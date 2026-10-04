import { describe, expect, it } from "vitest";

import {addUtcMilliseconds, createExactRational, exactRationalSchema, greatestCommonDivisor, isStrictlyOrderedUnique, parseUtcTimestamp} from "../../src/core/index.js";
import {parseEvmAccountIdentity, sameEvmAccountIdentity} from "../../src/evm/identities.js";
import { createNonnegativeExactRational } from "../../src/protocols/uniswap-v2/quote.js";
import { subtractUtcCalendarMonths } from "../../src/stock-token-trade-history/calendar.js";
import { stockTokenTradeHistoryRequestedStart } from "../../src/stock-token-trade-history/period-contract.js";

describe("shared value operations", () => {
  it("computes magnitude GCD without imposing financial sign or zero rules", () => {
    for (const [left, right, expected] of [
      [48n, 18n, 6n], [17n, 13n, 1n], [0n, 21n, 21n], [21n, 0n, 21n],
      [0n, 0n, 0n], [-21n, 0n, 21n], [0n, -21n, 21n],
      [-48n, 18n, 6n], [48n, -18n, 6n], [-48n, -18n, 6n],
      [7n * (1n << 180n), 13n * (1n << 180n), 1n << 180n],
    ]) expect(greatestCommonDivisor(left!, right!)).toBe(expected);
    expect(createExactRational(48n, 18n)).toEqual({ numerator: "8", denominator: "3" });
    expect(createNonnegativeExactRational(0n, 18n)).toEqual({ numerator: "0", denominator: "1" });
    expect(() => createExactRational(0n, 18n)).toThrow(TypeError);
    expect(() => createNonnegativeExactRational(-1n, 18n)).toThrow(TypeError);
    for (const [numerator, denominator] of [["-1", "3"], ["1", "-3"], ["0", "0"], ["2", "4"]]) {
      expect(exactRationalSchema.safeParse({ numerator, denominator }).success).toBe(false);
    }
  });

  it("keeps chain and address independently significant in admitted account identity", () => {
    const account = parseEvmAccountIdentity({ chainId: "eip155:4663", address: `0x${"1".repeat(40)}` });
    expect(sameEvmAccountIdentity(account, { ...account })).toBe(true);
    expect(sameEvmAccountIdentity(account, parseEvmAccountIdentity({ ...account, chainId: "eip155:1" }))).toBe(false);
    expect(sameEvmAccountIdentity(account, parseEvmAccountIdentity({ ...account, address: `0x${"2".repeat(40)}` }))).toBe(false);
  });

  it("admits strict code-point order without sorting or dropping entries", () => {
    expect(isStrictlyOrderedUnique([])).toBe(true);
    expect(isStrictlyOrderedUnique(["a"])).toBe(true);
    expect(isStrictlyOrderedUnique(["a", "aa", "b"])).toBe(true);
    const duplicate = Object.freeze(["a", "a"]);
    const reversed = Object.freeze(["b", "a"]);
    expect(isStrictlyOrderedUnique(duplicate)).toBe(false);
    expect(isStrictlyOrderedUnique(reversed)).toBe(false);
    expect(reversed).toEqual(["b", "a"]);
    expect(isStrictlyOrderedUnique(["\ue000", "\u{10000}"])).toBe(true);
    expect(isStrictlyOrderedUnique(["\u{10000}", "\ue000"])).toBe(false);
  });

  it("preserves millisecond duration and whole-second clamped calendar meanings", () => {
    expect(addUtcMilliseconds(parseUtcTimestamp("2028-02-29T23:59:59.999Z"), 1))
      .toBe("2028-03-01T00:00:00.000Z");
    expect(addUtcMilliseconds(parseUtcTimestamp("2028-03-01T00:00:00.000Z"), -1))
      .toBe("2028-02-29T23:59:59.999Z");
    expect(() => addUtcMilliseconds(parseUtcTimestamp("9999-12-31T23:59:59.999Z"), 1)).toThrow();
    for (const [end, months, expected] of [
      ["2028-03-31T12:34:56.789Z", 1, "2028-02-29T12:34:56.000Z"],
      ["2027-03-31T12:34:56.000Z", 1, "2027-02-28T12:34:56.000Z"],
      ["2028-02-29T12:34:56.000Z", 12, "2027-02-28T12:34:56.000Z"],
      ["2028-01-31T12:34:56.000Z", 2, "2027-11-30T12:34:56.000Z"],
    ] as const) {
      expect(subtractUtcCalendarMonths(end, months)).toBe(expected);
      expect(stockTokenTradeHistoryRequestedStart({ unit: "month", count: months }, parseUtcTimestamp(end)))
        .toBe(expected);
    }
  });
});
