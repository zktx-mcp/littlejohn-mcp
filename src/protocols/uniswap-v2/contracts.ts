import { uniswapProtocolFamily } from "../uniswap.js";
import { z } from "zod";

import {assertContractAnalysisForTarget, contractAnalysisSchema, contractRuntimeCodeIdentitySchema, type ContractAnalysis} from "../../intelligence/analysis-contract.js";
import {blockSelectorSchema, chainAnchorSchema} from "../../evm/primitives.js";
import {captureCanonicalJson, canonicalJsonStringify, exactRationalSchema, jsonObject} from "../../core/client.js";
import {canonicalUnsignedBigIntMaximumPattern, canonicalUnsignedDecimalMaximumPattern, erc20AssetIdentitySchema, maximumTokenDecimals, uint256DecimalSchema, type Erc20AssetIdentity} from "../../evm/amounts.js";
import {defineEvmReadCapability} from "../../evm/capability.js";
import {evmAddressSchema} from "../../evm/identities.js";
import {productChainId} from "../../registry/client.js";
import {
  uniswapV2DeploymentIdentity,
  uniswapV2DeploymentSource,
  uniswapV2DeploymentSourceSchema,
  uniswapV2FactoryAddress,
  uniswapV2FactoryRuntimeCodeIdentity,
  uniswapV2PairInitCodeHash,
  uniswapV2ProtocolId,
  uniswapV2QuoteCapabilityId,
  uniswapV2RouteAssets,
  uniswapV2RouteCoverageBasis,
  uniswapV2RouteAssetSource,
  uniswapV2RouteAssetSourceSchema,
  uniswapV2SdkDependencies,
} from "./deployment.js";
import { uniswapV2QuoteEvidence } from "./evidence.js";
import {
  calculateUniswapV2AmountOut,
  calculateUniswapV2Prices,
  computeUniswapV2PairAddress,
  constructUniswapV2CandidatePaths,
  orderedTokenAddresses,
  uniswapV2FeeRate,
} from "./quote.js";

const uint112Maximum = (1n << 112n) - 1n;
const priceImpactComponentMaximum = uint112Maximum ** 2n * ((1n << 256n) - 1n);
const zeroAddress = "0x0000000000000000000000000000000000000000" as const;

const tokenDecimalsSchema = z.string()
  .regex(
    new RegExp(canonicalUnsignedDecimalMaximumPattern(maximumTokenDecimals), "u"),
    "Token decimals must be an ERC-20 uint8 decimal value.",
  );
const reserveSchema = z.string()
  .regex(
    new RegExp(canonicalUnsignedBigIntMaximumPattern(uint112Maximum), "u"),
    "V2 reserves must be canonical uint112 decimal values.",
  );
const positiveUint256DecimalSchema = uint256DecimalSchema.refine(
  (value) => value !== "0",
  "V2 quote input must be positive.",
);
const positiveOutputSchema = uint256DecimalSchema.refine(
  (value) => value !== "0",
  "V2 quote output must be positive.",
);

export const uniswapV2AssetSchema = erc20AssetIdentitySchema.refine(
  (value) => value.chainId === productChainId,
  "V2 assets must belong to the supported chain.",
);

export const uniswapV2QuoteInputSchema = jsonObject({
  tokenIn: uniswapV2AssetSchema,
  tokenOut: uniswapV2AssetSchema,
  factory: evmAddressSchema,
  amountIn: positiveUint256DecimalSchema,
  block: blockSelectorSchema,
}).strict().superRefine((value, context) => {
  if (value.tokenIn.address === value.tokenOut.address) {
    context.addIssue({ code: "custom", message: "V2 quote endpoints must be distinct." });
  }
  if (value.factory !== uniswapV2FactoryAddress) {
    context.addIssue({ code: "custom", message: "V2 quote factory is not registered." });
  }
});
export type UniswapV2QuoteInput = z.infer<typeof uniswapV2QuoteInputSchema>;

const observedDecimalsSchema = jsonObject({
  status: z.literal("observed"),
  value: tokenDecimalsSchema,
}).strict();
const unavailableDecimalsSchema = jsonObject({
  status: z.literal("unavailable"),
  reason: z.literal("call_reverted"),
}).strict();
const notObservedDecimalsSchema = jsonObject({
  status: z.literal("not_observed"),
}).strict();
export const uniswapV2TokenDecimalsSchema = z.discriminatedUnion("status", [
  observedDecimalsSchema,
  unavailableDecimalsSchema,
  notObservedDecimalsSchema,
]);
export type UniswapV2TokenDecimals = z.infer<typeof uniswapV2TokenDecimalsSchema>;

const evaluatedTokenSchema = jsonObject({
  asset: uniswapV2AssetSchema,
  decimals: uniswapV2TokenDecimalsSchema,
}).strict();
export type UniswapV2EvaluatedToken = z.infer<typeof evaluatedTokenSchema>;

const feeRateValueSchema = jsonObject({
  numerator: z.literal(uniswapV2FeeRate.numerator),
  denominator: z.literal(uniswapV2FeeRate.denominator),
}).strict();

const pairObservationSchema = jsonObject({
  pairAddress: evmAddressSchema,
  runtimeCode: contractRuntimeCodeIdentitySchema,
  factory: evmAddressSchema,
  token0: evmAddressSchema,
  token1: evmAddressSchema,
  reserve0: reserveSchema,
  reserve1: reserveSchema,
}).strict();

const evaluatedHopBase = {
  tokenIn: evaluatedTokenSchema,
  tokenOut: evaluatedTokenSchema,
  factoryResult: evmAddressSchema,
  amountIn: positiveUint256DecimalSchema,
} as const;

const completedHopSchema = jsonObject({
  ...evaluatedHopBase,
  status: z.literal("completed"),
  pair: pairObservationSchema,
  amountOut: positiveOutputSchema,
  feeRate: feeRateValueSchema,
}).strict();
const pairAbsentHopSchema = jsonObject({
  ...evaluatedHopBase,
  status: z.literal("pair_absent"),
}).strict();
const zeroLiquidityHopSchema = jsonObject({
  ...evaluatedHopBase,
  status: z.literal("zero_liquidity"),
  pair: pairObservationSchema,
  feeRate: feeRateValueSchema,
}).strict();
const amountTooSmallHopSchema = jsonObject({
  ...evaluatedHopBase,
  status: z.literal("amount_too_small"),
  pair: pairObservationSchema,
  amountOut: z.literal("0"),
  feeRate: feeRateValueSchema,
}).strict();
const arithmeticOverflowHopSchema = jsonObject({
  ...evaluatedHopBase,
  status: z.literal("arithmetic_overflow"),
  pair: pairObservationSchema,
  feeRate: feeRateValueSchema,
}).strict();

export const uniswapV2EvaluatedHopSchema = z.discriminatedUnion("status", [
  completedHopSchema,
  pairAbsentHopSchema,
  zeroLiquidityHopSchema,
  amountTooSmallHopSchema,
  arithmeticOverflowHopSchema,
]);
export type UniswapV2EvaluatedHop = z.infer<typeof uniswapV2EvaluatedHopSchema>;

const nonnegativeImpactComponentSchema = z.string().regex(
  new RegExp(
    canonicalUnsignedBigIntMaximumPattern(priceImpactComponentMaximum),
    "u",
  ),
  "V2 price-impact component is outside the derived bound.",
);
export const uniswapV2PriceImpactSchema = jsonObject({
  numerator: nonnegativeImpactComponentSchema,
  denominator: nonnegativeImpactComponentSchema.refine(
    (value) => value !== "0",
    "V2 price-impact denominator must be positive.",
  ),
}).strict().superRefine((value, context) => {
  let left = BigInt(value.numerator);
  let right = BigInt(value.denominator);
  while (right !== 0n) [left, right] = [right, left % right];
  if (left !== 1n) {
    context.addIssue({ code: "custom", message: "V2 price impact must be reduced." });
  }
  if (value.numerator === "0" && value.denominator !== "1") {
    context.addIssue({ code: "custom", message: "Zero V2 price impact must be 0/1." });
  }
});

const sdkMatchedSchema = jsonObject({
  status: z.literal("matched"),
  sdkCoreVersion: z.literal(uniswapV2SdkDependencies.sdkCore.version),
  v2SdkVersion: z.literal(uniswapV2SdkDependencies.v2Sdk.version),
}).strict();
const sdkUnavailableSchema = jsonObject({
  status: z.literal("not_available"),
  reason: z.enum([
    "intermediary_decimals_unavailable",
    "token_decimals_outside_sdk_range",
  ]),
}).strict();
export const uniswapV2SdkCheckSchema = z.discriminatedUnion("status", [
  sdkMatchedSchema,
  sdkUnavailableSchema,
]);
export type UniswapV2SdkCheck = z.infer<typeof uniswapV2SdkCheckSchema>;

const candidatePathSchema = z.array(uniswapV2AssetSchema).min(2).max(3);
const evaluatedHopsSchema = z.array(uniswapV2EvaluatedHopSchema).min(1).max(2);

const quotedCandidateSchema = jsonObject({
  status: z.literal("quoted"),
  path: candidatePathSchema,
  evaluatedHops: evaluatedHopsSchema,
  amountOut: positiveOutputSchema,
  midPrice: exactRationalSchema,
  executionPrice: exactRationalSchema,
  priceImpact: uniswapV2PriceImpactSchema,
  sdkCheck: uniswapV2SdkCheckSchema,
}).strict();
const nonQuotedCandidateSchema = jsonObject({
  status: z.enum([
    "pair_absent",
    "zero_liquidity",
    "amount_too_small",
    "arithmetic_overflow",
  ]),
  path: candidatePathSchema,
  evaluatedHops: evaluatedHopsSchema,
}).strict();
export const uniswapV2CandidateSchema = z.discriminatedUnion("status", [
  quotedCandidateSchema,
  nonQuotedCandidateSchema,
]);
export type UniswapV2Candidate = z.infer<typeof uniswapV2CandidateSchema>;

const deploymentSchema = jsonObject({
  chainId: z.literal(productChainId),
  factory: z.literal(uniswapV2FactoryAddress),
  runtimeCode: contractRuntimeCodeIdentitySchema,
  analysis: contractAnalysisSchema,
  pairInitCodeHash: z.literal(uniswapV2PairInitCodeHash),
  source: uniswapV2DeploymentSourceSchema,
}).strict();

const coverageSchema = jsonObject({
  basis: z.literal(uniswapV2RouteCoverageBasis),
  routeAssets: z.array(evmAddressSchema).length(uniswapV2RouteAssets.length),
  source: uniswapV2RouteAssetSourceSchema,
}).strict();

export const uniswapV2QuoteDataSchema = jsonObject({
  protocol: jsonObject({
    familyId: z.literal(uniswapProtocolFamily.familyId),
    protocolId: z.literal(uniswapV2ProtocolId),
  }).strict(),
  deployment: deploymentSchema,
  block: chainAnchorSchema,
  input: jsonObject({
    tokenIn: uniswapV2AssetSchema,
    tokenOut: uniswapV2AssetSchema,
    tokenInDecimals: tokenDecimalsSchema,
    tokenOutDecimals: tokenDecimalsSchema,
    factory: z.literal(uniswapV2FactoryAddress),
    amountIn: positiveUint256DecimalSchema,
  }).strict(),
  candidates: z.array(uniswapV2CandidateSchema)
    .min(1)
    .max(uniswapV2RouteAssets.length + 1),
  coverage: coverageSchema,
}).strict();
export type UniswapV2QuoteData = z.infer<typeof uniswapV2QuoteDataSchema>;

const canonicalEqual = (left: unknown, right: unknown): boolean =>
  canonicalJsonStringify(captureCanonicalJson(left)) ===
  canonicalJsonStringify(captureCanonicalJson(right));

const assertTokenDecimals = (
  actual: UniswapV2TokenDecimals,
  expected: UniswapV2TokenDecimals,
): void => {
  if (!canonicalEqual(actual, expected)) {
    throw new TypeError("V2 token decimals are inconsistent.");
  }
};

const pairDirection = (
  hop: Exclude<UniswapV2EvaluatedHop, { status: "pair_absent" }>,
): Readonly<{ reserveIn: bigint; reserveOut: bigint }> => {
  const [token0, token1] = orderedTokenAddresses(
    hop.tokenIn.asset.address,
    hop.tokenOut.asset.address,
  );
  if (
    hop.factoryResult !== hop.pair.pairAddress ||
    hop.pair.factory !== uniswapV2FactoryAddress ||
    hop.pair.token0 !== token0 ||
    hop.pair.token1 !== token1
  ) {
    throw new TypeError("V2 pair identity is inconsistent.");
  }
  const reserve0 = BigInt(hop.pair.reserve0);
  const reserve1 = BigInt(hop.pair.reserve1);
  return hop.tokenIn.asset.address === token0
    ? { reserveIn: reserve0, reserveOut: reserve1 }
    : { reserveIn: reserve1, reserveOut: reserve0 };
};

const assertHop = (
  hop: UniswapV2EvaluatedHop,
  expectedInput: Erc20AssetIdentity,
  expectedOutput: Erc20AssetIdentity,
  expectedAmountIn: bigint,
): bigint | null => {
  if (
    !canonicalEqual(hop.tokenIn.asset, expectedInput) ||
    !canonicalEqual(hop.tokenOut.asset, expectedOutput) ||
    BigInt(hop.amountIn) !== expectedAmountIn
  ) {
    throw new TypeError("V2 evaluated hop is not contiguous.");
  }
  const expectedPair = computeUniswapV2PairAddress({
    factory: uniswapV2FactoryAddress,
    tokenA: expectedInput.address,
    tokenB: expectedOutput.address,
    pairInitCodeHash: uniswapV2PairInitCodeHash,
  });
  if (hop.status === "pair_absent") {
    if (hop.factoryResult !== zeroAddress) {
      throw new TypeError("V2 absent pair has a nonzero factory result.");
    }
    return null;
  }
  if (hop.factoryResult !== expectedPair) {
    throw new TypeError("V2 pair address differs from the CREATE2 identity.");
  }
  const direction = pairDirection(hop);
  const calculated = calculateUniswapV2AmountOut({
    amountIn: expectedAmountIn,
    ...direction,
  });
  const expectedStatus = calculated.status === "quoted"
    ? "completed"
    : calculated.status;
  if (expectedStatus !== hop.status) {
    throw new TypeError("V2 hop state differs from exact arithmetic.");
  }
  if (
    calculated.status === "quoted" &&
    hop.status === "completed" &&
    hop.amountOut !== calculated.amountOut.toString(10)
  ) {
    throw new TypeError("V2 hop output differs from exact arithmetic.");
  }
  if (
    calculated.status === "amount_too_small" &&
    hop.status === "amount_too_small" &&
    hop.amountOut !== "0"
  ) {
    throw new TypeError("V2 zero hop output is inconsistent.");
  }
  return calculated.status === "quoted" ? calculated.amountOut : null;
};

const endpointDecimals = (
  data: UniswapV2QuoteData,
  asset: Erc20AssetIdentity,
): UniswapV2TokenDecimals | undefined =>
  asset.address === data.input.tokenIn.address
    ? { status: "observed", value: data.input.tokenInDecimals }
    : asset.address === data.input.tokenOut.address
      ? { status: "observed", value: data.input.tokenOutDecimals }
      : undefined;

const assertCandidate = (
  data: UniswapV2QuoteData,
  candidate: UniswapV2Candidate,
  expectedPath: readonly Erc20AssetIdentity[],
): void => {
  if (!canonicalEqual(candidate.path, expectedPath)) {
    throw new TypeError("V2 candidate path is inconsistent.");
  }
  const expectedHopCount = expectedPath.length - 1;
  if (
    candidate.evaluatedHops.length > expectedHopCount ||
    (candidate.status === "quoted" &&
      candidate.evaluatedHops.length !== expectedHopCount)
  ) {
    throw new TypeError("V2 evaluated-hop coverage is inconsistent.");
  }
  let amount = BigInt(data.input.amountIn);
  const reserves: { reserveIn: bigint; reserveOut: bigint }[] = [];
  const decimalsByAddress = new Map<string, UniswapV2TokenDecimals>();
  for (let index = 0; index < candidate.evaluatedHops.length; index += 1) {
    const hop = candidate.evaluatedHops[index];
    const tokenIn = expectedPath[index];
    const tokenOut = expectedPath[index + 1];
    if (hop === undefined || tokenIn === undefined || tokenOut === undefined) {
      throw new TypeError("V2 evaluated hop is outside its path.");
    }
    for (const token of [hop.tokenIn, hop.tokenOut]) {
      const expected = endpointDecimals(data, token.asset);
      if (expected !== undefined) {
        assertTokenDecimals(token.decimals, expected);
      } else if (
        (candidate.status === "quoted" &&
          token.decimals.status === "not_observed") ||
        (candidate.status !== "quoted" &&
          token.decimals.status !== "not_observed")
      ) {
        throw new TypeError("V2 intermediary decimals do not match candidate evaluation.");
      }
      const previous = decimalsByAddress.get(token.asset.address);
      if (previous !== undefined) {
        assertTokenDecimals(token.decimals, previous);
      } else {
        decimalsByAddress.set(token.asset.address, token.decimals);
      }
    }
    const next = assertHop(hop, tokenIn, tokenOut, amount);
    const last = index === candidate.evaluatedHops.length - 1;
    if (hop.status !== "completed") {
      if (!last || candidate.status !== hop.status) {
        throw new TypeError("V2 terminal hop and candidate state are inconsistent.");
      }
      return;
    }
    reserves.push(pairDirection(hop));
    amount = next as bigint;
    if (last && candidate.status !== "quoted") {
      throw new TypeError("V2 non-quoted candidate omits its terminal hop.");
    }
  }
  if (candidate.status !== "quoted") {
    throw new TypeError("V2 non-quoted candidate has no terminal hop.");
  }
  if (candidate.amountOut !== amount.toString(10)) {
    throw new TypeError("V2 candidate output is inconsistent.");
  }
  const prices = calculateUniswapV2Prices({
    amountIn: BigInt(data.input.amountIn),
    amountOut: amount,
    reserves,
  });
  if (
    !canonicalEqual(candidate.executionPrice, prices.executionPrice) ||
    !canonicalEqual(candidate.midPrice, prices.midPrice) ||
    !canonicalEqual(candidate.priceImpact, prices.priceImpact)
  ) {
    throw new TypeError("V2 candidate price calculation is inconsistent.");
  }
  const tokenStates = candidate.evaluatedHops.flatMap((hop) => [
    hop.tokenIn.decimals,
    hop.tokenOut.decimals,
  ]);
  const hasOutsideRange = tokenStates.some(
    (state) => state.status === "observed" && state.value === "255",
  );
  const hasUnavailableIntermediary = candidate.evaluatedHops.some((hop) =>
    [hop.tokenIn, hop.tokenOut].some((token) =>
      endpointDecimals(data, token.asset) === undefined &&
      token.decimals.status === "unavailable"));
  if (
    candidate.sdkCheck.status === "matched" &&
    (hasOutsideRange || hasUnavailableIntermediary)
  ) {
    throw new TypeError("V2 SDK match is inconsistent with token decimals.");
  }
  if (
    candidate.sdkCheck.status === "not_available" &&
    !(
      (candidate.sdkCheck.reason === "token_decimals_outside_sdk_range" &&
        hasOutsideRange) ||
      (candidate.sdkCheck.reason === "intermediary_decimals_unavailable" &&
        hasUnavailableIntermediary &&
        !hasOutsideRange)
    )
  ) {
    throw new TypeError("V2 SDK unavailability reason is inconsistent.");
  }
};

export const assertUniswapV2QuoteData = (data: UniswapV2QuoteData): void => {
  if (
    !canonicalEqual(data.deployment.source, uniswapV2DeploymentSource) ||
    !canonicalEqual(data.coverage.source, uniswapV2RouteAssetSource) ||
    !canonicalEqual(
      data.coverage.routeAssets,
      uniswapV2RouteAssets.map((asset) => asset.address),
    ) ||
    data.deployment.chainId !== uniswapV2DeploymentIdentity.chainId ||
    data.deployment.factory !== uniswapV2DeploymentIdentity.address ||
    data.deployment.pairInitCodeHash !== uniswapV2PairInitCodeHash ||
    !canonicalEqual(
      data.deployment.runtimeCode,
      uniswapV2FactoryRuntimeCodeIdentity,
    ) ||
    data.block.chainId !== productChainId
  ) {
    throw new TypeError("V2 deployment or coverage identity is inconsistent.");
  }
  assertContractAnalysisForTarget({
    chainId: productChainId,
    address: uniswapV2FactoryAddress,
    block: data.block,
    runtimeCode: data.deployment.runtimeCode,
  }, data.deployment.analysis as ContractAnalysis);
  const paths = constructUniswapV2CandidatePaths(
    data.input.tokenIn,
    data.input.tokenOut,
    uniswapV2RouteAssets,
  );
  if (data.candidates.length !== paths.length) {
    throw new TypeError("V2 candidate coverage is incomplete.");
  }
  for (let index = 0; index < paths.length; index += 1) {
    const candidate = data.candidates[index];
    const path = paths[index];
    if (candidate === undefined || path === undefined) {
      throw new TypeError("V2 candidate order is incomplete.");
    }
    assertCandidate(data, candidate, path);
  }
};

export const uniswapV2QuoteCapability = defineEvmReadCapability<
  UniswapV2QuoteInput,
  UniswapV2QuoteData
>({
  capabilityId: uniswapV2QuoteCapabilityId,
  contractVersion: "1",
  inputSchema: uniswapV2QuoteInputSchema,
  dataSchema: uniswapV2QuoteDataSchema,
  failureCodes: [
    "chain_response_unavailable",
    "internal_error",
    "invalid_input",
    "not_found",
    "rate_limited",
    "request_aborted",
    "result_too_large",
    "runtime_busy",
    "runtime_state_unavailable",
    "source_inconsistent",
    "source_unavailable",
    "token_decimals_unavailable",
  ],
  evidence: uniswapV2QuoteEvidence,
  validateIntrinsicData: (data, context) => {
    for (const exclusion of uniswapV2QuoteEvidence.staticScopeExclusions) {
      context.assertDeclaredScopeExclusion(exclusion);
    }
    assertUniswapV2QuoteData(data);
  },
  validateSuccess: (data, context) => {
    if (data.block.chainId !== context.chainId) {
      throw new TypeError("V2 quote chain scope is inconsistent.");
    }
  },
  validateRequest: (input, data) => {
    if (
      !canonicalEqual(input.tokenIn, data.input.tokenIn) ||
      !canonicalEqual(input.tokenOut, data.input.tokenOut) ||
      input.factory !== data.input.factory ||
      input.amountIn !== data.input.amountIn ||
      (input.block.kind === "number" &&
        input.block.blockNumber !== data.block.blockNumber)
    ) {
      throw new TypeError("V2 quote request and result are inconsistent.");
    }
  },
});
