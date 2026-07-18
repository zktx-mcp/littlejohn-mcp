import { z, type ZodType } from "zod";

import {
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
  deepFreezeValue,
  defineReadCapability,
  erc20AssetIdentitySchema,
  evmAccountIdentitySchema,
  evmAddressSchema,
  getCapabilityDefinitionSnapshot,
  hash32Schema,
  isSafeSingleLineText,
  parseCapabilitySuccess,
  parseHash32,
  observationIdSchema,
  readCapabilityLimits,
  snakeCaseCodeSchema,
  unsignedDecimalSchema,
  utcTimestampSchema,
  type ApplicationFailure,
  type CanonicalJson,
  type CapabilityId,
  type CapabilitySuccess,
  type ConclusionDraft,
  type EvmAccountIdentity,
  type FactOutcome,
  type FactRequirement,
  type ObservationExpectation,
  type ObservationSlot,
  type ObservedFact,
  type StaticScopeExclusion,
} from "../core/index.js";
import { tokenCatalogErrorRegistry } from "./errors.js";
import { tokenCatalogErrorDefinitions } from "./error-definitions.js";
import {
  tokenCatalogInteractionInterfaces,
  tokenCatalogOperationKinds,
  tokenCatalogOperationStates,
  tokenRegistrationVisibilities,
  type TokenCatalogOperationKind,
  type TokenCatalogOperationState,
} from "./state.js";

const utf8Encoder = new TextEncoder();

export const tokenCatalogContractLimits = Object.freeze({
  displayTextCodePoints: 128,
  displayTextUtf8Bytes: 512,
  registrationRevisionBytes: 16,
  operationIdBytes: 32,
  listDefaultLimit: 25,
  listMaximumLimit: 25,
});

const tokenCatalogDigestVersions = Object.freeze({
  inspection: "1",
  review: "1",
} as const);

export const tokenDisplayTextSchema = z.string()
  .refine(
    (value) => codePointLength(value) <= tokenCatalogContractLimits.displayTextCodePoints,
    `Text exceeds ${tokenCatalogContractLimits.displayTextCodePoints} Unicode code points.`,
  )
  .refine(
    (value) => utf8Encoder.encode(value).byteLength <= tokenCatalogContractLimits.displayTextUtf8Bytes,
    `Text exceeds ${tokenCatalogContractLimits.displayTextUtf8Bytes} UTF-8 bytes.`,
  )
  .refine(isSafeSingleLineText, "Expected safe single-line text.");

export const tokenUserLabelSchema = tokenDisplayTextSchema.min(1);
export const tokenRegistrationRevisionSchema = canonicalBase64UrlSchema(
  tokenCatalogContractLimits.registrationRevisionBytes,
);
export const tokenCatalogOperationIdSchema = canonicalBase64UrlSchema(
  tokenCatalogContractLimits.operationIdBytes,
);

export const tokenRegistrationSettingsSchema = z.object({
  userLabel: tokenUserLabelSchema.nullable(),
  visibility: z.enum(tokenRegistrationVisibilities),
}).strict();
export type TokenRegistrationSettings = z.infer<typeof tokenRegistrationSettingsSchema>;

export const tokenRegistrationChangesSchema = z.object({
  userLabel: tokenUserLabelSchema.nullable().optional(),
  visibility: z.enum(tokenRegistrationVisibilities).optional(),
}).strict().refine(
  (value) => value.userLabel !== undefined || value.visibility !== undefined,
  "At least one token registration setting must change.",
);
export type TokenRegistrationChanges = z.infer<typeof tokenRegistrationChangesSchema>;

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
}).strict();
export type TokenInspectionData = z.infer<typeof tokenInspectionDataSchema>;

const sourceSlot = (
  slotId: string,
  factId: string,
  purpose: string,
): ObservationSlot => ({ slotId, factId, purpose, kind: "source", sourceClass: "chain_rpc" });

const requirement = (
  factId: string,
  outcome: FactOutcome,
  slotId: string,
): FactRequirement => ({
  factId,
  outcome,
  observationSlotIds: [slotId],
  requiredObservationSlotIds: [slotId],
  minimumObservationCount: 1,
});

const conclusion = (
  id: string,
  factId: string,
  _facts: ReadonlyMap<string, ObservedFact>,
): ConclusionDraft => ({
  id,
  outcomeFactId: factId,
  evidenceFactIds: [factId],
  freshnessRuleId: "chain_anchor_exact",
});

const claim = (
  role: string,
  value: CanonicalJson,
  data: TokenInspectionData,
) => ({ role, value, asset: data.asset, chainAnchor: data.block });

const expectation = (slotId: string, claims: ObservationExpectation["claims"]): ObservationExpectation => ({
  slotId,
  claims,
});

const exclusion = (id: string, message: string): StaticScopeExclusion => ({
  id: snakeCaseCodeSchema.parse(id),
  message,
});

const inspectionFailureCodes = Object.freeze([
  "internal_error",
  "invalid_input",
  "not_found",
  "rate_limited",
  "request_aborted",
  "runtime_busy",
  "source_inconsistent",
  "source_unavailable",
  "token_total_supply_reverted",
]);

const optionalFactOutcome = (
  observation: TokenInspectionData["metadata"]["name"],
): FactOutcome => observation.status === "available" ? "observed" : "source_failed";

export const tokenInspectCapability = defineReadCapability<TokenInspectionInput, TokenInspectionData>({
  capabilityId: "token.inspect",
  inputSchema: tokenInspectionInputSchema,
  dataSchema: tokenInspectionDataSchema,
  failureCodes: inspectionFailureCodes,
  conclusionIds: [
    "decimals_observed",
    "name_observed",
    "runtime_code_observed",
    "symbol_observed",
    "total_supply_observed",
  ],
  observationSlots: () => [
    sourceSlot("block", "block", "token_inspection_block"),
    sourceSlot("decimals", "decimals", "token_decimals"),
    sourceSlot("name", "name", "token_name"),
    sourceSlot("rpc_chain_id", "rpc_chain_id", "chain_id"),
    sourceSlot("runtime_code", "runtime_code", "token_runtime_code"),
    sourceSlot("symbol", "symbol", "token_symbol"),
    sourceSlot("total_supply", "total_supply", "token_total_supply"),
  ],
  observationExpectations: (_input, data) => [
    expectation("block", [{
      role: "token_inspection_block",
      value: data.block as unknown as CanonicalJson,
      chainAnchor: data.block,
    }]),
    expectation("decimals", [claim(
      "token_decimals",
      data.totalSupply.decimals.status === "available"
        ? data.totalSupply.decimals.value
        : { status: "unavailable", reason: "missing" },
      data,
    )]),
    expectation("name", [claim(
      "token_name",
      data.metadata.name.status === "available"
        ? data.metadata.name.value
        : { status: "unavailable", reason: data.metadata.name.reason },
      data,
    )]),
    expectation("rpc_chain_id", [{
      role: "chain_id",
      value: data.asset.chainId,
      chainAnchor: data.block,
    }]),
    expectation("runtime_code", [claim("token_runtime_code", data.runtimeCode as unknown as CanonicalJson, data)]),
    expectation("symbol", [claim(
      "token_symbol",
      data.metadata.symbol.status === "available"
        ? data.metadata.symbol.value
        : { status: "unavailable", reason: data.metadata.symbol.reason },
      data,
    )]),
    expectation("total_supply", [claim("token_total_supply", data.totalSupply.raw, data)]),
  ],
  factRequirements: (_input, data) => [
    requirement("block", "observed", "block"),
    requirement(
      "decimals",
      data.totalSupply.decimals.status === "available" ? "observed" : "source_failed",
      "decimals",
    ),
    requirement("name", optionalFactOutcome(data.metadata.name), "name"),
    requirement("rpc_chain_id", "observed", "rpc_chain_id"),
    requirement("runtime_code", "observed", "runtime_code"),
    requirement("symbol", optionalFactOutcome(data.metadata.symbol), "symbol"),
    requirement("total_supply", "observed", "total_supply"),
  ],
  deriveConclusions: (_input, _data, facts) => [
    conclusion("decimals_observed", "decimals", facts),
    conclusion("name_observed", "name", facts),
    conclusion("runtime_code_observed", "runtime_code", facts),
    conclusion("symbol_observed", "symbol", facts),
    conclusion("total_supply_observed", "total_supply", facts),
  ],
  deriveWarnings: (_input, data) => {
    const unavailableMetadataFacts = [
      ...(data.metadata.name.status === "available" ? [] : ["name"]),
      ...(data.metadata.symbol.status === "available" ? [] : ["symbol"]),
    ];
    return [
      ...(data.totalSupply.decimals.status === "available"
        ? []
        : [{ code: "decimals_unavailable" as const, factIds: ["decimals"] }]),
      ...(unavailableMetadataFacts.length === 0
        ? []
        : [{ code: "partial_result" as const, factIds: unavailableMetadataFacts }]),
    ];
  },
  validateIntrinsicData: (data) => {
    if (
      data.asset.chainId !== data.block.chainId ||
      data.totalSupply.asset.kind !== "erc20" ||
      data.totalSupply.asset.chainId !== data.asset.chainId ||
      data.totalSupply.asset.address !== data.asset.address ||
      data.runtimeCode.byteLength === "0"
    ) throw new TypeError("Token inspection identity is inconsistent.");
    if (data.totalSupply.decimals.status === "not_observed") {
      throw new TypeError("Token inspection must attempt decimals observation.");
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
    ) throw new TypeError("Token inspection observations are not independent.");
  },
  validateSuccess: (data, context) => {
    if (data.asset.chainId !== context.chainId) throw new TypeError("Token inspection chain scope mismatch.");
  },
  validateRequest: (input, data) => {
    if (input.asset.chainId !== data.asset.chainId || input.asset.address !== data.asset.address) {
      throw new TypeError("Token inspection target mismatch.");
    }
    if (input.block.kind === "number" && input.block.blockNumber !== data.block.blockNumber) {
      throw new TypeError("Token inspection block mismatch.");
    }
  },
  validateEvidence: (_input, data, context) => {
    const binding = (observationId: string, role: string) =>
      context.observationClaims.find((candidate) =>
        candidate.observationId === observationId && candidate.role === role);
    if (data.totalSupply.decimals.status === "not_observed") {
      throw new TypeError("Token inspection decimals evidence is absent.");
    }
    const decimalsId = data.totalSupply.decimals.status === "available"
      ? data.totalSupply.decimals.observationId
      : data.totalSupply.decimals.observationIds[0];
    if (
      binding(data.totalSupply.quantityObservationId, "token_total_supply")?.value !== data.totalSupply.raw ||
      decimalsId === undefined || binding(decimalsId, "token_decimals") === undefined ||
      binding(data.metadata.name.observationId, "token_name") === undefined ||
      binding(data.metadata.symbol.observationId, "token_symbol") === undefined
    ) throw new TypeError("Token inspection evidence binding is incomplete.");
  },
  warningCodes: ["decimals_unavailable", "partial_result"],
  staticScopeExclusions: [
    exclusion("account_balance", "This inspection does not read an account balance."),
    exclusion("official_asset_identity", "This inspection does not establish official asset identity."),
    exclusion("price_and_liquidity", "This inspection does not establish price or liquidity."),
    exclusion("protocol_identity", "This inspection does not establish protocol identity."),
    exclusion("proxy_and_controls", "This inspection does not inspect proxy or control authority."),
    exclusion("safety", "This inspection does not establish token safety."),
    exclusion("source_verification", "This inspection does not establish source verification."),
    exclusion("transaction_support", "This inspection does not establish transaction support."),
  ],
});

export type TokenInspectionSuccess = CapabilitySuccess<TokenInspectionData>;

const structuralInspectionSuccessSchema = z.fromJSONSchema(
  getCapabilityDefinitionSnapshot(tokenInspectCapability).successSchema as never,
) as ZodType<TokenInspectionSuccess>;

export const tokenInspectionSuccessSchema = structuralInspectionSuccessSchema.superRefine((value, context) => {
  try {
    parseCapabilitySuccess(tokenInspectCapability, {
      asset: value.data.asset,
      block: { kind: "number", blockNumber: value.data.block.blockNumber },
    }, value);
  } catch {
    context.addIssue({ code: "custom", message: "Token inspection success is invalid." });
  }
});

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
  proposedSettings: tokenRegistrationSettingsSchema.nullable(),
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
    proposedSettings: input.proposedSettings as unknown as CanonicalJson,
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
  userLabel: tokenUserLabelSchema.nullable(),
  visibility: z.enum(tokenRegistrationVisibilities),
  createdAt: utcTimestampSchema,
  updatedAt: utcTimestampSchema,
}).strict().superRefine((value, context) => {
  if (value.account.chainId !== value.asset.chainId || value.updatedAt < value.createdAt) {
    context.addIssue({ code: "custom", message: "Token registration identity or timestamps are invalid." });
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

const operationFailureCodes = Object.freeze([
  "internal_error",
  "runtime_state_unavailable",
  "state_conflict",
  "token_registration_revision_changed",
  "wallet_not_connected",
  "wallet_session_unusable",
]);
const tokenOperationFailureSchema = applicationFailureSchemaFor(tokenCatalogErrorRegistry, operationFailureCodes);

const operationReviewSchema = z.object({
  previousRegistration: tokenRegistrationSchema.nullable(),
  proposedSettings: tokenRegistrationSettingsSchema.nullable(),
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
  asset: erc20AssetIdentitySchema,
  review: operationReviewSchema,
} as const;

const sameAccount = (left: EvmAccountIdentity, right: EvmAccountIdentity): boolean =>
  left.chainId === right.chainId && left.address === right.address;

const sameAsset = (
  left: TokenRegistration["asset"],
  right: TokenRegistration["asset"],
): boolean => left.chainId === right.chainId && left.address === right.address;

const sameSettings = (
  left: TokenRegistrationSettings,
  right: TokenRegistrationSettings,
): boolean => left.userLabel === right.userLabel && left.visibility === right.visibility;

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
  update_registration: operationSchemasForKind("update_registration", registrationOperationResultSchema),
  unregister: operationSchemasForKind("unregister", unregistrationOperationResultSchema),
} as const satisfies Record<TokenCatalogOperationKind, object>;

const tokenCatalogOperationStructuralSchema = z.union([
  operationSchemas.register.applying,
  operationSchemas.register.awaiting_confirmation,
  operationSchemas.register.cancelled,
  operationSchemas.register.completed,
  operationSchemas.register.expired,
  operationSchemas.register.failed,
  operationSchemas.update_registration.applying,
  operationSchemas.update_registration.awaiting_confirmation,
  operationSchemas.update_registration.cancelled,
  operationSchemas.update_registration.completed,
  operationSchemas.update_registration.expired,
  operationSchemas.update_registration.failed,
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
    (operation.kind === "register" && (previous !== null || operation.review.proposedSettings === null)) ||
    (operation.kind === "update_registration" && (previous === null || operation.review.proposedSettings === null)) ||
    (operation.kind === "unregister" && (previous === null || operation.review.proposedSettings !== null))
  ) {
    addIssue("Token operation review does not match its kind.");
  }
  if (
    operation.kind === "update_registration" && previous !== null &&
    operation.review.proposedSettings !== null &&
    sameSettings(operation.review.proposedSettings, previous)
  ) {
    addIssue("Token registration update does not change its settings.");
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
  const settings = operation.review.proposedSettings;
  const resultInspectionDigest = tokenInspectionDigest(operation.result.inspection);
  const reviewInspectionDigest = tokenInspectionDigest(operation.review.inspection);
  if (
    settings === null ||
    !sameAccount(registration.account, operation.account) ||
    !sameAsset(registration.asset, operation.asset) ||
    !sameSettings(registration, settings) ||
    resultInspectionDigest !== reviewInspectionDigest ||
    registration.inspectionDigest !== reviewInspectionDigest
  ) addIssue("Token registration result is invalid.");
  if (operation.kind === "register" && (
    registration.createdAt !== registration.updatedAt ||
    registration.createdAt < operation.createdAt
  )) {
    addIssue("Token registration creation result is invalid.");
  }
  if (operation.kind === "update_registration" && (previous === null ||
    registration.createdAt !== previous.createdAt ||
    registration.updatedAt < operation.createdAt ||
    registration.revision === previous.revision ||
    registration.inspectionDigest !== previous.inspectionDigest
  )) {
    addIssue("Token registration update result is invalid.");
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
  operationSchemas.update_registration.completed,
  operationSchemas.update_registration.failed,
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
const startRegistrationInputSchema = z.object({
  asset: erc20AssetIdentitySchema,
  settings: tokenRegistrationSettingsSchema.optional(),
}).strict().transform((value) => ({
  asset: value.asset,
  settings: value.settings ?? { userLabel: null, visibility: "visible" as const },
}));
const startRegistrationRequestSchema = z.object({
  asset: erc20AssetIdentitySchema,
  settings: tokenRegistrationSettingsSchema,
}).strict();
const startUpdateInputSchema = z.object({
  asset: erc20AssetIdentitySchema,
  expectedRevision: tokenRegistrationRevisionSchema,
  changes: tokenRegistrationChangesSchema,
}).strict();
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
const registrationUpdateOperationStartResultSchema = z.object({
  operation: validateOperationSchema(operationSchemas.update_registration.awaiting_confirmation),
}).strict();
const unregistrationOperationStartResultSchema = z.object({
  operation: validateOperationSchema(operationSchemas.unregister.awaiting_confirmation),
}).strict();
const terminalOperationStructuralSchema = z.union([
  operationSchemas.register.cancelled,
  operationSchemas.register.completed,
  operationSchemas.register.expired,
  operationSchemas.register.failed,
  operationSchemas.update_registration.cancelled,
  operationSchemas.update_registration.completed,
  operationSchemas.update_registration.expired,
  operationSchemas.update_registration.failed,
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
export type TokenRegistrationUpdateStartInput = z.output<typeof startUpdateInputSchema>;
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
  startUpdate: ["internal_error", "invalid_input", "runtime_busy", "runtime_state_unavailable", "state_conflict", "token_operation_conflict", "token_registration_not_found", "token_registration_revision_changed", "wallet_not_connected", "wallet_session_unusable"],
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
  readonly failureSchema: ZodType<ApplicationFailure>;
  readonly failureCodes: readonly string[];
  parseInput(value: unknown): Input;
  parseSuccess(input: unknown, value: unknown): Success;
  parseFailure(value: unknown): ApplicationFailure;
}

const defineApplicationContract = <Input, Success>(options: {
  readonly capabilityId: string;
  readonly inputSchema: ZodType<Input>;
  readonly requestSchema?: ZodType<Input>;
  readonly successSchema: ZodType<Success>;
  readonly failureCodes: readonly string[];
  readonly validateSuccess?: (input: Input, success: Success) => void;
}): TokenCatalogApplicationContract<Input, Success> => {
  const capabilityId = capabilityIdSchema.parse(options.capabilityId);
  const failureSchema = applicationFailureSchemaFor(tokenCatalogErrorRegistry, options.failureCodes);
  return Object.freeze({
    capabilityId,
    contractVersion: coreContractVersion,
    inputSchema: options.inputSchema,
    successSchema: options.successSchema,
    failureSchema,
    failureCodes: Object.freeze([...options.failureCodes].sort()),
    parseInput(value: unknown): Input {
      return deepFreezeValue(options.inputSchema.parse(captureCanonicalJson(value)));
    },
    parseSuccess(inputValue: unknown, value: unknown): Success {
      const input = (options.requestSchema ?? options.inputSchema).parse(captureCanonicalJson(inputValue));
      const success = options.successSchema.parse(captureCanonicalJson(value));
      options.validateSuccess?.(input, success);
      return deepFreezeValue(success);
    },
    parseFailure(value: unknown): ApplicationFailure {
      return deepFreezeValue(failureSchema.parse(captureCanonicalJson(value)));
    },
  });
};

export interface TokenCatalogOperationConfirmationContract {
  readonly contractVersion: typeof coreContractVersion;
  readonly inputSchema: typeof tokenCatalogOperationConfirmationInputSchema;
  readonly successSchema: typeof tokenCatalogConfirmedOperationSchema;
  readonly failureSchema: ZodType<ApplicationFailure>;
  readonly failureCodes: readonly string[];
  parseInput(value: unknown): TokenCatalogOperationConfirmationInput;
  parseSuccess(
    input: unknown,
    value: unknown,
  ): TokenCatalogConfirmedOperation;
  parseFailure(value: unknown): ApplicationFailure;
}

const confirmationFailureSchema = applicationFailureSchemaFor(
  tokenCatalogErrorRegistry,
  confirmationFailureCodes,
);

export const tokenCatalogOperationConfirmationContract: TokenCatalogOperationConfirmationContract =
  Object.freeze({
    contractVersion: coreContractVersion,
    inputSchema: tokenCatalogOperationConfirmationInputSchema,
    successSchema: tokenCatalogConfirmedOperationSchema,
    failureSchema: confirmationFailureSchema,
    failureCodes: confirmationFailureCodes,
    parseInput(value: unknown): TokenCatalogOperationConfirmationInput {
      return deepFreezeValue(tokenCatalogOperationConfirmationInputSchema.parse(captureCanonicalJson(value)));
    },
    parseSuccess(inputValue: unknown, value: unknown): TokenCatalogConfirmedOperation {
      const input = tokenCatalogOperationConfirmationInputSchema.parse(captureCanonicalJson(inputValue));
      const success = tokenCatalogConfirmedOperationSchema.parse(captureCanonicalJson(value));
      if (
        success.operationId !== input.operationId ||
        success.review.reviewDigest !== input.reviewDigest
      ) throw new TypeError("Token operation confirmation result does not match its input.");
      return deepFreezeValue(success);
    },
    parseFailure(value: unknown): ApplicationFailure {
      return deepFreezeValue(confirmationFailureSchema.parse(captureCanonicalJson(value)));
    },
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
    validateSuccess: (input, success) => {
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
    validateSuccess: (input, success) => {
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
    requestSchema: startRegistrationRequestSchema,
    successSchema: registrationOperationStartResultSchema,
    failureCodes: contractFailureCodes.startRegistration,
    validateSuccess: (input, success) => {
      const operation = validateStartCommon(input.asset, success);
      if (
        operation.review.previousRegistration !== null ||
        operation.review.proposedSettings === null ||
        !sameSettings(operation.review.proposedSettings, input.settings)
      ) throw new TypeError("Token registration start result is invalid.");
    },
  }),
  startRegistrationUpdate: defineApplicationContract({
    capabilityId: "token.start_registration_update",
    inputSchema: startUpdateInputSchema,
    successSchema: registrationUpdateOperationStartResultSchema,
    failureCodes: contractFailureCodes.startUpdate,
    validateSuccess: (input, success) => {
      const operation = validateStartCommon(input.asset, success);
      const previous = operation.review.previousRegistration;
      const settings = operation.review.proposedSettings;
      if (previous === null || settings === null || previous.revision !== input.expectedRevision) {
        throw new TypeError("Token registration update start result is invalid.");
      }
      const expectedSettings = {
        userLabel: input.changes.userLabel === undefined ? previous.userLabel : input.changes.userLabel,
        visibility: input.changes.visibility === undefined ? previous.visibility : input.changes.visibility,
      };
      if (!sameSettings(settings, expectedSettings) || sameSettings(settings, previous)) {
        throw new TypeError("Token registration update start result is invalid.");
      }
    },
  }),
  startUnregistration: defineApplicationContract({
    capabilityId: "token.start_unregistration",
    inputSchema: startUnregistrationInputSchema,
    successSchema: unregistrationOperationStartResultSchema,
    failureCodes: contractFailureCodes.startUnregistration,
    validateSuccess: (input, success) => {
      const operation = validateStartCommon(input.asset, success);
      if (
        operation.review.proposedSettings !== null ||
        operation.review.previousRegistration?.revision !== input.expectedRevision
      ) throw new TypeError("Token removal start result is invalid.");
    },
  }),
  operation: defineApplicationContract({
    capabilityId: "token.operation",
    inputSchema: operationInputSchema,
    successSchema: operationResultSchema,
    failureCodes: contractFailureCodes.operation,
    validateSuccess: validateOperationId,
  }),
  cancelOperation: defineApplicationContract({
    capabilityId: "token.cancel_operation",
    inputSchema: operationInputSchema,
    successSchema: operationCancellationResultSchema,
    failureCodes: contractFailureCodes.cancelOperation,
    validateSuccess: validateCancelledOperation,
  }),
});

export type AnyTokenCatalogApplicationContract =
  typeof tokenCatalogApplicationContracts[keyof typeof tokenCatalogApplicationContracts];

export const tokenCatalogApplicationContractList = Object.freeze(
  Object.values(tokenCatalogApplicationContracts),
);

export const tokenCatalogCapabilityIds = Object.freeze([
  getCapabilityDefinitionSnapshot(tokenInspectCapability).capabilityId,
  ...tokenCatalogApplicationContractList.map((contract) => contract.capabilityId),
].sort());

export const tokenCatalogContractProjection = deepFreezeValue({
  contractVersion: coreContractVersion,
  inspection: getCapabilityDefinitionSnapshot(tokenInspectCapability),
  applications: tokenCatalogApplicationContractList.map((contract) => ({
    capabilityId: contract.capabilityId,
    contractVersion: contract.contractVersion,
    inputSchema: captureCanonicalJson(JSON.parse(JSON.stringify(z.toJSONSchema(contract.inputSchema, {
      target: "draft-2020-12",
      unrepresentable: "throw",
      io: "input",
    })))),
    successSchema: captureCanonicalJson(JSON.parse(JSON.stringify(z.toJSONSchema(contract.successSchema, {
      target: "draft-2020-12",
      unrepresentable: "throw",
      io: "output",
    })))),
    failureCodes: contract.failureCodes,
  })),
  operationConfirmation: {
    contractVersion: tokenCatalogOperationConfirmationContract.contractVersion,
    inputSchema: captureCanonicalJson(JSON.parse(JSON.stringify(z.toJSONSchema(
      tokenCatalogOperationConfirmationContract.inputSchema,
      { target: "draft-2020-12", unrepresentable: "throw", io: "input" },
    )))),
    successSchema: captureCanonicalJson(JSON.parse(JSON.stringify(z.toJSONSchema(
      tokenCatalogOperationConfirmationContract.successSchema,
      { target: "draft-2020-12", unrepresentable: "throw", io: "output" },
    )))),
    failureCodes: tokenCatalogOperationConfirmationContract.failureCodes,
  },
  errors: tokenCatalogErrorDefinitions,
  operationKinds: tokenCatalogOperationKinds,
  operationStates: tokenCatalogOperationStates,
  digestVersions: tokenCatalogDigestVersions,
});

export const tokenCatalogContractProjectionDigest = `0x${canonicalSha256(
  tokenCatalogContractProjection as unknown as CanonicalJson,
)}`;

export const tokenCatalogCurrentOperationSchema = z.object({
  operation: tokenCatalogOperationSchema.nullable(),
}).strict();

export const parseTokenOperationFailure = (value: unknown): ApplicationFailure =>
  tokenOperationFailureSchema.parse(captureCanonicalJson(value));
