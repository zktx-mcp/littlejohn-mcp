import {
  captureCanonicalJson,
  compareCodePointSequences,
  type ApplicationFailure,
  type CanonicalJson,
} from "../core/index.js";
import type { ControlCredentialVerifier } from "./control-credential.js";
import {
  assertDirectInterfaceErrorMappingRegistryExtension,
  runtimeInterfaceErrorMappings,
  toProblemDetails,
  type InterfaceErrorMappingRegistry,
  type ProblemDetails,
} from "./errors.js";
import {
  assertRequestPolicyRegistryDescendant,
  createInitialRequestPolicyRegistry,
  type RequestPolicyExtension,
  type RequestPolicyRegistry,
  type RequestClassSecurityInput,
  type RequestSecurityInput,
  type RequestSecurityResult,
} from "./request-security.js";
import {
  browserContentTypes,
  browserSetCookieLimitBytes,
  type BrowserContentType,
} from "./http-boundary.js";

export type RouteMethod = "GET" | "POST" | "DELETE";

export interface RouteContext {
  readonly params: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly signal: AbortSignal;
}

export type RouteResult =
  | { readonly ok: true; readonly body: CanonicalJson }
  | {
      readonly ok: true;
      readonly body: string;
      readonly contentType: BrowserContentType;
      readonly setCookie?: string;
    }
  | { readonly ok: false; readonly failure: ApplicationFailure };

export interface RouteDefinition {
  readonly method: RouteMethod;
  readonly mutation: "none" | "declared_control";
  readonly pathPattern: string;
  readonly response: "canonical_json" | "browser_content";
  readonly successStatus: 200 | 201;
  readonly handler: (context: RouteContext) => Promise<RouteResult>;
}

const captureRouteDefinition = (input: RouteDefinition): RouteDefinition => {
  if (typeof input !== "object" || input === null) {
    throw new TypeError("Route definition must be a plain object.");
  }
  let prototype: object | null;
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    prototype = Object.getPrototypeOf(input) as object | null;
    descriptors = Object.getOwnPropertyDescriptors(input) as Record<PropertyKey, PropertyDescriptor>;
  } catch {
    throw new TypeError("Route definition cannot be inspected safely.");
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Route definition must be a plain object.");
  }
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key === "symbol") ||
    keys.filter((key): key is string => typeof key === "string").sort(compareCodePointSequences).join("\0") !==
      ["handler", "method", "mutation", "pathPattern", "response", "successStatus"].join("\0")) {
    throw new TypeError("Route definition fields are invalid.");
  }
  const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError("Route definition properties must be enumerable data properties.");
    }
    values[key] = descriptor.value;
  }
  if (!(["GET", "POST", "DELETE"] as const).includes(values["method"] as RouteMethod) ||
    !(["none", "declared_control"] as const).includes(values["mutation"] as RouteDefinition["mutation"]) ||
    typeof values["pathPattern"] !== "string" ||
    !(["canonical_json", "browser_content"] as const).includes(
      values["response"] as RouteDefinition["response"],
    ) ||
    !([200, 201] as const).includes(values["successStatus"] as 200 | 201) ||
    typeof values["handler"] !== "function") {
    throw new TypeError("Route definition values are invalid.");
  }
  return Object.freeze({
    method: values["method"] as RouteMethod,
    mutation: values["mutation"] as RouteDefinition["mutation"],
    pathPattern: values["pathPattern"],
    response: values["response"] as RouteDefinition["response"],
    successStatus: values["successStatus"] as 200 | 201,
    handler: values["handler"] as RouteDefinition["handler"],
  });
};

interface CompiledRoute extends RouteDefinition {
  readonly requestClass: string;
  readonly acceptsBody: boolean;
  readonly responseLimitBytes: number;
  readonly segments: readonly RouteSegment[];
}

type RouteSegment =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "parameter"; readonly name: string };

const parseRouteSegments = (pathPattern: string): readonly RouteSegment[] => {
  if (!pathPattern.startsWith("/") || pathPattern.includes("//") || pathPattern.endsWith("/") ||
    pathPattern === "/api/v1/runtime-identity") {
    throw new TypeError("Route path pattern is invalid.");
  }
  const parameterNames = new Set<string>();
  return Object.freeze(pathPattern.slice(1).split("/").map((segment) => {
    const parameter = /^\{([a-z][a-zA-Z0-9]*)\}$/.exec(segment);
    if (parameter !== null) {
      const name = parameter[1] as string;
      if (parameterNames.has(name)) throw new TypeError("Route parameter is duplicated.");
      parameterNames.add(name);
      return Object.freeze({ kind: "parameter" as const, name });
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(segment)) throw new TypeError("Route literal is invalid.");
    return Object.freeze({ kind: "literal" as const, value: segment });
  }));
};

export type ResourcePathDefinition =
  | { readonly kind: "prefix"; readonly pathPrefix: string; readonly requestClass: string }
  | {
      readonly kind: "route";
      readonly method: RouteMethod;
      readonly pathPattern: string;
      readonly requestClass: string;
    };

const captureResourcePathDefinition = (input: ResourcePathDefinition): ResourcePathDefinition => {
  if (typeof input !== "object" || input === null) throw new TypeError("Resource path definition is invalid.");
  let prototype: object | null;
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    prototype = Object.getPrototypeOf(input) as object | null;
    descriptors = Object.getOwnPropertyDescriptors(input) as Record<PropertyKey, PropertyDescriptor>;
  } catch { throw new TypeError("Resource path definition cannot be inspected safely."); }
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError("Resource path definition is invalid.");
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string")) throw new TypeError("Resource path definition is invalid.");
  const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError("Resource path definition is invalid.");
    }
    values[key] = descriptor.value;
  }
  if (values["kind"] === "prefix") {
    if ((keys as string[]).sort(compareCodePointSequences).join("\0") !==
      ["kind", "pathPrefix", "requestClass"].join("\0") ||
      typeof values["pathPrefix"] !== "string" || typeof values["requestClass"] !== "string" ||
      !values["pathPrefix"].startsWith("/") || !values["pathPrefix"].endsWith("/") ||
      values["pathPrefix"].includes("//")) throw new TypeError("Resource path definition is invalid.");
    return Object.freeze({
      kind: "prefix", pathPrefix: values["pathPrefix"], requestClass: values["requestClass"],
    });
  }
  if (values["kind"] === "route") {
    if ((keys as string[]).sort(compareCodePointSequences).join("\0") !==
      ["kind", "method", "pathPattern", "requestClass"].join("\0") ||
      !(["GET", "POST", "DELETE"] as const).includes(values["method"] as RouteMethod) ||
      typeof values["pathPattern"] !== "string" || typeof values["requestClass"] !== "string") {
      throw new TypeError("Resource path definition is invalid.");
    }
    parseRouteSegments(values["pathPattern"]);
    return Object.freeze({
      kind: "route", method: values["method"] as RouteMethod,
      pathPattern: values["pathPattern"], requestClass: values["requestClass"],
    });
  }
  throw new TypeError("Resource path definition is invalid.");
};

const resourceKey = (definition: ResourcePathDefinition): string => definition.kind === "prefix"
  ? `prefix:${definition.pathPrefix}`
  : `route:${definition.method}:${definition.pathPattern}`;

const requestClassForResource = (
  method: RouteMethod,
  pathPattern: string,
  definitions: readonly ResourcePathDefinition[],
): string => {
  const pathAuthorities = definitions.filter((definition): definition is Extract<ResourcePathDefinition, { kind: "route" }> =>
    definition.kind === "route" && definition.pathPattern === pathPattern);
  const exact = pathAuthorities.filter((definition) => definition.method === method);
  if (exact.length > 1) throw new TypeError("Resource path authority is ambiguous.");
  if (exact[0] !== undefined) return exact[0].requestClass;
  if (pathAuthorities.length !== 0) {
    throw new TypeError("Route method is outside the registered resource authority.");
  }
  const prefixes = definitions.filter((definition): definition is Extract<ResourcePathDefinition, { kind: "prefix" }> =>
    definition.kind === "prefix" && pathPattern.startsWith(definition.pathPrefix))
    .sort((left, right) => right.pathPrefix.length - left.pathPrefix.length);
  if (prefixes.length === 0 || (prefixes[1] !== undefined &&
    prefixes[0]?.pathPrefix.length === prefixes[1].pathPrefix.length)) {
    throw new TypeError("Route path is outside an owned request-class resource.");
  }
  const selected = prefixes[0] as Extract<ResourcePathDefinition, { kind: "prefix" }>;
  if (pathPattern.startsWith("/api/v1/internal/") && selected.pathPrefix === "/api/v1/") {
    throw new TypeError("Internal routes require an explicitly owned resource namespace.");
  }
  return selected.requestClass;
};

const compile = (
  definition: RouteDefinition,
  requestPolicies: RequestPolicyRegistry,
  resources: readonly ResourcePathDefinition[],
): CompiledRoute => {
  const captured = captureRouteDefinition(definition);
  const segments = parseRouteSegments(captured.pathPattern);
  const requestClass = requestClassForResource(captured.method, captured.pathPattern, resources);
  const requestPolicy = requestPolicies.get(requestClass);
  if (requestClass === "owner_identity" ||
    (captured.method === "POST" && requestPolicy.body === "none") ||
    (captured.mutation === "declared_control" &&
      (requestPolicy.mutation !== "declared_control" || captured.method === "GET")) ||
    (captured.successStatus === 201 && captured.method !== "POST")) {
    throw new TypeError("Route request policy is incompatible with its resource.");
  }
  const acceptsBody = captured.method === "POST";
  return Object.freeze({
    ...captured,
    requestClass,
    acceptsBody,
    responseLimitBytes: requestPolicy.responseLimitBytes,
    segments,
  });
};

const routesIntersect = (left: CompiledRoute, right: CompiledRoute): boolean =>
  left.segments.length === right.segments.length && left.segments.every((segment, index) => {
    const other = right.segments[index];
    return other !== undefined &&
      (segment.kind === "parameter" || other.kind === "parameter" || segment.value === other.value);
  });

const routeShape = (route: CompiledRoute): string => route.segments.map((segment) =>
  segment.kind === "literal" ? segment.value : "{}").join("/");

const assertUnambiguousRoutes = (routes: readonly CompiledRoute[]): void => {
  for (let leftIndex = 0; leftIndex < routes.length; leftIndex += 1) {
    const left = routes[leftIndex];
    if (left === undefined) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < routes.length; rightIndex += 1) {
      const right = routes[rightIndex];
      if (right === undefined || !routesIntersect(left, right)) continue;
      if (left.method === right.method || routeShape(left) !== routeShape(right)) {
        throw new TypeError("Route patterns intersect ambiguously.");
      }
    }
  }
};

const matchSegments = (route: CompiledRoute, pathname: string): Readonly<Record<string, string>> | undefined => {
  if (
    !pathname.startsWith("/") ||
    pathname.length > 2_048 ||
    pathname.includes("//") ||
    (pathname.length > 1 && pathname.endsWith("/"))
  ) return undefined;
  const encodedSegments = pathname === "/" ? [] : pathname.slice(1).split("/");
  if (encodedSegments.length !== route.segments.length) return undefined;
  const params: Record<string, string> = Object.create(null) as Record<string, string>;
  for (let index = 0; index < route.segments.length; index += 1) {
    const expected = route.segments[index];
    const encoded = encodedSegments[index];
    if (expected === undefined || encoded === undefined || encoded.length === 0 || encoded.length > 128 ||
      !/^[A-Za-z0-9._~-]+$/.test(encoded)) return undefined;
    if (expected.kind === "literal") {
      if (encoded !== expected.value) return undefined;
    } else params[expected.name] = encoded;
  }
  return Object.freeze(params);
};

export type RouteMatch =
  | { readonly status: "matched"; readonly route: CompiledRoute; readonly params: Readonly<Record<string, string>> }
  | {
      readonly status: "method_not_allowed";
      readonly candidates: readonly {
        readonly route: CompiledRoute;
        readonly params: Readonly<Record<string, string>>;
      }[];
      readonly allow: readonly RouteMethod[];
    }
  | { readonly status: "not_found" };

const routeMatchRegistries = new WeakMap<object, RuntimeRouteRegistry>();

const createRouteMatch = <Match extends RouteMatch>(
  registry: RuntimeRouteRegistry,
  input: Match,
): Match => {
  const match = Object.freeze(input);
  routeMatchRegistries.set(match, registry);
  return match;
};

export type NormalizedRouteResult =
  | { readonly ok: true; readonly response: "canonical_json"; readonly body: CanonicalJson }
  | {
      readonly ok: true;
      readonly response: "browser_content";
      readonly body: string;
      readonly contentType: BrowserContentType;
      readonly setCookie?: string;
    }
  | { readonly ok: false; readonly problem: ProblemDetails };

const isSafeSetCookie = (value: string): boolean =>
  Buffer.byteLength(value) <= browserSetCookieLimitBytes &&
  !value.includes(",") &&
  /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/.test(value);

interface RouteRegistryState {
  readonly routes: readonly CompiledRoute[];
  readonly requestPolicies: RequestPolicyRegistry;
  readonly resources: readonly ResourcePathDefinition[];
  readonly errorMappings: InterfaceErrorMappingRegistry;
  readonly parent?: RuntimeRouteRegistry;
}

const routeRegistryStates = new WeakMap<object, RouteRegistryState>();

const routeRegistryState = (registry: RuntimeRouteRegistry): RouteRegistryState => {
  const state = typeof registry === "object" && registry !== null ? routeRegistryStates.get(registry) : undefined;
  if (state === undefined) throw new TypeError("Runtime route registry provenance is invalid.");
  return state;
};

const createRegistry = (state: RouteRegistryState): RuntimeRouteRegistry => {
  const registry = Object.create(RuntimeRouteRegistry.prototype) as RuntimeRouteRegistry;
  routeRegistryStates.set(registry, Object.freeze(state));
  return Object.freeze(registry);
};

export class RuntimeRouteRegistry {
  private constructor() {}

  extend(
    routesInput: readonly RouteDefinition[],
    errorMappings?: InterfaceErrorMappingRegistry,
  ): RuntimeRouteRegistry {
    let routeDefinitions: readonly RouteDefinition[];
    try {
      if (!Array.isArray(routesInput)) throw new TypeError();
      routeDefinitions = Object.freeze([...routesInput]);
    } catch { throw new TypeError("Route registry extension cannot be inspected safely."); }
    if (routeDefinitions.length === 0) throw new TypeError("Route registry extension is empty.");
    const state = routeRegistryState(this);
    const mappings = errorMappings ?? state.errorMappings;
    if (mappings !== state.errorMappings) {
      assertDirectInterfaceErrorMappingRegistryExtension(state.errorMappings, mappings);
    }
    const routes = Object.freeze([
      ...state.routes,
      ...routeDefinitions.map((route) => compile(route, state.requestPolicies, state.resources)),
    ]);
    assertUnambiguousRoutes(routes);
    return createRegistry({
      routes,
      requestPolicies: state.requestPolicies,
      resources: state.resources,
      errorMappings: mappings,
      parent: this,
    });
  }

  extendRequestPolicies(
    extension: RequestPolicyExtension,
    resourceDefinitions: readonly ResourcePathDefinition[],
  ): RuntimeRouteRegistry {
    let resourceInputs: readonly ResourcePathDefinition[];
    try {
      if (!Array.isArray(resourceDefinitions)) throw new TypeError();
      resourceInputs = Object.freeze([...resourceDefinitions]);
    } catch { throw new TypeError("Resource path extension cannot be inspected safely."); }
    if (resourceInputs.length === 0) throw new TypeError("Resource path extension is empty.");
    const state = routeRegistryState(this);
    const requestPolicies = state.requestPolicies.extend(extension);
    assertRequestPolicyRegistryDescendant(state.requestPolicies, requestPolicies);
    const newRequestClasses = requestPolicies.directRequestClasses(state.requestPolicies);
    const newAuthentications = requestPolicies.directAuthentications(state.requestPolicies);
    const resources = [...state.resources];
    const keys = new Set(resources.map(resourceKey));
    const capturedResources: ResourcePathDefinition[] = [];
    for (const input of resourceInputs) {
      const definition = captureResourcePathDefinition(input);
      requestPolicies.get(definition.requestClass);
      const ownedPath = definition.kind === "prefix" ? definition.pathPrefix : definition.pathPattern;
      if (ownedPath === "/api/v1/runtime-identity" || ownedPath.startsWith("/api/v1/internal/control/")) {
        throw new TypeError("A request policy extension cannot replace a fixed runtime resource authority.");
      }
      const key = resourceKey(definition);
      if (keys.has(key)) throw new TypeError("Duplicate resource path authority.");
      keys.add(key);
      capturedResources.push(definition);
    }
    const resourceClasses = [...new Set(capturedResources.map((definition) => definition.requestClass))]
      .sort(compareCodePointSequences);
    if (newRequestClasses.some((requestClass) => !resourceClasses.includes(requestClass))) {
      throw new TypeError("Every new request class requires an owned resource.");
    }
    const usedAuthentications = [...new Set(newRequestClasses.map((requestClass) =>
      requestPolicies.get(requestClass).authentication))];
    if (newAuthentications.some((authentication) => !usedAuthentications.includes(authentication))) {
      throw new TypeError("Every new authentication verifier requires a request policy consumer.");
    }
    resources.push(...capturedResources);
    return createRegistry({
      routes: state.routes,
      requestPolicies,
      resources: Object.freeze(resources),
      errorMappings: state.errorMappings,
      parent: this,
    });
  }

  match(method: string | undefined, pathname: string): RouteMatch {
    const state = routeRegistryState(this);
    const pathMatches = state.routes
      .map((route) => ({ route, params: matchSegments(route, pathname) }))
      .filter((candidate): candidate is { route: CompiledRoute; params: Readonly<Record<string, string>> } =>
        candidate.params !== undefined);
    const matched = pathMatches.find((candidate) => candidate.route.method === method);
    if (matched !== undefined) {
      return createRouteMatch(this, {
        status: "matched",
        route: matched.route,
        params: matched.params,
      });
    }
    if (pathMatches.length !== 0) {
      return createRouteMatch(this, {
        status: "method_not_allowed",
        candidates: Object.freeze(pathMatches.map((candidate) => Object.freeze({
          route: candidate.route,
          params: candidate.params,
        }))),
        allow: Object.freeze([...new Set(pathMatches.map((candidate) => candidate.route.method))]
          .sort(compareCodePointSequences)),
      });
    }
    return createRouteMatch(this, { status: "not_found" });
  }

  validateSecurity(
    match: Extract<RouteMatch, { readonly status: "matched" }>,
    input: Omit<RequestSecurityInput, "requestClass" | "acceptsBody" | "params">,
  ): RequestSecurityResult {
    const state = routeRegistryState(this);
    if (routeMatchRegistries.get(match) !== this || !state.routes.includes(match.route)) {
      throw new TypeError("Route match provenance is invalid.");
    }
    return state.requestPolicies.validate({
      ...input,
      params: match.params,
      requestClass: match.route.requestClass,
      acceptsBody: match.route.acceptsBody,
    });
  }

  validateMethodRejection(
    match: Extract<RouteMatch, { readonly status: "method_not_allowed" }>,
    input: Omit<RequestClassSecurityInput, "requestClass" | "params">,
  ): RequestSecurityResult {
    const state = routeRegistryState(this);
    if (routeMatchRegistries.get(match) !== this || match.candidates.length === 0 ||
      match.candidates.some((candidate) => !state.routes.includes(candidate.route))) {
      throw new TypeError("Route match provenance is invalid.");
    }
    const results = match.candidates.map((candidate) => state.requestPolicies.validateClass({
      ...input,
      params: candidate.params,
      requestClass: candidate.route.requestClass,
    }));
    if (results.some((result) => result.ok)) return { ok: true };
    return results[0] as Exclude<RequestSecurityResult, { readonly ok: true }>;
  }

  toProblemDetails(failure: ApplicationFailure): ProblemDetails {
    return toProblemDetails(failure, routeRegistryState(this).errorMappings);
  }

  normalizeResult(route: CompiledRoute, input: unknown): NormalizedRouteResult {
    const state = routeRegistryState(this);
    if (!state.routes.includes(route)) throw new TypeError("Route provenance is invalid.");
    const captured = captureCanonicalJson(input);
    if (typeof captured !== "object" || captured === null || Array.isArray(captured) ||
      typeof captured["ok"] !== "boolean") throw new TypeError("Route result is invalid.");
    const keys = Object.keys(captured).sort(compareCodePointSequences);
    if (captured["ok"] === true) {
      if (route.response === "canonical_json") {
        if (keys.join("\0") !== ["body", "ok"].join("\0") || captured["body"] === undefined) {
          throw new TypeError("Route success result is invalid.");
        }
        return Object.freeze({ ok: true, response: "canonical_json", body: captured["body"] });
      }
      const expectedKeys = captured["setCookie"] === undefined
        ? ["body", "contentType", "ok"]
        : ["body", "contentType", "ok", "setCookie"];
      if (keys.join("\0") !== expectedKeys.join("\0") ||
        typeof captured["body"] !== "string" ||
        !browserContentTypes.includes(captured["contentType"] as BrowserContentType) ||
        Buffer.byteLength(captured["body"]) > route.responseLimitBytes ||
        (captured["setCookie"] !== undefined &&
          (captured["contentType"] !== "text/html; charset=utf-8" ||
            typeof captured["setCookie"] !== "string" || !isSafeSetCookie(captured["setCookie"])))) {
        throw new TypeError("Browser content result is invalid.");
      }
      return Object.freeze({
        ok: true,
        response: "browser_content",
        body: captured["body"],
        contentType: captured["contentType"] as BrowserContentType,
        ...(captured["setCookie"] === undefined ? {} : { setCookie: captured["setCookie"] }),
      });
    }
    if (keys.join("\0") !== ["failure", "ok"].join("\0") || captured["failure"] === undefined) {
      throw new TypeError("Route failure result is invalid.");
    }
    return Object.freeze({
      ok: false,
      problem: toProblemDetails(captured["failure"] as unknown as ApplicationFailure, state.errorMappings),
    });
  }
}

export const createRuntimeRouteRegistry = (input: {
  readonly controlVerifier: ControlCredentialVerifier;
  readonly errorMappings?: InterfaceErrorMappingRegistry;
}): RuntimeRouteRegistry => createRegistry({
  routes: Object.freeze([]),
  requestPolicies: createInitialRequestPolicyRegistry(input.controlVerifier),
  resources: Object.freeze([
    Object.freeze({ kind: "prefix", pathPrefix: "/api/v1/internal/control/", requestClass: "local_control" }),
    Object.freeze({ kind: "prefix", pathPrefix: "/api/v1/", requestClass: "public_read" }),
  ]),
  errorMappings: input.errorMappings ?? runtimeInterfaceErrorMappings,
});

export const assertRuntimeRouteRegistryDescendant = (
  ancestor: RuntimeRouteRegistry,
  candidate: RuntimeRouteRegistry,
): void => {
  routeRegistryState(ancestor);
  let current: RuntimeRouteRegistry | undefined = candidate;
  while (current !== undefined && current !== ancestor) current = routeRegistryState(current).parent;
  if (current !== ancestor) throw new TypeError("Runtime route registry ancestry is invalid.");
};
