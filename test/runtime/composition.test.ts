import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  accountBalanceCapability,
  chainStatusCapability,
  contractInspectCapability,
  transactionInspectCapability,
  walletConnectionCapability,
} from "../../src/core/index.js";
import { tokenInspectCapability } from "../../src/token-catalog/contracts.js";
import { tokenCatalogErrorRegistry } from "../../src/token-catalog/errors.js";
import { TokenCatalogOperationError } from "../../src/token-catalog/operation-error.js";
import { extendTokenCatalogSupportManifest } from "../../src/token-catalog/support.js";
import type {
  TokenCatalogApplicationPort,
  TokenCatalogBrowserOperationPort,
  TokenCatalogInteractiveCliPort,
  TokenCatalogNonInteractiveOperationPort,
  TokenCatalogOperationCoordinatorPort,
  TokenCatalogQueryApplicationPort,
  TokenCatalogWebStartPort,
} from "../../src/token-catalog/ports.js";
import {
  LocalRuntime,
  composeOwnerApplicationStages,
  createTokenCatalogConsumerPorts,
  type ChainReadCapabilityPort,
  type TokenCatalogOwnerApplicationStage,
  type WalletConnectionReadCapabilityPort,
} from "../../src/runtime/composition.js";
import {
  readRuntimeConfiguration,
} from "../../src/runtime/configuration.js";
import {
  createControlCredentialVerifier,
  loadOrCreateControlCredential,
} from "../../src/runtime/control-credential.js";
import { RuntimeOperationError } from "../../src/runtime/errors.js";
import { createResourceOwnershipScope } from "../../src/runtime/resource-ownership.js";
import { createRuntimeRouteRegistry } from "../../src/runtime/http-routing.js";
import { runtimePaths } from "../../src/runtime/paths.js";
import {
  extendChainRuntimeSupportManifest,
  extendInterfaceRuntimeSupportManifest,
  extendWalletRuntimeSupportManifest,
  createInitialRuntimeSupportManifest,
} from "../../src/runtime/support-manifest.js";
import { bindForHarness, createCapabilityHarness } from "../core/capability-harness.js";

const directories: string[] = [];
const initialRuntimeSupportManifest = createInitialRuntimeSupportManifest(
  readRuntimeConfiguration({}).chain,
);

const internalFailure = new TokenCatalogOperationError("internal_error").failure;

const testTokenCatalog: TokenCatalogApplicationPort = Object.freeze({
  getRegistration: () => internalFailure,
  listRegistrations: () => internalFailure,
  startRegistration: async () => internalFailure,
  startRegistrationUpdate: async () => internalFailure,
  startUnregistration: async () => internalFailure,
  getOperation: () => internalFailure,
  cancelOperation: async () => internalFailure,
});

const unavailableOperation = (): never => { throw new Error("Token catalog operation is unavailable in this fixture."); };
const testTokenCatalogOperations: TokenCatalogOperationCoordinatorPort = Object.freeze({
  startRegistration: async () => internalFailure,
  startRegistrationUpdate: async () => internalFailure,
  startUnregistration: async () => internalFailure,
  getOperation: unavailableOperation,
  getCurrentOperation: () => null,
  confirm: async () => unavailableOperation(),
  cancel: async () => unavailableOperation(),
});

const testTokenCatalogQueries = Object.freeze({
  getRegistration: testTokenCatalog.getRegistration,
  listRegistrations: testTokenCatalog.listRegistrations,
}) satisfies TokenCatalogQueryApplicationPort;
const testTokenCatalogWebStart = Object.freeze({
  interactionInterface: "web",
  startRegistration: (input: Parameters<TokenCatalogApplicationPort["startRegistration"]>[0]) =>
    testTokenCatalog.startRegistration(input, "web"),
  startRegistrationUpdate: (input: Parameters<TokenCatalogApplicationPort["startRegistrationUpdate"]>[0]) =>
    testTokenCatalog.startRegistrationUpdate(input, "web"),
  startUnregistration: (input: Parameters<TokenCatalogApplicationPort["startUnregistration"]>[0]) =>
    testTokenCatalog.startUnregistration(input, "web"),
}) satisfies TokenCatalogWebStartPort;
const testTokenCatalogBrowserOperations = Object.freeze({
  interactionInterface: "web",
  getOperation: testTokenCatalog.getOperation,
  getCurrentOperation: testTokenCatalogOperations.getCurrentOperation,
  confirm: (input: Parameters<TokenCatalogBrowserOperationPort["confirm"]>[0]) =>
    testTokenCatalogOperations.confirm("web", input),
  cancel: (operationId: Parameters<TokenCatalogBrowserOperationPort["cancel"]>[0]) =>
    testTokenCatalogOperations.cancel(operationId, "web"),
}) satisfies TokenCatalogBrowserOperationPort;
const testTokenCatalogInteractiveCli = Object.freeze({
  interactionInterface: "cli",
  startRegistration: (input: Parameters<TokenCatalogApplicationPort["startRegistration"]>[0]) =>
    testTokenCatalog.startRegistration(input, "cli"),
  startRegistrationUpdate: (input: Parameters<TokenCatalogApplicationPort["startRegistrationUpdate"]>[0]) =>
    testTokenCatalog.startRegistrationUpdate(input, "cli"),
  startUnregistration: (input: Parameters<TokenCatalogApplicationPort["startUnregistration"]>[0]) =>
    testTokenCatalog.startUnregistration(input, "cli"),
  confirm: (input: Parameters<TokenCatalogInteractiveCliPort["confirm"]>[0]) =>
    testTokenCatalogOperations.confirm("cli", input),
}) satisfies TokenCatalogInteractiveCliPort;
const testTokenCatalogNonInteractiveOperations = Object.freeze({
  getOperation: testTokenCatalog.getOperation,
  cancelOperation: testTokenCatalog.cancelOperation,
}) satisfies TokenCatalogNonInteractiveOperationPort;

const testTokenInspection = () => bindForHarness(
  tokenInspectCapability,
  createCapabilityHarness(),
  async () => ({ status: "failure", code: "internal_error", issues: [] }),
  tokenCatalogErrorRegistry,
);

const createTestTokenCatalogStage = <ActiveWallet extends object>(
  close: () => void = () => undefined,
): TokenCatalogOwnerApplicationStage<ActiveWallet> => ({ routes }, _wallet, chain) => ({
  routes,
  supportManifest: extendTokenCatalogSupportManifest(chain.supportManifest),
  tokenCatalogQueries: testTokenCatalogQueries,
  tokenCatalogWebStart: testTokenCatalogWebStart,
  tokenCatalogBrowserOperations: testTokenCatalogBrowserOperations,
  tokenCatalogInteractiveCli: testTokenCatalogInteractiveCli,
  tokenCatalogNonInteractiveOperations: testTokenCatalogNonInteractiveOperations,
  close,
});

const extendTestInterfaceSupportManifest = (
  parent: Parameters<typeof extendInterfaceRuntimeSupportManifest>[0],
) => extendInterfaceRuntimeSupportManifest(parent, {
  registrations: [],
  changes: [{
    capabilityId: "chain.status",
    availability: {
      overall: "available", direct: "internal", http: "available",
      mcp: "unavailable", cli: "unavailable", web: "unavailable",
    },
  }],
});

const composeStages = <
  ActiveWallet extends object,
  WalletOperations extends object,
>(
  context: Parameters<typeof composeOwnerApplicationStages<ActiveWallet, WalletOperations>>[0],
  stages: Parameters<typeof composeOwnerApplicationStages<ActiveWallet, WalletOperations>>[2],
) => composeOwnerApplicationStages(context, initialRuntimeSupportManifest, stages);

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const baseRoutes = async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "littlejohn-composition-"));
  directories.push(directory);
  const paths = runtimePaths(directory);
  const authority = await loadOrCreateControlCredential(directory, paths.controlCredential);
  return createRuntimeRouteRegistry({ controlVerifier: createControlCredentialVerifier(authority) });
};

const route = (pathPattern: string) => ({
  method: "GET" as const,
  pathPattern,
  mutation: "none" as const,
  response: "canonical_json" as const, successStatus: 200 as const,
  handler: async () => ({ ok: true as const, body: {} }),
});

const ownerContext = (
  routes: Awaited<ReturnType<typeof baseRoutes>>,
  signal: AbortSignal,
) => ({
  routes,
  signal,
  startupResources: createResourceOwnershipScope().resources,
});

interface TestWalletOperations {
  readOperation(): "test-operation";
}

interface TestActiveWallet {
  capture(): "test-wallet";
}

const testWalletOperations = (): TestWalletOperations => Object.freeze({
  readOperation: () => "test-operation" as const,
});

const testActiveWallet = (): TestActiveWallet => Object.freeze({
  capture: () => "test-wallet" as const,
});

const capabilityPorts = (): {
  readonly wallet: WalletConnectionReadCapabilityPort;
  readonly chain: ChainReadCapabilityPort;
} => {
  const harness = createCapabilityHarness();
  const failure = async () => ({ status: "failure", code: "internal_error", issues: [] });
  return {
    wallet: {
      connection: bindForHarness(walletConnectionCapability, harness, failure),
    },
    chain: {
      accountBalance: bindForHarness(accountBalanceCapability, harness, failure),
      chainStatus: bindForHarness(chainStatusCapability, harness, failure),
      contractInspect: bindForHarness(contractInspectCapability, harness, failure),
      transactionInspect: bindForHarness(transactionInspectCapability, harness, failure),
    },
  };
};

const manifests = () => {
  const wallet = extendWalletRuntimeSupportManifest(initialRuntimeSupportManifest, {
    registrations: [],
    changes: [{
      capabilityId: "wallet.connection",
      availability: {
        overall: "internal", direct: "internal", http: "unavailable",
        mcp: "unavailable", cli: "unavailable", web: "unavailable",
      },
    }],
  });
  const chain = extendChainRuntimeSupportManifest(wallet, {
    registrations: [],
    changes: ["account.balance", "chain.status", "contract.inspect", "transaction.inspect"].map((capabilityId) => ({
      capabilityId,
      availability: {
        overall: "internal", direct: "internal", http: "unavailable",
        mcp: "unavailable", cli: "unavailable", web: "unavailable",
      },
    })),
  });
  return { wallet, chain };
};

describe("owner application composition", () => {
  it("preserves shutdown dependencies and retries only resources not proven closed", async () => {
    for (const failingResource of ["application", "database", "server"] as const) {
      const events: string[] = [];
      const secret = `secret-${failingResource}-close-payload`;
      let failureAvailable = true;
      const permit = Object.freeze({ resource: failingResource });
      const database = {
        close(): void {
          events.push("database:close");
          if (failingResource === "database" && failureAvailable) {
            failureAvailable = false;
            throw new Error(secret);
          }
        },
      };
      const owner = {
        async start(): Promise<void> { events.push("owner:start"); },
        async closeApplication(): Promise<object> {
          events.push("owner:prepare");
          if (failingResource === "application" && failureAvailable) {
            failureAvailable = false;
            throw new Error(secret);
          }
          return permit;
        },
        async releaseListener(input: object): Promise<void> {
          expect(input).toBe(permit);
          events.push("owner:release");
          if (failingResource === "server" && failureAvailable) {
            failureAvailable = false;
            throw new Error(secret);
          }
        },
      };
      const runtime = Reflect.construct(LocalRuntime, [database, () => owner]) as LocalRuntime;
      await runtime.start();
      events.length = 0;
      let failure: unknown;
      try { await runtime.stop(); }
      catch (error) { failure = error; }
      expect(events).toEqual(failingResource === "application"
        ? ["owner:prepare"]
        : failingResource === "database"
          ? ["owner:prepare", "database:close"]
          : ["owner:prepare", "database:close", "owner:release"]);
      expect(failure).toBeInstanceOf(RuntimeOperationError);
      expect((failure as RuntimeOperationError).failure.error.code).toBe("internal_error");
      expect((failure as Error).message).not.toContain(secret);
      expect((failure as Error).cause).toBeUndefined();
      expect(JSON.stringify(failure)).not.toContain(secret);

      events.length = 0;
      await expect(runtime.stop()).resolves.toBeUndefined();
      expect(events).toEqual(failingResource === "server"
        ? ["owner:prepare", "owner:release"]
        : ["owner:prepare", "database:close", "owner:release"]);
    }
  });

  it("installs one runtime stop authority before owner abort can reenter it", async () => {
    const events: string[] = [];
    let runtime!: LocalRuntime;
    let reentered: Promise<void> | undefined;
    const database = {
      close(): void { events.push("database:close"); },
    };
    const permit = Object.freeze({ permit: true });
    const owner = {
      state: "owner" as const,
      async start(): Promise<void> { events.push("owner:start"); },
      async closeApplication(): Promise<object> {
        events.push("owner:prepare");
        reentered = runtime.stop();
        return permit;
      },
      async releaseListener(input: object): Promise<void> {
        expect(input).toBe(permit);
        events.push("owner:release");
      },
    };
    runtime = Reflect.construct(LocalRuntime, [database, () => owner]) as LocalRuntime;
    await runtime.start();

    const stopping = runtime.stop();
    await stopping;
    expect(reentered).toBe(stopping);
    expect(events).toEqual(["owner:start", "owner:prepare", "database:close", "owner:release"]);
  });

  it("returns cleanup authority before fallible owner construction and forbids restart after stop", async () => {
    const constructionFailure = new Error("owner construction failed");
    let databaseCloses = 0;
    const runtime = Reflect.construct(LocalRuntime, [{
      close(): void { databaseCloses += 1; },
    }, () => { throw constructionFailure; }]) as LocalRuntime;

    await expect(runtime.start()).rejects.toMatchObject({
      failure: { error: { code: "internal_error" } },
    });
    await runtime.stop();
    expect(databaseCloses).toBe(1);
    await expect(runtime.start()).rejects.toMatchObject({
      failure: { error: { code: "state_conflict" } },
    });
  });

  it("hands typed outputs forward and closes dependency stages in reverse order", async () => {
    const routes = await baseRoutes();
    const signal = new AbortController().signal;
    const events: string[] = [];
    const ports = capabilityPorts();
    const support = manifests();
    const activeWallet = testActiveWallet();
    const walletOperations = testWalletOperations();
    const walletRoutes = routes.extend([route("/api/v1/internal/control/wallet")]);
    const chainRoutes = walletRoutes.extend([route("/api/v1/internal/control/chain")]);
    const interfaceRoutes = chainRoutes.extend([route("/api/v1/internal/control/interfaces")]);
    const application = await composeStages(ownerContext(routes, signal), [
      () => ({
        routes: walletRoutes,
        supportManifest: support.wallet,
        walletConnection: ports.wallet,
        activeWallet,
        walletOperations,
        close: () => { events.push("wallet:close"); },
      }),
      (_context, wallet) => {
        expect(wallet.walletConnection.connection).toBe(ports.wallet.connection);
        expect(wallet.activeWallet).toBe(activeWallet);
        expect("walletOperations" in wallet).toBe(false);
        return {
          routes: chainRoutes,
          supportManifest: support.chain,
          chainReads: ports.chain,
          tokenInspection: testTokenInspection(),
          close: () => { events.push("chain:close"); },
        };
      },
      createTestTokenCatalogStage(() => { events.push("catalog:close"); }),
      (_context, wallet, chain, catalog, operations) => {
        expect(wallet.walletConnection.connection).toBe(ports.wallet.connection);
        expect(chain.chainReads.chainStatus).toBe(ports.chain.chainStatus);
        expect(chain.tokenInspection).toBeDefined();
        expect(Reflect.ownKeys(catalog).sort()).toEqual([
          "supportManifest",
          "tokenCatalogBrowserOperations",
          "tokenCatalogInteractiveCli",
          "tokenCatalogNonInteractiveOperations",
          "tokenCatalogQueries",
          "tokenCatalogWebStart",
        ].sort());
        expect(Reflect.ownKeys(catalog.tokenCatalogQueries).sort())
          .toEqual(["getRegistration", "listRegistrations"]);
        expect(Reflect.ownKeys(catalog.tokenCatalogWebStart).sort()).toEqual([
          "interactionInterface", "startRegistration", "startRegistrationUpdate", "startUnregistration",
        ].sort());
        expect(Reflect.ownKeys(catalog.tokenCatalogBrowserOperations).sort()).toEqual([
          "cancel", "confirm", "getCurrentOperation", "getOperation", "interactionInterface",
        ].sort());
        expect(Reflect.ownKeys(catalog.tokenCatalogInteractiveCli).sort()).toEqual([
          "confirm", "interactionInterface", "startRegistration", "startRegistrationUpdate", "startUnregistration",
        ].sort());
        expect(Reflect.ownKeys(catalog.tokenCatalogNonInteractiveOperations).sort())
          .toEqual(["cancelOperation", "getOperation"]);
        expect(operations).toBe(walletOperations);
        expect(operations.readOperation()).toBe("test-operation");
        return {
          routes: interfaceRoutes,
          supportManifest: extendTestInterfaceSupportManifest(catalog.supportManifest),
          close: () => { events.push("interfaces:close"); },
        };
      },
    ]);
    expect(application.routes).toBe(interfaceRoutes);
    await application.close();
    expect(events).toEqual(["interfaces:close", "catalog:close", "chain:close", "wallet:close"]);
  });

  it("rejects catalog handoffs whose interaction authority is not fixed by the port", async () => {
    const routes = await baseRoutes();
    const ports = capabilityPorts();
    const support = manifests();
    for (const invalidPort of ["webStart", "browser", "cli"] as const) {
      const events: string[] = [];
      await expect(composeStages(ownerContext(routes, new AbortController().signal), [
        () => ({
          routes,
          supportManifest: support.wallet,
          walletConnection: ports.wallet,
          activeWallet: testActiveWallet(),
          walletOperations: testWalletOperations(),
          close: () => { events.push("wallet:close"); },
        }),
        () => ({
          routes,
          supportManifest: support.chain,
          chainReads: ports.chain,
          tokenInspection: testTokenInspection(),
          close: () => { events.push("chain:close"); },
        }),
        ({ routes: catalogRoutes }, _wallet, chain) => ({
          routes: catalogRoutes,
          supportManifest: extendTokenCatalogSupportManifest(chain.supportManifest),
          tokenCatalogQueries: testTokenCatalogQueries,
          tokenCatalogWebStart: invalidPort === "webStart"
            ? { ...testTokenCatalogWebStart, interactionInterface: "cli" as never }
            : testTokenCatalogWebStart,
          tokenCatalogBrowserOperations: invalidPort === "browser"
            ? { ...testTokenCatalogBrowserOperations, interactionInterface: "cli" as never }
            : testTokenCatalogBrowserOperations,
          tokenCatalogInteractiveCli: invalidPort === "cli"
            ? { ...testTokenCatalogInteractiveCli, interactionInterface: "web" as never }
            : testTokenCatalogInteractiveCli,
          tokenCatalogNonInteractiveOperations: testTokenCatalogNonInteractiveOperations,
          close: () => { events.push("catalog:close"); },
        }),
      ])).rejects.toThrow("authority is invalid");
      expect(events).toEqual(["catalog:close", "chain:close", "wallet:close"]);
    }
  });

  it("delegates every catalog consumer port through its fixed authority", async () => {
    const routes = await baseRoutes();
    const ports = capabilityPorts();
    const support = manifests();
    const calls: string[] = [];
    const operationFailure = new Error("operation fixture");
    const request = Object.freeze({}) as never;
    const operationId = "operation" as never;
    const confirmation = Object.freeze({ operationId, reviewDigest: "digest" as never });
    const application = Object.freeze({
      getRegistration: (input: Parameters<TokenCatalogApplicationPort["getRegistration"]>[0]) => {
        expect(input).toBe(request); calls.push("query:get"); return internalFailure;
      },
      listRegistrations: (input: Parameters<TokenCatalogApplicationPort["listRegistrations"]>[0]) => {
        expect(input).toBe(request); calls.push("query:list"); return internalFailure;
      },
      startRegistration: async (
        input: Parameters<TokenCatalogApplicationPort["startRegistration"]>[0],
        authority: Parameters<TokenCatalogApplicationPort["startRegistration"]>[1],
      ) => {
        expect(input).toBe(request); calls.push(`start:register:${authority}`); return internalFailure;
      },
      startRegistrationUpdate: async (
        input: Parameters<TokenCatalogApplicationPort["startRegistrationUpdate"]>[0],
        authority: Parameters<TokenCatalogApplicationPort["startRegistrationUpdate"]>[1],
      ) => {
        expect(input).toBe(request); calls.push(`start:update:${authority}`); return internalFailure;
      },
      startUnregistration: async (
        input: Parameters<TokenCatalogApplicationPort["startUnregistration"]>[0],
        authority: Parameters<TokenCatalogApplicationPort["startUnregistration"]>[1],
      ) => {
        expect(input).toBe(request); calls.push(`start:unregister:${authority}`); return internalFailure;
      },
      getOperation: (input: Parameters<TokenCatalogApplicationPort["getOperation"]>[0]) => {
        expect(input).toBe(request); calls.push("operation:get"); return internalFailure;
      },
      cancelOperation: async (input: Parameters<TokenCatalogApplicationPort["cancelOperation"]>[0]) => {
        expect(input).toBe(request); calls.push("operation:cancel"); return internalFailure;
      },
    } satisfies TokenCatalogApplicationPort);
    const coordinator = Object.freeze({
      startRegistration: async () => internalFailure,
      startRegistrationUpdate: async () => internalFailure,
      startUnregistration: async () => internalFailure,
      getOperation: () => { throw operationFailure; },
      getCurrentOperation: () => { calls.push("browser:current"); return null; },
      confirm: async (interactionInterface, input) => {
        expect(input.operationId).toBe(operationId);
        expect(input.reviewDigest).toBe(confirmation.reviewDigest);
        calls.push(`confirm:${interactionInterface}`);
        throw operationFailure;
      },
      cancel: async (inputOperationId, authority) => {
        expect(inputOperationId).toBe(operationId);
        calls.push(`cancel:${authority ?? "none"}`);
        throw operationFailure;
      },
    } satisfies TokenCatalogOperationCoordinatorPort);
    const consumerPorts = createTokenCatalogConsumerPorts(application, coordinator);
    const composed = await composeStages(ownerContext(routes, new AbortController().signal), [
      () => ({
        routes,
        supportManifest: support.wallet,
        walletConnection: ports.wallet,
        activeWallet: testActiveWallet(),
        walletOperations: testWalletOperations(),
        close: () => undefined,
      }),
      () => ({
        routes,
        supportManifest: support.chain,
        chainReads: ports.chain,
        tokenInspection: testTokenInspection(),
        close: () => undefined,
      }),
      ({ routes: catalogRoutes }, _wallet, chain) => ({
        routes: catalogRoutes,
        supportManifest: extendTokenCatalogSupportManifest(chain.supportManifest),
        ...consumerPorts,
        close: () => undefined,
      }),
      async (_context, _wallet, _chain, catalog) => {
        catalog.tokenCatalogQueries.getRegistration(request);
        catalog.tokenCatalogQueries.listRegistrations(request);
        await catalog.tokenCatalogWebStart.startRegistration(request);
        await catalog.tokenCatalogWebStart.startRegistrationUpdate(request);
        await catalog.tokenCatalogWebStart.startUnregistration(request);
        await catalog.tokenCatalogInteractiveCli.startRegistration(request);
        await catalog.tokenCatalogInteractiveCli.startRegistrationUpdate(request);
        await catalog.tokenCatalogInteractiveCli.startUnregistration(request);
        catalog.tokenCatalogBrowserOperations.getOperation(request);
        catalog.tokenCatalogBrowserOperations.getCurrentOperation();
        await expect(catalog.tokenCatalogBrowserOperations.confirm(confirmation)).rejects.toBe(operationFailure);
        await expect(catalog.tokenCatalogBrowserOperations.cancel(operationId)).rejects.toBe(operationFailure);
        await expect(catalog.tokenCatalogInteractiveCli.confirm(confirmation)).rejects.toBe(operationFailure);
        catalog.tokenCatalogNonInteractiveOperations.getOperation(request);
        await catalog.tokenCatalogNonInteractiveOperations.cancelOperation(request);
        return {
          routes,
          supportManifest: extendTestInterfaceSupportManifest(catalog.supportManifest),
          close: () => undefined,
        };
      },
    ]);
    await composed.close();
    expect(calls).toEqual([
      "query:get",
      "query:list",
      "start:register:web",
      "start:update:web",
      "start:unregister:web",
      "start:register:cli",
      "start:update:cli",
      "start:unregister:cli",
      "operation:get",
      "browser:current",
      "confirm:web",
      "cancel:web",
      "confirm:cli",
      "operation:get",
      "operation:cancel",
    ]);
  });

  it("keeps stage dependencies alive when a dependent close must be retried", async () => {
    const routes = await baseRoutes();
    const ports = capabilityPorts();
    const support = manifests();
    const events: string[] = [];
    const failure = new Error("interface close failed");
    let interfaceCloseCalls = 0;
    let reentered: Promise<void> | undefined;
    const application = await composeStages(
      ownerContext(routes, new AbortController().signal),
      [
        () => ({
          routes,
          supportManifest: support.wallet,
          walletConnection: ports.wallet,
          activeWallet: testActiveWallet(),
          walletOperations: testWalletOperations(),
          close: () => { events.push("wallet:close"); },
        }),
        () => ({
          routes,
          supportManifest: support.chain,
          chainReads: ports.chain,
          tokenInspection: testTokenInspection(),
          close: () => { events.push("chain:close"); },
        }),
        createTestTokenCatalogStage(() => { events.push("catalog:close"); }),
        (_context, _wallet, _chain, catalog) => ({
          routes,
          supportManifest: extendTestInterfaceSupportManifest(catalog.supportManifest),
          close: () => {
            events.push("interfaces:close");
            interfaceCloseCalls += 1;
            if (interfaceCloseCalls === 1) reentered = application.close() as Promise<void>;
            if (interfaceCloseCalls === 1) throw failure;
          },
        }),
      ],
    );

    const first = application.close() as Promise<void>;
    await expect(first).rejects.toBe(failure);
    expect(reentered).toBe(first);
    expect(events).toEqual(["interfaces:close"]);
    events.length = 0;
    await application.close();
    expect(events).toEqual(["interfaces:close", "catalog:close", "chain:close", "wallet:close"]);
    events.length = 0;
    await application.close();
    expect(events).toEqual([]);
  });

  it("closes the invalid scoped child and completed dependencies", async () => {
    const routes = await baseRoutes();
    const signal = new AbortController().signal;
    const events: string[] = [];
    const ports = capabilityPorts();
    const support = manifests();
    const walletRoutes = routes.extend([route("/api/v1/internal/control/wallet")]);
    const chainRoutes = walletRoutes.extend([route("/api/v1/internal/control/chain")]);
    const siblingWallet = extendWalletRuntimeSupportManifest(initialRuntimeSupportManifest, {
      registrations: [],
      changes: [{
        capabilityId: "wallet.connection",
        availability: {
          overall: "internal", direct: "internal", http: "unavailable",
          mcp: "unavailable", cli: "unavailable", web: "unavailable",
        },
      }],
    });
    const wrongChain = extendChainRuntimeSupportManifest(siblingWallet, {
      registrations: [],
      changes: ["account.balance", "chain.status", "contract.inspect", "transaction.inspect"].map((capabilityId) => ({
        capabilityId,
        availability: {
          overall: "internal", direct: "internal", http: "unavailable",
          mcp: "unavailable", cli: "unavailable", web: "unavailable",
        },
      })),
    });
    await expect(composeStages(ownerContext(routes, signal), [
      () => ({
        routes: walletRoutes,
        supportManifest: support.wallet,
        walletConnection: ports.wallet,
        activeWallet: testActiveWallet(),
        walletOperations: testWalletOperations(),
        close: () => { events.push("wallet:close"); },
      }),
      () => ({
        routes: chainRoutes,
        supportManifest: wrongChain,
        chainReads: ports.chain,
        tokenInspection: testTokenInspection(),
        close: () => { events.push("chain:close"); },
      }),
      createTestTokenCatalogStage(),
    ])).rejects.toThrow("scope lineage");
    expect(events).toEqual(["chain:close", "wallet:close"]);
  });

  it("closes a partial dependent stage before completed dependency stages", async () => {
    const routes = await baseRoutes();
    const ports = capabilityPorts();
    const support = manifests();
    const outer = createResourceOwnershipScope();
    const events: string[] = [];
    let partialCloseCalls = 0;
    const stageFailure = new Error("chain stage failed");
    const composition = composeStages({
      routes,
      signal: new AbortController().signal,
      startupResources: outer.resources,
    }, [
      () => ({
        routes,
        supportManifest: support.wallet,
        walletConnection: ports.wallet,
        activeWallet: testActiveWallet(),
        walletOperations: testWalletOperations(),
        close: () => { events.push("wallet:close"); },
      }),
      ({ startupResources }) => {
        startupResources.register({
          close(): void {
            events.push("partial-chain:close");
            partialCloseCalls += 1;
            if (partialCloseCalls === 1) throw new Error("partial cleanup failed");
          },
        });
        throw stageFailure;
      },
      createTestTokenCatalogStage(),
    ]);

    await expect(composition).rejects.toBe(stageFailure);
    expect(events).toEqual(["partial-chain:close"]);
    outer.seal();
    await outer.close();
    expect(events).toEqual([
      "partial-chain:close",
      "partial-chain:close",
      "wallet:close",
    ]);
  });

  it("rejects a completed stage that retains startup ownership and closes it before dependencies", async () => {
    const routes = await baseRoutes();
    const ports = capabilityPorts();
    const support = manifests();
    const events: string[] = [];

    await expect(composeStages(ownerContext(routes, new AbortController().signal), [
      () => ({
        routes,
        supportManifest: support.wallet,
        walletConnection: ports.wallet,
        activeWallet: testActiveWallet(),
        walletOperations: testWalletOperations(),
        close: () => { events.push("wallet:close"); },
      }),
      ({ startupResources }) => {
        startupResources.register({ close(): void { events.push("partial-chain:close"); } });
        return {
          routes,
          supportManifest: support.chain,
          chainReads: ports.chain,
          tokenInspection: testTokenInspection(),
          close: () => { events.push("chain:close"); },
        };
      },
      createTestTokenCatalogStage(),
    ])).rejects.toThrow("retained startup resources");
    expect(events).toEqual(["chain:close", "partial-chain:close", "wallet:close"]);
  });

  it("does not close a stage application twice when its factory pre-registers it", async () => {
    const routes = await baseRoutes();
    const ports = capabilityPorts();
    const support = manifests();
    const events: string[] = [];

    await expect(composeStages(ownerContext(routes, new AbortController().signal), [
      () => ({
        routes,
        supportManifest: support.wallet,
        walletConnection: ports.wallet,
        activeWallet: testActiveWallet(),
        walletOperations: testWalletOperations(),
        close: () => { events.push("wallet:close"); },
      }),
      ({ startupResources }) => {
        const application = {
          routes,
          supportManifest: support.chain,
          chainReads: ports.chain,
          tokenInspection: bindForHarness(
            tokenInspectCapability,
            createCapabilityHarness(),
            async () => ({ status: "failure", code: "internal_error", issues: [] }),
            tokenCatalogErrorRegistry,
          ),
          close: () => { events.push("chain:close"); },
        };
        startupResources.register(application);
        return application;
      },
      createTestTokenCatalogStage(),
    ])).rejects.toThrow("already registered");
    expect(events).toEqual(["chain:close", "wallet:close"]);
  });

  it("rejects a manifest that omits its typed capability output", async () => {
    const routes = await baseRoutes();
    const ports = capabilityPorts();
    const wrongWallet = extendWalletRuntimeSupportManifest(initialRuntimeSupportManifest, {
      registrations: [{
        capabilityId: "wallet.connect",
        availability: {
          overall: "internal", direct: "internal", http: "unavailable",
          mcp: "unavailable", cli: "unavailable", web: "unavailable",
        },
      }],
      changes: [],
    });
    let closed = false;
    await expect(composeStages(ownerContext(routes, new AbortController().signal), [
      () => ({
        routes,
        supportManifest: wrongWallet,
        walletConnection: ports.wallet,
        activeWallet: testActiveWallet(),
        walletOperations: testWalletOperations(),
        close: () => { closed = true; },
      }),
    ])).rejects.toThrow("absent from its support manifest");
    expect(closed).toBe(true);
  });

  it("rejects a binding placed under a different capability port", async () => {
    const routes = await baseRoutes();
    const ports = capabilityPorts();
    const support = manifests();
    let closed = false;
    await expect(composeStages(ownerContext(routes, new AbortController().signal), [
      () => ({
        routes,
        supportManifest: support.wallet,
        walletConnection: { connection: ports.chain.chainStatus as never },
        activeWallet: testActiveWallet(),
        walletOperations: testWalletOperations(),
        close: () => { closed = true; },
      }),
    ])).rejects.toThrow("provenance");
    expect(closed).toBe(true);
  });

  it("stops before the next stage and closes the completed stage after lifecycle abort", async () => {
    const routes = await baseRoutes();
    const lifecycle = new AbortController();
    const events: string[] = [];
    const ports = capabilityPorts();
    const support = manifests();
    let failure: unknown;
    try {
      await composeStages(ownerContext(routes, lifecycle.signal), [
        () => {
          lifecycle.abort();
          return {
            routes,
            supportManifest: support.wallet,
            walletConnection: ports.wallet,
            activeWallet: testActiveWallet(),
            walletOperations: testWalletOperations(),
            close: () => { events.push("wallet:close"); },
          };
        },
        () => {
          events.push("chain:start");
          return {
            routes,
            supportManifest: support.chain,
            chainReads: ports.chain,
            tokenInspection: testTokenInspection(),
            close: () => undefined,
          };
        },
        createTestTokenCatalogStage(),
      ]);
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(RuntimeOperationError);
    expect((failure as RuntimeOperationError).failure.error.code).toBe("request_aborted");
    expect(events).toEqual(["wallet:close"]);
  });

  it("rejects an absent or primitive wallet operation port before starting a dependent stage", async () => {
    const routes = await baseRoutes();
    const ports = capabilityPorts();
    const support = manifests();
    for (const invalid of [undefined, null, "operation", 1]) {
      const events: string[] = [];
      await expect(composeStages(ownerContext(routes, new AbortController().signal), [
        () => ({
          routes,
          supportManifest: support.wallet,
          walletConnection: ports.wallet,
          activeWallet: testActiveWallet(),
          walletOperations: invalid as never,
          close: () => { events.push("wallet:close"); },
        }),
        () => {
          events.push("chain:start");
          return {
            routes,
            supportManifest: support.chain,
            chainReads: ports.chain,
            tokenInspection: testTokenInspection(),
            close: () => undefined,
          };
        },
        createTestTokenCatalogStage(),
      ])).rejects.toThrow("Wallet operation port must be a reference value");
      expect(events).toEqual(["wallet:close"]);
    }
  });

  it("rejects an absent or primitive active-wallet port before starting a dependent stage", async () => {
    const routes = await baseRoutes();
    const ports = capabilityPorts();
    const support = manifests();
    for (const invalid of [undefined, null, "wallet", 1]) {
      const events: string[] = [];
      await expect(composeStages(ownerContext(routes, new AbortController().signal), [
        () => ({
          routes,
          supportManifest: support.wallet,
          walletConnection: ports.wallet,
          activeWallet: invalid as never,
          walletOperations: testWalletOperations(),
          close: () => { events.push("wallet:close"); },
        }),
        () => {
          events.push("chain:start");
          return {
            routes,
            supportManifest: support.chain,
            chainReads: ports.chain,
            tokenInspection: testTokenInspection(),
            close: () => undefined,
          };
        },
        createTestTokenCatalogStage(),
      ])).rejects.toThrow("Active wallet read port must be a reference value");
      expect(events).toEqual(["wallet:close"]);
    }
  });
});
