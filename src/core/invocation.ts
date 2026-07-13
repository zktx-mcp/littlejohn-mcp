import type { AssetIdentity } from "./amounts.js";
import type { CanonicalJson } from "./canonical-json.js";
import {
  parseExternalSourceClass,
  parseSourceReference,
  sourceClassAcceptsReference,
  type ExternalSourceClass,
  type SourceReference,
} from "./evidence.js";
import { robinhoodChainIdentity } from "./identities.js";
import {
  createPrimitiveSchemaSet,
  parseUtcTimestamp,
  type ChainAnchor,
  type UtcTimestamp,
} from "./primitives.js";

const authorityPrimitiveSchemas = createPrimitiveSchemaSet();

export interface ObservationClaim {
  readonly role: string;
  readonly value: CanonicalJson;
  readonly chainAnchor?: ChainAnchor;
  readonly asset?: AssetIdentity;
}

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

export class ObservationAuthorityRegistry {
  readonly #clock: CanonicalClock;
  readonly #authorities: ReadonlyMap<ExternalSourceClass, ObservationAuthority>;

  constructor(clock: CanonicalClock, authorities: readonly ObservationAuthority[]) {
    assertCanonicalClock(clock);
    const map = new Map<ExternalSourceClass, ObservationAuthority>();
    for (const authority of authorities) {
      const state = typeof authority === "object" && authority !== null
        ? authorityStates.get(authority)
        : undefined;
      if (state === undefined || state.clock !== clock) {
        throw new TypeError("Observation authority provenance is invalid.");
      }
      if (map.has(state.sourceClass)) throw new TypeError("Duplicate observation source class.");
      map.set(state.sourceClass, authority);
    }
    this.#clock = clock;
    this.#authorities = map;
    Object.freeze(this);
  }

  get(sourceClass: ExternalSourceClass): ObservationAuthority {
    const authority = this.#authorities.get(sourceClass);
    if (authority === undefined) throw new TypeError("Observation authority is unavailable.");
    return authority;
  }

  owns(sourceClass: ExternalSourceClass, authority: ObservationAuthority): boolean {
    return this.#authorities.get(sourceClass) === authority;
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

const invocationAuthorityStates = new WeakMap<object, { readonly clock: CanonicalClock }>();

export const createCapabilityInvocationAuthority = (
  clock: CanonicalClock,
): CapabilityInvocationAuthority => {
  assertCanonicalClock(clock);
  const authority = Object.freeze({}) as CapabilityInvocationAuthority;
  invocationAuthorityStates.set(authority, { clock });
  return authority;
};

export interface HandlerInvocationContext<Ports extends InvocationBoundaryPorts = InvocationBoundaryPorts> {
  readonly clock: CanonicalClock;
  readonly chainScope: typeof robinhoodChainIdentity;
  readonly signal: AbortSignal;
  readonly ports: Ports;
}

export const createHandlerInvocationContext = <Ports extends InvocationBoundaryPorts>(input: {
  readonly authority: CapabilityInvocationAuthority;
  readonly signal: AbortSignal;
  readonly ports: Ports;
}): HandlerInvocationContext<Ports> => {
  const state = typeof input.authority === "object" && input.authority !== null
    ? invocationAuthorityStates.get(input.authority)
    : undefined;
  if (state === undefined) throw new TypeError("Invocation authority provenance is invalid.");
  if (!input.ports.observations.uses(state.clock)) {
    throw new TypeError("Invocation ports use a different canonical clock.");
  }
  return Object.freeze({
    clock: state.clock,
    chainScope: robinhoodChainIdentity,
    signal: input.signal,
    ports: input.ports,
  });
};
