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
  signal: AbortSignal;
  rpcSource?: ObservationAuthority;
  observations?: ObservationWriter;
}>): Promise<ConfiguredChainProof> => {
  if ((input.rpcSource === undefined) !== (input.observations === undefined)) {
    throw new TypeError("Configured chain evidence inputs are incomplete.");
  }
  const result = await input.rpc.request("eth_chainId", [], input.signal);
  if (result !== unsignedDecimalToRpcQuantity(deriveEip155Reference(input.chainId))) {
    throw new ChainOperationError("source_inconsistent");
  }
  const proof = Object.freeze({}) as ConfiguredChainProof;
  configuredChainProofs.set(proof, input.chainId);
  if (input.rpcSource !== undefined && input.observations !== undefined) {
    recordConfiguredChainProof({
      proof,
      rpcSource: input.rpcSource,
      observations: input.observations,
    });
  }
  return proof;
};

export interface ConfiguredChainProof {
  readonly __configuredChainProof: unique symbol;
}

const configuredChainProofs = new WeakMap<object, EvmChainId>();

export const readConfiguredChainProof = (proof: ConfiguredChainProof): EvmChainId => {
  const chainId = typeof proof === "object" && proof !== null
    ? configuredChainProofs.get(proof)
    : undefined;
  if (chainId === undefined) throw new TypeError("Configured chain proof is invalid.");
  return chainId;
};

export const recordConfiguredChainProof = (input: Readonly<{
  proof: ConfiguredChainProof;
  rpcSource: ObservationAuthority;
  observations: ObservationWriter;
  chainAnchor?: ChainAnchor;
}>): void => {
  const chainId = readConfiguredChainProof(input.proof);
  input.observations.record("rpc_chain_id", {
    source: input.rpcSource,
    claims: [{
      role: "chain_id",
      value: chainId,
      ...(input.chainAnchor === undefined ? {} : { chainAnchor: input.chainAnchor }),
    }],
  });
};
