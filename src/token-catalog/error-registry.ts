import { assertDirectApplicationErrorRegistryExtension } from "../core/client.js";
import { chainErrorRegistry } from "../chain/error-registry.js";
import { tokenCatalogErrorDefinitions } from "./error-definitions.js";

export const tokenCatalogErrorRegistry = chainErrorRegistry.extend(tokenCatalogErrorDefinitions);
assertDirectApplicationErrorRegistryExtension(chainErrorRegistry, tokenCatalogErrorRegistry);
