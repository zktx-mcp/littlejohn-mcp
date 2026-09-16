import { evmAddressSchema, type EvmAddress } from "../../core/index.js";
import { poolPriceStateSchema, PoolPriceReadError, type PoolPriceState } from "../pool-price-contract.js";
import { decodePoolPriceResponse, type PoolPriceReadSession } from "../pool-price-reads.js";
import { uniswapV2FactoryAddress, uniswapV2FactoryRuntimeCodeIdentity } from "./deployment.js";
import { uniswapV2Evm } from "./evm.js";

export const readUniswapV2PoolPrice = async (input: Readonly<{
  session: PoolPriceReadSession; poolId: string; stock: EvmAddress; quote: EvmAddress;
}>): Promise<PoolPriceState> => {
  const pool = evmAddressSchema.parse(input.poolId);
  const deploymentCode = await input.session.requireCode(uniswapV2FactoryAddress, uniswapV2FactoryRuntimeCodeIdentity);
  const factoryBytes = await input.session.call(pool, uniswapV2Evm.factory());
  const factory = decodePoolPriceResponse(() => uniswapV2Evm.decodeFactory(factoryBytes));
  if (factory !== uniswapV2FactoryAddress) throw new PoolPriceReadError("pool_identity_mismatch");
  const pairBytes = await input.session.call(factory, uniswapV2Evm.getPair(input.stock, input.quote));
  if (decodePoolPriceResponse(() => uniswapV2Evm.decodePair(pairBytes)) !== pool) throw new PoolPriceReadError("pool_identity_mismatch");
  const t0 = await input.session.call(pool, uniswapV2Evm.token0());
  const t1 = await input.session.call(pool, uniswapV2Evm.token1());
  const token0 = decodePoolPriceResponse(() => uniswapV2Evm.decodeToken0(t0));
  const token1 = decodePoolPriceResponse(() => uniswapV2Evm.decodeToken1(t1));
  if (token0 !== (input.stock < input.quote ? input.stock : input.quote) ||
      token1 !== (input.stock < input.quote ? input.quote : input.stock)) throw new PoolPriceReadError("pool_identity_mismatch");
  const reserveBytes = await input.session.call(pool, uniswapV2Evm.reserves());
  const reserves = decodePoolPriceResponse(() => uniswapV2Evm.decodeReserves(reserveBytes));
  if (reserves.reserve0 === 0n || reserves.reserve1 === 0n) throw new PoolPriceReadError("pool_uninitialized");
  return poolPriceStateSchema.parse({
    protocol: "uniswap_v2", poolId: pool, token0, token1,
    deploymentAddress: factory, deploymentCode,
    reserve0: reserves.reserve0.toString(10), reserve1: reserves.reserve1.toString(10), swapFeeMillionths: "3000",
  });
};
