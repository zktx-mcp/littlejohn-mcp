import {
  parseWalletCurrentOperationProjection,
  parseWalletManagementOperation,
  parseWalletOperationConfirmation,
  parseWalletOperationId,
  parseWalletOperationPresentation,
  parseWalletOperationStartResult,
  parseWalletWebOperationCreate,
  type WalletCurrentOperationProjection,
  type WalletManagementOperation,
  type WalletOperationPresentation,
  type WalletOperationStartResult,
} from "../../wallet/operation-contract.js";
import { walletManagementContracts, walletOperationConfirmationContract } from "../../wallet/management-contracts.js";
import {
  createDeliveryUnknown,
  type DeliveryUnknown,
  type OperationDeliveryAction,
} from "../operation-delivery.js";
import type { WalletOperationKind } from "../../wallet/operation-state.js";
import {
  browserOperationCancellationPath,
  browserOperationConfirmationPath,
  browserOperationPath,
  browserWalletApiPaths,
} from "../browser-contract.js";
import {
  BrowserRequestError,
  controlBrowserActionJson,
  invalidBrowserResponse,
  readBrowserJson,
  type BrowserRequestOptions,
} from "./browser-client.js";

const parseCurrentProjection = (value: unknown): WalletCurrentOperationProjection => {
  try { return parseWalletCurrentOperationProjection(value); }
  catch { throw invalidBrowserResponse(); }
};

const parseOperation = (
  value: unknown,
  expectedOperationId: string,
): WalletManagementOperation => {
  try {
    const operation = parseWalletManagementOperation(value);
    if (operation.operationId !== expectedOperationId) {
      throw invalidBrowserResponse();
    }
    return operation;
  } catch {
    throw invalidBrowserResponse();
  }
};

export const loadWalletProjection = async (
  options: BrowserRequestOptions = {},
): Promise<WalletCurrentOperationProjection> => {
  return parseCurrentProjection(await readBrowserJson(
    browserWalletApiPaths.currentOperation,
    options,
  ));
};

export const loadWalletOperation = async (
  operationId: string,
  options: BrowserRequestOptions = {},
): Promise<WalletOperationPresentation> => {
  const id = parseWalletOperationId(operationId);
  try {
    const presentation = parseWalletOperationPresentation(
      await readBrowserJson(browserOperationPath(id), options),
    );
    if (presentation.operation.operationId !== id) {
      throw invalidBrowserResponse();
    }
    return presentation;
  } catch (error) {
    if (error instanceof BrowserRequestError) throw error;
    throw invalidBrowserResponse();
  }
};

export const startWalletOperation = async (
  operationIdInput: string,
  kind: WalletOperationKind,
  connectionRevision: string,
  csrfToken: unknown,
  options: BrowserRequestOptions = {},
): Promise<WalletOperationStartResult | DeliveryUnknown> => {
  const input = parseWalletWebOperationCreate({ kind, connectionRevision });
  const operationId = parseWalletOperationId(operationIdInput);
  const delivery = await controlBrowserActionJson(
    "start",
    operationId,
    browserWalletApiPaths.operations,
    {
      control: { operationId, interactionInterface: "web" },
      request: input,
    },
    csrfToken,
    options,
  );
  if (delivery.status === "delivery_unknown") return delivery.delivery;
  const value = delivery.value;
  try {
    return walletManagementContracts[kind].parseBoundSuccess(
      {},
      { operationId, interactionInterface: "web" },
      parseWalletOperationStartResult(value),
    );
  } catch {
    return createDeliveryUnknown("start", operationId);
  }
};

const controlWalletOperation = async (
  action: "confirm" | "cancel",
  operationId: string,
  connectionRevision: string,
  csrfToken: unknown,
  options: BrowserRequestOptions,
): Promise<WalletManagementOperation | DeliveryUnknown> => {
  const input = parseWalletOperationConfirmation({ connectionRevision });
  const id = parseWalletOperationId(operationId);
  const path = action === "confirm"
    ? browserOperationConfirmationPath(id)
    : browserOperationCancellationPath(id);
  const delivery = await controlBrowserActionJson(action, id, path, input, csrfToken, options);
  if (delivery.status === "delivery_unknown") return delivery.delivery;
  const value = delivery.value;
  try {
    const parsed = parseOperation(value, id);
    const operation = action === "confirm"
      ? walletOperationConfirmationContract.parseBoundSuccess(
          { operationId: id, connectionRevision: input.connectionRevision },
          { operationId: id, interactionInterface: "web" },
          parsed,
        )
      : walletManagementContracts.cancelOperation.parsePublicSuccess(
          { operationId: id },
          parsed,
        );
    if (action === "cancel" && operation.state !== "cancelled") {
      return createDeliveryUnknown("cancel", id);
    }
    return operation;
  } catch {
    return createDeliveryUnknown(action as OperationDeliveryAction, id);
  }
};

export const confirmWalletOperation = (
  operationId: string,
  connectionRevision: string,
  csrfToken: unknown,
  options: BrowserRequestOptions = {},
): Promise<WalletManagementOperation | DeliveryUnknown> =>
  controlWalletOperation(
    "confirm",
    operationId,
    connectionRevision,
    csrfToken,
    options,
  );

export const cancelWalletOperation = (
  operationId: string,
  connectionRevision: string,
  csrfToken: unknown,
  options: BrowserRequestOptions = {},
): Promise<WalletManagementOperation | DeliveryUnknown> =>
  controlWalletOperation(
    "cancel",
    operationId,
    connectionRevision,
    csrfToken,
    options,
  );
