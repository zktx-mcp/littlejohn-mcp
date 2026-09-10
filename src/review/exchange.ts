import { z } from "zod";

import {
  addressTargetSchema,
  canonicalJsonStringify,
  canonicalSha256,
  captureCanonicalJson,
  deepFreezeValue,
  evmAccountIdentitySchema,
  evmAddressInputSchema,
  evmAddressSchema,
  hash32Schema,
  humanTokenAmountSchema,
  jsonObject,
  maximumTokenDecimals,
  canonicalUnsignedDecimalMaximumPattern,
  parseHash32,
  parseHumanTokenAmount,
  productChainId,
  productUsdgAsset,
  uint256DecimalSchema,
  utcTimestampSchema,
  utf8ByteLength,
  type CanonicalJson,
  type EvmAccountIdentity,
  type Hash32,
} from "../core/client.js";
import { requestReviewLimits } from "./request-limits.js";
import { uniswapV4ProtocolId } from "../protocols/uniswap-v4/client.js";

export const feeCapsSchema = jsonObject({
  maxFeePerGas: uint256DecimalSchema.describe("Maximum native wei per gas."),
  maxPriorityFeePerGas: uint256DecimalSchema.describe("Maximum priority fee in native wei per gas."),
}).strict().superRefine((fees, context) => {
  if (BigInt(fees.maxPriorityFeePerGas) > BigInt(fees.maxFeePerGas)) {
    context.addIssue({ code: "custom", message: "Priority fee exceeds the maximum gas fee." });
  }
});

const inputConditions = jsonObject({
  basis: z.literal("sent"),
  inputRelation: z.enum(["equal", "at_most"]),
  inputAmount: humanTokenAmountSchema,
  outputRelation: z.enum(["equal", "at_least"]),
  outputAmount: humanTokenAmountSchema,
}).strict();
const outputConditions = inputConditions.extend({ basis: z.literal("received") }).strict();

export const exchangeRequestSchema = jsonObject({
  account: addressTargetSchema,
  stockTokenAddress: evmAddressInputSchema,
  direction: z.enum(["buy", "sell"]),
  poolId: hash32Schema,
  conditions: z.discriminatedUnion("basis", [inputConditions, outputConditions]),
  fees: feeCapsSchema,
  gasLimit: uint256DecimalSchema.refine((value) => value !== "0").optional(),
  replaces: hash32Schema.optional(),
  deadline: utcTimestampSchema.refine(
    (value) => Date.parse(value) >= 0 && value.endsWith(".000Z"),
    "Exchange execution deadline must be a nonnegative whole-second instant.",
  ),
}).strict();
export type ExchangeRequest = z.infer<typeof exchangeRequestSchema>;

export const feeReplacementRequestSchema = jsonObject({
  kind: z.literal("replace_fees"), account: addressTargetSchema,
  transactionHash: hash32Schema, fees: feeCapsSchema,
}).strict();
export type FeeReplacementRequest = z.infer<typeof feeReplacementRequestSchema>;

export const exchangeCommandSchema = z.union([exchangeRequestSchema, feeReplacementRequestSchema]);
export type ExchangeCommand = z.infer<typeof exchangeCommandSchema>;

export const parseExchangeRequest = (input: unknown): ExchangeRequest => {
  const value = captureCanonicalJson(input);
  if (utf8ByteLength(canonicalJsonStringify(value)) > requestReviewLimits.reviewUtf8Bytes) {
    throw new TypeError("Exchange request exceeds its input envelope.");
  }
  return deepFreezeValue(exchangeRequestSchema.parse(value));
};

const tokenDecimalsSchema = z.string().regex(new RegExp(
  canonicalUnsignedDecimalMaximumPattern(maximumTokenDecimals), "u",
));
const exchangeQuantitySchema = jsonObject({
  token: evmAddressSchema,
  decimals: tokenDecimalsSchema,
  human: humanTokenAmountSchema,
  raw: uint256DecimalSchema,
}).strict().superRefine((amount, context) => {
  try {
    if (parseHumanTokenAmount(amount.human, amount.decimals) === amount.raw) return;
  } catch { /* The owning input issue is reported below. */ }
  context.addIssue({ code: "custom", message: "Exchange quantity is not the exact token amount." });
});

export const resolvedExchangeIntentSchema = jsonObject({
  chainId: z.literal(productChainId),
  account: evmAccountIdentitySchema,
  stockTokenAddress: evmAddressSchema,
  direction: z.enum(["buy", "sell"]),
  protocolId: z.literal(uniswapV4ProtocolId),
  poolId: hash32Schema,
  basis: z.enum(["sent", "received"]),
  inputRelation: z.enum(["equal", "at_most"]),
  outputRelation: z.enum(["equal", "at_least"]),
  input: exchangeQuantitySchema,
  output: exchangeQuantitySchema,
  fees: feeCapsSchema,
  replaces: hash32Schema.optional(),
  deadline: utcTimestampSchema,
}).strict().superRefine((intent, context) => {
  const inputToken = intent.direction === "buy" ? productUsdgAsset.address : intent.stockTokenAddress;
  const outputToken = intent.direction === "buy" ? intent.stockTokenAddress : productUsdgAsset.address;
  if (intent.account.chainId !== productChainId || intent.stockTokenAddress === productUsdgAsset.address ||
      intent.input.token !== inputToken || intent.output.token !== outputToken || intent.input.raw === "0" ||
      (intent.output.raw === "0" && (intent.basis === "received" || intent.outputRelation === "equal"))) {
    context.addIssue({ code: "custom", message: "Exchange account, direction or token identity is inconsistent." });
  }
});
export type ResolvedExchangeIntent = z.infer<typeof resolvedExchangeIntentSchema>;

export const resolveExchangeIntent = (input: {
  readonly request: ExchangeRequest;
  readonly account: EvmAccountIdentity;
  readonly inputDecimals: string;
  readonly outputDecimals: string;
}): ResolvedExchangeIntent => {
  const request = parseExchangeRequest(input.request);
  const account = evmAccountIdentitySchema.parse(input.account);
  if (request.account.kind === "address" && request.account.address !== account.address) {
    throw new TypeError("Resolved account differs from the selected account.");
  }
  const inputToken = request.direction === "buy" ? productUsdgAsset.address : request.stockTokenAddress;
  const outputToken = request.direction === "buy" ? request.stockTokenAddress : productUsdgAsset.address;
  return deepFreezeValue(resolvedExchangeIntentSchema.parse({
    chainId: productChainId,
    account,
    stockTokenAddress: request.stockTokenAddress,
    direction: request.direction,
    protocolId: uniswapV4ProtocolId,
    poolId: request.poolId,
    basis: request.conditions.basis,
    inputRelation: request.conditions.inputRelation,
    outputRelation: request.conditions.outputRelation,
    input: {
      token: inputToken, decimals: input.inputDecimals, human: request.conditions.inputAmount,
      raw: parseHumanTokenAmount(request.conditions.inputAmount, input.inputDecimals),
    },
    output: {
      token: outputToken, decimals: input.outputDecimals, human: request.conditions.outputAmount,
      raw: parseHumanTokenAmount(request.conditions.outputAmount, input.outputDecimals),
    },
    fees: request.fees,
    ...(request.replaces === undefined ? {} : { replaces: request.replaces }),
    deadline: request.deadline,
  }));
};

export const exchangeIntentCommitment = (input: unknown): Hash32 => {
  const intent = resolvedExchangeIntentSchema.parse(captureCanonicalJson(input));
  return parseHash32(`0x${canonicalSha256({
    digestKind: "exchange_intent", digestVersion: "1", intent: intent as unknown as CanonicalJson,
  })}`);
};
