import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  captureEvidenceObservationClaims,
  createEvidenceClaimRoleDeclaration,
  createEvidenceDeclarationScope,
  createEvidenceFactIdentityDeclaration,
  createEvidenceFactIdentityForConclusion,
  createEvidenceObservationId,
  createEvidenceObservationTargetDeclaration,
  createEvidenceReplayBinder,
  createEvidenceReplayDefinition,
  createEvidenceReplayLayout,
  createEvmAddressConclusionIdentity,
  createEvmAddressConclusionIdentityDeclaration,
  createExactConclusionIdentityDeclaration,
  evidenceObservationClaimsEqual,
  readBoundEvidenceObservationSlot,
  readEvidenceReplayConclusionIds,
  readEvidenceReplaySlots,
  replayPublicEvidence,
} from "../../src/core/evidence-replay.js";
import {
  evidenceSourceSchema,
  invocationIdSchema,
} from "../../src/core/evidence.js";
import { evmAddressSchema } from "../../src/core/identities.js";
import { productDisplayName } from "../../src/core/product-identity.js";
import { parseUtcTimestamp } from "../../src/core/primitives.js";

const capabilityId = "test.replay";
const evaluatedAt = parseUtcTimestamp("2026-07-24T00:00:00.000Z");
const invocationId = invocationIdSchema.parse(`inv:${Buffer.alloc(32, 7).toString("base64url")}`);
const validatedInputOwner = `${productDisplayName} validated input`;
const validatedInputSourceId = `input:${capabilityId}`;

const conclusion = createExactConclusionIdentityDeclaration("input_validated");
const definition = createEvidenceReplayDefinition({
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
) => {
  const bound = createEvidenceReplayBinder(definition, layout).bind(target);
  const observationId = createEvidenceObservationId(definition, layout, {
    slot: bound.slot,
    sourceId: validatedInputSourceId,
    observedAt: evaluatedAt,
    invocationId,
  });
  return evidenceSourceSchema.parse({
    observationId,
    invocationId,
    sourceClass: "validated_input",
    owner,
    purpose: "validated_input",
    observedAt: evaluatedAt,
    reference: { kind: "validated_input", sourceId: validatedInputSourceId },
  });
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
      expectedConclusions: [conclusion],
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

  it("rejects forged, foreign-definition, and foreign-layout declarations", () => {
    const { layout, bound } = createLayout();
    const otherConclusion = createExactConclusionIdentityDeclaration("other");
    const otherDefinition = createEvidenceReplayDefinition({
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
    const dynamicDefinition = createEvidenceReplayDefinition({
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
    const dynamicDefinition = createEvidenceReplayDefinition({
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
    expect(() => createEvidenceReplayDefinition({
      capabilityId: "test.reused",
      conclusions: [addressFamily],
      warningCodes: [],
    })).toThrow("owner");

    const overlapFamily = createEvmAddressConclusionIdentityDeclaration("address:");
    const overlapExact = createExactConclusionIdentityDeclaration(
      "address:0x0000000000000000000000000000000000000000",
    );
    expect(() => createEvidenceReplayDefinition({
      capabilityId: "test.overlap",
      conclusions: [overlapFamily, overlapExact],
      warningCodes: [],
    })).toThrow("overlap");

    expect(() => createEvidenceReplayDefinition({
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
    const collisionDefinition = createEvidenceReplayDefinition({
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
    const scopedDefinition = createEvidenceReplayDefinition({
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
    const source = createSource(layout, "Wrong owner");
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
      expectedConclusions: [conclusion],
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

  it("rejects obsolete placeholder strings before they become declarations", () => {
    expect(() => createExactConclusionIdentityDeclaration(
      "<address>|0x0000000000000000000000000000000000000000",
    )).toThrow("placeholder");
  });
});
