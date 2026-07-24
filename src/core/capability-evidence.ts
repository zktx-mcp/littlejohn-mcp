import { readCapabilityLimits } from "./capability-contract.js";
import {
  createEvidenceClaimRoleDeclaration,
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
  type EvidenceFactIdentityDeclaration,
  type EvidenceObservationTargetDeclaration,
  type EvidenceReplayDefinition,
  type ExactConclusionIdentityDeclaration,
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
): ValidatedInputEvidenceFragment => {
  const capabilityId = readEvidenceReplayCapabilityId(definition);
  const fact = createEvidenceFactIdentityDeclaration(definition, "account");
  return Object.freeze({
    fact,
    target: createEvidenceObservationTargetDeclaration(definition, {
      slotId: "account",
      fact,
      kind: "validated_input",
      purpose: "account_input",
      owner: `${productDisplayName} validated input`,
      sourceId: `input:${capabilityId}`,
      roles: { input: "validated_input" },
    }),
    outcome: "validated_input",
    freshnessRuleId: "validated_input_current",
  });
};

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

const contractAccountConclusion = exactConclusion("account_observed");
const contractRuntimeCodeConclusion = exactConclusion("runtime_code_observed");
const contractReplay = createEvidenceReplayDefinition({
  capabilityId: "contract.inspect",
  conclusions: [contractAccountConclusion, contractRuntimeCodeConclusion],
  warningCodes: [],
});
const contractConfiguredChain = createConfiguredChainEvidenceFragment(contractReplay);
const contractAccountFact = createEvidenceFactIdentityDeclaration(contractReplay, "account");
const contractRuntimeCodeFact =
  createEvidenceFactIdentityDeclaration(contractReplay, "runtime_code");
const contractBlockTarget = createEvidenceObservationTargetDeclaration(contractReplay, {
  slotId: "block",
  fact: contractAccountFact,
  kind: "source",
  purpose: "contract_block",
  sourceClass: "chain_rpc",
  roles: { block: "contract_block" },
});
const contractRuntimeCodeTarget = createEvidenceObservationTargetDeclaration(
  contractReplay,
  {
    slotId: "runtime_code",
    fact: contractRuntimeCodeFact,
    kind: "source",
    purpose: "runtime_code",
    sourceClass: "chain_rpc",
    roles: { runtimeCode: "runtime_code" },
  },
);

export const contractInspectEvidence = Object.freeze({
  definition: contractReplay,
  configuredChain: contractConfiguredChain,
  facts: Object.freeze({
    account: contractAccountFact,
    runtimeCode: contractRuntimeCodeFact,
  }),
  targets: Object.freeze({
    block: contractBlockTarget,
    runtimeCode: contractRuntimeCodeTarget,
  }),
  conclusions: Object.freeze({
    accountObserved: contractAccountConclusion,
    runtimeCodeObserved: contractRuntimeCodeConclusion,
  }),
  warningCodes: Object.freeze([]),
  staticScopeExclusions: Object.freeze([
    exclusion("abi_identity", "This capability does not establish ABI identity."),
    exclusion("control_roles", "This capability does not inspect contract control roles."),
    exclusion("execution_readiness", "This capability does not establish execution readiness."),
    exclusion("protocol_identity", "This capability does not establish protocol identity."),
    exclusion("proxy_identity", "This capability does not resolve proxy identity."),
    exclusion("safety", "This capability does not establish contract safety."),
    exclusion(
      "source_verification",
      "This capability does not establish source verification.",
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
const accountValidatedInput = createValidatedInputEvidenceFragment(accountReplay);
const accountBlockFact = createEvidenceFactIdentityDeclaration(accountReplay, "block");
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
  slotId: "account",
  fact: accountValidatedInput.fact,
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
  const state = Object.freeze({
    declarationScope: createEvidenceDeclarationScope(accountReplay),
    addresses: new Set(addresses),
    identities: new Map<EvmAddress, AccountTokenEvidenceIdentity>(),
  });
  accountTokenEvidenceScopes.set(input, state);
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
  const existing = scope.identities.get(address);
  if (existing !== undefined) return existing;
  const conclusion = createEvmAddressConclusionIdentity(
    accountTokenBalanceConclusionFamily,
    address,
  );
  const fact = createEvidenceFactIdentityForConclusion(
    accountReplay,
    conclusion,
    scope.declarationScope,
  );
  const result = Object.freeze({
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
  }) satisfies AccountTokenEvidenceIdentity;
  scope.identities.set(address, result);
  return result;
};

export const accountBalanceEvidence = Object.freeze({
  definition: accountReplay,
  configuredChain: accountConfiguredChain,
  validatedInput: accountValidatedInput,
  facts: Object.freeze({
    block: accountBlockFact,
    nativeBalance: accountNativeBalanceFact,
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
