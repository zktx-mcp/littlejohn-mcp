// @vitest-environment jsdom

import {
  cleanup,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  chainAnchorSchema,
} from "../../../src/core/browser.js";
import type {
  BrowserFetch,
} from "../../../src/interfaces/web/browser-client.js";
import {
  StockTokenInformationDialog,
} from "../../../src/interfaces/web/stock-token-information-dialog.js";
import {
  createExactResolvedAnalysis,
} from "../../core/contract-analysis-fixtures.js";
import {
  createInspectionSuccess,
} from "../../token-catalog/harness.js";
import {
  stockTokenAddress,
  stockTokenBlock,
  stockTokenExactResult,
} from "./stock-token-fixtures.js";

let inspection: Awaited<ReturnType<typeof createInspectionSuccess>>;

beforeAll(async () => {
  const block = chainAnchorSchema.parse(stockTokenBlock);
  inspection = await createInspectionSuccess(undefined, {
    analysis: createExactResolvedAnalysis(stockTokenAddress, block),
  });
});

beforeEach(() => {
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
});

afterAll(() => {
  Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
  vi.restoreAllMocks();
});

describe("Stock Token information progressive presentation", () => {
  it("keeps exact facts visible while the control summary is still loading", async () => {
    let resolveRequest: ((response: Response) => void) | undefined;
    const request = vi.fn<BrowserFetch>(async () =>
      await new Promise<Response>((resolve) => {
        resolveRequest = resolve;
      }));

    render(
      <StockTokenInformationDialog
        presentation={{ status: "available", result: stockTokenExactResult }}
        onClose={vi.fn()}
        onRemove={vi.fn()}
        onRetry={vi.fn()}
        recoverSession={() => false}
        request={request}
      />,
    );

    expect(screen.getByRole("heading", { name: "Token facts" })).toBeTruthy();
    expect(screen.getByText("Example Stock Token")).toBeTruthy();
    expect(screen.getByText("EXT")).toBeTruthy();
    expect(screen.getByText(stockTokenAddress)).toBeTruthy();
    expect(screen.getByText("Reading control summary")).toBeTruthy();
    expect(screen.queryByText("Scam status")).toBeNull();
    expect(screen.queryByText("What this analysis cannot establish")).toBeNull();
    await waitFor(() => {
      expect(request).toHaveBeenCalledTimes(1);
    });

    resolveRequest?.(new Response(JSON.stringify(inspection), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    expect(await screen.findByText(/Exact source match/u)).toBeTruthy();
    expect(screen.getByText("Example Stock Token")).toBeTruthy();
    expect(screen.getByText(stockTokenAddress)).toBeTruthy();
    expect(screen.queryByText("Scam status")).toBeNull();
    expect(screen.queryByText("What this analysis cannot establish")).toBeNull();
  });

  it("does not erase exact facts when the control read fails", async () => {
    const request: BrowserFetch = vi.fn(async () => new Response(JSON.stringify({
      type: "about:blank",
      title: "Source inconsistent",
      status: 502,
      code: "source_inconsistent",
      detail: "Required source evidence is inconsistent.",
      retryable: false,
      issues: [],
    }), {
      status: 502,
      headers: { "Content-Type": "application/problem+json" },
    }));

    render(
      <StockTokenInformationDialog
        presentation={{ status: "available", result: stockTokenExactResult }}
        onClose={vi.fn()}
        onRemove={vi.fn()}
        onRetry={vi.fn()}
        recoverSession={() => false}
        request={request}
      />,
    );

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("Example Stock Token")).toBeTruthy();
    expect(screen.getByText(stockTokenAddress)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});
