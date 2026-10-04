import { describe, expect, it } from "vitest";

import {parseEvmAddressInput} from "../../src/evm/address-input.js";
import {keccak256FromHex} from "../../src/evm/keccak256.js";
import {keccak256FromUtf8} from "../../src/evm/keccak256.js";

describe("Keccak-256", () => {
  it("matches independent published vectors", () => {
    expect(keccak256FromHex("0x")).toBe("0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
    expect(keccak256FromHex("0x68656c6c6f")).toBe("0x1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8");
    expect(keccak256FromUtf8("")).toBe("0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
    expect(keccak256FromUtf8("hello")).toBe("0x1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8");
  });

  it("rejects non-canonical byte input", () => {
    expect(() => keccak256FromHex("0x0")).toThrow("canonical");
    expect(() => keccak256FromHex("0xAA")).toThrow("canonical");
  });

  it("hashes EIP-55 text as UTF-8 instead of decoding the address bytes", () => {
    const lowercaseBody = "52908400098527886e0f7030069857d2e4169ee7";
    expect(keccak256FromUtf8(lowercaseBody)).not.toBe(keccak256FromHex(`0x${lowercaseBody}`));
    expect(parseEvmAddressInput("0x52908400098527886E0F7030069857D2E4169EE7"))
      .toBe(`0x${lowercaseBody}`);
  });
});
