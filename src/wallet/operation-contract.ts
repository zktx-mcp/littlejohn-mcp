import { z } from "zod";

import {
  captureCanonicalJson,
  deepFreezeValue,
  internalErrorDefinition,
  operationIdByteLength,
  operationIdSchema,
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
  walletUserRejectedErrorDefinition,
} from "./error-definitions.js";
import {
  isWalletOperationTerminalState,
  walletInteractionInterfaces,
  walletOperationKinds,
  walletOperationStateDefinitions,
  walletOperationStatesForKind,
  type WalletNonterminalOperationState,
  type WalletOperationKind,
  type WalletOperationStateForKind,
} from "./operation-state.js";

export const walletOperationIdByteLength = operationIdByteLength;
export const walletOperationIdSchema = operationIdSchema;

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

export const walletTerminalStateFailureCodes = Object.freeze({
  expired: walletTimeoutErrorDefinition.code,
  rejected: walletUserRejectedErrorDefinition.code,
} as const);

const operationFailureDefinitionByCode = new Map(
  walletOperationFailureDefinitions.map((definition) => [definition.code, definition] as const),
);
const walletOperationFailureCategories =
  distinctDefinitionCategories(walletOperationFailureDefinitions);

const operationFailureErrorSchema = z.object({
  code: z.enum(walletOperationFailureCodes).and(snakeCaseCodeSchema),
  category: z.enum(walletOperationFailureCategories),
  message: z.string(),
  retryable: z.boolean(),
  issues: z.array(z.unknown()).length(0) as
    z.ZodType<ApplicationFailure["error"]["issues"]>,
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


export const walletOperationOutcomes = Object.freeze({
  connect: Object.freeze(["connected"] as const),
  disconnect: Object.freeze(["disconnected", "already_disconnected"] as const),
});
export type WalletOperationOutcomeForKind<Kind extends WalletOperationKind> =
  typeof walletOperationOutcomes[Kind][number];
export type WalletOperationOutcome =
  typeof walletOperationOutcomes[keyof typeof walletOperationOutcomes][number];

const connectOperationResultSchema = z.object({
  outcome: z.literal(walletOperationOutcomes.connect[0]),
  connection: canonicalWalletConnectionSchema("connected"),
}).strict();

const disconnectOperationResultSchema = z.object({
  outcome: z.enum(walletOperationOutcomes.disconnect),
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
  Kind extends "disconnect" ? DisconnectOperationResult : ConnectOperationResult;

export type WalletManagementOperationForKind<Kind extends WalletOperationKind> = {
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
export type WalletNonterminalManagementOperation = Extract<
  WalletManagementOperation,
  { readonly state: WalletNonterminalOperationState }
>;
export type WalletOperationResult = ConnectOperationResult | DisconnectOperationResult;

const operationResultSchema = (kind: WalletOperationKind) =>
  kind === "disconnect" ? disconnectOperationResultSchema : connectOperationResultSchema;

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

const connectOperationVariantSchemas = walletOperationStatesForKind("connect")
  .map((state) => operationVariantSchema("connect", state));
const disconnectOperationVariantSchemas = walletOperationStatesForKind("disconnect")
  .map((state) => operationVariantSchema("disconnect", state));
const nonterminalOperationVariantSchemas = [
  ...walletOperationStatesForKind("connect")
    .filter((state) => !isWalletOperationTerminalState(state))
    .map((state) => operationVariantSchema("connect", state)),
  ...walletOperationStatesForKind("disconnect")
    .filter((state) => !isWalletOperationTerminalState(state))
    .map((state) => operationVariantSchema("disconnect", state)),
];

const operationUnion = (schemas: readonly z.ZodType[]): z.ZodType => {
  if (schemas.length < 2) throw new TypeError("Wallet operation variants are incomplete.");
  return z.union(schemas as [
    z.ZodType,
    z.ZodType,
    ...z.ZodType[],
  ]);
};

export const walletManagementOperationSchemas = Object.freeze({
  connect: operationUnion(connectOperationVariantSchemas) as
    z.ZodType<WalletManagementOperationForKind<"connect">>,
  disconnect: operationUnion(disconnectOperationVariantSchemas) as
    z.ZodType<WalletManagementOperationForKind<"disconnect">>,
});

export const walletManagementOperationSchemaForKind = (
  kind: WalletOperationKind,
): z.ZodType<WalletManagementOperation> => walletManagementOperationSchemas[kind] as
  z.ZodType<WalletManagementOperation>;

export const walletOperationStartedResultSchemaForKind = (
  kind: WalletOperationKind,
) => z.object({
  status: z.literal("operation_started"),
  operation: walletManagementOperationSchemaForKind(kind),
}).strict();

const operationVariantSchemas: readonly z.ZodType[] = [
  ...connectOperationVariantSchemas,
  ...disconnectOperationVariantSchemas,
];
if (operationVariantSchemas.length < 2) throw new TypeError("Wallet operation variants are incomplete.");
const operationVariantUnion = operationUnion(operationVariantSchemas);

export const walletManagementOperationSchema =
  operationVariantUnion as z.ZodType<WalletManagementOperation>;
export const walletNonterminalManagementOperationSchema =
  operationUnion(nonterminalOperationVariantSchemas) as
    z.ZodType<WalletNonterminalManagementOperation>;

export const walletInteractionInterfaceSchema = z.enum(walletInteractionInterfaces);

export const walletOperationControlSchema = z.object({
  operationId: walletOperationIdSchema,
  interactionInterface: walletInteractionInterfaceSchema,
}).strict();
export type WalletOperationControl = z.infer<typeof walletOperationControlSchema>;

const walletOperationCommandSchema = walletOperationControlSchema.extend({
  kind: z.enum(walletOperationKinds),
  connectionRevision: unsignedDecimalSchema.nullable(),
}).strict();

export const walletOperationCreateSchema = z.object({
  control: walletOperationControlSchema,
  request: z.object({
    kind: z.enum(walletOperationKinds),
    connectionRevision: unsignedDecimalSchema.nullable(),
  }).strict(),
}).strict().transform(({ control, request }) => walletOperationCommandSchema.parse({ ...control, ...request }));
export type WalletOperationCreate = z.infer<typeof walletOperationCommandSchema>;

export const walletWebOperationCreateSchema = z.object({
  kind: z.enum(walletOperationKinds),
  connectionRevision: unsignedDecimalSchema,
}).strict();
export type WalletWebOperationCreate = z.infer<typeof walletWebOperationCreateSchema>;

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

export const walletCurrentConnectionStartResultSchema = z.object({
  status: z.literal("current_connection"),
  connectionRevision: unsignedDecimalSchema,
  connection: canonicalWalletConnectionSchema("connected"),
}).strict();

const operationStartedResultSchema = z.object({
  status: z.literal("operation_started"),
  operation: walletManagementOperationSchema,
}).strict();

export const walletOperationStartResultSchema = z.discriminatedUnion("status", [
  walletCurrentConnectionStartResultSchema,
  operationStartedResultSchema,
]);
export type WalletOperationStartResult = z.infer<typeof walletOperationStartResultSchema>;

export const walletOperationStartResponseSchema = z.object({
  result: walletOperationStartResultSchema,
  qr: walletQrMatrixSchema.optional(),
}).strict().superRefine((response, context) => {
  if (response.qr === undefined) return;
  if (
    response.result.status !== "operation_started" ||
    !walletOperationAllowsQr(response.result.operation)
  ) addQrOperationIssue(context);
});
export type WalletOperationStartResponse = z.infer<typeof walletOperationStartResponseSchema>;

export const walletOperationPresentationAccess = Object.freeze(["interactive", "read_only"] as const);
export const walletOperationPresentationAccessSchema = z.enum(walletOperationPresentationAccess);
export type WalletOperationPresentationAccess = z.infer<typeof walletOperationPresentationAccessSchema>;
const operationPresentationSchema = <Operation extends WalletManagementOperation>(
  operationSchema: z.ZodType<Operation>,
) => z.object({
  operation: operationSchema,
  access: walletOperationPresentationAccessSchema,
  qr: walletQrMatrixSchema.optional(),
}).strict().superRefine((presentation, context) => {
  if (presentation.qr !== undefined && !walletOperationAllowsQr(presentation.operation)) addQrOperationIssue(context);
});
export const walletOperationPresentationSchema = operationPresentationSchema(
  walletManagementOperationSchema,
);
export const walletCurrentOperationPresentationSchema = operationPresentationSchema(
  walletNonterminalManagementOperationSchema,
);
export type WalletOperationPresentation = z.infer<typeof walletOperationPresentationSchema>;

export const walletCurrentOperationProjectionSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("absent"),
    connectionRevision: unsignedDecimalSchema,
    connection: walletConnectionDataSchema,
  }).strict(),
  z.object({
    status: z.literal("present"),
    connectionRevision: unsignedDecimalSchema,
    connection: walletConnectionDataSchema,
    presentation: walletCurrentOperationPresentationSchema,
  }).strict(),
]);
export type WalletCurrentOperationProjection = z.infer<typeof walletCurrentOperationProjectionSchema>;

export const parseWalletOperationId = (input: unknown): string => walletOperationIdSchema.parse(input);
export const parseWalletOperationPresentationAccess = (
  input: unknown,
): WalletOperationPresentationAccess => walletOperationPresentationAccessSchema.parse(input);
export const parseWalletManagementOperation = (input: unknown): WalletManagementOperation =>
  deepFreezeValue(walletManagementOperationSchema.parse(captureCanonicalJson(input)));
export const parseWalletOperationCreate = (input: unknown): WalletOperationCreate =>
  deepFreezeValue(walletOperationCreateSchema.parse(captureCanonicalJson(input)));
export const parseWalletOperationCommand = (input: unknown): WalletOperationCreate =>
  deepFreezeValue(walletOperationCommandSchema.parse(captureCanonicalJson(input)));
export const parseWalletWebOperationCreate = (input: unknown): WalletWebOperationCreate =>
  deepFreezeValue(walletWebOperationCreateSchema.parse(captureCanonicalJson(input)));
export const parseWalletOperationConfirmation = (input: unknown): WalletOperationConfirmation =>
  deepFreezeValue(walletOperationConfirmationSchema.parse(captureCanonicalJson(input)));
export const parseWalletQrMatrix = (input: unknown): WalletQrMatrix =>
  deepFreezeValue(walletQrMatrixSchema.parse(captureCanonicalJson(input)));
export const parseWalletOperationResponse = (input: unknown): WalletOperationResponse => {
  const parsed = walletOperationResponseSchema.parse(captureCanonicalJson(input));
  return deepFreezeValue(parsed);
};
export const parseWalletOperationStartResult = (input: unknown): WalletOperationStartResult =>
  deepFreezeValue(walletOperationStartResultSchema.parse(captureCanonicalJson(input)));
export const parseWalletOperationStartResponse = (input: unknown): WalletOperationStartResponse =>
  deepFreezeValue(walletOperationStartResponseSchema.parse(captureCanonicalJson(input)));
export const parseWalletOperationPresentation = (input: unknown): WalletOperationPresentation => {
  const parsed = walletOperationPresentationSchema.parse(captureCanonicalJson(input));
  return deepFreezeValue(parsed);
};
export const parseWalletCurrentOperationProjection = (input: unknown): WalletCurrentOperationProjection =>
  deepFreezeValue(walletCurrentOperationProjectionSchema.parse(captureCanonicalJson(input)));

export const operationFailure = (failure: unknown): WalletOperationFailure =>
  deepFreezeValue(walletOperationFailureSchema.parse(captureCanonicalJson(failure as CanonicalJson)));
