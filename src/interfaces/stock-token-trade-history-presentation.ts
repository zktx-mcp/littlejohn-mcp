import {
  stockTokenTradeHistoryChartWindowDefinitions,
  type StockTokenTradeCoverageLimitation,
} from "../stock-token-trade-history/stock-token-trade-history-data.js";
import type {
  StockTokenTradeHistoryResult,
} from "../stock-token-trade-history/stock-token-trade-history.js";

type UnavailableReason = Extract<
  StockTokenTradeHistoryResult,
  { readonly status: "unavailable" }
>["reason"];

const unavailableReasonText = Object.freeze({
  official_asset_not_found: "No current official Stock Token has that symbol.",
  official_asset_symbol_ambiguous: "More than one current official Stock Token has that symbol.",
  stock_factory_unavailable: "StockFactory did not verify this Stock Token at the result block.",
  asset_not_supported: "Trade history is not collected for this Stock Token.",
  trade_history_unavailable: "Trade history is temporarily unavailable.",
  trade_history_inconsistent: "Trade history failed integrity validation.",
  outside_published_coverage: "The requested period is outside the published trade history.",
} satisfies Readonly<Record<UnavailableReason, string>>);

const coverageLimitationText = Object.freeze({
  before_published_coverage: "Published trade history starts after the requested period began.",
  after_published_coverage: "Published trade history ends before the requested period ended.",
} satisfies Readonly<Record<StockTokenTradeCoverageLimitation, string>>);

type TradeHistoryWindow = StockTokenTradeHistoryResult["window"];

const windowText = Object.freeze({
  "1d": "1 day",
  "7d": "7 days",
  "30d": "30 days",
} satisfies Readonly<Record<TradeHistoryWindow, string>>);

type AvailableTradeHistory = Extract<
  StockTokenTradeHistoryResult,
  { readonly status: "available" }
>;

export const stockTokenTradeHistoryLabel = (result: StockTokenTradeHistoryResult): string => {
  const sourceName = "officialAsset" in result
    ? result.officialAsset.member.sourceName
    : undefined;
  return sourceName === undefined || sourceName === result.symbol
    ? result.symbol
    : `${sourceName} · ${result.symbol}`;
};

export const stockTokenTradeHistoryUnavailableReasonLabel = (
  reason: UnavailableReason,
): string => unavailableReasonText[reason];

export const stockTokenTradeHistoryWindowLabel = (
  window: TradeHistoryWindow,
): string => windowText[window];

export const stockTokenTradeHistoryChartIntervalLabel = (
  window: TradeHistoryWindow,
): string => {
  const minutes = stockTokenTradeHistoryChartWindowDefinitions[window].intervalMilliseconds / 60_000;
  return minutes % 60 === 0 ? `${minutes / 60}-hour` : `${minutes}-minute`;
};

export const stockTokenTradeCoverageLimitationLabel = (
  limitation: StockTokenTradeCoverageLimitation,
): string => coverageLimitationText[limitation];

export const stockTokenTradeHistoryNoTradeLabel = (
  result: AvailableTradeHistory,
): string | undefined => {
  if (result.chart.positions.some((position) => position.candle !== null)) return undefined;
  return result.chart.positions.every((position) => position.coverage === "complete")
    ? "No qualifying Stock Token/USDG trade occurred in the requested period."
    : "No qualifying Stock Token/USDG trade was observed in the available coverage.";
};
