import { z, type ZodType } from "zod";

import {
  assertCapabilitySuccessChainScope,
  assertContractAnalysisForTarget,
  applicationFailureSchemaFor,
  blockSelectorSchema,
  canonicalAmountSchema,
  canonicalBase64UrlSchema,
  canonicalJsonStringify,
  canonicalSha256,
  capabilityIdSchema,
  captureCanonicalJson,
  chainAnchorSchema,
  compareCodePointSequences,
  contractAnalysisSchema,
  coreContractVersion,
  coreErrorRegistry,
  createCapabilitySuccessSchema,
  createConfiguredChainEvidenceFragment,
  createContractAnalysisEvidenceConclusions,
  createContractAnalysisEvidenceDeclaration,
  createContractAnalysisEvidenceFragment,
  createEvidenceFactIdentityDeclaration,
  createEvidenceObservationTargetDeclaration,
  createEvidenceReplayBinder,
  createEvidenceReplayDefinition,
  createEvidenceReplayLayout,
  createExactConclusionIdentityDeclaration,
  defineApplicationContract as defineCanonicalApplicationContract,
  deepFreezeValue,
  defineReadCapability,
  erc20AssetIdentitySchema,
  evmAccountIdentitySchema,
  evmAddressSchema,
  jsonObject,
  hash32Schema,
  parseHash32,
  observationIdSchema,
  operationIdByteLength,
  operationIdSchema,
  readCapabilityLimits,
  replayPublicEvidence,
  staticScopeExclusionSchema,
  availableTokenTextSchema,
  tokenDisplayTextLimits,
  tokenDisplayTextSchema,
  tokenStandardObservationResultSchema,
  unavailableTokenTextSchema,
  unsignedDecimalSchema,
  utcTimestampSchema,
  type ApplicationFailure,
  type ApplicationContract,
  type CanonicalJson,
  type CapabilityId,
  type CapabilitySuccess,
  type ConclusionDraft,
  type EvidenceReplayBinder,
  type EvidenceReplayDeclaration,
  type EvidenceReplayResult,
  type EvmAccountIdentity,
  type FactRequirement,
  type ObservationExpectation,
  type ObservationReference,
  type WarningRequirement,
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
  displayTextCodePoints: tokenDisplayTextLimits.codePoints,
  displayTextUtf8Bytes: tokenDisplayTextLimits.utf8Bytes,
  selectionRevisionBytes: 16,
  operationIdBytes: operationIdByteLength,
  listDefaultLimit: 25,
  listMaximumLimit: 25,
});

export const tokenCatalogDigestVersions = Object.freeze({
  inspection: "5",
  review: "6",
} as const);

export const tokenSelectionRevisionSchema = canonicalBase64UrlSchema(
  tokenCatalogContractLimits.selectionRevisionBytes,
);
export const tokenCatalogOperationIdSchema = operationIdSchema;

const optionalTextObservationSchema = z.discriminatedUnion("status", [
  availableTokenTextSchema.extend({
    observationId: observationIdSchema,
  }),
  unavailableTokenTextSchema.extend({
    observationId: observationIdSchema,
  }),
]);

export const tokenInspectionInputSchema = z.object({
  asset: erc20AssetIdentitySchema,
  block: blockSelectorSchema,
}).strict();
export type TokenInspectionInput = z.infer<typeof tokenInspectionInputSchema>;

export const tokenInspectionDataSchema = z.object({
  asset: erc20AssetIdentitySchema,
  analysis: contractAnalysisSchema,
  totalSupply: canonicalAmountSchema,
  metadata: z.object({
    name: optionalTextObservationSchema,
    symbol: optionalTextObservationSchema,
  }).strict(),
  standards: tokenStandardObservationResultSchema,
}).strict().superRefine((data, context) => {
  try {
    assertContractAnalysisForTarget({
      chainId: data.asset.chainId,
      address: data.asset.address,
      block: data.analysis.block,
      runtimeCode: data.analysis.targetRuntimeCode,
    }, data.analysis);
  } catch {
    context.addIssue({ code: "custom", message: "Token contract analysis is inconsistent." });
  }
  if (
    data.asset.chainId !== data.analysis.block.chainId ||
    data.asset.address !== data.analysis.target ||
    data.totalSupply.asset.kind !== "erc20" ||
    data.totalSupply.asset.chainId !== data.asset.chainId ||
    data.totalSupply.asset.address !== data.asset.address ||
    data.standards.asset.chainId !== data.asset.chainId ||
    data.standards.asset.address !== data.asset.address ||
    data.standards.block.chainId !== data.analysis.block.chainId ||
    data.standards.block.blockNumber !== data.analysis.block.blockNumber ||
    data.standards.block.blockHash !== data.analysis.block.blockHash ||
    data.standards.block.blockTimestamp !== data.analysis.block.blockTimestamp ||
    data.standards.account !== undefined
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

const inspectionFailureCodes = Object.freeze([
  "internal_error",
  "invalid_input",
  "not_found",
  "rate_limited",
  "request_aborted",
  "result_too_large",
  "runtime_busy",
  "source_inconsistent",
  "source_unavailable",
  "token_total_supply_reverted",
]);

export const tokenInspectionStaticScopeExclusions = Object.freeze([
  { id: "account_balance", message: "This inspection does not read an account balance." },
  { id: "official_asset_identity", message: "This inspection does not establish official asset identity." },
  { id: "price_and_liquidity", message: "This inspection does not establish price or liquidity." },
  { id: "protocol_identity", message: "This inspection does not establish protocol identity." },
  { id: "safety", message: "This inspection does not establish token safety." },
  {
    id: "unsupported_contract_controls",
    message: "This inspection does not infer custom proxy, role, fee, blocklist, mint, or burn controls.",
  },
  { id: "transaction_support", message: "This inspection does not establish transaction support." },
].map((value) => Object.freeze(staticScopeExclusionSchema.parse(value))));

const decimalsConclusion = createExactConclusionIdentityDeclaration("decimals_observed");
const nameConclusion = createExactConclusionIdentityDeclaration("name_observed");
const symbolConclusion = createExactConclusionIdentityDeclaration("symbol_observed");
const totalSupplyConclusion =
  createExactConclusionIdentityDeclaration("total_supply_observed");
const tokenContractAnalysisConclusions = createContractAnalysisEvidenceConclusions();

const tokenInspectionReplayDefinition = createEvidenceReplayDefinition({
  capabilityId: tokenInspectCapabilityId,
  conclusions: [
    decimalsConclusion,
    nameConclusion,
    symbolConclusion,
    totalSupplyConclusion,
    tokenContractAnalysisConclusions.deploymentObserved,
    tokenContractAnalysisConclusions.sourceChecked,
    tokenContractAnalysisConclusions.controlsObserved,
  ],
  warningCodes: ["decimals_unavailable", "partial_result"],
});

const tokenConfiguredChain =
  createConfiguredChainEvidenceFragment(tokenInspectionReplayDefinition);
const tokenContractAnalysis = createContractAnalysisEvidenceFragment(
  tokenInspectionReplayDefinition,
  tokenContractAnalysisConclusions,
);
const tokenFact = (
  identity: string,
) => createEvidenceFactIdentityDeclaration(tokenInspectionReplayDefinition, identity);
const decimalsFact = tokenFact("decimals");
const nameFact = tokenFact("name");
const symbolFact = tokenFact("symbol");
const totalSupplyFact = tokenFact("total_supply");
const tokenTarget = (
  slotId: string,
  fact: FactRequirement["fact"],
  purpose: string,
  role: string,
) => createEvidenceObservationTargetDeclaration(tokenInspectionReplayDefinition, {
  slotId,
  fact,
  purpose,
  kind: "source",
  sourceClass: "chain_rpc",
  roles: { value: role },
});
const decimalsTarget = tokenTarget(
  "decimals",
  decimalsFact,
  "token_decimals",
  "token_decimals",
);
const nameTarget = tokenTarget("name", nameFact, "token_name", "token_name");
const symbolTarget = tokenTarget("symbol", symbolFact, "token_symbol", "token_symbol");
const totalSupplyTarget = tokenTarget(
  "total_supply",
  totalSupplyFact,
  "token_total_supply",
  "token_total_supply",
);

const tokenInspectionObservationTargets = Object.freeze([
  decimalsTarget,
  nameTarget,
  tokenConfiguredChain.target,
  ...Object.values(tokenContractAnalysis.targets),
  symbolTarget,
  totalSupplyTarget,
]);

export const tokenInspectionEvidence = Object.freeze({
  definition: tokenInspectionReplayDefinition,
  configuredChain: tokenConfiguredChain,
  analysis: tokenContractAnalysis,
  facts: Object.freeze({
    decimals: decimalsFact,
    name: nameFact,
    symbol: symbolFact,
    totalSupply: totalSupplyFact,
  }),
  targets: Object.freeze({
    decimals: decimalsTarget,
    name: nameTarget,
    symbol: symbolTarget,
    totalSupply: totalSupplyTarget,
  }),
  conclusions: Object.freeze({
    decimalsObserved: decimalsConclusion,
    nameObserved: nameConclusion,
    symbolObserved: symbolConclusion,
    totalSupplyObserved: totalSupplyConclusion,
  }),
  warningCodes: Object.freeze([
    "decimals_unavailable",
    "partial_result",
  ] as const),
  staticScopeExclusions: tokenInspectionStaticScopeExclusions,
});

const tokenFactRequirement = (
  fact: FactRequirement["fact"],
  outcome: FactRequirement["outcome"],
  slot: FactRequirement["observationSlots"][number],
): FactRequirement => ({
  fact,
  outcome,
  observationSlots: [slot],
  requiredObservationSlots: [slot],
  minimumObservationCount: 1,
});

const tokenConclusion = (
  conclusion: ConclusionDraft["conclusion"],
  fact: ConclusionDraft["outcomeFact"],
): ConclusionDraft => ({
  conclusion,
  outcomeFact: fact,
  evidenceFacts: [fact],
  freshnessRuleId: "chain_anchor_exact",
});

const tokenClaim = (
  role: ObservationExpectation["claims"][number]["role"],
  value: CanonicalJson,
  data: TokenInspectionData,
) => ({ role, value, asset: data.asset, chainAnchor: data.analysis.block });

const tokenExpectation = (
  slot: ObservationExpectation["slot"],
  claims: ObservationExpectation["claims"],
): ObservationExpectation => ({ slot, claims });

const optionalTokenFactOutcome = (
  observation: TokenInspectionData["metadata"]["name"],
): FactRequirement["outcome"] => observation.status === "available" ? "observed" : "source_failed";

const createTokenInspectionEvidenceDeclaration = (
  data: TokenInspectionData,
  binder: EvidenceReplayBinder,
): EvidenceReplayDeclaration => {
  if (data.totalSupply.decimals.status === "not_observed") {
    throw new TypeError("Token inspection decimals evidence is absent.");
  }
  const analysis = createContractAnalysisEvidenceDeclaration(
    data.analysis,
    tokenContractAnalysis,
    binder,
  );
  const decimals = binder.bind(decimalsTarget);
  const name = binder.bind(nameTarget);
  const chain = binder.bind(tokenConfiguredChain.target);
  const symbol = binder.bind(symbolTarget);
  const totalSupply = binder.bind(totalSupplyTarget);
  const decimalsIds = data.totalSupply.decimals.status === "available"
    ? [data.totalSupply.decimals.observationId]
    : data.totalSupply.decimals.observationIds;
  const unavailableMetadataFacts = [
    ...(data.metadata.name.status === "available" ? [] : ["name"]),
    ...(data.metadata.symbol.status === "available" ? [] : ["symbol"]),
  ];
  const analysisPartialFacts = analysis.warningRequirements
    .filter((warning) => warning.code === "partial_result")
    .flatMap((warning) => warning.facts);
  const partialFacts = [
    ...analysisPartialFacts,
    ...unavailableMetadataFacts.map((fact) => fact === "name" ? nameFact : symbolFact),
  ];
  return deepFreezeValue({
    observationExpectations: [
      tokenExpectation(decimals.slot, [tokenClaim(
        decimals.roles.value,
        data.totalSupply.decimals.status === "available"
          ? data.totalSupply.decimals.value
          : { status: "unavailable", reason: "missing" },
        data,
      )]),
      tokenExpectation(name.slot, [tokenClaim(
        name.roles.value,
        data.metadata.name.status === "available"
          ? data.metadata.name.value
          : { status: "unavailable", reason: data.metadata.name.reason },
        data,
      )]),
      tokenExpectation(chain.slot, [{
        role: chain.roles.chainId,
        value: data.asset.chainId,
        chainAnchor: data.analysis.block,
      }]),
      ...analysis.observationExpectations,
      tokenExpectation(symbol.slot, [tokenClaim(
        symbol.roles.value,
        data.metadata.symbol.status === "available"
          ? data.metadata.symbol.value
          : { status: "unavailable", reason: data.metadata.symbol.reason },
        data,
      )]),
      tokenExpectation(totalSupply.slot, [
        tokenClaim(totalSupply.roles.value, data.totalSupply.raw, data),
      ]),
    ],
    observationReferences: [
      {
        observationId: data.totalSupply.quantityObservationId,
        slot: totalSupply.slot,
        role: totalSupply.roles.value,
      },
      ...decimalsIds.map((observationId): ObservationReference => ({
        observationId,
        slot: decimals.slot,
        role: decimals.roles.value,
      })),
      {
        observationId: data.metadata.name.observationId,
        slot: name.slot,
        role: name.roles.value,
      },
      {
        observationId: data.metadata.symbol.observationId,
        slot: symbol.slot,
        role: symbol.roles.value,
      },
    ],
    factRequirements: [
      tokenFactRequirement(
        decimalsFact,
        data.totalSupply.decimals.status === "available" ? "observed" : "source_failed",
        decimals.slot,
      ),
      tokenFactRequirement(nameFact, optionalTokenFactOutcome(data.metadata.name), name.slot),
      tokenFactRequirement(
        tokenConfiguredChain.fact,
        tokenConfiguredChain.outcome,
        chain.slot,
      ),
      ...analysis.factRequirements,
      tokenFactRequirement(
        symbolFact,
        optionalTokenFactOutcome(data.metadata.symbol),
        symbol.slot,
      ),
      tokenFactRequirement(totalSupplyFact, "observed", totalSupply.slot),
    ],
    expectedConclusions: [
      decimalsConclusion,
      nameConclusion,
      symbolConclusion,
      totalSupplyConclusion,
      ...analysis.expectedConclusions,
    ],
    conclusionDrafts: [
      tokenConclusion(decimalsConclusion, decimalsFact),
      tokenConclusion(nameConclusion, nameFact),
      tokenConclusion(symbolConclusion, symbolFact),
      tokenConclusion(totalSupplyConclusion, totalSupplyFact),
      ...analysis.conclusionDrafts,
    ],
    warningRequirements: [
      ...(data.totalSupply.decimals.status === "available"
        ? []
        : [{ code: "decimals_unavailable" as const, facts: [decimalsFact] }]),
      ...(partialFacts.length === 0
        ? []
        : [{
            code: "partial_result" as const,
            facts: Object.freeze([...new Set(partialFacts)]),
          }]),
    ],
  });
};

export const tokenInspectionCapabilityEvidence = Object.freeze({
  definition: tokenInspectionReplayDefinition,
  observationTargets: () => tokenInspectionObservationTargets,
  declaration: (
    _input: TokenInspectionInput,
    data: TokenInspectionData,
    binder: EvidenceReplayBinder,
  ) => createTokenInspectionEvidenceDeclaration(data, binder),
  staticScopeExclusions: tokenInspectionStaticScopeExclusions,
});

export const tokenInspectCapability =
  defineReadCapability<TokenInspectionInput, TokenInspectionData>({
    capabilityId: tokenInspectCapabilityId,
    inputSchema: tokenInspectionInputSchema,
    dataSchema: tokenInspectionDataSchema,
    failureCodes: inspectionFailureCodes,
    evidence: tokenInspectionCapabilityEvidence,
    validateSuccess: (data, context) => {
      if (data.asset.chainId !== context.chainId) {
        throw new TypeError("Token inspection chain scope mismatch.");
      }
      assertContractAnalysisForTarget({
        chainId: data.asset.chainId,
        address: data.asset.address,
        block: data.analysis.block,
        runtimeCode: data.analysis.targetRuntimeCode,
      }, data.analysis);
    },
    validateRequest: (input, data) => {
      if (
        input.asset.chainId !== data.asset.chainId ||
        input.asset.address !== data.asset.address
      ) {
        throw new TypeError("Token inspection target mismatch.");
      }
      if (
        input.block.kind === "number" &&
        input.block.blockNumber !== data.analysis.block.blockNumber
      ) {
        throw new TypeError("Token inspection block mismatch.");
      }
    },
  });

const canonicalTokenInspectionSuccessSchema = createCapabilitySuccessSchema(
  tokenInspectCapabilityId,
  tokenInspectionDataSchema,
);

const tokenEvidenceProjection = (value: TokenInspectionSuccess): EvidenceReplayResult => {
  const layout = createEvidenceReplayLayout(
    tokenInspectionCapabilityEvidence.definition,
    tokenInspectionCapabilityEvidence.observationTargets(),
  );
  const declaration = createTokenInspectionEvidenceDeclaration(
    value.data,
    createEvidenceReplayBinder(tokenInspectionCapabilityEvidence.definition, layout),
  );
  return replayPublicEvidence({
    definition: tokenInspectionCapabilityEvidence.definition,
    layout,
    ...declaration,
    evaluatedAt: value.meta.evaluatedAt,
    sources: value.evidence.sources,
  });
};

export const tokenInspectionSuccessSchema = canonicalTokenInspectionSuccessSchema.superRefine((value, context) => {
  try {
    assertCapabilitySuccessChainScope(value);
    if (value.meta.chainId !== value.data.asset.chainId) {
      throw new TypeError("Token inspection chain scope mismatch.");
    }
    const derived = tokenEvidenceProjection(value);
    const actual = canonicalJsonStringify({
      conclusions: value.evidence.conclusions,
      coverage: value.evidence.coverage,
      warnings: value.warnings,
    } as unknown as CanonicalJson);
    if (actual !== canonicalJsonStringify(derived as unknown as CanonicalJson)) {
      throw new TypeError("Token inspection evidence does not match its declaration.");
    }
  } catch {
    context.addIssue({ code: "custom", message: "Token inspection success is invalid." });
  }
}) as ZodType<TokenInspectionSuccess>;

const sortGeneratedRequiredArrays = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortGeneratedRequiredArrays);
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    const entry = record[key];
    result[key] = key === "required" && Array.isArray(entry)
      ? [...entry].map(String).sort(compareCodePointSequences)
      : sortGeneratedRequiredArrays(entry);
  }
  return result;
};

const directTokenInspectionProjection = JSON.parse(JSON.stringify(z.toJSONSchema(
  canonicalTokenInspectionSuccessSchema,
  {
    target: "draft-2020-12",
    unrepresentable: "throw",
    io: "output",
  },
))) as Record<string, unknown>;
delete directTokenInspectionProjection["$schema"];
export const tokenInspectionSuccessProjectionSchema = deepFreezeValue(captureCanonicalJson(
  sortGeneratedRequiredArrays(directTokenInspectionProjection),
));

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
  previousSelection: z.lazy(() => tokenSelectionSchema).nullable(),
  selectionSetRevision: z.lazy(() => tokenSelectionSetRevisionSchema).nullable(),
  inspection: tokenInspectionSuccessSchema.nullable(),
  officialSnapshotRevision: canonicalBase64UrlSchema(16).nullable(),
  officialEvidence: z.lazy(() => tokenOfficialSelectionEvidenceSchema).nullable(),
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
    previousSelection: input.previousSelection as unknown as CanonicalJson,
    selectionSetRevision: input.selectionSetRevision,
    inspection: input.inspection as unknown as CanonicalJson,
    officialSnapshotRevision: input.officialSnapshotRevision,
    officialEvidence: input.officialEvidence as unknown as CanonicalJson,
    interactionInterface: input.interactionInterface,
    expiresAt: input.expiresAt,
  })}`);
};

export const tokenSelectionSchema = z.object({
  account: evmAccountIdentitySchema,
  asset: erc20AssetIdentitySchema,
  included: z.boolean(),
  revision: tokenSelectionRevisionSchema,
  createdAt: utcTimestampSchema,
  updatedAt: utcTimestampSchema,
}).strict().superRefine((value, context) => {
  if (value.account.chainId !== value.asset.chainId || value.updatedAt < value.createdAt) {
    context.addIssue({ code: "custom", message: "Token selection identity is invalid." });
  }
});
export type TokenSelection = z.infer<typeof tokenSelectionSchema>;

export const tokenSelectionSetRevisionSchema = tokenSelectionRevisionSchema.brand(
  "TokenSelectionSetRevision",
);
export type TokenSelectionSetRevision = z.infer<typeof tokenSelectionSetRevisionSchema>;

export const tokenSelectionStateSchema = z.object({
  account: evmAccountIdentitySchema,
  revision: tokenSelectionSetRevisionSchema,
  defaultsInitialized: z.boolean(),
  createdAt: utcTimestampSchema,
  updatedAt: utcTimestampSchema,
}).strict().superRefine((value, context) => {
  if (value.updatedAt < value.createdAt) {
    context.addIssue({ code: "custom", message: "Token selection state lifetime is invalid." });
  }
});
export type TokenSelectionState = z.infer<typeof tokenSelectionStateSchema>;

export const tokenOfficialSelectionEvidenceSchema = z.object({
  assetUid: hash32Schema,
  snapshotRevision: canonicalBase64UrlSchema(16),
  verificationBlock: chainAnchorSchema,
}).strict();
export type TokenOfficialSelectionEvidence = z.infer<typeof tokenOfficialSelectionEvidenceSchema>;

export const tokenSelectionDetailSchema = z.object({
  selection: tokenSelectionSchema,
  historicalInspection: tokenInspectionSuccessSchema.nullable(),
}).strict().superRefine((value, context) => {
  const inspection = value.historicalInspection;
  if (inspection !== null && (
    value.selection.asset.chainId !== inspection.data.asset.chainId ||
    value.selection.asset.address !== inspection.data.asset.address
  )) context.addIssue({ code: "custom", message: "Historical selection inspection identity is invalid." });
});
export type TokenSelectionDetail = z.infer<typeof tokenSelectionDetailSchema>;

const tokenCatalogApplicationErrorRegistry = coreErrorRegistry
  .extend(runtimeErrorDefinitions)
  .extend(walletErrorDefinitions)
  .extend(chainErrorDefinitions)
  .extend(tokenCatalogErrorDefinitions);

const operationFailureCodes = Object.freeze([
  "internal_error",
  "runtime_state_unavailable",
  "state_conflict",
  "token_selection_revision_changed",
  "wallet_not_connected",
  "wallet_session_unusable",
]);
const tokenOperationFailureSchema = applicationFailureSchemaFor(
  tokenCatalogApplicationErrorRegistry,
  operationFailureCodes,
);

const operationReviewSchema = z.object({
  previousSelection: tokenSelectionSchema.nullable(),
  selectionSetRevision: tokenSelectionSetRevisionSchema.nullable(),
  inspection: tokenInspectionSuccessSchema.nullable(),
  inspectionDigest: hash32Schema.nullable(),
  officialSnapshotRevision: canonicalBase64UrlSchema(16).nullable(),
  officialEvidence: tokenOfficialSelectionEvidenceSchema.nullable(),
  reviewDigest: hash32Schema,
}).strict();

const selectionOperationResultSchema = tokenSelectionDetailSchema;

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
  left: TokenSelection["asset"],
  right: TokenSelection["asset"],
): boolean => left.chainId === right.chainId && left.address === right.address;

const sameChainAnchor = (
  left: z.output<typeof chainAnchorSchema>,
  right: z.output<typeof chainAnchorSchema>,
): boolean =>
  left.chainId === right.chainId &&
  left.blockNumber === right.blockNumber &&
  left.blockHash === right.blockHash &&
  left.blockTimestamp === right.blockTimestamp;

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
  add: operationSchemasForKind("add", selectionOperationResultSchema),
  remove: operationSchemasForKind("remove", selectionOperationResultSchema),
} as const satisfies Record<TokenCatalogOperationKind, object>;

const tokenCatalogOperationStructuralSchema = z.union([
  operationSchemas.add.applying,
  operationSchemas.add.awaiting_confirmation,
  operationSchemas.add.cancelled,
  operationSchemas.add.completed,
  operationSchemas.add.expired,
  operationSchemas.add.failed,
  operationSchemas.remove.applying,
  operationSchemas.remove.awaiting_confirmation,
  operationSchemas.remove.cancelled,
  operationSchemas.remove.completed,
  operationSchemas.remove.expired,
  operationSchemas.remove.failed,
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
    operation.expiresAt <= operation.createdAt
  ) {
    addIssue("Token operation identity or lifetime is invalid.");
    return;
  }
  const previous = operation.review.previousSelection;
  if (previous !== null && (
    !sameAccount(previous.account, operation.account) ||
    !sameAsset(previous.asset, operation.asset)
  )) {
    addIssue("Token operation previous selection is invalid.");
  }
  if (
    (operation.kind === "add" && previous?.included === true) ||
    (operation.kind === "remove" && previous?.included !== true) ||
    (operation.kind === "add" && operation.review.inspection === null) ||
    (operation.kind === "remove" && operation.review.inspection !== null) ||
    (operation.kind === "add" && operation.review.officialSnapshotRevision === null) ||
    (operation.kind === "remove" && (
      operation.review.officialSnapshotRevision !== null ||
      operation.review.officialEvidence !== null
    )) ||
    (operation.review.officialEvidence !== null &&
      operation.review.officialEvidence.snapshotRevision !== operation.review.officialSnapshotRevision)
  ) {
    addIssue("Token operation review does not match its kind.");
  }
  const inspection = operation.review.inspection;
  const inspectionDigest = operation.review.inspectionDigest;
  if (
    (inspection === null) !== (inspectionDigest === null) ||
    (inspection !== null &&
      inspectionDigest !== tokenInspectionDigest(inspection))
  ) addIssue("Token operation inspection digest is invalid.");
  if (inspection !== null && (
    inspection.data.asset.chainId !== operation.asset.chainId ||
    inspection.data.asset.address !== operation.asset.address
  )) addIssue("Token operation inspection identity is invalid.");
  if (
    inspection !== null &&
    operation.review.officialEvidence !== null &&
    !sameChainAnchor(
      operation.review.officialEvidence.verificationBlock,
      inspection.data.analysis.block,
    )
  ) addIssue("Token operation official verification anchor is invalid.");
  if (operation.state !== "completed" || operation.result === null) return;
  if (!("selection" in operation.result)) {
    addIssue("Token selection result is invalid.");
    return;
  }
  const selection = operation.result.selection;
  if (
    !sameAccount(selection.account, operation.account) ||
    !sameAsset(selection.asset, operation.asset) ||
    selection.included !== (operation.kind === "add") ||
    selection.revision === previous?.revision ||
    selection.updatedAt < operation.createdAt ||
    (previous === null
      ? selection.createdAt < operation.createdAt
      : selection.createdAt !== previous.createdAt) ||
    (operation.kind === "add" && (
      operation.result.historicalInspection === null ||
      inspection === null ||
      tokenInspectionDigest(operation.result.historicalInspection) !== tokenInspectionDigest(inspection)
    ))
  ) addIssue("Token selection result is invalid.");
};

const validateOperationSchema = <Schema extends ZodType<TokenCatalogOperation>>(schema: Schema) =>
  schema.superRefine((value, context) => {
    validateTokenCatalogOperation(value, (message) => {
      context.addIssue({ code: "custom", message });
    });
  });

export const tokenCatalogOperationSchema = validateOperationSchema(tokenCatalogOperationStructuralSchema);
export const tokenCatalogConfirmedOperationSchema = validateOperationSchema(z.union([
  operationSchemas.add.completed,
  operationSchemas.add.failed,
  operationSchemas.remove.completed,
  operationSchemas.remove.failed,
]));

const selectionInputSchema = z.object({ asset: erc20AssetIdentitySchema }).strict();
const selectionsInputSchema = z.object({
  limit: z.number().int().min(1).max(tokenCatalogContractLimits.listMaximumLimit).optional(),
  cursor: evmAddressSchema.optional(),
}).strict().transform((value) => ({
  limit: value.limit ?? tokenCatalogContractLimits.listDefaultLimit,
  cursor: value.cursor ?? null,
}));
const selectionsRequestSchema = z.object({
  limit: z.number().int().min(1).max(tokenCatalogContractLimits.listMaximumLimit),
  cursor: evmAddressSchema.nullable(),
}).strict();
const startAdditionInputSchema = z.object({
  asset: erc20AssetIdentitySchema,
}).strict();
const startRemovalInputSchema = z.object({
  asset: erc20AssetIdentitySchema,
  expectedRevision: tokenSelectionRevisionSchema,
}).strict();
const operationInputSchema = z.object({ operationId: tokenCatalogOperationIdSchema }).strict();
export const tokenCatalogOperationConfirmationInputSchema = z.object({
  operationId: tokenCatalogOperationIdSchema,
  reviewDigest: hash32Schema,
}).strict();

const operationResultSchema = z.object({ operation: tokenCatalogOperationSchema }).strict();
const selectionOperationStartResultSchema = z.object({
  operation: validateOperationSchema(operationSchemas.add.awaiting_confirmation),
}).strict();
const removalOperationStartResultSchema = z.object({
  operation: validateOperationSchema(operationSchemas.remove.awaiting_confirmation),
}).strict();
const terminalOperationStructuralSchema = z.union([
  operationSchemas.add.cancelled,
  operationSchemas.add.completed,
  operationSchemas.add.expired,
  operationSchemas.add.failed,
  operationSchemas.remove.cancelled,
  operationSchemas.remove.completed,
  operationSchemas.remove.expired,
  operationSchemas.remove.failed,
]);
const terminalOperationSchema = validateOperationSchema(terminalOperationStructuralSchema);
const operationCancellationResultSchema = z.object({ operation: terminalOperationSchema }).strict();
const selectionListResultSchema = z.object({
  selections: z.array(tokenSelectionSchema).max(tokenCatalogContractLimits.listMaximumLimit),
  nextCursor: evmAddressSchema.nullable(),
}).strict().superRefine((value, context) => {
  for (let index = 1; index < value.selections.length; index += 1) {
    const previous = value.selections[index - 1];
    const current = value.selections[index];
    if (previous !== undefined && current !== undefined &&
      previous.asset.address >= current.asset.address) {
      context.addIssue({ code: "custom", message: "Token selections are not canonically ordered." });
      return;
    }
  }
  const first = value.selections[0];
  if (first !== undefined && value.selections.some((entry) =>
    entry.account.chainId !== first.account.chainId ||
    entry.account.address !== first.account.address)) {
    context.addIssue({ code: "custom", message: "Token selection page mixes accounts." });
  }
  const last = value.selections.at(-1);
  if (value.nextCursor !== null && last?.asset.address !== value.nextCursor) {
    context.addIssue({ code: "custom", message: "Token selection cursor is invalid." });
  }
});

export type TokenSelectionInput = z.output<typeof selectionInputSchema>;
export type TokenSelectionListInput = z.input<typeof selectionsInputSchema>;
export type TokenSelectionListRequest = z.output<typeof selectionsInputSchema>;
export type TokenSelectionListResult = z.output<typeof selectionListResultSchema>;
export type TokenAdditionStartInput = z.input<typeof startAdditionInputSchema>;
export type TokenAdditionStartRequest = z.output<typeof startAdditionInputSchema>;
export type TokenRemovalStartInput = z.output<typeof startRemovalInputSchema>;
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
  selection: ["internal_error", "invalid_input", "runtime_state_unavailable", "token_selection_not_found", "wallet_not_connected", "wallet_session_unusable"],
  selections: ["internal_error", "invalid_input", "runtime_state_unavailable", "wallet_not_connected", "wallet_session_unusable"],
  startAddition: ["internal_error", "invalid_input", "not_found", "rate_limited", "request_aborted", "runtime_busy", "runtime_state_unavailable", "source_inconsistent", "source_unavailable", "state_conflict", "token_operation_conflict", "token_selection_already_included", "token_selection_revision_changed", "token_total_supply_reverted", "wallet_not_connected", "wallet_session_unusable"],
  startRemoval: ["internal_error", "invalid_input", "runtime_busy", "runtime_state_unavailable", "state_conflict", "token_operation_conflict", "token_selection_not_found", "token_selection_not_included", "token_selection_revision_changed", "wallet_not_connected", "wallet_session_unusable"],
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
  asset: TokenSelection["asset"],
  success: TokenCatalogOperationStartResult<Kind>,
): TokenCatalogAwaitingOperation<Kind> => {
  if (!sameAsset(success.operation.asset, asset)) {
    throw new TypeError("Token operation start result is invalid.");
  }
  return success.operation;
};

export const tokenCatalogApplicationContracts = Object.freeze({
  selection: defineApplicationContract({
    capabilityId: "token.selection",
    inputSchema: selectionInputSchema,
    successSchema: tokenSelectionDetailSchema,
    failureCodes: contractFailureCodes.selection,
    validatePublicSuccess: (input, success) => {
      if (input.asset.chainId !== success.selection.asset.chainId || input.asset.address !== success.selection.asset.address) {
        throw new TypeError("Token selection target mismatch.");
      }
    },
  }),
  selections: defineApplicationContract({
    capabilityId: "token.selections",
    inputSchema: selectionsInputSchema,
    requestSchema: selectionsRequestSchema,
    successSchema: selectionListResultSchema,
    failureCodes: contractFailureCodes.selections,
    validatePublicSuccess: (input, success) => {
      if (
        success.selections.length > input.limit ||
        (success.nextCursor !== null && success.selections.length !== input.limit) ||
        (input.cursor !== null && success.selections.some(
          (entry) => entry.asset.address <= input.cursor!,
        ))
      ) throw new TypeError("Token selection page does not match its request.");
    },
  }),
  startAddition: defineApplicationContract({
    capabilityId: "token.start_addition",
    inputSchema: startAdditionInputSchema,
    successSchema: selectionOperationStartResultSchema,
    failureCodes: contractFailureCodes.startAddition,
    validatePublicSuccess: (input, success) => {
      const operation = validateStartCommon(input.asset, success);
      if (operation.review.previousSelection?.included === true) {
        throw new TypeError("Token selection start result is invalid.");
      }
    },
    validateBoundSuccess: (_input, context, success) => {
      if (
        context.operationId !== success.operation.operationId ||
        context.interactionInterface !== success.operation.interactionInterface
      ) throw new TypeError("Token selection start result does not match its internal context.");
    },
  }),
  startRemoval: defineApplicationContract({
    capabilityId: "token.start_removal",
    inputSchema: startRemovalInputSchema,
    successSchema: removalOperationStartResultSchema,
    failureCodes: contractFailureCodes.startRemoval,
    validatePublicSuccess: (input, success) => {
      const operation = validateStartCommon(input.asset, success);
      if (
        operation.review.previousSelection?.revision !== input.expectedRevision
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
