import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  canonicalJsonStringify,
  productUsdgAsset,
  sha256Bytes,
  type CanonicalJson,
} from "../../src/core/index.js";
import {
  decodeStockTokenTradeHistoryDay,
  decodeStockTokenTradeHistoryMonth,
  decodeStockTokenTradeHistoryState,
} from "../../src/stock-token-trade-history/stock-token-trade-history-file.js";
import {
  serializeStockTokenTradeHistoryFileJson,
  createStockTokenTradeHistoryData,
  findStockTokenTradeHistoryAssetByPairId,
  stockTokenTradeHistoryFileCandleSchema,
  stockTokenTradeHistoryDaySchema,
  stockTokenTradeHistoryRegistry,
  stockTokenTradeHistoryRegistrySha256,
  stockTokenTradeHistoryStateSchema,
  stockTokenTradeHistoryDataSchema,
} from "../../src/stock-token-trade-history/stock-token-trade-history-data.js";
import { stockTokenTradeHistoryRegistryJson } from
  "../../src/stock-token-trade-history/stock-token-trade-history-registry.generated.js";
import {
  buildPairTradeHistoryFixture as buildFixture,
  buildPairTradeHistoryFixtureUntil,
  encodePairTradeHistoryFile as encode,
  pairTradeHistoryAsset as asset,
  pairTradeHistorySequence as sequence,
} from "./pair-trade-history-data-fixture.js";

describe("Stock Token trade-history data contract", () => {
  it("admits the exact product registry with only the eight Stock Token/USDG pairs", () => {
    const bytes = readFileSync(new URL(
      "../../src/stock-token-trade-history/stock-token-trade-history-registry.json",
      import.meta.url,
    ));
    expect(sha256Bytes(bytes)).toBe(stockTokenTradeHistoryRegistrySha256);
    expect(Buffer.from(stockTokenTradeHistoryRegistryJson, "utf8")).toEqual(bytes);
    expect(stockTokenTradeHistoryRegistry.pairs).toHaveLength(8);
    expect(stockTokenTradeHistoryRegistry.pairs.every(({ pair }) =>
      pair.chainId === productUsdgAsset.chainId &&
      pair.quoteAsset.address === productUsdgAsset.address)).toBe(true);
    expect(stockTokenTradeHistoryRegistry.pairs.every((entry) =>
      findStockTokenTradeHistoryAssetByPairId(entry.pair.pairId) !== undefined)).toBe(true);
    expect(asset.poolId).toBe("0x3bb34a44f1b2b5f32c034c38a53065a521a47b199700fa9bd19d60985ff24bf1");
  });

  it("admits one exact pair-state file and its referenced pair-month and pair-day files", () => {
    const fixture = buildFixture();
    const selected = decodeStockTokenTradeHistoryState(
      fixture.stateEncoded.gzip,
      asset.poolId,
      sequence,
    );
    expect(selected.state).toEqual(fixture.state);
    const otherPairId = stockTokenTradeHistoryRegistry.pairs.find((entry) =>
      entry.pair.pairId !== asset.poolId)!.pair.pairId;
    expect(() => decodeStockTokenTradeHistoryState(
      fixture.stateEncoded.gzip,
      otherPairId,
      sequence,
    )).toThrow();
    expect(() => decodeStockTokenTradeHistoryState(
      fixture.stateEncoded.gzip,
      asset.poolId,
      sequence + 1,
    )).toThrow();
    const month = fixture.months[0]!;
    expect(decodeStockTokenTradeHistoryMonth(month.encoded.gzip, month.reference).month)
      .toEqual(month.month);
    const day = month.days[0]!;
    expect(decodeStockTokenTradeHistoryDay(day.encoded.gzip, day.reference).day).toEqual(day.day);

    const changed = day.encoded.gzip.slice();
    changed[changed.length - 1] = changed.at(-1)! ^ 1;
    expect(() => decodeStockTokenTradeHistoryDay(changed, day.reference)).toThrow();
    const noncanonicalJson = Buffer.from(JSON.stringify(day.day), "utf8");
    const noncanonicalGzip = new Uint8Array(gzipSync(noncanonicalJson));
    expect(() => decodeStockTokenTradeHistoryDay(noncanonicalGzip, {
      ...day.reference,
      gzipBytes: noncanonicalGzip.byteLength,
      gzipSha256: sha256Bytes(noncanonicalGzip),
      jsonBytes: noncanonicalJson.byteLength,
      jsonSha256: sha256Bytes(noncanonicalJson),
    })).toThrow();
  });

  it("merges exact pair days across a UTC month boundary without exposing storage groups", () => {
    const fixture = buildFixture();
    const result = createStockTokenTradeHistoryData({
      request: {
        pairId: asset.poolId,
        window: "1d",
        requestedStart: "2026-07-31T12:01:30.000Z",
        requestedEnd: "2026-08-01T12:01:30.000Z",
      },
      asset,
      state: fixture.state,
      stateSha256: fixture.stateEncoded.jsonSha256,
      months: fixture.months.map((entry) => ({
        reference: entry.reference,
        month: entry.month,
        sha256: entry.encoded.jsonSha256,
      })),
      days: [fixture.days[0]!, fixture.days[1]!].map((entry) => ({
        reference: entry.reference,
        day: entry.day,
        sha256: entry.encoded.jsonSha256,
      })),
    });
    expect(result).toMatchObject({
      status: "available",
      source: { poolId: asset.poolId, quoteToken: { symbol: "USDG" } },
      sourceFiles: {
        pairId: asset.poolId,
        months: [{ month: "2026-07" }, { month: "2026-08" }],
        days: [{ day: "2026-07-31" }, { day: "2026-08-01" }],
      },
    });
    expect(Object.hasOwn(result, "candles")).toBe(false);
    expect(Object.hasOwn(result, "detail")).toBe(false);
    expect(JSON.stringify(result)).not.toContain("group");
    expect(JSON.stringify(result)).not.toContain("baseVolumeRaw");
    if (result.status !== "available") throw new TypeError("Expected available trade history.");
    expect(result.chart).toMatchObject({
      window: "1d",
      requestedStart: "2026-07-31T12:01:30.000Z",
      requestedEnd: "2026-08-01T12:01:30.000Z",
      source: {
        poolId: asset.poolId,
        token: { address: asset.token, decimals: asset.tokenDecimals, symbol: asset.symbol },
        quoteToken: { symbol: "USDG" },
      },
    });
    expect(result.chart.positions).toHaveLength(97);
    expect(result.chart.positions[0]).toMatchObject({
      intervalStart: "2026-07-31T12:00:00.000Z",
      representedStart: "2026-07-31T12:01:30.000Z",
      coverage: "unavailable",
      candle: null,
    });
    expect(result.chart.positions.at(-1)).toMatchObject({
      intervalStart: "2026-08-01T12:00:00.000Z",
      representedEnd: "2026-08-01T12:01:30.000Z",
      coverage: "partial",
      candle: null,
    });
    const observedPositions = result.chart.positions.filter((position) => position.candle !== null);
    expect(observedPositions).toHaveLength(2);
    expect(observedPositions[0]).toMatchObject({
      intervalStart: "2026-07-31T23:45:00.000Z",
      coverage: "partial",
      candle: {
        tokenVolumeRaw: "1000000000000000000",
        quoteVolumeRaw: "301500000",
        tradeCount: "1",
        observedStart: "2026-07-31T23:59:00.000Z",
        observedEnd: "2026-08-01T00:00:00.000Z",
      },
    });
    expect(observedPositions[1]).toMatchObject({
      intervalStart: "2026-08-01T00:00:00.000Z",
      coverage: "complete",
      candle: {
        open: { numerator: "306", denominator: "1" },
        high: { numerator: "307", denominator: "1" },
        low: { numerator: "299", denominator: "1" },
        close: { numerator: "601", denominator: "2" },
        tokenVolumeRaw: "2000000000000000000",
        quoteVolumeRaw: "603000000",
        tradeCount: "2",
        firstSource: { blockNumber: "36010001" },
        lastSource: { blockNumber: "36010002" },
        observedStart: "2026-08-01T00:00:00.000Z",
        observedEnd: "2026-08-01T00:02:00.000Z",
      },
    });

    const aggregateIndex = result.chart.positions.indexOf(observedPositions[1]!);
    const aboveMaximumVolume = (240n * (10n ** 78n - 1n) + 1n).toString();
    const replaceAggregate = (candle: Record<string, unknown>) => ({
      ...result,
      chart: {
        ...result.chart,
        positions: result.chart.positions.map((position, index) => index === aggregateIndex
          ? { ...position, candle: { ...position.candle!, ...candle } }
          : position),
      },
    });
    expect(() => stockTokenTradeHistoryDataSchema.parse({
      ...replaceAggregate({ quoteVolumeRaw: aboveMaximumVolume }),
    })).toThrow();
    const aboveObservedSpanVolume = (2n * (10n ** 78n - 1n) + 1n).toString();
    expect(() => stockTokenTradeHistoryDataSchema.parse(
      replaceAggregate({ quoteVolumeRaw: aboveObservedSpanVolume }),
    )).toThrow();
    const aboveMaximumTradeCount = (240n * BigInt(Number.MAX_SAFE_INTEGER) + 1n).toString();
    expect(() => stockTokenTradeHistoryDataSchema.parse(
      replaceAggregate({ tradeCount: aboveMaximumTradeCount }),
    )).toThrow();
    expect(() => stockTokenTradeHistoryDataSchema.safeParse(
      replaceAggregate({ tradeCount: "not-a-number" }),
    )).not.toThrow();
    expect(() => stockTokenTradeHistoryDataSchema.parse({
      ...result,
      chart: {
        ...result.chart,
        source: {
          ...result.chart.source,
          token: {
            ...result.chart.source.token,
            decimals: result.chart.source.token.decimals + 1,
          },
        },
      },
    })).toThrow();
    expect(() => stockTokenTradeHistoryDataSchema.parse(replaceAggregate({
      firstSource: {
        ...observedPositions[1]!.candle!.firstSource,
        blockNumber: "36009999",
        blockHash: `0x${"ed".repeat(32)}`,
        transactionHash: `0x${"ec".repeat(32)}`,
      },
    }))).toThrow();
    const aligned = createStockTokenTradeHistoryData({
      request: {
        pairId: asset.poolId,
        window: "1d",
        requestedStart: "2026-07-31T12:00:00.000Z",
        requestedEnd: "2026-08-01T12:00:00.000Z",
      },
      asset,
      state: fixture.state,
      stateSha256: fixture.stateEncoded.jsonSha256,
      months: fixture.months.map((entry) => ({
        reference: entry.reference,
        month: entry.month,
        sha256: entry.encoded.jsonSha256,
      })),
      days: [fixture.days[0]!, fixture.days[1]!].map((entry) => ({
        reference: entry.reference,
        day: entry.day,
        sha256: entry.encoded.jsonSha256,
      })),
    });
    if (aligned.status !== "available") throw new TypeError("Expected aligned trade history.");
    expect(aligned.chart.positions).toHaveLength(96);
    expect(() => stockTokenTradeHistoryDataSchema.parse({
      ...result,
      chart: {
        ...result.chart,
        positions: result.chart.positions.map((position, index) => index === 1
          ? { ...position, intervalStart: result.chart.positions[0]!.intervalStart }
          : position),
      },
    })).toThrow();
  });

  it("aggregates every requested source candle without returning a second one-minute list", () => {
    const fixture = buildFixture(new Set(["2026-08-11", "2026-08-12", "2026-08-13"]));
    const august = fixture.months[1]!;
    const requestedDays = fixture.days.filter((entry) =>
      entry.day.day >= "2026-08-07" && entry.day.day <= "2026-08-13");
    const result = createStockTokenTradeHistoryData({
      request: {
        pairId: asset.poolId,
        window: "7d",
        requestedStart: "2026-08-07T00:00:00.000Z",
        requestedEnd: "2026-08-14T00:00:00.000Z",
      },
      asset,
      state: fixture.state,
      stateSha256: fixture.stateEncoded.jsonSha256,
      months: [{ reference: august.reference, month: august.month, sha256: august.encoded.jsonSha256 }],
      days: requestedDays.map((entry) => ({
        reference: entry.reference,
        day: entry.day,
        sha256: entry.encoded.jsonSha256,
      })),
    });
    expect(result.status).toBe("available");
    if (result.status !== "available") return;
    expect(result.freshness).toBe("current");
    expect(result.coverage.status).toBe("complete");
    expect(result.coverage.limitations).toEqual([]);
    expect(Object.hasOwn(result, "detail")).toBe(false);
    expect(Object.hasOwn(result, "candles")).toBe(false);
    expect(result.chart.positions).toHaveLength(168);
    expect(result.chart.positions[0]).toMatchObject({
      intervalStart: "2026-08-07T00:00:00.000Z",
      coverage: "complete",
      candle: null,
    });
    const earlyDisplay = result.chart.positions.find((position) =>
      position.intervalStart === "2026-08-11T00:00:00.000Z");
    expect(earlyDisplay).toMatchObject({
      coverage: "complete",
      candle: {
        open: { numerator: "304", denominator: "1" },
        high: { numerator: "307", denominator: "1" },
        low: { numerator: "299", denominator: "1" },
        close: { numerator: "601", denominator: "2" },
        tokenVolumeRaw: "60000000000000000000",
        quoteVolumeRaw: "18090000000",
        tradeCount: "60",
        firstSource: { blockNumber: "36110001" },
        lastSource: { blockNumber: "36110060" },
        observedStart: "2026-08-11T00:00:00.000Z",
        observedEnd: "2026-08-11T01:00:00.000Z",
      },
    });
    expect(earlyDisplay!.candle!.observedStart).toBe("2026-08-11T00:00:00.000Z");

    expect(() => stockTokenTradeHistoryDataSchema.parse({
      ...result,
      sourceFiles: { ...result.sourceFiles, coveredUntilTimestamp: result.requestedStart },
      freshness: "stale",
    })).toThrow();

    const stale = createStockTokenTradeHistoryData({
      request: {
        pairId: asset.poolId,
        window: "7d",
        requestedStart: "2026-08-07T14:34:00.000Z",
        requestedEnd: "2026-08-14T14:34:00.000Z",
      },
      asset,
      state: fixture.state,
      stateSha256: fixture.stateEncoded.jsonSha256,
      months: [{ reference: august.reference, month: august.month, sha256: august.encoded.jsonSha256 }],
      days: fixture.days.filter((entry) =>
        entry.day.day >= "2026-08-07" && entry.day.day <= "2026-08-14").map((entry) => ({
        reference: entry.reference,
        day: entry.day,
        sha256: entry.encoded.jsonSha256,
      })),
    });
    if (stale.status !== "available") throw new TypeError("Expected stale trade history.");
    expect(stale.freshness).toBe("stale");
    expect(stale.coverage).toMatchObject({
      status: "partial",
      limitations: ["after_published_coverage"],
    });
    expect(stale.chart.positions).toHaveLength(169);

    const firstCoverage = result.coverage.intervals[0]!;
    expect(stockTokenTradeHistoryDataSchema.safeParse({
      ...result,
      coverage: {
        status: "partial",
        intervals: [{
          ...firstCoverage,
          fromTimestamp: "2026-08-07T00:01:00.000Z",
        }, ...result.coverage.intervals.slice(1)],
        limitations: ["before_published_coverage"],
      },
    }).success).toBe(false);
    const partial = stockTokenTradeHistoryDataSchema.parse({
      ...result,
      coverage: {
        status: "partial",
        intervals: [{
          ...firstCoverage,
          fromTimestamp: "2026-08-07T00:01:00.000Z",
        }, ...result.coverage.intervals.slice(1)],
        limitations: ["before_published_coverage"],
      },
      chart: {
        ...result.chart,
        positions: result.chart.positions.map((position, index) => index === 0
          ? { ...position, coverage: "partial" }
          : position),
      },
    });
    if (partial.status !== "available") throw new TypeError("Expected partial trade history.");
    expect(partial.freshness).toBe(result.freshness);

    expect(() => stockTokenTradeHistoryDataSchema.parse({
      ...result,
      sourceFiles: {
        ...result.sourceFiles,
        days: result.sourceFiles.days.map((entry, index) => index === 0
          ? { ...entry, day: "2026-08-10" }
          : entry),
      },
    })).toThrow();

    const firstInterval = result.coverage.intervals[0]!;
    const splitTimestamp = new Date(
      (Date.parse(firstInterval.fromTimestamp) + Date.parse(firstInterval.untilTimestamp)) / 2,
    ).toISOString();
    const splitBlock = String(
      (BigInt(firstInterval.fromBlock) + BigInt(firstInterval.untilBlock)) / 2n,
    );
    const mismatchedProjection = stockTokenTradeHistoryDataSchema.safeParse({
      ...result,
      coverage: {
        ...result.coverage,
        intervals: [
          { ...firstInterval, untilBlock: splitBlock, untilTimestamp: splitTimestamp },
          { ...firstInterval, fromBlock: splitBlock, fromTimestamp: splitTimestamp },
          ...result.coverage.intervals.slice(1),
        ],
      },
    });
    expect(mismatchedProjection.success).toBe(false);

    expect(() => stockTokenTradeHistoryDataSchema.parse({
      ...result,
      requestedStart: "2026-08-10T00:00:00.000Z",
      requestedEnd: "2026-08-11T00:00:00.000Z",
      coverage: { ...result.coverage, status: "partial", limitations: ["before_published_coverage"] },
    })).toThrow();

    expect(() => stockTokenTradeHistoryDataSchema.parse({
      ...result,
      coverage: { ...result.coverage, limitations: ["before_published_coverage"] },
    })).toThrow();
    expect(() => stockTokenTradeHistoryDataSchema.parse({
      ...result,
      detail: { status: "complete", observedCandleCount: 4_320, limitations: [] },
    })).toThrow();
    expect(() => stockTokenTradeHistoryDataSchema.parse({
      ...result,
      candles: [],
    })).toThrow();
    expect(() => stockTokenTradeHistoryDataSchema.parse({
      ...result,
      coverage: { ...result.coverage, limitations: ["candle_capacity"] },
    })).toThrow();
    expect(() => stockTokenTradeHistoryDataSchema.parse({
      ...result,
      coverage: { ...result.coverage, limitations: ["stale_index"] },
    })).toThrow();
    let emptyCoverageAdmission: ReturnType<typeof stockTokenTradeHistoryDataSchema.safeParse> | undefined;
    expect(() => {
      emptyCoverageAdmission = stockTokenTradeHistoryDataSchema.safeParse({
        ...result,
        coverage: { ...result.coverage, intervals: [] },
      });
    }).not.toThrow();
    expect(emptyCoverageAdmission?.success).toBe(false);
  });

  it("admits the maximum three pair-month and 31 pair-day inputs without changing public endpoints", () => {
    const fixture = buildPairTradeHistoryFixtureUntil("2027-03-02T12:01:00.000Z");
    const requestedStart = "2027-01-31T12:00:30.000Z";
    const requestedEnd = "2027-03-02T12:00:30.000Z";
    const months = fixture.months.filter((entry) =>
      entry.month.month >= "2027-01" && entry.month.month <= "2027-03");
    const days = fixture.days.filter((entry) =>
      entry.day.coverage.untilTimestamp > requestedStart &&
      entry.day.coverage.fromTimestamp < requestedEnd);
    const result = createStockTokenTradeHistoryData({
      request: { pairId: asset.poolId, window: "30d", requestedStart, requestedEnd },
      asset,
      state: fixture.state,
      stateSha256: fixture.stateEncoded.jsonSha256,
      months: months.map((entry) => ({
        reference: entry.reference,
        month: entry.month,
        sha256: entry.encoded.jsonSha256,
      })),
      days: days.map((entry) => ({
        reference: entry.reference,
        day: entry.day,
        sha256: entry.encoded.jsonSha256,
      })),
    });
    expect(result).toMatchObject({
      status: "available",
      requestedStart,
      requestedEnd,
      sourceFiles: {
        months: [{ month: "2027-01" }, { month: "2027-02" }, { month: "2027-03" }],
      },
    });
    if (result.status !== "available") throw new TypeError("Expected available trade history.");
    expect(result.sourceFiles.days).toHaveLength(31);
    expect(result.coverage.intervals).toHaveLength(31);
    expect(result.chart.positions).toHaveLength(181);
    expect(result.chart.positions.every((position) => position.candle === null)).toBe(true);
    expect(result.chart.positions[0]?.coverage).toBe("partial");
    expect(result.chart.positions.at(-1)?.coverage).toBe("partial");
    const alignedStart = "2027-01-31T12:00:00.000Z";
    const alignedEnd = "2027-03-02T12:00:00.000Z";
    const aligned = createStockTokenTradeHistoryData({
      request: {
        pairId: asset.poolId,
        window: "30d",
        requestedStart: alignedStart,
        requestedEnd: alignedEnd,
      },
      asset,
      state: fixture.state,
      stateSha256: fixture.stateEncoded.jsonSha256,
      months: months.map((entry) => ({
        reference: entry.reference,
        month: entry.month,
        sha256: entry.encoded.jsonSha256,
      })),
      days: days.map((entry) => ({
        reference: entry.reference,
        day: entry.day,
        sha256: entry.encoded.jsonSha256,
      })),
    });
    if (aligned.status !== "available") throw new TypeError("Expected aligned trade history.");
    expect(aligned.chart.positions).toHaveLength(180);
  });

  it("rejects a broken owner reference and a candle outside its day coverage", () => {
    const fixture = buildFixture();
    expect(() => stockTokenTradeHistoryStateSchema.parse({
      ...fixture.state,
      months: fixture.state.months.map((entry, index) => index === 1
        ? { ...entry, coverage: { ...entry.coverage, fromBlock: "36010001" } }
        : entry),
    })).toThrow();

    const july = fixture.days[0]!;
    const august = fixture.days[1]!;
    expect(july.day.candles).toHaveLength(1);
    expect(() => stockTokenTradeHistoryDaySchema.parse({
      ...august.day,
      candles: august.day.candles.map((entry) => ({
        ...entry,
        firstSource: { ...entry.firstSource, blockNumber: "36000001" },
        lastSource: { ...entry.lastSource, blockNumber: "36000001" },
      })),
    })).toThrow();
  });

  it("rejects impossible Swap ranges", () => {
    const fixture = buildFixture();
    const first = fixture.days[0]!.day.candles[0]!;
    expect(() => stockTokenTradeHistoryFileCandleSchema.parse({
      ...first,
      tradeCount: 2,
      lastSource: {
        ...first.lastSource,
        transactionIndex: first.lastSource.transactionIndex + 1,
        transactionHash: `0x${"ab".repeat(32)}`,
      },
    })).toThrow();

  });

  it("uses the same canonical bytes as the repository-wide canonical JSON encoder", () => {
    const fixture = buildFixture();
    expect(serializeStockTokenTradeHistoryFileJson(fixture.state)).toBe(
      canonicalJsonStringify(fixture.state as unknown as CanonicalJson),
    );
  });
});
