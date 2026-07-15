import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { canonicalJsonStringify, type CanonicalJson } from "../../src/core/index.js";
import {
  createRuntimeBuildIdentityFromFiles,
  verifyRuntimeBuildIdentityFiles,
} from "../../src/build/runtime-file-set.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const fixture = async () => {
  const root = await mkdtemp(resolve(tmpdir(), "littlejohn-build-"));
  directories.push(root);
  const dist = resolve(root, "dist");
  const generated = resolve(dist, "generated");
  const webAssets = resolve(dist, "web/assets");
  await mkdir(generated, { recursive: true });
  await mkdir(webAssets, { recursive: true });
  await writeFile(resolve(root, "package.json"), `${JSON.stringify({
    files: ["dist", "npm-shrinkwrap.json", "THIRD_PARTY_NOTICES.txt"],
  })}\n`);
  await writeFile(resolve(root, "npm-shrinkwrap.json"), "{}\n");
  await writeFile(resolve(root, "THIRD_PARTY_NOTICES.txt"), "notice\n");
  await writeFile(resolve(dist, "runtime.js"), "export {};\n");
  await writeFile(resolve(webAssets, "application-a1b2c3.js"), "export {};\n");
  const identityPath = resolve(generated, "runtime-build-identity.json");
  const identity = await createRuntimeBuildIdentityFromFiles(root, dist, identityPath);
  await writeFile(identityPath, `${canonicalJsonStringify(identity as unknown as CanonicalJson)}\n`);
  return { root, dist, identityPath, identity };
};

describe("runtime build file identity", () => {
  it("verifies the exact file set and file bytes", async () => {
    const built = await fixture();
    expect(built.identity.files).toHaveProperty("dist/web/assets/application-a1b2c3.js");
    expect(built.identity.files).toHaveProperty("THIRD_PARTY_NOTICES.txt");
    await expect(verifyRuntimeBuildIdentityFiles(
      built.identity,
      built.root,
      built.dist,
      built.identityPath,
    )).resolves.toEqual(built.identity);

    await writeFile(resolve(built.dist, "runtime.js"), "export const changed = true;\n");
    await expect(verifyRuntimeBuildIdentityFiles(
      built.identity,
      built.root,
      built.dist,
      built.identityPath,
    )).rejects.toThrow("do not match");
  });

  it("rejects an extra compiled file even when the identity label is unchanged", async () => {
    const built = await fixture();
    await writeFile(resolve(built.dist, "unexpected.js"), "export {};\n");
    await expect(verifyRuntimeBuildIdentityFiles(
      built.identity,
      built.root,
      built.dist,
      built.identityPath,
    )).rejects.toThrow("do not match");
  });

  it("fails closed on symlinks instead of omitting them from build identity", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "littlejohn-build-symlink-"));
    directories.push(root);
    const dist = resolve(root, "dist");
    await mkdir(dist, { recursive: true });
    await writeFile(resolve(root, "package.json"), `${JSON.stringify({
      files: ["dist", "npm-shrinkwrap.json"],
    })}\n`);
    await writeFile(resolve(root, "npm-shrinkwrap.json"), "{}\n");
    await writeFile(resolve(root, "outside.js"), "export {};\n");
    await symlink(resolve(root, "outside.js"), resolve(dist, "linked.js"));
    await expect(createRuntimeBuildIdentityFromFiles(
      root,
      dist,
      resolve(dist, "generated/runtime-build-identity.json"),
    )).rejects.toThrow("only regular files");
  });

  it("rejects symbolic links in a declared root's parent path", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "littlejohn-build-parent-symlink-"));
    directories.push(root);
    const dist = resolve(root, "dist");
    const outside = resolve(root, "outside");
    await mkdir(dist, { recursive: true });
    await mkdir(resolve(outside, "sub"), { recursive: true });
    await writeFile(resolve(dist, "runtime.js"), "export {};\n");
    await writeFile(resolve(root, "npm-shrinkwrap.json"), "{}\n");
    await writeFile(resolve(outside, "sub/escaped.txt"), "outside\n");
    await symlink(outside, resolve(root, "notices"));
    await writeFile(resolve(root, "package.json"), `${JSON.stringify({
      files: ["dist", "notices/sub", "npm-shrinkwrap.json"],
    })}\n`);

    await expect(createRuntimeBuildIdentityFromFiles(
      root,
      dist,
      resolve(dist, "generated/runtime-build-identity.json"),
    )).rejects.toThrow("root parents must be regular directories");
  });

  it("rejects a symbolic-link package manifest", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "littlejohn-build-manifest-symlink-"));
    directories.push(root);
    const dist = resolve(root, "dist");
    await mkdir(dist, { recursive: true });
    await writeFile(resolve(root, "manifest.json"), `${JSON.stringify({
      files: ["dist", "npm-shrinkwrap.json"],
    })}\n`);
    await symlink(resolve(root, "manifest.json"), resolve(root, "package.json"));
    await writeFile(resolve(root, "npm-shrinkwrap.json"), "{}\n");
    await writeFile(resolve(dist, "runtime.js"), "export {};\n");

    await expect(createRuntimeBuildIdentityFromFiles(
      root,
      dist,
      resolve(dist, "generated/runtime-build-identity.json"),
    )).rejects.toThrow("manifest must be a regular file");
  });

  it("rejects a filesystem alias for the package manifest name", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "littlejohn-build-manifest-alias-"));
    directories.push(root);
    const dist = resolve(root, "dist");
    const canonicalManifest = resolve(root, "package.json");
    const aliasedManifest = resolve(root, "Package.json");
    await mkdir(dist, { recursive: true });
    await writeFile(aliasedManifest, `${JSON.stringify({
      files: ["dist", "npm-shrinkwrap.json"],
    })}\n`);
    await writeFile(resolve(root, "npm-shrinkwrap.json"), "{}\n");
    await writeFile(resolve(dist, "runtime.js"), "export {};\n");

    let aliasResolvesToManifest = false;
    try {
      aliasResolvesToManifest = await realpath(canonicalManifest) === await realpath(aliasedManifest);
    } catch {
      return;
    }
    if (!aliasResolvesToManifest) return;

    await expect(createRuntimeBuildIdentityFromFiles(
      root,
      dist,
      resolve(dist, "generated/runtime-build-identity.json"),
    )).rejects.toThrow("manifest path is invalid");
  });

  it("rejects a manifest that does not package the dependency lock", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "littlejohn-build-unlocked-"));
    directories.push(root);
    const dist = resolve(root, "dist");
    await mkdir(dist, { recursive: true });
    await writeFile(resolve(root, "package.json"), `${JSON.stringify({ files: ["dist"] })}\n`);
    await writeFile(resolve(root, "npm-shrinkwrap.json"), "{}\n");
    await writeFile(resolve(dist, "runtime.js"), "export {};\n");

    await expect(createRuntimeBuildIdentityFromFiles(
      root,
      dist,
      resolve(dist, "generated/runtime-build-identity.json"),
    )).rejects.toThrow("content roots are incomplete");
  });

  it("rejects globbed or overlapping package roots", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "littlejohn-build-roots-"));
    directories.push(root);
    const dist = resolve(root, "dist");
    await mkdir(dist, { recursive: true });
    await writeFile(resolve(root, "npm-shrinkwrap.json"), "{}\n");
    await writeFile(resolve(dist, "runtime.js"), "export {};\n");

    await writeFile(resolve(root, "package.json"), `${JSON.stringify({
      files: ["dist/**", "npm-shrinkwrap.json"],
    })}\n`);
    await expect(createRuntimeBuildIdentityFromFiles(
      root,
      dist,
      resolve(dist, "generated/runtime-build-identity.json"),
    )).rejects.toThrow("content roots are invalid");

    await writeFile(resolve(root, "package.json"), `${JSON.stringify({
      files: ["dist", "dist/runtime.js", "npm-shrinkwrap.json"],
    })}\n`);
    await expect(createRuntimeBuildIdentityFromFiles(
      root,
      dist,
      resolve(dist, "generated/runtime-build-identity.json"),
    )).rejects.toThrow("content roots are invalid");

    await mkdir(resolve(dist, "empty"));
    await writeFile(resolve(root, "package.json"), `${JSON.stringify({
      files: ["dist", "dist/empty", "npm-shrinkwrap.json"],
    })}\n`);
    await expect(createRuntimeBuildIdentityFromFiles(
      root,
      dist,
      resolve(dist, "generated/runtime-build-identity.json"),
    )).rejects.toThrow("content roots are invalid");
  });

  it("rejects filesystem aliases that change a content root's physical spelling", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "littlejohn-build-alias-roots-"));
    directories.push(root);
    const dist = resolve(root, "dist");
    const canonicalRoot = resolve(root, "CaseRoot");
    const aliasRoot = resolve(root, "caseroot");
    await mkdir(dist, { recursive: true });
    await mkdir(resolve(canonicalRoot, "sub"), { recursive: true });
    await writeFile(resolve(root, "npm-shrinkwrap.json"), "{}\n");
    await writeFile(resolve(dist, "runtime.js"), "export {};\n");
    await writeFile(resolve(canonicalRoot, "sub/content.txt"), "content\n");

    let aliasResolvesToCanonicalRoot = false;
    try {
      aliasResolvesToCanonicalRoot = await realpath(aliasRoot) === await realpath(canonicalRoot);
    } catch {
      return;
    }
    if (!aliasResolvesToCanonicalRoot) return;

    await writeFile(resolve(root, "package.json"), `${JSON.stringify({
      files: ["dist", "npm-shrinkwrap.json", "CaseRoot", "caseroot/sub"],
    })}\n`);
    await expect(createRuntimeBuildIdentityFromFiles(
      root,
      dist,
      resolve(dist, "generated/runtime-build-identity.json"),
    )).rejects.toThrow("content roots are invalid");
  });
});
