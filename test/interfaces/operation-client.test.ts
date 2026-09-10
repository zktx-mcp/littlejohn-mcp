import { describe, expect, it } from "vitest";

import {
  canonicalJsonStringify,
  captureCanonicalJson,
  type CanonicalJson,
} from "../../src/core/index.js";
import { LocalOperationClient } from "../../src/interfaces/operation-client.js";
import { operationControlResources, operationInterfaceBindings } from "../../src/interfaces/operation-bindings.js";
import type { LocalOperationIdentity } from "../../src/interfaces/local-operation.js";
import {
  internalCanonicalJsonResponseLimitBytes,
  internalResponseLimitBytes,
  jsonContentType,
  noStoreCacheControl,
  problemJsonContentType,
  toProblemDetails,
  type RuntimeOwnerResponsePacket,
  type RuntimeOwnerSendResult,
  type RuntimeOwnerSession,
  type RuntimeOwnerSessionIdentity,
  type RuntimeOwnerSessionPort,
  type RuntimeOwnerSessionRequest,
} from "../../src/runtime/index.js";
import {
  parseOwnerInstanceId,
  parseProfileId,
  parseRuntimeConfigurationMac,
  parseRuntimeRevision,
} from "../../src/runtime/runtime-identity.js";
import {
  parseWalletManagementOperation,
  parseWalletReview,
  walletReviewDigest,
} from "../../src/wallet/contracts.js";
import { createWalletFailure, walletInterfaceErrorMappings } from "../../src/wallet/errors.js";

const operationId = Buffer.alloc(32, 31).toString("base64url");

const review = parseWalletReview({
  contractVersion: "1",
  domain: "wallet",
  operationId,
  kind: "connect",
  createdAt: "2026-08-12T00:00:00.000Z",
  actionExpiresAt: "2026-08-12T00:05:00.000Z",
  target: { chainId: "eip155:4663" },
  decision: {
    requiredMethods: ["eth_sendTransaction"],
    optionalMethods: ["personal_sign", "eth_signTypedData_v4"],
    requiredEvents: ["accountsChanged", "chainChanged"],
  },
  precondition: {
    connectionRevision: "4",
    connection: { status: "disconnected", reason: "no_session" },
  },
  fixedEvidence: { sessionSourceIds: [] },
  reviewDigest: walletReviewDigest({
    contractVersion: "1",
    domain: "wallet",
    operationId,
    kind: "connect",
    createdAt: "2026-08-12T00:00:00.000Z",
    actionExpiresAt: "2026-08-12T00:05:00.000Z",
    target: { chainId: "eip155:4663" },
    decision: {
      requiredMethods: ["eth_sendTransaction"],
      optionalMethods: ["personal_sign", "eth_signTypedData_v4"],
      requiredEvents: ["accountsChanged", "chainChanged"],
    },
    precondition: {
      connectionRevision: "4",
      connection: { status: "disconnected", reason: "no_session" },
    },
    fixedEvidence: { sessionSourceIds: [] },
  }),
});
const reviewed = Object.freeze({ status: "review" as const, review });

const action = Object.freeze({ review, initiatedBy: "mcp_app" as const });
const operation = parseWalletManagementOperation({
  contractVersion: "1",
  domain: "wallet",
  operationId,
  kind: "connect",
  initiatedBy: "mcp_app",
  review,
  state: "starting_connection",
  terminationTarget: null,
  result: null,
  failure: null,
  peerRefusalCode: null,
});

const ownerIdentity = (revision = "1"): RuntimeOwnerSessionIdentity => Object.freeze({
  profileId: parseProfileId(Buffer.alloc(16, 1).toString("base64url")),
  ownerInstanceId: parseOwnerInstanceId(Buffer.alloc(16, 2).toString("base64url")),
  configurationMac: parseRuntimeConfigurationMac(Buffer.alloc(32, 3).toString("base64url")),
  ownerRevision: parseRuntimeRevision(revision),
});

const responsePacket = (
  body: unknown,
  statusCode = 200,
  contentType = statusCode >= 400 ? problemJsonContentType : jsonContentType,
): RuntimeOwnerResponsePacket => Object.freeze({
  statusCode,
  contentType,
  cacheControl: noStoreCacheControl,
  bytes: new TextEncoder().encode(`${canonicalJsonStringify(captureCanonicalJson(body as CanonicalJson))}\n`),
});

const received = (body: unknown): RuntimeOwnerSendResult => Object.freeze({
  status: "response_received" as const,
  response: responsePacket(body),
});

const session = (input: Readonly<{
  identity?: RuntimeOwnerSessionIdentity;
  usable?: () => boolean;
  send(request: RuntimeOwnerSessionRequest, signal?: AbortSignal): Promise<RuntimeOwnerSendResult>;
  close?: () => void;
}>): RuntimeOwnerSession => Object.freeze({
  identity: input.identity ?? ownerIdentity(),
  get usable(): boolean { return input.usable?.() ?? true; },
  send: input.send,
  close: input.close ?? (() => undefined),
});

const ownerSessions = (...sessions: RuntimeOwnerSession[]): RuntimeOwnerSessionPort => {
  let index = 0;
  return Object.freeze({
    async openOwnerSession(): Promise<RuntimeOwnerSession> {
      const selected = sessions[index];
      index += 1;
      if (selected === undefined) throw new Error("Unexpected owner-session open.");
      return selected;
    },
  });
};

describe("local operation delivery", () => {
  it("derives one canonical operation payload from the framed internal response", () => {
    expect(internalCanonicalJsonResponseLimitBytes).toBe(65_535);
    expect(internalCanonicalJsonResponseLimitBytes + 1).toBe(internalResponseLimitBytes);
    const envelopeBytes = Buffer.byteLength('{"value":""}\n', "utf8");
    const packet = responsePacket({
      value: "x".repeat(65_535 - envelopeBytes + 1),
    });
    expect(packet.bytes).toHaveLength(65_536);
  });

  it("rejects identities outside the canonical identity owner before opening a session", async () => {
    let opens = 0;
    const client = new LocalOperationClient({
      ownerSessions: Object.freeze({
        async openOwnerSession(): Promise<never> {
          opens += 1;
          throw new Error("A foreign identity must not open an owner session.");
        },
      }),
    });
    const foreign = Object.freeze({}) as LocalOperationIdentity<unknown, unknown>;

    expect(() => client.invoke(foreign, {})).toThrow("Local operation identity is invalid.");
    expect(opens).toBe(0);
    await client.close();
  });

  it("returns the owning input path before opening an owner session", async () => {
    let opens = 0;
    const client = new LocalOperationClient({
      ownerSessions: Object.freeze({
        async openOwnerSession(): Promise<never> {
          opens += 1;
          throw new Error("Invalid input must not open an owner session.");
        },
      }),
    });

    const result = await client.invoke(operationInterfaceBindings.walletReview.identity, {
      kind: "replace",
    });

    expect(result).toMatchObject({
      ok: false,
      failure: {
        error: {
          code: "invalid_input",
          issues: [{ path: "/kind", code: "invalid_value" }],
        },
      },
    });
    expect(opens).toBe(0);
    await client.close();
  });

  it("does not convert an unobserved pure Review into durable-delivery uncertainty", async () => {
    const client = new LocalOperationClient({
      ownerSessions: ownerSessions(session({
        async send() {
          return Object.freeze({ status: "response_unavailable_after_send_began" as const });
        },
      })),
    });

    const result = await client.invoke(operationInterfaceBindings.walletReview.identity, { kind: "connect" });

    expect(result).toMatchObject({
      ok: false,
      failure: { error: { code: "runtime_state_unavailable" } },
    });
    expect(result).not.toHaveProperty("status", "delivery_unknown");
    await client.close();
  });

  it("keeps a proven pre-send abort definitive", async () => {
    const client = new LocalOperationClient({
      ownerSessions: ownerSessions(session({
        async send() {
          return Object.freeze({ status: "request_not_sent" as const, reason: "request_aborted" as const });
        },
      })),
    });

    const result = await client.invoke(operationInterfaceBindings.walletConnect.identity, action);

    expect(result).toMatchObject({ ok: false, failure: { error: { code: "request_aborted" } } });
    expect(result).not.toHaveProperty("status", "delivery_unknown");
    await client.close();
  });

  it("recovers a sent direct decision with one exact same-owner read and never resends", async () => {
    const requests: RuntimeOwnerSessionRequest[] = [];
    let firstUsable = true;
    const caller = new AbortController();
    const first = session({
      usable: () => firstUsable,
      async send(request) {
        requests.push(request);
        firstUsable = false;
        caller.abort();
        return Object.freeze({ status: "response_unavailable_after_send_began" as const });
      },
    });
    const replacement = session({
      async send(request, signal) {
        requests.push(request);
        expect(signal).not.toBe(caller.signal);
        expect(signal?.aborted).toBe(false);
        return received(operation);
      },
    });
    const client = new LocalOperationClient({ ownerSessions: ownerSessions(first, replacement) });

    const result = await client.invoke(operationInterfaceBindings.walletConnect.identity, action, caller.signal);

    expect(result).toEqual({ ok: true, value: operation });
    expect(requests.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: "POST", path: operationControlResources.wallet.decisions },
      { method: "GET", path: operationControlResources.wallet.operation(operationId) },
    ]);
    expect(requests[0]?.body).toEqual(action);
    expect(requests[1]?.body).toBeUndefined();
    expect(requests.map(({ maximumResponseBytes, responseDeadlineMilliseconds }) => ({
      maximumResponseBytes,
      responseDeadlineMilliseconds,
    }))).toEqual([
      { maximumResponseBytes: internalResponseLimitBytes, responseDeadlineMilliseconds: 300_000 },
      { maximumResponseBytes: internalResponseLimitBytes, responseDeadlineMilliseconds: 2_000 },
    ]);
    await client.close();
  });

  it("reports delivery_unknown when the exact operation cannot be proved by the same owner", async () => {
    let firstUsable = true;
    let replacementSends = 0;
    const client = new LocalOperationClient({
      ownerSessions: ownerSessions(
        session({
          usable: () => firstUsable,
          async send() {
            firstUsable = false;
            return Object.freeze({ status: "response_unavailable_after_send_began" as const });
          },
        }),
        session({
          identity: ownerIdentity("2"),
          async send() {
            replacementSends += 1;
            return received(operation);
          },
        }),
      ),
    });

    const result = await client.invoke(operationInterfaceBindings.walletConnect.identity, action);

    expect(result).toEqual({
      status: "delivery_unknown",
      action: "decide",
      operationId,
      resendAllowed: false,
    });
    expect(replacementSends).toBe(0);
    await client.close();
  });

  it("keeps an exact read failure definitive and never turns it into a resendable action", async () => {
    const client = new LocalOperationClient({
      ownerSessions: ownerSessions(session({
        async send() {
          return Object.freeze({ status: "response_unavailable_after_send_began" as const });
        },
      })),
    });

    const result = await client.invoke(operationInterfaceBindings.walletOperation.identity, { operationId });

    expect(result).toMatchObject({
      ok: false,
      failure: { error: { code: "runtime_state_unavailable" } },
    });
    expect(result).not.toHaveProperty("resendAllowed");
    await client.close();
  });

  it("preserves an admitted owner failure only with its Problem Details content type", async () => {
    const failure = createWalletFailure("wallet_operation_not_found");
    const problem = toProblemDetails(failure, walletInterfaceErrorMappings);
    const client = new LocalOperationClient({
      ownerSessions: ownerSessions(session({
        async send() {
          return Object.freeze({
            status: "response_received" as const,
            response: responsePacket(problem, problem.status),
          });
        },
      })),
    });

    expect(await client.invoke(
      operationInterfaceBindings.walletOperation.identity,
      { operationId },
    )).toEqual({ ok: false, failure });
    await client.close();
  });

  it("rejects a failure body carried with the success content type", async () => {
    const failure = createWalletFailure("wallet_operation_not_found");
    const problem = toProblemDetails(failure, walletInterfaceErrorMappings);
    const client = new LocalOperationClient({
      ownerSessions: ownerSessions(session({
        async send() {
          return Object.freeze({
            status: "response_received" as const,
            response: responsePacket(problem, problem.status, jsonContentType),
          });
        },
      })),
    });

    expect(await client.invoke(
      operationInterfaceBindings.walletOperation.identity,
      { operationId },
    )).toMatchObject({ ok: false, failure: { error: { code: "internal_error" } } });
    await client.close();
  });
});

const settle = <Value>(promise: Promise<Value>) => promise.then(
  (value) => Object.freeze({ status: "fulfilled" as const, value }),
  (reason: unknown) => Object.freeze({ status: "rejected" as const, reason }),
);

const pendingAfterOneTurn = async (promise: Promise<unknown>) => await Promise.race([
  settle(promise),
  new Promise<Readonly<{ status: "pending" }>>((resolve) => {
    setImmediate(() => resolve(Object.freeze({ status: "pending" })));
  }),
]);

describe("local operation cleanup ownership", () => {
  it("owns a pending acquisition before close and releases its late session without sending", async () => {
    let resolveOpen!: (value: RuntimeOwnerSession) => void;
    const opening = new Promise<RuntimeOwnerSession>((resolve) => { resolveOpen = resolve; });
    let sends = 0;
    let closes = 0;
    let acquisitionSignal: AbortSignal | undefined;
    const client = new LocalOperationClient({
      ownerSessions: Object.freeze({
        openOwnerSession(signal?: AbortSignal): Promise<RuntimeOwnerSession> {
          acquisitionSignal = signal;
          return opening;
        },
      }),
    });
    const invocation = client.invoke(
      operationInterfaceBindings.walletReview.identity,
      { kind: "connect" },
    );

    const closing = client.close();
    expect(client.close()).toBe(closing);
    expect(acquisitionSignal?.aborted).toBe(true);
    expect(await pendingAfterOneTurn(closing)).toEqual({ status: "pending" });

    resolveOpen(session({
      async send() {
        sends += 1;
        return received(review);
      },
      close: () => { closes += 1; },
    }));

    await expect(closing).resolves.toBeUndefined();
    expect(sends).toBe(0);
    expect(closes).toBe(1);
    await expect(invocation).resolves.toMatchObject({
      ok: false,
      failure: { error: { code: "request_aborted" } },
    });
    expect(client.close()).toBe(closing);
    await expect(client.invoke(
      operationInterfaceBindings.walletReview.identity,
      { kind: "connect" },
    )).resolves.toMatchObject({
      ok: false,
      failure: { error: { code: "runtime_state_unavailable" } },
    });
  });

  it("retains a late session whose first release rejects and retries only that session", async () => {
    let resolveOpen!: (value: RuntimeOwnerSession) => void;
    const opening = new Promise<RuntimeOwnerSession>((resolve) => { resolveOpen = resolve; });
    let closes = 0;
    const client = new LocalOperationClient({
      ownerSessions: Object.freeze({ openOwnerSession: () => opening }),
    });
    const invocation = client.invoke(
      operationInterfaceBindings.walletReview.identity,
      { kind: "connect" },
    );
    const first = client.close();
    resolveOpen(session({
      async send() { throw new Error("A late session must not send."); },
      close: () => {
        closes += 1;
        if (closes === 1) throw undefined;
      },
    }));

    expect(await settle(first)).toEqual({ status: "rejected", reason: undefined });
    await expect(invocation).resolves.toMatchObject({
      ok: false,
      failure: { error: { code: "request_aborted" } },
    });
    expect(closes).toBe(1);

    const retry = client.close();
    expect(retry).not.toBe(first);
    await expect(retry).resolves.toBeUndefined();
    expect(closes).toBe(2);
    expect(client.close()).toBe(retry);
  });

  it("attempts independent sessions once, preserves ordered failures, and retries exact unresolved identities", async () => {
    const childFailure = new AggregateError([], "child close failure");
    const closeOrder: string[] = [];
    const closeCalls = new Map<string, number>();
    const resolveSends = new Map<string, (value: RuntimeOwnerSendResult) => void>();
    let sendsStarted = 0;
    let resolveAllSendsStarted!: () => void;
    const allSendsStarted = new Promise<void>((resolve) => { resolveAllSendsStarted = resolve; });
    let client!: LocalOperationClient;
    let reentrantClose: Promise<void> | undefined;
    const makeSession = (name: string, failure?: unknown): RuntimeOwnerSession => session({
      async send() {
        sendsStarted += 1;
        if (sendsStarted === 3) resolveAllSendsStarted();
        return await new Promise<RuntimeOwnerSendResult>((resolve) => {
          resolveSends.set(name, resolve);
        });
      },
      close: () => {
        closeOrder.push(name);
        const calls = (closeCalls.get(name) ?? 0) + 1;
        closeCalls.set(name, calls);
        if (calls === 1) resolveSends.get(name)?.(received(reviewed));
        if (name === "second" && reentrantClose === undefined) {
          reentrantClose = client.close();
          expect(client.close()).toBe(reentrantClose);
        }
        if (calls === 1 && name !== "second") throw failure;
      },
    });
    client = new LocalOperationClient({
      ownerSessions: ownerSessions(
        makeSession("first", undefined),
        makeSession("second"),
        makeSession("third", childFailure),
      ),
    });
    const invocations = [0, 1, 2].map(() => client.invoke(
      operationInterfaceBindings.walletReview.identity,
      { kind: "connect" },
    ));
    await allSendsStarted;

    const first = client.close();
    expect(client.close()).toBe(first);
    const firstResult = await settle(first);
    expect(firstResult.status).toBe("rejected");
    if (firstResult.status === "rejected") {
      expect(firstResult.reason).toBeInstanceOf(AggregateError);
      expect((firstResult.reason as AggregateError).errors).toEqual([undefined, childFailure]);
    }
    expect(reentrantClose).toBe(first);
    expect(closeOrder).toEqual(["first", "second", "third"]);
    for (const invocation of invocations) {
      await expect(invocation).resolves.toEqual({ ok: true, value: reviewed });
    }

    const retry = client.close();
    await expect(retry).resolves.toBeUndefined();
    expect(closeOrder).toEqual(["first", "second", "third", "first", "third"]);
    expect(client.close()).toBe(retry);
  });

  it("preserves an admitted result while fail-closed abort reentry publishes one cleanup attempt", async () => {
    const releaseFailure = new Error("session release failed");
    let closes = 0;
    let opens = 0;
    let client!: LocalOperationClient;
    let reentrantClose: Promise<void> | undefined;
    let concurrentClose: Promise<void> | undefined;
    const owned = session({
      async send() { return received(reviewed); },
      close: () => {
        closes += 1;
        if (closes === 1) throw releaseFailure;
      },
    });
    client = new LocalOperationClient({
      ownerSessions: Object.freeze({
        async openOwnerSession(signal?: AbortSignal): Promise<RuntimeOwnerSession> {
          opens += 1;
          signal?.addEventListener("abort", () => {
            reentrantClose = client.close();
            concurrentClose = client.close();
          }, { once: true });
          return owned;
        },
      }),
    });

    await expect(client.invoke(
      operationInterfaceBindings.walletReview.identity,
      { kind: "connect" },
    )).resolves.toEqual({ ok: true, value: reviewed });
    expect(opens).toBe(1);
    expect(reentrantClose).toBeDefined();
    expect(concurrentClose).toBe(reentrantClose);
    await expect(reentrantClose).resolves.toBeUndefined();
    expect(closes).toBe(2);

    await expect(client.invoke(
      operationInterfaceBindings.walletReview.identity,
      { kind: "connect" },
    )).resolves.toMatchObject({
      ok: false,
      failure: { error: { code: "runtime_state_unavailable" } },
    });
    expect(opens).toBe(1);
    expect(client.close()).toBe(reentrantClose);
  });

  it("aborts an admitted send but does not fulfill close before the invocation settles", async () => {
    let sendSignal: AbortSignal | undefined;
    let resolveSend!: (value: RuntimeOwnerSendResult) => void;
    let resolveSendStarted!: () => void;
    const sendStarted = new Promise<void>((resolve) => { resolveSendStarted = resolve; });
    let closes = 0;
    let client!: LocalOperationClient;
    let reentrantClose: Promise<void> | undefined;
    client = new LocalOperationClient({
      ownerSessions: Object.freeze({
        async openOwnerSession(signal?: AbortSignal): Promise<RuntimeOwnerSession> {
          signal?.addEventListener("abort", () => {
            reentrantClose = client.close();
          }, { once: true });
          return session({
            send: async (_request, sendSignalInput) => {
              sendSignal = sendSignalInput;
              resolveSendStarted();
              return await new Promise<RuntimeOwnerSendResult>((resolve) => { resolveSend = resolve; });
            },
            close: () => { closes += 1; },
          });
        },
      }),
    });
    const invocation = client.invoke(
      operationInterfaceBindings.walletReview.identity,
      { kind: "connect" },
    );
    await sendStarted;

    const closing = client.close();
    expect(reentrantClose).toBe(closing);
    expect(sendSignal?.aborted).toBe(true);
    expect(await pendingAfterOneTurn(closing)).toEqual({ status: "pending" });
    expect(closes).toBe(1);

    resolveSend(Object.freeze({ status: "request_not_sent", reason: "request_aborted" }));
    await expect(invocation).resolves.toMatchObject({
      ok: false,
      failure: { error: { code: "request_aborted" } },
    });
    await expect(closing).resolves.toBeUndefined();
    expect(closes).toBe(1);
  });
});
