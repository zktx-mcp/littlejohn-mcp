import {
  CapabilityBindingRegistry,
  CapabilityRegistry,
  captureCanonicalJson,
  walletConnectionCapability,
  type ApplicationFailure,
} from "../core/index.js";
import type {
  RouteContext,
  RouteResult,
  RuntimeRouteRegistry,
  WalletConnectionReadCapabilityPort,
} from "../runtime/index.js";
import {
  parseWalletOperationConfirmation,
  parseWalletOperationCreate,
  parseWalletOperationId,
  parseWalletOperationResponse,
  parseWalletOperationStartResponse,
  walletManagementContracts,
  type WalletOperationConfirmationPort,
  type WalletLocalControlOperationPort,
} from "./contracts.js";
import type { WalletOperationKind } from "./operation-state.js";
import {
  createWalletFailure,
  normalizeWalletError,
  walletInterfaceErrorMappings,
} from "./errors.js";

const walletConnectionDefinitions = new CapabilityRegistry([walletConnectionCapability]);
const walletOperationsPath = "/api/v1/internal/control/wallet/operations";

export const walletControlRoutes = Object.freeze({
  operations: walletOperationsPath,
  connection: "/api/v1/internal/control/wallet/connection",
  operationPattern: `${walletOperationsPath}/{operationId}`,
  confirmationPattern: `${walletOperationsPath}/{operationId}/confirmation`,
  operation: (operationId: string): string =>
    `${walletOperationsPath}/${parseWalletOperationId(operationId)}`,
  confirmation: (operationId: string): string =>
    `${walletOperationsPath}/${parseWalletOperationId(operationId)}/confirmation`,
});

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

const validatedOperationResponse = (
  contract: typeof walletManagementContracts.operation |
    typeof walletManagementContracts.cancelOperation,
  id: string,
  value: unknown,
) => {
  const response = parseWalletOperationResponse(value);
  return Object.freeze({
    ...response,
    operation: contract.parseSuccess({ operationId: id }, response.operation),
  });
};

export const extendWalletControlRouteRegistry = (input: {
  readonly routes: RuntimeRouteRegistry;
  readonly operations: WalletLocalControlOperationPort;
  readonly cliConfirmation: WalletOperationConfirmationPort<"cli">;
  readonly walletConnection: WalletConnectionReadCapabilityPort;
}): RuntimeRouteRegistry => {
  const routes = input.routes;
  const operations = input.operations;
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
      method: "POST",
      mutation: "declared_control",
      pathPattern: walletControlRoutes.operations,
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
          const response = parseWalletOperationStartResponse(await operations.start(createInput));
          if (createInput.interactionInterface !== "cli" && response.qr !== undefined) {
            throw new TypeError("QR material is not available to this interaction interface.");
          }
          return success({
            ...response,
            result: startContract(createInput.kind).parseSuccess({}, response.result),
          });
        } catch (error) {
          return normalizeFailure(error);
        }
      },
    },
    {
      method: "GET",
      mutation: "none",
      pathPattern: walletControlRoutes.operationPattern,
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
          return success(validatedOperationResponse(
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
      method: "POST",
      mutation: "declared_control",
      pathPattern: walletControlRoutes.confirmationPattern,
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
          return success(validatedOperationResponse(
            walletManagementContracts.operation,
            id,
            await cliConfirmation.confirm(id, confirmation),
          ));
        } catch (error) {
          return normalizeFailure(error);
        }
      },
    },
    {
      method: "DELETE",
      mutation: "declared_control",
      pathPattern: walletControlRoutes.operationPattern,
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
          return success(validatedOperationResponse(
            walletManagementContracts.cancelOperation,
            id,
            await operations.cancel(id),
          ));
        } catch (error) {
          return normalizeFailure(error);
        }
      },
    },
    {
      method: "GET",
      mutation: "none",
      pathPattern: walletControlRoutes.connection,
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
