import { describe, expect, it } from "vitest";

import {
  canonicalErc20EventEncodingKind,
  erc20ApprovalTopic0,
  erc20TransferTopic0,
  matchesCanonicalErc20EventEvidence,
} from "../../src/core/erc20-events.js";
import {
  hash32Schema,
  hexBytesSchema,
  parseEvmAddress,
  parseUnsignedDecimal,
} from "../../src/core/index.js";

const addressA = parseEvmAddress(`0x${"1".repeat(40)}`);
const addressB = parseEvmAddress(`0x${"2".repeat(40)}`);
const topicAddress = (address: string) => hash32Schema.parse(`0x${"0".repeat(24)}${address.slice(2)}`);
const dataWord = (value: bigint) => hexBytesSchema.parse(`0x${value.toString(16).padStart(64, "0")}`);

describe("canonical ERC-20 event evidence", () => {
  it("fixes the published Transfer and Approval topic signatures", () => {
    expect(erc20TransferTopic0).toBe("0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef");
    expect(erc20ApprovalTopic0).toBe("0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925");
  });

  it("validates decoded evidence by reconstructing its exact canonical words", () => {
    const transferTopics = [
      hash32Schema.parse(erc20TransferTopic0),
      topicAddress(addressA),
      topicAddress(addressB),
    ];
    const approvalTopics = [
      hash32Schema.parse(erc20ApprovalTopic0),
      topicAddress(addressA),
      topicAddress(addressB),
    ];
    expect(canonicalErc20EventEncodingKind(transferTopics, dataWord(5n))).toBe("erc20_transfer");
    expect(matchesCanonicalErc20EventEvidence(transferTopics, dataWord(5n), {
      kind: "erc20_transfer",
      from: addressA,
      to: addressB,
      amountRaw: parseUnsignedDecimal("5"),
    })).toBe(true);
    expect(matchesCanonicalErc20EventEvidence(approvalTopics, dataWord(10n), {
      kind: "erc20_approval",
      owner: addressA,
      spender: addressB,
      amountRaw: parseUnsignedDecimal("10"),
    })).toBe(true);
  });

  it("rejects malformed words and claims that do not reconstruct the raw log", () => {
    const transfer = hash32Schema.parse(erc20TransferTopic0);
    const from = topicAddress(addressA);
    const to = topicAddress(addressB);
    expect(canonicalErc20EventEncodingKind([transfer, from], dataWord(1n))).toBeNull();
    expect(canonicalErc20EventEncodingKind([
      transfer,
      hash32Schema.parse(`0x1${"0".repeat(23)}${addressA.slice(2)}`),
      to,
    ], dataWord(1n))).toBeNull();
    expect(canonicalErc20EventEncodingKind([transfer, from, to], hexBytesSchema.parse("0x01"))).toBeNull();
    expect(matchesCanonicalErc20EventEvidence([transfer, from, to], dataWord(1n), {
      kind: "erc20_transfer",
      from: addressA,
      to: addressB,
      amountRaw: parseUnsignedDecimal("2"),
    })).toBe(false);
    expect(matchesCanonicalErc20EventEvidence([transfer, from, to], dataWord(1n), {
      kind: "erc20_transfer",
      from: addressB,
      to: addressB,
      amountRaw: parseUnsignedDecimal("1"),
    })).toBe(false);
    expect(matchesCanonicalErc20EventEvidence([transfer, from, to], dataWord(1n), {
      kind: "erc20_transfer",
      from: addressA,
      to: addressB,
      amountRaw: parseUnsignedDecimal((1n << 256n).toString(10)),
    })).toBe(false);
  });
});
