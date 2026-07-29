import { describe, expect, it } from "vitest";

import {
  parseReferenceChartEntries,
  type ReferenceChartEntry,
} from "../../../src/interfaces/web/reference-chart.js";

const candle = Object.freeze({
  kind: "candlestick" as const,
  time: 100,
  open: 2,
  high: 4,
  low: 1,
  close: 3,
});

describe("reference chart port data admission", () => {
  it("copies and freezes an increasing finite candlestick and whitespace sequence", () => {
    const input = [
      candle,
      { kind: "whitespace", time: 200 },
      { ...candle, time: 300, close: 2 },
    ];
    const parsed = parseReferenceChartEntries(input);

    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(parsed.every(Object.isFrozen)).toBe(true);
    expect(input).toEqual([
      candle,
      { kind: "whitespace", time: 200 },
      { ...candle, time: 300, close: 2 },
    ]);
  });

  it.each([
    ["an empty list", []],
    ["whitespace without a candle", [{ kind: "whitespace", time: 100 }]],
    ["a duplicate time", [candle, { ...candle }]],
    ["decreasing time", [candle, { ...candle, time: 99 }]],
    ["a fractional time", [{ ...candle, time: 100.5 }]],
    ["a non-finite value", [{ ...candle, high: Number.POSITIVE_INFINITY }]],
    ["a missing value", [{
      kind: "candlestick",
      time: 100,
      open: 2,
      high: 4,
      low: 1,
    }]],
    ["an extra field", [{ ...candle, volume: 10 }]],
    ["an extra whitespace field", [
      candle,
      { kind: "whitespace", time: 200, close: 2 },
    ]],
  ])("rejects %s", (_name, input) => {
    expect(() => parseReferenceChartEntries(input))
      .toThrow(/Reference chart/u);
  });

  it("does not accept a typed value as proof when its runtime fields are invalid", () => {
    const forged = Object.freeze({
      ...candle,
      close: Number.NaN,
    }) as ReferenceChartEntry;
    expect(() => parseReferenceChartEntries([forged]))
      .toThrow("Reference chart entry is invalid.");
  });
});
