import { lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertExactPaths,
  canonicalRelativePath,
  collectRegularFiles,
  parsePackOutput,
  stageVerifiedTarball,
} from "../../scripts/release/release-support.mjs";
import {
  dependencyGraphDifferences,
  parseReleasePackageIdentity,
  type ReleaseDependencyNode,
} from "../../scripts/release/package-audit.mjs";

const directories: string[] = [];
const typeLinkedReleaseModules = [
  "child-process-lifecycle",
  "fake-rpc",
  "package-audit",
  "packaged-integration",
  "packaged-owner-worker-source",
  "release-support",
] as const;

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("release verification support", () => {
  it("links every release-tool export to its single declaration authority", async () => {
    for (const moduleName of typeLinkedReleaseModules) {
      const [implementation, declaration] = await Promise.all([
        readFile(resolve("scripts/release", `${moduleName}.mjs`), "utf8"),
        readFile(resolve("scripts/release", `${moduleName}.d.mts`), "utf8"),
      ]);
      const implementationExports = [...implementation.matchAll(
        /\bexport\s+(?:class|const|function|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gu,
      )].map((match) => match[1]).sort();
      const declarationExports = [...declaration.matchAll(
        /\bexport\s+(?:declare\s+)?(?:class|const|function)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gu,
      )].map((match) => match[1]).sort();
      expect(implementation).not.toMatch(/\bexport\s*(?:\{|default\b)/u);
      expect(implementationExports).toEqual(declarationExports);
      for (const exportName of implementationExports) {
        expect(implementation).toContain(
          `@type {typeof import("./${moduleName}.d.mts").${exportName}}`,
        );
      }
    }
  });

  it("derives the installed package path from one package identity", () => {
    expect(parseReleasePackageIdentity({
      name: "littlejohn-mcp",
      version: "0.1.0",
    })).toEqual({
      name: "littlejohn-mcp",
      version: "0.1.0",
      installRelativePath: "node_modules/littlejohn-mcp",
    });
    expect(parseReleasePackageIdentity({
      name: "@scope/littlejohn-mcp",
      version: "1.0.0-next.1",
    })).toEqual({
      name: "@scope/littlejohn-mcp",
      version: "1.0.0-next.1",
      installRelativePath: "node_modules/@scope/littlejohn-mcp",
    });
    for (const invalid of [
      null,
      {},
      { name: "../escape", version: "1.0.0" },
      { name: "@scope", version: "1.0.0" },
      { name: "scope/name", version: "1.0.0" },
      { name: "littlejohn-mcp", version: "" },
      { name: "littlejohn-mcp", version: "1.0.0\nforged" },
    ]) expect(() => parseReleasePackageIdentity(invalid)).toThrow();
    expect(() => parseReleasePackageIdentity(Object.defineProperty({}, "name", {
      get: () => { throw new Error("secret getter"); },
    }))).toThrow("identity");
  });

  it("accepts only canonical relative package paths", () => {
    expect(canonicalRelativePath("dist/runtime/index.js")).toBe("dist/runtime/index.js");
    for (const value of [
      "",
      "/absolute",
      "trailing/",
      "double//segment",
      "./relative",
      "../escape",
      "dist/../escape",
      "dist\\runtime.js",
      "dist/\0runtime.js",
    ]) expect(() => canonicalRelativePath(value)).toThrow();
  });

  it("strictly parses one npm package record and rejects duplicate or hostile paths", () => {
    const valid = Buffer.from(JSON.stringify([{
      filename: "littlejohn-mcp-0.1.0.tgz",
      files: [{ path: "package.json" }, { path: "dist/cli.js" }],
    }]));
    expect(parsePackOutput(valid)).toEqual({
      filename: "littlejohn-mcp-0.1.0.tgz",
      paths: ["dist/cli.js", "package.json"],
    });

    for (const invalid of [
      Buffer.from("not-json"),
      Buffer.from("[]"),
      Buffer.from(JSON.stringify([{}, {}])),
      Buffer.from(JSON.stringify([{ filename: "../escape.tgz", files: [] }])),
      Buffer.from(JSON.stringify([{
        filename: "package.tgz",
        files: [{ path: "dist/cli.js" }, { path: "dist/cli.js" }],
      }])),
      Buffer.from(JSON.stringify([{
        filename: "package.tgz",
        files: [{ path: "../escape" }],
      }])),
    ]) expect(() => parsePackOutput(invalid)).toThrow();
  });

  it("rejects symbolic links and special entries in extracted package trees", async () => {
    const root = resolve(tmpdir(), `littlejohn-release-tree-${process.pid}-${directories.length}`);
    directories.push(root);
    await mkdir(resolve(root, "dist"), { recursive: true });
    await writeFile(resolve(root, "dist/cli.js"), "export {};\n");
    expect(await collectRegularFiles(root)).toEqual(["dist/cli.js"]);
    await symlink(resolve(root, "dist/cli.js"), resolve(root, "dist/alias.js"));
    await expect(collectRegularFiles(root)).rejects.toThrow("regular directories and files");
  });

  it("compares complete file sets instead of subset membership", () => {
    expect(() => assertExactPaths(["a", "b"], ["b", "a"], "test")).not.toThrow();
    expect(() => assertExactPaths(["a"], ["a", "b"], "test")).toThrow();
    expect(() => assertExactPaths(["a", "b"], ["a"], "test")).toThrow();
  });

  it("stages the verified tarball as one private regular file", async () => {
    const root = resolve(tmpdir(), `littlejohn-release-output-${process.pid}-${directories.length}`);
    directories.push(root);
    const source = resolve(root, "source.tgz");
    const target = resolve(root, "nested", "verified.tgz");
    await mkdir(root, { recursive: true });
    await writeFile(source, "verified-package");
    await expect(stageVerifiedTarball(source, "relative.tgz")).rejects.toThrow("absolute");
    await expect(stageVerifiedTarball(source, source)).rejects.toThrow("differ");
    await expect(stageVerifiedTarball(source, target)).resolves.toBe(target);
    expect(await readFile(target, "utf8")).toBe("verified-package");
    const details = await lstat(target);
    expect(details.isFile()).toBe(true);
    expect(details.isSymbolicLink()).toBe(false);
    if (process.platform !== "win32") expect(details.mode & 0o777).toBe(0o600);
  });

  it("reports every runtime dependency version and structural difference", () => {
    const node = (
      name: string,
      version: string,
      dependencies: Readonly<Record<string, ReleaseDependencyNode>> = {},
      optionalPeerDependencies: readonly string[] = [],
    ): ReleaseDependencyNode => ({
      name,
      version,
      dependencies,
      optionalPeerDependencies,
    });
    const repository = node("product", "1.0.0", {
      alpha: node("alpha", "1.0.0"),
      beta: node("beta", "2.0.0"),
    });
    const consumer = node("product", "1.0.0", {
      alpha: node("alpha", "1.0.1"),
      gamma: node("gamma", "3.0.0"),
    });
    expect(dependencyGraphDifferences(repository, consumer)).toEqual([
      "product > alpha: repository=alpha@1.0.0, consumer=alpha@1.0.1",
      "product > beta: repository=2.0.0, consumer=absent",
      "product > gamma: repository=absent, consumer=3.0.0",
    ]);
    const nestedRepository = node("product", "1.0.0", {
      runtime: node("runtime", "1.0.0", {
        typescript: node("typescript", "6.0.3"),
      }),
    });
    const nestedConsumer = node("product", "1.0.0", {
      runtime: node("runtime", "1.0.0"),
    });
    expect(dependencyGraphDifferences(nestedRepository, nestedConsumer)).toEqual([
      "product > runtime > typescript: repository=6.0.3, consumer=absent",
    ]);
    const optionalPeerRepository = node("product", "1.0.0", {
      runtime: node("runtime", "1.0.0", {
        typescript: node("typescript", "6.0.3"),
      }, ["typescript"]),
    });
    expect(dependencyGraphDifferences(optionalPeerRepository, nestedConsumer)).toEqual([]);
  });
});
