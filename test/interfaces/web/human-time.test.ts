import { describe, expect, it } from "vitest";

import {
  formatUnixSecondsAsUtc,
  formatUtcTimestamp,
} from "../../../src/interfaces/web/human-time.js";

describe("human UTC time", () => {
  it("renders admitted instants without locale or local-time conversion", () => {
    expect(formatUtcTimestamp("2026-07-21T04:05:06.000Z"))
      .toBe("2026-07-21 04:05:06 UTC");
    expect(formatUtcTimestamp("2026-07-21T04:05:06.123Z"))
      .toBe("2026-07-21 04:05:06.123 UTC");
  });

  it("converts canonical Unix seconds to the same admitted UTC form", () => {
    expect(formatUnixSecondsAsUtc("0")).toBe("1970-01-01 00:00:00 UTC");
    expect(formatUnixSecondsAsUtc("1")).toBe("1970-01-01 00:00:01 UTC");
  });

  it("rejects local, offset, malformed, and out-of-range time inputs", () => {
    for (const value of [
      "2026-07-21 04:05:06",
      "2026-07-21T04:05:06Z",
      "2026-07-21T04:05:06.000+09:00",
      "2026-02-30T04:05:06.000Z",
    ]) {
      expect(() => formatUtcTimestamp(value)).toThrow();
    }
    for (const value of ["", "-1", "01", "1.0", "253402300800"]) {
      expect(() => formatUnixSecondsAsUtc(value)).toThrow(TypeError);
    }
  });
});
