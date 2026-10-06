import { describe, expect, it } from "vitest";

import {tokenDisplayTextLimits, tokenDisplayTextSchema} from "../../src/core/index.js";

describe("shared display text contract", () => {
  it("owns the exact display limits", () => {
    expect(tokenDisplayTextLimits).toEqual({
      codePoints: 128,
      utf8Bytes: 512,
    });
    expect(Object.isFrozen(tokenDisplayTextLimits)).toBe(true);
  });

  it("admits only bounded safe single-line display text", () => {
    expect(tokenDisplayTextSchema.parse("A".repeat(128))).toBe("A".repeat(128));
    expect(tokenDisplayTextSchema.parse("😀".repeat(128))).toBe("😀".repeat(128));
    expect(() => tokenDisplayTextSchema.parse("A".repeat(129))).toThrow();
    expect(() => tokenDisplayTextSchema.parse("😀".repeat(129))).toThrow();
    expect(() => tokenDisplayTextSchema.parse("line one\nline two")).toThrow();
    expect(() => tokenDisplayTextSchema.parse("unsafe\u0000text")).toThrow();
  });

});
