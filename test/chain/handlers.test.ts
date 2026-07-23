import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { createErc20CallEncoder, type Erc20CallEncoder } from "../../src/chain/evm-standard.js";
import { ChainRpcError } from "../../src/chain/rpc.js";
import {
  accountBalanceCapability,
  chainStatusCapability,
  contractInspectCapability,
  createAccountBalanceTokenEvidenceIdentity,
  erc20TransferTopic0,
  fixedIdentifierSchema,
  keccak256FromHex,
  parseCapabilitySuccess,
  parseEvmAddress,
  parseEvmChainId,
  parseHash32,
  transactionInspectCapability,
  type EvmAddress,
  type Hash32,
} from "../../src/core/index.js";
import {
  ScriptedRpc,
  connectedWallet,
  configuredChainId,
  createChainHandlerHarness,
  disconnectedWallet,
  rpcFailure,
  rpcValue,
  type ChainHandlerHarness,
  type RpcStep,
} from "./handler-harness.js";

const account = parseEvmAddress(`0x${"11".repeat(20)}`);
const recipient = parseEvmAddress(`0x${"22".repeat(20)}`);
const contract = parseEvmAddress(`0x${"33".repeat(20)}`);
const token = parseEvmAddress(`0x${"44".repeat(20)}`);
const secondToken = parseEvmAddress(`0x${"45".repeat(20)}`);
const transferFrom = parseEvmAddress(`0x${"55".repeat(20)}`);
const transferTo = parseEvmAddress(`0x${"66".repeat(20)}`);
const transactionHash = parseHash32(`0x${"77".repeat(32)}`);
const blockHash = parseHash32(`0x${"88".repeat(32)}`);
const blockReference = Object.freeze({ blockHash, requireCanonical: true as const });

const largeDecimal = "9007199254740993" as const;
const largeQuantity = "0x20000000000001" as const;
const blockTimestamp = "0x65a00000" as const;
const expectedBlockTimestamp = new Date(Number(BigInt(blockTimestamp) * 1_000n)).toISOString();

const block = (
  number: string = largeQuantity,
  hash: Hash32 = blockHash,
) => ({
  number,
  hash,
  timestamp: blockTimestamp,
  transactions: [`0x${"01".repeat(32)}`, `0x${"02".repeat(32)}`, transactionHash],
});

const abiWord = (value: bigint): `0x${string}` => `0x${value.toString(16).padStart(64, "0")}`;

const indexedAddress = (address: EvmAddress): Hash32 =>
  parseHash32(`0x${address.slice(2).padStart(64, "0")}`);

const pendingTransaction = () => ({
  hash: transactionHash,
  from: account,
  to: recipient,
  value: largeQuantity,
  input: "0x1234",
  nonce: largeQuantity,
  gas: largeQuantity,
  type: "0x2",
  chainId: "0x1237",
  accessList: [],
  maxFeePerGas: largeQuantity,
  maxPriorityFeePerGas: "0x1",
  blockNumber: null,
  blockHash: null,
  transactionIndex: null,
});

const includedTransaction = () => ({
  hash: transactionHash,
  from: account,
  to: recipient,
  value: largeQuantity,
  input: "0x",
  nonce: "0x1",
  gas: "0x5208",
  type: "0x0",
  gasPrice: largeQuantity,
  blockNumber: "0x10",
  blockHash,
  transactionIndex: "0x2",
});

const includedReceipt = () => ({
  transactionHash,
  from: account,
  to: recipient,
  type: "0x0",
  transactionIndex: "0x2",
  blockNumber: "0x10",
  blockHash,
  status: "0x1",
  cumulativeGasUsed: largeQuantity,
  gasUsed: "0x5208",
  effectiveGasPrice: largeQuantity,
  contractAddress: null,
  logs: [{
    address: token,
    topics: [erc20TransferTopic0, indexedAddress(transferFrom), indexedAddress(transferTo)],
    data: abiWord(BigInt(largeDecimal)),
    logIndex: "0x1",
    transactionIndex: "0x2",
    transactionHash,
    blockNumber: "0x10",
    blockHash,
    removed: false,
  }],
});

let encoder: Erc20CallEncoder;
const openHarnesses: ChainHandlerHarness[] = [];

beforeAll(async () => {
  encoder = await createErc20CallEncoder();
});

afterEach(async () => {
  const current = openHarnesses.splice(0);
  await Promise.all(current.map((item) => item.close()));
});

const createHarness = (
  steps: readonly RpcStep[],
  wallet = disconnectedWallet(),
): ChainHandlerHarness => {
  const created = createChainHandlerHarness({ rpc: new ScriptedRpc(steps), encoder, wallet });
  openHarnesses.push(created);
  return created;
};

function expectSuccess<Value extends { readonly ok: boolean }>(
  value: Value,
): asserts value is Extract<Value, { ok: true }> {
  if (!value.ok) expect.fail(`Expected capability success, received ${JSON.stringify(value)}.`);
  expect(value.ok).toBe(true);
}

describe("Robinhood Chain read handlers", () => {
  it("generates one valid account token evidence identity for every owned role", () => {
    const identity = createAccountBalanceTokenEvidenceIdentity(token);

    expect(identity.factId).toBe(`token_balance:${token}`);
    expect(identity.balanceClaimRole).toBe(identity.factId);
    expect(identity).toEqual({
      factId: `token_balance:${token}`,
      balanceSlotId: `token:${token}:balance`,
      decimalsSlotId: `token:${token}:decimals`,
      balanceClaimRole: `token_balance:${token}`,
      decimalsClaimRole: `token_decimals:${token}`,
    });
    for (const value of Object.values(identity)) {
      expect(fixedIdentifierSchema.safeParse(value).success).toBe(true);
    }
  });

  it("checks the exact chain ID first and preserves block integers above 2^53", async () => {
    const service = createHarness([
      rpcValue("eth_chainId", "0x1237"),
      rpcValue("eth_getBlockByNumber", block()),
    ]);

    const result = await service.invoke(chainStatusCapability, {});
    expectSuccess(result);
    expect(result.data).toEqual({
      chainId: configuredChainId,
      latestBlock: {
        chainId: configuredChainId,
        blockNumber: largeDecimal,
        blockHash,
        blockTimestamp: expectedBlockTimestamp,
      },
    });
    expect(service.rpc.calls).toEqual([
      { method: "eth_chainId", params: [] },
      { method: "eth_getBlockByNumber", params: ["latest", false] },
    ]);
    expect(service.rpc.remainingSteps).toBe(0);

    for (const incompatible of ["0x1", "0x01237", "0X1237", "4663", 4663, null]) {
      const mismatch = createHarness([rpcValue("eth_chainId", incompatible)]);
      const rejected = await mismatch.invoke(chainStatusCapability, {});
      expect(rejected).toMatchObject({ ok: false, error: { code: "source_inconsistent" } });
      expect(mismatch.rpc.calls).toEqual([{ method: "eth_chainId", params: [] }]);
    }
  });

  it("anchors contract bytecode to the exact canonical block hash and computes exact code identity", async () => {
    const bytecode = "0x6001600055" as const;
    const service = createHarness([
      rpcValue("eth_chainId", "0x1237"),
      rpcValue("eth_getBlockByNumber", block()),
      rpcValue("eth_getCode", bytecode),
    ]);

    const result = await service.invoke(contractInspectCapability, {
      address: contract,
      block: { kind: "number", blockNumber: largeDecimal },
    });
    expectSuccess(result);
    expect(result.data).toEqual({
      address: contract,
      block: {
        chainId: configuredChainId,
        blockNumber: largeDecimal,
        blockHash,
        blockTimestamp: expectedBlockTimestamp,
      },
      runtimeCode: {
        status: "present",
        bytecode,
        byteLength: "5",
        codeHash: keccak256FromHex(bytecode),
      },
    });
    expect(service.rpc.calls).toEqual([
      { method: "eth_chainId", params: [] },
      { method: "eth_getBlockByNumber", params: [largeQuantity, false] },
      { method: "eth_getCode", params: [contract, blockReference] },
    ]);
  });

  it("returns an exact pending transaction without requesting a receipt", async () => {
    const service = createHarness([
      rpcValue("eth_chainId", "0x1237"),
      rpcValue("eth_getTransactionByHash", pendingTransaction()),
    ]);

    const result = await service.invoke(transactionInspectCapability, { transactionHash });
    expectSuccess(result);
    expect(result.data.value.raw).toBe(largeDecimal);
    expect(result.data.nonce).toBe(largeDecimal);
    expect(result.data.gasLimit.raw).toBe(largeDecimal);
    expect(result.data.fee).toMatchObject({
      kind: "dynamic",
      maxFeePerGas: { numerator: { raw: largeDecimal } },
      maxPriorityFeePerGas: { numerator: { raw: "1" } },
    });
    expect(result.data.accessList).toEqual({ kind: "entries", entries: [] });
    expect(result.data.inclusion).toEqual({ status: "pending" });
    expect(() => parseCapabilitySuccess(
      transactionInspectCapability,
      { transactionHash },
      result,
    )).not.toThrow();
    const chainIdSource = result.evidence.sources.find((source) => source.purpose === "chain_id");
    expect(chainIdSource).toBeDefined();
    if (chainIdSource === undefined) return;
    expect(() => parseCapabilitySuccess(
      transactionInspectCapability,
      { transactionHash },
      {
        ...result,
        data: {
          ...result.data,
          value: {
            ...result.data.value,
            quantityObservationId: chainIdSource.observationId,
          },
        },
      },
    )).toThrow();
    expect(service.rpc.calls).toEqual([
      { method: "eth_chainId", params: [] },
      { method: "eth_getTransactionByHash", params: [transactionHash] },
    ]);
  });

  it("returns not_found for a missing transaction without requesting dependent data", async () => {
    const service = createHarness([
      rpcValue("eth_chainId", "0x1237"),
      rpcValue("eth_getTransactionByHash", null),
    ]);

    const result = await service.invoke(transactionInspectCapability, { transactionHash });
    expect(result).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(service.rpc.calls).toEqual([
      { method: "eth_chainId", params: [] },
      { method: "eth_getTransactionByHash", params: [transactionHash] },
    ]);
    expect(service.rpc.remainingSteps).toBe(0);
  });

  it("fails closed on malformed or chain-mismatched transaction evidence without exposing it", async () => {
    const malformed = createHarness([
      rpcValue("eth_chainId", "0x1237"),
      rpcValue("eth_getTransactionByHash", { ...pendingTransaction(), from: "provider-secret" }),
    ]);
    const malformedResult = await malformed.invoke(transactionInspectCapability, { transactionHash });
    expect(malformedResult).toMatchObject({
      ok: false,
      error: { code: "source_inconsistent", message: "Required source evidence is inconsistent." },
    });
    expect(JSON.stringify(malformedResult)).not.toContain("provider-secret");

    const mismatch = createHarness([
      rpcValue("eth_chainId", "0x1237"),
      rpcValue("eth_getTransactionByHash", { ...pendingTransaction(), chainId: "0x1" }),
    ]);
    const mismatchResult = await mismatch.invoke(transactionInspectCapability, { transactionHash });
    expect(mismatchResult).toMatchObject({ ok: false, error: { code: "source_inconsistent" } });
  });

  it("preserves unsupported typed transaction identity while making interpretation unavailable", async () => {
    const service = createHarness([
      rpcValue("eth_chainId", "0x1237"),
      rpcValue("eth_getTransactionByHash", {
        ...pendingTransaction(),
        type: "0x3",
        chainId: "0x1237",
        accessList: [],
      }),
    ]);

    const result = await service.invoke(transactionInspectCapability, { transactionHash });
    expectSuccess(result);
    expect(result.data.type).toBe("3");
    expect(result.data.fee).toEqual({ kind: "unsupported", type: "3" });
    expect(result.warnings.map(({ code }) => code)).toContain("unsupported_transaction_type");
  });

  it("binds an included receipt and canonical ERC-20 event to one exact block", async () => {
    const service = createHarness([
      rpcValue("eth_chainId", "0x1237"),
      rpcValue("eth_getTransactionByHash", includedTransaction()),
      rpcValue("eth_getTransactionReceipt", includedReceipt()),
      rpcValue("eth_getBlockByHash", block("0x10")),
    ]);

    const result = await service.invoke(transactionInspectCapability, { transactionHash });
    expectSuccess(result);
    expect(result.data.inclusion.status).toBe("included");
    if (result.data.inclusion.status !== "included") throw new TypeError("Expected included transaction.");
    expect(result.data.chainId).toBe(configuredChainId);
    expect(result.data.value.asset.chainId).toBe(configuredChainId);
    expect(result.data.inclusion.block.chainId).toBe(configuredChainId);
    expect(result.data.inclusion.receipt.effectiveGasPrice.numerator.asset.chainId)
      .toBe(configuredChainId);
    expect(result.data.inclusion.block).toMatchObject({ blockNumber: "16", blockHash });
    expect(result.data.inclusion.receipt.cumulativeGasUsed.raw).toBe(largeDecimal);
    expect(result.data.inclusion.receipt.effectiveGasPrice.numerator.raw).toBe(largeDecimal);
    expect(result.data.inclusion.receipt.logs).toHaveLength(1);
    expect(result.data.inclusion.receipt.logs[0]?.decodedEvent).toMatchObject({
      kind: "erc20_transfer",
      token,
      from: transferFrom,
      to: transferTo,
      amount: {
        asset: { kind: "erc20", chainId: configuredChainId, address: token },
        raw: largeDecimal,
        decimals: {
          status: "not_observed",
          scopeExclusionId: "transaction_event_decimals_not_observed",
        },
      },
    });
    expect(service.rpc.calls).toEqual([
      { method: "eth_chainId", params: [] },
      { method: "eth_getTransactionByHash", params: [transactionHash] },
      { method: "eth_getTransactionReceipt", params: [transactionHash] },
      { method: "eth_getBlockByHash", params: [blockHash, false] },
    ]);
  });

  it("keeps an explicit-address token failure partial and does not invent a decimals observation", async () => {
    const wallet = disconnectedWallet();
    const service = createHarness([
      rpcValue("eth_chainId", "0x1237"),
      rpcValue("eth_getBlockByNumber", block()),
      rpcFailure("eth_call", "source_unavailable"),
    ], wallet);

    const result = await service.invoke(accountBalanceCapability, {
      account: { kind: "address", address: account },
      includeNative: false,
      tokens: [token],
      block: { kind: "latest" },
    });
    expectSuccess(result);
    expect(wallet.captures()).toBe(0);
    expect(result.data.tokens).toEqual([{
      asset: { kind: "erc20", chainId: configuredChainId, address: token },
      result: { status: "unavailable", errorCode: "source_unavailable" },
    }]);
    expect(result.evidence.coverage.status).toBe("partial");
    expect(result.warnings.map(({ code }) => code)).toContain("partial_result");
    expect(result.evidence.sources.some(({ purpose }) => purpose === "token_decimals")).toBe(false);
    expect(service.rpc.calls).toEqual([
      { method: "eth_chainId", params: [] },
      { method: "eth_getBlockByNumber", params: ["latest", false] },
      {
        method: "eth_call",
        params: [{ to: token, data: encoder.balanceOf(account) }, blockReference],
      },
    ]);
  });

  it("preserves a raw token balance when its decimals call is unavailable", async () => {
    const service = createHarness([
      rpcValue("eth_chainId", "0x1237"),
      rpcValue("eth_getBlockByNumber", block()),
      rpcValue("eth_call", abiWord(BigInt(largeDecimal))),
      rpcFailure("eth_call", "source_unavailable"),
    ]);

    const result = await service.invoke(accountBalanceCapability, {
      account: { kind: "address", address: account },
      includeNative: false,
      tokens: [token],
      block: { kind: "latest" },
    });
    expectSuccess(result);
    const tokenResult = result.data.tokens[0]?.result;
    expect(tokenResult?.status).toBe("available");
    if (tokenResult?.status !== "available") throw new TypeError("Expected available raw token balance.");
    expect(tokenResult.amount.raw).toBe(largeDecimal);
    expect(tokenResult.amount.decimals).toMatchObject({ status: "unavailable", reason: "missing" });
    expect(result.warnings.map(({ code }) => code)).toContain("decimals_unavailable");
    expect(result.evidence.sources.some(({ purpose }) => purpose === "token_decimals")).toBe(true);
    expect(service.rpc.calls).toEqual([
      { method: "eth_chainId", params: [] },
      { method: "eth_getBlockByNumber", params: ["latest", false] },
      {
        method: "eth_call",
        params: [{ to: token, data: encoder.balanceOf(account) }, blockReference],
      },
      {
        method: "eth_call",
        params: [{ to: token, data: encoder.decimals() }, blockReference],
      },
    ]);
  });

  it("preserves a raw token balance when decimals are malformed", async () => {
    const service = createHarness([
      rpcValue("eth_chainId", "0x1237"),
      rpcValue("eth_getBlockByNumber", block()),
      rpcValue("eth_call", abiWord(BigInt(largeDecimal))),
      rpcValue("eth_call", abiWord(256n)),
    ]);

    const result = await service.invoke(accountBalanceCapability, {
      account: { kind: "address", address: account },
      includeNative: false,
      tokens: [token],
      block: { kind: "latest" },
    });
    expectSuccess(result);
    const tokenResult = result.data.tokens[0]?.result;
    expect(tokenResult?.status).toBe("available");
    if (tokenResult?.status !== "available") throw new TypeError("Expected available raw token balance.");
    expect(tokenResult.amount.raw).toBe(largeDecimal);
    expect(tokenResult.amount.decimals).toMatchObject({ status: "unavailable", reason: "missing" });
    expect(result.warnings.map(({ code }) => code)).toContain("decimals_unavailable");
  });

  it("binds an available token balance and observed decimals to the same asset and block", async () => {
    const service = createHarness([
      rpcValue("eth_chainId", "0x1237"),
      rpcValue("eth_getBlockByNumber", block()),
      rpcValue("eth_call", abiWord(BigInt(largeDecimal))),
      rpcValue("eth_call", abiWord(6n)),
    ]);

    const input = {
      account: { kind: "address", address: account },
      includeNative: false as const,
      tokens: [token],
      block: { kind: "latest" as const },
    };
    const result = await service.invoke(accountBalanceCapability, input);
    expectSuccess(result);
    const tokenResult = result.data.tokens[0]?.result;
    expect(tokenResult?.status).toBe("available");
    if (tokenResult?.status !== "available") throw new TypeError("Expected available token balance.");
    expect(tokenResult.amount).toMatchObject({
      asset: { kind: "erc20", chainId: configuredChainId, address: token },
      raw: largeDecimal,
      decimals: { status: "available", value: "6" },
    });
    expect(() => parseCapabilitySuccess(accountBalanceCapability, input, result)).not.toThrow();
    const blockSource = result.evidence.sources.find((source) => source.purpose === "balance_block");
    expect(blockSource).toBeDefined();
    if (blockSource === undefined) return;
    expect(() => parseCapabilitySuccess(accountBalanceCapability, input, {
      ...result,
      data: {
        ...result.data,
        tokens: result.data.tokens.map((entry) => entry.result.status === "available"
          ? {
              ...entry,
              result: {
                ...entry.result,
                amount: {
                  ...entry.result.amount,
                  quantityObservationId: blockSource.observationId,
                },
              },
            }
          : entry),
      },
    })).toThrow();
  });

  it("keeps canonical token order when concurrent reads complete out of order", async () => {
    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const service = createHarness([
      rpcValue("eth_chainId", "0x1237"),
      rpcValue("eth_getBlockByNumber", block()),
      {
        method: "eth_call",
        run: async () => {
          await firstCanFinish;
          return abiWord(1n);
        },
      },
      {
        method: "eth_call",
        run: () => {
          releaseFirst();
          return abiWord(2n);
        },
      },
      rpcValue("eth_call", abiWord(18n)),
      rpcValue("eth_call", abiWord(6n)),
    ]);

    const result = await service.invoke(accountBalanceCapability, {
      account: { kind: "address", address: account },
      includeNative: false,
      tokens: [secondToken, token],
      block: { kind: "latest" },
    });
    expectSuccess(result);
    expect(result.data.tokens.map(({ asset }) => asset.address)).toEqual([token, secondToken]);
    expect(result.data.tokens.map(({ result: tokenResult }) =>
      tokenResult.status === "available" ? tokenResult.amount.raw : tokenResult.status
    )).toEqual(["1", "2"]);
    const stateReferences = service.rpc.calls
      .filter(({ method }) => method === "eth_call")
      .map(({ params }) => (params as readonly unknown[])[1]);
    expect(stateReferences[0]).toEqual(blockReference);
    expect(stateReferences.every((reference) => reference === stateReferences[0])).toBe(true);
  });

  it("captures an active wallet exactly once and rejects a disconnected wallet before RPC", async () => {
    const wallet = connectedWallet(account);
    const service = createHarness([
      rpcValue("eth_chainId", "0x1237"),
      rpcValue("eth_getBlockByNumber", block()),
      rpcValue("eth_getBalance", largeQuantity),
    ], wallet);

    const result = await service.invoke(accountBalanceCapability, {
      account: { kind: "active_wallet" },
      includeNative: true,
      tokens: [],
      block: { kind: "latest" },
    });
    expectSuccess(result);
    expect(wallet.captures()).toBe(1);
    expect(result.data.account).toBe(account);
    expect(result.data.native).toMatchObject({ status: "available", amount: { raw: largeDecimal } });
    expect(service.rpc.calls).toEqual([
      { method: "eth_chainId", params: [] },
      { method: "eth_getBlockByNumber", params: ["latest", false] },
      { method: "eth_getBalance", params: [account, blockReference] },
    ]);
    expect(result.evidence.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceClass: "wallet_session",
        reference: expect.objectContaining({
          kind: "wallet_session",
          sourceId: `wallet-session:${"A".repeat(43)}`,
        }),
      }),
    ]));

    const disconnected = disconnectedWallet();
    const rejectedService = createHarness([], disconnected);
    const rejected = await rejectedService.invoke(accountBalanceCapability, {
      account: { kind: "active_wallet" },
      includeNative: true,
      tokens: [],
      block: { kind: "latest" },
    });
    expect(rejected).toMatchObject({ ok: false, error: { code: "wallet_not_connected" } });
    expect(disconnected.captures()).toBe(1);
    expect(rejectedService.rpc.calls).toEqual([]);

    const otherChain = connectedWallet(account, parseEvmChainId("eip155:1"));
    const mismatchedService = createHarness([], otherChain);
    const mismatched = await mismatchedService.invoke(accountBalanceCapability, {
      account: { kind: "active_wallet" },
      includeNative: true,
      tokens: [],
      block: { kind: "latest" },
    });
    expect(mismatched).toMatchObject({ ok: false, error: { code: "internal_error" } });
    expect(otherChain.captures()).toBe(1);
    expect(mismatchedService.rpc.calls).toEqual([]);
  });

  it("returns request_aborted and does not continue after caller cancellation", async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const waitingStep: RpcStep = Object.freeze({
      method: "eth_chainId",
      run: (_params: readonly unknown[], signal: AbortSignal) => {
        markStarted();
        return new Promise<never>((_resolve, reject) => {
          const abort = (): void => reject(new ChainRpcError("request_aborted"));
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
      },
    });
    const service = createHarness([waitingStep]);
    const controller = new AbortController();

    const pending = service.invoke(chainStatusCapability, {}, controller.signal);
    await started;
    controller.abort();
    const result = await pending;

    expect(result).toMatchObject({ ok: false, error: { code: "request_aborted" } });
    expect(service.rpc.calls).toEqual([{ method: "eth_chainId", params: [] }]);
    expect(service.rpc.remainingSteps).toBe(0);
  });
});
