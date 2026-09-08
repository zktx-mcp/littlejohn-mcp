import { z } from "zod";
import { walletSessionRequirementsSchema } from "./session-requirements.js";
import { isWalletOperationCancellableState, walletCancellableOperationStates } from "./operation-state.js";

import {
  canonicalJsonStringify,
  canonicalSha256,
  captureCanonicalJson,
  closedTupleSchema,
  deepFreezeValue,
  evmChainIdSchema,
  hash32Schema,
  internalErrorDefinition,
  operationIdByteLength,
  operationIdSchema,
  parseHash32,
  snakeCaseCodeSchema,
  unsignedDecimalSchema,
  utcTimestampSchema,
  utf8ByteLength,
  walletConnectionDataSchema,
  type ApplicationFailure,
  type CanonicalJson,
  type WalletConnectionData,
} from "../core/client.js";
import {
  runtimeStateUnavailableErrorDefinition,
  stateConflictErrorDefinition,
} from "../runtime/error-definitions.js";
import {
  walletConnectUnavailableErrorDefinition,
  walletPairingCodeUnavailableErrorDefinition,
  walletSessionUnusableErrorDefinition,
  walletTimeoutErrorDefinition,
  walletUserRejectedErrorDefinition,
} from "./error-definitions.js";
import {
  isWalletOperationTerminalState,
  walletInitiators,
  walletOperationKinds,
  walletOperationStateDefinitions,
  walletOperationStatesForKind,
  type WalletInitiator,
  type WalletNonterminalOperationState,
  type WalletOperationKind,
  type WalletOperationStateForKind,
} from "./operation-state.js";

export const walletOperationIdByteLength = operationIdByteLength;
export const walletOperationIdSchema = operationIdSchema;
export const walletReviewActionLifetimeMilliseconds = 300_000;
export const walletOperationInputLimits = Object.freeze({
  actionUtf8Bytes: 16_384,
} as const);

export const walletPeerRefusalCodes = Object.freeze([
  5000, 5001, 5002, 5003,
  5100, 5101, 5102, 5103, 5104,
  6000, 7000, 10001,
] as const);
export type WalletPeerRefusalCode = typeof walletPeerRefusalCodes[number];
const walletPeerRefusalLiteralSchemas = walletPeerRefusalCodes.map((code) =>
  z.literal(code)) as unknown as readonly [
    z.ZodLiteral<WalletPeerRefusalCode>,
    z.ZodLiteral<WalletPeerRefusalCode>,
    ...z.ZodLiteral<WalletPeerRefusalCode>[],
  ];
export const walletPeerRefusalCodeSchema: z.ZodType<WalletPeerRefusalCode> =
  z.union(walletPeerRefusalLiteralSchemas);
export const walletInitiatorSchema = z.enum(walletInitiators);

type WalletConnectionForStatus<Status extends WalletConnectionData["status"]> =
  Extract<WalletConnectionData, { readonly status: Status }>;

const canonicalWalletConnectionSchema = <Status extends WalletConnectionData["status"]>(
  status: Status,
) => walletConnectionDataSchema.refine(
  (connection): connection is WalletConnectionForStatus<Status> => connection.status === status,
  "Wallet connection status does not match the required state.",
);

const walletSessionSourceIdSchema = z.string()
  .regex(/^wallet-session:[A-Za-z0-9_-]{43}$/u);

const walletReviewCommonShape = {
  contractVersion: z.literal("1"),
  domain: z.literal("wallet"),
  operationId: walletOperationIdSchema,
  createdAt: utcTimestampSchema,
  actionExpiresAt: utcTimestampSchema,
  target: z.object({ chainId: evmChainIdSchema }).strict(),
} as const;

const connectReviewWithoutDigestSchema = z.object({
  ...walletReviewCommonShape,
  kind: z.literal("connect"),
  decision: walletSessionRequirementsSchema,
  precondition: z.object({
    connectionRevision: unsignedDecimalSchema,
    connection: canonicalWalletConnectionSchema("disconnected"),
  }).strict(),
  fixedEvidence: z.object({
    sessionSourceIds: z.array(z.never()).max(0),
  }).strict(),
}).strict();

const disconnectReviewWithoutDigestSchema = z.object({
  ...walletReviewCommonShape,
  kind: z.literal("disconnect"),
  decision: z.object({ action: z.literal("disconnect_session") }).strict(),
  precondition: z.object({
    connectionRevision: unsignedDecimalSchema,
    connection: canonicalWalletConnectionSchema("connected"),
  }).strict(),
  fixedEvidence: z.object({
    sessionSourceIds: closedTupleSchema([walletSessionSourceIdSchema]),
  }).strict(),
}).strict();

const walletReviewWithoutDigestSchema = z.discriminatedUnion("kind", [
  connectReviewWithoutDigestSchema,
  disconnectReviewWithoutDigestSchema,
]);

export type WalletReviewWithoutDigest = z.infer<typeof walletReviewWithoutDigestSchema>;

export const walletReviewDigest = (inputValue: unknown) => {
  const input = walletReviewWithoutDigestSchema.parse(captureCanonicalJson(inputValue));
  return parseHash32(`0x${canonicalSha256({
    digestKind: "wallet_connection_change_review",
    digestVersion: "1",
    review: input as unknown as CanonicalJson,
  })}`);
};

const validateWalletReview = (
  review: WalletReviewWithoutDigest & { readonly reviewDigest: string },
  context: z.core.$RefinementCtx,
): void => {
  const chainMismatch = review.precondition.connection.status === "connected" &&
    review.target.chainId !== review.precondition.connection.chainId;
  if (
    Date.parse(review.actionExpiresAt) - Date.parse(review.createdAt) !==
      walletReviewActionLifetimeMilliseconds ||
    chainMismatch ||
    review.reviewDigest !== walletReviewDigest((({ reviewDigest: _digest, ...rest }) => rest)(review))
  ) {
    context.addIssue({ code: "custom", message: "Wallet Review is inconsistent." });
  }
};

const connectReviewSchema = connectReviewWithoutDigestSchema.extend({
  reviewDigest: hash32Schema,
}).strict().superRefine(validateWalletReview);
const disconnectReviewSchema = disconnectReviewWithoutDigestSchema.extend({
  reviewDigest: hash32Schema,
}).strict().superRefine(validateWalletReview);

export const walletReviewSchema = z.discriminatedUnion("kind", [
  connectReviewSchema,
  disconnectReviewSchema,
]);
export type WalletReview = z.infer<typeof walletReviewSchema>;

export const walletReviewRequestSchema = z.object({
  kind: z.enum(walletOperationKinds),
}).strict();
export type WalletReviewRequest = z.infer<typeof walletReviewRequestSchema>;

export const walletReviewResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("review"), review: walletReviewSchema }).strict(),
  z.object({
    status: z.literal("current_connection"),
    connectionRevision: unsignedDecimalSchema,
    connection: canonicalWalletConnectionSchema("connected"),
  }).strict(),
  z.object({
    status: z.literal("already_disconnected"),
    connectionRevision: unsignedDecimalSchema,
    connection: canonicalWalletConnectionSchema("disconnected"),
  }).strict(),
]);
export type WalletReviewResult = z.infer<typeof walletReviewResultSchema>;

const validateWalletOperationActionBytes = (
  value: unknown,
  context: z.core.$RefinementCtx,
): void => {
  const bytes = utf8ByteLength(canonicalJsonStringify(value as CanonicalJson));
  if (bytes > walletOperationInputLimits.actionUtf8Bytes) {
    context.addIssue({
      code: "custom",
      message: "Wallet operation action exceeds its canonical byte limit.",
    });
  }
};

export const walletDirectActionSchema = z.object({
  review: walletReviewSchema,
  initiatedBy: walletInitiatorSchema,
}).strict().superRefine(validateWalletOperationActionBytes);
export type WalletDirectAction = z.infer<typeof walletDirectActionSchema>;

const walletOperationFailureDefinitions = Object.freeze([
  internalErrorDefinition,
  runtimeStateUnavailableErrorDefinition,
  stateConflictErrorDefinition,
  walletPairingCodeUnavailableErrorDefinition,
  walletSessionUnusableErrorDefinition,
  walletTimeoutErrorDefinition,
  walletConnectUnavailableErrorDefinition,
] as const);

const distinctDefinitionCategories = <
  const Definitions extends readonly [
    Readonly<{ category: ApplicationFailure["error"]["category"] }>,
    ...Readonly<{ category: ApplicationFailure["error"]["category"] }>[],
  ],
>(definitions: Definitions): readonly [
  Definitions[number]["category"],
  ...Definitions[number]["category"][],
] => {
  const categories = [...new Set(definitions.map((definition) => definition.category))];
  if (categories.length === 0) throw new TypeError("Application error definitions are empty.");
  return Object.freeze(categories) as readonly [
    Definitions[number]["category"],
    ...Definitions[number]["category"][],
  ];
};

const definitionCodes = <const Definitions extends readonly { readonly code: string }[]>(
  definitions: Definitions,
): { readonly [Index in keyof Definitions]: Definitions[Index]["code"] } =>
  Object.freeze(definitions.map((definition) => definition.code)) as {
    readonly [Index in keyof Definitions]: Definitions[Index]["code"];
  };

export const walletOperationFailureCodes = definitionCodes(walletOperationFailureDefinitions);
export type WalletOperationFailureCode = typeof walletOperationFailureCodes[number];
const walletOperationFailureCodeSet = new Set<string>(walletOperationFailureCodes);
export const isWalletOperationFailureCode = (value: unknown): value is WalletOperationFailureCode =>
  typeof value === "string" && walletOperationFailureCodeSet.has(value);

const operationFailureDefinitionByCode = new Map(
  walletOperationFailureDefinitions.map((definition) => [definition.code, definition] as const),
);
const walletOperationFailureCategories = distinctDefinitionCategories(walletOperationFailureDefinitions);

const operationFailureErrorSchema = z.object({
  code: z.enum(walletOperationFailureCodes).and(snakeCaseCodeSchema),
  category: z.enum(walletOperationFailureCategories),
  message: z.string(),
  retryable: z.boolean(),
  issues: z.array(z.unknown()).length(0) as z.ZodType<ApplicationFailure["error"]["issues"]>,
}).strict().superRefine((error, context) => {
  const definition = operationFailureDefinitionByCode.get(error.code);
  if (
    definition === undefined || error.category !== definition.category ||
    error.message !== definition.message || error.retryable !== definition.retryable
  ) context.addIssue({ code: "custom", message: "Application failure does not match its authority." });
});

const walletOperationFailureSchema: z.ZodType<WalletOperationFailure> = z.object({
  ok: z.literal(false),
  error: operationFailureErrorSchema,
}).strict();

export type WalletOperationFailure = ApplicationFailure & {
  readonly error: ApplicationFailure["error"] & { readonly code: WalletOperationFailureCode };
};

export const walletOperationOutcomes = Object.freeze({
  connect: Object.freeze(["connected"] as const),
  disconnect: Object.freeze(["disconnected"] as const),
});

const connectOperationResultSchema = z.object({
  outcome: z.literal("connected"),
  connectionRevision: unsignedDecimalSchema,
  connection: canonicalWalletConnectionSchema("connected"),
}).strict();
const disconnectOperationResultSchema = z.object({
  outcome: z.enum(walletOperationOutcomes.disconnect),
  connectionRevision: unsignedDecimalSchema,
  connection: canonicalWalletConnectionSchema("disconnected"),
}).strict();
export type WalletOperationResult =
  | z.infer<typeof connectOperationResultSchema>
  | z.infer<typeof disconnectOperationResultSchema>;

type WalletReviewForKind<Kind extends WalletOperationKind> = Extract<WalletReview, { kind: Kind }>;
type WalletOperationResultForKind<Kind extends WalletOperationKind> =
  Kind extends "connect"
    ? z.infer<typeof connectOperationResultSchema>
    : z.infer<typeof disconnectOperationResultSchema>;

export type WalletManagementOperationForKind<Kind extends WalletOperationKind> = {
  [State in WalletOperationStateForKind<Kind>]: Readonly<{
    contractVersion: "1";
    domain: "wallet";
    operationId: z.infer<typeof walletOperationIdSchema>;
    kind: Kind;
    initiatedBy: WalletInitiator;
    review: WalletReviewForKind<Kind>;
    state: State;
    terminationTarget: State extends "cancelling" ? "cancelled" | "expired" : null;
    result: State extends "completed" ? WalletOperationResultForKind<Kind> : null;
    failure: State extends "failed" ? WalletOperationFailure : null;
    peerRefusalCode: State extends "rejected" ? WalletPeerRefusalCode : null;
  }>;
}[WalletOperationStateForKind<Kind>];

export type WalletManagementOperation = {
  [Kind in WalletOperationKind]: WalletManagementOperationForKind<Kind>;
}[WalletOperationKind];
export type WalletNonterminalManagementOperation = Extract<
  WalletManagementOperation,
  { readonly state: WalletNonterminalOperationState }
>;

const operationResultSchema = (kind: WalletOperationKind) =>
  kind === "connect" ? connectOperationResultSchema : disconnectOperationResultSchema;

const operationVariantSchema = <
  Kind extends WalletOperationKind,
  State extends WalletOperationStateForKind<Kind>,
>(kind: Kind, state: State) => z.object({
  contractVersion: z.literal("1"),
  domain: z.literal("wallet"),
  operationId: walletOperationIdSchema,
  kind: z.literal(kind),
  initiatedBy: walletInitiatorSchema,
  review: kind === "connect" ? connectReviewSchema : disconnectReviewSchema,
  state: z.literal(state),
  terminationTarget: state === "cancelling"
    ? z.enum(["cancelled", "expired"] as const)
    : z.null(),
  result: state === "completed" ? operationResultSchema(kind) : z.null(),
  failure: state === "failed" ? walletOperationFailureSchema : z.null(),
  peerRefusalCode: state === "rejected" ? walletPeerRefusalCodeSchema : z.null(),
}).strict().superRefine((operation, context) => {
  if (operation.state !== "completed" || operation.result === null) return;
  if (
    BigInt(operation.result.connectionRevision) <=
      BigInt(operation.review.precondition.connectionRevision) ||
    (operation.kind === "connect" &&
      operation.result.connection.status === "connected" &&
      operation.result.connection.chainId !== operation.review.target.chainId)
  ) context.addIssue({ code: "custom", message: "Wallet operation result is inconsistent." });
});

const operationUnion = (schemas: readonly z.ZodType[]): z.ZodType => {
  if (schemas.length < 2) throw new TypeError("Wallet operation variants are incomplete.");
  return z.union(schemas as [z.ZodType, z.ZodType, ...z.ZodType[]]);
};

const connectOperationSchemas = walletOperationStatesForKind("connect")
  .map((state) => operationVariantSchema("connect", state));
const disconnectOperationSchemas = walletOperationStatesForKind("disconnect")
  .map((state) => operationVariantSchema("disconnect", state));
const nonterminalOperationSchemas = [
  ...walletOperationStatesForKind("connect")
    .filter((state) => !isWalletOperationTerminalState(state))
    .map((state) => operationVariantSchema("connect", state)),
  ...walletOperationStatesForKind("disconnect")
    .filter((state) => !isWalletOperationTerminalState(state))
    .map((state) => operationVariantSchema("disconnect", state)),
];

export const walletManagementOperationSchema = operationUnion([
  ...connectOperationSchemas,
  ...disconnectOperationSchemas,
]) as z.ZodType<WalletManagementOperation>;
export const walletNonterminalManagementOperationSchema = operationUnion(
  nonterminalOperationSchemas,
) as z.ZodType<WalletNonterminalManagementOperation>;

export const walletOperationInputSchema = z.object({
  operationId: walletOperationIdSchema,
}).strict();
export type WalletOperationInput = z.infer<typeof walletOperationInputSchema>;

export const walletOperationCancellationSchema = z.object({
  operationId: walletOperationIdSchema,
  reviewDigest: hash32Schema,
  expectedState: z.enum(walletCancellableOperationStates),
  connectionRevision: unsignedDecimalSchema,
}).strict().superRefine(validateWalletOperationActionBytes);
export type WalletOperationCancellation = z.infer<typeof walletOperationCancellationSchema>;

export const walletQrMatrixSizeLimits = Object.freeze({ minimum: 21, maximum: 177 } as const);
export const walletQrMatrixSchema = z.object({
  size: z.number().int().min(walletQrMatrixSizeLimits.minimum).max(walletQrMatrixSizeLimits.maximum),
  rows: z.array(z.string().regex(/^[01]+$/u))
    .min(walletQrMatrixSizeLimits.minimum).max(walletQrMatrixSizeLimits.maximum),
}).strict().superRefine((matrix, context) => {
  if (matrix.rows.length !== matrix.size) {
    context.addIssue({ code: "custom", path: ["rows"], message: "QR row count must match its size." });
  }
  matrix.rows.forEach((row, index) => {
    if (row.length !== matrix.size) {
      context.addIssue({ code: "custom", path: ["rows", index], message: "QR row width must match its size." });
    }
  });
});
export type WalletQrMatrix = z.infer<typeof walletQrMatrixSchema>;

export const walletOperationAllowsQr = (operation: WalletManagementOperation): boolean =>
  operation.kind === "connect" && operation.state === "awaiting_wallet_approval";

export const walletOperationPresentationSchema = z.object({
  operation: walletManagementOperationSchema,
  qr: walletQrMatrixSchema.optional(),
}).strict().superRefine((presentation, context) => {
  if (presentation.qr !== undefined && !walletOperationAllowsQr(presentation.operation)) {
    context.addIssue({ code: "custom", path: ["qr"], message: "QR is not active for this operation." });
  }
});
export type WalletOperationPresentation = z.infer<typeof walletOperationPresentationSchema>;

export const parseWalletReview = (input: unknown): WalletReview =>
  deepFreezeValue(walletReviewSchema.parse(captureCanonicalJson(input)));
export const parseWalletReviewResult = (input: unknown): WalletReviewResult =>
  deepFreezeValue(walletReviewResultSchema.parse(captureCanonicalJson(input)));
export const parseWalletDirectAction = (input: unknown): WalletDirectAction =>
  deepFreezeValue(walletDirectActionSchema.parse(captureCanonicalJson(input)));
export const parseWalletOperationId = (input: unknown): string => walletOperationIdSchema.parse(input);
export const parseWalletManagementOperation = (input: unknown): WalletManagementOperation =>
  deepFreezeValue(walletManagementOperationSchema.parse(captureCanonicalJson(input)));
export const parseWalletOperationCancellation = (input: unknown): WalletOperationCancellation =>
  deepFreezeValue(walletOperationCancellationSchema.parse(captureCanonicalJson(input)));

export const createWalletOperationCancellation = (
  input: WalletManagementOperation,
): WalletOperationCancellation => {
  const operation = parseWalletManagementOperation(input);
  if (!isWalletOperationCancellableState(operation.state)) {
    throw new TypeError("Wallet operation is not cancellable.");
  }
  return parseWalletOperationCancellation({
    operationId: operation.operationId,
    reviewDigest: operation.review.reviewDigest,
    expectedState: operation.state,
    connectionRevision: operation.review.precondition.connectionRevision,
  });
};
export const parseWalletQrMatrix = (input: unknown): WalletQrMatrix =>
  deepFreezeValue(walletQrMatrixSchema.parse(captureCanonicalJson(input)));
export const parseWalletOperationPresentation = (input: unknown): WalletOperationPresentation =>
  deepFreezeValue(walletOperationPresentationSchema.parse(captureCanonicalJson(input)));

export const operationFailure = (failure: unknown): WalletOperationFailure =>
  deepFreezeValue(walletOperationFailureSchema.parse(captureCanonicalJson(failure as CanonicalJson)));

export const walletOperationIsTerminal = (operation: WalletManagementOperation): boolean =>
  isWalletOperationTerminalState(operation.state);

const walletTransitionTargets = Object.freeze({
  starting_connection: Object.freeze(["awaiting_wallet_approval", "cancelling", "completed", "expired", "failed"] as const),
  awaiting_wallet_approval: Object.freeze(["validating_session", "cancelling", "completed", "rejected", "expired", "failed"] as const),
  validating_session: Object.freeze(["cancelling", "completed", "expired", "failed"] as const),
  cancelling: Object.freeze(["completed", "cancelled", "expired", "failed"] as const),
  disconnecting: Object.freeze(["completed", "failed"] as const),
} satisfies Readonly<Record<WalletNonterminalOperationState, readonly string[]>>);

export const assertWalletOperationTransition = (
  previous: WalletNonterminalManagementOperation,
  nextInput: WalletManagementOperation,
): WalletManagementOperation => {
  const next = parseWalletManagementOperation(nextInput);
  if (
    previous.operationId !== next.operationId || previous.kind !== next.kind ||
    previous.initiatedBy !== next.initiatedBy ||
    previous.review.reviewDigest !== next.review.reviewDigest ||
    canonicalJsonStringify(previous.review as unknown as CanonicalJson) !==
      canonicalJsonStringify(next.review as unknown as CanonicalJson) ||
    !(walletTransitionTargets[previous.state] as readonly string[]).includes(next.state)
  ) throw new TypeError("Wallet operation transition is invalid.");
  return next;
};

export const walletOperationReview = (operation: WalletManagementOperation): WalletReview =>
  operation.review as WalletReview;

export const walletOperationInitiator = (operation: WalletManagementOperation): WalletInitiator =>
  operation.initiatedBy as WalletInitiator;
