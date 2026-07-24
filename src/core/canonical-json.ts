import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import {
  canonicalJsonStringify,
  type CanonicalJson,
} from "./canonical-json-value.js";

export {
  canonicalJsonStringify,
  captureCanonicalJson,
} from "./canonical-json-value.js";
export type { CanonicalJson } from "./canonical-json-value.js";

export const canonicalSha256 = (value: CanonicalJson): string =>
  bytesToHex(sha256(utf8ToBytes(canonicalJsonStringify(value))));

const bytesToBase64Url = (value: Uint8Array): string => {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
};

export const canonicalSha256Base64Url = (value: CanonicalJson): string =>
  bytesToBase64Url(sha256(utf8ToBytes(canonicalJsonStringify(value))));

export const sha256Bytes = (value: Uint8Array): string => bytesToHex(sha256(value));

export const utf8ByteLength = (value: string): number => utf8ToBytes(value).length;
