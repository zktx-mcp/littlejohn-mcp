import { describe, expect, it, vi } from "vitest";

import {
  canonicalBlockReference,
  ChainRpcError,
  createBoundedRpcRequester,
  isRpcBatchRejectedError,
  isRpcExecutionRevertedError,
  normalizeChainRpcError,
  rpcConcurrencyLimit,
  rpcRequestTimeoutMs,
  rpcResponseByteLimit,
  type RpcRequester,
} from "../../src/chain/rpc.js";
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
      "source_unavailable",
    );
    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain("query-secret");
    expect(error).not.toHaveProperty("cause");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("rejects the seventeenth process-wide external request without starting it", async () => {
    const completions: Array<Readonly<{ init: RequestInit | undefined; resolve: (response: Response) => void }>> = [];
    const fetchFn = vi.fn(fetchOf(async (_input, init) =>
      await new Promise<Response>((resolve) => completions.push({ init, resolve }))
    ));
    const first = createBoundedRpcRequester({ url: "https://rpc-one.example", fetch: fetchFn });
    const second = createBoundedRpcRequester({ url: "https://rpc-two.example", fetch: fetchFn });
    const active = Array.from({ length: rpcConcurrencyLimit }, (_, index) =>
      (index % 2 === 0 ? first : second).request("eth_chainId", [], new AbortController().signal)
    );
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(rpcConcurrencyLimit));

    await expectCode(
      second.request("eth_chainId", [], new AbortController().signal),
      "runtime_busy",
    );
    expect(fetchFn).toHaveBeenCalledTimes(rpcConcurrencyLimit);

    for (const completion of completions) completion.resolve(resultResponse(completion.init, "0x1237"));
    await expect(Promise.all(active)).resolves.toEqual(
      Array.from({ length: rpcConcurrencyLimit }, () => "0x1237"),
    );
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
    const fetchFn = vi.fn(fetchOf(async (_input, init) => {
      fetchSignal = init?.signal ?? undefined;
      return await new Promise<Response>((_resolve, reject) => {
        fetchSignal?.addEventListener(
          "abort",
          () => reject(new Error("provider cancellation detail")),
          { once: true },
        );
      });
    }));
    const requester = createBoundedRpcRequester({ url: "https://rpc.example", fetch: fetchFn });
    const controller = new AbortController();
    const pending = requester.request("eth_chainId", [], controller.signal);
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    controller.abort();

    const error = await expectCode(pending, "request_aborted");
    expect(fetchSignal?.aborted).toBe(true);
    expect(error.message).not.toContain("provider cancellation detail");
  });

  it("maps the request deadline to a safe unavailable error and forwards abort", async () => {
    let fetchSignal: AbortSignal | undefined;
    const fetchFn = vi.fn(fetchOf(async (_input, init) => {
      fetchSignal = init?.signal ?? undefined;
      return await new Promise<Response>((_resolve, reject) => {
        fetchSignal?.addEventListener(
          "abort",
          () => reject(new Error("secret provider timeout text")),
          { once: true },
        );
      });
    }));
    const requester = createBoundedRpcRequester({
      url: "https://rpc.example",
      fetch: fetchFn,
      timeoutMs: 5,
    });

    const error = await expectCode(
      requester.request("eth_chainId", [], new AbortController().signal),
      "source_unavailable",
    );
    expect(fetchSignal?.aborted).toBe(true);
    expect(error.message).not.toContain("secret provider timeout text");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("aborts and cancels an open response body when the caller ends the request", async () => {
    let bodyCancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{\"jsonrpc\":\"2.0\","));
      },
      cancel() {
        bodyCancelled = true;
        return new Promise<void>(() => undefined);
      },
    }));
    const fetchFn = vi.fn(fetchOf(async () => response));
    const requester = createBoundedRpcRequester({ url: "https://rpc.example", fetch: fetchFn });
    const controller = new AbortController();
    const pending = requester.request("eth_chainId", [], controller.signal);
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    controller.abort();

    await expectCode(pending, "request_aborted");
    await vi.waitFor(() => expect(bodyCancelled).toBe(true));
  });

  it("accepts an exactly 8 MiB response and rejects the next byte before parsing", async () => {
    let invocation = 0;
    const fetchFn = vi.fn(fetchOf(async (_input, init) => {
      invocation += 1;
      const request = requestFrom(init);
      const prefix = `{"jsonrpc":"2.0","id":"${request.id}","result":"`;
      const suffix = `"}`;
      const padding = rpcResponseByteLimit - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
      if (invocation === 1) {
        const body = `${prefix}${"x".repeat(padding)}${suffix}`;
        expect(Buffer.byteLength(body)).toBe(rpcResponseByteLimit);
        return new Response(body);
      }
      const chunks = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(rpcResponseByteLimit));
          controller.enqueue(new Uint8Array(1));
          controller.close();
        },
      });
      return new Response(chunks);
    }));
    const requester = createBoundedRpcRequester({ url: "https://rpc.example", fetch: fetchFn });

    const result = await requester.request("eth_chainId", [], new AbortController().signal);
    expect(result).toBe("x".repeat((result as string).length));
    expect(Buffer.byteLength(result as string)).toBeGreaterThan(8_000_000);
    await expectCode(
      requester.request("eth_chainId", [], new AbortController().signal),
      "source_inconsistent",
    );
  }, 20_000);

  it("rejects an oversized declared content length without consuming the body", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const fetchFn = fetchOf(async () => new Response(body, {
      headers: { "content-length": String(rpcResponseByteLimit + 1) },
    }));
    const requester = createBoundedRpcRequester({ url: "https://rpc.example", fetch: fetchFn });

    await expectCode(
      requester.request("eth_chainId", [], new AbortController().signal),
      "source_inconsistent",
    );
    await vi.waitFor(() => expect(cancelled).toBe(true));
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
      "source_unavailable",
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(error.message).not.toContain(secret);
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
    ["eth_call extra call field", "eth_call", [{ to: stateAddress, data: "0x", value: "0x0" }, stateReference]],
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

  it("keeps the production limits fixed and rejects a longer timeout", () => {
    expect(rpcRequestTimeoutMs).toBe(10_000);
    expect(rpcResponseByteLimit).toBe(8 * 1_024 * 1_024);
    expect(rpcConcurrencyLimit).toBe(16);
    expect(() => createBoundedRpcRequester({
      url: "https://rpc.example",
      timeoutMs: rpcRequestTimeoutMs + 1,
    })).toThrow("RPC timeout is invalid.");
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
    const unavailable = normalizeChainRpcError(new Error("provider secret"));
    expect(unavailable).toMatchObject({
      code: "source_unavailable",
    });
    expect(aborted.message).toBe(aborted.code);
    expect(unavailable.message).toBe(unavailable.code);
    expect(aborted).not.toHaveProperty("retryable");
    expect(unavailable).not.toHaveProperty("retryable");
    expect(unavailable).not.toHaveProperty("cause");
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

    expect(normalizeChainRpcError(forged).code).toBe("source_unavailable");
    expect(normalizeChainRpcError(proxied).code).toBe("source_unavailable");
    expect(proxyReads).toBe(0);
  });
});

const assertRequesterType = (requester: RpcRequester): void => {
  void requester;
};

assertRequesterType(createBoundedRpcRequester({ url: "https://rpc.example" }));
