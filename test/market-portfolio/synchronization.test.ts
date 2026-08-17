import { describe, expect, it } from "vitest";

import type {
  ReferenceHistoryTraversal,
  ReferenceMarketChainReadPort,
} from "../../src/chain/reference-market.js";
import { resolveConfiguredCanonicalBlock } from "../../src/chain/canonical-block.js";
import {
  createChainInvocationLifecycle,
  type ChainInvocationContext,
  type ChainInvocationLifecycle,
} from "../../src/chain/invocation-lifecycle.js";
import {
  ChainOperationError,
  getChainOperationFailure,
} from "../../src/chain/errors.js";
import {
  chainAnchorSchema,
  createCanonicalClock,
  createExactRational,
  findReferenceFeed,
  referenceFeedIds,
  referenceRoundObservationSchema,
  type ReferenceFeedId,
  type ReferenceRoundObservation,
} from "../../src/core/index.js";
import {
  getReferenceMarketOperationFailure,
  ReferenceMarketOperationError,
} from "../../src/market-portfolio/errors.js";
import { ReferenceFeedSynchronizationOwner } from "../../src/market-portfolio/synchronization.js";
import type {
  ReferenceFeedCacheCommit,
  ReferenceFeedCacheSnapshot,
  ReferenceMarketStore,
} from "../../src/runtime/reference-market-storage.js";

const block = chainAnchorSchema.parse({
  chainId: "eip155:4663",
  blockNumber: "16520666",
  blockHash: `0x${"39".repeat(32)}`,
  blockTimestamp: "2026-07-22T15:07:34.000Z",
});
const rpcConfigurationDigest = "A".repeat(43);
const issueBlock = (context: ChainInvocationContext) => resolveConfiguredCanonicalBlock({
  rpc: {
    async request(method) {
      if (method === "eth_chainId") return "0x1237";
      if (method === "eth_getBlockByNumber") {
        return {
          number: `0x${BigInt(block.blockNumber).toString(16)}`,
          hash: block.blockHash,
          timestamp: `0x${BigInt(Math.floor(Date.parse(block.blockTimestamp) / 1_000)).toString(16)}`,
        };
      }
      throw new Error(`Unexpected block fixture method: ${method}`);
    },
  },
  chainId: block.chainId,
  selector: { kind: "latest" },
  context,
});

const synchronize = (
  lifecycle: ChainInvocationLifecycle,
  owner: ReferenceFeedSynchronizationOwner,
  input: Omit<Parameters<ReferenceFeedSynchronizationOwner["synchronize"]>[0], "block" | "context">,
  callerSignal = new AbortController().signal,
) => lifecycle.run(callerSignal, async (context) => owner.synchronize({
  ...input,
  block: await issueBlock(context),
  context,
}));

const unexpectedStockTokenRead: ReferenceMarketChainReadPort["readStockTokenAtBlock"] =
  async () => { throw new Error("Stock Token reads are outside synchronization tests."); };

const observation = (
  aggregatorRound: bigint,
  feedId: ReferenceFeedId = "eth_usd",
): ReferenceRoundObservation => {
  const feed = findReferenceFeed(feedId);
  const roundId = ((1n << 64n) | aggregatorRound).toString(10);
  return referenceRoundObservationSchema.parse({
    fact: {
      manifestVersion: 1,
      feedId,
      proxyAddress: feed.standardProxy,
      decimals: feed.decimals,
      roundId,
      answeredInRound: roundId,
      answer: "193384405462",
      startedAtUnixSeconds: "1784731021",
      updatedAtUnixSeconds: "1784731033",
      value: createExactRational(193_384_405_462n, 100_000_000n),
    },
    readEvidence: {
      observedAt: "2026-07-22T15:07:34.000Z",
      sourceOwner: "user_configured",
      sourceClass: "chain_rpc",
      sourceReference: {
        kind: "configured_rpc",
        sourceId: `rpc:${rpcConfigurationDigest}`,
        publicOrigin: "https://rpc.example",
        configurationDigest: rpcConfigurationDigest,
      },
      block,
    },
  });
};

const deferred = <Value>() => {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const storeFixture = (
  initial: readonly ReferenceFeedCacheSnapshot[] = [],
): ReferenceMarketStore => {
  const snapshots = new Map<ReferenceFeedId, ReferenceFeedCacheSnapshot>(
    initial.map((snapshot) => [snapshot.feedId, snapshot]),
  );
  const empty = (feedId: ReferenceFeedId): ReferenceFeedCacheSnapshot => Object.freeze({
    feedId,
    revision: null,
    observations: Object.freeze([]),
    backfillPhaseId: null,
    backfillNextRoundId: null,
    retentionCutoffRoundId: null,
    integrityStatus: null,
    backfillStatus: null,
  });
  return Object.freeze({
    readFeed: (feedId: ReferenceFeedId) => snapshots.get(feedId) ?? empty(feedId),
    commitFeed: (input: ReferenceFeedCacheCommit) => {
      const current = snapshots.get(input.feedId) ?? empty(input.feedId);
      if (current.revision !== input.expectedRevision) throw new Error("Unexpected cache revision.");
      const next = Object.freeze({
        feedId: input.feedId,
        revision: current.revision === null ? "AQEBAQEBAQEBAQEBAQEBAQ" : "AgICAgICAgICAgICAgICAg",
        observations: Object.freeze([...current.observations, ...input.observations]),
        backfillPhaseId: input.backfillPhaseId,
        backfillNextRoundId: input.backfillNextRoundId,
        retentionCutoffRoundId: current.retentionCutoffRoundId,
        integrityStatus: current.integrityStatus,
        backfillStatus: input.backfillStatus,
      }) satisfies ReferenceFeedCacheSnapshot;
      snapshots.set(input.feedId, next);
      return next;
    },
    readWatchlist: () => { throw new Error("Watchlist access is not expected."); },
    readWatchlistOperation: () => { throw new Error("Watchlist operation access is not expected."); },
    applyWatchlistChange: () => { throw new Error("Watchlist mutation is not expected."); },
  });
};

const traversal = (): ReferenceHistoryTraversal => Object.freeze({
  observations: Object.freeze([]),
  backfillPhaseId: "1",
  backfillNextRoundId: ((1n << 64n) | 1n).toString(10),
  backfillStatus: null,
  phaseBoundaryObserved: false,
  malformedRoundObserved: false,
  failure: undefined,
});
const anyRejectedReason = Symbol("any_rejected_reason");

describe("reference feed synchronization ownership", () => {
  it("keeps recorded failure occurrence independent from payload and provenance", async () => {
    const sourceShapedCause = new ChainOperationError("source_unavailable");
    const localFailure = Object.freeze(new Error("Local observation capture failed.", {
      cause: sourceShapedCause,
    }));
    const cases = [{
      name: "direct rejection",
      read: (async () => { throw undefined; }) as ReferenceMarketChainReadPort["readHistoryAtBlock"],
      expectedCommits: 1,
      expectedFailure: undefined,
    }, {
      name: "local failure with a source-shaped cause",
      read: (async () => Object.freeze({
        ...traversal(),
        failure: Object.freeze({ reason: localFailure }),
      })) as ReferenceMarketChainReadPort["readHistoryAtBlock"],
      expectedCommits: 1,
      expectedFailure: localFailure,
    }, {
      name: "traversal failure record",
      read: (async () => Object.freeze({
        ...traversal(),
        failure: Object.freeze({ reason: undefined }),
      })) as ReferenceMarketChainReadPort["readHistoryAtBlock"],
      expectedCommits: 1,
      expectedFailure: undefined,
    }, {
      name: "nonconforming fulfillment",
      read: (async () => undefined as never) as ReferenceMarketChainReadPort["readHistoryAtBlock"],
      expectedCommits: 0,
      expectedFailure: anyRejectedReason,
    }] as const;

    for (const scenario of cases) {
      const lifecycle = createChainInvocationLifecycle(new AbortController().signal);
      const store = storeFixture();
      let commits = 0;
      const trackedStore: ReferenceMarketStore = Object.freeze({
        ...store,
        commitFeed(input: ReferenceFeedCacheCommit) {
          commits += 1;
          return store.commitFeed(input);
        },
      });
      const owner = new ReferenceFeedSynchronizationOwner({
        chain: {
          resolveCurrentBlock: async () => { throw new Error("Unexpected block resolution."); },
          readLatestAtBlock: async () => [],
          readStockTokenAtBlock: unexpectedStockTokenRead,
          readHistoryAtBlock: scenario.read,
        },
        store: trackedStore,
        clock: createCanonicalClock(() => "2026-07-22T15:07:34.000Z"),
      });
      const outcome = await synchronize(lifecycle, owner, {
        feedId: "eth_usd",
        requestedStartUnixSeconds: 1n,
        latest: observation(2n),
      }).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      );
      expect(outcome.status, scenario.name).toBe("rejected");
      if (outcome.status === "rejected") {
        if (scenario.expectedFailure === anyRejectedReason) {
          expect(getChainOperationFailure(outcome.reason), scenario.name).toBeUndefined();
          expect(getReferenceMarketOperationFailure(outcome.reason), scenario.name).toBeUndefined();
        } else {
          expect(outcome.reason, scenario.name).toBe(scenario.expectedFailure);
        }
      }
      expect(commits, scenario.name).toBe(scenario.expectedCommits);
      expect(
        trackedStore.readFeed("eth_usd").observations.map((entry) => entry.fact.roundId),
        scenario.name,
      ).toEqual(scenario.expectedCommits === 0 ? [] : [observation(2n).fact.roundId]);
      await owner.close();
      await lifecycle.close();
    }
  });

  it("serializes one feed in FIFO order while a queued caller can cancel independently", async () => {
    const lifecycle = createChainInvocationLifecycle(new AbortController().signal);
    const starts: string[] = [];
    const pending: Array<ReturnType<typeof deferred<ReferenceHistoryTraversal>>> = [];
    const chain: ReferenceMarketChainReadPort = {
      resolveCurrentBlock: async () => { throw new Error("Unexpected block resolution."); },
      readLatestAtBlock: async () => [],
      readStockTokenAtBlock: unexpectedStockTokenRead,
      readHistoryAtBlock: async (input) => {
        starts.push(input.latestRoundId);
        const result = deferred<ReferenceHistoryTraversal>();
        pending.push(result);
        return await result.promise;
      },
    };
    const owner = new ReferenceFeedSynchronizationOwner({
      chain,
      store: storeFixture(),
      clock: createCanonicalClock(() => "2026-07-22T15:07:34.000Z"),
    });
    const first = synchronize(lifecycle, owner, {
      feedId: "eth_usd", requestedStartUnixSeconds: 1n,
      latest: observation(4n),
    });
    const cancelledController = new AbortController();
    const cancelled = synchronize(lifecycle, owner, {
      feedId: "eth_usd", requestedStartUnixSeconds: 1n,
      latest: observation(3n),
    }, cancelledController.signal);
    const third = synchronize(lifecycle, owner, {
      feedId: "eth_usd", requestedStartUnixSeconds: 1n,
      latest: observation(2n),
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(starts).toHaveLength(1);
    cancelledController.abort();
    await expect(cancelled).rejects.toSatisfy((error: unknown) =>
      getChainOperationFailure(error)?.error.code === "request_aborted");
    expect(starts).toHaveLength(1);

    pending[0]!.resolve(traversal());
    await first;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(starts).toHaveLength(2);
    pending[1]!.resolve(traversal());
    await third;
    await owner.close();
    await lifecycle.close();
  });

  it("bounds the shared scheduler at two active and 32 total jobs and releases a cancelled place", async () => {
    const lifecycle = createChainInvocationLifecycle(new AbortController().signal);
    const activeReads = [deferred<ReferenceHistoryTraversal>(), deferred<ReferenceHistoryTraversal>()];
    const starts: ReferenceFeedId[] = [];
    const secondFeedId = referenceFeedIds.find((feedId) => feedId !== "eth_usd")!;
    const chain: ReferenceMarketChainReadPort = {
      resolveCurrentBlock: async () => { throw new Error("Unexpected block resolution."); },
      readLatestAtBlock: async () => [],
      readStockTokenAtBlock: unexpectedStockTokenRead,
      readHistoryAtBlock: async (input) => {
        starts.push(input.feedId);
        const gate = activeReads[starts.length - 1];
        return gate === undefined ? traversal() : await gate.promise;
      },
    };
    const owner = new ReferenceFeedSynchronizationOwner({
      chain,
      store: storeFixture(),
      clock: createCanonicalClock(() => "2026-07-22T15:07:34.000Z"),
    });
    const first = synchronize(lifecycle, owner, {
      feedId: "eth_usd",
      requestedStartUnixSeconds: 1n,
      latest: observation(100n),
    });
    const second = synchronize(lifecycle, owner, {
      feedId: secondFeedId,
      requestedStartUnixSeconds: 1n,
      latest: observation(100n, secondFeedId),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(new Set(starts)).toEqual(new Set(["eth_usd", secondFeedId]));

    const controllers = Array.from({ length: 30 }, () => new AbortController());
    const queued = controllers.map((controller, index) => synchronize(lifecycle, owner, {
      feedId: "eth_usd",
      requestedStartUnixSeconds: 1n,
      latest: observation(BigInt(99 - index)),
    }, controller.signal));
    await new Promise<void>((resolve) => setImmediate(resolve));

    await expect(synchronize(lifecycle, owner, {
      feedId: "eth_usd",
      requestedStartUnixSeconds: 1n,
      latest: observation(60n),
    })).rejects.toSatisfy((error: unknown) =>
      getReferenceMarketOperationFailure(error)?.error.code === "runtime_busy");

    controllers[7]!.abort();
    await expect(queued[7]).rejects.toSatisfy((error: unknown) =>
      getChainOperationFailure(error)?.error.code === "request_aborted");
    const replacement = synchronize(lifecycle, owner, {
      feedId: "eth_usd",
      requestedStartUnixSeconds: 1n,
      latest: observation(59n),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    activeReads[0]!.resolve(traversal());
    activeReads[1]!.resolve(traversal());
    await Promise.all([first, second]);
    await Promise.all(queued.filter((_entry, index) => index !== 7));
    await replacement;
    await owner.close();
    await lifecycle.close();
  });

  it("publishes an active job before synchronous chain reentry and drains it", async () => {
    const lifecycle = createChainInvocationLifecycle(new AbortController().signal);
    const readStarted = deferred<void>();
    const releaseRead = deferred<ReferenceHistoryTraversal>();
    let reads = 0;
    let effectClose: Promise<void> | undefined;
    let owner!: ReferenceFeedSynchronizationOwner;
    owner = new ReferenceFeedSynchronizationOwner({
      chain: {
        resolveCurrentBlock: async () => { throw new Error("Unexpected block resolution."); },
        readLatestAtBlock: async () => [],
        readStockTokenAtBlock: unexpectedStockTokenRead,
        readHistoryAtBlock: async () => {
          reads += 1;
          effectClose = owner.close();
          readStarted.resolve();
          return await releaseRead.promise;
        },
      },
      store: storeFixture(),
      clock: createCanonicalClock(() => "2026-07-22T15:07:34.000Z"),
    });

    const active = synchronize(lifecycle, owner, {
      feedId: "eth_usd",
      requestedStartUnixSeconds: 1n,
      latest: observation(2n),
    });
    await readStarted.promise;
    if (effectClose === undefined) throw new TypeError("Synchronization close was not started.");
    expect(owner.close()).toBe(effectClose);

    let closeSettled = false;
    void effectClose.then(
      () => { closeSettled = true; },
      () => { closeSettled = true; },
    );
    await new Promise<void>((resolveTurn) => { setImmediate(resolveTurn); });
    expect(closeSettled).toBe(false);
    expect(reads).toBe(1);
    await expect(synchronize(lifecycle, owner, {
      feedId: "eth_usd",
      requestedStartUnixSeconds: 1n,
      latest: observation(1n),
    })).rejects.toSatisfy((error: unknown) =>
      getReferenceMarketOperationFailure(error)?.error.code === "runtime_state_unavailable");

    releaseRead.resolve(traversal());
    await expect(active).resolves.toMatchObject({ snapshot: { feedId: "eth_usd" } });
    await effectClose;
    expect(closeSettled).toBe(true);
    await lifecycle.close();
  });

  it("drains an aborted active read before close resolves and rejects later work", async () => {
    const lifecycle = createChainInvocationLifecycle(new AbortController().signal);
    let committed = false;
    let readAborted = false;
    const readStarted = deferred<void>();
    const store = storeFixture();
    const chain: ReferenceMarketChainReadPort = {
      resolveCurrentBlock: async () => { throw new Error("Unexpected block resolution."); },
      readLatestAtBlock: async () => [],
      readStockTokenAtBlock: unexpectedStockTokenRead,
      readHistoryAtBlock: async (_input, context) => {
        readStarted.resolve();
        return await new Promise((_resolve, reject) => context.signal.addEventListener("abort", () => {
          readAborted = true;
          reject(new DOMException("Aborted.", "AbortError"));
        }, { once: true }));
      },
    };
    const trackedStore: ReferenceMarketStore = Object.freeze({
      ...store,
      commitFeed(input: ReferenceFeedCacheCommit) {
        const result = store.commitFeed(input);
        committed = true;
        return result;
      },
    });
    const owner = new ReferenceFeedSynchronizationOwner({
      chain,
      store: trackedStore,
      clock: createCanonicalClock(() => "2026-07-22T15:07:34.000Z"),
    });
    const caller = new AbortController();
    const active = synchronize(lifecycle, owner, {
      feedId: "eth_usd", requestedStartUnixSeconds: 1n,
      latest: observation(2n),
    }, caller.signal);
    await readStarted.promise;
    caller.abort();
    const closing = owner.close();
    await expect(active).rejects.toSatisfy((error: unknown) =>
      getChainOperationFailure(error)?.error.code === "request_aborted");
    await closing;
    expect({ readAborted, committed }).toEqual({ readAborted: true, committed: true });
    await expect(synchronize(lifecycle, owner, {
      feedId: "eth_usd", requestedStartUnixSeconds: 1n,
      latest: observation(1n),
    })).rejects.toSatisfy((error: unknown) =>
      getReferenceMarketOperationFailure(error)?.error.code === "runtime_state_unavailable");
    await lifecycle.close();
  });

  it("retains a malformed continuation when its explicit re-probe stops transiently", async () => {
    const lifecycle = createChainInvocationLifecycle(new AbortController().signal);
    const backfillNextRoundId = ((1n << 64n) | 3n).toString(10);
    const malformed: ReferenceFeedCacheSnapshot = Object.freeze({
      feedId: "eth_usd",
      revision: "AQEBAQEBAQEBAQEBAQEBAQ",
      observations: Object.freeze([observation(4n)]),
      backfillPhaseId: "1",
      backfillNextRoundId,
      retentionCutoffRoundId: null,
      integrityStatus: null,
      backfillStatus: "malformed",
    });
    const store = storeFixture([malformed]);
    const chain: ReferenceMarketChainReadPort = {
      resolveCurrentBlock: async () => { throw new Error("Unexpected block resolution."); },
      readLatestAtBlock: async () => [],
      readStockTokenAtBlock: unexpectedStockTokenRead,
      readHistoryAtBlock: async () => {
        throw new ReferenceMarketOperationError("source_unavailable");
      },
    };
    const owner = new ReferenceFeedSynchronizationOwner({
      chain,
      store,
      clock: createCanonicalClock(() => "2026-07-22T15:07:34.000Z"),
    });

    await expect(synchronize(lifecycle, owner, {
      feedId: "eth_usd", requestedStartUnixSeconds: 1n,
      latest: observation(5n),
    })).resolves.toMatchObject({
      report: {
        remainingContinuation: true,
      },
    });
    expect(store.readFeed("eth_usd")).toMatchObject({
      backfillNextRoundId,
      backfillStatus: "malformed",
    });
    await owner.close();
    await lifecycle.close();
  });

  it("still asks the chain owner for head gaps after older backfill reached a phase boundary", async () => {
    const lifecycle = createChainInvocationLifecycle(new AbortController().signal);
    const existing: ReferenceFeedCacheSnapshot = Object.freeze({
      feedId: "eth_usd",
      revision: "AQEBAQEBAQEBAQEBAQEBAQ",
      observations: Object.freeze([observation(2n)]),
      backfillPhaseId: "1",
      backfillNextRoundId: null,
      retentionCutoffRoundId: null,
      integrityStatus: null,
      backfillStatus: "phase_boundary",
    });
    const store = storeFixture([existing]);
    let received: Parameters<ReferenceMarketChainReadPort["readHistoryAtBlock"]>[0] | undefined;
    const chain: ReferenceMarketChainReadPort = {
      resolveCurrentBlock: async () => { throw new Error("Unexpected block resolution."); },
      readLatestAtBlock: async () => [],
      readStockTokenAtBlock: unexpectedStockTokenRead,
      readHistoryAtBlock: async (input) => {
        received = input;
        return Object.freeze({
          observations: Object.freeze([observation(3n)]),
          backfillPhaseId: "1",
          backfillNextRoundId: null,
          backfillStatus: "phase_boundary" as const,
          phaseBoundaryObserved: true,
          malformedRoundObserved: false,
          failure: undefined,
        });
      },
    };
    const owner = new ReferenceFeedSynchronizationOwner({
      chain,
      store,
      clock: createCanonicalClock(() => "2026-07-22T15:07:34.000Z"),
    });
    const result = await synchronize(lifecycle, owner, {
      feedId: "eth_usd", requestedStartUnixSeconds: 1_784_731_033n,
      latest: observation(4n),
    });
    expect(received).toMatchObject({
      latestRoundId: observation(4n).fact.roundId,
      knownObservations: [observation(2n)],
      backfillPhaseId: "1",
      backfillStatus: "phase_boundary",
      retentionCutoffRoundId: null,
    });
    expect(result.snapshot).toEqual(store.readFeed("eth_usd"));
    expect(result.snapshot.observations.map((entry) => entry.fact.roundId)).toEqual([
      observation(2n).fact.roundId,
      observation(4n).fact.roundId,
      observation(3n).fact.roundId,
    ]);
    expect(result.report).toEqual({
      remainingContinuation: false,
      remainingGap: true,
      phaseBoundaryObserved: true,
      malformedRoundObserved: false,
    });
    await owner.close();
    await lifecycle.close();
  });

  it("passes the exact retention cutoff as a terminal boundary instead of reopening old backfill", async () => {
    const lifecycle = createChainInvocationLifecycle(new AbortController().signal);
    const cutoffRoundId = ((1n << 64n) | 1n).toString(10);
    const retained: ReferenceFeedCacheSnapshot = Object.freeze({
      feedId: "eth_usd",
      revision: "AQEBAQEBAQEBAQEBAQEBAQ",
      observations: Object.freeze([observation(2n)]),
      backfillPhaseId: "1",
      backfillNextRoundId: null,
      retentionCutoffRoundId: cutoffRoundId,
      integrityStatus: null,
      backfillStatus: "retention_boundary",
    });
    const store = storeFixture([retained]);
    let received: Parameters<ReferenceMarketChainReadPort["readHistoryAtBlock"]>[0] | undefined;
    const chain: ReferenceMarketChainReadPort = {
      resolveCurrentBlock: async () => { throw new Error("Unexpected block resolution."); },
      readLatestAtBlock: async () => [],
      readStockTokenAtBlock: unexpectedStockTokenRead,
      readHistoryAtBlock: async (input) => {
        received = input;
        return Object.freeze({
          observations: Object.freeze([]),
          backfillPhaseId: "1",
          backfillNextRoundId: null,
          backfillStatus: "retention_boundary" as const,
          phaseBoundaryObserved: false,
          malformedRoundObserved: false,
          failure: undefined,
        });
      },
    };
    const owner = new ReferenceFeedSynchronizationOwner({
      chain,
      store,
      clock: createCanonicalClock(() => "2026-07-22T15:07:34.000Z"),
    });
    const result = await synchronize(lifecycle, owner, {
      feedId: "eth_usd", requestedStartUnixSeconds: 1n,
      latest: observation(3n),
    });
    expect(received).toMatchObject({
      backfillPhaseId: "1",
      backfillNextRoundId: null,
      backfillStatus: "retention_boundary",
      retentionCutoffRoundId: cutoffRoundId,
    });
    expect(result.snapshot).toEqual(store.readFeed("eth_usd"));
    expect(result.snapshot.retentionCutoffRoundId).toBe(cutoffRoundId);
    expect(result.report).toEqual({
      remainingContinuation: false,
      remainingGap: false,
      phaseBoundaryObserved: false,
      malformedRoundObserved: false,
    });
    await owner.close();
    await lifecycle.close();
  });

  it("rejects a current source identity that regresses to the retained cutoff domain", async () => {
    const lifecycle = createChainInvocationLifecycle(new AbortController().signal);
    const cutoffRoundId = ((1n << 64n) | 3n).toString(10);
    const store = storeFixture([Object.freeze({
      feedId: "eth_usd",
      revision: "AQEBAQEBAQEBAQEBAQEBAQ",
      observations: Object.freeze([observation(4n)]),
      backfillPhaseId: "1",
      backfillNextRoundId: null,
      retentionCutoffRoundId: cutoffRoundId,
      integrityStatus: null,
      backfillStatus: "retention_boundary",
    })]);
    let historyReads = 0;
    const owner = new ReferenceFeedSynchronizationOwner({
      chain: {
        resolveCurrentBlock: async () => { throw new Error("Unexpected block resolution."); },
        readLatestAtBlock: async () => [],
        readStockTokenAtBlock: unexpectedStockTokenRead,
        readHistoryAtBlock: async () => {
          historyReads += 1;
          return traversal();
        },
      },
      store,
      clock: createCanonicalClock(() => "2026-07-22T15:07:34.000Z"),
    });
    await expect(synchronize(lifecycle, owner, {
      feedId: "eth_usd",
      requestedStartUnixSeconds: 1n,
      latest: observation(2n),
    })).rejects.toSatisfy((error: unknown) =>
      getReferenceMarketOperationFailure(error)?.error.code === "source_inconsistent");
    expect(historyReads).toBe(0);
    await owner.close();
    await lifecycle.close();
  });
});
