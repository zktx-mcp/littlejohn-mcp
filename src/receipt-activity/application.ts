import { setTimeout as delay } from "node:timers/promises";
import {canonicalJsonStringify, captureCanonicalJson, parseUnsignedDecimal, parseHash32, type Hash32, type ApplicationFailure} from "../core/index.js";
import {evmAccountIdentitySchema, type EvmAccountIdentity} from "../evm/identities.js";
import { ReceiptActivityError } from "./errors.js";
import { normalizeReceiptActivityFailure } from "./operation-error.js";
import {
  transactionDependencyEventSchema, receivedWalletTransactionSchema,
  type TransactionDependencyEvent, type ReceivedWalletTransaction,
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

  currentRevision(accountInput: EvmAccountIdentity): string {
    this.#assertOpen();
    return this.#store.revision(evmAccountIdentitySchema.parse(accountInput));
  }

  reconcileAccount(accountInput: EvmAccountIdentity, signal: AbortSignal,
    observe: (event: TransactionDependencyEvent) => void): Promise<void> {
    const account = evmAccountIdentitySchema.parse(accountInput);
    if (typeof observe !== "function") throw new TypeError("A dependency observer is required.");
    return this.#run(signal, async (currentSignal) => {
      let expectedRevision = this.#store.revision(account);
      const emit = (event: TransactionDependencyEvent): void => {
        this.#assertOpen();
        if (currentSignal.aborted) throw new ReceiptActivityError("request_aborted");
        observe(transactionDependencyEventSchema.parse(event));
      };
      const assertRevision = (): void => {
        this.#assertOpen();
        if (this.#store.revision(account) !== expectedRevision) throw new ReceiptActivityError("state_conflict");
      };
      await this.#dependencies.chain.chainInvocations.run(currentSignal, async (context) => {
        const block = await this.#dependencies.chain.reads.resolveBlock(context, {kind: "latest"});
        const nonce = await this.#dependencies.chain.transactions.nonce(context, block, account.address);
        assertRevision();
        emit({kind: "begin", account, revision: expectedRevision, block: block.anchor,
          source: this.#dependencies.chain.transactions.observationAuthority, confirmedNonce: parseUnsignedDecimal(nonce.confirmed)});
        let cursor: Hash32 | null = null;
        for (;;) {
          assertRevision();
          const page = this.#store.listReconciliation(account, cursor, receiptActivityLimits.pageSize);
          assertRevision();
          for (const record of page) {
            if (cursor !== null && record.transactionHash <= cursor) throw new ReceiptActivityError("runtime_state_unavailable");
            if (record.account.chainId !== account.chainId || record.account.address !== account.address) throw new ReceiptActivityError("runtime_state_unavailable");
            const input = {account, transactionHash: record.transactionHash,
              reference: record.origin.kind === "wallet" ? record.origin.reference : null};
            const result = await this.#inspector.inspect(input, context, inspection => {
              this.#assertOpen();
              if (context.signal.aborted) throw new ReceiptActivityError("request_aborted");
              assertRevision();
              expectedRevision = this.#store.write(recordReceiptInspection(this.#store.read(account, record.transactionHash),
                input, record.receivedAt, inspection), expectedRevision);
            });
            assertRevision();
            cursor = record.transactionHash;
            const observed = result.data.status === "pending" || result.data.status === "included"
              ? {sender: result.data.actualSender, nonce: result.data.nonce} : record.observedTransaction;
            if (observed !== null && (observed.sender !== account.address || BigInt(observed.nonce) < BigInt(nonce.confirmed))) continue;
            if (result.data.status === "pending") emit({kind: "dependency", value: {
              status: "pending", transactionHash: record.transactionHash, nonce: result.data.nonce}});
            else if (result.data.status !== "included") emit({kind: "dependency", value: {
              status: result.data.status === "not_found" ? "not_found" : "unavailable",
              transactionHash: record.transactionHash, nonce: observed?.nonce ?? null}});
          }
          if (page.length < receiptActivityLimits.pageSize) break;
        }
        assertRevision();
        emit({kind: "complete", account, revision: expectedRevision});
      });
    });
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
