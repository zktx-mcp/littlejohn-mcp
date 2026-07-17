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
  browserCsrfHeaderName,
  browserOperationCancellationPath,
  browserOperationConfirmationPath,
  browserOperationPath,
  browserWalletApiPaths,
  parseBrowserCsrfToken,
} from "../browser-contract.js";
import {
  parseBrowserProblemDetails,
  type BrowserErrorCode,
} from "../browser-error-response.js";

export interface BrowserFetchInit {
  readonly method: "GET" | "POST";
  readonly credentials: "same-origin";
  readonly cache: "no-store";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

export interface BrowserFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export type BrowserFetch = (
  input: string,
  init: BrowserFetchInit,
) => Promise<BrowserFetchResponse>;

export interface BrowserRequestOptions {
  readonly request?: BrowserFetch;
  readonly signal?: AbortSignal;
}

export class BrowserResponseError extends Error {
  readonly code: BrowserErrorCode;

  constructor(message: string, code: BrowserErrorCode = "internal_error") {
    super(message);
    this.name = "BrowserResponseError";
    this.code = code;
    Object.freeze(this);
  }
}

export const readBrowserResponseJson = async (
  response: BrowserFetchResponse,
): Promise<unknown> => {
  let value: unknown;
  try { value = await response.json() as unknown; }
  catch { throw new BrowserResponseError("The wallet response is invalid."); }
  if (response.ok) return value;

  try {
    const problem = parseBrowserProblemDetails(value, response.status);
    throw new BrowserResponseError(problem.detail, problem.code);
  } catch (error) {
    if (error instanceof BrowserResponseError) throw error;
    throw new BrowserResponseError("The request could not be completed.");
  }
};

export const isBrowserResponseCode = (
  error: unknown,
  code: BrowserErrorCode,
): boolean => error instanceof BrowserResponseError && error.code === code;

export const browserSessionRequiresReload = (error: unknown): boolean =>
  isBrowserResponseCode(error, "unauthorized");

export const browserControlFailureMessage = (error: unknown): string =>
  error instanceof BrowserResponseError
    ? error.message
    : "The wallet operation could not be completed.";

const defaultBrowserFetch: BrowserFetch = (input, init) => globalThis.fetch(input, init);

const requestFor = (options: BrowserRequestOptions): BrowserFetch =>
  options.request ?? defaultBrowserFetch;

const normalizeBrowserTransportFailure = (error: unknown): BrowserResponseError => {
  if (error instanceof BrowserResponseError) return error;
  return error instanceof Error && error.name === "AbortError"
    ? new BrowserResponseError("The request ended before completion.", "request_aborted")
    : new BrowserResponseError("Local runtime state is unavailable.", "runtime_state_unavailable");
};

const issueBrowserRequest = async (
  options: BrowserRequestOptions,
  path: string,
  init: BrowserFetchInit,
): Promise<BrowserFetchResponse> => {
  try { return await requestFor(options)(path, init); }
  catch (error) { throw normalizeBrowserTransportFailure(error); }
};

const requestInit = (
  method: BrowserFetchInit["method"],
  signal?: AbortSignal,
): BrowserFetchInit => ({
  method,
  credentials: "same-origin",
  cache: "no-store",
  ...(signal === undefined ? {} : { signal }),
});

const parseCurrentProjection = (value: unknown): WalletCurrentOperationProjection => {
  try { return parseWalletCurrentOperationProjection(value); }
  catch { throw new BrowserResponseError("The wallet state response is invalid."); }
};

const parseStartResult = (value: unknown): WalletOperationStartResult => {
  try { return parseWalletOperationStartResult(value); }
  catch { throw new BrowserResponseError("The wallet operation response is invalid."); }
};

const parseOperation = (
  value: unknown,
  expectedOperationId: string,
): WalletManagementOperation => {
  try {
    const operation = parseWalletManagementOperation(value);
    if (operation.operationId !== expectedOperationId) throw new TypeError();
    return operation;
  } catch {
    throw new BrowserResponseError("The wallet operation response is invalid.");
  }
};

export const loadWalletProjection = async (
  options: BrowserRequestOptions = {},
): Promise<WalletCurrentOperationProjection> => {
  const response = await issueBrowserRequest(
    options,
    browserWalletApiPaths.currentOperation,
    requestInit("GET", options.signal),
  );
  return parseCurrentProjection(await readBrowserResponseJson(response));
};

export const loadWalletOperation = async (
  operationId: string,
  options: BrowserRequestOptions = {},
): Promise<WalletOperationPresentation> => {
  const id = parseWalletOperationId(operationId);
  const response = await issueBrowserRequest(
    options,
    browserOperationPath(id),
    requestInit("GET", options.signal),
  );
  try {
    const presentation = parseWalletOperationPresentation(
      await readBrowserResponseJson(response),
    );
    if (presentation.operation.operationId !== id) throw new TypeError();
    return presentation;
  } catch (error) {
    if (error instanceof BrowserResponseError) throw error;
    throw new BrowserResponseError("The wallet operation response is invalid.");
  }
};

const browserControl = async (
  path: string,
  body: unknown,
  csrfTokenInput: unknown,
  options: BrowserRequestOptions,
): Promise<unknown> => {
  const csrfToken = parseBrowserCsrfToken(csrfTokenInput);
  const response = await issueBrowserRequest(options, path, {
    ...requestInit("POST", options.signal),
    headers: {
      [browserCsrfHeaderName]: csrfToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return readBrowserResponseJson(response);
};

export const startWalletOperation = async (
  kind: WalletOperationKind,
  connectionRevision: string,
  csrfToken: unknown,
  options: BrowserRequestOptions = {},
): Promise<WalletOperationStartResult> => {
  const input = parseWalletWebOperationCreate({ kind, connectionRevision });
  return parseStartResult(await browserControl(
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
    await browserControl(path, input, csrfToken, options),
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
