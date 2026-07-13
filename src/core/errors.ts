import { z } from "zod";

import { createEvidenceSchemaSet, type FieldIssue } from "./evidence.js";
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
  return Object.freeze({ errorCategory, applicationErrorDefinition, applicationFailure });
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
  readonly parent?: ApplicationErrorRegistry;
}

const registryStates = new WeakMap<object, ApplicationErrorRegistryState>();

const registryState = (registry: ApplicationErrorRegistry): ApplicationErrorRegistryState => {
  const state = typeof registry === "object" && registry !== null ? registryStates.get(registry) : undefined;
  if (state === undefined) throw new TypeError("Application error registry provenance is invalid.");
  return state;
};

const createRegistry = (
  definitions: readonly ApplicationErrorDefinitionInput[],
  parent?: ApplicationErrorRegistry,
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
  registryStates.set(registry, Object.freeze({ definitions: map, ...(parent === undefined ? {} : { parent }) }));
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

export const assertDirectApplicationErrorRegistryExtension = (
  parent: ApplicationErrorRegistry,
  extension: ApplicationErrorRegistry,
): void => {
  registryState(parent);
  if (registryState(extension).parent !== parent) {
    throw new TypeError("Application error registry extension ancestry is invalid.");
  }
};

export const coreErrorRegistry = createRegistry([
  {
    code: "invalid_input",
    category: "input",
    message: "The request input is invalid.",
    retryable: false,
  },
  {
    code: "internal_error",
    category: "internal",
    message: "The request could not be completed.",
    retryable: false,
  },
]);

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
