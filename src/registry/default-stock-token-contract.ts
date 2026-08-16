import { z } from "zod";

export const defaultStockTokenCount = 5;

export const defaultStockTokenRankSchema = z.number()
  .int()
  .min(0)
  .max(defaultStockTokenCount - 1);
