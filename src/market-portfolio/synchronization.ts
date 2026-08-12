import type {
  CanonicalBlock,
  ChainInvocationContext,
  ReferenceMarketChainReadPort,
} from "../chain/index.js";
import {
  getChainOperationFailure,
  type ChainErrorCode,
} from "../chain/errors.js";
import {
  createReferenceHistoryWorkPlan,
  findReferenceFeed,
  referenceFeedIds,
  referenceFeedTraversalStateSchema,
  referenceHistoryTraversalReportSchema,
  referenceHistoryRetentionMilliseconds,
  referenceMarketLimits,
  type CanonicalClock,
  type ReferenceFeedId,
  type ReferenceHistoryTraversalReport,
  type ReferenceRoundObservation,
} from "../core/index.js";
import type {
  ReferenceFeedCacheSnapshot,
  ReferenceMarketStore,
} from "../runtime/reference-market-storage.js";
import {
  getReferenceMarketOperationFailure,
  ReferenceMarketOperationError,
} from "./errors.js";

interface SynchronizationJob {
  readonly feedId: ReferenceFeedId;
  readonly block: CanonicalBlock;
  readonly requestedStartUnixSeconds: bigint;
  readonly latest: ReferenceRoundObservation;
  readonly context: ChainInvocationContext;
  readonly resolve: (result: ReferenceFeedSynchronizationResult) => void;
  readonly reject: (error: unknown) => void;
  removeAbortListener?: () => void;
}

export interface ReferenceFeedSynchronizationResult {
  readonly snapshot: ReferenceFeedCacheSnapshot;
  readonly report: ReferenceHistoryTraversalReport;
}

const unixSeconds = (timestamp: string): bigint => BigInt(Math.floor(Date.parse(timestamp) / 1_000));

const boundedSourceStopCodes = Object.freeze([
  "chain_response_unavailable",
  "rate_limited",
  "source_unavailable",
] as const satisfies readonly ChainErrorCode[]);

const isBoundedSourceStop = (error: unknown): boolean => {
  const code = (
    getChainOperationFailure(error) ?? getReferenceMarketOperationFailure(error)
  )?.error.code;
  return code !== undefined && boundedSourceStopCodes.some((candidate) => candidate === code);
};

export class ReferenceFeedSynchronizationOwner {
  readonly #chain: ReferenceMarketChainReadPort;
  readonly #store: ReferenceMarketStore;
  readonly #clock: CanonicalClock;
  readonly #owner = new AbortController();
  readonly #feedIds = new Set<ReferenceFeedId>(referenceFeedIds);
  readonly #pending: SynchronizationJob[] = [];
  readonly #activeFeedIds = new Set<ReferenceFeedId>();
  readonly #activeSettlements = new Set<Promise<void>>();
  #state: "open" | "closing" | "closed" = "open";
  #closePromise: Promise<void> | undefined;

  constructor(input: Readonly<{
    chain: ReferenceMarketChainReadPort;
    store: ReferenceMarketStore;
    clock: CanonicalClock;
  }>) {
    this.#chain = input.chain;
    this.#store = input.store;
    this.#clock = input.clock;
  }

  synchronize(input: Readonly<{
    feedId: ReferenceFeedId;
    block: CanonicalBlock;
    requestedStartUnixSeconds: bigint;
    latest: ReferenceRoundObservation;
    context: ChainInvocationContext;
  }>): Promise<ReferenceFeedSynchronizationResult> {
    if (this.#state !== "open") {
      return Promise.reject(new ReferenceMarketOperationError("runtime_state_unavailable"));
    }
    if (input.context.signal.aborted) {
      return Promise.reject(new ReferenceMarketOperationError("request_aborted"));
    }
    if (!this.#feedIds.has(input.feedId) || input.latest.fact.feedId !== input.feedId) {
      return Promise.reject(new ReferenceMarketOperationError("invalid_input"));
    }
    if (
      this.#pending.length + this.#activeSettlements.size >=
        referenceMarketLimits.synchronizationJobs
    ) {
      return Promise.reject(new ReferenceMarketOperationError("runtime_busy"));
    }
    return new Promise<ReferenceFeedSynchronizationResult>((resolve, reject) => {
      const job: SynchronizationJob = {
        feedId: input.feedId,
        block: input.block,
        requestedStartUnixSeconds: input.requestedStartUnixSeconds,
        latest: input.latest,
        context: input.context,
        resolve,
        reject,
      };
      const abortQueued = (): void => {
        const index = this.#pending.indexOf(job);
        if (index < 0) return;
        this.#pending.splice(index, 1);
        job.removeAbortListener?.();
        reject(new ReferenceMarketOperationError("request_aborted"));
        this.#pump();
      };
      input.context.signal.addEventListener("abort", abortQueued, { once: true });
      job.removeAbortListener = () => input.context.signal.removeEventListener("abort", abortQueued);
      this.#pending.push(job);
      this.#pump();
    });
  }

  #pump(): void {
    if (this.#state !== "open") return;
    while (this.#activeSettlements.size < referenceMarketLimits.synchronizationActiveJobs) {
      const index = this.#pending.findIndex((job) => !this.#activeFeedIds.has(job.feedId));
      if (index < 0) return;
      const [job] = this.#pending.splice(index, 1);
      if (job === undefined) return;
      this.#activeFeedIds.add(job.feedId);
      let settlement!: Promise<void>;
      settlement = this.#run(job.feedId, job).then(job.resolve, job.reject).finally(() => {
        job.removeAbortListener?.();
        this.#activeFeedIds.delete(job.feedId);
        this.#activeSettlements.delete(settlement);
        this.#pump();
      });
      this.#activeSettlements.add(settlement);
    }
  }

  async #run(feedId: ReferenceFeedId, job: SynchronizationJob): Promise<ReferenceFeedSynchronizationResult> {
    const signal = job.context.signal;
    if (signal.aborted) {
      throw new ReferenceMarketOperationError(
        this.#owner.signal.aborted ? "runtime_state_unavailable" : "request_aborted",
      );
    }
    let current = this.#store.readFeed(feedId);
    if (current.integrityStatus === "conflict") {
      throw new ReferenceMarketOperationError("source_inconsistent");
    }
    if (
      current.retentionCutoffRoundId !== null &&
      BigInt(job.latest.fact.roundId) <= BigInt(current.retentionCutoffRoundId)
    ) {
      throw new ReferenceMarketOperationError("source_inconsistent");
    }
    const feed = findReferenceFeed(feedId);
    const retainAfter = unixSeconds(job.block.anchor.blockTimestamp) -
      BigInt(referenceHistoryRetentionMilliseconds / 1_000) - BigInt(feed.heartbeatSeconds);
    let observations: readonly ReferenceRoundObservation[] = [job.latest];
    let backfillPhaseId = current.backfillPhaseId;
    let backfillNextRoundId = current.backfillNextRoundId;
    let backfillStatus = current.backfillStatus;
    let stoppedByFailure: unknown;
    let phaseBoundaryObserved = current.backfillStatus === "phase_boundary";
    let malformedRoundObserved = current.backfillStatus === "malformed";
    const coverageTarget = job.requestedStartUnixSeconds - BigInt(feed.heartbeatSeconds);

    let results;
    try {
      results = await this.#chain.readHistoryAtBlock({
        feedId,
        latestRoundId: job.latest.fact.roundId,
        knownObservations: current.observations,
        backfillPhaseId,
        backfillNextRoundId,
        backfillStatus,
        retentionCutoffRoundId: current.retentionCutoffRoundId,
        stopAtOrBeforeUnixSeconds: coverageTarget.toString(10),
        block: job.block,
      }, job.context);
    } catch (error) {
      if (this.#owner.signal.aborted) {
        stoppedByFailure = new ReferenceMarketOperationError("runtime_state_unavailable");
      } else if (job.context.signal.aborted) {
        stoppedByFailure = new ReferenceMarketOperationError("request_aborted");
      } else {
        stoppedByFailure = error;
      }
    }
    if (results !== undefined) {
      observations = Object.freeze([job.latest, ...results.observations]);
      backfillPhaseId = results.backfillPhaseId;
      backfillNextRoundId = results.backfillNextRoundId;
      backfillStatus = results.backfillStatus;
      phaseBoundaryObserved ||= results.phaseBoundaryObserved;
      malformedRoundObserved ||= results.malformedRoundObserved;
      stoppedByFailure = results.failure;
    }

    const committed = this.#store.commitFeed({
      feedId,
      expectedRevision: current.revision,
      observations,
      backfillPhaseId,
      backfillNextRoundId,
      backfillStatus,
      retainAfterUnixSeconds: (retainAfter > 0n ? retainAfter : 1n).toString(10),
      now: this.#clock.now(),
    });
    current = committed;
    if (current.integrityStatus === "conflict") {
      throw new ReferenceMarketOperationError("source_inconsistent");
    }
    if (stoppedByFailure !== undefined && !isBoundedSourceStop(stoppedByFailure)) {
      throw stoppedByFailure;
    }
    const traversal = referenceFeedTraversalStateSchema.parse({
      backfillPhaseId: current.backfillPhaseId,
      backfillNextRoundId: current.backfillNextRoundId,
      backfillStatus: current.backfillStatus,
      retentionCutoffRoundId: current.retentionCutoffRoundId,
    });
    const remaining = createReferenceHistoryWorkPlan({
      latestRoundId: job.latest.fact.roundId,
      observations: current.observations,
      traversal,
    });
    return Object.freeze({
      snapshot: current,
      report: referenceHistoryTraversalReportSchema.parse({
        remainingContinuation: remaining.remainingContinuation,
        remainingGap: remaining.remainingGap,
        phaseBoundaryObserved:
          phaseBoundaryObserved || current.backfillStatus === "phase_boundary",
        malformedRoundObserved:
          malformedRoundObserved || current.backfillStatus === "malformed",
      }),
    });
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#state = "closing";
    this.#owner.abort();
    for (const job of this.#pending.splice(0)) {
      job.removeAbortListener?.();
      job.reject(new ReferenceMarketOperationError("runtime_state_unavailable"));
    }
    this.#closePromise = Promise.allSettled([...this.#activeSettlements]).then(() => {
      this.#state = "closed";
    });
    return this.#closePromise;
  }
}
