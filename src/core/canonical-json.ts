import { createHash } from "node:crypto";

import { sha256Algorithm } from "./digests.js";
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
  createHash(sha256Algorithm).update(canonicalJsonStringify(value), "utf8").digest("hex");

export const sha256Bytes = (value: Uint8Array): string =>
  createHash(sha256Algorithm).update(value).digest("hex");
