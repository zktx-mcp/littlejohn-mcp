import { describe, expect, it } from "vitest";

import {
  accountBalanceCapability,
  contractInspectCapability,
  erc20TransferTopic0,
  parseCapabilityInput,
  parseCapabilityDataAt,
  safeParseCapabilityData,
  safeParseCapabilityInput,
  transactionInspectCapability,
  walletConnectionCapability,
} from "../../src/core/index.js";

const address1 = `0x${"1".repeat(40)}`;
const address2 = `0x${"2".repeat(40)}`;
const observationId = `obs:${"A".repeat(43)}`;
const nativeAmount = {
  asset: { kind: "native", chainId: "4663" },
  raw: "1",
  decimals: { status: "not_observed", scopeExclusionId: "transaction_native_decimals_not_observed" },
  quantityObservationId: observationId,
};
const gasRate = {
  numerator: nativeAmount,
  denominator: { unit: "gas", raw: "1" },
  observationId,
};

describe("capability schemas", () => {
  it("rejects unknown fields at nested boundaries", () => {
    expect(safeParseCapabilityData(contractInspectCapability, {
      address: address1,
      block: {
        chainId: "4663",
        blockNumber: "1",
        blockHash: `0x${"a".repeat(64)}`,
        blockTimestamp: "2026-07-12T10:16:02.000Z",
      },
      runtimeCode: { status: "empty", unexpected: true },
    }).success).toBe(false);
  });

  it("rejects duplicate account tokens and canonicalizes their input order", () => {
    const base = {
      account: { kind: "address", address: address1 },
      includeNative: false,
      block: { kind: "latest" },
    };
    expect(safeParseCapabilityInput(accountBalanceCapability, { ...base, tokens: [address1, address2] }).success).toBe(true);
    expect(parseCapabilityInput(accountBalanceCapability, { ...base, tokens: [address2, address1] }).tokens).toEqual([address1, address2]);
    expect(safeParseCapabilityInput(accountBalanceCapability, { ...base, tokens: [address1, address1] }).success).toBe(false);
    expect(safeParseCapabilityInput(accountBalanceCapability, { ...base, tokens: [] }).success).toBe(false);
  });

  it("binds transaction type, fee form, access-list form, and native amount mode", () => {
    const transaction = {
      transactionHash: `0x${"a".repeat(64)}`,
      chainId: "4663",
      from: address1,
      recipient: { kind: "call", address: address2 },
      value: nativeAmount,
      input: "0x",
      nonce: "0",
      gasLimit: { raw: "21000", observationId },
      type: "0",
      accessList: { kind: "none" },
      fee: { kind: "legacy", gasPrice: gasRate },
      inclusion: { status: "pending" },
    };
    expect(safeParseCapabilityData(transactionInspectCapability, transaction).success).toBe(true);
    expect(safeParseCapabilityData(transactionInspectCapability, {
      ...transaction,
      accessList: { kind: "entries", entries: [] },
    }).success).toBe(false);
    expect(safeParseCapabilityData(transactionInspectCapability, {
      ...transaction,
      fee: { kind: "dynamic", maxFeePerGas: gasRate, maxPriorityFeePerGas: gasRate },
    }).success).toBe(false);
    expect(safeParseCapabilityData(transactionInspectCapability, {
      ...transaction,
      value: { ...nativeAmount, decimals: { status: "not_observed", scopeExclusionId: "account_native_decimals_not_observed" } },
    }).success).toBe(false);
    expect(safeParseCapabilityData(transactionInspectCapability, { ...transaction, type: "128" }).success).toBe(false);
  });

  it("binds connected wallet state to one canonical CAIP-10 account and excludes secrets", () => {
    const connected = {
      status: "connected",
      account: `eip155:4663:${address1}`,
      address: address1,
      chainId: "eip155:4663",
      approvedMethods: ["eth_sendTransaction"],
      approvedEvents: ["accountsChanged", "chainChanged"],
      expiresAt: "2026-07-12T10:16:02.000Z",
    };
    expect(safeParseCapabilityData(walletConnectionCapability, connected).success).toBe(true);
    expect(safeParseCapabilityData(walletConnectionCapability, {
      ...connected,
      account: `eip155:4663:${address2}`,
    }).success).toBe(false);
    expect(safeParseCapabilityData(walletConnectionCapability, { ...connected, topic: "secret" }).success).toBe(false);
    expect(() => parseCapabilityDataAt(
      walletConnectionCapability,
      connected,
      "2026-07-12T10:16:02.000Z",
    )).toThrow("expire after evaluation");
  });

  it("accepts a decoded ERC-20 event only when every canonical log word matches", () => {
    const block = {
      chainId: "4663",
      blockNumber: "1",
      blockHash: `0x${"b".repeat(64)}`,
      blockTimestamp: "2026-07-12T10:16:02.000Z",
    };
    const amount = {
      asset: { kind: "erc20", chainId: "4663", address: address2 },
      raw: "5",
      decimals: { status: "not_observed", scopeExclusionId: "transaction_event_decimals_not_observed" },
      quantityObservationId: observationId,
    };
    const log = {
      address: address2,
      topics: [
        erc20TransferTopic0,
        `0x${"0".repeat(24)}${address1.slice(2)}`,
        `0x${"0".repeat(24)}${address2.slice(2)}`,
      ],
      data: `0x${"0".repeat(63)}5`,
      logIndex: "0",
      transactionIndex: "0",
      decodedEvent: { kind: "erc20_transfer", token: address2, from: address1, to: address2, amount },
    };
    const included = {
      transactionHash: `0x${"c".repeat(64)}`,
      chainId: "4663",
      from: address1,
      recipient: { kind: "call", address: address2 },
      value: nativeAmount,
      input: "0x",
      nonce: "0",
      gasLimit: { raw: "21000", observationId },
      type: "0",
      accessList: { kind: "none" },
      fee: { kind: "legacy", gasPrice: gasRate },
      inclusion: {
        status: "included",
        block,
        transactionIndex: "0",
        receipt: {
          status: "success",
          cumulativeGasUsed: { raw: "21000", observationId },
          gasUsed: { raw: "21000", observationId },
          effectiveGasPrice: gasRate,
          createdContract: { kind: "none" },
          logs: [log],
        },
      },
    };
    expect(safeParseCapabilityData(transactionInspectCapability, included).success).toBe(true);
    expect(safeParseCapabilityData(transactionInspectCapability, {
      ...included,
      inclusion: {
        ...included.inclusion,
        receipt: { ...included.inclusion.receipt, logs: [{ ...log, topics: [] }] },
      },
    }).success).toBe(false);
    expect(safeParseCapabilityData(transactionInspectCapability, {
      ...included,
      inclusion: {
        ...included.inclusion,
        receipt: {
          ...included.inclusion.receipt,
          logs: [{ ...log, decodedEvent: { kind: "not_decoded" } }],
        },
      },
    }).success).toBe(false);
    expect(safeParseCapabilityData(transactionInspectCapability, {
      ...included,
      inclusion: {
        ...included.inclusion,
        receipt: {
          ...included.inclusion.receipt,
          logs: [{
            ...log,
            decodedEvent: { ...log.decodedEvent, from: address2 },
          }],
        },
      },
    }).success).toBe(false);
  });
});
