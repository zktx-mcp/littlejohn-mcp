import { readCapabilityLimits } from "./capability-contract.js";
import {
  createContractAnalysisChainClaims,
  createContractAnalysisSourceClaim,
  type ContractAnalysis,
} from "./contract-analysis.js";
import {
  createEvidenceClaimRoleDeclaration,
  createEvidenceConclusionSetDeclaration,
  createEvidenceDeclarationScope,
  createEvidenceFactIdentityDeclaration,
  createEvidenceFactIdentityForConclusion,
  createEvidenceObservationTargetDeclaration,
  createEvidenceReplayDefinition,
  createEvmAddressConclusionIdentity,
  createEvmAddressConclusionIdentityDeclaration,
  createExactConclusionIdentityDeclaration,
  readEvidenceReplayCapabilityId,
  type EvidenceClaimRoleDeclaration,
  type ConclusionDraft,
  type EvidenceFactIdentityDeclaration,
  type EvidenceObservationTargetDeclaration,
  type EvidenceReplayBinder,
  type EvidenceReplayDeclaration,
  type EvidenceReplayDefinition,
  type ExactConclusionIdentityDeclaration,
  type FactRequirement,
  type ObservationExpectation,
  type WarningRequirement,
} from "./evidence-replay.js";
import {
  staticScopeExclusionSchema,
  type FactOutcome,
  type Freshness,
  type StaticScopeExclusion,
} from "./evidence.js";
import { productDisplayName } from "./product-identity.js";
import {
  createPrimitiveSchemaSet,
  type EvmAddress,
} from "./primitives.js";

const evidencePrimitives = createPrimitiveSchemaSet();

const exclusion = (id: string, message: string): StaticScopeExclusion =>
  Object.freeze(staticScopeExclusionSchema.parse({ id, message })) as StaticScopeExclusion;

const exactConclusion = (identity: string): ExactConclusionIdentityDeclaration =>
  createExactConclusionIdentityDeclaration(identity);

export interface ConfiguredChainEvidenceFragment {
  readonly fact: EvidenceFactIdentityDeclaration;
  readonly target: EvidenceObservationTargetDeclaration<{
    readonly chainId: EvidenceClaimRoleDeclaration;
  }>;
  readonly outcome: FactOutcome;
  readonly freshnessRuleId: Freshness["ruleId"];
}

export const createConfiguredChainEvidenceFragment = (
  definition: EvidenceReplayDefinition,
): ConfiguredChainEvidenceFragment => {
  const fact = createEvidenceFactIdentityDeclaration(definition, "rpc_chain_id");
  return Object.freeze({
    fact,
    target: createEvidenceObservationTargetDeclaration(definition, {
      slotId: "rpc_chain_id",
      fact,
      kind: "source",
      purpose: "chain_id",
      sourceClass: "chain_rpc",
      roles: { chainId: "chain_id" },
    }),
    outcome: "observed",
    freshnessRuleId: "chain_anchor_exact",
  });
};

export interface ValidatedInputEvidenceFragment {
  readonly fact: EvidenceFactIdentityDeclaration;
  readonly target: EvidenceObservationTargetDeclaration<{
    readonly input: EvidenceClaimRoleDeclaration;
  }>;
  readonly outcome: FactOutcome;
  readonly freshnessRuleId: Freshness["ruleId"];
}

export const createValidatedInputEvidenceFragment = (
  definition: EvidenceReplayDefinition,
  input: Readonly<{
    factId: string;
    slotId: string;
    purpose: string;
    roleId: string;
  }>,
): ValidatedInputEvidenceFragment => {
  const capabilityId = readEvidenceReplayCapabilityId(definition);
  const fact = createEvidenceFactIdentityDeclaration(definition, input.factId);
  return Object.freeze({
    fact,
    target: createEvidenceObservationTargetDeclaration(definition, {
      slotId: input.slotId,
      fact,
      kind: "validated_input",
      purpose: input.purpose,
      owner: `${productDisplayName} validated input`,
      sourceId: `input:${capabilityId}`,
      roles: { input: input.roleId },
    }),
    outcome: "validated_input",
    freshnessRuleId: "validated_input_current",
  });
};

export interface ContractAnalysisEvidenceConclusions {
  readonly deploymentObserved: ExactConclusionIdentityDeclaration;
  readonly sourceChecked: ExactConclusionIdentityDeclaration;
  readonly controlsObserved: ExactConclusionIdentityDeclaration;
}

export const createContractAnalysisEvidenceConclusions =
  (): ContractAnalysisEvidenceConclusions => Object.freeze({
    deploymentObserved: exactConclusion("contract_deployment_observed"),
    sourceChecked: exactConclusion("contract_source_checked"),
    controlsObserved: exactConclusion("contract_controls_observed"),
  });

export interface ContractAnalysisEvidenceFragment {
  readonly definition: EvidenceReplayDefinition;
  readonly facts: Readonly<{
    readonly deployment: EvidenceFactIdentityDeclaration;
    readonly controls: EvidenceFactIdentityDeclaration;
    readonly targetSource: EvidenceFactIdentityDeclaration;
    readonly implementationSource: EvidenceFactIdentityDeclaration;
  }>;
  readonly targets: Readonly<{
    readonly deployment: EvidenceObservationTargetDeclaration<{
      readonly value: EvidenceClaimRoleDeclaration;
    }>;
    readonly controls: EvidenceObservationTargetDeclaration<{
      readonly value: EvidenceClaimRoleDeclaration;
    }>;
    readonly targetSource: EvidenceObservationTargetDeclaration<{
      readonly value: EvidenceClaimRoleDeclaration;
    }>;
    readonly implementationSource: EvidenceObservationTargetDeclaration<{
      readonly value: EvidenceClaimRoleDeclaration;
    }>;
  }>;
  readonly conclusions: ContractAnalysisEvidenceConclusions;
}

export type ContractAnalysisEvidenceTargets = Pick<
  ContractAnalysisEvidenceFragment,
  "targets"
>;

export const createContractAnalysisEvidenceFragment = (
  definition: EvidenceReplayDefinition,
  conclusions: ContractAnalysisEvidenceConclusions,
): ContractAnalysisEvidenceFragment => {
  const deployment = createEvidenceFactIdentityDeclaration(
    definition,
    "contract_deployment",
  );
  const controls = createEvidenceFactIdentityDeclaration(
    definition,
    "contract_controls",
  );
  const targetSource = createEvidenceFactIdentityDeclaration(
    definition,
    "contract_source_target",
  );
  const implementationSource = createEvidenceFactIdentityDeclaration(
    definition,
    "contract_source_implementation",
  );
  return Object.freeze({
    definition,
    facts: Object.freeze({
      deployment,
      controls,
      targetSource,
      implementationSource,
    }),
    targets: Object.freeze({
      deployment: createEvidenceObservationTargetDeclaration(definition, {
        slotId: "contract_deployment",
        fact: deployment,
        kind: "source",
        purpose: "contract_deployment",
        sourceClass: "chain_rpc",
        roles: { value: "contract_deployment" },
      }),
      controls: createEvidenceObservationTargetDeclaration(definition, {
        slotId: "contract_controls",
        fact: controls,
        kind: "source",
        purpose: "contract_controls",
        sourceClass: "chain_rpc",
        roles: { value: "contract_controls" },
      }),
      targetSource: createEvidenceObservationTargetDeclaration(definition, {
        slotId: "contract_source_target",
        fact: targetSource,
        kind: "source",
        purpose: "contract_source_target",
        sourceClass: "contract_verification_service",
        roles: { value: "contract_source_target" },
      }),
      implementationSource: createEvidenceObservationTargetDeclaration(definition, {
        slotId: "contract_source_implementation",
        fact: implementationSource,
        kind: "source",
        purpose: "contract_source_implementation",
        sourceClass: "contract_verification_service",
        roles: { value: "contract_source_implementation" },
      }),
    }),
    conclusions,
  });
};

const contractAnalysisFactRequirement = (
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

const contractAnalysisNoneFactRequirement = (
  fact: FactRequirement["fact"],
  outcome: "not_observed" | "not_present",
  slot: FactRequirement["observationSlots"][number],
): FactRequirement => ({
  fact,
  outcome,
  observationSlots: [slot],
  requiredObservationSlots: [],
  minimumObservationCount: 0,
});

const contractAnalysisConclusion = (
  conclusion: ExactConclusionIdentityDeclaration,
  fact: FactRequirement["fact"],
  freshnessRuleId: Freshness["ruleId"],
  evidenceFacts: readonly FactRequirement["fact"][] = [fact],
): Readonly<{
  readonly conclusion: ExactConclusionIdentityDeclaration;
  readonly outcomeFact: FactRequirement["fact"];
  readonly evidenceFacts: readonly FactRequirement["fact"][];
  readonly freshnessRuleId: Freshness["ruleId"];
}> => ({
  conclusion,
  outcomeFact: fact,
  evidenceFacts,
  freshnessRuleId,
});

const contractSourceOutcome = (
  status: ContractAnalysis["sources"][number]["status"],
): FactRequirement["outcome"] =>
  status === "exact_match"
    ? "observed"
    : status === "inconsistent"
      ? "source_inconsistent"
      : "source_failed";

export const createContractAnalysisEvidenceDeclaration = (
  analysis: ContractAnalysis,
  fragment: ContractAnalysisEvidenceFragment,
  binder: EvidenceReplayBinder,
): EvidenceReplayDeclaration => {
  const details = contractAnalysisEvidenceFacts(analysis, fragment, binder);
  const sourceConclusion = contractAnalysisConclusion(
    fragment.conclusions.sourceChecked,
    details.sourceConclusionFact,
    "contract_source_at_chain_anchor",
  );
  return Object.freeze({
    ...details.declaration,
    conclusionDrafts: Object.freeze([
      contractAnalysisConclusion(
        fragment.conclusions.deploymentObserved,
        fragment.facts.deployment,
        "chain_anchor_exact",
      ),
      sourceConclusion,
      details.controlsConclusion,
    ]),
  });
};

export type ContractAnalysisEvidenceFactsDeclaration = Pick<
  EvidenceReplayDeclaration,
  | "observationExpectations"
  | "observationReferences"
  | "factRequirements"
  | "warningRequirements"
>;

const contractAnalysisEvidenceFacts = (
  analysis: ContractAnalysis,
  fragment: ContractAnalysisEvidenceFragment,
  binder: EvidenceReplayBinder,
): Readonly<{
  readonly declaration: ContractAnalysisEvidenceFactsDeclaration;
  readonly sourceConclusionFact: FactRequirement["fact"];
  readonly controlsConclusion: ConclusionDraft;
}> => {
  const deployment = binder.bind(fragment.targets.deployment);
  const controls = binder.bind(fragment.targets.controls);
  const targetSource = binder.bind(fragment.targets.targetSource);
  const implementationSource = binder.bind(fragment.targets.implementationSource);
  const chainClaims = createContractAnalysisChainClaims(analysis);
  const implementation = analysis.sources.find((source) =>
    source.role === "implementation");
  const effectiveSource = analysis.proxy.status === "resolved"
    ? implementation
    : analysis.sources[0];
  if (effectiveSource === undefined) {
    throw new TypeError("Contract analysis effective source is absent.");
  }
  const controlUnavailable = Object.values(analysis.controls).some((control) =>
    control.status === "unavailable");
  const partialFacts = [
    ...(analysis.proxy.status === "unresolved" ? [fragment.facts.deployment] : []),
    ...analysis.sources
      .filter((source) => source.status !== "exact_match")
      .map((source) => source.role === "target"
        ? fragment.facts.targetSource
        : fragment.facts.implementationSource),
    ...(controlUnavailable && chainClaims.controlResults !== undefined
      ? [fragment.facts.controls]
      : []),
  ];
  const sourceConclusionFact = effectiveSource.role === "target"
    ? fragment.facts.targetSource
    : fragment.facts.implementationSource;
  const absentControlsOutcome =
    effectiveSource.status === "exact_match" && analysis.proxy.status !== "unresolved"
      ? "not_present"
      : "not_observed";
  const controlsConclusion = chainClaims.controlResults !== undefined
    ? contractAnalysisConclusion(
        fragment.conclusions.controlsObserved,
        fragment.facts.controls,
        "chain_anchor_exact",
      )
    : analysis.proxy.status === "unresolved"
      ? contractAnalysisConclusion(
          fragment.conclusions.controlsObserved,
          fragment.facts.controls,
          "chain_anchor_exact",
          [fragment.facts.deployment],
        )
      : contractAnalysisConclusion(
          fragment.conclusions.controlsObserved,
          fragment.facts.controls,
          "contract_source_at_chain_anchor",
          [sourceConclusionFact],
        );
  const observationExpectations: ObservationExpectation[] = [
    {
      slot: deployment.slot,
      claims: [{
        role: deployment.roles.value,
        value: chainClaims.deployment,
        chainAnchor: analysis.block,
      }],
    },
    {
      slot: targetSource.slot,
      claims: [{
        role: targetSource.roles.value,
        value: createContractAnalysisSourceClaim(analysis, "target"),
        chainAnchor: analysis.block,
      }],
    },
    ...(implementation === undefined
      ? []
      : [{
          slot: implementationSource.slot,
          claims: [{
            role: implementationSource.roles.value,
            value: createContractAnalysisSourceClaim(analysis, "implementation"),
            chainAnchor: analysis.block,
          }],
        }]),
    ...(chainClaims.controlResults === undefined
      ? []
      : [{
          slot: controls.slot,
          claims: [{
            role: controls.roles.value,
            value: chainClaims.controlResults,
            chainAnchor: analysis.block,
          }],
        }]),
  ];
  const factRequirements: FactRequirement[] = [
    contractAnalysisFactRequirement(
      fragment.facts.deployment,
      "observed",
      deployment.slot,
    ),
    contractAnalysisFactRequirement(
      fragment.facts.targetSource,
      contractSourceOutcome(analysis.sources[0]?.status ?? "inconsistent"),
      targetSource.slot,
    ),
    implementation === undefined
      ? contractAnalysisNoneFactRequirement(
          fragment.facts.implementationSource,
          analysis.proxy.status === "no_supported_proxy_observed"
            ? "not_present"
            : "not_observed",
          implementationSource.slot,
        )
      : contractAnalysisFactRequirement(
          fragment.facts.implementationSource,
          contractSourceOutcome(implementation.status),
          implementationSource.slot,
        ),
    chainClaims.controlResults === undefined
      ? contractAnalysisNoneFactRequirement(
          fragment.facts.controls,
          absentControlsOutcome,
          controls.slot,
        )
      : contractAnalysisFactRequirement(
          fragment.facts.controls,
          controlUnavailable ? "source_failed" : "observed",
          controls.slot,
        ),
  ];
  const warningRequirements: WarningRequirement[] = partialFacts.length === 0
    ? []
    : [{ code: "partial_result", facts: Object.freeze([...new Set(partialFacts)]) }];
  return Object.freeze({
    declaration: Object.freeze({
      observationExpectations: Object.freeze(observationExpectations),
      observationReferences: Object.freeze([]),
      factRequirements: Object.freeze(factRequirements),
      warningRequirements: Object.freeze(warningRequirements),
    }),
    sourceConclusionFact,
    controlsConclusion,
  });
};

export const createContractAnalysisEvidenceFactsDeclaration = (
  analysis: ContractAnalysis,
  fragment: ContractAnalysisEvidenceFragment,
  binder: EvidenceReplayBinder,
): ContractAnalysisEvidenceFactsDeclaration =>
  contractAnalysisEvidenceFacts(analysis, fragment, binder).declaration;

const chainStatusLatestBlockConclusion = exactConclusion("latest_block_observed");
const chainStatusChainConclusion = exactConclusion("rpc_chain_id_matches_scope");
const chainStatusReplay = createEvidenceReplayDefinition({
  capabilityId: "chain.status",
  conclusions: [
    chainStatusLatestBlockConclusion,
    chainStatusChainConclusion,
  ],
  warningCodes: [],
});
const chainStatusConfiguredChain = createConfiguredChainEvidenceFragment(chainStatusReplay);
const chainStatusLatestBlockFact =
  createEvidenceFactIdentityDeclaration(chainStatusReplay, "latest_block");
const chainStatusLatestBlockTarget = createEvidenceObservationTargetDeclaration(
  chainStatusReplay,
  {
    slotId: "latest_block",
    fact: chainStatusLatestBlockFact,
    kind: "source",
    purpose: "latest_block",
    sourceClass: "chain_rpc",
    roles: { block: "latest_block" },
  },
);

export const chainStatusEvidence = Object.freeze({
  definition: chainStatusReplay,
  configuredChain: chainStatusConfiguredChain,
  facts: Object.freeze({
    latestBlock: chainStatusLatestBlockFact,
  }),
  targets: Object.freeze({
    latestBlock: chainStatusLatestBlockTarget,
  }),
  conclusions: Object.freeze({
    latestBlockObserved: chainStatusLatestBlockConclusion,
    rpcChainIdMatchesScope: chainStatusChainConclusion,
  }),
  warningCodes: Object.freeze([]),
  staticScopeExclusions: Object.freeze([
    exclusion("execution_readiness", "This capability does not establish execution readiness."),
    exclusion("finality", "This capability does not establish block finality."),
    exclusion(
      "independent_provider_agreement",
      "This capability does not compare independent providers.",
    ),
    exclusion(
      "official_network_identity",
      "Configured scope does not establish official network identity.",
    ),
    exclusion(
      "provider_health",
      "This capability does not establish provider health beyond the observation.",
    ),
  ]),
});

const addressTargetBoundConclusion = exactConclusion("address_target_bound");
const noRuntimeCodeObservedConclusion = exactConclusion("no_runtime_code_observed");
const runtimeCodeObservedConclusion = exactConclusion("runtime_code_observed");
const addressContractAnalysisConclusions = createContractAnalysisEvidenceConclusions();
const noRuntimeCodeConclusionSet = createEvidenceConclusionSetDeclaration([
  noRuntimeCodeObservedConclusion,
]);
const runtimeCodeConclusionSet = createEvidenceConclusionSetDeclaration([
  runtimeCodeObservedConclusion,
  addressContractAnalysisConclusions.deploymentObserved,
  addressContractAnalysisConclusions.sourceChecked,
  addressContractAnalysisConclusions.controlsObserved,
]);
const addressReplay = createEvidenceReplayDefinition({
  capabilityId: "address.inspect",
  conclusions: [addressTargetBoundConclusion],
  conclusionSets: [noRuntimeCodeConclusionSet, runtimeCodeConclusionSet],
  warningCodes: ["partial_result"],
});
const addressConfiguredChain = createConfiguredChainEvidenceFragment(addressReplay);
const addressValidatedInput = createValidatedInputEvidenceFragment(addressReplay, {
  factId: "address_target",
  slotId: "address_target",
  purpose: "address_target",
  roleId: "address_target",
});
const addressContractAnalysis = createContractAnalysisEvidenceFragment(
  addressReplay,
  addressContractAnalysisConclusions,
);
const addressActiveWalletTarget = createEvidenceObservationTargetDeclaration(addressReplay, {
  slotId: "active_wallet_address",
  fact: addressValidatedInput.fact,
  kind: "source",
  purpose: "active_wallet_address",
  sourceClass: "wallet_session",
  roles: { address: "active_wallet_address" },
});
const addressRuntimeCodeFact = createEvidenceFactIdentityDeclaration(addressReplay, "runtime_code");
const addressRuntimeCodeTarget = createEvidenceObservationTargetDeclaration(addressReplay, {
  slotId: "address_runtime_code",
  fact: addressRuntimeCodeFact,
  kind: "source",
  purpose: "address_runtime_code",
  sourceClass: "chain_rpc",
  roles: { runtimeCode: "address_runtime_code" },
});

export const addressInspectEvidence = Object.freeze({
  definition: addressReplay,
  configuredChain: addressConfiguredChain,
  validatedInput: addressValidatedInput,
  analysis: addressContractAnalysis,
  facts: Object.freeze({
    addressTarget: addressValidatedInput.fact,
    runtimeCode: addressRuntimeCodeFact,
  }),
  targets: Object.freeze({
    activeWallet: addressActiveWalletTarget,
    runtimeCode: addressRuntimeCodeTarget,
  }),
  conclusions: Object.freeze({
    addressTargetBound: addressTargetBoundConclusion,
    noRuntimeCodeObserved: noRuntimeCodeObservedConclusion,
    runtimeCodeObserved: runtimeCodeObservedConclusion,
  }),
  conclusionSets: Object.freeze({
    noRuntimeCode: noRuntimeCodeConclusionSet,
    runtimeCode: runtimeCodeConclusionSet,
  }),
  warningCodes: Object.freeze(["partial_result"] as const),
  staticScopeExclusions: Object.freeze([
    exclusion("execution_readiness", "This capability does not establish execution readiness."),
    exclusion("protocol_identity", "This capability does not establish protocol identity."),
    exclusion("safety", "This capability does not establish address safety."),
    exclusion(
      "address_ownership",
      "This capability does not establish a private key, account owner, or current controller.",
    ),
    exclusion(
      "address_type",
      "Runtime code at one block does not establish an enduring EOA or contract classification.",
    ),
    exclusion(
      "unsupported_contract_controls",
      "This capability does not infer custom proxy, role, fee, blocklist, mint, or burn controls.",
    ),
  ]),
});

export const transactionEventDecimalsExclusion = exclusion(
  "transaction_event_decimals_not_observed",
  "Event token decimals are not read by this capability.",
);
export const transactionNativeDecimalsExclusion = exclusion(
  "transaction_native_decimals_not_observed",
  "Native asset decimals are not read by this capability.",
);

const transactionInclusionConclusion = exactConclusion("inclusion_observed");
const transactionReceiptConclusion = exactConclusion("receipt_observed");
const transactionEventsConclusion = exactConclusion("standard_events_decoded");
const transactionObservedConclusion = exactConclusion("transaction_observed");
const transactionReplay = createEvidenceReplayDefinition({
  capabilityId: "transaction.inspect",
  conclusions: [
    transactionInclusionConclusion,
    transactionReceiptConclusion,
    transactionEventsConclusion,
    transactionObservedConclusion,
  ],
  warningCodes: ["decimals_unavailable", "unsupported_transaction_type"],
});
const transactionConfiguredChain = createConfiguredChainEvidenceFragment(transactionReplay);
const transactionFact = createEvidenceFactIdentityDeclaration(transactionReplay, "transaction");
const transactionReceiptFact = createEvidenceFactIdentityDeclaration(transactionReplay, "receipt");
const transactionBlockFact = createEvidenceFactIdentityDeclaration(transactionReplay, "block");
const transactionTarget = createEvidenceObservationTargetDeclaration(transactionReplay, {
  slotId: "transaction",
  fact: transactionFact,
  kind: "source",
  purpose: "transaction",
  sourceClass: "chain_rpc",
  roles: {
    transaction: "transaction",
    value: "transaction_value",
    gasLimit: "transaction_gas_limit",
    gasPrice: "transaction_gas_price",
    maxFeePerGas: "transaction_max_fee_per_gas",
    maxPriorityFeePerGas: "transaction_max_priority_fee_per_gas",
  },
});
const transactionReceiptTarget = createEvidenceObservationTargetDeclaration(
  transactionReplay,
  {
    slotId: "receipt",
    fact: transactionReceiptFact,
    kind: "source",
    purpose: "transaction_receipt",
    sourceClass: "chain_rpc",
    roles: {
      receipt: "transaction_receipt",
      cumulativeGasUsed: "receipt_cumulative_gas_used",
      gasUsed: "receipt_gas_used",
      effectiveGasPrice: "receipt_effective_gas_price",
    },
  },
);
const transactionBlockTarget = createEvidenceObservationTargetDeclaration(
  transactionReplay,
  {
    slotId: "block",
    fact: transactionBlockFact,
    kind: "source",
    purpose: "transaction_block",
    sourceClass: "chain_rpc",
    roles: { block: "transaction_block" },
  },
);
const receiptAmountRoles = new Map<number, EvidenceClaimRoleDeclaration>();

export const receiptLogAmountRole = (indexInput: number): EvidenceClaimRoleDeclaration => {
  if (!Number.isSafeInteger(indexInput) ||
      indexInput < 0 ||
      indexInput >= readCapabilityLimits.transactionReceiptLogs) {
    throw new TypeError("Receipt-log evidence index is invalid.");
  }
  const existing = receiptAmountRoles.get(indexInput);
  if (existing !== undefined) return existing;
  const role = createEvidenceClaimRoleDeclaration(
    transactionReplay,
    transactionReceiptTarget,
    `receipt_log_amount:${indexInput}`,
  );
  receiptAmountRoles.set(indexInput, role);
  return role;
};

export const transactionInspectEvidence = Object.freeze({
  definition: transactionReplay,
  configuredChain: transactionConfiguredChain,
  facts: Object.freeze({
    transaction: transactionFact,
    receipt: transactionReceiptFact,
    block: transactionBlockFact,
  }),
  targets: Object.freeze({
    transaction: transactionTarget,
    receipt: transactionReceiptTarget,
    block: transactionBlockTarget,
  }),
  conclusions: Object.freeze({
    inclusionObserved: transactionInclusionConclusion,
    receiptObserved: transactionReceiptConclusion,
    standardEventsDecoded: transactionEventsConclusion,
    transactionObserved: transactionObservedConclusion,
  }),
  warningCodes: Object.freeze([
    "decimals_unavailable",
    "unsupported_transaction_type",
  ] as const),
  staticScopeExclusions: Object.freeze([
    exclusion(
      "asset_identity_from_symbols",
      "This capability does not derive asset identity from symbols.",
    ),
    exclusion("execution_readiness", "This capability does not establish execution readiness."),
    exclusion("finality", "This capability does not establish finality."),
    exclusion(
      "non_standard_abi_meaning",
      "This capability does not decode non-standard ABI meaning.",
    ),
    exclusion("raw_signatures", "This capability does not resolve raw signatures."),
    exclusion("safety", "This capability does not establish transaction safety."),
    exclusion("traces", "This capability does not inspect execution traces."),
    transactionEventDecimalsExclusion,
    transactionNativeDecimalsExclusion,
    exclusion(
      "unsupported_type_fields",
      "Unsupported transaction-type fields are not interpreted.",
    ),
  ]),
});

export const accountNativeDecimalsExclusion = exclusion(
  "account_native_decimals_not_observed",
  "Native asset decimals are not read by this capability.",
);

const accountBoundConclusion = exactConclusion("account_bound");
const accountNativeBalanceConclusion = exactConclusion("native_balance_observed");
const accountTokenBalanceConclusionFamily =
  createEvmAddressConclusionIdentityDeclaration("token_balance:");
const accountReplay = createEvidenceReplayDefinition({
  capabilityId: "account.balance",
  conclusions: [
    accountBoundConclusion,
    accountNativeBalanceConclusion,
    accountTokenBalanceConclusionFamily,
  ],
  warningCodes: ["decimals_unavailable", "partial_result"],
});
const accountConfiguredChain = createConfiguredChainEvidenceFragment(accountReplay);
const accountValidatedInput = createValidatedInputEvidenceFragment(accountReplay, {
  factId: "account",
  slotId: "account",
  purpose: "account_input",
  roleId: "validated_input",
});
const accountBlockFact = createEvidenceFactIdentityDeclaration(accountReplay, "block");
const accountWalletFact = createEvidenceFactIdentityDeclaration(accountReplay, "wallet_account");
const accountNativeBalanceFact =
  createEvidenceFactIdentityDeclaration(accountReplay, "native_balance");
const accountBlockTarget = createEvidenceObservationTargetDeclaration(accountReplay, {
  slotId: "block",
  fact: accountBlockFact,
  kind: "source",
  purpose: "balance_block",
  sourceClass: "chain_rpc",
  roles: { block: "balance_block" },
});
const accountWalletTarget = createEvidenceObservationTargetDeclaration(accountReplay, {
  slotId: "wallet_account",
  fact: accountWalletFact,
  kind: "source",
  purpose: "active_wallet_account",
  sourceClass: "wallet_session",
  roles: { account: "active_wallet_account" },
});
const accountNativeBalanceTarget = createEvidenceObservationTargetDeclaration(
  accountReplay,
  {
    slotId: "native_balance",
    fact: accountNativeBalanceFact,
    kind: "source",
    purpose: "native_balance",
    sourceClass: "chain_rpc",
    roles: { balance: "native_balance" },
  },
);

export interface AccountTokenEvidenceIdentity {
  readonly address: EvmAddress;
  readonly conclusion: ExactConclusionIdentityDeclaration;
  readonly fact: EvidenceFactIdentityDeclaration;
  readonly balanceTarget: EvidenceObservationTargetDeclaration<{
    readonly balance: EvidenceClaimRoleDeclaration;
  }>;
  readonly decimalsTarget: EvidenceObservationTargetDeclaration<{
    readonly decimals: EvidenceClaimRoleDeclaration;
  }>;
}

interface AccountTokenEvidenceInputScope {
  readonly tokens: readonly EvmAddress[];
}

interface AccountTokenEvidenceScopeState {
  readonly declarationScope: ReturnType<typeof createEvidenceDeclarationScope>;
  readonly addresses: ReadonlySet<EvmAddress>;
  readonly identities: Map<EvmAddress, AccountTokenEvidenceIdentity>;
}

const accountTokenEvidenceScopes =
  new WeakMap<object, AccountTokenEvidenceScopeState>();

const accountTokenEvidenceScope = (
  input: AccountTokenEvidenceInputScope,
): AccountTokenEvidenceScopeState => {
  if (typeof input !== "object" || input === null) {
    throw new TypeError("Account-token evidence input scope is invalid.");
  }
  const existing = accountTokenEvidenceScopes.get(input);
  if (existing !== undefined) return existing;
  if (!Array.isArray(input.tokens) ||
      input.tokens.length > readCapabilityLimits.accountTokenAddresses) {
    throw new TypeError("Account-token evidence input scope is invalid.");
  }
  const addresses = input.tokens.map((value) => evidencePrimitives.evmAddress.parse(value));
  if (new Set(addresses).size !== addresses.length) {
    throw new TypeError("Account-token evidence addresses are duplicated.");
  }
  const declarationScope = createEvidenceDeclarationScope(accountReplay);
  const identities = new Map<EvmAddress, AccountTokenEvidenceIdentity>();
  const state = Object.freeze({
    declarationScope,
    addresses: new Set(addresses),
    identities,
  });
  accountTokenEvidenceScopes.set(input, state);
  for (const address of addresses) {
    const conclusion = createEvmAddressConclusionIdentity(
      accountTokenBalanceConclusionFamily,
      address,
    );
    const fact = createEvidenceFactIdentityForConclusion(
      accountReplay,
      conclusion,
      declarationScope,
    );
    identities.set(address, Object.freeze({
      address,
      conclusion,
      fact,
      balanceTarget: createEvidenceObservationTargetDeclaration(accountReplay, {
        slotId: `token:${address}:balance`,
        fact,
        kind: "source",
        purpose: "token_balance",
        sourceClass: "chain_rpc",
        roles: { balance: conclusion },
      }),
      decimalsTarget: createEvidenceObservationTargetDeclaration(accountReplay, {
        slotId: `token:${address}:decimals`,
        fact,
        kind: "source",
        purpose: "token_decimals",
        sourceClass: "chain_rpc",
        roles: { decimals: `token_decimals:${address}` },
      }),
    }) satisfies AccountTokenEvidenceIdentity);
  }
  return state;
};

export const accountTokenEvidenceIdentity = (
  input: AccountTokenEvidenceInputScope,
  addressInput: EvmAddress,
): AccountTokenEvidenceIdentity => {
  const address = evidencePrimitives.evmAddress.parse(addressInput);
  const scope = accountTokenEvidenceScope(input);
  if (!scope.addresses.has(address)) {
    throw new TypeError("Account-token evidence address is outside its input scope.");
  }
  const identity = scope.identities.get(address);
  if (identity === undefined) {
    throw new TypeError("Account-token evidence identity is absent from its input scope.");
  }
  return identity;
};

export const accountBalanceEvidence = Object.freeze({
  definition: accountReplay,
  configuredChain: accountConfiguredChain,
  validatedInput: accountValidatedInput,
  facts: Object.freeze({
    block: accountBlockFact,
    nativeBalance: accountNativeBalanceFact,
    walletAccount: accountWalletFact,
  }),
  targets: Object.freeze({
    block: accountBlockTarget,
    walletAccount: accountWalletTarget,
    nativeBalance: accountNativeBalanceTarget,
  }),
  conclusions: Object.freeze({
    accountBound: accountBoundConclusion,
    nativeBalanceObserved: accountNativeBalanceConclusion,
    tokenBalance: accountTokenBalanceConclusionFamily,
  }),
  warningCodes: Object.freeze([
    "decimals_unavailable",
    "partial_result",
  ] as const),
  staticScopeExclusions: Object.freeze([
    accountNativeDecimalsExclusion,
    exclusion(
      "canonical_asset_identity",
      "This capability does not establish canonical asset identity.",
    ),
    exclusion("cost_basis", "This capability does not calculate cost basis."),
    exclusion("execution_readiness", "This capability does not establish execution readiness."),
    exclusion(
      "portfolio_completeness",
      "This capability does not establish portfolio completeness.",
    ),
    exclusion(
      "profit_and_loss",
      "This capability does not calculate profit and loss.",
    ),
    exclusion("valuation", "This capability does not calculate valuation."),
  ]),
});

const walletConnectionConclusion = exactConclusion("wallet_connection_state");
const walletReplay = createEvidenceReplayDefinition({
  capabilityId: "wallet.connection",
  conclusions: [walletConnectionConclusion],
  warningCodes: [],
});
const walletConnectionFact =
  createEvidenceFactIdentityDeclaration(walletReplay, "wallet_connection");
const walletSdkTarget = createEvidenceObservationTargetDeclaration(walletReplay, {
  slotId: "wallet_sdk",
  fact: walletConnectionFact,
  kind: "source",
  purpose: "wallet_sdk_sessions",
  sourceClass: "wallet_sdk",
  roles: { state: "wallet_sdk_state" },
});
const walletSessionTarget = createEvidenceObservationTargetDeclaration(walletReplay, {
  slotId: "wallet_session",
  fact: walletConnectionFact,
  kind: "source",
  purpose: "wallet_session",
  sourceClass: "wallet_session",
  roles: { state: "wallet_session_state" },
});

export const walletConnectionEvidence = Object.freeze({
  definition: walletReplay,
  facts: Object.freeze({
    connection: walletConnectionFact,
  }),
  targets: Object.freeze({
    sdk: walletSdkTarget,
    session: walletSessionTarget,
  }),
  conclusions: Object.freeze({
    connectionState: walletConnectionConclusion,
  }),
  warningCodes: Object.freeze([]),
  staticScopeExclusions: Object.freeze([
    exclusion("address_ownership", "Connection state does not prove address ownership."),
    exclusion(
      "future_session_usability",
      "Connection state does not guarantee future session usability.",
    ),
    exclusion("signing_authority", "Connection state does not grant signing authority."),
    exclusion(
      "transaction_approval",
      "Connection state does not approve a transaction.",
    ),
    exclusion("wallet_safety", "Connection state does not establish wallet safety."),
  ]),
});
