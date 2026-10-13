import { presentationCopy as copy, readReasonCopy, freshnessText, coverageText } from "./presentation-copy.js";
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

const unavailableReasonText = readReasonCopy;
const coverageLimitationText = { before_published_coverage: copy.chart.before, after_published_coverage: copy.chart.after } as const;

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
    ? copy.chart.allEmpty
    : copy.chart.allEmptyUnknown;
};

export const stockTokenTradeHistoryRequestedCoverageLabel = (
  result: AvailableTradeHistory,
): string => `${result.coverage.fromTimestamp} to ${result.coverage.untilTimestamp}`;

export const stockTokenTradeHistoryRequestCutCandleWarning = (
  result: AvailableTradeHistory,
): string | undefined => result.positions.some((position) =>
  position.coverage === "partial" && position.candle !== null)
  ? copy.chart.partialCandle
  : undefined;

export const stockTokenTradeHistoryHumanSummary = (
  result: StockTokenTradeHistoryData, evaluatedAt: string,
): string => {
  const lines = [
    copy.title.history,
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
        `${copy.label.freshness}: ${result.freshness === "unknown"
          ? "Unknown"
          : result.freshness === "current" ? "Current" : "Stale"}`,
        freshnessText(result.freshness, evaluatedAt),
        `Reached scope: ${result.archive.scope}`,
      );
      if (result.archive.scope !== "catalog_root") {
        lines.push(`Published through: ${result.archive.root.currentUntil.timestamp}`);
      }
    }
    return lines.join("\n");
  }
  lines.push(
    freshnessText(result.freshness, evaluatedAt),
    coverageText(result.coverage.status, true),
    `${copy.label.requestedPeriod}: ${result.requestedStart} to ${result.requestedEnd}`,
    `${copy.label.freshness}: ${result.freshness === "current" ? "Current" : "Stale"}`,
    `Published through: ${result.archive.root.currentUntil.timestamp}`,
    `${copy.label.coverage}: ${result.coverage.status === "complete" ? "Complete" : "Partial"}`,
    `${copy.label.availablePeriod}: ${stockTokenTradeHistoryRequestedCoverageLabel(result)}`,
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
