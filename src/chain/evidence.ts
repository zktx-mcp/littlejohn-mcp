import { readCapabilityLimits } from "../evm/read-limits.js";
import { createEvidenceClaimRoleDeclaration, createEvidenceConclusionSetDeclaration, createEvidenceFactIdentityDeclaration, createEvidenceObservationTargetDeclaration } from "../core/client.js";
import { type EvidenceClaimRoleDeclaration } from "../core/client.js";
import { createEvmEvidenceReplayDefinition } from "../evm/evidence-replay.js";
import {exclusion, exactConclusion} from "../core/client.js";
import {createConfiguredChainEvidenceFragment} from "./evidence-fragments.js";
import {createValidatedInputEvidenceFragment} from "../registry/validated-input-evidence.js";
import {createContractAnalysisEvidenceConclusions, createContractAnalysisEvidenceFragment} from "../intelligence/analysis-evidence.js";

const chainStatusLatestBlockConclusion = exactConclusion("latest_block_observed");

const chainStatusChainConclusion = exactConclusion("rpc_chain_id_matches_scope");

const chainStatusReplay = createEvmEvidenceReplayDefinition({
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

const addressReplay = createEvmEvidenceReplayDefinition({
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

const transactionReplay = createEvmEvidenceReplayDefinition({
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
