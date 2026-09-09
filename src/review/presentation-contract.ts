import { z } from "zod";
import { jsonObject, operationIdSchema, utcTimestampSchema, canonicalJsonStringify, captureCanonicalJson } from "../core/client.js";
import { exchangeCommandSchema } from "./exchange.js";
import { readyExchangeReviewSchema } from "./contracts.js";
import { exchangeApplicationContracts } from "./application-contracts.js";
import { presentationSnapshotUnavailableReasons } from "../runtime/presentation-snapshot.js";

export const liveReviewPresentationInputSchema = jsonObject({ operationId: operationIdSchema }).strict();
export const liveReviewPresentationSchema = z.discriminatedUnion("status", [
  jsonObject({ status: z.literal("available"), operationId: operationIdSchema, expiresAt: utcTimestampSchema,
    input: exchangeCommandSchema, result: readyExchangeReviewSchema }).strict().superRefine((value, context) => {
    try {
      exchangeApplicationContracts.start.parsePublicSuccess(value.input, value.result);
      if (value.operationId === value.result.observation.data.operationId && value.expiresAt === value.result.observation.data.actionExpiresAt) return;
    } catch { /* Report the complete correlation below. */ }
    context.addIssue({ code: "custom", message: "Live presentation differs from its original decision." });
  }),
  jsonObject({ status: z.literal("unavailable"), reason: z.enum(presentationSnapshotUnavailableReasons) }).strict(),
]);
export type LiveReviewPresentation = z.infer<typeof liveReviewPresentationSchema>;
export interface LiveReviewPresentationPort {
  read(operationId: string): Promise<LiveReviewPresentation>;
}
