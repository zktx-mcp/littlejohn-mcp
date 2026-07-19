import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { chainInterfaceErrorMappings } from "../../src/chain/errors.js";
import type { ApplicationFailure } from "../../src/core/index.js";
import {
  createControlCredentialVerifier,
  loadOrCreateControlCredential,
} from "../../src/runtime/control-credential.js";
import {
  createRuntimeRouteRegistry,
  type NormalizedRouteResult,
  type RouteMethod,
  type RuntimeRouteRegistry,
} from "../../src/runtime/http-routing.js";
import { runtimePaths } from "../../src/runtime/paths.js";
import {
  extendTokenCatalogControlRouteRegistry,
  tokenCatalogApplicationContracts,
  tokenCatalogControlRoutes,
  tokenCatalogOperationSchema,
  type TokenCatalogConfirmedOperation,
  type TokenCatalogOperationConfirmationInput,
  type TokenCatalogOperationStartResult,
  type TokenCatalogTerminalOperation,
  type TokenInspectionSuccess,
  type TokenRegistrationStartInput,
  type TokenRegistrationStartRequest,
  type TokenRegistrationUpdateStartInput,
  type TokenUnregistrationStartInput,
} from "../../src/token-catalog/index.js";
import { TokenCatalogOperationError } from "../../src/token-catalog/operation-error.js";
import type {
  TokenCatalogInteractiveCliPort,
  TokenCatalogNonInteractiveOperationPort,
  TokenCatalogQueryApplicationPort,
  TokenCatalogWebStartPort,
} from "../../src/token-catalog/ports.js";
import {
  chainId,
  createInspectionBinding,
  createInspectionSuccess,
  tokenAddress,
  walletAddress,
} from "./harness.js";

const directories: string[] = [];
const operationId = Buffer.alloc(32, 61).toString("base64url");
const createdAt = "2026-07-18T00:00:03.000Z";
const expiresAt = "2026-07-18T00:05:03.000Z";
let inspection: TokenInspectionSuccess;

beforeAll(async () => { inspection = await createInspectionSuccess(); });

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

const pendingRegistration = (
  interactionInterface: "web" | "cli",
  settings: TokenRegistrationStartRequest["settings"],
): TokenCatalogOperationStartResult<"register">["operation"] =>
  tokenCatalogOperationSchema.parse({
    operationId,
    kind: "register",
    state: "awaiting_confirmation",
    interactionInterface,
    createdAt,
    expiresAt,
    account: { chainId, address: walletAddress },
    asset: { kind: "erc20", chainId, address: tokenAddress },
    review: {
      previousRegistration: null,
      proposedSettings: settings,
      inspection,
      reviewDigest: `0x${"ab".repeat(32)}`,
    },
    result: null,
    failure: null,
  }) as TokenCatalogOperationStartResult<"register">["operation"];

const failedOperation = (
  operation: TokenCatalogOperationStartResult<"register">["operation"],
): TokenCatalogConfirmedOperation =>
  tokenCatalogOperationSchema.parse({
    ...operation,
    state: "failed",
    failure: new TokenCatalogOperationError("state_conflict").failure,
  }) as TokenCatalogConfirmedOperation;

const cancelledOperation = (
  operation: TokenCatalogOperationStartResult<"register">["operation"],
): TokenCatalogTerminalOperation => tokenCatalogOperationSchema.parse({
  ...operation,
  state: "cancelled",
  failure: null,
}) as TokenCatalogTerminalOperation;

interface Calls {
  readonly registrations: unknown[];
  readonly lists: unknown[];
  readonly webStarts: unknown[];
  readonly cliStarts: unknown[];
  readonly reads: unknown[];
  readonly confirmations: unknown[];
  readonly cancellations: unknown[];
}

const fakePorts = (): {
  readonly calls: Calls;
  readonly queries: TokenCatalogQueryApplicationPort;
  readonly webStart: TokenCatalogWebStartPort;
  readonly interactiveCli: TokenCatalogInteractiveCliPort;
  readonly operations: TokenCatalogNonInteractiveOperationPort;
} => {
  const calls: Calls = {
    registrations: [], lists: [], webStarts: [], cliStarts: [],
    reads: [], confirmations: [], cancellations: [],
  };
  let current = pendingRegistration("cli", { userLabel: null, visibility: "visible" });
  const unsupportedStart = async (): Promise<ApplicationFailure> =>
    new TokenCatalogOperationError("internal_error").failure;
  const queries: TokenCatalogQueryApplicationPort = Object.freeze({
    getRegistration(input) {
      calls.registrations.push(input);
      return new TokenCatalogOperationError("token_registration_not_found").failure;
    },
    listRegistrations(input) {
      calls.lists.push(input);
      return Object.freeze({ registrations: [], nextCursor: null });
    },
  });
  const webStart: TokenCatalogWebStartPort = Object.freeze({
    interactionInterface: "web" as const,
    async startRegistration(input: TokenRegistrationStartInput): Promise<TokenCatalogOperationStartResult<"register">> {
      const request = tokenCatalogApplicationContracts.startRegistration.parseInput(input);
      calls.webStarts.push(request);
      current = pendingRegistration("web", request.settings);
      return Object.freeze({ operation: current });
    },
    async startRegistrationUpdate(input: TokenRegistrationUpdateStartInput) {
      calls.webStarts.push(input);
      return await unsupportedStart();
    },
    async startUnregistration(input: TokenUnregistrationStartInput) {
      calls.webStarts.push(input);
      return await unsupportedStart();
    },
  });
  const interactiveCli: TokenCatalogInteractiveCliPort = Object.freeze({
    interactionInterface: "cli" as const,
    async startRegistration(input: TokenRegistrationStartInput): Promise<TokenCatalogOperationStartResult<"register">> {
      const request = tokenCatalogApplicationContracts.startRegistration.parseInput(input);
      calls.cliStarts.push(request);
      current = pendingRegistration("cli", request.settings);
      return Object.freeze({ operation: current });
    },
    async startRegistrationUpdate(input: TokenRegistrationUpdateStartInput) {
      calls.cliStarts.push(input);
      return await unsupportedStart();
    },
    async startUnregistration(input: TokenUnregistrationStartInput) {
      calls.cliStarts.push(input);
      return await unsupportedStart();
    },
    async confirm(input: TokenCatalogOperationConfirmationInput) {
      calls.confirmations.push(input);
      return failedOperation(current);
    },
  });
  const operations: TokenCatalogNonInteractiveOperationPort = Object.freeze({
    getOperation(input) {
      calls.reads.push(input);
      return Object.freeze({ operation: current });
    },
    async cancelOperation(input) {
      calls.cancellations.push(input);
      return Object.freeze({ operation: cancelledOperation(current) });
    },
  });
  return Object.freeze({
    calls,
    queries,
    webStart,
    interactiveCli,
    operations,
  });
};

const baseRoutes = async (): Promise<RuntimeRouteRegistry> => {
  const directory = await mkdtemp(resolve(tmpdir(), "littlejohn-token-routes-"));
  directories.push(directory);
  const paths = runtimePaths(directory);
  const authority = await loadOrCreateControlCredential(directory, paths.controlCredential);
  return createRuntimeRouteRegistry({
    controlVerifier: createControlCredentialVerifier(authority),
    errorMappings: chainInterfaceErrorMappings,
  });
};

const createRoutes = async () => {
  const ports = fakePorts();
  return Object.freeze({
    ...ports,
    routes: extendTokenCatalogControlRouteRegistry({
      routes: await baseRoutes(),
      inspection: createInspectionBinding(),
      queries: ports.queries,
      webStart: ports.webStart,
      interactiveCli: ports.interactiveCli,
      nonInteractiveOperations: ports.operations,
    }),
  });
};

const invoke = async (
  registry: RuntimeRouteRegistry,
  method: RouteMethod,
  path: string,
  body: unknown = {},
): Promise<NormalizedRouteResult> => {
  const match = registry.match(method, path);
  expect(match.status).toBe("matched");
  if (match.status !== "matched") throw new Error("Expected a token catalog route match.");
  return registry.normalizeResult(match.route, await match.route.handler({
    params: match.params,
    body,
    signal: new AbortController().signal,
  }));
};

describe("token catalog local control routes", () => {
  it("registers exactly the seven authenticated resources and their HTTP meanings", async () => {
    const { routes } = await createRoutes();
    const registration = tokenCatalogControlRoutes.registration(chainId, tokenAddress);
    const expected = [
      ["POST", tokenCatalogControlRoutes.inspections, "none", true],
      ["POST", tokenCatalogControlRoutes.registrationQueries, "none", true],
      ["GET", registration, "none", false],
      ["POST", tokenCatalogControlRoutes.operations, "declared_control", true],
      ["GET", tokenCatalogControlRoutes.operation(operationId), "none", false],
      ["POST", tokenCatalogControlRoutes.confirmation(operationId), "declared_control", true],
      ["DELETE", tokenCatalogControlRoutes.operation(operationId), "declared_control", false],
    ] as const;
    for (const [method, path, mutation, acceptsBody] of expected) {
      const match = routes.match(method, path);
      expect(match.status).toBe("matched");
      if (match.status !== "matched") continue;
      expect(match.route).toMatchObject({
        method,
        mutation,
        acceptsBody,
        requestClass: "local_control",
        response: "canonical_json",
        successStatus: 200,
      });
    }
    expect(routes.match("GET", tokenCatalogControlRoutes.operations).status)
      .toBe("method_not_allowed");
    expect(routes.match("POST", registration).status).toBe("method_not_allowed");
  });

  it("uses one raw canonical CAIP-2 segment and rejects aliases before application authority", async () => {
    const { routes, calls } = await createRoutes();
    const rawPath = tokenCatalogControlRoutes.registration(chainId, tokenAddress);
    expect(rawPath).toBe(
      `/api/v1/internal/control/token-catalog/registrations/${chainId}/${tokenAddress}`,
    );
    expect(() => tokenCatalogControlRoutes.registration(
      "eip155%3A4663" as never,
      tokenAddress,
    )).toThrow();
    expect(() => tokenCatalogControlRoutes.operation("not-an-operation" as never)).toThrow();
    expect(routes.match("GET", rawPath.replace(":", "%3A")).status).toBe("not_found");
    expect(routes.match("GET", rawPath.replace("eip155:4663", "eip155/4663")).status)
      .toBe("not_found");

    const malformed = await invoke(
      routes,
      "GET",
      rawPath.replace("eip155:4663", "eip155:0"),
    );
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.problem.code).toBe("invalid_input");
    expect(calls.registrations).toEqual([]);

    const canonical = await invoke(routes, "GET", rawPath);
    expect(canonical.ok).toBe(false);
    if (!canonical.ok) expect(canonical.problem.code).toBe("token_registration_not_found");
    expect(calls.registrations).toEqual([{
      asset: { kind: "erc20", chainId, address: tokenAddress },
    }]);
  });

  it("derives exact operation identities and accepts only strict transport bodies", async () => {
    const { routes, calls } = await createRoutes();
    const created = await invoke(routes, "POST", tokenCatalogControlRoutes.operations, {
      interactionInterface: "cli",
      request: {
        kind: "register",
        asset: { kind: "erc20", chainId, address: tokenAddress },
      },
    });
    expect(created.ok).toBe(true);
    expect(calls.cliStarts).toEqual([{
      asset: { kind: "erc20", chainId, address: tokenAddress },
      settings: { userLabel: null, visibility: "visible" },
    }]);
    expect(calls.webStarts).toEqual([]);

    const revision = Buffer.alloc(16, 7).toString("base64url");
    for (const request of [
      {
        kind: "update_registration",
        asset: { kind: "erc20", chainId, address: tokenAddress },
        expectedRevision: revision,
        changes: { visibility: "hidden" },
      },
      {
        kind: "unregister",
        asset: { kind: "erc20", chainId, address: tokenAddress },
        expectedRevision: revision,
      },
    ] as const) {
      const result = await invoke(routes, "POST", tokenCatalogControlRoutes.operations, {
        interactionInterface: "web",
        request,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.problem.code).toBe("internal_error");
    }
    expect(calls.webStarts).toEqual([
      {
        asset: { kind: "erc20", chainId, address: tokenAddress },
        expectedRevision: revision,
        changes: { visibility: "hidden" },
      },
      {
        asset: { kind: "erc20", chainId, address: tokenAddress },
        expectedRevision: revision,
      },
    ]);

    const extra = await invoke(routes, "POST", tokenCatalogControlRoutes.operations, {
      interactionInterface: "cli",
      request: {
        kind: "register",
        asset: { kind: "erc20", chainId, address: tokenAddress },
      },
      forwardedInterface: "web",
    });
    expect(extra.ok).toBe(false);
    if (!extra.ok) expect(extra.problem.code).toBe("invalid_input");
    expect(calls.cliStarts).toHaveLength(1);

    const reviewDigest = `0x${"ab".repeat(32)}`;
    const confirmed = await invoke(
      routes,
      "POST",
      tokenCatalogControlRoutes.confirmation(operationId),
      { reviewDigest },
    );
    expect(confirmed.ok).toBe(true);
    expect(calls.confirmations).toEqual([{ operationId, reviewDigest }]);

    const badConfirmation = await invoke(
      routes,
      "POST",
      tokenCatalogControlRoutes.confirmation(operationId),
      { reviewDigest, approved: true },
    );
    expect(badConfirmation.ok).toBe(false);
    if (!badConfirmation.ok) expect(badConfirmation.problem.code).toBe("invalid_input");
    expect(calls.confirmations).toHaveLength(1);

    const cancelled = await invoke(
      routes,
      "DELETE",
      tokenCatalogControlRoutes.operation(operationId),
    );
    expect(cancelled.ok).toBe(true);
    expect(calls.cancellations).toEqual([{ operationId }]);
  });

  it("projects canonical application failures and does not expose unknown exceptions", async () => {
    const ports = fakePorts();
    const secret = "secret relay and credential";
    const routes = extendTokenCatalogControlRouteRegistry({
      routes: await baseRoutes(),
      inspection: createInspectionBinding(),
      queries: Object.freeze({
        getRegistration() { throw new Error(secret); },
        listRegistrations: ports.queries.listRegistrations,
      }),
      webStart: ports.webStart,
      interactiveCli: ports.interactiveCli,
      nonInteractiveOperations: ports.operations,
    });
    const result = await invoke(
      routes,
      "GET",
      tokenCatalogControlRoutes.registration(chainId, tokenAddress),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problem.code).toBe("internal_error");
      expect(JSON.stringify(result.problem)).not.toContain(secret);
    }

    const list = await invoke(routes, "POST", tokenCatalogControlRoutes.registrationQueries, {});
    expect(ports.calls.lists).toEqual([{ limit: 25 }]);
    expect(list).toEqual({
      ok: true,
      response: "canonical_json",
      body: tokenCatalogApplicationContracts.registrations.parseSuccess(
        { limit: 25, cursor: null },
        { registrations: [], nextCursor: null },
      ),
    });
  });
});
