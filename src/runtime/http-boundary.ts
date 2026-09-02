import type { CanonicalJson } from "../core/index.js";
import { requestTargetUtf16CodeUnitLimit } from "./http-limits.js";

export const fixedHost = "127.0.0.1";
export const fixedPort = 46630;
export const fixedOrigin = `http://${fixedHost}:${fixedPort}`;
export const fixedHostHeader = `${fixedHost}:${fixedPort}`;

export const jsonContentType = "application/json";
export const problemJsonContentType = "application/problem+json";
export const noStoreCacheControl = "no-store";
export const runtimeIdentityPath = "/api/v1/runtime-identity";
export const publicApiPathPrefix = "/api/v1/";
export const internalApiPathPrefix = "/api/v1/internal/";
export const localControlApiPathPrefix = "/api/v1/internal/control/";
export const routeMethods = Object.freeze(["GET", "POST", "DELETE"] as const);
export type RouteMethod = typeof routeMethods[number];

export type RuntimeHttpRequest =
  | Readonly<{
      method: "POST";
      path: string;
      body: CanonicalJson;
    }>
  | Readonly<{
      method: "GET" | "DELETE";
      path: string;
      body?: never;
    }>;

export const routeMutationClasses = Object.freeze(["none", "declared_control"] as const);
export type RouteMutation = typeof routeMutationClasses[number];

export const routeSuccessStatuses = Object.freeze([200, 201] as const);
export type RouteSuccessStatus = typeof routeSuccessStatuses[number];

export interface RequestTarget {
  readonly pathname: string;
  readonly query: string;
}

export const parseRequestTarget = (value: string | undefined): RequestTarget | undefined => {
  if (
    value === undefined ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("#") ||
    value.includes("\r") ||
    value.includes("\n") ||
    value.length > requestTargetUtf16CodeUnitLimit
  ) return undefined;
  const queryIndex = value.indexOf("?");
  const pathname = queryIndex === -1 ? value : value.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : value.slice(queryIndex);
  if (pathname.length === 0) return undefined;
  return Object.freeze({ pathname, query });
};
