import { afterEach, describe, expect, it, vi } from "vitest";

import type { ReferenceChartEntry } from
  "../../../src/interfaces/web/reference-chart.js";

const entries: readonly ReferenceChartEntry[] = Object.freeze([
  Object.freeze({
    kind: "candlestick",
    time: 100,
    open: 2,
    high: 4,
    low: 1,
    close: 3,
  }),
  Object.freeze({ kind: "whitespace", time: 200 }),
]);

interface ChartDouble {
  readonly addSeries: ReturnType<typeof vi.fn>;
  readonly createChart: ReturnType<typeof vi.fn>;
  readonly fitContent: ReturnType<typeof vi.fn>;
  readonly remove: ReturnType<typeof vi.fn>;
  readonly setData: ReturnType<typeof vi.fn>;
  readonly subscribe: ReturnType<typeof vi.fn>;
  readonly unsubscribe: ReturnType<typeof vi.fn>;
}

const chartDouble = (): ChartDouble => {
  const setData = vi.fn();
  const fitContent = vi.fn();
  const chart = {
    addSeries: vi.fn(() => Object.freeze({ setData })),
    createChart: vi.fn(),
    fitContent,
    remove: vi.fn(),
    setData,
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
  };
  chart.createChart.mockImplementation(() => ({
    addSeries: chart.addSeries,
    remove: chart.remove,
    subscribeCrosshairMove: chart.subscribe,
    timeScale: () => Object.freeze({ fitContent: chart.fitContent }),
    unsubscribeCrosshairMove: chart.unsubscribe,
  }));
  return Object.freeze(chart);
};

const chartContainer = (): HTMLElement => {
  const values = new Map<string, string>([
    ["--chart-background", "rgb(23, 29, 25)"],
    ["--chart-grid", "rgb(42, 51, 45)"],
    ["--chart-text", "rgb(167, 179, 170)"],
    ["--chart-axis-border", "rgb(70, 85, 75)"],
    ["--chart-crosshair", "rgb(205, 214, 207)"],
    ["--chart-rising", "rgb(115, 201, 216)"],
    ["--chart-falling", "rgb(193, 156, 222)"],
  ]);
  vi.stubGlobal("getComputedStyle", () => ({
    getPropertyValue: (name: string) => values.get(name) ?? "",
  }));
  return {} as HTMLElement;
};

const installPackageDouble = (
  chart: ChartDouble,
  onLoad: () => void,
): void => {
  vi.doMock("lightweight-charts", () => {
    onLoad();
    return {
      CandlestickSeries: Object.freeze({ kind: "candlestick" }),
      ColorType: Object.freeze({ Solid: "solid" }),
      createChart: chart.createChart,
    };
  });
};

afterEach(() => {
  vi.doUnmock("lightweight-charts");
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("Lightweight Charts adapter boundary", () => {
  it("loads only on mount, maps admitted data, filters callbacks, and destroys once", async () => {
    const chart = chartDouble();
    let packageLoads = 0;
    installPackageDouble(chart, () => { packageLoads += 1; });
    const { createLightweightChartsAdapter } = await import(
      "../../../src/interfaces/web/lightweight-charts-adapter.js"
    );
    expect(packageLoads).toBe(0);
    const port = createLightweightChartsAdapter();
    expect(packageLoads).toBe(0);

    const selected: number[] = [];
    const container = chartContainer();
    const result = await port.mount(
      container,
      entries,
      (time) => { selected.push(time); },
    );
    expect(packageLoads).toBe(1);
    expect(result.status).toBe("mounted");
    expect(chart.setData).toHaveBeenCalledWith([
      { time: 100, open: 2, high: 4, low: 1, close: 3 },
      { time: 200 },
    ]);
    expect(chart.createChart).toHaveBeenCalledWith(container, expect.anything());
    expect(chart.createChart.mock.calls[0]?.[1]).toEqual({
      autoSize: true,
      crosshair: {
        horzLine: { color: "rgb(205, 214, 207)" },
        vertLine: { color: "rgb(205, 214, 207)" },
      },
      grid: {
        horzLines: { color: "rgb(42, 51, 45)" },
        vertLines: { color: "rgb(42, 51, 45)" },
      },
      layout: {
        attributionLogo: false,
        background: {
          color: "rgb(23, 29, 25)",
          type: "solid",
        },
        textColor: "rgb(167, 179, 170)",
      },
      rightPriceScale: { borderColor: "rgb(70, 85, 75)" },
      timeScale: {
        borderColor: "rgb(70, 85, 75)",
        secondsVisible: false,
        timeVisible: true,
      },
    });
    expect(chart.addSeries).toHaveBeenCalledWith(
      { kind: "candlestick" },
      {
        borderDownColor: "rgb(193, 156, 222)",
        borderUpColor: "rgb(115, 201, 216)",
        downColor: "rgb(193, 156, 222)",
        upColor: "rgb(115, 201, 216)",
        wickDownColor: "rgb(193, 156, 222)",
        wickUpColor: "rgb(115, 201, 216)",
      },
    );
    expect(chart.fitContent).toHaveBeenCalledOnce();

    const callback = chart.subscribe.mock.calls[0]?.[0] as
      ((event: Readonly<{ time?: number }>) => void) | undefined;
    expect(callback).toBeDefined();
    callback?.({ time: 100 });
    callback?.({ time: 200 });
    callback?.({ time: 100.5 });
    callback?.({});
    expect(selected).toEqual([100, 200]);

    if (result.status !== "mounted") throw new TypeError("Expected mounted chart.");
    result.handle.destroy();
    result.handle.destroy();
    callback?.({ time: 100 });
    expect(selected).toEqual([100, 200]);
    expect(chart.unsubscribe).toHaveBeenCalledOnce();
    expect(chart.remove).toHaveBeenCalledOnce();
  });

  it("normalizes package and chart creation failures without exposing provider detail", async () => {
    vi.doMock("lightweight-charts", () => {
      throw new Error("provider detail");
    });
    const { createLightweightChartsAdapter } = await import(
      "../../../src/interfaces/web/lightweight-charts-adapter.js"
    );
    await expect(createLightweightChartsAdapter().mount(
      chartContainer(),
      entries,
      () => undefined,
    )).resolves.toEqual({ status: "unavailable" });

    vi.doUnmock("lightweight-charts");
    vi.resetModules();
    const chart = chartDouble();
    chart.addSeries.mockImplementation(() => {
      throw new Error("creation detail");
    });
    installPackageDouble(chart, () => undefined);
    const adapterModule = await import(
      "../../../src/interfaces/web/lightweight-charts-adapter.js"
    );
    await expect(adapterModule.createLightweightChartsAdapter().mount(
      chartContainer(),
      entries,
      () => undefined,
    )).resolves.toEqual({ status: "unavailable" });
    expect(chart.remove).toHaveBeenCalledOnce();
  });

  it("continues local destruction when provider cleanup methods throw", async () => {
    const chart = chartDouble();
    chart.unsubscribe.mockImplementation(() => {
      throw new Error("unsubscribe failed");
    });
    chart.remove.mockImplementation(() => {
      throw new Error("remove failed");
    });
    installPackageDouble(chart, () => undefined);
    const { createLightweightChartsAdapter } = await import(
      "../../../src/interfaces/web/lightweight-charts-adapter.js"
    );
    const result = await createLightweightChartsAdapter().mount(
      chartContainer(),
      entries,
      () => undefined,
    );
    if (result.status !== "mounted") throw new TypeError("Expected mounted chart.");
    expect(() => result.handle.destroy()).not.toThrow();
    expect(() => result.handle.destroy()).not.toThrow();
    expect(chart.unsubscribe).toHaveBeenCalledOnce();
    expect(chart.remove).toHaveBeenCalledOnce();
  });
});
