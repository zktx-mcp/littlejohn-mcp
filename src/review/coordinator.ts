import {createReviewedRequestReference} from "./request-reference.js";
import type {PreparedRequestMaterial} from "./material-port.js";
import type {PreparedReviewDispatch} from "./prepared-dispatch.js";
import type {WalletBoundAccountReference} from "../wallet/bound-account-contract.js";
import {productChainId} from "../registry/client.js";
import type { ExchangeWalletOutcome } from "./response-contract.js";
import {addUtcMilliseconds, canonicalSha256, canonicalJsonStringify, captureCanonicalJson, deepFreezeValue, operationIdSchema, parseUtcTimestamp} from "../core/index.js";
import {evmAccountIdentitySchema, sameEvmAccountIdentity, type EvmAccountIdentity} from "../evm/identities.js";
import { normalizePinnedEvmReadFailure } from "../chain/index.js";
import { createOperationId } from "../runtime/operation-id.js";
import {
  accountTransactionDependenciesSchema,
  type TransactionReceiptAdmissionPort, type WalletReceiptReservation, type AccountTransactionDependencies,
} from "../receipt-activity/admission.js";
import type { WalletRequestAttempt, WalletTransactionInput, WalletRequestPort } from "../wallet/request-contract.js";
import {
  createReadyExchangeReview, exchangeDirectDecisionSchema, exchangeReviewSchema,
  type ExchangeDirectDecision, type ExchangeReview, type ReadyExchangeReview,
} from "./contracts.js";
import { createExchangeFailure, ExchangeError, exchangeFailureCode, exchangeErrorRegistry } from "./errors.js";
import { exchangeCommandSchema, type ExchangeCommand } from "./exchange.js";
import { requestReviewLimits } from "./request-limits.js";
import type { RequestReviewMaterialStore } from "./material-port.js";
import { observeExchange, revalidateExchange, type ExchangePreparationDependencies } from "./preparation.js";
import { observeExchangeResponse, type ExchangeResponse } from "./response.js";

interface AdmittedHandoff {
  readonly preparedMaterial: PreparedRequestMaterial;
  readonly reference: WalletTransactionInput["reference"];
  readonly sessionSourceId: string;
  readonly sendExpiresAt: string;
  readonly localExpiresAt: string;
  readonly reservation: WalletReceiptReservation;
  readonly permission: import("../wallet/bound-account-contract.js").WalletBoundAccountReference;
}
export interface ExchangeCoordinatorDependencies {
  readonly preparation: ExchangePreparationDependencies;
  readonly materials: RequestReviewMaterialStore;
  readonly wallet: WalletRequestPort;
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
  readonly #prepared = new Set<PreparedReviewDispatch<ExchangeConfirmationResult>>();
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
      const target = await this.#account(request, currentSignal);
      const expiresAt = parseUtcTimestamp([...( "kind" in request ? [] : [request.deadline]), target.expiresAt, addUtcMilliseconds(createdAt, requestReviewLimits.reviewLifetimeMilliseconds)]
        .sort()[0]!);
      const reservation = materials.reserve(operationId, createdAt, expiresAt);
      let published = false;
      try {
        const replacing = "kind" in request ? request.transactionHash : request.replaces;
        const dependencies = await this.#reconcile(target.account, currentSignal, replacing !== undefined);
        const result = await observeExchange(preparation, { request, operationId, createdAt, actionExpiresAt: expiresAt }, currentSignal, target.permission);
        this.#assertOpen(currentSignal);
        if (!result.ok) return deepFreezeValue(exchangeReviewSchema.parse({ state: "blocked", operationId, createdAt, request, failure: result }));
        this.#assertDependencies(dependencies, result.review.data.state.confirmedNonce, replacing !== undefined);
        const review = createReadyExchangeReview(result.review);
        materials.publish(reservation, { kind: "transaction", review, request: result.privateRequest, command: request });
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
    const material = this.#dependencies.materials.read(operationIdSchema.parse(operationId));
    return material?.kind === "transaction" ? material.review : null;
  }

  cancel(operationId: string) {
    this.#assertOpen();
    const id = operationIdSchema.parse(operationId);
    if (this.#dependencies.materials.read(id)?.kind !== "transaction") return Object.freeze({ operationId: id, status: "unavailable" as const });
    this.#dependencies.materials.discard(id);
    return Object.freeze({ operationId: id, status: "discarded" as const });
  }

  // Only the later App-only/TTY control binding receives this method. No grant
  // or boolean confirmation flag exists on the model-visible start/get surface.
  async confirm(input: ExchangeDirectDecision, signal: AbortSignal): Promise<ExchangeConfirmationResult> {
    const prepared = await this.prepareConfirm(input, signal);
    try { return await prepared.execute(); } finally { prepared.discard(); }
  }

  prepareConfirm(input: ExchangeDirectDecision, signal: AbortSignal): Promise<PreparedReviewDispatch<ExchangeConfirmationResult>> {
    this.#assertOpen(signal);
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal.addEventListener("abort", abort, {once: true});
    if (signal.aborted) abort();
    this.#controllers.add(controller);
    const release = (): void => {
      signal.removeEventListener("abort", abort);
      this.#controllers.delete(controller);
    };
    let preparation: Promise<PreparedReviewDispatch<ExchangeConfirmationResult>>;
    preparation = this.#prepareConfirm(input, controller.signal).then((prepared) => {
      let executed = false;
      let discarded = false;
      const owned: PreparedReviewDispatch<ExchangeConfirmationResult> = Object.freeze({source: prepared.source,
        ...(prepared.result === undefined ? {} : {result: prepared.result}),
        execute: (): Promise<ExchangeConfirmationResult> => {
          if (executed || discarded) throw new ExchangeError("state_conflict");
          executed = true;
          let result: Promise<ExchangeConfirmationResult>;
          result = prepared.execute().finally(() => {
            prepared.discard();
            release();
            this.#prepared.delete(owned);
            this.#calls.delete(result);
          });
          this.#calls.add(result);
          return result;
        },
        discard: (): void => {
          if (discarded) return;
          discarded = true;
          prepared.discard();
          // Executing response cleanup retains the signal until local waiting ends.
          if (!executed) {release(); this.#prepared.delete(owned);}
        },
      });
      this.#prepared.add(owned);
      if (this.#closed) {owned.discard(); throw new ExchangeError("runtime_state_unavailable");}
      return owned;
    }, (error: unknown) => {release(); throw error;}).finally(() => this.#calls.delete(preparation));
    this.#calls.add(preparation);
    return preparation;
  }

  async #prepareConfirm(input: ExchangeDirectDecision, signal: AbortSignal): Promise<PreparedReviewDispatch<ExchangeConfirmationResult>> {
    const decision = exchangeDirectDecisionSchema.parse(input);
    const source = Object.freeze({kind: "transaction" as const, operationId: decision.review.observation.data.operationId,
      resultDigest: canonicalSha256(captureCanonicalJson(decision.review))});
    let admitted: AdmittedHandoff | Readonly<{kind: "review"; review: ExchangeReview}> | undefined;
    admitted = await this.#authorize(decision, signal);
    const result = "review" in admitted ? admitted : undefined;
    let used = false;
    return Object.freeze({source, ...(result === undefined ? {} : {result}),
      execute: async (): Promise<ExchangeConfirmationResult> => {
        if (used || admitted === undefined) throw new ExchangeError("state_conflict");
        used = true;
        const value = admitted;
        admitted = undefined;
        if ("review" in value) return value;
        try { this.#assertOpen(signal); this.#dependencies.preparation.activeWallet.assertBoundAccountCurrent(value.permission); }
        catch {
          this.#dependencies.materials.discardPrepared(value.preparedMaterial);
          this.#dependencies.receipts.releaseWalletTransaction(value.reservation);
          return {kind: "wallet_result", outcome: {status: "not_sent"}};
        }
        return this.#send(value, signal);
      },
      discard: (): void => {
        if (admitted !== undefined && !("review" in admitted)) {
          this.#dependencies.materials.discardPrepared(admitted.preparedMaterial);
          this.#dependencies.receipts.releaseWalletTransaction(admitted.reservation);
        }
        admitted = undefined;
        used = true;
      },
    });
  }

  async #authorize(input: ExchangeDirectDecision, signal: AbortSignal): Promise<AdmittedHandoff | Readonly<{ kind: "review"; review: ExchangeReview }>> {
    this.#assertOpen(signal);
    if (this.#deciding) throw new ExchangeError("state_conflict");
    this.#deciding = true;
    const { preparation, materials, receipts } = this.#dependencies;
    let receiptReservation: WalletReceiptReservation | undefined;
    let review: ReadyExchangeReview | undefined;
    let material: import("./material-port.js").RequestReviewMaterial | undefined;
    let confirmedRefusal = false;
    try {
      const decision = deepFreezeValue(exchangeDirectDecisionSchema.parse(captureCanonicalJson(input)));
      review = decision.review;
      const data = review.observation.data;
      material = materials.read(data.operationId) ?? undefined;
      if (material?.kind !== "transaction" || canonicalJsonStringify(captureCanonicalJson(material.review)) !==
          canonicalJsonStringify(captureCanonicalJson(review))) throw new ExchangeError("review_unavailable");
      const dependencies = await this.#reconcile(data.intent.account, signal, "replacement" in data || data.intent.replaces !== undefined);
      const refusal = await revalidateExchange(preparation, material, signal);
      this.#assertOpen(signal);
      if (refusal !== null) {
        confirmedRefusal = !["source", "transport", "runtime", "internal"].includes(refusal.error.category);
        throw new ExchangeError(refusal.error.code);
      }
      confirmedRefusal = true;
      this.#assertDependencies(dependencies, data.state.confirmedNonce, "replacement" in data || data.intent.replaces !== undefined);
      this.#assertDependencies(accountTransactionDependenciesSchema.parse(receipts.currentDependencies(data.intent.account)),
        data.state.confirmedNonce, "replacement" in data || data.intent.replaces !== undefined);
      // The server creates and consumes this grant synchronously. Its bound
      // expiry also gates Wallet admission if the following promise is delayed.
      const grant = Object.freeze({
        operation: "transaction_handoff", account: data.intent.account,
        walletRequestCommitment: data.walletRequestCommitment,
        initiatedBy: decision.initiatedBy,
        expiresAt: [data.actionExpiresAt, addUtcMilliseconds(preparation.clock.now(), requestReviewLimits.grantLifetimeMilliseconds)].sort()[0]!,
      });
      confirmedRefusal = false;
      receiptReservation = receipts.reserveWalletTransaction();
      this.#assertOpen(signal);
      if (preparation.clock.now() >= grant.expiresAt) {
        throw new ExchangeError("review_expired");
      }
      if (this.#dependencies.wallet.hasPendingRequest()) throw new ExchangeError("state_conflict");
      const preparedMaterial = materials.prepareConsumption(review, grant.expiresAt);
      const reference = createReviewedRequestReference(review, material.request);
      if (reference.walletRequestCommitment !== grant.walletRequestCommitment || !sameEvmAccountIdentity(reference.account, grant.account)) {
        materials.discardPrepared(preparedMaterial);
        throw new ExchangeError("state_conflict");
      }
      const admitted = Object.freeze({preparedMaterial, reference, sessionSourceId: data.connection.source.sourceId, sendExpiresAt: grant.expiresAt,
        localExpiresAt: data.actionExpiresAt, reservation: receiptReservation, permission: data.connection.permission});
      receiptReservation = undefined;
      return admitted;
    } catch (error) {
      const code = exchangeFailureCode(error) ?? normalizePinnedEvmReadFailure(error, signal);
      if (review === undefined || code === undefined) throw error;
      if (this.#closed || material === undefined || code === "review_unavailable" || code === "request_aborted" ||
          ["source", "transport", "runtime", "internal"].includes(exchangeErrorRegistry.get(code).category) ||
          (!confirmedRefusal && !["review_expired", "wallet_not_connected", "wallet_session_unusable", "wallet_account_unavailable"].includes(code)) ||
          !materials.discardUnprepared(material)) throw new ExchangeError(code);
      return Object.freeze({ kind: "review", review: deepFreezeValue(exchangeReviewSchema.parse({
        state: "refresh_required", operationId: review.observation.data.operationId, failure: createExchangeFailure(code),
      })) });
    } finally {
      this.#deciding = false;
      if (receiptReservation !== undefined) receipts.releaseWalletTransaction(receiptReservation);
    }
  }

  #send(admitted: AdmittedHandoff, signal: AbortSignal): Promise<ExchangeConfirmationResult> {
    let attempt: Promise<WalletRequestAttempt>;
    try {
      this.#assertOpen(signal);
      this.#dependencies.preparation.activeWallet.assertBoundAccountCurrent(admitted.permission);
      const consumed = this.#dependencies.materials.takePrepared(admitted.preparedMaterial);
      if (consumed.kind !== "transaction" || consumed.reference.walletRequestCommitment !== admitted.reference.walletRequestCommitment ||
          !sameEvmAccountIdentity(consumed.reference.account, admitted.reference.account)) throw new ExchangeError("state_conflict");
      attempt = this.#dependencies.wallet.startRequest({kind: "transaction", request: consumed.request, reference: consumed.reference,
        sessionSourceId: admitted.sessionSourceId, sendExpiresAt: admitted.sendExpiresAt});
    } catch {
      this.#dependencies.materials.discardPrepared(admitted.preparedMaterial);
      this.#dependencies.receipts.releaseWalletTransaction(admitted.reservation);
      return Promise.resolve(Object.freeze({kind: "wallet_result" as const, outcome: {status: "not_sent" as const}}));
    }
    return this.#observe(attempt, admitted.reference, admitted.reservation, admitted.localExpiresAt, signal);
  }

  #observe(
    attempt: Promise<WalletRequestAttempt>, reference: WalletTransactionInput["reference"],
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

  async #account(request: ExchangeCommand, signal: AbortSignal): Promise<Readonly<{ account: EvmAccountIdentity; expiresAt: string; permission: WalletBoundAccountReference }>> {
    const current = await this.#dependencies.preparation.activeWallet.resolveAccount({chainId: productChainId, requiredMethods: ["eth_sendTransaction"]}, signal);
    this.#assertOpen(signal);
    if (current.connection.status !== "connected" || current.sessionSource === undefined) throw new ExchangeError("wallet_not_connected");
    const account = current.account;
    if (request.account.kind === "address" && request.account.address !== account.address) throw new ExchangeError("wallet_session_unusable");
    return { account, expiresAt: current.connection.expiresAt, permission: current.permission };
  }

  async #reconcile(account: EvmAccountIdentity, signal: AbortSignal, replacing: boolean): Promise<AccountTransactionDependencies> {
    if (this.#dependencies.wallet.hasPendingRequest()) throw new ExchangeError("state_conflict");
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
    for (const prepared of this.#prepared) prepared.discard();
    for (const response of this.#responses) response.close();
    this.#dependencies.materials.close();
    this.#closing = Promise.allSettled([...this.#calls]).then(() => undefined);
    return this.#closing;
  }
}
