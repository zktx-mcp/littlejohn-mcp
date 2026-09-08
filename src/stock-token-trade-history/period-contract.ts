import { z } from "zod";

import { subtractUtcCalendarMonths } from "./calendar.js";

import {
  deepFreezeValue,
  jsonObject,
  utcTimestampSchema,
  type UtcTimestamp,
} from "../core/client.js";
export {
  selectStockTokenTradeHistoryResolution,
  stockTokenTradeHistoryNaturalPositionCount,
} from "./source-semantics.js";

const count = (maximum: number) => z.number().int().positive().max(maximum);

export const stockTokenTradeHistoryPeriodSchema = z.discriminatedUnion("unit", [
  jsonObject({ count: count(365), unit: z.literal("day") }).strict(),
  jsonObject({ count: count(52), unit: z.literal("week") }).strict(),
  jsonObject({ count: count(12), unit: z.literal("month") }).strict(),
  jsonObject({ count: z.literal(1), unit: z.literal("year") }).strict(),
]);
export type StockTokenTradeHistoryPeriod = z.infer<
  typeof stockTokenTradeHistoryPeriodSchema
>;

const defaultStockTokenTradeHistoryPeriod = deepFreezeValue({
  count: 1,
  unit: "day",
} as const) satisfies StockTokenTradeHistoryPeriod;

export const stockTokenTradeHistoryCanonicalSymbolSchema = z.string()
  .min(1).max(32).regex(/^[A-Z0-9][A-Z0-9.-]*$/u);
const requestedSymbolSchema = z.string()
  .min(1).max(32).regex(/^[A-Za-z0-9][A-Za-z0-9.-]*$/u)
  .transform((value) => value.toUpperCase())
  .pipe(stockTokenTradeHistoryCanonicalSymbolSchema);

export const stockTokenTradeHistoryInputSchema = jsonObject({
  symbol: requestedSymbolSchema,
  period: stockTokenTradeHistoryPeriodSchema.default(defaultStockTokenTradeHistoryPeriod),
}).strict();
export type StockTokenTradeHistoryInput = z.infer<typeof stockTokenTradeHistoryInputSchema>;

export const stockTokenTradeHistoryRequestedStart = (
  periodInput: StockTokenTradeHistoryPeriod,
  requestedEndInput: UtcTimestamp,
): UtcTimestamp => {
  const period = stockTokenTradeHistoryPeriodSchema.parse(periodInput);
  const requestedEnd = utcTimestampSchema.parse(requestedEndInput) as UtcTimestamp;
  if (period.unit === "month" || period.unit === "year") {
    return utcTimestampSchema.parse(subtractUtcCalendarMonths(
      requestedEnd,
      period.unit === "year" ? 12 : period.count,
    ));
  }
  const days = period.unit === "week" ? period.count * 7 : period.count;
  return utcTimestampSchema.parse(
    new Date(Date.parse(requestedEnd) - days * 86_400_000).toISOString(),
  ) as UtcTimestamp;
};
