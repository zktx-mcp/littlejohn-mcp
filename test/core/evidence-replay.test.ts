import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createEvmAddressConclusionIdentity,
  createEvmAddressConclusionIdentityDeclaration,
  createEvidenceObservationId,
  createEvidenceReplayDefinition,
  createEvidenceReplayLayout,
  readEvidenceReplayConclusionIds,
  readEvidenceReplaySlots,
  replayPublicEvidence,
} from "../../src/core/evidence-replay.js";
import { evmAddressSchema } from "../../src/core/identities.js";
import {
  evidenceSourceSchema,
  invocationIdSchema,
} from "../../src/core/evidence.js";
import { productDisplayName } from "../../src/core/product-identity.js";
import { parseUtcTimestamp } from "../../src/core/primitives.js";

const capabilityId = "test.replay";
const evaluatedAt = parseUtcTimestamp("2026-07-24T00:00:00.000Z");
const invocationId = invocationIdSchema.parse(`inv:${Buffer.alloc(32, 7).toString("base64url")}`);
const definition = createEvidenceReplayDefinition({
  capabilityId,
  conclusionIds: ["input_validated"],
  warningCodes: [],
});
const slots = [{
  slotId: "input",
  factId: "input",
  kind: "validated_input" as const,
  purpose: "validated_input",
}];

describe("public evidence replay", () => {
  it("keeps the observation ordinal private while matching an independent SHA-256 oracle", () => {
    const layout = createEvidenceReplayLayout(definition, slots);
    const sourceId = `input:${capabilityId}`;
    const observationId = createEvidenceObservationId(definition, layout, {
      slotId: "input",
      sourceId,
      observedAt: evaluatedAt,
      invocationId,
    });
    const expected = createHash("sha256")
      .update(JSON.stringify([
        sourceId,
        "validated_input",
        evaluatedAt,
        null,
        invocationId,
        "0",
      ]), "utf8")
      .digest("base64url");
    expect(`obs:${expected}`).toBe("obs:-eskheVa4lSC7v4tQ9_qCYc1RJ1lWLUWVEwQBKpOwqQ");
    expect(observationId).toBe(`obs:${expected}`);
    expect(readEvidenceReplaySlots(definition, layout)).toEqual(slots);
    expect(Object.hasOwn(readEvidenceReplaySlots(definition, layout)[0] ?? {}, "ordinal")).toBe(false);
    expect(createEvidenceObservationId(definition, layout, {
      slotId: "input",
      sourceId,
      observedAt: evaluatedAt,
      invocationId,
      ordinal: "99",
    } as never)).toBe(observationId);
  });

  it("derives the complete public result without accepting caller replay decisions", () => {
    const layout = createEvidenceReplayLayout(definition, slots);
    const sourceId = `input:${capabilityId}`;
    const observationId = createEvidenceObservationId(definition, layout, {
      slotId: "input",
      sourceId,
      observedAt: evaluatedAt,
      invocationId,
    });
    const sources = [evidenceSourceSchema.parse({
      observationId,
      invocationId,
      sourceClass: "validated_input",
      owner: `${productDisplayName} validated input`,
      purpose: "validated_input",
      observedAt: evaluatedAt,
      reference: { kind: "validated_input", sourceId },
    })];
    expect(replayPublicEvidence({
      definition,
      layout,
      observationExpectations: [{
        slotId: "input",
        claims: [{ role: "validated_input", value: { value: "safe" } }],
      }],
      observationReferences: [],
      factRequirements: [{
        factId: "input",
        observationSlotIds: ["input"],
        requiredObservationSlotIds: ["input"],
        minimumObservationCount: 1,
        outcome: "validated_input",
      }],
      expectedConclusionIds: ["input_validated"],
      conclusionDrafts: [{
        id: "input_validated",
        outcomeFactId: "input",
        evidenceFactIds: ["input"],
        freshnessRuleId: "validated_input_current",
      }],
      warningRequirements: [],
      evaluatedAt,
      sources,
    })).toEqual({
      conclusions: [{
        id: "input_validated",
        status: "established",
        reason: "validated_input",
        observationIds: [observationId],
        freshness: {
          status: "fresh",
          ruleId: "validated_input_current",
          evaluatedAt,
          observationIds: [observationId],
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

  it("rejects duplicate observation slots before replay", () => {
    expect(() => createEvidenceReplayLayout(definition, [...slots, ...slots])).toThrow();
  });

  it("uses typed EVM-address declarations as the single dynamic identity owner", () => {
    const address = evmAddressSchema.parse(`0x${"1".repeat(40)}`);
    const addressIdentity = createEvmAddressConclusionIdentityDeclaration("address:");
    const otherIdentity = createEvmAddressConclusionIdentityDeclaration("other:");
    const definition = createEvidenceReplayDefinition({
      capabilityId: "test.disjoint",
      conclusionIds: [addressIdentity, otherIdentity],
      warningCodes: [],
    });
    expect(readEvidenceReplayConclusionIds(definition)).toEqual([
      "address:<address>",
      "other:<address>",
    ]);
    expect(createEvmAddressConclusionIdentity(addressIdentity, address))
      .toBe(`address:${address}`);
    expect(() => createEvmAddressConclusionIdentity({} as never, address))
      .toThrow("provenance");

    expect(() => createEvidenceReplayDefinition({
      capabilityId: "test.overlap",
      conclusionIds: [
        addressIdentity,
        "address:0x0000000000000000000000000000000000000000",
      ],
      warningCodes: [],
    })).toThrow("Conclusion identity declarations overlap");

    expect(() => createEvidenceReplayDefinition({
      capabilityId: "test.duplicate",
      conclusionIds: [
        addressIdentity,
        createEvmAddressConclusionIdentityDeclaration("address:"),
      ],
      warningCodes: [],
    })).toThrow("Duplicate conclusion identity");
  });

  it("rejects the obsolete arbitrary placeholder language", () => {
    expect(() => createEvidenceReplayDefinition({
      capabilityId: "test.obsolete",
      conclusionIds: [
        "<address>|0x0000000000000000000000000000000000000000",
        "0x1111111111111111111111111111111111111111|<address>",
      ],
      warningCodes: [],
    })).toThrow("Exact conclusion identity contains placeholder syntax");
  });
});
