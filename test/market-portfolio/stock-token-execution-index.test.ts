import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  canonicalJsonStringify,
  sha256Bytes,
  type CanonicalJson,
} from "../../src/core/index.js";
import {
  decodeStockTokenExecutionIndexDay,
  decodeStockTokenExecutionIndexMonth,
  decodeStockTokenExecutionIndexState,
} from "../../src/market-portfolio/stock-token-execution-index-artifact.js";
import {
  canonicalStockTokenExecutionIndexJson,
  createStockTokenExecutionSeries,
  findStockTokenExecutionIndexAssetByPairId,
  stockTokenExecutionArtifactCandleSchema,
  stockTokenExecutionIndexDaySchema,
  stockTokenExecutionIndexRegistry,
  stockTokenExecutionIndexRegistrySha256,
  stockTokenExecutionIndexStateSchema,
  stockTokenExecutionSeriesLimits,
  stockTokenExecutionSeriesSchema,
} from "../../src/market-portfolio/stock-token-execution-index.js";
import { stockTokenExecutionIndexRegistryJson } from
  "../../src/market-portfolio/stock-token-execution-index-registry.generated.js";
import {
  buildPairExecutionIndexFixture as buildFixture,
  buildPairExecutionIndexFixtureUntil,
  encodePairExecutionArtifact as encode,
  pairExecutionIndexAsset as asset,
  pairExecutionIndexSequence as sequence,
} from "./pair-execution-index-fixture.js";

describe("pair-based Stock Token execution index contract", () => {
  it("retains the exact upstream registry and projects only the eight ERC-20 Stock Token pairs", () => {
    const bytes = readFileSync(new URL(
      "../../src/market-portfolio/stock-token-execution-index-registry.json",
      import.meta.url,
    ));
    expect(sha256Bytes(bytes)).toBe(stockTokenExecutionIndexRegistrySha256);
    expect(Buffer.from(stockTokenExecutionIndexRegistryJson, "utf8")).toEqual(bytes);
    expect(stockTokenExecutionIndexRegistry.pairs).toHaveLength(9);
    expect(stockTokenExecutionIndexRegistry.pairs.filter((entry) => entry.pair.baseAsset.kind === "native"))
      .toHaveLength(1);
    expect(stockTokenExecutionIndexRegistry.pairs.filter((entry) =>
      findStockTokenExecutionIndexAssetByPairId(entry.pair.pairId) !== undefined)).toHaveLength(8);
    expect(asset.poolId).toBe("0x3bb34a44f1b2b5f32c034c38a53065a521a47b199700fa9bd19d60985ff24bf1");
  });

  it("admits one exact pair-state file and its referenced pair-month and pair-day files", () => {
    const fixture = buildFixture();
    const selected = decodeStockTokenExecutionIndexState(
      fixture.stateEncoded.gzip,
      asset.poolId,
      sequence,
    );
    expect(selected.state).toEqual(fixture.state);
    const otherPairId = stockTokenExecutionIndexRegistry.pairs.find((entry) =>
      entry.pair.pairId !== asset.poolId)!.pair.pairId;
    expect(() => decodeStockTokenExecutionIndexState(
      fixture.stateEncoded.gzip,
      otherPairId,
      sequence,
    )).toThrow();
    expect(() => decodeStockTokenExecutionIndexState(
      fixture.stateEncoded.gzip,
      asset.poolId,
      sequence + 1,
    )).toThrow();
    const month = fixture.months[0]!;
    expect(decodeStockTokenExecutionIndexMonth(month.encoded.gzip, month.reference).month)
      .toEqual(month.month);
    const day = month.days[0]!;
    expect(decodeStockTokenExecutionIndexDay(day.encoded.gzip, day.reference).day).toEqual(day.day);

    const changed = day.encoded.gzip.slice();
    changed[changed.length - 1] = changed.at(-1)! ^ 1;
    expect(() => decodeStockTokenExecutionIndexDay(changed, day.reference)).toThrow();
    const noncanonicalJson = Buffer.from(JSON.stringify(day.day), "utf8");
    const noncanonicalGzip = new Uint8Array(gzipSync(noncanonicalJson));
    expect(() => decodeStockTokenExecutionIndexDay(noncanonicalGzip, {
      ...day.reference,
      gzipBytes: noncanonicalGzip.byteLength,
      gzipSha256: sha256Bytes(noncanonicalGzip),
      jsonBytes: noncanonicalJson.byteLength,
      jsonSha256: sha256Bytes(noncanonicalJson),
    })).toThrow();
  });

  it("merges exact pair days across a UTC month boundary without exposing storage groups", () => {
    const fixture = buildFixture();
    const result = createStockTokenExecutionSeries({
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
      artifact: {
        pairId: asset.poolId,
        months: [{ month: "2026-07" }, { month: "2026-08" }],
        days: [{ day: "2026-07-31" }, { day: "2026-08-01" }],
      },
      candles: [
        { intervalStart: "2026-07-31T23:59:00.000Z", tokenVolumeRaw: "1000000000000000000" },
        { intervalStart: "2026-08-01T00:00:00.000Z", tokenVolumeRaw: "1000000000000000000" },
        { intervalStart: "2026-08-01T00:01:00.000Z", tokenVolumeRaw: "1000000000000000000" },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("group");
    expect(JSON.stringify(result)).not.toContain("baseVolumeRaw");
    if (result.status !== "available") throw new TypeError("Expected available execution history.");
    expect(result.displaySeries).toMatchObject({
      window: "1d",
      requestedStart: "2026-07-31T12:01:30.000Z",
      requestedEnd: "2026-08-01T12:01:30.000Z",
      source: {
        poolId: asset.poolId,
        token: { address: asset.token, decimals: asset.tokenDecimals, symbol: asset.symbol },
        quoteToken: { symbol: "USDG" },
      },
    });
    expect(result.displaySeries.positions).toHaveLength(97);
    expect(result.displaySeries.positions[0]).toMatchObject({
      intervalStart: "2026-07-31T12:00:00.000Z",
      representedStart: "2026-07-31T12:01:30.000Z",
      coverage: "unavailable",
      candle: null,
    });
    expect(result.displaySeries.positions.at(-1)).toMatchObject({
      intervalStart: "2026-08-01T12:00:00.000Z",
      representedEnd: "2026-08-01T12:01:30.000Z",
      coverage: "partial",
      candle: null,
    });
    const observedPositions = result.displaySeries.positions.filter((position) => position.candle !== null);
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

    const aggregateIndex = result.displaySeries.positions.indexOf(observedPositions[1]!);
    const aboveMaximumVolume = (240n * (10n ** 78n - 1n) + 1n).toString();
    const replaceAggregate = (candle: Record<string, unknown>) => ({
      ...result,
      displaySeries: {
        ...result.displaySeries,
        positions: result.displaySeries.positions.map((position, index) => index === aggregateIndex
          ? { ...position, candle: { ...position.candle!, ...candle } }
          : position),
      },
    });
    expect(() => stockTokenExecutionSeriesSchema.parse({
      ...replaceAggregate({ quoteVolumeRaw: aboveMaximumVolume }),
    })).toThrow();
    const aboveObservedSpanVolume = (2n * (10n ** 78n - 1n) + 1n).toString();
    expect(() => stockTokenExecutionSeriesSchema.parse(
      replaceAggregate({ quoteVolumeRaw: aboveObservedSpanVolume }),
    )).toThrow();
    const aboveMaximumTradeCount = (240n * BigInt(Number.MAX_SAFE_INTEGER) + 1n).toString();
    expect(() => stockTokenExecutionSeriesSchema.parse(
      replaceAggregate({ tradeCount: aboveMaximumTradeCount }),
    )).toThrow();
    expect(() => stockTokenExecutionSeriesSchema.safeParse(
      replaceAggregate({ tradeCount: "not-a-number" }),
    )).not.toThrow();
    expect(() => stockTokenExecutionSeriesSchema.parse({
      ...result,
      displaySeries: {
        ...result.displaySeries,
        source: {
          ...result.displaySeries.source,
          token: {
            ...result.displaySeries.source.token,
            decimals: result.displaySeries.source.token.decimals + 1,
          },
        },
      },
    })).toThrow();
    expect(() => stockTokenExecutionSeriesSchema.parse(replaceAggregate({
      firstSource: {
        ...observedPositions[1]!.candle!.firstSource,
        blockHash: `0x${"ef".repeat(32)}`,
      },
    }))).toThrow();
    expect(() => stockTokenExecutionSeriesSchema.parse(replaceAggregate({
      firstSource: {
        ...observedPositions[1]!.candle!.firstSource,
        blockNumber: "36009999",
        blockHash: `0x${"ed".repeat(32)}`,
        transactionHash: `0x${"ec".repeat(32)}`,
      },
    }))).toThrow();
    expect(() => stockTokenExecutionSeriesSchema.parse(replaceAggregate({
      firstSource: {
        ...observedPositions[1]!.candle!.firstSource,
        blockNumber: "36010000",
        blockHash: `0x${"e9".repeat(32)}`,
        transactionHash: `0x${"e8".repeat(32)}`,
      },
    }))).toThrow();
    const unwitnessedPositionIndex = result.displaySeries.positions.findIndex((position) =>
      position.intervalStart === "2026-08-01T00:15:00.000Z");
    expect(unwitnessedPositionIndex).toBeGreaterThan(aggregateIndex);
    expect(() => stockTokenExecutionSeriesSchema.parse({
      ...result,
      displaySeries: {
        ...result.displaySeries,
        positions: result.displaySeries.positions.map((position, index) => index === unwitnessedPositionIndex
          ? {
              ...position,
              candle: {
                ...observedPositions[1]!.candle!,
                firstSource: {
                  blockNumber: "36010003",
                  blockHash: `0x${"e1".repeat(32)}`,
                  transactionIndex: 0,
                  transactionHash: `0x${"e2".repeat(32)}`,
                  logIndex: 0,
                },
                lastSource: {
                  blockNumber: "36010004",
                  blockHash: `0x${"e3".repeat(32)}`,
                  transactionIndex: 0,
                  transactionHash: `0x${"e4".repeat(32)}`,
                  logIndex: 0,
                },
                observedStart: "2026-08-01T00:15:00.000Z",
                observedEnd: "2026-08-01T00:17:00.000Z",
              },
            }
          : position),
      },
    })).toThrow();
    const aligned = createStockTokenExecutionSeries({
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
    if (aligned.status !== "available") throw new TypeError("Expected aligned execution history.");
    expect(aligned.displaySeries.positions).toHaveLength(96);
    expect(() => stockTokenExecutionSeriesSchema.parse({
      ...result,
      displaySeries: {
        ...result.displaySeries,
        positions: result.displaySeries.positions.map((position, index) => index === 1
          ? { ...position, intervalStart: result.displaySeries.positions[0]!.intervalStart }
          : position),
      },
    })).toThrow();
  });

  it("applies the canonical candle capacity only after all requested days are merged", () => {
    const fixture = buildFixture(new Set(["2026-08-11", "2026-08-12", "2026-08-13"]));
    const august = fixture.months[1]!;
    const requestedDays = fixture.days.filter((entry) =>
      entry.day.day >= "2026-08-07" && entry.day.day <= "2026-08-13");
    const result = createStockTokenExecutionSeries({
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
    expect(result.detail.observedCandleCount).toBe(4_320);
    expect(result.detail).toMatchObject({
      status: "limited",
      limitations: ["candle_capacity"],
    });
    expect(result.candles).toHaveLength(stockTokenExecutionSeriesLimits.candles);
    expect(result.candles[0]?.intervalStart).toBe("2026-08-11T20:48:00.000Z");
    expect(result.candles.at(-1)?.intervalEnd).toBe("2026-08-14T00:00:00.000Z");
    expect(result.displaySeries.positions).toHaveLength(168);
    expect(result.displaySeries.positions[0]).toMatchObject({
      intervalStart: "2026-08-07T00:00:00.000Z",
      coverage: "complete",
      candle: null,
    });
    const earlyDisplay = result.displaySeries.positions.find((position) =>
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
    expect(Date.parse(earlyDisplay!.candle!.observedStart)).toBeLessThan(
      Date.parse(result.candles[0]!.intervalStart),
    );
    const latestDisplayIndex = result.displaySeries.positions.findLastIndex((position) =>
      position.candle !== null);
    const latestDisplay = result.displaySeries.positions[latestDisplayIndex]!;
    expect(latestDisplay.candle?.lastSource).toEqual(result.candles.at(-1)?.lastSource);
    expect(() => stockTokenExecutionSeriesSchema.parse({
      ...result,
      displaySeries: {
        ...result.displaySeries,
        positions: result.displaySeries.positions.map((position, index) => index === latestDisplayIndex
          ? {
              ...position,
              candle: {
                ...position.candle!,
                lastSource: {
                  ...position.candle!.lastSource,
                  blockNumber: (BigInt(position.candle!.lastSource.blockNumber) + 1n).toString(),
                  blockHash: `0x${"d9".repeat(32)}`,
                  transactionHash: `0x${"d8".repeat(32)}`,
                },
              },
            }
          : position),
      },
    })).toThrow();
    expect(stockTokenExecutionSeriesSchema.safeParse({
      ...result,
      detail: { ...result.detail, observedCandleCount: 43_200 },
    }).success).toBe(false);

    expect(() => stockTokenExecutionSeriesSchema.parse({
      ...result,
      artifact: { ...result.artifact, coveredUntilTimestamp: result.requestedStart },
      freshness: "stale",
    })).toThrow();

    const stale = createStockTokenExecutionSeries({
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
    if (stale.status !== "available") throw new TypeError("Expected stale execution history.");
    expect(stale.freshness).toBe("stale");
    expect(stale.coverage).toMatchObject({
      status: "partial",
      limitations: ["after_published_coverage"],
    });
    expect(stale.displaySeries.positions).toHaveLength(169);
    expect(stale.detail).toEqual(result.detail);

    const firstCoverage = result.coverage.intervals[0]!;
    expect(stockTokenExecutionSeriesSchema.safeParse({
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
    const partial = stockTokenExecutionSeriesSchema.parse({
      ...result,
      coverage: {
        status: "partial",
        intervals: [{
          ...firstCoverage,
          fromTimestamp: "2026-08-07T00:01:00.000Z",
        }, ...result.coverage.intervals.slice(1)],
        limitations: ["before_published_coverage"],
      },
      displaySeries: {
        ...result.displaySeries,
        positions: result.displaySeries.positions.map((position, index) => index === 0
          ? { ...position, coverage: "partial" }
          : position),
      },
    });
    if (partial.status !== "available") throw new TypeError("Expected partial execution history.");
    expect(partial.freshness).toBe(result.freshness);
    expect(partial.detail).toEqual(result.detail);

    expect(() => stockTokenExecutionSeriesSchema.parse({
      ...result,
      artifact: {
        ...result.artifact,
        days: result.artifact.days.map((entry, index) => index === 0
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
    const mismatchedProjection = stockTokenExecutionSeriesSchema.safeParse({
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

    expect(() => stockTokenExecutionSeriesSchema.parse({
      ...result,
      requestedStart: "2026-08-10T00:00:00.000Z",
      requestedEnd: "2026-08-11T00:00:00.000Z",
      coverage: { ...result.coverage, status: "partial", limitations: ["before_published_coverage"] },
      detail: { status: "complete", observedCandleCount: 0, limitations: [] },
      candles: [],
    })).toThrow();

    expect(() => stockTokenExecutionSeriesSchema.parse({
      ...result,
      coverage: { ...result.coverage, limitations: ["before_published_coverage"] },
    })).toThrow();
    expect(() => stockTokenExecutionSeriesSchema.parse({
      ...result,
      detail: { status: "complete", observedCandleCount: 4_320, limitations: [] },
    })).toThrow();
    expect(() => stockTokenExecutionSeriesSchema.parse({
      ...result,
      coverage: { ...result.coverage, limitations: ["candle_capacity"] },
    })).toThrow();
    expect(() => stockTokenExecutionSeriesSchema.parse({
      ...result,
      coverage: { ...result.coverage, limitations: ["stale_index"] },
    })).toThrow();
    let emptyCoverageAdmission: ReturnType<typeof stockTokenExecutionSeriesSchema.safeParse> | undefined;
    expect(() => {
      emptyCoverageAdmission = stockTokenExecutionSeriesSchema.safeParse({
        ...result,
        coverage: { ...result.coverage, intervals: [] },
      });
    }).not.toThrow();
    expect(emptyCoverageAdmission?.success).toBe(false);
  });

  it("admits the maximum three pair-month and 31 pair-day inputs without changing public endpoints", () => {
    const fixture = buildPairExecutionIndexFixtureUntil("2027-03-02T12:01:00.000Z");
    const requestedStart = "2027-01-31T12:00:30.000Z";
    const requestedEnd = "2027-03-02T12:00:30.000Z";
    const months = fixture.months.filter((entry) =>
      entry.month.month >= "2027-01" && entry.month.month <= "2027-03");
    const days = fixture.days.filter((entry) =>
      entry.day.coverage.untilTimestamp > requestedStart &&
      entry.day.coverage.fromTimestamp < requestedEnd);
    const result = createStockTokenExecutionSeries({
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
      artifact: {
        months: [{ month: "2027-01" }, { month: "2027-02" }, { month: "2027-03" }],
      },
    });
    if (result.status !== "available") throw new TypeError("Expected available execution history.");
    expect(result.artifact.days).toHaveLength(31);
    expect(result.coverage.intervals).toHaveLength(31);
    expect(result.displaySeries.positions).toHaveLength(181);
    expect(result.displaySeries.positions.every((position) => position.candle === null)).toBe(true);
    expect(result.displaySeries.positions[0]?.coverage).toBe("partial");
    expect(result.displaySeries.positions.at(-1)?.coverage).toBe("partial");
    const alignedStart = "2027-01-31T12:00:00.000Z";
    const alignedEnd = "2027-03-02T12:00:00.000Z";
    const aligned = createStockTokenExecutionSeries({
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
    if (aligned.status !== "available") throw new TypeError("Expected aligned execution history.");
    expect(aligned.displaySeries.positions).toHaveLength(180);
  });

  it("rejects a broken owner reference and a candle outside its day coverage", () => {
    const fixture = buildFixture();
    expect(() => stockTokenExecutionIndexStateSchema.parse({
      ...fixture.state,
      months: fixture.state.months.map((entry, index) => index === 1
        ? { ...entry, coverage: { ...entry.coverage, fromBlock: "36010001" } }
        : entry),
    })).toThrow();

    const july = fixture.days[0]!;
    const august = fixture.days[1]!;
    expect(july.day.candles).toHaveLength(1);
    expect(() => stockTokenExecutionIndexDaySchema.parse({
      ...august.day,
      candles: august.day.candles.map((entry) => ({
        ...entry,
        firstSource: { ...entry.firstSource, blockNumber: "36000001" },
        lastSource: { ...entry.lastSource, blockNumber: "36000001" },
      })),
    })).toThrow();
  });

  it("rejects impossible Swap ranges and cross-day position contradictions", () => {
    const fixture = buildFixture();
    const first = fixture.days[0]!.day.candles[0]!;
    expect(() => stockTokenExecutionArtifactCandleSchema.parse({
      ...first,
      tradeCount: 2,
      lastSource: {
        ...first.lastSource,
        transactionIndex: first.lastSource.transactionIndex + 1,
        transactionHash: `0x${"ab".repeat(32)}`,
      },
    })).toThrow();

    const result = createStockTokenExecutionSeries({
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
    if (result.status !== "available") throw new TypeError("Expected available execution history.");
    expect(() => stockTokenExecutionSeriesSchema.parse({
      ...result,
      candles: result.candles.map((entry, index) => index === 1
        ? {
            ...entry,
            firstSource: { ...entry.firstSource, blockHash: result.candles[0]!.firstSource.blockHash },
            lastSource: { ...entry.lastSource, blockHash: result.candles[0]!.firstSource.blockHash },
          }
        : entry),
    })).toThrow();
  });

  it("uses the same canonical bytes as the repository-wide canonical JSON encoder", () => {
    const fixture = buildFixture();
    expect(canonicalStockTokenExecutionIndexJson(fixture.state)).toBe(
      canonicalJsonStringify(fixture.state as unknown as CanonicalJson),
    );
  });
});
