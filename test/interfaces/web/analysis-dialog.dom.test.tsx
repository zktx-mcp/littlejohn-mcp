// @vitest-environment jsdom

import {
  cleanup,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AnalysisDialogContent,
  createAnalysisTarget,
} from "../../../src/interfaces/web/analysis-dialog.js";
import type {
  BrowserFetch,
} from "../../../src/interfaces/web/browser-client.js";

afterEach(() => {
  cleanup();
});

describe("Analysis dialog executable failure boundary", () => {
  it("runs the production effect and presents source inconsistency without inventing a conclusion", async () => {
    const request: BrowserFetch = vi.fn(async () => ({
      ok: false,
      status: 502,
      json: async () => ({
        type: "about:blank",
        title: "Source inconsistent",
        status: 502,
        code: "source_inconsistent",
        detail: "Required source evidence is inconsistent.",
        retryable: false,
        issues: [],
      }),
    }));

    render(
      <AnalysisDialogContent
        target={createAnalysisTarget({
          kind: "contract",
          address: "0x1111111111111111111111111111111111111111",
        })}
        recoverSession={() => false}
        request={request}
      />,
    );

    expect(screen.getByText("Reading analysis")).toBeTruthy();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "Little John could not verify the data required for analysis read, so no result was accepted.",
    );
    expect(alert.textContent).not.toContain(
      "Required source evidence is inconsistent.",
    );
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("keeps one read for an equivalent target and supersedes it only when the target changes", async () => {
    let resolveFirst:
      | ((value: Awaited<ReturnType<BrowserFetch>>) => void)
      | undefined;
    const request = vi.fn<BrowserFetch>(async (_path, init) => {
      if (resolveFirst === undefined) {
        return await new Promise<Awaited<ReturnType<BrowserFetch>>>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return {
        ok: false,
        status: 502,
        json: async () => ({
          type: "about:blank",
          title: "Source inconsistent",
          status: 502,
          code: "source_inconsistent",
          detail: "Required source evidence is inconsistent.",
          retryable: false,
          issues: [],
        }),
      };
    });
    const recoverSession = vi.fn(() => false);
    const address = "0x1111111111111111111111111111111111111111";
    const rendered = render(
      <AnalysisDialogContent
        target={createAnalysisTarget({ kind: "contract", address })}
        recoverSession={recoverSession}
        request={request}
      />,
    );

    await waitFor(() => {
      expect(request).toHaveBeenCalledTimes(1);
    });
    const firstSignal = request.mock.calls[0]?.[1]?.signal;

    rendered.rerender(
      <AnalysisDialogContent
        target={createAnalysisTarget({ kind: "contract", address })}
        recoverSession={recoverSession}
        request={request}
      />,
    );
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);
    expect(firstSignal?.aborted).toBe(false);

    rendered.rerender(
      <AnalysisDialogContent
        target={createAnalysisTarget({
          kind: "contract",
          address: "0x2222222222222222222222222222222222222222",
        })}
        recoverSession={recoverSession}
        request={request}
      />,
    );
    await waitFor(() => {
      expect(request).toHaveBeenCalledTimes(2);
    });
    expect(firstSignal?.aborted).toBe(true);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(recoverSession).toHaveBeenCalledTimes(1);

    resolveFirst?.({
      ok: false,
      status: 502,
      json: async () => ({
        type: "about:blank",
        title: "Source inconsistent",
        status: 502,
        code: "source_inconsistent",
        detail: "Required source evidence is inconsistent.",
        retryable: false,
        issues: [],
      }),
    });
  });

  it("hides a completed target in the same render that selects another target", async () => {
    const request = vi.fn<BrowserFetch>(async () => {
      if (request.mock.calls.length === 1) {
        return {
          ok: false,
          status: 502,
          json: async () => ({
            type: "about:blank",
            title: "Source inconsistent",
            status: 502,
            code: "source_inconsistent",
            detail: "Required source evidence is inconsistent.",
            retryable: false,
            issues: [],
          }),
        };
      }
      return await new Promise<Awaited<ReturnType<BrowserFetch>>>(() => undefined);
    });
    const rendered = render(
      <AnalysisDialogContent
        target={createAnalysisTarget({
          kind: "contract",
          address: "0x1111111111111111111111111111111111111111",
        })}
        recoverSession={() => false}
        request={request}
      />,
    );
    expect(await screen.findByRole("alert")).toBeTruthy();

    rendered.rerender(
      <AnalysisDialogContent
        target={createAnalysisTarget({
          kind: "contract",
          address: "0x2222222222222222222222222222222222222222",
        })}
        recoverSession={() => false}
        request={request}
      />,
    );

    expect(screen.getByText("Reading analysis")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
