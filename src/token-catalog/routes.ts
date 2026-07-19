import {
  CapabilityBindingRegistry,
  CapabilityRegistry,
  captureCanonicalJson,
  type ApplicationFailure,
  type CanonicalJson,
} from "../core/index.js";
import type {
  RouteContext,
  RouteResult,
  RuntimeRouteRegistry,
} from "../runtime/index.js";
import {
  tokenCatalogApplicationContracts,
  tokenCatalogOperationConfirmationContract,
  tokenCatalogOperationIdSchema,
  tokenInspectCapability,
  type AnyTokenCatalogApplicationContract,
  type TokenCatalogOperation,
  type TokenCatalogOperationConfirmationInput,
  type TokenCatalogOperationStartResult,
  type TokenRegistrationStartRequest,
  type TokenRegistrationUpdateStartInput,
  type TokenUnregistrationStartInput,
} from "./contracts.js";
import {
  normalizeTokenCatalogError,
  TokenCatalogOperationError,
} from "./operation-error.js";
import type {
  TokenCatalogBrowserOperationPort,
  TokenCatalogInspectionPort,
  TokenCatalogInteractiveCliPort,
  TokenCatalogNonInteractiveOperationPort,
  TokenCatalogQueryApplicationPort,
  TokenCatalogWebStartPort,
} from "./ports.js";
import { tokenCatalogInterfaceErrorMappings } from "./errors.js";
import {
  tokenCatalogInteractionInterfaces,
  type TokenCatalogInteractionInterface,
} from "./state.js";
import {
  tokenCatalogBrowserRoutes,
  tokenCatalogControlRoutes,
  tokenRegistrationListRequestBody,
} from "./http-contract.js";

export {
  tokenCatalogBrowserRoutes,
  tokenCatalogControlRoutes,
  tokenRegistrationListRequestBody,
} from "./http-contract.js";

export type TokenCatalogOperationCreate =
  | Readonly<{ kind: "register"; request: TokenRegistrationStartRequest }>
  | Readonly<{ kind: "update_registration"; request: TokenRegistrationUpdateStartInput }>
  | Readonly<{ kind: "unregister"; request: TokenUnregistrationStartInput }>;

const canonicalRecord = (input: unknown): Readonly<Record<string, CanonicalJson>> => {
  const value = captureCanonicalJson(input);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Expected an object.");
  }
  return value;
};

const exactKeys = (
  value: Readonly<Record<string, CanonicalJson>>,
  expected: readonly string[],
): void => {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (keys.length !== sortedExpected.length || keys.some((key, index) => key !== sortedExpected[index])) {
    throw new TypeError("Object fields are invalid.");
  }
};

export const parseTokenCatalogOperationCreate = (
  input: unknown,
): TokenCatalogOperationCreate => {
  const body = canonicalRecord(input);
  const kind = body["kind"];
  const request = Object.fromEntries(
    Object.entries(body).filter(([key]) => key !== "kind"),
  );
  if (kind === "register") {
    return Object.freeze({
      kind,
      request: tokenCatalogApplicationContracts.startRegistration.parseInput(request),
    });
  }
  if (kind === "update_registration") {
    return Object.freeze({
      kind,
      request: tokenCatalogApplicationContracts.startRegistrationUpdate.parseInput(request),
    });
  }
  if (kind === "unregister") {
    return Object.freeze({
      kind,
      request: tokenCatalogApplicationContracts.startUnregistration.parseInput(request),
    });
  }
  throw new TypeError("Token catalog operation kind is invalid.");
};

export const parseTokenCatalogControlOperationCreate = (input: unknown): Readonly<{
  interactionInterface: TokenCatalogInteractionInterface;
  request: TokenCatalogOperationCreate;
}> => {
  const body = canonicalRecord(input);
  exactKeys(body, ["interactionInterface", "request"]);
  const interactionInterface = tokenCatalogInteractionInterfaces.find(
    (candidate) => candidate === body["interactionInterface"],
  );
  if (interactionInterface === undefined) {
    throw new TypeError("Token catalog interaction interface is invalid.");
  }
  return Object.freeze({
    interactionInterface,
    request: parseTokenCatalogOperationCreate(body["request"]),
  });
};

export const parseTokenCatalogConfirmationBody = (
  operationIdInput: unknown,
  input: unknown,
): TokenCatalogOperationConfirmationInput => {
  const body = canonicalRecord(input);
  exactKeys(body, ["reviewDigest"]);
  return tokenCatalogOperationConfirmationContract.parseInput({
    operationId: operationIdInput,
    reviewDigest: body["reviewDigest"],
  });
};

export const parseTokenCatalogCancellationBody = (input: unknown): void => {
  exactKeys(canonicalRecord(input), []);
};

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

const normalizeFailure = (error: unknown): RouteResult =>
  failure(normalizeTokenCatalogError(error).failure);

export const tokenCatalogApplicationResult = (
  contract: AnyTokenCatalogApplicationContract,
  request: unknown,
  value: unknown,
): RouteResult => {
  try { return success(contract.parseSuccess(request, value)); }
  catch {
    try { return failure(contract.parseFailure(value)); }
    catch { return normalizeFailure(value); }
  }
};

export const parseTokenCatalogOperationPathId = (
  operationIdInput: unknown,
): TokenCatalogOperation["operationId"] =>
  tokenCatalogOperationIdSchema.parse(operationIdInput);

export const parseTokenCatalogRegistrationPathInput = (
  chainIdInput: unknown,
  tokenAddressInput: unknown,
) =>
  tokenCatalogApplicationContracts.registration.parseInput({
    asset: {
      kind: "erc20",
      chainId: chainIdInput,
      address: tokenAddressInput,
    },
  });

const operationId = (context: RouteContext): TokenCatalogOperation["operationId"] =>
  parseTokenCatalogOperationPathId(context.params["operationId"]);

const registrationRequest = (context: RouteContext) =>
  parseTokenCatalogRegistrationPathInput(
    context.params["chainId"],
    context.params["tokenAddress"],
  );

export const startTokenCatalogOperation = (
  input: TokenCatalogOperationCreate,
  port: TokenCatalogWebStartPort | TokenCatalogInteractiveCliPort,
): Promise<TokenCatalogOperationStartResult | ApplicationFailure> => {
  switch (input.kind) {
    case "register": return port.startRegistration(input.request);
    case "update_registration": return port.startRegistrationUpdate(input.request);
    case "unregister": return port.startUnregistration(input.request);
  }
};

export const tokenCatalogStartContract = (kind: TokenCatalogOperationCreate["kind"]) => {
  switch (kind) {
    case "register": return tokenCatalogApplicationContracts.startRegistration;
    case "update_registration": return tokenCatalogApplicationContracts.startRegistrationUpdate;
    case "unregister": return tokenCatalogApplicationContracts.startUnregistration;
  }
};

export const extendTokenCatalogControlRouteRegistry = (input: {
  readonly routes: RuntimeRouteRegistry;
  readonly inspection: TokenCatalogInspectionPort;
  readonly queries: TokenCatalogQueryApplicationPort;
  readonly webStart: TokenCatalogWebStartPort;
  readonly interactiveCli: TokenCatalogInteractiveCliPort;
  readonly nonInteractiveOperations: TokenCatalogNonInteractiveOperationPort;
}): RuntimeRouteRegistry => {
  if (input.webStart.interactionInterface !== "web" ||
    input.interactiveCli.interactionInterface !== "cli") {
    throw new TypeError("Token catalog interaction ports are invalid.");
  }
  const inspections = new CapabilityBindingRegistry(
    new CapabilityRegistry([tokenInspectCapability]),
    [input.inspection],
  );

  return input.routes.extend([
    {
      method: "POST",
      mutation: "none",
      pathPattern: tokenCatalogControlRoutes.inspections,
      response: "canonical_json",
      successStatus: 200,
      handler: async (context) => {
        try {
          const result = await inspections.invoke(
            tokenInspectCapability,
            context.body,
            { signal: context.signal },
          );
          return result.ok ? success(result) : failure(result);
        } catch (error) { return normalizeFailure(error); }
      },
    },
    {
      method: "POST",
      mutation: "none",
      pathPattern: tokenCatalogControlRoutes.registrationQueries,
      response: "canonical_json",
      successStatus: 200,
      handler: async (context) => {
        const contract = tokenCatalogApplicationContracts.registrations;
        let request;
        try { request = contract.parseInput(context.body); }
        catch { return invalidInput(); }
        try {
          return tokenCatalogApplicationResult(
            contract,
            request,
            await input.queries.listRegistrations(tokenRegistrationListRequestBody(request)),
          );
        }
        catch (error) { return normalizeFailure(error); }
      },
    },
    {
      method: "GET",
      mutation: "none",
      pathPattern: tokenCatalogControlRoutes.registrationPattern,
      response: "canonical_json",
      successStatus: 200,
      handler: async (context) => {
        const contract = tokenCatalogApplicationContracts.registration;
        let request;
        try { request = registrationRequest(context); }
        catch { return invalidInput(); }
        try {
          return tokenCatalogApplicationResult(
            contract,
            request,
            await input.queries.getRegistration(request),
          );
        }
        catch (error) { return normalizeFailure(error); }
      },
    },
    {
      method: "POST",
      mutation: "declared_control",
      pathPattern: tokenCatalogControlRoutes.operations,
      response: "canonical_json",
      successStatus: 200,
      handler: async (context) => {
        let create;
        try { create = parseTokenCatalogControlOperationCreate(context.body); }
        catch { return invalidInput(); }
        const port = create.interactionInterface === "web"
          ? input.webStart
          : input.interactiveCli;
        const contract = tokenCatalogStartContract(create.request.kind);
        try {
          return tokenCatalogApplicationResult(
            contract,
            create.request.request,
            await startTokenCatalogOperation(create.request, port),
          );
        } catch (error) { return normalizeFailure(error); }
      },
    },
    {
      method: "GET",
      mutation: "none",
      pathPattern: tokenCatalogControlRoutes.operationPattern,
      response: "canonical_json",
      successStatus: 200,
      handler: async (context) => {
        const contract = tokenCatalogApplicationContracts.operation;
        let request;
        try { request = contract.parseInput({ operationId: operationId(context) }); }
        catch { return invalidInput(); }
        try {
          return tokenCatalogApplicationResult(
            contract,
            request,
            await input.nonInteractiveOperations.getOperation(request),
          );
        }
        catch (error) { return normalizeFailure(error); }
      },
    },
    {
      method: "POST",
      mutation: "declared_control",
      pathPattern: tokenCatalogControlRoutes.confirmationPattern,
      response: "canonical_json",
      successStatus: 200,
      handler: async (context) => {
        let request;
        try { request = parseTokenCatalogConfirmationBody(operationId(context), context.body); }
        catch { return invalidInput(); }
        try {
          const value = await input.interactiveCli.confirm(request);
          return success(tokenCatalogOperationConfirmationContract.parseSuccess(request, value));
        } catch (error) { return normalizeFailure(error); }
      },
    },
    {
      method: "DELETE",
      mutation: "declared_control",
      pathPattern: tokenCatalogControlRoutes.operationPattern,
      response: "canonical_json",
      successStatus: 200,
      handler: async (context) => {
        const contract = tokenCatalogApplicationContracts.cancelOperation;
        let request;
        try { request = contract.parseInput({ operationId: operationId(context) }); }
        catch { return invalidInput(); }
        try {
          return tokenCatalogApplicationResult(
            contract,
            request,
            await input.nonInteractiveOperations.cancelOperation(request),
          );
        } catch (error) { return normalizeFailure(error); }
      },
    },
  ], tokenCatalogInterfaceErrorMappings);
};
