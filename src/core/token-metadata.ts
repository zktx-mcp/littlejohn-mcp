import { z } from "zod";

import { utf8ByteLength } from "./canonical-json.js";
import {
  codePointLength,
  isSafeSingleLineText,
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

export type TokenDisplayText = z.infer<typeof tokenDisplayTextSchema>;
