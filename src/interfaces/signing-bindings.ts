import { createCardDecisionIdentity } from "./mcp-app/card-bindings.js";
import type { LocalWalletRequestBinding } from "./local-operation.js";
import { captureCanonicalJson, operationIdSchema } from "../core/index.js";
import { signingApplicationContracts, signingRequestControlContract } from "../review/signing-application-contracts.js";
import { admitSigningCompletion, signingResponseContext } from "../review/signing-contracts.js";
import { signingInterfaceErrorMappings } from "../review/signing-error-mappings.js";
import { requestReviewLimits } from "../review/request-limits.js";
import { createLocalOperationIdentity } from "./local-operation.js";
import { signingToolContracts } from "./signing-tool-contracts.js";

const root = "/api/v1/internal/control/signing";
export const signingResources = Object.freeze({
  start: `${root}/reviews`, get: `${root}/reviews/{operationId}`,
  read: (id: string) => `${root}/reviews/${operationIdSchema.parse(id)}`,
  cancel: `${root}/discarded-reviews`, request: `${root}/signature-requests`,
});
const signingRequestBinding: LocalWalletRequestBinding<ReturnType<typeof signingRequestControlContract.parseInput>, ReturnType<typeof admitSigningCompletion>> = { action: "wallet_request", responseDeadlineMilliseconds: requestReviewLimits.reviewLifetimeMilliseconds,
      contract: signingRequestControlContract, errorMappings: signingInterfaceErrorMappings,
      operationId: (input) => input.review.operationId,
      actionRequest: (input) => ({ method: "POST", path: signingResources.request, body: captureCanonicalJson(input) }),
      responseContext: (input) => ({ kind: "signing", context: signingResponseContext(input.review) }),
      parseActionResponse: (context, result) => {
        if (context.kind !== "signing") throw new TypeError("Signing response context required.");
        return admitSigningCompletion(context.context, result);
      } };

export const signingBindings = Object.freeze({
  start: { ...signingToolContracts.start, path: signingResources.start,
    identity: createLocalOperationIdentity({ action: "read", contract: signingApplicationContracts.start,
      errorMappings: signingInterfaceErrorMappings, operationId: () => undefined,
      actionRequest: (input) => ({ method: "POST", path: signingResources.start, body: captureCanonicalJson(input) }),
      parseActionResponse: (input, _id, result) => signingApplicationContracts.start.parsePublicSuccess(input, result) }) },
  get: { ...signingToolContracts.get, path: signingResources.get,
    identity: createLocalOperationIdentity({ action: "read", contract: signingApplicationContracts.get,
      errorMappings: signingInterfaceErrorMappings, operationId: (input) => input.operationId,
      actionRequest: (input) => ({ method: "GET", path: signingResources.read(input.operationId) }),
      parseActionResponse: (input, _id, result) => signingApplicationContracts.get.parsePublicSuccess(input, result) }) },
  cancel: { ...signingToolContracts.cancel, path: signingResources.cancel,
    identity: createLocalOperationIdentity({ action: "cancel", contract: signingApplicationContracts.cancel,
      errorMappings: signingInterfaceErrorMappings, operationId: (input) => input.operationId,
      actionRequest: (input) => ({ method: "POST", path: signingResources.cancel, body: captureCanonicalJson(input) }),
      parseActionResponse: (input, _id, result) => signingApplicationContracts.cancel.parsePublicSuccess(input, result) }) },
  request: { ...signingToolContracts.request, path: signingResources.request,
    identity: createLocalOperationIdentity(signingRequestBinding),
    cardIdentity: createCardDecisionIdentity(signingRequestBinding) },
});
export const signingCliIdentities = Object.freeze([
  { domain: "signing", command: "start", argumentSyntax: "(--address <address> | --active) --file <payload.json>" },
  { domain: "signing", command: "get-review", argumentSyntax: "<operation-id>" },
  { domain: "signing", command: "cancel-review", argumentSyntax: "<operation-id>" },
] as const);
