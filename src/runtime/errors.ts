import { z } from "zod";

import {
  ApplicationErrorRegistry,
  assertDirectApplicationErrorRegistryExtension,
  canonicalJsonStringify,
  captureCanonicalJson,
  coreErrorRegistry,
  createApplicationFailure,
  fieldIssueSchema,
  generalSingleLineTextSchema,
  snakeCaseCodeSchema,
  type ApplicationFailure,
  type CanonicalJson,
} from "../core/index.js";
import { guardRuntimeJsonSchema, parseRuntimeAuthority } from "./schema-authority.js";

const runtimeDefinitions = [
  { code: "invalid_json", category: "transport", message: "The request body is not valid JSON.", retryable: false },
  { code: "query_not_supported", category: "transport", message: "Query parameters are not supported.", retryable: false },
  { code: "payload_too_large", category: "transport", message: "The request body exceeds the allowed size.", retryable: false },
  { code: "content_type_unsupported", category: "transport", message: "The request content type is not supported.", retryable: false },
  { code: "invalid_host", category: "security", message: "The request host is not allowed.", retryable: false },
  { code: "invalid_origin", category: "security", message: "The request origin is not allowed.", retryable: false },
  { code: "unauthorized", category: "security", message: "The request is not authorized.", retryable: false },
  { code: "route_not_found", category: "transport", message: "The requested route does not exist.", retryable: false },
  { code: "method_not_allowed", category: "transport", message: "The HTTP method is not allowed for this route.", retryable: false },
  { code: "state_conflict", category: "state", message: "Local state changed before the request completed.", retryable: false },
  { code: "port_conflict", category: "runtime", message: "The fixed Littlejohn port is owned by an incompatible process.", retryable: false },
  { code: "runtime_busy", category: "runtime", message: "The local runtime is busy.", retryable: true },
  { code: "runtime_state_unavailable", category: "runtime", message: "Local runtime state is unavailable.", retryable: false },
  { code: "request_aborted", category: "transport", message: "The request ended before completion.", retryable: true },
] as const;

export const runtimeErrorRegistry = coreErrorRegistry.extend(runtimeDefinitions);
assertDirectApplicationErrorRegistryExtension(coreErrorRegistry, runtimeErrorRegistry);

export const createRuntimeFailure = (code: string): ApplicationFailure =>
  createApplicationFailure(runtimeErrorRegistry, code);

export class RuntimeOperationError extends Error {
  readonly failure: ApplicationFailure;

  constructor(code: string) {
    const failure = createRuntimeFailure(code);
    super(failure.error.message);
    this.name = "RuntimeOperationError";
    this.failure = failure;
    Object.freeze(this);
  }
}

export const normalizeRuntimeError = (error: unknown): RuntimeOperationError =>
  error instanceof RuntimeOperationError ? error : new RuntimeOperationError("internal_error");

const createInterfaceSchemaSet = () => {
  const interfaceMapping = z.object({
    code: snakeCaseCodeSchema,
    httpStatus: z.number().int().min(400).max(599),
    problemTitle: generalSingleLineTextSchema,
    cliExitCode: z.number().int().min(1).max(255),
  }).strict();
  const problemDetails = z.object({
    type: z.literal("about:blank"),
    title: generalSingleLineTextSchema,
    status: z.number().int().min(400).max(599),
    code: snakeCaseCodeSchema,
    detail: generalSingleLineTextSchema,
    retryable: z.boolean(),
    issues: z.array(fieldIssueSchema).max(64),
  }).strict();
  return Object.freeze({ interfaceMapping, problemDetails });
};

const publicSchemas = createInterfaceSchemaSet();
const authoritySchemas = createInterfaceSchemaSet();

export const problemDetailsSchema = guardRuntimeJsonSchema(publicSchemas.problemDetails);
export type ProblemDetails = z.infer<typeof problemDetailsSchema>;
export type InterfaceErrorMapping = z.infer<typeof publicSchemas.interfaceMapping>;

interface MappingRegistryState {
  readonly applicationErrors: ApplicationErrorRegistry;
  readonly mappings: ReadonlyMap<string, InterfaceErrorMapping>;
  readonly parent?: InterfaceErrorMappingRegistry;
}

const mappingRegistryStates = new WeakMap<object, MappingRegistryState>();

const mappingRegistryState = (registry: InterfaceErrorMappingRegistry): MappingRegistryState => {
  const state = typeof registry === "object" && registry !== null
    ? mappingRegistryStates.get(registry)
    : undefined;
  if (state === undefined) throw new TypeError("Interface error mapping registry provenance is invalid.");
  return state;
};

const createMappingRegistry = (
  applicationErrors: ApplicationErrorRegistry,
  mappingsInput: readonly unknown[],
  parent?: InterfaceErrorMappingRegistry,
): InterfaceErrorMappingRegistry => {
  const mappings = new Map<string, InterfaceErrorMapping>();
  if (parent !== undefined) {
    for (const mapping of mappingRegistryState(parent).mappings.values()) mappings.set(mapping.code, mapping);
  }
  for (const input of mappingsInput) {
    const mapping = Object.freeze(parseRuntimeAuthority(authoritySchemas.interfaceMapping, input));
    applicationErrors.get(mapping.code);
    if (mappings.has(mapping.code)) throw new TypeError("Duplicate interface error mapping.");
    mappings.set(mapping.code, mapping);
  }
  const expectedCodes = applicationErrors.values().map((definition) => definition.code).sort();
  const actualCodes = [...mappings.keys()].sort();
  if (expectedCodes.join("\0") !== actualCodes.join("\0")) {
    throw new TypeError("Application error mapping coverage is incomplete.");
  }
  const registry = Object.create(InterfaceErrorMappingRegistry.prototype) as InterfaceErrorMappingRegistry;
  mappingRegistryStates.set(registry, Object.freeze({
    applicationErrors,
    mappings,
    ...(parent === undefined ? {} : { parent }),
  }));
  return Object.freeze(registry);
};

export class InterfaceErrorMappingRegistry {
  private constructor() {}

  get(code: string): InterfaceErrorMapping {
    const state = mappingRegistryState(this);
    state.applicationErrors.get(code);
    const mapping = state.mappings.get(code);
    if (mapping === undefined) throw new TypeError("Unknown interface error mapping.");
    return mapping;
  }

  extend(
    applicationErrors: ApplicationErrorRegistry,
    mappings: readonly unknown[],
  ): InterfaceErrorMappingRegistry {
    const state = mappingRegistryState(this);
    assertDirectApplicationErrorRegistryExtension(state.applicationErrors, applicationErrors);
    const inheritedCodes = new Set(state.applicationErrors.values().map((definition) => definition.code));
    const addedCodes = applicationErrors.values()
      .map((definition) => definition.code)
      .filter((code) => !inheritedCodes.has(code))
      .sort();
    const parsedCodes = mappings.map((mapping) =>
      parseRuntimeAuthority(authoritySchemas.interfaceMapping, mapping).code).sort();
    if (addedCodes.join("\0") !== parsedCodes.join("\0")) {
      throw new TypeError("Interface error mapping extension does not match its direct application-error extension.");
    }
    return createMappingRegistry(applicationErrors, mappings, this);
  }

  values(): readonly InterfaceErrorMapping[] {
    return Object.freeze([...mappingRegistryState(this).mappings.values()]);
  }
}

export const assertDirectInterfaceErrorMappingRegistryExtension = (
  parent: InterfaceErrorMappingRegistry,
  extension: InterfaceErrorMappingRegistry,
): void => {
  mappingRegistryState(parent);
  if (mappingRegistryState(extension).parent !== parent) {
    throw new TypeError("Interface error mapping registry extension ancestry is invalid.");
  }
};

export const runtimeInterfaceErrorMappings = createMappingRegistry(runtimeErrorRegistry, [
  { code: "invalid_input", httpStatus: 400, problemTitle: "Invalid request", cliExitCode: 2 },
  { code: "internal_error", httpStatus: 500, problemTitle: "Internal error", cliExitCode: 1 },
  { code: "invalid_json", httpStatus: 400, problemTitle: "Invalid JSON", cliExitCode: 2 },
  { code: "query_not_supported", httpStatus: 400, problemTitle: "Query not supported", cliExitCode: 2 },
  { code: "payload_too_large", httpStatus: 413, problemTitle: "Payload too large", cliExitCode: 2 },
  { code: "content_type_unsupported", httpStatus: 415, problemTitle: "Unsupported content type", cliExitCode: 2 },
  { code: "invalid_host", httpStatus: 400, problemTitle: "Invalid host", cliExitCode: 6 },
  { code: "invalid_origin", httpStatus: 403, problemTitle: "Invalid origin", cliExitCode: 6 },
  { code: "unauthorized", httpStatus: 401, problemTitle: "Unauthorized", cliExitCode: 6 },
  { code: "route_not_found", httpStatus: 404, problemTitle: "Route not found", cliExitCode: 3 },
  { code: "method_not_allowed", httpStatus: 405, problemTitle: "Method not allowed", cliExitCode: 2 },
  { code: "state_conflict", httpStatus: 409, problemTitle: "State conflict", cliExitCode: 5 },
  { code: "port_conflict", httpStatus: 409, problemTitle: "Port conflict", cliExitCode: 7 },
  { code: "runtime_busy", httpStatus: 503, problemTitle: "Runtime busy", cliExitCode: 4 },
  { code: "runtime_state_unavailable", httpStatus: 500, problemTitle: "Runtime state unavailable", cliExitCode: 7 },
  { code: "request_aborted", httpStatus: 408, problemTitle: "Request aborted", cliExitCode: 4 },
]);

const canonicalFailure = (
  failureInput: ApplicationFailure,
  registry: InterfaceErrorMappingRegistry,
): ApplicationFailure => {
  const captured = captureCanonicalJson(failureInput);
  if (typeof captured !== "object" || captured === null || Array.isArray(captured)) {
    throw new TypeError("Application failure is invalid.");
  }
  const error = captured["error"];
  if (typeof error !== "object" || error === null || Array.isArray(error)) {
    throw new TypeError("Application failure is invalid.");
  }
  const code = error["code"];
  const issues = error["issues"];
  if (typeof code !== "string" || !Array.isArray(issues)) throw new TypeError("Application failure is invalid.");
  const state = mappingRegistryState(registry);
  const normalized = createApplicationFailure(state.applicationErrors, code, issues as never);
  if (canonicalJsonStringify(captured as CanonicalJson) !== canonicalJsonStringify(normalized as unknown as CanonicalJson)) {
    throw new TypeError("Application failure does not match its authority.");
  }
  return normalized;
};

export const toProblemDetails = (
  failureInput: ApplicationFailure,
  registry = runtimeInterfaceErrorMappings,
): ProblemDetails => {
  const failure = canonicalFailure(failureInput, registry);
  const mapping = registry.get(failure.error.code);
  return Object.freeze(parseRuntimeAuthority(authoritySchemas.problemDetails, {
    type: "about:blank",
    title: mapping.problemTitle,
    status: mapping.httpStatus,
    code: failure.error.code,
    detail: failure.error.message,
    retryable: failure.error.retryable,
    issues: failure.error.issues,
  }));
};
