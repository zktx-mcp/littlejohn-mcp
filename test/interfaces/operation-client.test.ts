import { describe, expect, it } from "vitest";

import {
  canonicalJsonStringify,
  captureCanonicalJson,
  type CanonicalJson,
} from "../../src/core/index.js";
import {
  LocalOperationClient,
  walletLocalOperationIdentities,
  type LocalOperationIdentity,
} from "../../src/interfaces/index.js";
import {
  internalResponseLimitBytes,
  jsonContentType,
  noStoreCacheControl,
  type RuntimeOwnerResponsePacket,
  type RuntimeOwnerSendResult,
  type RuntimeOwnerSession,
  type RuntimeOwnerSessionIdentity,
  type RuntimeOwnerSessionPort,
  type RuntimeOwnerSessionRequest,
  runtimeProtocolVersion,
} from "../../src/runtime/index.js";
import {
  parseOwnerInstanceId,
  parseProfileId,
  parseRuntimeConfigurationMac,
  parseRuntimeRevision,
} from "../../src/runtime/runtime-identity.js";
import { parseWalletManagementOperation } from "../../src/wallet/contracts.js";

const operationId = Buffer.alloc(32, 31).toString("base64url");
const foreignOperationId = Buffer.alloc(32, 32).toString("base64url");
const expiresAt = "2026-07-21T04:00:00.000Z";

const ownerIdentity = (overrides: Partial<RuntimeOwnerSessionIdentity> = {}): RuntimeOwnerSessionIdentity =>
  Object.freeze({
    profileId: parseProfileId(Buffer.alloc(16, 1).toString("base64url")),
    ownerInstanceId: parseOwnerInstanceId(Buffer.alloc(16, 2).toString("base64url")),
    runtimeProtocolVersion,
    configurationMac: parseRuntimeConfigurationMac(Buffer.alloc(32, 3).toString("base64url")),
    ownerRevision: parseRuntimeRevision("1"),
    ...overrides,
  });

const operation = (
  state: "awaiting_wallet_approval" | "cancelled" | "expired",
  id = operationId,
) => parseWalletManagementOperation({
  operationId: id,
  kind: "connect",
  state,
  connectionRevision: "4",
  expiresAt,
  result: null,
  failure: null,
});

const responsePacket = (body: unknown): RuntimeOwnerResponsePacket => Object.freeze({
  statusCode: 200,
  contentType: jsonContentType,
  cacheControl: noStoreCacheControl,
  bytes: new TextEncoder().encode(`${canonicalJsonStringify(captureCanonicalJson(body))}\n`),
});

const received = (body: unknown): RuntimeOwnerSendResult => Object.freeze({
  status: "response_received" as const,
  response: responsePacket(body),
});

const ownerSessions = (...sessions: RuntimeOwnerSession[]): RuntimeOwnerSessionPort => {
  let next = 0;
  return Object.freeze({
    async openOwnerSession(): Promise<RuntimeOwnerSession> {
      const session = sessions[next];
      next += 1;
      if (session === undefined) throw new Error("Unexpected owner-session open.");
      return session;
    },
  });
};

const session = (input: Readonly<{
  identity?: RuntimeOwnerSessionIdentity;
  usable?: boolean;
  send(request: RuntimeOwnerSessionRequest, signal?: AbortSignal): Promise<RuntimeOwnerSendResult>;
  close?: () => void;
}>): RuntimeOwnerSession => Object.freeze({
  identity: input.identity ?? ownerIdentity(),
  get usable(): boolean { return input.usable ?? true; },
  send: input.send,
  close: input.close ?? (() => undefined),
});

describe("authenticated local operation client", () => {
  it("accepts only identities from the canonical local operation catalog", async () => {
    let sessionOpens = 0;
    const client = new LocalOperationClient({
      ownerSessions: Object.freeze({
        async openOwnerSession(): Promise<RuntimeOwnerSession> {
          sessionOpens += 1;
          throw new Error("A foreign identity must not open an owner session.");
        },
      }),
      createOperationId: () => operationId,
    });
    const foreignIdentity = Object.freeze({}) as LocalOperationIdentity<unknown, unknown>;

    expect(() => client.invoke(foreignIdentity, {})).toThrow("Local operation identity is invalid.");
    expect(sessionOpens).toBe(0);
    await client.close();
  });

  it("distinguishes abort before send from uncertainty after send", async () => {
    const controller = new AbortController();
    controller.abort();
    let sends = 0;
    const client = new LocalOperationClient({
      ownerSessions: ownerSessions(session({
        async send(_request, signal) {
          sends += 1;
          expect(signal?.aborted).toBe(true);
          return Object.freeze({ status: "request_not_sent", reason: "request_aborted" });
        },
      })),
      createOperationId: () => operationId,
    });

    const result = await client.invoke(walletLocalOperationIdentities.cli.connect, {}, controller.signal);
    expect(result).toMatchObject({ ok: false, failure: { error: { code: "request_aborted" } } });
    expect(sends).toBe(1);
    await client.close();
  });

  it("uses one exact read with the client lifecycle signal when the same owner remains provable", async () => {
    const caller = new AbortController();
    const requests: RuntimeOwnerSessionRequest[] = [];
    const recoverySignals: (AbortSignal | undefined)[] = [];
    const first = session({
      usable: false,
      async send(request) {
        requests.push(request);
        caller.abort();
        return Object.freeze({ status: "response_unavailable_after_send_began" });
      },
    });
    const replacement = session({
      async send(request, signal) {
        requests.push(request);
        recoverySignals.push(signal);
        return received({ operation: operation("awaiting_wallet_approval") });
      },
    });
    const client = new LocalOperationClient({
      ownerSessions: ownerSessions(first, replacement),
      createOperationId: () => operationId,
    });

    const result = await client.invoke(walletLocalOperationIdentities.cli.connect, {}, caller.signal);
    expect(result).toMatchObject({
      ok: true,
      value: { result: { status: "operation_started", operation: { operationId } } },
    });
    expect(requests.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: "POST", path: "/api/v1/internal/control/wallet/operations" },
      { method: "GET", path: `/api/v1/internal/control/wallet/operations/${operationId}` },
    ]);
    expect(requests.map(({ maximumResponseBytes, responseDeadlineMilliseconds }) => ({
      maximumResponseBytes,
      responseDeadlineMilliseconds,
    }))).toEqual([
      { maximumResponseBytes: internalResponseLimitBytes, responseDeadlineMilliseconds: 300_000 },
      { maximumResponseBytes: internalResponseLimitBytes, responseDeadlineMilliseconds: 2_000 },
    ]);
    expect(recoverySignals).toHaveLength(1);
    expect(recoverySignals[0]).not.toBe(caller.signal);
    expect(recoverySignals[0]?.aborted).toBe(false);
    await client.close();
  });

  it("recovers after a malformed post-send Problem Details response instead of inventing a failure", async () => {
    let sends = 0;
    const client = new LocalOperationClient({
      ownerSessions: ownerSessions(session({
        async send() {
          sends += 1;
          if (sends === 1) {
            return Object.freeze({
              status: "response_received" as const,
              response: Object.freeze({
                statusCode: 500,
                contentType: jsonContentType,
                cacheControl: noStoreCacheControl,
                bytes: new TextEncoder().encode("{}"),
              }),
            });
          }
          return received({ operation: operation("awaiting_wallet_approval") });
        },
      })),
      createOperationId: () => operationId,
    });

    expect(await client.invoke(walletLocalOperationIdentities.cli.connect, {})).toMatchObject({
      ok: true,
      value: { result: { status: "operation_started", operation: { operationId } } },
    });
    expect(sends).toBe(2);
    await client.close();
  });

  it("refuses recovery when any authenticated owner identity field changes", async () => {
    const replacements: RuntimeOwnerSessionIdentity[] = [
      ownerIdentity({ profileId: parseProfileId(Buffer.alloc(16, 4).toString("base64url")) }),
      ownerIdentity({ ownerInstanceId: parseOwnerInstanceId(Buffer.alloc(16, 5).toString("base64url")) }),
      ownerIdentity({ runtimeProtocolVersion: runtimeProtocolVersion + 1 } as unknown as Partial<RuntimeOwnerSessionIdentity>),
      ownerIdentity({
        configurationMac: parseRuntimeConfigurationMac(Buffer.alloc(32, 6).toString("base64url")),
      }),
      ownerIdentity({ ownerRevision: parseRuntimeRevision("2") }),
    ];

    for (const replacementIdentity of replacements) {
      let recoverySends = 0;
      const client = new LocalOperationClient({
        ownerSessions: ownerSessions(
          session({
            usable: false,
            async send() {
              return Object.freeze({ status: "response_unavailable_after_send_began" });
            },
          }),
          session({
            identity: replacementIdentity,
            async send() {
              recoverySends += 1;
              return received({ operation: operation("awaiting_wallet_approval") });
            },
          }),
        ),
        createOperationId: () => operationId,
      });

      expect(await client.invoke(walletLocalOperationIdentities.cli.connect, {})).toEqual({
        status: "delivery_unknown",
        action: "start",
        operationId,
        resendAllowed: false,
      });
      expect(recoverySends).toBe(0);
      await client.close();
    }
  });

  it("does not treat same-ID existence or a generic terminal state as action proof", async () => {
    const expectUnproved = async <Input, Success>(
      identity: LocalOperationIdentity<Input, Success>,
      input: unknown,
      recovery: unknown,
    ): Promise<void> => {
      let sends = 0;
      const client = new LocalOperationClient({
        ownerSessions: ownerSessions(session({
          async send() {
            sends += 1;
            return sends === 1
              ? Object.freeze({ status: "response_unavailable_after_send_began" })
              : received(recovery);
          },
        })),
        createOperationId: () => operationId,
      });

      const result = await client.invoke(identity, input);
      expect(result).toMatchObject({ status: "delivery_unknown", operationId, resendAllowed: false });
      expect(sends).toBe(2);
      await client.close();
    };

    await expectUnproved(
      walletLocalOperationIdentities.cli.connect,
      {},
      { operation: operation("awaiting_wallet_approval", foreignOperationId) },
    );
    await expectUnproved(
      walletLocalOperationIdentities.cli.cancel,
      { operationId },
      { operation: operation("expired") },
    );
  });

  it("close aborts and drains active delivery before rejecting later calls", async () => {
    let finish!: (result: RuntimeOwnerSendResult) => void;
    const pending = new Promise<RuntimeOwnerSendResult>((resolve) => { finish = resolve; });
    let closed = false;
    const client = new LocalOperationClient({
      ownerSessions: ownerSessions(session({
        async send() { return pending; },
        close() {
          closed = true;
          finish(Object.freeze({ status: "response_unavailable_after_send_began" }));
        },
      })),
      createOperationId: () => operationId,
    });
    const active = client.invoke(walletLocalOperationIdentities.cli.operation, { operationId });
    await Promise.resolve();
    const closing = client.close();
    expect(closed).toBe(true);
    await closing;
    await expect(active).resolves.toMatchObject({
      ok: false,
      failure: { error: { code: "runtime_state_unavailable" } },
    });
    await expect(client.invoke(walletLocalOperationIdentities.cli.operation, { operationId }))
      .resolves.toMatchObject({
        ok: false,
        failure: { error: { code: "runtime_state_unavailable" } },
      });
  });
});
