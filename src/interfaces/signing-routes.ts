import type { PresentationCardApplication } from "./mcp-app/card-application.js";
import { CardError } from "./mcp-app/card-errors.js";
import { CardDomainError } from "./mcp-app/card-sources.js";
import { admitApplicationInput, captureCanonicalJson } from "../core/index.js";
import { signingApplicationContracts, signingRequestControlContract, type SigningApplicationPort } from "../review/signing-application-contracts.js";
import { admitSigningCompletion, signingResponseContext } from "../review/signing-contracts.js";
import { signingFailureCode, createSigningFailure } from "../review/signing-errors.js";
import { signingInterfaceErrorMappings } from "../review/signing-error-mappings.js";
import type { RuntimeRouteRegistry, RouteResult } from "../runtime/http-routing.js";
import { signingResources } from "./signing-bindings.js";

const success = (value: unknown): RouteResult => ({ ok: true, body: captureCanonicalJson(value) });
const failed = (error: unknown): RouteResult => ({ ok: false, failure: error instanceof CardError || error instanceof CardDomainError ? error.failure : createSigningFailure(signingFailureCode(error) ?? "internal_error") });
export const extendSigningRoutes = (routes: RuntimeRouteRegistry, signing: SigningApplicationPort, cards: PresentationCardApplication) => routes.extend([
  { method: "POST", mutation: "declared_control", pathPattern: signingResources.start, successStatus: 200,
    handler: async (context) => {
      const admitted = admitApplicationInput(signingApplicationContracts.start, context.body);
      if (!admitted.ok) return { ok: false, failure: admitted.failure };
      try { return success(await signing.start(admitted.value, context.signal)); } catch (error) { return failed(error); }
    } },
  { method: "GET", mutation: "none", pathPattern: signingResources.get, successStatus: 200,
    handler: async (context) => {
      const admitted = admitApplicationInput(signingApplicationContracts.get, { operationId: context.params["operationId"] });
      if (!admitted.ok) return { ok: false, failure: admitted.failure };
      try { return success(signing.get(admitted.value.operationId)); } catch (error) { return failed(error); }
    } },
  { method: "POST", mutation: "declared_control", pathPattern: signingResources.cancel, successStatus: 200,
    handler: async (context) => {
      const admitted = admitApplicationInput(signingApplicationContracts.cancel, context.body);
      if (!admitted.ok) return { ok: false, failure: admitted.failure };
      try { return success(signingApplicationContracts.cancel.parsePublicSuccess(admitted.value,
        await cards.cancelReview("signing", admitted.value.operationId))); } catch (error) { return failed(error); }
    } },
  { method: "POST", mutation: "declared_control", pathPattern: signingResources.request, successStatus: 200,
    handler: (context) => {
      const admitted = admitApplicationInput(signingRequestControlContract, context.body);
      if (!admitted.ok) return Promise.resolve({ ok: false, failure: admitted.failure });
      const correlation = signingResponseContext(admitted.value.review);
      try { return cards.decideWithoutView("signing", admitted.value, context.signal).then((value) => success(admitSigningCompletion(correlation, value)), failed); }
      catch (error) { return Promise.resolve(failed(error)); }
    } },
], signingInterfaceErrorMappings);
