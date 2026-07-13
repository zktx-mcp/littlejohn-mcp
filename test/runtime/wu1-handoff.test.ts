import { createHash } from "node:crypto";
import { access, readFile, readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  canonicalSha256,
  compareCodePointSequences,
  projectCapabilities,
  readCapabilityRegistry,
  type CanonicalJson,
} from "../../src/core/index.js";

type ExtensionWorkUnit = "WU2" | "WU3" | "WU4" | "WU5" | "WU6";
type PackageSection = "scripts" | "dependencies" | "devDependencies";

interface PackageExtensionSet {
  readonly sourceRoot: string;
  readonly scripts: Readonly<Record<string, string>>;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly devDependencies: Readonly<Record<string, string>>;
}

interface HandoffFixture {
  readonly version: 2;
  readonly immutableFiles: Readonly<Record<string, string>>;
  readonly immutableFilesDigest: string;
  readonly capabilityProjectionDigest: string;
  readonly buildRuleDigest: string;
  readonly packageFoundation: {
    readonly name: string;
    readonly version: string;
    readonly description: string;
    readonly type: string;
    readonly exports: Readonly<Record<string, never>>;
    readonly engines: Readonly<Record<string, string>>;
    readonly bin: Readonly<Record<string, string>>;
    readonly files: readonly string[];
    readonly scripts: Readonly<Record<string, string>>;
    readonly dependencies: Readonly<Record<string, string>>;
    readonly devDependencies: Readonly<Record<string, string>>;
  };
  readonly extensionsByWorkUnit: Readonly<Record<ExtensionWorkUnit, PackageExtensionSet>>;
  readonly requiredAtBoundaryA: {
    readonly dependencies: readonly string[];
    readonly devDependencies: readonly string[];
  };
  readonly wu1LockClosureDigest: string;
}

const fixturePath = "test/fixtures/wu1-handoff.json";
const fixtureDigest = "3894f270f79bc84fadc843fd48044dc221955ae652fc7eac39ca67ce3662c0bf";
const extensionWorkUnits = ["WU2", "WU3", "WU4", "WU5", "WU6"] as const;
const buildRuleFiles = [
  "scripts/clean.mjs",
  "src/build/generate-build-identity.ts",
  "src/build/generate-contracts.ts",
  "src/build/runtime-file-set.ts",
  "src/core/build-identity.ts",
  "src/core/contract.ts",
  "src/core/digests.ts",
  "tsconfig.build.json",
  "tsconfig.json",
  "vitest.config.ts",
] as const;

const collect = async (path: string): Promise<string[]> => {
  const entries = await readdir(path, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) files.push(...await collect(child));
    else if (entry.isFile()) files.push(relative(resolve("."), child));
    else throw new TypeError(`Unexpected handoff entry: ${child}`);
  }
  return files;
};

const loadFixture = async (): Promise<HandoffFixture> => {
  const bytes = await readFile(fixturePath);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(fixtureDigest);
  return JSON.parse(bytes.toString("utf8")) as HandoffFixture;
};

const select = (
  values: Readonly<Record<string, string>>,
  names: readonly string[],
): Readonly<Record<string, string>> => {
  const selected: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const name of names) {
    const value = values[name];
    if (value === undefined) throw new TypeError(`Missing package foundation value: ${name}`);
    selected[name] = value;
  }
  return selected;
};

const packageFoundation = (manifest: Record<string, unknown>, fixture: HandoffFixture) => {
  const dependencies = manifest["dependencies"] as Record<string, string>;
  const devDependencies = manifest["devDependencies"] as Record<string, string>;
  const scripts = manifest["scripts"] as Record<string, string>;
  return {
    name: manifest["name"],
    version: manifest["version"],
    description: manifest["description"],
    type: manifest["type"],
    exports: manifest["exports"],
    engines: manifest["engines"],
    bin: manifest["bin"],
    files: manifest["files"],
    scripts: select(scripts, Object.keys(fixture.packageFoundation.scripts)),
    dependencies: select(dependencies, Object.keys(fixture.packageFoundation.dependencies)),
    devDependencies: select(devDependencies, Object.keys(fixture.packageFoundation.devDependencies)),
  };
};

const mergedExtensions = (
  fixture: HandoffFixture,
  section: PackageSection,
): Readonly<Record<string, string>> => {
  const merged: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const workUnit of extensionWorkUnits) {
    for (const [name, value] of Object.entries(fixture.extensionsByWorkUnit[workUnit][section])) {
      if (merged[name] !== undefined) throw new TypeError(`Duplicate package extension owner: ${name}`);
      merged[name] = value;
    }
  }
  return merged;
};

const packagePolicyErrors = (manifest: Record<string, unknown>, fixture: HandoffFixture): readonly string[] => {
  const errors: string[] = [];
  const actual = {
    scripts: manifest["scripts"] as Record<string, string>,
    dependencies: manifest["dependencies"] as Record<string, string>,
    devDependencies: manifest["devDependencies"] as Record<string, string>,
  };
  const foundation = fixture.packageFoundation;
  const allowed = {
    scripts: { ...foundation.scripts, ...mergedExtensions(fixture, "scripts") },
    dependencies: { ...foundation.dependencies, ...mergedExtensions(fixture, "dependencies") },
    devDependencies: { ...foundation.devDependencies, ...mergedExtensions(fixture, "devDependencies") },
  };
  for (const section of ["scripts", "dependencies", "devDependencies"] as const) {
    for (const [name, value] of Object.entries(actual[section])) {
      if (allowed[section][name] !== value) errors.push(`${section}:${name}@${value}`);
    }
  }
  for (const workUnit of extensionWorkUnits) {
    const extension = fixture.extensionsByWorkUnit[workUnit];
    const active = (["scripts", "dependencies", "devDependencies"] as const).some((section) =>
      Object.keys(extension[section]).some((name) => actual[section][name] !== undefined));
    if (!active) continue;
    for (const section of ["scripts", "dependencies", "devDependencies"] as const) {
      for (const [name, value] of Object.entries(extension[section])) {
        if (actual[section][name] !== value) errors.push(`${workUnit}:missing:${section}:${name}@${value}`);
      }
    }
  }
  for (const name of fixture.requiredAtBoundaryA.dependencies) {
    if (actual.dependencies[name] !== allowed.dependencies[name]) errors.push(`boundaryA:dependency:${name}`);
  }
  for (const name of fixture.requiredAtBoundaryA.devDependencies) {
    if (actual.devDependencies[name] !== allowed.devDependencies[name]) errors.push(`boundaryA:devDependency:${name}`);
  }
  return errors.sort(compareCodePointSequences);
};

const importedPackages = async (root: string): Promise<ReadonlySet<string>> => {
  try {
    await access(root);
  } catch {
    return new Set();
  }
  const packages = new Set<string>();
  for (const path of await collect(root)) {
    if (!/\.(?:[cm]?ts|[cm]?js)$/.test(path)) continue;
    const source = await readFile(path, "utf8");
    const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const record = (node: ts.Expression | undefined): void => {
      if (node !== undefined && ts.isStringLiteralLike(node) && !node.text.startsWith(".") && !node.text.startsWith("node:")) {
        const parts = node.text.split("/");
        packages.add(node.text.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? node.text));
      }
    };
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) record(node.moduleSpecifier);
      else if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) record(node.arguments[0]);
        if (ts.isIdentifier(node.expression) && node.expression.text === "require") record(node.arguments[0]);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return packages;
};

const extensionConsumerErrors = async (
  manifest: Record<string, unknown>,
  fixture: HandoffFixture,
): Promise<readonly string[]> => {
  const dependencies = manifest["dependencies"] as Record<string, string>;
  const errors: string[] = [];
  for (const workUnit of extensionWorkUnits) {
    const extension = fixture.extensionsByWorkUnit[workUnit];
    const activeDependencies = Object.keys(extension.dependencies).filter((name) => dependencies[name] !== undefined);
    if (activeDependencies.length === 0) continue;
    const imports = await importedPackages(extension.sourceRoot);
    for (const name of activeDependencies) {
      if (!imports.has(name)) errors.push(`${workUnit}:consumer:${name}`);
    }
  }
  return errors.sort(compareCodePointSequences);
};

const rootLockProjection = (manifest: Record<string, unknown>): Record<string, unknown> => ({
  name: manifest["name"],
  version: manifest["version"],
  dependencies: manifest["dependencies"],
  bin: manifest["bin"],
  devDependencies: manifest["devDependencies"],
  engines: manifest["engines"],
});

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

const lockClosure = (
  packages: Readonly<Record<string, Record<string, unknown>>>,
  roots: readonly string[],
): Readonly<Record<string, CanonicalJson>> => {
  const queue = roots.map((name) => {
    const path = resolveLockedDependency(packages, "", name);
    if (path === undefined) throw new TypeError(`Missing locked WU1 dependency: ${name}`);
    return path;
  });
  const seen = new Set<string>();
  while (queue.length > 0) {
    const path = queue.shift() as string;
    if (seen.has(path)) continue;
    const entry = packages[path];
    if (entry === undefined) throw new TypeError(`Missing locked WU1 package: ${path}`);
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

const immutableFileDigests = async (): Promise<Readonly<Record<string, string>>> => {
  const paths = [
    ...await collect("src/core"),
    ...await collect("src/build"),
    ...await collect("test/core"),
    "scripts/clean.mjs",
    "tsconfig.json",
    "tsconfig.build.json",
    "vitest.config.ts",
  ].sort(compareCodePointSequences);
  const digests: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const path of paths) digests[path] = createHash("sha256").update(await readFile(path)).digest("hex");
  return digests;
};

const buildRuleProjection = (
  foundation: ReturnType<typeof packageFoundation>,
  files: Readonly<Record<string, string>>,
): CanonicalJson => ({
  packageFoundation: foundation,
  files: select(files, buildRuleFiles),
} as unknown as CanonicalJson);

describe("WU1 frozen handoff", () => {
  it("retains the exact immutable WU1 file set and bytes", async () => {
    const fixture = await loadFixture();
    const actual = await immutableFileDigests();
    expect(Object.keys(actual)).toEqual(Object.keys(fixture.immutableFiles));
    expect(actual).toEqual(fixture.immutableFiles);
    expect(canonicalSha256(actual as unknown as CanonicalJson)).toBe(fixture.immutableFilesDigest);
  });

  it("preserves package authority and requires each activated extension at its declared first consumer", async () => {
    const fixture = await loadFixture();
    const manifest = JSON.parse(await readFile("package.json", "utf8")) as Record<string, unknown>;
    expect(Object.keys(manifest)).toEqual([
      "name", "version", "description", "type", "exports", "engines", "bin", "files", "scripts",
      "dependencies", "devDependencies",
    ]);
    expect(packageFoundation(manifest, fixture)).toEqual(fixture.packageFoundation);
    expect(packagePolicyErrors(manifest, fixture)).toEqual([]);
    expect(await extensionConsumerErrors(manifest, fixture)).toEqual([]);
    expect(packagePolicyErrors({
      ...manifest,
      scripts: { ...(manifest["scripts"] as object), undeclared: "node undeclared.js" },
    }, fixture)).toContain("scripts:undeclared@node undeclared.js");
    const earlyWallet = {
      ...manifest,
      dependencies: {
        ...(manifest["dependencies"] as object),
        "@walletconnect/sign-client": "2.23.10",
      },
    };
    expect(packagePolicyErrors(earlyWallet, fixture)).toContain("WU3:missing:dependencies:qrcode@1.5.4");
  });

  it("binds the shrinkwrap root to the current manifest and preserves exact WU1 resolution", async () => {
    const fixture = await loadFixture();
    const manifest = JSON.parse(await readFile("package.json", "utf8")) as Record<string, unknown>;
    const lock = JSON.parse(await readFile("npm-shrinkwrap.json", "utf8")) as {
      lockfileVersion: number;
      packages: Record<string, Record<string, unknown>>;
    };
    expect(lock.lockfileVersion).toBe(3);
    expect(lock.packages[""]).toEqual(rootLockProjection(manifest));
    const roots = [
      ...Object.keys(fixture.packageFoundation.dependencies),
      ...Object.keys(fixture.packageFoundation.devDependencies),
    ];
    expect(canonicalSha256(lockClosure(lock.packages, roots) as unknown as CanonicalJson))
      .toBe(fixture.wu1LockClosureDigest);
  });

  it("freezes the complete capability projection and build-rule projections", async () => {
    const fixture = await loadFixture();
    const manifest = JSON.parse(await readFile("package.json", "utf8")) as Record<string, unknown>;
    const files = await immutableFileDigests();
    expect(canonicalSha256(
      projectCapabilities(readCapabilityRegistry) as unknown as CanonicalJson,
    )).toBe(fixture.capabilityProjectionDigest);
    expect(canonicalSha256(buildRuleProjection(packageFoundation(manifest, fixture), files)))
      .toBe(fixture.buildRuleDigest);
  });
});
