import { maximumSuccessUtf8Bytes } from "../core/index.js";

export const fixedHost = "127.0.0.1";
export const fixedPort = 46630;
export const fixedOrigin = `http://${fixedHost}:${fixedPort}`;
export const fixedHostHeader = `${fixedHost}:${fixedPort}`;

export const requestBodyLimitBytes = 65_536;
export const internalResponseLimitBytes = 65_536;
export const publicReadResponseLimitBytes = maximumSuccessUtf8Bytes + 1;
export const jsonContentType = "application/json";
export const problemJsonContentType = "application/problem+json";
export const noStoreCacheControl = "no-store";
export const runtimeIdentityPath = "/api/v1/runtime-identity";
export const publicApiPathPrefix = "/api/v1/";
export const internalApiPathPrefix = "/api/v1/internal/";
export const localControlApiPathPrefix = "/api/v1/internal/control/";
export const browserContentSecurityPolicy =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
export const browserContentTypeOptions = "nosniff";
export const browserReferrerPolicy = "no-referrer";
export const browserCrossOriginOpenerPolicy = "same-origin";
export const browserSetCookieLimitBytes = 4_096;

export const routeMethods = Object.freeze(["GET", "POST", "DELETE"] as const);
export type RouteMethod = typeof routeMethods[number];

export const routeMutationClasses = Object.freeze(["none", "declared_control"] as const);
export type RouteMutation = typeof routeMutationClasses[number];

export const routeResponseKinds = Object.freeze(["canonical_json", "browser_content"] as const);
export type RouteResponseKind = typeof routeResponseKinds[number];

export const routeSuccessStatuses = Object.freeze([200, 201] as const);
export type RouteSuccessStatus = typeof routeSuccessStatuses[number];

export const browserContentTypes = Object.freeze([
  "text/html; charset=utf-8",
  "text/css; charset=utf-8",
  "text/javascript; charset=utf-8",
  "image/svg+xml",
] as const);

export type BrowserContentType = (typeof browserContentTypes)[number];

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
    value.length > 4_096
  ) return undefined;
  const queryIndex = value.indexOf("?");
  const pathname = queryIndex === -1 ? value : value.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : value.slice(queryIndex);
  if (pathname.length === 0) return undefined;
  return Object.freeze({ pathname, query });
};
