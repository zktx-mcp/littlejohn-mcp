import { runtimeErrorRegistry } from "../runtime/error-registry.js";
import { requestReviewErrorDefinitions } from "./request-error-definitions.js";

export const requestReviewErrorRegistry = runtimeErrorRegistry.extend(requestReviewErrorDefinitions);
