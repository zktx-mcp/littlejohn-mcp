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

export const utf8ByteLength = (value: string): number => utf8ToBytes(value).length;
