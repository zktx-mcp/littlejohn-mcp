import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import {
  buildPathSchema,
  canonicalJsonStringify,
  compareCodePointSequences,
  createRuntimeBuildIdentity,
  parseRuntimeBuildIdentity,
  sha256Bytes,
  type CanonicalJson,
  type RuntimeBuildIdentity,
} from "../core/index.js";

const packageManifestName = "package.json";
const dependencyLockName = "npm-shrinkwrap.json";
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

const collectFiles = async (directory: string): Promise<string[]> => {
  const root = await lstat(directory);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new TypeError("Runtime build directory must be a regular directory.");
  }
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(path));
    else if (entry.isFile()) files.push(path);
    else throw new TypeError("Runtime build content must contain only regular files and directories.");
  }
  return files;
};

const canonicalRelativePath = (root: string, path: string): string => {
  const value = relative(root, path).split(sep).join("/");
  const parsed = buildPathSchema.safeParse(value);
  if (!parsed.success) throw new TypeError("Runtime package path is invalid.");
  return parsed.data;
};

const assertRegularPackageRoot = async (packageRoot: string): Promise<void> => {
  const details = await lstat(packageRoot);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new TypeError("Runtime package root must be a regular directory.");
  }
};

const assertContentRootParents = async (
  packageRoot: string,
  relativeRoot: string,
): Promise<void> => {
  await assertRegularPackageRoot(packageRoot);
  const segments = relativeRoot.split("/");
  let current = packageRoot;
  for (const segment of segments.slice(0, -1)) {
    current = resolve(current, segment);
    const details = await lstat(current);
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new TypeError("Runtime package content root parents must be regular directories.");
    }
  }
};

const parsePackageContentRoots = async (
  packageRoot: string,
  distDirectory: string,
  manifestBytes: Uint8Array,
): Promise<readonly string[]> => {
  let manifest: unknown;
  try { manifest = JSON.parse(utf8Decoder.decode(manifestBytes)); }
  catch { throw new TypeError("Runtime package manifest is invalid."); }
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    Array.isArray(manifest) ||
    Object.getPrototypeOf(manifest) !== Object.prototype
  ) throw new TypeError("Runtime package manifest is invalid.");

  const filesDescriptor = Object.getOwnPropertyDescriptor(manifest, "files");
  if (
    filesDescriptor === undefined ||
    !("value" in filesDescriptor) ||
    !Array.isArray(filesDescriptor.value) ||
    Object.getPrototypeOf(filesDescriptor.value) !== Array.prototype ||
    filesDescriptor.value.length === 0
  ) throw new TypeError("Runtime package content roots are invalid.");

  const packageRealPath = await realpath(packageRoot);
  const roots: string[] = [];
  const names = new Set<string>();
  for (const value of filesDescriptor.value as unknown[]) {
    if (typeof value !== "string" || /[*?\[\]{}!]/u.test(value)) {
      throw new TypeError("Runtime package content roots are invalid.");
    }
    const parsed = buildPathSchema.safeParse(value);
    if (!parsed.success || names.has(parsed.data)) {
      throw new TypeError("Runtime package content roots are invalid.");
    }
    const root = resolve(packageRoot, parsed.data);
    if (canonicalRelativePath(packageRoot, root) !== parsed.data) {
      throw new TypeError("Runtime package content roots are invalid.");
    }
    await assertContentRootParents(packageRoot, parsed.data);
    const physicalName = canonicalRelativePath(packageRealPath, await realpath(root));
    if (physicalName !== parsed.data) {
      throw new TypeError("Runtime package content roots are invalid.");
    }
    names.add(parsed.data);
    roots.push(root);
  }

  const orderedNames = [...names].sort(compareCodePointSequences);
  for (let index = 0; index < orderedNames.length; index += 1) {
    const left = orderedNames[index];
    if (left === undefined) throw new TypeError("Runtime package content roots are invalid.");
    for (const right of orderedNames.slice(index + 1)) {
      if (right.startsWith(`${left}/`)) {
        throw new TypeError("Runtime package content roots are invalid.");
      }
    }
  }

  const distName = canonicalRelativePath(packageRoot, distDirectory);
  if (!names.has(distName) || !names.has(dependencyLockName) || names.has(packageManifestName)) {
    throw new TypeError("Runtime package content roots are incomplete.");
  }
  return Object.freeze(roots.sort((left, right) => compareCodePointSequences(
    canonicalRelativePath(packageRoot, left),
    canonicalRelativePath(packageRoot, right),
  )));
};

const collectPackageContent = async (
  packageRoot: string,
  roots: readonly string[],
): Promise<string[]> => {
  const artifacts: string[] = [];
  for (const root of roots) {
    await assertContentRootParents(packageRoot, canonicalRelativePath(packageRoot, root));
    const details = await lstat(root);
    if (details.isDirectory() && !details.isSymbolicLink()) artifacts.push(...await collectFiles(root));
    else if (details.isFile() && !details.isSymbolicLink()) artifacts.push(root);
    else throw new TypeError("Runtime package content must contain only regular files and directories.");
  }
  return artifacts;
};

export const readRuntimeBuildFiles = async (
  packageRoot: string,
  distDirectory: string,
  identityPath: string,
): Promise<Readonly<Record<string, string>>> => {
  const packageManifestPath = resolve(packageRoot, packageManifestName);
  await assertRegularPackageRoot(packageRoot);
  const manifestDetails = await lstat(packageManifestPath);
  if (!manifestDetails.isFile() || manifestDetails.isSymbolicLink()) {
    throw new TypeError("Runtime package manifest must be a regular file.");
  }
  const packageRealPath = await realpath(packageRoot);
  const manifestPhysicalName = canonicalRelativePath(
    packageRealPath,
    await realpath(packageManifestPath),
  );
  if (manifestPhysicalName !== packageManifestName) {
    throw new TypeError("Runtime package manifest path is invalid.");
  }
  const manifestBytes = await readFile(packageManifestPath);
  const identityRelativeToDist = relative(distDirectory, identityPath);
  if (
    identityRelativeToDist === "" ||
    identityRelativeToDist === ".." ||
    identityRelativeToDist.startsWith(`..${sep}`)
  ) throw new TypeError("Runtime build identity path is invalid.");
  const contentRoots = await parsePackageContentRoots(packageRoot, distDirectory, manifestBytes);
  const candidates = [
    packageManifestPath,
    ...(await collectPackageContent(packageRoot, contentRoots)).filter((path) => path !== identityPath),
  ];
  const files: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const path of candidates.sort(compareCodePointSequences)) {
    const key = canonicalRelativePath(packageRoot, path);
    if (files[key] !== undefined) {
      throw new TypeError("Runtime build file identity is invalid.");
    }
    files[key] = sha256Bytes(path === packageManifestPath ? manifestBytes : await readFile(path));
  }
  return Object.freeze(files);
};

export const createRuntimeBuildIdentityFromFiles = async (
  packageRoot: string,
  distDirectory: string,
  identityPath: string,
): Promise<RuntimeBuildIdentity> =>
  createRuntimeBuildIdentity(await readRuntimeBuildFiles(packageRoot, distDirectory, identityPath));

export const verifyRuntimeBuildIdentityFiles = async (
  identityInput: unknown,
  packageRoot: string,
  distDirectory: string,
  identityPath: string,
): Promise<RuntimeBuildIdentity> => {
  const identity = parseRuntimeBuildIdentity(identityInput);
  const actual = createRuntimeBuildIdentity(await readRuntimeBuildFiles(packageRoot, distDirectory, identityPath));
  if (
    canonicalJsonStringify(identity as unknown as CanonicalJson) !==
    canonicalJsonStringify(actual as unknown as CanonicalJson)
  ) throw new TypeError("Runtime build files do not match the generated build identity.");
  return identity;
};
