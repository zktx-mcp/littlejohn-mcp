import {
  captureCanonicalJson,
  compareCodePointSequences,
  type ApplicationFailure,
  type CanonicalJson,
} from "../core/index.js";
import type { ControlCredentialVerifier } from "./control-credential.js";
import {
  assertInterfaceErrorMappingRegistryDescendant,
  runtimeInterfaceErrorMappings,
  toProblemDetails,
  type InterfaceErrorMappingRegistry,
  type ProblemDetails,
} from "./errors.js";
import {
  createInitialRequestPolicyRegistry,
  localControlRequestClass,
  publicReadRequestClass,
  type RequestPolicyRegistry,
  type RequestClassSecurityInput,
  type RequestSecurityInput,
  type RequestSecurityResult,
} from "./request-security.js";
import {
  internalApiPathPrefix,
  localControlApiPathPrefix,
  publicApiPathPrefix,
  routeMethods,
  routeMutationClasses,
  routeSuccessStatuses,
  runtimeIdentityPath,
  type RouteMethod,
  type RouteMutation,
  type RouteSuccessStatus,
} from "./http-boundary.js";

export type { RouteMethod };

export interface RouteContext {
  readonly params: Readonly<Record<string, string>>;
  readonly query: string;
  readonly body: unknown;
  readonly signal: AbortSignal;
}

export type RouteResult =
  | { readonly ok: true; readonly body: CanonicalJson }
  | { readonly ok: false; readonly failure: ApplicationFailure };

export interface RouteDefinition {
  readonly method: RouteMethod;
  readonly mutation: RouteMutation;
  readonly pathPattern: string;
  readonly successStatus: RouteSuccessStatus;
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
      ["handler", "method", "mutation", "pathPattern", "successStatus"].join("\0")) {
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
  if (!routeMethods.includes(values["method"] as RouteMethod) ||
    !routeMutationClasses.includes(values["mutation"] as RouteMutation) ||
    typeof values["pathPattern"] !== "string" ||
    !routeSuccessStatuses.includes(values["successStatus"] as RouteSuccessStatus) ||
    typeof values["handler"] !== "function") {
    throw new TypeError("Route definition values are invalid.");
  }
  return Object.freeze({
    method: values["method"] as RouteMethod,
    mutation: values["mutation"] as RouteMutation,
    pathPattern: values["pathPattern"],
    successStatus: values["successStatus"] as RouteSuccessStatus,
    handler: values["handler"] as RouteDefinition["handler"],
  });
};

interface CompiledRoute extends RouteDefinition {
  readonly requestClass: string;
  readonly acceptsBody: boolean;
  readonly errorMappings: InterfaceErrorMappingRegistry;
  readonly responseLimitBytes: number;
  readonly segments: readonly RouteSegment[];
}

type RouteSegment =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "parameter"; readonly name: string };

const parseRouteSegments = (pathPattern: string): readonly RouteSegment[] => {
  if (pathPattern === "/") return Object.freeze([]);
  if (!pathPattern.startsWith("/") || pathPattern.includes("//") || pathPattern.endsWith("/") ||
    pathPattern === runtimeIdentityPath) {
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

const requestClassForPath = (pathPattern: string): string => {
  if (pathPattern.startsWith(localControlApiPathPrefix)) return localControlRequestClass;
  if (pathPattern.startsWith(internalApiPathPrefix)) {
    throw new TypeError("Internal routes require the fixed local-control namespace.");
  }
  if (pathPattern.startsWith(publicApiPathPrefix)) return publicReadRequestClass;
  throw new TypeError("Route path is outside the fixed HTTP resources.");
};

const compile = (
  definition: RouteDefinition,
  requestPolicies: RequestPolicyRegistry,
  errorMappings: InterfaceErrorMappingRegistry,
): CompiledRoute => {
  const captured = captureRouteDefinition(definition);
  const segments = parseRouteSegments(captured.pathPattern);
  const requestClass = requestClassForPath(captured.pathPattern);
  const requestPolicy = requestPolicies.get(requestClass);
  if ((captured.method === "POST" && requestPolicy.body === "none") ||
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
    errorMappings,
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
  const actualSegments = pathname === "/" ? [] : pathname.slice(1).split("/");
  if (actualSegments.length !== route.segments.length) return undefined;
  const params: Record<string, string> = Object.create(null) as Record<string, string>;
  for (let index = 0; index < route.segments.length; index += 1) {
    const expected = route.segments[index];
    const actual = actualSegments[index];
    if (expected === undefined || actual === undefined || actual.length === 0 || actual.length > 128 ||
      actual === "." || actual === ".." || !/^[A-Za-z0-9._~:-]+$/.test(actual)) return undefined;
    if (expected.kind === "literal") {
      if (actual !== expected.value) return undefined;
    } else params[expected.name] = actual;
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
  | { readonly ok: true; readonly body: CanonicalJson }
  | { readonly ok: false; readonly problem: ProblemDetails };

interface RouteRegistryState {
  readonly routes: readonly CompiledRoute[];
  readonly requestPolicies: RequestPolicyRegistry;
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
    assertInterfaceErrorMappingRegistryDescendant(
      runtimeInterfaceErrorMappings,
      mappings,
    );
    const routes = Object.freeze([
      ...state.routes,
      ...routeDefinitions.map((route) =>
        compile(route, state.requestPolicies, mappings)),
    ]);
    assertUnambiguousRoutes(routes);
    return createRegistry({
      routes,
      requestPolicies: state.requestPolicies,
      errorMappings: mappings,
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
    input: Omit<
      RequestSecurityInput,
      "requestClass" | "acceptsBody" | "params"
    >,
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
      if (keys.join("\0") !== ["body", "ok"].join("\0") || captured["body"] === undefined) {
        throw new TypeError("Route success result is invalid.");
      }
      return Object.freeze({ ok: true, body: captured["body"] });
    }
    if (keys.join("\0") !== ["failure", "ok"].join("\0") || captured["failure"] === undefined) {
      throw new TypeError("Route failure result is invalid.");
    }
    return Object.freeze({
      ok: false,
      problem: toProblemDetails(
        captured["failure"] as unknown as ApplicationFailure,
        route.errorMappings,
      ),
    });
  }
}

export const createRuntimeRouteRegistry = (input: {
  readonly controlVerifier: ControlCredentialVerifier;
  readonly errorMappings?: InterfaceErrorMappingRegistry;
}): RuntimeRouteRegistry => {
  const errorMappings = input.errorMappings ?? runtimeInterfaceErrorMappings;
  assertInterfaceErrorMappingRegistryDescendant(
    runtimeInterfaceErrorMappings,
    errorMappings,
  );
  return createRegistry({
    routes: Object.freeze([]),
    requestPolicies: createInitialRequestPolicyRegistry(input.controlVerifier),
    errorMappings,
  });
};

export const assertRuntimeRouteRegistryDescendant = (
  ancestor: RuntimeRouteRegistry,
  candidate: RuntimeRouteRegistry,
): void => {
  routeRegistryState(ancestor);
  let current: RuntimeRouteRegistry | undefined = candidate;
  while (current !== undefined && current !== ancestor) current = routeRegistryState(current).parent;
  if (current !== ancestor) throw new TypeError("Runtime route registry ancestry is invalid.");
};
