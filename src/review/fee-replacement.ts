import {
  CapabilityBindingRegistry, CapabilityRegistry, bindCapability,
  admitDynamicFeeTransactionRequest, canonicalJsonStringify, captureCanonicalJson, deepFreezeValue,
  dynamicFeeRequestCommitment, evmAccountIdentitySchema, parseUtcTimestamp, productUsdgAsset,
  type ApplicationFailure, type DynamicFeeTransactionRequest,
} from "../core/index.js";
import { createErc20CallEncoder, decodeAbiBooleanResult, decodeAbiUint256Result, normalizePinnedEvmReadFailure } from "../chain/index.js";
import { findOfficialAssetMember, projectOfficialAssetSnapshotEvidence } from "../registry/index.js";
import { isContractAnalysisTargetNotFoundError } from "../intelligence/contract-analysis.js";
import { uniswapV4ContractAddresses } from "../protocols/uniswap-v4/client.js";
import { uniswapV4ConditionContracts } from "../protocols/uniswap-v4/contract-profile.js";
import { readTransactionContractFacts } from "./contract-reads.js";
import { captureTransactionSession } from "./session.js";
import { readPendingReplacement } from "./pending-transaction.js";
import { feeReplacementRequestSchema } from "./exchange.js";
import { admitFeeReplacementObservation, assertHigherReplacementFees, replacementSemanticCommitment, type FeeReplacementObservation } from "./replacement-contract.js";
import { exchangeObservationCapability, exchangeObservationResultSchema, type ExchangeObservationInput } from "./observation-contract.js";
import { createExchangeFailure, ExchangeError, exchangeErrorRegistry, exchangeFailureCode } from "./errors.js";
import { recordExchangeEvidence } from "./evidence-recording.js";
import type { ExchangePreparationDependencies, PreparedExchange } from "./preparation.js";
import type { ExchangeReviewMaterial } from "./material-port.js";

const same = (a: unknown, b: unknown): boolean => canonicalJsonStringify(captureCanonicalJson(a)) === canonicalJsonStringify(captureCanonicalJson(b));

export const observeFeeReplacement = async (
  dependencies: ExchangePreparationDependencies,
  input: ExchangeObservationInput,
  signal: AbortSignal,
  previous?: ExchangeReviewMaterial,
): Promise<PreparedExchange | ApplicationFailure> => {
  const request = feeReplacementRequestSchema.parse(input.request);
  let captured: ReturnType<typeof captureTransactionSession>;
  try { captured = captureTransactionSession(dependencies, request.account, input.actionExpiresAt, signal); }
  catch (error) {
    const code = exchangeFailureCode(error);
    if (code !== undefined) return createExchangeFailure(code);
    throw error;
  }
  const { initial, connection, session, assertLive } = captured;
  const account = evmAccountIdentitySchema.parse({ chainId: connection.chainId, address: connection.address });
  let privateRequest: DynamicFeeTransactionRequest | undefined;
  const binding = bindCapability({
    definition: exchangeObservationCapability, errorRegistry: exchangeErrorRegistry,
    invocationAuthority: dependencies.invocationAuthority,
    createInvocationPorts: () => dependencies.createInvocationPorts(session),
    handler: async (_admitted, context, observations) => {
      try {
        assertLive();
        const value = await dependencies.chainInvocations.run(context.signal, async (chainContext) => {
          const { reads, transactions, evm } = dependencies;
          if (previous !== undefined) {
            const old = previous.review.observation.data.block;
            const canonical = await reads.resolveBlock(chainContext, { kind: "number", blockNumber: old.blockNumber });
            if (canonical.anchor.blockHash !== old.blockHash) throw new ExchangeError("state_conflict");
          }
          const block = await reads.resolveBlock(chainContext, { kind: "latest" });
          const pending = await readPendingReplacement(dependencies, chainContext, request.transactionHash, account);
          const nonce = await transactions.nonce(chainContext, block, account.address);
          if (nonce.confirmed !== pending.request.nonce) throw new ExchangeError("exchange_replacement_unavailable");
          try { assertHigherReplacementFees(pending.reference.fees, request.fees); }
          catch { throw new ExchangeError("exchange_replacement_unavailable"); }
          const conditions = pending.conditions;
          const token = conditions.kind === "swap" ? conditions.tokenIn : conditions.token;
          const tokenUnits = [];
          for (const tokenAddress of conditions.kind === "swap" ? [conditions.tokenIn, conditions.tokenOut] : [conditions.token]) {
            const decimals = await reads.readTokenDecimals(chainContext, block, tokenAddress);
            if (decimals.status !== "observed") throw new ExchangeError("exchange_contract_unavailable");
            tokenUnits.push({ asset: { kind: "erc20", chainId: account.chainId, address: tokenAddress }, decimals: decimals.value, block: block.anchor });
          }
          const stockToken = conditions.kind === "swap"
            ? conditions.tokenIn === productUsdgAsset.address ? conditions.tokenOut : conditions.tokenIn
            : token === productUsdgAsset.address ? null : token;
          let official: FeeReplacementObservation["official"] = null;
          if (stockToken !== null) {
            const current = await dependencies.officialAssets.synchronize(context.signal);
            if (current.status === "unavailable") throw new ExchangeError(current.reason);
            const member = findOfficialAssetMember(current.snapshot, stockToken);
            if (member === undefined) throw new ExchangeError("exchange_contract_unavailable");
            const verified = await dependencies.officialAssetReads.verifyAtBlock(member, block, chainContext);
            if (verified.status !== "verified") throw new ExchangeError("exchange_contract_unavailable");
            official = { member, snapshot: projectOfficialAssetSnapshotEvidence(current.snapshot), verification: verified.verification };
          }
          const encoder = await createErc20CallEncoder();
          const call = async (to: typeof token, data: ReturnType<typeof encoder.balanceOf>) => {
            const observed = await reads.call(chainContext, block, { to, data });
            if (observed.status !== "observed") throw new ExchangeError("exchange_conditions_unmet");
            return observed.value;
          };
          const inputBalance = decodeAbiUint256Result(await call(token, encoder.balanceOf(account.address)));
          const nativeBalance = await transactions.balance(chainContext, block, account.address);
          const erc20Allowance = decodeAbiUint256Result(await call(token, evm.erc20Allowance(account.address)));
          const permit2 = evm.decodePermitAllowance(await call(uniswapV4ContractAddresses.permit2, evm.permitAllowance(account.address, token)));
          const selected = await readTransactionContractFacts(reads, chainContext, block, uniswapV4ConditionContracts(conditions));
          const unsigned = admitDynamicFeeTransactionRequest({ ...pending.request, ...request.fees });
          const { gasLimit, ...callWithoutGas } = unsigned;
          const estimate = await transactions.estimateGas(chainContext, block, callWithoutGas);
          if (BigInt(estimate) > BigInt(gasLimit) || BigInt(nativeBalance) < BigInt(gasLimit) * BigInt(unsigned.maxFeePerGas)) {
            throw new ExchangeError("exchange_conditions_unmet");
          }
          const simulation = await transactions.simulate(chainContext, block, unsigned);
          if (simulation.status !== "returned" || (conditions.kind === "erc20_approval" && !decodeAbiBooleanResult(simulation.data))) {
            throw new ExchangeError("exchange_conditions_unmet");
          }
          const actionExpiresAt = pending.deadline === null ? input.actionExpiresAt : parseUtcTimestamp([input.actionExpiresAt, pending.deadline].sort()[0]!);
          if (dependencies.clock.now() >= actionExpiresAt) throw new ExchangeError("review_expired");
          const fields = {
            operationId: input.operationId, createdAt: input.createdAt, actionExpiresAt,
            intent: { kind: "replace_fees" as const, account, transactionHash: request.transactionHash, fees: request.fees },
            kind: conditions.kind, conditions, block: block.anchor,
            connection: { revision: initial.connectionRevision, account, expiresAt: connection.expiresAt, method: "eth_sendTransaction",
              source: { kind: "wallet_session", sourceId: session.sourceId, topicDigest: session.topicDigest } },
            official, state: { inputBalance, nativeBalance, confirmedNonce: nonce.confirmed, pendingNonce: nonce.pending, erc20Allowance, permit2 },
            contracts: selected.map(({ role, facts }) => ({ role, facts })),
            replacement: pending.reference, tokenUnits, gasLimit, walletRequestCommitment: dynamicFeeRequestCommitment(unsigned), simulation: "returned" as const,
          };
          const result = admitFeeReplacementObservation({ ...fields, semanticCommitment: replacementSemanticCommitment(fields) });
          if (previous !== undefined) {
            const old = previous.review.observation.data;
            const contracts = (data: typeof old) => data.contracts.map(({ role, facts }) => {
              const { block: _block, sourceAnalysisDigest: _digest, ...current } = facts;
              return { role, ...current };
            });
            if (!("replacement" in old) || !same(old.intent, result.intent) || !same(old.conditions, result.conditions) ||
                !same(old.connection, result.connection) || !same(old.replacement, result.replacement) ||
                !same(old.tokenUnits.map(({ asset, decimals }) => ({ asset, decimals })), result.tokenUnits.map(({ asset, decimals }) => ({ asset, decimals }))) ||
                !same(contracts(old), contracts(result)) || old.state.erc20Allowance !== result.state.erc20Allowance ||
                !same(old.state.permit2, result.state.permit2) || old.walletRequestCommitment !== result.walletRequestCommitment) {
              throw new ExchangeError("state_conflict");
            }
          }
          assertLive();
          recordExchangeEvidence(result, observations, dependencies, session, selected);
          privateRequest = unsigned;
          return result;
        });
        return { status: "success" as const, data: value };
      } catch (error) {
        const code = exchangeFailureCode(error) ?? (isContractAnalysisTargetNotFoundError(error) ? "exchange_contract_unavailable" : undefined) ??
          normalizePinnedEvmReadFailure(error, context.signal);
        if (code !== undefined) return { status: "failure" as const, code, issues: [] };
        throw error;
      }
    },
  });
  const result = await new CapabilityBindingRegistry(new CapabilityRegistry([exchangeObservationCapability]), [binding])
    .invoke(exchangeObservationCapability, input, { signal });
  if (!result.ok) return result;
  assertLive();
  if (privateRequest === undefined) throw new TypeError("Replacement observation has no exact request.");
  return { ok: true, review: deepFreezeValue(exchangeObservationResultSchema.parse(result)), privateRequest };
};
