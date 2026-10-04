import { readCapabilityLimits } from "../evm/read-limits.js";
import { createEvidenceDeclarationScope, createEvidenceFactIdentityDeclaration, createEvidenceFactIdentityForConclusion, createEvidenceObservationTargetDeclaration } from "../core/client.js";
import { type EvidenceClaimRoleDeclaration, type EvidenceFactIdentityDeclaration, type EvidenceObservationTargetDeclaration, type ExactConclusionIdentityDeclaration } from "../core/client.js";
import { createEvmEvidenceReplayDefinition } from "../evm/evidence-replay.js";
import {createEvmAddressConclusionIdentity, createEvmAddressConclusionIdentityDeclaration} from "../evm/evidence-replay.js";
import {createEvmPrimitiveSchemaSet} from "../evm/primitives.js";
import {type EvmAddress} from "../evm/identities.js";
import {exclusion, exactConclusion} from "../core/client.js";
import {createConfiguredChainEvidenceFragment} from "../chain/evidence-fragments.js";
import {createValidatedInputEvidenceFragment} from "../registry/validated-input-evidence.js";

const evidencePrimitives = createEvmPrimitiveSchemaSet();

export const accountNativeDecimalsExclusion = exclusion(
  "account_native_decimals_not_observed",
  "Native asset decimals are not read by this capability.",
);

const accountBoundConclusion = exactConclusion("account_bound");

const accountNativeBalanceConclusion = exactConclusion("native_balance_observed");

const accountTokenBalanceConclusionFamily =
  createEvmAddressConclusionIdentityDeclaration("token_balance:");

const accountReplay = createEvmEvidenceReplayDefinition({
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
