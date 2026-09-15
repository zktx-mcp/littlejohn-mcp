import type { PresentationCardApplication } from "./mcp-app/card-application.js";
import { CardError } from "./mcp-app/card-errors.js";
import { CardDomainError } from "./mcp-app/card-sources.js";
import {
  admitApplicationInput,
  captureCanonicalJson,
  type ApplicationFailure,
  type CanonicalJson,
} from "../core/index.js";
import type {
  RouteContext,
  RouteDefinition,
  RouteResult,
  RuntimeRouteRegistry,
} from "../runtime/http-routing.js";
import {
  tokenCatalogApplicationContracts,
  type AnyTokenCatalogApplicationContract,
} from "../token-catalog/client.js";
import {
  tokenCatalogInterfaceErrorMappings,
} from "../token-catalog/errors.js";
import {
  TokenCatalogOperationError,
} from "../token-catalog/operation-error.js";
import {
  type TokenCatalogManagementApplicationPort,
} from "../token-catalog/ports.js";
import {
  walletManagementContracts,
  parseWalletDirectAction,
  parseWalletOperationCancellation,
  type WalletManagementPort,
} from "../wallet/contracts.js";
import {
  normalizeWalletError,
  walletInterfaceErrorMappings,
  WalletOperationError,
} from "../wallet/errors.js";
import { operationControlResources } from "./operation-bindings.js";

const success = (body: unknown): RouteResult => ({
  ok: true,
  body: captureCanonicalJson(body),
});
const failure = (value: ApplicationFailure): RouteResult => ({ ok: false, failure: value });

const operationId = (context: RouteContext): string => {
  const value = context.params["operationId"];
  if (value === undefined) throw new TypeError("Operation ID is missing.");
  return value;
};

const nestedReviewKind = (value: unknown): CanonicalJson | undefined => {
  const captured = captureCanonicalJson(value);
  if (typeof captured !== "object" || captured === null || Array.isArray(captured)) return undefined;
  const review = captured["review"];
  return typeof review === "object" && review !== null && !Array.isArray(review)
    ? review["kind"]
    : undefined;
};

const applicationResult = (
  contract: AnyTokenCatalogApplicationContract,
  request: unknown,
  value: unknown,
  invalidFailure: ApplicationFailure,
): RouteResult => {
  try { return success(contract.parsePublicSuccess(request, value)); }
  catch {
    try { return failure(contract.parseFailure(value)); }
    catch { return failure(invalidFailure); }
  }
};

const walletRoutes = (wallet: WalletManagementPort, cards: PresentationCardApplication): readonly RouteDefinition[] => Object.freeze([
  {
    method: "POST",
    mutation: "none",
    pathPattern: operationControlResources.wallet.reviews,
    successStatus: 200,
    handler: async (context) => {
      const contract = walletManagementContracts.review;
      const admission = admitApplicationInput(contract, context.body);
      if (!admission.ok) return failure(admission.failure);
      try {
        return success(contract.parsePublicSuccess(
          admission.value,
          await wallet.review(admission.value),
        ));
      } catch (error) { return failure(error instanceof CardError || error instanceof CardDomainError ? error.failure : normalizeWalletError(error).failure); }
    },
  },
  {
    method: "POST",
    mutation: "declared_control",
    pathPattern: operationControlResources.wallet.decisions,
    successStatus: 200,
    handler: async (context) => {
      try {
        const action = parseWalletDirectAction(context.body);
        const contract = walletManagementContracts[action.review.kind];
        const request = contract.parseInput(action as never);
        return success(contract.parsePublicSuccess(request as never, await cards.decideWithoutView("wallet", request, context.signal) as never));
      } catch (error) { return failure(error instanceof CardError || error instanceof CardDomainError ? error.failure : normalizeWalletError(error).failure); }
    },
  },
  {
    method: "GET",
    mutation: "none",
    pathPattern: operationControlResources.wallet.operationPattern,
    successStatus: 200,
    handler: async (context) => {
      const contract = walletManagementContracts.operation;
      const admission = admitApplicationInput(contract, { operationId: operationId(context) });
      if (!admission.ok) return failure(admission.failure);
      try {
        return success(contract.parsePublicSuccess(
          admission.value,
          await wallet.get(admission.value.operationId),
        ));
      } catch (error) { return failure(error instanceof CardError || error instanceof CardDomainError ? error.failure : normalizeWalletError(error).failure); }
    },
  },
  {
    method: "GET",
    mutation: "none",
    pathPattern: operationControlResources.wallet.presentationPattern,
    successStatus: 200,
    handler: async (context) => {
      try { return success(await wallet.getPresentation(operationId(context))); }
      catch (error) { return failure(error instanceof CardError || error instanceof CardDomainError ? error.failure : normalizeWalletError(error).failure); }
    },
  },
  {
    method: "POST",
    mutation: "declared_control",
    pathPattern: operationControlResources.wallet.cancellationPattern,
    successStatus: 200,
    handler: async (context) => {
      try {
        const request = parseWalletOperationCancellation(context.body);
        if (request.operationId !== operationId(context)) {
          throw new WalletOperationError("invalid_input");
        }
        return success(await wallet.cancel(request));
      } catch (error) { return failure(error instanceof CardError || error instanceof CardDomainError ? error.failure : normalizeWalletError(error).failure); }
    },
  },
]);

const tokenRoutes = (
  token: TokenCatalogManagementApplicationPort,
  cards: PresentationCardApplication,
): readonly RouteDefinition[] => Object.freeze([
  {
    method: "POST",
    mutation: "none",
    pathPattern: operationControlResources.tokenSelection.reviews,
    successStatus: 200,
    handler: async (context) => {
      const contract = tokenCatalogApplicationContracts.selectionChangeReview;
      const admission = admitApplicationInput(contract, context.body);
      if (!admission.ok) return failure(admission.failure);
      return applicationResult(
        contract,
        admission.value,
        await token.review(admission.value),
        new TokenCatalogOperationError("internal_error").failure,
      );
    },
  },
  {
    method: "POST",
    mutation: "declared_control",
    pathPattern: operationControlResources.tokenSelection.decisions,
    successStatus: 200,
    handler: async (context) => {
      const captured = captureCanonicalJson(context.body);
      const kind = nestedReviewKind(captured);
      const contract = kind === "add"
        ? tokenCatalogApplicationContracts.addSelection
        : kind === "remove"
          ? tokenCatalogApplicationContracts.removeSelection
          : undefined;
      if (contract === undefined) return failure(new TokenCatalogOperationError("invalid_input").failure);
      const admission = admitApplicationInput(contract, captured as never);
      if (!admission.ok) return failure(admission.failure);
      try {
        return applicationResult(contract, admission.value,
          await cards.decideWithoutView("token_selection", admission.value, context.signal),
          new TokenCatalogOperationError("internal_error").failure);
      } catch (error) {
        return failure(error instanceof CardError || error instanceof CardDomainError
          ? error.failure : new TokenCatalogOperationError("internal_error").failure);
      }
    },
  },
  {
    method: "GET",
    mutation: "none",
    pathPattern: operationControlResources.tokenSelection.operationPattern,
    successStatus: 200,
    handler: async (context) => {
      const contract = tokenCatalogApplicationContracts.operation;
      const admission = admitApplicationInput(contract, { operationId: operationId(context) });
      if (!admission.ok) return failure(admission.failure);
      return applicationResult(
        contract,
        admission.value,
        token.getOperation(admission.value),
        new TokenCatalogOperationError("internal_error").failure,
      );
    },
  },
]);

export const extendOperationRoutes = (input: Readonly<{
  routes: RuntimeRouteRegistry;
  wallet: WalletManagementPort;
  token: TokenCatalogManagementApplicationPort;
  cards: PresentationCardApplication;
}>): RuntimeRouteRegistry => {
  const wallet = input.routes.extend(walletRoutes(input.wallet, input.cards), walletInterfaceErrorMappings);
  return wallet.extend(tokenRoutes(input.token, input.cards), tokenCatalogInterfaceErrorMappings);
};
