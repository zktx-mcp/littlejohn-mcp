import { canonicalJsonStringify, captureCanonicalJson, type CanonicalJson } from "../../core/index.js";
import { internalResponseLimitBytes } from "../../runtime/http-limits.js";
import type { PresentationSnapshotRecord, PresentationSnapshotMetadata } from "../../runtime/presentation-snapshot.js";
import { createPresentationSnapshotResource, type PresentationSnapshotResource, type PresentationSource } from "./contracts.js";
import { assertPresentationSource, type PresentationContractEntry } from "./registry.js";
import {storedPresentationContractRegistry} from "../immutable-read-contracts.js";

const exactUtf8 = (value: CanonicalJson): Uint8Array => new TextEncoder().encode(canonicalJsonStringify(value));

const readCanonicalBytes = (bytes: Uint8Array): CanonicalJson => {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value = captureCanonicalJson(JSON.parse(text));
  if (canonicalJsonStringify(value) !== text) {
    throw new TypeError("Stored presentation value is not canonical JSON.");
  }
  return value;
};

export const boundedSnapshotResource = (
  record: PresentationSnapshotRecord | PresentationSnapshotMetadata,
  normalizedInput: CanonicalJson,
  source: PresentationSource = { kind: "sqlite" },
): PresentationSnapshotResource => {
  const resource = createPresentationSnapshotResource(record, normalizedInput, source);
  if (exactUtf8(captureCanonicalJson(resource)).length > internalResponseLimitBytes) {
    throw new RangeError("Presentation snapshot resource exceeds its response bound.");
  }
  return resource;
};

export const admitSnapshotRecord = (record: PresentationSnapshotRecord, source: PresentationSource = { kind: "sqlite" }): Readonly<{
  entry: PresentationContractEntry;
  normalizedInput: CanonicalJson;
  admittedResult: CanonicalJson;
  resource: PresentationSnapshotResource;
}> => {
  const entry = storedPresentationContractRegistry.requireIdentity(
    record.contractId,
    record.contractVersion,
  );
  const normalizedInput = entry.parseNormalizedInput(readCanonicalBytes(record.inputBytes));
  const admittedResult = entry.parseResult(
    normalizedInput,
    readCanonicalBytes(record.resultBytes),
  );
  assertPresentationSource(entry, admittedResult, source);
  if (
    Buffer.compare(Buffer.from(exactUtf8(normalizedInput)), Buffer.from(record.inputBytes)) !== 0 ||
    Buffer.compare(Buffer.from(exactUtf8(admittedResult)), Buffer.from(record.resultBytes)) !== 0
  ) throw new TypeError("Stored presentation pair changed during canonical re-admission.");
  return Object.freeze({
    entry,
    normalizedInput,
    admittedResult,
    resource: boundedSnapshotResource(record, normalizedInput, source),
  });
};

export const admitSnapshotMetadata = (record: PresentationSnapshotMetadata): Readonly<{
  entry: PresentationContractEntry;
  normalizedInput: CanonicalJson;
  resource: PresentationSnapshotResource;
}> => {
  const entry = storedPresentationContractRegistry.requireIdentity(record.contractId, record.contractVersion);
  if (entry.retention !== "sqlite") throw new TypeError("A durable source cannot carry private request material.");
  const normalizedInput = entry.parseNormalizedInput(readCanonicalBytes(record.inputBytes));
  if (Buffer.compare(Buffer.from(exactUtf8(normalizedInput)), Buffer.from(record.inputBytes)) !== 0) {
    throw new TypeError("Stored snapshot input changed during admission.");
  }
  return Object.freeze({entry, normalizedInput, resource: boundedSnapshotResource(record, normalizedInput)});
};

