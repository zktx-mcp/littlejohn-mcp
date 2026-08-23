import type { BlockSelector, ChainAnchor, EvmChainId } from "../core/index.js";
import {
  validateConfiguredChain,
  type ConfiguredChainProof,
} from "./configured-chain.js";
import { admitChainReadFailure, ChainOperationError } from "./errors.js";
import { blockSelectorToRpcTag, normalizeRpcBlockAnchor } from "./normalization.js";
import {
  assertActiveChainInvocationContext,
  type ChainInvocationContext,
  type ChainInvocationLifecycle,
} from "./invocation-lifecycle.js";
import {
  canonicalBlockReference,
  type RpcCanonicalBlockReference,
  type RpcRequester,
} from "./rpc.js";

export interface CanonicalBlock {
  readonly anchor: ChainAnchor;
}

interface CanonicalBlockState {
  readonly context: ChainInvocationContext;
  readonly anchor: ChainAnchor;
  readonly stateReference: RpcCanonicalBlockReference;
  readonly configuredChainProof: ConfiguredChainProof;
}

const canonicalBlockStates = new WeakMap<object, CanonicalBlockState>();

export interface CurrentBlockReadPort {
  resolveCurrentBlock(context: ChainInvocationContext): Promise<CanonicalBlock>;
}

export const resolveConfiguredCanonicalBlock = async (input: Readonly<{
  rpc: RpcRequester;
  chainId: EvmChainId;
  selector: BlockSelector;
  context: ChainInvocationContext;
}>): Promise<CanonicalBlock> => {
  assertActiveChainInvocationContext(input.context);
  const signal = input.context.signal;
  const configuredChainProof = await validateConfiguredChain({
    rpc: input.rpc,
    chainId: input.chainId,
    signal,
  });
  const raw = await input.rpc.request(
    "eth_getBlockByNumber",
    [blockSelectorToRpcTag(input.selector), false],
    signal,
  );
  if (raw === null) throw new ChainOperationError("source_inconsistent");
  let anchor: ChainAnchor;
  try { anchor = normalizeRpcBlockAnchor(raw, input.chainId); }
  catch { throw new ChainOperationError("source_inconsistent"); }
  if (input.selector.kind === "number" && input.selector.blockNumber !== anchor.blockNumber) {
    throw new ChainOperationError("source_inconsistent");
  }
  const block = Object.freeze({ anchor }) satisfies CanonicalBlock;
  canonicalBlockStates.set(block, Object.freeze({
    context: input.context,
    anchor,
    stateReference: canonicalBlockReference(anchor.blockHash),
    configuredChainProof,
  }));
  return block;
};

export const readConfiguredCanonicalBlock = (input: Readonly<{
  context: ChainInvocationContext;
  block: CanonicalBlock;
  chainId: EvmChainId;
}>): CanonicalBlockState => {
  assertActiveChainInvocationContext(input.context);
  const state = typeof input.block === "object" && input.block !== null
    ? canonicalBlockStates.get(input.block)
    : undefined;
  if (
    state === undefined ||
    state.context !== input.context ||
    state.anchor.chainId !== input.chainId ||
    input.block.anchor !== state.anchor
  ) {
    throw new TypeError("Configured canonical block authority is invalid.");
  }
  return state;
};

export const createCurrentBlockReadPort = (input: Readonly<{
  rpc: RpcRequester;
  chainId: EvmChainId;
  lifecycle: ChainInvocationLifecycle;
}>): CurrentBlockReadPort => {
  if (
    typeof input !== "object" || input === null ||
    typeof input.rpc?.request !== "function" ||
    typeof input.lifecycle?.assertActiveContext !== "function"
  ) {
    throw new TypeError("Current-block read dependencies are invalid.");
  }
  return Object.freeze({
    async resolveCurrentBlock(context: ChainInvocationContext): Promise<CanonicalBlock> {
      input.lifecycle.assertActiveContext(context);
      try {
        return await resolveConfiguredCanonicalBlock({
          rpc: input.rpc,
          chainId: input.chainId,
          selector: { kind: "latest" },
          context,
        });
      } catch (error) {
        const failure = admitChainReadFailure(error, context.signal);
        if (failure !== undefined) throw new ChainOperationError(failure);
        throw error;
      }
    },
  });
};
