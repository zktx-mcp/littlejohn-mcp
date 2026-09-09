import type { ExchangeWalletOutcome } from "./response-contract.js";
import {
  addUtcMilliseconds, canonicalJsonStringify, captureCanonicalJson, deepFreezeValue,
  evmAccountIdentitySchema, operationIdSchema, parseUtcTimestamp, sameEvmAccountIdentity,
  type EvmAccountIdentity,
} from "../core/index.js";
import { normalizePinnedEvmReadFailure } from "../chain/index.js";
import { createOperationId } from "../runtime/operation-id.js";
import {
  accountTransactionDependenciesSchema,
  type TransactionReceiptAdmissionPort, type WalletReceiptReservation, type AccountTransactionDependencies,
} from "../receipt-activity/admission.js";
import type { WalletTransactionAttempt, WalletTransactionInput, WalletTransactionPort } from "../wallet/transaction-contract.js";
import {
  createReadyExchangeReview, exchangeDirectDecisionSchema, exchangeReviewSchema,
  type ExchangeDirectDecision, type ExchangeReview, type ReadyExchangeReview,
} from "./contracts.js";
import { createExchangeFailure, ExchangeError, exchangeFailureCode } from "./errors.js";
import { exchangeCommandSchema, type ExchangeCommand } from "./exchange.js";
import { exchangeLimits } from "./limits.js";
import type { ExchangeReviewMaterialStore } from "./material-port.js";
import { observeExchange, revalidateExchange, type ExchangePreparationDependencies } from "./preparation.js";
import { observeExchangeResponse, type ExchangeResponse } from "./response.js";

interface AdmittedHandoff {
  readonly walletInput: WalletTransactionInput;
  readonly localExpiresAt: string;
  readonly reservation: WalletReceiptReservation;
}
export interface ExchangeCoordinatorDependencies {
  readonly preparation: ExchangePreparationDependencies;
  readonly materials: ExchangeReviewMaterialStore;
  readonly wallet: WalletTransactionPort;
  readonly receipts: TransactionReceiptAdmissionPort;
}
export type ExchangeConfirmationResult =
  | Readonly<{ kind: "review"; review: ExchangeReview }>
  | Readonly<{ kind: "wallet_result"; outcome: ExchangeWalletOutcome }>;

export class ExchangeCoordinator {
  readonly #dependencies: ExchangeCoordinatorDependencies;
  readonly #controllers = new Set<AbortController>();
  readonly #responses = new Set<ExchangeResponse>();
  readonly #calls = new Set<Promise<unknown>>();
  #closed = false;
  #deciding = false;
  #closing: Promise<void> | undefined;

  constructor(dependencies: ExchangeCoordinatorDependencies) {
    this.#dependencies = dependencies;
  }

  start(input: ExchangeCommand, signal: AbortSignal): Promise<ExchangeReview> {
    return this.#run(signal, async (currentSignal) => {
      const request = deepFreezeValue(exchangeCommandSchema.parse(captureCanonicalJson(input)));
      const { preparation, materials } = this.#dependencies;
      const operationId = createOperationId();
      const createdAt = preparation.clock.now();
      const target = this.#account(request);
      const expiresAt = parseUtcTimestamp([...( "kind" in request ? [] : [request.deadline]), target.expiresAt, addUtcMilliseconds(createdAt, exchangeLimits.reviewLifetimeMilliseconds)]
        .sort()[0]!);
      const reservation = materials.reserve(operationId, createdAt, expiresAt);
      let published = false;
      try {
        const replacing = "kind" in request ? request.transactionHash : request.replaces;
        const dependencies = await this.#reconcile(target.account, currentSignal, replacing !== undefined);
        const result = await observeExchange(preparation, { request, operationId, createdAt, actionExpiresAt: expiresAt }, currentSignal);
        this.#assertOpen(currentSignal);
        if (!result.ok) return deepFreezeValue(exchangeReviewSchema.parse({ state: "blocked", operationId, createdAt, request, failure: result }));
        this.#assertDependencies(dependencies, result.review.data.state.confirmedNonce, replacing !== undefined);
        const review = createReadyExchangeReview(result.review);
        materials.publish(reservation, review, result.privateRequest, request);
        published = true;
        return review;
      } catch (error) {
        const code = exchangeFailureCode(error) ?? normalizePinnedEvmReadFailure(error, currentSignal);
        if (code === undefined) throw error;
        return deepFreezeValue(exchangeReviewSchema.parse({
          state: "blocked", operationId, createdAt, request, failure: createExchangeFailure(code),
        }));
      } finally {
        if (!published) materials.release(reservation);
      }
    });
  }

  get(operationId: string): ReadyExchangeReview | null {
    this.#assertOpen();
    return this.#dependencies.materials.read(operationIdSchema.parse(operationId))?.review ?? null;
  }

  cancel(operationId: string) {
    this.#assertOpen();
    const id = operationIdSchema.parse(operationId);
    if (this.#dependencies.materials.read(id) === null) return Object.freeze({ operationId: id, status: "unavailable" as const });
    this.#dependencies.materials.discard(id);
    return Object.freeze({ operationId: id, status: "discarded" as const });
  }

  // Only the later App-only/TTY control binding receives this method. No grant
  // or boolean confirmation flag exists on the model-visible start/get surface.
  confirm(input: ExchangeDirectDecision, signal: AbortSignal): Promise<ExchangeConfirmationResult> {
    return this.#run(signal, (currentSignal) => this.#authorize(input, currentSignal)
      .then((admitted) => "review" in admitted ? admitted : this.#send(admitted, currentSignal)));
  }

  async #authorize(input: ExchangeDirectDecision, signal: AbortSignal): Promise<AdmittedHandoff | Readonly<{ kind: "review"; review: ExchangeReview }>> {
    this.#assertOpen(signal);
    if (this.#deciding) throw new ExchangeError("state_conflict");
    this.#deciding = true;
    const { preparation, materials, receipts } = this.#dependencies;
    let receiptReservation: WalletReceiptReservation | undefined;
    let review: ReadyExchangeReview | undefined;
    try {
      const decision = deepFreezeValue(exchangeDirectDecisionSchema.parse(captureCanonicalJson(input)));
      review = decision.review;
      const data = review.observation.data;
      const material = materials.read(data.operationId);
      if (material === null || canonicalJsonStringify(captureCanonicalJson(material.review)) !==
          canonicalJsonStringify(captureCanonicalJson(review))) throw new ExchangeError("exchange_review_unavailable");
      const dependencies = await this.#reconcile(data.intent.account, signal, "replacement" in data || data.intent.replaces !== undefined);
      const refusal = await revalidateExchange(preparation, material, signal);
      this.#assertOpen(signal);
      if (refusal !== null) throw new ExchangeError(refusal.error.code);
      this.#assertDependencies(dependencies, data.state.confirmedNonce, "replacement" in data || data.intent.replaces !== undefined);
      this.#assertDependencies(accountTransactionDependenciesSchema.parse(receipts.currentDependencies(data.intent.account)),
        data.state.confirmedNonce, "replacement" in data || data.intent.replaces !== undefined);
      // The server creates and consumes this grant synchronously. Its bound
      // expiry also gates Wallet admission if the following promise is delayed.
      const grant = Object.freeze({
        operation: "transaction_handoff", account: data.intent.account,
        walletRequestCommitment: data.walletRequestCommitment,
        initiatedBy: decision.initiatedBy,
        expiresAt: [data.actionExpiresAt, addUtcMilliseconds(preparation.clock.now(), exchangeLimits.grantLifetimeMilliseconds)].sort()[0]!,
      });
      receiptReservation = receipts.reserveWalletTransaction();
      this.#assertOpen(signal);
      if (preparation.clock.now() >= grant.expiresAt || this.#dependencies.wallet.hasPendingTransaction()) {
        throw new ExchangeError("exchange_review_expired");
      }
      const consumed = materials.consume(review);
      if (consumed.reference.walletRequestCommitment !== grant.walletRequestCommitment ||
          !sameEvmAccountIdentity(consumed.reference.account, grant.account)) throw new ExchangeError("state_conflict");
      const admitted = Object.freeze({
        walletInput: { ...consumed, sessionSourceId: data.connection.source.sourceId, sendExpiresAt: grant.expiresAt },
        localExpiresAt: data.actionExpiresAt, reservation: receiptReservation,
      });
      receiptReservation = undefined;
      return admitted;
    } catch (error) {
      if (review !== undefined && !this.#closed) materials.discard(review.observation.data.operationId);
      const code = exchangeFailureCode(error) ?? normalizePinnedEvmReadFailure(error, signal);
      if (review === undefined || code === undefined) throw error;
      return Object.freeze({ kind: "review", review: deepFreezeValue(exchangeReviewSchema.parse({
        state: "refresh_required", operationId: review.observation.data.operationId, failure: createExchangeFailure(code),
      })) });
    } finally {
      this.#deciding = false;
      if (receiptReservation !== undefined) receipts.releaseWalletTransaction(receiptReservation);
    }
  }

  #send(admitted: AdmittedHandoff, signal: AbortSignal): Promise<ExchangeConfirmationResult> {
    let attempt: Promise<WalletTransactionAttempt>;
    try {
      this.#assertOpen(signal);
      attempt = this.#dependencies.wallet.startTransaction(admitted.walletInput);
    } catch {
      this.#dependencies.receipts.releaseWalletTransaction(admitted.reservation);
      return Promise.resolve(Object.freeze({ kind: "wallet_result", outcome: { status: "not_sent" as const } }));
    }
    // Enter a separate continuation with no request or Review parameter.
    return this.#observe(attempt, admitted.walletInput.reference, admitted.reservation, admitted.localExpiresAt, signal);
  }

  #observe(
    attempt: Promise<WalletTransactionAttempt>, reference: WalletTransactionInput["reference"],
    reservation: WalletReceiptReservation, expiresAt: string, signal: AbortSignal,
  ): Promise<ExchangeConfirmationResult> {
    return attempt.then((value) => {
      const response = observeExchangeResponse(value, reference, reservation, expiresAt,
        this.#dependencies.preparation.clock, this.#dependencies.receipts, signal);
      this.#responses.add(response);
      void response.settled.finally(() => this.#responses.delete(response)).catch(() => { void this.close(); });
      if (this.#closed) response.close();
      return response.result.then((outcome) => Object.freeze({ kind: "wallet_result" as const, outcome }));
    }, () => {
      this.#dependencies.receipts.releaseWalletTransaction(reservation);
      return Object.freeze({ kind: "wallet_result" as const, outcome: { status: "not_sent" as const } });
    });
  }

  #account(request: ExchangeCommand): Readonly<{ account: EvmAccountIdentity; expiresAt: string }> {
    const current = this.#dependencies.preparation.activeWallet.capture();
    if (current.connection.status !== "connected" || current.sessionSource === undefined) throw new ExchangeError("wallet_not_connected");
    const account = evmAccountIdentitySchema.parse({ chainId: current.connection.chainId, address: current.connection.address });
    if (request.account.kind === "address" && request.account.address !== account.address) throw new ExchangeError("wallet_session_unusable");
    return { account, expiresAt: current.connection.expiresAt };
  }

  async #reconcile(account: EvmAccountIdentity, signal: AbortSignal, replacing: boolean): Promise<AccountTransactionDependencies> {
    if (this.#dependencies.wallet.hasPendingTransaction()) throw new ExchangeError("state_conflict");
    const result = accountTransactionDependenciesSchema.parse(await this.#dependencies.receipts.reconcileAccount(account, signal));
    this.#assertOpen(signal);
    if (!sameEvmAccountIdentity(result.account, account) || (!replacing && result.unresolved.length !== 0)) throw new ExchangeError("state_conflict");
    return result;
  }

  #assertDependencies(result: AccountTransactionDependencies, nonce: string, replacing: boolean): void {
    if (result.unresolved.some((entry) => entry.nonce !== null && BigInt(entry.nonce) < BigInt(nonce) ? false :
      !replacing || entry.status !== "pending" || entry.nonce !== nonce)) {
      throw new ExchangeError("state_conflict");
    }
  }

  #assertOpen(signal?: AbortSignal): void {
    if (this.#closed) throw new ExchangeError("runtime_state_unavailable");
    if (signal?.aborted) throw new ExchangeError("request_aborted");
  }

  #run<Value>(signal: AbortSignal, work: (signal: AbortSignal) => Promise<Value>): Promise<Value> {
    this.#assertOpen(signal);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    this.#controllers.add(controller);
    const result = work(controller.signal).finally(() => {
      this.#controllers.delete(controller);
      signal.removeEventListener("abort", abort);
      this.#calls.delete(result);
    });
    this.#calls.add(result);
    return result;
  }

  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing;
    this.#closed = true;
    for (const controller of this.#controllers) controller.abort();
    for (const response of this.#responses) response.close();
    this.#dependencies.materials.close();
    this.#closing = Promise.allSettled([...this.#calls]).then(() => undefined);
    return this.#closing;
  }
}
