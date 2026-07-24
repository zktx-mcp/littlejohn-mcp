import { randomBytes } from "node:crypto";
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
  createFieldIssue,
  type EvidenceSource,
  type FieldIssue,
  type InvocationId,
  type ObservationId,
  type SourceClass,
  type StaticScopeExclusion,
  type Warning,
} from "./evidence.js";
import {
  captureEvidenceObservationClaims,
  createEvidenceReplayBinder,
  createEvidenceObservationId,
  createEvidenceReplayLayout,
  evidenceObservationClaimsEqual,
  readBoundEvidenceObservationSlot,
  readEvidenceReplayBoundTargets,
  readEvidenceReplayConclusionIds,
  readEvidenceReplayCapabilityId,
  readEvidenceReplayWarningCodes,
  replayPublicEvidence,
  type BoundEvidenceObservationSlotDeclaration,
  type BoundEvidenceObservationTarget,
  type EvidenceObservationTargetDeclaration,
  type EvidenceReplayBinder,
  type EvidenceReplayDefinition,
  type EvidenceReplayDeclaration,
  type EvidenceReplayLayout,
  type EvidenceReplayResult,
  type ObservationClaim,
} from "./evidence-replay.js";
import { evmChainIdSchema, type EvmChainId } from "./identities.js";
import { deepFreezeValue } from "./immutability.js";
import { jsonObject } from "./json-object.js";
import {
  assertCapabilityInvocationAuthority,
  createHandlerInvocationContext,
  readCanonicalClock,
  readObservationAuthority,
  type CapabilityInvocationAuthority,
  type CanonicalClock,
  type HandlerInvocationContext,
  type InvocationBoundaryPorts,
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
  type SnakeCaseCode,
  type UtcTimestamp,
} from "./primitives.js";

const binderPrimitiveSchemas = createPrimitiveSchemaSet();
const binderEvidenceSchemas = createEvidenceSchemaSet();

const capabilityIdAuthoritySchema = createCapabilityIdSchema();

export interface ObservationWriter extends EvidenceReplayBinder {
  record(slot: BoundEvidenceObservationSlotDeclaration, observation: {
    readonly source: ObservationAuthority;
    readonly claims: readonly ObservationClaim[];
  }): ObservationId;
  get(slot: BoundEvidenceObservationSlotDeclaration): ObservationId | undefined;
}

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

type CapabilityResultValidation<Data> =
  | Readonly<{ readonly status: "success"; readonly success: CapabilitySuccess<Data> }>
  | Readonly<{ readonly status: "result_too_large" }>;

const captureEvidenceDeclaration = <Input, Data>(
  definition: InternalDefinitionRecord<Input, Data>,
  input: Input,
  data: Data,
  layout: EvidenceReplayLayout,
): EvidenceReplayDeclaration => {
  const declaration = definition.evidenceDeclaration(
    input,
    data,
    createEvidenceReplayBinder(definition.replayDefinition, layout),
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
  const declaration = captureEvidenceDeclaration(definition, input, data, layout);
  return replayPublicEvidence({
    definition: definition.replayDefinition,
    layout,
    ...declaration,
    evaluatedAt: success.meta.evaluatedAt,
    sources: success.evidence.sources,
  });
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
  if (utf8ByteLength(canonicalJsonStringify(validated as unknown as CanonicalJson)) > maximumSuccessUtf8Bytes) {
    return Object.freeze({ status: "result_too_large" });
  }
  return Object.freeze({ status: "success", success: validated });
};

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

class InvocationObservations implements ObservationWriter {
  readonly #clock: CanonicalClock;
  readonly #authorities: ObservationAuthorityRegistry;
  readonly #definition: EvidenceReplayDefinition;
  readonly #layout: EvidenceReplayLayout;
  readonly #binder: EvidenceReplayBinder;
  readonly #invocationId: InvocationId;
  readonly #evidence =
    new Map<BoundEvidenceObservationSlotDeclaration, EvidenceSource>();
  readonly #claims =
    new Map<BoundEvidenceObservationSlotDeclaration, readonly ObservationClaim[]>();

  constructor(
    definition: EvidenceReplayDefinition,
    layout: EvidenceReplayLayout,
    input: unknown,
    invocationId: InvocationId,
    clock: CanonicalClock,
    authorities: ObservationAuthorityRegistry,
  ) {
    this.#clock = clock;
    this.#definition = definition;
    this.#layout = layout;
    this.#binder = createEvidenceReplayBinder(definition, layout);
    this.#invocationId = invocationId;
    this.#authorities = authorities;
    for (const target of readEvidenceReplayBoundTargets(definition, layout)) {
      const slot = readBoundEvidenceObservationSlot(definition, layout, target.slot);
      if (slot.sourceClass === "validated_input") {
        const identity = slot.validatedInputIdentity;
        const roles = Object.values(target.roles);
        if (identity === undefined || roles.length !== 1 || roles[0] === undefined) {
          throw new TypeError("Validated-input evidence declaration is invalid.");
        }
        this.#recordDetails(target.slot, {
          sourceClass: "validated_input",
          owner: identity.owner,
          observedAt: readCanonicalClock(clock),
          reference: {
            kind: "validated_input",
            sourceId: identity.sourceId as EvidenceSource["reference"]["sourceId"],
          } as EvidenceSource["reference"],
          claims: [{ role: roles[0], value: input as CanonicalJson }],
        });
      }
    }
  }

  bind<Target extends EvidenceObservationTargetDeclaration>(
    target: Target,
  ): BoundEvidenceObservationTarget<Target> {
    return this.#binder.bind(target);
  }

  bindRole(
    role: Parameters<EvidenceReplayBinder["bindRole"]>[0],
  ): ReturnType<EvidenceReplayBinder["bindRole"]> {
    return this.#binder.bindRole(role);
  }

  record(slot: BoundEvidenceObservationSlotDeclaration, observation: {
    readonly source: ObservationAuthority;
    readonly claims: readonly ObservationClaim[];
  }): ObservationId {
    const source = readObservationAuthority(observation.source, this.#clock);
    if (!this.#authorities.owns(source.sourceClass, observation.source)) {
      throw new TypeError("Observation authority is not registered for this invocation.");
    }
    return this.#recordDetails(slot, {
      ...source,
      observedAt: readCanonicalClock(this.#clock),
      claims: observation.claims,
    });
  }

  #recordDetails(slot: BoundEvidenceObservationSlotDeclaration, detailsInput: {
    readonly sourceClass: SourceClass;
    readonly owner: string;
    readonly observedAt: UtcTimestamp;
    readonly reference: EvidenceSource["reference"];
    readonly claims: readonly ObservationClaim[];
  }): ObservationId {
    if (this.#evidence.has(slot)) {
      throw new TypeError("Observation slot is invalid or complete.");
    }
    const slotDeclaration = readBoundEvidenceObservationSlot(
      this.#definition,
      this.#layout,
      slot,
    );
    const claims = captureEvidenceObservationClaims(
      this.#definition,
      this.#layout,
      slot,
      detailsInput.claims,
    );
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
    const expectedClass = slotDeclaration.sourceClass;
    if (expectedClass !== detailsInput.sourceClass) throw new TypeError("Observation source class is inconsistent.");
    const observationId = createEvidenceObservationId(this.#definition, this.#layout, {
      slot,
      sourceId: details.reference.sourceId,
      observedAt: details.observedAt,
      ...(details.chainAnchor === undefined ? {} : { chainAnchor: details.chainAnchor }),
      invocationId: this.#invocationId,
    });
    const evidence = deepFreezeValue({
      observationId,
      invocationId: this.#invocationId,
      sourceClass: expectedClass,
      owner: details.owner,
      purpose: slotDeclaration.purpose,
      observedAt: details.observedAt,
      reference: details.reference,
      ...(details.chainAnchor === undefined ? {} : { chainAnchor: details.chainAnchor }),
    }) as EvidenceSource;
    this.#evidence.set(slot, evidence);
    this.#claims.set(slot, claims);
    return observationId;
  }

  assertObservedNoLaterThan(evaluatedAt: UtcTimestamp): void {
    for (const evidence of this.#evidence.values()) {
      if (evidence.observedAt > evaluatedAt) throw new TypeError("Observation time exceeds evaluation time.");
    }
  }

  get(slot: BoundEvidenceObservationSlotDeclaration): ObservationId | undefined {
    readBoundEvidenceObservationSlot(this.#definition, this.#layout, slot);
    return this.#evidence.get(slot)?.observationId;
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

  assertExpectations(
    expectations: ReadonlyMap<
      BoundEvidenceObservationSlotDeclaration,
      readonly ObservationClaim[]
    >,
  ): void {
    for (const [slot, actual] of this.#claims) {
      const expected = expectations.get(slot);
      if (
        expected === undefined ||
        !evidenceObservationClaimsEqual(
          this.#definition,
          this.#layout,
          slot,
          actual,
          expected,
        )
      ) throw new TypeError("Observation claims do not match the capability definition.");
    }
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

const assertDerivedCapabilityEvidence = <Data>(
  success: CapabilitySuccess<Data>,
  derived: EvidenceReplayResult,
): void => {
  const actual = canonicalJsonStringify({
    conclusions: success.evidence.conclusions,
    coverage: success.evidence.coverage,
    warnings: success.warnings,
  } as unknown as CanonicalJson);
  const expected = canonicalJsonStringify(derived as unknown as CanonicalJson);
  if (actual !== expected) {
    throw new TypeError("Capability success evidence does not match its definition.");
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
  let layout: EvidenceReplayLayout;
  try {
    invocationId = binderEvidenceSchemas.invocationId.parse(
      `inv:${randomBytes(32).toString("base64url")}`,
    );
    layout = createEvidenceReplayLayout(
      definition.replayDefinition,
      definition.observationTargets(validatedInput),
    );
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
      definition.replayDefinition,
      layout,
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
    const declaration = captureEvidenceDeclaration(
      definition,
      validatedInput,
      result.data,
      layout,
    );
    observations.assertExpectations(new Map(
      declaration.observationExpectations.map((expectation) => [
        expectation.slot,
        expectation.claims,
      ]),
    ));
    const sources = observations.evidence();
    const derived = replayPublicEvidence({
      definition: definition.replayDefinition,
      layout,
      ...declaration,
      evaluatedAt,
      sources,
    });

    const success = {
      ok: true as const,
      meta: {
        capabilityId: definition.capabilityId,
        contractVersion: coreContractVersion,
        chainId: context.chainScope,
        evaluatedAt,
      },
      data: result.data,
      evidence: {
        sources,
        conclusions: derived.conclusions,
        coverage: derived.coverage,
      },
      warnings: derived.warnings,
    };
    const parsed = definition.successParser(success);
    if (!parsed.success) return internalFailure(record.errorRegistry);
    const validated = validateCapabilityResult(definition, validatedInput, parsed.data, derived);
    return validated.status === "result_too_large"
      ? createApplicationFailure(record.errorRegistry, "result_too_large")
      : validated.success as CapabilitySuccess<CapabilityData<Definition>>;
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
