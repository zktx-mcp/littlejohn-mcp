import { z, type ZodType } from "zod";

import {
  accountBalanceDataSchema,
  accountBalanceInputSchema,
  assertAccountBalancePublicSuccess,
  applicationFailureSchemaFor,
  canonicalBase64UrlSchema,
  capabilityIdSchema,
  canonicalJsonStringify,
  captureCanonicalJson,
  chainAnchorSchema,
  compareCodePointSequences,
  conclusionSchema,
  coreContractVersion,
  coverageSchema,
  createEvidenceSummary,
  createCapabilitySuccessSchema,
  defineApplicationContract,
  erc20AssetIdentitySchema,
  evidenceSourceSchema,
  evmAccountIdentitySchema,
  evmAddressSchema,
  evmChainIdSchema,
  fixedIdentifierSchema,
  generalSingleLineTextSchema,
  invocationIdSchema,
  jsonObject,
  observationIdSchema,
  snakeCaseCodeSchema,
  sourceReferenceSchema,
  staticScopeExclusionSchema,
  sourceClassSchema,
  utcTimestampSchema,
  utf8ByteLength,
  warningSchema,
  type AccountBalanceData,
  type AccountBalanceInput,
  type ApplicationContract,
  type ApplicationFailure,
  type CapabilitySuccess,
  type EvidenceSource,
  type SourceReference,
} from "../core/browser.js";
import {
  tokenDisplayTextSchema,
  tokenInspectionStaticScopeExclusions,
  tokenInspectCapabilityId,
  tokenRegistrationSchema,
  type TokenInspectionSuccess,
  type TokenRegistration,
} from "../token-catalog/browser.js";
import { accountAssetErrorRegistry } from "./error-registry.js";

export const accountAssetLimits = Object.freeze({
  defaultPageSize: 5,
  maximumPageSize: 5,
});

export const accountBalanceCapabilityId = capabilityIdSchema.parse("account.balance");
export type AccountBalanceSuccess = CapabilitySuccess<AccountBalanceData>;

export const accountBalanceSuccessSchema = createCapabilitySuccessSchema(
  accountBalanceCapabilityId,
  accountBalanceDataSchema,
) as ZodType<AccountBalanceSuccess>;

const rpcSourceIdSchema = z.string()
  .regex(
    /^rpc:[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u,
    "Expected a canonical configured RPC source identifier.",
  );
const rpcDigestSchema = canonicalBase64UrlSchema(32);
const configuredRpcReferenceSchema = jsonObject({
  kind: z.literal("configured_rpc"),
  sourceId: rpcSourceIdSchema,
  publicOrigin: z.string().refine(
    (value) => utf8ByteLength(value) <= 4_096,
    "Configured RPC public origin exceeds the runtime configuration limit.",
  ),
  configurationDigest: rpcDigestSchema,
}).strict().superRefine((value, context) => {
  if (value.sourceId !== `rpc:${value.configurationDigest}`) {
    context.addIssue({ code: "custom", message: "RPC source identity does not match its digest." });
  }
  if (!sourceReferenceSchema.safeParse(value).success) {
    context.addIssue({ code: "custom", message: "Configured RPC source reference is invalid." });
  }
});
const validatedInputReferenceSchema = jsonObject({
  kind: z.literal("validated_input"),
  sourceId: z.literal("input:account.balance"),
}).strict();

export const accountAssetSourceReferenceSchema = z.discriminatedUnion("kind", [
  configuredRpcReferenceSchema,
  validatedInputReferenceSchema,
]);
export type AccountAssetSourceReference = z.infer<typeof accountAssetSourceReferenceSchema>;

export const accountAssetEvidenceSourceSchema = jsonObject({
  observationId: observationIdSchema,
  invocationId: invocationIdSchema,
  sourceClass: sourceClassSchema,
  owner: generalSingleLineTextSchema,
  purpose: snakeCaseCodeSchema,
  observedAt: utcTimestampSchema,
  sourceId: z.union([rpcSourceIdSchema, fixedIdentifierSchema]),
  chainAnchor: chainAnchorSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.sourceClass === "chain_rpc") {
    if (!rpcSourceIdSchema.safeParse(value.sourceId).success ||
      (value.owner !== "Robinhood" && value.owner !== "user_configured")) {
      context.addIssue({ code: "custom", message: "Account asset RPC evidence source is invalid." });
    }
    return;
  }
  if (
    value.sourceClass !== "validated_input" ||
    value.sourceId !== "input:account.balance" ||
    value.chainAnchor !== undefined
  ) context.addIssue({ code: "custom", message: "Account asset input evidence source is invalid." });
});
export type AccountAssetEvidenceSource = z.infer<typeof accountAssetEvidenceSourceSchema>;

const optionalMetadataObservationSchema = z.discriminatedUnion("status", [
  jsonObject({
    status: z.literal("available"),
    value: tokenDisplayTextSchema,
    observationId: observationIdSchema,
  }).strict(),
  jsonObject({
    status: z.literal("unavailable"),
    reason: z.enum(["call_failed", "malformed", "unsafe_text"]),
    observationId: observationIdSchema,
  }).strict(),
]);

const metadataEvidenceSchema = jsonObject({
  observation: optionalMetadataObservationSchema,
  source: accountAssetEvidenceSourceSchema,
  conclusion: conclusionSchema,
}).strict();

export const accountAssetMetadataSchema = jsonObject({
  evaluatedAt: utcTimestampSchema,
  block: chainAnchorSchema,
  name: metadataEvidenceSchema,
  symbol: metadataEvidenceSchema,
  coverage: coverageSchema,
  warnings: z.array(warningSchema).max(64),
}).strict().superRefine((value, context) => {
  for (const [field, conclusionId, purpose] of [
    [value.name, "name_observed", "token_name"],
    [value.symbol, "symbol_observed", "token_symbol"],
  ] as const) {
    if (
      field.source.observationId !== field.observation.observationId ||
      field.source.purpose !== purpose ||
      canonicalJsonStringify(field.source.chainAnchor ?? null) !== canonicalJsonStringify(value.block) ||
      field.source.sourceClass !== "chain_rpc" ||
      field.conclusion.id !== conclusionId ||
      field.conclusion.observationIds.length !== 1 ||
      field.conclusion.observationIds[0] !== field.observation.observationId ||
      field.conclusion.freshness.ruleId !== "chain_anchor_exact" ||
      field.conclusion.freshness.evaluatedAt !== value.evaluatedAt ||
      field.source.observedAt > value.evaluatedAt ||
      field.conclusion.reason !== (field.observation.status === "available" ? "observed" : "source_failed")
    ) {
      context.addIssue({ code: "custom", message: "Account asset metadata evidence is invalid." });
    }
  }
  if (
    value.name.source.invocationId !== value.symbol.source.invocationId ||
    value.name.source.sourceId !== value.symbol.source.sourceId
  ) context.addIssue({ code: "custom", message: "Account asset metadata sources are inconsistent." });
  const unavailableObservationIds = [value.name, value.symbol]
    .filter((field) => field.observation.status === "unavailable")
    .map((field) => field.observation.observationId)
    .sort(compareCodePointSequences);
  const expectedSummary = createEvidenceSummary(
    [value.name.conclusion, value.symbol.conclusion],
    unavailableObservationIds.length === 0
      ? []
      : [{ code: "partial_result", observationIds: unavailableObservationIds }],
  );
  if (
    canonicalJsonStringify(captureCanonicalJson(value.coverage)) !==
      canonicalJsonStringify(captureCanonicalJson(expectedSummary.coverage)) ||
    canonicalJsonStringify(captureCanonicalJson(value.warnings)) !==
      canonicalJsonStringify(captureCanonicalJson(expectedSummary.warnings))
  ) context.addIssue({ code: "custom", message: "Account asset metadata summary is invalid." });
});
export type AccountAssetMetadata = z.infer<typeof accountAssetMetadataSchema>;

export const accountAssetEntrySchema = jsonObject({
  registration: tokenRegistrationSchema,
  metadata: accountAssetMetadataSchema,
}).strict().superRefine((value, context) => {
  if (value.registration.asset.chainId !== value.metadata.block.chainId) {
    context.addIssue({ code: "custom", message: "Account asset metadata chain is invalid." });
  }
});
export type AccountAssetEntry = z.infer<typeof accountAssetEntrySchema>;

const metadataAuthoritySchema = jsonObject({
  capabilityId: z.literal(tokenInspectCapabilityId),
  contractVersion: z.literal(coreContractVersion),
  scopeExclusions: z.array(staticScopeExclusionSchema)
    .length(tokenInspectionStaticScopeExclusions.length),
}).strict().superRefine((value, context) => {
  if (canonicalJsonStringify(captureCanonicalJson(value.scopeExclusions)) !==
    canonicalJsonStringify(captureCanonicalJson(tokenInspectionStaticScopeExclusions))) {
    context.addIssue({ code: "custom", message: "Account asset metadata authority is invalid." });
  }
});

export const accountAssetMetadataAuthority = metadataAuthoritySchema.parse({
  capabilityId: tokenInspectCapabilityId,
  contractVersion: coreContractVersion,
  scopeExclusions: [...tokenInspectionStaticScopeExclusions],
});

export const accountAssetBalanceFailureCodes = Object.freeze([
  "rate_limited",
  "source_inconsistent",
  "source_unavailable",
] as const);

const balanceFailureSchema = applicationFailureSchemaFor(
  accountAssetErrorRegistry,
  accountAssetBalanceFailureCodes,
).superRefine((failure, context) => {
  if (failure.error.issues.length !== 0) {
    context.addIssue({ code: "custom", message: "Account asset source failure cannot contain field issues." });
  }
});

export const accountBalanceSnapshotSchema = jsonObject({
  ok: z.literal(true),
  meta: jsonObject({
    capabilityId: z.literal(accountBalanceCapabilityId),
    contractVersion: z.literal(coreContractVersion),
    chainId: evmChainIdSchema,
    evaluatedAt: utcTimestampSchema,
  }).strict(),
  data: accountBalanceDataSchema,
  evidence: jsonObject({
    sources: z.array(accountAssetEvidenceSourceSchema).max(128),
    conclusions: z.array(conclusionSchema).max(64),
    coverage: coverageSchema,
  }).strict(),
  warnings: z.array(warningSchema).max(64),
}).strict();
export type AccountBalanceSnapshot = z.infer<typeof accountBalanceSnapshotSchema>;

export const accountAssetBalanceSchema = z.discriminatedUnion("status", [
  jsonObject({ status: z.literal("available"), snapshot: accountBalanceSnapshotSchema }).strict(),
  jsonObject({ status: z.literal("unavailable"), failure: balanceFailureSchema }).strict(),
]);
export type AccountAssetBalance = z.infer<typeof accountAssetBalanceSchema>;

const accountAssetSourceReferencesSchema = z.array(accountAssetSourceReferenceSchema)
  .max(7)
  .superRefine((references, context) => {
    for (let index = 1; index < references.length; index += 1) {
      if (compareCodePointSequences(
        references[index - 1]?.sourceId ?? "",
        references[index]?.sourceId ?? "",
      ) >= 0) {
        context.addIssue({ code: "custom", message: "Account asset source references must be unique and ordered." });
        return;
      }
    }
  });

const collectionInputSchema = jsonObject({
  limit: z.number().int().min(1).max(accountAssetLimits.maximumPageSize).optional(),
  cursor: evmAddressSchema.optional(),
}).strict().transform((value) => ({
  limit: value.limit ?? accountAssetLimits.defaultPageSize,
  cursor: value.cursor ?? null,
}));
const collectionRequestSchema = jsonObject({
  limit: z.number().int().min(1).max(accountAssetLimits.maximumPageSize),
  cursor: evmAddressSchema.nullable(),
}).strict();
const exactInputSchema = jsonObject({ asset: erc20AssetIdentitySchema }).strict();

const rehydrateEvidenceSource = (
  source: AccountAssetEvidenceSource,
  references: ReadonlyMap<string, AccountAssetSourceReference>,
  usedReferences: Set<string>,
): EvidenceSource => {
  const reference = references.get(source.sourceId);
  if (reference === undefined) throw new TypeError("Account asset source reference is missing.");
  usedReferences.add(source.sourceId);
  const { sourceId: _sourceId, ...details } = source;
  return evidenceSourceSchema.parse({
    ...details,
    reference: sourceReferenceSchema.parse(reference),
  });
};

const assertAccountAssetEvidence = (value: Readonly<{
  account: z.infer<typeof evmAccountIdentitySchema>;
  sourceReferences: readonly AccountAssetSourceReference[];
  assets: readonly AccountAssetEntry[];
  balance: AccountAssetBalance;
}>, includeNative: boolean): void => {
  const references = new Map(value.sourceReferences.map((reference) => [reference.sourceId, reference]));
  if (references.size !== value.sourceReferences.length) {
    throw new TypeError("Account asset source references are duplicated.");
  }
  const usedReferences = new Set<string>();
  for (const asset of value.assets) {
    rehydrateEvidenceSource(asset.metadata.name.source, references, usedReferences);
    rehydrateEvidenceSource(asset.metadata.symbol.source, references, usedReferences);
  }
  if (value.balance.status === "available") {
    const snapshot = value.balance.snapshot;
    const success = accountBalanceSuccessSchema.parse({
      ...snapshot,
      evidence: {
        ...snapshot.evidence,
        sources: snapshot.evidence.sources.map((source) =>
          rehydrateEvidenceSource(source, references, usedReferences)),
      },
    });
    const input = accountBalanceInputSchema.parse({
      account: { kind: "address", address: value.account.address },
      includeNative,
      tokens: value.assets.map((asset) => asset.registration.asset.address),
      block: { kind: "latest" },
    }) as AccountBalanceInput;
    assertAccountBalancePublicSuccess(input, success);
    const tokenCount = value.assets.length;
    const maximumSources = 3 + tokenCount * 2 + (includeNative ? 1 : 0);
    const maximumConclusions = 1 + tokenCount + (includeNative ? 1 : 0);
    const maximumWarnings = tokenCount + (includeNative ? 1 : 0);
    if (
      snapshot.evidence.sources.length > maximumSources ||
      snapshot.evidence.conclusions.length > maximumConclusions ||
      snapshot.warnings.length > maximumWarnings ||
      snapshot.evidence.conclusions.some((conclusion) => conclusion.observationIds.length > 2) ||
      snapshot.warnings.some((warning) => warning.observationIds.length > 2) ||
      snapshot.evidence.coverage.established.length +
        snapshot.evidence.coverage.notApplicable.length +
        snapshot.evidence.coverage.unavailable.length > maximumConclusions
    ) throw new TypeError("Account asset balance evidence exceeds its canonical process bounds.");
  }
  if (
    usedReferences.size !== references.size ||
    [...references.keys()].some((sourceId) => !usedReferences.has(sourceId))
  ) throw new TypeError("Account asset source references contain an unused entry.");
};

const collectionSuccessSchema = jsonObject({
  account: evmAccountIdentitySchema,
  metadataAuthority: metadataAuthoritySchema,
  sourceReferences: accountAssetSourceReferencesSchema,
  assets: z.array(accountAssetEntrySchema).max(accountAssetLimits.maximumPageSize),
  nextCursor: evmAddressSchema.nullable(),
  balance: accountAssetBalanceSchema,
}).strict().superRefine((value, context) => {
  const addresses = value.assets.map((entry) => entry.registration.asset.address);
  if (
    value.assets.some((entry) =>
      entry.registration.account.chainId !== value.account.chainId ||
      entry.registration.account.address !== value.account.address) ||
    addresses.some((address, index) => index > 0 && addresses[index - 1]! >= address) ||
    (value.nextCursor !== null && value.nextCursor !== addresses.at(-1))
  ) {
    context.addIssue({ code: "custom", message: "Account asset collection identity is invalid." });
  }
  try { assertAccountAssetEvidence(value, true); }
  catch { context.addIssue({ code: "custom", message: "Account asset collection evidence is invalid." }); }
  if (value.balance.status !== "available") return;
  const snapshot = value.balance.snapshot;
  if (
    snapshot.data.account !== value.account.address ||
    snapshot.meta.chainId !== value.account.chainId ||
    snapshot.data.native.status !== "available" ||
    snapshot.data.tokens.length !== addresses.length ||
    snapshot.data.tokens.some((entry, index) =>
      entry.asset.chainId !== value.account.chainId || entry.asset.address !== addresses[index])
  ) context.addIssue({ code: "custom", message: "Account asset collection balance is invalid." });
});

const exactSuccessSchema = jsonObject({
  account: evmAccountIdentitySchema,
  metadataAuthority: metadataAuthoritySchema,
  sourceReferences: accountAssetSourceReferencesSchema,
  asset: accountAssetEntrySchema,
  balance: accountAssetBalanceSchema,
}).strict().superRefine((value, context) => {
  const registration = value.asset.registration;
  if (
    registration.account.chainId !== value.account.chainId ||
    registration.account.address !== value.account.address
  ) context.addIssue({ code: "custom", message: "Account asset identity is invalid." });
  if (value.balance.status !== "available") {
    try { assertAccountAssetEvidence({ ...value, assets: [value.asset] }, false); }
    catch { context.addIssue({ code: "custom", message: "Exact account asset evidence is invalid." }); }
    return;
  }
  const snapshot = value.balance.snapshot;
  if (
    snapshot.data.account !== value.account.address ||
    snapshot.meta.chainId !== value.account.chainId ||
    snapshot.data.native.status !== "not_requested" ||
    snapshot.data.tokens.length !== 1 ||
    snapshot.data.tokens[0]?.asset.chainId !== registration.asset.chainId ||
    snapshot.data.tokens[0]?.asset.address !== registration.asset.address
  ) context.addIssue({ code: "custom", message: "Exact account asset balance is invalid." });
  try { assertAccountAssetEvidence({ ...value, assets: [value.asset] }, false); }
  catch { context.addIssue({ code: "custom", message: "Exact account asset evidence is invalid." }); }
});

export type AccountAssetCollectionInput = z.input<typeof collectionInputSchema>;
export type AccountAssetCollectionRequest = z.output<typeof collectionInputSchema>;
export type AccountAssetCollectionSuccess = z.output<typeof collectionSuccessSchema>;
export type AccountAssetExactInput = z.output<typeof exactInputSchema>;
export type AccountAssetExactSuccess = z.output<typeof exactSuccessSchema>;

type MetadataEvidenceWithReference<Field extends AccountAssetMetadata["name"]> =
  Omit<Field, "source"> & Readonly<{ source: EvidenceSource }>;

export type AccountAssetEntryWithReferences = Readonly<{
  registration: TokenRegistration;
  metadata: Omit<AccountAssetMetadata, "name" | "symbol"> & Readonly<{
    name: MetadataEvidenceWithReference<AccountAssetMetadata["name"]>;
    symbol: MetadataEvidenceWithReference<AccountAssetMetadata["symbol"]>;
  }>;
}>;

export type AccountAssetBalanceWithReferences =
  | Readonly<{ status: "available"; snapshot: AccountBalanceSuccess }>
  | Readonly<{ status: "unavailable"; failure: ApplicationFailure }>;

const createSourceProjection = () => {
  const references = new Map<string, AccountAssetSourceReference>();
  const project = (sourceInput: EvidenceSource): AccountAssetEvidenceSource => {
    const source = evidenceSourceSchema.parse(sourceInput);
    const reference = accountAssetSourceReferenceSchema.parse(source.reference);
    const prior = references.get(reference.sourceId);
    if (prior !== undefined && canonicalJsonStringify(captureCanonicalJson(prior)) !==
      canonicalJsonStringify(captureCanonicalJson(reference))) {
      throw new TypeError("Account asset source identity is conflicting.");
    }
    references.set(reference.sourceId, reference);
    const { reference: _reference, ...details } = source;
    return accountAssetEvidenceSourceSchema.parse({ ...details, sourceId: reference.sourceId });
  };
  const finish = (): readonly AccountAssetSourceReference[] => Object.freeze(
    [...references.values()].sort((left, right) => compareCodePointSequences(left.sourceId, right.sourceId)),
  );
  return Object.freeze({ project, finish });
};

const projectEntrySources = (
  entry: AccountAssetEntryWithReferences,
  project: (source: EvidenceSource) => AccountAssetEvidenceSource,
): AccountAssetEntry => ({
  registration: entry.registration,
  metadata: {
    ...entry.metadata,
    name: { ...entry.metadata.name, source: project(entry.metadata.name.source) },
    symbol: { ...entry.metadata.symbol, source: project(entry.metadata.symbol.source) },
  },
});

const projectBalanceSources = (
  balance: AccountAssetBalanceWithReferences,
  project: (source: EvidenceSource) => AccountAssetEvidenceSource,
): AccountAssetBalance => balance.status === "unavailable"
  ? balance
  : {
      status: "available",
      snapshot: {
        ...balance.snapshot,
        evidence: {
        ...balance.snapshot.evidence,
        sources: balance.snapshot.evidence.sources.map(project),
          conclusions: [...balance.snapshot.evidence.conclusions],
          coverage: {
            ...balance.snapshot.evidence.coverage,
            established: [...balance.snapshot.evidence.coverage.established],
            notApplicable: [...balance.snapshot.evidence.coverage.notApplicable],
            unavailable: [...balance.snapshot.evidence.coverage.unavailable],
          },
        },
        warnings: [...balance.snapshot.warnings],
      },
    };

export const projectAccountAssetCollectionSuccess = (value: Readonly<{
  account: z.infer<typeof evmAccountIdentitySchema>;
  metadataAuthority: typeof accountAssetMetadataAuthority;
  assets: readonly AccountAssetEntryWithReferences[];
  nextCursor: z.infer<typeof evmAddressSchema> | null;
  balance: AccountAssetBalanceWithReferences;
}>): AccountAssetCollectionSuccess => {
  const sources = createSourceProjection();
  const assets = value.assets.map((entry) => projectEntrySources(entry, sources.project));
  const balance = projectBalanceSources(value.balance, sources.project);
  return collectionSuccessSchema.parse({
    account: value.account,
    metadataAuthority: value.metadataAuthority,
    sourceReferences: sources.finish(),
    assets,
    nextCursor: value.nextCursor,
    balance,
  });
};

export const projectAccountAssetExactSuccess = (value: Readonly<{
  account: z.infer<typeof evmAccountIdentitySchema>;
  metadataAuthority: typeof accountAssetMetadataAuthority;
  asset: AccountAssetEntryWithReferences;
  balance: AccountAssetBalanceWithReferences;
}>): AccountAssetExactSuccess => {
  const sources = createSourceProjection();
  const asset = projectEntrySources(value.asset, sources.project);
  const balance = projectBalanceSources(value.balance, sources.project);
  return exactSuccessSchema.parse({
    account: value.account,
    metadataAuthority: value.metadataAuthority,
    sourceReferences: sources.finish(),
    asset,
    balance,
  });
};

const wholeRequestFailureCodes = Object.freeze([
  "internal_error",
  "invalid_input",
  "port_conflict",
  "request_aborted",
  "runtime_busy",
  "runtime_state_unavailable",
  "state_conflict",
  "wallet_not_connected",
  "wallet_session_unusable",
]);
const noInternalContextSchema = jsonObject({}).strict();

export interface AccountAssetApplicationContract<Input, Success> {
  readonly capabilityId: ReturnType<typeof capabilityIdSchema.parse>;
  readonly applicationContract: ApplicationContract<Input, Record<string, never>, Success>;
  readonly inputSchema: ZodType<Input>;
  readonly successSchema: ZodType<Success>;
  readonly failureCodes: readonly string[];
  parseInput(value: unknown): Input;
  parsePublicSuccess(input: unknown, value: unknown): Success;
  parseFailure(value: unknown): ApplicationFailure;
  normalizeFailure(value: unknown): ApplicationFailure;
}

const defineAccountAssetContract = <Input, Success>(options: Readonly<{
  capabilityId: "account.assets" | "account.asset";
  inputSchema: ZodType<Input>;
  correlationInputSchema?: ZodType<Input>;
  successSchema: ZodType<Success>;
  failureCodes: readonly string[];
  validatePublicSuccess: (input: Input, success: Success) => void;
}>): AccountAssetApplicationContract<Input, Success> => {
  const capabilityId = capabilityIdSchema.parse(options.capabilityId);
  const applicationContract = defineApplicationContract({
    inputSchema: options.inputSchema,
    ...(options.correlationInputSchema === undefined
      ? {}
      : { correlationInputSchema: options.correlationInputSchema }),
    successSchema: options.successSchema,
    internalContextSchema: noInternalContextSchema,
    errorRegistry: accountAssetErrorRegistry,
    failureCodes: options.failureCodes,
    validatePublicSuccess: options.validatePublicSuccess,
  });
  return Object.freeze({
    capabilityId,
    applicationContract,
    inputSchema: options.inputSchema,
    successSchema: options.successSchema,
    failureCodes: applicationContract.failureCodes,
    parseInput: applicationContract.parseInput,
    parsePublicSuccess: applicationContract.parsePublicSuccess,
    parseFailure: applicationContract.parseFailure,
    normalizeFailure: applicationContract.normalizeFailure,
  });
};

export const accountAssetApplicationContracts = Object.freeze({
  collection: defineAccountAssetContract({
    capabilityId: "account.assets",
    inputSchema: collectionInputSchema,
    correlationInputSchema: collectionRequestSchema,
    successSchema: collectionSuccessSchema,
    failureCodes: wholeRequestFailureCodes,
    validatePublicSuccess: (input, success) => {
      if (
        success.assets.length > input.limit ||
        (success.nextCursor !== null && success.assets.length !== input.limit) ||
        (input.cursor !== null && success.assets.some(
          (entry) => entry.registration.asset.address <= input.cursor!,
        ))
      ) throw new TypeError("Account asset collection does not match its request.");
    },
  }),
  exact: defineAccountAssetContract({
    capabilityId: "account.asset",
    inputSchema: exactInputSchema,
    successSchema: exactSuccessSchema,
    failureCodes: [...wholeRequestFailureCodes, "token_registration_not_found"],
    validatePublicSuccess: (input, success) => {
      if (
        input.asset.chainId !== success.asset.registration.asset.chainId ||
        input.asset.address !== success.asset.registration.asset.address
      ) throw new TypeError("Exact account asset result does not match its request.");
    },
  }),
});

export type AnyAccountAssetApplicationContract =
  (typeof accountAssetApplicationContracts)[keyof typeof accountAssetApplicationContracts];

export const accountAssetCapabilityIds = Object.freeze(
  Object.values(accountAssetApplicationContracts).map((contract) => contract.capabilityId).sort(),
);

export type { TokenInspectionSuccess, TokenRegistration };
