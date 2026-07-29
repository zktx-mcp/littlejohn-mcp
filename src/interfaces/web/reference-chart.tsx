export type ReferenceChartEntry =
  | Readonly<{
      kind: "whitespace";
      time: number;
    }>
  | Readonly<{
      kind: "candlestick";
      time: number;
      open: number;
      high: number;
      low: number;
      close: number;
    }>;

export interface ReferenceChartHandle {
  destroy(): void;
}

export type ReferenceChartMountResult =
  | Readonly<{ status: "unavailable" }>
  | Readonly<{
      status: "mounted";
      handle: ReferenceChartHandle;
    }>;

export interface ReferenceChartPort {
  mount(
    container: HTMLElement,
    entries: readonly ReferenceChartEntry[],
    onSelectedTime: (time: number) => void,
  ): Promise<ReferenceChartMountResult>;
}

const exactKeys = (
  value: object,
  expected: readonly string[],
): boolean => {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length &&
    actual.join("\0") === expected.join("\0");
};

const finiteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const integerNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value);

interface ReferenceChartEntryCandidate {
  readonly kind?: unknown;
  readonly time?: unknown;
  readonly open?: unknown;
  readonly high?: unknown;
  readonly low?: unknown;
  readonly close?: unknown;
}

export const parseReferenceChartEntries = (
  input: unknown,
): readonly ReferenceChartEntry[] => {
  if (!Array.isArray(input) || input.length === 0) {
    throw new TypeError("Reference chart entries are invalid.");
  }
  const entries: ReferenceChartEntry[] = [];
  let previousTime: number | undefined;
  let hasCandlestick = false;
  for (const inputEntry of input) {
    if (typeof inputEntry !== "object" || inputEntry === null || Array.isArray(inputEntry)) {
      throw new TypeError("Reference chart entry is invalid.");
    }
    const entry = inputEntry as ReferenceChartEntryCandidate;
    const time = entry.time;
    if (!integerNumber(time) || (previousTime !== undefined && time <= previousTime)) {
      throw new TypeError("Reference chart entry time is invalid.");
    }
    previousTime = time;
    if (entry.kind === "whitespace" && exactKeys(entry, ["kind", "time"])) {
      entries.push(Object.freeze({
        kind: "whitespace",
        time,
      }));
      continue;
    }
    if (
      entry.kind !== "candlestick" ||
      !exactKeys(entry, ["close", "high", "kind", "low", "open", "time"]) ||
      !finiteNumber(entry.open) ||
      !finiteNumber(entry.high) ||
      !finiteNumber(entry.low) ||
      !finiteNumber(entry.close)
    ) {
      throw new TypeError("Reference chart entry is invalid.");
    }
    hasCandlestick = true;
    entries.push(Object.freeze({
      kind: "candlestick",
      time,
      open: entry.open,
      high: entry.high,
      low: entry.low,
      close: entry.close,
    }));
  }
  if (!hasCandlestick) {
    throw new TypeError("Reference chart entries contain no candlestick.");
  }
  return Object.freeze(entries);
};
