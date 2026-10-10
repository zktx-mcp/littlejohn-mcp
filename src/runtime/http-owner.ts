import { runtimePackageIdentity } from "./package-identity.js";
import { runtimeControlProtocolVersion, type RuntimeLifecyclePhase } from "./runtime-identity.js";
import { runtimeManagementResources, runtimeShutdownTargetSchema, runtimeStatusSchema,
  type RuntimeShutdownTarget } from "./management-contract.js";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import {
  canonicalJsonStringify,
  captureCanonicalJson,
  parseUtcTimestamp,
  type CanonicalJson,
  type UtcTimestamp,
} from "../core/index.js";
import {
  createControlCredentialVerifier,
  signControlPayload,
  type LocalControlCredentialAuthority,
} from "./control-credential.js";
import type { RuntimeOwnerRecord, RuntimeOwnerStore } from "./database.js";
import {
  createRuntimeFailure,
  RuntimeOperationError,
  runtimeInterfaceErrorMappings,
  toProblemDetails,
} from "./errors.js";
import type { RuntimeApplicationContext } from "./application-context.js";
import {
  fixedHost,
  fixedPort,
  jsonContentType,
  noStoreCacheControl,
  parseRequestTarget,
  problemJsonContentType,
  runtimeIdentityPath,
  type RequestTarget,
} from "./http-boundary.js";
import {
  internalResponseLimitBytes,
  requestBodyLimitBytes,
} from "./http-limits.js";
import {
  assertRuntimeRouteRegistryDescendant,
  createRuntimeRouteRegistry,
  type RuntimeRouteRegistry,
} from "./http-routing.js";
import {
  ownerIdentityRequestClass,
  validateRequestEnvelopeSecurity,
  validateRequestSecurity,
} from "./request-security.js";
import {
  createResourceOwnershipScope,
  type OwnedResource,
  type OwnedResourceRegistration,
  type OwnedResourceRegistry,
  type ResourceOwnershipScope,
} from "./resource-ownership.js";
import {
  isProcessTerminalRequiredError,
  runtimeProcessTerminal,
  runtimeReleased,
  type RuntimeShutdownOutcome,
} from "./shutdown.js";
import {
  createOwnerInstanceId,
  encodeOwnerProofPayload,
  parseRuntimeIdentityChallenge,
  parseOwnerIdentity,
  parseUnsignedOwnerIdentity,
  type RuntimeConfigurationMac,
} from "./runtime-identity.js";
import type {
  RuntimeOwnerSession,
} from "./owner-session.js";

const headerValues = (request: IncomingMessage, name: string): string[] => {
  const distinct = request.headersDistinct[name];
  if (distinct !== undefined) return distinct;
  const value = request.headers[name];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
};

const writeJson = (
  response: ServerResponse,
  status: number,
  value: CanonicalJson,
  maximumBytes = internalResponseLimitBytes,
  contentType = status >= 400 ? problemJsonContentType : jsonContentType,
): void => {
  if (response.destroyed || response.writableEnded) return;
  const body = `${canonicalJsonStringify(value)}\n`;
  const length = Buffer.byteLength(body);
  if (length > maximumBytes) throw new Error("HTTP response exceeds its size limit.");
  response.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": length,
    "Cache-Control": noStoreCacheControl,
  });
  response.end(body);
};

const writeFailure = (
  response: ServerResponse,
  code: string,
  routes?: RuntimeRouteRegistry,
): void => {
  const failure = createRuntimeFailure(code);
  const problem = routes === undefined
    ? toProblemDetails(failure, runtimeInterfaceErrorMappings)
    : routes.toProblemDetails(failure);
  writeJson(response, problem.status, problem as unknown as CanonicalJson);
};

const readBodySize = (request: IncomingMessage): number => {
  if (request.headers["transfer-encoding"] !== undefined) return requestBodyLimitBytes + 1;
  const values = headerValues(request, "content-length");
  if (values.length === 0) return 0;
  const value = values[0];
  if (values.length !== 1 || value === undefined || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    return requestBodyLimitBytes + 1;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : requestBodyLimitBytes + 1;
};

const listen = (server: Server): Promise<void> => new Promise((resolve, reject) => {
  const onError = (error: Error): void => {
    server.off("listening", onListening);
    reject(error);
  };
  const onListening = (): void => {
    server.off("error", onError);
    resolve();
  };
  server.once("error", onError);
  server.once("listening", onListening);
  server.listen(fixedPort, fixedHost);
});

const closeServer = async (server: Server): Promise<void> => {
  if (!server.listening) return;
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
  server.closeAllConnections();
  await closed;
};

import {
  OwnerContention, PeerIncompatibleError, PeerUnavailableError,
  fatalUtf8, readIncomingBytes, openAuthenticatedOwnerChannel,
  validateRuntimeDispatchRequest, createAuthenticatedOwnerSession, dispatchAuthenticatedRequest,
  type AuthenticatedOwnerConnection, type RuntimeDispatchRequest, type RuntimeDispatchResponse,
} from "./owner-transport.js";
export type { RuntimeDispatchRequest, RuntimeDispatchResponse, RuntimeDispatchRequestClass } from "./owner-transport.js";
class BindUnavailableError extends Error {}

export interface HttpOwnerApplication {
  readonly routes: RuntimeRouteRegistry;
  close(): Promise<void> | void;
}

export interface HttpOwnerRootApplication extends HttpOwnerApplication {
  shutdown(): Promise<RuntimeShutdownOutcome>;
}

export type HttpOwnerStartupResource = OwnedResource;
export type HttpOwnerStartupResourceRegistration = OwnedResourceRegistration;
export type HttpOwnerStartupResourceRegistry = OwnedResourceRegistry;
export type HttpOwnerStartupResourceScope = ResourceOwnershipScope;

export interface HttpOwnerOptions {
  readonly ownerStore: RuntimeOwnerStore;
  readonly credential: LocalControlCredentialAuthority;
  readonly configurationMac: RuntimeConfigurationMac;
  readonly now: () => UtcTimestamp;
  readonly onPortOwnershipAcquired: () => Promise<void> | void;
  readonly onShutdownRequested?: (target: RuntimeShutdownTarget) => void;
  readonly applicationFactory?: (
    context: RuntimeApplicationContext,
  ) => Promise<HttpOwnerRootApplication> | HttpOwnerRootApplication;
}

type OwnerPhase = "stopped" | "starting" | "owner" | "deferred" | "stopping";

const ownerReleasePermitBrand: unique symbol = Symbol("littlejohn.http-owner-release-permit");

export interface HttpOwnerReleasePermit {
  readonly generation: number;
  readonly [ownerReleasePermitBrand]: FixedHttpOwner;
}

export type HttpOwnerApplicationShutdown =
  | Readonly<{
      readonly outcome: Extract<RuntimeShutdownOutcome, { readonly kind: "released" }>;
      readonly permit: HttpOwnerReleasePermit;
    }>
  | Readonly<{
      readonly outcome: Extract<RuntimeShutdownOutcome, { readonly kind: "process_terminal" }>;
    }>;

interface LifecycleWork {
  readonly controller: AbortController;
  readonly completion: Promise<void>;
  readonly finish: () => void;
  generation: number;
  awaitingOwner: boolean;
}

interface OwnerAcquisitionResult {
  readonly role: "owner" | "deferred";
  readonly connection?: AuthenticatedOwnerConnection;
}

interface OwnerRecovery {
  readonly controller: AbortController;
  readonly contention: OwnerContention;
  readonly waiters: Set<LifecycleWork>;
  completion: Promise<OwnerAcquisitionResult>;
  outcome?: OwnerAcquisitionResult;
  settled: boolean;
  channelClaimed: boolean;
}

const createLifecycleWork = (): LifecycleWork => {
  let resolveCompletion!: () => void;
  let finished = false;
  const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
  return {
    controller: new AbortController(),
    completion,
    generation: 0,
    awaitingOwner: false,
    finish(): void {
      if (finished) return;
      finished = true;
      resolveCompletion();
    },
  };
};

export class FixedHttpOwner {
  readonly #ownerStore: RuntimeOwnerStore;
  readonly #onShutdownRequested: ((target: RuntimeShutdownTarget) => void) | undefined;
  readonly #managementRoutes: RuntimeRouteRegistry;
  readonly #credential: LocalControlCredentialAuthority;
  readonly #configurationMac: RuntimeConfigurationMac;
  readonly #now: () => UtcTimestamp;
  readonly #onPortOwnershipAcquired: HttpOwnerOptions["onPortOwnershipAcquired"];
  readonly #baseRoutes: RuntimeRouteRegistry;
  readonly #applicationFactory: HttpOwnerOptions["applicationFactory"];
  readonly #lifecycleWork = new Set<LifecycleWork>();
  #phase: OwnerPhase = "stopped";
  #generation = 0;
  #lifecycleController: AbortController | undefined;
  #application: HttpOwnerRootApplication | undefined;
  #startupResources: HttpOwnerStartupResourceScope | undefined;
  #routes: RuntimeRouteRegistry;
  #server: Server | undefined;
  #ownerRecord: RuntimeOwnerRecord | undefined;
  #tail: Promise<void> = Promise.resolve();
  #stopRequested = false;
  #stopPromise: Promise<RuntimeShutdownOutcome> | undefined;
  #closeApplicationPromise: Promise<HttpOwnerApplicationShutdown> | undefined;
  #processTerminalRequired = false;
  #releaseListenerPromise: Promise<void> | undefined;
  #releaseListenerPermit: HttpOwnerReleasePermit | undefined;
  #releasePermit: HttpOwnerReleasePermit | undefined;
  #releaseScope: HttpOwnerStartupResourceScope | undefined;
  #startupController: AbortController | undefined;
  #ownerRecovery: OwnerRecovery | undefined;

  constructor(options: HttpOwnerOptions) {
    this.#ownerStore = options.ownerStore;
    this.#onShutdownRequested = options.onShutdownRequested;
    this.#credential = options.credential;
    this.#configurationMac = options.configurationMac;
    this.#now = options.now;
    this.#onPortOwnershipAcquired = options.onPortOwnershipAcquired;
    this.#baseRoutes = createRuntimeRouteRegistry({
      controlVerifier: createControlCredentialVerifier(options.credential),
    });
    this.#managementRoutes = this.#baseRoutes.extend([
      { method: runtimeManagementResources.status.method, mutation: runtimeManagementResources.status.mutation, pathPattern: runtimeManagementResources.status.path, successStatus: 200,
        handler: async () => ({ ok: true, body: captureCanonicalJson(this.#managementStatus()) }) },
      { method: runtimeManagementResources.shutdown.method, mutation: runtimeManagementResources.shutdown.mutation, pathPattern: runtimeManagementResources.shutdown.path, successStatus: 200,
        handler: async context => {
          const parsed = runtimeShutdownTargetSchema.safeParse(context.body);
          if (!parsed.success) return { ok: false, failure: createRuntimeFailure("invalid_input") };
          const current = this.#managementStatus().target;
          const target = parsed.data;
          if (target.profileId !== current.profileId || target.ownerInstanceId !== current.ownerInstanceId ||
              target.ownerRevision !== current.ownerRevision) return { ok: false, failure: createRuntimeFailure("state_conflict") };
          if (this.#onShutdownRequested === undefined) return { ok: false, failure: createRuntimeFailure("runtime_state_unavailable") };
          this.#stopRequested = true;
          this.#onShutdownRequested(Object.freeze(target));
          return { ok: true, body: captureCanonicalJson({ status: "stopping", target }) };
        } },
    ], runtimeInterfaceErrorMappings);
    this.#routes = this.#baseRoutes;
    this.#applicationFactory = options.applicationFactory;
  }

  get state(): OwnerPhase { return this.#phase; }

  #phaseForIdentity(): RuntimeLifecyclePhase {
    return this.#processTerminalRequired ? "failed" : this.#stopRequested || this.#phase === "stopping" ? "stopping"
      : this.#phase === "owner" ? "running" : "starting";
  }

  #managementStatus() {
    const owner = this.#ownerRecord;
    if (owner === undefined) throw new RuntimeOperationError("runtime_state_unavailable");
    return runtimeStatusSchema.parse({ phase: this.#phaseForIdentity(),
      target: { profileId: owner.profileId, ownerInstanceId: owner.ownerInstanceId, ownerRevision: owner.ownerRevision },
      packageName: runtimePackageIdentity.name, packageVersion: runtimePackageIdentity.version,
      controlProtocolVersion: runtimeControlProtocolVersion });
  }

  startExclusive(): Promise<boolean> {
    return this.#serialize(async () => {
      if (this.#stopRequested || this.#phase !== "stopped") throw new RuntimeOperationError("state_conflict");
      const contention = new OwnerContention();
      const controller = new AbortController();
      this.#startupController = controller;
      try { await this.#startAttemptLocked(controller.signal, contention); return true; }
      catch (error) { if (error instanceof BindUnavailableError) return false; throw error; }
      finally {
        contention.close();
        if (this.#startupController === controller) this.#startupController = undefined;
      }
    });
  }


  #serialize<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }

  start(): Promise<"owner" | "deferred"> {
    return this.#serialize(async () => {
      if (this.#stopRequested) throw new RuntimeOperationError("state_conflict");
      if (this.#phase !== "stopped") throw new RuntimeOperationError("state_conflict");
      return this.#startLocked();
    });
  }

  async #startLocked(): Promise<"owner" | "deferred"> {
    const controller = new AbortController();
    const contention = new OwnerContention();
    this.#startupController = controller;
    try {
      const acquired = await this.#acquireOwnerLocked("start", controller.signal, contention);
      await acquired.connection?.channel.close();
      return acquired.role;
    } catch (error) {
      if (this.#server === undefined) this.#resetStopped(true);
      throw error;
    } finally {
      contention.close();
      if (this.#startupController === controller) this.#startupController = undefined;
    }
  }

  async #acquireOwnerLocked(
    purpose: "start" | "connection",
    signal: AbortSignal,
    contention: OwnerContention,
    probeOnly = false,
  ): Promise<OwnerAcquisitionResult> {
    let initialProbe = purpose === "connection" && probeOnly;
    for (;;) {
      if (signal.aborted || this.#stopRequested) throw new RuntimeOperationError("request_aborted");
      contention.assertAvailable();
      if (!probeOnly && this.#phase !== "owner") {
        try {
          await this.#startAttemptLocked(signal, contention);
          if (purpose === "start") return { role: "owner" };
        } catch (error) {
          if (!(error instanceof BindUnavailableError)) throw error;
        }
      }
      let connection: AuthenticatedOwnerConnection | undefined;
      try {
        connection = await openAuthenticatedOwnerChannel({
          ownerStore: this.#ownerStore,
          credential: this.#credential,
          configurationMac: this.#configurationMac,
        }, AbortSignal.any([signal, contention.controller.signal]));
        contention.assertAvailable();
        if (signal.aborted || this.#stopRequested) throw new RuntimeOperationError("request_aborted");
        if (this.#phase !== "owner") {
          this.#phase = "deferred";
          this.#lifecycleController ??= new AbortController();
        }
        if (purpose === "start" || connection.ready) {
          contention.end();
          return { role: this.#phase === "owner" ? "owner" : "deferred", connection };
        }
        probeOnly = true;
      } catch (error) {
        await connection?.channel.close();
        connection = undefined;
        if (signal.aborted || this.#stopRequested) throw new RuntimeOperationError("request_aborted");
        if (error instanceof PeerIncompatibleError) throw new RuntimeOperationError("port_conflict", { cause: error });
        contention.assertAvailable();
        if (!(error instanceof PeerUnavailableError)) throw error;
        probeOnly = this.#phase === "owner";
        if (initialProbe && !probeOnly) {
          initialProbe = false;
          continue;
        }
      }
      await connection?.channel.close();
      initialProbe = false;
      contention.begin();
      try { await contention.wait(signal); }
      catch (error) {
        if (signal.aborted || this.#stopRequested) throw new RuntimeOperationError("request_aborted");
        contention.assertAvailable();
        throw error;
      }
    }
  }

  async #startAttemptLocked(signal: AbortSignal, contention: OwnerContention): Promise<void> {
    const generation = ++this.#generation;
    const lifecycle = new AbortController();
    const abort = (): void => lifecycle.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const startupResources = createResourceOwnershipScope();
    this.#lifecycleController = lifecycle;
    this.#startupResources = startupResources;
    this.#phase = "starting";
    const server = createServer((request, response) => { void this.#handle(request, response); });
    try {
      await listen(server);
    } catch (error) {
      signal.removeEventListener("abort", abort);
      this.#resetStopped(true);
      if (error instanceof Error && "code" in error && error.code === "EADDRINUSE") {
        throw new BindUnavailableError("The listener was not acquired.", { cause: error });
      }
      throw error;
    }
    signal.removeEventListener("abort", abort);
    this.#server = server;
    try {
      contention.assertAvailable();
      contention.end();
      if (lifecycle.signal.aborted || generation !== this.#generation) throw new RuntimeOperationError("request_aborted");
      const ownerInstanceId = createOwnerInstanceId();
      this.#ownerRecord = this.#ownerStore.publishOwner(
        ownerInstanceId,
        this.#configurationMac,
        parseUtcTimestamp(this.#now()),
      );
      if (lifecycle.signal.aborted || generation !== this.#generation) throw new RuntimeOperationError("request_aborted");
      await this.#onPortOwnershipAcquired();
      if (lifecycle.signal.aborted || generation !== this.#generation) throw new RuntimeOperationError("request_aborted");
      if (this.#applicationFactory !== undefined) {
        const initialization = createLifecycleWork();
        initialization.generation = generation;
        this.#lifecycleWork.add(initialization);
        const factoryResult = (async () => {
          try {
            const application = await this.#applicationFactory?.({
              routes: this.#baseRoutes,
              signal: lifecycle.signal,
              startupResources: startupResources.resources,
            });
            if (application === undefined) throw new TypeError("HTTP owner application is unavailable.");
            const registration = startupResources.resources.register(application);
            return Object.freeze({ application, registration });
          } finally {
            this.#finishLifecycleWork(initialization);
          }
        })();
        let rejectAborted!: (error: RuntimeOperationError) => void;
        const aborted = new Promise<never>((_resolve, reject) => {
          rejectAborted = reject;
        });
        const onAbort = (): void => rejectAborted(new RuntimeOperationError("request_aborted"));
        lifecycle.signal.addEventListener("abort", onAbort, { once: true });
        if (lifecycle.signal.aborted) onAbort();
        try {
          let produced!: Awaited<typeof factoryResult>;
          try { produced = await Promise.race([factoryResult, aborted]); }
          finally { lifecycle.signal.removeEventListener("abort", onAbort); }
          if (
            initialization.controller.signal.aborted ||
            lifecycle.signal.aborted ||
            generation !== this.#generation
          ) throw new RuntimeOperationError("request_aborted");
          assertRuntimeRouteRegistryDescendant(this.#baseRoutes, produced.application.routes);
          const routes = produced.application.routes;
          produced.registration.transfer();
          this.#application = produced.application;
          startupResources.seal();
          if (!startupResources.empty) throw new TypeError("HTTP owner application retained startup resources.");
          this.#routes = routes;
        } catch (error) {
          initialization.controller.abort();
          try { await factoryResult; } catch { /* Preserve the startup failure. */ }
          try { startupResources.seal(); } catch { /* Preserve the startup failure. */ }
          throw error;
        }
      } else {
        startupResources.seal();
      }
      if (lifecycle.signal.aborted || generation !== this.#generation) throw new RuntimeOperationError("request_aborted");
      this.#phase = "owner";
      return;
    } catch (error) {
      this.#beginStoppingLocked(true);
      if (isProcessTerminalRequiredError(error)) {
        this.#processTerminalRequired = true;
        throw error.primaryFailure ?? error;
      }
      try {
        // Callers waiting to acquire this owner cannot finish until startup returns.
        // They have no dependency on this generation's unpublished application.
        await Promise.all([...this.#lifecycleWork]
          .filter((work) => work.generation === generation && !work.awaitingOwner)
          .map((work) => work.completion));
        startupResources.seal();
        await this.#closeApplicationResources();
        await this.#closeServerResource();
        // Internal cleanup does not request a Runtime stop or clear an explicit
        // stop requested while this serialized acquisition was in progress.
        this.#resetStopped(true);
      } catch (cleanupError) {
        if (isProcessTerminalRequiredError(cleanupError)) {
          this.#processTerminalRequired = true;
          throw error;
        }
        throw new AggregateError(
          [error, cleanupError],
          "HTTP owner startup failed and acquired resources could not be released.",
        );
      }
      throw error;
    }
  }

  async dispatchRuntimeRequest(requestInput: RuntimeDispatchRequest): Promise<RuntimeDispatchResponse> {
    const request = validateRuntimeDispatchRequest(requestInput);
    const active = createLifecycleWork();
    const abort = (): void => active.controller.abort();
    if (request.signal?.aborted === true) abort();
    else request.signal?.addEventListener("abort", abort, { once: true });
    let registered = false;
    try {
      await this.#admitRuntimeClient(active);
      registered = true;
      const connection = await this.#connectRuntimeOwner(active);
      try {
        const result = await dispatchAuthenticatedRequest(connection, this.#credential,
          { ...request, signal: active.controller.signal });
        this.#assertActiveRuntimeDispatch(active);
        return result;
      } catch (error) {
        if (active.controller.signal.aborted || error instanceof RuntimeOperationError &&
          error.failure.error.code === "request_aborted") {
          throw new RuntimeOperationError("request_aborted");
        }
        throw new RuntimeOperationError("runtime_state_unavailable");
      } finally { await connection.channel.close(); }
    } finally {
      request.signal?.removeEventListener("abort", abort);
      if (registered) {
        this.#finishLifecycleWork(active);
      }
    }
  }

  async openOwnerSession(signal?: AbortSignal): Promise<RuntimeOwnerSession> {
    const active = createLifecycleWork();
    const abort = (): void => active.controller.abort();
    if (signal?.aborted === true) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    let connection: AuthenticatedOwnerConnection | undefined;
    let admitted = false;
    try {
      await this.#admitRuntimeClient(active);
      admitted = true;
      connection = await this.#connectRuntimeOwner(active);
      const session = createAuthenticatedOwnerSession(connection, this.#credential, active.controller.signal,
        () => this.#finishLifecycleWork(active));
      connection = undefined;
      admitted = false;
      return Object.freeze(session);
    } catch (error) {
      await connection?.channel.close();
      if (error instanceof PeerIncompatibleError) throw new RuntimeOperationError("port_conflict", { cause: error });
      if (error instanceof RuntimeOperationError) throw error;
      throw new RuntimeOperationError(active.controller.signal.aborted
        ? "request_aborted"
        : "runtime_state_unavailable");
    } finally {
      signal?.removeEventListener("abort", abort);
      if (admitted) this.#finishLifecycleWork(active);
    }
  }

  async #connectRuntimeOwner(active: LifecycleWork): Promise<AuthenticatedOwnerConnection> {
    active.awaitingOwner = true;
    let recovery = this.#ownerRecovery;
    if (recovery?.settled === true && recovery.outcome === undefined) {
      await this.#releaseRecovery(recovery);
      return this.#connectRuntimeOwner(active);
    }
    if (recovery?.controller.signal.aborted === true && recovery.waiters.size === 0) {
      await this.#waitForOwnerCleanup(active, recovery.completion);
      await this.#releaseRecovery(recovery);
      return this.#connectRuntimeOwner(active);
    }
    if (recovery === undefined) {
      recovery = {
        controller: new AbortController(),
        contention: new OwnerContention(),
        waiters: new Set(),
        completion: Promise.resolve({ role: "deferred" }),
        settled: false,
        channelClaimed: false,
      };
      const shared = recovery;
      this.#ownerRecovery = shared;
      shared.completion = this.#serialize(async () => {
        try {
          const result = await this.#acquireOwnerLocked(
            "connection", shared.controller.signal, shared.contention, true,
          );
          shared.outcome = result;
          return result;
        } finally {
          shared.settled = true;
          shared.contention.close();
          if (shared.waiters.size === 0) await this.#releaseRecovery(shared);
        }
      });
      // All callers may cancel before acquisition settles. Cleanup still belongs
      // to this operation; its rejection must not become unowned work.
      void shared.completion.catch(() => undefined);
    }
    const shared = recovery;
    shared.waiters.add(active);
    let rejectAborted!: (error: RuntimeOperationError) => void;
    const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = reject; });
    const abort = (): void => {
      shared.waiters.delete(active);
      if (shared.waiters.size === 0 && !shared.settled) shared.controller.abort();
      rejectAborted(new RuntimeOperationError("request_aborted"));
    };
    active.controller.signal.addEventListener("abort", abort, { once: true });
    if (active.controller.signal.aborted) abort();
    let connection: AuthenticatedOwnerConnection | undefined;
    try {
      const acquired = await Promise.race([shared.completion, aborted]);
      active.generation = this.#generation;
      this.#assertActiveRuntimeDispatch(active);
      if (acquired.connection !== undefined && !shared.channelClaimed) {
        shared.channelClaimed = true;
        connection = acquired.connection;
      } else {
        // A validated connection is exclusive to one caller. Other waiters
        // authenticate their own socket after the shared acquisition is ready.
        connection = await openAuthenticatedOwnerChannel({
          ownerStore: this.#ownerStore,
          credential: this.#credential,
          configurationMac: this.#configurationMac,
        }, active.controller.signal);
      }
      this.#assertActiveRuntimeDispatch(active);
      if (!connection.ready) throw new RuntimeOperationError("runtime_state_unavailable");
      active.awaitingOwner = false;
      return connection;
    } catch (error) {
      await connection?.channel.close();
      if (error instanceof PeerIncompatibleError) throw new RuntimeOperationError("port_conflict", { cause: error });
      if (error instanceof PeerUnavailableError) throw new RuntimeOperationError("runtime_state_unavailable", { cause: error });
      throw error;
    } finally {
      active.controller.signal.removeEventListener("abort", abort);
      shared.waiters.delete(active);
      if (shared.waiters.size === 0) {
        if (shared.settled) await this.#releaseRecovery(shared);
        else shared.controller.abort();
      }
    }
  }

  async #releaseRecovery(recovery: OwnerRecovery): Promise<void> {
    if (recovery.outcome?.connection !== undefined && !recovery.channelClaimed) {
      recovery.channelClaimed = true;
      await recovery.outcome.connection.channel.close();
    }
    if (this.#ownerRecovery === recovery) this.#ownerRecovery = undefined;
  }

  async #admitRuntimeClient(active: LifecycleWork): Promise<void> {
    if (this.#stopRequested || active.controller.signal.aborted) {
      throw new RuntimeOperationError("request_aborted");
    }
    active.generation = this.#generation;
    active.awaitingOwner = true;
    this.#lifecycleWork.add(active);
    try {
      if (this.#phase === "stopping") await this.#waitForOwnerCleanup(active, this.#tail);
      active.generation = this.#generation;
    } catch (error) {
      this.#finishLifecycleWork(active);
      throw error;
    }
  }

  async #waitForOwnerCleanup(active: LifecycleWork, completion: Promise<unknown>): Promise<void> {
    let rejectAborted!: (error: RuntimeOperationError) => void;
    const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = reject; });
    const abort = (): void => rejectAborted(new RuntimeOperationError("request_aborted"));
    active.controller.signal.addEventListener("abort", abort, { once: true });
    if (active.controller.signal.aborted || this.#stopRequested) abort();
    try {
      // The original acquisition retains its own error. This caller consumes
      // only the cleanup postcondition and never waits inside the closing scope.
      await Promise.race([completion.then(() => undefined, () => undefined), aborted]);
      if (this.#stopRequested || active.controller.signal.aborted) {
        throw new RuntimeOperationError("request_aborted");
      }
      if (this.#phase === "stopping" || this.#processTerminalRequired) {
        throw new RuntimeOperationError("runtime_state_unavailable");
      }
    } finally {
      active.controller.signal.removeEventListener("abort", abort);
    }
  }

  #assertActiveRuntimeDispatch(active: LifecycleWork): void {
    if (
      active.controller.signal.aborted ||
      !this.#lifecycleWork.has(active) ||
      active.generation !== this.#generation ||
      (this.#phase !== "owner" && this.#phase !== "deferred")
    ) {
      throw new RuntimeOperationError("request_aborted");
    }
  }

  stop(): Promise<RuntimeShutdownOutcome> {
    if (this.#stopPromise !== undefined) return this.#stopPromise;
    let resolveTracked!: (outcome: RuntimeShutdownOutcome) => void;
    let rejectTracked!: (error: unknown) => void;
    const tracked = new Promise<RuntimeShutdownOutcome>((resolve, reject) => {
      resolveTracked = resolve;
      rejectTracked = reject;
    });
    this.#stopPromise = tracked;
    void (async () => {
      try {
        const shutdown = await this.closeApplication();
        if ("permit" in shutdown) {
          await this.releaseListener(shutdown.permit);
        }
        resolveTracked(shutdown.outcome);
      } catch (error) {
        rejectTracked(error);
      } finally {
        if (this.#stopPromise === tracked) this.#stopPromise = undefined;
      }
    })();
    return tracked;
  }

  closeApplication(): Promise<HttpOwnerApplicationShutdown> {
    if (this.#closeApplicationPromise !== undefined) return this.#closeApplicationPromise;
    let resolveTracked!: (shutdown: HttpOwnerApplicationShutdown) => void;
    let rejectTracked!: (error: unknown) => void;
    const tracked = new Promise<HttpOwnerApplicationShutdown>((resolve, reject) => {
      resolveTracked = resolve;
      rejectTracked = reject;
    });
    this.#closeApplicationPromise = tracked;
    this.#stopRequested = true;
    this.#startupController?.abort();
    this.#ownerRecovery?.controller.abort();
    this.#lifecycleController?.abort();
    for (const work of this.#lifecycleWork) work.controller.abort();
    void this.#shutdownApplication().then(
      (shutdown) => {
        if (
          shutdown.outcome.kind === "released" &&
          this.#closeApplicationPromise === tracked
        ) this.#closeApplicationPromise = undefined;
        resolveTracked(shutdown);
      },
      (error: unknown) => {
        if (this.#closeApplicationPromise === tracked) this.#closeApplicationPromise = undefined;
        rejectTracked(error);
      },
    );
    return tracked;
  }

  releaseListener(permit: HttpOwnerReleasePermit): Promise<void> {
    if (permit !== this.#releasePermit) {
      return Promise.reject(new RuntimeOperationError("state_conflict"));
    }
    if (this.#releaseListenerPromise !== undefined) {
      return permit === this.#releaseListenerPermit
        ? this.#releaseListenerPromise
        : Promise.reject(new RuntimeOperationError("state_conflict"));
    }
    let resolveTracked!: () => void;
    let rejectTracked!: (error: unknown) => void;
    const tracked = new Promise<void>((resolve, reject) => {
      resolveTracked = resolve;
      rejectTracked = reject;
    });
    this.#releaseListenerPromise = tracked;
    this.#releaseListenerPermit = permit;
    const clear = (): void => {
      if (this.#releaseListenerPromise === tracked) {
        this.#releaseListenerPromise = undefined;
        this.#releaseListenerPermit = undefined;
      }
    };
    void this.#releaseListenerInternal(permit).then(
      () => { clear(); resolveTracked(); },
      (error: unknown) => { clear(); rejectTracked(error); },
    );
    return tracked;
  }

  async #shutdownApplication(): Promise<HttpOwnerApplicationShutdown> {
    const completions = await this.#serialize(async () => {
      if (this.#phase === "stopped") return undefined;
      this.#beginStoppingLocked();
      return Object.freeze([...this.#lifecycleWork].map((work) => work.completion));
    });
    if (completions !== undefined) {
      await Promise.all(completions);
      if (this.#processTerminalRequired) {
        return Object.freeze({ outcome: runtimeProcessTerminal });
      }
      const application = this.#application;
      if (application !== undefined) {
        let outcome: RuntimeShutdownOutcome;
        try { outcome = await application.shutdown(); }
        catch (error) {
          if (isProcessTerminalRequiredError(error)) {
            this.#processTerminalRequired = true;
          }
          throw error;
        }
        if (outcome.kind === "process_terminal") {
          this.#processTerminalRequired = true;
          return Object.freeze({ outcome });
        }
        if (this.#application === application) this.#application = undefined;
      }
      this.#startupResources?.seal();
      await this.#closeStartupResources();
    }
    const permit = await this.#serialize(async () => {
      if (this.#phase === "stopped") return this.#issueReleasePermitLocked();
      if (
        this.#phase !== "stopping" ||
        this.#application !== undefined ||
        this.#startupResources?.sealed === false ||
        this.#startupResources?.empty === false ||
        this.#lifecycleWork.size !== 0
      ) throw new RuntimeOperationError("state_conflict");
      return this.#issueReleasePermitLocked();
    });
    return Object.freeze({ outcome: runtimeReleased, permit });
  }

  async #releaseListenerInternal(permit: HttpOwnerReleasePermit): Promise<void> {
    const shouldRelease = await this.#serialize(async () => {
      if (
        permit !== this.#releasePermit ||
        this.#startupResources !== this.#releaseScope
      ) throw new RuntimeOperationError("state_conflict");
      if (this.#phase === "stopped") {
        this.#releasePermit = undefined;
        this.#releaseScope = undefined;
        this.#stopRequested = false;
        return false;
      }
      if (
        this.#phase !== "stopping" ||
        this.#application !== undefined ||
        this.#startupResources?.sealed === false ||
        this.#startupResources?.empty === false ||
        this.#lifecycleWork.size !== 0
      ) throw new RuntimeOperationError("state_conflict");
      return true;
    });
    if (!shouldRelease) return;
    await this.#closeServerResource();
    await this.#serialize(async () => {
      if (
        permit !== this.#releasePermit ||
        this.#startupResources !== this.#releaseScope ||
        this.#startupResources?.sealed === false ||
        this.#startupResources?.empty === false ||
        this.#server !== undefined
      ) {
        throw new RuntimeOperationError("state_conflict");
      }
      this.#resetStopped();
    });
  }

  #issueReleasePermitLocked(): HttpOwnerReleasePermit {
    const current = this.#releasePermit;
    if (current !== undefined && current.generation === this.#generation) return current;
    const permit = Object.freeze({
      generation: this.#generation,
      [ownerReleasePermitBrand]: this,
    });
    this.#releasePermit = permit;
    this.#releaseScope = this.#startupResources;
    return permit;
  }

  #beginStoppingLocked(preserveAcquisitionWaiters = false): void {
    if (this.#phase !== "stopping") {
      this.#phase = "stopping";
      this.#generation += 1;
      this.#releasePermit = undefined;
      this.#releaseScope = undefined;
    }
    this.#lifecycleController?.abort();
    for (const work of this.#lifecycleWork) {
      if (!preserveAcquisitionWaiters || !work.awaitingOwner) work.controller.abort();
    }
  }

  async #closeApplicationResources(): Promise<void> {
    let failure: unknown;
    const application = this.#application;
    if (application !== undefined) {
      try {
        await application.close();
        if (this.#application === application) this.#application = undefined;
      } catch (error) {
        failure = error;
      }
    }
    const startupResources = this.#startupResources;
    if (startupResources !== undefined && !startupResources.empty) {
      try { await startupResources.close(); }
      catch (error) { failure ??= error; }
    }
    if (failure !== undefined) throw failure;
  }

  async #closeStartupResources(): Promise<void> {
    let failure: unknown;
    const startupResources = this.#startupResources;
    if (startupResources !== undefined && !startupResources.empty) {
      try { await startupResources.close(); }
      catch (error) { failure ??= error; }
    }
    if (failure !== undefined) throw failure;
  }

  async #closeServerResource(): Promise<void> {
    const server = this.#server;
    if (server === undefined) return;
    await closeServer(server);
    if (this.#server === server) this.#server = undefined;
  }

  #finishLifecycleWork(work: LifecycleWork): void {
    this.#lifecycleWork.delete(work);
    work.finish();
  }

  #resetStopped(preserveStopRequest = false): void {
    this.#phase = "stopped";
    this.#lifecycleController = undefined;
    this.#application = undefined;
    this.#startupResources = undefined;
    this.#routes = this.#baseRoutes;
    this.#server = undefined;
    this.#ownerRecord = undefined;
    this.#releasePermit = undefined;
    this.#releaseScope = undefined;
    this.#processTerminalRequired = false;
    if (!preserveStopRequest) this.#stopRequested = false;
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const target = parseRequestTarget(request.url);
    if (target?.pathname === runtimeIdentityPath) {
      try { await this.#handleIdentity(request, response, target); }
      catch {
        if (!response.headersSent && !response.destroyed) writeFailure(response, "internal_error");
        else response.destroy();
      }
      return;
    }
    if (target !== undefined && Object.values(runtimeManagementResources).some(resource => resource.path === target.pathname)) {
      // Only these immutable descriptors have a lifecycle outside application draining.
      // Identity publication and the complete normal security checks are still required.
      if (this.#ownerRecord === undefined) { writeFailure(response, "runtime_state_unavailable"); return; }
      try { await this.#handleApplicationRoute(request, response, target, new AbortController().signal, this.#managementRoutes); }
      catch {
        if (!response.headersSent && !response.destroyed) writeFailure(response, "internal_error", this.#managementRoutes);
        else response.destroy();
      }
      return;
    }
    if (this.#stopRequested) {
      writeFailure(response, "request_aborted", this.#routes);
      return;
    }
    if (this.#phase === "stopping") {
      writeFailure(response, "runtime_state_unavailable", this.#routes);
      return;
    }
    const work = createLifecycleWork();
    work.generation = this.#generation;
    this.#lifecycleWork.add(work);
    const abort = (): void => work.controller.abort();
    const responseClosed = (): void => { if (!response.writableEnded) work.controller.abort(); };
    request.once("aborted", abort);
    request.once("error", abort);
    response.once("close", responseClosed);
    const lifecycle = this.#lifecycleController;
    if (lifecycle?.signal.aborted === true) work.controller.abort();
    else lifecycle?.signal.addEventListener("abort", abort, { once: true });
    try {
      if (target === undefined) return writeFailure(response, "invalid_input");
      await this.#handleApplicationRoute(request, response, target, work.controller.signal);
    } catch (error) {
      if (work.controller.signal.aborted) {
        if (!response.headersSent && !response.destroyed) writeFailure(response, "request_aborted", this.#routes);
      } else if (!response.headersSent) writeFailure(response, "internal_error", this.#routes);
      else response.destroy();
    } finally {
      request.off("aborted", abort);
      request.off("error", abort);
      response.off("close", responseClosed);
      lifecycle?.signal.removeEventListener("abort", abort);
      this.#finishLifecycleWork(work);
    }
  }

  async #handleIdentity(request: IncomingMessage, response: ServerResponse, target: RequestTarget): Promise<void> {
    const security = validateRequestSecurity({
      requestClass: ownerIdentityRequestClass,
      params: Object.freeze({}),
      host: headerValues(request, "host"),
      origin: headerValues(request, "origin"),
      authorization: headerValues(request, "authorization"),
      cookie: headerValues(request, "cookie"),
      contentType: headerValues(request, "content-type"),
      query: target.query,
      bodyLength: readBodySize(request),
      acceptsBody: false,
    });
    if (!security.ok) return writeFailure(response, security.code);
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      return writeFailure(response, "method_not_allowed");
    }
    const challenges = headerValues(request, "littlejohn-identity-challenge");
    if (challenges.length !== 1) {
      return writeFailure(response, "invalid_input");
    }
    let challenge;
    try { challenge = parseRuntimeIdentityChallenge(challenges[0]); }
    catch { return writeFailure(response, "invalid_input"); }
    const owner = this.#ownerRecord;
    if (owner === undefined) return writeFailure(response, "runtime_busy");
    const identityWithoutProof = {
      profileId: owner.profileId,
      ownerInstanceId: owner.ownerInstanceId,
      configurationMac: owner.configurationMac,
      challenge,
      ownerRevision: owner.ownerRevision,
      packageName: runtimePackageIdentity.name, packageVersion: runtimePackageIdentity.version,
      controlProtocolVersion: runtimeControlProtocolVersion, role: "backend" as const, phase: this.#phaseForIdentity(),
    };
    const unsignedIdentity = parseUnsignedOwnerIdentity(identityWithoutProof);
    const identity = parseOwnerIdentity({
      ...unsignedIdentity,
      proof: signControlPayload(this.#credential, encodeOwnerProofPayload(unsignedIdentity)),
    });
    const ready = this.#phase === "owner" && !this.#stopRequested && !this.#processTerminalRequired;
    writeJson(response, ready ? 200 : 503, identity as unknown as CanonicalJson, internalResponseLimitBytes, jsonContentType);
  }

  async #handleApplicationRoute(
    request: IncomingMessage,
    response: ServerResponse,
    target: RequestTarget,
    signal: AbortSignal,
    managementRoutes?: RuntimeRouteRegistry,
  ): Promise<void> {
    const routes = managementRoutes ?? this.#routes;
    const bodyLength = readBodySize(request);
    const envelopeSecurity = validateRequestEnvelopeSecurity({
      host: headerValues(request, "host"),
      bodyLength,
    });
    if (!envelopeSecurity.ok) return writeFailure(response, envelopeSecurity.code, routes);
    if (managementRoutes === undefined && this.#phase !== "owner") return writeFailure(response, "runtime_busy", routes);
    const match = routes.match(request.method, target.pathname);
    if (match.status === "not_found") return writeFailure(response, "route_not_found", routes);
    if (match.status === "method_not_allowed") {
      if (target.query !== "") {
        return writeFailure(response, "query_not_supported", routes);
      }
      const classSecurity = routes.validateMethodRejection(match, {
        origin: headerValues(request, "origin"),
        authorization: headerValues(request, "authorization"),
        cookie: headerValues(request, "cookie"),
      });
      if (!classSecurity.ok) return writeFailure(response, classSecurity.code, routes);
      response.setHeader("Allow", match.allow.join(", "));
      return writeFailure(response, "method_not_allowed", routes);
    }
    const security = routes.validateSecurity(match, {
      host: headerValues(request, "host"),
      origin: headerValues(request, "origin"),
      authorization: headerValues(request, "authorization"),
      cookie: headerValues(request, "cookie"),
      contentType: headerValues(request, "content-type"),
      query: target.query,
      bodyLength,
    });
    if (!security.ok) return writeFailure(response, security.code, routes);

    let body: unknown = {};
    if (match.route.acceptsBody) {
      try {
        const bytes = await readIncomingBytes(request, requestBodyLimitBytes, signal);
        if (bytes.length !== bodyLength || bytes.length === 0) throw new TypeError("Request body length is invalid.");
        body = JSON.parse(fatalUtf8(bytes)) as unknown;
      } catch (error) {
        const code = error instanceof RuntimeOperationError ? error.failure.error.code : "invalid_json";
        return writeFailure(response, code, routes);
      }
    }
    if (signal.aborted) return;
    let result;
    try {
      const executing = match.route.handler({ params: match.params, query: target.query, body, signal });
      body = undefined;
      result = routes.normalizeResult(match.route, await executing);
    }
    catch { return writeFailure(response, signal.aborted ? "request_aborted" : "internal_error", routes); }
    if (signal.aborted) return;
    if (!result.ok) {
      return writeJson(response, result.problem.status, result.problem as unknown as CanonicalJson);
    }
    writeJson(response, match.route.successStatus, result.body, match.route.responseLimitBytes);
  }
}
