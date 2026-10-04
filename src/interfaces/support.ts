import { exchangeBindings, activityBindings } from "./exchange-bindings.js";
import { signingBindings } from "./signing-bindings.js";
import {
  compareCodePointSequences,
} from "../core/index.js";
import { composeCapabilityCatalog, createCapabilityAvailability, createCapabilityCatalogSchema, extendInterfaceRuntimeSupportManifest, readRuntimeSupportManifest, type CapabilityCatalog, type CapabilityAvailabilityInput, type RuntimeSupportManifest } from "../runtime/support-manifest.js";
import { presentationContractRegistry } from "./mcp-app/registry.js";
import {
  operationInterfaceBindingList,
  type OperationInterfaceBinding,
} from "./operation-bindings.js";
import {
  interfaceReadCapabilityRegistry,
  accountAssetInterfaceBindingList,
  readInterfaceIdentities,
  uniswapV4PoolsInterface,
  tokenCatalogInterfaceBindingList,
  type ReadInterfaceIdentity,
  type TokenCatalogInterfaceBinding,
  type AccountAssetInterfaceBinding,
} from "./identities.js";

const interfaceCapabilityCatalogContractVersion = "1" as const;

export const interfaceCapabilityCatalogSchema = createCapabilityCatalogSchema(
  interfaceReadCapabilityRegistry,
  interfaceCapabilityCatalogContractVersion,
);

export const composeInterfaceCapabilityCatalog = (
  manifest: RuntimeSupportManifest,
): CapabilityCatalog => composeCapabilityCatalog(
  interfaceReadCapabilityRegistry,
  manifest,
  interfaceCapabilityCatalogContractVersion,
);

const readBindingAvailability = (
  identity: ReadInterfaceIdentity,
): CapabilityAvailabilityInput => createCapabilityAvailability({
  direct: "internal",
  http: "available",
  mcp: "available",
  cli: "available",
});

const tokenCatalogBindingAvailability = (
  binding: TokenCatalogInterfaceBinding,
): CapabilityAvailabilityInput => createCapabilityAvailability({
  direct: "internal",
  http: "internal",
  mcp: "available",
  cli: "available",
});

const accountAssetBindingAvailability = (
  binding: AccountAssetInterfaceBinding,
): CapabilityAvailabilityInput => createCapabilityAvailability({
  direct: "internal",
  http: "internal",
  mcp: binding.mcp === undefined ? "unavailable" : "available",
  cli: binding.cli === undefined ? "unavailable" : "available",
});

const operationBindingAvailability = (
  binding: OperationInterfaceBinding,
): CapabilityAvailabilityInput => createCapabilityAvailability({
  direct: "internal",
  http: "internal",
  mcp: "available",
  cli: binding.cli === undefined ? "unavailable" : "available",
});

type InterfaceAvailabilityAxes = Omit<CapabilityAvailabilityInput, "overall">;

export const sameInterfaceAvailabilityAxes = (
  left: InterfaceAvailabilityAxes,
  right: InterfaceAvailabilityAxes,
): boolean => left.direct === right.direct &&
  left.http === right.http &&
  left.mcp === right.mcp &&
  left.cli === right.cli;

export const extendInterfaceSupportManifest = (
  parent: RuntimeSupportManifest,
): RuntimeSupportManifest => {
  const parentCapabilities = new Map<string, CapabilityAvailabilityInput>(readRuntimeSupportManifest(parent).capabilities.map(
    (entry) => [entry.capabilityId, entry.availability] as const,
  ));
  const candidates = [
    { capabilityId: uniswapV4PoolsInterface.capabilityId, availability: createCapabilityAvailability({ direct: "internal", http: "internal", mcp: "available", cli: "available" }) },
    ...accountAssetInterfaceBindingList.map((binding) => ({
      capabilityId: binding.contract.capabilityId,
      availability: accountAssetBindingAvailability(binding),
    })),
    ...readInterfaceIdentities
      .map((identity) => ({
        capabilityId: identity.capabilityId,
        availability: readBindingAvailability(identity),
      })),
    ...tokenCatalogInterfaceBindingList.map((binding) => ({
      capabilityId: binding.contract.capabilityId,
      availability: tokenCatalogBindingAvailability(binding),
    })),
    ...operationInterfaceBindingList.map((binding) => ({
      capabilityId: binding.contract.capabilityId,
      availability: operationBindingAvailability(binding),
    })),
  ].sort((left, right) => compareCodePointSequences(left.capabilityId, right.capabilityId));
  const changes = candidates.filter((candidate) => {
    const previous = parentCapabilities.get(candidate.capabilityId);
    if (previous === undefined) {
      throw new TypeError("Interface support requires a registered capability.");
    }
    return !sameInterfaceAvailabilityAxes(previous, candidate.availability);
  });
  return extendInterfaceRuntimeSupportManifest(parent, {
    registrations: [...Object.values(exchangeBindings), ...Object.values(activityBindings), ...Object.values(signingBindings)].map((entry) => ({
      capabilityId: entry.contract.capabilityId, availability: createCapabilityAvailability({ direct: "internal", http: "internal", mcp: "available", cli: "available" }),
    })).sort((a, b) => compareCodePointSequences(a.capabilityId, b.capabilityId)),
    changes: Object.freeze(changes),
    presentations: Object.freeze(presentationContractRegistry.values()
      .map((entry) => Object.freeze({
        contractId: entry.contractId,
        contractVersion: entry.contractVersion,
      }))
      .sort((left, right) => compareCodePointSequences(
        `${left.contractId}\0${left.contractVersion}`,
        `${right.contractId}\0${right.contractVersion}`,
      ))),
  });
};
