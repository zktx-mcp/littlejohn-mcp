import { describe, expect, it } from "vitest";

import {
  chainAnchorSchema,
  canonicalJsonStringify,
  captureCanonicalJson,
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
  formatStockTokenMarketForCli,
  parseMarketPortfolioCliCommand,
  marketPortfolioCliCommandRequiresInteractiveTerminal,
  runMarketPortfolioCliCommand,
} from "../../src/interfaces/market-portfolio-cli.js";
import { LocalOperationClient } from "../../src/interfaces/operation-client.js";
import type { ReferenceFeedCacheSnapshot } from "../../src/runtime/reference-market-storage.js";
import { createReferenceHistory } from "../../src/market-portfolio/candles.js";
import { stockTokenMarketResultSchema } from
  "../../src/market-portfolio/stock-token-market.js";
import {
  stockTokenMarketAvailableFixture,
  stockTokenMarketReferenceUnavailableFixture,
  stockTokenMarketUnmappedFixture,
} from "./stock-token-market-fixture.js";

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

describe("market-portfolio interface boundary", () => {
  it("accepts only the fixed CLI grammar and delegates identities to the canonical schemas", () => {
    const pairId = referenceMarketManifest.pairs[0]!.pairId;
    expect(parseMarketPortfolioCliCommand(["market", "price", pairId])).toMatchObject({
      kind: "price", json: false, input: { pairId },
    });
    expect(parseMarketPortfolioCliCommand(["market", "history", pairId, "--window", "30d", "--json"]))
      .toMatchObject({ kind: "history", json: true, input: { pairId, window: "30d" } });
    expect(parseMarketPortfolioCliCommand(["market", "stock-token-market", "aapl"]))
      .toMatchObject({
        kind: "stockTokenMarket", json: false, input: { symbol: "AAPL", window: "1d" },
      });
    expect(parseMarketPortfolioCliCommand([
      "market", "stock-token-market", "AAPL", "--window", "7d", "--json",
    ])).toMatchObject({
      kind: "stockTokenMarket", json: true, input: { symbol: "AAPL", window: "7d" },
    });
    expect(parseMarketPortfolioCliCommand([
      "market", "add-pair", pairId, "--revision", "AAAAAAAAAAAAAAAAAAAAAA",
    ])).toMatchObject({ kind: "add", input: { pairId, expectedRevision: "AAAAAAAAAAAAAAAAAAAAAA" } });
    const operation = parseMarketPortfolioCliCommand([
      "market", "watchlist-operation", Buffer.alloc(32, 23).toString("base64url"), "--json",
    ]);
    expect(operation).toMatchObject({ kind: "operation", json: true });
    expect(marketPortfolioCliCommandRequiresInteractiveTerminal(operation)).toBe(false);
    expect(marketPortfolioCliCommandRequiresInteractiveTerminal(parseMarketPortfolioCliCommand([
      "market", "add-pair", pairId, "--revision", "AAAAAAAAAAAAAAAAAAAAAA",
    ]))).toBe(true);
    expect(() => parseMarketPortfolioCliCommand(["market", "add-pair", pairId])).toThrow();
    expect(() => parseMarketPortfolioCliCommand(["market", "history", pairId, "--window", "90d"])).toThrow();
    expect(() => parseMarketPortfolioCliCommand([
      "market", "stock-token-market", "AAPL", "--revision", "AAAAAAAAAAAAAAAAAAAAAA",
    ])).toThrow();
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

  it("projects the canonical Stock Token result without inventing price or history facts", () => {
    const available = stockTokenMarketAvailableFixture();
    if (available.status !== "available") throw new TypeError("The mapped fixture is unavailable.");
    const output = formatStockTokenMarketForCli(available);
    expect(output).toContain("Stock Token: Apple • Robinhood Token · AAPL");
    expect(output).toContain("Oracle reference status: current");
    expect(output).toContain("Oracle reference value denominated in USD: 925/4");
    expect(output).toContain("Oracle reference observed at: 2026-08-12T13:37:23.000Z");
    expect(output).toContain("USD-denominated oracle reference history: partial");
    expect(output).toContain("Executed trades (USDG): available");
    expect(output).toContain("Execution freshness: current");
    expect(output).toContain("Execution source coverage: partial");
    expect(output).toContain("Execution detail: complete");
    expect(output).toContain("Observed execution one-minute candles: 3");
    expect(output).toContain("Returned execution one-minute candles: 3");
    expect(output).toContain("Execution display positions: 97");
    expect(output).toContain("Latest returned one-minute execution close: 927/4 USDG");
    expect(output).toContain("Latest returned one-minute execution candle: 2026-08-12T13:37:00.000Z");
    expect(output).toContain("Execution coverage limitation: Published execution history starts");
    expect(output).toContain("Oracle reference limitation: Round traversal cannot prove");
    expect(output).toContain("Oracle reference warning: The value is a reference value");
    expect(output).not.toContain("source_history_not_exhaustive");
    expect(output).not.toContain("Oracle paused: no");

    const unavailableValue = stockTokenMarketUnmappedFixture();
    if (!("officialAsset" in unavailableValue)) {
      throw new TypeError("The unmapped fixture omitted its official asset.");
    }
    const unavailable = formatStockTokenMarketForCli(unavailableValue);
    expect(unavailable).toContain(
      `Stock Token: ${unavailableValue.officialAsset.member.sourceName} · P`,
    );
    expect(unavailable).toContain(
      `Contract: ${unavailableValue.officialAsset.member.contractAddress}`,
    );
    expect(unavailable).toContain("Oracle reference value denominated in USD: unavailable");
    expect(unavailable).toContain(
      "Oracle reference reason: The admitted catalog has no reference feed for this Stock Token.",
    );

    const availableWithoutSourceName = structuredClone(available);
    delete availableWithoutSourceName.officialAsset.member.sourceName;
    const referenceUnavailableWithoutSourceName = structuredClone(
      stockTokenMarketReferenceUnavailableFixture(),
    );
    if (referenceUnavailableWithoutSourceName.status !== "available") {
      throw new TypeError("The reference-unavailable fixture is unavailable.");
    }
    delete referenceUnavailableWithoutSourceName.officialAsset.member.sourceName;
    const sourceIndependentOutputs = [
      stockTokenMarketResultSchema.parse(availableWithoutSourceName),
      stockTokenMarketResultSchema.parse(referenceUnavailableWithoutSourceName),
    ].map(formatStockTokenMarketForCli);
    expect(sourceIndependentOutputs).toEqual([
      expect.stringContaining("Stock Token: AAPL\n"),
      expect.stringContaining("Stock Token: AAPL\n"),
    ]);
    expect(sourceIndependentOutputs.every((candidate) =>
      !candidate.includes("Apple • Robinhood Token"))).toBe(true);
  });

  it("dispatches CLI text and JSON through the one Stock Token interface binding", async () => {
    const value = stockTokenMarketUnmappedFixture();
    const requests: unknown[] = [];
    const runtime = Object.freeze({
      dispatchRuntimeRequest: async (request: unknown) => {
        requests.push(request);
        return { status: 200 as const, body: captureCanonicalJson(value) };
      },
    });
    const operationClient = new LocalOperationClient({
      ownerSessions: Object.freeze({
        openOwnerSession: async (): Promise<never> => {
          throw new TypeError("A read-only market command must not open an operation session.");
        },
      }),
    });
    const writes: string[] = [];
    const output = Object.freeze({
      inputIsTTY: false,
      outputIsTTY: false,
      interruptSignal: new AbortController().signal,
      writeOutput: (entry: string) => writes.push(entry),
      writeError: (entry: string) => { throw new TypeError(entry); },
      readLine: async (): Promise<never> => { throw new TypeError("No prompt is expected."); },
    });
    try {
      expect(await runMarketPortfolioCliCommand(
        runtime,
        operationClient,
        parseMarketPortfolioCliCommand(["market", "stock-token-market", "p", "--json"]),
        output,
      )).toBe(0);
      expect(writes).toEqual([
        `${canonicalJsonStringify(captureCanonicalJson(value))}\n`,
      ]);
      expect(requests).toEqual([expect.objectContaining({
        requestClass: "public_read",
        method: "POST",
        path: "/api/v1/stock-token-markets/queries",
        body: { symbol: "P", window: "1d" },
      })]);
    } finally {
      await operationClient.close();
    }
  });
});
