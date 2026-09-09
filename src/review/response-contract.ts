import { z } from "zod";
import { hash32Schema, jsonObject } from "../core/client.js";

export const exchangeWalletOutcomeSchema = z.discriminatedUnion("status", [
  jsonObject({ status: z.literal("not_sent") }).strict(),
  jsonObject({ status: z.literal("wallet_rejected") }).strict(),
  jsonObject({ status: z.literal("delivery_unknown") }).strict(),
  jsonObject({
    status: z.literal("hash_returned"), transactionHash: hash32Schema,
    recording: z.enum(["recorded", "failed"]),
    lookup: z.enum(["completed", "failed", "not_started"]),
  }).strict(),
]);
export type ExchangeWalletOutcome = z.infer<typeof exchangeWalletOutcomeSchema>;

