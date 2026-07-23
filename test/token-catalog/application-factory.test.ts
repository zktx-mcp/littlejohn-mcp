import { describe, expect, it } from "vitest";

import {
  createCanonicalClock,
  createObservationAuthority,
  parseCapabilityDataAt,
  parseUnsignedDecimal,
  parseUtcTimestamp,
  sourceReferenceSchema,
  walletConnectionCapability,
} from "../../src/core/index.js";
import { readRuntimeConfiguration } from "../../src/runtime/configuration.js";
import type { RuntimeRouteRegistry } from "../../src/runtime/http-routing.js";
import { createResourceOwnershipScope } from "../../src/runtime/resource-ownership.js";
import type { OfficialAssetSynchronizationResult } from "../../src/registry/index.js";
import {
  createInitialRuntimeSupportManifest,
  extendChainRuntimeSupportManifest,
  extendWalletRuntimeSupportManifest,
} from "../../src/runtime/support-manifest.js";
import { createTokenCatalogApplicationFactory } from "../../src/token-catalog/application-factory.js";
import { createTokenCatalogFailure } from "../../src/token-catalog/errors.js";
import { getTokenCatalogOperationFailure } from "../../src/token-catalog/operation-error.js";
import type {
  TokenCatalogCoordinatorDependencies,
  TokenCatalogStore,
} from "../../src/token-catalog/ports.js";
import {
  chainId,
  tokenAddress,
  walletAddress,
} from "./harness.js";

const supportManifest = () => {
  const initial = createInitialRuntimeSupportManifest(readRuntimeConfiguration({}).chain);
  const wallet = extendWalletRuntimeSupportManifest(initial, {
    registrations: [],
    changes: [{
      capabilityId: "wallet.connection",
      availability: {
        overall: "internal", direct: "internal", http: "unavailable",
        mcp: "unavailable", cli: "unavailable", web: "unavailable",
      },
    }],
  });
  return extendChainRuntimeSupportManifest(wallet, {
    registrations: [],
    changes: [
      "account.balance",
      "chain.status",
      "contract.inspect",
      "transaction.inspect",
    ].map((capabilityId) => ({
      capabilityId,
      availability: {
        overall: "internal" as const, direct: "internal" as const, http: "unavailable" as const,
        mcp: "unavailable" as const, cli: "unavailable" as const, web: "unavailable" as const,
      },
    })),
  });
};

const store = Object.freeze({
  getSelection: () => undefined,
  getSelectionState: () => undefined,
  listSelections: () => Object.freeze({ selections: Object.freeze([]), nextCursor: null }),
  applyConfirmation: () => { throw new Error("No confirmation is expected."); },
}) satisfies TokenCatalogStore;

const officialAssets = Object.freeze({
  synchronize: async () => Object.freeze({
    status: "unavailable" as const,
    storedRevision: null,
    failure: createTokenCatalogFailure("runtime_state_unavailable"),
  }),
  readStored: () => undefined,
  close: async (): Promise<void> => undefined,
}) satisfies TokenCatalogCoordinatorDependencies["officialAssets"];

const additionChainReads = Object.freeze({
  inspectAndVerifyOfficial: async () => {
    throw new Error("No token addition chain read is expected.");
  },
}) satisfies TokenCatalogCoordinatorDependencies["additionChainReads"];

const factoryInput = (
  officialAssetPort: TokenCatalogCoordinatorDependencies["officialAssets"] = officialAssets,
) => {
  const startup = createResourceOwnershipScope();
  return Object.freeze({
    startup,
    input: {
      routes: Object.freeze({}) as RuntimeRouteRegistry,
      supportManifest: supportManifest(),
      activeWallet: Object.freeze({
        capture: () => Object.freeze({
          connection: Object.freeze({ status: "disconnected" as const, reason: "no_session" as const }),
          connectionRevision: parseUnsignedDecimal("0"),
        }),
      }),
      additionChainReads,
      officialAssets: officialAssetPort,
      startupResources: startup.resources,
      store,
      readStore: store,
      accountTokenSelectionStore: Object.freeze({
        getState: () => undefined,
        getForAccount: () => undefined,
        listIncludedForAccount: () => Object.freeze({ selections: Object.freeze([]), nextCursor: null }),
        initializeDefaults: () => { throw new Error("No default initialization is expected."); },
      }),
      clock: createCanonicalClock(() => "2026-07-20T00:00:00.000Z"),
      signal: new AbortController().signal,
    },
  });
};

describe("token catalog application factory", () => {
  it("owns one close result and rejects every consumer surface once closing begins", async () => {
    const fixture = factoryInput();
    const application = await createTokenCatalogApplicationFactory(fixture.input);
    expect(fixture.startup.empty).toBe(true);

    const close = application.close();
    expect(application.close()).toBe(close);
    const calls: Array<() => unknown> = [
      () => application.tokenCatalogQueries.getSelection({} as never),
      () => application.tokenCatalogWebStart.startAddition({} as never, "A".repeat(43)),
      () => application.tokenCatalogBrowserOperations.getCurrentOperation(),
      () => application.tokenCatalogInteractiveCli.confirm({} as never),
      () => application.tokenCatalogNonInteractiveOperations.getOperation({} as never),
    ];
    for (const call of calls) {
      await expect((async () => { await call(); })()).rejects.toSatisfy((error: unknown) =>
        getTokenCatalogOperationFailure(error)?.error.code === "runtime_state_unavailable");
    }
    await close;
  });

  it("retries only the unresolved cleanup after sharing a failed close attempt", async () => {
    const failure = new Error("official assets close failed");
    let closeCalls = 0;
    const retryingOfficialAssets = Object.freeze({
      ...officialAssets,
      async close(): Promise<void> {
        closeCalls += 1;
        if (closeCalls === 1) throw failure;
      },
    });
    const application = await createTokenCatalogApplicationFactory(
      factoryInput(retryingOfficialAssets).input,
    );

    const first = application.close();
    expect(application.close()).toBe(first);
    await expect(first).rejects.toBe(failure);
    expect(closeCalls).toBe(1);

    await expect(application.close()).resolves.toBeUndefined();
    expect(closeCalls).toBe(2);
    await expect(application.close()).resolves.toBeUndefined();
    expect(closeCalls).toBe(2);
  });

  it("drains the coordinator before closing its official-asset dependency", async () => {
    const clock = createCanonicalClock(() => "2026-07-20T00:00:00.000Z");
    const observedAt = parseUtcTimestamp("2026-07-20T00:00:00.000Z");
    const topicDigest = Buffer.alloc(32, 2).toString("base64url");
    const sourceId = `wallet-session:${topicDigest}`;
    const events: string[] = [];
    let entered!: () => void;
    const synchronizationEntered = new Promise<void>((resolve) => { entered = resolve; });
    const orderedOfficialAssets = Object.freeze({
      synchronize: (signal: AbortSignal) => new Promise<OfficialAssetSynchronizationResult>((resolve) => {
        events.push("synchronize:start");
        entered();
        signal.addEventListener("abort", () => {
          events.push("synchronize:aborted");
          resolve(Object.freeze({
            status: "unavailable",
            storedRevision: null,
            failure: createTokenCatalogFailure("request_aborted"),
          }));
        }, { once: true });
      }),
      readStored: () => undefined,
      close: async (): Promise<void> => { events.push("official-assets:close"); },
    });
    const fixture = factoryInput(orderedOfficialAssets);
    const connection = parseCapabilityDataAt(walletConnectionCapability, {
      status: "connected",
      chainId,
      address: walletAddress,
      approvedMethods: ["eth_sendTransaction"],
      approvedEvents: ["accountsChanged", "chainChanged"],
      expiresAt: "2026-07-21T00:00:00.000Z",
    }, observedAt);
    const application = await createTokenCatalogApplicationFactory({
      ...fixture.input,
      clock,
      activeWallet: Object.freeze({
        capture: () => {
          return Object.freeze({
            connection,
            connectionRevision: parseUnsignedDecimal("1"),
            sessionSource: Object.freeze({
              sourceId,
              candidateId: sourceId,
              topicDigest,
              observationAuthority: createObservationAuthority({
                clock,
                sourceClass: "wallet_session",
                owner: "WalletConnect session",
                reference: sourceReferenceSchema.parse({
                  kind: "wallet_session",
                  sourceId,
                  topicDigest,
                }),
              }),
            }),
          });
        },
      }),
    });

    const start = application.tokenCatalogWebStart.startAddition({
      asset: { kind: "erc20", chainId, address: tokenAddress },
    }, Buffer.alloc(32, 3).toString("base64url"));
    const admission = await Promise.race([
      synchronizationEntered.then(() => Object.freeze({ status: "entered" as const })),
      start.then((result) => Object.freeze({ status: "settled" as const, result })),
    ]);
    expect(admission).toEqual({ status: "entered" });
    await application.close();
    await start;

    expect(events).toEqual([
      "synchronize:start",
      "synchronize:aborted",
      "official-assets:close",
    ]);
  });

  it("retains failed startup cleanup in the supplied owner", async () => {
    const cleanupFailure = new Error("official assets close failed");
    let closeCalls = 0;
    const retryingOfficialAssets = Object.freeze({
      ...officialAssets,
      async close(): Promise<void> {
        closeCalls += 1;
        if (closeCalls === 1) throw cleanupFailure;
      },
    });
    const fixture = factoryInput(retryingOfficialAssets);

    const outcome = createTokenCatalogApplicationFactory({
      ...fixture.input,
      supportManifest: Object.freeze({}) as never,
    });
    await expect(outcome).rejects.toSatisfy((error: unknown) =>
      error instanceof AggregateError && error.errors[1] === cleanupFailure);
    expect(closeCalls).toBe(1);
    expect(fixture.startup.empty).toBe(false);

    fixture.startup.seal();
    await fixture.startup.close();
    expect(closeCalls).toBe(2);
    expect(fixture.startup.empty).toBe(true);
  });
});
