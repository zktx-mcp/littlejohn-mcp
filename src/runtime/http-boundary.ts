export const fixedHost = "127.0.0.1";
export const fixedPort = 46630;
export const fixedOrigin = `http://${fixedHost}:${fixedPort}`;
export const fixedHostHeader = `${fixedHost}:${fixedPort}`;

export const requestBodyLimitBytes = 65_536;
export const internalResponseLimitBytes = 65_536;
export const publicReadResponseLimitBytes = 8 * 1024 * 1024;
export const jsonContentType = "application/json";
export const problemJsonContentType = "application/problem+json";
export const noStoreCacheControl = "no-store";
export const browserContentSecurityPolicy =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
export const browserContentTypeOptions = "nosniff";
export const browserReferrerPolicy = "no-referrer";
export const browserCrossOriginOpenerPolicy = "same-origin";
export const browserSetCookieLimitBytes = 4_096;

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
