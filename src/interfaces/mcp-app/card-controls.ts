import { getRuntimeOperationFailure } from "../../runtime/errors.js";
import { z } from "zod";
import { captureCanonicalJson, createApplicationFailure, type CanonicalJson } from "../../core/index.js";
import type { RuntimeRouteRegistry, RouteResult } from "../../runtime/http-routing.js";
import { localControlApiPathPrefix } from "../../runtime/http-boundary.js";
import { CardError, cardInterfaceErrorMappings } from "./card-errors.js";
import { CardDomainError } from "./card-sources.js";
import { cardActionEnvelopeSchema, cardActionResponseLimitBytes, cardControlContracts, cardErrorRegistry, cardReadStartContract, cardPresentationDeliverySchema, cardReferenceContract } from "./card-contract.js";
import { presentationDecisionKinds, presentationContractRegistry } from "./registry.js";
import type { PresentationCardApplication } from "./card-application.js";

const root = `${localControlApiPathPrefix}presentation`;
export const cardControlResources = Object.freeze({
  read: `${root}/card-state`,
  reference: `${root}/card-references`,
  open: `${root}/card-openings`,
  discard: `${root}/decision-cancellations`,
  stop: `${root}/wait-cancellations`,
  action: `${root}/card-decisions`,
  startRead: `${root}/read-requests`,
  review: (kind: typeof presentationDecisionKinds[number]) => `${root}/card-reviews/${kind.replaceAll("_", "-")}`,
});
const success = (value: unknown): RouteResult => ({ ok: true, body: captureCanonicalJson(value) });
const failure = (error: unknown): RouteResult => ({ ok: false, failure: error instanceof CardError || error instanceof CardDomainError
  ? error.failure : getRuntimeOperationFailure(error) ?? createApplicationFailure(cardErrorRegistry, "internal_error") });
const invalid = (): RouteResult => ({ ok: false, failure: createApplicationFailure(cardErrorRegistry, "invalid_input") });

export const extendCardRoutes = (routes: RuntimeRouteRegistry, cards: PresentationCardApplication): RuntimeRouteRegistry => {
  const controls = (Object.keys(cardControlContracts) as (keyof typeof cardControlContracts)[]).map((key) => ({
    method: "POST" as const, mutation: key === "read" ? "none" as const : "declared_control" as const, pathPattern: cardControlResources[key], successStatus: 200 as const,
    handler: async (context: { body: unknown }): Promise<RouteResult> => {
      const contract = cardControlContracts[key];
      let input: unknown;
      try { input = contract.parseInput(context.body); } catch { return invalid(); }
      try {
        const value = key === "read" ? await cards.get(input) : key === "open" ? await cards.open(input) : key === "discard" ? await cards.cancelDecision(input) : await cards.cancelWait(input);
        const delivery = cardPresentationDeliverySchema.parse(value);
        contract.parsePublicSuccess(input as never, delivery.presentation);
        return success(delivery);
      } catch (error) { return failure(error); }
    },
  }));
  const creation = presentationDecisionKinds.map((kind) => ({
    method: "POST" as const, mutation: "declared_control" as const, pathPattern: cardControlResources.review(kind), successStatus: 200 as const,
    handler: (context: { body: unknown; signal: AbortSignal }): Promise<RouteResult> => {
      let input: CanonicalJson;
      try { input = presentationContractRegistry.requireCardKind(kind).parseInput(context.body); } catch { return Promise.resolve(invalid()); }
      return cards.startReview(kind, input, context.signal).then(success, failure);
    },
  }));
  return routes.extend([...controls, ...creation, {
    method: "POST", mutation: "none", pathPattern: cardControlResources.reference, successStatus: 200,
    handler: async (context) => {
      let input: ReturnType<typeof cardReferenceContract.parseInput>;
      try { input = cardReferenceContract.parseInput(context.body); } catch { return invalid(); }
      try { return success(cards.getReference(input)); } catch (error) { return failure(error); }
    },
  }, {
    method: "POST", mutation: "declared_control", pathPattern: cardControlResources.startRead, successStatus: 200,
    handler: async (context) => {
      let input: ReturnType<typeof cardReadStartContract.parseInput>;
      try { input = cardReadStartContract.parseInput(context.body); } catch { return invalid(); }
      try { return success(cardReadStartContract.parsePublicSuccess(input, await cards.startRead(input, context.signal))); }
      catch (error) { return failure(error); }
    },
  }, {
    method: "POST", mutation: "declared_control", pathPattern: cardControlResources.action, successStatus: 200,
    maximumResponseBytes: cardActionResponseLimitBytes,
    handler: (context) => {
      let input: z.infer<typeof cardActionEnvelopeSchema>;
      try { input = cardActionEnvelopeSchema.parse(context.body); } catch { return Promise.resolve(invalid()); }
      // Source admission and compact response verification belong to the card/domain owners.
      // This continuation retains no decision material and returns their admitted value unchanged.
      return cards.action({ cardId: input.cardId, cardOpenRequestId: input.cardOpenRequestId }, input.decision, context.signal).then(success, failure);
    },
  }], cardInterfaceErrorMappings);
};
