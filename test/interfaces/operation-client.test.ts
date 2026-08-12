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
      requiredEvents: ["accountsChanged", "chainChanged"],
    },
    precondition: {
      connectionRevision: "4",
      connection: { status: "disconnected", reason: "no_session" },
    },
    fixedEvidence: { sessionSourceIds: [] },
  }),
});

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
}>): RuntimeOwnerSession => Object.freeze({
  identity: input.identity ?? ownerIdentity(),
  get usable(): boolean { return input.usable?.() ?? true; },
  send: input.send,
  close: () => undefined,
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
