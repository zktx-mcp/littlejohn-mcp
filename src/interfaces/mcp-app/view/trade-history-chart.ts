import {
  CandlestickSeries,
  ColorType,
  HistogramSeries,
  createChart,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type BarPrice,
  TickMarkType,
  type Time,
  type UTCTimestamp,
  type WhitespaceData,
} from "lightweight-charts";

import type {StockTokenTradeHistoryAvailableData} from "../../../stock-token-trade-history/result.js";

export const tradingViewUrl = "https://www.tradingview.com/";
const tradingViewProductNotice = "TradingView Lightweight Charts™";
const tradingViewCopyrightNotice = "Copyright (с) 2025 TradingView, Inc.";
type TradeHistoryPriceData = CandlestickData<UTCTimestamp> | WhitespaceData<UTCTimestamp>;
type TradeHistoryVolumeData = HistogramData<UTCTimestamp> | WhitespaceData<UTCTimestamp>;

export interface TradeHistoryChartProjection {
  readonly price: readonly TradeHistoryPriceData[];
  readonly quoteVolume: readonly TradeHistoryVolumeData[];
  readonly priceDirection: readonly ("up" | "down" | null)[];
  readonly visibleLogicalRange: Readonly<{ from: number; to: number }>;
}

export interface TradeHistoryChartMountDescription {
  readonly container: HTMLElement;
  readonly requestStartBoundary: HTMLElement;
  readonly requestEndBoundary: HTMLElement;
  readonly chartStatus: HTMLElement;
  readonly openLink: HTMLButtonElement;
  readonly linkStatus: HTMLElement;
  readonly series: StockTokenTradeHistoryAvailableData;
}

export interface TradeHistoryChartPresentation {
  readonly node: HTMLElement;
  readonly mount: TradeHistoryChartMountDescription;
}

export interface MountedTradeHistoryChart {
  dispose(): void;
}

export interface TradeHistoryChartHost {
  getHostCapabilities(): Readonly<{ openLinks?: Readonly<Record<string, never>> }> | undefined;
  openLink(
    params: Readonly<{ url: string }>,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<Readonly<{ isError?: boolean | undefined; [key: string]: unknown }>>;
}

const element = <Tag extends keyof HTMLElementTagNameMap>(
  tag: Tag,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[Tag] => {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const unixSeconds = (value: string): UTCTimestamp => {
  const milliseconds = Date.parse(value);
  const seconds = milliseconds / 1_000;
  if (!Number.isSafeInteger(seconds)) throw new TypeError("Chart time is invalid.");
  return seconds as UTCTimestamp;
};

const approximateRational = (value: Readonly<{
  numerator: string;
  denominator: string;
}>): number => {
  const denominator = Number(value.denominator);
  const result = Number(value.numerator) / denominator;
  if (!Number.isFinite(result) || denominator <= 0) {
    throw new TypeError("Chart rational value cannot be represented by Canvas.");
  }
  return result;
};

const approximateRawUnits = (raw: string, decimals: number): number => {
  const result = Number(raw) / 10 ** decimals;
  if (!Number.isFinite(result)) {
    throw new TypeError("Chart volume cannot be represented by Canvas.");
  }
  return result;
};

const priceDirection = (value: NonNullable<
  StockTokenTradeHistoryAvailableData["positions"][number]["candle"]
>): "up" | "down" => {
  const close = BigInt(value.close.numerator) * BigInt(value.open.denominator);
  const open = BigInt(value.open.numerator) * BigInt(value.close.denominator);
  return close >= open ? "up" : "down";
};

export const projectTradeHistoryChart = (
  series: StockTokenTradeHistoryAvailableData,
): TradeHistoryChartProjection => {
  const positions = series.positions;
  const first = positions[0];
  const last = positions.at(-1);
  if (first === undefined || last === undefined) {
    throw new TypeError("Trade-history chart positions are unavailable.");
  }
  const intervalDuration = Date.parse(first.naturalEnd) - Date.parse(first.naturalStart);
  if (!Number.isSafeInteger(intervalDuration) || intervalDuration <= 0) {
    throw new TypeError("Trade-history chart interval is invalid.");
  }
  const leadingFraction = (
    Date.parse(series.requestedStart) - Date.parse(first.naturalStart)
  ) / intervalDuration;
  const trailingFraction = (
    Date.parse(series.requestedEnd) - Date.parse(last.naturalStart)
  ) / intervalDuration;
  if (
    !Number.isFinite(leadingFraction) || !Number.isFinite(trailingFraction) ||
    leadingFraction < 0 || leadingFraction >= 1 ||
    trailingFraction <= 0 || trailingFraction > 1
  ) throw new TypeError("Trade-history chart represented range is invalid.");

  const price: TradeHistoryPriceData[] = [];
  const quoteVolume: TradeHistoryVolumeData[] = [];
  const directions: ("up" | "down" | null)[] = [];
  let previousTime: number | undefined;
  for (const position of positions) {
    const time = unixSeconds(position.naturalStart);
    if (previousTime !== undefined && time <= previousTime) {
      throw new TypeError("Trade-history chart positions are not strictly ordered.");
    }
    previousTime = time;
    if (position.candle === null) {
      price.push(Object.freeze({ time }));
      quoteVolume.push(Object.freeze({ time }));
      directions.push(null);
      continue;
    }
    price.push(Object.freeze({
      time,
      open: approximateRational(position.candle.open),
      high: approximateRational(position.candle.high),
      low: approximateRational(position.candle.low),
      close: approximateRational(position.candle.close),
    }));
    quoteVolume.push(Object.freeze({
      time,
      value: approximateRawUnits(
        position.candle.quoteVolumeRaw,
        series.archive.root.usdgDecimals,
      ),
    }));
    directions.push(priceDirection(position.candle));
  }
  if (
    price.length !== positions.length || quoteVolume.length !== positions.length ||
    directions.length !== positions.length ||
    price.some((value, index) => value.time !== quoteVolume[index]?.time)
  ) throw new TypeError("Trade-history chart series do not share one time axis.");

  return Object.freeze({
    price: Object.freeze(price),
    quoteVolume: Object.freeze(quoteVolume),
    priceDirection: Object.freeze(directions),
    visibleLogicalRange: Object.freeze({
      from: -0.5 + leadingFraction,
      to: positions.length - 1 - 0.5 + trailingFraction,
    }),
  });
};

export const createTradeHistoryChartPresentation = (
  series: StockTokenTradeHistoryAvailableData,
  label: string,
): TradeHistoryChartPresentation => {
  const figure = element("figure", "trade-history-chart-figure");
  const container = element("div", "trade-history-chart");
  container.setAttribute("role", "img");
  container.setAttribute(
    "aria-label",
    `${label}. Price candles above and USDG quote volume below share the requested time range from ${series.requestedStart} inclusive to ${series.requestedEnd} exclusive. Dashed vertical boundaries mark those exact bounds. Partial candles remain complete stored natural intervals and may include activity outside represented request bounds. Exact values and gaps are available in Developer details.`,
  );
  const requestStartBoundary = element("span", "chart-request-boundary chart-request-start");
  requestStartBoundary.setAttribute("aria-hidden", "true");
  requestStartBoundary.title = `Requested start: ${series.requestedStart}`;
  const requestEndBoundary = element("span", "chart-request-boundary chart-request-end");
  requestEndBoundary.setAttribute("aria-hidden", "true");
  requestEndBoundary.title = `Requested end: ${series.requestedEnd}`;
  const chartStatus = element("p", "chart-status", "");
  chartStatus.setAttribute("role", "status");
  chartStatus.hidden = true;
  const openLink = element("button", "action secondary chart-attribution-link", tradingViewUrl);
  openLink.type = "button";
  openLink.disabled = true;
  openLink.setAttribute("aria-label", `Open ${tradingViewUrl}`);
  const notice = element("p", "chart-attribution");
  notice.append(
    document.createTextNode(`${tradingViewProductNotice}\n${tradingViewCopyrightNotice} `),
    openLink,
  );
  const attribution = element("footer", "chart-attribution-footer");
  attribution.append(notice);
  const linkStatus = element(
    "p",
    "chart-link-status",
    "",
  );
  linkStatus.setAttribute("role", "status");
  linkStatus.hidden = true;
  figure.append(container, attribution, chartStatus, linkStatus);
  return Object.freeze({
    node: figure,
    mount: Object.freeze({
      container,
      requestStartBoundary,
      requestEndBoundary,
      chartStatus,
      openLink,
      linkStatus,
      series,
    }),
  });
};

const resolvedColor = (
  container: HTMLElement,
  className: string,
): string => {
  const probe = element("span", `chart-color-probe ${className}`);
  container.append(probe);
  try {
    const color = getComputedStyle(probe).color;
    if (color === "") throw new TypeError("Chart visual token is unavailable.");
    return color;
  } finally {
    probe.remove();
  }
};

const supportsChartRendering = (): boolean => {
  if (
    typeof HTMLCanvasElement === "undefined" ||
    typeof HTMLCanvasElement.prototype.getContext !== "function" ||
    typeof ResizeObserver === "undefined"
  ) return false;

  try {
    if (document.createElement("canvas").getContext("2d") === null) return false;
  } catch {
    return false;
  }

  let observer: ResizeObserver | undefined;
  let supported = false;
  try {
    observer = new ResizeObserver(() => {});
    observer.observe(document.createElement("div"), { box: "border-box" });
    supported = true;
  } catch {
    supported = false;
  }
  try {
    observer?.disconnect();
  } catch {
    supported = false;
  }
  return supported;
};

const priceLabel = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 5,
  minimumFractionDigits: 0,
});
const volumeLabel = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 2,
});

const utcTimeLabel = (time: Time): string => {
  if (typeof time !== "number") throw new TypeError("Trade-history chart time is not a timestamp.");
  return new Date(time * 1_000).toISOString();
};

const utcTickLabel = (time: Time, tickMarkType: TickMarkType): string => {
  if (typeof time !== "number") throw new TypeError("Trade-history chart time is not a timestamp.");
  const timestamp = new Date(time * 1_000);
  const year = String(timestamp.getUTCFullYear()).padStart(4, "0");
  const month = String(timestamp.getUTCMonth() + 1).padStart(2, "0");
  const day = String(timestamp.getUTCDate()).padStart(2, "0");
  const hour = String(timestamp.getUTCHours()).padStart(2, "0");
  const minute = String(timestamp.getUTCMinutes()).padStart(2, "0");
  switch (tickMarkType) {
    case TickMarkType.Year:
      return `${year}Z`;
    case TickMarkType.Month:
      return `${year}-${month}Z`;
    case TickMarkType.DayOfMonth:
      return `${month}-${day}Z`;
    case TickMarkType.Time:
    case TickMarkType.TimeWithSeconds:
      return `${hour}:${minute}Z`;
  }
};

const removeChartOnce = (state: { chart?: IChartApi; removed: boolean }): void => {
  if (state.removed || state.chart === undefined) return;
  state.removed = true;
  state.chart.remove();
};

export const mountTradeHistoryChart = (
  description: TradeHistoryChartMountDescription,
  app: TradeHistoryChartHost,
): MountedTradeHistoryChart => {
  const linkController = new AbortController();
  const chartState: { chart?: IChartApi; removed: boolean } = { removed: false };
  let disposed = false;
  const showChartStatus = (message: string): void => {
    description.chartStatus.textContent = message;
    description.chartStatus.hidden = false;
  };
  const showLinkStatus = (message: string): void => {
    description.linkStatus.textContent = message;
    description.linkStatus.hidden = false;
  };
  const openTradingView = (): void => {
    if (disposed || linkController.signal.aborted) return;
    description.openLink.disabled = true;
    showLinkStatus("Waiting for the Host to open TradingView.");
    void app.openLink({ url: tradingViewUrl }, { signal: linkController.signal })
      .then((result) => {
        if (disposed) return;
        showLinkStatus(result.isError === true
          ? `The Host did not open the link. Use the visible URL: ${tradingViewUrl}`
          : "The Host accepted the TradingView link request.");
      })
      .catch(() => {
        if (disposed || linkController.signal.aborted) return;
        showLinkStatus(`The Host could not open the link. Use the visible URL: ${tradingViewUrl}`);
      })
      .finally(() => {
        if (!disposed) description.openLink.disabled = false;
      });
  };

  const projection = supportsChartRendering()
    ? projectTradeHistoryChart(description.series)
    : null;
  let canOpenLinks = false;
  try {
    canOpenLinks = app.getHostCapabilities()?.openLinks !== undefined;
  } catch {
    showLinkStatus(
      `The Host link capability could not be verified. Use the visible URL: ${tradingViewUrl}`,
    );
  }
  if (canOpenLinks) {
    description.openLink.disabled = false;
    description.openLink.addEventListener("click", openTradingView);
  }

  if (projection === null) {
    showChartStatus(
      "Interactive chart unavailable: Canvas and ResizeObserver are required. Exact values remain available in the table.",
    );
  } else {
    try {
      const background = resolvedColor(description.container, "chart-color-surface");
      const text = resolvedColor(description.container, "chart-color-text");
      const border = resolvedColor(description.container, "chart-color-border");
      const priceUpColor = resolvedColor(description.container, "chart-color-price-up");
      const priceDownColor = resolvedColor(description.container, "chart-color-price-down");
      const chart = createChart(description.container, {
        autoSize: true,
        height: 360,
        layout: {
          attributionLogo: false,
          background: { type: ColorType.Solid, color: background },
          textColor: text,
          panes: {
            enableResize: false,
            separatorColor: border,
            separatorHoverColor: border,
          },
        },
        grid: {
          vertLines: { color: border },
          horzLines: { color: border },
        },
        handleScroll: false,
        handleScale: false,
        crosshair: {
          horzLine: { labelVisible: false },
        },
        localization: {
          locale: "en-US",
          timeFormatter: utcTimeLabel,
        },
        timeScale: {
          timeVisible: true,
          secondsVisible: false,
          tickMarkFormatter: utcTickLabel,
        },
      });
      chartState.chart = chart;
      const price = chart.addSeries(CandlestickSeries, {
        upColor: priceUpColor,
        downColor: priceDownColor,
        borderUpColor: priceUpColor,
        borderDownColor: priceDownColor,
        wickUpColor: priceUpColor,
        wickDownColor: priceDownColor,
        priceLineVisible: false,
        lastValueVisible: false,
        priceFormat: {
          type: "custom",
          minMove: 0.00000001,
          formatter: (value: BarPrice) => priceLabel.format(value),
        },
      }, 0);
      const quoteVolume = chart.addSeries(HistogramSeries, {
        color: priceUpColor,
        base: 0,
        priceLineVisible: false,
        lastValueVisible: false,
        priceFormat: {
          type: "custom",
          minMove: 0.00000001,
          formatter: (value: BarPrice) => volumeLabel.format(value),
        },
      }, 1);
      price.setData([...projection.price]);
      quoteVolume.setData(projection.quoteVolume.map((value, index) => {
        if (!("value" in value)) return value;
        const direction = projection.priceDirection[index];
        if (direction === null || direction === undefined) {
          throw new TypeError("Trade-history chart volume direction is unavailable.");
        }
        return Object.freeze({
          ...value,
          color: direction === "up" ? priceUpColor : priceDownColor,
        });
      }));
      const panes = chart.panes();
      if (panes.length !== 2 || panes[0] === undefined || panes[1] === undefined) {
        throw new TypeError("Trade-history chart pane layout is unavailable.");
      }
      for (const pane of panes) {
        pane.priceScale("right").applyOptions({ entireTextOnly: true });
      }
      panes[0].setStretchFactor(7);
      panes[1].setStretchFactor(3);
      chart.timeScale().setVisibleLogicalRange(projection.visibleLogicalRange);
      description.container.append(
        description.requestStartBoundary,
        description.requestEndBoundary,
      );
      description.chartStatus.textContent = "";
      description.chartStatus.hidden = true;
    } catch {
      description.requestStartBoundary.remove();
      description.requestEndBoundary.remove();
      removeChartOnce(chartState);
      showChartStatus(
        "Interactive chart unavailable because chart setup could not be completed. Exact values remain available in the table.",
      );
    }
  }

  return Object.freeze({
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      linkController.abort();
      description.openLink.removeEventListener("click", openTradingView);
      description.openLink.disabled = true;
      description.requestStartBoundary.remove();
      description.requestEndBoundary.remove();
      removeChartOnce(chartState);
    },
  });
};
