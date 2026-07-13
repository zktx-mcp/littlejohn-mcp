import { createHash } from "node:crypto";

import { sha256Algorithm } from "./digests.js";
import { compareCodePointSequences } from "./primitives.js";

export type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | CanonicalJson[]
  | { readonly [key: string]: CanonicalJson };

const maximumCanonicalDepth = 64;
const maximumCanonicalArrayLength = 8_192;

const capture = (input: unknown, depth: number): CanonicalJson => {
  if (depth > maximumCanonicalDepth) {
    throw new TypeError("Canonical JSON nesting exceeds the supported depth.");
  }
  if (input === null || typeof input === "string" || typeof input === "boolean") return input;
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw new TypeError("Canonical JSON rejects non-finite numbers.");
    return Object.is(input, -0) ? 0 : input;
  }
  if (Array.isArray(input)) {
    const descriptors = Object.getOwnPropertyDescriptors(input) as unknown as Record<PropertyKey, PropertyDescriptor>;
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key === "symbol")) throw new TypeError("Canonical JSON rejects symbol keys.");
    const lengthDescriptor = descriptors["length"];
    const length = lengthDescriptor?.value as unknown;
    if (
      lengthDescriptor === undefined ||
      !("value" in lengthDescriptor) ||
      typeof length !== "number" ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > maximumCanonicalArrayLength
    ) throw new TypeError("Canonical JSON rejects an invalid or excessive array length.");
    const permitted = new Set<string>(["length"]);
    const output: CanonicalJson[] = [];
    for (let index = 0; index < length; index += 1) {
      const key = String(index);
      permitted.add(key);
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
      ) throw new TypeError("Canonical JSON rejects sparse or accessor-backed arrays.");
      output.push(capture(descriptor.value, depth + 1));
    }
    if (keys.some((key) => typeof key !== "string" || !permitted.has(key))) {
      throw new TypeError("Canonical JSON rejects additional array properties.");
    }
    return output;
  }
  if (typeof input !== "object") throw new TypeError("Canonical JSON rejects unsupported values.");
  const prototype = Reflect.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Canonical JSON accepts only ordinary or null-prototype objects.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key === "symbol")) throw new TypeError("Canonical JSON rejects symbol keys.");
  const output: Record<string, CanonicalJson> = Object.create(null) as Record<string, CanonicalJson>;
  for (const key of (keys as string[]).sort(compareCodePointSequences)) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) throw new TypeError("Canonical JSON rejects accessors and non-enumerable fields.");
    output[key] = capture(descriptor.value, depth + 1);
  }
  return output;
};

export const captureCanonicalJson = (input: unknown): CanonicalJson => capture(input, 0);

const serializeCaptured = (value: CanonicalJson): string => {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "string" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return "[" + value.map(serializeCaptured).join(",") + "]";
  return "{" + Object.keys(value).map((key) =>
    JSON.stringify(key) + ":" + serializeCaptured(value[key] as CanonicalJson)).join(",") + "}";
};

export const canonicalJsonStringify = (value: CanonicalJson): string =>
  serializeCaptured(captureCanonicalJson(value));

export const canonicalSha256 = (value: CanonicalJson): string =>
  createHash(sha256Algorithm).update(canonicalJsonStringify(value), "utf8").digest("hex");

export const sha256Bytes = (value: Uint8Array): string =>
  createHash(sha256Algorithm).update(value).digest("hex");
