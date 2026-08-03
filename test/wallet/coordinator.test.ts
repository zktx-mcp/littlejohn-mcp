import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CapabilityBindingRegistry,
  CapabilityRegistry,
  ObservationAuthorityRegistry,
  createCanonicalClock,
  createCapabilityInvocationAuthority,
  createObservationAuthority,
  deriveCaip10Account,
  parseCapabilityDataAt,
  parseEvmAddressInput,
  parseEvmChainId,
  sourceReferenceSchema,
  walletConnectionCapability,
  type CanonicalClock,
  type InvocationBoundaryPorts,
  type UtcTimestamp,
  type WalletConnectionData,
} from "../../src/core/index.js";
import { readRuntimeConfiguration } from "../../src/runtime/configuration.js";
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
import type {
  WalletManagementOperation,
  WalletOperationCreate,
  WalletOperationStartResult,
} from "../../src/wallet/contracts.js";
import {
  WalletConnectClientError,
  type WalletConnectAttemptOutcome,
  type WalletConnectClientEvent,
  type WalletConnectClientPort,
  type WalletConnectConnectionAttemptPort,
  type WalletConnectAccountReference,
  type WalletConnectSessionSnapshot,
  type WalletConnectStableObservation,
} from "../../src/wallet/walletconnect-client.js";

const initialTime = "2026-07-14T00:00:00.000Z";
const addressA = "0x1111111111111111111111111111111111111111";
const addressB = "0x2222222222222222222222222222222222222222";
const topicA = "a".repeat(64);
const topicB = "b".repeat(64);
let operationIdSequence = 0;

const nextOperationId = (): string => {
  operationIdSequence += 1;
  return Buffer.alloc(32, operationIdSequence).toString("base64url");
};

const qr = Object.freeze({
  size: 21,
  rows: Array.from({ length: 21 }, () => "0".repeat(21)),
});

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  resolve(value: Value): void;
}

const deferred = <Value>(): Deferred<Value> => {
  let settle: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>((resolve) => { settle = resolve; });
  if (settle === undefined) throw new Error("Deferred result was not initialized.");
  return Object.freeze({ promise, resolve: settle });
};

class FakeConnectionAttempt implements WalletConnectConnectionAttemptPort {
  readonly qr = qr;
  readonly #outcome = deferred<WalletConnectAttemptOutcome>();
  cancelOutcome: WalletConnectAttemptOutcome = Object.freeze({ status: "cancelled" });
  cancelPromise: Promise<WalletConnectAttemptOutcome> | undefined;
  onCancel: (() => void) | undefined;
  terminal: WalletConnectAttemptOutcome | undefined;
  cancelCount = 0;

  wait(): Promise<WalletConnectAttemptOutcome> {
    return this.#outcome.promise;
  }

  async cancel(): Promise<WalletConnectAttemptOutcome> {
    if (this.terminal !== undefined) return this.terminal;
    this.cancelCount += 1;
    this.onCancel?.();
    if (this.cancelPromise !== undefined) return this.cancelPromise;
    this.settle(this.cancelOutcome);
    return this.cancelOutcome;
  }

  settle(outcome: WalletConnectAttemptOutcome): void {
    if (this.terminal !== undefined) return;
    this.terminal = outcome;
    this.#outcome.resolve(outcome);
  }
}

class FakeWalletConnectClient implements WalletConnectClientPort {
  proposalCount = 0;
  sessions: WalletConnectSessionSnapshot[] = [];
  revision = 0n;
  observeError: Error | undefined;
  readonly attempts: FakeConnectionAttempt[] = [];
  readonly disconnectedSourceIds: string[] = [];
  readonly lifecycle: string[] = [];
  readonly disconnectAfterDeleteFailures: Error[] = [];
  disconnectGate: Deferred<void> | undefined;
  preserveDisconnectedSources = false;
  #listener: ((event: WalletConnectClientEvent) => void) | undefined;

  observe(): WalletConnectStableObservation {
    this.lifecycle.push("observe");
    if (this.observeError !== undefined) throw this.observeError;
    return Object.freeze({
      proposalCount: this.proposalCount,
      sessions: Object.freeze([...this.sessions]),
      revision: this.revision,
    });
  }

  async startConnection(): Promise<WalletConnectConnectionAttemptPort> {
    this.lifecycle.push("startConnection");
    const attempt = new FakeConnectionAttempt();
    this.attempts.push(attempt);
    this.setObservation(this.sessions, 1);
    return attempt;
  }

  async disconnectSession(sessionSourceId: string): Promise<void> {
    this.lifecycle.push(`disconnect:${sessionSourceId}`);
    this.disconnectedSourceIds.push(sessionSourceId);
    if (this.disconnectGate !== undefined) await this.disconnectGate.promise;
    if (this.preserveDisconnectedSources) return;
    this.setObservation(
      this.sessions.filter((session) => session.source.sourceId !== sessionSourceId),
      this.proposalCount,
    );
    const failure = this.disconnectAfterDeleteFailures.shift();
    if (failure !== undefined) throw failure;
  }

  activate(listener: (event: WalletConnectClientEvent) => void) {
    if (this.#listener !== undefined) throw new Error("Only one coordinator may subscribe.");
    this.#listener = listener;
    let active = true;
    return Object.freeze({
      initialObservation: (() => {
        try {
          return Object.freeze({ status: "available" as const, observation: this.observe() });
        } catch {
          return Object.freeze({ status: "unavailable" as const });
        }
      })(),
      releaseEvents: () => undefined,
      unsubscribe: () => {
        if (!active) return;
        active = false;
        if (this.#listener === listener) this.#listener = undefined;
      },
    });
  }

  emit(event: WalletConnectClientEvent): void {
    this.#listener?.(event);
  }

  async contain(): Promise<void> {
    this.lifecycle.push("contain");
  }

  setObservation(
    sessions: readonly WalletConnectSessionSnapshot[],
    proposalCount = 0,
  ): void {
    this.sessions = [...sessions];
    this.proposalCount = proposalCount;
    this.revision += 1n;
  }
}

class MemoryWalletProjection implements WalletProjectionStore {
  #record: WalletConnectionRecord;
  readonly replaceFailures: Error[] = [];
  persistentReplaceFailure: Error | undefined;

  constructor(clock: CanonicalClock) {
    const observedAt = clock.now();
    this.#record = Object.freeze({
      revision: "0" as never,
      connection: parseCapabilityDataAt(
        walletConnectionCapability,
        { status: "unknown", reason: "reconciling" },
        observedAt,
      ),
      revalidationRequired: false,
      updatedAt: observedAt,
    });
  }

  read(): WalletConnectionRecord {
    return this.#record;
  }

  replace(
    expectedRevision: string,
    connection: WalletConnectionData,
    revalidationRequired: boolean,
    updatedAt: UtcTimestamp,
  ): WalletConnectionRecord {
    if (expectedRevision !== this.#record.revision) throw new Error("stale projection revision");
    const failure = this.replaceFailures.shift() ?? this.persistentReplaceFailure;
    if (failure !== undefined) throw failure;
    this.#record = Object.freeze({
      revision: String(BigInt(this.#record.revision) + 1n) as never,
      connection,
      revalidationRequired,
      updatedAt,
    });
    return this.#record;
  }

  advanceRevision(): void {
    this.#record = Object.freeze({
      ...this.#record,
      revision: String(BigInt(this.#record.revision) + 1n) as never,
    });
  }

  replaceExternally(
    connection: WalletConnectionData,
    revalidationRequired: boolean,
    updatedAt: UtcTimestamp,
  ): void {
    this.#record = Object.freeze({
      revision: String(BigInt(this.#record.revision) + 1n) as never,
      connection,
      revalidationRequired,
      updatedAt,
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
  const sourceCache = new Map<string, WalletSessionSource>();
  const createSessionSource = (topic: string): WalletSessionSource => {
    const cached = sourceCache.get(topic);
    if (cached !== undefined) return cached;
    const digest = topicDigest(topic);
    const sourceId = `wallet-session:${digest}`;
    const source = Object.freeze({
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
    sourceCache.set(topic, source);
    return source;
  };
  const projection = new MemoryWalletProjection(clock);
  const runtimeConfiguration = readRuntimeConfiguration({});
  const invocationAuthority = createCapabilityInvocationAuthority(
    clock,
    runtimeConfiguration.chain.chainId,
  );
  return Object.freeze({
    projection,
    wallet: Object.freeze({
      configuration: runtimeConfiguration.wallet,
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

const validSession = (
  source: WalletSessionSource,
  overrides: {
    readonly address?: string;
    readonly chains?: readonly string[] | "absent";
    readonly accounts?: readonly string[];
    readonly methods?: readonly string[];
    readonly events?: readonly string[];
    readonly expiry?: number;
  } = {},
): WalletConnectSessionSnapshot => {
  const chains = overrides.chains ?? ["eip155:4663"];
  return Object.freeze({
    status: "valid",
    source,
    expiry: overrides.expiry ?? Date.parse("2026-07-15T00:00:00.000Z") / 1_000,
    namespaces: Object.freeze({
      eip155: Object.freeze({
        ...(chains === "absent" ? {} : { chains: Object.freeze([...chains]) }),
        accounts: Object.freeze(overrides.accounts ?? [
          `eip155:4663:${overrides.address ?? addressA}`,
        ]),
        methods: Object.freeze(overrides.methods ?? ["eth_sendTransaction"]),
        events: Object.freeze(overrides.events ?? ["accountsChanged", "chainChanged"]),
      }),
    }),
  });
};

const invalidSession = (source: WalletSessionSource): WalletConnectSessionSnapshot =>
  Object.freeze({ status: "invalid", source });

interface Subject {
  readonly coordinator: WalletCoordinator;
  readonly client: FakeWalletConnectClient;
  readonly projection: MemoryWalletProjection;
  readonly source: (topic: string) => WalletSessionSource;
}

const createSubject = async (setup?: (
  client: FakeWalletConnectClient,
  source: (topic: string) => WalletSessionSource,
) => void): Promise<Subject> => {
  const bootstrap = createBootstrap();
  const source = (topic: string): WalletSessionSource =>
    bootstrap.wallet.sourceAuthority.createSessionSource(topic);
  const client = new FakeWalletConnectClient();
  setup?.(client, source);
  const coordinator = await createWalletCoordinator({ client, wallet: bootstrap.wallet });
  return Object.freeze({ coordinator, client, projection: bootstrap.projection, source });
};

const drainCoordinator = async (): Promise<void> => {
  for (let index = 0; index < 24; index += 1) await Promise.resolve();
};

const waitForOperation = async (
  coordinator: WalletCoordinator,
  operationId: string,
  predicate: (operation: WalletManagementOperation) => boolean,
): Promise<WalletManagementOperation> => {
  let last: WalletManagementOperation | undefined;
  for (let index = 0; index < 80; index += 1) {
    await drainCoordinator();
    last = await coordinator.get(operationId);
    if (predicate(last)) return last;
  }
  throw new Error(`Operation did not reach the expected state; last state was ${last?.state ?? "absent"}.`);
};

const waitForState = (
  coordinator: WalletCoordinator,
  operationId: string,
  state: WalletManagementOperation["state"],
): Promise<WalletManagementOperation> =>
  waitForOperation(coordinator, operationId, (operation) => operation.state === state);

const startOperation = async (
  coordinator: WalletCoordinator,
  kind: "connect" | "disconnect",
  interactionInterface: "cli" | "web" = "web",
  connectionRevision: WalletOperationCreate["connectionRevision"] = null,
): Promise<Extract<WalletOperationStartResult, { readonly status: "operation_started" }>> => {
  const result = await coordinator.start({
    operationId: nextOperationId(),
    kind,
    interactionInterface,
    connectionRevision,
  } satisfies WalletOperationCreate);
  if (result.status !== "operation_started") throw new Error("Expected an operation to start.");
  return result;
};

const expectWalletCode = async (action: Promise<unknown>, code: string): Promise<void> => {
  const outcome = await action.then(
    (value) => Object.freeze({ status: "resolved" as const, value }),
    (error: unknown) => Object.freeze({ status: "rejected" as const, error }),
  );
  if (outcome.status === "resolved") {
    expect(outcome.value).toMatchObject({ ok: false, error: { code } });
  } else {
    expect(outcome.error).toMatchObject({ failure: { error: { code } } });
  }
};

const invokeWalletConnection = (coordinator: WalletCoordinator) =>
  new CapabilityBindingRegistry(
    new CapabilityRegistry([walletConnectionCapability]),
    [coordinator.walletConnection.connection],
  ).invoke(walletConnectionCapability, {}, { signal: new AbortController().signal });

const expectNoConnectedPublicAuthority = async (
  coordinator: WalletCoordinator,
): Promise<void> => {
  const active = await Promise.resolve()
    .then(() => coordinator.activeWallet.capture())
    .then(
      (value) => Object.freeze({ status: "resolved" as const, value }),
      (error: unknown) => Object.freeze({ status: "rejected" as const, error }),
    );
  if (active.status === "resolved") {
    expect(active.value.connection.status).not.toBe("connected");
    expect(active.value).not.toHaveProperty("sessionSource");
  }

  const capability = await invokeWalletConnection(coordinator).then(
    (value) => Object.freeze({ status: "resolved" as const, value }),
    (error: unknown) => Object.freeze({ status: "rejected" as const, error }),
  );
  if (capability.status === "resolved" && capability.value.ok) {
    expect(capability.value.data.status).not.toBe("connected");
  }
};

describe("WalletCoordinator", () => {
  beforeEach(() => {
    operationIdSequence = 0;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(initialTime));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("restores one valid stable session without inventing an absent optional chains field", async () => {
    const subject = await createSubject((client, source) => {
      client.setObservation([validSession(source(topicA), { chains: "absent" })]);
    });

    expect(subject.coordinator.activeWallet.capture()).toMatchObject({
      connection: { status: "connected", address: addressA, chainId: "eip155:4663" },
      sessionSource: { sourceId: subject.source(topicA).sourceId },
    });

    const explicitEmpty = await createSubject((client, source) => {
      client.setObservation([validSession(source(topicA), { chains: [] })]);
    });
    expect(explicitEmpty.coordinator.activeWallet.capture().connection).toEqual({
      status: "unresolved",
      sessionCount: "1",
    });
  });

  it("keeps unavailable, invalid, and multiple observations distinct from healthy absence", async () => {
    const unavailable = await createSubject((client) => {
      client.observeError = new WalletConnectClientError("observation");
    });
    expect(unavailable.projection.read().connection).toEqual({
      status: "unknown",
      reason: "observation_unavailable",
    });
    await expectWalletCode(invokeWalletConnection(unavailable.coordinator), "runtime_state_unavailable");

    const invalid = await createSubject((client, source) => {
      client.setObservation([invalidSession(source(topicA))]);
    });
    expect(invalid.projection.read().connection).toEqual({
      status: "unresolved",
      sessionCount: "1",
    });

    const multiple = await createSubject((client, source) => {
      client.setObservation([
        validSession(source(topicA)),
        validSession(source(topicB), { address: addressB }),
      ]);
    });
    expect(multiple.projection.read().connection).toEqual({
      status: "unresolved",
      sessionCount: "2",
    });
    await expectWalletCode(
      multiple.coordinator.start({
        operationId: nextOperationId(),
        kind: "connect",
        interactionInterface: "web",
        connectionRevision: null,
      }),
      "wallet_session_unusable",
    );
    expect(multiple.client.attempts).toHaveLength(0);
  });

  it("requires exact local confirmation before disconnecting every observed source", async () => {
    const subject = await createSubject((client, source) => {
      client.setObservation([
        invalidSession(source(topicA)),
        validSession(source(topicB), { address: addressB }),
      ]);
    });
    const started = await startOperation(subject.coordinator, "disconnect", "web");
    const operation = started.operation;

    expect(operation.state).toBe("awaiting_confirmation");
    expect(subject.client.disconnectedSourceIds).toEqual([]);
    await expectWalletCode(
      subject.coordinator.cliConfirmation.confirm(operation.operationId, {
        connectionRevision: operation.connectionRevision,
      }),
      "state_conflict",
    );
    expect(subject.client.disconnectedSourceIds).toEqual([]);

    const confirming = await subject.coordinator.webConfirmation.confirm(operation.operationId, {
      connectionRevision: operation.connectionRevision,
    });
    expect(confirming.state).toBe("disconnecting");
    const completed = await waitForState(subject.coordinator, operation.operationId, "completed");
    expect(completed.result).toMatchObject({ outcome: "disconnected" });
    expect([...subject.client.disconnectedSourceIds].sort()).toEqual([
      subject.source(topicA).sourceId,
      subject.source(topicB).sourceId,
    ].sort());
  });

  it("rejects a confirmation whose displayed projection revision is stale without an SDK effect", async () => {
    const subject = await createSubject((client, source) => {
      client.setObservation([validSession(source(topicA))]);
    });
    const started = await startOperation(subject.coordinator, "disconnect", "web");
    subject.projection.advanceRevision();

    await expectWalletCode(
      subject.coordinator.webConfirmation.confirm(started.operation.operationId, {
        connectionRevision: started.operation.connectionRevision,
      }),
      "state_conflict",
    );
    expect(subject.client.disconnectedSourceIds).toEqual([]);
  });

  it("cancellation wins an approval race and cleans the exact late session before terminal publication", async () => {
    const subject = await createSubject();
    const started = await startOperation(subject.coordinator, "connect", "web");
    await waitForState(subject.coordinator, started.operation.operationId, "awaiting_wallet_approval");
    const attempt = subject.client.attempts[0];
    if (attempt === undefined) throw new Error("Connection attempt was not created.");
    const approved = validSession(subject.source(topicA));
    attempt.cancelOutcome = Object.freeze({ status: "approved", session: approved });
    attempt.onCancel = () => subject.client.setObservation([approved], 0);

    const cancelling = await subject.coordinator.cancel({
      operationId: started.operation.operationId,
      connectionRevision: started.operation.connectionRevision,
    });
    expect(cancelling.state).toBe("cancelling");
    const terminal = await waitForState(subject.coordinator, started.operation.operationId, "cancelled");

    expect(terminal.result).toBeNull();
    expect(terminal.failure).toBeNull();
    expect(subject.client.disconnectedSourceIds).toEqual([subject.source(topicA).sourceId]);
    expect(subject.projection.read().connection).toEqual({ status: "disconnected", reason: "no_session" });
    expect(await subject.coordinator.operationPresentation.get(
      started.operation.operationId,
      "web",
    )).not.toHaveProperty("qr");
  });

  it("preserves the exact numeric peer refusal instead of converting it into a local failure", async () => {
    const subject = await createSubject();
    const started = await startOperation(subject.coordinator, "connect", "web");
    await waitForState(subject.coordinator, started.operation.operationId, "awaiting_wallet_approval");
    const attempt = subject.client.attempts[0];
    if (attempt === undefined) throw new Error("Connection attempt was not created.");
    subject.client.setObservation([], 0);
    attempt.settle(Object.freeze({ status: "rejected", peerRefusalCode: 5103 }));

    const rejected = await waitForState(subject.coordinator, started.operation.operationId, "rejected");
    expect(rejected).toMatchObject({
      state: "rejected",
      peerRefusalCode: 5103,
      result: null,
      failure: null,
    });
  });

  it("durably gates a contradictory active-session event until stable emptiness clears it", async () => {
    const subject = await createSubject((client, source) => {
      client.setObservation([validSession(source(topicA))]);
    });
    subject.client.emit(Object.freeze({
      kind: "accounts_changed",
      sessionSourceId: subject.source(topicA).sourceId,
      chainId: parseEvmChainId("eip155:4663"),
      accounts: Object.freeze([deriveCaip10Account({
        chainId: parseEvmChainId("eip155:4663"),
        address: parseEvmAddressInput(addressB),
      }) as WalletConnectAccountReference]),
    }));

    expect(subject.projection.read().revalidationRequired).toBe(true);
    await drainCoordinator();
    expect(subject.projection.read()).toMatchObject({
      revalidationRequired: true,
      connection: { status: "unresolved", sessionCount: "1" },
    });
    expect(subject.client.disconnectedSourceIds).toEqual([]);

    subject.client.setObservation([], 0);
    subject.client.emit(Object.freeze({ kind: "observation_changed" }));
    await drainCoordinator();
    expect(subject.projection.read()).toMatchObject({
      revalidationRequired: false,
      connection: { status: "disconnected", reason: "no_session" },
    });
  });

  it("closes authority synchronously for an unattributed identity event before re-observation", async () => {
    const subject = await createSubject((client, source) => {
      client.setObservation([validSession(source(topicA))]);
    });

    subject.client.emit(Object.freeze({ kind: "identity_unattributed" }));
    expect(subject.projection.read()).toMatchObject({
      revalidationRequired: false,
      connection: { status: "unknown", reason: "reconciling" },
    });

    await drainCoordinator();
    expect(subject.projection.read()).toMatchObject({
      revalidationRequired: false,
      connection: { status: "connected", address: addressA },
    });
  });

  it("retains exact event attribution while a nonempty observation is unresolved", async () => {
    const subject = await createSubject((client, source) => {
      client.setObservation([validSession(source(topicA))]);
    });
    subject.client.setObservation([
      validSession(subject.source(topicA)),
      validSession(subject.source(topicB)),
    ]);
    subject.client.emit(Object.freeze({ kind: "observation_changed" }));
    await drainCoordinator();
    expect(subject.projection.read()).toMatchObject({
      revalidationRequired: false,
      connection: { status: "unresolved", sessionCount: "2" },
    });
    expect(subject.coordinator.activeWallet.capture()).not.toHaveProperty("sessionSource");

    subject.client.emit(Object.freeze({
      kind: "identity_invalid",
      sessionSourceId: subject.source(topicA).sourceId,
    }));
    expect(subject.projection.read().revalidationRequired).toBe(true);
    await drainCoordinator();

    subject.client.setObservation([validSession(subject.source(topicA))]);
    subject.client.emit(Object.freeze({ kind: "observation_changed" }));
    await drainCoordinator();
    expect(subject.projection.read()).toMatchObject({
      revalidationRequired: true,
      connection: { status: "unresolved", sessionCount: "1" },
    });
  });

  it("retains exact session attribution while a disconnect effect closes public authority", async () => {
    const gate = deferred<void>();
    const subject = await createSubject((client, source) => {
      client.setObservation([validSession(source(topicA))]);
      client.disconnectGate = gate;
      client.preserveDisconnectedSources = true;
    });
    const started = await startOperation(subject.coordinator, "disconnect", "web");
    await subject.coordinator.webConfirmation.confirm(started.operation.operationId, {
      connectionRevision: started.operation.connectionRevision,
    });
    await drainCoordinator();

    subject.client.emit(Object.freeze({
      kind: "identity_invalid",
      sessionSourceId: subject.source(topicA).sourceId,
    }));
    expect(subject.projection.read().revalidationRequired).toBe(true);

    gate.resolve();
    await waitForState(subject.coordinator, started.operation.operationId, "failed");
    expect(subject.projection.read()).toMatchObject({
      revalidationRequired: true,
      connection: { status: "unresolved", sessionCount: "1" },
    });
    await expectNoConnectedPublicAuthority(subject.coordinator);
  });

  it("does not attribute a closed-authority event to a different session source", async () => {
    const gate = deferred<void>();
    const subject = await createSubject((client, source) => {
      client.setObservation([validSession(source(topicA))]);
      client.disconnectGate = gate;
      client.preserveDisconnectedSources = true;
    });
    const started = await startOperation(subject.coordinator, "disconnect", "web");
    await subject.coordinator.webConfirmation.confirm(started.operation.operationId, {
      connectionRevision: started.operation.connectionRevision,
    });
    await drainCoordinator();

    subject.client.emit(Object.freeze({
      kind: "identity_invalid",
      sessionSourceId: subject.source(topicB).sourceId,
    }));
    expect(subject.projection.read().revalidationRequired).toBe(false);

    gate.resolve();
    await waitForState(subject.coordinator, started.operation.operationId, "failed");
    expect(subject.projection.read()).toMatchObject({
      revalidationRequired: false,
      connection: { status: "connected", address: addressA },
    });
  });

  it("does not let later observation failure replace a definite completed operation", async () => {
    const subject = await createSubject();
    const started = await startOperation(subject.coordinator, "connect", "web");
    await waitForState(subject.coordinator, started.operation.operationId, "awaiting_wallet_approval");
    const attempt = subject.client.attempts[0];
    if (attempt === undefined) throw new Error("Connection attempt was not created.");
    const approved = validSession(subject.source(topicA));
    subject.client.setObservation([approved], 0);
    attempt.settle(Object.freeze({ status: "approved", session: approved }));
    const completed = await waitForState(subject.coordinator, started.operation.operationId, "completed");

    subject.client.observeError = new WalletConnectClientError("observation");
    subject.client.emit(Object.freeze({ kind: "observation_changed" }));
    await drainCoordinator();

    expect(await subject.coordinator.get(started.operation.operationId)).toEqual(completed);
    expect(subject.projection.read().connection).toEqual({
      status: "unknown",
      reason: "observation_unavailable",
    });
  });

  it("contains product authority without observing, sealing, or closing SDK storage", async () => {
    const subject = await createSubject((client, source) => {
      client.setObservation([validSession(source(topicA))]);
    });
    subject.client.lifecycle.length = 0;
    await subject.coordinator.close();
    expect(subject.client.lifecycle).toEqual(["contain"]);
    expect(subject.client.disconnectedSourceIds).toEqual([]);
    expect(subject.projection.read().connection.status).toBe("connected");
  });

  it("prevents a late external effect from publishing after process-terminal containment", async () => {
    const subject = await createSubject();
    const started = await startOperation(subject.coordinator, "connect", "web");
    await waitForState(subject.coordinator, started.operation.operationId, "awaiting_wallet_approval");
    const attempt = subject.client.attempts[0];
    if (attempt === undefined) throw new Error("Connection attempt was not created.");
    const cancellation = deferred<WalletConnectAttemptOutcome>();
    attempt.cancelPromise = cancellation.promise;

    const closing = subject.coordinator.close();
    await vi.advanceTimersByTimeAsync(5 * 60 * 1_000);
    await closing;
    const containedProjection = subject.projection.read();

    subject.client.setObservation([], 0);
    cancellation.resolve(Object.freeze({ status: "cancelled" }));
    await drainCoordinator();

    expect(subject.projection.read()).toEqual(containedProjection);
    expect(subject.client.lifecycle).toContain("contain");
  });

  it("admits the closed projection before publishing a connect operation or starting the SDK effect", async () => {
    const subject = await createSubject();
    const operationId = nextOperationId();
    const projectionFailure = new Error("projection admission failed");
    subject.projection.replaceFailures.push(projectionFailure);

    await expect(subject.coordinator.start({
      operationId,
      kind: "connect",
      interactionInterface: "web",
      connectionRevision: null,
    })).rejects.toBe(projectionFailure);

    expect(subject.client.attempts).toEqual([]);
    expect(subject.client.lifecycle).not.toContain("startConnection");
    await expect(subject.coordinator.get(operationId)).rejects.toMatchObject({
      failure: { error: { code: "state_conflict" } },
    });
  });

  it("keeps an expired action nonterminal until its exact effect and postcondition settle", async () => {
    const readers = Object.freeze([
      Object.freeze({
        name: "operation",
        read: (coordinator: WalletCoordinator, operationId: string) => coordinator.get(operationId),
      }),
      Object.freeze({
        name: "presentation",
        read: (coordinator: WalletCoordinator, operationId: string) =>
          coordinator.operationPresentation.get(operationId, "web"),
      }),
      Object.freeze({
        name: "current projection",
        read: (coordinator: WalletCoordinator, _operationId: string) =>
          coordinator.currentOperationProjection.get(),
      }),
      Object.freeze({
        name: "active wallet",
        read: (coordinator: WalletCoordinator, _operationId: string) =>
          Promise.resolve(coordinator.activeWallet.capture()),
      }),
      Object.freeze({
        name: "wallet capability",
        read: (coordinator: WalletCoordinator, _operationId: string) =>
          invokeWalletConnection(coordinator),
      }),
    ]);

    for (const reader of readers) {
      vi.setSystemTime(new Date(initialTime));
      const subject = await createSubject();
      const started = await startOperation(subject.coordinator, "connect", "web");
      const awaiting = await waitForState(
        subject.coordinator,
        started.operation.operationId,
        "awaiting_wallet_approval",
      );
      const attempt = subject.client.attempts[0];
      if (attempt === undefined) throw new Error("Connection attempt was not created.");
      const cancellation = deferred<WalletConnectAttemptOutcome>();
      attempt.cancelPromise = cancellation.promise;
      vi.setSystemTime(new Date(Date.parse(awaiting.actionExpiresAt) + 1));

      await reader.read(subject.coordinator, awaiting.operationId);

      expect(await subject.coordinator.get(awaiting.operationId), reader.name).toMatchObject({
        state: "cancelling",
        result: null,
        failure: null,
      });
      expect(await subject.coordinator.currentOperationProjection.get(), reader.name).toMatchObject({
        status: "present",
        presentation: { operation: { state: "cancelling" } },
      });
      await expect(
        startOperation(subject.coordinator, "connect", "web"),
        `${reader.name} must keep the unsettled effect owned`,
      ).rejects.toMatchObject({ failure: { error: { code: "state_conflict" } } });
      expect(subject.client.attempts).toHaveLength(1);

      subject.client.setObservation([], 0);
      cancellation.resolve(Object.freeze({ status: "cancelled" }));
      expect(await waitForState(
        subject.coordinator,
        awaiting.operationId,
        "expired",
      ), reader.name).toMatchObject({ state: "expired", result: null, failure: null });
      expect(await subject.coordinator.currentOperationProjection.get(), reader.name)
        .toMatchObject({ status: "absent" });
    }
  });

  it("preserves a user's cancellation intent when its cleanup crosses the action deadline", async () => {
    const subject = await createSubject();
    const started = await startOperation(subject.coordinator, "connect", "web");
    const awaiting = await waitForState(
      subject.coordinator,
      started.operation.operationId,
      "awaiting_wallet_approval",
    );
    const attempt = subject.client.attempts[0];
    if (attempt === undefined) throw new Error("Connection attempt was not created.");
    const cancellation = deferred<WalletConnectAttemptOutcome>();
    attempt.cancelPromise = cancellation.promise;

    expect((await subject.coordinator.cancel({
      operationId: awaiting.operationId,
      connectionRevision: awaiting.connectionRevision,
    })).state).toBe("cancelling");
    vi.setSystemTime(new Date(Date.parse(awaiting.actionExpiresAt) + 1));
    expect((await subject.coordinator.get(awaiting.operationId)).state).toBe("cancelling");

    subject.client.setObservation([], 0);
    cancellation.resolve(Object.freeze({ status: "cancelled" }));
    expect((await waitForState(subject.coordinator, awaiting.operationId, "cancelled")).state)
      .toBe("cancelled");
  });

  it("keeps an expired disconnect nonterminal until stable emptiness is observed", async () => {
    const gate = deferred<void>();
    const subject = await createSubject((client, source) => {
      client.setObservation([validSession(source(topicA))]);
      client.disconnectGate = gate;
    });
    const started = await startOperation(subject.coordinator, "disconnect", "web");
    const disconnecting = await subject.coordinator.webConfirmation.confirm(
      started.operation.operationId,
      { connectionRevision: started.operation.connectionRevision },
    );
    await drainCoordinator();
    vi.setSystemTime(new Date(Date.parse(disconnecting.actionExpiresAt) + 1));

    expect((await subject.coordinator.get(disconnecting.operationId)).state).toBe("disconnecting");
    expect(await subject.coordinator.currentOperationProjection.get()).toMatchObject({
      status: "present",
      presentation: { operation: { state: "disconnecting" } },
    });

    gate.resolve();
    expect((await waitForState(subject.coordinator, disconnecting.operationId, "expired")).state)
      .toBe("expired");
  });

  it("never republishes a connected source while contradiction-gate persistence keeps failing", async () => {
    const subject = await createSubject((client, source) => {
      client.setObservation([validSession(source(topicA))]);
    });
    const projectionFailure = new Error("projection remains unavailable");
    subject.projection.persistentReplaceFailure = projectionFailure;

    subject.client.emit(Object.freeze({
      kind: "identity_invalid",
      sessionSourceId: subject.source(topicA).sourceId,
    }));

    await expectNoConnectedPublicAuthority(subject.coordinator);
    await expectNoConnectedPublicAuthority(subject.coordinator);
    expect(subject.projection.read().connection.status).toBe("connected");
  });

  it("requires a durable revision boundary before identical connection data can bind a new source", async () => {
    const subject = await createSubject((client, source) => {
      client.setObservation([validSession(source(topicA))]);
    });
    const originalRevision = subject.projection.read().revision;
    subject.client.setObservation([validSession(subject.source(topicB))]);
    subject.projection.persistentReplaceFailure = new Error("source replacement was not durable");

    subject.client.emit(Object.freeze({
      kind: "accounts_changed",
      sessionSourceId: subject.source(topicA).sourceId,
      chainId: parseEvmChainId("eip155:4663"),
      accounts: Object.freeze([deriveCaip10Account({
        chainId: parseEvmChainId("eip155:4663"),
        address: parseEvmAddressInput(addressA),
      }) as WalletConnectAccountReference]),
    }));
    await drainCoordinator();

    expect(subject.projection.read().revision).toBe(originalRevision);
    await expectNoConnectedPublicAuthority(subject.coordinator);

    subject.projection.persistentReplaceFailure = undefined;
    subject.client.setObservation([], 0);
    subject.client.emit(Object.freeze({ kind: "observation_changed" }));
    await drainCoordinator();
    const emptyRevision = subject.projection.read().revision;
    expect(emptyRevision).not.toBe(originalRevision);

    subject.client.setObservation([validSession(subject.source(topicB))]);
    subject.client.emit(Object.freeze({ kind: "observation_changed" }));
    await drainCoordinator();
    const rebound = subject.coordinator.activeWallet.capture();
    expect(rebound).toMatchObject({
      connection: { status: "connected", address: addressA },
      sessionSource: { sourceId: subject.source(topicB).sourceId },
    });
    expect(rebound.connectionRevision).not.toBe(emptyRevision);
  });

  it("uses the last admitted exact source to clean an expired connected session", async () => {
    const expiresAt = Date.parse(initialTime) / 1_000 + 1;
    const subject = await createSubject((client, source) => {
      client.setObservation([validSession(source(topicA), { expiry: expiresAt })]);
    });
    vi.setSystemTime(new Date(Date.parse(initialTime) + 2_000));

    expect(subject.coordinator.activeWallet.capture().connection.status).toBe("unknown");
    await drainCoordinator();

    expect(subject.client.disconnectedSourceIds).toEqual([subject.source(topicA).sourceId]);
    expect(subject.projection.read()).toMatchObject({
      revalidationRequired: false,
      connection: { status: "disconnected", reason: "expired" },
    });
  });

  it("accepts a fresh empty postcondition when disconnect deleted the session before throwing", async () => {
    const subject = await createSubject((client, source) => {
      client.setObservation([validSession(source(topicA))]);
      client.disconnectAfterDeleteFailures.push(new WalletConnectClientError("sdk"));
    });
    const started = await startOperation(subject.coordinator, "disconnect", "web");
    await subject.coordinator.webConfirmation.confirm(started.operation.operationId, {
      connectionRevision: started.operation.connectionRevision,
    });

    const completed = await waitForState(
      subject.coordinator,
      started.operation.operationId,
      "completed",
    );
    expect(completed).toMatchObject({
      result: { outcome: "disconnected", connection: { status: "disconnected" } },
      failure: null,
    });
    expect(subject.client.disconnectedSourceIds).toEqual([subject.source(topicA).sourceId]);
  });

  it("attempts every independent session before deciding a disconnect postcondition", async () => {
    const subject = await createSubject((client, source) => {
      client.setObservation([
        validSession(source(topicA)),
        validSession(source(topicB), { address: addressB }),
      ]);
      client.disconnectAfterDeleteFailures.push(new WalletConnectClientError("sdk"));
    });
    const started = await startOperation(subject.coordinator, "disconnect", "web");
    await subject.coordinator.webConfirmation.confirm(started.operation.operationId, {
      connectionRevision: started.operation.connectionRevision,
    });

    const completed = await waitForState(
      subject.coordinator,
      started.operation.operationId,
      "completed",
    );
    expect(completed).toMatchObject({
      result: { outcome: "disconnected", connection: { status: "disconnected" } },
      failure: null,
    });
    expect(subject.client.disconnectedSourceIds).toEqual([
      subject.source(topicA).sourceId,
      subject.source(topicB).sourceId,
    ]);
  });

  it("preserves an admitted disconnected cause across unchanged empty observations", async () => {
    const subject = await createSubject((client, source) => {
      client.setObservation([validSession(source(topicA))]);
    });
    const started = await startOperation(subject.coordinator, "disconnect", "web");
    await subject.coordinator.webConfirmation.confirm(started.operation.operationId, {
      connectionRevision: started.operation.connectionRevision,
    });
    await waitForState(subject.coordinator, started.operation.operationId, "completed");
    const completedProjection = subject.projection.read();
    expect(completedProjection.connection).toEqual({
      status: "disconnected",
      reason: "disconnected",
    });

    subject.client.emit(Object.freeze({ kind: "observation_changed" }));
    await drainCoordinator();

    expect(subject.projection.read()).toEqual(completedProjection);
  });

  it("contains an orphan proposal without converting it into a session claim", async () => {
    const subject = await createSubject((client) => {
      client.setObservation([], 1);
    });
    subject.client.lifecycle.length = 0;
    await subject.coordinator.close();

    expect(subject.client.lifecycle).toEqual(["contain"]);
    expect(subject.projection.read()).toMatchObject({
      revalidationRequired: false,
      connection: { status: "unknown", reason: "reconciling" },
    });
    expect(subject.client.disconnectedSourceIds).toEqual([]);
  });
});
