import { useCallback, useEffect, useRef, useState } from "react";

import {
  isReferenceObservationFresh,
  referenceMarketLimits,
  referenceMarketManifest,
  type ReferenceHistorySuccess,
  type ReferenceMarketMappingEvidence,
  type ReferencePairManifestEntry,
  type ReferencePriceSuccess,
  type ReferenceRoundObservation,
  type ReferenceWatchlistMutationInput,
  type ReferenceWatchlistReorderInput,
  type ReferenceWatchlistSuccess,
  type SourceReference,
} from "../../core/browser.js";
import type { ReferenceMarketDeliveryUnknown } from "../reference-market-delivery.js";
import {
  addReferenceWatchlistPair,
  readReferenceHistory,
  readReferencePrice,
  readReferenceWatchlist,
  removeReferenceWatchlistPair,
  reorderReferenceWatchlistPairs,
} from "./reference-market-client.js";
import { browserActionFailureMessage } from "./browser-client.js";

export interface ReferenceMarketViewProps {
  readonly walletConnected: boolean;
  readonly csrfToken: () => string;
}

type ReadState<Value> =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "available"; value: Value }>
  | Readonly<{ status: "error"; message: string }>;

export type ReferenceMarketHistoryState = ReadState<ReferenceHistorySuccess>;

const starters = Object.freeze(referenceMarketManifest.pairs.filter((pair) => pair.starter));
const firstStarter = referenceMarketManifest.pairs.find((pair) => pair.starter)!;

const exactValue = (value: Readonly<{ numerator: string; denominator: string }>): string =>
  `${value.numerator}/${value.denominator}`;

type ReferenceMarketBlock = ReferencePriceSuccess["block"];

const priceValue = (price: ReferencePriceSuccess): string => price.status === "current"
  ? exactValue(price.currentPrice)
  : price.status === "stale"
    ? exactValue(price.lastObserved)
    : "Unavailable";

const ReferenceBlockEvidence = ({ block, label }: Readonly<{
  block: ReferenceMarketBlock;
  label: string;
}>) => (
  <dl className="market-exact-values" aria-label={label}>
    <dt>Chain</dt><dd>{block.chainId}</dd>
    <dt>Block number</dt><dd>{block.blockNumber}</dd>
    <dt>Block hash</dt><dd>{block.blockHash}</dd>
    <dt>Block timestamp</dt><dd>{block.blockTimestamp}</dd>
  </dl>
);

const ReferenceSourceReference = ({ reference }: Readonly<{
  reference: SourceReference;
}>) => (
  <dl className="market-exact-values">
    <dt>Reference kind</dt><dd>{reference.kind}</dd>
    <dt>Source ID</dt><dd>{reference.sourceId}</dd>
    {reference.kind === "public" ? <><dt>URI</dt><dd>{reference.uri}</dd></> : null}
    {reference.kind === "configured_rpc" ? (
      <>
        <dt>Public origin</dt><dd>{reference.publicOrigin}</dd>
        <dt>Configuration digest</dt><dd>{reference.configurationDigest}</dd>
      </>
    ) : null}
    {reference.kind === "wallet_session" ? <><dt>Topic digest</dt><dd>{reference.topicDigest}</dd></> : null}
  </dl>
);

const ReferenceMappingEvidence = ({ mapping }: Readonly<{
  mapping: ReferenceMarketMappingEvidence;
}>) => (
  <details>
    <summary>Mapping evidence</summary>
    <dl className="market-exact-values">
      <dt>Source owner</dt><dd>{mapping.sourceOwner}</dd>
      <dt>Source class</dt><dd>{mapping.sourceClass}</dd>
      <dt>Source URI</dt><dd>{mapping.sourceUri}</dd>
      <dt>Source observed at</dt><dd>{mapping.sourceObservedAt}</dd>
      <dt>Freshness status</dt><dd>{mapping.freshnessStatus}</dd>
      <dt>Freshness rule</dt><dd>{mapping.freshnessRule}</dd>
      <dt>Coverage</dt><dd>{mapping.coverage}</dd>
      <dt>Exclusions</dt><dd>{mapping.exclusions.join(", ")}</dd>
      <dt>Supported conclusions</dt><dd>{mapping.supportedConclusions.join(", ")}</dd>
      <dt>Unsupported conclusions</dt><dd>{mapping.unsupportedConclusions.join(", ")}</dd>
    </dl>
  </details>
);

const ReferenceRoundEvidence = ({ source, freshness }: Readonly<{
  source: ReferenceRoundObservation;
  freshness?: "fresh" | "stale";
}>) => (
  <li>
    <details>
      <summary>{source.fact.feedId} · round {source.fact.roundId}{freshness === undefined ? "" : ` · ${freshness}`}</summary>
      <dl className="market-exact-values">
        <dt>Manifest version</dt><dd>{source.fact.manifestVersion}</dd>
        <dt>Feed ID</dt><dd>{source.fact.feedId}</dd>
        <dt>Proxy address</dt><dd>{source.fact.proxyAddress}</dd>
        <dt>Round ID</dt><dd>{source.fact.roundId}</dd>
        <dt>Answered in round</dt><dd>{source.fact.answeredInRound}</dd>
        <dt>Answer</dt><dd>{source.fact.answer}</dd>
        <dt>Decimals</dt><dd>{source.fact.decimals}</dd>
        <dt>Exact value</dt><dd>{exactValue(source.fact.value)}</dd>
        <dt>Started at Unix seconds</dt><dd>{source.fact.startedAtUnixSeconds}</dd>
        <dt>Updated at Unix seconds</dt><dd>{source.fact.updatedAtUnixSeconds}</dd>
        <dt>Observed at</dt><dd>{source.readEvidence.observedAt}</dd>
        <dt>Read source owner</dt><dd>{source.readEvidence.sourceOwner}</dd>
        <dt>Read source class</dt><dd>{source.readEvidence.sourceClass}</dd>
      </dl>
      <ReferenceSourceReference reference={source.readEvidence.sourceReference} />
      <ReferenceBlockEvidence block={source.readEvidence.block} label={`${source.fact.feedId} round read block`} />
    </details>
  </li>
);

export const ReferenceMarketPriceEvidence = ({ pair, price }: Readonly<{
  pair: ReferencePairManifestEntry;
  price: ReferencePriceSuccess;
}>) => (
  <div className="market-evidence">
    <span className="badge">{price.status}</span>
    {price.status === "unavailable" ? <p>Reason: {price.reason}</p> : null}
    <ReferenceBlockEvidence block={price.block} label={`${pair.label} canonical block`} />
    <ReferenceMappingEvidence mapping={price.mappingEvidence} />
    <details>
      <summary>Source observations ({price.sources.length})</summary>
      <ul aria-label={`${pair.label} reference price source observations`}>
        {price.sources.map((source) => (
          <ReferenceRoundEvidence
            key={`${source.fact.feedId}:${source.fact.roundId}`}
            source={source}
            freshness={isReferenceObservationFresh(source, price.block.blockTimestamp) ? "fresh" : "stale"}
          />
        ))}
      </ul>
    </details>
    <ul aria-label={`${pair.label} reference price warnings`}>
      {price.warnings.map((warning) => <li key={warning}>{warning}</li>)}
    </ul>
  </div>
);

const chartPoints = (result: ReferenceHistorySuccess): string => {
  const values = result.candles.map((candle) => Number(candle.close.numerator) / Number(candle.close.denominator));
  if (values.length === 0 || values.some((value) => !Number.isFinite(value))) return "";
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const span = maximum - minimum || 1;
  return values.map((value, index) => {
    const x = values.length === 1 ? 50 : index * 100 / (values.length - 1);
    const y = 92 - (value - minimum) * 84 / span;
    return `${x.toFixed(3)},${y.toFixed(3)}`;
  }).join(" ");
};

export const ReferenceMarketHistoryPanel = ({ selected, state }: Readonly<{
  selected: ReferencePairManifestEntry;
  state: ReferenceMarketHistoryState;
}>) => {
  const points = state.status === "available" ? chartPoints(state.value) : "";
  const latestCandle = state.status === "available" ? state.value.candles.at(-1) : undefined;
  return (
    <section className="market-chart" aria-labelledby="reference-chart-heading">
      <div className="section-heading">
        <h2 id="reference-chart-heading">{selected.label} · 1 day</h2>
        {state.status === "available" ? <span className="badge">{state.value.status}</span> : null}
      </div>
      {state.status === "loading" ? <p>Loading reference history…</p> : null}
      {state.status === "error" ? <p className="error">{state.message}</p> : null}
      {state.status === "available" && points.length === 0 ? <p>No valid candle is available.</p> : null}
      {state.status === "available" ? (
        <div className="market-evidence">
          {state.value.status === "unavailable" ? <p>Reason: {state.value.reason}</p> : null}
          <ReferenceBlockEvidence block={state.value.block} label={`${selected.label} history canonical block`} />
          <ReferenceMappingEvidence mapping={state.value.mappingEvidence} />
          <dl className="market-exact-values" aria-label={`${selected.label} history coverage`}>
            <dt>Coverage basis</dt><dd>{state.value.coverage.basis}</dd>
            <dt>Requested start</dt><dd>{state.value.coverage.requestedStart}</dd>
            <dt>Requested end</dt><dd>{state.value.coverage.requestedEnd}</dd>
            <dt>Empty bucket starts</dt>
            <dd>{state.value.coverage.emptyBucketStarts.length === 0
              ? "none"
              : state.value.coverage.emptyBucketStarts.join(", ")}</dd>
            <dt>Limitations</dt><dd>{state.value.coverage.limitations.join(", ")}</dd>
          </dl>
          <details>
            <summary>Source observations ({state.value.sourceObservations.length})</summary>
            <ul aria-label={`${selected.label} reference history source observations`}>
              {state.value.sourceObservations.map((source) => (
                <ReferenceRoundEvidence
                  key={`${source.fact.feedId}:${source.fact.roundId}`}
                  source={source}
                />
              ))}
            </ul>
          </details>
          <ul aria-label={`${selected.label} reference history warnings`}>
            {state.value.warnings.map((warning) => <li key={warning}>{warning}</li>)}
          </ul>
        </div>
      ) : null}
      {latestCandle === undefined ? null : (
        <dl className="market-exact-values" aria-label={`${selected.label} latest exact candle values`}>
          <dt>Open</dt><dd>{exactValue(latestCandle.open)}</dd>
          <dt>High</dt><dd>{exactValue(latestCandle.high)}</dd>
          <dt>Low</dt><dd>{exactValue(latestCandle.low)}</dd>
          <dt>Close</dt><dd>{exactValue(latestCandle.close)}</dd>
        </dl>
      )}
      {state.status === "available" && points.length > 0 ? (
        <svg viewBox="0 0 100 100" role="img" aria-label={`${selected.label} reference-price visual projection`}>
          <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        </svg>
      ) : null}
    </section>
  );
};

export const ReferenceMarketView = ({ walletConnected, csrfToken }: ReferenceMarketViewProps) => {
  const [selectedPairId, setSelectedPairId] = useState(firstStarter.pairId);
  const [prices, setPrices] = useState<ReadonlyMap<string, ReadState<ReferencePriceSuccess>>>(new Map());
  const [historyResult, setHistoryResult] = useState<ReadState<ReferenceHistorySuccess>>({ status: "loading" });
  const [watchlist, setWatchlist] = useState<ReadState<ReferenceWatchlistSuccess>>({ status: "loading" });
  const [pending, setPending] = useState(false);
  const [delivery, setDelivery] = useState<ReferenceMarketDeliveryUnknown>();
  const focusTarget = useRef<HTMLButtonElement | undefined>(undefined);

  const visiblePairs = watchlist.status === "available" && watchlist.value.entries.length > 0
    ? watchlist.value.entries
    : starters;

  const loadWatchlist = useCallback(async (): Promise<void> => {
    if (!walletConnected) {
      setWatchlist({ status: "error", message: "Connect a wallet to save a reference-pair watchlist." });
      return;
    }
    setWatchlist({ status: "loading" });
    try {
      setWatchlist({ status: "available", value: await readReferenceWatchlist() });
      setDelivery(undefined);
    } catch (error) {
      setWatchlist({ status: "error", message: browserActionFailureMessage(error) });
    }
  }, [walletConnected]);

  useEffect(() => { void loadWatchlist(); }, [loadWatchlist]);

  useEffect(() => {
    const controller = new AbortController();
    for (const pair of visiblePairs) {
      setPrices((current) => new Map(current).set(pair.pairId, { status: "loading" }));
      void readReferencePrice({ pairId: pair.pairId }, { signal: controller.signal }).then(
        (value) => { setPrices((current) => new Map(current).set(pair.pairId, { status: "available", value })); },
        (error) => {
          if (!controller.signal.aborted) {
            setPrices((current) => new Map(current).set(pair.pairId, {
              status: "error", message: browserActionFailureMessage(error),
            }));
          }
        },
      );
    }
    return () => { controller.abort(); };
  }, [visiblePairs.map((pair) => pair.pairId).join("\0")]);

  useEffect(() => {
    const controller = new AbortController();
    setHistoryResult({ status: "loading" });
    void readReferenceHistory({ pairId: selectedPairId, window: "1d" }, { signal: controller.signal }).then(
      (value) => { setHistoryResult({ status: "available", value }); },
      (error) => {
        if (!controller.signal.aborted) setHistoryResult({ status: "error", message: browserActionFailureMessage(error) });
      },
    );
    return () => { controller.abort(); };
  }, [selectedPairId]);

  useEffect(() => {
    if (!visiblePairs.some((pair) => pair.pairId === selectedPairId)) {
      setSelectedPairId(visiblePairs.at(0)?.pairId ?? firstStarter.pairId);
    }
  }, [selectedPairId, visiblePairs]);

  const runMutation = async (
    mutation:
      | Readonly<{ action: "add"; request: ReferenceWatchlistMutationInput }>
      | Readonly<{ action: "remove"; request: ReferenceWatchlistMutationInput }>
      | Readonly<{ action: "reorder"; request: ReferenceWatchlistReorderInput }>,
    trigger?: HTMLButtonElement,
  ): Promise<void> => {
    if (watchlist.status !== "available" || pending || delivery !== undefined) return;
    focusTarget.current = trigger;
    setPending(true);
    try {
      const result = mutation.action === "add"
        ? await addReferenceWatchlistPair(mutation.request, csrfToken())
        : mutation.action === "remove"
          ? await removeReferenceWatchlistPair(mutation.request, csrfToken())
          : await reorderReferenceWatchlistPairs(mutation.request, csrfToken());
      if (result.status === "delivery_unknown") setDelivery(result.delivery);
      else setWatchlist({ status: "available", value: result.value });
    } catch (error) {
      setWatchlist({ status: "error", message: browserActionFailureMessage(error) });
    } finally {
      setPending(false);
      const target = focusTarget.current;
      focusTarget.current = undefined;
      window.setTimeout(() => { if (target?.isConnected === true) target.focus(); }, 0);
    }
  };

  const savedIds = new Set(watchlist.status === "available"
    ? watchlist.value.entries.map((pair) => pair.pairId)
    : []);
  const selected = referenceMarketManifest.pairs.find((pair) => pair.pairId === selectedPairId) ?? firstStarter;

  return (
    <section className="reference-market" aria-labelledby="reference-market-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Chainlink reference data</p>
          <h1 id="reference-market-heading">Reference markets</h1>
        </div>
        <button type="button" className="secondary" onClick={() => { void loadWatchlist(); }}>Read watchlist</button>
      </div>
      <p className="muted">Reference prices are evidence from named oracle feeds, not trade prices or quotes.</p>
      {delivery === undefined ? null : (
        <div className="warning" role="status">
          <strong>Delivery result unknown</strong>
          <p>The request may have committed. Read the watchlist before deciding whether to send another mutation.</p>
        </div>
      )}
      <div className="market-card-grid">
        {visiblePairs.map((pair, index) => {
          const price = prices.get(pair.pairId);
          const saved = savedIds.has(pair.pairId);
          return (
            <article key={pair.pairId} className={`market-card${pair.pairId === selectedPairId ? " selected" : ""}`}>
              <button type="button" className="market-card-select" onClick={() => { setSelectedPairId(pair.pairId); }}>
                <strong>{pair.label}</strong>
                <span>{price?.status === "available" ? priceValue(price.value) : price?.status === "error" ? "Unavailable" : "Loading…"}</span>
              </button>
              {price?.status === "available"
                ? <ReferenceMarketPriceEvidence pair={pair} price={price.value} />
                : null}
              {walletConnected && watchlist.status === "available" ? (
                <div className="market-card-actions">
                  {saved ? (
                    <>
                      <button
                        type="button"
                        className="icon-button secondary"
                        aria-label={`Move ${pair.label} earlier`}
                        disabled={pending || delivery !== undefined || index === 0}
                        onClick={(event) => {
                          const ids = watchlist.value.entries.map((entry, currentIndex, entries) =>
                            currentIndex === index - 1
                              ? entries.at(index)!.pairId
                              : currentIndex === index
                                ? entries.at(index - 1)!.pairId
                                : entry.pairId);
                          void runMutation({
                            action: "reorder",
                            request: { pairIds: ids, expectedRevision: watchlist.value.revision },
                          }, event.currentTarget);
                        }}
                      >↑</button>
                      <button
                        type="button"
                        className="icon-button secondary"
                        aria-label={`Move ${pair.label} later`}
                        disabled={pending || delivery !== undefined || index === watchlist.value.entries.length - 1}
                        onClick={(event) => {
                          const ids = watchlist.value.entries.map((entry, currentIndex, entries) =>
                            currentIndex === index
                              ? entries.at(index + 1)!.pairId
                              : currentIndex === index + 1
                                ? entries.at(index)!.pairId
                                : entry.pairId);
                          void runMutation({
                            action: "reorder",
                            request: { pairIds: ids, expectedRevision: watchlist.value.revision },
                          }, event.currentTarget);
                        }}
                      >↓</button>
                      <button
                        type="button"
                        className="icon-button danger"
                        aria-label={`Remove ${pair.label} from watchlist`}
                        disabled={pending || delivery !== undefined}
                        onClick={(event) => { void runMutation({
                          action: "remove",
                          request: { pairId: pair.pairId, expectedRevision: watchlist.value.revision },
                        }, event.currentTarget); }}
                      >×</button>
                    </>
                  ) : null}
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
      {walletConnected && watchlist.status === "available" ? (
        <div className="market-pair-choices" aria-label="Supported reference pairs">
          {referenceMarketManifest.pairs.filter((pair) => !savedIds.has(pair.pairId)).map((pair) => (
            <button
              key={pair.pairId}
              type="button"
              className="secondary"
              disabled={pending || delivery !== undefined ||
                watchlist.value.entries.length >= referenceMarketLimits.watchlistEntries}
              onClick={(event) => { void runMutation({
                action: "add",
                request: { pairId: pair.pairId, expectedRevision: watchlist.value.revision },
              }, event.currentTarget); }}
            >Add {pair.label}</button>
          ))}
        </div>
      ) : null}
      {watchlist.status === "error" ? <p className="notice">{watchlist.message}</p> : null}
      <ReferenceMarketHistoryPanel selected={selected} state={historyResult} />
    </section>
  );
};
