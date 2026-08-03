import {
  CapabilityBindingRegistry,
  CapabilityRegistry,
  captureCanonicalJson,
  walletConnectionCapability,
  type ApplicationFailure,
} from "../core/index.js";
import type {
  RouteContext,
  RouteMethod,
  RouteResult,
  RuntimeRouteRegistry,
} from "../runtime/http-routing.js";
import type { WalletConnectionReadCapabilityPort } from "../runtime/application-context.js";
import {
  parseWalletOperationConfirmation,
  parseWalletOperationCancellation,
  parseWalletOperationCreate,
  parseWalletOperationId,
  parseWalletOperationPresentation,
  parseWalletManagementOperation,
  parseWalletOperationStartResult,
  walletManagementContracts,
  walletOperationConfirmationContract,
  type WalletOperationConfirmationPort,
  type WalletLocalControlOperationPort,
  type WalletOperationPresentationPort,
} from "./contracts.js";
import type { WalletOperationKind } from "./operation-state.js";
import {
  createWalletFailure,
  normalizeWalletError,
  walletInterfaceErrorMappings,
} from "./errors.js";

const walletConnectionDefinitions = new CapabilityRegistry([walletConnectionCapability]);
const walletOperationsPath = "/api/v1/internal/control/wallet/operations";
const walletOperationPattern = `${walletOperationsPath}/{operationId}`;

interface FixedWalletControlResource<Method extends RouteMethod> {
  readonly method: Method;
  readonly pathPattern: string;
  readonly path: string;
}

interface ExactWalletOperationControlResource<Method extends RouteMethod> {
  readonly method: Method;
  readonly pathPattern: string;
  path(operationId: string): string;
}

export const walletControlResources = Object.freeze({
  operations: Object.freeze({
    method: "POST",
    pathPattern: walletOperationsPath,
    path: walletOperationsPath,
  }),
  connection: Object.freeze({
    method: "GET",
    pathPattern: "/api/v1/internal/control/wallet/connection",
    path: "/api/v1/internal/control/wallet/connection",
  }),
  operation: Object.freeze({
    method: "GET",
    pathPattern: walletOperationPattern,
    path: (operationId: string): string =>
      `${walletOperationsPath}/${parseWalletOperationId(operationId)}`,
  }),
  presentation: Object.freeze({
    method: "GET",
    pathPattern: `${walletOperationPattern}/presentation`,
    path: (operationId: string): string =>
      `${walletOperationsPath}/${parseWalletOperationId(operationId)}/presentation`,
  }),
  confirmation: Object.freeze({
    method: "POST",
    pathPattern: `${walletOperationPattern}/confirmation`,
    path: (operationId: string): string =>
      `${walletOperationsPath}/${parseWalletOperationId(operationId)}/confirmation`,
  }),
  cancellation: Object.freeze({
    method: "POST",
    pathPattern: `${walletOperationPattern}/cancellation`,
    path: (operationId: string): string =>
      `${walletOperationsPath}/${parseWalletOperationId(operationId)}/cancellation`,
  }),
} satisfies Readonly<{
  operations: FixedWalletControlResource<"POST">;
  connection: FixedWalletControlResource<"GET">;
  operation: ExactWalletOperationControlResource<"GET">;
  presentation: ExactWalletOperationControlResource<"GET">;
  confirmation: ExactWalletOperationControlResource<"POST">;
  cancellation: ExactWalletOperationControlResource<"POST">;
}>);

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

const operationId = (context: RouteContext): string => parseWalletOperationId(context.params["operationId"]);

const startContract = (kind: WalletOperationKind) =>
  walletManagementContracts[kind];

const validatedOperation = (
  contract: typeof walletManagementContracts.operation,
  id: string,
  value: unknown,
) => {
  const operation = parseWalletManagementOperation(value);
  return contract.parsePublicSuccess({ operationId: id }, operation);
};

export const extendWalletControlRouteRegistry = (input: {
  readonly routes: RuntimeRouteRegistry;
  readonly operations: WalletLocalControlOperationPort;
  readonly presentation: WalletOperationPresentationPort;
  readonly cliConfirmation: WalletOperationConfirmationPort<"cli">;
  readonly walletConnection: WalletConnectionReadCapabilityPort;
}): RuntimeRouteRegistry => {
  const routes = input.routes;
  const operations = input.operations;
  const presentation = input.presentation;
  const cliConfirmation = input.cliConfirmation;
  const walletConnection = input.walletConnection;
  if (cliConfirmation.interactionInterface !== "cli") {
    throw new TypeError("The internal confirmation route requires the CLI confirmation port.");
  }
  const connectionBindings = new CapabilityBindingRegistry(
    walletConnectionDefinitions,
    [walletConnection.connection],
  );

  return routes.extend([
    {
      method: walletControlResources.operations.method,
      mutation: "declared_control",
      query: "none",
      pathPattern: walletControlResources.operations.pathPattern,
      response: "canonical_json",
      successStatus: 200,
      handler: async (context) => {
        let createInput;
        try {
          createInput = parseWalletOperationCreate(context.body);
        } catch {
          return invalidInput();
        }
        try {
          const result = parseWalletOperationStartResult(await operations.start(createInput));
          return success(startContract(createInput.kind).parseBoundSuccess(
              {},
              {
                operationId: createInput.operationId,
                interactionInterface: createInput.interactionInterface,
              },
              result,
            ));
        } catch (error) {
          return normalizeFailure(error);
        }
      },
    },
    {
      method: walletControlResources.presentation.method,
      mutation: "none",
      query: "none",
      pathPattern: walletControlResources.presentation.pathPattern,
      response: "canonical_json",
      successStatus: 200,
      handler: async (context) => {
        let id;
        try { id = operationId(context); }
        catch { return invalidInput(); }
        try {
          const exact = parseWalletOperationPresentation(await presentation.get(id, "cli"));
          if (exact.operation.operationId !== id) {
            throw new TypeError("Wallet presentation identity does not match its resource.");
          }
          return success(exact);
        } catch (error) {
          return normalizeFailure(error);
        }
      },
    },
    {
      method: walletControlResources.operation.method,
      mutation: "none",
      query: "none",
      pathPattern: walletControlResources.operation.pathPattern,
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
          return success(validatedOperation(
            walletManagementContracts.operation,
            id,
            await operations.get(id),
          ));
        } catch (error) {
          return normalizeFailure(error);
        }
      },
    },
    {
      method: walletControlResources.confirmation.method,
      mutation: "declared_control",
      query: "none",
      pathPattern: walletControlResources.confirmation.pathPattern,
      response: "canonical_json",
      successStatus: 200,
      handler: async (context) => {
        let id;
        let confirmation;
        try {
          id = operationId(context);
          confirmation = parseWalletOperationConfirmation(context.body);
        } catch {
          return invalidInput();
        }
        try {
          const operation = parseWalletManagementOperation(
            await cliConfirmation.confirm(id, confirmation),
          );
          return success(walletOperationConfirmationContract.parseBoundSuccess(
              { operationId: id, connectionRevision: confirmation.connectionRevision },
              { operationId: id, interactionInterface: "cli" },
              operation,
            ));
        } catch (error) {
          return normalizeFailure(error);
        }
      },
    },
    {
      method: walletControlResources.cancellation.method,
      mutation: "declared_control",
      query: "none",
      pathPattern: walletControlResources.cancellation.pathPattern,
      response: "canonical_json",
      successStatus: 200,
      handler: async (context) => {
        let id;
        let cancellation;
        try {
          id = operationId(context);
          const confirmation = parseWalletOperationConfirmation(context.body);
          cancellation = parseWalletOperationCancellation({
            operationId: id,
            connectionRevision: confirmation.connectionRevision,
          });
        } catch {
          return invalidInput();
        }
        try {
          const operation = parseWalletManagementOperation(await operations.cancel(cancellation));
          return success(walletManagementContracts.cancelOperation.parsePublicSuccess(
              cancellation,
              operation,
            ));
        } catch (error) {
          return normalizeFailure(error);
        }
      },
    },
    {
      method: walletControlResources.connection.method,
      mutation: "none",
      query: "none",
      pathPattern: walletControlResources.connection.pathPattern,
      response: "canonical_json",
      successStatus: 200,
      handler: async (context) => {
        try {
          const result = await connectionBindings.invoke(
            walletConnectionCapability,
            {},
            { signal: context.signal },
          );
          return result.ok ? success(result) : failure(result);
        } catch (error) {
          return normalizeFailure(error);
        }
      },
    },
  ], walletInterfaceErrorMappings);
};
