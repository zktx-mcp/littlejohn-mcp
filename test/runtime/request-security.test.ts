import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createControlCredentialVerifier,
  loadOrCreateControlCredential,
} from "../../src/runtime/control-credential.js";
import {
  createRuntimeRouteRegistry,
  type RouteDefinition,
} from "../../src/runtime/http-routing.js";
import {
  validateRequestEnvelopeSecurity,
  validateRequestSecurity,
  type RequestSecurityInput,
} from "../../src/runtime/request-security.js";
import { runtimePaths } from "../../src/runtime/paths.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const credentialFixture = async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "littlejohn-request-"));
  directories.push(directory);
  const paths = runtimePaths(directory);
  const authority = await loadOrCreateControlCredential(directory, paths.controlCredential);
  const verifier = createControlCredentialVerifier(authority);
  const authorization = `Bearer ${(await readFile(paths.controlCredential, "utf8")).slice(0, -1)}`;
  return { verifier, authorization };
};

const base: RequestSecurityInput = {
  requestClass: "owner_identity",
  host: ["127.0.0.1:46630"],
  origin: [],
  authorization: [],
  contentType: [],
  query: "",
  bodyLength: 0,
  acceptsBody: false,
};

describe("HTTP request-class and route authority", () => {
  it("enforces the exact Host, query, Origin, body, and credential matrix", async () => {
    const { verifier, authorization } = await credentialFixture();
    expect(validateRequestSecurity(base)).toEqual({ ok: true });
    expect(validateRequestSecurity({ ...base, host: [] })).toEqual({ ok: false, code: "invalid_host" });
    expect(validateRequestSecurity({ ...base, host: ["localhost:46630"] })).toEqual({ ok: false, code: "invalid_host" });
    expect(validateRequestSecurity({ ...base, query: "?x=1" })).toEqual({ ok: false, code: "query_not_supported" });
    expect(validateRequestSecurity({ ...base, bodyLength: 1 })).toEqual({ ok: false, code: "payload_too_large" });
    expect(validateRequestSecurity({
      ...base,
      requestClass: "public_read",
      origin: ["https://evil.example"],
    })).toEqual({ ok: false, code: "invalid_origin" });
    expect(validateRequestSecurity({
      ...base,
      requestClass: "native_control",
      authorization: [authorization],
      controlVerifier: verifier,
    })).toEqual({ ok: true });
    expect(validateRequestSecurity({
      ...base,
      requestClass: "native_control",
      authorization: ["Bearer AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
      controlVerifier: verifier,
    })).toEqual({ ok: false, code: "unauthorized" });
    expect(validateRequestSecurity({
      ...base,
      requestClass: "native_control",
      origin: ["http://127.0.0.1:46630"],
      authorization: [authorization],
      controlVerifier: verifier,
    })).toEqual({ ok: false, code: "invalid_origin" });
    expect(validateRequestSecurity({
      ...base,
      requestClass: "public_read",
      acceptsBody: true,
      contentType: [],
    })).toEqual({ ok: false, code: "content_type_unsupported" });
  });

  it("enforces the Host, query, and maximum byte envelope independently of route selection", () => {
    expect(validateRequestEnvelopeSecurity({
      host: ["127.0.0.1:46630"], query: "", bodyLength: 65_536,
    })).toEqual({ ok: true });
    expect(validateRequestEnvelopeSecurity({
      host: ["localhost:46630"], query: "", bodyLength: 0,
    })).toEqual({ ok: false, code: "invalid_host" });
    expect(validateRequestEnvelopeSecurity({
      host: ["127.0.0.1:46630"], query: "?x=1", bodyLength: 0,
    })).toEqual({ ok: false, code: "query_not_supported" });
    expect(validateRequestEnvelopeSecurity({
      host: ["127.0.0.1:46630"], query: "", bodyLength: 65_537,
    })).toEqual({ ok: false, code: "payload_too_large" });
  });

  it("derives request class, body policy, response limit, and success status from method and namespace", async () => {
    const { verifier, authorization } = await credentialFixture();
    const routes = createRuntimeRouteRegistry({ controlVerifier: verifier }).extend([
      {
        method: "GET",
        pathPattern: "/api/v1/internal/cli/items/{itemId}",
        handler: async () => ({ ok: true, body: {} }),
      },
      {
        method: "POST",
        pathPattern: "/api/v1/internal/cli/wallet-connection-attempts",
        handler: async () => ({ ok: true, body: {} }),
      },
      {
        method: "POST",
        pathPattern: "/api/v1/read/contracts/inspect",
        handler: async () => ({ ok: true, body: {} }),
      },
    ]);
    const internal = routes.match("GET", "/api/v1/internal/cli/items/abc");
    expect(internal.status).toBe("matched");
    if (internal.status !== "matched") return;
    expect(internal.route.requestClass).toBe("native_control");
    expect(internal.route.acceptsBody).toBe(false);
    expect(routes.validateSecurity(internal.route, {
      host: ["127.0.0.1:46630"], origin: [], authorization: [authorization], contentType: [], query: "", bodyLength: 0,
    })).toEqual({ ok: true });

    const attempt = routes.match("POST", "/api/v1/internal/cli/wallet-connection-attempts");
    expect(attempt.status).toBe("matched");
    if (attempt.status !== "matched") return;
    expect(attempt.route.successStatus).toBe(201);
    expect(attempt.route.acceptsBody).toBe(true);

    const read = routes.match("POST", "/api/v1/read/contracts/inspect");
    expect(read.status).toBe("matched");
    if (read.status !== "matched") return;
    expect(read.route.requestClass).toBe("public_read");
    expect(read.route.successStatus).toBe(200);
    expect(read.route.responseLimitBytes).toBe(8 * 1024 * 1024);
  });

  it("rejects unknown definition fields, hostile getters, unowned namespaces, and all ambiguous patterns", async () => {
    const { verifier } = await credentialFixture();
    const baseRegistry = createRuntimeRouteRegistry({ controlVerifier: verifier });
    const handler = async () => ({ ok: true as const, body: {} });
    expect(() => baseRegistry.extend([{
      method: "GET",
      pathPattern: "/api/v1/internal/cli/example",
      handler,
      requestClass: "public_read",
    } as unknown as RouteDefinition])).toThrow("fields");
    expect(() => baseRegistry.extend([{
      method: "GET",
      pathPattern: "/foreign/example",
      handler,
    }])).toThrow("namespace");
    const hostile = Object.defineProperty({
      method: "GET",
      pathPattern: "/api/v1/internal/cli/example",
    }, "handler", {
      enumerable: true,
      get(): never { throw new Error("secret-handler-getter"); },
    });
    expect(() => baseRegistry.extend([hostile as RouteDefinition])).toThrow("data properties");

    const fixed = {
      method: "GET" as const,
      pathPattern: "/api/v1/internal/cli/items/fixed",
      handler,
    };
    const parameter = {
      method: "GET" as const,
      pathPattern: "/api/v1/internal/cli/items/{itemId}",
      handler,
    };
    expect(() => baseRegistry.extend([fixed, parameter])).toThrow("intersect");
    expect(() => baseRegistry.extend([parameter, fixed])).toThrow("intersect");
    expect(() => baseRegistry.extend([
      fixed,
      { ...fixed, method: "POST", pathPattern: "/api/v1/internal/cli/items/{itemId}" },
    ])).toThrow("intersect");
    expect(() => baseRegistry.extend([
      parameter,
      { ...parameter, method: "DELETE" },
    ])).not.toThrow();
  });

  it("strictly normalizes handler results without reading getters or accepting extra fields", async () => {
    const { verifier } = await credentialFixture();
    const registry = createRuntimeRouteRegistry({ controlVerifier: verifier }).extend([{
      method: "GET",
      pathPattern: "/api/v1/internal/cli/example",
      handler: async () => ({ ok: true, body: {} }),
    }]);
    const match = registry.match("GET", "/api/v1/internal/cli/example");
    expect(match.status).toBe("matched");
    if (match.status !== "matched") return;
    expect(registry.normalizeResult(match.route, { ok: true, body: { value: "ok" } }))
      .toEqual({ ok: true, body: { value: "ok" } });
    expect(() => registry.normalizeResult(match.route, { ok: true, body: {}, extra: true })).toThrow("invalid");
    expect(() => registry.normalizeResult(match.route, Object.defineProperty({ body: {} }, "ok", {
      enumerable: true,
      get(): never { throw new Error("secret-result-getter"); },
    }))).toThrow();
  });
});
