import type {
  ChainInvocationPort,
  ReferenceMarketChainReadPort,
} from "../chain/index.js";
import type {
  ApplicationFailure,
  CanonicalClock,
  ReferenceHistoryInput,
  ReferenceHistorySuccess,
  ReferencePriceInput,
  ReferencePriceSuccess,
  ReferenceWatchlistSuccess,
} from "../core/index.js";
import type { OfficialAssetSynchronizationPort } from "../registry/index.js";
import type { ReferenceMarketStore } from "../runtime/reference-market-storage.js";
import type { ActiveWalletReadPort } from "../wallet/coordinator.js";
import type {
  ReferenceWatchlistDirectAction,
  ReferenceWatchlistOperation,
  ReferenceWatchlistOperationInput,
  ReferenceWatchlistReviewRequest,
  ReferenceWatchlistReviewResult,
} from "./contracts.js";
import type {
  StockTokenMarketInput,
  StockTokenMarketResult,
} from "./stock-token-market.js";
import type { StockTokenExecutionIndexReadPort } from "./stock-token-execution-index.js";

export interface ReferenceMarketApplicationPort {
  price(input: ReferencePriceInput, signal?: AbortSignal): Promise<ReferencePriceSuccess | ApplicationFailure>;
  history(input: ReferenceHistoryInput, signal?: AbortSignal): Promise<ReferenceHistorySuccess | ApplicationFailure>;
  stockTokenMarket(
    input: StockTokenMarketInput,
    signal?: AbortSignal,
  ): Promise<StockTokenMarketResult | ApplicationFailure>;
  watchlist(input: Record<string, never>, signal?: AbortSignal): Promise<ReferenceWatchlistSuccess | ApplicationFailure>;
  reviewWatchlistChange(
    input: ReferenceWatchlistReviewRequest,
    signal?: AbortSignal,
  ): Promise<ReferenceWatchlistReviewResult | ApplicationFailure>;
  decideWatchlistChange(
    input: ReferenceWatchlistDirectAction,
    signal?: AbortSignal,
  ): Promise<ReferenceWatchlistOperation | ApplicationFailure>;
  getWatchlistOperation(
    input: ReferenceWatchlistOperationInput,
    signal?: AbortSignal,
  ): Promise<ReferenceWatchlistOperation | ApplicationFailure>;
}

export interface ReferenceMarketApplicationDependencies {
  readonly chainInvocations: ChainInvocationPort;
  readonly chain: ReferenceMarketChainReadPort;
  readonly store: ReferenceMarketStore;
  readonly activeWallet: ActiveWalletReadPort;
  readonly officialAssets: OfficialAssetSynchronizationPort;
  readonly stockTokenExecutionIndex: StockTokenExecutionIndexReadPort;
  readonly clock: CanonicalClock;
}
