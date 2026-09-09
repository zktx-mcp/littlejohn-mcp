import {
  admitDynamicFeeTransactionRequest,
  chainAnchorSchema,
  dynamicFeeTransactionCallSchema,
  deriveEip155Reference,
  evmAddressSchema,
  parseHash32,
  type ChainAnchor,
  type DynamicFeeTransactionCall,
  type DynamicFeeTransactionRequest,
  type EvmAddress,
  type EvmChainId,
  type Hash32,
  type HexBytes,
  type ObservationAuthority,
} from "../core/index.js";
import { readConfiguredCanonicalBlock, type CanonicalBlock } from "./canonical-block.js";
import { ChainOperationError } from "./errors.js";
import type { ChainInvocationContext, ChainInvocationLifecycle } from "./invocation-lifecycle.js";
import {
  normalizeIncludedTransaction,
  normalizeRpcBlockAnchor,
  normalizeRpcBytes,
  normalizeRpcTransaction,
  rpcQuantityToUnsignedDecimal,
  unsignedDecimalToRpcQuantity,
  type NormalizedIncludedTransaction,
  type NormalizedRpcTransaction,
} from "./normalization.js";
import { isRpcExecutionRevertedError, type RpcRequester, type RpcTransactionCall } from "./rpc.js";

export const serializeDynamicFeeCall = (input: DynamicFeeTransactionCall): RpcTransactionCall => {
  const call = dynamicFeeTransactionCallSchema.parse(input);
  return Object.freeze({
    type: "0x2", accessList: Object.freeze([]) as readonly [],
    chainId: unsignedDecimalToRpcQuantity(deriveEip155Reference(call.chainId)),
    from: call.from, to: call.to, data: call.data,
    value: unsignedDecimalToRpcQuantity(call.value),
    nonce: unsignedDecimalToRpcQuantity(call.nonce),
    maxFeePerGas: unsignedDecimalToRpcQuantity(call.maxFeePerGas),
    maxPriorityFeePerGas: unsignedDecimalToRpcQuantity(call.maxPriorityFeePerGas),
  });
};

export const serializeDynamicFeeRequest = (input: DynamicFeeTransactionRequest): RpcTransactionCall => {
  const request = admitDynamicFeeTransactionRequest(input);
  const { gasLimit, ...call } = request;
  return Object.freeze({ ...serializeDynamicFeeCall(call), gas: unsignedDecimalToRpcQuantity(gasLimit) });
};

export type TransactionReadResult =
  | Readonly<{ status: "not_found" }>
  | Readonly<{ status: "pending"; transaction: NormalizedRpcTransaction }>
  | Readonly<{ status: "included"; value: NormalizedIncludedTransaction }>
  | Readonly<{ status: "reorged"; transaction: NormalizedRpcTransaction; canonicalBlock: ChainAnchor }>;

// Used by both pending replacement construction and independent receipt
// comparison. Observed envelope fields are never supplied from local defaults.
export const dynamicFeeRequestFromTransaction = (transaction: NormalizedRpcTransaction): DynamicFeeTransactionRequest => {
  if (transaction.type !== "2" || transaction.recipient.kind !== "call" || transaction.fee.kind !== "dynamic" ||
      transaction.accessList.kind !== "entries" || transaction.accessList.entries.length !== 0) {
    throw new TypeError("The observed transaction is outside the supported type-2 profile.");
  }
  return admitDynamicFeeTransactionRequest({
    type: transaction.type, accessList: transaction.accessList.entries,
    chainId: transaction.chainScope, from: transaction.from, to: transaction.recipient.address,
    value: transaction.value, data: transaction.input, nonce: transaction.nonce, gasLimit: transaction.gasLimit,
    maxFeePerGas: transaction.fee.maxFeePerGas, maxPriorityFeePerGas: transaction.fee.maxPriorityFeePerGas,
  });
};

export interface TransactionChainReadPort {
  readonly observationAuthority: ObservationAuthority;
  balance(context: ChainInvocationContext, block: CanonicalBlock, account: EvmAddress): Promise<string>;
  nonce(context: ChainInvocationContext, block: CanonicalBlock, account: EvmAddress): Promise<Readonly<{ confirmed: string; pending: string }>>;
  estimateGas(context: ChainInvocationContext, block: CanonicalBlock, call: DynamicFeeTransactionCall): Promise<string>;
  simulate(context: ChainInvocationContext, block: CanonicalBlock, request: DynamicFeeTransactionRequest): Promise<Readonly<{ status: "returned"; data: HexBytes }> | Readonly<{ status: "reverted" }>>;
  readTransaction(context: ChainInvocationContext, hash: Hash32): Promise<TransactionReadResult>;
  finality(context: ChainInvocationContext, block: ChainAnchor): Promise<Readonly<{ status: "included" | "safe" | "finalized"; head: ChainAnchor }>>;
}

export const createTransactionChainReadPort = (input: {
  readonly rpc: RpcRequester;
  readonly lifecycle: ChainInvocationLifecycle;
  readonly chainId: EvmChainId;
  readonly observationAuthority: ObservationAuthority;
}): TransactionChainReadPort => {
  const stateFor = (context: ChainInvocationContext, block: CanonicalBlock) => {
    input.lifecycle.assertActiveContext(context);
    return readConfiguredCanonicalBlock({ context, block, chainId: input.chainId });
  };
  const normalized = <Value>(read: () => Value): Value => {
    try { return read(); }
    catch { throw new ChainOperationError("source_inconsistent"); }
  };
  const assertCallChain = (chainId: EvmChainId): void => {
    if (chainId !== input.chainId) throw new TypeError("Transaction chain differs from the configured reader.");
  };
  return Object.freeze({
    observationAuthority: input.observationAuthority,
    async balance(context: ChainInvocationContext, block: CanonicalBlock, account: EvmAddress) {
      const state = stateFor(context, block);
      const raw = await input.rpc.request("eth_getBalance", [evmAddressSchema.parse(account), state.stateReference], context.signal);
      return normalized(() => rpcQuantityToUnsignedDecimal(raw));
    },
    async nonce(context: ChainInvocationContext, block: CanonicalBlock, accountInput: EvmAddress) {
      const state = stateFor(context, block);
      const account = evmAddressSchema.parse(accountInput);
      const confirmedRaw = await input.rpc.request("eth_getTransactionCount", [account, state.stateReference], context.signal);
      const pendingRaw = await input.rpc.request("eth_getTransactionCount", [account, "pending"], context.signal);
      const value = normalized(() => ({ confirmed: rpcQuantityToUnsignedDecimal(confirmedRaw), pending: rpcQuantityToUnsignedDecimal(pendingRaw) }));
      if (BigInt(value.pending) < BigInt(value.confirmed)) throw new ChainOperationError("source_inconsistent");
      return Object.freeze(value);
    },
    async estimateGas(context: ChainInvocationContext, block: CanonicalBlock, call: DynamicFeeTransactionCall) {
      const state = stateFor(context, block);
      assertCallChain(call.chainId);
      const raw = await input.rpc.request("eth_estimateGas", [serializeDynamicFeeCall(call), state.stateReference], context.signal);
      const gas = normalized(() => rpcQuantityToUnsignedDecimal(raw));
      if (gas === "0") throw new ChainOperationError("source_inconsistent");
      return gas;
    },
    async simulate(context: ChainInvocationContext, block: CanonicalBlock, request: DynamicFeeTransactionRequest) {
      const state = stateFor(context, block);
      assertCallChain(request.chainId);
      try {
        const raw = await input.rpc.request("eth_call", [serializeDynamicFeeRequest(request), state.stateReference], context.signal);
        return Object.freeze({ status: "returned" as const, data: normalized(() => normalizeRpcBytes(raw)) });
      } catch (error) {
        if (isRpcExecutionRevertedError(error)) return Object.freeze({ status: "reverted" as const });
        throw error;
      }
    },
    async readTransaction(context: ChainInvocationContext, hashInput: Hash32): Promise<TransactionReadResult> {
      input.lifecycle.assertActiveContext(context);
      const hash = parseHash32(hashInput);
      const raw = await input.rpc.request("eth_getTransactionByHash", [hash], context.signal);
      if (raw === null) return Object.freeze({ status: "not_found" });
      const transaction = normalized(() => normalizeRpcTransaction(raw, input.chainId));
      if (transaction.transactionHash !== hash) throw new ChainOperationError("source_inconsistent");
      if (transaction.position.status === "pending") return Object.freeze({ status: "pending", transaction });
      const receipt = await input.rpc.request("eth_getTransactionReceipt", [hash], context.signal);
      const block = await input.rpc.request("eth_getBlockByHash", [transaction.position.blockHash, false], context.signal);
      const value = normalized(() => normalizeIncludedTransaction(raw, receipt, block, input.chainId));
      const canonicalRaw = await input.rpc.request("eth_getBlockByNumber", [unsignedDecimalToRpcQuantity(value.block.blockNumber), false], context.signal);
      const canonical = normalized(() => normalizeRpcBlockAnchor(canonicalRaw, input.chainId));
      if (canonical.blockNumber !== value.block.blockNumber) throw new ChainOperationError("source_inconsistent");
      return canonical.blockHash === value.block.blockHash
        ? Object.freeze({ status: "included", value })
        : Object.freeze({ status: "reorged", transaction, canonicalBlock: canonical });
    },
    async finality(context: ChainInvocationContext, block: ChainAnchor) {
      input.lifecycle.assertActiveContext(context);
      assertCallChain(block.chainId);
      const canonical = chainAnchorSchema.parse(block);
      const currentRaw = await input.rpc.request("eth_getBlockByNumber", [unsignedDecimalToRpcQuantity(canonical.blockNumber), false], context.signal);
      if (currentRaw === null) throw new ChainOperationError("chain_response_unavailable");
      const current = normalized(() => normalizeRpcBlockAnchor(currentRaw, input.chainId));
      if (current.blockHash !== canonical.blockHash || current.blockNumber !== canonical.blockNumber) {
        throw new ChainOperationError("source_inconsistent");
      }
      const finalizedRaw = await input.rpc.request("eth_getBlockByNumber", ["finalized", false], context.signal);
      if (finalizedRaw === null) throw new ChainOperationError("chain_response_unavailable");
      const finalized = normalized(() => normalizeRpcBlockAnchor(finalizedRaw, input.chainId));
      if (finalized.blockNumber === canonical.blockNumber && finalized.blockHash !== canonical.blockHash) {
        throw new ChainOperationError("source_inconsistent");
      }
      if (BigInt(finalized.blockNumber) >= BigInt(canonical.blockNumber)) return Object.freeze({ status: "finalized" as const, head: finalized });
      const safeRaw = await input.rpc.request("eth_getBlockByNumber", ["safe", false], context.signal);
      if (safeRaw === null) throw new ChainOperationError("chain_response_unavailable");
      const safe = normalized(() => normalizeRpcBlockAnchor(safeRaw, input.chainId));
      if (BigInt(safe.blockNumber) < BigInt(finalized.blockNumber) ||
          (safe.blockNumber === canonical.blockNumber && safe.blockHash !== canonical.blockHash)) {
        throw new ChainOperationError("source_inconsistent");
      }
      return Object.freeze({ status: BigInt(safe.blockNumber) >= BigInt(canonical.blockNumber) ? "safe" as const : "included" as const, head: safe });
    },
  });
};
