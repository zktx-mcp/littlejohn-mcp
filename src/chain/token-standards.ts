import {
  calculateScaledUiAmount,
  chainAnchorSchema,
  deepFreezeValue,
  erc20AssetIdentitySchema,
  evmAccountIdentitySchema,
  parseHexBytes,
  requiredErc8056ObservationSchema,
  supportedErc8056ValuesSchema,
  tokenStandardObservationSchema,
  tokenStandardObservationResultSchema,
  tokenStandardOrder,
  type ChainAnchor,
  type Erc20AssetIdentity,
  type EvmAccountIdentity,
  type RequiredErc8056Observation,
  type SupportedErc8056Values,
  type TokenStandardObservation,
  type TokenStandardId,
  type UnsignedDecimal,
  type TokenStandardObservationResult,
} from "../core/index.js";
import {
  createTokenStandardCallEncoder,
  decodeAbiBooleanResult,
  decodeAbiUint256Result,
} from "./evm-standard.js";
import { normalizeRpcBytes } from "./normalization.js";
import {
  isRpcExecutionRevertedError,
  type RpcCanonicalBlockReference,
  type RpcRequester,
} from "./rpc.js";
import {
  admitChainReadFailure,
  ChainOperationError,
} from "./errors.js";

export type {
  RequiredErc8056Observation,
  TokenStandardObservationResult,
} from "../core/index.js";

export const erc165InterfaceId = parseHexBytes("0x01ffc9a7");
export const erc165InvalidInterfaceId = parseHexBytes("0xffffffff");
export const erc8056InterfaceId = parseHexBytes("0xa60bf13d");
export const erc8056PendingMultiplierInterfaceId = parseHexBytes("0x4bd27648");
export const erc8056ConversionInterfaceId = parseHexBytes("0x57854fc3");
export const erc8056BalancesInterfaceId = parseHexBytes("0xd890fd71");
export const erc165DetectionGas = "0x7530" as const;

export interface RequiredErc8056ObservationInput {
  readonly rpc: RpcRequester;
  readonly asset: Erc20AssetIdentity;
  readonly block: ChainAnchor;
  readonly stateReference: RpcCanonicalBlockReference;
  readonly signal: AbortSignal;
}

export interface CompleteTokenStandardObservationInput extends RequiredErc8056ObservationInput {
  readonly erc20ReadSurfaceObserved: true;
  readonly accountBalance?: Readonly<{
    account: EvmAccountIdentity;
    rawBalance: UnsignedDecimal;
  }>;
}

type CallResult<Value> =
  | Readonly<{ status: "available"; value: Value }>
  | Readonly<{ status: "inconsistent" }>
  | Readonly<{ status: "reverted" }>
  | Readonly<{ status: "unavailable" }>;

const encoder = createTokenStandardCallEncoder();
const admittedRequiredResults = new WeakSet<object>();

const observation = (
  standardId: TokenStandardObservation["standardId"],
  status: TokenStandardObservation["status"],
): TokenStandardObservation => tokenStandardObservationSchema.parse({ standardId, status });

const readCall = async <Value>(
  input: RequiredErc8056ObservationInput,
  data: ReturnType<typeof parseHexBytes>,
  decode: (raw: unknown) => Value,
  gasBounded = false,
): Promise<CallResult<Value>> => {
  let raw: unknown;
  try {
    raw = await input.rpc.request("eth_call", [{
      to: input.asset.address,
      data,
      ...(gasBounded ? { gas: erc165DetectionGas } : {}),
    }, input.stateReference], input.signal);
  } catch (error) {
    if (isRpcExecutionRevertedError(error)) return Object.freeze({ status: "reverted" });
    const failure = admitChainReadFailure(error, input.signal);
    if (failure?.error.code === "request_aborted") {
      throw new ChainOperationError(failure);
    }
    if (failure !== undefined) return Object.freeze({ status: "unavailable" });
    throw error;
  }
  try {
    return Object.freeze({ status: "available", value: decode(normalizeRpcBytes(raw)) });
  } catch {
    return Object.freeze({ status: "inconsistent" });
  }
};

const readInterface = (
  input: RequiredErc8056ObservationInput,
  interfaceId: ReturnType<typeof parseHexBytes>,
): Promise<CallResult<boolean>> => readCall(
  input,
  encoder.supportsInterface(interfaceId),
  decodeAbiBooleanResult,
  true,
);

const createRequiredResult = (
  asset: Erc20AssetIdentity,
  block: ChainAnchor,
  erc165Status: TokenStandardObservation["status"],
  erc8056Status: TokenStandardObservation["status"],
  pendingStatus: TokenStandardObservation["status"],
  values?: SupportedErc8056Values,
): RequiredErc8056Observation => {
  const result = deepFreezeValue(requiredErc8056ObservationSchema.parse({
    asset,
    block,
    erc165: observation("erc165", erc165Status),
    erc8056: observation("erc8056", erc8056Status),
    pendingMultiplier: observation("erc8056_pending_multiplier", pendingStatus),
    ...(values === undefined ? {} : { values: supportedErc8056ValuesSchema.parse(values) }),
  }));
  admittedRequiredResults.add(result);
  return result;
};

export const observeRequiredErc8056 = async (
  input: RequiredErc8056ObservationInput,
): Promise<RequiredErc8056Observation> => {
  const asset = erc20AssetIdentitySchema.parse(input.asset) as Erc20AssetIdentity;
  const block = chainAnchorSchema.parse(input.block) as ChainAnchor;
  if (!(input.signal instanceof AbortSignal) ||
    asset.chainId !== block.chainId ||
    input.stateReference.blockHash !== block.blockHash) {
    throw new TypeError("ERC-8056 observation block reference is inconsistent.");
  }
  const observationInput: RequiredErc8056ObservationInput = { ...input, asset, block };
  const self = await readInterface(observationInput, erc165InterfaceId);
  if (self.status === "unavailable") {
    return createRequiredResult(asset, block, "unknown", "unknown", "unknown");
  }
  if (self.status === "inconsistent") {
    return createRequiredResult(asset, block, "inconsistent", "unknown", "unknown");
  }
  if (self.status === "reverted" || !self.value) {
    return createRequiredResult(asset, block, "not_supported", "unknown", "unknown");
  }

  const invalid = await readInterface(observationInput, erc165InvalidInterfaceId);
  if (invalid.status === "unavailable") {
    return createRequiredResult(asset, block, "unknown", "unknown", "unknown");
  }
  if (invalid.status === "inconsistent") {
    return createRequiredResult(asset, block, "inconsistent", "unknown", "unknown");
  }
  if (invalid.status === "reverted" || invalid.value) {
    return createRequiredResult(asset, block, "not_supported", "unknown", "unknown");
  }

  const [core, pending] = await Promise.all([
    readInterface(observationInput, erc8056InterfaceId),
    readInterface(observationInput, erc8056PendingMultiplierInterfaceId),
  ]);
  if (core.status === "inconsistent" || core.status === "reverted" ||
    pending.status === "inconsistent" || pending.status === "reverted") {
    return createRequiredResult(
      asset,
      block,
      "supported",
      "inconsistent",
      pending.status === "available" && !pending.value ? "not_supported" : "inconsistent",
    );
  }
  if (core.status === "unavailable" || pending.status === "unavailable") {
    const erc8056Status = core.status === "available" && !core.value ? "not_supported" : "unknown";
    const pendingStatus = pending.status === "available" && !pending.value ? "not_supported" : "unknown";
    return createRequiredResult(asset, block, "supported", erc8056Status, pendingStatus);
  }
  if (!core.value && !pending.value) {
    return createRequiredResult(asset, block, "supported", "not_supported", "not_supported");
  }
  if (!core.value || !pending.value) {
    return createRequiredResult(
      asset,
      block,
      "supported",
      "inconsistent",
      pending.value ? "inconsistent" : "not_supported",
    );
  }

  const [currentMultiplier, pendingMultiplier, pendingEffectiveAt] = await Promise.all([
    readCall(observationInput, encoder.uiMultiplier(), decodeAbiUint256Result),
    readCall(observationInput, encoder.newUiMultiplier(), decodeAbiUint256Result),
    readCall(observationInput, encoder.effectiveAt(), decodeAbiUint256Result),
  ]);
  const values = [currentMultiplier, pendingMultiplier, pendingEffectiveAt] as const;
  if (values.some((value) => value.status === "unavailable")) {
    return createRequiredResult(asset, block, "supported", "unknown", "unknown");
  }
  if (values.some((value) => value.status !== "available")) {
    return createRequiredResult(asset, block, "supported", "inconsistent", "inconsistent");
  }
  if (
    currentMultiplier.status !== "available" ||
    pendingMultiplier.status !== "available" ||
    pendingEffectiveAt.status !== "available"
  ) throw new TypeError("ERC-8056 required result narrowing failed.");
  return createRequiredResult(asset, block, "supported", "supported", "supported", {
    currentMultiplier: currentMultiplier.value,
    pendingMultiplier: pendingMultiplier.value,
    pendingEffectiveAt: pendingEffectiveAt.value,
  });
};

const optionalInterfaceObservation = async (
  input: RequiredErc8056ObservationInput,
  interfaceId: ReturnType<typeof parseHexBytes>,
  standardId: "erc8056_conversion" | "erc8056_balances",
): Promise<Readonly<{ observation: TokenStandardObservation; declared: boolean }>> => {
  const result = await readInterface(input, interfaceId);
  if (result.status === "unavailable") {
    return Object.freeze({ observation: observation(standardId, "unknown"), declared: false });
  }
  if (result.status !== "available") {
    return Object.freeze({ observation: observation(standardId, "inconsistent"), declared: false });
  }
  return Object.freeze({
    observation: observation(standardId, result.value ? "supported" : "not_supported"),
    declared: result.value,
  });
};

export const completeTokenStandardObservation = async (
  input: CompleteTokenStandardObservationInput,
  required: RequiredErc8056Observation,
): Promise<TokenStandardObservationResult> => {
  const asset = erc20AssetIdentitySchema.parse(input.asset) as Erc20AssetIdentity;
  const block = chainAnchorSchema.parse(input.block) as ChainAnchor;
  const account = input.accountBalance === undefined
    ? undefined
    : evmAccountIdentitySchema.parse(input.accountBalance.account) as EvmAccountIdentity;
  if (input.erc20ReadSurfaceObserved !== true ||
    !(input.signal instanceof AbortSignal) ||
    asset.chainId !== block.chainId ||
    (account !== undefined && account.chainId !== block.chainId) ||
    input.stateReference.blockHash !== block.blockHash) {
    throw new TypeError("Token standard observation input is inconsistent.");
  }
  if (!admittedRequiredResults.has(required) ||
    required.asset.chainId !== asset.chainId ||
    required.asset.address !== asset.address ||
    required.block.blockHash !== block.blockHash ||
    required.block.chainId !== block.chainId ||
    required.block.blockNumber !== block.blockNumber ||
    required.block.blockTimestamp !== block.blockTimestamp) {
    throw new TypeError("The required ERC-8056 observation is not valid for this block.");
  }
  let conversion = observation("erc8056_conversion", "unknown");
  let balances = observation("erc8056_balances", "unknown");
  let balanceOfUi: UnsignedDecimal | undefined;
  let calculatedBalance: ReturnType<typeof calculateScaledUiAmount> | undefined;

  if (required.erc165.status === "supported") {
    const requiredInput: RequiredErc8056ObservationInput = {
      rpc: input.rpc,
      asset,
      block,
      stateReference: input.stateReference,
      signal: input.signal,
    };
    const [conversionResult, balancesResult] = await Promise.all([
      optionalInterfaceObservation(
        requiredInput,
        erc8056ConversionInterfaceId,
        "erc8056_conversion",
      ),
      optionalInterfaceObservation(
        requiredInput,
        erc8056BalancesInterfaceId,
        "erc8056_balances",
      ),
    ]);
    conversion = conversionResult.observation;
    balances = balancesResult.observation;
    if (required.values === undefined) {
      if (conversionResult.declared) conversion = observation("erc8056_conversion", "inconsistent");
      if (balancesResult.declared) balances = observation("erc8056_balances", "inconsistent");
    } else if (input.accountBalance !== undefined && account !== undefined) {
      calculatedBalance = calculateScaledUiAmount(
        input.accountBalance.rawBalance,
        required.values.currentMultiplier,
      );
      if (balancesResult.declared) {
        const onchain = await readCall(
          requiredInput,
          encoder.balanceOfUi(account.address),
          decodeAbiUint256Result,
        );
        if (onchain.status === "unavailable") {
          balances = observation("erc8056_balances", "unknown");
          calculatedBalance = undefined;
        }
        else if (onchain.status !== "available" ||
          calculatedBalance.status !== "available" ||
          onchain.value !== calculatedBalance.adjustedRaw) {
          balances = observation("erc8056_balances", "inconsistent");
          calculatedBalance = undefined;
        } else balanceOfUi = onchain.value;
      }
    }
  }

  const standards: Readonly<Record<TokenStandardId, TokenStandardObservation>> = Object.freeze({
    erc20_read_surface: observation("erc20_read_surface", "observed"),
    erc165: required.erc165,
    erc8056: required.erc8056,
    erc8056_pending_multiplier: required.pendingMultiplier,
    erc8056_conversion: conversion,
    erc8056_balances: balances,
  });
  return deepFreezeValue(tokenStandardObservationResultSchema.parse({
    asset,
    ...(account === undefined ? {} : { account }),
    block,
    standards: tokenStandardOrder.map((standardId) => standards[standardId]),
    ...(required.values === undefined ? {} : { requiredErc8056: required.values }),
    ...(balanceOfUi === undefined ? {} : { balanceOfUi }),
    ...(calculatedBalance === undefined ? {} : { calculatedBalance }),
  }));
};
