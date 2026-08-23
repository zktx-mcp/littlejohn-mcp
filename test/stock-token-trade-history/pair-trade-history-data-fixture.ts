import { gzipSync } from "node:zlib";

import { parseEvmAddress, sha256Bytes } from "../../src/core/index.js";
import {
  serializeStockTokenTradeHistoryFileJson,
  findStockTokenTradeHistoryAsset,
  stockTokenTradeHistoryFileCandleSchema,
  stockTokenTradeHistoryDaySchema,
  stockTokenTradeHistoryMonthSchema,
  stockTokenTradeHistoryStateSchema,
  stockTokenTradePairDayLogicalId,
  stockTokenTradePairMonthLogicalId,
  type StockTokenTradeHistoryFileReference,
  type StockTokenTradeCoverageInterval,
  type StockTokenTradeHistoryDay,
  type StockTokenTradeHistoryMonth,
} from "../../src/stock-token-trade-history/stock-token-trade-history-data.js";

export const pairTradeHistoryAsset = findStockTokenTradeHistoryAsset(parseEvmAddress(
  "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec",
))!;
export const pairTradeHistorySequence = 2;

export const encodePairTradeHistoryFile = (value: unknown) => {
  const json = Buffer.from(serializeStockTokenTradeHistoryFileJson(value), "utf8");
  const gzip = new Uint8Array(gzipSync(json, { level: 9 }));
  return Object.freeze({
    json,
    gzip,
    jsonSha256: sha256Bytes(json),
    gzipSha256: sha256Bytes(gzip),
  });
};

const reference = (
  logicalId: string,
  coverage: StockTokenTradeCoverageInterval,
  encoded: ReturnType<typeof encodePairTradeHistoryFile>,
): StockTokenTradeHistoryFileReference => Object.freeze({
  logicalId,
  sequence: pairTradeHistorySequence,
  coverage,
  jsonBytes: encoded.json.byteLength,
  jsonSha256: encoded.jsonSha256,
  gzipBytes: encoded.gzip.byteLength,
  gzipSha256: encoded.gzipSha256,
});

const hash = (value: number): `0x${string}` =>
  `0x${value.toString(16).padStart(64, "0")}`;
const candle = (start: string, block: number) => {
  const open = 300 + block % 7;
  return stockTokenTradeHistoryFileCandleSchema.parse({
  intervalStart: start,
  intervalEnd: new Date(Date.parse(start) + 60_000).toISOString(),
  open: { numerator: open.toString(), denominator: "1" },
  high: { numerator: (open + 1).toString(), denominator: "1" },
  low: { numerator: (open - 1).toString(), denominator: "1" },
  close: { numerator: (open * 2 + 1).toString(), denominator: "2" },
  baseVolumeRaw: "1000000000000000000",
  quoteVolumeRaw: "301500000",
  tradeCount: 1,
  firstSource: {
    blockNumber: block.toString(),
    blockHash: hash(block),
    transactionIndex: 0,
    transactionHash: hash(block + 1_000_000),
    logIndex: 0,
  },
  lastSource: {
    blockNumber: block.toString(),
    blockHash: hash(block),
    transactionIndex: 0,
    transactionHash: hash(block + 1_000_000),
    logIndex: 0,
  },
});
};

export interface PairDayFixture {
  readonly reference: StockTokenTradeHistoryFileReference;
  readonly day: StockTokenTradeHistoryDay;
  readonly encoded: ReturnType<typeof encodePairTradeHistoryFile>;
}
export interface PairMonthFixture {
  readonly reference: StockTokenTradeHistoryFileReference;
  readonly month: StockTokenTradeHistoryMonth;
  readonly encoded: ReturnType<typeof encodePairTradeHistoryFile>;
  readonly days: readonly PairDayFixture[];
}

interface PairDayDefinition {
    day: string;
    fromTimestamp: string;
    untilTimestamp: string;
    fromBlock: number;
    untilBlock: number;
}

const buildFixture = (
  definitions: readonly Readonly<PairDayDefinition>[],
  denseDays: ReadonlySet<string>,
) => {
  const days = definitions.map((definition): PairDayFixture => {
    const coverage = {
      fromBlock: definition.fromBlock.toString(),
      fromTimestamp: definition.fromTimestamp,
      untilBlock: definition.untilBlock.toString(),
      untilTimestamp: definition.untilTimestamp,
    };
    const count = denseDays.has(definition.day)
      ? Math.floor((Date.parse(definition.untilTimestamp) - Date.parse(definition.fromTimestamp)) / 60_000)
      : 0;
    const candles = Array.from({ length: count }, (_, index) =>
      candle(new Date(Date.parse(definition.fromTimestamp) + index * 60_000).toISOString(), definition.fromBlock + index + 1));
    if (definition.day === "2026-07-31" && !denseDays.has(definition.day)) {
      candles.push(candle("2026-07-31T23:59:00.000Z", definition.fromBlock + 2));
    }
    if (definition.day === "2026-08-01" && !denseDays.has(definition.day)) {
      candles.push(candle("2026-08-01T00:00:00.000Z", definition.fromBlock + 1));
      candles.push(candle("2026-08-01T00:01:00.000Z", definition.fromBlock + 2));
    }
    const day = stockTokenTradeHistoryDaySchema.parse({
      candles,
      contractVersion: "1",
      coverage,
      day: definition.day,
      kind: "pair_candle_day",
      pair: pairTradeHistoryAsset.pair,
      sequence: pairTradeHistorySequence,
    });
    const encoded = encodePairTradeHistoryFile(day);
    return {
      day,
      encoded,
      reference: reference(
        stockTokenTradePairDayLogicalId(pairTradeHistoryAsset.poolId, definition.day),
        day.coverage,
        encoded,
      ),
    };
  });
  const monthKeys = [...new Set(days.map((entry) => entry.day.day.slice(0, 7)))];
  const months = monthKeys.map((month): PairMonthFixture => {
    const monthDays = days.filter((entry) => entry.day.day.startsWith(month));
    const value = stockTokenTradeHistoryMonthSchema.parse({
      contractVersion: "1",
      coverage: {
        fromBlock: monthDays[0]!.day.coverage.fromBlock,
        fromTimestamp: monthDays[0]!.day.coverage.fromTimestamp,
        untilBlock: monthDays.at(-1)!.day.coverage.untilBlock,
        untilTimestamp: monthDays.at(-1)!.day.coverage.untilTimestamp,
      },
      days: monthDays.map((entry) => entry.reference),
      kind: "pair_candle_month",
      month,
      pair: pairTradeHistoryAsset.pair,
      sequence: pairTradeHistorySequence,
    });
    const encoded = encodePairTradeHistoryFile(value);
    return {
      month: value,
      encoded,
      days: monthDays,
      reference: reference(
        stockTokenTradePairMonthLogicalId(pairTradeHistoryAsset.poolId, month),
        value.coverage,
        encoded,
      ),
    };
  });
  const state = stockTokenTradeHistoryStateSchema.parse({
    contractVersion: "1",
    coverage: {
      fromBlock: months[0]!.month.coverage.fromBlock,
      fromTimestamp: months[0]!.month.coverage.fromTimestamp,
      untilBlock: months.at(-1)!.month.coverage.untilBlock,
      untilTimestamp: months.at(-1)!.month.coverage.untilTimestamp,
    },
    kind: "pair_candle_state",
    months: months.map((entry) => entry.reference),
    pair: pairTradeHistoryAsset.pair,
    sequence: pairTradeHistorySequence,
  });
  return Object.freeze({
    state,
    stateEncoded: encodePairTradeHistoryFile(state),
    months,
    days,
  });
};

export const buildPairTradeHistoryFixture = (
  denseDays: ReadonlySet<string> = new Set(),
) => {
  const definitions: Array<Readonly<PairDayDefinition>> = [{
    day: "2026-07-31",
    fromTimestamp: "2026-07-31T23:58:00.000Z",
    untilTimestamp: "2026-08-01T00:00:00.000Z",
    fromBlock: 36_000_000,
    untilBlock: 36_010_000,
  }];
  for (let date = 1; date <= 14; date += 1) {
    definitions.push({
      day: `2026-08-${date.toString().padStart(2, "0")}`,
      fromTimestamp: `2026-08-${date.toString().padStart(2, "0")}T00:00:00.000Z`,
      untilTimestamp: date === 14
        ? "2026-08-14T14:03:00.000Z"
        : `2026-08-${(date + 1).toString().padStart(2, "0")}T00:00:00.000Z`,
      fromBlock: 36_000_000 + date * 10_000,
      untilBlock: date === 14 ? 36_308_200 : 36_000_000 + (date + 1) * 10_000,
    });
  }

  return buildFixture(definitions, denseDays);
};

export const buildPairTradeHistoryFixtureUntil = (untilTimestamp: string) => {
  const until = Date.parse(untilTimestamp);
  let cursor = Date.parse("2026-07-31T23:58:00.000Z");
  let block = 36_000_000;
  const definitions: PairDayDefinition[] = [];
  while (cursor < until) {
    const nextDay = new Date(cursor);
    nextDay.setUTCHours(24, 0, 0, 0);
    const dayEnd = Math.min(until, nextDay.getTime());
    definitions.push({
      day: new Date(cursor).toISOString().slice(0, 10),
      fromTimestamp: new Date(cursor).toISOString(),
      untilTimestamp: new Date(dayEnd).toISOString(),
      fromBlock: block,
      untilBlock: block + 10_000,
    });
    cursor = dayEnd;
    block += 10_000;
  }
  return buildFixture(definitions, new Set());
};
