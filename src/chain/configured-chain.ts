import {
  deriveEip155Reference,
  type ChainAnchor,
  type EvmChainId,
  type ObservationAuthority,
  type ObservationWriter,
} from "../core/index.js";
import { ChainOperationError } from "./errors.js";
import { unsignedDecimalToRpcQuantity } from "./normalization.js";
import type { RpcRequester } from "./rpc.js";

export const validateConfiguredChain = async (input: Readonly<{
  rpc: RpcRequester;
  chainId: EvmChainId;
  rpcSource: ObservationAuthority;
  signal: AbortSignal;
  observations: ObservationWriter;
  chainAnchor?: ChainAnchor;
}>): Promise<void> => {
  const result = await input.rpc.request("eth_chainId", [], input.signal);
  if (result !== unsignedDecimalToRpcQuantity(deriveEip155Reference(input.chainId))) {
    throw new ChainOperationError("source_inconsistent");
  }
  input.observations.record("rpc_chain_id", {
    source: input.rpcSource,
    claims: [{
      role: "chain_id",
      value: input.chainId,
      ...(input.chainAnchor === undefined ? {} : { chainAnchor: input.chainAnchor }),
    }],
  });
};
