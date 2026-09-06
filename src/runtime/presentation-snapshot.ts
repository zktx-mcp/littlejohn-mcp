import type { CanonicalJson } from "../core/client.js";
import { internalResponseLimitBytes, requestBodyLimitBytes } from "./http-limits.js";

export const presentationSnapshotUnavailableReasons = Object.freeze([
  "capacity_exceeded",
  "runtime_unavailable",
  "snapshot_missing",
  "snapshot_inconsistent",
] as const);

export const presentationSnapshotLimits = Object.freeze({
  inputBytes: requestBodyLimitBytes,
  resultBytes: 8_388_607,
  resultChunkBytes: 262_144,
  rows: 16_384,
  aggregateBytes: 536_870_912,
} as const);

export const presentationSnapshotMetadataLimits = Object.freeze({
  contractIdentityBytes: internalResponseLimitBytes,
  resultChunkDigestsBytes: 67 * Math.ceil(
    presentationSnapshotLimits.resultBytes / presentationSnapshotLimits.resultChunkBytes,
  ) + 1,
});

export type PresentationSnapshotUnavailableReason =
  (typeof presentationSnapshotUnavailableReasons)[number];

export interface PresentationSnapshotRecord {
  readonly snapshotId: string;
  readonly contractId: string;
  readonly contractVersion: string;
  readonly inputBytes: Uint8Array;
  readonly inputDigest: string;
  readonly resultBytes: Uint8Array;
  readonly resultDigest: string;
}

export type PresentationSnapshotResult<Value> =
  | Readonly<{ status: "available"; value: Value }>
  | Readonly<{ status: "unavailable"; reason: PresentationSnapshotUnavailableReason }>;

export interface PresentationSnapshotStore {
  prepare(input: Readonly<{
    contractId: string;
    contractVersion: string;
    normalizedInput: CanonicalJson;
    admittedResult: CanonicalJson;
  }>): PresentationSnapshotResult<PresentationSnapshotRecord>;
  commit(input: Readonly<{
    contractId: string;
    contractVersion: string;
    normalizedInput: CanonicalJson;
    admittedResult: CanonicalJson;
  }>): PresentationSnapshotResult<PresentationSnapshotRecord>;
  read(snapshotId: string): PresentationSnapshotResult<PresentationSnapshotRecord>;
  readResultChunk(input: Readonly<{
    snapshotId: string;
    index: number;
  }>): PresentationSnapshotResult<Readonly<{
    snapshotId: string;
    index: number;
    bytes: Uint8Array;
  }>>;
}
