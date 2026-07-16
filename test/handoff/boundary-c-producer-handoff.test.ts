import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  boundaryCProducerHandoffDigest,
  collectProducerPaths,
  digestProducerFiles,
  loadBoundaryCProducerHandoff,
  parseBoundaryCProducerHandoff,
  sha256,
  type BoundaryCProducerOwner,
} from "./boundary-c-producer-handoff.js";

const producerOwners = ["WU1", "WU2", "WU3"] as const satisfies readonly BoundaryCProducerOwner[];

describe("Boundary C producer handoff", () => {
  it("loads the exact strict artifact and preserves all dependency baseline identities", async () => {
    const { bytes, fixture } = await loadBoundaryCProducerHandoff();
    expect(sha256(bytes)).toBe(boundaryCProducerHandoffDigest);
    expect(sha256(await readFile("test/fixtures/wu1-handoff.json"))).toBe(fixture.baselines.WU1.digest);
    expect(sha256(await readFile("test/fixtures/wu2-handoff.json"))).toBe(fixture.baselines.WU2.digest);
    expect(fixture.baselines.WU3).toEqual({
      kind: "commit",
      digest: "92fc354e8decd7b2ae20b98c7197ad650c17260e",
    });
  });

  it("freezes each final producer path set and its complete byte identity", async () => {
    const { fixture } = await loadBoundaryCProducerHandoff();
    for (const owner of producerOwners) {
      const paths = await collectProducerPaths(owner);
      expect(paths).toEqual(fixture.producers[owner].paths);
      expect(await digestProducerFiles(paths)).toBe(fixture.producers[owner].digest);
    }
  });

  it("rejects unowned producers, unknown fields, and non-canonical path manifests", async () => {
    const { fixture } = await loadBoundaryCProducerHandoff();
    expect(() => parseBoundaryCProducerHandoff({ ...fixture, unexpected: true })).toThrow();
    expect(() => parseBoundaryCProducerHandoff({
      ...fixture,
      producers: {
        ...fixture.producers,
        WU4: fixture.producers.WU3,
      },
    })).toThrow();
    const [first, second, ...remaining] = fixture.producers.WU1.paths;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(() => parseBoundaryCProducerHandoff({
      ...fixture,
      producers: {
        ...fixture.producers,
        WU1: {
          ...fixture.producers.WU1,
          paths: [second, first, ...remaining],
        },
      },
    })).toThrow("strictly sorted and unique");
  });
});
