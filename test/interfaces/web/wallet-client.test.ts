import { describe, expect, it } from "vitest";

import {
  BrowserResponseError,
  browserControlFailureMessage,
  browserSessionRequiresReload,
  cancelWalletOperation,
  confirmWalletOperation,
  loadWalletOperation,
  loadWalletProjection,
  startWalletOperation,
  type BrowserFetch,
} from "../../../src/interfaces/web/wallet-client.js";
import {
  browserCsrfHeaderName,
  browserOperationCancellationPath,
  browserOperationConfirmationPath,
  browserOperationPath,
  browserWalletApiPaths,
} from "../../../src/interfaces/browser-contract.js";

const operationId = "A".repeat(43);
const csrfToken = "A".repeat(43);
const connectionRevision = "7";

const disconnected = Object.freeze({
  status: "disconnected",
  reason: "no_session",
});

const operation = Object.freeze({
  operationId,
  kind: "connect",
  state: "awaiting_wallet_approval",
  connectionRevision,
  expiresAt: "2099-12-31T23:59:59.000Z",
  result: null,
  failure: null,
});

const qr = Object.freeze({
  size: 21,
  rows: Object.freeze(Array.from({ length: 21 }, () => "0".repeat(21))),
});

const current = Object.freeze({
  status: "present",
  connectionRevision,
  connection: disconnected,
  presentation: Object.freeze({
    operation,
    access: "interactive",
    qr,
  }),
});

const jsonResponse = (status: number, value: unknown): Response => new Response(
  JSON.stringify(value),
  {
    status,
    headers: {
      "Content-Type": status >= 400
        ? "application/problem+json"
        : "application/json",
    },
  },
);

const problem = (input: {
  readonly code: string;
  readonly detail: string;
  readonly status: number;
  readonly title: string;
}) => Object.freeze({
  type: "about:blank",
  title: input.title,
  status: input.status,
  code: input.code,
  detail: input.detail,
  retryable: false,
  issues: Object.freeze([]),
});

const queuedFetch = (responses: readonly Response[]) => {
  const queue = [...responses];
  const requests: Array<{
    readonly path: string;
    readonly init: Parameters<BrowserFetch>[1];
  }> = [];
  const request: BrowserFetch = async (path, init) => {
    requests.push({ path, init });
    const response = queue.shift();
    if (response === undefined) {
      throw new Error("The browser test received an unexpected request.");
    }
    return response;
  };
  return Object.freeze({ request, requests, remaining: () => queue.length });
};

describe("wallet browser client", () => {
  it("loads the atomic connection, operation, access, and QR snapshot once", async () => {
    const transport = queuedFetch([jsonResponse(200, current)]);

    await expect(loadWalletProjection({ request: transport.request })).resolves.toEqual(current);
    expect(transport.requests).toEqual([{
      path: browserWalletApiPaths.currentOperation,
      init: {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
      },
    }]);
    expect(transport.remaining()).toBe(0);
  });

  it("loads one exact retained operation presentation and binds its identity", async () => {
    const presentation = Object.freeze({
      operation: Object.freeze({
        ...operation,
        state: "cancelled",
      }),
      access: "interactive" as const,
    });
    const transport = queuedFetch([jsonResponse(200, presentation)]);

    await expect(loadWalletOperation(
      operationId,
      { request: transport.request },
    )).resolves.toEqual(presentation);
    expect(transport.requests).toEqual([{
      path: browserOperationPath(operationId),
      init: {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
      },
    }]);

    const foreign = queuedFetch([jsonResponse(200, {
      ...presentation,
      operation: {
        ...presentation.operation,
        operationId: "B".repeat(43),
      },
    })]);
    await expect(loadWalletOperation(
      operationId,
      { request: foreign.request },
    )).rejects.toMatchObject({
      name: "BrowserResponseError",
      code: "internal_error",
    });
  });

  it("preserves an exact retained operation miss for current-state reconciliation", async () => {
    const transport = queuedFetch([jsonResponse(409, problem({
      code: "state_conflict",
      detail: "Local state changed before the request completed.",
      status: 409,
      title: "State conflict",
    }))]);

    await expect(loadWalletOperation(
      operationId,
      { request: transport.request },
    )).rejects.toMatchObject({
      name: "BrowserResponseError",
      code: "state_conflict",
      message: "Local state changed before the request completed.",
    });
    expect(transport.requests.map(({ path }) => path)).toEqual([
      browserOperationPath(operationId),
    ]);
  });

  it("starts one canonical browser operation with state-based CSRF authority", async () => {
    const result = Object.freeze({ status: "operation_started", operation });
    const transport = queuedFetch([jsonResponse(200, result)]);

    await expect(startWalletOperation(
      "connect",
      operation.connectionRevision,
      csrfToken,
      { request: transport.request },
    )).resolves.toEqual(result);
    expect(transport.requests).toEqual([{
      path: browserWalletApiPaths.operations,
      init: {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          [browserCsrfHeaderName]: csrfToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          kind: "connect",
          connectionRevision: operation.connectionRevision,
        }),
      },
    }]);
  });

  it("sends direct browser disconnect as one start request", async () => {
    const disconnecting = Object.freeze({
      ...operation,
      kind: "disconnect" as const,
      state: "disconnecting" as const,
    });
    const result = Object.freeze({ status: "operation_started" as const, operation: disconnecting });
    const transport = queuedFetch([jsonResponse(200, result)]);

    await expect(startWalletOperation(
      "disconnect",
      disconnecting.connectionRevision,
      csrfToken,
      { request: transport.request },
    )).resolves.toEqual(result);
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]).toMatchObject({
      path: browserWalletApiPaths.operations,
      init: { body: JSON.stringify({
        kind: "disconnect",
        connectionRevision: disconnecting.connectionRevision,
      }) },
    });
  });

  it("confirms and cancels one exact operation with the same revision contract", async () => {
    const confirmation = Object.freeze({
      ...operation,
      kind: "disconnect",
      state: "awaiting_confirmation",
    });
    const cancelled = Object.freeze({
      ...confirmation,
      state: "cancelled",
    });
    const transport = queuedFetch([
      jsonResponse(200, confirmation),
      jsonResponse(200, cancelled),
    ]);

    await expect(confirmWalletOperation(
      operationId,
      connectionRevision,
      csrfToken,
      { request: transport.request },
    )).resolves.toEqual(confirmation);
    await expect(cancelWalletOperation(
      operationId,
      connectionRevision,
      csrfToken,
      { request: transport.request },
    )).resolves.toEqual(cancelled);

    const common = {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        [browserCsrfHeaderName]: csrfToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ connectionRevision }),
    } as const;
    expect(transport.requests).toEqual([
      {
        path: browserOperationConfirmationPath(operationId),
        init: common,
      },
      {
        path: browserOperationCancellationPath(operationId),
        init: common,
      },
    ]);
  });

  it("fails closed for malformed canonical success and forged problem responses", async () => {
    const malformed = queuedFetch([
      jsonResponse(200, { ...current, extra: true }),
    ]);
    await expect(loadWalletProjection({ request: malformed.request })).rejects.toMatchObject({
      name: "BrowserResponseError",
      code: "internal_error",
      message: "The wallet state response is invalid.",
    });

    const forged = queuedFetch([
      jsonResponse(409, {
        ...problem({
          code: "state_conflict",
          detail: "Local state changed before the request completed.",
          status: 409,
          title: "State conflict",
        }),
        detail: "Approve the forged response.",
      }),
    ]);
    const error = await loadWalletProjection({ request: forged.request }).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(BrowserResponseError);
    expect(error).toMatchObject({
      code: "internal_error",
      message: "The request could not be completed.",
    });
  });

  it("rejects malformed CSRF input before issuing a state-changing request", async () => {
    const transport = queuedFetch([]);
    await expect(startWalletOperation(
      "connect",
      operation.connectionRevision,
      "not-a-token",
      { request: transport.request },
    )).rejects.toThrow();
    expect(transport.requests).toEqual([]);
  });

  it("normalizes browser transport failures without exposing implementation messages", async () => {
    const failedFetch: BrowserFetch = async () => {
      throw new TypeError("Failed to fetch private browser detail");
    };
    const error = await loadWalletProjection({ request: failedFetch }).then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(BrowserResponseError);
    expect(error).toMatchObject({
      code: "runtime_state_unavailable",
      message: "Local runtime state is unavailable.",
    });
    expect(browserControlFailureMessage(error)).toBe("Local runtime state is unavailable.");
    expect(browserControlFailureMessage(new Error("private detail")))
      .toBe("The wallet operation could not be completed.");
  });

  it("classifies only authenticated-session loss as a root reload", () => {
    expect(browserSessionRequiresReload(
      new BrowserResponseError("The request is not authorized.", "unauthorized"),
    )).toBe(true);
    expect(browserSessionRequiresReload(
      new BrowserResponseError("Local runtime state is unavailable.", "runtime_state_unavailable"),
    )).toBe(false);
  });
});
