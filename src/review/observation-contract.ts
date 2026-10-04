import {createEvmCapabilitySuccessSchema} from "../evm/capability.js";
import { z } from "zod";
import {captureCanonicalJson, canonicalJsonStringify, getCapabilityDefinitionSnapshot, parseCapabilitySuccess, operationIdSchema, utcTimestampSchema, type CapabilitySuccess} from "../core/client.js";
import {defineEvmReadCapability} from "../evm/capability.js";
import { exchangeRequestSchema, feeReplacementRequestSchema } from "./exchange.js";
import { exchangeObservationSchema, type ExchangeObservation } from "./observation.js";
import { feeReplacementObservationSchema, type FeeReplacementObservation } from "./replacement-contract.js";
import { exchangeObservationCapabilityId, exchangeObservationEvidence } from "./evidence.js";
import { exchangeFailureCodes } from "./errors.js";

export const exchangeObservationInputSchema = z.object({
  request: z.union([exchangeRequestSchema, feeReplacementRequestSchema]), operationId: operationIdSchema,
  createdAt: utcTimestampSchema, actionExpiresAt: utcTimestampSchema,
}).strict();
export type ExchangeObservationInput = z.infer<typeof exchangeObservationInputSchema>;
export type TransactionObservation = ExchangeObservation | FeeReplacementObservation;
const transactionObservationSchema = z.union([exchangeObservationSchema, feeReplacementObservationSchema]);
export const exchangeObservationCapability = defineEvmReadCapability<ExchangeObservationInput, TransactionObservation>({
  capabilityId: exchangeObservationCapabilityId, contractVersion: "1",
  inputSchema: exchangeObservationInputSchema, dataSchema: transactionObservationSchema,
  failureCodes: exchangeFailureCodes, evidence: exchangeObservationEvidence,
  validateDataContext(data, context) {
    if (data.createdAt > context.evaluatedAt || context.evaluatedAt >= data.actionExpiresAt) {
      throw new TypeError("Exchange observation was not produced during its Review lifetime.");
    }
  },
  validateIntrinsicData(data, context) {
    transactionObservationSchema.parse(data);
    for (const exclusion of exchangeObservationEvidence.staticScopeExclusions) context.assertDeclaredScopeExclusion(exclusion);
  },
  validateRequest(input, data) {
    if ("kind" in input.request) {
      if (!("replacement" in data) || input.operationId !== data.operationId || input.createdAt !== data.createdAt ||
          input.actionExpiresAt < data.actionExpiresAt || input.request.transactionHash !== data.intent.transactionHash ||
          canonicalJsonStringify(captureCanonicalJson(input.request.fees)) !== canonicalJsonStringify(captureCanonicalJson(data.intent.fees)) ||
          (input.request.account.kind === "address" && input.request.account.address !== data.intent.account.address)) {
        throw new TypeError("Fee replacement observation differs from its requested subject.");
      }
      return;
    }
    if ("replacement" in data) throw new TypeError("Exchange observation changed its action.");
    if (input.operationId !== data.operationId || input.createdAt !== data.createdAt || input.actionExpiresAt !== data.actionExpiresAt ||
        input.request.stockTokenAddress !== data.intent.stockTokenAddress || input.request.direction !== data.intent.direction ||
        input.request.poolId !== data.intent.poolId || input.request.deadline !== data.intent.deadline ||
        input.request.replaces !== data.intent.replaces ||
        (input.request.gasLimit === undefined ? data.gasLimitSource !== "estimate" : data.gasLimitSource !== "user" || input.request.gasLimit !== data.gasLimit) ||
        input.request.conditions.basis !== data.intent.basis || input.request.conditions.inputRelation !== data.intent.inputRelation ||
        input.request.conditions.outputRelation !== data.intent.outputRelation || input.request.conditions.inputAmount !== data.intent.input.human ||
        input.request.conditions.outputAmount !== data.intent.output.human ||
        canonicalJsonStringify(captureCanonicalJson(input.request.fees)) !== canonicalJsonStringify(captureCanonicalJson(data.intent.fees)) ||
        (input.request.account.kind === "address" && input.request.account.address !== data.intent.account.address)) {
      throw new TypeError("Exchange observation differs from its requested subject.");
    }
  },
  validateSuccess(data, context) {
    if (data.block.chainId !== context.chainId) throw new TypeError("Exchange observation chain differs from its invocation.");
  },
});
export const exchangeObservationResultSchema = createEvmCapabilitySuccessSchema(
  getCapabilityDefinitionSnapshot(exchangeObservationCapability).capabilityId,
  "1",
  transactionObservationSchema,
).superRefine((value, context) => {
  const data = value.data;
  const intent = data.intent;
  // Reopening validates the complete retained observation and its evidence.
  // The original requested input is compared separately at production.
  const input = {
    operationId: data.operationId, createdAt: data.createdAt, actionExpiresAt: data.actionExpiresAt,
    request: "replacement" in data ? { kind: "replace_fees", account: { kind: "address", address: data.intent.account.address },
      transactionHash: data.intent.transactionHash, fees: data.intent.fees } : {
      account: { kind: "address", address: intent.account.address },
      stockTokenAddress: data.intent.stockTokenAddress, direction: data.intent.direction,
      poolId: data.intent.poolId, deadline: data.intent.deadline, fees: data.intent.fees,
      ...(data.intent.replaces === undefined ? {} : { replaces: data.intent.replaces }),
      ...(data.gasLimitSource === "user" ? { gasLimit: data.gasLimit } : {}),
      conditions: {
        basis: data.intent.basis, inputRelation: data.intent.inputRelation, outputRelation: data.intent.outputRelation,
        inputAmount: data.intent.input.human, outputAmount: data.intent.output.human,
      },
    },
  };
  try { parseCapabilitySuccess(exchangeObservationCapability, input, value); }
  catch { context.addIssue({ code: "custom", message: "Exchange Review evidence is inconsistent." }); }
});
export type ExchangeObservationResult = CapabilitySuccess<TransactionObservation>;
