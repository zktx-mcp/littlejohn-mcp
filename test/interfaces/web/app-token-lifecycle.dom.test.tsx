// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  accountAssetBrowserRoutes,
} from "../../../src/account-assets/browser.js";
import {
  browserLocations,
  browserWalletApiPaths,
} from "../../../src/interfaces/browser-contract.js";
import { App } from "../../../src/interfaces/web/app.js";
import type { ReferenceChartPort } from "../../../src/interfaces/web/reference-chart.js";
import {
  tokenCatalogBrowserRoutes,
  type TokenCatalogOperation,
} from "../../../src/token-catalog/browser.js";
import { parseWalletCurrentOperationProjection } from "../../../src/wallet/operation-contract.js";
import { createTokenOperation } from "../../token-catalog/harness.js";
import {
  stockTokenAccount,
  stockTokenExactResult,
  stockTokenOverviewResult,
} from "./stock-token-fixtures.js";

const unavailableChart: ReferenceChartPort = Object.freeze({
  mount: async () => Object.freeze({ status: "unavailable" }),
});
const disconnectedWallet = parseWalletCurrentOperationProjection({
  status: "absent",
  connectionRevision: "1",
  connection: { status: "disconnected", reason: "no_session" },
});
const connectedWallet = parseWalletCurrentOperationProjection({
  status: "absent",
  connectionRevision: "1",
  connection: {
    status: "connected",
    address: stockTokenAccount.address,
    chainId: stockTokenAccount.chainId,
    approvedMethods: ["eth_sendTransaction"],
    approvedEvents: ["accountsChanged", "chainChanged"],
    expiresAt: "2099-12-31T23:59:59.000Z",
  },
});
const json = (value: unknown): Response => new Response(JSON.stringify(value), {
  status: 200,
  headers: { "content-type": "application/json" },
});

beforeEach(() => {
  document.head.innerHTML =
    `<meta name="littlejohn-csrf-token" content="${"A".repeat(43)}">`;
  window.sessionStorage.clear();
  vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation((array) => {
    new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(0);
    return array;
  });
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: function showModal(this: HTMLDialogElement): void {
      this.setAttribute("open", "");
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: function close(this: HTMLDialogElement): void {
      this.removeAttribute("open");
    },
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Dismissal = "control" | "close" | "escape" | "backdrop";

describe("application token task lifecycle", () => {
  it.each<Dismissal>(["control", "close", "escape", "backdrop"])(
    "maps %s dismissal to one exact cancellation and retains the task until terminal observation",
    async (dismissal) => {
      const awaiting = await createTokenOperation({
        kind: "remove",
        state: "awaiting_confirmation",
        operationId: "A".repeat(43),
      });
      const cancelled = await createTokenOperation({
        kind: "remove",
        state: "cancelled",
        operationId: awaiting.operationId,
      });
      let observedOperation: TokenCatalogOperation = awaiting;
      let resolveCancellation!: (response: Response) => void;
      const cancellationResponse = new Promise<Response>((resolve) => {
        resolveCancellation = resolve;
      });
      const fetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
        const path = typeof input === "string" ? input : input.toString();
        if (path === browserWalletApiPaths.currentOperation) {
          return json(disconnectedWallet);
        }
        if (path === tokenCatalogBrowserRoutes.currentOperation) {
          return json({ operation: observedOperation });
        }
        if (path === tokenCatalogBrowserRoutes.operation(awaiting.operationId)) {
          return json({ operation: observedOperation });
        }
        if (path === tokenCatalogBrowserRoutes.cancellation(awaiting.operationId)) {
          return await cancellationResponse;
        }
        throw new Error(`Unexpected browser request: ${path}`);
      });
      vi.stubGlobal("fetch", fetch);

      render(<App
        referenceChart={unavailableChart}
        locationState={{ status: "valid", location: browserLocations.assets() }}
        navigationFocusVisible={false}
        onNavigate={() => undefined}
      />);

      const dialog = await screen.findByRole("dialog", {
        name: "Remove Stock Token",
      });
      expect(screen.getByText("No connected account")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Remove token" })).toBeNull();

      if (dismissal === "control") {
        fireEvent.click(screen.getByRole("button", { name: "Keep token" }));
      } else if (dismissal === "close") {
        fireEvent.click(screen.getByRole("button", {
          name: "Close Remove Stock Token",
        }));
      } else if (dismissal === "escape") {
        dialog.dispatchEvent(new Event("cancel", {
          bubbles: true,
          cancelable: true,
        }));
      } else {
        fireEvent.mouseDown(dialog);
      }

      await waitFor(() => {
        expect(fetch.mock.calls.filter(([input]) =>
          (typeof input === "string" ? input : input.toString()) ===
            tokenCatalogBrowserRoutes.cancellation(awaiting.operationId)))
          .toHaveLength(1);
      });
      expect(screen.getByRole("dialog", { name: "Remove Stock Token" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Keep token" })).toBeNull();

      observedOperation = cancelled;
      await act(async () => {
        resolveCancellation(json({ operation: cancelled }));
        await cancellationResponse;
      });
      expect(await screen.findByText("Token selection change cancelled")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      await waitFor(() => {
        expect(screen.queryByRole("dialog", { name: "Remove Stock Token" }))
          .toBeNull();
      });
    },
  );

  it("keeps a dismissed Remove uncertainty hidden until exact review becomes observable", async () => {
    const awaiting = await createTokenOperation({
      kind: "remove",
      state: "awaiting_confirmation",
      operationId: "A".repeat(43),
    });
    const assetWithoutMetadata = Object.freeze({
      ...stockTokenExactResult.asset,
      name: { status: "unavailable" as const, reason: "call_failed" as const },
      symbol: { status: "unavailable" as const, reason: "malformed" as const },
    });
    const exactWithoutMetadata = Object.freeze({
      ...stockTokenExactResult,
      asset: assetWithoutMetadata,
    });
    if (stockTokenOverviewResult.stockTokens.status !== "current") {
      throw new TypeError("Expected a current Stock Token overview fixture.");
    }
    const overviewWithoutMetadata = Object.freeze({
      ...stockTokenOverviewResult,
      stockTokens: Object.freeze({
        ...stockTokenOverviewResult.stockTokens,
        members: Object.freeze([{ status: "selected" as const, asset: assetWithoutMetadata }]),
      }),
    });
    let observable = false;
    const exactPath = accountAssetBrowserRoutes.exact(
      exactWithoutMetadata.asset.selection.asset.chainId,
      exactWithoutMetadata.asset.selection.asset.address,
    );
    const fetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const path = typeof input === "string" ? input : input.toString();
      if (path === browserWalletApiPaths.currentOperation) {
        return json(connectedWallet);
      }
      if (path === accountAssetBrowserRoutes.overview) {
        return json(overviewWithoutMetadata);
      }
      if (path === exactPath) return json(exactWithoutMetadata);
      if (path === tokenCatalogBrowserRoutes.currentOperation) {
        return json({ operation: null });
      }
      if (path === tokenCatalogBrowserRoutes.operations) return json({});
      if (path === tokenCatalogBrowserRoutes.operation(awaiting.operationId)) {
        return observable
          ? json({ operation: awaiting })
          : new Response(JSON.stringify({
              type: "about:blank",
              title: "Token operation not found",
              status: 404,
              code: "token_operation_not_found",
              detail: "The token operation was not found.",
              retryable: false,
              issues: [],
            }), {
              status: 404,
              headers: { "content-type": "application/problem+json" },
            });
      }
      throw new Error(`Unexpected browser request: ${path}`);
    });
    vi.stubGlobal("fetch", fetch);

    render(<App
      referenceChart={unavailableChart}
      locationState={{ status: "valid", location: browserLocations.assets() }}
      navigationFocusVisible={false}
      onNavigate={() => undefined}
    />);

    fireEvent.click(await screen.findByRole("button", {
      name: `Open ${stockTokenExactResult.asset.selection.asset.address} information`,
    }));
    const information = await screen.findByRole("dialog", {
      name: "Token information",
    });
    fireEvent.click(within(information).getByRole("button", { name: "Remove" }));

    const uncertain = await screen.findByRole("dialog", {
      name: `Remove ${stockTokenExactResult.asset.selection.asset.address}`,
    });
    expect(within(uncertain).getByText("Removal status unknown")).toBeTruthy();
    fireEvent.click(within(uncertain).getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", {
        name: `Remove ${stockTokenExactResult.asset.selection.asset.address}`,
      })).toBeNull();
    });
    await act(async () => {
      await new Promise((resolve) => { setTimeout(resolve, 650); });
    });
    expect(screen.queryByRole("dialog", {
      name: `Remove ${stockTokenExactResult.asset.selection.asset.address}`,
    })).toBeNull();

    observable = true;
    const review = await screen.findByRole("dialog", {
      name: `Remove ${stockTokenExactResult.asset.selection.asset.address}`,
    }, { timeout: 2_000 });
    expect(within(review).getByRole("button", { name: "Remove" })).toBeTruthy();
    expect(fetch.mock.calls.filter(([input]) =>
      (typeof input === "string" ? input : input.toString()) ===
        tokenCatalogBrowserRoutes.operations)).toHaveLength(1);
  });

  it("keeps a dismissed external uncertainty on exact-ID polling until terminal", async () => {
    const awaiting = await createTokenOperation({
      kind: "remove",
      state: "awaiting_confirmation",
      operationId: "A".repeat(43),
    });
    const completed = await createTokenOperation({
      kind: "remove",
      state: "completed",
      operationId: awaiting.operationId,
    });
    let observedOperation: TokenCatalogOperation = awaiting;
    const fetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const path = typeof input === "string" ? input : input.toString();
      if (path === browserWalletApiPaths.currentOperation) {
        return json(connectedWallet);
      }
      if (path === accountAssetBrowserRoutes.overview) {
        return json(stockTokenOverviewResult);
      }
      if (path === tokenCatalogBrowserRoutes.currentOperation) {
        return json({ operation: awaiting });
      }
      if (path === tokenCatalogBrowserRoutes.confirmation(awaiting.operationId)) {
        return json({});
      }
      if (path === tokenCatalogBrowserRoutes.operation(awaiting.operationId)) {
        return json({ operation: observedOperation });
      }
      throw new Error(`Unexpected browser request: ${path}`);
    });
    vi.stubGlobal("fetch", fetch);

    render(<App
      referenceChart={unavailableChart}
      locationState={{ status: "valid", location: browserLocations.assets() }}
      navigationFocusVisible={false}
      onNavigate={() => undefined}
    />);

    const task = await screen.findByRole("dialog", { name: "Remove Stock Token" });
    fireEvent.click(within(task).getByRole("button", { name: "Remove token" }));
    expect(await screen.findByText("Token action status unknown")).toBeTruthy();
    fireEvent.click(within(task).getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Remove Stock Token" }))
        .toBeNull();
    });

    observedOperation = completed;
    const terminal = await screen.findByRole("dialog", {
      name: "Remove Stock Token",
    }, { timeout: 2_000 });
    expect(within(terminal).getByText(
      "The account token selection is up to date.",
    )).toBeTruthy();
    expect(fetch.mock.calls.filter(([input]) =>
      (typeof input === "string" ? input : input.toString()) ===
        tokenCatalogBrowserRoutes.confirmation(awaiting.operationId)))
      .toHaveLength(1);
    expect(fetch.mock.calls.some(([input]) =>
      (typeof input === "string" ? input : input.toString()) ===
        tokenCatalogBrowserRoutes.operation(awaiting.operationId))).toBe(true);
  });
});
