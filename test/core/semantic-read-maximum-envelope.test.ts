import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { createErc20CallEncoder, type Erc20CallEncoder } from "../../src/chain/evm-standard.js";
import type { ChainRpcMethod, ChainRpcRequestMap } from "../../src/chain/rpc.js";
import {
  accountBalanceCapability,
  canonicalJsonStringify,
  captureCanonicalJson,
  chainAnchorSchema,
  chainStatusCapability,
  contractAnalysisSchema,
  contractDeclaredFunctionCountLimit,
  contractInspectCapability,
  getCapabilityDefinitionSnapshot,
  maximumEvmBalanceRaw,
  maximumSuccessUtf8Bytes,
  parseEvmAddress,
  parseHash32,
  parseUtcTimestamp,
  readCapabilityLimits,
  tokenStandardObservationResultSchema,
  transactionInspectCapability,
  walletConnectionDataSchema,
  walletConnectionCapability,
  walletConnectionEvidence,
  type AnyReadCapabilityDefinition,
  type ApplicationFailure,
  type CapabilityData,
  type CapabilitySuccess,
  type CanonicalJson,
  type EvmAddress,
  type WalletConnectionData,
} from "../../src/core/index.js";
import {
  createStockTokenTradeHistoryResult,
  findStockTokenTradeHistoryAsset,
  resolveStockTokenTradeHistoryOfficialAsset,
  stockTokenTradeHistoryApplicationContract,
  stockTokenTradeHistoryChartWindowDefinitions,
  stockTokenTradeHistoryDataSchema,
  stockTokenTradeHistoryInterval,
  stockTokenTradeHistoryRegistry,
} from "../../src/stock-token-trade-history/index.js";
import {
  admitPresentationSnapshotResource,
  presentationSnapshotChunkSchema,
  presentationSnapshotMetadataKey,
} from "../../src/interfaces/mcp-app/contracts.js";
import {
  McpAppPresentationService,
  createMcpAppResource,
} from "../../src/interfaces/mcp-app/server.js";
import {
  admitMcpToolResultForDelivery,
  maximumMcpToolResultUtf8Bytes,
} from "../../src/interfaces/mcp-result.js";
import { ProductDatabase } from "../../src/runtime/database.js";
import { publicReadResponseLimitBytes } from "../../src/runtime/http-boundary.js";
import {
  presentationSnapshotLimits,
  type PresentationSnapshotStore,
} from "../../src/runtime/presentation-snapshot.js";
import {
  assertCommittedOfficialAssetSnapshot,
  defaultStockTokenManifest,
  officialAssetSnapshotRevisionSchema,
  officialAssetSourceDefinition,
  stockFactoryAdmissionManifest,
  stockFactoryVerificationSchema,
} from "../../src/registry/index.js";
import {
  officialAssetCandidateListDigest,
  officialAssetMemberSetDigest,
} from "../../src/registry/official-asset-contract.js";
import { tokenInspectCapability } from "../../src/token-catalog/contracts.js";
import { createSourcifyContractSourceVerification } from "../../src/intelligence/sourcify.js";
import {
  tokenAddress,
  chainId as tokenChainId,
  createInspectionSuccess,
} from "../token-catalog/harness.js";
import {
  ScriptedRpc,
  configuredChainId,
  createChainHandlerHarness,
  handlerClock,
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
const sourcifyMaximumFixtureBytes = 1_048_576;

let encoder: Erc20CallEncoder;

beforeAll(async () => {
  encoder = await createErc20CallEncoder();
});

const independentCanonicalJson = (value: unknown): string => {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(independentCanonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, entry]) =>
      `${JSON.stringify(key)}:${independentCanonicalJson(entry)}`).join(",")}}`;
  }
  throw new TypeError("Unsupported test canonical JSON value.");
};

const canonicalUtf8Bytes = (value: unknown): number =>
  Buffer.byteLength(independentCanonicalJson(value), "utf8");

const providerBlock = (transactions: readonly string[] = []) => Object.freeze({
  number: maximumQuantity,
  hash: blockHash,
  timestamp: blockTimestamp,
  transactions,
});

const maximumSourcifyResponse = (
  address: string,
  runtimeCode: string,
): Readonly<{ readonly body: string; readonly nextBodyBytes: number }> => {
  const emptyBody = JSON.stringify({
    chainId: "4663",
    address,
    runtimeMatch: "exact_match",
    runtimeBytecode: { onchainBytecode: runtimeCode },
    abi: [],
  });
  if (!emptyBody.endsWith("[]}")) {
    throw new TypeError("The source-response fixture shape is invalid.");
  }
  const prefix = emptyBody.slice(0, -3);
  const entryTexts: string[] = [];
  let bodyBytes = Buffer.byteLength(emptyBody, "utf8");
  let nextBodyBytes = 0;
  for (let index = 0; index < contractDeclaredFunctionCountLimit; index += 1) {
    const entryText = JSON.stringify({
      type: "function",
      name: `f${index.toString().padStart(4, "0")}${"x".repeat(48)}`,
      inputs: [],
      outputs: [],
      stateMutability: "view",
    });
    const candidateBytes = bodyBytes + Buffer.byteLength(entryText, "utf8") +
      (entryTexts.length === 0 ? 0 : 1);
    if (candidateBytes > sourcifyMaximumFixtureBytes) {
      nextBodyBytes = candidateBytes;
      break;
    }
    entryTexts.push(entryText);
    bodyBytes = candidateBytes;
  }
  const body = `${prefix}[${entryTexts.join(",")}]}`;
  if (nextBodyBytes === 0) {
    throw new TypeError("The source-response fixture did not reach its byte boundary.");
  }
  return Object.freeze({ body, nextBodyBytes });
};

const invokeChain = async <Definition extends AnyReadCapabilityDefinition>(
  definition: Definition,
  input: unknown,
  steps: ConstructorParameters<typeof ScriptedRpc>[0],
  contractSourceVerification?: Parameters<typeof createChainHandlerHarness>[0][
    "contractSourceVerification"
  ],
): Promise<CapabilitySuccess<CapabilityData<Definition>> | ApplicationFailure> => {
  const rpc = new ScriptedRpc(steps);
  const harness = createChainHandlerHarness({
    rpc,
    encoder,
    ...(contractSourceVerification === undefined ? {} : { contractSourceVerification }),
  });
  try {
    const result = await harness.invoke(definition, input);
    if (!result.ok && result.error.code === "internal_error") {
      throw new Error(`Unexpected handler failure after: ${rpc.calls.map((call) => call.method).join(", ")}.`);
    }
    return result;
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
      const sdk = observations.bind(walletConnectionEvidence.targets.sdk);
      observations.record(sdk.slot, {
        source: context.ports.observations.get("wallet_sdk"),
        claims: [{ role: sdk.roles.state, value: data }],
      });
      if (data.status === "connected") {
        const session = observations.bind(walletConnectionEvidence.targets.session);
        observations.record(session.slot, {
          source: context.ports.observations.get("wallet_session"),
          claims: [{ role: session.roles.state, value: data }],
        });
      }
      return { status: "success", data };
    },
  );
  return invokeBinding(walletConnectionCapability, binding, {});
};

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
  const sourceResponse = maximumSourcifyResponse(account, runtimeCode);
  expect(Buffer.byteLength(sourceResponse.body, "utf8"))
    .toBeLessThanOrEqual(sourcifyMaximumFixtureBytes);
  expect(sourceResponse.nextBodyBytes).toBeGreaterThan(sourcifyMaximumFixtureBytes);
  const sourceVerification = createSourcifyContractSourceVerification({
    clock: handlerClock,
    fetch: async () => new Response(sourceResponse.body, {
      headers: { "content-type": "application/json" },
    }),
  });
  const contractInput = {
    address: account,
    block: { kind: "latest" },
  } as const;
  const contract = await invokeChain(contractInspectCapability, contractInput, [
    rpcValue("eth_chainId", "0x1237"),
    rpcValue("eth_getBlockByNumber", providerBlock()),
    rpcValue("eth_getCode", runtimeCode),
    rpcValue("eth_getStorageAt", `0x${"0".repeat(64)}`),
    rpcValue("eth_getStorageAt", `0x${"0".repeat(64)}`),
    rpcValue("eth_getStorageAt", `0x${"0".repeat(64)}`),
  ], sourceVerification);
  if (!contract.ok) throw new Error(`Maximum contract inspection failed: ${contract.error.code}`);
  expect(contract).toMatchObject({ ok: true });
  if (contract.ok) {
    expect(contract.data.analysis.targetRuntimeCode)
      .toMatchObject({ byteLength: String(readCapabilityLimits.runtimeCodeBytes) });
    expect(contract.data.runtimeCode).toBe(runtimeCode);
  }
  const canonicalContract = captureCanonicalJson(contract);
  const maximumContractMcpResult: CallToolResult = {
    structuredContent: canonicalContract as Record<string, unknown>,
    content: [{ type: "text", text: canonicalJsonStringify(canonicalContract) }],
  };
  expect(canonicalUtf8Bytes(maximumContractMcpResult)).toBeGreaterThan(
    maximumMcpToolResultUtf8Bytes,
  );
  const contractDelivery = admitMcpToolResultForDelivery(maximumContractMcpResult);
  expect(contractDelivery).toMatchObject({
    status: "too_large",
    result: {
      isError: true,
      content: [{ type: "text" }],
    },
  });
  expect(contractDelivery.result.structuredContent).toBeUndefined();
  expect(contractDelivery.result._meta).toBeUndefined();
  expect(canonicalUtf8Bytes(contractDelivery.result)).toBeLessThanOrEqual(
    maximumMcpToolResultUtf8Bytes,
  );

  const metadataBoundaryRuntimeCode = `0x${"ff".repeat(259_100)}`;
  const metadataBoundaryContract = await invokeChain(contractInspectCapability, contractInput, [
    rpcValue("eth_chainId", "0x1237"),
    rpcValue("eth_getBlockByNumber", providerBlock()),
    rpcValue("eth_getCode", metadataBoundaryRuntimeCode),
    rpcValue("eth_getStorageAt", `0x${"0".repeat(64)}`),
    rpcValue("eth_getStorageAt", `0x${"0".repeat(64)}`),
    rpcValue("eth_getStorageAt", `0x${"0".repeat(64)}`),
  ]);
  expect(metadataBoundaryContract.ok).toBe(true);
  if (!metadataBoundaryContract.ok) {
    throw new TypeError("The metadata-boundary contract inspection did not succeed.");
  }
  const metadataBoundaryCanonical = captureCanonicalJson(metadataBoundaryContract);
  const metadataBoundaryMcpResult: CallToolResult = {
    structuredContent: metadataBoundaryCanonical as Record<string, unknown>,
    content: [{
      type: "text",
      text: canonicalJsonStringify(metadataBoundaryCanonical),
    }],
  };
  expect(canonicalUtf8Bytes(metadataBoundaryMcpResult)).toBe(1_048_302);
  expect(admitMcpToolResultForDelivery(metadataBoundaryMcpResult).status).toBe("admitted");

  const directory = await mkdtemp(resolve(tmpdir(), "littlejohn-maximum-contract-presentation-"));
  let contractDatabase: ProductDatabase | undefined;
  try {
    contractDatabase = await ProductDatabase.open(
      resolve(directory, "runtime.sqlite3"),
      parseUtcTimestamp("2026-08-22T00:00:00.000Z"),
    );
    const store = contractDatabase.presentationSnapshotStore();
    let prepares = 0;
    let commits = 0;
    const countedStore: PresentationSnapshotStore = Object.freeze({
      prepare: (input: Parameters<PresentationSnapshotStore["prepare"]>[0]) => {
        prepares += 1;
        return store.prepare(input);
      },
      commit: (input: Parameters<PresentationSnapshotStore["commit"]>[0]) => {
        commits += 1;
        return store.commit(input);
      },
      read: (snapshotId: Parameters<PresentationSnapshotStore["read"]>[0]) =>
        store.read(snapshotId),
      readResultChunk: (
        input: Parameters<PresentationSnapshotStore["readResultChunk"]>[0],
      ) => store.readResultChunk(input),
    });
    const service = new McpAppPresentationService(
      countedStore,
      createMcpAppResource("<!doctype html><main>Little John</main>"),
    );
    const handoff = service.present(
      contractInspectCapability,
      contractInput,
      metadataBoundaryMcpResult,
    );
    expect(handoff).toEqual({ status: "delivery_error", delivery: contractDelivery });
    expect(prepares).toBe(1);
    expect(commits).toBe(0);
  } finally {
    contractDatabase?.close();
    await rm(directory, { recursive: true, force: true });
  }

  const accountResult = await maximumAccountSuccess();
  const connectedWallet = await maximumConnectedWallet();

  const block = chainAnchorSchema.parse({
    chainId: tokenChainId,
    blockNumber: "42",
    blockHash: `0x${"ab".repeat(32)}`,
    blockTimestamp: "2026-07-18T00:00:00.000Z",
  });
  if (contract.data.analysis.declaredFunctions.status !== "observed") {
    throw new TypeError("Maximum contract source did not expose its admitted functions.");
  }
  const tokenAnalysis = contractAnalysisSchema.parse({
    ...contract.data.analysis,
    chainId: tokenChainId,
    target: tokenAddress,
    block,
    sources: [{
      role: "target",
      address: tokenAddress,
      status: "exact_match",
    }],
  });
  const token = await createInspectionSuccess(undefined, {
    analysis: tokenAnalysis,
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

  for (const success of [chain, contract, accountResult, connectedWallet, token, pending]) {
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
  expect(fixedCounterexampleBytes + targetLogBytes * 2 + 1)
    .toBeGreaterThan(maximumSuccessUtf8Bytes);

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

const maximumStockTokenTradeHistoryData = (
  token: EvmAddress,
  interval: Readonly<{ requestedStart: string; requestedEnd: string }>,
) => {
  const asset = findStockTokenTradeHistoryAsset(token);
  if (asset === undefined) throw new TypeError("The maximum trade-history fixture must be registered.");
  const requestedStart = Date.parse(interval.requestedStart);
  const requestedEnd = Date.parse(interval.requestedEnd);
  const dayMilliseconds = 86_400_000;
  const intervals: Array<{
    fromBlock: string;
    fromTimestamp: string;
    untilBlock: string;
    untilTimestamp: string;
  }> = [];
  let cursor = requestedStart;
  let nextBlock = 10n ** 77n;
  while (cursor < requestedEnd) {
    const dayEnd = Math.min(
      requestedEnd,
      Math.floor(cursor / dayMilliseconds) * dayMilliseconds + dayMilliseconds,
    );
    const untilBlock = nextBlock + 100_000n;
    intervals.push({
      fromBlock: nextBlock.toString(),
      fromTimestamp: new Date(cursor).toISOString(),
      untilBlock: untilBlock.toString(),
      untilTimestamp: new Date(dayEnd).toISOString(),
    });
    cursor = dayEnd;
    nextBlock = untilBlock;
  }

  const maximumNumerator = "9".repeat(96);
  const maximumDenominator = `1${"0".repeat(95)}`;
  const maximumVolume = "9".repeat(78);

  const chartDefinition = stockTokenTradeHistoryChartWindowDefinitions["30d"];
  const firstPositionStart = Math.floor(requestedStart / chartDefinition.intervalMilliseconds) *
    chartDefinition.intervalMilliseconds;
  const sourcePosition = (timestamp: number, last: boolean) => {
    const coverage = intervals.find((candidate) =>
      timestamp >= Date.parse(candidate.fromTimestamp) &&
      timestamp < Date.parse(candidate.untilTimestamp));
    if (coverage === undefined) throw new TypeError("Maximum chart source lacks coverage.");
    const blockNumber = (BigInt(coverage.fromBlock) +
      BigInt((timestamp - Date.parse(coverage.fromTimestamp)) / 60_000)).toString();
    const blockHex = BigInt(blockNumber).toString(16).padStart(64, "0");
    const transactionIndex = last ? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER - 1;
    return {
      blockNumber,
      blockHash: `0x${blockHex}`,
      transactionIndex,
      transactionHash:
        `0x${transactionIndex.toString(16).padStart(16, "0")}${blockHex.slice(-48)}`,
      logIndex: transactionIndex,
    };
  };
  const positions = Array.from(
    { length: chartDefinition.maximumPositionCount },
    (_, index) => {
      const intervalStart = firstPositionStart + index * chartDefinition.intervalMilliseconds;
      const intervalEnd = intervalStart + chartDefinition.intervalMilliseconds;
      const representedStart = Math.max(intervalStart, requestedStart);
      const representedEnd = Math.min(intervalEnd, requestedEnd);
      if (representedStart >= representedEnd) {
        throw new TypeError("Maximum chart position does not intersect its request.");
      }
      const sourceCandleCount = (representedEnd - representedStart) / 60_000;
      if (!Number.isInteger(sourceCandleCount) || sourceCandleCount < 1) {
        throw new TypeError("Maximum chart position lacks a complete source minute.");
      }
      const exact = { numerator: maximumNumerator, denominator: maximumDenominator };
      return {
        intervalStart: new Date(intervalStart).toISOString(),
        intervalEnd: new Date(intervalEnd).toISOString(),
        representedStart: new Date(representedStart).toISOString(),
        representedEnd: new Date(representedEnd).toISOString(),
        coverage: "complete" as const,
        candle: {
          open: exact,
          high: exact,
          low: exact,
          close: exact,
          tokenVolumeRaw: (BigInt(maximumVolume) * BigInt(sourceCandleCount)).toString(),
          quoteVolumeRaw: (BigInt(maximumVolume) * BigInt(sourceCandleCount)).toString(),
          tradeCount: (BigInt(Number.MAX_SAFE_INTEGER) * BigInt(sourceCandleCount)).toString(),
          firstSource: sourcePosition(representedStart, false),
          lastSource: sourcePosition(representedEnd - 60_000, true),
          observedStart: new Date(representedStart).toISOString(),
          observedEnd: new Date(representedEnd).toISOString(),
        },
      };
    },
  );

  return stockTokenTradeHistoryDataSchema.parse({
    status: "available",
    ...interval,
    source: {
      chainId: stockTokenTradeHistoryRegistry.chain.chainId,
      finality: stockTokenTradeHistoryRegistry.chain.finalityTag,
      poolManager: stockTokenTradeHistoryRegistry.deployment.poolManager,
      poolId: asset.poolId,
      quoteToken: {
        address: asset.pair.quoteAsset.address,
        decimals: asset.pair.quoteAsset.decimals,
        symbol: "USDG",
      },
    },
    sourceFiles: {
      contractVersion: "1",
      pairId: asset.poolId,
      sequence: Number.MAX_SAFE_INTEGER,
      coveredUntilTimestamp: interval.requestedEnd,
      stateSha256: "f".repeat(64),
      months: [...new Set(intervals.map((entry) => entry.fromTimestamp.slice(0, 7)))].map(
        (month, index) => ({ month, sha256: (index + 1).toString(16).padStart(64, "0") }),
      ),
      days: intervals.map((entry, index) => ({
        day: entry.fromTimestamp.slice(0, 10),
        sha256: index.toString(16).padStart(64, "0"),
      })),
    },
    freshness: "current",
    coverage: {
      status: "complete",
      intervals,
      limitations: [],
    },
    chart: {
      window: "30d",
      ...interval,
      source: {
        chainId: stockTokenTradeHistoryRegistry.chain.chainId,
        finality: stockTokenTradeHistoryRegistry.chain.finalityTag,
        poolManager: stockTokenTradeHistoryRegistry.deployment.poolManager,
        poolId: asset.poolId,
        token: { address: asset.token, decimals: asset.tokenDecimals, symbol: asset.symbol },
        quoteToken: {
          address: asset.pair.quoteAsset.address,
          decimals: asset.pair.quoteAsset.decimals,
          symbol: "USDG",
        },
      },
      positions,
    },
  });
};

const maximumStockTokenTradeHistoryResult = () => {
  const asset = stockTokenTradeHistoryRegistry.pairs
    .map(({ pair }) => pair.baseAsset.kind === "erc20"
      ? findStockTokenTradeHistoryAsset(pair.baseAsset.address)
      : undefined)
    .find((candidate) => candidate !== undefined);
  if (asset === undefined) throw new TypeError("A registered Stock Token is required.");
  const official = defaultStockTokenManifest.assets.find(
    (candidate) => candidate.contractAddress === asset.token,
  );
  if (official === undefined) throw new TypeError("The registered token lacks official identity.");

  const block = chainAnchorSchema.parse({
    chainId: stockTokenTradeHistoryRegistry.chain.chainId,
    blockNumber: maximumUint256,
    blockHash: `0x${"ff".repeat(32)}`,
    blockTimestamp: "9999-12-30T12:01:00.000Z",
  });
  const member = {
    assetUid: official.assetUid,
    contractAddress: asset.token,
    sourceName: asset.name,
    sourceSymbol: asset.symbol,
  };
  const observedAt = parseUtcTimestamp("9999-12-30T11:59:00.000Z");
  const snapshot = assertCommittedOfficialAssetSnapshot({
    sourceUri: officialAssetSourceDefinition.sourceUri,
    sourceObservedAt: observedAt,
    rawResponseDigest: parseHash32(`0x${"aa".repeat(32)}`),
    memberSetDigest: officialAssetMemberSetDigest([member]),
    candidateListDigest: officialAssetCandidateListDigest([member]),
    chainId: block.chainId,
    members: [member],
    revision: officialAssetSnapshotRevisionSchema.parse(
      Buffer.alloc(16, 255).toString("base64url"),
    ),
    updatedAt: observedAt,
  });
  const request = { symbol: asset.symbol, window: "30d" as const };
  const resolution = resolveStockTokenTradeHistoryOfficialAsset(request, snapshot);
  if (resolution.status !== "resolved") throw new TypeError("Official Stock Token did not resolve.");
  const stockFactory = stockFactoryVerificationSchema.parse({
    assetUid: official.assetUid,
    contractAddress: asset.token,
    block,
    proxyAddress: stockFactoryAdmissionManifest.proxyAddress,
    proxyCodeHash: stockFactoryAdmissionManifest.proxyCodeHash,
    implementationAddress: stockFactoryAdmissionManifest.implementationAddress,
    implementationCodeHash: stockFactoryAdmissionManifest.implementationCodeHash,
    tokenCodeHash: parseHash32(`0x${"bb".repeat(32)}`),
  });
  const result = createStockTokenTradeHistoryResult({
    request,
    resolution,
    block,
    stockFactory,
    data: maximumStockTokenTradeHistoryData(
      asset.token,
      stockTokenTradeHistoryInterval(request.window, block.blockTimestamp),
    ),
  });
  return {
    request,
    result: stockTokenTradeHistoryApplicationContract.parsePublicSuccess(request, result),
  };
};

describe("semantic read maximum envelope", () => {
  it("fixes every semantic-read field at its independent contract value", () => {
    expect(readCapabilityLimits).toEqual({
      runtimeCodeBytes: 262_144,
      transactionCalldataBytes: 2_097_152,
      transactionLogTopics: 4,
      transactionReceiptLogs: 4_096,
      transactionAccessListEntries: 1_024,
      transactionAccessListStorageKeyOccurrences: 4_096,
      transactionType: 127,
      accountTokenAddresses: 50,
    });
    expect(Object.isFrozen(readCapabilityLimits)).toBe(true);
  });

  it("validates all semantic-read maximum result shapes and the one-byte aggregate boundary", async () => {
    await verifySemanticReadMaximumEnvelopes();
  }, 30_000);

  it("declares the aggregate failure on every semantic read definition exactly once", () => {
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
      expect(getCapabilityDefinitionSnapshot(definition).maximumSuccessUtf8Bytes).toBe(
        maximumSuccessUtf8Bytes,
      );
    }
  });

  it("admits the maximum trade-history result through transport and exact App chunks", async () => {
    const { request, result } = maximumStockTokenTradeHistoryResult();
    expect(result.status).toBe("available");
    if (result.status !== "available") throw new TypeError("Maximum trade history is unavailable.");
    expect(Object.hasOwn(result, "candles")).toBe(false);
    expect(Object.hasOwn(result, "detail")).toBe(false);
    expect(result.chart.positions).toHaveLength(
      stockTokenTradeHistoryChartWindowDefinitions["30d"].maximumPositionCount,
    );
    expect(canonicalUtf8Bytes(result)).toBe(403_301);
    const canonicalResult = captureCanonicalJson(result);
    const ordinaryMcpResult: CallToolResult = {
      structuredContent: canonicalResult as Record<string, unknown>,
      content: [{ type: "text", text: canonicalJsonStringify(canonicalResult) }],
    };
    expect(canonicalUtf8Bytes(ordinaryMcpResult)).toBe(829_034);
    expect(canonicalUtf8Bytes(ordinaryMcpResult)).toBeLessThanOrEqual(
      maximumMcpToolResultUtf8Bytes,
    );
    expect(canonicalUtf8Bytes(result)).toBeLessThanOrEqual(maximumSuccessUtf8Bytes);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(
      publicReadResponseLimitBytes,
    );
    expect(
      stockTokenTradeHistoryApplicationContract.failureCodes.filter(
        (code) => code === "result_too_large",
      ),
    ).toHaveLength(1);

    const directory = await mkdtemp(resolve(tmpdir(), "littlejohn-maximum-presentation-"));
    const path = resolve(directory, "runtime.sqlite3");
    let database: ProductDatabase | undefined;
    try {
      database = await ProductDatabase.open(path, parseUtcTimestamp("2026-08-22T00:00:00.000Z"));
      const service = new McpAppPresentationService(
        database.presentationSnapshotStore(),
        createMcpAppResource("<!doctype html><main>Little John</main>"),
      );
      const handoff = service.present(
        stockTokenTradeHistoryApplicationContract,
        request,
        ordinaryMcpResult,
      );
      expect(handoff.status).toBe("available");
      if (handoff.status !== "available") throw new TypeError("Maximum snapshot was not admitted.");
      const creatingResult = handoff.delivery.result;
      expect(creatingResult.structuredContent).toEqual(canonicalResult);
      expect(creatingResult.content).toHaveLength(2);
      expect(creatingResult.content[0]).toEqual(ordinaryMcpResult.content[0]);
      expect(creatingResult.content[1]?.type).toBe("resource_link");
      const creatingResultBytes = canonicalUtf8Bytes(creatingResult);
      expect(creatingResultBytes).toBe(830_143);
      expect(creatingResultBytes).toBeLessThanOrEqual(maximumMcpToolResultUtf8Bytes);
      const resource = admitPresentationSnapshotResource(
        creatingResult._meta?.[presentationSnapshotMetadataKey],
      );
      expect(resource.descriptor.resultChunkBytes).toBe(presentationSnapshotLimits.resultChunkBytes);
      expect(resource.descriptor.resultChunkCount).toBe(2);
      const reloaded = database.presentationSnapshotStore().read(resource.descriptor.snapshotId);
      expect(reloaded.status).toBe("available");
      if (reloaded.status !== "available") throw new TypeError("Maximum snapshot was not reloaded.");
      expect(new TextDecoder("utf-8", { fatal: true }).decode(reloaded.value.resultBytes))
        .toBe(canonicalJsonStringify(canonicalResult));

      const chunks: Buffer[] = [];
      for (let index = 0; index < resource.descriptor.resultChunkCount; index += 1) {
        const chunk = presentationSnapshotChunkSchema.parse(service.getResultChunk(
          resource.descriptor.snapshotId,
          index,
        ));
        const canonicalChunk = captureCanonicalJson(chunk);
        const chunkMcpResult = {
          structuredContent: canonicalChunk,
          content: [{ type: "text", text: canonicalJsonStringify(canonicalChunk) }],
        };
        if (index === 0) expect(canonicalUtf8Bytes(chunkMcpResult)).toBeLessThanOrEqual(699_444);
        expect(canonicalUtf8Bytes(chunkMcpResult)).toBeLessThanOrEqual(
          maximumMcpToolResultUtf8Bytes,
        );
        expect(chunk.snapshotId).toBe(resource.descriptor.snapshotId);
        expect(chunk.index).toBe(index);
        const bytes = Buffer.from(chunk.canonicalBase64, "base64");
        const expectedLength = index + 1 === resource.descriptor.resultChunkCount
          ? resource.descriptor.resultUtf8Bytes - resource.descriptor.resultChunkBytes * index
          : resource.descriptor.resultChunkBytes;
        expect(bytes).toHaveLength(expectedLength);
        chunks.push(bytes);
      }
      const reconstructed = Buffer.concat(chunks);
      expect(reconstructed).toHaveLength(resource.descriptor.resultUtf8Bytes);
      expect(createHash("sha256").update(reconstructed).digest("hex"))
        .toBe(resource.descriptor.resultSha256);
      expect(reconstructed.toString("utf8")).toBe(canonicalJsonStringify(canonicalResult));
    } finally {
      database?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
