import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  createOfficialAssetSourceClient,
  getOfficialAssetSourceErrorCode,
  officialAssetSourceManifest,
} from "../../src/registry/index.js";
import {
  parseEvmAddress,
  parseHash32,
  productChainNumericId,
} from "../../src/core/index.js";

const observedAt = "2026-07-20T00:00:00.000Z";
const expectedSourceUri = "https://api.robinhood.com/rhj/assets";
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
const readSnapshot = async (body: Uint8Array) => await createOfficialAssetSourceClient({
  fetch: (async () => new Response(body, {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as typeof globalThis.fetch,
  now: () => new Date(observedAt),
}).read(new AbortController().signal);

describe("official asset source", () => {
  it("accepts one complete response, normalizes ordering and addresses, and derives independent digests", async () => {
    const responseBytes = bytes({ assets: [
      asset(2, { deployments: [{ chainId: productChainNumericId, contractAddress: address(2).toUpperCase().replace("0X", "0x") }] }),
      asset(1),
    ], ignored: true });
    const snapshot = await readSnapshot(responseBytes);

    expect(officialAssetSourceManifest.sourceUri).toBe(expectedSourceUri);
    expect(snapshot.sourceUri).toBe(expectedSourceUri);
    expect(snapshot.rawResponseDigest).toBe(sha256(responseBytes));
    expect(snapshot.members.map(({ assetUid, contractAddress }) => ({ assetUid, contractAddress }))).toEqual([
      { assetUid: uid(1), contractAddress: address(1) },
      { assetUid: uid(2), contractAddress: address(2) },
    ]);
    const memberCanonical = `{"chainId":"eip155:4663","members":[{"assetUid":"${uid(1)}","contractAddress":"${address(1)}"},{"assetUid":"${uid(2)}","contractAddress":"${address(2)}"}],"sourceUri":"${expectedSourceUri}","version":"1"}`;
    const candidateCanonical = `{"chainId":"eip155:4663","members":[{"assetUid":"${uid(1)}","contractAddress":"${address(1)}","sourceName":"Token 1","sourceSymbol":"T1"},{"assetUid":"${uid(2)}","contractAddress":"${address(2)}","sourceName":"Token 2","sourceSymbol":"T2"}],"sourceUri":"${expectedSourceUri}","version":"1"}`;
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
        { length: officialAssetSourceManifest.memberLimit + 1 },
        (_, index) => asset(index + 1),
      ) },
    ];
    for (const response of invalidResponses) {
      await expect(readSnapshot(bytes(response))).rejects.toSatisfy(
        (error: unknown) => getOfficialAssetSourceErrorCode(error) === "source_inconsistent",
      );
    }
  });

  it("accepts the maximum complete source set without requiring an RPC dependency", async () => {
    const snapshot = await readSnapshot(bytes({
      assets: Array.from(
        { length: officialAssetSourceManifest.memberLimit },
        (_, index) => asset(index + 1),
      ),
    }));

    expect(snapshot.members).toHaveLength(officialAssetSourceManifest.memberLimit);
    expect(snapshot.members[0]?.assetUid).toBe(uid(1));
    expect(snapshot.members.at(-1)?.assetUid).toBe(
      uid(officialAssetSourceManifest.memberLimit),
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
    const client = createOfficialAssetSourceClient({
      fetch: fetchFn as typeof globalThis.fetch,
      now: () => new Date(observedAt),
    });
    await expect(client.read(new AbortController().signal)).resolves.toMatchObject({
      sourceObservedAt: observedAt,
      members: [{ assetUid: uid(1), contractAddress: address(1) }],
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("rejects wrong media, status, and declared or streamed oversize without a partial snapshot", async () => {
    const cases = [
      new Response("{}", { status: 500, headers: { "content-type": "application/json" } }),
      new Response("{}", { status: 200, headers: { "content-type": "text/plain" } }),
      new Response("{}", {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-length": String(officialAssetSourceManifest.responseByteLimit + 1),
        },
      }),
      new Response(new Uint8Array(officialAssetSourceManifest.responseByteLimit + 1), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ];
    for (const response of cases) {
      const client = createOfficialAssetSourceClient({
        fetch: (async () => response) as typeof globalThis.fetch,
      });
      await expect(client.read(new AbortController().signal)).rejects.toSatisfy(
        (error: unknown) => getOfficialAssetSourceErrorCode(error) !== undefined,
      );
    }
  });

  it("enforces the whole-response deadline even when the transport never settles", async () => {
    vi.useFakeTimers();
    try {
      const client = createOfficialAssetSourceClient({
        fetch: ((_input: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          })) as typeof globalThis.fetch,
      });
      const pending = client.read(new AbortController().signal);
      const rejection = expect(pending).rejects.toSatisfy(
        (error: unknown) => getOfficialAssetSourceErrorCode(error) === "source_unavailable",
      );
      await vi.advanceTimersByTimeAsync(10_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("enforces the same deadline after headers arrive when the response body stalls", async () => {
    vi.useFakeTimers();
    try {
      const client = createOfficialAssetSourceClient({
        fetch: (async () => new Response(new ReadableStream<Uint8Array>({
          start() {},
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof globalThis.fetch,
      });
      const pending = client.read(new AbortController().signal);
      const rejection = expect(pending).rejects.toSatisfy(
        (error: unknown) => getOfficialAssetSourceErrorCode(error) === "source_unavailable",
      );
      await vi.advanceTimersByTimeAsync(10_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects invalid UTF-8, truncated JSON, and caller cancellation without a snapshot", async () => {
    for (const body of [
      new Uint8Array([0xc3, 0x28]),
      Buffer.from('{"assets":[', "utf8"),
    ]) {
      const client = createOfficialAssetSourceClient({
        fetch: (async () => new Response(body, {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof globalThis.fetch,
      });
      await expect(client.read(new AbortController().signal)).rejects.toSatisfy(
        (error: unknown) => getOfficialAssetSourceErrorCode(error) === "source_inconsistent",
      );
    }

    const controller = new AbortController();
    controller.abort();
    const client = createOfficialAssetSourceClient({
      fetch: (async () => { throw new Error("fetch must not start"); }) as typeof globalThis.fetch,
    });
    await expect(client.read(controller.signal)).rejects.toSatisfy(
      (error: unknown) => getOfficialAssetSourceErrorCode(error) === "request_aborted",
    );

    const activeController = new AbortController();
    const stalledClient = createOfficialAssetSourceClient({
      fetch: (async () => new Response(new ReadableStream<Uint8Array>({ start() {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch,
    });
    const pending = stalledClient.read(activeController.signal);
    activeController.abort();
    await expect(pending).rejects.toSatisfy(
      (error: unknown) => getOfficialAssetSourceErrorCode(error) === "request_aborted",
    );
  });
});
