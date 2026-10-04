import type {StockTokenTradeHistoryPeriod} from "../stock-token-trade-history/period-contract.js";
import type {StockTokenTradeHistoryData} from "../stock-token-trade-history/result.js";
import type {StockTokenTradeHistorySourceReason} from "../stock-token-trade-history/source-semantics.js";

type PreArchiveUnavailable = Extract<
  StockTokenTradeHistoryData,
  { readonly reason: string }
>;
export type StockTokenTradeHistoryUnavailableReason =
  | PreArchiveUnavailable["reason"]
  | StockTokenTradeHistorySourceReason;

const unavailableReasonText = Object.freeze({
  official_asset_not_found: "No current official Stock Token has that symbol.",
  official_asset_symbol_ambiguous: "More than one current official Stock Token has that symbol.",
  stock_factory_unavailable: "StockFactory did not verify this Stock Token at the result block.",
  token_decimals_unavailable: "The Stock Token decimals call reverted at the result block.",
  asset_not_supported: "The published trade-history archive does not contain this Stock Token.",
  trade_history_unavailable: "Trade history is temporarily unavailable.",
  trade_history_inconsistent: "Trade history failed integrity validation.",
  trade_history_too_large: "Trade history exceeds the admitted product capacity.",
  outside_published_coverage: "The requested period is outside the published trade history.",
} satisfies Readonly<Record<StockTokenTradeHistoryUnavailableReason, string>>);

const coverageLimitationText = Object.freeze({
  before_published_coverage: "Published trade history starts after the requested period began.",
  after_published_coverage: "Published trade history ends before the requested period ended.",
} as const);

type AvailableTradeHistory = Extract<
  StockTokenTradeHistoryData,
  { readonly status: "available" }
>;

export const stockTokenTradeHistoryLabel = (result: StockTokenTradeHistoryData): string => {
  const sourceName = "officialAsset" in result
    ? result.officialAsset.member.sourceName
    : undefined;
  return sourceName === undefined || sourceName === null || sourceName === result.symbol
    ? result.symbol
    : `${sourceName} · ${result.symbol}`;
};

export const stockTokenTradeHistoryUnavailableReason = (
  result: Extract<StockTokenTradeHistoryData, { readonly status: "unavailable" }>,
): StockTokenTradeHistoryUnavailableReason => "reason" in result
  ? result.reason
  : result.archive.reason;

export const stockTokenTradeHistoryUnavailableReasonLabel = (
  reason: StockTokenTradeHistoryUnavailableReason,
): string => unavailableReasonText[reason];

export const stockTokenTradeHistoryPeriodLabel = (
  period: StockTokenTradeHistoryPeriod,
): string => `${period.count} ${period.unit}${period.count === 1 ? "" : "s"}`;

export const stockTokenTradeHistoryResolutionLabel = (
  intervalSeconds: number,
): string => intervalSeconds % 86_400 === 0
  ? `${intervalSeconds / 86_400}-day`
  : intervalSeconds % 3_600 === 0
    ? `${intervalSeconds / 3_600}-hour`
    : `${intervalSeconds / 60}-minute`;

export const stockTokenTradeCoverageLimitationLabel = (
  limitation: keyof typeof coverageLimitationText,
): string => coverageLimitationText[limitation];

export const stockTokenTradeHistoryNoTradeLabel = (
  result: AvailableTradeHistory,
): string | undefined => {
  if (result.positions.some((position) => position.candle !== null)) return undefined;
  return result.positions.every((position) => position.coverage === "complete")
    ? "No qualifying Stock Token/USDG trade occurred in the requested period."
    : "Trade absence is not established for every requested position.";
};

export const stockTokenTradeHistoryRequestedCoverageLabel = (
  result: AvailableTradeHistory,
): string => `${result.coverage.fromTimestamp} to ${result.coverage.untilTimestamp}`;

export const stockTokenTradeHistoryRequestCutCandleWarning = (
  result: AvailableTradeHistory,
): string | undefined => result.positions.some((position) =>
  position.coverage === "partial" && position.candle !== null)
  ? "A partial candle is the unchanged full stored natural interval and may include activity outside its represented request bounds."
  : undefined;

export const stockTokenTradeHistoryHumanSummary = (
  result: StockTokenTradeHistoryData,
): string => {
  const lines = [
    "Stock Token trade history",
    `Token: ${stockTokenTradeHistoryLabel(result)}`,
    `Requested period: ${stockTokenTradeHistoryPeriodLabel(result.period)}`,
  ];
  if (result.status === "unavailable") {
    lines.push(
      "Status: Unavailable",
      `Reason: ${stockTokenTradeHistoryUnavailableReasonLabel(
        stockTokenTradeHistoryUnavailableReason(result),
      )}`,
    );
    if ("archive" in result) {
      lines.push(
        `Freshness: ${result.freshness === "unknown"
          ? "Unknown"
          : result.freshness === "current" ? "Current" : "Stale"}`,
        `Reached scope: ${result.archive.scope}`,
      );
      if (result.archive.scope !== "catalog_root") {
        lines.push(`Published through: ${result.archive.root.currentUntil.timestamp}`);
      }
    }
    return lines.join("\n");
  }
  lines.push(
    "Status: Available",
    `Requested range: ${result.requestedStart} to ${result.requestedEnd}`,
    `Freshness: ${result.freshness === "current" ? "Current" : "Stale"}`,
    `Published through: ${result.archive.root.currentUntil.timestamp}`,
    `Coverage: ${result.coverage.status === "complete" ? "Complete" : "Partial"}`,
    `Requested coverage: ${stockTokenTradeHistoryRequestedCoverageLabel(result)}`,
    `Resolution: ${result.resolution.label} (${stockTokenTradeHistoryResolutionLabel(
      result.resolution.intervalSeconds,
    )})`,
    ...result.coverage.limitations.map((limitation) =>
      `Limitation: ${stockTokenTradeCoverageLimitationLabel(limitation)}`),
  );
  const requestCutWarning = stockTokenTradeHistoryRequestCutCandleWarning(result);
  if (requestCutWarning !== undefined) lines.push(`Warning: ${requestCutWarning}`);
  const latest = result.positions.findLast((position) => position.candle !== null)?.candle;
  if (latest === undefined || latest === null) {
    const noTrade = stockTokenTradeHistoryNoTradeLabel(result);
    if (noTrade === undefined) throw new TypeError("Trade-history result has no latest-candle meaning.");
    lines.push(noTrade);
  } else {
    lines.push(
      `Latest chart close: ${latest.close.numerator} / ${latest.close.denominator} USDG`,
      `Trades observed: ${latest.observedStart} to ${latest.observedEnd}`,
    );
  }
  return lines.join("\n");
};
