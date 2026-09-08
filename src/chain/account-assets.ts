import {
  deepFreezeValue,
  erc20AssetIdentitySchema,
  evmAccountIdentitySchema,
  type ChainAnchor,
  type Erc20AssetIdentity,
  type EvmAccountIdentity,
  type RequiredErc8056Observation,
  type OptionalTokenText,
  type TokenMetadataRead,
  type UnsignedDecimal,
} from "../core/index.js";
import type { Erc20CallEncoder } from "./evm-standard.js";
import { decodeAbiUint256Result } from "./evm-standard.js";
import {
  readConfiguredCanonicalBlock,
  type CanonicalBlock,
} from "./canonical-block.js";
import { admitChainReadFailure, ChainOperationError } from "./errors.js";
import {
  type ChainInvocationContext,
  type ChainInvocationLifecycle,
} from "./invocation-lifecycle.js";
import { normalizeRpcBytes, rpcQuantityToUnsignedDecimal } from "./normalization.js";
import {
  ChainRpcError,
  isRpcExecutionRevertedError,
  type ChainRpcMethod,
  type ChainRpcRequestMap,
  type RpcCanonicalBlockReference,
  type RpcRequester,
} from "./rpc.js";
import { observeRequiredErc8056 } from "./token-standards.js";
import { readTokenMetadataAtBlock } from "./token-metadata.js";

export interface CurrentAccountTokenRead {
  readonly asset: Erc20AssetIdentity;
  readonly name: OptionalTokenText;
  readonly symbol: OptionalTokenText;
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

export interface AccountAssetChainReadPort {
  readCollectionAtBlock(input: Readonly<{
    account: EvmAccountIdentity;
    assets: readonly Erc20AssetIdentity[];
    block: CanonicalBlock;
  }>, context: ChainInvocationContext): Promise<CurrentAccountAssetCollectionRead>;
}

interface Dependencies {
  readonly rpc: RpcRequester;
  readonly encoder: Erc20CallEncoder;
  readonly chainId: ChainAnchor["chainId"];
  readonly lifecycle: ChainInvocationLifecycle;
}

const accountAssetTokenReadConcurrency = 5;
const accountAssetRpcConcurrency = 8;

interface QueuedRpcRequest {
  cancelled: boolean;
  readonly removeAbortListener: () => void;
  readonly run: () => Promise<void>;
}

const createAccountAssetRpcRequester = (
  upstream: RpcRequester,
): RpcRequester => {
  const queue: QueuedRpcRequest[] = [];
  let active = 0;

  const drain = (): void => {
    while (active < accountAssetRpcConcurrency) {
      const request = queue.shift();
      if (request === undefined) return;
      if (request.cancelled) continue;
      request.removeAbortListener();
      active += 1;
      void request.run().finally(() => {
        active -= 1;
        drain();
      });
    }
  };

  return Object.freeze({
    request<Method extends ChainRpcMethod>(
      method: Method,
      params: ChainRpcRequestMap[Method],
      signal: AbortSignal,
    ): Promise<unknown> {
      if (!(signal instanceof AbortSignal)) {
        return Promise.reject(new TypeError("RPC abort signal is invalid."));
      }
      if (signal.aborted) return Promise.reject(new ChainRpcError("request_aborted"));
      return new Promise<unknown>((resolve, reject) => {
        const onAbort = (): void => {
          request.cancelled = true;
          reject(new ChainRpcError("request_aborted"));
        };
        const request: QueuedRpcRequest = {
          cancelled: false,
          removeAbortListener: () => signal.removeEventListener("abort", onAbort),
          run: async () => {
            try { resolve(await upstream.request(method, params, signal)); }
            catch (error) { reject(error); }
          },
        };
        signal.addEventListener("abort", onAbort, { once: true });
        queue.push(request);
        drain();
      });
    },
  } satisfies RpcRequester);
};

const normalizeFailure = (error: unknown, callerSignal: AbortSignal): never => {
  const failure = admitChainReadFailure(error, callerSignal);
  if (failure !== undefined) throw new ChainOperationError(failure);
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
  const stop = new AbortController();
  const callSignal = AbortSignal.any([signal, stop.signal]);
  const calls = [
    readTokenMetadataAtBlock(dependencies, {
      asset,
      stateReference: reference,
      signal: callSignal,
    }),
    readRequiredUint256(
      dependencies,
      asset,
      reference,
      callSignal,
      dependencies.encoder.balanceOf(account.address),
      decodeAbiUint256Result,
    ),
    observeRequiredErc8056({
      rpc: dependencies.rpc,
      asset,
      block,
      stateReference: reference,
      signal: callSignal,
    }),
  ] as const;
  let results: [TokenMetadataRead, UnsignedDecimal, RequiredErc8056Observation];
  try {
    results = await Promise.all(calls);
  } catch (error) {
    stop.abort();
    await Promise.allSettled(calls);
    throw error;
  }
  const [metadata, rawBalance, requiredStandards] = results;
  return deepFreezeValue({
    asset,
    name: metadata.name,
    symbol: metadata.symbol,
    decimals: metadata.decimals.status === "available" ? metadata.decimals.value : null,
    rawBalance,
    requiredStandards,
  });
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
  for (
    let start = 0;
    start < assets.length;
    start += accountAssetTokenReadConcurrency
  ) {
    if (signal.aborted) throw new ChainOperationError("request_aborted");
    const batch = assets.slice(start, start + accountAssetTokenReadConcurrency);
    const settled = await Promise.allSettled(batch.map((asset) =>
      readToken(dependencies, account, asset, block, reference, signal)));
    const failure = settled.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure !== undefined) throw failure.reason;
    for (const result of settled) {
      if (result.status === "fulfilled") tokens.push(result.value);
    }
  }
  return Object.freeze(tokens);
};

export const createAccountAssetChainReadPort = (
  dependencies: Dependencies,
): AccountAssetChainReadPort => Object.freeze({
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
      const stop = new AbortController();
      const callSignal = AbortSignal.any([context.signal, stop.signal]);
      const rpc = createAccountAssetRpcRequester(dependencies.rpc);
      const readDependencies = Object.freeze({ ...dependencies, rpc });
      const calls = [
        rpc.request(
          "eth_getBalance",
          [identities.account.address, identities.reference],
          callSignal,
        ).then(rpcQuantityToUnsignedDecimal),
        readTokensInOrder(
          readDependencies,
          identities.account,
          identities.assets,
          identities.block,
          identities.reference,
          callSignal,
        ),
      ] as const;
      let results: [UnsignedDecimal, readonly CurrentAccountTokenRead[]];
      try {
        results = await Promise.all(calls);
      } catch (error) {
        stop.abort();
        await Promise.allSettled(calls);
        throw error;
      }
      const [nativeRawBalance, tokens] = results;
      return deepFreezeValue({
        account: identities.account,
        block: identities.block,
        nativeRawBalance,
        tokens,
      });
    } catch (error) { return normalizeFailure(error, context.signal); }
  },
});
