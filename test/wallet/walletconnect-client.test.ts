import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { describe, expect, it, vi } from "vitest";

import { readRuntimeConfiguration } from "../../src/runtime/configuration.js";

import {
  createWalletConnectClient,
  createWalletConnectAcquisitionScope,
  isWalletConnectClientError,
  loadWalletConnectProductionDependencies,
  type WalletConnectClientAcquisition,
  type WalletConnectClientEvent,
  type WalletConnectClientPort,
  type WalletConnectAcquisitionScope,
  type WalletConnectSdkConnectInput,
  type WalletConnectSdkEventListener,
  type WalletConnectSdkEventName,
  type WalletConnectSdkFactory,
  type WalletConnectSdkInitOptions,
  type WalletConnectSdkPort,
} from "../../src/wallet/walletconnect-client.js";

const projectId = "1".repeat(32);
const metadata = readRuntimeConfiguration({}).wallet.metadata;
const pairingTopic = "2".repeat(64);
const firstSessionTopic = "3".repeat(64);
const secondSessionTopic = "4".repeat(64);
const otherPairingTopic = "6".repeat(64);
const pairingUri = `wc:${pairingTopic}@2?relay-protocol=irn&symKey=${"5".repeat(64)}`;
const otherPairingUri = `wc:${otherPairingTopic}@2?relay-protocol=irn&symKey=${"7".repeat(64)}`;
const privateStoreDirectory = resolve(".WORK/tests/walletconnect-client/private-store");
const ownerSignal = (): AbortSignal => new AbortController().signal;

class UnusedSignClient {
  static async init(): Promise<never> {
    throw new Error("The custom SDK factory must own initialization.");
  }
}

const customSdkModuleLoader = async (key: "signClient" | "qrCode"): Promise<unknown> =>
  key === "signClient"
    ? { SignClient: UnusedSignClient }
    : {
        create: () => ({
          modules: { size: 21, data: new Uint8Array(21 * 21) },
        }),
      };

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
  readonly reject: (error: unknown) => void;
}

const deferred = <Value>(): Deferred<Value> => {
  let resolvePromise: ((value: Value) => void) | undefined;
  let rejectPromise: ((error: unknown) => void) | undefined;
  const promise = new Promise<Value>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  if (resolvePromise === undefined || rejectPromise === undefined) {
    throw new Error("Deferred promise initialization failed.");
  }
  return Object.freeze({ promise, resolve: resolvePromise, reject: rejectPromise });
};

const namespace = () => ({
  chains: ["eip155:4663"],
  accounts: ["eip155:4663:0x1111111111111111111111111111111111111111"],
  methods: ["eth_sendTransaction"],
  events: ["accountsChanged", "chainChanged"],
});

const session = (topic = firstSessionTopic) => ({
  topic,
  pairingTopic,
  expiry: 1_783_791_906,
  namespaces: { eip155: namespace() },
  relay: { protocol: "irn", secret: "must-not-escape" },
  peer: { metadata: { name: "wallet" } },
});

const productionClientShape = (
  heartbeat: object,
  relayer: object,
  pairing: object = {
    disconnect: async () => undefined,
    getPairings: () => [],
  },
): object => ({
  core: {
    heartbeat,
    relayer,
    pairing,
    expirer: { set: () => undefined },
  },
  proposal: { getAll: () => [] },
  engine: {
    pendingSessions: new Map<unknown, unknown>(),
    onSessionProposeResponse: async () => undefined,
    onSessionSettleRequest: async () => undefined,
  },
  session: {
    getAll: () => [],
    set: async () => undefined,
  },
  connect: async () => ({ uri: pairingUri, approval: async () => session() }),
  disconnect: async () => undefined,
  on: () => undefined,
  off: () => undefined,
});

class FakeSdk implements WalletConnectSdkPort {
  sessions: unknown[] = [];
  pairings: unknown[] = [];
  proposals: Array<{ readonly id: number; readonly pairingTopic: string; readonly expiryTimestamp: number }> = [];
  readonly approvalResult = deferred<unknown>();
  readonly connectInputs: WalletConnectSdkConnectInput[] = [];
  readonly pairingDisconnects: string[] = [];
  readonly sessionDisconnects: string[] = [];
  readonly onCalls: WalletConnectSdkEventName[] = [];
  readonly offCalls: WalletConnectSdkEventName[] = [];
  readonly listeners = new Map<WalletConnectSdkEventName, Set<WalletConnectSdkEventListener>>();
  approvalCalls = 0;
  sdkCloseCalls = 0;
  proposalCancellationStarts = 0;
  proposalCancellationFinishes = 0;
  offListener: (event: WalletConnectSdkEventName) => void = () => undefined;
  pairingDisconnect: (topic: string) => Promise<void> = async (topic) => {
    this.pairings = this.pairings.filter((value) => {
      try {
        return (value as { readonly topic?: unknown }).topic !== topic;
      } catch {
        return true;
      }
    });
  };
  sessionDisconnect: (topic: string) => Promise<void> = async (topic) => {
    this.sessions = this.sessions.filter((value) => {
      try {
        return (value as { readonly topic?: unknown }).topic !== topic;
      } catch {
        return true;
      }
    });
  };

  listSessions(): readonly unknown[] {
    return this.sessions;
  }

  listPairings(): readonly unknown[] {
    return this.pairings;
  }

  async initializeConnectionAttempts(): Promise<void> {
    this.proposals = [];
  }

  async startConnection(input: WalletConnectSdkConnectInput): Promise<{
    readonly uri: string;
    readonly lifecycle: {
      readonly pairingTopic: string;
      readonly waitForApproval: () => Promise<unknown>;
      readonly finishApproval: (sessionTopic: string) => Promise<void>;
      readonly cancel: () => Promise<void>;
    };
  }> {
    this.connectInputs.push(input);
    this.pairings = [{ topic: pairingTopic }];
    const proposal = {
      id: this.connectInputs.length,
      pairingTopic,
      expiryTimestamp: 1_783_791_906,
    };
    this.proposals = [...this.proposals, proposal];
    return this.connectionAttempt(
      pairingUri,
      pairingTopic,
      proposal.id,
      this.approvalResult.promise,
    );
  }

  connectionAttempt(
    uri: string,
    topic: string,
    proposalId: number | undefined,
    approval: Promise<unknown>,
    settleApproval = true,
  ): {
    readonly uri: string;
    readonly lifecycle: {
      readonly pairingTopic: string;
      readonly waitForApproval: () => Promise<unknown>;
      readonly finishApproval: (sessionTopic: string) => Promise<void>;
      readonly cancel: () => Promise<void>;
    };
  } {
    this.approvalCalls += 1;
    void approval.catch(() => undefined);
    const cancellation = this.connectionCancellation(topic, proposalId, settleApproval);
    let phase: "owned" | "cancelled" | "approved" | "failed" = "owned";
    let cancellationWork: Promise<void> | undefined;
    return {
      uri,
      lifecycle: {
        pairingTopic: topic,
        waitForApproval: () => approval,
        finishApproval: async (sessionTopic: string) => {
          if (phase !== "owned") throw new Error("Connection attempt is not active.");
          const matching = this.sessions.filter((value) => {
            const candidate = value as {
              readonly topic?: unknown;
              readonly pairingTopic?: unknown;
            };
            return candidate.topic === sessionTopic && candidate.pairingTopic === topic;
          });
          if (matching.length !== 1) {
            phase = "failed";
            throw new Error("Approved session is not exact.");
          }
          if (proposalId !== undefined) {
            this.proposals = this.proposals.filter(({ id }) => id !== proposalId);
          }
          phase = "approved";
        },
        cancel: () => {
          if (phase === "cancelled") return Promise.resolve();
          if (cancellationWork !== undefined) return cancellationWork;
          if (phase === "approved" || phase === "failed") {
            return Promise.reject(new Error("Connection attempt is not cancellable."));
          }
          cancellationWork = (async () => {
            let failed = false;
            try {
              await cancellation.start();
            } catch {
              failed = true;
            }
            await approval.then(() => undefined, () => undefined);
            for (const value of [...this.sessions]) {
              const candidate = value as {
                readonly topic?: unknown;
                readonly pairingTopic?: unknown;
              };
              if (candidate.pairingTopic === topic && typeof candidate.topic === "string") {
                try {
                  await this.disconnectSession(candidate.topic);
                } catch {
                  failed = true;
                }
              }
            }
            try {
              await cancellation.finish();
            } catch {
              failed = true;
            }
            if (failed) {
              phase = "failed";
              throw new Error("Exact connection cleanup failed.");
            }
            phase = "cancelled";
          })();
          return cancellationWork;
        },
      },
    };
  }

  connectionCancellation(
    topic: string,
    proposalId?: number,
    settleApproval = true,
  ): { start(): Promise<void>; finish(): Promise<void> } {
    return {
      start: async () => {
        this.proposalCancellationStarts += 1;
        let pairingRemains = false;
        try {
          await this.disconnectPairing(topic);
        } catch {
          if (this.pairings.some((value) =>
            (value as { readonly topic?: unknown }).topic === topic)) {
            pairingRemains = true;
          }
        }
        if (proposalId !== undefined) {
          this.proposals = this.proposals.filter(({ id }) => id !== proposalId);
        }
        if (settleApproval) this.approvalResult.reject({ code: 0 });
        if (pairingRemains) throw new Error("Exact pairing remains after cancellation.");
      },
      finish: async () => {
        this.proposalCancellationFinishes += 1;
        if (
          (proposalId !== undefined && this.proposals.some(({ id }) => id === proposalId)) ||
          this.pairings.some((value) => (value as { readonly topic?: unknown }).topic === topic) ||
          this.sessions.some((value) =>
            (value as { readonly pairingTopic?: unknown }).pairingTopic === topic)
        ) {
          throw new Error("Exact connection resources remain.");
        }
      },
    };
  }

  async disconnectPairing(topic: string): Promise<void> {
    this.pairingDisconnects.push(topic);
    await this.pairingDisconnect(topic);
  }

  async disconnectSession(topic: string): Promise<void> {
    this.sessionDisconnects.push(topic);
    await this.sessionDisconnect(topic);
  }

  on(event: WalletConnectSdkEventName, listener: WalletConnectSdkEventListener): void {
    this.onCalls.push(event);
    const listeners = this.listeners.get(event) ?? new Set<WalletConnectSdkEventListener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  off(event: WalletConnectSdkEventName, listener: WalletConnectSdkEventListener): void {
    this.offCalls.push(event);
    this.offListener(event);
    this.listeners.get(event)?.delete(listener);
  }

  async close(): Promise<void> {
    this.sdkCloseCalls += 1;
  }

  emit(event: WalletConnectSdkEventName, value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }

  storePairing(topic = pairingTopic): void {
    this.pairings = [{ topic }];
  }
}

const clientWith = async (sdk: FakeSdk): Promise<{
  readonly acquisition: WalletConnectClientAcquisition;
  readonly client: WalletConnectClientPort;
  readonly init: WalletConnectSdkInitOptions;
  readonly scope: WalletConnectAcquisitionScope;
}> => {
  let init: WalletConnectSdkInitOptions | undefined;
  const factory: WalletConnectSdkFactory = async (options) => {
    init = options;
    return sdk;
  };
  const scope = createWalletConnectAcquisitionScope();
  const acquisition = await createWalletConnectClient(
    { projectId, metadata, privateStoreDirectory },
    scope.resources,
    ownerSignal(),
    factory,
  );
  if (init === undefined) throw new Error("SDK factory was not initialized.");
  return { acquisition, client: acquisition.client, init, scope };
};

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const captureFailure = (action: () => unknown): unknown => {
  try {
    action();
    return undefined;
  } catch (error) {
    return error;
  }
};

describe("WalletConnect client adapter", () => {
  it("narrows dynamic package exports without evaluating hostile accessors", async () => {
    let signClientGetterEvaluated = false;
    const hostileSignClientModule: Record<string, unknown> = {};
    Object.defineProperty(hostileSignClientModule, "SignClient", {
      enumerable: true,
      get() {
        signClientGetterEvaluated = true;
        throw new Error(pairingUri);
      },
    });

    const moduleFailure = await loadWalletConnectProductionDependencies(async (key) =>
      key === "signClient" ? hostileSignClientModule : { create: () => ({}) },
    ).catch((error: unknown) => error);
    expect(signClientGetterEvaluated).toBe(false);
    expect(isWalletConnectClientError(moduleFailure)).toBe(true);
    if (!isWalletConnectClientError(moduleFailure)) {
      throw new Error("Expected a typed module-boundary error.");
    }
    expect(moduleFailure.code).toBe("sdk_unavailable");
    expect(moduleFailure.message).not.toContain("wc:");

    class TestSignClient {
      static async init(): Promise<unknown> {
        return {};
      }
    }
    let modulesGetterEvaluated = false;
    const hostileQrResult: Record<string, unknown> = {};
    Object.defineProperty(hostileQrResult, "modules", {
      enumerable: true,
      get() {
        modulesGetterEvaluated = true;
        throw new Error(pairingUri);
      },
    });
    const dependencies = await loadWalletConnectProductionDependencies(async (key) =>
      key === "signClient"
        ? { SignClient: TestSignClient }
        : { create: () => hostileQrResult },
    );
    const qrFailure = captureFailure(() => dependencies.qrEncoder(pairingUri));
    expect(modulesGetterEvaluated).toBe(false);
    expect(isWalletConnectClientError(qrFailure)).toBe(true);
    if (!isWalletConnectClientError(qrFailure)) {
      throw new Error("Expected a typed QR-boundary error.");
    }
    expect(qrFailure.code).toBe("invalid_sdk_data");
  });

  it("copies only an exact accessor-free Uint8Array QR matrix", async () => {
    class TestSignClient {
      static async init(): Promise<unknown> {
        return {};
      }
    }
    const qrFailure = async (data: unknown): Promise<unknown> => {
      const dependencies = await loadWalletConnectProductionDependencies(async (key) =>
        key === "signClient"
          ? { SignClient: TestSignClient }
          : { create: () => ({ modules: { size: 21, data } }) },
      );
      return captureFailure(() => dependencies.qrEncoder(pairingUri));
    };

    class Uint8ArraySubclass extends Uint8Array {}
    const subclassFailure = await qrFailure(new Uint8ArraySubclass(21 * 21));
    expect(subclassFailure).toMatchObject({ code: "invalid_sdk_data" });

    let lengthGetterEvaluated = false;
    const accessorBacked = new Uint8Array(21 * 21);
    Object.defineProperty(accessorBacked, "length", {
      configurable: true,
      get() {
        lengthGetterEvaluated = true;
        throw new Error(pairingUri);
      },
    });
    const accessorFailure = await qrFailure(accessorBacked);
    expect(accessorFailure).toMatchObject({ code: "invalid_sdk_data" });
    expect(lengthGetterEvaluated).toBe(false);

    let speciesGetterEvaluated = false;
    const speciesBacked = new Uint8Array(21 * 21);
    Object.defineProperty(speciesBacked, "constructor", {
      configurable: true,
      get() {
        speciesGetterEvaluated = true;
        return { get [Symbol.species]() { return Uint8Array; } };
      },
    });
    const speciesFailure = await qrFailure(speciesBacked);
    expect(speciesFailure).toMatchObject({ code: "invalid_sdk_data" });
    expect(speciesGetterEvaluated).toBe(false);

    let proxyPrototypeRead = false;
    const proxied = new Proxy(new Uint8Array(21 * 21), {
      getPrototypeOf() {
        proxyPrototypeRead = true;
        throw new Error(pairingUri);
      },
    });
    const proxyFailure = await qrFailure(proxied);
    expect(proxyFailure).toMatchObject({ code: "invalid_sdk_data" });
    expect(proxyPrototypeRead).toBe(false);
  });

  it("captures the production SDK port once and closes an initialized malformed client", async () => {
    let transportCloseCalls = 0;
    let heartbeatStopCalls = 0;
    class TestRelayer {
      async transportClose(): Promise<void> {
        transportCloseCalls += 1;
      }
    }
    class TestHeartbeat {
      stop(): void {
        heartbeatStopCalls += 1;
      }
    }
    const relayer = new TestRelayer();
    const heartbeat = new TestHeartbeat();
    const validClient = productionClientShape(heartbeat, relayer);
    let initializedClient: unknown = validClient;
    class TestSignClient {
      static async init(): Promise<unknown> {
        return initializedClient;
      }
    }
    const moduleLoader = async (key: "signClient" | "qrCode"): Promise<unknown> =>
      key === "signClient"
        ? { SignClient: TestSignClient }
        : { create: () => ({}) };

    const successfulScope = createWalletConnectAcquisitionScope();
    const acquisition = await createWalletConnectClient(
      { projectId, metadata, privateStoreDirectory },
      successfulScope.resources,
      ownerSignal(),
      undefined,
      moduleLoader,
    );
    const client = acquisition.client;
    expect(client.listSessions()).toEqual([]);
    await client.close();
    expect(transportCloseCalls).toBe(1);
    expect(heartbeatStopCalls).toBe(1);

    initializedClient = {
      core: {
        heartbeat,
        relayer,
        pairing: {
          disconnect: async () => undefined,
          getPairings: () => [],
        },
      },
    };
    const malformedScope = createWalletConnectAcquisitionScope();
    await expect(createWalletConnectClient(
      { projectId, metadata, privateStoreDirectory },
      malformedScope.resources,
      ownerSignal(),
      undefined,
      moduleLoader,
    )).rejects.toMatchObject({ code: "sdk_unavailable" });
    await expect(malformedScope.close()).resolves.toBeUndefined();
    expect(transportCloseCalls).toBe(2);
    expect(heartbeatStopCalls).toBe(2);

    let pairingGetterEvaluated = false;
    const hostilePairing: Record<string, unknown> = {
      disconnect: async () => undefined,
    };
    Object.defineProperty(hostilePairing, "getPairings", {
      enumerable: true,
      get() {
        pairingGetterEvaluated = true;
        throw new Error(pairingUri);
      },
    });
    initializedClient = productionClientShape(heartbeat, relayer, hostilePairing);
    const hostileScope = createWalletConnectAcquisitionScope();
    await expect(createWalletConnectClient(
      { projectId, metadata, privateStoreDirectory },
      hostileScope.resources,
      ownerSignal(),
      undefined,
      moduleLoader,
    )).rejects.toMatchObject({ code: "sdk_unavailable" });
    await expect(hostileScope.close()).resolves.toBeUndefined();
    expect(pairingGetterEvaluated).toBe(false);
    expect(transportCloseCalls).toBe(3);
    expect(heartbeatStopCalls).toBe(3);

    initializedClient = {
      core: {
        heartbeat,
        pairing: {
          disconnect: async () => undefined,
          getPairings: () => [],
        },
      },
    };
    const missingRelayerScope = createWalletConnectAcquisitionScope();
    await expect(createWalletConnectClient(
      { projectId, metadata, privateStoreDirectory },
      missingRelayerScope.resources,
      ownerSignal(),
      undefined,
      moduleLoader,
    )).rejects.toMatchObject({ code: "sdk_unavailable" });
    await expect(missingRelayerScope.close()).resolves.toBeUndefined();
    expect(transportCloseCalls).toBe(3);
    expect(heartbeatStopCalls).toBe(4);

    initializedClient = {
      core: {
        relayer,
        pairing: {
          disconnect: async () => undefined,
          getPairings: () => [],
        },
      },
    };
    const missingHeartbeatScope = createWalletConnectAcquisitionScope();
    await expect(createWalletConnectClient(
      { projectId, metadata, privateStoreDirectory },
      missingHeartbeatScope.resources,
      ownerSignal(),
      undefined,
      moduleLoader,
    )).rejects.toMatchObject({ code: "sdk_unavailable" });
    await expect(missingHeartbeatScope.close()).resolves.toBeUndefined();
    expect(transportCloseCalls).toBe(4);
    expect(heartbeatStopCalls).toBe(4);
  });

  it("shares one production close and releases transport before heartbeat", async () => {
    const bootstrapSdk = new FakeSdk();
    const { client: bootstrapClient, init } = await clientWith(bootstrapSdk);
    await bootstrapClient.close();
    const transportGate = deferred<void>();
    const lifecycleEvents: string[] = [];
    class TestRelayer {
      async transportClose(): Promise<void> {
        lifecycleEvents.push("transport:start");
        await transportGate.promise;
        lifecycleEvents.push("transport:finish");
      }
    }
    class TestHeartbeat {
      stop(): void {
        lifecycleEvents.push("heartbeat:stop");
      }
    }
    const initializedClient = productionClientShape(
      new TestHeartbeat(),
      new TestRelayer(),
    );
    class TestSignClient {
      static async init(): Promise<unknown> {
        return initializedClient;
      }
    }
    const dependencies = await loadWalletConnectProductionDependencies(async (key) =>
      key === "signClient"
        ? { SignClient: TestSignClient }
        : { create: () => ({}) },
    );
    const sdk = await dependencies.sdkFactory(init, { retainCleanup: () => undefined });

    const firstClose = sdk.close();
    const concurrentClose = sdk.close();
    expect(concurrentClose).toBe(firstClose);
    await vi.waitFor(() => expect(lifecycleEvents).toEqual(["transport:start"]));
    transportGate.resolve();
    await expect(firstClose).resolves.toBeUndefined();
    expect(lifecycleEvents).toEqual([
      "transport:start",
      "transport:finish",
      "heartbeat:stop",
    ]);
  });

  it("lets a production-shaped child process exit naturally after SDK close", async () => {
    const workerPath = fileURLToPath(
      new URL("./walletconnect-natural-exit-worker.ts", import.meta.url),
    );
    const storeRoot = await mkdtemp(resolve(tmpdir(), "littlejohn-wallet-natural-exit-"));
    try {
      const child = spawn(process.execPath, ["--import", "tsx", workerPath], {
        env: {
          ...process.env,
          TSX_DISABLE_CACHE: "1",
          LITTLEJOHN_TEST_WALLETCONNECT_STORE_ROOT: storeRoot,
        },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer | string) => { stderr += chunk.toString(); });
      const result = await new Promise<{
        readonly code: number | null;
        readonly signal: NodeJS.Signals | null;
      }>((resolveExit, rejectExit) => {
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          rejectExit(new Error(`WalletConnect close did not release the child process.\n${stderr}`));
        }, 5_000);
        child.once("error", (error) => {
          clearTimeout(timeout);
          rejectExit(error);
        });
        child.once("exit", (code, signal) => {
          clearTimeout(timeout);
          resolveExit({ code, signal });
        });
      });
      expect(result).toEqual({ code: 0, signal: null });
      expect(stderr).toBe("");
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  it("normalizes direct production SDK factory failures without exposing provider data", async () => {
    const sdk = new FakeSdk();
    const { client, init } = await clientWith(sdk);
    await client.close();

    class ThrowingSignClient {
      static async init(): Promise<never> {
        throw new Error(`provider initialization failed ${pairingUri}`);
      }
    }
    const dependencies = await loadWalletConnectProductionDependencies(async (key) =>
      key === "signClient"
        ? { SignClient: ThrowingSignClient }
        : { create: () => ({ modules: { size: 21, data: new Uint8Array(21 * 21) } }) },
    );
    const failure = await dependencies.sdkFactory(init, {
      retainCleanup: () => undefined,
    }).catch((error: unknown) => error);
    expect(isWalletConnectClientError(failure)).toBe(true);
    if (!isWalletConnectClientError(failure)) {
      throw new Error("Expected a typed production SDK failure.");
    }
    expect(failure.code).toBe("sdk_unavailable");
    expect(failure.message).not.toContain("provider initialization failed");
    expect(JSON.stringify(failure)).not.toContain("wc:");
  });

  it("retains a malformed initialized SDK handle until its full lifecycle cleanup is proven", async () => {
    let transportCloseCalls = 0;
    let heartbeatStopCalls = 0;
    let cleanupFails = true;
    let heartbeatFails = false;
    class TestRelayer {
      async transportClose(): Promise<void> {
        transportCloseCalls += 1;
        if (cleanupFails) throw new Error(pairingUri);
      }
    }
    const relayer = new TestRelayer();
    class TestHeartbeat {
      stop(): void {
        heartbeatStopCalls += 1;
        if (heartbeatFails) throw new Error(pairingUri);
      }
    }
    const heartbeat = new TestHeartbeat();
    const pairing = {
      disconnect: async () => undefined,
      getPairings: () => [],
    };
    const validClient = productionClientShape(heartbeat, relayer, pairing);
    let initializedClient: unknown = { core: { heartbeat, relayer, pairing } };
    let initializationCalls = 0;
    class TestSignClient {
      static async init(): Promise<unknown> {
        initializationCalls += 1;
        return initializedClient;
      }
    }
    const moduleLoader = async (key: "signClient" | "qrCode"): Promise<unknown> =>
      key === "signClient"
        ? { SignClient: TestSignClient }
        : { create: () => ({}) };
    const storeDirectory = resolve(
      ".WORK/tests/walletconnect-client/pending-normalization-cleanup",
    );

    const failedScope = createWalletConnectAcquisitionScope();
    const normalizationFailure = await createWalletConnectClient(
      { projectId, metadata, privateStoreDirectory: storeDirectory },
      failedScope.resources,
      ownerSignal(),
      undefined,
      moduleLoader,
    ).catch((error: unknown) => error);
    expect(normalizationFailure).toMatchObject({ code: "sdk_unavailable" });
    if (!isWalletConnectClientError(normalizationFailure)) {
      throw new Error("Expected a typed normalization failure.");
    }
    const failureDescriptors = Object.getOwnPropertyDescriptors(normalizationFailure);
    expect(Reflect.ownKeys(failureDescriptors)).not.toContain("cleanup");
    expect(Reflect.ownKeys(failureDescriptors)).not.toContain("retainedHandle");
    expect(Object.values(failureDescriptors).some((descriptor) =>
      "value" in descriptor && descriptor.value === initializedClient)).toBe(false);
    expect(JSON.stringify(normalizationFailure)).not.toContain("wc:");
    expect(initializationCalls).toBe(1);
    await vi.waitFor(() => expect(transportCloseCalls).toBe(1));
    expect(heartbeatStopCalls).toBe(1);

    initializedClient = validClient;
    await expect(failedScope.close()).rejects.toMatchObject({ code: "sdk_unavailable" });
    expect(initializationCalls).toBe(1);
    expect(transportCloseCalls).toBe(1);
    expect(heartbeatStopCalls).toBe(1);

    cleanupFails = false;
    await expect(failedScope.close()).resolves.toBeUndefined();
    expect(initializationCalls).toBe(1);
    expect(transportCloseCalls).toBe(2);
    expect(heartbeatStopCalls).toBe(1);

    const successfulScope = createWalletConnectAcquisitionScope();
    const acquisition = await createWalletConnectClient(
      { projectId, metadata, privateStoreDirectory: storeDirectory },
      successfulScope.resources,
      ownerSignal(),
      undefined,
      moduleLoader,
    );
    const client = acquisition.client;
    expect(initializationCalls).toBe(2);
    await client.close();
    expect(transportCloseCalls).toBe(3);
    expect(heartbeatStopCalls).toBe(2);

    heartbeatFails = true;
    const heartbeatFailureScope = createWalletConnectAcquisitionScope();
    const heartbeatFailureAcquisition = await createWalletConnectClient(
      { projectId, metadata, privateStoreDirectory: storeDirectory },
      heartbeatFailureScope.resources,
      ownerSignal(),
      undefined,
      moduleLoader,
    );
    await expect(heartbeatFailureAcquisition.client.close()).rejects.toMatchObject({
      code: "sdk_unavailable",
    });
    expect(transportCloseCalls).toBe(4);
    expect(heartbeatStopCalls).toBe(3);

    heartbeatFails = false;
    await expect(heartbeatFailureAcquisition.client.close()).resolves.toBeUndefined();
    expect(transportCloseCalls).toBe(4);
    expect(heartbeatStopCalls).toBe(4);
  });

  it("treats an early acquisition timer as a wakeup and closes the late SDK handle exactly once", async () => {
    const sdk = new FakeSdk();
    const sdkGate = deferred<WalletConnectSdkPort>();
    const scope = createWalletConnectAcquisitionScope();
    let factoryCalls = 0;
    vi.useFakeTimers();
    const now = vi.spyOn(performance, "now").mockReturnValue(100);
    try {
      const creation = createWalletConnectClient(
        { projectId, metadata, privateStoreDirectory },
        scope.resources,
        ownerSignal(),
        async () => {
          factoryCalls += 1;
          return sdkGate.promise;
        },
        customSdkModuleLoader,
      );
      const creationFailure = creation.catch((error: unknown) => error);
      for (let index = 0; index < 4; index += 1) await flushMicrotasks();
      expect(factoryCalls).toBe(1);

      await vi.advanceTimersToNextTimerAsync();
      let creationSettled = false;
      void creation.then(() => { creationSettled = true; }, () => { creationSettled = true; });
      await flushMicrotasks();
      expect(creationSettled).toBe(false);

      now.mockReturnValue(300_100);
      await vi.advanceTimersToNextTimerAsync();
      await expect(creationFailure).resolves.toMatchObject({ code: "sdk_unavailable" });
      expect(scope.size).toBe(1);
      await expect(scope.close()).rejects.toMatchObject({ code: "sdk_unavailable" });

      sdkGate.resolve(sdk);
      for (let index = 0; index < 4; index += 1) await flushMicrotasks();
      expect(sdk.sdkCloseCalls).toBe(1);
      await expect(scope.close()).resolves.toBeUndefined();
      expect(scope.empty).toBe(true);
    } finally {
      now.mockRestore();
      vi.useRealTimers();
    }
  });

  it("returns the actual SDK cleanup promise without imposing an adapter close deadline", async () => {
    const sdk = new FakeSdk();
    const sdkCloseGate = deferred<void>();
    sdk.close = async () => {
      sdk.sdkCloseCalls += 1;
      await sdkCloseGate.promise;
    };
    const { client, scope } = await clientWith(sdk);

    vi.useFakeTimers();
    try {
      const closing = client.close();
      const repeated = client.close();
      expect(repeated).toBe(closing);
      let closeSettled = false;
      void closing.then(() => { closeSettled = true; }, () => { closeSettled = true; });
      for (let index = 0; index < 4; index += 1) await flushMicrotasks();
      expect(sdk.sdkCloseCalls).toBe(1);
      const scopeClosing = scope.close();
      let scopeCloseSettled = false;
      void scopeClosing.then(
        () => { scopeCloseSettled = true; },
        () => { scopeCloseSettled = true; },
      );
      await vi.advanceTimersByTimeAsync(10 * 60 * 1_000);
      expect(closeSettled).toBe(false);
      expect(scopeCloseSettled).toBe(false);
      expect(scope.size).toBe(1);

      sdkCloseGate.resolve();
      await expect(closing).resolves.toBeUndefined();
      await expect(scopeClosing).resolves.toBeUndefined();
      expect(scope.empty).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses one absolute acquisition budget across module loading, SDK creation, and initialization", async () => {
    const sdk = new FakeSdk();
    sdk.pairings = [{ topic: pairingTopic }];
    const moduleGate = deferred<void>();
    const factoryGate = deferred<void>();
    const initializationGate = deferred<void>();
    let moduleCalls = 0;
    let factoryCalls = 0;
    sdk.pairingDisconnect = async () => {
      await initializationGate.promise;
      sdk.pairings = [];
    };
    const scope = createWalletConnectAcquisitionScope();
    const controller = new AbortController();

    vi.useFakeTimers();
    let monotonicNow = 0;
    const now = vi.spyOn(performance, "now").mockImplementation(() => monotonicNow);
    try {
      const creation = createWalletConnectClient(
        { projectId, metadata, privateStoreDirectory },
        scope.resources,
        controller.signal,
        async () => {
          factoryCalls += 1;
          await factoryGate.promise;
          return sdk;
        },
        async (key) => {
          moduleCalls += 1;
          await moduleGate.promise;
          return customSdkModuleLoader(key);
        },
      );
      const failure = creation.catch((error: unknown) => error);
      await flushMicrotasks();
      expect(moduleCalls).toBe(2);

      monotonicNow = 2 * 60 * 1_000;
      await vi.advanceTimersByTimeAsync(2 * 60 * 1_000);
      moduleGate.resolve();
      for (let index = 0; index < 8; index += 1) await flushMicrotasks();
      expect(factoryCalls).toBe(1);

      monotonicNow = 4 * 60 * 1_000;
      await vi.advanceTimersByTimeAsync(2 * 60 * 1_000);
      factoryGate.resolve();
      for (let index = 0; index < 8; index += 1) await flushMicrotasks();
      expect(sdk.pairingDisconnects).toEqual([pairingTopic]);

      monotonicNow = 5 * 60 * 1_000;
      await vi.advanceTimersByTimeAsync(60 * 1_000);
      await expect(failure).resolves.toMatchObject({ code: "sdk_unavailable" });
      expect(sdk.sdkCloseCalls).toBe(0);

      initializationGate.resolve();
      await expect(scope.close()).resolves.toBeUndefined();
      expect(sdk.sdkCloseCalls).toBe(1);
    } finally {
      now.mockRestore();
      vi.useRealTimers();
    }
  });

  it("rejects owner-aborted acquisition and cleans a handle that arrives after abort", async () => {
    const sdk = new FakeSdk();
    const sdkGate = deferred<WalletConnectSdkPort>();
    const scope = createWalletConnectAcquisitionScope();
    const controller = new AbortController();
    let factoryCalls = 0;
    const creation = createWalletConnectClient(
      { projectId, metadata, privateStoreDirectory },
      scope.resources,
      controller.signal,
      async () => {
        factoryCalls += 1;
        return sdkGate.promise;
      },
      customSdkModuleLoader,
    );
    await vi.waitFor(() => expect(factoryCalls).toBe(1));

    controller.abort();
    await expect(creation).rejects.toMatchObject({ code: "sdk_unavailable" });
    await expect(scope.close()).rejects.toMatchObject({ code: "sdk_unavailable" });

    sdkGate.resolve(sdk);
    await vi.waitFor(() => expect(sdk.sdkCloseCalls).toBe(1));
    await expect(scope.close()).resolves.toBeUndefined();
    expect(sdk.sdkCloseCalls).toBe(1);
  });

  it("cleans both production lifecycle handles that arrive after owner abort", async () => {
    const initializedClientGate = deferred<unknown>();
    let initializationCalls = 0;
    let transportCloseCalls = 0;
    let heartbeatStopCalls = 0;
    class TestRelayer {
      async transportClose(): Promise<void> {
        transportCloseCalls += 1;
      }
    }
    class TestHeartbeat {
      stop(): void {
        heartbeatStopCalls += 1;
      }
    }
    class TestSignClient {
      static async init(): Promise<unknown> {
        initializationCalls += 1;
        return initializedClientGate.promise;
      }
    }
    const scope = createWalletConnectAcquisitionScope();
    const controller = new AbortController();
    const creation = createWalletConnectClient(
      { projectId, metadata, privateStoreDirectory },
      scope.resources,
      controller.signal,
      undefined,
      async (key) => key === "signClient"
        ? { SignClient: TestSignClient }
        : { create: () => ({}) },
    );
    await vi.waitFor(() => expect(initializationCalls).toBe(1));

    controller.abort();
    await expect(creation).rejects.toMatchObject({ code: "sdk_unavailable" });
    initializedClientGate.resolve(productionClientShape(
      new TestHeartbeat(),
      new TestRelayer(),
    ));
    await vi.waitFor(() => {
      expect(transportCloseCalls).toBe(1);
      expect(heartbeatStopCalls).toBe(1);
    });
    await expect(scope.close()).resolves.toBeUndefined();
  });

  it("checks the monotonic acquisition deadline after SDK fulfillment", async () => {
    vi.useFakeTimers();
    let monotonicNow = 0;
    const now = vi.spyOn(performance, "now").mockImplementation(() => monotonicNow);
    try {
      const fulfilledSdk = new FakeSdk();
      const fulfilledGate = deferred<WalletConnectSdkPort>();
      const fulfilledScope = createWalletConnectAcquisitionScope();
      let fulfilledFactoryCalls = 0;
      const fulfilledCreation = createWalletConnectClient(
        { projectId, metadata, privateStoreDirectory },
        fulfilledScope.resources,
        ownerSignal(),
        async () => {
          fulfilledFactoryCalls += 1;
          return fulfilledGate.promise;
        },
        customSdkModuleLoader,
      );
      await vi.waitFor(() => expect(fulfilledFactoryCalls).toBe(1));
      monotonicNow = 5 * 60 * 1_000;
      fulfilledGate.resolve(fulfilledSdk);
      await expect(fulfilledCreation).rejects.toMatchObject({ code: "sdk_unavailable" });
      for (let index = 0; index < 8; index += 1) await flushMicrotasks();
      expect(fulfilledSdk.sdkCloseCalls).toBe(1);
      await expect(fulfilledScope.close()).resolves.toBeUndefined();

    } finally {
      now.mockRestore();
      vi.useRealTimers();
    }
  });

  it("releases acquisition ownership when the SDK factory rejects without producing a handle", async () => {
    const rejectedGate = deferred<WalletConnectSdkPort>();
    const scope = createWalletConnectAcquisitionScope();
    let factoryCalls = 0;
    const creation = createWalletConnectClient(
      { projectId, metadata, privateStoreDirectory },
      scope.resources,
      ownerSignal(),
      async () => {
        factoryCalls += 1;
        return rejectedGate.promise;
      },
      customSdkModuleLoader,
    );
    await vi.waitFor(() => expect(factoryCalls).toBe(1));

    rejectedGate.reject(new Error(`provider secret ${pairingUri}`));
    const failure = await creation.catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "sdk_unavailable" });
    expect(String(failure)).not.toContain("provider secret");
    await expect(scope.close()).resolves.toBeUndefined();
    expect(scope.empty).toBe(true);
  });

  it("rejects adoption after owner abort and requests retained client cleanup", async () => {
    const sdk = new FakeSdk();
    const scope = createWalletConnectAcquisitionScope();
    const controller = new AbortController();
    const acquisition = await createWalletConnectClient(
      { projectId, metadata, privateStoreDirectory },
      scope.resources,
      controller.signal,
      async () => sdk,
      customSdkModuleLoader,
    );

    controller.abort();
    let replacementCloses = 0;
    expect(() => acquisition.replace({ close: async () => { replacementCloses += 1; } }))
      .toThrow("WalletConnect is unavailable");
    await vi.waitFor(() => expect(sdk.sdkCloseCalls).toBe(1));
    await expect(scope.close()).resolves.toBeUndefined();
    expect(sdk.sdkCloseCalls).toBe(1);
    expect(replacementCloses).toBe(1);
  });

  it("does not impose the acquisition deadline on serialized adapter commands", async () => {
    const sdk = new FakeSdk();
    sdk.sessions = [session()];
    const disconnectGate = deferred<void>();
    sdk.sessionDisconnect = async (topic) => {
      await disconnectGate.promise;
      sdk.sessions = sdk.sessions.filter((value) =>
        (value as { readonly topic: string }).topic !== topic);
    };
    const { client } = await clientWith(sdk);

    vi.useFakeTimers();
    try {
      const disconnecting = client.disconnectSession(firstSessionTopic);
      let settled = false;
      void disconnecting.then(() => { settled = true; }, () => { settled = true; });
      await vi.waitFor(() => expect(sdk.sessionDisconnects).toEqual([firstSessionTopic]));
      await vi.advanceTimersByTimeAsync(10 * 60 * 1_000);
      expect(settled).toBe(false);

      disconnectGate.resolve();
      await expect(disconnecting).resolves.toEqual([]);
      await expect(client.close()).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes only the fixed SDK initialization and connection contracts and exposes positive-list ports", async () => {
    const sdk = new FakeSdk();
    const { acquisition, client, init } = await clientWith(sdk);

    expect(Object.keys(init).sort()).toEqual([
      "logger",
      "metadata",
      "name",
      "projectId",
      "storageOptions",
      "telemetryEnabled",
    ]);
    expect(init).toMatchObject({
      projectId,
      name: metadata.name,
      metadata,
      storageOptions: { database: privateStoreDirectory },
      telemetryEnabled: false,
    });
    expect(init.logger.level).toBe("warn");
    expect(Object.keys(client).sort()).toEqual([
      "close",
      "disconnectSession",
      "listSessions",
      "startConnection",
      "subscribe",
    ]);
    expect(Object.isFrozen(client)).toBe(true);
    expect(Object.keys(acquisition).sort()).toEqual(["client", "replace", "transfer"]);
    expect(Object.isFrozen(acquisition)).toBe(true);

    const consoleMethods = ["error", "warn", "info", "debug", "trace", "log"] as const;
    const consoleSpies = consoleMethods.map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
    try {
      const secret = { pairingUri };
      init.logger.trace(secret);
      init.logger.debug(secret);
      init.logger.info(secret);
      init.logger.warn(secret);
      init.logger.error(secret);
      init.logger.fatal(secret);
      init.logger.child(secret).error(secret);
      expect(consoleSpies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
    } finally {
      for (const spy of consoleSpies) spy.mockRestore();
    }

    const attempt = await client.startConnection();
    expect(Object.keys(attempt).sort()).toEqual(["cancel", "qr", "wait"]);
    expect(Object.isFrozen(attempt)).toBe(true);
    expect(JSON.stringify(attempt)).not.toContain("wc:");
    expect(JSON.stringify(attempt)).not.toContain(pairingTopic);
    expect(attempt.qr.rows).toHaveLength(attempt.qr.size);
    expect(Object.isFrozen(attempt.qr)).toBe(true);
    expect(Object.isFrozen(attempt.qr.rows)).toBe(true);

    expect(sdk.connectInputs).toEqual([{
      requiredNamespaces: {
        eip155: {
          chains: ["eip155:4663"],
          methods: ["eth_sendTransaction"],
          events: ["accountsChanged", "chainChanged"],
        },
      },
    }]);
    expect(Object.keys(sdk.connectInputs[0] ?? {})).toEqual(["requiredNamespaces"]);
    await expect(client.startConnection()).rejects.toThrow("already active");

    const firstWait = attempt.wait();
    const secondWait = attempt.wait();
    await flushMicrotasks();
    expect(sdk.approvalCalls).toBe(1);

    const rawSession = session();
    sdk.sessions = [rawSession];
    sdk.approvalResult.resolve(rawSession);
    const [firstOutcome, secondOutcome] = await Promise.all([firstWait, secondWait]);
    expect(firstOutcome).toBe(secondOutcome);
    expect(firstOutcome.status).toBe("approved");
    if (firstOutcome.status !== "approved") throw new Error("Expected approved outcome.");
    expect(firstOutcome.session).toEqual({
      topic: firstSessionTopic,
      expiry: 1_783_791_906,
      namespaces: { eip155: namespace() },
    });
    expect(Object.keys(firstOutcome.session).sort()).toEqual(["expiry", "namespaces", "topic"]);
    expect(Object.isFrozen(firstOutcome)).toBe(true);
    expect(Object.isFrozen(firstOutcome.session)).toBe(true);
    expect(Object.isFrozen(firstOutcome.session.namespaces["eip155"]?.accounts)).toBe(true);
    rawSession.namespaces.eip155.accounts[0] = "mutated";
    expect(firstOutcome.session.namespaces["eip155"]?.accounts[0]).toContain("0x111111");

    expect(await attempt.cancel()).toBe(firstOutcome);
    expect(sdk.pairingDisconnects).toEqual([]);
  });

  it("retains each completed acquisition owner until the outer composer transfers it", async () => {
    const sdk = new FakeSdk();
    const { acquisition, client, scope } = await clientWith(sdk);
    let ownerCloseCalls = 0;
    const owner = Object.freeze({
      close: async () => {
        ownerCloseCalls += 1;
        await client.close();
      },
    });

    expect(scope.size).toBe(1);
    acquisition.replace(owner);
    expect(scope.size).toBe(1);
    acquisition.transfer();
    expect(scope.empty).toBe(true);
    await expect(scope.close()).resolves.toBeUndefined();
    expect(ownerCloseCalls).toBe(0);
    await owner.close();
    expect(ownerCloseCalls).toBe(1);
    expect(sdk.sdkCloseCalls).toBe(1);
  });

  it("returns fixed typed adapter errors without exposing unknown SDK failures", async () => {
    const sdk = new FakeSdk();
    sdk.startConnection = async () => {
      throw new Error(`provider failure ${pairingUri}`);
    };
    const { client } = await clientWith(sdk);

    const sdkFailure = await client.startConnection().catch((error: unknown) => error);
    expect(isWalletConnectClientError(sdkFailure)).toBe(true);
    if (!isWalletConnectClientError(sdkFailure)) throw new Error("Expected a typed client error.");
    expect(sdkFailure).toMatchObject({
      name: "WalletConnectClientError",
      code: "sdk_unavailable",
      message: "WalletConnect is unavailable.",
    });
    expect(Object.isFrozen(sdkFailure)).toBe(true);
    expect(JSON.stringify(sdkFailure)).not.toContain("wc:");
    const hostileUnknown = new Proxy({}, {
      getPrototypeOf() {
        throw new Error(pairingUri);
      },
    });
    expect(() => isWalletConnectClientError(hostileUnknown)).not.toThrow();
    expect(isWalletConnectClientError(hostileUnknown)).toBe(false);

    const configurationScope = createWalletConnectAcquisitionScope();
    const configurationFailure = await createWalletConnectClient(
      { projectId: "not-a-project-id", metadata, privateStoreDirectory },
      configurationScope.resources,
      ownerSignal(),
      async () => sdk,
    ).catch((error: unknown) => error);
    expect(isWalletConnectClientError(configurationFailure)).toBe(true);
    if (!isWalletConnectClientError(configurationFailure)) {
      throw new Error("Expected a typed configuration error.");
    }
    expect(configurationFailure.code).toBe("invalid_configuration");
    expect(configurationScope.empty).toBe(true);
  });

  it("rejects pairing URI text beyond the SDK boundary before QR generation", async () => {
    const sdk = new FakeSdk();
    const oversizedUri = `${pairingUri}&padding=${"a".repeat(512)}`;
    sdk.startConnection = async (input) => {
      sdk.connectInputs.push(input);
      sdk.storePairing();
      return sdk.connectionAttempt(
        oversizedUri,
        pairingTopic,
        undefined,
        sdk.approvalResult.promise,
      );
    };
    const { client } = await clientWith(sdk);

    const failure = await client.startConnection().catch((error: unknown) => error);
    expect(isWalletConnectClientError(failure)).toBe(true);
    if (!isWalletConnectClientError(failure)) throw new Error("Expected a typed client error.");
    expect(failure.code).toBe("sdk_unavailable");
    expect(failure.message).toBe("WalletConnect is unavailable.");
    expect(failure.message).not.toContain(oversizedUri);
    expect(sdk.pairingDisconnects).toEqual([]);
    expect(sdk.pairings).toEqual([{ topic: pairingTopic }]);
    expect(sdk.approvalCalls).toBe(1);
    expect(() => client.listSessions()).toThrow("WalletConnect is unavailable");
  });

  it("does not claim temporal cleanup authority when SDK start fails before handoff", async () => {
    const sdk = new FakeSdk();
    sdk.startConnection = async (input) => {
      sdk.connectInputs.push(input);
      sdk.storePairing();
      throw new Error(pairingUri);
    };
    const { client } = await clientWith(sdk);

    await expect(client.startConnection()).rejects.toMatchObject({ code: "sdk_unavailable" });
    expect(sdk.pairingDisconnects).toEqual([]);
    expect(sdk.pairings).toEqual([{ topic: pairingTopic }]);
    expect(() => client.listSessions()).toThrow("WalletConnect is unavailable");
    await expect(client.close()).resolves.toBeUndefined();
  });

  it("removes an unowned pairing from the SDK store during startup reconciliation", async () => {
    const sdk = new FakeSdk();
    sdk.pairings = [{ topic: pairingTopic, relay: { secret: pairingUri } }];

    const { client } = await clientWith(sdk);

    expect(sdk.pairingDisconnects).toEqual([pairingTopic]);
    expect(sdk.pairings).toEqual([]);
    expect(client.listSessions()).toEqual([]);
    await expect(client.close()).resolves.toBeUndefined();
  });

  it("preserves the exact pairing owned by a valid restored session", async () => {
    const sdk = new FakeSdk();
    sdk.sessions = [session()];
    sdk.pairings = [{ topic: pairingTopic }];

    const { client } = await clientWith(sdk);

    expect(sdk.sessionDisconnects).toEqual([]);
    expect(sdk.pairingDisconnects).toEqual([]);
    expect(client.listSessions().map((value) => value.topic)).toEqual([firstSessionTopic]);
    await expect(client.close()).resolves.toBeUndefined();
    expect(sdk.sessions).toHaveLength(1);
    expect(sdk.pairings).toEqual([{ topic: pairingTopic }]);
  });

  it("reads session deletion while the independent pairing remains", async () => {
    const sdk = new FakeSdk();
    sdk.sessions = [session()];
    sdk.pairings = [{ topic: pairingTopic }];
    const { client } = await clientWith(sdk);
    const events: WalletConnectClientEvent[] = [];
    client.subscribe((event) => events.push(event));

    sdk.sessions = [];
    sdk.emit("session_delete", { topic: firstSessionTopic });

    expect(events).toEqual([{ kind: "session_deleted", topic: firstSessionTopic }]);
    expect(client.listSessions()).toEqual([]);
    expect(sdk.pairings).toEqual([{ topic: pairingTopic }]);

    const attempt = await client.startConnection();
    expect(sdk.pairingDisconnects).toEqual([pairingTopic]);
    await expect(attempt.cancel()).resolves.toEqual({ status: "cancelled" });
    await client.close();
  });

  it("keeps deleted-session reads available when stale pairing cleanup fails", async () => {
    const sdk = new FakeSdk();
    sdk.sessions = [session()];
    sdk.pairings = [{ topic: pairingTopic }];
    const { client } = await clientWith(sdk);

    sdk.sessions = [];
    sdk.emit("session_delete", { topic: firstSessionTopic });
    sdk.pairingDisconnect = async () => { throw new Error(pairingUri); };

    expect(client.listSessions()).toEqual([]);
    await expect(client.startConnection()).rejects.toMatchObject({ code: "sdk_unavailable" });
    expect(sdk.pairingDisconnects).toEqual([pairingTopic]);
    expect(client.listSessions()).toEqual([]);
    await client.close();
  });

  it("keeps session reads separate from unrelated pairing-store integrity", async () => {
    const sdk = new FakeSdk();
    sdk.sessions = [session()];
    sdk.pairings = [{ topic: pairingTopic }];
    const { client } = await clientWith(sdk);
    const hostilePairing: Record<string, unknown> = {};
    Object.defineProperty(hostilePairing, "topic", {
      enumerable: true,
      get() {
        throw new Error(pairingUri);
      },
    });
    sdk.pairings = [hostilePairing];

    expect(client.listSessions().map(({ topic }) => topic)).toEqual([firstSessionTopic]);
    await expect(client.startConnection()).rejects.toMatchObject({ code: "sdk_unavailable" });
    await client.close();
  });

  it("removes a known-topic malformed session and its stale pairing during startup", async () => {
    const sdk = new FakeSdk();
    sdk.sessions = [{ ...session(), expiry: 0 }];
    sdk.pairings = [{ topic: pairingTopic }];

    const { client } = await clientWith(sdk);

    expect(sdk.sessionDisconnects).toEqual([firstSessionTopic]);
    expect(sdk.pairingDisconnects).toEqual([pairingTopic]);
    expect(sdk.sessions).toEqual([]);
    expect(sdk.pairings).toEqual([]);
    expect(client.listSessions()).toEqual([]);
    await expect(client.close()).resolves.toBeUndefined();
  });

  it("releases a failed startup client and lets the next owner reconcile its store", async () => {
    const firstSdk = new FakeSdk();
    firstSdk.pairings = [{ topic: pairingTopic }];
    firstSdk.pairingDisconnect = async () => {
      throw new Error(pairingUri);
    };
    const storeDirectory = resolve(
      ".WORK/tests/walletconnect-client/pending-startup-cleanup",
    );

    const failedScope = createWalletConnectAcquisitionScope();
    await expect(createWalletConnectClient(
      { projectId, metadata, privateStoreDirectory: storeDirectory },
      failedScope.resources,
      ownerSignal(),
      async () => firstSdk,
    )).rejects.toMatchObject({ code: "sdk_unavailable" });
    expect(firstSdk.sdkCloseCalls).toBe(0);
    await expect(failedScope.close()).resolves.toBeUndefined();
    expect(firstSdk.sdkCloseCalls).toBe(1);

    const secondSdk = new FakeSdk();
    secondSdk.pairings = [{ topic: pairingTopic }];
    let secondFactoryCalls = 0;
    const successfulScope = createWalletConnectAcquisitionScope();
    const acquisition = await createWalletConnectClient(
      { projectId, metadata, privateStoreDirectory: storeDirectory },
      successfulScope.resources,
      ownerSignal(),
      async () => {
        secondFactoryCalls += 1;
        return secondSdk;
      },
    );
    const client = acquisition.client;

    expect(firstSdk.sdkCloseCalls).toBe(1);
    expect(secondFactoryCalls).toBe(1);
    expect(secondSdk.pairingDisconnects).toEqual([pairingTopic]);
    await client.close();
    expect(secondSdk.sdkCloseCalls).toBe(1);
  });

  it("blocks all operations while a known failed pairing cleanup remains unresolved", async () => {
    const sdk = new FakeSdk();
    const oversizedUri = `${pairingUri}&padding=${"a".repeat(512)}`;
    sdk.startConnection = async (input) => {
      sdk.connectInputs.push(input);
      sdk.storePairing();
      return sdk.connectionAttempt(
        oversizedUri,
        pairingTopic,
        undefined,
        sdk.approvalResult.promise,
      );
    };
    sdk.pairingDisconnect = async () => {
      throw new Error(pairingUri);
    };
    const { client } = await clientWith(sdk);

    await expect(client.startConnection()).rejects.toMatchObject({ code: "sdk_unavailable" });
    expect(sdk.connectInputs).toHaveLength(1);
    expect(sdk.pairingDisconnects).toEqual([]);
    expect(() => client.listSessions()).toThrow("WalletConnect is unavailable");
    await expect(client.startConnection()).rejects.toMatchObject({ code: "sdk_unavailable" });
    expect(sdk.connectInputs).toHaveLength(1);
    await expect(client.disconnectSession(firstSessionTopic)).rejects.toMatchObject({
      code: "sdk_unavailable",
    });
    expect(sdk.sessionDisconnects).toEqual([]);
    await expect(client.close()).resolves.toBeUndefined();
    expect(sdk.sdkCloseCalls).toBe(1);
    expect(sdk.pairingDisconnects).toEqual([]);
  });

  it("never reuses an adapter after an invalid connection handoff", async () => {
    const sdk = new FakeSdk();
    const oversizedUri = `${pairingUri}&padding=${"a".repeat(512)}`;
    let connectionCount = 0;
    sdk.startConnection = async (input) => {
      sdk.connectInputs.push(input);
      connectionCount += 1;
      sdk.storePairing();
      return sdk.connectionAttempt(
        connectionCount === 1 ? oversizedUri : pairingUri,
        pairingTopic,
        undefined,
        sdk.approvalResult.promise,
      );
    };
    let cleanupCount = 0;
    sdk.pairingDisconnect = async () => {
      cleanupCount += 1;
      if (cleanupCount === 1) throw new Error(pairingUri);
      sdk.pairings = [];
    };
    const { client } = await clientWith(sdk);

    await expect(client.startConnection()).rejects.toMatchObject({ code: "sdk_unavailable" });
    await expect(client.startConnection()).rejects.toMatchObject({ code: "sdk_unavailable" });
    expect(connectionCount).toBe(1);
    expect(sdk.pairingDisconnects).toEqual([]);
  });

  it("releases the SDK when terminal pairing cleanup cannot be proven", async () => {
    const sdk = new FakeSdk();
    const oversizedUri = `${pairingUri}&padding=${"a".repeat(512)}`;
    sdk.startConnection = async (input) => {
      sdk.connectInputs.push(input);
      sdk.storePairing();
      return sdk.connectionAttempt(
        oversizedUri,
        pairingTopic,
        undefined,
        sdk.approvalResult.promise,
      );
    };
    sdk.pairingDisconnect = async () => undefined;
    const { client } = await clientWith(sdk);

    await expect(client.startConnection()).rejects.toMatchObject({ code: "sdk_unavailable" });
    expect(sdk.pairings).toEqual([{ topic: pairingTopic }]);
    expect(() => client.listSessions()).toThrow("WalletConnect is unavailable");
    await expect(client.close()).resolves.toBeUndefined();
    expect(sdk.sdkCloseCalls).toBe(1);
    const disconnectCallsAfterRelease = sdk.pairingDisconnects.length;

    sdk.pairings = [];
    await expect(client.close()).resolves.toBeUndefined();
    expect(sdk.sdkCloseCalls).toBe(1);
    expect(sdk.pairingDisconnects).toHaveLength(disconnectCallsAfterRelease);
  });

  it("accepts pairing cleanup when the command throws after the SDK store removes the topic", async () => {
    const sdk = new FakeSdk();
    sdk.pairingDisconnect = async () => {
      sdk.pairings = [];
      throw new Error(pairingUri);
    };
    const { client } = await clientWith(sdk);
    const attempt = await client.startConnection();

    await expect(attempt.cancel()).resolves.toEqual({ status: "cancelled" });
    expect(sdk.pairings).toEqual([]);
    expect(sdk.pairingDisconnects).toEqual([pairingTopic]);
  });

  it("does not delete a store pairing when a malformed handle lacks exact URI authority", async () => {
    const sdk = new FakeSdk();
    sdk.startConnection = async (input) => {
      sdk.connectInputs.push(input);
      sdk.storePairing();
      return {
        uri: undefined,
        pairingTopic,
        waitForApproval: () => sdk.approvalResult.promise,
        finishApproval: async () => undefined,
        cancel: async () => undefined,
      } as unknown as Awaited<ReturnType<FakeSdk["startConnection"]>>;
    };
    const { client } = await clientWith(sdk);

    await expect(client.startConnection()).rejects.toMatchObject({ code: "sdk_unavailable" });
    expect(sdk.connectInputs).toHaveLength(1);
    expect(sdk.pairingDisconnects).toEqual([]);
    expect(sdk.pairings).toEqual([{ topic: pairingTopic }]);
    expect(() => client.listSessions()).toThrow("WalletConnect is unavailable");
    await expect(client.close()).resolves.toBeUndefined();
    expect(sdk.sdkCloseCalls).toBe(1);
  });

  it("releases the SDK when terminal pairing state remains unreadable", async () => {
    const sdk = new FakeSdk();
    let topicGetterEvaluated = false;
    sdk.startConnection = async (input) => {
      sdk.connectInputs.push(input);
      const hostilePairing: Record<string, unknown> = {};
      Object.defineProperty(hostilePairing, "topic", {
        enumerable: true,
        get() {
          topicGetterEvaluated = true;
          throw new Error(pairingUri);
        },
      });
      sdk.pairings = [hostilePairing];
      return {
        uri: undefined,
        pairingTopic,
        waitForApproval: () => sdk.approvalResult.promise,
        finishApproval: async () => undefined,
        cancel: async () => undefined,
      } as unknown as Awaited<ReturnType<FakeSdk["startConnection"]>>;
    };
    const { client } = await clientWith(sdk);

    await expect(client.startConnection()).rejects.toMatchObject({ code: "sdk_unavailable" });
    expect(topicGetterEvaluated).toBe(false);
    expect(() => client.listSessions()).toThrow("WalletConnect is unavailable");
    await expect(client.close()).resolves.toBeUndefined();
    expect(sdk.sdkCloseCalls).toBe(1);
    const disconnectCallsAfterRelease = sdk.pairingDisconnects.length;

    sdk.pairings = [];
    await expect(client.close()).resolves.toBeUndefined();
    expect(sdk.sdkCloseCalls).toBe(1);
    expect(sdk.pairingDisconnects).toHaveLength(disconnectCallsAfterRelease);
  });

  it("rejects accessor-backed SDK connection data without evaluating it", async () => {
    const sdk = new FakeSdk();
    let getterEvaluated = false;
    sdk.startConnection = async () => {
      sdk.storePairing();
      const result: Record<string, unknown> = {
        pairingTopic,
        waitForApproval: () => sdk.approvalResult.promise,
        finishApproval: async () => undefined,
        cancel: async () => undefined,
      };
      Object.defineProperty(result, "uri", {
        enumerable: true,
        get() {
          getterEvaluated = true;
          throw new Error(pairingUri);
        },
      });
      return result as unknown as Awaited<ReturnType<FakeSdk["startConnection"]>>;
    };
    const { client } = await clientWith(sdk);

    await expect(client.startConnection()).rejects.toMatchObject({ code: "sdk_unavailable" });
    expect(getterEvaluated).toBe(false);
    expect(sdk.approvalCalls).toBe(0);
  });

  it("publishes cancellation only after an already-observed late approval is quarantined", async () => {
    const sdk = new FakeSdk();
    const pairingGate = deferred<void>();
    const sessionGate = deferred<void>();
    sdk.pairingDisconnect = async () => {
      await pairingGate.promise;
      sdk.pairings = [];
    };
    sdk.sessionDisconnect = async (topic) => {
      await sessionGate.promise;
      sdk.sessions = sdk.sessions.filter((value) =>
        (value as { readonly topic: string }).topic !== topic);
    };
    const { client } = await clientWith(sdk);
    const events: WalletConnectClientEvent[] = [];
    client.subscribe((event) => events.push(event));
    const attempt = await client.startConnection();
    const wait = attempt.wait();
    const cancellation = attempt.cancel();

    const approved = session();
    sdk.sessions = [approved];
    sdk.approvalResult.resolve(approved);
    expect(() => client.listSessions()).toThrow("WalletConnect is unavailable");
    expect(sdk.sessionDisconnects).toEqual([]);
    expect(events).toEqual([]);
    sdk.emit("session_update", { topic: firstSessionTopic });
    expect(events).toEqual([]);
    expect(JSON.stringify(events)).not.toContain(firstSessionTopic);
    expect(JSON.stringify(events)).not.toContain("wc:");

    let cancellationSettled = false;
    void cancellation.then(() => {
      cancellationSettled = true;
    });
    pairingGate.resolve();
    await vi.waitFor(() => expect(sdk.sessionDisconnects).toEqual([firstSessionTopic]));
    expect(cancellationSettled).toBe(false);

    sessionGate.resolve();
    await expect(cancellation).resolves.toEqual({ status: "cancelled" });
    await expect(wait).resolves.toEqual({ status: "cancelled" });
    expect(events).toEqual([]);
    expect(sdk.sessions).toEqual([]);
    expect(client.listSessions()).toEqual([]);
    expect(sdk.pairingDisconnects).toEqual([pairingTopic]);
  });

  it("does not publish cancellation before the exact approval settles and is quarantined", async () => {
    const sdk = new FakeSdk();
    sdk.startConnection = async (input) => {
      sdk.connectInputs.push(input);
      sdk.storePairing();
      return sdk.connectionAttempt(
        pairingUri,
        pairingTopic,
        undefined,
        sdk.approvalResult.promise,
        false,
      );
    };
    const { client } = await clientWith(sdk);
    const attempt = await client.startConnection();
    const wait = attempt.wait();
    const cancellation = attempt.cancel();
    let cancellationSettled = false;
    void cancellation.then(() => { cancellationSettled = true; });
    await flushMicrotasks();
    expect(cancellationSettled).toBe(false);

    const approved = session();
    sdk.sessions = [approved];
    sdk.approvalResult.resolve(approved);
    await expect(cancellation).resolves.toEqual({ status: "cancelled" });
    await expect(wait).resolves.toEqual({ status: "cancelled" });
    expect(cancellationSettled).toBe(true);
    expect(sdk.sessionDisconnects).toEqual([firstSessionTopic]);
    expect(sdk.sessions).toEqual([]);
    await expect(attempt.wait()).resolves.toEqual({ status: "cancelled" });
  });

  it("revokes only the exact concurrent approval and preserves an unrelated temporal session", async () => {
    const sdk = new FakeSdk();
    sdk.startConnection = async (input) => {
      sdk.connectInputs.push(input);
      sdk.storePairing();
      return sdk.connectionAttempt(
        pairingUri,
        pairingTopic,
        undefined,
        sdk.approvalResult.promise,
        false,
      );
    };
    const { client } = await clientWith(sdk);
    const attempt = await client.startConnection();
    const waiting = attempt.wait();
    const cancellation = attempt.cancel();

    const approved = session(firstSessionTopic);
    const unrelated = {
      ...session(secondSessionTopic),
      pairingTopic: otherPairingTopic,
    };
    sdk.sessions = [approved, unrelated];
    sdk.approvalResult.resolve(approved);

    await expect(cancellation).resolves.toEqual({ status: "cancelled" });
    await expect(waiting).resolves.toEqual({ status: "cancelled" });
    expect(sdk.sessionDisconnects).toEqual([firstSessionTopic]);
    expect(sdk.sessions).toEqual([unrelated]);
    expect(client.listSessions().map(({ topic }) => topic)).toEqual([secondSessionTopic]);
  });

  it("requires the coordinator to remove an existing session before a new SDK proposal", async () => {
    const sdk = new FakeSdk();
    sdk.sessions = [session()];
    sdk.pairings = [{ topic: pairingTopic }];
    sdk.startConnection = async (input) => {
      sdk.connectInputs.push(input);
      sdk.pairings = [{ topic: pairingTopic }, { topic: otherPairingTopic }];
      return sdk.connectionAttempt(
        otherPairingUri,
        otherPairingTopic,
        undefined,
        sdk.approvalResult.promise,
      );
    };
    const { client } = await clientWith(sdk);
    await expect(client.startConnection()).rejects.toMatchObject({ code: "sdk_unavailable" });
    expect(sdk.connectInputs).toEqual([]);
    expect(client.listSessions().map(({ topic }) => topic)).toEqual([firstSessionTopic]);
  });

  it("never exposes a cancelling generation whose session is stored before approval settles", async () => {
    const sdk = new FakeSdk();
    sdk.startConnection = async (input) => {
      sdk.connectInputs.push(input);
      sdk.storePairing();
      return sdk.connectionAttempt(
        pairingUri,
        pairingTopic,
        undefined,
        sdk.approvalResult.promise,
        false,
      );
    };
    const { client } = await clientWith(sdk);
    const attempt = await client.startConnection();
    const waiting = attempt.wait();
    const cancellation = attempt.cancel();

    const lateSession = session();
    sdk.sessions = [lateSession];
    expect(() => client.listSessions()).toThrow("WalletConnect is unavailable");
    await expect(client.startConnection()).rejects.toMatchObject({
      code: "connection_attempt_active",
    });
    expect(sdk.sessionDisconnects).toEqual([]);

    sdk.approvalResult.resolve(lateSession);
    await expect(cancellation).resolves.toEqual({ status: "cancelled" });
    await expect(waiting).resolves.toEqual({ status: "cancelled" });
    expect(sdk.sessionDisconnects).toEqual([firstSessionTopic]);
    expect(sdk.sessions).toEqual([]);
    expect(client.listSessions()).toEqual([]);
  });

  it("releases the cancelled generation for an immediate retry and natural close", async () => {
    const sdk = new FakeSdk();
    const { client } = await clientWith(sdk);
    const attempt = await client.startConnection();
    const waiting = attempt.wait();

    await expect(attempt.cancel()).resolves.toEqual({ status: "cancelled" });
    await expect(waiting).resolves.toEqual({ status: "cancelled" });
    const retry = await client.startConnection();
    await expect(retry.cancel()).resolves.toEqual({ status: "cancelled" });
    await expect(client.close()).resolves.toBeUndefined();
    expect(sdk.sdkCloseCalls).toBe(1);
  });

  it("fails closed without reopening approval when exact cancellation cannot be proven", async () => {
    const sdk = new FakeSdk();
    sdk.pairingDisconnect = async () => {
      throw new Error(`transport failed with ${pairingUri}`);
    };
    const { client } = await clientWith(sdk);
    const attempt = await client.startConnection();
    const wait = attempt.wait();

    await expect(attempt.cancel()).resolves.toEqual({ status: "failed" });
    await expect(wait).resolves.toEqual({ status: "failed" });
    await expect(client.startConnection()).rejects.toMatchObject({ code: "sdk_unavailable" });
    expect(sdk.proposals).toEqual([]);
    expect(sdk.sessionDisconnects).toEqual([]);
    expect(() => client.listSessions()).toThrow("WalletConnect is unavailable");
  });

  it("distinguishes the official user-rejection code from other safe approval failures", async () => {
    const rejectedSdk = new FakeSdk();
    const { client: rejectedClient } = await clientWith(rejectedSdk);
    const rejectedAttempt = await rejectedClient.startConnection();
    const rejected = rejectedAttempt.wait();
    rejectedSdk.approvalResult.reject({ code: 5000, message: pairingUri });
    await expect(rejected).resolves.toEqual({ status: "rejected" });

    const failedSdk = new FakeSdk();
    const { client: failedClient } = await clientWith(failedSdk);
    const failedAttempt = await failedClient.startConnection();
    const failed = failedAttempt.wait();
    failedSdk.approvalResult.reject({ code: 5100, message: pairingUri });
    const outcome = await failed;
    expect(outcome).toEqual({ status: "failed" });
    expect(JSON.stringify(outcome)).not.toContain("wc:");
  });

  it("quarantines an approved session that fails adapter normalization", async () => {
    const sdk = new FakeSdk();
    const { client } = await clientWith(sdk);
    const events: WalletConnectClientEvent[] = [];
    client.subscribe((event) => events.push(event));
    const attempt = await client.startConnection();
    const waiting = attempt.wait();
    const malformed = { ...session(), expiry: 0 };
    sdk.sessions = [malformed];

    sdk.approvalResult.resolve(malformed);

    await expect(waiting).resolves.toEqual({ status: "failed" });
    expect(sdk.sessionDisconnects).toEqual([firstSessionTopic]);
    expect(sdk.sessions).toEqual([]);
    expect(client.listSessions()).toEqual([]);
    expect(events).toEqual([]);
  });

  it("requires the approval and the stored session to share the exact attempt pairing", async () => {
    const sdk = new FakeSdk();
    const { client } = await clientWith(sdk);
    const attempt = await client.startConnection();
    const waiting = attempt.wait();
    const approved = session();
    sdk.sessions = [{ ...session(), pairingTopic: otherPairingTopic }];

    sdk.approvalResult.resolve(approved);

    await expect(waiting).resolves.toEqual({ status: "failed" });
    expect(sdk.sessionDisconnects).toEqual([firstSessionTopic]);
    expect(sdk.pairingDisconnects).toEqual([pairingTopic]);
    expect(sdk.sessions).toEqual([]);
    expect(sdk.pairings).toEqual([]);
    expect(client.listSessions()).toEqual([]);
  });

  it("uses the SDK store index to quarantine an approval whose returned topic is unreadable", async () => {
    const sdk = new FakeSdk();
    const { client } = await clientWith(sdk);
    const events: WalletConnectClientEvent[] = [];
    client.subscribe((event) => events.push(event));
    const attempt = await client.startConnection();
    const waiting = attempt.wait();
    const malformed = session();
    Object.defineProperty(malformed, "topic", {
      enumerable: true,
      get() {
        throw new Error(pairingUri);
      },
    });
    sdk.sessions = [session()];

    sdk.approvalResult.resolve(malformed);

    await expect(waiting).resolves.toEqual({ status: "failed" });
    expect(events).toEqual([]);
    expect(sdk.sessionDisconnects).toEqual([firstSessionTopic]);
    expect(sdk.sessions).toEqual([]);
    expect(client.listSessions()).toEqual([]);
  });

  it("fails rather than publishing cancelled when an observed approval cannot be quarantined", async () => {
    const sdk = new FakeSdk();
    const pairingGate = deferred<void>();
    sdk.pairingDisconnect = async () => {
      await pairingGate.promise;
      sdk.pairings = [];
    };
    sdk.sessionDisconnect = async () => {
      throw new Error(pairingUri);
    };
    const { client } = await clientWith(sdk);
    const events: WalletConnectClientEvent[] = [];
    client.subscribe((event) => events.push(event));
    const attempt = await client.startConnection();
    const wait = attempt.wait();
    const cancellation = attempt.cancel();

    const approved = session();
    sdk.sessions = [approved];
    sdk.approvalResult.resolve(approved);
    expect(() => client.listSessions()).toThrow("WalletConnect is unavailable");
    pairingGate.resolve();
    await vi.waitFor(() => expect(sdk.sessionDisconnects).toEqual([firstSessionTopic]));

    await expect(cancellation).resolves.toEqual({ status: "failed" });
    await expect(wait).resolves.toEqual({ status: "failed" });
    expect(events).toEqual([{ kind: "session_quarantined" }]);
    expect(JSON.stringify(events)).not.toContain(firstSessionTopic);
    expect(sdk.sessions).toEqual([approved]);
    const listFailure = captureFailure(() => client.listSessions());
    expect(isWalletConnectClientError(listFailure)).toBe(true);
    if (!isWalletConnectClientError(listFailure)) {
      throw new Error("Expected a typed quarantined-store failure.");
    }
    expect(listFailure.code).toBe("sdk_unavailable");
    const blockedStart = await client.startConnection().catch((error: unknown) => error);
    expect(isWalletConnectClientError(blockedStart)).toBe(true);
    if (!isWalletConnectClientError(blockedStart)) {
      throw new Error("Expected an unresolved-quarantine error.");
    }
    expect(blockedStart.code).toBe("sdk_unavailable");

    sdk.emit("session_delete", { topic: firstSessionTopic });
    expect(() => client.listSessions()).toThrow("WalletConnect is unavailable");
    const stillBlocked = await client.startConnection().catch((error: unknown) => error);
    expect(isWalletConnectClientError(stillBlocked)).toBe(true);
    if (!isWalletConnectClientError(stillBlocked)) {
      throw new Error("Expected the store-backed quarantine to remain unresolved.");
    }
    expect(stillBlocked.code).toBe("sdk_unavailable");

    sdk.sessions = [];
    sdk.emit("session_delete", { topic: firstSessionTopic });
    expect(() => client.listSessions()).toThrow("WalletConnect is unavailable");
    await expect(client.startConnection()).rejects.toMatchObject({ code: "sdk_unavailable" });
    await vi.waitFor(() => expect(sdk.sdkCloseCalls).toBe(1));
  });

  it("disconnects one exact session and trusts only the post-operation SDK store read", async () => {
    const sdk = new FakeSdk();
    sdk.sessions = [session(secondSessionTopic), session(firstSessionTopic)];
    const { client } = await clientWith(sdk);

    const remaining = await client.disconnectSession(firstSessionTopic);
    expect(sdk.sessionDisconnects).toEqual([firstSessionTopic]);
    expect(remaining.map((value) => value.topic)).toEqual([secondSessionTopic]);

    sdk.sessionDisconnect = async () => undefined;
    sdk.sessions = [session(firstSessionTopic)];
    await expect(client.disconnectSession(firstSessionTopic)).rejects.toThrow(
      "WalletConnect is unavailable",
    );
  });

  it("retries known-topic malformed-session cleanup before full session normalization", async () => {
    const sdk = new FakeSdk();
    const { client } = await clientWith(sdk);
    const malformed = { ...session(), expiry: 0 };
    sdk.sessions = [malformed];
    sdk.pairings = [{ topic: pairingTopic }];
    sdk.sessionDisconnect = async () => {
      throw new Error(pairingUri);
    };

    expect(() => client.listSessions()).toThrow("WalletConnect is unavailable");
    await expect(client.startConnection()).rejects.toMatchObject({ code: "sdk_unavailable" });
    expect(sdk.sessionDisconnects).toEqual([firstSessionTopic]);
    expect(sdk.sessions).toEqual([malformed]);

    sdk.sessionDisconnect = async (topic) => {
      sdk.sessions = sdk.sessions.filter((value) =>
        (value as { readonly topic: string }).topic !== topic);
    };
    const attempt = await client.startConnection();
    expect(sdk.sessionDisconnects).toEqual([firstSessionTopic, firstSessionTopic]);
    expect(sdk.sessions).toEqual([]);
    await expect(attempt.cancel()).resolves.toEqual({ status: "cancelled" });
  });

  it("copies lifecycle events into fixed immutable variants and invalidates malformed data", async () => {
    const sdk = new FakeSdk();
    const { client } = await clientWith(sdk);
    const events: WalletConnectClientEvent[] = [];
    const unsubscribe = client.subscribe((event) => events.push(event));

    sdk.emit("session_update", { topic: firstSessionTopic, params: { namespaces: {} } });
    sdk.emit("session_extend", { topic: firstSessionTopic });
    sdk.emit("session_delete", { topic: firstSessionTopic });
    sdk.emit("session_expire", { topic: firstSessionTopic });

    const accounts = ["0x1111111111111111111111111111111111111111"];
    sdk.emit("session_event", {
      topic: firstSessionTopic,
      params: { event: { name: "accountsChanged", data: accounts }, chainId: "eip155:4663" },
    });
    sdk.emit("session_event", {
      topic: firstSessionTopic,
      params: {
        chainId: "eip155:4663",
        event: {
          name: "accountsChanged",
          data: ["eip155:1:0x1111111111111111111111111111111111111111"],
        },
      },
    });
    accounts[0] = "mutated";
    sdk.emit("session_event", {
      topic: firstSessionTopic,
      params: { event: { name: "chainChanged", data: "0x1237" }, chainId: "eip155:4663" },
    });
    sdk.emit("session_event", {
      topic: firstSessionTopic,
      params: {
        chainId: "eip155:4663",
        event: { name: "unexpected", data: { secret: pairingUri } },
      },
    });
    sdk.emit("session_event", {
      topic: firstSessionTopic,
      params: {
        chainId: "eip155:1",
        event: { name: "chainChanged", data: "0x1" },
      },
    });

    let getterEvaluated = false;
    const hostileEvent: Record<string, unknown> = { name: "accountsChanged" };
    Object.defineProperty(hostileEvent, "data", {
      enumerable: true,
      get() {
        getterEvaluated = true;
        throw new Error(pairingUri);
      },
    });
    sdk.emit("session_event", {
      topic: firstSessionTopic,
      params: { chainId: "eip155:4663", event: hostileEvent },
    });

    expect(getterEvaluated).toBe(false);
    expect(events).toEqual([
      { kind: "session_changed", topic: firstSessionTopic },
      { kind: "session_changed", topic: firstSessionTopic },
      { kind: "session_deleted", topic: firstSessionTopic },
      { kind: "session_expired", topic: firstSessionTopic },
      {
        kind: "session_event",
        topic: firstSessionTopic,
        eventName: "accountsChanged",
        data: ["eip155:4663:0x1111111111111111111111111111111111111111"],
      },
      {
        kind: "invalid_session_event",
        topic: firstSessionTopic,
      },
      {
        kind: "session_event",
        topic: firstSessionTopic,
        eventName: "chainChanged",
        data: "0x1237",
      },
      { kind: "invalid_session_event", topic: firstSessionTopic },
      { kind: "invalid_session_event", topic: firstSessionTopic },
      { kind: "invalid_session_event", topic: firstSessionTopic },
    ]);
    expect(events.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(events[4] && "data" in events[4] ? events[4].data : undefined)).toBe(true);
    expect(JSON.stringify(events)).not.toContain("wc:");

    unsubscribe();
    sdk.emit("session_delete", { topic: secondSessionTopic });
    expect(events).toHaveLength(10);
  });

  it("rejects an unreadable startup session without evaluating its topic accessor", async () => {
    const sdk = new FakeSdk();
    let getterEvaluated = false;
    const hostile = session();
    Object.defineProperty(hostile, "topic", {
      enumerable: true,
      get() {
        getterEvaluated = true;
        throw new Error(pairingUri);
      },
    });
    sdk.sessions = [hostile];
    await expect(clientWith(sdk)).rejects.toMatchObject({ code: "sdk_unavailable" });
    expect(getterEvaluated).toBe(false);

    sdk.sessions = [];
    const { client: cleanupClient } = await clientWith(new FakeSdk());
    await cleanupClient.close();
  });

  it("detaches lifecycle listeners and closes the SDK without revoking approved sessions", async () => {
    const sdk = new FakeSdk();
    sdk.sessions = [session()];
    const { client } = await clientWith(sdk);
    client.subscribe(() => undefined);

    await client.close();
    await client.close();

    expect(sdk.onCalls).toEqual([
      "session_update",
      "session_extend",
      "session_delete",
      "session_expire",
      "session_event",
    ]);
    expect(sdk.offCalls).toEqual(sdk.onCalls);
    expect(sdk.sdkCloseCalls).toBe(1);
    expect(sdk.sessionDisconnects).toEqual([]);
    expect(sdk.sessions).toHaveLength(1);
    expect(() => client.listSessions()).toThrow("client is closed");
  });

  it("keeps close pending until proposal quarantine and SDK shutdown complete", async () => {
    const sdk = new FakeSdk();
    const pairingGate = deferred<void>();
    const sdkCloseGate = deferred<void>();
    sdk.pairingDisconnect = async () => {
      await pairingGate.promise;
      sdk.pairings = [];
    };
    sdk.close = async () => {
      sdk.sdkCloseCalls += 1;
      await sdkCloseGate.promise;
    };
    const { client } = await clientWith(sdk);
    const attempt = await client.startConnection();
    const waiting = attempt.wait();

    const firstClose = client.close();
    const secondClose = client.close();
    expect(firstClose).toBe(secondClose);
    let closeSettled = false;
    void firstClose.then(() => {
      closeSettled = true;
    });
    await flushMicrotasks();
    expect(closeSettled).toBe(false);

    expect(() => client.listSessions()).toThrow("client is closed");
    await expect(client.startConnection()).rejects.toThrow("client is closed");
    await expect(client.disconnectSession(firstSessionTopic)).rejects.toThrow("client is closed");
    expect(() => client.subscribe(() => undefined)).toThrow("client is closed");
    expect(sdk.sdkCloseCalls).toBe(0);

    const approved = session();
    sdk.sessions = [approved];
    sdk.approvalResult.resolve(approved);
    expect(closeSettled).toBe(false);

    pairingGate.resolve();
    await vi.waitFor(() => expect(sdk.sessionDisconnects).toEqual([firstSessionTopic]));
    expect(sdk.sessions).toEqual([]);
    await vi.waitFor(() => expect(sdk.sdkCloseCalls).toBe(1));
    expect(closeSettled).toBe(false);
    sdkCloseGate.resolve();
    await expect(firstClose).resolves.toBeUndefined();
    expect(closeSettled).toBe(true);
    await expect(waiting).resolves.toEqual({ status: "cancelled" });
  });

  it("keeps close pending until an in-progress SDK connection start is safely cancelled", async () => {
    const sdk = new FakeSdk();
    const connectionGate = deferred<Awaited<ReturnType<FakeSdk["startConnection"]>>>();
    sdk.startConnection = async (input) => {
      sdk.connectInputs.push(input);
      return connectionGate.promise;
    };
    const { client } = await clientWith(sdk);
    const starting = client.startConnection();
    await flushMicrotasks();

    const closing = client.close();
    let closeSettled = false;
    void closing.then(() => {
      closeSettled = true;
    });
    await flushMicrotasks();
    expect(closeSettled).toBe(false);
    expect(() => client.listSessions()).toThrow("client is closed");

    sdk.storePairing();
    connectionGate.resolve(sdk.connectionAttempt(
      pairingUri,
      pairingTopic,
      undefined,
      sdk.approvalResult.promise,
    ));
    await expect(starting).rejects.toThrow("client is closed");
    await expect(closing).resolves.toBeUndefined();
    expect(closeSettled).toBe(true);
    expect(sdk.pairingDisconnects).toEqual([pairingTopic]);
    expect(sdk.approvalCalls).toBe(1);
  });

  it("rejects close with a fixed adapter error when SDK shutdown fails synchronously", async () => {
    const sdk = new FakeSdk();
    sdk.close = (() => {
      sdk.sdkCloseCalls += 1;
      throw new Error(`secret SDK shutdown failure ${pairingUri}`);
    }) as () => Promise<void>;
    const { client } = await clientWith(sdk);

    const firstClose = client.close();
    const secondClose = client.close();
    expect(firstClose).toBe(secondClose);
    const closeFailure = await firstClose.catch((error: unknown) => error);
    expect(isWalletConnectClientError(closeFailure)).toBe(true);
    if (!isWalletConnectClientError(closeFailure)) throw new Error("Expected a typed close error.");
    expect(closeFailure.code).toBe("sdk_unavailable");
    await expect(secondClose).rejects.toMatchObject({ code: "sdk_unavailable" });
    expect(sdk.sdkCloseCalls).toBe(1);
    expect(() => client.listSessions()).toThrow("client is closed");
    const detachCallsAfterOperationalCleanup = sdk.offCalls.length;

    sdk.close = async () => {
      sdk.sdkCloseCalls += 1;
    };
    await expect(client.close()).resolves.toBeUndefined();
    expect(sdk.sdkCloseCalls).toBe(2);
    expect(sdk.offCalls).toHaveLength(detachCallsAfterOperationalCleanup);
  });

  it("treats listener detachment as terminal after releasing the SDK", async () => {
    const sdk = new FakeSdk();
    sdk.offListener = () => {
      throw new Error(`secret listener failure ${pairingUri}`);
    };
    const { client } = await clientWith(sdk);
    const events: WalletConnectClientEvent[] = [];
    client.subscribe((event) => events.push(event));

    await expect(client.close()).resolves.toBeUndefined();
    expect(sdk.sdkCloseCalls).toBe(1);
    const detachCallsAfterRelease = sdk.offCalls.length;

    sdk.emit("session_delete", { topic: firstSessionTopic });
    expect(events).toEqual([]);

    await expect(client.close()).resolves.toBeUndefined();
    expect(sdk.sdkCloseCalls).toBe(1);
    expect(sdk.offCalls).toHaveLength(detachCallsAfterRelease);
  });

  it("publishes one active close before an SDK callback can reenter cleanup", async () => {
    const sdk = new FakeSdk();
    const { client } = await clientWith(sdk);
    let reenteredClose: Promise<void> | undefined;
    sdk.offListener = () => {
      reenteredClose ??= client.close();
    };

    const closing = client.close();
    await expect(closing).resolves.toBeUndefined();
    expect(reenteredClose).toBe(closing);
    expect(sdk.sdkCloseCalls).toBe(1);
  });

  it("keeps SDK ownership until an in-flight session-store mutation settles", async () => {
    const sdk = new FakeSdk();
    sdk.sessions = [session()];
    const disconnectGate = deferred<void>();
    sdk.sessionDisconnect = async (topic) => {
      await disconnectGate.promise;
      sdk.sessions = sdk.sessions.filter((value) =>
        (value as { readonly topic?: unknown }).topic !== topic);
    };
    const { client } = await clientWith(sdk);

    const disconnecting = client.disconnectSession(firstSessionTopic);
    await vi.waitFor(() => expect(sdk.sessionDisconnects).toEqual([firstSessionTopic]));
    const closing = client.close();
    await flushMicrotasks();
    expect(sdk.sdkCloseCalls).toBe(0);

    disconnectGate.resolve();
    await expect(disconnecting).resolves.toEqual([]);
    await expect(closing).resolves.toBeUndefined();
    expect(sdk.sdkCloseCalls).toBe(1);
  });

  it("closes an active proposal through the same cancellation lifecycle", async () => {
    const sdk = new FakeSdk();
    const { client } = await clientWith(sdk);
    const attempt = await client.startConnection();
    const wait = attempt.wait();

    const closing = client.close();
    sdk.approvalResult.reject({ code: 5000, message: pairingUri });
    await closing;

    await expect(wait).resolves.toEqual({ status: "cancelled" });
    expect(sdk.pairingDisconnects).toEqual([pairingTopic]);
    expect(sdk.sessionDisconnects).toEqual([]);
    expect(sdk.sdkCloseCalls).toBe(1);
  });
});
