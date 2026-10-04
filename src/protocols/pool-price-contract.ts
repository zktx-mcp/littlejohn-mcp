import { z } from "zod";
import {contractRuntimeCodeIdentitySchema} from "../intelligence/analysis-contract.js";
import {evmAddressSchema} from "../evm/identities.js";
import {jsonObject, unsignedDecimalSchema} from "../core/client.js";
import {uint256DecimalSchema} from "../evm/amounts.js";
import { deriveUniswapV4PoolId, uniswapV4PoolKeySchema } from "./uniswap-v4/identity.js";
import { uniswapV2FactoryAddress, uniswapV2FactoryRuntimeCodeIdentity } from "./uniswap-v2/deployment.js";
import { uniswapV3FactoryAddress, uniswapV3FactoryRuntimeCodeIdentity } from "./uniswap-v3/deployment.js";
import { uniswapV4ContractAddresses, uniswapV4PriceReadCodeIdentities } from "./uniswap-v4/deployment.js";

export const poolPriceProtocolSchema = z.enum(["uniswap_v2", "uniswap_v3", "uniswap_v4"]);
export type PoolPriceProtocol = z.infer<typeof poolPriceProtocolSchema>;
const fee = unsignedDecimalSchema.refine((value) => BigInt(value) <= 1_000_000n, "Fee exceeds its millionths scale.");
const reserve = uint256DecimalSchema.refine((value) => BigInt(value) < (1n << 112n), "Reserve exceeds uint112.");
const sqrtPrice = uint256DecimalSchema.refine((value) => BigInt(value) < (1n << 160n), "Price exceeds uint160.");
const common = {
  token0: evmAddressSchema,
  token1: evmAddressSchema,
  deploymentAddress: evmAddressSchema,
  deploymentCode: contractRuntimeCodeIdentitySchema,
};
export const poolPriceStateSchema = z.discriminatedUnion("protocol", [
  jsonObject({
    ...common, protocol: z.literal("uniswap_v2"), poolId: evmAddressSchema,
    reserve0: reserve, reserve1: reserve,
    swapFeeMillionths: z.literal("3000"),
  }).strict(),
  jsonObject({
    ...common, protocol: z.literal("uniswap_v3"), poolId: evmAddressSchema,
    sqrtPriceX96: sqrtPrice, tickSpacing: z.number().int().positive().max((1 << 23) - 1),
    swapFeeMillionths: fee,
  }).strict(),
  jsonObject({
    ...common, protocol: z.literal("uniswap_v4"),
    poolId: z.string().regex(/^0x[0-9a-f]{64}$/u), poolKey: uniswapV4PoolKeySchema,
    sqrtPriceX96: sqrtPrice, positionManager: evmAddressSchema,
    positionManagerCode: contractRuntimeCodeIdentitySchema,
    stateView: evmAddressSchema, stateViewCode: contractRuntimeCodeIdentitySchema,
    lpFeeMillionths: fee,
    protocolFee0To1Millionths: fee, protocolFee1To0Millionths: fee,
    dynamicFee: z.boolean(),
  }).strict(),
]).superRefine((value, context) => {
  const expectedAddress = value.protocol === "uniswap_v2" ? uniswapV2FactoryAddress
    : value.protocol === "uniswap_v3" ? uniswapV3FactoryAddress : uniswapV4ContractAddresses.poolManager;
  const expectedCode = value.protocol === "uniswap_v2" ? uniswapV2FactoryRuntimeCodeIdentity
    : value.protocol === "uniswap_v3" ? uniswapV3FactoryRuntimeCodeIdentity : uniswapV4PriceReadCodeIdentities.poolManager;
  if (value.deploymentAddress !== expectedAddress || value.deploymentCode.codeHash !== expectedCode.codeHash || value.deploymentCode.byteLength !== expectedCode.byteLength) {
    context.addIssue({ code: "custom", message: "The pool state does not belong to an admitted deployment." });
  }
  if (value.token0 >= value.token1) context.addIssue({ code: "custom", message: "Pool currencies are not in protocol order." });
  if (value.protocol === "uniswap_v4") {
    if (value.positionManager !== uniswapV4ContractAddresses.positionManager || value.stateView !== uniswapV4ContractAddresses.stateView ||
        value.positionManagerCode.codeHash !== uniswapV4PriceReadCodeIdentities.positionManager.codeHash ||
        value.positionManagerCode.byteLength !== uniswapV4PriceReadCodeIdentities.positionManager.byteLength ||
        value.stateViewCode.codeHash !== uniswapV4PriceReadCodeIdentities.stateView.codeHash ||
        value.stateViewCode.byteLength !== uniswapV4PriceReadCodeIdentities.stateView.byteLength) {
      context.addIssue({ code: "custom", message: "V4 metadata or state source identity is inconsistent." });
    }
    if (value.poolKey.currency0 !== value.token0 || value.poolKey.currency1 !== value.token1 ||
        deriveUniswapV4PoolId(value.poolKey) !== value.poolId ||
        value.dynamicFee !== (value.poolKey.fee === 0x800000) ||
        BigInt(value.protocolFee0To1Millionths) > 1000n || BigInt(value.protocolFee1To0Millionths) > 1000n ||
        (!value.dynamicFee && (value.poolKey.fee > 1_000_000 || value.lpFeeMillionths !== String(value.poolKey.fee)))) {
      context.addIssue({ code: "custom", message: "V4 PoolKey, state or fee identity is inconsistent." });
    }
  }
});
export type PoolPriceState = z.infer<typeof poolPriceStateSchema>;
export const poolPriceReadReasons = [
  "pool_identity_mismatch", "deployment_identity_mismatch", "pool_metadata_unavailable",
  "pool_state_unavailable", "pool_uninitialized", "pool_response_malformed",
  "chain_response_unavailable", "source_unavailable", "source_inconsistent", "rate_limited",
] as const;
export type PoolPriceReadReason = typeof poolPriceReadReasons[number];
export const poolPriceFailureStatus = (reason: PoolPriceReadReason): "invalid" | "unavailable" =>
  reason === "pool_identity_mismatch" || reason === "deployment_identity_mismatch" ||
  reason === "pool_response_malformed" || reason === "source_inconsistent" ? "invalid" : "unavailable";
export class PoolPriceReadError extends Error {
  constructor(readonly reason: PoolPriceReadReason) { super(reason); }
}
