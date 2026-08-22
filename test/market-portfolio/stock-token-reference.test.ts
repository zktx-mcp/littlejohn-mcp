import { describe, expect, it, vi } from "vitest";

import type {
  CanonicalBlock,
  ChainInvocationContext,
  ReferenceMarketChainReadPort,
} from "../../src/chain/index.js";
import { ChainOperationError } from "../../src/chain/errors.js";
import {
  chainAnchorSchema,
  createExactRational,
  parseHash32,
  parseUtcTimestamp,
  referenceRoundObservationSchema,
  stockTokenReferenceMarketCatalog,
} from "../../src/core/index.js";
import { MarketPortfolioOperationError } from "../../src/market-portfolio/errors.js";
import { readStockTokenReference } from
  "../../src/market-portfolio/stock-token-reference.js";
import {
  stockTokenMarketInterval,
  stockTokenOfficialAssetFactSchema,
  type StockTokenReferenceAdmissionFailureReason,
} from "../../src/market-portfolio/stock-token-market.js";
import {
  officialAssetSnapshotRevisionSchema,
  officialAssetSourceDefinition,
} from "../../src/registry/index.js";
import { RuntimeOperationError } from "../../src/runtime/errors.js";

const anchor = chainAnchorSchema.parse({
  chainId: "eip155:4663",
  blockNumber: "34307195",
  blockHash: `0x${"39".repeat(32)}`,
  blockTimestamp: "2026-08-12T13:30:00.000Z",
});
const block: CanonicalBlock = Object.freeze({ anchor });
const disposition = stockTokenReferenceMarketCatalog.dispositions.find((entry) =>
  entry.asset.symbol === "AAPL");
if (disposition === undefined || disposition.mapping.status !== "mapped") {
  throw new TypeError("The reference-process fixture requires mapped AAPL evidence.");
}
const deployment = disposition.asset.deployments.find((entry) => entry.chainId === 4663);
if (deployment === undefined) {
  throw new TypeError("The reference-process fixture requires an AAPL deployment.");
}
const officialAsset = stockTokenOfficialAssetFactSchema.parse({
  member: {
    assetUid: disposition.asset.assetUid,
    contractAddress: deployment.contractAddress,
    sourceName: disposition.asset.name,
    sourceSymbol: disposition.asset.symbol,
  },
  snapshot: {
    sourceUri: officialAssetSourceDefinition.sourceUri,
    sourceObservedAt: parseUtcTimestamp("2026-08-12T13:12:28.000Z"),
    rawResponseDigest: parseHash32(`0x${"11".repeat(32)}`),
    memberSetDigest: parseHash32(`0x${"12".repeat(32)}`),
    revision: officialAssetSnapshotRevisionSchema.parse("AQEBAQEBAQEBAQEBAQEBAQ"),
  },
});
const interval = stockTokenMarketInterval("1d", anchor.blockTimestamp);
const feed = disposition.mapping.feed;
const roundId = ((1n << 64n) | 3n).toString(10);
const updatedAt = "2026-08-12T13:25:00.000Z";
const updatedAtUnixSeconds = String(Math.floor(Date.parse(updatedAt) / 1_000));
const latest = referenceRoundObservationSchema.parse({
  fact: {
    manifestVersion: 1,
    feedId: feed.feedId,
    proxyAddress: feed.proxyAddress,
    decimals: feed.decimals,
    roundId,
    answeredInRound: roundId,
    answer: "23125000000",
    startedAtUnixSeconds: updatedAtUnixSeconds,
    updatedAtUnixSeconds,
    value: createExactRational(23_125_000_000n, 10n ** BigInt(feed.decimals)),
  },
  readEvidence: {
    observedAt: anchor.blockTimestamp,
    sourceOwner: "user_configured",
    sourceClass: "chain_rpc",
    sourceReference: {
      kind: "configured_rpc",
      sourceId: `rpc:${"A".repeat(43)}`,
      publicOrigin: "https://rpc.example",
      configurationDigest: "A".repeat(43),
    },
    block: anchor,
  },
});

type DirectRead = ReferenceMarketChainReadPort["readStockTokenReferenceAtBlock"];
type Synchronize = Parameters<typeof readStockTokenReference>[0]["synchronization"]["synchronize"];

const inputFor = (input: Readonly<{
  controller?: AbortController;
  read: DirectRead;
  synchronize?: Synchronize;
}>) => {
  const controller = input.controller ?? new AbortController();
  return Object.freeze({
    officialAsset,
    window: "1d" as const,
    interval,
    block,
    context: Object.freeze({ signal: controller.signal }) satisfies ChainInvocationContext,
    chain: Object.freeze({ readStockTokenReferenceAtBlock: input.read }),
    synchronization: Object.freeze({
      synchronize: input.synchronize ?? vi.fn(async () => {
        throw new Error("Reference synchronization is not expected.");
      }),
    }),
  });
};

const observedRead: DirectRead = async () => Object.freeze({
  status: "observed",
  oraclePaused: false,
  latest,
});

const directReadFailures = Object.freeze({
  chain_response_unavailable: () => new ChainOperationError("chain_response_unavailable"),
  rate_limited: () => new ChainOperationError("rate_limited"),
  source_unavailable: () => new ChainOperationError("source_unavailable"),
  source_inconsistent: () => new ChainOperationError("source_inconsistent"),
  runtime_busy: () => new ChainOperationError("runtime_busy"),
} satisfies Readonly<Record<
  StockTokenReferenceAdmissionFailureReason,
  () => ChainOperationError
>>);

describe("Stock Token reference process ownership", () => {
  it.each(Object.entries(directReadFailures))(
    "admits the direct Chain %s failure as the exact reference sibling",
    async (reason, createFailure) => {
      const failure = createFailure();
      const synchronize = vi.fn<Synchronize>();
      const result = await readStockTokenReference(inputFor({
        read: async () => { throw failure; },
        synchronize,
      }));

      expect(result).toEqual({ status: "unavailable", reason });
      expect(synchronize).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["Chain history inconsistency", new ChainOperationError("source_inconsistent"), "source_inconsistent"],
    ["Chain RPC capacity", new ChainOperationError("runtime_busy"), "runtime_busy"],
    ["persisted round conflict", new MarketPortfolioOperationError("source_inconsistent"), "source_inconsistent"],
    ["reference scheduler capacity", new MarketPortfolioOperationError("runtime_busy"), "runtime_busy"],
    ["reference storage capacity", new RuntimeOperationError("runtime_busy"), "runtime_busy"],
  ] as const)("classifies %s at the synchronization boundary", async (
    _condition,
    failure,
    reason,
  ) => {
    const synchronize = vi.fn<Synchronize>(async () => { throw failure; });
    const result = await readStockTokenReference(inputFor({
      read: observedRead,
      synchronize,
    }));

    expect(result).toEqual({ status: "unavailable", reason });
    expect(synchronize).toHaveBeenCalledWith(expect.objectContaining({
      feedId: feed.feedId,
      block,
      requestedStartUnixSeconds: BigInt(Math.floor(Date.parse(interval.requestedStart) / 1_000)),
      latest,
    }));
  });

  it.each([
    ["a bounded-history source stop that escaped its owner", new ChainOperationError("source_unavailable")],
    ["a retention conflict", new MarketPortfolioOperationError("state_conflict")],
    ["storage unavailability", new RuntimeOperationError("runtime_state_unavailable")],
    ["an unbranded failure", new Error("Unclassified synchronization failure.")],
  ] as const)("rethrows %s instead of inventing a reference sibling", async (
    _condition,
    failure,
  ) => {
    await expect(readStockTokenReference(inputFor({
      read: observedRead,
      synchronize: async () => { throw failure; },
    }))).rejects.toBe(failure);
  });

  it("does not classify a direct-read failure after the invocation signal stops", async () => {
    const controller = new AbortController();
    const failure = new ChainOperationError("source_unavailable");
    await expect(readStockTokenReference(inputFor({
      controller,
      read: async () => {
        controller.abort();
        throw failure;
      },
    }))).rejects.toBe(failure);
  });

  it("does not classify a synchronization failure after the invocation signal stops", async () => {
    const controller = new AbortController();
    const failure = new MarketPortfolioOperationError("runtime_busy");
    await expect(readStockTokenReference(inputFor({
      controller,
      read: observedRead,
      synchronize: async () => {
        controller.abort();
        throw failure;
      },
    }))).rejects.toBe(failure);
  });
});
