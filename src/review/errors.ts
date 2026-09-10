import { requestReviewErrorDefinitions } from "./request-error-definitions.js";
import { requestReviewFailureCode } from "./request-errors.js";
import { createApplicationFailure, type ApplicationFailure } from "../core/client.js";
import { officialAssetErrorRegistry } from "../registry/error-registry.js";
import { receiptActivityErrorDefinitions, receiptActivityFailureCode } from "../receipt-activity/errors.js";

export const exchangeErrorDefinitions = Object.freeze([
  ...receiptActivityErrorDefinitions,
  ...requestReviewErrorDefinitions,
  { code: "exchange_replacement_unavailable", category: "domain", message: "The pending transaction or its replacement conditions could not be established.", retryable: true },
  { code: "exchange_conditions_unmet", category: "domain", message: "The current exchange does not satisfy the requested conditions.", retryable: true },
  { code: "exchange_contract_unavailable", category: "source", message: "A required exchange contract could not be admitted.", retryable: true },
  { code: "exchange_pool_unsupported", category: "domain", message: "The selected pool is outside the supported exchange catalog.", retryable: false },
  { code: "exchange_operation_not_found", category: "domain", message: "The exchange operation was not found.", retryable: false },
  { code: "exchange_capacity_exceeded", category: "domain", message: "The exchange exceeds the available bounded capacity.", retryable: false },
] as const);

export const exchangeErrorRegistry = officialAssetErrorRegistry.extend(exchangeErrorDefinitions);
export const exchangeFailureCodes = Object.freeze(exchangeErrorRegistry.values().map((value) => value.code));
const failures = new WeakMap<object, string>();
export class ExchangeError extends Error {
  constructor(code: string) {
    const definition = exchangeErrorRegistry.get(code);
    super(definition.message);
    this.name = "ExchangeError";
    failures.set(this, definition.code);
    Object.freeze(this);
  }
}
export const exchangeFailureCode = (input: unknown): string | undefined =>
  (typeof input === "object" && input !== null ? failures.get(input) : undefined) ?? receiptActivityFailureCode(input) ?? requestReviewFailureCode(input);
export const createExchangeFailure = (code: string): ApplicationFailure => createApplicationFailure(exchangeErrorRegistry, code);
