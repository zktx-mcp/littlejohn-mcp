import {memoryWalletReviewStore} from "./review-store-fixture.js";
import {parseEvmChainId as fixtureChainId, parseEvmAccountIdentity} from "../../src/evm/identities.js";
import {walletAccountPermissions} from "../../src/wallet/account-admission.js";
import {walletBoundAccountReferenceSchema} from "../../src/wallet/bound-account-contract.js";
import {walletSelectAccountSuccessSchema, type WalletSelectAccountInput, type WalletAccountPreference} from "../../src/wallet/account-selection-contract.js";
import {parseWalletLocalRevision, nextWalletLocalRevision} from "../../src/wallet/local-revision.js";
import {WalletOperationError} from "../../src/wallet/operation-error.js";
import {walletProductRecoverySchema, walletCleanupRecoverySchema, type WalletProductRecovery, type WalletCleanupRecovery} from "../../src/wallet/authority-recovery.js";
import {isWalletOperationTerminalState} from "../../src/wallet/operation-state.js";
import { createHash } from "node:crypto";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import Database from "better-sqlite3";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {ObservationAuthorityRegistry, CapabilityRegistry, CapabilityBindingRegistry, createCanonicalClock, createCapabilityInvocationAuthority, createObservationAuthority, parseCapabilityDataAt, parseHash32, sourceReferenceSchema, type CanonicalClock, type InvocationBoundaryPorts, type UtcTimestamp} from "../../src/core/index.js";
import {parseEvmChainId} from "../../src/evm/identities.js";
import {walletConnectionCapability} from "../../src/wallet/connection-capability.js";
import {type WalletConnectionData} from "../../src/wallet/connection-contract.js";
import { createSigningCodec } from "../../src/chain/evm-standard.js";
import { SigningCoordinator } from "../../src/review/signing-coordinator.js";
import { signingCommandSchema } from "../../src/review/signing-contracts.js";
import { createRequestReviewMaterialStore } from "../../src/runtime/request-review-material.js";
import type { WalletRequestResponse } from "../../src/wallet/request-contract.js";
import { readRuntimeConfiguration } from "../../src/runtime/configuration.js";
import {ProductDatabase} from "../../src/runtime/database.js";
import {createWalletSourceAuthorityFromKey} from "../../src/runtime/source-identity.js";
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
import { WalletConnectClientError, type WalletConnectAttemptOutcome, type WalletConnectClientEvent, type WalletConnectClientPort, type WalletConnectConnectionAttemptPort, type WalletConnectSessionSnapshot, type WalletConnectStableObservation } from "../../src/wallet/client-contract.js";

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
  async startRequest(): Promise<never> { throw new Error("This management fixture does not submit transactions."); }
  hasPendingRequest(): boolean { return false; }

  proposalCount = 0;
  sessions: WalletConnectSessionSnapshot[] = [];
  revision = 0n;
  observeError: Error | undefined;
  initialObservationAvailable = true;
  availability: "acquiring" | "available" | "unavailable" = "available";
  readonly attempts: FakeConnectionAttempt[] = [];
  readonly disconnectedSourceIds: string[] = [];
  readonly events: string[];
  containmentCount = 0;
  containCalls = 0;
  onContain: (() => Promise<void>) | undefined;
  #listener: ((event: WalletConnectClientEvent) => void) | undefined;

  constructor(events: string[]) { this.events = events; }

  readObservation(): WalletConnectStableObservation {
    this.events.push("sdk:observe");
    if (this.observeError !== undefined) throw this.observeError;
    return Object.freeze({
      proposalCount: this.proposalCount,
      sessions: Object.freeze([...this.sessions]),
      revision: this.revision,
    });
  }

  async observe(): Promise<WalletConnectStableObservation> {
    if (this.availability !== "available") throw new WalletConnectClientError("observation");
    return this.readObservation();
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
      getAvailability: () => this.availability,
      initialObservation: (() => {
        if (!this.initialObservationAvailable) return Object.freeze({status: "unavailable" as const});
        try {
          return Object.freeze({ status: "available" as const, observation: this.readObservation() });
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
  readonly #operations: MemoryWalletOperationStore;
  readmissionError: Error | undefined;

  constructor(clock: CanonicalClock, operations: MemoryWalletOperationStore) {
    this.#operations = operations;
    const observedAt = clock.now();
    this.#record = Object.freeze({
      revision: "0" as never,
      connection: parseCapabilityDataAt(
        walletConnectionCapability,
        { status: "unknown", reason: "reconciling" },
        observedAt,
      ),
      productRecovery: null,
      cleanupRecovery: null,
      revalidationSourceIds: [],
      updatedAt: observedAt,
    });
  }

  #preference: WalletAccountPreference = {connectionId: null, chainId: fixtureChainId("eip155:4663"), account: null, selectionRevision: parseWalletLocalRevision("0")};
  readPreference(): WalletAccountPreference { return this.#preference; }
  selectAccount(input: WalletSelectAccountInput) {
    if (input.expectedConnectionRevision !== this.#record.revision || input.expectedSelectionRevision !== this.#preference.selectionRevision || this.#record.connection.status !== "connected" || this.#record.connection.connectionId !== input.connectionId || this.#record.productRecovery !== null || this.#record.cleanupRecovery !== null) throw new WalletOperationError("state_conflict");
    if (!walletAccountPermissions(this.#record.connection.namespaces, input.chainId).some(value => value.account.address === input.account.address)) throw new WalletOperationError("wallet_account_unavailable");
    const selectionRevision = this.#preference.account?.address === input.account.address ? this.#preference.selectionRevision : nextWalletLocalRevision(this.#preference.selectionRevision);
    this.#preference = {connectionId: input.connectionId, chainId: input.chainId, account: parseEvmAccountIdentity(input.account), selectionRevision};
    return walletSelectAccountSuccessSchema.parse({connectionId: input.connectionId, chainId: input.chainId, account: input.account, connectionRevision: this.#record.revision, selectionRevision});
  }

  read(): WalletConnectionRecord { return this.#record; }

  replace(
    expectedRevision: string,
    connection: WalletConnectionData,
    productRecoveryInput: WalletProductRecovery | null,
    cleanupRecoveryInput: WalletCleanupRecovery | null,
    updatedAt: UtcTimestamp,
    revalidationSourceIds: readonly string[],
    observedSourceIds: readonly string[] | null,
    recoveryTransition?: WalletOperationTransitionCommand,
  ): WalletConnectionRecord {
    if (expectedRevision !== this.#record.revision) throw new Error("stale projection revision");
    const productRecovery = productRecoveryInput === null ? null : walletProductRecoverySchema.parse(productRecoveryInput);
    const cleanupRecovery = cleanupRecoveryInput === null ? null : walletCleanupRecoverySchema.parse(cleanupRecoveryInput);
    const admittedConnection = parseCapabilityDataAt(walletConnectionCapability, connection, updatedAt);
    if (admittedConnection.status === "connected" && (productRecovery !== null || cleanupRecovery !== null ||
        revalidationSourceIds.includes(admittedConnection.connectionId))) throw new Error("Connected projection has closed authority.");
    if (admittedConnection.status === "connected" && observedSourceIds !== null && !observedSourceIds.includes(admittedConnection.connectionId)) {
      throw new Error("Connected source is absent from the complete observation.");
    }
    if (this.#record.productRecovery?.operationId !== null && this.#record.productRecovery?.operationId !== undefined &&
        productRecovery !== null && productRecovery.operationId !== this.#record.productRecovery.operationId) {
      throw new Error("Exact product recovery correlation cannot be replaced.");
    }
    if (recoveryTransition !== undefined && (this.#record.productRecovery === null || productRecovery !== null ||
        this.#record.productRecovery.operationId !== recoveryTransition.operationId)) throw new Error("Recovery correlation changed.");
    if (this.#record.productRecovery !== null && productRecovery === null) {
      if (observedSourceIds === null) throw new Error("Product readmission requires complete observation.");
      if (this.readmissionError !== undefined) throw this.readmissionError;
      const operationId = this.#record.productRecovery.operationId;
      if (operationId !== null) {
        const operation = this.#operations.read(operationId);
        if (operation === null) throw new Error("Exact recovery operation is missing.");
        if (isWalletOperationTerminalState(operation.state)) {
          if (recoveryTransition !== undefined) throw new Error("Terminal recovery operation cannot be rewritten.");
        } else {
          if (recoveryTransition === undefined || !isWalletOperationTerminalState(recoveryTransition.operation.state)) {
            throw new Error("Exact recovery successor is missing.");
          }
          assertWalletOperationTransition(operation as WalletNonterminalManagementOperation, recoveryTransition.operation);
        }
      }
    }
    if (this.#record.cleanupRecovery !== null && cleanupRecovery === null &&
        (observedSourceIds === null || observedSourceIds.length !== 0 || admittedConnection.status !== "disconnected")) {
      throw new Error("Cleanup recovery requires complete empty observation.");
    }
    const nextRecord = Object.freeze({
      revision: nextWalletLocalRevision(this.#record.revision) as WalletConnectionRecord["revision"],
      connection: admittedConnection,
      productRecovery,
      cleanupRecovery,
      revalidationSourceIds: [...revalidationSourceIds],
      updatedAt,
    });
    const sourceLost = this.#preference.connectionId !== null && observedSourceIds !== null && !observedSourceIds.includes(this.#preference.connectionId);
    const accountLost = this.#preference.account !== null && admittedConnection.status === "connected" &&
      (admittedConnection.connectionId !== this.#preference.connectionId || !walletAccountPermissions(admittedConnection.namespaces, this.#preference.chainId)
        .some(value => value.account.address === this.#preference.account!.address));
    const nextPreference = this.#preference.account !== null && (sourceLost || accountLost)
      ? {...this.#preference, connectionId: null, account: null, selectionRevision: nextWalletLocalRevision(this.#preference.selectionRevision)}
      : this.#preference;
    if (recoveryTransition !== undefined) {
      this.#operations.transition(recoveryTransition);
    }
    this.#record = nextRecord;
    this.#preference = nextPreference;
    return this.#record;
  }

  advanceRevision(): void {
    this.#record = Object.freeze({
      ...this.#record,
      revision: nextWalletLocalRevision(this.#record.revision) as WalletConnectionRecord["revision"],
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
  const operations = new MemoryWalletOperationStore(events);
  const projection = new MemoryWalletProjection(clock, operations);
  const invocationAuthority = createCapabilityInvocationAuthority(
    clock,
    runtimeConfiguration.chain.chainId,
  );
  const wallet: WalletOwnerBootstrapPort = Object.freeze({
    configuration: runtimeConfiguration.wallet,
    privateStoreDirectory: Object.freeze({ ensureDirectory: async () => "/unused-wallet-store" }),
    projection,
    operations,
    reviews: memoryWalletReviewStore(),
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
): Extract<WalletConnectSessionSnapshot, { readonly status: "valid" }> => Object.freeze({
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
  const coordinator = await createWalletCoordinator({lifecycleSignal: new AbortController().signal, client, wallet: bootstrap.wallet });
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

const disconnectIds = (review: WalletReview): string[] => {
  if (review.kind !== "disconnect" || review.precondition.targetSet.kind !== "inline") throw new Error("Inline disconnect fixture required.");
  return review.precondition.targetSet.targets.map(value => value.sourceId);
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
      optionalMethods: ["personal_sign", "eth_signTypedData_v4"] as const,
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

  it("preserves inherited approval across acquiring reads, the original deadline and ready partial admission", async () => {
    const events: string[] = [];
    const bootstrap = createBootstrap(events);
    const operationId = Buffer.alloc(32, 61).toString("base64url");
    const review = storedRestartReview(operationId);
    const predecessor = parseWalletManagementOperation({contractVersion: "1", domain: "wallet", kind: "connect",
      operationId, initiatedBy: "cli", review, state: "validating_session", terminationTarget: null,
      result: null, failure: null, peerRefusalCode: null});
    bootstrap.operations.seed(predecessor);
    const client = new FakeWalletConnectClient(events);
    client.initialObservationAvailable = false;
    client.availability = "acquiring";
    const coordinator = await createWalletCoordinator({client, wallet: bootstrap.wallet, lifecycleSignal: new AbortController().signal});
    try {
      vi.setSystemTime(new Date("2026-07-14T00:06:00.000Z"));
      await vi.advanceTimersByTimeAsync(0);
      expect(await coordinator.get(operationId)).toEqual(predecessor);
      expect((await coordinator.activeWallet.capture()).connection.status).toBe("unknown");
      expect(bootstrap.operations.read(operationId)).toEqual(predecessor);
      expect(client.attempts).toEqual([]);
      expect(client.containmentCount).toBe(0);
      const approved = validSession(bootstrap.createSessionSource(topicA));
      client.setObservation([{...approved, namespaces: {eip155: {...approved.namespaces["eip155"]!, methods: ["personal_sign"]}}}]);
      client.availability = "available";
      client.emit({kind: "identity_unattributed"});
      expect(await coordinator.get(operationId)).toMatchObject({state: "failed", failure: {error: {code: "wallet_session_unusable"}}});
      expect(bootstrap.projection.read()).toMatchObject({connection: {status: "connected"}, productRecovery: null, cleanupRecovery: null});
      expect(events).not.toContain("store:transition:validating_session->cancelling");
      expect(client.disconnectedSourceIds).toEqual([]);
    } finally {await coordinator.close();}
  });

  it.each(["empty", "matching", "partial"] as const)("admits inherited exact cancellation and owns the %s postcondition", async (scope) => {
    const events: string[] = [];
    const bootstrap = createBootstrap(events);
    const operationId = Buffer.alloc(32, 62).toString("base64url");
    const review = storedRestartReview(operationId);
    bootstrap.operations.seed(parseWalletManagementOperation({contractVersion: "1", domain: "wallet", kind: "connect",
      operationId, initiatedBy: "cli", review, state: "awaiting_wallet_approval", terminationTarget: null,
      result: null, failure: null, peerRefusalCode: null}));
    const client = new FakeWalletConnectClient(events);
    client.initialObservationAvailable = false;
    client.availability = "acquiring";
    const coordinator = await createWalletCoordinator({client, wallet: bootstrap.wallet, lifecycleSignal: new AbortController().signal});
    try {
      const cancelled = await coordinator.cancel({operationId, reviewDigest: review.reviewDigest,
        expectedState: "awaiting_wallet_approval", connectionRevision: review.precondition.connectionRevision});
      expect(cancelled).toMatchObject({state: "cancelling", terminationTarget: "cancelled"});
      expect(client.attempts).toEqual([]);
      expect(client.disconnectedSourceIds).toEqual([]);
      expect(client.containmentCount).toBe(0);
      const approved = validSession(bootstrap.createSessionSource(topicA));
      client.setObservation(scope === "empty" ? [] : scope === "matching" ? [approved] :
        [{...approved, namespaces: {eip155: {...approved.namespaces["eip155"]!, methods: ["personal_sign"]}}}]);
      client.availability = "available";
      client.emit({kind: "observation_changed"});
      const terminal = await coordinator.get(operationId);
      expect(terminal.state).toBe(scope === "partial" ? "failed" : "cancelled");
      expect(client.disconnectedSourceIds).toEqual(scope === "matching" ? [approved.source.sourceId] : []);
      expect(client.containmentCount).toBe(1);
      expect(bootstrap.projection.read().cleanupRecovery).toEqual(scope === "partial" ? {kind: "management", operationId} : null);
      expect(client.attempts).toEqual([]);
    } finally {await coordinator.close();}
  });

  it("prioritizes Runtime signal abort over the earlier client containment wake before close", async () => {
    const events: string[] = [];
    const bootstrap = createBootstrap(events);
    const operationId = Buffer.alloc(32, 63).toString("base64url");
    const review = storedRestartReview(operationId);
    const predecessor = parseWalletManagementOperation({contractVersion: "1", domain: "wallet", kind: "connect",
      operationId, initiatedBy: "cli", review, state: "validating_session", terminationTarget: null,
      result: null, failure: null, peerRefusalCode: null});
    bootstrap.operations.seed(predecessor);
    const client = new FakeWalletConnectClient(events);
    client.initialObservationAvailable = false;
    client.availability = "acquiring";
    const runtime = new AbortController();
    runtime.signal.addEventListener("abort", () => {
      client.availability = "unavailable";
      client.emit({kind: "identity_unattributed"});
    }, {once: true});
    const coordinator = await createWalletCoordinator({client, wallet: bootstrap.wallet, lifecycleSignal: runtime.signal});
    runtime.abort();
    await drain();
    expect(bootstrap.operations.read(operationId)).toEqual(predecessor);
    expect(bootstrap.projection.read()).toMatchObject({productRecovery: null, cleanupRecovery: null});
    await coordinator.close();
    expect(bootstrap.operations.read(operationId)).toEqual(predecessor);
    expect(client.attempts).toEqual([]);
  });

  it.each(["scheduled", "observing"] as const)("removes the %s session-expiry wake on Runtime abort while close is delayed", async (phase) => {
    const events: string[] = [];
    const bootstrap = createBootstrap(events);
    const client = new FakeWalletConnectClient(events);
    const session = {...validSession(bootstrap.createSessionSource(topicA)), expiry: (Date.now() + 1_000) / 1_000};
    client.setObservation([session]);
    const runtime = new AbortController();
    const initialTimers = vi.getTimerCount();
    const coordinator = await createWalletCoordinator({client, wallet: bootstrap.wallet, lifecycleSignal: runtime.signal});
    const published = bootstrap.projection.read();
    const observation = deferred<WalletConnectStableObservation>();
    let observing = false;
    client.observe = async () => {observing = true; return observation.promise;};
    try {
      expect(published.connection.status).toBe("connected");
      expect(vi.getTimerCount()).toBe(initialTimers + 1);
      if (phase === "observing") {
        vi.advanceTimersToNextTimer();
        await drain();
        expect(observing).toBe(true);
      }
      runtime.abort();
      expect(vi.getTimerCount()).toBe(initialTimers);
      observation.resolve({proposalCount: 0, sessions: [session], revision: 1n});
      await drain();
      // A pre-abort callback's finally must not schedule another already-expired wake.
      expect(vi.getTimerCount()).toBe(initialTimers);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(vi.getTimerCount()).toBe(initialTimers);
      expect(observing).toBe(phase === "observing");
      expect(bootstrap.projection.read()).toEqual(published);
      expect(client.disconnectedSourceIds).toEqual([]);
      expect(client.containmentCount).toBe(0);
      expect(client.containCalls).toBe(0);
    } finally {
      observation.resolve({proposalCount: 0, sessions: [session], revision: 1n});
      await coordinator.close();
    }
  });

  it("joins startup demands, rejects the stale full reply and consumes the current partial facts", async () => {
    const events: string[] = [];
    const bootstrap = createBootstrap(events);
    const operationId = Buffer.alloc(32, 64).toString("base64url");
    const review = storedRestartReview(operationId);
    bootstrap.operations.seed(parseWalletManagementOperation({contractVersion: "1", domain: "wallet", kind: "connect",
      operationId, initiatedBy: "cli", review, state: "validating_session", terminationTarget: null,
      result: null, failure: null, peerRefusalCode: null}));
    const client = new FakeWalletConnectClient(events);
    client.initialObservationAvailable = false;
    client.availability = "acquiring";
    const coordinator = await createWalletCoordinator({client, wallet: bootstrap.wallet, lifecycleSignal: new AbortController().signal});
    const first = deferred<WalletConnectStableObservation>();
    const approved = validSession(bootstrap.createSessionSource(topicA));
    const oldReply = {proposalCount: 0, sessions: [approved], revision: 1n};
    let reads = 0;
    client.observe = async () => ++reads === 1 ? first.promise : client.readObservation();
    try {
      client.availability = "available";
      client.setObservation([approved]);
      const exact = coordinator.get(operationId);
      const presentation = coordinator.getPresentation(operationId);
      await drain();
      expect(reads).toBe(1);
      client.setObservation([{...approved, namespaces: {eip155: {...approved.namespaces["eip155"]!, methods: ["personal_sign"]}}}]);
      client.emit({kind: "observation_changed"});
      first.resolve(oldReply);
      expect(await exact).toMatchObject({state: "failed", failure: {error: {code: "wallet_session_unusable"}}});
      expect(await presentation).toMatchObject({operation: {state: "failed"}});
      expect(reads).toBe(2);
      expect(bootstrap.projection.read()).toMatchObject({connection: {status: "connected"}, productRecovery: null, cleanupRecovery: null});
      expect(client.attempts).toEqual([]);
      expect(client.containmentCount).toBe(0);
    } finally {first.resolve(oldReply); await coordinator.close();}
  });

  it("keeps execution closed when a public capture publishes healthy facts before inherited readmission settles", async () => {
    const events: string[] = [];
    const bootstrap = createBootstrap(events);
    const operationId = Buffer.alloc(32, 65).toString("base64url");
    const review = storedRestartReview(operationId);
    const initial = bootstrap.projection.read();
    const clean = bootstrap.projection.replace(initial.revision, {status: "disconnected", reason: "no_session"},
      null, null, bootstrap.wallet.capabilityAuthority.clock.now(), [], null);
    expect(clean).toMatchObject({revision: "1", connection: {status: "disconnected", reason: "no_session"},
      productRecovery: null, cleanupRecovery: null});
    expect(review).toMatchObject({precondition: {connectionRevision: "1", connection: {status: "disconnected", reason: "no_session"}}});
    bootstrap.operations.seed(parseWalletManagementOperation({contractVersion: "1", domain: "wallet", kind: "connect",
      operationId, initiatedBy: "cli", review, state: "validating_session", terminationTarget: null,
      result: null, failure: null, peerRefusalCode: null}));
    const client = new FakeWalletConnectClient(events);
    client.initialObservationAvailable = false;
    client.availability = "acquiring";
    const coordinator = await createWalletCoordinator({client, wallet: bootstrap.wallet, lifecycleSignal: new AbortController().signal});
    const first = deferred<WalletConnectStableObservation>();
    const current = deferred<WalletConnectStableObservation>();
    const approved = validSession(bootstrap.createSessionSource(topicA));
    client.setObservation([approved]);
    let reads = 0;
    client.observe = async () => {
      reads += 1;
      return reads === 1 ? first.promise : reads === 4 ? current.promise : client.readObservation();
    };
    try {
      client.availability = "available";
      const exact = coordinator.get(operationId);
      await drain();
      expect((await coordinator.activeWallet.capture()).connection.status).toBe("unknown");
      expect(bootstrap.projection.read().connection.status).toBe("connected");
      expect(bootstrap.operations.read(operationId)?.state).toBe("validating_session");
      await expectWalletCode(coordinator.activeWallet.resolveAccount({chainId: parseEvmChainId("eip155:4663"), requiredMethods: []}), "runtime_state_unavailable");
      expect(client.attempts).toEqual([]);
      expect(client.disconnectedSourceIds).toEqual([]);
      expect(client.containmentCount).toBe(0);
      first.resolve({proposalCount: 0, sessions: [approved], revision: 1n});
      await drain();
      expect(reads).toBe(4);
      const reference = walletBoundAccountReferenceSchema.parse({connectionId: approved.source.sourceId,
        account: {chainId: "eip155:4663", address: addressA}, requiredMethods: ["eth_sendTransaction"],
        permissionRevision: bootstrap.projection.read().revision});
      // The wake has been consumed and every bound fact is valid; only inherited execution remains closed.
      expect(() => coordinator.activeWallet.assertBoundAccountCurrent(reference)).toThrowError(WalletOperationError);
      current.resolve({proposalCount: 0, sessions: [approved], revision: 1n});
      expect((await exact).state).toBe("completed");
      expect(() => coordinator.activeWallet.assertBoundAccountCurrent(reference)).not.toThrow();
    } finally {
      first.resolve({proposalCount: 0, sessions: [approved], revision: 1n});
      current.resolve({proposalCount: 0, sessions: [approved], revision: 1n});
      await coordinator.close();
    }
  });

  it.each(["same_chain", "same_account", "changed_chain", "changed_account"] as const)(
    "reconciles %s before the signing consumer receives a same-turn result", async (kind) => {
      const subject = await createSubject((client, source) => {
        const value = validSession(source(topicA));
        client.setObservation([{ ...value, namespaces: { eip155: {
          ...value.namespaces["eip155"]!, methods: ["eth_sendTransaction", "personal_sign"],
        } } }]);
      });
      const clock = createCanonicalClock(() => new Date(Date.now()).toISOString());
      const materials = createRequestReviewMaterialStore(clock);
      const response = deferred<WalletRequestResponse>();
      const sent = deferred<void>();
      const startRequest = vi.fn(async () => { sent.resolve(); return { response: response.promise, settlement: response.promise }; });
      const signing = new SigningCoordinator({ clock, materials, codec: createSigningCodec(),
        activeWallet: subject.coordinator.activeWallet, wallet: { hasPendingRequest: () => false, startRequest } });
      try {
        const signal = new AbortController().signal;
        const review = await signing.start(signingCommandSchema.parse({ account: { kind: "active_wallet" },
          payload: { kind: "personal", encoding: "utf8", value: "Synthetic identity-event handoff check" } }), signal);
        const result = signing.confirm({ review, initiatedBy: "cli" }, signal);
        await sent.promise;
        const chainId = parseEvmChainId("eip155:4663");
        const sessionSourceId = subject.source(topicA).sourceId;
        subject.client.emit(kind === "same_chain" || kind === "changed_chain"
          ? { kind: "chain_changed", sessionSourceId,
            chainId: kind === "same_chain" ? chainId : parseEvmChainId("eip155:1") }
          : { kind: "accounts_changed", sessionSourceId, chainId,
            accounts: [`${chainId}:${kind === "same_account" ? addressA : addressB}`] });
        response.resolve({ status: "wallet_rejected" });
        // A normal callback is a hint; the complete SDK observation still admits the original actor.
        expect(await result).toMatchObject({ outcome: {status: "wallet_rejected"} });
        expect(await result).not.toHaveProperty("signature");
        expect(startRequest).toHaveBeenCalledOnce();
        expect(subject.projection.read()).toMatchObject({productRecovery: null, cleanupRecovery: null});
        expect(subject.projection.read().revalidationSourceIds).toEqual([]);
        expect((await subject.coordinator.activeWallet.capture()).connection.status).toBe("connected");
      } finally {
        response.resolve({ status: "wallet_rejected" });
        await signing.close();
        materials.close();
        await subject.coordinator.close();
      }
    },
  );

  it("keeps expiry cleanup with the owner when a public observation crosses the expiry boundary", async () => {
    const subject = await createSubject((client, source) => client.setObservation([{
      ...validSession(source(topicA)), expiry: Date.parse(initialTime) / 1_000 + 1,
    }]));
    const observation = deferred<WalletConnectStableObservation>();
    vi.spyOn(subject.client, "observe").mockReturnValueOnce(observation.promise);
    try {
      const capture = subject.coordinator.activeWallet.capture();
      await drain();
      vi.setSystemTime(new Date(Date.parse(initialTime) + 1_000));
      observation.resolve(subject.client.readObservation());
      expect((await capture).connection.status).toBe("unresolved");
      expect(subject.client.disconnectedSourceIds).toEqual([]);
      expect(subject.client.attempts).toHaveLength(0);
      expect(subject.projection.read()).toMatchObject({productRecovery: null, cleanupRecovery: null});
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(subject.client.disconnectedSourceIds).toEqual([subject.source(topicA).sourceId]);
      expect(subject.projection.read().connection).toEqual({status: "disconnected", reason: "expired"});
      vi.setSystemTime(new Date(initialTime));
      await expect(subject.coordinator.activeWallet.capture()).rejects.toThrow("Canonical clock moved backwards");
    } finally {
      observation.resolve(subject.client.readObservation());
      await subject.coordinator.close();
    }
  });

  it("settles session expiry without a read and rearms for a session extension", async () => {
    const subject = await createSubject((client, source) => client.setObservation([{
      ...validSession(source(topicA)), expiry: Date.parse(initialTime) / 1_000 + 2,
    }]));
    subject.client.setObservation([{ ...validSession(subject.source(topicA)),
      expiry: Date.parse(initialTime) / 1_000 + 4 }]);
    subject.client.emit({ kind: "observation_changed" });
    await drain();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(subject.client.disconnectedSourceIds).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(subject.client.disconnectedSourceIds).toEqual([subject.source(topicA).sourceId]);
    expect(subject.projection.read().connection).toEqual({ status: "disconnected", reason: "expired" });
    await subject.coordinator.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not let transient captures poison a connection as its effect completes", async () => {
    const subject = await createSubject();
    const review = await requireReview(subject.coordinator, "connect");
    await subject.coordinator.decide({ review, initiatedBy: "cli" });
    await waitForState(subject.coordinator, review.operationId, "awaiting_wallet_approval");
    const session = validSession(subject.source(topicA));
    subject.client.setObservation([session]);
    subject.client.attempts[0]!.settle({ status: "approved", session });
    for (let turn = 0; turn < 24; turn += 1) {
      await Promise.resolve();
      (await subject.coordinator.activeWallet.capture());
    }
    await waitForState(subject.coordinator, review.operationId, "completed");
    expect((await subject.coordinator.activeWallet.capture()).connection.status).toBe("connected");
    await subject.coordinator.close();
  });

  it("keeps authority closed while expiry cleanup settles and never repeats that effect", async () => {
    const subject = await createSubject((client, source) => client.setObservation([{
      ...validSession(source(topicA)), expiry: Date.parse(initialTime) / 1_000 + 1,
    }]));
    const settlement = deferred<void>();
    const disconnect = vi.spyOn(subject.client, "disconnectSession").mockImplementation(async () => {
      await settlement.promise;
      subject.client.setObservation([]);
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect((await subject.coordinator.activeWallet.capture()).connection.status).toBe("unknown");
    subject.client.emit({ kind: "observation_changed" });
    await drain();
    expect(disconnect).toHaveBeenCalledTimes(1);
    settlement.resolve();
    await drain();
    expect(subject.projection.read().connection).toEqual({ status: "disconnected", reason: "expired" });
    await subject.coordinator.close();
  });

  it("retains an expiry cleanup cause when the SDK resolves but a healthy session remains", async () => {
    const subject = await createSubject((client, source) => client.setObservation([{
      ...validSession(source(topicA)), expiry: Date.parse(initialTime) / 1_000 + 1,
    }]));
    const settlement = deferred<void>();
    const disconnect = vi.spyOn(subject.client, "disconnectSession").mockReturnValue(settlement.promise);
    const sourceId = subject.source(topicA).sourceId;
    try {
      expect(subject.projection.read().cleanupRecovery).toBeNull();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(disconnect).toHaveBeenCalledExactlyOnceWith(sourceId);
      subject.client.setObservation([validSession(subject.source(topicB), addressB)]);
      settlement.resolve(undefined);
      await drain();
      expect(subject.projection.read()).toMatchObject({productRecovery: null,
        cleanupRecovery: {kind: "expiry", sourceId}});
      await expectWalletCode(subject.coordinator.activeWallet.resolveAccount({chainId: parseEvmChainId("eip155:4663"), requiredMethods: []}),
        "runtime_state_unavailable");
      expect(subject.projection.read().connection).toEqual({status: "unresolved", sessionCount: "1"});

      const healthy = validSession(subject.source(topicB), addressB);
      subject.client.setObservation([{...healthy, expiry: healthy.expiry + 1}]);
      subject.client.emit({kind: "identity_unattributed"});
      await drain();
      expect(subject.projection.read().cleanupRecovery).toEqual({kind: "expiry", sourceId});
      subject.client.setObservation([], 1);
      subject.client.emit({kind: "observation_changed"});
      await drain();
      expect(subject.projection.read().cleanupRecovery).toEqual({kind: "expiry", sourceId});
      subject.client.setObservation([]);
      subject.client.emit({kind: "observation_changed"});
      await drain();
      expect(subject.projection.read()).toMatchObject({productRecovery: null, cleanupRecovery: null,
        connection: {status: "disconnected"}});
      expect(disconnect).toHaveBeenCalledOnce();
      expect(subject.client.attempts).toHaveLength(0);
    } finally {
      settlement.resolve(undefined);
      await drain();
      await subject.coordinator.close();
    }
  });

  it("records an expiry cleanup cause after a failed write before empty readmission clears it", async () => {
    const subject = await createSubject((client, source) => client.setObservation([{
      ...validSession(source(topicA)), expiry: Date.parse(initialTime) / 1_000 + 1,
    }]));
    const settlement = deferred<void>();
    const disconnect = vi.spyOn(subject.client, "disconnectSession").mockReturnValue(settlement.promise);
    const replace = subject.projection.replace.bind(subject.projection);
    let refuseCause = true;
    const publications: Array<Readonly<{product: WalletProductRecovery | null; cleanup: WalletCleanupRecovery | null}>> = [];
    vi.spyOn(subject.projection, "replace").mockImplementation((...args) => {
      if (refuseCause && args[3] !== null) throw new Error("Cleanup cause publication is unavailable.");
      const record = replace(...args);
      publications.push({product: record.productRecovery, cleanup: record.cleanupRecovery});
      return record;
    });
    const sourceId = subject.source(topicA).sourceId;
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      subject.client.setObservation([validSession(subject.source(topicB), addressB)]);
      settlement.resolve(undefined);
      await drain();
      expect(subject.projection.read().cleanupRecovery).toBeNull();
      await expectWalletCode(subject.coordinator.activeWallet.resolveAccount({chainId: parseEvmChainId("eip155:4663"), requiredMethods: []}),
        "runtime_state_unavailable");
      const recorded = publications.length;
      subject.client.setObservation([]);
      refuseCause = false;
      subject.client.emit({kind: "observation_changed"});
      await drain();
      expect(publications.slice(recorded)).toEqual([
        {product: {operationId: null}, cleanup: {kind: "expiry", sourceId}},
        {product: null, cleanup: null},
      ]);
      expect(subject.projection.read()).toMatchObject({productRecovery: null, cleanupRecovery: null,
        connection: {status: "disconnected"}});
      expect(disconnect).toHaveBeenCalledOnce();
      expect(subject.client.attempts).toHaveLength(0);
    } finally {
      refuseCause = false;
      settlement.resolve(undefined);
      await drain();
      await subject.coordinator.close();
    }
  });

  it("schedules a distant session expiry in supported timer slices without expiring early", async () => {
    const expiry = Math.ceil((Date.parse(initialTime) + 2_147_483_647 + 2_000) / 1_000);
    const subject = await createSubject((client, source) => client.setObservation([{
      ...validSession(source(topicA)), expiry,
    }]));
    await vi.advanceTimersByTimeAsync(2_147_483_647);
    expect(subject.client.disconnectedSourceIds).toEqual([]);
    await vi.advanceTimersByTimeAsync(expiry * 1_000 - Date.now());
    expect(subject.client.disconnectedSourceIds).toEqual([subject.source(topicA).sourceId]);
    await subject.coordinator.close();
  });

  it.each(["multiple", "revalidation"] as const)(
    "keeps a healthy %s observation available without granting an active wallet",
    async (kind) => {
      const subject = await createSubject((client, source) => client.setObservation([validSession(source(topicA))]));
      if (kind === "multiple") {
        subject.client.setObservation([validSession(subject.source(topicA)), validSession(subject.source(topicB))]);
        subject.client.emit({ kind: "observation_changed" });
      } else {
        subject.client.emit({ kind: "identity_invalid", sessionSourceId: subject.source(topicA).sourceId });
      }
      await drain();
      const before = subject.projection.read();
      expect(before.connection.status).toBe("unresolved");
      vi.setSystemTime(new Date("2026-07-15T00:00:00.000Z"));
      subject.events.length = 0;
      const writes = vi.spyOn(subject.projection, "replace");
      expect((await subject.coordinator.activeWallet.capture()).connection.status).toBe("unresolved");
      const bindings = new CapabilityBindingRegistry(new CapabilityRegistry([walletConnectionCapability]),
        [subject.coordinator.walletConnection.connection]);
      expect(await bindings.invoke(walletConnectionCapability, {}, { signal: new AbortController().signal }))
        .toMatchObject({ ok: true, data: before.connection });
      expect(subject.events.filter((event) => event !== "sdk:observe")).toEqual([]);
      expect(writes).not.toHaveBeenCalled();
      await subject.coordinator.close();
    },
  );

  it("resolves zero, one and multiple eligible accounts without hiding the complete observed connection", async () => {
    for (const accounts of [[], [`eip155:4663:${addressA}`], [`eip155:4663:${addressA}`, `eip155:4663:${addressB}`]]) {
      const subject = await createSubject((client, source) => {const session = validSession(source(topicA)); client.setObservation([{...session,
        namespaces: {eip155: {...session.namespaces["eip155"]!, accounts, methods: []}}}]);});
      try {
        const chainId = parseEvmChainId("eip155:4663"); const state = await subject.coordinator.getAccountSelection({chainId});
        expect(state.eligibleAccounts.map(value => value.address)).toEqual(accounts.map(value => value.split(":")[2]));
        expect(state.account?.address ?? null).toBe(accounts.length === 1 ? addressA : null);
        expect(subject.projection.readPreference().selectionRevision).toBe("0");
        expect((await subject.coordinator.activeWallet.capture()).connection).toMatchObject({status: "connected", namespaces: [{accounts}]});
        if (accounts.length === 1) expect((await subject.coordinator.activeWallet.resolveAccount({chainId, requiredMethods: []})).account.address).toBe(addressA);
        else await expectWalletCode(subject.coordinator.activeWallet.resolveAccount({chainId, requiredMethods: []}), accounts.length === 0 ? "wallet_account_unavailable" : "wallet_account_selection_required");
        await expectWalletCode(subject.coordinator.activeWallet.resolveAccount({chainId, requiredMethods: ["eth_sendTransaction"]}), "wallet_account_unavailable");
        const binding = subject.coordinator.walletConnection.connection;
        const registry = new CapabilityBindingRegistry(new CapabilityRegistry([walletConnectionCapability]), [binding]);
        expect(await registry.invoke(walletConnectionCapability, {}, {signal: new AbortController().signal})).toMatchObject({ok: true, data: {status: "connected", namespaces: [{accounts}]}});
      } finally {await subject.coordinator.close();}
    }
  });

  it("classifies known expiry as disconnected before any selection mutation", async () => {
    const subject = await createSubject((client, source) => client.setObservation([validSession(source(topicA))]));
    try {
      const chainId = parseEvmChainId("eip155:4663"); const prior = await subject.coordinator.getAccountSelection({chainId});
      const select = vi.spyOn(subject.projection, "selectAccount");
      vi.setSystemTime(new Date("2026-07-15T00:00:00.000Z"));
      await expectWalletCode(subject.coordinator.getAccountSelection({chainId}), "wallet_not_connected");
      await expectWalletCode(subject.coordinator.selectAccount({connectionId: prior.connectionId, chainId, account: prior.eligibleAccounts[0]!,
        expectedConnectionRevision: prior.connectionRevision, expectedSelectionRevision: prior.selectionRevision}), "wallet_not_connected");
      expect(select).not.toHaveBeenCalled(); expect(subject.projection.readPreference().selectionRevision).toBe("0");
    } finally {await subject.coordinator.close();}
  });

  it("keeps correlated malformed-source selection distinct from transient unknown observation", async () => {
    for (const reason of ["malformed", "unknown"] as const) {
      const subject = await createSubject((client, source) => client.setObservation([validSession(source(topicA))]));
      try {
        const chainId = parseEvmChainId("eip155:4663"); const prior = await subject.coordinator.getAccountSelection({chainId});
        const select = vi.spyOn(subject.projection, "selectAccount");
        if (reason === "malformed") subject.client.emit({kind: "identity_invalid", sessionSourceId: subject.source(topicA).sourceId});
        else {subject.client.observeError = new WalletConnectClientError("observation"); subject.client.emit({kind: "observation_changed"});}
        await drain();
        const code = reason === "malformed" ? "wallet_session_unusable" : "runtime_state_unavailable";
        await expectWalletCode(subject.coordinator.getAccountSelection({chainId}), code);
        await expectWalletCode(subject.coordinator.selectAccount({connectionId: prior.connectionId, chainId, account: prior.eligibleAccounts[0]!,
          expectedConnectionRevision: prior.connectionRevision, expectedSelectionRevision: prior.selectionRevision}), code);
        expect(select).not.toHaveBeenCalled(); expect(subject.projection.readPreference().selectionRevision).toBe("0");
        expect(subject.projection.read()).toMatchObject({productRecovery: null, cleanupRecovery: null});
        expect(subject.projection.read().revalidationSourceIds).toEqual(reason === "malformed" ? [subject.source(topicA).sourceId] : []);
      } finally {await subject.coordinator.close();}
    }
  });

  it("combines base and exact-chain grants while retaining accounts lacking a required method", async () => {
    const subject = await createSubject((client, source) => {const session = validSession(source(topicA)); client.setObservation([{...session, namespaces: {
      eip155: {accounts: [`eip155:4663:${addressA}`, `eip155:4663:${addressB}`], methods: ["personal_sign"], events: []},
      "eip155:4663": {accounts: [`eip155:4663:${addressA}`], methods: ["eth_sendTransaction"], events: []},
      "eip155:1": {accounts: [`eip155:1:${addressA}`], methods: ["eth_signTypedData_v4"], events: []},
    }}]);});
    try {
      const chainId = parseEvmChainId("eip155:4663");
      const actor = await subject.coordinator.activeWallet.resolveAccount({chainId, requiredMethods: ["eth_sendTransaction", "personal_sign"]});
      expect(actor.account.address).toBe(addressA); expect(actor.permission.requiredMethods).toEqual(["eth_sendTransaction", "personal_sign"]);
      await expectWalletCode(subject.coordinator.activeWallet.resolveAccount({chainId, requiredMethods: ["eth_signTypedData_v4"]}), "wallet_account_unavailable");
      const state = await subject.coordinator.getAccountSelection({chainId}); expect(state.eligibleAccounts.map(value => value.address)).toEqual([addressA, addressB]);
      await subject.coordinator.selectAccount({connectionId: state.connectionId, chainId, account: parseEvmAccountIdentity({chainId, address: addressB}),
        expectedConnectionRevision: state.connectionRevision, expectedSelectionRevision: state.selectionRevision});
      expect((await subject.coordinator.activeWallet.resolveAccount({chainId, requiredMethods: ["personal_sign"]})).account.address).toBe(addressB);
      expect((await subject.coordinator.activeWallet.resolveAccount({chainId, requiredMethods: ["eth_sendTransaction"]})).account.address).toBe(addressA);
    } finally {await subject.coordinator.close();}
  });

  it("keeps an existing actor bound across preference changes and unrelated account changes, then rejects removal and readdition", async () => {
    const values = (source: WalletSessionSource, addresses: string[]) => {const session = validSession(source); return {...session,
      namespaces: {eip155: {...session.namespaces["eip155"]!, accounts: addresses.map(address => `eip155:4663:${address}`)}}};};
    const subject = await createSubject((client, source) => client.setObservation([values(source(topicA), [addressA])]));
    try {
      const chainId = parseEvmChainId("eip155:4663"); const original = await subject.coordinator.activeWallet.resolveAccount({chainId, requiredMethods: ["eth_sendTransaction"]});
      subject.client.setObservation([values(subject.source(topicA), [addressA, addressB])]); subject.client.emit({kind: "observation_changed"}); await drain();
      const state = await subject.coordinator.getAccountSelection({chainId});
      const selected = await subject.coordinator.selectAccount({connectionId: state.connectionId, chainId, account: parseEvmAccountIdentity({chainId, address: addressB}),
        expectedConnectionRevision: state.connectionRevision, expectedSelectionRevision: state.selectionRevision});
      expect(selected.connectionRevision).toBe(state.connectionRevision);
      expect((await subject.coordinator.activeWallet.resolveAccount({chainId, requiredMethods: ["eth_sendTransaction"]})).account.address).toBe(addressB);
      expect((await subject.coordinator.activeWallet.validateBoundAccount(original.permission)).account.address).toBe(addressA);
      expect(() => subject.coordinator.activeWallet.assertBoundAccountCurrent(original.permission)).not.toThrow();
      subject.client.setObservation([values(subject.source(topicA), [addressB])]); subject.client.emit({kind: "observation_changed"}); await drain();
      await expectWalletCode(subject.coordinator.activeWallet.validateBoundAccount(original.permission), "wallet_session_unusable");
      subject.client.setObservation([values(subject.source(topicA), [addressA, addressB])]); subject.client.emit({kind: "observation_changed"}); await drain();
      await expectWalletCode(subject.coordinator.activeWallet.validateBoundAccount(original.permission), "wallet_session_unusable");
      expect(subject.client.attempts).toHaveLength(0); expect(subject.client.disconnectedSourceIds).toEqual([]);
    } finally {await subject.coordinator.close();}
  });

  it("latches only the malformed correlated source and admits a different healthy source after confirmed loss", async () => {
    const subject = await createSubject((client, source) => client.setObservation([validSession(source(topicA))]));
    try {
      const chainId = parseEvmChainId("eip155:4663"); const original = await subject.coordinator.activeWallet.resolveAccount({chainId, requiredMethods: []});
      subject.client.emit({kind: "identity_invalid", sessionSourceId: subject.source(topicA).sourceId}); await drain();
      expect(subject.projection.read()).toMatchObject({productRecovery: null, cleanupRecovery: null, revalidationSourceIds: [subject.source(topicA).sourceId], connection: {status: "unresolved"}});
      await expectWalletCode(subject.coordinator.activeWallet.validateBoundAccount(original.permission), "wallet_session_unusable");
      subject.client.setObservation([validSession(subject.source(topicB), addressB)]); subject.client.emit({kind: "observation_changed"}); await drain();
      const current = await subject.coordinator.activeWallet.resolveAccount({chainId, requiredMethods: []}); expect(current.account.address).toBe(addressB);
      expect(subject.projection.read().revalidationSourceIds).toEqual([]);
      await expectWalletCode(subject.coordinator.activeWallet.validateBoundAccount(original.permission), "wallet_session_unusable");
      subject.client.emit({kind: "identity_invalid", sessionSourceId: subject.source(topicA).sourceId}); await drain();
      expect((await subject.coordinator.activeWallet.resolveAccount({chainId, requiredMethods: []})).account.address).toBe(addressB);
      expect(subject.projection.read().revalidationSourceIds).toEqual([]);
    } finally {await subject.coordinator.close();}
  });

  it("retires an absent source and its preference even while a proposal keeps the public state unknown", async () => {
    const sessionFor = (source: WalletSessionSource) => {
      const session = validSession(source);
      return {...session, namespaces: {eip155: {...session.namespaces["eip155"]!,
        accounts: [`eip155:4663:${addressA}`, `eip155:4663:${addressB}`]}}};
    };
    const subject = await createSubject((client, source) => client.setObservation([sessionFor(source(topicA))]));
    try {
      const chainId = parseEvmChainId("eip155:4663");
      const selection = await subject.coordinator.getAccountSelection({chainId});
      await subject.coordinator.selectAccount({connectionId: selection.connectionId, chainId,
        account: parseEvmAccountIdentity({chainId, address: addressA}),
        expectedConnectionRevision: selection.connectionRevision, expectedSelectionRevision: selection.selectionRevision});
      const actor = await subject.coordinator.activeWallet.resolveAccount({chainId, requiredMethods: ["eth_sendTransaction"]});
      const preference = subject.projection.readPreference();
      subject.client.observeError = new WalletConnectClientError("observation");
      subject.client.emit({kind: "observation_changed"});
      await drain();
      await expectWalletCode(subject.coordinator.getAccountSelection({chainId}), "runtime_state_unavailable");
      expect(subject.projection.readPreference()).toEqual(preference);
      subject.client.observeError = undefined;
      subject.client.emit({kind: "observation_changed"});
      await drain();
      expect((await subject.coordinator.activeWallet.validateBoundAccount(actor.permission)).account.address).toBe(addressA);

      subject.client.setObservation([], 1);
      subject.client.emit({kind: "observation_changed"});
      await drain();
      expect(subject.projection.read().connection).toEqual({status: "unknown", reason: "reconciling"});
      expect(subject.projection.readPreference()).toMatchObject({connectionId: null, account: null,
        selectionRevision: nextWalletLocalRevision(preference.selectionRevision)});
      subject.client.setObservation([sessionFor(subject.source(topicA))]);
      subject.client.emit({kind: "observation_changed"});
      await drain();
      await expectWalletCode(subject.coordinator.activeWallet.validateBoundAccount(actor.permission), "wallet_session_unusable");
      await expectWalletCode(subject.coordinator.activeWallet.resolveAccount({chainId, requiredMethods: []}), "wallet_account_selection_required");
      expect(subject.projection.readPreference().account).toBeNull();
      expect(subject.client.disconnectedSourceIds).toEqual([]);
      expect(subject.client.attempts).toHaveLength(0);
    } finally {await subject.coordinator.close();}
  });

  it("keeps healthy partial approval usable only for its exact methods and permits a later fresh connection", async () => {
    const subject = await createSubject();
    try {
      const review = await requireReview(subject.coordinator, "connect");
      await subject.coordinator.decide({review, initiatedBy: "cli"});
      await waitForState(subject.coordinator, review.operationId, "awaiting_wallet_approval");
      const session = validSession(subject.source(topicA));
      const partial = {...session, namespaces: {eip155: {...session.namespaces["eip155"]!, methods: ["personal_sign"]}}};
      subject.client.setObservation([partial]);
      subject.client.attempts[0]!.settle({status: "approved", session: partial});
      const failed = await waitForState(subject.coordinator, review.operationId, "failed");
      expect(failed.failure?.error.code).toBe("wallet_session_unusable");
      expect(subject.projection.read()).toMatchObject({productRecovery: null, cleanupRecovery: null,
        connection: {status: "connected", namespaces: [{methods: ["personal_sign"]}]}});
      const chainId = parseEvmChainId("eip155:4663");
      expect((await subject.coordinator.activeWallet.resolveAccount({chainId, requiredMethods: ["personal_sign"]})).account.address).toBe(addressA);
      await expectWalletCode(subject.coordinator.activeWallet.resolveAccount({chainId, requiredMethods: ["eth_sendTransaction"]}), "wallet_account_unavailable");
      expect(subject.client.disconnectedSourceIds).toEqual([]);

      subject.client.setObservation([]);
      subject.client.emit({kind: "observation_changed"});
      await drain();
      const nextReview = await requireReview(subject.coordinator, "connect");
      await subject.coordinator.decide({review: nextReview, initiatedBy: "cli"});
      await waitForState(subject.coordinator, nextReview.operationId, "awaiting_wallet_approval");
      const nextSession = validSession(subject.source(topicB), addressB);
      subject.client.setObservation([nextSession]);
      subject.client.attempts[1]!.settle({status: "approved", session: nextSession});
      const completed = await waitForState(subject.coordinator, nextReview.operationId, "completed");
      expect(completed.result).toMatchObject({kind: "connected", connectionId: subject.source(topicB).sourceId});
      expect(subject.operations.read(review.operationId)).toEqual(failed);
      expect(subject.projection.read()).toMatchObject({productRecovery: null, cleanupRecovery: null});
      expect(subject.client.attempts).toHaveLength(2);
    } finally {
      for (const attempt of subject.client.attempts) attempt.settle({status: "cancelled"});
      await subject.coordinator.close();
    }
  });

  it("creates an immutable Review without operation state or WalletConnect effect", async () => {
    const subject = await createSubject();
    const review = await requireReview(subject.coordinator, "connect");

    expect(review).toMatchObject({
      kind: "connect",
      createdAt: initialTime,
      actionExpiresAt: "2026-07-14T00:05:00.000Z",
      precondition: { connectionRevision: subject.projection.read().revision },
      fixedEvidence: { sessionSourceIds: [] },
    });
    expect(subject.operations.read(review.operationId)).toBeNull();
    expect(subject.operations.readActive()).toBeNull();
    expect(subject.client.attempts).toHaveLength(0);
    expect(subject.events.filter((event) => event !== "sdk:observe")).toEqual([]);
  });

  it.each([
    { name: "target account after another chain", accounts: [`eip155:1:${addressB}`, `eip155:4663:${addressA}`], chains: ["eip155:1", "eip155:4663"], status: "connected" },
    { name: "same address on two chains", accounts: [`eip155:1:${addressA}`, `eip155:4663:${addressA}`], chains: ["eip155:1", "eip155:4663"], status: "connected" },
    { name: "two product-chain accounts", accounts: [`eip155:4663:${addressA}`, `eip155:4663:${addressB}`], chains: ["eip155:4663"], status: "connected" },
    { name: "no product-chain account", accounts: [`eip155:1:${addressA}`], chains: ["eip155:1"], status: "connected" },
    { name: "duplicate foreign-chain entry", accounts: [`eip155:1:${addressB}`, `eip155:1:${addressB}`, `eip155:4663:${addressA}`], chains: ["eip155:1", "eip155:4663"], status: "unresolved" },
    { name: "unlisted account chain", accounts: [`eip155:1:${addressB}`, `eip155:4663:${addressA}`], chains: ["eip155:4663"], status: "unresolved" },
    { name: "listed chain without an account", accounts: [`eip155:4663:${addressA}`], chains: ["eip155:1", "eip155:4663"], status: "connected" },
    { name: "duplicate chain replacing another account chain", accounts: [`eip155:1:${addressB}`, `eip155:4663:${addressA}`], chains: ["eip155:4663", "eip155:4663"], status: "unresolved" },
    { name: "malformed foreign account", accounts: ["eip155:1:not_an_address", `eip155:4663:${addressA}`], chains: ["eip155:1", "eip155:4663"], status: "unresolved" },
  ])("scopes session admission: $name", async ({ accounts, chains, status }) => {
    const subject = await createSubject((client, source) => {
      const session = validSession(source(topicA));
      client.setObservation([{ ...session, namespaces: { eip155: { ...session.namespaces["eip155"]!, accounts, chains } } }]);
    });
    try {
      const bindings = new CapabilityBindingRegistry(new CapabilityRegistry([walletConnectionCapability]), [subject.coordinator.walletConnection.connection]);
      const observed = await bindings.invoke(walletConnectionCapability, {}, {signal: new AbortController().signal});
      expect(observed).toMatchObject({ok: true, data: {status}});
      if (status === "connected") expect(observed).toMatchObject({data: {connectionId: subject.source(topicA).sourceId,
        namespaces: [{key: "eip155", accounts, chains}]}});
      expect(subject.client.attempts).toHaveLength(0);
    } finally { await subject.coordinator.close(); }
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
      result: { kind: "connected", connectionId: subject.source(topicA).sourceId },
    });
    expect(await subject.coordinator.get(review.operationId)).toEqual(completed);
    vi.setSystemTime(new Date(review.actionExpiresAt));
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

    const coordinator = await createWalletCoordinator({lifecycleSignal: new AbortController().signal, client, wallet: bootstrap.wallet });
    const terminal = await coordinator.get(operationId);
    expect(terminal.state).toBe("expired");
    expect(await coordinator.getPresentation(operationId)).toEqual({ operation: terminal });
    expect(client.attempts).toHaveLength(0);
    expect(events).not.toContain("sdk:start_connection");
    expect(client.containmentCount).toBe(1);
  });

  it.each([false, true])("preserves confirmed partial approval at startup (product readmission: %s)", async (recoverProduct) => {
    const events: string[] = [];
    const bootstrap = createBootstrap(events);
    const operationId = Buffer.alloc(32, 45).toString("base64url");
    const review = storedRestartReview(operationId);
    bootstrap.operations.seed(parseWalletManagementOperation({contractVersion: "1", domain: "wallet", operationId,
      kind: "connect", initiatedBy: "mcp_app", review, state: "validating_session",
      terminationTarget: null, result: null, failure: null, peerRefusalCode: null}));
    if (recoverProduct) {
      const current = bootstrap.projection.read();
      bootstrap.projection.replace(current.revision, current.connection, {operationId}, null,
        current.updatedAt, [], null);
    }
    // The reviewed deadline has elapsed; confirmed approval still precedes any startup expiry intent.
    vi.setSystemTime(new Date("2026-07-14T00:06:00.000Z"));
    const client = new FakeWalletConnectClient(events);
    client.initialObservationAvailable = false;
    const approved = validSession(bootstrap.createSessionSource(topicA));
    const partial = {...approved, namespaces: {eip155: {...approved.namespaces["eip155"]!, methods: ["personal_sign"]}}};
    client.setObservation([partial]);
    const coordinator = await createWalletCoordinator({lifecycleSignal: new AbortController().signal,client, wallet: bootstrap.wallet});
    try {
      const terminal = await coordinator.get(operationId);
      expect(terminal).toMatchObject({state: "failed", failure: {error: {code: "wallet_session_unusable"}},
        result: null, terminationTarget: null, review});
      expect(await coordinator.getPresentation(operationId)).toEqual({operation: terminal});
      expect(bootstrap.projection.read()).toMatchObject({productRecovery: null, cleanupRecovery: null,
        revalidationSourceIds: [], connection: {status: "connected", connectionId: approved.source.sourceId,
          namespaces: [{key: "eip155", accounts: [`eip155:4663:${addressA}`], chains: ["eip155:4663"],
            methods: ["personal_sign"], events: ["accountsChanged", "chainChanged"]}]}});
      const chainId = parseEvmChainId("eip155:4663");
      expect((await coordinator.activeWallet.resolveAccount({chainId, requiredMethods: ["personal_sign"]})).account.address).toBe(addressA);
      await expectWalletCode(coordinator.activeWallet.resolveAccount({chainId, requiredMethods: ["eth_sendTransaction"]}),
        "wallet_account_unavailable");
      expect(events).not.toContain("store:transition:validating_session->cancelling");
      expect(client.containmentCount).toBe(0);
      expect(client.disconnectedSourceIds).toEqual([]);
      expect(client.attempts).toHaveLength(0);
    } finally {await coordinator.close();}
  });

  it.each([false, true])("does not infer confirmed approval from a healthy partial session at startup (product readmission: %s)", async (recoverProduct) => {
    const events: string[] = [];
    const bootstrap = createBootstrap(events);
    const operationId = Buffer.alloc(32, 46).toString("base64url");
    const review = storedRestartReview(operationId);
    bootstrap.operations.seed(parseWalletManagementOperation({contractVersion: "1", domain: "wallet", operationId,
      kind: "connect", initiatedBy: "mcp_app", review, state: "awaiting_wallet_approval",
      terminationTarget: null, result: null, failure: null, peerRefusalCode: null}));
    if (recoverProduct) {
      const current = bootstrap.projection.read();
      bootstrap.projection.replace(current.revision, current.connection, {operationId}, null, current.updatedAt, [], null);
    }
    const client = new FakeWalletConnectClient(events);
    client.initialObservationAvailable = false;
    const session = validSession(bootstrap.createSessionSource(topicA));
    client.setObservation([{...session, namespaces: {eip155: {...session.namespaces["eip155"]!, methods: ["personal_sign"]}}}]);
    const coordinator = await createWalletCoordinator({lifecycleSignal: new AbortController().signal,client, wallet: bootstrap.wallet});
    try {
      expect(await coordinator.get(operationId)).toMatchObject({state: "failed",
        failure: {error: {code: "runtime_state_unavailable"}}});
      expect(bootstrap.projection.read()).toMatchObject({productRecovery: null,
        cleanupRecovery: {kind: "management", operationId}});
      // Exact-operation read schedules serial convergence; a fresh capture owns the observed connection facts.
      await drain();
      expect((await coordinator.activeWallet.capture()).connection).toEqual({status: "unresolved", sessionCount: "1"});
      expect(bootstrap.projection.read()).toMatchObject({productRecovery: null,
        cleanupRecovery: {kind: "management", operationId}, connection: {status: "unresolved", sessionCount: "1"}});
      await expectWalletCode(coordinator.activeWallet.resolveAccount({chainId: parseEvmChainId("eip155:4663"), requiredMethods: []}),
        "runtime_state_unavailable");
      expect(client.attempts).toHaveLength(0);
      expect(client.disconnectedSourceIds).toEqual([]);
    } finally {await coordinator.close();}
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
    expect(review.createdAt).toBe(initialTime);
    expect(review.actionExpiresAt).toBe("2026-07-14T00:05:00.000Z");
    expect(disconnectIds(review)).toEqual([subject.source(topicA).sourceId]);
    expect(subject.client.disconnectedSourceIds).toEqual([]);
    expect(subject.operations.read(review.operationId)).toBeNull();

    const started = await subject.coordinator.decide({ review, initiatedBy: "cli" });
    expect(started.state).toBe("disconnecting");
    const completed = await waitForState(subject.coordinator, review.operationId, "completed");
    expect(completed).toMatchObject({
      result: { kind: "disconnected" },
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

  it("disconnects an explicitly reviewed unresolved session and clears revalidation only after empty observation", async () => {
    const subject = await createSubject((client, source) => client.setObservation([validSession(source(topicA))]));
    try {
      subject.client.emit({ kind: "identity_invalid", sessionSourceId: subject.source(topicA).sourceId });
      await drain();
      expect(subject.projection.read().revalidationSourceIds).toEqual([subject.source(topicA).sourceId]);
      expect((await subject.coordinator.activeWallet.capture()).connection.status).toBe("unresolved");
      subject.events.length = 0;
      const review = await requireReview(subject.coordinator, "disconnect");
      expect(review.kind === "disconnect" && review.precondition.targetSet).toMatchObject({kind: "inline", targets: [{status: "unavailable", sourceId: subject.source(topicA).sourceId, reason: "revalidation_required"}]});
      expect(disconnectIds(review)).toEqual([subject.source(topicA).sourceId]);
      expect(subject.events.filter((event) => event !== "sdk:observe")).toEqual([]);
      await subject.coordinator.decide({ review, initiatedBy: "cli" });
      const completed = await waitForState(subject.coordinator, review.operationId, "completed");
      expect(completed.result).toMatchObject({ kind: "disconnected" });
      expect(subject.projection.read()).toMatchObject({productRecovery: null, cleanupRecovery: null});
      expect(subject.client.disconnectedSourceIds).toEqual([subject.source(topicA).sourceId]);
      expect(subject.events.indexOf("store:create:disconnecting")).toBeLessThan(subject.events.indexOf(`sdk:disconnect:${subject.source(topicA).sourceId}`));
      expect(await subject.coordinator.decide({ review, initiatedBy: "cli" })).toEqual(completed);
      expect(subject.client.disconnectedSourceIds).toHaveLength(1);
      expect((await requireReview(subject.coordinator, "connect")).kind).toBe("connect");
      expect(subject.client.attempts).toHaveLength(0);
    } finally { await subject.coordinator.close(); }
  });

  it("rejects a changed complete disconnect set even when count and connection revision stay equal", async () => {
    const subject = await createSubject((client, source) => client.setObservation([validSession(source(topicA)), validSession(source(topicB))]));
    try {
      const review = await requireReview(subject.coordinator, "disconnect");
      subject.client.setObservation([validSession(subject.source(topicA)), validSession(subject.source("c".repeat(64)))]);
      await expectWalletCode(subject.coordinator.decide({ review, initiatedBy: "mcp_app" }), "state_conflict");
      expect(subject.projection.read().revision).toBe(review.precondition.connectionRevision);
      expect(subject.client.disconnectedSourceIds).toEqual([]);
      expect(subject.operations.read(review.operationId)).toBeNull();
    } finally { await subject.coordinator.close(); }
  });

  it("refuses unresolved cleanup for a different chain or while a proposal remains", async () => {
    const subject = await createSubject((client, source) => client.setObservation([validSession(source(topicA)), validSession(source(topicB))]));
    try {
      const { reviewDigest: _digest, ...review } = await requireReview(subject.coordinator, "disconnect");
      const changed = { ...review, target: { chainId: "eip155:1" } };
      await expectWalletCode(subject.coordinator.decide({
        review: parseWalletReview({ ...changed, reviewDigest: walletReviewDigest(changed) }), initiatedBy: "cli",
      }), "state_conflict");
      expect(subject.client.disconnectedSourceIds).toEqual([]);
      subject.client.setObservation(subject.client.sessions, 1);
      subject.client.emit({ kind: "observation_changed" });
      await drain();
      await expectWalletCode(subject.coordinator.review({ kind: "disconnect" }), "wallet_session_unusable");
      expect(subject.client.disconnectedSourceIds).toEqual([]);
    } finally { await subject.coordinator.close(); }
  });

  it.each(["deletion_failure", "new_session", "observation_failure"] as const)(
    "retains closed authority after %s during reviewed cleanup", async (mode) => {
      const subject = await createSubject((client, source) => client.setObservation([validSession(source(topicA)), validSession(source(topicB))]));
      try {
        const review = await requireReview(subject.coordinator, "disconnect");
        const ids = [...disconnectIds(review)];
        const original = subject.client.disconnectSession.bind(subject.client);
        const calls: string[] = [];
        vi.spyOn(subject.client, "disconnectSession").mockImplementation(async (sourceId) => {
          calls.push(sourceId);
          if (mode === "deletion_failure" && sourceId === ids[1]) throw new WalletConnectClientError("sdk");
          await original(sourceId);
          if (sourceId === ids[0] && mode === "new_session") subject.client.setObservation([
            ...subject.client.sessions, validSession(subject.source("c".repeat(64))),
          ]);
          if (sourceId === ids[1] && mode === "observation_failure") subject.client.observeError = new WalletConnectClientError("observation");
        });
        await subject.coordinator.decide({ review, initiatedBy: "cli" });
        expect((await waitForState(subject.coordinator, review.operationId, "failed")).result).toBeNull();
        expect(calls).toEqual(ids);
        expect((await subject.coordinator.activeWallet.capture()).connection.status).not.toBe("connected");
        expect(subject.projection.read()).toMatchObject({productRecovery: null, cleanupRecovery: {kind: "management", operationId: review.operationId}});
        expect(subject.client.attempts).toHaveLength(0);
        if (mode === "new_session") expect(subject.client.sessions.map((session) => session.source.sourceId)).toEqual([subject.source("c".repeat(64)).sourceId]);
        if (mode === "deletion_failure") {
          const next = await requireReview(subject.coordinator, "disconnect");
          expect(disconnectIds(next)).toEqual([ids[1]]);
          expect(calls).toEqual(ids);
        }
      } finally { await subject.coordinator.close(); }
    },
  );

  it.each(["empty", "retained", "unavailable"] as const)("does not resend an interrupted disconnect on restart (%s observation)", async (mode) => {
    const events: string[] = [];
    const bootstrap = createBootstrap(events);
    const sourceIds = [bootstrap.createSessionSource(topicA).sourceId, bootstrap.createSessionSource(topicB).sourceId].sort();
    const input = {
      contractVersion: "1", domain: "wallet", kind: "disconnect", operationId: Buffer.alloc(32, 48).toString("base64url"),
      createdAt: initialTime, actionExpiresAt: "2026-07-14T00:05:00.000Z", target: { chainId: "eip155:4663" },
      decision: { action: "disconnect_session" }, precondition: {connectionRevision: "0", targetSet: {kind: "inline", targets: sourceIds.map(sourceId => ({status: "unavailable", sourceId, reason: "revalidation_required"}))}},
    };
    const review = parseWalletReview({ ...input, reviewDigest: walletReviewDigest(input) });
    bootstrap.operations.seed(parseWalletManagementOperation({
      contractVersion: "1", domain: "wallet", kind: "disconnect", operationId: review.operationId,
      initiatedBy: "cli", review, state: "disconnecting", terminationTarget: null, result: null, failure: null, peerRefusalCode: null,
    }));
    const client = new FakeWalletConnectClient(events);
    client.initialObservationAvailable = false;
    if (mode === "retained") client.setObservation([validSession(bootstrap.createSessionSource(topicA))]);
    if (mode === "unavailable") client.observeError = new WalletConnectClientError("observation");
    expect(bootstrap.projection.read().cleanupRecovery).toBeNull();
    const coordinator = await createWalletCoordinator({lifecycleSignal: new AbortController().signal, client, wallet: bootstrap.wallet });
    try {
      const operation = await coordinator.get(review.operationId);
      expect(operation.state).toBe(mode === "empty" ? "completed" : "failed");
      expect(bootstrap.projection.read().cleanupRecovery).toEqual(mode === "empty" ? null :
        {kind: "management", operationId: review.operationId});
      if (mode !== "empty") {
        await expectWalletCode(coordinator.activeWallet.resolveAccount({chainId: parseEvmChainId("eip155:4663"), requiredMethods: []}),
          "runtime_state_unavailable");
        if (mode === "retained") expect(bootstrap.projection.read().connection).toEqual({status: "unresolved", sessionCount: "1"});
        client.observeError = undefined;
        client.setObservation([]);
        client.emit({kind: "observation_changed"});
        await drain();
        expect(bootstrap.projection.read()).toMatchObject({productRecovery: null, cleanupRecovery: null,
          connection: {status: "disconnected"}});
        expect(bootstrap.operations.read(review.operationId)).toEqual(operation);
      }
      expect(client.disconnectedSourceIds).toEqual([]);
      expect(client.attempts).toHaveLength(0);
    } finally { await coordinator.close(); }
  });

  it("persists a newly derived startup disconnect cause through the actual product stores", async () => {
    vi.useFakeTimers({toFake: ["Date", "setTimeout", "clearTimeout"]});
    vi.setSystemTime(new Date(initialTime));
    const directory = await mkdtemp(join(tmpdir(), "littlejohn-wallet-cleanup-"));
    const path = join(directory, "product.sqlite3");
    const events: string[] = [];
    const bootstrap = createBootstrap(events);
    const clock = bootstrap.wallet.capabilityAuthority.clock;
    const chainId = parseEvmChainId("eip155:4663");
    let database: ProductDatabase | undefined;
    let coordinator: WalletCoordinator | undefined;
    try {
      database = await ProductDatabase.open(path, clock.now());
      database.configuredChainStore().insertConfiguredChainIfAbsent(chainId);
      const profile = database.ownerStore().readProfile();
      expect(database.ownerStore().readOwner()).toBeUndefined();
      const sourceAuthority = createWalletSourceAuthorityFromKey({key: Buffer.alloc(32, 7), profileId: profile.profileId, clock});
      expect(sourceAuthority.sdkStoreSourceId).toBe(`wallet-sdk:${profile.profileId}`);
      const session = validSession(sourceAuthority.createSessionSource(topicA));
      const wallet: WalletOwnerBootstrapPort = Object.freeze({...bootstrap.wallet,
        projection: database.walletStore(), operations: database.walletOperationStore(), reviews: database.walletReviewStore(),
        sourceAuthority, capabilityAuthority: Object.freeze({...bootstrap.wallet.capabilityAuthority,
          createInvocationPorts(source?: WalletSessionSource): InvocationBoundaryPorts {
            return {observations: new ObservationAuthorityRegistry(clock, source === undefined
              ? [sourceAuthority.sdkStoreAuthority] : [sourceAuthority.sdkStoreAuthority, source.observationAuthority])};
          },
        }),
      });
      const firstClient = new FakeWalletConnectClient(events);
      firstClient.initialObservationAvailable = false;
      firstClient.setObservation([session]);
      coordinator = await createWalletCoordinator({lifecycleSignal: new AbortController().signal,client: firstClient, wallet});
      const actor = await coordinator.activeWallet.resolveAccount({chainId, requiredMethods: ["eth_sendTransaction"]});
      const review = await requireReview(coordinator, "disconnect");
      const predecessor = parseWalletManagementOperation({contractVersion: "1", domain: "wallet", kind: "disconnect",
        operationId: review.operationId, initiatedBy: "cli", review, state: "disconnecting",
        terminationTarget: null, result: null, failure: null, peerRefusalCode: null});
      if (predecessor.state !== "disconnecting") throw new Error("A disconnecting predecessor is required.");
      // This is the durable producer boundary before the first deletion can be sent.
      database.walletOperationStore().create(predecessor);
      expect(database.walletStore().read()).toMatchObject({productRecovery: null, cleanupRecovery: null});
      await coordinator.close();
      coordinator = undefined;
      database.close();
      database = undefined;

      database = await ProductDatabase.open(path, clock.now());
      expect(database.ownerStore().readProfile()).toEqual(profile);
      expect(database.ownerStore().readOwner()).toBeUndefined();
      expect(database.walletOperationStore().read(review.operationId)).toEqual(predecessor);
      expect(database.walletStore().read().cleanupRecovery).toBeNull();
      const restartedClient = new FakeWalletConnectClient(events);
      restartedClient.initialObservationAvailable = false;
      restartedClient.setObservation([session]);
      coordinator = await createWalletCoordinator({lifecycleSignal: new AbortController().signal,client: restartedClient, wallet: Object.freeze({...wallet,
        projection: database.walletStore(), operations: database.walletOperationStore(), reviews: database.walletReviewStore()})});
      const failed = await coordinator.get(review.operationId);
      await drain();
      expect(failed).toMatchObject({state: "failed", failure: {error: {code: "runtime_state_unavailable"}}});
      expect(database.walletStore().read()).toMatchObject({productRecovery: null,
        cleanupRecovery: {kind: "management", operationId: review.operationId}, connection: {status: "unresolved", sessionCount: "1"}});
      await expectWalletCode(coordinator.activeWallet.validateBoundAccount(actor.permission), "runtime_state_unavailable");
      await expectWalletCode(coordinator.activeWallet.resolveAccount({chainId, requiredMethods: ["eth_sendTransaction"]}),
        "runtime_state_unavailable");
      expect(() => coordinator!.activeWallet.assertBoundAccountCurrent(actor.permission)).toThrowError(WalletOperationError);
      const raw = new Database(path, {readonly: true});
      try {
        expect(raw.prepare(`SELECT profile_id AS profileId, product_recovery_json AS productRecovery,
          cleanup_recovery_json AS cleanupRecovery FROM current_wallet_connection WHERE singleton = 1`).get()).toEqual({
          profileId: profile.profileId, productRecovery: null,
          cleanupRecovery: Buffer.from(JSON.stringify({kind: "management", operationId: review.operationId})),
        });
      } finally {raw.close();}
      expect(database.walletOperationStore().read(review.operationId)).toEqual(failed);
      expect(database.ownerStore().readProfile()).toEqual(profile);
      expect(database.ownerStore().readOwner()).toBeUndefined();
      expect(firstClient.disconnectedSourceIds).toEqual([]);
      expect(restartedClient.disconnectedSourceIds).toEqual([]);
      expect(firstClient.attempts).toHaveLength(0);
      expect(restartedClient.attempts).toHaveLength(0);
    } finally {
      try {await coordinator?.close();}
      finally {
        database?.close();
        await rm(directory, {recursive: true, force: true});
      }
    }
  });

  it("retains failed cleanup across another healthy source and clears only after complete empty observation", async () => {
    const subject = await createSubject((client, source) => client.setObservation([validSession(source(topicA))]));
    vi.spyOn(subject.client, "disconnectSession").mockRejectedValue(new WalletConnectClientError("sdk"));
    try {
      const review = await requireReview(subject.coordinator, "disconnect");
      await subject.coordinator.decide({review, initiatedBy: "cli"});
      const failed = await waitForState(subject.coordinator, review.operationId, "failed");
      expect(subject.projection.read()).toMatchObject({productRecovery: null,
        cleanupRecovery: {kind: "management", operationId: review.operationId}});
      subject.client.setObservation([validSession(subject.source(topicB), addressB)]);
      subject.client.emit({kind: "observation_changed"});
      await drain();
      await expectWalletCode(subject.coordinator.activeWallet.resolveAccount({chainId: parseEvmChainId("eip155:4663"), requiredMethods: []}), "runtime_state_unavailable");
      expect(subject.projection.read().cleanupRecovery).toEqual({kind: "management", operationId: review.operationId});
      subject.client.setObservation([]);
      subject.client.emit({kind: "observation_changed"});
      await drain();
      expect(subject.projection.read()).toMatchObject({productRecovery: null, cleanupRecovery: null, connection: {status: "disconnected"}});
      expect(subject.operations.read(review.operationId)).toEqual(failed);
      expect((await requireReview(subject.coordinator, "connect")).kind).toBe("connect");
      expect(subject.client.attempts).toHaveLength(0);
    } finally {await subject.coordinator.close();}
  });

  it("does not release cleanup at a local deadline while the original SDK work remains unsettled", async () => {
    const subject = await createSubject((client, source) => client.setObservation([validSession(source(topicA))]));
    const original = deferred<void>();
    const disconnect = vi.spyOn(subject.client, "disconnectSession").mockReturnValue(original.promise);
    try {
      const review = await requireReview(subject.coordinator, "disconnect");
      await subject.coordinator.decide({review, initiatedBy: "cli"});
      await drain();
      expect(disconnect).toHaveBeenCalledOnce();
      subject.client.setObservation([]);
      subject.client.emit({kind: "observation_changed"});
      await vi.advanceTimersByTimeAsync(Date.parse(review.actionExpiresAt) - Date.now());
      const failed = await waitForState(subject.coordinator, review.operationId, "failed");
      expect(failed.failure?.error.code).toBe("wallet_timeout");
      expect(subject.projection.read()).toMatchObject({productRecovery: null,
        cleanupRecovery: {kind: "management", operationId: review.operationId}});
      await subject.coordinator.activeWallet.capture();
      expect(subject.projection.read().cleanupRecovery).toEqual({kind: "management", operationId: review.operationId});
      expect(disconnect).toHaveBeenCalledOnce();
      original.resolve(undefined);
      await drain();
      await subject.coordinator.activeWallet.capture();
      expect(subject.projection.read()).toMatchObject({productRecovery: null, cleanupRecovery: null, connection: {status: "disconnected"}});
      expect(subject.operations.read(review.operationId)).toEqual(failed);
      expect(disconnect).toHaveBeenCalledOnce();
    } finally {
      original.resolve(undefined);
      await drain();
      await subject.coordinator.close();
    }
  });

  it("requires the product owner to readmit an uncertain projection before any authority reopens", async () => {
    const subject = await createSubject((client, source) => client.setObservation([validSession(source(topicA))]));
    try {
      const chainId = parseEvmChainId("eip155:4663");
      const actor = await subject.coordinator.activeWallet.resolveAccount({chainId, requiredMethods: []});
      const replace = subject.projection.replace.bind(subject.projection);
      subject.projection.readmissionError = new Error("The product owner cannot yet admit the stored state.");
      vi.spyOn(subject.projection, "replace").mockImplementationOnce(() => {throw new Error("Projection outcome is unavailable.");});
      subject.client.setObservation([validSession(subject.source(topicA), addressB)]);
      subject.client.emit({kind: "observation_changed"});
      await drain();
      expect(subject.projection.read()).toMatchObject({productRecovery: {operationId: null}, cleanupRecovery: null});
      subject.client.setObservation([]);
      subject.client.emit({kind: "observation_changed"});
      await drain();
      await subject.coordinator.activeWallet.capture();
      expect(subject.projection.read().productRecovery).toEqual({operationId: null});
      await expectWalletCode(subject.coordinator.activeWallet.validateBoundAccount(actor.permission), "runtime_state_unavailable");
      const blockedRevision = subject.projection.read().revision;
      subject.projection.readmissionError = undefined;
      vi.mocked(subject.projection.replace).mockImplementation(replace);
      subject.client.emit({kind: "observation_changed"});
      await drain();
      expect(subject.projection.read()).toMatchObject({productRecovery: null, cleanupRecovery: null, connection: {status: "disconnected"}});
      expect(BigInt(subject.projection.read().revision)).toBeGreaterThan(BigInt(blockedRevision));
      subject.client.setObservation([validSession(subject.source(topicA))]);
      subject.client.emit({kind: "observation_changed"});
      await drain();
      await expectWalletCode(subject.coordinator.activeWallet.validateBoundAccount(actor.permission), "wallet_session_unusable");
      const current = await subject.coordinator.activeWallet.resolveAccount({chainId, requiredMethods: []});
      expect(current.permission.permissionRevision).not.toBe(actor.permission.permissionRevision);
      expect(subject.client.attempts).toHaveLength(0);
      expect(subject.client.disconnectedSourceIds).toEqual([]);
    } finally {await subject.coordinator.close();}
  });

  it("commits exact successor reconciliation with product readmission without replaying the connect", async () => {
    const subject = await createSubject();
    try {
      const review = await requireReview(subject.coordinator, "connect");
      await subject.coordinator.decide({review, initiatedBy: "cli"});
      await waitForState(subject.coordinator, review.operationId, "awaiting_wallet_approval");
      subject.projection.readmissionError = new Error("The product owner has not admitted the exact successor.");
      const transition = subject.operations.transition.bind(subject.operations);
      let rejectedSuccessor = false;
      vi.spyOn(subject.operations, "transition").mockImplementation(command => {
        if (command.operation.state === "completed" && !rejectedSuccessor) {
          rejectedSuccessor = true;
          throw new Error("Terminal successor was not stored.");
        }
        return transition(command);
      });
      const session = validSession(subject.source(topicA));
      subject.client.setObservation([session]);
      subject.client.attempts[0]!.settle({status: "approved", session});
      await drain();
      expect(rejectedSuccessor).toBe(true);
      expect(subject.operations.read(review.operationId)?.state).toBe("validating_session");
      expect(subject.projection.read().productRecovery).toEqual({operationId: review.operationId});
      subject.client.setObservation([]);
      subject.client.emit({kind: "observation_changed"});
      await drain();
      expect(subject.projection.read().productRecovery).toEqual({operationId: review.operationId});
      expect(subject.operations.read(review.operationId)?.state).toBe("validating_session");
      subject.projection.readmissionError = undefined;
      subject.client.emit({kind: "observation_changed"});
      await drain();
      const completed = await waitForState(subject.coordinator, review.operationId, "completed");
      expect(completed.result).toMatchObject({kind: "connected", connectionId: session.source.sourceId});
      expect(subject.projection.read()).toMatchObject({productRecovery: null, cleanupRecovery: null, connection: {status: "disconnected"}});
      expect(subject.client.attempts).toHaveLength(1);
      expect(subject.client.disconnectedSourceIds).toEqual([]);
    } finally {
      for (const attempt of subject.client.attempts) attempt.settle({status: "cancelled"});
      await subject.coordinator.close();
    }
  });

  it("does not start another reviewed deletion after the action deadline", async () => {
    const subject = await createSubject((client, source) => client.setObservation([validSession(source(topicA)), validSession(source(topicB))]));
    try {
      const review = await requireReview(subject.coordinator, "disconnect");
      const original = subject.client.disconnectSession.bind(subject.client);
      const calls: string[] = [];
      vi.spyOn(subject.client, "disconnectSession").mockImplementation(async (sourceId) => {
        calls.push(sourceId);
        await original(sourceId);
        vi.setSystemTime(new Date(review.actionExpiresAt));
      });
      await subject.coordinator.decide({ review, initiatedBy: "cli" });
      const failed = await waitForState(subject.coordinator, review.operationId, "failed");
      expect(failed.failure?.error.code).toBe("wallet_timeout");
      expect(calls).toEqual([disconnectIds(review)[0]]);
      expect(subject.client.sessions.map((session) => session.source.sourceId)).toEqual([disconnectIds(review)[1]]);
      expect(subject.projection.read()).toMatchObject({productRecovery: null, cleanupRecovery: {kind: "management", operationId: review.operationId}});
    } finally { await subject.coordinator.close(); }
  });

  it.each(["get", "getPresentation"] as const)(
    "%s owns synchronous expiry and readback, including failed successor persistence",
    async (method) => {
      for (const failPersistence of [false, true]) {
        const subject = await createSubject();
        const review = await requireReview(subject.coordinator, "connect");
        await subject.coordinator.decide({ review, initiatedBy: "cli" });
        const awaiting = await waitForState(subject.coordinator, review.operationId, "awaiting_wallet_approval");
        expect(await subject.coordinator.getPresentation(review.operationId)).toEqual({ operation: awaiting, qr });
        const trace: string[] = [];
        const read = subject.operations.read.bind(subject.operations);
        const transition = subject.operations.transition.bind(subject.operations);
        vi.spyOn(subject.operations, "read").mockImplementation((id) => {
          const value = read(id);
          trace.push(`read:${value?.state ?? "absent"}`);
          return value;
        });
        vi.spyOn(subject.operations, "transition").mockImplementation((command) => {
          trace.push(`transition:${command.operation.state}`);
          if (failPersistence) throw new Error("Successor was not persisted.");
          return transition(command);
        });
        // Move the domain clock without running the scheduled convergence callback.
        vi.setSystemTime(new Date(review.actionExpiresAt));
        subject.events.length = 0;
        const result = subject.coordinator[method](review.operationId);
        expect(trace).toEqual([
          "read:awaiting_wallet_approval", "transition:cancelling",
          `read:${failPersistence ? "awaiting_wallet_approval" : "cancelling"}`,
        ]);
        const stored = read(review.operationId)!;
        expect(stored).toMatchObject(failPersistence
          ? awaiting : { state: "cancelling", terminationTarget: "expired" });
        const presentation = subject.coordinator.getPresentation(review.operationId);
        const ordinary = subject.coordinator.get(review.operationId);
        await expect(result).resolves.toEqual(method === "get" ? stored : { operation: stored });
        await expect(presentation).resolves.toEqual({ operation: stored });
        await expect(ordinary).resolves.toEqual(stored);
        expect(subject.events).not.toContain("sdk:start_connection");
        if (failPersistence) {
          // Settle the admitted external work without repairing the retained predecessor.
          subject.client.attempts[0]!.settle({ status: "cancelled" });
          await drain();
          expect(read(review.operationId)).toEqual(awaiting);
        } else {
          const expired = await waitForState(subject.coordinator, review.operationId, "expired");
          trace.length = 0;
          expect(await subject.coordinator.get(review.operationId)).toEqual(expired);
          expect(await subject.coordinator.getPresentation(review.operationId)).toEqual({ operation: expired });
          expect(trace).toEqual(["read:expired", "read:expired"]);
        }
        await subject.coordinator.close();
      }
    },
  );

  it("selects the exact operation and matching QR before a queued cancellation can change their source", async () => {
    const subject = await createSubject();
    const review = await requireReview(subject.coordinator, "connect");
    await subject.coordinator.decide({review, initiatedBy: "cli"});
    const awaiting = await waitForState(subject.coordinator, review.operationId, "awaiting_wallet_approval");
    const read = subject.operations.read.bind(subject.operations);
    let reads = 0;
    let cancellation: Promise<WalletManagementOperation> | undefined;
    vi.spyOn(subject.operations, "read").mockImplementation((id) => {
      const selected = read(id);
      if (++reads === 2) queueMicrotask(() => {
        cancellation = subject.coordinator.cancel({operationId: review.operationId, reviewDigest: review.reviewDigest,
          expectedState: "awaiting_wallet_approval", connectionRevision: review.precondition.connectionRevision});
      });
      return selected;
    });
    try {
      expect(await subject.coordinator.getPresentation(review.operationId)).toEqual({operation: awaiting, qr});
      expect(cancellation).toBeDefined();
      await cancellation;
      await drain();
      expect(subject.client.attempts).toHaveLength(1);
    } finally {await subject.coordinator.close();}
  });

  it("preserves exact-read admission and failures in both public entry points", async () => {
    const subject = await createSubject();
    const id = Buffer.alloc(32, 91).toString("base64url");
    const read = vi.spyOn(subject.operations, "read");
    for (const method of ["get", "getPresentation"] as const) {
      read.mockClear();
      await expect(subject.coordinator[method]("invalid")).rejects.toThrow();
      expect(read).not.toHaveBeenCalled();
      await expectWalletCode(subject.coordinator[method](id), "wallet_operation_not_found");
      expect(read).toHaveBeenCalledTimes(1);
      const failure = new Error("Exact store read unavailable.");
      read.mockImplementationOnce(() => { throw failure; });
      await expect(subject.coordinator[method](id)).rejects.toBe(failure);
    }
    await subject.coordinator.close();
    read.mockClear();
    for (const method of ["get", "getPresentation"] as const) {
      await expectWalletCode(subject.coordinator[method]("invalid"), "runtime_state_unavailable");
    }
    expect(read).not.toHaveBeenCalled();
  });

  it("contains close at its settlement deadline without claiming a pending effect stopped", async () => {
    const subject = await createSubject();
    const review = await requireReview(subject.coordinator, "connect");
    await subject.coordinator.decide({ review, initiatedBy: "cli" });
    await waitForState(subject.coordinator, review.operationId, "awaiting_wallet_approval");
    const attempt = subject.client.attempts[0]!;
    const cancellation = deferred<WalletConnectAttemptOutcome>();
    const cancel = vi.spyOn(attempt, "cancel").mockReturnValue(cancellation.promise);
    const closing = subject.coordinator.close();
    expect(subject.coordinator.close()).toBe(closing);
    await expectWalletCode(subject.coordinator.get(review.operationId), "runtime_state_unavailable");
    expect(subject.operations.read(review.operationId)).toMatchObject({ state: "cancelling", terminationTarget: "expired" });
    let closed = false;
    void closing.then(() => { closed = true; });
    await vi.advanceTimersByTimeAsync(299_999);
    expect(closed).toBe(false);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(subject.client.containCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(closed).toBe(true);
    await closing;
    expect(subject.client.containCalls).toBe(1);
    expect(attempt.terminal).toBeUndefined();
    cancellation.resolve({ status: "cancelled" });
    attempt.settle({ status: "cancelled" });
    await vi.advanceTimersByTimeAsync(0);
    expect(subject.client.attempts).toHaveLength(1);
    expect(subject.client.containCalls).toBe(1);
  });
});
