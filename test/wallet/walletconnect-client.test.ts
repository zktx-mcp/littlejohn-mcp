import { createHmac } from "node:crypto";
import { performance } from "node:perf_hooks";

import { describe, expect, it, vi } from "vitest";

import { admitDynamicFeeTransactionRequest, dynamicFeeRequestCommitment, parseHash32, type DynamicFeeTransactionRequest } from "../../src/core/index.js";
import type { WalletTransactionResponse } from "../../src/wallet/transaction-contract.js";
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
  pairingTopic,
  expiry: 1_900_000_000,
  namespaces: { eip155: namespace(chains) },
  relay: { secret: "must not escape" },
});

const proposal = (id = 1, topic = pairingTopic): object => ({
  id,
  pairingTopic: topic,
  expiryTimestamp: 1_900_000_000,
});

const pairing = (topic = pairingTopic): object => ({
  topic,
  expiry: 1_900_000_000,
  active: true,
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
  closeCount = 0;
  checkpointFailure: unknown;

  constructor(private readonly trace: string[] = []) {}

  checkpoint(): bigint {
    this.log.push("checkpoint");
    this.trace.push("checkpoint");
    if (this.checkpointFailure !== undefined) throw this.checkpointFailure;
    return this.checkpointValues.shift() ?? this.revision;
  }

  close(): void {
    this.log.push("storage-close");
    this.closeCount += 1;
  }
}

class FakeSdk implements WalletConnectSdkPort {
  transaction = deferred<WalletTransactionResponse>();
  readonly transactionInputs: { topic: string; request: DynamicFeeTransactionRequest; sendExpiresAt: string }[] = [];
  assertHealthy(): void {}
  requestTransaction(topic: string, request: DynamicFeeTransactionRequest, sendExpiresAt: string): Promise<WalletTransactionResponse> {
    this.transactionInputs.push({ topic, request, sendExpiresAt });
    return this.transaction.promise;
  }
  async closeTransactionResources(): Promise<void> {}

  proposals: unknown[] = [];
  sessions: unknown[] = [];
  pairings: unknown[] = [];
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
  onExpireProposal: (() => void) | undefined;
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

  listPairings(): readonly unknown[] {
    this.log.push("pairings");
    this.trace.push("pairings");
    return this.pairings;
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
    this.onExpireProposal?.();
    if (this.expireProposalFailure !== undefined) throw this.expireProposalFailure;
    this.proposals = this.proposals.filter((candidate) => {
      try { return Reflect.get(candidate as object, "id") !== id; }
      catch { return true; }
    });
  }

  async disconnectPairing(topic: string): Promise<void> {
    this.log.push(`pairing-disconnect:${topic}`);
    this.pairingDisconnects.push(topic);
    if (this.pairingDisconnectFailure !== undefined) throw this.pairingDisconnectFailure;
    this.pairings = this.pairings.filter((candidate) => {
      try { return Reflect.get(candidate as object, "topic") !== topic; }
      catch { return true; }
    });
  }

  async disconnectSession(topic: string): Promise<void> {
    this.log.push(`session-disconnect:${topic}`);
    this.sessionDisconnects.push(topic);
    this.sessions = this.sessions.filter((candidate) => {
      try { return Reflect.get(candidate as object, "topic") !== topic; }
      catch { return true; }
    });
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

const transactionInput = () => {
  const request = admitDynamicFeeTransactionRequest({
    type: "2", accessList: [], chainId, from: address, to: `0x${"6".repeat(40)}`,
    value: "0", data: "0x12345678", nonce: "7", gasLimit: "100000",
    maxFeePerGas: "20", maxPriorityFeePerGas: "2",
  });
  return {
    request,
    reference: {
      account: { chainId: request.chainId, address: request.from },
      encodingVersion: "1" as const,
      walletRequestCommitment: dynamicFeeRequestCommitment(request),
    },
    sessionSourceId: sessionSource(sessionTopic).sourceId,
    sendExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
};

describe("Wallet transaction admission and response lifetime", () => {
  it("sends once, preserves the response, and admits another request only through a fresh call", async () => {
    const created = await createClient();
    created.sdk.sessions = [session()];
    const client = created.acquisition.client;
    const input = transactionInput();
    const attempt = await client.startTransaction(input);
    expect(created.sdk.transactionInputs).toEqual([{ topic: sessionTopic, request: input.request, sendExpiresAt: input.sendExpiresAt }]);
    await expect(client.startTransaction(input)).rejects.toMatchObject({ code: "local_admission" });
    created.sdk.transaction.resolve({ status: "wallet_rejected" });
    expect(await attempt.response).toEqual({ status: "wallet_rejected" });
    await nextTurn();
    expect(created.sdk.transactionInputs).toHaveLength(1);
    created.sdk.transaction = deferred<WalletTransactionResponse>();
    const next = await client.startTransaction(transactionInput());
    const transactionHash = parseHash32(`0x${"ab".repeat(32)}`);
    created.sdk.transaction.resolve({ status: "hash_returned", transactionHash });
    expect(await next.response).toEqual({ status: "hash_returned", transactionHash });
    expect(created.sdk.transactionInputs).toHaveLength(2);
    await containCreatedClient(created);
  });

  it("rechecks the original reference, session and send expiry before calling the SDK", async () => {
    const created = await createClient();
    created.sdk.sessions = [session()];
    const client = created.acquisition.client;
    const input = transactionInput();
    for (const changed of [
      { ...input, request: admitDynamicFeeTransactionRequest({ ...input.request, nonce: "8" }) },
      { ...input, sessionSourceId: sessionSource(secondSessionTopic).sourceId },
      { ...input, sendExpiresAt: new Date(Date.now() - 1).toISOString() },
    ]) await expect(client.startTransaction(changed)).rejects.toMatchObject({ code: "local_admission" });
    created.sdk.sessions = [{ ...session(), namespaces: { eip155: {
      ...namespace(), accounts: [`${chainId}:0x${"7".repeat(40)}`],
    } } }];
    await expect(client.startTransaction(input)).rejects.toMatchObject({ code: "local_admission" });
    expect(created.sdk.transactionInputs).toHaveLength(0);
    await containCreatedClient(created);
  });

  it("settles shutdown as unknown and never turns a later SDK hash into a second outcome", async () => {
    const created = await createClient();
    created.sdk.sessions = [session()];
    const client = created.acquisition.client;
    const attempt = await client.startTransaction(transactionInput());
    await client.contain();
    expect(await attempt.response).toEqual({ status: "delivery_unknown", reason: "shutdown" });
    created.sdk.transaction.resolve({ status: "hash_returned", transactionHash: parseHash32(`0x${"ab".repeat(32)}`) });
    await nextTurn();
    expect(await attempt.response).toEqual({ status: "delivery_unknown", reason: "shutdown" });
    expect(() => client.startTransaction(transactionInput())).toThrow();
    await containCreatedClient(created);
  });
});

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

const observeReflection = <Value extends object>(target: Value) => {
  const descriptors: PropertyKey[] = [];
  let enumerations = 0;
  const value = new Proxy(target, {
    ownKeys(object) {
      enumerations += 1;
      return Reflect.ownKeys(object);
    },
    getOwnPropertyDescriptor(object, key) {
      descriptors.push(key);
      return Reflect.getOwnPropertyDescriptor(object, key);
    },
    get() { throw new Error("Input value getters must not run."); },
  });
  return { value, descriptors, get enumerations() { return enumerations; } };
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
      { topic: "6".repeat(64), pairingTopic, expiry: -1, namespaces: {} },
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

  it.each(["proposals", "sessions", "pairings"] as const)(
    "admits %s cardinality before key enumeration or element capture",
    async (role) => {
      const created = await createClient();
      try {
        for (const length of [257, 256]) {
          const values = Array.from({ length }, (_, index) => {
            const topic = (index + 1).toString(16).padStart(64, "0");
            return role === "proposals" ? proposal(index + 1, topic)
              : role === "sessions" ? session(topic) : pairing(topic);
          });
          const observed = observeReflection(values);
          created.sdk[role] = values;
          if (role === "pairings") {
            vi.spyOn(created.sdk, "listPairings").mockReturnValueOnce(observed.value);
          } else created.sdk[role] = observed.value;
          if (length === 257) {
            await expectClientError(role === "pairings"
              ? created.acquisition.client.containPendingConnectionState()
              : () => created.acquisition.client.observe(), "observation");
            expect(observed.descriptors.filter((key) => key !== "length")).toHaveLength(0);
            expect(observed.enumerations).toBe(0);
            expect(observed.descriptors).toEqual(["length"]);
          } else {
            if (role === "pairings") {
              await created.acquisition.client.containPendingConnectionState();
              expect(created.sdk.pairingDisconnects).toHaveLength(length);
            } else {
              const result = created.acquisition.client.observe();
              expect(role === "proposals" ? result.proposalCount : result.sessions.length).toBe(length);
            }
            expect(observed.enumerations).toBe(1);
            expect(observed.descriptors).toEqual([
              "length", ...Array.from({ length }, (_, index) => String(index)), "length",
            ]);
          }
        }
      } finally { await containCreatedClient(created); }
    },
  );

  it("refuses non-exact or changing array shape without executing getters", async () => {
    const created = await createClient();
    const getter = vi.fn(() => session());
    const sparse = new Array<unknown>(1);
    const accessor = Object.defineProperty([], "0", { enumerable: true, get: getter });
    const extra = Object.assign([session()], { extra: session() });
    const symbol = Object.assign([session()], { [Symbol("extra")]: session() });
    const substituted = new Proxy([session(), session(secondSessionTopic)], {
      ownKeys: () => ["length", "0", "extra"],
    });
    const missing = new Proxy([session()], {
      getOwnPropertyDescriptor: (target, key) => key === "0"
        ? undefined : Reflect.getOwnPropertyDescriptor(target, key),
    });
    const changing = new Proxy([session()], {
      getOwnPropertyDescriptor(target, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        if (key === "0") target.push(session(secondSessionTopic));
        return descriptor;
      },
    });
    try {
      for (const candidate of [sparse, accessor, extra, symbol, substituted, missing, changing]) {
        const observed = observeReflection(candidate);
        created.sdk.sessions = observed.value;
        await expectClientError(() => created.acquisition.client.observe(), "observation");
        if (candidate === extra || candidate === symbol || candidate === substituted) {
          expect(observed.descriptors).toEqual(["length"]);
        }
      }
      expect(getter).not.toHaveBeenCalled();
    } finally { await containCreatedClient(created); }
  });

  it("admits namespace count before capturing any namespace value", async () => {
    const created = await createClient();
    try {
      for (const length of [17, 16]) {
        const observed = observeReflection(Object.fromEntries(
          Array.from({ length }, (_, index) => [`ns${index}`, namespace()]),
        ));
        created.sdk.sessions = [{ ...session(), namespaces: observed.value }];
        const result = created.acquisition.client.observe().sessions[0];
        expect(result?.status).toBe(length === 16 ? "valid" : "invalid");
        expect(observed.descriptors).toHaveLength(length === 16 ? length : 0);
        expect(observed.enumerations).toBe(1);
        if (result?.status === "valid") expect(Object.keys(result.namespaces)).toHaveLength(16);
      }
      const getter = vi.fn(namespace);
      for (const namespaces of [
        { [Symbol("namespace")]: namespace() },
        Object.defineProperty({}, "eip155", { enumerable: true, get: getter }),
        Object.defineProperty({}, "eip155", { enumerable: false, value: namespace() }),
        new Proxy({ eip155: namespace() }, { getOwnPropertyDescriptor: () => undefined }),
      ]) {
        created.sdk.sessions = [{ ...session(), namespaces }];
        expect(created.acquisition.client.observe().sessions[0]?.status).toBe("invalid");
      }
      expect(getter).not.toHaveBeenCalled();
    } finally { await containCreatedClient(created); }
  });

  it("preserves complete namespace-array and Unicode text boundaries", async () => {
    const created = await createClient();
    try {
      for (const field of ["accounts", "methods", "events", "chains"]) {
        for (const length of [64, 65]) {
          const values = Array.from({ length }, (_, index) => `value${index}`);
          const observed = observeReflection(values);
          created.sdk.sessions = [{ ...session(), namespaces: {
            eip155: { ...namespace(), [field]: observed.value },
          } }];
          const result = created.acquisition.client.observe().sessions[0];
          expect(result?.status).toBe(length === 64 ? "valid" : "invalid");
          if (result?.status === "valid") {
            expect(Reflect.get(result.namespaces["eip155"]!, field)).toEqual(values);
          } else {
            expect(observed.enumerations).toBe(0);
            expect(observed.descriptors).toEqual(["length"]);
          }
        }
      }
      for (const text of ["a".repeat(512), "a".repeat(513), "😀".repeat(512), "😀".repeat(513)]) {
        created.sdk.sessions = [{ ...session(), namespaces: {
          eip155: { ...namespace(), methods: [text] },
        } }];
        const result = created.acquisition.client.observe().sessions[0];
        expect(result?.status).toBe([...text].length === 512 ? "valid" : "invalid");
        if (result?.status === "valid") expect(result.namespaces["eip155"]?.methods).toEqual([text]);
      }
      created.sdk.sessions = [session()];
      const events: WalletConnectClientEvent[] = [];
      const activation = created.acquisition.client.activate((event) => events.push(event));
      activation.releaseEvents();
      for (const length of [64, 65]) {
        created.sdk.emit("session_event", { topic: sessionTopic, params: {
          chainId, event: { name: "accountsChanged", data: Array.from({ length }, () => address) },
        } });
      }
      expect(events[0]).toMatchObject({ kind: "accounts_changed", accounts: Array(64).fill(`${chainId}:${address}`) });
      expect(events[1]).toEqual({ kind: "identity_invalid", sessionSourceId: sessionSource(sessionTopic).sourceId });
    } finally { await containCreatedClient(created); }
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

  it("publishes one in-flight cancellation before proposal cleanup can reenter", async () => {
    const sdk = new FakeSdk();
    const created = await createClient({ sdk });
    const attempt = await created.acquisition.client.startConnection();
    let reenteredCancellation: Promise<unknown> | undefined;
    sdk.onExpireProposal = () => {
      sdk.onExpireProposal = undefined;
      reenteredCancellation = attempt.cancel();
    };

    const cancellation = attempt.cancel();

    if (reenteredCancellation === undefined) {
      throw new TypeError("Proposal expiry did not reenter cancellation synchronously.");
    }
    expect(reenteredCancellation).toBe(cancellation);
    expect(sdk.expiredProposalIds).toEqual([1]);

    sdk.approval.reject(new Error("proposal expired"));
    await expect(cancellation).resolves.toEqual({ status: "cancelled" });
    expect(sdk.expiredProposalIds).toEqual([1]);
    expect(sdk.pairingDisconnects).toEqual([pairingTopic]);
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

  it("contains restart residue without disconnecting a pairing owned by a live session", async () => {
    const orphanTopic = "7".repeat(64);
    const created = await createClient();
    created.sdk.sessions = [session()];
    created.sdk.proposals = [proposal(9, orphanTopic)];
    created.sdk.pairings = [pairing(pairingTopic), pairing(orphanTopic)];

    await created.acquisition.client.containPendingConnectionState();

    expect(created.sdk.expiredProposalIds).toEqual([9]);
    expect(created.sdk.pairingDisconnects).toEqual([orphanTopic]);
    expect(created.sdk.pairings).toEqual([pairing(pairingTopic)]);
    expect(created.sdk.sessionDisconnects).toEqual([]);
    await containCreatedClient(created);
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
    created.sdk.emit("proposal_expire", { id: 999 });
    await expectClientError(() => created.acquisition.client.observe(), "observation");
    await containCreatedClient(created);
  });

  it("releases an exact-capacity queue once and ignores unrelated events at capacity", async () => {
    const created = await createClient();
    try {
      for (let index = 0; index < 256; index += 1) {
        created.sdk.emit("proposal_expire", { id: index });
      }
      created.sdk.emit("session_event", {
        topic: sessionTopic,
        params: { chainId, event: { name: "futureEvent", data: "ignored" } },
      });
      const events: WalletConnectClientEvent[] = [];
      const activation = created.acquisition.client.activate((event) => events.push(event));
      expect(activation.initialObservation.status).toBe("available");
      expect(events).toEqual([]);
      activation.releaseEvents();
      expect(events).toEqual(Array.from({ length: 256 }, () => ({ kind: "observation_changed" })));
      expect(() => activation.releaseEvents()).toThrow();
      expect(events).toHaveLength(256);
      const retainedCallback = [...created.sdk.listeners.get("proposal_expire")!][0]!;
      await created.acquisition.client.contain();
      retainedCallback({ id: 1 });
      expect(events).toHaveLength(256);
      await expectClientError(() => created.acquisition.client.observe(), "observation");
    } finally { await containCreatedClient(created); }
  });

  it("times approval settlement from containment and never revives late approval", async () => {
    vi.useFakeTimers();
    const created = await createClient();
    try {
      const attempt = await created.acquisition.client.startConnection();
      // Advancing before cancellation distinguishes this budget from acquisition.
      await vi.advanceTimersByTimeAsync(300_000);
      let settled = false;
      const cancelling = attempt.cancel();
      void cancelling.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(299_999);
      expect(settled).toBe(false);
      expect(created.sdk.expiredProposalIds).toEqual([1]);
      expect(created.sdk.pairingDisconnects).toEqual([pairingTopic]);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      await expect(cancelling).resolves.toEqual({ status: "failed", failure: "sdk" });
      await expectClientError(() => created.acquisition.client.observe(), "observation");
      created.sdk.approval.resolve(session());
      await vi.advanceTimersByTimeAsync(0);
      expect(created.sdk.sessionDisconnects).toEqual([sessionTopic]);
      await expect(attempt.wait()).resolves.toEqual({ status: "failed", failure: "sdk" });
    } finally {
      await containCreatedClient(created);
      vi.useRealTimers();
    }
  });

  it("contains product admission while retaining SDK storage", async () => {
    const created = await createClient();
    created.storage.revision = 8n;
    expect(created.acquisition.client.observe().revision).toBe(8n);

    const first = created.acquisition.client.contain();
    const second = created.acquisition.client.contain();
    await Promise.all([first, second]);

    await expectClientError(() => created.acquisition.client.observe(), "observation");
    await expectClientError(() => created.acquisition.client.startConnection(), "local_admission");
    expect([...created.sdk.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
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

  it.each(["just before", "at"] as const)(
    "uses the original acquisition deadline %s expiry after a delayed module phase",
    async (boundary) => {
      vi.useFakeTimers();
      vi.spyOn(performance, "now").mockImplementation(() => Date.now());
      const modules = deferred<void>();
      const sdk = new FakeSdk();
      const pendingSdk = deferred<WalletConnectSdkPort>();
      const started = deferred<void>();
      const storage = new FakeStorageOwner();
      const scope = createWalletConnectAcquisitionScope();
      try {
        const creation = createWalletConnectClient({ wallet, storageOwner: storage, createSessionSource: sessionSource },
          scope.resources.register(storage), new AbortController().signal,
          async () => { started.resolve(); return pendingSdk.promise; },
          async (key) => { await modules.promise; return moduleLoader()(key); });
        const outcome = creation.then(
          (value) => ({ status: "available" as const, value }),
          (error: unknown) => ({ status: "failed" as const, error }),
        );
        let settled = false;
        void outcome.then(() => { settled = true; });
        // Split the existing budget in half to expose a per-stage reset.
        await vi.advanceTimersByTimeAsync(300_000 / 2);
        modules.resolve();
        await started.promise;
        await vi.advanceTimersByTimeAsync(300_000 / 2 - 1);
        expect(settled).toBe(false);
        if (boundary === "just before") pendingSdk.resolve(sdk);
        await vi.advanceTimersByTimeAsync(boundary === "at" ? 1 : 0);
        expect(settled).toBe(true);
        const result = await outcome;
        if (boundary === "at") {
          expect(result).toMatchObject({ status: "failed", error: {
            name: "ProcessTerminalRequiredError", primaryFailure: { code: "deadline" },
          } });
          pendingSdk.resolve(sdk);
          await vi.advanceTimersByTimeAsync(0);
          expect(sdk.log).toEqual([]);
        } else {
          expect(result.status).toBe("available");
          if (result.status === "available") expect(result.value.client.observe().sessions).toEqual([]);
        }
        await expect(scope.close()).rejects.toMatchObject({ name: "ProcessTerminalRequiredError" });
        expect(storage.closeCount).toBe(0);
        expect([...sdk.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
      } finally { vi.useRealTimers(); }
    },
  );
});

describe("WalletConnect production SDK projection", () => {
  it("uses only the declared product operations and does not manufacture an SDK close", async () => {
    const log: string[] = [];
    let initOptions: unknown;
    let connectInput: unknown;
    const storageOwner = new FakeStorageOwner();
    const storage = storageOwner.storage;
    const client = {
      proposal: { getAll: () => [proposal()] },
      session: { getAll: () => [session()] },
      core: {
        expirer: { set: (id: number) => log.push(`expire:${id}`) },
        pairing: {
          getPairings: () => [],
          disconnect: async ({ topic }: { topic: string }) => {
            log.push(`pairing:${topic}`);
          },
        },
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
      storageOwner,
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
