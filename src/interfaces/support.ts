import {
  compareCodePointSequences,
} from "../core/index.js";
import {
  extendInterfaceRuntimeSupportManifest,
  type CapabilityAvailabilityInput,
  type InterfaceRuntimeSupportManifest,
  type TokenCatalogRuntimeSupportManifest,
} from "../runtime/index.js";
import {
  readInterfaceIdentities,
  walletInterfaceBindingList,
  type WalletInterfaceBinding,
} from "./identities.js";

const readAvailability: CapabilityAvailabilityInput = Object.freeze({
  overall: "available",
  direct: "internal",
  http: "available",
  mcp: "available",
  cli: "available",
  web: "unavailable",
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
  parent: TokenCatalogRuntimeSupportManifest,
): InterfaceRuntimeSupportManifest => extendInterfaceRuntimeSupportManifest(parent, {
  registrations: [],
  changes: Object.freeze([
    ...readInterfaceIdentities
      .map((identity) => ({
        capabilityId: identity.capabilityId,
        availability: readAvailability,
      })),
    ...walletInterfaceBindingList.map((binding) => ({
      capabilityId: binding.contract.capabilityId,
      availability: walletBindingAvailability(binding),
    })),
  ].sort((left, right) => compareCodePointSequences(left.capabilityId, right.capabilityId))),
});
