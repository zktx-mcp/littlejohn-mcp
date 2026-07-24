import { z } from "zod";

import { utf8ByteLength } from "./canonical-json.js";
import {
  codePointLength,
  isSafeSingleLineText,
  unsignedDecimalSchema,
} from "./primitives.js";

export const tokenDisplayTextLimits = Object.freeze({
  codePoints: 128,
  utf8Bytes: 512,
});

export const tokenDisplayTextSchema = z.string()
  .refine(
    (value) => codePointLength(value) <= tokenDisplayTextLimits.codePoints,
    `Text exceeds ${tokenDisplayTextLimits.codePoints} Unicode code points.`,
  )
  .refine(
    (value) => utf8ByteLength(value) <= tokenDisplayTextLimits.utf8Bytes,
    `Text exceeds ${tokenDisplayTextLimits.utf8Bytes} UTF-8 bytes.`,
  )
  .refine(isSafeSingleLineText, "Expected safe single-line text.");

export const tokenOptionalTextUnavailableReasons = Object.freeze([
  "call_failed",
  "malformed",
  "unsafe_text",
] as const);

export const tokenOptionalTextUnavailableReasonSchema =
  z.enum(tokenOptionalTextUnavailableReasons);

export const availableTokenTextSchema = z.object({
  status: z.literal("available"),
  value: tokenDisplayTextSchema,
}).strict();

export const unavailableTokenTextSchema = z.object({
  status: z.literal("unavailable"),
  reason: tokenOptionalTextUnavailableReasonSchema,
}).strict();

export const optionalTokenTextSchema = z.discriminatedUnion("status", [
  availableTokenTextSchema,
  unavailableTokenTextSchema,
]);

export const tokenMetadataReadSchema = z.object({
  name: optionalTokenTextSchema,
  symbol: optionalTokenTextSchema,
  decimals: unsignedDecimalSchema.nullable(),
}).strict();

export type TokenDisplayText = z.infer<typeof tokenDisplayTextSchema>;
export type TokenOptionalTextUnavailableReason =
  z.infer<typeof tokenOptionalTextUnavailableReasonSchema>;
export type OptionalTokenText = z.infer<typeof optionalTokenTextSchema>;
export type TokenMetadataRead = z.infer<typeof tokenMetadataReadSchema>;
