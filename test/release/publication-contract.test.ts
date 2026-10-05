import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  classifyMcpPublication,
  classifyNpmPublication,
  npmTarballIntegrity,
  parseReleasePublication,
} from "../../scripts/release/publication-contract.mjs";
import {
  publishNpmRelease,
  publishMcpRelease,
  readNpmPublication,
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

const publishRelease = async (value: ReturnType<typeof input>, ports: ReleasePublicationDependencies) => {
  const npm = await publishNpmRelease(value, ports);
  const mcp = await publishMcpRelease({ ...value, artifactIntegrity: npm.integrity }, ports);
  return { npm: npm.npm, mcp: mcp.mcp };
};

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
  let clock = 0;
  const remainingNpm = [...npmStates];
  const remainingMcp = [...mcpStates];
  const readNpm = vi.fn(async () => {
    const state = remainingNpm.shift() ?? npmStates.at(-1);
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
    now: () => clock,
    wait: vi.fn(async (milliseconds) => { clock += milliseconds; }),
  };
  return { result, validateMcp, readNpm, publishNpm, readMcp, publishMcp };
};

const versionUrl = "https://registry.npmjs.org/%40zktx.io%2Flittlejohn-mcp/0.0.1";
const tagsUrl = "https://registry.npmjs.org/-/package/%40zktx.io%2Flittlejohn-mcp/dist-tags";
const jsonResponse = (value: unknown, status = 200, headers?: Record<string, string>): Response =>
  new Response(JSON.stringify(value), { status, ...(headers === undefined ? {} : { headers }) });

describe("public npm lookup", () => {
  it("publishes a missing scoped package without reading its unauthorized tag endpoint", async () => {
    let published = false;
    const fetchRequest = vi.fn<typeof fetch>(async (url) => {
      if (url === versionUrl) return published
        ? jsonResponse(exactNpm.versionDocument)
        : jsonResponse({ error: "Not found" }, 404);
      if (url === tagsUrl) return published
        ? jsonResponse(exactNpm.distTags)
        : jsonResponse({ error: "Unauthorized" }, 401);
      throw new Error("Unexpected registry URL.");
    });
    const publishNpm = vi.fn(async () => { published = true; });
    const calls = dependencies({ npmStates: [], mcpStates: [], publishNpm });
    const ports = {
      ...calls.result,
      readNpm: (publication: typeof stablePublication, timeoutMs?: number) =>
        readNpmPublication(publication, { fetch: fetchRequest, ...(timeoutMs === undefined ? {} : { timeoutMs }) }),
    };
    await expect(publishNpmRelease(input(), ports)).resolves.toEqual({ npm: "published", integrity });
    expect(fetchRequest.mock.calls.map(([url]) => url)).toEqual([versionUrl, versionUrl, tagsUrl]);
    expect(publishNpm).toHaveBeenCalledExactlyOnceWith(stablePublication, input().artifactPath);
    for (const [, init] of fetchRequest.mock.calls) {
      expect(init?.headers).toEqual({ accept: "application/json", "cache-control": "no-cache" });
      expect(init?.redirect).toBe("error");
      expect(init?.signal?.aborted).toBe(true);
    }
  });

  it("waits for post-upload visibility through the real lookup without uploading again", async () => {
    let versionReads = 0;
    const fetchRequest = vi.fn<typeof fetch>(async (url) => {
      if (url === versionUrl) {
        versionReads += 1;
        return versionReads < 3
          ? jsonResponse({ error: "Not found" }, 404)
          : jsonResponse(exactNpm.versionDocument);
      }
      if (url === tagsUrl) return versionReads < 3
        ? jsonResponse({ error: "Unauthorized" }, 401)
        : jsonResponse(exactNpm.distTags);
      throw new Error("Unexpected registry URL.");
    });
    const calls = dependencies({ npmStates: [], mcpStates: [] });
    await expect(publishNpmRelease(input(), {
      ...calls.result,
      readNpm: (publication, timeoutMs) => readNpmPublication(publication, {
        fetch: fetchRequest, ...(timeoutMs === undefined ? {} : { timeoutMs }),
      }),
    })).resolves.toEqual({ npm: "published", integrity });
    expect(calls.publishNpm).toHaveBeenCalledOnce();
    expect(fetchRequest.mock.calls.map(([url]) => url)).toEqual([versionUrl, versionUrl, versionUrl, tagsUrl]);
    expect(calls.result.wait).toHaveBeenCalledExactlyOnceWith(30_000);
  });

  it("stops both publication stages when the version lookup requires authorization", async () => {
    const fetchRequest = vi.fn<typeof fetch>(async (url) => {
      if (url !== versionUrl) throw new Error("Unexpected registry URL.");
      return jsonResponse({ error: "Unauthorized" }, 401);
    });
    const calls = dependencies({ npmStates: [], mcpStates: [] });
    await expect(publishRelease(input(), {
      ...calls.result,
      readNpm: (publication) => readNpmPublication(publication, { fetch: fetchRequest }),
    })).rejects.toThrow("npm version read failed with HTTP 401");
    expect(fetchRequest).toHaveBeenCalledOnce();
    expect(calls.publishNpm).not.toHaveBeenCalled();
    expect(calls.readMcp).not.toHaveBeenCalled();
    expect(calls.publishMcp).not.toHaveBeenCalled();
  });

  it("retains exact and conflicting integrity decisions after actual JSON reads", async () => {
    for (const conflicting of [false, true]) {
      const document = conflicting
        ? { ...exactNpm.versionDocument as object, dist: { integrity: integrity.replace("Aj2", "Bj2") } }
        : exactNpm.versionDocument;
      const fetchRequest = vi.fn<typeof fetch>(async (url) => {
        if (url === versionUrl) return jsonResponse(document);
        if (url === tagsUrl) return jsonResponse(exactNpm.distTags);
        throw new Error("Unexpected registry URL.");
      });
      const calls = dependencies({ npmStates: [], mcpStates: [] });
      const result = publishNpmRelease(input(), {
        ...calls.result,
        readNpm: (publication) => readNpmPublication(publication, { fetch: fetchRequest }),
      });
      if (conflicting) await expect(result).rejects.toThrow("conflicting release version");
      else await expect(result).resolves.toEqual({ npm: "already_published", integrity });
      expect(calls.publishNpm).not.toHaveBeenCalled();
    }
  });

  it("keeps rate limits retryable but rejects malformed JSON", async () => {
    let response = jsonResponse({ error: "Rate limited" }, 429, { "retry-after": "60" });
    const fetchRequest = vi.fn<typeof fetch>(async (url) => {
      if (url !== versionUrl) throw new Error("Unexpected registry URL.");
      return response;
    });
    await expect(readNpmPublication(stablePublication, { fetch: fetchRequest }))
      .rejects.toMatchObject({ retryAfterMs: 60_000 });
    expect(response.bodyUsed).toBe(true);
    response = new Response("not JSON", { status: 200 });
    const error = await readNpmPublication(stablePublication, { fetch: fetchRequest }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(TypeError);
    expect(error).not.toHaveProperty("retryAfterMs");
  });

  it("uses one deadline for two individually timely requests and clears their timers", async () => {
    vi.useFakeTimers();
    try {
      const fetchRequest = vi.fn<typeof fetch>((url, init) => {
        if (url !== versionUrl && url !== tagsUrl) throw new Error("Unexpected registry URL.");
        const signal = init?.signal;
        if (!signal) throw new Error("Missing request signal.");
        return new Promise<Response>((resolveResponse, rejectResponse) => {
          const abort = () => { clearTimeout(timer); rejectResponse(signal.reason); };
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", abort);
            resolveResponse(jsonResponse(url === versionUrl ? exactNpm.versionDocument : exactNpm.distTags));
          }, 600);
          signal.addEventListener("abort", abort, { once: true });
        });
      });
      const outcome = readNpmPublication(stablePublication, { fetch: fetchRequest, timeoutMs: 1_000 })
        .then((value) => ({ value }), (error: unknown) => ({ error }));
      await vi.advanceTimersByTimeAsync(1_200);
      expect(await outcome).toMatchObject({ error: { retryAfterMs: 0 } });
      expect(fetchRequest.mock.calls.map(([url]) => url)).toEqual([versionUrl, tagsUrl]);
      expect(fetchRequest.mock.calls[0]?.[1]?.signal).toBe(fetchRequest.mock.calls[1]?.[1]?.signal);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await vi.runAllTimersAsync();
      vi.useRealTimers();
    }
  });

  it("keeps the deadline active while a valid version body is still arriving", async () => {
    vi.useFakeTimers();
    try {
      const fetchRequest = vi.fn<typeof fetch>(async (url, init) => {
        if (url === tagsUrl) return jsonResponse(exactNpm.distTags);
        if (url !== versionUrl || !init?.signal) throw new Error("Invalid request prerequisite.");
        const signal = init.signal;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            const abort = () => { clearTimeout(timer); controller.error(signal.reason); };
            const timer = setTimeout(() => {
              signal.removeEventListener("abort", abort);
              controller.enqueue(new TextEncoder().encode(JSON.stringify(exactNpm.versionDocument)));
              controller.close();
            }, 1_200);
            signal.addEventListener("abort", abort, { once: true });
          },
        });
        return new Response(body, { status: 200 });
      });
      const outcome = readNpmPublication(stablePublication, { fetch: fetchRequest, timeoutMs: 1_000 })
        .then((value) => ({ value }), (error: unknown) => ({ error }));
      await vi.advanceTimersByTimeAsync(1_200);
      expect(await outcome).toMatchObject({ error: { retryAfterMs: 0 } });
      expect(fetchRequest.mock.calls.map(([url]) => url)).toEqual([versionUrl]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await vi.runAllTimersAsync();
      vi.useRealTimers();
    }
  });

  it("rejects an otherwise valid version document beyond the retained byte limit", async () => {
    const oversized = { ...exactNpm.versionDocument as object, padding: "x".repeat(4 * 1024 * 1024) };
    const fetchRequest = vi.fn<typeof fetch>(async (url) => {
      if (url === versionUrl) return jsonResponse(oversized);
      if (url === tagsUrl) return jsonResponse(exactNpm.distTags);
      throw new Error("Unexpected registry URL.");
    });
    await expect(readNpmPublication(stablePublication, { fetch: fetchRequest }))
      .rejects.toThrow("response exceeds its byte limit");
    expect(fetchRequest.mock.calls.map(([url]) => url)).toEqual([versionUrl]);
  });
});

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
    expect(manifest.scripts["release:publish:npm"]).toBe("node scripts/release/publish-release.mjs npm");
    expect(manifest.scripts["release:publish:mcp"]).toBe("node scripts/release/publish-release.mjs mcp");
    expect(manifest.scripts).not.toHaveProperty("release:publish");
    expect(workflow).toContain("needs: publish-npm");
    expect(workflow).toContain("npm run release:publish:mcp");
    const setup = await readFile(".github/actions/setup-mcp-publisher/action.yml", "utf8");
    expect(setup).toContain("releases/download/v1.7.9/mcp-publisher_linux_amd64.tar.gz");
    expect(setup).toContain("ab128162b0616090b47cf245afe0a23f3ef08936fdce19074f5ba0a4469281ac");
    expect(workflow.indexOf("npm run release:check")).toBeLessThan(
      workflow.indexOf("npm run release:publish:npm"),
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
    expect(calls.validateMcp).toHaveBeenCalledTimes(2);
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

  it("registers independently after npm is visible without republishing npm", async () => {
    const calls = dependencies({ npmStates: [missingNpm, exactNpm], mcpStates: [undefined, exactMcp] });
    await expect(publishMcpRelease({ ...input(), artifactIntegrity: integrity }, calls.result))
      .resolves.toEqual({ mcp: "published" });
    expect(calls.publishNpm).not.toHaveBeenCalled();
    expect(calls.result.wait).toHaveBeenCalledWith(30_000);
  });

  it("honors temporary npm retry delays without bypassing public-state verification", async () => {
    const calls = dependencies({ npmStates: [exactNpm], mcpStates: [exactMcp] });
    const unavailable = Object.assign(new Error("rate limited"), { retryAfterMs: 120_000 });
    calls.readNpm.mockRejectedValueOnce(unavailable);
    await expect(publishMcpRelease({ ...input(), artifactIntegrity: integrity }, calls.result))
      .resolves.toEqual({ mcp: "already_published" });
    expect(calls.result.wait).toHaveBeenCalledWith(120_000);
    expect(calls.publishMcp).not.toHaveBeenCalled();
  });

  it("refuses a valid but different npm integrity handoff before registry mutation", async () => {
    const calls = dependencies({ npmStates: [exactNpm], mcpStates: [] });
    await expect(publishMcpRelease({ ...input(), artifactIntegrity: integrity.replace("Aj2", "Bj2") }, calls.result))
      .rejects.toThrow("conflicting release version");
    expect(calls.publishMcp).not.toHaveBeenCalled();
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
