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
import {
  LocalRuntime,
  composeOwnerApplicationStages,
  type ChainReadCapabilityPort,
  type WalletConnectionReadCapabilityPort,
} from "../../src/runtime/composition.js";
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
  initialRuntimeSupportManifest,
} from "../../src/runtime/support-manifest.js";
import { bindForHarness, createCapabilityHarness } from "../core/capability-harness.js";

const directories: string[] = [];

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
  const interfaces = extendInterfaceRuntimeSupportManifest(chain, {
    registrations: [],
    changes: [{
      capabilityId: "chain.status",
      availability: {
        overall: "available", direct: "internal", http: "available",
        mcp: "unavailable", cli: "unavailable", web: "unavailable",
      },
    }],
  });
  return { wallet, chain, interfaces };
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
    const application = await composeOwnerApplicationStages(ownerContext(routes, signal), [
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
          close: () => { events.push("chain:close"); },
        };
      },
      (_context, wallet, chain, operations) => {
        expect(wallet.walletConnection.connection).toBe(ports.wallet.connection);
        expect(chain.chainReads.chainStatus).toBe(ports.chain.chainStatus);
        expect(operations).toBe(walletOperations);
        expect(operations.readOperation()).toBe("test-operation");
        return {
          routes: interfaceRoutes,
          supportManifest: support.interfaces,
          close: () => { events.push("interfaces:close"); },
        };
      },
    ]);
    expect(application.routes).toBe(interfaceRoutes);
    await application.close();
    expect(events).toEqual(["interfaces:close", "chain:close", "wallet:close"]);
  });

  it("keeps stage dependencies alive when a dependent close must be retried", async () => {
    const routes = await baseRoutes();
    const ports = capabilityPorts();
    const support = manifests();
    const events: string[] = [];
    const failure = new Error("interface close failed");
    let interfaceCloseCalls = 0;
    let reentered: Promise<void> | undefined;
    const application = await composeOwnerApplicationStages(
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
          close: () => { events.push("chain:close"); },
        }),
        () => ({
          routes,
          supportManifest: support.interfaces,
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
    expect(events).toEqual(["interfaces:close", "chain:close", "wallet:close"]);
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
    await expect(composeOwnerApplicationStages(ownerContext(routes, signal), [
      () => ({
        routes: walletRoutes,
        supportManifest: support.wallet,
        walletConnection: ports.wallet,
        activeWallet: testActiveWallet(),
        walletOperations: testWalletOperations(),
        close: () => { events.push("wallet:close"); },
      }),
      () => ({
        routes: chainRoutes, supportManifest: wrongChain, chainReads: ports.chain,
        close: () => { events.push("chain:close"); },
      }),
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
    const composition = composeOwnerApplicationStages({
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

    await expect(composeOwnerApplicationStages(ownerContext(routes, new AbortController().signal), [
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
          close: () => { events.push("chain:close"); },
        };
      },
    ])).rejects.toThrow("retained startup resources");
    expect(events).toEqual(["chain:close", "partial-chain:close", "wallet:close"]);
  });

  it("does not close a stage application twice when its factory pre-registers it", async () => {
    const routes = await baseRoutes();
    const ports = capabilityPorts();
    const support = manifests();
    const events: string[] = [];

    await expect(composeOwnerApplicationStages(ownerContext(routes, new AbortController().signal), [
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
          close: () => { events.push("chain:close"); },
        };
        startupResources.register(application);
        return application;
      },
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
    await expect(composeOwnerApplicationStages(ownerContext(routes, new AbortController().signal), [
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
    await expect(composeOwnerApplicationStages(ownerContext(routes, new AbortController().signal), [
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
      await composeOwnerApplicationStages(ownerContext(routes, lifecycle.signal), [
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
          return { routes, supportManifest: support.chain, chainReads: ports.chain, close: () => undefined };
        },
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
      await expect(composeOwnerApplicationStages(ownerContext(routes, new AbortController().signal), [
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
            close: () => undefined,
          };
        },
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
      await expect(composeOwnerApplicationStages(ownerContext(routes, new AbortController().signal), [
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
            close: () => undefined,
          };
        },
      ])).rejects.toThrow("Active wallet read port must be a reference value");
      expect(events).toEqual(["wallet:close"]);
    }
  });
});
