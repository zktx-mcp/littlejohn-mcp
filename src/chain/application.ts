import {chainReadCapabilities} from "./read-capabilities.js";
import {getCapabilityDefinitionSnapshot} from "../core/index.js";
import { extendChainRuntimeSupportManifest, type RuntimeSupportManifest } from "../runtime/support-manifest.js";
import { readConfiguredRpcEndpoint } from "../runtime/configuration.js";
import type {
  ChainOwnerApplicationContext,
  ChainReadCapabilityPort,
} from "../runtime/application-context.js";
import type {
  TokenAdditionChainReadPort,
  TokenCatalogInspectionPort,
} from "../token-catalog/ports.js";
import type { HttpOwnerApplication } from "../runtime/http-owner.js";
import type { ActiveWalletReadPort } from "../wallet/coordinator.js";
import {
  createAddressTargetResolver,
  type AddressTargetResolverPort,
} from "./address-target.js";
import { createErc20CallEncoder, type Erc20CallEncoder } from "./evm-standard.js";
import { createAccountAssetChainReadPort } from "./account-assets.js";
import { createCurrentBlockReadPort } from "./canonical-block.js";
import { createChainReadService } from "./handlers.js";
import {
  createChainInvocationLifecycle,
  type ChainInvocationPort,
} from "./invocation-lifecycle.js";
import { createOfficialAssetChainReadPort } from "./official-assets.js";
import {
  createPinnedEvmReadPort,
  type PinnedEvmReadPort,
} from "./protocol-reads.js";
import { createBoundedRpcRequester, type RpcRequester } from "./rpc.js";
import { createTokenInspectionService } from "./token-inspection.js";
import { createTransactionChainReadPort, type TransactionChainReadPort } from "./transaction-reads.js";

const internalReadAvailability = Object.freeze({
  overall: "internal" as const,
  direct: "internal" as const,
  http: "unavailable" as const,
  mcp: "unavailable" as const,
  cli: "unavailable" as const,
});

export type ChainRpcRequesterFactory = (url: string) => RpcRequester;
export type ChainErc20CallEncoderFactory = () => Promise<Erc20CallEncoder>;

export interface ChainOwnerApplication extends HttpOwnerApplication {
  readonly supportManifest: RuntimeSupportManifest;
  readonly addressTargets: AddressTargetResolverPort;
  readonly invocations: ChainInvocationPort;
  readonly chainReads: ChainReadCapabilityPort;
  readonly tokenInspection: TokenCatalogInspectionPort;
  readonly tokenAdditionReads: TokenAdditionChainReadPort;
  readonly officialAssetReads: ReturnType<typeof createOfficialAssetChainReadPort>;
  readonly accountAssetReads: ReturnType<typeof createAccountAssetChainReadPort>;
  readonly currentBlockReads: ReturnType<typeof createCurrentBlockReadPort>;
  readonly protocolReads: PinnedEvmReadPort;
  readonly transactions: TransactionChainReadPort;
}

export type ChainOwnerApplicationFactory<ActiveWallet extends object> = (
  context: ChainOwnerApplicationContext<ActiveWallet>,
) => Promise<ChainOwnerApplication> | ChainOwnerApplication;

export const extendChainSupportManifest = (
  parent: RuntimeSupportManifest,
): RuntimeSupportManifest => extendChainRuntimeSupportManifest(parent, {
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
    let addressTargets: AddressTargetResolverPort;
    let officialAssetReads: ReturnType<typeof createOfficialAssetChainReadPort>;
    let tokenInspection: ReturnType<typeof createTokenInspectionService>;
    let accountAssetReads: ReturnType<typeof createAccountAssetChainReadPort>;
    let currentBlockReads: ReturnType<typeof createCurrentBlockReadPort>;
    let protocolReads: PinnedEvmReadPort;
    let transactions: TransactionChainReadPort;
    try {
      addressTargets = createAddressTargetResolver({
        chainId: context.chain.configuration.chain.chainId,
        activeWallet: context.activeWallet,
      });
      service = createChainReadService({
        context,
        rpc,
        encoder,
        lifecycle,
        addressTargets,
      });
      officialAssetReads = createOfficialAssetChainReadPort({
        rpc,
        chainId: context.chain.configuration.chain.chainId,
        lifecycle,
      });
      tokenInspection = createTokenInspectionService({
        context,
        rpc,
        encoder,
        lifecycle,
        officialAssetReads,
      });
      accountAssetReads = createAccountAssetChainReadPort({
        rpc,
        encoder,
        chainId: context.chain.configuration.chain.chainId,
        lifecycle,
      });
      currentBlockReads = createCurrentBlockReadPort({
        rpc,
        chainId: context.chain.configuration.chain.chainId,
        lifecycle,
      });
      protocolReads = createPinnedEvmReadPort({
        rpc,
        chainId: context.chain.configuration.chain.chainId,
        lifecycle,
        erc20Encoder: encoder,
        contractSourceVerification: context.chain.contractSourceVerification,
        observationAuthority: context.chain.sourceAuthority.observationAuthority,
      });
      transactions = createTransactionChainReadPort({ rpc, lifecycle, chainId: context.chain.configuration.chain.chainId,
        observationAuthority: context.chain.sourceAuthority.observationAuthority });
    } catch (error) {
      await lifecycle.close();
      throw error;
    }
    return Object.freeze({
      routes: context.routes,
      supportManifest: extendChainSupportManifest(context.supportManifest),
      addressTargets,
      invocations: Object.freeze({ run: lifecycle.run }),
      chainReads: service.chainReads,
      tokenInspection: tokenInspection.binding,
      tokenAdditionReads: tokenInspection.additionReads,
      officialAssetReads,
      accountAssetReads,
      currentBlockReads,
      protocolReads,
      transactions,
      close: () => lifecycle.close(),
    });
  };
};

export const createChainOwnerApplication = createChainOwnerApplicationFactory(
  (url) => createBoundedRpcRequester({ url }),
  createErc20CallEncoder,
);
