import { describe, expect, it } from "vitest";

import {
  assetIdentitySchema,
  canonicalAmountSchema,
  chainAnchorSchema,
  compareCodePointSequences,
  observationIdSchema,
  nativeGasRateSchema,
} from "../../src/core/index.js";
import {
  assertCanonicalAmountBindings,
  canonicalUnsignedDecimalMaximumPattern,
  maximumTokenDecimals,
  type ObservationClaimBinding,
} from "../../src/core/amounts.js";

const id = (character: string) => observationIdSchema.parse(
  `obs:${Buffer.alloc(32, character.codePointAt(0) ?? 0).toString("base64url")}`,
);
const assetA = assetIdentitySchema.parse({ kind: "erc20", chainId: "4663", address: `0x${"1".repeat(40)}` });
const assetB = assetIdentitySchema.parse({ kind: "erc20", chainId: "4663", address: `0x${"2".repeat(40)}` });
const anchor = chainAnchorSchema.parse({
  chainId: "4663",
  blockNumber: "10",
  blockHash: `0x${"a".repeat(64)}`,
  blockTimestamp: "2026-07-12T10:16:02.000Z",
});
const roles = { quantity: "token_balance", decimals: "token_decimals" } as const;

const availableAmount = (quantity: ReturnType<typeof id>, decimals: ReturnType<typeof id>) => ({
  asset: assetA,
  raw: "1000000",
  decimals: { status: "available", value: "6", observationId: decimals },
  quantityObservationId: quantity,
});

describe("amount observation commitments", () => {
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

  it("binds quantity and decimals role, value, asset, and chain anchor", () => {
    const quantity = id("A");
    const decimals = id("B");
    const bindings: ObservationClaimBinding[] = [
      { observationId: quantity, role: roles.quantity, value: "1000000", asset: assetA, chainAnchor: anchor },
      { observationId: decimals, role: roles.decimals, value: "6", asset: assetA, chainAnchor: anchor },
    ];
    expect(assertCanonicalAmountBindings(
      availableAmount(quantity, decimals),
      bindings,
      new Set(),
      roles,
    )).toMatchObject({ raw: "1000000" });
  });

  it("rejects a mismatched quantity value and a reused quantity observation", () => {
    const quantity = id("A");
    const decimals = id("B");
    expect(() => assertCanonicalAmountBindings(availableAmount(quantity, decimals), [
      { observationId: quantity, role: roles.quantity, value: "999999", asset: assetA, chainAnchor: anchor },
      { observationId: decimals, role: roles.decimals, value: "6", asset: assetA, chainAnchor: anchor },
    ], new Set(), roles)).toThrow("role, value, and asset");

    expect(() => assertCanonicalAmountBindings({
      ...availableAmount(quantity, decimals),
      decimals: { status: "available", value: "6", observationId: quantity },
    }, [
      { observationId: quantity, role: roles.quantity, value: "1000000", asset: assetA, chainAnchor: anchor },
      { observationId: quantity, role: roles.decimals, value: "6", asset: assetA, chainAnchor: anchor },
    ], new Set(), roles)).toThrow();
  });

  it("rejects decimals from another asset, anchor, role, or value", () => {
    const quantity = id("A");
    const decimals = id("B");
    const amount = availableAmount(quantity, decimals);
    const quantityBinding: ObservationClaimBinding = {
      observationId: quantity,
      role: roles.quantity,
      value: "1000000",
      asset: assetA,
      chainAnchor: anchor,
    };
    for (const decimalBinding of [
      { observationId: decimals, role: roles.decimals, value: "6", asset: assetB, chainAnchor: anchor },
      {
        observationId: decimals,
        role: roles.decimals,
        value: "6",
        asset: assetA,
        chainAnchor: chainAnchorSchema.parse({ ...anchor, blockNumber: "9" }),
      },
      { observationId: decimals, role: "token_symbol", value: "6", asset: assetA, chainAnchor: anchor },
      { observationId: decimals, role: roles.decimals, value: "18", asset: assetA, chainAnchor: anchor },
    ] satisfies ObservationClaimBinding[][][number]) {
      expect(() => assertCanonicalAmountBindings(amount, [quantityBinding, decimalBinding], new Set(), roles)).toThrow();
    }
  });

  it("requires missing and conflicting decimals to preserve their actual observations", () => {
    const quantity = id("A");
    const first = id("B");
    const second = id("C");
    const quantityBinding: ObservationClaimBinding = {
      observationId: quantity,
      role: roles.quantity,
      value: "1",
      asset: assetA,
      chainAnchor: anchor,
    };
    const unavailable = {
      asset: assetA,
      raw: "1",
      decimals: { status: "unavailable", reason: "missing", observationIds: [first] },
      quantityObservationId: quantity,
    };
    expect(assertCanonicalAmountBindings(unavailable, [
      quantityBinding,
      { observationId: first, role: roles.decimals, value: null, asset: assetA, chainAnchor: anchor },
    ], new Set(), roles).decimals.status).toBe("unavailable");
    expect(() => assertCanonicalAmountBindings(unavailable, [
      quantityBinding,
      { observationId: first, role: roles.decimals, value: "6", asset: assetA, chainAnchor: anchor },
    ], new Set(), roles)).toThrow("missing value");

    const conflictingIds = [first, second].sort(compareCodePointSequences);
    const conflicting = {
      ...unavailable,
      decimals: { status: "unavailable", reason: "conflicting", observationIds: conflictingIds },
    };
    expect(() => assertCanonicalAmountBindings(conflicting, [
      quantityBinding,
      { observationId: first, role: roles.decimals, value: "6", asset: assetA, chainAnchor: anchor },
      { observationId: second, role: roles.decimals, value: "6", asset: assetA, chainAnchor: anchor },
    ], new Set(), roles)).toThrow("distinct canonical values");
    expect(assertCanonicalAmountBindings(conflicting, [
      quantityBinding,
      { observationId: first, role: roles.decimals, value: "6", asset: assetA, chainAnchor: anchor },
      { observationId: second, role: roles.decimals, value: "18", asset: assetA, chainAnchor: anchor },
    ], new Set(), roles).decimals.status).toBe("unavailable");
  });

  it("accepts not_observed only for the exact owned amount-field exclusion", () => {
    const quantity = id("A");
    const amount = {
      asset: { kind: "native", chainId: "4663" },
      raw: "1",
      decimals: { status: "not_observed", scopeExclusionId: "account_native_decimals_not_observed" },
      quantityObservationId: quantity,
    };
    const native = assetIdentitySchema.parse({ kind: "native", chainId: "4663" });
    const bindings: ObservationClaimBinding[] = [
      { observationId: quantity, role: "native_balance", value: "1", asset: native, chainAnchor: anchor },
    ];
    const nativeRoles = { quantity: "native_balance", decimals: "native_decimals" };
    expect(() => assertCanonicalAmountBindings(amount, bindings, new Set(), nativeRoles)).toThrow("not owned");
    expect(assertCanonicalAmountBindings(
      amount,
      bindings,
      new Set(["account_native_decimals_not_observed"]),
      nativeRoles,
    ).raw).toBe("1");
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
    const native = { kind: "native", chainId: "4663" };
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
