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
  internalResponseLimitBytes,
  publicReadResponseLimitBytes,
} from "./http-boundary.js";
import {
  validateRequestClassSecurity,
  validateRequestSecurity,
  type RequestClass,
  type RequestClassSecurityInput,
  type RequestSecurityResult,
} from "./request-security.js";

export type RouteMethod = "GET" | "POST" | "DELETE";

export interface RouteContext {
  readonly params: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly signal: AbortSignal;
}

export type RouteResult =
  | { readonly ok: true; readonly body: CanonicalJson }
  | { readonly ok: false; readonly failure: ApplicationFailure };

export interface RouteDefinition {
  readonly method: RouteMethod;
  readonly pathPattern: string;
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
      ["handler", "method", "pathPattern"].join("\0")) {
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
    typeof values["pathPattern"] !== "string" || typeof values["handler"] !== "function") {
    throw new TypeError("Route definition values are invalid.");
  }
  return Object.freeze({
    method: values["method"] as RouteMethod,
    pathPattern: values["pathPattern"],
    handler: values["handler"] as RouteDefinition["handler"],
  });
};

type RouteSegment =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "parameter"; readonly name: string };

interface CompiledRoute extends RouteDefinition {
  readonly requestClass: Exclude<RequestClass, "owner_identity">;
  readonly acceptsBody: boolean;
  readonly successStatus: 200 | 201;
  readonly responseLimitBytes: number;
  readonly segments: readonly RouteSegment[];
}

const requestClassForPath = (pathPattern: string): Exclude<RequestClass, "owner_identity"> => {
  if (pathPattern.startsWith("/api/v1/internal/cli/")) return "native_control";
  if (pathPattern.startsWith("/api/v1/read/") || pathPattern === "/api/v1/wallet/connection") {
    return "public_read";
  }
  throw new TypeError("Route path is outside an owned request-class namespace.");
};

const compile = (definition: RouteDefinition): CompiledRoute => {
  const captured = captureRouteDefinition(definition);
  if (!captured.pathPattern.startsWith("/") || captured.pathPattern.includes("//") ||
    captured.pathPattern.endsWith("/")) {
    throw new TypeError("Route path pattern is invalid.");
  }
  const parameterNames = new Set<string>();
  const segments = captured.pathPattern.slice(1).split("/").map((segment) => {
    const parameter = /^\{([a-z][a-zA-Z0-9]*)\}$/.exec(segment);
    if (parameter !== null) {
      const name = parameter[1] as string;
      if (parameterNames.has(name)) throw new TypeError("Route parameter is duplicated.");
      parameterNames.add(name);
      return { kind: "parameter" as const, name };
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(segment)) throw new TypeError("Route literal is invalid.");
    return { kind: "literal" as const, value: segment };
  });
  const requestClass = requestClassForPath(captured.pathPattern);
  const acceptsBody = captured.method === "POST";
  const successStatus = captured.method === "POST" &&
    captured.pathPattern === "/api/v1/internal/cli/wallet-connection-attempts" ? 201 : 200;
  return Object.freeze({
    ...captured,
    requestClass,
    acceptsBody,
    successStatus,
    responseLimitBytes: requestClass === "public_read" ? publicReadResponseLimitBytes : internalResponseLimitBytes,
    segments: Object.freeze(segments),
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
  | { readonly status: "method_not_allowed"; readonly route: CompiledRoute; readonly allow: readonly RouteMethod[] }
  | { readonly status: "not_found" };

export type NormalizedRouteResult =
  | { readonly ok: true; readonly body: CanonicalJson }
  | { readonly ok: false; readonly problem: ProblemDetails };

interface RouteRegistryState {
  readonly routes: readonly CompiledRoute[];
  readonly controlVerifier: ControlCredentialVerifier;
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
    if (routesInput.length === 0) throw new TypeError("Route registry extension is empty.");
    const state = routeRegistryState(this);
    const mappings = errorMappings ?? state.errorMappings;
    if (mappings !== state.errorMappings) {
      assertDirectInterfaceErrorMappingRegistryExtension(state.errorMappings, mappings);
    }
    const routes = Object.freeze([...state.routes, ...routesInput.map(compile)]);
    assertUnambiguousRoutes(routes);
    return createRegistry({ routes, controlVerifier: state.controlVerifier, errorMappings: mappings, parent: this });
  }

  match(method: string | undefined, pathname: string): RouteMatch {
    const state = routeRegistryState(this);
    const pathMatches = state.routes
      .map((route) => ({ route, params: matchSegments(route, pathname) }))
      .filter((candidate): candidate is { route: CompiledRoute; params: Readonly<Record<string, string>> } =>
        candidate.params !== undefined);
    const matched = pathMatches.find((candidate) => candidate.route.method === method);
    if (matched !== undefined) return { status: "matched", route: matched.route, params: matched.params };
    if (pathMatches.length !== 0) {
      const route = pathMatches[0]?.route;
      if (route === undefined || pathMatches.some((candidate) => candidate.route.requestClass !== route.requestClass)) {
        throw new TypeError("Matched route request-class authority is inconsistent.");
      }
      return {
        status: "method_not_allowed",
        route,
        allow: Object.freeze([...new Set(pathMatches.map((candidate) => candidate.route.method))]
          .sort(compareCodePointSequences)),
      };
    }
    return { status: "not_found" };
  }

  validateSecurity(
    route: CompiledRoute,
    input: Omit<Parameters<typeof validateRequestSecurity>[0], "requestClass" | "acceptsBody" | "controlVerifier">,
  ): RequestSecurityResult {
    const state = routeRegistryState(this);
    if (!state.routes.includes(route)) throw new TypeError("Route provenance is invalid.");
    return validateRequestSecurity({
      ...input,
      requestClass: route.requestClass,
      acceptsBody: route.acceptsBody,
      ...(route.requestClass === "native_control" ? { controlVerifier: state.controlVerifier } : {}),
    });
  }

  validateRequestClass(
    route: CompiledRoute,
    input: Omit<RequestClassSecurityInput, "requestClass" | "controlVerifier">,
  ): RequestSecurityResult {
    const state = routeRegistryState(this);
    if (!state.routes.includes(route)) throw new TypeError("Route provenance is invalid.");
    return validateRequestClassSecurity({
      ...input,
      requestClass: route.requestClass,
      ...(route.requestClass === "native_control" ? { controlVerifier: state.controlVerifier } : {}),
    });
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
      problem: toProblemDetails(captured["failure"] as unknown as ApplicationFailure, state.errorMappings),
    });
  }
}

export const createRuntimeRouteRegistry = (input: {
  readonly controlVerifier: ControlCredentialVerifier;
  readonly errorMappings?: InterfaceErrorMappingRegistry;
}): RuntimeRouteRegistry => createRegistry({
  routes: Object.freeze([]),
  controlVerifier: input.controlVerifier,
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
