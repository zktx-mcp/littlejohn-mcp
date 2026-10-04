import { setTimeout as delay } from "node:timers/promises";
import {canonicalJsonStringify, captureCanonicalJson, deepFreezeValue, parseHash32, type Hash32, type ApplicationFailure} from "../core/index.js";
import {evmAccountIdentitySchema, type EvmAccountIdentity} from "../evm/identities.js";
import { ReceiptActivityError } from "./errors.js";
import { normalizeReceiptActivityFailure } from "./operation-error.js";
import {
  accountTransactionDependenciesSchema, receivedWalletTransactionSchema,
  type AccountTransactionDependencies, type ReceivedWalletTransaction,
  type TransactionReceiptAdmissionPort, type WalletReceiptReservation,
} from "./admission.js";
import { transactionLedgerRecordSchema, recordReceivedWalletHash, recordReceiptInspection, type TransactionLedgerRecord, type TransactionLedgerStore, type ReceiptInspectionSuccess } from "./contracts.js";
import { createReceiptInspector, type ReceiptInspectionDependencies } from "./inspection.js";
import { receiptActivityLimits } from "./limits.js";

export type ReceiptQueryResult = Readonly<{ status: "observed"; record: TransactionLedgerRecord | null }> |
  Readonly<{ status: "unavailable"; record: TransactionLedgerRecord | null; failure: ApplicationFailure }>;

export class ReceiptActivity implements TransactionReceiptAdmissionPort {
  readonly #dependencies: ReceiptInspectionDependencies;
  readonly #store: TransactionLedgerStore;
  readonly #inspector: ReturnType<typeof createReceiptInspector>;
  readonly #reservations = new Set<WalletReceiptReservation>();
  readonly #controllers = new Set<AbortController>();
  readonly #calls = new Set<Promise<unknown>>();
  #closed = false;
  #closing: Promise<void> | undefined;

  constructor(dependencies: ReceiptInspectionDependencies, store: TransactionLedgerStore) {
    this.#dependencies = dependencies;
    this.#store = store;
    this.#inspector = createReceiptInspector(dependencies);
  }

  reserveWalletTransaction(): WalletReceiptReservation {
    this.#assertOpen();
    const capacity = this.#store.capacity();
    const count = this.#reservations.size + 1;
    if (capacity.records + count > receiptActivityLimits.records ||
        capacity.bytes + count * receiptActivityLimits.recordUtf8Bytes > receiptActivityLimits.totalRecordUtf8Bytes) {
      throw new ReceiptActivityError("transaction_ledger_full");
    }
    const reservation = Object.freeze({}) as WalletReceiptReservation;
    this.#reservations.add(reservation);
    return reservation;
  }

  releaseWalletTransaction(reservation: WalletReceiptReservation): void { this.#reservations.delete(reservation); }

  recordWalletTransaction(reservation: WalletReceiptReservation, input: ReceivedWalletTransaction): void {
    this.#assertOpen();
    if (!this.#reservations.has(reservation)) throw new ReceiptActivityError("state_conflict");
    const value = receivedWalletTransactionSchema.parse(captureCanonicalJson(input));
    const record = recordReceivedWalletHash(value, this.#store.read(value.reference.account, value.transactionHash));
    this.#store.write(record);
    this.#reservations.delete(reservation);
  }

  async inspectWalletTransaction(input: ReceivedWalletTransaction, signal: AbortSignal): Promise<void> {
    const value = receivedWalletTransactionSchema.parse(captureCanonicalJson(input));
    const record = this.get(value.reference.account, value.transactionHash);
    if (record?.origin.kind !== "wallet" || canonicalJsonStringify(captureCanonicalJson(record.origin.reference)) !==
        canonicalJsonStringify(captureCanonicalJson(value.reference))) throw new ReceiptActivityError("state_conflict");
    const result = await this.inspect(value.reference.account, value.transactionHash, signal);
    if (result.status !== "observed") throw new ReceiptActivityError(result.failure.error.code);
  }

  get(account: EvmAccountIdentity, hash: Hash32): TransactionLedgerRecord | null {
    this.#assertOpen();
    return this.#store.read(evmAccountIdentitySchema.parse(account), parseHash32(hash));
  }

  list(accountInput: EvmAccountIdentity, cursorInput: Hash32 | null = null) {
    this.#assertOpen();
    const account = evmAccountIdentitySchema.parse(accountInput);
    const cursor = cursorInput === null ? null : parseHash32(cursorInput);
    const records = this.#store.list(account, cursor, receiptActivityLimits.pageSize + 1);
    const visible = records.slice(0, receiptActivityLimits.pageSize);
    return Object.freeze({ account, records: visible,
      nextCursor: records.length > receiptActivityLimits.pageSize ? visible.at(-1)!.transactionHash : null });
  }

  inspect(accountInput: EvmAccountIdentity, hashInput: Hash32, signal: AbortSignal): Promise<ReceiptQueryResult> {
    const account = evmAccountIdentitySchema.parse(accountInput);
    const hash = parseHash32(hashInput);
    return this.#run(signal, async (currentSignal) => {
      let latest = this.#store.read(account, hash);
      let persisted = latest !== null;
      const receivedAt = this.#dependencies.chain.clock.now();
      try {
        await this.#dependencies.chain.chainInvocations.run(currentSignal, async (context) => {
          await this.#dependencies.chain.reads.resolveBlock(context, { kind: "latest" });
          for (;;) {
            const reference = latest?.origin.kind === "wallet" ? latest.origin.reference : null;
            const result = await this.#inspector.inspect({ account, transactionHash: hash, reference }, context, (inspection) => {
              this.#assertOpen();
              if (context.signal.aborted) throw new ReceiptActivityError("request_aborted");
              if (!persisted && (inspection.data.status === "included" || inspection.data.status === "pending") &&
                  inspection.data.actualSender !== account.address) throw new ReceiptActivityError("source_inconsistent");
              const candidate = recordReceiptInspection(latest, { account, transactionHash: hash }, receivedAt, inspection);
              // An arbitrary missing user hash is not a new unresolved Wallet
              // dependency. A Wallet-returned hash is retained before this read.
              if (persisted || inspection.data.status !== "not_found") { this.#store.write(candidate); persisted = true; }
              latest = candidate;
            });
            if (result.data.status === "included" || result.data.status === "reorged") break;
            await delay(receiptActivityLimits.pollingMilliseconds, undefined, { signal: context.signal, ref: false });
          }
        });
        return Object.freeze({ status: "observed" as const, record: latest });
      } catch (error) {
        return Object.freeze({ status: "unavailable" as const, record: latest, failure: normalizeReceiptActivityFailure(error, currentSignal) });
      }
    });
  }

  currentDependencies(accountInput: EvmAccountIdentity): AccountTransactionDependencies {
    this.#assertOpen();
    const account = evmAccountIdentitySchema.parse(accountInput);
    const unresolved: AccountTransactionDependencies["unresolved"] = [];
    for (const record of this.#records(account)) {
      if (record.observedTransaction !== null && record.observedTransaction.sender !== account.address) continue;
      const data = record.inspection?.data;
      if (data?.status === "included") continue;
      unresolved.push(data?.status === "pending" ? { status: "pending", transactionHash: record.transactionHash, nonce: data.nonce }
        : { status: data?.status === "not_found" ? "not_found" : "unavailable", transactionHash: record.transactionHash, nonce: record.observedTransaction?.nonce ?? null });
    }
    return deepFreezeValue(accountTransactionDependenciesSchema.parse({ account, unresolved }));
  }

  reconcileAccount(accountInput: EvmAccountIdentity, signal: AbortSignal): Promise<AccountTransactionDependencies> {
    const account = evmAccountIdentitySchema.parse(accountInput);
    return this.#run(signal, async (currentSignal) => {
      const candidates = this.#records(account).filter((record) =>
        (record.observedTransaction === null || record.observedTransaction.sender === account.address) &&
        (record.inspection?.data.status !== "included" || record.inspection.data.finality.status !== "finalized"));
      if (candidates.length === 0) return deepFreezeValue(accountTransactionDependenciesSchema.parse({ account, unresolved: [] }));
      const unresolved: AccountTransactionDependencies["unresolved"] = [];
      const checked = new Set<Hash32>();
      try {
        await this.#dependencies.chain.chainInvocations.run(currentSignal, async (context) => {
          const block = await this.#dependencies.chain.reads.resolveBlock(context, { kind: "latest" });
          const nonce = await this.#dependencies.chain.transactions.nonce(context, block, account.address);
          for (const record of candidates) {
            const input = { account, transactionHash: record.transactionHash, reference: record.origin.kind === "wallet" ? record.origin.reference : null };
            const result = await this.#inspector.inspect(input, context, (inspection) => {
              this.#assertOpen();
              if (context.signal.aborted) throw new ReceiptActivityError("request_aborted");
              this.#store.write(recordReceiptInspection(this.#store.read(account, record.transactionHash), input, record.receivedAt, inspection));
            });
            checked.add(record.transactionHash);
            const observed = result.data.status === "pending" || result.data.status === "included"
              ? { sender: result.data.actualSender, nonce: result.data.nonce } : record.observedTransaction;
            if (observed !== null && (observed.sender !== account.address || BigInt(observed.nonce) < BigInt(nonce.confirmed))) continue;
            if (result.data.status === "pending") unresolved.push({ status: "pending", transactionHash: record.transactionHash, nonce: result.data.nonce });
            else if (result.data.status !== "included") unresolved.push({ status: result.data.status === "not_found" ? "not_found" : "unavailable", transactionHash: record.transactionHash, nonce: record.observedTransaction?.nonce ?? null });
          }
        });
      } catch {
        for (const record of candidates) if (!checked.has(record.transactionHash)) unresolved.push({ status: "unavailable", transactionHash: record.transactionHash, nonce: record.observedTransaction?.nonce ?? null });
      }
      return deepFreezeValue(accountTransactionDependenciesSchema.parse({ account, unresolved }));
    });
  }

  #records(account: EvmAccountIdentity): TransactionLedgerRecord[] {
    const records: TransactionLedgerRecord[] = [];
    let cursor: Hash32 | null = null;
    for (;;) {
      const page = this.#store.list(account, cursor, receiptActivityLimits.pageSize);
      records.push(...page);
      if (records.length > receiptActivityLimits.records) throw new ReceiptActivityError("runtime_state_unavailable");
      if (page.length < receiptActivityLimits.pageSize) return records;
      const next = page.at(-1)!.transactionHash;
      if (cursor !== null && next <= cursor) throw new ReceiptActivityError("runtime_state_unavailable");
      cursor = next;
    }
  }

  #assertOpen(): void { if (this.#closed) throw new ReceiptActivityError("runtime_state_unavailable"); }

  #run<Value>(signal: AbortSignal, work: (signal: AbortSignal) => Promise<Value>): Promise<Value> {
    this.#assertOpen();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) controller.abort();
    this.#controllers.add(controller);
    const result = work(controller.signal).finally(() => {
      this.#calls.delete(result); this.#controllers.delete(controller); signal.removeEventListener("abort", abort);
    });
    this.#calls.add(result); return result;
  }

  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing;
    this.#closed = true;
    this.#reservations.clear();
    for (const controller of this.#controllers) controller.abort();
    this.#closing = Promise.allSettled([...this.#calls]).then(() => undefined);
    return this.#closing;
  }
}
