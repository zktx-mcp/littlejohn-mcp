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

afterEach(cleanup);

const unavailableChart: ReferenceChartPort = Object.freeze({
  mount: async () => Object.freeze({ status: "unavailable" }),
});

describe("ReferenceMarketChart recovery", () => {
  it("executes the retry exposed by a retryable history request failure", () => {
    const onRetry = vi.fn();
    render(
      <ReferenceMarketChart
        chartPort={unavailableChart}
        selectedPair={referenceMarketManifest.pairs[0]!}
        historyState={{
          status: "error",
          failure: {
            summary: "Price history did not finish.",
            recovery: "Try again.",
            retryable: true,
            fields: [],
            code: "response_timeout",
          },
        }}
        onRetry={onRetry}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
