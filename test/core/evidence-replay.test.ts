import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { captureEvidenceObservationClaims, createEvidenceObservationId, createEvidenceSourceRecordDigest, evidenceObservationClaimsEqual } from "../../src/core/evidence-replay.js";
import { createEvidenceClaimRoleDeclaration, createEvidenceConclusionSetDeclaration, createEvidenceDeclarationScope, createEvidenceFactIdentityDeclaration, createEvidenceFactIdentityForConclusion, createEvidenceObservationTargetDeclaration, createEvidenceReplayLayout, createExactConclusionIdentityDeclaration, readEvidenceReplayConclusionIds, readEvidenceReplaySlots, replayPublicEvidence } from "../../src/core/client.js";
import { createEvidenceReplayBinder, readBoundEvidenceObservationSlot } from "../../src/core/client.js";
import { type ConclusionIdentityDeclaration } from "../../src/core/index.js";
import { createEvmEvidenceReplayDefinition } from "../../src/evm/evidence-replay.js";
import {createEvmAddressConclusionIdentity, createEvmAddressConclusionIdentityDeclaration} from "../../src/evm/evidence-replay.js";
import { invocationIdSchema } from "../../src/core/index.js";
import { evidenceSourceRecordSchema } from "../../src/evm/evidence.js";
import { evidenceSourceSchema } from "../../src/evm/evidence.js";
import type {CanonicalJson} from "../../src/core/index.js";
import {evmAddressSchema} from "../../src/evm/identities.js";
import {productDisplayName} from "../../src/registry/client.js";
import {chainAnchorSchema} from "../../src/evm/primitives.js";
import {parseUtcTimestamp} from "../../src/core/index.js";

const capabilityId = "test.replay";
const evaluatedAt = parseUtcTimestamp("2026-07-24T00:00:00.000Z");
const invocationId = invocationIdSchema.parse(`inv:${Buffer.alloc(32, 7).toString("base64url")}`);
const validatedInputOwner = `${productDisplayName} validated input`;
const validatedInputSourceId = `input:${capabilityId}`;

const conclusion = createExactConclusionIdentityDeclaration("input_validated");
const definition = createEvmEvidenceReplayDefinition({
  capabilityId,
  conclusions: [conclusion],
  warningCodes: [],
});
const fact = createEvidenceFactIdentityDeclaration(definition, "input");
const target = createEvidenceObservationTargetDeclaration(definition, {
  slotId: "input",
  fact,
  kind: "validated_input",
  purpose: "validated_input",
  owner: validatedInputOwner,
  sourceId: validatedInputSourceId,
  roles: { value: "validated_input" },
});

const createLayout = () => {
  const layout = createEvidenceReplayLayout(definition, [target]);
  const bound = createEvidenceReplayBinder(definition, layout).bind(target);
  return { layout, bound };
};

const createSource = (
  layout: ReturnType<typeof createEvidenceReplayLayout>,
  owner = validatedInputOwner,
  value: CanonicalJson = { value: "safe" },
) => {
  const bound = createEvidenceReplayBinder(definition, layout).bind(target);
  const claims = [{ role: bound.roles.value, value }];
  const observationId = createEvidenceObservationId(definition, layout, {
    slot: bound.slot,
    sourceId: validatedInputSourceId,
    observedAt: evaluatedAt,
    invocationId,
  });
  const sourceRecord = evidenceSourceRecordSchema.parse({
    observationId,
    invocationId,
    sourceClass: "validated_input",
    owner,
    purpose: "validated_input",
    observedAt: evaluatedAt,
    reference: { kind: "validated_input", sourceId: validatedInputSourceId },
  });
  return evidenceSourceSchema.parse({
    ...sourceRecord,
    recordDigest: createEvidenceSourceRecordDigest(
      definition,
      layout,
      bound.slot,
      sourceRecord,
      claims,
    ),
  });
};

const createValidatedReplayFixture = (
  localCapabilityId: string,
  conclusions: readonly ConclusionIdentityDeclaration[],
  value: CanonicalJson,
) => {
  const localDefinition = createEvmEvidenceReplayDefinition({
    capabilityId: localCapabilityId,
    conclusions,
    warningCodes: [],
  });
  const supportFact = createEvidenceFactIdentityDeclaration(localDefinition, "input");
  const sourceId = `input:${localCapabilityId}`;
  const supportTarget = createEvidenceObservationTargetDeclaration(localDefinition, {
    slotId: "input",
    fact: supportFact,
    kind: "validated_input",
    purpose: "validated_input",
    owner: validatedInputOwner,
    sourceId,
    roles: { value: "validated_input" },
  });
  const layout = createEvidenceReplayLayout(localDefinition, [supportTarget]);
  const bound = createEvidenceReplayBinder(localDefinition, layout).bind(supportTarget);
  const claims = [{ role: bound.roles.value, value }];
  const observationId = createEvidenceObservationId(localDefinition, layout, {
    slot: bound.slot,
    sourceId,
    observedAt: evaluatedAt,
    invocationId,
  });
  const sourceRecord = evidenceSourceRecordSchema.parse({
    observationId,
    invocationId,
    sourceClass: "validated_input",
    owner: validatedInputOwner,
    purpose: "validated_input",
    observedAt: evaluatedAt,
    reference: { kind: "validated_input", sourceId },
  });
  const source = evidenceSourceSchema.parse({
    ...sourceRecord,
    recordDigest: createEvidenceSourceRecordDigest(
      localDefinition,
      layout,
      bound.slot,
      sourceRecord,
      claims,
    ),
  });
  return { localDefinition, supportFact, layout, bound, claims, observationId, source };
};

describe("public evidence replay", () => {
  it("keeps the observation ordinal private while matching an independent SHA-256 oracle", () => {
    const { layout, bound } = createLayout();
    const observationId = createEvidenceObservationId(definition, layout, {
      slot: bound.slot,
      sourceId: validatedInputSourceId,
      observedAt: evaluatedAt,
      invocationId,
    });
    const expected = createHash("sha256")
      .update(JSON.stringify([
        validatedInputSourceId,
        "validated_input",
        evaluatedAt,
        null,
        invocationId,
        "0",
      ]), "utf8")
      .digest("base64url");
    expect(`obs:${expected}`).toBe("obs:-eskheVa4lSC7v4tQ9_qCYc1RJ1lWLUWVEwQBKpOwqQ");
    expect(observationId).toBe(`obs:${expected}`);
    expect(readEvidenceReplaySlots(definition, layout)).toEqual([{
      slotId: "input",
      factId: "input",
      kind: "validated_input",
      purpose: "validated_input",
    }]);
    expect(Object.hasOwn(readEvidenceReplaySlots(definition, layout)[0] ?? {}, "ordinal")).toBe(false);
    expect(createEvidenceObservationId(definition, layout, {
      slot: bound.slot,
      sourceId: validatedInputSourceId,
      observedAt: evaluatedAt,
      invocationId,
      ordinal: "99",
    } as never)).toBe(observationId);
  });

  it("keeps observation identity separate from the record digest", () => {
    const { layout } = createLayout();
    const original = createSource(layout, validatedInputOwner, { value: "safe" });
    const changed = createSource(layout, validatedInputOwner, { value: "changed" });
    expect(changed.observationId).toBe(original.observationId);
    expect(changed.recordDigest).not.toBe(original.recordDigest);
  });

  it("derives the complete public result from definition- and layout-bound declarations", () => {
    const { layout, bound } = createLayout();
    const source = createSource(layout);
    expect(replayPublicEvidence({
      definition,
      layout,
      observationExpectations: [{
        slot: bound.slot,
        claims: [{ role: bound.roles.value, value: { value: "safe" } }],
      }],
      observationReferences: [],
      factRequirements: [{
        fact,
        observationSlots: [bound.slot],
        requiredObservationSlots: [bound.slot],
        minimumObservationCount: 1,
        outcome: "validated_input",
      }],
      conclusionDrafts: [{
        conclusion,
        outcomeFact: fact,
        evidenceFacts: [fact],
        freshnessRuleId: "validated_input_current",
      }],
      warningRequirements: [],
      evaluatedAt,
      sources: [source],
    })).toEqual({
      conclusions: [{
        id: "input_validated",
        status: "established",
        reason: "validated_input",
        observationIds: [source.observationId],
        freshness: {
          status: "fresh",
          ruleId: "validated_input_current",
          evaluatedAt,
          observationIds: [source.observationId],
        },
      }],
      coverage: {
        status: "complete",
        established: ["input_validated"],
        notApplicable: [],
        unavailable: [],
      },
      warnings: [],
    });
  });

  it("rejects a producer that omits a definition-owned fixed conclusion", () => {
    const firstConclusion = createExactConclusionIdentityDeclaration("first_observed");
    const secondConclusion = createExactConclusionIdentityDeclaration("second_observed");
    const { localDefinition, supportFact, layout, bound, claims, source } =
      createValidatedReplayFixture(
        "test.required_conclusions",
        [firstConclusion, secondConclusion],
        { value: "safe" },
      );
    expect(() => replayPublicEvidence({
      definition: localDefinition,
      layout,
      observationExpectations: [{ slot: bound.slot, claims }],
      observationReferences: [],
      factRequirements: [{
        fact: supportFact,
        observationSlots: [bound.slot],
        requiredObservationSlots: [bound.slot],
        minimumObservationCount: 1,
        outcome: "validated_input",
      }],
      conclusionDrafts: [{
        conclusion: firstConclusion,
        outcomeFact: supportFact,
        evidenceFacts: [supportFact],
        freshnessRuleId: "validated_input_current",
      }],
      warningRequirements: [],
      evaluatedAt,
      sources: [source],
    })).toThrow("incomplete or undeclared");
  });

  it("selects exactly one definition-owned result conclusion set", () => {
    const baseConclusion = createExactConclusionIdentityDeclaration("base_observed");
    const emptyConclusion = createExactConclusionIdentityDeclaration("empty_observed");
    const presentConclusion = createExactConclusionIdentityDeclaration("present_observed");
    const emptySet = createEvidenceConclusionSetDeclaration([emptyConclusion]);
    const presentSet = createEvidenceConclusionSetDeclaration([presentConclusion]);
    const localDefinition = createEvmEvidenceReplayDefinition({
      capabilityId: "test.result_sets",
      conclusions: [baseConclusion],
      conclusionSets: [emptySet, presentSet],
      warningCodes: [],
    });
    const supportFact = createEvidenceFactIdentityDeclaration(localDefinition, "input");
    const sourceId = "input:test.result_sets";
    const supportTarget = createEvidenceObservationTargetDeclaration(localDefinition, {
      slotId: "input",
      fact: supportFact,
      kind: "validated_input",
      purpose: "validated_input",
      owner: validatedInputOwner,
      sourceId,
      roles: { value: "validated_input" },
    });
    const layout = createEvidenceReplayLayout(localDefinition, [supportTarget]);
    const bound = createEvidenceReplayBinder(localDefinition, layout).bind(supportTarget);
    const claims = [{ role: bound.roles.value, value: { value: "safe" } }];
    const observationId = createEvidenceObservationId(localDefinition, layout, {
      slot: bound.slot,
      sourceId,
      observedAt: evaluatedAt,
      invocationId,
    });
    const sourceRecord = evidenceSourceRecordSchema.parse({
      observationId,
      invocationId,
      sourceClass: "validated_input",
      owner: validatedInputOwner,
      purpose: "validated_input",
      observedAt: evaluatedAt,
      reference: { kind: "validated_input", sourceId },
    });
    const source = evidenceSourceSchema.parse({
      ...sourceRecord,
      recordDigest: createEvidenceSourceRecordDigest(
        localDefinition,
        layout,
        bound.slot,
        sourceRecord,
        claims,
      ),
    });
    const common = {
      definition: localDefinition,
      layout,
      observationExpectations: [{ slot: bound.slot, claims }],
      observationReferences: [],
      factRequirements: [{
        fact: supportFact,
        observationSlots: [bound.slot],
        requiredObservationSlots: [bound.slot],
        minimumObservationCount: 1,
        outcome: "validated_input" as const,
      }],
      warningRequirements: [],
      evaluatedAt,
      sources: [source],
    };
    const draft = (candidate: typeof baseConclusion) => ({
      conclusion: candidate,
      outcomeFact: supportFact,
      evidenceFacts: [supportFact],
      freshnessRuleId: "validated_input_current" as const,
    });

    expect(readEvidenceReplayConclusionIds(localDefinition)).toEqual([
      "base_observed",
      "empty_observed",
      "present_observed",
    ]);
    expect(replayPublicEvidence({
      ...common,
      conclusionSet: emptySet,
      conclusionDrafts: [draft(baseConclusion), draft(emptyConclusion)],
    }).conclusions.map((entry) => entry.id)).toEqual([
      "base_observed",
      "empty_observed",
    ]);
    expect(replayPublicEvidence({
      ...common,
      conclusionSet: presentSet,
      conclusionDrafts: [draft(baseConclusion), draft(presentConclusion)],
    }).conclusions.map((entry) => entry.id)).toEqual([
      "base_observed",
      "present_observed",
    ]);
    expect(() => replayPublicEvidence({
      ...common,
      conclusionDrafts: [draft(baseConclusion), draft(emptyConclusion)],
    })).toThrow("selection");
    expect(() => replayPublicEvidence({
      ...common,
      conclusionSet: emptySet,
      conclusionDrafts: [draft(baseConclusion), draft(presentConclusion)],
    })).toThrow("incomplete or undeclared");
    expect(() => replayPublicEvidence({
      ...common,
      conclusionSet: {} as never,
      conclusionDrafts: [draft(baseConclusion), draft(emptyConclusion)],
    })).toThrow("selection");
    const foreignFirst = createEvidenceConclusionSetDeclaration([
      createExactConclusionIdentityDeclaration("foreign_first"),
    ]);
    const foreignSecond = createEvidenceConclusionSetDeclaration([
      createExactConclusionIdentityDeclaration("foreign_second"),
    ]);
    createEvmEvidenceReplayDefinition({
      capabilityId: "test.foreign_sets",
      conclusions: [createExactConclusionIdentityDeclaration("foreign_base")],
      conclusionSets: [foreignFirst, foreignSecond],
      warningCodes: [],
    });
    expect(() => replayPublicEvidence({
      ...common,
      conclusionSet: foreignFirst,
      conclusionDrafts: [draft(baseConclusion), draft(emptyConclusion)],
    })).toThrow("selection");
    const regular = createLayout();
    const regularSource = createSource(regular.layout);
    expect(() => replayPublicEvidence({
      definition,
      layout: regular.layout,
      conclusionSet: emptySet,
      observationExpectations: [{
        slot: regular.bound.slot,
        claims: [{ role: regular.bound.roles.value, value: { value: "safe" } }],
      }],
      observationReferences: [],
      factRequirements: [{
        fact,
        observationSlots: [regular.bound.slot],
        requiredObservationSlots: [regular.bound.slot],
        minimumObservationCount: 1,
        outcome: "validated_input",
      }],
      conclusionDrafts: [{
        conclusion,
        outcomeFact: fact,
        evidenceFacts: [fact],
        freshnessRuleId: "validated_input_current",
      }],
      warningRequirements: [],
      evaluatedAt,
      sources: [regularSource],
    })).toThrow("not declared");
    expect(() => createEvmEvidenceReplayDefinition({
      capabilityId: "test.result_set_reuse",
      conclusions: [createExactConclusionIdentityDeclaration("reuse_base")],
      conclusionSets: [
        emptySet,
        createEvidenceConclusionSetDeclaration([
          createExactConclusionIdentityDeclaration("reuse_other"),
        ]),
      ],
      warningCodes: [],
    })).toThrow("owner");
  });

  it("rejects malformed result conclusion-set definitions", () => {
    expect(() => createEvidenceConclusionSetDeclaration([])).toThrow("set");
    const base = createExactConclusionIdentityDeclaration("set_base");
    const shared = createExactConclusionIdentityDeclaration("set_shared");
    expect(() => createEvmEvidenceReplayDefinition({
      capabilityId: "test.single_set",
      conclusions: [base],
      conclusionSets: [createEvidenceConclusionSetDeclaration([shared])],
      warningCodes: [],
    })).toThrow("sets");
    expect(() => createEvmEvidenceReplayDefinition({
      capabilityId: "test.duplicate_set_contents",
      conclusions: [base],
      conclusionSets: [
        createEvidenceConclusionSetDeclaration([shared]),
        createEvidenceConclusionSetDeclaration([shared]),
      ],
      warningCodes: [],
    })).toThrow("contents");
    const leftOnly = createExactConclusionIdentityDeclaration("set_left_only");
    const rightOnly = createExactConclusionIdentityDeclaration("set_right_only");
    expect(() => createEvmEvidenceReplayDefinition({
      capabilityId: "test.overlapping_sets",
      conclusions: [base],
      conclusionSets: [
        createEvidenceConclusionSetDeclaration([shared, leftOnly]),
        createEvidenceConclusionSetDeclaration([shared, rightOnly]),
      ],
      warningCodes: [],
    })).toThrow("Duplicate conclusion identity");

    const declarations = Array.from({ length: 65 }, (_, index) =>
      createExactConclusionIdentityDeclaration(`set_capacity_${String(index).padStart(2, "0")}`));
    expect(() => createEvmEvidenceReplayDefinition({
      capabilityId: "test.set_capacity",
      conclusions: [declarations[0] as typeof base],
      conclusionSets: [
        createEvidenceConclusionSetDeclaration(declarations.slice(1, 33)),
        createEvidenceConclusionSetDeclaration(declarations.slice(33)),
      ],
      warningCodes: [],
    })).toThrow("conclusion declarations");
  });

  it("combines one result conclusion set with one input-scoped conclusion family", () => {
    const base = createExactConclusionIdentityDeclaration("scoped_base");
    const first = createExactConclusionIdentityDeclaration("scoped_first");
    const second = createExactConclusionIdentityDeclaration("scoped_second");
    const firstSet = createEvidenceConclusionSetDeclaration([first]);
    const secondSet = createEvidenceConclusionSetDeclaration([second]);
    const family = createEvmAddressConclusionIdentityDeclaration("scoped_address:");
    const localDefinition = createEvmEvidenceReplayDefinition({
      capabilityId: "test.scoped_result_set",
      conclusions: [base, family],
      conclusionSets: [firstSet, secondSet],
      warningCodes: [],
    });
    const address = evmAddressSchema.parse(`0x${"3".repeat(40)}`);
    const scope = createEvidenceDeclarationScope(localDefinition);
    const addressConclusion = createEvmAddressConclusionIdentity(family, address);
    const supportFact = createEvidenceFactIdentityForConclusion(
      localDefinition,
      addressConclusion,
      scope,
    );
    const sourceId = "input:test.scoped_result_set";
    const supportTarget = createEvidenceObservationTargetDeclaration(localDefinition, {
      slotId: `scoped_address:${address}`,
      fact: supportFact,
      kind: "validated_input",
      purpose: "scoped_result_set",
      owner: validatedInputOwner,
      sourceId,
      roles: { value: addressConclusion },
    });
    const layout = createEvidenceReplayLayout(localDefinition, [supportTarget]);
    const bound = createEvidenceReplayBinder(localDefinition, layout).bind(supportTarget);
    const claims = [{ role: bound.roles.value, value: address }];
    const observationId = createEvidenceObservationId(localDefinition, layout, {
      slot: bound.slot,
      sourceId,
      observedAt: evaluatedAt,
      invocationId,
    });
    const sourceRecord = evidenceSourceRecordSchema.parse({
      observationId,
      invocationId,
      sourceClass: "validated_input",
      owner: validatedInputOwner,
      purpose: "scoped_result_set",
      observedAt: evaluatedAt,
      reference: { kind: "validated_input", sourceId },
    });
    const source = evidenceSourceSchema.parse({
      ...sourceRecord,
      recordDigest: createEvidenceSourceRecordDigest(
        localDefinition,
        layout,
        bound.slot,
        sourceRecord,
        claims,
      ),
    });
    const draft = (candidate: typeof base) => ({
      conclusion: candidate,
      outcomeFact: supportFact,
      evidenceFacts: [supportFact],
      freshnessRuleId: "validated_input_current" as const,
    });

    expect(replayPublicEvidence({
      definition: localDefinition,
      layout,
      conclusionSet: firstSet,
      observationExpectations: [{ slot: bound.slot, claims }],
      observationReferences: [],
      factRequirements: [{
        fact: supportFact,
        observationSlots: [bound.slot],
        requiredObservationSlots: [bound.slot],
        minimumObservationCount: 1,
        outcome: "validated_input",
      }],
      conclusionDrafts: [draft(base), draft(first), draft(addressConclusion)],
      warningRequirements: [],
      evaluatedAt,
      sources: [source],
    }).conclusions.map((entry) => entry.id)).toEqual([
      "scoped_address:0x3333333333333333333333333333333333333333",
      "scoped_base",
      "scoped_first",
    ]);
  });

  it("permits an unused possible source target without permitting unowned evidence", () => {
    const localConclusion = createExactConclusionIdentityDeclaration("selected_observed");
    const localDefinition = createEvmEvidenceReplayDefinition({
      capabilityId: "test.possible_targets",
      conclusions: [localConclusion],
      warningCodes: [],
    });
    const selectedFact = createEvidenceFactIdentityDeclaration(localDefinition, "selected");
    const optionalFact = createEvidenceFactIdentityDeclaration(localDefinition, "optional");
    const selectedTarget = createEvidenceObservationTargetDeclaration(localDefinition, {
      slotId: "selected",
      fact: selectedFact,
      kind: "validated_input",
      purpose: "selected_input",
      owner: validatedInputOwner,
      sourceId: "input:test.possible_targets",
      roles: { value: "selected_input" },
    });
    const optionalTarget = createEvidenceObservationTargetDeclaration(localDefinition, {
      slotId: "optional",
      fact: optionalFact,
      kind: "validated_input",
      purpose: "optional_input",
      owner: validatedInputOwner,
      sourceId: "input:test.possible_targets",
      roles: { value: "optional_input" },
    });
    const layout = createEvidenceReplayLayout(localDefinition, [selectedTarget, optionalTarget]);
    const binder = createEvidenceReplayBinder(localDefinition, layout);
    const selected = binder.bind(selectedTarget);
    const optional = binder.bind(optionalTarget);
    const selectedClaims = [{ role: selected.roles.value, value: { value: "safe" } }];
    const selectedObservationId = createEvidenceObservationId(localDefinition, layout, {
      slot: selected.slot,
      sourceId: "input:test.possible_targets",
      observedAt: evaluatedAt,
      invocationId,
    });
    const selectedRecord = evidenceSourceRecordSchema.parse({
      observationId: selectedObservationId,
      invocationId,
      sourceClass: "validated_input",
      owner: validatedInputOwner,
      purpose: "selected_input",
      observedAt: evaluatedAt,
      reference: { kind: "validated_input", sourceId: "input:test.possible_targets" },
    });
    const selectedSource = evidenceSourceSchema.parse({
      ...selectedRecord,
      recordDigest: createEvidenceSourceRecordDigest(
        localDefinition,
        layout,
        selected.slot,
        selectedRecord,
        selectedClaims,
      ),
    });
    const optionalClaims = [{ role: optional.roles.value, value: { value: "safe" } }];
    const optionalObservationId = createEvidenceObservationId(localDefinition, layout, {
      slot: optional.slot,
      sourceId: "input:test.possible_targets",
      observedAt: evaluatedAt,
      invocationId,
    });
    const optionalRecord = evidenceSourceRecordSchema.parse({
      observationId: optionalObservationId,
      invocationId,
      sourceClass: "validated_input",
      owner: validatedInputOwner,
      purpose: "optional_input",
      observedAt: evaluatedAt,
      reference: { kind: "validated_input", sourceId: "input:test.possible_targets" },
    });
    const optionalSource = evidenceSourceSchema.parse({
      ...optionalRecord,
      recordDigest: createEvidenceSourceRecordDigest(
        localDefinition,
        layout,
        optional.slot,
        optionalRecord,
        optionalClaims,
      ),
    });
    const common = {
      definition: localDefinition,
      layout,
      observationReferences: [],
      factRequirements: [{
        fact: selectedFact,
        observationSlots: [selected.slot],
        requiredObservationSlots: [selected.slot],
        minimumObservationCount: 1,
        outcome: "validated_input" as const,
      }],
      conclusionDrafts: [{
        conclusion: localConclusion,
        outcomeFact: selectedFact,
        evidenceFacts: [selectedFact],
        freshnessRuleId: "validated_input_current" as const,
      }],
      warningRequirements: [],
      evaluatedAt,
    };

    expect(replayPublicEvidence({
      ...common,
      observationExpectations: [{ slot: selected.slot, claims: selectedClaims }],
      sources: [selectedSource],
    }).conclusions).toHaveLength(1);
    expect(() => replayPublicEvidence({
      ...common,
      observationExpectations: [
        { slot: selected.slot, claims: selectedClaims },
        { slot: optional.slot, claims: [{ role: optional.roles.value, value: { value: "safe" } }] },
      ],
      sources: [selectedSource],
    })).toThrow("expectation has no owning fact");
    expect(() => replayPublicEvidence({
      ...common,
      observationExpectations: [{ slot: selected.slot, claims: selectedClaims }],
      sources: [selectedSource, optionalSource].sort((left, right) =>
        left.observationId < right.observationId ? -1 : 1),
    })).toThrow("no definition-owned expectation");
  });

  it("enforces separate replay conclusion, observation, and fact capacities", () => {
    const conclusionDeclarations = Array.from(
      { length: 65 },
      (_, index) => createExactConclusionIdentityDeclaration(
        `bounded_conclusion_${String(index).padStart(2, "0")}`,
      ),
    );
    expect(() => createEvmEvidenceReplayDefinition({
      capabilityId: "test.excessive_conclusions",
      conclusions: conclusionDeclarations,
      warningCodes: [],
    })).toThrow("conclusion declarations");
    expect(() => createEvmEvidenceReplayDefinition({
      capabilityId: "test.maximum_conclusions",
      conclusions: conclusionDeclarations.slice(0, 64),
      warningCodes: [],
    })).not.toThrow();

    const layoutConclusion = createExactConclusionIdentityDeclaration("layout_observed");
    const layoutDefinition = createEvmEvidenceReplayDefinition({
      capabilityId: "test.layout_limit",
      conclusions: [layoutConclusion],
      warningCodes: [],
    });
    const layoutTargets = Array.from({ length: 129 }, (_, index) => {
      const suffix = String(index).padStart(3, "0");
      const layoutFact = createEvidenceFactIdentityDeclaration(
        layoutDefinition,
        `layout_fact_${suffix}`,
      );
      return createEvidenceObservationTargetDeclaration(layoutDefinition, {
        slotId: `layout_slot_${suffix}`,
        fact: layoutFact,
        kind: "source",
        purpose: "layout_limit",
        sourceClass: "chain_rpc",
        roles: { value: "value" },
      });
    });
    expect(() => createEvidenceReplayLayout(layoutDefinition, layoutTargets))
      .toThrow("layout targets");
    expect(() => createEvidenceReplayLayout(layoutDefinition, layoutTargets.slice(0, 128)))
      .not.toThrow();

    const factLimitConclusion = createExactConclusionIdentityDeclaration("fact_limit_observed");
    const {
      localDefinition,
      supportFact,
      layout,
      bound,
      claims,
      source,
    } = createValidatedReplayFixture(
      "test.fact_limit",
      [factLimitConclusion],
      { value: "safe" },
    );
    const extraFacts = Array.from({ length: 128 }, (_, index) =>
      createEvidenceFactIdentityDeclaration(
        localDefinition,
        `unused_fact_${String(index).padStart(3, "0")}`,
      ));
    const factRequirements = [{
      fact: supportFact,
      observationSlots: [bound.slot],
      requiredObservationSlots: [bound.slot],
      minimumObservationCount: 1,
      outcome: "validated_input" as const,
    }, ...extraFacts.map((extraFact) => ({
      fact: extraFact,
      observationSlots: [],
      requiredObservationSlots: [],
      minimumObservationCount: 0,
      outcome: "not_requested" as const,
    }))];
    const replayInput = {
      definition: localDefinition,
      layout,
      observationExpectations: [{ slot: bound.slot, claims }],
      observationReferences: [],
      conclusionDrafts: [{
        conclusion: factLimitConclusion,
        outcomeFact: supportFact,
        evidenceFacts: [supportFact],
        freshnessRuleId: "validated_input_current" as const,
      }],
      warningRequirements: [],
      evaluatedAt,
      sources: [source],
    };
    expect(() => replayPublicEvidence({
      ...replayInput,
      factRequirements,
    })).toThrow("fact requirements");
    expect(replayPublicEvidence({
      ...replayInput,
      factRequirements: factRequirements.slice(0, 128),
    }).conclusions).toHaveLength(1);
  });

  it("enforces one claim-role capacity across static and dynamic registration", () => {
    const localConclusion = createExactConclusionIdentityDeclaration("roles_observed");
    const localDefinition = createEvmEvidenceReplayDefinition({
      capabilityId: "test.role_capacity",
      conclusions: [localConclusion],
      warningCodes: [],
    });
    const localFact = createEvidenceFactIdentityDeclaration(localDefinition, "roles");
    const staticRoles = Object.fromEntries(Array.from({ length: 8_191 }, (_, index) => {
      const identity = `role_${String(index).padStart(4, "0")}`;
      return [identity, identity];
    }));
    expect(() => createEvidenceObservationTargetDeclaration(localDefinition, {
      slotId: "excessive_roles",
      fact: localFact,
      kind: "source",
      purpose: "role_capacity",
      sourceClass: "chain_rpc",
      roles: {
        ...staticRoles,
        role_8191: "role_8191",
        role_8192: "role_8192",
      },
    })).toThrow("claim-role capacity");
    const localTarget = createEvidenceObservationTargetDeclaration(localDefinition, {
      slotId: "roles",
      fact: localFact,
      kind: "source",
      purpose: "role_capacity",
      sourceClass: "chain_rpc",
      roles: staticRoles,
    });
    const finalRole = createEvidenceClaimRoleDeclaration(
      localDefinition,
      localTarget,
      "role_8191",
    );
    expect(() => createEvidenceClaimRoleDeclaration(
      localDefinition,
      localTarget,
      "role_8191",
    )).toThrow("Duplicate");
    expect(() => createEvidenceClaimRoleDeclaration(
      localDefinition,
      localTarget,
      "role_8192",
    )).toThrow("capacity");

    const layout = createEvidenceReplayLayout(localDefinition, [localTarget]);
    const binder = createEvidenceReplayBinder(localDefinition, layout);
    const boundTarget = binder.bind(localTarget);
    const boundRole = binder.bindRole(finalRole);
    expect(captureEvidenceObservationClaims(
      localDefinition,
      layout,
      boundTarget.slot,
      [{ role: boundRole, value: "at_limit" }],
    )).toEqual([{ role: boundRole, value: "at_limit" }]);
  });

  it("enforces replay-reference capacity independently across targets", () => {
    const localConclusion = createExactConclusionIdentityDeclaration("references_observed");
    const localDefinition = createEvmEvidenceReplayDefinition({
      capabilityId: "test.reference_capacity",
      conclusions: [localConclusion],
      warningCodes: [],
    });
    const firstFact = createEvidenceFactIdentityDeclaration(localDefinition, "first");
    const secondFact = createEvidenceFactIdentityDeclaration(localDefinition, "second");
    const firstRoles = Object.fromEntries(Array.from({ length: 8_192 }, (_, index) => {
      const identity = `reference_${String(index).padStart(4, "0")}`;
      return [identity, identity];
    }));
    const firstTarget = createEvidenceObservationTargetDeclaration(localDefinition, {
      slotId: "first",
      fact: firstFact,
      kind: "source",
      purpose: "reference_first",
      sourceClass: "chain_rpc",
      roles: firstRoles,
    });
    const secondTarget = createEvidenceObservationTargetDeclaration(localDefinition, {
      slotId: "second",
      fact: secondFact,
      kind: "source",
      purpose: "reference_second",
      sourceClass: "chain_rpc",
      roles: { value: "reference_extra" },
    });
    const layout = createEvidenceReplayLayout(localDefinition, [firstTarget, secondTarget]);
    const binder = createEvidenceReplayBinder(localDefinition, layout);
    const firstBound = binder.bind(firstTarget);
    const secondBound = binder.bind(secondTarget);
    const anchor = chainAnchorSchema.parse({
      chainId: "eip155:4663",
      blockNumber: "1",
      blockHash: `0x${"1".repeat(64)}`,
      blockTimestamp: evaluatedAt,
    });
    const firstClaims = Object.values(firstBound.roles).map((role, index) => ({
      role,
      value: String(index),
      chainAnchor: anchor,
    }));
    const secondClaims = [{
      role: secondBound.roles.value,
      value: "extra",
      chainAnchor: anchor,
    }];
    const reference = {
      kind: "public" as const,
      sourceId: "rpc_capacity",
      uri: "https://rpc.example/",
    };
    const firstObservationId = createEvidenceObservationId(localDefinition, layout, {
      slot: firstBound.slot,
      sourceId: reference.sourceId,
      observedAt: evaluatedAt,
      chainAnchor: anchor,
      invocationId,
    });
    const secondObservationId = createEvidenceObservationId(localDefinition, layout, {
      slot: secondBound.slot,
      sourceId: reference.sourceId,
      observedAt: evaluatedAt,
      chainAnchor: anchor,
      invocationId,
    });
    const firstSourceRecord = evidenceSourceRecordSchema.parse({
      observationId: firstObservationId,
      invocationId,
      sourceClass: "chain_rpc",
      owner: "Capacity fixture RPC",
      purpose: "reference_first",
      observedAt: evaluatedAt,
      reference,
      chainAnchor: anchor,
    });
    const secondSourceRecord = evidenceSourceRecordSchema.parse({
      observationId: secondObservationId,
      invocationId,
      sourceClass: "chain_rpc",
      owner: "Capacity fixture RPC",
      purpose: "reference_second",
      observedAt: evaluatedAt,
      reference,
      chainAnchor: anchor,
    });
    const sources = [
      evidenceSourceSchema.parse({
        ...firstSourceRecord,
        recordDigest: createEvidenceSourceRecordDigest(
          localDefinition,
          layout,
          firstBound.slot,
          firstSourceRecord,
          firstClaims,
        ),
      }),
      evidenceSourceSchema.parse({
        ...secondSourceRecord,
        recordDigest: createEvidenceSourceRecordDigest(
          localDefinition,
          layout,
          secondBound.slot,
          secondSourceRecord,
          secondClaims,
        ),
      }),
    ].sort((left, right) => left.observationId === right.observationId
      ? 0
      : left.observationId < right.observationId ? -1 : 1);
    const references = Object.values(firstBound.roles).map((role) => ({
      observationId: firstObservationId,
      slot: firstBound.slot,
      role,
    }));
    const replayInput = {
      definition: localDefinition,
      layout,
      observationExpectations: [
        { slot: firstBound.slot, claims: firstClaims },
        { slot: secondBound.slot, claims: secondClaims },
      ],
      factRequirements: [
        {
          fact: firstFact,
          observationSlots: [firstBound.slot],
          requiredObservationSlots: [firstBound.slot],
          minimumObservationCount: 1,
          outcome: "observed" as const,
        },
        {
          fact: secondFact,
          observationSlots: [secondBound.slot],
          requiredObservationSlots: [secondBound.slot],
          minimumObservationCount: 1,
          outcome: "observed" as const,
        },
      ],
      conclusionDrafts: [{
        conclusion: localConclusion,
        outcomeFact: firstFact,
        evidenceFacts: [firstFact, secondFact],
        freshnessRuleId: "chain_anchor_exact" as const,
      }],
      warningRequirements: [],
      evaluatedAt,
      sources,
    };

    expect(replayPublicEvidence({
      ...replayInput,
      observationReferences: references,
    }).conclusions).toHaveLength(1);
    expect(() => replayPublicEvidence({
      ...replayInput,
      observationReferences: [...references, {
        observationId: secondObservationId,
        slot: secondBound.slot,
        role: secondBound.roles.value,
      }],
    })).toThrow("Public observation references");
  });

  it("requires separate admitted evidence for a slotless none-authority outcome", () => {
    const localConclusion = createExactConclusionIdentityDeclaration("required_observation");
    const {
      localDefinition,
      supportFact,
      layout,
      bound,
      claims,
      observationId,
      source,
    } = createValidatedReplayFixture(
      "test.none_authority",
      [localConclusion],
      { requested: true },
    );
    const outcomeFact = createEvidenceFactIdentityDeclaration(localDefinition, "outcome");
    const common = {
      definition: localDefinition,
      layout,
      observationExpectations: [{ slot: bound.slot, claims }],
      observationReferences: [],
      warningRequirements: [],
      evaluatedAt,
      sources: [source],
    } as const;
    const outcomeRequirement = {
      fact: outcomeFact,
      observationSlots: [],
      requiredObservationSlots: [],
      minimumObservationCount: 0,
      outcome: "not_observed" as const,
    };
    const supportRequirement = {
      fact: supportFact,
      observationSlots: [bound.slot],
      requiredObservationSlots: [bound.slot],
      minimumObservationCount: 1,
      outcome: "validated_input" as const,
    };
    const factRequirements = [outcomeRequirement, supportRequirement];
    const result = replayPublicEvidence({
      ...common,
      factRequirements,
      conclusionDrafts: [{
        conclusion: localConclusion,
        outcomeFact,
        evidenceFacts: [supportFact],
        freshnessRuleId: "validated_input_current",
      }],
    });
    expect(result.conclusions[0]).toMatchObject({
      id: "required_observation",
      status: "unavailable",
      reason: "not_observed",
      observationIds: [observationId],
    });
    expect(result.coverage.status).toBe("unavailable");
    for (const outcome of ["source_failed", "validated_input"] as const) {
      expect(() => replayPublicEvidence({
        ...common,
        factRequirements: [{
          ...outcomeRequirement,
          outcome,
        }, supportRequirement],
        conclusionDrafts: [{
          conclusion: localConclusion,
          outcomeFact,
          evidenceFacts: [supportFact],
          freshnessRuleId: "validated_input_current",
        }],
      })).toThrow("requires an observation slot");
    }
    expect(() => replayPublicEvidence({
      ...common,
      factRequirements,
      conclusionDrafts: [{
        conclusion: localConclusion,
        outcomeFact,
        evidenceFacts: [outcomeFact],
        freshnessRuleId: "validated_input_current",
      }],
    })).toThrow("freshness requires evidence");
  });

  it("rejects forged, foreign-definition, and foreign-layout declarations", () => {
    const { layout, bound } = createLayout();
    const otherConclusion = createExactConclusionIdentityDeclaration("other");
    const otherDefinition = createEvmEvidenceReplayDefinition({
      capabilityId: "test.other",
      conclusions: [otherConclusion],
      warningCodes: [],
    });
    const otherFact = createEvidenceFactIdentityDeclaration(otherDefinition, "input");
    const otherTarget = createEvidenceObservationTargetDeclaration(otherDefinition, {
      slotId: "input",
      fact: otherFact,
      kind: "validated_input",
      purpose: "validated_input",
      owner: "Other validated input",
      sourceId: "input:test.other",
      roles: { value: "validated_input" },
    });
    const otherLayout = createEvidenceReplayLayout(otherDefinition, [otherTarget]);

    expect(() => createEvidenceReplayLayout(otherDefinition, [target])).toThrow("provenance");
    expect(() => createEvidenceObservationId(definition, layout, {
      slot: {} as never,
      sourceId: validatedInputSourceId,
      observedAt: evaluatedAt,
      invocationId,
    })).toThrow("provenance");
    expect(() => captureEvidenceObservationClaims(definition, layout, bound.slot, [{
      role: createEvidenceReplayBinder(otherDefinition, otherLayout).bind(otherTarget).roles.value,
      value: "foreign",
    }])).toThrow("provenance");
    expect(() => createEvidenceReplayBinder(definition, otherLayout as never).bind(target))
      .toThrow("provenance");
  });

  it("binds dynamic roles to one target and rejects cross-layout use", () => {
    const dynamicConclusion = createExactConclusionIdentityDeclaration("dynamic_observed");
    const dynamicDefinition = createEvmEvidenceReplayDefinition({
      capabilityId: "test.dynamic",
      conclusions: [dynamicConclusion],
      warningCodes: [],
    });
    const dynamicFact = createEvidenceFactIdentityDeclaration(dynamicDefinition, "dynamic");
    const dynamicTarget = createEvidenceObservationTargetDeclaration(dynamicDefinition, {
      slotId: "dynamic",
      fact: dynamicFact,
      kind: "source",
      purpose: "dynamic",
      sourceClass: "chain_rpc",
      roles: { base: "base" },
    });
    const amountRole = createEvidenceClaimRoleDeclaration(
      dynamicDefinition,
      dynamicTarget,
      "amount:0",
    );
    expect(() => createEvidenceClaimRoleDeclaration(
      dynamicDefinition,
      dynamicTarget,
      "amount:0",
    )).toThrow("Duplicate");

    const firstLayout = createEvidenceReplayLayout(dynamicDefinition, [dynamicTarget]);
    const secondLayout = createEvidenceReplayLayout(dynamicDefinition, [dynamicTarget]);
    const firstBinder = createEvidenceReplayBinder(dynamicDefinition, firstLayout);
    const secondBinder = createEvidenceReplayBinder(dynamicDefinition, secondLayout);
    const firstTarget = firstBinder.bind(dynamicTarget);
    const firstRole = firstBinder.bindRole(amountRole);
    const secondRole = secondBinder.bindRole(amountRole);
    const firstClaims = [{ role: firstRole, value: "1" }];

    expect(captureEvidenceObservationClaims(
      dynamicDefinition,
      firstLayout,
      firstTarget.slot,
      firstClaims,
    )).toEqual(firstClaims);
    expect(evidenceObservationClaimsEqual(
      dynamicDefinition,
      firstLayout,
      firstTarget.slot,
      firstClaims,
      [{ role: firstRole, value: "1" }],
    )).toBe(true);
    expect(() => captureEvidenceObservationClaims(
      dynamicDefinition,
      firstLayout,
      firstTarget.slot,
      [{ role: secondRole, value: "1" }],
    )).toThrow("provenance");
  });

  it("uses typed EVM-address declarations as one immutable dynamic identity owner", () => {
    const address = evmAddressSchema.parse(`0x${"1".repeat(40)}`);
    const addressFamily = createEvmAddressConclusionIdentityDeclaration("address:");
    const otherFamily = createEvmAddressConclusionIdentityDeclaration("other:");
    const dynamicDefinition = createEvmEvidenceReplayDefinition({
      capabilityId: "test.disjoint",
      conclusions: [addressFamily, otherFamily],
      warningCodes: [],
    });
    expect(readEvidenceReplayConclusionIds(dynamicDefinition)).toEqual([
      "address:<address>",
      "other:<address>",
    ]);
    expect(typeof createEvmAddressConclusionIdentity(addressFamily, address)).toBe("object");
    expect(() => createEvmAddressConclusionIdentity({} as never, address))
      .toThrow("provenance");
    expect(() => createEvmEvidenceReplayDefinition({
      capabilityId: "test.reused",
      conclusions: [addressFamily],
      warningCodes: [],
    })).toThrow("owner");

    const overlapFamily = createEvmAddressConclusionIdentityDeclaration("address:");
    const overlapExact = createExactConclusionIdentityDeclaration(
      "address:0x0000000000000000000000000000000000000000",
    );
    expect(() => createEvmEvidenceReplayDefinition({
      capabilityId: "test.overlap",
      conclusions: [overlapFamily, overlapExact],
      warningCodes: [],
    })).toThrow("overlap");

    expect(() => createEvmEvidenceReplayDefinition({
      capabilityId: "test.duplicate",
      conclusions: [
        createEvmAddressConclusionIdentityDeclaration("duplicate:"),
        createEvmAddressConclusionIdentityDeclaration("duplicate:"),
      ],
      warningCodes: [],
    })).toThrow("Duplicate");
  });

  it("isolates dynamic declarations to one bounded input scope", () => {
    const address = evmAddressSchema.parse(`0x${"2".repeat(40)}`);
    const collisionFamily = createEvmAddressConclusionIdentityDeclaration("collision:");
    const collisionDefinition = createEvmEvidenceReplayDefinition({
      capabilityId: "test.collision",
      conclusions: [collisionFamily],
      warningCodes: [],
    });
    const collidingIdentity = `collision:${address}`;
    const staticFact = createEvidenceFactIdentityDeclaration(
      collisionDefinition,
      collidingIdentity,
    );
    const collisionScope = createEvidenceDeclarationScope(collisionDefinition);
    const collisionConclusion = createEvmAddressConclusionIdentity(
      collisionFamily,
      address,
    );
    expect(() => createEvidenceFactIdentityForConclusion(
      collisionDefinition,
      collisionConclusion,
      collisionScope,
    )).toThrow("Duplicate");
    expect(() => createEvidenceFactIdentityDeclaration(
      collisionDefinition,
      "late_static",
    )).toThrow("closed");
    expect(() => createEvidenceObservationTargetDeclaration(collisionDefinition, {
      slotId: "late_static",
      fact: staticFact,
      kind: "source",
      purpose: "late_static",
      sourceClass: "chain_rpc",
      roles: { value: "late_static" },
    })).toThrow("closed");

    const family = createEvmAddressConclusionIdentityDeclaration("scoped:");
    const scopedDefinition = createEvmEvidenceReplayDefinition({
      capabilityId: "test.scoped",
      conclusions: [family],
      warningCodes: [],
    });
    const firstScope = createEvidenceDeclarationScope(scopedDefinition);
    const secondScope = createEvidenceDeclarationScope(scopedDefinition);
    const firstConclusion = createEvmAddressConclusionIdentity(family, address);
    const secondConclusion = createEvmAddressConclusionIdentity(family, address);
    const firstFact = createEvidenceFactIdentityForConclusion(
      scopedDefinition,
      firstConclusion,
      firstScope,
    );
    expect(() => createEvidenceFactIdentityForConclusion(
      scopedDefinition,
      firstConclusion,
      firstScope,
    )).toThrow("Duplicate");
    const secondFact = createEvidenceFactIdentityForConclusion(
      scopedDefinition,
      secondConclusion,
      secondScope,
    );
    const firstTarget = createEvidenceObservationTargetDeclaration(scopedDefinition, {
      slotId: `scoped:${address}`,
      fact: firstFact,
      kind: "source",
      purpose: "scoped",
      sourceClass: "chain_rpc",
      roles: { value: firstConclusion },
    });
    const secondTarget = createEvidenceObservationTargetDeclaration(scopedDefinition, {
      slotId: `scoped:${address}`,
      fact: secondFact,
      kind: "source",
      purpose: "scoped",
      sourceClass: "chain_rpc",
      roles: { value: secondConclusion },
    });
    expect(() => createEvidenceReplayLayout(scopedDefinition, [
      firstTarget,
      secondTarget,
    ])).toThrow("mixes declaration scopes");
  });

  it("keeps validated-input private identity on the bound target", () => {
    const { layout, bound } = createLayout();
    expect(readBoundEvidenceObservationSlot(definition, layout, bound.slot)).toEqual({
      purpose: "validated_input",
      sourceClass: "validated_input",
      validatedInputIdentity: {
        owner: validatedInputOwner,
        sourceId: validatedInputSourceId,
      },
    });
    const source = createSource(layout, "Wrong owner", "safe");
    expect(() => replayPublicEvidence({
      definition,
      layout,
      observationExpectations: [{
        slot: bound.slot,
        claims: [{ role: bound.roles.value, value: "safe" }],
      }],
      observationReferences: [],
      factRequirements: [{
        fact,
        observationSlots: [bound.slot],
        requiredObservationSlots: [bound.slot],
        minimumObservationCount: 1,
        outcome: "validated_input",
      }],
      conclusionDrafts: [{
        conclusion,
        outcomeFact: fact,
        evidenceFacts: [fact],
        freshnessRuleId: "validated_input_current",
      }],
      warningRequirements: [],
      evaluatedAt,
      sources: [source],
    })).toThrow("Validated-input evidence identity");
  });

  it("rejects undeclared placeholder strings before they become declarations", () => {
    expect(() => createExactConclusionIdentityDeclaration(
      "<address>|0x0000000000000000000000000000000000000000",
    )).toThrow("placeholder");
  });
});
