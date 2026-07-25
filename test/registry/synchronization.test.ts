import { describe, expect, it, vi } from "vitest";

import {
  createOfficialAssetSynchronization,
  officialAssetSnapshotRevisionSchema,
  type CommittedOfficialAssetSnapshot,
  type OfficialAssetSnapshotStore,
} from "../../src/registry/index.js";
import {
  createRobinhoodOfficialAssetSourceClient,
} from "../../src/registry/official-assets.js";
import type {
  RobinhoodOfficialAssetSourceClient,
  RobinhoodOfficialAssetSourceObservation,
} from "../../src/registry/official-asset-source-contract.js";
import { createTokenCatalogFailure } from "../../src/token-catalog/index.js";

const observedAt = "2026-07-21T00:00:00.000Z";
const sourceObservation = async (): Promise<RobinhoodOfficialAssetSourceObservation> =>
  await createRobinhoodOfficialAssetSourceClient({
    fetch: (async () => new Response(JSON.stringify({
      assets: [{
        id: `0x${"11".repeat(32)}`,
        status: "ASSET_STATUS_ACTIVE",
        deployments: [{ chainId: 4663, contractAddress: `0x${"22".repeat(20)}` }],
      }],
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch,
    now: () => new Date(observedAt),
  }).read(new AbortController().signal);

const committed = (
  observation: RobinhoodOfficialAssetSourceObservation,
  byte: number,
): CommittedOfficialAssetSnapshot => Object.freeze({
  ...observation,
  revision: officialAssetSnapshotRevisionSchema.parse(Buffer.alloc(16, byte).toString("base64url")),
  updatedAt: observation.sourceObservedAt,
});

const failures = Object.freeze({
  failureFor: () => createTokenCatalogFailure("source_unavailable"),
  abortedFailure: () => createTokenCatalogFailure("runtime_state_unavailable"),
});

describe("official asset synchronization", () => {
  it("shares one source read and one atomic replacement across concurrent callers", async () => {
    const observation = await sourceObservation();
    let release: (() => void) | undefined;
    const sourceRead = vi.fn(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return observation;
    });
    let stored: CommittedOfficialAssetSnapshot | undefined;
    const replaceSnapshot = vi.fn((input: RobinhoodOfficialAssetSourceObservation) => {
      stored = committed(input, 1);
      return stored;
    });
    const owner = new AbortController();
    const synchronization = createOfficialAssetSynchronization({
      source: Object.freeze({ read: sourceRead }),
      store: Object.freeze({ readSnapshot: () => stored, replaceSnapshot }),
      signal: owner.signal,
      ...failures,
    });

    const first = synchronization.synchronize(new AbortController().signal);
    const second = synchronization.synchronize(new AbortController().signal);
    expect(sourceRead).toHaveBeenCalledTimes(1);
    release?.();

    const results = await Promise.all([first, second]);
    expect(results).toEqual([
      { status: "current", snapshot: stored },
      { status: "current", snapshot: stored },
    ]);
    expect(replaceSnapshot).toHaveBeenCalledTimes(1);
    await synchronization.close();
  });

  it("preserves the prior revision when a source read fails", async () => {
    const observation = await sourceObservation();
    const prior = committed(observation, 2);
    const store: OfficialAssetSnapshotStore = Object.freeze({
      readSnapshot: () => prior,
      replaceSnapshot: vi.fn(),
    });
    const synchronization = createOfficialAssetSynchronization({
      source: Object.freeze({ read: async () => { throw new Error("source failed"); } }),
      store,
      signal: new AbortController().signal,
      ...failures,
    });

    await expect(synchronization.synchronize(new AbortController().signal)).resolves.toEqual({
      status: "unavailable",
      storedRevision: prior.revision,
      failure: createTokenCatalogFailure("source_unavailable"),
    });
    expect(store.replaceSnapshot).not.toHaveBeenCalled();
    await synchronization.close();
  });

  it("aborts and drains the owned source read before close resolves", async () => {
    let settled = false;
    const source: RobinhoodOfficialAssetSourceClient = Object.freeze({
      read: async (signal: AbortSignal) =>
        await new Promise<RobinhoodOfficialAssetSourceObservation>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          settled = true;
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      }),
    });
    const synchronization = createOfficialAssetSynchronization({
      source,
      store: Object.freeze({
        readSnapshot: () => undefined,
        replaceSnapshot: vi.fn(),
      }),
      signal: new AbortController().signal,
      ...failures,
    });

    const active = synchronization.synchronize(new AbortController().signal);
    await synchronization.close();
    expect(settled).toBe(true);
    await expect(active).resolves.toMatchObject({
      status: "unavailable",
      storedRevision: null,
      failure: { error: { code: "runtime_state_unavailable" } },
    });
  });
});
