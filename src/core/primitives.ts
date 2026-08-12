import { z } from "zod";

import {
  evmAddressSchema,
  evmChainIdSchema,
  parseEvmAddress,
  type EvmAddress,
} from "./identities.js";
import { guardJsonSchema, jsonObject } from "./json-object.js";

type NonEmptyTupleSchemas = readonly [z.ZodType, ...z.ZodType[]];

export const closedTupleSchema = <const Items extends NonEmptyTupleSchemas>(
  items: Items,
) => z.tuple(items).meta({
  minItems: items.length,
  maxItems: items.length,
  items: false,
});

const unsafeSingleLineCodePoint = (codePoint: number): boolean =>
  codePoint <= 0x1f ||
  (codePoint >= 0x7f && codePoint <= 0x9f) ||
  codePoint === 0x2028 ||
  codePoint === 0x2029 ||
  (codePoint >= 0x202a && codePoint <= 0x202e) ||
  (codePoint >= 0x2066 && codePoint <= 0x2069);

export const isWellFormedText = (value: string): boolean =>
  (value as string & { isWellFormed(): boolean }).isWellFormed();

export const isSafeSingleLineText = (value: string): boolean => {
  if (!isWellFormedText(value)) return false;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || unsafeSingleLineCodePoint(codePoint)) {
      return false;
    }
  }
  return true;
};

export const codePointLength = (value: string): number => [...value].length;

const base64UrlAlphabetPattern = "[A-Za-z0-9_-]";
const base64UrlTailPattern = (byteLength: number): string => {
  const remainder = byteLength % 3;
  if (remainder === 0) return base64UrlAlphabetPattern;
  return remainder === 1 ? "[AQgw]" : "[AEIMQUYcgkosw048]";
};

export const canonicalBase64UrlPattern = (byteLength: number): string => {
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0) {
    throw new TypeError("Base64url byte length must be a positive safe integer.");
  }
  const encodedLength = Math.ceil(byteLength * 4 / 3);
  return byteLength % 3 === 0
    ? `^${base64UrlAlphabetPattern}{${encodedLength}}$`
    : `^${base64UrlAlphabetPattern}{${encodedLength - 1}}${base64UrlTailPattern(byteLength)}$`;
};

export const decodeCanonicalBase64Url = (value: string, byteLength: number): Uint8Array => {
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0) {
    throw new TypeError("Base64url byte length must be a positive safe integer.");
  }
  if (!new RegExp(canonicalBase64UrlPattern(byteLength), "u").test(value)) {
    throw new TypeError("Expected canonical unpadded base64url.");
  }
  let decoded: string;
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/") +
      "=".repeat((4 - value.length % 4) % 4);
    decoded = globalThis.atob(base64);
  } catch {
    throw new TypeError("Expected canonical unpadded base64url.");
  }
  if (decoded.length !== byteLength) throw new TypeError("Expected canonical unpadded base64url.");
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
};

export const canonicalBase64UrlSchema = (byteLength: number) => {
  const pattern = canonicalBase64UrlPattern(byteLength);
  return z.string()
    .regex(new RegExp(pattern, "u"), "Expected canonical unpadded base64url.")
    .meta({ pattern });
};

export const base64UrlSha256Schema = canonicalBase64UrlSchema(32);

export const prefixedCanonicalBase64UrlSchema = (prefix: string, byteLength: number) =>
  z.string().superRefine((value, context) => {
    if (!value.startsWith(prefix)) {
      context.addIssue({ code: "custom", message: "Expected the canonical identifier prefix." });
      return;
    }
    try {
      decodeCanonicalBase64Url(value.slice(prefix.length), byteLength);
    } catch {
      context.addIssue({ code: "custom", message: "Expected a canonical encoded identifier." });
    }
  }).meta({
    pattern: canonicalBase64UrlPattern(byteLength)
      .replace("^", `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  });

export const compareCodePointSequences = (left: string, right: string): number => {
  const leftIterator = left[Symbol.iterator]();
  const rightIterator = right[Symbol.iterator]();

  while (true) {
    const leftPart = leftIterator.next();
    const rightPart = rightIterator.next();
    if (leftPart.done || rightPart.done) {
      if (leftPart.done && rightPart.done) return 0;
      return leftPart.done ? -1 : 1;
    }

    const leftCodePoint = leftPart.value.codePointAt(0);
    const rightCodePoint = rightPart.value.codePointAt(0);
    if (leftCodePoint === undefined || rightCodePoint === undefined) {
      throw new TypeError("A string iterator returned an invalid character.");
    }
    if (leftCodePoint !== rightCodePoint) {
      return leftCodePoint < rightCodePoint ? -1 : 1;
    }
  }
};

const brandedString = <Brand extends string>(
  pattern: RegExp,
  message: string,
  brand: Brand,
) => z.string().regex(pattern, message).brand(brand);

const unsignedDecimalPattern = /^(?:0|[1-9][0-9]*)$/;
const hexWord32Pattern = /^0x[0-9a-f]{64}$/;
const hexBytesPattern = /^0x(?:[0-9a-f]{2})*$/;
const fixedIdentifierPattern = /^[\x21-\x7e]+$/;
const snakeCaseCodePattern = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

const leapYearPattern = "(?:[0-9]{2}(?:0[48]|[2468][048]|[13579][26])|(?:0[48]|[2468][048]|[13579][26])00)";
const utcTimestampPattern = new RegExp(
  `^(?:(?:[0-9]{4}-(?:(?:01|03|05|07|08|10|12)-(?:0[1-9]|[12][0-9]|3[01])|(?:04|06|09|11)-(?:0[1-9]|[12][0-9]|30)|02-(?:0[1-9]|1[0-9]|2[0-8])))|(?:${leapYearPattern}-02-29))T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\\.[0-9]{3}Z$`,
);

export const createPrimitiveSchemaSet = () => {
  const unsignedDecimal = brandedString(
    unsignedDecimalPattern,
    "Expected a canonical unsigned base-10 integer string.",
    "UnsignedDecimal",
  );
  const evmAddress = evmAddressSchema;
  const hash32 = brandedString(
    hexWord32Pattern,
    "Expected a canonical lowercase 32-byte hash.",
    "Hash32",
  );
  const hexBytes = brandedString(
    hexBytesPattern,
    "Expected canonical lowercase even-length hexadecimal bytes.",
    "HexBytes",
  );
  const utcTimestamp = z.string()
    .regex(utcTimestampPattern, "Expected a real UTC RFC 3339 timestamp with millisecond precision.")
    .brand("UtcTimestamp");
  const fixedIdentifier = z.string()
    .min(1)
    .max(64)
    .regex(fixedIdentifierPattern, "Expected printable ASCII without spaces.")
    .refine(isSafeSingleLineText, "Expected safe single-line text.")
    .brand("FixedIdentifier");
  const snakeCaseCode = z.string()
    .min(1)
    .max(64)
    .regex(snakeCaseCodePattern, "Expected a lowercase snake-case code.")
    .brand("SnakeCaseCode");
  const generalSingleLineText = z.string()
    .min(1)
    .refine((value) => codePointLength(value) <= 512, "Text exceeds 512 Unicode code points.")
    .refine(isSafeSingleLineText, "Expected safe single-line text.");
  const warningMessage = z.string()
    .min(1)
    .refine((value) => codePointLength(value) <= 256, "Warning exceeds 256 Unicode code points.")
    .refine(isSafeSingleLineText, "Expected safe single-line text.");
  const blockSelector = z.discriminatedUnion("kind", [
    jsonObject({ kind: z.literal("latest") }).strict(),
    jsonObject({ kind: z.literal("number"), blockNumber: unsignedDecimal }).strict(),
  ]);
  const chainAnchor = jsonObject({
    chainId: evmChainIdSchema,
    blockNumber: unsignedDecimal,
    blockHash: hash32,
    blockTimestamp: utcTimestamp,
  }).strict();
  return Object.freeze({
    unsignedDecimal,
    evmAddress,
    hash32,
    hexBytes,
    utcTimestamp,
    fixedIdentifier,
    snakeCaseCode,
    generalSingleLineText,
    warningMessage,
    blockSelector,
    chainAnchor,
  });
};

const primitiveSchemas = createPrimitiveSchemaSet();
const parserPrimitiveSchemas = createPrimitiveSchemaSet();

export const unsignedDecimalSchema = primitiveSchemas.unsignedDecimal;
export type UnsignedDecimal = z.infer<typeof unsignedDecimalSchema>;

export { evmAddressSchema, parseEvmAddress } from "./identities.js";
export type { EvmAddress } from "./identities.js";

export const hash32Schema = primitiveSchemas.hash32;
export type Hash32 = z.infer<typeof hash32Schema>;

export const hexBytesSchema = primitiveSchemas.hexBytes;
export type HexBytes = z.infer<typeof hexBytesSchema>;

export const utcTimestampSchema = primitiveSchemas.utcTimestamp;
export type UtcTimestamp = z.infer<typeof utcTimestampSchema>;

export const fixedIdentifierSchema = primitiveSchemas.fixedIdentifier;
export type FixedIdentifier = z.infer<typeof fixedIdentifierSchema>;

export const snakeCaseCodeSchema = primitiveSchemas.snakeCaseCode;
export type SnakeCaseCode = z.infer<typeof snakeCaseCodeSchema>;

export const generalSingleLineTextSchema = primitiveSchemas.generalSingleLineText;

export const warningMessageSchema = primitiveSchemas.warningMessage;

export const blockSelectorSchema = guardJsonSchema(primitiveSchemas.blockSelector);
export type BlockSelector = z.infer<typeof blockSelectorSchema>;

export const chainAnchorSchema = guardJsonSchema(primitiveSchemas.chainAnchor);
export type ChainAnchor = z.infer<typeof chainAnchorSchema>;

export const parseUnsignedDecimal = (value: unknown): UnsignedDecimal =>
  parserPrimitiveSchemas.unsignedDecimal.parse(value);
export const parseHash32 = (value: unknown): Hash32 => parserPrimitiveSchemas.hash32.parse(value);
export const parseHexBytes = (value: unknown): HexBytes => parserPrimitiveSchemas.hexBytes.parse(value);
export const parseUtcTimestamp = (value: unknown): UtcTimestamp => parserPrimitiveSchemas.utcTimestamp.parse(value);

export const isCanonicalHexWord32 = (value: string): boolean => hexWord32Pattern.test(value);

export const sortUniqueStrings = <Value extends string>(values: readonly Value[]): Value[] => {
  const sorted = [...values].sort(compareCodePointSequences);
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index - 1] === sorted[index]) {
      throw new TypeError("Expected unique canonical strings.");
    }
  }
  return sorted;
};
