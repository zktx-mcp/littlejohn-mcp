// @vitest-environment jsdom

import { CandlestickSeries, HistogramSeries, TickMarkType } from "lightweight-charts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createTradeHistoryChartPresentation,
  mountTradeHistoryChart,
  projectTradeHistoryChart,
  type TradeHistoryChartHost,
} from "../../../src/interfaces/mcp-app/view/trade-history-chart.js";
import {createPresentationLifecycle} from "../../../src/interfaces/mcp-app/view/presentation-lifecycle.js";
import type {RenderedPresentation} from "../../../src/interfaces/mcp-app/view/renderers.js";
import { stockTokenTradeHistoryAvailableFixture } from
  "../stock-token-trade-history-fixture.js";

const library = vi.hoisted(() => ({ createChart: vi.fn() }));

vi.mock("lightweight-charts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("lightweight-charts")>();
  return { ...actual, createChart: library.createChart };
});

const originalResizeObserver = globalThis.ResizeObserver;

const chartColor = (node: Element): string => {
  if (node.classList.contains("chart-color-surface")) return "rgb(1, 1, 1)";
  if (node.classList.contains("chart-color-text")) return "rgb(2, 2, 2)";
  if (node.classList.contains("chart-color-border")) return "rgb(3, 3, 3)";
  if (node.classList.contains("chart-color-price-up")) return "rgb(4, 4, 4)";
  if (node.classList.contains("chart-color-price-down")) return "rgb(7, 7, 7)";
  return "rgb(6, 6, 6)";
};

class TestResizeObserver implements ResizeObserver {
  disconnect(): void {}
  observe(): void {}
  unobserve(): void {}
}

const tradeHistorySeries = () => {
  const result = stockTokenTradeHistoryAvailableFixture();
  if (result.data.status !== "available") {
    throw new TypeError("Trade-history fixture is unavailable.");
  }
  return result.data;
};

const host = (openLinks: boolean, calls: string[]): TradeHistoryChartHost => ({
  getHostCapabilities: () => openLinks ? { openLinks: {} } : {},
  openLink: async ({ url }: { url: string }) => {
    calls.push(url);
    return {};
  },
});

const chartApi = () => {
  const price = { setData: vi.fn() };
  const volume = { setData: vi.fn() };
  const priceScale0 = { applyOptions: vi.fn() };
  const priceScale1 = { applyOptions: vi.fn() };
  const pane0 = { priceScale: vi.fn(() => priceScale0), setStretchFactor: vi.fn() };
  const pane1 = { priceScale: vi.fn(() => priceScale1), setStretchFactor: vi.fn() };
  const timeScale = { setVisibleLogicalRange: vi.fn() };
  const chart = {
    addSeries: vi.fn()
      .mockReturnValueOnce(price)
      .mockReturnValueOnce(volume),
    panes: vi.fn(() => [pane0, pane1]),
    timeScale: vi.fn(() => timeScale),
    remove: vi.fn(),
  };
  return { chart, price, volume, pane0, pane1, priceScale0, priceScale1, timeScale };
};

beforeEach(() => {
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: TestResizeObserver,
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockImplementation(() => ({} as CanvasRenderingContext2D));
  vi.spyOn(globalThis, "getComputedStyle")
    .mockImplementation((node) => ({ color: chartColor(node) } as CSSStyleDeclaration));
  library.createChart.mockReset();
});

afterEach(() => {
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: originalResizeObserver,
  });
  vi.restoreAllMocks();
});

describe("Stock Token trade-history chart adapter", () => {
  it("projects every fixed position onto one price and USDG-volume time axis", () => {
    const series = tradeHistorySeries();
    const projection = projectTradeHistoryChart(series);

    expect(projection.price).toHaveLength(series.positions.length);
    expect(projection.quoteVolume).toHaveLength(series.positions.length);
    expect(projection.price.map((value) => value.time))
      .toEqual(projection.quoteVolume.map((value) => value.time));
    for (const [index, position] of series.positions.entries()) {
      const price = projection.price[index];
      const volume = projection.quoteVolume[index];
      expect(price?.time).toBe(Date.parse(position.naturalStart) / 1_000);
      expect(volume?.time).toBe(price?.time);
      expect("open" in (price ?? {})).toBe(position.candle !== null);
      expect("value" in (volume ?? {})).toBe(position.candle !== null);
      expect(projection.priceDirection[index] === null).toBe(position.candle === null);
    }
    expect(projection.visibleLogicalRange.from).toBeGreaterThanOrEqual(-0.5);
    expect(projection.visibleLogicalRange.to).toBeLessThanOrEqual(series.positions.length - 0.5);
  });

  it("mounts two fixed panes, delegates link opening to the Host, and removes once", async () => {
    const api = chartApi();
    library.createChart.mockReturnValue(api.chart);
    const calls: string[] = [];
    const series = tradeHistorySeries();
    const presentation = createTradeHistoryChartPresentation(series, "Trade-history chart");
    document.body.append(presentation.node);

    expect(presentation.node.querySelector(".chart-time-range")).toBeNull();

    const mounted = mountTradeHistoryChart(presentation.mount, host(true, calls));

    expect(library.createChart).toHaveBeenCalledWith(presentation.mount.container, expect.objectContaining({
      autoSize: true,
      height: 360,
      handleScroll: false,
      handleScale: false,
      layout: expect.objectContaining({
        attributionLogo: false,
        panes: expect.objectContaining({ enableResize: false }),
      }),
    }));
    expect(api.chart.addSeries).toHaveBeenNthCalledWith(
      1,
      CandlestickSeries,
      expect.any(Object),
      0,
    );
    const priceOptions = api.chart.addSeries.mock.calls[0]?.[1];
    expect(priceOptions?.upColor).toBe("rgb(4, 4, 4)");
    expect(priceOptions?.downColor).toBe("rgb(7, 7, 7)");
    expect([priceOptions?.borderUpColor, priceOptions?.wickUpColor])
      .toEqual([priceOptions?.upColor, priceOptions?.upColor]);
    expect([priceOptions?.borderDownColor, priceOptions?.wickDownColor])
      .toEqual([priceOptions?.downColor, priceOptions?.downColor]);
    expect(api.chart.addSeries).toHaveBeenNthCalledWith(
      2,
      HistogramSeries,
      expect.any(Object),
      1,
    );
    expect(api.chart.addSeries.mock.calls[1]?.[1]?.color).toBe("rgb(4, 4, 4)");
    expect(api.price.setData.mock.calls[0]?.[0]).toHaveLength(series.positions.length);
    expect(api.volume.setData.mock.calls[0]?.[0]).toHaveLength(series.positions.length);
    const projected = projectTradeHistoryChart(series);
    const volumeData = api.volume.setData.mock.calls[0]?.[0] as readonly Readonly<{
      readonly color?: string;
    }>[];
    for (const [index, direction] of projected.priceDirection.entries()) {
      expect(volumeData[index]?.color).toBe(direction === null
        ? undefined
        : direction === "up" ? "rgb(4, 4, 4)" : "rgb(7, 7, 7)");
    }
    expect(api.pane0.priceScale).toHaveBeenCalledTimes(1);
    expect(api.pane0.priceScale).toHaveBeenCalledWith("right");
    expect(api.priceScale0.applyOptions).toHaveBeenCalledTimes(1);
    expect(api.priceScale0.applyOptions).toHaveBeenCalledWith({ entireTextOnly: true });
    expect(api.pane1.priceScale).toHaveBeenCalledTimes(1);
    expect(api.pane1.priceScale).toHaveBeenCalledWith("right");
    expect(api.priceScale1.applyOptions).toHaveBeenCalledTimes(1);
    expect(api.priceScale1.applyOptions).toHaveBeenCalledWith({ entireTextOnly: true });
    expect(api.pane0.setStretchFactor).toHaveBeenCalledWith(7);
    expect(api.pane1.setStretchFactor).toHaveBeenCalledWith(3);
    expect(api.timeScale.setVisibleLogicalRange).toHaveBeenCalledWith(
      projectTradeHistoryChart(series).visibleLogicalRange,
    );
    expect(presentation.mount.container.querySelectorAll(".chart-request-boundary"))
      .toHaveLength(2);
    expect(presentation.mount.requestStartBoundary.title)
      .toBe(`Requested start: ${series.requestedStart}`);
    expect(presentation.mount.requestEndBoundary.title)
      .toBe(`Requested end: ${series.requestedEnd}`);
    const chartOptions = library.createChart.mock.calls[0]?.[1];
    expect(chartOptions?.crosshair?.horzLine?.labelVisible).toBe(false);
    const tickMarkFormatter = chartOptions?.timeScale?.tickMarkFormatter;
    const timeFormatter = chartOptions?.localization?.timeFormatter;
    const timestamp = Date.parse("2026-08-12T13:37:23.000Z") / 1_000;
    expect(timeFormatter?.(timestamp)).toBe("2026-08-12T13:37:23.000Z");
    expect(tickMarkFormatter?.(timestamp, TickMarkType.Year, "en-US")).toBe("2026Z");
    expect(tickMarkFormatter?.(timestamp, TickMarkType.Month, "en-US")).toBe("2026-08Z");
    expect(tickMarkFormatter?.(timestamp, TickMarkType.DayOfMonth, "en-US")).toBe("08-12Z");
    expect(tickMarkFormatter?.(timestamp, TickMarkType.Time, "en-US")).toBe("13:37Z");
    expect(tickMarkFormatter?.(timestamp, TickMarkType.TimeWithSeconds, "en-US"))
      .toBe("13:37Z");
    expect([
      TickMarkType.Year,
      TickMarkType.Month,
      TickMarkType.DayOfMonth,
      TickMarkType.Time,
      TickMarkType.TimeWithSeconds,
    ].every((type) => (tickMarkFormatter?.(timestamp, type, "en-US").length ?? 9) <= 8))
      .toBe(true);
    expect(presentation.mount.openLink.disabled).toBe(false);
    expect(presentation.mount.openLink.textContent).toBe("https://www.tradingview.com/");
    expect(presentation.mount.openLink.className).toBe(
      "action secondary chart-attribution-link",
    );
    expect(presentation.mount.chartStatus.hidden).toBe(true);
    expect(presentation.mount.chartStatus.textContent).toBe("");
    expect(presentation.mount.linkStatus.hidden).toBe(true);
    expect(presentation.node.querySelector("a[href]")).toBeNull();
    expect(presentation.node.querySelector(".chart-attribution-footer")?.firstElementChild)
      .toBe(presentation.node.querySelector(".chart-attribution"));
    expect(presentation.node.querySelector(".chart-attribution")?.textContent).toBe(
      "TradingView Lightweight Charts™\n" +
      "Copyright (с) 2025 TradingView, Inc. https://www.tradingview.com/",
    );

    presentation.mount.openLink.click();
    await Promise.resolve();
    expect(calls).toEqual(["https://www.tradingview.com/"]);
    expect(presentation.mount.linkStatus.hidden).toBe(false);

    mounted.dispose();
    mounted.dispose();
    presentation.mount.openLink.click();
    expect(api.chart.remove).toHaveBeenCalledTimes(1);
    expect(presentation.mount.container.querySelector(".chart-request-boundary")).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("keeps semantic content when chart construction fails", () => {
    const api = chartApi();
    api.chart.addSeries.mockReset()
      .mockReturnValueOnce(api.price)
      .mockImplementationOnce(() => { throw new TypeError("Pane failed."); });
    library.createChart.mockReturnValue(api.chart);
    const presentation = createTradeHistoryChartPresentation(tradeHistorySeries(), "Trade-history chart");
    document.body.append(presentation.node);

    const mounted = mountTradeHistoryChart(presentation.mount, host(false, []));

    expect(presentation.node.textContent).toContain(
      "Interactive chart unavailable because chart setup could not be completed",
    );
    expect(presentation.mount.chartStatus.hidden).toBe(false);
    expect(presentation.node.textContent).toContain("TradingView Lightweight Charts™");
    expect(api.chart.remove).toHaveBeenCalledTimes(1);
    mounted.dispose();
    expect(api.chart.remove).toHaveBeenCalledTimes(1);
  });

  it("does not claim a chart when the Host lacks required resize behavior", () => {
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: undefined,
    });
    const presentation = createTradeHistoryChartPresentation(tradeHistorySeries(), "Trade-history chart");
    document.body.append(presentation.node);

    const mounted = mountTradeHistoryChart(presentation.mount, host(false, []));

    expect(library.createChart).not.toHaveBeenCalled();
    expect(presentation.mount.chartStatus.textContent).toContain(
      "Canvas and ResizeObserver are required",
    );
    expect(presentation.mount.chartStatus.hidden).toBe(false);
    expect(presentation.mount.openLink.disabled).toBe(true);
    expect(presentation.mount.linkStatus.textContent).toBe("");
    expect(presentation.mount.linkStatus.hidden).toBe(true);
    mounted.dispose();
  });

  it("does not construct a chart when Canvas has no usable two-dimensional context", () => {
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null);
    const presentation = createTradeHistoryChartPresentation(tradeHistorySeries(), "Trade-history chart");
    document.body.append(presentation.node);

    const mounted = mountTradeHistoryChart(presentation.mount, host(false, []));

    expect(library.createChart).not.toHaveBeenCalled();
    expect(presentation.mount.chartStatus.textContent).toContain(
      "Canvas and ResizeObserver are required",
    );
    mounted.dispose();
  });

  it("does not construct a chart when resize observation is present but unusable", () => {
    let disconnects = 0;
    class BrokenResizeObserver implements ResizeObserver {
      disconnect(): void { disconnects += 1; }
      observe(): void { throw new TypeError("Resize observation failed."); }
      unobserve(): void {}
    }
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: BrokenResizeObserver,
    });
    const presentation = createTradeHistoryChartPresentation(tradeHistorySeries(), "Trade-history chart");
    document.body.append(presentation.node);

    const mounted = mountTradeHistoryChart(presentation.mount, host(false, []));

    expect(library.createChart).not.toHaveBeenCalled();
    expect(disconnects).toBe(1);
    expect(presentation.mount.chartStatus.textContent).toContain(
      "Canvas and ResizeObserver are required",
    );
    mounted.dispose();
  });

  it("does not construct a chart without resolved visual tokens", () => {
    vi.mocked(globalThis.getComputedStyle)
      .mockImplementation(() => ({ color: "" } as CSSStyleDeclaration));
    const presentation = createTradeHistoryChartPresentation(tradeHistorySeries(), "Trade-history chart");
    document.body.append(presentation.node);

    const mounted = mountTradeHistoryChart(presentation.mount, host(false, []));

    expect(library.createChart).not.toHaveBeenCalled();
    expect(presentation.mount.chartStatus.textContent).toContain(
      "chart setup could not be completed",
    );
    expect(presentation.mount.container.querySelector(".chart-color-probe")).toBeNull();
    mounted.dispose();
  });

  it("keeps a neutral semantic fallback when the exact projection is invalid", () => {
    const series = tradeHistorySeries();
    const invalidSeries = {
      ...series,
      requestedStart: series.positions[0]?.naturalEnd ?? series.requestedEnd,
    };
    const presentation = createTradeHistoryChartPresentation(invalidSeries, "Trade-history chart");
    const root = document.createElement("main");
    const lifecycle = createPresentationLifecycle(root, host(false, []));

    lifecycle.replace(Object.freeze({
      node: presentation.node,
      tradeHistoryChart: presentation.mount,
    }));

    expect(library.createChart).not.toHaveBeenCalled();
    expect(presentation.mount.chartStatus.textContent).toContain(
      "chart setup could not be verified",
    );
    expect(presentation.mount.chartStatus.textContent).not.toContain("Host");
    expect(presentation.mount.chartStatus.hidden).toBe(false);
    lifecycle.dispose();
  });

  it("disposes the mounted chart before replacing or tearing down the presentation", () => {
    const firstApi = chartApi();
    const secondApi = chartApi();
    library.createChart
      .mockReturnValueOnce(firstApi.chart)
      .mockReturnValueOnce(secondApi.chart);
    const root = document.createElement("main");
    const first = createTradeHistoryChartPresentation(tradeHistorySeries(), "First");
    const second = createTradeHistoryChartPresentation(tradeHistorySeries(), "Second");
    const lifecycle = createPresentationLifecycle(root, host(false, []));
    const rendered = (
      node: HTMLElement,
      mount: NonNullable<RenderedPresentation["tradeHistoryChart"]>,
    ): RenderedPresentation => Object.freeze({ node, tradeHistoryChart: mount });

    lifecycle.replace(rendered(first.node, first.mount));
    lifecycle.replace(rendered(second.node, second.mount));
    expect(firstApi.chart.remove).toHaveBeenCalledTimes(1);
    expect(root.firstElementChild).toBe(second.node);

    lifecycle.dispose();
    lifecycle.dispose();
    expect(secondApi.chart.remove).toHaveBeenCalledTimes(1);
  });
});
