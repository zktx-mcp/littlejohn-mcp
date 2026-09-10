import { admitApplicationInput, captureCanonicalJson } from "../core/index.js";
import { liveReviewPresentationContract } from "../review/presentation-contract.js";
import { createRequestReviewFailure } from "../review/request-errors.js";
import { requestReviewInterfaceErrorMappings } from "../review/request-error-mappings.js";
import type { ReviewPresentationSource } from "../runtime/presentation-snapshot.js";
import type { RuntimeRouteRegistry } from "../runtime/http-routing.js";
import { reviewPresentationResources } from "./review-presentation-binding.js";

export const extendReviewPresentationRoutes = (routes: RuntimeRouteRegistry, presentations: ReviewPresentationSource) => routes.extend([
  { method: "GET", mutation: "none", pathPattern: reviewPresentationResources.path, successStatus: 200,
    handler: async (context) => {
      const admitted = admitApplicationInput(liveReviewPresentationContract, { operationId: context.params["operationId"] });
      if (!admitted.ok) return { ok: false, failure: admitted.failure };
      try {
        const stored = presentations.readPresentation(admitted.value.operationId);
        const value = stored.status === "unavailable" ? stored : {
          status: "available", operationId: stored.value.operationId, expiresAt: stored.value.expiresAt,
          contractId: stored.value.snapshot.contractId,
          input: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(stored.value.snapshot.inputBytes)),
          result: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(stored.value.snapshot.resultBytes)),
        };
        return { ok: true, body: captureCanonicalJson(liveReviewPresentationContract.parsePublicSuccess(admitted.value, value)) };
      } catch { return { ok: false, failure: createRequestReviewFailure("runtime_state_unavailable") }; }
    } },
], requestReviewInterfaceErrorMappings);
