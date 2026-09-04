import { describe, expect, it } from "vitest";

import {
  createCanonicalClock,
  createObservationAuthority,
  createObservationAuthorityIssuer,
  addressInspectEvidence,
  keccak256FromHex,
  observationIdSchema,
  parseEvmAddressInput,
  parseEvmChainId,
  parseHexBytes,
  parseHash32,
  parseUnsignedDecimal,
  sourceReferenceSchema,
  type ObservationWriter,
} from "../../src/core/index.js";
import {
  createContractSourceVerificationPort,
  type ContractSourceVerificationPort,
} from "../../src/intelligence/ports.js";
import {
  createEvidenceReplayBinder,
  createEvidenceReplayLayout,
} from "../../src/core/evidence-replay.js";
import {
  ChainRpcError,
  type ChainRpcMethod,
  type ChainRpcRequestMap,
  type RpcRequester,
} from "../../src/chain/rpc.js";
import {
  createChainInvocationLifecycle,
  type ChainInvocationContext,
} from "../../src/chain/invocation-lifecycle.js";
import { createErc20CallEncoder } from "../../src/chain/evm-standard.js";
import {
  createPinnedEvmReadPort,
  normalizePinnedEvmReadFailure,
} from "../../src/chain/protocol-reads.js";
import type { CanonicalBlock } from "../../src/chain/canonical-block.js";

const chainId = parseEvmChainId("eip155:4663");
const address = parseEvmAddressInput(`0x${"12".repeat(20)}`);
const blockHash = `0x${"ab".repeat(32)}` as const;
const runtimeCode = parseHexBytes("0x6000");

class RecordingRpc implements RpcRequester {
  readonly calls: Array<Readonly<{
    method: ChainRpcMethod;
    params: readonly unknown[];
    signal: AbortSignal;
  }>> = [];

  async request<Method extends ChainRpcMethod>(
    method: Method,
    params: ChainRpcRequestMap[Method],
    signal: AbortSignal,
  ): Promise<unknown> {
    this.calls.push(Object.freeze({ method, params, signal }));
    if (method === "eth_chainId") return "0x1237";
    if (method === "eth_getBlockByNumber") {
      return { number: "0x2c", hash: blockHash, timestamp: "0x687787a4" };
    }
    if (method === "eth_getCode") return runtimeCode;
    if (method === "eth_getStorageAt") return `0x${"0".repeat(64)}`;
    if (method === "eth_call") {
      return `0x${"0".repeat(62)}12`;
    }
    throw new TypeError(`Unexpected RPC method: ${method}.`);
  }
}

const createPort = async (
  lifecycle: ReturnType<typeof createChainInvocationLifecycle>,
  rpc: RpcRequester,
) => {
  const clock = createCanonicalClock(() => "2026-07-27T00:00:00.000Z");
  const observationAuthority = createObservationAuthority({
    clock,
    sourceClass: "chain_rpc",
    owner: "user_configured",
    reference: sourceReferenceSchema.parse({
      kind: "public",
      sourceId: "protocol_read_test",
      uri: "https://rpc.example/",
    }),
  });
  const unusedSourceVerification = Object.freeze({
    inspect: async () => {
      throw new Error("Contract inspection is not used by this test.");
    },
  }) as ContractSourceVerificationPort;
  return createPinnedEvmReadPort({
    rpc,
    chainId,
    lifecycle,
    erc20Encoder: await createErc20CallEncoder(),
    contractSourceVerification: unusedSourceVerification,
    observationAuthority,
  });
};

const createAnalysisPort = async (
  lifecycle: ReturnType<typeof createChainInvocationLifecycle>,
  rpc: RpcRequester,
  useForeignSourceAuthority = false,
) => {
  const clock = createCanonicalClock(() => "2026-07-27T00:00:00.000Z");
  const observationAuthority = createObservationAuthority({
    clock,
    sourceClass: "chain_rpc",
    owner: "user_configured",
    reference: sourceReferenceSchema.parse({
      kind: "public",
      sourceId: "protocol_read_test",
      uri: "https://rpc.example/",
    }),
  });
  const issuer = createObservationAuthorityIssuer({
    clock,
    sourceClass: "contract_verification_service",
    owner: "Sourcify",
    referenceKind: "public",
    sourceId: "sourcify-v2",
  });
  const foreignIssuer = createObservationAuthorityIssuer({
    clock,
    sourceClass: "contract_verification_service",
    owner: "foreign_verifier",
    referenceKind: "public",
    sourceId: "sourcify-v2",
  });
  const sourceVerification = createContractSourceVerificationPort({
    observationAuthorityRegistration: issuer.registration,
    async inspect(request) {
      const reference = sourceReferenceSchema.parse({
        kind: "public",
        sourceId: "sourcify-v2",
        uri: `https://sourcify.example/contract/${request.address}`,
      });
      if (reference.kind !== "public") throw new TypeError("Expected a public reference.");
      return {
        status: "no_record_observed",
        reference,
        observationAuthority: (useForeignSourceAuthority ? foreignIssuer : issuer).issue(reference),
      };
    },
  });
  return createPinnedEvmReadPort({
    rpc,
    chainId,
    lifecycle,
    erc20Encoder: await createErc20CallEncoder(),
    contractSourceVerification: sourceVerification,
    observationAuthority,
  });
};

const createContractAnalysisObservationWriter = () => {
  const layout = createEvidenceReplayLayout(addressInspectEvidence.definition, [
    addressInspectEvidence.configuredChain.target,
    addressInspectEvidence.validatedInput.target,
    addressInspectEvidence.targets.runtimeCode,
    ...Object.values(addressInspectEvidence.analysis.targets),
  ]);
  const binder = createEvidenceReplayBinder(addressInspectEvidence.definition, layout);
  const observationId = observationIdSchema.parse(
    `obs:${Buffer.alloc(32, 9).toString("base64url")}`,
  );
  const records: Array<Parameters<ObservationWriter["record"]>> = [];
  const recorded = new Map<
    Parameters<ObservationWriter["get"]>[0],
    typeof observationId
  >();
  const observations: ObservationWriter = {
    bind: (target) => binder.bind(target),
    bindRole: (role) => binder.bindRole(role),
    record(slot, observation) {
      records.push([slot, observation]);
      recorded.set(slot, observationId);
      return observationId;
    },
    get: (slot) => recorded.get(slot),
  };
  return { observations, records };
};

describe("pinned EVM protocol reads", () => {
  it("preserves the canonical incomplete-response failure at the protocol boundary", () => {
    expect(normalizePinnedEvmReadFailure(
      new ChainRpcError("chain_response_unavailable"),
      new AbortController().signal,
    )).toBe("chain_response_unavailable");
  });

  it("uses one EIP-1898 block for code, calls, and token decimals", async () => {
    const lifecycle = createChainInvocationLifecycle(new AbortController().signal);
    const rpc = new RecordingRpc();
    const port = await createPort(lifecycle, rpc);
    await lifecycle.run(new AbortController().signal, async (context) => {
      const block = await port.resolveBlock(context, {
        kind: "number",
        blockNumber: parseUnsignedDecimal("44"),
      });
      const code = await port.readRuntimeCode(context, block, address);
      const call = await port.call(context, block, {
        to: address,
        data: parseHexBytes("0x1234"),
      });
      const decimals = await port.readTokenDecimals(context, block, address);
      expect(code).toEqual({
        bytecode: runtimeCode,
        identity: {
          byteLength: "2",
          codeHash: keccak256FromHex(runtimeCode),
        },
      });
      expect(call).toEqual({
        status: "observed",
        value: `0x${"0".repeat(62)}12`,
      });
      expect(decimals).toEqual({ status: "observed", value: "18" });
      const stateCalls = rpc.calls.filter(
        (entry) => entry.method === "eth_getCode" || entry.method === "eth_call",
      );
      expect(stateCalls).toHaveLength(3);
      for (const entry of stateCalls) {
        expect(entry.params.at(-1)).toEqual({ blockHash, requireCanonical: true });
        expect(entry.signal).toBe(context.signal);
      }
    });
    await lifecycle.close();
  });

  it("rejects copied, foreign, and settled invocation authority before state RPC", async () => {
    const lifecycle = createChainInvocationLifecycle(new AbortController().signal);
    const foreignLifecycle = createChainInvocationLifecycle(new AbortController().signal);
    const rpc = new RecordingRpc();
    const port = await createPort(lifecycle, rpc);
    let settledContext!: ChainInvocationContext;
    let settledBlock!: CanonicalBlock;
    await lifecycle.run(new AbortController().signal, async (context) => {
      const block = await port.resolveBlock(context, { kind: "latest" });
      const copied = Object.freeze({
        anchor: Object.freeze({ ...block.anchor }),
      }) as CanonicalBlock;
      const before = rpc.calls.length;
      await expect(port.readRuntimeCode(context, copied, address)).rejects.toThrow(TypeError);
      expect(rpc.calls).toHaveLength(before);
      await foreignLifecycle.run(new AbortController().signal, async (foreignContext) => {
        await expect(port.readRuntimeCode(foreignContext, block, address)).rejects.toThrow(TypeError);
      });
      expect(rpc.calls).toHaveLength(before);
      settledContext = context;
      settledBlock = block;
    });
    const before = rpc.calls.length;
    await expect(port.call(settledContext, settledBlock, {
      to: address,
      data: parseHexBytes("0x1234"),
    })).rejects.toThrow(TypeError);
    expect(rpc.calls).toHaveLength(before);
    await Promise.all([lifecycle.close(), foreignLifecycle.close()]);
  });

  it("returns only admitted analysis after the existing evidence owner records it", async () => {
    const lifecycle = createChainInvocationLifecycle(new AbortController().signal);
    const rpc = new RecordingRpc();
    const port = await createAnalysisPort(lifecycle, rpc);
    await lifecycle.run(new AbortController().signal, async (context) => {
      const block = await port.resolveBlock(context, { kind: "latest" });
      const code = await port.readRuntimeCode(context, block, address);
      if (code === null) throw new TypeError("Expected runtime code.");
      const { observations, records } = createContractAnalysisObservationWriter();
      const analysis = await port.inspectContract(
        context,
        block,
        { address, runtimeCode: code.identity },
        { fragment: addressInspectEvidence.analysis, observations },
      );
      expect(analysis.target).toBe(address);
      expect(analysis.targetRuntimeCode).toEqual(code.identity);
      expect(Reflect.ownKeys(analysis)).not.toContain("sourceObservations");
      expect(records).toHaveLength(2);
      const recordedSources = records.map(([, observation]) => observation.source);
      expect(recordedSources).toContain(port.observationAuthority);
      expect(recordedSources.some((source) => source !== port.observationAuthority)).toBe(true);
    });
    await lifecycle.close();
  });

  it("rejects a changed expected runtime identity before returning analysis", async () => {
    const lifecycle = createChainInvocationLifecycle(new AbortController().signal);
    const rpc = new RecordingRpc();
    const port = await createAnalysisPort(lifecycle, rpc);
    await lifecycle.run(new AbortController().signal, async (context) => {
      const block = await port.resolveBlock(context, { kind: "latest" });
      const { observations } = createContractAnalysisObservationWriter();
      await expect(port.inspectContract(
        context,
        block,
        {
          address,
          runtimeCode: {
            byteLength: parseUnsignedDecimal("2"),
            codeHash: parseHash32(`0x${"ff".repeat(32)}`),
          },
        },
        { fragment: addressInspectEvidence.analysis, observations },
      )).rejects.toThrow("does not match its target");
    });
    await lifecycle.close();
  });

  it("rejects a source authority not issued by the configured verification port", async () => {
    const lifecycle = createChainInvocationLifecycle(new AbortController().signal);
    const rpc = new RecordingRpc();
    const port = await createAnalysisPort(lifecycle, rpc, true);
    await lifecycle.run(new AbortController().signal, async (context) => {
      const block = await port.resolveBlock(context, { kind: "latest" });
      const code = await port.readRuntimeCode(context, block, address);
      if (code === null) throw new TypeError("Expected runtime code.");
      const { observations } = createContractAnalysisObservationWriter();
      await expect(port.inspectContract(
        context,
        block,
        { address, runtimeCode: code.identity },
        { fragment: addressInspectEvidence.analysis, observations },
      )).rejects.toThrow("authority");
    });
    await lifecycle.close();
  });
});
