import { z, type ZodType } from "zod";

import {
  assertCapabilitySuccessChainScope,
  applicationFailureSchemaFor,
  blockSelectorSchema,
  canonicalAmountSchema,
  canonicalBase64UrlSchema,
  canonicalSha256,
  capabilityIdSchema,
  captureCanonicalJson,
  chainAnchorSchema,
  codePointLength,
  coreContractVersion,
  coreErrorRegistry,
  createCapabilitySuccessSchema,
  defineApplicationContract as defineCanonicalApplicationContract,
  deepFreezeValue,
  erc20AssetIdentitySchema,
  evmAccountIdentitySchema,
  evmAddressSchema,
  jsonObject,
  hash32Schema,
  isSafeSingleLineText,
  parseHash32,
  observationIdSchema,
  operationIdByteLength,
  operationIdSchema,
  readCapabilityLimits,
  staticScopeExclusionSchema,
  unsignedDecimalSchema,
  utcTimestampSchema,
  utf8ByteLength,
  type ApplicationFailure,
  type ApplicationContract,
  type CanonicalJson,
  type CapabilityId,
  type CapabilitySuccess,
  type EvmAccountIdentity,
} from "../core/browser.js";
import { chainErrorDefinitions } from "../chain/error-definitions.js";
import { runtimeErrorDefinitions } from "../runtime/error-definitions.js";
import { walletErrorDefinitions } from "../wallet/error-definitions.js";
import { tokenCatalogErrorDefinitions } from "./error-definitions.js";
import {
  tokenCatalogInteractionInterfaces,
  tokenCatalogOperationKinds,
  tokenCatalogOperationStates,
  type TokenCatalogOperationKind,
  type TokenCatalogOperationState,
} from "./state.js";

export const tokenCatalogContractLimits = Object.freeze({
  displayTextCodePoints: 128,
  displayTextUtf8Bytes: 512,
  registrationRevisionBytes: 16,
  operationIdBytes: operationIdByteLength,
  listDefaultLimit: 25,
  listMaximumLimit: 25,
});

export const tokenCatalogDigestVersions = Object.freeze({
  inspection: "1",
  review: "2",
} as const);

export const tokenDisplayTextSchema = z.string()
  .refine(
    (value) => codePointLength(value) <= tokenCatalogContractLimits.displayTextCodePoints,
    `Text exceeds ${tokenCatalogContractLimits.displayTextCodePoints} Unicode code points.`,
  )
  .refine(
    (value) => utf8ByteLength(value) <= tokenCatalogContractLimits.displayTextUtf8Bytes,
    `Text exceeds ${tokenCatalogContractLimits.displayTextUtf8Bytes} UTF-8 bytes.`,
  )
  .refine(isSafeSingleLineText, "Expected safe single-line text.");

export const tokenRegistrationRevisionSchema = canonicalBase64UrlSchema(
  tokenCatalogContractLimits.registrationRevisionBytes,
);
export const tokenCatalogOperationIdSchema = operationIdSchema;

const optionalTextObservationSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("available"),
    value: tokenDisplayTextSchema,
    observationId: observationIdSchema,
  }).strict(),
  z.object({
    status: z.literal("unavailable"),
    reason: z.enum(["call_failed", "malformed", "unsafe_text"]),
    observationId: observationIdSchema,
  }).strict(),
]);

export const tokenInspectionInputSchema = z.object({
  asset: erc20AssetIdentitySchema,
  block: blockSelectorSchema,
}).strict();
export type TokenInspectionInput = z.infer<typeof tokenInspectionInputSchema>;

export const tokenInspectionDataSchema = z.object({
  asset: erc20AssetIdentitySchema,
  block: chainAnchorSchema,
  runtimeCode: z.object({
    byteLength: unsignedDecimalSchema.refine(
      (value) => BigInt(value) > 0n && BigInt(value) <= BigInt(readCapabilityLimits.runtimeCodeBytes),
      "Runtime code size is outside the inspection boundary.",
    ),
    codeHash: hash32Schema,
  }).strict(),
  totalSupply: canonicalAmountSchema,
  metadata: z.object({
    name: optionalTextObservationSchema,
    symbol: optionalTextObservationSchema,
  }).strict(),
}).strict().superRefine((data, context) => {
  if (
    data.asset.chainId !== data.block.chainId ||
    data.totalSupply.asset.kind !== "erc20" ||
    data.totalSupply.asset.chainId !== data.asset.chainId ||
    data.totalSupply.asset.address !== data.asset.address ||
    data.runtimeCode.byteLength === "0"
  ) {
    context.addIssue({ code: "custom", message: "Token inspection identity is inconsistent." });
  }
  if (data.totalSupply.decimals.status === "not_observed") {
    context.addIssue({ code: "custom", message: "Token inspection must attempt decimals observation." });
    return;
  }
  const observationIds = [
    data.totalSupply.quantityObservationId,
    ...(data.totalSupply.decimals.status === "available"
      ? [data.totalSupply.decimals.observationId]
      : data.totalSupply.decimals.observationIds),
    data.metadata.name.observationId,
    data.metadata.symbol.observationId,
  ];
  if (
    new Set(observationIds).size !== observationIds.length ||
    (data.totalSupply.decimals.status === "unavailable" &&
      data.totalSupply.decimals.observationIds.length !== 1)
  ) {
    context.addIssue({ code: "custom", message: "Token inspection observations are not independent." });
  }
});
export type TokenInspectionData = z.infer<typeof tokenInspectionDataSchema>;

export type TokenInspectionSuccess = CapabilitySuccess<TokenInspectionData>;

export const tokenInspectCapabilityId = capabilityIdSchema.parse("token.inspect");

export const tokenInspectionStaticScopeExclusions = Object.freeze([
  { id: "account_balance", message: "This inspection does not read an account balance." },
  { id: "official_asset_identity", message: "This inspection does not establish official asset identity." },
  { id: "price_and_liquidity", message: "This inspection does not establish price or liquidity." },
  { id: "protocol_identity", message: "This inspection does not establish protocol identity." },
  { id: "proxy_and_controls", message: "This inspection does not inspect proxy or control authority." },
  { id: "safety", message: "This inspection does not establish token safety." },
  { id: "source_verification", message: "This inspection does not establish source verification." },
  { id: "transaction_support", message: "This inspection does not establish transaction support." },
].map((value) => Object.freeze(staticScopeExclusionSchema.parse(value))));

const canonicalTokenInspectionSuccessSchema = createCapabilitySuccessSchema(
  tokenInspectCapabilityId,
  tokenInspectionDataSchema,
);
const structuralTokenInspectionSuccessSchema = z.fromJSONSchema(
  captureCanonicalJson(JSON.parse(JSON.stringify(z.toJSONSchema(canonicalTokenInspectionSuccessSchema, {
    target: "draft-2020-12",
    unrepresentable: "throw",
    io: "output",
  })))) as never,
) as ZodType<TokenInspectionSuccess>;

export const tokenInspectionSuccessSchema = structuralTokenInspectionSuccessSchema.superRefine((value, context) => {
  try {
    tokenInspectionDataSchema.parse(value.data);
    assertCapabilitySuccessChainScope(value);
    if (value.meta.chainId !== value.data.asset.chainId) {
      throw new TypeError("Token inspection chain scope mismatch.");
    }
  } catch {
    context.addIssue({ code: "custom", message: "Token inspection success is invalid." });
  }
}) as ZodType<TokenInspectionSuccess>;

export const tokenInspectionDigest = (resultInput: unknown) => {
  const result = tokenInspectionSuccessSchema.parse(captureCanonicalJson(resultInput));
  return parseHash32(`0x${canonicalSha256({
    digestKind: "token_inspection",
    digestVersion: tokenCatalogDigestVersions.inspection,
    result: result as unknown as CanonicalJson,
  })}`);
};

const tokenCatalogReviewDigestInputSchema = z.object({
  operationId: tokenCatalogOperationIdSchema,
  kind: z.enum(tokenCatalogOperationKinds),
  account: evmAccountIdentitySchema,
  connectionRevision: unsignedDecimalSchema,
  asset: erc20AssetIdentitySchema,
  previousRegistration: z.lazy(() => tokenRegistrationSchema).nullable(),
  inspection: tokenInspectionSuccessSchema,
  interactionInterface: z.enum(tokenCatalogInteractionInterfaces),
  expiresAt: utcTimestampSchema,
}).strict();

export const tokenCatalogReviewDigest = (inputValue: unknown) => {
  const input = tokenCatalogReviewDigestInputSchema.parse(captureCanonicalJson(inputValue));
  return parseHash32(`0x${canonicalSha256({
    digestKind: "token_catalog_review",
    digestVersion: tokenCatalogDigestVersions.review,
    coreContractVersion,
    operationId: input.operationId,
    operationKind: input.kind,
    account: input.account as unknown as CanonicalJson,
    connectionRevision: input.connectionRevision,
    asset: input.asset as unknown as CanonicalJson,
    previousRegistration: input.previousRegistration as unknown as CanonicalJson,
    inspection: input.inspection as unknown as CanonicalJson,
    interactionInterface: input.interactionInterface,
    expiresAt: input.expiresAt,
  })}`);
};

export const tokenRegistrationSchema = z.object({
  account: evmAccountIdentitySchema,
  asset: erc20AssetIdentitySchema,
  revision: tokenRegistrationRevisionSchema,
  inspectionDigest: hash32Schema,
  createdAt: utcTimestampSchema,
}).strict().superRefine((value, context) => {
  if (value.account.chainId !== value.asset.chainId) {
    context.addIssue({ code: "custom", message: "Token registration identity is invalid." });
  }
});
export type TokenRegistration = z.infer<typeof tokenRegistrationSchema>;

export const tokenRegistrationWithInspectionSchema = z.object({
  registration: tokenRegistrationSchema,
  inspection: tokenInspectionSuccessSchema,
}).strict().superRefine((value, context) => {
  if (
    value.registration.asset.chainId !== value.inspection.data.asset.chainId ||
    value.registration.asset.address !== value.inspection.data.asset.address ||
    value.registration.inspectionDigest !== tokenInspectionDigest(value.inspection)
  ) context.addIssue({ code: "custom", message: "Registration inspection identity is invalid." });
});
export type TokenRegistrationWithInspection = z.infer<typeof tokenRegistrationWithInspectionSchema>;

const tokenCatalogApplicationErrorRegistry = coreErrorRegistry
  .extend(runtimeErrorDefinitions)
  .extend(walletErrorDefinitions)
  .extend(chainErrorDefinitions)
  .extend(tokenCatalogErrorDefinitions);

const operationFailureCodes = Object.freeze([
  "internal_error",
  "runtime_state_unavailable",
  "state_conflict",
  "token_registration_revision_changed",
  "wallet_not_connected",
  "wallet_session_unusable",
]);
const tokenOperationFailureSchema = applicationFailureSchemaFor(
  tokenCatalogApplicationErrorRegistry,
  operationFailureCodes,
);

const operationReviewSchema = z.object({
  previousRegistration: tokenRegistrationSchema.nullable(),
  inspection: tokenInspectionSuccessSchema,
  reviewDigest: hash32Schema,
}).strict();

const registrationOperationResultSchema = tokenRegistrationWithInspectionSchema;
const unregistrationOperationResultSchema = z.object({
  asset: erc20AssetIdentitySchema,
  removedRevision: tokenRegistrationRevisionSchema,
}).strict();

const operationCommonShape = {
  operationId: tokenCatalogOperationIdSchema,
  interactionInterface: z.enum(tokenCatalogInteractionInterfaces),
  createdAt: utcTimestampSchema,
  expiresAt: utcTimestampSchema,
  account: evmAccountIdentitySchema,
  connectionRevision: unsignedDecimalSchema,
  asset: erc20AssetIdentitySchema,
  review: operationReviewSchema,
} as const;

const sameAccount = (left: EvmAccountIdentity, right: EvmAccountIdentity): boolean =>
  left.chainId === right.chainId && left.address === right.address;

const sameAsset = (
  left: TokenRegistration["asset"],
  right: TokenRegistration["asset"],
): boolean => left.chainId === right.chainId && left.address === right.address;

const operationVariantSchema = <
  Kind extends TokenCatalogOperationKind,
  State extends TokenCatalogOperationState,
  ResultSchema extends ZodType,
  FailureSchema extends ZodType,
>(
  kind: Kind,
  state: State,
  result: ResultSchema,
  failure: FailureSchema,
) => z.object({
  ...operationCommonShape,
  kind: z.literal(kind),
  state: z.literal(state),
  result,
  failure,
}).strict();

const operationSchemasForKind = <
  Kind extends TokenCatalogOperationKind,
  CompletedResultSchema extends ZodType,
>(kind: Kind, completedResult: CompletedResultSchema) => ({
  applying: operationVariantSchema(kind, "applying", z.null(), z.null()),
  awaiting_confirmation: operationVariantSchema(
    kind,
    "awaiting_confirmation",
    z.null(),
    z.null(),
  ),
  cancelled: operationVariantSchema(kind, "cancelled", z.null(), z.null()),
  completed: operationVariantSchema(kind, "completed", completedResult, z.null()),
  expired: operationVariantSchema(kind, "expired", z.null(), z.null()),
  failed: operationVariantSchema(kind, "failed", z.null(), tokenOperationFailureSchema),
} as const satisfies Record<TokenCatalogOperationState, ZodType>);

const operationSchemas = {
  register: operationSchemasForKind("register", registrationOperationResultSchema),
  unregister: operationSchemasForKind("unregister", unregistrationOperationResultSchema),
} as const satisfies Record<TokenCatalogOperationKind, object>;

const tokenCatalogOperationStructuralSchema = z.union([
  operationSchemas.register.applying,
  operationSchemas.register.awaiting_confirmation,
  operationSchemas.register.cancelled,
  operationSchemas.register.completed,
  operationSchemas.register.expired,
  operationSchemas.register.failed,
  operationSchemas.unregister.applying,
  operationSchemas.unregister.awaiting_confirmation,
  operationSchemas.unregister.cancelled,
  operationSchemas.unregister.completed,
  operationSchemas.unregister.expired,
  operationSchemas.unregister.failed,
]);

export type TokenCatalogOperation = z.output<typeof tokenCatalogOperationStructuralSchema>;
export type TokenCatalogOperationVariant<
  Kind extends TokenCatalogOperationKind,
  State extends TokenCatalogOperationState,
> = Extract<TokenCatalogOperation, { readonly kind: Kind; readonly state: State }>;

export type TokenCatalogAwaitingOperation<Kind extends TokenCatalogOperationKind = TokenCatalogOperationKind> =
  Extract<TokenCatalogOperation, { readonly kind: Kind; readonly state: "awaiting_confirmation" }>;
export type TokenCatalogConfirmedOperation = Extract<
  TokenCatalogOperation,
  { readonly state: "completed" | "failed" }
>;
export type TokenCatalogTerminalOperation = Extract<
  TokenCatalogOperation,
  { readonly state: "cancelled" | "completed" | "expired" | "failed" }
>;

const validateTokenCatalogOperation = (
  operation: TokenCatalogOperation,
  addIssue: (message: string) => void,
): void => {
  if (
    operation.account.chainId !== operation.asset.chainId ||
    operation.review.inspection.data.asset.chainId !== operation.asset.chainId ||
    operation.review.inspection.data.asset.address !== operation.asset.address ||
    operation.expiresAt <= operation.createdAt
  ) {
    addIssue("Token operation identity or lifetime is invalid.");
    return;
  }
  const previous = operation.review.previousRegistration;
  if (previous !== null && (
    !sameAccount(previous.account, operation.account) ||
    !sameAsset(previous.asset, operation.asset) ||
    previous.inspectionDigest !== tokenInspectionDigest(operation.review.inspection)
  )) {
    addIssue("Token operation previous registration is invalid.");
  }
  if (
    (operation.kind === "register" && previous !== null) ||
    (operation.kind === "unregister" && previous === null)
  ) {
    addIssue("Token operation review does not match its kind.");
  }
  if (operation.state !== "completed" || operation.result === null) return;
  if (operation.kind === "unregister") {
    if (!("removedRevision" in operation.result) || previous === null ||
      operation.result.asset.chainId !== operation.asset.chainId ||
      operation.result.asset.address !== operation.asset.address ||
      operation.result.removedRevision !== previous.revision) {
      addIssue("Token removal result is invalid.");
    }
    return;
  }
  if (!("registration" in operation.result)) {
    addIssue("Token registration result is invalid.");
    return;
  }
  const registration = operation.result.registration;
  const resultInspectionDigest = tokenInspectionDigest(operation.result.inspection);
  const reviewInspectionDigest = tokenInspectionDigest(operation.review.inspection);
  if (
    !sameAccount(registration.account, operation.account) ||
    !sameAsset(registration.asset, operation.asset) ||
    resultInspectionDigest !== reviewInspectionDigest ||
    registration.inspectionDigest !== reviewInspectionDigest
  ) addIssue("Token registration result is invalid.");
  if (operation.kind === "register" && registration.createdAt < operation.createdAt) {
    addIssue("Token registration creation result is invalid.");
  }
};

const validateOperationSchema = <Schema extends ZodType<TokenCatalogOperation>>(schema: Schema) =>
  schema.superRefine((value, context) => {
    validateTokenCatalogOperation(value, (message) => {
      context.addIssue({ code: "custom", message });
    });
  });

export const tokenCatalogOperationSchema = validateOperationSchema(tokenCatalogOperationStructuralSchema);
export const tokenCatalogConfirmedOperationSchema = validateOperationSchema(z.union([
  operationSchemas.register.completed,
  operationSchemas.register.failed,
  operationSchemas.unregister.completed,
  operationSchemas.unregister.failed,
]));

const registrationInputSchema = z.object({ asset: erc20AssetIdentitySchema }).strict();
const registrationsInputSchema = z.object({
  limit: z.number().int().min(1).max(tokenCatalogContractLimits.listMaximumLimit).optional(),
  cursor: evmAddressSchema.optional(),
}).strict().transform((value) => ({
  limit: value.limit ?? tokenCatalogContractLimits.listDefaultLimit,
  cursor: value.cursor ?? null,
}));
const registrationsRequestSchema = z.object({
  limit: z.number().int().min(1).max(tokenCatalogContractLimits.listMaximumLimit),
  cursor: evmAddressSchema.nullable(),
}).strict();
const startRegistrationInputSchema = z.object({ asset: erc20AssetIdentitySchema }).strict();
const startUnregistrationInputSchema = z.object({
  asset: erc20AssetIdentitySchema,
  expectedRevision: tokenRegistrationRevisionSchema,
}).strict();
const operationInputSchema = z.object({ operationId: tokenCatalogOperationIdSchema }).strict();
export const tokenCatalogOperationConfirmationInputSchema = z.object({
  operationId: tokenCatalogOperationIdSchema,
  reviewDigest: hash32Schema,
}).strict();

const operationResultSchema = z.object({ operation: tokenCatalogOperationSchema }).strict();
const registrationOperationStartResultSchema = z.object({
  operation: validateOperationSchema(operationSchemas.register.awaiting_confirmation),
}).strict();
const unregistrationOperationStartResultSchema = z.object({
  operation: validateOperationSchema(operationSchemas.unregister.awaiting_confirmation),
}).strict();
const terminalOperationStructuralSchema = z.union([
  operationSchemas.register.cancelled,
  operationSchemas.register.completed,
  operationSchemas.register.expired,
  operationSchemas.register.failed,
  operationSchemas.unregister.cancelled,
  operationSchemas.unregister.completed,
  operationSchemas.unregister.expired,
  operationSchemas.unregister.failed,
]);
const terminalOperationSchema = validateOperationSchema(terminalOperationStructuralSchema);
const operationCancellationResultSchema = z.object({ operation: terminalOperationSchema }).strict();
const registrationListResultSchema = z.object({
  registrations: z.array(tokenRegistrationSchema).max(tokenCatalogContractLimits.listMaximumLimit),
  nextCursor: evmAddressSchema.nullable(),
}).strict().superRefine((value, context) => {
  for (let index = 1; index < value.registrations.length; index += 1) {
    const previous = value.registrations[index - 1];
    const current = value.registrations[index];
    if (previous !== undefined && current !== undefined &&
      previous.asset.address >= current.asset.address) {
      context.addIssue({ code: "custom", message: "Token registrations are not canonically ordered." });
      return;
    }
  }
  const first = value.registrations[0];
  if (first !== undefined && value.registrations.some((entry) =>
    entry.account.chainId !== first.account.chainId ||
    entry.account.address !== first.account.address)) {
    context.addIssue({ code: "custom", message: "Token registration page mixes accounts." });
  }
  const last = value.registrations.at(-1);
  if (value.nextCursor !== null && last?.asset.address !== value.nextCursor) {
    context.addIssue({ code: "custom", message: "Token registration cursor is invalid." });
  }
});

export type TokenRegistrationInput = z.output<typeof registrationInputSchema>;
export type TokenRegistrationListInput = z.input<typeof registrationsInputSchema>;
export type TokenRegistrationListRequest = z.output<typeof registrationsInputSchema>;
export type TokenRegistrationListResult = z.output<typeof registrationListResultSchema>;
export type TokenRegistrationStartInput = z.input<typeof startRegistrationInputSchema>;
export type TokenRegistrationStartRequest = z.output<typeof startRegistrationInputSchema>;
export type TokenUnregistrationStartInput = z.output<typeof startUnregistrationInputSchema>;
export type TokenCatalogOperationInput = z.output<typeof operationInputSchema>;
export type TokenCatalogOperationConfirmationInput = z.output<
  typeof tokenCatalogOperationConfirmationInputSchema
>;
export type TokenCatalogOperationResult = z.output<typeof operationResultSchema>;
export type TokenCatalogOperationStartResult<
  Kind extends TokenCatalogOperationKind = TokenCatalogOperationKind,
> = Readonly<{ operation: TokenCatalogAwaitingOperation<Kind> }>;
export type TokenCatalogCancellationResult = Readonly<{ operation: TokenCatalogTerminalOperation }>;

const contractFailureCodes = Object.freeze({
  registration: ["internal_error", "invalid_input", "runtime_state_unavailable", "token_registration_not_found", "wallet_not_connected", "wallet_session_unusable"],
  registrations: ["internal_error", "invalid_input", "runtime_state_unavailable", "wallet_not_connected", "wallet_session_unusable"],
  startRegistration: ["internal_error", "invalid_input", "not_found", "rate_limited", "request_aborted", "runtime_busy", "runtime_state_unavailable", "source_inconsistent", "source_unavailable", "state_conflict", "token_operation_conflict", "token_registration_already_exists", "token_total_supply_reverted", "wallet_not_connected", "wallet_session_unusable"],
  startUnregistration: ["internal_error", "invalid_input", "runtime_busy", "runtime_state_unavailable", "state_conflict", "token_operation_conflict", "token_registration_not_found", "token_registration_revision_changed", "wallet_not_connected", "wallet_session_unusable"],
  operation: ["internal_error", "invalid_input", "runtime_state_unavailable", "token_operation_not_found"],
  cancelOperation: ["internal_error", "invalid_input", "runtime_state_unavailable", "state_conflict", "token_operation_not_found"],
} as const);

const confirmationFailureCodes = Object.freeze([
  "internal_error",
  "invalid_input",
  "runtime_state_unavailable",
  "state_conflict",
  "token_operation_expired",
  "token_operation_not_found",
] as const);

export interface TokenCatalogApplicationContract<Input, Success> {
  readonly capabilityId: CapabilityId;
  readonly contractVersion: typeof coreContractVersion;
  readonly inputSchema: ZodType<Input>;
  readonly successSchema: ZodType<Success>;
  readonly failureCodes: readonly string[];
  readonly applicationContract: ApplicationContract<Input, TokenCatalogInternalContext, Success>;
  parseInput(value: unknown): Input;
  parsePublicSuccess(input: unknown, value: unknown): Success;
  parseBoundSuccess(input: unknown, context: unknown, value: unknown): Success;
  parseFailure(value: unknown): ApplicationFailure;
  normalizeFailure(value: unknown): ApplicationFailure;
}

export const tokenCatalogInternalContextSchema = z.object({
  operationId: operationIdSchema.optional(),
  interactionInterface: z.enum(tokenCatalogInteractionInterfaces).optional(),
}).strict();
export type TokenCatalogInternalContext = z.infer<typeof tokenCatalogInternalContextSchema>;

const defineApplicationContract = <Input, Success>(options: {
  readonly capabilityId: string;
  readonly inputSchema: ZodType<Input>;
  readonly requestSchema?: ZodType<Input>;
  readonly successSchema: ZodType<Success>;
  readonly failureCodes: readonly string[];
  readonly validatePublicSuccess?: (input: Input, success: Success) => void;
  readonly validateBoundSuccess?: (
    input: Input,
    context: TokenCatalogInternalContext,
    success: Success,
  ) => void;
}): TokenCatalogApplicationContract<Input, Success> => {
  const capabilityId = capabilityIdSchema.parse(options.capabilityId);
  const applicationContract = defineCanonicalApplicationContract({
    inputSchema: options.inputSchema,
    ...(options.requestSchema === undefined ? {} : { correlationInputSchema: options.requestSchema }),
    successSchema: options.successSchema,
    internalContextSchema: tokenCatalogInternalContextSchema,
    errorRegistry: tokenCatalogApplicationErrorRegistry,
    failureCodes: options.failureCodes,
    ...(options.validatePublicSuccess === undefined ? {} : {
      validatePublicSuccess: options.validatePublicSuccess,
    }),
    ...(options.validateBoundSuccess === undefined ? {} : {
      validateBoundSuccess: options.validateBoundSuccess,
    }),
  });
  return Object.freeze({
    capabilityId,
    contractVersion: coreContractVersion,
    inputSchema: options.inputSchema,
    successSchema: options.successSchema,
    failureCodes: applicationContract.failureCodes,
    applicationContract,
    parseInput: applicationContract.parseInput,
    parsePublicSuccess: applicationContract.parsePublicSuccess,
    parseBoundSuccess: applicationContract.parseBoundSuccess,
    parseFailure: applicationContract.parseFailure,
    normalizeFailure: applicationContract.normalizeFailure,
  });
};

export interface TokenCatalogOperationConfirmationContract {
  readonly contractVersion: typeof coreContractVersion;
  readonly inputSchema: typeof tokenCatalogOperationConfirmationInputSchema;
  readonly successSchema: typeof tokenCatalogConfirmedOperationSchema;
  readonly failureCodes: readonly string[];
  readonly applicationContract: ApplicationContract<
    TokenCatalogOperationConfirmationInput,
    TokenCatalogInternalContext,
    TokenCatalogConfirmedOperation
  >;
  parseInput(value: unknown): TokenCatalogOperationConfirmationInput;
  parsePublicSuccess(
    input: unknown,
    value: unknown,
  ): TokenCatalogConfirmedOperation;
  parseBoundSuccess(input: unknown, context: unknown, value: unknown): TokenCatalogConfirmedOperation;
  parseFailure(value: unknown): ApplicationFailure;
  normalizeFailure(value: unknown): ApplicationFailure;
}

const confirmationApplicationContract = defineCanonicalApplicationContract({
  inputSchema: tokenCatalogOperationConfirmationInputSchema,
  successSchema: tokenCatalogConfirmedOperationSchema,
  internalContextSchema: tokenCatalogInternalContextSchema,
  errorRegistry: tokenCatalogApplicationErrorRegistry,
  failureCodes: confirmationFailureCodes,
  validatePublicSuccess: (input, success) => {
    if (
      success.operationId !== input.operationId ||
      success.review.reviewDigest !== input.reviewDigest
    ) throw new TypeError("Token operation confirmation result does not match its input.");
  },
  validateBoundSuccess: (_input, context, success) => {
    if (
      context.operationId !== success.operationId ||
      context.interactionInterface !== success.interactionInterface
    ) throw new TypeError("Token operation confirmation result does not match its internal context.");
  },
});

export const tokenCatalogOperationConfirmationContract: TokenCatalogOperationConfirmationContract =
  Object.freeze({
    contractVersion: coreContractVersion,
    inputSchema: tokenCatalogOperationConfirmationInputSchema,
    successSchema: tokenCatalogConfirmedOperationSchema,
    failureCodes: confirmationApplicationContract.failureCodes,
    applicationContract: confirmationApplicationContract,
    parseInput: confirmationApplicationContract.parseInput,
    parsePublicSuccess: confirmationApplicationContract.parsePublicSuccess,
    parseBoundSuccess: confirmationApplicationContract.parseBoundSuccess,
    parseFailure: confirmationApplicationContract.parseFailure,
    normalizeFailure: confirmationApplicationContract.normalizeFailure,
  });

const validateOperationId = (
  input: Readonly<{ operationId: string }>,
  success: Readonly<{ operation: TokenCatalogOperation }>,
) => {
  if (input.operationId !== success.operation.operationId) throw new TypeError("Token operation identity mismatch.");
};

const validateCancelledOperation = (
  input: Readonly<{ operationId: string }>,
  success: TokenCatalogCancellationResult,
) => {
  validateOperationId(input, success);
};

const validateStartCommon = <Kind extends TokenCatalogOperationKind>(
  asset: TokenRegistration["asset"],
  success: TokenCatalogOperationStartResult<Kind>,
): TokenCatalogAwaitingOperation<Kind> => {
  if (!sameAsset(success.operation.asset, asset)) {
    throw new TypeError("Token operation start result is invalid.");
  }
  return success.operation;
};

export const tokenCatalogApplicationContracts = Object.freeze({
  registration: defineApplicationContract({
    capabilityId: "token.registration",
    inputSchema: registrationInputSchema,
    successSchema: tokenRegistrationWithInspectionSchema,
    failureCodes: contractFailureCodes.registration,
    validatePublicSuccess: (input, success) => {
      if (input.asset.chainId !== success.registration.asset.chainId || input.asset.address !== success.registration.asset.address) {
        throw new TypeError("Token registration target mismatch.");
      }
    },
  }),
  registrations: defineApplicationContract({
    capabilityId: "token.registrations",
    inputSchema: registrationsInputSchema,
    requestSchema: registrationsRequestSchema,
    successSchema: registrationListResultSchema,
    failureCodes: contractFailureCodes.registrations,
    validatePublicSuccess: (input, success) => {
      if (
        success.registrations.length > input.limit ||
        (success.nextCursor !== null && success.registrations.length !== input.limit) ||
        (input.cursor !== null && success.registrations.some(
          (entry) => entry.asset.address <= input.cursor!,
        ))
      ) throw new TypeError("Token registration page does not match its request.");
    },
  }),
  startRegistration: defineApplicationContract({
    capabilityId: "token.start_registration",
    inputSchema: startRegistrationInputSchema,
    successSchema: registrationOperationStartResultSchema,
    failureCodes: contractFailureCodes.startRegistration,
    validatePublicSuccess: (input, success) => {
      const operation = validateStartCommon(input.asset, success);
      if (operation.review.previousRegistration !== null) {
        throw new TypeError("Token registration start result is invalid.");
      }
    },
    validateBoundSuccess: (_input, context, success) => {
      if (
        context.operationId !== success.operation.operationId ||
        context.interactionInterface !== success.operation.interactionInterface
      ) throw new TypeError("Token registration start result does not match its internal context.");
    },
  }),
  startUnregistration: defineApplicationContract({
    capabilityId: "token.start_unregistration",
    inputSchema: startUnregistrationInputSchema,
    successSchema: unregistrationOperationStartResultSchema,
    failureCodes: contractFailureCodes.startUnregistration,
    validatePublicSuccess: (input, success) => {
      const operation = validateStartCommon(input.asset, success);
      if (
        operation.review.previousRegistration?.revision !== input.expectedRevision
      ) throw new TypeError("Token removal start result is invalid.");
    },
    validateBoundSuccess: (_input, context, success) => {
      if (
        context.operationId !== success.operation.operationId ||
        context.interactionInterface !== success.operation.interactionInterface
      ) throw new TypeError("Token removal start result does not match its internal context.");
    },
  }),
  operation: defineApplicationContract({
    capabilityId: "token.operation",
    inputSchema: operationInputSchema,
    successSchema: operationResultSchema,
    failureCodes: contractFailureCodes.operation,
    validatePublicSuccess: validateOperationId,
  }),
  cancelOperation: defineApplicationContract({
    capabilityId: "token.cancel_operation",
    inputSchema: operationInputSchema,
    successSchema: operationCancellationResultSchema,
    failureCodes: contractFailureCodes.cancelOperation,
    validatePublicSuccess: validateCancelledOperation,
  }),
});

export type AnyTokenCatalogApplicationContract =
  typeof tokenCatalogApplicationContracts[keyof typeof tokenCatalogApplicationContracts];

export const tokenCatalogApplicationContractList = Object.freeze(
  Object.values(tokenCatalogApplicationContracts),
);

export const tokenCatalogCurrentOperationSchema = z.object({
  operation: tokenCatalogOperationSchema.nullable(),
}).strict();

export const parseTokenOperationFailure = (value: unknown): ApplicationFailure =>
  tokenOperationFailureSchema.parse(captureCanonicalJson(value));
