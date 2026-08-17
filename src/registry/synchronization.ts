import type {
  CommittedOfficialAssetSnapshot,
  OfficialAssetSnapshotRevision,
  OfficialAssetSourceUnavailableReason,
} from "./official-asset-contract.js";
import type {
  OfficialAssetSnapshotStore,
  RobinhoodOfficialAssetSourceClient,
} from "./official-asset-source-contract.js";

export type OfficialAssetSynchronizationUnavailableReason =
  | OfficialAssetSourceUnavailableReason
  | "runtime_state_unavailable";

export type OfficialAssetSynchronizationResult =
  | Readonly<{
      status: "current";
      snapshot: CommittedOfficialAssetSnapshot;
    }>
  | Readonly<{
      status: "unavailable";
      storedRevision: OfficialAssetSnapshotRevision | null;
      reason: OfficialAssetSynchronizationUnavailableReason;
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
}

type CallerWaitResult<Value> =
  | Readonly<{ status: "completed"; value: Value }>
  | Readonly<{ status: "caller_aborted" }>;

const waitForCaller = async <Value>(
  shared: Promise<Value>,
  signal: AbortSignal,
): Promise<CallerWaitResult<Value>> => {
  if (signal.aborted) return Object.freeze({ status: "caller_aborted" });
  return await new Promise<CallerWaitResult<Value>>((resolve, reject) => {
    const onAbort = (): void => resolve(Object.freeze({ status: "caller_aborted" }));
    signal.addEventListener("abort", onAbort, { once: true });
    void shared.then(
      (value) => resolve(Object.freeze({ status: "completed", value })),
      reject,
    ).finally(() => signal.removeEventListener("abort", onAbort));
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
  let closePromise: Promise<void> | undefined;
  let closed = false;

  const run = async (): Promise<OfficialAssetSynchronizationResult> => {
    const prior = dependencies.store.readSnapshot();
    const sourceResult = await dependencies.source.read(ownerAbort.signal);
    if (ownerAbort.signal.aborted) {
      return Object.freeze({
        status: "unavailable" as const,
        storedRevision: prior?.revision ?? null,
        reason: "runtime_state_unavailable" as const,
      });
    }
    if (sourceResult.status === "unavailable") {
      return Object.freeze({
        status: "unavailable" as const,
        storedRevision: prior?.revision ?? null,
        reason: sourceResult.reason,
      });
    }
    return Object.freeze({
      status: "current" as const,
      snapshot: dependencies.store.replaceSnapshot(
        sourceResult.observation,
        prior?.revision ?? null,
      ),
    });
  };

  const startRun = (): Promise<OfficialAssetSynchronizationResult> => {
    let resolveRun!: (result: OfficialAssetSynchronizationResult) => void;
    let rejectRun!: (reason: unknown) => void;
    const shared = new Promise<OfficialAssetSynchronizationResult>((resolve, reject) => {
      resolveRun = resolve;
      rejectRun = reject;
    });
    active = shared;
    const clearActive = (): void => {
      if (active === shared) active = undefined;
    };
    void shared.then(clearActive, clearActive);
    void run().then(resolveRun, rejectRun);
    return shared;
  };

  return Object.freeze({
    async synchronize(signal: AbortSignal): Promise<OfficialAssetSynchronizationResult> {
      if (closed || ownerAbort.signal.aborted) {
        return Object.freeze({
          status: "unavailable" as const,
          storedRevision: dependencies.store.readSnapshot()?.revision ?? null,
          reason: "runtime_state_unavailable" as const,
        });
      }
      const shared = active ?? startRun();
      const waited = await waitForCaller(shared, signal);
      if (waited.status === "completed") return waited.value;
      return Object.freeze({
        status: "unavailable" as const,
        storedRevision: dependencies.store.readSnapshot()?.revision ?? null,
        reason: "request_aborted" as const,
      });
    },
    readStored: () => dependencies.store.readSnapshot(),
    close(): Promise<void> {
      if (closePromise !== undefined) return closePromise;
      let resolveClose!: () => void;
      let rejectClose!: (reason: unknown) => void;
      closePromise = new Promise<void>((resolve, reject) => {
        resolveClose = resolve;
        rejectClose = reject;
      });
      closed = true;
      const admitted = active;
      void (async (): Promise<void> => {
        ownerAbort.abort();
        dependencies.signal.removeEventListener("abort", abortForOwner);
        if (admitted !== undefined) await Promise.allSettled([admitted]);
      })().then(resolveClose, rejectClose);
      return closePromise;
    },
  });
};
