import { chainInterfaceErrorMappings } from "../chain/error-mappings.js";
import { officialAssetErrorRegistry } from "./error-registry.js";
import { officialAssetInterfaceErrorMappingDefinitions } from "./error-definitions.js";

export const officialAssetInterfaceErrorMappings = chainInterfaceErrorMappings.extend(
  officialAssetErrorRegistry, officialAssetInterfaceErrorMappingDefinitions,
);
