import {exactConclusion} from "../core/client.js";
import {createEvidenceFactIdentityDeclaration, createEvidenceObservationTargetDeclaration, createExactConclusionIdentityDeclaration, type EvidenceFactIdentityDeclaration, type EvidenceObservationTargetDeclaration, type EvidenceClaimRoleDeclaration, type EvidenceReplayDefinition} from "../core/client.js";
import {createContractAnalysisChainClaims, createContractAnalysisSourceClaim, type ContractAnalysis} from "./analysis-contract.js";
import {type ConclusionDraft, type EvidenceReplayBinder, type EvidenceReplayDeclaration, type ExactConclusionIdentityDeclaration, type FactRequirement, type ObservationExpectation, type WarningRequirement} from "../core/client.js";
import {type Freshness} from "../core/client.js";


export type ContractAnalysisEvidenceTargets = Pick<
  ContractAnalysisEvidenceFragment,
  "targets"
>;

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
