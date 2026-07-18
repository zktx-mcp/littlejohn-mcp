import { chainErrorRegistry, chainInterfaceErrorMappings } from "../chain/errors.js";
import { tokenCatalogErrorDefinitions, tokenCatalogInterfaceErrorMappingDefinitions } from "./error-definitions.js";

export const tokenCatalogErrorRegistry = chainErrorRegistry.extend(tokenCatalogErrorDefinitions);

export const tokenCatalogInterfaceErrorMappings = chainInterfaceErrorMappings.extend(
  tokenCatalogErrorRegistry,
  tokenCatalogInterfaceErrorMappingDefinitions,
);
