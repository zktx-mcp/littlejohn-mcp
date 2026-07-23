import {
  deepFreezeValue,
  erc20AssetIdentitySchema,
  evmAccountIdentitySchema,
  type ChainAnchor,
  type Erc20AssetIdentity,
  type EvmAccountIdentity,
  type RequiredErc8056Observation,
  type TokenStandardObservationResult,
  type UnsignedDecimal,
} from "../core/index.js";
import { tokenCatalogContractLimits, tokenDisplayTextSchema } from "../token-catalog/contracts.js";
import type { Erc20CallEncoder } from "./evm-standard.js";
import {
  decodeErc20BalanceOfResult,
  decodeErc20DecimalsResult,
  decodeErc20TextResult,
  decodeErc20TotalSupplyResult,
} from "./evm-standard.js";
import {
  readConfiguredCanonicalBlock,
  resolveConfiguredCanonicalBlock,
  type CanonicalBlock,
} from "./canonical-block.js";
import { ChainOperationError, getChainOperationFailure } from "./errors.js";
import {
  getChainInvocationStopReason,
  type ChainInvocationContext,
  type ChainInvocationLifecycle,
} from "./invocation-lifecycle.js";
import { normalizeRpcBytes, rpcQuantityToUnsignedDecimal } from "./normalization.js";
import {
  getChainRpcErrorCode,
  isRpcExecutionRevertedError,
  type RpcCanonicalBlockReference,
  type RpcRequester,
} from "./rpc.js";
import {
  completeTokenStandardObservation,
  observeRequiredErc8056,
} from "./token-standards.js";

export type CurrentTokenText =
  | Readonly<{ status: "available"; value: string }>
  | Readonly<{ status: "unavailable"; reason: "call_failed" | "malformed" | "unsafe_text" }>;

export interface CurrentAccountTokenRead {
  readonly asset: Erc20AssetIdentity;
  readonly name: CurrentTokenText;
  readonly symbol: CurrentTokenText;
  readonly decimals: UnsignedDecimal | null;
  readonly rawBalance: UnsignedDecimal;
  readonly requiredStandards: RequiredErc8056Observation;
}

export interface CurrentAccountAssetCollectionRead {
  readonly account: EvmAccountIdentity;
  readonly block: ChainAnchor;
  readonly nativeRawBalance: UnsignedDecimal;
  readonly tokens: readonly CurrentAccountTokenRead[];
}

export interface CurrentAccountAssetExactRead extends CurrentAccountTokenRead {
  readonly account: EvmAccountIdentity;
  readonly block: ChainAnchor;
  readonly totalSupply: UnsignedDecimal;
  readonly standards: TokenStandardObservationResult;
}

export interface AccountAssetChainReadPort {
  resolveCurrentBlock(context: ChainInvocationContext): Promise<CanonicalBlock>;
  readCollectionAtBlock(input: Readonly<{
    account: EvmAccountIdentity;
    assets: readonly Erc20AssetIdentity[];
    block: CanonicalBlock;
  }>, context: ChainInvocationContext): Promise<CurrentAccountAssetCollectionRead>;
  readExactAtBlock(input: Readonly<{
    account: EvmAccountIdentity;
    asset: Erc20AssetIdentity;
    block: CanonicalBlock;
  }>, context: ChainInvocationContext): Promise<CurrentAccountAssetExactRead>;
}

interface Dependencies {
  readonly rpc: RpcRequester;
  readonly encoder: Erc20CallEncoder;
  readonly chainId: ChainAnchor["chainId"];
  readonly lifecycle: ChainInvocationLifecycle;
}

const normalizeFailure = (error: unknown, callerSignal: AbortSignal): never => {
  const stopReason = getChainInvocationStopReason(error);
  if (stopReason !== undefined) {
    throw new ChainOperationError(stopReason === "caller_aborted" ? "request_aborted" : "source_unavailable");
  }
  const operationFailure = getChainOperationFailure(error);
  if (operationFailure !== undefined) throw error;
  const rpcCode = getChainRpcErrorCode(error);
  if (rpcCode !== undefined) {
    throw new ChainOperationError(
      rpcCode === "request_aborted" && callerSignal.aborted ? "request_aborted" : rpcCode,
    );
  }
  throw error;
};

const requireIdentities = (
  chainId: ChainAnchor["chainId"],
  accountInput: EvmAccountIdentity,
  assetsInput: readonly Erc20AssetIdentity[],
  blockInput: CanonicalBlock,
  context: ChainInvocationContext,
): Readonly<{
  account: EvmAccountIdentity;
  assets: readonly Erc20AssetIdentity[];
  block: ChainAnchor;
  reference: RpcCanonicalBlockReference;
}> => {
  const account = evmAccountIdentitySchema.parse(accountInput) as EvmAccountIdentity;
  const assets = Object.freeze(assetsInput.map((asset) =>
    erc20AssetIdentitySchema.parse(asset) as Erc20AssetIdentity));
  const block = readConfiguredCanonicalBlock({
    context,
    block: blockInput,
    chainId,
  });
  if (
    account.chainId !== chainId ||
    assets.some((asset) => asset.chainId !== chainId) ||
    new Set(assets.map((asset) => asset.address)).size !== assets.length
  ) throw new TypeError("Account asset chain-read identities are invalid.");
  return Object.freeze({
    account,
    assets,
    block: block.anchor,
    reference: block.stateReference,
  });
};

const readText = async (
  dependencies: Dependencies,
  asset: Erc20AssetIdentity,
  reference: RpcCanonicalBlockReference,
  signal: AbortSignal,
  field: "name" | "symbol",
): Promise<CurrentTokenText> => {
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
      tokenCatalogContractLimits.displayTextUtf8Bytes,
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

const readDecimals = async (
  dependencies: Dependencies,
  asset: Erc20AssetIdentity,
  reference: RpcCanonicalBlockReference,
  signal: AbortSignal,
): Promise<UnsignedDecimal | null> => {
  let raw: unknown;
  try {
    raw = await dependencies.rpc.request("eth_call", [{
      to: asset.address,
      data: dependencies.encoder.decimals(),
    }, reference], signal);
  } catch (error) {
    if (isRpcExecutionRevertedError(error)) return null;
    throw error;
  }
  try { return decodeErc20DecimalsResult(normalizeRpcBytes(raw)); }
  catch { return null; }
};

const readRequiredUint256 = async (
  dependencies: Dependencies,
  asset: Erc20AssetIdentity,
  reference: RpcCanonicalBlockReference,
  signal: AbortSignal,
  data: ReturnType<Erc20CallEncoder["balanceOf"]>,
  decode: (input: unknown) => UnsignedDecimal,
): Promise<UnsignedDecimal> => {
  let raw: unknown;
  try {
    raw = await dependencies.rpc.request("eth_call", [{ to: asset.address, data }, reference], signal);
  } catch (error) {
    if (isRpcExecutionRevertedError(error)) throw new ChainOperationError("source_inconsistent");
    throw error;
  }
  try { return decode(normalizeRpcBytes(raw)); }
  catch { throw new ChainOperationError("source_inconsistent"); }
};

const readToken = async (
  dependencies: Dependencies,
  account: EvmAccountIdentity,
  asset: Erc20AssetIdentity,
  block: ChainAnchor,
  reference: RpcCanonicalBlockReference,
  signal: AbortSignal,
): Promise<CurrentAccountTokenRead> => {
  const [name, symbol, decimals, rawBalance, requiredStandards] = await Promise.all([
    readText(dependencies, asset, reference, signal, "name"),
    readText(dependencies, asset, reference, signal, "symbol"),
    readDecimals(dependencies, asset, reference, signal),
    readRequiredUint256(
      dependencies,
      asset,
      reference,
      signal,
      dependencies.encoder.balanceOf(account.address),
      decodeErc20BalanceOfResult,
    ),
    observeRequiredErc8056({
      rpc: dependencies.rpc,
      asset,
      block,
      stateReference: reference,
      signal,
    }),
  ]);
  return deepFreezeValue({ asset, name, symbol, decimals, rawBalance, requiredStandards });
};

const readTokensInOrder = async (
  dependencies: Dependencies,
  account: EvmAccountIdentity,
  assets: readonly Erc20AssetIdentity[],
  block: ChainAnchor,
  reference: RpcCanonicalBlockReference,
  signal: AbortSignal,
): Promise<readonly CurrentAccountTokenRead[]> => {
  const tokens: CurrentAccountTokenRead[] = [];
  for (const asset of assets) {
    tokens.push(await readToken(dependencies, account, asset, block, reference, signal));
  }
  return Object.freeze(tokens);
};

export const createAccountAssetChainReadPort = (
  dependencies: Dependencies,
): AccountAssetChainReadPort => Object.freeze({
  async resolveCurrentBlock(context: ChainInvocationContext) {
    dependencies.lifecycle.assertActiveContext(context);
    try {
      return await resolveConfiguredCanonicalBlock({
        rpc: dependencies.rpc,
        chainId: dependencies.chainId,
        selector: { kind: "latest" },
        context,
      });
    } catch (error) { return normalizeFailure(error, context.signal); }
  },

  async readCollectionAtBlock(input: Readonly<{
    account: EvmAccountIdentity;
    assets: readonly Erc20AssetIdentity[];
    block: CanonicalBlock;
  }>, context: ChainInvocationContext) {
    dependencies.lifecycle.assertActiveContext(context);
    try {
      const identities = requireIdentities(
        dependencies.chainId,
        input.account,
        input.assets,
        input.block,
        context,
      );
      const [nativeRawBalance, tokens] = await Promise.all([
        dependencies.rpc.request(
          "eth_getBalance",
          [identities.account.address, identities.reference],
          context.signal,
        ).then(rpcQuantityToUnsignedDecimal),
        readTokensInOrder(
          dependencies,
          identities.account,
          identities.assets,
          identities.block,
          identities.reference,
          context.signal,
        ),
      ]);
      return deepFreezeValue({
        account: identities.account,
        block: identities.block,
        nativeRawBalance,
        tokens,
      });
    } catch (error) { return normalizeFailure(error, context.signal); }
  },

  async readExactAtBlock(input: Readonly<{
    account: EvmAccountIdentity;
    asset: Erc20AssetIdentity;
    block: CanonicalBlock;
  }>, context: ChainInvocationContext) {
    dependencies.lifecycle.assertActiveContext(context);
    try {
      const identities = requireIdentities(
        dependencies.chainId,
        input.account,
        [input.asset],
        input.block,
        context,
      );
      const asset = identities.assets[0] as Erc20AssetIdentity;
      const [token, totalSupply] = await Promise.all([
        readToken(
          dependencies,
          identities.account,
          asset,
          identities.block,
          identities.reference,
          context.signal,
        ),
        readRequiredUint256(
          dependencies,
          asset,
          identities.reference,
          context.signal,
          dependencies.encoder.totalSupply(),
          decodeErc20TotalSupplyResult,
        ),
      ]);
      const standards = await completeTokenStandardObservation({
        rpc: dependencies.rpc,
        asset,
        block: identities.block,
        stateReference: identities.reference,
        signal: context.signal,
        erc20ReadSurfaceObserved: true,
        accountBalance: { account: identities.account, rawBalance: token.rawBalance },
      }, token.requiredStandards);
      return deepFreezeValue({
        ...token,
        account: identities.account,
        block: identities.block,
        totalSupply,
        standards,
      });
    } catch (error) { return normalizeFailure(error, context.signal); }
  },
});
