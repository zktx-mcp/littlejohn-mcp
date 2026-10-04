import { CapabilityRegistry, type AnyReadCapabilityDefinition } from "../core/index.js";
import { chainReadCapabilities } from "../chain/read-capabilities.js";
import { walletConnectionCapability } from "../wallet/connection-capability.js";

export const readCapabilityRegistry = new CapabilityRegistry([...chainReadCapabilities.map(definition => definition as unknown as AnyReadCapabilityDefinition), walletConnectionCapability as unknown as AnyReadCapabilityDefinition]);
