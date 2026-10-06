import { uniswapV4SwapFields } from "./parameters.js";
import { z } from "zod";

import {canonicalJsonStringify, deepFreezeValue, parseHexBytes, parseUtcTimestamp, type CanonicalJson, type HexBytes} from "../../core/index.js";
import {evmAddressSchema, type EvmAddress} from "../../evm/identities.js";
import {keccak256FromUtf8} from "../../evm/keccak256.js";
import {productUsdgAsset} from "../../registry/client.js";
import {uint256DecimalSchema} from "../../evm/amounts.js";
import type { EvmAbiCodec } from "../../chain/index.js";
import { resolvedExchangeIntentSchema, type ResolvedExchangeIntent } from "../../review/exchange.js";
import { exchangeLimits } from "../../review/limits.js";
import { getUniswapV4PoolCandidate, uniswapV4PoolCatalog } from "./catalog.js";
import { describeUniswapV4ExpectedEffect, uniswapV4ExpectedEffectSchema, type UniswapV4ExpectedEffect } from "./effects.js";
import { uniswapV4ContractAddresses } from "./deployment.js";
import { deriveUniswapV4PoolId, uniswapV4PoolKeySchema, uniswapV4PoolIdSchema } from "./identity.js";
import { uniswapV4PermitAllowanceSchema, uniswapV4Slot0Schema, uniswapV4SwapAmountSchema, uniswapV4QuotedAmountSchema } from "./values.js";

const addresses = uniswapV4ContractAddresses;
const callerRecipient = "0x0000000000000000000000000000000000000001";
const routerCommand = "0x10";
const inputSwapAction = "06";
const outputSwapAction = "08";
const fixedSettlementAction = "0b";
const cappedSettlementAction = "0c";
const fixedCollectionAction = "0e";
const minimumCollectionAction = "0f";
const maximumUint128 = (1n << 128n) - 1n;
// The exact-input Quoter converts exactAmount through int128. A quote must
// retain its requested direction rather than reinterpret a signed overflow.
export class UniswapV4UnsupportedIntentError extends Error {
  constructor() {
    super("The quantity cannot be expressed by the selected native V4 profile.");
    this.name = "UniswapV4UnsupportedIntentError";
  }
}

const poolComponents = [
  { name: "currency0", type: "address" },
  { name: "currency1", type: "address" },
  { name: "fee", type: "uint24" },
  { name: "tickSpacing", type: "int24" },
  { name: "hooks", type: "address" },
] as const;
const quoteComponents = [
  { name: "poolKey", type: "tuple", components: poolComponents },
  { name: "zeroForOne", type: "bool" },
  { name: "exactAmount", type: "uint128" },
  { name: "hookData", type: "bytes" },
] as const;
const quoteAbi = ["quoteExactInputSingle", "quoteExactOutputSingle"].map((name) => ({
  type: "function", name, stateMutability: "nonpayable",
  inputs: [{ name: "params", type: "tuple", components: quoteComponents }],
  outputs: [{ name: "amount", type: "uint256" }, { name: "gasEstimate", type: "uint256" }],
}));
const stateAbi = [{
  type: "function", name: "getSlot0", stateMutability: "view",
  inputs: [{ name: "poolId", type: "bytes32" }],
  outputs: [
    { name: "sqrtPriceX96", type: "uint160" }, { name: "tick", type: "int24" },
    { name: "protocolFee", type: "uint24" }, { name: "lpFee", type: "uint24" },
  ],
}] as const;
const executeParameters = [
  { name: "commands", type: "bytes" }, { name: "inputs", type: "bytes[]" },
  { name: "deadline", type: "uint256" },
] as const;
const executeAbi = [{
  type: "function", name: "execute", stateMutability: "payable",
  inputs: executeParameters, outputs: [],
}] as const;
const permitApprovalParameters = [
  { name: "token", type: "address" }, { name: "spender", type: "address" },
  { name: "amount", type: "uint160" }, { name: "expiration", type: "uint48" },
] as const;
const permitAbi = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: permitApprovalParameters, outputs: [] },
  {
    type: "function", name: "allowance", stateMutability: "view",
    inputs: [{ name: "user", type: "address" }, { name: "token", type: "address" }, { name: "spender", type: "address" }],
    outputs: [{ name: "amount", type: "uint160" }, { name: "expiration", type: "uint48" }, { name: "nonce", type: "uint48" }],
  },
] as const;
const currencyAmount = [{ type: "address" }, { type: "uint256" }] as const;
const fixedSettlement = [...currencyAmount, { type: "bool" }] as const;
const fixedCollection = [{ type: "address" }, { type: "address" }, { type: "uint256" }] as const;

const swapParameters = (basis: ResolvedExchangeIntent["basis"]) => [{
  type: "tuple",
  components: [
    { name: "poolKey", type: "tuple", components: poolComponents },
    { name: "zeroForOne", type: "bool" },
    { name: uniswapV4SwapFields[basis].amount, type: "uint128" },
    { name: uniswapV4SwapFields[basis].limit, type: "uint128" },
    { name: "minHopPriceX36", type: "uint256" },
    { name: "hookData", type: "bytes" },
  ],
}];

const nativeAddressSchema = z.string().transform((value) => evmAddressSchema.parse(value.toLowerCase()));
const swapBaseSchema = z.object({
  poolKey: uniswapV4PoolKeySchema.extend({
    currency0: nativeAddressSchema, currency1: nativeAddressSchema, hooks: nativeAddressSchema,
  }),
  zeroForOne: z.boolean(),
  minHopPriceX36: z.literal(0n),
  hookData: z.literal("0x"),
}).strict();
const swapValueSchemas = {
  sent: swapBaseSchema.extend({
    amountIn: z.bigint().positive().max(maximumUint128),
    amountOutMinimum: z.bigint().nonnegative().max(maximumUint128),
  }).strict(),
  received: swapBaseSchema.extend({
    amountOut: z.bigint().positive().max(maximumUint128),
    amountInMaximum: z.bigint().nonnegative().max(maximumUint128),
  }).strict(),
};
const scalar = (input: unknown): bigint => {
  if (typeof input !== "bigint" || input < 0n || input >= (1n << 256n)) {
    throw new TypeError("V4 ABI scalar is invalid.");
  }
  return input;
};
const address = (input: unknown): EvmAddress => {
  if (typeof input !== "string") throw new TypeError("V4 ABI address is invalid.");
  return evmAddressSchema.parse(input.toLowerCase());
};
const selector = (signature: string): string => keccak256FromUtf8(signature).slice(0, 10);
const uint48 = (value: unknown): string => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value >= 2 ** 48) {
    throw new TypeError("V4 ABI uint48 ordinal is invalid.");
  }
  return value.toString(10);
};
const seconds = (value: string): bigint => {
  const milliseconds = Date.parse(value);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds % 1_000 !== 0) {
    throw new TypeError("V4 deadline is not an exact nonnegative second.");
  }
  return BigInt(milliseconds / 1_000);
};
const instant = (value: string): string => {
  const milliseconds = BigInt(value) * 1_000n;
  if (milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError("Native expiration is outside the timestamp range.");
  return parseUtcTimestamp(new Date(Number(milliseconds)).toISOString());
};
const admitIntent = (input: ResolvedExchangeIntent): ResolvedExchangeIntent => {
  const intent = resolvedExchangeIntentSchema.parse(input);
  const pool = getUniswapV4PoolCandidate(intent.poolId);
  if (pool.stockTokenAddress !== intent.stockTokenAddress ||
      !uniswapV4SwapAmountSchema.safeParse(intent.input.raw).success || !uniswapV4SwapAmountSchema.safeParse(intent.output.raw).success) {
    throw new UniswapV4UnsupportedIntentError();
  }
  return intent;
};

export type UniswapV4TransactionKind = "swap" | "erc20_approval" | "permit2_approval";
export interface UniswapV4NativeCall {
  readonly kind: UniswapV4TransactionKind;
  readonly to: EvmAddress;
  readonly value: "0";
  readonly data: HexBytes;
}

export const createUniswapV4Evm = (codec: EvmAbiCodec) => {
  const decodeSwap = (dataInput: HexBytes, sender: EvmAddress) => {
    const data = parseHexBytes(dataInput);
    if (data.length > 2 + exchangeLimits.privateRequestUtf8Bytes * 2 ||
        data.slice(0, 10) !== selector("execute(bytes,bytes[],uint256)")) {
      throw new TypeError("Uniswap V4 Router call is outside the admitted profile.");
    }
    const [commands, inputs, deadline] = codec.decodeParameters(executeParameters, parseHexBytes(`0x${data.slice(10)}`));
    if (commands !== routerCommand || !Array.isArray(inputs) || inputs.length !== 1) {
      throw new TypeError("Uniswap V4 Router command profile is invalid.");
    }
    const [actions, params] = codec.decodeParameters(
      [{ type: "bytes" }, { type: "bytes[]" }], parseHexBytes(inputs[0]),
    );
    if (typeof actions !== "string" || !/^0x(?:06|08)(?:0b|0c)(?:0e|0f)$/u.test(actions) ||
        !Array.isArray(params) || params.length !== 3) {
      throw new TypeError("Uniswap V4 swap action profile is invalid.");
    }
    const basis = actions.slice(2, 4) === inputSwapAction ? "sent" : "received";
    const fixedInput = actions.slice(4, 6) === fixedSettlementAction;
    const fixedOutput = actions.slice(6, 8) === fixedCollectionAction;
    const native = codec.decodeParameters(swapParameters(basis), parseHexBytes(params[0]))[0];
    const parsed = basis === "sent" ? swapValueSchemas.sent.parse(native) : swapValueSchemas.received.parse(native);
    const quantity = "amountIn" in parsed ? parsed.amountIn : parsed.amountOut;
    const limit = "amountOutMinimum" in parsed ? parsed.amountOutMinimum : parsed.amountInMaximum;
    const poolKey = parsed.poolKey;
    const pool = getUniswapV4PoolCandidate(deriveUniswapV4PoolId(poolKey));
    const tokenIn = parsed.zeroForOne ? pool.poolKey.currency0 : pool.poolKey.currency1;
    const tokenOut = parsed.zeroForOne ? pool.poolKey.currency1 : pool.poolKey.currency0;
    const settlement = codec.decodeParameters(fixedInput ? fixedSettlement : currencyAmount, parseHexBytes(params[1]));
    const collection = codec.decodeParameters(fixedOutput ? fixedCollection : currencyAmount, parseHexBytes(params[2]));
    const inputAmount = scalar(settlement[1]);
    const outputAmount = scalar(collection[fixedOutput ? 2 : 1]);
    if (address(settlement[0]) !== tokenIn || address(collection[0]) !== tokenOut ||
        (fixedInput && (settlement[2] !== true || inputAmount === 0n)) ||
        (fixedOutput && (address(collection[1]) !== callerRecipient || outputAmount === 0n)) ||
        (basis === "sent" ? quantity !== inputAmount || limit !== outputAmount
          : quantity !== outputAmount || limit !== inputAmount)) {
      throw new TypeError("Uniswap V4 settlement does not preserve the swap conditions.");
    }
    return deepFreezeValue({
      basis, poolId: pool.poolId, tokenIn, tokenOut, recipient: address(sender),
      inputRelation: fixedInput ? "equal" as const : "at_most" as const,
      outputRelation: fixedOutput ? "equal" as const : "at_least" as const,
      inputAmount: inputAmount.toString(10), outputAmount: outputAmount.toString(10),
      deadline: scalar(deadline).toString(10),
    });
  };

  const decodeCall = (call: Readonly<{ to: EvmAddress; value: string; data: HexBytes }>, sender: EvmAddress): UniswapV4ExpectedEffect => {
    if (call.value !== "0") throw new TypeError("The ERC-20 exchange cannot send native value.");
    if (call.to === addresses.router) {
      const decoded = decodeSwap(call.data, sender);
      return deepFreezeValue(uniswapV4ExpectedEffectSchema.parse({
        kind: "swap", router: addresses.router, poolId: decoded.poolId, basis: decoded.basis,
        payer: sender, recipient: decoded.recipient, tokenIn: decoded.tokenIn, tokenOut: decoded.tokenOut,
        input: { relation: decoded.inputRelation, amount: decoded.inputAmount },
        output: { relation: decoded.outputRelation, amount: decoded.outputAmount }, deadline: instant(decoded.deadline),
      }));
    }
    const data = parseHexBytes(call.data);
    const parameters = parseHexBytes(`0x${data.slice(10)}`);
    const admittedToken = (token: EvmAddress): boolean => token === productUsdgAsset.address ||
      uniswapV4PoolCatalog.some((pool) => pool.stockTokenAddress === token);
    if (call.to !== addresses.permit2) {
      const [spender, amount] = codec.decodeParameters(currencyAmount, parameters);
      if (!admittedToken(call.to) || data.slice(0, 10) !== selector("approve(address,uint256)") ||
          address(spender) !== addresses.permit2 || scalar(amount) === 0n) {
        throw new TypeError("ERC-20 approval differs from the supported profile.");
      }
      return deepFreezeValue(uniswapV4ExpectedEffectSchema.parse({ kind: "erc20_approval", token: call.to,
        spender: address(spender), allowance: scalar(amount).toString(10), expiration: "none" }));
    }
    const [token, spender, amount, expiration] = codec.decodeParameters(permitApprovalParameters, parameters);
    if (data.slice(0, 10) !== selector("approve(address,address,uint160,uint48)") ||
        !admittedToken(address(token)) || address(spender) !== addresses.router || scalar(amount) === 0n) {
      throw new TypeError("Permit2 approval differs from the supported profile.");
    }
    return deepFreezeValue(uniswapV4ExpectedEffectSchema.parse({ kind: "permit2_approval", token: address(token),
      spender: address(spender), allowance: scalar(amount).toString(10), expiration: instant(uint48(expiration)) }));
  };

  const assertCall = (input: ResolvedExchangeIntent, call: UniswapV4NativeCall): void => {
    const intent = admitIntent(input);
    const decoded = decodeCall(call, intent.account.address);
    const expected = describeUniswapV4ExpectedEffect(intent, call.kind);
    if (decoded.kind !== call.kind || canonicalJsonStringify(decoded as unknown as CanonicalJson) !==
        canonicalJsonStringify(expected as unknown as CanonicalJson)) {
      throw new TypeError("V4 call differs from the admitted intent.");
    }
  };

  const createSwap = (input: ResolvedExchangeIntent): UniswapV4NativeCall => {
    const intent = admitIntent(input);
    const pool = getUniswapV4PoolCandidate(intent.poolId);
    const fixedInput = intent.inputRelation === "equal";
    const fixedOutput = intent.outputRelation === "equal";
    const actions = parseHexBytes(`0x${intent.basis === "sent" ? inputSwapAction : outputSwapAction}${
      fixedInput ? fixedSettlementAction : cappedSettlementAction}${fixedOutput ? fixedCollectionAction : minimumCollectionAction}`);
    const swap = codec.encodeParameters(swapParameters(intent.basis), [{
      poolKey: pool.poolKey,
      zeroForOne: intent.input.token === pool.poolKey.currency0,
      [uniswapV4SwapFields[intent.basis].amount]: BigInt(intent.basis === "sent" ? intent.input.raw : intent.output.raw),
      [uniswapV4SwapFields[intent.basis].limit]: BigInt(intent.basis === "sent" ? intent.output.raw : intent.input.raw),
      minHopPriceX36: 0n,
      hookData: "0x",
    }]);
    const settlement = codec.encodeParameters(fixedInput ? fixedSettlement : currencyAmount,
      fixedInput ? [intent.input.token, BigInt(intent.input.raw), true] : [intent.input.token, BigInt(intent.input.raw)]);
    const collection = codec.encodeParameters(fixedOutput ? fixedCollection : currencyAmount,
      fixedOutput ? [intent.output.token, callerRecipient, BigInt(intent.output.raw)] : [intent.output.token, BigInt(intent.output.raw)]);
    const inner = codec.encodeParameters([{ type: "bytes" }, { type: "bytes[]" }], [actions, [swap, settlement, collection]]);
    const data = codec.encodeFunction(executeAbi, "execute", [routerCommand, [inner], seconds(intent.deadline)]);
    const call = Object.freeze({ kind: "swap" as const, to: addresses.router, value: "0" as const, data });
    assertCall(intent, call);
    return call;
  };

  return Object.freeze({
    decodeSwap,
    decodeCall,
    createSwap,
    assertCall,
    slot0(poolId: string): HexBytes {
      return codec.encodeFunction(stateAbi, "getSlot0", [uniswapV4PoolIdSchema.parse(poolId)]);
    },
    decodeSlot0(data: HexBytes) {
      const [price, tick, protocolFee, lpFee] = codec.decodeParameters(stateAbi[0].outputs, data);
      if (!Number.isSafeInteger(tick) || !Number.isSafeInteger(protocolFee) || !Number.isSafeInteger(lpFee)) {
        throw new TypeError("V4 slot0 scalars are invalid.");
      }
      return Object.freeze(uniswapV4Slot0Schema.parse({ sqrtPriceX96: scalar(price).toString(10), tick, protocolFee, lpFee }));
    },
    quote(input: ResolvedExchangeIntent): HexBytes {
      const intent = admitIntent(input);
      const pool = getUniswapV4PoolCandidate(intent.poolId);
      const amount = BigInt(intent.basis === "sent" ? intent.input.raw : intent.output.raw);
      if (!uniswapV4QuotedAmountSchema.safeParse(amount.toString(10)).success) throw new UniswapV4UnsupportedIntentError();
      return codec.encodeFunction(quoteAbi, intent.basis === "sent" ? "quoteExactInputSingle" : "quoteExactOutputSingle", [{
        poolKey: pool.poolKey, zeroForOne: intent.input.token === pool.poolKey.currency0, exactAmount: amount, hookData: "0x",
      }]);
    },
    decodeQuote(data: HexBytes) {
      const [amount, quoteGasEstimate] = codec.decodeParameters([{ type: "uint256" }, { type: "uint256" }], data);
      return Object.freeze({ amount: scalar(amount).toString(10), quoteGasEstimate: scalar(quoteGasEstimate).toString(10) });
    },
    erc20Allowance(account: EvmAddress): HexBytes {
      return codec.encodeErc20("allowance", [address(account), addresses.permit2]);
    },
    permitAllowance(account: EvmAddress, token: EvmAddress): HexBytes {
      return codec.encodeFunction(permitAbi, "allowance", [address(account), address(token), addresses.router]);
    },
    decodePermitAllowance(data: HexBytes) {
      const [amount, expiration, nonce] = codec.decodeParameters(permitAbi[1].outputs, data);
      return Object.freeze(uniswapV4PermitAllowanceSchema.parse({ amount: scalar(amount).toString(10), expiration: uint48(expiration), nonce: uint48(nonce) }));
    },
    approval(input: ResolvedExchangeIntent, kind: "erc20_approval" | "permit2_approval"): UniswapV4NativeCall {
      const intent = admitIntent(input);
      const amount = BigInt(uint256DecimalSchema.parse(intent.input.raw));
      const data = kind === "erc20_approval"
        ? codec.encodeErc20("approve", [addresses.permit2, amount])
        : codec.encodeFunction(permitAbi, "approve", [intent.input.token, addresses.router, amount, seconds(intent.deadline)]);
      const call = Object.freeze({ kind, to: kind === "erc20_approval" ? intent.input.token : addresses.permit2, value: "0" as const, data });
      assertCall(intent, call);
      return call;
    },
  });
};

export type UniswapV4Evm = ReturnType<typeof createUniswapV4Evm>;
