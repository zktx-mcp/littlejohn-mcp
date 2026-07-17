import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import { canonicalBase64UrlSchema } from "../core/index.js";
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
  browserCsrfTokenByteLength,
  browserWalletApiRoot,
  parseBrowserCsrfToken,
} from "./browser-contract.js";

export const browserSessionCookieName = "littlejohn_browser_session";
export const browserSessionLifetimeSeconds = 60 * 60;

const browserSessionSecretByteLength = 32;
const browserSessionNonceByteLength = 32;
const browserSessionExpiryByteLength = 8;
const browserSessionMacByteLength = 32;
const browserSessionCredentialByteLength =
  browserSessionExpiryByteLength +
  browserSessionNonceByteLength +
  browserSessionMacByteLength;
const browserSessionCredentialSchema =
  canonicalBase64UrlSchema(browserSessionCredentialByteLength);

export interface BrowserCredentialIssue {
  readonly csrfToken: string;
  readonly setCookie: string;
}

export interface BrowserRequestCredentialAuthority {
  readonly requestPolicyExtension: RequestPolicyExtension;
  issue(): BrowserCredentialIssue;
  close(): void;
}

export interface BrowserCredentialAuthorityOptions {
  readonly now?: () => number;
  readonly randomBytes?: (size: number) => Buffer;
}

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
    if (
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
      !/^[!#$%&'()*+\-./:<=>?@\[\]^_`{|}~0-9A-Za-z]+$/.test(value) ||
      cookies.has(name)
    ) return undefined;
    cookies.set(name, value);
  }
  return cookies;
};

const equalBytes = (left: Buffer, right: Buffer): boolean =>
  left.byteLength === right.byteLength && timingSafeEqual(left, right);

const expiryBytes = (expiresAtSeconds: number): Buffer => {
  if (!Number.isSafeInteger(expiresAtSeconds) || expiresAtSeconds <= 0) {
    throw new TypeError("Browser session expiry is invalid.");
  }
  const encoded = Buffer.alloc(browserSessionExpiryByteLength);
  encoded.writeBigUInt64BE(BigInt(expiresAtSeconds));
  return encoded;
};

const browserSessionCredential = (input: unknown): Buffer | undefined => {
  try {
    return Buffer.from(browserSessionCredentialSchema.parse(input), "base64url");
  } catch {
    return undefined;
  }
};

export const createBrowserRequestCredentialAuthority = (
  options: BrowserCredentialAuthorityOptions = {},
): BrowserRequestCredentialAuthority => {
  const now = options.now ?? Date.now;
  const random = options.randomBytes ?? randomBytes;
  const secret = random(browserSessionSecretByteLength);
  if (secret.byteLength !== browserSessionSecretByteLength) {
    throw new TypeError("Browser credential entropy source is invalid.");
  }
  let closed = false;
  let lastObservedMilliseconds: number | undefined;
  let active: {
    readonly credential: Buffer;
    readonly csrfToken: Buffer;
    readonly expiresAtSeconds: number;
  } | undefined;

  const currentSeconds = (): number => {
    const currentMilliseconds = now();
    if (
      !Number.isSafeInteger(currentMilliseconds) ||
      currentMilliseconds < 0 ||
      (lastObservedMilliseconds !== undefined &&
        currentMilliseconds < lastObservedMilliseconds)
    ) throw new TypeError("Browser session clock is invalid.");
    lastObservedMilliseconds = currentMilliseconds;
    return Math.floor(currentMilliseconds / 1_000);
  };

  const clearActive = (): void => {
    if (active === undefined) return;
    active.credential.fill(0);
    active.csrfToken.fill(0);
    active = undefined;
  };

  const sign = (purpose: "cookie" | "csrf", payload: Buffer): Buffer =>
    createHmac("sha256", secret)
      .update(`littlejohn-browser-${purpose}\0`, "ascii")
      .update(payload)
      .digest();

  const verify = (input: RequestAuthenticationInput, requiresCsrf: boolean): boolean => {
    if (closed || input.authorization.length !== 0) return false;
    const cookies = parseCookieHeader(input.cookie);
    if (cookies === undefined) return false;
    const credential = browserSessionCredential(cookies.get(browserSessionCookieName));
    if (credential === undefined) return false;

    const payload = credential.subarray(
      0,
      browserSessionExpiryByteLength + browserSessionNonceByteLength,
    );
    const suppliedMac = credential.subarray(payload.byteLength);
    if (!equalBytes(sign("cookie", payload), suppliedMac)) return false;

    let observedSeconds: number;
    try { observedSeconds = currentSeconds(); }
    catch { return false; }
    const expiresAtSeconds = Number(payload.readBigUInt64BE(0));
    if (
      !Number.isSafeInteger(expiresAtSeconds) ||
      expiresAtSeconds <= observedSeconds ||
      expiresAtSeconds > observedSeconds + browserSessionLifetimeSeconds
    ) return false;

    if (!requiresCsrf) return input.csrfToken.length === 0;
    if (input.csrfToken.length !== 1) return false;
    let suppliedCsrf: Buffer;
    try {
      suppliedCsrf = Buffer.from(parseBrowserCsrfToken(input.csrfToken[0]), "base64url");
    } catch {
      return false;
    }
    return equalBytes(sign("csrf", payload), suppliedCsrf);
  };

  const authenticationVerifiers = Object.freeze<AuthenticationVerifierDefinition[]>([
    Object.freeze({
      authentication: "browser_session",
      verify: (input: RequestAuthenticationInput) => verify(input, false),
    }),
    Object.freeze({
      authentication: "browser_session_csrf",
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
        authentication: "browser_session",
        body: "none",
        responseLimitBytes: publicReadResponseLimitBytes,
        mutation: "none",
      }),
      Object.freeze({
        requestClass: "browser_control",
        host: "fixed",
        origin: "fixed",
        authentication: "browser_session_csrf",
        body: "route_json",
        responseLimitBytes: internalResponseLimitBytes,
        mutation: "declared_control",
      }),
    ]),
  });

  return Object.freeze({
    requestPolicyExtension,
    issue: (): BrowserCredentialIssue => {
      if (closed) throw new TypeError("Browser credential authority is closed.");
      const observedSeconds = currentSeconds();
      if (active !== undefined && active.expiresAtSeconds <= observedSeconds) {
        clearActive();
      }
      if (active === undefined) {
        const expiresAtSeconds = observedSeconds + browserSessionLifetimeSeconds;
        const nonce = random(browserSessionNonceByteLength);
        if (nonce.byteLength !== browserSessionNonceByteLength) {
          nonce.fill(0);
          throw new TypeError("Browser credential entropy source is invalid.");
        }
        const payload = Buffer.concat([expiryBytes(expiresAtSeconds), nonce]);
        nonce.fill(0);
        const credential = Buffer.concat([payload, sign("cookie", payload)]);
        const csrfToken = sign("csrf", payload);
        payload.fill(0);
        active = Object.freeze({ credential, csrfToken, expiresAtSeconds });
      }
      const credential = active.credential.toString("base64url");
      const csrfToken = active.csrfToken.toString("base64url");
      browserSessionCredentialSchema.parse(credential);
      if (Buffer.from(parseBrowserCsrfToken(csrfToken), "base64url").byteLength !== browserCsrfTokenByteLength) {
        throw new TypeError("Browser CSRF authority is invalid.");
      }
      const remainingSeconds = active.expiresAtSeconds - observedSeconds;
      return Object.freeze({
        csrfToken,
        setCookie: `${browserSessionCookieName}=${credential}; ` +
          `Path=${browserWalletApiRoot}; HttpOnly; SameSite=Strict; ` +
          `Max-Age=${remainingSeconds}`,
      });
    },
    close: (): void => {
      if (closed) return;
      closed = true;
      clearActive();
      secret.fill(0);
    },
  });
};
