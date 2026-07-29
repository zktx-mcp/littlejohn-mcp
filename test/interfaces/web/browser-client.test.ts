import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BrowserRequestError,
  readBrowserJson,
  type BrowserFetch,
  type BrowserFetchResponse,
} from "../../../src/interfaces/web/browser-client.js";

const responseDeadlineMilliseconds = 120_000;

const failureFrom = async (
  pending: Promise<unknown>,
): Promise<BrowserRequestError> => {
  const error = await pending.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(BrowserRequestError);
  if (!(error instanceof BrowserRequestError)) {
    throw new TypeError("Expected BrowserRequestError.");
  }
  return error;
};

afterEach(() => {
  vi.useRealTimers();
});

describe("bounded browser read transport", () => {
  it("ends a never-settling fetch at the whole-response deadline", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    let settled = false;
    const request: BrowserFetch = (_path, init) => {
      requestSignal = init.signal;
      return new Promise<BrowserFetchResponse>(() => {});
    };
    const pending = readBrowserJson("/api/v1/test", { request });
    void pending.then(
      () => { settled = true; },
      () => { settled = true; },
    );

    await vi.advanceTimersByTimeAsync(responseDeadlineMilliseconds - 1);
    expect(settled).toBe(false);
    expect(requestSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const error = await failureFrom(pending);
    expect(error.failure).toEqual({
      kind: "local_failure",
      code: "response_timeout",
      detail: "The local response was not completed before the deadline.",
      retryable: true,
      issues: [],
    });
    expect(requestSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the same deadline after headers arrive while JSON remains pending", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    let bodyReadStarted = false;
    let settled = false;
    const request: BrowserFetch = (_path, init) => {
      requestSignal = init.signal;
      return new Promise<BrowserFetchResponse>((resolve) => {
        globalThis.setTimeout(() => {
          resolve({
            ok: true,
            status: 200,
            json: () => {
              bodyReadStarted = true;
              return new Promise<unknown>(() => {});
            },
          });
        }, 90_000);
      });
    };
    const pending = readBrowserJson("/api/v1/test", { request });
    void pending.then(
      () => { settled = true; },
      () => { settled = true; },
    );

    await vi.advanceTimersByTimeAsync(90_000);
    expect(bodyReadStarted).toBe(true);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const error = await failureFrom(pending);
    expect(error.failure).toMatchObject({
      kind: "local_failure",
      code: "response_timeout",
      retryable: true,
    });
    expect(requestSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps caller cancellation distinct and clears the response deadline", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const request: BrowserFetch = (_path, init) => {
      requestSignal = init.signal;
      return new Promise<BrowserFetchResponse>(() => {});
    };
    const pending = readBrowserJson("/api/v1/test", {
      request,
      signal: caller.signal,
    });

    caller.abort();
    const error = await failureFrom(pending);
    expect(error.failure).toMatchObject({
      kind: "local_failure",
      code: "request_aborted",
      retryable: true,
    });
    expect(requestSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not dispatch a request when its caller is already cancelled", async () => {
    const caller = new AbortController();
    caller.abort();
    const request = vi.fn<BrowserFetch>();

    const error = await failureFrom(readBrowserJson("/api/v1/test", {
      request,
      signal: caller.signal,
    }));
    expect(error.failure).toMatchObject({
      kind: "local_failure",
      code: "request_aborted",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("preserves an admitted canonical problem response before the deadline", async () => {
    vi.useFakeTimers();
    const problem = Object.freeze({
      type: "about:blank",
      title: "Source unavailable",
      status: 503,
      code: "source_unavailable",
      detail: "A required data source is unavailable.",
      retryable: true,
      issues: Object.freeze([]),
    });
    const request: BrowserFetch = async () => ({
      ok: false,
      status: 503,
      json: async () => problem,
    });

    const error = await failureFrom(readBrowserJson("/api/v1/test", { request }));
    expect(error.failure).toEqual({
      kind: "response_problem",
      problem,
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
