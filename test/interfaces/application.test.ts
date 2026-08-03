import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { extendChainSupportManifest } from "../../src/chain/application.js";
import {
  extendAccountAssetControlRouteRegistry,
} from "../../src/account-assets/routes.js";
import { extendAccountAssetSupportManifest } from "../../src/account-assets/support.js";
import { extendReferenceMarketSupportManifest } from "../../src/market-portfolio/support.js";
import {
  accountBalanceCapability,
  chainStatusCapability,
  contractInspectCapability,
  referenceMarketManifest,
  transactionInspectCapability,
  walletConnectionCapability,
} from "../../src/core/index.js";
import type { BrowserAssetBundle } from "../../src/interfaces/browser-assets.js";
import {
  createBrowserRequestCredentialAuthority,
  type BrowserRequestCredentialAuthority,
} from "../../src/interfaces/browser-credentials.js";
import { createInterfaceOwnerApplicationFactory } from "../../src/interfaces/application.js";
import { extendTokenCatalogSupportManifest } from "../../src/token-catalog/support.js";
import {
  createControlAuthorizationHeader,
  createControlCredentialVerifier,
  loadOrCreateControlCredential,
} from "../../src/runtime/control-credential.js";
import {
  fixedHostHeader,
  jsonContentType,
} from "../../src/runtime/http-boundary.js";
import { createRuntimeRouteRegistry } from "../../src/runtime/http-routing.js";
import { runtimePaths } from "../../src/runtime/paths.js";
import { createResourceOwnershipScope } from "../../src/runtime/resource-ownership.js";
import {
  createInitialRuntimeSupportManifest,
  readRuntimeSupportManifest,
  type ChainReadCapabilityPort,
  type WalletConnectionReadCapabilityPort,
} from "../../src/runtime/index.js";
import { readRuntimeConfiguration } from "../../src/runtime/configuration.js";
import { extendWalletSupportManifest } from "../../src/wallet/application.js";
import {
  parseWalletCurrentOperationProjection,
  parseWalletManagementOperation,
  parseWalletOperationStartResult,
  type WalletInterfaceOperations,
} from "../../src/wallet/contracts.js";
import { bindForHarness, createCapabilityHarness } from "../core/capability-harness.js";
import { referenceMarketInterfaceHarnessPort } from "../market-portfolio/interface-harness.js";
import { tokenCatalogInterfaceHarnessPorts } from "../token-catalog/interface-harness.js";
import { accountAssetInterfaceHarnessPort } from "../account-assets/interface-harness.js";
import {
  extendUniswapV2ProtocolHarnessManifest,
  uniswapV2QuoteHarnessBinding,
} from "../protocols/interface-harness.js";

const directories: string[] = [];
const operationId = Buffer.alloc(32, 41).toString("base64url");

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

const capabilityPorts = (): {
  readonly wallet: WalletConnectionReadCapabilityPort;
  readonly chain: ChainReadCapabilityPort;
} => {
  const harness = createCapabilityHarness();
  const failure = async () => ({ status: "failure" as const, code: "internal_error", issues: [] });
  return Object.freeze({
    wallet: Object.freeze({ connection: bindForHarness(walletConnectionCapability, harness, failure) }),
    chain: Object.freeze({
      accountBalance: bindForHarness(accountBalanceCapability, harness, failure),
      chainStatus: bindForHarness(chainStatusCapability, harness, failure),
      contractInspect: bindForHarness(contractInspectCapability, harness, failure),
      transactionInspect: bindForHarness(transactionInspectCapability, harness, failure),
    }),
  });
};

const walletOperations = (): WalletInterfaceOperations => {
  const operation = parseWalletManagementOperation({
    operationId,
    kind: "disconnect",
    state: "awaiting_confirmation",
    connectionRevision: "1",
    actionExpiresAt: "2026-07-15T06:00:00.000Z",
    interactionInterface: "web",
    result: null,
    failure: null,
    peerRefusalCode: null,
  });
  return Object.freeze({
    operation: Object.freeze({
      start: async () => parseWalletOperationStartResult({
        status: "operation_started",
        operation,
      }),
      cancel: async () => parseWalletManagementOperation({
        ...operation, state: "cancelled", result: null, failure: null,
      }),
    }),
    confirmation: Object.freeze({
      interactionInterface: "web" as const,
      confirm: async () => operation,
    }),
    presentation: Object.freeze({
      get: async () => Object.freeze({ operation, access: "interactive" as const }),
    }),
    currentProjection: Object.freeze({
      get: async () => parseWalletCurrentOperationProjection({
        status: "present",
        connectionRevision: "1",
        connection: { status: "disconnected", reason: "no_session" },
        presentation: { operation, access: "interactive" },
      }),
    }),
  });
};

const assets: BrowserAssetBundle = Object.freeze({
  renderShell: (token: string) => `<meta content="${token}">`,
  get: () => undefined,
  paths: () => Object.freeze([]),
});

describe("interface owner application", () => {
  it("atomically installs public reads, browser authority, and the final support projection", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "littlejohn-interface-app-"));
    directories.push(directory);
    const paths = runtimePaths(directory);
    const controlCredential = await loadOrCreateControlCredential(directory, paths.controlCredential);
    const accountAssets = accountAssetInterfaceHarnessPort();
    const routes = extendAccountAssetControlRouteRegistry({
      routes: createRuntimeRouteRegistry({
        controlVerifier: createControlCredentialVerifier(controlCredential),
      }),
      accountAssets,
    });
    const walletManifest = extendWalletSupportManifest(
      createInitialRuntimeSupportManifest(readRuntimeConfiguration({}).chain),
    );
    const chainManifest = extendChainSupportManifest(walletManifest);
    const tokenCatalogManifest = extendUniswapV2ProtocolHarnessManifest(
      extendReferenceMarketSupportManifest(extendAccountAssetSupportManifest(
        extendTokenCatalogSupportManifest(chainManifest),
      )),
    );
    const ports = capabilityPorts();
    let closes = 0;
    const createCredentials = (): BrowserRequestCredentialAuthority => {
      const authority = createBrowserRequestCredentialAuthority({
        now: () => Date.parse("2026-07-15T05:00:00.000Z"),
        randomBytes: (size) => Buffer.alloc(size, 42),
      });
      return Object.freeze({
        requestPolicyExtension: authority.requestPolicyExtension,
        issue: authority.issue,
        close: () => { closes += 1; authority.close(); },
      });
    };
    const application = await createInterfaceOwnerApplicationFactory({
      loadAssets: async () => assets,
      createCredentials,
    })({
      ...tokenCatalogInterfaceHarnessPorts(),
      accountAssets,
      referenceMarkets: referenceMarketInterfaceHarnessPort(),
      routes,
      signal: new AbortController().signal,
      startupResources: createResourceOwnershipScope().resources,
      supportManifest: tokenCatalogManifest,
      walletConnection: ports.wallet,
      walletOperations: walletOperations(),
      chainReads: ports.chain,
      uniswapV2Quote: uniswapV2QuoteHarnessBinding(),
    });

    for (const [method, path] of [
      ["GET", "/api/v1/chain-status"],
      ["GET", "/api/v1/wallet/connection"],
      ["GET", "/api/v1/capabilities"],
      ["GET", "/"],
      ["GET", "/prices"],
      ["GET", `/prices/${referenceMarketManifest.pairs[0]!.pairId}`],
      ["POST", "/api/v1/contract-inspections"],
      ["POST", "/api/v1/internal/control/account-assets/queries"],
      ["GET", "/api/v1/account-assets/overview"],
      ["POST", "/api/v1/account-assets/eip155:4663/0x1111111111111111111111111111111111111111"],
      ["POST", "/api/v1/token-inspections"],
      ["POST", "/api/v1/uniswap-v2-exact-input-quotes"],
      ["POST", "/api/v1/internal/control/token-catalog/inspections"],
      ["POST", "/api/v1/internal/control/token-catalog/selection-queries"],
      ["GET", "/api/v1/internal/control/token-catalog/selections/eip155:4663/0x1111111111111111111111111111111111111111"],
      ["POST", "/api/v1/internal/control/token-catalog/operations"],
      ["GET", `/api/v1/internal/control/token-catalog/operations/${operationId}`],
      ["POST", `/api/v1/internal/control/token-catalog/operations/${operationId}/confirmation`],
      ["DELETE", `/api/v1/internal/control/token-catalog/operations/${operationId}`],
      ["POST", "/api/v1/token-catalog/operations"],
      ["GET", "/api/v1/token-catalog/current-operation"],
      ["GET", `/api/v1/token-catalog/operations/${operationId}`],
      ["POST", `/api/v1/token-catalog/operations/${operationId}/confirmation`],
      ["POST", `/api/v1/token-catalog/operations/${operationId}/cancellation`],
      ["POST", "/api/v1/wallet/operations"],
      ["GET", "/api/v1/wallet/current-operation"],
      ["GET", `/api/v1/wallet/operations/${operationId}`],
      ["POST", `/api/v1/wallet/operations/${operationId}/confirmation`],
      ["POST", `/api/v1/wallet/operations/${operationId}/cancellation`],
    ] as const) {
      expect(
        application.routes.match(method, path).status,
        `${method} ${path} must be installed by the composed interface owner`,
      ).toBe("matched");
    }
    expect(application.routes.match("POST", "/api/v1/token-catalog/inspections").status)
      .toBe("not_found");
    expect(application.routes.match("GET", "/unsupported").status)
      .toBe("not_found");

    const root = application.routes.match("GET", "/");
    if (root.status !== "matched") throw new Error("Expected browser bootstrap route.");
    const bootstrapped = application.routes.normalizeResult(root.route, await root.route.handler({
      params: root.params,
      body: {},
      query: "",
      signal: new AbortController().signal,
    }));
    if (!bootstrapped.ok || bootstrapped.response !== "browser_content" ||
      bootstrapped.setCookie === undefined) throw new Error("Expected browser credential.");
    const cookie = bootstrapped.setCookie.split(";", 1)[0] as string;
    const securityBase = {
      host: [fixedHostHeader], origin: [], csrfToken: [], query: "",
      contentType: [jsonContentType], bodyLength: 2,
    } as const;
    const publicInspection = application.routes.match("POST", "/api/v1/token-inspections");
    const controlInspection = application.routes.match(
      "POST",
      "/api/v1/internal/control/token-catalog/inspections",
    );
    if (publicInspection.status !== "matched" || controlInspection.status !== "matched") {
      throw new Error("Expected token inspection routes.");
    }
    expect(application.routes.validateSecurity(publicInspection, {
      ...securityBase, authorization: [], cookie: [cookie],
    })).toEqual({ ok: false, code: "unauthorized" });
    const authorization = createControlAuthorizationHeader(controlCredential);
    expect(application.routes.validateSecurity(controlInspection, {
      ...securityBase, authorization: [authorization], cookie: [cookie],
    })).toEqual({ ok: false, code: "unauthorized" });
    expect(application.routes.validateSecurity(controlInspection, {
      ...securityBase, authorization: [authorization], cookie: [],
    })).toEqual({ ok: true });

    const supportSnapshot = readRuntimeSupportManifest(application.supportManifest);
    const availability = new Map<string, typeof supportSnapshot.capabilities[number]["availability"]>(
      supportSnapshot.capabilities.map((entry) => [entry.capabilityId, entry.availability]),
    );
    for (const capabilityId of ["account.balance", "chain.status", "transaction.inspect"]) {
      expect(availability.get(capabilityId)).toEqual({
        overall: "available", direct: "internal", http: "available",
        mcp: "available", cli: "available", web: "unavailable",
      });
    }
    expect(availability.get("contract.inspect")).toEqual({
      overall: "available", direct: "internal", http: "available",
      mcp: "available", cli: "available", web: "available",
    });
    expect(availability.get("wallet.connection")).toEqual({
      overall: "available", direct: "internal", http: "available",
      mcp: "available", cli: "available", web: "unavailable",
    });
    expect(availability.get("wallet.connect")?.http).toBe("internal");
    expect(availability.get("wallet.connect")?.web).toBe("available");
    expect(availability.get("wallet.disconnect")?.web).toBe("available");
    expect(availability.get("wallet.current_operation")?.web).toBe("available");
    expect(availability.get("wallet.cancel_operation")?.web).toBe("available");
    expect(availability.get("wallet.operation")?.web).toBe("available");
    expect(availability.get("token.inspect")).toEqual({
      overall: "available", direct: "internal", http: "available",
      mcp: "available", cli: "available", web: "available",
    });
    for (const capabilityId of [
      "token.selection",
      "token.selections",
      "token.start_addition",
      "token.start_removal",
      "token.operation",
      "token.cancel_operation",
    ]) expect(availability.get(capabilityId)).toEqual({
      overall: "available", direct: "internal", http: "internal",
      mcp: "available", cli: "available", web: "available",
    });
    expect(availability.get("account.assets")).toEqual({
      overall: "available", direct: "internal", http: "internal",
      mcp: "available", cli: "available", web: "available",
    });
    expect(availability.get("account.asset")).toEqual({
      overall: "available", direct: "internal", http: "internal",
      mcp: "unavailable", cli: "unavailable", web: "available",
    });

    await application.close();
    expect(closes).toBe(1);
  });

  it("closes browser credential authority when route assembly fails", async () => {
    let closes = 0;
    const factory = createInterfaceOwnerApplicationFactory({
      loadAssets: async () => assets,
      createCredentials: () => Object.freeze({
        requestPolicyExtension: createBrowserRequestCredentialAuthority().requestPolicyExtension,
        issue: () => { throw new Error("unused"); },
        close: () => { closes += 1; },
      }),
    });
    await expect(factory({} as never)).rejects.toThrow();
    expect(closes).toBe(1);
  });
});
