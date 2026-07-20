import {
  createApplicationFailure,
  type ApplicationFailure,
} from "../core/index.js";
import { chainErrorRegistry, chainInterfaceErrorMappings } from "../chain/errors.js";
import { tokenCatalogErrorDefinitions, tokenCatalogInterfaceErrorMappingDefinitions } from "./error-definitions.js";

export const tokenCatalogErrorRegistry = chainErrorRegistry.extend(tokenCatalogErrorDefinitions);

export const tokenCatalogInterfaceErrorMappings = chainInterfaceErrorMappings.extend(
  tokenCatalogErrorRegistry,
  tokenCatalogInterfaceErrorMappingDefinitions,
);

export const createTokenCatalogFailure = (code: string): ApplicationFailure =>
  createApplicationFailure(tokenCatalogErrorRegistry, code);
