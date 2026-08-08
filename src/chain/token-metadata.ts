import {
  deepFreezeValue,
  erc20AssetIdentitySchema,
  tokenDisplayTextLimits,
  tokenDisplayTextSchema,
  tokenMetadataReadSchema,
  type Erc20AssetIdentity,
  type OptionalTokenText,
  type TokenMetadataDecimalsRead,
  type TokenMetadataRead,
} from "../core/index.js";
import {
  decodeErc20DecimalsResult,
  decodeErc20TextResult,
  type Erc20CallEncoder,
} from "./evm-standard.js";
import { normalizeRpcBytes } from "./normalization.js";
import {
  isRpcExecutionRevertedError,
  type RpcCanonicalBlockReference,
  type RpcRequester,
} from "./rpc.js";

interface TokenMetadataReadDependencies {
  readonly rpc: RpcRequester;
  readonly encoder: Erc20CallEncoder;
}

const readOptionalText = async (
  dependencies: TokenMetadataReadDependencies,
  asset: Erc20AssetIdentity,
  reference: RpcCanonicalBlockReference,
  signal: AbortSignal,
  field: "name" | "symbol",
): Promise<OptionalTokenText> => {
  let raw: unknown;
  try {
    raw = await dependencies.rpc.request("eth_call", [{
      to: asset.address,
      data: dependencies.encoder[field](),
    }, reference], signal);
  } catch (error) {
    if (isRpcExecutionRevertedError(error)) {
      return Object.freeze({ status: "unavailable", reason: "call_failed" });
    }
    throw error;
  }

  let decoded: ReturnType<typeof decodeErc20TextResult>;
  try {
    decoded = decodeErc20TextResult(
      normalizeRpcBytes(raw),
      field,
      tokenDisplayTextLimits.utf8Bytes,
    );
  } catch {
    return Object.freeze({ status: "unavailable", reason: "malformed" });
  }
  if (decoded.status === "byte_limit_exceeded") {
    return Object.freeze({ status: "unavailable", reason: "unsafe_text" });
  }
  const parsed = tokenDisplayTextSchema.safeParse(decoded.value);
  return parsed.success
    ? Object.freeze({ status: "available", value: parsed.data })
    : Object.freeze({ status: "unavailable", reason: "unsafe_text" });
};

const readOptionalDecimals = async (
  dependencies: TokenMetadataReadDependencies,
  asset: Erc20AssetIdentity,
  reference: RpcCanonicalBlockReference,
  signal: AbortSignal,
): Promise<TokenMetadataDecimalsRead> => {
  let raw: unknown;
  try {
    raw = await dependencies.rpc.request("eth_call", [{
      to: asset.address,
      data: dependencies.encoder.decimals(),
    }, reference], signal);
  } catch (error) {
    if (isRpcExecutionRevertedError(error)) {
      return Object.freeze({ status: "unavailable", reason: "call_failed" });
    }
    throw error;
  }
  try {
    return Object.freeze({
      status: "available",
      value: decodeErc20DecimalsResult(normalizeRpcBytes(raw)),
    });
  } catch {
    return Object.freeze({ status: "unavailable", reason: "malformed" });
  }
};

export const readTokenMetadataAtBlock = async (
  dependencies: TokenMetadataReadDependencies,
  input: Readonly<{
    asset: Erc20AssetIdentity;
    stateReference: RpcCanonicalBlockReference;
    signal: AbortSignal;
  }>,
): Promise<TokenMetadataRead> => {
  const asset = erc20AssetIdentitySchema.parse(input.asset) as Erc20AssetIdentity;
  const stop = new AbortController();
  const signal = AbortSignal.any([input.signal, stop.signal]);
  const calls = [
    readOptionalText(dependencies, asset, input.stateReference, signal, "name"),
    readOptionalText(dependencies, asset, input.stateReference, signal, "symbol"),
    readOptionalDecimals(dependencies, asset, input.stateReference, signal),
  ] as const;

  try {
    const [name, symbol, decimals] = await Promise.all(calls);
    return deepFreezeValue(tokenMetadataReadSchema.parse({ name, symbol, decimals }));
  } catch (error) {
    stop.abort();
    await Promise.allSettled(calls);
    throw error;
  }
};
