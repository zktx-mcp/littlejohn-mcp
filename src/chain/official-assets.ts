import {
  chainAnchorSchema,
  type ChainAnchor,
} from "../core/index.js";
import type { OfficialAssetSourceMember } from "../registry/official-assets.js";
import {
  createStockFactoryVerifier,
  getStockFactoryVerificationErrorCode,
  type StockFactoryVerification,
} from "../registry/stock-factory.js";
import { getChainInvocationStopReason, type ChainInvocationLifecycle } from "./invocation-lifecycle.js";
import { canonicalBlockReference, type RpcRequester } from "./rpc.js";
import { ChainOperationError } from "./errors.js";

export interface OfficialAssetChainReadPort {
  verifyAtBlock(
    member: OfficialAssetSourceMember,
    block: ChainAnchor,
    signal: AbortSignal,
  ): Promise<StockFactoryVerification>;
  verifyManyAtBlock(
    members: readonly OfficialAssetSourceMember[],
    block: ChainAnchor,
    signal: AbortSignal,
  ): Promise<readonly OfficialAssetVerificationResult[]>;
}

export type OfficialAssetVerificationResult =
  | Readonly<{ status: "verified"; verification: StockFactoryVerification }>
  | Readonly<{
      status: "unavailable";
      reason:
        | "factory_identity_mismatch"
        | "source_inconsistent"
        | "source_unavailable"
        | "token_code_missing"
        | "token_identity_mismatch";
    }>;

export const createOfficialAssetChainReadPort = (input: Readonly<{
  rpc: RpcRequester;
  chainId: ChainAnchor["chainId"];
  lifecycle: ChainInvocationLifecycle;
}>): OfficialAssetChainReadPort => {
  const verifyManyAtBlock = async (
    members: readonly OfficialAssetSourceMember[],
    blockInput: ChainAnchor,
    callerSignal: AbortSignal,
  ): Promise<readonly OfficialAssetVerificationResult[]> => {
    const block = chainAnchorSchema.parse(blockInput) as ChainAnchor;
    if (block.chainId !== input.chainId || !(callerSignal instanceof AbortSignal)) {
      throw new TypeError("Official asset verification block is invalid.");
    }
    try {
      return await input.lifecycle.run(callerSignal, async (signal) => {
        const stateReference = canonicalBlockReference(block.blockHash);
        const verifier = await createStockFactoryVerifier({
          rpc: input.rpc,
          block,
          stateReference,
          signal,
        });
        const settled = await Promise.allSettled(members.map((member) => verifier.verify(member)));
        return Object.freeze(settled.map((result): OfficialAssetVerificationResult => {
          if (result.status === "fulfilled") {
            return Object.freeze({ status: "verified", verification: result.value });
          }
          const reason = getStockFactoryVerificationErrorCode(result.reason);
          if (reason === "request_aborted") throw result.reason;
          return Object.freeze({
            status: "unavailable",
            reason: reason ?? "source_inconsistent",
          });
        }));
      });
    } catch (error) {
      const stopReason = getChainInvocationStopReason(error);
      if (stopReason !== undefined) throw new ChainOperationError(
        stopReason === "caller_aborted" ? "request_aborted" : "source_unavailable",
      );
      throw error;
    }
  };
  return Object.freeze({
    verifyAtBlock: async (
      member: OfficialAssetSourceMember,
      block: ChainAnchor,
      signal: AbortSignal,
    ) => {
      const result = (await verifyManyAtBlock([member], block, signal))[0];
      if (result?.status === "verified") return result.verification;
      throw new ChainOperationError(
        result?.reason === "source_unavailable" ? "source_unavailable" : "source_inconsistent",
      );
    },
    verifyManyAtBlock,
  });
};
