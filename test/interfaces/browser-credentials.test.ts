import { describe, expect, it } from "vitest";

import {
  browserCsrfTokenByteLength,
  browserWalletApiRoot,
} from "../../src/interfaces/browser-contract.js";
import {
  browserSessionCookieName,
  browserSessionLifetimeSeconds,
  createBrowserRequestCredentialAuthority,
} from "../../src/interfaces/browser-credentials.js";
import type { RequestAuthenticationInput } from "../../src/runtime/index.js";

const issuedAt = Date.parse("2026-07-15T02:00:00.000Z");
const operationId = Buffer.alloc(32, 7).toString("base64url");
const foreignOperationId = Buffer.alloc(32, 8).toString("base64url");

const cookiePair = (setCookie: string): string => setCookie.split(";", 1)[0] as string;

const authenticationInput = (
  cookie: string,
  csrfToken: readonly string[] = [],
  params: Readonly<Record<string, string>> = Object.freeze({}),
): RequestAuthenticationInput => Object.freeze({
  authorization: Object.freeze([]),
  cookie: Object.freeze([cookie]),
  csrfToken: Object.freeze([...csrfToken]),
  params,
});

const verifier = (
  authority: ReturnType<typeof createBrowserRequestCredentialAuthority>,
  authentication: "browser_session" | "browser_session_csrf",
) => authority.requestPolicyExtension.authenticationVerifiers
  .find((entry) => entry.authentication === authentication)?.verify;

const tamperBase64Url = (value: string): string => {
  const bytes = Buffer.from(value, "base64url");
  bytes[bytes.length - 1] = (bytes[bytes.length - 1] as number) ^ 1;
  return bytes.toString("base64url");
};

describe("browser session credential authority", () => {
  it("issues one-hour session authority independently from operation identity", () => {
    let entropy = 0;
    const authority = createBrowserRequestCredentialAuthority({
      now: () => issuedAt,
      randomBytes: (size) => Buffer.alloc(size, ++entropy),
    });
    const issue = authority.issue();
    const cookie = cookiePair(issue.setCookie);
    const cookieValue = cookie.split("=")[1] as string;
    const readVerifier = verifier(authority, "browser_session");
    const controlVerifier = verifier(authority, "browser_session_csrf");

    expect(readVerifier).toBeTypeOf("function");
    expect(controlVerifier).toBeTypeOf("function");
    expect(browserSessionLifetimeSeconds).toBe(3_600);
    expect(issue.setCookie).toBe(
      `${browserSessionCookieName}=${cookieValue}; ` +
      `Path=${browserWalletApiRoot}; HttpOnly; SameSite=Strict; ` +
      `Max-Age=${browserSessionLifetimeSeconds}`,
    );
    expect(issue.setCookie).not.toContain("Domain=");
    expect(issue.setCookie).not.toContain("Secure");
    expect(cookieValue).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(issue.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(Buffer.from(issue.csrfToken, "base64url")).toHaveLength(browserCsrfTokenByteLength);
    const credentialBytes = Buffer.from(cookieValue, "base64url");
    const cookieMac = credentialBytes.subarray(
      credentialBytes.byteLength - browserCsrfTokenByteLength,
    );
    expect(cookieMac.equals(Buffer.from(issue.csrfToken, "base64url"))).toBe(false);

    expect(readVerifier?.(authenticationInput(
      cookie,
      [],
      Object.freeze({ operationId }),
    ))).toBe(true);
    expect(readVerifier?.(authenticationInput(
      cookie,
      [],
      Object.freeze({ operationId: foreignOperationId }),
    ))).toBe(true);
    expect(readVerifier?.(authenticationInput(cookie))).toBe(true);
    expect(controlVerifier?.(authenticationInput(
      cookie,
      [issue.csrfToken],
      Object.freeze({ operationId }),
    ))).toBe(true);

    expect(readVerifier?.(authenticationInput(cookie, [issue.csrfToken]))).toBe(false);
    expect(controlVerifier?.(authenticationInput(cookie))).toBe(false);
    expect(controlVerifier?.(authenticationInput(
      cookie,
      [Buffer.alloc(browserCsrfTokenByteLength, 9).toString("base64url")],
    ))).toBe(false);
    expect(controlVerifier?.({
      ...authenticationInput(cookie, [issue.csrfToken]),
      authorization: ["Bearer forbidden"],
    })).toBe(false);

    authority.close();
  });

  it("reuses one cookie and CSRF pair across bootstrap requests", () => {
    let now = issuedAt;
    let entropy = 10;
    const authority = createBrowserRequestCredentialAuthority({
      now: () => now,
      randomBytes: (size) => Buffer.alloc(size, ++entropy),
    });
    const first = authority.issue();
    const second = authority.issue();
    const firstCookie = cookiePair(first.setCookie);
    const secondCookie = cookiePair(second.setCookie);
    const readVerifier = verifier(authority, "browser_session");
    const controlVerifier = verifier(authority, "browser_session_csrf");

    expect(firstCookie).toBe(secondCookie);
    expect(first.csrfToken).toBe(second.csrfToken);
    expect(readVerifier?.(authenticationInput(firstCookie))).toBe(true);
    expect(readVerifier?.(authenticationInput(secondCookie))).toBe(true);
    expect(controlVerifier?.(authenticationInput(firstCookie, [first.csrfToken]))).toBe(true);
    expect(controlVerifier?.(authenticationInput(secondCookie, [second.csrfToken]))).toBe(true);

    now += 1_500;
    const later = authority.issue();
    expect(cookiePair(later.setCookie)).toBe(firstCookie);
    expect(later.csrfToken).toBe(first.csrfToken);
    expect(later.setCookie).toContain("Max-Age=3599");

    const firstValue = firstCookie.split("=")[1] as string;
    expect(readVerifier?.(authenticationInput(
      `${browserSessionCookieName}=${tamperBase64Url(firstValue)}`,
    ))).toBe(false);
    expect(controlVerifier?.(authenticationInput(
      firstCookie,
      [tamperBase64Url(first.csrfToken)],
    ))).toBe(false);
    expect(readVerifier?.(authenticationInput(
      `${firstCookie}; ${browserSessionCookieName}=duplicate`,
    ))).toBe(false);

    const otherAuthority = createBrowserRequestCredentialAuthority({
      now: () => issuedAt,
      randomBytes: (size) => Buffer.alloc(size, 99),
    });
    expect(verifier(otherAuthority, "browser_session")?.(
      authenticationInput(firstCookie),
    )).toBe(false);

    otherAuthority.close();
    authority.close();
  });

  it("rotates at the encoded deadline and fails closed for clock rollback", () => {
    let now = issuedAt;
    let entropy = 20;
    const authority = createBrowserRequestCredentialAuthority({
      now: () => now,
      randomBytes: (size) => Buffer.alloc(size, ++entropy),
    });
    const issue = authority.issue();
    const cookie = cookiePair(issue.setCookie);
    const readVerifier = verifier(authority, "browser_session");

    now = issuedAt + browserSessionLifetimeSeconds * 1_000 - 1;
    expect(readVerifier?.(authenticationInput(cookie))).toBe(true);
    now = issuedAt + browserSessionLifetimeSeconds * 1_000;
    expect(readVerifier?.(authenticationInput(cookie))).toBe(false);
    const rotated = authority.issue();
    const rotatedCookie = cookiePair(rotated.setCookie);
    expect(rotatedCookie).not.toBe(cookie);
    expect(rotated.csrfToken).not.toBe(issue.csrfToken);
    expect(readVerifier?.(authenticationInput(rotatedCookie))).toBe(true);
    expect(readVerifier?.(authenticationInput(cookie))).toBe(false);
    now = issuedAt - 1_000;
    expect(readVerifier?.(authenticationInput(rotatedCookie))).toBe(false);
    expect(() => authority.issue()).toThrow("Browser session clock is invalid.");

    authority.close();
  });

  it("zeroes its secret on close and rejects every later issue or verification", () => {
    let secret: Buffer | undefined;
    let calls = 0;
    const authority = createBrowserRequestCredentialAuthority({
      now: () => issuedAt,
      randomBytes: (size) => {
        const value = Buffer.alloc(size, ++calls);
        if (calls === 1) secret = value;
        return value;
      },
    });
    const issue = authority.issue();
    const cookie = cookiePair(issue.setCookie);
    const readVerifier = verifier(authority, "browser_session");

    expect(secret).toBeDefined();
    expect(readVerifier?.(authenticationInput(cookie))).toBe(true);
    authority.close();
    authority.close();

    expect([...secret as Buffer].every((value) => value === 0)).toBe(true);
    expect(readVerifier?.(authenticationInput(cookie))).toBe(false);
    expect(() => authority.issue()).toThrow("Browser credential authority is closed.");
  });

  it("rejects invalid entropy and issue-time clocks", () => {
    expect(() => createBrowserRequestCredentialAuthority({
      randomBytes: () => Buffer.alloc(31),
    })).toThrow("Browser credential entropy source is invalid.");

    const invalidNonceAuthority = createBrowserRequestCredentialAuthority({
      now: () => issuedAt,
      randomBytes: (() => {
        let call = 0;
        return (size: number) => Buffer.alloc(call++ === 0 ? size : size - 1);
      })(),
    });
    expect(() => invalidNonceAuthority.issue())
      .toThrow("Browser credential entropy source is invalid.");
    invalidNonceAuthority.close();

    for (const invalidNow of [Number.NaN, -1]) {
      const authority = createBrowserRequestCredentialAuthority({
        now: () => invalidNow,
        randomBytes: (size) => Buffer.alloc(size, 1),
      });
      expect(() => authority.issue()).toThrow("Browser session clock is invalid.");
      authority.close();
    }
  });

  it("declares only the three browser request classes with separate session and CSRF authority", () => {
    const authority = createBrowserRequestCredentialAuthority({
      now: () => issuedAt,
      randomBytes: (size) => Buffer.alloc(size, 12),
    });
    expect(authority.requestPolicyExtension.policies).toEqual([
      {
        requestClass: "browser_bootstrap",
        host: "fixed",
        origin: "absent",
        authentication: "none",
        body: "none",
        responseLimitBytes: 8 * 1024 * 1024,
        mutation: "none",
      },
      {
        requestClass: "browser_read",
        host: "fixed",
        origin: "absent_or_fixed",
        authentication: "browser_session",
        body: "none",
        responseLimitBytes: 8 * 1024 * 1024,
        mutation: "none",
      },
      {
        requestClass: "browser_control",
        host: "fixed",
        origin: "fixed",
        authentication: "browser_session_csrf",
        body: "route_json",
        responseLimitBytes: 64 * 1024,
        mutation: "declared_control",
      },
    ]);
    authority.close();
  });
});
