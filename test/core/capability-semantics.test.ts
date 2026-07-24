import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  accountBalanceCapability,
  chainAnchorSchema,
  createAccountBalanceTokenEvidenceIdentity,
  evmAddressSchema,
  evmChainIdSchema,
  transactionInspectCapability,
  walletConnectionCapability,
  type HandlerInvocationContext,
  type ObservationClaim,
  type ObservationWriter,
} from "../../src/core/index.js";
import { defineReadCapability } from "../../src/core/capability.js";
import {
  bindForHarness,
  configuredChainId,
  createCapabilityHarness,
  fixedEvaluationTime,
  invokeBinding,
} from "./capability-harness.js";

const block = chainAnchorSchema.parse({
  chainId: configuredChainId,
  blockNumber: "10",
  blockHash: `0x${"a".repeat(64)}`,
  blockTimestamp: fixedEvaluationTime,
});
const address = evmAddressSchema.parse(`0x${"1".repeat(40)}`);
const token = evmAddressSchema.parse(`0x${"2".repeat(40)}`);
const otherChainId = evmChainIdSchema.parse("eip155:1");

const record = (
  context: HandlerInvocationContext,
  observations: ObservationWriter,
  sourceClass: "chain_rpc" | "wallet_sdk" | "wallet_session",
  slotId: string,
  claims: readonly ObservationClaim[],
) => observations.record(slotId, {
  source: context.ports.observations.get(sourceClass),
  claims,
});

const sourceAmount = {
  asset: { kind: "native" as const, chainId: configuredChainId },
  raw: "1",
  decimals: {
    status: "not_observed" as const,
    scopeExclusionId: "transaction_native_decimals_not_observed",
  },
};

const pendingData = (transactionHash: string, observationId: string) => {
  const amount = { ...sourceAmount, quantityObservationId: observationId };
  return {
    transactionHash,
    chainId: configuredChainId,
    from: address,
    recipient: { kind: "call" as const, address: token },
    value: amount,
    input: "0x",
    nonce: "0",
    gasLimit: { raw: "21000", observationId },
    type: "0",
    accessList: { kind: "none" as const },
    fee: {
      kind: "legacy" as const,
      gasPrice: {
        numerator: { ...amount, raw: "2" },
        denominator: { unit: "gas" as const, raw: "1" as const },
        observationId,
      },
    },
    inclusion: { status: "pending" as const },
  };
};

const dynamicPendingData = (transactionHash: string, observationId: string) => {
  const legacy = pendingData(transactionHash, observationId);
  const amount = { ...sourceAmount, quantityObservationId: observationId };
  return {
    ...legacy,
    type: "2",
    accessList: {
      kind: "entries" as const,
      entries: [
        { address: token, storageKeys: [`0x${"f".repeat(64)}`, `0x${"f".repeat(64)}`] },
        { address: token, storageKeys: [] },
      ],
    },
    fee: {
      kind: "dynamic" as const,
      maxFeePerGas: {
        numerator: { ...amount, raw: "3" },
        denominator: { unit: "gas" as const, raw: "1" as const },
        observationId,
      },
      maxPriorityFeePerGas: {
        numerator: { ...amount, raw: "2" },
        denominator: { unit: "gas" as const, raw: "1" as const },
        observationId,
      },
    },
  };
};

type PendingData = ReturnType<typeof pendingData> | ReturnType<typeof dynamicPendingData>;

const transactionClaims = (data: PendingData): readonly ObservationClaim[] => {
  const fee = data.fee.kind === "legacy"
    ? {
        kind: "legacy" as const,
        gasPrice: {
          numerator: { ...sourceAmount, raw: data.fee.gasPrice.numerator.raw },
          denominator: { unit: "gas" as const, raw: "1" as const },
        },
      }
    : {
        kind: "dynamic" as const,
        maxFeePerGas: {
          numerator: { ...sourceAmount, raw: data.fee.maxFeePerGas.numerator.raw },
          denominator: { unit: "gas" as const, raw: "1" as const },
        },
        maxPriorityFeePerGas: {
          numerator: { ...sourceAmount, raw: data.fee.maxPriorityFeePerGas.numerator.raw },
          denominator: { unit: "gas" as const, raw: "1" as const },
        },
      };
  return [
    {
      role: "transaction",
      value: {
        ...data,
        value: sourceAmount,
        gasLimit: { raw: data.gasLimit.raw },
        fee,
      },
    },
    { role: "transaction_value", value: "1", asset: sourceAmount.asset },
    { role: "transaction_gas_limit", value: "21000" },
    ...(data.fee.kind === "legacy"
      ? [{ role: "transaction_gas_price", value: data.fee.gasPrice.numerator.raw, asset: sourceAmount.asset }]
      : [
          {
            role: "transaction_max_fee_per_gas",
            value: data.fee.maxFeePerGas.numerator.raw,
            asset: sourceAmount.asset,
          },
          {
            role: "transaction_max_priority_fee_per_gas",
            value: data.fee.maxPriorityFeePerGas.numerator.raw,
            asset: sourceAmount.asset,
          },
        ]),
  ];
};

describe("capability semantic and evidence authority", () => {
  it("rejects an amount whose raw value differs from its source claim", async () => {
    const harness = createCapabilityHarness();
    const binding = bindForHarness(accountBalanceCapability, harness, async (_input, context, observations) => {
      const identity = createAccountBalanceTokenEvidenceIdentity(token);
      record(context, observations, "chain_rpc", "rpc_chain_id", [{ role: "chain_id", value: configuredChainId }]);
      record(context, observations, "chain_rpc", "block", [{ role: "balance_block", value: block, chainAnchor: block }]);
      const quantity = record(context, observations, "chain_rpc", identity.balanceSlotId, [{
        role: identity.balanceClaimRole,
        value: "2",
        asset: { kind: "erc20", chainId: configuredChainId, address: token },
        chainAnchor: block,
      }]);
      const decimals = record(context, observations, "chain_rpc", identity.decimalsSlotId, [{
        role: identity.decimalsClaimRole,
        value: "6",
        asset: { kind: "erc20", chainId: configuredChainId, address: token },
        chainAnchor: block,
      }]);
      return {
        status: "success",
        data: {
          account: address,
          block,
          native: { status: "not_requested" },
          tokens: [{
            asset: { kind: "erc20", chainId: configuredChainId, address: token },
            result: {
              status: "available",
              amount: {
                asset: { kind: "erc20", chainId: configuredChainId, address: token },
                raw: "1",
                decimals: { status: "available", value: "6", observationId: decimals },
                quantityObservationId: quantity,
              },
            },
          }],
        },
      };
    });
    const result = await invokeBinding(accountBalanceCapability, binding, {
      account: { kind: "address", address },
      includeNative: false,
      tokens: [token],
      block: { kind: "latest" },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a pending transaction whose source claim targets another hash", async () => {
    const harness = createCapabilityHarness();
    const requestedHash = `0x${"c".repeat(64)}`;
    const binding = bindForHarness(transactionInspectCapability, harness, async (_input, context, observations) => {
      record(context, observations, "chain_rpc", "rpc_chain_id", [{ role: "chain_id", value: configuredChainId }]);
      const provisional = pendingData(`0x${"f".repeat(64)}`, `obs:${"A".repeat(43)}`);
      const transactionId = record(
        context,
        observations,
        "chain_rpc",
        "transaction",
        transactionClaims(provisional),
      );
      return { status: "success", data: pendingData(requestedHash, transactionId) };
    });
    expect((await invokeBinding(transactionInspectCapability, binding, {
      transactionHash: requestedHash,
    })).ok).toBe(false);
  });

  it("binds pending not-present conclusions to exactly one unanchored transaction observation", async () => {
    const harness = createCapabilityHarness();
    const transactionHash = `0x${"d".repeat(64)}`;
    let transactionId = "";
    const binding = bindForHarness(transactionInspectCapability, harness, async (_input, context, observations) => {
      record(context, observations, "chain_rpc", "rpc_chain_id", [{ role: "chain_id", value: configuredChainId }]);
      const provisional = pendingData(transactionHash, `obs:${"A".repeat(43)}`);
      transactionId = record(context, observations, "chain_rpc", "transaction", transactionClaims(provisional));
      return { status: "success", data: pendingData(transactionHash, transactionId) };
    });
    const result = await invokeBinding(transactionInspectCapability, binding, { transactionHash });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const conclusion of result.evidence.conclusions) {
      expect(conclusion.observationIds).toEqual([transactionId]);
      expect(conclusion.freshness.observationIds).toEqual([transactionId]);
      expect(conclusion.freshness.ruleId).toBe("pending_transaction_observed");
      expect(conclusion.freshness.status).toBe("unknown");
    }
  });

  it("enforces transaction type, fee, access-list, and amount-path semantics in the definition", async () => {
    const harness = createCapabilityHarness();
    const transactionHash = `0x${"e".repeat(64)}`;
    const binding = bindForHarness(transactionInspectCapability, harness, async (_input, context, observations) => {
      record(context, observations, "chain_rpc", "rpc_chain_id", [{ role: "chain_id", value: configuredChainId }]);
      const provisional = pendingData(transactionHash, `obs:${"A".repeat(43)}`);
      const transactionId = record(context, observations, "chain_rpc", "transaction", transactionClaims(provisional));
      const data = pendingData(transactionHash, transactionId);
      return {
        status: "success",
        data: {
          ...data,
          accessList: { kind: "entries", entries: [] },
        },
      };
    });
    expect((await invokeBinding(transactionInspectCapability, binding, { transactionHash })).ok).toBe(false);

    const duplicateHarness = createCapabilityHarness();
    const duplicateBinding = bindForHarness(
      transactionInspectCapability,
      duplicateHarness,
      async (_input, context, observations) => {
        record(context, observations, "chain_rpc", "rpc_chain_id", [{ role: "chain_id", value: configuredChainId }]);
        const provisional = dynamicPendingData(transactionHash, `obs:${"A".repeat(43)}`);
        const transactionId = record(
          context,
          observations,
          "chain_rpc",
          "transaction",
          transactionClaims(provisional),
        );
        return { status: "success", data: dynamicPendingData(transactionHash, transactionId) };
      },
    );
    const duplicateResult = await invokeBinding(
      transactionInspectCapability,
      duplicateBinding,
      { transactionHash },
    );
    expect(duplicateResult.ok).toBe(true);

    const invalidFeeHarness = createCapabilityHarness();
    const invalidFeeBinding = bindForHarness(
      transactionInspectCapability,
      invalidFeeHarness,
      async (_input, context, observations) => {
        record(context, observations, "chain_rpc", "rpc_chain_id", [{ role: "chain_id", value: configuredChainId }]);
        const provisional = dynamicPendingData(transactionHash, `obs:${"A".repeat(43)}`);
        const invalid = {
          ...provisional,
          fee: {
            ...provisional.fee,
            maxFeePerGas: {
              ...provisional.fee.maxFeePerGas,
              numerator: { ...provisional.fee.maxFeePerGas.numerator, raw: "1" },
            },
          },
        };
        const transactionId = record(
          context,
          observations,
          "chain_rpc",
          "transaction",
          transactionClaims(invalid),
        );
        return {
          status: "success",
          data: {
            ...invalid,
            value: { ...invalid.value, quantityObservationId: transactionId },
            gasLimit: { ...invalid.gasLimit, observationId: transactionId },
            fee: {
              ...invalid.fee,
              maxFeePerGas: {
                ...invalid.fee.maxFeePerGas,
                numerator: {
                  ...invalid.fee.maxFeePerGas.numerator,
                  quantityObservationId: transactionId,
                },
                observationId: transactionId,
              },
              maxPriorityFeePerGas: {
                ...invalid.fee.maxPriorityFeePerGas,
                numerator: {
                  ...invalid.fee.maxPriorityFeePerGas.numerator,
                  quantityObservationId: transactionId,
                },
                observationId: transactionId,
              },
            },
          },
        };
      },
    );
    expect((await invokeBinding(
      transactionInspectCapability,
      invalidFeeBinding,
      { transactionHash },
    )).ok).toBe(false);
  });

  it("requires connected wallet state to bind both SDK and exact session authority", async () => {
    const connected = {
      status: "connected" as const,
      address,
      chainId: configuredChainId,
      approvedMethods: ["eth_sendTransaction"],
      approvedEvents: ["accountsChanged", "chainChanged"],
      expiresAt: "2026-07-13T10:16:02.000Z",
    };
    const harness = createCapabilityHarness();
    const missing = bindForHarness(walletConnectionCapability, harness, async (_input, context, observations) => {
      record(context, observations, "wallet_sdk", "wallet_sdk", [{ role: "wallet_sdk_state", value: connected }]);
      return { status: "success", data: connected };
    });
    expect((await invokeBinding(walletConnectionCapability, missing, {})).ok).toBe(false);

    const complete = bindForHarness(walletConnectionCapability, harness, async (_input, context, observations) => {
      record(context, observations, "wallet_sdk", "wallet_sdk", [{ role: "wallet_sdk_state", value: connected }]);
      record(context, observations, "wallet_session", "wallet_session", [{ role: "wallet_session_state", value: connected }]);
      return { status: "success", data: connected };
    });
    expect((await invokeBinding(walletConnectionCapability, complete, {})).ok).toBe(true);
  });

  it("rejects mismatched, non-canonical, and expired connected-wallet semantics", async () => {
    const harness = createCapabilityHarness();
    for (const data of [
      {
        status: "connected" as const,
        address,
        chainId: otherChainId,
        approvedMethods: ["eth_sendTransaction"],
        approvedEvents: ["accountsChanged", "chainChanged"],
        expiresAt: "2026-07-13T10:16:02.000Z",
      },
      {
        status: "connected" as const,
        address,
        chainId: configuredChainId,
        approvedMethods: ["eth_sendTransaction", "eth_sendTransaction"],
        approvedEvents: ["accountsChanged", "chainChanged"],
        expiresAt: "2026-07-13T10:16:02.000Z",
      },
      {
        status: "connected" as const,
        address,
        chainId: configuredChainId,
        approvedMethods: ["eth_sendTransaction"],
        approvedEvents: ["accountsChanged", "chainChanged"],
        expiresAt: fixedEvaluationTime,
      },
    ]) {
      const binding = bindForHarness(walletConnectionCapability, harness, async (_input, context, observations) => {
        record(context, observations, "wallet_sdk", "wallet_sdk", [{ role: "wallet_sdk_state", value: data }]);
        record(context, observations, "wallet_session", "wallet_session", [{ role: "wallet_session_state", value: data }]);
        return { status: "success", data };
      });
      expect((await invokeBinding(walletConnectionCapability, binding, {})).ok).toBe(false);
    }
  });

  it("centrally rejects conflicting chain anchors for one exact-anchor conclusion", async () => {
    const otherBlock = chainAnchorSchema.parse({
      ...block,
      blockNumber: "11",
      blockHash: `0x${"b".repeat(64)}`,
    });
    const definition = defineReadCapability({
      capabilityId: "test.anchors",
      inputSchema: z.object({}).strict(),
      dataSchema: z.object({ value: z.string() }).strict(),
      failureCodes: ["internal_error", "invalid_input", "result_too_large"],
      conclusionIds: ["value_observed"],
      observationSlots: () => [
        { slotId: "first", factId: "value", kind: "source" as const, purpose: "first", sourceClass: "chain_rpc" as const },
        { slotId: "second", factId: "value", kind: "source" as const, purpose: "second", sourceClass: "chain_rpc" as const },
      ],
      evidenceDeclaration: () => ({
        observationExpectations: [
          { slotId: "first", claims: [{ role: "first", value: "same", chainAnchor: block }] },
          { slotId: "second", claims: [{ role: "second", value: "same", chainAnchor: otherBlock }] },
        ],
        observationReferences: [],
        factRequirements: [{
          factId: "value",
          observationSlotIds: ["first", "second"],
          requiredObservationSlotIds: ["first", "second"],
          minimumObservationCount: 2,
          outcome: "observed" as const,
        }],
        expectedConclusionIds: ["value_observed"],
        conclusionDrafts: [{
          id: "value_observed",
          outcomeFactId: "value",
          evidenceFactIds: ["value"],
          freshnessRuleId: "chain_anchor_exact" as const,
        }],
        warningRequirements: [],
      }),
      warningCodes: [],
      staticScopeExclusions: [],
    });
    const harness = createCapabilityHarness();
    const binding = bindForHarness(definition, harness, async (_input, context, observations) => {
      record(context, observations, "chain_rpc", "first", [{ role: "first", value: "same", chainAnchor: block }]);
      record(context, observations, "chain_rpc", "second", [{ role: "second", value: "same", chainAnchor: otherBlock }]);
      return { status: "success", data: { value: "same" } };
    });
    expect((await invokeBinding(definition, binding, {})).ok).toBe(false);
  });
});
