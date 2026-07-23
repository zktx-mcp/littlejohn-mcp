import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import {
  chainAnchorSchema,
  createExactRational,
  parseCapabilityDataAt,
  parseEvmAddressInput,
  parseEvmChainId,
  parseUtcTimestamp,
  referenceMarketManifest,
  referenceRoundObservationSchema,
  walletConnectionCapability,
  type ChainAnchor,
  type ReferenceRoundObservation,
} from "../../src/core/index.js";
import { ProductDatabase } from "../../src/runtime/database.js";
import { RuntimeOperationError } from "../../src/runtime/errors.js";
import { ensureOwnerOnlyDirectory, runtimePaths } from "../../src/runtime/paths.js";
import { parseRuntimeRevision } from "../../src/runtime/runtime-identity.js";

const directories: string[] = [];
const now = parseUtcTimestamp("2026-07-22T15:07:34.000Z");
const chainId = parseEvmChainId("eip155:4663");
const address = parseEvmAddressInput(`0x${"12".repeat(20)}`);
const account = Object.freeze({ chainId, address });
const connectedRevision = parseRuntimeRevision("1");
const rpcConfigurationDigest = "A".repeat(43);
const roundId = (aggregatorRoundId: number): string =>
  ((1n << 64n) | BigInt(aggregatorRoundId)).toString(10);
const firstReadBlock = Object.freeze({
  chainId: "eip155:4663" as const,
  blockNumber: "16520666",
  blockHash: `0x${"39".repeat(32)}` as const,
  blockTimestamp: "2026-07-22T15:07:34.000Z" as const,
});

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

const openConnected = async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "littlejohn-reference-market-"));
  directories.push(directory);
  await ensureOwnerOnlyDirectory(directory);
  const database = await ProductDatabase.open(runtimePaths(directory).database, now);
  database.configuredChainStore().insertConfiguredChainIfAbsent(chainId);
  database.walletStore().replace("0", parseCapabilityDataAt(walletConnectionCapability, {
    status: "connected",
    address,
    chainId,
    approvedMethods: ["eth_sendTransaction"],
    approvedEvents: ["accountsChanged", "chainChanged"],
    expiresAt: "2026-07-23T15:07:34.000Z",
  }, now), now);
  return { database, directory };
};

const observation = (
  answer = "193384405462",
  input: Readonly<{
    roundId?: string;
    updatedAtUnixSeconds?: string;
    observedAt?: string;
    block?: ChainAnchor;
  }> = {},
) => {
  const feed = referenceMarketManifest.feeds[0]!;
  const roundId = input.roundId ?? "18446744073709552818";
  const updatedAtUnixSeconds = input.updatedAtUnixSeconds ?? "1784731033";
  return referenceRoundObservationSchema.parse({
    fact: {
      manifestVersion: 1,
      feedId: "eth_usd",
      proxyAddress: feed.standardProxy,
      decimals: 8,
      roundId,
      answeredInRound: roundId,
      answer,
      startedAtUnixSeconds: updatedAtUnixSeconds,
      updatedAtUnixSeconds,
      value: createExactRational(BigInt(answer), 100_000_000n),
    },
    readEvidence: {
      observedAt: input.observedAt ?? now,
      sourceOwner: "user_configured",
      sourceClass: "chain_rpc",
      sourceReference: {
        kind: "configured_rpc",
        sourceId: `rpc:${rpcConfigurationDigest}`,
        publicOrigin: "https://rpc.example",
        configurationDigest: rpcConfigurationDigest,
      },
      block: input.block ?? firstReadBlock,
    },
  });
};

describe("reference-market storage", () => {
  it("rejects zero composite-round facts and traversal pointers before durable mutation", async () => {
    const { database } = await openConnected();
    const store = database.referenceMarketStore();
    const admitted = observation();
    for (const invalidRoundId of ["1", (1n << 64n).toString(10)]) {
      const invalidObservation = Object.freeze({
        ...admitted,
        fact: Object.freeze({
          ...admitted.fact,
          roundId: invalidRoundId,
          answeredInRound: invalidRoundId,
        }),
      }) as ReferenceRoundObservation;
      expect(() => store.commitFeed({
        feedId: "eth_usd",
        expectedRevision: null,
        observations: [invalidObservation],
        backfillPhaseId: null,
        backfillNextRoundId: null,
        backfillStatus: null,
        retainAfterUnixSeconds: "1",
        now,
      })).toThrow();
      expect(() => store.commitFeed({
        feedId: "eth_usd",
        expectedRevision: null,
        observations: [],
        backfillPhaseId: "1",
        backfillNextRoundId: invalidRoundId,
        backfillStatus: null,
        retainAfterUnixSeconds: "1",
        now,
      })).toThrow();
      expect(store.readFeed("eth_usd")).toMatchObject({
        revision: null,
        observations: [],
      });
    }
    database.close();
  });

  it("commits an exact cache batch atomically and makes conflicting re-observation permanent", async () => {
    const { database } = await openConnected();
    const store = database.referenceMarketStore();
    expect(store.readFeed("eth_usd")).toMatchObject({ revision: null, observations: [] });

    const admitted = observation();
    const first = store.commitFeed({
      feedId: "eth_usd",
      expectedRevision: null,
      observations: [admitted],
      backfillPhaseId: "1",
      backfillNextRoundId: "18446744073709552817",
      backfillStatus: null,
      retainAfterUnixSeconds: "1782054454",
      now,
    });
    expect(first.observations).toHaveLength(1);
    expect(first.backfillPhaseId).toBe("1");
    expect(() => store.commitFeed({
      feedId: "eth_usd",
      expectedRevision: first.revision,
      observations: [],
      backfillPhaseId: "2",
      backfillNextRoundId: first.backfillNextRoundId,
      backfillStatus: null,
      retainAfterUnixSeconds: "1782054454",
      now,
    })).toThrow();
    const laterReadBlock = chainAnchorSchema.parse({
      ...firstReadBlock,
      blockNumber: "16520667",
      blockHash: `0x${"3a".repeat(32)}` as const,
      blockTimestamp: "2026-07-22T15:08:00.000Z" as const,
    });
    const exact = store.commitFeed({
      feedId: "eth_usd",
      expectedRevision: first.revision,
      observations: [observation("193384405462", {
        observedAt: "2026-07-22T15:08:01.000Z",
        block: laterReadBlock,
      })],
      backfillPhaseId: first.backfillPhaseId,
      backfillNextRoundId: first.backfillNextRoundId,
      backfillStatus: null,
      retainAfterUnixSeconds: "1782054454",
      now,
    });
    expect(exact.revision).toBe(first.revision);
    expect(exact.observations[0]?.readEvidence).toEqual(admitted.readEvidence);

    const conflicted = store.commitFeed({
      feedId: "eth_usd",
      expectedRevision: exact.revision,
      observations: [observation("193384405463")],
      backfillPhaseId: exact.backfillPhaseId,
      backfillNextRoundId: exact.backfillNextRoundId,
      backfillStatus: null,
      retainAfterUnixSeconds: "1782054454",
      now,
    });
    expect(conflicted.integrityStatus).toBe("conflict");
    expect(conflicted.observations[0]?.fact.answer).toBe("193384405462");
    expect(conflicted.observations[0]?.readEvidence).toEqual(admitted.readEvidence);
    expect(store.commitFeed({
      feedId: "eth_usd",
      expectedRevision: conflicted.revision,
      observations: [],
      backfillPhaseId: null,
      backfillNextRoundId: null,
      backfillStatus: null,
      retainAfterUnixSeconds: "1782054454",
      now,
    })).toEqual(conflicted);
    database.close();
  });

  it("evicts only an expired identity prefix and makes its cutoff irreversible", async () => {
    const { database } = await openConnected();
    const store = database.referenceMarketStore();
    const oldRound = observation("193300000000", {
      roundId: "18446744073709552817",
      updatedAtUnixSeconds: "1782000000",
    });
    const retainedRound = observation();
    const committed = store.commitFeed({
      feedId: "eth_usd",
      expectedRevision: null,
      observations: [oldRound, retainedRound],
      backfillPhaseId: "1",
      backfillNextRoundId: "18446744073709552816",
      backfillStatus: null,
      retainAfterUnixSeconds: "1783000000",
      now,
    });

    expect(committed.observations.map((entry) => entry.fact.roundId)).toEqual([retainedRound.fact.roundId]);
    expect(committed.backfillPhaseId).toBe("1");
    expect(committed.backfillNextRoundId).toBeNull();
    expect(committed.backfillStatus).toBe("retention_boundary");
    expect(committed.retentionCutoffRoundId).toBe(oldRound.fact.roundId);
    expect(store.readFeed("eth_usd")).toEqual(committed);
    const repeated = store.commitFeed({
      feedId: "eth_usd",
      expectedRevision: committed.revision,
      observations: [],
      backfillPhaseId: committed.backfillPhaseId,
      backfillNextRoundId: committed.backfillNextRoundId,
      backfillStatus: committed.backfillStatus,
      retainAfterUnixSeconds: "1",
      now,
    });
    expect(repeated).toEqual(committed);
    expect(repeated.retentionCutoffRoundId).toBe(oldRound.fact.roundId);
    expect(() => store.commitFeed({
      feedId: "eth_usd",
      expectedRevision: committed.revision,
      observations: [oldRound],
      backfillPhaseId: committed.backfillPhaseId,
      backfillNextRoundId: committed.backfillNextRoundId,
      backfillStatus: committed.backfillStatus,
      retainAfterUnixSeconds: "1783000000",
      now,
    })).toThrow(RuntimeOperationError);
    expect(store.readFeed("eth_usd")).toEqual(committed);
    database.close();
  });

  it("does not scatter-delete an expired fact after a retained identity", async () => {
    const { database } = await openConnected();
    const store = database.referenceMarketStore();
    const observations = [
      observation("193300000001", {
        roundId: roundId(1),
        updatedAtUnixSeconds: "1782000000",
      }),
      observation("193300000002", {
        roundId: roundId(2),
        updatedAtUnixSeconds: "1784000000",
      }),
      observation("193300000003", {
        roundId: roundId(3),
        updatedAtUnixSeconds: "1782100000",
      }),
      observation("193300000004", {
        roundId: roundId(4),
        updatedAtUnixSeconds: "1784100000",
      }),
    ];
    const committed = store.commitFeed({
      feedId: "eth_usd",
      expectedRevision: null,
      observations,
      backfillPhaseId: "1",
      backfillNextRoundId: roundId(5),
      backfillStatus: null,
      retainAfterUnixSeconds: "1783000000",
      now,
    });

    expect(committed.retentionCutoffRoundId).toBe(roundId(1));
    expect(committed.observations.map((entry) => entry.fact.roundId)).toEqual([
      roundId(3),
      roundId(2),
      roundId(4),
    ]);
    expect(committed.observations.find((entry) => entry.fact.roundId === roundId(3))
      ?.fact.updatedAtUnixSeconds).toBe("1782100000");
    database.close();
  });

  it("capacity eviction retains the 16,384 greatest identities and advances one exact cutoff", async () => {
    const { database } = await openConnected();
    const store = database.referenceMarketStore();
    let current = store.readFeed("eth_usd");
    for (let first = 1; first <= 16_385; first += 1_024) {
      const last = Math.min(first + 1_023, 16_385);
      const observations = Array.from(
        { length: last - first + 1 },
        (_, index) => observation("193384405462", { roundId: roundId(first + index) }),
      );
      current = store.commitFeed({
        feedId: "eth_usd",
        expectedRevision: current.revision,
        observations,
        backfillPhaseId: null,
        backfillNextRoundId: null,
        backfillStatus: null,
        retainAfterUnixSeconds: "1",
        now,
      });
    }
    const retained = store.readFeed("eth_usd");
    expect(retained.observations).toHaveLength(16_384);
    expect(new Set(retained.observations.map((entry) => entry.fact.roundId))).toEqual(
      new Set(Array.from({ length: 16_384 }, (_, index) => roundId(index + 2))),
    );
    expect(retained.retentionCutoffRoundId).toBe(roundId(1));
    expect(retained).toMatchObject({
      backfillPhaseId: null,
      backfillNextRoundId: null,
      backfillStatus: null,
    });
    expect(() => store.commitFeed({
      feedId: "eth_usd",
      expectedRevision: retained.revision,
      observations: [observation("193384405462", { roundId: roundId(1) })],
      backfillPhaseId: retained.backfillPhaseId,
      backfillNextRoundId: retained.backfillNextRoundId,
      backfillStatus: retained.backfillStatus,
      retainAfterUnixSeconds: "1",
      now,
    })).toThrow(RuntimeOperationError);
    expect(store.readFeed("eth_usd")).toEqual(retained);
    database.close();
  }, 30_000);

  it("rejects non-manifest feed identities at admission and during startup integrity scanning", async () => {
    const { database, directory } = await openConnected();
    database.close();
    const path = runtimePaths(directory).database;
    const raw = new Database(path);
    const insert = raw.prepare(`INSERT INTO reference_feed_sync_state(
      manifest_version, chain_id, feed_id, proxy_address, revision, backfill_phase_id,
      backfill_next_round_id,
      retention_cutoff_round_id, integrity_status, backfill_status, updated_at
    ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?)`);
    const wrongProxy = referenceMarketManifest.feeds[1]!.standardProxy;
    expect(() => insert.run(1, chainId, "eth_usd", wrongProxy, "AQEBAQEBAQEBAQEBAQEBAQ", now))
      .toThrow();
    raw.pragma("ignore_check_constraints = ON");
    insert.run(1, chainId, "eth_usd", wrongProxy, "AQEBAQEBAQEBAQEBAQEBAQ", now);
    raw.close();

    await expect(ProductDatabase.open(path, now)).rejects.toMatchObject({
      failure: { error: { code: "runtime_state_unavailable" } },
    });
  });

  it("owns add, no-op reorder, stale revision rejection, remove, and restart persistence", async () => {
    const { database, directory } = await openConnected();
    const store = database.referenceMarketStore();
    const initial = store.readWatchlist(account);
    expect(initial.entries).toEqual([]);
    const pair = referenceMarketManifest.pairs[0]!;
    const added = store.mutateWatchlist({
      account,
      expectedConnectionRevision: connectedRevision,
      expectedRevision: initial.revision,
      mutation: { kind: "add", pairId: pair.pairId },
      now,
    });
    expect(added.status).toBe("success");
    if (added.status !== "success") throw new Error("Expected a stored watchlist.");
    const noOp = store.mutateWatchlist({
      account,
      expectedConnectionRevision: connectedRevision,
      expectedRevision: added.watchlist.revision,
      mutation: { kind: "reorder", pairIds: [pair.pairId] },
      now,
    });
    expect(noOp).toEqual(added);
    expect(() => store.mutateWatchlist({
      account,
      expectedConnectionRevision: connectedRevision,
      expectedRevision: initial.revision,
      mutation: { kind: "remove", pairId: pair.pairId },
      now,
    })).toThrow(RuntimeOperationError);
    database.close();

    const reopened = await ProductDatabase.open(runtimePaths(directory).database, now);
    expect(reopened.referenceMarketStore().readWatchlist(account)).toEqual(added.watchlist);
    const removed = reopened.referenceMarketStore().mutateWatchlist({
      account,
      expectedConnectionRevision: connectedRevision,
      expectedRevision: added.watchlist.revision,
      mutation: { kind: "remove", pairId: pair.pairId },
      now,
    });
    expect(removed.status).toBe("success");
    if (removed.status === "success") expect(removed.watchlist.entries).toEqual([]);
    reopened.close();
  });

  it("rejects duplicate, missing, incomplete-order, and changed-wallet mutations without changing state", async () => {
    const { database } = await openConnected();
    const store = database.referenceMarketStore();
    const initial = store.readWatchlist(account);
    const pair = referenceMarketManifest.pairs[0]!;

    expect(store.mutateWatchlist({
      account,
      expectedConnectionRevision: connectedRevision,
      expectedRevision: initial.revision,
      mutation: { kind: "remove", pairId: pair.pairId },
      now,
    })).toEqual({ status: "rejected", reason: "watchlist_pair_not_found" });
    expect(store.readWatchlist(account)).toEqual(initial);

    const added = store.mutateWatchlist({
      account,
      expectedConnectionRevision: connectedRevision,
      expectedRevision: initial.revision,
      mutation: { kind: "add", pairId: pair.pairId },
      now,
    });
    if (added.status !== "success") throw new Error("Expected a stored watchlist.");
    expect(store.mutateWatchlist({
      account,
      expectedConnectionRevision: connectedRevision,
      expectedRevision: added.watchlist.revision,
      mutation: { kind: "add", pairId: pair.pairId },
      now,
    })).toEqual({ status: "rejected", reason: "watchlist_pair_already_saved" });
    expect(store.mutateWatchlist({
      account,
      expectedConnectionRevision: connectedRevision,
      expectedRevision: added.watchlist.revision,
      mutation: { kind: "reorder", pairIds: [] },
      now,
    })).toEqual({ status: "rejected", reason: "watchlist_order_conflict" });
    expect(store.readWatchlist(account)).toEqual(added.watchlist);

    let full = added.watchlist;
    for (const nextPair of referenceMarketManifest.pairs.slice(1)) {
      const result = store.mutateWatchlist({
        account,
        expectedConnectionRevision: connectedRevision,
        expectedRevision: full.revision,
        mutation: { kind: "add", pairId: nextPair.pairId },
        now,
      });
      if (result.status !== "success") throw new Error("Expected the watchlist to reach its fixed capacity.");
      full = result.watchlist;
    }
    expect(store.mutateWatchlist({
      account,
      expectedConnectionRevision: connectedRevision,
      expectedRevision: full.revision,
      mutation: { kind: "add", pairId: pair.pairId },
      now,
    })).toEqual({ status: "rejected", reason: "watchlist_full" });
    expect(store.readWatchlist(account)).toEqual(full);

    const alternateAddress = parseEvmAddressInput(`0x${"34".repeat(20)}`);
    database.walletStore().replace(connectedRevision, parseCapabilityDataAt(walletConnectionCapability, {
      status: "connected",
      address: alternateAddress,
      chainId,
      approvedMethods: ["eth_sendTransaction"],
      approvedEvents: ["accountsChanged", "chainChanged"],
      expiresAt: "2026-07-23T15:07:34.000Z",
    }, now), now);
    expect(() => store.mutateWatchlist({
      account,
      expectedConnectionRevision: connectedRevision,
      expectedRevision: full.revision,
      mutation: { kind: "remove", pairId: pair.pairId },
      now,
    })).toThrow(RuntimeOperationError);
    expect(store.readWatchlist(account)).toEqual(full);
    database.close();
  });
});
