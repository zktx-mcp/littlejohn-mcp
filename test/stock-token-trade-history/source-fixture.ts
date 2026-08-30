import { gzipSync } from "node:zlib";

import { sha256Bytes } from "../../src/core/index.js";
import {
  stockTokenTradeHistorySourceContract,
  type StockTokenTradeHistoryProviderOutcome,
  type StockTokenTradeHistoryProviderTransport,
} from "../../src/stock-token-trade-history/source-contract.js";

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
};

const encode = (value: unknown) => {
  const json = new TextEncoder().encode(canonicalJson(value));
  const gzip = new Uint8Array(gzipSync(json, { level: 9 }));
  return Object.freeze({
    gzip,
    gzipSha256: sha256Bytes(gzip),
    jsonBytes: json.byteLength,
    jsonSha256: sha256Bytes(json),
  });
};

const baseAddress = "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9";
const poolId = "0xc748f4671a867db48b552f6b7650bf3255e05f80f00e3f7aad1b17ccb7898fdb";
const poolKey = Object.freeze({
  currency0: stockTokenTradeHistorySourceContract.usdgAddress,
  currency1: baseAddress,
  fee: 3_000,
  hooks: "0x0000000000000000000000000000000000000000",
  tickSpacing: 60,
});

const position = (blockNumber: string, fill: string, transactionIndex: number, logIndex: number) =>
  Object.freeze({
    blockHash: `0x${fill.repeat(64)}`,
    blockNumber,
    transactionHash: `0x${(fill === "a" ? "c" : fill === "b" ? "d" : fill).repeat(64)}`,
    transactionIndex,
    logIndex,
  });

const selectedCandle = Object.freeze({
  baseVolumeRaw: "2",
  close: { numerator: "2", denominator: "1" },
  firstSource: position("98", "a", 0, 0),
  high: { numerator: "2", denominator: "1" },
  intervalEnd: "2026-08-24T07:00:00.000Z",
  intervalStart: "2026-08-24T06:45:00.000Z",
  lastSource: position("99", "b", 0, 0),
  low: { numerator: "1", denominator: "1" },
  observedEnd: "2026-08-24T06:47:00.000Z",
  observedStart: "2026-08-24T06:46:00.000Z",
  open: { numerator: "1", denominator: "1" },
  quoteVolumeRaw: "3",
  sourceCandleCount: 1,
  tradeCount: "2",
});

const reference = (
  logicalId: string,
  encoded: ReturnType<typeof encode>,
  assetSha256: string,
  from: number,
) => Object.freeze({
  assetSha256,
  from,
  gzipSha256: encoded.gzipSha256,
  jsonBytes: encoded.jsonBytes,
  jsonSha256: encoded.jsonSha256,
  logicalId,
  until: from + encoded.gzip.byteLength,
});

const pack = (
  releaseTag: string,
  family: "data" | "index",
  values: readonly Readonly<{
    readonly logicalId: string;
    readonly encoded: ReturnType<typeof encode>;
  }>[],
) => {
  const ordered = [...values].sort((left, right) => left.logicalId.localeCompare(right.logicalId));
  const bytes = new Uint8Array(ordered.reduce((total, value) => total + value.encoded.gzip.byteLength, 0));
  let offset = 0;
  for (const value of ordered) {
    bytes.set(value.encoded.gzip, offset);
    offset += value.encoded.gzip.byteLength;
  }
  const sha256 = sha256Bytes(bytes);
  offset = 0;
  const references = new Map(ordered.map((value) => {
    const stored = reference(value.logicalId, value.encoded, sha256, offset);
    offset = stored.until;
    return [value.logicalId, stored];
  }));
  return Object.freeze({
    bytes,
    references,
    asset: Object.freeze({
      assetName: `${family}-${sha256}.bin`,
      bytes: bytes.byteLength,
      logicalIds: Object.freeze(ordered.map((value) => value.logicalId)),
      releaseTag,
      sha256,
    }),
  });
};

export interface StockTokenTradeHistorySourceFixture {
  readonly baseAddress: typeof baseAddress;
  readonly root: unknown;
  readonly rootBytes: Uint8Array;
  readonly rootName: string;
  readonly assets: ReadonlyMap<string, Uint8Array>;
  readonly transport: StockTokenTradeHistoryProviderTransport;
}

export const createStockTokenTradeHistorySourceFixture = (
  options: Readonly<{
    readonly resolutionFromBlock?: string;
    readonly stateJsonBytes?: number;
  }> = {},
): StockTokenTradeHistorySourceFixture => {
  const stateCoverage = Object.freeze([Object.freeze({
    fromBlock: "10",
    fromTimestamp: "2026-06-01T00:00:00.000Z",
    poolId,
    untilBlock: "100",
    untilTimestamp: "2026-08-24T07:00:00.000Z",
  })]);
  const augustMonthCoverage = Object.freeze([Object.freeze({
    fromBlock: "50",
    fromTimestamp: "2026-08-01T00:00:00.000Z",
    poolId,
    untilBlock: "70",
    untilTimestamp: "2026-08-12T00:00:00.000Z",
  }), Object.freeze({
    fromBlock: "70",
    fromTimestamp: "2026-08-12T00:00:00.000Z",
    poolId,
    untilBlock: "100",
    untilTimestamp: "2026-08-24T07:00:00.000Z",
  })]);
  const resolutionCoverage = Object.freeze([Object.freeze({
    fromBlock: options.resolutionFromBlock ?? "50",
    fromTimestamp: "2026-08-01T00:00:00.000Z",
    poolId,
    untilBlock: "100",
    untilTimestamp: "2026-08-24T07:00:00.000Z",
  })]);
  const resolutionValues = stockTokenTradeHistorySourceContract.resolutions.slice(1).map((definition) => {
    const logicalId = `base/${baseAddress}/resolution/${definition.label}/2026-08`;
    const value = definition.label === "15m"
      ? {
          baseCurrencyAddress: baseAddress,
          candles: [selectedCandle],
          coverage: resolutionCoverage,
          intervalSeconds: definition.intervalSeconds,
          ownerMonth: "2026-08",
        }
      : {
          baseCurrencyAddress: baseAddress,
          candles: [],
          coverage: resolutionCoverage,
          intervalSeconds: definition.intervalSeconds,
          ownerMonth: "2026-08",
        };
    return Object.freeze({ logicalId, encoded: encode(value) });
  });
  const dayLogicalId = `base/${baseAddress}/day/2026-08-24`;
  const data = pack(
    "market-data-2026-08-s1",
    "data",
    [
      { logicalId: dayLogicalId, encoded: encode({ unused: true }) },
      ...resolutionValues,
    ],
  );
  const monthLogicalId = `base/${baseAddress}/month/2026-08`;
  const monthValue = {
    baseCurrencyAddress: baseAddress,
    coverage: augustMonthCoverage,
    days: [data.references.get(dayLogicalId)],
    month: "2026-08",
    resolutions: Object.fromEntries(stockTokenTradeHistorySourceContract.resolutions.slice(1).map((definition) => [
      definition.label,
      data.references.get(`base/${baseAddress}/resolution/${definition.label}/2026-08`),
    ])),
  };
  const month = pack(
    "market-data-index-s1",
    "index",
    [
      {
        logicalId: `base/${baseAddress}/month/2026-06`,
        encoded: encode({ unused: "2026-06" }),
      },
      {
        logicalId: `base/${baseAddress}/month/2026-07`,
        encoded: encode({ unused: "2026-07" }),
      },
      { logicalId: monthLogicalId, encoded: encode(monthValue) },
    ],
  );
  const stateLogicalId = `base/${baseAddress}/state`;
  const stateValue = {
    baseCurrencyAddress: baseAddress,
    decimals: 18,
    months: [
      month.references.get(`base/${baseAddress}/month/2026-06`),
      month.references.get(`base/${baseAddress}/month/2026-07`),
      month.references.get(monthLogicalId),
    ],
    poolPeriods: stateCoverage,
    pools: {
      [poolId]: {
        historyFrom: { blockNumber: "10", timestamp: "2026-06-01T00:00:00.000Z" },
        initialize: { blockNumber: "9", timestamp: "2026-05-31T23:59:30.000Z" },
        poolKey,
        sourceFrom: { blockNumber: "9", timestamp: "2026-05-31T23:59:00.000Z" },
      },
    },
  };
  const state = pack(
    "market-data-index-s1",
    "index",
    [{ logicalId: stateLogicalId, encoded: encode(stateValue) }],
  );
  const selectedAssets = [data.asset, month.asset, state.asset]
    .sort((left, right) => left.sha256.localeCompare(right.sha256));
  const root = {
    assets: selectedAssets,
    baseCurrencies: {
      [baseAddress]: options.stateJsonBytes === undefined
        ? state.references.get(stateLogicalId)
        : { ...state.references.get(stateLogicalId), jsonBytes: options.stateJsonBytes },
    },
    currentUntil: { blockNumber: "100", timestamp: "2026-08-24T07:00:00.000Z" },
    poolManager: stockTokenTradeHistorySourceContract.poolManager,
    publicationSequence: 12,
    resolutions: stockTokenTradeHistorySourceContract.resolutions,
    usdgAddress: stockTokenTradeHistorySourceContract.usdgAddress,
    usdgDecimals: stockTokenTradeHistorySourceContract.usdgDecimals,
  };
  const encodedRoot = encode(root);
  const rootName = `root-s12-${encodedRoot.gzipSha256}.json.gz`;
  const assetBytes = new Map<string, Uint8Array>([
    [data.asset.assetName, data.bytes],
    [month.asset.assetName, month.bytes],
    [state.asset.assetName, state.bytes],
  ]);
  const read = <Value>(value: Value): StockTokenTradeHistoryProviderOutcome<Value> =>
    Object.freeze({ status: "read", value });
  const transport: StockTokenTradeHistoryProviderTransport = Object.freeze({
    async readCatalog() {
      return read(Object.freeze({
        assets: Object.freeze([{ name: rootName, bytes: encodedRoot.gzip.byteLength }]),
        overflow: false,
        transferredBytes: 128,
      }));
    },
    async readRoot() {
      return read(Object.freeze({ bytes: encodedRoot.gzip, identityEncoding: true }));
    },
    async readMember(input: Readonly<{
      readonly releaseTag: string;
      readonly assetName: string;
      readonly from: number;
      readonly until: number;
      readonly maximumBytes: number;
    }>) {
      const asset = assetBytes.get(input.assetName);
      if (asset === undefined) return Object.freeze({ status: "absent" });
      return read(Object.freeze({
        bytes: asset.slice(input.from, input.until),
        identityEncoding: true,
        range: Object.freeze({ from: input.from, until: input.until, assetBytes: asset.byteLength }),
      }));
    },
  });
  return Object.freeze({
    baseAddress,
    root,
    rootBytes: encodedRoot.gzip,
    rootName,
    assets: assetBytes,
    transport,
  });
};

export const createStockTokenTradeHistoryMultiMonthSourceFixture =
  (): StockTokenTradeHistorySourceFixture => {
    const monthInputs = [{
      month: "2026-07",
      day: "2026-07-31",
      segments: [{
        fromBlock: "10",
        fromTimestamp: "2026-07-31T23:00:00.000Z",
        poolId,
        untilBlock: "15",
        untilTimestamp: "2026-07-31T23:30:00.000Z",
      }, {
        fromBlock: "15",
        fromTimestamp: "2026-07-31T23:30:00.000Z",
        poolId,
        untilBlock: "20",
        untilTimestamp: "2026-08-01T00:00:00.000Z",
      }],
      candleStart: "2026-07-31T23:00:00.000Z",
      observedStart: "2026-07-31T23:01:00.000Z",
      observedEnd: "2026-07-31T23:02:00.000Z",
      firstBlock: "11",
      lastBlock: "12",
      fill: "3",
    }, {
      month: "2026-08",
      day: "2026-08-01",
      segments: [{
        fromBlock: "20",
        fromTimestamp: "2026-08-01T00:00:00.000Z",
        poolId,
        untilBlock: "25",
        untilTimestamp: "2026-08-01T00:30:00.000Z",
      }, {
        fromBlock: "25",
        fromTimestamp: "2026-08-01T00:30:00.000Z",
        poolId,
        untilBlock: "30",
        untilTimestamp: "2026-08-01T01:00:00.000Z",
      }],
      candleStart: "2026-08-01T00:00:00.000Z",
      observedStart: "2026-08-01T00:01:00.000Z",
      observedEnd: "2026-08-01T00:02:00.000Z",
      firstBlock: "21",
      lastBlock: "22",
      fill: "4",
    }] as const;
    const dataPacks = monthInputs.map((input) => {
      const firstSource = position(input.firstBlock, input.fill, 0, 0);
      const lastSource = position(input.lastBlock, input.fill === "3" ? "5" : "6", 0, 0);
      const oneMinute = {
        baseVolumeRaw: "2",
        close: { numerator: "2", denominator: "1" },
        firstSource,
        high: { numerator: "2", denominator: "1" },
        intervalEnd: input.observedEnd,
        intervalStart: input.observedStart,
        lastSource,
        low: { numerator: "1", denominator: "1" },
        open: { numerator: "1", denominator: "1" },
        quoteVolumeRaw: "3",
        tradeCount: 2,
      };
      const derivedCandle = {
        ...oneMinute,
        intervalStart: input.candleStart,
        intervalEnd: new Date(Date.parse(input.candleStart) + 900_000).toISOString(),
        observedStart: input.observedStart,
        observedEnd: input.observedEnd,
        sourceCandleCount: 1,
        tradeCount: "2",
      };
      const resolutionCoverage = [{
        ...input.segments[0],
        untilBlock: input.segments[1].untilBlock,
        untilTimestamp: input.segments[1].untilTimestamp,
      }];
      const dayLogicalId = `base/${baseAddress}/day/${input.day}`;
      const entries = [{
        logicalId: dayLogicalId,
        encoded: encode({
          baseCurrencyAddress: baseAddress,
          candles: [oneMinute],
          coverage: input.segments,
          day: input.day,
        }),
      }, ...stockTokenTradeHistorySourceContract.resolutions.slice(1).map((definition) => ({
        logicalId: `base/${baseAddress}/resolution/${definition.label}/${input.month}`,
        encoded: encode({
          baseCurrencyAddress: baseAddress,
          candles: definition.label === "15m" ? [derivedCandle] : [],
          coverage: resolutionCoverage,
          intervalSeconds: definition.intervalSeconds,
          ownerMonth: input.month,
        }),
      }))];
      return Object.freeze({
        input,
        dayLogicalId,
        packed: pack(`market-data-${input.month}-s1`, "data", entries),
      });
    });
    const monthEntries = dataPacks.map(({ input, dayLogicalId, packed }) => ({
      logicalId: `base/${baseAddress}/month/${input.month}`,
      encoded: encode({
        baseCurrencyAddress: baseAddress,
        coverage: input.segments,
        days: [packed.references.get(dayLogicalId)],
        month: input.month,
        resolutions: Object.fromEntries(
          stockTokenTradeHistorySourceContract.resolutions.slice(1).map((definition) => [
            definition.label,
            packed.references.get(`base/${baseAddress}/resolution/${definition.label}/${input.month}`),
          ]),
        ),
      }),
    }));
    const months = pack("market-data-index-s2", "index", monthEntries);
    const stateLogicalId = `base/${baseAddress}/state`;
    const state = pack("market-data-index-s2", "index", [{
      logicalId: stateLogicalId,
      encoded: encode({
        baseCurrencyAddress: baseAddress,
        decimals: 18,
        months: monthEntries.map((entry) => months.references.get(entry.logicalId)),
        poolPeriods: [{
          fromBlock: "10",
          fromTimestamp: "2026-07-31T23:00:00.000Z",
          poolId,
          untilBlock: "30",
          untilTimestamp: "2026-08-01T01:00:00.000Z",
        }],
        pools: {
          [poolId]: {
            historyFrom: { blockNumber: "10", timestamp: "2026-07-31T23:00:00.000Z" },
            initialize: { blockNumber: "9", timestamp: "2026-07-31T22:59:30.000Z" },
            poolKey,
            sourceFrom: { blockNumber: "9", timestamp: "2026-07-31T22:59:00.000Z" },
          },
        },
      }),
    }]);
    const selectedAssets = [
      ...dataPacks.map((entry) => entry.packed.asset),
      months.asset,
      state.asset,
    ].sort((left, right) => left.sha256.localeCompare(right.sha256));
    const root = {
      assets: selectedAssets,
      baseCurrencies: { [baseAddress]: state.references.get(stateLogicalId) },
      currentUntil: { blockNumber: "30", timestamp: "2026-08-01T01:00:00.000Z" },
      poolManager: stockTokenTradeHistorySourceContract.poolManager,
      publicationSequence: 13,
      resolutions: stockTokenTradeHistorySourceContract.resolutions,
      usdgAddress: stockTokenTradeHistorySourceContract.usdgAddress,
      usdgDecimals: stockTokenTradeHistorySourceContract.usdgDecimals,
    };
    const encodedRoot = encode(root);
    const rootName = `root-s13-${encodedRoot.gzipSha256}.json.gz`;
    const assetBytes = new Map<string, Uint8Array>([
      ...dataPacks.map((entry) => [entry.packed.asset.assetName, entry.packed.bytes] as const),
      [months.asset.assetName, months.bytes],
      [state.asset.assetName, state.bytes],
    ]);
    const read = <Value>(value: Value): StockTokenTradeHistoryProviderOutcome<Value> =>
      Object.freeze({ status: "read", value });
    const transport: StockTokenTradeHistoryProviderTransport = Object.freeze({
      async readCatalog() {
        return read(Object.freeze({
          assets: Object.freeze([{ name: rootName, bytes: encodedRoot.gzip.byteLength }]),
          overflow: false,
          transferredBytes: 128,
        }));
      },
      async readRoot() {
        return read(Object.freeze({ bytes: encodedRoot.gzip, identityEncoding: true }));
      },
      async readMember(input: Parameters<StockTokenTradeHistoryProviderTransport["readMember"]>[0]) {
        const asset = assetBytes.get(input.assetName);
        if (asset === undefined) return Object.freeze({ status: "absent" });
        return read(Object.freeze({
          bytes: asset.slice(input.from, input.until),
          identityEncoding: true,
          range: Object.freeze({ from: input.from, until: input.until, assetBytes: asset.byteLength }),
        }));
      },
    });
    return Object.freeze({
      baseAddress,
      root,
      rootBytes: encodedRoot.gzip,
      rootName,
      assets: assetBytes,
      transport,
    });
  };
