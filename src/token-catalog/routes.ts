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
  type TokenAdditionStartRequest,
  type TokenRemovalStartInput,
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
  tokenSelectionListRequestBody,
} from "./http-contract.js";

export {
  tokenCatalogBrowserRoutes,
  tokenCatalogControlRoutes,
  tokenSelectionListRequestBody,
} from "./http-contract.js";

export type TokenCatalogOperationCreate =
  | Readonly<{ kind: "add"; request: TokenAdditionStartRequest }>
  | Readonly<{ kind: "remove"; request: TokenRemovalStartInput }>;

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
  if (kind === "add") {
    return Object.freeze({
      kind,
      request: tokenCatalogApplicationContracts.startAddition.parseInput(request),
    });
  }
  if (kind === "remove") {
    return Object.freeze({
      kind,
      request: tokenCatalogApplicationContracts.startRemoval.parseInput(request),
    });
  }
  throw new TypeError("Token catalog operation kind is invalid.");
};

export const parseTokenCatalogControlOperationCreate = (input: unknown): Readonly<{
  operationId: TokenCatalogOperation["operationId"];
  interactionInterface: TokenCatalogInteractionInterface;
  request: TokenCatalogOperationCreate;
}> => {
  const body = canonicalRecord(input);
  exactKeys(body, ["control", "request"]);
  const control = canonicalRecord(body["control"]);
  exactKeys(control, ["operationId", "interactionInterface"]);
  const interactionInterface = tokenCatalogInteractionInterfaces.find(
    (candidate) => candidate === control["interactionInterface"],
  );
  if (interactionInterface === undefined) {
    throw new TypeError("Token catalog interaction interface is invalid.");
  }
  return Object.freeze({
    operationId: tokenCatalogOperationIdSchema.parse(control["operationId"]),
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
  try { return success(contract.parsePublicSuccess(request, value)); }
  catch {
    try { return failure(contract.parseFailure(value)); }
    catch { return normalizeFailure(value); }
  }
};

export const tokenCatalogStartApplicationResult = (
  contract: ReturnType<typeof tokenCatalogStartContract>,
  request: TokenAdditionStartRequest | TokenRemovalStartInput,
  context: Readonly<{
    operationId: TokenCatalogOperation["operationId"];
    interactionInterface: TokenCatalogInteractionInterface;
  }>,
  value: unknown,
): RouteResult => {
  try { return success(contract.parseBoundSuccess(request, context, value)); }
  catch {
    try { return failure(contract.parseFailure(value)); }
    catch { return normalizeFailure(value); }
  }
};

export const parseTokenCatalogOperationPathId = (
  operationIdInput: unknown,
): TokenCatalogOperation["operationId"] =>
  tokenCatalogOperationIdSchema.parse(operationIdInput);

export const parseTokenCatalogSelectionPathInput = (
  chainIdInput: unknown,
  tokenAddressInput: unknown,
) =>
  tokenCatalogApplicationContracts.selection.parseInput({
    asset: {
      kind: "erc20",
      chainId: chainIdInput,
      address: tokenAddressInput,
    },
  });

const operationId = (context: RouteContext): TokenCatalogOperation["operationId"] =>
  parseTokenCatalogOperationPathId(context.params["operationId"]);

const selectionRequest = (context: RouteContext) =>
  parseTokenCatalogSelectionPathInput(
    context.params["chainId"],
    context.params["tokenAddress"],
  );

export const startTokenCatalogOperation = (
  input: TokenCatalogOperationCreate,
  port: TokenCatalogWebStartPort | TokenCatalogInteractiveCliPort,
  operationIdInput: TokenCatalogOperation["operationId"],
): Promise<TokenCatalogOperationStartResult | ApplicationFailure> => {
  switch (input.kind) {
    case "add": return port.startAddition(input.request, operationIdInput);
    case "remove": return port.startRemoval(input.request, operationIdInput);
  }
};

export const tokenCatalogStartContract = (kind: TokenCatalogOperationCreate["kind"]) => {
  switch (kind) {
    case "add": return tokenCatalogApplicationContracts.startAddition;
    case "remove": return tokenCatalogApplicationContracts.startRemoval;
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
      pathPattern: tokenCatalogControlRoutes.selectionQueries,
      response: "canonical_json",
      successStatus: 200,
      handler: async (context) => {
        const contract = tokenCatalogApplicationContracts.selections;
        let request;
        try { request = contract.parseInput(context.body); }
        catch { return invalidInput(); }
        try {
          return tokenCatalogApplicationResult(
            contract,
            request,
            await input.queries.listSelections(tokenSelectionListRequestBody(request)),
          );
        }
        catch (error) { return normalizeFailure(error); }
      },
    },
    {
      method: "GET",
      mutation: "none",
      pathPattern: tokenCatalogControlRoutes.selectionPattern,
      response: "canonical_json",
      successStatus: 200,
      handler: async (context) => {
        const contract = tokenCatalogApplicationContracts.selection;
        let request;
        try { request = selectionRequest(context); }
        catch { return invalidInput(); }
        try {
          return tokenCatalogApplicationResult(
            contract,
            request,
            await input.queries.getSelection(request),
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
          return tokenCatalogStartApplicationResult(
            contract,
            create.request.request,
            {
              operationId: create.operationId,
              interactionInterface: create.interactionInterface,
            },
            await startTokenCatalogOperation(create.request, port, create.operationId),
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
          return success(tokenCatalogOperationConfirmationContract.parseBoundSuccess(
            request,
            { operationId: request.operationId, interactionInterface: "cli" },
            value,
          ));
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
