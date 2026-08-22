import { z } from "zod";

import { deepFreezeValue } from "./immutability.js";

const marketTimeWindowDefinitionEntries = deepFreezeValue([
  { window: "1d", durationMilliseconds: 24 * 60 * 60 * 1_000 },
  { window: "7d", durationMilliseconds: 7 * 24 * 60 * 60 * 1_000 },
  { window: "30d", durationMilliseconds: 30 * 24 * 60 * 60 * 1_000 },
] as const);

export const marketTimeWindowSchema = z.enum(
  marketTimeWindowDefinitionEntries.map((definition) => definition.window),
);
export type MarketTimeWindow = z.infer<typeof marketTimeWindowSchema>;

export const marketTimeWindowDefinitions = deepFreezeValue(
  Object.fromEntries(marketTimeWindowDefinitionEntries.map((definition) => [
    definition.window,
    { durationMilliseconds: definition.durationMilliseconds },
  ])) as Record<MarketTimeWindow, Readonly<{ durationMilliseconds: number }>>,
);

export const maximumMarketTimeWindowMilliseconds =
  marketTimeWindowDefinitions["30d"].durationMilliseconds;
