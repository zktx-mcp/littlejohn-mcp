import { describe, expect, it } from "vitest";

import {
  createErc20CallEncoder,
  decodeCanonicalErc20Event,
  decodeErc20BalanceOfResult,
  decodeErc20DecimalsResult,
  hashEvmBytes,
} from "../../src/chain/evm-standard.js";
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

describe("standard EVM boundary", () => {
  it("uses viem for exact ERC-20 call encoding", async () => {
    const encoder = await createErc20CallEncoder();
    expect(encoder.decimals()).toBe("0x313ce567");
    expect(encoder.balanceOf(addressA)).toBe(
      `0x70a08231${"12".repeat(20).padStart(64, "0")}`,
    );
    expect(Object.isFrozen(encoder)).toBe(true);
  });

  it("produces EVM Keccak and exact fixed-width function results", () => {
    expect(hashEvmBytes(hexBytesSchema.parse("0x"))).toBe(
      "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
    );
    expect(decodeErc20BalanceOfResult(word((1n << 255n) + 1n))).toBe(
      ((1n << 255n) + 1n).toString(10),
    );
    expect(decodeErc20DecimalsResult(word(255n))).toBe("255");
    expect(() => decodeErc20BalanceOfResult(`${word(1n)}${word(2n).slice(2)}`)).toThrow(TypeError);
    expect(() => decodeErc20BalanceOfResult("0x01")).toThrow(TypeError);
    expect(() => decodeErc20DecimalsResult(word(256n))).toThrow(TypeError);
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
