import { describe, expect, it } from "vitest";
import {createCanonicalClock, createObservationAuthority, parseHash32, sourceReferenceSchema} from "../../src/core/index.js";
import {dynamicFeeTransactionCallSchema, dynamicFeeRequestCommitment, admitDynamicFeeTransactionRequest} from "../../src/evm/transaction-request.js";
import {parseEvmAddress, parseEvmChainId} from "../../src/evm/identities.js";
import { createChainInvocationLifecycle } from "../../src/chain/invocation-lifecycle.js";
import { resolveConfiguredCanonicalBlock } from "../../src/chain/canonical-block.js";
import { getChainOperationFailure } from "../../src/chain/errors.js";
import { createTransactionChainReadPort, dynamicFeeRequestFromTransaction } from "../../src/chain/transaction-reads.js";
import { normalizeRpcTransaction } from "../../src/chain/normalization.js";
import type { ChainRpcMethod, ChainRpcRequestMap, RpcRequester } from "../../src/chain/rpc.js";

const chainId = parseEvmChainId("eip155:4663");
const sender = parseEvmAddress(`0x${"12".repeat(20)}`);
const target = parseEvmAddress(`0x${"34".repeat(20)}`);
const hash = parseHash32(`0x${"56".repeat(32)}`);
const blockHash = parseHash32(`0x${"78".repeat(32)}`);
const differentHash = parseHash32(`0x${"9a".repeat(32)}`);
const transaction = {
  hash, from: sender, to: target, input: "0x1234", value: "0x0", nonce: "0x7",
  type: "0x2", chainId: "0x1237", gas: "0x186a0", maxFeePerGas: "0xa", maxPriorityFeePerGas: "0x1", accessList: [],
  blockNumber: "0x64", blockHash, transactionIndex: "0x0",
};

class TransactionRpc implements RpcRequester {
  readonly calls: Array<{ method: ChainRpcMethod; params: readonly unknown[] }> = [];
  nonce: unknown = "0x7";
  finalized: unknown = { number: "0x64", hash: blockHash, timestamp: "0x65920080" };
  safe: unknown = this.finalized;
  canonicalHash = blockHash;
  transaction: unknown = transaction;
  async request<Method extends ChainRpcMethod>(method: Method, params: ChainRpcRequestMap[Method]): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === "eth_chainId") return "0x1237";
    if (method === "eth_getBlockByNumber") {
      if (params[0] === "finalized") return this.finalized;
      if (params[0] === "safe") return this.safe;
      return { number: "0x64", hash: this.canonicalHash, timestamp: "0x65920080" };
    }
    if (method === "eth_getBlockByHash") return { number: "0x64", hash: blockHash, timestamp: "0x65920080", transactions: [hash] };
    if (method === "eth_getBalance") return "0x20000000000001";
    if (method === "eth_getTransactionCount") return this.nonce;
    if (method === "eth_estimateGas") return "0x186a0";
    if (method === "eth_call") return "0x";
    if (method === "eth_getTransactionByHash") return this.transaction;
    if (method === "eth_getTransactionReceipt") return {
      transactionHash: hash, from: sender, to: target, type: "0x2", transactionIndex: "0x0", blockNumber: "0x64", blockHash,
      status: "0x1", cumulativeGasUsed: "0x5208", gasUsed: "0x5208", effectiveGasPrice: "0x5", contractAddress: null, logs: [],
    };
    throw new Error(`Unexpected transaction test method ${method}.`);
  }
}

const create = () => {
  const rpc = new TransactionRpc();
  const lifecycle = createChainInvocationLifecycle(new AbortController().signal);
  const clock = createCanonicalClock(() => "2026-09-08T00:00:00.000Z");
  const observationAuthority = createObservationAuthority({ clock, sourceClass: "chain_rpc", owner: "Test RPC", reference: sourceReferenceSchema.parse({ kind: "public", sourceId: "rpc", uri: "https://rpc.example/" }) });
  return { rpc, lifecycle, port: createTransactionChainReadPort({ rpc, lifecycle, chainId, observationAuthority }) };
};

describe("transaction chain reads", () => {
  it("compares every independent observed request field with one fixed pre-send commitment", () => {
    const reviewed = admitDynamicFeeTransactionRequest({ type: "2", accessList: [], chainId, from: sender, to: target,
      value: "0", data: "0x1234", nonce: "7", gasLimit: "100000", maxFeePerGas: "10", maxPriorityFeePerGas: "1" });
    const expected = dynamicFeeRequestCommitment(reviewed);
    const fingerprint = (value: unknown) => dynamicFeeRequestCommitment(dynamicFeeRequestFromTransaction(normalizeRpcTransaction(value, chainId)));
    expect(fingerprint(transaction)).toBe(expected);
    for (const changed of [{ from: target }, { to: sender }, { value: "0x1" }, { input: "0x00" }, { nonce: "0x8" },
      { gas: "0x186a1" }, { maxFeePerGas: "0xb" }, { maxPriorityFeePerGas: "0x2" }]) {
      expect(fingerprint({ ...transaction, ...changed }), JSON.stringify(changed)).not.toBe(expected);
    }
    expect(() => fingerprint({ ...transaction, chainId: "0x1" })).toThrow();
    expect(() => fingerprint({ ...transaction, accessList: [{ address: sender, storageKeys: [] }] })).toThrow();
    const { maxFeePerGas: _max, maxPriorityFeePerGas: _priority, ...legacy } = transaction;
    expect(() => fingerprint({ ...legacy, type: "0x1", gasPrice: "0x5" })).toThrow();
  });
  it("estimates and simulates the complete type-2 envelope against the admitted block", async () => {
    const test = create();
    try {
      await test.lifecycle.run(new AbortController().signal, async (context) => {
        const block = await resolveConfiguredCanonicalBlock({ rpc: test.rpc, chainId, selector: { kind: "latest" }, context });
        const call = dynamicFeeTransactionCallSchema.parse({ type: "2", accessList: [], chainId, from: sender, to: target, value: "0", data: "0x1234", nonce: "7", maxFeePerGas: "10", maxPriorityFeePerGas: "1" });
        expect(await test.port.balance(context, block, sender)).toBe("9007199254740993");
        expect(await test.port.nonce(context, block, sender)).toEqual({ confirmed: "7", pending: "7" });
        expect(await test.port.estimateGas(context, block, call)).toBe("100000");
        const request = admitDynamicFeeTransactionRequest({ ...call, gasLimit: "100000" });
        expect(await test.port.simulate(context, block, request)).toEqual({ status: "returned", data: "0x" });
        const expected = { type: "0x2", accessList: [], chainId: "0x1237", from: sender, to: target, data: "0x1234", value: "0x0", nonce: "0x7", maxFeePerGas: "0xa", maxPriorityFeePerGas: "0x1" };
        const anchor = { blockHash, requireCanonical: true };
        expect(test.rpc.calls.find(({ method }) => method === "eth_estimateGas")?.params).toEqual([expected, anchor]);
        expect(test.rpc.calls.find(({ method }) => method === "eth_call")?.params).toEqual([{ ...expected, gas: "0x186a0" }, anchor]);
        expect(test.rpc.calls.filter(({ method }) => method === "eth_getTransactionCount").map(({ params }) => params)).toEqual([[sender, anchor], [sender, "pending"]]);
        await expect(test.port.simulate(context, { ...block }, request)).rejects.toThrow("canonical block authority");
      });
    } finally { await test.lifecycle.close(); }
  });

  it("normalizes the transaction and receipt together and detects a changed canonical block", async () => {
    const test = create();
    try {
      await test.lifecycle.run(new AbortController().signal, async (context) => {
        const included = await test.port.readTransaction(context, hash);
        expect(included.status).toBe("included");
        test.rpc.canonicalHash = differentHash;
        expect((await test.port.readTransaction(context, hash)).status).toBe("reorged");
        test.rpc.transaction = { ...transaction, hash: differentHash };
        await expect(test.port.readTransaction(context, hash)).rejects.toSatisfy((error: unknown) => getChainOperationFailure(error)?.error.code === "source_inconsistent");
      });
    } finally { await test.lifecycle.close(); }
  });

  it("requires observed finality tags and rejects inconsistent tag identities", async () => {
    const test = create();
    try {
      await test.lifecycle.run(new AbortController().signal, async (context) => {
        const block = await resolveConfiguredCanonicalBlock({ rpc: test.rpc, chainId, selector: { kind: "latest" }, context });
        expect((await test.port.finality(context, block.anchor)).status).toBe("finalized");
        test.rpc.finalized = { number: "0x63", hash: differentHash, timestamp: "0x6592007f" };
        expect((await test.port.finality(context, block.anchor)).status).toBe("safe");
        test.rpc.safe = test.rpc.finalized;
        expect((await test.port.finality(context, block.anchor)).status).toBe("included");
        test.rpc.finalized = null;
        await expect(test.port.finality(context, block.anchor)).rejects.toSatisfy((error: unknown) => getChainOperationFailure(error)?.error.code === "chain_response_unavailable");
        test.rpc.finalized = { number: "0x64", hash: differentHash, timestamp: "0x65920080" };
        await expect(test.port.finality(context, block.anchor)).rejects.toSatisfy((error: unknown) => getChainOperationFailure(error)?.error.code === "source_inconsistent");
      });
    } finally { await test.lifecycle.close(); }
  });
});
