import { presentationCopy as copy, readReasonCopy } from "./presentation-copy.js";
import {formatAmount} from "../evm/amounts.js";
import {formatRationalForDisplay} from "../evm/numeric-display.js";
import {productUsdgAsset} from "../registry/client.js";
import type { PricedPool, StockTokenPricesData, StockTokensData } from "../stock-token-prices/result.js";
import type { PoolPriceReadReason } from "../protocols/pool-price-contract.js";

const reasonLabels: Record<PoolPriceReadReason, string> = readReasonCopy;

export const poolPriceStatusText = (row: PricedPool): string => row.status === "verified" ? "Verified pool price"
  : row.status === "unsupported" ? readReasonCopy.unsupportedPool
    : reasonLabels[row.reason];
export const poolPriceValueText = (row: PricedPool): string => {
  if (row.status !== "verified") return copy.label.unavailable;
  const display = formatRationalForDisplay(row.price);
  return `${display.relation === "approximately" ? "≈ " : ""}${display.coefficient}${display.notation === "scientific" ? `e${display.exponent >= 0 ? "+" : ""}${display.exponent}` : ""} USDG`;
};
const percent = (millionths: string) => `${formatAmount(millionths, "4")}%`;
export const poolPriceFeeText = (row: PricedPool): string => {
  if (row.status !== "verified") return copy.label.unavailable;
  const state = row.state;
  if (state.protocol !== "uniswap_v4") return percent(state.swapFeeMillionths);
  const protocol = state.token0 !== productUsdgAsset.address ?
    [state.protocolFee0To1Millionths, state.protocolFee1To0Millionths] :
    [state.protocolFee1To0Millionths, state.protocolFee0To1Millionths];
  return `Observed LP fee: ${percent(state.lpFeeMillionths)}${state.dynamicFee ? " (dynamic)" : ""}; ` +
    `protocol fee Stock Token→USDG: ${percent(protocol[0]!)}; USDG→Stock Token: ${percent(protocol[1]!)}`;
};
export const stockTokenPriceLimitations = Object.freeze([copy.scope.prices, copy.scope.pools]);
export const stockTokenPriceUnavailableText = (data: Exclude<StockTokenPricesData, { status: "available" }>): string => readReasonCopy[data.reason === "official_asset_ambiguous" ? "official_asset_symbol_ambiguous" : data.reason];
export const stockTokenPricesHumanSummary = (data: StockTokenPricesData): string => {
  if (data.status !== "available") return [copy.title.prices, stockTokenPriceUnavailableText(data),
    ...(data.status === "selection_unavailable" ? data.candidates.map((member) => `${member.sourceSymbol ?? member.sourceName ?? "Official token"}: ${member.contractAddress}`) : [])].join("\n");
  return [
    `${copy.title.prices}: ${data.member.sourceSymbol ?? data.member.contractAddress}`,
    `${copy.label.block}: ${data.block.blockNumber}`, `${copy.label.asOf}: ${data.block.blockTimestamp}`,
    `${copy.label.source}: ${data.source.sourceOwner}`,
    ...stockTokenPriceLimitations,
    ...(data.pools.length === 0 ? [copy.scope.empty] : data.pools.flatMap((row) => [
      `${row.candidate.protocol ?? row.candidate.sourceDexId} — ${row.candidate.poolId}`,
      `${copy.label.price}: ${poolPriceValueText(row)}; ${poolPriceStatusText(row)}`, `${copy.label.poolFee}: ${poolPriceFeeText(row)}`,
      ...(row.status === "verified" && row.state.protocol === "uniswap_v4" && row.state.dynamicFee
        ? [copy.scope.dynamicFee] : []),
    ])),
  ].join("\n");
};
export const stockTokensHumanSummary = (data: StockTokensData): string => [
  copy.title.stockTokens, `${copy.label.asOf}: ${data.snapshot.sourceObservedAt}`,
  copy.scope.officialListing,
  ...data.members.map((member) => `${member.sourceSymbol ?? "Symbol unavailable"} — ${member.sourceName ?? "Name unavailable"} — ${member.contractAddress}`),
].join("\n");
