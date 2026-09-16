import { officialAssetInterfaceErrorMappings } from "../registry/errors.js";
import { stockTokenPricesErrorRegistry } from "./contracts.js";
import { stockTokenPricesInterfaceErrorMappingDefinitions } from "./error-definitions.js";

export const stockTokenPricesInterfaceErrorMappings = officialAssetInterfaceErrorMappings.extend(
  stockTokenPricesErrorRegistry, stockTokenPricesInterfaceErrorMappingDefinitions,
);
