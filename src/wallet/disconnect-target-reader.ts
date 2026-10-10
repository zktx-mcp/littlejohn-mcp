import { canonicalJsonStringify, captureCanonicalJson, sha256Bytes, type CanonicalJson } from "../core/client.js";
import { presentationSnapshotIdentity, presentationSnapshotLimits } from "../runtime/presentation-snapshot.js";
import { walletDisconnectManifestSchema, walletDisconnectTargetSchema, walletDisconnectTargetsSchema,
  type WalletReview, type WalletDisconnectTarget, type WalletTargetSnapshotReference } from "./operation-contract.js";

export interface WalletTargetChunkReader {
  readResultChunk(snapshotId: string, index: number): Promise<Uint8Array>;
}

// The reference is the owner's lossless canonical value, never a displayed summary.
const readValue = async (reference: WalletTargetSnapshotReference, input: CanonicalJson, reader: WalletTargetChunkReader): Promise<unknown> => {
  const inputBytes = new TextEncoder().encode(canonicalJsonStringify(input));
  const expected = presentationSnapshotIdentity({contractId: reference.contractId, contractVersion: reference.contractVersion,
    inputBytes: inputBytes.length, inputDigest: sha256Bytes(inputBytes), resultBytes: reference.resultLength, resultDigest: reference.resultDigest});
  if (expected !== reference.snapshotId) throw new TypeError("Wallet target reference does not belong to this input.");
  const result = new Uint8Array(reference.resultLength);
  const chunkBytes = presentationSnapshotLimits.resultChunkBytes;
  for (let index = 0; index < Math.ceil(result.length / chunkBytes); index += 1) {
    const chunk = await reader.readResultChunk(reference.snapshotId, index);
    if (!(chunk instanceof Uint8Array) || chunk.length !== Math.min(chunkBytes, result.length - index * chunkBytes)) {
      throw new TypeError("Wallet target chunk is incomplete.");
    }
    result.set(chunk, index * chunkBytes);
  }
  if (sha256Bytes(result) !== reference.resultDigest) throw new TypeError("Wallet target digest differs.");
  const text = new TextDecoder("utf-8", {fatal: true}).decode(result);
  const value = captureCanonicalJson(JSON.parse(text));
  if (canonicalJsonStringify(value) !== text) throw new TypeError("Wallet target value is not canonical.");
  return value;
};

export const readWalletDisconnectTargets = async (
  review: Extract<WalletReview, {kind: "disconnect"}>, reader: WalletTargetChunkReader,
): Promise<readonly WalletDisconnectTarget[]> => {
  const targetSet = review.precondition.targetSet;
  if (targetSet.kind === "inline") return walletDisconnectTargetsSchema.parse(targetSet.targets);
  const manifest = walletDisconnectManifestSchema.parse(await readValue(targetSet.reference,
    {operationId: review.operationId, connectionRevision: review.precondition.connectionRevision}, reader));
  const targets: WalletDisconnectTarget[] = [];
  for (const entry of manifest) {
    const target = walletDisconnectTargetSchema.parse(await readValue(entry.facts, {sourceId: entry.sourceId}, reader));
    if (target.sourceId !== entry.sourceId) throw new TypeError("Wallet target source differs from its manifest.");
    targets.push(target);
  }
  return walletDisconnectTargetsSchema.parse(targets);
};
