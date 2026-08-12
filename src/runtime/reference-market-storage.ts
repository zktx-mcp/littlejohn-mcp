import type {
  EvmAccountIdentity,
  ReferenceFeedId,
  ReferenceFeedIntegrityStatus,
  ReferenceFeedTraversalStatus,
  ReferenceRoundObservation,
  ReferenceWatchlistSuccess,
  UtcTimestamp,
} from "../core/index.js";
import type {
  ReferenceWatchlistDirectAction,
  ReferenceWatchlistOperation,
} from "../market-portfolio/contracts.js";

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

export interface ReferenceWatchlistActionCommand {
  readonly action: ReferenceWatchlistDirectAction;
  readonly completedAt: UtcTimestamp;
}

export interface ReferenceMarketStore {
  readFeed(feedId: ReferenceFeedId): ReferenceFeedCacheSnapshot;
  commitFeed(input: ReferenceFeedCacheCommit): ReferenceFeedCacheSnapshot;
  readWatchlist(account: EvmAccountIdentity): ReferenceWatchlistSuccess;
  readWatchlistOperation(
    operationId: ReferenceWatchlistOperation["operationId"],
  ): ReferenceWatchlistOperation | null;
  applyWatchlistChange(input: ReferenceWatchlistActionCommand): ReferenceWatchlistOperation;
}
