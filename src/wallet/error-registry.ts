import { assertDirectApplicationErrorRegistryExtension } from "../core/client.js";
import { runtimeErrorRegistry } from "../runtime/error-registry.js";
import { walletErrorDefinitions } from "./error-definitions.js";

export const walletErrorRegistry = runtimeErrorRegistry.extend(walletErrorDefinitions);
assertDirectApplicationErrorRegistryExtension(runtimeErrorRegistry, walletErrorRegistry);
