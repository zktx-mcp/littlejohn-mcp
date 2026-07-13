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
  it("completes both shutdown paths and exposes only a normalized public failure", async () => {
    for (const failingResource of ["owner", "database"] as const) {
      const events: string[] = [];
      const secret = `secret-${failingResource}-close-payload`;
      const database = {
        close(): void {
          events.push("database:close");
          if (failingResource === "database") throw new Error(secret);
        },
      };
      const owner = {
        async stop(): Promise<void> {
          events.push("owner:stop");
          if (failingResource === "owner") throw new Error(secret);
        },
      };
      const runtime = Reflect.construct(LocalRuntime, [database, owner]) as LocalRuntime;
      let failure: unknown;
      try { await runtime.stop(); }
      catch (error) { failure = error; }
      expect(events).toEqual(["owner:stop", "database:close"]);
      expect(failure).toBeInstanceOf(RuntimeOperationError);
      expect((failure as RuntimeOperationError).failure.error.code).toBe("internal_error");
      expect((failure as Error).message).not.toContain(secret);
      expect((failure as Error).cause).toBeUndefined();
      expect(JSON.stringify(failure)).not.toContain(secret);
    }
  });

  it("hands typed outputs forward and closes dependency stages in reverse order", async () => {
    const routes = await baseRoutes();
    const signal = new AbortController().signal;
    const events: string[] = [];
    const ports = capabilityPorts();
    const support = manifests();
    const walletRoutes = routes.extend([route("/api/v1/internal/control/wallet")]);
    const chainRoutes = walletRoutes.extend([route("/api/v1/internal/control/chain")]);
    const interfaceRoutes = chainRoutes.extend([route("/api/v1/internal/control/interfaces")]);
    const application = await composeOwnerApplicationStages({ routes, signal }, [
      () => ({
        routes: walletRoutes,
        supportManifest: support.wallet,
        walletConnection: ports.wallet,
        close: () => { events.push("wallet:close"); },
      }),
      (_context, wallet) => {
        expect(wallet.walletConnection.connection).toBe(ports.wallet.connection);
        return {
          routes: chainRoutes,
          supportManifest: support.chain,
          chainReads: ports.chain,
          close: () => { events.push("chain:close"); },
        };
      },
      (_context, wallet, chain) => {
        expect(wallet.walletConnection.connection).toBe(ports.wallet.connection);
        expect(chain.chainReads.chainStatus).toBe(ports.chain.chainStatus);
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
    await expect(composeOwnerApplicationStages({ routes, signal }, [
      () => ({
        routes: walletRoutes, supportManifest: support.wallet, walletConnection: ports.wallet,
        close: () => { events.push("wallet:close"); },
      }),
      () => ({
        routes: chainRoutes, supportManifest: wrongChain, chainReads: ports.chain,
        close: () => { events.push("chain:close"); },
      }),
    ])).rejects.toThrow("scope lineage");
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
    await expect(composeOwnerApplicationStages({ routes, signal: new AbortController().signal }, [
      () => ({
        routes, supportManifest: wrongWallet, walletConnection: ports.wallet,
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
    await expect(composeOwnerApplicationStages({ routes, signal: new AbortController().signal }, [
      () => ({
        routes,
        supportManifest: support.wallet,
        walletConnection: { connection: ports.chain.chainStatus as never },
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
      await composeOwnerApplicationStages({ routes, signal: lifecycle.signal }, [
        () => {
          lifecycle.abort();
          return {
            routes, supportManifest: support.wallet, walletConnection: ports.wallet,
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
});
