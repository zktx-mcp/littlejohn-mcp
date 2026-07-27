import { z } from "zod";

export const supportLevelDefinitions = Object.freeze([
  "L0_discovered",
  "L1_analyzed",
  "L2_reviewed",
  "L3_executable",
  "L4_receipt_verified",
] as const);

export const supportLevelSchema = z.enum(supportLevelDefinitions);
export type SupportLevel = z.infer<typeof supportLevelSchema>;
