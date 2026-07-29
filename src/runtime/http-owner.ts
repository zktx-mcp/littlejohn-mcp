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
import type { RuntimeApplicationContext } from "./application-context.js";
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
  routeMethods,
  runtimeIdentityPath,
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
  localControlRequestClass,
  ownerIdentityRequestClass,
  publicReadRequestClass,
  runtimeDispatchRequestClasses,
  validateRequestEnvelopeSecurity,
  validateRequestSecurity,
  type RuntimeDispatchRequestClass,
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
  parseRuntimeIdentityChallenge,
  parseUnsignedOwnerIdentity,
  runtimeProtocolVersion,
  type RuntimeConfigurationMac,
} from "./runtime-identity.js";
import type {
  RuntimeOwnerSession,
  RuntimeOwnerSessionIdentity,
  RuntimeOwnerSessionRequest,
} from "./owner-session.js";

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

const parseHttpJson = (bytes: Uint8Array): CanonicalJson =>
  captureCanonicalJson(JSON.parse(fatalUtf8(bytes)) as unknown);

class PeerUnavailableError extends Error {}
class PeerIncompatibleError extends Error {}
class OwnerRequestInterruptedError extends Error {
  constructor(
    readonly sendBegan: boolean,
    readonly reason: "request_aborted" | "owner_unavailable",
  ) {
    super(reason);
  }
}
const ownerTransportDeadlineMilliseconds = 2_000;
type RequestDeadlineBoundary = "response" | "dispatch" | "delivery";

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

interface AuthenticatedOwnerConnection {
  readonly channel: AuthenticatedOwnerChannel;
  readonly identity: RuntimeOwnerSessionIdentity;
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
  responseDeadlineMilliseconds?: number,
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
  const advanceDeadlineAfterWrite = (): void => {
    if (!pinnedSocketAssigned || !requestFinished || deadline === undefined) return;
    if (deadlineBoundary === "dispatch") {
      clearTimeout(deadline);
      deadline = undefined;
      return;
    }
    if (deadlineBoundary === "delivery") {
      clearTimeout(deadline);
      deadline = setTimeout(onDeadline, responseDeadlineMilliseconds);
    }
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
    rejectOnce(deadlineBoundary === "delivery"
      ? new OwnerRequestInterruptedError(pinnedSocketAssigned, "request_aborted")
      : new RuntimeOperationError("request_aborted"));
    request.destroy();
    channel.socket.destroy();
  };
  const onDeadline = (): void => {
    rejectOnce(deadlineBoundary === "delivery"
      ? new OwnerRequestInterruptedError(pinnedSocketAssigned, "owner_unavailable")
      : new PeerUnavailableError("Owner request timed out."));
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
    advanceDeadlineAfterWrite();
  };
  const onFinish = (): void => {
    requestFinished = true;
    advanceDeadlineAfterWrite();
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
      } catch (error) {
        rejectOnce(deadlineBoundary === "delivery"
          ? new OwnerRequestInterruptedError(true, "owner_unavailable")
          : error);
      }
    })();
  });
  request.once("error", (error) => rejectOnce(deadlineBoundary === "delivery"
    ? new OwnerRequestInterruptedError(pinnedSocketAssigned, error.name === "AbortError"
      ? "request_aborted"
      : "owner_unavailable")
    : error instanceof RuntimeOperationError ? error : new PeerUnavailableError(error.message)));
  request.once("socket", onSocket);
  request.once("finish", onFinish);
  deadline = setTimeout(onDeadline, ownerTransportDeadlineMilliseconds);
  signal?.addEventListener("abort", onAbort, { once: true });
  request.end(options.body);
});

const openAuthenticatedOwnerChannel = async (input: {
  readonly ownerStore: RuntimeOwnerStore;
  readonly credential: LocalControlCredentialAuthority;
  readonly configurationMac: RuntimeConfigurationMac;
}, signal?: AbortSignal): Promise<AuthenticatedOwnerConnection> => {
  const channel = await connectPinnedAgent(signal);
  const challenge = createRuntimeIdentityChallenge();
  try {
    const packet = await requestPacket(channel, {
      method: "GET",
      path: runtimeIdentityPath,
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
    const identity = parseOwnerIdentity(parseHttpJson(packet.bytes));
    const profile = input.ownerStore.readProfile();
    const recorded = input.ownerStore.readOwner();
    if (
      identity.challenge !== challenge ||
      identity.profileId !== profile.profileId ||
      identity.runtimeProtocolVersion !== runtimeProtocolVersion ||
      identity.configurationMac !== input.configurationMac ||
      recorded === undefined ||
      identity.ownerInstanceId !== recorded.ownerInstanceId ||
      recorded.protocolVersion !== identity.runtimeProtocolVersion ||
      recorded.configurationMac !== input.configurationMac ||
      identity.ownerRevision !== recorded.ownerRevision
    ) throw new PeerIncompatibleError("Owner identity is incompatible.");
    const { proof, ...identityWithoutProof } = identity;
    if (!verifyControlPayload(input.credential, encodeOwnerProofPayload(identityWithoutProof), proof)) {
      throw new PeerIncompatibleError("Owner identity proof is invalid.");
    }
    return Object.freeze({
      channel,
      identity: Object.freeze({
        profileId: identity.profileId,
        ownerInstanceId: identity.ownerInstanceId,
        runtimeProtocolVersion: identity.runtimeProtocolVersion,
        configurationMac: identity.configurationMac,
        ownerRevision: identity.ownerRevision,
      }),
    });
  } catch (error) {
    channel.close();
    if (error instanceof PeerUnavailableError || error instanceof PeerIncompatibleError || error instanceof RuntimeOperationError) {
      throw error;
    }
    throw new PeerIncompatibleError("Owner identity is invalid.");
  }
};

export type { RuntimeDispatchRequestClass };

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
  if (!runtimeDispatchRequestClasses.includes(request.requestClass as RuntimeDispatchRequestClass)) {
    throw new TypeError("Runtime dispatch request class is invalid.");
  }
  if (request.method === "POST" && request.body === undefined) {
    throw new TypeError("POST runtime dispatch requests require a canonical JSON body.");
  }
  if (request.method !== "POST" && request.body !== undefined) {
    throw new TypeError("GET and DELETE runtime dispatch requests cannot contain a body.");
  }
  if (!routeMethods.includes(request.method)) {
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

export interface HttpOwnerOptions {
  readonly ownerStore: RuntimeOwnerStore;
  readonly credential: LocalControlCredentialAuthority;
  readonly configurationMac: RuntimeConfigurationMac;
  readonly now: () => UtcTimestamp;
  readonly onPortOwnershipAcquired: () => Promise<void> | void;
  readonly applicationFactory?: (
    context: RuntimeApplicationContext,
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
  readonly #configurationMac: RuntimeConfigurationMac;
  readonly #now: () => UtcTimestamp;
  readonly #onPortOwnershipAcquired: HttpOwnerOptions["onPortOwnershipAcquired"];
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
    this.#configurationMac = options.configurationMac;
    this.#now = options.now;
    this.#onPortOwnershipAcquired = options.onPortOwnershipAcquired;
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
          const connection = await openAuthenticatedOwnerChannel({
            ownerStore: this.#ownerStore,
            credential: this.#credential,
            configurationMac: this.#configurationMac,
          }, lifecycle.signal);
          connection.channel.close();
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
      return "owner";
    } catch (error) {
      this.#beginStoppingLocked();
      try {
        await Promise.all([...this.#lifecycleWork].map((work) => work.completion));
        startupResources.seal();
        await this.#closeApplicationResources();
        await this.#closeServerResource();
        this.#resetStopped();
      } catch (cleanupError) {
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
      for (let attempt = 0; attempt < 2; attempt += 1) {
        this.#assertActiveRuntimeDispatch(active);
        let connection: AuthenticatedOwnerConnection | undefined;
        try {
          connection = await openAuthenticatedOwnerChannel({
            ownerStore: this.#ownerStore,
            credential: this.#credential,
            configurationMac: this.#configurationMac,
          }, active.controller.signal);
          this.#assertActiveRuntimeDispatch(active);
          const body = request.body === undefined ? undefined : `${canonicalJsonStringify(request.body)}\n`;
          const packet = await requestPacket(connection.channel, {
            method: request.method,
            path: request.path,
            headers: {
              Host: fixedHostHeader,
              ...(request.requestClass === localControlRequestClass
                ? { Authorization: createControlAuthorizationHeader(this.#credential) }
                : {}),
              ...(body === undefined ? {} : {
                "Content-Type": jsonContentType,
                "Content-Length": Buffer.byteLength(body),
              }),
            },
            ...(body === undefined ? {} : { body }),
          }, request.requestClass === publicReadRequestClass
            ? publicReadResponseLimitBytes
            : internalResponseLimitBytes, "dispatch", active.controller.signal);
          this.#assertActiveRuntimeDispatch(active);
          return Object.freeze({ status: packet.status, body: parseHttpJson(packet.bytes) });
        } catch (error) {
          if (active.controller.signal.aborted || error instanceof RuntimeOperationError &&
            error.failure.error.code === "request_aborted") {
            throw new RuntimeOperationError("request_aborted");
          }
          if (error instanceof PeerIncompatibleError) throw new RuntimeOperationError("port_conflict");
          if (!(error instanceof PeerUnavailableError) || connection !== undefined || attempt !== 0) {
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
        } finally { connection?.channel.close(); }
      }
      throw new RuntimeOperationError("runtime_state_unavailable");
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
      connection = await openAuthenticatedOwnerChannel({
        ownerStore: this.#ownerStore,
        credential: this.#credential,
        configurationMac: this.#configurationMac,
      }, active.controller.signal);
      this.#assertActiveRuntimeDispatch(active);
      const captured = connection;
      const credential = this.#credential;
      let closed = false;
      let sending = false;
      const close = (): void => {
        if (closed) return;
        closed = true;
        active.controller.abort();
        captured.channel.close();
        signal?.removeEventListener("abort", abort);
        this.#finishLifecycleWork(active);
      };
      const session: RuntimeOwnerSession = {
        identity: captured.identity,
        get usable(): boolean {
          return !closed && !captured.channel.socket.destroyed;
        },
        async send(requestInput: RuntimeOwnerSessionRequest, callerSignal?: AbortSignal) {
          if (closed || sending) return Object.freeze({
            status: "request_not_sent" as const,
            reason: "owner_unavailable" as const,
          });
          if (
            !Number.isSafeInteger(requestInput.maximumResponseBytes) ||
            requestInput.maximumResponseBytes < 1 ||
            !Number.isSafeInteger(requestInput.responseDeadlineMilliseconds) ||
            requestInput.responseDeadlineMilliseconds < 1
          ) throw new TypeError("Owner session request limits are invalid.");
          const request = validateRuntimeDispatchRequest({
            requestClass: localControlRequestClass,
            method: requestInput.method,
            path: requestInput.path,
            ...(requestInput.body === undefined ? {} : { body: requestInput.body }),
          });
          if (callerSignal?.aborted === true) return Object.freeze({
            status: "request_not_sent" as const,
            reason: "request_aborted" as const,
          });
          sending = true;
          const combinedSignal = callerSignal === undefined
            ? active.controller.signal
            : AbortSignal.any([active.controller.signal, callerSignal]);
          try {
            const body = request.body === undefined ? undefined : `${canonicalJsonStringify(request.body)}\n`;
            const packet = await requestPacket(captured.channel, {
              method: request.method,
              path: request.path,
              headers: {
                Host: fixedHostHeader,
                Authorization: createControlAuthorizationHeader(credential),
                ...(body === undefined ? {} : {
                  "Content-Type": jsonContentType,
                  "Content-Length": Buffer.byteLength(body),
                }),
              },
              ...(body === undefined ? {} : { body }),
            }, requestInput.maximumResponseBytes, "delivery", combinedSignal,
            requestInput.responseDeadlineMilliseconds);
            return Object.freeze({
              status: "response_received" as const,
              response: Object.freeze({
                statusCode: packet.status,
                contentType: packet.headers["content-type"],
                cacheControl: packet.headers["cache-control"],
                bytes: Uint8Array.from(packet.bytes),
              }),
            });
          } catch (error) {
            if (error instanceof OwnerRequestInterruptedError) {
              return error.sendBegan
                ? Object.freeze({ status: "response_unavailable_after_send_began" as const })
                : Object.freeze({ status: "request_not_sent" as const, reason: error.reason });
            }
            return Object.freeze({
              status: "request_not_sent" as const,
              reason: combinedSignal.aborted
                ? "request_aborted" as const
                : "owner_unavailable" as const,
            });
          } finally {
            sending = false;
          }
        },
        close,
      };
      connection = undefined;
      admitted = false;
      return Object.freeze(session);
    } catch (error) {
      connection?.channel.close();
      if (error instanceof PeerIncompatibleError) throw new RuntimeOperationError("port_conflict");
      if (error instanceof RuntimeOperationError) throw error;
      throw new RuntimeOperationError(active.controller.signal.aborted
        ? "request_aborted"
        : "runtime_state_unavailable");
    } finally {
      signal?.removeEventListener("abort", abort);
      if (admitted) this.#finishLifecycleWork(active);
    }
  }

  async #admitRuntimeClient(active: LifecycleWork): Promise<void> {
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
    });
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
      if (target.pathname === runtimeIdentityPath) await this.#handleIdentity(request, response, target);
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
      requestClass: ownerIdentityRequestClass,
      params: Object.freeze({}),
      host: headerValues(request, "host"),
      origin: headerValues(request, "origin"),
      authorization: headerValues(request, "authorization"),
      cookie: headerValues(request, "cookie"),
      csrfToken: headerValues(request, browserCsrfHeaderKey),
      contentType: headerValues(request, "content-type"),
      query: target.query,
      queryMode: "none",
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
      configurationMac: owner.configurationMac,
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
      bodyLength,
    });
    if (!envelopeSecurity.ok) return writeFailure(response, envelopeSecurity.code, this.#routes);
    if (this.#phase !== "owner") return writeFailure(response, "runtime_busy", this.#routes);
    const match = this.#routes.match(request.method, target.pathname);
    if (match.status === "not_found") return writeFailure(response, "route_not_found", this.#routes);
    if (match.status === "method_not_allowed") {
      if (target.query !== "") {
        return writeFailure(response, "query_not_supported", this.#routes);
      }
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
        await match.route.handler({
          params: match.params,
          query: target.query,
          body,
          signal,
        }),
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
