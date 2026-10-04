import { describe, expect, it } from "vitest";

import {formatRationalForDisplay, scaleRawUnitPriceToTokenUnits} from "../../src/evm/numeric-display.js";
import {createExactRational, exactRationalMaximumDigits} from "../../src/core/index.js";

describe("numeric display", () => {
  it("formats exact and rounded values with one declared significant-digit rule", () => {
    expect(formatRationalForDisplay({ numerator: "0", denominator: "1" })).toEqual({
      relation: "exact",
      notation: "plain",
      coefficient: "0",
      exponent: 0,
    });
    expect(formatRationalForDisplay({ numerator: "1", denominator: "8" })).toEqual({
      relation: "exact",
      notation: "plain",
      coefficient: "0.125",
      exponent: 0,
    });
    expect(formatRationalForDisplay({ numerator: "1", denominator: "3" })).toEqual({
      relation: "approximately",
      notation: "plain",
      coefficient: "0.33333333",
      exponent: 0,
    });
    expect(formatRationalForDisplay({
      numerator: "20000001",
      denominator: "20000000",
    })).toEqual({
      relation: "approximately",
      notation: "plain",
      coefficient: "1",
      exponent: 0,
    });
    expect(formatRationalForDisplay({
      numerator: "20000003",
      denominator: "20000000",
    })).toEqual({
      relation: "approximately",
      notation: "plain",
      coefficient: "1.0000002",
      exponent: 0,
    });
    expect(formatRationalForDisplay({
      numerator: "199999999",
      denominator: "20000000",
    })).toEqual({
      relation: "approximately",
      notation: "plain",
      coefficient: "10",
      exponent: 0,
    });
  });

  it("selects plain and scientific notation after rounding", () => {
    expect(formatRationalForDisplay({ numerator: "1", denominator: "1000000" })).toEqual({
      relation: "exact",
      notation: "plain",
      coefficient: "0.000001",
      exponent: 0,
    });
    expect(formatRationalForDisplay({ numerator: "1", denominator: "10000000" })).toEqual({
      relation: "exact",
      notation: "scientific",
      coefficient: "1",
      exponent: -7,
    });
    expect(formatRationalForDisplay({
      numerator: "1000000000000000",
      denominator: "1",
    })).toEqual({
      relation: "exact",
      notation: "plain",
      coefficient: "1000000000000000",
      exponent: 0,
    });
    expect(formatRationalForDisplay({
      numerator: "10000000000000000",
      denominator: "1",
    })).toEqual({
      relation: "exact",
      notation: "scientific",
      coefficient: "1",
      exponent: 16,
    });
    expect(formatRationalForDisplay({
      numerator: "9999999950000000",
      denominator: "1",
    })).toEqual({
      relation: "approximately",
      notation: "scientific",
      coefficient: "1",
      exponent: 16,
    });
    expect(formatRationalForDisplay({
      numerator: "1000003",
      denominator: "1000000",
    })).toEqual({
      relation: "exact",
      notation: "plain",
      coefficient: "1.000003",
      exponent: 0,
    });
  });

  it("preserves tiny positive values and rejects malformed rational objects", () => {
    const maximumComponent = "9".repeat(exactRationalMaximumDigits);
    expect(formatRationalForDisplay({
      numerator: "1",
      denominator: maximumComponent,
    })).toMatchObject({
      relation: "approximately",
      notation: "scientific",
      exponent: -exactRationalMaximumDigits,
    });
    expect(formatRationalForDisplay({
      numerator: "1",
      denominator: "1000000000",
    })).toEqual({
      relation: "exact",
      notation: "scientific",
      coefficient: "1",
      exponent: -9,
    });
    for (const value of [
      { numerator: "-1", denominator: "1" },
      { numerator: "01", denominator: "1" },
      { numerator: "1", denominator: "0" },
      { numerator: "2", denominator: "4" },
      { numerator: "0", denominator: "2" },
      { numerator: "1".repeat(
        exactRationalMaximumDigits + 256,
      ), denominator: "1" },
    ]) {
      expect(() => formatRationalForDisplay(value)).toThrow(TypeError);
    }
  });

  it("scales raw-unit prices to an exact reduced token-unit rational", () => {
    expect(scaleRawUnitPriceToTokenUnits(
      createExactRational(3n, 2n),
      "18",
      "6",
    )).toEqual({
      numerator: "1500000000000",
      denominator: "1",
    });
    expect(scaleRawUnitPriceToTokenUnits(
      createExactRational(1n, 2n),
      "6",
      "18",
    )).toEqual({
      numerator: "1",
      denominator: "2000000000000",
    });
    expect(scaleRawUnitPriceToTokenUnits(
      createExactRational(2n, 5n),
      "6",
      "6",
    )).toEqual({
      numerator: "2",
      denominator: "5",
    });
    expect(() => scaleRawUnitPriceToTokenUnits(
      createExactRational(1n, 1n),
      "256",
      "0",
    )).toThrow(TypeError);
  });
});
