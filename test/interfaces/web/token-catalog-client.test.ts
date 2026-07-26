import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  browserCsrfHeaderName,
  publicInspectionPaths,
} from "../../../src/interfaces/browser-contract.js";
import type { BrowserFetch } from "../../../src/interfaces/web/browser-client.js";
import {
  cancelTokenOperation,
  confirmTokenOperation,
  inspectTokenContract,
  loadCurrentTokenOperation,
  loadTokenOperation,
  startTokenSelection,
  startTokenRemoval,
} from "../../../src/interfaces/web/token-catalog-client.js";
import {
  tokenCatalogBrowserRoutes,
} from "../../../src/token-catalog/browser.js";
import {
  chainId,
  createInspectionSuccess,
  createTokenOperation,
  createTokenSelection,
  tokenAddress,
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
  const selection = createTokenSelection(inspection);
  return Object.freeze({
    inspection,
    selection,
    add: await createTokenOperation({ kind: "add", state: "awaiting_confirmation", operationId }),
    remove: await createTokenOperation({ kind: "remove", state: "awaiting_confirmation", operationId }),
  });
};

describe("token catalog browser client", () => {
  it("uses the public token route without credentials and applies complete public validation", async () => {
    const fixture = await fixtures();
    const input = {
      asset: fixture.inspection.data.asset,
      block: { kind: "latest" as const },
    };
    const valid = queuedFetch([jsonResponse(200, fixture.inspection)]);
    const signal = new AbortController().signal;

    await expect(inspectTokenContract(input, { request: valid.request, signal }))
      .resolves.toEqual(fixture.inspection);
    expect(valid.requests).toEqual([{
      path: publicInspectionPaths.tokenQueries,
      init: expect.objectContaining({
        method: "POST",
        credentials: "omit",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        signal,
      }),
    }]);

    if (fixture.inspection.data.metadata.name.status !== "available") {
      throw new Error("The token inspection fixture has no name claim.");
    }
    const changedClaim = {
      ...fixture.inspection,
      data: {
        ...fixture.inspection.data,
        metadata: {
          ...fixture.inspection.data.metadata,
          name: {
            ...fixture.inspection.data.metadata.name,
            value: "Different Token",
          },
        },
      },
    };
    const invalid = queuedFetch([jsonResponse(200, changedClaim)]);
    await expect(inspectTokenContract(input, { request: invalid.request }))
      .rejects.toMatchObject({
        message: "The token inspection response is invalid.",
      });
  });

  it("starts membership addition with one canonical browser-control request", async () => {
    const fixture = await fixtures();
    const transport = queuedFetch([jsonResponse(200, { operation: fixture.add })]);

    await expect(startTokenSelection(
      chainId,
      tokenAddress,
      csrfToken,
      { request: transport.request },
    )).resolves.toEqual({ operation: fixture.add });
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
      request: { kind: "add", asset: fixture.selection.asset },
    });
  });

  it("derives removal, current read, exact read, confirmation, and cancellation from canonical state", async () => {
    const fixture = await fixtures();
    const cancelled = await createTokenOperation({
      kind: "remove", state: "cancelled", operationId: fixture.remove.operationId,
    });
    const completed = await createTokenOperation({
      kind: "remove", state: "completed", operationId: fixture.remove.operationId,
    });
    const transport = queuedFetch([
      jsonResponse(200, { operation: fixture.remove }),
      jsonResponse(200, { operation: fixture.remove }),
      jsonResponse(200, { operation: fixture.remove }),
      jsonResponse(200, completed),
      jsonResponse(200, { operation: cancelled }),
    ]);
    const options = { request: transport.request };

    await expect(startTokenRemoval(fixture.selection, csrfToken, options))
      .resolves.toEqual({ operation: fixture.remove });
    await expect(loadCurrentTokenOperation(options)).resolves.toEqual(fixture.remove);
    await expect(loadTokenOperation(fixture.remove.operationId, options))
      .resolves.toEqual({ operation: fixture.remove });
    await expect(confirmTokenOperation(fixture.remove, csrfToken, options)).resolves.toEqual(completed);
    await expect(cancelTokenOperation(fixture.remove.operationId, csrfToken, options))
      .resolves.toEqual({ operation: cancelled });

    expect(transport.requests.map(({ path, init }) => ({ path, method: init.method, body: body(init.body) })))
      .toEqual([
        {
          path: tokenCatalogBrowserRoutes.operations,
          method: "POST",
          body: {
            control: { operationId: fixture.remove.operationId, interactionInterface: "web" },
            request: {
              kind: "remove",
              asset: fixture.selection.asset,
              expectedRevision: fixture.selection.revision,
            },
          },
        },
        { path: tokenCatalogBrowserRoutes.currentOperation, method: "GET", body: undefined },
        { path: tokenCatalogBrowserRoutes.operation(fixture.remove.operationId), method: "GET", body: undefined },
        {
          path: tokenCatalogBrowserRoutes.confirmation(fixture.remove.operationId),
          method: "POST",
          body: { reviewDigest: fixture.remove.review.reviewDigest },
        },
        {
          path: tokenCatalogBrowserRoutes.cancellation(fixture.remove.operationId),
          method: "POST",
          body: {},
        },
      ]);
  });

  it("converts an uncorrelated successful mutation response into delivery uncertainty", async () => {
    const fixture = await fixtures();
    const transport = queuedFetch([jsonResponse(200, {})]);

    await expect(startTokenSelection(chainId, tokenAddress, csrfToken, { request: transport.request }))
      .resolves.toEqual({
        status: "delivery_unknown",
        action: "start",
        operationId,
        resendAllowed: false,
      });
    await expect(confirmTokenOperation(
      fixture.add,
      csrfToken,
      { request: queuedFetch([jsonResponse(200, {})]).request },
    )).resolves.toMatchObject({ status: "delivery_unknown", action: "confirm", resendAllowed: false });
  });

  it("passes one caller signal through read requests and rejects malformed read responses", async () => {
    const fixture = await fixtures();
    const controller = new AbortController();
    const transport = queuedFetch([
      jsonResponse(200, { operation: fixture.add }),
      jsonResponse(200, {}),
    ]);
    const options = { request: transport.request, signal: controller.signal };

    await expect(loadCurrentTokenOperation(options)).resolves.toEqual(fixture.add);
    await expect(loadTokenOperation(fixture.add.operationId, options)).rejects.toMatchObject({
      message: "The account token response is invalid.",
    });
    expect(transport.requests.every(({ init }) => init.signal === controller.signal)).toBe(true);
  });
});
