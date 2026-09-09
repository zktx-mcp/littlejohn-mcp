import { uniswapV4PackageRegistration, uniswapV4ActionSupport } from "./uniswap-v4/register.js";
import { uniswapV4PoolsCapability } from "./uniswap-v4/pools.js";
import type { OfficialAssetSynchronizationPort } from "../registry/index.js";
import type { ObservationAuthority } from "../core/index.js";
import type {
  ChainInvocationPort,
  PinnedEvmReadPort,
} from "../chain/index.js";
import {
  CapabilityBindingRegistry,
  compareCodePointSequences,
  CapabilityRegistry,
  getCapabilityDefinitionSnapshot,
  type CapabilityBinding,
  type CapabilityInvocationAuthority,
  type InvocationBoundaryPorts,
} from "../core/index.js";
import type { HttpOwnerApplication } from "../runtime/http-owner.js";
import type { RuntimeRouteRegistry } from "../runtime/http-routing.js";
import {
  createProtocolRegistrySupportExtension,
  type ProtocolSupportExtension,
} from "./application.js";
import { ProtocolRegistry } from "./registry.js";
import {
  uniswapV2PackageRegistration,
  uniswapV2QuoteCapability,
} from "./uniswap-v2/index.js";

const internalReadAvailability = Object.freeze({
  overall: "internal" as const,
  direct: "internal" as const,
  http: "unavailable" as const,
  mcp: "unavailable" as const,
  cli: "unavailable" as const,
});

export interface ProtocolOwnerApplication extends HttpOwnerApplication {
  readonly supportExtension: ProtocolSupportExtension;
  readonly uniswapV2Quote: CapabilityBinding<typeof uniswapV2QuoteCapability>;
  readonly uniswapV4Pools: CapabilityBinding<typeof uniswapV4PoolsCapability>;
}

export interface ProtocolOwnerApplicationInput {
  readonly routes: RuntimeRouteRegistry;
  readonly officialAssets: OfficialAssetSynchronizationPort;
  readonly officialAssetObservationAuthority: ObservationAuthority;
  readonly invocations: ChainInvocationPort;
  readonly reads: PinnedEvmReadPort;
  readonly invocationAuthority: CapabilityInvocationAuthority;
  readonly invocationPorts: InvocationBoundaryPorts;
}

export const createProtocolOwnerApplication = (
  input: ProtocolOwnerApplicationInput,
): ProtocolOwnerApplication => {
  const registration = uniswapV2PackageRegistration;
  const registry = new ProtocolRegistry(
    [registration.family],
    [registration.package, uniswapV4PackageRegistration.package],
  );
  const quote = registration.createApplication({
    invocations: input.invocations,
    reads: input.reads,
    invocationAuthority: input.invocationAuthority,
    invocationPorts: input.invocationPorts,
  });
  const pools = uniswapV4PackageRegistration.createApplication(input);
  new CapabilityBindingRegistry(
    new CapabilityRegistry([registration.capability, uniswapV4PoolsCapability]),
    [quote.binding, pools],
  );
  const capabilityId = getCapabilityDefinitionSnapshot(
    registration.capability,
  ).capabilityId;
  return Object.freeze({
    routes: input.routes,
    supportExtension: createProtocolRegistrySupportExtension(registry, {
      transactionActions: uniswapV4ActionSupport,
      capabilities: [{
        capabilityId,
        availability: internalReadAvailability,
      }, { capabilityId: getCapabilityDefinitionSnapshot(uniswapV4PoolsCapability).capabilityId, availability: internalReadAvailability }],
    }),
    uniswapV2Quote: quote.binding,
    uniswapV4Pools: pools,
    close: async (): Promise<void> => undefined,
  });
};
