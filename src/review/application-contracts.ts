import type { ApplicationContract, CapabilityId } from "../core/client.js";
import { z, type ZodType } from "zod";
import {
  capabilityIdSchema, defineApplicationContract, captureCanonicalJson, canonicalJsonStringify,
  jsonObject, operationIdSchema, parseCapabilitySuccess,
} from "../core/client.js";
import { exchangeCommandSchema } from "./exchange.js";
import { exchangeDirectDecisionSchema, exchangeReviewSchema, readyExchangeReviewSchema } from "./contracts.js";
import { exchangeWalletOutcomeSchema } from "./response-contract.js";
import { exchangeErrorRegistry, exchangeFailureCodes } from "./errors.js";
import { exchangeObservationCapability } from "./observation-contract.js";

type ContractDefinition<Input, Output> = ApplicationContract<Input, Record<string, never>, Output> & Readonly<{
  capabilityId: CapabilityId;
  applicationContract: ApplicationContract<Input, Record<string, never>, Output>;
}>;

const define = <Input, Output>(capabilityId: string, inputSchema: ZodType<Input>, successSchema: ZodType<Output>,
  validatePublicSuccess: (input: Input, output: Output) => void): ContractDefinition<Input, Output> => {
  const applicationContract = defineApplicationContract({ contractVersion: "1", inputSchema, successSchema,
    internalContextSchema: jsonObject({}).strict(), errorRegistry: exchangeErrorRegistry,
    failureCodes: exchangeFailureCodes, validatePublicSuccess });
  return Object.freeze({ capabilityId: capabilityIdSchema.parse(capabilityId), ...applicationContract, applicationContract });
};
const operation = jsonObject({ operationId: operationIdSchema }).strict();
export const exchangeConfirmationResultSchema = z.discriminatedUnion("kind", [
  jsonObject({ kind: z.literal("review"), review: exchangeReviewSchema }).strict(),
  jsonObject({ kind: z.literal("wallet_result"), outcome: exchangeWalletOutcomeSchema }).strict(),
]);
export const exchangeCancellationResultSchema = jsonObject({ operationId: operationIdSchema,
  status: z.enum(["discarded", "unavailable"]) }).strict();

export const admitExchangeConfirmationResult = (operationId: string, value: unknown) => {
  const result = exchangeConfirmationResultSchema.parse(value);
  if (result.kind === "review" && (result.review.state === "ready_for_wallet_review" ||
      result.review.operationId !== operationIdSchema.parse(operationId))) throw new TypeError("The confirmation returned another Review.");
  return result;
};

export const exchangeApplicationContracts = Object.freeze({
  start: define("exchange.start_review", exchangeCommandSchema, exchangeReviewSchema, (input, value) => {
    if (value.state === "ready_for_wallet_review") {
      const data = value.observation.data;
      parseCapabilitySuccess(exchangeObservationCapability, { request: input, operationId: data.operationId,
        createdAt: data.createdAt, actionExpiresAt: data.actionExpiresAt }, value.observation);
    } else if (value.state !== "blocked" || canonicalJsonStringify(captureCanonicalJson(input)) !== canonicalJsonStringify(captureCanonicalJson(value.request))) {
      throw new TypeError("The Review does not belong to its original command.");
    }
  }),
  get: define("exchange.get_review", operation, readyExchangeReviewSchema.nullable(), (input, value) => {
    if (value !== null && value.observation.data.operationId !== input.operationId) throw new TypeError("The Review has another identity.");
  }),
  cancel: define("exchange.cancel_review", operation, exchangeCancellationResultSchema, (input, value) => {
    if (input.operationId !== value.operationId) throw new TypeError("The discarded Review has another identity.");
  }),
  request: define("exchange.request", exchangeDirectDecisionSchema, exchangeConfirmationResultSchema, (input, value) => {
    admitExchangeConfirmationResult(input.review.observation.data.operationId, value);
  }),
});
export type AnyExchangeApplicationContract = typeof exchangeApplicationContracts[keyof typeof exchangeApplicationContracts];
export interface ExchangeApplicationPort {
  start: (input: z.infer<typeof exchangeCommandSchema>, signal: AbortSignal) => Promise<z.infer<typeof exchangeReviewSchema>>;
  get: (operationId: string) => z.infer<typeof readyExchangeReviewSchema> | null;
  cancel: (operationId: string) => z.infer<typeof exchangeCancellationResultSchema>;
  confirm: (input: z.infer<typeof exchangeDirectDecisionSchema>, signal: AbortSignal) => Promise<z.infer<typeof exchangeConfirmationResultSchema>>;
}
