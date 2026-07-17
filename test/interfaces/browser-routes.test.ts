import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { BrowserAssetBundle } from "../../src/interfaces/browser-assets.js";
import {
  browserAssetPaths,
  browserCsrfHeaderName,
  browserCsrfMetaName,
  browserOperationCancellationPath,
  browserOperationConfirmationPath,
  browserOperationPath,
  browserPagePaths,
  browserWalletApiPaths,
} from "../../src/interfaces/browser-contract.js";
import {
  browserSessionCookieName,
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
import {
  fixedHostHeader,
  fixedOrigin,
  jsonContentType,
} from "../../src/runtime/http-boundary.js";
import { runtimePaths } from "../../src/runtime/paths.js";
import {
  parseWalletCurrentOperationProjection,
  parseWalletManagementOperation,
  parseWalletOperationStartResult,
  parseWalletQrMatrix,
  type WalletCurrentOperationProjection,
  type WalletInterfaceOperations,
  type WalletManagementOperation,
  type WalletOperationConfirmation,
  type WalletOperationStartResult,
  type WalletWebOperationCreate,
} from "../../src/wallet/contracts.js";
import { WalletOperationError } from "../../src/wallet/errors.js";

const directories: string[] = [];
const operationId = Buffer.alloc(32, 13).toString("base64url");
const foreignOperationId = Buffer.alloc(32, 14).toString("base64url");
const expiresAt = "2026-07-15T04:00:00.000Z";
const now = Date.parse("2026-07-15T03:00:00.000Z");
const connectionRevision = "7";
const disconnected = Object.freeze({
  status: "disconnected" as const,
  reason: "no_session" as const,
});

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })));
});

const operation = (
  state: "awaiting_confirmation" | "awaiting_wallet_approval" | "cancelled",
  id = operationId,
): WalletManagementOperation =>
  parseWalletManagementOperation({
    operationId: id,
    kind: state === "awaiting_confirmation" ? "disconnect" : "connect",
    state,
    connectionRevision,
    expiresAt,
    result: null,
    failure: null,
  });

const qr = parseWalletQrMatrix({
  size: 21,
  rows: Array.from({ length: 21 }, (_unused, row) =>
    Array.from({ length: 21 }, (_other, column) =>
      (row + column) % 2 === 0 ? "1" : "0").join("")),
});

const currentPresent = (
  value: WalletManagementOperation = operation("awaiting_wallet_approval"),
): WalletCurrentOperationProjection => parseWalletCurrentOperationProjection({
  status: "present",
  connectionRevision,
  connection: disconnected,
  presentation: {
    operation: value,
    access: "interactive",
    ...(value.state === "awaiting_wallet_approval" ? { qr } : {}),
  },
});

const currentAbsent = (): WalletCurrentOperationProjection =>
  parseWalletCurrentOperationProjection({
    status: "absent",
    connectionRevision,
    connection: disconnected,
  });

const started = (
  value: WalletManagementOperation = operation("awaiting_wallet_approval"),
): WalletOperationStartResult => parseWalletOperationStartResult({
  status: "operation_started",
  operation: value,
});

const assets: BrowserAssetBundle = Object.freeze({
  renderShell: (token: string) =>
    `<meta name="${browserCsrfMetaName}" content="${token}">`,
  get: (path: string) => path === "/assets/index-Abcdef12.js"
    ? Object.freeze({
        body: "export{};",
        contentType: "text/javascript; charset=utf-8" as const,
      })
    : undefined,
  paths: () => Object.freeze(["/assets/index-Abcdef12.js"]),
});

interface WalletCalls {
  readonly starts: WalletWebOperationCreate[];
  readonly currentReads: string[];
  readonly exactReads: string[];
  readonly confirmations: unknown[];
  readonly cancellations: unknown[];
}

const walletOperations = (input: {
  readonly current?: () => WalletCurrentOperationProjection;
  readonly start?: () => WalletOperationStartResult;
  readonly operationResult?: () => WalletManagementOperation;
  readonly expectedRevision?: string;
} = {}): { readonly port: WalletInterfaceOperations; readonly calls: WalletCalls } => {
  const calls: WalletCalls = {
    starts: [],
    currentReads: [],
    exactReads: [],
    confirmations: [],
    cancellations: [],
  };
  const expectedRevision = input.expectedRevision ?? connectionRevision;
  const assertRevision = (value: unknown): void => {
    if (
      typeof value !== "object" ||
      value === null ||
      (value as { readonly connectionRevision?: unknown }).connectionRevision !== expectedRevision
    ) throw new WalletOperationError("state_conflict");
  };
  const result = input.operationResult ?? (() => operation("cancelled"));
  return Object.freeze({
    calls,
    port: Object.freeze({
      currentProjection: Object.freeze({
        async get() {
          calls.currentReads.push("current");
          return (input.current ?? currentPresent)();
        },
      }),
      presentation: Object.freeze({
        async get(id: string) {
          calls.exactReads.push(id);
          const exact = result();
          return {
            operation: exact,
            access: "interactive" as const,
            ...(exact.state === "awaiting_wallet_approval" ? { qr } : {}),
          };
        },
      }),
      operation: Object.freeze({
        async start(value: WalletWebOperationCreate) {
          calls.starts.push(value);
          return (input.start ?? started)();
        },
        async cancel(id: string, value: WalletOperationConfirmation) {
          assertRevision(value);
          calls.cancellations.push({ id, input: value });
          return result();
        },
      }),
      confirmation: Object.freeze({
        interactionInterface: "web" as const,
        async confirm(id: string, value: WalletOperationConfirmation) {
          assertRevision(value);
          calls.confirmations.push({ id, input: value });
          return result();
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
  return createRuntimeRouteRegistry({
    controlVerifier: createControlCredentialVerifier(credential),
  });
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

const bootstrap = async (
  registry: RuntimeRouteRegistry,
): Promise<{ readonly cookie: string; readonly csrfToken: string }> => {
  const page = await invoke(registry, "GET", browserPagePaths.root);
  if (!page.ok || page.response !== "browser_content" || page.setCookie === undefined) {
    throw new Error("Expected a credentialed root shell.");
  }
  const cookie = page.setCookie.split(";", 1)[0] as string;
  const csrfToken = /content="([A-Za-z0-9_-]{43})"/.exec(page.body)?.[1];
  if (csrfToken === undefined) throw new Error("Expected a CSRF token in the root shell.");
  return Object.freeze({ cookie, csrfToken });
};

describe("wallet browser routes", () => {
  it("registers only the root page, wallet session API, and immutable asset resources", async () => {
    const credentials = createBrowserRequestCredentialAuthority({
      now: () => now,
      randomBytes: (size) => Buffer.alloc(size, 15),
    });
    const wallet = walletOperations();
    const registry = extendBrowserInterfaceRoutes({
      routes: await baseRoutes(),
      credentials,
      assets,
      walletOperations: wallet.port,
    });
    const expected = [
      ["GET", "/", "browser_bootstrap", "browser_content", "none"],
      ["POST", browserWalletApiPaths.operations, "browser_control", "canonical_json", "declared_control"],
      ["GET", browserWalletApiPaths.currentOperation, "browser_read", "canonical_json", "none"],
      ["GET", browserOperationPath(operationId), "browser_read", "canonical_json", "none"],
      ["POST", browserOperationConfirmationPath(operationId), "browser_control", "canonical_json", "declared_control"],
      ["POST", browserOperationCancellationPath(operationId), "browser_control", "canonical_json", "declared_control"],
      ["GET", "/assets/index-Abcdef12.js", "public_read", "browser_content", "none"],
    ] as const;
    for (const [method, path, requestClass, response, mutation] of expected) {
      const match = registry.match(method, path);
      expect(match.status).toBe("matched");
      if (match.status === "matched") {
        expect(match.route).toMatchObject({
          method,
          requestClass,
          response,
          mutation,
          successStatus: 200,
        });
      }
    }

    expect(registry.match("GET", "/wallet").status).toBe("not_found");
    expect(registry.match(
      "GET",
      `/api/v1/wallet/operations/${operationId}/qr`,
    ).status).toBe("not_found");
    expect(registry.match(
      "DELETE",
      `/api/v1/wallet/operations/${operationId}`,
    ).status).toBe("method_not_allowed");

    const page = await invoke(registry, "GET", "/");
    expect(page.ok).toBe(true);
    if (!page.ok || page.response !== "browser_content") {
      throw new Error("Expected the browser root shell.");
    }
    expect(page.setCookie?.startsWith(`${browserSessionCookieName}=`)).toBe(true);
    expect(page.body).toContain(`name="${browserCsrfMetaName}"`);
    expect(wallet.calls).toEqual({
      starts: [],
      currentReads: [],
      exactReads: [],
      confirmations: [],
      cancellations: [],
    });
    credentials.close();
  });

  it("issues session authority only at the root and enforces Host, Origin, cookie, and CSRF", async () => {
    let entropy = 20;
    const credentials = createBrowserRequestCredentialAuthority({
      now: () => now,
      randomBytes: (size) => Buffer.alloc(size, ++entropy),
    });
    const wallet = walletOperations();
    const registry = extendBrowserInterfaceRoutes({
      routes: await baseRoutes(),
      credentials,
      assets,
      walletOperations: wallet.port,
    });
    const rootMatch = registry.match("GET", browserPagePaths.root);
    if (rootMatch.status !== "matched") throw new Error("Expected the root bootstrap route.");
    const noAuthority = {
      host: [fixedHostHeader],
      origin: [],
      authorization: [],
      cookie: [],
      csrfToken: [],
      contentType: [],
      query: "",
      bodyLength: 0,
    } as const;
    expect(registry.validateSecurity(rootMatch, noAuthority)).toEqual({ ok: true });
    expect(registry.validateSecurity(rootMatch, {
      ...noAuthority,
      origin: [fixedOrigin],
    })).toEqual({ ok: false, code: "invalid_origin" });

    const { cookie, csrfToken } = await bootstrap(registry);
    const secondBootstrap = await bootstrap(registry);
    expect(secondBootstrap).toEqual({ cookie, csrfToken });
    const currentMatch = registry.match("GET", browserWalletApiPaths.currentOperation);
    const startMatch = registry.match("POST", browserWalletApiPaths.operations);
    if (currentMatch.status !== "matched" || startMatch.status !== "matched") {
      throw new Error("Expected wallet browser API routes.");
    }
    const readInput = {
      host: [fixedHostHeader],
      origin: [],
      authorization: [],
      cookie: [cookie],
      csrfToken: [],
      contentType: [],
      query: "",
      bodyLength: 0,
    } as const;
    expect(registry.validateSecurity(currentMatch, readInput)).toEqual({ ok: true });
    expect(registry.validateSecurity(currentMatch, {
      ...readInput,
      origin: [fixedOrigin],
    })).toEqual({ ok: true });
    expect(registry.validateSecurity(currentMatch, {
      ...readInput,
      host: ["localhost:46630"],
    })).toEqual({ ok: false, code: "invalid_host" });
    expect(registry.validateSecurity(currentMatch, {
      ...readInput,
      cookie: [],
    })).toEqual({ ok: false, code: "unauthorized" });

    const controlInput = {
      ...readInput,
      origin: [fixedOrigin],
      csrfToken: [csrfToken],
      contentType: [jsonContentType],
      bodyLength: 43,
    } as const;
    expect(registry.validateSecurity(startMatch, controlInput)).toEqual({ ok: true });
    expect(registry.validateSecurity(startMatch, {
      ...controlInput,
      origin: [],
    })).toEqual({ ok: false, code: "invalid_origin" });
    expect(registry.validateSecurity(startMatch, {
      ...controlInput,
      csrfToken: [],
    })).toEqual({ ok: false, code: "unauthorized" });
    credentials.close();
  });

  it("returns the current operation atomically and one exact retained presentation", async () => {
    const credentials = createBrowserRequestCredentialAuthority({
      now: () => now,
      randomBytes: (size) => Buffer.alloc(size, 25),
    });
    const present = currentPresent();
    const wallet = walletOperations({ current: () => present });
    const registry = extendBrowserInterfaceRoutes({
      routes: await baseRoutes(),
      credentials,
      assets,
      walletOperations: wallet.port,
    });

    expect(await invoke(
      registry,
      "GET",
      browserWalletApiPaths.currentOperation,
    )).toEqual({
      ok: true,
      response: "canonical_json",
      body: present,
    });
    expect(wallet.calls.currentReads).toEqual(["current"]);
    expect(wallet.calls.exactReads).toEqual([]);

    const exact = {
      operation: operation("cancelled"),
      access: "interactive",
    } as const;
    expect(await invoke(
      registry,
      "GET",
      browserOperationPath(operationId),
    )).toEqual({
      ok: true,
      response: "canonical_json",
      body: exact,
    });
    expect(wallet.calls.exactReads).toEqual([operationId]);

    const absent = currentAbsent();
    const absentWallet = walletOperations({ current: () => absent });
    const absentCredentials = createBrowserRequestCredentialAuthority({
      now: () => now,
      randomBytes: (size) => Buffer.alloc(size, 26),
    });
    const absentRegistry = extendBrowserInterfaceRoutes({
      routes: await baseRoutes(),
      credentials: absentCredentials,
      assets,
      walletOperations: absentWallet.port,
    });
    expect(await invoke(
      absentRegistry,
      "GET",
      browserWalletApiPaths.currentOperation,
    )).toEqual({
      ok: true,
      response: "canonical_json",
      body: absent,
    });
    absentCredentials.close();
    credentials.close();
  });

  it("parses state-based start and exact revision-bound follow-up commands", async () => {
    const credentials = createBrowserRequestCredentialAuthority({
      now: () => now,
      randomBytes: (size) => Buffer.alloc(size, 27),
    });
    let startResult = started();
    const controlResult = operation("cancelled");
    const wallet = walletOperations({
      start: () => startResult,
      operationResult: () => controlResult,
    });
    const registry = extendBrowserInterfaceRoutes({
      routes: await baseRoutes(),
      credentials,
      assets,
      walletOperations: wallet.port,
    });
    const startInput = { kind: "connect", connectionRevision } as const;
    expect(await invoke(
      registry,
      "POST",
      browserWalletApiPaths.operations,
      startInput,
    )).toEqual({
      ok: true,
      response: "canonical_json",
      body: startResult,
    });
    expect(await invoke(
      registry,
      "POST",
      browserOperationConfirmationPath(operationId),
      { connectionRevision },
    )).toEqual({
      ok: true,
      response: "canonical_json",
      body: controlResult,
    });
    expect(await invoke(
      registry,
      "POST",
      browserOperationCancellationPath(operationId),
      { connectionRevision },
    )).toEqual({
      ok: true,
      response: "canonical_json",
      body: controlResult,
    });
    expect(wallet.calls.starts).toEqual([startInput]);
    expect(wallet.calls.confirmations).toEqual([{
      id: operationId,
      input: { connectionRevision },
    }]);
    expect(wallet.calls.cancellations).toEqual([{
      id: operationId,
      input: { connectionRevision },
    }]);

    startResult = started(operation("awaiting_confirmation"));
    const disconnectInput = { kind: "disconnect", connectionRevision } as const;
    expect(await invoke(
      registry,
      "POST",
      browserWalletApiPaths.operations,
      disconnectInput,
    )).toEqual({
      ok: true,
      response: "canonical_json",
      body: startResult,
    });
    expect(wallet.calls.starts).toEqual([startInput, disconnectInput]);

    startResult = parseWalletOperationStartResult({
      status: "current_connection",
      connectionRevision,
      connection: {
        status: "connected",
        address: "0x1111111111111111111111111111111111111111",
        chainId: "eip155:4663",
        approvedMethods: ["eth_sendTransaction"],
        approvedEvents: ["accountsChanged", "chainChanged"],
        expiresAt: "2026-07-22T00:00:00.000Z",
      },
    });
    expect(await invoke(
      registry,
      "POST",
      browserWalletApiPaths.operations,
      startInput,
    )).toEqual({
      ok: true,
      response: "canonical_json",
      body: startResult,
    });
    credentials.close();
  });

  it("rejects malformed commands before ports and preserves stale-revision failures", async () => {
    const credentials = createBrowserRequestCredentialAuthority({
      now: () => now,
      randomBytes: (size) => Buffer.alloc(size, 28),
    });
    const wallet = walletOperations();
    const registry = extendBrowserInterfaceRoutes({
      routes: await baseRoutes(),
      credentials,
      assets,
      walletOperations: wallet.port,
    });

    for (const [path, body] of [
      [browserWalletApiPaths.operations, {
        kind: "connect",
        connectionRevision,
        extra: true,
      }],
      [browserWalletApiPaths.operations, {
        kind: "unknown",
        connectionRevision,
      }],
      [browserWalletApiPaths.operations, {
        kind: "connect",
      }],
      [browserOperationConfirmationPath(operationId), {
        connectionRevision,
        extra: true,
      }],
      [browserOperationCancellationPath(operationId), {
        connectionRevision: "-1",
      }],
    ] as const) {
      const result = await invoke(registry, "POST", path, body);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.problem.code).toBe("invalid_input");
    }
    expect(wallet.calls.starts).toEqual([]);
    expect(wallet.calls.confirmations).toEqual([]);
    expect(wallet.calls.cancellations).toEqual([]);

    const staleStartWallet = walletOperations({
      start: () => { throw new WalletOperationError("state_conflict"); },
    });
    const staleStartRegistry = extendBrowserInterfaceRoutes({
      routes: await baseRoutes(),
      credentials,
      assets,
      walletOperations: staleStartWallet.port,
    });
    const staleStart = await invoke(
      staleStartRegistry,
      "POST",
      browserWalletApiPaths.operations,
      { kind: "connect", connectionRevision },
    );
    expect(staleStart.ok).toBe(false);
    if (!staleStart.ok) expect(staleStart.problem.code).toBe("state_conflict");

    for (const path of [
      browserOperationConfirmationPath(operationId),
      browserOperationCancellationPath(operationId),
    ]) {
      const result = await invoke(
        registry,
        "POST",
        path,
        { connectionRevision: "8" },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.problem.code).toBe("state_conflict");
    }
    credentials.close();
  });

  it("fails closed for invalid operation identities and hostile port results", async () => {
    const credentials = createBrowserRequestCredentialAuthority({
      now: () => now,
      randomBytes: (size) => Buffer.alloc(size, 29),
    });
    const foreign = operation("cancelled", foreignOperationId);
    const wallet = walletOperations({
      current: () => ({ status: "present" } as never),
      start: () => ({
        status: "operation_started",
        operation: foreign,
        extra: true,
      } as never),
      operationResult: () => foreign,
    });
    const registry = extendBrowserInterfaceRoutes({
      routes: await baseRoutes(),
      credentials,
      assets,
      walletOperations: wallet.port,
    });

    const current = await invoke(
      registry,
      "GET",
      browserWalletApiPaths.currentOperation,
    );
    expect(current.ok).toBe(false);
    if (!current.ok) expect(current.problem.code).toBe("internal_error");

    const exact = await invoke(
      registry,
      "GET",
      browserOperationPath(operationId),
    );
    expect(exact.ok).toBe(false);
    if (!exact.ok) expect(exact.problem.code).toBe("internal_error");

    const start = await invoke(
      registry,
      "POST",
      browserWalletApiPaths.operations,
      { kind: "connect", connectionRevision },
    );
    expect(start.ok).toBe(false);
    if (!start.ok) expect(start.problem.code).toBe("internal_error");

    for (const path of [
      browserOperationConfirmationPath(operationId),
      browserOperationCancellationPath(operationId),
    ]) {
      const result = await invoke(
        registry,
        "POST",
        path,
        { connectionRevision },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.problem.code).toBe("internal_error");
    }

    for (const [method, path] of [
      ["GET", "/api/v1/wallet/operations/not-canonical"],
      ["POST", "/api/v1/wallet/operations/not-canonical/confirmation"],
      ["POST", "/api/v1/wallet/operations/not-canonical/cancellation"],
    ] as const) {
      const result = await invoke(
        registry,
        method,
        path,
        { connectionRevision },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.problem.code).toBe("invalid_input");
    }
    credentials.close();
  });

  it("keeps page, API, and asset registries resource-oriented and caller-neutral", () => {
    expect(browserPagePaths).toEqual({ root: "/" });
    expect(JSON.stringify(browserWalletApiPaths)).not.toContain("mcp");
    expect(JSON.stringify(browserWalletApiPaths)).not.toContain("cli");
    expect(JSON.stringify(browserAssetPaths)).not.toContain("wallet");
    for (const path of [
      ...Object.values(browserPagePaths),
      ...Object.values(browserWalletApiPaths),
      ...Object.values(browserAssetPaths),
    ]) expect(path).toMatch(/^\//u);
    expect(browserCsrfHeaderName).toBe("Littlejohn-CSRF-Token");
  });
});
