import { operationIdSchema } from "../core/index.js";
import { requestReviewInterfaceErrorMappings } from "../review/request-error-mappings.js";
import { liveReviewPresentationContract } from "../review/presentation-contract.js";
import { createLocalOperationIdentity } from "./local-operation.js";

const root = "/api/v1/internal/control/reviews/presentations";
export const reviewPresentationResources = Object.freeze({
  path: `${root}/{operationId}`,
  read: (id: string) => `${root}/${operationIdSchema.parse(id)}`,
});
export const liveReviewPresentationIdentity = createLocalOperationIdentity({ action: "read",
  contract: liveReviewPresentationContract,
  errorMappings: requestReviewInterfaceErrorMappings,
  operationId: (input) => input.operationId,
  actionRequest: (input) => ({ method: "GET", path: reviewPresentationResources.read(input.operationId) }),
  parseActionResponse: (input, _id, value) => {
    return liveReviewPresentationContract.parsePublicSuccess(input, value);
  },
});
