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
import { browserCsrfHeaderName } from "../interfaces/browser-contract.js";
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
  browserContentSecurityPolicy,
  browserContentTypeOptions,
  browserCrossOriginOpenerPolicy,
  browserReferrerPolicy,
  fixedHost,
  fixedHostHeader,
  fixedPort,
  internalResponseLimitBytes,
  jsonContentType,
  noStoreCacheControl,
  parseRequestTarget,
  problemJsonContentType,
  publicReadResponseLimitBytes,
  requestBodyLimitBytes,
  type BrowserContentType,
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
  createResourceOwnershipScope,
  type OwnedResource,
  type OwnedResourceRegistration,
  type OwnedResourceRegistry,
  type ResourceOwnershipScope,
} from "./resource-ownership.js";
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

const browserCsrfHeaderKey = browserCsrfHeaderName.toLowerCase();

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

const writeBrowserContent = (
  response: ServerResponse,
  status: number,
  body: string,
  contentType: BrowserContentType,
  maximumBytes: number,
  setCookie?: string,
): void => {
  if (response.destroyed || response.writableEnded) return;
  const length = Buffer.byteLength(body);
  if (length > maximumBytes) throw new Error("HTTP response exceeds its size limit.");
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Content-Length": String(length),
    "Cache-Control": noStoreCacheControl,
    "Content-Security-Policy": browserContentSecurityPolicy,
    "X-Content-Type-Options": browserContentTypeOptions,
    "Referrer-Policy": browserReferrerPolicy,
    "Cross-Origin-Opener-Policy": browserCrossOriginOpenerPolicy,
  };
  if (setCookie !== undefined) headers["Set-Cookie"] = setCookie;
  response.writeHead(status, headers);
  response.end(body);
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
      path: "/api/v1/runtime-identity",
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

export type RuntimeDispatchRequestClass = "local_control" | "public_read";

export interface RuntimeDispatchRequest {
  readonly requestClass: RuntimeDispatchRequestClass;
  readonly method: RouteMethod;
  readonly path: string;
  readonly body?: CanonicalJson;
  readonly signal?: AbortSignal;
}

export interface RuntimeDispatchResponse {
  readonly status: number;
  readonly body: CanonicalJson;
}

const validateRuntimeDispatchRequest = (request: RuntimeDispatchRequest): RuntimeDispatchRequest => {
  const target = parseRequestTarget(request.path);
  if (target === undefined || target.query !== "") {
    throw new TypeError("Runtime dispatch path is invalid.");
  }
  if (request.requestClass !== "local_control" && request.requestClass !== "public_read") {
    throw new TypeError("Runtime dispatch request class is invalid.");
  }
  if (request.method === "POST" && request.body === undefined) {
    throw new TypeError("POST runtime dispatch requests require a canonical JSON body.");
  }
  if (request.method !== "POST" && request.body !== undefined) {
    throw new TypeError("GET and DELETE runtime dispatch requests cannot contain a body.");
  }
  if (request.method !== "GET" && request.method !== "POST" && request.method !== "DELETE") {
    throw new TypeError("Runtime dispatch method is invalid.");
  }
  if (request.signal !== undefined && !(request.signal instanceof AbortSignal)) {
    throw new TypeError("Runtime dispatch signal is invalid.");
  }
  return Object.freeze({
    requestClass: request.requestClass,
    method: request.method,
    path: target.pathname,
    ...(request.body === undefined ? {} : { body: captureCanonicalJson(request.body) }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
};

export interface HttpOwnerApplication {
  readonly routes: RuntimeRouteRegistry;
  close(): Promise<void> | void;
}

export type HttpOwnerStartupResource = OwnedResource;
export type HttpOwnerStartupResourceRegistration = OwnedResourceRegistration;
export type HttpOwnerStartupResourceRegistry = OwnedResourceRegistry;
export type HttpOwnerStartupResourceScope = ResourceOwnershipScope;

export interface HttpOwnerApplicationContext {
  readonly routes: RuntimeRouteRegistry;
  readonly signal: AbortSignal;
  readonly startupResources: HttpOwnerStartupResourceRegistry;
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

const ownerReleasePermitBrand: unique symbol = Symbol("littlejohn.http-owner-release-permit");

export interface HttpOwnerReleasePermit {
  readonly generation: number;
  readonly [ownerReleasePermitBrand]: FixedHttpOwner;
}

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
  #startupResources: HttpOwnerStartupResourceScope | undefined;
  #routes: RuntimeRouteRegistry;
  #server: Server | undefined;
  #ownerRecord: RuntimeOwnerRecord | undefined;
  #tail: Promise<void> = Promise.resolve();
  #stopRequested = false;
  #stopPromise: Promise<void> | undefined;
  #closeApplicationPromise: Promise<HttpOwnerReleasePermit> | undefined;
  #releaseListenerPromise: Promise<void> | undefined;
  #releaseListenerPermit: HttpOwnerReleasePermit | undefined;
  #releasePermit: HttpOwnerReleasePermit | undefined;
  #releaseScope: HttpOwnerStartupResourceScope | undefined;

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
    const startupResources = createResourceOwnershipScope();
    this.#lifecycleController = lifecycle;
    this.#startupResources = startupResources;
    this.#phase = "starting";
    const server = createServer((request, response) => { void this.#handle(request, response); });
    try {
      await listen(server);
    } catch (error) {
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

    this.#server = server;
    try {
      if (lifecycle.signal.aborted || generation !== this.#generation) throw new RuntimeOperationError("request_aborted");
      const ownerInstanceId = createOwnerInstanceId();
      this.#ownerRecord = this.#ownerStore.publishOwner(ownerInstanceId, parseUtcTimestamp(this.#now()));
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
      return "owner";
    } catch (error) {
      this.#beginStoppingLocked();
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
      await this.#serialize(async () => {
        if (this.#stopRequested || active.controller.signal.aborted) {
          throw new RuntimeOperationError("request_aborted");
        }
        if (this.#phase === "stopped") await this.#startLocked();
        if (this.#phase !== "owner" && this.#phase !== "deferred") {
          throw new RuntimeOperationError("runtime_busy");
        }
        active.generation = this.#generation;
        this.#lifecycleWork.add(active);
        registered = true;
      });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        this.#assertActiveRuntimeDispatch(active);
        let channel: AuthenticatedOwnerChannel | undefined;
        try {
          channel = await openAuthenticatedOwnerChannel({
            ownerStore: this.#ownerStore,
            credential: this.#credential,
            runtimeBuildDigest: this.#runtimeBuildDigest,
          }, active.controller.signal);
          this.#assertActiveRuntimeDispatch(active);
          const body = request.body === undefined ? undefined : `${canonicalJsonStringify(request.body)}\n`;
          const packet = await requestPacket(channel, {
            method: request.method,
            path: request.path,
            headers: {
              Host: fixedHostHeader,
              ...(request.requestClass === "local_control"
                ? { Authorization: createControlAuthorizationHeader(this.#credential) }
                : {}),
              ...(body === undefined ? {} : {
                "Content-Type": jsonContentType,
                "Content-Length": Buffer.byteLength(body),
              }),
            },
            ...(body === undefined ? {} : { body }),
          }, request.requestClass === "public_read"
            ? publicReadResponseLimitBytes
            : internalResponseLimitBytes, "dispatch", active.controller.signal);
          this.#assertActiveRuntimeDispatch(active);
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
            this.#assertActiveRuntimeDispatch(active);
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
      request.signal?.removeEventListener("abort", abort);
      if (registered) {
        this.#finishLifecycleWork(active);
      }
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

  stop(): Promise<void> {
    if (this.#stopPromise !== undefined) return this.#stopPromise;
    let resolveTracked!: () => void;
    let rejectTracked!: (error: unknown) => void;
    const tracked = new Promise<void>((resolve, reject) => {
      resolveTracked = resolve;
      rejectTracked = reject;
    });
    this.#stopPromise = tracked;
    void (async () => {
      try {
        const permit = await this.closeApplication();
        await this.releaseListener(permit);
        resolveTracked();
      } catch (error) {
        rejectTracked(error);
      } finally {
        if (this.#stopPromise === tracked) this.#stopPromise = undefined;
      }
    })();
    return tracked;
  }

  closeApplication(): Promise<HttpOwnerReleasePermit> {
    if (this.#closeApplicationPromise !== undefined) return this.#closeApplicationPromise;
    let resolveTracked!: (permit: HttpOwnerReleasePermit) => void;
    let rejectTracked!: (error: unknown) => void;
    const tracked = new Promise<HttpOwnerReleasePermit>((resolve, reject) => {
      resolveTracked = resolve;
      rejectTracked = reject;
    });
    this.#closeApplicationPromise = tracked;
    this.#stopRequested = true;
    this.#lifecycleController?.abort();
    for (const work of this.#lifecycleWork) work.controller.abort();
    void this.#closeApplicationForRelease().then(
      (permit) => {
        if (this.#closeApplicationPromise === tracked) this.#closeApplicationPromise = undefined;
        resolveTracked(permit);
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

  async #closeApplicationForRelease(): Promise<HttpOwnerReleasePermit> {
    const completions = await this.#serialize(async () => {
      if (this.#phase === "stopped") return undefined;
      this.#beginStoppingLocked();
      return Object.freeze([...this.#lifecycleWork].map((work) => work.completion));
    });
    if (completions !== undefined) {
      await Promise.all(completions);
      this.#startupResources?.seal();
      await this.#closeApplicationResources();
    }
    return this.#serialize(async () => {
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

  #beginStoppingLocked(): void {
    this.#stopRequested = true;
    if (this.#phase !== "stopping") {
      this.#phase = "stopping";
      this.#generation += 1;
      this.#releasePermit = undefined;
      this.#releaseScope = undefined;
    }
    this.#lifecycleController?.abort();
    for (const work of this.#lifecycleWork) work.controller.abort();
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

  #resetStopped(): void {
    this.#phase = "stopped";
    this.#lifecycleController = undefined;
    this.#application = undefined;
    this.#startupResources = undefined;
    this.#routes = this.#baseRoutes;
    this.#server = undefined;
    this.#ownerRecord = undefined;
    this.#releasePermit = undefined;
    this.#releaseScope = undefined;
    this.#stopRequested = false;
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
      if (target.pathname === "/api/v1/runtime-identity") await this.#handleIdentity(request, response, target);
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
      params: Object.freeze({}),
      host: headerValues(request, "host"),
      origin: headerValues(request, "origin"),
      authorization: headerValues(request, "authorization"),
      cookie: headerValues(request, "cookie"),
      csrfToken: headerValues(request, browserCsrfHeaderKey),
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
      const classSecurity = this.#routes.validateMethodRejection(match, {
        origin: headerValues(request, "origin"),
        authorization: headerValues(request, "authorization"),
        cookie: headerValues(request, "cookie"),
        csrfToken: headerValues(request, browserCsrfHeaderKey),
      });
      if (!classSecurity.ok) return writeFailure(response, classSecurity.code, this.#routes);
      response.setHeader("Allow", match.allow.join(", "));
      return writeFailure(response, "method_not_allowed", this.#routes);
    }
    const security = this.#routes.validateSecurity(match, {
      host: headerValues(request, "host"),
      origin: headerValues(request, "origin"),
      authorization: headerValues(request, "authorization"),
      cookie: headerValues(request, "cookie"),
      csrfToken: headerValues(request, browserCsrfHeaderKey),
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
    if (result.response === "canonical_json") {
      writeJson(response, match.route.successStatus, result.body, match.route.responseLimitBytes);
    } else {
      writeBrowserContent(
        response,
        match.route.successStatus,
        result.body,
        result.contentType,
        match.route.responseLimitBytes,
        result.setCookie,
      );
    }
  }
}
