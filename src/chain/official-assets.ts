import type { ChainAnchor } from "../core/index.js";
import type {
  OfficialAssetSourceMember,
  StockFactoryClassificationUnavailableReason,
  StockFactoryVerification,
} from "../registry/official-asset-contract.js";
import {
  createStockFactoryVerifier,
  getStockFactoryVerificationErrorCode,
} from "../registry/stock-factory.js";
import type {
  ChainInvocationContext,
  ChainInvocationLifecycle,
} from "./invocation-lifecycle.js";
import type { RpcRequester } from "./rpc.js";
import {
  admitChainReadFailure,
  ChainOperationError,
  createChainFailure,
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
  ): Promise<StockFactoryVerification>;
  verifyManyAtBlock(
    members: readonly OfficialAssetSourceMember[],
    block: CanonicalBlock,
    context: ChainInvocationContext,
  ): Promise<readonly OfficialAssetVerificationResult[]>;
}

export type OfficialAssetVerificationResult =
  | Readonly<{ status: "verified"; verification: StockFactoryVerification }>
  | Readonly<{
      status: "unavailable";
      reason: StockFactoryClassificationUnavailableReason;
    }>;

const officialAssetVerificationConcurrency = 5;

export const createOfficialAssetChainReadPort = (input: Readonly<{
  rpc: RpcRequester;
  chainId: ChainAnchor["chainId"];
  lifecycle: ChainInvocationLifecycle;
}>): OfficialAssetChainReadPort => {
  const verifyManyAtBlock = async (
    members: readonly OfficialAssetSourceMember[],
    blockInput: CanonicalBlock,
    context: ChainInvocationContext,
  ): Promise<readonly OfficialAssetVerificationResult[]> => {
    input.lifecycle.assertActiveContext(context);
    try {
      const block = readConfiguredCanonicalBlock({
        context,
        block: blockInput,
        chainId: input.chainId,
      });
      const verifier = await createStockFactoryVerifier({
        rpc: input.rpc,
        block: block.anchor,
        stateReference: block.stateReference,
        signal: context.signal,
      });
      const results: OfficialAssetVerificationResult[] = [];
      for (
        let start = 0;
        start < members.length;
        start += officialAssetVerificationConcurrency
      ) {
        input.lifecycle.assertActiveContext(context);
        const batch = members.slice(start, start + officialAssetVerificationConcurrency);
        const settled = await Promise.allSettled(batch.map((member) => verifier.verify(member)));
        for (const result of settled) {
          if (result.status === "fulfilled") {
            results.push(Object.freeze({
              status: "verified",
              verification: result.value,
            }));
            continue;
          }
          const reason = getStockFactoryVerificationErrorCode(result.reason);
          if (reason === "request_aborted") throw result.reason;
          results.push(Object.freeze({
            status: "unavailable",
            reason: reason ?? "source_inconsistent",
          }));
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
      if (result?.status === "verified") return result.verification;
      const reason = result?.reason;
      throw new ChainOperationError(
        reason === "chain_response_unavailable" ||
        reason === "rate_limited" ||
        reason === "runtime_busy" ||
        reason === "source_unavailable" ||
        reason === "source_inconsistent"
          ? createChainFailure(reason)
          : createChainFailure("source_inconsistent"),
      );
    },
    verifyManyAtBlock,
  });
};
