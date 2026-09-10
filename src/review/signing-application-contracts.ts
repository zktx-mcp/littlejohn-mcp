import { z, type ZodType } from "zod";
import {
  capabilityIdSchema, defineApplicationContract, jsonObject, operationIdSchema,
  canonicalJsonStringify, captureCanonicalJson,
  type ApplicationContract, type CapabilityId,
} from "../core/client.js";
import {
  admitSigningCompletion, admitSigningOutcome, signingCommandSchema, signingCompletionSchema,
  signingDirectDecisionSchema, signingOutcomeSchema, signingResponseContext, signingReviewSchema,
  type SigningCommand, type SigningCompletion, type SigningDirectDecision, type SigningReview,
} from "./signing-contracts.js";
import { signingErrorRegistry, signingFailureCodes } from "./signing-errors.js";

type ContractDefinition<Input, Output> = ApplicationContract<Input, Record<string, never>, Output> & Readonly<{
  capabilityId: CapabilityId;
  applicationContract: ApplicationContract<Input, Record<string, never>, Output>;
}>;
const define = <Input, Output>(id: string, inputSchema: ZodType<Input>, successSchema: ZodType<Output>,
  validatePublicSuccess: (input: Input, result: Output) => void): ContractDefinition<Input, Output> => {
  const applicationContract = defineApplicationContract({ contractVersion: "1", inputSchema, successSchema,
    internalContextSchema: jsonObject({}).strict(), errorRegistry: signingErrorRegistry,
    failureCodes: signingFailureCodes, validatePublicSuccess });
  return Object.freeze({ capabilityId: capabilityIdSchema.parse(id), ...applicationContract, applicationContract });
};
const operation = jsonObject({ operationId: operationIdSchema }).strict();
const cancellation = jsonObject({ operationId: operationIdSchema, status: z.enum(["discarded", "unavailable"]) }).strict();
export const signingGetResultSchema = jsonObject({ operationId: operationIdSchema, review: signingReviewSchema.nullable() }).strict();
export const signingApplicationContracts = Object.freeze({
  start: define("signing.start_review", signingCommandSchema, signingReviewSchema, (input, review) => {
    if ((input.account.kind === "address" && input.account.address !== review.account.address) ||
        canonicalJsonStringify(captureCanonicalJson(input.payload)) !== canonicalJsonStringify(captureCanonicalJson(review.payload))) {
      throw new TypeError("Signing Review differs from its command.");
    }
  }),
  get: define("signing.get_review", operation, signingGetResultSchema, (input, result) => {
    if (input.operationId !== result.operationId || (result.review !== null && input.operationId !== result.review.operationId)) throw new TypeError("Another signing Review was returned.");
  }),
  cancel: define("signing.cancel_review", operation, cancellation, (input, result) => {
    if (input.operationId !== result.operationId) throw new TypeError("Another signing Review was discarded.");
  }),
  request: define("signing.request_signature", signingDirectDecisionSchema, signingOutcomeSchema, (input, result) => {
    admitSigningOutcome(signingResponseContext(input.review), result);
  }),
});
// Native control carries the owner-admitted private pair. The public application
// result remains the outcome above, never a projection used to reconstruct it.
export const signingRequestControlContract = define("signing.request_signature", signingDirectDecisionSchema,
  signingCompletionSchema, (input, result) => { admitSigningCompletion(signingResponseContext(input.review), result); });
export interface SigningApplicationPort {
  start(input: SigningCommand, signal: AbortSignal): Promise<SigningReview>;
  get(operationId: string): z.infer<typeof signingGetResultSchema>;
  cancel(operationId: string): z.infer<typeof cancellation>;
  confirm(input: SigningDirectDecision, signal: AbortSignal): Promise<SigningCompletion>;
}
