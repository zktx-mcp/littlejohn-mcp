import { describe, expect, it } from "vitest";

import {
  createCanonicalClock,
  createObservationAuthority,
  evmAccountIdentitySchema,
  observationIdSchema,
  parseEvmChainId,
  parseUnsignedDecimal,
  sourceReferenceSchema,
  type ObservationWriter,
} from "../../src/core/index.js";
import { createAccountAssetChainReadPort } from "../../src/chain/account-assets.js";
import {
  readConfiguredCanonicalBlock,
  resolveConfiguredCanonicalBlock,
  type CanonicalBlock,
} from "../../src/chain/canonical-block.js";
import { validateConfiguredChain } from "../../src/chain/configured-chain.js";
import { createErc20CallEncoder } from "../../src/chain/evm-standard.js";
import {
  createChainInvocationLifecycle,
  type ChainInvocationContext,
} from "../../src/chain/invocation-lifecycle.js";
import { createOfficialAssetChainReadPort } from "../../src/chain/official-assets.js";
import {
  createReferenceMarketCallEncoder,
  createReferenceMarketChainReadPort,
} from "../../src/chain/reference-market.js";
import type { ChainRpcMethod, ChainRpcRequestMap, RpcRequester } from "../../src/chain/rpc.js";

const chainId = parseEvmChainId("eip155:4663");
const blockHash = `0x${"ab".repeat(32)}` as const;
const observationId = observationIdSchema.parse(`obs:${"A".repeat(43)}`);

class RecordingRpc implements RpcRequester {
  readonly calls: Array<Readonly<{ method: ChainRpcMethod; params: readonly unknown[] }>> = [];
  constructor(readonly respond: (method: ChainRpcMethod) => unknown) {}
  async request<Method extends ChainRpcMethod>(
    method: Method,
    params: ChainRpcRequestMap[Method],
    _signal: AbortSignal,
  ): Promise<unknown> {
    this.calls.push({ method, params });
    return this.respond(method);
  }
}

const runWithChainInvocation = async <Result>(
  effect: (context: ChainInvocationContext) => Promise<Result>,
): Promise<Result> => {
  const lifecycle = createChainInvocationLifecycle(new AbortController().signal);
  try {
    return await lifecycle.run(new AbortController().signal, effect);
  } finally {
    await lifecycle.close();
  }
};

describe("shared chain read processes", () => {
  it("validates only the configured chain and records its evidence", async () => {
    const rpc = new RecordingRpc(() => "0x1237");
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
    const recordedIds = new Map<string, typeof observationId>();
    const observations: ObservationWriter = {
      record: (slotId, observation) => {
        records.push([slotId, observation]);
        recordedIds.set(slotId, observationId);
        return observationId;
      },
      get: (slotId) => recordedIds.get(slotId),
    };
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

  it("validates the configured chain before resolving one canonical block", async () => {
    const rpc = new RecordingRpc((method) => method === "eth_chainId"
      ? "0x1237"
      : { number: "0x2c", hash: blockHash, timestamp: "0x687787a4" });
    const resolved = await runWithChainInvocation(async (context) => {
      const block = await resolveConfiguredCanonicalBlock({
        rpc,
        chainId,
        selector: { kind: "number", blockNumber: parseUnsignedDecimal("44") },
        context,
      });
      const state = readConfiguredCanonicalBlock({ context, block, chainId });
      return Object.freeze({ block, stateReference: state.stateReference });
    });
    expect(resolved.block).toEqual({
      anchor: {
        chainId,
        blockNumber: "44",
        blockHash,
        blockTimestamp: "2025-07-16T11:06:12.000Z",
      },
    });
    expect(Object.keys(resolved.block)).toEqual(["anchor"]);
    expect(resolved.stateReference).toEqual({ blockHash, requireCanonical: true });
    expect(rpc.calls).toEqual([
      { method: "eth_chainId", params: [] },
      { method: "eth_getBlockByNumber", params: ["0x2c", false] },
    ]);
  });

  it("rejects a selector response for a different block", async () => {
    const rpc = new RecordingRpc((method) => method === "eth_chainId"
      ? "0x1237"
      : { number: "0x2d", hash: blockHash, timestamp: "0x687787a4" });
    await expect(runWithChainInvocation((context) => resolveConfiguredCanonicalBlock({
      rpc,
      chainId,
      selector: { kind: "number", blockNumber: parseUnsignedDecimal("44") },
      context,
    }))).rejects.toMatchObject({ failure: { error: { code: "source_inconsistent" } } });
  });

  it("does not read a block when the configured RPC reports another chain", async () => {
    const rpc = new RecordingRpc(() => "0x1");
    await expect(runWithChainInvocation((context) => resolveConfiguredCanonicalBlock({
      rpc,
      chainId,
      selector: { kind: "latest" },
      context,
    }))).rejects.toMatchObject({ failure: { error: { code: "source_inconsistent" } } });
    expect(rpc.calls).toEqual([{ method: "eth_chainId", params: [] }]);
  });

  it("rejects copied, detached, foreign, stale, wrong-chain, and wrong-block authority", async () => {
    const lifecycle = createChainInvocationLifecycle(new AbortController().signal);
    const foreignLifecycle = createChainInvocationLifecycle(new AbortController().signal);
    const issuanceRpc = new RecordingRpc((method) => method === "eth_chainId"
      ? "0x1237"
      : { number: "0x2c", hash: blockHash, timestamp: "0x687787a4" });
    let staleContext!: ChainInvocationContext;
    let detachedBlock!: CanonicalBlock;
    await lifecycle.run(new AbortController().signal, async (context) => {
      const block = await resolveConfiguredCanonicalBlock({
        rpc: issuanceRpc,
        chainId,
        selector: { kind: "number", blockNumber: parseUnsignedDecimal("44") },
        context,
      });
      const plain = Object.freeze({ anchor: block.anchor }) as CanonicalBlock;
      const clone = Object.freeze({
        anchor: Object.freeze({ ...block.anchor }),
      }) as CanonicalBlock;
      expect(() => readConfiguredCanonicalBlock({ context, block: plain, chainId })).toThrow(TypeError);
      expect(() => readConfiguredCanonicalBlock({ context, block: clone, chainId })).toThrow(TypeError);
      expect(() => readConfiguredCanonicalBlock({
        context,
        block,
        chainId: parseEvmChainId("eip155:1"),
      })).toThrow(TypeError);

      await lifecycle.run(new AbortController().signal, async (otherContext) => {
        const otherBlock = await resolveConfiguredCanonicalBlock({
          rpc: issuanceRpc,
          chainId,
          selector: { kind: "number", blockNumber: parseUnsignedDecimal("44") },
          context: otherContext,
        });
        expect(() => readConfiguredCanonicalBlock({
          context,
          block: otherBlock,
          chainId,
        })).toThrow(TypeError);
        expect(() => readConfiguredCanonicalBlock({
          context: otherContext,
          block,
          chainId,
        })).toThrow(TypeError);
      });

      await foreignLifecycle.run(new AbortController().signal, async (foreignContext) => {
        expect(() => readConfiguredCanonicalBlock({
          context: foreignContext,
          block,
          chainId,
        })).toThrow(TypeError);
      });
      staleContext = context;
      detachedBlock = block;
    });
    expect(() => readConfiguredCanonicalBlock({
      context: staleContext,
      block: detachedBlock,
      chainId,
    })).toThrow(TypeError);
    await Promise.all([lifecycle.close(), foreignLifecycle.close()]);
  });

  it("rejects counterfeit blocks in every at-block port before state RPC", async () => {
    const lifecycle = createChainInvocationLifecycle(new AbortController().signal);
    const issuanceRpc = new RecordingRpc((method) => method === "eth_chainId"
      ? "0x1237"
      : { number: "0x2c", hash: blockHash, timestamp: "0x687787a4" });
    const stateRpc = new RecordingRpc(() => {
      throw new Error("A counterfeit block must fail before state RPC.");
    });
    const clock = createCanonicalClock(() => "2026-07-20T00:00:00.000Z");
    const observationAuthority = createObservationAuthority({
      clock,
      sourceClass: "chain_rpc",
      owner: "user_configured",
      reference: sourceReferenceSchema.parse({
        kind: "public",
        sourceId: "configured_chain_test",
        uri: "https://rpc.example/",
      }),
    });
    const accountPort = createAccountAssetChainReadPort({
      rpc: stateRpc,
      encoder: await createErc20CallEncoder(),
      chainId,
      lifecycle,
    });
    const officialPort = createOfficialAssetChainReadPort({
      rpc: stateRpc,
      chainId,
      lifecycle,
    });
    const referencePort = createReferenceMarketChainReadPort({
      rpc: stateRpc,
      encoder: createReferenceMarketCallEncoder(),
      chainId,
      lifecycle,
      clock,
      observationAuthority,
    });
    const account = evmAccountIdentitySchema.parse({
      chainId,
      address: `0x${"12".repeat(20)}`,
    });
    await lifecycle.run(new AbortController().signal, async (context) => {
      const block = await resolveConfiguredCanonicalBlock({
        rpc: issuanceRpc,
        chainId,
        selector: { kind: "number", blockNumber: parseUnsignedDecimal("44") },
        context,
      });
      const counterfeit = Object.freeze({
        anchor: Object.freeze({ ...block.anchor }),
      }) as CanonicalBlock;
      await expect(accountPort.readCollectionAtBlock({
        account,
        assets: [],
        block: counterfeit,
      }, context)).rejects.toThrow(TypeError);
      await expect(officialPort.verifyManyAtBlock([], counterfeit, context)).rejects.toThrow(TypeError);
      await expect(referencePort.readLatestAtBlock(
        ["eth_usd"],
        counterfeit,
        context,
      )).rejects.toThrow(TypeError);
    });
    expect(stateRpc.calls).toEqual([]);
    await lifecycle.close();
  });
});
