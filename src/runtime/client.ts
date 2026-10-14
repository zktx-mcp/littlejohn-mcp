import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { randomInt } from "node:crypto";
import { parseUtcTimestamp } from "../core/index.js";
import { readRuntimeConfiguration } from "./configuration.js";
import { deriveRuntimeConfigurationMac, loadOrCreateControlCredential, type LocalControlCredentialAuthority } from "./control-credential.js";
import { ProductDatabase } from "./database.js";
import { ensureOwnerOnlyDirectory, resolveApplicationDataDirectory, runtimePaths } from "./paths.js";
import { createPresentationPublicationKeyOwner } from "./presentation-publication-key.js";
import type { PresentationSnapshotStore } from "./presentation-snapshot.js";
import { RuntimeOperationError } from "./errors.js";
import { runtimeReleased, type RuntimeShutdownOutcome } from "./shutdown.js";
import { runtimeBackendStartupMilliseconds } from "./management-contract.js";
import { ownerContentionDeadlineMilliseconds, ownerRetryMinimumDelayMilliseconds, ownerRetryDelayGrowth, ownerTransportDeadlineMilliseconds } from "./http-limits.js";
import { openAuthenticatedOwnerChannel, createAuthenticatedOwnerSession, dispatchAuthenticatedRequest,
  validateRuntimeDispatchRequest, PeerIncompatibleError, PeerUnavailableError,
  type AuthenticatedOwnerConnection, type RuntimeDispatchRequest, type RuntimeDispatchResponse } from "./owner-transport.js";
import type { RuntimeConfigurationMac } from "./runtime-identity.js";
import type { RuntimeOwnerSession } from "./owner-session.js";
import type { PresentationTurnContext } from "../interfaces/mcp-app/publication-context.js";

export type BackendSpawn = (environment: Readonly<Record<string, string>>) => ChildProcess;
const spawnBackend: BackendSpawn = environment => {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./backend-entry.js", import.meta.url))], {
    detached: true, stdio: "ignore", windowsHide: true, env: environment,
  });
  child.unref();
  return child;
};
interface ClientResources {
  readonly database: ProductDatabase;
  readonly credential: LocalControlCredentialAuthority;
  readonly configurationMac: RuntimeConfigurationMac;
  readonly publicationKeys: ReturnType<typeof createPresentationPublicationKeyOwner>;
}
interface Acquisition { readonly controller: AbortController; readonly work: Promise<void>; waiters: number; settled: boolean }

const interrupted = (): RuntimeOperationError => new RuntimeOperationError("request_aborted");
const waiting = async <T>(work: Promise<T>, signal: AbortSignal): Promise<T> => {
  if (signal.aborted) throw interrupted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(interrupted()); });
  signal.addEventListener("abort", abort, { once: true });
  try { return await Promise.race([work, cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
};

export class RuntimeClient {
  readonly #lifetime = new AbortController();
  readonly #configuration;
  readonly #paths;
  readonly #environment: Readonly<Record<string, string>>;
  readonly #spawn: BackendSpawn;
  readonly #pending = new Set<Promise<unknown>>();
  readonly #sessions = new Set<RuntimeOwnerSession>();
  readonly #connections = new Set<AuthenticatedOwnerConnection>();
  readonly startupFailure: Promise<unknown>;
  readonly #failStartup: (error: unknown) => void;
  #resources: Promise<ClientResources> | undefined;
  #database: ProductDatabase | undefined;
  #acquisition: Acquisition | undefined;
  #candidate: { child: ChildProcess; ended: boolean } | undefined;
  #knownReady = false;
  #closed = false;
  #closing: Promise<RuntimeShutdownOutcome> | undefined;
  #startedAt: number | undefined;

  private constructor(environment: Readonly<Record<string, string | undefined>>, spawnProcess: BackendSpawn) {
    // Invalid RPC configuration remains a pre-filesystem, pre-MCP failure.
    this.#configuration = readRuntimeConfiguration(environment);
    this.#paths = runtimePaths(resolveApplicationDataDirectory(environment));
    const selected: Record<string, string> = { NODE_ENV: "production", LITTLEJOHN_MCP_DATA_DIR: this.#paths.dataDirectory };
    for (const name of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "LITTLEJOHN_MCP_RPC_URL", "LITTLEJOHN_MCP_WALLETCONNECT_PROJECT_ID"]) {
      const value = environment[name]; if (value !== undefined) selected[name] = value;
    }
    this.#environment = Object.freeze(selected);
    this.#spawn = spawnProcess;
    let fail!: (error: unknown) => void;
    this.startupFailure = new Promise(resolve => { fail = resolve; });
    this.#failStartup = fail;
  }

  static async create(options: { environment?: Readonly<Record<string, string | undefined>>; spawnBackend?: BackendSpawn } = {}): Promise<RuntimeClient> {
    return new RuntimeClient(options.environment ?? process.env, options.spawnBackend ?? spawnBackend);
  }

  start(): Promise<void> {
    if (this.#closed) return Promise.reject(interrupted());
    if (this.#resources !== undefined) return Promise.resolve();
    this.#startedAt = performance.now();
    this.#resources = this.#openResources();
    void this.#resources.catch(error => { if (!this.#closed) this.#failStartup(error); });
    // This is one bounded initial acquisition, not an idle restart loop. MCP
    // initialization and static discovery do not await it.
    void this.#joinReady(this.#lifetime.signal).catch(error => {
      if (!this.#closed && error instanceof RuntimeOperationError && error.failure.error.code === "port_conflict") this.#failStartup(error);
    });
    return Promise.resolve();
  }

  async #openResources(): Promise<ClientResources> {
    try { await ensureOwnerOnlyDirectory(this.#paths.dataDirectory); }
    catch { throw new RuntimeOperationError("runtime_state_unavailable"); }
    const credential = await loadOrCreateControlCredential(this.#paths.dataDirectory, this.#paths.controlCredential);
    const database = await ProductDatabase.open(this.#paths.database, parseUtcTimestamp(new Date().toISOString()));
    this.#database = database;
    return Object.freeze({ database, credential,
      configurationMac: deriveRuntimeConfigurationMac(credential, this.#configuration),
      publicationKeys: createPresentationPublicationKeyOwner({ credential, profileId: database.ownerStore().readProfile().profileId }) });
  }

  async #profile(signal = this.#lifetime.signal): Promise<ClientResources> {
    if (this.#resources === undefined) throw new RuntimeOperationError("state_conflict");
    const resources = await waiting(this.#resources, signal);
    if (this.#closed || signal.aborted) throw interrupted();
    return resources;
  }

  presentationSnapshotStore(): {
    read(id: string): Promise<ReturnType<PresentationSnapshotStore["read"]>>;
    readMetadata(id: string): Promise<ReturnType<PresentationSnapshotStore["readMetadata"]>>;
    readResultChunk(input: Parameters<PresentationSnapshotStore["readResultChunk"]>[0]): Promise<ReturnType<PresentationSnapshotStore["readResultChunk"]>>;
  } {
    return Object.freeze({
      read: async (id: string) => (await this.#profile()).database.presentationSnapshotStore().read(id),
      readMetadata: async (id: string) => (await this.#profile()).database.presentationSnapshotStore().readMetadata(id),
      readResultChunk: async (input: Parameters<PresentationSnapshotStore["readResultChunk"]>[0]) =>
        (await this.#profile()).database.presentationSnapshotStore().readResultChunk(input),
    });
  }
  presentationPublicationKeys() {
    return Object.freeze({ derive: async (context: PresentationTurnContext): Promise<string> =>
      (await this.#profile()).publicationKeys.derive(context) });
  }

  async #probe(resources: ClientResources, signal: AbortSignal): Promise<AuthenticatedOwnerConnection> {
    try {
      const connection = await openAuthenticatedOwnerChannel({ ownerStore: resources.database.ownerStore(),
        credential: resources.credential, configurationMac: resources.configurationMac }, signal);
      if (this.#closed || signal.aborted) { await connection.channel.close(); throw interrupted(); }
      return connection;
    } catch (error) {
      if (error instanceof PeerIncompatibleError) throw new RuntimeOperationError("port_conflict", { cause: error });
      throw error;
    }
  }

  #ensureReady(): Promise<void> {
    if (this.#closed) return Promise.reject(interrupted());
    if (this.#acquisition !== undefined) return this.#acquisition.work;
    const controller = new AbortController();
    const deadline = (this.#startedAt ?? performance.now()) + runtimeBackendStartupMilliseconds;
    this.#startedAt = undefined;
    const timer = setTimeout(() => controller.abort(), Math.max(0, deadline - performance.now()));
    const joined = AbortSignal.any([controller.signal, this.#lifetime.signal]);
    const work = this.#acquire(joined, deadline).finally(() => {
      clearTimeout(timer);
      if (this.#acquisition?.controller === controller) { this.#acquisition.settled = true; this.#acquisition = undefined; }
    });
    this.#acquisition = { controller, work, waiters: 0, settled: false };
    void work.catch(() => undefined);
    return work;
  }

  async #joinReady(signal: AbortSignal): Promise<void> {
    const previous = this.#acquisition;
    if (previous?.controller.signal.aborted && previous.waiters === 0) {
      await waiting(previous.work.catch(() => undefined), signal);
      return this.#joinReady(signal);
    }
    const work = this.#ensureReady();
    const acquisition = this.#acquisition;
    if (acquisition === undefined) return waiting(work, signal);
    acquisition.waiters += 1;
    try { await waiting(work, signal); }
    finally {
      acquisition.waiters -= 1;
      if (acquisition.waiters === 0 && !acquisition.settled) acquisition.controller.abort();
    }
  }

  async #acquire(signal: AbortSignal, deadline: number): Promise<void> {
    let spawned = false;
    let retry = 0;
    let contentionDeadline: number | undefined;
    try {
      const resources = await this.#profile(signal);
      for (;;) {
        if (signal.aborted) throw interrupted();
        if (performance.now() >= deadline) throw new RuntimeOperationError("runtime_state_unavailable");
        let phase: string | undefined;
        try {
          const connection = await this.#probe(resources, signal);
          phase = connection.ownerIdentity.phase;
          const ready = connection.ready;
          await connection.channel.close();
          if (ready) { this.#knownReady = true; return; }
        } catch (error) {
          if (!(error instanceof PeerUnavailableError)) throw error;
          if (!spawned && (this.#candidate === undefined || this.#candidate.ended)) {
            const child = this.#spawn(this.#environment);
            const candidate = { child, ended: false };
            this.#candidate = candidate;
            child.once("error", () => { candidate.ended = true; });
            child.once("exit", () => { candidate.ended = true; });
            spawned = true;
          }
        }
        const starting = phase === "starting" || (phase === undefined && this.#candidate?.ended === false);
        if (starting) contentionDeadline = undefined;
        else contentionDeadline ??= performance.now() + ownerContentionDeadlineMilliseconds;
        const until = Math.min(deadline, contentionDeadline ?? deadline);
        // Startup observation backs off only up to one bounded identity exchange.
        // This keeps a running candidate observable without a separate polling interval.
        const minimum = Math.min(ownerTransportDeadlineMilliseconds,
          ownerRetryMinimumDelayMilliseconds * ownerRetryDelayGrowth ** retry);
        if (!Number.isSafeInteger(minimum) || performance.now() + minimum >= until) {
          throw new RuntimeOperationError("runtime_state_unavailable");
        }
        const notBefore = Math.min(until, performance.now() + minimum + randomInt(minimum));
        do { await delay(Math.max(1, Math.ceil(notBefore - performance.now())), undefined, { signal }); }
        while (performance.now() < notBefore);
        retry += 1;
      }
    } catch (error) {
      if (this.#closed) throw interrupted();
      if (signal.aborted) throw new RuntimeOperationError("runtime_state_unavailable");
      throw error;
    }
  }

  async #connect(signal: AbortSignal): Promise<AuthenticatedOwnerConnection> {
    const resources = await this.#profile(signal);
    if (this.#knownReady) {
      try {
        const connection = await this.#probe(resources, signal);
        if (connection.ready) return connection;
        await connection.channel.close();
      } catch (error) { if (!(error instanceof PeerUnavailableError)) throw error; }
      this.#knownReady = false;
    }
    await this.#joinReady(signal);
    const connection = await this.#probe(resources, signal);
    if (!connection.ready) { await connection.channel.close(); throw new RuntimeOperationError("runtime_state_unavailable"); }
    return connection;
  }

  #track<T>(work: Promise<T>): Promise<T> {
    this.#pending.add(work);
    void work.finally(() => this.#pending.delete(work)).catch(() => undefined);
    return work;
  }
  dispatchRuntimeRequest(input: RuntimeDispatchRequest): Promise<RuntimeDispatchResponse> {
    const request = validateRuntimeDispatchRequest(input);
    return this.#track((async () => {
      const signal = request.signal === undefined ? this.#lifetime.signal : AbortSignal.any([this.#lifetime.signal, request.signal]);
      const connection = await this.#connect(signal);
      this.#connections.add(connection);
      try { return await dispatchAuthenticatedRequest(connection, (await this.#profile(signal)).credential, { ...request, signal }); }
      catch (error) { throw error instanceof RuntimeOperationError ? error : new RuntimeOperationError(signal.aborted ? "request_aborted" : "runtime_state_unavailable"); }
      finally { await connection.channel.close(); this.#connections.delete(connection); }
    })());
  }
  openOwnerSession(callerSignal?: AbortSignal): Promise<RuntimeOwnerSession> {
    return this.#track((async () => {
      const signal = callerSignal === undefined ? this.#lifetime.signal : AbortSignal.any([this.#lifetime.signal, callerSignal]);
      const resources = await this.#profile(signal);
      const connection = await this.#connect(signal);
      if (this.#closed || signal.aborted) { await connection.channel.close(); throw interrupted(); }
      let session: RuntimeOwnerSession;
      session = createAuthenticatedOwnerSession(connection, resources.credential, this.#lifetime.signal,
        () => { this.#sessions.delete(session); });
      this.#sessions.add(session);
      return session;
    })());
  }
  stop(): Promise<RuntimeShutdownOutcome> {
    if (this.#closing !== undefined) return this.#closing;
    this.#closed = true;
    const sessions = [...this.#sessions]; const connections = [...this.#connections];
    this.#closing = Promise.resolve().then(async () => {
      this.#lifetime.abort();
      const closed = await Promise.allSettled([...sessions.map(session => session.close()), ...connections.map(connection => connection.channel.close())]);
      await Promise.allSettled([...this.#pending, ...(this.#acquisition === undefined ? [] : [this.#acquisition.work]), ...(this.#resources === undefined ? [] : [this.#resources])]);
      const failed = closed.find(result => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      this.#database?.close();
      return runtimeReleased;
    }).catch(error => { this.#closing = undefined; throw error; });
    return this.#closing;
  }
}
