import type { ApplicationFailure } from "../core/index.js";
import type {
  CommittedOfficialAssetSnapshot,
  OfficialAssetSnapshotRevision,
} from "./official-asset-contract.js";
import type {
  OfficialAssetSnapshotStore,
  RobinhoodOfficialAssetSourceClient,
} from "./official-asset-source-contract.js";

export type OfficialAssetSynchronizationResult =
  | Readonly<{
      status: "current";
      snapshot: CommittedOfficialAssetSnapshot;
    }>
  | Readonly<{
      status: "unavailable";
      storedRevision: OfficialAssetSnapshotRevision | null;
      failure: ApplicationFailure;
    }>;

export interface OfficialAssetSynchronizationPort {
  synchronize(signal: AbortSignal): Promise<OfficialAssetSynchronizationResult>;
  readStored(): CommittedOfficialAssetSnapshot | undefined;
  close(): Promise<void>;
}

export interface OfficialAssetSynchronizationDependencies {
  readonly source: RobinhoodOfficialAssetSourceClient;
  readonly store: OfficialAssetSnapshotStore;
  readonly signal: AbortSignal;
  readonly failureFor: (error: unknown) => ApplicationFailure;
  readonly abortedFailure: () => ApplicationFailure;
}

const waitForCaller = async <Value>(
  shared: Promise<Value>,
  signal: AbortSignal,
): Promise<Value> => {
  if (signal.aborted) throw new DOMException("The request was aborted.", "AbortError");
  return await new Promise<Value>((resolve, reject) => {
    const onAbort = (): void => reject(new DOMException("The request was aborted.", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    void shared.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
};

export const createOfficialAssetSynchronization = (
  dependencies: OfficialAssetSynchronizationDependencies,
): OfficialAssetSynchronizationPort => {
  const ownerAbort = new AbortController();
  const abortForOwner = (): void => ownerAbort.abort();
  if (dependencies.signal.aborted) ownerAbort.abort();
  else dependencies.signal.addEventListener("abort", abortForOwner, { once: true });
  let active: Promise<OfficialAssetSynchronizationResult> | undefined;
  let closed = false;

  const run = async (): Promise<OfficialAssetSynchronizationResult> => {
    try {
      const prior = dependencies.store.readSnapshot();
      const observation = await dependencies.source.read(ownerAbort.signal);
      return Object.freeze({
        status: "current" as const,
        snapshot: dependencies.store.replaceSnapshot(
          observation,
          prior?.revision ?? null,
        ),
      });
    } catch (error) {
      const stored = dependencies.store.readSnapshot();
      return Object.freeze({
        status: "unavailable" as const,
        storedRevision: stored?.revision ?? null,
        failure: ownerAbort.signal.aborted
          ? dependencies.abortedFailure()
          : dependencies.failureFor(error),
      });
    }
  };

  return Object.freeze({
    synchronize(signal: AbortSignal): Promise<OfficialAssetSynchronizationResult> {
      if (closed || ownerAbort.signal.aborted) {
        return Promise.resolve(Object.freeze({
          status: "unavailable" as const,
          storedRevision: dependencies.store.readSnapshot()?.revision ?? null,
          failure: dependencies.abortedFailure(),
        }));
      }
      const shared = active ?? run();
      if (active === undefined) {
        active = shared;
        void shared.then(
          () => { if (active === shared) active = undefined; },
          () => { if (active === shared) active = undefined; },
        );
      }
      return waitForCaller(shared, signal).catch(() => Object.freeze({
        status: "unavailable" as const,
        storedRevision: dependencies.store.readSnapshot()?.revision ?? null,
        failure: dependencies.abortedFailure(),
      }));
    },
    readStored: () => dependencies.store.readSnapshot(),
    close(): Promise<void> {
      if (closed) return active?.then(() => undefined) ?? Promise.resolve();
      closed = true;
      ownerAbort.abort();
      dependencies.signal.removeEventListener("abort", abortForOwner);
      return active?.then(() => undefined) ?? Promise.resolve();
    },
  });
};
