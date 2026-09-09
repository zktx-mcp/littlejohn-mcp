import { keccak256FromUtf8, evmAddressSchema, type EvmAddress, type Hash32 } from "../../core/index.js";
import { uniswapV4SwapTopic } from "./event-contract.js";
import type { HexBytes } from "../../core/index.js";
import type { EvmAbiCodec } from "../../chain/index.js";
import { uniswapV4ContractAddresses } from "./deployment.js";


const permitApprovalTopic = keccak256FromUtf8("Approval(address,address,address,uint160,uint48)");
const indexedAddress = (word: string | undefined): EvmAddress => {
  if (word === undefined || !/^0x0{24}[0-9a-f]{40}$/u.test(word)) throw new TypeError("Invalid indexed event address.");
  return evmAddressSchema.parse(`0x${word.slice(26)}`);
};
export interface UniswapV4EventLog { readonly address: EvmAddress; readonly topics: readonly Hash32[]; readonly data: HexBytes }

export const createUniswapV4EventDecoder = (codec: EvmAbiCodec) => Object.freeze({
  swap(log: UniswapV4EventLog) {
    if (log.address !== uniswapV4ContractAddresses.poolManager || log.topics[0] !== uniswapV4SwapTopic) return null;
    if (log.topics.length !== 3) throw new TypeError("Invalid V4 Swap topics.");
    codec.decodeParameters([{ type: "int128" }, { type: "int128" }, { type: "uint160" },
      { type: "uint128" }, { type: "int24" }, { type: "uint24" }], log.data);
    return Object.freeze({ poolId: log.topics[1]!, sender: indexedAddress(log.topics[2]) });
  },
  approval(log: UniswapV4EventLog) {
    if (log.address !== uniswapV4ContractAddresses.permit2 || log.topics[0] !== permitApprovalTopic) return null;
    if (log.topics.length !== 4) throw new TypeError("Invalid Permit2 Approval topics.");
    const [amount, expiration] = codec.decodeParameters([{ type: "uint160" }, { type: "uint48" }], log.data);
    if (typeof amount !== "bigint" || amount < 0n || amount >= 1n << 160n ||
        typeof expiration !== "number" || !Number.isSafeInteger(expiration) || expiration < 0 || expiration >= 2 ** 48) {
      throw new TypeError("Invalid Permit2 Approval amount or expiration.");
    }
    return Object.freeze({ owner: indexedAddress(log.topics[1]), token: indexedAddress(log.topics[2]),
      spender: indexedAddress(log.topics[3]), amount: amount.toString(10), expiration: expiration.toString(10) });
  },
});
