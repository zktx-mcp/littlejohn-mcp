import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";

import { z } from "zod";

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const commitDigestSchema = z.string().regex(/^[0-9a-f]{40}$/);
const repositoryPathSchema = z.string().min(1).refine((path) => {
  if (path.startsWith("/") || path.includes("\\")) return false;
  return path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}, "Expected a normalized repository-relative path.");
const sortedUniquePathsSchema = z.array(repositoryPathSchema).min(1).superRefine((paths, context) => {
  for (let index = 1; index < paths.length; index += 1) {
    const previous = paths[index - 1];
    const current = paths[index];
    if (previous !== undefined && current !== undefined && previous >= current) {
      context.addIssue({
        code: "custom",
        message: "Producer paths must be strictly sorted and unique.",
      });
      return;
    }
  }
});
const fixtureBaselineSchema = z.strictObject({
  kind: z.literal("fixture"),
  digest: digestSchema,
});
const commitBaselineSchema = z.strictObject({
  kind: z.literal("commit"),
  digest: commitDigestSchema,
});
const producerSchema = z.strictObject({
  paths: sortedUniquePathsSchema,
  digest: digestSchema,
});
const boundaryCProducerHandoffSchema = z.strictObject({
  version: z.literal(1),
  baselines: z.strictObject({
    WU1: fixtureBaselineSchema,
    WU2: fixtureBaselineSchema,
    WU3: commitBaselineSchema,
  }),
  producers: z.strictObject({
    WU1: producerSchema,
    WU2: producerSchema,
    WU3: producerSchema,
  }),
});

export type BoundaryCProducerOwner = keyof z.infer<
  typeof boundaryCProducerHandoffSchema
>["producers"];
export type BoundaryCProducerHandoff = z.infer<typeof boundaryCProducerHandoffSchema>;

export const boundaryCProducerHandoffPath = "test/fixtures/boundary-c-producer-handoff.json";
export const boundaryCProducerHandoffDigest =
  "fea722b34cc291c0fc61189f4304418d89f410e80fb97ac55c2a8f9030b1606f";

const repositoryRoot = resolve(".");
const wu2EvidenceFiles = new Set([
  "test/runtime/wu1-handoff-fixture.ts",
  "test/runtime/wu1-handoff.test.ts",
  "test/runtime/wu2-handoff.test.ts",
]);

export const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

export const parseBoundaryCProducerHandoff = (value: unknown): BoundaryCProducerHandoff =>
  boundaryCProducerHandoffSchema.parse(value);

export const loadBoundaryCProducerHandoff = async (): Promise<{
  readonly bytes: Buffer;
  readonly fixture: BoundaryCProducerHandoff;
}> => {
  const bytes = await readFile(boundaryCProducerHandoffPath);
  if (sha256(bytes) !== boundaryCProducerHandoffDigest) {
    throw new TypeError("Boundary C producer handoff fixture digest mismatch.");
  }
  return {
    bytes,
    fixture: parseBoundaryCProducerHandoff(JSON.parse(bytes.toString("utf8"))),
  };
};

const collectFiles = async (path: string): Promise<readonly string[]> => {
  const files: string[] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(child));
    else if (entry.isFile()) files.push(relative(repositoryRoot, child));
    else throw new TypeError(`Unexpected producer handoff entry: ${child}`);
  }
  return files;
};

export const collectProducerPaths = async (
  owner: BoundaryCProducerOwner,
): Promise<readonly string[]> => {
  switch (owner) {
    case "WU1":
      return [
        "scripts/browser-build-policy.ts",
        "scripts/clean.mjs",
        ...await collectFiles("src/build"),
        ...await collectFiles("src/core"),
        ...await collectFiles("test/core"),
        "tsconfig.build.json",
        "tsconfig.json",
        "vite.config.ts",
        "vitest.config.ts",
      ].sort();
    case "WU2":
      return [
        ...await collectFiles("src/runtime"),
        ...await collectFiles("test/runtime"),
      ].filter((path) => !wu2EvidenceFiles.has(path)).sort();
    case "WU3":
      return [
        "src/cli.ts",
        ...await collectFiles("src/wallet"),
        ...await collectFiles("test/wallet"),
      ].sort();
  }
};

export const digestProducerFiles = async (paths: readonly string[]): Promise<string> => {
  const entries: [string, string][] = [];
  for (const path of paths) entries.push([path, sha256(await readFile(path))]);
  return sha256(Buffer.from(JSON.stringify(entries), "utf8"));
};
