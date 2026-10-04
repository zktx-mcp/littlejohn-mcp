import { uniswapV4PackageRegistration, uniswapV4ActionSupport } from "./uniswap-v4/register.js";
import { uniswapV3PackageRegistration } from "./uniswap-v3/register.js";
import { createPoolPriceReadSession } from "./pool-price-reads.js";
import type { PoolPriceReadPort, PoolPriceSessionPort } from "./pool-price-port.js";
import { createEvmAbiCodec } from "../chain/index.js";
import { uniswapV4PoolsCapability } from "./uniswap-v4/pools.js";
import type { OfficialAssetReadPort } from "../registry/index.js";
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
  readonly poolPrices: PoolPriceReadPort;
}

export interface ProtocolOwnerApplicationInput {
  readonly routes: RuntimeRouteRegistry;
  readonly officialAssets: OfficialAssetReadPort;
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
    [registration.package, uniswapV3PackageRegistration.package, uniswapV4PackageRegistration.package],
  );
  const quote = registration.createApplication({
    invocations: input.invocations,
    reads: input.reads,
    invocationAuthority: input.invocationAuthority,
    invocationPorts: input.invocationPorts,
  });
  const pools = uniswapV4PackageRegistration.createApplication(input);
  const codec = createEvmAbiCodec();
  const poolPrices: PoolPriceReadPort = Object.freeze({
    observationAuthority: input.reads.observationAuthority,
    createSession(context: Parameters<PoolPriceReadPort["createSession"]>[0], block: Parameters<PoolPriceReadPort["createSession"]>[1]) {
      const session = createPoolPriceReadSession({ context, block, reads: input.reads });
      return Object.freeze({ async read(request: Parameters<PoolPriceSessionPort["read"]>[0]) {
        const args = { ...request, session, codec };
        switch (request.protocol) {
          case "uniswap_v2": return registration.readPoolPrice(args);
          case "uniswap_v3": return uniswapV3PackageRegistration.readPoolPrice(args);
          case "uniswap_v4": return uniswapV4PackageRegistration.readPoolPrice(args);
        }
      } });
    },
  });
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
    poolPrices,
    close: async (): Promise<void> => undefined,
  });
};
