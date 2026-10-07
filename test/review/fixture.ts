import { vi } from "vitest";
import {ObservationAuthorityRegistry, createCanonicalClock, createCapabilityInvocationAuthority, createObservationAuthority, createObservationAuthorityIssuer, parseHash32, parseHexBytes, parseUnsignedDecimal, parseUtcTimestamp, sourceReferenceSchema} from "../../src/core/index.js";
import {chainAnchorSchema} from "../../src/evm/primitives.js";
import {contractAnalysisSchema, createContractAnalysisSourceClaim} from "../../src/intelligence/analysis-contract.js";
import {dynamicFeeRequestCommitment} from "../../src/evm/transaction-request.js";
import {keccak256FromHex} from "../../src/evm/keccak256.js";
import {parseEvmAddress, type EvmAddress} from "../../src/evm/identities.js";
import {requiredErc8056ObservationSchema} from "../../src/evm/token-standards.js";
import {walletConnectionDataSchema} from "../../src/wallet/connection-contract.js";
import { createChainInvocationLifecycle, createEvmAbiCodec } from "../../src/chain/index.js";
import { normalizeRpcTransaction } from "../../src/chain/normalization.js";
import { serializeDynamicFeeRequest } from "../../src/chain/transaction-reads.js";
import {
  assertCommittedOfficialAssetSnapshot, officialAssetSnapshotRevisionSchema, officialAssetSourceDefinition,
  stockFactoryAdmissionManifest, stockFactoryVerificationSchema,
} from "../../src/registry/index.js";
import { officialAssetCandidateListDigest, officialAssetMemberSetDigest } from "../../src/registry/official-asset-contract.js";
import { observeExchange, type ExchangePreparationDependencies } from "../../src/review/preparation.js";
import { exchangeObservationInputSchema, exchangeObservationResultSchema } from "../../src/review/observation-contract.js";
import { requestReviewLimits } from "../../src/review/request-limits.js";
import { ExchangeCoordinator } from "../../src/review/coordinator.js";
import type { WalletRequestPort, WalletTransactionResponse } from "../../src/wallet/request-contract.js";
import type { ReceivedWalletTransaction, TransactionReceiptAdmissionPort, WalletReceiptReservation } from "../../src/receipt-activity/admission.js";
import { createReadyExchangeReview, exchangeDirectDecisionSchema, exchangeReviewSchema } from "../../src/review/contracts.js";
import { createRequestReviewMaterialStore } from "../../src/runtime/request-review-material.js";
import { createUniswapV4Evm } from "../../src/protocols/uniswap-v4/evm.js";
import { walletSessionRequirements } from "../../src/wallet/session-requirements.js";
import { uniswapV4PoolCatalog, uniswapV4ContractAddresses } from "../../src/protocols/uniswap-v4/client.js";
import { uniswapV4RequiredContractFunctions } from "../../src/protocols/uniswap-v4/contract-profile.js";

import { nativeAssetUnitDefinition } from "../../src/registry/native-asset.js";
const unsupported = async (): Promise<never> => { throw new Error("Unexpected fixture port."); };
const word = (value: bigint) => parseHexBytes(`0x${value.toString(16).padStart(64, "0")}`);
export const createExchangeFixture = (kind: "swap" | "erc20_approval" | "permit2_approval" = "swap", largeSession = false) => {
  let now = "2026-09-08T00:00:01.000Z";
  const clock = createCanonicalClock(() => now);
  let block = chainAnchorSchema.parse({ chainId: "eip155:4663", blockNumber: "100", blockHash: `0x${"ab".repeat(32)}`, blockTimestamp: "2026-09-08T00:00:00.000Z" });
  const originalBlock = block;
  const pool = uniswapV4PoolCatalog[0]!;
  const account = parseEvmAddress(`0x${"12".repeat(20)}`);
  const member = { assetUid: parseHash32(`0x${"34".repeat(32)}`), contractAddress: pool.stockTokenAddress };
  const snapshot = assertCommittedOfficialAssetSnapshot({
    sourceUri: officialAssetSourceDefinition.sourceUri, sourceObservedAt: parseUtcTimestamp(now),
    rawResponseDigest: parseHash32(`0x${"56".repeat(32)}`), memberSetDigest: officialAssetMemberSetDigest([member]),
    candidateListDigest: officialAssetCandidateListDigest([member]), chainId: block.chainId,
    members: [member], revision: officialAssetSnapshotRevisionSchema.parse(Buffer.alloc(16, 1).toString("base64url")), updatedAt: parseUtcTimestamp(now),
  });
  const rpc = createObservationAuthority({ clock, sourceClass: "chain_rpc", owner: "Test RPC", reference: sourceReferenceSchema.parse({ kind: "public", sourceId: "rpc", uri: "https://rpc.example/" }) });
  const api = createObservationAuthority({ clock, sourceClass: "web_api", owner: "Robinhood", reference: sourceReferenceSchema.parse({ kind: "public", sourceId: "official-assets", uri: officialAssetSourceDefinition.sourceUri }) });
  const wallet = createObservationAuthority({ clock, sourceClass: "wallet_session", owner: "WalletConnect session", reference: sourceReferenceSchema.parse({ kind: "wallet_session", sourceId: `wallet-session:${"A".repeat(43)}`, topicDigest: "A".repeat(43) }) });
  const source = createObservationAuthorityIssuer({ clock, sourceClass: "contract_verification_service", owner: "Sourcify", referenceKind: "public", sourceId: "sourcify-v2" });
  const nativeUnitAuthority = createObservationAuthority({ clock, sourceClass: "official_document", owner: "Native asset definition",
    reference: sourceReferenceSchema.parse({ kind: "public", sourceId: "native-ether-definition", uri: nativeAssetUnitDefinition.chainSource }) });
  const sources = new ObservationAuthorityRegistry(clock, [rpc, api, wallet, source.registration, nativeUnitAuthority]);
  const identifiers = Array.from({ length: 64 }, (_, index) => `${'"'.repeat(62)}${String(index).padStart(2, "0")}`);
  const connection = walletConnectionDataSchema.parse({
    status: "connected", address: account, chainId: block.chainId,
    approvedMethods: largeSession ? [...identifiers.slice(0, 63), "eth_sendTransaction"].sort() : ["eth_sendTransaction"],
    approvedEvents: largeSession ? [...identifiers.slice(0, 62), ...walletSessionRequirements.requiredEvents].sort() : [...walletSessionRequirements.requiredEvents], expiresAt: "2026-09-09T00:00:00.000Z",
  });
  const session = { sourceId: `wallet-session:${"A".repeat(43)}`, candidateId: "candidate", topicDigest: "A".repeat(43), observationAuthority: wallet };
  let revision = parseUnsignedDecimal("1");
  const chain = createChainInvocationLifecycle(new AbortController().signal);
  const codec = createEvmAbiCodec();
  const evm = createUniswapV4Evm(codec);
  const addresses = { input_token: pool.poolKey.currency0 === pool.stockTokenAddress ? pool.poolKey.currency1 : pool.poolKey.currency0, output_token: pool.stockTokenAddress, permit2: uniswapV4ContractAddresses.permit2, pool_manager: uniswapV4ContractAddresses.poolManager, quoter: uniswapV4ContractAddresses.quoter, router: uniswapV4ContractAddresses.router, state_view: uniswapV4ContractAddresses.stateView };
  const code = { bytecode: parseHexBytes("0x6000"), identity: { byteLength: parseUnsignedDecimal("2"), codeHash: parseHash32(keccak256FromHex("0x6000")) } };
  const inspect = vi.fn(async (_context: unknown, _block: unknown, address: EvmAddress) => {
    const role = Object.entries(addresses).find(([, value]) => value === address)![0] as keyof typeof addresses;
    const implementation = parseEvmAddress(`0x${"78".repeat(20)}`);
    const proxied = role === "input_token" || role === "output_token";
    const analysis = contractAnalysisSchema.parse({
      chainId: block.chainId, target: address, block, targetRuntimeCode: code.identity,
      proxy: proxied ? { status: "resolved", method: "eip1967_implementation", implementation, implementationRuntimeCode: code.identity, admin: { status: "not_present" } } : { status: "no_supported_proxy_observed" },
      sources: proxied ? [{ role: "target", address, status: "no_record_observed" }, { role: "implementation", address: implementation, status: "exact_match" }] : [{ role: "target", address, status: "exact_match" }],
      declaredFunctions: { status: "observed", signatures: uniswapV4RequiredContractFunctions[role] },
      controls: { owner: { status: "not_declared" }, paused: { status: "not_declared" }, defaultAdmins: { status: "not_declared" } },
    });
    return {
      analysis, targetRuntimeCode: code,
      sourceObservations: analysis.sources.map((entry) => {
        const reference = sourceReferenceSchema.parse({ kind: "public", sourceId: "sourcify-v2", uri: `https://sourcify.example/${entry.address}` });
        if (reference.kind !== "public") throw new Error("Fixture source is not public.");
        return { ...entry, reference, observationAuthority: source.issue(reference), claim: createContractAnalysisSourceClaim(analysis, entry.role) };
      }),
    };
  });
  const readsCall = vi.fn(async (_context: unknown, _block: unknown, call: { to: EvmAddress; data: string }) => {
    let value;
    if (call.to === addresses.state_view) value = codec.encodeParameters([{ type: "uint160" }, { type: "int24" }, { type: "uint24" }, { type: "uint24" }], [1n << 96n, 0, 0, pool.poolKey.fee]);
    else if (call.to === addresses.quoter) value = codec.encodeParameters([{ type: "uint256" }, { type: "uint256" }], [20n, 15_000n]);
    else if (call.to === addresses.permit2) value = codec.encodeParameters([{ type: "uint160" }, { type: "uint48" }, { type: "uint48" }], [kind === "swap" ? 10n : 0n, 2_000_000_000, 0]);
    else if (call.data.startsWith("0xdd62ed3e")) value = word(kind === "erc20_approval" ? 0n : 10n);
    else if (call.data.startsWith("0x70a08231")) value = word(100n);
    else throw new Error("Unexpected token read.");
    return { status: "observed" as const, value };
  });
  const estimate = vi.fn(async () => "100000");
  const simulate = vi.fn(async () => ({ status: "returned" as const, data: kind === "erc20_approval" ? word(1n) : parseHexBytes("0x") }));
  const deps: ExchangePreparationDependencies = {
    clock, invocationAuthority: createCapabilityInvocationAuthority(clock, block.chainId), createInvocationPorts: () => ({ observations: sources }),
    activeWallet: { capture: async () => ({ connection, connectionRevision: revision, sessionSource: session }) },
    chainInvocations: chain,
    officialAssets: { synchronize: async () => ({ status: "current", snapshot }), readStored: () => snapshot },
    officialAssetObservationAuthority: api,
    officialAssetReads: {
      verifyAtBlock: async () => ({ status: "verified", member, verification: stockFactoryVerificationSchema.parse({ assetUid: member.assetUid, contractAddress: member.contractAddress, block, proxyAddress: stockFactoryAdmissionManifest.proxyAddress, proxyCodeHash: stockFactoryAdmissionManifest.proxyCodeHash, implementationAddress: stockFactoryAdmissionManifest.implementationAddress, implementationCodeHash: stockFactoryAdmissionManifest.implementationCodeHash, tokenCodeHash: code.identity.codeHash }) }),
      verifyManyAtBlock: unsupported,
    },
    reads: {
      observationAuthority: rpc, resolveBlock: async (_context, selector) => ({ anchor: selector.kind === "number" && selector.blockNumber === originalBlock.blockNumber ? originalBlock : block }), call: readsCall,
      readTokenDecimals: async () => ({ status: "observed", value: parseUnsignedDecimal("0") }),
      readTokenDisplayScaling: async (_context, _block, token) => requiredErc8056ObservationSchema.parse({
        asset: { kind: "erc20", chainId: block.chainId, address: token }, block,
        erc165: { standardId: "erc165", status: "supported" },
        erc8056: { standardId: "erc8056", status: "supported" },
        pendingMultiplier: { standardId: "erc8056_pending_multiplier", status: "supported" },
        values: { currentMultiplier: "2000000000000000000", pendingMultiplier: "0", pendingEffectiveAt: "0" },
      }),
      inspectContractExecution: inspect, inspectContract: unsupported, readRuntimeCode: unsupported,
      recordConfiguredChain: () => { throw new Error("Unexpected configured-chain evidence call."); },
    },
    transactions: { observationAuthority: rpc, balance: async () => "1000000000", nonce: async () => ({ confirmed: "1", pending: "1" }), estimateGas: estimate, simulate, readTransaction: unsupported, finality: unsupported }, evm,
  };
  const input = exchangeObservationInputSchema.parse({
    operationId: Buffer.alloc(32, 1).toString("base64url"), createdAt: now, actionExpiresAt: "2026-09-08T00:05:00.000Z",
    request: { account: { kind: "address", address: account }, stockTokenAddress: member.contractAddress, direction: "buy", poolId: pool.poolId,
      conditions: { basis: "sent", inputRelation: "equal", inputAmount: "10", outputRelation: "at_least", outputAmount: "19" },
      fees: { maxFeePerGas: "10", maxPriorityFeePerGas: "1" }, deadline: "2026-09-08T00:05:00.000Z" },
  });
  return { deps, input, inspect, estimate, simulate, readsCall, codec, nativeUnitAuthority, invocationPorts: { observations: sources },
    advanceBlock: () => {
      now = "2026-09-08T00:00:02.000Z";
      block = chainAnchorSchema.parse({ ...block, blockNumber: "101", blockHash: `0x${"cd".repeat(32)}`, blockTimestamp: "2026-09-08T00:00:01.000Z" });
    },
    expire: () => { now = "2026-09-08T00:05:00.000Z"; },
    replaceConnection: () => { revision = parseUnsignedDecimal("2"); }, close: () => chain.close() };
};

