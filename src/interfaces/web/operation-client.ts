import {
  parseWalletOperationConfirmation,
  walletOperationAllowsQr,
  type WalletManagementOperation,
  type WalletQrMatrix,
} from "../../wallet/operation-contract.js";
import {
  browserCsrfHeaderName,
  browserOperationConfirmationPath,
  browserOperationQrPath,
  browserOperationResourcePath,
  parseBrowserRequestToken,
} from "../browser-contract.js";
import {
  parseBrowserProblemDetails,
  type BrowserErrorCode,
} from "../browser-error-response.js";
import {
  parseOperationControlResponse,
  parseOperationReadResponse,
  parseQrResponse,
  type OperationReadResponse,
} from "../browser-responses.js";

export interface BrowserFetchInit {
  readonly method: "GET" | "POST" | "DELETE";
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

export interface WalletOperationView {
  readonly operation: WalletManagementOperation;
  readonly access: OperationReadResponse["access"];
  readonly qr?: WalletQrMatrix;
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

export const readBrowserResponseJson = async (response: BrowserFetchResponse): Promise<unknown> => {
  let value: unknown;
  try { value = await response.json() as unknown; }
  catch { throw new BrowserResponseError("The wallet operation response is invalid."); }
  if (response.ok) return value;

  try {
    const problem = parseBrowserProblemDetails(value, response.status);
    throw new BrowserResponseError(problem.detail, problem.code);
  } catch (error) {
    if (error instanceof BrowserResponseError) throw error;
    throw new BrowserResponseError("The request could not be completed.");
  }
};

export const isBrowserResponseCode = (error: unknown, code: BrowserErrorCode): boolean =>
  error instanceof BrowserResponseError && error.code === code;

const defaultBrowserFetch: BrowserFetch = (input, init) => globalThis.fetch(input, init);

const requestFor = (options: BrowserRequestOptions): BrowserFetch =>
  options.request ?? defaultBrowserFetch;

const fetchOperation = async (
  request: BrowserFetch,
  operationId: string,
  signal?: AbortSignal,
): Promise<OperationReadResponse> => {
  const response = await request(browserOperationResourcePath(operationId), {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    ...(signal === undefined ? {} : { signal }),
  });
  return parseOperationReadResponse(await readBrowserResponseJson(response), operationId);
};

const fetchQr = async (
  request: BrowserFetch,
  operationId: string,
  signal?: AbortSignal,
): Promise<WalletQrMatrix> => {
  const response = await request(browserOperationQrPath(operationId), {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    ...(signal === undefined ? {} : { signal }),
  });
  return parseQrResponse(await readBrowserResponseJson(response)).qr;
};

export const loadWalletOperationView = async (
  operationId: string,
  options: BrowserRequestOptions = {},
): Promise<WalletOperationView> => {
  const request = requestFor(options);
  const { signal } = options;
  const response = await fetchOperation(request, operationId, signal);
  const view = Object.freeze({
    operation: response.operation,
    access: response.access,
  });
  if (!walletOperationAllowsQr(response.operation)) return view;

  try {
    return Object.freeze({
      ...view,
      qr: await fetchQr(request, operationId, signal),
    });
  } catch (error) {
    if (isBrowserResponseCode(error, "state_conflict")) return view;
    throw error;
  }
};

const controlWalletOperation = async (
  operationId: string,
  csrfTokenInput: unknown,
  method: "POST" | "DELETE",
  options: BrowserRequestOptions,
  body?: string,
): Promise<WalletManagementOperation> => {
  const csrfToken = parseBrowserRequestToken(csrfTokenInput);
  const response = await requestFor(options)(
    method === "POST"
      ? browserOperationConfirmationPath(operationId)
      : browserOperationResourcePath(operationId),
    {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        [browserCsrfHeaderName]: csrfToken,
        ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
      },
      ...(body === undefined ? {} : { body }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  );
  return parseOperationControlResponse(
    await readBrowserResponseJson(response),
    operationId,
  ).operation;
};

export const confirmWalletOperation = (
  operationId: string,
  connectionRevision: string,
  csrfToken: unknown,
  options: BrowserRequestOptions = {},
): Promise<WalletManagementOperation> => {
  const confirmation = parseWalletOperationConfirmation({ connectionRevision });
  return controlWalletOperation(
    operationId,
    csrfToken,
    "POST",
    options,
    JSON.stringify(confirmation),
  );
};

export const cancelWalletOperation = (
  operationId: string,
  csrfToken: unknown,
  options: BrowserRequestOptions = {},
): Promise<WalletManagementOperation> =>
  controlWalletOperation(operationId, csrfToken, "DELETE", options);
