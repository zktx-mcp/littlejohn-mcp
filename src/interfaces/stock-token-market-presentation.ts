import type {
  StockTokenExecutionCoverageLimitation,
  StockTokenExecutionDetailLimitation,
  StockTokenExecutionIndexUnavailableReason,
} from "../market-portfolio/stock-token-execution-index.js";
import type {
  StockTokenMarketResult,
  StockTokenReferenceResult,
} from "../market-portfolio/stock-token-market.js";

type StockTokenMarketUnavailableReason = Extract<
  StockTokenMarketResult,
  { readonly status: "unavailable" }
>["reason"];

const stockTokenMarketUnavailableReasonText = Object.freeze({
  official_asset_not_found: "No current official Stock Token has that symbol.",
  official_asset_symbol_ambiguous: "More than one current official Stock Token has that symbol.",
  stock_factory_unavailable: "StockFactory did not verify this Stock Token at the result block.",
} satisfies Readonly<Record<StockTokenMarketUnavailableReason, string>>);

type StockTokenReferenceUnavailableReason = Extract<
  StockTokenReferenceResult,
  { readonly status: "unavailable" }
>["reason"];

const stockTokenReferenceUnavailableReasonText = Object.freeze({
  mapping_unavailable: "The admitted catalog has no reference feed for this Stock Token.",
  mapping_catalog_outdated: "The current official asset does not match the admitted catalog.",
  no_valid_observation: "No valid USD-denominated oracle reference observation was available.",
  chain_response_unavailable: "The oracle reference chain response was unavailable.",
  rate_limited: "The USD-denominated oracle reference request was rate-limited.",
  source_unavailable: "The oracle reference source was unavailable.",
  source_inconsistent: "The oracle reference source response was inconsistent.",
  runtime_busy: "Local capacity for the oracle reference result is busy.",
} satisfies Readonly<Record<StockTokenReferenceUnavailableReason, string>>);

const stockTokenExecutionUnavailableReasonText = Object.freeze({
  asset_not_indexed: "Executed-trade history is not collected for this Stock Token.",
  index_unavailable: "Executed-trade history is temporarily unavailable.",
  index_inconsistent: "Executed-trade history failed integrity validation.",
  outside_published_coverage: "The requested period is outside the published execution history.",
} satisfies Readonly<Record<StockTokenExecutionIndexUnavailableReason, string>>);

const stockTokenExecutionCoverageLimitationText = Object.freeze({
  before_published_coverage: "Published execution history starts after the requested period began.",
  after_published_coverage: "Published execution history ends before the requested period ended.",
} satisfies Readonly<Record<StockTokenExecutionCoverageLimitation, string>>);

const stockTokenExecutionDetailLimitationText = Object.freeze({
  candle_capacity: "Only the most recent exact execution candles fit in this result.",
} satisfies Readonly<Record<StockTokenExecutionDetailLimitation, string>>);

export const stockTokenMarketLabel = (result: StockTokenMarketResult): string => {
  const sourceName = "officialAsset" in result
    ? result.officialAsset.member.sourceName
    : undefined;
  return sourceName === undefined || sourceName === result.symbol
    ? result.symbol
    : `${sourceName} · ${result.symbol}`;
};

export const stockTokenMarketUnavailableReasonLabel = (
  reason: StockTokenMarketUnavailableReason,
): string => stockTokenMarketUnavailableReasonText[reason];

export const stockTokenReferenceUnavailableReasonLabel = (
  reason: StockTokenReferenceUnavailableReason,
): string => stockTokenReferenceUnavailableReasonText[reason];

export const stockTokenExecutionUnavailableReasonLabel = (
  reason: StockTokenExecutionIndexUnavailableReason,
): string => stockTokenExecutionUnavailableReasonText[reason];

export const stockTokenExecutionCoverageLimitationLabel = (
  limitation: StockTokenExecutionCoverageLimitation,
): string => stockTokenExecutionCoverageLimitationText[limitation];

export const stockTokenExecutionDetailLimitationLabel = (
  limitation: StockTokenExecutionDetailLimitation,
): string => stockTokenExecutionDetailLimitationText[limitation];
