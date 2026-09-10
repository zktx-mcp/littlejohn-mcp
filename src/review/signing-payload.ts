import { z } from "zod";
import {
  captureCanonicalJson, canonicalJsonStringify, deepFreezeValue, isWellFormedText,
  guardJsonSchema, jsonObject, productChainNumericId, utf8ByteLength,
} from "../core/client.js";
import { requestReviewLimits } from "./request-limits.js";
import { walletSigningMethods } from "../wallet/session-requirements.js";

const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u);
const field = jsonObject({ name: identifier, type: z.string() }).strict();
const typed = jsonObject({
  kind: z.literal("typed_data"),
  types: z.record(identifier, z.array(field)),
  primaryType: identifier,
  domain: z.record(z.string(), z.json()),
  message: z.record(z.string(), z.json()),
}).strict();
export type TypedSigningPayload = z.infer<typeof typed>;

const domainTypes: Readonly<Record<string, string>> = Object.freeze({
  name: "string", version: "string", chainId: "uint256", verifyingContract: "address", salt: "bytes32",
});
const atom = (type: string): boolean => {
  if (["address", "bool", "string", "bytes"].includes(type)) return true;
  const integer = /^(u?int)([0-9]+)$/u.exec(type);
  if (integer !== null) return Number(integer[2]) >= 8 && Number(integer[2]) <= 256 &&
    Number(integer[2]) % 8 === 0 && String(Number(integer[2])) === integer[2];
  const bytes = /^bytes([0-9]+)$/u.exec(type);
  return bytes !== null && Number(bytes[1]) >= 1 && Number(bytes[1]) <= 32 && String(Number(bytes[1])) === bytes[1];
};
const arrayType = (type: string) => /^(.*)\[([1-9][0-9]*|)\]$/u.exec(type);
const invalid = (): never => { throw new TypeError("Invalid declared signing data."); };

// Admission and SDK value conversion share the declared EIP-712 type traversal.
// This does not hash data or infer meaning from names such as amount or spender.
export const signingTypedDataValues = (payload: TypedSigningPayload) => {
  const hasType = (name: string) => Object.hasOwn(payload.types, name);
  const checkType = (type: string): void => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[(?:[1-9][0-9]*|)\])*$/u.exec(type);
    if (match === null || (!atom(match[1]!) && !hasType(match[1]!))) invalid();
  };
  for (const [name, fields] of Object.entries(payload.types)) {
    if (atom(name) || name === "uint" || name === "int" || new Set(fields.map((entry) => entry.name)).size !== fields.length) invalid();
    for (const entry of fields) checkType(entry.type);
  }
  // viem's domain-only hash omits message entirely. It cannot represent this
  // command's complete domain-and-message decision.
  if (!hasType("EIP712Domain") || !hasType(payload.primaryType) || payload.primaryType === "EIP712Domain") invalid();
  for (const entry of payload.types["EIP712Domain"]!) {
    if (!Object.hasOwn(domainTypes, entry.name) || domainTypes[entry.name] !== entry.type) invalid();
  }
  const convert = (type: string, value: unknown): unknown => {
    const array = arrayType(type);
    if (array !== null) {
      if (!Array.isArray(value) || (array[2] !== "" && BigInt(array[2]!) !== BigInt(value.length))) return invalid();
      return value.map((entry) => convert(array[1]!, entry));
    }
    if (hasType(type)) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid();
      const fields = payload.types[type]!;
      const record = value as Record<string, unknown>;
      if (Object.keys(record).length !== fields.length || fields.some((entry) => !Object.hasOwn(record, entry.name))) return invalid();
      return Object.fromEntries(fields.map((entry) => [entry.name, convert(entry.type, record[entry.name])]));
    }
    if (type === "string") return typeof value === "string" && isWellFormedText(value) ? value : invalid();
    if (type === "bool") return typeof value === "boolean" ? value : invalid();
    if (type === "address") return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/u.test(value) ? value : invalid();
    if (type === "bytes" || type.startsWith("bytes")) {
      if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/u.test(value) ||
          (type !== "bytes" && value.length !== 2 + 2 * Number(type.slice(5)))) return invalid();
      return value;
    }
    const integer = /^(u?int)([0-9]+)$/u.exec(type);
    if (integer === null || typeof value !== "string" || !/^(?:0|-?[1-9][0-9]*)$/u.test(value)) return invalid();
    const bits = BigInt(integer[2]!);
    const number = BigInt(value);
    const signed = integer[1] === "int";
    const lower = signed ? -(1n << (bits - 1n)) : 0n;
    const upper = 1n << (signed ? bits - 1n : bits);
    return number >= lower && number < upper ? number : invalid();
  };
  return {
    types: payload.types,
    primaryType: payload.primaryType,
    domain: convert("EIP712Domain", payload.domain) as Record<string, unknown>,
    message: convert(payload.primaryType, payload.message) as Record<string, unknown>,
  };
};

export const signingPayloadSchema = guardJsonSchema(z.discriminatedUnion("kind", [
  jsonObject({ kind: z.literal("personal"), encoding: z.enum(["utf8", "hex"]), value: z.string() }).strict(),
  typed,
]).superRefine((payload, context) => {
  try {
    const captured = captureCanonicalJson(payload);
    if (utf8ByteLength(canonicalJsonStringify(captured)) > requestReviewLimits.reviewUtf8Bytes) return invalid();
    if (payload.kind === "personal") {
      if (payload.encoding === "hex" && !/^0x(?:[0-9a-fA-F]{2})*$/u.test(payload.value)) invalid();
    } else {
      signingTypedDataValues(payload);
      if (Object.hasOwn(payload.domain, "chainId") && payload.domain["chainId"] !== String(productChainNumericId)) invalid();
    }
  } catch { context.addIssue({ code: "custom", message: "Signing data violates its declared types or input envelope." }); }
}));
export type SigningPayload = z.infer<typeof signingPayloadSchema>;
export const admitSigningPayload = (value: unknown): SigningPayload =>
  deepFreezeValue(signingPayloadSchema.parse(captureCanonicalJson(value)));
export const signingMethod = (payload: SigningPayload) => walletSigningMethods[payload.kind];
export const personalSigningHex = (payload: Extract<SigningPayload, { kind: "personal" }>): `0x${string}` => {
  if (payload.encoding === "hex") return payload.value.toLowerCase() as `0x${string}`;
  return `0x${Array.from(new TextEncoder().encode(payload.value), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
};
