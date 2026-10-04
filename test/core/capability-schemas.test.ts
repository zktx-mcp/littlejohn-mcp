import {createEvmCapabilitySuccessSchema} from "../../src/evm/capability.js";
import { z } from "zod";
import { describe, expect, it } from "vitest";

import {accountBalanceCapability} from "../../src/account-assets/balance-capability.js";
import {addressInspectCapability, transactionInspectCapability} from "../../src/chain/read-contracts.js";
import {capabilityIdSchema, parseCapabilityInput, parseCapabilityDataAt, safeParseCapabilityData, safeParseCapabilityInput} from "../../src/core/index.js";
import {erc20TransferTopic0} from "../../src/evm/erc20-events.js";
import {walletConnectionCapability} from "../../src/wallet/connection-capability.js";

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
      "address.inspect",
      "transaction.inspect",
      "account.balance",
      "wallet.connection",
      "wallet.cancel_operation",
      `chain.${"a".repeat(58)}`,
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

  it("enforces the canonical capability evidence capacities", () => {
    const boundaryCapabilityId = capabilityIdSchema.parse("test.boundary");
    const schema = createEvmCapabilitySuccessSchema(boundaryCapabilityId, "1", z.null());
    const source = {
      observationId,
      invocationId: `inv:${"A".repeat(43)}`,
      sourceClass: "validated_input",
      owner: "boundary",
      purpose: "boundary",
      observedAt: "2026-07-12T10:16:02.000Z",
      reference: { kind: "validated_input", sourceId: "input:test.boundary" },
      recordDigest: "A".repeat(43),
    };
    const freshness = {
      status: "fresh",
      ruleId: "validated_input_current",
      evaluatedAt: "2026-07-12T10:16:02.000Z",
      observationIds: [observationId],
    };
    const conclusion = {
      id: "boundary",
      status: "established",
      reason: "validated_input",
      observationIds: [observationId],
      freshness,
    };
    const warning = {
      code: "partial_result",
      message: "Some requested results are unavailable.",
      observationIds: [observationId],
    };
    const success = (sources: unknown[], conclusions: unknown[], warnings: unknown[]) => ({
      ok: true,
      meta: {
        capabilityId: boundaryCapabilityId,
        contractVersion: "1",
        chainId: "eip155:4663",
        evaluatedAt: "2026-07-12T10:16:02.000Z",
      },
      data: null,
      evidence: {
        sources,
        conclusions,
        coverage: {
          status: "complete",
          established: ["boundary"],
          notApplicable: [],
          unavailable: [],
        },
      },
      warnings,
    });

    expect(schema.safeParse(success(
      Array.from({ length: 128 }, () => source),
      Array.from({ length: 64 }, () => conclusion),
      Array.from({ length: 64 }, () => warning),
    )).success).toBe(true);
    expect(schema.safeParse(success(
      Array.from({ length: 129 }, () => source),
      [],
      [],
    )).success).toBe(false);
    expect(schema.safeParse(success(
      [],
      Array.from({ length: 65 }, () => conclusion),
      [],
    )).success).toBe(false);
    expect(schema.safeParse(success(
      [],
      [],
      Array.from({ length: 65 }, () => warning),
    )).success).toBe(false);
  });

  it("rejects unknown fields at nested boundaries", () => {
    expect(safeParseCapabilityData(addressInspectCapability, {
      status: "no_runtime_code_observed",
      address: address1,
      block: {
        chainId: "eip155:4663",
        blockNumber: "1",
        blockHash: `0x${"a".repeat(64)}`,
        blockTimestamp: "2026-07-12T10:16:02.000Z",
      },
      runtimeCode: "0x",
      analysis: { unexpected: true },
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
      status: "runtime_code_observed",
      address: address1,
      block,
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
    const noCode = {
      status: "no_runtime_code_observed",
      address: address1,
      block,
      runtimeCode: "0x",
    };
    expect(safeParseCapabilityData(addressInspectCapability, noCode).success).toBe(true);
    expect(safeParseCapabilityData(addressInspectCapability, {
      ...noCode,
      runtimeCode: "0x00",
    }).success).toBe(false);
    expect(safeParseCapabilityData(addressInspectCapability, {
      ...noCode,
      analysis: data.analysis,
    }).success).toBe(false);
    expect(safeParseCapabilityData(addressInspectCapability, data).success).toBe(true);
    expect(safeParseCapabilityData(addressInspectCapability, {
      ...data,
      runtimeCode: "0x",
    }).success).toBe(false);
    const { analysis: _analysis, ...withoutAnalysis } = data;
    expect(safeParseCapabilityData(addressInspectCapability, withoutAnalysis).success).toBe(false);
    expect(safeParseCapabilityData(addressInspectCapability, {
      ...data,
      analysis: {
        ...data.analysis,
        targetRuntimeCode: { ...targetRuntimeCode, byteLength: "2" },
      },
    }).success).toBe(false);
    expect(safeParseCapabilityData(addressInspectCapability, {
      ...data,
      analysis: {
        ...data.analysis,
        targetRuntimeCode: { ...targetRuntimeCode, codeHash: `0x${"0".repeat(64)}` },
      },
    }).success).toBe(false);
    expect(safeParseCapabilityData(addressInspectCapability, {
      ...data,
      analysis: {
        ...data.analysis,
        chainId: "eip155:1",
        block: { ...block, chainId: "eip155:1" },
      },
    }).success).toBe(false);
    expect(safeParseCapabilityData(addressInspectCapability, {
      ...data,
      analysis: {
        ...data.analysis,
        target: address2,
        sources: [{ role: "target", address: address2, status: "no_record_observed" }],
      },
    }).success).toBe(false);
    expect(safeParseCapabilityData(addressInspectCapability, {
      ...data,
      analysis: {
        ...data.analysis,
        block: {
          ...block,
          blockNumber: "2",
          blockHash: `0x${"b".repeat(64)}`,
          blockTimestamp: "2026-07-12T10:16:03.000Z",
        },
      },
    }).success).toBe(false);
    expect(safeParseCapabilityData(addressInspectCapability, {
      ...data,
      analysis: {
        ...data.analysis,
        targetRuntimeCode: {
          byteLength: "2",
          codeHash: `0x${"b".repeat(64)}`,
        },
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
    const tokenAddresses = Array.from(
      { length: 51 },
      (_, index) => `0x${String(index + 1).padStart(40, "0")}`,
    );
    expect(safeParseCapabilityInput(accountBalanceCapability, {
      ...base,
      tokens: tokenAddresses.slice(0, 50),
    }).success).toBe(true);
    expect(safeParseCapabilityInput(accountBalanceCapability, {
      ...base,
      tokens: tokenAddresses,
    }).success).toBe(false);

    const tokenResults = tokenAddresses.map((address) => ({
      asset: { kind: "erc20", chainId: "eip155:4663", address },
      result: { status: "unavailable", errorCode: "source_unavailable" },
    }));
    const balanceData = {
      account: address1,
      block: {
        chainId: "eip155:4663",
        blockNumber: "1",
        blockHash: `0x${"a".repeat(64)}`,
        blockTimestamp: "2026-07-12T10:16:02.000Z",
      },
      native: { status: "not_requested" },
    };
    expect(safeParseCapabilityData(accountBalanceCapability, {
      ...balanceData,
      tokens: tokenResults.slice(0, 50),
    }).success).toBe(true);
    expect(safeParseCapabilityData(accountBalanceCapability, {
      ...balanceData,
      tokens: tokenResults,
    }).success).toBe(false);
  });

  it("normalizes human-entered EVM addresses before invoking a capability", () => {
    const checksummed = "0x52908400098527886E0F7030069857D2E4169EE7";
    expect(parseCapabilityInput(addressInspectCapability, {
      target: { kind: "address", address: checksummed },
      block: { kind: "latest" },
    }).target).toEqual({ kind: "address", address: checksummed.toLowerCase() });
    expect(parseCapabilityInput(accountBalanceCapability, {
      account: { kind: "address", address: `0x${"A".repeat(40)}` },
      includeNative: false,
      tokens: [checksummed],
      block: { kind: "latest" },
    })).toMatchObject({
      account: { kind: "address", address: `0x${"a".repeat(40)}` },
      tokens: [checksummed.toLowerCase()],
    });
    expect(safeParseCapabilityInput(addressInspectCapability, {
      target: { kind: "address", address: "0x52908400098527886e0F7030069857D2E4169EE7" },
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
