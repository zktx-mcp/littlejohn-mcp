import { z } from "zod";
import {addressTargetSchema} from "../evm/address-target.js";
import {canonicalJsonStringify, captureCanonicalJson, deepFreezeValue, fixedIdentifierSchema, hash32Schema, jsonObject, operationIdSchema, sha256Bytes, unsignedDecimalSchema, utcTimestampSchema, utf8ByteLength} from "../core/client.js";
import {evmAccountIdentitySchema, sameEvmAccountIdentity} from "../evm/identities.js";
import {productChainId} from "../registry/client.js";
import { dataSignatureBytes, dataSignatureSchema } from "../intelligence/signature-contract.js";
import { requestReviewLimits } from "./request-limits.js";
import { requestInitiatedBySchema } from "./direct-decision.js";
import { signingMethod, signingPayloadSchema } from "./signing-payload.js";
import { walletSessionRequirements } from "../wallet/session-requirements.js";

const bounded = (value: unknown, context: z.RefinementCtx): void => {
  if (utf8ByteLength(canonicalJsonStringify(captureCanonicalJson(value))) > requestReviewLimits.reviewUtf8Bytes) {
    context.addIssue({ code: "custom", message: "The complete signing decision exceeds its input envelope." });
  }
};
export const signingCommandSchema = jsonObject({ account: addressTargetSchema, payload: signingPayloadSchema }).strict().superRefine(bounded);
export type SigningCommand = z.infer<typeof signingCommandSchema>;
export const signingMethodSchema = z.enum(walletSessionRequirements.optionalMethods);
export const signingResponseContextSchema = jsonObject({
  operationId: operationIdSchema,
  account: evmAccountIdentitySchema.refine((account) => account.chainId === productChainId),
  method: signingMethodSchema, messageHash: hash32Schema,
}).strict();
export type SigningResponseContext = z.infer<typeof signingResponseContextSchema>;
export const signingReviewSchema = signingResponseContextSchema.extend({
  contractVersion: z.literal("1"), state: z.literal("ready_for_wallet_review"),
  createdAt: utcTimestampSchema, actionExpiresAt: utcTimestampSchema,
  sessionSourceId: fixedIdentifierSchema, connectionRevision: unsignedDecimalSchema,
  payload: signingPayloadSchema,
}).strict().superRefine((value, context) => {
  bounded(value, context);
  if (signingMethod(value.payload) !== value.method || value.actionExpiresAt <= value.createdAt ||
      Date.parse(value.actionExpiresAt) - Date.parse(value.createdAt) > requestReviewLimits.reviewLifetimeMilliseconds) {
    context.addIssue({ code: "custom", message: "Signing Review method or lifetime is inconsistent." });
  }
});
export type SigningReview = z.infer<typeof signingReviewSchema>;
export const signingDirectDecisionSchema = jsonObject({ review: signingReviewSchema, initiatedBy: requestInitiatedBySchema }).strict().superRefine(bounded);
export type SigningDirectDecision = z.infer<typeof signingDirectDecisionSchema>;
export const signingResponseContext = (value: SigningReview): SigningResponseContext => deepFreezeValue(signingResponseContextSchema.parse({
  operationId: value.operationId, account: value.account, method: value.method, messageHash: value.messageHash,
}));
const base = signingResponseContextSchema.extend({ contractVersion: z.literal("1") }).strict();
const verified = base.extend({ status: z.literal("verified"), signatureDigest: z.string().regex(/^[0-9a-f]{64}$/u) }).strict();
const unavailable = base.extend({ status: z.enum([
  "verification_failed", "unsupported_signature", "wallet_rejected", "not_sent", "delivery_unknown",
]) }).strict();
export const signingOutcomeSchema = z.discriminatedUnion("status", [verified, unavailable]);
export type SigningOutcome = z.infer<typeof signingOutcomeSchema>;
export const signingCompletionSchema = z.union([
  jsonObject({ outcome: verified, signature: dataSignatureSchema }).strict(),
  jsonObject({ outcome: unavailable }).strict(),
]).superRefine((value, context) => {
  if ("signature" in value && sha256Bytes(dataSignatureBytes(value.signature)) !== value.outcome.signatureDigest) {
    context.addIssue({ code: "custom", message: "The private signature differs from the verified outcome." });
  }
});
export type SigningCompletion = z.infer<typeof signingCompletionSchema>;
export const admitSigningOutcome = (contextInput: SigningResponseContext, input: unknown): SigningOutcome => {
  const context = signingResponseContextSchema.parse(contextInput);
  const result = signingOutcomeSchema.parse(input);
  if (context.operationId !== result.operationId || !sameEvmAccountIdentity(context.account, result.account) ||
      context.method !== result.method || context.messageHash !== result.messageHash) throw new TypeError("Signing response correlation differs.");
  return deepFreezeValue(result);
};
export const admitSigningCompletion = (context: SigningResponseContext, input: unknown): SigningCompletion => {
  const completion = signingCompletionSchema.parse(input);
  admitSigningOutcome(context, completion.outcome);
  return deepFreezeValue(completion);
};
export const createSigningCompletion = (context: SigningResponseContext,
  status: SigningOutcome["status"], signature?: string): SigningCompletion => {
  const outcome = { ...context, contractVersion: "1", status,
    ...(status === "verified" && signature !== undefined ? { signatureDigest: sha256Bytes(dataSignatureBytes(signature)) } : {}),
  };
  return admitSigningCompletion(context, { outcome, ...(status === "verified" ? { signature } : {}) });
};
