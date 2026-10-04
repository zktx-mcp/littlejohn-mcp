import { operationToolResultDescriptorSchema, presentationSnapshotIdSchema, presentationSnapshotDescriptorSchema, presentationSnapshotResourceSchema, walletOperationQrMetadataSchema, type PresentationSnapshotDescriptor } from "./contracts.js";
import { z } from "zod";
import {canonicalJsonStringify, captureCanonicalJson, deepFreezeValue, defineApplicationContract, capabilityIdSchema, type ApplicationContract, type CapabilityId, operationIdByteLength, operationIdSchema, utcTimestampSchema, utf8ByteLength, unsignedDecimalSchema} from "../../core/client.js";
import {evmAccountIdentitySchema} from "../../evm/identities.js";
import {erc20AssetIdentitySchema} from "../../evm/amounts.js";
import {productChainId} from "../../registry/product-identity.js";
import { exchangeWalletOutcomeSchema } from "../../review/response-contract.js";
import { signingOutcomeSchema, signingMethodSchema } from "../../review/signing-contracts.js";
import { signingErrorRegistry } from "../../review/signing-errors.js";
import { exchangeErrorRegistry } from "../../review/errors.js";
import { tokenCatalogApplicationContracts, tokenCatalogErrorDefinitions } from "../../token-catalog/client.js";
import { presentationDecisionKinds, presentationContractRegistry, type PresentationDecisionKind } from "./registry.js";
import { deliveryUnknownSchema } from "../operation-delivery.js";
import { stockTokenTradeHistoryInputSchema } from "../../stock-token-trade-history/period-contract.js";
import { stockTokenTradeHistoryCapability, stockTokenTradeHistoryFailureCodes } from "../../stock-token-trade-history/contracts.js";
import { getCapabilityDefinitionSnapshot } from "../../core/client.js";
import { walletOperationStates, walletOperationKinds, walletInitiators, isWalletOperationTerminalState } from "../../wallet/operation-state.js";
import { walletPeerRefusalCodeSchema } from "../../wallet/operation-contract.js";
import { tokenSelectionRevisionSchema } from "../../token-catalog/client.js";
import type { PresentationSnapshotStore } from "../../runtime/presentation-snapshot.js";
import { internalCanonicalJsonResponseLimitBytes } from "../../runtime/http-limits.js";

export const cardErrorDefinitions = Object.freeze([
  { code: "presentation_not_found", category: "domain", message: "This exact card is not retained.", retryable: false },
  { code: "presentation_capacity_exceeded", category: "domain", message: "Card storage capacity is exhausted.", retryable: false },
  { code: "presentation_inconsistent", category: "domain", message: "Card identity or state is inconsistent.", retryable: false },
] as const);
export const cardRegistryErrorDefinitions = Object.freeze([...tokenCatalogErrorDefinitions, ...cardErrorDefinitions]);
export const cardErrorRegistry = exchangeErrorRegistry.extend(cardRegistryErrorDefinitions);

export const cardPhases = Object.freeze(["ready", "dispatching", "pending", "closed"] as const);
export const cardKinds = Object.freeze([...presentationDecisionKinds, "read"] as const);
export const cardReadInputSchema = z.object({
  capabilityId: z.literal(getCapabilityDefinitionSnapshot(stockTokenTradeHistoryCapability).capabilityId),
  input: stockTokenTradeHistoryInputSchema,
}).strict();
export type CardReadInput = z.infer<typeof cardReadInputSchema>;
const digest = operationToolResultDescriptorSchema.shape.resultSha256;
const snapshotId = presentationSnapshotIdSchema;
const failureCodes = [...new Set([
  ...signingErrorRegistry.values().map((entry) => entry.code),
  ...cardErrorRegistry.values().map((entry) => entry.code),
  ...Object.values(tokenCatalogApplicationContracts).flatMap((contract) => contract.failureCodes),
  ...stockTokenTradeHistoryFailureCodes,
])];
const signingStatus = z.union(signingOutcomeSchema.options.map((entry) => entry.shape.status));

export const cardOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("decision"), reason: z.enum(["discarded", "returned", "expired", "source_unavailable", "owner_lost"]) }).strict(),
  z.object({ kind: z.literal("signing"), status: signingStatus }).strict(),
  z.object({ kind: z.literal("transaction"), result: exchangeWalletOutcomeSchema }).strict(),
  z.object({ kind: z.literal("review"), state: z.enum(["blocked", "refresh_required"]), failureCode: z.enum(failureCodes) }).strict(),
  z.object({ kind: z.literal("failure"), failureCode: z.enum(failureCodes) }).strict(),
  z.object({ kind: z.literal("operation") }).strict(),
  z.object({ kind: z.literal("delivery"), result: deliveryUnknownSchema }).strict(),
  z.object({ kind: z.literal("snapshot"), snapshotId }).strict(),
]);
export type CardOutcome = z.infer<typeof cardOutcomeSchema>;

const decisionRecordShape = {
  cardId: operationIdSchema,
  contractVersion: z.literal("1"),
  operationId: operationIdSchema,
  resultDigest: digest,
  snapshotId: snapshotId.nullable(),
  firstCardOpenRequestId: operationIdSchema.nullable(),
  expiresAt: utcTimestampSchema.nullable(),
  phase: z.enum(cardPhases),
  outcome: cardOutcomeSchema.nullable(),
};
const decisionRecordSchema = z.discriminatedUnion("kind", [
  z.object({ ...decisionRecordShape, kind: z.literal("wallet") }).strict(),
  z.object({ ...decisionRecordShape, kind: z.literal("token_selection") }).strict(),
  z.object({ ...decisionRecordShape, kind: z.literal("signing"), context: z.object({ account: evmAccountIdentitySchema, method: signingMethodSchema }).strict() }).strict(),
  z.object({ ...decisionRecordShape, kind: z.literal("transaction"), context: z.object({ account: evmAccountIdentitySchema.nullable() }).strict() }).strict(),
]).superRefine((value, context) => {
  const durable = value.kind === "wallet" || value.kind === "token_selection";
  if ((value.phase === "closed") !== (value.outcome !== null) ||
      (value.snapshotId !== null) !== durable ||
      (value.phase !== "closed" && value.expiresAt === null) ||
      (value.outcome?.kind === "operation" && !durable) ||
      (value.outcome?.kind === "delivery" && (!durable || value.outcome.result.operationId !== value.operationId || value.outcome.result.action !== "decide")) ||
      (value.outcome?.kind === "signing" && value.kind !== "signing") ||
      value.outcome?.kind === "snapshot" ||
      ((value.outcome?.kind === "transaction" || value.outcome?.kind === "review") && value.kind !== "transaction")) {
    context.addIssue({ code: "custom", message: "Card state differs from its source or phase." });
  }
});
export type DecisionCardRecord = z.infer<typeof decisionRecordSchema>;
export const readCardRecordSchema = z.object({
  cardId: operationIdSchema, kind: z.literal("read"), contractVersion: z.literal("1"),
  request: cardReadInputSchema,
  phase: z.enum(["pending", "closed"]),
  outcome: z.union([
    z.object({ kind: z.literal("snapshot"), snapshotId }).strict(),
    z.object({ kind: z.literal("failure"), failureCode: z.enum(failureCodes) }).strict(),
  ]).nullable(),
}).strict().refine((value) => (value.phase === "closed") === (value.outcome !== null));
export type ReadCardRecord = z.infer<typeof readCardRecordSchema>;
export const cardRecordSchema = z.union([decisionRecordSchema, readCardRecordSchema]);
export type CardRecord = z.infer<typeof cardRecordSchema>;

export const isCardPhaseTransition = (before: CardRecord["phase"], after: CardRecord["phase"]): boolean => {
  if (before === after) return true;
  if (after === "closed") return true;
  if (before === "ready") return after === "dispatching" || after === "pending";
  return before === "dispatching" && after === "pending";
};

// Closed JSON field widths, including the largest complete outcome branch.
// IDs use Core's 32-byte base64url encoding; digests and UTC use their owning encodings.
const idWidth = Math.ceil(operationIdByteLength * 4 / 3);
const longest = (values: readonly string[]) => values.reduce((a, b) => a.length >= b.length ? a : b);
const outcomeEnvelopes = [
  { kind: "decision", reason: "source_unavailable" },
  { kind: "signing", status: "unsupported_signature" },
  { kind: "transaction", result: { status: "hash_returned", transactionHash: `0x${"0".repeat(64)}`, recording: "recorded", lookup: "not_started" } },
  { kind: "review", state: "refresh_required", failureCode: longest(failureCodes) },
  { kind: "failure", failureCode: longest(failureCodes) },
  { kind: "operation" },
  { kind: "delivery", result: { status: "delivery_unknown", action: "decide", operationId: "0".repeat(idWidth), resendAllowed: false } },
];
const outcomeBytes = Math.max(...outcomeEnvelopes.map((value) => utf8ByteLength(JSON.stringify(value))));
const baseEnvelope = {
  cardId: "0".repeat(idWidth), kind: longest(presentationDecisionKinds), contractVersion: "1",
  operationId: "0".repeat(idWidth), resultDigest: "0".repeat(64), snapshotId: `sha256:${"0".repeat(64)}`,
  firstCardOpenRequestId: "0".repeat(idWidth),
  expiresAt: "2099-12-31T23:59:59.999Z", phase: longest(cardPhases), outcome: null,
};
// An EVM address is 20 bytes; its canonical text has a 0x prefix and 40 hex digits.
const accountEnvelope = { chainId: productChainId, address: `0x${"0".repeat(40)}` };
const decisionContextBytes = utf8ByteLength(JSON.stringify({ context: {
  account: accountEnvelope, method: longest(signingMethodSchema.options),
} })) - 2;
const readEnvelope = {
  cardId: "0".repeat(idWidth), kind: "read", contractVersion: "1",
  request: { capabilityId: getCapabilityDefinitionSnapshot(stockTokenTradeHistoryCapability).capabilityId,
    input: { symbol: "A".repeat(32), period: { count: 365, unit: "month" } } },
  phase: "pending", outcome: { kind: "failure", failureCode: longest(failureCodes) },
};
const recordBytes = Math.max(
  utf8ByteLength(JSON.stringify(baseEnvelope)) - "null".length + outcomeBytes + 1 + decisionContextBytes,
  utf8ByteLength(JSON.stringify(readEnvelope)),
);
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
        : record.expiresAt === null ? source.kind !== "response_memory"
          : source.kind !== "review_memory" || source.operationId !== record.operationId || source.expiresAt !== record.expiresAt)) {
    throw new TypeError("Presentation source differs from its saved card.");
  }
};

export const cardReferenceContract = defineApplicationContract({
  contractVersion: "1",
  inputSchema: z.object({ operationId: operationIdSchema, descriptor: presentationSnapshotDescriptorSchema }).strict(),
  successSchema: cardReferenceSchema.options[0], internalContextSchema: z.object({}).strict(),
  errorRegistry: cardErrorRegistry, failureCodes: cardErrorRegistry.values().map((value) => value.code),
});
export type CardReferenceReader = (input: ReturnType<typeof cardReferenceContract.parseInput>, signal?: AbortSignal) => Promise<ReturnType<typeof cardReferenceContract.parsePublicSuccess>>;

export const cardStateSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("static"), reference: cardReferenceSchema,
    record: cardRecordSchema.nullable(),
  }).strict().refine((value) => value.reference.kind === "snapshot" ? value.record === null : value.record !== null && value.record.phase !== "ready"),
  z.object({
    mode: z.literal("interactive"), reference: z.object({ kind: z.literal("card"), cardId: operationIdSchema }).strict(),
    record: cardRecordSchema,
  }).strict().refine((value) => value.record.phase === "ready"),
]).superRefine((value, context) => {
  if (value.reference.kind === "card" && value.reference.cardId !== value.record?.cardId) {
    context.addIssue({ code: "custom", message: "Card reference and state differ." });
  }
});
export type CardState = z.infer<typeof cardStateSchema>;
export const cardState = (record: CardRecord): CardState => deepFreezeValue(cardStateSchema.parse({
  mode: record.phase === "ready" ? "interactive" : "static", reference: { kind: "card", cardId: record.cardId }, record,
}));

export interface PresentationCardStore {
  unsettled(): readonly CardRecord[];
  read(cardId: string): CardRecord | null;
  find(kind: PresentationDecisionKind, operationId: string): CardRecord | null;
  insert(record: CardRecord): CardRecord;
  replace(expected: CardRecord, next: CardRecord): CardRecord;
  completeRead(expected: ReadCardRecord, snapshot: Parameters<PresentationSnapshotStore["commit"]>[0]): ReadCardRecord;
}

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
    z.object({ kind: z.literal("review"), resource: presentationSnapshotResourceSchema }).strict(),
    z.object({ kind: z.literal("snapshot"), resource: presentationSnapshotResourceSchema }).strict(),
    z.object({ kind: z.literal("operation"), value: cardOperationProjectionSchema }).strict(),
  ]),
  actions: z.array(z.enum(["confirm", "discard", "stop"])).max(2),
}).strict().superRefine((value, context) => {
  const record = value.state.record;
  if (new Set(value.actions).size !== value.actions.length ||
      ((value.actions.includes("confirm") || value.actions.includes("discard")) && record?.phase !== "ready") ||
      (value.actions.includes("stop") && (record === null || record.phase === "ready" || record.phase === "closed")) ||
      (value.display.kind === "review" && (record === null || record.kind === "read" || record.phase !== "ready" ||
        value.display.resource.descriptor.resultSha256 !== record.resultDigest)) ||
      (value.display.kind === "operation" && (record === null || record.kind === "read" ||
        value.display.value.operationId !== record.operationId || value.display.value.kind !== record.kind))) {
    context.addIssue({ code: "custom", message: "Card presentation differs from saved state." });
  }
  if (value.display.kind === "review" && record !== null && record.kind !== "read") {
    try { assertCardPresentationSource(record, value.display.resource.descriptor); }
    catch {
      context.addIssue({ code: "custom", message: "Review resource differs from its saved source." });
    }
  }
  if (value.actions.includes("confirm") && (value.display.kind !== "review" || record === null || record.kind === "read" || record.firstCardOpenRequestId === null)) {
    context.addIssue({ code: "custom", message: "An admitted opening and Review are required for a decision." });
  }
  if (value.display.kind === "snapshot") {
    const expected = value.state.reference.kind === "snapshot" ? value.state.reference.snapshotId
      : record?.kind === "read" && record.outcome?.kind === "snapshot" ? record.outcome.snapshotId : undefined;
    if (expected !== value.display.resource.descriptor.snapshotId ||
        (record?.kind === "read" && (value.display.resource.descriptor.contractId !== record.request.capabilityId ||
          canonicalJsonStringify(captureCanonicalJson(value.display.resource.normalizedInput)) !== canonicalJsonStringify(captureCanonicalJson(record.request.input))))) {
      context.addIssue({ code: "custom", message: "Completed data differs from its saved read." });
    }
  }
  if (value.display.kind === "operation" && record !== null) {
    const terminal = value.display.value.kind === "token_selection" || isWalletOperationTerminalState(value.display.value.state);
    if ((record.phase === "closed") !== terminal || (record.phase === "closed" && record.outcome?.kind !== "operation")) {
      context.addIssue({ code: "custom", message: "Operation projection and card completion differ." });
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
    if (presentation.state.record === null || presentation.state.record.kind === "read" ||
        presentation.state.record.phase === "ready" || presentation.display.kind === "review" || presentation.display.kind === "snapshot") {
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
      : value.state.record === null || value.state.record.kind === "read" || value.state.record.snapshotId !== input.snapshotId) {
      throw new TypeError("Card read returned another snapshot's state.");
    }
  }),
  open: define("presentation.start_view", cardOpeningSchema, sameCard),
  discard: define("presentation.cancel_decision", cardIdInputSchema, sameCard),
  stop: define("presentation.cancel_wait", cardIdInputSchema, sameCard),
});
export interface CardReadAcknowledgement { readonly reference: { readonly kind: "card"; readonly cardId: string } }
export type CardReadStartContract = ApplicationContract<CardReadInput, Record<string, never>, CardReadAcknowledgement> & { readonly capabilityId: CapabilityId };
export const cardReadStartContract: CardReadStartContract = Object.freeze({ capabilityId: capabilityIdSchema.parse("presentation.start_read"), ...defineApplicationContract({
  contractVersion: "1", inputSchema: cardReadInputSchema,
  successSchema: z.object({ reference: z.object({ kind: z.literal("card"), cardId: operationIdSchema }).strict() }).strict(),
  internalContextSchema: z.object({}).strict(), errorRegistry: cardErrorRegistry,
  failureCodes: cardErrorRegistry.values().map((value) => value.code),
}) });
export const cardActionEnvelopeSchema = z.object({ cardId: operationIdSchema, cardOpenRequestId: operationIdSchema, decision: z.unknown() }).strict();

export interface CardReviewResult {
  readonly value: import("../../core/client.js").CanonicalJson;
  readonly reference: Extract<CardReference, { kind: "card" }> | null;
}

const cardReviewResultSchema = z.object({
  value: z.unknown(),
  reference: z.object({ kind: z.literal("card"), cardId: operationIdSchema }).strict().nullable(),
}).strict();

export const admitCardReviewResult = (input: unknown): CardReviewResult => {
  const result = cardReviewResultSchema.parse(captureCanonicalJson(input));
  return deepFreezeValue({ value: captureCanonicalJson(result.value), reference: result.reference });
};
