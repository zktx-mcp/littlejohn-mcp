import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { BrowserAssetBundle } from "../../src/interfaces/browser-assets.js";
import {
  browserCsrfMetaName,
  browserInterfacePaths,
} from "../../src/interfaces/browser-contract.js";
import {
  browserOperationCookieName,
  createBrowserRequestCredentialAuthority,
} from "../../src/interfaces/browser-credentials.js";
import {
  extendBrowserInterfaceRoutes,
} from "../../src/interfaces/browser-routes.js";
import {
  createControlCredentialVerifier,
  loadOrCreateControlCredential,
} from "../../src/runtime/control-credential.js";
import {
  createRuntimeRouteRegistry,
  type NormalizedRouteResult,
  type RouteMethod,
  type RuntimeRouteRegistry,
} from "../../src/runtime/http-routing.js";
import { fixedHostHeader, fixedOrigin, jsonContentType } from "../../src/runtime/http-boundary.js";
import { runtimePaths } from "../../src/runtime/paths.js";
import {
  parseWalletManagementOperation,
  parseWalletQrMatrix,
  type WalletInterfaceOperations,
  type WalletManagementOperation,
  type WalletOperationPresentation,
} from "../../src/wallet/contracts.js";

const directories: string[] = [];
const operationId = Buffer.alloc(32, 13).toString("base64url");
const foreignOperationId = Buffer.alloc(32, 14).toString("base64url");
const expiresAt = "2026-07-15T04:00:00.000Z";
const now = Date.parse("2026-07-15T03:00:00.000Z");

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

const operation = (
  state: WalletManagementOperation["state"],
  id = operationId,
): WalletManagementOperation =>
  parseWalletManagementOperation({
    operationId: id,
    kind: "connect",
    state,
    connectionRevision: "7",
    expiresAt,
    result: null,
    failure: null,
  });

const qr = parseWalletQrMatrix({
  size: 21,
  rows: Array.from({ length: 21 }, (_unused, row) =>
    Array.from({ length: 21 }, (_other, column) => (row + column) % 2 === 0 ? "1" : "0").join("")),
});

const assets: BrowserAssetBundle = Object.freeze({
  renderShell: (token: string) => `<meta name="${browserCsrfMetaName}" content="${token}">`,
  get: (path: string) => path === "/assets/index-Abcdef12.js"
    ? Object.freeze({ body: "export{};", contentType: "text/javascript; charset=utf-8" as const })
    : undefined,
  paths: () => Object.freeze(["/assets/index-Abcdef12.js"]),
});

interface WalletCalls {
  readonly reads: string[];
  readonly confirmations: unknown[];
  readonly cancellations: string[];
}

const walletOperations = (
  current: () => WalletOperationPresentation,
): { readonly port: WalletInterfaceOperations; readonly calls: WalletCalls } => {
  const calls: WalletCalls = { reads: [], confirmations: [], cancellations: [] };
  return Object.freeze({
    calls,
    port: Object.freeze({
      presentation: Object.freeze({
        async get(id: string) {
          calls.reads.push(id);
          return current();
        },
      }),
      operation: Object.freeze({
        async start() { throw new Error("The browser cannot start an operation."); },
        async get() { throw new Error("The browser reads through the presentation port."); },
        async cancel(id: string) {
          calls.cancellations.push(id);
          return operation("cancelled");
        },
      }),
      confirmation: Object.freeze({
        interactionInterface: "web" as const,
        async confirm(id: string, input: unknown) {
          calls.confirmations.push({ id, input });
          return operation("awaiting_wallet_approval");
        },
      }),
    }),
  });
};

const baseRoutes = async (): Promise<RuntimeRouteRegistry> => {
  const directory = await mkdtemp(resolve(tmpdir(), "littlejohn-browser-routes-"));
  directories.push(directory);
  const paths = runtimePaths(directory);
  const credential = await loadOrCreateControlCredential(directory, paths.controlCredential);
  return createRuntimeRouteRegistry({ controlVerifier: createControlCredentialVerifier(credential) });
};

const invoke = async (
  registry: RuntimeRouteRegistry,
  method: RouteMethod,
  path: string,
  body: unknown = {},
): Promise<NormalizedRouteResult> => {
  const match = registry.match(method, path);
  expect(match.status).toBe("matched");
  if (match.status !== "matched") throw new Error("Expected a browser route match.");
  return registry.normalizeResult(match.route, await match.route.handler({
    params: match.params,
    body,
    signal: new AbortController().signal,
  }));
};

const csrfFromShell = (shell: string): string => {
  const token = /content="([A-Za-z0-9_-]{43})"/.exec(shell)?.[1];
  if (token === undefined) throw new Error("Expected a CSRF token in the shell.");
  return token;
};

describe("wallet operation browser routes", () => {
  it("registers the exact bootstrap, read, control, and immutable asset resources", async () => {
    const credentials = createBrowserRequestCredentialAuthority({
      now: () => now,
      randomBytes: (size) => Buffer.alloc(size, 15),
    });
    const wallet = walletOperations(() => ({
      operation: operation("awaiting_confirmation"),
      access: "interactive",
    }));
    const registry = extendBrowserInterfaceRoutes({
      routes: await baseRoutes(), credentials, assets, walletOperations: wallet.port,
    });
    const expected = [
      ["GET", `/wallet/operations/${operationId}`, "browser_bootstrap", "browser_content", "none"],
      ["GET", `/api/v1/wallet/operations/${operationId}`, "browser_read", "canonical_json", "none"],
      ["GET", `/api/v1/wallet/operations/${operationId}/qr`, "browser_read", "canonical_json", "none"],
      ["POST", `/api/v1/wallet/operations/${operationId}/confirmation`, "browser_control", "canonical_json", "declared_control"],
      ["DELETE", `/api/v1/wallet/operations/${operationId}`, "browser_control", "canonical_json", "declared_control"],
      ["GET", "/assets/index-Abcdef12.js", "public_read", "browser_content", "none"],
    ] as const;
    for (const [method, path, requestClass, response, mutation] of expected) {
      const match = registry.match(method, path);
      expect(match.status).toBe("matched");
      if (match.status === "matched") {
        expect(match.route).toMatchObject({ method, requestClass, response, mutation, successStatus: 200 });
      }
    }
    expect(registry.match("POST", `/wallet/operations/${operationId}`).status).toBe("method_not_allowed");
    expect(registry.match("GET", "/wallet/operations").status).toBe("not_found");
    credentials.close();
  });

  it("binds one page credential to the path operation and enforces Host, Origin, cookie, and CSRF", async () => {
    let entropy = 20;
    const credentials = createBrowserRequestCredentialAuthority({
      now: () => now,
      randomBytes: (size) => Buffer.alloc(size, ++entropy),
    });
    const wallet = walletOperations(() => ({
      operation: operation("awaiting_confirmation"),
      access: "interactive",
    }));
    const registry = extendBrowserInterfaceRoutes({
      routes: await baseRoutes(), credentials, assets, walletOperations: wallet.port,
    });
    const page = await invoke(registry, "GET", `/wallet/operations/${operationId}`);
    expect(page.ok).toBe(true);
    if (!page.ok || page.response !== "browser_content") throw new Error("Expected browser content.");
    const cookie = page.setCookie?.split(";", 1)[0];
    if (cookie === undefined) throw new Error("Expected a browser operation cookie.");
    expect(cookie.startsWith(`${browserOperationCookieName}=`)).toBe(true);
    const csrfToken = csrfFromShell(page.body);

    const readMatch = registry.match("GET", `/api/v1/wallet/operations/${operationId}`);
    if (readMatch.status !== "matched") throw new Error("Expected operation read route.");
    const readInput = {
      host: [fixedHostHeader], origin: [], authorization: [], cookie: [cookie], csrfToken: [],
      contentType: [], query: "", bodyLength: 0,
    } as const;
    expect(registry.validateSecurity(readMatch, readInput)).toEqual({ ok: true });
    expect(registry.validateSecurity(readMatch, { ...readInput, host: ["localhost:46630"] }))
      .toEqual({ ok: false, code: "invalid_host" });
    expect(registry.validateSecurity(readMatch, { ...readInput, cookie: [] }))
      .toEqual({ ok: false, code: "unauthorized" });

    const foreignMatch = registry.match("GET", `/api/v1/wallet/operations/${foreignOperationId}`);
    if (foreignMatch.status !== "matched") throw new Error("Expected foreign operation route shape.");
    expect(registry.validateSecurity(foreignMatch, readInput))
      .toEqual({ ok: false, code: "unauthorized" });

    const controlMatch = registry.match("POST", `/api/v1/wallet/operations/${operationId}/confirmation`);
    if (controlMatch.status !== "matched") throw new Error("Expected confirmation route.");
    const controlInput = {
      host: [fixedHostHeader], origin: [fixedOrigin], authorization: [], cookie: [cookie],
      csrfToken: [csrfToken], contentType: [jsonContentType], query: "", bodyLength: 26,
    } as const;
    expect(registry.validateSecurity(controlMatch, controlInput)).toEqual({ ok: true });
    expect(registry.validateSecurity(controlMatch, { ...controlInput, origin: [] }))
      .toEqual({ ok: false, code: "invalid_origin" });
    expect(registry.validateSecurity(controlMatch, { ...controlInput, csrfToken: [] }))
      .toEqual({ ok: false, code: "unauthorized" });
    credentials.close();
  });

  it("preserves WU3 read-only access in the issued browser credential", async () => {
    let entropy = 24;
    const credentials = createBrowserRequestCredentialAuthority({
      now: () => now,
      randomBytes: (size) => Buffer.alloc(size, entropy++),
    });
    const wallet = walletOperations(() => ({
      operation: operation("awaiting_confirmation"),
      access: "read_only",
    }));
    const registry = extendBrowserInterfaceRoutes({
      routes: await baseRoutes(), credentials, assets, walletOperations: wallet.port,
    });
    const page = await invoke(registry, "GET", `/wallet/operations/${operationId}`);
    if (!page.ok || page.response !== "browser_content" || page.setCookie === undefined) {
      throw new Error("Expected a read-only browser page credential.");
    }
    const cookie = page.setCookie.split(";", 1)[0] as string;
    const csrfToken = csrfFromShell(page.body);
    const readMatch = registry.match("GET", `/api/v1/wallet/operations/${operationId}`);
    const controlMatch = registry.match("POST", `/api/v1/wallet/operations/${operationId}/confirmation`);
    if (readMatch.status !== "matched" || controlMatch.status !== "matched") {
      throw new Error("Expected the browser operation resources.");
    }
    const common = {
      host: [fixedHostHeader], authorization: [], cookie: [cookie], query: "", bodyLength: 0,
    } as const;
    expect(registry.validateSecurity(readMatch, {
      ...common, origin: [], csrfToken: [], contentType: [],
    })).toEqual({ ok: true });
    expect(registry.validateSecurity(controlMatch, {
      ...common,
      origin: [fixedOrigin],
      csrfToken: [csrfToken],
      contentType: [jsonContentType],
      bodyLength: 26,
    })).toEqual({ ok: false, code: "unauthorized" });
    credentials.close();
  });

  it("projects the canonical operation and QR and delegates confirmation and cancellation once", async () => {
    let current: WalletOperationPresentation = {
      operation: operation("awaiting_wallet_approval"),
      access: "interactive",
      qr,
    };
    const credentials = createBrowserRequestCredentialAuthority({
      now: () => now,
      randomBytes: (size) => Buffer.alloc(size, 25),
    });
    const wallet = walletOperations(() => current);
    const registry = extendBrowserInterfaceRoutes({
      routes: await baseRoutes(), credentials, assets, walletOperations: wallet.port,
    });

    const read = await invoke(registry, "GET", `/api/v1/wallet/operations/${operationId}`);
    expect(read).toEqual({
      ok: true,
      response: "canonical_json",
      body: {
        operation: operation("awaiting_wallet_approval"),
        access: "interactive",
      },
    });
    const qrRead = await invoke(registry, "GET", `/api/v1/wallet/operations/${operationId}/qr`);
    expect(qrRead).toEqual({ ok: true, response: "canonical_json", body: { qr } });

    current = { operation: operation("awaiting_confirmation"), access: "interactive" };
    const missingQr = await invoke(registry, "GET", `/api/v1/wallet/operations/${operationId}/qr`);
    expect(missingQr.ok).toBe(false);
    if (!missingQr.ok) expect(missingQr.problem.code).toBe("state_conflict");

    const confirmed = await invoke(
      registry,
      "POST",
      `/api/v1/wallet/operations/${operationId}/confirmation`,
      { connectionRevision: "7" },
    );
    expect(confirmed.ok).toBe(true);
    expect(wallet.calls.confirmations).toEqual([{ id: operationId, input: { connectionRevision: "7" } }]);

    const cancelled = await invoke(registry, "DELETE", `/api/v1/wallet/operations/${operationId}`);
    expect(cancelled.ok).toBe(true);
    expect(wallet.calls.cancellations).toEqual([operationId]);
    expect(wallet.calls.reads).toEqual([operationId, operationId, operationId]);
    credentials.close();
  });

  it("rejects an invalid operation path before any wallet port is called", async () => {
    const credentials = createBrowserRequestCredentialAuthority({
      now: () => now,
      randomBytes: (size) => Buffer.alloc(size, 30),
    });
    const wallet = walletOperations(() => ({
      operation: operation("awaiting_confirmation"), access: "interactive",
    }));
    const registry = extendBrowserInterfaceRoutes({
      routes: await baseRoutes(), credentials, assets, walletOperations: wallet.port,
    });
    const result = await invoke(registry, "GET", "/api/v1/wallet/operations/not-canonical");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem.code).toBe("invalid_input");
    expect(wallet.calls.reads).toEqual([]);
    expect(wallet.calls.confirmations).toEqual([]);
    expect(wallet.calls.cancellations).toEqual([]);
    credentials.close();
  });

  it("rejects every port result whose operation identity differs from the requested resource", async () => {
    const credentials = createBrowserRequestCredentialAuthority({
      now: () => now,
      randomBytes: (size) => Buffer.alloc(size, 31),
    });
    const foreign = operation("awaiting_confirmation", foreignOperationId);
    const wallet: WalletInterfaceOperations = Object.freeze({
      presentation: Object.freeze({
        get: async () => Object.freeze({ operation: foreign, access: "interactive" as const, qr }),
      }),
      operation: Object.freeze({
        start: async () => foreign,
        get: async () => foreign,
        cancel: async () => foreign,
      }),
      confirmation: Object.freeze({
        interactionInterface: "web" as const,
        confirm: async () => foreign,
      }),
    });
    const registry = extendBrowserInterfaceRoutes({
      routes: await baseRoutes(), credentials, assets, walletOperations: wallet,
    });

    for (const [method, path, body] of [
      ["GET", `/wallet/operations/${operationId}`, {}],
      ["GET", `/api/v1/wallet/operations/${operationId}`, {}],
      ["GET", `/api/v1/wallet/operations/${operationId}/qr`, {}],
      ["POST", `/api/v1/wallet/operations/${operationId}/confirmation`, { connectionRevision: "7" }],
      ["DELETE", `/api/v1/wallet/operations/${operationId}`, {}],
    ] as const) {
      const result = await invoke(registry, method, path, body);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.problem.code).toBe("internal_error");
    }
    credentials.close();
  });

  it("keeps route names resource-oriented and caller-neutral", () => {
    expect(JSON.stringify(browserInterfacePaths)).not.toContain("mcp");
    expect(JSON.stringify(browserInterfacePaths)).not.toContain("cli");
    for (const path of Object.values(browserInterfacePaths)) expect(path).toMatch(/^\//u);
  });
});
