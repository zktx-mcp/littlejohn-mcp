import { describe, expect, it } from "vitest";

import {
  decodeCanonicalErc20Event,
  erc20ApprovalTopic0,
  erc20TransferTopic0,
  hash32Schema,
  hexBytesSchema,
} from "../../src/core/index.js";

const addressA = `0x${"1".repeat(40)}`;
const addressB = `0x${"2".repeat(40)}`;
const topicAddress = (address: string) => hash32Schema.parse(`0x${"0".repeat(24)}${address.slice(2)}`);
const dataWord = (value: string) => hexBytesSchema.parse(`0x${value.padStart(64, "0")}`);

describe("canonical ERC-20 event semantics", () => {
  it("fixes the published Transfer and Approval topic signatures", () => {
    expect(erc20TransferTopic0).toBe("0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef");
    expect(erc20ApprovalTopic0).toBe("0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925");
  });

  it("decodes exact canonical Transfer and Approval words", () => {
    expect(decodeCanonicalErc20Event([
      hash32Schema.parse(erc20TransferTopic0),
      topicAddress(addressA),
      topicAddress(addressB),
    ], dataWord("5"))).toEqual({ kind: "erc20_transfer", from: addressA, to: addressB, amountRaw: "5" });
    expect(decodeCanonicalErc20Event([
      hash32Schema.parse(erc20ApprovalTopic0),
      topicAddress(addressA),
      topicAddress(addressB),
    ], dataWord("a"))).toEqual({ kind: "erc20_approval", owner: addressA, spender: addressB, amountRaw: "10" });
  });

  it("does not reconstruct malformed standard-shaped logs", () => {
    const transfer = hash32Schema.parse(erc20TransferTopic0);
    const from = topicAddress(addressA);
    const to = topicAddress(addressB);
    expect(decodeCanonicalErc20Event([transfer, from], dataWord("1"))).toBeNull();
    expect(decodeCanonicalErc20Event([
      transfer,
      hash32Schema.parse(`0x1${"0".repeat(23)}${addressA.slice(2)}`),
      to,
    ], dataWord("1"))).toBeNull();
    expect(decodeCanonicalErc20Event([transfer, from, to], hexBytesSchema.parse("0x01"))).toBeNull();
  });
});
