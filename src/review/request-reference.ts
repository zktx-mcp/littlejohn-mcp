import { z } from "zod";
import {
  admitDynamicFeeTransactionRequest, captureCanonicalJson, deepFreezeValue,
  dynamicFeeRequestCommitment, dynamicFeeRequestCommitmentVersion,
  evmAccountIdentitySchema, hash32Schema, jsonObject, sameEvmAccountIdentity,
} from "../core/client.js";
import { exchangeReviewSchema, type ReadyExchangeReview } from "./contracts.js";

export const reviewedRequestReferenceSchema = jsonObject({
  account: evmAccountIdentitySchema,
  encodingVersion: z.literal(dynamicFeeRequestCommitmentVersion),
  walletRequestCommitment: hash32Schema,
}).strict();
export type ReviewedRequestReference = z.infer<typeof reviewedRequestReferenceSchema>;

// This value supports later comparison. It grants no authority to send a request.
export const createReviewedRequestReference = (
  reviewInput: ReadyExchangeReview,
  requestInput: unknown,
): ReviewedRequestReference => {
  const review = exchangeReviewSchema.parse(captureCanonicalJson(reviewInput));
  if (review.state !== "ready_for_wallet_review") throw new TypeError("A ready Review is required.");
  const request = admitDynamicFeeTransactionRequest(requestInput);
  const data = review.observation.data;
  const commitment = dynamicFeeRequestCommitment(request);
  if (!sameEvmAccountIdentity(data.intent.account, { chainId: request.chainId, address: request.from }) ||
      data.walletRequestCommitment !== commitment) {
    throw new TypeError("The request differs from the confirmed Review.");
  }
  return deepFreezeValue(reviewedRequestReferenceSchema.parse({
    account: data.intent.account,
    encodingVersion: dynamicFeeRequestCommitmentVersion,
    walletRequestCommitment: commitment,
  }));
};
