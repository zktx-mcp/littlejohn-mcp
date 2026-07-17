import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CapabilityBindingRegistry,
  CapabilityRegistry,
  ObservationAuthorityRegistry,
  createCanonicalClock,
  createCapabilityInvocationAuthority,
  createObservationAuthority,
  parseCapabilityDataAt,
  sourceReferenceSchema,
  walletConnectionCapability,
  type CanonicalClock,
  type InvocationBoundaryPorts,
  type UtcTimestamp,
  type WalletConnectionData,
} from "../../src/core/index.js";
import {
  readRuntimeConfiguration,
} from "../../src/runtime/configuration.js";
import { RuntimeOperationError } from "../../src/runtime/errors.js";
import type {
  WalletConnectionRecord,
  WalletOwnerBootstrapPort,
  WalletProjectionStore,
  WalletSessionSource,
} from "../../src/runtime/index.js";
import {
  createWalletCoordinator,
  type WalletCoordinator,
} from "../../src/wallet/coordinator.js";
import {
  parseWalletOperationResponse,
  parseWalletWebOperationCreate,
  type WalletOperationCreate,
  type WalletOperationResponse,
} from "../../src/wallet/contracts.js";
import { parseWalletOperationConfirmation } from "../../src/wallet/operation-contract.js";
import {
  WalletConnectClientError,
  type WalletConnectAccountReference,
  type WalletConnectAttemptOutcome,
  type WalletConnectClientEvent,
  type WalletConnectClientPort,
  type WalletConnectConnectionAttemptPort,
  type WalletConnectSessionSnapshot,
} from "../../src/wallet/walletconnect-client.js";

const initialTime = "2026-07-14T00:00:00.000Z";
const addressA = "0x1111111111111111111111111111111111111111";
const addressB = "0x2222222222222222222222222222222222222222";
const topicA = "a".repeat(64);
const topicB = "b".repeat(64);
const topicC = "c".repeat(64);
const topicD = "d".repeat(64);

const qr = {
  size: 21,
  rows: Array.from({ length: 21 }, () => "0".repeat(21)),
};

const disconnected = (reason: "no_session" | "expired" | "deleted" | "disconnected" | "unusable_store") =>
  Object.freeze({ status: "disconnected" as const, reason });

const session = (
  topic = topicA,
  address = addressA,
  overrides: {
    readonly accounts?: readonly string[];
    readonly chains?: readonly string[];
    readonly methods?: readonly string[];
    readonly events?: readonly string[];
    readonly expiry?: number;
  } = {},
): WalletConnectSessionSnapshot => Object.freeze({
  topic,
  expiry: overrides.expiry ?? Date.parse("2026-07-15T00:00:00.000Z") / 1_000,
  namespaces: Object.freeze({
    eip155: Object.freeze({
      chains: Object.freeze(overrides.chains ?? ["eip155:4663"]),
      accounts: Object.freeze(overrides.accounts ?? [`eip155:4663:${address}`]),
      methods: Object.freeze(overrides.methods ?? ["eth_sendTransaction"]),
      events: Object.freeze(overrides.events ?? ["accountsChanged", "chainChanged"]),
    }),
  }),
});

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
}

const deferred = <Value>(): Deferred<Value> => {
  let resolvePromise: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>((resolve) => { resolvePromise = resolve; });
  if (resolvePromise === undefined) throw new Error("Deferred result was not initialized.");
  return Object.freeze({ promise, resolve: resolvePromise });
};

class FakeConnectionAttempt implements WalletConnectConnectionAttemptPort {
  readonly qr = qr;
  readonly result = deferred<WalletConnectAttemptOutcome>();
  cancelOutcome: WalletConnectAttemptOutcome = Object.freeze({ status: "cancelled" });
  cancelError: Error | undefined;
  cancelWait: Deferred<void> | undefined;
  cancelCount = 0;
  terminal: WalletConnectAttemptOutcome | undefined;

  wait(): Promise<WalletConnectAttemptOutcome> { return this.result.promise; }

  async cancel(): Promise<WalletConnectAttemptOutcome> {
    if (this.terminal !== undefined) return this.terminal;
    this.cancelCount += 1;
    if (this.cancelError !== undefined) throw this.cancelError;
    if (this.cancelWait !== undefined) await this.cancelWait.promise;
    this.terminal = this.cancelOutcome;
    this.result.resolve(this.cancelOutcome);
    return this.cancelOutcome;
  }

  settle(outcome: WalletConnectAttemptOutcome): void {
    this.terminal = outcome;
    this.result.resolve(outcome);
  }
}

class FakeWalletConnectClient implements WalletConnectClientPort {
  sessions: WalletConnectSessionSnapshot[];
  readonly attempts: FakeConnectionAttempt[] = [];
  readonly disconnectTopics: string[] = [];
  readonly disconnectFailures = new Set<string>();
  readonly disconnectKeepsTopics = new Set<string>();
  readonly disconnectWaits: Deferred<void>[] = [];
  readonly startWaits: Deferred<void>[] = [];
  readonly callsAfterClose: string[] = [];
  listSessionsCount = 0;
  lockSessionReadsWhileAttemptPending = false;
  beforeListSessions: ((call: number) => void) | undefined;
  listError: Error | undefined;
  startError: Error | undefined;
  closeError: Error | undefined;
  closeCount = 0;
  closed = false;
  #starting: Promise<WalletConnectConnectionAttemptPort> | undefined;
  #listener: ((event: WalletConnectClientEvent) => void) | undefined;

  constructor(sessions: readonly WalletConnectSessionSnapshot[] = []) {
    this.sessions = [...sessions];
  }

  listSessions(): readonly WalletConnectSessionSnapshot[] {
    this.#recordAccess("listSessions");
    this.listSessionsCount += 1;
    this.beforeListSessions?.(this.listSessionsCount);
    if (
      this.lockSessionReadsWhileAttemptPending &&
      this.attempts.some(({ terminal }) => terminal === undefined)
    ) {
      throw new WalletConnectClientError("sdk_unavailable");
    }
    if (this.listError !== undefined) throw this.listError;
    return Object.freeze([...this.sessions]);
  }

  async startConnection(): Promise<WalletConnectConnectionAttemptPort> {
    this.#recordAccess("startConnection");
    const starting = (async (): Promise<WalletConnectConnectionAttemptPort> => {
      const wait = this.startWaits.shift();
      if (wait !== undefined) await wait.promise;
      if (this.closed) throw new WalletConnectClientError("client_closed");
      if (this.startError !== undefined) throw this.startError;
      const attempt = new FakeConnectionAttempt();
      this.attempts.push(attempt);
      return attempt;
    })();
    this.#starting = starting;
    try { return await starting; }
    finally { if (this.#starting === starting) this.#starting = undefined; }
  }

  async disconnectSession(topic: string): Promise<readonly WalletConnectSessionSnapshot[]> {
    this.#recordAccess("disconnectSession");
    this.disconnectTopics.push(topic);
    const wait = this.disconnectWaits.shift();
    if (wait !== undefined) await wait.promise;
    if (this.disconnectFailures.has(topic)) throw new WalletConnectClientError("sdk_unavailable");
    if (!this.disconnectKeepsTopics.has(topic)) {
      this.sessions = this.sessions.filter((candidate) => candidate.topic !== topic);
    }
    return Object.freeze([...this.sessions]);
  }

  subscribe(listener: (event: WalletConnectClientEvent) => void): () => void {
    if (this.#listener !== undefined) throw new Error("Only one coordinator may subscribe.");
    this.#listener = listener;
    return () => { if (this.#listener === listener) this.#listener = undefined; };
  }

  emit(event: WalletConnectClientEvent): void { this.#listener?.(event); }

  #recordAccess(method: string): void {
    if (this.closed) this.callsAfterClose.push(method);
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    this.closed = true;
    this.#listener = undefined;
    try { await this.#starting; }
    catch { /* Closing owns the pending-start failure. */ }
    const latestAttempt = this.attempts.at(-1);
    if (latestAttempt !== undefined) {
      try { await latestAttempt.cancel(); }
      catch { /* The fake models local close after best-effort SDK cleanup. */ }
    }
    if (this.closeError !== undefined) throw this.closeError;
  }
}

class MemoryWalletProjection implements WalletProjectionStore {
  #record: WalletConnectionRecord;
  replaceError: Error | undefined;

  constructor(clock: CanonicalClock) {
    const observedAt = clock.now();
    this.#record = Object.freeze({
      revision: "0" as never,
      connection: parseCapabilityDataAt(
        walletConnectionCapability,
        { status: "unknown", reason: "reconciling" },
        observedAt,
      ),
      updatedAt: observedAt,
    });
  }

  read(): WalletConnectionRecord { return this.#record; }

  replace(
    expectedRevision: string,
    connection: WalletConnectionData,
    updatedAt: UtcTimestamp,
  ): WalletConnectionRecord {
    if (this.replaceError !== undefined) throw this.replaceError;
    if (expectedRevision !== this.#record.revision) throw new Error("stale projection revision");
    this.#record = Object.freeze({
      revision: String(BigInt(this.#record.revision) + 1n) as never,
      connection,
      updatedAt,
    });
    return this.#record;
  }

  bumpRevision(): void {
    this.#record = Object.freeze({
      ...this.#record,
      revision: String(BigInt(this.#record.revision) + 1n) as never,
    });
  }
}

const topicDigest = (topic: string): string =>
  createHash("sha256").update(topic, "utf8").digest("base64url");

const createBootstrap = (): {
  readonly wallet: WalletOwnerBootstrapPort;
  readonly projection: MemoryWalletProjection;
} => {
  const clock = createCanonicalClock(() => new Date(Date.now()).toISOString());
  const sdkStoreAuthority = createObservationAuthority({
    clock,
    sourceClass: "wallet_sdk",
    owner: "WalletConnect SDK",
    reference: sourceReferenceSchema.parse({
      kind: "wallet_sdk",
      sourceId: `wallet-sdk:${"A".repeat(22)}`,
    }),
  });
  const createSessionSource = (topic: string): WalletSessionSource => {
    const digest = topicDigest(topic);
    const sourceId = `wallet-session:${digest}`;
    return Object.freeze({
      sourceId,
      candidateId: sourceId,
      topicDigest: digest,
      observationAuthority: createObservationAuthority({
        clock,
        sourceClass: "wallet_session",
        owner: "WalletConnect session",
        reference: sourceReferenceSchema.parse({
          kind: "wallet_session",
          sourceId,
          topicDigest: digest,
        }),
      }),
    });
  };
  const projection = new MemoryWalletProjection(clock);
  const configuration = readRuntimeConfiguration({}).wallet;
  const invocationAuthority = createCapabilityInvocationAuthority(clock);
  return Object.freeze({
    projection,
    wallet: Object.freeze({
      configuration,
      privateStoreDirectory: Object.freeze({ ensureDirectory: async () => "/unused-wallet-store" }),
      projection,
      sourceAuthority: Object.freeze({
        sdkStoreSourceId: `wallet-sdk:${"A".repeat(22)}`,
        sdkStoreAuthority,
        createSessionSource,
      }),
      capabilityAuthority: Object.freeze({
        clock,
        invocationAuthority,
        createInvocationPorts(sessionSource?: WalletSessionSource): InvocationBoundaryPorts {
          const authorities = [sdkStoreAuthority];
          if (sessionSource !== undefined) authorities.push(sessionSource.observationAuthority);
          return Object.freeze({ observations: new ObservationAuthorityRegistry(clock, authorities) });
        },
      }),
    }),
  });
};

const createSubject = async (
  sessions: readonly WalletConnectSessionSnapshot[] = [],
  initialConnection?: unknown,
) => {
  const client = new FakeWalletConnectClient(sessions);
  const bootstrap = createBootstrap();
  if (initialConnection !== undefined) {
    const evaluatedAt = bootstrap.wallet.capabilityAuthority.clock.now();
    const current = bootstrap.projection.read();
    bootstrap.projection.replace(
      current.revision,
      parseCapabilityDataAt(walletConnectionCapability, initialConnection, evaluatedAt),
      evaluatedAt,
    );
  }
  const coordinator = await createWalletCoordinator({ client, wallet: bootstrap.wallet });
  return Object.freeze({ client, coordinator, projection: bootstrap.projection });
};

const drainCoordinator = async (): Promise<void> => {
  for (let index = 0; index < 24; index += 1) await Promise.resolve();
};

const operationState = async (coordinator: WalletCoordinator, operationId: string): Promise<string> =>
  (await coordinator.get(operationId)).operation.state;

const observeOperation = async (
  coordinator: WalletCoordinator,
  operationId: string,
  predicate: (operation: WalletOperationResponse["operation"]) => boolean,
): Promise<WalletOperationResponse["operation"]> => {
  let last: WalletOperationResponse["operation"] | undefined;
  for (let index = 0; index < 64; index += 1) {
    await drainCoordinator();
    last = (await coordinator.get(operationId)).operation;
    if (predicate(last)) return last;
  }
  throw new Error(`Wallet operation did not reach the expected state; last state was ${last?.state ?? "absent"}.`);
};

const observeOperationState = (
  coordinator: WalletCoordinator,
  operationId: string,
  state: WalletOperationResponse["operation"]["state"],
): Promise<WalletOperationResponse["operation"]> =>
  observeOperation(coordinator, operationId, (operation) => operation.state === state);

const startOperation = async (
  coordinator: WalletCoordinator,
  input: Omit<WalletOperationCreate, "connectionRevision"> & {
    readonly connectionRevision?: WalletOperationCreate["connectionRevision"];
  },
): Promise<WalletOperationResponse> => {
  const response = await coordinator.start({
    ...input,
    connectionRevision: input.connectionRevision ?? null,
  });
  if (response.result.status !== "operation_started") {
    throw new Error("Expected a wallet operation to start.");
  }
  return parseWalletOperationResponse({
    operation: response.result.operation,
    ...(response.qr === undefined ? {} : { qr: response.qr }),
  });
};

const expectWalletCode = async (action: Promise<unknown>, code: string): Promise<void> => {
  await expect(action).rejects.toMatchObject({ failure: { error: { code } } });
};

const invokeWalletConnection = (coordinator: WalletCoordinator) =>
  new CapabilityBindingRegistry(
    new CapabilityRegistry([walletConnectionCapability]),
    [coordinator.walletConnection.connection],
  ).invoke(walletConnectionCapability, {}, { signal: new AbortController().signal });

describe("WalletCoordinator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(initialTime));
  });

  afterEach(() => { vi.useRealTimers(); });

  it("restores the only valid SDK session from an unavailable persisted projection", async () => {
    const { client, coordinator, projection } = await createSubject(
      [session()],
      disconnected("unusable_store"),
    );

    expect(projection.read().connection).toMatchObject({
      status: "connected",
      account: `eip155:4663:${addressA}`,
      address: addressA,
    });
    expect(coordinator.activeWallet.capture()).toMatchObject({
      connection: { status: "connected", address: addressA },
      sessionSource: { topicDigest: topicDigest(topicA) },
    });
    expect(client.attempts).toHaveLength(0);

    await coordinator.close();
    expect(client.closed).toBe(true);
    expect(client.disconnectTopics).toEqual([]);
    expect(client.sessions).toHaveLength(1);
  });

  it("expires a connected session once when the browser current projection reads first", async () => {
    const expiring = session(topicA, addressA, {
      expiry: Date.parse("2026-07-14T00:01:00.000Z") / 1_000,
    });
    const { client, coordinator, projection } = await createSubject([expiring]);
    const initialRevision = projection.read().revision;
    vi.setSystemTime(new Date("2026-07-14T00:01:00.000Z"));

    const current = await coordinator.currentOperationProjection.get();
    expect(current).toMatchObject({
      status: "absent",
      connection: disconnected("expired"),
    });
    expect(current.connectionRevision).toBe(String(BigInt(initialRevision) + 1n));
    expect(projection.read()).toMatchObject({
      revision: current.connectionRevision,
      connection: disconnected("expired"),
    });
    expect(coordinator.activeWallet.capture()).toEqual({
      connection: disconnected("expired"),
    });
    expect(client.disconnectTopics).toEqual([topicA]);
    expect(client.sessions).toEqual([]);
    await coordinator.close();
  });

  it("shares the same persisted expiry transition when the active-wallet read starts it", async () => {
    const expiring = session(topicA, addressA, {
      expiry: Date.parse("2026-07-14T00:01:00.000Z") / 1_000,
    });
    const { client, coordinator, projection } = await createSubject([expiring]);
    const initialRevision = projection.read().revision;
    const cleanupGate = deferred<void>();
    client.disconnectWaits.push(cleanupGate);
    vi.setSystemTime(new Date("2026-07-14T00:01:00.000Z"));

    expect(coordinator.activeWallet.capture()).toEqual({
      connection: disconnected("expired"),
    });
    const duringCleanup = await coordinator.currentOperationProjection.get();
    expect(duringCleanup).toEqual({
      status: "absent",
      connectionRevision: String(BigInt(initialRevision) + 1n),
      connection: disconnected("expired"),
    });
    expect(projection.read()).toEqual({
      revision: duringCleanup.connectionRevision,
      connection: disconnected("expired"),
      updatedAt: "2026-07-14T00:01:00.000Z",
    });
    expect(coordinator.activeWallet.capture()).toEqual({
      connection: disconnected("expired"),
    });
    expect(client.disconnectTopics).toEqual([topicA]);
    expect(client.sessions.map(({ topic }) => topic)).toEqual([topicA]);

    cleanupGate.resolve();
    await drainCoordinator();
    expect(await coordinator.currentOperationProjection.get()).toEqual(duringCleanup);
    expect(projection.read().revision).toBe(duringCleanup.connectionRevision);
    expect(client.sessions).toEqual([]);
    await coordinator.close();
  });

  it("moves both readers to one unavailable revision when expiry cleanup cannot be proven", async () => {
    const expiring = session(topicA, addressA, {
      expiry: Date.parse("2026-07-14T00:01:00.000Z") / 1_000,
    });
    const { client, coordinator, projection } = await createSubject([expiring]);
    const initialRevision = projection.read().revision;
    const cleanupGate = deferred<void>();
    client.disconnectWaits.push(cleanupGate);
    client.disconnectFailures.add(topicA);
    vi.setSystemTime(new Date("2026-07-14T00:01:00.000Z"));

    expect(coordinator.activeWallet.capture()).toEqual({
      connection: disconnected("expired"),
    });
    expect(await coordinator.currentOperationProjection.get()).toEqual({
      status: "absent",
      connectionRevision: String(BigInt(initialRevision) + 1n),
      connection: disconnected("expired"),
    });

    cleanupGate.resolve();
    await drainCoordinator();
    const unavailable = await coordinator.currentOperationProjection.get();
    expect(unavailable).toEqual({
      status: "absent",
      connectionRevision: String(BigInt(initialRevision) + 2n),
      connection: disconnected("unusable_store"),
    });
    expect(projection.read()).toMatchObject({
      revision: unavailable.connectionRevision,
      connection: disconnected("unusable_store"),
    });
    expect(coordinator.activeWallet.capture()).toEqual({
      connection: disconnected("unusable_store"),
    });
    expect(client.sessions.map(({ topic }) => topic)).toEqual([topicA]);
    client.disconnectFailures.delete(topicA);
    await coordinator.close();
  });

  it("serializes connected evidence with secret-safe local source identity only", async () => {
    const { coordinator } = await createSubject([session(topicA, addressA)]);
    const result = await invokeWalletConnection(coordinator);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const sdkSource = result.evidence.sources.find((source) => source.sourceClass === "wallet_sdk");
    const sessionSource = result.evidence.sources.find((source) => source.sourceClass === "wallet_session");
    const digest = topicDigest(topicA);
    expect(sdkSource?.reference).toEqual({
      kind: "wallet_sdk",
      sourceId: `wallet-sdk:${"A".repeat(22)}`,
    });
    expect(sessionSource?.reference).toEqual({
      kind: "wallet_session",
      sourceId: `wallet-session:${digest}`,
      topicDigest: digest,
    });
    expect(result.evidence.sources).toHaveLength(2);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(topicA);
    expect(serialized).not.toContain("/unused-wallet-store");
    expect(serialized).not.toMatch(/"topic"\s*:/);
    expect(serialized).not.toMatch(/"candidateId"\s*:/);
    await coordinator.close();
  });

  it("does not adopt a different sole session topic during runtime continuity", async () => {
    const { client, coordinator, projection } = await createSubject([session(topicA, addressA)]);
    const firstRevision = projection.read().revision;

    client.sessions = [session(topicB, addressA)];
    client.emit({ kind: "session_changed", topic: topicA });
    await drainCoordinator();

    expect(projection.read()).toMatchObject({
      revision: String(BigInt(firstRevision) + 1n),
      connection: disconnected("unusable_store"),
    });
    expect(coordinator.activeWallet.capture()).toEqual({
      connection: disconnected("unusable_store"),
    });
    expect(client.disconnectTopics).toEqual([]);
    expect(client.sessions.map(({ topic }) => topic)).toEqual([topicB]);
    await coordinator.close();
  });

  it("rejects stale confirmation when an equal-count SDK session set is replaced", async () => {
    const { client, coordinator, projection } = await createSubject([
      session(topicA, addressA),
      session(topicB, addressB),
    ]);
    const pending = await startOperation(coordinator, { kind: "disconnect", interactionInterface: "web" });
    const originalRevision = pending.operation.connectionRevision;

    client.sessions = [session(topicC, addressA), session(topicD, addressB)];
    client.emit({ kind: "session_changed", topic: topicA });
    await drainCoordinator();

    expect(projection.read().revision).not.toBe(originalRevision);
    await expectWalletCode(coordinator.webConfirmation.confirm(pending.operation.operationId, {
      connectionRevision: originalRevision,
    }), "state_conflict");
    expect(client.disconnectTopics).toEqual([]);
    await coordinator.cancel(pending.operation.operationId);
    await coordinator.close();
  });

  it.each([
    ["account", session(topicA, addressB)],
    ["namespace", session(topicA, addressA, {
      methods: ["eth_sendTransaction", "personal_sign"],
    })],
    ["expiry", session(topicA, addressA, {
      expiry: Date.parse("2026-07-15T00:01:00.000Z") / 1_000,
    })],
  ])("rejects confirmation when the same-topic %s changes between observation and commit", async (
    _change,
    replacement,
  ) => {
    const { client, coordinator, projection } = await createSubject([session(topicA, addressA)]);
    const pending = await startOperation(coordinator, { kind: "disconnect", interactionInterface: "web" });
    expect(pending.operation.state).toBe("awaiting_confirmation");
    const originalRevision = projection.read().revision;

    let confirmationReads = 0;
    client.beforeListSessions = () => {
      confirmationReads += 1;
      if (confirmationReads !== 2) return;
      client.beforeListSessions = undefined;
      client.sessions = [replacement];
    };

    await expectWalletCode(coordinator.webConfirmation.confirm(pending.operation.operationId, {
      connectionRevision: pending.operation.connectionRevision,
    }), "state_conflict");
    await drainCoordinator();

    expect(client.attempts).toHaveLength(0);
    expect(projection.read().revision).not.toBe(originalRevision);
    expect(await operationState(coordinator, pending.operation.operationId)).toBe("awaiting_confirmation");
    await coordinator.cancel(pending.operation.operationId);
    await coordinator.close();
  });

  it("admits only one of two concurrent confirmations for the same operation revision", async () => {
    const { client, coordinator } = await createSubject([session(topicA, addressA)]);
    const pending = await startOperation(coordinator, { kind: "disconnect", interactionInterface: "web" });
    const confirmation = {
      connectionRevision: pending.operation.connectionRevision,
    };

    const outcomes = await Promise.allSettled([
      coordinator.webConfirmation.confirm(pending.operation.operationId, confirmation),
      coordinator.webConfirmation.confirm(pending.operation.operationId, confirmation),
    ]);
    const fulfilled = outcomes.find((outcome) => outcome.status === "fulfilled");
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");

    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);
    if (fulfilled?.status !== "fulfilled" || rejected?.status !== "rejected") {
      throw new Error("Concurrent confirmation must produce one success and one rejection.");
    }
    expect(fulfilled.value).toMatchObject({ state: "disconnecting" });
    expect(rejected.reason).toMatchObject({
      failure: { error: { code: "state_conflict" } },
    });
    expect(await observeOperationState(
      coordinator,
      pending.operation.operationId,
      "completed",
    )).toMatchObject({ result: { outcome: "disconnected" } });
    expect(client.disconnectTopics).toEqual([topicA]);
    await coordinator.close();
  });

  it("connects from zero sessions only after the approved session is independently observed", async () => {
    const { client, coordinator, projection } = await createSubject();
    const pending = await startOperation(coordinator, { kind: "connect", interactionInterface: "cli" });

    expect(pending.operation.state).toBe("starting_connection");
    expect(pending).not.toHaveProperty("qr");
    expect("qr" in pending.operation).toBe(false);
    const awaiting = await observeOperationState(
      coordinator,
      pending.operation.operationId,
      "awaiting_wallet_approval",
    );
    expect(await coordinator.operationPresentation.get(pending.operation.operationId)).toEqual({
      operation: awaiting,
      qr,
      access: "read_only",
    });
    const attempt = client.attempts[0] as FakeConnectionAttempt;
    const approved = session();
    client.sessions = [approved];
    attempt.settle(Object.freeze({ status: "approved", session: approved }));
    await drainCoordinator();

    const completed = await coordinator.get(pending.operation.operationId);
    expect(completed).not.toHaveProperty("qr");
    expect(completed.operation).toMatchObject({
      state: "completed",
      result: {
        outcome: "connected",
        connection: { status: "connected", address: addressA },
      },
    });
    expect(projection.read().connection).toMatchObject({ status: "connected", address: addressA });
    await coordinator.close();
  });

  it("returns the current valid connection without creating or mutating an operation", async () => {
    const { client, coordinator, projection } = await createSubject([session()]);
    const revision = projection.read().revision;
    const listCount = client.listSessionsCount;

    const result = await coordinator.start({
      kind: "connect",
      interactionInterface: "web",
      connectionRevision: revision,
    });

    expect(result).toEqual({
      result: {
        status: "current_connection",
        connectionRevision: revision,
        connection: expect.objectContaining({ status: "connected", address: addressA }),
      },
    });
    expect(client.attempts).toEqual([]);
    expect(client.disconnectTopics).toEqual([]);
    expect(projection.read().revision).toBe(revision);
    expect(client.listSessionsCount).toBeGreaterThan(listCount);
    expect(await coordinator.currentOperationProjection.get()).toEqual({
      status: "absent",
      connectionRevision: revision,
      connection: expect.objectContaining({ status: "connected", address: addressA }),
    });
    await coordinator.close();
  });

  it("fails an unresolved connection request closed without selecting, deleting, or creating an operation", async () => {
    const { client, coordinator, projection } = await createSubject([
      session(topicA, addressA),
      session(topicB, addressB),
    ]);
    const revision = projection.read().revision;

    await expectWalletCode(coordinator.start({
      kind: "connect",
      interactionInterface: "web",
      connectionRevision: revision,
    }), "state_conflict");

    expect(client.attempts).toEqual([]);
    expect(client.disconnectTopics).toEqual([]);
    expect(client.sessions.map(({ topic }) => topic)).toEqual([topicA, topicB]);
    expect(await coordinator.currentOperationProjection.get()).toEqual({
      status: "absent",
      connectionRevision: revision,
      connection: { status: "unresolved", eligibleSessionCount: "2" },
    });
    await coordinator.close();
  });

  it("keeps browser cancellation bound to its operation identity across connection revision drift", async () => {
    const { client, coordinator } = await createSubject();
    const initial = await coordinator.currentOperationProjection.get();
    expect(initial.status).toBe("absent");

    await expectWalletCode(coordinator.operation.start(parseWalletWebOperationCreate({
      kind: "connect",
      connectionRevision: "999",
    })), "state_conflict");
    expect(client.attempts).toEqual([]);

    const started = await coordinator.operation.start({
      kind: "connect",
      connectionRevision: initial.connectionRevision,
    });
    expect(started).toMatchObject({
      status: "operation_started",
      operation: { kind: "connect", state: "starting_connection" },
    });
    if (started.status !== "operation_started") {
      throw new Error("Expected a browser-owned wallet operation.");
    }
    const awaiting = await observeOperationState(
      coordinator,
      started.operation.operationId,
      "awaiting_wallet_approval",
    );
    expect(await coordinator.currentOperationProjection.get()).toEqual({
      status: "present",
      connectionRevision: initial.connectionRevision,
      connection: disconnected("unusable_store"),
      presentation: {
        operation: awaiting,
        qr,
        access: "interactive",
      },
    });

    client.sessions = [session()];
    client.emit({ kind: "session_changed", topic: topicA });
    await drainCoordinator();
    const changed = await coordinator.currentOperationProjection.get();
    expect(changed.connectionRevision).not.toBe(started.operation.connectionRevision);
    await expectWalletCode(coordinator.operation.cancel(
      started.operation.operationId,
      parseWalletOperationConfirmation({ connectionRevision: "999" }),
    ), "state_conflict");
    expect((client.attempts[0] as FakeConnectionAttempt).cancelCount).toBe(0);
    await coordinator.operation.cancel(
      started.operation.operationId,
      { connectionRevision: started.operation.connectionRevision },
    );
    await observeOperationState(coordinator, started.operation.operationId, "cancelled");
    expect((client.attempts[0] as FakeConnectionAttempt).cancelCount).toBe(1);
    await coordinator.close();
  });

  it("executes a browser disconnect as one direct action while generic web start still awaits confirmation", async () => {
    const direct = await createSubject([session()]);
    const disconnectGate = deferred<void>();
    direct.client.disconnectWaits.push(disconnectGate);
    await expectWalletCode(direct.coordinator.operation.start(parseWalletWebOperationCreate({
      kind: "disconnect",
      connectionRevision: "999",
    })), "state_conflict");
    expect(direct.client.disconnectTopics).toEqual([]);
    let directSettled = false;
    const directAction = direct.coordinator.operation.start({
      kind: "disconnect",
      connectionRevision: direct.projection.read().revision,
    }).then((result) => {
      directSettled = true;
      return result;
    });
    await drainCoordinator();

    expect(directSettled).toBe(true);
    await expect(directAction).resolves.toMatchObject({
      status: "operation_started",
      operation: { state: "disconnecting" },
    });
    const active = await direct.coordinator.currentOperationProjection.get();
    if (active.status !== "present") throw new Error("Expected a direct browser operation.");
    expect(active.presentation.operation.state).toBe("disconnecting");
    expect(direct.client.disconnectTopics).toEqual([topicA]);

    disconnectGate.resolve();
    expect(await observeOperationState(
      direct.coordinator,
      active.presentation.operation.operationId,
      "completed",
    )).toMatchObject({ result: { outcome: "disconnected" } });
    await direct.coordinator.close();

    const delegated = await createSubject([session()]);
    const pending = await delegated.coordinator.start({
      kind: "disconnect",
      interactionInterface: "web",
      connectionRevision: delegated.projection.read().revision,
    });
    expect(pending.result).toMatchObject({
      status: "operation_started",
      operation: { state: "awaiting_confirmation" },
    });
    expect(delegated.client.disconnectTopics).toEqual([]);
    if (pending.result.status !== "operation_started") {
      throw new Error("Expected a confirmation-dependent operation.");
    }
    await delegated.coordinator.cancel(pending.result.operation.operationId);
    await delegated.coordinator.close();
  });

  it("preserves a cancelled disconnection and changes wallets only after disconnect then connect", async () => {
    const { client, coordinator, projection } = await createSubject([session()]);
    const beforeDisconnect = await invokeWalletConnection(coordinator);
    expect(beforeDisconnect.ok).toBe(true);
    if (!beforeDisconnect.ok) throw new Error("Expected the initial wallet connection.");
    expect(beforeDisconnect.data).toMatchObject({ status: "connected", address: addressA });
    expect(beforeDisconnect.evidence.sources
      .find(({ sourceClass }) => sourceClass === "wallet_session")?.reference)
      .toMatchObject({ topicDigest: topicDigest(topicA) });
    const cancelled = await startOperation(coordinator, { kind: "disconnect", interactionInterface: "web" });

    expect(cancelled.operation.state).toBe("awaiting_confirmation");
    expect(cancelled).not.toHaveProperty("qr");
    const firstCancellation = await coordinator.operation.cancel(
      cancelled.operation.operationId,
      { connectionRevision: cancelled.operation.connectionRevision },
    );
    expect(firstCancellation.state).toBe("cancelled");
    expect(await coordinator.operation.cancel(
      cancelled.operation.operationId,
      { connectionRevision: cancelled.operation.connectionRevision },
    )).toEqual(firstCancellation);
    expect(client.disconnectTopics).toEqual([]);
    expect(client.sessions.map(({ topic }) => topic)).toEqual([topicA]);

    const disconnection = await startOperation(coordinator, {
      kind: "disconnect",
      interactionInterface: "web",
    });
    const disconnectedResult = await coordinator.webConfirmation.confirm(
      disconnection.operation.operationId,
      {
        connectionRevision: disconnection.operation.connectionRevision,
      },
    );
    expect(disconnectedResult).toMatchObject({
      state: "disconnecting",
    });
    expect(await observeOperationState(
      coordinator,
      disconnection.operation.operationId,
      "completed",
    )).toMatchObject({
      result: { outcome: "disconnected", connection: { status: "disconnected" } },
    });
    expect(client.disconnectTopics).toEqual([topicA]);
    expect(client.sessions).toEqual([]);
    expect(client.attempts).toEqual([]);
    expect(projection.read().connection).toEqual(disconnected("disconnected"));
    expect(await coordinator.operation.cancel(
      cancelled.operation.operationId,
      { connectionRevision: cancelled.operation.connectionRevision },
    )).toEqual(firstCancellation);
    expect(client.disconnectTopics).toEqual([topicA]);

    const connection = await startOperation(coordinator, {
      kind: "connect",
      interactionInterface: "cli",
      connectionRevision: projection.read().revision,
    });
    expect(connection.operation.state).toBe("starting_connection");
    expect(projection.read().connection).toEqual(disconnected("disconnected"));
    const awaitingConnection = await observeOperationState(
      coordinator,
      connection.operation.operationId,
      "awaiting_wallet_approval",
    );
    expect(await coordinator.operationPresentation.get(connection.operation.operationId)).toEqual({
      operation: awaitingConnection,
      qr,
      access: "read_only",
    });
    const attempt = client.attempts[0] as FakeConnectionAttempt;
    const next = session(topicB, addressB);
    client.sessions = [next];
    attempt.settle(Object.freeze({ status: "approved", session: next }));
    await drainCoordinator();

    expect((await coordinator.get(connection.operation.operationId)).operation).toMatchObject({
      state: "completed",
      result: { outcome: "connected", connection: { address: addressB } },
    });
    expect(projection.read().connection).toMatchObject({ status: "connected", address: addressB });
    const afterConnect = await invokeWalletConnection(coordinator);
    expect(afterConnect.ok).toBe(true);
    if (!afterConnect.ok) throw new Error("Expected the new wallet connection.");
    expect(afterConnect.data).toMatchObject({ status: "connected", address: addressB });
    expect(afterConnect.evidence.sources
      .find(({ sourceClass }) => sourceClass === "wallet_session")?.reference)
      .toMatchObject({ topicDigest: topicDigest(topicB) });
    expect(beforeDisconnect.data).toMatchObject({ status: "connected", address: addressA });
    expect(beforeDisconnect.evidence.sources
      .find(({ sourceClass }) => sourceClass === "wallet_session")?.reference)
      .toMatchObject({ topicDigest: topicDigest(topicA) });
    await coordinator.close();
  });

  it("fails disconnection without starting pairing when any existing session cannot be deleted", async () => {
    const { client, coordinator, projection } = await createSubject([
      session(topicA, addressA),
      session(topicB, addressB),
    ]);
    client.disconnectFailures.add(topicB);
    const disconnection = await startOperation(coordinator, { kind: "disconnect", interactionInterface: "web" });

    const result = await coordinator.webConfirmation.confirm(disconnection.operation.operationId, {
      connectionRevision: disconnection.operation.connectionRevision,
    });
    expect(result).toMatchObject({ state: "disconnecting" });
    expect(await observeOperationState(
      coordinator,
      disconnection.operation.operationId,
      "failed",
    )).toMatchObject({
      state: "failed",
      failure: { error: { code: "runtime_state_unavailable" } },
    });
    expect(client.attempts).toEqual([]);
    expect(client.disconnectTopics).toEqual([topicA, topicB]);
    expect(client.sessions.map(({ topic }) => topic)).toEqual([topicB]);
    expect(projection.read().connection).toEqual(disconnected("unusable_store"));
    await coordinator.close();
  });

  it("does not restore a disconnected session when the following connection is rejected", async () => {
    const { client, coordinator, projection } = await createSubject([session()]);
    const disconnection = await startOperation(coordinator, { kind: "disconnect", interactionInterface: "web" });
    expect(await coordinator.webConfirmation.confirm(disconnection.operation.operationId, {
      connectionRevision: disconnection.operation.connectionRevision,
    })).toMatchObject({ state: "disconnecting" });
    await observeOperationState(coordinator, disconnection.operation.operationId, "completed");
    expect(client.sessions).toEqual([]);

    const connection = await startOperation(coordinator, { kind: "connect", interactionInterface: "web" });
    expect(connection.operation.state).toBe("starting_connection");
    await observeOperationState(coordinator, connection.operation.operationId, "awaiting_wallet_approval");
    (client.attempts[0] as FakeConnectionAttempt).settle(Object.freeze({ status: "rejected" }));
    await drainCoordinator();
    expect(await operationState(coordinator, connection.operation.operationId)).toBe("rejected");
    expect(client.sessions).toEqual([]);
    expect(projection.read().connection).toEqual(disconnected("no_session"));
    await coordinator.close();
  });

  it("cancels connection while the public wallet-approval state is acquiring its exact attempt", async () => {
    const { client, coordinator } = await createSubject();
    const startGate = deferred<void>();
    client.startWaits.push(startGate);

    const starting = await coordinator.start({
      kind: "connect",
      interactionInterface: "web",
      connectionRevision: null,
    });
    expect(starting).toMatchObject({
      result: { status: "operation_started", operation: { state: "starting_connection" } },
    });
    const current = await coordinator.currentOperationProjection.get();
    if (current.status !== "present") throw new Error("Expected an active connection operation.");
    expect(current.presentation.operation).toMatchObject({
      kind: "connect",
      state: "starting_connection",
    });
    expect(current.presentation).not.toHaveProperty("qr");
    expect(client.sessions).toEqual([]);
    expect(client.attempts).toEqual([]);

    const cancellation = await coordinator.cancel(current.presentation.operation.operationId);
    expect(cancellation.operation.state).toBe("cancelling");
    const cancelling = await coordinator.currentOperationProjection.get();
    if (cancelling.status !== "present") throw new Error("Expected a cancelling operation.");
    expect(cancelling.presentation.operation.state).toBe("cancelling");

    startGate.resolve();
    const cancelled = await observeOperationState(
      coordinator,
      current.presentation.operation.operationId,
      "cancelled",
    );
    expect(cancelled.state).toBe("cancelled");
    expect(client.attempts).toHaveLength(1);
    expect((client.attempts[0] as FakeConnectionAttempt).cancelCount).toBe(1);
    expect(client.sessions).toEqual([]);
    await coordinator.close();
  });

  it("bounds disconnection by the operation deadline, reconciles, and releases the operation slot", async () => {
    const { client, coordinator } = await createSubject([session()]);
    const operation = await startOperation(coordinator, { kind: "disconnect", interactionInterface: "web" });
    const lateDisconnect = deferred<void>();
    client.disconnectWaits.push(lateDisconnect);
    const confirmation = await coordinator.webConfirmation.confirm(operation.operation.operationId, {
      connectionRevision: operation.operation.connectionRevision,
    });
    expect(confirmation.state).toBe("disconnecting");
    expect(await operationState(coordinator, operation.operation.operationId)).toBe("disconnecting");

    await vi.advanceTimersByTimeAsync(5 * 60 * 1_000);
    const failed = await observeOperationState(
      coordinator,
      operation.operation.operationId,
      "failed",
    );
    expect(failed).toMatchObject({
      state: "failed",
      failure: { error: { code: "wallet_timeout" } },
    });
    expect(client.sessions.map(({ topic }) => topic)).toEqual([topicA]);
    await expectWalletCode(
      startOperation(coordinator, { kind: "disconnect", interactionInterface: "cli" }),
      "runtime_state_unavailable",
    );

    lateDisconnect.resolve();
    await drainCoordinator();
    const next = await startOperation(coordinator, { kind: "disconnect", interactionInterface: "cli" });
    expect(next.operation).toMatchObject({
      state: "completed",
      result: { outcome: "already_disconnected" },
    });
    await coordinator.close();
  });

  it("bounds invalid-session revocation, reconciles the SDK store, and releases the operation slot", async () => {
    const { client, coordinator } = await createSubject();
    const operation = await startOperation(coordinator, { kind: "connect", interactionInterface: "cli" });
    const approved = session(topicA, addressA, { accounts: [] });
    client.sessions = [approved];
    const lateRevocation = deferred<void>();
    client.disconnectWaits.push(lateRevocation);
    (client.attempts[0] as FakeConnectionAttempt).settle(
      Object.freeze({ status: "approved", session: approved }),
    );
    await drainCoordinator();
    expect(await operationState(coordinator, operation.operation.operationId)).toBe("validating_session");

    await vi.advanceTimersByTimeAsync(5 * 60 * 1_000);
    await drainCoordinator();
    expect((await coordinator.get(operation.operation.operationId)).operation).toMatchObject({
      state: "failed",
      failure: { error: { code: "runtime_state_unavailable" } },
    });
    await expectWalletCode(
      startOperation(coordinator, { kind: "disconnect", interactionInterface: "cli" }),
      "runtime_state_unavailable",
    );

    lateRevocation.resolve();
    await drainCoordinator();
    const next = await startOperation(coordinator, { kind: "disconnect", interactionInterface: "cli" });
    expect(next.operation).toMatchObject({
      state: "completed",
      result: { outcome: "already_disconnected" },
    });
    await coordinator.close();
  });

  it("implements zero, one, and conflicting-session disconnect rules without selecting a session", async () => {
    const empty = await createSubject();
    const noSession = await startOperation(empty.coordinator, { kind: "disconnect", interactionInterface: "web" });
    expect(noSession.operation).toMatchObject({
      state: "completed",
      result: { outcome: "already_disconnected", connection: disconnected("no_session") },
    });
    expect(empty.client.disconnectTopics).toEqual([]);
    await empty.coordinator.close();

    const one = await createSubject([session()]);
    const direct = await startOperation(one.coordinator, { kind: "disconnect", interactionInterface: "cli" });
    expect(direct.operation).toMatchObject({ state: "disconnecting" });
    expect(await observeOperationState(
      one.coordinator,
      direct.operation.operationId,
      "completed",
    )).toMatchObject({ result: { outcome: "disconnected" } });
    expect(one.client.disconnectTopics).toEqual([topicA]);
    await one.coordinator.close();

    const many = await createSubject([session(topicB, addressB), session()]);
    expect(many.projection.read().connection).toEqual({ status: "unresolved", eligibleSessionCount: "2" });
    const guarded = await startOperation(many.coordinator, { kind: "disconnect", interactionInterface: "cli" });
    expect(guarded.operation.state).toBe("awaiting_confirmation");
    expect(many.client.disconnectTopics).toEqual([]);
    const completed = await many.coordinator.cliConfirmation.confirm(guarded.operation.operationId, {
      connectionRevision: guarded.operation.connectionRevision,
    });
    expect(completed.operation).toMatchObject({ state: "disconnecting" });
    expect(await observeOperationState(
      many.coordinator,
      guarded.operation.operationId,
      "completed",
    )).toMatchObject({ result: { outcome: "disconnected" } });
    expect(new Set(many.client.disconnectTopics)).toEqual(new Set([topicA, topicB]));
    expect(many.client.sessions).toEqual([]);
    await many.coordinator.close();
  });

  it("fails a disconnect whose SDK call succeeds without satisfying the store postcondition", async () => {
    const { client, coordinator, projection } = await createSubject([session()]);
    client.disconnectKeepsTopics.add(topicA);

    const operation = await startOperation(coordinator, { kind: "disconnect", interactionInterface: "cli" });

    expect(operation.operation).toMatchObject({ state: "disconnecting" });
    expect(await observeOperationState(
      coordinator,
      operation.operation.operationId,
      "failed",
    )).toMatchObject({
      state: "failed",
      failure: { error: { code: "runtime_state_unavailable" } },
    });
    expect(client.disconnectTopics).toEqual([topicA]);
    expect(client.sessions.map(({ topic }) => topic)).toEqual([topicA]);
    expect(projection.read().connection).toEqual(disconnected("unusable_store"));
    await coordinator.close();
  });

  it("never deletes a session that appears after explicit disconnect authority is captured", async () => {
    const { client, coordinator, projection } = await createSubject([session(topicA, addressA)]);
    const pending = await startOperation(coordinator, { kind: "disconnect", interactionInterface: "web" });
    const disconnectGate = deferred<void>();
    client.disconnectWaits.push(disconnectGate);

    const confirmation = await coordinator.webConfirmation.confirm(pending.operation.operationId, {
      connectionRevision: pending.operation.connectionRevision,
    });
    expect(confirmation.state).toBe("disconnecting");
    client.sessions = [session(topicA, addressA), session(topicB, addressB)];
    disconnectGate.resolve();

    expect(await observeOperationState(
      coordinator,
      pending.operation.operationId,
      "failed",
    )).toMatchObject({
      state: "failed",
      failure: { error: { code: "runtime_state_unavailable" } },
    });
    expect(client.disconnectTopics).toEqual([topicA]);
    expect(client.sessions.map(({ topic }) => topic)).toEqual([topicB]);
    expect(projection.read().connection).toEqual(disconnected("unusable_store"));
    await coordinator.close();
  });

  it("serializes one nonterminal operation and keeps cancellation scoped to its exact proposal", async () => {
    const { client, coordinator } = await createSubject();
    const pending = await startOperation(coordinator, { kind: "connect", interactionInterface: "cli" });

    await expectWalletCode(
      startOperation(coordinator, { kind: "disconnect", interactionInterface: "cli" }),
      "state_conflict",
    );
    const attempt = client.attempts[0] as FakeConnectionAttempt;
    const cancelled = await coordinator.cancel(pending.operation.operationId);
    expect(cancelled.operation.state).toBe("cancelling");
    await observeOperationState(coordinator, pending.operation.operationId, "cancelled");
    expect(attempt.cancelCount).toBe(1);
    expect(client.disconnectTopics).toEqual([]);
    await coordinator.close();
  });

  it("rejects a second create without reading an SDK store locked by the active attempt", async () => {
    const { client, coordinator } = await createSubject();
    client.lockSessionReadsWhileAttemptPending = true;
    const pending = await startOperation(coordinator, { kind: "connect", interactionInterface: "cli" });
    const readsBeforeSecondCreate = client.listSessionsCount;

    await expectWalletCode(
      startOperation(coordinator, { kind: "disconnect", interactionInterface: "cli" }),
      "state_conflict",
    );

    expect(pending.operation.state).toBe("starting_connection");
    await observeOperationState(coordinator, pending.operation.operationId, "awaiting_wallet_approval");
    expect(client.listSessionsCount).toBe(readsBeforeSecondCreate);
    await coordinator.cancel(pending.operation.operationId);
    await coordinator.close();
  });

  it("admits only one of two concurrent create requests", async () => {
    const { client, coordinator } = await createSubject();

    const outcomes = await Promise.allSettled([
      startOperation(coordinator, { kind: "connect", interactionInterface: "cli" }),
      startOperation(coordinator, { kind: "connect", interactionInterface: "cli" }),
    ]);
    const fulfilled = outcomes.find(
      (outcome): outcome is PromiseFulfilledResult<WalletOperationResponse> =>
        outcome.status === "fulfilled",
    );
    const rejected = outcomes.find(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
    );

    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(fulfilled?.value.operation.state).toBe("starting_connection");
    expect(rejected?.reason).toMatchObject({
      failure: { error: { code: "state_conflict" } },
    });
    expect(client.attempts).toHaveLength(1);
    if (fulfilled === undefined) throw new Error("One create request must be admitted.");
    await coordinator.cancel(fulfilled.value.operation.operationId);
    await coordinator.close();
  });

  it("bounds pairing start by the operation deadline and releases the operation slot", async () => {
    const { client, coordinator } = await createSubject();
    const lateStart = deferred<void>();
    client.startWaits.push(lateStart);
    const creating = await startOperation(coordinator, { kind: "connect", interactionInterface: "cli" });
    expect(creating.operation.state).toBe("starting_connection");

    await vi.advanceTimersByTimeAsync(5 * 60 * 1_000);
    await drainCoordinator();
    await vi.advanceTimersByTimeAsync(5 * 60 * 1_000);
    expect(await observeOperationState(
      coordinator,
      creating.operation.operationId,
      "failed",
    )).toMatchObject({
      state: "failed",
      failure: { error: { code: "wallet_timeout" } },
    });
    await expectWalletCode(
      startOperation(coordinator, { kind: "disconnect", interactionInterface: "cli" }),
      "runtime_state_unavailable",
    );

    lateStart.resolve();
    await drainCoordinator();
    const next = await startOperation(coordinator, { kind: "disconnect", interactionInterface: "cli" });
    expect(next.operation).toMatchObject({
      state: "completed",
      result: { outcome: "already_disconnected" },
    });
    await coordinator.close();
  });

  it("normalizes proposal cancellation failure without exposing adapter errors", async () => {
    const { client, coordinator } = await createSubject();
    const pending = await startOperation(coordinator, { kind: "connect", interactionInterface: "cli" });
    await observeOperationState(coordinator, pending.operation.operationId, "awaiting_wallet_approval");
    const attempt = client.attempts[0] as FakeConnectionAttempt;
    attempt.cancelError = new WalletConnectClientError("sdk_unavailable");

    expect(await coordinator.cancel(pending.operation.operationId)).toMatchObject({
      operation: { state: "cancelling" },
    });
    expect(await observeOperationState(
      coordinator,
      pending.operation.operationId,
      "awaiting_wallet_approval",
    )).toMatchObject({ failure: null });
    await coordinator.close();
  });

  it("maps rejection and transport failure to distinct terminal states", async () => {
    const { client, coordinator } = await createSubject();
    const rejected = await startOperation(coordinator, { kind: "connect", interactionInterface: "cli" });
    await observeOperationState(coordinator, rejected.operation.operationId, "awaiting_wallet_approval");
    (client.attempts[0] as FakeConnectionAttempt).settle(Object.freeze({ status: "rejected" }));
    await drainCoordinator();
    expect(await operationState(coordinator, rejected.operation.operationId)).toBe("rejected");

    const failed = await startOperation(coordinator, { kind: "connect", interactionInterface: "cli" });
    await observeOperationState(coordinator, failed.operation.operationId, "awaiting_wallet_approval");
    (client.attempts[1] as FakeConnectionAttempt).settle(Object.freeze({ status: "failed" }));
    await drainCoordinator();
    expect((await coordinator.get(failed.operation.operationId)).operation).toMatchObject({
      state: "failed",
      failure: { error: { code: "runtime_state_unavailable" } },
    });
    await coordinator.close();
  });

  it("fails closed when the SDK store or pairing start is unavailable", async () => {
    const unavailable = new FakeWalletConnectClient();
    unavailable.listError = new WalletConnectClientError("sdk_unavailable");
    const bootstrap = createBootstrap();
    const coordinator = await createWalletCoordinator({ client: unavailable, wallet: bootstrap.wallet });
    expect(bootstrap.projection.read().connection).toEqual(disconnected("unusable_store"));
    const connectionRead = await invokeWalletConnection(coordinator);
    expect(connectionRead).toMatchObject({ ok: false, error: { code: "runtime_state_unavailable" } });
    expect(JSON.stringify(connectionRead)).not.toContain("wallet_sdk_state");
    await expectWalletCode(
      startOperation(coordinator, { kind: "connect", interactionInterface: "cli" }),
      "runtime_state_unavailable",
    );
    await coordinator.close();

    const startFailure = await createSubject();
    startFailure.client.startError = new WalletConnectClientError("sdk_unavailable");
    const operation = await startOperation(startFailure.coordinator, {
      kind: "connect",
      interactionInterface: "cli",
    });
    expect(operation.operation).toMatchObject({ state: "starting_connection" });
    expect(await observeOperationState(
      startFailure.coordinator,
      operation.operation.operationId,
      "failed",
    )).toMatchObject({
      state: "failed",
      failure: { error: { code: "runtime_state_unavailable" } },
    });
    expect(JSON.stringify(operation)).not.toContain("secret pairing failure");
    await startFailure.coordinator.close();
  });

  it("makes connection evidence unavailable while adapter quarantine is unresolved", async () => {
    const { client, coordinator } = await createSubject([session()]);
    client.listError = new WalletConnectClientError("sdk_unavailable");
    client.emit({ kind: "session_quarantined" });
    await drainCoordinator();

    expect(coordinator.activeWallet.capture().connection).toEqual(disconnected("unusable_store"));
    await expect(invokeWalletConnection(coordinator)).resolves.toMatchObject({
      ok: false,
      error: { code: "runtime_state_unavailable" },
    });

    client.listError = undefined;
    client.emit({ kind: "session_changed", topic: topicA });
    await drainCoordinator();
    expect(coordinator.activeWallet.capture().connection).toMatchObject({
      status: "connected",
      address: addressA,
    });
    await coordinator.close();
  });

  it.each([
    ["zero target accounts", session(topicA, addressA, { accounts: [] })],
    [
      "multiple target accounts",
      session(topicA, addressA, {
        accounts: [`eip155:4663:${addressA}`, `eip155:4663:${addressB}`],
      }),
    ],
    ["missing required method", session(topicA, addressA, { methods: [] })],
    ["missing required event", session(topicA, addressA, { events: ["accountsChanged"] })],
    ["expired session", session(topicA, addressA, { expiry: Date.parse(initialTime) / 1_000 })],
  ])("revokes an approved session with %s", async (_case, invalid) => {
    const { client, coordinator, projection } = await createSubject();
    const pending = await startOperation(coordinator, { kind: "connect", interactionInterface: "cli" });
    client.sessions = [invalid];
    (client.attempts[0] as FakeConnectionAttempt).settle(
      Object.freeze({ status: "approved", session: invalid }),
    );
    await drainCoordinator();

    expect(await observeOperationState(
      coordinator,
      pending.operation.operationId,
      "failed",
    )).toMatchObject({
      state: "failed",
      failure: { error: { code: "wallet_session_unusable" } },
    });
    expect(client.disconnectTopics).toContain(topicA);
    expect(client.sessions).toEqual([]);
    expect(projection.read().connection).toMatchObject({ status: "disconnected" });
    await coordinator.close();
  });

  it("terminates approval settlement on an unexpected projection invariant failure", async () => {
    const { client, coordinator, projection } = await createSubject();
    const pending = await startOperation(coordinator, { kind: "connect", interactionInterface: "cli" });
    const approved = session();
    const cleanupGate = deferred<void>();
    client.disconnectWaits.push(cleanupGate);
    client.sessions = [approved];
    projection.replaceError = new Error("secret unexpected projection invariant");
    (client.attempts[0] as FakeConnectionAttempt).settle(
      Object.freeze({ status: "approved", session: approved }),
    );
    await drainCoordinator();

    expect(await operationState(coordinator, pending.operation.operationId)).toBe("validating_session");
    expect(client.sessions.map(({ topic }) => topic)).toEqual([topicA]);
    cleanupGate.resolve();
    await drainCoordinator();

    expect(await observeOperationState(
      coordinator,
      pending.operation.operationId,
      "failed",
    )).toMatchObject({
      state: "failed",
      failure: { error: { code: "runtime_state_unavailable" } },
    });
    expect(client.disconnectTopics).toEqual([topicA]);
    expect(client.sessions).toEqual([]);
    projection.replaceError = undefined;
    await coordinator.close();
  });

  it("revokes the exact approved topic when session-store validation throws", async () => {
    const { client, coordinator } = await createSubject();
    const pending = await startOperation(coordinator, { kind: "connect", interactionInterface: "cli" });
    const approved = session();
    const cleanupGate = deferred<void>();
    client.disconnectWaits.push(cleanupGate);
    client.sessions = [approved];
    client.listError = new WalletConnectClientError("sdk_unavailable");
    (client.attempts[0] as FakeConnectionAttempt).settle(
      Object.freeze({ status: "approved", session: approved }),
    );
    await drainCoordinator();

    expect(client.disconnectTopics).toEqual([topicA]);
    expect(await operationState(coordinator, pending.operation.operationId)).toBe("validating_session");
    expect(client.sessions.map(({ topic }) => topic)).toEqual([topicA]);
    cleanupGate.resolve();
    await drainCoordinator();
    expect(client.sessions).toEqual([]);
    client.listError = undefined;
    expect(await observeOperationState(
      coordinator,
      pending.operation.operationId,
      "failed",
    )).toMatchObject({
      state: "failed",
      failure: { error: { code: "runtime_state_unavailable" } },
    });
    await coordinator.close();
  });

  it("revokes the exact approved topic when canonical session validation throws", async () => {
    const { client, coordinator } = await createSubject();
    const pending = await startOperation(coordinator, { kind: "connect", interactionInterface: "cli" });
    const approved = session();
    const hostile = Object.freeze({
      ...approved,
      namespaces: new Proxy(approved.namespaces, {
        ownKeys() { throw new Error("secret invalid namespace store"); },
      }),
    }) as WalletConnectSessionSnapshot;
    const cleanupGate = deferred<void>();
    client.disconnectWaits.push(cleanupGate);
    client.sessions = [hostile];
    (client.attempts[0] as FakeConnectionAttempt).settle(
      Object.freeze({ status: "approved", session: hostile }),
    );
    await drainCoordinator();

    expect(client.disconnectTopics).toEqual([topicA]);
    expect(await operationState(coordinator, pending.operation.operationId)).toBe("validating_session");
    cleanupGate.resolve();
    await drainCoordinator();
    expect(client.sessions).toEqual([]);
    expect(await observeOperationState(
      coordinator,
      pending.operation.operationId,
      "failed",
    )).toMatchObject({
      state: "failed",
      failure: { error: { code: "internal_error" } },
    });
    await coordinator.close();
  });

  it("rejects approval when the SDK store contains an extra session", async () => {
    const { client, coordinator } = await createSubject();
    const pending = await startOperation(coordinator, { kind: "connect", interactionInterface: "cli" });
    const approved = session();
    client.sessions = [approved, session(topicB, addressB)];
    (client.attempts[0] as FakeConnectionAttempt).settle(
      Object.freeze({ status: "approved", session: approved }),
    );
    await drainCoordinator();

    expect(await observeOperationState(
      coordinator,
      pending.operation.operationId,
      "failed",
    )).toMatchObject({
      state: "failed",
      failure: { error: { code: "wallet_session_unusable" } },
    });
    expect(client.disconnectTopics).toEqual([topicA]);
    expect(client.sessions.map(({ topic }) => topic)).toEqual([topicB]);
    expect(coordinator.activeWallet.capture().connection).toEqual(disconnected("unusable_store"));
    await expectWalletCode(
      startOperation(coordinator, { kind: "connect", interactionInterface: "web" }),
      "state_conflict",
    );
    expect(client.sessions.map(({ topic }) => topic)).toEqual([topicB]);
    await coordinator.close();
  });

  it("keeps an absent approved topic quarantined until a late store appearance is cleaned", async () => {
    const { client, coordinator, projection } = await createSubject();
    const pending = await startOperation(coordinator, { kind: "connect", interactionInterface: "cli" });
    const approved = session(topicA, addressA);
    (client.attempts[0] as FakeConnectionAttempt).settle(
      Object.freeze({ status: "approved", session: approved }),
    );
    await drainCoordinator();

    expect((await coordinator.get(pending.operation.operationId)).operation).toMatchObject({
      state: "failed",
      failure: { error: { code: "wallet_session_unusable" } },
    });
    expect(client.disconnectTopics).toEqual([]);

    client.sessions = [approved];
    client.emit({ kind: "session_changed", topic: topicA });
    await drainCoordinator();

    expect(client.disconnectTopics).toEqual([topicA]);
    expect(client.sessions).toEqual([]);
    expect(projection.read().connection).toEqual(disconnected("no_session"));
    await coordinator.close();
  });

  it("never revokes an unrelated session when rejected approval cleanup fails", async () => {
    const { client, coordinator } = await createSubject();
    const pending = await startOperation(coordinator, { kind: "connect", interactionInterface: "cli" });
    const approved = session(topicA, addressA);
    client.sessions = [approved, session(topicB, addressB)];
    client.disconnectFailures.add(topicA);
    (client.attempts[0] as FakeConnectionAttempt).settle(
      Object.freeze({ status: "approved", session: approved }),
    );
    await drainCoordinator();

    expect(await observeOperationState(
      coordinator,
      pending.operation.operationId,
      "failed",
    )).toMatchObject({
      state: "failed",
      failure: { error: { code: "runtime_state_unavailable" } },
    });
    expect(client.disconnectTopics).toEqual([topicA]);
    expect(client.sessions.map(({ topic }) => topic)).toEqual([topicA, topicB]);
    await expectWalletCode(
      startOperation(coordinator, { kind: "connect", interactionInterface: "web" }),
      "runtime_state_unavailable",
    );

    client.disconnectFailures.delete(topicA);
    await expectWalletCode(
      coordinator.start({
        kind: "connect",
        interactionInterface: "web",
        connectionRevision: null,
      }),
      "state_conflict",
    );
    expect(client.disconnectTopics).toEqual([topicA, topicA, topicA]);
    expect(client.sessions.map(({ topic }) => topic)).toEqual([topicB]);
    await coordinator.close();
  });

  it("invalidates a same-topic account replacement instead of adopting the new account", async () => {
    const { client, coordinator, projection } = await createSubject([session(topicA, addressA)]);

    client.sessions = [session(topicA, addressB)];
    client.emit({
      kind: "session_event",
      topic: topicA,
      eventName: "accountsChanged",
      data: [`eip155:4663:${addressB}` as WalletConnectAccountReference],
    });
    await drainCoordinator();
    expect(projection.read().connection).toEqual(disconnected("no_session"));
    expect(client.sessions).toEqual([]);
    expect(client.disconnectTopics).toEqual([topicA]);
    await coordinator.close();
  });

  it("reconciles deletion, expiry, and invalid chain events without restoring a session", async () => {
    const invalidChain = await createSubject([session()]);
    invalidChain.client.emit({
      kind: "session_event",
      topic: topicA,
      eventName: "chainChanged",
      data: "0x1",
    });
    await drainCoordinator();
    expect(invalidChain.projection.read().connection).toEqual(disconnected("no_session"));
    expect(invalidChain.client.sessions).toEqual([]);
    await invalidChain.coordinator.close();

    const deleted = await createSubject([session()]);
    deleted.client.sessions = [];
    deleted.client.emit({ kind: "session_deleted", topic: topicA });
    await drainCoordinator();
    expect(deleted.projection.read().connection).toEqual(disconnected("deleted"));
    await deleted.coordinator.close();

    const expired = await createSubject([session()]);
    expired.client.sessions = [];
    expired.client.emit({ kind: "session_deleted", topic: topicA });
    await drainCoordinator();
    expect(expired.projection.read().connection).toEqual(disconnected("deleted"));
    expired.client.emit({ kind: "session_expired", topic: topicA });
    await drainCoordinator();
    expect(expired.projection.read().connection).toEqual(disconnected("expired"));
    await expired.coordinator.close();
  });

  it("treats accountsChanged as an invalidation trigger rather than account authority", async () => {
    const { client, coordinator, projection } = await createSubject([session(topicA, addressA)]);

    client.emit({
      kind: "session_event",
      topic: topicA,
      eventName: "accountsChanged",
      data: [`eip155:4663:${addressB}` as WalletConnectAccountReference],
    });
    await drainCoordinator();

    expect(client.disconnectTopics).toEqual([topicA]);
    expect(client.sessions).toEqual([]);
    expect(projection.read().connection).toEqual(disconnected("no_session"));
    await coordinator.close();
  });

  it("invalidates account removal and ignores events for a non-active topic", async () => {
    const { client, coordinator, projection } = await createSubject([session()]);
    const revision = projection.read().revision;

    client.emit({ kind: "session_event", topic: topicB, eventName: "accountsChanged", data: [] });
    await drainCoordinator();
    expect(projection.read().revision).toBe(revision);
    expect(client.disconnectTopics).toEqual([]);

    client.emit({ kind: "session_event", topic: topicA, eventName: "accountsChanged", data: [] });
    await drainCoordinator();
    expect(projection.read().connection).toEqual(disconnected("no_session"));
    expect(client.disconnectTopics).toEqual([topicA]);
    await coordinator.close();
  });

  it("fails closed for invalid active or unscoped events and ignores an unrelated topic", async () => {
    const unrelated = await createSubject([session()]);
    const unrelatedRevision = unrelated.projection.read().revision;
    unrelated.client.emit({ kind: "invalid_session_event", topic: topicB });
    await drainCoordinator();
    expect(unrelated.projection.read().revision).toBe(unrelatedRevision);
    expect(unrelated.client.disconnectTopics).toEqual([]);

    unrelated.client.emit({ kind: "invalid_session_event", topic: null });
    await drainCoordinator();
    expect(unrelated.projection.read().connection).toEqual(disconnected("no_session"));
    expect(unrelated.client.disconnectTopics).toEqual([topicA]);
    await unrelated.coordinator.close();

    const active = await createSubject([session()]);
    active.client.emit({ kind: "invalid_session_event", topic: topicA });
    await drainCoordinator();
    expect(active.projection.read().connection).toEqual(disconnected("no_session"));
    expect(active.client.disconnectTopics).toEqual([topicA]);
    await active.coordinator.close();
  });

  it("fails active-wallet reads closed before asynchronous invalid-session revocation settles", async () => {
    const { client, coordinator, projection } = await createSubject([session()]);
    const lateRevocation = deferred<void>();
    client.disconnectWaits.push(lateRevocation);

    client.emit({ kind: "session_event", topic: topicA, eventName: "accountsChanged", data: [] });
    await drainCoordinator();
    expect(coordinator.activeWallet.capture().connection).toMatchObject({ status: "disconnected" });
    expect(projection.read().connection).toMatchObject({ status: "disconnected" });

    lateRevocation.resolve();
    await drainCoordinator();
    const next = await startOperation(coordinator, { kind: "disconnect", interactionInterface: "cli" });
    expect(next.operation).toMatchObject({
      state: "completed",
      result: { outcome: "already_disconnected" },
    });
    await coordinator.close();
  });

  it("fails active-wallet reads closed before changed-session revalidation cleanup settles", async () => {
    const { client, coordinator, projection } = await createSubject([session()]);
    const lateRevocation = deferred<void>();
    client.sessions = [session(topicA, addressA, { methods: [] })];
    client.disconnectWaits.push(lateRevocation);

    client.emit({ kind: "session_changed", topic: topicA });
    await drainCoordinator();
    expect(coordinator.activeWallet.capture().connection).toMatchObject({ status: "disconnected" });
    expect(projection.read().connection).toMatchObject({ status: "disconnected" });

    lateRevocation.resolve();
    await drainCoordinator();
    expect(client.sessions).toEqual([]);
    await coordinator.close();
  });

  it("fails active-wallet reads closed when an invalidation cannot update the product projection", async () => {
    const { client, coordinator, projection } = await createSubject([session()]);
    projection.replaceError = new RuntimeOperationError("runtime_state_unavailable");

    client.emit({ kind: "session_event", topic: topicA, eventName: "accountsChanged", data: [] });
    await drainCoordinator();

    expect(coordinator.activeWallet.capture().connection).toEqual(disconnected("unusable_store"));
    expect(client.disconnectTopics).toEqual([topicA]);
    await expectWalletCode(
      startOperation(coordinator, { kind: "disconnect", interactionInterface: "cli" }),
      "runtime_state_unavailable",
    );
    projection.replaceError = undefined;
    await coordinator.close();
  });

  it("expires pending operations, cancels their exact proposal, and retains terminal state for five minutes", async () => {
    const { client, coordinator } = await createSubject();
    const pending = await startOperation(coordinator, { kind: "connect", interactionInterface: "cli" });
    const attempt = client.attempts[0] as FakeConnectionAttempt;

    await vi.advanceTimersByTimeAsync(5 * 60 * 1_000);
    expect(await operationState(coordinator, pending.operation.operationId)).toBe("expired");
    expect(attempt.cancelCount).toBe(1);

    await vi.advanceTimersByTimeAsync(5 * 60 * 1_000 - 1);
    expect(await operationState(coordinator, pending.operation.operationId)).toBe("expired");
    await vi.advanceTimersByTimeAsync(1);
    await expect(coordinator.get(pending.operation.operationId)).rejects.toThrowError();
    await coordinator.close();
  });

  it("uses the canonical clock at the exact confirmation deadline without waiting for the timer callback", async () => {
    const { client, coordinator } = await createSubject([session()]);
    const pending = await startOperation(coordinator, { kind: "disconnect", interactionInterface: "web" });
    vi.setSystemTime(new Date(pending.operation.expiresAt));

    const current = await coordinator.get(pending.operation.operationId);
    expect(current.operation.state).toBe("expired");
    await expectWalletCode(coordinator.webConfirmation.confirm(pending.operation.operationId, {
      connectionRevision: pending.operation.connectionRevision,
    }), "state_conflict");
    expect(client.disconnectTopics).toEqual([]);
    expect(client.sessions.map(({ topic }) => topic)).toEqual([topicA]);
    await coordinator.close();
  });

  it("cancels an approval attempt before publishing canonical-clock expiry without timer delivery", async () => {
    const { client, coordinator } = await createSubject();
    const pending = await startOperation(coordinator, { kind: "connect", interactionInterface: "cli" });
    const attempt = client.attempts[0] as FakeConnectionAttempt;
    vi.setSystemTime(new Date(pending.operation.expiresAt));

    const current = await coordinator.get(pending.operation.operationId);
    expect(current.operation.state).toBe("expired");
    expect(attempt.cancelCount).toBe(1);
    expect(client.sessions).toEqual([]);
    await coordinator.close();
  });

  it("publishes an expired presentation after cancelling the exact attempt at the canonical deadline", async () => {
    const { client, coordinator } = await createSubject();
    const pending = await startOperation(coordinator, { kind: "connect", interactionInterface: "web" });
    const attempt = client.attempts[0] as FakeConnectionAttempt;
    vi.setSystemTime(new Date(pending.operation.expiresAt));

    expect(await coordinator.operationPresentation.get(pending.operation.operationId)).toEqual({
      operation: expect.objectContaining({ state: "expired" }),
      access: "interactive",
    });
    expect(attempt.cancelCount).toBe(1);
    expect((await observeOperationState(
      coordinator,
      pending.operation.operationId,
      "expired",
    )).state).toBe("expired");
    await coordinator.close();
  });

  it("quarantines approval settled after the canonical deadline instead of connecting", async () => {
    const { client, coordinator, projection } = await createSubject();
    const pending = await startOperation(coordinator, { kind: "connect", interactionInterface: "cli" });
    const attempt = client.attempts[0] as FakeConnectionAttempt;
    const approved = session();
    vi.setSystemTime(new Date(pending.operation.expiresAt));
    client.sessions = [approved];
    attempt.settle(Object.freeze({ status: "approved", session: approved }));
    await drainCoordinator();

    expect((await observeOperationState(
      coordinator,
      pending.operation.operationId,
      "expired",
    )).state).toBe("expired");
    expect(client.sessions).toEqual([]);
    expect(projection.read().connection).toEqual(disconnected("no_session"));
    await coordinator.close();
  });

  it("rejects an SDK mutation that resolves after its canonical deadline without timer delivery", async () => {
    const { client, coordinator } = await createSubject([session()]);
    const operation = await startOperation(coordinator, { kind: "disconnect", interactionInterface: "web" });
    const lateDisconnect = deferred<void>();
    client.disconnectWaits.push(lateDisconnect);
    const confirmation = await coordinator.webConfirmation.confirm(operation.operation.operationId, {
      connectionRevision: operation.operation.connectionRevision,
    });
    expect(confirmation.state).toBe("disconnecting");
    const active = await coordinator.get(operation.operation.operationId);
    vi.setSystemTime(new Date(active.operation.expiresAt));
    lateDisconnect.resolve();

    const failed = await observeOperationState(
      coordinator,
      operation.operation.operationId,
      "failed",
    );
    expect(failed).toMatchObject({
      state: "failed",
      failure: { error: { code: "wallet_timeout" } },
    });
    await drainCoordinator();
    await coordinator.close();
  });

  it("assigns a fresh SDK deadline when confirmation enters disconnection", async () => {
    const { client, coordinator } = await createSubject([session()]);
    const operation = await startOperation(coordinator, { kind: "disconnect", interactionInterface: "web" });
    vi.setSystemTime(new Date("2026-07-14T00:04:59.000Z"));
    const disconnectGate = deferred<void>();
    client.disconnectWaits.push(disconnectGate);
    const confirmation = await coordinator.webConfirmation.confirm(operation.operation.operationId, {
      connectionRevision: operation.operation.connectionRevision,
    });
    expect(confirmation.state).toBe("disconnecting");

    const active = await coordinator.get(operation.operation.operationId);
    expect(active.operation).toMatchObject({
      state: "disconnecting",
      expiresAt: "2026-07-14T00:09:59.000Z",
    });
    disconnectGate.resolve();
    expect(await observeOperationState(
      coordinator,
      operation.operation.operationId,
      "completed",
    )).toMatchObject({ state: "completed" });
    await coordinator.close();
  });

  it("removes terminal operations by canonical retention time without timer delivery", async () => {
    const { coordinator } = await createSubject();
    const completed = await startOperation(coordinator, { kind: "disconnect", interactionInterface: "cli" });
    vi.setSystemTime(new Date(completed.operation.expiresAt));

    await expect(coordinator.get(completed.operation.operationId)).rejects.toThrowError();
    await coordinator.close();
  });

  it("ends user waiting at five minutes and fences a stalled expiry cancellation", async () => {
    const { client, coordinator } = await createSubject();
    const pending = await startOperation(coordinator, { kind: "connect", interactionInterface: "cli" });
    const attempt = client.attempts[0] as FakeConnectionAttempt;
    const lateCancellation = deferred<void>();
    attempt.cancelWait = lateCancellation;

    await vi.advanceTimersByTimeAsync(5 * 60 * 1_000);
    expect(await operationState(coordinator, pending.operation.operationId)).toBe("cancelling");
    expect(attempt.cancelCount).toBe(1);

    await vi.advanceTimersByTimeAsync(5 * 60 * 1_000);
    expect((await coordinator.get(pending.operation.operationId)).operation).toMatchObject({
      state: "failed",
      failure: { error: { code: "wallet_timeout" } },
    });
    await expectWalletCode(
      startOperation(coordinator, { kind: "disconnect", interactionInterface: "cli" }),
      "runtime_state_unavailable",
    );

    lateCancellation.resolve();
    await drainCoordinator();
    const next = await startOperation(coordinator, { kind: "disconnect", interactionInterface: "cli" });
    expect(next.operation).toMatchObject({
      state: "completed",
      result: { outcome: "already_disconnected" },
    });
    await coordinator.close();
  });

  it("owns one attempt cancellation across cancel, expiry, and a retryable finite close", async () => {
    const { client, coordinator } = await createSubject();
    const pending = await startOperation(coordinator, { kind: "connect", interactionInterface: "cli" });
    const attempt = client.attempts[0] as FakeConnectionAttempt;
    const lateCancellation = deferred<void>();
    attempt.cancelWait = lateCancellation;

    const cancelling = await coordinator.cancel(pending.operation.operationId);
    expect(cancelling.operation.state).toBe("cancelling");
    expect(attempt.cancelCount).toBe(1);
    expect(await operationState(coordinator, pending.operation.operationId)).toBe("cancelling");

    await vi.advanceTimersByTimeAsync(5 * 60 * 1_000);
    expect((await coordinator.get(pending.operation.operationId)).operation).toMatchObject({
      state: "failed",
      failure: { error: { code: "wallet_timeout" } },
    });
    expect(attempt.cancelCount).toBe(1);

    const closing = coordinator.close();
    const closeFailure = expectWalletCode(closing, "runtime_state_unavailable");
    await drainCoordinator();
    await vi.advanceTimersByTimeAsync(5 * 60 * 1_000);
    await closeFailure;
    expect(attempt.cancelCount).toBe(1);
    expect(client.closeCount).toBe(0);

    lateCancellation.resolve();
    await drainCoordinator();
    await expect(coordinator.close()).resolves.toBeUndefined();
    expect(client.closeCount).toBe(1);
  });

  it("expires confirmation without mutating the existing session", async () => {
    const { client, coordinator } = await createSubject([session()]);
    const pending = await startOperation(coordinator, { kind: "disconnect", interactionInterface: "web" });

    await vi.advanceTimersByTimeAsync(5 * 60 * 1_000);
    expect(await operationState(coordinator, pending.operation.operationId)).toBe("expired");
    expect(client.disconnectTopics).toEqual([]);
    expect(client.sessions.map(({ topic }) => topic)).toEqual([topicA]);
    await coordinator.close();
  });

  it("binds confirmation authority to the operation interaction interface", async () => {
    const web = await createSubject([session()]);
    const webOperation = await startOperation(web.coordinator, {
      kind: "disconnect",
      interactionInterface: "web",
    });
    await expectWalletCode(web.coordinator.cliConfirmation.confirm(
      webOperation.operation.operationId,
      { connectionRevision: webOperation.operation.connectionRevision },
    ), "state_conflict");
    expect(web.client.disconnectTopics).toEqual([]);
    expect(await web.coordinator.webConfirmation.confirm(
      webOperation.operation.operationId,
      { connectionRevision: webOperation.operation.connectionRevision },
    )).toMatchObject({ state: "disconnecting" });
    await observeOperationState(web.coordinator, webOperation.operation.operationId, "completed");
    await web.coordinator.close();

    const cli = await createSubject([
      session(topicA, addressA),
      session(topicB, addressB),
    ]);
    const cliOperation = await startOperation(cli.coordinator, {
      kind: "disconnect",
      interactionInterface: "cli",
    });
    await expectWalletCode(cli.coordinator.webConfirmation.confirm(
      cliOperation.operation.operationId,
      { connectionRevision: cliOperation.operation.connectionRevision },
    ), "state_conflict");
    expect(cli.client.disconnectTopics).toEqual([]);
    await cli.coordinator.cancel(cliOperation.operation.operationId);
    await cli.coordinator.close();
  });

  it("atomically presents operation access and QR while preserving browser control scope", async () => {
    const cli = await createSubject();
    const cliPending = await startOperation(cli.coordinator, { kind: "connect", interactionInterface: "cli" });
    expect(cliPending.operation.state).toBe("starting_connection");
    expect(cliPending).not.toHaveProperty("qr");
    const cliAwaiting = await observeOperationState(
      cli.coordinator,
      cliPending.operation.operationId,
      "awaiting_wallet_approval",
    );
    expect(await cli.coordinator.operationPresentation.get(cliPending.operation.operationId)).toEqual({
      operation: cliAwaiting,
      qr,
      access: "read_only",
    });
    await expectWalletCode(
      cli.coordinator.operation.cancel(
        cliPending.operation.operationId,
        { connectionRevision: cliPending.operation.connectionRevision },
      ),
      "state_conflict",
    );
    expect((cli.client.attempts[0] as FakeConnectionAttempt).cancelCount).toBe(0);
    expect(await cli.coordinator.cancel(cliPending.operation.operationId)).toMatchObject({
      operation: { state: "cancelling" },
    });
    await observeOperationState(cli.coordinator, cliPending.operation.operationId, "cancelled");
    expect(await cli.coordinator.operationPresentation.get(cliPending.operation.operationId)).toEqual({
      operation: expect.objectContaining({ state: "cancelled" }),
      access: "read_only",
    });
    await cli.coordinator.close();

    const web = await createSubject();
    const webPending = await startOperation(web.coordinator, { kind: "connect", interactionInterface: "web" });
    expect(webPending.operation.state).toBe("starting_connection");
    expect(webPending).not.toHaveProperty("qr");
    const webAwaiting = await observeOperationState(
      web.coordinator,
      webPending.operation.operationId,
      "awaiting_wallet_approval",
    );
    expect(await web.coordinator.get(webPending.operation.operationId)).not.toHaveProperty("qr");
    expect(await web.coordinator.operationPresentation.get(webPending.operation.operationId)).toEqual({
      operation: webAwaiting,
      qr,
      access: "interactive",
    });
    expect(Object.keys(web.coordinator.operation).sort()).toEqual(["cancel", "start"]);
    expect(Object.keys(web.coordinator.operationPresentation)).toEqual(["get"]);
    expect(Object.keys(web.coordinator.cliConfirmation).sort()).toEqual(["confirm", "interactionInterface"]);
    expect(Object.keys(web.coordinator.webConfirmation).sort()).toEqual(["confirm", "interactionInterface"]);
    expect(await web.coordinator.cancel(webPending.operation.operationId)).toMatchObject({
      operation: { state: "cancelling" },
    });
    await observeOperationState(web.coordinator, webPending.operation.operationId, "cancelled");
    expect((web.client.attempts[0] as FakeConnectionAttempt).cancelCount).toBe(1);
    expect(await web.coordinator.operationPresentation.get(webPending.operation.operationId)).toEqual({
      operation: expect.objectContaining({ state: "cancelled" }),
      access: "interactive",
    });
    await web.coordinator.close();
  });

  it("presents confirmation state and access without requiring QR material", async () => {
    const web = await createSubject([session()]);
    const webPending = await startOperation(web.coordinator, { kind: "disconnect", interactionInterface: "web" });
    expect(webPending.operation.state).toBe("awaiting_confirmation");
    expect(await web.coordinator.operationPresentation.get(webPending.operation.operationId)).toEqual({
      operation: webPending.operation,
      access: "interactive",
    });
    await web.coordinator.cancel(webPending.operation.operationId);
    await web.coordinator.close();

    const cli = await createSubject([
      session(topicA, addressA),
      session(topicB, addressB),
    ]);
    const cliPending = await startOperation(cli.coordinator, { kind: "disconnect", interactionInterface: "cli" });
    expect(cliPending.operation.state).toBe("awaiting_confirmation");
    expect(await cli.coordinator.operationPresentation.get(cliPending.operation.operationId)).toEqual({
      operation: cliPending.operation,
      access: "read_only",
    });
    await cli.coordinator.cancel(cliPending.operation.operationId);
    await cli.coordinator.close();
  });

  it("cancels a pending proposal on owner close without revoking an approved session", async () => {
    const pendingOwner = await createSubject();
    const pending = await startOperation(pendingOwner.coordinator, { kind: "connect", interactionInterface: "cli" });
    const attempt = pendingOwner.client.attempts[0] as FakeConnectionAttempt;
    await pendingOwner.coordinator.close();
    expect(attempt.cancelCount).toBe(1);
    expect(pendingOwner.client.disconnectTopics).toEqual([]);
    await expect(
      pendingOwner.coordinator.operationPresentation.get(pending.operation.operationId),
    ).rejects.toThrowError();

    const connectedOwner = await createSubject([session()]);
    await connectedOwner.coordinator.close();
    expect(connectedOwner.client.disconnectTopics).toEqual([]);
    expect(connectedOwner.client.sessions.map(({ topic }) => topic)).toEqual([topicA]);
  });

  it("drains a session event racing with close without post-close client or projection access", async () => {
    const { client, coordinator, projection } = await createSubject([session(topicA, addressA)]);

    client.emit({
      kind: "session_event",
      topic: topicA,
      eventName: "accountsChanged",
      data: [`eip155:4663:${addressB}` as WalletConnectAccountReference],
    });
    await coordinator.close();
    const finalRecord = projection.read();
    await drainCoordinator();

    expect(client.callsAfterClose).toEqual([]);
    expect(projection.read()).toBe(finalRecord);
  });

  it("drains approval settlement racing with close without post-close client or projection access", async () => {
    const { client, coordinator, projection } = await createSubject();
    const pending = await startOperation(coordinator, { kind: "connect", interactionInterface: "cli" });
    const attempt = client.attempts[0] as FakeConnectionAttempt;
    const approved = session(topicA, addressA);
    client.sessions = [approved];

    attempt.settle(Object.freeze({ status: "approved", session: approved }));
    await coordinator.close();
    const finalRecord = projection.read();
    await drainCoordinator();

    expect(pending.operation.state).toBe("starting_connection");
    expect(client.callsAfterClose).toEqual([]);
    expect(projection.read()).toBe(finalRecord);
  });

  it("drains a deadline wake racing with close without post-close client or projection access", async () => {
    const { client, coordinator, projection } = await createSubject();
    await startOperation(coordinator, { kind: "connect", interactionInterface: "cli" });
    const attempt = client.attempts[0] as FakeConnectionAttempt;

    vi.advanceTimersByTime(5 * 60 * 1_000);
    await coordinator.close();
    const finalRecord = projection.read();
    await drainCoordinator();

    expect(attempt.cancelCount).toBe(1);
    expect(client.callsAfterClose).toEqual([]);
    expect(projection.read()).toBe(finalRecord);
  });

  it("finishes local close and promptly rejects new operations while pairing start remains pending", async () => {
    const { client, coordinator } = await createSubject();
    const startGate = deferred<void>();
    client.startWaits.push(startGate);
    const creating = await startOperation(coordinator, { kind: "connect", interactionInterface: "cli" });
    expect(creating.operation.state).toBe("starting_connection");

    let closeSettled = false;
    const closing = coordinator.close().then(() => { closeSettled = true; });
    let followupSettled = false;
    const followup = startOperation(coordinator, { kind: "disconnect", interactionInterface: "cli" })
      .then(
        () => undefined,
        (error: unknown) => {
          followupSettled = true;
          return error;
        },
      );
    await drainCoordinator();
    const closeSettledBeforeSdkRelease = closeSettled;
    const followupSettledBeforeSdkRelease = followupSettled;

    startGate.resolve();
    await closing;
    const followupError = await followup;

    expect(closeSettledBeforeSdkRelease).toBe(false);
    expect(followupSettledBeforeSdkRelease).toBe(true);
    expect(followupError).toMatchObject({
      failure: { error: { code: "runtime_state_unavailable" } },
    });
    expect(client.closed).toBe(true);
    expect(client.closeCount).toBe(1);
  });

  it("finishes local close and promptly rejects new operations while proposal cancellation remains pending", async () => {
    const { client, coordinator } = await createSubject();
    const pending = await startOperation(coordinator, { kind: "connect", interactionInterface: "cli" });
    const attempt = client.attempts[0] as FakeConnectionAttempt;
    const cancellationGate = deferred<void>();
    attempt.cancelWait = cancellationGate;
    const cancelling = await coordinator.cancel(pending.operation.operationId);
    expect(cancelling.operation.state).toBe("cancelling");
    expect(attempt.cancelCount).toBe(1);

    let closeSettled = false;
    const closing = coordinator.close().then(() => { closeSettled = true; });
    let followupSettled = false;
    const followup = startOperation(coordinator, { kind: "disconnect", interactionInterface: "cli" })
      .then(
        () => undefined,
        (error: unknown) => {
          followupSettled = true;
          return error;
        },
      );
    await drainCoordinator();
    const closeSettledBeforeSdkRelease = closeSettled;
    const followupSettledBeforeSdkRelease = followupSettled;

    cancellationGate.resolve();
    await closing;
    const followupError = await followup;

    expect(closeSettledBeforeSdkRelease).toBe(false);
    expect(followupSettledBeforeSdkRelease).toBe(true);
    expect(followupError).toMatchObject({
      failure: { error: { code: "runtime_state_unavailable" } },
    });
    expect(client.closed).toBe(true);
    expect(client.closeCount).toBe(1);
  });

  it("quiesces a serialized session-store mutation before releasing the wallet client", async () => {
    const { client, coordinator } = await createSubject([session()]);
    const disconnectGate = deferred<void>();
    client.disconnectWaits.push(disconnectGate);
    const disconnecting = await startOperation(coordinator, { kind: "disconnect", interactionInterface: "cli" });
    expect(disconnecting.operation.state).toBe("disconnecting");
    expect(client.disconnectTopics).toEqual([topicA]);

    const closing = coordinator.close();
    await drainCoordinator();
    expect(client.closeCount).toBe(0);

    disconnectGate.resolve();
    await expect(closing).resolves.toBeUndefined();
    expect(client.closeCount).toBe(1);
  });

  it("awaits and safely normalizes a wallet client shutdown failure", async () => {
    const { client, coordinator } = await createSubject([session()]);
    client.closeError = new WalletConnectClientError("sdk_unavailable");

    await expectWalletCode(coordinator.close(), "runtime_state_unavailable");
    client.closeError = undefined;
    await expect(coordinator.close()).resolves.toBeUndefined();
    expect(client.closeCount).toBe(2);
    expect(client.disconnectTopics).toEqual([]);
    expect(client.sessions.map(({ topic }) => topic)).toEqual([topicA]);
  });
});
