import {
  useEffect,
  useState,
  type MouseEvent,
} from "react";

import {
  findReferenceFeed,
  findReferencePair,
  type ReferenceHistorySuccess,
  type ReferenceMarketWarningCode,
  type ReferencePriceSuccess,
} from "../../core/browser.js";
import {
  browserLocationHref,
  browserLocations,
  type BrowserLocation,
} from "../browser-contract.js";
import {
  readReferenceHistory,
  readReferencePrice,
} from "./reference-market-client.js";
import { invalidBrowserResponse } from "./browser-client.js";
import {
  humanFailureText,
  presentBrowserRequestFailure,
  type HumanFailurePresentation,
} from "./human-failures.js";
import { createBrowserRequestAuthority } from "./request-authority.js";
import {
  referencePriceStatusLabel,
  referencePriceUnavailableReasonLabel,
  referenceWarningLabel,
} from "./human-labels.js";
import { formatUnixSecondsAsUtc } from "./human-time.js";
import {
  createAnalysisTarget,
  type AnalysisTarget,
} from "./analysis-dialog.js";
import { ContextualAnalysisAction } from "./contextual-analysis-action.js";
import { LoadingIndicator } from "./loading-indicator.js";
import { PageHeader } from "./page-header.js";
import { presentReferencePrice } from "./reference-price-presentation.js";
import { RationalValue } from "./rational-value.js";
import type { ReferenceChartPort } from "./reference-chart.js";
import { ReferenceMarketChart } from "./reference-market-chart.js";
import { StatusIndicator } from "./status-indicator.js";

type ReadState<Value> =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "available"; value: Value }>
  | Readonly<{ status: "error"; failure: HumanFailurePresentation }>;

type KeyedReadState<Value> =
  | Readonly<{ requestKey: string; status: "loading" }>
  | Readonly<{ requestKey: string; status: "available"; value: Value }>
  | Readonly<{
      requestKey: string;
      status: "error";
      failure: HumanFailurePresentation;
    }>;

type ReferencePriceLocation = Extract<
  BrowserLocation,
  { readonly page: "reference_price" }
>;

const historyWindows = Object.freeze([
  Object.freeze({ value: "1d" as const, label: "1 day" }),
  Object.freeze({ value: "7d" as const, label: "7 days" }),
  Object.freeze({ value: "30d" as const, label: "30 days" }),
]);

export interface ReferencePricePageProps {
  readonly chartPort: ReferenceChartPort;
  readonly pageLocation: ReferencePriceLocation;
  readonly onNavigate: (
    location: BrowserLocation,
    event: MouseEvent<HTMLAnchorElement>,
  ) => void;
  readonly onAnalyze: (
    target: AnalysisTarget,
    trigger: HTMLButtonElement,
  ) => void;
}

export const ReferencePairInterpretation = ({
  warnings,
}: {
  readonly warnings: readonly ReferenceMarketWarningCode[];
}) => {
  const shared = warnings.filter((warning) =>
    warning === "reference_price_not_trade_price" ||
    warning === "source_listing_not_revalidated" ||
    warning === "sequencer_status_unavailable");
  return shared.length === 0 ? null : (
    <section
      className="interpretation-note"
      aria-labelledby="reference-interpretation-heading"
    >
      <h2 id="reference-interpretation-heading">How to interpret this reference</h2>
      <ul>
        {shared.map((warning) => (
          <li key={warning}>{referenceWarningLabel(warning)}</li>
        ))}
      </ul>
    </section>
  );
};

export const ReferencePricePage = ({
  chartPort,
  pageLocation,
  onNavigate,
  onAnalyze,
}: ReferencePricePageProps) => {
  const pair = findReferencePair(pageLocation.pairId);
  const historyRequestKey = `${pair.pairId}:${pageLocation.window}`;
  const [priceRead, setPriceRead] = useState<KeyedReadState<ReferencePriceSuccess>>({
    requestKey: pair.pairId,
    status: "loading",
  });
  const [historyRead, setHistoryRead] = useState<KeyedReadState<ReferenceHistorySuccess>>({
    requestKey: historyRequestKey,
    status: "loading",
  });
  const [priceAuthority] = useState(createBrowserRequestAuthority);
  const [historyAuthority] = useState(createBrowserRequestAuthority);
  const [priceRetryRevision, setPriceRetryRevision] = useState(0);
  const [historyRetryRevision, setHistoryRetryRevision] = useState(0);

  useEffect(() => {
    priceAuthority.activate();
    historyAuthority.activate();
    return () => {
      priceAuthority.close();
      historyAuthority.close();
    };
  }, [historyAuthority, priceAuthority]);

  useEffect(() => {
    const request = priceAuthority.beginRead();
    if (request === undefined) return;
    const requestKey = pair.pairId;
    setPriceRead({ requestKey, status: "loading" });
    void readReferencePrice(
      { pairId: pair.pairId },
      { signal: request.signal },
    ).then(
      (value) => {
        if (priceAuthority.isCurrent(request)) {
          if (value.pair.pairId !== requestKey) {
            setPriceRead({
              requestKey,
              status: "error",
              failure: presentBrowserRequestFailure(
                "selected_price",
                invalidBrowserResponse(),
              ),
            });
            return;
          }
          setPriceRead({ requestKey, status: "available", value });
        }
      },
      (error) => {
        if (priceAuthority.isCurrent(request)) {
          setPriceRead({
            requestKey,
            status: "error",
            failure: presentBrowserRequestFailure("selected_price", error),
          });
        }
      },
    );
    return () => {
      priceAuthority.cancelRead(request);
    };
  }, [pair.pairId, priceAuthority, priceRetryRevision]);

  useEffect(() => {
    const request = historyAuthority.beginRead();
    if (request === undefined) return;
    setHistoryRead({ requestKey: historyRequestKey, status: "loading" });
    void readReferenceHistory(
      { pairId: pair.pairId, window: pageLocation.window },
      { signal: request.signal },
    ).then(
      (value) => {
        if (historyAuthority.isCurrent(request)) {
          if (
            value.pair.pairId !== pair.pairId ||
            value.window !== pageLocation.window
          ) {
            setHistoryRead({
              requestKey: historyRequestKey,
              status: "error",
              failure: presentBrowserRequestFailure(
                "price_history",
                invalidBrowserResponse(),
              ),
            });
            return;
          }
          setHistoryRead({
            requestKey: historyRequestKey,
            status: "available",
            value,
          });
        }
      },
      (error) => {
        if (historyAuthority.isCurrent(request)) {
          setHistoryRead({
            requestKey: historyRequestKey,
            status: "error",
            failure: presentBrowserRequestFailure("price_history", error),
          });
        }
      },
    );
    return () => {
      historyAuthority.cancelRead(request);
    };
  }, [
    historyAuthority,
    historyRequestKey,
    historyRetryRevision,
    pageLocation.window,
    pair.pairId,
  ]);

  const price: ReadState<ReferencePriceSuccess> =
    priceRead.requestKey === pair.pairId
      ? priceRead
      : Object.freeze({ status: "loading" });
  const availablePrice = price.status === "available" ? price.value : undefined;
  const pricePresentation =
    availablePrice === undefined
      ? undefined
      : presentReferencePrice(availablePrice);
  const historyState: ReadState<ReferenceHistorySuccess> =
    historyRead.requestKey === historyRequestKey
      ? historyRead
      : Object.freeze({ status: "loading" });
  const availableHistory = historyState.status === "available"
    ? historyState.value
    : undefined;
  const interpretationWarnings =
    availablePrice?.warnings ?? availableHistory?.warnings ?? [];
  return (
    <section className="reference-price-page" aria-labelledby="reference-price-heading">
      <PageHeader
        headingId="reference-price-heading"
        title={pair.label}
        description="Current reference value and bounded price history."
        breadcrumb={(
          <a
            href={browserLocationHref(browserLocations.referencePrices())}
            onClick={(event) => {
              onNavigate(browserLocations.referencePrices(), event);
            }}
          >
            Prices
          </a>
        )}
      />
      <section className="price-primary-section" aria-label={`${pair.label} current value`}>
        {price.status === "loading" ? (
          <LoadingIndicator label="Loading current reference price" />
        ) : price.status === "error" ? null : (
          <>
            <p className="primary-financial-value">
              {pricePresentation?.status === "available"
                ? (
                    <RationalValue
                      value={pricePresentation.value}
                      prefix={pricePresentation.unit.prefix}
                      suffix={pricePresentation.unit.suffix}
                    />
                  )
                : "Unavailable"}
            </p>
            <StatusIndicator
              tone={pricePresentation?.tone ?? "unavailable"}
              label={referencePriceStatusLabel(price.value.status)}
            />
          </>
        )}
        {availablePrice?.status === "unavailable" ? (
          <p>{referencePriceUnavailableReasonLabel(availablePrice.reason)}</p>
        ) : null}
        {price.status === "error" ? (
          <div className="error" role="alert">
            <p>{humanFailureText(price.failure)}</p>
            {price.failure.retryable ? (
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setPriceRetryRevision((current) => current + 1);
                }}
              >
                Retry
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="reference-source-times">
          {availablePrice?.sources.map((source) => (
            <p key={source.fact.feedId}>
              <span>{findReferenceFeed(source.fact.feedId).expectedDescription}</span>
              <time>{formatUnixSecondsAsUtc(source.fact.updatedAtUnixSeconds)}</time>
            </p>
          ))}
        </div>
      </section>
      <ReferencePairInterpretation warnings={interpretationWarnings} />
      <nav className="history-window-navigation" aria-label="History window">
        {historyWindows.map((historyWindow) => {
          const next = browserLocations.referencePrice(
            pair.pairId,
            historyWindow.value,
          );
          return (
            <a
              key={historyWindow.value}
              href={browserLocationHref(next)}
              aria-current={
                pageLocation.window === historyWindow.value ? "page" : undefined
              }
              onClick={(event) => {
                onNavigate(next, event);
              }}
            >
              {historyWindow.label}
            </a>
          );
        })}
      </nav>
      <ReferenceMarketChart
        chartPort={chartPort}
        historyState={historyState}
        selectedPair={pair}
        onRetry={() => {
          setHistoryRetryRevision((current) => current + 1);
        }}
      />
      {availablePrice === undefined ? null : (
        <section
          className="source-analysis-section"
          aria-labelledby="source-analysis-heading"
        >
          <h2 id="source-analysis-heading">Source contracts</h2>
          <p className="muted">
            Inspect the contracts that produced this reference value.
          </p>
          <div className="source-analysis-list">
            {availablePrice.sources.map((source) => (
              <ContextualAnalysisAction
                key={source.fact.feedId}
                label={`Analyze ${
                  findReferenceFeed(source.fact.feedId).expectedDescription
                } contract`}
                target={createAnalysisTarget({
                  kind: "contract",
                  address: source.fact.proxyAddress,
                  blockNumber: source.readEvidence.block.blockNumber,
                  expectedBlockHash: source.readEvidence.block.blockHash,
                })}
                onAnalyze={onAnalyze}
              />
            ))}
          </div>
        </section>
      )}
    </section>
  );
};
