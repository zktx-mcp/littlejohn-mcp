import { afterEach, describe, expect, it, vi } from "vitest";

import {
  canonicalBlockReference,
  ChainRpcError,
  createBoundedRpcRequester,
  isRpcBatchRejectedError,
  isRpcExecutionRevertedError,
  normalizeChainRpcError,
  type RpcRequester,
} from "../../src/chain/rpc.js";
import { rpcConcurrencyLimit } from "../../src/chain/limits.js";
import { parseEvmAddress, parseHash32, parseHexBytes } from "../../src/core/index.js";

const stateAddress = parseEvmAddress(`0x${"a".repeat(40)}`);
const stateBlockHash = parseHash32(`0x${"b".repeat(64)}`);
const stateReference = canonicalBlockReference(stateBlockHash);

type JsonRpcRequest = Readonly<{
  jsonrpc: "2.0";
  id: string;
  method: string;
  params: readonly unknown[];
}>;

const requestFrom = (init: RequestInit | undefined): JsonRpcRequest => {
  if (typeof init?.body !== "string") throw new TypeError("Expected a string request body.");
  return JSON.parse(init.body) as JsonRpcRequest;
};

const resultResponse = (init: RequestInit | undefined, result: unknown): Response => {
  const request = requestFrom(init);
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

const fetchOf = (
  implementation: (input: string | URL | Request, init: RequestInit | undefined) => Promise<Response>,
): typeof globalThis.fetch => implementation as typeof globalThis.fetch;

const expectCode = async (
  promise: Promise<unknown>,
  code: ChainRpcError["code"],
): Promise<ChainRpcError> => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ChainRpcError);
    expect(error).toMatchObject({ code });
    return error as ChainRpcError;
  }
  throw new Error(`Expected ${code}.`);
};

const expectExecutionRevert = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    expect(error).not.toBeInstanceOf(ChainRpcError);
    expect(isRpcExecutionRevertedError(error)).toBe(true);
    return error;
  }
  throw new Error("Expected an execution revert.");
};

describe("bounded RPC requester", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends one unbatched JSON-RPC request with the caller abort signal", async () => {
    const fetchFn = vi.fn(fetchOf(async (input, init) => {
      expect(input).toBe("https://rpc.example/read?network=mainnet");
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      expect(init?.credentials).toBe("omit");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const headers = new Headers(init?.headers);
      expect(headers.get("accept")).toBe("application/json");
      expect(headers.get("content-type")).toBe("application/json");
      const request = requestFrom(init);
      expect(request).toEqual({
        jsonrpc: "2.0",
        id: expect.stringMatching(/^[1-9][0-9]*$/u),
        method: "eth_getBlockByNumber",
        params: ["latest", false],
      });
      return resultResponse(init, { number: "0x123" });
    }));
    const requester = createBoundedRpcRequester({
      url: "https://rpc.example/read?network=mainnet",
      fetch: fetchFn,
    });

    await expect(
      requester.request("eth_getBlockByNumber", ["latest", false], new AbortController().signal),
    ).resolves.toEqual({ number: "0x123" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("sends state reads against one exact canonical block hash", async () => {
    const fetchFn = vi.fn(fetchOf(async (_input, init) => {
      expect(requestFrom(init)).toEqual({
        jsonrpc: "2.0",
        id: expect.stringMatching(/^[1-9][0-9]*$/u),
        method: "eth_getBalance",
        params: [stateAddress, { blockHash: stateBlockHash, requireCanonical: true }],
      });
      return resultResponse(init, "0x1");
    }));
    const requester = createBoundedRpcRequester({ url: "https://rpc.example", fetch: fetchFn });

    await expect(requester.request(
      "eth_getBalance",
      [stateAddress, stateReference],
      new AbortController().signal,
    )).resolves.toBe("0x1");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("returns batch results in request order while preserving per-call reverts", async () => {
    const fetchFn = vi.fn(fetchOf(async (_input, init) => {
      if (typeof init?.body !== "string") throw new TypeError("Expected a string request body.");
      const requests = JSON.parse(init.body) as JsonRpcRequest[];
      expect(requests).toHaveLength(2);
      return new Response(JSON.stringify([{
        jsonrpc: "2.0",
        id: requests[1]!.id,
        error: { code: 3, message: "execution reverted", data: "0x" },
      }, {
        jsonrpc: "2.0",
        id: requests[0]!.id,
        result: "0x01",
      }]));
    }));
    const requester = createBoundedRpcRequester({ url: "https://rpc.example", fetch: fetchFn });
    if (requester.requestBatch === undefined) throw new TypeError("Expected batch support.");
    const results = await requester.requestBatch([{
      method: "eth_call",
      params: [{ to: stateAddress, data: parseHexBytes("0x01") }, stateReference],
    }, {
      method: "eth_call",
      params: [{ to: stateAddress, data: parseHexBytes("0x02") }, stateReference],
    }], new AbortController().signal);

    expect(results[0]).toEqual({ status: "fulfilled", value: "0x01" });
    expect(results[1]?.status).toBe("rejected");
    if (results[1]?.status !== "rejected") throw new TypeError("Expected a rejected batch item.");
    expect(isRpcExecutionRevertedError(results[1].reason)).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("admits thirty-two ordered calls and rejects other batch cardinalities before fetch", async () => {
    const observedBatchSizes: number[] = [];
    const fetchFn = vi.fn(fetchOf(async (_input, init) => {
      if (typeof init?.body !== "string") throw new TypeError("Expected a string request body.");
      const requests = JSON.parse(init.body) as JsonRpcRequest[];
      observedBatchSizes.push(requests.length);
      return new Response(JSON.stringify(requests.map((request, index) => ({
        jsonrpc: "2.0",
        id: request.id,
        result: `result-${index}`,
      })).reverse()));
    }));
    const requester = createBoundedRpcRequester({ url: "https://rpc.example", fetch: fetchFn });
    if (requester.requestBatch === undefined) throw new TypeError("Expected batch support.");
    const exactBatch = Array.from({ length: 32 }, () => ({
      method: "eth_chainId" as const,
      params: [] as const,
    }));

    await expect(requester.requestBatch(
      exactBatch,
      new AbortController().signal,
    )).resolves.toEqual(Array.from({ length: 32 }, (_, index) => ({
      status: "fulfilled",
      value: `result-${index}`,
    })));
    await expect(requester.requestBatch(
      [],
      new AbortController().signal,
    )).rejects.toThrow("RPC batch size is invalid.");
    await expect(requester.requestBatch(
      Array.from({ length: 33 }, () => ({
        method: "eth_chainId" as const,
        params: [] as const,
      })),
      new AbortController().signal,
    )).rejects.toThrow("RPC batch size is invalid.");
    expect(observedBatchSizes).toEqual([32]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("distinguishes a canonical provider batch rejection from malformed transport data", async () => {
    const requester = createBoundedRpcRequester({
      url: "https://rpc.example",
      fetch: fetchOf(async () => new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "batch unsupported" },
      }))),
    });
    if (requester.requestBatch === undefined) throw new TypeError("Expected batch support.");
    try {
      await requester.requestBatch([{
        method: "eth_call",
        params: [{ to: stateAddress, data: parseHexBytes("0x01") }, stateReference],
      }], new AbortController().signal);
      throw new Error("Expected a batch rejection.");
    } catch (error) {
      expect(isRpcBatchRejectedError(error)).toBe(true);
    }
  });

  it("admits exact storage reads and gas-bounded calls without widening other parameters", async () => {
    const slot = parseHash32(`0x${"c".repeat(64)}`);
    const fetchFn = vi.fn(fetchOf(async (_input, init) => {
      const request = requestFrom(init);
      if (request.method === "eth_getStorageAt") {
        expect(request.params).toEqual([stateAddress, slot, {
          blockHash: stateBlockHash,
          requireCanonical: true,
        }]);
        return resultResponse(init, `0x${"0".repeat(64)}`);
      }
      expect(request).toMatchObject({
        method: "eth_call",
        params: [{ to: stateAddress, data: "0x01", gas: "0x7530" }, {
          blockHash: stateBlockHash,
          requireCanonical: true,
        }],
      });
      return resultResponse(init, `0x${"0".repeat(64)}`);
    }));
    const requester = createBoundedRpcRequester({ url: "https://rpc.example", fetch: fetchFn });
    await requester.request("eth_getStorageAt", [stateAddress, slot, stateReference], new AbortController().signal);
    await requester.request("eth_call", [{
      to: stateAddress,
      data: parseHexBytes("0x01"),
      gas: "0x7530",
    }, stateReference], new AbortController().signal);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("carries a complete type-2 simulation request and the exact nonce/finality reads", async () => {
    const requests: JsonRpcRequest[] = [];
    const fetchFn = vi.fn(fetchOf(async (_input, init) => {
      requests.push(requestFrom(init));
      return resultResponse(init, "0x5208");
    }));
    const requester = createBoundedRpcRequester({ url: "https://rpc.example", fetch: fetchFn });
    const call = {
      to: stateAddress, from: stateAddress, data: parseHexBytes("0x01"), value: "0x0",
      gas: "0x5208", nonce: "0x7", chainId: "0x1237", type: "0x2",
      accessList: [], maxFeePerGas: "0x5", maxPriorityFeePerGas: "0x1",
    } as const;
    const signal = new AbortController().signal;
    await requester.request("eth_estimateGas", [call, stateReference], signal);
    await requester.request("eth_call", [call, stateReference], signal);
    await requester.request("eth_getTransactionCount", [stateAddress, "pending"], signal);
    await requester.request("eth_getBlockByNumber", ["finalized", false], signal);
    await requester.request("eth_gasPrice", [], signal);
    await requester.request("eth_maxPriorityFeePerGas", [], signal);
    expect(requests.map((request) => [request.method, request.params])).toEqual([
      ["eth_estimateGas", [call, stateReference]], ["eth_call", [call, stateReference]],
      ["eth_getTransactionCount", [stateAddress, "pending"]], ["eth_getBlockByNumber", ["finalized", false]],
      ["eth_gasPrice", []], ["eth_maxPriorityFeePerGas", []],
    ]);
    const unsafe = requester as unknown as { request(method: string, params: unknown[], signal: AbortSignal): Promise<unknown> };
    for (const changed of [{ type: "0x0" }, { gasPrice: "0x1" }, { maxPriorityFeePerGas: "0x6" }, { accessList: [stateAddress] }]) {
      await expect(unsafe.request("eth_call", [{ ...call, ...changed }, stateReference], signal)).rejects.toThrow();
    }
    expect(fetchFn).toHaveBeenCalledTimes(6);
  });

  it("classifies estimation refusal without claiming that a provider contradicted chain state", async () => {
    const requester = createBoundedRpcRequester({
      url: "https://rpc.example",
      fetch: fetchOf(async (_input, init) => new Response(JSON.stringify({
        jsonrpc: "2.0", id: requestFrom(init).id,
        error: { code: -32000, message: "execution cannot be estimated" },
      }))),
    });
    await expectCode(requester.request("eth_estimateGas", [{ to: stateAddress, data: parseHexBytes("0x") }, stateReference],
      new AbortController().signal), "chain_response_unavailable");
  });

  it("supports credential-bearing configuration without exposing credentials in the fetch URL or error", async () => {
    const secret = "provider-secret";
    const fetchFn = vi.fn(fetchOf(async (input, init) => {
      expect(input).toBe("https://rpc.example/private?key=query-secret");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(
        `Basic ${Buffer.from(`user:${secret}`, "utf8").toString("base64")}`,
      );
      throw new Error(`do not expose ${secret} query-secret`);
    }));
    const requester = createBoundedRpcRequester({
      url: `https://user:${secret}@rpc.example/private?key=query-secret`,
      fetch: fetchFn,
    });

    const error = await expectCode(
      requester.request("eth_chainId", [], new AbortController().signal),
      "chain_response_unavailable",
    );
    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain("query-secret");
    expect(error).not.toHaveProperty("cause");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("rejects an inadmissible target before request serialization or external work", () => {
    const fetchFn = vi.fn(fetchOf(async (_input, init) => resultResponse(init, "0x1237")));

    expect(() => createBoundedRpcRequester({
      url: "http://user:plaintext-secret@rpc.example/private",
      fetch: fetchFn,
    })).toThrow("RPC URL is invalid.");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("admits only exact undefined as an omitted requester setting", async () => {
    const fetchFn = vi.fn(fetchOf(async (_input, init) => resultResponse(init, "0x1237")));
    const createWithUnknownSettings = createBoundedRpcRequester as unknown as (options: {
      readonly url: string;
      readonly fetch?: unknown;
      readonly timeoutMs?: unknown;
    }) => RpcRequester;
    vi.stubGlobal("fetch", fetchFn);
    let requester: RpcRequester;
    try {
      requester = createWithUnknownSettings({
        url: "https://rpc.example",
        fetch: undefined,
        timeoutMs: undefined,
      });
      expect(() => createWithUnknownSettings({
        url: "https://rpc.example",
        fetch: null,
      })).toThrow("RPC fetch implementation is unavailable.");
      expect(() => createWithUnknownSettings({
        url: "https://rpc.example",
        timeoutMs: null,
      })).toThrow("RPC timeout is invalid.");
      expect(() => createWithUnknownSettings({
        url: "https://rpc.example",
        fetch: "not-a-function",
      })).toThrow("RPC fetch implementation is unavailable.");
    } finally {
      vi.unstubAllGlobals();
    }

    await expect(
      requester.request("eth_chainId", [], new AbortController().signal),
    ).resolves.toBe("0x1237");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("rejects the seventeenth process-wide external request without starting it", async () => {
    const completions: Array<Readonly<{ init: RequestInit | undefined; resolve: (response: Response) => void }>> = [];
    const fetchFn = vi.fn(fetchOf(async (_input, init) =>
      await new Promise<Response>((resolve) => completions.push({ init, resolve }))
    ));
    const first = createBoundedRpcRequester({ url: "https://rpc-one.example", fetch: fetchFn });
    const second = createBoundedRpcRequester({ url: "https://rpc-two.example", fetch: fetchFn });
    const active = Array.from({ length: 16 }, (_, index) =>
      (index % 2 === 0 ? first : second)
        .request("eth_chainId", [], new AbortController().signal)
    );
    const observedActive = Promise.allSettled(active);
    let observedSeventeenth: Promise<readonly PromiseSettledResult<unknown>[]> | undefined;
    let activeOutcomes: readonly PromiseSettledResult<unknown>[] = [];

    try {
      expect(fetchFn).toHaveBeenCalledTimes(16);
      observedSeventeenth = Promise.allSettled([
        second.request("eth_chainId", [], new AbortController().signal),
      ]);
      expect(fetchFn).toHaveBeenCalledTimes(16);

      const [outcome] = await observedSeventeenth;
      if (outcome === undefined) throw new TypeError("Expected capacity outcome.");
      expect(outcome.status).toBe("rejected");
      if (outcome.status !== "rejected") throw new TypeError("Expected capacity rejection.");
      expect(outcome.reason).toBeInstanceOf(ChainRpcError);
      expect(outcome.reason).toMatchObject({ code: "runtime_busy" });
    } finally {
      for (const completion of completions) {
        completion.resolve(resultResponse(completion.init, "0x1237"));
      }
      activeOutcomes = await observedActive;
      if (observedSeventeenth !== undefined) await observedSeventeenth;
    }

    expect(activeOutcomes).toEqual(Array.from({ length: 16 }, () => ({
      status: "fulfilled",
      value: "0x1237",
    })));
  });

  it("releases every acquired request resource when local setup fails", async () => {
    const setupFetch = vi.fn(fetchOf(async (_input, init) => resultResponse(init, "0x1237")));
    const requester = createBoundedRpcRequester({ url: "https://rpc.example", fetch: setupFetch });

    {
      const failure = new Error("controller setup failure");
      const callerSignal = new AbortController().signal;
      vi.stubGlobal("AbortController", class {
        constructor() {
          throw failure;
        }
      });
      const pending = requester.request("eth_chainId", [], callerSignal);
      const observed = Promise.allSettled([pending]);
      vi.unstubAllGlobals();
      const [outcome] = await observed;
      expect(outcome).toEqual({ status: "rejected", reason: failure });
    }

    {
      const failure = new Error("listener setup failure");
      const callerSignal = new AbortController().signal;
      const addListener = vi.spyOn(AbortSignal.prototype, "addEventListener")
        .mockImplementation(() => { throw failure; });
      const removeListener = vi.spyOn(AbortSignal.prototype, "removeEventListener")
        .mockImplementation(() => undefined);
      const pending = requester.request("eth_chainId", [], callerSignal);
      const observed = Promise.allSettled([pending]);
      let outcome: PromiseSettledResult<unknown> | undefined;
      try {
        expect(addListener).toHaveBeenCalledTimes(1);
        expect(removeListener).not.toHaveBeenCalled();
      } finally {
        vi.restoreAllMocks();
        [outcome] = await observed;
      }
      expect(outcome).toEqual({ status: "rejected", reason: failure });
    }

    {
      const failure = new Error("timer setup failure");
      const callerSignal = new AbortController().signal;
      const addListener = vi.spyOn(AbortSignal.prototype, "addEventListener");
      const removeListener = vi.spyOn(AbortSignal.prototype, "removeEventListener");
      vi.stubGlobal("setTimeout", vi.fn(() => { throw failure; }));
      const pending = requester.request("eth_chainId", [], callerSignal);
      const observed = Promise.allSettled([pending]);
      let outcome: PromiseSettledResult<unknown> | undefined;
      try {
        expect(addListener).toHaveBeenCalledTimes(1);
        expect(removeListener).toHaveBeenCalledTimes(1);
      } finally {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        [outcome] = await observed;
      }
      expect(outcome).toEqual({ status: "rejected", reason: failure });
    }

    {
      const failure = new Error("timer unref failure");
      const callerSignal = new AbortController().signal;
      const fakeTimeout = Object.freeze({ unref: () => { throw failure; } });
      const clearTimeoutFn = vi.fn();
      const addListener = vi.spyOn(AbortSignal.prototype, "addEventListener");
      const removeListener = vi.spyOn(AbortSignal.prototype, "removeEventListener");
      vi.stubGlobal("setTimeout", vi.fn(() => fakeTimeout));
      vi.stubGlobal("clearTimeout", clearTimeoutFn);
      const pending = requester.request("eth_chainId", [], callerSignal);
      const observed = Promise.allSettled([pending]);
      let outcome: PromiseSettledResult<unknown> | undefined;
      try {
        expect(addListener).toHaveBeenCalledTimes(1);
        expect(removeListener).toHaveBeenCalledTimes(1);
        expect(clearTimeoutFn).toHaveBeenCalledTimes(1);
        expect(clearTimeoutFn).toHaveBeenCalledWith(fakeTimeout);
      } finally {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        [outcome] = await observed;
      }
      expect(outcome).toEqual({ status: "rejected", reason: failure });
    }

    expect(setupFetch).not.toHaveBeenCalled();

    const completions: Array<Readonly<{ init: RequestInit | undefined; resolve: (response: Response) => void }>> = [];
    const capacityFetch = vi.fn(fetchOf(async (_input, init) =>
      await new Promise<Response>((resolve) => completions.push({ init, resolve }))
    ));
    const capacityRequester = createBoundedRpcRequester({
      url: "https://rpc.example",
      fetch: capacityFetch,
    });
    const active = Array.from({ length: rpcConcurrencyLimit }, () =>
      capacityRequester.request("eth_chainId", [], new AbortController().signal)
    );
    const observedActive = Promise.allSettled(active);
    let observedExcess: Promise<readonly PromiseSettledResult<unknown>[]> | undefined;
    let activeOutcomes: readonly PromiseSettledResult<unknown>[] = [];

    try {
      expect(capacityFetch).toHaveBeenCalledTimes(rpcConcurrencyLimit);
      observedExcess = Promise.allSettled([
        capacityRequester.request("eth_chainId", [], new AbortController().signal),
      ]);
      expect(capacityFetch).toHaveBeenCalledTimes(rpcConcurrencyLimit);
      const [outcome] = await observedExcess;
      if (outcome === undefined) throw new TypeError("Expected capacity outcome.");
      expect(outcome.status).toBe("rejected");
      if (outcome.status !== "rejected") throw new TypeError("Expected capacity rejection.");
      expect(outcome.reason).toBeInstanceOf(ChainRpcError);
      expect(outcome.reason).toMatchObject({ code: "runtime_busy" });
    } finally {
      for (const completion of completions) {
        completion.resolve(resultResponse(completion.init, "0x1237"));
      }
      activeOutcomes = await observedActive;
      if (observedExcess !== undefined) await observedExcess;
    }

    expect(activeOutcomes).toEqual(Array.from({ length: rpcConcurrencyLimit }, () => ({
      status: "fulfilled",
      value: "0x1237",
    })));
  });

  it("does not call fetch for an already aborted request", async () => {
    const fetchFn = vi.fn(fetchOf(async (_input, init) => resultResponse(init, "0x1237")));
    const requester = createBoundedRpcRequester({ url: "https://rpc.example", fetch: fetchFn });
    const controller = new AbortController();
    controller.abort();

    await expectCode(requester.request("eth_chainId", [], controller.signal), "request_aborted");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("propagates in-flight cancellation and returns no late result", async () => {
    let fetchSignal: AbortSignal | undefined;
    let settleFetch: (() => void) | undefined;
    const fetchFn = vi.fn(fetchOf(async (_input, init) => {
      fetchSignal = init?.signal ?? undefined;
      return await new Promise<Response>((_resolve, reject) => {
        let settled = false;
        const rejectProvider = (): void => {
          if (settled) return;
          settled = true;
          reject(new Error("provider cancellation detail"));
        };
        settleFetch = rejectProvider;
        fetchSignal?.addEventListener(
          "abort",
          rejectProvider,
          { once: true },
        );
      });
    }));
    const requester = createBoundedRpcRequester({ url: "https://rpc.example", fetch: fetchFn });
    const controller = new AbortController();
    const pending = requester.request("eth_chainId", [], controller.signal);
    const observed = pending.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    );
    let outcome: Awaited<typeof observed> | undefined;

    try {
      expect(fetchFn).toHaveBeenCalledTimes(1);
      controller.abort();
      expect(fetchSignal?.aborted).toBe(true);
      outcome = await observed;
    } finally {
      settleFetch?.();
      controller.abort();
      await observed;
    }

    expect(outcome?.status).toBe("rejected");
    if (outcome?.status !== "rejected") throw new TypeError("Expected caller cancellation.");
    expect(outcome.reason).toBeInstanceOf(ChainRpcError);
    expect(outcome.reason).toMatchObject({ code: "request_aborted" });
    expect((outcome.reason as ChainRpcError).message)
      .not.toContain("provider cancellation detail");
  });

  it("applies the default request deadline at exactly ten thousand milliseconds", async () => {
    vi.useFakeTimers();
    let fetchSignal: AbortSignal | undefined;
    let settleFetch: (() => void) | undefined;
    const fetchFn = vi.fn(fetchOf(async (_input, init) => {
      fetchSignal = init?.signal ?? undefined;
      return await new Promise<Response>((_resolve, reject) => {
        let settled = false;
        const rejectProvider = (): void => {
          if (settled) return;
          settled = true;
          reject(new Error("secret provider timeout text"));
        };
        settleFetch = rejectProvider;
        fetchSignal?.addEventListener(
          "abort",
          rejectProvider,
          { once: true },
        );
      });
    }));
    const requester = createBoundedRpcRequester({ url: "https://rpc.example", fetch: fetchFn });
    const caller = new AbortController();
    const addCallerListener = vi.spyOn(caller.signal, "addEventListener");
    const removeCallerListener = vi.spyOn(caller.signal, "removeEventListener");
    const pending = requester.request("eth_chainId", [], caller.signal);
    const observed = pending.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    );
    let requestSettled = false;
    void observed.then(() => { requestSettled = true; });
    let outcome: Awaited<typeof observed> | undefined;

    try {
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(addCallerListener).toHaveBeenCalledTimes(1);
      expect(fetchSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(9_999);
      expect(fetchSignal?.aborted).toBe(false);
      expect(requestSettled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchSignal?.aborted).toBe(true);
      outcome = await observed;
      expect(requestSettled).toBe(true);
    } finally {
      settleFetch?.();
      caller.abort();
      await observed;
    }

    expect(outcome?.status).toBe("rejected");
    if (outcome?.status !== "rejected") throw new TypeError("Expected request timeout.");
    expect(outcome.reason).toBeInstanceOf(ChainRpcError);
    if (!(outcome.reason instanceof ChainRpcError)) {
      throw new TypeError("Expected a Chain RPC timeout.");
    }
    expect(outcome.reason).toMatchObject({ code: "chain_response_unavailable" });
    expect(outcome.reason.message).not.toContain("secret provider timeout text");
    expect(removeCallerListener).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    const capacityFetch = vi.fn(fetchOf(async (_input, init) =>
      resultResponse(init, "0x1237")
    ));
    const capacityRequester = createBoundedRpcRequester({
      url: "https://rpc.example",
      fetch: capacityFetch,
    });
    const afterTimeout = Array.from({ length: 16 }, () =>
      capacityRequester.request("eth_chainId", [], new AbortController().signal)
    );
    const afterTimeoutOutcomes = await Promise.allSettled(afterTimeout);
    expect(afterTimeoutOutcomes).toEqual(Array.from({ length: 16 }, () => ({
      status: "fulfilled",
      value: "0x1237",
    })));
    expect(capacityFetch).toHaveBeenCalledTimes(16);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts and cancels an open response body when the caller ends the request", async () => {
    let bodyCancelled = false;
    let bodyController!: ReadableStreamDefaultController<Uint8Array>;
    let releaseBodyPull!: () => void;
    const bodyPull = new Promise<void>((resolve) => { releaseBodyPull = resolve; });
    let bodyPullStarted = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
        controller.enqueue(new TextEncoder().encode("{\"jsonrpc\":\"2.0\","));
      },
      pull() {
        bodyPullStarted = true;
        return bodyPull;
      },
      cancel() {
        bodyCancelled = true;
      },
    });
    const response = new Response(body);
    const cancelReader = vi.spyOn(ReadableStreamDefaultReader.prototype, "cancel");
    const fetchFn = vi.fn(fetchOf(async () => response));
    const requester = createBoundedRpcRequester({ url: "https://rpc.example", fetch: fetchFn });
    const controller = new AbortController();
    const pending = requester.request("eth_chainId", [], controller.signal);
    const observed = pending.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    );
    let outcome: Awaited<typeof observed> | undefined;

    try {
      expect(fetchFn).toHaveBeenCalledTimes(1);
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      expect(bodyPullStarted).toBe(true);
      controller.abort();
      bodyController.enqueue(new Uint8Array());
      releaseBodyPull();
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      expect(bodyCancelled).toBe(true);
      expect(cancelReader).toHaveBeenCalledTimes(1);
      const cancellation = cancelReader.mock.results[0]?.value;
      if (cancellation === undefined) throw new TypeError("Expected body cancellation.");
      await cancellation;
      expect(bodyCancelled).toBe(true);
      outcome = await observed;
    } finally {
      controller.abort();
      releaseBodyPull();
      if (!bodyCancelled) bodyController.close();
      await observed;
    }

    expect(outcome?.status).toBe("rejected");
    if (outcome?.status !== "rejected") throw new TypeError("Expected caller cancellation.");
    expect(outcome.reason).toBeInstanceOf(ChainRpcError);
    expect(outcome.reason).toMatchObject({ code: "request_aborted" });
  });

  it("admits the exact aggregate response limit and rejects one valid byte more", async () => {
    let invocation = 0;
    const cancelReader = vi.spyOn(ReadableStreamDefaultReader.prototype, "cancel");
    const fetchFn = vi.fn(fetchOf(async (_input, init) => {
      invocation += 1;
      const currentInvocation = invocation;
      const request = requestFrom(init);
      const prefix = `{"jsonrpc":"2.0","id":"${request.id}","result":"`;
      const suffix = `"}`;
      const result = "x".repeat(
        8_388_607 - Buffer.byteLength(prefix) - Buffer.byteLength(suffix),
      );
      const firstText = `${prefix}${result}${suffix}`;
      const secondText = currentInvocation === 1 ? " " : "  ";
      const exactPrefixText = `${firstText} `;
      const completeText = `${firstText}  `;
      const expected = { jsonrpc: "2.0", id: request.id, result };
      expect(Buffer.byteLength(firstText)).toBe(8_388_607);
      expect(Buffer.byteLength(exactPrefixText)).toBe(8_388_608);
      expect(Buffer.byteLength(completeText)).toBe(8_388_609);
      expect(JSON.parse(firstText)).toEqual(expected);
      expect(JSON.parse(exactPrefixText)).toEqual(expected);
      expect(JSON.parse(completeText)).toEqual(expected);

      const encoder = new TextEncoder();
      const first = encoder.encode(firstText);
      const second = encoder.encode(secondText);
      expect(first.byteLength).toBeLessThan(8_388_608);
      expect(second.byteLength).toBeLessThan(8_388_608);
      let part = 0;
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (part === 0) {
            part += 1;
            controller.enqueue(first);
            return;
          }
          if (part === 1) {
            part += 1;
            controller.enqueue(second);
            if (currentInvocation === 1) controller.close();
            return;
          }
          controller.close();
        },
      }));
    }));
    const requester = createBoundedRpcRequester({ url: "https://rpc.example", fetch: fetchFn });

    const result = await requester.request("eth_chainId", [], new AbortController().signal);
    expect(result).toBe("x".repeat((result as string).length));
    expect(Buffer.byteLength(result as string)).toBeGreaterThan(8_000_000);
    expect(cancelReader).not.toHaveBeenCalled();
    cancelReader.mockClear();
    await expectCode(
      requester.request("eth_chainId", [], new AbortController().signal),
      "source_inconsistent",
    );
    expect(cancelReader).toHaveBeenCalledTimes(1);
  }, 20_000);

  it("rejects oversized declared length before acquiring a valid body reader", async () => {
    const getReader = vi.spyOn(ReadableStream.prototype, "getReader");
    const fetchFn = fetchOf(async (_input, init) => {
      const request = requestFrom(init);
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: "0x1237",
      }), {
        headers: { "content-length": "8388609" },
      });
    });
    const requester = createBoundedRpcRequester({ url: "https://rpc.example", fetch: fetchFn });

    await expectCode(
      requester.request("eth_chainId", [], new AbortController().signal),
      "source_inconsistent",
    );
    expect(getReader).not.toHaveBeenCalled();
  });

  it("cancels a pending body rejected by oversized declared content length", async () => {
    const body = new ReadableStream<Uint8Array>();
    const cancel = vi.spyOn(body, "cancel");
    const fetchFn = fetchOf(async () => new Response(body, {
      headers: { "content-length": "8388609" },
    }));
    const requester = createBoundedRpcRequester({ url: "https://rpc.example", fetch: fetchFn });

    await expectCode(
      requester.request("eth_chainId", [], new AbortController().signal),
      "source_inconsistent",
    );
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("bounds response storage even when the provider emits many empty and tiny chunks", async () => {
    const fetchFn = fetchOf(async (_input, init) => {
      const request = requestFrom(init);
      const encoded = new TextEncoder().encode(JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: "0x1237",
      }));
      let index = 0;
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (index >= encoded.length) {
            controller.close();
            return;
          }
          controller.enqueue(new Uint8Array(0));
          controller.enqueue(encoded.subarray(index, index + 1));
          index += 1;
        },
      }));
    });
    const requester = createBoundedRpcRequester({ url: "https://rpc.example", fetch: fetchFn });

    await expect(
      requester.request("eth_chainId", [], new AbortController().signal),
    ).resolves.toBe("0x1237");
  });

  it("treats content length as a wire-size hint because fetch may decode the response stream", async () => {
    const requester = createBoundedRpcRequester({
      url: "https://rpc.example",
      fetch: fetchOf(async (_input, init) => {
        const request = requestFrom(init);
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: "0x1237" }), {
          headers: { "content-length": "3", "content-encoding": "gzip" },
        });
      }),
    });

    await expect(
      requester.request("eth_chainId", [], new AbortController().signal),
    ).resolves.toBe("0x1237");
  });

  it.each([
    ["invalid JSON", (_id: string) => "{"],
    ["batch response", (id: string) => JSON.stringify([{ jsonrpc: "2.0", id, result: "0x1237" }])],
    ["wrong version", (id: string) => JSON.stringify({ jsonrpc: "1.0", id, result: "0x1237" })],
    ["wrong id", (_id: string) => JSON.stringify({ jsonrpc: "2.0", id: "different", result: "0x1237" })],
    ["missing result", (id: string) => JSON.stringify({ jsonrpc: "2.0", id })],
    ["result and error", (id: string) => JSON.stringify({ jsonrpc: "2.0", id, result: null, error: null })],
    ["unknown envelope field", (id: string) => JSON.stringify({ jsonrpc: "2.0", id, result: null, extra: true })],
    ["malformed error", (id: string) => JSON.stringify({ jsonrpc: "2.0", id, error: { code: "-32005", message: "limited" } })],
  ])("rejects a %s response envelope", async (_name, makeBody) => {
    const requester = createBoundedRpcRequester({
      url: "https://rpc.example",
      fetch: fetchOf(async (_input, init) => {
        const request = requestFrom(init);
        return new Response(makeBody(request.id));
      }),
    });

    await expectCode(
      requester.request("eth_chainId", [], new AbortController().signal),
      "source_inconsistent",
    );
  });

  it("classifies HTTP and EIP-1474 rate limits without exposing provider text", async () => {
    let invocation = 0;
    const secret = "provider-account-secret";
    const requester = createBoundedRpcRequester({
      url: "https://rpc.example",
      fetch: fetchOf(async (_input, init) => {
        invocation += 1;
        if (invocation === 1) return new Response(secret, { status: 429 });
        const request = requestFrom(init);
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32005, message: secret, data: { secret } },
        }));
      }),
    });

    for (let index = 0; index < 2; index += 1) {
      const error = await expectCode(
        requester.request("eth_chainId", [], new AbortController().signal),
        "rate_limited",
      );
      expect(error.message).not.toContain(secret);
      expect(error).not.toHaveProperty("cause");
    }
  });

  it("distinguishes inconsistent protocol errors from unavailable provider failures", async () => {
    const errors = [
      { code: -32000, expected: "source_inconsistent" as const },
      { code: -32602, expected: "source_inconsistent" as const },
      { code: -32603, expected: "source_unavailable" as const },
    ];
    let invocation = 0;
    const requester = createBoundedRpcRequester({
      url: "https://rpc.example",
      fetch: fetchOf(async (_input, init) => {
        const request = requestFrom(init);
        const error = errors[invocation];
        invocation += 1;
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: error?.code, message: "provider detail must not escape" },
        }));
      }),
    });

    for (const error of errors) {
      const normalized = await expectCode(
        requester.request("eth_chainId", [], new AbortController().signal),
        error.expected,
      );
      expect(normalized.message).not.toContain("provider detail");
    }
  });

  it("preserves only a valid eth_call execution revert as a method failure", async () => {
    let invocation = 0;
    const requester = createBoundedRpcRequester({
      url: "https://rpc.example",
      fetch: fetchOf(async (_input, init) => {
        const request = requestFrom(init);
        invocation += 1;
        const error = invocation === 1
          ? { code: 3, message: "execution detail must not escape", data: "0x" }
          : invocation === 2
            ? { code: 3, message: "missing revert data" }
            : { code: 3, message: "not an eth_call failure", data: "0x" };
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, error }));
      }),
    });

    const reverted = await expectExecutionRevert(requester.request("eth_call", [{
      to: stateAddress,
      data: parseHexBytes("0x"),
    }, stateReference], new AbortController().signal));
    expect(String(reverted)).not.toContain("execution detail");

    const malformed = await expectCode(requester.request("eth_call", [{
      to: stateAddress,
      data: parseHexBytes("0x"),
    }, stateReference], new AbortController().signal), "source_inconsistent");
    expect(isRpcExecutionRevertedError(malformed)).toBe(false);

    const otherMethod = await expectCode(
      requester.request("eth_chainId", [], new AbortController().signal),
      "source_unavailable",
    );
    expect(isRpcExecutionRevertedError(otherMethod)).toBe(false);
  });

  it("does not retry failed HTTP work or expose response-stream failures", async () => {
    const secret = "response-stream-secret";
    const fetchFn = vi.fn(fetchOf(async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error(secret));
      },
    }))));
    const requester = createBoundedRpcRequester({ url: "https://rpc.example", fetch: fetchFn });

    const error = await expectCode(
      requester.request("eth_chainId", [], new AbortController().signal),
      "chain_response_unavailable",
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(error.message).not.toContain(secret);
  });

  it("maps a TLS trust rejection only to absence of a complete response", async () => {
    const tlsFailure = Object.assign(new Error("private trust-store detail"), {
      code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    });
    const fetchFn = vi.fn(fetchOf(async () => { throw tlsFailure; }));
    const requester = createBoundedRpcRequester({ url: "https://rpc.example", fetch: fetchFn });

    const error = await expectCode(
      requester.request("eth_chainId", [], new AbortController().signal),
      "chain_response_unavailable",
    );
    expect(error.message).toBe("chain_response_unavailable");
    expect(error).not.toHaveProperty("cause");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("rejects unlisted methods and non-JSON parameters before external work", async () => {
    const fetchFn = vi.fn(fetchOf(async (_input, init) => resultResponse(init, null)));
    const requester = createBoundedRpcRequester({ url: "https://rpc.example", fetch: fetchFn });
    const unsafe = requester as unknown as {
      request(method: string, params: readonly unknown[], signal: AbortSignal): Promise<unknown>;
    };

    await expect(unsafe.request("eth_sendTransaction", [], new AbortController().signal))
      .rejects.toThrow("RPC method is not allowed.");
    await expect(unsafe.request("eth_call", [1], new AbortController().signal))
      .rejects.toThrow("RPC request parameters are invalid.");
    const getter = Object.defineProperty({}, "to", {
      enumerable: true,
      get: () => { throw new Error("getter secret"); },
    });
    await expect(unsafe.request("eth_call", [getter], new AbortController().signal))
      .rejects.toThrow("RPC request parameters are invalid.");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each([
    ["eth_chainId extra parameters", "eth_chainId", ["unexpected"]],
    ["eth_getBlockByNumber missing parameters", "eth_getBlockByNumber", ["latest"]],
    ["eth_getBlockByNumber extra parameters", "eth_getBlockByNumber", ["latest", false, "unexpected"]],
    ["eth_getCode missing parameters", "eth_getCode", [`0x${"a".repeat(40)}`]],
    ["eth_getTransactionByHash missing parameters", "eth_getTransactionByHash", []],
    ["eth_getTransactionReceipt extra parameters", "eth_getTransactionReceipt", [`0x${"b".repeat(64)}`, "unexpected"]],
    ["eth_getBlockByHash missing parameters", "eth_getBlockByHash", [`0x${"b".repeat(64)}`]],
    ["eth_getBalance missing parameters", "eth_getBalance", [`0x${"a".repeat(40)}`]],
    ["eth_call missing block parameter", "eth_call", [{ to: `0x${"a".repeat(40)}`, data: "0x" }]],
    ["eth_getBlockByNumber full transactions", "eth_getBlockByNumber", ["latest", true]],
    ["eth_getBlockByHash full transactions", "eth_getBlockByHash", [`0x${"b".repeat(64)}`, true]],
    ["noncanonical block quantity", "eth_getBlockByNumber", ["0x00", false]],
    ["noncanonical address", "eth_getBalance", [`0x${"A".repeat(40)}`, stateReference]],
    ["numeric state selector", "eth_getBalance", [stateAddress, "0x1"]],
    ["block-number object state selector", "eth_getCode", [stateAddress, { blockNumber: "0x1" }]],
    ["missing canonical requirement", "eth_getBalance", [stateAddress, { blockHash: stateBlockHash }]],
    ["false canonical requirement", "eth_getBalance", [stateAddress, { blockHash: stateBlockHash, requireCanonical: false }]],
    ["noncanonical block hash", "eth_getBalance", [stateAddress, {
      blockHash: `0x${"B".repeat(64)}`, requireCanonical: true,
    }]],
    ["extra block-reference field", "eth_getBalance", [stateAddress, {
      blockHash: stateBlockHash, requireCanonical: true, extra: true,
    }]],
    ["noncanonical transaction hash", "eth_getTransactionByHash", [`0x${"B".repeat(64)}`]],
    ["noncanonical call data", "eth_call", [{ to: stateAddress, data: "0xAB" }, stateReference]],
    ["odd-length call data", "eth_call", [{ to: stateAddress, data: "0x1" }, stateReference]],
    ["eth_call missing data", "eth_call", [{ to: stateAddress }, stateReference]],
    ["eth_call extra call field", "eth_call", [{ to: stateAddress, data: "0x", unexpected: "0x0" }, stateReference]],
  ] as const)("rejects %s before external work", async (_name, method, params) => {
    const fetchFn = vi.fn(fetchOf(async (_input, init) => resultResponse(init, null)));
    const requester = createBoundedRpcRequester({ url: "https://rpc.example", fetch: fetchFn });
    const unsafe = requester as unknown as {
      request(method: string, params: readonly unknown[], signal: AbortSignal): Promise<unknown>;
    };

    await expect(unsafe.request(method, params, new AbortController().signal))
      .rejects.toThrow("RPC request parameters are invalid.");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("admits the exact timeout setting and rejects every value outside its contract", async () => {
    const fetchFn = vi.fn(fetchOf(async (_input, init) => resultResponse(init, "0x1237")));
    const createWithUnknownTimeout = createBoundedRpcRequester as unknown as (options: {
      readonly url: string;
      readonly fetch: typeof globalThis.fetch;
      readonly timeoutMs: unknown;
    }) => RpcRequester;

    for (const timeoutMs of [10_001, 0, 1.5, Number.NaN, "10000"] as const) {
      expect(() => createWithUnknownTimeout({
        url: "https://rpc.example",
        fetch: fetchFn,
        timeoutMs,
      })).toThrow("RPC timeout is invalid.");
    }
    expect(fetchFn).not.toHaveBeenCalled();

    const requester = createBoundedRpcRequester({
      url: "https://rpc.example",
      fetch: fetchFn,
      timeoutMs: 10_000,
    });
    await expect(requester.request(
      "eth_chainId",
      [],
      new AbortController().signal,
    )).resolves.toBe("0x1237");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe("RPC error normalization", () => {
  it("preserves canonical errors and safely normalizes aborts and unknown failures", () => {
    const canonical = new ChainRpcError("rate_limited");
    expect(normalizeChainRpcError(canonical)).toBe(canonical);

    const controller = new AbortController();
    controller.abort(new Error("caller secret"));
    const aborted = normalizeChainRpcError(new Error("provider secret"), controller.signal);
    expect(aborted).toMatchObject({
      code: "request_aborted",
    });
    const incomplete = normalizeChainRpcError(new Error("provider secret"));
    expect(incomplete).toMatchObject({
      code: "chain_response_unavailable",
    });
    expect(aborted.message).toBe(aborted.code);
    expect(incomplete.message).toBe(incomplete.code);
    expect(aborted).not.toHaveProperty("retryable");
    expect(incomplete).not.toHaveProperty("retryable");
    expect(incomplete).not.toHaveProperty("cause");
  });

  it("does not trust a forged prototype or inspect a proxied RPC error", () => {
    const forged = Object.create(ChainRpcError.prototype) as Record<string, unknown>;
    Object.defineProperty(forged, "code", {
      enumerable: true,
      get: () => { throw new Error("secret-forged-code"); },
    });
    let proxyReads = 0;
    const proxied = new Proxy(new ChainRpcError("rate_limited"), {
      get: () => {
        proxyReads += 1;
        throw new Error("secret-proxy-code");
      },
      getPrototypeOf: () => {
        proxyReads += 1;
        throw new Error("secret-proxy-code");
      },
    });

    expect(normalizeChainRpcError(forged).code).toBe("chain_response_unavailable");
    expect(normalizeChainRpcError(proxied).code).toBe("chain_response_unavailable");
    expect(proxyReads).toBe(0);
  });
});

const assertRequesterType = (requester: RpcRequester): void => {
  void requester;
};

assertRequesterType(createBoundedRpcRequester({ url: "https://rpc.example" }));
