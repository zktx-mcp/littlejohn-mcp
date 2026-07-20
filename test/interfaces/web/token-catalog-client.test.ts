import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { browserCsrfHeaderName } from "../../../src/interfaces/browser-contract.js";
import {
  isBrowserResponseCode,
  type BrowserFetch,
} from "../../../src/interfaces/web/browser-client.js";
import {
  cancelTokenOperation,
  confirmTokenOperation,
  loadCurrentTokenOperation,
  loadTokenRegistration,
  loadTokenOperation,
  loadTokenRegistrations,
  startTokenRegistration,
  startTokenRegistrationUpdate,
  startTokenUnregistration,
} from "../../../src/interfaces/web/token-catalog-client.js";
import {
  tokenCatalogBrowserRoutes,
  tokenCatalogOperationSchema,
  tokenInspectionDigest,
  tokenRegistrationSchema,
} from "../../../src/token-catalog/browser.js";
import {
  chainId,
  createInspectionSuccess,
  tokenAddress,
  walletAddress,
} from "../../token-catalog/harness.js";

const csrfToken = "A".repeat(43);
const operationId = "A".repeat(43);
let operationIdByte = 0;

beforeEach(() => {
  operationIdByte = 0;
  vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation((array) => {
    new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(operationIdByte);
    operationIdByte += 1;
    return array;
  });
});

afterEach(() => { vi.restoreAllMocks(); });

const jsonResponse = (status: number, value: unknown): Response => new Response(
  JSON.stringify(value),
  {
    status,
    headers: { "Content-Type": "application/json" },
  },
);

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
  return Object.freeze({ request, requests });
};

const parseRequestBody = (body: string | undefined): unknown =>
  body === undefined ? undefined : JSON.parse(body);

const operationFixtures = async () => {
  const inspection = await createInspectionSuccess();
  const previous = tokenRegistrationSchema.parse({
    account: { chainId, address: walletAddress },
    asset: inspection.data.asset,
    revision: Buffer.alloc(16, 1).toString("base64url"),
    inspectionDigest: tokenInspectionDigest(inspection),
    userLabel: "Old label",
    visibility: "visible",
    createdAt: "2026-07-18T00:00:01.000Z",
    updatedAt: "2026-07-18T00:00:01.000Z",
  });
  const common = {
    operationId: "A".repeat(43),
    state: "awaiting_confirmation" as const,
    interactionInterface: "web" as const,
    createdAt: "2026-07-18T00:00:03.000Z",
    expiresAt: "2026-07-18T00:05:03.000Z",
    account: previous.account,
    asset: previous.asset,
    result: null,
    failure: null,
  };
  const update = tokenCatalogOperationSchema.parse({
    ...common,
    kind: "update_registration",
    review: {
      previousRegistration: previous,
      proposedSettings: { userLabel: "New label", visibility: "hidden" },
      inspection,
      reviewDigest: `0x${"ab".repeat(32)}`,
    },
  });
  const unregister = tokenCatalogOperationSchema.parse({
    ...common,
    operationId: Buffer.alloc(32, 1).toString("base64url"),
    kind: "unregister",
    review: {
      previousRegistration: previous,
      proposedSettings: null,
      inspection,
      reviewDigest: `0x${"cd".repeat(32)}`,
    },
  });
  const updatedRegistration = tokenRegistrationSchema.parse({
    ...previous,
    revision: Buffer.alloc(16, 2).toString("base64url"),
    userLabel: "New label",
    visibility: "hidden",
    updatedAt: "2026-07-18T00:00:04.000Z",
  });
  const completedUpdate = tokenCatalogOperationSchema.parse({
    ...update,
    state: "completed",
    result: { registration: updatedRegistration, inspection },
  });
  const cancelledUnregister = tokenCatalogOperationSchema.parse({
    ...unregister,
    state: "cancelled",
  });
  return Object.freeze({
    inspection,
    previous,
    update,
    unregister,
    completedUpdate,
    cancelledUnregister,
  });
};

describe("token catalog browser client", () => {
  it("uses the canonical list wire body for the first and cursor pages", async () => {
    const transport = queuedFetch([
      jsonResponse(200, { registrations: [], nextCursor: null }),
      jsonResponse(200, { registrations: [], nextCursor: null }),
    ]);

    await expect(loadTokenRegistrations({}, { request: transport.request })).resolves.toEqual({
      registrations: [],
      nextCursor: null,
    });
    await expect(loadTokenRegistrations(
      { cursor: tokenAddress },
      { request: transport.request },
    )).resolves.toEqual({ registrations: [], nextCursor: null });

    expect(transport.requests.map(({ path, init }) => ({
      path,
      body: parseRequestBody(init.body),
    }))).toEqual([
      {
        path: tokenCatalogBrowserRoutes.registrationQueries,
        body: { limit: 25 },
      },
      {
        path: tokenCatalogBrowserRoutes.registrationQueries,
        body: { limit: 25, cursor: tokenAddress },
      },
    ]);
  });

  it("starts Add as one non-aborted canonical browser control request", async () => {
    const inspection = await createInspectionSuccess();
    const settings = { userLabel: "Example", visibility: "visible" as const };
    const operation = tokenCatalogOperationSchema.parse({
      operationId: "A".repeat(43),
      kind: "register",
      state: "awaiting_confirmation",
      interactionInterface: "web",
      createdAt: "2026-07-18T00:00:03.000Z",
      expiresAt: "2026-07-18T00:05:03.000Z",
      account: { chainId, address: walletAddress },
      asset: inspection.data.asset,
      review: {
        previousRegistration: null,
        proposedSettings: settings,
        inspection,
        reviewDigest: `0x${"ab".repeat(32)}`,
      },
      result: null,
      failure: null,
    });
    const transport = queuedFetch([jsonResponse(200, { operation })]);

    await expect(startTokenRegistration(
      chainId,
      tokenAddress,
      settings,
      csrfToken,
      { request: transport.request },
    )).resolves.toEqual({ operation });
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]?.path).toBe(tokenCatalogBrowserRoutes.operations);
    expect(transport.requests[0]?.init).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        [browserCsrfHeaderName]: csrfToken,
        "Content-Type": "application/json",
      },
    });
    expect(transport.requests[0]?.init.signal).toBeInstanceOf(AbortSignal);
    expect(parseRequestBody(transport.requests[0]?.init.body)).toEqual({
      control: { operationId, interactionInterface: "web" },
      request: {
        kind: "register",
        asset: inspection.data.asset,
        settings,
      },
    });
  });

  it("preserves an unavailable exact-operation response for the page lifecycle", async () => {
    const transport = queuedFetch([jsonResponse(404, {
      type: "about:blank",
      title: "Token operation not found",
      status: 404,
      code: "token_operation_not_found",
      detail: "The token catalog operation is not available.",
      retryable: false,
      issues: [],
    })]);

    await expect(loadTokenOperation(operationId, { request: transport.request })).rejects.toSatisfy(
      (error: unknown) => isBrowserResponseCode(error, "token_operation_not_found"),
    );
  });

  it("uses the canonical browser contract for detail, update, removal, operation, confirmation, and cancellation", async () => {
    const fixture = await operationFixtures();
    const transport = queuedFetch([
      jsonResponse(200, { registration: fixture.previous, inspection: fixture.inspection }),
      jsonResponse(200, { operation: fixture.update }),
      jsonResponse(200, { operation: fixture.unregister }),
      jsonResponse(200, { operation: fixture.update }),
      jsonResponse(200, { operation: fixture.update }),
      jsonResponse(200, fixture.completedUpdate),
      jsonResponse(200, { operation: fixture.cancelledUnregister }),
    ]);
    const options = { request: transport.request };

    await expect(loadTokenRegistration(chainId, tokenAddress, options)).resolves.toEqual({
      registration: fixture.previous,
      inspection: fixture.inspection,
    });
    await expect(startTokenRegistrationUpdate(
      fixture.previous,
      { userLabel: "New label", visibility: "hidden" },
      csrfToken,
      options,
    )).resolves.toEqual({ operation: fixture.update });
    await expect(startTokenUnregistration(
      fixture.previous,
      csrfToken,
      options,
    )).resolves.toEqual({ operation: fixture.unregister });
    await expect(loadCurrentTokenOperation(options)).resolves.toEqual(fixture.update);
    await expect(loadTokenOperation(fixture.update.operationId, options)).resolves.toEqual({
      operation: fixture.update,
    });
    await expect(confirmTokenOperation(fixture.update, csrfToken, options)).resolves.toEqual(
      fixture.completedUpdate,
    );
    await expect(cancelTokenOperation(
      fixture.unregister.operationId,
      csrfToken,
      options,
    )).resolves.toEqual({ operation: fixture.cancelledUnregister });

    expect(transport.requests.map(({ path, init }) => ({
      path,
      method: init.method,
      csrf: init.headers?.[browserCsrfHeaderName],
      body: parseRequestBody(init.body),
    }))).toEqual([
      {
        path: tokenCatalogBrowserRoutes.registration(chainId, tokenAddress),
        method: "GET",
        csrf: undefined,
        body: undefined,
      },
      {
        path: tokenCatalogBrowserRoutes.operations,
        method: "POST",
        csrf: csrfToken,
        body: {
          control: {
            operationId: fixture.update.operationId,
            interactionInterface: "web",
          },
          request: {
            kind: "update_registration",
            asset: fixture.previous.asset,
            expectedRevision: fixture.previous.revision,
            changes: { userLabel: "New label", visibility: "hidden" },
          },
        },
      },
      {
        path: tokenCatalogBrowserRoutes.operations,
        method: "POST",
        csrf: csrfToken,
        body: {
          control: {
            operationId: fixture.unregister.operationId,
            interactionInterface: "web",
          },
          request: {
            kind: "unregister",
            asset: fixture.previous.asset,
            expectedRevision: fixture.previous.revision,
          },
        },
      },
      {
        path: tokenCatalogBrowserRoutes.currentOperation,
        method: "GET",
        csrf: undefined,
        body: undefined,
      },
      {
        path: tokenCatalogBrowserRoutes.operation(fixture.update.operationId),
        method: "GET",
        csrf: undefined,
        body: undefined,
      },
      {
        path: tokenCatalogBrowserRoutes.confirmation(fixture.update.operationId),
        method: "POST",
        csrf: csrfToken,
        body: { reviewDigest: fixture.update.review.reviewDigest },
      },
      {
        path: tokenCatalogBrowserRoutes.cancellation(fixture.unregister.operationId),
        method: "POST",
        csrf: csrfToken,
        body: {},
      },
    ]);
  });

  it("rejects malformed responses for every browser catalog operation", async () => {
    const fixture = await operationFixtures();
    const readCalls = [
      () => loadTokenRegistrations({}, { request: queuedFetch([jsonResponse(200, {})]).request }),
      () => loadTokenRegistration(chainId, tokenAddress, { request: queuedFetch([jsonResponse(200, {})]).request }),
      () => loadCurrentTokenOperation({ request: queuedFetch([jsonResponse(200, {})]).request }),
      () => loadTokenOperation(
        fixture.update.operationId,
        { request: queuedFetch([jsonResponse(200, {})]).request },
      ),
    ];
    for (const call of readCalls) {
      await expect(call()).rejects.toMatchObject({
        message: "The token catalog response is invalid.",
      });
    }

    const actionCalls = [
      () => startTokenRegistration(
        chainId,
        tokenAddress,
        { userLabel: null, visibility: "visible" },
        csrfToken,
        { request: queuedFetch([jsonResponse(200, {})]).request },
      ),
      () => startTokenRegistrationUpdate(
        fixture.previous,
        { visibility: "hidden" },
        csrfToken,
        { request: queuedFetch([jsonResponse(200, {})]).request },
      ),
      () => startTokenUnregistration(
        fixture.previous,
        csrfToken,
        { request: queuedFetch([jsonResponse(200, {})]).request },
      ),
      () => confirmTokenOperation(
        fixture.update,
        csrfToken,
        { request: queuedFetch([jsonResponse(200, {})]).request },
      ),
      () => cancelTokenOperation(
        fixture.unregister.operationId,
        csrfToken,
        { request: queuedFetch([jsonResponse(200, {})]).request },
      ),
    ];
    for (const call of actionCalls) {
      await expect(call()).resolves.toMatchObject({
        status: "delivery_unknown",
        resendAllowed: false,
      });
    }
  });

  it("does not trust a response body that imitates local delivery uncertainty", async () => {
    const transport = queuedFetch([jsonResponse(200, {
      status: "delivery_unknown",
      action: "confirm",
      operationId: "B".repeat(43),
      resendAllowed: false,
      extra: true,
    })]);

    await expect(startTokenRegistration(
      chainId,
      tokenAddress,
      { userLabel: null, visibility: "visible" },
      csrfToken,
      { request: transport.request },
    )).resolves.toEqual({
      status: "delivery_unknown",
      action: "start",
      operationId,
      resendAllowed: false,
    });
  });

  it("passes one abort signal through every catalog read request", async () => {
    const fixture = await operationFixtures();
    const controller = new AbortController();
    const transport = queuedFetch([
      jsonResponse(200, { registrations: [], nextCursor: null }),
      jsonResponse(200, { registration: fixture.previous, inspection: fixture.inspection }),
      jsonResponse(200, { operation: fixture.update }),
      jsonResponse(200, { operation: fixture.update }),
    ]);
    const options = { request: transport.request, signal: controller.signal };

    await loadTokenRegistrations({}, options);
    await loadTokenRegistration(chainId, tokenAddress, options);
    await loadCurrentTokenOperation(options);
    await loadTokenOperation(fixture.update.operationId, options);

    expect(transport.requests).toHaveLength(4);
    expect(transport.requests.every(({ init }) => init.signal === controller.signal)).toBe(true);
  });
});
