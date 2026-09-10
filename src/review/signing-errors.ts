import { createApplicationFailure } from "../core/client.js";
import { walletErrorRegistry } from "../wallet/error-registry.js";
import { requestReviewErrorDefinitions } from "./request-error-definitions.js";
import { requestReviewFailureCode } from "./request-errors.js";

export const signingErrorRegistry = walletErrorRegistry.extend(requestReviewErrorDefinitions);
export const signingFailureCodes = Object.freeze(signingErrorRegistry.values().map((entry) => entry.code));
const codes = new WeakMap<object, string>();
export class SigningError extends Error {
  constructor(code: string) {
    const definition = signingErrorRegistry.get(code);
    super(definition.message);
    this.name = "SigningError";
    codes.set(this, definition.code);
    Object.freeze(this);
  }
}
export const signingFailureCode = (value: unknown): string | undefined =>
  (typeof value === "object" && value !== null ? codes.get(value) : undefined) ?? requestReviewFailureCode(value);
export const createSigningFailure = (code: string) => createApplicationFailure(signingErrorRegistry, code);
