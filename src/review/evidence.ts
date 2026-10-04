import { captureCanonicalJson, createEvidenceFactIdentityDeclaration, createEvidenceObservationTargetDeclaration, createExactConclusionIdentityDeclaration, createEvidenceConclusionSetDeclaration, staticScopeExclusionSchema, type EvidenceReplayBinder, type EvidenceReplayDeclaration, type ObservationExpectation, type FactRequirement, type ConclusionDraft } from "../core/client.js";
import { createEvmEvidenceReplayDefinition } from "../evm/evidence-replay.js";
import { transactionContractSourceClaim } from "../intelligence/transaction-contracts.js";
import type { ExchangeObservation } from "./observation.js";
import type { FeeReplacementObservation } from "./replacement-contract.js";
import { uniswapV4ContractRoles } from "../protocols/uniswap-v4/contract-profile.js";

const observed = createExactConclusionIdentityDeclaration("exchange_inputs_observed");
const official = createExactConclusionIdentityDeclaration("exchange_official_asset_observed");
const usdg = createExactConclusionIdentityDeclaration("exchange_usdg_observed");
const wallet = createExactConclusionIdentityDeclaration("exchange_wallet_observed");
const pending = createExactConclusionIdentityDeclaration("exchange_pending_nonce_observed");
const sources = createExactConclusionIdentityDeclaration("exchange_contract_sources_observed");
const stockConclusions = createEvidenceConclusionSetDeclaration([official]);
const usdgConclusions = createEvidenceConclusionSetDeclaration([usdg]);
export const exchangeObservationCapabilityId = "exchange.observation" as const;
const definition = createEvmEvidenceReplayDefinition({
  capabilityId: exchangeObservationCapabilityId,
  conclusions: [observed, wallet, pending, sources], conclusionSets: [stockConclusions, usdgConclusions], warningCodes: [],
});

const target = (id: string, sourceClass: "chain_rpc" | "web_api" | "wallet_session" | "contract_verification_service", purpose = id) => {
  const fact = createEvidenceFactIdentityDeclaration(definition, id);
  return Object.freeze({ fact, declaration: createEvidenceObservationTargetDeclaration(definition, {
    slotId: id, fact, kind: "source", purpose, sourceClass, roles: { value: id },
  }) });
};

const chain = target("exchange_chain", "chain_rpc");
const officialTarget = target("exchange_official", "web_api");
const walletTarget = target("exchange_wallet", "wallet_session");
const pendingTarget = target("exchange_pending_nonce", "chain_rpc", "pending_account_nonce");
const contracts = Object.freeze(uniswapV4ContractRoles.map((role) => ({
  role,
  chain: target(`${role}_chain`, "chain_rpc"),
  target: target(`${role}_source`, "contract_verification_service"),
  implementation: target(`${role}_implementation`, "contract_verification_service"),
})));

type TransactionObservation = ExchangeObservation | FeeReplacementObservation;
export const exchangeChainClaim = (data: TransactionObservation) => {
  const { pendingNonce: _pending, ...state } = data.state;
  return captureCanonicalJson({
    block: data.block, intent: data.intent, state,
    ...("replacement" in data ? { replacement: data.replacement, conditions: data.conditions, tokenUnits: data.tokenUnits } :
      { pool: data.pool, displayScaling: data.displayScaling, quote: data.quote,
        ...(data.predecessor === undefined ? {} : { predecessor: data.predecessor }) }),
    ...(data.official === null ? {} : { verification: data.official.verification }),
    kind: data.kind, gasLimit: data.gasLimit, simulation: data.simulation,
    walletRequestCommitment: data.walletRequestCommitment,
  });
};
export const exchangeOfficialClaim = (data: TransactionObservation) => {
  if (data.official === null) throw new TypeError("No StockFactory attribution applies to this transaction.");
  return captureCanonicalJson({ member: data.official.member, snapshot: data.official.snapshot });
};
export const exchangeWalletClaim = (data: TransactionObservation) => captureCanonicalJson(data.connection);
export const exchangePendingNonceClaim = (data: TransactionObservation) => captureCanonicalJson({ account: data.intent.account, nonce: data.state.pendingNonce,
  ...("replacement" in data ? { replacement: data.replacement } : data.predecessor === undefined ? {} : { predecessor: data.predecessor }) });
export const exchangeContractChainClaim = (facts: ExchangeObservation["contracts"][number]["facts"]) => captureCanonicalJson({
  chainId: facts.chainId, target: facts.target, block: facts.block,
  targetRuntimeCode: facts.targetRuntimeCode, proxy: facts.proxy, controls: facts.controls,
});

const declaration = (_input: unknown, data: TransactionObservation, binder: EvidenceReplayBinder): EvidenceReplayDeclaration => {
  const expectations: ObservationExpectation[] = [];
  const requirements: FactRequirement[] = [];
  const chainFacts: FactRequirement["fact"][] = [];
  const sourceFacts: FactRequirement["fact"][] = [];
  const add = (entry: ReturnType<typeof target>, value: ReturnType<typeof captureCanonicalJson>, anchored: boolean) => {
    const bound = binder.bind(entry.declaration);
    expectations.push({ slot: bound.slot, claims: [{ role: bound.roles.value, value, ...(anchored ? { chainAnchor: data.block } : {}) }] });
    requirements.push({ fact: entry.fact, outcome: "observed", observationSlots: [bound.slot], requiredObservationSlots: [bound.slot], minimumObservationCount: 1 });
  };
  add(chain, exchangeChainClaim(data), true); chainFacts.push(chain.fact);
  if (data.official !== null) add(officialTarget, exchangeOfficialClaim(data), false);
  add(walletTarget, exchangeWalletClaim(data), false);
  add(pendingTarget, exchangePendingNonceClaim(data), false);
  for (const entry of contracts) {
    const facts = data.contracts.find((contract) => contract.role === entry.role)?.facts;
    if (facts === undefined) continue;
    add(entry.chain, exchangeContractChainClaim(facts), true); chainFacts.push(entry.chain.fact);
    add(entry.target, transactionContractSourceClaim(facts, "target"), true); sourceFacts.push(entry.target.fact);
    if (facts.sources.some((source) => source.role === "implementation")) {
      add(entry.implementation, transactionContractSourceClaim(facts, "implementation"), true);
      sourceFacts.push(entry.implementation.fact);
    }
  }
  const conclusions: ConclusionDraft[] = [
    { conclusion: observed, outcomeFact: chain.fact, evidenceFacts: chainFacts, freshnessRuleId: "chain_anchor_exact" },
    data.official === null
      ? { conclusion: usdg, outcomeFact: chain.fact, evidenceFacts: chainFacts, freshnessRuleId: "chain_anchor_exact" }
      : { conclusion: official, outcomeFact: officialTarget.fact, evidenceFacts: [officialTarget.fact], freshnessRuleId: "official_asset_snapshot_current" },
    { conclusion: wallet, outcomeFact: walletTarget.fact, evidenceFacts: [walletTarget.fact], freshnessRuleId: "wallet_session_current" },
    { conclusion: pending, outcomeFact: pendingTarget.fact, evidenceFacts: [pendingTarget.fact], freshnessRuleId: "pending_nonce_observed" },
    { conclusion: sources, outcomeFact: sourceFacts[0]!, evidenceFacts: sourceFacts, freshnessRuleId: "contract_source_at_chain_anchor" },
  ];
  return { conclusionSet: data.official === null ? usdgConclusions : stockConclusions,
    observationExpectations: expectations, observationReferences: [], factRequirements: requirements, conclusionDrafts: conclusions, warningRequirements: [] };
};

export const exchangeObservationEvidence = Object.freeze({
  definition, chain, official: officialTarget, wallet: walletTarget, pending: pendingTarget, contracts,
  observationTargets: (_input: unknown) => [chain.declaration, officialTarget.declaration, walletTarget.declaration, pendingTarget.declaration,
    ...contracts.flatMap((entry) => [entry.chain.declaration, entry.target.declaration, entry.implementation.declaration])],
  declaration,
  staticScopeExclusions: [
    { id: "broadcast_or_receipt", message: "This observation does not establish Wallet approval, broadcast, execution or a receipt." },
    { id: "future_state", message: "Observed execution inputs do not guarantee later state or a future successful transaction." },
    { id: "all_pending_transactions", message: "The endpoint's pending nonce is not proof that every pending transaction is known." },
    { id: "simulation_trace", message: "A successful call simulation is not an observed transaction trace or an actual asset delta." },
  ].map((value) => staticScopeExclusionSchema.parse(value)),
});

