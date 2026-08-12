import {
  compareCodePointSequences,
  createExactRational,
  deepFreezeValue,
  evmAddressSchema,
  keccak256FromHex,
  type Erc20AssetIdentity,
  type ExactRational,
  type EvmAddress,
} from "../../core/client.js";

const uint256Maximum = (1n << 256n) - 1n;
export const uniswapV2FeeAdjustedInputNumerator = 997n;
export const uniswapV2FeeAdjustedInputDenominator = 1000n;
export const uniswapV2FeeRate = deepFreezeValue({
  numerator: (
    uniswapV2FeeAdjustedInputDenominator -
    uniswapV2FeeAdjustedInputNumerator
  ).toString(10),
  denominator: uniswapV2FeeAdjustedInputDenominator.toString(10),
});

const gcd = (left: bigint, right: bigint): bigint => {
  while (right !== 0n) [left, right] = [right, left % right];
  return left;
};

export interface NonnegativeExactRational {
  readonly numerator: string;
  readonly denominator: string;
}

export const createNonnegativeExactRational = (
  numerator: bigint,
  denominator: bigint,
): NonnegativeExactRational => {
  if (numerator < 0n || denominator <= 0n) {
    throw new TypeError("Exact nonnegative rational components are invalid.");
  }
  if (numerator === 0n) {
    return Object.freeze({ numerator: "0", denominator: "1" });
  }
  const divisor = gcd(numerator, denominator);
  return Object.freeze({
    numerator: (numerator / divisor).toString(10),
    denominator: (denominator / divisor).toString(10),
  });
};

const addressBytes = (address: EvmAddress): string =>
  evmAddressSchema.parse(address).slice(2);

export const orderedTokenAddresses = (
  leftInput: EvmAddress,
  rightInput: EvmAddress,
): readonly [EvmAddress, EvmAddress] => {
  const left = evmAddressSchema.parse(leftInput);
  const right = evmAddressSchema.parse(rightInput);
  if (left === right) throw new TypeError("A V2 pair requires distinct token addresses.");
  return left < right ? [left, right] : [right, left];
};

export const computeUniswapV2PairAddress = (input: {
  readonly factory: EvmAddress;
  readonly tokenA: EvmAddress;
  readonly tokenB: EvmAddress;
  readonly pairInitCodeHash: string;
}): EvmAddress => {
  const factory = evmAddressSchema.parse(input.factory);
  const [token0, token1] = orderedTokenAddresses(input.tokenA, input.tokenB);
  const initCodeHash = /^0x[0-9a-f]{64}$/u.test(input.pairInitCodeHash)
    ? input.pairInitCodeHash
    : (() => {
        throw new TypeError("V2 pair init-code hash is invalid.");
      })();
  const salt = keccak256FromHex(`0x${addressBytes(token0)}${addressBytes(token1)}`);
  const digest = keccak256FromHex(
    `0xff${addressBytes(factory)}${salt.slice(2)}${initCodeHash.slice(2)}`,
  );
  return evmAddressSchema.parse(`0x${digest.slice(-40)}`);
};

export type UniswapV2AmountOutResult =
  | Readonly<{ readonly status: "quoted"; readonly amountOut: bigint }>
  | Readonly<{ readonly status: "zero_liquidity" }>
  | Readonly<{ readonly status: "amount_too_small" }>
  | Readonly<{ readonly status: "arithmetic_overflow" }>;

const multiplyUint256 = (left: bigint, right: bigint): bigint | null => {
  const result = left * right;
  return result > uint256Maximum ? null : result;
};

const addUint256 = (left: bigint, right: bigint): bigint | null => {
  const result = left + right;
  return result > uint256Maximum ? null : result;
};

export const calculateUniswapV2AmountOut = (input: {
  readonly amountIn: bigint;
  readonly reserveIn: bigint;
  readonly reserveOut: bigint;
}): UniswapV2AmountOutResult => {
  if (
    input.amountIn <= 0n ||
    input.amountIn > uint256Maximum ||
    input.reserveIn < 0n ||
    input.reserveOut < 0n
  ) {
    throw new TypeError("V2 quote inputs are outside their canonical range.");
  }
  if (input.reserveIn === 0n || input.reserveOut === 0n) {
    return Object.freeze({ status: "zero_liquidity" });
  }
  const amountInWithFee = multiplyUint256(
    input.amountIn,
    uniswapV2FeeAdjustedInputNumerator,
  );
  if (amountInWithFee === null) {
    return Object.freeze({ status: "arithmetic_overflow" });
  }
  const numerator = multiplyUint256(amountInWithFee, input.reserveOut);
  const reserveTerm = multiplyUint256(
    input.reserveIn,
    uniswapV2FeeAdjustedInputDenominator,
  );
  if (numerator === null || reserveTerm === null) {
    return Object.freeze({ status: "arithmetic_overflow" });
  }
  const denominator = addUint256(reserveTerm, amountInWithFee);
  if (denominator === null) {
    return Object.freeze({ status: "arithmetic_overflow" });
  }
  const amountOut = numerator / denominator;
  if (amountOut === 0n) return Object.freeze({ status: "amount_too_small" });
  if (amountOut >= input.reserveOut) {
    throw new TypeError("V2 quote output is inconsistent with the admitted reserves.");
  }
  return Object.freeze({ status: "quoted", amountOut });
};

export const constructUniswapV2CandidatePaths = (
  tokenIn: Erc20AssetIdentity,
  tokenOut: Erc20AssetIdentity,
  routeAssets: readonly Erc20AssetIdentity[],
): readonly (readonly Erc20AssetIdentity[])[] => {
  if (
    tokenIn.chainId !== tokenOut.chainId ||
    tokenIn.address === tokenOut.address
  ) {
    throw new TypeError("V2 quote endpoints are invalid.");
  }
  const routeAddresses = routeAssets.map((asset) => asset.address);
  const orderedRouteAddresses = [...routeAddresses].sort(compareCodePointSequences);
  if (
    routeAssets.some((asset) => asset.chainId !== tokenIn.chainId) ||
    new Set(routeAddresses).size !== routeAddresses.length ||
    routeAddresses.some((address, index) => address !== orderedRouteAddresses[index])
  ) {
    throw new TypeError("V2 route assets must be unique, ordered, and on the quote chain.");
  }
  const paths: Erc20AssetIdentity[][] = [[tokenIn, tokenOut]];
  for (const routeAsset of routeAssets) {
    if (
      routeAsset.address === tokenIn.address ||
      routeAsset.address === tokenOut.address
    ) {
      continue;
    }
    paths.push([tokenIn, routeAsset, tokenOut]);
  }
  return deepFreezeValue(paths);
};

export const calculateUniswapV2Prices = (input: {
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly reserves: readonly Readonly<{
    readonly reserveIn: bigint;
    readonly reserveOut: bigint;
  }>[];
}): Readonly<{
  readonly executionPrice: ExactRational;
  readonly midPrice: ExactRational;
  readonly priceImpact: NonnegativeExactRational;
}> => {
  if (input.amountIn <= 0n || input.amountOut <= 0n || input.reserves.length === 0) {
    throw new TypeError("V2 price inputs are invalid.");
  }
  let midNumerator = 1n;
  let midDenominator = 1n;
  for (const reserve of input.reserves) {
    if (reserve.reserveIn <= 0n || reserve.reserveOut <= 0n) {
      throw new TypeError("V2 mid-price reserves must be positive.");
    }
    midNumerator *= reserve.reserveOut;
    midDenominator *= reserve.reserveIn;
  }
  const executionPrice = createExactRational(input.amountOut, input.amountIn);
  const midPrice = createExactRational(midNumerator, midDenominator);
  const impactNumerator =
    midNumerator * input.amountIn - input.amountOut * midDenominator;
  if (impactNumerator < 0n) {
    throw new TypeError("V2 execution price exceeds the admitted reserve mid-price.");
  }
  return deepFreezeValue({
    executionPrice,
    midPrice,
    priceImpact: createNonnegativeExactRational(
      impactNumerator,
      midNumerator * input.amountIn,
    ),
  });
};
