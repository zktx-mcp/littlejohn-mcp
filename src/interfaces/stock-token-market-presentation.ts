import type {
  StockTokenExecutionCoverageLimitation,
  StockTokenExecutionIndexUnavailableReason,
} from "../market-portfolio/stock-token-execution-index.js";
import type { StockTokenMarketResult } from "../market-portfolio/stock-token-market.js";

type StockTokenMarketUnavailableReason = Extract<
  StockTokenMarketResult,
  { readonly status: "unavailable" }
>["reason"];

const stockTokenMarketUnavailableReasonText = Object.freeze({
  official_asset_not_found: "No current official Stock Token has that symbol.",
  official_asset_symbol_ambiguous: "More than one current official Stock Token has that symbol.",
  mapping_unavailable: "The admitted catalog has no reference feed for this Stock Token.",
  mapping_catalog_outdated: "The current official asset does not match the admitted catalog.",
  stock_factory_unavailable: "StockFactory did not verify this Stock Token at the result block.",
  market_observation_unavailable: "No valid reference-market observation was available.",
} satisfies Readonly<Record<StockTokenMarketUnavailableReason, string>>);

const stockTokenExecutionUnavailableReasonText = Object.freeze({
  asset_not_indexed: "Executed-trade history is not collected for this Stock Token.",
  index_unavailable: "Executed-trade history is temporarily unavailable.",
  index_inconsistent: "Executed-trade history failed integrity validation.",
  outside_published_coverage: "The requested period is outside the published execution history.",
} satisfies Readonly<Record<StockTokenExecutionIndexUnavailableReason, string>>);

const stockTokenExecutionLimitationText = Object.freeze({
  before_published_coverage: "Published execution history starts after the requested period began.",
  after_published_coverage: "Published execution history ends before the requested period ended.",
  stale_index: "The published execution history is not current.",
  candle_capacity: "Only the most recent exact execution candles fit in this result.",
} satisfies Readonly<Record<StockTokenExecutionCoverageLimitation, string>>);

export const stockTokenMarketUnavailableReasonLabel = (
  reason: StockTokenMarketUnavailableReason,
): string => stockTokenMarketUnavailableReasonText[reason];

export const stockTokenExecutionUnavailableReasonLabel = (
  reason: StockTokenExecutionIndexUnavailableReason,
): string => stockTokenExecutionUnavailableReasonText[reason];

export const stockTokenExecutionLimitationLabel = (
  limitation: StockTokenExecutionCoverageLimitation,
): string => stockTokenExecutionLimitationText[limitation];
