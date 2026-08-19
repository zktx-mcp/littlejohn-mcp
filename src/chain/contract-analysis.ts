import {
  contractDefaultAdminMemberLimit,
  evmAddressSchema,
  parseHexBytes,
  parseUnsignedDecimal,
  type ChainAnchor,
  type EvmAddress,
  type HexBytes,
  type UnsignedDecimal,
} from "../core/index.js";
import type {
  ContractAnalysisChainReadPort,
  ContractReadResult,
  ContractStorageAddress,
} from "../intelligence/ports.js";
import { ChainOperationError } from "./errors.js";
import {
  decodeAbiAddressResult,
  decodeAbiBooleanResult,
  decodeAbiUint256Result,
  eip1967StorageSlots,
  type ContractAnalysisCallEncoder,
} from "./evm-standard.js";
import {
  normalizeRpcBytes,
  normalizeRpcRuntimeCode,
} from "./normalization.js";
import { rpcBatchCallLimit } from "./limits.js";
import {
  isRpcExecutionRevertedError,
  type RpcCanonicalBlockReference,
  type RpcRequester,
} from "./rpc.js";

if (contractDefaultAdminMemberLimit > rpcBatchCallLimit) {
  throw new TypeError("The contract default-administrator limit exceeds the RPC batch limit.");
}

const storageAddress = (input: unknown): ContractStorageAddress => {
  try {
    const word = normalizeRpcBytes(input);
    if (!/^0x[0-9a-f]{64}$/u.test(word)) return Object.freeze({ status: "malformed" });
    if (/^0x0{64}$/u.test(word)) return Object.freeze({ status: "not_present" });
    if (!/^0x0{24}[0-9a-f]{40}$/u.test(word)) return Object.freeze({ status: "malformed" });
    const address = evmAddressSchema.parse(`0x${word.slice(-40)}`);
    if (address === "0x0000000000000000000000000000000000000000") {
      return Object.freeze({ status: "not_present" });
    }
    return Object.freeze({ status: "observed", address });
  } catch {
    return Object.freeze({ status: "malformed" });
  }
};

const settledValues = async <Value>(
  promises: readonly Promise<Value>[],
): Promise<readonly Value[]> => {
  const settled = await Promise.allSettled(promises);
  const rejected = settled.find(
    (entry): entry is PromiseRejectedResult => entry.status === "rejected",
  );
  if (rejected !== undefined) throw rejected.reason;
  return settled.map((entry) => (entry as PromiseFulfilledResult<Value>).value);
};

export const createContractAnalysisChainReadPort = (input: {
  readonly rpc: RpcRequester;
  readonly encoder: ContractAnalysisCallEncoder;
  readonly chainId: ContractAnalysisChainReadPort["chainId"];
  readonly block: ChainAnchor;
  readonly stateReference: RpcCanonicalBlockReference;
  readonly signal: AbortSignal;
}): ContractAnalysisChainReadPort => {
  if (
    input.block.chainId !== input.chainId ||
    input.stateReference.blockHash !== input.block.blockHash
  ) {
    throw new TypeError("Contract-analysis chain block is inconsistent.");
  }
  const stop = new AbortController();
  const signal = AbortSignal.any([input.signal, stop.signal]);

  const boundary = async <Value>(operation: () => Promise<Value>): Promise<Value> => {
    try {
      return await operation();
    } catch (error) {
      stop.abort();
      throw error;
    }
  };

  const call = async <Value>(
    address: EvmAddress,
    data: HexBytes,
    decode: (value: unknown) => Value,
  ): Promise<ContractReadResult<Value>> => {
    try {
      const raw = await input.rpc.request(
        "eth_call",
        [{ to: address, data }, input.stateReference],
        signal,
      );
      try {
        return Object.freeze({ status: "observed", value: decode(raw) });
      } catch {
        return Object.freeze({ status: "malformed" });
      }
    } catch (error) {
      if (isRpcExecutionRevertedError(error)) return Object.freeze({ status: "reverted" });
      stop.abort();
      throw error;
    }
  };

  return Object.freeze({
    chainId: input.chainId,
    block: input.block,
    async readRuntimeCode(addressInput: EvmAddress) {
      const address = evmAddressSchema.parse(addressInput);
      return boundary(async () => {
        const raw = await input.rpc.request(
          "eth_getCode",
          [address, input.stateReference],
          signal,
        );
        let normalized;
        try {
          normalized = normalizeRpcRuntimeCode(raw);
        } catch {
          throw new ChainOperationError("source_inconsistent");
        }
        return normalized.status === "empty"
          ? null
          : Object.freeze({
              bytecode: normalized.bytecode,
              identity: Object.freeze({
                byteLength: normalized.byteLength,
                codeHash: normalized.codeHash,
              }),
            });
      });
    },
    async readEip1967ProxyStorage(addressInput: EvmAddress) {
      const address = evmAddressSchema.parse(addressInput);
      const values = await boundary(() => settledValues([
        input.rpc.request(
          "eth_getStorageAt",
          [address, eip1967StorageSlots.implementation, input.stateReference],
          signal,
        ),
        input.rpc.request(
          "eth_getStorageAt",
          [address, eip1967StorageSlots.beacon, input.stateReference],
          signal,
        ),
        input.rpc.request(
          "eth_getStorageAt",
          [address, eip1967StorageSlots.admin, input.stateReference],
          signal,
        ),
      ]));
      return Object.freeze({
        implementation: storageAddress(values[0]),
        beacon: storageAddress(values[1]),
        admin: storageAddress(values[2]),
      });
    },
    readBeaconImplementation(addressInput: EvmAddress) {
      const address = evmAddressSchema.parse(addressInput);
      return call(address, input.encoder.beaconImplementation(), decodeAbiAddressResult);
    },
    readOwner(addressInput: EvmAddress) {
      const address = evmAddressSchema.parse(addressInput);
      return call(address, input.encoder.owner(), decodeAbiAddressResult);
    },
    readPaused(addressInput: EvmAddress) {
      const address = evmAddressSchema.parse(addressInput);
      return call(address, input.encoder.paused(), decodeAbiBooleanResult);
    },
    readDefaultAdminRole(addressInput: EvmAddress) {
      const address = evmAddressSchema.parse(addressInput);
      return call(address, input.encoder.defaultAdminRole(), (value) => {
        const word = normalizeRpcBytes(value);
        if (!/^0x[0-9a-f]{64}$/u.test(word)) {
          throw new TypeError("Default-administrator role result is invalid.");
        }
        return parseHexBytes(word);
      });
    },
    readDefaultAdminMemberCount(addressInput: EvmAddress, roleInput: HexBytes) {
      const address = evmAddressSchema.parse(addressInput);
      const role = parseHexBytes(roleInput);
      return call(
        address,
        input.encoder.defaultAdminMemberCount(role),
        decodeAbiUint256Result,
      );
    },
    async readDefaultAdminMembers(
      addressInput: EvmAddress,
      roleInput: HexBytes,
      countInput: UnsignedDecimal,
    ) {
      const address = evmAddressSchema.parse(addressInput);
      const role = parseHexBytes(roleInput);
      const count = parseUnsignedDecimal(countInput);
      const countNumber = Number(count);
      if (
        !Number.isSafeInteger(countNumber) ||
        countNumber < 0 ||
        countNumber > contractDefaultAdminMemberLimit
      ) {
        throw new TypeError("Default-administrator member count is invalid.");
      }
      if (countNumber === 0) {
        return Object.freeze({ status: "observed", value: Object.freeze([]) });
      }
      if (input.rpc.requestBatch === undefined) {
        throw new TypeError("RPC batch support is required for administrator enumeration.");
      }
      const results = await boundary(() => input.rpc.requestBatch!(
        Array.from({ length: countNumber }, (_, index) => ({
          method: "eth_call" as const,
          params: [{
            to: address,
            data: input.encoder.defaultAdminMember(
              role,
              parseUnsignedDecimal(String(index)),
            ),
          }, input.stateReference] as const,
        })),
        signal,
      ));
      const members: EvmAddress[] = [];
      for (const result of results) {
        if (result.status === "rejected") {
          if (isRpcExecutionRevertedError(result.reason)) {
            return Object.freeze({ status: "reverted" });
          }
          stop.abort();
          throw result.reason;
        }
        try {
          members.push(decodeAbiAddressResult(result.value));
        } catch {
          return Object.freeze({ status: "malformed" });
        }
      }
      return Object.freeze({ status: "observed", value: Object.freeze(members) });
    },
  });
};
