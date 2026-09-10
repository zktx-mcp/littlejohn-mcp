import { createApplicationFailure } from "../core/client.js";
import { requestReviewErrorRegistry } from "./request-error-registry.js";
export const createRequestReviewFailure = (code: string) => createApplicationFailure(requestReviewErrorRegistry, code);
const codes = new WeakMap<object, string>();
export class RequestReviewError extends Error {
  constructor(code: string) {
    const definition = requestReviewErrorRegistry.get(code);
    super(definition.message);
    this.name = "RequestReviewError";
    codes.set(this, code);
    Object.freeze(this);
  }
}
export const requestReviewFailureCode = (value: unknown): string | undefined =>
  typeof value === "object" && value !== null ? codes.get(value) : undefined;
