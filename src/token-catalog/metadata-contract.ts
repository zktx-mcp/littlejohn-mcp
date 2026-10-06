import { z } from "zod";

import { tokenDisplayTextSchema, unsignedDecimalSchema } from "../core/client.js";

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

export const tokenMetadataDecimalsReadFailureReasons = Object.freeze([
  "call_failed",
  "malformed",
] as const);

export const tokenMetadataDecimalsReadFailureReasonSchema =
  z.enum(tokenMetadataDecimalsReadFailureReasons);

export const tokenMetadataDecimalsReadSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("available"),
    value: unsignedDecimalSchema,
  }).strict(),
  z.object({
    status: z.literal("unavailable"),
    reason: tokenMetadataDecimalsReadFailureReasonSchema,
  }).strict(),
]);

export const tokenMetadataReadSchema = z.object({
  name: optionalTokenTextSchema,
  symbol: optionalTokenTextSchema,
  decimals: tokenMetadataDecimalsReadSchema,
}).strict();

export type TokenOptionalTextUnavailableReason =
  z.infer<typeof tokenOptionalTextUnavailableReasonSchema>;
export type OptionalTokenText = z.infer<typeof optionalTokenTextSchema>;
export type TokenMetadataDecimalsReadFailureReason =
  z.infer<typeof tokenMetadataDecimalsReadFailureReasonSchema>;
export type TokenMetadataDecimalsRead = z.infer<typeof tokenMetadataDecimalsReadSchema>;
export type TokenMetadataRead = z.infer<typeof tokenMetadataReadSchema>;
