import { z } from "zod";

import {evmAddressSchema} from "../../evm/identities.js";
import {hash32Schema, jsonObject} from "../../core/client.js";
import {keccak256FromHex} from "../../evm/keccak256.js";

export const uniswapV4PoolIdSchema = hash32Schema;

// The ABI shape is shared by archive admission and live protocol reads.
// Pool initialization and execution availability are separate observations.
export const uniswapV4PoolKeySchema = jsonObject({
  currency0: evmAddressSchema,
  currency1: evmAddressSchema,
  fee: z.number().int().nonnegative().safe().max(2 ** 24 - 1),
  tickSpacing: z.number().int().positive().safe().max(2 ** 23 - 1),
  hooks: evmAddressSchema,
}).strict();
export type UniswapV4PoolKey = z.infer<typeof uniswapV4PoolKeySchema>;

const abiWord = (value: string | bigint, bytes: number): string => {
  const hex = typeof value === "bigint" ? value.toString(16) : value.slice(2);
  if (hex.length > bytes * 2) throw new TypeError("PoolKey value exceeds its ABI width.");
  return hex.padStart(64, "0");
};

export const deriveUniswapV4PoolId = (input: UniswapV4PoolKey): string => {
  const key = uniswapV4PoolKeySchema.parse(input);
  return keccak256FromHex(`0x${[
    abiWord(key.currency0, 20),
    abiWord(key.currency1, 20),
    abiWord(BigInt(key.fee), 3),
    abiWord(BigInt(key.tickSpacing), 3),
    abiWord(key.hooks, 20),
  ].join("")}`);
};
