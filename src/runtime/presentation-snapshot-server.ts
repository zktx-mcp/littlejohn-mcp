import { canonicalJsonStringify, sha256Bytes, type CanonicalJson } from "../core/index.js";
import { parsePresentationContractIdentity, presentationSnapshotIdentity, presentationSnapshotMetadataLimits,
  presentationSnapshotLimits, type PresentationSnapshotRecord, type PresentationSnapshotResult } from "./presentation-snapshot.js";

export const createPresentationSnapshot = (input: Readonly<{
  contractId: string;
  contractVersion: string;
  normalizedInput: CanonicalJson;
  admittedResult: CanonicalJson;
}>): PresentationSnapshotResult<PresentationSnapshotRecord> => {
  let identity: Readonly<{ contractId: string; contractVersion: string }>;
  let inputBytes: Buffer;
  let resultBytes: Buffer;
  try {
    identity = parsePresentationContractIdentity(input.contractId, input.contractVersion);
    inputBytes = Buffer.from(canonicalJsonStringify(input.normalizedInput), "utf8");
    resultBytes = Buffer.from(canonicalJsonStringify(input.admittedResult), "utf8");
  } catch {
    return Object.freeze({ status: "unavailable" as const, reason: "snapshot_inconsistent" as const });
  }
  if (
    Buffer.byteLength(identity.contractId, "utf8") > presentationSnapshotMetadataLimits.contractIdentityBytes ||
    Buffer.byteLength(identity.contractVersion, "utf8") > presentationSnapshotMetadataLimits.contractIdentityBytes ||
    inputBytes.length > presentationSnapshotLimits.inputBytes ||
    resultBytes.length > presentationSnapshotLimits.resultBytes
  ) return Object.freeze({ status: "unavailable" as const, reason: "capacity_exceeded" as const });
  const inputDigest = sha256Bytes(inputBytes);
  const resultDigest = sha256Bytes(resultBytes);
  const snapshotId = presentationSnapshotIdentity({
    ...identity,
    inputBytes: inputBytes.length,
    inputDigest,
    resultBytes: resultBytes.length,
    resultDigest,
  });
  return Object.freeze({ status: "available", value: Object.freeze({
    snapshotId,
    ...identity,
    inputBytes: Uint8Array.from(inputBytes),
    inputDigest,
    resultBytes: Uint8Array.from(resultBytes),
    resultDigest,
  }) });
};

