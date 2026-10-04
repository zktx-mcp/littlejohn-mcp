import { describe, expect, it } from "vitest";

import {parseEvmAddressInput} from "../../src/evm/address-input.js";
import {parseEvmChainId} from "../../src/evm/identities.js";
import {parseHexBytes, parseHash32} from "../../src/core/index.js";
import type { Erc20CallEncoder } from "../../src/chain/evm-standard.js";
import {
  ChainRpcError,
  canonicalBlockReference,
  createBoundedRpcRequester,
  type ChainRpcMethod,
  type ChainRpcRequestMap,
  type RpcRequester,
} from "../../src/chain/rpc.js";
import { readTokenMetadataAtBlock } from "../../src/chain/token-metadata.js";

const asset = Object.freeze({
  kind: "erc20" as const,
  chainId: parseEvmChainId("eip155:4663"),
  address: parseEvmAddressInput(`0x${"12".repeat(20)}`),
});
const reference = canonicalBlockReference(parseHash32(`0x${"ab".repeat(32)}`));
const word = (value: bigint): string => `0x${value.toString(16).padStart(64, "0")}`;
const text = (value: string): string => {
  const bytes = Buffer.from(value, "utf8");
  const padding = (32 - bytes.length % 32) % 32;
  return `${word(32n)}${word(BigInt(bytes.length)).slice(2)}${bytes.toString("hex")}${"0".repeat(padding * 2)}`;
};

class Encoder implements Erc20CallEncoder {
  balanceOf(): ReturnType<Erc20CallEncoder["balanceOf"]> {
    return parseHexBytes(`0x70a08231${"0".repeat(64)}`);
  }
  decimals(): ReturnType<Erc20CallEncoder["decimals"]> {
    return parseHexBytes("0x313ce567");
  }
  name(): ReturnType<Erc20CallEncoder["name"]> {
    return parseHexBytes("0x06fdde03");
  }
  symbol(): ReturnType<Erc20CallEncoder["symbol"]> {
    return parseHexBytes("0x95d89b41");
  }
  totalSupply(): ReturnType<Erc20CallEncoder["totalSupply"]> {
    return parseHexBytes("0x18160ddd");
  }
}

const encoder = new Encoder();

describe("token metadata read process", () => {
  it("starts the three same-block calls in canonical order and returns one frozen result", async () => {
    const calls: Array<readonly unknown[]> = [];
    const rpc: RpcRequester = {
      async request<Method extends ChainRpcMethod>(
        method: Method,
        params: ChainRpcRequestMap[Method],
      ): Promise<unknown> {
        expect(method).toBe("eth_call");
        calls.push(params);
        const data = (params[0] as { readonly data: string }).data;
        if (data === "0x06fdde03") return text("Example");
        if (data === "0x95d89b41") return text("EXT");
        if (data === "0x313ce567") return word(18n);
        throw new Error("Unexpected selector.");
      },
    };

    const result = await readTokenMetadataAtBlock({ rpc, encoder }, {
      asset,
      stateReference: reference,
      signal: new AbortController().signal,
    });

    expect(result).toEqual({
      name: { status: "available", value: "Example" },
      symbol: { status: "available", value: "EXT" },
      decimals: { status: "available", value: "18" },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(calls.map((params) => (params[0] as { readonly data: string }).data)).toEqual([
      "0x06fdde03",
      "0x95d89b41",
      "0x313ce567",
    ]);
    expect(calls.every((params) => params[1] === reference)).toBe(true);
  });

  it("keeps execution revert and malformed optional values field-local", async () => {
    const rpc = createBoundedRpcRequester({
      url: "https://rpc.example",
      fetch: (async (_input, init) => {
        if (typeof init?.body !== "string") throw new TypeError("Missing RPC body.");
        const request = JSON.parse(init.body) as {
          readonly id: string;
          readonly params: readonly [{ readonly data: string }];
        };
        const data = request.params[0].data;
        if (data === "0x06fdde03") {
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            error: { code: 3, message: "execution reverted", data: "0x" },
          }));
        }
        const result = data === "0x95d89b41" ? "0x01" : word(256n);
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
      }) as typeof fetch,
    });

    await expect(readTokenMetadataAtBlock({ rpc, encoder }, {
      asset,
      stateReference: reference,
      signal: new AbortController().signal,
    })).resolves.toEqual({
      name: { status: "unavailable", reason: "call_failed" },
      symbol: { status: "unavailable", reason: "malformed" },
      decimals: { status: "unavailable", reason: "malformed" },
    });
  });

  it("propagates a general failure only after aborting and draining both siblings", async () => {
    let started = 0;
    let aborted = 0;
    let markStarted!: () => void;
    const allStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    let markAborted!: () => void;
    const allAborted = new Promise<void>((resolve) => { markAborted = resolve; });
    const release: Array<() => void> = [];
    const rpc: RpcRequester = {
      async request<Method extends ChainRpcMethod>(
        _method: Method,
        params: ChainRpcRequestMap[Method],
        signal: AbortSignal,
      ): Promise<unknown> {
        const data = (params[0] as { readonly data: string }).data;
        if (data === "0x06fdde03") throw new ChainRpcError("source_inconsistent");
        return await new Promise<never>((_resolve, reject) => {
          started += 1;
          if (started === 2) markStarted();
          const onAbort = (): void => {
            aborted += 1;
            if (aborted === 2) markAborted();
          };
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
          release.push(() => reject(new ChainRpcError("request_aborted")));
        });
      },
    };

    let settled = false;
    const operation = readTokenMetadataAtBlock({ rpc, encoder }, {
      asset,
      stateReference: reference,
      signal: new AbortController().signal,
    }).finally(() => { settled = true; });
    await allStarted;
    await allAborted;
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(settled).toBe(false);
    for (const settle of release) settle();
    await expect(operation).rejects.toMatchObject({ code: "source_inconsistent" });
    expect(aborted).toBe(2);
  });
});
