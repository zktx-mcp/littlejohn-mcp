import { z } from "zod";
import {canonicalJsonStringify, captureCanonicalJson, jsonObject} from "../core/client.js";
import {chainAnchorSchema} from "../evm/primitives.js";
import {evmAddressSchema} from "../evm/identities.js";
import {maximumTokenDecimals} from "../evm/amounts.js";
import {productChainId} from "../registry/product-identity.js";
import {productUsdgAsset} from "../registry/product-assets.js";
import {
  officialAssetSourceDefinition, officialAssetSourceLabelSchema,
  officialAssetSourceMemberSchema, officialAssetSnapshotEvidenceSchema,
  stockFactoryVerificationResultSchema,
} from "../registry/official-asset-contract.js";
import { poolPriceReadReasons, poolPriceStateSchema, poolPriceFailureStatus, type PoolPriceState } from "../protocols/pool-price-contract.js";
import { uniswapV2FactoryAddress } from "../protocols/uniswap-v2/deployment.js";
import { uniswapV3FactoryAddress } from "../protocols/uniswap-v3/deployment.js";
import { uniswapV4ContractAddresses } from "../protocols/uniswap-v4/deployment.js";
import { poolCandidateSchema, poolCandidateSourceResultSchema } from "./source-contract.js";
import { stockTokenPriceRatioSchema, tokenUnitPoolPrice } from "./numeric.js";

export const stockTokenPricesInputSchema = z.union([
  jsonObject({ symbol: officialAssetSourceLabelSchema.transform((s) => s.toUpperCase()).pipe(officialAssetSourceLabelSchema) }).strict(),
  jsonObject({ tokenAddress: evmAddressSchema }).strict(),
]);
export type StockTokenPricesInput = z.infer<typeof stockTokenPricesInputSchema>;
export const stockTokensInputSchema = jsonObject({}).strict();
export const stockTokensDataSchema = jsonObject({
  snapshot: officialAssetSnapshotEvidenceSchema,
  members: z.array(officialAssetSourceMemberSchema).min(1).max(officialAssetSourceDefinition.memberLimit),
}).strict();
export type StockTokensData = z.infer<typeof stockTokensDataSchema>;

const decimalsSchema = z.number().int().nonnegative().max(maximumTokenDecimals);
const selected = {
  snapshot: officialAssetSnapshotEvidenceSchema,
  member: officialAssetSourceMemberSchema,
};
export const pricedPoolSchema = z.discriminatedUnion("status", [
  jsonObject({ status: z.literal("verified"), candidate: poolCandidateSchema,
    state: poolPriceStateSchema, price: stockTokenPriceRatioSchema }).strict(),
  jsonObject({ status: z.literal("unsupported"), candidate: poolCandidateSchema }).strict(),
  jsonObject({ status: z.literal("invalid"), candidate: poolCandidateSchema,
    reason: z.enum(poolPriceReadReasons) }).strict(),
  jsonObject({ status: z.literal("unavailable"), candidate: poolCandidateSchema,
    reason: z.enum(poolPriceReadReasons) }).strict(),
]);
export type PricedPool = z.infer<typeof pricedPoolSchema>;
export const stockTokenPricesDataSchema = z.discriminatedUnion("status", [
  jsonObject({
    status: z.literal("selection_unavailable"), snapshot: officialAssetSnapshotEvidenceSchema,
    reason: z.enum(["official_asset_not_found", "official_asset_ambiguous"]),
    candidates: z.array(officialAssetSourceMemberSchema).max(officialAssetSourceDefinition.memberLimit),
  }).strict(),
  jsonObject({
    ...selected, status: z.literal("asset_unavailable"), block: chainAnchorSchema,
    source: poolCandidateSourceResultSchema,
    verification: stockFactoryVerificationResultSchema,
    reason: z.enum(["stock_factory_unavailable", "token_decimals_unavailable"]),
  }).strict(),
  jsonObject({
    ...selected, status: z.literal("available"), block: chainAnchorSchema,
    verification: stockFactoryVerificationResultSchema,
    stockDecimals: decimalsSchema, quoteDecimals: decimalsSchema,
    source: poolCandidateSourceResultSchema,
    pools: z.array(pricedPoolSchema),
  }).strict(),
]);
export type StockTokenPricesData = z.infer<typeof stockTokenPricesDataSchema>;

const same = (a: unknown, b: unknown) => canonicalJsonStringify(captureCanonicalJson(a)) === canonicalJsonStringify(captureCanonicalJson(b));
export const priceFromPoolState = (state: PoolPriceState, stock: string, stockDecimals: number, quoteDecimals: number) => {
  const forward = state.token0 === stock;
  const numerator = state.protocol === "uniswap_v2"
    ? BigInt(forward ? state.reserve1 : state.reserve0)
    : forward ? BigInt(state.sqrtPriceX96) ** 2n : 1n << 192n;
  const denominator = state.protocol === "uniswap_v2"
    ? BigInt(forward ? state.reserve0 : state.reserve1)
    : forward ? 1n << 192n : BigInt(state.sqrtPriceX96) ** 2n;
  return tokenUnitPoolPrice({ numerator, denominator, stockDecimals, quoteDecimals });
};

export const assertStockTokenPricesData = (data: StockTokenPricesData): void => {
  if (data.status === "selection_unavailable") {
    if (data.reason === "official_asset_not_found" ? data.candidates.length !== 0 : data.candidates.length < 2) {
      throw new TypeError("Official selection outcome contradicts its candidates.");
    }
    return;
  }
  if (data.block.chainId !== productChainId || !same(data.member, data.verification.member) ||
      data.source.stockTokenAddress !== data.member.contractAddress ||
      (data.verification.status === "verified" && !same(data.block, data.verification.verification.block))) {
    throw new TypeError("The selected asset verification has a different identity or block.");
  }
  if (data.status === "asset_unavailable") {
    if ((data.reason === "stock_factory_unavailable") !== (data.verification.status === "unavailable")) {
      throw new TypeError("Asset availability contradicts its verification.");
    }
    return;
  }
  if (data.verification.status !== "verified" || data.source.stockTokenAddress !== data.member.contractAddress ||
      data.source.candidates.length !== data.pools.length) throw new TypeError("Price result changed its admitted candidates or asset.");
  for (let index = 0; index < data.pools.length; index += 1) {
    const row = data.pools[index]!;
    if (!same(row.candidate, data.source.candidates[index])) throw new TypeError("Price row changed candidate identity or order.");
    if (row.status === "unsupported") {
      if (row.candidate.status !== "unsupported") throw new TypeError("Unsupported price row has a supported candidate.");
      continue;
    }
    if (row.candidate.status === "unsupported") throw new TypeError("An unsupported candidate cannot be read as a registered protocol.");
    if (row.status !== "verified") {
      if (poolPriceFailureStatus(row.reason) !== row.status ||
          (row.candidate.status === "invalid" && row.status !== "invalid")) throw new TypeError("Pool failure classification differs from its owning meaning.");
      continue;
    }
    const state = row.state;
    const stock = data.member.contractAddress;
    if (row.candidate.status !== "candidate" || state.protocol !== row.candidate.protocol || state.poolId !== row.candidate.poolId ||
        state.token0 !== (stock < productUsdgAsset.address ? stock : productUsdgAsset.address) ||
        state.token1 !== (stock < productUsdgAsset.address ? productUsdgAsset.address : stock)) {
      throw new TypeError("Verified pool differs from the requested pair or candidate.");
    }
    const deployment = state.protocol === "uniswap_v2" ? uniswapV2FactoryAddress :
      state.protocol === "uniswap_v3" ? uniswapV3FactoryAddress : uniswapV4ContractAddresses.poolManager;
    if (state.deploymentAddress !== deployment || !same(row.price, priceFromPoolState(state, stock, data.stockDecimals, data.quoteDecimals))) {
      throw new TypeError("Price arithmetic or deployment identity is inconsistent.");
    }
  }
};

export const assertStockTokenPricesRequest = (input: StockTokenPricesInput, data: StockTokenPricesData): void => {
  const members = data.status === "selection_unavailable" ? data.candidates : [data.member];
  if (members.some((member) => "symbol" in input ? member.sourceSymbol !== input.symbol : member.contractAddress !== input.tokenAddress)) {
    throw new TypeError("Price result changed its selected official asset.");
  }
};
