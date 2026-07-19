import {
  browserCsrfHeaderName,
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

export const invalidBrowserResponse = (message: string): BrowserResponseError =>
  new BrowserResponseError(message);

export const readBrowserResponseJson = async (
  response: BrowserFetchResponse,
): Promise<unknown> => {
  let value: unknown;
  try { value = await response.json(); }
  catch { throw new BrowserResponseError("The local response is invalid."); }
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

export const browserActionFailureMessage = (error: unknown): string =>
  error instanceof BrowserResponseError
    ? error.message
    : "The action could not be completed.";

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
): Promise<unknown> => {
  try {
    return await readBrowserResponseJson(await requestFor(options)(path, init));
  } catch (error) {
    throw normalizeBrowserTransportFailure(error);
  }
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

export const readBrowserJson = (
  path: string,
  options: BrowserRequestOptions = {},
): Promise<unknown> => issueBrowserRequest(
  options,
  path,
  requestInit("GET", options.signal),
);

export const queryBrowserJson = (
  path: string,
  body: unknown,
  options: BrowserRequestOptions = {},
): Promise<unknown> => issueBrowserRequest(options, path, {
  ...requestInit("POST", options.signal),
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const controlBrowserJson = (
  path: string,
  body: unknown,
  csrfTokenInput: unknown,
  options: BrowserRequestOptions = {},
): Promise<unknown> => issueBrowserRequest(options, path, {
  ...requestInit("POST", options.signal),
  headers: {
    [browserCsrfHeaderName]: parseBrowserCsrfToken(csrfTokenInput),
    "Content-Type": "application/json",
  },
  body: JSON.stringify(body),
});
