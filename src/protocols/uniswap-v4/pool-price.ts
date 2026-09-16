import { evmAddressSchema, type EvmAddress } from "../../core/index.js";
import type { EvmAbiCodec } from "../../chain/index.js";
import { poolPriceStateSchema, PoolPriceReadError, type PoolPriceState } from "../pool-price-contract.js";
import { decodePoolPriceResponse, type PoolPriceReadSession } from "../pool-price-reads.js";
import { uniswapV4ContractAddresses as addresses, uniswapV4PriceReadCodeIdentities as codes } from "./deployment.js";
import { createUniswapV4Evm } from "./evm.js";
import { deriveUniswapV4PoolId, uniswapV4PoolIdSchema, uniswapV4PoolKeySchema } from "./identity.js";

const metadataAbi = [
  { type: "function", name: "poolManager", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "poolKeys", stateMutability: "view", inputs: [{ type: "bytes25" }], outputs: [
    { type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" },
  ] },
] as const;

export const readUniswapV4PoolPrice = async (input: Readonly<{
  session: PoolPriceReadSession; codec: EvmAbiCodec; poolId: string; stock: EvmAddress; quote: EvmAddress;
}>): Promise<PoolPriceState> => {
  const poolId = uniswapV4PoolIdSchema.parse(input.poolId);
  const deploymentCode = await input.session.requireCode(addresses.poolManager, codes.poolManager);
  const positionManagerCode = await input.session.requireCode(addresses.positionManager, codes.positionManager);
  const stateViewCode = await input.session.requireCode(addresses.stateView, codes.stateView);
  const managerCall = input.codec.encodeFunction(metadataAbi, "poolManager", []);
  for (const address of [addresses.positionManager, addresses.stateView]) {
    const bytes = await input.session.call(address, managerCall);
    const [manager] = decodePoolPriceResponse(() => input.codec.decodeParameters(metadataAbi[0].outputs, bytes));
    if (typeof manager !== "string" || manager.toLowerCase() !== addresses.poolManager) {
      throw new PoolPriceReadError("deployment_identity_mismatch");
    }
  }
  let keyBytes;
  try {
    keyBytes = await input.session.call(addresses.positionManager,
      input.codec.encodeFunction(metadataAbi, "poolKeys", [poolId.slice(0, 52)]));
  } catch (error) {
    if (error instanceof PoolPriceReadError && error.reason === "pool_state_unavailable") {
      throw new PoolPriceReadError("pool_metadata_unavailable");
    }
    throw error;
  }
  const [currency0, currency1, fee, tickSpacing, hooks] =
    decodePoolPriceResponse(() => input.codec.decodeParameters(metadataAbi[1].outputs, keyBytes));
  if (currency0 === "0x0000000000000000000000000000000000000000" &&
      currency1 === "0x0000000000000000000000000000000000000000" && fee === 0 && tickSpacing === 0 &&
      hooks === "0x0000000000000000000000000000000000000000") throw new PoolPriceReadError("pool_metadata_unavailable");
  const address = (value: unknown) => evmAddressSchema.parse(typeof value === "string" ? value.toLowerCase() : value);
  const key = decodePoolPriceResponse(() => uniswapV4PoolKeySchema.parse({
    currency0: address(currency0), currency1: address(currency1), fee, tickSpacing, hooks: address(hooks),
  }));
  if (deriveUniswapV4PoolId(key) !== poolId ||
      key.currency0 !== (input.stock < input.quote ? input.stock : input.quote) ||
      key.currency1 !== (input.stock < input.quote ? input.quote : input.stock)) {
    throw new PoolPriceReadError("pool_identity_mismatch");
  }
  const evm = createUniswapV4Evm(input.codec);
  const slotBytes = await input.session.call(addresses.stateView, evm.slot0(poolId));
  const slot = decodePoolPriceResponse(() => evm.decodeSlot0(slotBytes));
  if (slot.sqrtPriceX96 === "0") throw new PoolPriceReadError("pool_uninitialized");
  return decodePoolPriceResponse(() => poolPriceStateSchema.parse({
    protocol: "uniswap_v4", poolId, token0: key.currency0, token1: key.currency1,
    deploymentAddress: addresses.poolManager, deploymentCode,
    positionManager: addresses.positionManager, positionManagerCode,
    stateView: addresses.stateView, stateViewCode,
    poolKey: key, sqrtPriceX96: slot.sqrtPriceX96,
    lpFeeMillionths: String(slot.lpFee),
    protocolFee0To1Millionths: String(slot.protocolFee & 0xfff),
    protocolFee1To0Millionths: String(slot.protocolFee >> 12),
    dynamicFee: key.fee === 0x800000,
  }));
};
