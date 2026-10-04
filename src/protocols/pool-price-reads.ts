import {canonicalJsonStringify, captureCanonicalJson, type HexBytes} from "../core/index.js";
import {type ContractRuntimeCodeIdentity} from "../intelligence/analysis-contract.js";
import {type EvmAddress} from "../evm/identities.js";
import type { CanonicalBlock, ChainInvocationContext, PinnedEvmReadPort } from "../chain/index.js";
import type { ContractRuntimeCode } from "../intelligence/ports.js";
import { PoolPriceReadError } from "./pool-price-contract.js";

// One request/block owns these memoized observations. They are never reused by
// another request or a transaction decision.
export const createPoolPriceReadSession = (input: Readonly<{
  context: ChainInvocationContext;
  block: CanonicalBlock;
  reads: PinnedEvmReadPort;
}>) => {
  const code = new Map<string, Promise<ContractRuntimeCode | null>>();
  const calls = new Map<string, ReturnType<PinnedEvmReadPort["call"]>>();
  const readCode = (address: EvmAddress) => {
    input.context.signal.throwIfAborted();
    let pending = code.get(address);
    if (pending === undefined) {
      pending = input.reads.readRuntimeCode(input.context, input.block, address);
      code.set(address, pending);
    }
    return pending;
  };
  return Object.freeze({
    async requireCode(address: EvmAddress, expected?: ContractRuntimeCodeIdentity) {
      const observed = await readCode(address);
      if (observed === null || (expected !== undefined &&
          canonicalJsonStringify(captureCanonicalJson(observed.identity)) !== canonicalJsonStringify(captureCanonicalJson(expected)))) {
        throw new PoolPriceReadError("deployment_identity_mismatch");
      }
      return observed.identity;
    },
    async call(address: EvmAddress, data: HexBytes): Promise<HexBytes> {
      input.context.signal.throwIfAborted();
      const key = `${address}:${data}`;
      let pending = calls.get(key);
      if (pending === undefined) {
        pending = input.reads.call(input.context, input.block, { to: address, data });
        calls.set(key, pending);
      }
      const result = await pending;
      if (result.status === "reverted") throw new PoolPriceReadError("pool_state_unavailable");
      return result.value;
    },
  });
};
export type PoolPriceReadSession = ReturnType<typeof createPoolPriceReadSession>;

export const decodePoolPriceResponse = <Value>(decode: () => Value): Value => {
  try { return decode(); } catch (error) {
    if (error instanceof PoolPriceReadError) throw error;
    throw new PoolPriceReadError("pool_response_malformed");
  }
};
