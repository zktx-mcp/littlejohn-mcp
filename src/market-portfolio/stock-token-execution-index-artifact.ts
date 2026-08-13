import { Buffer } from "node:buffer";
import { gunzipSync } from "node:zlib";

import { deepFreezeValue, sha256Bytes } from "../core/index.js";
import {
  canonicalStockTokenExecutionIndexJson,
  stockTokenExecutionIndexDaySchema,
  stockTokenExecutionIndexStateSchema,
  stockTokenExecutionSeriesLimits,
  type StockTokenExecutionDayReference,
  type StockTokenExecutionIndexDay,
  type StockTokenExecutionIndexState,
} from "./stock-token-execution-index.js";

const decodeArtifact = (
  gzipBytes: Uint8Array,
): Readonly<{ value: unknown; jsonBytes: Uint8Array; jsonSha256: string }> => {
  if (
    !(gzipBytes instanceof Uint8Array) ||
    gzipBytes.byteLength > stockTokenExecutionSeriesLimits.artifactBytes
  ) throw new TypeError("Execution-index compressed artifact exceeds its bound.");
  const jsonBytes = new Uint8Array(gunzipSync(Buffer.from(gzipBytes), {
    maxOutputLength: stockTokenExecutionSeriesLimits.artifactBytes,
  }));
  const text = new TextDecoder("utf-8", { fatal: true }).decode(jsonBytes);
  const value = JSON.parse(text) as unknown;
  if (canonicalStockTokenExecutionIndexJson(value) !== text) {
    throw new TypeError("Execution-index artifact JSON is not canonical.");
  }
  return Object.freeze({
    value,
    jsonBytes,
    jsonSha256: sha256Bytes(jsonBytes),
  });
};

export const decodeStockTokenExecutionIndexState = (
  gzipBytes: Uint8Array,
  expectedSequence?: string,
): Readonly<{ state: StockTokenExecutionIndexState; sha256: string }> => {
  const decoded = decodeArtifact(gzipBytes);
  const state = stockTokenExecutionIndexStateSchema.parse(decoded.value);
  if (expectedSequence !== undefined && BigInt(expectedSequence) !== BigInt(state.sequence)) {
    throw new TypeError("Execution-index state generation does not match its value.");
  }
  return deepFreezeValue({ state, sha256: decoded.jsonSha256 });
};

export const decodeStockTokenExecutionIndexDay = (
  gzipBytes: Uint8Array,
  reference: StockTokenExecutionDayReference,
): Readonly<{ day: StockTokenExecutionIndexDay; sha256: string }> => {
  if (gzipBytes.byteLength !== reference.gzipBytes || sha256Bytes(gzipBytes) !== reference.gzipSha256) {
    throw new TypeError("Execution-index day bytes do not match their state reference.");
  }
  const decoded = decodeArtifact(gzipBytes);
  if (
    decoded.jsonBytes.byteLength !== reference.jsonBytes ||
    decoded.jsonSha256 !== reference.jsonSha256
  ) throw new TypeError("Execution-index day content does not match its state reference.");
  const day = stockTokenExecutionIndexDaySchema.parse(decoded.value);
  if (day.day !== reference.day) throw new TypeError("Execution-index day identity is inconsistent.");
  return deepFreezeValue({ day, sha256: decoded.jsonSha256 });
};
