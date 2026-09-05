import { z, type ZodType } from "zod";

import {
  assertCapabilitySuccessChainScope,
  assertContractAnalysisForTarget,
  addressTargetSchema,
  applicationFailureSchemaFor,
  blockSelectorSchema,
  canonicalAmountSchema,
  canonicalBase64UrlSchema,
  canonicalJsonStringify,
  canonicalSha256,
  capabilityIdSchema,
  captureCanonicalJson,
  chainAnchorSchema,
  closedTupleSchema,
  compareCodePointSequences,
  contractAnalysisSchema,
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
  getCapabilityDefinitionSnapshot,
  parseHash32,
  projectZodJsonSchema,
  observationIdSchema,
  operationIdSchema,
  optionalTokenTextSchema,
  readCapabilityLimits,
  replayPublicEvidence,
  staticScopeExclusionSchema,
  availableTokenTextSchema,
  tokenDisplayTextSchema,
  tokenMetadataDecimalsReadFailureReasonSchema,
  tokenStandardObservationResultSchema,
  tokenStandardOrder,
  unavailableTokenTextSchema,
  unsignedDecimalSchema,
  utcTimestampSchema,
  utf8ByteLength,
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
  type TokenMetadataDecimalsReadFailureReason,
  type TokenOptionalTextUnavailableReason,
  type TokenStandardId,
  type TokenStandardObservationStatus,
} from "../core/client.js";
import { tokenCatalogErrorRegistry } from "./error-registry.js";
import {
  officialAssetSnapshotRevisionSchema,
  type OfficialAssetSnapshotRevision,
  type OfficialAssetSourceMember,
  type OfficialAssetSourceUnavailableReason,
  type StockFactoryVerification,
  type StockFactoryClassificationUnavailableReason,
} from "../registry/client.js";
import {
  tokenCatalogInitiators,
  tokenCatalogOperationKinds,
  tokenCatalogOperationStates,
  type TokenCatalogInitiator,
  type TokenCatalogOperationKind,
  type TokenCatalogOperationState,
} from "./state.js";

export const tokenCatalogContractLimits = Object.freeze({
  selectionRevisionBytes: 16,
  listDefaultLimit: 25,
  listMaximumLimit: 25,
  directActionUtf8Bytes: 32_768,
  reviewActionMilliseconds: 300_000,
});

export const tokenCatalogDigestVersions = Object.freeze({
  inspection: "1",
  review: "1",
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
    decimalsReadFailure: tokenMetadataDecimalsReadFailureReasonSchema.nullable(),
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
  if (
    (data.metadata.decimalsReadFailure === null) !==
      (data.totalSupply.decimals.status === "available") ||
    (data.metadata.decimalsReadFailure !== null && (
      data.totalSupply.decimals.status !== "unavailable" ||
      data.totalSupply.decimals.reason !== "missing"
    ))
  ) {
    context.addIssue({
      code: "custom",
      message: "Token inspection decimals state and read outcome differ.",
    });
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
  "chain_response_unavailable",
  "internal_error",
  "invalid_input",
  "not_found",
  "rate_limited",
  "request_aborted",
  "result_too_large",
  "runtime_busy",
  "runtime_state_unavailable",
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
const tokenStandardEvidenceDefinitions = {
  erc20_read_surface: {
    conclusion: createExactConclusionIdentityDeclaration("erc20_read_surface_observed"),
    factId: "erc20_read_surface",
    slotId: "erc20_read_surface",
    role: "erc20_read_surface",
    prerequisite: null,
  },
  erc165: {
    conclusion: createExactConclusionIdentityDeclaration("erc165_status_observed"),
    factId: "erc165_status",
    slotId: "erc165_status",
    role: "erc165_status",
    prerequisite: null,
  },
  erc8056: {
    conclusion: createExactConclusionIdentityDeclaration("erc8056_status_observed"),
    factId: "erc8056_status",
    slotId: "erc8056_status",
    role: "erc8056_status",
    prerequisite: "erc165",
  },
  erc8056_pending_multiplier: {
    conclusion: createExactConclusionIdentityDeclaration(
      "erc8056_pending_multiplier_status_observed",
    ),
    factId: "erc8056_pending_multiplier_status",
    slotId: "erc8056_pending_multiplier_status",
    role: "erc8056_pending_multiplier_status",
    prerequisite: "erc165",
  },
  erc8056_conversion: {
    conclusion: createExactConclusionIdentityDeclaration("erc8056_conversion_status_observed"),
    factId: "erc8056_conversion_status",
    slotId: "erc8056_conversion_status",
    role: "erc8056_conversion_status",
    prerequisite: "erc165",
  },
  erc8056_balances: {
    conclusion: createExactConclusionIdentityDeclaration("erc8056_balances_status_observed"),
    factId: "erc8056_balances_status",
    slotId: "erc8056_balances_status",
    role: "erc8056_balances_status",
    prerequisite: "erc165",
  },
} as const satisfies Record<TokenStandardId, Readonly<{
  conclusion: ReturnType<typeof createExactConclusionIdentityDeclaration>;
  factId: string;
  slotId: string;
  role: string;
  prerequisite: TokenStandardId | null;
}>>;
const requiredErc8056ValuesConclusion =
  createExactConclusionIdentityDeclaration("erc8056_required_values_observed");
const tokenContractAnalysisConclusions = createContractAnalysisEvidenceConclusions();

const tokenInspectionReplayDefinition = createEvidenceReplayDefinition({
  capabilityId: tokenInspectCapabilityId,
  conclusions: [
    decimalsConclusion,
    nameConclusion,
    symbolConclusion,
    totalSupplyConclusion,
    ...tokenStandardOrder.map((standardId) =>
      tokenStandardEvidenceDefinitions[standardId].conclusion),
    requiredErc8056ValuesConclusion,
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

const createTokenStandardEvidenceRelation = (standardId: TokenStandardId) => {
  const definition = tokenStandardEvidenceDefinitions[standardId];
  const fact = tokenFact(definition.factId);
  return Object.freeze({
    conclusion: definition.conclusion,
    fact,
    prerequisite: definition.prerequisite,
    target: tokenTarget(
      definition.slotId,
      fact,
      definition.role,
      definition.role,
    ),
  });
};

const createTokenStandardRecord = <Value>(
  project: (standardId: TokenStandardId) => Value,
): Readonly<Record<TokenStandardId, Value>> => {
  const record = {} as Record<TokenStandardId, Value>;
  for (const standardId of tokenStandardOrder) record[standardId] = project(standardId);
  return Object.freeze(record);
};

const tokenStandardEvidenceRelations = createTokenStandardRecord(
  createTokenStandardEvidenceRelation,
);

const requiredErc8056ValuesFact = tokenFact("erc8056_required_values");
const requiredErc8056ValuesTarget = tokenTarget(
  "erc8056_required_values",
  requiredErc8056ValuesFact,
  "erc8056_required_values",
  "erc8056_required_values",
);

type TokenStandardEvidenceProjectionEntry =
  | Readonly<{
      outcome: "observed" | "source_inconsistent";
      observationValue: CanonicalJson;
    }>
  | Readonly<{
      outcome: "unsupported" | "not_observed";
      observationValue?: never;
    }>;

type RequiredErc8056EvidenceProjectionEntry =
  | Readonly<{
      outcome: "observed";
      observationValue: CanonicalJson;
    }>
  | Readonly<{
      outcome: "unsupported" | "not_observed";
      observationValue?: never;
    }>;

const requiredErc8056PrerequisiteStandardIds = Object.freeze([
  "erc165",
  "erc8056",
  "erc8056_pending_multiplier",
] as const satisfies readonly TokenStandardId[]);

const tokenStandardEvidenceClasses = {
  observed: "observed",
  supported: "observed",
  not_supported: "observed",
  inconsistent: "source_inconsistent",
  unknown: "not_observed",
} as const satisfies Record<
  TokenStandardObservationStatus,
  "observed" | "source_inconsistent" | "not_observed"
>;

export const projectTokenInspectionStandardEvidence = (
  result: TokenInspectionData["standards"],
): Readonly<{
  standards: Readonly<Record<TokenStandardId, TokenStandardEvidenceProjectionEntry>>;
  requiredErc8056: RequiredErc8056EvidenceProjectionEntry;
}> => {
  const standardsById = createTokenStandardRecord((standardId) => {
    const entry = result.standards.find((candidate) => candidate.standardId === standardId);
    if (entry === undefined) throw new TypeError("Token standard evidence projection is incomplete.");
    return entry;
  });
  const erc165 = standardsById.erc165;
  const standards = createTokenStandardRecord((standardId) => {
    const entry = standardsById[standardId];
    const evidenceClass = tokenStandardEvidenceClasses[entry.status];
    const projection: TokenStandardEvidenceProjectionEntry =
      evidenceClass === "observed"
        ? Object.freeze({
            outcome: "observed",
            observationValue: captureCanonicalJson(entry),
          })
        : evidenceClass === "source_inconsistent"
          ? Object.freeze({
              outcome: "source_inconsistent",
              observationValue: captureCanonicalJson(entry),
            })
          : standardId !== "erc165" && erc165.status === "not_supported"
            ? Object.freeze({ outcome: "unsupported" })
            : Object.freeze({ outcome: "not_observed" });
    return projection;
  });
  const requiredErc8056: RequiredErc8056EvidenceProjectionEntry =
    result.requiredErc8056 !== undefined
      ? Object.freeze({
          outcome: "observed",
          observationValue: captureCanonicalJson(result.requiredErc8056),
        })
      : requiredErc8056PrerequisiteStandardIds.some((standardId) =>
          standardsById[standardId].status === "not_supported")
        ? Object.freeze({ outcome: "unsupported" })
        : Object.freeze({ outcome: "not_observed" });
  return Object.freeze({ standards, requiredErc8056 });
};

const tokenInspectionObservationTargets = Object.freeze([
  decimalsTarget,
  nameTarget,
  tokenConfiguredChain.target,
  ...Object.values(tokenContractAnalysis.targets),
  symbolTarget,
  totalSupplyTarget,
  ...tokenStandardOrder.map((standardId) =>
    tokenStandardEvidenceRelations[standardId].target),
  requiredErc8056ValuesTarget,
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
    standards: createTokenStandardRecord((standardId) =>
      tokenStandardEvidenceRelations[standardId].fact),
    requiredErc8056: requiredErc8056ValuesFact,
  }),
  targets: Object.freeze({
    decimals: decimalsTarget,
    name: nameTarget,
    symbol: symbolTarget,
    totalSupply: totalSupplyTarget,
    standards: createTokenStandardRecord((standardId) =>
      tokenStandardEvidenceRelations[standardId].target),
    requiredErc8056: requiredErc8056ValuesTarget,
  }),
  conclusions: Object.freeze({
    decimalsObserved: decimalsConclusion,
    nameObserved: nameConclusion,
    symbolObserved: symbolConclusion,
    totalSupplyObserved: totalSupplyConclusion,
    standards: createTokenStandardRecord((standardId) =>
      tokenStandardEvidenceRelations[standardId].conclusion),
    requiredErc8056Observed: requiredErc8056ValuesConclusion,
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

const tokenNoneFactRequirement = (
  fact: FactRequirement["fact"],
  outcome: "unsupported" | "not_observed",
  slot: FactRequirement["observationSlots"][number],
): FactRequirement => ({
  fact,
  outcome,
  observationSlots: [slot],
  requiredObservationSlots: [],
  minimumObservationCount: 0,
});

const tokenConclusion = (
  conclusion: ConclusionDraft["conclusion"],
  fact: ConclusionDraft["outcomeFact"],
  evidenceFacts: readonly ConclusionDraft["outcomeFact"][] = [fact],
): ConclusionDraft => ({
  conclusion,
  outcomeFact: fact,
  evidenceFacts,
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

const optionalTokenTextFactOutcomes = {
  call_failed: "source_failed",
  malformed: "source_inconsistent",
  unsafe_text: "observed",
} as const satisfies Record<
  TokenOptionalTextUnavailableReason,
  FactRequirement["outcome"]
>;

const decimalsReadFailureFactOutcomes = {
  call_failed: "source_failed",
  malformed: "source_inconsistent",
} as const satisfies Record<
  TokenMetadataDecimalsReadFailureReason,
  FactRequirement["outcome"]
>;

const optionalTokenFactOutcome = (
  observation: TokenInspectionData["metadata"]["name"],
): FactRequirement["outcome"] => observation.status === "available"
  ? "observed"
  : optionalTokenTextFactOutcomes[observation.reason];

const decimalsFactOutcome = (
  failure: TokenInspectionData["metadata"]["decimalsReadFailure"],
): FactRequirement["outcome"] => failure === null
  ? "observed"
  : decimalsReadFailureFactOutcomes[failure];

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
  const standardProjection = projectTokenInspectionStandardEvidence(data.standards);
  const standardsById = createTokenStandardRecord((standardId) => {
    const relation = tokenStandardEvidenceRelations[standardId];
    return Object.freeze({
      standardId,
      relation,
      target: binder.bind(relation.target),
      projection: standardProjection.standards[standardId],
    });
  });
  const standards = tokenStandardOrder.map((standardId) => standardsById[standardId]);
  const requiredErc8056 = Object.freeze({
    fact: requiredErc8056ValuesFact,
    target: binder.bind(requiredErc8056ValuesTarget),
    projection: standardProjection.requiredErc8056,
  });
  const decimalsIds = data.totalSupply.decimals.status === "available"
    ? [data.totalSupply.decimals.observationId]
    : data.totalSupply.decimals.observationIds;
  const unavailableMetadataFacts = [
    ...(data.metadata.decimalsReadFailure === null ? [] : [decimalsFact]),
    ...(data.metadata.name.status !== "available" && data.metadata.name.reason !== "unsafe_text"
      ? [nameFact]
      : []),
    ...(data.metadata.symbol.status !== "available" && data.metadata.symbol.reason !== "unsafe_text"
      ? [symbolFact]
      : []),
  ];
  const analysisPartialFacts = analysis.warningRequirements
    .filter((warning) => warning.code === "partial_result")
    .flatMap((warning) => warning.facts);
  const observedStandardFact = (standardId: TokenStandardId) => {
    const entry = standardsById[standardId];
    return entry.projection.observationValue === undefined ? undefined : entry.relation.fact;
  };
  const standardSupportFacts = createTokenStandardRecord((standardId) => {
    const entry = standardsById[standardId];
    if (entry.projection.observationValue !== undefined) return [entry.relation.fact];
    const prerequisite = entry.relation.prerequisite === null
      ? undefined
      : observedStandardFact(entry.relation.prerequisite);
    return [prerequisite ?? tokenConfiguredChain.fact];
  });
  const observedRequiredSupportFacts = requiredErc8056PrerequisiteStandardIds
    .flatMap((standardId) => observedStandardFact(standardId) ?? [])
    .filter((fact, index, facts) => facts.indexOf(fact) === index);
  const requiredSupportFacts = requiredErc8056.projection.observationValue !== undefined
    ? [requiredErc8056.fact]
    : observedRequiredSupportFacts.length === 0
      ? [tokenConfiguredChain.fact]
      : observedRequiredSupportFacts;
  const unavailableStandardFacts = standards.flatMap((entry) =>
    entry.projection.outcome === "source_inconsistent" ||
      entry.projection.outcome === "not_observed"
      ? standardSupportFacts[entry.standardId]
      : []);
  if (requiredErc8056.projection.outcome === "not_observed") {
    unavailableStandardFacts.push(...requiredSupportFacts);
  }
  const partialFacts = [
    ...analysisPartialFacts,
    ...unavailableMetadataFacts,
    ...unavailableStandardFacts,
  ];
  return deepFreezeValue({
    observationExpectations: [
      tokenExpectation(decimals.slot, [tokenClaim(
        decimals.roles.value,
        data.totalSupply.decimals.status === "available"
          ? data.totalSupply.decimals.value
          : {
              status: "unavailable",
              reason: data.metadata.decimalsReadFailure,
            },
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
      ...standards.flatMap((entry) => entry.projection.observationValue === undefined
        ? []
        : [tokenExpectation(entry.target.slot, [tokenClaim(
            entry.target.roles.value,
            entry.projection.observationValue,
            data,
          )])]),
      ...(requiredErc8056.projection.observationValue === undefined
        ? []
        : [tokenExpectation(requiredErc8056.target.slot, [tokenClaim(
            requiredErc8056.target.roles.value,
            requiredErc8056.projection.observationValue,
            data,
          )])]),
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
        decimalsFactOutcome(data.metadata.decimalsReadFailure),
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
      ...standards.map((entry) => entry.projection.observationValue === undefined
        ? tokenNoneFactRequirement(
            entry.relation.fact,
            entry.projection.outcome,
            entry.target.slot,
          )
        : tokenFactRequirement(
            entry.relation.fact,
            entry.projection.outcome,
            entry.target.slot,
          )),
      ...(requiredErc8056.projection.observationValue === undefined
        ? [tokenNoneFactRequirement(
            requiredErc8056.fact,
            requiredErc8056.projection.outcome,
            requiredErc8056.target.slot,
          )]
        : [tokenFactRequirement(
            requiredErc8056.fact,
            requiredErc8056.projection.outcome,
            requiredErc8056.target.slot,
          )]),
    ],
    conclusionDrafts: [
      tokenConclusion(decimalsConclusion, decimalsFact),
      tokenConclusion(nameConclusion, nameFact),
      tokenConclusion(symbolConclusion, symbolFact),
      tokenConclusion(totalSupplyConclusion, totalSupplyFact),
      ...analysis.conclusionDrafts,
      ...standards.map((entry) => tokenConclusion(
        entry.relation.conclusion,
        entry.relation.fact,
        standardSupportFacts[entry.standardId],
      )),
      tokenConclusion(
        requiredErc8056ValuesConclusion,
        requiredErc8056.fact,
        requiredSupportFacts,
      ),
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
    contractVersion: "1",
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
  getCapabilityDefinitionSnapshot(tokenInspectCapability).contractVersion,
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

const directTokenInspectionProjection = JSON.parse(JSON.stringify(
  projectZodJsonSchema(canonicalTokenInspectionSuccessSchema, "output"),
)) as Record<string, unknown>;
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
  snapshotRevision: officialAssetSnapshotRevisionSchema,
  verificationBlock: chainAnchorSchema,
}).strict();
export type TokenOfficialSelectionEvidence = z.infer<typeof tokenOfficialSelectionEvidenceSchema>;

const tokenSelectionDetailShape = {
  selection: tokenSelectionSchema,
  historicalInspection: tokenInspectionSuccessSchema.nullable(),
} as const;

const validateTokenSelectionDetail = (
  value: Readonly<{
    selection: TokenSelection;
    historicalInspection: TokenInspectionSuccess | null;
  }>,
  context: z.core.$RefinementCtx,
): void => {
  const inspection = value.historicalInspection;
  if (inspection !== null && (
    value.selection.asset.chainId !== inspection.data.asset.chainId ||
    value.selection.asset.address !== inspection.data.asset.address
  )) context.addIssue({ code: "custom", message: "Historical selection inspection identity is invalid." });
};

export const tokenSelectionDetailSchema = z.object(tokenSelectionDetailShape)
  .strict()
  .superRefine(validateTokenSelectionDetail);
export type TokenSelectionDetail = z.infer<typeof tokenSelectionDetailSchema>;

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

const tokenInspectionWarningCodeSubsetSchema = z.union([
  z.array(z.never()).max(0),
  closedTupleSchema([z.literal("decimals_unavailable")]),
  closedTupleSchema([z.literal("partial_result")]),
  closedTupleSchema([z.literal("decimals_unavailable"), z.literal("partial_result")]),
]);

const projectTokenSelectionReviewText = (
  value: TokenInspectionData["metadata"]["name"],
): z.output<typeof optionalTokenTextSchema> => optionalTokenTextSchema.parse(
  value.status === "available"
    ? { status: value.status, value: value.value }
    : { status: value.status, reason: value.reason },
);

const tokenSelectionReviewCommonShape = {
  contractVersion: z.literal("1"),
  domain: z.literal("token_selection"),
  operationId: tokenCatalogOperationIdSchema,
  createdAt: utcTimestampSchema,
  actionExpiresAt: utcTimestampSchema,
  target: z.object({
    account: evmAccountIdentitySchema,
    asset: erc20AssetIdentitySchema,
  }).strict(),
  precondition: z.object({
    accountTarget: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("address") }).strict(),
      z.object({
        kind: z.literal("active_wallet"),
        connectionRevision: unsignedDecimalSchema,
      }).strict(),
    ]),
    previousSelection: tokenSelectionSchema.nullable(),
    selectionSetRevision: tokenSelectionSetRevisionSchema.nullable(),
  }).strict(),
} as const;

const additionReviewWithoutDigestSchema = z.object({
  ...tokenSelectionReviewCommonShape,
  kind: z.literal("add"),
  decision: z.object({
    name: optionalTokenTextSchema,
    symbol: optionalTokenTextSchema,
    officialClassification: z.enum(["official", "unlisted"]),
    warningCodes: tokenInspectionWarningCodeSubsetSchema,
  }).strict(),
  fixedEvidence: z.object({
    inspectionBlock: chainAnchorSchema,
    officialSnapshotRevision: officialAssetSnapshotRevisionSchema,
    officialEvidence: tokenOfficialSelectionEvidenceSchema.nullable(),
  }).strict(),
}).strict();

const removalReviewWithoutDigestSchema = z.object({
  ...tokenSelectionReviewCommonShape,
  kind: z.literal("remove"),
  decision: z.object({ action: z.literal("remove_selection") }).strict(),
  fixedEvidence: z.object({}).strict(),
}).strict();

const tokenSelectionReviewWithoutDigestSchema = z.discriminatedUnion("kind", [
  additionReviewWithoutDigestSchema,
  removalReviewWithoutDigestSchema,
]);
export type TokenSelectionReviewWithoutDigest = z.infer<
  typeof tokenSelectionReviewWithoutDigestSchema
>;

export const tokenSelectionReviewDigest = (inputValue: unknown) => {
  const review = tokenSelectionReviewWithoutDigestSchema.parse(captureCanonicalJson(inputValue));
  return parseHash32(`0x${canonicalSha256({
    digestKind: "token_selection_change_review",
    digestVersion: tokenCatalogDigestVersions.review,
    review: review as unknown as CanonicalJson,
  })}`);
};

const validateTokenSelectionReview = (
  review: TokenSelectionReviewWithoutDigest & { readonly reviewDigest: string },
  context: z.core.$RefinementCtx,
): void => {
  const previous = review.precondition.previousSelection;
  const expectedDigest = tokenSelectionReviewDigest(
    (({ reviewDigest: _digest, ...withoutDigest }) => withoutDigest)(review),
  );
  if (
    Date.parse(review.actionExpiresAt) - Date.parse(review.createdAt) !==
      tokenCatalogContractLimits.reviewActionMilliseconds ||
    review.target.asset.chainId !== review.target.account.chainId ||
    (previous !== null && (
      !sameAccount(previous.account, review.target.account) ||
      !sameAsset(previous.asset, review.target.asset)
    )) ||
    expectedDigest !== review.reviewDigest
  ) {
    context.addIssue({ code: "custom", message: "Token selection Review is inconsistent." });
    return;
  }
  if (review.kind === "add") {
    if (
      previous?.included === true ||
      (previous !== null && review.precondition.selectionSetRevision === null) ||
      review.fixedEvidence.inspectionBlock.chainId !== review.target.asset.chainId ||
      (review.decision.officialClassification === "official") !==
        (review.fixedEvidence.officialEvidence !== null) ||
      (review.fixedEvidence.officialEvidence !== null && (
        review.fixedEvidence.officialEvidence.snapshotRevision !==
          review.fixedEvidence.officialSnapshotRevision ||
        !sameChainAnchor(
          review.fixedEvidence.officialEvidence.verificationBlock,
          review.fixedEvidence.inspectionBlock,
        )
      ))
    ) context.addIssue({ code: "custom", message: "Token addition Review is inconsistent." });
  } else if (
    previous?.included !== true ||
    review.precondition.selectionSetRevision === null
  ) context.addIssue({ code: "custom", message: "Token removal Review is inconsistent." });
};

const additionReviewSchema = additionReviewWithoutDigestSchema.extend({
  reviewDigest: hash32Schema,
}).strict().superRefine(validateTokenSelectionReview);
const removalReviewSchema = removalReviewWithoutDigestSchema.extend({
  reviewDigest: hash32Schema,
}).strict().superRefine(validateTokenSelectionReview);

export const tokenSelectionReviewSchema = z.discriminatedUnion("kind", [
  additionReviewSchema,
  removalReviewSchema,
]);
export type TokenSelectionReview = z.infer<typeof tokenSelectionReviewSchema>;

const projectTokenInspectionReviewFacts = (inspection: TokenInspectionSuccess) => ({
  inspectionBlock: inspection.data.analysis.block,
  decision: {
    name: projectTokenSelectionReviewText(inspection.data.metadata.name),
    symbol: projectTokenSelectionReviewText(inspection.data.metadata.symbol),
    warningCodes: tokenInspectionWarningCodeSubsetSchema.parse(
      tokenInspectionEvidence.warningCodes.filter((code) =>
        inspection.warnings.some((warning) => warning.code === code)),
    ),
  },
});

export const createTokenAdditionReviewProjection = (input: Readonly<{
  inspection: TokenInspectionSuccess;
  officialSnapshotRevision: OfficialAssetSnapshotRevision;
  officialMember: OfficialAssetSourceMember | null;
  officialVerification: StockFactoryVerification | null;
}>): Readonly<{
  decision: z.infer<typeof additionReviewWithoutDigestSchema>["decision"];
  fixedEvidence: z.infer<typeof additionReviewWithoutDigestSchema>["fixedEvidence"];
}> => {
  const inspection = tokenInspectionSuccessSchema.parse(input.inspection);
  const facts = projectTokenInspectionReviewFacts(inspection);
  const member = input.officialMember;
  const verification = input.officialVerification;
  if ((member === null) !== (verification === null)) {
    throw new TypeError("Official token verification does not match its source member.");
  }
  const block = facts.inspectionBlock;
  if (member !== null && verification !== null && (
    member.contractAddress !== inspection.data.asset.address ||
    member.assetUid !== verification.assetUid ||
    member.contractAddress !== verification.contractAddress ||
    !sameChainAnchor(block, verification.block)
  )) throw new TypeError("Official token verification is inconsistent.");
  return deepFreezeValue({
    decision: {
      ...facts.decision,
      officialClassification: member === null ? "unlisted" : "official",
    },
    fixedEvidence: {
      inspectionBlock: block,
      officialSnapshotRevision: input.officialSnapshotRevision,
      officialEvidence: member === null || verification === null
        ? null
        : {
            assetUid: member.assetUid,
            snapshotRevision: input.officialSnapshotRevision,
            verificationBlock: verification.block,
          },
    },
  });
};

export const tokenSelectionReviewRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("add"),
    account: addressTargetSchema,
    asset: erc20AssetIdentitySchema,
  }).strict(),
  z.object({
    kind: z.literal("remove"),
    account: addressTargetSchema,
    asset: erc20AssetIdentitySchema,
    expectedRevision: tokenSelectionRevisionSchema,
  }).strict(),
]);
export type TokenSelectionReviewRequest = z.infer<typeof tokenSelectionReviewRequestSchema>;

export const tokenSelectionReviewResultSchema = z.object({
  review: tokenSelectionReviewSchema,
}).strict();
export type TokenSelectionReviewResult = z.infer<typeof tokenSelectionReviewResultSchema>;

export const tokenSelectionDirectActionSchema = z.object({
  review: tokenSelectionReviewSchema,
  initiatedBy: z.enum(tokenCatalogInitiators),
}).strict().superRefine((action, context) => {
  if (
    utf8ByteLength(canonicalJsonStringify(action as unknown as CanonicalJson)) >
      tokenCatalogContractLimits.directActionUtf8Bytes
  ) context.addIssue({ code: "custom", message: "Token selection action is too large." });
});
export type TokenSelectionDirectAction = z.infer<typeof tokenSelectionDirectActionSchema>;

const additionOperationSelectionDetailSchema = z.object({
  ...tokenSelectionDetailShape,
  historicalInspection: tokenInspectionSuccessSchema,
}).strict().superRefine(validateTokenSelectionDetail);

const removalOperationSelectionDetailSchema = z.object({
  ...tokenSelectionDetailShape,
  historicalInspection: z.null(),
}).strict().superRefine(validateTokenSelectionDetail);

const tokenSelectionOperationResultSchemas = Object.freeze({
  add: z.object({
    outcome: z.literal("selection_added"),
    selectionSetRevision: tokenSelectionSetRevisionSchema,
    selection: additionOperationSelectionDetailSchema,
  }).strict(),
  remove: z.object({
    outcome: z.literal("selection_removed"),
    selectionSetRevision: tokenSelectionSetRevisionSchema,
    selection: removalOperationSelectionDetailSchema,
  }).strict(),
});
export type TokenSelectionOperationResult = z.infer<
  (typeof tokenSelectionOperationResultSchemas)[keyof typeof tokenSelectionOperationResultSchemas]
>;

interface TokenSelectionOperationValidationValue {
  readonly operationId: string;
  readonly completedAt: string;
  readonly review: TokenSelectionReview;
  readonly result: TokenSelectionOperationResult;
}

const tokenSelectionOperationForKind = <Kind extends TokenCatalogOperationKind>(kind: Kind) =>
  z.object({
    contractVersion: z.literal("1"),
    domain: z.literal("token_selection"),
    operationId: tokenCatalogOperationIdSchema,
    kind: z.literal(kind),
    initiatedBy: z.enum(tokenCatalogInitiators),
    review: kind === "add" ? additionReviewSchema : removalReviewSchema,
    state: z.literal("completed"),
    completedAt: utcTimestampSchema,
    result: tokenSelectionOperationResultSchemas[kind],
  }).strict().superRefine((operationInput, context) => {
    const operation = operationInput as unknown as TokenSelectionOperationValidationValue;
    const selection = operation.result.selection.selection;
    const previous = operation.review.precondition.previousSelection;
    if (
      operation.completedAt < operation.review.createdAt ||
      operation.operationId !== operation.review.operationId ||
      !sameAccount(selection.account, operation.review.target.account) ||
      !sameAsset(selection.asset, operation.review.target.asset) ||
      selection.included !== (kind === "add") ||
      selection.revision === previous?.revision ||
      operation.result.selectionSetRevision === operation.review.precondition.selectionSetRevision ||
      selection.updatedAt !== operation.completedAt ||
      (previous === null
        ? selection.createdAt !== operation.completedAt
        : selection.createdAt !== previous.createdAt) ||
      operation.result.outcome !== (kind === "add" ? "selection_added" : "selection_removed")
    ) context.addIssue({ code: "custom", message: "Token selection operation is inconsistent." });
    if (operation.review.kind === "add") {
      // The kind-specific result schema requires the complete inspection for additions.
      const facts = projectTokenInspectionReviewFacts(operation.result.selection.historicalInspection!);
      const decision = operation.review.decision;
      if (
        !sameChainAnchor(facts.inspectionBlock, operation.review.fixedEvidence.inspectionBlock) ||
        canonicalJsonStringify(facts.decision as unknown as CanonicalJson) !==
          canonicalJsonStringify({
            name: decision.name,
            symbol: decision.symbol,
            warningCodes: decision.warningCodes,
          } as unknown as CanonicalJson)
      ) context.addIssue({ code: "custom", message: "Token selection Review differs from its inspection." });
    }
  });

const additionOperationSchema = tokenSelectionOperationForKind("add");
const removalOperationSchema = tokenSelectionOperationForKind("remove");
export const tokenCatalogOperationSchema = z.discriminatedUnion("kind", [
  additionOperationSchema,
  removalOperationSchema,
]);
export type TokenCatalogOperation = z.infer<typeof tokenCatalogOperationSchema>;
export type TokenCatalogOperationVariant<Kind extends TokenCatalogOperationKind> = Extract<
  TokenCatalogOperation,
  { readonly kind: Kind }
>;
export type TokenCatalogConfirmedOperation = TokenCatalogOperation;
export type TokenCatalogTerminalOperation = TokenCatalogOperation;

export const parseTokenSelectionReview = (value: unknown): TokenSelectionReview =>
  deepFreezeValue(tokenSelectionReviewSchema.parse(captureCanonicalJson(value)));
export const parseTokenCatalogOperation = (value: unknown): TokenCatalogOperation =>
  deepFreezeValue(tokenCatalogOperationSchema.parse(captureCanonicalJson(value)));

const selectionInputSchema = z.object({
  account: addressTargetSchema,
  asset: erc20AssetIdentitySchema,
}).strict();
const selectionsInputSchema = z.object({
  account: addressTargetSchema,
  limit: z.number().int().min(1).max(tokenCatalogContractLimits.listMaximumLimit).optional(),
  cursor: evmAddressSchema.optional(),
}).strict().transform((value) => ({
  account: value.account,
  limit: value.limit ?? tokenCatalogContractLimits.listDefaultLimit,
  cursor: value.cursor ?? null,
}));
const selectionsRequestSchema = z.object({
  account: addressTargetSchema,
  limit: z.number().int().min(1).max(tokenCatalogContractLimits.listMaximumLimit),
  cursor: evmAddressSchema.nullable(),
}).strict();
export const tokenCatalogOperationInputSchema = z.object({
  operationId: tokenCatalogOperationIdSchema,
}).strict();
const selectionListResultSchema = z.object({
  account: evmAccountIdentitySchema,
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
  if (value.selections.some((entry) =>
    entry.account.chainId !== value.account.chainId ||
    entry.account.address !== value.account.address)) {
    context.addIssue({ code: "custom", message: "Token selection page mixes accounts." });
  }
  const last = value.selections.at(-1);
  if (value.nextCursor !== null && last?.asset.address !== value.nextCursor) {
    context.addIssue({ code: "custom", message: "Token selection cursor is invalid." });
  }
});

export type TokenSelectionInput = z.output<typeof selectionInputSchema>;
export type TokenSelectionRequest = z.output<typeof selectionInputSchema>;
export type TokenSelectionListInput = z.input<typeof selectionsInputSchema>;
export type TokenSelectionListRequest = z.output<typeof selectionsInputSchema>;
export type TokenSelectionListResult = z.output<typeof selectionListResultSchema>;
export type TokenCatalogOperationInput = z.output<typeof tokenCatalogOperationInputSchema>;

const contractFailureCodes = Object.freeze({
  selection: ["internal_error", "invalid_input", "runtime_state_unavailable", "token_selection_not_found", "wallet_not_connected"],
  selections: ["internal_error", "invalid_input", "runtime_state_unavailable", "wallet_not_connected"],
  review: ["chain_response_unavailable", "factory_identity_mismatch", "internal_error", "invalid_input", "not_found", "rate_limited", "request_aborted", "result_too_large", "runtime_busy", "runtime_state_unavailable", "source_inconsistent", "source_unavailable", "state_conflict", "token_code_missing", "token_identity_mismatch", "token_selection_already_included", "token_selection_not_found", "token_selection_not_included", "token_selection_revision_changed", "token_total_supply_reverted", "wallet_not_connected"],
  addSelection: ["chain_response_unavailable", "factory_identity_mismatch", "internal_error", "invalid_input", "not_found", "rate_limited", "request_aborted", "result_too_large", "runtime_busy", "runtime_state_unavailable", "source_inconsistent", "source_unavailable", "state_conflict", "token_code_missing", "token_identity_mismatch", "token_review_expired", "token_selection_already_included", "token_selection_revision_changed", "token_total_supply_reverted"],
  removeSelection: ["internal_error", "invalid_input", "runtime_busy", "runtime_state_unavailable", "state_conflict", "token_review_expired", "token_selection_not_found", "token_selection_not_included", "token_selection_revision_changed"],
  operation: ["internal_error", "invalid_input", "runtime_state_unavailable", "token_operation_not_found"],
} as const);

const tokenAdditionExternalFailuresAreComplete: Exclude<
  StockFactoryClassificationUnavailableReason,
  (typeof contractFailureCodes.review)[number] | (typeof contractFailureCodes.addSelection)[number]
> extends never ? true : never = true;

if (!tokenAdditionExternalFailuresAreComplete) {
  throw new TypeError("Token addition external failure contract is incomplete.");
}

export interface TokenCatalogApplicationContract<Input, Success> {
  readonly capabilityId: CapabilityId;
  readonly contractVersion: "1";
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
}).strict();
export type TokenCatalogInternalContext = z.infer<typeof tokenCatalogInternalContextSchema>;

const defineApplicationContract = <Input, Success>(options: {
  readonly capabilityId: string;
  readonly contractVersion: "1";
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
    contractVersion: options.contractVersion,
    inputSchema: options.inputSchema,
    ...(options.requestSchema === undefined ? {} : { correlationInputSchema: options.requestSchema }),
    successSchema: options.successSchema,
    internalContextSchema: tokenCatalogInternalContextSchema,
    errorRegistry: tokenCatalogErrorRegistry,
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
    contractVersion: applicationContract.contractVersion,
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

type TokenSelectionActionForKind<Kind extends TokenCatalogOperationKind> =
  TokenSelectionDirectAction & {
    readonly review: Extract<TokenSelectionReview, { readonly kind: Kind }>;
  };

const actionSchemaForKind = <Kind extends TokenCatalogOperationKind>(kind: Kind) =>
  tokenSelectionDirectActionSchema.refine(
    (action): action is TokenSelectionActionForKind<Kind> => action.review.kind === kind,
    `Token selection action must carry a ${kind} Review.`,
  ) as ZodType<TokenSelectionActionForKind<Kind>>;

const operationSchemaForKind = <Kind extends TokenCatalogOperationKind>(kind: Kind) =>
  tokenCatalogOperationSchema.refine(
    (operation): operation is TokenCatalogOperationVariant<Kind> => operation.kind === kind,
    `Token selection operation must be ${kind}.`,
  ) as ZodType<TokenCatalogOperationVariant<Kind>>;

const validateActionOperation = <Kind extends TokenCatalogOperationKind>(
  input: TokenSelectionActionForKind<Kind>,
  success: TokenCatalogOperationVariant<Kind>,
): void => {
  if (
    success.operationId !== input.review.operationId ||
    success.review.reviewDigest !== input.review.reviewDigest ||
    canonicalJsonStringify(success.review as unknown as CanonicalJson) !==
      canonicalJsonStringify(input.review as unknown as CanonicalJson)
  ) throw new TypeError("Token selection operation does not match its action.");
};

export const tokenCatalogApplicationContracts = Object.freeze({
  selection: defineApplicationContract({
    capabilityId: "token.selection",
    contractVersion: "1",
    inputSchema: selectionInputSchema,
    successSchema: tokenSelectionDetailSchema,
    failureCodes: contractFailureCodes.selection,
    validatePublicSuccess: (input, success) => {
      if (
        input.asset.chainId !== success.selection.asset.chainId ||
        input.asset.address !== success.selection.asset.address ||
        (input.account.kind === "address" &&
          input.account.address !== success.selection.account.address)
      ) {
        throw new TypeError("Token selection target mismatch.");
      }
    },
  }),
  selections: defineApplicationContract({
    capabilityId: "token.selections",
    contractVersion: "1",
    inputSchema: selectionsInputSchema,
    requestSchema: selectionsRequestSchema,
    successSchema: selectionListResultSchema,
    failureCodes: contractFailureCodes.selections,
    validatePublicSuccess: (input, success) => {
      if (
        (input.account.kind === "address" &&
          input.account.address !== success.account.address) ||
        success.selections.length > input.limit ||
        (success.nextCursor !== null && success.selections.length !== input.limit) ||
        (input.cursor !== null && success.selections.some(
          (entry) => entry.asset.address <= input.cursor!,
        ))
      ) throw new TypeError("Token selection page does not match its request.");
    },
  }),
  selectionChangeReview: defineApplicationContract({
    capabilityId: "token.selection_change_review",
    contractVersion: "1",
    inputSchema: tokenSelectionReviewRequestSchema,
    successSchema: tokenSelectionReviewResultSchema,
    failureCodes: contractFailureCodes.review,
    validatePublicSuccess: (input, success) => {
      if (
        success.review.kind !== input.kind ||
        success.review.precondition.accountTarget.kind !== input.account.kind ||
        (input.account.kind === "address" &&
          input.account.address !== success.review.target.account.address) ||
        !sameAsset(success.review.target.asset, input.asset) ||
        (input.kind === "remove" &&
          success.review.precondition.previousSelection?.revision !== input.expectedRevision)
      ) throw new TypeError("Token selection Review does not match its request.");
    },
  }),
  addSelection: defineApplicationContract({
    capabilityId: "token.add_selection",
    contractVersion: "1",
    inputSchema: actionSchemaForKind("add"),
    successSchema: operationSchemaForKind("add"),
    failureCodes: contractFailureCodes.addSelection,
    validatePublicSuccess: validateActionOperation,
  }),
  removeSelection: defineApplicationContract({
    capabilityId: "token.remove_selection",
    contractVersion: "1",
    inputSchema: actionSchemaForKind("remove"),
    successSchema: operationSchemaForKind("remove"),
    failureCodes: contractFailureCodes.removeSelection,
    validatePublicSuccess: validateActionOperation,
  }),
  operation: defineApplicationContract({
    capabilityId: "token.operation",
    contractVersion: "1",
    inputSchema: tokenCatalogOperationInputSchema,
    successSchema: tokenCatalogOperationSchema,
    failureCodes: contractFailureCodes.operation,
    validatePublicSuccess: (input, success) => {
      if (input.operationId !== success.operationId) {
        throw new TypeError("Token selection operation identity mismatch.");
      }
    },
  }),
});

export type AnyTokenCatalogApplicationContract =
  typeof tokenCatalogApplicationContracts[keyof typeof tokenCatalogApplicationContracts];

export const tokenCatalogApplicationContractList = Object.freeze(
  Object.values(tokenCatalogApplicationContracts),
);
