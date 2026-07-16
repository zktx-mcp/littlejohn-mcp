import {
  extendInterfaceRuntimeSupportManifest,
  type CapabilityAvailabilityInput,
  type ChainRuntimeSupportManifest,
  type InterfaceRuntimeSupportManifest,
} from "../runtime/index.js";
import {
  readInterfaceIdentities,
  walletConnectionInterface,
  walletToolInterfaces,
} from "./identities.js";

const readAvailability: CapabilityAvailabilityInput = Object.freeze({
  overall: "available",
  direct: "internal",
  http: "available",
  mcp: "available",
  cli: "available",
  web: "unavailable",
});

const walletConnectionAvailability: CapabilityAvailabilityInput = Object.freeze({
  overall: "available",
  direct: "internal",
  http: "available",
  mcp: "available",
  cli: "available",
  web: "available",
});

const walletOperationAvailability: CapabilityAvailabilityInput = Object.freeze({
  overall: "available",
  direct: "internal",
  http: "internal",
  mcp: "available",
  cli: "available",
  web: "available",
});

const walletStartAvailability: CapabilityAvailabilityInput = Object.freeze({
  overall: "available",
  direct: "internal",
  http: "internal",
  mcp: "available",
  cli: "available",
  web: "unavailable",
});

export const extendInterfaceSupportManifest = (
  parent: ChainRuntimeSupportManifest,
): InterfaceRuntimeSupportManifest => extendInterfaceRuntimeSupportManifest(parent, {
  registrations: [],
  changes: [
    ...readInterfaceIdentities
      .filter((identity) => identity !== walletConnectionInterface)
      .map((identity) => identity.capabilityId),
  ].map((capabilityId) => ({ capabilityId, availability: readAvailability })).concat([
    {
      capabilityId: walletToolInterfaces.cancelOperation.capabilityId,
      availability: walletOperationAvailability,
    },
    {
      capabilityId: walletToolInterfaces.startConnection.capabilityId,
      availability: walletStartAvailability,
    },
    {
      capabilityId: walletConnectionInterface.capabilityId,
      availability: walletConnectionAvailability,
    },
    {
      capabilityId: walletToolInterfaces.startDisconnection.capabilityId,
      availability: walletStartAvailability,
    },
    {
      capabilityId: walletToolInterfaces.getOperation.capabilityId,
      availability: walletOperationAvailability,
    },
  ]),
});
