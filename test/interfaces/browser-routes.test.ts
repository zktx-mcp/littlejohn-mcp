import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { chainInterfaceErrorMappings } from "../../src/chain/errors.js";
import { referenceMarketInterfaceErrorMappings } from "../../src/market-portfolio/errors.js";
import { accountAssetBrowserRoutes } from "../../src/account-assets/http-contract.js";
import {
  parseEvmAddress,
  referenceMarketManifest,
} from "../../src/core/index.js";
import type { BrowserAssetBundle } from "../../src/interfaces/browser-assets.js";
import {
  browserAssetPaths,
  browserCsrfHeaderName,
  browserCsrfMetaName,
  browserLocationHref,
  browserLocations,
  browserOperationCancellationPath,
  browserOperationConfirmationPath,
  browserOperationPath,
  referenceMarketBrowserMutationPaths,
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
import { tokenCatalogBrowserRoutes } from "../../src/token-catalog/browser.js";
import { TokenCatalogOperationError } from "../../src/token-catalog/operation-error.js";
import { tokenCatalogInterfaceHarnessPorts } from "../token-catalog/interface-harness.js";
import { accountAssetInterfaceHarnessPort } from "../account-assets/interface-harness.js";
import { referenceMarketInterfaceHarnessPort } from "../market-portfolio/interface-harness.js";
import {
  createReferenceMarketFailure,
  type ReferenceMarketApplicationPort,
} from "../../src/market-portfolio/index.js";

const directories: string[] = [];
const operationId = Buffer.alloc(32, 13).toString("base64url");
const browserPagePaths = Object.freeze({
  assets: browserLocationHref(browserLocations.assets()),
  prices: browserLocationHref(browserLocations.referencePrices()),
  price: browserLocationHref(browserLocations.referencePrice(
    referenceMarketManifest.pairs[0]!.pairId,
  )),
});
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
  state: "awaiting_confirmation" | "awaiting_wallet_approval" | "disconnecting" | "cancelled",
  id = operationId,
): WalletManagementOperation =>
  parseWalletManagementOperation({
    operationId: id,
    kind: state === "awaiting_confirmation" || state === "disconnecting" ? "disconnect" : "connect",
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

const interfacePorts = (
  referenceMarkets: ReferenceMarketApplicationPort = referenceMarketInterfaceHarnessPort(),
) => Object.freeze({
  ...tokenCatalogInterfaceHarnessPorts(),
  accountAssets: accountAssetInterfaceHarnessPort(),
  referenceMarkets,
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
    errorMappings: referenceMarketInterfaceErrorMappings,
  });
};

const invoke = async (
  registry: RuntimeRouteRegistry,
  method: RouteMethod,
  path: string,
  body: unknown = {},
  query = "",
): Promise<NormalizedRouteResult> => {
  const match = registry.match(method, path);
  expect(match.status).toBe("matched");
  if (match.status !== "matched") throw new Error("Expected a browser route match.");
  return registry.normalizeResult(match.route, await match.route.handler({
    params: match.params,
    body,
    query,
    signal: new AbortController().signal,
  }));
};

const bootstrap = async (
  registry: RuntimeRouteRegistry,
  path: (typeof browserPagePaths)[keyof typeof browserPagePaths] = browserPagePaths.assets,
  query = "",
): Promise<{ readonly cookie: string; readonly csrfToken: string }> => {
  const page = await invoke(registry, "GET", path, {}, query);
  if (!page.ok || page.response !== "browser_content" || page.setCookie === undefined) {
    throw new Error("Expected a credentialed information-page shell.");
  }
  const cookie = page.setCookie.split(";", 1)[0] as string;
  const csrfToken = /content="([A-Za-z0-9_-]{43})"/.exec(page.body)?.[1];
  if (csrfToken === undefined) throw new Error("Expected a CSRF token in the page shell.");
  return Object.freeze({ cookie, csrfToken });
};

describe("wallet browser routes", () => {
  it("registers only the application pages, browser APIs, and immutable asset resources", async () => {
    const credentials = createBrowserRequestCredentialAuthority({
      now: () => now,
      randomBytes: (size) => Buffer.alloc(size, 15),
    });
    const wallet = walletOperations();
    const registry = extendBrowserInterfaceRoutes({
      ...interfacePorts(),
      routes: await baseRoutes(),
      credentials,
      assets,
      walletOperations: wallet.port,
    });
    const expected = [
      ["GET", "/", "browser_bootstrap", "browser_content", "none", "none"],
      ["GET", "/prices", "browser_bootstrap", "browser_content", "none", "none"],
      ["GET", browserPagePaths.price, "browser_bootstrap", "browser_content", "none", "browser_location"],
      ["GET", accountAssetBrowserRoutes.overview, "browser_read", "canonical_json", "none", "none"],
      ["POST", accountAssetBrowserRoutes.exact(
        "eip155:4663",
        parseEvmAddress("0x1111111111111111111111111111111111111111"),
      ), "browser_query", "canonical_json", "none", "none"],
      ["POST", browserWalletApiPaths.operations, "browser_control", "canonical_json", "declared_control", "none"],
      ["GET", browserWalletApiPaths.currentOperation, "browser_read", "canonical_json", "none", "none"],
      ["GET", browserOperationPath(operationId), "browser_read", "canonical_json", "none", "none"],
      ["POST", browserOperationConfirmationPath(operationId), "browser_control", "canonical_json", "declared_control", "none"],
      ["POST", browserOperationCancellationPath(operationId), "browser_control", "canonical_json", "declared_control", "none"],
      ["POST", tokenCatalogBrowserRoutes.operations, "browser_control", "canonical_json", "declared_control", "none"],
      ["GET", tokenCatalogBrowserRoutes.currentOperation, "browser_read", "canonical_json", "none", "none"],
      ["GET", tokenCatalogBrowserRoutes.operation(operationId), "browser_read", "canonical_json", "none", "none"],
      ["POST", tokenCatalogBrowserRoutes.confirmation(operationId), "browser_control", "canonical_json", "declared_control", "none"],
      ["POST", tokenCatalogBrowserRoutes.cancellation(operationId), "browser_control", "canonical_json", "declared_control", "none"],
      ["GET", "/assets/index-Abcdef12.js", "public_read", "browser_content", "none", "none"],
    ] as const;
    for (const [method, path, requestClass, response, mutation, query] of expected) {
      const match = registry.match(method, path);
      expect(match.status).toBe("matched");
      if (match.status === "matched") {
        expect(match.route).toMatchObject({
          method,
          requestClass,
          response,
          mutation,
          query,
          successStatus: 200,
        });
      }
    }

    expect(registry.match("GET", "/unsupported").status).toBe("not_found");
    expect(registry.match(
      "GET",
      `/api/v1/wallet/operations/${operationId}/unsupported`,
    ).status).toBe("not_found");
    expect(registry.match(
      "DELETE",
      `/api/v1/wallet/operations/${operationId}`,
    ).status).toBe("method_not_allowed");

    for (const path of Object.values(browserPagePaths)) {
      const page = await invoke(registry, "GET", path);
      expect(page.ok).toBe(true);
      if (!page.ok || page.response !== "browser_content") {
        throw new Error("Expected a browser information-page shell.");
      }
      expect(page.setCookie?.startsWith(`${browserSessionCookieName}=`)).toBe(true);
      expect(page.body).toContain(`name="${browserCsrfMetaName}"`);
    }
    expect(wallet.calls).toEqual({
      starts: [],
      currentReads: [],
      exactReads: [],
      confirmations: [],
      cancellations: [],
    });
    credentials.close();
  });

  it("admits only the selected-price location query before issuing page authority", async () => {
    const credentials = createBrowserRequestCredentialAuthority({
      now: () => now,
      randomBytes: (size) => Buffer.alloc(size, 16),
    });
    const registry = extendBrowserInterfaceRoutes({
      ...interfacePorts(),
      routes: await baseRoutes(),
      credentials,
      assets,
      walletOperations: walletOperations().port,
    });

    for (const query of ["?window=7d", "?window=30d"]) {
      const page = await invoke(registry, "GET", browserPagePaths.price, {}, query);
      expect(page.ok).toBe(true);
      if (!page.ok || page.response !== "browser_content") {
        throw new Error("Expected a selected-price browser page.");
      }
      expect(page.setCookie?.startsWith(`${browserSessionCookieName}=`)).toBe(true);
    }

    for (const query of [
      "?window=2d",
      "?window=1d&window=30d",
      "?unknown=1d",
      "?",
    ]) {
      const page = await invoke(registry, "GET", browserPagePaths.price, {}, query);
      expect(page.ok).toBe(false);
      expect("setCookie" in page).toBe(false);
      if (!page.ok) expect(page.problem.code).toBe("invalid_input");
    }

    for (const path of [browserPagePaths.assets, browserPagePaths.prices]) {
      const match = registry.match("GET", path);
      if (match.status !== "matched") throw new Error("Expected a browser page route.");
      expect(registry.validateSecurity(match, {
        host: [fixedHostHeader],
        origin: [],
        authorization: [],
        cookie: [],
        csrfToken: [],
        contentType: [],
        query: "?window=1d",
        bodyLength: 0,
      })).toEqual({ ok: false, code: "query_not_supported" });
    }
    credentials.close();
  });

  it("binds each browser reference-market mutation path to the matching application effect", async () => {
    const calls: string[] = [];
    const base = referenceMarketInterfaceHarnessPort();
    const record = (
      action: "add" | "remove" | "reorder",
    ) => async () => {
      calls.push(action);
      return createReferenceMarketFailure("wallet_not_connected");
    };
    const referenceMarkets: ReferenceMarketApplicationPort = Object.freeze({
      ...base,
      addPair: record("add"),
      removePair: record("remove"),
      reorderPairs: record("reorder"),
    });
    const credentials = createBrowserRequestCredentialAuthority({
      now: () => now,
      randomBytes: (size) => Buffer.alloc(size, 18),
    });
    const registry = extendBrowserInterfaceRoutes({
      ...interfacePorts(referenceMarkets),
      routes: await baseRoutes(),
      credentials,
      assets,
      walletOperations: walletOperations().port,
    });
    const pairId = referenceMarketManifest.pairs[0]!.pairId;
    const expectedRevision = "AAAAAAAAAAAAAAAAAAAAAA";
    const requests = {
      add: { pairId, expectedRevision },
      remove: { pairId, expectedRevision },
      reorder: { pairIds: [pairId], expectedRevision },
    } as const;
    for (const action of ["add", "remove", "reorder"] as const) {
      await invoke(registry, "POST", referenceMarketBrowserMutationPaths[action], requests[action]);
    }
    expect(calls).toEqual(["add", "remove", "reorder"]);
    credentials.close();
  });

  it("issues session authority only at information pages and enforces Host, Origin, cookie, and CSRF", async () => {
    let entropy = 20;
    const credentials = createBrowserRequestCredentialAuthority({
      now: () => now,
      randomBytes: (size) => Buffer.alloc(size, ++entropy),
    });
    const wallet = walletOperations();
    const registry = extendBrowserInterfaceRoutes({
      ...interfacePorts(),
      routes: await baseRoutes(),
      credentials,
      assets,
      walletOperations: wallet.port,
    });
    const pageMatch = registry.match("GET", browserPagePaths.assets);
    if (pageMatch.status !== "matched") throw new Error("Expected the account bootstrap route.");
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
    expect(registry.validateSecurity(pageMatch, noAuthority)).toEqual({ ok: true });
    expect(registry.validateSecurity(pageMatch, {
      ...noAuthority,
      origin: [fixedOrigin],
    })).toEqual({ ok: false, code: "invalid_origin" });

    const { cookie, csrfToken } = await bootstrap(registry);
    expect(registry.match("GET", "/unsupported").status).toBe("not_found");
    const currentMatch = registry.match("GET", browserWalletApiPaths.currentOperation);
    const startMatch = registry.match("POST", browserWalletApiPaths.operations);
    const tokenControlMatch = registry.match("POST", tokenCatalogBrowserRoutes.operations);
    const overviewMatch = registry.match("GET", accountAssetBrowserRoutes.overview);
    if (
      currentMatch.status !== "matched" ||
      startMatch.status !== "matched" ||
      tokenControlMatch.status !== "matched" ||
      overviewMatch.status !== "matched"
    ) {
      throw new Error("Expected wallet browser API routes.");
    }
    expect(registry.match("POST", "/api/v1/token-catalog/inspections").status)
      .toBe("not_found");
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
    expect(registry.validateSecurity(overviewMatch, readInput)).toEqual({ ok: true });
    expect(registry.validateSecurity(overviewMatch, {
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
    expect(registry.validateSecurity(tokenControlMatch, controlInput)).toEqual({ ok: true });
    credentials.close();
  });

  it("projects token catalog operation state and failures through canonical contracts", async () => {
    const credentials = createBrowserRequestCredentialAuthority({
      now: () => now,
      randomBytes: (size) => Buffer.alloc(size, 49),
    });
    const registry = extendBrowserInterfaceRoutes({
      ...interfacePorts(),
      routes: await baseRoutes(),
      credentials,
      assets,
      walletOperations: walletOperations().port,
    });

    expect(await invoke(
      registry,
      "GET",
      tokenCatalogBrowserRoutes.currentOperation,
    )).toEqual({
      ok: true,
      response: "canonical_json",
      body: { operation: null },
    });

    const cancelled = await invoke(
      registry,
      "POST",
      tokenCatalogBrowserRoutes.cancellation(operationId),
      {},
    );
    expect(cancelled.ok).toBe(false);
    if (!cancelled.ok) expect(cancelled.problem.code).toBe("token_operation_not_found");
    credentials.close();
  });

  it("dispatches every token catalog start kind through the shared browser application meaning", async () => {
    const credentials = createBrowserRequestCredentialAuthority({
      now: () => now,
      randomBytes: (size) => Buffer.alloc(size, 50),
    });
    const calls: unknown[] = [];
    const rejected = () => new TokenCatalogOperationError("token_selection_revision_changed").failure;
    const ports = interfacePorts();
    const registry = extendBrowserInterfaceRoutes({
      ...ports,
      tokenCatalogWebStart: Object.freeze({
        interactionInterface: "web" as const,
        async startAddition(input: unknown) { calls.push(input); return rejected(); },
        async startRemoval(input: unknown) { calls.push(input); return rejected(); },
      }),
      routes: await baseRoutes(),
      credentials,
      assets,
      walletOperations: walletOperations().port,
    });
    const asset = {
      kind: "erc20",
      chainId: "eip155:4663",
      address: "0x1111111111111111111111111111111111111111",
    } as const;
    const revision = Buffer.alloc(16, 3).toString("base64url");
    const requests = [
      { kind: "add", asset },
      { kind: "remove", asset, expectedRevision: revision },
    ] as const;
    for (const request of requests) {
      const result = await invoke(
        registry,
        "POST",
        tokenCatalogBrowserRoutes.operations,
        {
          control: { operationId, interactionInterface: "web" },
          request,
        },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.problem.code).toBe("token_selection_revision_changed");
    }
    expect(calls).toEqual(requests.map(({ kind: _kind, ...request }) => request));
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
      ...interfacePorts(),
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
      ...interfacePorts(),
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
    const controlResult = operation("disconnecting");
    const wallet = walletOperations({
      start: () => startResult,
      operationResult: () => controlResult,
    });
    const registry = extendBrowserInterfaceRoutes({
      ...interfacePorts(),
      routes: await baseRoutes(),
      credentials,
      assets,
      walletOperations: wallet.port,
    });
    const startInput = { kind: "connect", connectionRevision } as const;
    const startEnvelope = {
      control: { operationId, interactionInterface: "web" },
      request: startInput,
    } as const;
    expect(await invoke(
      registry,
      "POST",
      browserWalletApiPaths.operations,
      startEnvelope,
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
      {
        control: { operationId, interactionInterface: "web" },
        request: disconnectInput,
      },
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
      startEnvelope,
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
      ...interfacePorts(),
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
      ...interfacePorts(),
      routes: await baseRoutes(),
      credentials,
      assets,
      walletOperations: staleStartWallet.port,
    });
    const staleStart = await invoke(
      staleStartRegistry,
      "POST",
      browserWalletApiPaths.operations,
      {
        control: { operationId, interactionInterface: "web" },
        request: { kind: "connect", connectionRevision },
      },
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
      ...interfacePorts(),
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
      {
        control: { operationId, interactionInterface: "web" },
        request: { kind: "connect", connectionRevision },
      },
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
    expect(browserPagePaths).toEqual({
      assets: "/",
      prices: "/prices",
      price: browserPagePaths.price,
    });
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
