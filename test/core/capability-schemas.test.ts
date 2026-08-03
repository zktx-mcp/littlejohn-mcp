import { describe, expect, it } from "vitest";

import {
  accountBalanceCapability,
  capabilityIdSchema,
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
  asset: { kind: "native", chainId: "eip155:4663" },
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
  it("uses one exact capability identifier convention", () => {
    for (const capabilityId of [
      "chain.status",
      "contract.inspect",
      "transaction.inspect",
      "account.balance",
      "wallet.connection",
      "wallet.cancel_operation",
    ]) expect(capabilityIdSchema.safeParse(capabilityId).success).toBe(true);

    for (const capabilityId of [
      "chain",
      "chain.status.extra",
      "chain.",
      ".status",
      "chain.cancelOperation",
      "chain.cancel__operation",
      "chain._operation",
      "chain.operation_",
      "Chain.status",
      "1chain.status",
      `chain.${"a".repeat(59)}`,
    ]) expect(capabilityIdSchema.safeParse(capabilityId).success).toBe(false);
  });

  it("rejects unknown fields at nested boundaries", () => {
    expect(safeParseCapabilityData(contractInspectCapability, {
      address: address1,
      block: {
        chainId: "eip155:4663",
        blockNumber: "1",
        blockHash: `0x${"a".repeat(64)}`,
        blockTimestamp: "2026-07-12T10:16:02.000Z",
      },
      runtimeCode: { status: "empty", unexpected: true },
    }).success).toBe(false);
  });

  it("independently verifies runtime-code length and Keccak identity", () => {
    const block = {
      chainId: "eip155:4663",
      blockNumber: "1",
      blockHash: `0x${"a".repeat(64)}`,
      blockTimestamp: "2026-07-12T10:16:02.000Z",
    };
    const targetRuntimeCode = {
      byteLength: "1",
      codeHash: "0xbc36789e7a1e281436464229828f817d6612f7b477d66591ff96a9e064bcc98a",
    };
    const data = {
      analysis: {
        chainId: "eip155:4663",
        target: address1,
        block,
        targetRuntimeCode,
        proxy: { status: "no_supported_proxy_observed" },
        sources: [{ role: "target", address: address1, status: "no_record_observed" }],
        declaredFunctions: { status: "unavailable", reason: "exact_abi_unavailable" },
        controls: {
          owner: { status: "unavailable", reason: "exact_abi_unavailable" },
          paused: { status: "unavailable", reason: "exact_abi_unavailable" },
          defaultAdmins: { status: "unavailable", reason: "exact_abi_unavailable" },
        },
      },
      runtimeCode: "0x00",
    };
    expect(safeParseCapabilityData(contractInspectCapability, data).success).toBe(true);
    expect(safeParseCapabilityData(contractInspectCapability, {
      ...data,
      analysis: {
        ...data.analysis,
        targetRuntimeCode: { ...targetRuntimeCode, byteLength: "2" },
      },
    }).success).toBe(false);
    expect(safeParseCapabilityData(contractInspectCapability, {
      ...data,
      analysis: {
        ...data.analysis,
        targetRuntimeCode: { ...targetRuntimeCode, codeHash: `0x${"0".repeat(64)}` },
      },
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

  it("normalizes human-entered EVM addresses before invoking a capability", () => {
    const checksummed = "0x52908400098527886E0F7030069857D2E4169EE7";
    expect(parseCapabilityInput(contractInspectCapability, {
      address: checksummed,
      block: { kind: "latest" },
    }).address).toBe(checksummed.toLowerCase());
    expect(parseCapabilityInput(accountBalanceCapability, {
      account: { kind: "address", address: `0x${"A".repeat(40)}` },
      includeNative: false,
      tokens: [checksummed],
      block: { kind: "latest" },
    })).toMatchObject({
      account: { kind: "address", address: `0x${"a".repeat(40)}` },
      tokens: [checksummed.toLowerCase()],
    });
    expect(safeParseCapabilityInput(contractInspectCapability, {
      address: "0x52908400098527886e0F7030069857D2E4169EE7",
      block: { kind: "latest" },
    }).success).toBe(false);
  });

  it("binds transaction type, fee form, access-list form, and native amount mode", () => {
    const transaction = {
      transactionHash: `0x${"a".repeat(64)}`,
      chainId: "eip155:4663",
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

  it("binds connected wallet state to one canonical chain-address identity and excludes secrets", () => {
    const connected = {
      status: "connected",
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
    for (const reason of ["reconciling", "observation_unavailable"] as const) {
      expect(safeParseCapabilityData(walletConnectionCapability, { status: "unknown", reason }).success).toBe(true);
    }
    for (const reason of ["no_session", "expired", "disconnected"] as const) {
      expect(safeParseCapabilityData(walletConnectionCapability, { status: "disconnected", reason }).success).toBe(true);
    }
    for (const reason of ["owner_unavailable", "deleted", "unusable_store"] as const) {
      expect(safeParseCapabilityData(walletConnectionCapability, { status: "disconnected", reason }).success).toBe(false);
      expect(safeParseCapabilityData(walletConnectionCapability, { status: "unknown", reason }).success).toBe(false);
    }
    expect(safeParseCapabilityData(walletConnectionCapability, {
      status: "unresolved",
      sessionCount: "1",
    }).success).toBe(true);
    expect(safeParseCapabilityData(walletConnectionCapability, {
      status: "unresolved",
      sessionCount: "0",
    }).success).toBe(false);
    expect(() => parseCapabilityDataAt(
      walletConnectionCapability,
      connected,
      "2026-07-12T10:16:02.000Z",
    )).toThrow("expire after evaluation");
  });

  it("accepts a decoded ERC-20 event only when every canonical log word matches", () => {
    const block = {
      chainId: "eip155:4663",
      blockNumber: "1",
      blockHash: `0x${"b".repeat(64)}`,
      blockTimestamp: "2026-07-12T10:16:02.000Z",
    };
    const amount = {
      asset: { kind: "erc20", chainId: "eip155:4663", address: address2 },
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
      chainId: "eip155:4663",
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
    for (const malformedLog of [
      { ...log, topics: [...log.topics, `0x${"0".repeat(64)}`] },
      { ...log, topics: [log.topics[0], `0x1${"0".repeat(23)}${address1.slice(2)}`, log.topics[2]] },
      { ...log, data: `${log.data}${"0".repeat(64)}` },
    ]) {
      expect(safeParseCapabilityData(transactionInspectCapability, {
        ...included,
        inclusion: {
          ...included.inclusion,
          receipt: { ...included.inclusion.receipt, logs: [malformedLog] },
        },
      }).success).toBe(false);
    }
  });
});
