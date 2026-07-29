import {
  browserCsrfHeaderName,
  parseBrowserCsrfToken,
  referenceMarketBrowserMutationPath,
} from "../browser-contract.js";
import {
  parseBrowserProblemDetails,
  type BrowserErrorCode,
  type BrowserProblemDetails,
} from "../browser-error-response.js";
import {
  createDeliveryUnknown,
  type DeliveryUnknown,
  type OperationDeliveryAction,
} from "../operation-delivery.js";
import type { FieldIssue, OperationId } from "../../core/browser.js";
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

export type BrowserLocalFailureCode =
  | "internal_error"
  | "invalid_response"
  | "request_aborted"
  | "response_timeout"
  | "runtime_state_unavailable";

export const browserLocalFailureCodes = Object.freeze([
  "internal_error",
  "invalid_response",
  "request_aborted",
  "response_timeout",
  "runtime_state_unavailable",
] as const satisfies readonly BrowserLocalFailureCode[]);

export type BrowserRequestFailure =
  | Readonly<{
      kind: "response_problem";
      problem: BrowserProblemDetails;
    }>
  | Readonly<{
      kind: "local_failure";
      code: BrowserLocalFailureCode;
      detail: string;
      retryable: boolean;
      issues: readonly FieldIssue[];
    }>;

const localFailureDefinition = (
  code: BrowserLocalFailureCode,
): Readonly<{ detail: string; retryable: boolean }> => {
  switch (code) {
    case "internal_error":
      return Object.freeze({
        detail: "The action could not be completed.",
        retryable: false,
      });
    case "invalid_response":
      return Object.freeze({
        detail: "The local response is invalid.",
        retryable: false,
      });
    case "request_aborted":
      return Object.freeze({
        detail: "The request ended before completion.",
        retryable: true,
      });
    case "response_timeout":
      return Object.freeze({
        detail: "The local response was not completed before the deadline.",
        retryable: true,
      });
    case "runtime_state_unavailable":
      return Object.freeze({
        detail: "Local runtime state is unavailable.",
        retryable: false,
      });
  }
};

const localFailure = (
  code: BrowserLocalFailureCode,
): BrowserRequestFailure => {
  const definition = localFailureDefinition(code);
  return Object.freeze({
    kind: "local_failure",
    code,
    detail: definition.detail,
    retryable: definition.retryable,
    issues: Object.freeze([]),
  });
};

const responseProblemFailure = (
  problem: BrowserProblemDetails,
): BrowserRequestFailure => Object.freeze({
  kind: "response_problem",
  problem,
});

const failureDetail = (failure: BrowserRequestFailure): string =>
  failure.kind === "response_problem"
    ? failure.problem.detail
    : failure.detail;

export class BrowserRequestError extends Error {
  readonly failure: BrowserRequestFailure;

  constructor(failure: BrowserRequestFailure) {
    super(failureDetail(failure));
    this.name = "BrowserRequestError";
    this.failure = failure;
    Object.freeze(this);
  }
}

export const invalidBrowserResponse = (): BrowserRequestError =>
  new BrowserRequestError(localFailure("invalid_response"));

export const browserRequestFailure = (
  error: unknown,
): BrowserRequestFailure => error instanceof BrowserRequestError
  ? error.failure
  : localFailure("internal_error");

export const readBrowserResponseJson = async (
  response: BrowserFetchResponse,
): Promise<unknown> => {
  let value: unknown;
  try { value = await response.json(); }
  catch { throw invalidBrowserResponse(); }
  if (response.ok) return value;

  let problem: BrowserProblemDetails;
  try {
    problem = parseBrowserProblemDetails(value, response.status);
  } catch {
    throw invalidBrowserResponse();
  }
  throw new BrowserRequestError(responseProblemFailure(problem));
};

export const isBrowserRequestFailureCode = (
  error: unknown,
  code: BrowserErrorCode,
): boolean => error instanceof BrowserRequestError &&
  error.failure.kind === "response_problem" &&
  error.failure.problem.code === code;

export const browserSessionRequiresReload = (error: unknown): boolean =>
  isBrowserRequestFailureCode(error, "unauthorized");

const defaultBrowserFetch: BrowserFetch = (input, init) => globalThis.fetch(input, init);

const browserReadResponseDeadlineMilliseconds = 120_000;
const browserActionResponseDeadlineMilliseconds = 5 * 60 * 1_000;
const browserReadStopped = Symbol("browser-read-stopped");
const browserActionResponseUnavailable = Symbol("browser-action-response-unavailable");

const requestFor = (options: BrowserRequestOptions): BrowserFetch =>
  options.request ?? defaultBrowserFetch;

const normalizeBrowserTransportFailure = (error: unknown): BrowserRequestError => {
  if (error instanceof BrowserRequestError) return error;
  return error instanceof Error && error.name === "AbortError"
    ? new BrowserRequestError(localFailure("request_aborted"))
    : new BrowserRequestError(localFailure("runtime_state_unavailable"));
};

type BrowserReadStopReason = "caller_aborted" | "deadline_reached";

const stoppedBrowserReadFailure = (
  reason: BrowserReadStopReason | undefined,
): BrowserRequestError => {
  switch (reason) {
    case "caller_aborted":
      return new BrowserRequestError(localFailure("request_aborted"));
    case "deadline_reached":
      return new BrowserRequestError(localFailure("response_timeout"));
    case undefined:
      throw new TypeError("The browser read stopped without a reason.");
  }
};

const issueBrowserRequest = async (
  options: BrowserRequestOptions,
  path: string,
  init: BrowserFetchInit,
): Promise<unknown> => {
  if (options.signal?.aborted === true) {
    throw new BrowserRequestError(localFailure("request_aborted"));
  }
  const controller = new AbortController();
  let stopReason: BrowserReadStopReason | undefined;
  let markStopped!: () => void;
  const stopped = new Promise<typeof browserReadStopped>((resolve) => {
    markStopped = () => { resolve(browserReadStopped); };
  });
  const stop = (reason: BrowserReadStopReason): void => {
    if (stopReason !== undefined) return;
    stopReason = reason;
    controller.abort();
    markStopped();
  };
  const callerAbort = (): void => { stop("caller_aborted"); };
  options.signal?.addEventListener("abort", callerAbort, { once: true });
  const deadline = globalThis.setTimeout(
    () => { stop("deadline_reached"); },
    browserReadResponseDeadlineMilliseconds,
  );
  try {
    const response = await Promise.race([
      requestFor(options)(path, {
        ...init,
        signal: controller.signal,
      }),
      stopped,
    ]);
    if (response === browserReadStopped) {
      throw stoppedBrowserReadFailure(stopReason);
    }
    const value = await Promise.race([
      readBrowserResponseJson(response),
      stopped,
    ]);
    if (value === browserReadStopped) {
      throw stoppedBrowserReadFailure(stopReason);
    }
    return value;
  } catch (error) {
    if (stopReason !== undefined) {
      throw stoppedBrowserReadFailure(stopReason);
    }
    throw normalizeBrowserTransportFailure(error);
  } finally {
    globalThis.clearTimeout(deadline);
    options.signal?.removeEventListener("abort", callerAbort);
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
    throw new BrowserRequestError(localFailure("request_aborted"));
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

    let problem: BrowserProblemDetails;
    try {
      problem = parseBrowserProblemDetails(value, response.status);
    } catch {
      return Object.freeze({
        status: "delivery_unknown",
        delivery: deliveryUnknown(),
      });
    }
    throw new BrowserRequestError(responseProblemFailure(problem));
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
