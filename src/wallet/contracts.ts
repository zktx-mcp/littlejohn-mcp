import { z } from "zod";

import {
  applicationFailureSchema,
  canonicalJsonStringify,
  canonicalBase64UrlSchema,
  captureCanonicalJson,
  createApplicationFailure,
  parseCapabilityData,
  unsignedDecimalSchema,
  utcTimestampSchema,
  walletConnectionCapability,
  type ApplicationFailure,
  type CanonicalJson,
  type WalletConnectionData,
} from "../core/index.js";
import { walletErrorRegistry } from "./errors.js";

export const walletOperationKinds = Object.freeze(["connect", "disconnect"] as const);
const walletOperationStateDefinitions = Object.freeze({
  awaiting_confirmation: Object.freeze({
    terminal: false,
    payload: "none",
    kinds: Object.freeze(["connect", "disconnect"] as const),
  }),
  awaiting_wallet_approval: Object.freeze({
    terminal: false,
    payload: "none",
    kinds: Object.freeze(["connect"] as const),
  }),
  disconnecting: Object.freeze({
    terminal: false,
    payload: "none",
    kinds: Object.freeze(["connect", "disconnect"] as const),
  }),
  validating_session: Object.freeze({
    terminal: false,
    payload: "none",
    kinds: Object.freeze(["connect"] as const),
  }),
  completed: Object.freeze({
    terminal: true,
    payload: "result",
    kinds: Object.freeze(["connect", "disconnect"] as const),
  }),
  cancelled: Object.freeze({
    terminal: true,
    payload: "none",
    kinds: Object.freeze(["connect", "disconnect"] as const),
  }),
  rejected: Object.freeze({
    terminal: true,
    payload: "none",
    kinds: Object.freeze(["connect"] as const),
  }),
  failed: Object.freeze({
    terminal: true,
    payload: "failure",
    kinds: Object.freeze(["connect", "disconnect"] as const),
  }),
  expired: Object.freeze({
    terminal: true,
    payload: "none",
    kinds: Object.freeze(["connect", "disconnect"] as const),
  }),
} as const);
export const walletInteractionInterfaces = Object.freeze(["cli", "web"] as const);
export const walletManagementCapabilityIds = Object.freeze([
  "wallet.cancel_operation",
  "wallet.connect",
  "wallet.disconnect",
  "wallet.operation",
] as const);

export type WalletOperationKind = typeof walletOperationKinds[number];
export type WalletOperationState = keyof typeof walletOperationStateDefinitions;
export type WalletOperationStateForKind<Kind extends WalletOperationKind> = {
  [State in WalletOperationState]: Kind extends
  typeof walletOperationStateDefinitions[State]["kinds"][number] ? State : never;
}[WalletOperationState];
export type WalletInteractionInterface = typeof walletInteractionInterfaces[number];

export const walletOperationStates = Object.freeze(
  Object.keys(walletOperationStateDefinitions) as WalletOperationState[],
);

export const isWalletOperationTerminalState = (state: WalletOperationState): boolean =>
  walletOperationStateDefinitions[state].terminal;

const operationStatesForKind = <Kind extends WalletOperationKind>(
  kind: Kind,
): readonly [WalletOperationStateForKind<Kind>, ...WalletOperationStateForKind<Kind>[]] => {
  const states = walletOperationStates.filter((state) =>
    (walletOperationStateDefinitions[state].kinds as readonly WalletOperationKind[]).includes(kind));
  if (states.length === 0) throw new TypeError("A wallet operation kind must own at least one state.");
  return states as [WalletOperationStateForKind<Kind>, ...WalletOperationStateForKind<Kind>[]];
};

const operationIdSchema = canonicalBase64UrlSchema(32);

type WalletConnectionForStatus<Status extends WalletConnectionData["status"]> =
  Extract<WalletConnectionData, { readonly status: Status }>;

const canonicalWalletConnectionSchema = <Status extends WalletConnectionData["status"]>(
  status: Status,
) => z.unknown().transform((value, context): WalletConnectionForStatus<Status> => {
  try {
    const connection = parseCapabilityData(walletConnectionCapability, value);
    if (connection.status !== status) throw new TypeError("Wallet connection status does not match the operation result.");
    return connection as WalletConnectionForStatus<Status>;
  } catch {
    context.addIssue({ code: "custom", message: "Wallet connection data is invalid." });
    return z.NEVER;
  }
});

export const walletOperationFailureCodes = Object.freeze([
  "internal_error",
  "runtime_state_unavailable",
  "wallet_session_unusable",
  "wallet_timeout",
] as const);
export type WalletOperationFailureCode = typeof walletOperationFailureCodes[number];
const walletOperationFailureCodeSet = new Set<string>(walletOperationFailureCodes);
export const isWalletOperationFailureCode = (value: unknown): value is WalletOperationFailureCode =>
  typeof value === "string" && walletOperationFailureCodeSet.has(value);

export type WalletOperationFailure = ApplicationFailure & {
  readonly error: ApplicationFailure["error"] & {
    readonly code: WalletOperationFailureCode;
  };
};

const canonicalWalletOperationFailureSchema = z.unknown().transform((value, context): WalletOperationFailure => {
  try {
    const captured = captureCanonicalJson(value);
    const parsed = applicationFailureSchema.parse(captured);
    if (!isWalletOperationFailureCode(parsed.error.code) || parsed.error.issues.length !== 0) {
      throw new TypeError("Application failure is not an operation failure.");
    }
    const normalized = createApplicationFailure(walletErrorRegistry, parsed.error.code, parsed.error.issues);
    if (canonicalJsonStringify(captured) !==
      canonicalJsonStringify(normalized as unknown as CanonicalJson)) {
      throw new TypeError("Application failure does not match its authority.");
    }
    return normalized as WalletOperationFailure;
  } catch {
    context.addIssue({ code: "custom", message: "Application failure is invalid." });
    return z.NEVER;
  }
});

const connectOperationResultSchema = z.object({
  outcome: z.literal("connected"),
  connection: canonicalWalletConnectionSchema("connected"),
}).strict();

const disconnectOperationResultSchema = z.object({
  outcome: z.enum(["disconnected", "already_disconnected"]),
  connection: canonicalWalletConnectionSchema("disconnected"),
}).strict();

const walletManagementOperationBase = {
  operationId: operationIdSchema,
  connectionRevision: unsignedDecimalSchema,
  expiresAt: utcTimestampSchema,
} as const;

type ConnectOperationResult = z.infer<typeof connectOperationResultSchema>;
type DisconnectOperationResult = z.infer<typeof disconnectOperationResultSchema>;
type WalletOperationResultForKind<Kind extends WalletOperationKind> =
  Kind extends "connect" ? ConnectOperationResult : DisconnectOperationResult;

type WalletManagementOperationForKind<Kind extends WalletOperationKind> = {
  [State in WalletOperationStateForKind<Kind>]: Readonly<{
    operationId: z.infer<typeof operationIdSchema>;
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
    failure: payload === "failure" ? canonicalWalletOperationFailureSchema : z.null(),
  }).strict();
};

const operationVariantSchemas = walletOperationKinds.flatMap((kind) =>
  operationStatesForKind(kind).map((state) => operationVariantSchema(kind, state)));
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

export const walletQrMatrixSchema = z.object({
  size: z.number().int().min(21).max(177),
  rows: z.array(z.string().regex(/^[01]+$/)).min(21).max(177),
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

const operationAllowsQr = (operation: WalletManagementOperation): boolean =>
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
  if (response.qr !== undefined && !operationAllowsQr(response.operation)) addQrOperationIssue(context);
});
export type WalletOperationResponse = z.infer<typeof walletOperationResponseSchema>;

export const walletOperationPresentationAccess = Object.freeze(["interactive", "read_only"] as const);
export const walletOperationPresentationSchema = z.object({
  operation: walletManagementOperationSchema,
  access: z.enum(walletOperationPresentationAccess),
  qr: walletQrMatrixSchema.optional(),
}).strict().superRefine((presentation, context) => {
  if (presentation.qr !== undefined && !operationAllowsQr(presentation.operation)) addQrOperationIssue(context);
});
export type WalletOperationPresentation = z.infer<typeof walletOperationPresentationSchema>;

export interface WalletLocalControlOperationPort {
  start(input: WalletOperationCreate): Promise<WalletOperationResponse>;
  get(operationId: string): Promise<WalletOperationResponse>;
  cancel(operationId: string): Promise<WalletOperationResponse>;
}

export interface WalletWebOperationPort {
  start(kind: WalletOperationKind): Promise<WalletManagementOperation>;
  get(operationId: string): Promise<WalletManagementOperation>;
  cancel(operationId: string): Promise<WalletManagementOperation>;
}

export interface WalletOperationConfirmationPort<
  InteractionInterface extends WalletInteractionInterface,
> {
  readonly interactionInterface: InteractionInterface;
  confirm(
    operationId: string,
    input: WalletOperationConfirmation,
  ): Promise<InteractionInterface extends "cli" ? WalletOperationResponse : WalletManagementOperation>;
}

export interface WalletOperationPresentationPort {
  get(operationId: string): Promise<WalletOperationPresentation>;
}

export interface WalletInterfaceOperations {
  readonly operation: WalletWebOperationPort;
  readonly confirmation: WalletOperationConfirmationPort<"web">;
  readonly presentation: WalletOperationPresentationPort;
}

export const parseWalletOperationId = (input: unknown): string => operationIdSchema.parse(input);
export const parseWalletManagementOperation = (input: unknown): WalletManagementOperation => {
  const parsed = walletManagementOperationSchema.parse(captureCanonicalJson(input));
  if (parsed.result !== null) Object.freeze(parsed.result);
  return Object.freeze(parsed);
};
export const parseWalletOperationCreate = (input: unknown): WalletOperationCreate =>
  Object.freeze(walletOperationCreateSchema.parse(captureCanonicalJson(input)));
export const parseWalletOperationConfirmation = (input: unknown): WalletOperationConfirmation =>
  Object.freeze(walletOperationConfirmationSchema.parse(captureCanonicalJson(input)));
export const parseWalletQrMatrix = (input: unknown): WalletQrMatrix => {
  const parsed = walletQrMatrixSchema.parse(captureCanonicalJson(input));
  Object.freeze(parsed.rows);
  return Object.freeze(parsed);
};
export const parseWalletOperationResponse = (input: unknown): WalletOperationResponse => {
  const parsed = walletOperationResponseSchema.parse(captureCanonicalJson(input));
  return Object.freeze({
    operation: parseWalletManagementOperation(parsed.operation),
    ...(parsed.qr === undefined ? {} : { qr: parseWalletQrMatrix(parsed.qr) }),
  });
};
export const parseWalletOperationPresentation = (input: unknown): WalletOperationPresentation => {
  const parsed = walletOperationPresentationSchema.parse(captureCanonicalJson(input));
  return Object.freeze({
    operation: parseWalletManagementOperation(parsed.operation),
    access: parsed.access,
    ...(parsed.qr === undefined ? {} : { qr: parseWalletQrMatrix(parsed.qr) }),
  });
};

export const operationFailure = (failure: ApplicationFailure): WalletOperationFailure =>
  canonicalWalletOperationFailureSchema.parse(captureCanonicalJson(failure));
