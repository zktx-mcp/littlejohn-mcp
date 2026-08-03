import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { readRuntimeConfiguration } from "../../src/runtime/configuration.js";
import type { WalletSessionSource } from "../../src/runtime/source-identity.js";
import { walletPeerRefusalCodes } from "../../src/wallet/contracts.js";
import type { WalletConnectSdkStorage, WalletConnectStorageOwner } from
  "../../src/wallet/walletconnect-storage.js";
import {
  createWalletConnectClient,
  createWalletConnectAcquisitionScope,
  isWalletConnectClientError,
  loadWalletConnectProductionDependencies,
  type WalletConnectClientAcquisition,
  type WalletConnectClientErrorCode,
  type WalletConnectClientEvent,
  type WalletConnectSdkConnectInput,
  type WalletConnectSdkEventListener,
  type WalletConnectSdkEventName,
  type WalletConnectSdkFactory,
  type WalletConnectSdkInitOptions,
  type WalletConnectSdkPort,
  type WalletExternalModuleLoader,
} from "../../src/wallet/walletconnect-client.js";
import { createWalletConnectConfiguration } from
  "../../src/wallet/walletconnect-configuration.js";

const runtime = readRuntimeConfiguration({});
const wallet = createWalletConnectConfiguration("1".repeat(32), runtime.chain);
const chainId = runtime.chain.chainId;
const pairingTopic = "2".repeat(64);
const sessionTopic = "3".repeat(64);
const secondSessionTopic = "4".repeat(64);
const pairingUri = `wc:${pairingTopic}@2?relay-protocol=irn&symKey=${"5".repeat(64)}`;
const address = "0x1111111111111111111111111111111111111111";

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

const nextTurn = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
};

const namespace = (chains: "absent" | "empty" | "configured" = "configured"): object => ({
  ...(chains === "absent" ? {} : { chains: chains === "empty" ? [] : [chainId] }),
  accounts: [`${chainId}:${address}`],
  methods: ["eth_sendTransaction"],
  events: ["accountsChanged", "chainChanged"],
});

const session = (
  topic = sessionTopic,
  chains: "absent" | "empty" | "configured" = "configured",
): object => ({
  topic,
  expiry: 1_900_000_000,
  namespaces: { eip155: namespace(chains) },
  relay: { secret: "must not escape" },
});

const proposal = (id = 1, topic = pairingTopic): object => ({
  id,
  pairingTopic: topic,
  expiryTimestamp: 1_900_000_000,
});

const sessionSource = (topic: string): WalletSessionSource => {
  const topicDigest = createHmac("sha256", "walletconnect-client-test-source-key")
    .update(topic)
    .digest("base64url");
  const sourceId = `wallet-session:${topicDigest}`;
  return Object.freeze({
    sourceId,
    candidateId: sourceId,
    topicDigest,
    observationAuthority: Object.freeze({}) as WalletSessionSource["observationAuthority"],
  });
};

class FakeStorageOwner implements WalletConnectStorageOwner {
  readonly storage: WalletConnectSdkStorage = Object.freeze({
    getKeys: async () => [],
    getEntries: async () => [],
    getItem: async () => undefined,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  });
  revision = 0n;
  checkpointValues: bigint[] = [];
  readonly log: string[] = [];
  sealedRevision: bigint | undefined;
  closeCount = 0;
  checkpointFailure: unknown;

  constructor(private readonly trace: string[] = []) {}

  checkpoint(): bigint {
    this.log.push("checkpoint");
    this.trace.push("checkpoint");
    if (this.checkpointFailure !== undefined) throw this.checkpointFailure;
    return this.checkpointValues.shift() ?? this.revision;
  }

  seal(expectedRevision: bigint): void {
    this.log.push(`seal:${expectedRevision}`);
    if (expectedRevision !== this.revision) throw new Error("revision changed");
    this.sealedRevision = expectedRevision;
  }

  close(): void {
    this.log.push("storage-close");
    this.closeCount += 1;
  }
}

class FakeSdk implements WalletConnectSdkPort {
  proposals: unknown[] = [];
  sessions: unknown[] = [];
  approval = deferred<unknown>();
  approvalCallCount = 0;
  connectionUri: string | undefined = pairingUri;
  addProposalOnConnect = true;
  proposalsOnConnect: unknown[] | undefined;
  readonly connectInputs: WalletConnectSdkConnectInput[] = [];
  readonly expiredProposalIds: number[] = [];
  readonly pairingDisconnects: string[] = [];
  readonly sessionDisconnects: string[] = [];
  readonly listeners = new Map<WalletConnectSdkEventName, Set<WalletConnectSdkEventListener>>();
  readonly log: string[] = [];
  listProposalFailure: unknown;
  listSessionFailure: unknown;
  onListSessions: (() => void) | undefined;
  pairingDisconnectFailure: unknown;
  expireProposalFailure: unknown;
  connectionResult: unknown = undefined;

  constructor(private readonly trace: string[] = []) {}

  listProposals(): readonly unknown[] {
    this.log.push("proposals");
    this.trace.push("proposals");
    if (this.listProposalFailure !== undefined) throw this.listProposalFailure;
    return this.proposals;
  }

  listSessions(): readonly unknown[] {
    this.log.push("sessions");
    this.trace.push("sessions");
    if (this.listSessionFailure !== undefined) throw this.listSessionFailure;
    this.onListSessions?.();
    return this.sessions;
  }

  async startConnection(input: WalletConnectSdkConnectInput): Promise<unknown> {
    this.log.push("connect");
    this.connectInputs.push(input);
    if (this.proposalsOnConnect !== undefined) this.proposals = this.proposalsOnConnect;
    else if (this.addProposalOnConnect) this.proposals = [...this.proposals, proposal()];
    if (this.connectionResult !== undefined) return this.connectionResult;
    return {
      ...(this.connectionUri === undefined ? {} : { uri: this.connectionUri }),
      approval: () => {
        this.approvalCallCount += 1;
        return this.approval.promise;
      },
    };
  }

  expireProposal(id: number): void {
    this.log.push(`expire:${id}`);
    this.expiredProposalIds.push(id);
    if (this.expireProposalFailure !== undefined) throw this.expireProposalFailure;
  }

  async disconnectPairing(topic: string): Promise<void> {
    this.log.push(`pairing-disconnect:${topic}`);
    this.pairingDisconnects.push(topic);
    if (this.pairingDisconnectFailure !== undefined) throw this.pairingDisconnectFailure;
  }

  async disconnectSession(topic: string): Promise<void> {
    this.log.push(`session-disconnect:${topic}`);
    this.sessionDisconnects.push(topic);
  }

  on(event: WalletConnectSdkEventName, listener: WalletConnectSdkEventListener): void {
    this.log.push(`on:${event}`);
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  off(event: WalletConnectSdkEventName, listener: WalletConnectSdkEventListener): void {
    this.log.push(`off:${event}`);
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: WalletConnectSdkEventName, value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }
}

const qrModule = (matrix: unknown = {
  modules: { size: 21, data: new Uint8Array(21 * 21) },
}): object => ({ create: () => matrix });

class UnusedSignClient {
  static async init(): Promise<never> {
    throw new Error("custom SDK factory owns initialization");
  }
}

const moduleLoader = (qr: unknown = qrModule()): WalletExternalModuleLoader => async (key) =>
  key === "signClient" ? { SignClient: UnusedSignClient } : qr;

interface CreatedClient {
  readonly acquisition: WalletConnectClientAcquisition;
  readonly scope: ReturnType<typeof createWalletConnectAcquisitionScope>;
  readonly sdk: FakeSdk;
  readonly storage: FakeStorageOwner;
  readonly options: WalletConnectSdkInitOptions;
}

const createClient = async (input: {
  readonly sdk?: FakeSdk;
  readonly storage?: FakeStorageOwner;
  readonly loader?: WalletExternalModuleLoader;
  readonly signal?: AbortSignal;
  readonly createSource?: (topic: string) => WalletSessionSource;
} = {}): Promise<CreatedClient> => {
  const sdk = input.sdk ?? new FakeSdk();
  const storage = input.storage ?? new FakeStorageOwner();
  const scope = createWalletConnectAcquisitionScope();
  const storageRegistration = scope.resources.register(storage);
  let options: WalletConnectSdkInitOptions | undefined;
  const factory: WalletConnectSdkFactory = async (candidate) => {
    options = candidate;
    return sdk;
  };
  const acquisition = await createWalletConnectClient({
    wallet,
    storageOwner: storage,
    createSessionSource: input.createSource ?? sessionSource,
  }, storageRegistration, input.signal ?? new AbortController().signal, factory,
  input.loader ?? moduleLoader());
  if (options === undefined) throw new Error("SDK factory was not called");
  return Object.freeze({ acquisition, scope, sdk, storage, options });
};

const containCreatedClient = async (created: CreatedClient): Promise<void> => {
  await expect(created.scope.close()).rejects.toMatchObject({
    name: "ProcessTerminalRequiredError",
  });
  expect(created.storage.closeCount).toBe(0);
};

const expectClientError = async (
  operation: Promise<unknown> | (() => unknown),
  code: WalletConnectClientErrorCode,
): Promise<void> => {
  let failure: unknown;
  try {
    if (typeof operation === "function") operation();
    else await operation;
  } catch (error) {
    failure = error;
  }
  expect(isWalletConnectClientError(failure)).toBe(true);
  if (isWalletConnectClientError(failure)) {
    expect(failure.code).toBe(code);
    expect(failure.message).not.toContain(pairingTopic);
    expect(failure.message).not.toContain(sessionTopic);
  }
};

describe("WalletConnect public adapter boundary", () => {
  it("injects the exact storage facade and sends only optional namespaces", async () => {
    const created = await createClient();
    expect(created.options.storage).toBe(created.storage.storage);
    expect(created.options).not.toHaveProperty("storageOptions");
    expect(created.options.telemetryEnabled).toBe(false);

    const attempt = await created.acquisition.client.startConnection();
    expect(created.sdk.connectInputs).toEqual([{
      optionalNamespaces: {
        eip155: {
          chains: [chainId],
          methods: ["eth_sendTransaction"],
          events: ["accountsChanged", "chainChanged"],
        },
      },
    }]);
    expect(created.sdk.connectInputs[0]).not.toHaveProperty("requiredNamespaces");
    const cancellation = attempt.cancel();
    created.sdk.approval.reject(new Error("proposal expired"));
    await cancellation;
    await containCreatedClient(created);
  });

  it("admits one unchanged storage revision in the exact read order", async () => {
    const trace: string[] = [];
    const created = await createClient({
      sdk: new FakeSdk(trace),
      storage: new FakeStorageOwner(trace),
    });
    created.sdk.sessions = [session()];
    created.sdk.log.length = 0;
    created.storage.log.length = 0;

    const observed = created.acquisition.client.observe();

    expect(trace).toEqual(["checkpoint", "proposals", "sessions", "checkpoint"]);
    expect(created.storage.log).toEqual(["checkpoint", "checkpoint"]);
    expect(created.sdk.log).toEqual(["proposals", "sessions"]);
    expect(observed.revision).toBe(0n);
    expect(observed.proposalCount).toBe(0);
    expect(observed.sessions).toHaveLength(1);
    expect(observed.sessions[0]).toMatchObject({
      status: "valid",
      source: { sourceId: sessionSource(sessionTopic).sourceId },
      expiry: 1_900_000_000,
    });
    expect(observed.sessions[0]).not.toHaveProperty("topic");
    expect(observed.sessions[0]).not.toHaveProperty("relay");
    const publicProjection = JSON.stringify(observed.sessions);
    expect(publicProjection).not.toContain(sessionTopic);
    expect(publicProjection).not.toContain(pairingTopic);
    expect(publicProjection).not.toContain("5".repeat(64));
    await containCreatedClient(created);
  });

  it("preserves absent chains, explicit empty chains, and addressable invalid entries", async () => {
    const created = await createClient();
    created.sdk.sessions = [
      session(sessionTopic, "absent"),
      session(secondSessionTopic, "empty"),
      { topic: "6".repeat(64), expiry: -1, namespaces: {} },
    ];

    const observed = created.acquisition.client.observe();
    expect(observed.sessions).toHaveLength(3);
    const first = observed.sessions[0];
    const second = observed.sessions[1];
    expect(first?.status).toBe("valid");
    expect(second?.status).toBe("valid");
    if (first?.status === "valid" && second?.status === "valid") {
      expect(first.namespaces["eip155"]).not.toHaveProperty("chains");
      expect(second.namespaces["eip155"]?.chains).toEqual([]);
    }
    expect(observed.sessions[2]).toMatchObject({ status: "invalid" });
    expect(observed.sessions[2]).toHaveProperty("source");
    await containCreatedClient(created);
  });

  it("makes the whole observation unavailable when any SDK session is unaddressable", async () => {
    const created = await createClient();
    created.sdk.sessions = [session(), { topic: "not-a-topic" }];

    await expectClientError(() => created.acquisition.client.observe(), "observation");
    await containCreatedClient(created);
  });

  it("never turns a changing revision, failed read, or source-admission failure into emptiness", async () => {
    const changingStorage = new FakeStorageOwner();
    changingStorage.checkpointValues = [3n, 4n];
    const changing = await createClient({ storage: changingStorage });
    await expectClientError(() => changing.acquisition.client.observe(), "observation");
    await containCreatedClient(changing);

    const readFailureSdk = new FakeSdk();
    readFailureSdk.listSessionFailure = new Error("secret SDK failure");
    const readFailure = await createClient({ sdk: readFailureSdk });
    await expectClientError(() => readFailure.acquisition.client.observe(), "observation");
    await containCreatedClient(readFailure);

    const sourceFailure = await createClient({
      createSource: () => { throw new Error("local source failure"); },
    });
    sourceFailure.sdk.sessions = [session()];
    await expectClientError(() => sourceFailure.acquisition.client.observe(), "observation");
    await containCreatedClient(sourceFailure);
  });

  it("copies SDK arrays from data descriptors without invoking value getters", async () => {
    const created = await createClient();
    const target = [session()];
    created.sdk.sessions = new Proxy(target, {
      get: () => { throw new Error("array value getter must not run"); },
    });

    const observation = created.acquisition.client.observe();
    expect(observation.sessions).toHaveLength(1);
    expect(observation.sessions[0]?.status).toBe("valid");
    await containCreatedClient(created);
  });

  it("returns each admitted peer refusal as its exact numeric code", async () => {
    for (const peerRefusalCode of walletPeerRefusalCodes) {
      const created = await createClient();
      const attempt = await created.acquisition.client.startConnection();
      created.sdk.approval.reject(Object.assign(new Error("raw peer message"), {
        code: peerRefusalCode,
      }));
      await expect(attempt.wait()).resolves.toEqual({ status: "rejected", peerRefusalCode });
      await containCreatedClient(created);
    }
  });

  it("does not guess request and responder error codes as Connect refusal", async () => {
    for (const code of [1001, 1002, 1003, 1004, 1005, 3001, 3002, 3003, 3004]) {
      const created = await createClient();
      const attempt = await created.acquisition.client.startConnection();
      created.sdk.approval.reject(Object.assign(new Error("raw SDK message"), { code }));
      await expect(attempt.wait()).resolves.toEqual({ status: "failed", failure: "sdk" });
      await containCreatedClient(created);
    }
  });

  it("withdraws local approval authority monotonically and cleans a late session", async () => {
    const created = await createClient();
    const attempt = await created.acquisition.client.startConnection();

    let cancellationSettled = false;
    const cancellation = attempt.cancel().then((outcome) => {
      cancellationSettled = true;
      return outcome;
    });
    await nextTurn();
    expect(created.sdk.expiredProposalIds).toEqual([1]);
    expect(created.sdk.pairingDisconnects).toEqual([pairingTopic]);
    expect(cancellationSettled).toBe(false);
    await expectClientError(created.acquisition.client.startConnection(), "local_admission");

    created.sdk.approval.resolve(session());
    await expect(cancellation).resolves.toEqual({ status: "cancelled" });
    await expect(attempt.wait()).resolves.toEqual({ status: "cancelled" });
    expect(created.sdk.sessionDisconnects).toEqual([sessionTopic]);
    await containCreatedClient(created);
  });

  it("settles cancellation only after the approval future rejects", async () => {
    const created = await createClient();
    const attempt = await created.acquisition.client.startConnection();

    let cancellationSettled = false;
    const cancellation = attempt.cancel().then((outcome) => {
      cancellationSettled = true;
      return outcome;
    });
    await nextTurn();
    expect(cancellationSettled).toBe(false);

    created.sdk.approval.reject(new Error("proposal expired"));
    await expect(cancellation).resolves.toEqual({ status: "cancelled" });
    expect(cancellationSettled).toBe(true);
    await containCreatedClient(created);
  });

  it("cannot return from failed cancellation to approval", async () => {
    const sdk = new FakeSdk();
    sdk.pairingDisconnectFailure = new Error("pairing cleanup failed");
    const created = await createClient({ sdk });
    const attempt = await created.acquisition.client.startConnection();

    let cancellationSettled = false;
    const cancellation = attempt.cancel().then((outcome) => {
      cancellationSettled = true;
      return outcome;
    });
    await nextTurn();
    expect(cancellationSettled).toBe(false);
    sdk.approval.resolve(session());
    await expect(cancellation).resolves.toEqual({ status: "failed", failure: "sdk" });
    await expect(attempt.wait()).resolves.toEqual({ status: "failed", failure: "sdk" });
    expect(sdk.sessionDisconnects).toEqual([sessionTopic]);
    await expectClientError(() => created.acquisition.client.observe(), "observation");
    await containCreatedClient(created);
  });

  it("attempts pairing cleanup even when proposal expiry fails", async () => {
    const sdk = new FakeSdk();
    sdk.expireProposalFailure = new Error("proposal expiry failed");
    const created = await createClient({ sdk });
    const attempt = await created.acquisition.client.startConnection();

    const cancellation = attempt.cancel();
    sdk.approval.reject(new Error("proposal rejected"));

    await expect(cancellation).resolves.toEqual({ status: "failed", failure: "sdk" });
    expect(sdk.expiredProposalIds).toEqual([1]);
    expect(sdk.pairingDisconnects).toEqual([pairingTopic]);
    await containCreatedClient(created);
  });

  it("contains an exact proposal when the SDK start result cannot supply approval", async () => {
    const sdk = new FakeSdk();
    sdk.connectionResult = Object.freeze({ uri: pairingUri, approval: 1 });
    const created = await createClient({ sdk });

    await expectClientError(created.acquisition.client.startConnection(), "sdk");
    expect(sdk.expiredProposalIds).toEqual([1]);
    expect(sdk.pairingDisconnects).toEqual([pairingTopic]);
    expect(sdk.approvalCallCount).toBe(0);
    await containCreatedClient(created);
  });

  it("does not treat an unidentifiable late session as contained cancellation", async () => {
    const created = await createClient();
    const attempt = await created.acquisition.client.startConnection();

    const cancellation = attempt.cancel();
    created.sdk.approval.resolve(Object.freeze({ topic: "not-a-session" }));

    await expect(cancellation).resolves.toEqual({ status: "failed", failure: "sdk" });
    await expectClientError(() => created.acquisition.client.observe(), "observation");
    await containCreatedClient(created);
  });

  it("contains the exact sole proposal when its topic contradicts the returned URI", async () => {
    const sdk = new FakeSdk();
    sdk.proposalsOnConnect = [proposal(7, "7".repeat(64))];
    const created = await createClient({ sdk });

    let startSettled = false;
    const starting = created.acquisition.client.startConnection().then(
      (value) => { startSettled = true; return value; },
      (error: unknown) => { startSettled = true; throw error; },
    );
    await nextTurn();
    expect(startSettled).toBe(false);
    expect(sdk.approvalCallCount).toBe(1);
    expect(sdk.expiredProposalIds).toEqual([7]);
    expect(sdk.pairingDisconnects).toEqual(["7".repeat(64)]);
    sdk.approval.resolve(session());
    await expectClientError(starting, "sdk");
    expect(sdk.sessionDisconnects).toEqual([sessionTopic]);
    await expectClientError(() => created.acquisition.client.observe(), "observation");
    await containCreatedClient(created);
  });

  it.each([
    ["missing URI", undefined],
    ["missing symmetric key", `wc:${pairingTopic}@2?relay-protocol=irn`],
    ["unsupported relay", `wc:${pairingTopic}@2?relay-protocol=other&symKey=${"5".repeat(64)}`],
    ["duplicate parameter", `wc:${pairingTopic}@2?relay-protocol=irn&symKey=${"5".repeat(64)}&symKey=${"5".repeat(64)}`],
    ["unknown parameter", `wc:${pairingTopic}@2?relay-protocol=irn&symKey=${"5".repeat(64)}&future=value`],
  ])("cleans the exact proposal without deriving authority from a malformed URI: %s", async (_caseName, uri) => {
    const sdk = new FakeSdk();
    sdk.connectionUri = uri;
    const created = await createClient({ sdk });

    let startSettled = false;
    const starting = created.acquisition.client.startConnection().then(
      (value) => { startSettled = true; return value; },
      (error: unknown) => { startSettled = true; throw error; },
    );
    await nextTurn();
    expect(startSettled).toBe(false);
    expect(sdk.approvalCallCount).toBe(1);
    expect(sdk.expiredProposalIds).toEqual([1]);
    expect(sdk.pairingDisconnects).toEqual([pairingTopic]);
    sdk.approval.resolve(session());
    await expectClientError(starting, "sdk");
    expect(sdk.sessionDisconnects).toEqual([sessionTopic]);
    await expectClientError(() => created.acquisition.client.observe(), "observation");
    await containCreatedClient(created);
  });

  it("does not guess cleanup authority from an ambiguous proposal snapshot", async () => {
    const sdk = new FakeSdk();
    sdk.proposalsOnConnect = [proposal(), proposal(2, "7".repeat(64))];
    const created = await createClient({ sdk });

    let startSettled = false;
    const starting = created.acquisition.client.startConnection().then(
      (value) => { startSettled = true; return value; },
      (error: unknown) => { startSettled = true; throw error; },
    );
    await nextTurn();
    expect(startSettled).toBe(false);
    expect(sdk.approvalCallCount).toBe(1);
    expect(sdk.expiredProposalIds).toEqual([]);
    expect(sdk.pairingDisconnects).toEqual([]);
    sdk.approval.resolve(session());
    await expectClientError(starting, "sdk");
    expect(sdk.sessionDisconnects).toEqual([sessionTopic]);
    await containCreatedClient(created);
  });

  it("cleans the exact proposal and pairing when QR encoding fails", async () => {
    const created = await createClient({
      loader: moduleLoader(qrModule({ modules: { size: 21, data: new Uint8Array(1) } })),
    });

    let startSettled = false;
    const starting = created.acquisition.client.startConnection().then(
      (value) => { startSettled = true; return value; },
      (error: unknown) => { startSettled = true; throw error; },
    );
    await nextTurn();
    expect(startSettled).toBe(false);
    expect(created.sdk.approvalCallCount).toBe(1);
    expect(created.sdk.expiredProposalIds).toEqual([1]);
    expect(created.sdk.pairingDisconnects).toEqual([pairingTopic]);
    created.sdk.approval.resolve(session());
    await expectClientError(starting, "qr_encoding");
    expect(created.sdk.sessionDisconnects).toEqual([sessionTopic]);
    await containCreatedClient(created);
  });

  it("contains product authority without waiting for live SDK approval", async () => {
    const created = await createClient();
    await created.acquisition.client.startConnection();

    await containCreatedClient(created);
    expect(created.storage.closeCount).toBe(0);
    expect(created.sdk.sessionDisconnects).toEqual([]);
  });

  it("maps an opaque source identifier back to the latest observed topic", async () => {
    const created = await createClient();
    created.sdk.sessions = [session()];
    const observed = created.acquisition.client.observe();
    const admitted = observed.sessions[0];
    if (admitted?.status !== "valid") throw new Error("valid session expected");

    await created.acquisition.client.disconnectSession(admitted.source.sourceId);
    expect(created.sdk.sessionDisconnects).toEqual([sessionTopic]);
    await expectClientError(
      created.acquisition.client.disconnectSession("wallet-session:unknown"),
      "local_admission",
    );
    await containCreatedClient(created);
  });

  it("uses events only as attributable wake-up and canonical identity hints", async () => {
    const created = await createClient();
    created.sdk.sessions = [session()];
    const events: WalletConnectClientEvent[] = [];
    const activation = created.acquisition.client.activate((event) => events.push(event));
    if (activation.initialObservation.status !== "available") {
      throw new Error("available activation expected");
    }
    const observed = activation.initialObservation.observation;
    const admitted = observed.sessions[0];
    if (admitted?.status !== "valid") throw new Error("valid session expected");
    activation.releaseEvents();

    created.sdk.emit("session_connect", { session: session() });
    created.sdk.emit("session_update", { topic: sessionTopic });
    created.sdk.emit("session_event", {
      topic: sessionTopic,
      params: {
        chainId,
        event: { name: "accountsChanged", data: [address] },
      },
    });
    created.sdk.emit("session_event", {
      topic: sessionTopic,
      params: {
        chainId,
        event: { name: "chainChanged", data: "0x1237" },
      },
    });
    created.sdk.emit("session_event", {
      topic: sessionTopic,
      params: { chainId, event: { name: "futureEvent", data: "ignored" } },
    });
    created.sdk.emit("session_event", {
      topic: secondSessionTopic,
      params: { chainId, event: { name: "accountsChanged", data: [address] } },
    });
    created.sdk.emit("proposal_expire", { id: 1 });

    expect(events).toEqual([
      { kind: "observation_changed" },
      { kind: "observation_changed", sessionSourceId: admitted.source.sourceId },
      {
        kind: "accounts_changed",
        sessionSourceId: admitted.source.sourceId,
        chainId,
        accounts: [`${chainId}:${address}`],
      },
      {
        kind: "chain_changed",
        sessionSourceId: admitted.source.sourceId,
        chainId,
      },
      { kind: "identity_unattributed" },
      { kind: "observation_changed" },
    ]);
    await containCreatedClient(created);
  });

  it("reports attributable malformed supported identity data without exposing it", async () => {
    const created = await createClient();
    created.sdk.sessions = [session()];
    const events: WalletConnectClientEvent[] = [];
    const activation = created.acquisition.client.activate((event) => events.push(event));
    if (activation.initialObservation.status !== "available") {
      throw new Error("available activation expected");
    }
    const observed = activation.initialObservation.observation;
    const admitted = observed.sessions[0];
    if (admitted?.status !== "valid") throw new Error("valid session expected");
    activation.releaseEvents();
    const walletEvent = Object.defineProperty({ name: "accountsChanged" }, "data", {
      get: () => { throw new Error("raw event secret"); },
    });

    created.sdk.emit("session_event", {
      topic: sessionTopic,
      params: { chainId, event: walletEvent },
    });
    created.sdk.emit("session_event", { topic: sessionTopic });
    created.sdk.emit("session_event", {
      topic: sessionTopic,
      params: { chainId, event: { name: 1, data: [] } },
    });
    created.sdk.emit("session_event", {
      topic: sessionTopic,
      params: { chainId: "eip155:1", event: { name: "chainChanged", data: "0x1237" } },
    });
    created.sdk.emit("session_event", {
      topic: sessionTopic,
      params: { chainId, event: { name: "futureEvent", data: "ignored" } },
    });

    expect(events).toEqual([{
      kind: "identity_invalid",
      sessionSourceId: admitted.source.sourceId,
    }, {
      kind: "identity_invalid",
      sessionSourceId: admitted.source.sourceId,
    }, {
      kind: "identity_invalid",
      sessionSourceId: admitted.source.sourceId,
    }, {
      kind: "identity_invalid",
      sessionSourceId: admitted.source.sourceId,
    }]);
    await containCreatedClient(created);
  });

  it("poisons observation if the security event consumer fails", async () => {
    const created = await createClient();
    created.sdk.sessions = [session()];
    const activation = created.acquisition.client.activate(() => {
      throw new Error("projection write failed");
    });
    activation.releaseEvents();

    created.sdk.emit("session_event", {
      topic: sessionTopic,
      params: { chainId, event: { name: "accountsChanged", data: [address] } },
    });

    await expectClientError(() => created.acquisition.client.observe(), "observation");
    await containCreatedClient(created);
  });

  it("retains identity events until activation establishes exact attribution", async () => {
    const created = await createClient();
    created.sdk.sessions = [session()];
    created.sdk.emit("session_event", {
      topic: sessionTopic,
      params: {
        chainId,
        event: { name: "accountsChanged", data: [address] },
      },
    });
    const events: WalletConnectClientEvent[] = [];

    const activation = created.acquisition.client.activate((event) => events.push(event));
    expect(events).toEqual([]);
    activation.releaseEvents();

    expect(events).toEqual([{
      kind: "accounts_changed",
      sessionSourceId: sessionSource(sessionTopic).sourceId,
      chainId,
      accounts: [`${chainId}:${address}`],
    }]);
    await containCreatedClient(created);
  });

  it("retains an identity event emitted during the activation observation", async () => {
    const created = await createClient();
    created.sdk.sessions = [session()];
    created.sdk.onListSessions = () => {
      created.sdk.onListSessions = undefined;
      created.sdk.emit("session_event", {
        topic: sessionTopic,
        params: {
          chainId,
          event: { name: "accountsChanged", data: [address] },
        },
      });
    };
    const events: WalletConnectClientEvent[] = [];

    const activation = created.acquisition.client.activate((event) => events.push(event));
    expect(events).toEqual([]);
    activation.releaseEvents();

    expect(events).toEqual([{
      kind: "accounts_changed",
      sessionSourceId: sessionSource(sessionTopic).sourceId,
      chainId,
      accounts: [`${chainId}:${address}`],
    }]);
    await containCreatedClient(created);
  });

  it("closes observation when the bounded pre-activation event queue overflows", async () => {
    const created = await createClient();
    for (let index = 0; index <= 256; index += 1) {
      created.sdk.emit("proposal_expire", { id: index });
    }

    const activation = created.acquisition.client.activate(() => undefined);
    expect(activation.initialObservation).toEqual({ status: "unavailable" });
    expect(() => activation.releaseEvents()).toThrow("WalletConnect state could not be observed.");
    await expectClientError(() => created.acquisition.client.observe(), "observation");
    await containCreatedClient(created);
  });

  it("contains product admission without sealing or closing SDK storage", async () => {
    const created = await createClient();
    created.storage.revision = 8n;
    expect(created.acquisition.client.observe().revision).toBe(8n);

    const first = created.acquisition.client.contain();
    const second = created.acquisition.client.contain();
    await Promise.all([first, second]);

    await expectClientError(() => created.acquisition.client.observe(), "observation");
    await expectClientError(() => created.acquisition.client.startConnection(), "local_admission");
    expect([...created.sdk.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
    expect(created.storage.sealedRevision).toBeUndefined();
    expect(created.storage.closeCount).toBe(0);
    await expect(created.scope.close()).rejects.toMatchObject({
      name: "ProcessTerminalRequiredError",
    });
    expect(created.storage.closeCount).toBe(0);
  });

  it("replaces already-registered storage ownership before wallet configuration validation", async () => {
    const storage = new FakeStorageOwner();
    const scope = createWalletConnectAcquisitionScope();
    const storageRegistration = scope.resources.register(storage);

    await expectClientError(createWalletConnectClient({
      wallet: Object.freeze({}) as Parameters<typeof createWalletConnectClient>[0]["wallet"],
      storageOwner: storage,
      createSessionSource: sessionSource,
    }, storageRegistration, new AbortController().signal, undefined, moduleLoader()), "configuration");

    expect(storage.closeCount).toBe(1);
    await scope.close();
  });

  it("closes the supplied storage locally when its registration cannot be replaced", async () => {
    const registeredStorage = new FakeStorageOwner();
    const suppliedStorage = new FakeStorageOwner();
    const scope = createWalletConnectAcquisitionScope();
    const registration = scope.resources.register(registeredStorage);

    await expectClientError(createWalletConnectClient({
      wallet,
      storageOwner: suppliedStorage,
      createSessionSource: sessionSource,
    }, registration, new AbortController().signal, undefined, moduleLoader()), "local_admission");

    expect(suppliedStorage.closeCount).toBe(1);
    expect(registeredStorage.closeCount).toBe(0);
    await scope.close();
    expect(registeredStorage.closeCount).toBe(1);
  });

  it("requires adoption before ownership can be transferred", async () => {
    const created = await createClient();
    await expectClientError(() => created.acquisition.transfer(), "local_admission");
    const coordinator = Object.freeze({ close: async () => undefined });
    const application = Object.freeze({ close: async () => undefined });
    created.acquisition.replace(coordinator);
    created.acquisition.replace(application);
    created.acquisition.transfer();
    expect(created.scope.empty).toBe(true);
  });

  it("retains the SDK storage owner after SDK initialization", async () => {
    const created = await createClient();
    await expect(created.scope.close()).rejects.toMatchObject({
      name: "ProcessTerminalRequiredError",
    });
    expect(created.storage.closeCount).toBe(0);
    expect(created.scope.empty).toBe(false);
    await expectClientError(() => created.acquisition.client.startConnection(), "local_admission");
  });

  it("classifies module loading separately and keeps error text secret-free", async () => {
    const storage = new FakeStorageOwner();
    const scope = createWalletConnectAcquisitionScope();
    const storageRegistration = scope.resources.register(storage);
    await expectClientError(createWalletConnectClient({
      wallet,
      storageOwner: storage,
      createSessionSource: sessionSource,
    }, storageRegistration, new AbortController().signal, undefined, async () => {
      throw new Error(pairingUri);
    }), "module_loading");
    expect(storage.closeCount).toBe(1);
    await scope.close();
  });

  it("retains a late SDK handle and storage after acquisition abort", async () => {
    const sdk = new FakeSdk();
    const pendingSdk = deferred<WalletConnectSdkPort>();
    const storage = new FakeStorageOwner();
    const scope = createWalletConnectAcquisitionScope();
    const storageRegistration = scope.resources.register(storage);
    const controller = new AbortController();
    const creation = createWalletConnectClient({
      wallet,
      storageOwner: storage,
      createSessionSource: sessionSource,
    }, storageRegistration, controller.signal, async () => pendingSdk.promise, moduleLoader());
    await nextTurn();

    controller.abort();
    await expect(creation).rejects.toMatchObject({
      name: "ProcessTerminalRequiredError",
      primaryFailure: { code: "local_admission" },
    });
    expect(sdk.log).toEqual([]);
    expect(storage.closeCount).toBe(0);

    pendingSdk.resolve(sdk);
    await nextTurn();
    expect(sdk.log).toEqual([]);
    expect(storage.closeCount).toBe(0);
    await expect(scope.close()).rejects.toMatchObject({ name: "ProcessTerminalRequiredError" });
  });

  it("ends non-settling SDK acquisition at the local deadline and owns late cleanup", async () => {
    vi.useFakeTimers();
    const sdk = new FakeSdk();
    const pendingSdk = deferred<WalletConnectSdkPort>();
    const factoryStarted = deferred<void>();
    const storage = new FakeStorageOwner();
    const scope = createWalletConnectAcquisitionScope();
    const storageRegistration = scope.resources.register(storage);
    try {
      const creation = createWalletConnectClient({
        wallet,
        storageOwner: storage,
        createSessionSource: sessionSource,
      }, storageRegistration, new AbortController().signal, async () => {
        factoryStarted.resolve();
        return pendingSdk.promise;
      }, moduleLoader());
      await factoryStarted.promise;

      const deadlineFailure = expect(creation).rejects.toMatchObject({
        name: "ProcessTerminalRequiredError",
        primaryFailure: { code: "deadline" },
      });
      await vi.advanceTimersByTimeAsync(5 * 60 * 1_000);
      await deadlineFailure;
      expect(storage.closeCount).toBe(0);
      expect(scope.empty).toBe(false);

      pendingSdk.resolve(sdk);
      await vi.advanceTimersByTimeAsync(0);
      await expect(scope.close()).rejects.toMatchObject({
        name: "ProcessTerminalRequiredError",
      });
      expect(storage.closeCount).toBe(0);
      expect(scope.empty).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("WalletConnect production SDK projection", () => {
  it("uses only the declared product operations and does not manufacture an SDK close", async () => {
    const log: string[] = [];
    let initOptions: unknown;
    let connectInput: unknown;
    const storage = new FakeStorageOwner().storage;
    const client = {
      proposal: { getAll: () => [proposal()] },
      session: { getAll: () => [session()] },
      core: {
        expirer: { set: (id: number) => log.push(`expire:${id}`) },
        pairing: { disconnect: async ({ topic }: { topic: string }) => {
          log.push(`pairing:${topic}`);
        } },
      },
      connect: async (input: unknown) => {
        connectInput = input;
        return { uri: pairingUri, approval: async () => session() };
      },
      disconnect: async ({ topic }: { topic: string }) => log.push(`session:${topic}`),
      on: () => undefined,
      off: () => undefined,
    };
    class SignClient {
      static async init(options: unknown): Promise<unknown> {
        initOptions = options;
        return client;
      }
    }
    const dependencies = await loadWalletConnectProductionDependencies(async (key) =>
      key === "signClient" ? { SignClient } : qrModule());
    const sdk = await dependencies.sdkFactory({
      projectId: "1".repeat(32) as WalletConnectSdkInitOptions["projectId"],
      name: "Little John",
      metadata: {
        name: "Little John",
        description: "Local Robinhood Chain wallet connection",
        url: "http://127.0.0.1:46630",
        icons: [],
      },
      storage,
      telemetryEnabled: false,
      logger: {
        level: "warn",
        child() { return this; },
        trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
      },
    });

    expect(initOptions).toMatchObject({ storage, telemetryEnabled: false });
    expect(initOptions).not.toHaveProperty("storageOptions");
    expect(sdk.listProposals()).toHaveLength(1);
    expect(sdk.listSessions()).toHaveLength(1);
    await sdk.startConnection({
      optionalNamespaces: {
        eip155: {
          chains: [chainId],
          methods: ["eth_sendTransaction"],
          events: ["accountsChanged", "chainChanged"],
        },
      },
    });
    expect(connectInput).toEqual({
      optionalNamespaces: {
        eip155: {
          chains: [chainId],
          methods: ["eth_sendTransaction"],
          events: ["accountsChanged", "chainChanged"],
        },
      },
    });

    expect(log).toEqual([]);
  });

  it("retains SDK and storage ownership when projection fails after SDK initialization", async () => {
    const storage = new FakeStorageOwner();
    const scope = createWalletConnectAcquisitionScope();
    const storageRegistration = scope.resources.register(storage);
    const malformedClient = { core: {} };
    class SignClient {
      static async init(): Promise<unknown> {
        return malformedClient;
      }
    }

    await expect(createWalletConnectClient({
      wallet,
      storageOwner: storage,
      createSessionSource: sessionSource,
    }, storageRegistration, new AbortController().signal, undefined, async (key) =>
      key === "signClient" ? { SignClient } : qrModule())).rejects.toMatchObject({
        name: "ProcessTerminalRequiredError",
        primaryFailure: { code: "sdk" },
      });

    expect(storage.closeCount).toBe(0);
    expect(scope.empty).toBe(false);
    await expect(scope.close()).rejects.toMatchObject({ name: "ProcessTerminalRequiredError" });
    expect(storage.closeCount).toBe(0);
    expect(scope.empty).toBe(false);
  });
});
