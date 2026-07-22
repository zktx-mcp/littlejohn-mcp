import {
  compareCodePointSequences,
} from "../core/index.js";
import {
  composeCapabilityCatalog,
  createCapabilityCatalogSchema,
  extendInterfaceRuntimeSupportManifest,
  type CapabilityCatalog,
  type CapabilityAvailabilityInput,
  type AccountAssetRuntimeSupportManifest,
  type InterfaceRuntimeSupportManifest,
} from "../runtime/support-manifest.js";
import {
  interfaceReadCapabilityRegistry,
  accountAssetInterfaceBindingList,
  readInterfaceIdentities,
  tokenCatalogInterfaceBindingList,
  walletInterfaceBindingList,
  type ReadInterfaceIdentity,
  type TokenCatalogInterfaceBinding,
  type WalletInterfaceBinding,
  type AccountAssetInterfaceBinding,
} from "./identities.js";

export const interfaceCapabilityCatalogSchema = createCapabilityCatalogSchema(
  interfaceReadCapabilityRegistry,
);

export const composeInterfaceCapabilityCatalog = (
  manifest: InterfaceRuntimeSupportManifest,
): CapabilityCatalog => composeCapabilityCatalog(interfaceReadCapabilityRegistry, manifest);

const readBindingAvailability = (
  identity: ReadInterfaceIdentity,
): CapabilityAvailabilityInput => Object.freeze({
  overall: "available",
  direct: "internal",
  http: "available",
  mcp: "available",
  cli: "available",
  web: identity.web === true ? "available" : "unavailable",
});

const tokenCatalogBindingAvailability = (
  _binding: TokenCatalogInterfaceBinding,
): CapabilityAvailabilityInput => Object.freeze({
  overall: "available",
  direct: "internal",
  http: "internal",
  mcp: "available",
  cli: "available",
  web: "available",
});

const accountAssetBindingAvailability = (
  binding: AccountAssetInterfaceBinding,
): CapabilityAvailabilityInput => Object.freeze({
  overall: binding.mcp !== undefined || binding.cli !== undefined || binding.web ? "available" : "internal",
  direct: "internal",
  http: "internal",
  mcp: binding.mcp === undefined ? "unavailable" : "available",
  cli: binding.cli === undefined ? "unavailable" : "available",
  web: binding.web ? "available" : "unavailable",
});

const walletBindingAvailability = (
  binding: WalletInterfaceBinding,
): CapabilityAvailabilityInput => Object.freeze({
  overall: binding.mcp !== undefined || binding.cli !== undefined || binding.web !== undefined
    ? "available"
    : "internal",
  direct: "internal",
  http: "internal",
  mcp: binding.mcp === undefined ? "unavailable" : "available",
  cli: binding.cli === undefined ? "unavailable" : "available",
  web: binding.web === undefined ? "unavailable" : "available",
});

export const extendInterfaceSupportManifest = (
  parent: AccountAssetRuntimeSupportManifest,
): InterfaceRuntimeSupportManifest => extendInterfaceRuntimeSupportManifest(parent, {
  registrations: [],
  changes: Object.freeze([
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
    ...walletInterfaceBindingList.map((binding) => ({
      capabilityId: binding.contract.capabilityId,
      availability: walletBindingAvailability(binding),
    })),
  ].sort((left, right) => compareCodePointSequences(left.capabilityId, right.capabilityId))),
});
