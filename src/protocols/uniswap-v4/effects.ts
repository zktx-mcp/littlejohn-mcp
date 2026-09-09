import { z } from "zod";
import { deepFreezeValue, evmAddressSchema, hash32Schema, jsonObject, uint256DecimalSchema, utcTimestampSchema } from "../../core/client.js";
import { resolvedExchangeIntentSchema, type ResolvedExchangeIntent } from "../../review/exchange.js";
import { getUniswapV4PoolCandidate } from "./catalog.js";
import { uniswapV4ContractAddresses } from "./deployment.js";
import type { UniswapV4TransactionKind } from "./evm.js";

const approval = {
  token: evmAddressSchema, spender: evmAddressSchema, allowance: uint256DecimalSchema,
} as const;
export const uniswapV4ExpectedEffectSchema = z.discriminatedUnion("kind", [
  jsonObject({
    kind: z.literal("swap"), router: evmAddressSchema, poolId: hash32Schema,
    basis: z.enum(["sent", "received"]),
    payer: evmAddressSchema, recipient: evmAddressSchema,
    tokenIn: evmAddressSchema, tokenOut: evmAddressSchema,
    input: jsonObject({ relation: z.enum(["equal", "at_most"]), amount: uint256DecimalSchema }).strict(),
    output: jsonObject({ relation: z.enum(["equal", "at_least"]), amount: uint256DecimalSchema }).strict(),
    deadline: utcTimestampSchema,
  }).strict(),
  jsonObject({ kind: z.literal("erc20_approval"), ...approval, expiration: z.literal("none") }).strict(),
  jsonObject({ kind: z.literal("permit2_approval"), ...approval, expiration: utcTimestampSchema }).strict(),
]);
export type UniswapV4ExpectedEffect = z.infer<typeof uniswapV4ExpectedEffectSchema>;

export const describeUniswapV4ExpectedEffect = (
  intentInput: ResolvedExchangeIntent,
  kind: UniswapV4TransactionKind,
): UniswapV4ExpectedEffect => {
  const intent = resolvedExchangeIntentSchema.parse(intentInput);
  const pool = getUniswapV4PoolCandidate(intent.poolId);
  if (pool.stockTokenAddress !== intent.stockTokenAddress) throw new TypeError("Exchange effect has a different pool asset.");
  return deepFreezeValue(uniswapV4ExpectedEffectSchema.parse(kind === "swap" ? {
    kind, router: uniswapV4ContractAddresses.router, poolId: intent.poolId,
    basis: intent.basis,
    payer: intent.account.address, recipient: intent.account.address,
    tokenIn: intent.input.token, tokenOut: intent.output.token,
    input: { relation: intent.inputRelation, amount: intent.input.raw },
    output: { relation: intent.outputRelation, amount: intent.output.raw },
    deadline: intent.deadline,
  } : {
    kind, token: intent.input.token, allowance: intent.input.raw,
    spender: kind === "erc20_approval" ? uniswapV4ContractAddresses.permit2 : uniswapV4ContractAddresses.router,
    expiration: kind === "erc20_approval" ? "none" : intent.deadline,
  }));
};
