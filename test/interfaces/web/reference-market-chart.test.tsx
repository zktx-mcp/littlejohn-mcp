import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  chainAnchorSchema,
  createExactRational,
  referenceHistorySuccessSchema,
  referenceHistoryWarnings,
  referenceMarketManifest,
  referenceMarketMappingEvidence,
  referenceRoundObservationSchema,
  type ReferenceHistorySuccess,
} from "../../../src/core/browser.js";
import {
  createReferenceChartMountController,
  projectReferenceHistoryChart,
  ReferenceMarketChart,
  referenceObservedRange,
  selectReferenceChartTime,
} from "../../../src/interfaces/web/reference-market-chart.js";
import type {
  ReferenceChartEntry,
  ReferenceChartMountResult,
  ReferenceChartPort,
} from "../../../src/interfaces/web/reference-chart.js";

const pair = referenceMarketManifest.pairs[0]!;
const feed = referenceMarketManifest.feeds[0]!;
const block = chainAnchorSchema.parse({
  chainId: "eip155:4663",
  blockNumber: "42",
  blockHash: `0x${"ab".repeat(32)}`,
  blockTimestamp: "2026-07-22T00:07:00.000Z",
});
const observationTime = "2026-07-22T00:02:00.000Z";
const observationSeconds = String(Date.parse(observationTime) / 1_000);
const observation = referenceRoundObservationSchema.parse({
  fact: {
    manifestVersion: 1,
    feedId: feed.feedId,
    proxyAddress: feed.standardProxy,
    decimals: 8,
    roundId: String((1n << 64n) | 1n),
    answeredInRound: String((1n << 64n) | 1n),
    answer: "193384405462",
    startedAtUnixSeconds: observationSeconds,
    updatedAtUnixSeconds: observationSeconds,
    value: createExactRational(193384405462n, 100000000n),
  },
  readEvidence: {
    observedAt: "2026-07-22T00:07:01.000Z",
    sourceOwner: "user_configured",
    sourceClass: "chain_rpc",
    sourceReference: {
      kind: "configured_rpc",
      sourceId: `rpc:${"A".repeat(43)}`,
      publicOrigin: "https://rpc.example",
      configurationDigest: "A".repeat(43),
    },
    block,
  },
});
const firstBucket = Date.parse("2026-07-21T00:15:00.000Z");
const finalBucket = Date.parse("2026-07-22T00:00:00.000Z");
const bucketMilliseconds = 15 * 60 * 1_000;
const chronologicalEmptyBuckets = Object.freeze(Array.from(
  { length: (finalBucket - firstBucket) / bucketMilliseconds },
  (_, index) => new Date(firstBucket + index * bucketMilliseconds).toISOString(),
));
const sourcePointers = Object.freeze([{
  feedId: observation.fact.feedId,
  roundId: observation.fact.roundId,
}]);

const historyWithEmptyBuckets = (
  emptyBucketStarts: readonly string[],
): ReferenceHistorySuccess => referenceHistorySuccessSchema.parse({
  status: "partial",
  pair,
  window: "1d",
  block,
  mappingEvidence: referenceMarketMappingEvidence,
  coverage: {
    basis: "observed_rounds",
    requestedStart: "2026-07-21T00:07:00.000Z",
    requestedEnd: block.blockTimestamp,
    emptyBucketStarts,
    limitations: ["source_history_not_exhaustive", "phase_boundary"],
  },
  candles: [{
    openedAt: new Date(finalBucket).toISOString(),
    closedAt: block.blockTimestamp,
    openBucket: true,
    open: observation.fact.value,
    high: observation.fact.value,
    low: observation.fact.value,
    close: observation.fact.value,
    openSourcePointers: sourcePointers,
    openSourceSkewSeconds: "0",
    highSourcePointers: sourcePointers,
    highSourceSkewSeconds: "0",
    lowSourcePointers: sourcePointers,
    lowSourceSkewSeconds: "0",
    closeSourcePointers: sourcePointers,
    closeSourceSkewSeconds: "0",
  }],
  sourceObservations: [observation],
  warnings: [...referenceHistoryWarnings, "partial_history"],
});

const chartEntries: readonly ReferenceChartEntry[] = Object.freeze([
  Object.freeze({
    kind: "candlestick",
    time: 100,
    open: 2,
    high: 4,
    low: 1,
    close: 3,
  }),
]);

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return Object.freeze({ promise, reject, resolve });
};

describe("reference history chart product state", () => {
  it("links chart descriptions only after their admitted owners exist", () => {
    const chartPort: ReferenceChartPort = Object.freeze({
      mount: async () => Object.freeze({ status: "unavailable" as const }),
    });
    const loading = renderToStaticMarkup(createElement(ReferenceMarketChart, {
      chartPort,
      historyState: { status: "loading" },
      selectedPair: pair,
    }));
    const available = renderToStaticMarkup(createElement(ReferenceMarketChart, {
      chartPort,
      historyState: {
        status: "available",
        value: historyWithEmptyBuckets(chronologicalEmptyBuckets),
      },
      selectedPair: pair,
    }));

    expect(loading).not.toContain("aria-describedby=");
    expect(loading).not.toContain('id="reference-chart-summary"');
    expect(loading).not.toContain('id="reference-chart-legend"');
    expect(loading).not.toContain('tabindex="0"');
    expect(loading).not.toContain("aria-keyshortcuts=");
    expect(available).toContain(
      'aria-describedby="reference-chart-summary reference-chart-legend reference-chart-instructions"',
    );
    expect(available).toContain('id="reference-chart-summary"');
    expect(available).toContain('id="reference-chart-legend"');
    expect(available).toContain('aria-keyshortcuts="ArrowLeft ArrowRight Home End"');
    expect(available).toContain('id="reference-chart-instructions"');
  });

  it("derives chronological chart entries without mutating or replacing canonical history", () => {
    const reversedEmptyBuckets = Object.freeze([...chronologicalEmptyBuckets].reverse());
    const history = historyWithEmptyBuckets(reversedEmptyBuckets);
    const originalEmptyBuckets = [...history.coverage.emptyBucketStarts];
    const originalCandles = history.candles;

    const projection = projectReferenceHistoryChart(history);

    expect(projection.status).toBe("available");
    if (projection.status !== "available") throw new TypeError("Expected chart projection.");
    expect(projection.entries).toHaveLength(96);
    expect(projection.entries.at(0)).toEqual({
      kind: "whitespace",
      time: firstBucket / 1_000,
    });
    expect(projection.entries.at(-1)).toMatchObject({
      kind: "candlestick",
      time: finalBucket / 1_000,
    });
    expect(projection.entryTimes).toEqual(
      projection.entries.map((entry) => entry.time),
    );
    expect(projection.candleTimes).toEqual([finalBucket / 1_000]);
    expect(history.coverage.emptyBucketStarts).toEqual(originalEmptyBuckets);
    expect(history.candles).toBe(originalCandles);
  });

  it("uses every admitted chart interval for keys and pointer selection", () => {
    const entries = [100, 200, 300, 400, 500];
    expect(selectReferenceChartTime(entries, undefined, { kind: "replace" })).toBe(500);
    expect(selectReferenceChartTime(entries, 300, { kind: "left" })).toBe(200);
    expect(selectReferenceChartTime(entries, 300, { kind: "right" })).toBe(400);
    expect(selectReferenceChartTime(entries, 100, { kind: "left" })).toBe(100);
    expect(selectReferenceChartTime(entries, 500, { kind: "right" })).toBe(500);
    expect(selectReferenceChartTime(entries, 300, { kind: "first" })).toBe(100);
    expect(selectReferenceChartTime(entries, 300, { kind: "last" })).toBe(500);
    expect(selectReferenceChartTime(entries, 300, {
      kind: "chart_time",
      time: 100,
      admittedEntryTimes: entries,
    })).toBe(100);
    expect(selectReferenceChartTime(entries, 300, {
      kind: "chart_time",
      time: 200,
      admittedEntryTimes: entries,
    })).toBe(200);
    expect(selectReferenceChartTime(entries, 200, { kind: "left" })).toBe(100);
    expect(selectReferenceChartTime(entries, 200, { kind: "right" })).toBe(300);
    expect(selectReferenceChartTime(entries, 300, {
      kind: "chart_time",
      time: 250,
      admittedEntryTimes: entries,
    })).toBe(300);
    expect(selectReferenceChartTime(entries, 300, {
      kind: "chart_time",
      admittedEntryTimes: entries,
    })).toBe(300);
    expect(selectReferenceChartTime([], 300, { kind: "right" })).toBeUndefined();
  });

  it("selects the exact admitted observed range without recalculating prices", () => {
    const history = historyWithEmptyBuckets(chronologicalEmptyBuckets);
    const range = referenceObservedRange(history.candles);
    expect(range?.high).toBe(history.candles[0]?.high);
    expect(range?.low).toBe(history.candles[0]?.low);
    expect(referenceObservedRange([])).toBeUndefined();
  });

  it("destroys and ignores a superseded mount result and its callback", async () => {
    const first = deferred<ReferenceChartMountResult>();
    const second = deferred<ReferenceChartMountResult>();
    const callbacks: Array<(time: number) => void> = [];
    let calls = 0;
    const port: ReferenceChartPort = Object.freeze({
      mount: (
        _container: HTMLElement,
        _entries: readonly ReferenceChartEntry[],
        callback: (time: number) => void,
      ) => {
        callbacks.push(callback);
        calls += 1;
        return calls === 1 ? first.promise : second.promise;
      },
    });
    const statuses: string[] = [];
    const selected: number[] = [];
    const firstDestroy = { count: 0 };
    const secondDestroy = { count: 0 };
    const controller = createReferenceChartMountController(
      port,
      (status) => { statuses.push(status); },
    );

    controller.replace({} as HTMLElement, chartEntries, (time) => {
      selected.push(time);
    });
    controller.replace({} as HTMLElement, chartEntries, (time) => {
      selected.push(time);
    });
    first.resolve({
      status: "mounted",
      handle: Object.freeze({
        destroy: () => { firstDestroy.count += 1; },
      }),
    });
    await first.promise;
    await Promise.resolve();
    callbacks.at(0)?.(100);
    expect(firstDestroy.count).toBe(1);
    expect(selected).toEqual([]);

    second.resolve({
      status: "mounted",
      handle: Object.freeze({
        destroy: () => { secondDestroy.count += 1; },
      }),
    });
    await second.promise;
    await Promise.resolve();
    callbacks.at(1)?.(100);
    expect(selected).toEqual([100]);
    controller.destroy();
    callbacks.at(1)?.(100);
    expect(selected).toEqual([100]);
    expect(secondDestroy.count).toBe(1);
    expect(statuses).toEqual([
      "idle",
      "loading",
      "idle",
      "loading",
      "mounted",
      "idle",
    ]);
  });

  it("normalizes synchronous and asynchronous mount failure as unavailable", async () => {
    const statuses: string[] = [];
    const synchronous = createReferenceChartMountController(
      Object.freeze({
        mount: () => {
          throw new Error("provider detail");
        },
      }),
      (status) => { statuses.push(status); },
    );
    expect(() => synchronous.replace(
      {} as HTMLElement,
      chartEntries,
      () => undefined,
    )).not.toThrow();
    expect(statuses).toEqual(["idle", "loading", "unavailable"]);

    const asynchronousStatuses: string[] = [];
    const rejected = deferred<ReferenceChartMountResult>();
    const asynchronous = createReferenceChartMountController(
      Object.freeze({ mount: () => rejected.promise }),
      (status) => { asynchronousStatuses.push(status); },
    );
    asynchronous.replace({} as HTMLElement, chartEntries, () => undefined);
    rejected.reject(new Error("provider detail"));
    await rejected.promise.catch(() => undefined);
    await Promise.resolve();
    expect(asynchronousStatuses).toEqual(["idle", "loading", "unavailable"]);
  });
});
