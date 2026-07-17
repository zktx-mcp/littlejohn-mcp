import { createHash, randomBytes } from "node:crypto";
import { z, type ZodType } from "zod";

import { createAmountSchemaSet, type AssetIdentity, type ObservationClaimBinding } from "./amounts.js";
import { canonicalJsonStringify, captureCanonicalJson, type CanonicalJson } from "./canonical-json.js";
import { coreContractVersion } from "./contract.js";
import { sha256Algorithm } from "./digests.js";
import {
  createEvidenceSchemaSet,
  createFieldIssue,
  createWarning,
  deriveCoverage,
  factOutcomeDefinitions,
  freshnessRuleDefinitions,
  isStrictlyOrderedUnique,
  type Conclusion,
  type Coverage,
  type EvidenceSource,
  type FactOutcome,
  type FieldIssue,
  type Freshness,
  type InvocationId,
  type ObservationId,
  type SourceClass,
  type StaticScopeExclusion,
  type Warning,
} from "./evidence.js";
import { robinhoodChainIdentity } from "./identities.js";
import { deepFreezeValue } from "./immutability.js";
import { jsonObject } from "./json-object.js";
import { productDisplayName } from "./product-identity.js";
import {
  assertCapabilityInvocationAuthority,
  createHandlerInvocationContext,
  readCanonicalClock,
  readObservationAuthority,
  type CapabilityInvocationAuthority,
  type CanonicalClock,
  type HandlerInvocationContext,
  type InvocationBoundaryPorts,
  type ObservationClaim,
  type ObservationAuthority,
  ObservationAuthorityRegistry,
} from "./invocation.js";
import {
  assertApplicationErrorRegistry,
  createApplicationFailure,
  type ApplicationErrorRegistry,
  type ApplicationFailure,
} from "./errors.js";
import {
  compareCodePointSequences,
  sortUniqueStrings,
  createPrimitiveSchemaSet,
  type ChainAnchor,
  type SnakeCaseCode,
  type UtcTimestamp,
} from "./primitives.js";

const binderPrimitiveSchemas = createPrimitiveSchemaSet();
const binderAmountSchemas = createAmountSchemaSet();
const binderEvidenceSchemas = createEvidenceSchemaSet();

export const capabilityIdPatternSource =
  "[a-z][a-z0-9]*(?:_[a-z0-9]+)*\\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*";

export const createCapabilityIdSchema = () => z
  .string()
  .min(1)
  .max(64)
  .regex(new RegExp("^" + capabilityIdPatternSource + "$"))
  .brand("CapabilityId");

export const capabilityIdSchema = createCapabilityIdSchema();
const capabilityIdAuthoritySchema = createCapabilityIdSchema();
export type CapabilityId = z.infer<typeof capabilityIdSchema>;

export interface FactRequirement {
  readonly factId: string;
  readonly observationSlotIds: readonly string[];
  readonly requiredObservationSlotIds: readonly string[];
  readonly minimumObservationCount: number;
  readonly outcome: FactOutcome;
}

export type ObservationSlot =
  | {
      readonly slotId: string;
      readonly factId: string;
      readonly kind: "validated_input";
      readonly purpose: string;
    }
  | {
      readonly slotId: string;
      readonly factId: string;
      readonly kind: "source";
      readonly purpose: string;
      readonly sourceClass: Exclude<SourceClass, "validated_input">;
    };

export interface ObservedFact {
  readonly factId: string;
  readonly outcome: FactOutcome;
  readonly observationIds: readonly ObservationId[];
}

export interface ObservationExpectation {
  readonly slotId: string;
  readonly claims: readonly ObservationClaim[];
}

export interface ObservationWriter {
  record(slotId: string, observation: {
    readonly source: ObservationAuthority;
    readonly claims: readonly ObservationClaim[];
  }): ObservationId;
  get(slotId: string): ObservationId | undefined;
}

export interface ConclusionDraft {
  readonly id: string;
  readonly outcomeFactId: string;
  readonly evidenceFactIds: readonly string[];
  readonly freshnessRuleId: Freshness["ruleId"];
}

export interface WarningRequirement {
  readonly code: Warning["code"];
  readonly factIds: readonly string[];
}

export interface InvocationValidationContext {
  readonly observationClaims: readonly ObservationClaimBinding[];
  readonly evaluatedAt: UtcTimestamp;
}

export interface DataValidationContext {
  readonly evaluatedAt: UtcTimestamp;
}

export interface IntrinsicDataValidationContext {
  assertDeclaredScopeExclusion(exclusion: StaticScopeExclusion): void;
}

const observationClaimAuthoritySchema = jsonObject({
  role: binderPrimitiveSchemas.fixedIdentifier,
  value: z.json(),
  chainAnchor: binderPrimitiveSchemas.chainAnchor.optional(),
  asset: binderAmountSchemas.assetIdentity.optional(),
}).strict();
const observationSlotAuthoritySchema = z.discriminatedUnion("kind", [
  jsonObject({
    slotId: binderPrimitiveSchemas.fixedIdentifier,
    factId: binderPrimitiveSchemas.fixedIdentifier,
    kind: z.literal("validated_input"),
    purpose: binderPrimitiveSchemas.snakeCaseCode,
  }).strict(),
  jsonObject({
    slotId: binderPrimitiveSchemas.fixedIdentifier,
    factId: binderPrimitiveSchemas.fixedIdentifier,
    kind: z.literal("source"),
    purpose: binderPrimitiveSchemas.snakeCaseCode,
    sourceClass: binderEvidenceSchemas.externalSourceClass,
  }).strict(),
]);
const factRequirementAuthoritySchema = jsonObject({
  factId: binderPrimitiveSchemas.fixedIdentifier,
  observationSlotIds: z.array(binderPrimitiveSchemas.fixedIdentifier).min(1).max(128),
  requiredObservationSlotIds: z.array(binderPrimitiveSchemas.fixedIdentifier).max(128),
  minimumObservationCount: z.number().int().min(0).max(128),
  outcome: binderEvidenceSchemas.factOutcome,
}).strict();
const observationExpectationAuthoritySchema = jsonObject({
  slotId: binderPrimitiveSchemas.fixedIdentifier,
  claims: z.array(observationClaimAuthoritySchema).min(1).max(8_192),
}).strict();
const conclusionDraftAuthoritySchema = jsonObject({
  id: binderPrimitiveSchemas.fixedIdentifier,
  outcomeFactId: binderPrimitiveSchemas.fixedIdentifier,
  evidenceFactIds: z.array(binderPrimitiveSchemas.fixedIdentifier).min(1).max(128),
  freshnessRuleId: binderEvidenceSchemas.freshnessRuleId,
}).strict();
const warningRequirementAuthoritySchema = jsonObject({
  code: binderEvidenceSchemas.warningCode,
  factIds: z.array(binderPrimitiveSchemas.fixedIdentifier).min(1).max(128),
}).strict();

const parseDefinitionArray = <Value>(schema: ZodType<Value>, input: unknown): readonly Value[] => {
  const normalized = safeNormalize(input);
  if (!normalized.ok || !Array.isArray(normalized.value)) {
    throw new TypeError("Capability definition output is invalid.");
  }
  return Object.freeze(normalized.value.map((value) => deepFreezeValue(schema.parse(value))));
};

declare const readCapabilityDefinitionType: unique symbol;

export interface ReadCapabilityDefinition<Input, Data> {
  readonly [readCapabilityDefinitionType]: {
    readonly input: Input;
    readonly data: Data;
  };
}

export type CapabilityInput<Definition> = Definition extends ReadCapabilityDefinition<infer Input, unknown>
  ? Input
  : never;
export type CapabilityData<Definition> = Definition extends ReadCapabilityDefinition<unknown, infer Data>
  ? Data
  : never;

export interface CapabilitySuccess<Data> {
  readonly ok: true;
  readonly meta: {
    readonly capabilityId: CapabilityId;
    readonly contractVersion: typeof coreContractVersion;
    readonly chainId: typeof robinhoodChainIdentity.chainId;
    readonly evaluatedAt: UtcTimestamp;
  };
  readonly data: Data;
  readonly evidence: {
    readonly sources: readonly EvidenceSource[];
    readonly conclusions: readonly Conclusion[];
    readonly coverage: Coverage;
  };
  readonly warnings: readonly Warning[];
}

interface InternalReadCapabilityDefinition<Input, Data> {
  readonly capabilityId: CapabilityId;
  readonly contractVersion: typeof coreContractVersion;
  readonly failureCodes: readonly SnakeCaseCode[];
  readonly conclusionIds: readonly string[];
  readonly conclusionIdMatchers: readonly ((value: string) => boolean)[];
  expectedConclusionIds(input: Input, data: Data): readonly string[];
  observationSlots(input: Input): readonly ObservationSlot[];
  observationExpectations(input: Input, data: Data): readonly ObservationExpectation[];
  factRequirements(input: Input, data: Data): readonly FactRequirement[];
  deriveConclusions(
    input: Input,
    data: Data,
    facts: ReadonlyMap<string, ObservedFact>,
  ): readonly ConclusionDraft[];
  deriveWarnings(
    input: Input,
    data: Data,
    facts: ReadonlyMap<string, ObservedFact>,
  ): readonly WarningRequirement[];
  validateIntrinsicData(data: Data, context: IntrinsicDataValidationContext): void;
  validateDataContext(data: Data, context: DataValidationContext): void;
  validateInvocation(input: Input, data: Data, context: InvocationValidationContext): void;
  readonly warningCodes: readonly Warning["code"][];
  readonly staticScopeExclusions: readonly StaticScopeExclusion[];
}

export type AnyReadCapabilityDefinition = ReadCapabilityDefinition<unknown, unknown>;

const definitionInternals = new WeakMap<object, InternalReadCapabilityDefinition<unknown, unknown>>();

const internalDefinition = <Input, Data>(
  definition: ReadCapabilityDefinition<Input, Data>,
): InternalReadCapabilityDefinition<Input, Data> => {
  const internal = typeof definition === "object" && definition !== null
    ? definitionInternals.get(definition)
    : undefined;
  if (internal === undefined) throw new TypeError("Capability definition provenance is invalid.");
  return internal as InternalReadCapabilityDefinition<Input, Data>;
};

const safeNormalize = (input: unknown): { readonly ok: true; readonly value: CanonicalJson } | { readonly ok: false } => {
  try {
    return { ok: true, value: captureCanonicalJson(input) };
  } catch {
    return { ok: false };
  }
};

const pathToJsonPointer = (path: readonly PropertyKey[]): string =>
  path.length === 0
    ? ""
    : `/${path.map((part) => String(part).replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;

const issuePathBelongsToInput = (path: string, input: unknown): boolean => {
  if (path === "") return true;
  let current = input;
  for (const encoded of path.slice(1).split("/")) {
    const segment = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    if (typeof current !== "object" || current === null) return false;
    let property = segment;
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(segment)) return false;
      const index = Number(segment);
      if (!Number.isSafeInteger(index) || index >= current.length) return false;
      property = String(index);
    }
    const descriptor = Object.getOwnPropertyDescriptor(current, property);
    if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) return false;
    current = descriptor.value;
  }
  return true;
};

const zodIssues = (error: z.ZodError): FieldIssue[] =>
  error.issues
    .map((issue) => createFieldIssue("invalid_value", pathToJsonPointer(issue.path)))
    .sort((left, right) => {
      const pathOrder = compareCodePointSequences(left.path, right.path);
      return pathOrder === 0 ? compareCodePointSequences(left.code, right.code) : pathOrder;
    });

const createSuccessSchema = <Data>(capabilityId: CapabilityId, dataSchema: ZodType<Data>) =>
  jsonObject({
      ok: z.literal(true),
      meta: jsonObject({
          capabilityId: z.literal(capabilityId),
          contractVersion: z.literal(coreContractVersion),
          chainId: z.literal(robinhoodChainIdentity.chainId),
          evaluatedAt: binderPrimitiveSchemas.utcTimestamp,
        })
        .strict(),
      data: dataSchema,
      evidence: jsonObject({
          sources: z.array(binderEvidenceSchemas.evidenceSource).max(128),
          conclusions: z.array(binderEvidenceSchemas.conclusion).max(64),
          coverage: binderEvidenceSchemas.coverage,
        })
        .strict(),
      warnings: z.array(binderEvidenceSchemas.warning).max(64),
    })
    .strict();

const handlerEnvelopeSchema = z.discriminatedUnion("status", [
    jsonObject({
        status: z.literal("success"),
        data: z.unknown(),
      })
      .strict(),
    jsonObject({
        status: z.literal("failure"),
        code: binderPrimitiveSchemas.snakeCaseCode,
        issues: z.array(binderEvidenceSchemas.fieldIssue).max(64),
      })
      .strict(),
  ]);
type HandlerEnvelope = z.output<typeof handlerEnvelopeSchema>;
type ParsedHandlerResult<Data> =
  | (Omit<Extract<HandlerEnvelope, { status: "success" }>, "data"> & { readonly data: Data })
  | Extract<HandlerEnvelope, { status: "failure" }>;

const canonicalUnique = (values: readonly string[]): readonly string[] => Object.freeze(sortUniqueStrings(values));

const conclusionAddressMarker = "<address>";

const compileConclusionIdMatcher = (declaration: string): ((value: string) => boolean) => {
  const markerIndex = declaration.indexOf(conclusionAddressMarker);
  if (markerIndex < 0) {
    if (declaration.includes("<") || declaration.includes(">")) {
      throw new TypeError("Conclusion identity contains an undeclared placeholder.");
    }
    return (value) => value === declaration;
  }
  if (
    declaration.indexOf(conclusionAddressMarker, markerIndex + conclusionAddressMarker.length) >= 0 ||
    declaration.replace(conclusionAddressMarker, "").includes("<") ||
    declaration.replace(conclusionAddressMarker, "").includes(">")
  ) throw new TypeError("Conclusion identity placeholder is ambiguous.");
  const prefix = declaration.slice(0, markerIndex);
  const suffix = declaration.slice(markerIndex + conclusionAddressMarker.length);
  return (value) => {
    if (!value.startsWith(prefix) || !value.endsWith(suffix)) return false;
    const end = value.length - suffix.length;
    if (end < prefix.length) return false;
    return binderPrimitiveSchemas.evmAddress.safeParse(value.slice(prefix.length, end)).success;
  };
};

export interface CapabilityDefinitionSnapshot {
  readonly capabilityId: CapabilityId;
  readonly contractVersion: typeof coreContractVersion;
  readonly chain: typeof robinhoodChainIdentity;
  readonly failureCodes: readonly SnakeCaseCode[];
  readonly inputSchema: CanonicalJson;
  readonly dataSchema: CanonicalJson;
  readonly successSchema: CanonicalJson;
  readonly conclusionIds: readonly string[];
  readonly warningCodes: readonly Warning["code"][];
  readonly staticScopeExclusions: readonly StaticScopeExclusion[];
}

interface InternalDefinitionRecord<Input, Data> extends InternalReadCapabilityDefinition<Input, Data> {
  readonly inputParser: (value: unknown) => z.ZodSafeParseResult<Input>;
  readonly dataParser: (value: unknown) => z.ZodSafeParseResult<Data>;
  readonly successParser: (value: unknown) => z.ZodSafeParseResult<CapabilitySuccess<Data>>;
  readonly snapshot: CapabilityDefinitionSnapshot;
}

const structuralSchemaSnapshot = (schema: ZodType, io: "input" | "output"): CanonicalJson =>
  deepFreezeValue(JSON.parse(canonicalJsonStringify(JSON.parse(JSON.stringify(z.toJSONSchema(schema, {
    target: "draft-2020-12",
    unrepresentable: "throw",
    io,
  }))) as CanonicalJson)) as CanonicalJson);

const definitionRecord = <Input, Data>(
  definition: ReadCapabilityDefinition<Input, Data>,
): InternalDefinitionRecord<Input, Data> => {
  const record = internalDefinition(definition) as InternalDefinitionRecord<Input, Data>;
  return record;
};

export const getCapabilityDefinitionSnapshot = (
  definition: AnyReadCapabilityDefinition,
): CapabilityDefinitionSnapshot => definitionRecord(definition).snapshot;

export const parseCapabilityInput = <Definition extends AnyReadCapabilityDefinition>(
  definition: Definition,
  value: unknown,
): CapabilityInput<Definition> => {
  const parsed = definitionRecord(definition).inputParser(value);
  if (!parsed.success) throw parsed.error;
  return parsed.data as CapabilityInput<Definition>;
};

export const safeParseCapabilityInput = <Definition extends AnyReadCapabilityDefinition>(
  definition: Definition,
  value: unknown,
): z.ZodSafeParseResult<CapabilityInput<Definition>> =>
  definitionRecord(definition).inputParser(value) as z.ZodSafeParseResult<CapabilityInput<Definition>>;

export const parseCapabilityData = <Definition extends AnyReadCapabilityDefinition>(
  definition: Definition,
  value: unknown,
): CapabilityData<Definition> => {
  const parsed = definitionRecord(definition).dataParser(value);
  if (!parsed.success) throw parsed.error;
  return parsed.data as CapabilityData<Definition>;
};

export const safeParseCapabilityData = <Definition extends AnyReadCapabilityDefinition>(
  definition: Definition,
  value: unknown,
): z.ZodSafeParseResult<CapabilityData<Definition>> =>
  definitionRecord(definition).dataParser(value) as z.ZodSafeParseResult<CapabilityData<Definition>>;

export const parseCapabilitySuccess = <Definition extends AnyReadCapabilityDefinition>(
  definition: Definition,
  value: unknown,
): CapabilitySuccess<CapabilityData<Definition>> => {
  const record = definitionRecord(definition);
  const parsed = record.successParser(value);
  if (!parsed.success) throw parsed.error;
  const parsedData = record.dataParser(parsed.data.data);
  if (!parsedData.success) throw parsedData.error;
  record.validateDataContext(parsedData.data, {
    evaluatedAt: parsed.data.meta.evaluatedAt,
  });
  return deepFreezeValue({
    ...parsed.data,
    data: parsedData.data,
  }) as CapabilitySuccess<CapabilityData<Definition>>;
};

export const parseCapabilityDataAt = <Definition extends AnyReadCapabilityDefinition>(
  definition: Definition,
  value: unknown,
  evaluatedAtInput: unknown,
): CapabilityData<Definition> => {
  const record = definitionRecord(definition);
  const parsed = record.dataParser(value);
  if (!parsed.success) throw parsed.error;
  const evaluatedAt = binderPrimitiveSchemas.utcTimestamp.parse(evaluatedAtInput);
  record.validateDataContext(parsed.data, { evaluatedAt });
  return parsed.data as CapabilityData<Definition>;
};

const validateDefinitionStructure = <Input>(
  slots: readonly ObservationSlot[],
  requirements: readonly FactRequirement[],
): void => {
  const slotIds = canonicalUnique(slots.map((slot) => slot.slotId));
  const factIds = canonicalUnique(requirements.map((requirement) => requirement.factId));
  if (slotIds.length !== slots.length || factIds.length !== requirements.length) throw new TypeError("Duplicate definition identity.");
  const slotById = new Map(slots.map((slot) => [slot.slotId, slot]));
  const requirementByFactId = new Map(requirements.map((requirement) => [requirement.factId, requirement]));
  for (const requirement of requirements) {
    const ordered = canonicalUnique(requirement.observationSlotIds);
    if (ordered.length !== requirement.observationSlotIds.length) throw new TypeError("Duplicate fact observation slot.");
    const required = canonicalUnique(requirement.requiredObservationSlotIds);
    if (required.length !== requirement.requiredObservationSlotIds.length) {
      throw new TypeError("Duplicate required fact observation slot.");
    }
    if (
      !Number.isSafeInteger(requirement.minimumObservationCount) ||
      requirement.minimumObservationCount < required.length ||
      requirement.minimumObservationCount > ordered.length
    ) throw new TypeError("Fact observation cardinality is invalid.");
    for (const slotId of ordered) {
      const slot = slotById.get(slotId);
      if (slot === undefined || slot.factId !== requirement.factId) throw new TypeError("Fact requirement does not own its observation slot.");
    }
    const authorityKind = factOutcomeDefinitions[requirement.outcome].evidenceAuthority === "validated_input"
      ? "validated_input"
      : "source";
    if (ordered.some((slotId) => slotById.get(slotId)?.kind !== authorityKind)) {
      throw new TypeError("Fact requirement mixes observation authorities.");
    }
    for (const slotId of required) {
      if (!ordered.includes(slotId)) throw new TypeError("Required observation slot is not allowed by its fact.");
    }
  }
  for (const slot of slots) {
    const requirement = requirementByFactId.get(slot.factId);
    if (requirement === undefined || !requirement.observationSlotIds.includes(slot.slotId)) {
      throw new TypeError("Observation slot has no owning fact requirement.");
    }
  }
};

class ImmutableFactProjection implements ReadonlyMap<string, ObservedFact> {
  readonly #facts: Map<string, ObservedFact>;

  constructor(facts: ReadonlyMap<string, ObservedFact>) {
    this.#facts = new Map(facts);
    Object.freeze(this);
  }

  get size(): number {
    return this.#facts.size;
  }

  get(key: string): ObservedFact | undefined {
    return this.#facts.get(key);
  }

  has(key: string): boolean {
    return this.#facts.has(key);
  }

  entries(): MapIterator<[string, ObservedFact]> {
    return this.#facts.entries();
  }

  keys(): MapIterator<string> {
    return this.#facts.keys();
  }

  values(): MapIterator<ObservedFact> {
    return this.#facts.values();
  }

  forEach(
    callbackfn: (value: ObservedFact, key: string, map: ReadonlyMap<string, ObservedFact>) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.#facts) callbackfn.call(thisArg, value, key, this);
  }

  [Symbol.iterator](): MapIterator<[string, ObservedFact]> {
    return this.entries();
  }

  get [Symbol.toStringTag](): string {
    return "ImmutableFactProjection";
  }
}

export const defineReadCapability = <Input, Data>(options: {
  readonly capabilityId: string;
  readonly inputSchema: ZodType<Input>;
  readonly dataSchema: ZodType<Data>;
  readonly normalizeInput?: (input: Input) => Input;
  readonly conclusionIds: readonly string[];
  readonly expectedConclusionIds?: (input: Input, data: Data) => readonly string[];
  readonly observationSlots: (input: Input) => readonly ObservationSlot[];
  readonly observationExpectations: (input: Input, data: Data) => readonly ObservationExpectation[];
  readonly factRequirements: (input: Input, data: Data) => readonly FactRequirement[];
  readonly deriveConclusions: InternalReadCapabilityDefinition<Input, Data>["deriveConclusions"];
  readonly deriveWarnings: InternalReadCapabilityDefinition<Input, Data>["deriveWarnings"];
  readonly validateIntrinsicData?: InternalReadCapabilityDefinition<Input, Data>["validateIntrinsicData"];
  readonly validateDataContext?: InternalReadCapabilityDefinition<Input, Data>["validateDataContext"];
  readonly validateInvocation: InternalReadCapabilityDefinition<Input, Data>["validateInvocation"];
  readonly failureCodes: readonly string[];
  readonly warningCodes: readonly Warning["code"][];
  readonly staticScopeExclusions: readonly StaticScopeExclusion[];
}) => {
  const capabilityId = capabilityIdAuthoritySchema.parse(options.capabilityId);
  const failureCodeInput = options.failureCodes.map((code) => binderPrimitiveSchemas.snakeCaseCode.parse(code));
  const failureCodes = canonicalUnique(failureCodeInput) as readonly SnakeCaseCode[];
  if (failureCodes.length !== failureCodeInput.length) throw new TypeError("Duplicate capability failure code.");
  if (!failureCodes.includes("invalid_input" as SnakeCaseCode) ||
    !failureCodes.includes("internal_error" as SnakeCaseCode)) {
    throw new TypeError("Capability failure codes must include canonical boundary failures.");
  }
  const conclusionIdInput = options.conclusionIds.map((id) => binderPrimitiveSchemas.fixedIdentifier.parse(id));
  const conclusionIds = canonicalUnique(conclusionIdInput);
  if (conclusionIds.length !== conclusionIdInput.length) throw new TypeError("Duplicate conclusion identity.");
  const conclusionIdMatchers = Object.freeze(conclusionIds.map(compileConclusionIdMatcher));
  if (options.expectedConclusionIds === undefined && conclusionIds.some((id) => id.includes(conclusionAddressMarker))) {
    throw new TypeError("Parameterized conclusions require an exact identity producer.");
  }
  for (let index = 0; index < conclusionIds.length; index += 1) {
    for (let other = index + 1; other < conclusionIds.length; other += 1) {
      if (conclusionIdMatchers[index]?.(conclusionIds[other] ?? "") === true ||
        conclusionIdMatchers[other]?.(conclusionIds[index] ?? "") === true) {
        throw new TypeError("Conclusion identity declarations overlap.");
      }
    }
  }
  const warningCodeInput = options.warningCodes.map((code) => binderEvidenceSchemas.warningCode.parse(code));
  const warningCodes = canonicalUnique(warningCodeInput) as readonly Warning["code"][];
  if (warningCodes.length !== warningCodeInput.length) throw new TypeError("Duplicate warning code.");
  const staticScopeExclusions = options.staticScopeExclusions
    .map((entry) => binderEvidenceSchemas.staticScopeExclusion.parse(entry) as StaticScopeExclusion)
    .sort((left, right) => compareCodePointSequences(left.id, right.id));
  if (canonicalUnique(staticScopeExclusions.map((entry) => entry.id)).length !== staticScopeExclusions.length) {
    throw new TypeError("Duplicate static scope exclusion.");
  }
  const staticScopeById = new Map<string, StaticScopeExclusion>(
    staticScopeExclusions.map((entry): [string, StaticScopeExclusion] => [entry.id, entry]),
  );
  const intrinsicContext: IntrinsicDataValidationContext = Object.freeze({
    assertDeclaredScopeExclusion(exclusion: StaticScopeExclusion): void {
      const declared = staticScopeById.get(exclusion.id);
      if (declared === undefined || declared.message !== exclusion.message) {
        throw new TypeError("Data meaning uses an undeclared static scope exclusion.");
      }
    },
  });
  const successSchema = createSuccessSchema(capabilityId, options.dataSchema);
  const inputSchemaSnapshot = structuralSchemaSnapshot(options.inputSchema, "input");
  const dataSchemaSnapshot = structuralSchemaSnapshot(options.dataSchema, "output");
  const successSchemaSnapshot = structuralSchemaSnapshot(successSchema, "output");
  const normalizeInput = options.normalizeInput ?? ((input: Input): Input => input);
  const structuralFailure = <Value>(path: readonly PropertyKey[]): z.ZodSafeParseResult<Value> => ({
    success: false,
    error: new z.ZodError([{
      code: "custom",
      path: [...path],
      message: "The canonical structural contract is invalid.",
    }]) as z.ZodError<Value>,
  });
  const inputParser = (value: unknown): z.ZodSafeParseResult<Input> => {
    const normalized = safeNormalize(value);
    if (!normalized.ok) return structuralFailure([]);
    const parsed = options.inputSchema.safeParse(normalized.value);
    if (!parsed.success) return parsed;
    try {
      const canonical = safeNormalize(normalizeInput(deepFreezeValue(parsed.data)));
      if (!canonical.ok) return structuralFailure([]);
      return options.inputSchema.safeParse(canonical.value);
    } catch {
      return structuralFailure([]);
    }
  };
  const dataParser = (value: unknown): z.ZodSafeParseResult<Data> => {
    const normalized = safeNormalize(value);
    if (!normalized.ok) return structuralFailure([]);
    const parsed = options.dataSchema.safeParse(normalized.value);
    if (!parsed.success) return parsed;
    const data = deepFreezeValue(parsed.data);
    try {
      options.validateIntrinsicData?.(data, intrinsicContext);
      return { success: true, data };
    } catch {
      return structuralFailure([]);
    }
  };
  const successParser = (value: unknown): z.ZodSafeParseResult<CapabilitySuccess<Data>> => {
    const normalized = safeNormalize(value);
    if (!normalized.ok) return structuralFailure([]);
    return successSchema.safeParse(normalized.value) as z.ZodSafeParseResult<CapabilitySuccess<Data>>;
  };
  const snapshot = deepFreezeValue({
    capabilityId,
    contractVersion: coreContractVersion,
    chain: robinhoodChainIdentity,
    failureCodes,
    inputSchema: inputSchemaSnapshot,
    dataSchema: dataSchemaSnapshot,
    successSchema: successSchemaSnapshot,
    conclusionIds,
    warningCodes,
    staticScopeExclusions: Object.freeze(staticScopeExclusions.map((entry) => Object.freeze(entry))),
  });
  const internal: InternalDefinitionRecord<Input, Data> = Object.freeze({
    capabilityId,
    contractVersion: coreContractVersion,
    failureCodes,
    conclusionIds,
    conclusionIdMatchers,
    expectedConclusionIds: options.expectedConclusionIds ?? (() => conclusionIds),
    observationSlots: options.observationSlots,
    observationExpectations: options.observationExpectations,
    factRequirements: options.factRequirements,
    deriveConclusions: options.deriveConclusions,
    deriveWarnings: options.deriveWarnings,
    validateIntrinsicData: options.validateIntrinsicData ?? (() => undefined),
    validateDataContext: options.validateDataContext ?? (() => undefined),
    validateInvocation: options.validateInvocation,
    warningCodes,
    staticScopeExclusions: snapshot.staticScopeExclusions,
    inputParser,
    dataParser,
    successParser,
    snapshot,
  });
  const definition = Object.freeze({}) as ReadCapabilityDefinition<Input, Data>;
  definitionInternals.set(definition, internal as InternalDefinitionRecord<unknown, unknown>);
  return definition;
};

export class CapabilityRegistry {
  readonly #definitions: ReadonlyMap<string, AnyReadCapabilityDefinition>;

  constructor(definitions: readonly AnyReadCapabilityDefinition[]) {
    const map = new Map<string, AnyReadCapabilityDefinition>();
    for (const definition of definitions) {
      const record = definitionRecord(definition);
      if (map.has(record.capabilityId)) throw new TypeError("Duplicate capability identifier.");
      map.set(record.capabilityId, definition);
    }
    this.#definitions = map;
    Object.freeze(this);
  }

  get(capabilityId: string): AnyReadCapabilityDefinition {
    const definition = this.#definitions.get(capabilityId);
    if (definition === undefined) throw new TypeError("Unknown capability identifier.");
    return definition;
  }

  values(): readonly AnyReadCapabilityDefinition[] {
    return Object.freeze([...this.#definitions.values()].sort((left, right) =>
      compareCodePointSequences(
        definitionRecord(left).capabilityId,
        definitionRecord(right).capabilityId,
      )));
  }

  owns(definition: AnyReadCapabilityDefinition): boolean {
    const record = definitionRecord(definition);
    return this.#definitions.get(record.capabilityId) === definition;
  }
}

const sourceIdOf = (reference: EvidenceSource["reference"]): string => reference.sourceId;

const observationIdFor = (
  sourceId: string,
  purpose: string,
  observedAt: UtcTimestamp,
  chainAnchor: ChainAnchor | undefined,
  invocationId: InvocationId,
  invocationOrdinal: string,
): ObservationId => {
  const anchor = chainAnchor === undefined ? null : chainAnchor as unknown as CanonicalJson;
  const digest = createHash(sha256Algorithm)
    .update(canonicalJsonStringify([sourceId, purpose, observedAt, anchor, invocationId, invocationOrdinal]), "utf8")
    .digest("base64url");
  return binderEvidenceSchemas.observationId.parse(`obs:${digest}`);
};

class InvocationObservations implements ObservationWriter {
  readonly #clock: CanonicalClock;
  readonly #authorities: ObservationAuthorityRegistry;
  readonly #invocationId: InvocationId;
  readonly #slots: ReadonlyMap<string, ObservationSlot & { readonly ordinal: string }>;
  readonly #evidence = new Map<string, EvidenceSource>();
  readonly #claims = new Map<string, readonly ObservationClaim[]>();
  readonly #bindings: ObservationClaimBinding[] = [];

  constructor(
    capabilityId: CapabilityId,
    slots: readonly (ObservationSlot & { readonly ordinal: string })[],
    input: unknown,
    invocationId: InvocationId,
    clock: CanonicalClock,
    authorities: ObservationAuthorityRegistry,
  ) {
    this.#clock = clock;
    this.#invocationId = invocationId;
    this.#authorities = authorities;
    const map = new Map<string, ObservationSlot & { readonly ordinal: string }>();
    for (const slot of slots) map.set(slot.slotId, slot);
    this.#slots = map;
    for (const slot of map.values()) {
      if (slot.kind === "validated_input") {
        this.#recordDetails(slot.slotId, {
          sourceClass: "validated_input",
          owner: `${productDisplayName} validated input`,
          observedAt: readCanonicalClock(clock),
          reference: {
            kind: "validated_input",
            sourceId: `input:${capabilityId}` as EvidenceSource["reference"]["sourceId"],
          } as EvidenceSource["reference"],
          claims: [{ role: "validated_input", value: input as CanonicalJson }],
        });
      }
    }
  }

  record(slotId: string, observation: {
    readonly source: ObservationAuthority;
    readonly claims: readonly ObservationClaim[];
  }): ObservationId {
    const source = readObservationAuthority(observation.source, this.#clock);
    if (!this.#authorities.owns(source.sourceClass, observation.source)) {
      throw new TypeError("Observation authority is not registered for this invocation.");
    }
    return this.#recordDetails(slotId, {
      ...source,
      observedAt: readCanonicalClock(this.#clock),
      claims: observation.claims,
    });
  }

  #recordDetails(slotId: string, detailsInput: {
    readonly sourceClass: SourceClass;
    readonly owner: string;
    readonly observedAt: UtcTimestamp;
    readonly reference: EvidenceSource["reference"];
    readonly claims: readonly ObservationClaim[];
  }): ObservationId {
    const slot = this.#slots.get(slotId);
    if (slot === undefined || this.#evidence.has(slotId)) throw new TypeError("Observation slot is invalid or complete.");
    const claims = detailsInput.claims.map((candidate) => {
      const role = binderPrimitiveSchemas.fixedIdentifier.parse(candidate.role);
      const value = JSON.parse(canonicalJsonStringify(candidate.value)) as CanonicalJson;
      return deepFreezeValue({
        role,
        value,
        ...(candidate.chainAnchor === undefined ? {} : { chainAnchor: binderPrimitiveSchemas.chainAnchor.parse(candidate.chainAnchor) }),
        ...(candidate.asset === undefined ? {} : { asset: binderAmountSchemas.assetIdentity.parse(candidate.asset) }),
      });
    }).sort((left, right) => compareCodePointSequences(left.role, right.role));
    if (claims.length === 0 || claims.length > 8_192) throw new TypeError("An observation requires bounded claims.");
    canonicalUnique(claims.map((claim) => claim.role));
    const anchors = claims.flatMap((claim) => claim.chainAnchor === undefined ? [] : [claim.chainAnchor]);
    const chainAnchor = anchors[0];
    if (anchors.some((candidate) => canonicalJsonStringify(candidate as unknown as CanonicalJson) !==
      canonicalJsonStringify(chainAnchor as unknown as CanonicalJson))) {
      throw new TypeError("One observation cannot bind multiple chain anchors.");
    }
    const details = {
      observedAt: binderPrimitiveSchemas.utcTimestamp.parse(detailsInput.observedAt),
      owner: detailsInput.owner,
      reference: detailsInput.reference,
      claims: Object.freeze(claims),
      ...(chainAnchor === undefined ? {} : { chainAnchor }),
    };
    const expectedClass = slot.kind === "validated_input" ? "validated_input" : slot.sourceClass;
    if (expectedClass !== detailsInput.sourceClass) throw new TypeError("Observation source class is inconsistent.");
    const observationId = observationIdFor(
      sourceIdOf(details.reference),
      slot.purpose,
      details.observedAt,
      details.chainAnchor,
      this.#invocationId,
      slot.ordinal,
    );
    const evidence = deepFreezeValue({
      observationId,
      invocationId: this.#invocationId,
      sourceClass: expectedClass,
      owner: details.owner,
      purpose: slot.purpose,
      observedAt: details.observedAt,
      reference: details.reference,
      ...(details.chainAnchor === undefined ? {} : { chainAnchor: details.chainAnchor }),
    }) as EvidenceSource;
    this.#evidence.set(slotId, evidence);
    this.#claims.set(slotId, details.claims);
    for (const claim of details.claims) {
      this.#bindings.push(Object.freeze({ observationId, ...claim }));
    }
    return observationId;
  }

  assertObservedNoLaterThan(evaluatedAt: UtcTimestamp): void {
    for (const evidence of this.#evidence.values()) {
      if (evidence.observedAt > evaluatedAt) throw new TypeError("Observation time exceeds evaluation time.");
    }
  }

  get(slotId: string): ObservationId | undefined {
    return this.#evidence.get(slotId)?.observationId;
  }

  hasObservation(observationId: string): boolean {
    for (const evidence of this.#evidence.values()) if (evidence.observationId === observationId) return true;
    return false;
  }

  slotFactId(observationId: string): string | undefined {
    for (const [slotId, evidence] of this.#evidence) {
      if (evidence.observationId === observationId) return this.#slots.get(slotId)?.factId;
    }
    return undefined;
  }

  evidence(): readonly EvidenceSource[] {
    const evidence = [...this.#evidence.values()];
    if (evidence.some((source) => source.invocationId !== this.#invocationId)) {
      throw new TypeError("Evidence source invocation identity is inconsistent.");
    }
    return Object.freeze(evidence.sort((left, right) =>
      compareCodePointSequences(left.observationId, right.observationId)));
  }

  evidenceFor(observationId: string): EvidenceSource | undefined {
    for (const evidence of this.#evidence.values()) if (evidence.observationId === observationId) return evidence;
    return undefined;
  }

  hasSlot(slotId: string): boolean {
    return this.#evidence.has(slotId);
  }

  assertExpectations(expectationsInput: readonly ObservationExpectation[]): void {
    const expectations = new Map<string, readonly ObservationClaim[]>();
    for (const expectation of expectationsInput) {
      if (!this.#slots.has(expectation.slotId) || expectations.has(expectation.slotId)) {
        throw new TypeError("Observation expectation identity is invalid.");
      }
      const normalized = expectation.claims.map((claim) => ({
        role: binderPrimitiveSchemas.fixedIdentifier.parse(claim.role),
        value: JSON.parse(canonicalJsonStringify(claim.value)) as CanonicalJson,
        ...(claim.chainAnchor === undefined ? {} : { chainAnchor: binderPrimitiveSchemas.chainAnchor.parse(claim.chainAnchor) }),
        ...(claim.asset === undefined ? {} : { asset: binderAmountSchemas.assetIdentity.parse(claim.asset) }),
      })).sort((left, right) => compareCodePointSequences(left.role, right.role));
      canonicalUnique(normalized.map((claim) => claim.role));
      expectations.set(expectation.slotId, normalized);
    }
    for (const [slotId, actual] of this.#claims) {
      const expected = expectations.get(slotId);
      if (
        expected === undefined ||
        canonicalJsonStringify(actual as unknown as CanonicalJson) !==
          canonicalJsonStringify(expected as unknown as CanonicalJson)
      ) throw new TypeError("Observation claims do not match the capability definition.");
    }
  }

  bindings(): readonly ObservationClaimBinding[] {
    return Object.freeze([...this.#bindings]);
  }
}

const normalizeHandlerResult = <Data>(
  value: unknown,
  parseData: (value: unknown) => z.ZodSafeParseResult<Data>,
): ParsedHandlerResult<Data> | null => {
  const normalized = safeNormalize(value);
  if (!normalized.ok) return null;
  const envelope = handlerEnvelopeSchema.safeParse(normalized.value);
  if (!envelope.success) return null;
  if (envelope.data.status === "failure") return envelope.data;
  const data = parseData(envelope.data.data);
  return data.success ? { ...envelope.data, data: data.data } : null;
};

const internalFailure = (registry: ApplicationErrorRegistry): ApplicationFailure =>
  createApplicationFailure(registry, "internal_error");

const conclusionOutcome = (outcome: FactOutcome): Pick<Conclusion, "status" | "reason"> =>
  ({ status: factOutcomeDefinitions[outcome].conclusionStatus, reason: outcome });

const assertConclusionFreshness = (
  draft: ConclusionDraft,
  sources: readonly EvidenceSource[],
): void => {
  if (sources.length === 0) throw new TypeError("Conclusion freshness requires evidence.");
  const rule = freshnessRuleDefinitions[draft.freshnessRuleId];
  if (sources.some((source) => !rule.sourceClasses.includes(source.sourceClass as never))) {
    throw new TypeError("Conclusion freshness source is invalid.");
  }
  if ("exactSourceCount" in rule && sources.length !== rule.exactSourceCount) {
    throw new TypeError("Conclusion freshness source count is invalid.");
  }
  if ("purpose" in rule && sources.some((source) => source.purpose !== rule.purpose)) {
    throw new TypeError("Conclusion freshness source purpose is invalid.");
  }
  if (rule.anchor === "consistent_present") {
    const anchors = sources.flatMap((source) => source.chainAnchor === undefined ? [] : [source.chainAnchor]);
    if (anchors.length === 0) throw new TypeError("Chain freshness requires an anchor.");
    const expected = canonicalJsonStringify(anchors[0] as unknown as CanonicalJson);
    if (anchors.some((anchor) => canonicalJsonStringify(anchor as unknown as CanonicalJson) !== expected)) {
      throw new TypeError("Chain freshness contains conflicting anchors.");
    }
    return;
  }
  if (rule.anchor === "absent" && sources.some((source) => source.chainAnchor !== undefined)) {
    throw new TypeError("Conclusion freshness must not claim a chain anchor.");
  }
};

declare const capabilityBindingType: unique symbol;
export interface CapabilityBinding<Definition extends AnyReadCapabilityDefinition> {
  readonly [capabilityBindingType]: Definition;
}

type AnyCapabilityBinding = CapabilityBinding<AnyReadCapabilityDefinition>;

interface BindingRecord<
  Definition extends AnyReadCapabilityDefinition,
  Ports extends InvocationBoundaryPorts,
> {
  readonly definition: Definition;
  readonly errorRegistry: ApplicationErrorRegistry;
  readonly invocationAuthority: CapabilityInvocationAuthority;
  readonly createInvocationPorts: (input: CapabilityInput<Definition>) => Ports;
  readonly handler: (
    input: CapabilityInput<Definition>,
    context: HandlerInvocationContext<Ports>,
    observations: ObservationWriter,
  ) => Promise<unknown>;
}

const captureBindingRecord = <
  Definition extends AnyReadCapabilityDefinition,
  Ports extends InvocationBoundaryPorts,
>(input: BindingRecord<Definition, Ports>): BindingRecord<Definition, Ports> => {
  try {
    if (Reflect.getPrototypeOf(input) !== Object.prototype) {
      throw new TypeError();
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const expectedKeys = [
      "definition",
      "errorRegistry",
      "invocationAuthority",
      "createInvocationPorts",
      "handler",
    ] as const;
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key as never))
    ) {
      throw new TypeError();
    }
    for (const key of expectedKeys) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
      ) {
        throw new TypeError();
      }
    }
    const definition = descriptors.definition?.value as Definition;
    const errorRegistry = descriptors.errorRegistry?.value as ApplicationErrorRegistry;
    const invocationAuthority = descriptors.invocationAuthority?.value as CapabilityInvocationAuthority;
    const createInvocationPorts = descriptors.createInvocationPorts?.value as (
      (input: CapabilityInput<Definition>) => Ports
    );
    const handler = descriptors.handler?.value as BindingRecord<Definition, Ports>["handler"];
    if (typeof createInvocationPorts !== "function" || typeof handler !== "function") {
      throw new TypeError();
    }
    return Object.freeze({
      definition,
      errorRegistry,
      invocationAuthority,
      createInvocationPorts,
      handler,
    });
  } catch {
    throw new TypeError("Capability binding options are invalid.");
  }
};

const bindingInternals = new WeakMap<object, BindingRecord<AnyReadCapabilityDefinition, InvocationBoundaryPorts>>();

const captureInvocationPorts = <Ports extends InvocationBoundaryPorts>(ports: Ports): Ports => {
  if (typeof ports !== "object" || ports === null) throw new TypeError("Invocation ports are invalid.");
  const prototype = Reflect.getPrototypeOf(ports);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError("Invocation ports must be a plain object.");
  const descriptors = Object.getOwnPropertyDescriptors(ports);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key === "symbol")) throw new TypeError("Invocation ports cannot use symbol keys.");
  const captured: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError("Invocation ports must use enumerable data properties.");
    }
    captured[key] = descriptor.value;
  }
  return Object.freeze(captured) as Ports;
};

const prepareObservationSlots = (
  slots: readonly ObservationSlot[],
): readonly (ObservationSlot & { readonly ordinal: string })[] => {
  if (canonicalUnique(slots.map((slot) => slot.slotId)).length !== slots.length) {
    throw new TypeError("Duplicate observation slot identity.");
  }
  return Object.freeze(slots.map((slot, index) => Object.freeze({
    ...slot,
    ordinal: String(index),
  })));
};

export const bindCapability = <
  Definition extends AnyReadCapabilityDefinition,
  Ports extends InvocationBoundaryPorts,
>(options: BindingRecord<Definition, Ports>): CapabilityBinding<Definition> => {
  const record = captureBindingRecord(options);
  const definition = definitionRecord(record.definition);
  assertApplicationErrorRegistry(record.errorRegistry);
  try {
    for (const code of definition.failureCodes) record.errorRegistry.get(code);
  } catch {
    throw new TypeError("Capability error registry does not cover the declared failure codes.");
  }
  assertCapabilityInvocationAuthority(record.invocationAuthority);
  const binding = Object.freeze({}) as CapabilityBinding<Definition>;
  bindingInternals.set(
    binding,
    record as unknown as BindingRecord<AnyReadCapabilityDefinition, InvocationBoundaryPorts>,
  );
  return binding;
};

const executeCapabilityBinding = async <Definition extends AnyReadCapabilityDefinition>(
  record: BindingRecord<Definition, InvocationBoundaryPorts>,
  input: unknown,
  signal: AbortSignal,
): Promise<CapabilitySuccess<CapabilityData<Definition>> | ApplicationFailure> => {
  const definition = definitionRecord(record.definition) as InternalDefinitionRecord<
    CapabilityInput<Definition>,
    CapabilityData<Definition>
  >;
  const normalizedInput = safeNormalize(input);
  if (!normalizedInput.ok) return createApplicationFailure(record.errorRegistry, "invalid_input");
  const parsedInput = definition.inputParser(normalizedInput.value);
  if (!parsedInput.success) {
    return createApplicationFailure(record.errorRegistry, "invalid_input", zodIssues(parsedInput.error));
  }
  const validatedInput = deepFreezeValue(parsedInput.data);

  let invocationId: InvocationId;
  let slots: readonly (ObservationSlot & { readonly ordinal: string })[];
  try {
    invocationId = binderEvidenceSchemas.invocationId.parse(
      `inv:${randomBytes(32).toString("base64url")}`,
    );
    slots = prepareObservationSlots(parseDefinitionArray(
      observationSlotAuthoritySchema,
      definition.observationSlots(validatedInput),
    ) as readonly ObservationSlot[]);
  } catch {
    return internalFailure(record.errorRegistry);
  }

  let context: HandlerInvocationContext<InvocationBoundaryPorts>;
  try {
    const ports = captureInvocationPorts(record.createInvocationPorts(validatedInput));
    context = createHandlerInvocationContext({
      authority: record.invocationAuthority,
      signal,
      ports,
    });
  } catch {
    return internalFailure(record.errorRegistry);
  }

  let observations: InvocationObservations;
  try {
    observations = new InvocationObservations(
      definition.capabilityId,
      slots,
      validatedInput,
      invocationId,
      context.clock,
      context.ports.observations,
    );
  } catch {
    return internalFailure(record.errorRegistry);
  }

  let rawResult: unknown;
  try {
    rawResult = await record.handler(validatedInput, context, observations);
  } catch {
    return internalFailure(record.errorRegistry);
  }
  const result = normalizeHandlerResult(rawResult, definition.dataParser);
  if (result === null) return internalFailure(record.errorRegistry);
  if (result.status === "failure") {
    try {
      if (!definition.failureCodes.includes(result.code as SnakeCaseCode)) {
        return internalFailure(record.errorRegistry);
      }
      if (result.issues.some((issue) => !issuePathBelongsToInput(issue.path, validatedInput))) {
        return internalFailure(record.errorRegistry);
      }
      return createApplicationFailure(record.errorRegistry, result.code, result.issues);
    } catch {
      return internalFailure(record.errorRegistry);
    }
  }

  try {
    const evaluatedAt = readCanonicalClock(context.clock);
    observations.assertObservedNoLaterThan(evaluatedAt);
    const requirements = parseDefinitionArray(
      factRequirementAuthoritySchema,
      definition.factRequirements(validatedInput, result.data),
    ) as readonly FactRequirement[];
    validateDefinitionStructure(slots, requirements);
    observations.assertExpectations(parseDefinitionArray(
      observationExpectationAuthoritySchema,
      definition.observationExpectations(validatedInput, result.data),
    ) as readonly ObservationExpectation[]);
    const slotById = new Map(slots.map((slot) => [slot.slotId, slot]));
    const facts = new Map<string, ObservedFact>();
    for (const requirement of requirements) {
      const observationIds = canonicalUnique(requirement.observationSlotIds.flatMap((slotId) => {
        const observationId = observations.get(slotId);
        return observationId === undefined ? [] : [observationId];
      })) as readonly ObservationId[];
      for (const slotId of requirement.requiredObservationSlotIds) {
        if (!observations.hasSlot(slotId)) throw new TypeError("Required fact evidence is incomplete.");
      }
      if (observationIds.length < requirement.minimumObservationCount) {
        throw new TypeError("Fact evidence cardinality is incomplete.");
      }
      for (const observationId of observationIds) {
        if (observations.slotFactId(observationId) !== requirement.factId) {
          throw new TypeError("Fact evidence is not owned by its requirement.");
        }
      }
      const observedSlots = requirement.observationSlotIds
        .map((slotId) => slotById.get(slotId))
        .filter((slot): slot is ObservationSlot & { readonly ordinal: string } =>
          slot !== undefined && observations.hasSlot(slot.slotId));
      const evidenceAuthority = factOutcomeDefinitions[requirement.outcome].evidenceAuthority;
      if (evidenceAuthority === "none" && observedSlots.length !== 0) {
        throw new TypeError("Fact outcome must not claim evidence.");
      }
      if (evidenceAuthority === "external" && (
        observedSlots.length === 0 || observedSlots.some((slot) => slot.kind !== "source")
      )) throw new TypeError("External fact evidence authority is invalid.");
      if (evidenceAuthority === "validated_input" && (
        observedSlots.length === 0 || observedSlots.some((slot) => slot.kind !== "validated_input")
      )) throw new TypeError("Validated-input fact evidence authority is invalid.");
      facts.set(requirement.factId, deepFreezeValue({
        factId: requirement.factId,
        outcome: requirement.outcome,
        observationIds,
      }));
    }
    if (facts.size !== requirements.length) throw new TypeError("Fact output is incomplete.");
    const factProjection = new ImmutableFactProjection(facts);

    definition.validateDataContext(result.data, { evaluatedAt });
    definition.validateInvocation(validatedInput, result.data, {
      observationClaims: observations.bindings(),
      evaluatedAt,
    });
    const expectedConclusionIdInput = parseDefinitionArray(
      binderPrimitiveSchemas.fixedIdentifier,
      definition.expectedConclusionIds(validatedInput, result.data),
    );
    const expectedConclusionIds = canonicalUnique(expectedConclusionIdInput);
    if (expectedConclusionIds.length !== expectedConclusionIdInput.length) {
      throw new TypeError("Expected conclusion identities are duplicated.");
    }
    for (const expectedId of expectedConclusionIds) {
      const matches = definition.conclusionIdMatchers.filter((matcher) => matcher(expectedId)).length;
      if (matches !== 1) throw new TypeError("Expected conclusion identity is undeclared or ambiguous.");
    }
    const drafts = parseDefinitionArray(
      conclusionDraftAuthoritySchema,
      definition.deriveConclusions(validatedInput, result.data, factProjection),
    ) as readonly ConclusionDraft[];
    const conclusions: Conclusion[] = drafts.map((draft) => {
      const factIds = canonicalUnique(draft.evidenceFactIds);
      if (factIds.length !== draft.evidenceFactIds.length) throw new TypeError("Conclusion fact evidence is duplicated.");
      const observationIds = canonicalUnique(factIds.flatMap((factId) => {
        const fact = facts.get(factId);
        if (fact === undefined) throw new TypeError("Conclusion fact is unavailable.");
        return fact.observationIds;
      })) as readonly ObservationId[];
      const supportingSources = observationIds.map((observationId) => {
        const source = observations.evidenceFor(observationId);
        if (source === undefined) throw new TypeError("Conclusion evidence is unavailable.");
        return source;
      });
      assertConclusionFreshness(draft, supportingSources);
      const outcomeFact = facts.get(draft.outcomeFactId);
      if (outcomeFact === undefined) throw new TypeError("Conclusion outcome fact is unavailable.");
      if (outcomeFact.observationIds.length > 0 && !factIds.includes(draft.outcomeFactId)) {
        throw new TypeError("Conclusion evidence does not contain its outcome fact.");
      }
      const outcome = conclusionOutcome(outcomeFact.outcome);
      const freshnessStatus = freshnessRuleDefinitions[draft.freshnessRuleId].status;
      return deepFreezeValue({
        id: draft.id,
        status: outcome.status,
        reason: outcome.reason,
        observationIds,
        freshness: {
          status: freshnessStatus,
          ruleId: draft.freshnessRuleId,
          evaluatedAt,
          observationIds,
        },
      }) as Conclusion;
    }).sort((left, right) => compareCodePointSequences(left.id, right.id));
    if (!isStrictlyOrderedUnique(conclusions.map((item) => item.id))) {
      throw new TypeError("Conclusion identities are not unique and ordered.");
    }
    if (conclusions.map((conclusion) => conclusion.id).join("\0") !== expectedConclusionIds.join("\0")) {
      throw new TypeError("Capability conclusions are incomplete or undeclared.");
    }

    const warningRequirements = parseDefinitionArray(
      warningRequirementAuthoritySchema,
      definition.deriveWarnings(validatedInput, result.data, factProjection),
    ) as readonly WarningRequirement[];
    const warnings = warningRequirements.map((candidate) => {
      if (!definition.warningCodes.includes(candidate.code)) throw new TypeError("Warning is not declared.");
      const factIds = canonicalUnique(candidate.factIds);
      if (factIds.length !== candidate.factIds.length) throw new TypeError("Warning fact evidence is duplicated.");
      const observationIds = canonicalUnique(factIds.flatMap((factId) => {
        const fact = facts.get(factId);
        if (fact === undefined) throw new TypeError("Warning fact is invalid.");
        return fact.observationIds;
      })) as readonly ObservationId[];
      if (observationIds.length === 0) throw new TypeError("Warning evidence is invalid.");
      return createWarning(candidate.code, observationIds);
    }).sort((left, right) => {
      const codeOrder = compareCodePointSequences(left.code, right.code);
      return codeOrder === 0
        ? compareCodePointSequences(left.observationIds.join("\0"), right.observationIds.join("\0"))
        : codeOrder;
    });
    const warningIdentities = warnings.map((warning) =>
      canonicalJsonStringify(warning as unknown as CanonicalJson));
    if (!isStrictlyOrderedUnique(warningIdentities)) throw new TypeError("Warnings are not unique and ordered.");

    const coverage = deriveCoverage(conclusions);
    const success = {
      ok: true as const,
      meta: {
        capabilityId: definition.capabilityId,
        contractVersion: coreContractVersion,
        chainId: robinhoodChainIdentity.chainId,
        evaluatedAt,
      },
      data: result.data,
      evidence: {
        sources: observations.evidence(),
        conclusions,
        coverage,
      },
      warnings,
    };
    const parsed = definition.successParser(success);
    if (!parsed.success) return internalFailure(record.errorRegistry);
    return deepFreezeValue(parsed.data) as CapabilitySuccess<CapabilityData<Definition>>;
  } catch {
    return internalFailure(record.errorRegistry);
  }
};

export class CapabilityBindingRegistry {
  readonly #definitions: CapabilityRegistry;
  readonly #bindings: readonly AnyCapabilityBinding[];
  readonly #byCapabilityId: ReadonlyMap<string, BindingRecord<AnyReadCapabilityDefinition, InvocationBoundaryPorts>>;

  constructor(definitions: CapabilityRegistry, bindings: readonly AnyCapabilityBinding[] = []) {
    const byCapabilityId = new Map<string, BindingRecord<AnyReadCapabilityDefinition, InvocationBoundaryPorts>>();
    for (const binding of bindings) {
      const record = typeof binding === "object" && binding !== null ? bindingInternals.get(binding) : undefined;
      if (record === undefined || !definitions.owns(record.definition)) {
        throw new TypeError("Capability binding provenance is invalid.");
      }
      const capabilityId = definitionRecord(record.definition).capabilityId;
      if (byCapabilityId.has(capabilityId)) throw new TypeError("Duplicate capability binding.");
      byCapabilityId.set(capabilityId, record);
    }
    this.#definitions = definitions;
    this.#bindings = Object.freeze([...bindings]);
    this.#byCapabilityId = byCapabilityId;
    Object.freeze(this);
  }

  extend(bindings: readonly AnyCapabilityBinding[]): CapabilityBindingRegistry {
    return new CapabilityBindingRegistry(this.#definitions, [...this.#bindings, ...bindings]);
  }

  invoke<Definition extends AnyReadCapabilityDefinition>(
    definition: Definition,
    input: unknown,
    call: { readonly signal: AbortSignal },
  ): Promise<CapabilitySuccess<CapabilityData<Definition>> | ApplicationFailure> {
    if (!this.#definitions.owns(definition)) throw new TypeError("Capability definition is not registered.");
    const record = this.#byCapabilityId.get(definitionRecord(definition).capabilityId);
    if (record === undefined || record.definition !== definition) {
      throw new TypeError("Capability binding is not registered for the exact definition.");
    }
    return executeCapabilityBinding(record, input, call.signal) as Promise<
      CapabilitySuccess<CapabilityData<Definition>> | ApplicationFailure
    >;
  }
}
