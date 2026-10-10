import { isRuntimeManagementRequest } from "./management-contract.js";
import { Agent, request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { connect as connectSocket, type Socket } from "node:net";
import { randomInt } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { canonicalJsonStringify, captureCanonicalJson, type CanonicalJson } from "../core/index.js";
import { createControlAuthorizationHeader, verifyControlPayload, type LocalControlCredentialAuthority } from "./control-credential.js";
import type { RuntimeOwnerStore } from "./database.js";
import { RuntimeOperationError } from "./errors.js";
import { fixedHost, fixedHostHeader, fixedPort, jsonContentType, noStoreCacheControl, parseRequestTarget, routeMethods, runtimeIdentityPath, type RuntimeHttpRequest } from "./http-boundary.js";
import { internalResponseLimitBytes, publicReadResponseLimitBytes, ownerContentionDeadlineMilliseconds, ownerRetryMinimumDelayMilliseconds, ownerRetryDelayGrowth, ownerTransportDeadlineMilliseconds } from "./http-limits.js";
import type { RouteMethod } from "./http-routing.js";
import { localControlRequestClass, publicReadRequestClass, runtimeDispatchRequestClasses, type RuntimeDispatchRequestClass } from "./request-security.js";
import { createRuntimeIdentityChallenge, encodeOwnerProofPayload, parseOwnerIdentity, type RuntimeConfigurationMac, type OwnerIdentity } from "./runtime-identity.js";
import type { RuntimeOwnerSession, RuntimeOwnerSessionIdentity, RuntimeOwnerSessionRequest } from "./owner-session.js";

export const fatalUtf8 = (bytes: Uint8Array): string =>
  new TextDecoder("utf-8", { fatal: true }).decode(bytes);

export const readIncomingBytes = async (
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

export const parseHttpJson = (bytes: Uint8Array): CanonicalJson =>
  captureCanonicalJson(JSON.parse(fatalUtf8(bytes)) as unknown);

export class PeerUnavailableError extends Error {
  constructor(message: string, readonly refused = false) { super(message); }
}
export class PeerIncompatibleError extends Error {}
export class OwnerRequestInterruptedError extends Error {
  constructor(
    readonly sendBegan: boolean,
    readonly reason: "request_aborted" | "owner_unavailable",
  ) {
    super(reason);
  }
}
type RequestDeadlineBoundary = "response" | "dispatch" | "delivery";

export interface ResponsePacket {
  readonly status: number;
  readonly headers: IncomingMessage["headers"];
  readonly bytes: Uint8Array;
  readonly socket: Socket;
}

export interface AuthenticatedOwnerChannel {
  readonly agent: Agent;
  readonly socket: Socket;
  close(): Promise<void>;
}

export interface AuthenticatedOwnerConnection {
  readonly channel: AuthenticatedOwnerChannel;
  readonly identity: RuntimeOwnerSessionIdentity;
  readonly ownerIdentity: OwnerIdentity;
  readonly ready: boolean;
}

export class OwnerContention {
  readonly controller = new AbortController();
  #deadline: number | undefined;
  #timer: NodeJS.Timeout | undefined;
  #retryIndex = 0;

  begin(): void {
    if (this.#deadline !== undefined) return;
    this.#deadline = performance.now() + ownerContentionDeadlineMilliseconds;
    this.#timer = setTimeout(() => this.controller.abort(), ownerContentionDeadlineMilliseconds);
  }

  assertAvailable(): void {
    if (this.controller.signal.aborted || this.#deadline !== undefined && performance.now() >= this.#deadline) {
      throw new RuntimeOperationError("runtime_state_unavailable");
    }
  }

  async wait(signal: AbortSignal): Promise<void> {
    this.begin();
    this.assertAvailable();
    const minimum = ownerRetryMinimumDelayMilliseconds * ownerRetryDelayGrowth ** this.#retryIndex;
    const remaining = (this.#deadline as number) - performance.now();
    const waiting = minimum >= remaining
      ? remaining
      : randomInt(minimum, minimum * ownerRetryDelayGrowth);
    const notBefore = Math.min(performance.now() + waiting, this.#deadline as number);
    const combined = AbortSignal.any([signal, this.controller.signal]);
    do {
      await delay(Math.max(ownerRetryMinimumDelayMilliseconds, notBefore - performance.now()), undefined, { signal: combined });
      this.assertAvailable();
    } while (performance.now() < notBefore);
    this.#retryIndex += 1;
  }

  close(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  end(): void {
    this.close();
    this.#deadline = undefined;
  }
}

export const connectPinnedAgent = async (signal?: AbortSignal): Promise<AuthenticatedOwnerChannel> => {
  if (signal?.aborted === true) throw new RuntimeOperationError("request_aborted");
  const socket = connectSocket({ host: fixedHost, port: fixedPort });
  const socketClosed = new Promise<void>((resolveClose) => socket.once("close", () => resolveClose()));
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
      if (socket.localAddress === socket.remoteAddress && socket.localPort === socket.remotePort) {
        // Linux can assign the absent listener's port to this client and
        // connect it to itself. Reset it before takeover so TIME_WAIT cannot
        // retain the server port; no identity or application request is sent.
        socket.once("close", () => {
          cleanup();
          reject(new PeerUnavailableError("Owner connection returned to its own endpoint."));
        });
        socket.resetAndDestroy();
        return;
      }
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
  }).catch(async (error) => {
    socket.destroy();
    await socketClosed;
    if (error instanceof RuntimeOperationError) throw error;
    throw new PeerUnavailableError(error instanceof Error ? error.message : "Owner connection failed.",
      error instanceof Error && "code" in error && error.code === "ECONNREFUSED");
  });
  socket.setNoDelay(true);
  const agent = new Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
  agent.createConnection = (() => socket) as typeof agent.createConnection;
  return {
    agent,
    socket,
    async close(): Promise<void> {
      agent.destroy();
      socket.destroy();
      await socketClosed;
    },
  };
};

export const requestPacket = (
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
  const receivedBeforeRequest = channel.socket.bytesRead;
  const identityResponseStarted = (): boolean =>
    deadlineBoundary === "response" && channel.socket.bytesRead > receivedBeforeRequest;
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
      : identityResponseStarted()
        ? new PeerIncompatibleError("Owner identity response is incomplete.")
        : new RuntimeOperationError("request_aborted"));
    request.destroy();
    channel.socket.destroy();
  };
  const onDeadline = (): void => {
    rejectOnce(deadlineBoundary === "delivery"
      ? new OwnerRequestInterruptedError(pinnedSocketAssigned, "owner_unavailable")
      : identityResponseStarted()
        ? new PeerIncompatibleError("Owner identity response is incomplete.")
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
          : deadlineBoundary === "response" && !(error instanceof RuntimeOperationError &&
              error.failure.error.code === "request_aborted")
            ? new PeerIncompatibleError("Owner identity response is invalid.")
            : error);
      }
    })();
  });
  request.once("error", (error) => rejectOnce(deadlineBoundary === "delivery"
    ? new OwnerRequestInterruptedError(pinnedSocketAssigned, error.name === "AbortError"
      ? "request_aborted"
      : "owner_unavailable")
    : error instanceof RuntimeOperationError ? error
      : identityResponseStarted() || deadlineBoundary === "response" &&
        "code" in error && typeof error.code === "string" && error.code.startsWith("HPE_")
        ? new PeerIncompatibleError("Owner identity protocol is invalid.")
        : new PeerUnavailableError(error.message)));
  request.once("socket", onSocket);
  request.once("finish", onFinish);
  deadline = setTimeout(onDeadline, ownerTransportDeadlineMilliseconds);
  signal?.addEventListener("abort", onAbort, { once: true });
  request.end(options.body);
});

export const openAuthenticatedOwnerChannel = async (input: {
  readonly ownerStore: Pick<RuntimeOwnerStore, "readProfile" | "readOwner">;
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
      (packet.status !== 200 && packet.status !== 503) ||
      packet.headers["content-type"] !== jsonContentType ||
      packet.headers["cache-control"] !== noStoreCacheControl
    ) throw new PeerIncompatibleError("Owner identity request failed.");
    const identity = parseOwnerIdentity(parseHttpJson(packet.bytes));
    if ((packet.status === 200) !== (identity.phase === "running")) throw new PeerIncompatibleError("Owner readiness is inconsistent.");
    const profile = input.ownerStore.readProfile();
    const recorded = input.ownerStore.readOwner();
    if (
      identity.challenge !== challenge ||
      identity.profileId !== profile.profileId ||
      identity.configurationMac !== input.configurationMac ||
      recorded === undefined ||
      identity.ownerInstanceId !== recorded.ownerInstanceId ||
      recorded.configurationMac !== input.configurationMac ||
      identity.ownerRevision !== recorded.ownerRevision
    ) throw new PeerIncompatibleError("Owner identity is incompatible.");
    const { proof, ...identityWithoutProof } = identity;
    if (!verifyControlPayload(input.credential, encodeOwnerProofPayload(identityWithoutProof), proof)) {
      throw new PeerIncompatibleError("Owner identity proof is invalid.");
    }
    return Object.freeze({
      channel,
      ready: packet.status === 200,
      ownerIdentity: identity,
      identity: Object.freeze({
        profileId: identity.profileId,
        ownerInstanceId: identity.ownerInstanceId,
        configurationMac: identity.configurationMac,
        ownerRevision: identity.ownerRevision,
      }),
    });
  } catch (error) {
    await channel.close();
    if (error instanceof PeerUnavailableError || error instanceof PeerIncompatibleError || error instanceof RuntimeOperationError) {
      throw error;
    }
    throw new PeerIncompatibleError("Owner identity is invalid.");
  }
};

export type { RuntimeDispatchRequestClass };

export type RuntimeDispatchRequest = RuntimeHttpRequest & Readonly<{
  requestClass: RuntimeDispatchRequestClass;
  signal?: AbortSignal;
}>;

export interface RuntimeDispatchResponse {
  readonly status: number;
  readonly body: CanonicalJson;
}

export const validateRuntimeDispatchRequest = (requestInput: unknown): RuntimeDispatchRequest => {
  if (typeof requestInput !== "object" || requestInput === null) {
    throw new TypeError("Runtime dispatch request is invalid.");
  }
  const request = requestInput as Readonly<{
    requestClass?: unknown;
    method?: unknown;
    path?: unknown;
    body?: unknown;
    signal?: unknown;
  }>;
  const target = parseRequestTarget(typeof request.path === "string" ? request.path : undefined);
  if (target === undefined || target.query !== "") {
    throw new TypeError("Runtime dispatch path is invalid.");
  }
  if (!runtimeDispatchRequestClasses.includes(request.requestClass as RuntimeDispatchRequestClass)) {
    throw new TypeError("Runtime dispatch request class is invalid.");
  }
  const requestClass = request.requestClass as RuntimeDispatchRequestClass;
  if (!routeMethods.includes(request.method as RouteMethod)) {
    throw new TypeError("Runtime dispatch method is invalid.");
  }
  const method = request.method as RouteMethod;
  if (method === "POST" && request.body === undefined) {
    throw new TypeError("POST runtime dispatch requests require a canonical JSON body.");
  }
  if (method !== "POST" && request.body !== undefined) {
    throw new TypeError("GET and DELETE runtime dispatch requests cannot contain a body.");
  }
  if (request.signal !== undefined && !(request.signal instanceof AbortSignal)) {
    throw new TypeError("Runtime dispatch signal is invalid.");
  }
  const common = {
    requestClass,
    path: target.pathname,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  } as const;
  return method === "POST"
    ? Object.freeze({
        ...common,
        method,
        body: captureCanonicalJson(request.body),
      })
    : Object.freeze({
        ...common,
        method,
      });
};


export const createAuthenticatedOwnerSession = (
  captured: AuthenticatedOwnerConnection,
  credential: LocalControlCredentialAuthority,
  signal: AbortSignal,
  onClosed: () => void,
): RuntimeOwnerSession => {
  const lifetime = new AbortController();
  let closed = false;
  let sending = false;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing !== undefined) return closing;
    closed = true;
    closing = Promise.resolve().then(() => captured.channel.close()).finally(() => {
      signal.removeEventListener("abort", closeOnAbort);
      onClosed();
    });
    lifetime.abort();
    return closing;
  };
  const closeOnAbort = (): void => { void close().catch(() => undefined); };
  signal.addEventListener("abort", closeOnAbort, { once: true });
  if (signal.aborted) closeOnAbort();
  return Object.freeze({
    identity: captured.identity,
    get usable(): boolean { return !closed && !captured.channel.socket.destroyed; },
    async send(input: RuntimeOwnerSessionRequest, callerSignal?: AbortSignal) {
      if (closed || sending) return { status: "request_not_sent" as const, reason: "owner_unavailable" as const };
      if (!Number.isSafeInteger(input.maximumResponseBytes) || input.maximumResponseBytes < 1 ||
          !Number.isSafeInteger(input.responseDeadlineMilliseconds) || input.responseDeadlineMilliseconds < 1) {
        throw new TypeError("Owner session request limits are invalid.");
      }
      const request = validateRuntimeDispatchRequest({ requestClass: localControlRequestClass, ...input });
      if (!captured.ready && !isRuntimeManagementRequest(request)) {
        return { status: "request_not_sent" as const, reason: "owner_unavailable" as const };
      }
      if (callerSignal?.aborted) return { status: "request_not_sent" as const, reason: "request_aborted" as const };
      sending = true;
      const joined = callerSignal === undefined ? lifetime.signal : AbortSignal.any([lifetime.signal, callerSignal]);
      try {
        const body = request.body === undefined ? undefined : `${canonicalJsonStringify(request.body)}\n`;
        const packet = await requestPacket(captured.channel, {
          method: request.method, path: request.path,
          headers: { Host: fixedHostHeader, Authorization: createControlAuthorizationHeader(credential),
            ...(body === undefined ? {} : { "Content-Type": jsonContentType, "Content-Length": Buffer.byteLength(body) }) },
          ...(body === undefined ? {} : { body }),
        }, input.maximumResponseBytes, "delivery", joined, input.responseDeadlineMilliseconds);
        return { status: "response_received" as const, response: Object.freeze({ statusCode: packet.status,
          contentType: packet.headers["content-type"], cacheControl: packet.headers["cache-control"], bytes: Uint8Array.from(packet.bytes) }) };
      } catch (error) {
        if (error instanceof OwnerRequestInterruptedError) return error.sendBegan
          ? { status: "response_unavailable_after_send_began" as const }
          : { status: "request_not_sent" as const, reason: error.reason };
        return { status: "request_not_sent" as const, reason: joined.aborted ? "request_aborted" as const : "owner_unavailable" as const };
      } finally { sending = false; }
    },
    close,
  });
};

export const dispatchAuthenticatedRequest = async (
  connection: AuthenticatedOwnerConnection,
  credential: LocalControlCredentialAuthority,
  request: RuntimeDispatchRequest,
): Promise<RuntimeDispatchResponse> => {
  if (!connection.ready) throw new RuntimeOperationError("runtime_state_unavailable");
  const body = request.body === undefined ? undefined : `${canonicalJsonStringify(request.body)}\n`;
  const packet = await requestPacket(connection.channel, { method: request.method, path: request.path,
    headers: { Host: fixedHostHeader,
      ...(request.requestClass === localControlRequestClass ? { Authorization: createControlAuthorizationHeader(credential) } : {}),
      ...(body === undefined ? {} : { "Content-Type": jsonContentType, "Content-Length": Buffer.byteLength(body) }) },
    ...(body === undefined ? {} : { body }),
  }, request.requestClass === publicReadRequestClass ? publicReadResponseLimitBytes : internalResponseLimitBytes,
  "dispatch", request.signal);
  return Object.freeze({ status: packet.status, body: parseHttpJson(packet.bytes) });
};
