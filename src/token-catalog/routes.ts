import {
  CapabilityBindingRegistry,
  CapabilityRegistry,
  captureCanonicalJson,
  type ApplicationFailure,
} from "../core/index.js";
import type {
  RouteContext,
  RouteResult,
  RuntimeRouteRegistry,
} from "../runtime/http-routing.js";
import {
  tokenCatalogApplicationContracts,
  tokenInspectCapability,
  type AnyTokenCatalogApplicationContract,
} from "./contracts.js";
import { tokenCatalogInterfaceErrorMappings } from "./errors.js";
import { normalizeTokenCatalogError, TokenCatalogOperationError } from "./operation-error.js";
import type {
  TokenCatalogInspectionPort,
  TokenCatalogQueryApplicationPort,
} from "./ports.js";
import {
  tokenCatalogControlRoutes,
  tokenSelectionListRequestBody,
  tokenSelectionRequestBody,
} from "./http-contract.js";

const success = (body: unknown): RouteResult => ({
  ok: true,
  body: captureCanonicalJson(body),
});
const failure = (applicationFailure: ApplicationFailure): RouteResult => ({
  ok: false,
  failure: applicationFailure,
});
const invalidInput = (): RouteResult => failure(
  new TokenCatalogOperationError("invalid_input").failure,
);

export const tokenCatalogApplicationResult = (
  contract: AnyTokenCatalogApplicationContract,
  request: unknown,
  value: unknown,
): RouteResult => {
  try { return success(contract.parsePublicSuccess(request, value)); }
  catch {
    try { return failure(contract.parseFailure(value)); }
    catch { return failure(normalizeTokenCatalogError(value).failure); }
  }
};

export const extendTokenCatalogQueryRoutes = (input: Readonly<{
  routes: RuntimeRouteRegistry;
  inspection: TokenCatalogInspectionPort;
  queries: TokenCatalogQueryApplicationPort;
}>): RuntimeRouteRegistry => {
  const inspections = new CapabilityBindingRegistry(
    new CapabilityRegistry([tokenInspectCapability]),
    [input.inspection],
  );
  return input.routes.extend([
    {
      method: "POST",
      mutation: "none",
      pathPattern: tokenCatalogControlRoutes.inspections,
      successStatus: 200,
      handler: async (context) => {
        try {
          const result = await inspections.invoke(
            tokenInspectCapability,
            context.body,
            { signal: context.signal },
          );
          return result.ok ? success(result) : failure(result);
        } catch (error) { return failure(normalizeTokenCatalogError(error).failure); }
      },
    },
    {
      method: "POST",
      mutation: "none",
      pathPattern: tokenCatalogControlRoutes.selectionListQueries,
      successStatus: 200,
      handler: async (context) => {
        const contract = tokenCatalogApplicationContracts.selections;
        let request;
        try { request = contract.parseInput(context.body); }
        catch { return invalidInput(); }
        return tokenCatalogApplicationResult(
          contract,
          request,
          await input.queries.listSelections(tokenSelectionListRequestBody(request)),
        );
      },
    },
    {
      method: "POST",
      mutation: "none",
      pathPattern: tokenCatalogControlRoutes.selectionQueries,
      successStatus: 200,
      handler: async (context) => {
        const contract = tokenCatalogApplicationContracts.selection;
        let request;
        try { request = contract.parseInput(context.body); }
        catch { return invalidInput(); }
        return tokenCatalogApplicationResult(
          contract,
          request,
          await input.queries.getSelection(tokenSelectionRequestBody(request)),
        );
      },
    },
  ], tokenCatalogInterfaceErrorMappings);
};

export {
  tokenCatalogControlRoutes,
  tokenSelectionListRequestBody,
  tokenSelectionRequestBody,
} from "./http-contract.js";
