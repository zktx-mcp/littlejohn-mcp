import { z } from "zod";
import {
  applicationFailureSchemaFor, canonicalJsonStringify, captureCanonicalJson,
  deepFreezeValue, jsonObject, operationIdSchema, utcTimestampSchema, utf8ByteLength,
} from "../core/client.js";
import { describeUniswapV4ExpectedEffect, uniswapV4ExpectedEffectSchema } from "../protocols/uniswap-v4/effects.js";
import { exchangeCommandSchema } from "./exchange.js";
import { exchangeErrorRegistry, exchangeFailureCodes } from "./errors.js";
import { requestReviewLimits } from "./request-limits.js";
import { requestInitiatedBySchema } from "./direct-decision.js";
import { exchangeObservationResultSchema, type ExchangeObservationResult } from "./observation-contract.js";

const failure = applicationFailureSchemaFor(exchangeErrorRegistry, exchangeFailureCodes);
export const readyExchangeReviewSchema = jsonObject({
  state: z.literal("ready_for_wallet_review"),
  observation: exchangeObservationResultSchema,
  expectedEffect: uniswapV4ExpectedEffectSchema,
}).strict().superRefine((value, context) => {
  const data = value.observation.data;
  const expected = "replacement" in data ? data.conditions : describeUniswapV4ExpectedEffect(data.intent, data.kind);
  if (canonicalJsonStringify(captureCanonicalJson(value.expectedEffect)) !== canonicalJsonStringify(captureCanonicalJson(expected))) {
    context.addIssue({ code: "custom", message: "Review effects differ from the committed native transaction." });
  }
});
export type ReadyExchangeReview = z.infer<typeof readyExchangeReviewSchema>;

export const exchangeReviewSchema = z.discriminatedUnion("state", [
  readyExchangeReviewSchema,
  jsonObject({
    state: z.literal("blocked"), operationId: operationIdSchema,
    createdAt: utcTimestampSchema, request: exchangeCommandSchema, failure,
  }).strict(),
  jsonObject({
    state: z.literal("refresh_required"), operationId: operationIdSchema, failure,
  }).strict(),
]).superRefine((value, context) => {
  if (utf8ByteLength(canonicalJsonStringify(captureCanonicalJson(value))) > requestReviewLimits.reviewUtf8Bytes) {
    context.addIssue({ code: "custom", message: "The complete exchange Review exceeds its byte limit." });
  }
});
export type ExchangeReview = z.infer<typeof exchangeReviewSchema>;

export const createReadyExchangeReview = (observation: ExchangeObservationResult): ReadyExchangeReview => {
  const review = exchangeReviewSchema.parse({
    state: "ready_for_wallet_review", observation,
    expectedEffect: "replacement" in observation.data ? observation.data.conditions : describeUniswapV4ExpectedEffect(observation.data.intent, observation.data.kind),
  });
  if (review.state !== "ready_for_wallet_review") throw new TypeError("Ready Review construction failed.");
  exchangeDirectDecisionSchema.parse({ review, initiatedBy: "mcp_app" });
  return deepFreezeValue(review);
};

export const exchangeDirectDecisionSchema = jsonObject({
  review: readyExchangeReviewSchema,
  initiatedBy: requestInitiatedBySchema,
}).strict().superRefine((value, context) => {
  if (utf8ByteLength(canonicalJsonStringify(captureCanonicalJson(value))) > requestReviewLimits.reviewUtf8Bytes) {
    context.addIssue({ code: "custom", message: "The complete exchange direct decision exceeds its byte limit." });
  }
});
export type ExchangeDirectDecision = z.infer<typeof exchangeDirectDecisionSchema>;
