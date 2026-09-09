import { z } from "zod";
import {
  canonicalJsonStringify, captureCanonicalJson, dynamicFeeTransactionRequestSchema,
  hash32Schema, jsonObject, fixedIdentifierSchema, utcTimestampSchema, utf8ByteLength,
  type DynamicFeeTransactionRequest,
} from "../core/client.js";
import { reviewedRequestReferenceSchema, type ReviewedRequestReference } from "../review/request-reference.js";
import { exchangeLimits } from "../review/limits.js";

export const walletTransactionInputSchema = jsonObject({
  request: dynamicFeeTransactionRequestSchema,
  reference: reviewedRequestReferenceSchema,
  sessionSourceId: fixedIdentifierSchema,
  sendExpiresAt: utcTimestampSchema,
}).strict().superRefine((value, context) => {
  if (utf8ByteLength(canonicalJsonStringify(captureCanonicalJson(value.request))) > exchangeLimits.privateRequestUtf8Bytes) {
    context.addIssue({ code: "custom", message: "Wallet transaction request exceeds its byte boundary." });
  }
});
export interface WalletTransactionInput {
  readonly request: DynamicFeeTransactionRequest;
  readonly reference: ReviewedRequestReference;
  readonly sessionSourceId: string;
  readonly sendExpiresAt: string;
}

export const walletTransactionResponseSchema = z.discriminatedUnion("status", [
  jsonObject({ status: z.literal("hash_returned"), transactionHash: hash32Schema }).strict(),
  jsonObject({ status: z.literal("wallet_rejected") }).strict(),
  jsonObject({ status: z.literal("not_sent") }).strict(),
  jsonObject({ status: z.literal("delivery_unknown"), reason: z.enum(["sdk_error", "request_expired", "invalid_response", "shutdown"]) }).strict(),
]);
export type WalletTransactionResponse = z.infer<typeof walletTransactionResponseSchema>;
export interface WalletTransactionAttempt {
  readonly response: Promise<WalletTransactionResponse>;
}
export interface WalletTransactionPort {
  hasPendingTransaction(): boolean;
  startTransaction(input: WalletTransactionInput): Promise<WalletTransactionAttempt>;
}
