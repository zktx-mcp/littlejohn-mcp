import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ObservationAuthorityRegistry,
  createCanonicalClock,
  createCapabilityInvocationAuthority,
  createObservationAuthority,
  getCapabilityDefinitionSnapshot,
  parseCapabilityDataAt,
  parseUtcTimestamp,
  sourceReferenceSchema,
  walletConnectionCapability,
  type InvocationBoundaryPorts,
  type UtcTimestamp,
  type WalletConnectionData,
} from "../../src/core/index.js";
import { readRuntimeConfiguration } from "../../src/runtime/configuration.js";
import {
  createControlCredentialVerifier,
  loadOrCreateControlCredential,
} from "../../src/runtime/control-credential.js";
import { createRuntimeRouteRegistry } from "../../src/runtime/http-routing.js";
import { runtimePaths } from "../../src/runtime/paths.js";
import {
  createResourceOwnershipScope,
  type OwnedResource,
} from "../../src/runtime/resource-ownership.js";
import {
  isProcessTerminalRequiredError,
  requireProcessTermination,
  runtimeProcessTerminal,
} from "../../src/runtime/shutdown.js";
import {
  createInitialRuntimeSupportManifest,
  readRuntimeSupportManifest,
  type WalletConnectionRecord,
  type WalletOwnerApplicationContext,
  type WalletOwnerBootstrapPort,
  type WalletProjectionStore,
  type WalletSessionSource,
} from "../../src/runtime/index.js";
import { parseRuntimeRevision } from "../../src/runtime/runtime-identity.js";
import {
  createWalletOwnerApplicationFactory,
} from "../../src/wallet/application.js";
import {
  assertWalletOperationTransition,
  parseWalletManagementOperation,
  walletManagementCapabilityIdList,
  type WalletManagementOperation,
  type WalletNonterminalManagementOperation,
  type WalletOperationStore,
  type WalletOperationTransitionCommand,
} from "../../src/wallet/contracts.js";
import {
  type WalletConnectClientAcquisition,
  type WalletConnectClientConfiguration,
  type WalletConnectClientEvent,
  type WalletConnectClientPort,
  type WalletConnectConnectionAttemptPort,
  type WalletConnectStableObservation,
} from "../../src/wallet/walletconnect-client.js";
import {
  openWalletConnectStorage,
  type WalletConnectStorageOwner,
} from "../../src/wallet/walletconnect-storage.js";

const directories: string[] = [];
const observedAt = parseUtcTimestamp("2026-07-14T08:00:00.000Z");

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

const createDirectory = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(resolve(tmpdir(), prefix));
  if (process.platform !== "win32") await chmod(directory, 0o700);
  directories.push(directory);
  return directory;
};

class MemoryWalletProjection implements WalletProjectionStore {
  #record: WalletConnectionRecord = Object.freeze({
    revision: parseRuntimeRevision("0"),
    connection: parseCapabilityDataAt(
      walletConnectionCapability,
      { status: "unknown", reason: "reconciling" },
      observedAt,
    ),
    revalidationRequired: false,
    updatedAt: observedAt,
  });

  read(): WalletConnectionRecord { return this.#record; }

  replace(
    expectedRevision: string,
    connection: WalletConnectionData,
    revalidationRequired: boolean,
    updatedAt: UtcTimestamp,
  ): WalletConnectionRecord {
    if (expectedRevision !== this.#record.revision) throw new Error("Unexpected projection revision.");
    this.#record = Object.freeze({
      revision: parseRuntimeRevision(String(BigInt(this.#record.revision) + 1n)),
      connection,
      revalidationRequired,
      updatedAt,
    });
    return this.#record;
  }
}

class MemoryWalletOperationStore implements WalletOperationStore {
  readonly #values = new Map<string, WalletManagementOperation>();

  read(operationId: string): WalletManagementOperation | null {
    return this.#values.get(operationId) ?? null;
  }

  readActive(): WalletNonterminalManagementOperation | null {
    return ([...this.#values.values()].find((operation) => ![
      "completed", "cancelled", "rejected", "expired", "failed",
    ].includes(operation.state)) as WalletNonterminalManagementOperation | undefined) ?? null;
  }

  create(operation: WalletNonterminalManagementOperation): WalletNonterminalManagementOperation {
    if (this.readActive() !== null || this.#values.has(operation.operationId)) {
      throw new Error("Operation create conflict.");
    }
    const admitted = parseWalletManagementOperation(operation) as WalletNonterminalManagementOperation;
    this.#values.set(admitted.operationId, admitted);
    return admitted;
  }

  transition(command: WalletOperationTransitionCommand): WalletManagementOperation {
    const previous = this.#values.get(command.operationId);
    if (previous === undefined || [
      "completed", "cancelled", "rejected", "expired", "failed",
    ].includes(previous.state)) throw new Error("Operation transition conflict.");
    const admitted = assertWalletOperationTransition(
      previous as WalletNonterminalManagementOperation,
      command.operation,
    );
    this.#values.set(admitted.operationId, admitted);
    return admitted;
  }
}

const createBootstrap = (privateStoreDirectory: string): WalletOwnerBootstrapPort => {
  const clock = createCanonicalClock(() => observedAt);
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
  const invocationAuthority = createCapabilityInvocationAuthority(
    clock,
    runtimeConfiguration.chain.chainId,
  );
  return Object.freeze({
    configuration: runtimeConfiguration.wallet,
    privateStoreDirectory: Object.freeze({ ensureDirectory: async () => privateStoreDirectory }),
    projection: new MemoryWalletProjection(),
    operations: new MemoryWalletOperationStore(),
    sourceAuthority: Object.freeze({
      sdkStoreSourceId: `wallet-sdk:${"A".repeat(22)}`,
      sdkStoreAuthority,
      createSessionSource(topic: string): WalletSessionSource {
        const topicDigest = createHash("sha256").update(topic, "utf8").digest("base64url");
        const sourceId = `wallet-session:${topicDigest}`;
        return Object.freeze({
          sourceId,
          candidateId: sourceId,
          topicDigest,
          observationAuthority: createObservationAuthority({
            clock,
            sourceClass: "wallet_session",
            owner: "WalletConnect session",
            reference: sourceReferenceSchema.parse({ kind: "wallet_session", sourceId, topicDigest }),
          }),
        });
      },
    }),
    capabilityAuthority: Object.freeze({
      clock,
      invocationAuthority,
      createInvocationPorts(session?: WalletSessionSource): InvocationBoundaryPorts {
        return Object.freeze({
          observations: new ObservationAuthorityRegistry(
            clock,
            session === undefined
              ? [sdkStoreAuthority]
              : [sdkStoreAuthority, session.observationAuthority],
          ),
        });
      },
    }),
  });
};

const createContext = async () => {
  const privateStoreDirectory = await createDirectory("littlejohn-wallet-store-");
  const runtimeDirectory = await createDirectory("littlejohn-wallet-runtime-");
  const paths = runtimePaths(runtimeDirectory);
  const authority = await loadOrCreateControlCredential(runtimeDirectory, paths.controlCredential);
  const routes = createRuntimeRouteRegistry({
    controlVerifier: createControlCredentialVerifier(authority),
  });
  const startupScope = createResourceOwnershipScope();
  const configuration = readRuntimeConfiguration({});
  const context: WalletOwnerApplicationContext = Object.freeze({
    routes,
    signal: new AbortController().signal,
    startupResources: startupScope.resources,
    supportManifest: createInitialRuntimeSupportManifest(configuration.chain),
    wallet: createBootstrap(privateStoreDirectory),
  });
  return Object.freeze({ context, privateStoreDirectory, startupScope });
};

class FakeWalletConnectClient implements WalletConnectClientPort {
  async startRequest(): Promise<never> { throw new Error("This management fixture does not submit transactions."); }
  hasPendingRequest(): boolean { return false; }

  readonly steps: string[];
  readonly storageOwner: WalletConnectStorageOwner;
  activationFailure: Error | undefined;
  #listener: ((event: WalletConnectClientEvent) => void) | undefined;

  constructor(storageOwner: WalletConnectStorageOwner, steps: string[]) {
    this.storageOwner = storageOwner;
    this.steps = steps;
  }

  observe(): WalletConnectStableObservation {
    this.steps.push("observe");
    return Object.freeze({
      proposalCount: 0,
      sessions: Object.freeze([]),
      revision: this.storageOwner.checkpoint(),
    });
  }

  async startConnection(): Promise<WalletConnectConnectionAttemptPort> {
    throw new Error("Connection is outside this composition test.");
  }

  async containPendingConnectionState(): Promise<void> { this.steps.push("contain-pending"); }
  async disconnectSession(): Promise<void> { throw new Error("Disconnect is outside this composition test."); }

  activate(listener: (event: WalletConnectClientEvent) => void) {
    this.steps.push("activate");
    if (this.activationFailure !== undefined) throw this.activationFailure;
    this.#listener = listener;
    let active = true;
    return Object.freeze({
      initialObservation: Object.freeze({
        status: "available" as const,
        observation: this.observe(),
      }),
      releaseEvents: () => undefined,
      unsubscribe: () => {
        if (!active) return;
        active = false;
        if (this.#listener === listener) {
          this.#listener = undefined;
          this.steps.push("unsubscribe");
        }
      },
    });
  }

  async contain(): Promise<void> { this.steps.push("contain"); }
}

type ClientFactory = Parameters<typeof createWalletOwnerApplicationFactory>[0];

interface FakeFactorySubject {
  factory: ClientFactory;
  readonly configurations: WalletConnectClientConfiguration[];
  readonly signals: AbortSignal[];
  readonly steps: string[];
  cleanupCount: number;
}

const createFakeFactory = (): FakeFactorySubject => {
  const subject: FakeFactorySubject = {
    configurations: [],
    signals: [],
    steps: [],
    cleanupCount: 0,
    factory: undefined as unknown as ClientFactory,
  };
  subject.factory = async (configuration, storageRegistration, signal) => {
    subject.configurations.push(configuration);
    subject.signals.push(signal);
    const client = new FakeWalletConnectClient(configuration.storageOwner, subject.steps);
    const acquisitionOwner: OwnedResource = Object.freeze({
      async close(): Promise<void> {
        subject.cleanupCount += 1;
        await client.contain();
        throw requireProcessTermination();
      },
    });
    storageRegistration.replace(configuration.storageOwner, acquisitionOwner);
    let ownedResource: OwnedResource = acquisitionOwner;
    const acquisition: WalletConnectClientAcquisition = Object.freeze({
      client,
      replace(resource: OwnedResource): void {
        storageRegistration.replace(ownedResource, resource);
        ownedResource = resource;
      },
      transfer(): void { storageRegistration.transfer(); },
    });
    return acquisition;
  };
  return subject;
};

const availability = Object.freeze({
  overall: "internal",
  direct: "internal",
  http: "internal",
  mcp: "unavailable",
  cli: "unavailable",
});

describe("wallet owner application composition", () => {
  it("hands one WalletConnect acquisition to the final coordinator and operation owner", async () => {
    const subject = createFakeFactory();
    const { context, startupScope } = await createContext();
    const application = await createWalletOwnerApplicationFactory(subject.factory)(context);

    expect(subject.configurations).toHaveLength(1);
    expect(Object.keys(subject.configurations[0] ?? {}).sort()).toEqual([
      "createSessionSource", "storageOwner", "wallet",
    ]);
    expect(subject.signals).toEqual([context.signal]);
    expect(application.routes).toBe(context.routes);
    expect(startupScope.empty).toBe(true);

    const review = await application.walletOperations.review({ kind: "connect" });
    expect(review).toMatchObject({ status: "review", review: { kind: "connect" } });

    const parent = readRuntimeSupportManifest(context.supportManifest);
    const manifest = readRuntimeSupportManifest(application.supportManifest);
    const walletConnectionCapabilityId =
      getCapabilityDefinitionSnapshot(walletConnectionCapability).capabilityId;
    for (const capabilityId of [...walletManagementCapabilityIdList, walletConnectionCapabilityId]) {
      expect(manifest.capabilities.find((entry) => entry.capabilityId === capabilityId)?.availability)
        .toEqual(availability);
    }
    expect(manifest.capabilities.length)
      .toBe(parent.capabilities.length + walletManagementCapabilityIdList.length);

    await expect(application.shutdown()).resolves.toBe(runtimeProcessTerminal);
    await expect(application.close()).rejects.toMatchObject({ name: "ProcessTerminalRequiredError" });
    expect(subject.steps.filter((step) => step === "contain")).toHaveLength(1);
    expect(subject.cleanupCount).toBe(0);
  });

  it("closes storage when client acquisition fails before adoption", async () => {
    const creationFailure = new Error("client creation failed");
    const { context, privateStoreDirectory, startupScope } = await createContext();
    const factory: ClientFactory = async () => { throw creationFailure; };

    await expect(createWalletOwnerApplicationFactory(factory)(context)).rejects.toBe(creationFailure);
    const reopened = await openWalletConnectStorage(privateStoreDirectory);
    reopened.close();
    expect(startupScope.size).toBe(1);
    await startupScope.close();
    expect(startupScope.empty).toBe(true);
  });

  it("retains process-terminal ownership when coordinator activation fails", async () => {
    const subject = createFakeFactory();
    const constructionFailure = new Error("subscription failed");
    const { context, startupScope } = await createContext();
    const baseFactory = subject.factory;
    const failingFactory: ClientFactory = async (configuration, registration, signal) => {
      const acquisition = await baseFactory(configuration, registration, signal);
      (acquisition.client as FakeWalletConnectClient).activationFailure = constructionFailure;
      return acquisition;
    };

    const failure = await Promise.resolve(
      createWalletOwnerApplicationFactory(failingFactory)(context),
    ).then(() => undefined, (error: unknown) => error);
    expect(isProcessTerminalRequiredError(failure)).toBe(true);
    if (!isProcessTerminalRequiredError(failure)) throw failure;
    expect(failure.primaryFailure).toBe(constructionFailure);
    expect(subject.cleanupCount).toBe(1);
    expect(subject.steps).toContain("contain");
    expect(startupScope.empty).toBe(false);
  });
});
