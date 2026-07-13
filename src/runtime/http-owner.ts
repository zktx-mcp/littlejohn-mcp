import {
  Agent,
  createServer,
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { connect as connectSocket, type Socket } from "node:net";

import {
  canonicalJsonStringify,
  captureCanonicalJson,
  parseUtcTimestamp,
  type CanonicalJson,
  type UtcTimestamp,
} from "../core/index.js";
import {
  createControlAuthorizationHeader,
  createControlCredentialVerifier,
  signControlPayload,
  verifyControlPayload,
  type LocalControlCredentialAuthority,
} from "./control-credential.js";
import type { RuntimeOwnerRecord, RuntimeOwnerStore } from "./database.js";
import {
  createRuntimeFailure,
  RuntimeOperationError,
  runtimeInterfaceErrorMappings,
  toProblemDetails,
} from "./errors.js";
import {
  fixedHost,
  fixedHostHeader,
  fixedPort,
  internalResponseLimitBytes,
  jsonContentType,
  noStoreCacheControl,
  parseRequestTarget,
  problemJsonContentType,
  requestBodyLimitBytes,
  type RequestTarget,
} from "./http-boundary.js";
import {
  assertRuntimeRouteRegistryDescendant,
  createRuntimeRouteRegistry,
  type RouteMethod,
  type RuntimeRouteRegistry,
} from "./http-routing.js";
import {
  validateRequestEnvelopeSecurity,
  validateRequestSecurity,
} from "./request-security.js";
import {
  createOwnerInstanceId,
  createRuntimeIdentityChallenge,
  encodeOwnerProofPayload,
  parseOwnerIdentity,
  parseRuntimeBuildDigest,
  parseRuntimeIdentityChallenge,
  parseUnsignedOwnerIdentity,
  runtimeProtocolVersion,
} from "./runtime-identity.js";

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
): void => {
  if (response.destroyed || response.writableEnded) return;
  const body = `${canonicalJsonStringify(value)}\n`;
  const length = Buffer.byteLength(body);
  if (length > maximumBytes) throw new Error("HTTP response exceeds its size limit.");
  response.writeHead(status, {
    "Content-Type": status >= 400 ? problemJsonContentType : jsonContentType,
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

const fatalUtf8 = (bytes: Uint8Array): string =>
  new TextDecoder("utf-8", { fatal: true }).decode(bytes);

const readIncomingBytes = async (
  input: AsyncIterable<unknown>,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> => {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of input) {
    if (signal?.aborted === true) throw new RuntimeOperationError("request_aborted");
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    length += bytes.length;
    if (length > maximumBytes) throw new RuntimeOperationError("payload_too_large");
    chunks.push(bytes);
  }
  if (signal?.aborted === true) throw new RuntimeOperationError("request_aborted");
  return Buffer.concat(chunks);
};

const parseCanonicalHttpJson = (bytes: Uint8Array): CanonicalJson => {
  const text = fatalUtf8(bytes);
  if (!text.endsWith("\n")) throw new TypeError("HTTP JSON is not canonical.");
  const parsed: unknown = JSON.parse(text.slice(0, -1));
  const canonical = captureCanonicalJson(parsed);
  if (`${canonicalJsonStringify(canonical)}\n` !== text) throw new TypeError("HTTP JSON is not canonical.");
  return canonical;
};

class PeerUnavailableError extends Error {}
class PeerIncompatibleError extends Error {}
const ownerTransportDeadlineMilliseconds = 2_000;
type RequestDeadlineBoundary = "response" | "dispatch";

interface ResponsePacket {
  readonly status: number;
  readonly headers: IncomingMessage["headers"];
  readonly bytes: Uint8Array;
  readonly socket: Socket;
}

interface AuthenticatedOwnerChannel {
  readonly agent: Agent;
  readonly socket: Socket;
  close(): void;
}

const connectPinnedAgent = async (signal?: AbortSignal): Promise<AuthenticatedOwnerChannel> => {
  if (signal?.aborted === true) throw new RuntimeOperationError("request_aborted");
  const socket = connectSocket({ host: fixedHost, port: fixedPort });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => socket.destroy(new Error("Owner connection timed out.")),
      ownerTransportDeadlineMilliseconds,
    );
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off("connect", onConnect);
      socket.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const onConnect = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onAbort = (): void => {
      cleanup();
      socket.destroy();
      reject(new RuntimeOperationError("request_aborted"));
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
  }).catch((error) => {
    socket.destroy();
    if (error instanceof RuntimeOperationError) throw error;
    throw new PeerUnavailableError(error instanceof Error ? error.message : "Owner connection failed.");
  });
  socket.setNoDelay(true);
  const agent = new Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
  agent.createConnection = (() => socket) as typeof agent.createConnection;
  return {
    agent,
    socket,
    close(): void {
      agent.destroy();
      socket.destroy();
    },
  };
};

const requestPacket = (
  channel: AuthenticatedOwnerChannel,
  options: {
    readonly method: RouteMethod;
    readonly path: string;
    readonly headers: Readonly<Record<string, string | number>>;
    readonly body?: string;
  },
  maximumBytes: number,
  deadlineBoundary: RequestDeadlineBoundary,
  signal?: AbortSignal,
): Promise<ResponsePacket> => new Promise((resolve, reject) => {
  if (signal?.aborted === true) {
    reject(new RuntimeOperationError("request_aborted"));
    return;
  }
  let settled = false;
  let request: ClientRequest;
  let deadline: NodeJS.Timeout | undefined;
  let pinnedSocketAssigned = false;
  let requestFinished = false;
  const clearDispatchedDeadline = (): void => {
    if (deadlineBoundary !== "dispatch" || !pinnedSocketAssigned || !requestFinished || deadline === undefined) return;
    clearTimeout(deadline);
    deadline = undefined;
  };
  const cleanup = (): void => {
    if (deadline !== undefined) clearTimeout(deadline);
    signal?.removeEventListener("abort", onAbort);
    request?.off("socket", onSocket);
    request?.off("finish", onFinish);
  };
  const resolveOnce = (packet: ResponsePacket): void => {
    if (settled) return;
    settled = true;
    cleanup();
    resolve(packet);
  };
  const rejectOnce = (error: unknown): void => {
    if (settled) return;
    settled = true;
    cleanup();
    reject(error);
  };
  const onAbort = (): void => {
    rejectOnce(new RuntimeOperationError("request_aborted"));
    request.destroy();
    channel.socket.destroy();
  };
  const onDeadline = (): void => {
    rejectOnce(new PeerUnavailableError("Owner request timed out."));
    request.destroy();
    channel.socket.destroy();
  };
  const onSocket = (socket: Socket): void => {
    if (socket !== channel.socket || socket.destroyed) {
      rejectOnce(new PeerUnavailableError("Authenticated owner socket is unavailable."));
      request.destroy();
      channel.socket.destroy();
      return;
    }
    pinnedSocketAssigned = true;
    clearDispatchedDeadline();
  };
  const onFinish = (): void => {
    requestFinished = true;
    clearDispatchedDeadline();
  };
  request = httpRequest({
    host: fixedHost,
    port: fixedPort,
    method: options.method,
    path: options.path,
    agent: channel.agent,
    headers: { ...options.headers, Connection: "keep-alive" },
  }, (response) => {
    const responseSocket = response.socket;
    void (async () => {
      try {
        if (responseSocket !== channel.socket) throw new PeerIncompatibleError("Owner socket changed.");
        const bytes = await readIncomingBytes(response, maximumBytes, signal);
        resolveOnce({ status: response.statusCode ?? 0, headers: response.headers, bytes, socket: channel.socket });
      } catch (error) { rejectOnce(error); }
    })();
  });
  request.once("error", (error) => rejectOnce(
    error instanceof RuntimeOperationError ? error : new PeerUnavailableError(error.message),
  ));
  request.once("socket", onSocket);
  request.once("finish", onFinish);
  deadline = setTimeout(onDeadline, ownerTransportDeadlineMilliseconds);
  signal?.addEventListener("abort", onAbort, { once: true });
  request.end(options.body);
});

const openAuthenticatedOwnerChannel = async (input: {
  readonly ownerStore: RuntimeOwnerStore;
  readonly credential: LocalControlCredentialAuthority;
  readonly runtimeBuildDigest: string;
}, signal?: AbortSignal): Promise<AuthenticatedOwnerChannel> => {
  const channel = await connectPinnedAgent(signal);
  const challenge = createRuntimeIdentityChallenge();
  try {
    const packet = await requestPacket(channel, {
      method: "GET",
      path: "/__identity",
      headers: {
        Host: fixedHostHeader,
        "Littlejohn-Identity-Challenge": challenge,
      },
    }, internalResponseLimitBytes, "response", signal);
    if (
      packet.status !== 200 ||
      packet.headers["content-type"] !== jsonContentType ||
      packet.headers["cache-control"] !== noStoreCacheControl
    ) throw new PeerIncompatibleError("Owner identity request failed.");
    const identity = parseOwnerIdentity(parseCanonicalHttpJson(packet.bytes));
    const profile = input.ownerStore.readProfile();
    const recorded = input.ownerStore.readOwner();
    if (
      identity.challenge !== challenge ||
      identity.profileId !== profile.profileId ||
      identity.runtimeProtocolVersion !== runtimeProtocolVersion ||
      identity.runtimeBuildDigest !== input.runtimeBuildDigest ||
      recorded === undefined ||
      identity.ownerInstanceId !== recorded.ownerInstanceId ||
      identity.ownerRevision !== recorded.ownerRevision
    ) throw new PeerIncompatibleError("Owner identity is incompatible.");
    const { proof, ...identityWithoutProof } = identity;
    if (!verifyControlPayload(input.credential, encodeOwnerProofPayload(identityWithoutProof), proof)) {
      throw new PeerIncompatibleError("Owner identity proof is invalid.");
    }
    return channel;
  } catch (error) {
    channel.close();
    if (error instanceof PeerUnavailableError || error instanceof PeerIncompatibleError || error instanceof RuntimeOperationError) {
      throw error;
    }
    throw new PeerIncompatibleError("Owner identity is invalid.");
  }
};

export interface OwnerOperation {
  readonly method: RouteMethod;
  readonly path: string;
  readonly body?: CanonicalJson;
}

export interface OwnerOperationResponse {
  readonly status: number;
  readonly body: CanonicalJson;
}

const validateOwnerOperation = (operation: OwnerOperation): OwnerOperation => {
  const target = parseRequestTarget(operation.path);
  if (target === undefined || target.query !== "" || !target.pathname.startsWith("/api/v1/internal/cli/")) {
    throw new TypeError("Owner operation path is invalid.");
  }
  if (operation.method === "POST" && operation.body === undefined) {
    throw new TypeError("POST owner operations require a canonical JSON body.");
  }
  if (operation.method !== "POST" && operation.body !== undefined) {
    throw new TypeError("GET and DELETE owner operations cannot contain a body.");
  }
  return Object.freeze({
    method: operation.method,
    path: target.pathname,
    ...(operation.body === undefined ? {} : { body: captureCanonicalJson(operation.body) }),
  });
};

export interface HttpOwnerApplication {
  readonly routes: RuntimeRouteRegistry;
  close(): Promise<void> | void;
}

export interface HttpOwnerApplicationContext {
  readonly routes: RuntimeRouteRegistry;
  readonly signal: AbortSignal;
}

export interface HttpOwnerOptions {
  readonly ownerStore: RuntimeOwnerStore;
  readonly credential: LocalControlCredentialAuthority;
  readonly runtimeBuildDigest: string;
  readonly now: () => UtcTimestamp;
  readonly applicationFactory?: (
    context: HttpOwnerApplicationContext,
  ) => Promise<HttpOwnerApplication> | HttpOwnerApplication;
}

type OwnerPhase = "stopped" | "starting" | "owner" | "deferred" | "stopping";

interface LifecycleWork {
  readonly controller: AbortController;
  readonly completion: Promise<void>;
  readonly finish: () => void;
  generation: number;
}

const createLifecycleWork = (): LifecycleWork => {
  let resolveCompletion!: () => void;
  let finished = false;
  const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
  return {
    controller: new AbortController(),
    completion,
    generation: 0,
    finish(): void {
      if (finished) return;
      finished = true;
      resolveCompletion();
    },
  };
};

export class FixedHttpOwner {
  readonly #ownerStore: RuntimeOwnerStore;
  readonly #credential: LocalControlCredentialAuthority;
  readonly #runtimeBuildDigest: string;
  readonly #now: () => UtcTimestamp;
  readonly #baseRoutes: RuntimeRouteRegistry;
  readonly #applicationFactory: HttpOwnerOptions["applicationFactory"];
  readonly #lifecycleWork = new Set<LifecycleWork>();
  #phase: OwnerPhase = "stopped";
  #generation = 0;
  #lifecycleController: AbortController | undefined;
  #application: HttpOwnerApplication | undefined;
  #routes: RuntimeRouteRegistry;
  #server: Server | undefined;
  #ownerRecord: RuntimeOwnerRecord | undefined;
  #tail: Promise<void> = Promise.resolve();
  #stopRequested = false;
  #stopPromise: Promise<void> | undefined;

  constructor(options: HttpOwnerOptions) {
    this.#ownerStore = options.ownerStore;
    this.#credential = options.credential;
    this.#runtimeBuildDigest = parseRuntimeBuildDigest(options.runtimeBuildDigest);
    this.#now = options.now;
    this.#baseRoutes = createRuntimeRouteRegistry({
      controlVerifier: createControlCredentialVerifier(options.credential),
    });
    this.#routes = this.#baseRoutes;
    this.#applicationFactory = options.applicationFactory;
  }

  get state(): OwnerPhase { return this.#phase; }

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
    const generation = ++this.#generation;
    const lifecycle = new AbortController();
    this.#lifecycleController = lifecycle;
    this.#phase = "starting";
    const server = createServer((request, response) => { void this.#handle(request, response); });
    try {
      await listen(server);
      if (lifecycle.signal.aborted || generation !== this.#generation) throw new RuntimeOperationError("request_aborted");
      this.#server = server;
      const ownerInstanceId = createOwnerInstanceId();
      this.#ownerRecord = this.#ownerStore.publishOwner(ownerInstanceId, parseUtcTimestamp(this.#now()));
      if (this.#applicationFactory !== undefined) {
        const initialization = createLifecycleWork();
        initialization.generation = generation;
        this.#lifecycleWork.add(initialization);
        let returnedApplication: HttpOwnerApplication | undefined;
        const factoryResult = (async () => {
          try {
            const application = await this.#applicationFactory?.({ routes: this.#baseRoutes, signal: lifecycle.signal });
            if (application === undefined) throw new TypeError("HTTP owner application is unavailable.");
            if (
              initialization.controller.signal.aborted ||
              lifecycle.signal.aborted ||
              initialization.generation !== this.#generation
            ) {
              await application.close();
            } else returnedApplication = application;
          } finally {
            this.#finishLifecycleWork(initialization);
          }
        })();
        const aborted = new Promise<never>((_resolve, reject) => {
          lifecycle.signal.addEventListener("abort", () => reject(new RuntimeOperationError("request_aborted")), { once: true });
        });
        try {
          await Promise.race([factoryResult, aborted]);
          if (
            returnedApplication === undefined ||
            lifecycle.signal.aborted ||
            generation !== this.#generation
          ) throw new RuntimeOperationError("request_aborted");
          assertRuntimeRouteRegistryDescendant(this.#baseRoutes, returnedApplication.routes);
          this.#application = returnedApplication;
          this.#routes = returnedApplication.routes;
          returnedApplication = undefined;
        } catch (error) {
          initialization.controller.abort();
          try { await factoryResult; } catch { /* Preserve the startup failure. */ }
          if (returnedApplication !== undefined) {
            try { await returnedApplication.close(); } catch { /* Preserve the startup failure. */ }
          }
          throw error;
        }
      }
      if (lifecycle.signal.aborted || generation !== this.#generation) throw new RuntimeOperationError("request_aborted");
      this.#phase = "owner";
      return "owner";
    } catch (error) {
      if (server.listening || this.#server === server) {
        try { await this.#closeOwnedResources(server, this.#application, generation); } catch { /* Preserve startup failure. */ }
      }
      this.#resetStopped();
      if (error instanceof Error && "code" in error && error.code === "EADDRINUSE") {
        this.#lifecycleController = lifecycle;
        this.#phase = "starting";
        try {
          const channel = await openAuthenticatedOwnerChannel({
            ownerStore: this.#ownerStore,
            credential: this.#credential,
            runtimeBuildDigest: this.#runtimeBuildDigest,
          }, lifecycle.signal);
          channel.close();
          this.#lifecycleController = lifecycle;
          this.#phase = "deferred";
          return "deferred";
        } catch (identityError) {
          this.#resetStopped();
          if (lifecycle.signal.aborted || identityError instanceof RuntimeOperationError &&
            identityError.failure.error.code === "request_aborted") {
            throw new RuntimeOperationError("request_aborted");
          }
          throw new RuntimeOperationError("port_conflict");
        }
      }
      throw error;
    }
  }

  async executeOwnerOperation(operationInput: OwnerOperation): Promise<OwnerOperationResponse> {
    const operation = validateOwnerOperation(operationInput);
    const active = createLifecycleWork();
    let registered = false;
    try {
      await this.#serialize(async () => {
        if (this.#stopRequested) throw new RuntimeOperationError("request_aborted");
        if (this.#phase === "stopped") await this.#startLocked();
        if (this.#phase !== "owner" && this.#phase !== "deferred") {
          throw new RuntimeOperationError("runtime_busy");
        }
        active.generation = this.#generation;
        this.#lifecycleWork.add(active);
        registered = true;
      });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        this.#assertActiveOwnerOperation(active);
        let channel: AuthenticatedOwnerChannel | undefined;
        try {
          channel = await openAuthenticatedOwnerChannel({
            ownerStore: this.#ownerStore,
            credential: this.#credential,
            runtimeBuildDigest: this.#runtimeBuildDigest,
          }, active.controller.signal);
          this.#assertActiveOwnerOperation(active);
          const body = operation.body === undefined ? undefined : `${canonicalJsonStringify(operation.body)}\n`;
          const packet = await requestPacket(channel, {
            method: operation.method,
            path: operation.path,
            headers: {
              Host: fixedHostHeader,
              Authorization: createControlAuthorizationHeader(this.#credential),
              ...(body === undefined ? {} : {
                "Content-Type": jsonContentType,
                "Content-Length": Buffer.byteLength(body),
              }),
            },
            ...(body === undefined ? {} : { body }),
          }, internalResponseLimitBytes, "dispatch", active.controller.signal);
          this.#assertActiveOwnerOperation(active);
          return Object.freeze({ status: packet.status, body: parseCanonicalHttpJson(packet.bytes) });
        } catch (error) {
          if (active.controller.signal.aborted || error instanceof RuntimeOperationError &&
            error.failure.error.code === "request_aborted") {
            throw new RuntimeOperationError("request_aborted");
          }
          if (error instanceof PeerIncompatibleError) throw new RuntimeOperationError("port_conflict");
          if (!(error instanceof PeerUnavailableError) || channel !== undefined || attempt !== 0) {
            throw new RuntimeOperationError("runtime_state_unavailable");
          }
          await this.#serialize(async () => {
            this.#assertActiveOwnerOperation(active);
            if (this.#phase === "deferred") {
              this.#phase = "stopped";
              this.#lifecycleController?.abort();
              await this.#startLocked();
              active.generation = this.#generation;
            }
          });
        } finally { channel?.close(); }
      }
      throw new RuntimeOperationError("runtime_state_unavailable");
    } finally {
      if (registered) {
        this.#finishLifecycleWork(active);
      }
    }
  }

  #assertActiveOwnerOperation(active: LifecycleWork): void {
    if (
      active.controller.signal.aborted ||
      !this.#lifecycleWork.has(active) ||
      active.generation !== this.#generation ||
      (this.#phase !== "owner" && this.#phase !== "deferred")
    ) {
      throw new RuntimeOperationError("request_aborted");
    }
  }

  stop(): Promise<void> {
    if (this.#stopPromise !== undefined) return this.#stopPromise;
    this.#stopRequested = true;
    this.#lifecycleController?.abort();
    for (const work of this.#lifecycleWork) work.controller.abort();
    const stopping = this.#stopInternal();
    const tracked = stopping.finally(() => {
      if (this.#stopPromise === tracked) this.#stopPromise = undefined;
      this.#stopRequested = false;
    });
    this.#stopPromise = tracked;
    return tracked;
  }

  async #stopInternal(): Promise<void> {
    const resources = await this.#serialize(async () => {
      if (this.#phase === "stopped") return undefined;
      this.#phase = "stopping";
      this.#generation += 1;
      for (const work of this.#lifecycleWork) work.controller.abort();
      this.#ownerRecord = undefined;
      return {
        server: this.#server,
        application: this.#application,
        activeCompletions: Object.freeze([...this.#lifecycleWork].map((work) => work.completion)),
      };
    });
    if (resources === undefined) return;
    try {
      await Promise.all(resources.activeCompletions);
      try {
        await resources.application?.close();
      } finally {
        if (resources.server !== undefined) await closeServer(resources.server);
      }
    } finally {
      await this.#serialize(async () => { this.#resetStopped(); });
    }
  }

  async #closeOwnedResources(
    server: Server,
    application: HttpOwnerApplication | undefined,
    generation: number,
  ): Promise<void> {
    const work = [...this.#lifecycleWork].filter((active) => active.generation === generation);
    for (const active of work) active.controller.abort();
    await Promise.all(work.map((active) => active.completion));
    try { await application?.close(); }
    finally { await closeServer(server); }
  }

  #finishLifecycleWork(work: LifecycleWork): void {
    this.#lifecycleWork.delete(work);
    work.finish();
  }

  #resetStopped(): void {
    this.#phase = "stopped";
    this.#lifecycleController = undefined;
    this.#application = undefined;
    this.#routes = this.#baseRoutes;
    this.#server = undefined;
    this.#ownerRecord = undefined;
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.#stopRequested) {
      writeFailure(response, "request_aborted", this.#routes);
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
      const target = parseRequestTarget(request.url);
      if (target === undefined) return writeFailure(response, "invalid_input");
      if (target.pathname === "/__identity") await this.#handleIdentity(request, response, target);
      else await this.#handleApplicationRoute(request, response, target, work.controller.signal);
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
      requestClass: "owner_identity",
      host: headerValues(request, "host"),
      origin: headerValues(request, "origin"),
      authorization: headerValues(request, "authorization"),
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
      runtimeProtocolVersion,
      runtimeBuildDigest: this.#runtimeBuildDigest,
      challenge,
      ownerRevision: owner.ownerRevision,
    };
    const unsignedIdentity = parseUnsignedOwnerIdentity(identityWithoutProof);
    const identity = parseOwnerIdentity({
      ...unsignedIdentity,
      proof: signControlPayload(this.#credential, encodeOwnerProofPayload(unsignedIdentity)),
    });
    writeJson(response, 200, identity as unknown as CanonicalJson);
  }

  async #handleApplicationRoute(
    request: IncomingMessage,
    response: ServerResponse,
    target: RequestTarget,
    signal: AbortSignal,
  ): Promise<void> {
    const bodyLength = readBodySize(request);
    const envelopeSecurity = validateRequestEnvelopeSecurity({
      host: headerValues(request, "host"),
      query: target.query,
      bodyLength,
    });
    if (!envelopeSecurity.ok) return writeFailure(response, envelopeSecurity.code, this.#routes);
    if (this.#phase !== "owner") return writeFailure(response, "runtime_busy", this.#routes);
    const match = this.#routes.match(request.method, target.pathname);
    if (match.status === "not_found") return writeFailure(response, "route_not_found", this.#routes);
    if (match.status === "method_not_allowed") {
      const classSecurity = this.#routes.validateRequestClass(match.route, {
        origin: headerValues(request, "origin"),
        authorization: headerValues(request, "authorization"),
      });
      if (!classSecurity.ok) return writeFailure(response, classSecurity.code, this.#routes);
      response.setHeader("Allow", match.allow.join(", "));
      return writeFailure(response, "method_not_allowed", this.#routes);
    }
    const security = this.#routes.validateSecurity(match.route, {
      host: headerValues(request, "host"),
      origin: headerValues(request, "origin"),
      authorization: headerValues(request, "authorization"),
      contentType: headerValues(request, "content-type"),
      query: target.query,
      bodyLength,
    });
    if (!security.ok) return writeFailure(response, security.code, this.#routes);

    let body: unknown = {};
    if (match.route.acceptsBody) {
      try {
        const bytes = await readIncomingBytes(request, requestBodyLimitBytes, signal);
        if (bytes.length !== bodyLength || bytes.length === 0) throw new TypeError("Request body length is invalid.");
        body = JSON.parse(fatalUtf8(bytes)) as unknown;
      } catch (error) {
        const code = error instanceof RuntimeOperationError ? error.failure.error.code : "invalid_json";
        return writeFailure(response, code, this.#routes);
      }
    }
    if (signal.aborted) return;
    let result;
    try {
      result = this.#routes.normalizeResult(
        match.route,
        await match.route.handler({ params: match.params, body, signal }),
      );
    }
    catch { return writeFailure(response, signal.aborted ? "request_aborted" : "internal_error", this.#routes); }
    if (signal.aborted) return;
    if (!result.ok) {
      return writeJson(response, result.problem.status, result.problem as unknown as CanonicalJson);
    }
    writeJson(response, match.route.successStatus, result.body, match.route.responseLimitBytes);
  }
}
