import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { parseUtcTimestamp } from "../core/index.js";
import type {
  AuthenticationVerifierDefinition,
  RequestAuthenticationInput,
  RequestPolicyExtension,
} from "../runtime/index.js";
import {
  internalResponseLimitBytes,
  publicReadResponseLimitBytes,
} from "../runtime/index.js";
import {
  parseWalletOperationId,
  parseWalletOperationPresentationAccess,
  type WalletOperationPresentation,
} from "../wallet/contracts.js";
import {
  browserRequestTokenByteLength,
  browserOperationResourcePath,
  parseBrowserRequestToken,
} from "./browser-contract.js";

export const browserOperationCookieName = "littlejohn_wallet_operation";

interface CredentialRecord {
  readonly credentialDigest: Buffer;
  readonly csrfDigest: Buffer;
  readonly expiresAtMilliseconds: number;
  readonly access: WalletOperationPresentation["access"];
}

export interface BrowserCredentialIssue {
  readonly csrfToken: string;
  readonly setCookie: string;
}

export interface BrowserRequestCredentialAuthority {
  readonly requestPolicyExtension: RequestPolicyExtension;
  issue(
    operationId: string,
    expiresAt: string,
    access: WalletOperationPresentation["access"],
  ): BrowserCredentialIssue;
  close(): void;
}

export interface BrowserCredentialAuthorityOptions {
  readonly now?: () => number;
  readonly randomBytes?: (size: number) => Buffer;
}

const digest = (value: string): Buffer => createHash("sha256").update(value, "ascii").digest();
const digestByteLength = digest("").byteLength;

const equalDigest = (left: Buffer, right: Buffer): boolean =>
  left.length === right.length && timingSafeEqual(left, right);

const parseCookieHeader = (values: readonly string[]): ReadonlyMap<string, string> | undefined => {
  if (values.length !== 1) return undefined;
  const header = values[0];
  if (header === undefined || header.length === 0 || header.length > 4_096) return undefined;
  const cookies = new Map<string, string>();
  for (const segment of header.split(";")) {
    const trimmed = segment.trim();
    const separator = trimmed.indexOf("=");
    if (
      separator <= 0 ||
      separator === trimmed.length - 1 ||
      trimmed.indexOf("=", separator + 1) !== -1
    ) return undefined;
    const name = trimmed.slice(0, separator);
    const value = trimmed.slice(separator + 1);
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
      !/^[!#$%&'()*+\-./:<=>?@\[\]^_`{|}~0-9A-Za-z]+$/.test(value) ||
      cookies.has(name)) return undefined;
    cookies.set(name, value);
  }
  return cookies;
};

const captureOperationId = (input: RequestAuthenticationInput): string | undefined => {
  const keys = Object.keys(input.params);
  if (keys.length !== 1 || keys[0] !== "operationId") return undefined;
  try { return parseWalletOperationId(input.params["operationId"]); }
  catch { return undefined; }
};

const canonicalRequestToken = (input: unknown): string | undefined => {
  try { return parseBrowserRequestToken(input); }
  catch { return undefined; }
};

export const createBrowserRequestCredentialAuthority = (
  options: BrowserCredentialAuthorityOptions = {},
): BrowserRequestCredentialAuthority => {
  const now = options.now ?? Date.now;
  const random = options.randomBytes ?? randomBytes;
  const records = new Map<string, CredentialRecord>();
  let closed = false;

  const remove = (operationId: string): void => {
    const record = records.get(operationId);
    if (record === undefined) return;
    records.delete(operationId);
    record.credentialDigest.fill(0);
    record.csrfDigest.fill(0);
  };

  const removeExpired = (currentTime: number): void => {
    for (const [operationId, record] of records) {
      if (currentTime >= record.expiresAtMilliseconds) remove(operationId);
    }
  };

  const verify = (input: RequestAuthenticationInput, requiresCsrf: boolean): boolean => {
    if (closed) return false;
    const currentTime = now();
    removeExpired(currentTime);
    if (input.authorization.length !== 0) return false;
    const operationId = captureOperationId(input);
    const cookies = parseCookieHeader(input.cookie);
    if (operationId === undefined || cookies === undefined) return false;
    const credential = canonicalRequestToken(cookies.get(browserOperationCookieName));
    if (credential === undefined) return false;
    const record = records.get(operationId);
    if (record === undefined) {
      equalDigest(digest(credential), Buffer.alloc(digestByteLength));
      return false;
    }
    if (!equalDigest(digest(credential), record.credentialDigest)) return false;
    if (!requiresCsrf) return input.csrfToken.length === 0;
    if (record.access !== "interactive") return false;
    if (input.csrfToken.length !== 1) return false;
    const csrfToken = canonicalRequestToken(input.csrfToken[0]);
    return csrfToken !== undefined &&
      equalDigest(digest(csrfToken), record.csrfDigest);
  };

  const authenticationVerifiers = Object.freeze<AuthenticationVerifierDefinition[]>([
    Object.freeze({
      authentication: "browser_request",
      verify: (input: RequestAuthenticationInput) => verify(input, false),
    }),
    Object.freeze({
      authentication: "browser_request_csrf",
      verify: (input: RequestAuthenticationInput) => verify(input, true),
    }),
  ]);

  const requestPolicyExtension: RequestPolicyExtension = Object.freeze({
    authenticationVerifiers,
    policies: Object.freeze([
      Object.freeze({
        requestClass: "browser_bootstrap",
        host: "fixed",
        origin: "absent",
        authentication: "none",
        body: "none",
        responseLimitBytes: publicReadResponseLimitBytes,
        mutation: "none",
      }),
      Object.freeze({
        requestClass: "browser_read",
        host: "fixed",
        origin: "absent_or_fixed",
        authentication: "browser_request",
        body: "none",
        responseLimitBytes: publicReadResponseLimitBytes,
        mutation: "none",
      }),
      Object.freeze({
        requestClass: "browser_control",
        host: "fixed",
        origin: "fixed",
        authentication: "browser_request_csrf",
        body: "route_json",
        responseLimitBytes: internalResponseLimitBytes,
        mutation: "declared_control",
      }),
    ]),
  });

  return Object.freeze({
    requestPolicyExtension,
    issue: (
      operationIdInput: string,
      expiresAtInput: string,
      access: WalletOperationPresentation["access"],
    ): BrowserCredentialIssue => {
      if (closed) throw new TypeError("Browser credential authority is closed.");
      const currentTime = now();
      removeExpired(currentTime);
      const operationId = parseWalletOperationId(operationIdInput);
      const canonicalAccess = parseWalletOperationPresentationAccess(access);
      const expiresAt = parseUtcTimestamp(expiresAtInput);
      const expiresAtMilliseconds = Date.parse(expiresAt);
      const remainingSeconds = Math.floor((expiresAtMilliseconds - currentTime) / 1_000);
      if (!Number.isSafeInteger(remainingSeconds) || remainingSeconds <= 0) {
        throw new TypeError("Browser credential expiry is invalid.");
      }
      const credential = random(browserRequestTokenByteLength).toString("base64url");
      const csrfToken = random(browserRequestTokenByteLength).toString("base64url");
      if (
        canonicalRequestToken(credential) === undefined ||
        canonicalRequestToken(csrfToken) === undefined ||
        credential === csrfToken
      ) {
        throw new TypeError("Browser credential entropy source is invalid.");
      }
      remove(operationId);
      records.set(operationId, Object.freeze({
        credentialDigest: digest(credential),
        csrfDigest: digest(csrfToken),
        expiresAtMilliseconds,
        access: canonicalAccess,
      }));
      return Object.freeze({
        csrfToken,
        setCookie: `${browserOperationCookieName}=${credential}; ` +
          `Path=${browserOperationResourcePath(operationId)}; HttpOnly; SameSite=Strict; Max-Age=${remainingSeconds}`,
      });
    },
    close: (): void => {
      if (closed) return;
      closed = true;
      for (const operationId of [...records.keys()]) remove(operationId);
    },
  });
};
