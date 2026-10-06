import { describe, expect, it } from "vitest";

import {
  tokenMetadataReadSchema,
  tokenMetadataDecimalsReadFailureReasons,
  tokenOptionalTextUnavailableReasons,
} from "../../src/token-catalog/metadata-contract.js";

describe("Token metadata read contract", () => {
  it("owns the ordered unavailable reasons", () => {
    expect(tokenOptionalTextUnavailableReasons).toEqual([
      "call_failed",
      "malformed",
      "unsafe_text",
    ]);
    expect(tokenMetadataDecimalsReadFailureReasons).toEqual([
      "call_failed",
      "malformed",
    ]);
    expect(Object.isFrozen(tokenOptionalTextUnavailableReasons)).toBe(true);
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
