import type {
  ChainInvocationPort,
  PinnedEvmReadPort,
} from "../chain/index.js";
import {
  CapabilityBindingRegistry,
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
  web: "unavailable" as const,
});

export interface ProtocolOwnerApplication extends HttpOwnerApplication {
  readonly supportExtension: ProtocolSupportExtension;
  readonly uniswapV2Quote: CapabilityBinding<typeof uniswapV2QuoteCapability>;
}

export interface ProtocolOwnerApplicationInput {
  readonly routes: RuntimeRouteRegistry;
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
    [registration.package],
  );
  const quote = registration.createApplication({
    invocations: input.invocations,
    reads: input.reads,
    invocationAuthority: input.invocationAuthority,
    invocationPorts: input.invocationPorts,
  });
  new CapabilityBindingRegistry(
    new CapabilityRegistry([registration.capability]),
    [quote.binding],
  );
  const capabilityId = getCapabilityDefinitionSnapshot(
    registration.capability,
  ).capabilityId;
  return Object.freeze({
    routes: input.routes,
    supportExtension: createProtocolRegistrySupportExtension(registry, {
      capabilities: [{
        capabilityId,
        availability: internalReadAvailability,
      }],
    }),
    uniswapV2Quote: quote.binding,
    close: async (): Promise<void> => undefined,
  });
};
