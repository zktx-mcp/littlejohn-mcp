import { pendingReplacementSchema } from "./pending-contract.js";
import { z } from "zod";
import {canonicalSha256, captureCanonicalJson, deepFreezeValue, hash32Schema, jsonObject, operationIdSchema, parseHash32, utcTimestampSchema, type CanonicalJson} from "../core/client.js";
import {chainAnchorSchema} from "../evm/primitives.js";
import {evmAccountIdentitySchema} from "../evm/identities.js";
import {erc20AssetIdentitySchema, canonicalUnsignedDecimalMaximumPattern, maximumTokenDecimals, uint256DecimalSchema} from "../evm/amounts.js";
import {productChainId} from "../registry/product-identity.js";
import {productUsdgAsset} from "../registry/product-assets.js";
import { transactionContractFactsSchema } from "../intelligence/transaction-contracts.js";
import { officialAssetSnapshotEvidenceSchema, officialAssetSourceMemberSchema, stockFactoryVerificationSchema } from "../registry/client.js";
import { uniswapV4ExpectedEffectSchema } from "../protocols/uniswap-v4/effects.js";
import { uniswapV4ContractRoles, uniswapV4ConditionContracts, uniswapV4RequiredContractFunctions } from "../protocols/uniswap-v4/contract-profile.js";
import { uniswapV4PermitAllowanceSchema } from "../protocols/uniswap-v4/client.js";
import { feeCapsSchema } from "./exchange.js";
import { exchangeConnectionSchema, exchangeTransactionKindSchema } from "./observation.js";
import { requestReviewLimits } from "./request-limits.js";

const fields = {
  operationId: operationIdSchema, createdAt: utcTimestampSchema, actionExpiresAt: utcTimestampSchema,
  intent: jsonObject({ kind: z.literal("replace_fees"), account: evmAccountIdentitySchema,
    transactionHash: hash32Schema, fees: feeCapsSchema }).strict(),
  kind: exchangeTransactionKindSchema, block: chainAnchorSchema,
  connection: exchangeConnectionSchema,
  official: jsonObject({ member: officialAssetSourceMemberSchema, snapshot: officialAssetSnapshotEvidenceSchema,
    verification: stockFactoryVerificationSchema }).strict().nullable(),
  state: jsonObject({ inputBalance: uint256DecimalSchema, nativeBalance: uint256DecimalSchema,
    confirmedNonce: uint256DecimalSchema, pendingNonce: uint256DecimalSchema,
    erc20Allowance: uint256DecimalSchema, permit2: uniswapV4PermitAllowanceSchema }).strict(),
  contracts: z.array(jsonObject({ role: z.enum(uniswapV4ContractRoles), facts: transactionContractFactsSchema }).strict())
    .min(1).max(uniswapV4ContractRoles.length),
  replacement: pendingReplacementSchema, conditions: uniswapV4ExpectedEffectSchema,
  tokenUnits: z.array(jsonObject({ asset: erc20AssetIdentitySchema,
    decimals: z.string().regex(new RegExp(canonicalUnsignedDecimalMaximumPattern(maximumTokenDecimals), "u")),
    block: chainAnchorSchema }).strict()).min(1).max(2),
  gasLimit: uint256DecimalSchema.refine((value) => value !== "0"),
  walletRequestCommitment: hash32Schema, simulation: z.literal("returned"),
} as const;
const unsignedSchema = jsonObject(fields).strict();
export const replacementSemanticCommitment = (input: unknown) => {
  const value = unsignedSchema.parse(captureCanonicalJson(input));
  return parseHash32(`0x${canonicalSha256({ digestKind: "fee_replacement_semantic", digestVersion: "1",
    account: value.intent.account as unknown as CanonicalJson, original: value.replacement as unknown as CanonicalJson,
    conditions: value.conditions as unknown as CanonicalJson, block: value.block as unknown as CanonicalJson,
    walletRequestCommitment: value.walletRequestCommitment,
  })}`);
};
export const feeReplacementObservationSchema = unsignedSchema.extend({ semanticCommitment: hash32Schema }).strict()
  .superRefine((value, context) => {
    const { semanticCommitment, ...unsigned } = value;
    const account = value.intent.account;
    if (account.chainId !== productChainId || value.block.chainId !== account.chainId ||
        value.connection.account.chainId !== account.chainId || value.connection.account.address !== account.address ||
        value.intent.transactionHash !== value.replacement.transactionHash || value.state.confirmedNonce !== value.replacement.nonce ||
        BigInt(value.state.pendingNonce) < BigInt(value.state.confirmedNonce) || value.gasLimit !== value.replacement.gasLimit ||
        value.kind !== value.conditions.kind || semanticCommitment !== replacementSemanticCommitment(unsigned) ||
        Date.parse(value.actionExpiresAt) <= Date.parse(value.createdAt) || value.actionExpiresAt > value.connection.expiresAt ||
        Date.parse(value.actionExpiresAt) - Date.parse(value.createdAt) > requestReviewLimits.reviewLifetimeMilliseconds ||
        BigInt(value.state.nativeBalance) < BigInt(value.gasLimit) * BigInt(value.intent.fees.maxFeePerGas)) {
      context.addIssue({ code: "custom", message: "Fee replacement observation does not preserve its subject or commitment." });
    }
    try { assertHigherReplacementFees(value.replacement.fees, value.intent.fees); }
    catch { context.addIssue({ code: "custom", message: "Replacement fees do not increase the selected envelope." }); }
    const targets = uniswapV4ConditionContracts(value.conditions);
    const same = (a: unknown, b: unknown) => canonicalSha256(captureCanonicalJson(a)) === canonicalSha256(captureCanonicalJson(b));
    if (value.contracts.length !== targets.length || value.contracts.some((entry, index) =>
      entry.role !== targets[index]?.role || entry.facts.target !== targets[index]?.target ||
      !same(entry.facts.block, value.block) || entry.facts.functionStatus !== "declared" ||
      !same(entry.facts.requiredFunctions, uniswapV4RequiredContractFunctions[entry.role]))) {
      context.addIssue({ code: "custom", message: "Replacement contract observations have incomplete native coverage." });
    }
    const deadline = value.conditions.kind === "swap" ? value.conditions.deadline :
      value.conditions.kind === "permit2_approval" ? value.conditions.expiration : null;
    if (deadline !== null && value.actionExpiresAt > deadline) context.addIssue({ code: "custom", message: "Review exceeds the pending call's expiration." });
    if (value.conditions.kind === "swap" && (value.conditions.payer !== account.address || value.conditions.recipient !== account.address)) {
      context.addIssue({ code: "custom", message: "Replacement swap differs from the selected account." });
    }
    const token = value.conditions.kind === "swap"
      ? value.conditions.tokenIn === productUsdgAsset.address ? value.conditions.tokenOut : value.conditions.tokenIn
      : value.conditions.token;
    if (token === productUsdgAsset.address ? value.official !== null : value.official?.member.contractAddress !== token) {
      context.addIssue({ code: "custom", message: "The action's Stock Token requires its own official attribution." });
    }
    const tokens = value.conditions.kind === "swap" ? [value.conditions.tokenIn, value.conditions.tokenOut] : [value.conditions.token];
    if (tokens.length !== value.tokenUnits.length || value.tokenUnits.some((unit, index) =>
      unit.asset.chainId !== value.block.chainId || unit.asset.address !== tokens[index] || !same(unit.block, value.block))) {
      context.addIssue({ code: "custom", message: "Replacement amounts require current token units at the observation block." });
    }
    if (value.official !== null && (!same(value.official.verification.block, value.block) ||
      value.official.member.assetUid !== value.official.verification.assetUid ||
      value.official.member.contractAddress !== value.official.verification.contractAddress ||
      !value.contracts.some((entry) => entry.facts.target === value.official!.member.contractAddress &&
        entry.facts.targetRuntimeCode.codeHash === value.official!.verification.tokenCodeHash))) {
      context.addIssue({ code: "custom", message: "Replacement StockFactory attribution is inconsistent." });
    }
  });
export type FeeReplacementObservation = z.infer<typeof feeReplacementObservationSchema>;
export const admitFeeReplacementObservation = (value: unknown): FeeReplacementObservation =>
  deepFreezeValue(feeReplacementObservationSchema.parse(captureCanonicalJson(value)));

export const assertHigherReplacementFees = (previous: z.infer<typeof feeCapsSchema>, current: z.infer<typeof feeCapsSchema>): void => {
  const oldFees = feeCapsSchema.parse(previous);
  const newFees = feeCapsSchema.parse(current);
  if (BigInt(newFees.maxFeePerGas) < BigInt(oldFees.maxFeePerGas) ||
      BigInt(newFees.maxPriorityFeePerGas) < BigInt(oldFees.maxPriorityFeePerGas) ||
      (newFees.maxFeePerGas === oldFees.maxFeePerGas && newFees.maxPriorityFeePerGas === oldFees.maxPriorityFeePerGas)) {
    throw new TypeError("Replacement fees must increase without reducing either cap.");
  }
};
