import { describe, expect, it } from "vitest";

import {
  createCanonicalClock,
  createObservationAuthority,
  parseEvmChainId,
  parseUnsignedDecimal,
  sourceReferenceSchema,
  type ObservationWriter,
} from "../../src/core/index.js";
import { resolveCanonicalBlock } from "../../src/chain/canonical-block.js";
import { validateConfiguredChain } from "../../src/chain/configured-chain.js";
import type { ChainRpcMethod, ChainRpcRequestMap, RpcRequester } from "../../src/chain/rpc.js";

const chainId = parseEvmChainId("eip155:4663");
const blockHash = `0x${"ab".repeat(32)}` as const;

class RecordingRpc implements RpcRequester {
  readonly calls: Array<Readonly<{ method: ChainRpcMethod; params: readonly unknown[] }>> = [];
  constructor(readonly response: unknown) {}
  async request<Method extends ChainRpcMethod>(
    method: Method,
    params: ChainRpcRequestMap[Method],
  ): Promise<unknown> {
    this.calls.push({ method, params });
    return this.response;
  }
}

describe("shared chain read processes", () => {
  it("validates only the configured chain and records its evidence", async () => {
    const rpc = new RecordingRpc("0x1237");
    const records: unknown[] = [];
    const clock = createCanonicalClock(() => "2026-07-20T00:00:00.000Z");
    const rpcSource = createObservationAuthority({
      clock,
      sourceClass: "chain_rpc",
      owner: "user_configured",
      reference: sourceReferenceSchema.parse({
        kind: "public",
        sourceId: "configured_chain_test",
        uri: "https://rpc.example/",
      }),
    });
    const observations = {
      record: (...input: unknown[]) => { records.push(input); return "observation"; },
    } as unknown as ObservationWriter;
    await validateConfiguredChain({
      rpc,
      chainId,
      rpcSource,
      signal: new AbortController().signal,
      observations,
    });
    expect(rpc.calls).toEqual([{ method: "eth_chainId", params: [] }]);
    expect(records).toHaveLength(1);
  });

  it("resolves one selector to a canonical hash reference without validating the chain", async () => {
    const rpc = new RecordingRpc({ number: "0x2c", hash: blockHash, timestamp: "0x687787a4" });
    const block = await resolveCanonicalBlock({
      rpc,
      chainId,
      selector: { kind: "number", blockNumber: parseUnsignedDecimal("44") },
      signal: new AbortController().signal,
    });
    expect(block).toMatchObject({
      anchor: { blockNumber: "44", blockHash },
      stateReference: { blockHash, requireCanonical: true },
    });
    expect(rpc.calls).toEqual([{ method: "eth_getBlockByNumber", params: ["0x2c", false] }]);
  });

  it("rejects a selector response for a different block", async () => {
    const rpc = new RecordingRpc({ number: "0x2d", hash: blockHash, timestamp: "0x687787a4" });
    await expect(resolveCanonicalBlock({
      rpc,
      chainId,
      selector: { kind: "number", blockNumber: parseUnsignedDecimal("44") },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ failure: { error: { code: "source_inconsistent" } } });
  });
});
