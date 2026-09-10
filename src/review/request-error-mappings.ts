import { runtimeInterfaceErrorMappings } from "../runtime/errors.js";
import { requestReviewErrorRegistry } from "./request-error-registry.js";
import { requestReviewErrorMappingDefinitions } from "./request-error-definitions.js";

export const requestReviewInterfaceErrorMappings = runtimeInterfaceErrorMappings.extend(
  requestReviewErrorRegistry, requestReviewErrorMappingDefinitions,
);
