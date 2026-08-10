import { describe, expect, it } from "vitest";

import {
  chainStatusEvidence,
  createCanonicalClock,
  createObservationAuthority,
  erc20AssetIdentitySchema,
  evmAccountIdentitySchema,
  observationIdSchema,
  parseEvmChainId,
  parseHash32,
  parseUnsignedDecimal,
  sourceReferenceSchema,
  type ObservationWriter,
} from "../../src/core/index.js";
import {
  createEvidenceReplayBinder,
  createEvidenceReplayLayout,
} from "../../src/core/evidence-replay.js";
import { createAccountAssetChainReadPort } from "../../src/chain/account-assets.js";
import {
  readConfiguredCanonicalBlock,
  resolveConfiguredCanonicalBlock,
  type CanonicalBlock,
} from "../../src/chain/canonical-block.js";
import { validateConfiguredChain } from "../../src/chain/configured-chain.js";
import { createErc20CallEncoder } from "../../src/chain/evm-standard.js";
import { ChainOperationError, getChainOperationFailure } from "../../src/chain/errors.js";
import {
  createChainInvocationLifecycle,
  type ChainInvocationContext,
} from "../../src/chain/invocation-lifecycle.js";
import { createOfficialAssetChainReadPort } from "../../src/chain/official-assets.js";
import {
  createReferenceMarketCallEncoder,
  createReferenceMarketChainReadPort,
} from "../../src/chain/reference-market.js";
import {
  ChainRpcError,
  type ChainRpcMethod,
  type ChainRpcRequestMap,
  type RpcRequester,
} from "../../src/chain/rpc.js";
import {
  officialAssetSourceMemberSchema,
  stockFactoryAdmissionManifest,
} from "../../src/registry/index.js";
import {
  stockFactoryImplementationCodeFixture,
  stockFactoryProxyCodeFixture,
} from "../registry/stock-factory-fixture.js";

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

class OverlappingRpc implements RpcRequester {
  active = 0;
  maximumActive = 0;
  readonly calls: Array<Readonly<{ method: ChainRpcMethod; params: readonly unknown[] }>> = [];

  async request<Method extends ChainRpcMethod>(
    method: Method,
    params: ChainRpcRequestMap[Method],
    _signal: AbortSignal,
  ): Promise<unknown> {
    this.calls.push({ method, params });
    this.active += 1;
    this.maximumActive = Math.max(this.maximumActive, this.active);
    try {
      const callData = method === "eth_call" &&
          typeof params[0] === "object" && params[0] !== null &&
          "data" in params[0] && typeof params[0].data === "string"
        ? params[0].data
        : undefined;
      await new Promise<void>((resolve) =>
        setTimeout(resolve, callData?.startsWith("0x01ffc9a7") === true ? 0 : 20));
      if (method === "eth_getBalance") return "0x0";
      if (callData?.startsWith("0x01ffc9a7") === true) {
        return callData.includes("ffffffff")
          ? `0x${"00".repeat(32)}`
          : `0x${"00".repeat(31)}01`;
      }
      if (method === "eth_call") return `0x${"00".repeat(32)}`;
      throw new TypeError(`Unexpected test RPC method: ${method}`);
    } finally {
      this.active -= 1;
    }
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
    const layout = createEvidenceReplayLayout(chainStatusEvidence.definition, [
      chainStatusEvidence.configuredChain.target,
      chainStatusEvidence.targets.latestBlock,
    ]);
    const binder = createEvidenceReplayBinder(chainStatusEvidence.definition, layout);
    const chainTarget = binder.bind(chainStatusEvidence.configuredChain.target);
    const recordedIds = new Map<Parameters<ObservationWriter["get"]>[0], typeof observationId>();
    const observations: ObservationWriter = {
      bind: (target) => binder.bind(target),
      bindRole: (role) => binder.bindRole(role),
      record: (slot, observation) => {
        records.push([slot, observation]);
        recordedIds.set(slot, observationId);
        return observationId;
      },
      get: (slot) => recordedIds.get(slot),
    };
    await validateConfiguredChain({
      rpc,
      chainId,
      rpcSource,
      signal: new AbortController().signal,
      observations,
      target: chainTarget,
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

  it("preserves an incomplete StockFactory response as its canonical classification reason", async () => {
    const lifecycle = createChainInvocationLifecycle(new AbortController().signal);
    const issuanceRpc = new RecordingRpc((method) => method === "eth_chainId"
      ? "0x1237"
      : { number: "0x2c", hash: blockHash, timestamp: "0x687787a4" });
    let codeReads = 0;
    const stateRpc: RpcRequester = {
      async request(method) {
        if (method === "eth_getCode") {
          codeReads += 1;
          return codeReads === 1
            ? stockFactoryProxyCodeFixture
            : stockFactoryImplementationCodeFixture;
        }
        if (method === "eth_getStorageAt") {
          return `0x${"0".repeat(24)}${stockFactoryAdmissionManifest.implementationAddress.slice(2)}`;
        }
        if (method === "eth_call") {
          throw new ChainRpcError("chain_response_unavailable");
        }
        throw new TypeError(`Unexpected StockFactory RPC method: ${method}.`);
      },
    };
    const officialPort = createOfficialAssetChainReadPort({
      rpc: stateRpc,
      chainId,
      lifecycle,
    });
    const member = officialAssetSourceMemberSchema.parse({
      assetUid: parseHash32(`0x${"12".repeat(32)}`),
      contractAddress: `0x${"34".repeat(20)}`,
    });

    await lifecycle.run(new AbortController().signal, async (context) => {
      const block = await resolveConfiguredCanonicalBlock({
        rpc: issuanceRpc,
        chainId,
        selector: { kind: "number", blockNumber: parseUnsignedDecimal("44") },
        context,
      });
      await expect(officialPort.verifyManyAtBlock([member], block, context)).resolves.toEqual([{
        status: "unavailable",
        member,
        reason: "chain_response_unavailable",
      }]);
    });
    await lifecycle.close();
  });

  it("drains a failed StockFactory batch and selects whole-request failure by member order", async () => {
    const lifecycle = createChainInvocationLifecycle(new AbortController().signal);
    const issuanceRpc = new RecordingRpc((method) => method === "eth_chainId"
      ? "0x1237"
      : { number: "0x2c", hash: blockHash, timestamp: "0x687787a4" });
    let codeReads = 0;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    let releaseFirst!: () => void;
    const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const members = [
      officialAssetSourceMemberSchema.parse({
        assetUid: parseHash32(`0x${"21".repeat(32)}`),
        contractAddress: `0x${"31".repeat(20)}`,
      }),
      officialAssetSourceMemberSchema.parse({
        assetUid: parseHash32(`0x${"22".repeat(32)}`),
        contractAddress: `0x${"32".repeat(20)}`,
      }),
    ];
    const stateRpc: RpcRequester = {
      async request(method, params) {
        if (method === "eth_getCode") {
          codeReads += 1;
          return codeReads === 1
            ? stockFactoryProxyCodeFixture
            : stockFactoryImplementationCodeFixture;
        }
        if (method === "eth_getStorageAt") {
          return `0x${"0".repeat(24)}${stockFactoryAdmissionManifest.implementationAddress.slice(2)}`;
        }
        if (method === "eth_call") {
          const call = params[0] as { readonly data: string };
          if (call.data.endsWith(members[0]!.assetUid.slice(2))) {
            markFirstStarted();
            await firstRelease;
            throw new ChainRpcError("runtime_busy");
          }
          await firstStarted;
          throw new ChainOperationError("runtime_state_unavailable");
        }
        throw new TypeError(`Unexpected StockFactory RPC method: ${method}.`);
      },
    };
    const officialPort = createOfficialAssetChainReadPort({ rpc: stateRpc, chainId, lifecycle });

    await lifecycle.run(new AbortController().signal, async (context) => {
      const block = await resolveConfiguredCanonicalBlock({
        rpc: issuanceRpc,
        chainId,
        selector: { kind: "number", blockNumber: parseUnsignedDecimal("44") },
        context,
      });
      let settled = false;
      const pending = officialPort.verifyManyAtBlock(members, block, context).finally(() => {
        settled = true;
      });
      await firstStarted;
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      expect(settled).toBe(false);
      releaseFirst();
      await expect(pending).rejects.toSatisfy((error: unknown) =>
        getChainOperationFailure(error)?.error.code === "runtime_busy");
    });
    await lifecycle.close();
  });

  it("bounds nested account-asset RPC work below the process-wide requester limit", async () => {
    const lifecycle = createChainInvocationLifecycle(new AbortController().signal);
    const issuanceRpc = new RecordingRpc((method) => method === "eth_chainId"
      ? "0x1237"
      : { number: "0x2c", hash: blockHash, timestamp: "0x687787a4" });
    const stateRpc = new OverlappingRpc();
    const accountPort = createAccountAssetChainReadPort({
      rpc: stateRpc,
      encoder: await createErc20CallEncoder(),
      chainId,
      lifecycle,
    });
    const account = evmAccountIdentitySchema.parse({
      chainId,
      address: `0x${"12".repeat(20)}`,
    });
    const assets = Array.from({ length: 5 }, (_, index) =>
      erc20AssetIdentitySchema.parse({
        kind: "erc20",
        chainId,
        address: `0x${(index + 1).toString(16).padStart(40, "0")}`,
      }));

    await lifecycle.run(new AbortController().signal, async (context) => {
      const block = await resolveConfiguredCanonicalBlock({
        rpc: issuanceRpc,
        chainId,
        selector: { kind: "number", blockNumber: parseUnsignedDecimal("44") },
        context,
      });
      const result = await accountPort.readCollectionAtBlock({
        account,
        assets,
        block,
      }, context);
      expect(result.tokens.map((token) => token.asset)).toEqual(assets);
      expect(result.tokens.every((token) =>
        token.requiredStandards.block.blockHash === blockHash)).toBe(true);
      expect(result.tokens.every((token) =>
        token.requiredStandards.erc8056.status === "supported")).toBe(true);
    });

    expect(stateRpc.maximumActive).toBe(8);
    expect(stateRpc.active).toBe(0);
    await lifecycle.close();
  });
});
