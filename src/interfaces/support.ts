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
import { browserCapabilityBindingFor } from "./browser-capability-bindings.js";
import {
  interfaceReadCapabilityRegistry,
  accountAssetInterfaceBindingList,
  readInterfaceIdentities,
  referenceMarketInterfaceBindingList,
  tokenCatalogInterfaceBindingList,
  walletInterfaceBindingList,
  type ReadInterfaceIdentity,
  type ReferenceMarketInterfaceBinding,
  type TokenCatalogInterfaceBinding,
  type WalletInterfaceBinding,
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
  web: browserAvailability(identity.definition),
});

const tokenCatalogBindingAvailability = (
  binding: TokenCatalogInterfaceBinding,
): CapabilityAvailabilityInput => createCapabilityAvailability({
  direct: "internal",
  http: "internal",
  mcp: "available",
  cli: "available",
  web: browserAvailability(binding.contract),
});

const accountAssetBindingAvailability = (
  binding: AccountAssetInterfaceBinding,
): CapabilityAvailabilityInput => createCapabilityAvailability({
  direct: "internal",
  http: "internal",
  mcp: binding.mcp === undefined ? "unavailable" : "available",
  cli: binding.cli === undefined ? "unavailable" : "available",
  web: browserAvailability(binding.contract),
});

const walletBindingAvailability = (
  binding: WalletInterfaceBinding,
): CapabilityAvailabilityInput => createCapabilityAvailability({
  direct: "internal",
  http: "internal",
  mcp: binding.mcp === undefined ? "unavailable" : "available",
  cli: binding.cli === undefined ? "unavailable" : "available",
  web: browserAvailability(binding.contract),
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
  web: browserAvailability(binding.contract),
});

type InterfaceAvailabilityAxes = Omit<CapabilityAvailabilityInput, "overall">;

const browserAvailability = (contract: object): "available" | "unavailable" =>
  browserCapabilityBindingFor(contract) === undefined ? "unavailable" : "available";

export const sameInterfaceAvailabilityAxes = (
  left: InterfaceAvailabilityAxes,
  right: InterfaceAvailabilityAxes,
): boolean => left.direct === right.direct &&
  left.http === right.http &&
  left.mcp === right.mcp &&
  left.cli === right.cli &&
  left.web === right.web;

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
    ...walletInterfaceBindingList.map((binding) => ({
      capabilityId: binding.contract.capabilityId,
      availability: walletBindingAvailability(binding),
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
  });
};
