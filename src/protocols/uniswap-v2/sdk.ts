import { createRequire } from "node:module";

import {evmAddressSchema, type EvmAddress} from "../../evm/identities.js";
import {productChainNumericId} from "../../registry/client.js";
import {type Erc20AssetIdentity} from "../../evm/amounts.js";
import {
  uniswapV2FactoryAddress,
  uniswapV2PairInitCodeHash,
  uniswapV2SdkDependencies,
} from "./deployment.js";

interface SdkCurrencyAmount {
  readonly currency: SdkToken;
  readonly quotient: Readonly<{ toString(): string }>;
}

interface SdkToken {
  readonly address: string;
  readonly chainId: number;
  readonly decimals: number;
}

interface SdkPair {
  getOutputAmount(
    input: SdkCurrencyAmount,
    calculateFotFees: boolean,
  ): readonly [SdkCurrencyAmount, SdkPair];
}

interface SdkCoreNamespace {
  readonly Token: new (
    chainId: number,
    address: string,
    decimals: number,
  ) => SdkToken;
  readonly CurrencyAmount: Readonly<{
    fromRawAmount(currency: SdkToken, amount: string): SdkCurrencyAmount;
  }>;
}

interface V2SdkNamespace {
  readonly Pair: new (
    amount0: SdkCurrencyAmount,
    amount1: SdkCurrencyAmount,
  ) => SdkPair;
  readonly computePairAddress: (input: Readonly<{
    factoryAddress: string;
    tokenA: SdkToken;
    tokenB: SdkToken;
  }>) => string;
  readonly FACTORY_ADDRESS_MAP: Readonly<Record<number, string>>;
  readonly INIT_CODE_HASH: string;
}

const require = createRequire(import.meta.url);

const exactRecord = (value: unknown, label: string): Record<PropertyKey, unknown> => {
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`${label} SDK namespace is invalid.`);
  }
  return value as Record<PropertyKey, unknown>;
};

const loadSdk = (): Readonly<{
  readonly core: SdkCoreNamespace;
  readonly v2: V2SdkNamespace;
}> => {
  if (
    uniswapV2SdkDependencies.sdkCore.packageName !== "@uniswap/sdk-core" ||
    uniswapV2SdkDependencies.v2Sdk.packageName !== "@uniswap/v2-sdk"
  ) {
    throw new TypeError("Uniswap SDK dependency identities are inconsistent.");
  }
  const core = exactRecord(require("@uniswap/sdk-core"), "Uniswap core");
  const v2 = exactRecord(require("@uniswap/v2-sdk"), "Uniswap V2");
  if (
    typeof core["Token"] !== "function" ||
    (typeof core["CurrencyAmount"] !== "object" &&
      typeof core["CurrencyAmount"] !== "function") ||
    core["CurrencyAmount"] === null ||
    typeof (core["CurrencyAmount"] as Record<PropertyKey, unknown>)["fromRawAmount"] !== "function" ||
    typeof v2["Pair"] !== "function" ||
    typeof v2["computePairAddress"] !== "function" ||
    typeof v2["FACTORY_ADDRESS_MAP"] !== "object" ||
    v2["FACTORY_ADDRESS_MAP"] === null ||
    typeof v2["INIT_CODE_HASH"] !== "string"
  ) {
    throw new TypeError("Required Uniswap SDK exports are absent.");
  }
  const factoryMap = v2["FACTORY_ADDRESS_MAP"] as Readonly<Record<number, unknown>>;
  if (
    factoryMap[productChainNumericId] !== uniswapV2FactoryAddress ||
    v2["INIT_CODE_HASH"] !== uniswapV2PairInitCodeHash
  ) {
    throw new TypeError("Uniswap SDK deployment constants are inconsistent.");
  }
  return Object.freeze({
    core: core as unknown as SdkCoreNamespace,
    v2: v2 as unknown as V2SdkNamespace,
  });
};

const sdk = loadSdk();

export interface UniswapV2SdkHopInput {
  readonly tokenIn: Erc20AssetIdentity;
  readonly tokenOut: Erc20AssetIdentity;
  readonly tokenInDecimals: string;
  readonly tokenOutDecimals: string;
  readonly reserve0: string;
  readonly reserve1: string;
  readonly expectedPair: EvmAddress;
}

const sdkToken = (
  asset: Erc20AssetIdentity,
  decimals: string,
): SdkToken => {
  const value = Number(decimals);
  if (!Number.isSafeInteger(value) || value < 0 || value > 254) {
    throw new TypeError("Token decimals are outside the admitted SDK range.");
  }
  return new sdk.core.Token(productChainNumericId, asset.address, value);
};

const canonicalSdkAddress = (address: string): EvmAddress =>
  evmAddressSchema.parse(address.toLowerCase());

export const compareUniswapV2SdkQuote = (input: {
  readonly amountIn: string;
  readonly expectedAmountOut: string;
  readonly hops: readonly UniswapV2SdkHopInput[];
}): void => {
  if (input.hops.length === 0) throw new TypeError("V2 SDK route is empty.");
  let amount = input.amountIn;
  for (const hop of input.hops) {
    const tokenIn = sdkToken(hop.tokenIn, hop.tokenInDecimals);
    const tokenOut = sdkToken(hop.tokenOut, hop.tokenOutDecimals);
    const pairAddress = canonicalSdkAddress(sdk.v2.computePairAddress({
      factoryAddress: uniswapV2FactoryAddress,
      tokenA: tokenIn,
      tokenB: tokenOut,
    }));
    if (pairAddress !== hop.expectedPair) {
      throw new TypeError("Uniswap SDK pair address disagrees with the canonical calculation.");
    }
    const token0IsInput = tokenIn.address.toLowerCase() < tokenOut.address.toLowerCase();
    const token0 = token0IsInput ? tokenIn : tokenOut;
    const token1 = token0IsInput ? tokenOut : tokenIn;
    const amount0 = sdk.core.CurrencyAmount.fromRawAmount(
      token0,
      hop.reserve0,
    );
    const amount1 = sdk.core.CurrencyAmount.fromRawAmount(
      token1,
      hop.reserve1,
    );
    const pair = new sdk.v2.Pair(amount0, amount1);
    const inputAmount = sdk.core.CurrencyAmount.fromRawAmount(tokenIn, amount);
    const result = pair.getOutputAmount(inputAmount, false);
    if (!Array.isArray(result) || result.length !== 2) {
      throw new TypeError("Uniswap SDK quote result is malformed.");
    }
    const output = result[0];
    if (
      typeof output !== "object" ||
      output === null ||
      output.currency.address.toLowerCase() !== tokenOut.address.toLowerCase()
    ) {
      throw new TypeError("Uniswap SDK quote output identity is inconsistent.");
    }
    amount = output.quotient.toString();
  }
  if (amount !== input.expectedAmountOut) {
    throw new TypeError("Uniswap SDK quote output disagrees with exact arithmetic.");
  }
};
