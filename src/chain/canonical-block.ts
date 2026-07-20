import type { BlockSelector, ChainAnchor, EvmChainId } from "../core/index.js";
import { ChainOperationError } from "./errors.js";
import { blockSelectorToRpcTag, normalizeRpcBlockAnchor } from "./normalization.js";
import {
  canonicalBlockReference,
  type RpcCanonicalBlockReference,
  type RpcRequester,
} from "./rpc.js";

export interface CanonicalBlock {
  readonly anchor: ChainAnchor;
  readonly stateReference: RpcCanonicalBlockReference;
}

export const resolveCanonicalBlock = async (input: Readonly<{
  rpc: RpcRequester;
  chainId: EvmChainId;
  selector: BlockSelector;
  signal: AbortSignal;
}>): Promise<CanonicalBlock> => {
  const raw = await input.rpc.request(
    "eth_getBlockByNumber",
    [blockSelectorToRpcTag(input.selector), false],
    input.signal,
  );
  if (raw === null) throw new ChainOperationError("source_inconsistent");
  let anchor: ChainAnchor;
  try { anchor = normalizeRpcBlockAnchor(raw, input.chainId); }
  catch { throw new ChainOperationError("source_inconsistent"); }
  if (input.selector.kind === "number" && input.selector.blockNumber !== anchor.blockNumber) {
    throw new ChainOperationError("source_inconsistent");
  }
  return Object.freeze({ anchor, stateReference: canonicalBlockReference(anchor.blockHash) });
};
