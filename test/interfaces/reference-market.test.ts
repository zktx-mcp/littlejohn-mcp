import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  chainAnchorSchema,
  createExactRational,
  referenceHistorySuccessSchema,
  referenceMarketManifest,
  referenceMarketMappingEvidence,
  referencePriceSuccessSchema,
  referencePriceWarnings,
  referenceRoundObservationSchema,
} from "../../src/core/index.js";
import {
  formatReferenceHistoryForCli,
  formatReferencePriceForCli,
  parseReferenceMarketCliCommand,
} from "../../src/interfaces/reference-market-cli.js";
import { referenceMarketPublicRoutes } from "../../src/interfaces/browser-contract.js";
import { referenceMarketLocalMutationPaths } from "../../src/interfaces/identities.js";
import {
  extendReferenceMarketInterfaceRoutes,
} from "../../src/interfaces/reference-market-http.js";
import { createReferenceMarketDeliveryUnknown } from "../../src/interfaces/reference-market-delivery.js";
import { createControlCredentialVerifier, loadOrCreateControlCredential } from "../../src/runtime/control-credential.js";
import { createRuntimeRouteRegistry, type RuntimeRouteRegistry } from "../../src/runtime/http-routing.js";
import { runtimePaths } from "../../src/runtime/paths.js";
import type { ReferenceFeedCacheSnapshot } from "../../src/runtime/reference-market-storage.js";
import { createReferenceHistory } from "../../src/market-portfolio/candles.js";
import {
  createReferenceMarketFailure,
  type ReferenceMarketApplicationPort,
} from "../../src/market-portfolio/index.js";
import { referenceMarketInterfaceHarnessPort } from "../market-portfolio/interface-harness.js";
import { tokenCatalogInterfaceErrorMappings } from "../../src/token-catalog/errors.js";

const directories: string[] = [];
const block = chainAnchorSchema.parse({
  chainId: "eip155:4663",
  blockNumber: "42",
  blockHash: `0x${"ab".repeat(32)}`,
  blockTimestamp: "2026-07-22T00:07:00.000Z",
});
const feed = referenceMarketManifest.feeds[0]!;
const observationTime = "2026-07-22T00:02:00.000Z";
const observationSeconds = String(Date.parse(observationTime) / 1_000);
const rpcConfigurationDigest = "A".repeat(43);
const observation = referenceRoundObservationSchema.parse({
  fact: {
    manifestVersion: 1,
    feedId: feed.feedId,
    proxyAddress: feed.standardProxy,
    decimals: 8,
    roundId: String((1n << 64n) | 1n),
    answeredInRound: String((1n << 64n) | 1n),
    answer: "193384405462",
    startedAtUnixSeconds: observationSeconds,
    updatedAtUnixSeconds: observationSeconds,
    value: createExactRational(193384405462n, 100000000n),
  },
  readEvidence: {
    observedAt: "2026-07-22T00:07:01.000Z",
    sourceOwner: "user_configured",
    sourceClass: "chain_rpc",
    sourceReference: {
      kind: "configured_rpc",
      sourceId: `rpc:${rpcConfigurationDigest}`,
      publicOrigin: "https://rpc.example",
      configurationDigest: rpcConfigurationDigest,
    },
    block,
  },
});
const snapshot: ReferenceFeedCacheSnapshot = Object.freeze({
  feedId: feed.feedId,
  revision: null,
  observations: [observation],
  backfillPhaseId: "1",
  backfillNextRoundId: null,
  retentionCutoffRoundId: null,
  integrityStatus: null,
  backfillStatus: "phase_boundary",
});
const traversalReport = Object.freeze({
  remainingContinuation: false,
  remainingGap: false,
  phaseBoundaryObserved: true,
  malformedRoundObserved: false,
});
const history = createReferenceHistory({
  pair: referenceMarketManifest.pairs[0]!,
  window: "1d",
  block,
  snapshots: new Map([[feed.feedId, snapshot]]),
  reports: new Map([[feed.feedId, traversalReport]]),
});

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

const routes = async (
  referenceMarkets: ReferenceMarketApplicationPort = referenceMarketInterfaceHarnessPort(),
): Promise<RuntimeRouteRegistry> => {
  const directory = await mkdtemp(resolve(tmpdir(), "littlejohn-reference-market-routes-"));
  directories.push(directory);
  const paths = runtimePaths(directory);
  const credential = await loadOrCreateControlCredential(directory, paths.controlCredential);
  return extendReferenceMarketInterfaceRoutes({
    routes: createRuntimeRouteRegistry({
      controlVerifier: createControlCredentialVerifier(credential),
      errorMappings: tokenCatalogInterfaceErrorMappings,
    }),
    referenceMarkets,
  });
};

describe("reference-market interface boundary", () => {
  it("registers the six exact POST resources with their declared trust and mutation classes", async () => {
    const registry = await routes();
    const expected = [
      [referenceMarketPublicRoutes.priceQueries, "public_read", "none"],
      [referenceMarketPublicRoutes.historyQueries, "public_read", "none"],
      [referenceMarketPublicRoutes.watchlistQueries, "public_read", "none"],
      [referenceMarketLocalMutationPaths.add, "local_control", "declared_control"],
      [referenceMarketLocalMutationPaths.remove, "local_control", "declared_control"],
      [referenceMarketLocalMutationPaths.reorder, "local_control", "declared_control"],
    ] as const;
    for (const [path, requestClass, mutation] of expected) {
      const match = registry.match("POST", path);
      expect(match.status).toBe("matched");
      if (match.status === "matched") {
        expect(match.route).toMatchObject({ method: "POST", requestClass, mutation, successStatus: 200 });
      }
      expect(registry.match("GET", path).status).toBe("method_not_allowed");
    }
  });

  it("binds each local mutation path to the matching application effect", async () => {
    const calls: string[] = [];
    const base = referenceMarketInterfaceHarnessPort();
    const record = (
      action: "add" | "remove" | "reorder",
    ) => async () => {
      calls.push(action);
      return createReferenceMarketFailure("wallet_not_connected");
    };
    const application: ReferenceMarketApplicationPort = Object.freeze({
      ...base,
      addPair: record("add"),
      removePair: record("remove"),
      reorderPairs: record("reorder"),
    });
    const registry = await routes(application);
    const pairId = referenceMarketManifest.pairs[0]!.pairId;
    const expectedRevision = "AAAAAAAAAAAAAAAAAAAAAA";
    const requests = {
      add: { pairId, expectedRevision },
      remove: { pairId, expectedRevision },
      reorder: { pairIds: [pairId], expectedRevision },
    } as const;
    for (const action of ["add", "remove", "reorder"] as const) {
      const match = registry.match("POST", referenceMarketLocalMutationPaths[action]);
      if (match.status !== "matched") throw new Error(`Missing ${action} route.`);
      await match.route.handler({
        params: {},
        body: requests[action],
        query: "",
        signal: new AbortController().signal,
      });
    }
    expect(calls).toEqual(["add", "remove", "reorder"]);
  });

  it("rejects malformed input at the route contract and preserves a declared domain failure", async () => {
    const registry = await routes();
    const malformed = registry.match("POST", referenceMarketPublicRoutes.priceQueries);
    if (malformed.status !== "matched") throw new Error("Reference price route is unavailable.");
    const malformedResult = registry.normalizeResult(malformed.route, await malformed.route.handler({
      params: {},
      body: { pairId: referenceMarketManifest.pairs[0]!.pairId, extra: true },
      query: "",
      signal: new AbortController().signal,
    }));
    expect(malformedResult).toMatchObject({ ok: false, problem: { code: "invalid_input" } });

    const watchlist = registry.match("POST", referenceMarketPublicRoutes.watchlistQueries);
    if (watchlist.status !== "matched") throw new Error("Reference watchlist route is unavailable.");
    const disconnected = registry.normalizeResult(watchlist.route, await watchlist.route.handler({
      params: {}, body: {}, query: "", signal: new AbortController().signal,
    }));
    expect(disconnected).toMatchObject({ ok: false, problem: { code: "wallet_not_connected" } });
  });

  it("accepts only the fixed CLI grammar and delegates identities to the canonical schemas", () => {
    const pairId = referenceMarketManifest.pairs[0]!.pairId;
    expect(parseReferenceMarketCliCommand(["market", "price", pairId])).toMatchObject({
      kind: "price", json: false, input: { pairId },
    });
    expect(parseReferenceMarketCliCommand(["market", "history", pairId, "--window", "30d", "--json"]))
      .toMatchObject({ kind: "history", json: true, input: { pairId, window: "30d" } });
    expect(parseReferenceMarketCliCommand([
      "market", "add-pair", pairId, "--revision", "AAAAAAAAAAAAAAAAAAAAAA",
    ])).toMatchObject({ kind: "add", input: { pairId, expectedRevision: "AAAAAAAAAAAAAAAAAAAAAA" } });
    expect(() => parseReferenceMarketCliCommand(["market", "add-pair", pairId])).toThrow();
    expect(() => parseReferenceMarketCliCommand(["market", "history", pairId, "--window", "90d"])).toThrow();
  });

  it("derives the delivery commitment only from the canonical action and request", () => {
    const pairId = referenceMarketManifest.pairs[0]!.pairId;
    const otherPairId = referenceMarketManifest.pairs[1]!.pairId;
    const expectedRevision = "AAAAAAAAAAAAAAAAAAAAAA";
    const independentPreimage =
      `{"capabilityId":"market.add_watchlist_pair","domain":"littlejohn.reference-market-watchlist.delivery.v1",` +
      `"request":{"expectedRevision":"${expectedRevision}","pairId":"${pairId}"}}`;
    const independentDigest = createHash("sha256").update(independentPreimage).digest("hex");
    expect(independentDigest).toBe("26ba5ebfd2ed004b2e15c2bc669d6dd9edfc4764085ad0f212f4e621af1f774d");

    const add = createReferenceMarketDeliveryUnknown({
      action: "add",
      request: { pairId, expectedRevision },
    });
    expect(add).toMatchObject({
      action: "add",
      requestDigest: independentDigest,
      expectedRevision,
      resendAllowed: false,
      verificationCapability: "market.watchlist",
    });

    const digests = [
      add.requestDigest,
      createReferenceMarketDeliveryUnknown({
        action: "remove",
        request: { pairId, expectedRevision },
      }).requestDigest,
      createReferenceMarketDeliveryUnknown({
        action: "add",
        request: { pairId: otherPairId, expectedRevision },
      }).requestDigest,
      createReferenceMarketDeliveryUnknown({
        action: "add",
        request: { pairId, expectedRevision: "BBBBBBBBBBBBBBBBBBBBBA" },
      }).requestDigest,
      createReferenceMarketDeliveryUnknown({
        action: "reorder",
        request: { pairIds: [pairId, otherPairId], expectedRevision },
      }).requestDigest,
      createReferenceMarketDeliveryUnknown({
        action: "reorder",
        request: { pairIds: [otherPairId, pairId], expectedRevision },
      }).requestDigest,
    ];
    expect(new Set(digests).size).toBe(digests.length);
    expect(() => createReferenceMarketDeliveryUnknown({
      action: "add",
      request: { pairIds: [pairId], expectedRevision },
    })).toThrow();
    expect(() => createReferenceMarketDeliveryUnknown({
      action: "reorder",
      request: { pairId, expectedRevision },
    })).toThrow();
  });

  it("renders canonical price and observed-history evidence without weakening limitations", () => {
    const staleBlock = chainAnchorSchema.parse({
      ...block,
      blockTimestamp: "2026-07-24T00:07:00.000Z",
    });
    const staleObservation = referenceRoundObservationSchema.parse({
      ...observation,
      readEvidence: { ...observation.readEvidence, block: staleBlock },
    });
    const stale = referencePriceSuccessSchema.parse({
      status: "stale",
      pair: referenceMarketManifest.pairs[0]!,
      block: staleBlock,
      mappingEvidence: referenceMarketMappingEvidence,
      sources: [staleObservation],
      lastObserved: staleObservation.fact.value,
      warnings: referencePriceWarnings,
    });
    const price = formatReferencePriceForCli(stale);
    expect(price).toContain("Status: stale");
    expect(price).toContain(`Source 1 round: ${staleObservation.fact.roundId}`);
    expect(price).toContain("Source 1 source reference: kind=configured_rpc");
    expect(price).toContain("Block timestamp: 2026-07-24T00:07:00.000Z");
    expect(price).toContain("Warning: source_listing_not_revalidated");

    const formattedHistory = formatReferenceHistoryForCli(history);
    expect(formattedHistory).toContain("Warning: partial_history");
    expect(formattedHistory).toContain(
      "Block hash: 0xabababababababababababababababababababababababababababababababab",
    );
    expect(formattedHistory).toContain("Mapping source class: official_document");
    expect(formattedHistory).toContain("Mapping freshness: unknown (not_revalidated_at_runtime)");
    expect(formattedHistory).toContain("Empty bucket starts: 2026-07-21T00:15:00.000Z");
    expect(formattedHistory).toContain("Limitations: source_history_not_exhaustive, phase_boundary");
    expect(formattedHistory).toContain("Source 1 source reference: kind=configured_rpc");
    expect(formattedHistory).toContain("Source 1 updated at Unix seconds: 1784678520");
    expect(formattedHistory).toContain("Source 1 observed at: 2026-07-22T00:07:01.000Z");

    const unavailable = referenceHistorySuccessSchema.parse(createReferenceHistory({
      pair: referenceMarketManifest.pairs[0]!,
      window: "1d",
      block,
      snapshots: new Map([[feed.feedId, Object.freeze({ ...snapshot, observations: [] })]]),
      reports: new Map([[feed.feedId, traversalReport]]),
    }));
    const unavailableOutput = formatReferenceHistoryForCli(unavailable);
    expect(unavailableOutput).toContain("Reason: no_valid_observation");
    expect(unavailableOutput).toContain("Coverage basis: observed_rounds");
    expect(unavailableOutput).toContain("Mapping source URI: https://docs.chain.link/");
    expect(unavailableOutput).toContain("Warning: no_trade_volume");
  });
});
