import { Buffer } from "node:buffer";
import { gunzipSync } from "node:zlib";

import { deepFreezeValue, sha256Bytes } from "../core/index.js";
import {
  canonicalStockTokenExecutionIndexJson,
  stockTokenExecutionArtifactMaximumBytes,
  stockTokenExecutionIndexDaySchema,
  stockTokenExecutionIndexMonthSchema,
  stockTokenExecutionIndexStateSchema,
  stockTokenExecutionPairDayLogicalId,
  stockTokenExecutionPairMonthLogicalId,
  type StockTokenExecutionArtifactReference,
  type StockTokenExecutionIndexDay,
  type StockTokenExecutionIndexMonth,
  type StockTokenExecutionIndexState,
} from "./stock-token-execution-index.js";

const decodeArtifact = (
  gzipBytes: Uint8Array,
): Readonly<{ value: unknown; jsonBytes: Uint8Array; jsonSha256: string }> => {
  if (
    !(gzipBytes instanceof Uint8Array) ||
    gzipBytes.byteLength > stockTokenExecutionArtifactMaximumBytes
  ) throw new TypeError("Execution-index compressed artifact exceeds its bound.");
  const jsonBytes = new Uint8Array(gunzipSync(Buffer.from(gzipBytes), {
    maxOutputLength: stockTokenExecutionArtifactMaximumBytes,
  }));
  const text = new TextDecoder("utf-8", { fatal: true }).decode(jsonBytes);
  const value = JSON.parse(text) as unknown;
  if (canonicalStockTokenExecutionIndexJson(value) !== text) {
    throw new TypeError("Execution-index artifact JSON is not canonical.");
  }
  return Object.freeze({ value, jsonBytes, jsonSha256: sha256Bytes(jsonBytes) });
};

const decodeReferencedArtifact = <T>(
  gzipBytes: Uint8Array,
  reference: StockTokenExecutionArtifactReference,
  parse: (value: unknown) => T,
  identity: (value: T) => string,
  sequence: (value: T) => number,
  coverage: (value: T) => unknown,
): Readonly<{ value: T; sha256: string }> => {
  if (
    gzipBytes.byteLength !== reference.gzipBytes ||
    sha256Bytes(gzipBytes) !== reference.gzipSha256
  ) throw new TypeError("Execution-index bytes do not match their reference.");
  const decoded = decodeArtifact(gzipBytes);
  if (
    decoded.jsonBytes.byteLength !== reference.jsonBytes ||
    decoded.jsonSha256 !== reference.jsonSha256
  ) throw new TypeError("Execution-index content does not match its reference.");
  const value = parse(decoded.value);
  if (
    identity(value) !== reference.logicalId || sequence(value) !== reference.sequence ||
    canonicalStockTokenExecutionIndexJson(coverage(value)) !==
      canonicalStockTokenExecutionIndexJson(reference.coverage)
  ) throw new TypeError("Execution-index artifact does not match its owning reference.");
  return deepFreezeValue({ value, sha256: decoded.jsonSha256 });
};

export const decodeStockTokenExecutionIndexState = (
  gzipBytes: Uint8Array,
  expectedPairId: string,
  expectedSequence?: number,
): Readonly<{ state: StockTokenExecutionIndexState; sha256: string }> => {
  const decoded = decodeArtifact(gzipBytes);
  const state = stockTokenExecutionIndexStateSchema.parse(decoded.value);
  if (
    state.pair.pairId !== expectedPairId ||
    (expectedSequence !== undefined && state.sequence !== expectedSequence)
  ) throw new TypeError("Execution-index state does not match its selected carrier.");
  return deepFreezeValue({ state, sha256: decoded.jsonSha256 });
};

export const decodeStockTokenExecutionIndexMonth = (
  gzipBytes: Uint8Array,
  reference: StockTokenExecutionArtifactReference,
): Readonly<{ month: StockTokenExecutionIndexMonth; sha256: string }> => {
  const decoded = decodeReferencedArtifact(
    gzipBytes,
    reference,
    (value) => stockTokenExecutionIndexMonthSchema.parse(value),
    (month) => stockTokenExecutionPairMonthLogicalId(month.pair.pairId, month.month),
    (month) => month.sequence,
    (month) => month.coverage,
  );
  return deepFreezeValue({ month: decoded.value, sha256: decoded.sha256 });
};

export const decodeStockTokenExecutionIndexDay = (
  gzipBytes: Uint8Array,
  reference: StockTokenExecutionArtifactReference,
): Readonly<{ day: StockTokenExecutionIndexDay; sha256: string }> => {
  const decoded = decodeReferencedArtifact(
    gzipBytes,
    reference,
    (value) => stockTokenExecutionIndexDaySchema.parse(value),
    (day) => stockTokenExecutionPairDayLogicalId(day.pair.pairId, day.day),
    (day) => day.sequence,
    (day) => day.coverage,
  );
  return deepFreezeValue({ day: decoded.value, sha256: decoded.sha256 });
};
