import { z, type ZodType } from "zod";

import {
  assertCapabilitySuccessChainScope,
  capabilityIdSchema,
  createCapabilityIdSchema,
  createCapabilitySuccessSchema,
  maximumSuccessUtf8Bytes,
  type CapabilityId,
  type CapabilitySuccess,
} from "./capability-contract.js";
export {
  capabilityIdPatternSource,
  capabilityIdSchema,
  createCapabilityIdSchema,
} from "./capability-contract.js";
export type { CapabilityId } from "./capability-contract.js";
import {
  canonicalJsonStringify,
  captureCanonicalJson,
  utf8ByteLength,
  type CanonicalJson,
} from "./canonical-json.js";
import { coreContractVersion } from "./contract.js";
import {
  createEvidenceSchemaSet,
  type StaticScopeExclusion,
  type Warning,
} from "./evidence.js";
import {
  createEvidenceReplayBinder,
  createEvidenceReplayLayout,
  readEvidenceReplayConclusionIds,
  readEvidenceReplayCapabilityId,
  readEvidenceReplayWarningCodes,
  replayPublicEvidence,
  type EvidenceObservationTargetDeclaration,
  type EvidenceReplayBinder,
  type EvidenceReplayDefinition,
  type EvidenceReplayDeclaration,
  type EvidenceReplayLayout,
  type EvidenceReplayResult,
} from "./evidence-replay.js";
import { evmChainIdSchema, type EvmChainId } from "./identities.js";
import { deepFreezeValue } from "./immutability.js";
import {
  compareCodePointSequences,
  sortUniqueStrings,
  createPrimitiveSchemaSet,
  type SnakeCaseCode,
  type UtcTimestamp,
} from "./primitives.js";

const binderPrimitiveSchemas = createPrimitiveSchemaSet();
const binderEvidenceSchemas = createEvidenceSchemaSet();

const capabilityIdAuthoritySchema = createCapabilityIdSchema();

export interface SuccessValidationContext {
  readonly evaluatedAt: UtcTimestamp;
  readonly chainId: EvmChainId;
}

export interface DataValidationContext {
  readonly evaluatedAt: UtcTimestamp;
}

export interface IntrinsicDataValidationContext {
  assertDeclaredScopeExclusion(exclusion: StaticScopeExclusion): void;
}

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

interface InternalReadCapabilityDefinition<Input, Data> {
  readonly capabilityId: CapabilityId;
  readonly contractVersion: typeof coreContractVersion;
  readonly failureCodes: readonly SnakeCaseCode[];
  readonly conclusionIds: readonly string[];
  readonly replayDefinition: EvidenceReplayDefinition;
  observationTargets(input: Input): readonly EvidenceObservationTargetDeclaration[];
  evidenceDeclaration(
    input: Input,
    data: Data,
    binder: EvidenceReplayBinder,
  ): EvidenceReplayDeclaration;
  validateIntrinsicData(data: Data, context: IntrinsicDataValidationContext): void;
  validateDataContext(data: Data, context: DataValidationContext): void;
  validateSuccess(data: Data, context: SuccessValidationContext): void;
  validateRequest(input: Input, data: Data): void;
  readonly warningCodes: readonly Warning["code"][];
  readonly staticScopeExclusions: readonly StaticScopeExclusion[];
}

export interface ReadCapabilityEvidence<Input, Data> {
  readonly definition: EvidenceReplayDefinition;
  observationTargets(input: Input): readonly EvidenceObservationTargetDeclaration[];
  declaration(
    input: Input,
    data: Data,
    binder: EvidenceReplayBinder,
  ): EvidenceReplayDeclaration;
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

const canonicalUnique = (values: readonly string[]): readonly string[] => Object.freeze(sortUniqueStrings(values));

export interface CapabilityDefinitionSnapshot {
  readonly capabilityId: CapabilityId;
  readonly contractVersion: typeof coreContractVersion;
  readonly maximumSuccessUtf8Bytes: typeof maximumSuccessUtf8Bytes;
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

export interface CapabilityExecutionDefinition<Input, Data> {
  readonly capabilityId: CapabilityId;
  readonly failureCodes: readonly SnakeCaseCode[];
  readonly replayDefinition: EvidenceReplayDefinition;
  observationTargets(input: Input): readonly EvidenceObservationTargetDeclaration[];
  readonly inputParser: (value: unknown) => z.ZodSafeParseResult<Input>;
  readonly dataParser: (value: unknown) => z.ZodSafeParseResult<Data>;
  readonly successParser: (value: unknown) => z.ZodSafeParseResult<CapabilitySuccess<Data>>;
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

export const readCapabilityExecutionDefinition = <Input, Data>(
  definition: ReadCapabilityDefinition<Input, Data>,
): CapabilityExecutionDefinition<Input, Data> => definitionRecord(definition);

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

type CapabilityResultValidation<Data> =
  | Readonly<{ readonly status: "success"; readonly success: CapabilitySuccess<Data> }>
  | Readonly<{ readonly status: "result_too_large" }>;

const captureCapabilityEvidenceDeclaration = <Input, Data>(
  record: InternalDefinitionRecord<Input, Data>,
  input: Input,
  data: Data,
  layout: EvidenceReplayLayout,
): EvidenceReplayDeclaration => {
  const declaration = record.evidenceDeclaration(
    input,
    data,
    createEvidenceReplayBinder(record.replayDefinition, layout),
  );
  return Object.freeze({
    observationExpectations: Object.freeze([...declaration.observationExpectations]),
    observationReferences: Object.freeze([...declaration.observationReferences]),
    factRequirements: Object.freeze([...declaration.factRequirements]),
    expectedConclusions: Object.freeze([...declaration.expectedConclusions]),
    conclusionDrafts: Object.freeze([...declaration.conclusionDrafts]),
    warningRequirements: Object.freeze([...declaration.warningRequirements]),
  });
};

export const createCapabilityEvidenceDeclaration = <Input, Data>(
  definition: ReadCapabilityDefinition<Input, Data>,
  input: Input,
  data: Data,
  layout: EvidenceReplayLayout,
): EvidenceReplayDeclaration =>
  captureCapabilityEvidenceDeclaration(definitionRecord(definition), input, data, layout);

const replayCapabilityEvidence = <Input, Data>(
  definition: InternalDefinitionRecord<Input, Data>,
  input: Input,
  data: Data,
  success: CapabilitySuccess<Data>,
): EvidenceReplayResult => {
  const layout = createEvidenceReplayLayout(
    definition.replayDefinition,
    definition.observationTargets(input),
  );
  const declaration = captureCapabilityEvidenceDeclaration(definition, input, data, layout);
  return replayPublicEvidence({
    definition: definition.replayDefinition,
    layout,
    ...declaration,
    evaluatedAt: success.meta.evaluatedAt,
    sources: success.evidence.sources,
  });
};

const assertDerivedCapabilityEvidence = <Data>(
  success: CapabilitySuccess<Data>,
  derived: EvidenceReplayResult,
): void => {
  const actual = canonicalJsonStringify(captureCanonicalJson({
    conclusions: success.evidence.conclusions,
    coverage: success.evidence.coverage,
    warnings: success.warnings,
  }));
  const expected = canonicalJsonStringify(captureCanonicalJson(derived));
  if (actual !== expected) {
    throw new TypeError("Capability success evidence does not match its definition.");
  }
};

const validateCapabilityResult = <Input, Data>(
  record: InternalDefinitionRecord<Input, Data>,
  input: Input,
  success: CapabilitySuccess<Data>,
  producedEvidence?: EvidenceReplayResult,
): CapabilityResultValidation<Data> => {
  const parsedData = record.dataParser(success.data);
  if (!parsedData.success) throw parsedData.error;
  const dataContext = Object.freeze({ evaluatedAt: success.meta.evaluatedAt });
  const successContext = Object.freeze({
    evaluatedAt: success.meta.evaluatedAt,
    chainId: success.meta.chainId,
  });
  record.validateDataContext(parsedData.data, dataContext);
  record.validateSuccess(parsedData.data, successContext);
  record.validateRequest(input, parsedData.data);
  assertCapabilitySuccessChainScope(success);
  assertDerivedCapabilityEvidence(
    success,
    producedEvidence ?? replayCapabilityEvidence(record, input, parsedData.data, success),
  );
  const validated = deepFreezeValue({
    ...success,
    data: parsedData.data,
  });
  if (
    utf8ByteLength(canonicalJsonStringify(captureCanonicalJson(validated))) >
      maximumSuccessUtf8Bytes
  ) {
    return Object.freeze({ status: "result_too_large" });
  }
  return Object.freeze({ status: "success", success: validated });
};

export const validateProducedCapabilitySuccess = <Input, Data>(
  definition: ReadCapabilityDefinition<Input, Data>,
  input: Input,
  success: CapabilitySuccess<Data>,
  producedEvidence: EvidenceReplayResult,
): CapabilityResultValidation<Data> =>
  validateCapabilityResult(definitionRecord(definition), input, success, producedEvidence);

export const parseCapabilitySuccess = <Definition extends AnyReadCapabilityDefinition>(
  definition: Definition,
  input: unknown,
  value: unknown,
): CapabilitySuccess<CapabilityData<Definition>> => {
  const record = definitionRecord(definition);
  const parsedInput = record.inputParser(input);
  if (!parsedInput.success) throw parsedInput.error;
  const parsed = record.successParser(value);
  if (!parsed.success) throw parsed.error;
  const result = validateCapabilityResult(record, parsedInput.data, parsed.data);
  if (result.status === "result_too_large") {
    throw new TypeError("The canonical capability success exceeds the supported size.");
  }
  return result.success as CapabilitySuccess<CapabilityData<Definition>>;
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

export const defineReadCapability = <Input, Data>(options: {
  readonly capabilityId: string;
  readonly inputSchema: ZodType<Input>;
  readonly dataSchema: ZodType<Data>;
  readonly normalizeInput?: (input: Input) => Input;
  readonly evidence: ReadCapabilityEvidence<Input, Data>;
  readonly validateIntrinsicData?: InternalReadCapabilityDefinition<Input, Data>["validateIntrinsicData"];
  readonly validateDataContext?: InternalReadCapabilityDefinition<Input, Data>["validateDataContext"];
  readonly validateSuccess?: InternalReadCapabilityDefinition<Input, Data>["validateSuccess"];
  readonly validateRequest?: InternalReadCapabilityDefinition<Input, Data>["validateRequest"];
  readonly failureCodes: readonly string[];
}) => {
  const capabilityId = capabilityIdAuthoritySchema.parse(options.capabilityId);
  const failureCodeInput = options.failureCodes.map((code) => binderPrimitiveSchemas.snakeCaseCode.parse(code));
  const failureCodes = canonicalUnique(failureCodeInput) as readonly SnakeCaseCode[];
  if (failureCodes.length !== failureCodeInput.length) throw new TypeError("Duplicate capability failure code.");
  if (!failureCodes.includes("invalid_input" as SnakeCaseCode) ||
    !failureCodes.includes("internal_error" as SnakeCaseCode) ||
    !failureCodes.includes("result_too_large" as SnakeCaseCode)) {
    throw new TypeError("Capability failure codes must include canonical boundary failures.");
  }
  const replayDefinition = options.evidence.definition;
  if (readEvidenceReplayCapabilityId(replayDefinition) !== capabilityId) {
    throw new TypeError("Capability evidence definition identity is inconsistent.");
  }
  const conclusionIds = readEvidenceReplayConclusionIds(replayDefinition);
  const warningCodes = readEvidenceReplayWarningCodes(replayDefinition);
  const staticScopeExclusions = options.evidence.staticScopeExclusions
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
  const successSchema = createCapabilitySuccessSchema(capabilityId, options.dataSchema);
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
    maximumSuccessUtf8Bytes,
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
    replayDefinition,
    observationTargets: options.evidence.observationTargets,
    evidenceDeclaration: options.evidence.declaration,
    validateIntrinsicData: options.validateIntrinsicData ?? (() => undefined),
    validateDataContext: options.validateDataContext ?? (() => undefined),
    validateSuccess: options.validateSuccess ?? (() => undefined),
    validateRequest: options.validateRequest ?? (() => undefined),
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
