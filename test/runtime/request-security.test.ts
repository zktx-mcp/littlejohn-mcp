import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createApplicationFailure,
  maximumSuccessUtf8Bytes,
} from "../../src/core/index.js";
import { publicReadResponseLimitBytes } from "../../src/runtime/http-boundary.js";

import {
  createControlCredentialVerifier,
  loadOrCreateControlCredential,
} from "../../src/runtime/control-credential.js";
import {
  runtimeErrorRegistry,
  runtimeInterfaceErrorMappings,
} from "../../src/runtime/errors.js";
import {
  createRuntimeRouteRegistry,
  type RouteDefinition,
} from "../../src/runtime/http-routing.js";
import {
  validateRequestEnvelopeSecurity,
  validateRequestSecurity,
  type RequestPolicyExtension,
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
  cookie: [],
  csrfToken: [],
  params: Object.freeze({}),
  contentType: [],
  query: "",
  bodyLength: 0,
  acceptsBody: false,
};

const success = async () => ({ ok: true as const, body: {} });

describe("HTTP request-class and route authority", () => {
  it("derives the public-read frame from the canonical semantic success budget", () => {
    expect(publicReadResponseLimitBytes).toBe(maximumSuccessUtf8Bytes + 1);
    expect(publicReadResponseLimitBytes).toBe(8_388_608);
  });

  it("accepts only the exact neutral route finite values", async () => {
    const { verifier } = await credentialFixture();
    const registry = createRuntimeRouteRegistry({ controlVerifier: verifier });
    expect(() => registry.extend([
      {
        method: "GET",
        mutation: "none",
        pathPattern: "/api/v1/example",
        response: "canonical_json",
        successStatus: 200,
        handler: success,
      },
      {
        method: "POST",
        mutation: "declared_control",
        pathPattern: "/api/v1/internal/control/example-creations",
        response: "canonical_json",
        successStatus: 201,
        handler: success,
      },
      {
        method: "DELETE",
        mutation: "declared_control",
        pathPattern: "/api/v1/internal/control/example-deletions",
        response: "canonical_json",
        successStatus: 200,
        handler: success,
      },
      {
        method: "GET",
        mutation: "none",
        pathPattern: "/api/v1/browser-example",
        response: "browser_content",
        successStatus: 200,
        handler: success,
      },
    ])).not.toThrow();

    const valid = {
      method: "GET",
      mutation: "none",
      pathPattern: "/api/v1/example",
      response: "canonical_json",
      successStatus: 200,
      handler: success,
    } as const;
    for (const [field, value] of [
      ["method", "PATCH"],
      ["mutation", "implicit"],
      ["response", "arbitrary"],
      ["successStatus", 204],
    ] as const) {
      expect(() => createRuntimeRouteRegistry({ controlVerifier: verifier }).extend([{
        ...valid,
        [field]: value,
      } as unknown as RouteDefinition])).toThrow("values");
    }
  });

  it("keeps sibling product error mappings with the routes that own them", async () => {
    const { verifier } = await credentialFixture();
    const leftErrors = runtimeErrorRegistry.extend([{
      code: "left_product_failure",
      category: "domain",
      message: "The left product failed.",
      retryable: false,
    }]);
    const leftMappings = runtimeInterfaceErrorMappings.extend(leftErrors, [{
      code: "left_product_failure",
      httpStatus: 409,
      problemTitle: "Left product failure",
      cliExitCode: 5,
    }]);
    const rightErrors = runtimeErrorRegistry.extend([{
      code: "right_product_failure",
      category: "domain",
      message: "The right product failed.",
      retryable: false,
    }]);
    const rightMappings = runtimeInterfaceErrorMappings.extend(rightErrors, [{
      code: "right_product_failure",
      httpStatus: 422,
      problemTitle: "Right product failure",
      cliExitCode: 3,
    }]);
    const routes = createRuntimeRouteRegistry({ controlVerifier: verifier })
      .extend([{
        method: "GET",
        mutation: "none",
        pathPattern: "/api/v1/left-product",
        response: "canonical_json",
        successStatus: 200,
        handler: success,
      }], leftMappings)
      .extend([{
        method: "GET",
        mutation: "none",
        pathPattern: "/api/v1/right-product",
        response: "canonical_json",
        successStatus: 200,
        handler: success,
      }], rightMappings);
    const left = routes.match("GET", "/api/v1/left-product");
    const right = routes.match("GET", "/api/v1/right-product");
    if (left.status !== "matched" || right.status !== "matched") {
      throw new TypeError("Expected both sibling product routes.");
    }
    expect(routes.normalizeResult(left.route, {
      ok: false,
      failure: createApplicationFailure(leftErrors, "left_product_failure"),
    })).toMatchObject({ ok: false, problem: { status: 409, code: "left_product_failure" } });
    expect(routes.normalizeResult(right.route, {
      ok: false,
      failure: createApplicationFailure(rightErrors, "right_product_failure"),
    })).toMatchObject({ ok: false, problem: { status: 422, code: "right_product_failure" } });
    expect(() => routes.normalizeResult(left.route, {
      ok: false,
      failure: createApplicationFailure(rightErrors, "right_product_failure"),
    })).toThrow("Unknown application error code.");
  });

  it("enforces the complete initial Host, Origin, authentication, and body policy", async () => {
    const { verifier, authorization } = await credentialFixture();
    expect(validateRequestSecurity(base)).toEqual({ ok: true });
    expect(validateRequestSecurity({ ...base, host: [] })).toEqual({ ok: false, code: "invalid_host" });
    expect(validateRequestSecurity({ ...base, host: ["localhost:46630"] }))
      .toEqual({ ok: false, code: "invalid_host" });
    expect(validateRequestSecurity({ ...base, query: "?x=1" }))
      .toEqual({ ok: false, code: "query_not_supported" });
    expect(validateRequestSecurity({ ...base, bodyLength: 1 }))
      .toEqual({ ok: false, code: "payload_too_large" });
    expect(validateRequestSecurity({ ...base, contentType: ["application/json"] }))
      .toEqual({ ok: false, code: "content_type_unsupported" });
    expect(validateRequestSecurity({
      ...base,
      requestClass: "public_read",
      origin: ["https://evil.example"],
    })).toEqual({ ok: false, code: "invalid_origin" });
    expect(validateRequestSecurity({
      ...base,
      requestClass: "local_control",
      authorization: [authorization],
      controlVerifier: verifier,
    })).toEqual({ ok: true });
    expect(validateRequestSecurity({
      ...base,
      requestClass: "local_control",
      authorization: [authorization],
      cookie: ["browser=forbidden"],
      controlVerifier: verifier,
    })).toEqual({ ok: false, code: "unauthorized" });
    expect(validateRequestSecurity({
      ...base,
      requestClass: "local_control",
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

  it("derives initial request policy and explicit success status from owned resources", async () => {
    const { verifier, authorization } = await credentialFixture();
    const routes = createRuntimeRouteRegistry({ controlVerifier: verifier }).extend([
      {
        method: "GET",
        pathPattern: "/api/v1/internal/control/items/{itemId}",
        mutation: "none" as const,
        response: "canonical_json" as const, successStatus: 200,
        handler: success,
      },
      {
        method: "POST",
        pathPattern: "/api/v1/internal/control/examples",
        mutation: "declared_control" as const,
        response: "canonical_json" as const, successStatus: 201,
        handler: success,
      },
      {
        method: "POST",
        pathPattern: "/api/v1/contract-inspections",
        mutation: "none" as const,
        response: "canonical_json" as const, successStatus: 200,
        handler: success,
      },
    ]);
    const internal = routes.match("GET", "/api/v1/internal/control/items/abc");
    expect(internal.status).toBe("matched");
    if (internal.status !== "matched") return;
    expect(internal.route.requestClass).toBe("local_control");
    expect(internal.route.acceptsBody).toBe(false);
    expect(routes.validateSecurity(internal, {
      host: ["127.0.0.1:46630"], origin: [], authorization: [authorization],
      cookie: [], csrfToken: [], contentType: [], query: "", bodyLength: 0,
    })).toEqual({ ok: true });

    const operation = routes.match("POST", "/api/v1/internal/control/examples");
    expect(operation.status).toBe("matched");
    if (operation.status !== "matched") return;
    expect(operation.route.successStatus).toBe(201);

    const read = routes.match("POST", "/api/v1/contract-inspections");
    expect(read.status).toBe("matched");
    if (read.status !== "matched") return;
    expect(read.route.requestClass).toBe("public_read");
    expect(read.route.successStatus).toBe(200);
    expect(read.route.responseLimitBytes).toBe(8 * 1024 * 1024);
  });

  it("matches one raw canonical CAIP-2 parameter without accepting encoded aliases", async () => {
    const { verifier } = await credentialFixture();
    const routes = createRuntimeRouteRegistry({ controlVerifier: verifier }).extend([{
      method: "GET",
      pathPattern: "/api/v1/internal/control/items/{chainId}",
      mutation: "none" as const,
      response: "canonical_json" as const,
      successStatus: 200,
      handler: success,
    }]);

    const canonical = routes.match("GET", "/api/v1/internal/control/items/eip155:4663");
    expect(canonical.status).toBe("matched");
    if (canonical.status === "matched") {
      expect(canonical.params).toEqual({ chainId: "eip155:4663" });
    }

    for (const alias of [
      "eip155%3A4663",
      "eip155%3a4663",
      "eip155%253A4663",
      "eip155%2F4663",
      ".",
      "..",
    ]) {
      expect(routes.match("GET", `/api/v1/internal/control/items/${alias}`).status)
        .toBe("not_found");
    }
    expect(routes.match("GET", "/api/v1/internal/control/items/eip155:4663/extra").status)
      .toBe("not_found");
  });

  it("extends policy and resource authority only as one complete immutable contract", async () => {
    const { verifier } = await credentialFixture();
    const initial = createRuntimeRouteRegistry({ controlVerifier: verifier });
    const policy = {
      requestClass: "browser_state_change",
      host: "fixed",
      origin: "fixed",
      authentication: "browser_session",
      body: "route_json",
      responseLimitBytes: 65_536,
      mutation: "declared_control",
    } as const;
    const extension = {
      authenticationVerifiers: [{
        authentication: "browser_session",
        verify: (input: {
          cookie: readonly string[];
          csrfToken: readonly string[];
          params: Readonly<Record<string, string>>;
        }) =>
          input.cookie.length === 1 && input.cookie[0] === "browser=session" &&
          input.csrfToken.length === 1 && input.csrfToken[0] === "token" &&
          input.params["operationId"] === "op-1" && Object.isFrozen(input.params) &&
          Object.getPrototypeOf(input.params) === null,
      }],
      policies: [policy],
    };
    const withPolicy = initial.extendRequestPolicies(extension, [
      {
        kind: "route",
        method: "POST",
        pathPattern: "/api/v1/examples/{operationId}/confirmations",
        requestClass: "browser_state_change",
      },
      { kind: "prefix", pathPrefix: "/assets/", requestClass: "public_read" },
    ]);
    const withRoute = withPolicy.extend([
      {
        method: "POST",
        pathPattern: "/api/v1/examples/{operationId}/confirmations",
        mutation: "declared_control" as const,
        response: "canonical_json" as const, successStatus: 200,
        handler: success,
      },
      {
        method: "GET", mutation: "none", pathPattern: "/assets/{assetName}",
        response: "canonical_json" as const, successStatus: 200, handler: success,
      },
    ]);
    expect(initial.match("POST", "/api/v1/examples/op-1/confirmations").status).toBe("not_found");
    const match = withRoute.match("POST", "/api/v1/examples/op-1/confirmations");
    expect(match.status).toBe("matched");
    if (match.status !== "matched") return;
    expect(withRoute.validateSecurity(match, {
      host: ["127.0.0.1:46630"], origin: ["http://127.0.0.1:46630"], authorization: [],
      cookie: ["browser=session"], csrfToken: ["token"], contentType: ["application/json"],
      query: "", bodyLength: 2,
    })).toEqual({ ok: true });
    const foreignOperation = withRoute.match(
      "POST",
      "/api/v1/examples/op-2/confirmations",
    );
    expect(foreignOperation.status).toBe("matched");
    if (foreignOperation.status === "matched") {
      expect(withRoute.validateSecurity(foreignOperation, {
        host: ["127.0.0.1:46630"], origin: ["http://127.0.0.1:46630"], authorization: [],
        cookie: ["browser=session"], csrfToken: ["token"], contentType: ["application/json"],
        query: "", bodyLength: 2,
      })).toEqual({ ok: false, code: "unauthorized" });
      expect(() => withRoute.validateSecurity({
        ...foreignOperation,
        params: Object.freeze(Object.assign(Object.create(null) as Record<string, string>, {
          operationId: "op-1",
        })),
      }, {
        host: ["127.0.0.1:46630"], origin: ["http://127.0.0.1:46630"], authorization: [],
        cookie: ["browser=session"], csrfToken: ["token"], contentType: ["application/json"],
        query: "", bodyLength: 2,
      })).toThrow("provenance");
    }
    expect(withRoute.validateSecurity(match, {
      host: ["127.0.0.1:46630"], origin: ["http://127.0.0.1:46630"], authorization: [],
      cookie: ["browser=session"], csrfToken: [], contentType: ["application/json"],
      query: "", bodyLength: 2,
    })).toEqual({ ok: false, code: "unauthorized" });

    expect(() => initial.extendRequestPolicies({
      authenticationVerifiers: [], policies: [{ requestClass: "partial_class" }],
    } as unknown as RequestPolicyExtension, [{
      kind: "prefix", pathPrefix: "/api/v1/partial/", requestClass: "partial_class",
    }])).toThrow();
    expect(() => initial.extendRequestPolicies({
      authenticationVerifiers: [], policies: [policy],
    }, [{ kind: "prefix", pathPrefix: "/api/v1/duplicate/", requestClass: "browser_state_change" }]))
      .toThrow("Unknown authentication verifier");
    expect(() => withPolicy.extendRequestPolicies({
      authenticationVerifiers: [], policies: [policy],
    }, [{ kind: "prefix", pathPrefix: "/api/v1/duplicate/", requestClass: "browser_state_change" }]))
      .toThrow("Duplicate request class");
    expect(() => initial.extendRequestPolicies({
      authenticationVerifiers: [], policies: [{ ...policy, requestClass: "unknown_auth" }],
    }, [{ kind: "prefix", pathPrefix: "/api/v1/unknown/", requestClass: "unknown_auth" }]))
      .toThrow("Unknown authentication verifier");
    expect(() => initial.extendRequestPolicies(extension, [{
      kind: "route", method: "POST", pathPattern: "/api/v1/examples",
      requestClass: "public_read",
    }])).toThrow("Every new request class requires an owned resource");
    expect(() => initial.extendRequestPolicies({
      authenticationVerifiers: [
        ...extension.authenticationVerifiers,
        { authentication: "unused_authentication", verify: () => true },
      ],
      policies: [policy],
    }, [{
      kind: "route", method: "POST", pathPattern: "/api/v1/examples",
      requestClass: "browser_state_change",
    }])).toThrow("requires a request policy consumer");
    expect(() => initial.extendRequestPolicies(extension, [{
      kind: "route", method: "POST", pathPattern: "/api/v1/internal/control/examples",
      requestClass: "browser_state_change",
    }])).toThrow("cannot replace");
    const hostileResources = new Proxy([], {
      get(target, property, receiver): unknown {
        if (property === Symbol.iterator) throw new Error("secret-resource-iterator");
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    expect(() => initial.extendRequestPolicies(extension, hostileResources))
      .toThrow("cannot be inspected safely");
    expect(() => withPolicy.extend([{
      method: "GET",
      pathPattern: "/api/v1/examples/{operationId}/confirmations",
      mutation: "none" as const,
      response: "canonical_json" as const, successStatus: 200,
      handler: success,
    }])).toThrow("outside the registered resource authority");
    expect(match.route.requestClass).toBe("browser_state_change");
    const asset = withRoute.match("GET", "/assets/app-a1b2c3.js");
    expect(asset.status).toBe("matched");
    if (asset.status === "matched") expect(asset.route.requestClass).toBe("public_read");

    const throwingVerifier = initial.extendRequestPolicies({
      authenticationVerifiers: [{
        authentication: "throwing_authentication",
        verify: (): never => { throw new Error("secret-verifier-payload"); },
      }],
      policies: [{
        requestClass: "throwing_read", host: "fixed", origin: "absent",
        authentication: "throwing_authentication", body: "none",
        responseLimitBytes: 65_536, mutation: "none",
      }],
    }, [{ kind: "prefix", pathPrefix: "/api/v1/throwing/", requestClass: "throwing_read" }])
      .extend([{
        method: "GET", mutation: "none", pathPattern: "/api/v1/throwing/example",
        response: "canonical_json" as const, successStatus: 200, handler: success,
      }]);
    const throwingMatch = throwingVerifier.match("GET", "/api/v1/throwing/example");
    expect(throwingMatch.status).toBe("matched");
    if (throwingMatch.status === "matched") {
      expect(throwingVerifier.validateSecurity(throwingMatch, {
        host: ["127.0.0.1:46630"], origin: [], authorization: [], cookie: [], csrfToken: [],
        contentType: [], query: "", bodyLength: 0,
      })).toEqual({ ok: false, code: "unauthorized" });
    }
  });

  it("keeps method rejection authenticated when one resource path has distinct method policies", async () => {
    const { verifier } = await credentialFixture();
    const routes = createRuntimeRouteRegistry({ controlVerifier: verifier })
      .extendRequestPolicies({
        authenticationVerifiers: [
          {
            authentication: "browser_session",
            verify: (input) => input.authorization.length === 0 &&
              input.cookie.length === 1 && input.cookie[0] === "browser=session" &&
              input.params["readOperationId"] === "op-1",
          },
          {
            authentication: "browser_state",
            verify: (input) => input.authorization.length === 0 &&
              input.cookie.length === 1 && input.cookie[0] === "browser=session" &&
              input.csrfToken.length === 1 && input.csrfToken[0] === "token" &&
              input.params["operationId"] === "op-1",
          },
        ],
        policies: [
          {
            requestClass: "browser_session_read", host: "fixed", origin: "absent_or_fixed",
            authentication: "browser_session", body: "none", responseLimitBytes: 65_536, mutation: "none",
          },
          {
            requestClass: "browser_state_change", host: "fixed", origin: "fixed",
            authentication: "browser_state", body: "route_json", responseLimitBytes: 65_536,
            mutation: "declared_control",
          },
        ],
      }, [
        {
          kind: "route", method: "DELETE", pathPattern: "/api/v1/examples/{operationId}",
          requestClass: "browser_state_change",
        },
        {
          kind: "route", method: "GET", pathPattern: "/api/v1/examples/{readOperationId}",
          requestClass: "browser_session_read",
        },
      ])
      .extend([
        {
          method: "DELETE", mutation: "declared_control", pathPattern: "/api/v1/examples/{operationId}",
          response: "canonical_json" as const, successStatus: 200, handler: success,
        },
        {
          method: "GET", mutation: "none", pathPattern: "/api/v1/examples/{readOperationId}",
          response: "canonical_json" as const, successStatus: 200, handler: success,
        },
      ]);
    const match = routes.match("POST", "/api/v1/examples/op-1");
    expect(match.status).toBe("method_not_allowed");
    if (match.status !== "method_not_allowed") return;
    expect(match.allow).toEqual(["DELETE", "GET"]);
    expect(match.candidates.map((candidate) => candidate.params)).toEqual([
      { operationId: "op-1" },
      { readOperationId: "op-1" },
    ]);
    expect(match.candidates.every((candidate) => Object.isFrozen(candidate.params))).toBe(true);
    expect(routes.validateMethodRejection(match, {
      origin: [], authorization: [], cookie: ["browser=session"], csrfToken: [],
    })).toEqual({ ok: true });
    expect(routes.validateMethodRejection(match, {
      origin: ["https://evil.example"], authorization: [], cookie: [], csrfToken: [],
    })).toEqual({ ok: false, code: "invalid_origin" });
    const foreignOperation = routes.match("POST", "/api/v1/examples/op-2");
    expect(foreignOperation.status).toBe("method_not_allowed");
    if (foreignOperation.status === "method_not_allowed") {
      expect(routes.validateMethodRejection(foreignOperation, {
        origin: ["http://127.0.0.1:46630"], authorization: [],
        cookie: ["browser=session"], csrfToken: [],
      })).toEqual({ ok: false, code: "unauthorized" });
    }
  });

  it("rejects malformed definitions, undeclared legacy paths, and ambiguous routes", async () => {
    const { verifier } = await credentialFixture();
    const baseRegistry = createRuntimeRouteRegistry({ controlVerifier: verifier });
    expect(() => baseRegistry.extend([{
      method: "GET",
      pathPattern: "/api/v1/internal/control/example",
      mutation: "none" as const,
      response: "canonical_json" as const, successStatus: 200,
      handler: success,
      requestClass: "public_read",
    } as unknown as RouteDefinition])).toThrow("fields");
    expect(() => baseRegistry.extend([{
      method: "GET", mutation: "none", pathPattern: "/foreign/example", response: "canonical_json" as const, successStatus: 200, handler: success,
    }])).toThrow("owned request-class resource");
    expect(() => baseRegistry.extend([{
      method: "GET", mutation: "none", pathPattern: "/__identity", response: "canonical_json" as const, successStatus: 200, handler: success,
    }])).toThrow();
    expect(() => baseRegistry.extend([{
      method: "GET", mutation: "none", pathPattern: "/api/v1/internal/cli/example", response: "canonical_json" as const, successStatus: 200, handler: success,
    }])).toThrow();
    expect(baseRegistry.match("POST", "/api/v1/wallet/connect").status).toBe("not_found");
    const hostileRoutes = new Proxy([], {
      get(target, property, receiver): unknown {
        if (property === Symbol.iterator) throw new Error("secret-route-iterator");
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    expect(() => baseRegistry.extend(hostileRoutes)).toThrow("cannot be inspected safely");
    const hostile = Object.defineProperty({
      method: "GET", mutation: "none", pathPattern: "/api/v1/internal/control/example", response: "canonical_json" as const, successStatus: 200,
    }, "handler", {
      enumerable: true,
      get(): never { throw new Error("secret-handler-getter"); },
    });
    expect(() => baseRegistry.extend([hostile as RouteDefinition])).toThrow("data properties");
    expect(() => baseRegistry.extend([{
      method: "GET", mutation: "none", pathPattern: "/api/v1/example", response: "canonical_json" as const, successStatus: 201, handler: success,
    }])).toThrow("incompatible");
    expect(() => baseRegistry.extend([{
      method: "POST", mutation: "declared_control", pathPattern: "/api/v1/contract-inspections",
      response: "canonical_json" as const, successStatus: 200, handler: success,
    }])).toThrow("incompatible");
    expect(() => baseRegistry.extend([{
      method: "GET", mutation: "declared_control", pathPattern: "/api/v1/internal/control/example",
      response: "canonical_json" as const, successStatus: 200, handler: success,
    }])).toThrow("incompatible");

    const fixed = {
      method: "GET" as const,
      pathPattern: "/api/v1/internal/control/items/fixed",
      mutation: "none" as const,
      response: "canonical_json" as const, successStatus: 200 as const,
      handler: success,
    };
    const parameter = {
      method: "GET" as const,
      pathPattern: "/api/v1/internal/control/items/{itemId}",
      mutation: "none" as const,
      response: "canonical_json" as const, successStatus: 200 as const,
      handler: success,
    };
    expect(() => baseRegistry.extend([fixed, parameter])).toThrow("intersect");
    expect(() => baseRegistry.extend([parameter, fixed])).toThrow("intersect");
    expect(() => baseRegistry.extend([
      fixed,
      { ...fixed, method: "POST", pathPattern: "/api/v1/internal/control/items/{itemId}" },
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
      pathPattern: "/api/v1/internal/control/example",
      mutation: "none" as const,
      response: "canonical_json" as const, successStatus: 200,
      handler: success,
    }]);
    const match = registry.match("GET", "/api/v1/internal/control/example");
    expect(match.status).toBe("matched");
    if (match.status !== "matched") return;
    expect(registry.normalizeResult(match.route, { ok: true, body: { value: "ok" } }))
      .toEqual({ ok: true, response: "canonical_json", body: { value: "ok" } });
    expect(() => registry.normalizeResult(match.route, { ok: true, body: {}, extra: true })).toThrow("invalid");
    expect(() => registry.normalizeResult(match.route, {
      ok: true,
      body: "<html></html>",
      contentType: "text/html; charset=utf-8",
    })).toThrow("invalid");
    expect(() => registry.normalizeResult(match.route, Object.defineProperty({ body: {} }, "ok", {
      enumerable: true,
      get(): never { throw new Error("secret-result-getter"); },
    }))).toThrow();
  });

  it("carries browser text only through the fixed response contract", async () => {
    const { verifier } = await credentialFixture();
    const registry = createRuntimeRouteRegistry({ controlVerifier: verifier })
      .extendRequestPolicies({
        authenticationVerifiers: [],
        policies: [{
          requestClass: "browser_bootstrap",
          host: "fixed",
          origin: "absent",
          authentication: "none",
          body: "none",
          responseLimitBytes: 65_536,
          mutation: "none",
        }],
      }, [{
        kind: "route",
        method: "GET",
        pathPattern: "/examples/{operationId}",
        requestClass: "browser_bootstrap",
      }])
      .extend([{
        method: "GET",
        pathPattern: "/examples/{operationId}",
        mutation: "none",
        response: "browser_content",
        successStatus: 200,
        handler: async () => ({
          ok: true,
          body: "<html></html>",
          contentType: "text/html; charset=utf-8",
        }),
      }]);
    const match = registry.match("GET", "/examples/example");
    expect(match.status).toBe("matched");
    if (match.status !== "matched") return;

    expect(registry.normalizeResult(match.route, {
      ok: true,
      body: "<html></html>",
      contentType: "text/html; charset=utf-8",
      setCookie: "example_session=token; Path=/api/v1/examples/example; Max-Age=60; HttpOnly; SameSite=Strict",
    })).toEqual({
      ok: true,
      response: "browser_content",
      body: "<html></html>",
      contentType: "text/html; charset=utf-8",
      setCookie: "example_session=token; Path=/api/v1/examples/example; Max-Age=60; HttpOnly; SameSite=Strict",
    });
    expect(() => registry.normalizeResult(match.route, {
      ok: true,
      body: "<html></html>",
      contentType: "application/json",
    })).toThrow("invalid");
    expect(() => registry.normalizeResult(match.route, {
      ok: true,
      body: "<html></html>",
      contentType: "text/html; charset=utf-8",
      headers: { "X-Unowned": "value" },
    })).toThrow("invalid");
    expect(() => registry.normalizeResult(match.route, {
      ok: true,
      body: "<html></html>",
      contentType: "text/html; charset=utf-8",
      setCookie: "value=one\r\nX-Injected: yes",
    })).toThrow("invalid");
    expect(() => registry.normalizeResult(match.route, {
      ok: true,
      body: "body {}",
      contentType: "text/css; charset=utf-8",
      setCookie: "value=one; HttpOnly",
    })).toThrow("invalid");
    expect(() => registry.normalizeResult(match.route, {
      ok: true,
      body: "x".repeat(65_537),
      contentType: "text/html; charset=utf-8",
    })).toThrow("invalid");
  });
});
