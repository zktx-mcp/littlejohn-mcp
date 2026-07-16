import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  canonicalSha256,
  compareCodePointSequences,
  type CanonicalJson,
} from "../../src/core/index.js";
import { databaseMigrationIdentity } from "../../src/runtime/database.js";
import {
  runtimeErrorRegistry,
  runtimeInterfaceErrorMappings,
} from "../../src/runtime/errors.js";
import {
  browserContentSecurityPolicy,
  browserContentTypeOptions,
  browserContentTypes,
  browserCrossOriginOpenerPolicy,
  browserReferrerPolicy,
  browserSetCookieLimitBytes,
  fixedHost,
  fixedHostHeader,
  fixedOrigin,
  fixedPort,
  internalResponseLimitBytes,
  jsonContentType,
  noStoreCacheControl,
  problemJsonContentType,
  publicReadResponseLimitBytes,
  requestBodyLimitBytes,
} from "../../src/runtime/http-boundary.js";
import * as runtimePublic from "../../src/runtime/index.js";
import {
  composeCapabilityCatalog,
  initialRuntimeSupportManifest,
  readRuntimeSupportManifest,
  renderCurrentSupportSection,
} from "../../src/runtime/support-manifest.js";

interface WU2HandoffFixture {
  readonly version: 1;
  readonly immutableFiles: Readonly<Record<string, string>>;
  readonly immutableFilesDigest: string;
  readonly dependencyClosureDigest: string;
  readonly databaseMigrationIdentity: typeof databaseMigrationIdentity;
  readonly runtimeErrorProjection: readonly RuntimeErrorProjectionEntry[];
  readonly runtimeErrorProjectionDigest: string;
  readonly httpBoundary: Readonly<Record<string, CanonicalJson>>;
  readonly initialSupport: CanonicalJson;
  readonly initialSupportDigest: string;
  readonly initialCatalogDigest: string;
  readonly currentSupportSectionDigest: string;
  readonly runtimePublicValueExports: readonly string[];
}

interface RuntimeErrorProjectionEntry {
  readonly code: string;
  readonly category: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly httpStatus: number;
  readonly problemTitle: string;
  readonly cliExitCode: number;
}

const fixturePath = "test/fixtures/wu2-handoff.json";
const fixtureDigest = "2170ba72b3b9c40963817b9f227da606de853e8fcf6fa7360187c5260d633b81";
const loadFixture = async (): Promise<WU2HandoffFixture> => {
  const bytes = await readFile(fixturePath);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(fixtureDigest);
  return JSON.parse(bytes.toString("utf8")) as WU2HandoffFixture;
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
): Readonly<Record<string, CanonicalJson>> => {
  const roots = ["better-sqlite3", "@types/better-sqlite3"];
  const queue = roots.map((name) => {
    const path = resolveLockedDependency(packages, "", name);
    if (path === undefined) throw new TypeError(`Missing locked WU2 dependency: ${name}`);
    return path;
  });
  const seen = new Set<string>();
  while (queue.length > 0) {
    const path = queue.shift() as string;
    if (seen.has(path)) continue;
    const entry = packages[path];
    if (entry === undefined) throw new TypeError(`Missing locked WU2 package: ${path}`);
    seen.add(path);
    const dependencyNames = Object.keys({
      ...(entry["dependencies"] as Record<string, string> | undefined),
      ...(entry["optionalDependencies"] as Record<string, string> | undefined),
      ...(entry["peerDependencies"] as Record<string, string> | undefined),
    });
    for (const dependency of dependencyNames) {
      const resolved = resolveLockedDependency(packages, path, dependency);
      const optionalPeer = (entry["peerDependenciesMeta"] as Record<string, { optional?: boolean }> | undefined)
        ?.[dependency]?.optional === true;
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
    const source = packages[path] as Record<string, unknown>;
    const entry: Record<string, CanonicalJson> = Object.create(null) as Record<string, CanonicalJson>;
    for (const field of fields) if (source[field] !== undefined) entry[field] = source[field] as CanonicalJson;
    projection[path] = entry;
  }
  return projection;
};

const runtimeErrorProjection = (): readonly RuntimeErrorProjectionEntry[] => runtimeErrorRegistry.values().map((definition) => {
  const mapping = runtimeInterfaceErrorMappings.get(definition.code);
  return {
    code: definition.code,
    category: definition.category,
    message: definition.message,
    retryable: definition.retryable,
    httpStatus: mapping.httpStatus,
    problemTitle: mapping.problemTitle,
    cliExitCode: mapping.cliExitCode,
  };
});

const httpBoundary = Object.freeze({
  fixedHost,
  fixedHostHeader,
  fixedOrigin,
  fixedPort,
  requestBodyLimitBytes,
  internalResponseLimitBytes,
  publicReadResponseLimitBytes,
  jsonContentType,
  problemJsonContentType,
  noStoreCacheControl,
  browserContentSecurityPolicy,
  browserContentTypeOptions,
  browserContentTypes,
  browserCrossOriginOpenerPolicy,
  browserReferrerPolicy,
  browserSetCookieLimitBytes,
}) as unknown as Readonly<Record<string, CanonicalJson>>;

describe("WU2 baseline semantic handoff", () => {
  it("preserves the producer fixture identity and internal immutable-file projection", async () => {
    const fixture = await loadFixture();
    expect(canonicalSha256(fixture.immutableFiles as unknown as CanonicalJson))
      .toBe(fixture.immutableFilesDigest);
  });

  it("retains the exact WU2 dependency resolution", async () => {
    const fixture = await loadFixture();
    const lock = JSON.parse(await readFile("npm-shrinkwrap.json", "utf8")) as {
      readonly packages: Readonly<Record<string, Record<string, unknown>>>;
    };
    expect(canonicalSha256(dependencyClosure(lock.packages) as unknown as CanonicalJson))
      .toBe(fixture.dependencyClosureDigest);
  });

  it("freezes persistence, errors, HTTP, support, catalog, and public runtime values", async () => {
    const fixture = await loadFixture();
    const errors = runtimeErrorProjection();
    const support = readRuntimeSupportManifest(initialRuntimeSupportManifest) as unknown as CanonicalJson;
    expect(databaseMigrationIdentity).toEqual(fixture.databaseMigrationIdentity);
    expect(errors.map(({ message: _message, ...entry }) => entry))
      .toEqual(fixture.runtimeErrorProjection.map(({ message: _message, ...entry }) => entry));
    expect(errors.flatMap((entry, index) =>
      entry.message === fixture.runtimeErrorProjection[index]?.message ? [] : [entry.code]))
      .toEqual(["port_conflict"]);
    expect(httpBoundary).toEqual(fixture.httpBoundary);
    expect(support).toEqual(fixture.initialSupport);
    expect(canonicalSha256(support)).toBe(fixture.initialSupportDigest);
    expect(canonicalSha256(composeCapabilityCatalog(initialRuntimeSupportManifest) as unknown as CanonicalJson))
      .toBe(fixture.initialCatalogDigest);
    expect(createHash("sha256").update(renderCurrentSupportSection(initialRuntimeSupportManifest), "utf8").digest("hex"))
      .toBe(fixture.currentSupportSectionDigest);
    expect(Object.keys(runtimePublic).sort(compareCodePointSequences)).toEqual(fixture.runtimePublicValueExports);
  });
});
