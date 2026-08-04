// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { referenceMarketManifest } from "../../../src/core/browser.js";
import { ReferenceMarketChart } from "../../../src/interfaces/web/reference-market-chart.js";
import type { ReferenceChartPort } from "../../../src/interfaces/web/reference-chart.js";
import { presentHumanFailure } from "../../../src/interfaces/web/human-failures.js";

afterEach(cleanup);

const unavailableChart: ReferenceChartPort = Object.freeze({
  mount: async () => Object.freeze({ status: "unavailable" }),
});

describe("ReferenceMarketChart recovery", () => {
  it("executes the retry exposed by an incomplete Chain response", () => {
    const onRetry = vi.fn();
    const failure = presentHumanFailure("price_history", {
      kind: "response_problem",
      problem: {
        type: "about:blank",
        title: "Chain response unavailable",
        status: 502,
        code: "chain_response_unavailable",
        detail: "A complete chain response was not obtained.",
        retryable: true,
        issues: [],
      },
    });
    render(
      <ReferenceMarketChart
        chartPort={unavailableChart}
        selectedPair={referenceMarketManifest.pairs[0]!}
        historyState={{
          status: "error",
          failure,
        }}
        onRetry={onRetry}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert").textContent).toContain(
      "a complete chain response was not obtained",
    );
  });

  it("offers restart recovery without Retry after the Chain owner closes", () => {
    const onRetry = vi.fn();
    const failure = presentHumanFailure("price_history", {
      kind: "response_problem",
      problem: {
        type: "about:blank",
        title: "Runtime state unavailable",
        status: 500,
        code: "runtime_state_unavailable",
        detail: "Runtime state is unavailable.",
        retryable: false,
        issues: [],
      },
    });
    render(
      <ReferenceMarketChart
        chartPort={unavailableChart}
        selectedPair={referenceMarketManifest.pairs[0]!}
        historyState={{ status: "error", failure }}
        onRetry={onRetry}
      />,
    );

    expect(screen.getByRole("alert").textContent).toContain(
      "Start or restart Little John, then reload this page.",
    );
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(onRetry).not.toHaveBeenCalled();
  });
});
