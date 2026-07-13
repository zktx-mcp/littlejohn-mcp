import { z } from "zod";

import { compareCodePointSequences, snakeCaseCodeSchema } from "../core/index.js";
import {
  validateControlCredential,
  type ControlCredentialVerifier,
} from "./control-credential.js";
import {
  fixedHostHeader,
  fixedOrigin,
  internalResponseLimitBytes,
  jsonContentType,
  publicReadResponseLimitBytes,
  requestBodyLimitBytes,
} from "./http-boundary.js";
import { parseRuntimeAuthority } from "./schema-authority.js";

export type SecurityFailureCode =
  | "invalid_host"
  | "invalid_origin"
  | "unauthorized"
  | "query_not_supported"
  | "payload_too_large"
  | "content_type_unsupported";

export interface RequestAuthenticationInput {
  readonly authorization: readonly string[];
  readonly cookie: readonly string[];
  readonly csrfToken: readonly string[];
}

export interface RequestEnvelopeSecurityInput {
  readonly host: readonly string[];
  readonly query: string;
  readonly bodyLength: number;
}

export interface RequestClassSecurityInput extends RequestAuthenticationInput {
  readonly requestClass: string;
  readonly origin: readonly string[];
}

export interface RequestSecurityInput extends RequestClassSecurityInput, RequestEnvelopeSecurityInput {
  readonly contentType: readonly string[];
  readonly acceptsBody: boolean;
}

export type RequestSecurityResult = { readonly ok: true } | { readonly ok: false; readonly code: SecurityFailureCode };

export interface RequestPolicyDefinition {
  readonly requestClass: string;
  readonly host: "fixed";
  readonly origin: "absent" | "absent_or_fixed" | "fixed";
  readonly authentication: string;
  readonly body: "none" | "route_json";
  readonly responseLimitBytes: number;
  readonly mutation: "none" | "declared_control";
}

export interface AuthenticationVerifierDefinition {
  readonly authentication: string;
  readonly verify: (input: RequestAuthenticationInput) => boolean;
}

export interface RequestPolicyExtension {
  readonly authenticationVerifiers: readonly AuthenticationVerifierDefinition[];
  readonly policies: readonly RequestPolicyDefinition[];
}

const policySchema = z.object({
  requestClass: snakeCaseCodeSchema,
  host: z.literal("fixed"),
  origin: z.enum(["absent", "absent_or_fixed", "fixed"]),
  authentication: snakeCaseCodeSchema,
  body: z.enum(["none", "route_json"]),
  responseLimitBytes: z.number().int().min(1).max(publicReadResponseLimitBytes),
  mutation: z.enum(["none", "declared_control"]),
}).strict();

const exactOne = (values: readonly string[], expected: string): boolean =>
  values.length === 1 && values[0] === expected;

const noAuthentication = (input: RequestAuthenticationInput): boolean =>
  input.authorization.length === 0 && input.cookie.length === 0 && input.csrfToken.length === 0;

const localControlAuthentication = (
  verifier: ControlCredentialVerifier,
  input: RequestAuthenticationInput,
): boolean => {
  if (input.cookie.length !== 0 || input.csrfToken.length !== 0 || input.authorization.length !== 1) return false;
  const authorization = input.authorization[0] as string;
  return authorization.startsWith("Bearer ") &&
    validateControlCredential(verifier, authorization.slice(7));
};

const captureAuthenticationVerifier = (
  input: AuthenticationVerifierDefinition,
): AuthenticationVerifierDefinition => {
  if (typeof input !== "object" || input === null) {
    throw new TypeError("Authentication verifier definition must be a plain object.");
  }
  let prototype: object | null;
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    prototype = Object.getPrototypeOf(input) as object | null;
    descriptors = Object.getOwnPropertyDescriptors(input) as Record<PropertyKey, PropertyDescriptor>;
  } catch {
    throw new TypeError("Authentication verifier definition cannot be inspected safely.");
  }
  const keys = Reflect.ownKeys(descriptors);
  if ((prototype !== Object.prototype && prototype !== null) ||
    keys.some((key) => typeof key !== "string") ||
    (keys as string[]).sort(compareCodePointSequences).join("\0") !== ["authentication", "verify"].join("\0")) {
    throw new TypeError("Authentication verifier definition fields are invalid.");
  }
  const authentication = descriptors["authentication"];
  const verify = descriptors["verify"];
  if (authentication === undefined || verify === undefined ||
    !("value" in authentication) || !("value" in verify) ||
    authentication.enumerable !== true || verify.enumerable !== true ||
    !snakeCaseCodeSchema.safeParse(authentication.value).success || typeof verify.value !== "function") {
    throw new TypeError("Authentication verifier definition values are invalid.");
  }
  return Object.freeze({
    authentication: authentication.value as string,
    verify: verify.value as AuthenticationVerifierDefinition["verify"],
  });
};

const captureRequestPolicyExtension = (input: RequestPolicyExtension): RequestPolicyExtension => {
  if (typeof input !== "object" || input === null) {
    throw new TypeError("Request policy extension must be a plain object.");
  }
  try {
    const prototype = Object.getPrototypeOf(input) as object | null;
    const descriptors = Object.getOwnPropertyDescriptors(input) as Record<PropertyKey, PropertyDescriptor>;
    const keys = Reflect.ownKeys(descriptors);
    if ((prototype !== Object.prototype && prototype !== null) ||
      keys.some((key) => typeof key !== "string") ||
      (keys as string[]).sort(compareCodePointSequences).join("\0") !==
        ["authenticationVerifiers", "policies"].join("\0")) {
      throw new TypeError("Request policy extension fields are invalid.");
    }
    const authenticationVerifiers = descriptors["authenticationVerifiers"];
    const policies = descriptors["policies"];
    if (authenticationVerifiers === undefined || policies === undefined ||
      !("value" in authenticationVerifiers) || !("value" in policies) ||
      authenticationVerifiers.enumerable !== true || policies.enumerable !== true ||
      !Array.isArray(authenticationVerifiers.value) || !Array.isArray(policies.value)) {
      throw new TypeError("Request policy extension values are invalid.");
    }
    return Object.freeze({
      authenticationVerifiers: Object.freeze([...authenticationVerifiers.value] as AuthenticationVerifierDefinition[]),
      policies: Object.freeze([...policies.value] as RequestPolicyDefinition[]),
    });
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith("Request policy extension")) throw error;
    throw new TypeError("Request policy extension cannot be inspected safely.");
  }
};

interface RequestPolicyRegistryState {
  readonly policies: ReadonlyMap<string, RequestPolicyDefinition>;
  readonly authenticationVerifiers: ReadonlyMap<string, AuthenticationVerifierDefinition["verify"]>;
  readonly parent?: RequestPolicyRegistry;
}

const registryStates = new WeakMap<object, RequestPolicyRegistryState>();

const registryState = (registry: RequestPolicyRegistry): RequestPolicyRegistryState => {
  const state = typeof registry === "object" && registry !== null ? registryStates.get(registry) : undefined;
  if (state === undefined) throw new TypeError("Request policy registry provenance is invalid.");
  return state;
};

const createRegistry = (state: RequestPolicyRegistryState): RequestPolicyRegistry => {
  const registry = Object.create(RequestPolicyRegistry.prototype) as RequestPolicyRegistry;
  registryStates.set(registry, Object.freeze(state));
  return Object.freeze(registry);
};

const validateOrigin = (
  policy: RequestPolicyDefinition,
  origin: readonly string[],
): RequestSecurityResult => {
  if (policy.origin === "absent") {
    return origin.length === 0 ? { ok: true } : { ok: false, code: "invalid_origin" };
  }
  if (policy.origin === "fixed") {
    return exactOne(origin, fixedOrigin) ? { ok: true } : { ok: false, code: "invalid_origin" };
  }
  return origin.length === 0 || exactOne(origin, fixedOrigin)
    ? { ok: true }
    : { ok: false, code: "invalid_origin" };
};

export class RequestPolicyRegistry {
  private constructor() {}

  get(requestClass: string): RequestPolicyDefinition {
    const policy = registryState(this).policies.get(requestClass);
    if (policy === undefined) throw new TypeError("Unknown request class.");
    return policy;
  }

  directRequestClasses(parent: RequestPolicyRegistry): readonly string[] {
    const state = registryState(this);
    const parentState = registryState(parent);
    if (state.parent !== parent) throw new TypeError("Request policy registry is not a direct extension.");
    return Object.freeze([...state.policies.keys()]
      .filter((requestClass) => !parentState.policies.has(requestClass))
      .sort(compareCodePointSequences));
  }

  directAuthentications(parent: RequestPolicyRegistry): readonly string[] {
    const state = registryState(this);
    const parentState = registryState(parent);
    if (state.parent !== parent) throw new TypeError("Request policy registry is not a direct extension.");
    return Object.freeze([...state.authenticationVerifiers.keys()]
      .filter((authentication) => !parentState.authenticationVerifiers.has(authentication))
      .sort(compareCodePointSequences));
  }

  extend(extension: RequestPolicyExtension): RequestPolicyRegistry {
    const state = registryState(this);
    const captured = captureRequestPolicyExtension(extension);
    const verifiers = new Map(state.authenticationVerifiers);
    for (const input of captured.authenticationVerifiers) {
      const verifier = captureAuthenticationVerifier(input);
      if (verifiers.has(verifier.authentication)) throw new TypeError("Duplicate authentication verifier.");
      verifiers.set(verifier.authentication, verifier.verify);
    }
    const policies = new Map(state.policies);
    const parsedPolicies = parseRuntimeAuthority(z.array(policySchema).min(1), captured.policies);
    for (const parsed of parsedPolicies) {
      const policy = Object.freeze({ ...parsed });
      if (!verifiers.has(policy.authentication)) throw new TypeError("Unknown authentication verifier.");
      if (policies.has(policy.requestClass)) throw new TypeError("Duplicate request class.");
      policies.set(policy.requestClass, policy);
    }
    return createRegistry({ policies, authenticationVerifiers: verifiers, parent: this });
  }

  validateClass(input: RequestClassSecurityInput): RequestSecurityResult {
    const state = registryState(this);
    const policy = this.get(input.requestClass);
    const origin = validateOrigin(policy, input.origin);
    if (!origin.ok) return origin;
    const verifier = state.authenticationVerifiers.get(policy.authentication);
    let verified = false;
    try { verified = verifier?.(input) === true; }
    catch { verified = false; }
    if (!verified) return { ok: false, code: "unauthorized" };
    return { ok: true };
  }

  validate(input: RequestSecurityInput): RequestSecurityResult {
    const envelope = validateRequestEnvelopeSecurity(input);
    if (!envelope.ok) return envelope;
    const policy = this.get(input.requestClass);
    if (!input.acceptsBody && input.bodyLength !== 0) return { ok: false, code: "payload_too_large" };
    if (!input.acceptsBody && input.contentType.length !== 0) {
      return { ok: false, code: "content_type_unsupported" };
    }
    if (input.acceptsBody) {
      if (policy.body !== "route_json" || !exactOne(input.contentType, jsonContentType)) {
        return { ok: false, code: "content_type_unsupported" };
      }
    }
    return this.validateClass(input);
  }
}

export const createInitialRequestPolicyRegistry = (
  controlVerifier?: ControlCredentialVerifier,
): RequestPolicyRegistry => createRegistry({
  policies: new Map<string, RequestPolicyDefinition>([
    ["owner_identity", Object.freeze({
      requestClass: "owner_identity", host: "fixed", origin: "absent", authentication: "none",
      body: "none", responseLimitBytes: internalResponseLimitBytes, mutation: "none",
    })],
    ["public_read", Object.freeze({
      requestClass: "public_read", host: "fixed", origin: "absent_or_fixed", authentication: "none",
      body: "route_json", responseLimitBytes: publicReadResponseLimitBytes, mutation: "none",
    })],
    ["local_control", Object.freeze({
      requestClass: "local_control", host: "fixed", origin: "absent", authentication: "local_control",
      body: "route_json", responseLimitBytes: internalResponseLimitBytes, mutation: "declared_control",
    })],
  ]),
  authenticationVerifiers: new Map([
    ["none", noAuthentication],
    ["local_control", (input) => controlVerifier !== undefined && localControlAuthentication(controlVerifier, input)],
  ]),
});

export const assertRequestPolicyRegistryDescendant = (
  ancestor: RequestPolicyRegistry,
  candidate: RequestPolicyRegistry,
): void => {
  registryState(ancestor);
  let current: RequestPolicyRegistry | undefined = candidate;
  while (current !== undefined && current !== ancestor) current = registryState(current).parent;
  if (current !== ancestor) throw new TypeError("Request policy registry ancestry is invalid.");
};

export const validateRequestTargetSecurity = (
  host: readonly string[],
  query: string,
): RequestSecurityResult => {
  if (!exactOne(host, fixedHostHeader)) return { ok: false, code: "invalid_host" };
  if (query !== "") return { ok: false, code: "query_not_supported" };
  return { ok: true };
};

export const validateRequestEnvelopeSecurity = (
  input: RequestEnvelopeSecurityInput,
): RequestSecurityResult => {
  const target = validateRequestTargetSecurity(input.host, input.query);
  if (!target.ok) return target;
  if (!Number.isSafeInteger(input.bodyLength) || input.bodyLength < 0 || input.bodyLength > requestBodyLimitBytes) {
    return { ok: false, code: "payload_too_large" };
  }
  return { ok: true };
};

export const validateRequestSecurity = (
  input: RequestSecurityInput & { readonly controlVerifier?: ControlCredentialVerifier },
): RequestSecurityResult => {
  if (input.controlVerifier === undefined) {
    if (input.requestClass === "local_control") return { ok: false, code: "unauthorized" };
    return createInitialRequestPolicyRegistry().validate(input);
  }
  return createInitialRequestPolicyRegistry(input.controlVerifier).validate(input);
};
