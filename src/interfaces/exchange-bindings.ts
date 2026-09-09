import { exchangeToolContracts, activityToolContracts } from "./exchange-tool-contracts.js";
import { chainInvocationDeadlineMs } from "../chain/invocation-limits.js";
import { exchangeLimits } from "../review/limits.js";
import { captureCanonicalJson, operationIdSchema } from "../core/index.js";
import { exchangeApplicationContracts, admitExchangeConfirmationResult } from "../review/application-contracts.js";
import { receiptApplicationContracts } from "../receipt-activity/application-contracts.js";
import { exchangeInterfaceErrorMappings } from "../review/error-mappings.js";
import { receiptActivityInterfaceErrorMappings } from "../receipt-activity/error-mappings.js";
import { createLocalOperationIdentity } from "./local-operation.js";
import { liveReviewPresentationInputSchema, liveReviewPresentationSchema } from "../review/presentation-contract.js";

const controlRoot = "/api/v1/internal/control/exchange";
export const exchangeResources = Object.freeze({
  start: `${controlRoot}/reviews`, get: `${controlRoot}/reviews/{operationId}`,
  review: (id: string) => `${controlRoot}/reviews/${operationIdSchema.parse(id)}`,
  cancel: `${controlRoot}/discarded-reviews`, request: `${controlRoot}/transaction-requests`,
  presentation: `${controlRoot}/review-presentations/{operationId}`,
  readPresentation: (id: string) => `${controlRoot}/review-presentations/${operationIdSchema.parse(id)}`,
  activityGet: "/api/v1/activity/transaction-queries", activityList: "/api/v1/activity/transaction-pages",
  activityInspect: "/api/v1/internal/control/activity/transaction-inspections",
});
export const exchangeBindings = Object.freeze({
  start: { ...exchangeToolContracts.start, path: exchangeResources.start,
    identity: createLocalOperationIdentity({ action: "read", contract: exchangeApplicationContracts.start,
      errorMappings: exchangeInterfaceErrorMappings, operationId: () => undefined,
      actionRequest: (input) => ({ method: "POST", path: exchangeResources.start, body: captureCanonicalJson(input) }),
      parseActionResponse: (input, _id, value) => exchangeApplicationContracts.start.parsePublicSuccess(input, value) }) },
  get: { ...exchangeToolContracts.get, path: exchangeResources.get,
    identity: createLocalOperationIdentity({ action: "read", contract: exchangeApplicationContracts.get,
      errorMappings: exchangeInterfaceErrorMappings, operationId: (input) => input.operationId,
      actionRequest: (input) => ({ method: "GET", path: exchangeResources.review(input.operationId) }),
      parseActionResponse: (input, _id, value) => exchangeApplicationContracts.get.parsePublicSuccess(input, value) }) },
  cancel: { ...exchangeToolContracts.cancel, path: exchangeResources.cancel,
    identity: createLocalOperationIdentity({ action: "cancel", contract: exchangeApplicationContracts.cancel,
      errorMappings: exchangeInterfaceErrorMappings, operationId: (input) => input.operationId,
      actionRequest: (input) => ({ method: "POST", path: exchangeResources.cancel, body: captureCanonicalJson(input) }),
      parseActionResponse: (input, _id, value) => exchangeApplicationContracts.cancel.parsePublicSuccess(input, value) }) },
  request: { ...exchangeToolContracts.request, path: exchangeResources.request,
    identity: createLocalOperationIdentity({ action: "transaction", responseDeadlineMilliseconds: exchangeLimits.reviewLifetimeMilliseconds + chainInvocationDeadlineMs, contract: exchangeApplicationContracts.request,
      errorMappings: exchangeInterfaceErrorMappings, operationId: (input) => input.review.observation.data.operationId,
      actionRequest: (input) => ({ method: "POST", path: exchangeResources.request, body: captureCanonicalJson(input) }),
      parseActionResponse: admitExchangeConfirmationResult }) },
});
export const activityBindings = Object.freeze({
  get: { ...activityToolContracts.get, path: exchangeResources.activityGet },
  list: { ...activityToolContracts.list, path: exchangeResources.activityList },
  inspect: { ...activityToolContracts.inspect, path: exchangeResources.activityInspect,
    identity: createLocalOperationIdentity({ action: "read", contract: receiptApplicationContracts.inspect,
      errorMappings: receiptActivityInterfaceErrorMappings, operationId: () => undefined,
      actionRequest: (input) => ({ method: "POST", path: exchangeResources.activityInspect, body: captureCanonicalJson(input) }),
      parseActionResponse: (input, _id, value) => receiptApplicationContracts.inspect.parsePublicSuccess(input, value) }) },
});

export const liveReviewPresentationIdentity = createLocalOperationIdentity({ action: "read",
  contract: { errorRegistry: exchangeApplicationContracts.get.errorRegistry,
    parseInput: (value: unknown) => liveReviewPresentationInputSchema.parse(value),
    normalizeFailure: exchangeApplicationContracts.get.normalizeFailure },
  errorMappings: exchangeInterfaceErrorMappings,
  operationId: (input) => input.operationId,
  actionRequest: (input) => ({ method: "GET", path: exchangeResources.readPresentation(input.operationId) }),
  parseActionResponse: (input, _id, value) => {
    const result = liveReviewPresentationSchema.parse(value);
    if (result.status === "available" && result.operationId !== input.operationId) throw new TypeError("Live presentation changed its operation.");
    return result;
  },
});

export const exchangeCliIdentities = Object.freeze([
  { domain: "exchange", command: "start", argumentSyntax: "(--address <address> | --active) --stock-token <address> --direction <buy|sell> --pool <pool-id> --basis <sent|received> --input <token-units> --input-relation <equal|at_most> --output <token-units> --output-relation <equal|at_least> --max-fee <wei-per-gas> --priority-fee <wei-per-gas> --deadline <UTC-time> [--gas-limit <gas>] [--replaces <hash>]" },
  { domain: "exchange", command: "replace-fees", argumentSyntax: "<transaction-hash> (--address <address> | --active) --max-fee <wei-per-gas> --priority-fee <wei-per-gas>" },
  { domain: "exchange", command: "get-review", argumentSyntax: "<operation-id> [--json]" },
  { domain: "exchange", command: "cancel-review", argumentSyntax: "<operation-id> [--json]" },
  { domain: "activity", command: "get", argumentSyntax: "<transaction-hash> --address <address> [--json]" },
  { domain: "activity", command: "inspect", argumentSyntax: "<transaction-hash> --address <address> [--json]" },
  { domain: "activity", command: "list", argumentSyntax: "--address <address> [--after <transaction-hash>] [--json]" },
] as const);
