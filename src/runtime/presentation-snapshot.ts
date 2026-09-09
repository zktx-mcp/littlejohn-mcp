import { isWellFormedText, sha256Bytes, type CanonicalJson } from "../core/client.js";
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

export interface ReviewPresentationSource {
  readPresentation(operationId: string): PresentationSnapshotResult<Readonly<{
    operationId: string;
    expiresAt: string;
    snapshot: PresentationSnapshotRecord;
  }>>;
}

export const presentationSnapshotIdPattern = /^sha256:[0-9a-f]{64}$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const positiveCanonicalDecimalPattern = /^[1-9][0-9]*$/u;

export const parsePresentationContractIdentity = (contractId: unknown, contractVersion: unknown): Readonly<{
  contractId: string;
  contractVersion: string;
}> => {
  if (
    typeof contractId !== "string" || contractId.length === 0 || contractId.includes("\0") ||
    !isWellFormedText(contractId) ||
    typeof contractVersion !== "string" || !positiveCanonicalDecimalPattern.test(contractVersion)
  ) throw new TypeError("Presentation contract identity is invalid.");
  return Object.freeze({ contractId, contractVersion });
};

export const presentationSnapshotIdentity = (input: Readonly<{
  contractId: string;
  contractVersion: string;
  inputBytes: number;
  inputDigest: string;
  resultBytes: number;
  resultDigest: string;
}>): string => {
  parsePresentationContractIdentity(input.contractId, input.contractVersion);
  if (
    !Number.isSafeInteger(input.inputBytes) || input.inputBytes < 1 ||
    !Number.isSafeInteger(input.resultBytes) || input.resultBytes < 1 ||
    !sha256Pattern.test(input.inputDigest) || !sha256Pattern.test(input.resultDigest)
  ) throw new TypeError("Presentation snapshot identity fields are invalid.");
  const identityInput = [
    input.contractId,
    input.contractVersion,
    String(input.inputBytes),
    input.inputDigest,
    String(input.resultBytes),
    input.resultDigest,
  ].join("\0");
  return `sha256:${sha256Bytes(new TextEncoder().encode(identityInput))}`;
};
