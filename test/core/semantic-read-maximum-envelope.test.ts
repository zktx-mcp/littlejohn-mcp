import { Buffer } from "node:buffer";

import { beforeAll, describe, expect, it } from "vitest";

import { createErc20CallEncoder, type Erc20CallEncoder } from "../../src/chain/evm-standard.js";
import type { ChainRpcMethod, ChainRpcRequestMap } from "../../src/chain/rpc.js";
import {
  accountBalanceCapability,
  canonicalJsonStringify,
  chainAnchorSchema,
  chainStatusCapability,
  contractInspectCapability,
  getCapabilityDefinitionSnapshot,
  maximumEvmBalanceRaw,
  maximumSuccessUtf8Bytes,
  parseEvmAddress,
  parseCapabilitySuccess,
  parseHash32,
  parseUnsignedDecimal,
  readCapabilityLimits,
  tokenStandardObservationResultSchema,
  transactionInspectCapability,
  walletConnectionDataSchema,
  walletConnectionCapability,
  type AnyReadCapabilityDefinition,
  type ApplicationFailure,
  type CapabilityData,
  type CapabilitySuccess,
  type CanonicalJson,
  type WalletConnectionData,
} from "../../src/core/index.js";
import { publicReadResponseLimitBytes } from "../../src/runtime/http-boundary.js";
import { tokenInspectCapability } from "../../src/token-catalog/contracts.js";
import {
  tokenAddress,
  chainId as tokenChainId,
  createInspectionSuccess,
} from "../token-catalog/harness.js";
import {
  ScriptedRpc,
  configuredChainId,
  createChainHandlerHarness,
  rpcValue,
} from "../chain/handler-harness.js";
import {
  bindForHarness,
  createCapabilityHarness,
  invokeBinding,
} from "./capability-harness.js";

const maximumUint256 = (2n ** 256n - 1n).toString();
const maximumQuantity = `0x${"f".repeat(64)}`;
const maximumWord = `0x${BigInt(maximumUint256).toString(16).padStart(64, "0")}`;
const maximumDecimalsWord = `0x${(255n).toString(16).padStart(64, "0")}`;
const account = parseEvmAddress(`0x${"11".repeat(20)}`);
const recipient = parseEvmAddress(`0x${"22".repeat(20)}`);
const transactionHash = parseHash32(`0x${"33".repeat(32)}`);
const blockHash = parseHash32(`0x${"44".repeat(32)}`);
const otherHash = parseHash32(`0x${"55".repeat(32)}`);
const blockTimestamp = "0x65a00000";

let encoder: Erc20CallEncoder;

beforeAll(async () => {
  encoder = await createErc20CallEncoder();
});

const canonicalUtf8Bytes = (value: unknown): number =>
  Buffer.byteLength(canonicalJsonStringify(value as CanonicalJson), "utf8");

const providerBlock = (transactions: readonly string[] = []) => Object.freeze({
  number: maximumQuantity,
  hash: blockHash,
  timestamp: blockTimestamp,
  transactions,
});

const invokeChain = async <Definition extends AnyReadCapabilityDefinition>(
  definition: Definition,
  input: unknown,
  steps: ConstructorParameters<typeof ScriptedRpc>[0],
): Promise<CapabilitySuccess<CapabilityData<Definition>> | ApplicationFailure> => {
  const harness = createChainHandlerHarness({ rpc: new ScriptedRpc(steps), encoder });
  try {
    return await harness.invoke(definition, input);
  } finally {
    await harness.close();
  }
};

const maximumTokenAddresses = Object.freeze(Array.from(
  { length: readCapabilityLimits.accountTokenAddresses },
  (_, index) => parseEvmAddress(`0x${(index + 1).toString(16).padStart(40, "0")}`),
));

class MaximumAccountRpc {
  readonly calls: Array<Readonly<{ method: ChainRpcMethod; params: readonly unknown[] }>> = [];

  async request<Method extends ChainRpcMethod>(
    method: Method,
    params: ChainRpcRequestMap[Method],
    _signal: AbortSignal,
  ): Promise<unknown> {
    this.calls.push(Object.freeze({ method, params: [...params] }));
    if (method === "eth_chainId") return "0x1237";
    if (method === "eth_getBlockByNumber") return providerBlock();
    if (method === "eth_getBalance") return maximumQuantity;
    if (method === "eth_call") {
      const call = params[0] as { readonly to?: unknown; readonly data?: unknown } | undefined;
      if (typeof call?.to !== "string" || !maximumTokenAddresses.some((address) => address === call.to)) {
        throw new TypeError("The maximum account verifier received an unknown token call.");
      }
      if (typeof call.data !== "string") throw new TypeError("The maximum account verifier received no calldata.");
      if (call.data.length === encoder.decimals().length) return maximumDecimalsWord;
      if (call.data.length === encoder.balanceOf(account).length) return maximumWord;
      throw new TypeError("The maximum account verifier received an unknown token method.");
    }
    throw new TypeError(`Unexpected maximum account RPC method: ${method}.`);
  }
}

const maximumAccountSuccess = async () => {
  const rpc = new MaximumAccountRpc();
  const harness = createChainHandlerHarness({ rpc: rpc as unknown as ScriptedRpc, encoder });
  try {
    const result = await harness.invoke(accountBalanceCapability, {
      account: { kind: "address", address: account },
      includeNative: true,
      tokens: maximumTokenAddresses,
      block: { kind: "latest" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new TypeError("The maximum account result did not succeed.");
    expect(result.data.native).toMatchObject({ status: "available", amount: { raw: maximumEvmBalanceRaw } });
    expect(result.data.tokens).toHaveLength(readCapabilityLimits.accountTokenAddresses);
    expect(rpc.calls.filter(({ method }) => method === "eth_call")).toHaveLength(
      readCapabilityLimits.accountTokenAddresses * 2,
    );
    return result;
  } finally {
    await harness.close();
  }
};

const walletConnectionResult = async (data: WalletConnectionData) => {
  const binding = bindForHarness(
    walletConnectionCapability,
    createCapabilityHarness(),
    async (_input, context, observations) => {
      observations.record("wallet_sdk", {
        source: context.ports.observations.get("wallet_sdk"),
        claims: [{ role: "wallet_sdk_state", value: data }],
      });
      if (data.status === "connected") {
        observations.record("wallet_session", {
          source: context.ports.observations.get("wallet_session"),
          claims: [{ role: "wallet_session_state", value: data }],
        });
      }
      return { status: "success", data };
    },
  );
  return invokeBinding(walletConnectionCapability, binding, {});
};

const unresolvedWallet = async (sessionCount: string) => walletConnectionResult({
  status: "unresolved",
  sessionCount: parseUnsignedDecimal(sessionCount),
});

const maximumConnectedWallet = async () => {
  const maximumIdentifiers = (prefix: string) => Array.from({ length: 64 }, (_, index) =>
    `${prefix}${index.toString().padStart(2, "0")}${"x".repeat(61)}`);
  const result = await walletConnectionResult(walletConnectionDataSchema.parse({
    status: "connected",
    address: account,
    chainId: configuredChainId,
    approvedMethods: maximumIdentifiers("m"),
    approvedEvents: maximumIdentifiers("e"),
    expiresAt: "9999-12-31T23:59:59.999Z",
  }));
  expect(result.ok, canonicalJsonStringify(result as unknown as CanonicalJson)).toBe(true);
  if (!result.ok) throw new TypeError("The maximum connected wallet did not succeed.");
  expect(result.data).toMatchObject({
    status: "connected",
    approvedMethods: { length: 64 },
    approvedEvents: { length: 64 },
  });
  return result;
};

const exactWalletBoundary = async () => {
  const sessionCount = "9".repeat(8_387_589);
  const exact = await unresolvedWallet(sessionCount);
  expect(exact.ok).toBe(true);
  if (!exact.ok) throw new TypeError("The exact wallet boundary did not succeed.");
  expect(canonicalUtf8Bytes(exact)).toBe(8_388_607);
  expect(parseCapabilitySuccess(walletConnectionCapability, {}, exact)).toEqual(exact);

  const oversizedTransportSuccess = {
    ...exact,
    data: { status: "unresolved" as const, sessionCount: `${sessionCount}9` },
  };
  expect(canonicalUtf8Bytes(oversizedTransportSuccess)).toBe(8_388_608);
  expect(() => parseCapabilitySuccess(walletConnectionCapability, {}, oversizedTransportSuccess)).toThrow(
    "exceeds the supported size",
  );
  const oversizedBinding = await unresolvedWallet(`${sessionCount}9`);
  expect(oversizedBinding).toMatchObject({ ok: false, error: { code: "result_too_large" } });
  return exact;
};

const maximumPendingTransaction = () => Object.freeze({
  hash: transactionHash,
  from: account,
  to: recipient,
  value: maximumQuantity,
  input: `0x${"ab".repeat(readCapabilityLimits.transactionCalldataBytes)}`,
  nonce: maximumQuantity,
  gas: maximumQuantity,
  type: "0x2",
  chainId: "0x1237",
  accessList: Array.from({ length: readCapabilityLimits.transactionAccessListEntries }, () => ({
    address: recipient,
    storageKeys: [blockHash, otherHash, transactionHash, `0x${"66".repeat(32)}`],
  })),
  maxFeePerGas: maximumQuantity,
  maxPriorityFeePerGas: maximumQuantity,
  blockNumber: null,
  blockHash: null,
  transactionIndex: null,
});

const maximumIncludedTransaction = () => Object.freeze({
  hash: transactionHash,
  from: account,
  to: recipient,
  value: maximumQuantity,
  input: `0x${"ab".repeat(readCapabilityLimits.transactionCalldataBytes)}`,
  nonce: maximumQuantity,
  gas: maximumQuantity,
  type: "0x0",
  gasPrice: maximumQuantity,
  blockNumber: "0x1",
  blockHash,
  transactionIndex: "0x0",
});

const maximumIncludedReceipt = (logDataBytes: number) => Object.freeze({
  transactionHash,
  from: account,
  to: recipient,
  type: "0x0",
  transactionIndex: "0x0",
  blockNumber: "0x1",
  blockHash,
  status: "0x1",
  cumulativeGasUsed: maximumQuantity,
  gasUsed: maximumQuantity,
  effectiveGasPrice: maximumQuantity,
  contractAddress: null,
  logs: [{
    address: tokenAddress,
    topics: [otherHash, blockHash],
    data: `0x${"cd".repeat(logDataBytes)}`,
    logIndex: "0x0",
    transactionIndex: "0x0",
    transactionHash,
    blockNumber: "0x1",
    blockHash,
    removed: false,
  }],
});

export const verifySemanticReadMaximumEnvelopes = async (): Promise<void> => {
  const chain = await invokeChain(chainStatusCapability, {}, [
    rpcValue("eth_chainId", "0x1237"),
    rpcValue("eth_getBlockByNumber", providerBlock()),
  ]);
  expect(chain.ok).toBe(true);

  const runtimeCode = `0x${"ff".repeat(readCapabilityLimits.runtimeCodeBytes)}`;
  const contract = await invokeChain(contractInspectCapability, {
    address: account,
    block: { kind: "latest" },
  }, [
    rpcValue("eth_chainId", "0x1237"),
    rpcValue("eth_getBlockByNumber", providerBlock()),
    rpcValue("eth_getCode", runtimeCode),
  ]);
  expect(contract.ok).toBe(true);
  if (contract.ok) expect(contract.data.runtimeCode).toMatchObject({ byteLength: String(readCapabilityLimits.runtimeCodeBytes) });

  const accountResult = await maximumAccountSuccess();
  const wallet = await exactWalletBoundary();
  const connectedWallet = await maximumConnectedWallet();

  const block = chainAnchorSchema.parse({
    chainId: tokenChainId,
    blockNumber: "42",
    blockHash: `0x${"ab".repeat(32)}`,
    blockTimestamp: "2026-07-18T00:00:00.000Z",
  });
  const token = await createInspectionSuccess(undefined, {
    decimals: "255",
    name: "😀".repeat(128),
    runtimeByteLength: String(readCapabilityLimits.runtimeCodeBytes),
    symbol: "😀".repeat(128),
    totalSupply: maximumUint256,
    standards: tokenStandardObservationResultSchema.parse({
      asset: { kind: "erc20", chainId: tokenChainId, address: tokenAddress },
      block,
      standards: [
        { standardId: "erc20_read_surface", status: "observed" },
        { standardId: "erc165", status: "supported" },
        { standardId: "erc8056", status: "supported" },
        { standardId: "erc8056_pending_multiplier", status: "supported" },
        { standardId: "erc8056_conversion", status: "supported" },
        { standardId: "erc8056_balances", status: "supported" },
      ],
      requiredErc8056: {
        currentMultiplier: maximumUint256,
        pendingMultiplier: maximumUint256,
        pendingEffectiveAt: maximumUint256,
      },
    }),
  });
  expect(token.ok).toBe(true);
  expect(token.data.metadata.name).toMatchObject({ status: "available", value: "😀".repeat(128) });

  const pendingProvider = maximumPendingTransaction();
  const pending = await invokeChain(transactionInspectCapability, { transactionHash }, [
    rpcValue("eth_chainId", "0x1237"),
    rpcValue("eth_getTransactionByHash", pendingProvider),
  ]);
  expect(pending.ok).toBe(true);
  if (!pending.ok) throw new TypeError("The maximum pending transaction did not succeed.");
  expect(pending.data.accessList).toMatchObject({ kind: "entries" });

  for (const success of [chain, contract, accountResult, wallet, connectedWallet, token, pending]) {
    if (!success.ok) throw new TypeError("A maximum semantic read did not succeed.");
    expect(canonicalUtf8Bytes(success)).toBeLessThanOrEqual(8_388_607);
  }

  const includedProvider = maximumIncludedTransaction();
  const calibrationLogBytes = readCapabilityLimits.transactionCalldataBytes - 4_096;
  const calibrationReceipt = maximumIncludedReceipt(calibrationLogBytes);
  const calibration = await invokeChain(transactionInspectCapability, { transactionHash }, [
    rpcValue("eth_chainId", "0x1237"),
    rpcValue("eth_getTransactionByHash", includedProvider),
    rpcValue("eth_getTransactionReceipt", calibrationReceipt),
    rpcValue("eth_getBlockByHash", { ...providerBlock([transactionHash]), number: "0x1" }),
  ]);
  expect(calibration.ok).toBe(true);
  if (!calibration.ok) throw new TypeError("The transaction counterexample calibration did not succeed.");
  const fixedCounterexampleBytes = canonicalUtf8Bytes(calibration) - calibrationLogBytes * 2;
  const targetLogBytes = 2_094_754;
  expect(targetLogBytes).toBeLessThanOrEqual(readCapabilityLimits.transactionCalldataBytes);
  expect(fixedCounterexampleBytes + targetLogBytes * 2 + 1).toBe(8_390_974);

  const receiptProvider = maximumIncludedReceipt(targetLogBytes);
  expect(Buffer.byteLength(JSON.stringify(includedProvider), "utf8")).toBeLessThan(publicReadResponseLimitBytes);
  expect(Buffer.byteLength(JSON.stringify(receiptProvider), "utf8")).toBeLessThan(publicReadResponseLimitBytes);
  const included = await invokeChain(transactionInspectCapability, { transactionHash }, [
    rpcValue("eth_chainId", "0x1237"),
    rpcValue("eth_getTransactionByHash", includedProvider),
    rpcValue("eth_getTransactionReceipt", receiptProvider),
    rpcValue("eth_getBlockByHash", { ...providerBlock([transactionHash]), number: "0x1" }),
  ]);
  expect(included).toMatchObject({ ok: false, error: { code: "result_too_large" } });
};

describe("semantic read maximum envelope", () => {
  it("validates all six maximum result shapes and the one-byte aggregate boundary", async () => {
    await verifySemanticReadMaximumEnvelopes();
  }, 30_000);

  it("declares the aggregate failure on every semantic definition exactly once", () => {
    for (const definition of [
      accountBalanceCapability,
      chainStatusCapability,
      contractInspectCapability,
      tokenInspectCapability,
      transactionInspectCapability,
      walletConnectionCapability,
    ]) {
      const failureCodes = getCapabilityDefinitionSnapshot(definition).failureCodes;
      expect(failureCodes.filter((code) => code === "result_too_large")).toHaveLength(1);
      expect(getCapabilityDefinitionSnapshot(definition).maximumSuccessUtf8Bytes).toBe(8_388_607);
    }
  });
});
