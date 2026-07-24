import {
  canonicalJsonStringify,
  captureCanonicalJson,
  type ApplicationErrorRegistry,
  createApplicationFailure,
  type ApplicationFailure,
  type CanonicalJson,
} from "../core/index.js";
import {
  getRuntimeOperationFailure,
  problemDetailsSchema,
  runtimeErrorRegistry,
  toProblemDetails,
  type InterfaceErrorMappingRegistry,
} from "../runtime/errors.js";
import type { RouteSuccessStatus } from "../runtime/http-boundary.js";
import type {
  RuntimeDispatchRequest,
  RuntimeDispatchResponse,
} from "../runtime/http-owner.js";

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
  try { return createApplicationFailure(runtimeErrorRegistry, code, issues); }
  catch { return createApplicationFailure(runtimeErrorRegistry, "internal_error"); }
};

export const constrainInterfaceFailure = (
  result: InterfaceInvocationResult,
  failureCodes: readonly string[],
): InterfaceInvocationResult => result.ok || failureCodes.includes(result.failure.error.code)
  ? result
  : Object.freeze({ ok: false, failure: createInterfaceFailure("internal_error") });

export const parseProblemDetailsFailure = (
  response: RuntimeDispatchResponse,
  applicationErrors: ApplicationErrorRegistry,
  interfaceMappings: InterfaceErrorMappingRegistry,
): ApplicationFailure => {
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
};

export const normalizeProblemDetailsFailure = (
  response: RuntimeDispatchResponse,
  applicationErrors: ApplicationErrorRegistry,
  interfaceMappings: InterfaceErrorMappingRegistry,
  fallbackCode: string,
): ApplicationFailure => {
  try { return parseProblemDetailsFailure(response, applicationErrors, interfaceMappings); }
  catch { return createApplicationFailure(applicationErrors, fallbackCode); }
};

export interface CanonicalDispatchAuthority {
  readonly applicationErrors: ApplicationErrorRegistry;
  readonly interfaceMappings: InterfaceErrorMappingRegistry;
}

const authorityFailure = (
  authority: CanonicalDispatchAuthority,
  code: string,
  issues: ApplicationFailure["error"]["issues"] = [],
): ApplicationFailure => {
  try { return createApplicationFailure(authority.applicationErrors, code, issues); }
  catch { return createApplicationFailure(authority.applicationErrors, "internal_error"); }
};

export const dispatchCanonical = async (
  runtime: RuntimeDispatchPort,
  request: RuntimeDispatchRequest,
  expectedStatus: RouteSuccessStatus,
  authority: CanonicalDispatchAuthority,
): Promise<InterfaceInvocationResult> => {
  try {
    const response = await runtime.dispatchRuntimeRequest(request);
    if (response.status >= 400) return {
      ok: false,
      failure: normalizeProblemDetailsFailure(
        response,
        authority.applicationErrors,
        authority.interfaceMappings,
        "internal_error",
      ),
    };
    if (response.status !== expectedStatus) {
      return { ok: false, failure: authorityFailure(authority, "internal_error") };
    }
    return { ok: true, value: captureCanonicalJson(response.body) };
  } catch (error) {
    const failure = getRuntimeOperationFailure(error);
    return {
      ok: false,
      failure: failure === undefined
        ? authorityFailure(authority, "internal_error")
        : authorityFailure(authority, failure.error.code, failure.error.issues),
    };
  }
};
