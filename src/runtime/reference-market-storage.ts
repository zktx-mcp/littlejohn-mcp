import type {
  EvmAccountIdentity,
  ReferenceFeedId,
  ReferenceFeedIntegrityStatus,
  ReferenceFeedTraversalStatus,
  ReferencePairId,
  ReferenceRoundObservation,
  ReferenceWatchlistRevision,
  ReferenceWatchlistSuccess,
  UtcTimestamp,
} from "../core/index.js";
import type { RuntimeRevision } from "./runtime-identity.js";

export interface ReferenceFeedCacheSnapshot {
  readonly feedId: ReferenceFeedId;
  readonly revision: string | null;
  readonly observations: readonly ReferenceRoundObservation[];
  readonly backfillPhaseId: string | null;
  readonly backfillNextRoundId: string | null;
  readonly retentionCutoffRoundId: string | null;
  readonly integrityStatus: ReferenceFeedIntegrityStatus;
  readonly backfillStatus: ReferenceFeedTraversalStatus;
}

export interface ReferenceFeedCacheCommit {
  readonly feedId: ReferenceFeedId;
  readonly expectedRevision: string | null;
  readonly observations: readonly ReferenceRoundObservation[];
  readonly backfillPhaseId: string | null;
  readonly backfillNextRoundId: string | null;
  readonly backfillStatus: ReferenceFeedTraversalStatus;
  readonly retainAfterUnixSeconds: string;
  readonly now: UtcTimestamp;
}

export type ReferenceWatchlistMutation =
  | Readonly<{ kind: "add"; pairId: ReferencePairId }>
  | Readonly<{ kind: "remove"; pairId: ReferencePairId }>
  | Readonly<{ kind: "reorder"; pairIds: readonly ReferencePairId[] }>;

export type ReferenceWatchlistMutationResult =
  | Readonly<{ status: "success"; watchlist: ReferenceWatchlistSuccess }>
  | Readonly<{
      status: "rejected";
      reason:
        | "watchlist_full"
        | "watchlist_order_conflict"
        | "watchlist_pair_already_saved"
        | "watchlist_pair_not_found";
    }>;

export interface ReferenceMarketStore {
  readFeed(feedId: ReferenceFeedId): ReferenceFeedCacheSnapshot;
  commitFeed(input: ReferenceFeedCacheCommit): ReferenceFeedCacheSnapshot;
  readWatchlist(account: EvmAccountIdentity): ReferenceWatchlistSuccess;
  mutateWatchlist(input: Readonly<{
    account: EvmAccountIdentity;
    expectedConnectionRevision: RuntimeRevision;
    expectedRevision: ReferenceWatchlistRevision;
    mutation: ReferenceWatchlistMutation;
    now: UtcTimestamp;
  }>): ReferenceWatchlistMutationResult;
}
