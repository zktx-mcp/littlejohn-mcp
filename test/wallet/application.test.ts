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
import {
  createWalletOwnerApplicationFactory,
} from "../../src/wallet/application.js";
import { readRuntimeConfiguration } from "../../src/runtime/configuration.js";
import {
  createControlCredentialVerifier,
  loadOrCreateControlCredential,
} from "../../src/runtime/control-credential.js";
import { createRuntimeRouteRegistry } from "../../src/runtime/http-routing.js";
import { runtimePaths } from "../../src/runtime/paths.js";
import {
  isProcessTerminalRequiredError,
  requireProcessTermination,
  runtimeProcessTerminal,
} from "../../src/runtime/shutdown.js";
import { parseRuntimeRevision } from "../../src/runtime/runtime-identity.js";
import {
  createResourceOwnershipScope,
  type OwnedResource,
} from "../../src/runtime/resource-ownership.js";
import {
  createInitialRuntimeSupportManifest,
  readRuntimeSupportManifest,
  type WalletConnectionRecord,
  type WalletOwnerApplicationContext,
  type WalletOwnerBootstrapPort,
  type WalletProjectionStore,
  type WalletSessionSource,
} from "../../src/runtime/index.js";
import { walletManagementCapabilityIdList } from "../../src/wallet/contracts.js";
import { walletControlResources } from "../../src/wallet/routes.js";
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
    if (expectedRevision !== this.#record.revision) {
      throw new Error("Unexpected projection revision.");
    }
    this.#record = Object.freeze({
      revision: parseRuntimeRevision(String(BigInt(this.#record.revision) + 1n)),
      connection,
      revalidationRequired,
      updatedAt,
    });
    return this.#record;
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

  async disconnectSession(): Promise<void> {
    throw new Error("Disconnect is outside this composition test.");
  }

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
  readonly clients: FakeWalletConnectClient[];
  cleanupCount: number;
}

const createFakeFactory = (): FakeFactorySubject => {
  const subject: FakeFactorySubject = {
    configurations: [],
    signals: [],
    steps: [],
    clients: [],
    cleanupCount: 0,
    factory: undefined as unknown as ClientFactory,
  };
  const factory: ClientFactory = async (configuration, storageRegistration, signal) => {
    subject.configurations.push(configuration);
    subject.signals.push(signal);
    const client = new FakeWalletConnectClient(configuration.storageOwner, subject.steps);
    subject.clients.push(client);
    const acquisitionOwner: OwnedResource = Object.freeze({
      async close(): Promise<void> {
        subject.cleanupCount += 1;
        subject.steps.push("close-acquisition");
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
  subject.factory = factory;
  return subject;
};

const availability = Object.freeze({
  overall: "internal",
  direct: "internal",
  http: "internal",
  mcp: "unavailable",
  cli: "unavailable",
  web: "unavailable",
});

describe("wallet owner application composition", () => {
  it("hands one registered store through the adapter, coordinator, routes, and application", async () => {
    const subject = createFakeFactory();
    const { context, startupScope } = await createContext();
    const application = await createWalletOwnerApplicationFactory(subject.factory)(context);

    expect(subject.configurations).toHaveLength(1);
    expect(Object.keys(subject.configurations[0] ?? {}).sort()).toEqual([
      "createSessionSource", "storageOwner", "wallet",
    ]);
    expect(Object.isFrozen(subject.configurations[0])).toBe(true);
    expect(subject.signals).toEqual([context.signal]);
    expect(startupScope.empty).toBe(true);

    const paths = [
      ["POST", walletControlResources.operations.path],
      ["GET", walletControlResources.operation.path(Buffer.alloc(32, 1).toString("base64url"))],
      ["GET", walletControlResources.presentation.path(Buffer.alloc(32, 1).toString("base64url"))],
      ["POST", walletControlResources.confirmation.path(Buffer.alloc(32, 1).toString("base64url"))],
      ["POST", walletControlResources.cancellation.path(Buffer.alloc(32, 1).toString("base64url"))],
      ["GET", walletControlResources.connection.path],
    ] as const;
    for (const [method, path] of paths) {
      expect(application.routes.match(method, path).status).toBe("matched");
    }

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
    await expect(application.close()).rejects.toMatchObject({
      name: "ProcessTerminalRequiredError",
    });
    expect(subject.steps.filter((step) => step === "contain")).toHaveLength(1);
    expect(subject.steps).not.toContain("close-storage");
    expect(subject.cleanupCount).toBe(0);
  });

  it("owns and closes storage when the client factory rejects before adoption", async () => {
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

  it("closes the adapter acquisition owner when coordinator construction fails", async () => {
    const subject = createFakeFactory();
    const constructionFailure = new Error("subscription failed");
    const { context, privateStoreDirectory, startupScope } = await createContext();
    const baseFactory = subject.factory;
    const failingFactory: ClientFactory = async (configuration, registration, signal) => {
      const acquisition = await baseFactory(configuration, registration, signal);
      const client = acquisition.client as FakeWalletConnectClient;
      client.activationFailure = constructionFailure;
      return acquisition;
    };

    const failure = await Promise.resolve(createWalletOwnerApplicationFactory(failingFactory)(context)).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(isProcessTerminalRequiredError(failure)).toBe(true);
    if (!isProcessTerminalRequiredError(failure)) throw failure;
    expect(failure.primaryFailure).toBe(constructionFailure);
    expect(subject.cleanupCount).toBe(1);
    expect(subject.steps).toContain("contain");
    expect(startupScope.empty).toBe(false);
  });

  it("retains failed creation ownership after SDK acquisition becomes process-terminal", async () => {
    const subject = createFakeFactory();
    const constructionFailure = new Error("subscription failed");
    const { context, startupScope } = await createContext();
    const baseFactory = subject.factory;
    const failingFactory: ClientFactory = async (configuration, registration, signal) => {
      const acquisition = await baseFactory(configuration, registration, signal);
      const client = acquisition.client as FakeWalletConnectClient;
      client.activationFailure = constructionFailure;
      return acquisition;
    };

    const failure = await Promise.resolve(createWalletOwnerApplicationFactory(failingFactory)(context)).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(isProcessTerminalRequiredError(failure)).toBe(true);
    if (!isProcessTerminalRequiredError(failure)) throw failure;
    expect(failure.primaryFailure).toBe(constructionFailure);
    expect(subject.cleanupCount).toBe(1);
    expect(startupScope.empty).toBe(false);
    await expect(startupScope.close()).rejects.toMatchObject({
      name: "ProcessTerminalRequiredError",
    });
    expect(subject.cleanupCount).toBe(2);
    expect(startupScope.empty).toBe(false);
  });

  it("retains the acquisition owner when route assembly fails after coordinator construction", async () => {
    const subject = createFakeFactory();
    const { context, startupScope } = await createContext();
    const conflictingRoutes = context.routes.extend([{
      method: walletControlResources.operations.method,
      mutation: "declared_control",
      query: "none",
      pathPattern: walletControlResources.operations.pathPattern,
      response: "canonical_json",
      successStatus: 200,
      handler: async () => ({ ok: true, body: {} }),
    }]);
    const conflictingContext: WalletOwnerApplicationContext = Object.freeze({
      ...context,
      routes: conflictingRoutes,
    });

    const failure = await Promise.resolve(
      createWalletOwnerApplicationFactory(subject.factory)(conflictingContext),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(isProcessTerminalRequiredError(failure)).toBe(true);
    if (!isProcessTerminalRequiredError(failure)) throw failure;
    expect(failure.primaryFailure).toMatchObject({
      name: "TypeError",
      message: "Route patterns intersect ambiguously.",
    });
    expect(subject.steps).toContain("activate");
    expect(subject.steps).toContain("observe");
    expect(subject.cleanupCount).toBe(1);
    expect(subject.steps).toContain("contain");
    expect(startupScope.empty).toBe(false);
  });

  it("keeps process-terminal shutdown sticky without reviving graceful-close stages", async () => {
    const subject = createFakeFactory();
    const { context } = await createContext();
    const application = await createWalletOwnerApplicationFactory(subject.factory)(context);
    await expect(application.shutdown()).resolves.toBe(runtimeProcessTerminal);
    await expect(application.shutdown()).resolves.toBe(runtimeProcessTerminal);
    await expect(application.close()).rejects.toMatchObject({ name: "ProcessTerminalRequiredError" });

    expect(subject.steps.filter((step) => step === "unsubscribe")).toHaveLength(1);
    expect(subject.steps.filter((step) => step === "contain")).toHaveLength(1);
    expect(subject.steps).not.toContain("seal-storage");
    expect(subject.steps).not.toContain("close-storage");
  });
});
