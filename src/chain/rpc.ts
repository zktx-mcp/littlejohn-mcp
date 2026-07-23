import type { EvmAddress, Hash32, HexBytes } from "../core/index.js";
import {
  normalizeRpcAddress,
  normalizeRpcBytes,
  normalizeRpcHash,
  rpcQuantityToUnsignedDecimal,
  unsignedDecimalToRpcQuantity,
} from "./normalization.js";
import { rpcResponseByteLimit } from "./limits.js";

type RpcQuantity = `0x${string}`;

declare const rpcCanonicalBlockReferenceBrand: unique symbol;

export interface RpcCanonicalBlockReference {
  readonly [rpcCanonicalBlockReferenceBrand]: true;
  readonly blockHash: Hash32;
  readonly requireCanonical: true;
}

export const canonicalBlockReference = (
  blockHash: Hash32,
): RpcCanonicalBlockReference => Object.freeze({
  blockHash,
  requireCanonical: true,
}) as RpcCanonicalBlockReference;

export const rpcRequestTimeoutMs = 10_000;
export { rpcResponseByteLimit } from "./limits.js";
export const rpcConcurrencyLimit = 16;

export type ChainRpcErrorCode =
  | "request_aborted"
  | "runtime_busy"
  | "rate_limited"
  | "source_unavailable"
  | "source_inconsistent";

const chainRpcErrorCodes = new WeakMap<object, ChainRpcErrorCode>();
const rpcExecutionRevertedErrors = new WeakSet<object>();

export class ChainRpcError extends Error {
  override readonly name = "ChainRpcError";
  readonly code: ChainRpcErrorCode;

  constructor(code: ChainRpcErrorCode) {
    super(code);
    this.code = code;
    chainRpcErrorCodes.set(this, code);
    Object.freeze(this);
  }
}

export const getChainRpcErrorCode = (error: unknown): ChainRpcErrorCode | undefined =>
  typeof error === "object" && error !== null
    ? chainRpcErrorCodes.get(error)
    : undefined;

const createRpcExecutionRevertedError = (): Error => {
  const error = new Error("execution_reverted");
  error.name = "RpcExecutionRevertedError";
  rpcExecutionRevertedErrors.add(error);
  Object.freeze(error);
  return error;
};

export const isRpcExecutionRevertedError = (error: unknown): boolean =>
  typeof error === "object" && error !== null && rpcExecutionRevertedErrors.has(error);

export const normalizeChainRpcError = (
  error: unknown,
  signal?: AbortSignal,
): ChainRpcError => {
  if (getChainRpcErrorCode(error) !== undefined) return error as ChainRpcError;
  if (signal?.aborted === true) return new ChainRpcError("request_aborted");
  return new ChainRpcError("source_unavailable");
};

export interface ChainRpcRequestMap {
  readonly eth_chainId: readonly [];
  readonly eth_getBlockByNumber: readonly [block: "latest" | RpcQuantity, fullTransactions: false];
  readonly eth_getCode: readonly [address: EvmAddress, block: RpcCanonicalBlockReference];
  readonly eth_getStorageAt: readonly [
    address: EvmAddress,
    slot: Hash32,
    block: RpcCanonicalBlockReference,
  ];
  readonly eth_getTransactionByHash: readonly [transactionHash: Hash32];
  readonly eth_getTransactionReceipt: readonly [transactionHash: Hash32];
  readonly eth_getBlockByHash: readonly [blockHash: Hash32, fullTransactions: false];
  readonly eth_getBalance: readonly [address: EvmAddress, block: RpcCanonicalBlockReference];
  readonly eth_call: readonly [
    call: Readonly<{ to: EvmAddress; data: HexBytes; gas?: RpcQuantity }>,
    block: RpcCanonicalBlockReference,
  ];
}

export type ChainRpcMethod = keyof ChainRpcRequestMap;

export interface RpcRequester {
  request<Method extends ChainRpcMethod>(
    method: Method,
    params: ChainRpcRequestMap[Method],
    signal: AbortSignal,
  ): Promise<unknown>;
  requestBatch?(
    calls: readonly ChainRpcCall[],
    signal: AbortSignal,
  ): Promise<readonly PromiseSettledResult<unknown>[]>;
}

export type ChainRpcCall = {
  readonly [Method in ChainRpcMethod]: Readonly<{
    method: Method;
    params: ChainRpcRequestMap[Method];
  }>;
}[ChainRpcMethod];

export const rpcBatchCallLimit = 32;

type RpcFetch = typeof fetch;

export interface BoundedRpcRequesterOptions {
  readonly url: string;
  readonly fetch?: RpcFetch;
  readonly timeoutMs?: number;
}

const allowedMethods = new Set<ChainRpcMethod>([
  "eth_chainId",
  "eth_getBlockByNumber",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_getBlockByHash",
  "eth_getBalance",
  "eth_call",
]);

const inconsistentProviderErrorCodes = new Set([
  -32700,
  -32600,
  -32601,
  -32602,
  -32000,
  -32004,
  -32006,
  -32042,
]);

const limitExceededRpcCode = -32005;

let activeExternalRpcRequests = 0;
let nextRequestId = 1n;

class RequestAbortedMarker extends Error {
  override readonly name = "RequestAbortedMarker";
}

const rpcBatchRejectedErrors = new WeakSet<object>();

const createRpcBatchRejectedError = (): Error => {
  const error = new Error("rpc_batch_rejected");
  error.name = "RpcBatchRejectedError";
  rpcBatchRejectedErrors.add(error);
  Object.freeze(error);
  return error;
};

export const isRpcBatchRejectedError = (error: unknown): boolean =>
  typeof error === "object" && error !== null && rpcBatchRejectedErrors.has(error);

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const hasExactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
};

const cloneJsonRpcValue = (value: unknown, ancestors: WeakSet<object>): unknown => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value !== "object") throw new TypeError("RPC request parameters are invalid.");

  if (ancestors.has(value)) throw new TypeError("RPC request parameters are invalid.");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      if (
        keys.some((key) =>
          typeof key === "symbol" || (key !== "length" && !/^(0|[1-9][0-9]*)$/u.test(key)),
        )
      ) {
        throw new TypeError("RPC request parameters are invalid.");
      }
      const clone: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (
          descriptor === undefined ||
          descriptor.enumerable !== true ||
          !("value" in descriptor)
        ) {
          throw new TypeError("RPC request parameters are invalid.");
        }
        clone.push(cloneJsonRpcValue(descriptor.value, ancestors));
      }
      return clone;
    }

    if (!isPlainObject(value) || Object.getOwnPropertySymbols(value).length !== 0) {
      throw new TypeError("RPC request parameters are invalid.");
    }
    const clone: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (descriptor.enumerable !== true || !("value" in descriptor)) {
        throw new TypeError("RPC request parameters are invalid.");
      }
      clone[key] = cloneJsonRpcValue(descriptor.value, ancestors);
    }
    return clone;
  } finally {
    ancestors.delete(value);
  }
};

const exactArray = (value: unknown, length: number): readonly unknown[] | undefined =>
  Array.isArray(value) && value.length === length ? value : undefined;

const canonicalRpcQuantity = (value: unknown): boolean => {
  try { return unsignedDecimalToRpcQuantity(rpcQuantityToUnsignedDecimal(value)) === value; }
  catch { return false; }
};

const canonicalRpcAddress = (value: unknown): boolean => {
  try { return normalizeRpcAddress(value) === value; }
  catch { return false; }
};

const canonicalRpcHash = (value: unknown): boolean => {
  try { return normalizeRpcHash(value) === value; }
  catch { return false; }
};

const canonicalRpcBytes = (value: unknown): boolean => {
  try { return normalizeRpcBytes(value) === value; }
  catch { return false; }
};

const canonicalRpcBlockReference = (value: unknown): boolean =>
  isPlainObject(value) &&
  hasExactKeys(value, ["blockHash", "requireCanonical"]) &&
  canonicalRpcHash(value["blockHash"]) &&
  value["requireCanonical"] === true;

const assertMethodParameters = (method: ChainRpcMethod, input: unknown): void => {
  const expectedLength = method === "eth_chainId"
    ? 0
    : method === "eth_getTransactionByHash" || method === "eth_getTransactionReceipt"
      ? 1
      : method === "eth_getStorageAt"
        ? 3
        : 2;
  const params = exactArray(input, expectedLength);
  if (method === "eth_chainId") {
    if (params === undefined) throw new TypeError("RPC request parameters are invalid.");
    return;
  }
  if (method === "eth_getTransactionByHash" || method === "eth_getTransactionReceipt") {
    const one = exactArray(input, 1);
    if (one === undefined || !canonicalRpcHash(one[0])) {
      throw new TypeError("RPC request parameters are invalid.");
    }
    return;
  }
  if (params === undefined) throw new TypeError("RPC request parameters are invalid.");
  if (method === "eth_getBlockByNumber") {
    if (
      !(params[0] === "latest" || canonicalRpcQuantity(params[0])) ||
      params[1] !== false
    ) throw new TypeError("RPC request parameters are invalid.");
    return;
  }
  if (method === "eth_getBlockByHash") {
    if (!canonicalRpcHash(params[0]) || params[1] !== false) {
      throw new TypeError("RPC request parameters are invalid.");
    }
    return;
  }
  if (method === "eth_getCode" || method === "eth_getBalance") {
    if (!canonicalRpcAddress(params[0]) || !canonicalRpcBlockReference(params[1])) {
      throw new TypeError("RPC request parameters are invalid.");
    }
    return;
  }
  if (method === "eth_getStorageAt") {
    if (
      !canonicalRpcAddress(params[0]) ||
      !canonicalRpcHash(params[1]) ||
      !canonicalRpcBlockReference(params[2])
    ) throw new TypeError("RPC request parameters are invalid.");
    return;
  }
  const call = params[0];
  if (
    !isPlainObject(call) ||
    !(hasExactKeys(call, ["to", "data"]) || hasExactKeys(call, ["to", "data", "gas"])) ||
    !canonicalRpcAddress(call["to"]) ||
    !canonicalRpcBytes(call["data"]) ||
    (Object.hasOwn(call, "gas") && !canonicalRpcQuantity(call["gas"])) ||
    !canonicalRpcBlockReference(params[1])
  ) throw new TypeError("RPC request parameters are invalid.");
};

const serializeRequest = (
  id: string,
  method: ChainRpcMethod,
  params: readonly unknown[],
): string => {
  let canonicalParams: unknown;
  try {
    canonicalParams = cloneJsonRpcValue(params, new WeakSet<object>());
  } catch {
    throw new TypeError("RPC request parameters are invalid.");
  }
  assertMethodParameters(method, canonicalParams);
  const body = JSON.stringify({ jsonrpc: "2.0", id, method, params: canonicalParams });
  if (typeof body !== "string") throw new TypeError("RPC request parameters are invalid.");
  return body;
};

const parseBoundedInteger = (value: number | undefined, fallback: number, maximum: number, name: string): number => {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > maximum) {
    throw new TypeError(`${name} is invalid.`);
  }
  return candidate;
};

const createFetchTarget = (value: string): Readonly<{ url: string; authorization?: string }> => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("RPC URL is invalid.");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hash !== "") {
    throw new TypeError("RPC URL is invalid.");
  }

  if (url.username === "" && url.password === "") return Object.freeze({ url: url.href });

  let username: string;
  let password: string;
  try {
    username = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
  } catch {
    throw new TypeError("RPC URL is invalid.");
  }
  if (username.includes(":")) throw new TypeError("RPC URL is invalid.");
  const authorization = `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
  url.username = "";
  url.password = "";
  return Object.freeze({ url: url.href, authorization });
};

const raceWithAbort = async <Value>(work: Promise<Value>, signal: AbortSignal): Promise<Value> => {
  if (signal.aborted) throw new RequestAbortedMarker();
  return await new Promise<Value>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      action();
    };
    const onAbort = (): void => finish(() => reject(new RequestAbortedMarker()));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
};

const cancelBody = (response: Response): void => {
  if (response.body === null) return;
  void response.body.cancel().catch(() => undefined);
};

const parseContentLength = (response: Response): number | undefined => {
  const value = response.headers.get("content-length");
  if (value === null) return undefined;
  if (!/^(0|[1-9][0-9]*)$/u.test(value) || value.length > 16) {
    cancelBody(response);
    throw new ChainRpcError("source_inconsistent");
  }
  const parsed = BigInt(value);
  if (parsed > BigInt(rpcResponseByteLimit)) {
    cancelBody(response);
    throw new ChainRpcError("source_inconsistent");
  }
  return Number(parsed);
};

const readBoundedBody = async (response: Response, signal: AbortSignal): Promise<string> => {
  const declaredLength = parseContentLength(response);
  if (response.body === null) throw new ChainRpcError("source_inconsistent");

  const reader = response.body.getReader();
  let bytes = new Uint8Array(Math.min(declaredLength ?? 0, 64 * 1_024));
  let total = 0;
  try {
    while (true) {
      const chunk = await raceWithAbort(reader.read(), signal);
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) throw new ChainRpcError("source_inconsistent");
      if (chunk.value.byteLength === 0) continue;
      const nextTotal = total + chunk.value.byteLength;
      if (nextTotal > rpcResponseByteLimit || nextTotal < total) {
        throw new ChainRpcError("source_inconsistent");
      }
      if (nextTotal > bytes.byteLength) {
        let capacity = Math.max(1, bytes.byteLength);
        while (capacity < nextTotal) {
          capacity = Math.min(rpcResponseByteLimit, capacity * 2);
        }
        const grown = new Uint8Array(capacity);
        grown.set(bytes.subarray(0, total));
        bytes = grown;
      }
      bytes.set(chunk.value, total);
      total = nextTotal;
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, total));
  } catch {
    throw new ChainRpcError("source_inconsistent");
  }
};

const parseResponseValue = (
  parsed: unknown,
  expectedId: string,
  method: ChainRpcMethod,
): unknown => {
  if (!isPlainObject(parsed) || parsed["jsonrpc"] !== "2.0" || parsed["id"] !== expectedId) {
    throw new ChainRpcError("source_inconsistent");
  }

  const hasResult = Object.hasOwn(parsed, "result");
  const hasError = Object.hasOwn(parsed, "error");
  if (hasResult === hasError) throw new ChainRpcError("source_inconsistent");

  if (hasResult) {
    if (!hasExactKeys(parsed, ["jsonrpc", "id", "result"])) {
      throw new ChainRpcError("source_inconsistent");
    }
    return parsed["result"];
  }

  if (!hasExactKeys(parsed, ["jsonrpc", "id", "error"])) {
    throw new ChainRpcError("source_inconsistent");
  }
  const rpcError = parsed["error"];
  if (!isPlainObject(rpcError)) throw new ChainRpcError("source_inconsistent");
  const errorKeys = Object.keys(rpcError);
  if (
    (errorKeys.length !== 2 && errorKeys.length !== 3) ||
    !Object.hasOwn(rpcError, "code") ||
    !Object.hasOwn(rpcError, "message") ||
    (errorKeys.length === 3 && !Object.hasOwn(rpcError, "data")) ||
    !Number.isSafeInteger(rpcError["code"]) ||
    typeof rpcError["message"] !== "string"
  ) {
    throw new ChainRpcError("source_inconsistent");
  }

  const code = rpcError["code"] as number;
  if (code === limitExceededRpcCode) throw new ChainRpcError("rate_limited");
  if (method === "eth_call" && code === 3) {
    if (errorKeys.length !== 3 || !canonicalRpcBytes(rpcError["data"])) {
      throw new ChainRpcError("source_inconsistent");
    }
    throw createRpcExecutionRevertedError();
  }
  if (inconsistentProviderErrorCodes.has(code)) throw new ChainRpcError("source_inconsistent");
  throw new ChainRpcError("source_unavailable");
};

const parseResponse = (
  body: string,
  expectedId: string,
  method: ChainRpcMethod,
): unknown => {
  let parsed: unknown;
  try { parsed = JSON.parse(body) as unknown; }
  catch { throw new ChainRpcError("source_inconsistent"); }
  return parseResponseValue(parsed, expectedId, method);
};

const isBatchRejection = (value: unknown): boolean => {
  if (!isPlainObject(value) || value["jsonrpc"] !== "2.0" || value["id"] !== null) return false;
  const error = value["error"];
  return hasExactKeys(value, ["jsonrpc", "id", "error"]) &&
    isPlainObject(error) &&
    (hasExactKeys(error, ["code", "message"]) || hasExactKeys(error, ["code", "message", "data"])) &&
    (error["code"] === -32600 || error["code"] === -32601) &&
    typeof error["message"] === "string";
};

const parseBatchResponse = (
  body: string,
  expected: ReadonlyMap<string, ChainRpcMethod>,
): readonly PromiseSettledResult<unknown>[] => {
  let parsed: unknown;
  try { parsed = JSON.parse(body) as unknown; }
  catch { throw new ChainRpcError("source_inconsistent"); }
  if (!Array.isArray(parsed)) {
    if (isBatchRejection(parsed)) throw createRpcBatchRejectedError();
    throw new ChainRpcError("source_inconsistent");
  }
  if (parsed.length !== expected.size) throw new ChainRpcError("source_inconsistent");
  const byId = new Map<string, PromiseSettledResult<unknown>>();
  for (const entry of parsed) {
    if (!isPlainObject(entry) || typeof entry["id"] !== "string" || !expected.has(entry["id"]) ||
      byId.has(entry["id"])) {
      throw new ChainRpcError("source_inconsistent");
    }
    const id = entry["id"];
    const method = expected.get(id);
    if (method === undefined) throw new ChainRpcError("source_inconsistent");
    try {
      byId.set(id, { status: "fulfilled", value: parseResponseValue(entry, id, method) });
    } catch (reason) {
      byId.set(id, { status: "rejected", reason });
    }
  }
  return Object.freeze([...expected.keys()].map((id) => {
    const result = byId.get(id);
    if (result === undefined) throw new ChainRpcError("source_inconsistent");
    return Object.freeze(result);
  }));
};

export const createBoundedRpcRequester = (
  options: BoundedRpcRequesterOptions,
): RpcRequester => {
  const target = createFetchTarget(options.url);
  const fetchFn = options.fetch ?? fetch;
  if (typeof fetchFn !== "function") throw new TypeError("RPC fetch implementation is unavailable.");
  const timeoutMs = parseBoundedInteger(options.timeoutMs, rpcRequestTimeoutMs, rpcRequestTimeoutMs, "RPC timeout");

  const sendBody = async (body: string, signal: AbortSignal): Promise<string> => {
    if (!(signal instanceof AbortSignal)) throw new TypeError("RPC abort signal is invalid.");
    if (signal.aborted) throw new ChainRpcError("request_aborted");
      if (activeExternalRpcRequests >= rpcConcurrencyLimit) throw new ChainRpcError("runtime_busy");
      activeExternalRpcRequests += 1;

      const controller = new AbortController();
      let timedOut = false;
      const onCallerAbort = (): void => controller.abort();
      signal.addEventListener("abort", onCallerAbort, { once: true });
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      timeout.unref();

      try {
        const headers = new Headers({
          accept: "application/json",
          "content-type": "application/json",
        });
        if (target.authorization !== undefined) headers.set("authorization", target.authorization);
        const response = await raceWithAbort(
          fetchFn(target.url, {
            method: "POST",
            headers,
            body,
            signal: controller.signal,
            redirect: "error",
            credentials: "omit",
          }),
          controller.signal,
        );
        if (!(response instanceof Response)) throw new ChainRpcError("source_inconsistent");
        if (response.status === 429) {
          cancelBody(response);
          throw new ChainRpcError("rate_limited");
        }
        if (!response.ok) {
          cancelBody(response);
          throw new ChainRpcError("source_unavailable");
        }
        return await readBoundedBody(response, controller.signal);
      } catch (error) {
        if (signal.aborted) throw new ChainRpcError("request_aborted");
        if (timedOut) throw new ChainRpcError("source_unavailable");
        throw normalizeChainRpcError(error);
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener("abort", onCallerAbort);
        activeExternalRpcRequests -= 1;
      }
  };

  const requester: RpcRequester = {
    async request<Method extends ChainRpcMethod>(
      method: Method,
      params: ChainRpcRequestMap[Method],
      signal: AbortSignal,
    ): Promise<unknown> {
      if (!allowedMethods.has(method)) throw new TypeError("RPC method is not allowed.");
      const id = nextRequestId.toString(10);
      nextRequestId += 1n;
      const body = serializeRequest(id, method, params);
      return parseResponse(await sendBody(body, signal), id, method);
    },
    async requestBatch(
      calls: readonly ChainRpcCall[],
      signal: AbortSignal,
    ): Promise<readonly PromiseSettledResult<unknown>[]> {
      if (!Array.isArray(calls) || calls.length < 1 || calls.length > rpcBatchCallLimit) {
        throw new TypeError("RPC batch size is invalid.");
      }
      const expected = new Map<string, ChainRpcMethod>();
      const requests: string[] = [];
      for (const call of calls) {
        if (!isPlainObject(call) || !hasExactKeys(call, ["method", "params"])) {
          throw new TypeError("RPC batch call is invalid.");
        }
        const method = call["method"];
        const params = call["params"];
        if (typeof method !== "string" || !allowedMethods.has(method as ChainRpcMethod) || !Array.isArray(params)) {
          throw new TypeError("RPC batch call is invalid.");
        }
        const admittedMethod = method as ChainRpcMethod;
        const id = nextRequestId.toString(10);
        nextRequestId += 1n;
        expected.set(id, admittedMethod);
        requests.push(serializeRequest(id, admittedMethod, params));
      }
      return parseBatchResponse(await sendBody(`[${requests.join(",")}]`, signal), expected);
    },
  };
  return Object.freeze(requester);
};
