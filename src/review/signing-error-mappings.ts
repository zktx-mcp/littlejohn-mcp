import { walletInterfaceErrorMappings } from "../wallet/errors.js";
import { requestReviewErrorMappingDefinitions } from "./request-error-definitions.js";
import { signingErrorRegistry } from "./signing-errors.js";

export const signingInterfaceErrorMappings = walletInterfaceErrorMappings.extend(signingErrorRegistry, requestReviewErrorMappingDefinitions);
