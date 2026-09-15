import { requestReviewPresentationIdentity } from "../../review/presentation-contract.js";
import { operationToolResultEvidence } from "./contracts.js";
import { createDeliveryUnknown } from "../operation-delivery.js";
import { CardError } from "./card-errors.js";
import {
  captureCanonicalJson,
  type ApplicationFailure, type CanonicalJson,
} from "../../core/index.js";
import { admitExchangeConfirmationResult, exchangeApplicationContracts, type ExchangeApplicationPort } from "../../review/application-contracts.js";
import { exchangeReviewSchema, exchangeDirectDecisionSchema } from "../../review/contracts.js";
import { exchangeFailureCode, createExchangeFailure } from "../../review/errors.js";
import { signingApplicationContracts, type SigningApplicationPort } from "../../review/signing-application-contracts.js";
import { signingDirectDecisionSchema, signingReviewSchema, signingResponseContext, admitSigningCompletion } from "../../review/signing-contracts.js";
import { signingFailureCode, createSigningFailure } from "../../review/signing-errors.js";
import { walletManagementContracts, walletDirectActionSchema, walletReviewResultSchema, createWalletOperationCancellation, parseWalletOperationPresentation, type WalletManagementOperation, type WalletQrMatrix, type WalletManagementPort } from "../../wallet/contracts.js";
import { isWalletOperationCancellableState, isWalletOperationTerminalState } from "../../wallet/operation-state.js";
import { normalizeWalletError } from "../../wallet/errors.js";
import { tokenCatalogApplicationContracts, tokenSelectionDirectActionSchema, tokenSelectionReviewResultSchema, type TokenCatalogOperation } from "../../token-catalog/client.js";
import type { TokenCatalogManagementApplicationPort } from "../../token-catalog/ports.js";
import { type CardOutcome, type DecisionCardRecord } from "./card-contract.js";
import { presentationContractRegistry, type PresentationDecisionKind, type PresentationContractEntry } from "./registry.js";

export interface CardDomains {
  readonly wallet: WalletManagementPort;
  readonly token: TokenCatalogManagementApplicationPort;
  readonly signing: SigningApplicationPort;
  readonly exchange: ExchangeApplicationPort;
}
export class CardDomainError extends Error {
  constructor(readonly failure: ApplicationFailure) { super(failure.error.message); }
}
export interface CardDescription {
  readonly operationId: string;
  readonly expiresAt: string | null;
  readonly outcome: CardOutcome | null;
  readonly context?: unknown;
}
export interface CardOperationObservation {
  readonly value: WalletManagementOperation | TokenCatalogOperation;
  readonly qr?: WalletQrMatrix;
}
export interface CardDispatchResult {
  readonly operation?: CardOperationObservation;
  readonly value: CanonicalJson;
  readonly outcome: CardOutcome | null;
}

export interface CardSource {
  readonly entry: PresentationContractEntry;
  start(domains: CardDomains, input: unknown, signal: AbortSignal): Promise<unknown>;
  describe(value: unknown): CardDescription | null;
  decision(input: unknown): { readonly review: unknown; readonly initiatedBy: string };
  creatingValue(review: unknown): unknown;
  dispatch(domains: CardDomains, input: unknown, operationId: string, signal: AbortSignal): Promise<CardDispatchResult>;
  operation?(domains: CardDomains, record: DecisionCardRecord, includeQr?: boolean): Promise<CardOperationObservation | null>;
  discard?(domains: CardDomains, operationId: string): unknown;
  end?(domains: CardDomains, record: DecisionCardRecord): Promise<void>;
  unknown(operationId: string): CardOutcome;
}
const tokenValue = (value: unknown, contract: { parseFailure(value: unknown): ApplicationFailure }): unknown => {
  if (typeof value === "object" && value !== null && "ok" in value && value.ok === false) throw new CardDomainError(contract.parseFailure(value));
  return value;
};

const readWalletOperation = async (wallet: WalletManagementPort, record: DecisionCardRecord, includeQr = false): Promise<CardOperationObservation | null> => {
  try {
    const observed = includeQr ? parseWalletOperationPresentation(await wallet.getPresentation(record.operationId))
      : { operation: await wallet.get(record.operationId) };
    const operation = walletManagementContracts.operation.parsePublicSuccess({ operationId: record.operationId }, observed.operation);
    if (operationToolResultEvidence({ status: "review", review: operation.review }).sha256 !== record.resultDigest) throw new CardError("presentation_inconsistent");
    return { value: operation, ...(observed.qr === undefined ? {} : { qr: observed.qr }) };
  } catch (error) {
    if (error instanceof CardError) throw error;
    const failure = normalizeWalletError(error).failure;
    if (failure.error.code === "wallet_operation_not_found") return null;
    throw new CardDomainError(failure);
  }
};

// Only compact correlation enters the signing-response continuation.
const signingDispatch = (port: SigningApplicationPort, input: unknown, signal: AbortSignal): Promise<CardDispatchResult> => {
  let decision: ReturnType<typeof signingDirectDecisionSchema.parse> | undefined = signingDirectDecisionSchema.parse(input);
  input = undefined;
  const context = signingResponseContext(decision.review);
  let pending: ReturnType<SigningApplicationPort["confirm"]>;
  try { pending = port.confirm(decision, signal); }
  catch (error) { throw new CardDomainError(createSigningFailure(signingFailureCode(error) ?? "internal_error")); }
  decision = undefined;
  return pending.then((value) => {
    const completion = admitSigningCompletion(context, value);
    return { value: captureCanonicalJson(completion), outcome: { kind: "signing", status: completion.outcome.status } };
  }, (error: unknown) => { throw new CardDomainError(createSigningFailure(signingFailureCode(error) ?? "internal_error")); });
};

export const cardSources: Readonly<Record<PresentationDecisionKind, CardSource>> = (() => {
  const sources: Record<PresentationDecisionKind, CardSource> = {
    wallet: {
      entry: presentationContractRegistry.requireCardKind("wallet"),
      async start(domains, input) {
        try { return await domains.wallet.review(walletManagementContracts.review.parseInput(input)); }
        catch (error) { throw new CardDomainError(normalizeWalletError(error).failure); }
      },
      describe(value) {
        const result = walletReviewResultSchema.parse(value);
        return result.status === "review" ? { operationId: result.review.operationId, expiresAt: result.review.actionExpiresAt, outcome: null } : null;
      },
      decision: (input) => walletDirectActionSchema.parse(input),
      creatingValue: (review) => ({ status: "review", review }),
      async dispatch(domains, input) {
        const decision = walletDirectActionSchema.parse(input);
        const contract = walletManagementContracts[decision.review.kind];
        try {
          const operation = contract.parsePublicSuccess(decision, await domains.wallet.decide(decision));
          return { value: captureCanonicalJson(operation), operation: { value: operation }, outcome: isWalletOperationTerminalState(operation.state) ? { kind: "operation" } : null };
        } catch (error) { throw new CardDomainError(normalizeWalletError(error).failure); }
      },
      operation: (domains, record, includeQr) => readWalletOperation(domains.wallet, record, includeQr),
      async end(domains, record) {
        const observed = await readWalletOperation(domains.wallet, record);
        if (observed === null || observed.value.domain !== "wallet") return;
        const operation = observed.value;
        if (!isWalletOperationCancellableState(operation.state)) return;
        try { await domains.wallet.cancel(createWalletOperationCancellation(operation)); }
        catch (error) {
          const failure = normalizeWalletError(error).failure;
          // The original owner may have advanced beyond its cancellable state.
          // Local closure does not authorize a retry or a compensating effect.
          if (failure.error.code !== "state_conflict") throw new CardDomainError(failure);
        }
      },
      unknown: (operationId) => ({ kind: "delivery", result: createDeliveryUnknown("decide", operationId) }),
    },
    token_selection: {
      entry: presentationContractRegistry.requireCardKind("token_selection"),
      async start(domains, input) {
        return tokenValue(await domains.token.review(tokenCatalogApplicationContracts.selectionChangeReview.parseInput(input)), tokenCatalogApplicationContracts.selectionChangeReview);
      },
      describe(value) {
        const { review } = tokenSelectionReviewResultSchema.parse(value);
        return { operationId: review.operationId, expiresAt: review.actionExpiresAt, outcome: null };
      },
      decision: (input) => tokenSelectionDirectActionSchema.parse(input),
      creatingValue: (review) => ({ review }),
      async dispatch(domains, input) {
        const decision = tokenSelectionDirectActionSchema.parse(input);
        const contract = decision.review.kind === "add" ? tokenCatalogApplicationContracts.addSelection : tokenCatalogApplicationContracts.removeSelection;
        const value = tokenValue(await domains.token.decide(decision), contract);
        const operation = contract.parsePublicSuccess(decision as never, value);
        return { value: captureCanonicalJson(operation), operation: { value: operation }, outcome: { kind: "operation" } };
      },
      async operation(domains, record) {
        const input = tokenCatalogApplicationContracts.operation.parseInput({ operationId: record.operationId });
        const value = domains.token.getOperation(input);
        if (typeof value === "object" && value !== null && "ok" in value && value.ok === false) {
          const failure = tokenCatalogApplicationContracts.operation.parseFailure(value);
          if (failure.error.code === "token_operation_not_found") return null;
          throw new CardDomainError(failure);
        }
        const operation = tokenCatalogApplicationContracts.operation.parsePublicSuccess(input, value);
        if (operationToolResultEvidence({ review: operation.review }).sha256 !== record.resultDigest) throw new CardError("presentation_inconsistent");
        return { value: operation };
      },
      unknown: (operationId) => ({ kind: "delivery", result: createDeliveryUnknown("decide", operationId) }),
    },
    signing: {
      entry: presentationContractRegistry.requireCardKind("signing"),
      async start(domains, input, signal) {
        try { return await domains.signing.start(signingApplicationContracts.start.parseInput(input), signal); }
        catch (error) { throw new CardDomainError(createSigningFailure(signingFailureCode(error) ?? "internal_error")); }
      },
      describe(value) {
        const review = signingReviewSchema.parse(value);
        const identity = requestReviewPresentationIdentity(review);
        if (identity === null) throw new TypeError("Live signing identity required.");
        return { operationId: identity.operationId, expiresAt: identity.expiresAt, outcome: null, context: { account: review.account, method: review.method } };
      },
      decision: (input) => signingDirectDecisionSchema.parse(input),
      creatingValue: (review) => review,
      dispatch: (domains, input, _operationId, signal) => signingDispatch(domains.signing, input, signal),
      discard: (domains, operationId) => domains.signing.cancel(operationId),
      unknown: () => ({ kind: "signing", status: "delivery_unknown" }),
    },
    transaction: {
      entry: presentationContractRegistry.requireCardKind("transaction"),
      async start(domains, input, signal) {
        try { return await domains.exchange.start(exchangeApplicationContracts.start.parseInput(input), signal); }
        catch (error) { throw new CardDomainError(createExchangeFailure(exchangeFailureCode(error) ?? "internal_error")); }
      },
      describe(value) {
        const review = exchangeReviewSchema.parse(value);
        if (review.state === "ready_for_wallet_review") {
          const identity = requestReviewPresentationIdentity(review);
          if (identity === null) throw new TypeError("Live transaction identity required.");
          return { operationId: identity.operationId, expiresAt: identity.expiresAt, outcome: null, context: { account: review.observation.data.intent.account } };
        }
        return { operationId: review.operationId, expiresAt: null, outcome: { kind: "review", state: review.state, failureCode: review.failure.error.code }, context: { account: null } };
      },
      decision: (input) => exchangeDirectDecisionSchema.parse(input),
      creatingValue: (review) => review,
      dispatch(domains, input, operationId, signal) {
        let decision: ReturnType<typeof exchangeDirectDecisionSchema.parse> | undefined = exchangeDirectDecisionSchema.parse(input);
        input = undefined;
        let pending: ReturnType<ExchangeApplicationPort["confirm"]>;
        try { pending = domains.exchange.confirm(decision, signal); }
        catch (error) { throw new CardDomainError(createExchangeFailure(exchangeFailureCode(error) ?? "internal_error")); }
        decision = undefined;
        return pending.then((value) => {
          const result = admitExchangeConfirmationResult(operationId, value);
          if (result.kind === "wallet_result") return { value: captureCanonicalJson(result), outcome: { kind: "transaction", result: result.outcome } };
          if (result.review.state === "ready_for_wallet_review") throw new TypeError("A completed request cannot create another ready decision.");
          return { value: captureCanonicalJson(result), outcome: { kind: "review", state: result.review.state, failureCode: result.review.failure.error.code } };
        }, (error: unknown) => { throw new CardDomainError(createExchangeFailure(exchangeFailureCode(error) ?? "internal_error")); });
      },
      discard: (domains, operationId) => domains.exchange.cancel(operationId),
      unknown: () => ({ kind: "transaction", result: { status: "delivery_unknown" } }),
    },
  };
  for (const [kind, source] of Object.entries(sources)) {
    if (source.entry.cardKind !== kind) throw new TypeError("Card source binding differs from the presentation registry.");
    Object.freeze(source);
  }
  return Object.freeze(sources);
})();
