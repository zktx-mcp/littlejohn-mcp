import {
  browserCsrfHeaderName,
  parseBrowserCsrfToken,
  referenceMarketBrowserMutationPath,
} from "../browser-contract.js";
import {
  parseBrowserProblemDetails,
  type BrowserErrorCode,
} from "../browser-error-response.js";
import {
  createDeliveryUnknown,
  type DeliveryUnknown,
  type OperationDeliveryAction,
} from "../operation-delivery.js";
import type { OperationId } from "../../core/browser.js";
import {
  createReferenceMarketDeliveryUnknown,
  type ReferenceMarketDeliveryAction,
  type ReferenceMarketDeliveryUnknown,
} from "../reference-market-delivery.js";
import type { CanonicalJson } from "../../core/browser.js";

export interface BrowserFetchInit {
  readonly method: "GET" | "POST";
  readonly credentials: "omit" | "same-origin";
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

export type BrowserActionDeliveryResult =
  | Readonly<{ status: "response_received"; value: unknown }>
  | Readonly<{ status: "delivery_unknown"; delivery: DeliveryUnknown }>;

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

const browserActionResponseDeadlineMilliseconds = 5 * 60 * 1_000;
const browserActionResponseUnavailable = Symbol("browser-action-response-unavailable");

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

export const queryPublicBrowserJson = (
  path: string,
  body: unknown,
  options: BrowserRequestOptions = {},
): Promise<unknown> => issueBrowserRequest(options, path, {
  method: "POST",
  credentials: "omit",
  cache: "no-store",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
  ...(options.signal === undefined ? {} : { signal: options.signal }),
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

const controlBrowserSendOnceJson = async <Unknown>(
  path: string,
  body: unknown,
  csrfTokenInput: unknown,
  deliveryUnknown: () => Unknown,
  options: BrowserRequestOptions = {},
): Promise<Readonly<{ status: "response_received"; value: unknown }> | Readonly<{
  status: "delivery_unknown";
  delivery: Unknown;
}>> => {
  if (options.signal?.aborted === true) {
    throw new BrowserResponseError(
      "The request ended before completion.",
      "request_aborted",
    );
  }
  const csrfToken = parseBrowserCsrfToken(csrfTokenInput);
  const controller = new AbortController();
  let markUnavailable!: () => void;
  const unavailable = new Promise<typeof browserActionResponseUnavailable>((resolve) => {
    markUnavailable = () => { resolve(browserActionResponseUnavailable); };
  });
  const abort = (): void => {
    controller.abort();
    markUnavailable();
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  const deadline = globalThis.setTimeout(
    () => { abort(); },
    browserActionResponseDeadlineMilliseconds,
  );
  try {
    let response: BrowserFetchResponse | typeof browserActionResponseUnavailable;
    try {
      response = await Promise.race([
        requestFor(options)(path, {
          ...requestInit("POST", controller.signal),
          headers: {
            [browserCsrfHeaderName]: csrfToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        }),
        unavailable,
      ]);
    } catch {
      return Object.freeze({
        status: "delivery_unknown",
        delivery: deliveryUnknown(),
      });
    }
    if (response === browserActionResponseUnavailable) {
      return Object.freeze({
        status: "delivery_unknown",
        delivery: deliveryUnknown(),
      });
    }

    let value: unknown | typeof browserActionResponseUnavailable;
    try { value = await Promise.race([response.json(), unavailable]); }
    catch {
      return Object.freeze({
        status: "delivery_unknown",
        delivery: deliveryUnknown(),
      });
    }
    if (value === browserActionResponseUnavailable) {
      return Object.freeze({
        status: "delivery_unknown",
        delivery: deliveryUnknown(),
      });
    }
    if (response.ok) return Object.freeze({ status: "response_received", value });

    try {
      const problem = parseBrowserProblemDetails(value, response.status);
      throw new BrowserResponseError(problem.detail, problem.code);
    } catch (error) {
      if (error instanceof BrowserResponseError) throw error;
      return Object.freeze({
        status: "delivery_unknown",
        delivery: deliveryUnknown(),
      });
    }
  } finally {
    globalThis.clearTimeout(deadline);
    options.signal?.removeEventListener("abort", abort);
  }
};

export const controlBrowserActionJson = (
  action: OperationDeliveryAction,
  operationId: OperationId,
  path: string,
  body: unknown,
  csrfTokenInput: unknown,
  options: BrowserRequestOptions = {},
): Promise<BrowserActionDeliveryResult> => controlBrowserSendOnceJson(
  path,
  body,
  csrfTokenInput,
  () => createDeliveryUnknown(action, operationId),
  options,
);

export const controlBrowserReferenceMarketMutationJson = (
  input: Readonly<{
    action: ReferenceMarketDeliveryAction;
    request: CanonicalJson;
    csrfToken: unknown;
    options?: BrowserRequestOptions;
  }>,
): Promise<Readonly<{ status: "response_received"; value: unknown }> | Readonly<{
  status: "delivery_unknown";
  delivery: ReferenceMarketDeliveryUnknown;
}>> => {
  const deliveryUnknown = createReferenceMarketDeliveryUnknown(input);
  return controlBrowserSendOnceJson(
    referenceMarketBrowserMutationPath(deliveryUnknown.action),
    input.request,
    input.csrfToken,
    () => deliveryUnknown,
    input.options,
  );
};
