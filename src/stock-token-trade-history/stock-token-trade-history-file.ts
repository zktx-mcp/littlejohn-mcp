import { Buffer } from "node:buffer";
import { gunzipSync } from "node:zlib";

import { deepFreezeValue, sha256Bytes } from "../core/index.js";
import {
  serializeStockTokenTradeHistoryFileJson,
  stockTokenTradeHistoryFileMaximumBytes,
  stockTokenTradeHistoryDaySchema,
  stockTokenTradeHistoryMonthSchema,
  stockTokenTradeHistoryStateSchema,
  stockTokenTradePairDayLogicalId,
  stockTokenTradePairMonthLogicalId,
  type StockTokenTradeHistoryFileReference,
  type StockTokenTradeHistoryDay,
  type StockTokenTradeHistoryMonth,
  type StockTokenTradeHistoryState,
} from "./stock-token-trade-history-data.js";

const decodeFile = (
  gzipBytes: Uint8Array,
): Readonly<{ value: unknown; jsonBytes: Uint8Array; jsonSha256: string }> => {
  if (
    !(gzipBytes instanceof Uint8Array) ||
    gzipBytes.byteLength > stockTokenTradeHistoryFileMaximumBytes
  ) throw new TypeError("Compressed trade-history file exceeds its bound.");
  const jsonBytes = new Uint8Array(gunzipSync(Buffer.from(gzipBytes), {
    maxOutputLength: stockTokenTradeHistoryFileMaximumBytes,
  }));
  const text = new TextDecoder("utf-8", { fatal: true }).decode(jsonBytes);
  const value = JSON.parse(text) as unknown;
  if (serializeStockTokenTradeHistoryFileJson(value) !== text) {
    throw new TypeError("Trade-history file JSON does not use its required serialization.");
  }
  return Object.freeze({ value, jsonBytes, jsonSha256: sha256Bytes(jsonBytes) });
};

const decodeReferencedFile = <T>(
  gzipBytes: Uint8Array,
  reference: StockTokenTradeHistoryFileReference,
  parse: (value: unknown) => T,
  identity: (value: T) => string,
  sequence: (value: T) => number,
  coverage: (value: T) => unknown,
): Readonly<{ value: T; sha256: string }> => {
  if (
    gzipBytes.byteLength !== reference.gzipBytes ||
    sha256Bytes(gzipBytes) !== reference.gzipSha256
  ) throw new TypeError("Trade-history bytes do not match their reference.");
  const decoded = decodeFile(gzipBytes);
  if (
    decoded.jsonBytes.byteLength !== reference.jsonBytes ||
    decoded.jsonSha256 !== reference.jsonSha256
  ) throw new TypeError("Trade-history content does not match its reference.");
  const value = parse(decoded.value);
  if (
    identity(value) !== reference.logicalId || sequence(value) !== reference.sequence ||
    serializeStockTokenTradeHistoryFileJson(coverage(value)) !==
      serializeStockTokenTradeHistoryFileJson(reference.coverage)
  ) throw new TypeError("Trade-history file does not match its owning reference.");
  return deepFreezeValue({ value, sha256: decoded.jsonSha256 });
};

export const decodeStockTokenTradeHistoryState = (
  gzipBytes: Uint8Array,
  expectedPairId: string,
  expectedSequence?: number,
): Readonly<{ state: StockTokenTradeHistoryState; sha256: string }> => {
  const decoded = decodeFile(gzipBytes);
  const state = stockTokenTradeHistoryStateSchema.parse(decoded.value);
  if (
    state.pair.pairId !== expectedPairId ||
    (expectedSequence !== undefined && state.sequence !== expectedSequence)
  ) throw new TypeError("Trade-history state does not match the selected pair-state identity.");
  return deepFreezeValue({ state, sha256: decoded.jsonSha256 });
};

export const decodeStockTokenTradeHistoryMonth = (
  gzipBytes: Uint8Array,
  reference: StockTokenTradeHistoryFileReference,
): Readonly<{ month: StockTokenTradeHistoryMonth; sha256: string }> => {
  const decoded = decodeReferencedFile(
    gzipBytes,
    reference,
    (value) => stockTokenTradeHistoryMonthSchema.parse(value),
    (month) => stockTokenTradePairMonthLogicalId(month.pair.pairId, month.month),
    (month) => month.sequence,
    (month) => month.coverage,
  );
  return deepFreezeValue({ month: decoded.value, sha256: decoded.sha256 });
};

export const decodeStockTokenTradeHistoryDay = (
  gzipBytes: Uint8Array,
  reference: StockTokenTradeHistoryFileReference,
): Readonly<{ day: StockTokenTradeHistoryDay; sha256: string }> => {
  const decoded = decodeReferencedFile(
    gzipBytes,
    reference,
    (value) => stockTokenTradeHistoryDaySchema.parse(value),
    (day) => stockTokenTradePairDayLogicalId(day.pair.pairId, day.day),
    (day) => day.sequence,
    (day) => day.coverage,
  );
  return deepFreezeValue({ day: decoded.value, sha256: decoded.sha256 });
};
