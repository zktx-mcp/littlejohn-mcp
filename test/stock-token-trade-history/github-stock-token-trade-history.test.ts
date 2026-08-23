import { describe, expect, it, vi } from "vitest";

import { createGitHubStockTokenTradeHistory } from
  "../../src/stock-token-trade-history/github-stock-token-trade-history.js";
import type { StockTokenTradeHistoryFileReference } from
  "../../src/stock-token-trade-history/stock-token-trade-history-data.js";
import {
  buildPairTradeHistoryFixture,
  buildPairTradeHistoryFixtureUntil,
  pairTradeHistoryAsset as asset,
  pairTradeHistorySequence as sequence,
} from "./pair-trade-history-data-fixture.js";

const repository = "stelis-dev/robinhood-stock-token-index";
const apiOrigin = "https://api.github.com";
const downloadOrigin = "https://github.com";
const stateTag = `pair-${asset.poolId}-state`;
const stateName = `state-g${sequence.toString().padStart(16, "0")}.json.gz`;
const referenceIdentity = (reference: StockTokenTradeHistoryFileReference) => {
  const match = reference.logicalId.match(/^pairs\/(0x[0-9a-f]{64})\/(months|days)\/(.+)$/u)!;
  return {
    kind: match[2] === "months" ? "month" : "day",
    period: match[3]!,
  } as const;
};
const referenceName = (reference: StockTokenTradeHistoryFileReference): string => {
  const identity = referenceIdentity(reference);
  return `${identity.kind}-${identity.period}-g${reference.sequence.toString().padStart(16, "0")}-` +
    `${reference.gzipSha256}.json.gz`;
};
const referenceUrl = (reference: StockTokenTradeHistoryFileReference): string => {
  const identity = referenceIdentity(reference);
  const tag = `pair-${asset.poolId}-month-${identity.period.slice(0, 7)}`;
  return `${downloadOrigin}/${repository}/releases/download/${tag}/${referenceName(reference)}`;
};
const stateReleaseUrl = `${apiOrigin}/repos/${repository}/releases/tags/${stateTag}`;
const releaseAssetsUrl = `${apiOrigin}/repos/${repository}/releases/41/assets?per_page=100&page=1`;
const stateUrl = `${downloadOrigin}/${repository}/releases/download/${stateTag}/${stateName}`;

const trackedResponse = (response: Response, released: () => void): Response => {
  if (response.body === null) return response;
  const getReader = response.body.getReader.bind(response.body);
  Object.defineProperty(response.body, "getReader", {
    value: () => {
      const reader = getReader();
      const releaseLock = reader.releaseLock.bind(reader);
      Object.defineProperty(reader, "releaseLock", {
        value: () => {
          released();
          releaseLock();
        },
      });
      return reader;
    },
  });
  return response;
};
const jsonResponse = (value: unknown, released: () => void, status = 200): Response =>
  trackedResponse(new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  }), released);
const sourceFileResponse = (bytes: Uint8Array, released: () => void): Response =>
  trackedResponse(new Response(bytes, {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "content-length": bytes.byteLength.toString(),
    },
  }), released);

const fetchFixture = (
  changedReference?: StockTokenTradeHistoryFileReference,
  fixture = buildPairTradeHistoryFixture(),
) => {
  let readerReleases = 0;
  const released = () => { readerReleases += 1; };
  const byUrl = new Map<string, Uint8Array>();
  byUrl.set(stateUrl, fixture.stateEncoded.gzip);
  for (const month of fixture.months) byUrl.set(referenceUrl(month.reference), month.encoded.gzip);
  for (const day of fixture.days) byUrl.set(referenceUrl(day.reference), day.encoded.gzip);
  if (changedReference !== undefined) {
    const target = referenceUrl(changedReference);
    const changed = byUrl.get(target)!.slice();
    changed[changed.length - 1] = changed.at(-1)! ^ 1;
    byUrl.set(target, changed);
  }
  const fetchImplementation = vi.fn<typeof fetch>(async (input) => {
    const target = String(input);
    if (target === stateReleaseUrl) return jsonResponse({ id: 41, tag_name: stateTag }, released);
    if (target === releaseAssetsUrl) {
      return jsonResponse([{
        id: 17,
        name: stateName,
        size: fixture.stateEncoded.gzip.byteLength,
      }], released);
    }
    const bytes = byUrl.get(target);
    return bytes === undefined ? new Response(null, { status: 404 }) : sourceFileResponse(bytes, released);
  });
  return { fixture, fetchImplementation, readerReleases: () => readerReleases };
};

const request = Object.freeze({
  pairId: asset.poolId,
  window: "1d" as const,
  requestedStart: "2026-07-31T12:01:30.000Z",
  requestedEnd: "2026-08-01T12:01:30.000Z",
});

describe("GitHub pair trade-history reads", () => {
  it("reads one selected pair-state file and only the overlapping pair-month and pair-day files", async () => {
    const { fixture, fetchImplementation, readerReleases } = fetchFixture();
    const result = await createGitHubStockTokenTradeHistory({ fetchImplementation }).read(request);
    expect(result).toMatchObject({
      status: "available",
      sourceFiles: {
        pairId: asset.poolId,
        months: [{ month: "2026-07" }, { month: "2026-08" }],
        days: [{ day: "2026-07-31" }, { day: "2026-08-01" }],
      },
    });
    if (result.status !== "available") throw new TypeError("Expected available trade history.");
    expect(result.chart.positions.filter((position) => position.candle !== null)).toHaveLength(2);
    expect(Object.hasOwn(result, "candles")).toBe(false);
    expect(Object.hasOwn(result, "detail")).toBe(false);
    const targets = fetchImplementation.mock.calls.map(([input]) => String(input));
    expect(targets).toEqual(expect.arrayContaining([
      stateReleaseUrl,
      releaseAssetsUrl,
      stateUrl,
      ...fixture.months.map((entry) => referenceUrl(entry.reference)),
      referenceUrl(fixture.days[0]!.reference),
      referenceUrl(fixture.days[1]!.reference),
    ]));
    expect(targets).toHaveLength(7);
    expect(readerReleases()).toBe(7);
    expect(targets.some((target) => target.includes("group"))).toBe(false);
    expect(targets.some((target) => target.includes("2026-08-02"))).toBe(false);
  });

  it("preserves an exact 30-day public interval while selecting three months and 31 UTC days", async () => {
    const fixture = buildPairTradeHistoryFixtureUntil("2027-03-02T12:01:00.000Z");
    const selected = fetchFixture(undefined, fixture);
    const requestedStart = "2027-01-31T12:00:30.000Z";
    const requestedEnd = "2027-03-02T12:00:30.000Z";
    const invalidFetch = vi.fn<typeof fetch>();
    await expect(createGitHubStockTokenTradeHistory({ fetchImplementation: invalidFetch }).read({
      pairId: asset.poolId,
      window: "7d",
      requestedStart,
      requestedEnd,
    })).rejects.toBeInstanceOf(TypeError);
    expect(invalidFetch).not.toHaveBeenCalled();
    const result = await createGitHubStockTokenTradeHistory({
      fetchImplementation: selected.fetchImplementation,
    }).read({ pairId: asset.poolId, window: "30d", requestedStart, requestedEnd });

    expect(result).toMatchObject({
      status: "available",
      requestedStart,
      requestedEnd,
      sourceFiles: {
        months: [{ month: "2027-01" }, { month: "2027-02" }, { month: "2027-03" }],
      },
    });
    if (result.status !== "available") throw new TypeError("Expected available trade history.");
    expect(result.sourceFiles.days).toHaveLength(31);
    expect(result.sourceFiles.days[0]?.day).toBe("2027-01-31");
    expect(result.sourceFiles.days.at(-1)?.day).toBe("2027-03-02");
    expect(selected.fetchImplementation).toHaveBeenCalledTimes(37);
    expect(selected.readerReleases()).toBe(37);
  });

  it("selects every UTC day overlapped by an exact seven-day public interval", async () => {
    const selected = fetchFixture();
    const requestedStart = "2026-08-06T00:00:30.000Z";
    const requestedEnd = "2026-08-13T00:00:30.000Z";
    const result = await createGitHubStockTokenTradeHistory({
      fetchImplementation: selected.fetchImplementation,
    }).read({ pairId: asset.poolId, window: "7d", requestedStart, requestedEnd });
    expect(result).toMatchObject({ status: "available", requestedStart, requestedEnd });
    if (result.status !== "available") throw new TypeError("Expected available trade history.");
    expect(result.sourceFiles.months).toEqual([expect.objectContaining({ month: "2026-08" })]);
    expect(result.sourceFiles.days).toHaveLength(8);
    expect(result.sourceFiles.days[0]?.day).toBe("2026-08-06");
    expect(result.sourceFiles.days.at(-1)?.day).toBe("2026-08-13");
    expect(selected.fetchImplementation).toHaveBeenCalledTimes(12);
  });

  it("reports admitted partial coverage without treating a partial boundary minute as missing", async () => {
    const selected = fetchFixture();
    const requestedStart = request.requestedStart;
    const requestedEnd = request.requestedEnd;
    const result = await createGitHubStockTokenTradeHistory({
      fetchImplementation: selected.fetchImplementation,
    }).read({ pairId: asset.poolId, window: "1d", requestedStart, requestedEnd });
    expect(result).toMatchObject({
      status: "available",
      requestedStart,
      requestedEnd,
      coverage: {
        status: "partial",
        limitations: ["before_published_coverage"],
      },
    });
    if (result.status !== "available") throw new TypeError("Expected available trade history.");
    expect(result.chart.positions.filter((position) => position.candle !== null)).toHaveLength(2);
    expect(Object.hasOwn(result, "candles")).toBe(false);
  });

  it("distinguishes a missing selected state from changed bytes referenced by selected state", async () => {
    const missingFetch = vi.fn<typeof fetch>(async () => new Response(null, { status: 404 }));
    await expect(createGitHubStockTokenTradeHistory({ fetchImplementation: missingFetch }).read(request))
      .resolves.toMatchObject({ status: "unavailable", reason: "trade_history_unavailable" });

    const fixture = buildPairTradeHistoryFixture();
    const changed = fetchFixture(fixture.months[0]!.reference);
    await expect(createGitHubStockTokenTradeHistory({ fetchImplementation: changed.fetchImplementation }).read(request))
      .resolves.toMatchObject({ status: "unavailable", reason: "trade_history_inconsistent" });
  });

  it("settles every admitted parallel source-file read before publishing one failure", async () => {
    const fixture = buildPairTradeHistoryFixture();
    const changed = fetchFixture(fixture.months[0]!.reference, fixture);
    const delayedTarget = referenceUrl(fixture.months[1]!.reference);
    let enterDelay: (() => void) | undefined;
    let releaseDelay: (() => void) | undefined;
    const delayEntered = new Promise<void>((resolve) => { enterDelay = resolve; });
    const delay = new Promise<void>((resolve) => { releaseDelay = resolve; });
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input) === delayedTarget) {
        enterDelay?.();
        await delay;
      }
      return changed.fetchImplementation(input, init);
    });
    let settled = false;
    const pending = createGitHubStockTokenTradeHistory({ fetchImplementation }).read(request);
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await delayEntered;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    releaseDelay?.();
    await expect(pending).resolves.toMatchObject({
      status: "unavailable",
      reason: "trade_history_inconsistent",
    });
  });

  it("admits only an omitted or callable fetch dependency and does not turn local cleanup failure into source evidence", async () => {
    expect(() => createGitHubStockTokenTradeHistory({ fetchImplementation: null as never })).toThrow(TypeError);
    expect(() => createGitHubStockTokenTradeHistory({ fetchImplementation: undefined })).not.toThrow();
    expect(() => createGitHubStockTokenTradeHistory({ unexpected: true } as never)).toThrow(TypeError);

    const cleanupFailure = new Error("cleanup failed");
    const body = new ReadableStream<Uint8Array>({
      cancel: async () => { throw cleanupFailure; },
    });
    const fetchImplementation = vi.fn<typeof fetch>(async () => new Response(body, { status: 404 }));
    await expect(createGitHubStockTokenTradeHistory({ fetchImplementation }).read(request))
      .rejects.toMatchObject({ name: "TradeHistoryLocalError", cause: cleanupFailure });

    const readerFailure = new Error("reader acquisition failed");
    const cancel = vi.fn(async () => undefined);
    const acquisitionBody = new ReadableStream<Uint8Array>({ cancel });
    Object.defineProperty(acquisitionBody, "getReader", {
      value: () => { throw readerFailure; },
    });
    const acquisitionFetch = vi.fn<typeof fetch>(async () => new Response(acquisitionBody));
    await expect(createGitHubStockTokenTradeHistory({
      fetchImplementation: acquisitionFetch,
    }).read(request)).rejects.toMatchObject({ name: "TradeHistoryLocalError", cause: readerFailure });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("preserves caller cancellation instead of converting it to trade-history availability", async () => {
    let releaseFetch: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => { releaseFetch = resolve; });
    const fetchImplementation = vi.fn<typeof fetch>(async (_input, init) => {
      releaseFetch?.();
      await new Promise<void>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
      throw new Error("unreachable");
    });
    const controller = new AbortController();
    const pending = createGitHubStockTokenTradeHistory({ fetchImplementation }).read(request, controller.signal);
    await entered;
    controller.abort(new Error("caller stopped"));
    await expect(pending).rejects.toBeInstanceOf(Error);

    const deadlineController = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadlineController.signal);
    try {
      let enteredDeadline: (() => void) | undefined;
      const deadlineEntered = new Promise<void>((resolve) => { enteredDeadline = resolve; });
      const deadlineFetch = vi.fn<typeof fetch>(async (_input, init) => {
        enteredDeadline?.();
        await new Promise<void>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
        throw new Error("unreachable");
      });
      const deadlineRead = createGitHubStockTokenTradeHistory({
        fetchImplementation: deadlineFetch,
      }).read(request);
      await deadlineEntered;
      deadlineController.abort(new Error("deadline"));
      await expect(deadlineRead).resolves.toMatchObject({
        status: "unavailable",
        reason: "trade_history_unavailable",
      });
    } finally {
      timeout.mockRestore();
    }
  });
});
