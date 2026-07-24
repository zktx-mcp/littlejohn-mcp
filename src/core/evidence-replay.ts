import { z, type ZodType } from "zod";

import { createAmountSchemaSet } from "./amounts.js";
import {
  capabilityIdSchema,
  type CapabilityId,
} from "./capability-contract.js";
import {
  canonicalJsonStringify,
  canonicalSha256Base64Url,
  captureCanonicalJson,
  type CanonicalJson,
} from "./canonical-json.js";
import {
  createEvidenceSchemaSet,
  createEvidenceSummary,
  factOutcomeDefinitions,
  freshnessRuleDefinitions,
  isStrictlyOrderedUnique,
  type Conclusion,
  type Coverage,
  type EvidenceSource,
  type FactOutcome,
  type Freshness,
  type InvocationId,
  type ObservationId,
  type SourceClass,
  type Warning,
} from "./evidence.js";
import { deepFreezeValue } from "./immutability.js";
import type { ObservationClaim } from "./invocation.js";
import { jsonObject } from "./json-object.js";
import { productDisplayName } from "./product-identity.js";
import {
  compareCodePointSequences,
  createPrimitiveSchemaSet,
  sortUniqueStrings,
  type ChainAnchor,
  type EvmAddress,
  type UtcTimestamp,
} from "./primitives.js";

const replayPrimitives = createPrimitiveSchemaSet();
const replayAmounts = createAmountSchemaSet();
const replayEvidence = createEvidenceSchemaSet();

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

export interface ObservationExpectation {
  readonly slotId: string;
  readonly claims: readonly ObservationClaim[];
}

export interface ObservationReference {
  readonly observationId: ObservationId;
  readonly slotId: string;
  readonly role: string;
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

export interface EvidenceReplayResult {
  readonly conclusions: readonly Conclusion[];
  readonly coverage: Coverage;
  readonly warnings: readonly Warning[];
}

export interface EvidenceReplayDeclaration {
  readonly observationExpectations: readonly ObservationExpectation[];
  readonly observationReferences: readonly ObservationReference[];
  readonly factRequirements: readonly FactRequirement[];
  readonly expectedConclusionIds: readonly string[];
  readonly conclusionDrafts: readonly ConclusionDraft[];
  readonly warningRequirements: readonly WarningRequirement[];
}

const observationClaimSchema = jsonObject({
  role: replayPrimitives.fixedIdentifier,
  value: z.json(),
  chainAnchor: replayPrimitives.chainAnchor.optional(),
  asset: replayAmounts.assetIdentity.optional(),
}).strict();
const observationSlotSchema = z.discriminatedUnion("kind", [
  jsonObject({
    slotId: replayPrimitives.fixedIdentifier,
    factId: replayPrimitives.fixedIdentifier,
    kind: z.literal("validated_input"),
    purpose: replayPrimitives.snakeCaseCode,
  }).strict(),
  jsonObject({
    slotId: replayPrimitives.fixedIdentifier,
    factId: replayPrimitives.fixedIdentifier,
    kind: z.literal("source"),
    purpose: replayPrimitives.snakeCaseCode,
    sourceClass: replayEvidence.externalSourceClass,
  }).strict(),
]);
const factRequirementSchema = jsonObject({
  factId: replayPrimitives.fixedIdentifier,
  observationSlotIds: z.array(replayPrimitives.fixedIdentifier).min(1).max(128),
  requiredObservationSlotIds: z.array(replayPrimitives.fixedIdentifier).max(128),
  minimumObservationCount: z.number().int().min(0).max(128),
  outcome: replayEvidence.factOutcome,
}).strict();
const observationExpectationSchema = jsonObject({
  slotId: replayPrimitives.fixedIdentifier,
  claims: z.array(observationClaimSchema).min(1).max(8_192),
}).strict();
const observationReferenceSchema = jsonObject({
  observationId: replayEvidence.observationId,
  slotId: replayPrimitives.fixedIdentifier,
  role: replayPrimitives.fixedIdentifier,
}).strict();
const conclusionDraftSchema = jsonObject({
  id: replayPrimitives.fixedIdentifier,
  outcomeFactId: replayPrimitives.fixedIdentifier,
  evidenceFactIds: z.array(replayPrimitives.fixedIdentifier).min(1).max(128),
  freshnessRuleId: replayEvidence.freshnessRuleId,
}).strict();
const warningRequirementSchema = jsonObject({
  code: replayEvidence.warningCode,
  factIds: z.array(replayPrimitives.fixedIdentifier).min(1).max(128),
}).strict();

const canonicalUnique = (values: readonly string[]): readonly string[] =>
  Object.freeze(sortUniqueStrings(values));

const parseArray = <Value>(schema: ZodType<Value>, input: unknown): readonly Value[] => {
  let normalized: CanonicalJson;
  try {
    normalized = captureCanonicalJson(input);
  } catch {
    throw new TypeError("Evidence replay declaration is invalid.");
  }
  if (!Array.isArray(normalized)) throw new TypeError("Evidence replay declaration is invalid.");
  return Object.freeze(normalized.map((value) => deepFreezeValue(schema.parse(value))));
};

const conclusionAddressMarker = "<address>";
const zeroEvmAddress = "0x0000000000000000000000000000000000000000";

declare const evmAddressConclusionIdentityDeclarationType: unique symbol;
export interface EvmAddressConclusionIdentityDeclaration {
  readonly [evmAddressConclusionIdentityDeclarationType]: true;
}

interface EvmAddressConclusionIdentityDeclarationState {
  readonly prefix: string;
  readonly projection: string;
}

const evmAddressConclusionIdentityDeclarationStates =
  new WeakMap<object, EvmAddressConclusionIdentityDeclarationState>();

const evmAddressConclusionIdentityDeclarationState = (
  declaration: EvmAddressConclusionIdentityDeclaration,
): EvmAddressConclusionIdentityDeclarationState => {
  const state = typeof declaration === "object" && declaration !== null
    ? evmAddressConclusionIdentityDeclarationStates.get(declaration)
    : undefined;
  if (state === undefined) {
    throw new TypeError("EVM-address conclusion identity declaration provenance is invalid.");
  }
  return state;
};

export const createEvmAddressConclusionIdentityDeclaration = (
  prefixInput: string,
): EvmAddressConclusionIdentityDeclaration => {
  const prefix = replayPrimitives.fixedIdentifier.parse(prefixInput);
  if (prefix.includes("<") || prefix.includes(">")) {
    throw new TypeError("EVM-address conclusion identity prefix contains placeholder syntax.");
  }
  const projection = replayPrimitives.fixedIdentifier.parse(`${prefix}${conclusionAddressMarker}`);
  replayPrimitives.fixedIdentifier.parse(`${prefix}${zeroEvmAddress}`);
  const declaration = Object.freeze({}) as EvmAddressConclusionIdentityDeclaration;
  evmAddressConclusionIdentityDeclarationStates.set(declaration, Object.freeze({
    prefix,
    projection,
  }));
  return declaration;
};

export const createEvmAddressConclusionIdentity = (
  declaration: EvmAddressConclusionIdentityDeclaration,
  addressInput: EvmAddress,
): string => {
  const { prefix } = evmAddressConclusionIdentityDeclarationState(declaration);
  const address = replayPrimitives.evmAddress.parse(addressInput);
  return replayPrimitives.fixedIdentifier.parse(`${prefix}${address}`);
};

export type ConclusionIdentityDeclaration =
  | string
  | EvmAddressConclusionIdentityDeclaration;

interface ConclusionMatcher {
  readonly declaration: string;
  readonly duplicateKey: string;
  readonly dynamic: boolean;
  readonly prefix?: string;
  matches(value: string): boolean;
}

const compileConclusionMatcher = (
  declarationInput: ConclusionIdentityDeclaration,
): ConclusionMatcher => {
  if (typeof declarationInput === "string") {
    const declaration = replayPrimitives.fixedIdentifier.parse(declarationInput);
    if (declaration.includes("<") || declaration.includes(">")) {
      throw new TypeError("Exact conclusion identity contains placeholder syntax.");
    }
    return Object.freeze({
      declaration,
      duplicateKey: `exact:${declaration}`,
      dynamic: false,
      matches: (value: string) => value === declaration,
    });
  }
  const { prefix, projection } =
    evmAddressConclusionIdentityDeclarationState(declarationInput);
  return Object.freeze({
    declaration: projection,
    duplicateKey: `evm_address:${prefix}`,
    dynamic: true,
    prefix,
    matches(value: string): boolean {
      if (!value.startsWith(prefix)) return false;
      return replayPrimitives.evmAddress.safeParse(value.slice(prefix.length)).success;
    },
  });
};

const matchersOverlap = (left: ConclusionMatcher, right: ConclusionMatcher): boolean => {
  if (left.dynamic && right.dynamic) return left.prefix === right.prefix;
  if (!left.dynamic && !right.dynamic) return left.declaration === right.declaration;
  return left.dynamic
    ? left.matches(right.declaration)
    : right.matches(left.declaration);
};

declare const evidenceReplayDefinitionType: unique symbol;
export interface EvidenceReplayDefinition {
  readonly [evidenceReplayDefinitionType]: true;
}

interface EvidenceReplayDefinitionState {
  readonly capabilityId: CapabilityId;
  readonly conclusionIds: readonly string[];
  readonly conclusionMatchers: readonly ConclusionMatcher[];
  readonly warningCodes: readonly Warning["code"][];
}

const definitionStates = new WeakMap<object, EvidenceReplayDefinitionState>();

const definitionState = (definition: EvidenceReplayDefinition): EvidenceReplayDefinitionState => {
  const state = typeof definition === "object" && definition !== null
    ? definitionStates.get(definition)
    : undefined;
  if (state === undefined) throw new TypeError("Evidence replay definition provenance is invalid.");
  return state;
};

export const createEvidenceReplayDefinition = (input: {
  readonly capabilityId: string;
  readonly conclusionIds: readonly ConclusionIdentityDeclaration[];
  readonly warningCodes: readonly Warning["code"][];
}): EvidenceReplayDefinition => {
  const parsedCapabilityId = capabilityIdSchema.parse(input.capabilityId);
  const matcherInput = input.conclusionIds.map(compileConclusionMatcher);
  if (new Set(matcherInput.map((matcher) => matcher.duplicateKey)).size !== matcherInput.length) {
    throw new TypeError("Duplicate conclusion identity.");
  }
  const conclusionMatchers = Object.freeze(
    [...matcherInput].sort((left, right) =>
      compareCodePointSequences(left.declaration, right.declaration)
    ),
  );
  for (let index = 0; index < conclusionMatchers.length; index += 1) {
    for (let other = index + 1; other < conclusionMatchers.length; other += 1) {
      const left = conclusionMatchers[index];
      const right = conclusionMatchers[other];
      if (left !== undefined && right !== undefined && matchersOverlap(left, right)) {
        throw new TypeError("Conclusion identity declarations overlap.");
      }
    }
  }
  const conclusionIds = Object.freeze(conclusionMatchers.map((matcher) => matcher.declaration));
  const warningInput = input.warningCodes.map((value) => replayEvidence.warningCode.parse(value));
  const warningCodes = canonicalUnique(warningInput) as readonly Warning["code"][];
  if (warningCodes.length !== warningInput.length) throw new TypeError("Duplicate warning code.");
  const definition = Object.freeze({}) as EvidenceReplayDefinition;
  definitionStates.set(definition, Object.freeze({
    capabilityId: parsedCapabilityId,
    conclusionIds,
    conclusionMatchers,
    warningCodes,
  }));
  return definition;
};

export const readEvidenceReplayConclusionIds = (
  definition: EvidenceReplayDefinition,
): readonly string[] => definitionState(definition).conclusionIds;

declare const evidenceReplayLayoutType: unique symbol;
export interface EvidenceReplayLayout {
  readonly [evidenceReplayLayoutType]: true;
}

type PreparedObservationSlot = ObservationSlot & { readonly ordinal: string };

interface EvidenceReplayLayoutState {
  readonly definition: EvidenceReplayDefinition;
  readonly slots: readonly PreparedObservationSlot[];
  readonly slotById: ReadonlyMap<string, PreparedObservationSlot>;
}

const layoutStates = new WeakMap<object, EvidenceReplayLayoutState>();

const layoutState = (
  definition: EvidenceReplayDefinition,
  layout: EvidenceReplayLayout,
): EvidenceReplayLayoutState => {
  definitionState(definition);
  const state = typeof layout === "object" && layout !== null ? layoutStates.get(layout) : undefined;
  if (state === undefined || state.definition !== definition) {
    throw new TypeError("Evidence replay layout provenance is invalid.");
  }
  return state;
};

export const createEvidenceReplayLayout = (
  definition: EvidenceReplayDefinition,
  slotsInput: unknown,
): EvidenceReplayLayout => {
  definitionState(definition);
  const slots = parseArray(observationSlotSchema, slotsInput) as readonly ObservationSlot[];
  if (canonicalUnique(slots.map((slot) => slot.slotId)).length !== slots.length) {
    throw new TypeError("Duplicate observation slot identity.");
  }
  const prepared = Object.freeze(slots.map((slot, index) => Object.freeze({
    ...slot,
    ordinal: String(index),
  })));
  const layout = Object.freeze({}) as EvidenceReplayLayout;
  layoutStates.set(layout, Object.freeze({
    definition,
    slots: prepared,
    slotById: new Map(prepared.map((slot) => [slot.slotId, slot])),
  }));
  return layout;
};

export const readEvidenceReplaySlots = (
  definition: EvidenceReplayDefinition,
  layout: EvidenceReplayLayout,
): readonly ObservationSlot[] =>
  Object.freeze(layoutState(definition, layout).slots.map(({ ordinal: _ordinal, ...slot }) => Object.freeze(slot)));

export const createEvidenceObservationId = (
  definition: EvidenceReplayDefinition,
  layout: EvidenceReplayLayout,
  input: {
    readonly slotId: string;
    readonly sourceId: string;
    readonly observedAt: UtcTimestamp;
    readonly chainAnchor?: ChainAnchor;
    readonly invocationId: InvocationId;
  },
): ObservationId => {
  const state = layoutState(definition, layout);
  const slot = state.slotById.get(input.slotId);
  if (slot === undefined) throw new TypeError("Observation slot identity is invalid.");
  const observedAt = replayPrimitives.utcTimestamp.parse(input.observedAt);
  const chainAnchor = input.chainAnchor === undefined
    ? undefined
    : replayPrimitives.chainAnchor.parse(input.chainAnchor);
  const invocationId = replayEvidence.invocationId.parse(input.invocationId);
  const anchor = chainAnchor === undefined ? null : chainAnchor as unknown as CanonicalJson;
  const digest = canonicalSha256Base64Url([
    input.sourceId,
    slot.purpose,
    observedAt,
    anchor,
    invocationId,
    slot.ordinal,
  ]);
  return replayEvidence.observationId.parse(`obs:${digest}`);
};

const expectedSourceClass = (slot: ObservationSlot): SourceClass =>
  slot.kind === "validated_input" ? "validated_input" : slot.sourceClass;

const canonicalOptionalAnchor = (anchor: ChainAnchor | undefined): string =>
  canonicalJsonStringify((anchor ?? null) as unknown as CanonicalJson);

interface ObservedFact {
  readonly factId: string;
  readonly outcome: FactOutcome;
  readonly observationIds: readonly ObservationId[];
}

interface EvidenceObservationProjection {
  get(slotId: string): ObservationId | undefined;
  hasSlot(slotId: string): boolean;
  evidenceFor(observationId: string): EvidenceSource | undefined;
}

class ParsedEvidenceObservations implements EvidenceObservationProjection {
  readonly #bySlot = new Map<string, EvidenceSource>();
  readonly #byObservationId = new Map<string, EvidenceSource>();

  constructor(
    definition: EvidenceReplayDefinition,
    layout: EvidenceReplayLayout,
    sources: readonly EvidenceSource[],
    evaluatedAt: UtcTimestamp,
  ) {
    const definitionValue = definitionState(definition);
    const slots = layoutState(definition, layout).slots;
    const observationIds = sources.map((source) => source.observationId);
    if (!isStrictlyOrderedUnique(observationIds)) {
      throw new TypeError("Evidence sources must be unique and canonically ordered.");
    }
    const invocationId = sources[0]?.invocationId;
    const authorityByClass = new Map<SourceClass, string>();
    for (const source of sources) {
      if (source.observedAt > evaluatedAt) throw new TypeError("Observation time exceeds evaluation time.");
      if (source.invocationId !== invocationId) {
        throw new TypeError("Evidence source invocation identity is inconsistent.");
      }
      const authorityIdentity = canonicalJsonStringify({
        owner: source.owner,
        reference: source.reference,
      } as unknown as CanonicalJson);
      const currentAuthority = authorityByClass.get(source.sourceClass);
      if (currentAuthority !== undefined && currentAuthority !== authorityIdentity) {
        throw new TypeError("One invocation uses conflicting source identities.");
      }
      authorityByClass.set(source.sourceClass, authorityIdentity);
      const candidates = slots.filter((slot) =>
        expectedSourceClass(slot) === source.sourceClass &&
        slot.purpose === source.purpose &&
        createEvidenceObservationId(definition, layout, {
          slotId: slot.slotId,
          sourceId: source.reference.sourceId,
          observedAt: source.observedAt,
          ...(source.chainAnchor === undefined ? {} : { chainAnchor: source.chainAnchor }),
          invocationId: source.invocationId,
        }) === source.observationId);
      if (candidates.length !== 1) {
        throw new TypeError("Evidence source does not match one declared observation slot.");
      }
      const slot = candidates[0] as PreparedObservationSlot;
      if (this.#bySlot.has(slot.slotId)) throw new TypeError("Observation slot is duplicated.");
      if (slot.kind === "validated_input" && (
        source.owner !== `${productDisplayName} validated input` ||
        source.reference.kind !== "validated_input" ||
        source.reference.sourceId !== `input:${definitionValue.capabilityId}`
      )) throw new TypeError("Validated-input evidence identity is invalid.");
      this.#bySlot.set(slot.slotId, source);
      this.#byObservationId.set(source.observationId, source);
    }
  }

  get(slotId: string): ObservationId | undefined {
    return this.#bySlot.get(slotId)?.observationId;
  }

  hasSlot(slotId: string): boolean {
    return this.#bySlot.has(slotId);
  }

  evidenceFor(observationId: string): EvidenceSource | undefined {
    return this.#byObservationId.get(observationId);
  }
}

const validateDefinitionStructure = (
  slots: readonly PreparedObservationSlot[],
  requirements: readonly FactRequirement[],
): void => {
  const factIds = canonicalUnique(requirements.map((requirement) => requirement.factId));
  if (factIds.length !== requirements.length) throw new TypeError("Duplicate definition identity.");
  const slotById = new Map(slots.map((slot) => [slot.slotId, slot]));
  const requirementByFactId = new Map(requirements.map((requirement) => [requirement.factId, requirement]));
  for (const requirement of requirements) {
    const ordered = canonicalUnique(requirement.observationSlotIds);
    if (ordered.length !== requirement.observationSlotIds.length) {
      throw new TypeError("Duplicate fact observation slot.");
    }
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
      if (slot === undefined || slot.factId !== requirement.factId) {
        throw new TypeError("Fact requirement does not own its observation slot.");
      }
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

const prepareObservationExpectations = (
  slots: readonly PreparedObservationSlot[],
  expectationsInput: unknown,
): ReadonlyMap<string, readonly ObservationClaim[]> => {
  const expectations = parseArray(
    observationExpectationSchema,
    expectationsInput,
  ) as readonly ObservationExpectation[];
  const slotIds = new Set(slots.map((slot) => slot.slotId));
  const result = new Map<string, readonly ObservationClaim[]>();
  for (const expectation of expectations) {
    if (!slotIds.has(expectation.slotId) || result.has(expectation.slotId)) {
      throw new TypeError("Observation expectation identity is invalid.");
    }
    const claims = [...expectation.claims].sort((left, right) =>
      compareCodePointSequences(left.role, right.role));
    if (canonicalUnique(claims.map((claim) => claim.role)).length !== claims.length) {
      throw new TypeError("Observation expectation claims are invalid.");
    }
    result.set(expectation.slotId, Object.freeze(claims));
  }
  return result;
};

const assertExpectedSourceAnchors = (
  observations: EvidenceObservationProjection,
  expectations: ReadonlyMap<string, readonly ObservationClaim[]>,
): void => {
  for (const [slotId, claims] of expectations) {
    const observationId = observations.get(slotId);
    if (observationId === undefined) continue;
    const source = observations.evidenceFor(observationId);
    if (source === undefined) throw new TypeError("Observation source is unavailable.");
    const anchors = claims.flatMap((claim) => claim.chainAnchor === undefined ? [] : [claim.chainAnchor]);
    const expected = anchors[0];
    if (anchors.some((anchor) => canonicalOptionalAnchor(anchor) !== canonicalOptionalAnchor(expected))) {
      throw new TypeError("Observation expectation contains conflicting anchors.");
    }
    if (canonicalOptionalAnchor(source.chainAnchor) !== canonicalOptionalAnchor(expected)) {
      throw new TypeError("Observation source anchor does not match its definition.");
    }
  }
};

const assertPublicEvidenceClosure = (
  slots: readonly PreparedObservationSlot[],
  expectations: ReadonlyMap<string, readonly ObservationClaim[]>,
  references: readonly ObservationReference[],
  observations: EvidenceObservationProjection,
): void => {
  for (const slot of slots) {
    if (observations.hasSlot(slot.slotId) && !expectations.has(slot.slotId)) {
      throw new TypeError("Observed slot has no definition-owned expectation.");
    }
  }
  const identities = new Set<string>();
  for (const reference of references) {
    const identity = canonicalJsonStringify(reference as unknown as CanonicalJson);
    if (identities.has(identity)) throw new TypeError("Public observation reference is duplicated.");
    identities.add(identity);
    if (observations.get(reference.slotId) !== reference.observationId) {
      throw new TypeError("Public observation reference does not match its declared slot.");
    }
    const claims = expectations.get(reference.slotId);
    if (claims === undefined || !claims.some((claim) => claim.role === reference.role)) {
      throw new TypeError("Public observation reference role is not owned by its declared slot.");
    }
  }
  assertExpectedSourceAnchors(observations, expectations);
};

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

const conclusionOutcome = (outcome: FactOutcome): Pick<Conclusion, "status" | "reason"> => ({
  status: factOutcomeDefinitions[outcome].conclusionStatus,
  reason: outcome,
});

export const replayPublicEvidence = (input: EvidenceReplayDeclaration & {
  readonly definition: EvidenceReplayDefinition;
  readonly layout: EvidenceReplayLayout;
  readonly evaluatedAt: UtcTimestamp;
  readonly sources: readonly EvidenceSource[];
}): EvidenceReplayResult => {
  const definition = definitionState(input.definition);
  const layout = layoutState(input.definition, input.layout);
  const evaluatedAt = replayPrimitives.utcTimestamp.parse(input.evaluatedAt);
  const sources = parseArray(replayEvidence.evidenceSource, input.sources) as readonly EvidenceSource[];
  const requirements = parseArray(
    factRequirementSchema,
    input.factRequirements,
  ) as readonly FactRequirement[];
  validateDefinitionStructure(layout.slots, requirements);
  const expectations = prepareObservationExpectations(layout.slots, input.observationExpectations);
  const references = parseArray(
    observationReferenceSchema,
    input.observationReferences,
  ) as readonly ObservationReference[];
  const observations = new ParsedEvidenceObservations(
    input.definition,
    input.layout,
    sources,
    evaluatedAt,
  );
  assertPublicEvidenceClosure(layout.slots, expectations, references, observations);

  const slotById = new Map(layout.slots.map((slot) => [slot.slotId, slot]));
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
    const observedSlots = requirement.observationSlotIds
      .map((slotId) => slotById.get(slotId))
      .filter((slot): slot is PreparedObservationSlot =>
        slot !== undefined && observations.hasSlot(slot.slotId));
    const authority = factOutcomeDefinitions[requirement.outcome].evidenceAuthority;
    if (authority === "none" && observedSlots.length !== 0) {
      throw new TypeError("Fact outcome must not claim evidence.");
    }
    if (authority === "external" && (
      observedSlots.length === 0 || observedSlots.some((slot) => slot.kind !== "source")
    )) throw new TypeError("External fact evidence authority is invalid.");
    if (authority === "validated_input" && (
      observedSlots.length === 0 || observedSlots.some((slot) => slot.kind !== "validated_input")
    )) throw new TypeError("Validated-input fact evidence authority is invalid.");
    facts.set(requirement.factId, deepFreezeValue({
      factId: requirement.factId,
      outcome: requirement.outcome,
      observationIds,
    }));
  }
  if (facts.size !== requirements.length) throw new TypeError("Fact output is incomplete.");

  const expectedInput = parseArray(replayPrimitives.fixedIdentifier, input.expectedConclusionIds);
  const expectedConclusionIds = canonicalUnique(expectedInput);
  if (expectedConclusionIds.length !== expectedInput.length) {
    throw new TypeError("Expected conclusion identities are duplicated.");
  }
  for (const expectedId of expectedConclusionIds) {
    const matches = definition.conclusionMatchers.filter((matcher) => matcher.matches(expectedId)).length;
    if (matches !== 1) throw new TypeError("Expected conclusion identity is undeclared or ambiguous.");
  }
  const drafts = parseArray(conclusionDraftSchema, input.conclusionDrafts) as readonly ConclusionDraft[];
  const conclusions = drafts.map((draft): Conclusion => {
    const factIds = canonicalUnique(draft.evidenceFactIds);
    if (factIds.length !== draft.evidenceFactIds.length) {
      throw new TypeError("Conclusion fact evidence is duplicated.");
    }
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
    return deepFreezeValue({
      id: draft.id,
      status: outcome.status,
      reason: outcome.reason,
      observationIds,
      freshness: {
        status: freshnessRuleDefinitions[draft.freshnessRuleId].status,
        ruleId: draft.freshnessRuleId,
        evaluatedAt,
        observationIds,
      },
    }) as Conclusion;
  }).sort((left, right) => compareCodePointSequences(left.id, right.id));
  if (!isStrictlyOrderedUnique(conclusions.map((conclusion) => conclusion.id))) {
    throw new TypeError("Conclusion identities are not unique and ordered.");
  }
  if (conclusions.map((conclusion) => conclusion.id).join("\0") !== expectedConclusionIds.join("\0")) {
    throw new TypeError("Capability conclusions are incomplete or undeclared.");
  }

  const warningRequirements = parseArray(
    warningRequirementSchema,
    input.warningRequirements,
  ) as readonly WarningRequirement[];
  const warningInputs = warningRequirements.map((candidate) => {
    if (!definition.warningCodes.includes(candidate.code)) throw new TypeError("Warning is not declared.");
    const factIds = canonicalUnique(candidate.factIds);
    if (factIds.length !== candidate.factIds.length) {
      throw new TypeError("Warning fact evidence is duplicated.");
    }
    const observationIds = canonicalUnique(factIds.flatMap((factId) => {
      const fact = facts.get(factId);
      if (fact === undefined) throw new TypeError("Warning fact is invalid.");
      return fact.observationIds;
    })) as readonly ObservationId[];
    if (observationIds.length === 0) throw new TypeError("Warning evidence is invalid.");
    return { code: candidate.code, observationIds };
  });
  const summary = createEvidenceSummary(conclusions, warningInputs);
  const warningIdentities = summary.warnings.map((warning) =>
    canonicalJsonStringify(warning as unknown as CanonicalJson));
  if (!isStrictlyOrderedUnique(warningIdentities)) throw new TypeError("Warnings are not unique and ordered.");
  return deepFreezeValue({
    conclusions,
    coverage: summary.coverage,
    warnings: summary.warnings,
  });
};
