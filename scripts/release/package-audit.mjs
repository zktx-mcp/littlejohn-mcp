import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";

import {
  assertExactFileBytes,
  assertExactPaths,
  canonicalRelativePath,
  collectRegularFiles,
  copyRepositorySource,
  parsePackOutput,
  readJsonFile,
  runCommand,
  sha256,
} from "./release-support.mjs";

const reownNotice = "Portions © 2025 Reown, Inc. All Rights Reserved";
const uniswapSdkNotice = "Uniswap SDK Core and Uniswap V2 SDK";
const uniswapSdkLicenseDigest =
  "610ab47634715eb91e1ac6fe4b69fce3952ee978f294270e5cee367dd88b6b71";
const uniswapSdkDirectDependencies = Object.freeze({
  "@uniswap/sdk-core": "7.19.0",
  "@uniswap/v2-sdk": "4.21.1",
});
const automaticallyPermittedLicenses = new Set([
  "0BSD",
  "MIT",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "BlueOak-1.0.0",
]);
const fixedDistributionArtifacts = Object.freeze([
  Object.freeze({ path: "package.json" }),
  Object.freeze({ path: "LICENSE" }),
  Object.freeze({ path: "THIRD_PARTY_NOTICES.txt" }),
  Object.freeze({
    path: "LICENSES/WALLETCONNECT-COMMUNITY-LICENSE.md",
    licenseName: "WalletConnect",
    digest: "1cb6f8cfe21f54ab1105105717eaa2ba08343037a2a9c41dfd5ab09e3ce270fc",
  }),
  Object.freeze({
    path: "LICENSES/LUCIDE-LICENSE.txt",
    licenseName: "Lucide",
    digest: "b495047bd93a9b06913511076f504daba17d5bbeb3e0650f3bb53a4220329c57",
  }),
]);
const fixedDistributionPaths = Object.freeze(fixedDistributionArtifacts.map(({ path }) => path));
const fixedDistributionPathSet = new Set(fixedDistributionPaths);

const requiredObjectProperty = (input, key, label) => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError(`${label} is invalid.`);
  }
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (descriptor === undefined || !("value" in descriptor)) {
    throw new TypeError(`${label} is invalid.`);
  }
  return descriptor.value;
};

const lockDependencyPath = (packages, importerPath, packageName) => {
  let parent = importerPath;
  for (;;) {
    const candidate = canonicalRelativePath(
      `${parent.length === 0 ? "" : `${parent}/`}node_modules/${packageName}`,
    );
    if (Object.hasOwn(packages, candidate)) return candidate;
    const nestedBoundary = parent.lastIndexOf("/node_modules/");
    if (nestedBoundary < 0) break;
    parent = parent.slice(0, nestedBoundary);
  }
  const rootCandidate = canonicalRelativePath(`node_modules/${packageName}`);
  if (Object.hasOwn(packages, rootCandidate)) return rootCandidate;
  throw new TypeError(`SDK dependency is absent from the lockfile: ${packageName}`);
};

const uniswapSdkLockClosure = (lockfile, manifest) => {
  const packages =
    typeof lockfile === "object" &&
    lockfile !== null &&
    !Array.isArray(lockfile) &&
    typeof lockfile.packages === "object" &&
    lockfile.packages !== null &&
    !Array.isArray(lockfile.packages)
      ? lockfile.packages
      : undefined;
  const dependencies =
    typeof manifest === "object" &&
    manifest !== null &&
    !Array.isArray(manifest) &&
    typeof manifest.dependencies === "object" &&
    manifest.dependencies !== null &&
    !Array.isArray(manifest.dependencies)
      ? manifest.dependencies
      : undefined;
  if (packages === undefined || dependencies === undefined) {
    throw new TypeError("Release dependency authority is invalid.");
  }
  const pending = [];
  for (const [name, version] of Object.entries(uniswapSdkDirectDependencies)) {
    if (Object.getOwnPropertyDescriptor(dependencies, name)?.value !== version) {
      throw new TypeError(`Direct SDK dependency is not exact: ${name}`);
    }
    pending.push(lockDependencyPath(packages, "", name));
  }
  const closure = new Map();
  while (pending.length !== 0) {
    const packagePath = pending.pop();
    if (packagePath === undefined || closure.has(packagePath)) continue;
    const entry = Object.getOwnPropertyDescriptor(packages, packagePath)?.value;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new TypeError(`SDK lockfile entry is invalid: ${packagePath}`);
    }
    if (
      typeof entry.version !== "string" ||
      typeof entry.license !== "string" ||
      !automaticallyPermittedLicenses.has(entry.license) ||
      entry.optional === true ||
      entry.os !== undefined ||
      entry.cpu !== undefined
    ) {
      throw new TypeError(`SDK dependency admission is invalid: ${packagePath}`);
    }
    closure.set(packagePath, Object.freeze({
      version: entry.version,
      license: entry.license,
    }));
    const childDependencies = {
      ...(typeof entry.dependencies === "object" && entry.dependencies !== null
        ? entry.dependencies
        : {}),
      ...(typeof entry.optionalDependencies === "object" &&
        entry.optionalDependencies !== null
        ? entry.optionalDependencies
        : {}),
    };
    for (const name of Object.keys(childDependencies)) {
      pending.push(lockDependencyPath(packages, packagePath, name));
    }
  }
  return Object.freeze([...closure.entries()]
    .sort(([left], [right]) => left.localeCompare(right)));
};

const assertInstalledUniswapSdkClosure = async (
  sourceRoot,
  dependencyRoot,
  sourceManifest,
) => {
  const lockfile = await readJsonFile(resolve(sourceRoot, "package-lock.json"));
  const closure = uniswapSdkLockClosure(lockfile, sourceManifest);
  for (const [packagePath, expected] of closure) {
    const installedManifest = await readJsonFile(resolve(dependencyRoot, packagePath, "package.json"));
    const installedVersion = requiredObjectProperty(
      installedManifest,
      "version",
      `Installed SDK dependency version for ${packagePath}`,
    );
    const installedLicense = requiredObjectProperty(
      installedManifest,
      "license",
      `Installed SDK dependency license for ${packagePath}`,
    );
    const expectedVersion = requiredObjectProperty(
      expected,
      "version",
      `Lockfile SDK dependency version for ${packagePath}`,
    );
    const expectedLicense = requiredObjectProperty(
      expected,
      "license",
      `Lockfile SDK dependency license for ${packagePath}`,
    );
    if (
      typeof installedVersion !== "string" ||
      typeof installedLicense !== "string" ||
      typeof expectedVersion !== "string" ||
      typeof expectedLicense !== "string" ||
      installedVersion !== expectedVersion ||
      installedLicense !== expectedLicense
    ) {
      throw new TypeError(`Installed SDK dependency differs from the lockfile: ${packagePath}`);
    }
  }
  for (const [name, version] of Object.entries(uniswapSdkDirectDependencies)) {
    const packagePath = lockDependencyPath(
      Object.fromEntries(closure.map(([path, value]) => [path, value])),
      "",
      name,
    );
    const packageRoot = resolve(dependencyRoot, packagePath);
    const manifest = await readJsonFile(resolve(packageRoot, "package.json"));
    const manifestName = requiredObjectProperty(
      manifest,
      "name",
      `Installed SDK package name for ${name}`,
    );
    const manifestVersion = requiredObjectProperty(
      manifest,
      "version",
      `Installed SDK package version for ${name}`,
    );
    const exportsValue = requiredObjectProperty(
      manifest,
      "exports",
      `Installed SDK package exports for ${name}`,
    );
    const rootExport = requiredObjectProperty(
      exportsValue,
      ".",
      `Installed SDK root export for ${name}`,
    );
    const requireEntry = requiredObjectProperty(
      rootExport,
      "require",
      `Installed SDK CommonJS export for ${name}`,
    );
    if (
      manifestName !== name ||
      manifestVersion !== version ||
      requireEntry !== "./dist/cjs/src/index.js"
    ) {
      throw new TypeError(`Installed SDK package identity is invalid: ${name}`);
    }
    const entryDetails = await lstat(resolve(packageRoot, requireEntry));
    if (!entryDetails.isFile() || entryDetails.isSymbolicLink()) {
      throw new TypeError(`Installed SDK CommonJS entry is invalid: ${name}`);
    }
    const license = await readFile(resolve(packageRoot, "LICENSE"));
    if (sha256(license) !== uniswapSdkLicenseDigest) {
      throw new TypeError(`Installed SDK license is invalid: ${name}`);
    }
  }
};

/** @type {typeof import("./package-audit.d.mts").parseReleasePackageIdentity} */
export const parseReleasePackageIdentity = (value) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Release package identity is invalid.");
  }
  const name = Object.getOwnPropertyDescriptor(value, "name")?.value;
  const version = Object.getOwnPropertyDescriptor(value, "version")?.value;
  if (typeof name !== "string" || typeof version !== "string") {
    throw new TypeError("Release package identity is invalid.");
  }
  const nameSegments = name.split("/");
  if (
    (name.startsWith("@")
      ? nameSegments.length !== 2 ||
        (nameSegments[0]?.length ?? 0) < 2 ||
        (nameSegments[1]?.length ?? 0) === 0
      : nameSegments.length !== 1) ||
    version.length === 0 ||
    /[\u0000-\u0020\u007f]/u.test(version)
  ) {
    throw new TypeError("Release package identity is invalid.");
  }
  return Object.freeze({
    name,
    version,
    installRelativePath: canonicalRelativePath(`node_modules/${name}`),
  });
};

const isolatedNpmEnvironment = (base, inherited = process.env) => Object.freeze({
  ...inherited,
  HOME: resolve(base, "home"),
  npm_config_cache: resolve(base, "npm-cache"),
  npm_config_audit: "false",
  npm_config_fund: "false",
  npm_config_update_notifier: "false",
});

const assertPackagePathClasses = (paths) => {
  for (const path of paths) {
    if (
      fixedDistributionPathSet.has(path) ||
      path.startsWith("dist/")
    ) continue;
    throw new TypeError(`npm package contains a prohibited path: ${path}`);
  }
};

const expectedPackagePaths = async (sourceRoot) => {
  const distPaths = (await collectRegularFiles(resolve(sourceRoot, "dist")))
    .map((path) => canonicalRelativePath(`dist/${path}`));
  if (distPaths.length === 0) throw new TypeError("Built package dist tree is empty.");
  for (const path of fixedDistributionPaths) {
    const details = await lstat(resolve(sourceRoot, path));
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new TypeError(`Source package artifact must be a regular file: ${path}`);
    }
  }
  const paths = Object.freeze([...fixedDistributionPaths, ...distPaths].sort());
  assertPackagePathClasses(paths);
  return paths;
};

const exactPackageDirectory = async (extractionRoot) => {
  const entries = await import("node:fs/promises").then(({ readdir }) =>
    readdir(extractionRoot, { withFileTypes: true }));
  if (
    entries.length !== 1 ||
    entries[0]?.name !== "package" ||
    !entries[0].isDirectory() ||
    entries[0].isSymbolicLink()
  ) throw new TypeError("Extracted tarball must contain exactly one package directory.");
  return resolve(extractionRoot, "package");
};

const assertDeclarationTargets = async (packageRoot, paths) => {
  const declarationPaths = paths.filter((path) => /\.d\.(?:cts|mts|ts)$/u.test(path));
  const relativeSpecifier = /(?:\bfrom\s*|\bimport\s*\()\s*["'](\.[^"']*)["']/gu;
  const packaged = new Set(paths);
  for (const path of declarationPaths) {
    const source = await readFile(resolve(packageRoot, path), "utf8");
    for (const match of source.matchAll(relativeSpecifier)) {
      const specifier = match[1];
      if (
        specifier === undefined ||
        specifier.includes("?") ||
        specifier.includes("#") ||
        specifier.includes("\\")
      ) throw new TypeError(`Type declaration contains an invalid relative import: ${path}`);
      const target = resolve(dirname(resolve(packageRoot, path)), specifier);
      const fromPackage = relative(packageRoot, target).split(sep).join("/");
      if (
        fromPackage === ".." ||
        fromPackage.startsWith("../") ||
        !fromPackage.startsWith("dist/") ||
        !packaged.has(fromPackage)
      ) throw new TypeError(`Type declaration target is outside the packaged dist graph: ${path}`);
    }
  }
};

const assertDistributionArtifacts = async (sourceRoot, packageRoot) => {
  for (const path of fixedDistributionPaths) {
    const [source, packaged] = await Promise.all([
      readFile(resolve(sourceRoot, path)),
      readFile(resolve(packageRoot, path)),
    ]);
    if (!source.equals(packaged)) throw new TypeError(`Packaged artifact differs from source: ${path}`);
  }
  for (const artifact of fixedDistributionArtifacts) {
    if (!("digest" in artifact)) continue;
    const license = await readFile(resolve(packageRoot, artifact.path));
    if (sha256(license) !== artifact.digest) {
      throw new TypeError(`Packaged ${artifact.licenseName} license digest is invalid.`);
    }
  }
  const notice = await readFile(resolve(packageRoot, "THIRD_PARTY_NOTICES.txt"), "utf8");
  if (notice.split(reownNotice).length !== 2) {
    throw new TypeError("Packaged Reown notice must occur exactly once.");
  }
  if (notice.split(uniswapSdkNotice).length !== 2) {
    throw new TypeError("Packaged Uniswap SDK notice must occur exactly once.");
  }
};

const assertInstalledBinary = async (installRoot, packageRoot) => {
  const manifest = await readJsonFile(resolve(packageRoot, "package.json"));
  const manifestBinary =
    typeof manifest === "object" &&
    manifest !== null &&
    !Array.isArray(manifest)
      ? Object.getOwnPropertyDescriptor(manifest, "bin")?.value
      : undefined;
  if (
    typeof manifestBinary !== "object" ||
    manifestBinary === null ||
    Array.isArray(manifestBinary) ||
    Object.getOwnPropertyDescriptor(manifestBinary, "littlejohn")?.value !== "dist/cli.js"
  ) throw new TypeError("Installed package binary declaration is invalid.");
  const binaryPath = resolve(installRoot, "node_modules/.bin/littlejohn");
  const details = await lstat(binaryPath);
  if (!details.isSymbolicLink() && !details.isFile()) {
    throw new TypeError("Installed package binary is unavailable.");
  }
  const target = await realpath(binaryPath);
  if (target !== await realpath(resolve(packageRoot, "dist/cli.js"))) {
    throw new TypeError("Installed package binary resolves outside the packaged dist tree.");
  }
};

/** @type {typeof import("./package-audit.d.mts").prepareReleasePackage} */
export const prepareReleasePackage = async (repositoryRoot) => {
  const workspace = await mkdtemp(resolve(tmpdir(), "littlejohn-release-"));
  const sourceRoot = resolve(workspace, "repository");
  const packRoot = resolve(workspace, "pack");
  const extractionRoot = resolve(workspace, "extracted");
  const installRoot = resolve(workspace, "install");
  const npxRoot = resolve(workspace, "npx");
  const environment = isolatedNpmEnvironment(workspace);
  await Promise.all([
    mkdir(resolve(workspace, "home"), { recursive: true, mode: 0o700 }),
    mkdir(packRoot, { recursive: true, mode: 0o700 }),
    mkdir(extractionRoot, { recursive: true, mode: 0o700 }),
    mkdir(installRoot, { recursive: true, mode: 0o700 }),
    mkdir(npxRoot, { recursive: true, mode: 0o700 }),
  ]);

  try {
    await copyRepositorySource(repositoryRoot, sourceRoot);
    const sourceManifest = await readJsonFile(resolve(sourceRoot, "package.json"));
    const packageIdentity = parseReleasePackageIdentity(sourceManifest);
    const lockBefore = await readFile(resolve(sourceRoot, "package-lock.json"));
    await runCommand("npm", ["ci"], { cwd: sourceRoot, env: environment });
    const lockAfter = await readFile(resolve(sourceRoot, "package-lock.json"));
    if (!lockBefore.equals(lockAfter)) {
      throw new TypeError("npm ci changed the repository dependency lock.");
    }
    await assertInstalledUniswapSdkClosure(sourceRoot, sourceRoot, sourceManifest);
    await runCommand(process.execPath, [
      resolve(sourceRoot, "node_modules/typescript/bin/tsc"),
      "-p",
      "scripts/release/tsconfig.json",
    ], { cwd: sourceRoot, env: environment });
    await runCommand("npm", ["run", "typecheck"], { cwd: sourceRoot, env: environment });
    await runCommand("npm", ["test"], { cwd: sourceRoot, env: environment });
    await runCommand("npm", ["run", "build"], { cwd: sourceRoot, env: environment });

    const expectedPaths = await expectedPackagePaths(sourceRoot);
    const packResult = parsePackOutput((await runCommand("npm", [
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      packRoot,
    ], { cwd: sourceRoot, env: environment, output: "capture" })).stdout);
    const tarballPath = resolve(packRoot, packResult.filename);
    const tarballDetails = await lstat(tarballPath);
    if (!tarballDetails.isFile() || tarballDetails.isSymbolicLink() || tarballDetails.size === 0) {
      throw new TypeError("npm pack did not create a regular tarball.");
    }
    assertPackagePathClasses(packResult.paths);
    assertExactPaths(packResult.paths, expectedPaths, "npm pack");

    await runCommand("tar", ["-xzf", tarballPath, "-C", extractionRoot]);
    const extractedPackageRoot = await exactPackageDirectory(extractionRoot);
    const extractedPaths = await collectRegularFiles(extractedPackageRoot);
    assertExactPaths(extractedPaths, expectedPaths, "extracted package");
    await assertExactFileBytes(sourceRoot, extractedPackageRoot, expectedPaths, "extracted package");
    await assertDistributionArtifacts(sourceRoot, extractedPackageRoot);
    await assertDeclarationTargets(extractedPackageRoot, extractedPaths);

    await writeFile(resolve(installRoot, "package.json"), `${JSON.stringify({
      name: "littlejohn-release-install",
      version: "1.0.0",
      private: true,
    }, null, 2)}\n`);
    await runCommand("npm", [
      "install",
      "--no-audit",
      "--no-fund",
      "--save-exact",
      tarballPath,
    ], { cwd: installRoot, env: environment });
    await assertInstalledUniswapSdkClosure(sourceRoot, installRoot, sourceManifest);
    const installedPackageRoot = resolve(installRoot, packageIdentity.installRelativePath);
    const installedPaths = await collectRegularFiles(installedPackageRoot);
    assertExactPaths(installedPaths, expectedPaths, "installed package");
    await assertExactFileBytes(sourceRoot, installedPackageRoot, expectedPaths, "installed package");
    await assertDistributionArtifacts(sourceRoot, installedPackageRoot);
    await assertInstalledBinary(installRoot, installedPackageRoot);

    if ((await readdir(npxRoot)).length !== 0) {
      throw new TypeError("Local tarball npx smoke must start from an empty directory.");
    }
    const help = await runCommand("npx", [
      "--yes",
      "--package",
      tarballPath,
      "littlejohn",
      "--help",
    ], { cwd: npxRoot, env: environment, output: "capture" });
    const directHelp = await runCommand(process.execPath, [
      resolve(installedPackageRoot, "dist/cli.js"),
      "--help",
    ], { cwd: installRoot, env: environment, output: "capture" });
    if (!help.stdout.equals(directHelp.stdout)) {
      throw new TypeError("Local tarball npx smoke returned an unexpected CLI surface.");
    }

    return Object.freeze({
      environment,
      extractedPackageRoot,
      installRoot,
      installedPackageRoot,
      npxRoot,
      packageIdentity,
      sourceRoot,
      tarballPath,
      workspace,
      cleanup: () => rm(workspace, { recursive: true, force: true }),
    });
  } catch (error) {
    await rm(workspace, { recursive: true, force: true });
    throw error;
  }
};
