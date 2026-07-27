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
import {
  runtimeErrorDefinitions,
  runtimeInterfaceErrorMappingDefinitions,
} from "./error-definitions.js";

export const runtimeErrorRegistry = coreErrorRegistry.extend(runtimeErrorDefinitions);
assertDirectApplicationErrorRegistryExtension(coreErrorRegistry, runtimeErrorRegistry);

export const createRuntimeFailure = (code: string): ApplicationFailure =>
  createApplicationFailure(runtimeErrorRegistry, code);

const runtimeOperationFailures = new WeakMap<object, ApplicationFailure>();

export class RuntimeOperationError extends Error {
  readonly failure: ApplicationFailure;

  constructor(code: string) {
    const failure = createRuntimeFailure(code);
    super(failure.error.message);
    this.name = "RuntimeOperationError";
    this.failure = failure;
    runtimeOperationFailures.set(this, failure);
    Object.freeze(this);
  }
}

export const getRuntimeOperationFailure = (error: unknown): ApplicationFailure | undefined =>
  typeof error === "object" && error !== null
    ? runtimeOperationFailures.get(error)
    : undefined;

export const normalizeRuntimeError = (error: unknown): RuntimeOperationError =>
  getRuntimeOperationFailure(error) === undefined
    ? new RuntimeOperationError("internal_error")
    : error as RuntimeOperationError;

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

export const assertInterfaceErrorMappingRegistryDescendant = (
  ancestor: InterfaceErrorMappingRegistry,
  candidate: InterfaceErrorMappingRegistry,
): void => {
  mappingRegistryState(ancestor);
  let current: InterfaceErrorMappingRegistry | undefined = candidate;
  while (current !== undefined && current !== ancestor) {
    current = mappingRegistryState(current).parent;
  }
  if (current !== ancestor) {
    throw new TypeError("Interface error mapping registry ancestry is invalid.");
  }
};

export const runtimeInterfaceErrorMappings = createMappingRegistry(
  runtimeErrorRegistry,
  runtimeInterfaceErrorMappingDefinitions,
);

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
