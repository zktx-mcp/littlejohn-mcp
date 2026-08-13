import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

import { describe, expect, it, vi } from "vitest";

import {
  canonicalJsonStringify,
  parseEvmAddress,
  sha256Bytes,
  type CanonicalJson,
} from "../../src/core/index.js";
import { createGitHubStockTokenExecutionIndex } from
  "../../src/market-portfolio/github-stock-token-execution-index.js";
import {
  createStockTokenExecutionSeries,
  findStockTokenExecutionIndexAsset,
  stockTokenExecutionIndexRegistry,
  stockTokenExecutionIndexRegistrySha256,
  stockTokenExecutionIndexDaySchema,
  stockTokenExecutionIndexStateSchema,
  stockTokenExecutionSeriesSchema,
} from "../../src/market-portfolio/stock-token-execution-index.js";
import {
  decodeStockTokenExecutionIndexDay,
  decodeStockTokenExecutionIndexState,
} from "../../src/market-portfolio/stock-token-execution-index-artifact.js";
import { stockTokenExecutionIndexRegistryJson } from
  "../../src/market-portfolio/stock-token-execution-index-registry.generated.js";

const asset = findStockTokenExecutionIndexAsset(parseEvmAddress(
  "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9",
))!;
const request = Object.freeze({
  token: asset.token,
  requestedStart: "2026-08-13T04:00:00.000Z",
  requestedEnd: "2026-08-13T06:00:00.000Z",
});
const sourcePosition = Object.freeze({
  blockNumber: "35110000",
  blockHash: `0x${"11".repeat(32)}`,
  transactionIndex: 1,
  transactionHash: `0x${"22".repeat(32)}`,
  logIndex: 2,
});
const candle = Object.freeze({
  symbol: asset.symbol,
  token: asset.token,
  poolId: asset.poolId,
  intervalStart: "2026-08-13T04:35:00.000Z",
  intervalEnd: "2026-08-13T04:36:00.000Z",
  open: { numerator: "301", denominator: "1" },
  high: { numerator: "302", denominator: "1" },
  low: { numerator: "300", denominator: "1" },
  close: { numerator: "603", denominator: "2" },
  tokenVolumeRaw: "1000000000000000000",
  quoteVolumeRaw: "301500000",
  tradeCount: 2,
  firstSource: sourcePosition,
  lastSource: sourcePosition,
});
const coverage = Object.freeze({
  fromBlock: "35107460",
  fromTimestamp: "2026-08-13T04:30:00.000Z",
  untilBlock: "35139159",
  untilTimestamp: "2026-08-13T05:28:00.000Z",
});
const day = stockTokenExecutionIndexDaySchema.parse({
  contractVersion: "1" as const,
  kind: "stock_token_execution_day" as const,
  groupId: "group-01" as const,
  day: "2026-08-13",
  source: Object.freeze({
    chainId: stockTokenExecutionIndexRegistry.chain.chainId,
    finality: stockTokenExecutionIndexRegistry.chain.finalityTag,
    poolManager: stockTokenExecutionIndexRegistry.deployment.poolManager,
    quoteToken: stockTokenExecutionIndexRegistry.deployment.quoteToken,
    swapTopic: stockTokenExecutionIndexRegistry.deployment.swapTopic,
  }),
  coverage: [coverage],
  candles: [candle],
});

const encode = (value: unknown) => {
  const json = Buffer.from(canonicalJsonStringify(value as CanonicalJson), "utf8");
  const gzip = new Uint8Array(gzipSync(json, { level: 9 }));
  return Object.freeze({
    json,
    gzip,
    jsonSha256: sha256Bytes(json),
    gzipSha256: sha256Bytes(gzip),
  });
};
const encodedDay = encode(day);
const dayReference = Object.freeze({
  day: day.day,
  releaseTag: "index-2026-08",
  assetName: `group-01-${day.day}-g0000000000000001-${encodedDay.gzipSha256}.json.gz`,
  gzipBytes: encodedDay.gzip.byteLength,
  gzipSha256: encodedDay.gzipSha256,
  jsonBytes: encodedDay.json.byteLength,
  jsonSha256: encodedDay.jsonSha256,
});
const state = stockTokenExecutionIndexStateSchema.parse({
  contractVersion: "1" as const,
  kind: "stock_token_execution_state" as const,
  groupId: "group-01" as const,
  sequence: 1,
  nextBlock: "35139159",
  coveredUntilTimestamp: "2026-08-13T05:28:00.000Z",
  days: [dayReference],
});
const encodedState = encode(state);
const stateAssetName = "group-01-state-g0000000000000001.json.gz";

const response = (body: string | Uint8Array, contentType: string): Response => new Response(body, {
  status: 200,
  headers: { "content-type": contentType },
});

const fetchFixture = (dayBytes = encodedDay.gzip) => vi.fn<typeof fetch>(async (input) => {
  const target = String(input);
  if (target.endsWith("/releases/tags/index-state")) {
    return response(JSON.stringify({
      tag_name: "index-state",
      assets: [{ id: 17, name: stateAssetName, size: encodedState.gzip.byteLength }],
    }), "application/json");
  }
  if (target.endsWith("/releases/assets/17")) {
    return response(encodedState.gzip, "application/octet-stream");
  }
  if (target.endsWith(`/${dayReference.releaseTag}/${dayReference.assetName}`)) {
    return response(dayBytes, "application/octet-stream");
  }
  return new Response(null, { status: 404 });
});

describe("Stock Token execution index boundary", () => {
  it("retains the passed registry bytes without a second PoolKey derivation", () => {
    const bytes = readFileSync(new URL(
      "../../src/market-portfolio/stock-token-execution-index-registry.json",
      import.meta.url,
    ));
    expect(sha256Bytes(bytes)).toBe(stockTokenExecutionIndexRegistrySha256);
    expect(Buffer.from(stockTokenExecutionIndexRegistryJson, "utf8")).toEqual(bytes);
    expect(stockTokenExecutionIndexRegistry.groups[0]?.assets).toHaveLength(8);
    expect(asset.poolId).toBe("0xc748f4671a867db48b552f6b7650bf3255e05f80f00e3f7aad1b17ccb7898fdb");
  });

  it("admits exact canonical state and day bytes and rejects digest or canonical-byte changes", () => {
    expect(decodeStockTokenExecutionIndexState(encodedState.gzip, "0000000000000001").state)
      .toEqual(state);
    expect(decodeStockTokenExecutionIndexDay(encodedDay.gzip, dayReference).day).toEqual(day);
    const changed = encodedDay.gzip.slice();
    changed[changed.length - 1] = changed.at(-1)! ^ 1;
    expect(() => decodeStockTokenExecutionIndexDay(changed, dayReference)).toThrow();
    const noncanonical = new Uint8Array(gzipSync(Buffer.from(JSON.stringify(day), "utf8")));
    expect(() => decodeStockTokenExecutionIndexDay(noncanonical, {
      ...dayReference,
      gzipBytes: noncanonical.byteLength,
      gzipSha256: sha256Bytes(noncanonical),
    })).toThrow();
  });

  it("keeps exact USDG executions and stale coverage separate from reference values", () => {
    const series = createStockTokenExecutionSeries({
      request,
      asset,
      state,
      stateSha256: encodedState.jsonSha256,
      days: [{ reference: dayReference, day, sha256: encodedDay.jsonSha256 }],
    });
    expect(series).toMatchObject({
      status: "available",
      freshness: "stale",
      source: { poolId: asset.poolId, quoteToken: { symbol: "USDG" } },
      coverage: {
        status: "partial",
        limitations: [
          "before_published_coverage",
          "after_published_coverage",
          "stale_index",
        ],
        observedCandleCount: 1,
      },
      candles: [candle],
    });
    expect(Object.keys(series)).not.toContain("emptyBucketStarts");
    expect(() => stockTokenExecutionSeriesSchema.parse({
      ...series,
      source: { ...(series.status === "available" ? series.source : {}), poolId: `0x${"ff".repeat(32)}` },
    })).toThrow();
  });

  it("keeps one contiguous recent suffix when the canonical result array bound is reached", () => {
    const days = Array.from({ length: 6 }, (_, dayIndex) => {
      const start = Date.UTC(2026, 7, 7 + dayIndex, 0, 0, 0, 0);
      const fromBlock = 40_000_000n + BigInt(dayIndex * 1_440);
      const candles = Array.from({ length: 1_440 }, (_, minute) => {
        const source = {
          ...sourcePosition,
          blockNumber: (fromBlock + BigInt(minute)).toString(),
          blockHash: `0x${(dayIndex + 1).toString(16).padStart(2, "0").repeat(32)}`,
          transactionHash: `0x${(minute + 1).toString(16).padStart(64, "0")}`,
        };
        return {
          ...candle,
          intervalStart: new Date(start + minute * 60_000).toISOString(),
          intervalEnd: new Date(start + (minute + 1) * 60_000).toISOString(),
          firstSource: source,
          lastSource: source,
        };
      });
      const dayValue = stockTokenExecutionIndexDaySchema.parse({
          ...day,
          day: new Date(start).toISOString().slice(0, 10),
          coverage: [{
            fromBlock: fromBlock.toString(),
            fromTimestamp: new Date(start).toISOString(),
            untilBlock: (fromBlock + 1_440n).toString(),
            untilTimestamp: new Date(start + 86_400_000).toISOString(),
          }],
          candles,
        });
      const encoded = encode(dayValue);
      const reference = {
        day: dayValue.day,
        releaseTag: `index-${dayValue.day.slice(0, 7)}`,
        assetName: `group-01-${dayValue.day}-g0000000000000001-${encoded.gzipSha256}.json.gz`,
        gzipBytes: encoded.gzip.byteLength,
        gzipSha256: encoded.gzipSha256,
        jsonBytes: encoded.json.byteLength,
        jsonSha256: encoded.jsonSha256,
      };
      return { reference, day: dayValue, sha256: encoded.jsonSha256 };
    });
    const stateValue = stockTokenExecutionIndexStateSchema.parse({
      ...state,
      nextBlock: "40008640",
      coveredUntilTimestamp: "2026-08-13T00:00:00.000Z",
      days: days.map((entry) => entry.reference),
    });
    const result = createStockTokenExecutionSeries({
      request: {
        token: asset.token,
        requestedStart: "2026-07-14T00:00:00.000Z",
        requestedEnd: "2026-08-13T00:00:00.000Z",
      },
      asset,
      state: stateValue,
      stateSha256: encode(stateValue).jsonSha256,
      days,
    });
    expect(result).toMatchObject({
      status: "available",
      coverage: {
        status: "partial",
        limitations: ["before_published_coverage", "candle_capacity"],
        observedCandleCount: 8_640,
      },
    });
    if (result.status !== "available") throw new Error("Expected an available series.");
    expect(result.candles).toHaveLength(3_072);
    expect(result.candles[0]?.intervalStart).toBe("2026-08-10T20:48:00.000Z");
    expect(result.candles.at(-1)?.intervalEnd).toBe("2026-08-13T00:00:00.000Z");
  });

  it("uses GitHub only as a bounded carrier and re-admits the same result after restart", async () => {
    const firstFetch = fetchFixture();
    const first = await createGitHubStockTokenExecutionIndex({ fetchImplementation: firstFetch })
      .read(request);
    const second = await createGitHubStockTokenExecutionIndex({ fetchImplementation: fetchFixture() })
      .read(request);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ status: "available", candles: [candle] });
    expect(canonicalJsonStringify(first as CanonicalJson)).not.toMatch(/github|release|assetName|url/iu);
    expect(firstFetch).toHaveBeenCalledTimes(3);
  });

  it("fails only the execution series when the selected immutable day is corrupted", async () => {
    const changed = encodedDay.gzip.slice();
    changed[changed.length - 1] = changed.at(-1)! ^ 1;
    await expect(createGitHubStockTokenExecutionIndex({ fetchImplementation: fetchFixture(changed) })
      .read(request)).resolves.toMatchObject({
        status: "unavailable",
        reason: "index_inconsistent",
      });
  });

  it("does not call the carrier for an asset outside the admitted registry", async () => {
    const fetchImplementation = fetchFixture();
    await expect(createGitHubStockTokenExecutionIndex({ fetchImplementation }).read({
      ...request,
      token: parseEvmAddress("0x0000000000000000000000000000000000000001"),
    })).resolves.toMatchObject({ status: "unavailable", reason: "asset_not_indexed" });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("distinguishes a request outside retained coverage without requesting a day artifact", async () => {
    const fetchImplementation = fetchFixture();
    await expect(createGitHubStockTokenExecutionIndex({ fetchImplementation }).read({
      ...request,
      requestedStart: "2025-08-12T00:00:00.000Z",
      requestedEnd: "2025-08-13T00:00:00.000Z",
    })).resolves.toMatchObject({
      status: "unavailable",
      reason: "outside_published_coverage",
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("bounds the carrier deadline and translates only that deadline to index unavailability", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    try {
      const fetchImplementation = vi.fn<typeof fetch>(async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }));
      const pending = createGitHubStockTokenExecutionIndex({ fetchImplementation }).read(request);
      deadline.abort();
      await expect(pending).resolves.toMatchObject({
        status: "unavailable",
        reason: "index_unavailable",
      });
      expect(timeout).toHaveBeenCalledWith(30_000);
    } finally {
      timeout.mockRestore();
    }
  });

  it("preserves caller cancellation instead of translating it into index unavailability", async () => {
    const controller = new AbortController();
    const fetchImplementation = vi.fn<typeof fetch>(async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
          once: true,
        });
      }));
    const pending = createGitHubStockTokenExecutionIndex({ fetchImplementation })
      .read(request, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
  });
});
