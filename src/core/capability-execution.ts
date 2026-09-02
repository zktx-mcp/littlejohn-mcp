import { randomBytes } from "node:crypto";
import { z } from "zod";

import {
  CapabilityRegistry,
  createCapabilityEvidenceDeclaration,
  readCapabilityExecutionDefinition,
  validateProducedCapabilitySuccess,
  type AnyReadCapabilityDefinition,
  type CapabilityData,
  type CapabilityInput,
} from "./capability.js";
import type { CapabilitySuccess } from "./capability-contract.js";
import {
  canonicalJsonStringify,
  captureCanonicalJson,
  type CanonicalJson,
} from "./canonical-json.js";
import {
  createEvidenceSchemaSet,
  type EvidenceSource,
  type InvocationId,
  type ObservationId,
  type SourceClass,
} from "./evidence.js";
import {
  captureEvidenceObservationClaims,
  createEvidenceObservationId,
  createEvidenceReplayBinder,
  createEvidenceReplayLayout,
  createEvidenceSourceRecordDigest,
  evidenceObservationClaimsEqual,
  readBoundEvidenceObservationSlot,
  readEvidenceReplayBoundTargets,
  replayPublicEvidence,
  type BoundEvidenceObservationSlotDeclaration,
  type BoundEvidenceObservationTarget,
  type EvidenceObservationTargetDeclaration,
  type EvidenceReplayBinder,
  type EvidenceReplayDefinition,
  type EvidenceReplayLayout,
  type ObservationClaim,
} from "./evidence-replay.js";
import {
  applicationFailureIssueLimit,
  applicationFailureSchemaFor,
  assertApplicationErrorRegistry,
  createApplicationFailure,
  fieldIssuesFromInputError,
  type ApplicationErrorRegistry,
  type ApplicationFailure,
} from "./errors.js";
import { deepFreezeValue } from "./immutability.js";
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
import { jsonObject } from "./json-object.js";
import {
  compareCodePointSequences,
  createPrimitiveSchemaSet,
  type SnakeCaseCode,
  type UtcTimestamp,
} from "./primitives.js";

const executionPrimitiveSchemas = createPrimitiveSchemaSet();
const executionEvidenceSchemas = createEvidenceSchemaSet();

export interface ObservationWriter extends EvidenceReplayBinder {
  record(slot: BoundEvidenceObservationSlotDeclaration, observation: {
    readonly source: ObservationAuthority;
    readonly claims: readonly ObservationClaim[];
  }): ObservationId;
  get(slot: BoundEvidenceObservationSlotDeclaration): ObservationId | undefined;
}

const safeNormalize = (
  input: unknown,
): { readonly ok: true; readonly value: CanonicalJson } | { readonly ok: false } => {
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

const handlerEnvelopeSchema = z.discriminatedUnion("status", [
  jsonObject({
    status: z.literal("success"),
    data: z.unknown(),
  }).strict(),
  jsonObject({
    status: z.literal("failure"),
    code: executionPrimitiveSchemas.snakeCaseCode,
    issues: z.array(executionEvidenceSchemas.fieldIssue).max(applicationFailureIssueLimit),
  }).strict(),
]);

type HandlerEnvelope = z.output<typeof handlerEnvelopeSchema>;
type ParsedHandlerResult<Data> =
  | (Omit<Extract<HandlerEnvelope, { status: "success" }>, "data"> & { readonly data: Data })
  | Extract<HandlerEnvelope, { status: "failure" }>;

class InvocationObservations implements ObservationWriter {
  readonly #clock: CanonicalClock;
  readonly #authorities: ObservationAuthorityRegistry;
  readonly #definition: EvidenceReplayDefinition;
  readonly #layout: EvidenceReplayLayout;
  readonly #binder: EvidenceReplayBinder;
  readonly #invocationId: InvocationId;
  readonly #evidence = new Map<BoundEvidenceObservationSlotDeclaration, EvidenceSource>();
  readonly #claims = new Map<
    BoundEvidenceObservationSlotDeclaration,
    readonly ObservationClaim[]
  >();

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
    const anchors = claims.flatMap((claim) =>
      claim.chainAnchor === undefined ? [] : [claim.chainAnchor]);
    const chainAnchor = anchors[0];
    if (anchors.some((candidate) =>
      canonicalJsonStringify(candidate as unknown as CanonicalJson) !==
      canonicalJsonStringify(chainAnchor as unknown as CanonicalJson))) {
      throw new TypeError("One observation cannot bind multiple chain anchors.");
    }
    const details = {
      observedAt: executionPrimitiveSchemas.utcTimestamp.parse(detailsInput.observedAt),
      owner: detailsInput.owner,
      reference: detailsInput.reference,
      claims: Object.freeze(claims),
      ...(chainAnchor === undefined ? {} : { chainAnchor }),
    };
    const expectedClass = slotDeclaration.sourceClass;
    if (expectedClass !== detailsInput.sourceClass) {
      throw new TypeError("Observation source class is inconsistent.");
    }
    const observationId = createEvidenceObservationId(this.#definition, this.#layout, {
      slot,
      sourceId: details.reference.sourceId,
      observedAt: details.observedAt,
      ...(details.chainAnchor === undefined ? {} : { chainAnchor: details.chainAnchor }),
      invocationId: this.#invocationId,
    });
    const sourceRecord = deepFreezeValue(executionEvidenceSchemas.evidenceSourceRecord.parse({
      observationId,
      invocationId: this.#invocationId,
      sourceClass: expectedClass,
      owner: details.owner,
      purpose: slotDeclaration.purpose,
      observedAt: details.observedAt,
      reference: details.reference,
      ...(details.chainAnchor === undefined ? {} : { chainAnchor: details.chainAnchor }),
    }));
    const evidence = deepFreezeValue({
      ...sourceRecord,
      recordDigest: createEvidenceSourceRecordDigest(
        this.#definition,
        this.#layout,
        slot,
        sourceRecord,
        claims,
      ),
    }) as EvidenceSource;
    this.#evidence.set(slot, evidence);
    this.#claims.set(slot, claims);
    return observationId;
  }

  assertObservedNoLaterThan(evaluatedAt: UtcTimestamp): void {
    for (const evidence of this.#evidence.values()) {
      if (evidence.observedAt > evaluatedAt) {
        throw new TypeError("Observation time exceeds evaluation time.");
      }
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
    for (const evidence of this.#evidence.values()) {
      if (evidence.observationId === observationId) return evidence;
    }
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
      ) {
        throw new TypeError("Observation claims do not match the capability definition.");
      }
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

declare const capabilityBindingType: unique symbol;
export interface CapabilityBinding<Definition extends AnyReadCapabilityDefinition> {
  readonly [capabilityBindingType]: Definition;
}

type AnyCapabilityExecutionResult = CapabilitySuccess<unknown> | ApplicationFailure;

export interface CapabilityExecutionOwnerPort {
  execute<Result extends AnyCapabilityExecutionResult>(
    callerSignal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<Result>,
  ): Promise<Result>;
}

type AnyCapabilityBinding = CapabilityBinding<AnyReadCapabilityDefinition>;

interface BindingRecord<
  Definition extends AnyReadCapabilityDefinition,
  Ports extends InvocationBoundaryPorts,
> {
  readonly definition: Definition;
  readonly errorRegistry: ApplicationErrorRegistry;
  readonly invocationAuthority: CapabilityInvocationAuthority;
  readonly executionOwner?: CapabilityExecutionOwnerPort;
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
    if (Reflect.getPrototypeOf(input) !== Object.prototype) throw new TypeError();
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const expectedKeys = [
      "definition",
      "errorRegistry",
      "invocationAuthority",
      ...(descriptors.executionOwner === undefined ? [] : ["executionOwner"]),
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
    const executionOwner = descriptors.executionOwner?.value as CapabilityExecutionOwnerPort | undefined;
    const createInvocationPorts = descriptors.createInvocationPorts?.value as (
      input: CapabilityInput<Definition>
    ) => Ports;
    const handler = descriptors.handler?.value as BindingRecord<Definition, Ports>["handler"];
    if (
      typeof createInvocationPorts !== "function" ||
      typeof handler !== "function" ||
      (executionOwner !== undefined && (
        typeof executionOwner !== "object" ||
        executionOwner === null ||
        typeof executionOwner.execute !== "function"
      ))
    ) {
      throw new TypeError();
    }
    return Object.freeze({
      definition,
      errorRegistry,
      invocationAuthority,
      ...(executionOwner === undefined ? {} : { executionOwner }),
      createInvocationPorts,
      handler,
    });
  } catch {
    throw new TypeError("Capability binding options are invalid.");
  }
};

const bindingInternals = new WeakMap<
  object,
  BindingRecord<AnyReadCapabilityDefinition, InvocationBoundaryPorts>
>();

const captureInvocationPorts = <Ports extends InvocationBoundaryPorts>(ports: Ports): Ports => {
  if (typeof ports !== "object" || ports === null) {
    throw new TypeError("Invocation ports are invalid.");
  }
  const prototype = Reflect.getPrototypeOf(ports);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Invocation ports must be a plain object.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(ports);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key === "symbol")) {
    throw new TypeError("Invocation ports cannot use symbol keys.");
  }
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
  const definition = readCapabilityExecutionDefinition(record.definition);
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
  const definition = readCapabilityExecutionDefinition(record.definition);
  const normalizedInput = safeNormalize(input);
  if (!normalizedInput.ok) {
    return createApplicationFailure(record.errorRegistry, "invalid_input");
  }
  const parsedInput = definition.inputParser(normalizedInput.value);
  if (!parsedInput.success) {
    return createApplicationFailure(
      record.errorRegistry,
      "invalid_input",
      fieldIssuesFromInputError(parsedInput.error),
    );
  }
  const validatedInput = deepFreezeValue(parsedInput.data) as CapabilityInput<Definition>;

  let invocationId: InvocationId;
  let layout: EvidenceReplayLayout;
  try {
    invocationId = executionEvidenceSchemas.invocationId.parse(
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
  if (result === null) {
    return internalFailure(record.errorRegistry);
  }
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
    const declaration = createCapabilityEvidenceDeclaration(
      record.definition,
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
        contractVersion: definition.contractVersion,
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
    if (!parsed.success) {
      return internalFailure(record.errorRegistry);
    }
    const validated = validateProducedCapabilitySuccess(
      record.definition,
      validatedInput,
      parsed.data,
      derived,
    );
    return validated.status === "result_too_large"
      ? createApplicationFailure(record.errorRegistry, "result_too_large")
      : validated.success as CapabilitySuccess<CapabilityData<Definition>>;
  } catch {
    return internalFailure(record.errorRegistry);
  }
};

const executeOwnedCapabilityBinding = async <Definition extends AnyReadCapabilityDefinition>(
  record: BindingRecord<Definition, InvocationBoundaryPorts>,
  input: unknown,
  signal: AbortSignal,
): Promise<CapabilitySuccess<CapabilityData<Definition>> | ApplicationFailure> => {
  const owner = record.executionOwner;
  if (owner === undefined) return executeCapabilityBinding(record, input, signal);
  let started = false;
  let completed: CapabilitySuccess<CapabilityData<Definition>> | ApplicationFailure | undefined;
  const operation = async (ownedSignal: AbortSignal) => {
    if (started) throw new TypeError("Capability execution operation was started more than once.");
    started = true;
    completed = await executeCapabilityBinding(record, input, ownedSignal);
    return completed;
  };
  let result: CapabilitySuccess<CapabilityData<Definition>> | ApplicationFailure;
  try {
    result = await owner.execute(signal, operation);
  } catch {
    return internalFailure(record.errorRegistry);
  }
  if (result.ok === false) {
    const definition = readCapabilityExecutionDefinition(record.definition);
    const failure = applicationFailureSchemaFor(
      record.errorRegistry,
      definition.failureCodes,
    ).safeParse(result);
    return failure.success ? failure.data : internalFailure(record.errorRegistry);
  }
  return completed !== undefined && result === completed
    ? result
    : internalFailure(record.errorRegistry);
};

export class CapabilityBindingRegistry {
  readonly #definitions: CapabilityRegistry;
  readonly #bindings: readonly AnyCapabilityBinding[];
  readonly #byCapabilityId: ReadonlyMap<
    string,
    BindingRecord<AnyReadCapabilityDefinition, InvocationBoundaryPorts>
  >;

  constructor(definitions: CapabilityRegistry, bindings: readonly AnyCapabilityBinding[] = []) {
    const byCapabilityId = new Map<
      string,
      BindingRecord<AnyReadCapabilityDefinition, InvocationBoundaryPorts>
    >();
    for (const binding of bindings) {
      const record = typeof binding === "object" && binding !== null
        ? bindingInternals.get(binding)
        : undefined;
      if (record === undefined || !definitions.owns(record.definition)) {
        throw new TypeError("Capability binding provenance is invalid.");
      }
      const capabilityId = readCapabilityExecutionDefinition(record.definition).capabilityId;
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
    if (!this.#definitions.owns(definition)) {
      throw new TypeError("Capability definition is not registered.");
    }
    const record = this.#byCapabilityId.get(
      readCapabilityExecutionDefinition(definition).capabilityId,
    );
    if (record === undefined || record.definition !== definition) {
      throw new TypeError("Capability binding is not registered for the exact definition.");
    }
    return executeOwnedCapabilityBinding(record, input, call.signal) as Promise<
      CapabilitySuccess<CapabilityData<Definition>> | ApplicationFailure
    >;
  }
}
