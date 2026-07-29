import { describe, expect, it } from "vitest";
import {
  calculateScaledUiAmount,
  assetIdentitySchema,
  canonicalAmountSchema,
  compareCodePointSequences,
  observationIdSchema,
  nativeGasRateSchema,
  scaledUiAmountSchema,
} from "../../src/core/index.js";
import {
  canonicalUnsignedDecimalMaximumPattern,
  formatAmount,
  maximumTokenDecimals,
} from "../../src/core/amounts.js";

const id = (character: string) => observationIdSchema.parse(
  `obs:${Buffer.alloc(32, character.codePointAt(0) ?? 0).toString("base64url")}`,
);
const assetA = assetIdentitySchema.parse({ kind: "erc20", chainId: "eip155:4663", address: `0x${"1".repeat(40)}` });

const availableAmount = (quantity: ReturnType<typeof id>, decimals: ReturnType<typeof id>) => ({
  asset: assetA,
  raw: "1000000",
  decimals: { status: "available", value: "6", observationId: decimals },
  quantityObservationId: quantity,
});

describe("amount observation commitments", () => {
  it("applies the ERC-8056 multiplier once with exact integer rounding", () => {
    expect(calculateScaledUiAmount("100", "1500000000000000000")).toEqual({
      status: "available",
      raw: "100",
      multiplier: "1500000000000000000",
      scale: "1000000000000000000",
      adjustedRaw: "150",
    });
    expect(calculateScaledUiAmount("1", "1500000000000000000")).toMatchObject({
      status: "available",
      adjustedRaw: "1",
    });
    const maximum = ((1n << 256n) - 1n).toString(10);
    expect(calculateScaledUiAmount(maximum, "1000000000000000000")).toMatchObject({
      status: "available",
      adjustedRaw: maximum,
    });
    expect(calculateScaledUiAmount(maximum, maximum)).toEqual({
      status: "unavailable",
      reason: "result_out_of_range",
      raw: maximum,
      multiplier: maximum,
      scale: "1000000000000000000",
    });
    expect(() => scaledUiAmountSchema.parse({
      status: "available",
      raw: "100",
      multiplier: "1500000000000000000",
      scale: "1000000000000000000",
      adjustedRaw: "151",
    })).toThrow();
    expect(() => scaledUiAmountSchema.parse({
      status: "unavailable",
      reason: "result_out_of_range",
      raw: "1",
      multiplier: "1",
      scale: "1000000000000000000",
    })).toThrow();
    for (const malformed of ["-1", "01", "1.0", (1n << 256n).toString(10)]) {
      expect(() => calculateScaledUiAmount(malformed, "1")).toThrow(TypeError);
      expect(() => calculateScaledUiAmount("1", malformed)).toThrow(TypeError);
    }
  });

  it("formats canonical raw units without numeric conversion or insignificant zeroes", () => {
    expect(formatAmount("0", "18")).toBe("0");
    expect(formatAmount("1", "6")).toBe("0.000001");
    expect(formatAmount("1000000", "6")).toBe("1");
    expect(formatAmount("1234500", "6")).toBe("1.2345");
    expect(formatAmount("9007199254740993000000", "6")).toBe("9007199254740993");
    expect(formatAmount("1", String(maximumTokenDecimals))).toBe(
      `0.${"0".repeat(maximumTokenDecimals - 1)}1`,
    );

    for (const [raw, decimals] of [
      ["01", "6"],
      ["-1", "6"],
      ["1", "00"],
      ["1", String(maximumTokenDecimals + 1)],
    ] as const) expect(() => formatAmount(raw, decimals)).toThrow(TypeError);
  });

  it("derives canonical unsigned-decimal bounds without widening the schema range", () => {
    for (const maximum of [0, 1, 9, 10, 99, 100, 127, maximumTokenDecimals, 1_000]) {
      const pattern = new RegExp(canonicalUnsignedDecimalMaximumPattern(maximum), "u");
      for (let value = 0; value <= maximum; value += 1) {
        expect(pattern.test(String(value))).toBe(true);
      }
      expect(pattern.test(String(maximum + 1))).toBe(false);
      for (const malformed of ["", "-1", "00", "01", "1.0", "1e2", `0${maximum}`]) {
        expect(pattern.test(malformed)).toBe(false);
      }
    }
    for (const invalid of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => canonicalUnsignedDecimalMaximumPattern(invalid)).toThrow(TypeError);
    }
    const maximumSafePattern = new RegExp(
      canonicalUnsignedDecimalMaximumPattern(Number.MAX_SAFE_INTEGER),
      "u",
    );
    expect(maximumSafePattern.test(String(Number.MAX_SAFE_INTEGER))).toBe(true);
    expect(maximumSafePattern.test(String(Number.MAX_SAFE_INTEGER - 1))).toBe(true);
    expect(maximumSafePattern.test("9007199254740992")).toBe(false);
  });

  it("keeps evidence-free amount invariants in the canonical schemas", () => {
    const quantity = id("A");
    const first = id("B");
    const second = id("C");
    expect(canonicalAmountSchema.safeParse({
      asset: assetA,
      raw: "1",
      decimals: { status: "unavailable", reason: "conflicting", observationIds: [first] },
      quantityObservationId: quantity,
    }).success).toBe(false);
    expect(canonicalAmountSchema.safeParse({
      asset: assetA,
      raw: "1",
      decimals: {
        status: "unavailable",
        reason: "conflicting",
        observationIds: [first, second].sort(compareCodePointSequences).reverse(),
      },
      quantityObservationId: quantity,
    }).success).toBe(false);
    expect(canonicalAmountSchema.safeParse({
      asset: assetA,
      raw: "1",
      decimals: { status: "available", value: "6", observationId: quantity },
      quantityObservationId: quantity,
    }).success).toBe(false);
    const native = { kind: "native", chainId: "eip155:4663" };
    const numerator = {
      asset: native,
      raw: "1",
      decimals: { status: "not_observed", scopeExclusionId: "transaction_native_decimals_not_observed" },
      quantityObservationId: quantity,
    };
    expect(nativeGasRateSchema.safeParse({
      numerator,
      denominator: { unit: "gas", raw: "1" },
      observationId: first,
    }).success).toBe(false);

    const assetWithPrototypeKey = Object.defineProperty({ ...assetA }, "__proto__", {
      value: undefined,
      enumerable: true,
    });
    expect(canonicalAmountSchema.safeParse({
      ...availableAmount(quantity, first),
      asset: assetWithPrototypeKey,
    }).success).toBe(false);
  });
});
