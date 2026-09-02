import { describe, expect, it } from "vitest";

import {
  getCapabilityDefinitionSnapshot,
  chainAnchorSchema,
  parseEvmAddress,
  parseUtcTimestamp,
} from "../../src/core/index.js";
import {
  assertStockTokenTradeHistoryData,
  assertStockTokenTradeHistoryDataAt,
  createStockTokenTradeHistoryArchiveResult,
  projectStockTokenTradeHistoryEvidenceStages,
  selectStockTokenTradeHistoryResolution,
  stockTokenTradeHistoryCapability,
  stockTokenTradeHistoryInputSchema,
  stockTokenTradeHistoryMaximumSuccessUtf8Bytes,
  stockTokenTradeHistoryNaturalPositionCount,
  stockTokenTradeHistoryRequestAtBlock,
  stockTokenTradeHistoryRequestedStart,
  type StockTokenTradeHistoryPeriod,
  type StockTokenTradeHistoryData,
} from "../../src/stock-token-trade-history/index.js";
import { createStockTokenTradeHistorySource } from
  "../../src/stock-token-trade-history/source.js";
import { stockFactoryVerificationSchema } from "../../src/registry/index.js";
import { stockTokenTradeHistorySourceResolution } from
  "../../src/stock-token-trade-history/source-semantics.js";
import { deriveStockTokenTradeHistoryPublicData } from
  "../../src/stock-token-trade-history/source-semantics.js";
import results from "../interfaces/stock-token-trade-history-results.json" with { type: "json" };
import {
  createStockTokenTradeHistoryCrossPoolFixture,
  createStockTokenTradeHistoryIncompleteWithSwapFixture,
  createStockTokenTradeHistoryPositivePreviousOwnerFixture,
} from "./source-fixture.js";

const request = { symbol: "AAPL", period: { count: 1, unit: "day" as const } };
const availableData = () => assertStockTokenTradeHistoryData(
  request,
  results.available.data as unknown as StockTokenTradeHistoryData,
);
const unavailableData = () => assertStockTokenTradeHistoryData(
  request,
  results.unavailable.data as unknown as StockTokenTradeHistoryData,
);

describe("Stock Token trade-history period and result ownership", () => {
  it("preserves the closed period branch and selects the finest admitted stored resolution", () => {
    expect(stockTokenTradeHistoryInputSchema.parse({ symbol: "aapl" })).toEqual({
      symbol: "AAPL",
      period: { count: 1, unit: "day" },
    });
    const requestedEnd = parseUtcTimestamp("2028-02-29T12:00:00.000Z");
    expect(stockTokenTradeHistoryRequestedStart(
      { count: 1, unit: "year" },
      requestedEnd,
    )).toBe("2027-02-28T12:00:00.000Z");
    const cases = [
      { period: { count: 1, unit: "day" }, expected: "15m" },
      { period: { count: 7, unit: "day" }, expected: "1h" },
      { period: { count: 1, unit: "year" }, expected: "2d" },
    ] as const satisfies readonly Readonly<{
      period: StockTokenTradeHistoryPeriod;
      expected: "15m" | "1h" | "2d";
    }>[];
    for (const { period, expected } of cases) {
      const requestedStart = stockTokenTradeHistoryRequestedStart(period, requestedEnd);
      const selected = selectStockTokenTradeHistoryResolution({ requestedStart, requestedEnd });
      expect(selected).toBe(expected);
      expect(stockTokenTradeHistoryNaturalPositionCount({
        requestedStart,
        requestedEnd,
        intervalSeconds: stockTokenTradeHistorySourceResolution(selected).intervalSeconds,
      })).toBeLessThanOrEqual(185);
    }
  });

  it("rejects a freshness claim that does not follow the admitted root", () => {
    const available = availableData();
    if (available.status !== "available") throw new TypeError("Expected available fixture data.");
    expect(() => assertStockTokenTradeHistoryData(
      { symbol: "AAPL", period: { count: 1, unit: "day" } },
      { ...available, freshness: available.freshness === "current" ? "stale" : "current" },
    )).toThrow("freshness");

    const unavailable = unavailableData();
    if (unavailable.status !== "unavailable" || !("archive" in unavailable)) {
      throw new TypeError("Expected archive-unavailable fixture data.");
    }
    expect(() => assertStockTokenTradeHistoryData(
      { symbol: "AAPL", period: { count: 1, unit: "day" } },
      { ...unavailable, freshness: "current" },
    )).toThrow("freshness");
  });

  it("preserves both material published-coverage limitations in semantic order", () => {
    const available = availableData();
    if (available.status !== "available") throw new TypeError("Expected available fixture data.");
    const derived = deriveStockTokenTradeHistoryPublicData({
      sourceInput: {
        baseCurrencyAddress: available.officialAsset.member.contractAddress,
        baseCurrencyDecimals: available.tokenDecimals.value,
        requestedStart: available.requestedStart,
        requestedEnd: available.requestedEnd,
        canonicalBlock: available.block,
        resolution: available.resolution.label,
      },
      coverage: [{
        fromTimestamp: "2026-08-23T08:00:00.000Z",
        poolId: Object.keys(available.archive.pools)[0]!,
        untilTimestamp: "2026-08-24T06:00:00.000Z",
      }],
      resolutionOwnerMonths: ["2026-08"],
      candles: [],
    });
    expect(derived.coverageSummary).toEqual({
      status: "partial",
      limitations: ["before_published_coverage", "after_published_coverage"],
    });
  });

  it("ends raw coverage at the SourcePort and retains only position-owned public facts", () => {
    const available = availableData();
    if (available.status !== "available") throw new TypeError("Expected available fixture data.");
    expect(available.archive).not.toHaveProperty("coverage");
    expect(available.archive).not.toHaveProperty("coverageOwnerMonths");
    expect(available.coverage).toEqual({
      status: "complete",
      limitations: [],
      fromTimestamp: available.requestedStart,
      untilTimestamp: available.requestedEnd,
    });
    const positionPoolIds = [...new Set(available.positions.flatMap((position) =>
      position.poolId === null ? [] : [position.poolId]))].sort();
    expect(Object.keys(available.archive.pools).sort()).toEqual(positionPoolIds);
  });

  it("rejects changed relationships retained by the canonical public result", () => {
    const available = availableData();
    if (available.status !== "available") throw new TypeError("Expected available fixture data.");
    const candleIndex = available.positions.findIndex((position) => position.candle !== null);
    const changedCandle = available.positions[candleIndex]?.candle;
    if (candleIndex < 0 || changedCandle === undefined || changedCandle === null) {
      throw new TypeError("Expected one stored candle.");
    }
    const changed: StockTokenTradeHistoryData[] = [
      {
        ...available,
        coverage: {
          ...available.coverage,
          fromTimestamp: parseUtcTimestamp("2026-08-23T08:00:00.000Z"),
        },
      },
      {
        ...available,
        archive: {
          ...available.archive,
          base: {
            ...available.archive.base,
            state: {
              ...available.archive.base.state,
              logicalId: "base/0x0000000000000000000000000000000000000001/state",
            },
          },
        },
      },
      {
        ...available,
        archive: {
          ...available.archive,
          monthMembers: [...available.archive.monthMembers, available.archive.monthMembers[0]!],
        },
      },
      {
        ...available,
        archive: {
          ...available.archive,
          resolutionMembers: [],
        },
      },
      {
        ...available,
        archive: {
          ...available.archive,
          pools: {
            ...available.archive.pools,
            [`0x${"1".repeat(64)}`]: Object.values(available.archive.pools)[0]!,
          },
        },
      },
      {
        ...available,
        archive: {
          ...available.archive,
          root: {
            ...available.archive.root,
            currentUntil: {
              ...available.archive.root.currentUntil,
              timestamp: parseUtcTimestamp("2026-08-24T06:45:00.000Z"),
            },
          },
        },
      },
      {
        ...available,
        positions: available.positions.map((position, index) => index === candleIndex
          ? {
              ...position,
              candle: {
                ...changedCandle,
                lastSource: {
                  ...changedCandle.lastSource,
                  blockNumber: available.block.blockNumber,
                },
              },
            }
          : position),
      },
    ];
    for (const value of changed) {
      expect(() => assertStockTokenTradeHistoryData(
        { symbol: "AAPL", period: { count: 1, unit: "day" } },
        value,
      )).toThrow();
    }
    expect(() => assertStockTokenTradeHistoryData(request, {
      ...available,
      period: undefined,
    } as unknown as StockTokenTradeHistoryData)).toThrow();
  });

  it("carries the three producer semantic edge cases into exact public positions", async () => {
    const baseline = availableData();
    if (baseline.status !== "available") throw new TypeError("Expected available fixture data.");
    const block = chainAnchorSchema.parse({
      chainId: "eip155:4663",
      blockNumber: "10000000",
      blockHash: `0x${"8".repeat(64)}`,
      blockTimestamp: "2027-09-01T00:01:00.000Z",
    });
    const stockFactory = stockFactoryVerificationSchema.parse({
      ...baseline.stockFactory,
      block,
    });
    const requestInput = {
      symbol: "AAPL",
      period: { count: 1 as const, unit: "year" as const },
    };
    const selected = stockTokenTradeHistoryRequestAtBlock(requestInput, block);
    const build = async (
      createFixture: () => ReturnType<typeof createStockTokenTradeHistoryPositivePreviousOwnerFixture>,
    ) => {
      const fixture = createFixture();
      const source = createStockTokenTradeHistorySource({
        transport: fixture.transport,
        now: () => new Date("2027-09-01T00:01:00.000Z"),
      });
      try {
        const sourceResult = await source.read({
          baseCurrencyAddress: baseline.officialAsset.member.contractAddress,
          baseCurrencyDecimals: baseline.tokenDecimals.value,
          requestedStart: selected.requestedStart,
          requestedEnd: selected.requestedEnd,
          canonicalBlock: block,
          resolution: selected.resolution.label,
        });
        return createStockTokenTradeHistoryArchiveResult({
          request: requestInput,
          officialAsset: baseline.officialAsset,
          block,
          stockFactory,
          tokenDecimals: baseline.tokenDecimals.value,
          source: sourceResult,
        });
      } finally {
        await source.close();
      }
    };

    const positive = await build(createStockTokenTradeHistoryPositivePreviousOwnerFixture);
    if (positive.status !== "available") throw new TypeError("Expected positive edge data.");
    const positivePosition = positive.positions.find((position) => position.candle !== null);
    expect(positivePosition).toMatchObject({
      coverage: "partial",
      poolId: expect.any(String),
      candle: { intervalStart: "2026-08-31T00:00:00.000Z" },
    });
    expect(projectStockTokenTradeHistoryEvidenceStages(positive).archive.claim).toMatchObject({
      archive: {
        monthMembers: [{ ownerMonth: "2026-08" }, { ownerMonth: "2026-09" }],
        resolutionMembers: [{ ownerMonth: "2026-08" }],
      },
      positions: expect.arrayContaining([expect.objectContaining({
        coverage: "partial",
        candle: expect.objectContaining({ intervalStart: "2026-08-31T00:00:00.000Z" }),
      })]),
    });
    expect(() => assertStockTokenTradeHistoryData(requestInput, {
      ...positive,
      positions: positive.positions.map((position) => position === positivePosition
        ? { ...position, coverage: "complete" as const }
        : position),
    })).toThrow("position coverage");

    for (const createFixture of [
      createStockTokenTradeHistoryIncompleteWithSwapFixture,
      createStockTokenTradeHistoryCrossPoolFixture,
    ]) {
      const data = await build(createFixture);
      if (data.status !== "available") throw new TypeError("Expected partial edge data.");
      expect(data.positions.find((position) => position.coverage === "partial"))
        .toMatchObject({ coverage: "partial", poolId: null, candle: null });
      expect(projectStockTokenTradeHistoryEvidenceStages(data).archive.claim).toMatchObject({
        positions: expect.arrayContaining([expect.objectContaining({
          coverage: "partial",
          poolId: null,
          candle: null,
        })]),
      });
      expect(Object.keys(data.archive.pools).sort()).toEqual(
        [...new Set(data.positions.flatMap((position) =>
          position.poolId === null ? [] : [position.poolId]))].sort(),
      );
    }
  });

  it("re-admits identities and observation time on stage-complete unavailable results", () => {
    const available = availableData();
    if (available.status !== "available") throw new TypeError("Expected available fixture data.");
    expect(() => assertStockTokenTradeHistoryData(request, {
      status: "unavailable",
      reason: "stock_factory_unavailable",
      symbol: available.symbol,
      period: available.period,
      officialAsset: available.officialAsset,
      block: available.block,
      stockFactory: {
        status: "unavailable",
        member: { ...available.officialAsset.member, sourceName: "Different label" },
        reason: "source_unavailable",
      },
    })).toThrow("StockFactory unavailable identity");

    const selectedPeriodUnavailable = {
      status: "unavailable",
      symbol: available.symbol,
      period: available.period,
      officialAsset: available.officialAsset,
      block: available.block,
      stockFactory: available.stockFactory,
      tokenDecimals: available.tokenDecimals,
      requestedStart: available.requestedStart,
      requestedEnd: available.requestedEnd,
      resolution: available.resolution,
      archive: {
        status: "unavailable",
        reason: "outside_published_coverage",
        scope: "selected_period",
        observedAt: available.archive.observedAt,
        root: available.archive.root,
        base: available.archive.base,
      },
      freshness: available.freshness,
    } satisfies StockTokenTradeHistoryData;
    expect(() => assertStockTokenTradeHistoryData(request, selectedPeriodUnavailable)).not.toThrow();
    expect(projectStockTokenTradeHistoryEvidenceStages(selectedPeriodUnavailable).archive.outcome)
      .toBe("observed");
    const selectedBaseUnavailable = {
      ...selectedPeriodUnavailable,
      archive: {
        status: "unavailable" as const,
        reason: "asset_not_supported" as const,
        scope: "selected_base" as const,
        observedAt: selectedPeriodUnavailable.archive.observedAt,
        root: selectedPeriodUnavailable.archive.root,
      },
    } satisfies StockTokenTradeHistoryData;
    expect(() => assertStockTokenTradeHistoryData(request, selectedBaseUnavailable)).not.toThrow();
    expect(projectStockTokenTradeHistoryEvidenceStages(selectedBaseUnavailable).archive.outcome)
      .toBe("observed");
    const catalogUnavailable = unavailableData();
    expect(projectStockTokenTradeHistoryEvidenceStages(catalogUnavailable).archive.outcome)
      .toBe("source_failed");
    expect(projectStockTokenTradeHistoryEvidenceStages({
      ...selectedPeriodUnavailable,
      archive: { ...selectedPeriodUnavailable.archive, reason: "trade_history_inconsistent" },
    }).archive.outcome).toBe("source_inconsistent");
    expect(projectStockTokenTradeHistoryEvidenceStages(available).official.claim).toEqual({
      snapshot: available.officialAsset.snapshot,
      member: available.officialAsset.member,
    });
    expect(() => assertStockTokenTradeHistoryData(request, {
      ...selectedPeriodUnavailable,
      archive: {
        ...selectedPeriodUnavailable.archive,
        base: {
          ...selectedPeriodUnavailable.archive.base,
          baseCurrencyAddress: parseEvmAddress("0x0000000000000000000000000000000000000001"),
        },
      },
    })).toThrow("selected base identity");

    expect(() => assertStockTokenTradeHistoryDataAt({
      ...available,
      officialAsset: {
        ...available.officialAsset,
        snapshot: {
          ...available.officialAsset.snapshot,
          sourceObservedAt: parseUtcTimestamp("2026-08-24T07:00:02.000Z"),
        },
      },
    }, parseUtcTimestamp("2026-08-24T07:00:01.000Z"))).toThrow("observation");
  });

  it("owns the accepted initial feature success maximum", () => {
    expect(getCapabilityDefinitionSnapshot(stockTokenTradeHistoryCapability).maximumSuccessUtf8Bytes)
      .toBe(stockTokenTradeHistoryMaximumSuccessUtf8Bytes);
  });
});
