import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
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
  await writeFile(resolve(root, "package.json"), "{}\n");
  await writeFile(resolve(root, "npm-shrinkwrap.json"), "{}\n");
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
    await writeFile(resolve(root, "package.json"), "{}\n");
    await writeFile(resolve(root, "npm-shrinkwrap.json"), "{}\n");
    await writeFile(resolve(root, "outside.js"), "export {};\n");
    await symlink(resolve(root, "outside.js"), resolve(dist, "linked.js"));
    await expect(createRuntimeBuildIdentityFromFiles(
      root,
      dist,
      resolve(dist, "generated/runtime-build-identity.json"),
    )).rejects.toThrow("only regular files");
  });
});
