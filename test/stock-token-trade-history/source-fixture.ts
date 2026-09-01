import { Buffer } from "node:buffer";

import type {
  StockTokenTradeHistoryProviderOutcome,
  StockTokenTradeHistoryProviderTransport,
} from "../../src/stock-token-trade-history/source-contract.js";
import { stockTokenTradeHistorySourceIdentity } from
  "../../src/stock-token-trade-history/source-semantics.js";
import sourceArtifacts from "./source-artifacts.json" with { type: "json" };

const bytes = (base64: string): Uint8Array => new Uint8Array(Buffer.from(base64, "base64"));

export interface StockTokenTradeHistorySourceFixture {
  readonly baseAddress: string;
  readonly rootBytes: Uint8Array;
  readonly rootName: string;
  readonly transport: StockTokenTradeHistoryProviderTransport;
}

type SourceArtifactName = keyof typeof sourceArtifacts.artifacts;

const sourceFixture = (name: SourceArtifactName): StockTokenTradeHistorySourceFixture => {
  if (sourceArtifacts.producerRevision !== stockTokenTradeHistorySourceIdentity.revision) {
    throw new TypeError("Stock Token trade-history source fixture revision is stale.");
  }
  const artifact = sourceArtifacts.artifacts[name];
  const rootBytes = bytes(artifact.rootBase64);
  const assets = new Map(
    artifact.assets.map((asset) => [asset.assetName, bytes(asset.base64)] as const),
  );
  const read = <Value>(value: Value): StockTokenTradeHistoryProviderOutcome<Value> =>
    Object.freeze({ status: "read", value });
  const transport: StockTokenTradeHistoryProviderTransport = Object.freeze({
    async readCatalog() {
      return read(Object.freeze({
        assets: Object.freeze([{ name: artifact.rootName, bytes: rootBytes.byteLength }]),
        overflow: false,
        transferredBytes: 128,
      }));
    },
    async readRoot(rootName: string) {
      return rootName === artifact.rootName
        ? read(Object.freeze({ bytes: rootBytes, identityEncoding: true }))
        : Object.freeze({ status: "absent" as const });
    },
    async readMember(input: Parameters<StockTokenTradeHistoryProviderTransport["readMember"]>[0]) {
      const asset = assets.get(input.assetName);
      if (asset === undefined) return Object.freeze({ status: "absent" as const });
      return read(Object.freeze({
        bytes: asset.slice(input.from, input.until),
        identityEncoding: true,
        range: Object.freeze({ from: input.from, until: input.until, assetBytes: asset.byteLength }),
      }));
    },
  });
  return Object.freeze({
    baseAddress: artifact.baseAddress,
    rootBytes,
    rootName: artifact.rootName,
    transport,
  });
};

export const createStockTokenTradeHistorySourceFixture =
  (): StockTokenTradeHistorySourceFixture => sourceFixture("healthy");

export const createStockTokenTradeHistoryCoverageConflictFixture =
  (): StockTokenTradeHistorySourceFixture => sourceFixture("coverageConflict");

export const createStockTokenTradeHistoryDeclaredTooLargeFixture =
  (): StockTokenTradeHistorySourceFixture => sourceFixture("declaredTooLarge");

export const createStockTokenTradeHistoryMultiMonthSourceFixture =
  (): StockTokenTradeHistorySourceFixture => sourceFixture("multiMonth");
