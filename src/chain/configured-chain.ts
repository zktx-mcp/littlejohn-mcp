import {deriveEip155Reference, type EvmChainId} from "../evm/identities.js";
import {type BoundEvidenceObservationTarget, type ObservationAuthority, type ObservationWriter} from "../core/index.js";
import {type ChainAnchor} from "../evm/primitives.js";
import {type ConfiguredChainEvidenceFragment} from "./evidence-fragments.js";
import { ChainOperationError } from "./errors.js";
import { unsignedDecimalToRpcQuantity } from "./normalization.js";
import type { RpcRequester } from "./rpc.js";

export const validateConfiguredChain = async (input: Readonly<{
  rpc: RpcRequester;
  chainId: EvmChainId;
  signal: AbortSignal;
  rpcSource?: ObservationAuthority;
  observations?: ObservationWriter;
  target?: BoundEvidenceObservationTarget<ConfiguredChainEvidenceFragment["target"]>;
}>): Promise<ConfiguredChainProof> => {
  if (
    (input.rpcSource === undefined) !== (input.observations === undefined) ||
    (input.rpcSource === undefined) !== (input.target === undefined)
  ) {
    throw new TypeError("Configured chain evidence inputs are incomplete.");
  }
  const result = await input.rpc.request("eth_chainId", [], input.signal);
  if (result !== unsignedDecimalToRpcQuantity(deriveEip155Reference(input.chainId))) {
    throw new ChainOperationError("source_inconsistent");
  }
  const proof = Object.freeze({}) as ConfiguredChainProof;
  configuredChainProofs.set(proof, input.chainId);
  if (input.rpcSource !== undefined) {
    if (input.observations === undefined || input.target === undefined) {
      throw new TypeError("Configured chain evidence inputs are incomplete.");
    }
    recordConfiguredChainProof({
      proof,
      rpcSource: input.rpcSource,
      observations: input.observations,
      target: input.target,
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
  target: BoundEvidenceObservationTarget<ConfiguredChainEvidenceFragment["target"]>;
  chainAnchor?: ChainAnchor;
}>): void => {
  const chainId = readConfiguredChainProof(input.proof);
  input.observations.record(input.target.slot, {
    source: input.rpcSource,
    claims: [{
      role: input.target.roles.chainId,
      value: chainId,
      ...(input.chainAnchor === undefined ? {} : { chainAnchor: input.chainAnchor }),
    }],
  });
};
