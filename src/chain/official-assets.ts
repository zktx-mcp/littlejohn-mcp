import type { ChainAnchor } from "../core/index.js";
import {
  assertOfficialAssetSourceMember,
  assertStockFactoryVerificationResult,
  type OfficialAssetSourceMember,
  type StockFactoryVerificationResult,
} from "../registry/official-asset-contract.js";
import { createStockFactoryVerifier } from "../registry/stock-factory.js";
import type {
  ChainInvocationContext,
  ChainInvocationLifecycle,
} from "./invocation-lifecycle.js";
import type { RpcRequester } from "./rpc.js";
import {
  admitChainReadFailure,
  ChainOperationError,
} from "./errors.js";
import {
  readConfiguredCanonicalBlock,
  type CanonicalBlock,
} from "./canonical-block.js";

export interface OfficialAssetChainReadPort {
  verifyAtBlock(
    member: OfficialAssetSourceMember,
    block: CanonicalBlock,
    context: ChainInvocationContext,
  ): Promise<StockFactoryVerificationResult>;
  verifyManyAtBlock(
    members: readonly OfficialAssetSourceMember[],
    block: CanonicalBlock,
    context: ChainInvocationContext,
  ): Promise<readonly StockFactoryVerificationResult[]>;
}

const officialAssetVerificationConcurrency = 5;

export const createOfficialAssetChainReadPort = (input: Readonly<{
  rpc: RpcRequester;
  chainId: ChainAnchor["chainId"];
  lifecycle: ChainInvocationLifecycle;
}>): OfficialAssetChainReadPort => {
  const verifyManyAtBlock = async (
    memberInputs: readonly OfficialAssetSourceMember[],
    blockInput: CanonicalBlock,
    context: ChainInvocationContext,
  ): Promise<readonly StockFactoryVerificationResult[]> => {
    input.lifecycle.assertActiveContext(context);
    const members = memberInputs.map(assertOfficialAssetSourceMember);
    try {
      const block = readConfiguredCanonicalBlock({
        context,
        block: blockInput,
        chainId: input.chainId,
      });
      if (members.length === 0) return Object.freeze([]);
      const initialization = await createStockFactoryVerifier({
        rpc: input.rpc,
        block: block.anchor,
        stateReference: block.stateReference,
        signal: context.signal,
      });
      if (initialization.status === "unavailable") {
        return Object.freeze(members.map((member) =>
          assertStockFactoryVerificationResult({
            status: "unavailable",
            member,
            reason: initialization.reason,
          }),
        ));
      }
      const results: StockFactoryVerificationResult[] = [];
      for (
        let start = 0;
        start < members.length;
        start += officialAssetVerificationConcurrency
      ) {
        input.lifecycle.assertActiveContext(context);
        const batch = members.slice(start, start + officialAssetVerificationConcurrency);
        const settled = await Promise.allSettled(
          batch.map((member) => initialization.verifier.verify(member)),
        );
        const failure = settled.find(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        if (failure !== undefined) throw failure.reason;
        for (const result of settled) {
          if (result.status === "fulfilled") results.push(result.value);
        }
      }
      return Object.freeze(results);
    } catch (error) {
      const failure = admitChainReadFailure(error, context.signal);
      if (failure !== undefined) throw new ChainOperationError(failure);
      throw error;
    }
  };
  return Object.freeze({
    verifyAtBlock: async (
      member: OfficialAssetSourceMember,
      block: CanonicalBlock,
      context: ChainInvocationContext,
    ) => {
      const result = (await verifyManyAtBlock([member], block, context))[0];
      if (result === undefined) {
        throw new TypeError("StockFactory single verification result is missing.");
      }
      return result;
    },
    verifyManyAtBlock,
  });
};
