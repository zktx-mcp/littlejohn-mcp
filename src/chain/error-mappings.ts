import { walletInterfaceErrorMappings } from "../wallet/errors.js";
import { chainInterfaceErrorMappingDefinitions } from "./error-definitions.js";
import { chainErrorRegistry } from "./error-registry.js";

export const chainInterfaceErrorMappings = walletInterfaceErrorMappings.extend(
  chainErrorRegistry,
  chainInterfaceErrorMappingDefinitions,
);

