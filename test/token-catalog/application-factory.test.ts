import { describe, expect, it } from "vitest";

import {
  createCanonicalClock,
  parseUnsignedDecimal,
} from "../../src/core/index.js";
import { readRuntimeConfiguration } from "../../src/runtime/configuration.js";
import type { RuntimeRouteRegistry } from "../../src/runtime/http-routing.js";
import { createResourceOwnershipScope } from "../../src/runtime/resource-ownership.js";
import {
  createInitialRuntimeSupportManifest,
  extendChainRuntimeSupportManifest,
  extendWalletRuntimeSupportManifest,
} from "../../src/runtime/support-manifest.js";
import { createTokenCatalogApplicationFactory } from "../../src/token-catalog/application-factory.js";
import { createAddressTargetResolver } from "../../src/chain/address-target.js";
import { getTokenCatalogOperationFailure } from "../../src/token-catalog/operation-error.js";
import type {
  TokenCatalogCoordinatorDependencies,
  TokenCatalogStore,
} from "../../src/token-catalog/ports.js";
import { chainId } from "./harness.js";
const supportManifest = () => {
  const initial = createInitialRuntimeSupportManifest(readRuntimeConfiguration({}).chain);
  const wallet = extendWalletRuntimeSupportManifest(initial, {
    registrations: [],
    changes: [{
      capabilityId: "wallet.connection",
      availability: {
        overall: "internal", direct: "internal", http: "unavailable",
        mcp: "unavailable", cli: "unavailable",
      },
    }],
  });
  return extendChainRuntimeSupportManifest(wallet, {
    registrations: [],
    changes: [
      "account.balance",
      "address.inspect",
      "chain.status",
      "transaction.inspect",
    ].map((capabilityId) => ({
      capabilityId,
        availability: {
          overall: "internal" as const, direct: "internal" as const, http: "unavailable" as const,
          mcp: "unavailable" as const, cli: "unavailable" as const,
      },
    })),
  });
};

const store = Object.freeze({
  getSelection: () => undefined,
  getSelectionState: () => undefined,
  listSelections: () => Object.freeze({ selections: Object.freeze([]), nextCursor: null }),
  readOperation: () => null,
  applySelectionChange: () => { throw new Error("No selection change is expected."); },
}) satisfies TokenCatalogStore;

const officialAssets = Object.freeze({
  synchronize: async () => Object.freeze({
    status: "unavailable" as const,
    storedRevision: null,
    reason: "runtime_state_unavailable" as const,
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
  officialAssetPort: typeof officialAssets = officialAssets,
) => {
  const startup = createResourceOwnershipScope();
  return Object.freeze({
    startup,
    input: {
      routes: Object.freeze({}) as RuntimeRouteRegistry,
      supportManifest: supportManifest(),
      addressTargets: createAddressTargetResolver({ chainId, activeWallet: Object.freeze({
        capture: async () => Object.freeze({
          connection: Object.freeze({ status: "disconnected" as const, reason: "no_session" as const }),
          connectionRevision: parseUnsignedDecimal("0"),
        }),
      }) }),
      additionChainReads,
      officialAssets: officialAssetPort,
      startupResources: startup.resources,
      store,
      readStore: store,
      accountTokenSelectionStore: Object.freeze({
        isAccountRetained: () => false,
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
      async () => (await application.tokenCatalogQueries.getSelection({} as never)),
      () => application.tokenCatalogManagement.review({} as never),
      () => application.tokenCatalogManagement.decide({} as never),
      () => application.tokenCatalogManagement.getOperation({} as never),
      () => application.accountTokenSelectionStore.getState({} as never),
    ];
    for (const call of calls) {
      await expect((async () => { await call(); })()).rejects.toSatisfy((error: unknown) =>
        getTokenCatalogOperationFailure(error)?.error.code === "runtime_state_unavailable");
    }
    await close;
  });

  it("leaves the shared Registry available after Token closes", async () => {
    let closeCalls = 0;
    const sharedOfficialAssets = Object.freeze({
      ...officialAssets,
      async close(): Promise<void> { closeCalls += 1; },
    });
    const application = await createTokenCatalogApplicationFactory(
      factoryInput(sharedOfficialAssets).input,
    );
    await application.close();
    expect(closeCalls).toBe(0);
    await expect(sharedOfficialAssets.synchronize()).resolves.toMatchObject({
      status: "unavailable", reason: "runtime_state_unavailable",
    });
  });

  it("cleans up its failed startup without closing the shared Registry", async () => {
    let closeCalls = 0;
    const fixture = factoryInput(Object.freeze({
      ...officialAssets,
      async close(): Promise<void> { closeCalls += 1; },
    }));
    await expect(createTokenCatalogApplicationFactory({
      ...fixture.input,
      supportManifest: Object.freeze({}) as never,
    })).rejects.toThrow("provenance");
    expect(closeCalls).toBe(0);
    expect(fixture.startup.empty).toBe(true);
  });
});
