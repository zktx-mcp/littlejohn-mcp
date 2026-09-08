import { assertDirectApplicationErrorRegistryExtension } from "../core/client.js";
import { chainErrorRegistry } from "../chain/error-registry.js";
import { officialAssetErrorDefinitions } from "./error-definitions.js";

export const officialAssetErrorRegistry = chainErrorRegistry.extend(officialAssetErrorDefinitions);
assertDirectApplicationErrorRegistryExtension(chainErrorRegistry, officialAssetErrorRegistry);
