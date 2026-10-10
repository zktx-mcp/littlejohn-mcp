import {captureCanonicalJson, canonicalJsonStringify, type ApplicationFailure, type CanonicalJson} from "../../core/index.js";
import {exchangeApplicationContracts, admitExchangeConfirmationResult, type ExchangeApplicationPort} from "../../review/application-contracts.js";
import {exchangeDirectDecisionSchema} from "../../review/contracts.js";
import {exchangeFailureCode, createExchangeFailure} from "../../review/errors.js";
import {signingApplicationContracts, type SigningApplicationPort} from "../../review/signing-application-contracts.js";
import {signingDirectDecisionSchema, signingResponseContext, admitSigningCompletion} from "../../review/signing-contracts.js";
import {signingFailureCode, createSigningFailure} from "../../review/signing-errors.js";
import type {PreparedReviewDispatch} from "../../review/prepared-dispatch.js";
import {walletManagementContracts, walletDirectActionSchema, createWalletOperationCancellation, parseWalletOperationPresentation,
  type WalletManagementOperation, type WalletQrMatrix, type WalletManagementPort, type WalletPreparedReview} from "../../wallet/contracts.js";
import {walletAccountSelectionContracts} from "../../wallet/account-selection-contract.js";
import {isWalletOperationCancellableState, isWalletOperationTerminalState} from "../../wallet/operation-state.js";
import {normalizeWalletError} from "../../wallet/errors.js";
import {tokenCatalogApplicationContracts, tokenSelectionDirectActionSchema, type TokenCatalogOperation} from "../../token-catalog/client.js";
import type {TokenCatalogManagementApplicationPort} from "../../token-catalog/ports.js";
import type {PreparedTokenSelectionReview} from "../../token-catalog/review-source.js";
import type {ReviewPresentationSource} from "../../runtime/presentation-snapshot.js";
import {operationToolResultEvidence} from "./contracts.js";
import {createDeliveryUnknown, createSelectorDeliveryUnknown} from "../operation-delivery.js";
import {CardError} from "./card-errors.js";
import {describeCardSource, type CardSourceIdentity, type CardOutcome, type DecisionCardRecord, type CardDecisionAdmission} from "./card-contract.js";
import {presentationContractRegistry, type PresentationDecisionKind, type PresentationContractEntry} from "./registry.js";

export interface CardDomains {
  readonly wallet: WalletManagementPort;
  readonly token: TokenCatalogManagementApplicationPort;
  readonly signing: SigningApplicationPort;
  readonly exchange: ExchangeApplicationPort;
}
export class CardDomainError extends Error {
  constructor(readonly failure: ApplicationFailure) { super(failure.error.message); }
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
export interface PreparedCardSource {
  readonly input: CanonicalJson;
  readonly value: CanonicalJson;
  readonly walletReview?: WalletPreparedReview;
  readonly tokenReview?: PreparedTokenSelectionReview;
  discard(): void;
}
export interface CardSource {
  readonly entry: PresentationContractEntry;
  prepare(domains: CardDomains, input: unknown, signal: AbortSignal): Promise<PreparedCardSource>;
  existing(domains: CardDomains, operationId: string, reviews: ReviewPresentationSource): PreparedCardSource;
  describe(value: unknown): CardSourceIdentity | null;
  decision(input: unknown): unknown;
  creatingValue(decision: unknown): unknown;
  dispatch(domains: CardDomains, input: unknown, signal: AbortSignal, admission?: CardDecisionAdmission): Promise<CardDispatchResult>;
  prepareDispatch?(domains: CardDomains, input: unknown, signal: AbortSignal): Promise<PreparedReviewDispatch<CardDispatchResult>>;
  operation?(domains: CardDomains, record: DecisionCardRecord, includeQr?: boolean): Promise<CardOperationObservation | null>;
  discard?(domains: CardDomains, operationId: string): unknown;
  end?(domains: CardDomains, record: DecisionCardRecord): Promise<void>;
  unknown(record: DecisionCardRecord, input?: unknown): CardOutcome;
}
const tokenValue = (value: unknown, contract: {parseFailure(value: unknown): ApplicationFailure}): unknown => {
  if (typeof value === "object" && value !== null && "ok" in value && value.ok === false) throw new CardDomainError(contract.parseFailure(value));
  return value;
};
const operationId = (record: DecisionCardRecord): string => {
  if (record.operationId === null) throw new CardError("presentation_inconsistent");
  return record.operationId;
};
const admittedSource = (entry: PresentationContractEntry, input: unknown, value: unknown, discard: () => void = () => {}): PreparedCardSource => {
  const command = entry.parseNormalizedInput(input);
  return Object.freeze({input: command, value: entry.parseResult(command, value), discard});
};
const privateExisting = (entry: PresentationContractEntry, id: string, reviews: ReviewPresentationSource): PreparedCardSource => {
  const result = reviews.readPresentation(id);
  if (result.status !== "available") throw new CardError(result.reason === "snapshot_missing" ? "review_unavailable" : "runtime_state_unavailable");
  const record = result.value.snapshot;
  if (record.contractId !== entry.contractId || record.contractVersion !== entry.contractVersion) throw new CardError("presentation_inconsistent");
  const decode = (bytes: Uint8Array): unknown => {
    const text = new TextDecoder("utf-8", {fatal: true}).decode(bytes);
    const value = captureCanonicalJson(JSON.parse(text));
    if (canonicalJsonStringify(value) !== text) throw new CardError("presentation_inconsistent");
    return value;
  };
  return admittedSource(entry, decode(record.inputBytes), decode(record.resultBytes));
};
const readWalletOperation = async (wallet: WalletManagementPort, record: DecisionCardRecord, includeQr = false): Promise<CardOperationObservation | null> => {
  const id = operationId(record);
  try {
    const observed = includeQr ? parseWalletOperationPresentation(await wallet.getPresentation(id)) : {operation: await wallet.get(id)};
    const operation = walletManagementContracts.operation.parsePublicSuccess({operationId: id}, observed.operation);
    if (operationToolResultEvidence({status: "review", review: operation.review}).sha256 !== record.resultDigest) throw new CardError("presentation_inconsistent");
    return {value: operation, ...(observed.qr === undefined ? {} : {qr: observed.qr})};
  } catch (error) {
    if (error instanceof CardError) throw error;
    const failure = normalizeWalletError(error).failure;
    if (failure.error.code === "wallet_operation_not_found") return null;
    throw new CardDomainError(failure);
  }
};
const signingPrepared = async (port: SigningApplicationPort, input: unknown, signal: AbortSignal): Promise<PreparedReviewDispatch<CardDispatchResult>> => {
  const decision = signingDirectDecisionSchema.parse(input);
  const context = signingResponseContext(decision.review);
  try {
    const prepared = await port.prepareConfirm(decision, signal);
    return Object.freeze({source: prepared.source, discard: () => prepared.discard(), execute: async () => {
      try {
        const completion = admitSigningCompletion(context, await prepared.execute());
        return {value: captureCanonicalJson(completion), outcome: {kind: "signing" as const, status: completion.outcome.status}};
      } catch (error) { throw new CardDomainError(createSigningFailure(signingFailureCode(error) ?? "internal_error")); }
    }});
  } catch (error) { throw new CardDomainError(createSigningFailure(signingFailureCode(error) ?? "internal_error")); }
};
const transactionPrepared = async (port: ExchangeApplicationPort, input: unknown, signal: AbortSignal): Promise<PreparedReviewDispatch<CardDispatchResult>> => {
  const decision = exchangeDirectDecisionSchema.parse(input);
  const id = decision.review.observation.data.operationId;
  try {
    const prepared = await port.prepareConfirm(decision, signal);
    const resultOf = (value: unknown): CardDispatchResult => {
      const result = admitExchangeConfirmationResult(id, value);
      if (result.kind === "wallet_result") return {value: captureCanonicalJson(result), outcome: {kind: "transaction", result: result.outcome}};
      const review = result.review;
      if (review.state === "ready_for_wallet_review") throw new CardError("presentation_inconsistent");
      return {value: captureCanonicalJson(result), outcome: {kind: "review", state: review.state, failureCode: review.failure.error.code}};
    };
    return Object.freeze({source: prepared.source, ...(prepared.result === undefined ? {} : {result: resultOf(prepared.result)}),
      discard: () => prepared.discard(), execute: async () => {
      try {
        return resultOf(await prepared.execute());
      } catch (error) { throw new CardDomainError(createExchangeFailure(exchangeFailureCode(error) ?? "internal_error")); }
    }});
  } catch (error) { throw new CardDomainError(createExchangeFailure(exchangeFailureCode(error) ?? "internal_error")); }
};
export const cardSources: Readonly<Record<PresentationDecisionKind, CardSource>> = (() => {
  const walletEntry = presentationContractRegistry.requireCardKind("wallet");
  const tokenEntry = presentationContractRegistry.requireCardKind("token_selection");
  const signingEntry = presentationContractRegistry.requireCardKind("signing");
  const transactionEntry = presentationContractRegistry.requireCardKind("transaction");
  const selectionEntry = presentationContractRegistry.requireCardKind("wallet_selection");
  const sources: Record<PresentationDecisionKind, CardSource> = {
    wallet: {
      entry: walletEntry,
      async prepare(domains, input) {
        const command = walletManagementContracts.review.parseInput(input);
        try {
          const prepared = await domains.wallet.prepareReview(command);
          if (prepared.status !== "review") return admittedSource(walletEntry, command, prepared);
          return Object.freeze({...admittedSource(walletEntry, command, {status: "review", review: prepared.prepared.review}),
            walletReview: prepared.prepared, discard: () => domains.wallet.discardPreparedReview(prepared.prepared)});
        } catch (error) { throw new CardDomainError(normalizeWalletError(error).failure); }
      },
      existing: (domains, id) => {const source = domains.wallet.getReviewSource(id); return admittedSource(walletEntry, source.input, source.result);},
      describe: (value) => describeCardSource("wallet", value),
      decision: (input) => walletDirectActionSchema.parse(input),
      creatingValue: (input) => ({status: "review", review: walletDirectActionSchema.parse(input).review}),
      async dispatch(domains, input, _signal, admission) {
        const decision = walletDirectActionSchema.parse(input);
        const contract = walletManagementContracts[decision.review.kind];
        try {
          const operation = contract.parsePublicSuccess(decision, await domains.wallet.decide(decision, admission));
          return {value: captureCanonicalJson(operation), operation: {value: operation}, outcome: isWalletOperationTerminalState(operation.state) ? {kind: "operation"} : null};
        } catch (error) { throw new CardDomainError(normalizeWalletError(error).failure); }
      },
      operation: (domains, record, includeQr) => readWalletOperation(domains.wallet, record, includeQr),
      async end(domains, record) {
        const observed = await readWalletOperation(domains.wallet, record);
        if (observed?.value.domain !== "wallet" || !isWalletOperationCancellableState(observed.value.state)) return;
        try { await domains.wallet.cancel(createWalletOperationCancellation(observed.value)); }
        catch (error) { const failure = normalizeWalletError(error).failure; if (failure.error.code !== "state_conflict") throw new CardDomainError(failure); }
      },
      unknown: (record) => ({kind: "delivery", result: createDeliveryUnknown("decide", operationId(record))}),
    },
    wallet_selection: {
      entry: selectionEntry,
      async prepare(domains, input, signal) {
        const command = walletAccountSelectionContracts.get.parseInput(input);
        try { return admittedSource(selectionEntry, command, await domains.wallet.getAccountSelection(command, signal)); }
        catch (error) { throw new CardDomainError(normalizeWalletError(error).failure); }
      },
      existing() {throw new CardError("invalid_input");},
      describe: (value) => describeCardSource("wallet_selection", value),
      decision: (input) => walletAccountSelectionContracts.select.parseInput(input),
      creatingValue() {throw new CardError("invalid_input");},
      async dispatch(domains, input, signal, admission) {
        const command = walletAccountSelectionContracts.select.parseInput(input);
        try {
          const value = walletAccountSelectionContracts.select.parsePublicSuccess(command, await domains.wallet.selectAccount(command, signal, admission));
          return {value: captureCanonicalJson(value), outcome: {kind: "wallet_selection", value}};
        } catch (error) { throw new CardDomainError(normalizeWalletError(error).failure); }
      },
      unknown: (record, input) => ({kind: "delivery", result: createSelectorDeliveryUnknown(walletAccountSelectionContracts.select.parseInput(input), record.cardId)}),
    },
    token_selection: {
      entry: tokenEntry,
      async prepare(domains, input) {
        const command = tokenCatalogApplicationContracts.selectionChangeReview.parseInput(input);
        const prepared = await domains.token.prepareReview(command);
        return Object.freeze({...admittedSource(tokenEntry, command, prepared.result), tokenReview: prepared,
          discard: () => domains.token.discardPreparedReview(prepared)});
      },
      existing: (domains, id) => {const source = domains.token.getReviewSource(id); return admittedSource(tokenEntry, source.input, source.result);},
      describe: (value) => describeCardSource("token_selection", value),
      decision: (input) => tokenSelectionDirectActionSchema.parse(input),
      creatingValue: (input) => ({review: tokenSelectionDirectActionSchema.parse(input).review}),
      async dispatch(domains, input, _signal, admission) {
        const decision = tokenSelectionDirectActionSchema.parse(input);
        const contract = decision.review.kind === "add" ? tokenCatalogApplicationContracts.addSelection : tokenCatalogApplicationContracts.removeSelection;
        const operation = contract.parsePublicSuccess(decision as never, tokenValue(await domains.token.decide(decision, admission), contract));
        return {value: captureCanonicalJson(operation), operation: {value: operation}, outcome: {kind: "operation"}};
      },
      async operation(domains, record) {
        const command = tokenCatalogApplicationContracts.operation.parseInput({operationId: operationId(record)});
        const raw = domains.token.getOperation(command);
        if (typeof raw === "object" && raw !== null && "ok" in raw && raw.ok === false) {
          const failure = tokenCatalogApplicationContracts.operation.parseFailure(raw);
          if (failure.error.code === "token_operation_not_found") return null;
          throw new CardDomainError(failure);
        }
        const value = tokenCatalogApplicationContracts.operation.parsePublicSuccess(command, raw);
        if (operationToolResultEvidence({review: value.review}).sha256 !== record.resultDigest) throw new CardError("presentation_inconsistent");
        return {value};
      },
      unknown: (record) => ({kind: "delivery", result: createDeliveryUnknown("decide", operationId(record))}),
    },
    signing: {
      entry: signingEntry,
      async prepare(domains, input, signal) {
        const command = signingApplicationContracts.start.parseInput(input);
        try {const review = await domains.signing.start(command, signal); return admittedSource(signingEntry, command, review, () => {domains.signing.cancel(review.operationId);});}
        catch (error) {throw new CardDomainError(createSigningFailure(signingFailureCode(error) ?? "internal_error"));}
      },
      existing: (_domains, id, reviews) => privateExisting(signingEntry, id, reviews),
      describe: (value) => describeCardSource("signing", value),
      decision: (input) => signingDirectDecisionSchema.parse(input),
      creatingValue: (input) => signingDirectDecisionSchema.parse(input).review,
      prepareDispatch: (domains, input, signal) => signingPrepared(domains.signing, input, signal),
      async dispatch(domains, input, signal) {const prepared = await signingPrepared(domains.signing, input, signal); try {return await prepared.execute();} finally {prepared.discard();}},
      discard: (domains, id) => domains.signing.cancel(id),
      unknown: () => ({kind: "signing", status: "delivery_unknown"}),
    },
    transaction: {
      entry: transactionEntry,
      async prepare(domains, input, signal) {
        const command = exchangeApplicationContracts.start.parseInput(input);
        try {const review = await domains.exchange.start(command, signal); return admittedSource(transactionEntry, command, review, () => {domains.exchange.cancel(review.state === "ready_for_wallet_review" ? review.observation.data.operationId : review.operationId);});}
        catch (error) {throw new CardDomainError(createExchangeFailure(exchangeFailureCode(error) ?? "internal_error"));}
      },
      existing: (_domains, id, reviews) => privateExisting(transactionEntry, id, reviews),
      describe: (value) => describeCardSource("transaction", value),
      decision: (input) => exchangeDirectDecisionSchema.parse(input),
      creatingValue: (input) => exchangeDirectDecisionSchema.parse(input).review,
      prepareDispatch: (domains, input, signal) => transactionPrepared(domains.exchange, input, signal),
      async dispatch(domains, input, signal) {const prepared = await transactionPrepared(domains.exchange, input, signal); try {return await prepared.execute();} finally {prepared.discard();}},
      discard: (domains, id) => domains.exchange.cancel(id),
      unknown: () => ({kind: "transaction", result: {status: "delivery_unknown"}}),
    },
  };
  for (const [kind, source] of Object.entries(sources)) {
    if (source.entry.cardKind !== kind) throw new TypeError("Card source binding differs from the presentation registry.");
    Object.freeze(source);
  }
  return Object.freeze(sources);
})();
