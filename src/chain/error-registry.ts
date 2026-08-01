import { assertDirectApplicationErrorRegistryExtension } from "../core/browser.js";
import { walletErrorRegistry } from "../wallet/error-registry.js";
import { chainErrorDefinitions } from "./error-definitions.js";

export const chainErrorRegistry = walletErrorRegistry.extend(chainErrorDefinitions);
assertDirectApplicationErrorRegistryExtension(walletErrorRegistry, chainErrorRegistry);
