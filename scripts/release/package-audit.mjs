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
  assertExactPaths,
  canonicalRelativePath,
  collectRegularFiles,
  copyRepositorySource,
  parsePackOutput,
  readJsonFile,
  runCommand,
  sha256,
} from "./release-support.mjs";

const runtimeIdentityRelativePath = "dist/generated/runtime-build-identity.json";
const walletConnectLicenseRelativePath = "LICENSES/WALLETCONNECT-COMMUNITY-LICENSE.md";
const walletConnectLicenseDigest =
  "1cb6f8cfe21f54ab1105105717eaa2ba08343037a2a9c41dfd5ab09e3ce270fc";
const reownNotice = "Portions © 2025 Reown, Inc. All Rights Reserved";

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

const runtimeIdentityProbe = `
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { verifyRuntimeBuildIdentityFiles } from "./dist/build/runtime-file-set.js";
const rootInput = process.env.LITTLEJOHN_RELEASE_PACKAGE_ROOT;
if (typeof rootInput !== "string") throw new TypeError("Release package root is unavailable.");
const root = resolve(rootInput);
const dist = resolve(root, "dist");
const identityPath = resolve(root, ${JSON.stringify(runtimeIdentityRelativePath)});
const input = JSON.parse(await readFile(identityPath, "utf8"));
const identity = await verifyRuntimeBuildIdentityFiles(input, root, dist, identityPath);
process.stdout.write(JSON.stringify(identity));
`;

const isolatedNpmEnvironment = (base, inherited = process.env) => Object.freeze({
  ...inherited,
  HOME: resolve(base, "home"),
  npm_config_cache: resolve(base, "npm-cache"),
  npm_config_audit: "false",
  npm_config_fund: "false",
  npm_config_update_notifier: "false",
});

const verifyRuntimeIdentity = async (
  packageRoot,
  environment,
  verifierRoot = packageRoot,
) => {
  const result = await runCommand(
    process.execPath,
    ["--input-type=module", "--eval", runtimeIdentityProbe],
    {
      cwd: verifierRoot,
      env: {
        ...environment,
        LITTLEJOHN_RELEASE_PACKAGE_ROOT: packageRoot,
      },
      output: "capture",
    },
  );
  let identity;
  try { identity = JSON.parse(result.stdout.toString("utf8")); }
  catch { throw new TypeError("Runtime build identity probe returned invalid JSON."); }
  if (
    typeof identity !== "object" ||
    identity === null ||
    Array.isArray(identity) ||
    typeof identity.files !== "object" ||
    identity.files === null ||
    Array.isArray(identity.files)
  ) throw new TypeError("Runtime build identity probe returned an invalid identity.");
  return identity;
};

const expectedPackagePaths = (identity) => Object.freeze([
  ...Object.keys(identity.files),
  runtimeIdentityRelativePath,
].sort());

const assertPackagePathClasses = (paths) => {
  for (const path of paths) {
    if (
      path === "package.json" ||
      path === "npm-shrinkwrap.json" ||
      path === "THIRD_PARTY_NOTICES.txt" ||
      path === walletConnectLicenseRelativePath ||
      path.startsWith("dist/")
    ) continue;
    throw new TypeError(`npm package contains a prohibited path: ${path}`);
  }
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

const normalizeDependencyNode = (value, expectedName) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("npm dependency graph is invalid.");
  }
  if (Object.keys(value).length === 0) return undefined;
  const name = typeof value.name === "string" ? value.name : expectedName;
  const version = value.version;
  if (name !== expectedName || typeof version !== "string") {
    throw new TypeError("npm dependency graph identity is invalid.");
  }
  const dependencies = value.dependencies;
  const normalized = {};
  if (dependencies !== undefined) {
    if (typeof dependencies !== "object" || dependencies === null || Array.isArray(dependencies)) {
      throw new TypeError("npm dependency graph children are invalid.");
    }
    for (const dependencyName of Object.keys(dependencies).sort()) {
      const child = normalizeDependencyNode(
        dependencies[dependencyName],
        dependencyName,
      );
      if (child !== undefined) normalized[dependencyName] = child;
    }
  }
  const peerDependenciesMeta = value.peerDependenciesMeta;
  const optionalPeerDependencies = [];
  if (peerDependenciesMeta !== undefined) {
    if (
      typeof peerDependenciesMeta !== "object" ||
      peerDependenciesMeta === null ||
      Array.isArray(peerDependenciesMeta)
    ) throw new TypeError("npm dependency graph peer metadata is invalid.");
    for (const dependencyName of Object.keys(peerDependenciesMeta).sort()) {
      const metadata = peerDependenciesMeta[dependencyName];
      if (
        typeof metadata !== "object" ||
        metadata === null ||
        Array.isArray(metadata)
      ) throw new TypeError("npm dependency graph peer metadata entry is invalid.");
      if (metadata.optional === true) optionalPeerDependencies.push(dependencyName);
    }
  }
  return Object.freeze({
    name,
    version,
    dependencies: Object.freeze(normalized),
    optionalPeerDependencies: Object.freeze(optionalPeerDependencies),
  });
};

/** @type {typeof import("./package-audit.d.mts").dependencyGraphDifferences} */
export const dependencyGraphDifferences = (
  repository,
  consumer,
) => {
  const differences = [];
  const visit = (repositoryNode, consumerNode, path) => {
    if (repositoryNode === undefined || consumerNode === undefined) {
      differences.push(
        `${path}: repository=${repositoryNode?.version ?? "absent"}, consumer=${consumerNode?.version ?? "absent"}`,
      );
      return;
    }
    if (
      repositoryNode.name !== consumerNode.name ||
      repositoryNode.version !== consumerNode.version
    ) {
      differences.push(
        `${path}: repository=${repositoryNode.name}@${repositoryNode.version}, consumer=${consumerNode.name}@${consumerNode.version}`,
      );
    }
    const dependencyNames = [...new Set([
      ...Object.keys(repositoryNode.dependencies),
      ...Object.keys(consumerNode.dependencies),
    ])].sort();
    for (const dependencyName of dependencyNames) {
      const repositoryDependency = repositoryNode.dependencies[dependencyName];
      const consumerDependency = consumerNode.dependencies[dependencyName];
      if (
        repositoryDependency !== undefined &&
        consumerDependency === undefined &&
        repositoryNode.optionalPeerDependencies.includes(dependencyName)
      ) continue;
      visit(
        repositoryDependency,
        consumerDependency,
        `${path} > ${dependencyName}`,
      );
    }
  };
  visit(repository, consumer, repository.name);
  return Object.freeze(differences);
};

const readDependencyGraph = async (
  cwd,
  environment,
  packageName,
  packageLockOnly = false,
) => {
  const result = await runCommand(
    "npm",
    [
      "ls",
      "--all",
      "--long",
      "--omit=dev",
      ...(packageLockOnly ? ["--package-lock-only"] : []),
      "--json",
    ],
    { cwd, env: environment, output: "capture" },
  );
  let value;
  try { value = JSON.parse(result.stdout.toString("utf8")); }
  catch { throw new TypeError("npm dependency graph output is invalid JSON."); }
  if (value.name === packageName) {
    const root = normalizeDependencyNode(value, packageName);
    if (root === undefined) throw new TypeError("npm dependency graph root is unavailable.");
    return root;
  }
  const dependency = value.dependencies?.[packageName];
  const root = normalizeDependencyNode(dependency, packageName);
  if (root === undefined) throw new TypeError("npm dependency graph package is unavailable.");
  return root;
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
  for (const path of [
    "package.json",
    "npm-shrinkwrap.json",
    "THIRD_PARTY_NOTICES.txt",
    walletConnectLicenseRelativePath,
  ]) {
    const [source, packaged] = await Promise.all([
      readFile(resolve(sourceRoot, path)),
      readFile(resolve(packageRoot, path)),
    ]);
    if (!source.equals(packaged)) throw new TypeError(`Packaged artifact differs from source: ${path}`);
  }
  const license = await readFile(resolve(packageRoot, walletConnectLicenseRelativePath));
  if (sha256(license) !== walletConnectLicenseDigest) {
    throw new TypeError("Packaged WalletConnect license digest is invalid.");
  }
  const notice = await readFile(resolve(packageRoot, "THIRD_PARTY_NOTICES.txt"), "utf8");
  if (notice.split(reownNotice).length !== 2) {
    throw new TypeError("Packaged Reown notice must occur exactly once.");
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
    const sourceDependencies =
      typeof sourceManifest === "object" &&
      sourceManifest !== null &&
      !Array.isArray(sourceManifest)
        ? Object.getOwnPropertyDescriptor(sourceManifest, "dependencies")?.value
        : undefined;
    if (
      typeof sourceDependencies !== "object" ||
      sourceDependencies === null ||
      Array.isArray(sourceDependencies)
    ) throw new TypeError("Source dependency manifest is invalid.");
    const shrinkwrapBefore = await readFile(resolve(sourceRoot, "npm-shrinkwrap.json"));
    await runCommand("npm", ["ci"], { cwd: sourceRoot, env: environment });
    const shrinkwrapAfter = await readFile(resolve(sourceRoot, "npm-shrinkwrap.json"));
    if (!shrinkwrapBefore.equals(shrinkwrapAfter)) {
      throw new TypeError("npm ci changed the repository shrinkwrap.");
    }
    await runCommand(process.execPath, [
      resolve(sourceRoot, "node_modules/typescript/bin/tsc"),
      "-p",
      "scripts/release/tsconfig.json",
    ], { cwd: sourceRoot, env: environment });
    await runCommand("npm", ["run", "typecheck"], { cwd: sourceRoot, env: environment });
    await runCommand("npm", ["test"], { cwd: sourceRoot, env: environment });
    await runCommand("npm", ["run", "build"], { cwd: sourceRoot, env: environment });

    const sourceIdentity = await verifyRuntimeIdentity(sourceRoot, environment);
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
    const expectedPaths = expectedPackagePaths(sourceIdentity);
    assertPackagePathClasses(packResult.paths);
    assertExactPaths(packResult.paths, expectedPaths, "npm pack");

    await runCommand("tar", ["-xzf", tarballPath, "-C", extractionRoot]);
    const extractedPackageRoot = await exactPackageDirectory(extractionRoot);
    const extractedPaths = await collectRegularFiles(extractedPackageRoot);
    assertExactPaths(extractedPaths, expectedPaths, "extracted package");
    await verifyRuntimeIdentity(extractedPackageRoot, environment, sourceRoot);
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
    const installedPackageRoot = resolve(installRoot, packageIdentity.installRelativePath);
    await verifyRuntimeIdentity(installedPackageRoot, environment);
    await assertDistributionArtifacts(sourceRoot, installedPackageRoot);
    await assertInstalledBinary(installRoot, installedPackageRoot);

    const [sourceGraph, installedGraph] = await Promise.all([
      readDependencyGraph(sourceRoot, environment, packageIdentity.name, true),
      readDependencyGraph(installRoot, environment, packageIdentity.name),
    ]);
    const dependencyDifferences = dependencyGraphDifferences(sourceGraph, installedGraph);
    if (dependencyDifferences.length > 0) {
      throw new TypeError(
        `Installed runtime dependency graph differs from the repository shrinkwrap:\n${dependencyDifferences.join("\n")}`,
      );
    }

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
    if (!help.stdout.toString("utf8").startsWith("Usage:\n  littlejohn read chain-status")) {
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
