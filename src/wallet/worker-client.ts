import { performance } from "node:perf_hooks";
import { fixedIdentifierSchema, deepFreezeValue, captureCanonicalJson } from "../core/index.js";
import { walletRequestInputSchema } from "./request-contract.js";
import { fork, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { WalletOwnerBootstrapPort } from "../runtime/application-context.js";
import { exportWalletSourceKey, restoreWalletSessionSource } from "../runtime/source-identity.js";
import { requireProcessTermination } from "../runtime/shutdown.js";
import { clientError, type WalletConnectClientPort, type WalletConnectClientEvent, type WalletConnectClientActivation, type WalletConnectConnectionAttemptPort, type WalletConnectAttemptOutcome, type WalletConnectStableObservation, type WalletConnectSessionSnapshot, type WalletConnectClientErrorCode } from "./client-contract.js";
import type { WalletRequestInput, WalletRequestAttempt, WalletRequestResponse } from "./request-contract.js";
import { serializeWalletConnectConfiguration } from "./walletconnect-configuration.js";
import { walletSdkAcquisitionMilliseconds, walletEffectSettlementMilliseconds, walletSdkPendingEventLimit } from "./session-limits.js";
import { createWalletWorkerSender, decodeWalletWorkerMessage, workerCommandSchema, workerMessageSchema, type WalletWorkerCommand, type WalletWorkerMessage, type WalletWorkerSession, workerObservationSchema } from "./worker-contract.js";

type Deferred<Value> = { promise: Promise<Value>; resolve(value: Value): void; reject(error: unknown): void };
const deferred = <Value>(): Deferred<Value> => {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  return { promise: new Promise<Value>((yes, no) => { resolve = yes; reject = no; }), resolve, reject };
};
type WorkerReply = Exclude<WalletWorkerMessage, { kind: "observed" }> | (Extract<WalletWorkerMessage, { kind: "observed" }> & { observation: ReturnType<typeof workerObservationSchema.parse> });
type CommandInput = WalletWorkerCommand extends infer Command ? Command extends WalletWorkerCommand ? Omit<Command, "version" | "generation" | "id"> : never : never;
export interface WalletWorkerConstruction {
  // Trusted composition only. Neither CLI/environment nor IPC selects code.
  readonly spawn?: (entry: URL) => ChildProcess;
  readonly relayUrl?: string;
}
const spawnWorker = (entry: URL): ChildProcess => fork(fileURLToPath(entry), [], {
  stdio: ["ignore", "ignore", "ignore", "ipc"], execArgv: [], serialization: "json",
  env: { ...(process.env["PATH"] === undefined ? {} : { PATH: process.env["PATH"] }), NODE_ENV: "production" },
});

export class WalletSdkWorkerClient implements WalletConnectClientPort {
  readonly #generation = randomBytes(32).toString("base64url");
  readonly #closed = deferred<void>();
  readonly #pending = new Map<number, { kind: string; result: Deferred<WorkerReply>; observation?: { proposalCount: number; sessionCount: number; revision: string; sessions: WalletWorkerSession[] } }>();
  readonly #listeners = new Set<(event: WalletConnectClientEvent) => void>();
  readonly #events: WalletConnectClientEvent[] = [];
  #eventsReleased = false;
  #activated = false;
  #state: "acquiring" | "available" | "failed" | "closing" | "closed" = "acquiring";
  #child: ChildProcess | undefined;
  #exited = false;
  #disconnected = false;
  #sender: ReturnType<typeof createWalletWorkerSender> | undefined;
  #failureCode: WalletConnectClientErrorCode = "observation";
  readonly #acquisitionDeadline = performance.now() + walletSdkAcquisitionMilliseconds;
  #nextId = 0;
  #epoch = 0;
  #observing: Promise<WalletConnectStableObservation> | undefined;
  #connection: { id: number; outcome: Deferred<WalletConnectAttemptOutcome> } | undefined;
  #request: { id: number; kind: WalletRequestInput["kind"]; response: Deferred<WalletRequestResponse>; settlement: Deferred<WalletRequestResponse>; responded: boolean } | undefined;
  #closeWork: Promise<void> | undefined;
  readonly #acquisitionTimer: ReturnType<typeof setTimeout>;
  readonly #abort: () => void;

  constructor(private readonly wallet: WalletOwnerBootstrapPort, private readonly signal: AbortSignal, construction: WalletWorkerConstruction = {}) {
    this.#acquisitionTimer = setTimeout(() => this.#fail("deadline"), walletSdkAcquisitionMilliseconds);
    this.#acquisitionTimer.unref();
    this.#abort = () => { void this.contain().catch(() => {}); };
    signal.addEventListener("abort", this.#abort, { once: true });
    void Promise.resolve().then(() => wallet.privateStoreDirectory.ensureDirectory()).then((directory) => {
      if (performance.now() >= this.#acquisitionDeadline) this.#fail("deadline");
      if (this.#state !== "acquiring" || signal.aborted) { this.#finishWithoutChild(); return; }
      const child = (construction.spawn ?? spawnWorker)(new URL("./sdk-worker-entry.js", import.meta.url));
      this.#child = child;
      this.#sender = createWalletWorkerSender((message, done) => { child.send(message, done); }, () => this.#fail());
      child.on("message", (message: unknown) => this.#receive(message));
      child.once("error", () => this.#fail());
      child.once("exit", () => {
        this.#exited = true;
        if (this.#disconnected) this.#onClose();
      });
      child.once("close", () => this.#onClose());
      child.once("disconnect", () => {
        this.#disconnected = true;
        if (this.#state !== "closing" && this.#state !== "closed") this.#fail();
        if (this.#exited) this.#onClose();
      });
      this.#send({ kind: "bootstrap", directory, sourceKey: exportWalletSourceKey(wallet.sourceAuthority), storeSourceId: fixedIdentifierSchema.parse(wallet.sourceAuthority.sdkStoreSourceId), configuration: serializeWalletConnectConfiguration(wallet.configuration), ...(construction.relayUrl === undefined ? {} : { relayUrl: construction.relayUrl }) });
    }).catch(() => { this.#fail(); if (this.#child === undefined) this.#finishWithoutChild(); });
    if (signal.aborted) this.#abort();
  }

  #finishWithoutChild(): void { this.signal.removeEventListener("abort", this.#abort); clearTimeout(this.#acquisitionTimer); this.#state = this.#state === "closing" ? "closed" : "failed"; this.#closed.resolve(); }
  #send(input: CommandInput): number {
    if (this.#sender === undefined || this.#nextId >= Number.MAX_SAFE_INTEGER) throw clientError("sdk");
    const id = ++this.#nextId;
    void this.#sender.send(workerCommandSchema, { ...input, version: "1", generation: this.#generation, id }).catch(() => this.#fail());
    return id;
  }
  #command(input: CommandInput, expected: string): Promise<WorkerReply> {
    if (this.#state !== "available") return Promise.reject(clientError("observation"));
    if ([...this.#pending.values()].some((p) => p.kind === expected)) return Promise.reject(clientError("local_admission"));
    const result = deferred<WorkerReply>();
    const id = this.#nextId + 1;
    this.#pending.set(id, { kind: expected, result });
    try { this.#send(input); }
    catch { this.#pending.delete(id); result.reject(clientError("sdk")); this.#fail(); }
    return result.promise;
  }
  #session(value: WalletWorkerSession): WalletConnectSessionSnapshot {
    const source = restoreWalletSessionSource(this.wallet.capabilityAuthority.clock, value.source.topicDigest);
    return deepFreezeValue(value.status === "invalid" ? { status: "invalid" as const, source } : { status: "valid" as const, source, expiry: value.expiry, namespaces: Object.fromEntries(Object.entries(value.namespaces).map(([key, ns]) => [key, { accounts: ns.accounts, methods: ns.methods, events: ns.events, ...(ns.chains === undefined ? {} : { chains: ns.chains }) }])) });
  }
  #receive(input: unknown): void {
    try {
      const message = decodeWalletWorkerMessage(workerMessageSchema, input);
      if (message.generation !== this.#generation) throw new TypeError();
      if (message.kind === "ready") {
        if (performance.now() >= this.#acquisitionDeadline) { this.#fail("deadline"); return; }
        if (this.#state !== "acquiring" || message.id !== 1) throw new TypeError();
        clearTimeout(this.#acquisitionTimer);
        this.#state = "available";
        this.#event({ kind: "identity_unattributed" });
        return;
      }
      if (message.kind === "event") { if (this.#state === "available") this.#event(message.event as WalletConnectClientEvent); return; }
      if (message.kind === "connection_outcome") {
        const connection = this.#connection;
        if (connection?.id !== message.id) throw new TypeError();
        const outcome = message.outcome;
        connection.outcome.resolve(outcome.status === "approved" ? { ...outcome, session: this.#session(outcome.session) } : outcome as WalletConnectAttemptOutcome);
        this.#connection = undefined;
        return;
      }
      if (message.kind === "response" || message.kind === "settlement" || (message.kind === "failure" && this.#request?.id === message.id)) {
        const request = this.#request;
        if (request?.id !== message.id) throw new TypeError();
        const outcome: WalletRequestResponse = message.kind === "failure" ? (message.code === "local_admission" ? { status: "not_sent" } : { status: "delivery_unknown", reason: "sdk_error" }) : message.outcome;
        if (request.kind === "transaction" ? outcome.status === "signature_returned" || outcome.status === "unsupported_signature" : outcome.status === "hash_returned") throw new TypeError();
        if (message.kind !== "settlement") {
          if (request.responded) throw new TypeError();
          request.responded = true;
          request.response.resolve(outcome);
        }
        if (message.kind !== "response") { request.response.resolve(outcome); request.settlement.resolve(outcome); this.#request = undefined; }
        return;
      }
      if (message.kind === "failure" && message.id === 1 && this.#state === "acquiring") { this.#fail(); return; }
      const pending = this.#pending.get(message.id);
      if (pending?.kind === "observed" && message.kind === "observation_start") {
        if (pending.observation !== undefined) throw new TypeError();
        pending.observation = { proposalCount: message.proposalCount, sessionCount: message.sessionCount, revision: message.revision, sessions: [] };
        return;
      }
      if (pending?.kind === "observed" && message.kind === "observation_session") {
        const observation = pending.observation;
        if (observation === undefined || message.index !== observation.sessions.length || message.index >= observation.sessionCount) throw new TypeError();
        observation.sessions.push(message.session); return;
      }
      if (pending === undefined || (message.kind !== pending.kind && message.kind !== "failure")) throw new TypeError();
      if (message.kind === "observed" && (pending.observation === undefined || pending.observation.sessions.length !== pending.observation.sessionCount)) throw new TypeError();
      if (message.kind === "failure") pending.result.reject(clientError(message.code));
      else if (message.kind === "observed") {
        const observation = workerObservationSchema.parse(pending.observation === undefined ? undefined : { proposalCount: pending.observation.proposalCount, sessions: pending.observation.sessions, revision: pending.observation.revision });
        pending.result.resolve(Object.freeze({ ...message, observation }));
      } else pending.result.resolve(message);
      this.#pending.delete(message.id);
    } catch { this.#fail(); }
  }
  #event(event: WalletConnectClientEvent): void {
    this.#epoch += 1;
    if (!this.#eventsReleased) { if (this.#events.length >= walletSdkPendingEventLimit) { this.#fail(); return; } this.#events.push(event); return; }
    for (const listener of this.#listeners) { try { listener(event); } catch { this.#fail(); } }
  }
  #fail(code: WalletConnectClientErrorCode = "sdk"): void {
    if (this.#state === "closed" || this.#state === "failed") return;
    this.#state = "failed";
    this.#failureCode = code;
    this.#events.length = 0;
    clearTimeout(this.#acquisitionTimer);
    this.#event({ kind: "identity_unattributed" });
    for (const { result } of this.#pending.values()) result.reject(clientError("sdk"));
    this.#pending.clear();
    this.#connection?.outcome.resolve({ status: "failed", failure: "sdk" });
    this.#connection = undefined;
    this.#request?.response.resolve({ status: "delivery_unknown", reason: "sdk_error" });
    // The slot is retained until actual close, even after lost IPC or a signal.
    try { this.#child?.kill("SIGKILL"); } catch { /* Retain ownership until close. */ }
  }
  #onClose(): void {
    if (this.#state === "closed") return;
    if (this.#state !== "closing") this.#fail();
    this.#state = "closed";
    clearTimeout(this.#acquisitionTimer);
    this.signal.removeEventListener("abort", this.#abort);
    this.#sender?.close();
    for (const { result } of this.#pending.values()) result.reject(clientError("sdk"));
    this.#pending.clear();
    const request = this.#request;
    if (request !== undefined) {
      const outcome = { status: "delivery_unknown" as const, reason: "shutdown" as const };
      request.response.resolve(outcome); request.settlement.resolve(outcome); this.#request = undefined;
    }
    this.#connection?.outcome.resolve({ status: "failed", failure: "sdk" });
    this.#connection = undefined;
    this.#closed.resolve();
  }
  observe(signal?: AbortSignal): Promise<WalletConnectStableObservation> {
    if (this.#state !== "available" || signal?.aborted) return Promise.reject(clientError(this.#failureCode));
    if (this.#observing === undefined) {
      const epoch = this.#epoch;
      const observing = this.#command({ kind: "observe" }, "observed").then((reply) => {
        if (reply.kind !== "observed" || epoch !== this.#epoch || this.#state !== "available") throw clientError("observation");
        const observation = reply.observation;
        return Object.freeze({ ...observation, sessions: observation.sessions.map((s) => this.#session(s)), revision: BigInt(observation.revision) });
      }).finally(() => { if (this.#observing === observing) this.#observing = undefined; });
      this.#observing = observing;
    }
    const work = this.#observing!;
    if (signal === undefined) return work;
    return new Promise((resolve, reject) => {
      const abort = () => reject(clientError("observation"));
      signal.addEventListener("abort", abort, { once: true });
      void work.then((value) => { if (signal.aborted) abort(); else resolve(value); }, reject)
        .finally(() => signal.removeEventListener("abort", abort));
    });
  }
  async startConnection(): Promise<WalletConnectConnectionAttemptPort> {
    if (this.#connection !== undefined) throw clientError("local_admission");
    const id = this.#nextId + 1;
    const connection = { id, outcome: deferred<WalletConnectAttemptOutcome>() };
    this.#connection = connection;
    try {
      const reply = await this.#command({ kind: "connect" }, "connected");
      if (reply.kind !== "connected") throw clientError("sdk");
      return Object.freeze({ qr: reply.qr, wait: () => connection.outcome.promise,
        cancel: async () => { if (this.#connection === connection) await this.#command({ kind: "cancel", attemptId: id }, "acknowledged"); return connection.outcome.promise; } });
    } catch (error) { if (this.#connection === connection) this.#connection = undefined; throw error; }
  }
  async containPendingConnectionState(): Promise<void> { await this.#command({ kind: "contain_pending" }, "acknowledged"); }
  async disconnectSession(sourceId: string): Promise<void> { await this.#command({ kind: "disconnect", sourceId: fixedIdentifierSchema.parse(sourceId) }, "acknowledged"); }
  hasPendingRequest(): boolean { return this.#request !== undefined; }
  async startRequest(input: WalletRequestInput): Promise<WalletRequestAttempt> {
    if (this.#state !== "available" || this.#request !== undefined) throw clientError("local_admission");
    const admitted = walletRequestInputSchema.parse(captureCanonicalJson(input));
    const request = { id: this.#nextId + 1, kind: admitted.kind, response: deferred<WalletRequestResponse>(), settlement: deferred<WalletRequestResponse>(), responded: false };
    this.#request = request;
    try { this.#send({ kind: "request", input: admitted }); }
    catch { this.#fail(); }
    return Object.freeze({ response: request.response.promise, settlement: request.settlement.promise });
  }
  activate(listener: (event: WalletConnectClientEvent) => void): WalletConnectClientActivation {
    if (this.#activated) throw clientError("local_admission");
    this.#activated = true;
    this.#listeners.add(listener);
    return Object.freeze({ initialObservation: { status: "unavailable" as const },
      releaseEvents: () => { this.#eventsReleased = true; for (const event of this.#events.splice(0)) for (const subscriber of this.#listeners) subscriber(event); },
      unsubscribe: () => { this.#listeners.delete(listener); } });
  }
  contain(): Promise<void> {
    if (this.#closeWork !== undefined) return this.#closeWork;
    const previous = this.#state;
    this.#state = "closing";
    clearTimeout(this.#acquisitionTimer);
    this.#event({ kind: "identity_unattributed" });
    if (this.#child !== undefined) {
      try { if (previous !== "closed") this.#send({ kind: "shutdown" }); } catch { this.#fail(); }
    } else if (previous !== "acquiring") this.#finishWithoutChild();
    this.#closeWork = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        try { this.#child?.kill("SIGKILL"); } catch { /* A signal is not release. */ }
        reject(requireProcessTermination());
      }, walletEffectSettlementMilliseconds);
      timer.unref();
      void this.#closed.promise.then(() => { clearTimeout(timer); resolve(); }, reject);
    });
    return this.#closeWork;
  }
}
