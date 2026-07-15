import { readFile } from "node:fs/promises";

import { z } from "zod";

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const stringRecordSchema = z.record(z.string().min(1), z.string());

const packageExtensionSchema = z.strictObject({
  sourceRoot: z.string().min(1),
  scripts: stringRecordSchema,
  dependencies: stringRecordSchema,
  devDependencies: stringRecordSchema,
});

export const extensionWorkUnits = ["WU2", "WU3", "WU4", "WU5", "WU6"] as const;
const extensionWorkUnitSchema = z.enum(extensionWorkUnits);

const packageFoundationSchema = z.strictObject({
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string(),
  type: z.string().min(1),
  exports: z.strictObject({}),
  engines: stringRecordSchema,
  bin: stringRecordSchema,
  files: z.array(z.string().min(1)),
  scripts: stringRecordSchema,
  dependencies: stringRecordSchema,
  devDependencies: stringRecordSchema,
});

const wu1HandoffFixtureSchema = z.strictObject({
  version: z.literal(2),
  immutableFiles: stringRecordSchema,
  immutableFilesDigest: digestSchema,
  capabilityProjectionDigest: digestSchema,
  buildRuleDigest: digestSchema,
  packageFoundation: packageFoundationSchema,
  extensionsByWorkUnit: z.record(extensionWorkUnitSchema, packageExtensionSchema),
  requiredAtBoundaryA: z.strictObject({
    dependencies: z.array(z.string().min(1)),
    devDependencies: z.array(z.string().min(1)),
  }),
  wu1LockClosureDigest: digestSchema,
});

const packageManifestSchema = packageFoundationSchema;

const packageSections = ["scripts", "dependencies", "devDependencies"] as const;

export type ExtensionWorkUnit = z.infer<typeof extensionWorkUnitSchema>;
export type PackageExtensionSet = z.infer<typeof packageExtensionSchema>;
export type PackageManifest = z.infer<typeof packageManifestSchema>;
export type Wu1HandoffFixture = z.infer<typeof wu1HandoffFixtureSchema>;

export interface PackageExtensionAnalysis {
  readonly activeWorkUnits: ReadonlySet<ExtensionWorkUnit>;
  readonly errors: readonly string[];
}

export const parseWu1HandoffFixture = (value: unknown): Wu1HandoffFixture =>
  wu1HandoffFixtureSchema.parse(value);

export const parsePackageManifest = (value: unknown): PackageManifest =>
  packageManifestSchema.parse(value);

export const loadWu1HandoffFixture = async (
  path = "test/fixtures/wu1-handoff.json",
): Promise<{ readonly bytes: Buffer; readonly fixture: Wu1HandoffFixture }> => {
  const bytes = await readFile(path);
  return { bytes, fixture: parseWu1HandoffFixture(JSON.parse(bytes.toString("utf8"))) };
};

export const loadPackageManifest = async (
  path = "package.json",
): Promise<PackageManifest> => parsePackageManifest(JSON.parse(await readFile(path, "utf8")));

export const extensionEntries = (
  fixture: Wu1HandoffFixture,
): readonly (readonly [ExtensionWorkUnit, PackageExtensionSet])[] =>
  extensionWorkUnitSchema.options.map((workUnit) =>
    [workUnit, fixture.extensionsByWorkUnit[workUnit]] as const);

const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

const forbiddenPackageSegmentCharacterPattern = /[\\\0@:#?%]/;
const externalPackageSchemePattern = /^[A-Za-z][A-Za-z0-9+.-]*:/;

const validPackageSegment = (value: string): boolean =>
  value.length > 0 && value !== "." && value !== ".." &&
  !forbiddenPackageSegmentCharacterPattern.test(value);

export const packageRootFromSpecifier = (specifier: string): string | undefined => {
  if (
    specifier.length === 0 ||
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("\\") ||
    specifier.startsWith("#") ||
    externalPackageSchemePattern.test(specifier)
  ) return undefined;

  const parts = specifier.split("/");
  const first = parts[0];
  if (first === undefined) return undefined;
  if (first.startsWith("@")) {
    const name = parts[1];
    return first.length > 1 && name !== undefined && validPackageSegment(first.slice(1)) &&
      parts.slice(1).every(validPackageSegment)
      ? `${first}/${name}`
      : undefined;
  }
  return parts.every(validPackageSegment) ? first : undefined;
};

export const isExactPackageRoot = (name: string): boolean =>
  packageRootFromSpecifier(name) === name;

const extensionActivationAttempted = (
  fixture: Wu1HandoffFixture,
  manifest: PackageManifest,
  extension: PackageExtensionSet,
): boolean => {
  for (const section of ["dependencies", "devDependencies"] as const) {
    if (Object.keys(extension[section]).some((name) => Object.hasOwn(manifest[section], name))) return true;
  }
  return Object.keys(extension.scripts).some((name) =>
    Object.hasOwn(manifest.scripts, name) &&
    manifest.scripts[name] !== fixture.packageFoundation.scripts[name]);
};

export const analyzePackageExtensions = (
  fixtureValue: unknown,
  manifestValue: unknown,
): PackageExtensionAnalysis => {
  const fixture = parseWu1HandoffFixture(fixtureValue);
  const manifest = parsePackageManifest(manifestValue);
  const errors: string[] = [];
  const activeWorkUnits = new Set<ExtensionWorkUnit>();
  const extensionDeclarations = {
    scripts: new Map<string, string>(),
    dependencies: new Map<string, string>(),
    devDependencies: new Map<string, string>(),
  };
  const packageDeclarationSections = new Map<string, "dependencies" | "devDependencies">();

  for (const section of ["dependencies", "devDependencies"] as const) {
    for (const name of Object.keys(fixture.packageFoundation[section])) {
      if (!isExactPackageRoot(name)) throw new TypeError(`Package declaration is not an exact package root: WU1:${name}`);
      const previous = packageDeclarationSections.get(name);
      if (previous !== undefined) throw new TypeError(`Duplicate package declaration: WU1:${previous}:${section}:${name}`);
      packageDeclarationSections.set(name, section);
    }
  }

  for (const [workUnit, extension] of extensionEntries(fixture)) {
    for (const section of packageSections) {
      for (const [name, value] of Object.entries(extension[section])) {
        const previous = extensionDeclarations[section].get(name);
        if (previous !== undefined) {
          throw new TypeError(`Duplicate package extension declaration: ${section}:${name}`);
        }
        extensionDeclarations[section].set(name, value);
        if (section !== "scripts") {
          if (!isExactPackageRoot(name)) {
            throw new TypeError(`Package declaration is not an exact package root: ${workUnit}:${name}`);
          }
          const previousSection = packageDeclarationSections.get(name);
          if (previousSection !== undefined) {
            throw new TypeError(`Duplicate package declaration: ${workUnit}:${previousSection}:${section}:${name}`);
          }
          packageDeclarationSections.set(name, section);
        }
      }
    }
  }

  for (const section of packageSections) {
    const actual = manifest[section];
    const foundation = fixture.packageFoundation[section];
    const extensions = extensionDeclarations[section];
    for (const [name, value] of Object.entries(actual)) {
      if (foundation[name] !== value && extensions.get(name) !== value) {
        errors.push(`${section}:${name}@${value}`);
      }
    }
  }

  for (const [workUnit, extension] of extensionEntries(fixture)) {
    if (!extensionActivationAttempted(fixture, manifest, extension)) continue;
    activeWorkUnits.add(workUnit);
    for (const section of packageSections) {
      for (const [name, value] of Object.entries(extension[section])) {
        if (manifest[section][name] !== value) {
          errors.push(`${workUnit}:missing:${section}:${name}@${value}`);
        }
      }
    }
  }

  for (const section of packageSections) {
    for (const [name, value] of Object.entries(fixture.packageFoundation[section])) {
      const overridden = [...activeWorkUnits].some((workUnit) =>
        Object.hasOwn(fixture.extensionsByWorkUnit[workUnit][section], name));
      if (!overridden && manifest[section][name] !== value) {
        errors.push(`WU1:missing:${section}:${name}@${value}`);
      }
    }
  }

  for (const name of fixture.requiredAtBoundaryA.dependencies) {
    if (manifest.dependencies[name] !== extensionDeclarations.dependencies.get(name)) {
      errors.push(`boundaryA:dependency:${name}`);
    }
  }
  for (const name of fixture.requiredAtBoundaryA.devDependencies) {
    if (manifest.devDependencies[name] !== extensionDeclarations.devDependencies.get(name)) {
      errors.push(`boundaryA:devDependency:${name}`);
    }
  }

  return Object.freeze({
    activeWorkUnits,
    errors: Object.freeze([...new Set(errors)].sort(compareText)),
  });
};
