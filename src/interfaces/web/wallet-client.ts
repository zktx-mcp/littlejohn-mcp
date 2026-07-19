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
import type { WalletOperationKind } from "../../wallet/operation-state.js";
import {
  browserOperationCancellationPath,
  browserOperationConfirmationPath,
  browserOperationPath,
  browserWalletApiPaths,
} from "../browser-contract.js";
import {
  BrowserResponseError,
  controlBrowserJson,
  invalidBrowserResponse,
  readBrowserJson,
  type BrowserRequestOptions,
} from "./browser-client.js";

const parseCurrentProjection = (value: unknown): WalletCurrentOperationProjection => {
  try { return parseWalletCurrentOperationProjection(value); }
  catch { throw invalidBrowserResponse("The wallet state response is invalid."); }
};

const parseStartResult = (value: unknown): WalletOperationStartResult => {
  try { return parseWalletOperationStartResult(value); }
  catch { throw invalidBrowserResponse("The wallet operation response is invalid."); }
};

const parseOperation = (
  value: unknown,
  expectedOperationId: string,
): WalletManagementOperation => {
  try {
    const operation = parseWalletManagementOperation(value);
    if (operation.operationId !== expectedOperationId) {
      throw invalidBrowserResponse("The wallet operation response is invalid.");
    }
    return operation;
  } catch {
    throw invalidBrowserResponse("The wallet operation response is invalid.");
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
      throw invalidBrowserResponse("The wallet operation response is invalid.");
    }
    return presentation;
  } catch (error) {
    if (error instanceof BrowserResponseError) throw error;
    throw invalidBrowserResponse("The wallet operation response is invalid.");
  }
};

export const startWalletOperation = async (
  kind: WalletOperationKind,
  connectionRevision: string,
  csrfToken: unknown,
  options: BrowserRequestOptions = {},
): Promise<WalletOperationStartResult> => {
  const input = parseWalletWebOperationCreate({ kind, connectionRevision });
  return parseStartResult(await controlBrowserJson(
    browserWalletApiPaths.operations,
    input,
    csrfToken,
    options,
  ));
};

const controlWalletOperation = async (
  action: "confirm" | "cancel",
  operationId: string,
  connectionRevision: string,
  csrfToken: unknown,
  options: BrowserRequestOptions,
): Promise<WalletManagementOperation> => {
  const input = parseWalletOperationConfirmation({ connectionRevision });
  const path = action === "confirm"
    ? browserOperationConfirmationPath(operationId)
    : browserOperationCancellationPath(operationId);
  return parseOperation(
    await controlBrowserJson(path, input, csrfToken, options),
    operationId,
  );
};

export const confirmWalletOperation = (
  operationId: string,
  connectionRevision: string,
  csrfToken: unknown,
  options: BrowserRequestOptions = {},
): Promise<WalletManagementOperation> =>
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
): Promise<WalletManagementOperation> =>
  controlWalletOperation(
    "cancel",
    operationId,
    connectionRevision,
    csrfToken,
    options,
  );
