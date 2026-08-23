import type {
  ChainInvocationPort,
  CurrentBlockReadPort,
  OfficialAssetChainReadPort,
} from "../chain/index.js";
import type { ApplicationFailure } from "../core/index.js";
import type { OfficialAssetSynchronizationPort } from "../registry/index.js";
import type {
  StockTokenTradeHistoryInput,
  StockTokenTradeHistoryResult,
} from "./stock-token-trade-history.js";
import type { StockTokenTradeHistoryReadPort } from "./stock-token-trade-history-data.js";

export interface StockTokenTradeHistoryApplicationPort {
  get(
    input: StockTokenTradeHistoryInput,
    signal?: AbortSignal,
  ): Promise<StockTokenTradeHistoryResult | ApplicationFailure>;
}

export interface StockTokenTradeHistoryApplicationDependencies {
  readonly chainInvocations: ChainInvocationPort;
  readonly currentBlockReads: CurrentBlockReadPort;
  readonly officialAssets: OfficialAssetSynchronizationPort;
  readonly officialAssetReads: OfficialAssetChainReadPort;
  readonly tradeHistoryReads: StockTokenTradeHistoryReadPort;
}
