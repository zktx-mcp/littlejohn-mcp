import {
  canonicalJsonStringify,
  captureCanonicalJson,
  type ApplicationErrorRegistry,
  createApplicationFailure,
  type ApplicationFailure,
  type CanonicalJson,
} from "../core/index.js";
import {
  tokenCatalogErrorRegistry,
  tokenCatalogInterfaceErrorMappings,
} from "../token-catalog/index.js";
import {
  getRuntimeOperationFailure,
  problemDetailsSchema,
  toProblemDetails,
  type InterfaceErrorMappingRegistry,
} from "../runtime/errors.js";
import type {
  RuntimeDispatchRequest,
  RuntimeDispatchResponse,
} from "../runtime/index.js";

export interface RuntimeDispatchPort {
  dispatchRuntimeRequest(request: RuntimeDispatchRequest): Promise<RuntimeDispatchResponse>;
}

export type InterfaceInvocationResult =
  | { readonly ok: true; readonly value: CanonicalJson }
  | { readonly ok: false; readonly failure: ApplicationFailure };

export const createInterfaceFailure = (
  code: string,
  issues: ApplicationFailure["error"]["issues"] = [],
): ApplicationFailure => {
  try { return createApplicationFailure(tokenCatalogErrorRegistry, code, issues); }
  catch { return createApplicationFailure(tokenCatalogErrorRegistry, "internal_error"); }
};

export const constrainInterfaceFailure = (
  result: InterfaceInvocationResult,
  failureCodes: readonly string[],
): InterfaceInvocationResult => result.ok || failureCodes.includes(result.failure.error.code)
  ? result
  : Object.freeze({ ok: false, failure: createInterfaceFailure("internal_error") });

export const normalizeProblemDetailsFailure = (
  response: RuntimeDispatchResponse,
  applicationErrors: ApplicationErrorRegistry,
  interfaceMappings: InterfaceErrorMappingRegistry,
  fallbackCode: string,
): ApplicationFailure => {
  try {
    const problem = problemDetailsSchema.parse(captureCanonicalJson(response.body));
    const failure = createApplicationFailure(applicationErrors, problem.code, problem.issues);
    const expected = toProblemDetails(failure, interfaceMappings);
    if (
      response.status !== problem.status ||
      canonicalJsonStringify(problem as unknown as CanonicalJson) !==
        canonicalJsonStringify(expected as unknown as CanonicalJson)
    ) {
      throw new TypeError("Problem Details does not match the interface error authority.");
    }
    return failure;
  } catch {
    return createApplicationFailure(applicationErrors, fallbackCode);
  }
};

const normalizeDispatchFailure = (response: RuntimeDispatchResponse): ApplicationFailure =>
  normalizeProblemDetailsFailure(
    response,
    tokenCatalogErrorRegistry,
    tokenCatalogInterfaceErrorMappings,
    "internal_error",
  );

export const dispatchCanonical = async (
  runtime: RuntimeDispatchPort,
  request: RuntimeDispatchRequest,
  expectedStatus: 200 | 201,
): Promise<InterfaceInvocationResult> => {
  try {
    const response = await runtime.dispatchRuntimeRequest(request);
    if (response.status >= 400) return { ok: false, failure: normalizeDispatchFailure(response) };
    if (response.status !== expectedStatus) {
      return { ok: false, failure: createInterfaceFailure("internal_error") };
    }
    return { ok: true, value: captureCanonicalJson(response.body) };
  } catch (error) {
    const failure = getRuntimeOperationFailure(error);
    return {
      ok: false,
      failure: failure === undefined
        ? createInterfaceFailure("internal_error")
        : createInterfaceFailure(failure.error.code, failure.error.issues),
    };
  }
};
