import {
  accountAssetApplicationContracts,
  accountAssetApplicationResult,
  accountAssetBrowserRoutes,
  accountAssetInterfaceErrorMappings,
  accountAssetOverviewQueryContract,
  createAccountAssetFailure,
  parseAccountAssetExactPath,
  type AccountAssetApplicationPort,
} from "../account-assets/index.js";
import {
  captureCanonicalJson,
  type ApplicationFailure,
} from "../core/index.js";
import type {
  ResourcePathDefinition,
  RouteContext,
  RouteResult,
  RuntimeRouteRegistry,
} from "../runtime/http-routing.js";
import {
  parseTokenCatalogCancellationBody,
  parseTokenCatalogConfirmationBody,
  parseTokenCatalogControlOperationCreate,
  parseTokenCatalogOperationCreate,
  parseTokenCatalogOperationPathId,
  startTokenCatalogOperation,
  tokenCatalogApplicationResult,
  tokenCatalogStartApplicationResult,
  tokenCatalogBrowserRoutes,
  tokenCatalogCurrentOperationSchema,
  tokenCatalogOperationConfirmationContract,
  normalizeTokenCatalogError,
  TokenCatalogOperationError,
  type TokenCatalogBrowserOperationPort,
  type TokenCatalogWebStartPort,
} from "../token-catalog/index.js";
import {
  parseWalletCurrentOperationProjection,
  parseWalletManagementOperation,
  parseWalletOperationConfirmation,
  parseWalletOperationCreate,
  parseWalletOperationId,
  parseWalletOperationPresentation,
  parseWalletOperationStartResult,
  walletManagementContracts,
  walletOperationConfirmationContract,
  type WalletInterfaceOperations,
} from "../wallet/contracts.js";
import {
  createWalletFailure,
  normalizeWalletError,
} from "../wallet/errors.js";
import type { BrowserAssetBundle } from "./browser-assets.js";
import { browserCapabilityBindings } from "./browser-capability-bindings.js";
import {
  browserAssetPaths,
  browserInformationPages,
  browserPages,
  browserWalletApiPaths,
  parseBrowserLocation,
} from "./browser-contract.js";
import type { BrowserRequestCredentialAuthority } from "./browser-credentials.js";

const success = (body: unknown): RouteResult => ({
  ok: true,
  body: captureCanonicalJson(body),
});

const failure = (applicationFailure: ApplicationFailure): RouteResult => ({
  ok: false,
  failure: applicationFailure,
});

const invalidInput = (): RouteResult => failure(createWalletFailure("invalid_input"));
const normalizeFailure = (error: unknown): RouteResult =>
  failure(normalizeWalletError(error).failure);

const tokenInvalidInput = (): RouteResult => failure(
  new TokenCatalogOperationError("invalid_input").failure,
);
const normalizeTokenFailure = (error: unknown): RouteResult =>
  failure(normalizeTokenCatalogError(error).failure);

const operationId = (context: RouteContext): string =>
  parseWalletOperationId(context.params["operationId"]);

const operationForId = (id: string, value: unknown) => {
  const operation = parseWalletManagementOperation(value);
  if (operation.operationId !== id) {
    throw new TypeError("Wallet operation identity does not match the requested resource.");
  }
  return operation;
};

const presentationForId = (id: string, value: unknown) => {
  const presentation = parseWalletOperationPresentation(value);
  return Object.freeze({
    ...presentation,
    operation: browserCapabilityBindings.walletOperation.contract.parsePublicSuccess(
      { operationId: id },
      presentation.operation,
    ),
  });
};

const browserPageResources: readonly ResourcePathDefinition[] = Object.freeze(
  browserInformationPages.map((page) => Object.freeze({
    kind: "route",
    method: "GET",
    pathPattern: page.pathPattern,
    requestClass: "browser_bootstrap",
  })),
);

const browserApiResources: readonly ResourcePathDefinition[] = Object.freeze([
  Object.freeze({
    kind: "route",
    method: "GET",
    pathPattern: accountAssetBrowserRoutes.overview,
    requestClass: "browser_read",
  }),
  Object.freeze({
    kind: "route",
    method: "POST",
    pathPattern: accountAssetBrowserRoutes.exactPattern,
    requestClass: "browser_query",
  }),
  Object.freeze({
    kind: "route",
    method: "POST",
    pathPattern: browserWalletApiPaths.operations,
    requestClass: "browser_control",
  }),
  Object.freeze({
    kind: "route",
    method: "GET",
    pathPattern: browserWalletApiPaths.currentOperation,
    requestClass: "browser_read",
  }),
  Object.freeze({
    kind: "route",
    method: "GET",
    pathPattern: browserWalletApiPaths.operationPattern,
    requestClass: "browser_read",
  }),
  Object.freeze({
    kind: "route",
    method: "POST",
    pathPattern: browserWalletApiPaths.confirmationPattern,
    requestClass: "browser_control",
  }),
  Object.freeze({
    kind: "route",
    method: "POST",
    pathPattern: browserWalletApiPaths.cancellationPattern,
    requestClass: "browser_control",
  }),
  Object.freeze({
    kind: "route",
    method: "POST",
    pathPattern: tokenCatalogBrowserRoutes.operations,
    requestClass: "browser_control",
  }),
  Object.freeze({
    kind: "route",
    method: "GET",
    pathPattern: tokenCatalogBrowserRoutes.currentOperation,
    requestClass: "browser_read",
  }),
  Object.freeze({
    kind: "route",
    method: "GET",
    pathPattern: tokenCatalogBrowserRoutes.operationPattern,
    requestClass: "browser_read",
  }),
  Object.freeze({
    kind: "route",
    method: "POST",
    pathPattern: tokenCatalogBrowserRoutes.confirmationPattern,
    requestClass: "browser_control",
  }),
  Object.freeze({
    kind: "route",
    method: "POST",
    pathPattern: tokenCatalogBrowserRoutes.cancellationPattern,
    requestClass: "browser_control",
  }),
]);

const browserAssetResources: readonly ResourcePathDefinition[] = Object.freeze([
  Object.freeze({
    kind: "route",
    method: "GET",
    pathPattern: browserAssetPaths.pattern,
    requestClass: "public_read",
  }),
]);

const browserResources: readonly ResourcePathDefinition[] = Object.freeze([
  ...browserPageResources,
  ...browserApiResources,
  ...browserAssetResources,
]);

export const extendBrowserInterfaceRoutes = (input: {
  readonly routes: RuntimeRouteRegistry;
  readonly credentials: BrowserRequestCredentialAuthority;
  readonly assets: BrowserAssetBundle;
  readonly walletOperations: WalletInterfaceOperations;
  readonly accountAssets: AccountAssetApplicationPort;
  readonly tokenCatalogWebStart: TokenCatalogWebStartPort;
  readonly tokenCatalogBrowserOperations: TokenCatalogBrowserOperationPort;
}): RuntimeRouteRegistry => {
  const securedRoutes = input.routes.extendRequestPolicies(
    input.credentials.requestPolicyExtension,
    browserResources,
  );
  const operations = input.walletOperations.operation;
  const confirmation = input.walletOperations.confirmation;
  const presentation = input.walletOperations.presentation;
  const currentProjection = input.walletOperations.currentProjection;
  if (confirmation.interactionInterface !== "web") {
    throw new TypeError("Browser confirmation requires the web confirmation port.");
  }
  if (input.tokenCatalogWebStart.interactionInterface !== "web" ||
    input.tokenCatalogBrowserOperations.interactionInterface !== "web") {
    throw new TypeError("Browser token catalog ports require the web interaction interface.");
  }
  const bootstrap = async (): Promise<RouteResult> => {
    try {
      const issued = input.credentials.issue();
      return {
        ok: true,
        body: input.assets.renderShell(issued.csrfToken),
        contentType: "text/html; charset=utf-8",
        setCookie: issued.setCookie,
      };
    } catch (error) {
      return normalizeFailure(error);
    }
  };
  const bootstrapReferencePrice = async (
    context: RouteContext,
  ): Promise<RouteResult> => {
    const pairId = context.params["pairId"];
    try {
      if (pairId === undefined) throw new TypeError("Reference pair is missing.");
      const location = parseBrowserLocation(
        `/prices/${pairId}`,
        context.query,
        "",
      );
      if (location.page !== browserPages.referencePrice.id ||
        location.pairId !== pairId) {
        throw new TypeError("Reference price location does not match the route.");
      }
    } catch {
      return failure(createWalletFailure("invalid_input"));
    }
    return bootstrap();
  };

  const browserRoutes = securedRoutes.extend([
    ...browserInformationPages.map((page) => ({
      method: "GET",
      mutation: "none",
      pathPattern: page.pathPattern,
      query: page.id === "reference_price"
        ? "browser_location"
        : "none",
      response: "browser_content",
      successStatus: 200,
      handler: page.id === browserPages.referencePrice.id
        ? bootstrapReferencePrice
        : bootstrap,
    } as const)),
    {
      method: "GET",
      mutation: "none",
      pathPattern: accountAssetBrowserRoutes.overview,
      query: "none",
      response: "canonical_json",
      successStatus: 200,
      handler: async (context) => {
        const contract = accountAssetOverviewQueryContract;
        let request;
        try { request = contract.parseInput({}); }
        catch { return failure(createAccountAssetFailure("invalid_input")); }
        return accountAssetApplicationResult(
          contract,
          request,
          await input.accountAssets.getOverview(request, context.signal),
        );
      },
    },
    {
      method: "POST",
      mutation: "none",
      pathPattern: accountAssetBrowserRoutes.exactPattern,
      query: "none",
      response: "canonical_json",
      successStatus: 200,
      handler: async (context) => {
        const contract = accountAssetApplicationContracts.exact;
        let request;
        try { request = parseAccountAssetExactPath(context); }
        catch { return failure(createAccountAssetFailure("invalid_input")); }
        return accountAssetApplicationResult(
          contract,
          request,
          await input.accountAssets.get(request, context.signal),
        );
      },
    },
    {
      method: "POST",
      mutation: "declared_control",
      pathPattern: browserWalletApiPaths.operations,
      query: "none",
      response: "canonical_json",
      successStatus: 200,
      handler: async (context) => {
        let request;
        try {
          request = parseWalletOperationCreate(context.body);
          if (request.interactionInterface !== "web" || request.connectionRevision === null) {
            throw new TypeError("Browser operation interface is invalid.");
          }
        } catch {
          return invalidInput();
        }
        try {
          const result = parseWalletOperationStartResult(await operations.start({
            kind: request.kind,
            connectionRevision: request.connectionRevision,
          }, request.operationId));
          const contract = request.kind === "connect"
            ? browserCapabilityBindings.walletConnect.contract
            : browserCapabilityBindings.walletDisconnect.contract;
          return success(contract.parseBoundSuccess(
            {},
            { operationId: request.operationId, interactionInterface: "web" },
            result,
          ));
        } catch (error) {
          return normalizeFailure(error);
        }
      },
    },
    {
      method: "GET",
      mutation: "none",
      pathPattern: browserWalletApiPaths.currentOperation,
      query: "none",
      response: "canonical_json",
      successStatus: 200,
      handler: async () => {
        try {
          const current = parseWalletCurrentOperationProjection(await currentProjection.get());
          return success(walletManagementContracts.currentOperation.parsePublicSuccess({}, current));
        } catch (error) {
          return normalizeFailure(error);
        }
      },
    },
    {
      method: "GET",
      mutation: "none",
      pathPattern: browserWalletApiPaths.operationPattern,
      query: "none",
      response: "canonical_json",
      successStatus: 200,
      handler: async (context) => {
        let id;
        try {
          id = operationId(context);
        } catch {
          return invalidInput();
        }
        try {
          return success(presentationForId(id, await presentation.get(id, "web")));
        } catch (error) {
          return normalizeFailure(error);
        }
      },
    },
    {
      method: "POST",
      mutation: "declared_control",
      pathPattern: browserWalletApiPaths.confirmationPattern,
      query: "none",
      response: "canonical_json",
      successStatus: 200,
      handler: async (context) => {
        let id;
        let request;
        try {
          id = operationId(context);
          request = parseWalletOperationConfirmation(context.body);
        } catch {
          return invalidInput();
        }
        try {
          return success(walletOperationConfirmationContract.parseBoundSuccess(
            { operationId: id, connectionRevision: request.connectionRevision },
            { operationId: id, interactionInterface: "web" },
            operationForId(id, await confirmation.confirm(id, request)),
          ));
        } catch (error) {
          return normalizeFailure(error);
        }
      },
    },
    {
      method: "POST",
      mutation: "declared_control",
      pathPattern: browserWalletApiPaths.cancellationPattern,
      query: "none",
      response: "canonical_json",
      successStatus: 200,
      handler: async (context) => {
        let id;
        let request;
        try {
          id = operationId(context);
          request = parseWalletOperationConfirmation(context.body);
        } catch {
          return invalidInput();
        }
        try {
          const operation = operationForId(
            id,
            await operations.cancel(id, request),
          );
          return success(browserCapabilityBindings.walletCancelOperation.contract.parseBoundSuccess(
            { operationId: id, connectionRevision: request.connectionRevision },
            { operationId: id, interactionInterface: "web" },
            operation,
          ));
        } catch (error) {
          return normalizeFailure(error);
        }
      },
    },
    {
      method: "POST",
      mutation: "declared_control",
      pathPattern: tokenCatalogBrowserRoutes.operations,
      query: "none",
      response: "canonical_json",
      successStatus: 200,
      handler: async (context) => {
        let create;
        try {
          create = parseTokenCatalogControlOperationCreate(context.body);
          if (create.interactionInterface !== "web") throw new TypeError("Browser operation interface is invalid.");
        }
        catch { return tokenInvalidInput(); }
        const contract = create.request.kind === "add"
          ? browserCapabilityBindings.tokenStartAddition.contract
          : browserCapabilityBindings.tokenStartRemoval.contract;
        try {
          return tokenCatalogStartApplicationResult(
            contract,
            create.request.request,
            {
              operationId: create.operationId,
              interactionInterface: "web",
            },
            await startTokenCatalogOperation(create.request, input.tokenCatalogWebStart, create.operationId),
          );
        } catch (error) { return normalizeTokenFailure(error); }
      },
    },
    {
      method: "GET",
      mutation: "none",
      pathPattern: tokenCatalogBrowserRoutes.currentOperation,
      query: "none",
      response: "canonical_json",
      successStatus: 200,
      handler: async () => {
        try {
          return success(tokenCatalogCurrentOperationSchema.parse({
            operation: input.tokenCatalogBrowserOperations.getCurrentOperation(),
          }));
        } catch (error) { return normalizeTokenFailure(error); }
      },
    },
    {
      method: "GET",
      mutation: "none",
      pathPattern: tokenCatalogBrowserRoutes.operationPattern,
      query: "none",
      response: "canonical_json",
      successStatus: 200,
      handler: async (context) => {
        const contract = browserCapabilityBindings.tokenOperation.contract;
        let request;
        try {
          request = contract.parseInput({
            operationId: parseTokenCatalogOperationPathId(context.params["operationId"]),
          });
        } catch { return tokenInvalidInput(); }
        try {
          return tokenCatalogApplicationResult(
            contract,
            request,
            await input.tokenCatalogBrowserOperations.getOperation(request),
          );
        } catch (error) { return normalizeTokenFailure(error); }
      },
    },
    {
      method: "POST",
      mutation: "declared_control",
      pathPattern: tokenCatalogBrowserRoutes.confirmationPattern,
      query: "none",
      response: "canonical_json",
      successStatus: 200,
      handler: async (context) => {
        let request;
        try {
          request = parseTokenCatalogConfirmationBody(
            parseTokenCatalogOperationPathId(context.params["operationId"]),
            context.body,
          );
        } catch { return tokenInvalidInput(); }
        try {
          return success(tokenCatalogOperationConfirmationContract.parseBoundSuccess(
            request,
            { operationId: request.operationId, interactionInterface: "web" },
            await input.tokenCatalogBrowserOperations.confirm(request),
          ));
        } catch (error) { return normalizeTokenFailure(error); }
      },
    },
    {
      method: "POST",
      mutation: "declared_control",
      pathPattern: tokenCatalogBrowserRoutes.cancellationPattern,
      query: "none",
      response: "canonical_json",
      successStatus: 200,
      handler: async (context) => {
        const contract = browserCapabilityBindings.tokenCancelOperation.contract;
        let request;
        try {
          parseTokenCatalogCancellationBody(context.body);
          request = contract.parseInput({
            operationId: parseTokenCatalogOperationPathId(context.params["operationId"]),
          });
        } catch { return tokenInvalidInput(); }
        try {
          return tokenCatalogApplicationResult(contract, request, {
            operation: await input.tokenCatalogBrowserOperations.cancel(request.operationId),
          });
        } catch (error) { return normalizeTokenFailure(error); }
      },
    },
    {
      method: "GET",
      mutation: "none",
      pathPattern: browserAssetPaths.pattern,
      query: "none",
      response: "browser_content",
      successStatus: 200,
      handler: async (context) => {
        const name = context.params["assetName"];
        const asset = name === undefined ? undefined : input.assets.get(`/assets/${name}`);
        return asset === undefined
          ? failure(createWalletFailure("route_not_found"))
          : { ok: true, body: asset.body, contentType: asset.contentType };
      },
    },
  ]);
  return browserRoutes;
};
