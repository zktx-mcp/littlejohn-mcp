// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  browserLocations,
  browserOperationCancellationPath,
  browserWalletApiPaths,
} from "../../../src/interfaces/browser-contract.js";
import { App } from "../../../src/interfaces/web/app.js";
import type { ReferenceChartPort } from "../../../src/interfaces/web/reference-chart.js";
import {
  parseWalletCurrentOperationProjection,
  parseWalletManagementOperation,
  parseWalletOperationPresentation,
} from "../../../src/wallet/operation-contract.js";
import { tokenCatalogBrowserRoutes } from "../../../src/token-catalog/browser.js";

const operationId = "A".repeat(43);
const connectionRevision = "1";
const disconnected = Object.freeze({
  status: "disconnected" as const,
  reason: "no_session" as const,
});
const awaiting = parseWalletManagementOperation({
  operationId,
  connectionRevision,
  expiresAt: "2099-12-31T23:59:59.000Z",
  kind: "connect",
  state: "awaiting_wallet_approval",
  result: null,
  failure: null,
});
const cancelled = parseWalletManagementOperation({
  ...awaiting,
  state: "cancelled",
});
const absent = parseWalletCurrentOperationProjection({
  status: "absent",
  connectionRevision,
  connection: disconnected,
});
const present = parseWalletCurrentOperationProjection({
  status: "present",
  connectionRevision,
  connection: disconnected,
  presentation: parseWalletOperationPresentation({
    operation: awaiting,
    access: "interactive",
  }),
});
const unavailableChart: ReferenceChartPort = Object.freeze({
  mount: async () => Object.freeze({ status: "unavailable" }),
});

const json = (value: unknown): Response => new Response(
  JSON.stringify(value),
  {
    status: 200,
    headers: { "content-type": "application/json" },
  },
);

const sourceUnavailable = (): Response => new Response(
  JSON.stringify({
    type: "about:blank",
    title: "Source unavailable",
    status: 503,
    code: "source_unavailable",
    detail: "A required data source is unavailable.",
    retryable: true,
    issues: [],
  }),
  {
    status: 503,
    headers: { "content-type": "application/problem+json" },
  },
);

beforeEach(() => {
  document.head.innerHTML =
    `<meta name="littlejohn-csrf-token" content="${"A".repeat(43)}">`;
  window.sessionStorage.clear();
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
  vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation((array) => {
    new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(0);
    return array;
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("application wallet task lifecycle", () => {
  it("does not offer Retry for a non-retryable wallet status failure", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const path = typeof input === "string" ? input : input.toString();
      if (path === browserWalletApiPaths.currentOperation) {
        throw new TypeError("The local runtime could not be reached.");
      }
      if (path === tokenCatalogBrowserRoutes.currentOperation) {
        return json({ operation: null });
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

    expect(await screen.findByText(
      /Little John is not available, so wallet status could not be loaded/u,
    )).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("offers an effective Retry only for a retryable wallet status failure", async () => {
    let available = false;
    let walletReads = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const path = typeof input === "string" ? input : input.toString();
      if (path === browserWalletApiPaths.currentOperation) {
        walletReads += 1;
        return available ? json(absent) : sourceUnavailable();
      }
      if (path === tokenCatalogBrowserRoutes.currentOperation) {
        return json({ operation: null });
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

    const retry = await screen.findByRole("button", { name: "Retry" });
    const readsBeforeRetry = walletReads;
    available = true;
    fireEvent.click(retry);
    expect(walletReads).toBeGreaterThan(readsBeforeRetry);
    await waitFor(() => {
      expect(screen.getAllByRole("button", {
        name: "Connect wallet",
      }).length).toBeGreaterThan(0);
    });
  });

  it("keeps an active wallet task without exposing an inaccessible page Retry", async () => {
    let started = false;
    let observationUnavailable = false;
    let walletReads = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const path = typeof input === "string" ? input : input.toString();
      if (path === browserWalletApiPaths.currentOperation) {
        walletReads += 1;
        if (observationUnavailable) return sourceUnavailable();
        return json(started ? present : absent);
      }
      if (path === browserWalletApiPaths.operations) {
        started = true;
        return json({ status: "operation_started", operation: awaiting });
      }
      if (path === tokenCatalogBrowserRoutes.currentOperation) {
        return json({ operation: null });
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

    fireEvent.click(await screen.findByText("Connect wallet", {
      selector: "button",
    }));
    expect(await screen.findByRole("button", {
      name: "Cancel connection",
    })).toBeTruthy();

    observationUnavailable = true;
    const readsBeforeFailure = walletReads;
    await waitFor(() => {
      expect(walletReads).toBeGreaterThan(readsBeforeFailure);
    });
    expect(screen.queryByText(
      /Wallet status could not be loaded because a required data source is unavailable/u,
    )).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Connect wallet" })).toBeTruthy();
    expect(screen.getByRole("button", {
      name: "Cancel connection",
    })).toBeTruthy();

    observationUnavailable = false;
    const readsBeforeRecovery = walletReads;
    await waitFor(() => {
      expect(walletReads).toBeGreaterThan(readsBeforeRecovery);
    });
    expect(screen.getByRole("dialog", { name: "Connect wallet" })).toBeTruthy();
  });

  it("binds the started operation and closes the exact task after cancellation", async () => {
    let started = false;
    let ended = false;
    const paths: string[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const path = typeof input === "string" ? input : input.toString();
      paths.push(path);
      if (path === browserWalletApiPaths.currentOperation) {
        return json(started && !ended ? present : absent);
      }
      if (path === browserWalletApiPaths.operations) {
        started = true;
        return json({ status: "operation_started", operation: awaiting });
      }
      if (path === browserOperationCancellationPath(operationId)) {
        ended = true;
        return json(cancelled);
      }
      if (path === tokenCatalogBrowserRoutes.currentOperation) {
        return json({ operation: null });
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

    fireEvent.click(await screen.findByText("Connect wallet", {
      selector: "button",
    }));
    const cancel = await screen.findByRole("button", {
      name: "Cancel connection",
    });
    fireEvent.click(cancel);

    await waitFor(() => {
      expect(screen.queryByRole("dialog", {
        name: "Connect wallet",
      })).toBeNull();
      expect(screen.getByText("Wallet connection cancelled")).toBeTruthy();
      expect(document.activeElement).toBe(
        document.querySelector(".wallet-nav-control"),
      );
    });
    expect(paths.filter((path) =>
      path === browserWalletApiPaths.operations)).toHaveLength(1);
    expect(paths.filter((path) =>
      path === browserOperationCancellationPath(operationId))).toHaveLength(1);
    expect(screen.queryByText("Starting wallet connection")).toBeNull();
  });
});
