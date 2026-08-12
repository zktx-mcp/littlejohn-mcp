import {
  validateControlCredential,
  type ControlCredentialVerifier,
} from "./control-credential.js";
import {
  fixedHostHeader,
  internalResponseLimitBytes,
  jsonContentType,
  publicReadResponseLimitBytes,
  requestBodyLimitBytes,
  type RouteMutation,
} from "./http-boundary.js";

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
  readonly params: Readonly<Record<string, string>>;
}

export interface RequestEnvelopeSecurityInput {
  readonly host: readonly string[];
  readonly bodyLength: number;
}

export interface RequestClassSecurityInput extends RequestAuthenticationInput {
  readonly requestClass: string;
  readonly origin: readonly string[];
}

export interface RequestSecurityInput extends RequestClassSecurityInput, RequestEnvelopeSecurityInput {
  readonly contentType: readonly string[];
  readonly acceptsBody: boolean;
  readonly query: string;
}

export type RequestSecurityResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: SecurityFailureCode };

type RequestPolicyBodyMode = "none" | "route_json";

export const ownerIdentityRequestClass = "owner_identity" as const;
export const publicReadRequestClass = "public_read" as const;
export const localControlRequestClass = "local_control" as const;
export const runtimeDispatchRequestClasses = Object.freeze([
  localControlRequestClass,
  publicReadRequestClass,
] as const);
export type RuntimeDispatchRequestClass = typeof runtimeDispatchRequestClasses[number];

export interface RequestPolicyDefinition {
  readonly requestClass: string;
  readonly host: "fixed";
  readonly authentication: "none" | "local_control";
  readonly body: RequestPolicyBodyMode;
  readonly responseLimitBytes: number;
  readonly mutation: RouteMutation;
}

type AuthenticationVerifier = (input: RequestAuthenticationInput) => boolean;

const exactOne = (values: readonly string[], expected: string): boolean =>
  values.length === 1 && values[0] === expected;

const noAuthentication: AuthenticationVerifier = (input) =>
  input.authorization.length === 0 && input.cookie.length === 0;

const localControlAuthentication = (
  verifier: ControlCredentialVerifier,
  input: RequestAuthenticationInput,
): boolean => {
  if (input.cookie.length !== 0 || input.authorization.length !== 1) return false;
  const authorization = input.authorization[0] as string;
  return authorization.startsWith("Bearer ") &&
    validateControlCredential(verifier, authorization.slice(7));
};

interface RequestPolicyRegistryState {
  readonly policies: ReadonlyMap<string, RequestPolicyDefinition>;
  readonly authenticationVerifiers: ReadonlyMap<string, AuthenticationVerifier>;
}

const registryStates = new WeakMap<object, RequestPolicyRegistryState>();

const registryState = (registry: RequestPolicyRegistry): RequestPolicyRegistryState => {
  const state = typeof registry === "object" && registry !== null
    ? registryStates.get(registry)
    : undefined;
  if (state === undefined) throw new TypeError("Request policy registry provenance is invalid.");
  return state;
};

const createRegistry = (state: RequestPolicyRegistryState): RequestPolicyRegistry => {
  const registry = Object.create(RequestPolicyRegistry.prototype) as RequestPolicyRegistry;
  registryStates.set(registry, Object.freeze(state));
  return Object.freeze(registry);
};

export class RequestPolicyRegistry {
  private constructor() {}

  get(requestClass: string): RequestPolicyDefinition {
    const policy = registryState(this).policies.get(requestClass);
    if (policy === undefined) throw new TypeError("Unknown request class.");
    return policy;
  }

  validateClass(input: RequestClassSecurityInput): RequestSecurityResult {
    const state = registryState(this);
    const policy = this.get(input.requestClass);
    if (input.origin.length !== 0) return { ok: false, code: "invalid_origin" };
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
    if (input.query !== "") return { ok: false, code: "query_not_supported" };
    const policy = this.get(input.requestClass);
    if (!input.acceptsBody && input.bodyLength !== 0) {
      return { ok: false, code: "payload_too_large" };
    }
    if (!input.acceptsBody && input.contentType.length !== 0) {
      return { ok: false, code: "content_type_unsupported" };
    }
    if (input.acceptsBody &&
      (policy.body !== "route_json" || !exactOne(input.contentType, jsonContentType))) {
      return { ok: false, code: "content_type_unsupported" };
    }
    return this.validateClass(input);
  }
}

export const createInitialRequestPolicyRegistry = (
  controlVerifier?: ControlCredentialVerifier,
): RequestPolicyRegistry => createRegistry({
  policies: new Map<string, RequestPolicyDefinition>([
    [ownerIdentityRequestClass, Object.freeze({
      requestClass: ownerIdentityRequestClass,
      host: "fixed",
      authentication: "none",
      body: "none",
      responseLimitBytes: internalResponseLimitBytes,
      mutation: "none",
    })],
    [publicReadRequestClass, Object.freeze({
      requestClass: publicReadRequestClass,
      host: "fixed",
      authentication: "none",
      body: "route_json",
      responseLimitBytes: publicReadResponseLimitBytes,
      mutation: "none",
    })],
    [localControlRequestClass, Object.freeze({
      requestClass: localControlRequestClass,
      host: "fixed",
      authentication: "local_control",
      body: "route_json",
      responseLimitBytes: internalResponseLimitBytes,
      mutation: "declared_control",
    })],
  ]),
  authenticationVerifiers: new Map<string, AuthenticationVerifier>([
    ["none", noAuthentication],
    ["local_control", (input) =>
      controlVerifier !== undefined && localControlAuthentication(controlVerifier, input)],
  ]),
});

export const validateRequestTargetSecurity = (
  host: readonly string[],
): RequestSecurityResult => {
  if (!exactOne(host, fixedHostHeader)) return { ok: false, code: "invalid_host" };
  return { ok: true };
};

export const validateRequestEnvelopeSecurity = (
  input: RequestEnvelopeSecurityInput,
): RequestSecurityResult => {
  const target = validateRequestTargetSecurity(input.host);
  if (!target.ok) return target;
  if (!Number.isSafeInteger(input.bodyLength) || input.bodyLength < 0 ||
    input.bodyLength > requestBodyLimitBytes) {
    return { ok: false, code: "payload_too_large" };
  }
  return { ok: true };
};

export const validateRequestSecurity = (
  input: RequestSecurityInput & { readonly controlVerifier?: ControlCredentialVerifier },
): RequestSecurityResult => {
  if (input.controlVerifier === undefined) {
    if (input.requestClass === localControlRequestClass) {
      return { ok: false, code: "unauthorized" };
    }
    return createInitialRequestPolicyRegistry().validate(input);
  }
  return createInitialRequestPolicyRegistry(input.controlVerifier).validate(input);
};
