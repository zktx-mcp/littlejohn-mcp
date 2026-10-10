import {walletSelectAccountSuccessSchema, walletAccountSelectionSchema} from "../../wallet/account-selection-contract.js";
import {walletConnectionIdSchema} from "../../wallet/connection-contract.js";
import {walletLocalRevisionSchema, walletLocalRevisionDecimalBytes} from "../../wallet/local-revision.js";
import {evmChainIdSchema} from "../../evm/identities.js";
import { operationToolResultEvidence, operationToolResultDescriptorSchema, presentationSnapshotIdSchema, presentationSnapshotDescriptorSchema, presentationSnapshotResourceSchema, walletOperationQrMetadataSchema, type PresentationSnapshotDescriptor } from "./contracts.js";
import { z } from "zod";
import {canonicalJsonStringify, captureCanonicalJson, deepFreezeValue, defineApplicationContract, capabilityIdSchema, type ApplicationContract, type CapabilityId, operationIdByteLength, operationIdSchema, utcTimestampSchema, utf8ByteLength, unsignedDecimalSchema} from "../../core/client.js";
import {evmAccountIdentitySchema} from "../../evm/identities.js";
import {erc20AssetIdentitySchema} from "../../evm/amounts.js";
import { exchangeWalletOutcomeSchema } from "../../review/response-contract.js";
import { signingOutcomeSchema, signingMethodSchema, signingReviewSchema } from "../../review/signing-contracts.js";
import {exchangeReviewSchema} from "../../review/contracts.js";
import { signingErrorRegistry } from "../../review/signing-errors.js";
import { exchangeErrorRegistry } from "../../review/errors.js";
import { tokenCatalogApplicationContracts, tokenCatalogErrorDefinitions, tokenSelectionReviewResultSchema } from "../../token-catalog/client.js";
import { presentationDecisionKinds, presentationContractRegistry, presentationContracts, type PresentationDecisionKind } from "./registry.js";
import { deliveryUnknownSchema } from "../operation-delivery.js";
import { stockTokenTradeHistoryFailureCodes } from "../../stock-token-trade-history/contracts.js";
import { walletOperationStates, walletOperationKinds, walletInitiators, isWalletOperationTerminalState } from "../../wallet/operation-state.js";
import { walletPeerRefusalCodeSchema, walletReviewResultSchema } from "../../wallet/operation-contract.js";
import { tokenSelectionRevisionSchema } from "../../token-catalog/client.js";
import type { PresentationSnapshotStore } from "../../runtime/presentation-snapshot.js";
import { internalCanonicalJsonResponseLimitBytes } from "../../runtime/http-limits.js";

export const cardErrorDefinitions = Object.freeze([
  { code: "presentation_not_found", category: "domain", message: "This exact card is not retained.", retryable: false },
  { code: "presentation_capacity_exceeded", category: "domain", message: "Card storage capacity is exhausted.", retryable: false },
  { code: "presentation_inconsistent", category: "domain", message: "Card identity or state is inconsistent.", retryable: false },
] as const);
const inheritedFailureCodes = new Set<string>(exchangeErrorRegistry.values().map((definition) => definition.code));
const registeredFailureDefinitions = new Map([
  ...tokenCatalogErrorDefinitions,
  ...presentationContractRegistry.values().flatMap((entry) => entry.failureCodes.map((code) => entry.errorRegistry.get(code))),
  ...cardErrorDefinitions,
].filter((definition) => !inheritedFailureCodes.has(definition.code))
  .map((definition) => [definition.code, definition]));
export const cardRegistryErrorDefinitions = Object.freeze([...registeredFailureDefinitions.values()]);
export const cardErrorRegistry = exchangeErrorRegistry.extend(cardRegistryErrorDefinitions);

export const cardInputStates = Object.freeze(["input_pending", "input_closed"] as const);
export const cardCloseReasons = Object.freeze(["submitted", "expired", "discarded", "invalidated", "owner_lost"] as const);
export const cardKinds = Object.freeze([...presentationDecisionKinds, "read", "preparing"] as const);
const immutableReadEntries = presentationContractRegistry.values().filter((entry) => entry.presentationKind === "immutable_result");
const readInputSchemas = immutableReadEntries.map((entry) => z.object({capabilityId: z.literal(entry.contractId), input: entry.inputSchema}).strict());
const [firstRead, secondRead, ...otherReads] = readInputSchemas;
if (firstRead === undefined || secondRead === undefined) throw new TypeError("Read-card registry requires its registered immutable inputs.");
export const cardReadInputSchema = z.discriminatedUnion("capabilityId", [firstRead, secondRead, ...otherReads])
  .transform((value) => ({capabilityId: value.capabilityId, input: value.input}));
export type CardReadInput = z.infer<typeof cardReadInputSchema>;
const normalizedReadSchemas = immutableReadEntries.map((entry) => z.object({capabilityId: z.literal(entry.contractId),
  input: z.unknown().transform((value) => entry.parseNormalizedInput(value))}).strict());
const [firstNormalizedRead, secondNormalizedRead, ...otherNormalizedReads] = normalizedReadSchemas;
if (firstNormalizedRead === undefined || secondNormalizedRead === undefined) throw new TypeError("Normalized read-card registry is incomplete.");
const normalizedReadInputSchema = z.discriminatedUnion("capabilityId", [firstNormalizedRead, secondNormalizedRead, ...otherNormalizedReads]);
const digest = operationToolResultDescriptorSchema.shape.resultSha256;
const snapshotId = presentationSnapshotIdSchema;
const failureCodes = [...new Set([
  ...signingErrorRegistry.values().map((entry) => entry.code),
  ...cardErrorRegistry.values().map((entry) => entry.code),
  ...Object.values(tokenCatalogApplicationContracts).flatMap((contract) => contract.failureCodes),
  ...stockTokenTradeHistoryFailureCodes,
  ...presentationContractRegistry.values().flatMap((entry) => entry.failureCodes),
])];
const signingStatus = z.union(signingOutcomeSchema.options.map((entry) => entry.shape.status));

export const cardOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("signing"), status: signingStatus }).strict(),
  z.object({ kind: z.literal("transaction"), result: exchangeWalletOutcomeSchema }).strict(),
  z.object({ kind: z.literal("review"), state: z.enum(["blocked", "refresh_required"]), failureCode: z.enum(failureCodes) }).strict(),
  z.object({ kind: z.literal("failure"), failureCode: z.enum(failureCodes) }).strict(),
  z.object({ kind: z.literal("operation") }).strict(),
  z.object({kind: z.literal("wallet_selection"), value: walletSelectAccountSuccessSchema}).strict(),
  z.object({ kind: z.literal("delivery"), result: deliveryUnknownSchema }).strict(),
]);
export type CardOutcome = z.infer<typeof cardOutcomeSchema>;

export interface CardSourceIdentity {
  readonly operationId: string | null;
  readonly expiresAt: string | null;
  readonly outcome: CardOutcome | null;
  readonly context?: unknown;
}

export const describeCardSource = (kind: PresentationDecisionKind, value: unknown): CardSourceIdentity | null => {
  if (kind === "wallet") {
    const result = walletReviewResultSchema.parse(value);
    return result.status === "review" ? {operationId: result.review.operationId, expiresAt: result.review.actionExpiresAt, outcome: null} : null;
  }
  if (kind === "token_selection") {
    const {review} = tokenSelectionReviewResultSchema.parse(value);
    return {operationId: review.operationId, expiresAt: review.actionExpiresAt, outcome: null};
  }
  if (kind === "wallet_selection") {
    const result = walletAccountSelectionSchema.parse(value);
    return {operationId: null, expiresAt: null, outcome: null, context: {connectionId: result.connectionId,
      chainId: result.chainId, originalConnectionRevision: result.connectionRevision}};
  }
  if (kind === "signing") {
    const review = signingReviewSchema.parse(value);
    return {operationId: review.operationId, expiresAt: review.actionExpiresAt, outcome: null,
      context: {account: review.account, method: review.method}};
  }
  const review = exchangeReviewSchema.parse(value);
  return review.state === "ready_for_wallet_review"
    ? {operationId: review.observation.data.operationId, expiresAt: review.observation.data.actionExpiresAt, outcome: null,
      context: {account: review.observation.data.intent.account}}
    : {operationId: review.operationId, expiresAt: null, outcome: {kind: "review", state: review.state, failureCode: review.failure.error.code},
      context: {account: null}};
};

const decisionRecordShape = {
  cardId: operationIdSchema,
  contractVersion: z.literal("1"),
  operationId: operationIdSchema,
  resultDigest: digest,
  snapshotId: snapshotId.nullable(),
  inputState: z.enum(cardInputStates),
  closeReason: z.enum(cardCloseReasons).nullable(),
  dispatchId: operationIdSchema.nullable(),
  expiresAt: utcTimestampSchema.nullable(),
  outcome: cardOutcomeSchema.nullable(),
};
const decisionRecordSchema = z.discriminatedUnion("kind", [
  z.object({ ...decisionRecordShape, kind: z.literal("wallet") }).strict(),
  z.object({...decisionRecordShape, kind: z.literal("wallet_selection"), operationId: z.null(),
    context: z.object({connectionId: walletConnectionIdSchema, chainId: evmChainIdSchema, originalConnectionRevision: walletLocalRevisionSchema}).strict()}).strict(),
  z.object({ ...decisionRecordShape, kind: z.literal("token_selection") }).strict(),
  z.object({ ...decisionRecordShape, kind: z.literal("signing"), context: z.object({ account: evmAccountIdentitySchema, method: signingMethodSchema }).strict() }).strict(),
  z.object({ ...decisionRecordShape, kind: z.literal("transaction"), context: z.object({ account: evmAccountIdentitySchema.nullable() }).strict() }).strict(),
]).superRefine((value, context) => {
  const durable = value.kind === "wallet" || value.kind === "token_selection" || value.kind === "wallet_selection";
  if ((value.inputState === "input_closed") !== (value.closeReason !== null) ||
      (value.closeReason === "submitted") !== (value.dispatchId !== null) ||
      (value.snapshotId !== null) !== durable || (value.inputState === "input_pending" && ((value.kind !== "wallet_selection" && value.expiresAt === null) || value.outcome !== null)) ||
      (value.outcome?.kind === "operation" && (!durable || value.kind === "wallet_selection")) ||
      (value.outcome?.kind === "delivery" && (value.outcome.result.action === "select_account"
        ? value.kind !== "wallet_selection" || value.outcome.result.cardId !== value.cardId
        : !durable || value.outcome.result.operationId !== value.operationId || value.outcome.result.action !== "decide")) ||
      (value.outcome?.kind === "signing" && value.kind !== "signing") ||
      (value.outcome?.kind === "wallet_selection" && (value.kind !== "wallet_selection" || value.outcome.value.connectionId !== value.context.connectionId ||
        value.outcome.value.chainId !== value.context.chainId || value.outcome.value.connectionRevision !== value.context.originalConnectionRevision)) ||
      ((value.outcome?.kind === "transaction" || value.outcome?.kind === "review") && value.kind !== "transaction")) {
    context.addIssue({code: "custom", message: "Decision input, source and domain outcome are inconsistent."});
  }
});
export type DecisionCardRecord = z.infer<typeof decisionRecordSchema>;
export const readCardRecordSchema = z.object({
  cardId: operationIdSchema, kind: z.literal("read"), contractVersion: z.literal("1"),
  contractId: z.enum([...immutableReadEntries.map((entry) => entry.contractId), presentationContracts.walletReview.contractId]), inputDigest: digest, snapshotId: snapshotId.nullable(),
  preparationState: z.enum(["pending", "completed", "failed"]),
  outcome: z.union([
    z.object({kind: z.literal("snapshot")}).strict(),
    z.object({kind: z.literal("failure"), failureCode: z.enum(failureCodes)}).strict(),
  ]).nullable(),
}).strict().refine((value) => value.preparationState === "pending" ? value.outcome === null && value.snapshotId === null
  : value.preparationState === "completed" ? value.outcome?.kind === "snapshot" && value.snapshotId !== null
    : value.outcome?.kind === "failure" && value.snapshotId === null);
export type ReadCardRecord = z.infer<typeof readCardRecordSchema>;
export const preparingCardRecordSchema = z.object({
  cardId: operationIdSchema, kind: z.literal("preparing"), contractVersion: z.literal("1"),
  sourceKind: z.enum([...presentationDecisionKinds, "read"]), inputDigest: digest,
  creationState: z.enum(["creating", "owner_lost"]),
}).strict();
export type PreparingCardRecord = z.infer<typeof preparingCardRecordSchema>;
export const cardRecordSchema = z.union([decisionRecordSchema, readCardRecordSchema, preparingCardRecordSchema]);
export type CardRecord = z.infer<typeof cardRecordSchema>;
export const isCardInputTransition = (before: DecisionCardRecord, after: DecisionCardRecord): boolean =>
  before.inputState === "input_pending" ? after.inputState === "input_pending" || after.inputState === "input_closed"
    : after.inputState === "input_closed" && before.closeReason === after.closeReason && before.dispatchId === after.dispatchId;

// Closed JSON field widths, including the largest complete outcome branch.
// IDs use Core's 32-byte base64url encoding; digests and UTC use their owning encodings.
const idWidth = Math.ceil(operationIdByteLength * 4 / 3);
const longest = (values: readonly string[]) => values.reduce((a, b) => a.length >= b.length ? a : b);
const revisionWidth = walletLocalRevisionDecimalBytes;
const nativeChainEnvelope = `eip155:${"9".repeat(32)}`;
const accountEnvelope = {chainId: nativeChainEnvelope, address: `0x${"0".repeat(40)}`};
const selectionEnvelope = {connectionId: `wallet-session:${"A".repeat(idWidth)}`, connectionRevision: "9".repeat(revisionWidth),
  chainId: nativeChainEnvelope, account: accountEnvelope, selectionRevision: "9".repeat(revisionWidth)};
const selectorEnvelope = {connectionId: selectionEnvelope.connectionId, chainId: nativeChainEnvelope, account: accountEnvelope,
  expectedConnectionRevision: "9".repeat(revisionWidth), expectedSelectionRevision: "9".repeat(revisionWidth)};
const outcomeEnvelopes = [
  {kind: "signing", status: longest(signingOutcomeSchema.options.flatMap((entry) => {
    const status = entry.shape.status;
    return "options" in status ? status.options : [...status.values];
  }))},
  {kind: "transaction", result: {status: "hash_returned", transactionHash: `0x${"0".repeat(64)}`, recording: "recorded", lookup: "not_started"}},
  {kind: "review", state: "refresh_required", failureCode: longest(failureCodes)},
  {kind: "failure", failureCode: longest(failureCodes)}, {kind: "operation"},
  {kind: "wallet_selection", value: selectionEnvelope},
  {kind: "delivery", result: {status: "delivery_unknown", action: "decide", operationId: "A".repeat(idWidth), resendAllowed: false}},
  {kind: "delivery", result: {status: "delivery_unknown", action: "select_account", selector: selectorEnvelope, cardId: "A".repeat(idWidth),
    recovery: {capabilityId: "wallet.account_selection", input: {chainId: nativeChainEnvelope}}, resendAllowed: false}},
];
const outcomeBytes = Math.max(...outcomeEnvelopes.map((value) => utf8ByteLength(JSON.stringify(value))));
const contexts = [{account: accountEnvelope, method: longest(signingMethodSchema.options)},
  {connectionId: selectionEnvelope.connectionId, chainId: nativeChainEnvelope, originalConnectionRevision: "9".repeat(revisionWidth)}];
const contextBytes = Math.max(...contexts.map((context) => utf8ByteLength(JSON.stringify({context})) - 2));
const baseEnvelope = {cardId: "A".repeat(idWidth), kind: longest(presentationDecisionKinds), contractVersion: "1",
  operationId: "A".repeat(idWidth), resultDigest: "0".repeat(64), snapshotId: `sha256:${"0".repeat(64)}`,
  expiresAt: "2099-12-31T23:59:59.999Z", inputState: longest(cardInputStates), closeReason: longest(cardCloseReasons), dispatchId: "A".repeat(idWidth), outcome: null};
const readEnvelope = {cardId: "A".repeat(idWidth), kind: "read", contractVersion: "1", contractId: longest(immutableReadEntries.map((entry) => entry.contractId)), inputDigest: "0".repeat(64),
  snapshotId: `sha256:${"0".repeat(64)}`, preparationState: "completed", outcome: {kind: "failure", failureCode: longest(failureCodes)}};
const recordBytes = Math.max(utf8ByteLength(JSON.stringify(baseEnvelope)) - 4 + outcomeBytes + 1 + contextBytes,
  utf8ByteLength(JSON.stringify(readEnvelope)));
export const presentationCardLimits = Object.freeze({ rows: 16_384, recordBytes, aggregateBytes: 16_384 * recordBytes });

export const admitCardRecord = (input: unknown): Readonly<CardRecord> => {
  const captured = captureCanonicalJson(input);
  if (utf8ByteLength(canonicalJsonStringify(captured)) > presentationCardLimits.recordBytes) throw new TypeError("Card metadata exceeds its closed envelope.");
  return deepFreezeValue(cardRecordSchema.parse(captured));
};

export const cardReferenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("card"), cardId: operationIdSchema }).strict(),
  z.object({ kind: z.literal("snapshot"), snapshotId }).strict(),
]);
export type CardReference = z.infer<typeof cardReferenceSchema>;
export const presentationCardMetadataKey = "littlejohn/presentation-card" as const;
export const presentationCardUriPrefix = "littlejohn://presentation/cards/" as const;
export const presentationCardUri = (cardId: string): string => `${presentationCardUriPrefix}${operationIdSchema.parse(cardId)}`;
export const cardIdFromPresentationUri = (uri: string): string => {
  if (!uri.startsWith(presentationCardUriPrefix)) throw new TypeError("Card resource URI is invalid.");
  return operationIdSchema.parse(uri.slice(presentationCardUriPrefix.length));
};
export const cardOpeningSchema = z.object({ cardId: operationIdSchema, cardOpenRequestId: operationIdSchema }).strict();
export const cardIdInputSchema = z.object({ cardId: operationIdSchema }).strict();
export const cardReadReferenceSchema = z.union([
  z.object({ kind: z.literal("card"), cardId: operationIdSchema, cardOpenRequestId: operationIdSchema.optional() }).strict(),
  z.object({ kind: z.literal("snapshot"), snapshotId }).strict(),
]);

export const assertCardPresentationSource = (record: DecisionCardRecord, descriptor: PresentationSnapshotDescriptor): void => {
  const entry = presentationContractRegistry.requireCardKind(record.kind);
  const source = descriptor.source;
  if (entry.contractId !== descriptor.contractId || record.contractVersion !== descriptor.contractVersion ||
      record.resultDigest !== descriptor.resultSha256 ||
      (record.snapshotId !== null ? source.kind !== "sqlite" || record.snapshotId !== descriptor.snapshotId
        : record.expiresAt === null ? true
          : source.kind !== "review_memory" || source.operationId !== record.operationId || source.expiresAt !== record.expiresAt)) {
    throw new TypeError("Presentation source differs from its saved card.");
  }
};

export const admitCardSourceResult = (record: DecisionCardRecord, normalizedInput: unknown, value: unknown): import("../../core/client.js").CanonicalJson => {
  const entry = presentationContractRegistry.requireCardKind(record.kind);
  const result = entry.parseResult(normalizedInput, value);
  const identity = describeCardSource(record.kind, result);
  const context = "context" in record ? captureCanonicalJson(record.context) : null;
  const sourceContext = identity?.context === undefined ? null : captureCanonicalJson(identity.context);
  if (identity === null || identity.operationId !== record.operationId || identity.expiresAt !== record.expiresAt ||
      operationToolResultEvidence(result).sha256 !== record.resultDigest || canonicalJsonStringify(context) !== canonicalJsonStringify(sourceContext)) {
    throw new TypeError("Canonical decision subject or lifetime differs from its saved card.");
  }
  return result;
};

export const cardReferenceContract = defineApplicationContract({
  contractVersion: "1",
  inputSchema: z.object({ cardId: operationIdSchema, descriptor: presentationSnapshotDescriptorSchema }).strict(),
  successSchema: cardReferenceSchema.options[0], internalContextSchema: z.object({}).strict(),
  errorRegistry: cardErrorRegistry, failureCodes: cardErrorRegistry.values().map((value) => value.code),
});

export const cardStateSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("static"), reference: cardReferenceSchema,
    record: cardRecordSchema.nullable(),
  }).strict().refine((value) => value.reference.kind === "snapshot" ? value.record === null : value.record !== null && (value.record.kind === "read" || value.record.kind === "preparing" || value.record.inputState === "input_closed")),
  z.object({
    mode: z.literal("interactive"), reference: z.object({ kind: z.literal("card"), cardId: operationIdSchema }).strict(),
    record: cardRecordSchema,
  }).strict().refine((value) => value.record.kind !== "read" && value.record.kind !== "preparing" && value.record.inputState === "input_pending"),
]).superRefine((value, context) => {
  if (value.reference.kind === "card" && value.reference.cardId !== value.record?.cardId) {
    context.addIssue({ code: "custom", message: "Card reference and state differ." });
  }
});
export type CardState = z.infer<typeof cardStateSchema>;
export const cardState = (record: CardRecord): CardState => deepFreezeValue(cardStateSchema.parse({
  mode: record.kind !== "read" && record.kind !== "preparing" && record.inputState === "input_pending" ? "interactive" : "static", reference: { kind: "card", cardId: record.cardId }, record,
}));

export interface PresentationCardStore {
  unsettled(): readonly CardRecord[];
  read(cardId: string): CardRecord | null;
  replace(expected: CardRecord, next: CardRecord): CardRecord;
  prepareDecision(expected: DecisionCardRecord, dispatchId: string, callerSignal?: AbortSignal): CardDecisionAdmission;
  commitDecision(admission: CardDecisionAdmission, source: CardDecisionSource, outcome?: CardOutcome): DecisionCardRecord;
  discardDecision(admission: CardDecisionAdmission): void;
  beginCreation(sourceKind: PreparingCardRecord["sourceKind"], normalizedInput: import("../../core/client.js").CanonicalJson, publicationKey: string | null): CardCreationAdmission;
  commitCreation(admission: CardCreationReservation, record: DecisionCardRecord | ReadCardRecord,
    snapshot?: Parameters<PresentationSnapshotStore["commit"]>[0], walletReview?: import("../../wallet/contracts.js").WalletPreparedReview,
    tokenReview?: import("../../token-catalog/review-source.js").PreparedTokenSelectionReview, readInputBytes?: number): CardRecord;
  discardCreation(admission: CardCreationReservation): void;
  completeRead(expected: ReadCardRecord, snapshot: Parameters<PresentationSnapshotStore["commit"]>[0]): ReadCardRecord;
}

export interface CardDecisionAdmission { readonly __cardDecisionAdmission: unique symbol }
export interface CardCreationReservation { readonly __cardCreationReservation: unique symbol }
export type CardCreationAdmission =
  | Readonly<{status: "reserved"; cardId: string; reservation: CardCreationReservation}>
  | Readonly<{status: "existing" | "creating"; cardId: string}>;
export const cardCreationResultSchema = z.object({kind: z.literal("card"), cardId: operationIdSchema,
  disposition: z.enum(["created", "existing", "creating"])}).strict();
export type CardCreationResult = z.infer<typeof cardCreationResultSchema>;
export type CardDecisionSource =
  | Readonly<{kind: Exclude<PresentationDecisionKind, "wallet_selection">; operationId: string; resultDigest: string}>
  | Readonly<{kind: "wallet_selection"; connectionId: string; chainId: string; connectionRevision: string}>;

const operationProjectionCommon = {
  operationId: operationIdSchema, resultSha256: digest, initiatedBy: z.enum(walletInitiators), actionExpiresAt: utcTimestampSchema,
};
export const cardOperationProjectionSchema = z.discriminatedUnion("kind", [
  z.object({ ...operationProjectionCommon, kind: z.literal("wallet"), action: z.enum(walletOperationKinds), state: z.enum(walletOperationStates),
    account: evmAccountIdentitySchema.nullable(), connectionRevision: unsignedDecimalSchema.nullable(),
    peerRefusalCode: walletPeerRefusalCodeSchema.nullable(), failureCode: z.enum(failureCodes).nullable(),
  }).strict(),
  z.object({ ...operationProjectionCommon, kind: z.literal("token_selection"), action: z.enum(["add", "remove"]), state: z.literal("completed"),
    account: evmAccountIdentitySchema, asset: erc20AssetIdentitySchema, included: z.boolean(),
    selectionRevision: tokenSelectionRevisionSchema, completedAt: utcTimestampSchema,
  }).strict(),
]);
export type CardOperationProjection = z.infer<typeof cardOperationProjectionSchema>;
export const cardPresentationSchema = z.object({
  state: cardStateSchema,
  display: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("summary") }).strict(),
    z.object({ kind: z.literal("decision"), resource: presentationSnapshotResourceSchema }).strict(),
    z.object({ kind: z.literal("snapshot"), resource: presentationSnapshotResourceSchema }).strict(),
    z.object({ kind: z.literal("operation"), value: cardOperationProjectionSchema, review: presentationSnapshotResourceSchema.optional() }).strict(),
  ]),
  actions: z.array(z.enum(["confirm", "discard", "stop"])).max(2),
  selection: walletAccountSelectionSchema.optional(),
}).strict().superRefine((value, context) => {
  const record = value.state.record;
  if (new Set(value.actions).size !== value.actions.length ||
      ((value.actions.includes("confirm") || value.actions.includes("discard")) && (record === null || record.kind === "read" || record.kind === "preparing" || record.inputState !== "input_pending")) ||
      (value.actions.includes("stop") && (record === null || record.kind === "read" || record.kind === "preparing" ||
        (record.kind !== "wallet" && record.kind !== "signing" && record.kind !== "transaction") || record.closeReason !== "submitted")) ||
      (value.display.kind === "decision" && (record === null || record.kind === "read" || record.kind === "preparing" || record.inputState !== "input_pending" ||
        value.display.resource.descriptor.resultSha256 !== record.resultDigest)) ||
      (value.display.kind === "operation" && (record === null || record.kind === "read" || record.kind === "preparing" ||
        value.display.value.operationId !== record.operationId || value.display.value.kind !== record.kind))) {
    context.addIssue({ code: "custom", message: "Card presentation differs from saved state." });
  }
  if (value.selection !== undefined && (record?.kind !== "wallet_selection" || record.inputState !== "input_pending" ||
      value.selection.connectionId !== record.context.connectionId || value.selection.chainId !== record.context.chainId ||
      value.selection.connectionRevision !== record.context.originalConnectionRevision)) {
    context.addIssue({code: "custom", message: "Current selection belongs to another decision subject."});
  }
  if (value.display.kind === "decision" && record !== null && record.kind !== "read" && record.kind !== "preparing") {
    try { assertCardPresentationSource(record, value.display.resource.descriptor); }
    catch {
      context.addIssue({ code: "custom", message: "Review resource differs from its saved source." });
    }
  }
  if (value.actions.includes("confirm") && (value.display.kind !== "decision" || record === null || record.kind === "read" || record.kind === "preparing" ||
      (record.kind === "wallet_selection" && value.selection === undefined))) {
    context.addIssue({ code: "custom", message: "An admitted decision source is required for direct input." });
  }
  if (value.display.kind === "snapshot") {
    const expected = value.state.reference.kind === "snapshot" ? value.state.reference.snapshotId
      : record?.kind === "read" && record.outcome?.kind === "snapshot" ? record.snapshotId : undefined;
    if (expected !== value.display.resource.descriptor.snapshotId ||
        (record?.kind === "read" && (value.display.resource.descriptor.contractId !== record.contractId ||
          value.display.resource.descriptor.inputSha256 !== record.inputDigest))) {
      context.addIssue({ code: "custom", message: "Completed data differs from its saved read." });
    }
  }
  if (value.display.kind === "operation" && record !== null) {
    const terminal = value.display.value.kind === "token_selection" || isWalletOperationTerminalState(value.display.value.state);
    if (record.kind === "read" || record.kind === "preparing" || record.inputState !== "input_closed" ||
        (terminal && record.outcome?.kind !== "operation") || (!terminal && record.outcome?.kind === "operation")) {
      context.addIssue({ code: "custom", message: "Operation projection and card completion differ." });
    }
    if (value.display.review !== undefined) {
      try {
        if (record.kind !== "wallet") throw new TypeError("Only a durable Wallet operation carries its original decision resource.");
        assertCardPresentationSource(record, value.display.review.descriptor);
      } catch { context.addIssue({code: "custom", message: "Original operation decision differs from its saved card."}); }
    }
  }
});
export type CardPresentation = z.infer<typeof cardPresentationSchema>;
export const cardPresentationDeliverySchema = z.object({ presentation: cardPresentationSchema,
  qr: walletOperationQrMetadataSchema.optional(),
}).strict().superRefine((value, context) => {
  const display = value.presentation.display;
  if (value.qr !== undefined && (display.kind !== "operation" || display.value.kind !== "wallet" ||
      display.value.state !== "awaiting_wallet_approval" || value.qr.operationId !== display.value.operationId ||
      value.qr.resultSha256 !== display.value.resultSha256)) {
    context.addIssue({ code: "custom", message: "QR differs from the admitted operation." });
  }
});
export type CardPresentationDelivery = z.infer<typeof cardPresentationDeliverySchema>;
export const cardPresentationMetadataKey = "littlejohn/presentation-state" as const;
export const cardPresentationUnavailableSchema = z.object({ status: z.literal("unavailable"), cardId: operationIdSchema }).strict();

export const cardActionPresentationSchema = z.union([cardPresentationSchema, cardPresentationUnavailableSchema]);
export type CardActionPresentation = z.infer<typeof cardActionPresentationSchema>;

// Two previously bounded canonical payloads, one inserted result member, and HTTP framing.
const cardActionEnvelopeBytes = utf8ByteLength('{"result":0,"presentation":0}') - utf8ByteLength('0') - utf8ByteLength('{"presentation":0}');
export const cardActionResponseLimitBytes = internalCanonicalJsonResponseLimitBytes * 2 + cardActionEnvelopeBytes + 1;

export interface CardActionDelivery<Result = import("../../core/client.js").CanonicalJson> {
  readonly result: Result;
  readonly presentation: CardActionPresentation;
  readonly qr?: CardPresentationDelivery["qr"];
}
const cardActionDeliverySchema = z.object({
  result: z.unknown(), presentation: cardActionPresentationSchema, qr: walletOperationQrMetadataSchema.optional(),
}).strict();

export const admitCardActionDelivery = (input: unknown): CardActionDelivery => {
  const captured = cardActionDeliverySchema.parse(captureCanonicalJson(input));
  const result = captureCanonicalJson(captured.result);
  const { presentation, qr } = captured;
  const display = captureCanonicalJson({ presentation, ...(qr === undefined ? {} : { qr }) });
  if (utf8ByteLength(canonicalJsonStringify(result)) > internalCanonicalJsonResponseLimitBytes ||
      utf8ByteLength(canonicalJsonStringify(display)) > internalCanonicalJsonResponseLimitBytes) {
    throw new TypeError("Card action components exceed their admitted response bounds.");
  }
  if ("status" in presentation) {
    if (qr !== undefined) throw new TypeError("Unavailable card state cannot carry QR material.");
  } else {
    cardPresentationDeliverySchema.parse(display);
    if (presentation.state.record === null || presentation.state.record.kind === "read" || presentation.state.record.kind === "preparing" ||
        presentation.state.record.inputState !== "input_closed" || presentation.display.kind === "decision" || presentation.display.kind === "snapshot") {
      throw new TypeError("A direct action cannot restore decision input or a read card.");
    }
  }
  return { result, presentation, ...(qr === undefined ? {} : { qr }) };
};

export const serializeCardActionPresentation = (input: CardActionPresentation): string => {
  const text = canonicalJsonStringify(captureCanonicalJson(cardActionPresentationSchema.parse(input)));
  if (utf8ByteLength(text) > internalCanonicalJsonResponseLimitBytes) throw new TypeError("Card presentation exceeds its response bound.");
  return text;
};

export const admitCardActionPresentation = (input: unknown): CardActionPresentation => {
  if (typeof input !== "string") throw new TypeError("Card action presentation requires canonical JSON text.");
  if (utf8ByteLength(input) > internalCanonicalJsonResponseLimitBytes) throw new TypeError("Card presentation exceeds its response bound.");
  const value = captureCanonicalJson(JSON.parse(input));
  if (canonicalJsonStringify(value) !== input) throw new TypeError("Card action presentation text is not canonical.");
  return cardActionPresentationSchema.parse(value);
};

type CardControlContract<T> = ApplicationContract<T, Record<string, never>, CardPresentation> & { readonly capabilityId: CapabilityId };
const define = <T>(id: string, inputSchema: z.ZodType<T>, validate: (input: T, value: CardPresentation) => void): CardControlContract<T> => Object.freeze({ capabilityId: capabilityIdSchema.parse(id), ...defineApplicationContract({
  contractVersion: "1", inputSchema, successSchema: cardPresentationSchema, internalContextSchema: z.object({}).strict(),
  errorRegistry: cardErrorRegistry, failureCodes: cardErrorRegistry.values().map((value) => value.code), validatePublicSuccess: validate,
}) });
const sameCard = (input: { cardId: string }, value: CardPresentation) => {
  if (value.state.reference.kind !== "card" || value.state.reference.cardId !== input.cardId) throw new TypeError("Card control returned another card.");
};
export const cardControlContracts = Object.freeze({
  read: define("presentation.get_card", cardReadReferenceSchema, (input, value) => {
    const reference = value.state.reference;
    const record = value.state.record;
    if (record !== null && record.kind !== "read" &&
      (input.kind !== "card" || input.cardOpenRequestId === undefined) && value.actions.length !== 0) {
      throw new TypeError("A saved decision read cannot grant mutation controls.");
    }
    if (input.kind === "card") sameCard(input, value);
    else if (reference.kind === "snapshot" ? input.snapshotId !== reference.snapshotId
      : value.state.record === null || value.state.record.kind === "read" || value.state.record.kind === "preparing" || value.state.record.snapshotId !== input.snapshotId) {
      throw new TypeError("Card read returned another snapshot's state.");
    }
  }),
  open: define("presentation.start_view", cardOpeningSchema, sameCard),
  discard: define("presentation.cancel_decision", cardIdInputSchema, sameCard),
  stop: define("presentation.cancel_wait", cardIdInputSchema, sameCard),
});
export type CardReadStartContract = ApplicationContract<CardReadInput, Record<string, never>, CardCreationResult> & { readonly capabilityId: CapabilityId };
export const cardReadStartContract: CardReadStartContract = Object.freeze({ capabilityId: capabilityIdSchema.parse("presentation.start_read"), ...defineApplicationContract({
  contractVersion: "1", inputSchema: cardReadInputSchema, correlationInputSchema: normalizedReadInputSchema,
  successSchema: cardCreationResultSchema,
  internalContextSchema: z.object({}).strict(), errorRegistry: cardErrorRegistry,
  failureCodes: cardErrorRegistry.values().map((value) => value.code),
}) });
const decisionCreationSchemas = presentationDecisionKinds.map((kind) => {
  const entry = presentationContractRegistry.requireCardKind(kind);
  const source = kind === "wallet_selection"
    ? z.object({kind: z.literal("new"), input: entry.inputSchema}).strict()
    : z.discriminatedUnion("kind", [
      z.object({kind: z.literal("new"), input: entry.inputSchema}).strict(),
      z.object({kind: z.literal("existing"), operationId: operationIdSchema}).strict(),
    ]);
  return z.object({kind: z.literal(kind), source}).strict();
});
const [firstDecision, secondDecision, ...otherDecisions] = decisionCreationSchemas;
if (firstDecision === undefined || secondDecision === undefined) throw new TypeError("Decision-card registry is incomplete.");
export const cardDecisionStartInputSchema = z.discriminatedUnion("kind", [firstDecision, secondDecision, ...otherDecisions]);
const normalizedDecisionSchemas = presentationDecisionKinds.map((kind) => {
  const entry = presentationContractRegistry.requireCardKind(kind);
  const fresh = z.object({kind: z.literal("new"), input: z.unknown().transform((value) => entry.parseNormalizedInput(value))}).strict();
  return z.object({kind: z.literal(kind), source: kind === "wallet_selection" ? fresh : z.discriminatedUnion("kind", [fresh,
    z.object({kind: z.literal("existing"), operationId: operationIdSchema}).strict()])}).strict();
});
const [firstNormalizedDecision, secondNormalizedDecision, ...otherNormalizedDecisions] = normalizedDecisionSchemas;
if (firstNormalizedDecision === undefined || secondNormalizedDecision === undefined) throw new TypeError("Normalized decision-card registry is incomplete.");
const normalizedDecisionInputSchema = z.discriminatedUnion("kind", [firstNormalizedDecision, secondNormalizedDecision, ...otherNormalizedDecisions]);
export type CardDecisionStartInput = Readonly<{kind: PresentationDecisionKind; source:
  Readonly<{kind: "new"; input: unknown}> | Readonly<{kind: "existing"; operationId: string}>}>;
export type CardDecisionStartContract = ApplicationContract<CardDecisionStartInput, Record<string, never>, CardCreationResult> & {readonly capabilityId: CapabilityId};
export const cardDecisionStartContract: CardDecisionStartContract = Object.freeze({capabilityId: capabilityIdSchema.parse("presentation.start_decision"),
  ...defineApplicationContract({contractVersion: "1", inputSchema: cardDecisionStartInputSchema as z.ZodType<CardDecisionStartInput>,
    correlationInputSchema: normalizedDecisionInputSchema as z.ZodType<CardDecisionStartInput>,
    successSchema: cardCreationResultSchema, internalContextSchema: z.object({}).strict(),
    errorRegistry: cardErrorRegistry, failureCodes: cardErrorRegistry.values().map((value) => value.code)})});
export const cardActionEnvelopeSchema = z.object({ cardId: operationIdSchema, cardOpenRequestId: operationIdSchema, decision: z.unknown() }).strict();
