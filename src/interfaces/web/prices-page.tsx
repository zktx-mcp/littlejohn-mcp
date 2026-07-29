import {
  useCallback,
  useEffect,
  useState,
  type MouseEvent,
} from "react";

import {
  findReferenceFeed,
  referenceMarketManifest,
  type ReferencePriceSuccess,
} from "../../core/browser.js";
import {
  browserLocationHref,
  browserLocations,
  type BrowserLocation,
} from "../browser-contract.js";
import { readReferencePrice } from "./reference-market-client.js";
import {
  humanFailureText,
  presentBrowserRequestFailure,
  type HumanFailurePresentation,
} from "./human-failures.js";
import { referencePriceStatusLabel } from "./human-labels.js";
import { formatUnixSecondsAsUtc } from "./human-time.js";
import { Icon } from "./icons.js";
import { LoadingIndicator } from "./loading-indicator.js";
import { PageHeader } from "./page-header.js";
import { presentReferencePrice } from "./reference-price-presentation.js";
import { createBrowserRequestAuthority } from "./request-authority.js";
import { RationalValue } from "./rational-value.js";
import { StatusIndicator } from "./status-indicator.js";

type PriceReadState =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "available"; value: ReferencePriceSuccess }>
  | Readonly<{ status: "error"; failure: HumanFailurePresentation }>;

export interface PricesPageProps {
  readonly onNavigate: (
    location: BrowserLocation,
    event: MouseEvent<HTMLAnchorElement>,
  ) => void;
}

export const PricesPage = ({ onNavigate }: PricesPageProps) => {
  const [prices, setPrices] = useState<
    ReadonlyMap<string, PriceReadState>
  >(new Map());
  const [priceAuthority] = useState(createBrowserRequestAuthority);

  const loadPrices = useCallback(async (): Promise<void> => {
    const request = priceAuthority.beginRead();
    if (request === undefined) return;
    setPrices(new Map(referenceMarketManifest.pairs.map(
      (pair) => [pair.pairId, { status: "loading" as const }],
    )));
    await Promise.all(referenceMarketManifest.pairs.map(async (pair) => {
      try {
        const value = await readReferencePrice(
          { pairId: pair.pairId },
          { signal: request.signal },
        );
        if (priceAuthority.isCurrent(request)) {
          setPrices((current) => new Map(current).set(pair.pairId, {
            status: "available",
            value,
          }));
        }
      } catch (error) {
        if (priceAuthority.isCurrent(request)) {
          setPrices((current) => new Map(current).set(pair.pairId, {
            status: "error",
            failure: presentBrowserRequestFailure("prices_list", error),
          }));
        }
      }
    }));
    if (priceAuthority.isCurrent(request)) {
      priceAuthority.cancelRead(request);
    }
  }, [priceAuthority]);

  useEffect(() => {
    priceAuthority.activate();
    void loadPrices();
    return () => {
      priceAuthority.close();
    };
  }, [loadPrices, priceAuthority]);

  const completedPriceCount = referenceMarketManifest.pairs.reduce(
    (count, pair) => prices.get(pair.pairId)?.status === "loading"
      ? count
      : prices.has(pair.pairId) ? count + 1 : count,
    0,
  );
  const failedPriceCount = referenceMarketManifest.pairs.reduce(
    (count, pair) => prices.get(pair.pairId)?.status === "error"
      ? count + 1
      : count,
    0,
  );
  const priceCount = referenceMarketManifest.pairs.length;
  const aggregateStatus = completedPriceCount < priceCount
    ? completedPriceCount === 0
      ? "Loading reference prices."
      : `Loading reference prices. ${completedPriceCount} of ${priceCount} complete.`
    : failedPriceCount === 0
      ? "Reference prices loaded."
      : `Reference prices loaded with ${failedPriceCount} unavailable.`;

  return (
    <section className="prices-page" aria-labelledby="prices-heading">
      <PageHeader
        headingId="prices-heading"
        title="Prices"
        description="Current reference prices and their latest observation."
        actions={(
          <button
            type="button"
            className="secondary icon-button"
            aria-label="Refresh prices"
            title="Refresh prices"
            onClick={() => {
              void loadPrices();
            }}
          >
            <Icon name="refresh" />
          </button>
        )}
      />
      <p className="interpretation-note">
        Reference prices are named oracle observations, not trade prices or
        executable quotes.
      </p>
      <p className="visually-hidden" role="status">
        {aggregateStatus}
      </p>
      <div
        className="price-list"
        role="table"
        aria-label="Reference price comparison"
      >
        <div className="price-list-header" role="row">
          <span role="columnheader">Pair</span>
          <span role="columnheader">Reference price</span>
          <span role="columnheader">Last observation</span>
        </div>
        {referenceMarketManifest.pairs.map((pair) => {
          const read = prices.get(pair.pairId);
          const price = read?.status === "available" ? read.value : undefined;
          const presentation =
            price === undefined ? undefined : presentReferencePrice(price);
          const detail = browserLocations.referencePrice(pair.pairId);
          return (
            <article className="price-row" role="row" key={pair.pairId}>
              <div className="price-row-identity" role="cell" data-label="Pair">
                <a
                  className="price-pair-link"
                  href={browserLocationHref(detail)}
                  onClick={(event) => {
                    onNavigate(detail, event);
                  }}
                >
                  {pair.label}
                </a>
              </div>
              <div
                className="price-row-value"
                role="cell"
                data-label="Reference price"
              >
                {price === undefined
                  ? read?.status === "error"
                    ? <strong>Could not load</strong>
                    : (
                        <LoadingIndicator
                          label="Loading reference price"
                          announce={false}
                        />
                      )
                  : (
                      <>
                        <strong>
                          {presentation?.status === "available"
                            ? (
                                <RationalValue
                                  value={presentation.value}
                                  prefix={presentation.unit.prefix}
                                  suffix={presentation.unit.suffix}
                                />
                              )
                            : "Unavailable"}
                        </strong>
                        <StatusIndicator
                          tone={presentation?.tone ?? "unavailable"}
                          label={referencePriceStatusLabel(price.status)}
                        />
                      </>
                    )}
              </div>
              <div
                className="price-source-updates"
                role="cell"
                data-label="Last observation"
              >
                {read?.status === "error" ? (
                  <p className="error">{humanFailureText(read.failure)}</p>
                ) : null}
                {price?.sources.map((source) => (
                  <p key={source.fact.feedId}>
                    <span>
                      {findReferenceFeed(source.fact.feedId).expectedDescription}
                    </span>
                    <time>
                      {formatUnixSecondsAsUtc(source.fact.updatedAtUnixSeconds)}
                    </time>
                  </p>
                ))}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
};
