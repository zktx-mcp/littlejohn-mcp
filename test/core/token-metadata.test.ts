import { describe, expect, it } from "vitest";

import {
  tokenDisplayTextLimits,
  tokenDisplayTextSchema,
  tokenMetadataReadSchema,
  tokenMetadataDecimalsReadFailureReasons,
  tokenOptionalTextUnavailableReasons,
} from "../../src/core/token-metadata.js";

describe("token display metadata contract", () => {
  it("owns the exact display limits and ordered unavailable reasons", () => {
    expect(tokenDisplayTextLimits).toEqual({
      codePoints: 128,
      utf8Bytes: 512,
    });
    expect(tokenOptionalTextUnavailableReasons).toEqual([
      "call_failed",
      "malformed",
      "unsafe_text",
    ]);
    expect(tokenMetadataDecimalsReadFailureReasons).toEqual([
      "call_failed",
      "malformed",
    ]);
    expect(Object.isFrozen(tokenDisplayTextLimits)).toBe(true);
    expect(Object.isFrozen(tokenOptionalTextUnavailableReasons)).toBe(true);
  });

  it("admits only bounded safe single-line display text", () => {
    expect(tokenDisplayTextSchema.parse("A".repeat(128))).toBe("A".repeat(128));
    expect(tokenDisplayTextSchema.parse("😀".repeat(128))).toBe("😀".repeat(128));
    expect(() => tokenDisplayTextSchema.parse("A".repeat(129))).toThrow();
    expect(() => tokenDisplayTextSchema.parse("😀".repeat(129))).toThrow();
    expect(() => tokenDisplayTextSchema.parse("line one\nline two")).toThrow();
    expect(() => tokenDisplayTextSchema.parse("unsafe\u0000text")).toThrow();
  });

  it("rejects outcomes outside the one metadata language", () => {
    const result = {
      name: { status: "available", value: "Example" },
      symbol: { status: "unavailable", reason: "call_failed" },
      decimals: { status: "available", value: "18" },
    } as const;
    expect(tokenMetadataReadSchema.parse(result)).toEqual(result);
    expect(() => tokenMetadataReadSchema.parse({
      ...result,
      symbol: { status: "unavailable", reason: "transport_failed" },
    })).toThrow();
    expect(() => tokenMetadataReadSchema.parse({
      ...result,
      decimals: { status: "available", value: "-1" },
    })).toThrow();
    expect(() => tokenMetadataReadSchema.parse({
      ...result,
      decimals: { status: "unavailable", reason: "transport_failed" },
    })).toThrow();
    expect(() => tokenMetadataReadSchema.parse({
      ...result,
      unexpected: true,
    })).toThrow();
  });
});
