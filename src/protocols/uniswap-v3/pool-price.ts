import { evmAddressSchema, type EvmAddress } from "../../core/index.js";
import type { EvmAbiCodec } from "../../chain/index.js";
import { poolPriceStateSchema, PoolPriceReadError, type PoolPriceState } from "../pool-price-contract.js";
import { decodePoolPriceResponse, type PoolPriceReadSession } from "../pool-price-reads.js";
import { uniswapV3FactoryAddress, uniswapV3FactoryRuntimeCodeIdentity } from "./deployment.js";

const abi = [
  { type: "function", name: "factory", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "token1", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "fee", stateMutability: "view", inputs: [], outputs: [{ type: "uint24" }] },
  { type: "function", name: "tickSpacing", stateMutability: "view", inputs: [], outputs: [{ type: "int24" }] },
  { type: "function", name: "getPool", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }, { type: "uint24" }], outputs: [{ type: "address" }] },
  { type: "function", name: "slot0", stateMutability: "view", inputs: [], outputs: [
    { type: "uint160" }, { type: "int24" }, { type: "uint16" }, { type: "uint16" }, { type: "uint16" }, { type: "uint8" }, { type: "bool" },
  ] },
] as const;

export const readUniswapV3PoolPrice = async (input: Readonly<{
  session: PoolPriceReadSession; codec: EvmAbiCodec; poolId: string; stock: EvmAddress; quote: EvmAddress;
}>): Promise<PoolPriceState> => {
  const pool = evmAddressSchema.parse(input.poolId);
  const deploymentCode = await input.session.requireCode(uniswapV3FactoryAddress, uniswapV3FactoryRuntimeCodeIdentity);
  const read = async (address: EvmAddress, name: typeof abi[number]["name"], args: readonly unknown[] = []) => {
    const entry = abi.find((entry) => entry.name === name)!;
    const bytes = await input.session.call(address, input.codec.encodeFunction(abi, name, args));
    return decodePoolPriceResponse(() => input.codec.decodeParameters(entry.outputs, bytes));
  };
  const address = (value: unknown) => decodePoolPriceResponse(() => evmAddressSchema.parse(typeof value === "string" ? value.toLowerCase() : value));
  const [factory] = await read(pool, "factory");
  if (address(factory) !== uniswapV3FactoryAddress) throw new PoolPriceReadError("pool_identity_mismatch");
  const [fee] = await read(pool, "fee");
  const [mapped] = await read(uniswapV3FactoryAddress, "getPool", [input.stock, input.quote, fee]);
  if (address(mapped) !== pool) throw new PoolPriceReadError("pool_identity_mismatch");
  const [t0] = await read(pool, "token0");
  const [t1] = await read(pool, "token1");
  const token0 = address(t0); const token1 = address(t1);
  if (token0 !== (input.stock < input.quote ? input.stock : input.quote) ||
      token1 !== (input.stock < input.quote ? input.quote : input.stock)) throw new PoolPriceReadError("pool_identity_mismatch");
  const [tickSpacing] = await read(pool, "tickSpacing");
  const [sqrtPriceX96] = await read(pool, "slot0");
  if (sqrtPriceX96 === 0n) throw new PoolPriceReadError("pool_uninitialized");
  return decodePoolPriceResponse(() => poolPriceStateSchema.parse({
    protocol: "uniswap_v3", poolId: pool, token0, token1,
    deploymentAddress: uniswapV3FactoryAddress, deploymentCode,
    sqrtPriceX96: String(sqrtPriceX96), tickSpacing, swapFeeMillionths: String(fee),
  }));
};
