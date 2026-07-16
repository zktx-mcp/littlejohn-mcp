import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  canonicalSha256,
  compareCodePointSequences,
  projectCapabilities,
  readCapabilityRegistry,
  type CanonicalJson,
} from "../../src/core/index.js";
import { collectSourceFiles, inspectSourceFile } from "./import-audit.js";
import {
  analyzePackageExtensions,
  extensionEntries,
  extensionWorkUnits,
  loadPackageManifest,
  loadWu1HandoffFixture,
  type PackageManifest,
  type Wu1HandoffFixture,
} from "./wu1-handoff-fixture.js";

const fixturePath = "test/fixtures/wu1-handoff.json";
const fixtureDigest = "5bf3f423abd2f6b640aa320fcc9f3b83a7a4fd562ad29c002173f72b314c86a7";
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

const loadFixture = async (): Promise<Wu1HandoffFixture> => {
  const { bytes, fixture } = await loadWu1HandoffFixture(fixturePath);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(fixtureDigest);
  return fixture;
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

const packageFoundation = (manifest: PackageManifest, fixture: Wu1HandoffFixture) => {
  const { dependencies, devDependencies, scripts } = manifest;
  const analysis = analyzePackageExtensions(fixture, manifest);
  if (analysis.errors.length !== 0) throw new TypeError(analysis.errors[0]);
  const foundationScripts: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const name of Object.keys(fixture.packageFoundation.scripts)) {
    const overridden = [...analysis.activeWorkUnits].some((workUnit) =>
      Object.hasOwn(fixture.extensionsByWorkUnit[workUnit].scripts, name));
    const value = overridden ? fixture.packageFoundation.scripts[name] : scripts[name];
    if (value === undefined) throw new TypeError(`Missing package foundation value: ${name}`);
    foundationScripts[name] = value;
  }
  return {
    name: manifest["name"],
    version: manifest["version"],
    description: manifest["description"],
    type: manifest["type"],
    exports: manifest["exports"],
    engines: manifest["engines"],
    bin: manifest["bin"],
    files: manifest["files"],
    scripts: foundationScripts,
    dependencies: select(dependencies, Object.keys(fixture.packageFoundation.dependencies)),
    devDependencies: select(devDependencies, Object.keys(fixture.packageFoundation.devDependencies)),
  };
};

const withoutExtension = (
  manifest: PackageManifest,
  fixture: Wu1HandoffFixture,
  workUnit: "WU2" | "WU3" | "WU4" | "WU5" | "WU6",
): PackageManifest => {
  const extension = fixture.extensionsByWorkUnit[workUnit];
  const scripts = { ...manifest.scripts };
  const dependencies = { ...manifest.dependencies };
  const devDependencies = { ...manifest.devDependencies };
  for (const name of Object.keys(extension.dependencies)) delete dependencies[name];
  for (const name of Object.keys(extension.devDependencies)) delete devDependencies[name];
  for (const [name, value] of Object.entries(extension.scripts)) {
    if (scripts[name] !== value) continue;
    const foundationValue = fixture.packageFoundation.scripts[name];
    if (foundationValue === undefined) delete scripts[name];
    else scripts[name] = foundationValue;
  }
  return { ...manifest, scripts, dependencies, devDependencies };
};

const withExtension = (
  manifest: PackageManifest,
  fixture: Wu1HandoffFixture,
  workUnit: (typeof extensionWorkUnits)[number],
): PackageManifest => {
  const extension = fixture.extensionsByWorkUnit[workUnit];
  return {
    ...manifest,
    scripts: { ...manifest.scripts, ...extension.scripts },
    dependencies: { ...manifest.dependencies, ...extension.dependencies },
    devDependencies: { ...manifest.devDependencies, ...extension.devDependencies },
  };
};

const importedPackages = async (root: string): Promise<ReadonlySet<string>> => {
  const packages = new Set<string>();
  for (const path of await collectSourceFiles(resolve(root))) {
    for (const reference of (await inspectSourceFile(path)).moduleImports) {
      if (reference.runtime && reference.packageRoot !== undefined) packages.add(reference.packageRoot);
    }
  }
  return packages;
};

const extensionConsumerErrors = async (
  manifest: PackageManifest,
  fixture: Wu1HandoffFixture,
  readImportedPackages: (root: string) => Promise<ReadonlySet<string>> = importedPackages,
): Promise<readonly string[]> => {
  const extensionAnalysis = analyzePackageExtensions(fixture, manifest);
  if (extensionAnalysis.errors.length !== 0) return extensionAnalysis.errors;
  const errors: string[] = [];
  for (const [workUnit, extension] of extensionEntries(fixture)) {
    if (!extensionAnalysis.activeWorkUnits.has(workUnit)) continue;
    const imports = await readImportedPackages(extension.sourceRoot);
    for (const name of Object.keys(extension.dependencies)) {
      if (!imports.has(name)) errors.push(`${workUnit}:consumer:${name}`);
    }
  }
  return errors.sort(compareCodePointSequences);
};

const rootLockProjection = (manifest: PackageManifest): Record<string, unknown> => ({
  name: manifest.name,
  version: manifest.version,
  dependencies: manifest.dependencies,
  bin: manifest.bin,
  devDependencies: manifest.devDependencies,
  engines: manifest.engines,
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

const buildRuleProjection = (
  foundation: ReturnType<typeof packageFoundation>,
  files: Readonly<Record<string, string>>,
): CanonicalJson => ({
  packageFoundation: foundation,
  files: select(files, buildRuleFiles),
} as unknown as CanonicalJson);

describe("WU1 baseline semantic handoff", () => {
  it("preserves the producer fixture identity and internal immutable-file projection", async () => {
    const fixture = await loadFixture();
    expect(canonicalSha256(fixture.immutableFiles as unknown as CanonicalJson))
      .toBe(fixture.immutableFilesDigest);
  });

  it("preserves the package foundation and complete activated extension groups", async () => {
    const fixture = await loadFixture();
    const manifest = await loadPackageManifest();
    expect(Object.keys(manifest)).toEqual([
      "name", "version", "description", "type", "exports", "engines", "bin", "files", "scripts",
      "dependencies", "devDependencies",
    ]);
    expect(packageFoundation(manifest, fixture)).toEqual(fixture.packageFoundation);
    expect(analyzePackageExtensions(fixture, manifest).errors).toEqual([]);
    expect(analyzePackageExtensions(fixture, {
      ...manifest,
      scripts: { ...manifest.scripts, undeclared: "node undeclared.js" },
    }).errors).toContain("scripts:undeclared@node undeclared.js");
    const earlyWallet = {
      ...manifest,
      dependencies: Object.fromEntries(
        Object.entries(manifest.dependencies)
          .filter(([name]) => name !== "qrcode"),
      ),
    };
    expect(analyzePackageExtensions(fixture, earlyWallet).errors)
      .toContain("WU3:missing:dependencies:qrcode@1.5.4");
    const webBaseline = withoutExtension(manifest, fixture, "WU5");
    const earlyWeb = {
      ...webBaseline,
      dependencies: {
        ...webBaseline.dependencies,
        react: "19.2.7",
      },
    };
    expect(analyzePackageExtensions(fixture, earlyWeb).errors).toEqual(expect.arrayContaining([
      "WU5:missing:dependencies:@modelcontextprotocol/sdk@1.29.0",
      "WU5:missing:dependencies:react-dom@19.2.7",
      "WU5:missing:devDependencies:vite@8.1.4",
      "WU5:missing:scripts:build@npm run clean && tsc -p tsconfig.build.json && tsc -p tsconfig.web.json --noEmit && vite build --config vite.config.ts && node dist/build/generate-contracts.js && node dist/build/generate-build-identity.js",
      "WU5:missing:scripts:typecheck@tsc -p tsconfig.json --noEmit && tsc -p tsconfig.web.json --noEmit",
    ]));
  });

  it("requires each activated runtime dependency to have a consumer under its declared source root", async () => {
    const fixture = await loadFixture();
    const manifest = await loadPackageManifest();
    expect(await extensionConsumerErrors(manifest, fixture)).toEqual([]);

    const missingConsumer = {
      ...fixture,
      extensionsByWorkUnit: {
        ...fixture.extensionsByWorkUnit,
        WU3: {
          ...fixture.extensionsByWorkUnit.WU3,
          sourceRoot: "src/runtime",
        },
      },
    };
    expect(await extensionConsumerErrors(manifest, missingConsumer)).toEqual([
      "WU3:consumer:@walletconnect/sign-client",
      "WU3:consumer:qrcode",
    ]);

    for (const workUnit of extensionWorkUnits) {
      const activeManifest = withExtension(manifest, fixture, workUnit);
      const target = fixture.extensionsByWorkUnit[workUnit];
      const completeConsumers = async (sourceRoot: string): Promise<ReadonlySet<string>> => {
        const entry = extensionEntries(fixture).find(([, extension]) => extension.sourceRoot === sourceRoot);
        return new Set(entry === undefined ? [] : Object.keys(entry[1].dependencies));
      };
      expect(await extensionConsumerErrors(activeManifest, fixture, completeConsumers)).toEqual([]);

      const firstDependency = Object.keys(target.dependencies)[0];
      if (firstDependency === undefined) continue;
      const missingTargetConsumer = async (sourceRoot: string): Promise<ReadonlySet<string>> => {
        const packages = new Set(await completeConsumers(sourceRoot));
        if (sourceRoot === target.sourceRoot) packages.delete(firstDependency);
        return packages;
      };
      expect(await extensionConsumerErrors(activeManifest, fixture, missingTargetConsumer))
        .toContain(`${workUnit}:consumer:${firstDependency}`);
    }
  });

  it("declares and activates the isolated WU5 web build as one complete extension", async () => {
    const fixture = await loadFixture();
    const web = fixture.extensionsByWorkUnit.WU5;
    expect(web).toEqual({
      sourceRoot: "src/interfaces",
      scripts: {
        build: "npm run clean && tsc -p tsconfig.build.json && tsc -p tsconfig.web.json --noEmit && vite build --config vite.config.ts && node dist/build/generate-contracts.js && node dist/build/generate-build-identity.js",
        typecheck: "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.web.json --noEmit",
      },
      dependencies: {
        "@modelcontextprotocol/sdk": "1.29.0",
        react: "19.2.7",
        "react-dom": "19.2.7",
      },
      devDependencies: {
        "@types/react": "19.2.17",
        "@types/react-dom": "19.2.3",
        "@vitejs/plugin-react": "6.0.3",
        vite: "8.1.4",
      },
    });
    const manifest = await loadPackageManifest();
    const baseline = withoutExtension(manifest, fixture, "WU5");
    const activated = {
      ...baseline,
      scripts: { ...baseline.scripts, ...web.scripts },
      dependencies: { ...baseline.dependencies, ...web.dependencies },
      devDependencies: { ...baseline.devDependencies, ...web.devDependencies },
    };
    const analysis = analyzePackageExtensions(fixture, activated);
    expect(analysis.errors).toEqual([]);
    expect(analysis.activeWorkUnits.has("WU5")).toBe(true);
  });

  it("keeps browser globals in the isolated WU5 typecheck and preserves the Node build boundary", async () => {
    const nodeConfig = JSON.parse(await readFile("tsconfig.json", "utf8")) as {
      readonly compilerOptions: { readonly lib: readonly string[] };
      readonly include: readonly string[];
    };
    const webConfig = JSON.parse(await readFile("tsconfig.web.json", "utf8")) as {
      readonly compilerOptions: Readonly<Record<string, unknown>>;
      readonly include: readonly string[];
    };
    const buildConfig = JSON.parse(await readFile("tsconfig.build.json", "utf8")) as {
      readonly include: readonly string[];
      readonly exclude: readonly string[];
    };
    const viteConfig = (await import("../../vite.config.js")).default;

    expect(nodeConfig.compilerOptions.lib).toEqual(["ES2023"]);
    expect(nodeConfig.include).toEqual([
      "src/**/*.ts",
      "test/**/*.ts",
      "scripts/browser-build-policy.ts",
      "vite.config.ts",
    ]);
    expect(webConfig.compilerOptions).toMatchObject({
      target: "ES2023",
      module: "ESNext",
      moduleResolution: "Bundler",
      lib: ["ES2023", "DOM", "DOM.Iterable"],
      jsx: "react-jsx",
      types: ["vite/client"],
      noEmit: true,
    });
    expect(webConfig.include).toEqual([
      "src/interfaces/web/**/*.ts",
      "src/interfaces/web/**/*.tsx",
      "test/interfaces/web/**/*.ts",
      "test/interfaces/web/**/*.tsx",
    ]);
    expect(buildConfig.include).toEqual(["src/**/*.ts"]);
    expect(buildConfig.exclude).toEqual(["test", "dist"]);
    expect(viteConfig).toMatchObject({
      root: resolve("src/interfaces/web"),
      base: "/",
      publicDir: false,
      build: {
        outDir: resolve("dist/web"),
        emptyOutDir: true,
        assetsDir: "assets",
        assetsInlineLimit: 0,
        sourcemap: false,
        rollupOptions: { input: resolve("src/interfaces/web/index.html") },
      },
    });
  });

  it("binds the shrinkwrap root to the current manifest and preserves exact WU1 resolution", async () => {
    const fixture = await loadFixture();
    const manifest = await loadPackageManifest();
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
    const manifest = await loadPackageManifest();
    expect(canonicalSha256(
      projectCapabilities(readCapabilityRegistry) as unknown as CanonicalJson,
    )).toBe(fixture.capabilityProjectionDigest);
    expect(canonicalSha256(buildRuleProjection(packageFoundation(manifest, fixture), fixture.immutableFiles)))
      .toBe(fixture.buildRuleDigest);
  });
});
