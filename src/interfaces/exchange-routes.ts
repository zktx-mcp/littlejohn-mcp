import { liveReviewPresentationSchema, liveReviewPresentationInputSchema } from "../review/presentation-contract.js";
import type { ReviewPresentationSource } from "../runtime/presentation-snapshot.js";
import { admitApplicationInput, captureCanonicalJson } from "../core/index.js";
import { exchangeApplicationContracts, admitExchangeConfirmationResult, type ExchangeApplicationPort } from "../review/application-contracts.js";
import { receiptApplicationContracts, type ReceiptActivityPort } from "../receipt-activity/application-contracts.js";
import { exchangeInterfaceErrorMappings } from "../review/error-mappings.js";
import { exchangeFailureCode, createExchangeFailure } from "../review/errors.js";
import { receiptActivityInterfaceErrorMappings } from "../receipt-activity/error-mappings.js";
import type { RuntimeRouteRegistry, RouteResult, RouteDefinition } from "../runtime/http-routing.js";
import { exchangeResources } from "./exchange-bindings.js";

const success = (value: unknown): RouteResult => ({ ok: true, body: captureCanonicalJson(value) });
const failed = (error: unknown): RouteResult => ({ ok: false, failure: createExchangeFailure(exchangeFailureCode(error) ?? "internal_error") });
export const extendExchangeRoutes = (input: Readonly<{
  routes: RuntimeRouteRegistry; exchange: ExchangeApplicationPort; activity: ReceiptActivityPort; presentations: ReviewPresentationSource;
}>): RuntimeRouteRegistry => {
  const exchange: RouteDefinition[] = [
    { method: "GET", mutation: "none", pathPattern: exchangeResources.presentation, successStatus: 200,
      handler: async (context) => {
        const parsed = liveReviewPresentationInputSchema.safeParse({ operationId: context.params["operationId"] });
        if (!parsed.success) return { ok: false, failure: createExchangeFailure("invalid_input") };
        try {
          const stored = input.presentations.readPresentation(parsed.data.operationId);
          if (stored.status === "unavailable") return success(stored);
          return success(liveReviewPresentationSchema.parse({ status: "available", operationId: stored.value.operationId,
            expiresAt: stored.value.expiresAt, input: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(stored.value.snapshot.inputBytes)),
            result: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(stored.value.snapshot.resultBytes)) }));
        } catch (error) { return failed(error); }
      } },
    { method: "POST", mutation: "declared_control", pathPattern: exchangeResources.start, successStatus: 200,
      handler: async (context) => {
        const admitted = admitApplicationInput(exchangeApplicationContracts.start, context.body);
        if (!admitted.ok) return { ok: false, failure: admitted.failure };
        try { return success(await input.exchange.start(admitted.value, context.signal)); } catch (error) { return failed(error); }
      } },
    { method: "GET", mutation: "none", pathPattern: exchangeResources.get, successStatus: 200,
      handler: async (context) => {
        const admitted = admitApplicationInput(exchangeApplicationContracts.get, { operationId: context.params["operationId"] });
        if (!admitted.ok) return { ok: false, failure: admitted.failure };
        try { return success(input.exchange.get(admitted.value.operationId)); } catch (error) { return failed(error); }
      } },
    { method: "POST", mutation: "declared_control", pathPattern: exchangeResources.cancel, successStatus: 200,
      handler: async (context) => {
        const admitted = admitApplicationInput(exchangeApplicationContracts.cancel, context.body);
        if (!admitted.ok) return { ok: false, failure: admitted.failure };
        try { return success(input.exchange.cancel(admitted.value.operationId)); } catch (error) { return failed(error); }
      } },
    { method: "POST", mutation: "declared_control", pathPattern: exchangeResources.request, successStatus: 200,
      handler: (context) => {
        const admitted = admitApplicationInput(exchangeApplicationContracts.request, context.body);
        if (!admitted.ok) return Promise.resolve({ ok: false, failure: admitted.failure });
        const operationId = admitted.value.review.observation.data.operationId;
        // The response closure retains correlation only, never the full Review.
        return input.exchange.confirm(admitted.value, context.signal).then(
          (value) => success(admitExchangeConfirmationResult(operationId, value)), failed);
      } },
  ];
  const routes = input.routes.extend(exchange, exchangeInterfaceErrorMappings);
  return routes.extend([
    { method: "POST", mutation: "none", pathPattern: exchangeResources.activityGet, successStatus: 200,
      handler: async (context) => {
        const admitted = admitApplicationInput(receiptApplicationContracts.get, context.body);
        if (!admitted.ok) return { ok: false, failure: admitted.failure };
        try { return success(input.activity.get(admitted.value)); } catch (error) { return failed(error); }
      } },
    { method: "POST", mutation: "none", pathPattern: exchangeResources.activityList, successStatus: 200,
      handler: async (context) => {
        const admitted = admitApplicationInput(receiptApplicationContracts.list, context.body);
        if (!admitted.ok) return { ok: false, failure: admitted.failure };
        try { return success(input.activity.list(admitted.value)); } catch (error) { return failed(error); }
      } },
    { method: "POST", mutation: "declared_control", pathPattern: exchangeResources.activityInspect, successStatus: 200,
      handler: async (context) => {
        const admitted = admitApplicationInput(receiptApplicationContracts.inspect, context.body);
        if (!admitted.ok) return { ok: false, failure: admitted.failure };
        try { return success(await input.activity.inspect(admitted.value, context.signal)); } catch (error) { return failed(error); }
      } },
  ], receiptActivityInterfaceErrorMappings);
};
