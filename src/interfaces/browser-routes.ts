import {
  captureCanonicalJson,
  type ApplicationFailure,
} from "../core/index.js";
import type {
  ResourcePathDefinition,
  RouteContext,
  RouteResult,
  RuntimeRouteRegistry,
} from "../runtime/index.js";
import {
  parseWalletManagementOperation,
  parseWalletOperationConfirmation,
  parseWalletOperationId,
  parseWalletOperationPresentation,
  type WalletInterfaceOperations,
} from "../wallet/contracts.js";
import {
  createWalletFailure,
  normalizeWalletError,
} from "../wallet/errors.js";
import type { BrowserAssetBundle } from "./browser-assets.js";
import { browserInterfacePaths } from "./browser-contract.js";
import type { BrowserRequestCredentialAuthority } from "./browser-credentials.js";
import {
  createOperationControlResponse,
  createOperationReadResponse,
  createQrResponse,
} from "./browser-responses.js";

const success = (body: unknown): RouteResult => ({
  ok: true,
  body: captureCanonicalJson(body),
});

const failure = (applicationFailure: ApplicationFailure): RouteResult => ({
  ok: false,
  failure: applicationFailure,
});

const invalidInput = (): RouteResult => failure(createWalletFailure("invalid_input"));
const normalizeFailure = (error: unknown): RouteResult => failure(normalizeWalletError(error).failure);

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
  if (presentation.operation.operationId !== id) {
    throw new TypeError("Wallet operation presentation identity does not match the requested resource.");
  }
  return presentation;
};

const resourceDefinitions: readonly ResourcePathDefinition[] = Object.freeze([
  Object.freeze({
    kind: "route",
    method: "GET",
    pathPattern: browserInterfacePaths.operationPagePattern,
    requestClass: "browser_bootstrap",
  }),
  Object.freeze({
    kind: "route",
    method: "GET",
    pathPattern: browserInterfacePaths.operationPattern,
    requestClass: "browser_read",
  }),
  Object.freeze({
    kind: "route",
    method: "GET",
    pathPattern: browserInterfacePaths.qrPattern,
    requestClass: "browser_read",
  }),
  Object.freeze({
    kind: "route",
    method: "POST",
    pathPattern: browserInterfacePaths.confirmationPattern,
    requestClass: "browser_control",
  }),
  Object.freeze({
    kind: "route",
    method: "DELETE",
    pathPattern: browserInterfacePaths.operationPattern,
    requestClass: "browser_control",
  }),
  Object.freeze({
    kind: "route",
    method: "GET",
    pathPattern: browserInterfacePaths.assetPattern,
    requestClass: "public_read",
  }),
]);

export const extendBrowserInterfaceRoutes = (input: {
  readonly routes: RuntimeRouteRegistry;
  readonly credentials: BrowserRequestCredentialAuthority;
  readonly assets: BrowserAssetBundle;
  readonly walletOperations: WalletInterfaceOperations;
}): RuntimeRouteRegistry => {
  const securedRoutes = input.routes.extendRequestPolicies(
    input.credentials.requestPolicyExtension,
    resourceDefinitions,
  );
  const presentation = input.walletOperations.presentation;
  const operations = input.walletOperations.operation;
  const confirmation = input.walletOperations.confirmation;
  if (confirmation.interactionInterface !== "web") {
    throw new TypeError("Browser confirmation requires the web confirmation port.");
  }

  return securedRoutes.extend([
    {
      method: "GET",
      mutation: "none",
      pathPattern: browserInterfacePaths.operationPagePattern,
      response: "browser_content",
      successStatus: 200,
      handler: async (context) => {
        let id;
        try { id = operationId(context); }
        catch { return invalidInput(); }
        try {
          const snapshot = presentationForId(id, await presentation.get(id));
          const issued = input.credentials.issue(
            id,
            snapshot.operation.expiresAt,
            snapshot.access,
          );
          return {
            ok: true,
            body: input.assets.renderShell(issued.csrfToken),
            contentType: "text/html; charset=utf-8",
            setCookie: issued.setCookie,
          };
        } catch (error) { return normalizeFailure(error); }
      },
    },
    {
      method: "GET",
      mutation: "none",
      pathPattern: browserInterfacePaths.operationPattern,
      response: "canonical_json",
      successStatus: 200,
      handler: async (context) => {
        let id;
        try { id = operationId(context); }
        catch { return invalidInput(); }
        try {
          const snapshot = presentationForId(id, await presentation.get(id));
          return success(createOperationReadResponse(
            snapshot.operation,
            snapshot.access,
          ));
        } catch (error) { return normalizeFailure(error); }
      },
    },
    {
      method: "GET",
      mutation: "none",
      pathPattern: browserInterfacePaths.qrPattern,
      response: "canonical_json",
      successStatus: 200,
      handler: async (context) => {
        let id;
        try { id = operationId(context); }
        catch { return invalidInput(); }
        try {
          const snapshot = presentationForId(id, await presentation.get(id));
          if (snapshot.qr === undefined) return failure(createWalletFailure("state_conflict"));
          return success(createQrResponse(snapshot.qr));
        } catch (error) { return normalizeFailure(error); }
      },
    },
    {
      method: "POST",
      mutation: "declared_control",
      pathPattern: browserInterfacePaths.confirmationPattern,
      response: "canonical_json",
      successStatus: 200,
      handler: async (context) => {
        let id;
        let request;
        try {
          id = operationId(context);
          request = parseWalletOperationConfirmation(context.body);
        } catch { return invalidInput(); }
        try {
          return success(createOperationControlResponse(
            operationForId(id, await confirmation.confirm(id, request)),
          ));
        } catch (error) { return normalizeFailure(error); }
      },
    },
    {
      method: "DELETE",
      mutation: "declared_control",
      pathPattern: browserInterfacePaths.operationPattern,
      response: "canonical_json",
      successStatus: 200,
      handler: async (context) => {
        let id;
        try { id = operationId(context); }
        catch { return invalidInput(); }
        try {
          return success(createOperationControlResponse(
            operationForId(id, await operations.cancel(id)),
          ));
        } catch (error) { return normalizeFailure(error); }
      },
    },
    {
      method: "GET",
      mutation: "none",
      pathPattern: browserInterfacePaths.assetPattern,
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
};
