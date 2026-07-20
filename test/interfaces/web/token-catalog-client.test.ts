import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { browserCsrfHeaderName } from "../../../src/interfaces/browser-contract.js";
import type { BrowserFetch } from "../../../src/interfaces/web/browser-client.js";
import {
  cancelTokenOperation,
  confirmTokenOperation,
  loadCurrentTokenOperation,
  loadTokenOperation,
  startTokenRegistration,
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

beforeEach(() => {
  vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation((array) => {
    new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(0);
    return array;
  });
});

afterEach(() => { vi.restoreAllMocks(); });

const jsonResponse = (status: number, value: unknown): Response => new Response(JSON.stringify(value), {
  status,
  headers: { "Content-Type": "application/json" },
});

const queuedFetch = (responses: readonly Response[]) => {
  const queue = [...responses];
  const requests: Array<{ readonly path: string; readonly init: Parameters<BrowserFetch>[1] }> = [];
  const request: BrowserFetch = async (path, init) => {
    requests.push({ path, init });
    const response = queue.shift();
    if (response === undefined) throw new Error("Unexpected browser request.");
    return response;
  };
  return Object.freeze({ request, requests });
};

const body = (value: string | undefined): unknown => value === undefined ? undefined : JSON.parse(value);

const fixtures = async () => {
  const inspection = await createInspectionSuccess();
  const registration = tokenRegistrationSchema.parse({
    account: { chainId, address: walletAddress },
    asset: inspection.data.asset,
    revision: Buffer.alloc(16, 1).toString("base64url"),
    inspectionDigest: tokenInspectionDigest(inspection),
    createdAt: "2026-07-18T00:00:01.000Z",
  });
  const operation = (kind: "register" | "unregister", id = operationId) =>
    tokenCatalogOperationSchema.parse({
      operationId: id,
      kind,
      state: "awaiting_confirmation",
      interactionInterface: "web",
      createdAt: "2026-07-18T00:00:03.000Z",
      expiresAt: "2026-07-18T00:05:03.000Z",
      account: registration.account,
      connectionRevision: "1",
      asset: registration.asset,
      review: {
        previousRegistration: kind === "register" ? null : registration,
        inspection,
        reviewDigest: `0x${"ab".repeat(32)}`,
      },
      result: null,
      failure: null,
    });
  return Object.freeze({
    inspection,
    registration,
    register: operation("register"),
    unregister: operation("unregister"),
  });
};

describe("token catalog browser client", () => {
  it("starts membership addition with one canonical browser-control request", async () => {
    const fixture = await fixtures();
    const transport = queuedFetch([jsonResponse(200, { operation: fixture.register })]);

    await expect(startTokenRegistration(
      chainId,
      tokenAddress,
      csrfToken,
      { request: transport.request },
    )).resolves.toEqual({ operation: fixture.register });
    expect(transport.requests).toEqual([{
      path: tokenCatalogBrowserRoutes.operations,
      init: expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: expect.objectContaining({ [browserCsrfHeaderName]: csrfToken }),
        body: expect.any(String),
      }),
    }]);
    expect(body(transport.requests[0]?.init.body)).toEqual({
      control: { operationId, interactionInterface: "web" },
      request: { kind: "register", asset: fixture.registration.asset },
    });
  });

  it("derives removal, current read, exact read, confirmation, and cancellation from canonical state", async () => {
    const fixture = await fixtures();
    const cancelled = tokenCatalogOperationSchema.parse({ ...fixture.unregister, state: "cancelled" });
    const completed = tokenCatalogOperationSchema.parse({
      ...fixture.unregister,
      state: "completed",
      result: { asset: fixture.registration.asset, removedRevision: fixture.registration.revision },
    });
    const transport = queuedFetch([
      jsonResponse(200, { operation: fixture.unregister }),
      jsonResponse(200, { operation: fixture.unregister }),
      jsonResponse(200, { operation: fixture.unregister }),
      jsonResponse(200, completed),
      jsonResponse(200, { operation: cancelled }),
    ]);
    const options = { request: transport.request };

    await expect(startTokenUnregistration(fixture.registration, csrfToken, options))
      .resolves.toEqual({ operation: fixture.unregister });
    await expect(loadCurrentTokenOperation(options)).resolves.toEqual(fixture.unregister);
    await expect(loadTokenOperation(fixture.unregister.operationId, options))
      .resolves.toEqual({ operation: fixture.unregister });
    await expect(confirmTokenOperation(fixture.unregister, csrfToken, options)).resolves.toEqual(completed);
    await expect(cancelTokenOperation(fixture.unregister.operationId, csrfToken, options))
      .resolves.toEqual({ operation: cancelled });

    expect(transport.requests.map(({ path, init }) => ({ path, method: init.method, body: body(init.body) })))
      .toEqual([
        {
          path: tokenCatalogBrowserRoutes.operations,
          method: "POST",
          body: {
            control: { operationId: fixture.unregister.operationId, interactionInterface: "web" },
            request: {
              kind: "unregister",
              asset: fixture.registration.asset,
              expectedRevision: fixture.registration.revision,
            },
          },
        },
        { path: tokenCatalogBrowserRoutes.currentOperation, method: "GET", body: undefined },
        { path: tokenCatalogBrowserRoutes.operation(fixture.unregister.operationId), method: "GET", body: undefined },
        {
          path: tokenCatalogBrowserRoutes.confirmation(fixture.unregister.operationId),
          method: "POST",
          body: { reviewDigest: fixture.unregister.review.reviewDigest },
        },
        {
          path: tokenCatalogBrowserRoutes.cancellation(fixture.unregister.operationId),
          method: "POST",
          body: {},
        },
      ]);
  });

  it("converts an uncorrelated successful mutation response into delivery uncertainty", async () => {
    const fixture = await fixtures();
    const transport = queuedFetch([jsonResponse(200, {})]);

    await expect(startTokenRegistration(chainId, tokenAddress, csrfToken, { request: transport.request }))
      .resolves.toEqual({
        status: "delivery_unknown",
        action: "start",
        operationId,
        resendAllowed: false,
      });
    await expect(confirmTokenOperation(
      fixture.register,
      csrfToken,
      { request: queuedFetch([jsonResponse(200, {})]).request },
    )).resolves.toMatchObject({ status: "delivery_unknown", action: "confirm", resendAllowed: false });
  });

  it("passes one caller signal through read requests and rejects malformed read responses", async () => {
    const fixture = await fixtures();
    const controller = new AbortController();
    const transport = queuedFetch([
      jsonResponse(200, { operation: fixture.register }),
      jsonResponse(200, {}),
    ]);
    const options = { request: transport.request, signal: controller.signal };

    await expect(loadCurrentTokenOperation(options)).resolves.toEqual(fixture.register);
    await expect(loadTokenOperation(fixture.register.operationId, options)).rejects.toMatchObject({
      message: "The token catalog response is invalid.",
    });
    expect(transport.requests.every(({ init }) => init.signal === controller.signal)).toBe(true);
  });
});
