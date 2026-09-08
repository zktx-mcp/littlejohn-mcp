import { assertDirectApplicationErrorRegistryExtension } from "../core/client.js";
import { officialAssetErrorRegistry } from "../registry/error-registry.js";
import { tokenCatalogErrorDefinitions } from "./error-definitions.js";

export const tokenCatalogErrorRegistry = officialAssetErrorRegistry.extend(tokenCatalogErrorDefinitions);
assertDirectApplicationErrorRegistryExtension(officialAssetErrorRegistry, tokenCatalogErrorRegistry);
