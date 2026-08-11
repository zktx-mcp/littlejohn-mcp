import { z } from "zod";

import {
  canonicalJsonStringify,
  captureCanonicalJson,
  sha256Bytes,
  type CanonicalJson,
} from "../../core/browser.js";
import {
  presentationSnapshotLimits,
  presentationSnapshotUnavailableReasons,
  type PresentationSnapshotRecord,
} from "../../runtime/presentation-snapshot.js";

export const mcpAppResourceMimeType = "text/html;profile=mcp-app" as const;
export const presentationSnapshotResourceMimeType = "application/json" as const;
export const presentationSnapshotUriPrefix =
  "littlejohn://presentation/snapshots/sha256/" as const;
export const presentationSnapshotMetadataKey = "littlejohn/presentation-snapshot" as const;

export const presentationMcpTools = Object.freeze({
  getSnapshot: "presentation_get_snapshot",
  getSnapshotChunk: "presentation_get_snapshot_chunk",
} as const);

const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/u);
export const presentationSnapshotIdSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
export const presentationSnapshotUriSchema = z.string().regex(
  /^littlejohn:\/\/presentation\/snapshots\/sha256\/[0-9a-f]{64}$/u,
);
const positiveCanonicalDecimalSchema = z.string().regex(/^[1-9][0-9]*$/u);

export const presentationSnapshotDescriptorSchema = z.object({
  kind: z.literal("presentation_snapshot_descriptor"),
  snapshotUri: presentationSnapshotUriSchema,
  snapshotId: presentationSnapshotIdSchema,
  contractId: z.string().min(1).refine((value) => !value.includes("\0")),
  contractVersion: positiveCanonicalDecimalSchema,
  inputUtf8Bytes: z.number().int().min(1).max(presentationSnapshotLimits.inputBytes),
  inputSha256: sha256HexSchema,
  resultUtf8Bytes: z.number().int().min(1).max(presentationSnapshotLimits.resultBytes),
  resultSha256: sha256HexSchema,
  resultChunkBytes: z.literal(presentationSnapshotLimits.resultChunkBytes),
  resultChunkCount: z.number().int().min(1),
}).strict();
export type PresentationSnapshotDescriptor = z.infer<typeof presentationSnapshotDescriptorSchema>;

export const presentationSnapshotReferenceSchema = z.object({
  kind: z.literal("presentation_snapshot_reference"),
  snapshotUri: presentationSnapshotUriSchema,
  descriptor: presentationSnapshotDescriptorSchema,
}).strict();
export type PresentationSnapshotReference = z.infer<typeof presentationSnapshotReferenceSchema>;

export const presentationSnapshotChunkSchema = z.object({
  kind: z.literal("presentation_snapshot_chunk"),
  snapshotId: presentationSnapshotIdSchema,
  index: z.number().int().min(0),
  canonicalBase64: z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u),
}).strict();
export type PresentationSnapshotChunk = z.infer<typeof presentationSnapshotChunkSchema>;

export const presentationUnavailableSchema = z.object({
  kind: z.literal("presentation_unavailable"),
  status: z.literal("unavailable"),
  reason: z.enum(presentationSnapshotUnavailableReasons),
}).strict();
export type PresentationUnavailable = z.infer<typeof presentationUnavailableSchema>;

export interface PresentationSnapshotResource {
  readonly kind: "presentation_snapshot_resource";
  readonly descriptor: PresentationSnapshotDescriptor;
  readonly normalizedInput: CanonicalJson;
}

export const createPresentationUnavailable = (
  reason: PresentationUnavailable["reason"],
): PresentationUnavailable => Object.freeze({
  kind: "presentation_unavailable",
  status: "unavailable",
  reason,
});

export const snapshotIdFromUri = (snapshotUri: unknown): string => {
  const parsed = presentationSnapshotUriSchema.parse(snapshotUri);
  return presentationSnapshotIdSchema.parse(
    `sha256:${parsed.slice(presentationSnapshotUriPrefix.length)}`,
  );
};

export const snapshotUriFromId = (snapshotId: unknown): string => {
  const parsed = presentationSnapshotIdSchema.parse(snapshotId);
  return presentationSnapshotUriSchema.parse(
    `${presentationSnapshotUriPrefix}${parsed.slice("sha256:".length)}`,
  );
};

const descriptorIdentity = (descriptor: Readonly<{
  contractId: string;
  contractVersion: string;
  inputUtf8Bytes: number;
  inputSha256: string;
  resultUtf8Bytes: number;
  resultSha256: string;
}>): string => `sha256:${sha256Bytes(new TextEncoder().encode([
  descriptor.contractId,
  descriptor.contractVersion,
  String(descriptor.inputUtf8Bytes),
  descriptor.inputSha256,
  String(descriptor.resultUtf8Bytes),
  descriptor.resultSha256,
].join("\0")))}`;

export const admitPresentationSnapshotDescriptor = (
  value: unknown,
): PresentationSnapshotDescriptor => {
  const descriptor = presentationSnapshotDescriptorSchema.parse(captureCanonicalJson(value));
  if (
    descriptor.snapshotId !== descriptorIdentity(descriptor) ||
    descriptor.snapshotUri !== snapshotUriFromId(descriptor.snapshotId) ||
    descriptor.resultChunkCount !== Math.ceil(
      descriptor.resultUtf8Bytes / descriptor.resultChunkBytes,
    )
  ) throw new TypeError("Presentation snapshot descriptor identity is invalid.");
  return Object.freeze(descriptor);
};

export const descriptorForPresentationSnapshot = (
  record: PresentationSnapshotRecord,
): PresentationSnapshotDescriptor => admitPresentationSnapshotDescriptor({
  kind: "presentation_snapshot_descriptor",
  snapshotUri: snapshotUriFromId(record.snapshotId),
  snapshotId: record.snapshotId,
  contractId: record.contractId,
  contractVersion: record.contractVersion,
  inputUtf8Bytes: record.inputBytes.length,
  inputSha256: record.inputDigest,
  resultUtf8Bytes: record.resultBytes.length,
  resultSha256: record.resultDigest,
  resultChunkBytes: presentationSnapshotLimits.resultChunkBytes,
  resultChunkCount: Math.ceil(record.resultBytes.length / presentationSnapshotLimits.resultChunkBytes),
});

export const createPresentationSnapshotResource = (
  record: PresentationSnapshotRecord,
  normalizedInput: CanonicalJson,
): PresentationSnapshotResource => {
  const admittedInput = captureCanonicalJson(normalizedInput);
  const inputBytes = new TextEncoder().encode(canonicalJsonStringify(admittedInput));
  if (
    inputBytes.length !== record.inputBytes.length ||
    sha256Bytes(inputBytes) !== record.inputDigest
  ) throw new TypeError("Presentation snapshot input does not match its descriptor.");
  return Object.freeze({
    kind: "presentation_snapshot_resource",
    descriptor: descriptorForPresentationSnapshot(record),
    normalizedInput: admittedInput,
  });
};

export const admitPresentationSnapshotResource = (
  value: unknown,
): PresentationSnapshotResource => {
  const captured = captureCanonicalJson(value);
  if (typeof captured !== "object" || captured === null || Array.isArray(captured)) {
    throw new TypeError("Presentation snapshot resource is invalid.");
  }
  const keys = Object.keys(captured);
  if (keys.length !== 3 || keys.join("\0") !== ["descriptor", "kind", "normalizedInput"].join("\0") ||
    captured["kind"] !== "presentation_snapshot_resource") {
    throw new TypeError("Presentation snapshot resource is invalid.");
  }
  const descriptor = admitPresentationSnapshotDescriptor(captured["descriptor"]);
  const normalizedInput = captureCanonicalJson(captured["normalizedInput"]);
  const inputBytes = new TextEncoder().encode(canonicalJsonStringify(normalizedInput));
  if (
    inputBytes.length !== descriptor.inputUtf8Bytes ||
    sha256Bytes(inputBytes) !== descriptor.inputSha256
  ) throw new TypeError("Presentation snapshot resource input is inconsistent.");
  return Object.freeze({ kind: "presentation_snapshot_resource", descriptor, normalizedInput });
};

export const admitPresentationSnapshotReference = (
  value: unknown,
): PresentationSnapshotReference => {
  const reference = presentationSnapshotReferenceSchema.parse(captureCanonicalJson(value));
  const descriptor = admitPresentationSnapshotDescriptor(reference.descriptor);
  if (reference.snapshotUri !== descriptor.snapshotUri) {
    throw new TypeError("Presentation snapshot reference is inconsistent.");
  }
  return Object.freeze({ ...reference, descriptor });
};

export const canonicalBase64FromBytes = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

export const bytesFromCanonicalBase64 = (value: unknown): Uint8Array => {
  const parsed = presentationSnapshotChunkSchema.shape.canonicalBase64.parse(value);
  const binary = atob(parsed);
  if (btoa(binary) !== parsed) throw new TypeError("Presentation snapshot chunk is not canonical Base64.");
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};
