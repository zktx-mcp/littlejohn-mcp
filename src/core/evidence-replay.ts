import { z } from "zod";

import { createAmountSchemaSet, type AssetIdentity } from "./amounts.js";
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
import { canonicalJsonArrayLengthLimit } from "./canonical-json-limits.js";
import {
  createEvidenceSchemaSet,
  createEvidenceSummary,
  evidenceConclusionCountLimit,
  evidenceObservationCountLimit,
  evidenceReplayFactRequirementCountLimit,
  evidenceWarningCountLimit,
  factOutcomeDefinitions,
  freshnessRuleDefinitions,
  invocationSourceIdentity,
  sourceReferenceIdentity,
  type Conclusion,
  type Coverage,
  type EvidenceSource,
  type EvidenceSourceRecord,
  type FactOutcome,
  type Freshness,
  type InvocationId,
  type ObservationId,
  type SourceClass,
  type Warning,
} from "./evidence.js";
import { deepFreezeValue } from "./immutability.js";
import { jsonObject } from "./json-object.js";
import {
  compareCodePointSequences,
  isStrictlyOrderedUnique,
  createPrimitiveSchemaSet,
  sortUniqueStrings,
  type ChainAnchor,
  type EvmAddress,
  type UtcTimestamp,
} from "./primitives.js";

const replayPrimitives = createPrimitiveSchemaSet();
const replayAmounts = createAmountSchemaSet();
const replayEvidence = createEvidenceSchemaSet();
const evidenceObservationTargetRoleCountLimit = 8_192 as const;
const evidenceReplayReferenceCountLimit = 8_192 as const;

declare const evidenceFactIdentityDeclarationType: unique symbol;
export interface EvidenceFactIdentityDeclaration {
  readonly [evidenceFactIdentityDeclarationType]: true;
}

declare const evidenceObservationSlotDeclarationType: unique symbol;
export interface EvidenceObservationSlotDeclaration {
  readonly [evidenceObservationSlotDeclarationType]: true;
}

declare const evidenceClaimRoleDeclarationType: unique symbol;
export interface EvidenceClaimRoleDeclaration {
  readonly [evidenceClaimRoleDeclarationType]: true;
}

declare const boundEvidenceObservationSlotDeclarationType: unique symbol;
export interface BoundEvidenceObservationSlotDeclaration {
  readonly [boundEvidenceObservationSlotDeclarationType]: true;
}

declare const boundEvidenceClaimRoleDeclarationType: unique symbol;
export interface BoundEvidenceClaimRoleDeclaration {
  readonly [boundEvidenceClaimRoleDeclarationType]: true;
}

export interface EvidenceObservationTargetDeclaration<
  Roles extends Readonly<Record<string, EvidenceClaimRoleDeclaration>> =
    Readonly<Record<string, EvidenceClaimRoleDeclaration>>,
> {
  readonly slot: EvidenceObservationSlotDeclaration;
  readonly roles: Roles;
}

export type BoundEvidenceObservationTarget<
  Target extends EvidenceObservationTargetDeclaration =
    EvidenceObservationTargetDeclaration,
> = Readonly<{
  slot: BoundEvidenceObservationSlotDeclaration;
  roles: Readonly<{
    [Key in keyof Target["roles"]]: BoundEvidenceClaimRoleDeclaration;
  }>;
}>;

export interface EvidenceReplayBinder {
  bind<Target extends EvidenceObservationTargetDeclaration>(
    target: Target,
  ): BoundEvidenceObservationTarget<Target>;
  bindRole(role: EvidenceClaimRoleDeclaration): BoundEvidenceClaimRoleDeclaration;
}

export interface ObservationClaim {
  readonly role: BoundEvidenceClaimRoleDeclaration;
  readonly value: CanonicalJson;
  readonly chainAnchor?: ChainAnchor;
  readonly asset?: AssetIdentity;
}

export interface FactRequirement {
  readonly fact: EvidenceFactIdentityDeclaration;
  readonly observationSlots: readonly BoundEvidenceObservationSlotDeclaration[];
  readonly requiredObservationSlots: readonly BoundEvidenceObservationSlotDeclaration[];
  readonly minimumObservationCount: number;
  readonly outcome: FactOutcome;
}

type ObservationSlotProjection =
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
  readonly slot: BoundEvidenceObservationSlotDeclaration;
  readonly claims: readonly ObservationClaim[];
}

export interface ObservationReference {
  readonly observationId: ObservationId;
  readonly slot: BoundEvidenceObservationSlotDeclaration;
  readonly role: BoundEvidenceClaimRoleDeclaration;
}

export interface ConclusionDraft {
  readonly conclusion: ExactConclusionIdentityDeclaration;
  readonly outcomeFact: EvidenceFactIdentityDeclaration;
  readonly evidenceFacts: readonly EvidenceFactIdentityDeclaration[];
  readonly freshnessRuleId: Freshness["ruleId"];
}

export interface WarningRequirement {
  readonly code: Warning["code"];
  readonly facts: readonly EvidenceFactIdentityDeclaration[];
}

export interface EvidenceReplayResult {
  readonly conclusions: readonly Conclusion[];
  readonly coverage: Coverage;
  readonly warnings: readonly Warning[];
}

export interface EvidenceReplayDeclaration {
  readonly conclusionSet?: EvidenceConclusionSetDeclaration;
  readonly observationExpectations: readonly ObservationExpectation[];
  readonly observationReferences: readonly ObservationReference[];
  readonly factRequirements: readonly FactRequirement[];
  readonly conclusionDrafts: readonly ConclusionDraft[];
  readonly warningRequirements: readonly WarningRequirement[];
}

const observationClaimValueSchema = jsonObject({
  value: z.json(),
  chainAnchor: replayPrimitives.chainAnchor.optional(),
  asset: replayAmounts.assetIdentity.optional(),
}).strict();

const canonicalUnique = (values: readonly string[]): readonly string[] =>
  Object.freeze(sortUniqueStrings(values));

const parseBoundedArray = <Value>(
  input: readonly Value[],
  minimum: number,
  maximum: number,
  message: string,
): readonly Value[] => {
  if (!Array.isArray(input) || input.length < minimum || input.length > maximum) {
    throw new TypeError(message);
  }
  return input;
};

const conclusionAddressMarker = "<address>";
const zeroEvmAddress = "0x0000000000000000000000000000000000000000";

declare const exactConclusionIdentityDeclarationType: unique symbol;
export interface ExactConclusionIdentityDeclaration {
  readonly [exactConclusionIdentityDeclarationType]: true;
}

declare const evidenceConclusionSetDeclarationType: unique symbol;
export interface EvidenceConclusionSetDeclaration {
  readonly [evidenceConclusionSetDeclarationType]: true;
}

interface ExactConclusionIdentityDeclarationState {
  readonly identity: string;
  readonly family?: EvmAddressConclusionIdentityDeclaration;
  readonly scope?: EvidenceDeclarationScope;
}

const exactConclusionIdentityDeclarationStates =
  new WeakMap<object, ExactConclusionIdentityDeclarationState>();

const exactConclusionIdentityDeclarationState = (
  declaration: ExactConclusionIdentityDeclaration,
): ExactConclusionIdentityDeclarationState => {
  const state = typeof declaration === "object" && declaration !== null
    ? exactConclusionIdentityDeclarationStates.get(declaration)
    : undefined;
  if (state === undefined) {
    throw new TypeError("Exact conclusion identity declaration provenance is invalid.");
  }
  return state;
};

export const createExactConclusionIdentityDeclaration = (
  identityInput: string,
): ExactConclusionIdentityDeclaration => {
  const identity = replayPrimitives.fixedIdentifier.parse(identityInput);
  if (identity.includes("<") || identity.includes(">")) {
    throw new TypeError("Exact conclusion identity contains placeholder syntax.");
  }
  const declaration = Object.freeze({}) as ExactConclusionIdentityDeclaration;
  exactConclusionIdentityDeclarationStates.set(declaration, Object.freeze({ identity }));
  return declaration;
};

interface EvidenceConclusionSetDeclarationState {
  readonly conclusions: readonly ExactConclusionIdentityDeclaration[];
}

const evidenceConclusionSetDeclarationStates =
  new WeakMap<object, EvidenceConclusionSetDeclarationState>();
const evidenceConclusionSetDeclarationOwners =
  new WeakMap<object, EvidenceReplayDefinition>();

export const createEvidenceConclusionSetDeclaration = (
  conclusionsInput: readonly ExactConclusionIdentityDeclaration[],
): EvidenceConclusionSetDeclaration => {
  const conclusions = parseBoundedArray(
    conclusionsInput,
    1,
    evidenceConclusionCountLimit,
    "Evidence conclusion set is invalid.",
  ).map((conclusion) => {
    exactConclusionIdentityDeclarationState(conclusion);
    return conclusion;
  }).sort((left, right) => compareCodePointSequences(
    exactConclusionIdentityDeclarationState(left).identity,
    exactConclusionIdentityDeclarationState(right).identity,
  ));
  if (new Set(conclusions).size !== conclusions.length ||
      canonicalUnique(conclusions.map((conclusion) =>
        exactConclusionIdentityDeclarationState(conclusion).identity)).length !==
        conclusions.length) {
    throw new TypeError("Evidence conclusion set contains duplicates.");
  }
  const declaration = Object.freeze({}) as EvidenceConclusionSetDeclaration;
  evidenceConclusionSetDeclarationStates.set(declaration, Object.freeze({
    conclusions: Object.freeze(conclusions),
  }));
  return declaration;
};

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

export type ConclusionIdentityDeclaration =
  | ExactConclusionIdentityDeclaration
  | EvmAddressConclusionIdentityDeclaration;

declare const evidenceReplayDefinitionType: unique symbol;
export interface EvidenceReplayDefinition {
  readonly [evidenceReplayDefinitionType]: true;
}

declare const evidenceDeclarationScopeType: unique symbol;
export interface EvidenceDeclarationScope {
  readonly [evidenceDeclarationScopeType]: true;
}

const conclusionDeclarationOwners =
  new WeakMap<object, EvidenceReplayDefinition>();

export const createEvmAddressConclusionIdentity = (
  declaration: EvmAddressConclusionIdentityDeclaration,
  addressInput: EvmAddress,
): ExactConclusionIdentityDeclaration => {
  const family = evmAddressConclusionIdentityDeclarationState(declaration);
  const definition = conclusionDeclarationOwners.get(declaration as object);
  if (definition === undefined) {
    throw new TypeError("EVM-address conclusion identity family is not definition-owned.");
  }
  const address = replayPrimitives.evmAddress.parse(addressInput);
  const identity = replayPrimitives.fixedIdentifier.parse(`${family.prefix}${address}`);
  const result = Object.freeze({}) as ExactConclusionIdentityDeclaration;
  exactConclusionIdentityDeclarationStates.set(result, Object.freeze({
    identity,
    family: declaration,
  }));
  conclusionDeclarationOwners.set(result as object, definition);
  return result;
};

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
  if (conclusionDeclarationOwners.has(declarationInput as object)) {
    throw new TypeError("Conclusion identity declaration already has an owner.");
  }
  if (exactConclusionIdentityDeclarationStates.has(declarationInput as object)) {
    const declaration = exactConclusionIdentityDeclarationState(
      declarationInput as ExactConclusionIdentityDeclaration,
    ).identity;
    return Object.freeze({
      declaration,
      duplicateKey: `exact:${declaration}`,
      dynamic: false,
      matches: (value: string) => value === declaration,
    });
  }
  const family = evmAddressConclusionIdentityDeclarationState(
    declarationInput as EvmAddressConclusionIdentityDeclaration,
  );
  return Object.freeze({
    declaration: family.projection,
    duplicateKey: `evm_address:${family.prefix}`,
    dynamic: true,
    prefix: family.prefix,
    matches(value: string): boolean {
      if (!value.startsWith(family.prefix)) return false;
      return replayPrimitives.evmAddress.safeParse(value.slice(family.prefix.length)).success;
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

interface EvidenceReplayDefinitionState {
  readonly capabilityId: CapabilityId;
  readonly conclusionIds: readonly string[];
  readonly conclusionMatchers: readonly ConclusionMatcher[];
  readonly fixedConclusions: readonly ExactConclusionIdentityDeclaration[];
  readonly conclusionSets: readonly EvidenceConclusionSetDeclaration[];
  readonly warningCodes: readonly Warning["code"][];
  readonly factsById: Map<string, EvidenceFactIdentityDeclaration>;
  readonly slotsById: Map<string, EvidenceObservationSlotDeclaration[]>;
}

interface EvidenceDeclarationRegistry {
  readonly factsById: Map<string, EvidenceFactIdentityDeclaration>;
  readonly slotsById: Map<string, EvidenceObservationSlotDeclaration[]>;
}

interface EvidenceDeclarationScopeState extends EvidenceDeclarationRegistry {
  readonly definition: EvidenceReplayDefinition;
  readonly conclusionsById: Map<string, ExactConclusionIdentityDeclaration>;
}

const definitionStates = new WeakMap<object, EvidenceReplayDefinitionState>();
const declarationScopeStates = new WeakMap<object, EvidenceDeclarationScopeState>();
const definitionsWithScopedDeclarations = new WeakSet<object>();

const definitionState = (definition: EvidenceReplayDefinition): EvidenceReplayDefinitionState => {
  const state = typeof definition === "object" && definition !== null
    ? definitionStates.get(definition)
    : undefined;
  if (state === undefined) throw new TypeError("Evidence replay definition provenance is invalid.");
  return state;
};

const declarationScopeState = (
  definition: EvidenceReplayDefinition,
  scope: EvidenceDeclarationScope,
): EvidenceDeclarationScopeState => {
  definitionState(definition);
  const state = typeof scope === "object" && scope !== null
    ? declarationScopeStates.get(scope)
    : undefined;
  if (state === undefined || state.definition !== definition) {
    throw new TypeError("Evidence declaration scope provenance is invalid.");
  }
  return state;
};

export const createEvidenceReplayDefinition = (input: {
  readonly capabilityId: string;
  readonly conclusions: readonly ConclusionIdentityDeclaration[];
  readonly conclusionSets?: readonly EvidenceConclusionSetDeclaration[];
  readonly warningCodes: readonly Warning["code"][];
}): EvidenceReplayDefinition => {
  const capabilityId = capabilityIdSchema.parse(input.capabilityId);
  const baseConclusions = parseBoundedArray(
    input.conclusions,
    1,
    evidenceConclusionCountLimit,
    "Evidence replay conclusion declarations are invalid.",
  );
  const conclusionSets = input.conclusionSets === undefined
    ? Object.freeze([])
    : Object.freeze(parseBoundedArray(
        input.conclusionSets,
        2,
        evidenceConclusionCountLimit,
        "Evidence replay conclusion sets are invalid.",
      ).map((declaration) => {
        const state = typeof declaration === "object" && declaration !== null
          ? evidenceConclusionSetDeclarationStates.get(declaration)
          : undefined;
        if (state === undefined) {
          throw new TypeError("Evidence conclusion set provenance is invalid.");
        }
        if (evidenceConclusionSetDeclarationOwners.has(declaration as object)) {
          throw new TypeError("Evidence conclusion set already has an owner.");
        }
        return declaration;
      }));
  if (new Set(conclusionSets).size !== conclusionSets.length) {
    throw new TypeError("Duplicate evidence conclusion set.");
  }
  const setSignatures = conclusionSets.map((declaration) => {
    const state = evidenceConclusionSetDeclarationStates.get(declaration as object);
    if (state === undefined) throw new TypeError("Evidence conclusion set provenance is invalid.");
    return state.conclusions.map((conclusion) =>
      exactConclusionIdentityDeclarationState(conclusion).identity).join("\0");
  });
  if (new Set(setSignatures).size !== setSignatures.length) {
    throw new TypeError("Duplicate evidence conclusion set contents.");
  }
  const conclusions = parseBoundedArray(
    [
      ...baseConclusions,
      ...conclusionSets.flatMap((declaration) => {
        const state = evidenceConclusionSetDeclarationStates.get(declaration as object);
        if (state === undefined) {
          throw new TypeError("Evidence conclusion set provenance is invalid.");
        }
        return state.conclusions;
      }),
    ],
    1,
    evidenceConclusionCountLimit,
    "Evidence replay conclusion declarations are invalid.",
  );
  const matcherInput = conclusions.map(compileConclusionMatcher);
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
  const fixedConclusions = Object.freeze(baseConclusions
    .flatMap((declaration) => exactConclusionIdentityDeclarationStates.has(declaration as object)
      ? [declaration as ExactConclusionIdentityDeclaration]
      : [])
    .sort((left, right) => compareCodePointSequences(
      exactConclusionIdentityDeclarationState(left).identity,
      exactConclusionIdentityDeclarationState(right).identity,
    )));
  const warningInput = input.warningCodes.map((value) => replayEvidence.warningCode.parse(value));
  const warningCodes = canonicalUnique(warningInput) as readonly Warning["code"][];
  if (warningCodes.length !== warningInput.length) throw new TypeError("Duplicate warning code.");

  const definition = Object.freeze({}) as EvidenceReplayDefinition;
  definitionStates.set(definition, {
    capabilityId,
    conclusionIds,
    conclusionMatchers,
    fixedConclusions,
    conclusionSets,
    warningCodes,
    factsById: new Map(),
    slotsById: new Map(),
  });
  for (const declaration of conclusions) {
    conclusionDeclarationOwners.set(declaration as object, definition);
  }
  for (const declaration of conclusionSets) {
    evidenceConclusionSetDeclarationOwners.set(declaration as object, definition);
  }
  return definition;
};

export const createEvidenceDeclarationScope = (
  definition: EvidenceReplayDefinition,
): EvidenceDeclarationScope => {
  definitionState(definition);
  definitionsWithScopedDeclarations.add(definition as object);
  const scope = Object.freeze({}) as EvidenceDeclarationScope;
  declarationScopeStates.set(scope, {
    definition,
    conclusionsById: new Map(),
    factsById: new Map(),
    slotsById: new Map(),
  });
  return scope;
};

export const readEvidenceReplayConclusionIds = (
  definition: EvidenceReplayDefinition,
): readonly string[] => definitionState(definition).conclusionIds;

export const readEvidenceReplayCapabilityId = (
  definition: EvidenceReplayDefinition,
): CapabilityId => definitionState(definition).capabilityId;

export const readEvidenceReplayWarningCodes = (
  definition: EvidenceReplayDefinition,
): readonly Warning["code"][] => definitionState(definition).warningCodes;

interface EvidenceFactIdentityDeclarationState {
  readonly definition: EvidenceReplayDefinition;
  readonly identity: string;
  readonly scope?: EvidenceDeclarationScope;
}

const factIdentityDeclarationStates =
  new WeakMap<object, EvidenceFactIdentityDeclarationState>();

const factIdentityDeclarationState = (
  definition: EvidenceReplayDefinition,
  declaration: EvidenceFactIdentityDeclaration,
): EvidenceFactIdentityDeclarationState => {
  definitionState(definition);
  const state = typeof declaration === "object" && declaration !== null
    ? factIdentityDeclarationStates.get(declaration)
    : undefined;
  if (state === undefined || state.definition !== definition) {
    throw new TypeError("Evidence fact identity declaration provenance is invalid.");
  }
  return state;
};

export const createEvidenceFactIdentityDeclaration = (
  definition: EvidenceReplayDefinition,
  identityInput: string,
): EvidenceFactIdentityDeclaration => {
  const state = definitionState(definition);
  if (definitionsWithScopedDeclarations.has(definition as object)) {
    throw new TypeError("Static evidence declarations are closed.");
  }
  const identity = replayPrimitives.fixedIdentifier.parse(identityInput);
  if (state.factsById.has(identity)) throw new TypeError("Duplicate evidence fact identity.");
  const declaration = Object.freeze({}) as EvidenceFactIdentityDeclaration;
  factIdentityDeclarationStates.set(declaration, Object.freeze({ definition, identity }));
  state.factsById.set(identity, declaration);
  return declaration;
};

export const createEvidenceFactIdentityForConclusion = (
  definition: EvidenceReplayDefinition,
  conclusion: ExactConclusionIdentityDeclaration,
  scope: EvidenceDeclarationScope,
): EvidenceFactIdentityDeclaration => {
  const registry = declarationScopeState(definition, scope);
  const conclusionState = exactConclusionIdentityDeclarationState(conclusion);
  if (conclusionState.family === undefined) {
    throw new TypeError("Dynamic evidence fact requires a dynamic conclusion identity.");
  }
  const identity = readConclusionIdentity(definition, conclusion);
  if (definitionState(definition).factsById.has(identity) ||
      registry.factsById.has(identity) ||
      registry.conclusionsById.has(identity)) {
    throw new TypeError("Duplicate evidence fact identity.");
  }
  if (conclusionState.scope !== undefined && conclusionState.scope !== scope) {
    throw new TypeError("Dynamic conclusion identity belongs to another declaration scope.");
  }
  exactConclusionIdentityDeclarationStates.set(conclusion as object, Object.freeze({
    ...conclusionState,
    scope,
  }));
  const declaration = Object.freeze({}) as EvidenceFactIdentityDeclaration;
  factIdentityDeclarationStates.set(
    declaration,
    Object.freeze({ definition, identity, scope }),
  );
  registry.conclusionsById.set(identity, conclusion);
  registry.factsById.set(identity, declaration);
  return declaration;
};

type EvidenceObservationTargetInput<
  Roles extends Readonly<
    Record<string, string | ExactConclusionIdentityDeclaration>
  >,
> = Readonly<{
  slotId: string;
  fact: EvidenceFactIdentityDeclaration;
  purpose: string;
  roles: Roles;
}> & (
  | Readonly<{
      kind: "validated_input";
      owner: string;
      sourceId: string;
    }>
  | Readonly<{
      kind: "source";
      sourceClass: Exclude<SourceClass, "validated_input">;
    }>
);

export interface ValidatedInputEvidenceIdentity {
  readonly owner: string;
  readonly sourceId: string;
}

interface EvidenceObservationSlotDeclarationState {
  readonly definition: EvidenceReplayDefinition;
  readonly projection: ObservationSlotProjection;
  readonly fact: EvidenceFactIdentityDeclaration;
  readonly target: EvidenceObservationTargetDeclaration;
  readonly scope?: EvidenceDeclarationScope;
  readonly validatedInputIdentity?: ValidatedInputEvidenceIdentity;
}

interface EvidenceClaimRoleDeclarationState {
  readonly slot: EvidenceObservationSlotDeclaration;
  readonly identity: string;
}

interface EvidenceObservationTargetDeclarationState {
  readonly definition: EvidenceReplayDefinition;
  readonly slot: EvidenceObservationSlotDeclaration;
  readonly roles: Readonly<Record<string, EvidenceClaimRoleDeclaration>>;
  readonly rolesByIdentity: Map<string, EvidenceClaimRoleDeclaration>;
}

const observationSlotDeclarationStates =
  new WeakMap<object, EvidenceObservationSlotDeclarationState>();
const claimRoleDeclarationStates =
  new WeakMap<object, EvidenceClaimRoleDeclarationState>();
const observationTargetDeclarationStates =
  new WeakMap<object, EvidenceObservationTargetDeclarationState>();

const registerEvidenceClaimRoleDeclaration = (
  slot: EvidenceObservationSlotDeclaration,
  rolesByIdentity: Map<string, EvidenceClaimRoleDeclaration>,
  identity: string,
): EvidenceClaimRoleDeclaration => {
  if (rolesByIdentity.has(identity)) {
    throw new TypeError("Duplicate evidence claim role identity.");
  }
  if (rolesByIdentity.size >= evidenceObservationTargetRoleCountLimit) {
    throw new TypeError("Evidence observation target claim-role capacity is exceeded.");
  }
  const role = Object.freeze({}) as EvidenceClaimRoleDeclaration;
  claimRoleDeclarationStates.set(role, Object.freeze({ slot, identity }));
  rolesByIdentity.set(identity, role);
  return role;
};

const observationTargetDeclarationState = (
  definition: EvidenceReplayDefinition,
  target: EvidenceObservationTargetDeclaration,
): EvidenceObservationTargetDeclarationState => {
  definitionState(definition);
  const state = typeof target === "object" && target !== null
    ? observationTargetDeclarationStates.get(target)
    : undefined;
  if (state === undefined || state.definition !== definition) {
    throw new TypeError("Evidence observation target declaration provenance is invalid.");
  }
  return state;
};

const observationSlotDeclarationState = (
  definition: EvidenceReplayDefinition,
  slot: EvidenceObservationSlotDeclaration,
): EvidenceObservationSlotDeclarationState => {
  definitionState(definition);
  const state = typeof slot === "object" && slot !== null
    ? observationSlotDeclarationStates.get(slot)
    : undefined;
  if (state === undefined || state.definition !== definition) {
    throw new TypeError("Evidence observation slot declaration provenance is invalid.");
  }
  return state;
};

const claimRoleDeclarationState = (
  definition: EvidenceReplayDefinition,
  role: EvidenceClaimRoleDeclaration,
): EvidenceClaimRoleDeclarationState => {
  definitionState(definition);
  const state = typeof role === "object" && role !== null
    ? claimRoleDeclarationStates.get(role)
    : undefined;
  const slotState = state === undefined
    ? undefined
    : observationSlotDeclarationStates.get(state.slot);
  if (state === undefined || slotState?.definition !== definition) {
    throw new TypeError("Evidence claim role declaration provenance is invalid.");
  }
  return state;
};

export const createEvidenceObservationTargetDeclaration = <
  const Roles extends Readonly<
    Record<string, string | ExactConclusionIdentityDeclaration>
  >,
>(
  definition: EvidenceReplayDefinition,
  input: EvidenceObservationTargetInput<Roles>,
): EvidenceObservationTargetDeclaration<{
  readonly [Key in keyof Roles]: EvidenceClaimRoleDeclaration;
}> => {
  const definitionValue = definitionState(definition);
  const fact = factIdentityDeclarationState(definition, input.fact);
  if (fact.scope === undefined &&
      definitionsWithScopedDeclarations.has(definition as object)) {
    throw new TypeError("Static evidence declarations are closed.");
  }
  const registry: EvidenceDeclarationRegistry = fact.scope === undefined
    ? definitionValue
    : declarationScopeState(definition, fact.scope);
  const slotId = replayPrimitives.fixedIdentifier.parse(input.slotId);
  const purpose = replayPrimitives.snakeCaseCode.parse(input.purpose);
  if (typeof input.roles !== "object" || input.roles === null ||
      Array.isArray(input.roles)) {
    throw new TypeError("Evidence claim-role declarations are invalid.");
  }
  const roleInput: Readonly<Record<string, string | ExactConclusionIdentityDeclaration>> =
    input.roles;
  const roleEntries = Object.keys(roleInput).map((key) => {
    const identity = roleInput[key];
    if (identity === undefined) {
      throw new TypeError("Evidence claim-role declaration key is invalid.");
    }
    return [key, identity] as const;
  });
  if (roleEntries.length === 0 ||
      (input.kind === "validated_input" && roleEntries.length !== 1)) {
    throw new TypeError("Evidence observation target claim roles are invalid.");
  }
  const roleIds = roleEntries.map(([, identity]) => {
    if (typeof identity === "string") {
      return replayPrimitives.fixedIdentifier.parse(identity);
    }
    const conclusion = exactConclusionIdentityDeclarationState(identity);
    if (conclusion.family !== undefined &&
        (fact.scope === undefined || conclusion.scope !== fact.scope)) {
      throw new TypeError("Dynamic conclusion role is outside its fact declaration scope.");
    }
    return readConclusionIdentity(definition, identity);
  });
  if (canonicalUnique(roleIds).length !== roleIds.length) {
    throw new TypeError("Duplicate evidence claim role identity.");
  }

  const projection: ObservationSlotProjection = input.kind === "validated_input"
    ? Object.freeze({
        slotId,
        factId: fact.identity,
        kind: "validated_input",
        purpose,
      })
    : Object.freeze({
        slotId,
        factId: fact.identity,
        kind: "source",
        purpose,
        sourceClass: replayEvidence.externalSourceClass.parse(input.sourceClass),
      });
  const validatedInputIdentity = input.kind === "validated_input"
    ? Object.freeze({
        owner: replayPrimitives.generalSingleLineText.parse(input.owner),
        sourceId: replayPrimitives.fixedIdentifier.parse(input.sourceId),
      })
    : undefined;
  const existingSlots = registry.slotsById.get(slotId) ?? [];
  if (existingSlots.some((existing) => {
    const existingState = observationSlotDeclarationState(definition, existing);
    return canonicalJsonStringify(existingState.projection as unknown as CanonicalJson) ===
        canonicalJsonStringify(projection as unknown as CanonicalJson) &&
      canonicalJsonStringify((existingState.validatedInputIdentity ?? null) as CanonicalJson) ===
        canonicalJsonStringify((validatedInputIdentity ?? null) as CanonicalJson);
  })) {
    throw new TypeError("Duplicate observation slot declaration.");
  }

  const slot = Object.freeze({}) as EvidenceObservationSlotDeclaration;
  const roles: Record<string, EvidenceClaimRoleDeclaration> = {};
  const rolesByIdentity = new Map<string, EvidenceClaimRoleDeclaration>();
  for (let index = 0; index < roleEntries.length; index += 1) {
    const key = roleEntries[index]?.[0];
    const identity = roleIds[index];
    if (key === undefined || identity === undefined || Object.hasOwn(roles, key)) {
      throw new TypeError("Evidence claim-role declaration key is invalid.");
    }
    const role = registerEvidenceClaimRoleDeclaration(slot, rolesByIdentity, identity);
    roles[key] = role;
  }
  const target = Object.freeze({
    slot,
    roles: Object.freeze(roles),
  }) as EvidenceObservationTargetDeclaration<{
    readonly [Key in keyof Roles]: EvidenceClaimRoleDeclaration;
  }>;
  observationSlotDeclarationStates.set(slot, Object.freeze({
    definition,
    projection,
    fact: input.fact,
    target,
    ...(fact.scope === undefined ? {} : { scope: fact.scope }),
    ...(validatedInputIdentity === undefined ? {} : { validatedInputIdentity }),
  }));
  observationTargetDeclarationStates.set(target, Object.freeze({
    definition,
    slot,
    roles: target.roles,
    rolesByIdentity,
  }));
  registry.slotsById.set(slotId, [...existingSlots, slot]);
  return target;
};

export const createEvidenceClaimRoleDeclaration = (
  definition: EvidenceReplayDefinition,
  target: EvidenceObservationTargetDeclaration,
  identityInput: string,
): EvidenceClaimRoleDeclaration => {
  const targetState = observationTargetDeclarationState(definition, target);
  const identity = replayPrimitives.fixedIdentifier.parse(identityInput);
  return registerEvidenceClaimRoleDeclaration(
    targetState.slot,
    targetState.rolesByIdentity,
    identity,
  );
};

const readConclusionIdentity = (
  definition: EvidenceReplayDefinition,
  declaration: ExactConclusionIdentityDeclaration,
): string => {
  const state = exactConclusionIdentityDeclarationState(declaration);
  if (conclusionDeclarationOwners.get(declaration as object) !== definition) {
    throw new TypeError("Conclusion identity declaration provenance is invalid.");
  }
  const matches = definitionState(definition).conclusionMatchers
    .filter((matcher) => matcher.matches(state.identity));
  if (matches.length !== 1) {
    throw new TypeError("Conclusion identity declaration is undeclared or ambiguous.");
  }
  return state.identity;
};

declare const evidenceReplayLayoutType: unique symbol;
export interface EvidenceReplayLayout {
  readonly [evidenceReplayLayoutType]: true;
}

interface BoundEvidenceObservationSlotDeclarationState {
  readonly definition: EvidenceReplayDefinition;
  readonly layout: EvidenceReplayLayout;
  readonly declaration: EvidenceObservationSlotDeclaration;
  readonly projection: ObservationSlotProjection;
  readonly ordinal: string;
  readonly validatedInputIdentity?: ValidatedInputEvidenceIdentity;
}

interface BoundEvidenceClaimRoleDeclarationState {
  readonly definition: EvidenceReplayDefinition;
  readonly layout: EvidenceReplayLayout;
  readonly slot: BoundEvidenceObservationSlotDeclaration;
  readonly declaration: EvidenceClaimRoleDeclaration;
  readonly identity: string;
}

interface PreparedObservationTarget {
  readonly declaration: EvidenceObservationTargetDeclaration;
  readonly bound: BoundEvidenceObservationTarget;
  readonly projection: ObservationSlotProjection;
  readonly ordinal: string;
  readonly validatedInputIdentity?: ValidatedInputEvidenceIdentity;
}

interface EvidenceReplayLayoutState {
  readonly definition: EvidenceReplayDefinition;
  readonly declarationScope?: EvidenceDeclarationScope;
  readonly targets: readonly PreparedObservationTarget[];
  readonly targetByDeclaration: ReadonlyMap<
    EvidenceObservationTargetDeclaration,
    BoundEvidenceObservationTarget
  >;
  readonly targetBySlotDeclaration: ReadonlyMap<
    EvidenceObservationSlotDeclaration,
    PreparedObservationTarget
  >;
  readonly roleByDeclaration: Map<
    EvidenceClaimRoleDeclaration,
    BoundEvidenceClaimRoleDeclaration
  >;
}

const layoutStates = new WeakMap<object, EvidenceReplayLayoutState>();
const boundObservationSlotDeclarationStates =
  new WeakMap<object, BoundEvidenceObservationSlotDeclarationState>();
const boundClaimRoleDeclarationStates =
  new WeakMap<object, BoundEvidenceClaimRoleDeclarationState>();

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

const readLayoutConclusionIdentity = (
  definition: EvidenceReplayDefinition,
  layout: EvidenceReplayLayout,
  declaration: ExactConclusionIdentityDeclaration,
): string => {
  const identity = readConclusionIdentity(definition, declaration);
  const conclusion = exactConclusionIdentityDeclarationState(declaration);
  if (conclusion.family !== undefined &&
      conclusion.scope !== layoutState(definition, layout).declarationScope) {
    throw new TypeError("Dynamic conclusion identity is outside the replay layout scope.");
  }
  return identity;
};

const requiredConclusionDeclarations = (
  definition: EvidenceReplayDefinition,
  layout: EvidenceReplayLayout,
  conclusionSet: EvidenceConclusionSetDeclaration | undefined,
): readonly ExactConclusionIdentityDeclaration[] => {
  const definitionValue = definitionState(definition);
  let selected: readonly ExactConclusionIdentityDeclaration[] = [];
  if (definitionValue.conclusionSets.length === 0) {
    if (conclusionSet !== undefined) {
      throw new TypeError("Evidence conclusion set is not declared.");
    }
  } else {
    const owner = typeof conclusionSet === "object" && conclusionSet !== null
      ? evidenceConclusionSetDeclarationOwners.get(conclusionSet)
      : undefined;
    const state = typeof conclusionSet === "object" && conclusionSet !== null
      ? evidenceConclusionSetDeclarationStates.get(conclusionSet)
      : undefined;
    if (conclusionSet === undefined || owner !== definition || state === undefined ||
        !definitionValue.conclusionSets.includes(conclusionSet)) {
      throw new TypeError("Evidence conclusion set selection is invalid.");
    }
    selected = state.conclusions;
  }
  const scope = layoutState(definition, layout).declarationScope;
  const dynamic = scope === undefined
    ? []
    : [...declarationScopeState(definition, scope).conclusionsById.values()];
  const declarations = parseBoundedArray(
    [...definitionValue.fixedConclusions, ...selected, ...dynamic],
    1,
    evidenceConclusionCountLimit,
    "Required conclusion declarations are invalid.",
  );
  return Object.freeze([...declarations].sort((left, right) =>
    compareCodePointSequences(
      readLayoutConclusionIdentity(definition, layout, left),
      readLayoutConclusionIdentity(definition, layout, right),
    )));
};

const boundObservationSlotDeclarationState = (
  definition: EvidenceReplayDefinition,
  layout: EvidenceReplayLayout,
  slot: BoundEvidenceObservationSlotDeclaration,
): BoundEvidenceObservationSlotDeclarationState => {
  layoutState(definition, layout);
  const state = typeof slot === "object" && slot !== null
    ? boundObservationSlotDeclarationStates.get(slot)
    : undefined;
  if (state === undefined || state.definition !== definition || state.layout !== layout) {
    throw new TypeError("Bound evidence observation slot provenance is invalid.");
  }
  return state;
};

const boundClaimRoleDeclarationState = (
  definition: EvidenceReplayDefinition,
  layout: EvidenceReplayLayout,
  role: BoundEvidenceClaimRoleDeclaration,
): BoundEvidenceClaimRoleDeclarationState => {
  layoutState(definition, layout);
  const state = typeof role === "object" && role !== null
    ? boundClaimRoleDeclarationStates.get(role)
    : undefined;
  if (state === undefined || state.definition !== definition || state.layout !== layout) {
    throw new TypeError("Bound evidence claim role provenance is invalid.");
  }
  return state;
};

export const createEvidenceReplayLayout = (
  definition: EvidenceReplayDefinition,
  targetsInput: readonly EvidenceObservationTargetDeclaration[],
): EvidenceReplayLayout => {
  definitionState(definition);
  const targets = parseBoundedArray(
    targetsInput,
    1,
    evidenceObservationCountLimit,
    "Evidence replay layout targets are invalid.",
  ).map((target) => observationTargetDeclarationState(definition, target));
  const declarationScopes = new Set(
    targets.flatMap((target) => {
      const scope = observationSlotDeclarationState(definition, target.slot).scope;
      return scope === undefined ? [] : [scope];
    }),
  );
  if (declarationScopes.size > 1) {
    throw new TypeError("Evidence replay layout mixes declaration scopes.");
  }
  const declarationScope = declarationScopes.values().next().value as
    EvidenceDeclarationScope | undefined;
  if (new Set(targetsInput).size !== targetsInput.length ||
      canonicalUnique(targets.map((target) =>
        observationSlotDeclarationState(definition, target.slot).projection.slotId)).length !==
        targets.length) {
    throw new TypeError("Duplicate observation slot identity.");
  }

  const layout = Object.freeze({}) as EvidenceReplayLayout;
  const targetByDeclaration = new Map<
    EvidenceObservationTargetDeclaration,
    BoundEvidenceObservationTarget
  >();
  const targetBySlotDeclaration = new Map<
    EvidenceObservationSlotDeclaration,
    PreparedObservationTarget
  >();
  const roleByDeclaration = new Map<
    EvidenceClaimRoleDeclaration,
    BoundEvidenceClaimRoleDeclaration
  >();
  const prepared = Object.freeze(targets.map((target, index): PreparedObservationTarget => {
    const slotState = observationSlotDeclarationState(definition, target.slot);
    const boundSlot = Object.freeze({}) as BoundEvidenceObservationSlotDeclaration;
    boundObservationSlotDeclarationStates.set(boundSlot, Object.freeze({
      definition,
      layout,
      declaration: target.slot,
      projection: slotState.projection,
      ordinal: String(index),
      ...(slotState.validatedInputIdentity === undefined
        ? {}
        : { validatedInputIdentity: slotState.validatedInputIdentity }),
    }));
    const boundRoles: Record<string, BoundEvidenceClaimRoleDeclaration> = {};
    for (const key of Object.keys(target.roles)) {
      const role = target.roles[key];
      if (role === undefined) {
        throw new TypeError("Evidence claim role declaration key is invalid.");
      }
      const roleState = claimRoleDeclarationState(definition, role);
      if (roleState.slot !== target.slot) {
        throw new TypeError("Evidence claim role does not belong to its observation slot.");
      }
      const boundRole = Object.freeze({}) as BoundEvidenceClaimRoleDeclaration;
      boundClaimRoleDeclarationStates.set(boundRole, Object.freeze({
        definition,
        layout,
        slot: boundSlot,
        declaration: role,
        identity: roleState.identity,
      }));
      roleByDeclaration.set(role, boundRole);
      boundRoles[key] = boundRole;
    }
    const bound = Object.freeze({
      slot: boundSlot,
      roles: Object.freeze(boundRoles),
    }) as BoundEvidenceObservationTarget;
    const result = Object.freeze({
      declaration: targetsInput[index] as EvidenceObservationTargetDeclaration,
      bound,
      projection: slotState.projection,
      ordinal: String(index),
      ...(slotState.validatedInputIdentity === undefined
        ? {}
        : { validatedInputIdentity: slotState.validatedInputIdentity }),
    });
    targetByDeclaration.set(result.declaration, bound);
    targetBySlotDeclaration.set(target.slot, result);
    return result;
  }));
  layoutStates.set(layout, Object.freeze({
    definition,
    ...(declarationScope === undefined ? {} : { declarationScope }),
    targets: prepared,
    targetByDeclaration,
    targetBySlotDeclaration,
    roleByDeclaration,
  }));
  return layout;
};

export const readEvidenceReplaySlots = (
  definition: EvidenceReplayDefinition,
  layout: EvidenceReplayLayout,
): readonly ObservationSlotProjection[] =>
  Object.freeze(layoutState(definition, layout).targets.map((target) => target.projection));

export const readEvidenceReplayBoundTargets = (
  definition: EvidenceReplayDefinition,
  layout: EvidenceReplayLayout,
): readonly BoundEvidenceObservationTarget[] =>
  Object.freeze(layoutState(definition, layout).targets.map((target) => target.bound));

export const readBoundEvidenceObservationSlot = (
  definition: EvidenceReplayDefinition,
  layout: EvidenceReplayLayout,
  slot: BoundEvidenceObservationSlotDeclaration,
): Readonly<{
  readonly purpose: string;
  readonly sourceClass: SourceClass;
  readonly validatedInputIdentity?: ValidatedInputEvidenceIdentity;
}> => {
  const state = boundObservationSlotDeclarationState(definition, layout, slot);
  return Object.freeze({
    purpose: state.projection.purpose,
    sourceClass: state.projection.kind === "validated_input"
      ? "validated_input"
      : state.projection.sourceClass,
    ...(state.validatedInputIdentity === undefined
      ? {}
      : { validatedInputIdentity: state.validatedInputIdentity }),
  });
};

export const bindEvidenceObservationTarget = <
  Target extends EvidenceObservationTargetDeclaration,
>(
  definition: EvidenceReplayDefinition,
  layout: EvidenceReplayLayout,
  target: Target,
): BoundEvidenceObservationTarget<Target> => {
  observationTargetDeclarationState(definition, target);
  const bound = layoutState(definition, layout).targetByDeclaration.get(target);
  if (bound === undefined) {
    throw new TypeError("Evidence observation target is not part of this layout.");
  }
  return bound as BoundEvidenceObservationTarget<Target>;
};

export const bindEvidenceClaimRole = (
  definition: EvidenceReplayDefinition,
  layout: EvidenceReplayLayout,
  role: EvidenceClaimRoleDeclaration,
): BoundEvidenceClaimRoleDeclaration => {
  const roleState = claimRoleDeclarationState(definition, role);
  const state = layoutState(definition, layout);
  const existing = state.roleByDeclaration.get(role);
  if (existing !== undefined) return existing;
  const preparedTarget = state.targetBySlotDeclaration.get(roleState.slot);
  if (preparedTarget === undefined) {
    throw new TypeError("Evidence claim role observation target is not part of this layout.");
  }
  const boundRole = Object.freeze({}) as BoundEvidenceClaimRoleDeclaration;
  boundClaimRoleDeclarationStates.set(boundRole, Object.freeze({
    definition,
    layout,
    slot: preparedTarget.bound.slot,
    declaration: role,
    identity: roleState.identity,
  }));
  state.roleByDeclaration.set(role, boundRole);
  return boundRole;
};

export const createEvidenceReplayBinder = (
  definition: EvidenceReplayDefinition,
  layout: EvidenceReplayLayout,
): EvidenceReplayBinder => Object.freeze({
  bind<Target extends EvidenceObservationTargetDeclaration>(
    target: Target,
  ): BoundEvidenceObservationTarget<Target> {
    return bindEvidenceObservationTarget(definition, layout, target);
  },
  bindRole(role: EvidenceClaimRoleDeclaration): BoundEvidenceClaimRoleDeclaration {
    return bindEvidenceClaimRole(definition, layout, role);
  },
});

export const createEvidenceObservationId = (
  definition: EvidenceReplayDefinition,
  layout: EvidenceReplayLayout,
  input: {
    readonly slot: BoundEvidenceObservationSlotDeclaration;
    readonly sourceId: string;
    readonly observedAt: UtcTimestamp;
    readonly chainAnchor?: ChainAnchor;
    readonly invocationId: InvocationId;
  },
): ObservationId => {
  const slot = boundObservationSlotDeclarationState(definition, layout, input.slot);
  const sourceId = replayPrimitives.fixedIdentifier.parse(input.sourceId);
  const observedAt = replayPrimitives.utcTimestamp.parse(input.observedAt);
  const chainAnchor = input.chainAnchor === undefined
    ? undefined
    : replayPrimitives.chainAnchor.parse(input.chainAnchor);
  const invocationId = replayEvidence.invocationId.parse(input.invocationId);
  const anchor = chainAnchor === undefined ? null : chainAnchor as unknown as CanonicalJson;
  const digest = canonicalSha256Base64Url([
    sourceId,
    slot.projection.purpose,
    observedAt,
    anchor,
    invocationId,
    slot.ordinal,
  ]);
  return replayEvidence.observationId.parse(`obs:${digest}`);
};

const claimProjection = (
  definition: EvidenceReplayDefinition,
  layout: EvidenceReplayLayout,
  slot: BoundEvidenceObservationSlotDeclaration,
  claim: ObservationClaim,
): Readonly<{
  readonly role: string;
  readonly value: CanonicalJson;
  readonly chainAnchor?: ChainAnchor;
  readonly asset?: AssetIdentity;
}> => {
  boundObservationSlotDeclarationState(definition, layout, slot);
  const role = boundClaimRoleDeclarationState(definition, layout, claim.role);
  if (role.slot !== slot) {
    throw new TypeError("Evidence claim role does not belong to its bound observation slot.");
  }
  let value: CanonicalJson;
  try {
    value = captureCanonicalJson(claim.value);
  } catch {
    throw new TypeError("Evidence observation claim is invalid.");
  }
  const parsed = observationClaimValueSchema.parse({
    value,
    ...(claim.chainAnchor === undefined ? {} : { chainAnchor: claim.chainAnchor }),
    ...(claim.asset === undefined ? {} : { asset: claim.asset }),
  });
  return deepFreezeValue({
    role: role.identity,
    value: parsed.value,
    ...(parsed.chainAnchor === undefined ? {} : { chainAnchor: parsed.chainAnchor }),
    ...(parsed.asset === undefined ? {} : { asset: parsed.asset }),
  });
};

export const captureEvidenceObservationClaims = (
  definition: EvidenceReplayDefinition,
  layout: EvidenceReplayLayout,
  slot: BoundEvidenceObservationSlotDeclaration,
  claimsInput: readonly ObservationClaim[],
): readonly ObservationClaim[] => {
  const claims = parseBoundedArray(
    claimsInput,
    1,
    canonicalJsonArrayLengthLimit,
    "An observation requires bounded claims.",
  ).map((claim) => {
    const projection = claimProjection(definition, layout, slot, claim);
    return Object.freeze({
      role: claim.role,
      value: projection.value,
      ...(projection.chainAnchor === undefined
        ? {}
        : { chainAnchor: projection.chainAnchor }),
      ...(projection.asset === undefined ? {} : { asset: projection.asset }),
    }) as ObservationClaim;
  }).sort((left, right) => {
    const leftRole = boundClaimRoleDeclarationState(definition, layout, left.role).identity;
    const rightRole = boundClaimRoleDeclarationState(definition, layout, right.role).identity;
    return compareCodePointSequences(leftRole, rightRole);
  });
  const roleIds = claims.map((claim) =>
    boundClaimRoleDeclarationState(definition, layout, claim.role).identity);
  if (canonicalUnique(roleIds).length !== roleIds.length) {
    throw new TypeError("Evidence observation claim roles are duplicated.");
  }
  return Object.freeze(claims);
};

const projectEvidenceObservationClaims = (
  definition: EvidenceReplayDefinition,
  layout: EvidenceReplayLayout,
  slot: BoundEvidenceObservationSlotDeclaration,
  claims: readonly ObservationClaim[],
): readonly Readonly<{
  readonly role: string;
  readonly value: CanonicalJson;
  readonly chainAnchor?: ChainAnchor;
  readonly asset?: AssetIdentity;
}>[] => Object.freeze(captureEvidenceObservationClaims(
    definition,
    layout,
    slot,
    claims,
  ).map((claim) => claimProjection(definition, layout, slot, claim)));

const canonicalClaimArray = (
  definition: EvidenceReplayDefinition,
  layout: EvidenceReplayLayout,
  slot: BoundEvidenceObservationSlotDeclaration,
  claims: readonly ObservationClaim[],
): string => canonicalJsonStringify(
  captureCanonicalJson(projectEvidenceObservationClaims(definition, layout, slot, claims)),
);

export const createEvidenceSourceRecordDigest = (
  definition: EvidenceReplayDefinition,
  layout: EvidenceReplayLayout,
  slot: BoundEvidenceObservationSlotDeclaration,
  sourceRecordInput: EvidenceSourceRecord,
  claims: readonly ObservationClaim[],
): EvidenceSource["recordDigest"] => {
  const source = deepFreezeValue(
    replayEvidence.evidenceSourceRecord.parse(sourceRecordInput),
  );
  return replayEvidence.digest.parse(canonicalSha256Base64Url(
    captureCanonicalJson({
      claims: projectEvidenceObservationClaims(definition, layout, slot, claims),
      digestKind: "evidence_source_record",
      source,
    }),
  ));
};

export const evidenceObservationClaimsEqual = (
  definition: EvidenceReplayDefinition,
  layout: EvidenceReplayLayout,
  slot: BoundEvidenceObservationSlotDeclaration,
  left: readonly ObservationClaim[],
  right: readonly ObservationClaim[],
): boolean =>
  canonicalClaimArray(definition, layout, slot, left) ===
  canonicalClaimArray(definition, layout, slot, right);

const canonicalOptionalAnchor = (anchor: ChainAnchor | undefined): string =>
  canonicalJsonStringify((anchor ?? null) as unknown as CanonicalJson);

interface ObservedFact {
  readonly outcome: FactOutcome;
  readonly observationIds: readonly ObservationId[];
}

interface EvidenceObservationProjection {
  get(slot: BoundEvidenceObservationSlotDeclaration): ObservationId | undefined;
  hasSlot(slot: BoundEvidenceObservationSlotDeclaration): boolean;
  evidenceFor(observationId: string): EvidenceSource | undefined;
}

class ParsedEvidenceObservations implements EvidenceObservationProjection {
  readonly #bySlot = new Map<BoundEvidenceObservationSlotDeclaration, EvidenceSource>();
  readonly #byObservationId = new Map<string, EvidenceSource>();

  constructor(
    definition: EvidenceReplayDefinition,
    layout: EvidenceReplayLayout,
    sources: readonly EvidenceSource[],
    evaluatedAt: UtcTimestamp,
  ) {
    const targets = layoutState(definition, layout).targets;
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
      const authorityIdentity = invocationSourceIdentity(
        source.sourceClass,
        source.owner,
        source.reference,
        sourceReferenceIdentity(source.reference),
      );
      const currentAuthority = authorityByClass.get(source.sourceClass);
      if (currentAuthority !== undefined && currentAuthority !== authorityIdentity) {
        throw new TypeError("One invocation uses conflicting source identities.");
      }
      authorityByClass.set(source.sourceClass, authorityIdentity);
      const candidates = targets.filter((target) =>
        (target.projection.kind === "validated_input"
          ? "validated_input"
          : target.projection.sourceClass) === source.sourceClass &&
        target.projection.purpose === source.purpose &&
        createEvidenceObservationId(definition, layout, {
          slot: target.bound.slot,
          sourceId: source.reference.sourceId,
          observedAt: source.observedAt,
          ...(source.chainAnchor === undefined ? {} : { chainAnchor: source.chainAnchor }),
          invocationId: source.invocationId,
        }) === source.observationId);
      if (candidates.length !== 1) {
        throw new TypeError("Evidence source does not match one declared observation slot.");
      }
      const target = candidates[0] as PreparedObservationTarget;
      if (this.#bySlot.has(target.bound.slot)) throw new TypeError("Observation slot is duplicated.");
      if (target.projection.kind === "validated_input") {
        const expected = target.validatedInputIdentity;
        if (expected === undefined ||
            source.owner !== expected.owner ||
            source.reference.kind !== "validated_input" ||
            source.reference.sourceId !== expected.sourceId) {
          throw new TypeError("Validated-input evidence identity is invalid.");
        }
      }
      this.#bySlot.set(target.bound.slot, source);
      this.#byObservationId.set(source.observationId, source);
    }
  }

  get(slot: BoundEvidenceObservationSlotDeclaration): ObservationId | undefined {
    return this.#bySlot.get(slot)?.observationId;
  }

  hasSlot(slot: BoundEvidenceObservationSlotDeclaration): boolean {
    return this.#bySlot.has(slot);
  }

  evidenceFor(observationId: string): EvidenceSource | undefined {
    return this.#byObservationId.get(observationId);
  }
}

const validateDefinitionStructure = (
  definition: EvidenceReplayDefinition,
  layout: EvidenceReplayLayout,
  requirementsInput: readonly FactRequirement[],
): Readonly<{
  readonly requirements: readonly FactRequirement[];
  readonly ownedSlots: ReadonlySet<BoundEvidenceObservationSlotDeclaration>;
}> => {
  const requirements = parseBoundedArray(
    requirementsInput,
    1,
    evidenceReplayFactRequirementCountLimit,
    "Evidence fact requirements are invalid.",
  );
  if (new Set(requirements.map((requirement) => requirement.fact)).size !== requirements.length) {
    throw new TypeError("Duplicate definition identity.");
  }
  const ownedSlots = new Set<BoundEvidenceObservationSlotDeclaration>();
  for (const requirement of requirements) {
    factIdentityDeclarationState(definition, requirement.fact);
    const slots = parseBoundedArray(
      requirement.observationSlots,
      0,
      evidenceObservationCountLimit,
      "Fact observation slots are invalid.",
    );
    const requiredSlots = parseBoundedArray(
      requirement.requiredObservationSlots,
      0,
      evidenceObservationCountLimit,
      "Required fact observation slots are invalid.",
    );
    if (new Set(slots).size !== slots.length || new Set(requiredSlots).size !== requiredSlots.length) {
      throw new TypeError("Duplicate fact observation slot.");
    }
    if (!Number.isSafeInteger(requirement.minimumObservationCount) ||
        requirement.minimumObservationCount < requiredSlots.length ||
        requirement.minimumObservationCount > slots.length) {
      throw new TypeError("Fact observation cardinality is invalid.");
    }
    const outcome = replayEvidence.factOutcome.parse(requirement.outcome);
    const evidenceAuthority = factOutcomeDefinitions[outcome].evidenceAuthority;
    if (slots.length === 0 && evidenceAuthority !== "none") {
      throw new TypeError("Evidence-bearing fact requires an observation slot.");
    }
    const authorityKind = evidenceAuthority === "validated_input"
      ? "validated_input"
      : "source";
    for (const slot of slots) {
      const slotState = boundObservationSlotDeclarationState(definition, layout, slot);
      if (observationSlotDeclarationState(definition, slotState.declaration).fact !== requirement.fact) {
        throw new TypeError("Fact requirement does not own its observation slot.");
      }
      if (slotState.projection.kind !== authorityKind) {
        throw new TypeError("Fact requirement mixes observation authorities.");
      }
      ownedSlots.add(slot);
    }
    for (const slot of requiredSlots) {
      boundObservationSlotDeclarationState(definition, layout, slot);
      if (!slots.includes(slot)) throw new TypeError("Required observation slot is not allowed by its fact.");
    }
  }
  return Object.freeze({
    requirements: Object.freeze([...requirements]),
    ownedSlots,
  });
};

const prepareObservationExpectations = (
  definition: EvidenceReplayDefinition,
  layout: EvidenceReplayLayout,
  expectationsInput: readonly ObservationExpectation[],
): ReadonlyMap<
  BoundEvidenceObservationSlotDeclaration,
  readonly ObservationClaim[]
> => {
  const expectations = parseBoundedArray(
    expectationsInput,
    0,
    evidenceObservationCountLimit,
    "Observation expectations are invalid.",
  );
  const result = new Map<
    BoundEvidenceObservationSlotDeclaration,
    readonly ObservationClaim[]
  >();
  for (const expectation of expectations) {
    boundObservationSlotDeclarationState(definition, layout, expectation.slot);
    if (result.has(expectation.slot)) {
      throw new TypeError("Observation expectation identity is invalid.");
    }
    result.set(
      expectation.slot,
      captureEvidenceObservationClaims(
        definition,
        layout,
        expectation.slot,
        expectation.claims,
      ),
    );
  }
  return result;
};

const assertExpectedSourceAnchors = (
  observations: EvidenceObservationProjection,
  expectations: ReadonlyMap<
    BoundEvidenceObservationSlotDeclaration,
    readonly ObservationClaim[]
  >,
): void => {
  for (const [slot, claims] of expectations) {
    const observationId = observations.get(slot);
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

const assertExpectedSourceRecordDigests = (
  definition: EvidenceReplayDefinition,
  layout: EvidenceReplayLayout,
  observations: EvidenceObservationProjection,
  expectations: ReadonlyMap<
    BoundEvidenceObservationSlotDeclaration,
    readonly ObservationClaim[]
  >,
): void => {
  for (const [slot, claims] of expectations) {
    const observationId = observations.get(slot);
    if (observationId === undefined) continue;
    const source = observations.evidenceFor(observationId);
    if (source === undefined) throw new TypeError("Observation source is unavailable.");
    const { recordDigest: _recordDigest, ...sourceRecord } = source;
    const expectedDigest = createEvidenceSourceRecordDigest(
      definition,
      layout,
      slot,
      sourceRecord,
      claims,
    );
    if (source.recordDigest !== expectedDigest) {
      throw new TypeError("Observation source record does not match its digest.");
    }
  }
};

const assertPublicEvidenceClosure = (
  definition: EvidenceReplayDefinition,
  layout: EvidenceReplayLayout,
  expectations: ReadonlyMap<
    BoundEvidenceObservationSlotDeclaration,
    readonly ObservationClaim[]
  >,
  referencesInput: readonly ObservationReference[],
  observations: EvidenceObservationProjection,
): void => {
  for (const target of layoutState(definition, layout).targets) {
    if (observations.hasSlot(target.bound.slot) && !expectations.has(target.bound.slot)) {
      throw new TypeError("Observed slot has no definition-owned expectation.");
    }
  }
  const references = parseBoundedArray(
    referencesInput,
    0,
    evidenceReplayReferenceCountLimit,
    "Public observation references are invalid.",
  );
  const identities = new Set<string>();
  for (const reference of references) {
    const observationId = replayEvidence.observationId.parse(reference.observationId);
    boundObservationSlotDeclarationState(definition, layout, reference.slot);
    const role = boundClaimRoleDeclarationState(definition, layout, reference.role);
    if (role.slot !== reference.slot) {
      throw new TypeError("Public observation reference role is not owned by its declared slot.");
    }
    const slotState = boundObservationSlotDeclarationState(
      definition,
      layout,
      reference.slot,
    );
    const identity = canonicalJsonStringify({
      observationId,
      slotId: slotState.projection.slotId,
      role: role.identity,
    } as unknown as CanonicalJson);
    if (identities.has(identity)) throw new TypeError("Public observation reference is duplicated.");
    identities.add(identity);
    if (observations.get(reference.slot) !== observationId) {
      throw new TypeError("Public observation reference does not match its declared slot.");
    }
    const claims = expectations.get(reference.slot);
    if (claims === undefined || !claims.some((claim) => claim.role === reference.role)) {
      throw new TypeError("Public observation reference role is not owned by its declared slot.");
    }
  }
  assertExpectedSourceAnchors(observations, expectations);
  assertExpectedSourceRecordDigests(
    definition,
    layout,
    observations,
    expectations,
  );
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
  layoutState(input.definition, input.layout);
  const evaluatedAt = replayPrimitives.utcTimestamp.parse(input.evaluatedAt);
  const sources = Object.freeze(input.sources.map((source) =>
    deepFreezeValue(replayEvidence.evidenceSource.parse(source)))) as readonly EvidenceSource[];
  const structure = validateDefinitionStructure(
    input.definition,
    input.layout,
    input.factRequirements,
  );
  const requirements = structure.requirements;
  const expectations = prepareObservationExpectations(
    input.definition,
    input.layout,
    input.observationExpectations,
  );
  for (const slot of expectations.keys()) {
    if (!structure.ownedSlots.has(slot)) {
      throw new TypeError("Observation expectation has no owning fact requirement.");
    }
  }
  const observations = new ParsedEvidenceObservations(
    input.definition,
    input.layout,
    sources,
    evaluatedAt,
  );
  assertPublicEvidenceClosure(
    input.definition,
    input.layout,
    expectations,
    input.observationReferences,
    observations,
  );

  const facts = new Map<EvidenceFactIdentityDeclaration, ObservedFact>();
  for (const requirement of requirements) {
    const observationIds = canonicalUnique(requirement.observationSlots.flatMap((slot) => {
      const observationId = observations.get(slot);
      return observationId === undefined ? [] : [observationId];
    })) as readonly ObservationId[];
    for (const slot of requirement.requiredObservationSlots) {
      if (!observations.hasSlot(slot)) throw new TypeError("Required fact evidence is incomplete.");
    }
    if (observationIds.length < requirement.minimumObservationCount) {
      throw new TypeError("Fact evidence cardinality is incomplete.");
    }
    const observedSlots = requirement.observationSlots
      .filter((slot) => observations.hasSlot(slot));
    const authority = factOutcomeDefinitions[requirement.outcome].evidenceAuthority;
    if (authority === "none" && observedSlots.length !== 0) {
      throw new TypeError("Fact outcome must not claim evidence.");
    }
    if (authority === "external" && (
      observedSlots.length === 0 || observedSlots.some((slot) =>
        boundObservationSlotDeclarationState(
          input.definition,
          input.layout,
          slot,
        ).projection.kind !== "source")
    )) {
      throw new TypeError("External fact evidence authority is invalid.");
    }
    if (authority === "validated_input" && (
      observedSlots.length === 0 || observedSlots.some((slot) =>
        boundObservationSlotDeclarationState(
          input.definition,
          input.layout,
          slot,
        ).projection.kind !== "validated_input")
    )) {
      throw new TypeError("Validated-input fact evidence authority is invalid.");
    }
    facts.set(requirement.fact, Object.freeze({
      outcome: requirement.outcome,
      observationIds,
    }));
  }

  const requiredDeclarations = requiredConclusionDeclarations(
    input.definition,
    input.layout,
    input.conclusionSet,
  );
  if (new Set(requiredDeclarations).size !== requiredDeclarations.length) {
    throw new TypeError("Required conclusion identities are duplicated.");
  }
  const requiredConclusionIds = canonicalUnique(requiredDeclarations.map((declaration) =>
    readConclusionIdentity(input.definition, declaration)));
  if (requiredConclusionIds.length !== requiredDeclarations.length) {
    throw new TypeError("Required conclusion identities are duplicated.");
  }

  const drafts = parseBoundedArray(
    input.conclusionDrafts,
    1,
    evidenceConclusionCountLimit,
    "Conclusion drafts are invalid.",
  );
  const conclusions = drafts.map((draft): Conclusion => {
    const id = readLayoutConclusionIdentity(input.definition, input.layout, draft.conclusion);
    factIdentityDeclarationState(input.definition, draft.outcomeFact);
    const evidenceFacts = parseBoundedArray(
      draft.evidenceFacts,
      1,
      evidenceReplayFactRequirementCountLimit,
      "Conclusion evidence facts are invalid.",
    );
    if (new Set(evidenceFacts).size !== evidenceFacts.length) {
      throw new TypeError("Conclusion fact evidence is duplicated.");
    }
    const observationIds = canonicalUnique(evidenceFacts.flatMap((factDeclaration) => {
      factIdentityDeclarationState(input.definition, factDeclaration);
      const fact = facts.get(factDeclaration);
      if (fact === undefined) throw new TypeError("Conclusion fact is unavailable.");
      return fact.observationIds;
    })) as readonly ObservationId[];
    const supportingSources = observationIds.map((observationId) => {
      const source = observations.evidenceFor(observationId);
      if (source === undefined) throw new TypeError("Conclusion evidence is unavailable.");
      return source;
    });
    const freshnessRuleId = replayEvidence.freshnessRuleId.parse(draft.freshnessRuleId);
    assertConclusionFreshness({ ...draft, freshnessRuleId }, supportingSources);
    const outcomeFact = facts.get(draft.outcomeFact);
    if (outcomeFact === undefined) throw new TypeError("Conclusion outcome fact is unavailable.");
    if (outcomeFact.observationIds.length > 0 && !evidenceFacts.includes(draft.outcomeFact)) {
      throw new TypeError("Conclusion evidence does not contain its outcome fact.");
    }
    const outcome = conclusionOutcome(outcomeFact.outcome);
    return deepFreezeValue({
      id,
      status: outcome.status,
      reason: outcome.reason,
      observationIds,
      freshness: {
        status: freshnessRuleDefinitions[freshnessRuleId].status,
        ruleId: freshnessRuleId,
        evaluatedAt,
        observationIds,
      },
    }) as Conclusion;
  }).sort((left, right) => compareCodePointSequences(left.id, right.id));
  if (!isStrictlyOrderedUnique(conclusions.map((conclusion) => conclusion.id))) {
    throw new TypeError("Conclusion identities are not unique and ordered.");
  }
  if (conclusions.map((conclusion) => conclusion.id).join("\0") !==
      requiredConclusionIds.join("\0")) {
    throw new TypeError("Capability conclusions are incomplete or undeclared.");
  }

  const warningRequirements = parseBoundedArray(
    input.warningRequirements,
    0,
    evidenceWarningCountLimit,
    "Warning requirements are invalid.",
  );
  const warningInputs = warningRequirements.map((candidate) => {
    const code = replayEvidence.warningCode.parse(candidate.code);
    if (!definition.warningCodes.includes(code)) throw new TypeError("Warning is not declared.");
    const factDeclarations = parseBoundedArray(
      candidate.facts,
      1,
      evidenceReplayFactRequirementCountLimit,
      "Warning fact evidence is invalid.",
    );
    if (new Set(factDeclarations).size !== factDeclarations.length) {
      throw new TypeError("Warning fact evidence is duplicated.");
    }
    const observationIds = canonicalUnique(factDeclarations.flatMap((factDeclaration) => {
      factIdentityDeclarationState(input.definition, factDeclaration);
      const fact = facts.get(factDeclaration);
      if (fact === undefined) throw new TypeError("Warning fact is invalid.");
      return fact.observationIds;
    })) as readonly ObservationId[];
    if (observationIds.length === 0) throw new TypeError("Warning evidence is invalid.");
    return { code, observationIds };
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
