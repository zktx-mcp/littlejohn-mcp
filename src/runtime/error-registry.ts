import {
  assertDirectApplicationErrorRegistryExtension,
  coreErrorRegistry,
} from "../core/browser.js";
import { runtimeErrorDefinitions } from "./error-definitions.js";

export const runtimeErrorRegistry = coreErrorRegistry.extend(runtimeErrorDefinitions);
assertDirectApplicationErrorRegistryExtension(coreErrorRegistry, runtimeErrorRegistry);
