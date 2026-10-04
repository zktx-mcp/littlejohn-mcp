import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  classifyMcpPublication,
  classifyNpmPublication,
  npmTarballIntegrity,
  parseReleasePublication,
} from "../../scripts/release/publication-contract.mjs";
import {
  publishRelease,
  type NpmRemoteState,
  type ReleasePublicationDependencies,
} from "../../scripts/release/publish-release.mjs";

const packageManifest = Object.freeze({
  name: "@zktx.io/littlejohn-mcp",
  version: "0.0.1",
  license: "MIT",
  mcpName: "io.github.zktx-mcp/littlejohn-mcp",
  description: "Local Robinhood Chain MCP and transaction review runtime.",
  repository: Object.freeze({
    type: "git",
    url: "git+https://github.com/zktx-mcp/littlejohn-mcp.git",
  }),
  bugs: Object.freeze({
    url: "https://github.com/zktx-mcp/littlejohn-mcp/issues",
  }),
  homepage: "https://zktx.io/",
  publishConfig: Object.freeze({
    access: "public",
    registry: "https://registry.npmjs.org",
  }),
});

const serverManifest = Object.freeze({
  $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  name: "io.github.zktx-mcp/littlejohn-mcp",
  description: "Local Robinhood Chain MCP and transaction review runtime.",
  websiteUrl: "https://zktx.io/",
  repository: Object.freeze({
    url: "https://github.com/zktx-mcp/littlejohn-mcp",
    source: "github",
  }),
  version: "0.0.1",
  packages: Object.freeze([Object.freeze({
    registryType: "npm",
    identifier: "@zktx.io/littlejohn-mcp",
    version: "0.0.1",
    transport: Object.freeze({ type: "stdio" }),
  })]),
});

const artifactBytes = Buffer.from("verified release artifact");
const integrity = "sha512-Aj2mDB/i7A3lI7sBlFapOFMt8aNVldEJ0RViIQf4qbQvrEJ1xKDqLDu/itnJ0mvshCVcj6sXFl7uOhOFvTSnGQ==";
const stablePublication = parseReleasePublication(
  packageManifest,
  serverManifest,
  "v0.0.1",
  false,
);
const exactNpm: NpmRemoteState = Object.freeze({
  versionDocument: Object.freeze({
    name: "@zktx.io/littlejohn-mcp",
    version: "0.0.1",
    dist: Object.freeze({ integrity }),
  }),
  distTags: Object.freeze({ latest: "0.0.1" }),
});
const missingNpm: NpmRemoteState = Object.freeze({
  versionDocument: undefined,
  distTags: undefined,
});
const exactMcp = Object.freeze({ server: serverManifest, _meta: Object.freeze({}) });

const input = (prerelease = false) => Object.freeze({
  packageManifest: prerelease
    ? Object.freeze({ ...packageManifest, version: "0.0.1-next.1" })
    : packageManifest,
  serverManifest: prerelease
    ? Object.freeze({
      ...serverManifest,
      version: "0.0.1-next.1",
      packages: Object.freeze([Object.freeze({
        ...serverManifest.packages[0],
        version: "0.0.1-next.1",
      })]),
    })
    : serverManifest,
  releaseTag: prerelease ? "v0.0.1-next.1" : "v0.0.1",
  prerelease,
  artifactPath: "/verified/littlejohn-mcp.tgz",
  artifactBytes,
});

const dependencies = ({
  npmStates,
  mcpStates,
  validateMcp = vi.fn(async () => undefined),
  publishNpm = vi.fn(async () => undefined),
  publishMcp = vi.fn(async () => undefined),
}: {
  npmStates: NpmRemoteState[];
  mcpStates: Array<unknown | undefined>;
  validateMcp?: ReturnType<typeof vi.fn<ReleasePublicationDependencies["validateMcp"]>>;
  publishNpm?: ReturnType<typeof vi.fn<ReleasePublicationDependencies["publishNpm"]>>;
  publishMcp?: ReturnType<typeof vi.fn<ReleasePublicationDependencies["publishMcp"]>>;
}) => {
  const remainingNpm = [...npmStates];
  const remainingMcp = [...mcpStates];
  const readNpm = vi.fn(async () => {
    const state = remainingNpm.shift();
    if (state === undefined) throw new Error("Unexpected npm read.");
    return state;
  });
  const readMcp = vi.fn(async () => {
    if (remainingMcp.length === 0) throw new Error("Unexpected MCP read.");
    return remainingMcp.shift();
  });
  const result: ReleasePublicationDependencies = {
    validateMcp,
    readNpm,
    publishNpm,
    readMcp,
    publishMcp,
    wait: vi.fn(async () => undefined),
  };
  return { result, validateMcp, readNpm, publishNpm, readMcp, publishMcp };
};

describe("release publication contract", () => {
  it("computes npm integrity from an independent fixed SHA-512 vector", () => {
    expect(npmTarballIntegrity(artifactBytes)).toBe(integrity);
    expect(() => npmTarballIntegrity(Buffer.alloc(0))).toThrow("invalid");
  });

  it("keeps repository manifests and the immutable workflow on one release identity", async () => {
    const [manifest, lock, registry, license, workflow] = await Promise.all([
      readFile("package.json", "utf8").then(JSON.parse),
      readFile("package-lock.json", "utf8").then(JSON.parse),
      readFile("server.json", "utf8").then(JSON.parse),
      readFile("LICENSE", "utf8"),
      readFile(".github/workflows/publish.yml", "utf8"),
    ]);
    const prerelease = /-/u.test(manifest.version);
    expect(() => parseReleasePublication(
      manifest,
      registry,
      `v${manifest.version}`,
      prerelease,
    )).not.toThrow();
    expect(lock.packages[""].license).toBe("MIT");
    expect(manifest.name).toBe("@zktx.io/littlejohn-mcp");
    expect(manifest.version).toBe("0.0.1");
    expect(lock.name).toBe(manifest.name);
    expect(lock.version).toBe(manifest.version);
    expect(lock.packages[""].name).toBe(manifest.name);
    expect(lock.packages[""].version).toBe(manifest.version);
    expect(license).toContain("Copyright (c) 2026 Stelis");
    expect(workflow).toMatch(/actions\/checkout@[0-9a-f]{40}/u);
    expect(workflow).toMatch(/actions\/setup-node@[0-9a-f]{40}/u);
    expect(workflow).not.toMatch(/uses: [^\n]+@v\d/u);
    expect(workflow).not.toContain("JS-DevTools/npm-publish");
    expect(workflow).not.toContain("releases/latest");
    expect(workflow).not.toContain("jq ");
    expect(workflow).toContain("LITTLEJOHN_RELEASE_OUTPUT");
    expect(workflow).toContain("npm run release:check");
    expect(workflow).toContain("node scripts/release/publish-release.mjs");
    expect(workflow).toContain("releases/download/v1.7.9/mcp-publisher_linux_amd64.tar.gz");
    expect(workflow).toContain("ab128162b0616090b47cf245afe0a23f3ef08936fdce19074f5ba0a4469281ac");
    expect(workflow.indexOf("npm run release:check")).toBeLessThan(
      workflow.indexOf("node scripts/release/publish-release.mjs"),
    );
  });

  it("derives one stable publication identity from package, server, and release metadata", () => {
    expect(stablePublication).toEqual({
      packageName: "@zktx.io/littlejohn-mcp",
      version: "0.0.1",
      serverName: "io.github.zktx-mcp/littlejohn-mcp",
      npmTag: "latest",
      registerMcp: true,
    });
    expect(parseReleasePublication(
      input(true).packageManifest,
      input(true).serverManifest,
      "0.0.1-next.1",
      true,
    )).toMatchObject({ npmTag: "next", registerMcp: false });
  });

  it("admits the product homepage independently of its source repository", () => {
    expect(parseReleasePublication(
      { ...packageManifest, homepage: "https://product.example/" },
      { ...serverManifest, websiteUrl: "https://product.example/" },
      "v0.0.1",
      false,
    )).toEqual(stablePublication);
    for (const homepage of [undefined, "", "not a URL", "http://product.example/",
      "https://user:secret@product.example/", "https://product.example"]) {
      expect(() => parseReleasePublication(
        { ...packageManifest, homepage },
        { ...serverManifest, websiteUrl: homepage },
        "v0.0.1",
        false,
      )).toThrow("identity is inconsistent");
    }
  });

  it("requires the MCP namespace to identify the package's GitHub repository", () => {
    for (const mcpName of [
      "io.github.other/littlejohn-mcp",
      "io.github.zktx-mcp/other-server",
    ]) {
      expect(() => parseReleasePublication(
        { ...packageManifest, mcpName },
        { ...serverManifest, name: mcpName },
        "v0.0.1",
        false,
      )).toThrow("identity is inconsistent");
    }
  });

  it("rejects invalid scoped npm names before publication", () => {
    for (const name of ["@zktx.io", "@zktx.io/", "zktx.io/littlejohn-mcp", "@zktx.io/../littlejohn-mcp"]) {
      expect(() => parseReleasePublication(
        { ...packageManifest, name },
        { ...serverManifest, packages: [{ ...serverManifest.packages[0], identifier: name }] },
        "v0.0.1",
        false,
      )).toThrow("identity is inconsistent");
    }
  });

  it("rejects license, tag, repository, version, and package projection drift", () => {
    for (const [manifest, registry, tag, prerelease] of [
      [{ ...packageManifest, license: "UNLICENSED" }, serverManifest, "v0.0.1", false],
      [{ ...packageManifest, publishConfig: { access: "public", registry: "https://example.com" } }, serverManifest, "v0.0.1", false],
      [packageManifest, serverManifest, "v0.2.0", false],
      [{ ...packageManifest, repository: { type: "git", url: "https://example.com/repo" } }, serverManifest, "v0.0.1", false],
      [packageManifest, { ...serverManifest, websiteUrl: "https://product.example/" }, "v0.0.1", false],
      [packageManifest, { ...serverManifest, repository: { ...serverManifest.repository, url: "https://zktx.io/" } }, "v0.0.1", false],
      [packageManifest, { ...serverManifest, version: "0.2.0" }, "v0.0.1", false],
      [packageManifest, { ...serverManifest, packages: [{ ...serverManifest.packages[0], identifier: "other" }] }, "v0.0.1", false],
      [packageManifest, serverManifest, "v0.0.1", true],
    ] as const) {
      expect(() => parseReleasePublication(manifest, registry, tag, prerelease)).toThrow(
        "identity is inconsistent",
      );
    }
  });

  it("distinguishes absent, propagating, exact, and conflicting npm state", () => {
    expect(classifyNpmPublication(
      undefined,
      undefined,
      stablePublication,
      integrity,
    )).toEqual({ status: "missing" });
    expect(classifyNpmPublication(
      exactNpm.versionDocument,
      exactNpm.distTags,
      stablePublication,
      integrity,
    )).toEqual({ status: "exact" });
    for (const state of [
      { ...exactNpm, distTags: { latest: "0.0.9" } },
      { versionDocument: undefined, distTags: { latest: "0.0.1" } },
    ]) expect(classifyNpmPublication(
      state.versionDocument,
      state.distTags,
      stablePublication,
      integrity,
    )).toEqual({ status: "pending" });
    for (const state of [
      { ...exactNpm, versionDocument: { name: "@zktx.io/littlejohn-mcp", version: "0.0.1", dist: { integrity: npmTarballIntegrity(Buffer.from("different")) } } },
      { ...exactNpm, versionDocument: null },
      { ...exactNpm, versionDocument: [] },
      { ...exactNpm, versionDocument: "malformed" },
      { ...exactNpm, distTags: null },
    ]) expect(classifyNpmPublication(
      state.versionDocument,
      state.distTags,
      stablePublication,
      integrity,
    )).toEqual({ status: "conflict" });
  });

  it("waits out a split npm observation without attempting a duplicate publish", async () => {
    const pendingNpm: NpmRemoteState = {
      versionDocument: exactNpm.versionDocument,
      distTags: { latest: "0.0.9" },
    };
    const calls = dependencies({
      npmStates: [pendingNpm, exactNpm],
      mcpStates: [exactMcp],
    });
    await expect(publishRelease(input(), calls.result)).resolves.toEqual({
      npm: "already_published",
      mcp: "already_published",
    });
    expect(calls.publishNpm).not.toHaveBeenCalled();
  });

  it("distinguishes absent, exact, and conflicting MCP Registry state structurally", () => {
    expect(classifyMcpPublication(undefined, serverManifest)).toEqual({ status: "missing" });
    expect(classifyMcpPublication(exactMcp, serverManifest)).toEqual({ status: "exact" });
    expect(classifyMcpPublication(
      { server: { ...serverManifest, version: "0.2.0" } },
      serverManifest,
    )).toEqual({ status: "conflict" });
  });

  it("publishes each missing stable commit once and verifies both committed states", async () => {
    const calls = dependencies({
      npmStates: [missingNpm, exactNpm],
      mcpStates: [undefined, exactMcp],
    });
    await expect(publishRelease(input(), calls.result)).resolves.toEqual({
      npm: "published",
      mcp: "published",
    });
    expect(calls.publishNpm).toHaveBeenCalledOnce();
    expect(calls.publishMcp).toHaveBeenCalledOnce();
    expect(calls.validateMcp).toHaveBeenCalledOnce();
    expect(calls.validateMcp.mock.invocationCallOrder[0]).toBeLessThan(
      calls.publishNpm.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("resumes an exact committed release without repeating either external mutation", async () => {
    const calls = dependencies({ npmStates: [exactNpm], mcpStates: [exactMcp] });
    await expect(publishRelease(input(), calls.result)).resolves.toEqual({
      npm: "already_published",
      mcp: "already_published",
    });
    expect(calls.publishNpm).not.toHaveBeenCalled();
    expect(calls.publishMcp).not.toHaveBeenCalled();
  });

  it("recovers a lost npm publish response only from exact remote state", async () => {
    const publishNpm = vi.fn(async () => { throw new Error("response lost"); });
    const calls = dependencies({
      npmStates: [missingNpm, exactNpm],
      mcpStates: [exactMcp],
      publishNpm,
    });
    await expect(publishRelease(input(), calls.result)).resolves.toEqual({
      npm: "published",
      mcp: "already_published",
    });
    expect(publishNpm).toHaveBeenCalledOnce();

    const uncommitted = dependencies({
      npmStates: [missingNpm, ...Array.from({ length: 12 }, () => missingNpm)],
      mcpStates: [],
      publishNpm: vi.fn(async () => { throw new Error("response lost"); }),
    });
    await expect(publishRelease(input(), uncommitted.result)).rejects.toThrow(
      "exact committed state was not recovered",
    );
    expect(uncommitted.publishNpm).toHaveBeenCalledOnce();
    expect(uncommitted.readMcp).not.toHaveBeenCalled();
  });

  it("recovers a lost MCP publish response only from the exact registry entry", async () => {
    const publishMcp = vi.fn(async () => { throw new Error("response lost"); });
    const calls = dependencies({
      npmStates: [exactNpm],
      mcpStates: [undefined, exactMcp],
      publishMcp,
    });
    await expect(publishRelease(input(), calls.result)).resolves.toEqual({
      npm: "already_published",
      mcp: "published",
    });
    expect(publishMcp).toHaveBeenCalledOnce();

    const uncommitted = dependencies({
      npmStates: [exactNpm],
      mcpStates: [undefined, ...Array.from({ length: 12 }, () => undefined)],
      publishMcp: vi.fn(async () => { throw new Error("response lost"); }),
    });
    await expect(publishRelease(input(), uncommitted.result)).rejects.toThrow(
      "exact committed state was not recovered",
    );
    expect(uncommitted.publishMcp).toHaveBeenCalledOnce();
  });

  it("never reads or publishes MCP state for a prerelease", async () => {
    const prereleasePublication = parseReleasePublication(
      input(true).packageManifest,
      input(true).serverManifest,
      input(true).releaseTag,
      true,
    );
    const prereleaseExact: NpmRemoteState = {
      versionDocument: {
        name: prereleasePublication.packageName,
        version: prereleasePublication.version,
        dist: { integrity },
      },
      distTags: { next: prereleasePublication.version },
    };
    const calls = dependencies({ npmStates: [prereleaseExact], mcpStates: [] });
    await expect(publishRelease(input(true), calls.result)).resolves.toEqual({
      npm: "already_published",
      mcp: "not_applicable",
    });
    expect(calls.readMcp).not.toHaveBeenCalled();
    expect(calls.publishMcp).not.toHaveBeenCalled();
    expect(calls.validateMcp).not.toHaveBeenCalled();
  });

  it("fails before mutation when official validation fails or npm conflicts", async () => {
    const invalidMcp = dependencies({
      npmStates: [],
      mcpStates: [],
      validateMcp: vi.fn(async () => { throw new Error("invalid server manifest"); }),
    });
    await expect(publishRelease(input(), invalidMcp.result)).rejects.toThrow(
      "invalid server manifest",
    );
    expect(invalidMcp.readNpm).not.toHaveBeenCalled();
    expect(invalidMcp.publishNpm).not.toHaveBeenCalled();

    const calls = dependencies({
      npmStates: [{
        versionDocument: {
          name: "@zktx.io/littlejohn-mcp",
          version: "0.0.1",
          dist: { integrity: npmTarballIntegrity(Buffer.from("other")) },
        },
        distTags: { latest: "0.0.1" },
      }],
      mcpStates: [],
    });
    await expect(publishRelease(input(), calls.result)).rejects.toThrow("conflicting");
    expect(calls.publishNpm).not.toHaveBeenCalled();
    expect(calls.readMcp).not.toHaveBeenCalled();
  });
});
