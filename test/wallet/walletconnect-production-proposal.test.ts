import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { readRuntimeConfiguration } from "../../src/runtime/configuration.js";
import {
  createWalletConnectClient,
  createWalletConnectAcquisitionScope,
  type WalletConnectClientAcquisition,
} from "../../src/wallet/walletconnect-client.js";

const projectId = "1".repeat(32);
const metadata = readRuntimeConfiguration({}).wallet.metadata;
const firstPairingTopic = "2".repeat(64);
const secondPairingTopic = "6".repeat(64);
const firstSessionTopic = "3".repeat(64);
const secondSessionTopic = "4".repeat(64);
const publicKey = "5".repeat(64);
const storeDirectory = resolve(".WORK/tests/walletconnect-production-proposal/store");

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
  readonly reject: (error: unknown) => void;
}

const deferred = <Value>(): Deferred<Value> => {
  let resolvePromise: ((value: Value) => void) | undefined;
  let rejectPromise: ((error: unknown) => void) | undefined;
  const promise = new Promise<Value>((resolveValue, rejectValue) => {
    resolvePromise = resolveValue;
    rejectPromise = rejectValue;
  });
  if (resolvePromise === undefined || rejectPromise === undefined) {
    throw new TypeError("Deferred initialization failed.");
  }
  return Object.freeze({ promise, resolve: resolvePromise, reject: rejectPromise });
};

const namespace = () => ({
  chains: ["eip155:4663"],
  accounts: ["eip155:4663:0x1111111111111111111111111111111111111111"],
  methods: ["eth_sendTransaction"],
  events: ["accountsChanged", "chainChanged"],
});

const sdkSession = (topic: string, pairingTopic: string) => ({
  topic,
  pairingTopic,
  expiry: 1_783_791_906,
  namespaces: { eip155: namespace() },
});

type EventListener = (event: unknown) => void;
type ConnectionProposalMode = "exact" | "none" | "multiple" | "malformed" | "mismatched";

class TestRelayer {
  constructor(private readonly harness: PinnedProtocolHarness) {}

  async transportClose(): Promise<void> {
    this.harness.transportCloseCalls += 1;
  }
}

class TestHeartbeat {
  constructor(private readonly harness: PinnedProtocolHarness) {}

  stop(): void {
    this.harness.heartbeatStopCalls += 1;
  }
}

class PinnedProtocolHarness {
  readonly expirations: number[] = [];
  readonly expirationRequests = new Map<number, Deferred<void>>();
  readonly pairingDisconnects: string[] = [];
  readonly pairingDisconnectRequests = new Map<string, Deferred<void>>();
  readonly pendingSessions = new Map<number, {
    readonly proposalId: number;
    readonly pairingTopic: string;
    readonly sessionTopic: string;
    readonly publicKey: string;
  }>();
  readonly listeners = new Map<string, Set<EventListener>>();
  readonly approvals = new Map<number, Deferred<unknown>>();
  transportCloseCalls = 0;
  heartbeatStopCalls = 0;
  approvalCalls = 0;
  sessionReadCount = 0;
  sessionReadHook: ((readCount: number) => void) | undefined;
  proposals: Array<{
    readonly id: number;
    readonly pairingTopic: string;
    readonly expiryTimestamp: number;
  }> = [];
  pairings: Array<{ readonly topic: string }> = [];
  sessions: unknown[] = [];
  holdExpiration = false;
  emitExpirationEvent = true;
  failPairingDisconnect = false;
  failProposalListenerRemoval = false;
  settleBarrier: Deferred<void> | undefined;
  sessionSetObserved: Deferred<void> | undefined;
  nextProposalId = 100;
  nextPairingIndex = 0;
  connectionUriOverride: string | undefined;
  connectionProposalMode: ConnectionProposalMode = "exact";
  connectionProposalStoreActive = false;

  readonly engine: {
    readonly pendingSessions: Map<number, {
      readonly proposalId: number;
      readonly pairingTopic: string;
      readonly sessionTopic: string;
      readonly publicKey: string;
    }>;
    onSessionProposeResponse: (topic: string, payload: unknown) => Promise<void>;
    onSessionSettleRequest: (topic: string, payload: unknown) => Promise<void>;
  };

  readonly sessionStore: {
    getAll: () => unknown[];
    set: (topic: string, value: unknown) => Promise<void>;
  };

  readonly client: object;

  constructor() {
    const pairing = {
      disconnect: async ({ topic }: { readonly topic: string }) => {
        this.pairingDisconnects.push(topic);
        this.pairingDisconnectRequest(topic).resolve();
        if (this.failPairingDisconnect) throw new Error("pairing transport failure");
        this.pairings = this.pairings.filter((value) => value.topic !== topic);
      },
      getPairings: () => this.pairings,
    };
    this.sessionStore = {
      getAll: () => {
        this.sessionReadCount += 1;
        this.sessionReadHook?.(this.sessionReadCount);
        return this.sessions;
      },
      set: async (topic: string, value: unknown) => {
        this.sessions = [
          ...this.sessions.filter((candidate) =>
            (candidate as { readonly topic?: unknown }).topic !== topic),
          value,
        ];
        this.sessionSetObserved?.resolve();
      },
    };
    this.engine = {
      pendingSessions: this.pendingSessions,
      onSessionProposeResponse: async (topic: string, payload: unknown) => {
        const id = (payload as { readonly id: number }).id;
        this.pendingSessions.set(id, {
          proposalId: id,
          pairingTopic: topic,
          sessionTopic: firstSessionTopic,
          publicKey,
        });
      },
      onSessionSettleRequest: async (topic: string) => {
        const pending = [...this.pendingSessions.values()]
          .find((value) => value.sessionTopic === topic);
        if (pending === undefined) return;
        const established = sdkSession(topic, pending.pairingTopic);
        await this.sessionStore.set(topic, established);
        await this.settleBarrier?.promise;
        this.pendingSessions.delete(pending.proposalId);
        this.proposals = this.proposals.filter(({ id }) => id !== pending.proposalId);
        const approval = this.approvals.get(pending.proposalId);
        this.approvals.delete(pending.proposalId);
        approval?.resolve(established);
      },
    };
    this.client = {
      core: {
        heartbeat: new TestHeartbeat(this),
        relayer: new TestRelayer(this),
        pairing,
        expirer: {
          set: (id: number) => {
            this.expirations.push(id);
            this.expirationRequest(id).resolve();
            if (!this.holdExpiration) this.expireNow(id, this.emitExpirationEvent);
          },
        },
      },
      proposal: { getAll: () => this.readProposalStore() },
      engine: this.engine,
      session: this.sessionStore,
      connect: async () => this.connect(),
      disconnect: async ({ topic }: { readonly topic: string }) => {
        const sessionExists = this.sessions.some((value) =>
          (value as { readonly topic?: unknown }).topic === topic);
        if (sessionExists) {
          this.sessions = this.sessions.filter((value) =>
            (value as { readonly topic?: unknown }).topic !== topic);
          return;
        }
        this.pairings = this.pairings.filter((value) => value.topic !== topic);
      },
      on: (event: string, listener: EventListener) => {
        const listeners = this.listeners.get(event) ?? new Set<EventListener>();
        listeners.add(listener);
        this.listeners.set(event, listeners);
      },
      off: (event: string, listener: EventListener) => {
        if (event === "proposal_expire" && this.failProposalListenerRemoval) {
          throw new Error("proposal listener removal failure");
        }
        this.listeners.get(event)?.delete(listener);
      },
    };
  }

  seedProposal(id: number, pairingTopic: string, withApproval = true): void {
    this.proposals.push({
      id,
      pairingTopic,
      expiryTimestamp: Math.floor(Date.now() / 1_000) + 3_600,
    });
    if (withApproval) {
      const approval = deferred<unknown>();
      this.approvals.set(id, approval);
    }
  }

  expireNow(id: number, emitEvent = true): void {
    this.proposals = this.proposals.filter((proposal) => proposal.id !== id);
    this.pendingSessions.delete(id);
    const approval = this.approvals.get(id);
    this.approvals.delete(id);
    approval?.reject({ code: 0 });
    if (emitEvent) this.emit("proposal_expire", { id });
  }

  waitForExpirationRequest(id: number): Promise<void> {
    if (this.expirations.includes(id)) return Promise.resolve();
    return this.expirationRequest(id).promise;
  }

  waitForPairingDisconnectRequest(topic: string): Promise<void> {
    if (this.pairingDisconnects.includes(topic)) return Promise.resolve();
    return this.pairingDisconnectRequest(topic).promise;
  }

  holdSettle(): Deferred<void> {
    const barrier = deferred<void>();
    this.settleBarrier = barrier;
    return barrier;
  }

  releaseHeldWork(): void {
    this.settleBarrier?.resolve();
    this.settleBarrier = undefined;
    this.holdExpiration = false;
    for (const id of new Set(this.expirations)) {
      if (this.proposals.some((proposal) => proposal.id === id)) {
        this.expireNow(id, this.emitExpirationEvent);
      }
    }
  }

  assertReleased(): void {
    const liveListenerCount = [...this.listeners.values()]
      .reduce((count, listeners) => count + listeners.size, 0);
    if (
      this.proposals.length !== 0 ||
      this.pendingSessions.size !== 0 ||
      this.approvals.size !== 0 ||
      liveListenerCount !== 0
    ) {
      throw new TypeError("Pinned protocol harness retained owned work after cleanup.");
    }
  }

  discardUnownedProtocolStateAfterAssertion(): void {
    this.proposals = [];
    this.pairings = [];
    this.sessions = [];
    this.pendingSessions.clear();
    this.approvals.clear();
    this.listeners.clear();
  }

  private connect(): { readonly uri: string; readonly approval: () => Promise<unknown> } {
    const id = this.nextProposalId;
    this.nextProposalId += 1;
    const pairingTopic = this.nextPairingIndex === 0 ? firstPairingTopic : secondPairingTopic;
    this.nextPairingIndex += 1;
    this.seedProposal(id, pairingTopic);
    this.pairings.push({ topic: pairingTopic });
    this.connectionProposalStoreActive = true;
    if (
      this.connectionProposalMode === "multiple" ||
      this.connectionProposalMode === "mismatched"
    ) {
      this.pairings.push({ topic: secondPairingTopic });
    }
    const approval = this.approvals.get(id);
    if (approval === undefined) throw new TypeError("Approval authority is unavailable.");
    return {
      uri: this.connectionUriOverride ??
        `wc:${pairingTopic}@2?relay-protocol=irn&symKey=${publicKey}`,
      approval: () => {
        this.approvalCalls += 1;
        return approval.promise;
      },
    };
  }

  private readProposalStore(): readonly unknown[] {
    if (!this.connectionProposalStoreActive || this.connectionProposalMode === "exact") {
      return this.proposals;
    }
    if (this.connectionProposalMode === "none") return [];
    const proposal = this.proposals[0];
    if (proposal === undefined) return [];
    if (this.connectionProposalMode === "malformed") {
      return [{ ...proposal, id: "not-a-proposal-id" }];
    }
    if (this.connectionProposalMode === "mismatched") {
      return [{ ...proposal, pairingTopic: secondPairingTopic }];
    }
    return [
      proposal,
      {
        id: proposal.id + 1,
        pairingTopic: secondPairingTopic,
        expiryTimestamp: proposal.expiryTimestamp,
      },
    ];
  }

  private expirationRequest(id: number): Deferred<void> {
    const existing = this.expirationRequests.get(id);
    if (existing !== undefined) return existing;
    const created = deferred<void>();
    this.expirationRequests.set(id, created);
    return created;
  }

  private pairingDisconnectRequest(topic: string): Deferred<void> {
    const existing = this.pairingDisconnectRequests.get(topic);
    if (existing !== undefined) return existing;
    const created = deferred<void>();
    this.pairingDisconnectRequests.set(topic, created);
    return created;
  }

  private emit(event: string, value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }
}

type AcquisitionOutcome =
  | Readonly<{ status: "fulfilled"; acquisition: WalletConnectClientAcquisition }>
  | Readonly<{ status: "rejected"; error: unknown }>;

interface ManagedAcquisition {
  get(): Promise<WalletConnectClientAcquisition>;
  waitForExpirationRequest(id: number): Promise<void>;
  close(): Promise<void>;
}

const beginAcquisition = (harness: PinnedProtocolHarness): ManagedAcquisition => {
  class TestSignClient {
    static async init(): Promise<unknown> {
      return harness.client;
    }
  }
  const scope = createWalletConnectAcquisitionScope();
  const outcome: Promise<AcquisitionOutcome> = createWalletConnectClient(
    { projectId, metadata, privateStoreDirectory: storeDirectory },
    scope.resources,
    new AbortController().signal,
    undefined,
    async (key) => key === "signClient"
      ? { SignClient: TestSignClient }
      : {
          create: () => ({
            modules: { size: 21, data: new Uint8Array(21 * 21) },
          }),
        },
  ).then(
    (acquisition) => Object.freeze({ status: "fulfilled", acquisition }),
    (error: unknown) => Object.freeze({ status: "rejected", error }),
  );
  let closed = false;
  return Object.freeze({
    async get(): Promise<WalletConnectClientAcquisition> {
      const result = await outcome;
      if (result.status === "rejected") throw result.error;
      return result.acquisition;
    },
    async waitForExpirationRequest(id: number): Promise<void> {
      const observed = await Promise.race([
        harness.waitForExpirationRequest(id).then(() =>
          Object.freeze({ kind: "expiration" as const })),
        outcome.then((result) => Object.freeze({ kind: "acquisition" as const, result })),
      ]);
      if (observed.kind === "expiration") return;
      if (observed.result.status === "rejected") throw observed.result.error;
      throw new TypeError("Acquisition completed before the expected proposal expiration.");
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      harness.releaseHeldWork();
      let closeFailure: unknown;
      try { await scope.close(); }
      catch (error: unknown) { closeFailure ??= error; }
      await outcome;
      if (!scope.empty || scope.size !== 0) {
        closeFailure ??= new TypeError("Initialization scope retained resources after cleanup.");
      }
      harness.assertReleased();
      if (closeFailure !== undefined) throw closeFailure;
    },
  });
};

const withAcquisition = async <Result>(
  harness: PinnedProtocolHarness,
  action: (acquisition: WalletConnectClientAcquisition) => Promise<Result>,
): Promise<Result> => {
  return withManagedAcquisition(harness, async (managed) =>
    action(await managed.get()));
};

const withManagedAcquisition = async <Result>(
  harness: PinnedProtocolHarness,
  action: (managed: ManagedAcquisition) => Promise<Result>,
): Promise<Result> => {
  const managed = beginAcquisition(harness);
  let value: Result | undefined;
  let actionFailure: unknown;
  try {
    value = await action(managed);
  } catch (error: unknown) {
    actionFailure = error;
  }
  let cleanupFailure: unknown;
  try { await managed.close(); }
  catch (error: unknown) { cleanupFailure = error; }
  if (actionFailure !== undefined && cleanupFailure !== undefined) {
    throw new AggregateError(
      [actionFailure, cleanupFailure],
      "Pinned protocol behavior and cleanup both failed.",
    );
  }
  if (actionFailure !== undefined) throw actionFailure;
  if (cleanupFailure !== undefined) throw cleanupFailure;
  return value as Result;
};

const withExpectedUnownedProtocolState = async <Result>(
  harness: PinnedProtocolHarness,
  action: (managed: ManagedAcquisition) => Promise<Result>,
): Promise<Result> => {
  const managed = beginAcquisition(harness);
  let value: Result | undefined;
  let actionFailure: unknown;
  try {
    value = await action(managed);
  } catch (error: unknown) {
    actionFailure = error;
  }
  harness.discardUnownedProtocolStateAfterAssertion();
  let cleanupFailure: unknown;
  try { await managed.close(); }
  catch (error: unknown) { cleanupFailure = error; }
  if (actionFailure !== undefined && cleanupFailure !== undefined) {
    throw new AggregateError(
      [actionFailure, cleanupFailure],
      "Unowned protocol-state assertion and cleanup both failed.",
    );
  }
  if (actionFailure !== undefined) throw actionFailure;
  if (cleanupFailure !== undefined) throw cleanupFailure;
  return value as Result;
};

describe("pinned WalletConnect proposal cancellation", () => {
  it("owns approval immediately and completes one exact approved session", async () => {
    const harness = new PinnedProtocolHarness();

    await withAcquisition(harness, async (acquisition) => {
      const attempt = await acquisition.client.startConnection();
      const proposal = harness.proposals[0];
      if (proposal === undefined) throw new TypeError("Expected one proposal.");
      expect(harness.approvalCalls).toBe(1);

      const firstWait = attempt.wait();
      const secondWait = attempt.wait();
      await harness.engine.onSessionProposeResponse(proposal.pairingTopic, {
        id: proposal.id,
      });
      await harness.engine.onSessionSettleRequest(firstSessionTopic, { id: 1 });

      const [firstOutcome, secondOutcome] = await Promise.all([firstWait, secondWait]);
      expect(firstOutcome).toBe(secondOutcome);
      expect(firstOutcome).toMatchObject({
        status: "approved",
        session: { topic: firstSessionTopic },
      });
      expect(harness.proposals).toEqual([]);
      expect(harness.pendingSessions.size).toBe(0);
      expect(harness.sessions).toEqual([sdkSession(firstSessionTopic, firstPairingTopic)]);
      expect(harness.pairings).toEqual([{ topic: firstPairingTopic }]);

      await harness.engine.onSessionProposeResponse(proposal.pairingTopic, {
        id: proposal.id,
      });
      await harness.engine.onSessionSettleRequest(firstSessionTopic, { id: 2 });
      expect(harness.approvalCalls).toBe(1);
      expect(harness.sessions).toEqual([sdkSession(firstSessionTopic, firstPairingTopic)]);
      await expect(attempt.cancel()).resolves.toBe(firstOutcome);
    });

    expect(harness.sessions).toEqual([sdkSession(firstSessionTopic, firstPairingTopic)]);
    expect(harness.pairings).toEqual([{ topic: firstPairingTopic }]);
    expect(harness.transportCloseCalls).toBe(1);
    expect(harness.heartbeatStopCalls).toBe(1);
  });

  it("closes new session writes while approval state is being finalized", async () => {
    const harness = new PinnedProtocolHarness();

    await withAcquisition(harness, async (acquisition) => {
      const attempt = await acquisition.client.startConnection();
      const proposal = harness.proposals[0];
      if (proposal === undefined) throw new TypeError("Expected one proposal.");
      await harness.engine.onSessionProposeResponse(proposal.pairingTopic, {
        id: proposal.id,
      });

      const settleGate = harness.holdSettle();
      harness.sessionSetObserved = deferred<void>();
      const waiting = attempt.wait();
      const settling = harness.engine.onSessionSettleRequest(firstSessionTopic, { id: 1 });
      await harness.sessionSetObserved.promise;

      const lateWrite = {
        outcome: undefined as Promise<"fulfilled" | "rejected"> | undefined,
      };
      const finishingRead = harness.sessionReadCount + 2;
      harness.sessionReadHook = (readCount) => {
        if (readCount !== finishingRead) return;
        harness.sessionReadHook = undefined;
        lateWrite.outcome = harness.sessionStore.set(firstSessionTopic, {
          ...sdkSession(firstSessionTopic, firstPairingTopic),
          expiry: 1_783_791_907,
        }).then(() => "fulfilled", () => "rejected");
      };

      settleGate.resolve();
      await settling;
      await expect(waiting).resolves.toMatchObject({ status: "approved" });
      if (lateWrite.outcome === undefined) {
        throw new TypeError("Expected a session write at the finalization read boundary.");
      }
      await expect(lateWrite.outcome).resolves.toBe("rejected");
      expect(harness.sessions).toEqual([sdkSession(firstSessionTopic, firstPairingTopic)]);
    });
  });

  it("serializes repeated cancellation through one exact protocol transition", async () => {
    const harness = new PinnedProtocolHarness();

    await withAcquisition(harness, async (acquisition) => {
      const attempt = await acquisition.client.startConnection();
      const proposal = harness.proposals[0];
      if (proposal === undefined) throw new TypeError("Expected one proposal.");

      const firstCancellation = attempt.cancel();
      const secondCancellation = attempt.cancel();
      expect(firstCancellation).toBe(secondCancellation);
      await expect(Promise.all([firstCancellation, secondCancellation])).resolves.toEqual([
        { status: "cancelled" },
        { status: "cancelled" },
      ]);
      expect(harness.approvalCalls).toBe(1);
      expect(harness.pairingDisconnects).toEqual([proposal.pairingTopic]);
      expect(harness.expirations).toEqual([proposal.id]);
    });
  });

  it("requires exact proposal, pairing, pending-map, and session-topic identity", async () => {
    const harness = new PinnedProtocolHarness();
    await withAcquisition(harness, async (acquisition) => {
      const attempt = await acquisition.client.startConnection();
      const proposal = harness.proposals[0];
      if (proposal === undefined) throw new TypeError("Expected one proposal.");
      expect(harness.approvalCalls).toBe(1);

      await expect(harness.engine.onSessionProposeResponse(secondPairingTopic, {
        id: proposal.id,
      })).rejects.toMatchObject({ code: "sdk_unavailable" });
      await expect(harness.engine.onSessionProposeResponse(proposal.pairingTopic, {
        id: proposal.id + 1,
      })).rejects.toMatchObject({ code: "sdk_unavailable" });
      expect(harness.pendingSessions.size).toBe(0);

      await harness.engine.onSessionProposeResponse(proposal.pairingTopic, { id: proposal.id });
      const pending = harness.pendingSessions.get(proposal.id);
      if (pending === undefined) throw new TypeError("Expected one pending session.");
      harness.pendingSessions.delete(proposal.id);
      harness.pendingSessions.set(proposal.id + 1, pending);
      await expect(harness.engine.onSessionSettleRequest(firstSessionTopic, {
        id: 1,
      })).rejects.toMatchObject({ code: "sdk_unavailable" });
      expect(harness.sessions).toEqual([]);

      harness.pendingSessions.delete(proposal.id + 1);
      harness.pendingSessions.set(proposal.id, pending);
      await expect(attempt.cancel()).resolves.toEqual({ status: "cancelled" });
    });
  });

  it("drains a full settle handler and quarantines only its concurrent session", async () => {
    const harness = new PinnedProtocolHarness();
    await withAcquisition(harness, async (acquisition) => {
      const attempt = await acquisition.client.startConnection();
      const proposal = harness.proposals[0];
      if (proposal === undefined) throw new TypeError("Expected one proposal.");
      await harness.engine.onSessionProposeResponse(proposal.pairingTopic, { id: proposal.id });

      const settleGate = harness.holdSettle();
      harness.sessionSetObserved = deferred<void>();
      const settling = harness.engine.onSessionSettleRequest(firstSessionTopic, { id: 1 });
      await harness.sessionSetObserved.promise;
      harness.sessions.push(sdkSession(secondSessionTopic, secondPairingTopic));
      harness.pairings.push({ topic: secondPairingTopic });

      const cancellation = attempt.cancel();
      let cancellationSettled = false;
      void cancellation.then(() => { cancellationSettled = true; });
      await harness.waitForPairingDisconnectRequest(proposal.pairingTopic);
      expect(cancellationSettled).toBe(false);

      settleGate.resolve();
      await settling;
      await expect(cancellation).resolves.toEqual({ status: "cancelled" });
      expect(harness.sessions).toEqual([sdkSession(secondSessionTopic, secondPairingTopic)]);
      expect(harness.pendingSessions.size).toBe(0);
      expect(harness.proposals).toEqual([]);
    });
  });

  it("blocks settle and duplicate response processing after the cancellation tombstone", async () => {
    const harness = new PinnedProtocolHarness();
    harness.holdExpiration = true;
    await withAcquisition(harness, async (acquisition) => {
      const attempt = await acquisition.client.startConnection();
      const proposal = harness.proposals[0];
      if (proposal === undefined) throw new TypeError("Expected one proposal.");
      await harness.engine.onSessionProposeResponse(proposal.pairingTopic, { id: proposal.id });

      const cancellation = attempt.cancel();
      await harness.waitForExpirationRequest(proposal.id);
      expect(harness.expirations).toEqual([proposal.id]);
      await harness.engine.onSessionSettleRequest(firstSessionTopic, { id: 1 });
      expect(harness.sessions).toEqual([]);
      harness.expireNow(proposal.id);
      await expect(cancellation).resolves.toEqual({ status: "cancelled" });

      await harness.engine.onSessionProposeResponse(proposal.pairingTopic, { id: proposal.id });
      await harness.engine.onSessionSettleRequest(firstSessionTopic, { id: 2 });
      expect(harness.sessions).toEqual([]);
    });
  });

  it("expires a restored proposal behind a baseline-session fence without deleting the session", async () => {
    const harness = new PinnedProtocolHarness();
    const proposalId = 90;
    harness.seedProposal(proposalId, firstPairingTopic, false);
    harness.pairings.push({ topic: firstPairingTopic });
    const baseline = sdkSession(firstSessionTopic, firstPairingTopic);
    harness.sessions.push(baseline);
    harness.holdExpiration = true;

    await withManagedAcquisition(harness, async (managed) => {
      await managed.waitForExpirationRequest(proposalId);
      expect(harness.expirations).toEqual([proposalId]);
      await harness.engine.onSessionProposeResponse(firstPairingTopic, { id: proposalId });
      expect(harness.pendingSessions.size).toBe(0);
      harness.expireNow(proposalId);

      const acquisition = await managed.get();
      expect(acquisition.client.listSessions().map(({ topic }) => topic)).toEqual([
        firstSessionTopic,
      ]);
      expect(harness.pairings).toEqual([{ topic: firstPairingTopic }]);
    });
  });

  it("does not preserve changed session data merely because its topic is unchanged", async () => {
    const harness = new PinnedProtocolHarness();
    const proposalId = 91;
    harness.seedProposal(proposalId, firstPairingTopic, false);
    harness.pairings.push({ topic: firstPairingTopic });
    harness.sessions.push(sdkSession(firstSessionTopic, firstPairingTopic));
    harness.holdExpiration = true;

    await withManagedAcquisition(harness, async (managed) => {
      await managed.waitForExpirationRequest(proposalId);
      expect(harness.expirations).toEqual([proposalId]);
      harness.sessions = [{
        ...sdkSession(firstSessionTopic, firstPairingTopic),
        expiry: 1_783_791_907,
      }];
      harness.expireNow(proposalId);

      const acquisition = await managed.get();
      expect(acquisition.client.listSessions()).toEqual([]);
      expect(harness.sessions).toEqual([]);
      expect(harness.pairings).toEqual([]);
    });
  });

  it("still expires the proposal and fails closed when pairing removal cannot be proven", async () => {
    const harness = new PinnedProtocolHarness();
    harness.failPairingDisconnect = true;
    await withAcquisition(harness, async (acquisition) => {
      const attempt = await acquisition.client.startConnection();
      const proposal = harness.proposals[0];
      if (proposal === undefined) throw new TypeError("Expected one proposal.");

      await expect(attempt.cancel()).resolves.toEqual({ status: "failed" });
      expect(harness.expirations).toEqual([proposal.id]);
      expect(harness.proposals).toEqual([]);
      expect(harness.pairings).toEqual([{ topic: proposal.pairingTopic }]);
      expect(() => acquisition.client.listSessions()).toThrow("WalletConnect is unavailable");
    });
  });

  it("fails and closes the adapter when exact proposal-listener release is unproven", async () => {
    const harness = new PinnedProtocolHarness();
    harness.failProposalListenerRemoval = true;

    await withExpectedUnownedProtocolState(harness, async (managed) => {
      const acquisition = await managed.get();
      const attempt = await acquisition.client.startConnection();
      const proposal = harness.proposals[0];
      if (proposal === undefined) throw new TypeError("Expected one proposal.");

      await expect(attempt.cancel()).resolves.toEqual({ status: "failed" });
      expect(harness.expirations).toEqual([proposal.id]);
      expect(harness.proposals).toEqual([]);
      expect(harness.pairings).toEqual([]);
      expect(harness.listeners.get("proposal_expire")?.size).toBe(1);
      expect(() => acquisition.client.listSessions()).toThrow("WalletConnect is unavailable");
      expect(harness.transportCloseCalls).toBe(1);
      expect(harness.heartbeatStopCalls).toBe(1);
    });
  });

  it("accepts repeated authoritative proposal absence when the expiry event is lost", async () => {
    const harness = new PinnedProtocolHarness();
    harness.emitExpirationEvent = false;
    await withAcquisition(harness, async (acquisition) => {
      const attempt = await acquisition.client.startConnection();
      const proposal = harness.proposals[0];
      if (proposal === undefined) throw new TypeError("Expected one proposal.");

      await expect(attempt.cancel()).resolves.toEqual({ status: "cancelled" });
      expect(harness.expirations).toEqual([proposal.id]);
      expect(harness.proposals).toEqual([]);
      expect(harness.pairings).toEqual([]);
    });
  });

  it.each([
    ["missing symmetric key", `wc:${firstPairingTopic}@2?relay-protocol=irn`],
    ["invalid symmetric key", `wc:${firstPairingTopic}@2?relay-protocol=irn&symKey=bad`],
    ["missing relay protocol", `wc:${firstPairingTopic}@2?symKey=${publicKey}`],
    ["unexpected parameter", `wc:${firstPairingTopic}@2?foo=bar&relay-protocol=irn&symKey=${publicKey}`],
    ["duplicate parameter", `wc:${firstPairingTopic}@2?relay-protocol=irn&symKey=${publicKey}&symKey=${publicKey}`],
    ["unsupported relay protocol", `wc:${firstPairingTopic}@2?relay-protocol=other&symKey=${publicKey}`],
  ])("rejects a %s without treating it as pairing cleanup authority", async (_caseName, uri) => {
    const harness = new PinnedProtocolHarness();
    harness.connectionUriOverride = uri;
    await withExpectedUnownedProtocolState(harness, async (managed) => {
      const acquisition = await managed.get();

      await expect(acquisition.client.startConnection()).rejects.toMatchObject({
        code: "sdk_unavailable",
      });
      expect(harness.approvalCalls).toBe(0);
      expect(harness.expirations).toEqual([]);
      expect(harness.pairingDisconnects).toEqual([]);
      expect(harness.proposals).toHaveLength(1);
      expect(harness.pairings).toEqual([{ topic: firstPairingTopic }]);
      expect(harness.transportCloseCalls).toBe(1);
      expect(harness.heartbeatStopCalls).toBe(1);
    });
  });

  it.each([
    ["no proposal", "none"],
    ["multiple proposals", "multiple"],
    ["a malformed proposal", "malformed"],
    ["a proposal for another pairing", "mismatched"],
  ] as const)("poisons an ambiguous handoff with %s without expiring any proposal", async (
    _caseName,
    proposalMode,
  ) => {
    const harness = new PinnedProtocolHarness();
    harness.connectionProposalMode = proposalMode;

    await withExpectedUnownedProtocolState(harness, async (managed) => {
      const acquisition = await managed.get();
      await expect(acquisition.client.startConnection()).rejects.toMatchObject({
        code: "sdk_unavailable",
      });

      expect(harness.approvalCalls).toBe(0);
      expect(harness.expirations).toEqual([]);
      expect(harness.proposals).toHaveLength(1);
      expect(harness.pairingDisconnects).toEqual([firstPairingTopic]);
      expect(harness.pairings).toEqual(
        proposalMode === "multiple" || proposalMode === "mismatched"
          ? [{ topic: secondPairingTopic }]
          : [],
      );
      expect(() => acquisition.client.listSessions()).toThrow("WalletConnect is unavailable");
      expect(harness.transportCloseCalls).toBe(1);
      expect(harness.heartbeatStopCalls).toBe(1);
    });
  });
});
