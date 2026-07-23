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
  ReferenceWatchlistMutationInput,
  ReferenceWatchlistReorderInput,
  ReferenceWatchlistSuccess,
} from "../core/index.js";
import type { ReferenceMarketStore } from "../runtime/reference-market-storage.js";
import type { ActiveWalletReadPort } from "../wallet/coordinator.js";

export interface ReferenceMarketApplicationPort {
  price(input: ReferencePriceInput, signal?: AbortSignal): Promise<ReferencePriceSuccess | ApplicationFailure>;
  history(input: ReferenceHistoryInput, signal?: AbortSignal): Promise<ReferenceHistorySuccess | ApplicationFailure>;
  watchlist(input: Record<string, never>, signal?: AbortSignal): Promise<ReferenceWatchlistSuccess | ApplicationFailure>;
  addPair(
    input: ReferenceWatchlistMutationInput,
    signal?: AbortSignal,
  ): Promise<ReferenceWatchlistSuccess | ApplicationFailure>;
  removePair(
    input: ReferenceWatchlistMutationInput,
    signal?: AbortSignal,
  ): Promise<ReferenceWatchlistSuccess | ApplicationFailure>;
  reorderPairs(
    input: ReferenceWatchlistReorderInput,
    signal?: AbortSignal,
  ): Promise<ReferenceWatchlistSuccess | ApplicationFailure>;
}

export interface ReferenceMarketApplicationDependencies {
  readonly chainInvocations: ChainInvocationPort;
  readonly chain: ReferenceMarketChainReadPort;
  readonly store: ReferenceMarketStore;
  readonly activeWallet: ActiveWalletReadPort;
  readonly clock: CanonicalClock;
}
