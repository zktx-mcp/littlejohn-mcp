import { z } from "zod";

import {
  canonicalBase64UrlSchema,
  captureCanonicalJson,
  deepFreezeValue,
  internalErrorDefinition,
  snakeCaseCodeSchema,
  unsignedDecimalSchema,
  utcTimestampSchema,
  walletConnectionDataSchema,
  type ApplicationFailure,
  type CanonicalJson,
  type WalletConnectionData,
} from "../core/browser.js";
import { runtimeStateUnavailableErrorDefinition } from "../runtime/error-definitions.js";
import {
  walletSessionUnusableErrorDefinition,
  walletTimeoutErrorDefinition,
} from "./error-definitions.js";
import {
  walletInteractionInterfaces,
  walletOperationKinds,
  walletOperationStateDefinitions,
  walletOperationStatesForKind,
  type WalletOperationKind,
  type WalletOperationStateForKind,
} from "./operation-state.js";

export const walletOperationIdByteLength = 32;
export const walletOperationIdSchema = canonicalBase64UrlSchema(walletOperationIdByteLength);

type WalletConnectionForStatus<Status extends WalletConnectionData["status"]> =
  Extract<WalletConnectionData, { readonly status: Status }>;

const canonicalWalletConnectionSchema = <Status extends WalletConnectionData["status"]>(
  status: Status,
) => walletConnectionDataSchema.refine(
  (connection): connection is WalletConnectionForStatus<Status> => connection.status === status,
  "Wallet connection status does not match the operation result.",
);

const walletOperationFailureDefinitions = Object.freeze([
  internalErrorDefinition,
  runtimeStateUnavailableErrorDefinition,
  walletSessionUnusableErrorDefinition,
  walletTimeoutErrorDefinition,
] as const);

const definitionCodes = <
  const Definitions extends readonly { readonly code: string }[],
>(definitions: Definitions): { readonly [Index in keyof Definitions]: Definitions[Index]["code"] } =>
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

const operationFailureErrorSchema = z.object({
  code: z.enum(walletOperationFailureCodes).and(snakeCaseCodeSchema),
  category: z.enum(["internal", "runtime", "wallet"]),
  message: z.string(),
  retryable: z.boolean(),
  issues: z.tuple([]),
}).strict().superRefine((error, context) => {
  const definition = operationFailureDefinitionByCode.get(error.code);
  if (
    definition === undefined ||
    error.category !== definition.category ||
    error.message !== definition.message ||
    error.retryable !== definition.retryable
  ) context.addIssue({ code: "custom", message: "Application failure does not match its authority." });
});

const walletOperationFailureSchema: z.ZodType<WalletOperationFailure> = z.object({
  ok: z.literal(false),
  error: operationFailureErrorSchema,
}).strict();

export type WalletOperationFailure = ApplicationFailure & {
  readonly error: ApplicationFailure["error"] & {
    readonly code: WalletOperationFailureCode;
  };
};


const connectOperationResultSchema = z.object({
  outcome: z.literal("connected"),
  connection: canonicalWalletConnectionSchema("connected"),
}).strict();

const disconnectOperationResultSchema = z.object({
  outcome: z.enum(["disconnected", "already_disconnected"]),
  connection: canonicalWalletConnectionSchema("disconnected"),
}).strict();

const walletManagementOperationBase = {
  operationId: walletOperationIdSchema,
  connectionRevision: unsignedDecimalSchema,
  expiresAt: utcTimestampSchema,
} as const;

type ConnectOperationResult = z.infer<typeof connectOperationResultSchema>;
type DisconnectOperationResult = z.infer<typeof disconnectOperationResultSchema>;
type WalletOperationResultForKind<Kind extends WalletOperationKind> =
  Kind extends "connect" ? ConnectOperationResult : DisconnectOperationResult;

type WalletManagementOperationForKind<Kind extends WalletOperationKind> = {
  [State in WalletOperationStateForKind<Kind>]: Readonly<{
    operationId: z.infer<typeof walletOperationIdSchema>;
    connectionRevision: z.infer<typeof unsignedDecimalSchema>;
    expiresAt: z.infer<typeof utcTimestampSchema>;
    kind: Kind;
    state: State;
  }> & (State extends "completed"
    ? Readonly<{ result: WalletOperationResultForKind<Kind>; failure: null }>
    : State extends "failed"
      ? Readonly<{ result: null; failure: WalletOperationFailure }>
      : Readonly<{ result: null; failure: null }>);
}[WalletOperationStateForKind<Kind>];

export type WalletManagementOperation = {
  [Kind in WalletOperationKind]: WalletManagementOperationForKind<Kind>;
}[WalletOperationKind];
export type WalletOperationResult = ConnectOperationResult | DisconnectOperationResult;

const operationResultSchema = (kind: WalletOperationKind) =>
  kind === "connect" ? connectOperationResultSchema : disconnectOperationResultSchema;

const operationVariantSchema = <
  Kind extends WalletOperationKind,
  State extends WalletOperationStateForKind<Kind>,
>(kind: Kind, state: State) => {
  const payload = walletOperationStateDefinitions[state].payload;
  return z.object({
    ...walletManagementOperationBase,
    kind: z.literal(kind),
    state: z.literal(state),
    result: payload === "result" ? operationResultSchema(kind) : z.null(),
    failure: payload === "failure" ? walletOperationFailureSchema : z.null(),
  }).strict();
};

const operationVariantSchemas = walletOperationKinds.flatMap((kind) =>
  walletOperationStatesForKind(kind).map((state) => operationVariantSchema(kind, state)));
if (operationVariantSchemas.length < 2) throw new TypeError("Wallet operation variants are incomplete.");
const operationVariantUnion = z.union(operationVariantSchemas as [
  typeof operationVariantSchemas[number],
  typeof operationVariantSchemas[number],
  ...typeof operationVariantSchemas[number][],
]);

export const walletManagementOperationSchema =
  operationVariantUnion as z.ZodType<WalletManagementOperation>;

export const walletOperationCreateSchema = z.object({
  kind: z.enum(walletOperationKinds),
  interactionInterface: z.enum(walletInteractionInterfaces),
}).strict();
export type WalletOperationCreate = z.infer<typeof walletOperationCreateSchema>;

export const walletOperationConfirmationSchema = z.object({
  connectionRevision: unsignedDecimalSchema,
}).strict();
export type WalletOperationConfirmation = z.infer<typeof walletOperationConfirmationSchema>;

export const walletQrMatrixSizeLimits = Object.freeze({
  minimum: 21,
  maximum: 177,
} as const);

export const walletQrMatrixSchema = z.object({
  size: z.number().int()
    .min(walletQrMatrixSizeLimits.minimum)
    .max(walletQrMatrixSizeLimits.maximum),
  rows: z.array(z.string().regex(/^[01]+$/))
    .min(walletQrMatrixSizeLimits.minimum)
    .max(walletQrMatrixSizeLimits.maximum),
}).strict().superRefine((matrix, context) => {
  if (matrix.rows.length !== matrix.size) {
    context.addIssue({ code: "custom", path: ["rows"], message: "QR row count must match its size." });
  }
  for (let index = 0; index < matrix.rows.length; index += 1) {
    if (matrix.rows[index]?.length !== matrix.size) {
      context.addIssue({ code: "custom", path: ["rows", index], message: "QR row width must match its size." });
    }
  }
});
export type WalletQrMatrix = z.infer<typeof walletQrMatrixSchema>;

export const walletOperationAllowsQr = (operation: WalletManagementOperation): boolean =>
  operation.kind === "connect" && operation.state === "awaiting_wallet_approval";

const addQrOperationIssue = (context: z.core.$RefinementCtx): void => {
  context.addIssue({
    code: "custom",
    path: ["qr"],
    message: "QR data is available only while wallet approval is pending.",
  });
};

export const walletOperationResponseSchema = z.object({
  operation: walletManagementOperationSchema,
  qr: walletQrMatrixSchema.optional(),
}).strict().superRefine((response, context) => {
  if (response.qr !== undefined && !walletOperationAllowsQr(response.operation)) addQrOperationIssue(context);
});
export type WalletOperationResponse = z.infer<typeof walletOperationResponseSchema>;

export const walletOperationPresentationAccess = Object.freeze(["interactive", "read_only"] as const);
export const walletOperationPresentationAccessSchema = z.enum(walletOperationPresentationAccess);
export type WalletOperationPresentationAccess = z.infer<typeof walletOperationPresentationAccessSchema>;
export const walletOperationPresentationSchema = z.object({
  operation: walletManagementOperationSchema,
  access: walletOperationPresentationAccessSchema,
  qr: walletQrMatrixSchema.optional(),
}).strict().superRefine((presentation, context) => {
  if (presentation.qr !== undefined && !walletOperationAllowsQr(presentation.operation)) addQrOperationIssue(context);
});
export type WalletOperationPresentation = z.infer<typeof walletOperationPresentationSchema>;

export const parseWalletOperationId = (input: unknown): string => walletOperationIdSchema.parse(input);
export const parseWalletOperationPresentationAccess = (
  input: unknown,
): WalletOperationPresentationAccess => walletOperationPresentationAccessSchema.parse(input);
export const parseWalletManagementOperation = (input: unknown): WalletManagementOperation =>
  deepFreezeValue(walletManagementOperationSchema.parse(captureCanonicalJson(input)));
export const parseWalletOperationCreate = (input: unknown): WalletOperationCreate =>
  deepFreezeValue(walletOperationCreateSchema.parse(captureCanonicalJson(input)));
export const parseWalletOperationConfirmation = (input: unknown): WalletOperationConfirmation =>
  deepFreezeValue(walletOperationConfirmationSchema.parse(captureCanonicalJson(input)));
export const parseWalletQrMatrix = (input: unknown): WalletQrMatrix =>
  deepFreezeValue(walletQrMatrixSchema.parse(captureCanonicalJson(input)));
export const parseWalletOperationResponse = (input: unknown): WalletOperationResponse => {
  const parsed = walletOperationResponseSchema.parse(captureCanonicalJson(input));
  return deepFreezeValue(parsed);
};
export const parseWalletOperationPresentation = (input: unknown): WalletOperationPresentation => {
  const parsed = walletOperationPresentationSchema.parse(captureCanonicalJson(input));
  return deepFreezeValue(parsed);
};

export const operationFailure = (failure: unknown): WalletOperationFailure =>
  deepFreezeValue(walletOperationFailureSchema.parse(captureCanonicalJson(failure as CanonicalJson)));
