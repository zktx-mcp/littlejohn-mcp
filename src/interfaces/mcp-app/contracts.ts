import { z } from "zod";

import {
  canonicalJsonStringify,
  captureCanonicalJson,
  operationIdSchema,
  sha256Bytes,
  type CanonicalJson,
} from "../../core/client.js";
import {
  internalCanonicalJsonResponseLimitBytes,
  requestBodyLimitBytes,
} from "../../runtime/http-limits.js";
import {
  presentationSnapshotIdentity,
  presentationSnapshotIdPattern,
  presentationSnapshotLimits,
  presentationSnapshotUnavailableReasons,
  type PresentationSnapshotRecord,
} from "../../runtime/presentation-snapshot.js";
import {
  walletOperationAllowsQr,
  walletQrMatrixSchema,
  type WalletManagementOperation,
  type WalletQrMatrix,
} from "../../wallet/operation-contract.js";

export const mcpAppResourceMimeType = "text/html;profile=mcp-app" as const;
export const presentationSnapshotResourceMimeType = "application/json" as const;
export const presentationSnapshotUriPrefix =
  "littlejohn://presentation/snapshots/sha256/" as const;
export const presentationSnapshotMetadataKey = "littlejohn/presentation-snapshot" as const;
export const operationToolResultMetadataKey = "littlejohn/operation-tool-result" as const;
export const walletOperationQrMetadataKey = "littlejohn/wallet-operation-qr" as const;

export const presentationMcpTools = Object.freeze({
  getSnapshot: "presentation_get_snapshot",
  getSnapshotChunk: "presentation_get_snapshot_chunk",
} as const);

const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/u);
export const presentationSnapshotIdSchema = z.string().regex(presentationSnapshotIdPattern);
export const presentationSnapshotUriSchema = z.string().regex(
  /^littlejohn:\/\/presentation\/snapshots\/sha256\/[0-9a-f]{64}$/u,
);
const positiveCanonicalDecimalSchema = z.string().regex(/^[1-9][0-9]*$/u);

export const operationToolResultLimits = Object.freeze({
  inputBytes: requestBodyLimitBytes,
  resultBytes: internalCanonicalJsonResponseLimitBytes,
} as const);

export const operationToolResultDescriptorSchema = z.object({
  kind: z.literal("operation_tool_result_descriptor"),
  version: z.literal(1),
  toolName: z.string().min(1).max(64).regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+){2,}$/u),
  inputUtf8Bytes: z.number().int().min(1).max(operationToolResultLimits.inputBytes),
  inputSha256: sha256HexSchema,
  resultUtf8Bytes: z.number().int().min(1).max(operationToolResultLimits.resultBytes),
  resultSha256: sha256HexSchema,
  isError: z.boolean(),
}).strict();
export type OperationToolResultDescriptor = z.infer<typeof operationToolResultDescriptorSchema>;

export const walletOperationQrMetadataSchema = z.object({
  kind: z.literal("wallet_operation_qr"),
  operationId: operationIdSchema,
  resultSha256: sha256HexSchema,
  qr: walletQrMatrixSchema,
}).strict();
export type WalletOperationQrMetadata = z.infer<typeof walletOperationQrMetadataSchema>;

export const operationToolResultEvidence = (value: unknown): Readonly<{
  value: CanonicalJson;
  utf8Bytes: number;
  sha256: string;
}> => {
  const admitted = captureCanonicalJson(value);
  const bytes = new TextEncoder().encode(canonicalJsonStringify(admitted));
  return Object.freeze({ value: admitted, utf8Bytes: bytes.length, sha256: sha256Bytes(bytes) });
};

export const createOperationToolResultDescriptor = (input: Readonly<{
  toolName: string;
  normalizedInput: unknown;
  result: unknown;
  isError: boolean;
}>): OperationToolResultDescriptor => {
  const normalizedInput = operationToolResultEvidence(input.normalizedInput);
  const result = operationToolResultEvidence(input.result);
  return Object.freeze(operationToolResultDescriptorSchema.parse({
    kind: "operation_tool_result_descriptor",
    version: 1,
    toolName: input.toolName,
    inputUtf8Bytes: normalizedInput.utf8Bytes,
    inputSha256: normalizedInput.sha256,
    resultUtf8Bytes: result.utf8Bytes,
    resultSha256: result.sha256,
    isError: input.isError,
  }));
};

export const admitOperationToolResultDescriptor = (
  value: unknown,
): OperationToolResultDescriptor => Object.freeze(
  operationToolResultDescriptorSchema.parse(captureCanonicalJson(value)),
);

export const createWalletOperationQrMetadata = (
  operationInput: WalletManagementOperation,
  qrInput: WalletQrMatrix,
): WalletOperationQrMetadata => {
  if (!walletOperationAllowsQr(operationInput)) {
    throw new TypeError("QR is not active for this Wallet operation.");
  }
  const operation = operationToolResultEvidence(operationInput);
  return Object.freeze(walletOperationQrMetadataSchema.parse({
    kind: "wallet_operation_qr",
    operationId: operationInput.operationId,
    resultSha256: operation.sha256,
    qr: qrInput,
  }));
};

export const admitWalletOperationQrMetadata = (
  value: unknown,
): WalletOperationQrMetadata => Object.freeze(
  walletOperationQrMetadataSchema.parse(captureCanonicalJson(value)),
);

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

export const admitPresentationSnapshotDescriptor = (
  value: unknown,
): PresentationSnapshotDescriptor => {
  const descriptor = presentationSnapshotDescriptorSchema.parse(captureCanonicalJson(value));
  if (
    descriptor.snapshotId !== presentationSnapshotIdentity({
      contractId: descriptor.contractId,
      contractVersion: descriptor.contractVersion,
      inputBytes: descriptor.inputUtf8Bytes,
      inputDigest: descriptor.inputSha256,
      resultBytes: descriptor.resultUtf8Bytes,
      resultDigest: descriptor.resultSha256,
    }) ||
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
