import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import type {
  ExactRational,
  ReferenceCandle,
  ReferenceHistorySuccess,
  ReferencePairManifestEntry,
} from "../../core/browser.js";
import {
  compareExactRationals,
  referenceHistoryWindowDefinitions,
} from "../../core/browser.js";
import {
  referenceHistoryLimitationLabel,
  referenceHistoryStatusLabel,
  referenceHistoryUnavailableReasonLabel,
  referenceWarningLabel,
} from "./human-labels.js";
import {
  humanFailureText,
  type HumanFailurePresentation,
} from "./human-failures.js";
import { formatUtcTimestamp } from "./human-time.js";
import { RationalValue } from "./rational-value.js";
import { referencePairQuoteUnit } from "./reference-price-presentation.js";
import type {
  ReferenceChartEntry,
  ReferenceChartHandle,
  ReferenceChartPort,
} from "./reference-chart.js";
import { parseReferenceChartEntries } from "./reference-chart.js";
import { StatusIndicator } from "./status-indicator.js";

const timestampSecond = (timestamp: string): number | undefined => {
  const milliseconds = Date.parse(timestamp);
  if (!Number.isInteger(milliseconds) || milliseconds % 1_000 !== 0) return undefined;
  const second = milliseconds / 1_000;
  return Number.isInteger(second) && new Date(second * 1_000).toISOString() === timestamp
    ? second
    : undefined;
};

const finiteRationalProjection = (value: ExactRational): number | undefined => {
  const numerator = BigInt(value.numerator);
  const denominator = BigInt(value.denominator);
  const numeratorDigits = value.numerator.length;
  const denominatorDigits = value.denominator.length;
  let exponent = numeratorDigits - denominatorDigits;
  if (exponent >= 0) {
    if (numerator < denominator * 10n ** BigInt(exponent)) exponent -= 1;
  } else if (numerator * 10n ** BigInt(-exponent) < denominator) {
    exponent -= 1;
  }
  const significantDigits = 17;
  const shift = significantDigits - 1 - exponent;
  const coefficient = shift >= 0
    ? numerator * 10n ** BigInt(shift) / denominator
    : numerator / (denominator * 10n ** BigInt(-shift));
  const digits = coefficient.toString(10).padStart(significantDigits, "0");
  const projected = Number(`${digits.charAt(0)}.${digits.slice(1)}e${exponent}`);
  return Number.isFinite(projected) ? projected : undefined;
};

export type ReferenceHistoryChartProjection =
  | Readonly<{ status: "unavailable" }>
  | Readonly<{
      status: "available";
      entries: readonly ReferenceChartEntry[];
      entryTimes: readonly number[];
      candleTimes: readonly number[];
    }>;

export const projectReferenceHistoryChart = (
  result: ReferenceHistorySuccess,
): ReferenceHistoryChartProjection => {
  if (result.candles.length === 0) {
    return Object.freeze({ status: "unavailable" });
  }
  const emptyBuckets = result.coverage.emptyBucketStarts.map((timestamp) =>
    Object.freeze({ timestamp, time: timestampSecond(timestamp) }));
  if (emptyBuckets.some((bucket) => bucket.time === undefined)) {
    return Object.freeze({ status: "unavailable" });
  }
  emptyBuckets.sort((left, right) => left.time! - right.time!);
  const entries: ReferenceChartEntry[] = [];
  const candleTimes: number[] = [];
  let candleIndex = 0;
  let emptyIndex = 0;
  let previousTime: number | undefined;
  while (
    candleIndex < result.candles.length ||
    emptyIndex < emptyBuckets.length
  ) {
    const candle = result.candles.at(candleIndex);
    const emptyBucket = emptyBuckets.at(emptyIndex);
    const candleTime = candle === undefined ? undefined : timestampSecond(candle.openedAt);
    const emptyTime = emptyBucket?.time;
    if (
      candleTime === undefined && candle !== undefined ||
      emptyTime === undefined && emptyBucket !== undefined
    ) return Object.freeze({ status: "unavailable" });
    const useCandle = candleTime !== undefined &&
      (emptyTime === undefined || candleTime < emptyTime);
    const time = useCandle ? candleTime : emptyTime;
    if (time === undefined || (previousTime !== undefined && time <= previousTime)) {
      return Object.freeze({ status: "unavailable" });
    }
    previousTime = time;
    if (useCandle) {
      const projectedOpen = finiteRationalProjection(candle!.open);
      const high = finiteRationalProjection(candle!.high);
      const low = finiteRationalProjection(candle!.low);
      const close = finiteRationalProjection(candle!.close);
      if (
        projectedOpen === undefined ||
        high === undefined ||
        low === undefined ||
        close === undefined
      ) return Object.freeze({ status: "unavailable" });
      entries.push({
        kind: "candlestick",
        time,
        open: projectedOpen,
        high,
        low,
        close,
      });
      candleTimes.push(time);
      candleIndex += 1;
    } else {
      entries.push({ kind: "whitespace", time });
      emptyIndex += 1;
    }
  }
  try {
    return Object.freeze({
      status: "available",
      entries: parseReferenceChartEntries(entries),
      entryTimes: Object.freeze(entries.map((entry) => entry.time)),
      candleTimes: Object.freeze(candleTimes),
    });
  } catch {
    return Object.freeze({ status: "unavailable" });
  }
};

export type ReferenceChartSelectionAction =
  | Readonly<{ kind: "replace" }>
  | Readonly<{ kind: "left" }>
  | Readonly<{ kind: "right" }>
  | Readonly<{ kind: "first" }>
  | Readonly<{ kind: "last" }>
  | Readonly<{
      kind: "chart_time";
      time?: number;
      admittedEntryTimes: readonly number[];
    }>;

export const selectReferenceChartTime = (
  entryTimes: readonly number[],
  selectedTime: number | undefined,
  action: ReferenceChartSelectionAction,
): number | undefined => {
  if (entryTimes.length === 0) return undefined;
  if (action.kind === "replace") return entryTimes.at(-1);
  if (action.kind === "chart_time") {
    return action.time !== undefined && action.admittedEntryTimes.includes(action.time)
      ? action.time
      : selectedTime;
  }
  if (action.kind === "first") return entryTimes.at(0);
  if (action.kind === "last") return entryTimes.at(-1);
  const selectedIndex = selectedTime === undefined
    ? -1
    : entryTimes.indexOf(selectedTime);
  if (selectedIndex < 0) return entryTimes.at(-1);
  return action.kind === "left"
    ? entryTimes.at(Math.max(0, selectedIndex - 1))
    : entryTimes.at(Math.min(entryTimes.length - 1, selectedIndex + 1));
};

export interface ReferenceObservedRange {
  readonly high: ExactRational;
  readonly low: ExactRational;
}

export interface ReferenceHistorySelectionPresentation {
  readonly candle: ReferenceCandle | undefined;
  readonly emptyInterval: Readonly<{
    start: string;
    end: string;
  }> | undefined;
  readonly representedIntervals: number;
  readonly valueIntervals: number;
}

export const presentReferenceHistorySelection = (
  result: ReferenceHistorySuccess,
  selectedTime: number | undefined,
): ReferenceHistorySelectionPresentation => {
  const candle = result.candles.find((entry) =>
    timestampSecond(entry.openedAt) === selectedTime) ??
    (selectedTime === undefined ? result.candles.at(-1) : undefined);
  const emptyStart = result.coverage.emptyBucketStarts.find(
    (timestamp) => timestampSecond(timestamp) === selectedTime,
  );
  const emptyInterval = emptyStart === undefined
    ? undefined
    : Object.freeze({
        start: emptyStart,
        end: new Date(Math.min(
          Date.parse(emptyStart) +
            referenceHistoryWindowDefinitions[result.window].bucketMilliseconds,
          Date.parse(result.coverage.requestedEnd),
        )).toISOString(),
      });
  return Object.freeze({
    candle,
    emptyInterval,
    representedIntervals:
      result.candles.length + result.coverage.emptyBucketStarts.length,
    valueIntervals: result.candles.length,
  });
};

export const referenceObservedRange = (
  candles: readonly ReferenceCandle[],
): ReferenceObservedRange | undefined => {
  const first = candles.at(0);
  if (first === undefined) return undefined;
  let high = first.high;
  let low = first.low;
  for (const candle of candles.slice(1)) {
    if (compareExactRationals(candle.high, high) > 0) high = candle.high;
    if (compareExactRationals(candle.low, low) < 0) low = candle.low;
  }
  return Object.freeze({ high, low });
};

const candleValuesAreEqual = (candle: ReferenceCandle): boolean =>
  compareExactRationals(candle.open, candle.high) === 0 &&
  compareExactRationals(candle.open, candle.low) === 0 &&
  compareExactRationals(candle.open, candle.close) === 0;

export type ReferenceChartPresentationStatus =
  "idle" | "loading" | "mounted" | "unavailable";

export interface ReferenceChartMountController {
  replace(
    container: HTMLElement,
    entries: readonly ReferenceChartEntry[],
    onSelectedTime: (time: number) => void,
  ): void;
  destroy(): void;
}

export const createReferenceChartMountController = (
  port: ReferenceChartPort,
  onStatus: (status: ReferenceChartPresentationStatus) => void,
): ReferenceChartMountController => {
  let generation = 0;
  let handle: ReferenceChartHandle | undefined;
  const destroy = (): void => {
    generation += 1;
    handle?.destroy();
    handle = undefined;
    onStatus("idle");
  };
  return Object.freeze({
    replace(
      container: HTMLElement,
      entries: readonly ReferenceChartEntry[],
      onSelectedTime: (time: number) => void,
    ): void {
      destroy();
      const activeGeneration = generation;
      onStatus("loading");
      let mountResult: Promise<
        Awaited<ReturnType<ReferenceChartPort["mount"]>>
      >;
      try {
        mountResult = port.mount(container, entries, (time) => {
          if (generation === activeGeneration) onSelectedTime(time);
        });
      } catch {
        onStatus("unavailable");
        return;
      }
      void mountResult.then(
        (result) => {
          if (generation !== activeGeneration) {
            if (result.status === "mounted") result.handle.destroy();
            return;
          }
          if (result.status === "unavailable") {
            onStatus("unavailable");
            return;
          }
          handle = result.handle;
          onStatus("mounted");
        },
        () => {
          if (generation === activeGeneration) onStatus("unavailable");
        },
      );
    },
    destroy,
  });
};

export interface ReferenceMarketChartProps {
  readonly chartPort: ReferenceChartPort;
  readonly historyState:
    | Readonly<{ status: "loading" }>
    | Readonly<{ status: "available"; value: ReferenceHistorySuccess }>
    | Readonly<{ status: "error"; failure: HumanFailurePresentation }>;
  readonly selectedPair: ReferencePairManifestEntry;
  readonly onRetry?: () => void;
}

export const ReferenceMarketChart = ({
  chartPort,
  historyState,
  selectedPair,
  onRetry,
}: ReferenceMarketChartProps) => {
  const container = useRef<HTMLDivElement>(null);
  const [selectedTime, setSelectedTime] = useState<number>();
  const [chartStatus, setChartStatus] =
    useState<ReferenceChartPresentationStatus>("idle");
  const [mountController] = useState(() =>
    createReferenceChartMountController(chartPort, setChartStatus));
  const projection = useMemo(
    () => historyState.status === "available"
      ? projectReferenceHistoryChart(historyState.value)
      : Object.freeze({ status: "unavailable" as const }),
    [historyState],
  );

  useEffect(() => {
    setSelectedTime(projection.status === "available"
      ? selectReferenceChartTime(projection.entryTimes, undefined, { kind: "replace" })
      : undefined);
  }, [projection]);

  useEffect(() => {
    if (projection.status !== "available" || container.current === null) {
      mountController.destroy();
      return;
    }
    mountController.replace(container.current, projection.entries, (time) => {
      setSelectedTime((current) =>
        selectReferenceChartTime(projection.entryTimes, current, {
          kind: "chart_time",
          time,
          admittedEntryTimes: projection.entryTimes,
        }));
    });
    return () => { mountController.destroy(); };
  }, [mountController, projection]);

  const availableHistory = historyState.status === "available" ? historyState.value : undefined;
  const quoteUnit = referencePairQuoteUnit(selectedPair);
  const historyPresentation = availableHistory === undefined
    ? undefined
    : presentReferenceHistorySelection(availableHistory, selectedTime);
  const selectedCandle = historyPresentation?.candle;
  const selectedEmptyInterval = historyPresentation?.emptyInterval;
  const entryTimes = projection.status === "available" ? projection.entryTimes : [];
  const interactive = projection.status === "available" &&
    projection.entryTimes.length >= 2;
  const chartAvailable = projection.status === "available" &&
    (availableHistory?.candles.length ?? 0) >= 2;
  const observedRange = availableHistory === undefined
    ? undefined
    : referenceObservedRange(availableHistory.candles);
  const observedRangeIsEqual = observedRange !== undefined &&
    compareExactRationals(observedRange.high, observedRange.low) === 0;
  const historyLabel = availableHistory === undefined
    ? "Reference price history"
    : `${availableHistory.window} reference price history`;
  const selectFromKeyboard = (
    action: Extract<
      ReferenceChartSelectionAction,
      { readonly kind: "left" | "right" | "first" | "last" }
    >,
  ): void => {
    setSelectedTime((current) =>
      selectReferenceChartTime(entryTimes, current, action));
  };
  const handleKeyboardSelection = (
    event: KeyboardEvent<HTMLElement>,
  ): void => {
    if (event.currentTarget !== event.target) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      selectFromKeyboard({ kind: "left" });
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      selectFromKeyboard({ kind: "right" });
    } else if (event.key === "Home") {
      event.preventDefault();
      selectFromKeyboard({ kind: "first" });
    } else if (event.key === "End") {
      event.preventDefault();
      selectFromKeyboard({ kind: "last" });
    }
  };
  return (
    <section
      className="market-chart"
      aria-label={historyLabel}
      aria-keyshortcuts={interactive
        ? "ArrowLeft ArrowRight Home End"
        : undefined}
      aria-describedby={availableHistory === undefined
        ? undefined
        : `reference-chart-summary reference-chart-legend${
          interactive ? " reference-chart-instructions" : ""
        }`}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={interactive ? handleKeyboardSelection : undefined}
    >
      <div className="chart-heading">
        <div>
          <h2>Price history</h2>
          <p className="muted">{historyLabel}</p>
        </div>
        {availableHistory === undefined ? null : (
          <StatusIndicator
            tone={availableHistory.status === "partial" ? "partial" : "unavailable"}
            label={referenceHistoryStatusLabel(availableHistory.status)}
          />
        )}
      </div>
      {historyState.status === "loading" ? <p>Loading reference history…</p> : null}
      {historyState.status === "error" ? (
        <div className="error" role="alert">
          <p>{humanFailureText(historyState.failure)}</p>
          {historyState.failure.retryable && onRetry !== undefined ? (
            <button type="button" className="secondary" onClick={onRetry}>
              Retry
            </button>
          ) : null}
        </div>
      ) : null}
      {availableHistory !== undefined && availableHistory.candles.length === 0 ? (
        <p>{availableHistory.status === "unavailable"
          ? referenceHistoryUnavailableReasonLabel(availableHistory.reason)
          : "No reference value is available for this window."}</p>
      ) : null}
      {availableHistory !== undefined ? (
        <>
          <div id="reference-chart-summary" className="chart-window-summary">
            {observedRange === undefined ? null : observedRangeIsEqual ? (
              <dl>
                <dt>Observed range</dt>
                <dd>
                  <RationalValue
                    value={observedRange.high}
                    prefix={quoteUnit.prefix}
                    suffix={quoteUnit.suffix}
                  />
                </dd>
              </dl>
            ) : observedRange === undefined ? null : (
              <>
                <dl>
                  <dt>Observed high</dt>
                  <dd>
                    <RationalValue
                      value={observedRange.high}
                      prefix={quoteUnit.prefix}
                      suffix={quoteUnit.suffix}
                    />
                  </dd>
                </dl>
                <dl>
                  <dt>Observed low</dt>
                  <dd>
                    <RationalValue
                      value={observedRange.low}
                      prefix={quoteUnit.prefix}
                      suffix={quoteUnit.suffix}
                    />
                  </dd>
                </dl>
              </>
            )}
            <p>
              {historyPresentation?.valueIntervals ?? 0} of{" "}
              {historyPresentation?.representedIntervals ?? 0} chart{" "}
              {historyPresentation?.representedIntervals === 1
                ? "interval contains"
                : "intervals contain"}{" "}
              reference values.
            </p>
          </div>
          {chartAvailable ? (
            <>
              <div
                ref={container}
                className="reference-chart-canvas"
                aria-hidden="true"
              />
              {chartStatus === "loading" ? <p>Loading visual chart…</p> : null}
              {chartStatus === "unavailable" ? (
                <p className="notice">
                  The visual chart is unavailable. The exact observed range and
                  selected value remain available.
                </p>
              ) : null}
              <p className="chart-attribution">
                <a
                  href="https://www.tradingview.com/"
                  target="_blank"
                  rel="noopener noreferrer"
                >Charting by TradingView</a>
              </p>
            </>
          ) : availableHistory.candles.length === 1 ? (
            <p className="notice">
              One reference value is available. A trend is not shown.
            </p>
          ) : availableHistory.candles.length >= 2 ? (
            <p className="notice">
              The visual chart is unavailable for this history.
            </p>
          ) : null}
          <div
            id="reference-chart-legend"
            className="chart-legend"
            aria-live="polite"
          >
            {selectedCandle !== undefined ? (
              <>
              <h3>Selected interval</h3>
              <p>
                {formatUtcTimestamp(selectedCandle.openedAt)} to{" "}
                {formatUtcTimestamp(selectedCandle.closedAt)}
              </p>
              <p>
                {selectedCandle.openBucket ? "Open bucket" : "Closed bucket"}
              </p>
              {candleValuesAreEqual(selectedCandle) ? (
                <div className="selected-candle-values flat">
                  <dl>
                    <dt>Price</dt>
                    <dd>
                      <RationalValue
                        value={selectedCandle.open}
                        prefix={quoteUnit.prefix}
                        suffix={quoteUnit.suffix}
                      />
                    </dd>
                  </dl>
                  <p>The values in this interval are equal.</p>
                </div>
              ) : (
                <div className="selected-candle-values">
                  {([
                    ["Open", selectedCandle.open],
                    ["High", selectedCandle.high],
                    ["Low", selectedCandle.low],
                    ["Close", selectedCandle.close],
                  ] as const).map(([label, value]) => (
                    <dl key={label}>
                      <dt>{label}</dt>
                      <dd>
                        <RationalValue
                          value={value}
                          prefix={quoteUnit.prefix}
                          suffix={quoteUnit.suffix}
                        />
                      </dd>
                    </dl>
                  ))}
                </div>
              )}
              {selectedCandle.openBucket ? (
                <p>
                  This interval is still open at the latest block in this result
                  and may change in a later reading.
                </p>
              ) : null}
              </>
            ) : selectedEmptyInterval !== undefined ? (
              <>
                <h3>Selected interval</h3>
                <p>
                  {formatUtcTimestamp(selectedEmptyInterval.start)} to{" "}
                  {formatUtcTimestamp(selectedEmptyInterval.end)}
                </p>
                <p>No reference value in this interval.</p>
              </>
            ) : null}
          </div>
          {interactive ? (
            <p id="reference-chart-instructions" className="muted">
              Use Left and Right Arrow keys to inspect adjacent intervals.
              Use Home and End to inspect the first or last interval.
            </p>
          ) : null}
          <section
            className="history-interpretation"
            aria-labelledby="history-interpretation-heading"
          >
            <h3 id="history-interpretation-heading">History limitations</h3>
            <ul>
              {availableHistory.warnings
                .filter((warning) =>
                  warning === "no_trade_volume" || warning === "partial_history")
                .map((warning) => (
                  <li key={warning}>{referenceWarningLabel(warning)}</li>
                ))}
              {availableHistory.coverage.limitations.map((limitation) => (
                <li key={limitation}>
                  {referenceHistoryLimitationLabel(limitation)}
                </li>
              ))}
            </ul>
          </section>
        </>
      ) : null}
    </section>
  );
};
