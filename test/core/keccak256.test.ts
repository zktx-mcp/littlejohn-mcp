import { describe, expect, it } from "vitest";

import { keccak256Hex } from "../../src/core/index.js";

describe("Keccak-256", () => {
  it("matches independent published vectors", () => {
    expect(keccak256Hex("0x")).toBe("0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
    expect(keccak256Hex("0x68656c6c6f")).toBe("0x1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8");
  });

  it("rejects non-canonical byte input", () => {
    expect(() => keccak256Hex("0x0")).toThrow("canonical");
    expect(() => keccak256Hex("0xAA")).toThrow("canonical");
  });
});
