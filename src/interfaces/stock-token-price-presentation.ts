import {formatAmount} from "../evm/amounts.js";
import {formatRationalForDisplay} from "../evm/numeric-display.js";
import {productUsdgAsset} from "../registry/product-assets.js";
import type { PricedPool, StockTokenPricesData, StockTokensData } from "../stock-token-prices/result.js";
import type { PoolPriceReadReason } from "../protocols/pool-price-contract.js";

const reasonLabels: Record<PoolPriceReadReason, string> = {
  pool_identity_mismatch: "Pool identity does not match the requested pair.",
  deployment_identity_mismatch: "The expected protocol deployment could not be verified.",
  pool_metadata_unavailable: "Pool metadata is unavailable through the supported read path.",
  pool_state_unavailable: "The pool state could not be read.",
  pool_uninitialized: "The pool has no initialized price or positive reserves.",
  pool_response_malformed: "The pool returned invalid data.",
  chain_response_unavailable: "The chain response is unavailable.",
  source_unavailable: "The source is unavailable.",
  source_inconsistent: "The source data is inconsistent.",
  rate_limited: "The source limited this read.",
};

export const poolPriceStatusText = (row: PricedPool): string => row.status === "verified" ? "Verified pool price"
  : row.status === "unsupported" ? "This candidate's protocol or version is not supported."
    : reasonLabels[row.reason];
export const poolPriceValueText = (row: PricedPool): string => {
  if (row.status !== "verified") return "Unavailable";
  const display = formatRationalForDisplay(row.price);
  return `${display.relation === "approximately" ? "≈ " : ""}${display.coefficient}${display.notation === "scientific" ? `e${display.exponent >= 0 ? "+" : ""}${display.exponent}` : ""} USDG`;
};
const percent = (millionths: string) => `${formatAmount(millionths, "4")}%`;
export const poolPriceFeeText = (row: PricedPool): string => {
  if (row.status !== "verified") return "Unavailable";
  const state = row.state;
  if (state.protocol !== "uniswap_v4") return `Pool swap fee: ${percent(state.swapFeeMillionths)}`;
  const protocol = state.token0 !== productUsdgAsset.address ?
    [state.protocolFee0To1Millionths, state.protocolFee1To0Millionths] :
    [state.protocolFee1To0Millionths, state.protocolFee0To1Millionths];
  return `Observed LP fee: ${percent(state.lpFeeMillionths)}${state.dynamicFee ? " (dynamic)" : ""}; ` +
    `protocol fee Stock Token→USDG: ${percent(protocol[0]!)}; USDG→Stock Token: ${percent(protocol[1]!)}`;
};
export const stockTokenPriceLimitations = Object.freeze([
  "Only candidates returned by the source are covered; this is not every pool or a best-price selection.",
  "Prices are pool spot ratios in USDG per Stock Token at the displayed block, not execution quotes or USD values.",
]);
export const stockTokenPriceUnavailableText = (data: Exclude<StockTokenPricesData, { status: "available" }>): string => {
  if (data.status === "selection_unavailable") return data.reason === "official_asset_not_found"
    ? "No matching official Stock Token was found." : "The symbol matches multiple official tokens. Choose an exact token address.";
  return data.reason === "stock_factory_unavailable" ? "The official token's on-chain identity could not be verified."
    : "Token decimals are unavailable; no price was calculated.";
};
export const stockTokenPricesHumanSummary = (data: StockTokenPricesData): string => {
  if (data.status !== "available") return ["Stock Token pool prices", stockTokenPriceUnavailableText(data),
    ...(data.status === "selection_unavailable" ? data.candidates.map((member) => `${member.sourceSymbol ?? member.sourceName ?? "Official token"}: ${member.contractAddress}`) : [])].join("\n");
  return [
    `Stock Token pool prices: ${data.member.sourceSymbol ?? data.member.contractAddress}`,
    `Price block: ${data.block.blockNumber} (${data.block.blockTimestamp})`,
    `Candidate source: ${data.source.sourceOwner}; coverage: source-reported candidates`,
    ...stockTokenPriceLimitations,
    ...(data.pools.length === 0 ? ["No matching candidates were returned by this source."] : data.pools.flatMap((row) => [
      `${row.candidate.protocol ?? row.candidate.sourceDexId} — ${row.candidate.poolId}`,
      `Price: ${poolPriceValueText(row)}; ${poolPriceStatusText(row)}`, poolPriceFeeText(row),
      ...(row.status === "verified" && row.state.protocol === "uniswap_v4" && row.state.dynamicFee
        ? ["A hook may override the execution fee; the observed LP fee does not establish the final swap fee."] : []),
    ])),
  ].join("\n");
};
export const stockTokensHumanSummary = (data: StockTokensData): string => [
  "Official Stock Tokens", `Catalog observed: ${data.snapshot.sourceObservedAt}`,
  "Catalog membership does not establish a USDG pool or a current price.",
  ...data.members.map((member) => `${member.sourceSymbol ?? "Symbol unavailable"} — ${member.sourceName ?? "Name unavailable"} — ${member.contractAddress}`),
].join("\n");
