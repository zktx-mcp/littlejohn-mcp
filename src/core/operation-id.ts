import { z } from "zod";

import { canonicalBase64UrlSchema } from "./primitives.js";

export const operationIdByteLength = 32;
export const operationIdSchema = canonicalBase64UrlSchema(operationIdByteLength);
export type OperationId = z.infer<typeof operationIdSchema>;

export const operationIdFromBytes = (bytes: Uint8Array): OperationId => {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== operationIdByteLength) {
    throw new TypeError("Operation ID entropy must contain exactly 32 bytes.");
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = globalThis.btoa(binary);
  return operationIdSchema.parse(
    encoded.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, ""),
  );
};
