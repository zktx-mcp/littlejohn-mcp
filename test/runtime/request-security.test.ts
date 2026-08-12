import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { maximumSuccessUtf8Bytes } from "../../src/core/index.js";
import {
  fixedHostHeader,
  jsonContentType,
  publicReadResponseLimitBytes,
  requestBodyLimitBytes,
} from "../../src/runtime/http-boundary.js";
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

describe("fixed loopback HTTP authority", () => {
  it("derives the public response frame from the canonical success limit", () => {
    expect(publicReadResponseLimitBytes).toBe(maximumSuccessUtf8Bytes + 1);
    expect(validateRequestEnvelopeSecurity({
      host: [fixedHostHeader],
      bodyLength: requestBodyLimitBytes,
    })).toEqual({ ok: true });
    expect(validateRequestEnvelopeSecurity({
      host: [fixedHostHeader],
      bodyLength: requestBodyLimitBytes + 1,
    })).toEqual({ ok: false, code: "payload_too_large" });
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
        pathPattern: "/api/v1/contract-inspections",
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

    const publicRead = routes.match("POST", "/api/v1/contract-inspections");
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
});
