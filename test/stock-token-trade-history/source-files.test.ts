import { describe, expect, it } from "vitest";

import { stockTokenTradeHistorySourceLimits } from
  "../../src/stock-token-trade-history/source-contract.js";
import { parseBaseResolutionFile } from
  "../../src/stock-token-trade-history/source-files.js";
import {
  assertStockTokenTradeHistoryPoolIdentity,
  deriveStockTokenTradeHistoryPoolId,
  stockTokenTradeHistoryPoolKeySchema,
  stockTokenTradeHistorySourceIdentity,
} from "../../src/stock-token-trade-history/source-semantics.js";

const baseAddress = "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9";
const poolId = `0x${"1".repeat(64)}`;
const uint256Maximum = (1n << 256n) - 1n;
const int128MagnitudeMaximum = 1n << 127n;
const maximumResolutionMinutes = 2_880n;
const tradeCountMaximum = maximumResolutionMinutes * BigInt(Number.MAX_SAFE_INTEGER);
const volumeMaximum = tradeCountMaximum * int128MagnitudeMaximum;
const priceNumerator = int128MagnitudeMaximum * 10n ** 249n;
const priceDenominator = int128MagnitudeMaximum - 1n;

const position = (blockNumber: string, fill: string, logIndex: number) => ({
  blockHash: `0x${fill.repeat(64)}`,
  blockNumber,
  transactionHash: `0x${(fill === "a" ? "c" : "d").repeat(64)}`,
  transactionIndex: 0,
  logIndex,
});

const resolutionValue = () => ({
  baseCurrencyAddress: baseAddress,
  candles: [{
    baseVolumeRaw: volumeMaximum.toString(),
    close: { numerator: priceNumerator.toString(), denominator: priceDenominator.toString() },
    firstSource: position("1", "a", 0),
    high: { numerator: priceNumerator.toString(), denominator: priceDenominator.toString() },
    intervalEnd: "2026-08-03T00:00:00.000Z",
    intervalStart: "2026-08-01T00:00:00.000Z",
    lastSource: position("2", "b", 0),
    low: { numerator: priceNumerator.toString(), denominator: priceDenominator.toString() },
    observedEnd: "2026-08-03T00:00:00.000Z",
    observedStart: "2026-08-01T00:00:00.000Z",
    open: { numerator: priceNumerator.toString(), denominator: priceDenominator.toString() },
    quoteVolumeRaw: volumeMaximum.toString(),
    sourceCandleCount: Number(maximumResolutionMinutes),
    tradeCount: tradeCountMaximum.toString(),
  }],
  coverage: [{
    fromBlock: "0",
    fromTimestamp: "2026-08-01T00:00:00.000Z",
    poolId,
    untilBlock: uint256Maximum.toString(),
    untilTimestamp: "2026-08-03T00:00:00.000Z",
  }],
  intervalSeconds: 172_800,
  ownerMonth: "2026-08",
});

const parse = (value: unknown, baseDecimals = 255) => parseBaseResolutionFile(
  value,
  baseAddress,
  baseDecimals,
  "2026-08",
  "2d",
  stockTokenTradeHistorySourceLimits,
);

describe("Stock Token trade-history source numeric admission", () => {
  it("binds the complete PoolKey to the exact derived PoolId", () => {
    const poolKey = stockTokenTradeHistoryPoolKeySchema.parse({
      currency0: stockTokenTradeHistorySourceIdentity.usdgAddress,
      currency1: baseAddress,
      fee: 3_000,
      hooks: "0x0000000000000000000000000000000000000000",
      tickSpacing: 60,
    });
    const derivedPoolId = deriveStockTokenTradeHistoryPoolId(poolKey);

    expect(() => assertStockTokenTradeHistoryPoolIdentity({
      poolId: derivedPoolId,
      baseCurrencyAddress: baseAddress,
      poolKey,
    })).not.toThrow();
    expect(() => assertStockTokenTradeHistoryPoolIdentity({
      poolId: `0x${"1".repeat(64)}`,
      baseCurrencyAddress: baseAddress,
      poolKey,
    })).toThrow("Pool identity is invalid.");
  });

  it("admits the reachable exact numeric maxima", () => {
    expect(parse(resolutionValue())).toBeDefined();
    for (const { baseDecimals, sourceCandleCount, tradesPerSourceCandle } of [
      { baseDecimals: 0, sourceCandleCount: 1, tradesPerSourceCandle: 1 },
      { baseDecimals: 6, sourceCandleCount: 1, tradesPerSourceCandle: 2 },
      { baseDecimals: 18, sourceCandleCount: 10, tradesPerSourceCandle: 1_000 },
    ]) {
      const value = resolutionValue();
      const candle = value.candles[0]!;
      const tradeCount = BigInt(sourceCandleCount) * BigInt(tradesPerSourceCandle);
      candle.sourceCandleCount = sourceCandleCount;
      candle.tradeCount = tradeCount.toString();
      candle.baseVolumeRaw = tradeCount.toString();
      candle.quoteVolumeRaw = tradeCount.toString();
      candle.observedEnd = new Date(
        Date.parse(candle.observedStart) + sourceCandleCount * 60_000,
      ).toISOString();
      if (tradeCount === 1n) candle.lastSource = candle.firstSource;
      const price = baseDecimals >= 6
        ? { numerator: (10n ** BigInt(baseDecimals - 6)).toString(), denominator: "1" }
        : { numerator: "1", denominator: (10n ** BigInt(6 - baseDecimals)).toString() };
      candle.open = price;
      candle.high = price;
      candle.low = price;
      candle.close = price;
      expect(parse(value, baseDecimals)).toBeDefined();
    }
  });

  it("rejects each exact maximum plus one and non-minute source coverage", () => {
    const cases = [
      () => {
        const value = resolutionValue();
        value.coverage[0]!.untilBlock = (uint256Maximum + 1n).toString();
        return value;
      },
      () => {
        const value = resolutionValue();
        value.candles[0]!.tradeCount = (tradeCountMaximum + 1n).toString();
        return value;
      },
      () => {
        const value = resolutionValue();
        value.candles[0]!.baseVolumeRaw = (volumeMaximum + 1n).toString();
        return value;
      },
      () => {
        const value = resolutionValue();
        const price = {
          numerator: ((int128MagnitudeMaximum + 1n) * 10n ** 249n).toString(),
          denominator: priceDenominator.toString(),
        };
        Object.assign(value.candles[0]!, { open: price, high: price, low: price, close: price });
        return value;
      },
      () => {
        const value = resolutionValue();
        const price = {
          numerator: ((int128MagnitudeMaximum - 1n) * 10n ** 249n).toString(),
          denominator: (int128MagnitudeMaximum + 1n).toString(),
        };
        Object.assign(value.candles[0]!, { open: price, high: price, low: price, close: price });
        return value;
      },
      () => {
        const value = resolutionValue();
        value.candles[0]!.quoteVolumeRaw = (tradeCountMaximum - 1n).toString();
        return value;
      },
      () => {
        const value = resolutionValue();
        value.candles[0]!.sourceCandleCount = Number(maximumResolutionMinutes) + 1;
        return value;
      },
      () => {
        const value = resolutionValue();
        value.coverage[0]!.fromTimestamp = "2026-08-01T00:00:01.000Z";
        return value;
      },
    ];
    for (const create of cases) expect(() => parse(create())).toThrow();
  });
});
