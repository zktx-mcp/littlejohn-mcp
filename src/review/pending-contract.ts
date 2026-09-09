import { z } from "zod";
import { hash32Schema, jsonObject, uint256DecimalSchema } from "../core/client.js";
import { feeCapsSchema } from "./exchange.js";

export const pendingReplacementSchema = jsonObject({
  transactionHash: hash32Schema, walletRequestCommitment: hash32Schema,
  nonce: uint256DecimalSchema, gasLimit: uint256DecimalSchema,
  fees: feeCapsSchema,
}).strict();
export type PendingReplacement = z.infer<typeof pendingReplacementSchema>;

