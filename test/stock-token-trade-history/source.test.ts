import { describe, expect, it, vi } from "vitest";

import {
  createStockTokenTradeHistorySource,
} from "../../src/stock-token-trade-history/source.js";
import {
  isStockTokenTradeHistorySourceRateLimitError,
  isStockTokenTradeHistoryProviderCleanupError,
  parseStockTokenTradeHistorySourceInput,
  stockTokenTradeHistorySourceContract,
  stockTokenTradeHistorySourceLimits,
  StockTokenTradeHistoryProviderCleanupError,
  type StockTokenTradeHistoryProviderTransport,
  type StockTokenTradeHistorySourceInput,
} from "../../src/stock-token-trade-history/source-contract.js";
import {
  createStockTokenTradeHistoryMultiMonthSourceFixture,
  createStockTokenTradeHistorySourceFixture,
} from "./source-fixture.js";

const request = (
  overrides: Readonly<Record<string, unknown>> = {},
): StockTokenTradeHistorySourceInput => parseStockTokenTradeHistorySourceInput({
  baseCurrencyAddress: "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9",
  baseCurrencyDecimals: 18,
  requestedStart: "2026-08-23T07:00:00.000Z",
  requestedEnd: "2026-08-24T07:00:00.000Z",
  canonicalBlock: {
    chainId: "eip155:4663",
    blockNumber: "100",
    blockHash: `0x${"e".repeat(64)}`,
    blockTimestamp: "2026-08-24T07:00:00.000Z",
  },
  resolution: "15m",
  ...overrides,
});

const withCatalog = (
  base: StockTokenTradeHistoryProviderTransport,
  readCatalog: StockTokenTradeHistoryProviderTransport["readCatalog"],
): StockTokenTradeHistoryProviderTransport => Object.freeze({ ...base, readCatalog });

describe("StockTokenTradeHistorySource", () => {
  it("owns the current initial source parameters", () => {
    expect(stockTokenTradeHistorySourceLimits).toEqual({
      catalogResponseBytes: 2_097_152,
      rootCompressedBytes: 23_068_672,
      rootDecodedBytes: 23_068_672,
      memberCompressedBytes: 8_388_608,
      memberDecodedBytes: 8_388_608,
      cumulativeTransportBytes: 67_108_864,
      cumulativeDecodedBytes: 33_554_432,
      rootAssets: 16_384,
      rootBaseCurrencies: 513,
      rootLogicalIds: 255_474,
      statePoolPeriods: 512,
      statePools: 512,
      stateMonths: 13,
      monthCoverageSegments: 512,
      monthDayReferences: 31,
      resolutionCoverageSegments: 512,
      resolutionCandles: 2_976,
      concurrentMemberReads: 2,
      deadlineMilliseconds: 60_000,
    });
    expect(stockTokenTradeHistorySourceContract.maximumRedirects).toBe(5);
  });

  it("returns one admitted source result without reading a day or full packed asset", async () => {
    const fixture = createStockTokenTradeHistorySourceFixture();
    const memberReads: Array<Readonly<{ assetName: string; from: number; until: number }>> = [];
    const transport: StockTokenTradeHistoryProviderTransport = Object.freeze({
      ...fixture.transport,
      async readMember(
        input: Parameters<StockTokenTradeHistoryProviderTransport["readMember"]>[0],
        signal: AbortSignal,
      ) {
        memberReads.push({ assetName: input.assetName, from: input.from, until: input.until });
        return fixture.transport.readMember(input, signal);
      },
    });
    const source = createStockTokenTradeHistorySource({
      transport,
      now: () => new Date("2026-08-24T07:01:02.345Z"),
    });

    const result = await source.read(request());
    expect(result).toMatchObject({
      status: "available",
      observedAt: "2026-08-24T07:01:02.000Z",
      root: { publicationSequence: 12 },
      base: {
        baseCurrencyAddress: fixture.baseAddress,
        poolPeriods: [{
          fromBlock: "10",
          fromTimestamp: "2026-06-01T00:00:00.000Z",
        }],
      },
      ownerMonths: [{
        ownerMonth: "2026-08",
        resolution: {
          label: "15m",
          coverage: [{
            fromBlock: "50",
            fromTimestamp: "2026-08-01T00:00:00.000Z",
          }],
          candles: [{
            intervalStart: "2026-08-24T06:45:00.000Z",
            intervalEnd: "2026-08-24T07:00:00.000Z",
            tradeCount: "2",
          }],
        },
      }],
    });
    expect("coverage" in result).toBe(false);
    expect("candles" in result).toBe(false);
    expect("members" in result).toBe(false);
    if (result.status !== "available") throw new TypeError("Expected available source fixture.");
    expect(result.base.poolPeriods).toHaveLength(1);
    expect(result.ownerMonths[0]!.month.coverage).toHaveLength(2);
    expect(result.ownerMonths[0]!.resolution.coverage).toHaveLength(1);
    expect(memberReads).toHaveLength(3);
    expect(memberReads.every((read) => read.until > read.from)).toBe(true);
    await source.close();
  });

  it("preserves distinct producer-valid state, month, resolution, member, and candle roles", async () => {
    const fixture = createStockTokenTradeHistoryMultiMonthSourceFixture();
    let memberReads = 0;
    const source = createStockTokenTradeHistorySource({
      transport: Object.freeze({
        ...fixture.transport,
        async readMember(
          input: Parameters<StockTokenTradeHistoryProviderTransport["readMember"]>[0],
          signal: AbortSignal,
        ) {
          memberReads += 1;
          return fixture.transport.readMember(input, signal);
        },
      }),
    });
    const result = await source.read(request({
      requestedStart: "2026-07-31T23:00:00.000Z",
      requestedEnd: "2026-08-01T01:00:00.000Z",
      canonicalBlock: {
        chainId: "eip155:4663",
        blockNumber: "30",
        blockHash: `0x${"7".repeat(64)}`,
        blockTimestamp: "2026-08-01T01:00:00.000Z",
      },
    }));

    if (result.status !== "available") throw new TypeError("Expected available multi-month source.");
    expect(result.base.poolPeriods).toHaveLength(1);
    expect(result.ownerMonths.map((entry) => entry.ownerMonth)).toEqual(["2026-07", "2026-08"]);
    expect(result.ownerMonths.every((entry) => entry.month.coverage.length === 2)).toBe(true);
    expect(result.ownerMonths.every((entry) => entry.resolution.coverage.length === 1)).toBe(true);
    expect(result.ownerMonths.every((entry) => entry.resolution.candles.length === 1)).toBe(true);
    expect(new Set(result.ownerMonths.flatMap((entry) => [
      entry.month.member.logicalId,
      entry.resolution.member.logicalId,
    ])).size).toBe(4);
    expect(memberReads).toBe(5);
    await source.close();
  });

  it("owns provider terminal precedence and source scope", async () => {
    const fixture = createStockTokenTradeHistorySourceFixture();
    const cases = [
      {
        status: "capacity_exceeded" as const,
        expected: { reason: "trade_history_too_large", scope: "catalog_root" },
      },
      {
        status: "unavailable" as const,
        expected: { reason: "trade_history_unavailable", scope: "catalog_root" },
      },
      {
        status: "absent" as const,
        expected: { reason: "trade_history_unavailable", scope: "catalog_root" },
      },
    ];
    for (const testCase of cases) {
      const source = createStockTokenTradeHistorySource({
        transport: withCatalog(fixture.transport, async () => Object.freeze({ status: testCase.status })),
      });
      await expect(source.read(request())).resolves.toMatchObject({
        status: "unavailable",
        ...testCase.expected,
      });
      await source.close();
    }

    const overflow = createStockTokenTradeHistorySource({
      transport: withCatalog(fixture.transport, async () => Object.freeze({
        status: "read",
        value: Object.freeze({ assets: Object.freeze([]), overflow: true, transferredBytes: 1 }),
      })),
    });
    await expect(overflow.read(request())).resolves.toMatchObject({
      status: "unavailable",
      reason: "trade_history_inconsistent",
      scope: "catalog_root",
    });
    await overflow.close();
  });

  it("classifies a producer-invalid physical root before product capacity", async () => {
    const fixture = createStockTokenTradeHistorySourceFixture();
    let rootReads = 0;
    const source = createStockTokenTradeHistorySource({
      transport: Object.freeze({
        ...withCatalog(fixture.transport, async () => Object.freeze({
          status: "read" as const,
          value: Object.freeze({
            assets: Object.freeze([{
              name: `root-s1-${"a".repeat(64)}.json.gz`,
              bytes: stockTokenTradeHistorySourceContract.maximumPhysicalAssetBytes + 1,
            }]),
            overflow: false,
            transferredBytes: 1,
          }),
        })),
        async readRoot() {
          rootReads += 1;
          return Object.freeze({ status: "absent" as const });
        },
      }),
    });

    await expect(source.read(request())).resolves.toMatchObject({
      status: "unavailable",
      reason: "trade_history_inconsistent",
      scope: "catalog_root",
    });
    expect(rootReads).toBe(0);
    await source.close();
  });

  it("keeps rate limiting outside the source result union", async () => {
    const fixture = createStockTokenTradeHistorySourceFixture();
    const source = createStockTokenTradeHistorySource({
      transport: withCatalog(fixture.transport, async () => Object.freeze({ status: "rate_limited" })),
    });
    await expect(source.read(request())).rejects.toSatisfy(
      isStockTokenTradeHistorySourceRateLimitError,
    );
    await source.close();
  });

  it("does not substitute an older root when selected root bytes are inconsistent", async () => {
    const fixture = createStockTokenTradeHistorySourceFixture();
    const corrupt = fixture.rootBytes.slice();
    corrupt[corrupt.length - 1] = (corrupt[corrupt.length - 1] ?? 0) ^ 1;
    const rootReads: string[] = [];
    const source = createStockTokenTradeHistorySource({
      transport: Object.freeze({
        ...withCatalog(fixture.transport, async () => Object.freeze({
          status: "read" as const,
          value: Object.freeze({
            assets: Object.freeze([{
              name: `root-s11-${"a".repeat(64)}.json.gz`,
              bytes: 1,
            }, {
              name: fixture.rootName,
              bytes: fixture.rootBytes.byteLength,
            }]),
            overflow: false,
            transferredBytes: 128,
          }),
        })),
        async readRoot(name: string) {
          rootReads.push(name);
          return Object.freeze({
            status: "read" as const,
            value: Object.freeze({ bytes: corrupt, identityEncoding: true }),
          });
        },
      }),
    });
    await expect(source.read(request())).resolves.toMatchObject({
      status: "unavailable",
      reason: "trade_history_inconsistent",
      scope: "catalog_root",
    });
    expect(rootReads).toEqual([fixture.rootName]);
    await source.close();
  });

  it("does not repin after a pinned root or selected member disappears", async () => {
    const fixture = createStockTokenTradeHistorySourceFixture();
    let catalogReads = 0;
    const missingRoot = createStockTokenTradeHistorySource({
      transport: Object.freeze({
        ...fixture.transport,
        async readCatalog(
          ...args: Parameters<StockTokenTradeHistoryProviderTransport["readCatalog"]>
        ): ReturnType<StockTokenTradeHistoryProviderTransport["readCatalog"]> {
          catalogReads += 1;
          return fixture.transport.readCatalog(...args);
        },
        async readRoot() { return Object.freeze({ status: "absent" as const }); },
      }),
    });
    await expect(missingRoot.read(request())).resolves.toMatchObject({
      status: "unavailable",
      reason: "trade_history_unavailable",
      scope: "catalog_root",
    });
    expect(catalogReads).toBe(1);
    await missingRoot.close();

    catalogReads = 0;
    let memberReads = 0;
    const missingMember = createStockTokenTradeHistorySource({
      transport: Object.freeze({
        ...fixture.transport,
        async readCatalog(
          ...args: Parameters<StockTokenTradeHistoryProviderTransport["readCatalog"]>
        ): ReturnType<StockTokenTradeHistoryProviderTransport["readCatalog"]> {
          catalogReads += 1;
          return fixture.transport.readCatalog(...args);
        },
        async readMember() {
          memberReads += 1;
          return Object.freeze({ status: "absent" as const });
        },
      }),
    });
    await expect(missingMember.read(request())).resolves.toMatchObject({
      status: "unavailable",
      reason: "trade_history_unavailable",
      scope: "selected_base",
    });
    expect(catalogReads).toBe(1);
    expect(memberReads).toBe(1);
    await missingMember.close();
  });

  it("classifies encoded root bytes beyond their catalog identity as inconsistent", async () => {
    const fixture = createStockTokenTradeHistorySourceFixture();
    const source = createStockTokenTradeHistorySource({
      transport: Object.freeze({
        ...fixture.transport,
        async readRoot() { return Object.freeze({ status: "capacity_exceeded" as const }); },
      }),
    });

    await expect(source.read(request())).resolves.toMatchObject({
      status: "unavailable",
      reason: "trade_history_inconsistent",
      scope: "catalog_root",
    });
    await source.close();
  });

  it("distinguishes an absent selected base from a request outside admitted coverage", async () => {
    const fixture = createStockTokenTradeHistorySourceFixture();
    const unsupported = createStockTokenTradeHistorySource({
      transport: fixture.transport,
    });
    await expect(unsupported.read(request({
      baseCurrencyAddress: "0x1111111111111111111111111111111111111111",
    }))).resolves.toMatchObject({
      status: "unavailable",
      reason: "asset_not_supported",
      scope: "selected_base",
      root: { publicationSequence: 12 },
    });
    await unsupported.close();

    const outside = createStockTokenTradeHistorySource({
      transport: fixture.transport,
    });
    await expect(outside.read(request({
      requestedStart: "2026-08-25T07:00:00.000Z",
      requestedEnd: "2026-08-26T07:00:00.000Z",
      canonicalBlock: {
        chainId: "eip155:4663",
        blockNumber: "200",
        blockHash: `0x${"f".repeat(64)}`,
        blockTimestamp: "2026-08-26T07:00:00.000Z",
      },
    }))).resolves.toMatchObject({
      status: "unavailable",
      reason: "outside_published_coverage",
      scope: "selected_period",
      root: { publicationSequence: 12 },
      base: { baseCurrencyAddress: fixture.baseAddress },
    });
    await outside.close();
  });

  it("rejects archive decimals that differ from the verified source input", async () => {
    const fixture = createStockTokenTradeHistorySourceFixture();
    const source = createStockTokenTradeHistorySource({
      transport: fixture.transport,
    });

    await expect(source.read(request({ baseCurrencyDecimals: 17 }))).resolves.toMatchObject({
      status: "unavailable",
      reason: "trade_history_inconsistent",
      scope: "selected_base",
    });
    await source.close();
  });

  it("rejects resolution coverage that drops part of its owner-month block range", async () => {
    const fixture = createStockTokenTradeHistorySourceFixture({ resolutionFromBlock: "51" });
    const source = createStockTokenTradeHistorySource({
      transport: fixture.transport,
    });

    await expect(source.read(request())).resolves.toMatchObject({
      status: "unavailable",
      reason: "trade_history_inconsistent",
      scope: "selected_period",
    });
    await source.close();
  });

  it("rejects a declared member envelope before starting its transfer", async () => {
    const fixture = createStockTokenTradeHistorySourceFixture({
      stateJsonBytes: stockTokenTradeHistorySourceLimits.memberDecodedBytes + 1,
    });
    let memberReads = 0;
    const source = createStockTokenTradeHistorySource({
      transport: Object.freeze({
        ...fixture.transport,
        async readMember() {
          memberReads += 1;
          return Object.freeze({ status: "absent" as const });
        },
      }),
    });

    await expect(source.read(request())).resolves.toMatchObject({
      status: "unavailable",
      reason: "trade_history_too_large",
      scope: "selected_base",
    });
    expect(memberReads).toBe(0);
    await source.close();
  });

  it("classifies encoded member bytes beyond their reference identity as inconsistent", async () => {
    const fixture = createStockTokenTradeHistorySourceFixture();
    let memberReads = 0;
    const source = createStockTokenTradeHistorySource({
      transport: Object.freeze({
        ...fixture.transport,
        async readMember() {
          memberReads += 1;
          return Object.freeze({ status: "capacity_exceeded" as const });
        },
      }),
    });

    await expect(source.read(request())).resolves.toMatchObject({
      status: "unavailable",
      reason: "trade_history_inconsistent",
      scope: "selected_base",
    });
    expect(memberReads).toBe(1);
    await source.close();
  });

  it("stops new member work and aborts an active sibling after a terminal result", async () => {
    const fixture = createStockTokenTradeHistorySourceFixture();
    let memberReads = 0;
    let siblingAborted = false;
    const source = createStockTokenTradeHistorySource({
      transport: Object.freeze({
        ...fixture.transport,
        readMember(
          input: Parameters<StockTokenTradeHistoryProviderTransport["readMember"]>[0],
          signal: AbortSignal,
        ): ReturnType<StockTokenTradeHistoryProviderTransport["readMember"]> {
          memberReads += 1;
          if (memberReads === 1) return fixture.transport.readMember(input, signal);
          if (memberReads === 2) {
            return Promise.resolve(Object.freeze({ status: "absent" as const }));
          }
          if (memberReads === 3) {
            return new Promise((resolve) => {
              const timeout = setTimeout(() => resolve(Object.freeze({ status: "absent" as const })), 10);
              const stop = (): void => {
                siblingAborted = true;
                clearTimeout(timeout);
                resolve(Object.freeze({ status: "absent" as const }));
              };
              if (signal.aborted) stop();
              else signal.addEventListener("abort", stop, { once: true });
            });
          }
          return fixture.transport.readMember(input, signal);
        },
      }),
    });

    await expect(source.read(request({
      requestedStart: "2026-06-01T00:00:00.000Z",
    }))).resolves.toMatchObject({
      status: "unavailable",
      reason: "trade_history_unavailable",
      scope: "selected_period",
    });
    expect(memberReads).toBe(3);
    expect(siblingAborted).toBe(true);
    await source.close();
  });

  it("uses canonical member order when a later member fails first", async () => {
    const fixture = createStockTokenTradeHistorySourceFixture();
    let memberReads = 0;
    let earlierAborted = false;
    const source = createStockTokenTradeHistorySource({
      transport: Object.freeze({
        ...fixture.transport,
        async readMember(
          input: Parameters<StockTokenTradeHistoryProviderTransport["readMember"]>[0],
          signal: AbortSignal,
        ): ReturnType<StockTokenTradeHistoryProviderTransport["readMember"]> {
          memberReads += 1;
          if (memberReads === 1) return fixture.transport.readMember(input, signal);
          if (memberReads === 2) {
            await new Promise<void>((resolve) => {
              const timeout = setTimeout(resolve, 15);
              signal.addEventListener("abort", () => {
                earlierAborted = true;
                clearTimeout(timeout);
                resolve();
              }, { once: true });
            });
            return fixture.transport.readMember(input, signal);
          }
          if (memberReads === 3) return Object.freeze({ status: "absent" as const });
          return fixture.transport.readMember(input, signal);
        },
      }),
    });

    await expect(source.read(request({
      requestedStart: "2026-06-01T00:00:00.000Z",
    }))).resolves.toMatchObject({
      status: "unavailable",
      reason: "trade_history_inconsistent",
      scope: "selected_period",
    });
    expect(memberReads).toBe(3);
    expect(earlierAborted).toBe(false);
    await source.close();
  });

  it("accepts a healthy root newer than the canonical request and excludes future candles", async () => {
    const fixture = createStockTokenTradeHistorySourceFixture();
    const source = createStockTokenTradeHistorySource({
      transport: fixture.transport,
    });
    const result = await source.read(request({
      requestedStart: "2026-08-23T06:30:00.000Z",
      requestedEnd: "2026-08-24T06:30:00.000Z",
      canonicalBlock: {
        chainId: "eip155:4663",
        blockNumber: "90",
        blockHash: `0x${"9".repeat(64)}`,
        blockTimestamp: "2026-08-24T06:30:00.000Z",
      },
    }));
    expect(result).toMatchObject({
      status: "available",
      root: { publicationSequence: 12 },
      ownerMonths: [{ resolution: { candles: [] } }],
    });
    await source.close();
  });

  it("preserves cleanup failure instead of publishing a concurrent source terminal", async () => {
    const fixture = createStockTokenTradeHistorySourceFixture();
    let memberReads = 0;
    const cleanup = new StockTokenTradeHistoryProviderCleanupError([new Error("cleanup failed")]);
    const source = createStockTokenTradeHistorySource({
      transport: Object.freeze({
        ...fixture.transport,
        readMember(
          input: Parameters<StockTokenTradeHistoryProviderTransport["readMember"]>[0],
          signal: AbortSignal,
        ): ReturnType<StockTokenTradeHistoryProviderTransport["readMember"]> {
          memberReads += 1;
          if (memberReads === 1) return fixture.transport.readMember(input, signal);
          if (memberReads === 2) return Promise.resolve(Object.freeze({ status: "absent" as const }));
          throw cleanup;
        },
      }),
    });

    const failure = await source.read(request({
      requestedStart: "2026-06-01T00:00:00.000Z",
    })).then(() => undefined, (error: unknown) => error);
    expect(isStockTokenTradeHistoryProviderCleanupError(failure)).toBe(true);
    const cause = (failure as Error & { readonly cause?: unknown }).cause;
    expect(cause).toBeInstanceOf(AggregateError);
    expect((cause as AggregateError).errors[0]).toMatchObject({ name: "SourceTerminal" });
    expect((cause as AggregateError).errors[1]).toBe(cleanup);
    const close = source.close();
    await expect(close).rejects.toBe(failure);
    expect(source.close()).toBe(close);
  });

  it("checks caller cancellation before publishing a source terminal", async () => {
    const fixture = createStockTokenTradeHistorySourceFixture();
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    const source = createStockTokenTradeHistorySource({
      transport: withCatalog(fixture.transport, async () => Object.freeze({ status: "absent" })),
      now: () => {
        controller.abort(reason);
        return new Date("2026-08-24T07:01:00.000Z");
      },
    });

    await expect(source.read(request(), controller.signal)).rejects.toBe(reason);
    await source.close();
  });

  it("maps the whole-source deadline to provider unavailability after settlement", async () => {
    vi.useFakeTimers();
    try {
      const fixture = createStockTokenTradeHistorySourceFixture();
      const source = createStockTokenTradeHistorySource({
        transport: Object.freeze({
          ...fixture.transport,
          readCatalog(
            _maximumResponseBytes: number,
            _maximumTotalBytes: number,
            _maximumAssets: number,
            signal: AbortSignal,
          ): ReturnType<StockTokenTradeHistoryProviderTransport["readCatalog"]> {
            return new Promise((_, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
          },
        }),
      });
      const read = source.read(request());
      await vi.advanceTimersByTimeAsync(stockTokenTradeHistorySourceLimits.deadlineMilliseconds);
      await expect(read).resolves.toMatchObject({
        status: "unavailable",
        reason: "trade_history_unavailable",
        scope: "catalog_root",
      });
      await source.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes by aborting and settling an active source read", async () => {
    const fixture = createStockTokenTradeHistorySourceFixture();
    let entered!: () => void;
    const readStarted = new Promise<void>((resolve) => { entered = resolve; });
    const source = createStockTokenTradeHistorySource({
      transport: Object.freeze({
        ...fixture.transport,
        readCatalog(
          _maximumResponseBytes: number,
          _maximumTotalBytes: number,
          _maximumAssets: number,
          signal: AbortSignal,
        ): ReturnType<StockTokenTradeHistoryProviderTransport["readCatalog"]> {
          entered();
          return new Promise((_, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
      }),
    });

    const read = source.read(request());
    await readStarted;
    const close = source.close();
    await expect(read).rejects.toMatchObject({ name: "StockTokenTradeHistorySourceClosedError" });
    await expect(close).resolves.toBeUndefined();
    await expect(source.read(request())).rejects.toMatchObject({
      name: "StockTokenTradeHistorySourceClosedError",
    });
  });

  it("registers a read before provider work can reenter close", async () => {
    const fixture = createStockTokenTradeHistorySourceFixture();
    let source!: ReturnType<typeof createStockTokenTradeHistorySource>;
    let close!: Promise<void>;
    let releaseCatalog!: () => void;
    let entered!: () => void;
    const readStarted = new Promise<void>((resolve) => { entered = resolve; });
    const catalog = new Promise<Awaited<ReturnType<
      StockTokenTradeHistoryProviderTransport["readCatalog"]
    >>>((resolve) => {
      releaseCatalog = () => resolve(Object.freeze({
        status: "read" as const,
        value: Object.freeze({
          assets: Object.freeze([]),
          overflow: false,
          transferredBytes: 2,
        }),
      }));
    });
    source = createStockTokenTradeHistorySource({
      transport: Object.freeze({
        ...fixture.transport,
        readCatalog() {
          entered();
          close = source.close();
          return catalog;
        },
      }),
    });

    const read = source.read(request());
    await readStarted;
    let closeSettled = false;
    void close.then(() => { closeSettled = true; });
    await Promise.resolve();
    const closeSettledBeforeRelease = closeSettled;

    releaseCatalog();
    const [readSettlement, closeSettlement] = await Promise.allSettled([read, close]);
    expect(closeSettledBeforeRelease).toBe(false);
    expect(readSettlement).toMatchObject({
      status: "rejected",
      reason: { name: "StockTokenTradeHistorySourceClosedError" },
    });
    expect(closeSettlement).toEqual({
      status: "fulfilled",
      value: undefined,
    });
  });

  it("publishes one close completion before abort listeners can reenter", async () => {
    const fixture = createStockTokenTradeHistorySourceFixture();
    let source!: ReturnType<typeof createStockTokenTradeHistorySource>;
    let reentrantClose: Promise<void> | undefined;
    let entered!: () => void;
    const readStarted = new Promise<void>((resolve) => { entered = resolve; });
    let announceReentry!: () => void;
    const reentered = new Promise<void>((resolve) => { announceReentry = resolve; });
    source = createStockTokenTradeHistorySource({
      transport: Object.freeze({
        ...fixture.transport,
        readCatalog(
          _maximumResponseBytes: number,
          _maximumTotalBytes: number,
          _maximumAssets: number,
          signal: AbortSignal,
        ): ReturnType<StockTokenTradeHistoryProviderTransport["readCatalog"]> {
          entered();
          return new Promise((_, reject) => {
            signal.addEventListener("abort", () => {
              reentrantClose = source.close();
              announceReentry();
              reject(signal.reason);
            }, { once: true });
          });
        },
      }),
    });

    const read = source.read(request());
    await readStarted;
    const close = source.close();
    await reentered;
    const observedReentrantClose = reentrantClose;
    const [readSettlement, closeSettlement, reentrantSettlement] = await Promise.allSettled([
      read,
      close,
      observedReentrantClose ?? Promise.resolve(),
    ]);
    expect(observedReentrantClose).toBe(close);
    expect(readSettlement).toMatchObject({
      status: "rejected",
      reason: { name: "StockTokenTradeHistorySourceClosedError" },
    });
    expect(closeSettlement).toEqual({
      status: "fulfilled",
      value: undefined,
    });
    expect(reentrantSettlement).toEqual({
      status: "fulfilled",
      value: undefined,
    });
  });

  it("rejects close when an admitted read cannot complete provider cleanup", async () => {
    const fixture = createStockTokenTradeHistorySourceFixture();
    let entered!: () => void;
    const readStarted = new Promise<void>((resolve) => { entered = resolve; });
    const cleanup = new StockTokenTradeHistoryProviderCleanupError([new Error("cleanup failed")]);
    const source = createStockTokenTradeHistorySource({
      transport: Object.freeze({
        ...fixture.transport,
        readCatalog(
          _maximumResponseBytes: number,
          _maximumTotalBytes: number,
          _maximumAssets: number,
          signal: AbortSignal,
        ): ReturnType<StockTokenTradeHistoryProviderTransport["readCatalog"]> {
          entered();
          return new Promise((_, reject) => {
            signal.addEventListener("abort", () => reject(cleanup), { once: true });
          });
        },
      }),
    });

    const read = source.read(request());
    await readStarted;
    const close = source.close();
    const [readSettlement, closeSettlement] = await Promise.allSettled([read, close]);
    expect(readSettlement.status).toBe("rejected");
    expect(closeSettlement.status).toBe("rejected");
    if (readSettlement.status !== "rejected" || closeSettlement.status !== "rejected") return;
    expect(isStockTokenTradeHistoryProviderCleanupError(readSettlement.reason)).toBe(true);
    expect(closeSettlement.reason).toBe(readSettlement.reason);
    const cause = (readSettlement.reason as Error & { readonly cause?: unknown }).cause;
    expect(cause).toBeInstanceOf(AggregateError);
    expect((cause as AggregateError).errors[0]).toMatchObject({
      name: "StockTokenTradeHistorySourceClosedError",
    });
    expect((cause as AggregateError).errors[1]).toBe(cleanup);
    expect(source.close()).toBe(close);
  });
});
