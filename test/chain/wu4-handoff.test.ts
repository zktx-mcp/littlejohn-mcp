import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import * as chainPublic from "../../src/chain/index.js";
import { extendChainSupportManifest } from "../../src/chain/application.js";
import { chainErrorRegistry, chainInterfaceErrorMappings } from "../../src/chain/errors.js";
import {
  canonicalSha256,
  compareCodePointSequences,
  type CanonicalJson,
} from "../../src/core/index.js";
import {
  initialRuntimeSupportManifest,
  readRuntimeSupportManifest,
} from "../../src/runtime/support-manifest.js";
import { extendWalletSupportManifest } from "../../src/wallet/application.js";
import { walletErrorRegistry } from "../../src/wallet/errors.js";

interface WU4HandoffFixture {
  readonly version: 1;
  readonly immutableFiles: Readonly<Record<string, string>>;
  readonly immutableFilesDigest: string;
  readonly dependencyRoots: Readonly<Record<string, string>>;
  readonly dependencyClosureDigest: string;
  readonly chainErrorProjection: readonly CanonicalJson[];
  readonly chainErrorProjectionDigest: string;
  readonly chainSupportProjection: readonly CanonicalJson[];
  readonly chainSupportProjectionDigest: string;
  readonly chainPublicValueExports: readonly string[];
}

const fixturePath = "test/fixtures/wu4-handoff.json";
const fixtureDigest = "3323bff36d98022faed34977b204465498ef5ccd93a2adb2ef75886e48308185";
const excludedChainTests = new Set([
  "test/chain/current-support.test.ts",
  "test/chain/wu4-handoff.test.ts",
]);

const collect = async (path: string): Promise<string[]> => {
  const files: string[] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) files.push(...await collect(child));
    else if (entry.isFile()) files.push(relative(resolve("."), child));
    else throw new TypeError(`Unexpected WU4 handoff entry: ${child}`);
  }
  return files;
};

const immutableFileDigests = async (): Promise<Readonly<Record<string, string>>> => {
  const paths = [
    ...await collect("src/chain"),
    ...await collect("test/chain"),
  ].filter((path) => !excludedChainTests.has(path)).sort(compareCodePointSequences);
  const digests: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const path of paths) {
    digests[path] = createHash("sha256").update(await readFile(path)).digest("hex");
  }
  return digests;
};

const loadFixture = async (): Promise<WU4HandoffFixture> => {
  const bytes = await readFile(fixturePath);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(fixtureDigest);
  return JSON.parse(bytes.toString("utf8")) as WU4HandoffFixture;
};

const dependencyCandidatePaths = (fromPath: string, dependency: string): readonly string[] => {
  const candidates: string[] = [];
  const parts = fromPath === "" ? [] : fromPath.split("/");
  while (parts.length > 0) {
    if (parts.at(-1) === "node_modules") {
      parts.pop();
      continue;
    }
    candidates.push([...parts, "node_modules", dependency].join("/"));
    parts.pop();
  }
  candidates.push(`node_modules/${dependency}`);
  return [...new Set(candidates)];
};

const resolveLockedDependency = (
  packages: Readonly<Record<string, Record<string, unknown>>>,
  fromPath: string,
  dependency: string,
): string | undefined => dependencyCandidatePaths(fromPath, dependency)
  .find((candidate) => packages[candidate] !== undefined);

const dependencyClosure = (
  packages: Readonly<Record<string, Record<string, unknown>>>,
  roots: Readonly<Record<string, string>>,
): Readonly<Record<string, CanonicalJson>> => {
  const queue = Object.keys(roots).map((name) => {
    const path = resolveLockedDependency(packages, "", name);
    if (path === undefined) throw new TypeError(`Missing locked WU4 dependency: ${name}`);
    return path;
  });
  const seen = new Set<string>();
  while (queue.length > 0) {
    const path = queue.shift();
    if (path === undefined || seen.has(path)) continue;
    const entry = packages[path];
    if (entry === undefined) throw new TypeError(`Missing locked WU4 package: ${path}`);
    seen.add(path);
    const dependencyNames = Object.keys({
      ...(entry["dependencies"] as Record<string, string> | undefined),
      ...(entry["optionalDependencies"] as Record<string, string> | undefined),
      ...(entry["peerDependencies"] as Record<string, string> | undefined),
    });
    for (const dependency of dependencyNames) {
      const resolved = resolveLockedDependency(packages, path, dependency);
      const optionalPeer = (entry["peerDependenciesMeta"] as
        | Record<string, { optional?: boolean }>
        | undefined)?.[dependency]?.optional === true;
      if (resolved === undefined) {
        if (!optionalPeer) throw new TypeError(`Missing locked dependency ${dependency} from ${path}`);
      } else if (!seen.has(resolved)) queue.push(resolved);
    }
  }
  const fields = [
    "version", "resolved", "integrity", "dependencies", "optionalDependencies",
    "peerDependencies", "peerDependenciesMeta", "engines", "os", "cpu", "bin", "hasInstall",
  ] as const;
  const projection: Record<string, CanonicalJson> = Object.create(null) as Record<string, CanonicalJson>;
  for (const path of [...seen].sort(compareCodePointSequences)) {
    const source = packages[path];
    if (source === undefined) throw new TypeError(`Missing locked WU4 package: ${path}`);
    const entry: Record<string, CanonicalJson> = Object.create(null) as Record<string, CanonicalJson>;
    for (const field of fields) {
      if (source[field] !== undefined) entry[field] = source[field] as CanonicalJson;
    }
    projection[path] = entry;
  }
  return projection;
};

const chainErrorProjection = (): readonly CanonicalJson[] => {
  const walletErrorCodes = new Set(walletErrorRegistry.values().map(({ code }) => code));
  return chainErrorRegistry.values()
    .filter(({ code }) => !walletErrorCodes.has(code))
    .map((definition) => {
      const mapping = chainInterfaceErrorMappings.get(definition.code);
      return {
        code: definition.code,
        category: definition.category,
        message: definition.message,
        retryable: definition.retryable,
        httpStatus: mapping.httpStatus,
        problemTitle: mapping.problemTitle,
        cliExitCode: mapping.cliExitCode,
      } as unknown as CanonicalJson;
    });
};

const chainSupportProjection = (): readonly CanonicalJson[] => {
  const capabilityIds = new Set([
    "account.balance",
    "chain.status",
    "contract.inspect",
    "transaction.inspect",
  ]);
  const manifest = extendChainSupportManifest(
    extendWalletSupportManifest(initialRuntimeSupportManifest),
  );
  return readRuntimeSupportManifest(manifest).capabilities
    .filter(({ capabilityId }) => capabilityIds.has(capabilityId)) as unknown as readonly CanonicalJson[];
};

describe("WU4 frozen handoff", () => {
  it("retains the exact chain implementation and verification bytes", async () => {
    const fixture = await loadFixture();
    const actual = await immutableFileDigests();
    expect(Object.keys(actual)).toEqual(Object.keys(fixture.immutableFiles));
    expect(actual).toEqual(fixture.immutableFiles);
    expect(canonicalSha256(actual as unknown as CanonicalJson)).toBe(fixture.immutableFilesDigest);
  });

  it("retains the WU1-owned dependency roots and exact locked closure", async () => {
    const fixture = await loadFixture();
    const wu1Fixture = JSON.parse(await readFile("test/fixtures/wu1-handoff.json", "utf8")) as {
      readonly extensionsByWorkUnit: {
        readonly WU4: { readonly dependencies: Readonly<Record<string, string>> };
      };
    };
    const packageManifest = JSON.parse(await readFile("package.json", "utf8")) as {
      readonly dependencies: Readonly<Record<string, string>>;
    };
    const roots = wu1Fixture.extensionsByWorkUnit.WU4.dependencies;
    expect(roots).toEqual(fixture.dependencyRoots);
    for (const [name, version] of Object.entries(roots)) {
      expect(packageManifest.dependencies[name]).toBe(version);
    }
    const lock = JSON.parse(await readFile("npm-shrinkwrap.json", "utf8")) as {
      readonly packages: Readonly<Record<string, Record<string, unknown>>>;
    };
    expect(canonicalSha256(dependencyClosure(lock.packages, roots) as unknown as CanonicalJson))
      .toBe(fixture.dependencyClosureDigest);
  });

  it("retains the chain errors, internal support handoff, and public values", async () => {
    const fixture = await loadFixture();
    const errors = chainErrorProjection();
    const support = chainSupportProjection();
    expect(errors).toEqual(fixture.chainErrorProjection);
    expect(canonicalSha256(errors as CanonicalJson)).toBe(fixture.chainErrorProjectionDigest);
    expect(support).toEqual(fixture.chainSupportProjection);
    expect(canonicalSha256(support as CanonicalJson)).toBe(fixture.chainSupportProjectionDigest);
    expect(Object.keys(chainPublic).sort(compareCodePointSequences)).toEqual(fixture.chainPublicValueExports);
  });
});
