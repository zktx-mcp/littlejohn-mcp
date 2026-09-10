import { z } from "zod";
import {
  canonicalJsonStringify, captureCanonicalJson, dynamicFeeTransactionRequestSchema,
  hash32Schema, jsonObject, fixedIdentifierSchema, utcTimestampSchema, utf8ByteLength,
  type DynamicFeeTransactionRequest,
} from "../core/client.js";
import { reviewedRequestReferenceSchema, type ReviewedRequestReference } from "../review/request-reference.js";
import { exchangeLimits } from "../review/limits.js";
import { signingResponseContextSchema } from "../review/signing-contracts.js";
import { signingPayloadSchema, signingMethod } from "../review/signing-payload.js";
import { requestReviewLimits } from "../review/request-limits.js";
import { dataSignatureSchema } from "../intelligence/signature-contract.js";

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
export const walletSigningInputSchema = jsonObject({
  kind: z.literal("signing"), payload: signingPayloadSchema,
  context: signingResponseContextSchema, sessionSourceId: fixedIdentifierSchema,
  sendExpiresAt: utcTimestampSchema,
}).strict().superRefine((value, context) => {
  if (signingMethod(value.payload) !== value.context.method ||
      utf8ByteLength(canonicalJsonStringify(captureCanonicalJson(value))) > requestReviewLimits.reviewUtf8Bytes) {
    context.addIssue({ code: "custom", message: "The signing request differs from its method or envelope." });
  }
});
export const walletRequestInputSchema = z.discriminatedUnion("kind", [
  walletTransactionInputSchema.safeExtend({ kind: z.literal("transaction") }).strict(), walletSigningInputSchema,
]);
export type WalletRequestInput = (Readonly<{ kind: "transaction" }> & WalletTransactionInput) |
  (Omit<z.infer<typeof walletSigningInputSchema>, "sessionSourceId" | "sendExpiresAt"> &
    Readonly<{ sessionSourceId: string; sendExpiresAt: string }>);
export const walletRequestResponseSchema = z.union([
  walletTransactionResponseSchema,
  jsonObject({ status: z.literal("signature_returned"), signature: dataSignatureSchema }).strict(),
  jsonObject({ status: z.literal("unsupported_signature") }).strict(),
]);
export type WalletRequestResponse = z.infer<typeof walletRequestResponseSchema>;
export interface WalletRequestAttempt { readonly response: Promise<WalletRequestResponse> }
export interface WalletRequestPort {
  hasPendingRequest(): boolean;
  startRequest(input: WalletRequestInput): Promise<WalletRequestAttempt>;
}
