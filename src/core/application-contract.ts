import type { ZodType } from "zod";

import { captureCanonicalJson } from "./canonical-json.js";
import { coreContractVersion } from "./contract.js";
import {
  ApplicationErrorRegistry,
  applicationFailureSchemaFor,
  assertApplicationErrorRegistry,
  createApplicationFailure,
  type ApplicationFailure,
} from "./errors.js";
import { deepFreezeValue } from "./immutability.js";

declare const applicationContractType: unique symbol;

export interface ApplicationContract<PublicInput, InternalContext, Success> {
  readonly [applicationContractType]: {
    readonly publicInput: PublicInput;
    readonly internalContext: InternalContext;
    readonly success: Success;
  };
  readonly contractVersion: typeof coreContractVersion;
  readonly errorRegistry: ApplicationErrorRegistry;
  readonly inputSchema: ZodType<PublicInput>;
  readonly successSchema: ZodType<Success>;
  readonly failureCodes: readonly string[];
  parseInput(value: unknown): PublicInput;
  parsePublicSuccess(publicInput: unknown, value: unknown): Success;
  parseBoundSuccess(publicInput: unknown, internalContext: unknown, value: unknown): Success;
  parseFailure(value: unknown): ApplicationFailure;
  normalizeFailure(value: unknown): ApplicationFailure;
}

export type ApplicationContractPublicInput<Contract> =
  Contract extends ApplicationContract<infer Input, unknown, unknown> ? Input : never;
export type ApplicationContractInternalContext<Contract> =
  Contract extends ApplicationContract<unknown, infer Context, unknown> ? Context : never;
export type ApplicationContractSuccess<Contract> =
  Contract extends ApplicationContract<unknown, unknown, infer Success> ? Success : never;

export const defineApplicationContract = <PublicInput, InternalContext, Success>(options: Readonly<{
  inputSchema: ZodType<PublicInput>;
  correlationInputSchema?: ZodType<PublicInput>;
  successSchema: ZodType<Success>;
  internalContextSchema: ZodType<InternalContext>;
  errorRegistry: ApplicationErrorRegistry;
  failureCodes: readonly string[];
  validatePublicSuccess?: (publicInput: PublicInput, success: Success) => void;
  validateBoundSuccess?: (
    publicInput: PublicInput,
    internalContext: InternalContext,
    success: Success,
  ) => void;
}>): ApplicationContract<PublicInput, InternalContext, Success> => {
  assertApplicationErrorRegistry(options.errorRegistry);
  const failureCodes = Object.freeze([...options.failureCodes].sort());
  if (
    failureCodes.length === 0 ||
    new Set(failureCodes).size !== failureCodes.length ||
    !failureCodes.includes("invalid_input") ||
    !failureCodes.includes("internal_error")
  ) {
    throw new TypeError("Application contract failure codes are invalid.");
  }
  for (const code of failureCodes) options.errorRegistry.get(code);
  const failureSchema = applicationFailureSchemaFor(options.errorRegistry, failureCodes);

  const parsePublic = (publicInputValue: unknown, value: unknown): Readonly<{
    publicInput: PublicInput;
    success: Success;
  }> => {
    const publicInput = (options.correlationInputSchema ?? options.inputSchema)
      .parse(captureCanonicalJson(publicInputValue));
    const success = options.successSchema.parse(captureCanonicalJson(value));
    options.validatePublicSuccess?.(publicInput, success);
    return Object.freeze({ publicInput, success });
  };

  return Object.freeze({
    contractVersion: coreContractVersion,
    errorRegistry: options.errorRegistry,
    inputSchema: options.inputSchema,
    successSchema: options.successSchema,
    failureCodes,
    parseInput(value: unknown): PublicInput {
      return deepFreezeValue(options.inputSchema.parse(captureCanonicalJson(value)));
    },
    parsePublicSuccess(publicInputValue: unknown, value: unknown): Success {
      return deepFreezeValue(parsePublic(publicInputValue, value).success);
    },
    parseBoundSuccess(publicInputValue: unknown, internalContextValue: unknown, value: unknown): Success {
      const parsed = parsePublic(publicInputValue, value);
      const internalContext = options.internalContextSchema.parse(captureCanonicalJson(internalContextValue));
      options.validateBoundSuccess?.(parsed.publicInput, internalContext, parsed.success);
      return deepFreezeValue(parsed.success);
    },
    parseFailure(value: unknown): ApplicationFailure {
      return deepFreezeValue(failureSchema.parse(captureCanonicalJson(value)));
    },
    normalizeFailure(value: unknown): ApplicationFailure {
      try {
        return deepFreezeValue(failureSchema.parse(captureCanonicalJson(value)));
      } catch {
        return createApplicationFailure(options.errorRegistry, "internal_error");
      }
    },
  }) as ApplicationContract<PublicInput, InternalContext, Success>;
};
