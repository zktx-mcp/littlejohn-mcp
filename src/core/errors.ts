import { z } from "zod";

import {
  createEvidenceSchemaSet,
  createFieldIssue,
  type FieldIssue,
} from "./evidence.js";
import { coreErrorDefinitions } from "./error-definitions.js";
import { deepFreezeValue } from "./immutability.js";
import { guardJsonSchema, jsonObject } from "./json-object.js";
import { compareCodePointSequences, createPrimitiveSchemaSet } from "./primitives.js";

export const errorCategories = Object.freeze([
  "input",
  "transport",
  "security",
  "domain",
  "source",
  "wallet",
  "state",
  "runtime",
  "internal",
] as const);

const createApplicationErrorSchemaSet = () => {
  const primitive = createPrimitiveSchemaSet();
  const evidence = createEvidenceSchemaSet();
  const errorCategory = z.enum(errorCategories);
  const applicationErrorDefinition = jsonObject({
      code: primitive.snakeCaseCode,
      category: errorCategory,
      message: primitive.generalSingleLineText,
      retryable: z.boolean(),
    })
    .strict();
  const applicationFailure = jsonObject({
      ok: z.literal(false),
      error: applicationErrorDefinition.extend({ issues: z.array(evidence.fieldIssue).max(64) }).strict(),
    })
    .strict();
  return Object.freeze({
    errorCategory,
    applicationErrorDefinition,
    applicationFailure,
    fieldIssue: evidence.fieldIssue,
  });
};

const publicSchemas = createApplicationErrorSchemaSet();
const authoritySchemas = createApplicationErrorSchemaSet();
const authorityEvidenceSchemas = createEvidenceSchemaSet();
const authorityApplicationErrorDefinitionSchema = guardJsonSchema(authoritySchemas.applicationErrorDefinition);
const authorityApplicationFailureSchema = guardJsonSchema(authoritySchemas.applicationFailure);

export const errorCategorySchema = publicSchemas.errorCategory;
export type ErrorCategory = z.infer<typeof errorCategorySchema>;

export const applicationErrorDefinitionSchema = guardJsonSchema(publicSchemas.applicationErrorDefinition);
export type ApplicationErrorDefinition = z.infer<typeof applicationErrorDefinitionSchema>;

export const applicationFailureSchema = guardJsonSchema(publicSchemas.applicationFailure);
export type ApplicationFailure = z.infer<typeof applicationFailureSchema>;

type ApplicationErrorDefinitionInput = z.input<typeof applicationErrorDefinitionSchema>;

interface ApplicationErrorRegistryState {
  readonly definitions: ReadonlyMap<string, ApplicationErrorDefinition>;
  readonly parentRegistry?: ApplicationErrorRegistry;
}

const registryStates = new WeakMap<object, ApplicationErrorRegistryState>();

const registryState = (registry: ApplicationErrorRegistry): ApplicationErrorRegistryState => {
  const state = typeof registry === "object" && registry !== null ? registryStates.get(registry) : undefined;
  if (state === undefined) throw new TypeError("Application error registry provenance is invalid.");
  return state;
};

const createRegistry = (
  definitions: readonly ApplicationErrorDefinitionInput[],
  parentRegistry?: ApplicationErrorRegistry,
): ApplicationErrorRegistry => {
  const parsed = definitions
    .map((definition) => deepFreezeValue(authorityApplicationErrorDefinitionSchema.parse(definition)))
    .sort((left, right) => compareCodePointSequences(left.code, right.code));
  const map = new Map<string, ApplicationErrorDefinition>();
  for (const definition of parsed) {
    if (map.has(definition.code)) throw new TypeError("Duplicate application error code: " + definition.code);
    map.set(definition.code, definition);
  }
  const registry = Object.create(ApplicationErrorRegistry.prototype) as ApplicationErrorRegistry;
  registryStates.set(registry, Object.freeze({
    definitions: map,
    ...(parentRegistry === undefined ? {} : { parentRegistry }),
  }));
  return Object.freeze(registry);
};

export class ApplicationErrorRegistry {
  private constructor() {}

  get(code: string): ApplicationErrorDefinition {
    const definition = registryState(this).definitions.get(code);
    if (definition === undefined) throw new TypeError("Unknown application error code.");
    return definition;
  }

  extend(definitions: readonly ApplicationErrorDefinitionInput[]): ApplicationErrorRegistry {
    if (definitions.length === 0) throw new TypeError("Application error registry extension is empty.");
    return createRegistry([...registryState(this).definitions.values(), ...definitions], this);
  }

  values(): readonly ApplicationErrorDefinition[] {
    return Object.freeze([...registryState(this).definitions.values()]);
  }
}

export const assertApplicationErrorRegistry = (registry: ApplicationErrorRegistry): void => {
  registryState(registry);
};

export const applicationFailureSchemaFor = (
  registry: ApplicationErrorRegistry,
  codes: readonly string[],
): z.ZodType<ApplicationFailure> => {
  assertApplicationErrorRegistry(registry);
  if (codes.length === 0 || new Set(codes).size !== codes.length) {
    throw new TypeError("Application failure schema codes are invalid.");
  }
  const variants = codes.map((code) => {
    const definition = registry.get(code);
    return jsonObject({
      ok: z.literal(false),
      error: jsonObject({
        code: z.literal(definition.code),
        category: z.literal(definition.category),
        message: z.literal(definition.message),
        retryable: z.literal(definition.retryable),
        issues: z.array(publicSchemas.fieldIssue).max(64),
      }).strict(),
    }).strict();
  });
  const first = variants[0];
  if (first === undefined) throw new TypeError("Application failure schema codes are invalid.");
  const second = variants[1];
  const schema = second === undefined
    ? first
    : z.union([first, second, ...variants.slice(2)]);
  return guardJsonSchema(schema as z.ZodType<ApplicationFailure>);
};

export const assertDirectApplicationErrorRegistryExtension = (
  parentRegistry: ApplicationErrorRegistry,
  extension: ApplicationErrorRegistry,
): void => {
  registryState(parentRegistry);
  if (registryState(extension).parentRegistry !== parentRegistry) {
    throw new TypeError("Application error registry extension ancestry is invalid.");
  }
};

export const coreErrorRegistry = createRegistry(coreErrorDefinitions);

const pathToJsonPointer = (path: readonly PropertyKey[]): string =>
  path.length === 0
    ? ""
    : `/${path.map((part) => String(part).replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;

export const fieldIssuesFromInputError = (error: unknown): readonly FieldIssue[] =>
  error instanceof z.ZodError
    ? error.issues.map((issue) => createFieldIssue("invalid_value", pathToJsonPointer(issue.path)))
    : [createFieldIssue("invalid_value", "")];

export const createApplicationFailure = (
  registry: ApplicationErrorRegistry,
  code: string,
  issues: readonly FieldIssue[] = [],
): ApplicationFailure => {
  const definition = registry.get(code);
  const canonicalIssues = issues
    .map((issue) => authorityEvidenceSchemas.fieldIssue.parse(issue))
    .sort((left, right) => {
      const pathOrder = compareCodePointSequences(left.path, right.path);
      if (pathOrder !== 0) return pathOrder;
      const codeOrder = compareCodePointSequences(left.code, right.code);
      return codeOrder === 0 ? compareCodePointSequences(left.message, right.message) : codeOrder;
    })
    .filter((issue, index, values) => {
      const previous = values[index - 1];
      return previous === undefined ||
        previous.path !== issue.path || previous.code !== issue.code || previous.message !== issue.message;
    })
    .slice(0, 64);
  const parsed = authorityApplicationFailureSchema.parse({
    ok: false,
    error: { ...definition, issues: canonicalIssues },
  });
  return deepFreezeValue({
    ...parsed,
    error: {
      ...parsed.error,
      issues: [...parsed.error.issues],
    },
  }) as ApplicationFailure;
};
