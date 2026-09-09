import { chainErrorRegistry } from "../chain/error-registry.js";
export const receiptActivityErrorDefinitions = Object.freeze([
  { code: "transaction_ledger_full", category: "domain", message: "The transaction ledger has no capacity for another result.", retryable: false },
] as const);
export const receiptActivityErrorRegistry = chainErrorRegistry.extend(receiptActivityErrorDefinitions);
export const receiptActivityFailureCodes = Object.freeze(receiptActivityErrorRegistry.values().map((entry) => entry.code));
const codes = new WeakMap<object, string>();
export class ReceiptActivityError extends Error {
  constructor(code: string) {
    const definition = receiptActivityErrorRegistry.get(code);
    super(definition.message);
    this.name = "ReceiptActivityError";
    codes.set(this, definition.code);
    Object.freeze(this);
  }
}
export const receiptActivityFailureCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null ? codes.get(error) : undefined;
