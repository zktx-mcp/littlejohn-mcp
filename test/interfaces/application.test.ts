import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { extendChainSupportManifest } from "../../src/chain/application.js";
import {
  accountBalanceCapability,
  chainStatusCapability,
  contractInspectCapability,
  transactionInspectCapability,
  walletConnectionCapability,
} from "../../src/core/index.js";
import type { BrowserAssetBundle } from "../../src/interfaces/browser-assets.js";
import {
  createBrowserRequestCredentialAuthority,
  type BrowserRequestCredentialAuthority,
} from "../../src/interfaces/browser-credentials.js";
import { createInterfaceOwnerApplicationFactory } from "../../src/interfaces/application.js";
import {
  createControlCredentialVerifier,
  loadOrCreateControlCredential,
} from "../../src/runtime/control-credential.js";
import { createRuntimeRouteRegistry } from "../../src/runtime/http-routing.js";
import { runtimePaths } from "../../src/runtime/paths.js";
import { createResourceOwnershipScope } from "../../src/runtime/resource-ownership.js";
import {
  initialRuntimeSupportManifest,
  readRuntimeSupportManifest,
  type ChainReadCapabilityPort,
  type WalletConnectionReadCapabilityPort,
} from "../../src/runtime/index.js";
import { extendWalletSupportManifest } from "../../src/wallet/application.js";
import {
  parseWalletCurrentOperationProjection,
  parseWalletManagementOperation,
  parseWalletOperationStartResult,
  type WalletInterfaceOperations,
} from "../../src/wallet/contracts.js";
import { walletInterfaceErrorMappings } from "../../src/wallet/errors.js";
import { bindForHarness, createCapabilityHarness } from "../core/capability-harness.js";

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
    expiresAt: "2026-07-15T06:00:00.000Z",
    result: null,
    failure: null,
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
    const routes = createRuntimeRouteRegistry({
      controlVerifier: createControlCredentialVerifier(controlCredential),
      errorMappings: walletInterfaceErrorMappings,
    });
    const walletManifest = extendWalletSupportManifest(initialRuntimeSupportManifest);
    const chainManifest = extendChainSupportManifest(walletManifest);
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
      routes,
      signal: new AbortController().signal,
      startupResources: createResourceOwnershipScope().resources,
      supportManifest: chainManifest,
      walletConnection: ports.wallet,
      walletOperations: walletOperations(),
      chainReads: ports.chain,
    });

    for (const [method, path] of [
      ["GET", "/api/v1/chain-status"],
      ["GET", "/api/v1/wallet/connection"],
      ["GET", "/api/v1/capabilities"],
      ["GET", "/"],
      ["POST", "/api/v1/wallet/operations"],
      ["GET", "/api/v1/wallet/current-operation"],
      ["GET", `/api/v1/wallet/operations/${operationId}`],
      ["POST", `/api/v1/wallet/operations/${operationId}/confirmation`],
      ["POST", `/api/v1/wallet/operations/${operationId}/cancellation`],
    ] as const) expect(application.routes.match(method, path).status).toBe("matched");
    expect(application.routes.match("GET", "/wallet").status)
      .toBe("not_found");

    const supportSnapshot = readRuntimeSupportManifest(application.supportManifest);
    const availability = new Map<string, typeof supportSnapshot.capabilities[number]["availability"]>(
      supportSnapshot.capabilities.map((entry) => [entry.capabilityId, entry.availability]),
    );
    for (const capabilityId of [
      "account.balance", "chain.status", "contract.inspect", "transaction.inspect",
    ]) expect(availability.get(capabilityId)).toEqual({
      overall: "available", direct: "internal", http: "available",
      mcp: "available", cli: "available", web: "unavailable",
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
