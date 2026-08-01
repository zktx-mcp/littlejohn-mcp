import {
  createApplicationFailure,
  type ApplicationFailure,
} from "../core/index.js";
import { chainInterfaceErrorMappings } from "../chain/errors.js";
import { tokenCatalogInterfaceErrorMappingDefinitions } from "./error-definitions.js";
import { tokenCatalogErrorRegistry } from "./error-registry.js";

export { tokenCatalogErrorRegistry } from "./error-registry.js";

export const tokenCatalogInterfaceErrorMappings = chainInterfaceErrorMappings.extend(
  tokenCatalogErrorRegistry,
  tokenCatalogInterfaceErrorMappingDefinitions,
);

export const createTokenCatalogFailure = (code: string): ApplicationFailure =>
  createApplicationFailure(tokenCatalogErrorRegistry, code);
