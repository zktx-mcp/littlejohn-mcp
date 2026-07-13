import { lstat, readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import {
  canonicalJsonStringify,
  compareCodePointSequences,
  createRuntimeBuildIdentity,
  parseRuntimeBuildIdentity,
  sha256Bytes,
  type CanonicalJson,
  type RuntimeBuildIdentity,
} from "../core/index.js";

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

const existingPackageArtifacts = async (packageRoot: string): Promise<string[]> => {
  const artifacts: string[] = [];
  for (const relativePath of ["THIRD_PARTY_NOTICES.txt", "LICENSES"]) {
    const path = resolve(packageRoot, relativePath);
    try {
      const details = await lstat(path);
      if (details.isDirectory()) artifacts.push(...await collectFiles(path));
      else if (details.isFile()) artifacts.push(path);
      else throw new TypeError("Packaged notice content must contain only regular files and directories.");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
  }
  return artifacts;
};

export const readRuntimeBuildFiles = async (
  packageRoot: string,
  distDirectory: string,
  identityPath: string,
): Promise<Readonly<Record<string, string>>> => {
  const candidates = [
    resolve(packageRoot, "package.json"),
    resolve(packageRoot, "npm-shrinkwrap.json"),
    ...await existingPackageArtifacts(packageRoot),
    ...(await collectFiles(distDirectory)).filter((path) => path !== identityPath),
  ];
  const files: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const path of candidates.sort(compareCodePointSequences)) {
    const key = relative(packageRoot, path).split(sep).join("/");
    if (key.startsWith("../") || files[key] !== undefined) {
      throw new TypeError("Runtime build file identity is invalid.");
    }
    files[key] = sha256Bytes(await readFile(path));
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
