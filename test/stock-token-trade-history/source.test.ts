import { describe, expect, it, vi } from "vitest";

import {
  createStockTokenTradeHistorySource,
} from "../../src/stock-token-trade-history/source.js";
import {
  isStockTokenTradeHistorySourceRateLimitError,
  isStockTokenTradeHistoryProviderCleanupError,
  parseStockTokenTradeHistorySourceInput,
  stockTokenTradeHistoryProducerAdmission,
  stockTokenTradeHistorySourceLimits,
  StockTokenTradeHistoryProviderCleanupError,
  type StockTokenTradeHistoryProviderTransport,
  type StockTokenTradeHistorySourceInput,
} from "../../src/stock-token-trade-history/source-contract.js";
import {
  deriveStockTokenTradeHistoryPublicData,
} from "../../src/stock-token-trade-history/source-semantics.js";
import {
  createStockTokenTradeHistoryCoverageConflictFixture,
  createStockTokenTradeHistoryCrossPoolFixture,
  createStockTokenTradeHistoryDeclaredTooLargeFixture,
  createStockTokenTradeHistoryIncompleteWithSwapFixture,
  createStockTokenTradeHistoryMultiMonthSourceFixture,
  createStockTokenTradeHistoryPositivePreviousOwnerFixture,
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
  });

  it("rejects a non-canonical resolution before provider work", async () => {
    const fixture = createStockTokenTradeHistorySourceFixture();
    let catalogReads = 0;
    const source = createStockTokenTradeHistorySource({
      transport: Object.freeze({
        ...fixture.transport,
        async readCatalog(
          ...args: Parameters<StockTokenTradeHistoryProviderTransport["readCatalog"]>
        ): ReturnType<StockTokenTradeHistoryProviderTransport["readCatalog"]> {
          catalogReads += 1;
          return fixture.transport.readCatalog(...args);
        },
      }),
    });
    await expect(source.read({ ...request(), resolution: "30m" })).rejects.toThrow(
      "resolution is not canonical",
    );
    expect(catalogReads).toBe(0);
    await source.close();
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

    const sourceInput = request();
    const result = await source.read(sourceInput);
    expect(result).toMatchObject({
      status: "available",
      observedAt: "2026-08-24T07:01:02.000Z",
      root: { publicationSequence: 12 },
      base: {
        baseCurrencyAddress: fixture.baseAddress,
      },
      coverage: [{
        fromBlock: "50",
        fromTimestamp: "2026-08-01T00:00:00.000Z",
      }],
      coverageOwnerMonths: ["2026-08"],
      monthMembers: [{
        ownerMonth: "2026-08",
        member: { logicalId: `base/${fixture.baseAddress}/month/2026-08` },
      }],
      resolutionMembers: [{
        ownerMonth: "2026-08",
        member: { logicalId: `base/${fixture.baseAddress}/resolution/15m/2026-08` },
      }],
      candles: [{
        intervalStart: "2026-08-24T06:45:00.000Z",
        intervalEnd: "2026-08-24T07:00:00.000Z",
        tradeCount: "2",
      }],
    });
    expect("members" in result).toBe(false);
    if (result.status !== "available") throw new TypeError("Expected available source fixture.");
    expect(result.coverage).toHaveLength(1);
    const poolKey = Object.values(result.pools)[0]!;
    expect(Object.keys(poolKey).sort()).toEqual([
      "currency0", "currency1", "fee", "hooks", "tickSpacing",
    ]);
    expect(memberReads).toHaveLength(3);
    expect(memberReads.every((read) => read.until > read.from)).toBe(true);
    const publicData = deriveStockTokenTradeHistoryPublicData({
      sourceInput,
      coverage: result.coverage,
      resolutionOwnerMonths: result.resolutionMembers.map((entry) => entry.ownerMonth),
      candles: result.candles,
    });
    expect(publicData.positions[0]).toMatchObject({
      coverage: "complete",
      poolId: expect.any(String),
      candle: null,
    });
    expect(publicData.positions.at(-1)).toMatchObject({
      coverage: "complete",
      poolId: expect.any(String),
      candle: { tradeCount: "2" },
    });
    await source.close();
  });

  it("keeps coverage and resolution member roles separate across owner months", async () => {
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
      requestedStart: "2025-07-01T01:00:00.000Z",
      requestedEnd: "2026-07-01T01:00:00.000Z",
      canonicalBlock: {
        chainId: "eip155:4663",
        blockNumber: "30",
        blockHash: `0x${"7".repeat(64)}`,
        blockTimestamp: "2026-07-01T01:00:00.000Z",
      },
      resolution: "2d",
    }));

    if (result.status !== "available") throw new TypeError("Expected available multi-month source.");
    expect(result.coverage).toHaveLength(1);
    expect(result.coverageOwnerMonths).toEqual(["2026-06", "2026-07"]);
    expect(result.monthMembers.map((entry) => entry.ownerMonth)).toEqual(["2026-06", "2026-07"]);
    expect(result.resolutionMembers).toEqual([]);
    expect(result.candles).toHaveLength(0);
    expect(new Set(result.monthMembers.map((entry) => entry.member.logicalId)).size).toBe(2);
    expect(memberReads).toBe(3);
    await source.close();
  });

  it("retains an unchanged candle when the request cuts its natural interval", async () => {
    const fixture = createStockTokenTradeHistorySourceFixture();
    const source = createStockTokenTradeHistorySource({ transport: fixture.transport });
    const result = await source.read(request({
      requestedStart: "2026-08-23T07:01:00.000Z",
      requestedEnd: "2026-08-24T06:50:00.000Z",
      canonicalBlock: {
        chainId: "eip155:4663",
        blockNumber: "100",
        blockHash: `0x${"e".repeat(64)}`,
        blockTimestamp: "2026-08-24T06:50:00.000Z",
      },
    }));
    if (result.status !== "available") throw new TypeError("Expected available source fixture.");
    expect(result.candles.map((candle) => [candle.intervalStart, candle.intervalEnd])).toEqual([
      ["2026-08-24T06:45:00.000Z", "2026-08-24T07:00:00.000Z"],
    ]);
    expect(result.resolutionMembers.map((entry) => entry.ownerMonth)).toEqual(["2026-08"]);
    await source.close();
  });

  it("reads the preceding resolution owner for a request-cut positive candle", async () => {
    const fixture = createStockTokenTradeHistoryPositivePreviousOwnerFixture();
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
    const sourceInput = request({
      requestedStart: "2026-09-01T00:01:00.000Z",
      requestedEnd: "2027-09-01T00:01:00.000Z",
      canonicalBlock: {
        chainId: "eip155:4663",
        blockNumber: "10000000",
        blockHash: `0x${"8".repeat(64)}`,
        blockTimestamp: "2027-09-01T00:01:00.000Z",
      },
      resolution: "2d",
    });
    const result = await source.read(sourceInput);
    if (result.status !== "available") throw new TypeError("Expected positive edge source.");
    expect(result.coverageOwnerMonths).toEqual(["2026-08", "2026-09"]);
    expect(result.monthMembers.map((entry) => entry.ownerMonth)).toEqual([
      "2026-08", "2026-09",
    ]);
    expect(result.resolutionMembers.map((entry) => entry.ownerMonth)).toEqual(["2026-08"]);
    expect(result.candles.map((candle) => [candle.intervalStart, candle.intervalEnd])).toEqual([
      ["2026-08-31T00:00:00.000Z", "2026-09-02T00:00:00.000Z"],
    ]);
    expect(memberReads).toBe(4);
    const publicData = deriveStockTokenTradeHistoryPublicData({
      sourceInput,
      coverage: result.coverage,
      resolutionOwnerMonths: result.resolutionMembers.map((entry) => entry.ownerMonth),
      candles: result.candles,
    });
    expect(publicData.positions.find((position) => position.candle !== null)).toMatchObject({
      coverage: "partial",
      poolId: expect.any(String),
      candle: { intervalStart: "2026-08-31T00:00:00.000Z" },
    });
    await source.close();
  });

  it("does not read a resolution member for incomplete coverage with a stored minute Swap", async () => {
    const fixture = createStockTokenTradeHistoryIncompleteWithSwapFixture();
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
    const sourceInput = request({
      requestedStart: "2026-09-01T00:01:00.000Z",
      requestedEnd: "2027-09-01T00:01:00.000Z",
      canonicalBlock: {
        chainId: "eip155:4663",
        blockNumber: "10000000",
        blockHash: `0x${"8".repeat(64)}`,
        blockTimestamp: "2027-09-01T00:01:00.000Z",
      },
      resolution: "2d",
    });
    const result = await source.read(sourceInput);
    if (result.status !== "available") throw new TypeError("Expected incomplete source.");
    expect(result.coverageOwnerMonths).toEqual(["2026-09"]);
    expect(result.resolutionMembers).toEqual([]);
    expect(result.candles).toEqual([]);
    expect(memberReads).toBe(2);
    const publicData = deriveStockTokenTradeHistoryPublicData({
      sourceInput,
      coverage: result.coverage,
      resolutionOwnerMonths: [],
      candles: [],
    });
    expect(publicData.positions.find((position) => position.coverage === "partial"))
      .toMatchObject({ coverage: "partial", poolId: null, candle: null });
    expect(publicData.positions.some((position) => position.coverage === "unavailable"))
      .toBe(true);
    await source.close();
  });

  it("does not read a resolution member across a covered Pool transition", async () => {
    const fixture = createStockTokenTradeHistoryCrossPoolFixture();
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
    const sourceInput = request({
      requestedStart: "2026-09-01T00:01:00.000Z",
      requestedEnd: "2027-09-01T00:01:00.000Z",
      canonicalBlock: {
        chainId: "eip155:4663",
        blockNumber: "10000000",
        blockHash: `0x${"8".repeat(64)}`,
        blockTimestamp: "2027-09-01T00:01:00.000Z",
      },
      resolution: "2d",
    });
    const result = await source.read(sourceInput);
    if (result.status !== "available") throw new TypeError("Expected cross-Pool source.");
    expect(result.coverage.map((segment) => segment.poolId)).toHaveLength(2);
    expect(new Set(result.coverage.map((segment) => segment.poolId)).size).toBe(2);
    expect(result.resolutionMembers).toEqual([]);
    expect(result.candles).toEqual([]);
    expect(memberReads).toBe(3);
    const publicData = deriveStockTokenTradeHistoryPublicData({
      sourceInput,
      coverage: result.coverage,
      resolutionOwnerMonths: [],
      candles: [],
    });
    expect(publicData.positions.find((position) => position.coverage === "partial"))
      .toMatchObject({ coverage: "partial", poolId: null, candle: null });
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
              bytes: stockTokenTradeHistoryProducerAdmission.maximumPhysicalAssetBytes + 1,
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
    const fixture = createStockTokenTradeHistoryCoverageConflictFixture();
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
    const fixture = createStockTokenTradeHistoryDeclaredTooLargeFixture();
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

  it("rejects selected member bytes that do not match their admitted gzip digest", async () => {
    const fixture = createStockTokenTradeHistorySourceFixture();
    let memberReads = 0;
    const source = createStockTokenTradeHistorySource({
      transport: Object.freeze({
        ...fixture.transport,
        async readMember(
          input: Parameters<StockTokenTradeHistoryProviderTransport["readMember"]>[0],
          signal: AbortSignal,
        ) {
          memberReads += 1;
          const outcome = await fixture.transport.readMember(input, signal);
          if (memberReads !== 1 || outcome.status !== "read") return outcome;
          const bytes = outcome.value.bytes.slice();
          bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
          return Object.freeze({
            status: "read" as const,
            value: Object.freeze({ ...outcome.value, bytes }),
          });
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
    let observedAtReads = 0;
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
      now: () => {
        observedAtReads += 1;
        return new Date("2026-08-24T07:01:00.000Z");
      },
    });

    await expect(source.read(request({
      requestedStart: "2026-06-01T00:00:00.000Z",
      resolution: "12h",
    }))).resolves.toMatchObject({
      status: "unavailable",
      reason: "trade_history_unavailable",
      scope: "selected_period",
    });
    expect(memberReads).toBe(3);
    expect(siblingAborted).toBe(true);
    expect(observedAtReads).toBe(1);
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
      resolution: "12h",
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
      candles: [],
    });
    await source.close();
  });

  it("does not admit coverage whose proved block range starts at the canonical block", async () => {
    const fixture = createStockTokenTradeHistorySourceFixture();
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
    await expect(source.read(request({
      canonicalBlock: {
        chainId: "eip155:4663",
        blockNumber: "50",
        blockHash: `0x${"5".repeat(64)}`,
        blockTimestamp: "2026-08-24T07:00:00.000Z",
      },
    }))).resolves.toMatchObject({
      status: "unavailable",
      reason: "outside_published_coverage",
      scope: "selected_period",
    });
    expect(memberReads).toBe(2);
    await source.close();
  });

  it("preserves cleanup failure from a stopped sibling with the canonical source terminal", async () => {
    const fixture = createStockTokenTradeHistorySourceFixture();
    let memberReads = 0;
    const cleanupCause = new Error("cleanup failed");
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
          return new Promise((_, reject) => {
            const stop = (): void => reject(new StockTokenTradeHistoryProviderCleanupError(
              [cleanupCause],
              signal.reason,
            ));
            if (signal.aborted) stop();
            else signal.addEventListener("abort", stop, { once: true });
          });
        },
      }),
    });

    const failure = await source.read(request({
      requestedStart: "2026-06-01T00:00:00.000Z",
      resolution: "12h",
    })).then(() => undefined, (error: unknown) => error);
    expect(isStockTokenTradeHistoryProviderCleanupError(failure)).toBe(true);
    expect((failure as StockTokenTradeHistoryProviderCleanupError).primaryFailure)
      .toMatchObject({ name: "SourceTerminal" });
    expect((failure as StockTokenTradeHistoryProviderCleanupError).cleanupFailures)
      .toEqual([cleanupCause]);
    const cause = (failure as Error & { readonly cause?: unknown }).cause;
    expect(cause).toBeInstanceOf(AggregateError);
    expect((cause as AggregateError).errors[0]).toMatchObject({ name: "SourceTerminal" });
    expect((cause as AggregateError).errors[1]).toBe(cleanupCause);
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

  it("replaces a raw deadline abort primary while preserving cleanup failure", async () => {
    vi.useFakeTimers();
    try {
      const fixture = createStockTokenTradeHistorySourceFixture();
      const cleanupCause = new Error("deadline cleanup failed");
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
              signal.addEventListener("abort", () => reject(
                new StockTokenTradeHistoryProviderCleanupError([cleanupCause], signal.reason),
              ), { once: true });
            });
          },
        }),
      });
      const read = source.read(request());
      await vi.advanceTimersByTimeAsync(stockTokenTradeHistorySourceLimits.deadlineMilliseconds);
      const failure = await read.then(() => undefined, (error: unknown) => error);
      expect(isStockTokenTradeHistoryProviderCleanupError(failure)).toBe(true);
      expect((failure as StockTokenTradeHistoryProviderCleanupError).primaryFailure)
        .toMatchObject({ name: "SourceTerminal" });
      expect((failure as StockTokenTradeHistoryProviderCleanupError).cleanupFailures)
        .toEqual([cleanupCause]);
      const close = source.close();
      await expect(close).rejects.toBe(failure);
      expect(source.close()).toBe(close);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rechecks caller cancellation after constructing a deadline cleanup terminal", async () => {
    vi.useFakeTimers();
    try {
      const fixture = createStockTokenTradeHistorySourceFixture();
      const cleanupCause = new Error("deadline cleanup failed");
      const caller = new AbortController();
      const callerReason = new Error("caller cancelled during terminal observation");
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
              signal.addEventListener("abort", () => reject(
                new StockTokenTradeHistoryProviderCleanupError([cleanupCause], signal.reason),
              ), { once: true });
            });
          },
        }),
        now: () => {
          caller.abort(callerReason);
          return new Date("2026-08-24T07:01:00.000Z");
        },
      });
      const read = source.read(request(), caller.signal);
      await vi.advanceTimersByTimeAsync(stockTokenTradeHistorySourceLimits.deadlineMilliseconds);
      const failure = await read.then(() => undefined, (error: unknown) => error);
      expect(isStockTokenTradeHistoryProviderCleanupError(failure)).toBe(true);
      expect((failure as StockTokenTradeHistoryProviderCleanupError).primaryFailure)
        .toBe(callerReason);
      expect((failure as StockTokenTradeHistoryProviderCleanupError).cleanupFailures)
        .toEqual([cleanupCause]);
      await expect(source.close()).rejects.toBe(failure);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not admit a provider value that settles after the whole-source deadline", async () => {
    vi.useFakeTimers();
    try {
      const fixture = createStockTokenTradeHistorySourceFixture();
      let releaseCatalog!: () => void;
      const source = createStockTokenTradeHistorySource({
        transport: Object.freeze({
          ...fixture.transport,
          readCatalog(
            ...args: Parameters<StockTokenTradeHistoryProviderTransport["readCatalog"]>
          ): ReturnType<StockTokenTradeHistoryProviderTransport["readCatalog"]> {
            return new Promise((resolve) => {
              releaseCatalog = () => { void fixture.transport.readCatalog(...args).then(resolve); };
            });
          },
        }),
      });
      const read = source.read(request());
      await vi.advanceTimersByTimeAsync(stockTokenTradeHistorySourceLimits.deadlineMilliseconds);
      releaseCatalog();

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

  it("keeps an admitted pre-deadline source terminal while draining later member work", async () => {
    vi.useFakeTimers();
    try {
      const fixture = createStockTokenTradeHistorySourceFixture();
      let memberReads = 0;
      let releaseLater!: () => void;
      let laterStarted!: () => void;
      const laterReadStarted = new Promise<void>((resolve) => { laterStarted = resolve; });
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
              laterStarted();
              return new Promise((resolve) => {
                releaseLater = () => resolve(Object.freeze({ status: "absent" as const }));
              });
            }
            return fixture.transport.readMember(input, signal);
          },
        }),
      });
      const read = source.read(request({
        requestedStart: "2026-06-01T00:00:00.000Z",
        resolution: "12h",
      }));
      await laterReadStarted;
      await vi.advanceTimersByTimeAsync(stockTokenTradeHistorySourceLimits.deadlineMilliseconds);
      releaseLater();

      await expect(read).resolves.toMatchObject({
        status: "unavailable",
        reason: "trade_history_unavailable",
        scope: "selected_period",
      });
      await source.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps caller cancellation ahead of an overlapping owner close", async () => {
    const fixture = createStockTokenTradeHistorySourceFixture();
    const caller = new AbortController();
    const callerReason = new Error("caller cancelled");
    let entered!: () => void;
    const readStarted = new Promise<void>((resolve) => { entered = resolve; });
    let rejectCatalog!: (reason: unknown) => void;
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
            rejectCatalog = () => reject(signal.reason);
          });
        },
      }),
    });

    const read = source.read(request(), caller.signal);
    await readStarted;
    const close = source.close();
    caller.abort(callerReason);
    rejectCatalog(undefined);

    await expect(read).rejects.toBe(callerReason);
    await expect(close).resolves.toBeUndefined();
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
    const cleanupCause = new Error("cleanup failed");
    const cleanup = new StockTokenTradeHistoryProviderCleanupError([cleanupCause]);
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
    expect((cause as AggregateError).errors[1]).toBe(cleanupCause);
    expect(source.close()).toBe(close);
  });
});
