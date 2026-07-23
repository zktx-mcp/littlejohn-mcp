import { describe, expect, it } from "vitest";

import { referenceMarketManifest } from "../../src/core/index.js";
import { LocalMutationClient } from "../../src/interfaces/reference-market-local-client.js";
import { referenceMarketLocalMutationPaths } from "../../src/interfaces/identities.js";
import { jsonContentType, noStoreCacheControl } from "../../src/runtime/http-boundary.js";
import type {
  RuntimeOwnerSession,
  RuntimeOwnerSessionPort,
  RuntimeOwnerSessionRequest,
} from "../../src/runtime/owner-session.js";

const ownerSessions = (session: RuntimeOwnerSession): RuntimeOwnerSessionPort => Object.freeze({
  async openOwnerSession(): Promise<RuntimeOwnerSession> { return session; },
});

describe("reference-market compatible-process mutation delivery", () => {
  it("sends once and preserves ambiguity after the owner accepted transmission", async () => {
    const requests: RuntimeOwnerSessionRequest[] = [];
    let closes = 0;
    const client = new LocalMutationClient(ownerSessions(Object.freeze({
      identity: {} as never,
      usable: true,
      async send(request: RuntimeOwnerSessionRequest) {
        requests.push(request);
        return Object.freeze({ status: "response_unavailable_after_send_began" as const });
      },
      close() { closes += 1; },
    })));
    const pairId = referenceMarketManifest.pairs[0]!.pairId;
    const result = await client.add({ pairId, expectedRevision: "AAAAAAAAAAAAAAAAAAAAAA" });
    expect(result).toMatchObject({
      status: "delivery_unknown",
      action: "add",
      requestDigest: "26ba5ebfd2ed004b2e15c2bc669d6dd9edfc4764085ad0f212f4e621af1f774d",
      expectedRevision: "AAAAAAAAAAAAAAAAAAAAAA",
      resendAllowed: false,
      verificationCapability: "market.watchlist",
    });
    expect(requests).toEqual([expect.objectContaining({
      method: "POST",
      path: referenceMarketLocalMutationPaths.add,
      body: { pairId, expectedRevision: "AAAAAAAAAAAAAAAAAAAAAA" },
    })]);
    expect(closes).toBe(1);
    await client.close();
  });

  it("reports a proven pre-send abort as a failure rather than delivery ambiguity", async () => {
    const client = new LocalMutationClient(ownerSessions(Object.freeze({
      identity: {} as never,
      usable: true,
      async send() {
        return Object.freeze({ status: "request_not_sent" as const, reason: "request_aborted" as const });
      },
      close() {},
    })));
    const result = await client.remove({
      pairId: referenceMarketManifest.pairs[0]!.pairId,
      expectedRevision: "AAAAAAAAAAAAAAAAAAAAAA",
    });
    expect(result).toMatchObject({ ok: false, failure: { error: { code: "request_aborted" } } });
    expect(result).not.toHaveProperty("status");
    await client.close();
  });

  it("does not turn a malformed post-send Problem Details body into a definitive failure", async () => {
    const client = new LocalMutationClient(ownerSessions(Object.freeze({
      identity: {} as never,
      usable: true,
      async send() {
        return Object.freeze({
          status: "response_received" as const,
          response: Object.freeze({
            statusCode: 500,
            contentType: jsonContentType,
            cacheControl: noStoreCacheControl,
            bytes: new TextEncoder().encode("{}"),
          }),
        });
      },
      close() {},
    })));
    const result = await client.add({
      pairId: referenceMarketManifest.pairs[0]!.pairId,
      expectedRevision: "AAAAAAAAAAAAAAAAAAAAAA",
    });
    expect(result).toMatchObject({ status: "delivery_unknown", resendAllowed: false });
    expect(result).not.toHaveProperty("failure");
    await client.close();
  });
});
