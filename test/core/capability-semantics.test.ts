import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  accountBalanceEvidence,
  accountBalanceCapability,
  accountTokenEvidenceIdentity,
  chainAnchorSchema,
  evmAddressSchema,
  evmChainIdSchema,
  transactionInspectEvidence,
  transactionInspectCapability,
  walletConnectionEvidence,
  walletConnectionCapability,
  type BoundEvidenceObservationTarget,
  type HandlerInvocationContext,
  type ObservationClaim,
  type ObservationWriter,
} from "../../src/core/index.js";
import { defineReadCapability } from "../../src/core/capability.js";
import {
  createEvidenceFactIdentityDeclaration,
  createEvidenceObservationTargetDeclaration,
  createEvidenceReplayDefinition,
  createExactConclusionIdentityDeclaration,
} from "../../src/core/evidence-replay.js";
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
  slot: Parameters<ObservationWriter["record"]>[0],
  claims: readonly ObservationClaim[],
) => observations.record(slot, {
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

const transactionClaims = (
  data: PendingData,
  target: BoundEvidenceObservationTarget<
    typeof transactionInspectEvidence.targets.transaction
  >,
): readonly ObservationClaim[] => {
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
      role: target.roles.transaction,
      value: {
        ...data,
        value: sourceAmount,
        gasLimit: { raw: data.gasLimit.raw },
        fee,
      },
    },
    { role: target.roles.value, value: "1", asset: sourceAmount.asset },
    { role: target.roles.gasLimit, value: "21000" },
    ...(data.fee.kind === "legacy"
      ? [{
          role: target.roles.gasPrice,
          value: data.fee.gasPrice.numerator.raw,
          asset: sourceAmount.asset,
        }]
      : [
          {
            role: target.roles.maxFeePerGas,
            value: data.fee.maxFeePerGas.numerator.raw,
            asset: sourceAmount.asset,
          },
          {
            role: target.roles.maxPriorityFeePerGas,
            value: data.fee.maxPriorityFeePerGas.numerator.raw,
            asset: sourceAmount.asset,
          },
        ]),
  ];
};

describe("capability semantic and evidence authority", () => {
  it("rejects an amount whose raw value differs from its source claim", async () => {
    const harness = createCapabilityHarness();
    const binding = bindForHarness(accountBalanceCapability, harness, async (input, context, observations) => {
      const identity = accountTokenEvidenceIdentity(input, token);
      const chain = observations.bind(accountBalanceEvidence.configuredChain.target);
      const blockTarget = observations.bind(accountBalanceEvidence.targets.block);
      const balanceTarget = observations.bind(identity.balanceTarget);
      const decimalsTarget = observations.bind(identity.decimalsTarget);
      record(context, observations, "chain_rpc", chain.slot, [{
        role: chain.roles.chainId,
        value: configuredChainId,
      }]);
      record(context, observations, "chain_rpc", blockTarget.slot, [{
        role: blockTarget.roles.block,
        value: block,
        chainAnchor: block,
      }]);
      const quantity = record(context, observations, "chain_rpc", balanceTarget.slot, [{
        role: balanceTarget.roles.balance,
        value: "2",
        asset: { kind: "erc20", chainId: configuredChainId, address: token },
        chainAnchor: block,
      }]);
      const decimals = record(context, observations, "chain_rpc", decimalsTarget.slot, [{
        role: decimalsTarget.roles.decimals,
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
      const chain = observations.bind(transactionInspectEvidence.configuredChain.target);
      const transaction = observations.bind(transactionInspectEvidence.targets.transaction);
      record(context, observations, "chain_rpc", chain.slot, [{
        role: chain.roles.chainId,
        value: configuredChainId,
      }]);
      const provisional = pendingData(`0x${"f".repeat(64)}`, `obs:${"A".repeat(43)}`);
      const transactionId = record(
        context,
        observations,
        "chain_rpc",
        transaction.slot,
        transactionClaims(provisional, transaction),
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
      const chain = observations.bind(transactionInspectEvidence.configuredChain.target);
      const transaction = observations.bind(transactionInspectEvidence.targets.transaction);
      record(context, observations, "chain_rpc", chain.slot, [{
        role: chain.roles.chainId,
        value: configuredChainId,
      }]);
      const provisional = pendingData(transactionHash, `obs:${"A".repeat(43)}`);
      transactionId = record(
        context,
        observations,
        "chain_rpc",
        transaction.slot,
        transactionClaims(provisional, transaction),
      );
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
      const chain = observations.bind(transactionInspectEvidence.configuredChain.target);
      const transaction = observations.bind(transactionInspectEvidence.targets.transaction);
      record(context, observations, "chain_rpc", chain.slot, [{
        role: chain.roles.chainId,
        value: configuredChainId,
      }]);
      const provisional = pendingData(transactionHash, `obs:${"A".repeat(43)}`);
      const transactionId = record(
        context,
        observations,
        "chain_rpc",
        transaction.slot,
        transactionClaims(provisional, transaction),
      );
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
        const chain = observations.bind(transactionInspectEvidence.configuredChain.target);
        const transaction = observations.bind(transactionInspectEvidence.targets.transaction);
        record(context, observations, "chain_rpc", chain.slot, [{
          role: chain.roles.chainId,
          value: configuredChainId,
        }]);
        const provisional = dynamicPendingData(transactionHash, `obs:${"A".repeat(43)}`);
        const transactionId = record(
          context,
          observations,
          "chain_rpc",
          transaction.slot,
          transactionClaims(provisional, transaction),
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
        const chain = observations.bind(transactionInspectEvidence.configuredChain.target);
        const transaction = observations.bind(transactionInspectEvidence.targets.transaction);
        record(context, observations, "chain_rpc", chain.slot, [{
          role: chain.roles.chainId,
          value: configuredChainId,
        }]);
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
          transaction.slot,
          transactionClaims(invalid, transaction),
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
      const sdk = observations.bind(walletConnectionEvidence.targets.sdk);
      record(context, observations, "wallet_sdk", sdk.slot, [{
        role: sdk.roles.state,
        value: connected,
      }]);
      return { status: "success", data: connected };
    });
    expect((await invokeBinding(walletConnectionCapability, missing, {})).ok).toBe(false);

    const complete = bindForHarness(walletConnectionCapability, harness, async (_input, context, observations) => {
      const sdk = observations.bind(walletConnectionEvidence.targets.sdk);
      const session = observations.bind(walletConnectionEvidence.targets.session);
      record(context, observations, "wallet_sdk", sdk.slot, [{
        role: sdk.roles.state,
        value: connected,
      }]);
      record(context, observations, "wallet_session", session.slot, [{
        role: session.roles.state,
        value: connected,
      }]);
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
        const sdk = observations.bind(walletConnectionEvidence.targets.sdk);
        const session = observations.bind(walletConnectionEvidence.targets.session);
        record(context, observations, "wallet_sdk", sdk.slot, [{
          role: sdk.roles.state,
          value: data,
        }]);
        record(context, observations, "wallet_session", session.slot, [{
          role: session.roles.state,
          value: data,
        }]);
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
    const conclusion = createExactConclusionIdentityDeclaration("value_observed");
    const replay = createEvidenceReplayDefinition({
      capabilityId: "test.anchors",
      conclusions: [conclusion],
      warningCodes: [],
    });
    const fact = createEvidenceFactIdentityDeclaration(replay, "value");
    const firstTarget = createEvidenceObservationTargetDeclaration(replay, {
      slotId: "first",
      fact,
      kind: "source",
      purpose: "first",
      sourceClass: "chain_rpc",
      roles: { value: "first" },
    });
    const secondTarget = createEvidenceObservationTargetDeclaration(replay, {
      slotId: "second",
      fact,
      kind: "source",
      purpose: "second",
      sourceClass: "chain_rpc",
      roles: { value: "second" },
    });
    const definition = defineReadCapability({
      capabilityId: "test.anchors",
      contractVersion: "1",
      inputSchema: z.object({}).strict(),
      dataSchema: z.object({ value: z.string() }).strict(),
      failureCodes: ["internal_error", "invalid_input", "result_too_large"],
      evidence: {
        definition: replay,
        observationTargets: () => [firstTarget, secondTarget],
        declaration: (_input, _data, binder) => {
          const first = binder.bind(firstTarget);
          const second = binder.bind(secondTarget);
          return {
            observationExpectations: [
              {
                slot: first.slot,
                claims: [{ role: first.roles.value, value: "same", chainAnchor: block }],
              },
              {
                slot: second.slot,
                claims: [{ role: second.roles.value, value: "same", chainAnchor: otherBlock }],
              },
            ],
            observationReferences: [],
            factRequirements: [{
              fact,
              observationSlots: [first.slot, second.slot],
              requiredObservationSlots: [first.slot, second.slot],
              minimumObservationCount: 2,
              outcome: "observed",
            }],
            conclusionDrafts: [{
              conclusion,
              outcomeFact: fact,
              evidenceFacts: [fact],
              freshnessRuleId: "chain_anchor_exact",
            }],
            warningRequirements: [],
          };
        },
        staticScopeExclusions: [],
      },
    });
    const harness = createCapabilityHarness();
    const binding = bindForHarness(definition, harness, async (_input, context, observations) => {
      const first = observations.bind(firstTarget);
      const second = observations.bind(secondTarget);
      record(context, observations, "chain_rpc", first.slot, [{
        role: first.roles.value,
        value: "same",
        chainAnchor: block,
      }]);
      record(context, observations, "chain_rpc", second.slot, [{
        role: second.roles.value,
        value: "same",
        chainAnchor: otherBlock,
      }]);
      return { status: "success", data: { value: "same" } };
    });
    expect((await invokeBinding(definition, binding, {})).ok).toBe(false);
  });
});
