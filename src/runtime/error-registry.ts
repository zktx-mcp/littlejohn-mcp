import {
  assertDirectApplicationErrorRegistryExtension,
  coreErrorRegistry,
} from "../core/client.js";
import { runtimeErrorDefinitions } from "./error-definitions.js";

export const runtimeErrorRegistry = coreErrorRegistry.extend(runtimeErrorDefinitions);
assertDirectApplicationErrorRegistryExtension(coreErrorRegistry, runtimeErrorRegistry);
