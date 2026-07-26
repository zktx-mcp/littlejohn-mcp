import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createCanonicalClock,
  parseEvmAddress,
  parseEvmChainId,
  parseHexBytes,
} from "../../src/core/index.js";
import { createSourcifyContractSourceVerification } from "../../src/intelligence/sourcify.js";

const address = parseEvmAddress("0x1111111111111111111111111111111111111111");
const implementation = parseEvmAddress("0x2222222222222222222222222222222222222222");
const chainId = parseEvmChainId("eip155:4663");
const runtimeBytecode = parseHexBytes("0x6000");
const clock = () => createCanonicalClock(() => "2026-07-26T00:00:00.000Z");
const request = (signal = new AbortController().signal) => ({
  chainId,
  address,
  runtimeBytecode,
  signal,
});
const jsonResponse = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
const identity = {
  chainId: "4663",
  address,
};

afterEach(() => {
  vi.useRealTimers();
});

describe("Sourcify source verification adapter", () => {
  it("constructs the fixed request and admits exact, non-exact, and exact no-record results", async () => {
    const seen: string[] = [];
    const values = [
      jsonResponse({
        ...identity,
        runtimeMatch: "exact_match",
        runtimeBytecode: { onchainBytecode: runtimeBytecode },
        abi: [],
      }),
      jsonResponse({ ...identity, runtimeMatch: "match" }),
      jsonResponse({
        ...identity,
        match: null,
        creationMatch: null,
        runtimeMatch: null,
      }, 404),
    ];
    const adapter = createSourcifyContractSourceVerification({
      clock: clock(),
      fetch: async (input, init) => {
        seen.push(String(input));
        expect(init).toMatchObject({
          method: "GET",
          redirect: "error",
          headers: { accept: "application/json" },
        });
        return values.shift()!;
      },
    });
    await expect(adapter.port.inspect(request())).resolves.toMatchObject({
      status: "exact_match",
      exactInterface: {
        declaredFunctions: [],
        owner: "not_declared",
        paused: "not_declared",
        defaultAdmins: "not_declared",
      },
    });
    await expect(adapter.port.inspect(request())).resolves.toMatchObject({
      status: "non_exact_match",
    });
    await expect(adapter.port.inspect(request())).resolves.toMatchObject({
      status: "no_record_observed",
    });
    expect(new Set(seen)).toEqual(new Set([
      `https://sourcify.dev/server/v2/contract/4663/${address}` +
        "?fields=abi%2CruntimeBytecode.onchainBytecode",
    ]));
  });

  it("separates contradictory responses from provider availability failures", async () => {
    const responses = [
      jsonResponse({ ...identity, address: "0x2222222222222222222222222222222222222222", runtimeMatch: "match" }),
      jsonResponse({ ...identity, chainId: "1", runtimeMatch: "match" }),
      jsonResponse({
        ...identity,
        runtimeMatch: "exact_match",
        runtimeBytecode: { onchainBytecode: "0x6001" },
        abi: [],
      }),
      jsonResponse({
        ...identity,
        runtimeMatch: "exact_match",
        runtimeBytecode: { onchainBytecode: "0xzz" },
        abi: [],
      }),
      jsonResponse({
        ...identity,
        runtimeMatch: "exact_match",
        runtimeBytecode: { onchainBytecode: runtimeBytecode },
        abi: [{ type: "function", name: 1 }],
      }),
      jsonResponse({ ...identity, runtimeMatch: null }, 404),
      jsonResponse({ error: "temporarily unavailable" }, 503),
      new Response("{", { headers: { "content-type": "application/json" } }),
    ];
    const adapter = createSourcifyContractSourceVerification({
      clock: clock(),
      fetch: async () => responses.shift()!,
    });
    for (const expected of [
      "inconsistent",
      "inconsistent",
      "inconsistent",
      "inconsistent",
      "inconsistent",
      "inconsistent",
      "unavailable",
      "inconsistent",
    ]) {
      await expect(adapter.port.inspect(request())).resolves.toMatchObject({ status: expected });
    }
  });

  it("classifies the complete admitted control interface from exact ABI items", async () => {
    const abi = [
      { type: "function", name: "owner", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
      { type: "function", name: "transferOwnership", inputs: [{ type: "address" }], outputs: [], stateMutability: "nonpayable" },
      {
        type: "event",
        name: "OwnershipTransferred",
        anonymous: false,
        inputs: [
          { type: "address", indexed: true },
          { type: "address", indexed: true },
        ],
      },
      { type: "function", name: "paused", inputs: [], outputs: [{ type: "bool" }], stateMutability: "view" },
      { type: "function", name: "DEFAULT_ADMIN_ROLE", inputs: [], outputs: [{ type: "bytes32" }], stateMutability: "view" },
      { type: "function", name: "hasRole", inputs: [{ type: "bytes32" }, { type: "address" }], outputs: [{ type: "bool" }], stateMutability: "view" },
      { type: "function", name: "getRoleAdmin", inputs: [{ type: "bytes32" }], outputs: [{ type: "bytes32" }], stateMutability: "view" },
      { type: "function", name: "grantRole", inputs: [{ type: "bytes32" }, { type: "address" }], outputs: [], stateMutability: "nonpayable" },
      { type: "function", name: "revokeRole", inputs: [{ type: "bytes32" }, { type: "address" }], outputs: [], stateMutability: "nonpayable" },
      { type: "function", name: "renounceRole", inputs: [{ type: "bytes32" }, { type: "address" }], outputs: [], stateMutability: "nonpayable" },
      { type: "function", name: "getRoleMember", inputs: [{ type: "bytes32" }, { type: "uint256" }], outputs: [{ type: "address" }], stateMutability: "view" },
      { type: "function", name: "getRoleMemberCount", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
    ];
    const adapter = createSourcifyContractSourceVerification({
      clock: clock(),
      fetch: async () => jsonResponse({
        ...identity,
        runtimeMatch: "exact_match",
        runtimeBytecode: { onchainBytecode: runtimeBytecode },
        abi,
      }),
    });
    const result = await adapter.port.inspect(request());
    expect(result).toMatchObject({
      status: "exact_match",
      exactInterface: {
        owner: "erc173",
        paused: "declared",
        defaultAdmins: "enumerable",
      },
    });
    if (result.status !== "exact_match" || result.exactInterface === undefined) {
      throw new TypeError("Expected an exact interface.");
    }
    expect(result.exactInterface.declaredFunctions).toEqual(
      [...result.exactInterface.declaredFunctions].sort(),
    );
  });

  it("does not treat an anonymous OwnershipTransferred event as ERC-173", async () => {
    const abi = [
      {
        type: "function",
        name: "owner",
        inputs: [],
        outputs: [{ type: "address" }],
        stateMutability: "view",
      },
      {
        type: "function",
        name: "transferOwnership",
        inputs: [{ type: "address" }],
        outputs: [],
        stateMutability: "nonpayable",
      },
      {
        type: "event",
        name: "OwnershipTransferred",
        anonymous: true,
        inputs: [
          { type: "address", indexed: true },
          { type: "address", indexed: true },
        ],
      },
    ];
    const adapter = createSourcifyContractSourceVerification({
      clock: clock(),
      fetch: async () => jsonResponse({
        ...identity,
        runtimeMatch: "exact_match",
        runtimeBytecode: { onchainBytecode: runtimeBytecode },
        abi,
      }),
    });
    await expect(adapter.port.inspect(request())).resolves.toMatchObject({
      status: "exact_match",
      exactInterface: { owner: "not_declared" },
    });
  });

  it("cancels an oversized stream before releasing its active slot", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1_048_577));
      },
      cancel() {
        cancelled = true;
      },
    });
    const adapter = createSourcifyContractSourceVerification({
      clock: clock(),
      fetch: async () => new Response(body, {
        headers: { "content-type": "application/json" },
      }),
    });
    await expect(adapter.port.inspect(request())).resolves.toMatchObject({ status: "unavailable" });
    expect(cancelled).toBe(true);
  });

  it("uses one exact public URI for each requested proxy address", async () => {
    const seen: string[] = [];
    const adapter = createSourcifyContractSourceVerification({
      clock: clock(),
      fetch: async (input) => {
        seen.push(String(input));
        const requestedAddress = String(input).includes(address) ? address : implementation;
        return jsonResponse({
          chainId: "4663",
          address: requestedAddress,
          match: null,
          creationMatch: null,
          runtimeMatch: null,
        }, 404);
      },
    });
    await Promise.all([
      adapter.port.inspect(request()),
      adapter.port.inspect({ ...request(), address: implementation }),
    ]);
    expect(seen.sort()).toEqual([
      `https://sourcify.dev/server/v2/contract/4663/${address}` +
        "?fields=abi%2CruntimeBytecode.onchainBytecode",
      `https://sourcify.dev/server/v2/contract/4663/${implementation}` +
        "?fields=abi%2CruntimeBytecode.onchainBytecode",
    ]);
  });

  it("distinguishes cancellation before fetch, during headers, and during body cleanup", async () => {
    const before = new AbortController();
    before.abort();
    const unusedFetch = vi.fn<typeof fetch>();
    const beforeAdapter = createSourcifyContractSourceVerification({
      clock: clock(),
      fetch: unusedFetch,
    });
    await expect(beforeAdapter.port.inspect(request(before.signal))).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(unusedFetch).not.toHaveBeenCalled();

    const headersController = new AbortController();
    let headersStarted = false;
    const headersAdapter = createSourcifyContractSourceVerification({
      clock: clock(),
      fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
        headersStarted = true;
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }),
    });
    const duringHeaders = headersAdapter.port.inspect(request(headersController.signal));
    await vi.waitFor(() => expect(headersStarted).toBe(true));
    headersController.abort();
    await expect(duringHeaders).rejects.toMatchObject({ name: "AbortError" });

    const bodyController = new AbortController();
    let bodyReadStarted = false;
    let bodyCancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull() {
        bodyReadStarted = true;
        return new Promise<void>(() => undefined);
      },
      cancel() {
        bodyCancelled = true;
      },
    });
    const bodyAdapter = createSourcifyContractSourceVerification({
      clock: clock(),
      fetch: async () => new Response(body, {
        headers: { "content-type": "application/json" },
      }),
    });
    const duringBody = bodyAdapter.port.inspect(request(bodyController.signal));
    await vi.waitFor(() => expect(bodyReadStarted).toBe(true));
    bodyController.abort();
    await expect(duringBody).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(bodyCancelled).toBe(true));
  });

  it("consumes body cleanup rejection without retaining request capacity", async () => {
    const response = () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1_048_577));
      },
      cancel() {
        throw new Error("cleanup failed");
      },
    }), {
      headers: { "content-type": "application/json" },
    });
    const adapter = createSourcifyContractSourceVerification({
      clock: clock(),
      fetch: async () => response(),
    });
    for (let index = 0; index < 5; index += 1) {
      await expect(adapter.port.inspect(request())).resolves.toMatchObject({
        status: "unavailable",
      });
    }
  });

  it("holds four active requests, rejects a fifth without a queue, and drains caller cancellation", async () => {
    const adapter = createSourcifyContractSourceVerification({
      clock: clock(),
      fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }),
    });
    const controllers = Array.from({ length: 4 }, () => new AbortController());
    const active = controllers.map((controller) => adapter.port.inspect(request(controller.signal)));
    await expect(adapter.port.inspect(request())).resolves.toMatchObject({ status: "unavailable" });
    for (const controller of controllers) controller.abort();
    for (const pending of active) await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("returns unavailable at the deadline while retaining the ignored fetch until it settles", async () => {
    vi.useFakeTimers();
    const settles: Array<(response: Response) => void> = [];
    const adapter = createSourcifyContractSourceVerification({
      clock: clock(),
      fetch: async () => new Promise<Response>((resolve) => {
        settles.push(resolve);
      }),
    });
    const pending = adapter.port.inspect(request());
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toMatchObject({ status: "unavailable" });
    const retained = Array.from({ length: 3 }, () => adapter.port.inspect(request()));
    await expect(adapter.port.inspect(request())).resolves.toMatchObject({ status: "unavailable" });
    for (const settle of settles) settle(jsonResponse({ ...identity, runtimeMatch: "match" }));
    for (const requestResult of retained) {
      await expect(requestResult).resolves.toMatchObject({ status: "non_exact_match" });
    }
    await vi.runAllTimersAsync();
  });
});
