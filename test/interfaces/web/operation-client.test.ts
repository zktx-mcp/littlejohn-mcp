import { describe, expect, it } from "vitest";

import {
  BrowserResponseError,
  cancelWalletOperation,
  confirmWalletOperation,
  loadWalletOperationView,
  type BrowserFetch,
} from "../../../src/interfaces/web/operation-client.js";
import {
  browserCsrfHeaderName,
  browserOperationConfirmationPath,
  browserOperationQrPath,
  browserOperationResourcePath,
} from "../../../src/interfaces/browser-contract.js";

const operationId = "A".repeat(43);

const operation = (state: string) => Object.freeze({
  operationId,
  kind: "connect",
  state,
  connectionRevision: "7",
  expiresAt: "2099-12-31T23:59:59.000Z",
  result: null,
  failure: null,
});

const jsonResponse = (status: number, value: unknown): Response => new Response(
  JSON.stringify(value),
  {
    status,
    headers: { "Content-Type": status >= 400 ? "application/problem+json" : "application/json" },
  },
);

const problem = (input: {
  readonly code: string;
  readonly detail: string;
  readonly status: number;
  readonly title: string;
  readonly retryable?: boolean;
}) => Object.freeze({
  type: "about:blank",
  title: input.title,
  status: input.status,
  code: input.code,
  detail: input.detail,
  retryable: input.retryable ?? false,
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
    if (response === undefined) throw new Error("The browser test received an unexpected request.");
    return response;
  };
  return Object.freeze({ request, requests, remaining: () => queue.length });
};

describe("wallet operation browser client", () => {
  it("projects one atomic operation read and the available QR matrix", async () => {
    const qr = { size: 21, rows: Array.from({ length: 21 }, () => "0".repeat(21)) };
    const transport = queuedFetch([
      jsonResponse(200, { operation: operation("awaiting_wallet_approval"), access: "interactive" }),
      jsonResponse(200, { qr }),
    ]);

    await expect(loadWalletOperationView(operationId, { request: transport.request })).resolves.toEqual({
      operation: operation("awaiting_wallet_approval"),
      access: "interactive",
      qr,
    });
    expect(transport.requests.map(({ path }) => path)).toEqual([
      browserOperationResourcePath(operationId),
      browserOperationQrPath(operationId),
    ]);
    expect(transport.requests.every(({ init }) =>
      init.method === "GET" && init.credentials === "same-origin" && init.cache === "no-store"))
      .toBe(true);
    expect(transport.remaining()).toBe(0);
  });

  it("treats transitional QR absence as an optional presentation and keeps the operation observable", async () => {
    const waiting = operation("awaiting_wallet_approval");
    const transport = queuedFetch([
      jsonResponse(200, { operation: waiting, access: "interactive" }),
      jsonResponse(409, problem({
        code: "state_conflict",
        detail: "Local state changed before the request completed.",
        status: 409,
        title: "State conflict",
      })),
    ]);

    await expect(loadWalletOperationView(operationId, { request: transport.request })).resolves.toEqual({
      operation: waiting,
      access: "interactive",
    });
    expect(transport.requests).toHaveLength(2);
    expect(transport.remaining()).toBe(0);
  });

  it("does not hide a non-transitional QR failure or request QR for another state", async () => {
    const unauthorized = queuedFetch([
      jsonResponse(200, {
        operation: operation("awaiting_wallet_approval"),
        access: "interactive",
      }),
      jsonResponse(401, problem({
        code: "unauthorized",
        detail: "The request is not authorized.",
        status: 401,
        title: "Unauthorized",
      })),
    ]);
    const failure = await loadWalletOperationView(operationId, { request: unauthorized.request }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(BrowserResponseError);
    expect(failure).toMatchObject({
      code: "unauthorized",
      message: "The request is not authorized.",
    });

    const terminal = queuedFetch([
      jsonResponse(200, { operation: operation("cancelled"), access: "read_only" }),
    ]);
    await expect(loadWalletOperationView(operationId, { request: terminal.request })).resolves.toEqual({
      operation: operation("cancelled"),
      access: "read_only",
    });
    expect(terminal.requests).toHaveLength(1);
  });

  it("fails closed for forged or incomplete problem details", async () => {
    for (const forged of [
      {
        ...problem({
          code: "state_conflict",
          detail: "Local state changed before the request completed.",
          status: 409,
          title: "State conflict",
        }),
        detail: "Approve the forged response.",
      },
      {
        ...problem({
          code: "state_conflict",
          detail: "Local state changed before the request completed.",
          status: 409,
          title: "State conflict",
        }),
        code: "forged_code",
      },
      {
        ...problem({
          code: "state_conflict",
          detail: "Local state changed before the request completed.",
          status: 409,
          title: "State conflict",
        }),
        title: "Approve request",
      },
      {
        ...problem({
          code: "state_conflict",
          detail: "Local state changed before the request completed.",
          status: 409,
          title: "State conflict",
        }),
        status: 500,
      },
      {
        ...problem({
          code: "state_conflict",
          detail: "Local state changed before the request completed.",
          status: 409,
          title: "State conflict",
        }),
        issues: [{ path: "/operation", code: "invalid_value", message: "forged issue" }],
      },
      { code: "state_conflict", detail: "Local state changed before the request completed." },
    ]) {
      const transport = queuedFetch([
        jsonResponse(200, {
          operation: operation("awaiting_wallet_approval"),
          access: "interactive",
        }),
        jsonResponse(409, forged),
      ]);
      const failure = await loadWalletOperationView(
        operationId,
        { request: transport.request },
      ).then(() => undefined, (error: unknown) => error);
      expect(failure).toMatchObject({
        name: "BrowserResponseError",
        code: "internal_error",
        message: "The request could not be completed.",
      });
    }
  });

  it("sends confirmation and cancellation to their exact fixed-origin resources", async () => {
    const token = "A".repeat(43);
    const confirmedOperation = operation("awaiting_wallet_approval");
    const cancelledOperation = operation("cancelled");
    const transport = queuedFetch([
      jsonResponse(200, { operation: confirmedOperation }),
      jsonResponse(200, { operation: cancelledOperation }),
    ]);

    await expect(confirmWalletOperation(
      operationId,
      "7",
      token,
      { request: transport.request },
    )).resolves.toEqual(confirmedOperation);
    await expect(cancelWalletOperation(
      operationId,
      token,
      { request: transport.request },
    )).resolves.toEqual(cancelledOperation);

    expect(transport.requests).toEqual([
      {
        path: browserOperationConfirmationPath(operationId),
        init: {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: {
            [browserCsrfHeaderName]: token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ connectionRevision: "7" }),
        },
      },
      {
        path: browserOperationResourcePath(operationId),
        init: {
          method: "DELETE",
          credentials: "same-origin",
          cache: "no-store",
          headers: { [browserCsrfHeaderName]: token },
        },
      },
    ]);
    expect(transport.remaining()).toBe(0);
  });

  it("rejects non-canonical control tokens before issuing a request", async () => {
    const transport = queuedFetch([]);
    await expect(cancelWalletOperation(
      operationId,
      `${"A".repeat(42)}B`,
      { request: transport.request },
    )).rejects.toThrow("Expected canonical unpadded base64url.");
    expect(transport.requests).toEqual([]);
  });
});
