import {
  chainReadCapabilities,
  getCapabilityDefinitionSnapshot,
} from "../core/index.js";
import {
  extendChainRuntimeSupportManifest,
  readConfiguredRpcEndpoint,
  type ChainOwnerApplication,
  type ChainOwnerApplicationFactory,
  type ChainRuntimeSupportManifest,
  type WalletRuntimeSupportManifest,
} from "../runtime/index.js";
import type { ActiveWalletReadPort } from "../wallet/coordinator.js";
import { createErc20CallEncoder, type Erc20CallEncoder } from "./evm-standard.js";
import { createAccountAssetChainReadPort } from "./account-assets.js";
import { createChainReadService } from "./handlers.js";
import { createChainInvocationLifecycle } from "./invocation-lifecycle.js";
import { createOfficialAssetChainReadPort } from "./official-assets.js";
import { createBoundedRpcRequester, type RpcRequester } from "./rpc.js";
import { createTokenInspectionService } from "./token-inspection.js";

const internalReadAvailability = Object.freeze({
  overall: "internal" as const,
  direct: "internal" as const,
  http: "unavailable" as const,
  mcp: "unavailable" as const,
  cli: "unavailable" as const,
  web: "unavailable" as const,
});

export type ChainRpcRequesterFactory = (url: string) => RpcRequester;
export type ChainErc20CallEncoderFactory = () => Promise<Erc20CallEncoder>;

export const extendChainSupportManifest = (
  parent: WalletRuntimeSupportManifest,
): ChainRuntimeSupportManifest => extendChainRuntimeSupportManifest(parent, {
  registrations: [],
  changes: chainReadCapabilities.map((definition) => ({
    capabilityId: getCapabilityDefinitionSnapshot(definition).capabilityId,
    availability: internalReadAvailability,
  })),
});

export const createChainOwnerApplicationFactory = (
  createRequester: ChainRpcRequesterFactory,
  createEncoder: ChainErc20CallEncoderFactory,
): ChainOwnerApplicationFactory<ActiveWalletReadPort> => {
  if (typeof createRequester !== "function" || typeof createEncoder !== "function") {
    throw new TypeError("Chain application factories are invalid.");
  }
  return async (context): Promise<ChainOwnerApplication> => {
    const rpc = createRequester(
      readConfiguredRpcEndpoint(context.chain.configuration.endpoint).exactUri,
    );
    if (typeof rpc !== "object" || rpc === null || typeof rpc.request !== "function") {
      throw new TypeError("Chain RPC requester is invalid.");
    }
    const encoder = await createEncoder();
    if (
      typeof encoder !== "object" ||
      encoder === null ||
      typeof encoder.balanceOf !== "function" ||
      typeof encoder.decimals !== "function" ||
      typeof encoder.name !== "function" ||
      typeof encoder.symbol !== "function" ||
      typeof encoder.totalSupply !== "function"
    ) {
      throw new TypeError("ERC-20 call encoder is invalid.");
    }
    const lifecycle = createChainInvocationLifecycle(context.signal);
    let service: ReturnType<typeof createChainReadService>;
    let tokenInspection: ReturnType<typeof createTokenInspectionService>;
    let officialAssetReads: ReturnType<typeof createOfficialAssetChainReadPort>;
    let accountAssetReads: ReturnType<typeof createAccountAssetChainReadPort>;
    try {
      service = createChainReadService({ context, rpc, encoder, lifecycle });
      tokenInspection = createTokenInspectionService({ context, rpc, encoder, lifecycle });
      officialAssetReads = createOfficialAssetChainReadPort({
        rpc,
        chainId: context.chain.configuration.chain.chainId,
        lifecycle,
      });
      accountAssetReads = createAccountAssetChainReadPort({
        rpc,
        encoder,
        chainId: context.chain.configuration.chain.chainId,
        lifecycle,
      });
    } catch (error) {
      await lifecycle.close();
      throw error;
    }
    return Object.freeze({
      routes: context.routes,
      supportManifest: extendChainSupportManifest(context.supportManifest),
      chainReads: service.chainReads,
      tokenInspection: tokenInspection.binding,
      officialAssetReads,
      accountAssetReads,
      close: () => lifecycle.close(),
    });
  };
};

export const createChainOwnerApplication = createChainOwnerApplicationFactory(
  (url) => createBoundedRpcRequester({ url }),
  createErc20CallEncoder,
);
