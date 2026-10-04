import { readTransactionContractFacts } from "./contract-reads.js";
import { observeFeeReplacement } from "./fee-replacement.js";
import { readPendingReplacement } from "./pending-transaction.js";
import { assertHigherReplacementFees } from "./replacement-contract.js";
import { captureTransactionSession } from "./session.js";
import {CapabilityBindingRegistry, CapabilityRegistry, bindCapability, canonicalJsonStringify, captureCanonicalJson, deepFreezeValue, parseUnsignedDecimal, utf8ByteLength, type ApplicationFailure, type CanonicalClock, type CapabilityInvocationAuthority, type InvocationBoundaryPorts, type ObservationAuthority, type ObservationWriter} from "../core/index.js";
import {admitDynamicFeeTransactionRequest, dynamicFeeRequestCommitment, dynamicFeeTransactionCallSchema, type DynamicFeeTransactionRequest} from "../evm/transaction-request.js";
import {evmAccountIdentitySchema} from "../evm/identities.js";
import {productChainId} from "../registry/product-identity.js";
import {productUsdgAsset} from "../registry/product-assets.js";
import {walletConnectionDataSchema} from "../wallet/connection-contract.js";
import {
  createErc20CallEncoder, decodeAbiUint256Result, decodeAbiBooleanResult,
  normalizePinnedEvmReadFailure,
  type ChainInvocationPort, type OfficialAssetChainReadPort, type PinnedEvmReadPort,
} from "../chain/index.js";
import type { TransactionChainReadPort } from "../chain/transaction-reads.js";
import {
  findOfficialAssetMember, projectOfficialAssetSnapshotEvidence,
  type OfficialAssetReadPort,
} from "../registry/index.js";
import { getUniswapV4PoolCandidate, uniswapV4ContractAddresses } from "../protocols/uniswap-v4/client.js";
import { uniswapV4RequiredContractFunctions, uniswapV4ContractRoles } from "../protocols/uniswap-v4/contract-profile.js";
import { UniswapV4UnsupportedIntentError, type UniswapV4Evm } from "../protocols/uniswap-v4/evm.js";
import { isContractAnalysisTargetNotFoundError } from "../intelligence/contract-analysis.js";
import type { ActiveWalletReadPort } from "../wallet/coordinator.js";
import type { WalletSessionSource } from "../runtime/source-identity.js";
import { exchangeLimits } from "./limits.js";
import { requestReviewLimits } from "./request-limits.js";
import type { ExchangeReviewMaterial } from "./material-port.js";
import { createReviewedRequestReference } from "./request-reference.js";
import { parseExchangeRequest, resolveExchangeIntent } from "./exchange.js";
import { ExchangeError, createExchangeFailure, exchangeErrorRegistry, exchangeFailureCode } from "./errors.js";
import {
  admitExchangeObservation, exchangeObservationStateSchema, exchangeSemanticCommitment, exchangeQuoteSatisfiesConditions,
  requiredExchangeTransactionKind, type ExchangeObservation,
} from "./observation.js";
import { exchangeObservationCapability, exchangeObservationResultSchema, type ExchangeObservationInput, type ExchangeObservationResult } from "./observation-contract.js";
import {
  recordExchangeEvidence,
} from "./evidence-recording.js";

export interface ExchangePreparationDependencies {
  readonly clock: CanonicalClock;
  readonly invocationAuthority: CapabilityInvocationAuthority;
  createInvocationPorts(session: WalletSessionSource): InvocationBoundaryPorts;
  readonly activeWallet: ActiveWalletReadPort;
  readonly chainInvocations: ChainInvocationPort;
  readonly reads: PinnedEvmReadPort;
  readonly transactions: TransactionChainReadPort;
  readonly officialAssets: OfficialAssetReadPort;
  readonly officialAssetReads: OfficialAssetChainReadPort;
  readonly officialAssetObservationAuthority: ObservationAuthority;
  readonly evm: UniswapV4Evm;
}

export interface PreparedExchange {
  readonly ok: true;
  readonly review: ExchangeObservationResult;
  readonly privateRequest: DynamicFeeTransactionRequest;
}

// One invocation retains its native request only in this lexical scope. Core
// publishes the admitted observation; Runtime's later Review owner takes the
// complete public value and the separate private request together.
const captureExchange = async (
  dependencies: ExchangePreparationDependencies,
  input: ExchangeObservationInput,
  signal: AbortSignal,
  previous?: ExchangeReviewMaterial,
): Promise<PreparedExchange | ApplicationFailure> => {
  const request = parseExchangeRequest(input.request);
  let captured: ReturnType<typeof captureTransactionSession>;
  try { captured = captureTransactionSession(dependencies, request.account, input.actionExpiresAt, signal); }
  catch (error) {
    const code = exchangeFailureCode(error);
    if (code !== undefined) return createExchangeFailure(code);
    throw error;
  }
  const { initial, connection, session, assertLive } = captured;
  let privateRequest: DynamicFeeTransactionRequest | undefined;
  const binding = bindCapability({
    definition: exchangeObservationCapability,
    errorRegistry: exchangeErrorRegistry,
    invocationAuthority: dependencies.invocationAuthority,
    createInvocationPorts: () => dependencies.createInvocationPorts(session),
    handler: async (admitted, context, observations) => {
      try {
        assertLive();
        const pool = (() => {
          try { return getUniswapV4PoolCandidate(request.poolId); }
          catch { throw new ExchangeError("exchange_pool_unsupported"); }
        })();
        if (pool.stockTokenAddress !== request.stockTokenAddress) throw new ExchangeError("exchange_pool_unsupported");
        const official = await dependencies.officialAssets.synchronize(context.signal);
        if (official.status === "unavailable") throw new ExchangeError(official.reason);
        const member = findOfficialAssetMember(official.snapshot, request.stockTokenAddress);
        if (member === undefined) throw new ExchangeError("exchange_contract_unavailable");
        const data = await dependencies.chainInvocations.run(context.signal, async (chainContext) => {
          const { reads, transactions, evm } = dependencies;
          if (previous !== undefined) {
            const anchor = previous.review.observation.data.block;
            const canonical = await reads.resolveBlock(chainContext, { kind: "number", blockNumber: anchor.blockNumber });
            if (canonical.anchor.blockHash !== anchor.blockHash) throw new ExchangeError("state_conflict");
          }
          const block = await reads.resolveBlock(chainContext, { kind: "latest" });
          const verified = await dependencies.officialAssetReads.verifyAtBlock(member, block, chainContext);
          if (verified.status !== "verified") throw new ExchangeError("exchange_contract_unavailable");
          const tokenIn = request.direction === "buy" ? productUsdgAsset.address : member.contractAddress;
          const tokenOut = request.direction === "buy" ? member.contractAddress : productUsdgAsset.address;
          const inputDecimals = await reads.readTokenDecimals(chainContext, block, tokenIn);
          const outputDecimals = await reads.readTokenDecimals(chainContext, block, tokenOut);
          if (inputDecimals.status !== "observed" || outputDecimals.status !== "observed") throw new ExchangeError("exchange_contract_unavailable");
          const account = evmAccountIdentitySchema.parse({ chainId: connection.chainId, address: connection.address });
          const intent = resolveExchangeIntent({ request, account, inputDecimals: inputDecimals.value, outputDecimals: outputDecimals.value });
          const displayScaling = [
            await reads.readTokenDisplayScaling(chainContext, block, tokenIn),
            await reads.readTokenDisplayScaling(chainContext, block, tokenOut),
          ];
          const call = async (to: typeof tokenIn, data: Parameters<PinnedEvmReadPort["call"]>[2]["data"]) => {
            const result = await reads.call(chainContext, block, { to, data });
            if (result.status !== "observed") throw new ExchangeError("exchange_conditions_unmet");
            return result.value;
          };
          const encoder = await createErc20CallEncoder();
          const inputBalance = decodeAbiUint256Result(await call(tokenIn, encoder.balanceOf(account.address)));
          const outputBalance = decodeAbiUint256Result(await call(tokenOut, encoder.balanceOf(account.address)));
          const nativeBalance = await transactions.balance(chainContext, block, account.address);
          const nonce = await transactions.nonce(chainContext, block, account.address);
          const predecessor = request.replaces === undefined ? undefined :
            await readPendingReplacement(dependencies, chainContext, request.replaces, account);
          if (predecessor === undefined ? nonce.confirmed !== nonce.pending : predecessor.request.nonce !== nonce.confirmed) {
            throw new ExchangeError("exchange_conditions_unmet");
          }
          if (predecessor !== undefined) {
            try { assertHigherReplacementFees(predecessor.reference.fees, request.fees); }
            catch { throw new ExchangeError("exchange_replacement_unavailable"); }
          }
          const erc20Allowance = decodeAbiUint256Result(await call(tokenIn, evm.erc20Allowance(account.address)));
          const permit2 = evm.decodePermitAllowance(await call(uniswapV4ContractAddresses.permit2, evm.permitAllowance(account.address, tokenIn)));
          const slot0 = evm.decodeSlot0(await call(uniswapV4ContractAddresses.stateView, evm.slot0(pool.poolId)));
          if (slot0.sqrtPriceX96 === "0") throw new ExchangeError("exchange_conditions_unmet");
          const quote = evm.decodeQuote(await call(uniswapV4ContractAddresses.quoter, evm.quote(intent)));
          if (!exchangeQuoteSatisfiesConditions(intent, { amount: parseUnsignedDecimal(quote.amount), quoteGasEstimate: parseUnsignedDecimal(quote.quoteGasEstimate) })) {
            throw new ExchangeError("exchange_conditions_unmet");
          }
          const addresses = {
            input_token: tokenIn, output_token: tokenOut,
            permit2: uniswapV4ContractAddresses.permit2, pool_manager: uniswapV4ContractAddresses.poolManager,
            quoter: uniswapV4ContractAddresses.quoter, router: uniswapV4ContractAddresses.router,
            state_view: uniswapV4ContractAddresses.stateView,
          };
          const selectedContracts = await readTransactionContractFacts(reads, chainContext, block,
            uniswapV4ContractRoles.map((role) => ({ role, target: addresses[role] })));
          const state = exchangeObservationStateSchema.parse({ inputBalance, outputBalance, nativeBalance, confirmedNonce: nonce.confirmed, pendingNonce: nonce.pending, erc20Allowance, permit2, slot0 });
          const kind = requiredExchangeTransactionKind(intent, state);
          const native = kind === "swap" ? evm.createSwap(intent) : evm.approval(intent, kind);
          const proposed = dynamicFeeTransactionCallSchema.parse({
            type: "2", accessList: [], chainId: productChainId, from: account.address,
            to: native.to, value: native.value, data: native.data, nonce: nonce.confirmed, ...intent.fees,
          });
          const estimate = await transactions.estimateGas(chainContext, block, proposed);
          const gasLimit = previous?.request.gasLimit ?? request.gasLimit ?? estimate;
          if (BigInt(estimate) > BigInt(gasLimit)) throw new ExchangeError("exchange_conditions_unmet");
          if (BigInt(nativeBalance) < BigInt(gasLimit) * BigInt(intent.fees.maxFeePerGas)) throw new ExchangeError("exchange_conditions_unmet");
          const unsigned = admitDynamicFeeTransactionRequest({ ...proposed, gasLimit });
          if (utf8ByteLength(canonicalJsonStringify(captureCanonicalJson(unsigned))) > exchangeLimits.privateRequestUtf8Bytes) {
            throw new ExchangeError("exchange_capacity_exceeded");
          }
          const simulation = await transactions.simulate(chainContext, block, unsigned);
          if (simulation.status !== "returned" || (kind === "erc20_approval" && !decodeAbiBooleanResult(simulation.data))) {
            throw new ExchangeError("exchange_conditions_unmet");
          }
          const fields = {
            operationId: admitted.operationId, createdAt: admitted.createdAt, actionExpiresAt: admitted.actionExpiresAt,
            intent, kind, block: block.anchor,
            connection: {
              revision: initial.connectionRevision, account, expiresAt: connection.expiresAt, method: "eth_sendTransaction",
              source: { kind: "wallet_session", sourceId: session.sourceId, topicDigest: session.topicDigest },
            },
            official: { member, snapshot: projectOfficialAssetSnapshotEvidence(official.snapshot), verification: verified.verification },
            pool: pool.poolKey, displayScaling, state, quote, gasLimit, gasLimitSource: request.gasLimit === undefined ? "estimate" : "user",
            contracts: selectedContracts.map(({ role, facts }) => ({ role, facts })),
            walletRequestCommitment: dynamicFeeRequestCommitment(unsigned), simulation: "returned" as const,
            ...(predecessor === undefined ? {} : { predecessor: predecessor.reference }),
          };
          const result = admitExchangeObservation({ ...fields, semanticCommitment: exchangeSemanticCommitment(fields) });
          if (previous !== undefined) assertUnchangedDecision(previous, result, unsigned);
          assertLive();
          recordExchangeEvidence(result, observations, dependencies, session, selectedContracts);
          privateRequest = unsigned;
          return result;
        });
        return { status: "success" as const, data };
      } catch (error) {
        const code = exchangeFailureCode(error) ??
          (error instanceof UniswapV4UnsupportedIntentError ? "exchange_conditions_unmet" : undefined) ??
          (isContractAnalysisTargetNotFoundError(error) ? "exchange_contract_unavailable" : undefined) ??
          normalizePinnedEvmReadFailure(error, context.signal);
        if (code !== undefined) return { status: "failure" as const, code, issues: [] };
        throw error;
      }
    },
  });
  const result = await new CapabilityBindingRegistry(new CapabilityRegistry([exchangeObservationCapability]), [binding])
    .invoke(exchangeObservationCapability, input, { signal });
  if (!result.ok) return result;
  try {
    assertLive();
    const review = exchangeObservationResultSchema.parse(result);
    if (utf8ByteLength(canonicalJsonStringify(captureCanonicalJson(review))) > requestReviewLimits.reviewUtf8Bytes) {
      return createExchangeFailure("exchange_capacity_exceeded");
    }
    if (privateRequest === undefined) throw new TypeError("The complete exchange observation has no private request.");
    return Object.freeze({ ok: true, review: deepFreezeValue(review), privateRequest });
  } catch (error) {
    const code = exchangeFailureCode(error);
    if (code !== undefined) return createExchangeFailure(code);
    throw error;
  }
};

export const observeExchange = (
  dependencies: ExchangePreparationDependencies,
  input: ExchangeObservationInput,
  signal: AbortSignal,
): Promise<PreparedExchange | ApplicationFailure> => "kind" in input.request
  ? observeFeeReplacement(dependencies, input, signal)
  : captureExchange(dependencies, input, signal);

const same = (left: unknown, right: unknown): boolean =>
  canonicalJsonStringify(captureCanonicalJson(left)) === canonicalJsonStringify(captureCanonicalJson(right));

const assertUnchangedDecision = (
  previous: ExchangeReviewMaterial,
  current: ExchangeObservation,
  request: DynamicFeeTransactionRequest,
): void => {
  const original = previous.review.observation.data;
  if ("replacement" in original) throw new ExchangeError("state_conflict");
  // A newer observation is allowed; a new authorizing condition is not.
  // Analysis digests include their block, so compare the admitted contract facts
  // directly while the original evidence anchor is independently checked above.
  const contracts = (value: ExchangeObservation) => value.contracts.map(({ role, facts }) => {
    const { block: _block, sourceAnalysisDigest: _digest, ...identityAndControls } = facts;
    return { role, ...identityAndControls };
  });
  if (!same(original.intent, current.intent) || original.kind !== current.kind ||
      !same(original.connection, current.connection) || !same(original.official.member, current.official.member) ||
      original.state.confirmedNonce !== current.state.confirmedNonce ||
      original.state.erc20Allowance !== current.state.erc20Allowance ||
      !same(original.predecessor ?? null, current.predecessor ?? null) ||
      !same(original.state.permit2, current.state.permit2) || !same(contracts(original), contracts(current)) ||
      dynamicFeeRequestCommitment(request) !== original.walletRequestCommitment) {
    throw new ExchangeError("state_conflict");
  }
};

export const revalidateExchange = async (
  dependencies: ExchangePreparationDependencies,
  material: ExchangeReviewMaterial,
  signal: AbortSignal,
): Promise<ApplicationFailure | null> => {
  createReviewedRequestReference(material.review, material.request);
  const data = material.review.observation.data;
  if ("replacement" in data) {
    const result = await observeFeeReplacement(dependencies, {
      operationId: data.operationId, createdAt: data.createdAt, actionExpiresAt: data.actionExpiresAt,
      request: { kind: "replace_fees", account: { kind: "address", address: data.intent.account.address },
        transactionHash: data.intent.transactionHash, fees: data.intent.fees },
    }, signal, material);
    return result.ok ? null : result;
  }
  const intent = data.intent;
  const result = await captureExchange(dependencies, {
    operationId: data.operationId, createdAt: data.createdAt, actionExpiresAt: data.actionExpiresAt,
    request: {
      account: { kind: "address", address: intent.account.address }, stockTokenAddress: intent.stockTokenAddress,
      direction: intent.direction, poolId: intent.poolId, deadline: intent.deadline, fees: intent.fees,
      ...(data.gasLimitSource === "user" ? { gasLimit: data.gasLimit } : {}),
      ...(intent.replaces === undefined ? {} : { replaces: intent.replaces }),
      conditions: { basis: intent.basis, inputRelation: intent.inputRelation, inputAmount: intent.input.human,
        outputRelation: intent.outputRelation, outputAmount: intent.output.human },
    },
  }, signal, material);
  return result.ok ? null : result;
};
