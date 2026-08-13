import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { createErc20CallEncoder, type Erc20CallEncoder } from "../../src/chain/evm-standard.js";
import type { ChainRpcMethod, ChainRpcRequestMap } from "../../src/chain/rpc.js";
import {
  accountBalanceCapability,
  canonicalJsonStringify,
  chainAnchorSchema,
  chainStatusCapability,
  contractAnalysisSchema,
  contractDeclaredFunctionCountLimit,
  contractInspectCapability,
  createExactRational,
  getCapabilityDefinitionSnapshot,
  maximumEvmBalanceRaw,
  maximumSuccessUtf8Bytes,
  parseEvmAddress,
  parseCapabilitySuccess,
  parseHash32,
  parseUnsignedDecimal,
  parseUtcTimestamp,
  referenceHistoryWindowDefinitions,
  referenceHistoryWarnings,
  referenceMarketManifest,
  referenceMarketMappingEvidence,
  referenceRoundObservationSchema,
  stockTokenReferenceMarketCatalog,
  referenceWatchlistRevisionSchema,
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
  findStockTokenExecutionIndexAsset,
  stockTokenExecutionIndexRegistry,
  stockTokenExecutionSeriesLimits,
  stockTokenExecutionSeriesSchema,
  unavailableStockTokenExecutionSeries,
} from
  "../../src/market-portfolio/stock-token-execution-index.js";
import { stockTokenHistoryInterval } from
  "../../src/market-portfolio/stock-token-market.js";
import {
  internalResponseLimitBytes,
  publicReadResponseLimitBytes,
} from "../../src/runtime/http-boundary.js";
import { referenceMarketApplicationContracts } from "../../src/market-portfolio/contracts.js";
import { createDirectReferenceCandleSeries } from
  "../../src/market-portfolio/candles.js";
import {
  createAvailableStockTokenMarketResult,
  resolveStockTokenMarketAsset,
} from "../../src/market-portfolio/stock-token-market.js";
import {
  assertCommittedOfficialAssetSnapshot,
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

const independentRecordDigest = (
  source: Readonly<Record<string, unknown>>,
  claims: readonly unknown[],
): string =>
  createHash("sha256").update(independentCanonicalJson({
    claims,
    digestKind: "evidence_source_record",
    source,
  }), "utf8").digest("base64url");

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
  const baseline = await unresolvedWallet("2");
  expect(baseline.ok).toBe(true);
  if (!baseline.ok) throw new TypeError("The wallet boundary baseline did not succeed.");
  const fixedBytes = canonicalUtf8Bytes(baseline) - 1;
  const sessionCount = "9".repeat(maximumSuccessUtf8Bytes - fixedBytes);
  const exact = await unresolvedWallet(sessionCount);
  expect(exact.ok).toBe(true);
  if (!exact.ok) throw new TypeError("The exact wallet boundary did not succeed.");
  expect(canonicalUtf8Bytes(exact)).toBe(8_388_607);
  expect(parseCapabilitySuccess(walletConnectionCapability, {}, exact)).toEqual(exact);

  const oversizedTransportSuccess = {
    ...exact,
    data: { status: "unresolved" as const, sessionCount: `${sessionCount}9` },
    evidence: {
      ...exact.evidence,
      sources: exact.evidence.sources.map((source) => source.purpose === "wallet_sdk_sessions"
        ? (() => {
            const { recordDigest: _recordDigest, ...sourceRecord } = source;
            return {
              ...sourceRecord,
              recordDigest: independentRecordDigest(sourceRecord, [{
              role: "wallet_sdk_state",
              value: { status: "unresolved", sessionCount: `${sessionCount}9` },
              }]),
            };
          })()
        : source),
    },
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
  const contract = await invokeChain(contractInspectCapability, {
    address: account,
    block: { kind: "latest" },
  }, [
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

  const accountResult = await maximumAccountSuccess();
  const wallet = await exactWalletBoundary();
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

const maximumStockTokenExecutionSeries = (
  token: EvmAddress,
  interval: Readonly<{ requestedStart: string; requestedEnd: string }>,
) => {
  const asset = findStockTokenExecutionIndexAsset(token);
  if (asset === undefined) throw new TypeError("The maximum execution fixture must be indexed.");
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
  const firstCandleStart = requestedEnd -
    stockTokenExecutionSeriesLimits.candles * 60_000;
  const candles = Array.from({ length: stockTokenExecutionSeriesLimits.candles }, (_, index) => {
    const intervalStart = firstCandleStart + index * 60_000;
    const coverage = intervals.find((candidate) =>
      intervalStart >= Date.parse(candidate.fromTimestamp) &&
      intervalStart < Date.parse(candidate.untilTimestamp));
    if (coverage === undefined) throw new TypeError("Maximum execution candle lacks coverage.");
    const blockNumber = (BigInt(coverage.fromBlock) +
      BigInt((intervalStart - Date.parse(coverage.fromTimestamp)) / 60_000)).toString();
    const source = {
      blockNumber,
      blockHash: `0x${"ff".repeat(32)}`,
      transactionIndex: Number.MAX_SAFE_INTEGER,
      transactionHash: `0x${"ee".repeat(32)}`,
      logIndex: Number.MAX_SAFE_INTEGER,
    };
    const exact = { numerator: maximumNumerator, denominator: maximumDenominator };
    return {
      symbol: asset.symbol,
      token: asset.token,
      poolId: asset.poolId,
      intervalStart: new Date(intervalStart).toISOString(),
      intervalEnd: new Date(intervalStart + 60_000).toISOString(),
      open: exact,
      high: exact,
      low: exact,
      close: exact,
      tokenVolumeRaw: maximumVolume,
      quoteVolumeRaw: maximumVolume,
      tradeCount: Number.MAX_SAFE_INTEGER,
      firstSource: source,
      lastSource: source,
    };
  });
  return stockTokenExecutionSeriesSchema.parse({
    status: "available",
    ...interval,
    source: {
      chainId: stockTokenExecutionIndexRegistry.chain.chainId,
      finality: stockTokenExecutionIndexRegistry.chain.finalityTag,
      poolManager: stockTokenExecutionIndexRegistry.deployment.poolManager,
      poolId: asset.poolId,
      quoteToken: stockTokenExecutionIndexRegistry.deployment.quoteToken,
    },
    artifact: {
      contractVersion: "1",
      groupId: stockTokenExecutionIndexRegistry.groups[0]!.groupId,
      sequence: Number.MAX_SAFE_INTEGER,
      coveredUntilTimestamp: interval.requestedEnd,
      stateSha256: "f".repeat(64),
      days: intervals.map((entry, index) => ({
        day: entry.fromTimestamp.slice(0, 10),
        sha256: index.toString(16).padStart(64, "0"),
      })),
    },
    freshness: "current",
    coverage: {
      status: "partial",
      intervals,
      limitations: ["candle_capacity"],
      observedCandleCount: 43_200,
    },
    candles,
  });
};

const maximumStockTokenMarketSuccess = (withExecution: boolean) => {
  const mapped = stockTokenReferenceMarketCatalog.dispositions.filter((entry) =>
    entry.mapping.status === "mapped" &&
    (!withExecution || findStockTokenExecutionIndexAsset(
      entry.mapping.selectedDeployment.contractAddress,
    ) !== undefined));
  const disposition = mapped.reduce((largest, entry) =>
    Buffer.byteLength(independentCanonicalJson(entry), "utf8") >
      Buffer.byteLength(independentCanonicalJson(largest), "utf8") ? entry : largest);
  if (disposition.mapping.status !== "mapped") {
    throw new TypeError("The maximum Stock Token fixture must be mapped.");
  }
  const member = {
    assetUid: disposition.asset.assetUid,
    contractAddress: disposition.mapping.selectedDeployment.contractAddress,
    sourceName: disposition.asset.name,
    sourceSymbol: disposition.asset.symbol,
  } as const;
  const snapshotObservedAt = parseUtcTimestamp("9999-11-01T00:00:00.000Z");
  const officialSnapshot = assertCommittedOfficialAssetSnapshot({
    sourceUri: officialAssetSourceDefinition.sourceUri,
    sourceObservedAt: snapshotObservedAt,
    rawResponseDigest: parseHash32(`0x${"aa".repeat(32)}`),
    memberSetDigest: officialAssetMemberSetDigest([member]),
    candidateListDigest: officialAssetCandidateListDigest([member]),
    chainId: tokenChainId,
    members: [member],
    revision: officialAssetSnapshotRevisionSchema.parse(
      Buffer.alloc(16, 255).toString("base64url"),
    ),
    updatedAt: snapshotObservedAt,
  });
  const request = { symbol: member.sourceSymbol, window: "30d" as const };
  const resolution = resolveStockTokenMarketAsset(request, officialSnapshot);
  if (resolution.status !== "mapped") {
    throw new TypeError("The maximum Stock Token fixture did not resolve its mapping.");
  }

  const block = chainAnchorSchema.parse({
    chainId: "eip155:4663",
    blockNumber: maximumUint256,
    blockHash: `0x${"ff".repeat(32)}`,
    blockTimestamp: withExecution
      ? "9999-12-30T12:00:00.000Z"
      : "9999-12-31T23:59:59.999Z",
  });
  const window = referenceHistoryWindowDefinitions["30d"];
  const requestedEnd = Date.parse(block.blockTimestamp);
  const requestedStart = requestedEnd - window.windowMilliseconds;
  const firstBucket = Math.ceil(requestedStart / window.bucketMilliseconds) *
    window.bucketMilliseconds;
  const maximumRoundId = 2n ** 80n - 1n;
  const maximumAnswer = 2n ** 255n - 1n;
  const feed = disposition.mapping.feed;
  const observationsLength = window.maximumBuckets * 4;
  const observations = Array.from(
    { length: observationsLength },
    (_, index) => {
      const bucketIndex = Math.floor(index / 4);
      const pointIndex = index % 4;
      const updatedAt = firstBucket + bucketIndex * window.bucketMilliseconds +
        (pointIndex + 1) * 1_000;
      const updatedAtUnixSeconds = Math.floor(updatedAt / 1_000).toString(10);
      const roundId = (maximumRoundId - BigInt(observationsLength - 1 - index)).toString(10);
      const answer = [
        maximumAnswer - 2n,
        maximumAnswer,
        maximumAnswer - 3n,
        maximumAnswer - 1n,
      ][pointIndex]!;
      return referenceRoundObservationSchema.parse({
        fact: {
          manifestVersion: 1,
          feedId: feed.feedId,
          proxyAddress: feed.proxyAddress,
          decimals: feed.decimals,
          roundId,
          answeredInRound: roundId,
          answer: answer.toString(10),
          startedAtUnixSeconds: updatedAtUnixSeconds,
          updatedAtUnixSeconds,
          value: createExactRational(answer, 10n ** BigInt(feed.decimals)),
        },
        readEvidence: {
          observedAt: block.blockTimestamp,
          sourceOwner: "user_configured",
          sourceClass: "chain_rpc",
          sourceReference: {
            kind: "configured_rpc",
            sourceId: `rpc:${"A".repeat(43)}`,
            publicOrigin: "https://rpc.example",
            configurationDigest: "A".repeat(43),
          },
          block,
        },
      });
    },
  );
  const minimumRetainedRoundId = BigInt(observations[0]!.fact.roundId);
  const cacheSnapshot = Object.freeze({
    feedId: feed.feedId,
    revision: Buffer.alloc(16, 255).toString("base64url"),
    observations: Object.freeze(observations),
    backfillPhaseId: null,
    backfillNextRoundId: null,
    retentionCutoffRoundId: (minimumRetainedRoundId - 1n).toString(10),
    integrityStatus: null,
    backfillStatus: null,
  });
  const series = createDirectReferenceCandleSeries({
    feedId: feed.feedId,
    window: request.window,
    block,
    snapshot: cacheSnapshot,
  });
  expect(series.candles).toHaveLength(180);
  expect(series.sourceObservations).toHaveLength(720);
  const stockFactory = stockFactoryVerificationSchema.parse({
    assetUid: member.assetUid,
    contractAddress: member.contractAddress,
    block,
    proxyAddress: stockFactoryAdmissionManifest.proxyAddress,
    proxyCodeHash: stockFactoryAdmissionManifest.proxyCodeHash,
    implementationAddress: stockFactoryAdmissionManifest.implementationAddress,
    implementationCodeHash: stockFactoryAdmissionManifest.implementationCodeHash,
    tokenCodeHash: parseHash32(`0x${"ee".repeat(32)}`),
  });
  const result = createAvailableStockTokenMarketResult({
    request,
    resolution,
    block,
    read: {
      status: "observed",
      stockFactory,
      oraclePaused: false,
      latest: observations.at(-1)!,
    },
    series,
    execution: withExecution
      ? maximumStockTokenExecutionSeries(
          member.contractAddress,
          stockTokenHistoryInterval(request.window, block.blockTimestamp),
        )
      : unavailableStockTokenExecutionSeries({
          token: member.contractAddress,
          ...stockTokenHistoryInterval(request.window, block.blockTimestamp),
        }, findStockTokenExecutionIndexAsset(member.contractAddress) === undefined
          ? "asset_not_indexed"
          : "index_unavailable"),
    snapshot: cacheSnapshot,
    report: {
      remainingContinuation: true,
      remainingGap: true,
      phaseBoundaryObserved: true,
      malformedRoundObserved: true,
    },
  });
  return referenceMarketApplicationContracts.stockTokenMarket.parsePublicSuccess(request, result);
};

export const verifyMaximumReferenceMarketEnvelopes = (): void => {
  const pair = referenceMarketManifest.pairs[2]!;
  const latestUnixSeconds = "253402300799";
  const maximumRoundId = (2n ** 80n - 1n).toString(10);
  const maximumAnswer = 2n ** 255n - 1n;
  const rpcConfigurationDigest = "A".repeat(43);
  const maximumBlock = {
    chainId: "eip155:4663",
    blockNumber: maximumUint256,
    blockHash: `0x${"ff".repeat(32)}`,
    blockTimestamp: "9999-12-31T23:59:59.999Z",
  } as const;
  const observations = pair.contract.sourceIds.map((feedId, index) => {
    const feed = referenceMarketManifest.feeds.find((entry) => entry.feedId === feedId)!;
    const answer = index === 0 ? maximumAnswer : 1n;
    return referenceRoundObservationSchema.parse({
      fact: {
        manifestVersion: 1,
        feedId,
        proxyAddress: feed.standardProxy,
        decimals: feed.decimals,
        roundId: (BigInt(maximumRoundId) - BigInt(index)).toString(10),
        answeredInRound: (BigInt(maximumRoundId) - BigInt(index)).toString(10),
        answer: answer.toString(10),
        startedAtUnixSeconds: latestUnixSeconds,
        updatedAtUnixSeconds: latestUnixSeconds,
        value: {
          numerator: index === 0 ? maximumAnswer.toString(10) : "1",
          denominator: "100000000",
        },
      },
      readEvidence: {
        observedAt: "9999-12-31T23:59:59.999Z",
        sourceOwner: "user_configured",
        sourceClass: "chain_rpc",
        sourceReference: {
          kind: "configured_rpc",
          sourceId: `rpc:${rpcConfigurationDigest}`,
          publicOrigin: "https://rpc.example",
          configurationDigest: rpcConfigurationDigest,
        },
        block: maximumBlock,
      },
    });
  });
  const priceInput = { pairId: pair.pairId };
  const price = referenceMarketApplicationContracts.price.parsePublicSuccess(priceInput, {
    status: "current",
    pair,
    block: maximumBlock,
    mappingEvidence: referenceMarketMappingEvidence,
    sources: observations,
    warnings: [
      "reference_price_not_trade_price",
      "source_listing_not_revalidated",
      "sequencer_status_unavailable",
    ],
    currentPrice: { numerator: maximumAnswer.toString(10), denominator: "1" },
  });

  const requestedEnd = Date.parse("2026-08-01T00:00:00.000Z");
  const bucketMilliseconds = 4 * 60 * 60 * 1_000;
  const requestedStart = requestedEnd - 30 * 24 * 60 * 60 * 1_000;
  const historyBlock = {
    chainId: "eip155:4663",
    blockNumber: maximumUint256,
    blockHash: `0x${"ff".repeat(32)}`,
    blockTimestamp: new Date(requestedEnd).toISOString(),
  } as const;
  const sourceObservations: ReturnType<typeof referenceRoundObservationSchema.parse>[] = [];
  const maximumHistoryPointIndex = 180 * 4 - 1;
  const candles = Array.from({ length: 180 }, (_, index) => {
    const openedAt = requestedStart + index * bucketMilliseconds;
    const closedAt = openedAt + bucketMilliseconds;
    const pointers = Array.from({ length: 4 }, (_, pointIndex) => pair.contract.sourceIds.map((feedId, feedIndex) => {
      const feed = referenceMarketManifest.feeds.find((entry) => entry.feedId === feedId)!;
      const answer = feedIndex === 0 ? maximumAnswer : 1n;
      const pointIndexWithinFeed = index * 4 + pointIndex;
      const roundId = (BigInt(maximumRoundId) -
        BigInt(maximumHistoryPointIndex - pointIndexWithinFeed)).toString(10);
      const updatedAtUnixSeconds = Math.floor((openedAt + pointIndex * 1_000) / 1_000).toString(10);
      sourceObservations.push(referenceRoundObservationSchema.parse({
        fact: {
          manifestVersion: 1,
          feedId,
          proxyAddress: feed.standardProxy,
          decimals: feed.decimals,
          roundId,
          answeredInRound: roundId,
          answer: answer.toString(10),
          startedAtUnixSeconds: updatedAtUnixSeconds,
          updatedAtUnixSeconds,
          value: {
            numerator: feedIndex === 0 ? maximumAnswer.toString(10) : "1",
            denominator: "100000000",
          },
        },
        readEvidence: {
          observedAt: "2026-08-01T00:00:01.000Z",
          sourceOwner: "user_configured",
          sourceClass: "chain_rpc",
          sourceReference: {
            kind: "configured_rpc",
            sourceId: `rpc:${rpcConfigurationDigest}`,
            publicOrigin: "https://rpc.example",
            configurationDigest: rpcConfigurationDigest,
          },
          block: historyBlock,
        },
      }));
      return { feedId, roundId };
    }));
    const exact = { numerator: maximumAnswer.toString(10), denominator: "1" };
    return {
      openedAt: new Date(openedAt).toISOString(),
      closedAt: new Date(closedAt).toISOString(),
      openBucket: false,
      open: exact,
      high: exact,
      low: exact,
      close: exact,
      openSourcePointers: pointers[0],
      openSourceSkewSeconds: "0",
      highSourcePointers: pointers[1],
      highSourceSkewSeconds: "0",
      lowSourcePointers: pointers[2],
      lowSourceSkewSeconds: "0",
      closeSourcePointers: pointers[3],
      closeSourceSkewSeconds: "0",
    };
  });
  const historyInput = { pairId: pair.pairId, window: "30d" as const };
  const history = referenceMarketApplicationContracts.history.parsePublicSuccess(historyInput, {
    status: "partial",
    pair,
    window: "30d",
    block: historyBlock,
    mappingEvidence: referenceMarketMappingEvidence,
    coverage: {
      basis: "observed_rounds",
      requestedStart: new Date(requestedStart).toISOString(),
      requestedEnd: new Date(requestedEnd).toISOString(),
      emptyBucketStarts: [],
      limitations: ["source_history_not_exhaustive"],
    },
    candles,
    sourceObservations,
    warnings: [...referenceHistoryWarnings, "partial_history"],
  });
  const watchlist = referenceMarketApplicationContracts.watchlist.parsePublicSuccess({}, {
    account: { chainId: "eip155:4663", address: `0x${"ff".repeat(20)}` },
    revision: referenceWatchlistRevisionSchema.parse(Buffer.alloc(16, 255).toString("base64url")),
    entries: referenceMarketManifest.pairs,
  });
  const stockTokenMarket = maximumStockTokenMarketSuccess(false);
  const stockTokenMarketWithExecution = maximumStockTokenMarketSuccess(true);

  for (const success of [price, history, stockTokenMarket, stockTokenMarketWithExecution]) {
    expect(canonicalUtf8Bytes(success)).toBeLessThanOrEqual(maximumSuccessUtf8Bytes);
    expect(Buffer.byteLength(JSON.stringify(success), "utf8")).toBeLessThan(publicReadResponseLimitBytes);
  }
  expect(canonicalUtf8Bytes(watchlist)).toBeLessThan(internalResponseLimitBytes);
  expect(Buffer.byteLength(JSON.stringify(watchlist), "utf8")).toBeLessThan(internalResponseLimitBytes);
  for (const contract of Object.values(referenceMarketApplicationContracts)) {
    expect(contract.failureCodes.filter((code) => code === "result_too_large")).toHaveLength(1);
  }
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

  it("proves maximum reference-market successes against their actual transport boundaries", () => {
    verifyMaximumReferenceMarketEnvelopes();
  });
});
