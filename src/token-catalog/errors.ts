import {
  createApplicationFailure,
  type ApplicationFailure,
} from "../core/index.js";
import { officialAssetInterfaceErrorMappings } from "../registry/errors.js";
import { tokenCatalogInterfaceErrorMappingDefinitions } from "./error-definitions.js";
import { tokenCatalogErrorRegistry } from "./error-registry.js";

export { tokenCatalogErrorRegistry } from "./error-registry.js";

export const tokenCatalogInterfaceErrorMappings = officialAssetInterfaceErrorMappings.extend(
  tokenCatalogErrorRegistry,
  tokenCatalogInterfaceErrorMappingDefinitions,
);

export const createTokenCatalogFailure = (code: string): ApplicationFailure =>
  createApplicationFailure(tokenCatalogErrorRegistry, code);
