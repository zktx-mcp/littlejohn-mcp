import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ObservationAuthorityRegistry,
  createCanonicalClock,
  createCapabilityInvocationAuthority,
  createObservationAuthority,
  parseCapabilityDataAt,
  parseHash32,
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
import {
  assertWalletOperationTransition,
  parseWalletManagementOperation,
  parseWalletQrMatrix,
  parseWalletReview,
  walletReviewDigest,
  type WalletManagementOperation,
  type WalletNonterminalManagementOperation,
  type WalletOperationStore,
  type WalletOperationTransitionCommand,
  type WalletReview,
} from "../../src/wallet/contracts.js";
import {
  WalletConnectClientError,
  type WalletConnectAttemptOutcome,
  type WalletConnectClientEvent,
  type WalletConnectClientPort,
  type WalletConnectConnectionAttemptPort,
  type WalletConnectSessionSnapshot,
  type WalletConnectStableObservation,
} from "../../src/wallet/walletconnect-client.js";

const initialTime = "2026-07-14T00:00:00.000Z";
const addressA = "0x1111111111111111111111111111111111111111";
const addressB = "0x2222222222222222222222222222222222222222";
const topicA = "a".repeat(64);
const topicB = "b".repeat(64);

const qr = parseWalletQrMatrix({
  size: 21,
  rows: Array.from({ length: 21 }, () => "0".repeat(21)),
});

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  resolve(value: Value): void;
  reject(error: unknown): void;
}

const deferred = <Value>(): Deferred<Value> => {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return Object.freeze({ promise, resolve, reject });
};

class FakeConnectionAttempt implements WalletConnectConnectionAttemptPort {
  readonly qr = qr;
  readonly #outcome = deferred<WalletConnectAttemptOutcome>();
  terminal: WalletConnectAttemptOutcome | undefined;
  cancelCount = 0;
  onCancel: (() => void) | undefined;

  wait(): Promise<WalletConnectAttemptOutcome> { return this.#outcome.promise; }

  async cancel(): Promise<WalletConnectAttemptOutcome> {
    if (this.terminal !== undefined) return this.terminal;
    this.cancelCount += 1;
    this.onCancel?.();
    const outcome = Object.freeze({ status: "cancelled" as const });
    this.settle(outcome);
    return outcome;
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
  readonly events: string[];
  containmentCount = 0;
  containCalls = 0;
  onContain: (() => Promise<void>) | undefined;
  #listener: ((event: WalletConnectClientEvent) => void) | undefined;

  constructor(events: string[]) { this.events = events; }

  observe(): WalletConnectStableObservation {
    this.events.push("sdk:observe");
    if (this.observeError !== undefined) throw this.observeError;
    return Object.freeze({
      proposalCount: this.proposalCount,
      sessions: Object.freeze([...this.sessions]),
      revision: this.revision,
    });
  }

  async startConnection(): Promise<WalletConnectConnectionAttemptPort> {
    this.events.push("sdk:start_connection");
    const attempt = new FakeConnectionAttempt();
    attempt.onCancel = () => this.setObservation(this.sessions, 0);
    this.attempts.push(attempt);
    this.setObservation(this.sessions, 1);
    return attempt;
  }

  async containPendingConnectionState(): Promise<void> {
    this.events.push("sdk:contain_pending");
    this.containmentCount += 1;
    this.setObservation(this.sessions, 0);
  }

  async disconnectSession(sessionSourceId: string): Promise<void> {
    this.events.push(`sdk:disconnect:${sessionSourceId}`);
    this.disconnectedSourceIds.push(sessionSourceId);
    this.setObservation(
      this.sessions.filter((session) => session.source.sourceId !== sessionSourceId),
      this.proposalCount,
    );
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

  emit(event: WalletConnectClientEvent): void { this.#listener?.(event); }

  contain(): Promise<void> {
    this.events.push("sdk:contain");
    this.containCalls += 1;
    return this.onContain?.() ?? Promise.resolve();
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

  read(): WalletConnectionRecord { return this.#record; }

  replace(
    expectedRevision: string,
    connection: WalletConnectionData,
    revalidationRequired: boolean,
    updatedAt: UtcTimestamp,
  ): WalletConnectionRecord {
    if (expectedRevision !== this.#record.revision) throw new Error("stale projection revision");
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
}

class MemoryWalletOperationStore implements WalletOperationStore {
  readonly events: string[];
  readonly #values = new Map<string, WalletManagementOperation>();

  constructor(events: string[]) { this.events = events; }

  read(operationId: string): WalletManagementOperation | null {
    return this.#values.get(operationId) ?? null;
  }

  readActive(): WalletNonterminalManagementOperation | null {
    const active = [...this.#values.values()].filter((operation) => ![
      "completed", "cancelled", "rejected", "expired", "failed",
    ].includes(operation.state));
    if (active.length > 1) throw new Error("More than one active operation.");
    return (active[0] as WalletNonterminalManagementOperation | undefined) ?? null;
  }

  create(operation: WalletNonterminalManagementOperation): WalletNonterminalManagementOperation {
    if (this.#values.has(operation.operationId) || this.readActive() !== null) {
      throw new Error("Operation create conflict.");
    }
    const admitted = parseWalletManagementOperation(operation) as WalletNonterminalManagementOperation;
    this.events.push(`store:create:${admitted.state}`);
    this.#values.set(admitted.operationId, admitted);
    return admitted;
  }

  transition(command: WalletOperationTransitionCommand): WalletManagementOperation {
    const previous = this.#values.get(command.operationId);
    if (previous === undefined || [
      "completed", "cancelled", "rejected", "expired", "failed",
    ].includes(previous.state)) throw new Error("Operation transition conflict.");
    if (
      previous.state !== command.expectedState ||
      previous.review.reviewDigest !== command.reviewDigest ||
      previous.review.precondition.connectionRevision !== command.connectionRevision
    ) throw new Error("Operation transition compare-and-set conflict.");
    const admitted = assertWalletOperationTransition(
      previous as WalletNonterminalManagementOperation,
      command.operation,
    );
    this.events.push(`store:transition:${previous.state}->${admitted.state}`);
    this.#values.set(admitted.operationId, admitted);
    return admitted;
  }

  seed(operation: WalletManagementOperation): void {
    const admitted = parseWalletManagementOperation(operation);
    this.#values.set(admitted.operationId, admitted);
  }
}

const topicDigest = (topic: string): string =>
  createHash("sha256").update(topic, "utf8").digest("base64url");

const createBootstrap = (events: string[]) => {
  const clock = createCanonicalClock(() => new Date(Date.now()).toISOString());
  const runtimeConfiguration = readRuntimeConfiguration({});
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
  const operations = new MemoryWalletOperationStore(events);
  const invocationAuthority = createCapabilityInvocationAuthority(
    clock,
    runtimeConfiguration.chain.chainId,
  );
  const wallet: WalletOwnerBootstrapPort = Object.freeze({
    configuration: runtimeConfiguration.wallet,
    privateStoreDirectory: Object.freeze({ ensureDirectory: async () => "/unused-wallet-store" }),
    projection,
    operations,
    sourceAuthority: Object.freeze({
      sdkStoreSourceId: `wallet-sdk:${"A".repeat(22)}`,
      sdkStoreAuthority,
      createSessionSource,
    }),
    capabilityAuthority: Object.freeze({
      clock,
      invocationAuthority,
      createInvocationPorts(sessionSource?: WalletSessionSource): InvocationBoundaryPorts {
        return Object.freeze({
          observations: new ObservationAuthorityRegistry(
            clock,
            sessionSource === undefined
              ? [sdkStoreAuthority]
              : [sdkStoreAuthority, sessionSource.observationAuthority],
          ),
        });
      },
    }),
  });
  return Object.freeze({ wallet, projection, operations, createSessionSource });
};

const validSession = (
  source: WalletSessionSource,
  address = addressA,
): WalletConnectSessionSnapshot => Object.freeze({
  status: "valid",
  source,
  expiry: Date.parse("2026-07-15T00:00:00.000Z") / 1_000,
  namespaces: Object.freeze({
    eip155: Object.freeze({
      chains: Object.freeze(["eip155:4663"]),
      accounts: Object.freeze([`eip155:4663:${address}`]),
      methods: Object.freeze(["eth_sendTransaction"]),
      events: Object.freeze(["accountsChanged", "chainChanged"]),
    }),
  }),
});

interface Subject {
  readonly coordinator: WalletCoordinator;
  readonly client: FakeWalletConnectClient;
  readonly projection: MemoryWalletProjection;
  readonly operations: MemoryWalletOperationStore;
  readonly source: (topic: string) => WalletSessionSource;
  readonly events: string[];
}

const createSubject = async (setup?: (
  client: FakeWalletConnectClient,
  source: (topic: string) => WalletSessionSource,
) => void): Promise<Subject> => {
  const events: string[] = [];
  const bootstrap = createBootstrap(events);
  const client = new FakeWalletConnectClient(events);
  setup?.(client, bootstrap.createSessionSource);
  const coordinator = await createWalletCoordinator({ client, wallet: bootstrap.wallet });
  events.length = 0;
  return Object.freeze({
    coordinator,
    client,
    projection: bootstrap.projection,
    operations: bootstrap.operations,
    source: bootstrap.createSessionSource,
    events,
  });
};

const drain = async (): Promise<void> => {
  for (let index = 0; index < 24; index += 1) await Promise.resolve();
};

const waitForState = async (
  coordinator: WalletCoordinator,
  operationId: string,
  state: WalletManagementOperation["state"],
): Promise<WalletManagementOperation> => {
  let last: WalletManagementOperation | undefined;
  for (let index = 0; index < 80; index += 1) {
    await drain();
    last = await coordinator.get(operationId);
    if (last.state === state) return last;
  }
  throw new Error(`Operation remained ${last?.state ?? "absent"}.`);
};

const requireReview = async (
  coordinator: WalletCoordinator,
  kind: "connect" | "disconnect",
): Promise<WalletReview> => {
  const result = await coordinator.review({ kind });
  if (result.status !== "review") throw new Error("Expected an actionable Review.");
  return result.review;
};

const expectWalletCode = async (work: Promise<unknown>, code: string): Promise<void> => {
  await expect(work).rejects.toMatchObject({ failure: { error: { code } } });
};

const storedRestartReview = (operationId: string): WalletReview => {
  const withoutDigest = {
    contractVersion: "1" as const,
    domain: "wallet" as const,
    kind: "connect" as const,
    operationId,
    createdAt: initialTime,
    actionExpiresAt: "2026-07-14T00:05:00.000Z",
    target: { chainId: "eip155:4663" },
    decision: {
      requiredMethods: ["eth_sendTransaction"] as const,
      requiredEvents: ["accountsChanged", "chainChanged"] as const,
    },
    precondition: {
      connectionRevision: "1",
      connection: { status: "disconnected" as const, reason: "no_session" as const },
    },
    fixedEvidence: { sessionSourceIds: [] as const },
  };
  return parseWalletReview({ ...withoutDigest, reviewDigest: walletReviewDigest(withoutDigest) });
};

describe("WalletCoordinator final durable operation ownership", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(initialTime));
  });

  afterEach(() => { vi.useRealTimers(); });

  it("creates an immutable Review without operation state or WalletConnect effect", async () => {
    const subject = await createSubject();
    const review = await requireReview(subject.coordinator, "connect");

    expect(review).toMatchObject({
      kind: "connect",
      precondition: { connectionRevision: subject.projection.read().revision },
      fixedEvidence: { sessionSourceIds: [] },
    });
    expect(subject.operations.read(review.operationId)).toBeNull();
    expect(subject.operations.readActive()).toBeNull();
    expect(subject.client.attempts).toHaveLength(0);
    expect(subject.events).toEqual([]);
  });

  it("revalidates the Review connection revision before creating state or issuing an effect", async () => {
    const subject = await createSubject();
    const review = await requireReview(subject.coordinator, "connect");
    subject.projection.advanceRevision();

    await expectWalletCode(
      subject.coordinator.decide({ review, initiatedBy: "mcp_app" }),
      "state_conflict",
    );
    expect(subject.operations.read(review.operationId)).toBeNull();
    expect(subject.client.attempts).toHaveLength(0);
    expect(subject.events).not.toContain("sdk:start_connection");
  });

  it("rejects an expired Review before creating state or issuing an effect", async () => {
    const subject = await createSubject();
    const review = await requireReview(subject.coordinator, "connect");
    vi.setSystemTime(new Date(review.actionExpiresAt));

    await expectWalletCode(
      subject.coordinator.decide({ review, initiatedBy: "mcp_app" }),
      "wallet_operation_expired",
    );
    expect(subject.operations.read(review.operationId)).toBeNull();
    expect(subject.client.attempts).toHaveLength(0);
    expect(subject.events).not.toContain("sdk:start_connection");
  });

  it("durably creates before the external effect and makes duplicate delivery idempotent", async () => {
    const subject = await createSubject();
    const review = await requireReview(subject.coordinator, "connect");
    const started = await subject.coordinator.decide({ review, initiatedBy: "mcp_app" });
    const awaiting = await waitForState(subject.coordinator, review.operationId, "awaiting_wallet_approval");

    expect(started.state).toBe("starting_connection");
    expect(subject.events.indexOf("store:create:starting_connection"))
      .toBeLessThan(subject.events.indexOf("sdk:start_connection"));
    expect(await subject.coordinator.decide({ review, initiatedBy: "mcp_app" })).toEqual(awaiting);
    expect(subject.client.attempts).toHaveLength(1);

    const session = validSession(subject.source(topicA));
    subject.client.setObservation([session], 0);
    subject.client.attempts[0]?.settle(Object.freeze({ status: "approved", session }));
    const completed = await waitForState(subject.coordinator, review.operationId, "completed");
    expect(completed).toMatchObject({
      result: { outcome: "connected", connection: { status: "connected", address: addressA } },
    });
    expect(await subject.coordinator.get(review.operationId)).toEqual(completed);
    expect(await subject.coordinator.decide({ review, initiatedBy: "mcp_app" })).toEqual(completed);
    expect(subject.client.attempts).toHaveLength(1);
  });

  it("exposes QR only while the exact connect attempt is active and binds cancellation", async () => {
    const subject = await createSubject();
    const review = await requireReview(subject.coordinator, "connect");
    await subject.coordinator.decide({ review, initiatedBy: "cli" });
    const awaiting = await waitForState(subject.coordinator, review.operationId, "awaiting_wallet_approval");

    expect(await subject.coordinator.getPresentation(review.operationId)).toEqual({
      operation: awaiting,
      qr,
    });
    await expectWalletCode(subject.coordinator.cancel({
      operationId: review.operationId,
      reviewDigest: parseHash32(`0x${"0".repeat(64)}`),
      expectedState: "awaiting_wallet_approval",
      connectionRevision: review.precondition.connectionRevision,
    }), "state_conflict");
    expect(subject.client.attempts[0]?.cancelCount).toBe(0);

    const cancelling = await subject.coordinator.cancel({
      operationId: review.operationId,
      reviewDigest: review.reviewDigest,
      expectedState: "awaiting_wallet_approval",
      connectionRevision: review.precondition.connectionRevision,
    });
    expect(cancelling).toMatchObject({ state: "cancelling", terminationTarget: "cancelled" });
    const cancelled = await waitForState(subject.coordinator, review.operationId, "cancelled");
    expect(await subject.coordinator.getPresentation(review.operationId)).toEqual({
      operation: cancelled,
    });
    expect(subject.client.attempts[0]?.cancelCount).toBe(1);
  });

  it("reconciles a durable active operation after restart without reconstructing QR or resending", async () => {
    const events: string[] = [];
    const bootstrap = createBootstrap(events);
    const operationId = Buffer.alloc(32, 44).toString("base64url");
    const review = storedRestartReview(operationId);
    bootstrap.operations.seed(parseWalletManagementOperation({
      contractVersion: "1",
      domain: "wallet",
      operationId,
      kind: "connect",
      initiatedBy: "mcp_app",
      review,
      state: "awaiting_wallet_approval",
      terminationTarget: null,
      result: null,
      failure: null,
      peerRefusalCode: null,
    }));
    const client = new FakeWalletConnectClient(events);

    const coordinator = await createWalletCoordinator({ client, wallet: bootstrap.wallet });
    const terminal = await coordinator.get(operationId);
    expect(terminal.state).toBe("expired");
    expect(await coordinator.getPresentation(operationId)).toEqual({ operation: terminal });
    expect(client.attempts).toHaveLength(0);
    expect(events).not.toContain("sdk:start_connection");
    expect(client.containmentCount).toBe(1);
  });

  it("publishes one retryable close before client containment can reenter", async () => {
    const subject = await createSubject();
    const firstContainment = deferred<void>();
    const retryContainment = deferred<void>();
    let reenteredClose: Promise<void> | undefined;
    subject.client.onContain = () => {
      if (subject.client.containCalls === 1) {
        reenteredClose = subject.coordinator.close();
        return firstContainment.promise;
      }
      if (subject.client.containCalls === 2) return retryContainment.promise;
      throw new TypeError("Unexpected client containment attempt.");
    };

    const closing = subject.coordinator.close();

    if (reenteredClose === undefined) {
      throw new TypeError("Client containment did not reenter close synchronously.");
    }
    expect(reenteredClose).toBe(closing);
    expect(subject.client.containCalls).toBe(1);
    let closeSettled = false;
    void closing.then(
      () => { closeSettled = true; },
      () => { closeSettled = true; },
    );
    await drain();
    expect(closeSettled).toBe(false);

    const containmentFailure = new Error("client containment failed");
    let retry: Promise<void> | undefined;
    const failureObserved = closing.then(
      () => { throw new TypeError("Client containment unexpectedly succeeded."); },
      (error: unknown) => {
        expect(error).toBe(containmentFailure);
        retry = subject.coordinator.close();
      },
    );
    firstContainment.reject(containmentFailure);
    await failureObserved;

    if (retry === undefined) throw new TypeError("Coordinator close retry was not observed.");
    expect(retry).not.toBe(closing);
    expect(subject.client.containCalls).toBe(2);
    let retrySettled = false;
    void retry.then(
      () => { retrySettled = true; },
      () => { retrySettled = true; },
    );
    await drain();
    expect(retrySettled).toBe(false);

    retryContainment.resolve(undefined);
    await expect(retry).resolves.toBeUndefined();
  });

  it("keeps disconnect Review pure, then commits before one exact SDK deletion", async () => {
    const subject = await createSubject((client, source) => {
      client.setObservation([validSession(source(topicA), addressB)]);
    });
    const review = await requireReview(subject.coordinator, "disconnect");
    expect(review.fixedEvidence.sessionSourceIds).toEqual([subject.source(topicA).sourceId]);
    expect(subject.client.disconnectedSourceIds).toEqual([]);
    expect(subject.operations.read(review.operationId)).toBeNull();

    const started = await subject.coordinator.decide({ review, initiatedBy: "cli" });
    expect(started.state).toBe("disconnecting");
    const completed = await waitForState(subject.coordinator, review.operationId, "completed");
    expect(completed).toMatchObject({
      result: { outcome: "disconnected", connection: { status: "disconnected" } },
    });
    const disconnectEvent = `sdk:disconnect:${subject.source(topicA).sourceId}`;
    expect(subject.events.indexOf("store:create:disconnecting"))
      .toBeLessThan(subject.events.indexOf(disconnectEvent));
    expect(subject.client.disconnectedSourceIds).toEqual([subject.source(topicA).sourceId]);

    expect(await subject.coordinator.decide({ review, initiatedBy: "cli" })).toEqual(completed);
    expect(subject.client.disconnectedSourceIds).toEqual([subject.source(topicA).sourceId]);
  });

  it("keeps unavailable and conflicting session evidence distinct from healthy absence", async () => {
    const unavailable = await createSubject((client) => {
      client.observeError = new WalletConnectClientError("observation");
    });
    await expectWalletCode(unavailable.coordinator.review({ kind: "connect" }), "runtime_state_unavailable");

    const multiple = await createSubject((client, source) => {
      client.setObservation([
        validSession(source(topicA), addressA),
        validSession(source(topicB), addressB),
      ]);
    });
    await expectWalletCode(multiple.coordinator.review({ kind: "connect" }), "wallet_session_unusable");
    expect(multiple.client.attempts).toHaveLength(0);
  });
});
