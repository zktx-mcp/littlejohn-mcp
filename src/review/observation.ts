import { z } from "zod";
import {
  closedTupleSchema,
  canonicalSha256,
  captureCanonicalJson,
  chainAnchorSchema,
  deepFreezeValue,
  evmAccountIdentitySchema,
  hash32Schema,
  jsonObject,
  operationIdSchema,
  parseHash32,
  productChainId,
  requiredErc8056ObservationSchema,
  sourceReferenceSchema,
  uint256DecimalSchema,
  unsignedDecimalSchema,
  utcTimestampSchema,
  type CanonicalJson,
} from "../core/client.js";
import {
  officialAssetSnapshotEvidenceSchema,
  officialAssetSourceMemberSchema,
  stockFactoryVerificationSchema,
} from "../registry/client.js";
import { transactionContractFactsSchema } from "../intelligence/transaction-contracts.js";
import { getUniswapV4PoolCandidate, uniswapV4PoolKeySchema, uniswapV4ContractAddresses, uniswapV4PermitAllowanceSchema, uniswapV4Slot0Schema } from "../protocols/uniswap-v4/client.js";
import { resolvedExchangeIntentSchema } from "./exchange.js";
import { requestReviewLimits } from "./request-limits.js";
import { pendingReplacementSchema } from "./pending-contract.js";
import { uniswapV4RequiredContractFunctions, uniswapV4ContractRoles } from "../protocols/uniswap-v4/contract-profile.js";

export const exchangeTransactionKindSchema = z.enum(["swap", "erc20_approval", "permit2_approval"]);
export type ExchangeTransactionKind = z.infer<typeof exchangeTransactionKindSchema>;

// This is evidence of the selected transaction permission, not a transport
// projection from which consumers reconstruct Wallet's connection result.
export const exchangeConnectionSchema = jsonObject({
  revision: unsignedDecimalSchema,
  account: evmAccountIdentitySchema,
  expiresAt: utcTimestampSchema,
  method: z.literal("eth_sendTransaction"),
  source: sourceReferenceSchema.refine((value) => value.kind === "wallet_session"),
}).strict();
export const exchangeObservationStateSchema = jsonObject({
  inputBalance: uint256DecimalSchema, outputBalance: uint256DecimalSchema, nativeBalance: uint256DecimalSchema,
  confirmedNonce: uint256DecimalSchema, pendingNonce: uint256DecimalSchema,
  erc20Allowance: uint256DecimalSchema,
  permit2: uniswapV4PermitAllowanceSchema,
  slot0: uniswapV4Slot0Schema,
}).strict();
const observationFields = {
  operationId: operationIdSchema,
  createdAt: utcTimestampSchema,
  actionExpiresAt: utcTimestampSchema,
  intent: resolvedExchangeIntentSchema,
  kind: exchangeTransactionKindSchema,
  block: chainAnchorSchema,
  connection: exchangeConnectionSchema,
  official: jsonObject({
    member: officialAssetSourceMemberSchema,
    snapshot: officialAssetSnapshotEvidenceSchema,
    verification: stockFactoryVerificationSchema,
  }).strict(),
  pool: uniswapV4PoolKeySchema,
  displayScaling: closedTupleSchema([requiredErc8056ObservationSchema, requiredErc8056ObservationSchema]),
  state: exchangeObservationStateSchema,
  quote: jsonObject({ amount: uint256DecimalSchema, quoteGasEstimate: uint256DecimalSchema }).strict(),
  contracts: z.array(jsonObject({ role: z.enum(uniswapV4ContractRoles), facts: transactionContractFactsSchema }).strict()).length(uniswapV4ContractRoles.length),
  gasLimit: uint256DecimalSchema.refine((value) => value !== "0"),
  gasLimitSource: z.enum(["estimate", "user"]),
  walletRequestCommitment: hash32Schema,
  simulation: z.literal("returned"),
  predecessor: pendingReplacementSchema.optional(),
} as const;

const observationWithoutCommitmentSchema = jsonObject(observationFields).strict();
type ObservationFields = z.infer<typeof observationWithoutCommitmentSchema>;
export const exchangeQuoteSatisfiesConditions = (intent: ObservationFields["intent"], quote: ObservationFields["quote"]): boolean => {
  const bound = BigInt(intent.basis === "sent" ? intent.output.raw : intent.input.raw);
  const amount = BigInt(quote.amount);
  const equal = intent.basis === "sent" ? intent.outputRelation === "equal" : intent.inputRelation === "equal";
  return equal ? amount === bound : intent.basis === "sent" ? amount >= bound : amount <= bound;
};
export const requiredExchangeTransactionKind = (
  intent: ObservationFields["intent"], state: ObservationFields["state"],
): ExchangeTransactionKind => {
  const required = BigInt(intent.input.raw);
  if (BigInt(state.erc20Allowance) < required) return "erc20_approval";
  if (BigInt(state.permit2.amount) < required ||
      BigInt(state.permit2.expiration) * 1_000n < BigInt(Date.parse(intent.deadline))) return "permit2_approval";
  return "swap";
};
export const exchangeSemanticCommitment = (input: unknown) => {
  const value = observationWithoutCommitmentSchema.parse(captureCanonicalJson(input));
  return parseHash32(`0x${canonicalSha256({
    digestKind: "exchange_semantic", digestVersion: "1",
    kind: value.kind, intent: value.intent as unknown as CanonicalJson,
    pool: value.pool as unknown as CanonicalJson,
    block: value.block as unknown as CanonicalJson,
    walletRequestCommitment: value.walletRequestCommitment,
    gasLimit: value.gasLimit,
    expectedEffectPolicy: "admitted_native_conditions",
  })}`);
};

export const exchangeObservationSchema = observationWithoutCommitmentSchema.extend({
  semanticCommitment: hash32Schema,
}).strict().superRefine((value, context) => {
  const { semanticCommitment, ...unsigned } = value;
  let pool: ReturnType<typeof getUniswapV4PoolCandidate>;
  try { pool = getUniswapV4PoolCandidate(value.intent.poolId); }
  catch {
    context.addIssue({ code: "custom", message: "Exchange pool is outside admitted coverage." });
    return;
  }
  const connection = value.connection;
  const roles = {
    input_token: value.intent.input.token, output_token: value.intent.output.token,
    permit2: uniswapV4ContractAddresses.permit2, pool_manager: uniswapV4ContractAddresses.poolManager,
    quoter: uniswapV4ContractAddresses.quoter, router: uniswapV4ContractAddresses.router,
    state_view: uniswapV4ContractAddresses.stateView,
  };
  if (value.block.chainId !== productChainId ||
      connection.account.address !== value.intent.account.address || connection.account.chainId !== value.intent.account.chainId ||
      value.official.member.contractAddress !== value.intent.stockTokenAddress ||
      value.official.verification.contractAddress !== value.official.member.contractAddress ||
      value.official.verification.assetUid !== value.official.member.assetUid ||
      canonicalSha256(captureCanonicalJson(value.official.verification.block)) !== canonicalSha256(captureCanonicalJson(value.block)) ||
      (value.intent.replaces === undefined ? value.state.pendingNonce !== value.state.confirmedNonce || value.predecessor !== undefined :
        value.predecessor?.transactionHash !== value.intent.replaces || value.predecessor.nonce !== value.state.confirmedNonce ||
        BigInt(value.state.pendingNonce) < BigInt(value.state.confirmedNonce)) ||
      value.kind !== requiredExchangeTransactionKind(value.intent, value.state) ||
      BigInt(value.state.nativeBalance) < BigInt(value.gasLimit) * BigInt(value.intent.fees.maxFeePerGas) ||
      Date.parse(value.actionExpiresAt) <= Date.parse(value.createdAt) ||
      Date.parse(value.actionExpiresAt) - Date.parse(value.createdAt) > requestReviewLimits.reviewLifetimeMilliseconds ||
      value.actionExpiresAt > value.intent.deadline ||
      value.actionExpiresAt > connection.expiresAt ||
      semanticCommitment !== exchangeSemanticCommitment(unsigned) ||
      canonicalSha256(captureCanonicalJson(pool.poolKey)) !== canonicalSha256(captureCanonicalJson(value.pool))) {
    context.addIssue({ code: "custom", message: "Exchange observation does not preserve the admitted subject or commitments." });
  }
  if (value.contracts.some((entry, index) => entry.role !== uniswapV4ContractRoles[index] ||
      entry.facts.target !== roles[entry.role] ||
      canonicalSha256(captureCanonicalJson(entry.facts.block)) !== canonicalSha256(captureCanonicalJson(value.block)) ||
      entry.facts.functionStatus !== "declared" ||
      canonicalSha256(captureCanonicalJson(entry.facts.requiredFunctions)) !== canonicalSha256(captureCanonicalJson(uniswapV4RequiredContractFunctions[entry.role])))) {
    context.addIssue({ code: "custom", message: "Exchange contract observation scope is invalid." });
  }
  if (value.displayScaling.some((entry, index) => entry.asset.address !== (index === 0 ? value.intent.input.token : value.intent.output.token) ||
      canonicalSha256(captureCanonicalJson(entry.block)) !== canonicalSha256(captureCanonicalJson(value.block)))) {
    context.addIssue({ code: "custom", message: "Exchange display evidence has a different asset or block." });
  }
  const stockRole = value.intent.direction === "buy" ? "output_token" : "input_token";
  if (value.contracts.find(({ role }) => role === stockRole)?.facts.targetRuntimeCode.codeHash !== value.official.verification.tokenCodeHash) {
    context.addIssue({ code: "custom", message: "StockFactory and exchange contract code observations differ." });
  }
  if (!exchangeQuoteSatisfiesConditions(value.intent, value.quote)) {
    context.addIssue({ code: "custom", message: "The quote does not satisfy the selected quantity conditions." });
  }
});
export type ExchangeObservation = z.infer<typeof exchangeObservationSchema>;

export const admitExchangeObservation = (input: unknown): ExchangeObservation =>
  deepFreezeValue(exchangeObservationSchema.parse(captureCanonicalJson(input)));
