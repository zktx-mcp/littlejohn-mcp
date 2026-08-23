import {
  mountTradeHistoryChart,
  type TradeHistoryChartHost,
  type MountedTradeHistoryChart,
} from "./trade-history-chart.js";
import type { RenderedPresentation } from "./renderers.js";

export interface PresentationLifecycle {
  replace(rendered: RenderedPresentation): void;
  replaceStatic(node: HTMLElement): void;
  dispose(): void;
}

export const createPresentationLifecycle = (
  root: HTMLElement,
  app: TradeHistoryChartHost,
): PresentationLifecycle => {
  let mountedChart: MountedTradeHistoryChart | undefined;
  let disposed = false;

  const disposeChart = (): void => {
    mountedChart?.dispose();
    mountedChart = undefined;
  };

  const replaceStatic = (node: HTMLElement): void => {
    if (disposed) throw new TypeError("Presentation lifecycle is disposed.");
    disposeChart();
    root.replaceChildren(node);
  };

  return Object.freeze({
    replace: (rendered: RenderedPresentation): void => {
      replaceStatic(rendered.node);
      const description = rendered.tradeHistoryChart;
      if (description === null) return;
      try {
        mountedChart = mountTradeHistoryChart(description, app);
      } catch {
        description.chartStatus.textContent =
          "Interactive chart unavailable because chart setup could not be verified. Exact values remain available in the table.";
        description.chartStatus.hidden = false;
      }
    },
    replaceStatic,
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      disposeChart();
    },
  });
};
