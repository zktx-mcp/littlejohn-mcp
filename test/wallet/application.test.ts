import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { createRuntimeRouteRegistry, type RuntimeRouteRegistry } from "../../src/runtime/http-routing.js";
import { runtimePaths } from "../../src/runtime/paths.js";
import { parseRuntimeRevision } from "../../src/runtime/runtime-identity.js";
import { createResourceOwnershipScope } from "../../src/runtime/resource-ownership.js";
import {
  createInitialRuntimeSupportManifest,
  readRuntimeSupportManifest,
  type WalletConnectionRecord,
  type WalletOwnerApplicationContext,
  type WalletOwnerBootstrapPort,
  type WalletProjectionStore,
  type WalletSessionSource,
} from "../../src/runtime/index.js";
import {
  createWalletOwnerApplicationFactory,
} from "../../src/wallet/application.js";
import {
  walletManagementCapabilityIdList,
} from "../../src/wallet/contracts.js";
import { walletControlRoutes } from "../../src/wallet/routes.js";
import type {
  WalletConnectClientAcquisition,
  WalletConnectAcquisitionRegistry,
  WalletConnectAcquisitionResource,
  WalletConnectClientEvent,
  WalletConnectClientPort,
  WalletConnectConnectionAttemptPort,
  WalletConnectSessionSnapshot,
} from "../../src/wallet/walletconnect-client.js";

const directories: string[] = [];
const observedAt = parseUtcTimestamp("2026-07-14T08:00:00.000Z");

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

class MemoryWalletProjection implements WalletProjectionStore {
  #record: WalletConnectionRecord = Object.freeze({
    revision: parseRuntimeRevision("0"),
    connection: parseCapabilityDataAt(
      walletConnectionCapability,
      { status: "unknown", reason: "reconciling" },
      observedAt,
    ),
    updatedAt: observedAt,
  });

  read(): WalletConnectionRecord { return this.#record; }

  replace(
    expectedRevision: string,
    connection: WalletConnectionData,
    updatedAt: UtcTimestamp,
  ): WalletConnectionRecord {
    if (expectedRevision !== this.#record.revision) throw new Error("Unexpected projection revision.");
    this.#record = Object.freeze({
      revision: parseRuntimeRevision(String(BigInt(this.#record.revision) + 1n)),
      connection,
      updatedAt,
    });
    return this.#record;
  }
}

class FakeWalletConnectClient implements WalletConnectClientPort {
  readonly sessions: WalletConnectSessionSnapshot[] = [];
  closeCount = 0;
  subscribeCount = 0;
  unsubscribeCount = 0;
  subscribeError: Error | undefined;
  readonly closeErrors: Error[] = [];
  #listener: ((event: WalletConnectClientEvent) => void) | undefined;

  listSessions(): readonly WalletConnectSessionSnapshot[] {
    return Object.freeze([...this.sessions]);
  }

  async startConnection(): Promise<WalletConnectConnectionAttemptPort> {
    throw new Error("Connection is not exercised by this application wiring test.");
  }

  async disconnectSession(topic: string): Promise<readonly WalletConnectSessionSnapshot[]> {
    this.sessions.splice(0, this.sessions.length, ...this.sessions.filter((session) => session.topic !== topic));
    return Object.freeze([...this.sessions]);
  }

  subscribe(listener: (event: WalletConnectClientEvent) => void): () => void {
    this.subscribeCount += 1;
    if (this.subscribeError !== undefined) throw this.subscribeError;
    if (this.#listener !== undefined) throw new Error("A listener is already registered.");
    this.#listener = listener;
    return () => {
      if (this.#listener === listener) {
        this.#listener = undefined;
        this.unsubscribeCount += 1;
      }
    };
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    const failure = this.closeErrors.shift();
    if (failure !== undefined) throw failure;
    this.#listener = undefined;
  }
}

const createBootstrap = (privateStoreDirectory: string): WalletOwnerBootstrapPort => {
  const clock = createCanonicalClock(() => observedAt);
  const configuration = readRuntimeConfiguration({}).wallet;
  const sdkStoreAuthority = createObservationAuthority({
    clock,
    sourceClass: "wallet_sdk",
    owner: "WalletConnect SDK",
    reference: sourceReferenceSchema.parse({
      kind: "wallet_sdk",
      sourceId: `wallet-sdk:${"A".repeat(22)}`,
    }),
  });
  const invocationAuthority = createCapabilityInvocationAuthority(clock, configuration.chain.chainId);
  return Object.freeze({
    configuration,
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

const createRoutes = async (): Promise<RuntimeRouteRegistry> => {
  const directory = await mkdtemp(resolve(tmpdir(), "littlejohn-wallet-application-"));
  directories.push(directory);
  const paths = runtimePaths(directory);
  const authority = await loadOrCreateControlCredential(directory, paths.controlCredential);
  return createRuntimeRouteRegistry({ controlVerifier: createControlCredentialVerifier(authority) });
};

const createContextWithScope = async (
  privateStoreDirectory: string,
  routes?: RuntimeRouteRegistry,
) => {
  await mkdir(privateStoreDirectory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(privateStoreDirectory, 0o700);
  directories.push(privateStoreDirectory);
  const startupScope = createResourceOwnershipScope();
  const configuration = readRuntimeConfiguration({});
  const context: WalletOwnerApplicationContext = Object.freeze({
    routes: routes ?? await createRoutes(),
    signal: new AbortController().signal,
    startupResources: startupScope.resources,
    supportManifest: createInitialRuntimeSupportManifest(configuration.chain),
    wallet: createBootstrap(privateStoreDirectory),
  });
  return Object.freeze({ context, startupScope });
};

const createContext = async (
  privateStoreDirectory: string,
  routes?: RuntimeRouteRegistry,
): Promise<WalletOwnerApplicationContext> =>
  (await createContextWithScope(privateStoreDirectory, routes)).context;

const acquireFakeClient = (
  client: WalletConnectClientPort,
  configurations: unknown[] = [],
  signals: AbortSignal[] = [],
) => async (
  configuration: unknown,
  acquisitionResources: WalletConnectAcquisitionRegistry,
  signal: AbortSignal,
): Promise<WalletConnectClientAcquisition> => {
  configurations.push(configuration);
  signals.push(signal);
  const registration = acquisitionResources.register(client);
  let ownedResource: WalletConnectAcquisitionResource = client;
  return Object.freeze({
    client,
    replace(resource: WalletConnectAcquisitionResource): void {
      registration.replace(ownedResource, resource);
      ownedResource = resource;
    },
    transfer: () => registration.transfer(),
  });
};

const availability = Object.freeze({
  overall: "internal",
  direct: "internal",
  http: "internal",
  mcp: "unavailable",
  cli: "unavailable",
  web: "unavailable",
});
const walletConnectionCapabilityId =
  getCapabilityDefinitionSnapshot(walletConnectionCapability).capabilityId;

describe("wallet owner application composition", () => {
  it("wires one prepared private store, client, coordinator, routes, manifest, and typed handoffs", async () => {
    const privateStoreDirectory = resolve(tmpdir(), "littlejohn-wallet-sdk-store");
    const client = new FakeWalletConnectClient();
    const configurations: unknown[] = [];
    const signals: AbortSignal[] = [];
    const createApplication = createWalletOwnerApplicationFactory(
      acquireFakeClient(client, configurations, signals),
    );
    const { context, startupScope } = await createContextWithScope(privateStoreDirectory);
    const application = await createApplication(context);

    expect(configurations).toEqual([{
      wallet: readRuntimeConfiguration({}).wallet,
      privateStoreDirectory,
    }]);
    expect(Object.isFrozen(configurations[0])).toBe(true);
    expect(signals).toEqual([context.signal]);
    expect(client.subscribeCount).toBe(1);
    expect(Object.keys(application).sort()).toEqual([
      "activeWallet",
      "close",
      "routes",
      "supportManifest",
      "walletConnection",
      "walletOperations",
    ]);
    expect(application).not.toHaveProperty("client");
    expect(Object.keys(application.walletOperations).sort()).toEqual([
      "confirmation",
      "currentProjection",
      "operation",
      "presentation",
    ]);

    const parent = readRuntimeSupportManifest(context.supportManifest);
    const manifest = readRuntimeSupportManifest(application.supportManifest);
    expect(manifest.capabilities
      .filter((entry) => !parent.capabilities.some((parentEntry) =>
        parentEntry.capabilityId === entry.capabilityId))
      .map((entry) => entry.capabilityId)).toEqual(walletManagementCapabilityIdList);
    expect(manifest.capabilities)
      .toHaveLength(parent.capabilities.length + walletManagementCapabilityIdList.length);
    for (const parentEntry of parent.capabilities) {
      if (parentEntry.capabilityId === walletConnectionCapabilityId) continue;
      expect(manifest.capabilities.find((entry) => entry.capabilityId === parentEntry.capabilityId))
        .toEqual(parentEntry);
    }
    for (const capabilityId of [...walletManagementCapabilityIdList, walletConnectionCapabilityId]) {
      expect(manifest.capabilities.find((entry) => entry.capabilityId === capabilityId)?.availability)
        .toEqual(availability);
    }

    const current = await application.walletOperations.currentProjection.get();
    const started = await application.walletOperations.operation.start({
      kind: "disconnect",
      connectionRevision: current.connectionRevision,
    }, "A".repeat(43));
    expect(started.status).toBe("operation_started");
    if (started.status !== "operation_started") throw new Error("Expected a disconnection operation.");
    const operation = started.operation;
    expect(operation).toMatchObject({
      state: "completed",
      result: { outcome: "already_disconnected", connection: { status: "disconnected" } },
    });
    expect(await application.walletOperations.presentation.get(operation.operationId)).toEqual({
      operation,
      access: "interactive",
    });
    const paths = [
      ["POST", walletControlRoutes.operations],
      ["GET", walletControlRoutes.operation(operation.operationId)],
      ["POST", walletControlRoutes.confirmation(operation.operationId)],
      ["DELETE", walletControlRoutes.operation(operation.operationId)],
      ["GET", walletControlRoutes.connection],
    ] as const;
    for (const [method, path] of paths) {
      expect(application.routes.match(method, path).status).toBe("matched");
    }

    expect(application.activeWallet.capture()).toEqual({
      connection: { status: "disconnected", reason: "no_session" },
      connectionRevision: operation.connectionRevision,
    });
    expect(startupScope.empty).toBe(true);
    await startupScope.close();
    expect(client.closeCount).toBe(0);
    const closing = application.close();
    expect(application.close()).toBe(closing);
    await closing;
    await application.close();
    expect(client.unsubscribeCount).toBe(1);
    expect(client.closeCount).toBe(1);
  });

  it("closes the client when coordinator construction fails", async () => {
    const client = new FakeWalletConnectClient();
    const constructionFailure = new Error("coordinator subscription failed");
    client.subscribeError = constructionFailure;
    const factory = createWalletOwnerApplicationFactory(acquireFakeClient(client));
    const context = await createContext(
      resolve(tmpdir(), "littlejohn-wallet-failed-client"),
    );

    await expect(factory(context))
      .rejects.toBe(constructionFailure);
    expect(client.closeCount).toBe(1);
    expect(client.unsubscribeCount).toBe(0);
  });

  it("retains failed construction cleanup in the HTTP owner startup scope", async () => {
    const client = new FakeWalletConnectClient();
    const constructionFailure = new Error("coordinator subscription failed");
    const cleanupFailure = new Error("client close failed");
    client.subscribeError = constructionFailure;
    client.closeErrors.push(cleanupFailure);
    const factory = createWalletOwnerApplicationFactory(acquireFakeClient(client));
    const { context, startupScope } = await createContextWithScope(
      resolve(tmpdir(), "littlejohn-wallet-retained-client"),
    );

    await expect(factory(context)).rejects.toBe(constructionFailure);
    expect(client.closeCount).toBe(1);
    expect(startupScope.empty).toBe(false);
    await startupScope.close();
    expect(client.closeCount).toBe(2);
    expect(startupScope.empty).toBe(true);
  });

  it("keeps an overlapping owner during the final application handoff", async () => {
    const client = new FakeWalletConnectClient();
    const transferFailure = new Error("startup transfer failed");
    const baseContext = await createContext(resolve(tmpdir(), "littlejohn-wallet-overlap"));
    let retained: WalletConnectAcquisitionResource | undefined;
    const context: WalletOwnerApplicationContext = Object.freeze({
      ...baseContext,
      startupResources: Object.freeze({
        register(resource: WalletConnectAcquisitionResource) {
          retained = resource;
          return Object.freeze({
            replace(
              _expected: WalletConnectAcquisitionResource,
              replacement: WalletConnectAcquisitionResource,
            ): void { retained = replacement; },
            transfer(): void { throw transferFailure; },
          });
        },
      }),
    });
    const factory = createWalletOwnerApplicationFactory(acquireFakeClient(client));

    await expect(factory(context)).rejects.toBe(transferFailure);
    expect(retained).toBeDefined();
    await retained?.close();
    expect(client.closeCount).toBe(1);
  });

  it("retains one idempotent application owner when the inner handoff is interrupted", async () => {
    const client = new FakeWalletConnectClient();
    const transferFailure = new Error("acquisition transfer failed");
    const baseFactory = acquireFakeClient(client);
    const createClient = async (...arguments_: Parameters<typeof baseFactory>) => {
      const acquisition = await baseFactory(...arguments_);
      return Object.freeze({
        client: acquisition.client,
        replace: (resource: WalletConnectAcquisitionResource) => acquisition.replace(resource),
        transfer(): void { throw transferFailure; },
      });
    };
    const { context, startupScope } = await createContextWithScope(
      resolve(tmpdir(), "littlejohn-wallet-inner-overlap"),
    );
    const factory = createWalletOwnerApplicationFactory(createClient);

    await expect(factory(context)).rejects.toBe(transferFailure);
    expect(client.closeCount).toBe(1);
    expect(startupScope.empty).toBe(false);
    await startupScope.close();
    expect(client.closeCount).toBe(1);
    expect(startupScope.empty).toBe(true);
  });

  it("closes an adopted coordinator when acquisition freshness fails after ownership transfer", async () => {
    const client = new FakeWalletConnectClient();
    const freshnessFailure = new Error("acquisition became stale");
    const baseFactory = acquireFakeClient(client);
    const createClient = async (...arguments_: Parameters<typeof baseFactory>) => {
      const acquisition = await baseFactory(...arguments_);
      return Object.freeze({
        client: acquisition.client,
        replace(resource: WalletConnectAcquisitionResource): void {
          acquisition.replace(resource);
          throw freshnessFailure;
        },
        transfer: () => acquisition.transfer(),
      });
    };
    const { context, startupScope } = await createContextWithScope(
      resolve(tmpdir(), "littlejohn-wallet-stale-adoption"),
    );

    await expect(createWalletOwnerApplicationFactory(createClient)(context))
      .rejects.toBe(freshnessFailure);
    expect(client.closeCount).toBe(1);
    expect(startupScope.empty).toBe(false);
    await startupScope.close();
    expect(client.closeCount).toBe(1);
    expect(startupScope.empty).toBe(true);
  });

  it.runIf(process.platform !== "win32")(
    "retries coordinator and store shutdown without repeating a proven coordinator close",
    async () => {
    const privateStoreDirectory = resolve(tmpdir(), "littlejohn-wallet-close-retry");
    const client = new FakeWalletConnectClient();
    const coordinatorFailure = new Error("coordinator close failed");
    client.closeErrors.push(coordinatorFailure);
    const factory = createWalletOwnerApplicationFactory(acquireFakeClient(client));
    const application = await factory(await createContext(privateStoreDirectory));
    const state = resolve(privateStoreDirectory, "state");
    await writeFile(state, "opaque-walletconnect-state", { mode: 0o600 });
    await chmod(state, 0o644);

    await expect(application.close()).rejects.toMatchObject({
      failure: { error: { code: "runtime_state_unavailable" } },
    });
    expect(client.closeCount).toBe(1);
    await expect(application.close()).rejects.toThrow("WalletConnect private storage is invalid.");
    expect(client.closeCount).toBe(2);

    await chmod(state, 0o600);
    await application.close();
    await application.close();
      expect(client.closeCount).toBe(2);
    },
  );

  it("closes the initialized coordinator when a later registry extension fails", async () => {
    const client = new FakeWalletConnectClient();
    const routes = (await createRoutes()).extend([{
      method: "POST",
      mutation: "declared_control",
      pathPattern: walletControlRoutes.operations,
      response: "canonical_json",
      successStatus: 201,
      handler: async () => ({ ok: true, body: {} }),
    }]);
    const factory = createWalletOwnerApplicationFactory(acquireFakeClient(client));
    const context = await createContext(
      resolve(tmpdir(), "littlejohn-wallet-failed-registry"),
      routes,
    );

    await expect(factory(context)).rejects.toThrow();
    expect(client.subscribeCount).toBe(1);
    expect(client.unsubscribeCount).toBe(1);
    expect(client.closeCount).toBe(1);
  });

  it.runIf(process.platform !== "win32")(
    "rejects SDK storage that becomes permissive during initialization or before shutdown",
    async () => {
      for (const phase of ["initialization", "shutdown"] as const) {
        const privateStoreDirectory = resolve(
          tmpdir(),
          `littlejohn-wallet-permissive-${phase}`,
        );
        const client = new FakeWalletConnectClient();
        const baseFactory = acquireFakeClient(client);
        const createClient = async (...arguments_: Parameters<typeof baseFactory>) => {
          const acquisition = await baseFactory(...arguments_);
          if (phase === "initialization") {
            const state = resolve(privateStoreDirectory, "state");
            await writeFile(state, "opaque-walletconnect-state", { mode: 0o600 });
            await chmod(state, 0o644);
          }
          return acquisition;
        };
        const factory = createWalletOwnerApplicationFactory(createClient);
        const context = await createContext(privateStoreDirectory);

        if (phase === "initialization") {
          await expect(factory(context))
            .rejects.toThrow("WalletConnect private storage is invalid.");
          expect(client.closeCount).toBe(1);
          continue;
        }

        const application = await factory(context);
        const state = resolve(privateStoreDirectory, "state");
        await writeFile(state, "opaque-walletconnect-state", { mode: 0o600 });
        await chmod(state, 0o644);
        await expect(application.close())
          .rejects.toThrow("WalletConnect private storage is invalid.");
        expect(client.closeCount).toBe(1);
      }
    },
  );
});
