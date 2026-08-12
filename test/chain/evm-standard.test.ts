import { describe, expect, it } from "vitest";

import {
  createErc20CallEncoder,
  createStockFactoryCallEncoder,
  createTokenStandardCallEncoder,
  decodeAbiAddressResult,
  decodeAbiBooleanResult,
  decodeCanonicalErc20Event,
  decodeErc20BalanceOfResult,
  decodeErc20DecimalsResult,
  decodeErc20TextResult,
  decodeErc20TotalSupplyResult,
  encodeStockTokenOraclePausedCall,
  hashEvmBytes,
} from "../../src/chain/evm-standard.js";
import { rpcResponseByteLimit } from "../../src/chain/rpc.js";
import {
  erc20ApprovalTopic0,
  erc20TransferTopic0,
  hash32Schema,
  hexBytesSchema,
  parseEvmAddress,
} from "../../src/core/index.js";

const addressA = parseEvmAddress(`0x${"12".repeat(20)}`);
const addressB = parseEvmAddress(`0x${"34".repeat(20)}`);
const indexedAddress = (address: string) =>
  hash32Schema.parse(`0x${"0".repeat(24)}${address.slice(2)}`);
const word = (value: bigint) =>
  hexBytesSchema.parse(`0x${value.toString(16).padStart(64, "0")}`);
const encodedTextBytes = (bytes: Uint8Array) => {
  const padding = (32 - bytes.length % 32) % 32;
  return hexBytesSchema.parse(
    `${word(32n)}${word(BigInt(bytes.length)).slice(2)}${Buffer.from(bytes).toString("hex")}${"0".repeat(padding * 2)}`,
  );
};
const encodedText = (value: string) => encodedTextBytes(Buffer.from(value, "utf8"));
const textByteLimit = 512;

describe("standard EVM boundary", () => {
  it("uses viem for exact ERC-20 call encoding", async () => {
    const encoder = await createErc20CallEncoder();
    expect(encoder.decimals()).toBe("0x313ce567");
    expect(encoder.name()).toBe("0x06fdde03");
    expect(encoder.symbol()).toBe("0x95d89b41");
    expect(encoder.totalSupply()).toBe("0x18160ddd");
    expect(encoder.balanceOf(addressA)).toBe(
      `0x70a08231${"12".repeat(20).padStart(64, "0")}`,
    );
    expect(Object.isFrozen(encoder)).toBe(true);
  });

  it("uses exact fixed standard and StockFactory ABI encodings", () => {
    const standards = createTokenStandardCallEncoder();
    expect(standards.supportsInterface(hexBytesSchema.parse("0xa60bf13d"))).toBe(
      `0x01ffc9a7a60bf13d${"0".repeat(56)}`,
    );
    expect(standards.uiMultiplier()).toBe("0xa60bf13d");
    expect(standards.newUiMultiplier()).toBe("0xdc767007");
    expect(standards.effectiveAt()).toBe("0x97a4064f");
    expect(standards.balanceOfUi(addressA)).toBe(
      `0x437a9958${addressA.slice(2).padStart(64, "0")}`,
    );
    expect(createStockFactoryCallEncoder().tokenAddress(hash32Schema.parse(`0x${"1".repeat(64)}`)))
      .toBe(`0x97bb3ce9${"1".repeat(64)}`);
    expect(encodeStockTokenOraclePausedCall()).toBe("0x7706ba52");
    expect(decodeAbiBooleanResult(word(1n))).toBe(true);
    expect(decodeAbiBooleanResult(word(0n))).toBe(false);
    expect(decodeAbiAddressResult(hexBytesSchema.parse(
      `0x${"0".repeat(24)}${addressA.slice(2)}`,
    ))).toBe(addressA);
    expect(() => standards.supportsInterface(hexBytesSchema.parse("0x01"))).toThrow(TypeError);
    expect(() => decodeAbiBooleanResult(word(2n))).toThrow(TypeError);
  });

  it("produces EVM Keccak and exact fixed-width function results", () => {
    expect(hashEvmBytes(hexBytesSchema.parse("0x"))).toBe(
      "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
    );
    expect(decodeErc20BalanceOfResult(word((1n << 255n) + 1n))).toBe(
      ((1n << 255n) + 1n).toString(10),
    );
    expect(decodeErc20DecimalsResult(word(255n))).toBe("255");
    expect(decodeErc20TotalSupplyResult(word((1n << 256n) - 1n))).toBe(
      ((1n << 256n) - 1n).toString(10),
    );
    expect(decodeErc20TextResult(encodedText("Token name"), "name", textByteLimit)).toEqual({
      status: "decoded",
      value: "Token name",
    });
    expect(decodeErc20TextResult(encodedText("TKN"), "symbol", textByteLimit)).toEqual({
      status: "decoded",
      value: "TKN",
    });
    expect(decodeErc20TextResult(encodedText(""), "name", textByteLimit)).toEqual({
      status: "decoded",
      value: "",
    });
    expect(decodeErc20TextResult(encodedText("토큰 🪙"), "name", textByteLimit)).toEqual({
      status: "decoded",
      value: "토큰 🪙",
    });
    expect(decodeErc20TextResult(encodedText("x".repeat(33)), "name", textByteLimit)).toEqual({
      status: "decoded",
      value: "x".repeat(33),
    });
    expect(() => decodeErc20BalanceOfResult(`${word(1n)}${word(2n).slice(2)}`)).toThrow(TypeError);
    expect(() => decodeErc20BalanceOfResult("0x01")).toThrow(TypeError);
    expect(() => decodeErc20DecimalsResult(word(256n))).toThrow(TypeError);
    expect(() => decodeErc20TextResult(word(1n), "name", textByteLimit)).toThrow(TypeError);
  });

  it("bounds ERC-20 text before full-value decoding without changing UTF-8 meaning", () => {
    const exactLimit = "🪙".repeat(128);
    expect(Buffer.byteLength(exactLimit, "utf8")).toBe(textByteLimit);
    expect(decodeErc20TextResult(encodedText(exactLimit), "name", textByteLimit)).toEqual({
      status: "decoded",
      value: exactLimit,
    });

    const oneByteOver = `${exactLimit}a`;
    expect(Buffer.byteLength(oneByteOver, "utf8")).toBe(textByteLimit + 1);
    expect(decodeErc20TextResult(encodedText(oneByteOver), "name", textByteLimit)).toEqual({
      status: "byte_limit_exceeded",
    });

    const invalidOversizedUtf8 = new Uint8Array(textByteLimit + 1).fill(0x61);
    invalidOversizedUtf8[0] = 0xc3;
    invalidOversizedUtf8[1] = 0x28;
    expect(() => decodeErc20TextResult(
      encodedTextBytes(invalidOversizedUtf8),
      "name",
      textByteLimit,
    )).toThrow(TypeError);

    const largeCanonicalText = "x".repeat(Math.floor((rpcResponseByteLimit - 256) / 2));
    expect(decodeErc20TextResult(
      encodedText(largeCanonicalText),
      "symbol",
      textByteLimit,
    )).toEqual({ status: "byte_limit_exceeded" });
  });

  it("rejects non-canonical or lossy ERC-20 text results", () => {
    const canonicalA = encodedText("A");
    const nonzeroPadding = hexBytesSchema.parse(`${canonicalA.slice(0, -2)}01`);
    const trailingWord = hexBytesSchema.parse(`${canonicalA}${"0".repeat(64)}`);
    const alternateOffsetWithJunk = hexBytesSchema.parse(
      `${word(64n)}${word(0xdeadn).slice(2)}${word(1n).slice(2)}61${"0".repeat(62)}`,
    );
    const overstatedLength = hexBytesSchema.parse(
      `${word(32n)}${word(33n).slice(2)}${"00".repeat(32)}`,
    );
    const invalidUtf8 = encodedTextBytes(Uint8Array.from([0xc3, 0x28]));
    const truncatedPadding = hexBytesSchema.parse(canonicalA.slice(0, -2));

    expect(() => decodeErc20TextResult(nonzeroPadding, "name", textByteLimit)).toThrow(TypeError);
    expect(() => decodeErc20TextResult(trailingWord, "name", textByteLimit)).toThrow(TypeError);
    expect(() => decodeErc20TextResult(alternateOffsetWithJunk, "name", textByteLimit)).toThrow(TypeError);
    expect(() => decodeErc20TextResult(overstatedLength, "name", textByteLimit)).toThrow(TypeError);
    expect(() => decodeErc20TextResult(invalidUtf8, "name", textByteLimit)).toThrow(TypeError);
    expect(() => decodeErc20TextResult(truncatedPadding, "name", textByteLimit)).toThrow(TypeError);
  });

  it("decodes only exact canonical Transfer and Approval evidence", () => {
    expect(decodeCanonicalErc20Event([
      hash32Schema.parse(erc20TransferTopic0),
      indexedAddress(addressA),
      indexedAddress(addressB),
    ], word(5n))).toEqual({
      kind: "erc20_transfer",
      from: addressA,
      to: addressB,
      amountRaw: "5",
    });
    expect(decodeCanonicalErc20Event([
      hash32Schema.parse(erc20ApprovalTopic0),
      indexedAddress(addressA),
      indexedAddress(addressB),
    ], word(10n))).toEqual({
      kind: "erc20_approval",
      owner: addressA,
      spender: addressB,
      amountRaw: "10",
    });
  });

  it("rejects shapes that viem alone decodes permissively", () => {
    const transfer = hash32Schema.parse(erc20TransferTopic0);
    const from = indexedAddress(addressA);
    const to = indexedAddress(addressB);
    const amount = word(1n);
    expect(decodeCanonicalErc20Event([
      transfer,
      from,
      to,
      hash32Schema.parse(`0x${"0".repeat(64)}`),
    ], amount)).toBeNull();
    expect(decodeCanonicalErc20Event([
      transfer,
      hash32Schema.parse(`0x1${"0".repeat(23)}${addressA.slice(2)}`),
      to,
    ], amount)).toBeNull();
    expect(decodeCanonicalErc20Event(
      [transfer, from, to],
      hexBytesSchema.parse(`${amount}${"0".repeat(64)}`),
    )).toBeNull();
    expect(decodeCanonicalErc20Event([transfer, from], amount)).toBeNull();
  });
});
