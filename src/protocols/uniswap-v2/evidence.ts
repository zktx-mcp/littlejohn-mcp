import {
  canonicalJsonStringify,
  captureCanonicalJson,
  createConfiguredChainEvidenceFragment,
  createContractAnalysisEvidenceConclusions,
  createContractAnalysisEvidenceFactsDeclaration,
  createContractAnalysisEvidenceFragment,
  createEvidenceFactIdentityDeclaration,
  createEvidenceObservationTargetDeclaration,
  createEvidenceReplayDefinition,
  createExactConclusionIdentityDeclaration,
  staticScopeExclusionSchema,
  type ConclusionDraft,
  type EvidenceReplayBinder,
  type EvidenceReplayDeclaration,
  type FactRequirement,
  type ObservationExpectation,
} from "../../core/client.js";
import {
  uniswapV2RouteAssets,
  uniswapV2QuoteCapabilityId,
} from "./deployment.js";
import type {
  UniswapV2EvaluatedHop,
  UniswapV2QuoteData,
  UniswapV2QuoteInput,
  UniswapV2TokenDecimals,
} from "./contracts.js";

const deploymentObserved = createExactConclusionIdentityDeclaration(
  "uniswap_v2_deployment_observed",
);
const candidatesEvaluated = createExactConclusionIdentityDeclaration(
  "uniswap_v2_candidates_evaluated",
);
const quoteObserved = createExactConclusionIdentityDeclaration(
  "uniswap_v2_quote_observed",
);
const definition = createEvidenceReplayDefinition({
  capabilityId: uniswapV2QuoteCapabilityId,
  conclusions: [deploymentObserved, candidatesEvaluated, quoteObserved],
  warningCodes: ["partial_result"],
});
const quoteOutcomeFact = createEvidenceFactIdentityDeclaration(definition, "quote_outcome");
const configuredChain = createConfiguredChainEvidenceFragment(definition);
const analysis = createContractAnalysisEvidenceFragment(
  definition,
  createContractAnalysisEvidenceConclusions(),
);

const maximumPairObservations = 1 + uniswapV2RouteAssets.length * 2;
const pairEntries = Object.freeze(
  Array.from({ length: maximumPairObservations }, (_, index) => {
    const fact = createEvidenceFactIdentityDeclaration(definition, `pair_${index}`);
    return Object.freeze({
      fact,
      target: createEvidenceObservationTargetDeclaration(definition, {
        slotId: `pair_${index}`,
        fact,
        kind: "source",
        purpose: "uniswap_v2_pair",
        sourceClass: "chain_rpc",
        roles: { value: `uniswap_v2_pair_${index}` },
      }),
    });
  }),
);

const maximumDecimalsObservations = 2 + uniswapV2RouteAssets.length;
const decimalsEntries = Object.freeze(
  Array.from({ length: maximumDecimalsObservations }, (_, index) => {
    const fact = createEvidenceFactIdentityDeclaration(definition, `token_decimals_${index}`);
    return Object.freeze({
      fact,
      target: createEvidenceObservationTargetDeclaration(definition, {
        slotId: `token_decimals_${index}`,
        fact,
        kind: "source",
        purpose: "token_decimals",
        sourceClass: "chain_rpc",
        roles: { value: `token_decimals_${index}` },
      }),
    });
  }),
);

const pairSlotIndex = (candidateIndex: number, hopIndex: number): number => {
  if (
    !Number.isSafeInteger(candidateIndex) ||
    candidateIndex < 0 ||
    candidateIndex > uniswapV2RouteAssets.length ||
    !Number.isSafeInteger(hopIndex) ||
    hopIndex < 0 ||
    hopIndex >= (candidateIndex === 0 ? 1 : 2)
  ) {
    throw new TypeError("V2 pair evidence position is invalid.");
  }
  return candidateIndex === 0
    ? 0
    : 1 + (candidateIndex - 1) * 2 + hopIndex;
};

export const uniswapV2PairEvidenceTarget = (
  candidateIndex: number,
  hopIndex: number,
) => {
  const entry = pairEntries[pairSlotIndex(candidateIndex, hopIndex)];
  if (entry === undefined) throw new TypeError("V2 pair evidence target is absent.");
  return entry.target;
};

const decimalsSlotIndex = (
  input: UniswapV2QuoteInput,
  address: string,
): number => {
  if (address === input.tokenIn.address) return 0;
  if (address === input.tokenOut.address) return 1;
  const routeIndex = uniswapV2RouteAssets.findIndex((asset) => asset.address === address);
  if (routeIndex < 0) throw new TypeError("V2 decimals evidence asset is undeclared.");
  return 2 + routeIndex;
};

export const uniswapV2DecimalsEvidenceTarget = (
  input: UniswapV2QuoteInput,
  address: string,
) => {
  const entry = decimalsEntries[decimalsSlotIndex(input, address)];
  if (entry === undefined) throw new TypeError("V2 decimals evidence target is absent.");
  return entry.target;
};

export const createUniswapV2PairObservationClaim = (
  candidateIndex: number,
  hopIndex: number,
  hop: UniswapV2EvaluatedHop,
) => captureCanonicalJson({
  candidateIndex: String(candidateIndex),
  hopIndex: String(hopIndex),
  tokenIn: hop.tokenIn.asset,
  tokenOut: hop.tokenOut.asset,
  factoryResult: hop.factoryResult,
  ...(hop.status === "pair_absent" ? {} : { pair: hop.pair }),
});

export const createUniswapV2DecimalsObservationClaim = (
  address: string,
  decimals: Exclude<UniswapV2TokenDecimals, { status: "not_observed" }>,
) => captureCanonicalJson({
  address,
  result: decimals.status === "observed"
    ? { status: "observed", decimals: decimals.value }
    : { status: "reverted" },
});

const requirement = (
  fact: FactRequirement["fact"],
  outcome: FactRequirement["outcome"],
  slot: FactRequirement["observationSlots"][number],
  observed: boolean,
): FactRequirement => Object.freeze({
  fact,
  outcome: observed ? outcome : "not_observed",
  observationSlots: [slot],
  requiredObservationSlots: observed ? [slot] : [],
  minimumObservationCount: observed ? 1 : 0,
});

const boundPairEntries = (
  binder: EvidenceReplayBinder,
) => pairEntries.map((entry) => Object.freeze({
  fact: entry.fact,
  target: binder.bind(entry.target),
}));

const boundDecimalsEntries = (
  binder: EvidenceReplayBinder,
) => decimalsEntries.map((entry) => Object.freeze({
  fact: entry.fact,
  target: binder.bind(entry.target),
}));

const pairObservationAt = (
  data: UniswapV2QuoteData,
  flatIndex: number,
): Readonly<{
  readonly candidateIndex: number;
  readonly hopIndex: number;
  readonly hop: UniswapV2EvaluatedHop;
}> | undefined => {
  for (let candidateIndex = 0; candidateIndex < data.candidates.length; candidateIndex += 1) {
    const candidate = data.candidates[candidateIndex];
    if (candidate === undefined) continue;
    for (let hopIndex = 0; hopIndex < candidate.evaluatedHops.length; hopIndex += 1) {
      if (pairSlotIndex(candidateIndex, hopIndex) === flatIndex) {
        const hop = candidate.evaluatedHops[hopIndex];
        if (hop === undefined) throw new TypeError("V2 evaluated hop is absent.");
        return { candidateIndex, hopIndex, hop };
      }
    }
  }
  return undefined;
};

const decimalsObservationsBySlot = (
  input: UniswapV2QuoteInput,
  data: UniswapV2QuoteData,
): ReadonlyMap<number, Readonly<{
  readonly address: string;
  readonly decimals: Exclude<UniswapV2TokenDecimals, { status: "not_observed" }>;
}>> => {
  const values = new Map<number, Readonly<{
    readonly address: string;
    readonly decimals: Exclude<UniswapV2TokenDecimals, { status: "not_observed" }>;
  }>>();
  for (const candidate of data.candidates) {
    for (const hop of candidate.evaluatedHops) {
      for (const token of [hop.tokenIn, hop.tokenOut]) {
        if (token.decimals.status === "not_observed") continue;
        const index = decimalsSlotIndex(input, token.asset.address);
        const existing = values.get(index);
        if (
          existing !== undefined &&
          (existing.address !== token.asset.address ||
            canonicalJsonStringify(existing.decimals) !==
              canonicalJsonStringify(token.decimals))
        ) {
          throw new TypeError("V2 token decimals conflict across candidates.");
        }
        values.set(index, Object.freeze({
          address: token.asset.address,
          decimals: token.decimals,
        }));
      }
    }
  }
  return values;
};

const declaration = (
  input: UniswapV2QuoteInput,
  data: UniswapV2QuoteData,
  binder: EvidenceReplayBinder,
): EvidenceReplayDeclaration => {
  const chain = binder.bind(configuredChain.target);
  const analysisFacts = createContractAnalysisEvidenceFactsDeclaration(
    data.deployment.analysis,
    analysis,
    binder,
  );
  const pairs = boundPairEntries(binder);
  const decimals = boundDecimalsEntries(binder);
  const decimalsBySlot = decimalsObservationsBySlot(input, data);
  const observationExpectations: ObservationExpectation[] = [
    {
      slot: chain.slot,
      claims: [{
        role: chain.roles.chainId,
        value: data.block.chainId,
        chainAnchor: data.block,
      }],
    },
    ...analysisFacts.observationExpectations,
  ];
  const factRequirements: FactRequirement[] = [
    requirement(
      configuredChain.fact,
      configuredChain.outcome,
      chain.slot,
      true,
    ),
    ...analysisFacts.factRequirements,
  ];
  const observedCandidateFacts: FactRequirement["fact"][] = [
    configuredChain.fact,
    analysis.facts.deployment,
  ];
  for (let index = 0; index < pairs.length; index += 1) {
    const pair = pairs[index];
    if (pair === undefined) continue;
    const observation = pairObservationAt(data, index);
    if (observation !== undefined) {
      observationExpectations.push({
        slot: pair.target.slot,
        claims: [{
          role: pair.target.roles.value,
          value: createUniswapV2PairObservationClaim(
            observation.candidateIndex,
            observation.hopIndex,
            observation.hop,
          ),
          chainAnchor: data.block,
        }],
      });
      observedCandidateFacts.push(pair.fact);
    }
    factRequirements.push(requirement(
      pair.fact,
      "observed",
      pair.target.slot,
      observation !== undefined,
    ));
  }
  for (let index = 0; index < decimals.length; index += 1) {
    const entry = decimals[index];
    if (entry === undefined) continue;
    const observation = decimalsBySlot.get(index);
    if (observation !== undefined) {
      observationExpectations.push({
        slot: entry.target.slot,
        claims: [{
          role: entry.target.roles.value,
          value: createUniswapV2DecimalsObservationClaim(
            observation.address,
            observation.decimals,
          ),
          chainAnchor: data.block,
        }],
      });
      observedCandidateFacts.push(entry.fact);
    }
    factRequirements.push(requirement(
      entry.fact,
      observation?.decimals.status === "unavailable"
        ? "source_failed"
        : "observed",
      entry.target.slot,
      observation !== undefined,
    ));
  }
  const quoted = data.candidates.some((candidate) => candidate.status === "quoted");
  if (!quoted) {
    factRequirements.push(Object.freeze({
      fact: quoteOutcomeFact,
      outcome: "not_present",
      observationSlots: [],
      requiredObservationSlots: [],
      minimumObservationCount: 0,
    }));
  }
  const deploymentFacts = [configuredChain.fact, analysis.facts.deployment];
  const conclusionDrafts: ConclusionDraft[] = [
    {
      conclusion: deploymentObserved,
      outcomeFact: analysis.facts.deployment,
      evidenceFacts: Object.freeze(deploymentFacts),
      freshnessRuleId: "chain_anchor_exact",
    },
    {
      conclusion: candidatesEvaluated,
      outcomeFact: configuredChain.fact,
      evidenceFacts: Object.freeze(observedCandidateFacts),
      freshnessRuleId: "chain_anchor_exact",
    },
    {
      conclusion: quoteObserved,
      outcomeFact: quoted ? configuredChain.fact : quoteOutcomeFact,
      evidenceFacts: Object.freeze(observedCandidateFacts),
      freshnessRuleId: "chain_anchor_exact" as const,
    },
  ];
  return Object.freeze({
    observationExpectations: Object.freeze(observationExpectations),
    observationReferences: analysisFacts.observationReferences,
    factRequirements: Object.freeze(factRequirements),
    conclusionDrafts: Object.freeze(conclusionDrafts),
    warningRequirements: analysisFacts.warningRequirements,
  });
};

const staticScopeExclusions = Object.freeze([
  { id: "best_route", message: "This capability does not select a best route or venue." },
  {
    id: "liquidity_outside_declared_candidates",
    message: "This capability does not inspect liquidity outside the declared candidates.",
  },
  {
    id: "actual_received_output",
    message: "This capability does not establish the output that a transaction would receive.",
  },
  { id: "execution_readiness", message: "This capability does not establish execution readiness." },
  { id: "gas_cost", message: "This capability does not calculate transaction gas cost." },
  { id: "minimum_output", message: "This capability does not calculate minimum output or slippage tolerance." },
  { id: "nonstandard_token_behavior", message: "This capability does not simulate non-standard token transfer behavior." },
  {
    id: "transaction_lifecycle",
    message: "This capability does not construct, simulate, review, execute, or confirm a transaction.",
  },
  {
    id: "universal_sellability",
    message: "This capability does not establish universal sellability or the absence of a honeypot.",
  },
  {
    id: "future_availability",
    message: "This capability does not establish future route or liquidity availability.",
  },
  { id: "safety", message: "This capability does not establish token or transaction safety." },
].map((value) => Object.freeze(staticScopeExclusionSchema.parse(value))));

export const uniswapV2QuoteEvidence = Object.freeze({
  definition,
  configuredChain,
  analysis,
  pairEntries,
  decimalsEntries,
  observationTargets: (_input: UniswapV2QuoteInput) => [
    configuredChain.target,
    ...Object.values(analysis.targets),
    ...pairEntries.map((entry) => entry.target),
    ...decimalsEntries.map((entry) => entry.target),
  ],
  declaration,
  staticScopeExclusions,
});
