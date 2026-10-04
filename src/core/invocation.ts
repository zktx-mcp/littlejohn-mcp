import {
  parseExternalSourceClass,
  parseSourceReference,
  sourceClassDefinitions,
  sourceClassAcceptsReference,
  sourceReferenceKinds,
  sourceReferenceIdentity,
  invocationSourceGroupIdentity,
  type ExternalSourceClass,
  type SourceReference,
} from "./evidence.js";
import {parseChainId, type ChainId} from "./primitives.js";
import {
  createPrimitiveSchemaSet,
  parseUtcTimestamp,
  type UtcTimestamp,
} from "./primitives.js";

const authorityPrimitiveSchemas = createPrimitiveSchemaSet();

export interface CanonicalClock {
  now(): UtcTimestamp;
}

const clockStates = new WeakMap<object, {
  readonly read: () => unknown;
  last?: UtcTimestamp;
}>();

const assertCanonicalClock = (clock: CanonicalClock): void => {
  if (typeof clock !== "object" || clock === null || !clockStates.has(clock)) {
    throw new TypeError("Canonical clock provenance is invalid.");
  }
};

export const createCanonicalClock = (read: () => unknown): CanonicalClock => {
  if (typeof read !== "function") throw new TypeError("Canonical clock reader is invalid.");
  const clock = Object.freeze({
    now(): UtcTimestamp {
      const state = clockStates.get(clock);
      if (state === undefined) throw new TypeError("Canonical clock provenance is invalid.");
      const value = parseUtcTimestamp(state.read());
      if (state.last !== undefined && value < state.last) {
        throw new TypeError("Canonical clock moved backwards.");
      }
      state.last = value;
      return value;
    },
  });
  clockStates.set(clock, { read });
  return clock;
};

export const readCanonicalClock = (clock: CanonicalClock): UtcTimestamp => {
  assertCanonicalClock(clock);
  return clock.now();
};

export interface ObservationAuthority {
  readonly __observationAuthority: unique symbol;
}

interface ObservationAuthorityState {
  readonly clock: CanonicalClock;
  readonly sourceClass: ExternalSourceClass;
  readonly owner: string;
  readonly reference: SourceReference;
  readonly registration?: ObservationAuthorityRegistration;
}

const authorityStates = new WeakMap<object, ObservationAuthorityState>();

const assertReferenceClass = (sourceClass: ExternalSourceClass, reference: SourceReference): void => {
  if (!sourceClassAcceptsReference(sourceClass, reference.kind)) {
    throw new TypeError("Observation source class and reference are inconsistent.");
  }
};

export const createObservationAuthority = (input: {
  readonly clock: CanonicalClock;
  readonly sourceClass: ExternalSourceClass;
  readonly owner: string;
  readonly reference: SourceReference;
}): ObservationAuthority => {
  assertCanonicalClock(input.clock);
  const sourceClass = parseExternalSourceClass(input.sourceClass);
  const owner = authorityPrimitiveSchemas.generalSingleLineText.parse(input.owner);
  const reference = Object.freeze(parseSourceReference(input.reference));
  assertReferenceClass(sourceClass, reference);
  const authority = Object.freeze({}) as ObservationAuthority;
  authorityStates.set(authority, Object.freeze({ clock: input.clock, sourceClass, owner, reference }));
  return authority;
};

export interface ObservationAuthorityRegistration {
  readonly __observationAuthorityRegistration: unique symbol;
}

interface ObservationAuthorityRegistrationState {
  readonly clock: CanonicalClock;
  readonly sourceClass: ExternalSourceClass;
  readonly owner: string;
  readonly referenceKind: SourceReference["kind"];
  readonly sourceId: SourceReference["sourceId"];
}

const registrationStates = new WeakMap<object, ObservationAuthorityRegistrationState>();

export const createObservationAuthorityIssuer = (input: {
  readonly clock: CanonicalClock;
  readonly sourceClass: ExternalSourceClass;
  readonly owner: string;
  readonly referenceKind: SourceReference["kind"];
  readonly sourceId: SourceReference["sourceId"];
}): Readonly<{
  registration: ObservationAuthorityRegistration;
  issue(reference: SourceReference): ObservationAuthority;
}> => {
  assertCanonicalClock(input.clock);
  const sourceClass = parseExternalSourceClass(input.sourceClass);
  if (sourceClassDefinitions[sourceClass].invocationReferenceCardinality === "single") {
    throw new TypeError("Observation authority issuer requires a multiple-reference source class.");
  }
  const owner = authorityPrimitiveSchemas.generalSingleLineText.parse(input.owner);
  const referenceKind = sourceReferenceKinds.includes(input.referenceKind as never)
    ? input.referenceKind
    : undefined;
  if (
    referenceKind === undefined ||
    !sourceClassAcceptsReference(sourceClass, referenceKind)
  ) {
    throw new TypeError("Observation authority reference kind is invalid.");
  }
  const sourceId = authorityPrimitiveSchemas.fixedIdentifier.parse(input.sourceId);
  const registration = Object.freeze({}) as ObservationAuthorityRegistration;
  const state = Object.freeze({
    clock: input.clock,
    sourceClass,
    owner,
    referenceKind,
    sourceId,
  });
  registrationStates.set(registration, state);
  return Object.freeze({
    registration,
    issue(referenceInput: SourceReference): ObservationAuthority {
      const reference = Object.freeze(parseSourceReference(referenceInput));
      if (
        reference.kind !== referenceKind ||
        reference.sourceId !== sourceId ||
        !sourceClassAcceptsReference(sourceClass, reference.kind)
      ) {
        throw new TypeError("Observation authority reference does not match its registration.");
      }
      const authority = Object.freeze({}) as ObservationAuthority;
      authorityStates.set(authority, Object.freeze({
        clock: input.clock,
        sourceClass,
        owner,
        reference,
        registration,
      }));
      return authority;
    },
  });
};

export const readObservationAuthority = (
  authority: ObservationAuthority,
  clock: CanonicalClock,
): Omit<ObservationAuthorityState, "clock"> => {
  const state = typeof authority === "object" && authority !== null
    ? authorityStates.get(authority)
    : undefined;
  if (state === undefined || state.clock !== clock) {
    throw new TypeError("Observation authority provenance is invalid.");
  }
  return {
    sourceClass: state.sourceClass,
    owner: state.owner,
    reference: state.reference,
  };
};

export const assertObservationAuthorityReference = (
  authority: ObservationAuthority,
  sourceClassInput: ExternalSourceClass,
  referenceInput: SourceReference,
): void => {
  const state = typeof authority === "object" && authority !== null
    ? authorityStates.get(authority)
    : undefined;
  const sourceClass = parseExternalSourceClass(sourceClassInput);
  const reference = parseSourceReference(referenceInput);
  if (
    state === undefined ||
    state.sourceClass !== sourceClass ||
    sourceReferenceIdentity(state.reference) !== sourceReferenceIdentity(reference)
  ) {
    throw new TypeError("Observation authority reference is inconsistent.");
  }
};

export const assertObservationAuthorityRegistrationOwns = (
  registration: ObservationAuthorityRegistration,
  authority: ObservationAuthority,
  sourceClassInput: ExternalSourceClass,
  referenceInput: SourceReference,
): void => {
  const registrationState = typeof registration === "object" && registration !== null
    ? registrationStates.get(registration)
    : undefined;
  const authorityState = typeof authority === "object" && authority !== null
    ? authorityStates.get(authority)
    : undefined;
  const sourceClass = parseExternalSourceClass(sourceClassInput);
  const reference = parseSourceReference(referenceInput);
  if (
    registrationState === undefined ||
    authorityState === undefined ||
    authorityState.registration !== registration ||
    registrationState.sourceClass !== sourceClass ||
    authorityState.sourceClass !== sourceClass ||
    authorityState.owner !== registrationState.owner ||
    authorityState.reference.kind !== registrationState.referenceKind ||
    authorityState.reference.sourceId !== registrationState.sourceId ||
    sourceReferenceIdentity(authorityState.reference) !== sourceReferenceIdentity(reference)
  ) {
    throw new TypeError("Observation authority is not owned by its registration.");
  }
};

export class ObservationAuthorityRegistry {
  readonly #clock: CanonicalClock;
  readonly #authorities: ReadonlyMap<ExternalSourceClass, readonly ObservationAuthority[]>;
  readonly #registrations: ReadonlyMap<ExternalSourceClass, readonly ObservationAuthorityRegistration[]>;

  constructor(
    clock: CanonicalClock,
    entries: readonly (ObservationAuthority | ObservationAuthorityRegistration)[],
  ) {
    assertCanonicalClock(clock);
    const map = new Map<ExternalSourceClass, ObservationAuthority[]>();
    const registrations = new Map<ExternalSourceClass, ObservationAuthorityRegistration[]>();
    const identities = new Set<string>();
    const register = (sourceClass: ExternalSourceClass, owner: string, kind: string, sourceId: string) => {
      const identity = invocationSourceGroupIdentity(sourceClass, owner, { kind: kind as SourceReference["kind"], sourceId });
      if (identities.has(identity)) throw new TypeError("Duplicate observation source class or owner identity.");
      identities.add(identity);
    };
    for (const entry of entries) {
      const authorityState = typeof entry === "object" && entry !== null
        ? authorityStates.get(entry)
        : undefined;
      if (authorityState !== undefined) {
        if (
          authorityState.clock !== clock ||
          sourceClassDefinitions[authorityState.sourceClass].invocationReferenceCardinality === "multiple_same_owner"
        ) {
          throw new TypeError("Observation authority provenance is invalid.");
        }
        register(authorityState.sourceClass, authorityState.owner, authorityState.reference.kind, authorityState.reference.sourceId);
        map.set(authorityState.sourceClass, [...(map.get(authorityState.sourceClass) ?? []), entry as ObservationAuthority]);
        continue;
      }
      const registrationState = typeof entry === "object" && entry !== null
        ? registrationStates.get(entry)
        : undefined;
      if (
        registrationState === undefined ||
        registrationState.clock !== clock ||
        sourceClassDefinitions[registrationState.sourceClass].invocationReferenceCardinality === "single"
      ) {
        throw new TypeError("Observation authority registration provenance is invalid.");
      }
      register(registrationState.sourceClass, registrationState.owner, registrationState.referenceKind, registrationState.sourceId);
      registrations.set(registrationState.sourceClass, [...(registrations.get(registrationState.sourceClass) ?? []), entry as ObservationAuthorityRegistration]);
    }
    this.#clock = clock;
    this.#authorities = map;
    this.#registrations = registrations;
    Object.freeze(this);
  }

  get(sourceClass: ExternalSourceClass): ObservationAuthority {
    const authorities = this.#authorities.get(sourceClass);
    if (authorities?.length !== 1 || this.#registrations.has(sourceClass)) throw new TypeError("Observation authority is unavailable or ambiguous.");
    return authorities[0]!;
  }

  owns(sourceClass: ExternalSourceClass, authority: ObservationAuthority): boolean {
    if (this.#authorities.get(sourceClass)?.includes(authority)) return true;
    const authorityState = typeof authority === "object" && authority !== null
      ? authorityStates.get(authority)
      : undefined;
    return (
      authorityState !== undefined &&
      authorityState.sourceClass === sourceClass &&
      authorityState.clock === this.#clock &&
      authorityState.registration !== undefined &&
      this.#registrations.get(sourceClass)?.includes(authorityState.registration) === true
    );
  }

  uses(clock: CanonicalClock): boolean {
    return this.#clock === clock;
  }
}

export interface InvocationBoundaryPorts {
  readonly observations: ObservationAuthorityRegistry;
}

export interface CapabilityInvocationAuthority {
  readonly __capabilityInvocationAuthority: unique symbol;
}

const invocationAuthorityStates = new WeakMap<object, {
  readonly clock: CanonicalClock;
  readonly chainId: ChainId;
}>();

export const assertCapabilityInvocationAuthority = (
  authority: CapabilityInvocationAuthority,
): Readonly<{ clock: CanonicalClock; chainId: ChainId }> => {
  const state = typeof authority === "object" && authority !== null
    ? invocationAuthorityStates.get(authority)
    : undefined;
  if (state === undefined) throw new TypeError("Invocation authority provenance is invalid.");
  return state;
};

export const createCapabilityInvocationAuthority = (
  clock: CanonicalClock,
  chainIdInput: ChainId,
): CapabilityInvocationAuthority => {
  assertCanonicalClock(clock);
  const chainId = parseChainId(chainIdInput);
  const authority = Object.freeze({}) as CapabilityInvocationAuthority;
  invocationAuthorityStates.set(authority, Object.freeze({ clock, chainId }));
  return authority;
};

export interface HandlerInvocationContext<Ports extends InvocationBoundaryPorts = InvocationBoundaryPorts> {
  readonly clock: CanonicalClock;
  readonly chainScope: ChainId;
  readonly signal: AbortSignal;
  readonly ports: Ports;
}

export const createHandlerInvocationContext = <Ports extends InvocationBoundaryPorts>(input: {
  readonly authority: CapabilityInvocationAuthority;
  readonly signal: AbortSignal;
  readonly ports: Ports;
}): HandlerInvocationContext<Ports> => {
  const { clock, chainId } = assertCapabilityInvocationAuthority(input.authority);
  if (!input.ports.observations.uses(clock)) {
    throw new TypeError("Invocation ports use a different canonical clock.");
  }
  return Object.freeze({
    clock,
    chainScope: chainId,
    signal: input.signal,
    ports: input.ports,
  });
};
