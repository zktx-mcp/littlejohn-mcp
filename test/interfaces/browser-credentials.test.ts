import { describe, expect, it, vi } from "vitest";

import {
  browserOperationResourcePath,
} from "../../src/interfaces/browser-contract.js";
import {
  browserOperationCookieName,
  createBrowserRequestCredentialAuthority,
} from "../../src/interfaces/browser-credentials.js";
import type { RequestAuthenticationInput } from "../../src/runtime/index.js";

const operationId = Buffer.alloc(32, 7).toString("base64url");
const foreignOperationId = Buffer.alloc(32, 8).toString("base64url");
const expiry = "2026-07-15T03:00:00.000Z";
const issuedAt = Date.parse("2026-07-15T02:00:00.000Z");

const cookiePair = (setCookie: string): string => setCookie.split(";", 1)[0] as string;

const authenticationInput = (
  id: string,
  cookie: string,
  csrfToken: readonly string[] = [],
): RequestAuthenticationInput => Object.freeze({
  authorization: Object.freeze([]),
  cookie: Object.freeze([cookie]),
  csrfToken: Object.freeze([...csrfToken]),
  params: Object.freeze({ operationId: id }),
});

describe("browser operation credential authority", () => {
  it("binds independent credentials and CSRF tokens to one operation and exact expiry", () => {
    let entropy = 0;
    const authority = createBrowserRequestCredentialAuthority({
      now: () => issuedAt,
      randomBytes: (size) => Buffer.alloc(size, ++entropy),
    });
    const issue = authority.issue(operationId, expiry, "interactive");
    const cookie = cookiePair(issue.setCookie);
    const readVerifier = authority.requestPolicyExtension.authenticationVerifiers
      .find((entry) => entry.authentication === "browser_request")?.verify;
    const controlVerifier = authority.requestPolicyExtension.authenticationVerifiers
      .find((entry) => entry.authentication === "browser_request_csrf")?.verify;

    expect(readVerifier).toBeTypeOf("function");
    expect(controlVerifier).toBeTypeOf("function");
    expect(issue.csrfToken).not.toBe(cookie.split("=")[1]);
    expect(issue.setCookie).toBe(
      `${browserOperationCookieName}=${cookie.split("=")[1]}; ` +
      `Path=${browserOperationResourcePath(operationId)}; HttpOnly; SameSite=Strict; Max-Age=3600`,
    );
    expect(issue.setCookie).not.toContain("Domain=");
    expect(issue.setCookie).not.toContain("Secure");
    expect(readVerifier?.(authenticationInput(operationId, cookie))).toBe(true);
    expect(controlVerifier?.(authenticationInput(operationId, cookie, [issue.csrfToken]))).toBe(true);
    expect(readVerifier?.(authenticationInput(foreignOperationId, cookie))).toBe(false);
    expect(controlVerifier?.(authenticationInput(operationId, cookie, []))).toBe(false);
    expect(controlVerifier?.(authenticationInput(operationId, cookie, [Buffer.alloc(32, 9).toString("base64url")]))).toBe(false);
    expect(controlVerifier?.({
      ...authenticationInput(operationId, cookie, [issue.csrfToken]),
      authorization: ["Bearer forbidden"],
    })).toBe(false);
  });

  it("invalidates a replaced credential, rejects malformed cookies, expires records, and closes cleanly", () => {
    let now = issuedAt;
    let entropy = 10;
    const authority = createBrowserRequestCredentialAuthority({
      now: () => now,
      randomBytes: (size) => Buffer.alloc(size, ++entropy),
    });
    const first = authority.issue(operationId, expiry, "interactive");
    const firstCookie = cookiePair(first.setCookie);
    const second = authority.issue(operationId, expiry, "interactive");
    const secondCookie = cookiePair(second.setCookie);
    const readVerifier = authority.requestPolicyExtension.authenticationVerifiers
      .find((entry) => entry.authentication === "browser_request")?.verify;

    expect(readVerifier?.(authenticationInput(operationId, firstCookie))).toBe(false);
    expect(readVerifier?.(authenticationInput(operationId, secondCookie))).toBe(true);
    expect(readVerifier?.({
      ...authenticationInput(operationId, secondCookie),
      cookie: [`${secondCookie}; ${browserOperationCookieName}=duplicate`],
    })).toBe(false);
    expect(readVerifier?.({
      ...authenticationInput(operationId, secondCookie),
      params: Object.freeze({ operationId, extra: "forbidden" }),
    })).toBe(false);

    now = Date.parse(expiry);
    expect(readVerifier?.(authenticationInput(operationId, secondCookie))).toBe(false);
    expect(() => authority.issue(operationId, expiry, "interactive"))
      .toThrow("Browser credential expiry is invalid.");

    authority.close();
    authority.close();
    expect(readVerifier?.(authenticationInput(operationId, secondCookie))).toBe(false);
    expect(() => authority.issue(operationId, "2026-07-15T04:00:00.000Z", "interactive"))
      .toThrow("Browser credential authority is closed.");
  });

  it("allows a read-only presentation to read but never to use browser control", () => {
    let entropy = 13;
    const authority = createBrowserRequestCredentialAuthority({
      now: () => issuedAt,
      randomBytes: (size) => Buffer.alloc(size, entropy++),
    });
    const issue = authority.issue(operationId, expiry, "read_only");
    const cookie = cookiePair(issue.setCookie);
    const readVerifier = authority.requestPolicyExtension.authenticationVerifiers
      .find((entry) => entry.authentication === "browser_request")?.verify;
    const controlVerifier = authority.requestPolicyExtension.authenticationVerifiers
      .find((entry) => entry.authentication === "browser_request_csrf")?.verify;

    expect(readVerifier?.(authenticationInput(operationId, cookie))).toBe(true);
    expect(controlVerifier?.(authenticationInput(operationId, cookie, [issue.csrfToken]))).toBe(false);
  });

  it("sweeps and zeroes unrelated expired records before issuing another credential", () => {
    let now = issuedAt;
    let entropy = 20;
    const authority = createBrowserRequestCredentialAuthority({
      now: () => now,
      randomBytes: (size) => Buffer.from(
        Uint8Array.from({ length: size }, () => ++entropy % 255),
      ),
    });
    authority.issue(operationId, expiry, "interactive");

    now = Date.parse(expiry);
    const fill = vi.spyOn(Buffer.prototype, "fill");
    authority.issue(foreignOperationId, "2026-07-15T04:00:00.000Z", "interactive");

    expect(fill.mock.calls).toEqual([[0], [0]]);
    fill.mockRestore();
    authority.close();
  });

  it("rejects presentation access outside the wallet operation contract", () => {
    const authority = createBrowserRequestCredentialAuthority({
      now: () => issuedAt,
      randomBytes: (size) => Buffer.alloc(size, 13),
    });
    expect(() => authority.issue(operationId, expiry, "owner" as never)).toThrow();
  });

  it("declares only the three browser request classes with their distinct authorities", () => {
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
        authentication: "browser_request",
        body: "none",
        responseLimitBytes: 8 * 1024 * 1024,
        mutation: "none",
      },
      {
        requestClass: "browser_control",
        host: "fixed",
        origin: "fixed",
        authentication: "browser_request_csrf",
        body: "route_json",
        responseLimitBytes: 64 * 1024,
        mutation: "declared_control",
      },
    ]);
  });
});
