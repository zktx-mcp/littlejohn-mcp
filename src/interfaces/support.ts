import {
  compareCodePointSequences,
} from "../core/index.js";
import {
  composeCapabilityCatalog,
  createCapabilityAvailability,
  createCapabilityCatalogSchema,
  extendInterfaceRuntimeSupportManifest,
  readRuntimeSupportManifest,
  type CapabilityCatalog,
  type CapabilityAvailabilityInput,
  type InterfaceRuntimeSupportManifest,
  type ProtocolRuntimeSupportManifest,
} from "../runtime/support-manifest.js";
import { presentationContractRegistry } from "./mcp-app/registry.js";
import {
  operationInterfaceBindingList,
  type OperationInterfaceBinding,
} from "./operation-bindings.js";
import {
  interfaceReadCapabilityRegistry,
  accountAssetInterfaceBindingList,
  readInterfaceIdentities,
  referenceMarketInterfaceBindingList,
  tokenCatalogInterfaceBindingList,
  type ReadInterfaceIdentity,
  type ReferenceMarketInterfaceBinding,
  type TokenCatalogInterfaceBinding,
  type AccountAssetInterfaceBinding,
} from "./identities.js";

const interfaceCapabilityCatalogContractVersion = "1" as const;

export const interfaceCapabilityCatalogSchema = createCapabilityCatalogSchema(
  interfaceReadCapabilityRegistry,
  interfaceCapabilityCatalogContractVersion,
);

export const composeInterfaceCapabilityCatalog = (
  manifest: InterfaceRuntimeSupportManifest,
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

const referenceMarketBindingAvailability = (
  binding: ReferenceMarketInterfaceBinding,
): CapabilityAvailabilityInput => createCapabilityAvailability({
  direct: "internal",
  http: binding.action === "price" || binding.action === "history" || binding.action === "watchlist"
    ? "available"
    : "internal",
  mcp: "available",
  cli: "available",
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
  parent: ProtocolRuntimeSupportManifest,
): InterfaceRuntimeSupportManifest => {
  const parentCapabilities = new Map<string, CapabilityAvailabilityInput>(readRuntimeSupportManifest(parent).capabilities.map(
    (entry) => [entry.capabilityId, entry.availability] as const,
  ));
  const candidates = [
    ...accountAssetInterfaceBindingList.map((binding) => ({
      capabilityId: binding.contract.capabilityId,
      availability: accountAssetBindingAvailability(binding),
    })),
    ...readInterfaceIdentities
      .map((identity) => ({
        capabilityId: identity.capabilityId,
        availability: readBindingAvailability(identity),
      })),
    ...referenceMarketInterfaceBindingList.map((binding) => ({
      capabilityId: binding.contract.capabilityId,
      availability: referenceMarketBindingAvailability(binding),
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
    registrations: [],
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
