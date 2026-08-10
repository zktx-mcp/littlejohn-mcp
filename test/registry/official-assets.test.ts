import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  createRobinhoodOfficialAssetSourceClient,
} from "../../src/registry/official-assets.js";
import {
  officialAssetSourceDefinition,
} from "../../src/registry/official-asset-contract.js";
import {
  parseEvmAddress,
  parseHash32,
  productChainNumericId,
} from "../../src/core/index.js";

const observedAt = "2026-07-20T00:00:00.000Z";
const expectedSourceUri = "https://api.robinhood.com/rhj/assets";
const expectedMemberLimit = 512;
const expectedResponseByteLimit = 1_048_576;
const uid = (value: number) => parseHash32(`0x${value.toString(16).padStart(64, "0")}`);
const address = (value: number) => parseEvmAddress(`0x${value.toString(16).padStart(40, "0")}`);
const asset = (value: number, overrides: Record<string, unknown> = {}) => ({
  id: uid(value),
  status: "ASSET_STATUS_ACTIVE",
  deployments: [{ chainId: productChainNumericId, contractAddress: address(value) }],
  tokenName: `Token ${value}`,
  tokenSymbol: `T${value}`,
  ignored: "not consumed",
  ...overrides,
});
const bytes = (value: unknown): Uint8Array => Buffer.from(JSON.stringify(value), "utf8");
const sha256 = (value: Uint8Array | string): string =>
  `0x${createHash("sha256").update(value).digest("hex")}`;
const readSnapshot = async (body: Uint8Array) => {
  const result = await createRobinhoodOfficialAssetSourceClient({
    fetch: (async () => new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof globalThis.fetch,
    now: () => new Date(observedAt),
  }).read(new AbortController().signal);
  if (result.status !== "observed") {
    throw new Error(`Expected an observed source result, received ${result.reason}.`);
  }
  return result.observation;
};

describe("official asset source", () => {
  it("accepts one complete response, normalizes ordering and addresses, and derives independent digests", async () => {
    const responseBytes = bytes({ assets: [
      asset(2, { deployments: [{ chainId: productChainNumericId, contractAddress: address(2).toUpperCase().replace("0X", "0x") }] }),
      asset(1),
    ], ignored: true });
    const snapshot = await readSnapshot(responseBytes);

    expect(Reflect.ownKeys(snapshot)).toEqual([
      "sourceUri",
      "sourceObservedAt",
      "rawResponseDigest",
      "memberSetDigest",
      "candidateListDigest",
      "chainId",
      "members",
    ]);
    expect(responseBytes.byteLength).toBe(565);
    expect(officialAssetSourceDefinition.sourceUri).toBe(expectedSourceUri);
    expect(snapshot.sourceUri).toBe(expectedSourceUri);
    expect(snapshot.rawResponseDigest).toBe(
      "0xdc0909e936f3b973b65fa50b7beb72685a50f49ca020b21ad41c0f662f3676ac",
    );
    expect(snapshot.rawResponseDigest).toBe(sha256(responseBytes));
    expect(snapshot.members.map(({ assetUid, contractAddress }) => ({ assetUid, contractAddress }))).toEqual([
      { assetUid: uid(1), contractAddress: address(1) },
      { assetUid: uid(2), contractAddress: address(2) },
    ]);
    const memberCanonical = `{"chainId":"eip155:4663","members":[{"assetUid":"${uid(1)}","contractAddress":"${address(1)}"},{"assetUid":"${uid(2)}","contractAddress":"${address(2)}"}],"sourceUri":"${expectedSourceUri}","version":"1"}`;
    const candidateCanonical = `{"chainId":"eip155:4663","members":[{"assetUid":"${uid(1)}","contractAddress":"${address(1)}","sourceName":"Token 1","sourceSymbol":"T1"},{"assetUid":"${uid(2)}","contractAddress":"${address(2)}","sourceName":"Token 2","sourceSymbol":"T2"}],"sourceUri":"${expectedSourceUri}","version":"1"}`;
    expect(snapshot.memberSetDigest).toBe(
      "0x74690e3965edcc0f971c20f4591ea3021f3a38f9cde62d5c90853325bf218540",
    );
    expect(snapshot.candidateListDigest).toBe(
      "0xee2118b01cb881612ba97558e0b392dbbecde83771548c06e6298d264bb93bdc",
    );
    expect(snapshot.memberSetDigest).toBe(sha256(memberCanonical));
    expect(snapshot.candidateListDigest).toBe(sha256(candidateCanonical));
    expect(Object.isFrozen(snapshot.members)).toBe(true);
  });

  it("treats invalid optional labels as unavailable without weakening identity", async () => {
    const snapshot = await readSnapshot(bytes({ assets: [asset(1, {
      tokenName: "",
      tokenSymbol: "🪙".repeat(129),
    })] }));
    expect(snapshot.members[0]).toEqual({ assetUid: uid(1), contractAddress: address(1) });
  });

  it("rejects every incomplete or ambiguous complete-set shape", async () => {
    const invalidResponses = [
      { assets: [] },
      { assets: [asset(1), asset(1)] },
      { assets: [asset(1), asset(2, { deployments: [{ chainId: productChainNumericId, contractAddress: address(1) }] })] },
      { assets: [asset(1, { status: "ASSET_STATUS_INACTIVE" })] },
      { assets: [asset(1, { deployments: [{ chainId: 1, contractAddress: address(1) }] })] },
      { assets: [asset(1, { deployments: [
        { chainId: productChainNumericId, contractAddress: address(1) },
        { chainId: productChainNumericId, contractAddress: address(2) },
      ] })] },
      { assets: [asset(1, { deployments: [
        { chainId: productChainNumericId, contractAddress: address(1) },
        { chainId: 1, contractAddress: "not-an-address" },
      ] })] },
      { assets: [asset(1, { id: `0x${"A".repeat(64)}` })] },
      { assets: Array.from(
        { length: expectedMemberLimit + 1 },
        (_, index) => asset(index + 1),
      ) },
    ];
    for (const response of invalidResponses) {
      await expect(createRobinhoodOfficialAssetSourceClient({
        fetch: (async () => new Response(bytes(response), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof globalThis.fetch,
      }).read(new AbortController().signal)).resolves.toEqual({
        status: "unavailable",
        reason: "source_inconsistent",
      });
    }
  });

  it("accepts the maximum complete source set without requiring an RPC dependency", async () => {
    const snapshot = await readSnapshot(bytes({
      assets: Array.from(
        { length: expectedMemberLimit },
        (_, index) => asset(index + 1),
      ),
    }));

    expect(snapshot.members).toHaveLength(expectedMemberLimit);
    expect(snapshot.members[0]?.assetUid).toBe(uid(1));
    expect(snapshot.members.at(-1)?.assetUid).toBe(
      uid(expectedMemberLimit),
    );
  });

  it("owns the exact HTTP request and response boundary", async () => {
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(input).toBe(expectedSourceUri);
      expect(init).toMatchObject({ method: "GET", redirect: "error", credentials: "omit" });
      expect(new Headers(init?.headers).get("accept")).toBe("application/json");
      expect(init?.body).toBeUndefined();
      return new Response(bytes({ assets: [asset(1)] }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    });
    const client = createRobinhoodOfficialAssetSourceClient({
      fetch: fetchFn as typeof globalThis.fetch,
      now: () => new Date(observedAt),
    });
    expect(Reflect.ownKeys(client)).toEqual(["read"]);
    expect(Object.isFrozen(client)).toBe(true);
    await expect(client.read(new AbortController().signal)).resolves.toMatchObject({
      status: "observed",
      observation: {
        sourceObservedAt: observedAt,
        members: [{ assetUid: uid(1), contractAddress: address(1) }],
      },
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("rejects wrong media, status, and declared or streamed oversize without a partial snapshot", async () => {
    const cases = [
      [new Response("{}", { status: 429, headers: { "content-type": "application/json" } }), "rate_limited"],
      [new Response("{}", { status: 500, headers: { "content-type": "application/json" } }), "source_unavailable"],
      [new Response("{}", { status: 200, headers: { "content-type": "text/plain" } }), "source_inconsistent"],
      [new Response("{}", {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-length": String(expectedResponseByteLimit + 1),
        },
      }), "official_asset_response_too_large"],
      [new Response(new Uint8Array(expectedResponseByteLimit + 1), {
        status: 200,
        headers: { "content-type": "application/json" },
      }), "official_asset_response_too_large"],
    ] as const;
    for (const [response, reason] of cases) {
      const client = createRobinhoodOfficialAssetSourceClient({
        fetch: (async () => response) as typeof globalThis.fetch,
      });
      await expect(client.read(new AbortController().signal)).resolves.toEqual({
        status: "unavailable",
        reason,
      });
    }
  });

  it("enforces the whole-response deadline even when the transport never settles", async () => {
    vi.useFakeTimers();
    try {
      const client = createRobinhoodOfficialAssetSourceClient({
        fetch: ((_input: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          })) as typeof globalThis.fetch,
      });
      const pending = client.read(new AbortController().signal);
      const result = expect(pending).resolves.toEqual({
        status: "unavailable",
        reason: "official_asset_response_unavailable",
      });
      await vi.advanceTimersByTimeAsync(10_000);
      await result;
    } finally {
      vi.useRealTimers();
    }
  });

  it("enforces the same deadline after headers arrive when the response body stalls", async () => {
    vi.useFakeTimers();
    try {
      const client = createRobinhoodOfficialAssetSourceClient({
        fetch: (async () => new Response(new ReadableStream<Uint8Array>({
          start() {},
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof globalThis.fetch,
      });
      const pending = client.read(new AbortController().signal);
      const result = expect(pending).resolves.toEqual({
        status: "unavailable",
        reason: "official_asset_response_unavailable",
      });
      await vi.advanceTimersByTimeAsync(10_000);
      await result;
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects invalid UTF-8, truncated JSON, and caller cancellation without a snapshot", async () => {
    for (const body of [
      new Uint8Array([0xc3, 0x28]),
      Buffer.from('{"assets":[', "utf8"),
    ]) {
      const client = createRobinhoodOfficialAssetSourceClient({
        fetch: (async () => new Response(body, {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof globalThis.fetch,
      });
      await expect(client.read(new AbortController().signal)).resolves.toEqual({
        status: "unavailable",
        reason: "source_inconsistent",
      });
    }

    const controller = new AbortController();
    controller.abort();
    const client = createRobinhoodOfficialAssetSourceClient({
      fetch: (async () => { throw new Error("fetch must not start"); }) as typeof globalThis.fetch,
    });
    await expect(client.read(controller.signal)).resolves.toEqual({
      status: "unavailable",
      reason: "request_aborted",
    });

    const activeController = new AbortController();
    const stalledClient = createRobinhoodOfficialAssetSourceClient({
      fetch: (async () => new Response(new ReadableStream<Uint8Array>({ start() {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch,
    });
    const pending = stalledClient.read(activeController.signal);
    activeController.abort();
    await expect(pending).resolves.toEqual({
      status: "unavailable",
      reason: "request_aborted",
    });
  });

  it("does not relabel invalid dependencies, responses, or clock values as source evidence", async () => {
    expect(() => createRobinhoodOfficialAssetSourceClient({
      fetch: null as never,
    })).toThrow(TypeError);
    expect(() => createRobinhoodOfficialAssetSourceClient({
      now: null as never,
    })).toThrow(TypeError);

    const invalidResponseClient = createRobinhoodOfficialAssetSourceClient({
      fetch: (async () => ({ status: 200 })) as unknown as typeof globalThis.fetch,
    });
    await expect(invalidResponseClient.read(new AbortController().signal)).rejects.toThrow(
      "invalid response",
    );

    const invalidClockClient = createRobinhoodOfficialAssetSourceClient({
      fetch: (async () => new Response(bytes({ assets: [asset(1)] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch,
      now: () => new Date(Number.NaN),
    });
    await expect(invalidClockClient.read(new AbortController().signal)).rejects.toThrow(
      "clock",
    );

    const nonByteResponse = new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    Object.defineProperty(nonByteResponse, "body", {
      value: {
        getReader: () => ({
          read: async () => ({ done: false, value: "not bytes" }),
          cancel: async () => undefined,
          releaseLock: () => undefined,
        }),
      },
    });
    const nonByteClient = createRobinhoodOfficialAssetSourceClient({
      fetch: (async () => nonByteResponse) as typeof globalThis.fetch,
    });
    await expect(nonByteClient.read(new AbortController().signal)).rejects.toThrow(
      "non-byte value",
    );
  });
});
