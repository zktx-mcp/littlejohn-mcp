import { describe, expect, it } from "vitest";

import {
  createCanonicalClock,
  parseUnsignedDecimal,
} from "../../src/core/index.js";
import { readRuntimeConfiguration } from "../../src/runtime/configuration.js";
import type { RuntimeRouteRegistry } from "../../src/runtime/http-routing.js";
import {
  createInitialRuntimeSupportManifest,
  extendChainRuntimeSupportManifest,
  extendWalletRuntimeSupportManifest,
} from "../../src/runtime/support-manifest.js";
import { createTokenCatalogApplicationFactory } from "../../src/token-catalog/application-factory.js";
import { getTokenCatalogOperationFailure } from "../../src/token-catalog/operation-error.js";
import type { TokenCatalogStore } from "../../src/token-catalog/ports.js";
import { createInspectionBinding } from "./harness.js";

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
  getRegistration: () => undefined,
  listRegistrations: () => Object.freeze({ registrations: Object.freeze([]), nextCursor: null }),
  applyConfirmation: () => { throw new Error("No confirmation is expected."); },
}) satisfies TokenCatalogStore;

describe("token catalog application factory", () => {
  it("owns one close result and rejects every consumer surface once closing begins", async () => {
    const application = await createTokenCatalogApplicationFactory({
      routes: Object.freeze({}) as RuntimeRouteRegistry,
      supportManifest: supportManifest(),
      activeWallet: Object.freeze({
        capture: () => Object.freeze({
          connection: Object.freeze({ status: "disconnected" as const, reason: "no_session" as const }),
          connectionRevision: parseUnsignedDecimal("0"),
        }),
      }),
      inspection: createInspectionBinding(),
      store,
      readStore: store,
      accountTokenRegistrationRead: Object.freeze({
        getForAccount: () => undefined,
        listForAccount: () => Object.freeze({ entries: Object.freeze([]), nextCursor: null }),
      }),
      clock: createCanonicalClock(() => "2026-07-20T00:00:00.000Z"),
      signal: new AbortController().signal,
    });

    const close = application.close();
    expect(application.close()).toBe(close);
    const calls: Array<() => unknown> = [
      () => application.tokenCatalogQueries.getRegistration({} as never),
      () => application.tokenCatalogWebStart.startRegistration({} as never, "A".repeat(43)),
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
});
