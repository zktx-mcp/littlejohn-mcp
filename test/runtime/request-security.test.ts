import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { maximumSuccessUtf8Bytes } from "../../src/core/index.js";
import {
  fixedHostHeader,
  jsonContentType,
  parseRequestTarget,
} from "../../src/runtime/http-boundary.js";
import {
  internalResponseLimitBytes,
  ownerContentionDeadlineMilliseconds,
  ownerRetryMinimumDelayMilliseconds,
  ownerRetryDelayGrowth,
  ownerTransportDeadlineMilliseconds,
  publicReadResponseLimitBytes,
  requestBodyLimitBytes,
} from "../../src/runtime/http-limits.js";
import {
  createControlCredentialVerifier,
  loadOrCreateControlCredential,
} from "../../src/runtime/control-credential.js";
import {
  createRuntimeRouteRegistry,
  type RouteDefinition,
} from "../../src/runtime/http-routing.js";
import { runtimePaths } from "../../src/runtime/paths.js";
import {
  localControlRequestClass,
  ownerIdentityRequestClass,
  publicReadRequestClass,
  validateRequestEnvelopeSecurity,
  validateRequestSecurity,
  type RequestSecurityInput,
} from "../../src/runtime/request-security.js";
import { presentationSnapshotLimits } from "../../src/runtime/presentation-snapshot.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

const credentialFixture = async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "littlejohn-request-"));
  directories.push(directory);
  const paths = runtimePaths(directory);
  const authority = await loadOrCreateControlCredential(directory, paths.controlCredential);
  return Object.freeze({
    verifier: createControlCredentialVerifier(authority),
    authorization: `Bearer ${(await readFile(paths.controlCredential, "utf8")).trimEnd()}`,
  });
};

const request = (
  requestClass: string,
  overrides: Partial<RequestSecurityInput> = {},
): RequestSecurityInput => ({
  requestClass,
  host: [fixedHostHeader],
  origin: [],
  authorization: [],
  cookie: [],
  params: Object.freeze({}),
  contentType: [],
  query: "",
  bodyLength: 0,
  acceptsBody: false,
  ...overrides,
});

const success = async () => ({ ok: true as const, body: {} });

const publicPathPatternWithLength = (targetLength: number): string => {
  const segments = ["api", "v1"];
  let length = "/api/v1".length;
  while (length < targetLength) {
    const segmentLength = Math.min(128, targetLength - length - 1);
    if (segmentLength < 1) throw new TypeError("Path-pattern fixture length is invalid.");
    segments.push("a".repeat(segmentLength));
    length += segmentLength + 1;
  }
  const path = `/${segments.join("/")}`;
  if (path.length !== targetLength) throw new TypeError("Path-pattern fixture is inexact.");
  return path;
};

describe("fixed loopback HTTP authority", () => {
  it("derives the public response frame from the canonical success limit", () => {
    expect(maximumSuccessUtf8Bytes).toBe(8_388_607);
    expect(requestBodyLimitBytes).toBe(65_536);
    expect(internalResponseLimitBytes).toBe(65_536);
    expect(publicReadResponseLimitBytes).toBe(8_388_608);
    expect(publicReadResponseLimitBytes).toBe(maximumSuccessUtf8Bytes + 1);
    expect(presentationSnapshotLimits.inputBytes).toBe(requestBodyLimitBytes);
    expect(ownerTransportDeadlineMilliseconds).toBe(2_000);
    expect(ownerContentionDeadlineMilliseconds).toBe(2_000);
    expect(ownerRetryMinimumDelayMilliseconds).toBe(1);
    expect(ownerRetryDelayGrowth).toBe(2);
    expect(validateRequestEnvelopeSecurity({
      host: [fixedHostHeader],
      bodyLength: requestBodyLimitBytes,
    })).toEqual({ ok: true });
    expect(validateRequestEnvelopeSecurity({
      host: [fixedHostHeader],
      bodyLength: requestBodyLimitBytes + 1,
    })).toEqual({ ok: false, code: "payload_too_large" });
  });

  it("admits the exact request target and rejects one code unit more", () => {
    const prefix = "/api/v1/example?";
    const exact = `${prefix}${"x".repeat(4_096 - prefix.length)}`;
    const oversized = `${exact}x`;
    expect(exact.length).toBe(4_096);
    expect(oversized.length).toBe(4_097);
    expect(parseRequestTarget(exact)).toEqual({
      pathname: "/api/v1/example",
      query: exact.slice("/api/v1/example".length),
    });
    expect(parseRequestTarget(oversized)).toBeUndefined();
  });

  it("admits only fixed public, owner-identity, and Bearer-authenticated control requests", async () => {
    const { verifier, authorization } = await credentialFixture();

    expect(validateRequestSecurity(request(ownerIdentityRequestClass))).toEqual({ ok: true });
    expect(validateRequestSecurity(request(publicReadRequestClass))).toEqual({ ok: true });
    expect(validateRequestSecurity({
      ...request(localControlRequestClass),
      authorization: [authorization],
      controlVerifier: verifier,
    })).toEqual({ ok: true });

    const rejected = [
      request(publicReadRequestClass, { host: ["localhost:46630"] }),
      request(publicReadRequestClass, { origin: ["http://127.0.0.1:46630"] }),
      request(publicReadRequestClass, { query: "?current=true" }),
      request(publicReadRequestClass, { cookie: ["browser_session=forbidden"] }),
      request(localControlRequestClass, { authorization: [authorization] }),
      {
        ...request(localControlRequestClass, {
          authorization: [authorization],
          cookie: ["browser_session=forbidden"],
        }),
        controlVerifier: verifier,
      },
      request(publicReadRequestClass, {
        acceptsBody: true,
        bodyLength: 2,
        contentType: [],
      }),
    ] as const;
    expect(rejected.map((candidate) => validateRequestSecurity(candidate))).toEqual([
      { ok: false, code: "invalid_host" },
      { ok: false, code: "invalid_origin" },
      { ok: false, code: "query_not_supported" },
      { ok: false, code: "unauthorized" },
      { ok: false, code: "unauthorized" },
      { ok: false, code: "unauthorized" },
      { ok: false, code: "content_type_unsupported" },
    ]);
    expect(validateRequestSecurity(request(publicReadRequestClass, {
      acceptsBody: true,
      bodyLength: 2,
      contentType: [jsonContentType],
    }))).toEqual({ ok: true });
  });

  it("derives authority only from the fixed public and local-control namespaces", async () => {
    const { verifier, authorization } = await credentialFixture();
    const routes = createRuntimeRouteRegistry({ controlVerifier: verifier }).extend([
      {
        method: "POST",
        mutation: "none",
        pathPattern: "/api/v1/address-inspections",
        successStatus: 200,
        handler: success,
      },
      {
        method: "GET",
        mutation: "none",
        pathPattern: "/api/v1/internal/control/operations/{operationId}",
        successStatus: 200,
        handler: success,
      },
      {
        method: "POST",
        mutation: "declared_control",
        pathPattern: "/api/v1/internal/control/decisions",
        successStatus: 200,
        handler: success,
      },
    ]);

    const publicRead = routes.match("POST", "/api/v1/address-inspections");
    const exactOperation = routes.match("GET", "/api/v1/internal/control/operations/op:1");
    expect(publicRead.status).toBe("matched");
    expect(exactOperation.status).toBe("matched");
    if (publicRead.status !== "matched" || exactOperation.status !== "matched") return;
    expect(publicRead.route.requestClass).toBe(publicReadRequestClass);
    expect(exactOperation.route.requestClass).toBe(localControlRequestClass);
    expect(routes.validateSecurity(exactOperation, {
      host: [fixedHostHeader],
      origin: [],
      authorization: [authorization],
      cookie: [],
      contentType: [],
      query: "",
      bodyLength: 0,
    })).toEqual({ ok: true });

    expect(() => createRuntimeRouteRegistry({ controlVerifier: verifier }).extend([{
      method: "GET",
      mutation: "none",
      pathPattern: "/api/v1/internal/unowned",
      successStatus: 200,
      handler: success,
    }])).toThrow("fixed local-control namespace");
    expect(() => createRuntimeRouteRegistry({ controlVerifier: verifier }).extend([{
      method: "GET",
      mutation: "none",
      pathPattern: "/outside/example",
      successStatus: 200,
      handler: success,
    }])).toThrow("outside the fixed HTTP resources");
  });

  it("rejects ambiguous route ownership and encoded parameter aliases", async () => {
    const { verifier } = await credentialFixture();
    const definition = (pathPattern: string): RouteDefinition => ({
      method: "GET",
      mutation: "none",
      pathPattern,
      successStatus: 200,
      handler: success,
    });
    expect(() => createRuntimeRouteRegistry({ controlVerifier: verifier }).extend([
      definition("/api/v1/items/{itemId}"),
      definition("/api/v1/items/current"),
    ])).toThrow("intersect ambiguously");

    const routes = createRuntimeRouteRegistry({ controlVerifier: verifier })
      .extend([definition("/api/v1/items/{itemId}")]);
    const canonical = routes.match("GET", "/api/v1/items/eip155:4663");
    expect(canonical.status).toBe("matched");
    if (canonical.status === "matched") {
      expect(canonical.params).toEqual({ itemId: "eip155:4663" });
    }
    expect(routes.match("GET", "/api/v1/items/eip155%3A4663").status).toBe("not_found");
  });

  it("closes route definitions over the concrete pathname and segment limits", async () => {
    const { verifier } = await credentialFixture();
    const definition = (pathPattern: string): RouteDefinition => ({
      method: "GET",
      mutation: "none",
      pathPattern,
      successStatus: 200,
      handler: success,
    });
    const exactPathname = publicPathPatternWithLength(2_048);
    const oversizedPathname = publicPathPatternWithLength(2_049);
    const exactPathRoutes = createRuntimeRouteRegistry({ controlVerifier: verifier })
      .extend([definition(exactPathname)]);
    expect(exactPathRoutes.match("GET", exactPathname).status).toBe("matched");
    expect(() => createRuntimeRouteRegistry({ controlVerifier: verifier })
      .extend([definition(oversizedPathname)]))
      .toThrow("cannot fit the pathname limit");

    const exactLiteral = "a".repeat(128);
    const oversizedLiteral = `${exactLiteral}a`;
    const exactLiteralPath = `/api/v1/${exactLiteral}`;
    const exactLiteralRoutes = createRuntimeRouteRegistry({ controlVerifier: verifier })
      .extend([definition(exactLiteralPath)]);
    expect(exactLiteralRoutes.match("GET", exactLiteralPath).status).toBe("matched");
    expect(() => createRuntimeRouteRegistry({ controlVerifier: verifier })
      .extend([definition(`/api/v1/${oversizedLiteral}`)]))
      .toThrow("Route literal is invalid");

    const parameterRoutes = createRuntimeRouteRegistry({ controlVerifier: verifier })
      .extend([definition("/api/v1/items/{itemId}")]);
    expect(parameterRoutes.match("GET", `/api/v1/items/${exactLiteral}`).status).toBe("matched");
    expect(parameterRoutes.match("GET", `/api/v1/items/${oversizedLiteral}`).status)
      .toBe("not_found");

    const longParameterName = `p${"A".repeat(128)}`;
    const longParameterRoutes = createRuntimeRouteRegistry({ controlVerifier: verifier })
      .extend([definition(`/api/v1/items/{${longParameterName}}`)]);
    const longParameterMatch = longParameterRoutes.match("GET", "/api/v1/items/x");
    expect(longParameterMatch.status).toBe("matched");
    if (longParameterMatch.status === "matched") {
      expect(longParameterMatch.params).toEqual({ [longParameterName]: "x" });
    }
  });

  it("rejects an oversized concrete pathname whose parameter segments remain valid", async () => {
    const { verifier } = await credentialFixture();
    const parameterNames = Array.from({ length: 16 }, (_, index) => `p${index}`);
    const pathPattern = `/api/v1/${parameterNames.map((name) => `{${name}}`).join("/")}`;
    const minimumPathname = `/api/v1/${parameterNames.map(() => "a").join("/")}`;
    expect(minimumPathname.length).toBe(39);

    const commonValues = Array.from({ length: 15 }, () => "a".repeat(128));
    const exactValues = [...commonValues, "a".repeat(105)];
    const oversizedValues = [...commonValues, "a".repeat(106)];
    const exactPathname = `/api/v1/${exactValues.join("/")}`;
    const oversizedPathname = `/api/v1/${oversizedValues.join("/")}`;
    expect(exactPathname.length).toBe(2_048);
    expect(oversizedPathname.length).toBe(2_049);
    for (const value of oversizedValues) {
      expect(value).toMatch(/^[A-Za-z0-9._~:-]+$/u);
      expect(value.length).toBeGreaterThanOrEqual(1);
      expect(value.length).toBeLessThanOrEqual(128);
    }

    const routes = createRuntimeRouteRegistry({ controlVerifier: verifier }).extend([{
      method: "GET",
      mutation: "none",
      pathPattern,
      successStatus: 200,
      handler: success,
    }]);
    const exact = routes.match("GET", exactPathname);
    expect(exact.status).toBe("matched");
    if (exact.status === "matched") {
      expect(exact.params).toEqual(Object.fromEntries(
        parameterNames.map((name, index) => [name, exactValues[index]]),
      ));
    }
    expect(routes.match("GET", oversizedPathname).status).toBe("not_found");
  });
});
