import { z } from "zod";
import { jsonObject, operationIdSchema, utcTimestampSchema, defineApplicationContract } from "../core/client.js";
import { requestReviewErrorRegistry } from "./request-error-registry.js";
import { exchangeCommandSchema } from "./exchange.js";
import { exchangeReviewSchema, readyExchangeReviewSchema } from "./contracts.js";
import { exchangeApplicationContracts } from "./application-contracts.js";
import { signingCommandSchema, signingReviewSchema } from "./signing-contracts.js";
import { signingApplicationContracts } from "./signing-application-contracts.js";
import { presentationSnapshotUnavailableReasons } from "../runtime/presentation-snapshot.js";

export const liveReviewPresentationInputSchema = jsonObject({ operationId: operationIdSchema }).strict();
export const requestReviewPresentationIdentity = (input: unknown): Readonly<{ operationId: string; expiresAt: string }> | null => {
  const review = z.union([exchangeReviewSchema, signingReviewSchema]).parse(input);
  if (review.state !== "ready_for_wallet_review") return null;
  return "observation" in review
    ? { operationId: review.observation.data.operationId, expiresAt: review.observation.data.actionExpiresAt }
    : { operationId: review.operationId, expiresAt: review.actionExpiresAt };
};

export const liveReviewPresentationSchema = z.union([
  jsonObject({ status: z.literal("available"), operationId: operationIdSchema, expiresAt: utcTimestampSchema,
    contractId: z.literal(exchangeApplicationContracts.start.capabilityId),
    input: exchangeCommandSchema, result: readyExchangeReviewSchema }).strict().superRefine((value, context) => {
    try {
      exchangeApplicationContracts.start.parsePublicSuccess(value.input, value.result);
      if (value.operationId === value.result.observation.data.operationId && value.expiresAt === value.result.observation.data.actionExpiresAt) return;
    } catch { /* Report the complete correlation below. */ }
    context.addIssue({ code: "custom", message: "Live presentation differs from its original decision." });
  }),
  jsonObject({ status: z.literal("available"), operationId: operationIdSchema, expiresAt: utcTimestampSchema,
    contractId: z.literal(signingApplicationContracts.start.capabilityId),
    input: signingCommandSchema, result: signingReviewSchema }).strict().superRefine((value, context) => {
    try {
      signingApplicationContracts.start.parsePublicSuccess(value.input, value.result);
      if (value.operationId === value.result.operationId && value.expiresAt === value.result.actionExpiresAt) return;
    } catch { /* Report complete correlation without raw inputs. */ }
    context.addIssue({ code: "custom", message: "Live signing presentation differs from its decision." });
  }),
  jsonObject({ status: z.literal("unavailable"), reason: z.enum(presentationSnapshotUnavailableReasons) }).strict(),
]);
export type LiveReviewPresentation = z.infer<typeof liveReviewPresentationSchema>;
export const liveReviewPresentationContract = defineApplicationContract({ contractVersion: "1",
  inputSchema: liveReviewPresentationInputSchema, successSchema: liveReviewPresentationSchema,
  internalContextSchema: jsonObject({}).strict(), errorRegistry: requestReviewErrorRegistry,
  failureCodes: requestReviewErrorRegistry.values().map((entry) => entry.code),
  validatePublicSuccess: (input, result) => {
    if (result.status === "available" && result.operationId !== input.operationId) throw new TypeError("Live presentation changed its operation.");
  },
});
export interface LiveReviewPresentationPort {
  read(operationId: string): Promise<LiveReviewPresentation>;
}
