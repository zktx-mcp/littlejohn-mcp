import {
  chainReadCapabilities,
  getCapabilityDefinitionSnapshot,
} from "../core/index.js";
import {
  extendChainRuntimeSupportManifest,
  type ChainOwnerApplication,
  type ChainOwnerApplicationFactory,
  type ChainRuntimeSupportManifest,
  type WalletRuntimeSupportManifest,
} from "../runtime/index.js";
import type { ActiveWalletReadPort } from "../wallet/coordinator.js";
import { createErc20CallEncoder, type Erc20CallEncoder } from "./erc20-calls.js";
import { createChainReadService } from "./handlers.js";
import { createBoundedRpcRequester, type RpcRequester } from "./rpc.js";

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
    const rpc = createRequester(context.chain.configuredRpcUri);
    if (typeof rpc !== "object" || rpc === null || typeof rpc.request !== "function") {
      throw new TypeError("Chain RPC requester is invalid.");
    }
    const encoder = await createEncoder();
    if (
      typeof encoder !== "object" ||
      encoder === null ||
      typeof encoder.balanceOf !== "function" ||
      typeof encoder.decimals !== "function"
    ) {
      throw new TypeError("ERC-20 call encoder is invalid.");
    }
    const service = createChainReadService({ context, rpc, encoder });
    return Object.freeze({
      routes: context.routes,
      supportManifest: extendChainSupportManifest(context.supportManifest),
      chainReads: service.chainReads,
      close: () => service.close(),
    });
  };
};

export const createChainOwnerApplication = createChainOwnerApplicationFactory(
  (url) => createBoundedRpcRequester({ url }),
  createErc20CallEncoder,
);
