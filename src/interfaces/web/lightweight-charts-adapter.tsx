import type {
  ReferenceChartEntry,
  ReferenceChartMountResult,
  ReferenceChartPort,
} from "./reference-chart.js";

type UTCTimestamp = import("lightweight-charts").UTCTimestamp;

interface ChartTheme {
  readonly axisBorder: string;
  readonly background: string;
  readonly crosshair: string;
  readonly falling: string;
  readonly grid: string;
  readonly rising: string;
  readonly text: string;
}

const readChartTheme = (container: HTMLElement): ChartTheme => {
  const style = globalThis.getComputedStyle(container);
  const read = (name: string): string => {
    const value = style.getPropertyValue(name).trim();
    if (value.length === 0) throw new TypeError(`Missing chart style: ${name}`);
    return value;
  };
  return Object.freeze({
    background: read("--chart-background"),
    grid: read("--chart-grid"),
    text: read("--chart-text"),
    axisBorder: read("--chart-axis-border"),
    crosshair: read("--chart-crosshair"),
    rising: read("--chart-rising"),
    falling: read("--chart-falling"),
  });
};

const packageData = (entries: readonly ReferenceChartEntry[]) => entries.map((entry) =>
  entry.kind === "whitespace"
    ? Object.freeze({ time: entry.time as UTCTimestamp })
    : Object.freeze({
        time: entry.time as UTCTimestamp,
        open: entry.open,
        high: entry.high,
        low: entry.low,
        close: entry.close,
      }));

export const createLightweightChartsAdapter = (): ReferenceChartPort =>
  Object.freeze({
    async mount(
      container: HTMLElement,
      entries: readonly ReferenceChartEntry[],
      onSelectedTime: (time: number) => void,
    ): Promise<ReferenceChartMountResult> {
      let chart: ReturnType<
        typeof import("lightweight-charts")["createChart"]
      > | undefined;
      let crosshairHandler:
        Parameters<NonNullable<typeof chart>["subscribeCrosshairMove"]>[0] | undefined;
      let destroyed = false;
      const cleanup = (): void => {
        if (chart === undefined) return;
        if (crosshairHandler !== undefined) {
          try {
            chart.unsubscribeCrosshairMove(crosshairHandler);
          } catch {
            // The provider cannot prevent the remaining local cleanup.
          }
        }
        try {
          chart.remove();
        } catch {
          // Provider cleanup failures have no product failure detail.
        }
      };
      try {
        const theme = readChartTheme(container);
        const packageModule = await import("lightweight-charts");
        const admittedTimes = new Set(entries.map((entry) => entry.time));
        chart = packageModule.createChart(container, {
          autoSize: true,
          layout: {
            attributionLogo: false,
            background: {
              type: packageModule.ColorType.Solid,
              color: theme.background,
            },
            textColor: theme.text,
          },
          grid: {
            vertLines: { color: theme.grid },
            horzLines: { color: theme.grid },
          },
          crosshair: {
            vertLine: { color: theme.crosshair },
            horzLine: { color: theme.crosshair },
          },
          rightPriceScale: {
            borderColor: theme.axisBorder,
          },
          timeScale: {
            borderColor: theme.axisBorder,
            timeVisible: true,
            secondsVisible: false,
          },
        });
        const series = chart.addSeries(packageModule.CandlestickSeries, {
          upColor: theme.rising,
          downColor: theme.falling,
          borderUpColor: theme.rising,
          borderDownColor: theme.falling,
          wickUpColor: theme.rising,
          wickDownColor: theme.falling,
        });
        series.setData(packageData(entries));
        crosshairHandler = (event): void => {
          if (
            destroyed ||
            typeof event.time !== "number" ||
            !Number.isInteger(event.time) ||
            !admittedTimes.has(event.time)
          ) return;
          onSelectedTime(event.time);
        };
        chart.subscribeCrosshairMove(crosshairHandler);
        chart.timeScale().fitContent();
        const mountedChart = chart;
        const mountedHandler = crosshairHandler;
        return Object.freeze({
          status: "mounted" as const,
          handle: Object.freeze({
            destroy(): void {
              if (destroyed) return;
              destroyed = true;
              try {
                mountedChart.unsubscribeCrosshairMove(mountedHandler);
              } catch {
                // The provider cannot prevent chart removal.
              }
              try {
                mountedChart.remove();
              } catch {
                // Provider cleanup failures have no product failure detail.
              }
            },
          }),
        });
      } catch {
        destroyed = true;
        cleanup();
        return Object.freeze({ status: "unavailable" as const });
      }
    },
  });
