import { request } from "node:http";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { inspectModuleImports } from "../runtime/import-audit.js";
import { startFakeRpc } from "../../scripts/release/fake-rpc.mjs";
import { parseReleasePackageIdentity } from "../../scripts/release/package-audit.mjs";
import { assertPackagedMcpServerIdentity } from "../../scripts/release/packaged-integration.mjs";
import { renderPackagedOwnerWorkerSource } from "../../scripts/release/packaged-owner-worker-source.mjs";

const rpcRequest = (
  url: string,
  method: string,
  params: readonly unknown[],
): Promise<unknown> => new Promise((resolveRequest, rejectRequest) => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: "1", method, params });
  const target = new URL(url);
  const outgoing = request({
    host: target.hostname,
    port: Number(target.port),
    path: target.pathname,
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    },
  }, (response) => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    response.once("end", () => {
      try { resolveRequest(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch (error) { rejectRequest(error); }
    });
  });
  outgoing.once("error", rejectRequest);
  outgoing.end(body);
});

describe("release fake boundaries", () => {
  it("binds the MCP handshake to the package manifest identity", () => {
    const identity = parseReleasePackageIdentity(
      JSON.parse(readFileSync("package.json", "utf8")),
    );
    expect(() => assertPackagedMcpServerIdentity({
      serverInfo: { name: identity.name, version: identity.version },
    }, identity)).not.toThrow();
    expect(() => assertPackagedMcpServerIdentity({
      serverInfo: { name: identity.name, version: "0.0.0-stale" },
    }, identity)).toThrow("identity");
    expect(() => assertPackagedMcpServerIdentity({
      serverInfo: { name: "foreign-package", version: identity.version },
    }, identity)).toThrow("identity");
    expect(() => assertPackagedMcpServerIdentity(
      Object.defineProperty({}, "serverInfo", {
        get: () => { throw new Error("secret getter"); },
      }),
      identity,
    )).toThrow("identity");
  });

  it("serves only the exact automated read RPC methods and records prohibited calls", async () => {
    const rpc = await startFakeRpc();
    try {
      await expect(rpcRequest(rpc.url, "eth_chainId", [])).resolves.toMatchObject({
        result: "0x1237",
      });
      await expect(rpcRequest(rpc.url, "eth_sendTransaction", [{}])).resolves.toMatchObject({
        error: { code: -32601 },
      });
      expect(() => rpc.assertNoUnexpectedMethods()).toThrow("eth_sendTransaction");
    } finally {
      await rpc.close();
    }
  });

  it("generates a static installed-package worker without loader or remote imports", () => {
    const identity = parseReleasePackageIdentity(
      JSON.parse(readFileSync("package.json", "utf8")),
    );
    const source = renderPackagedOwnerWorkerSource(identity.installRelativePath);
    const imports = inspectModuleImports(source, "release-owner-worker.mjs");
    expect(imports).toHaveLength(7);
    expect(imports.every((entry) =>
      entry.kind === "module" &&
      typeof entry.specifier === "string" &&
      (entry.specifier.startsWith("node:") ||
        entry.specifier.startsWith(`./${identity.installRelativePath}/dist/`))
    )).toBe(true);
    expect(source).not.toMatch(/\b(?:eval|Function|createRequire)\s*\(/u);
    expect(source).not.toContain("http://");
    expect(source).not.toContain("https://");
    expect(source).not.toContain("wc:");
    expect(source).not.toContain("pairingTopic");
  });
});
