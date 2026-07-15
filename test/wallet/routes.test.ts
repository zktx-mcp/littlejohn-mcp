import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  walletConnectionCapability,
  type HandlerInvocationContext,
  type ObservationWriter,
} from "../../src/core/index.js";
import type { WalletConnectionReadCapabilityPort } from "../../src/runtime/composition.js";
import {
  createControlCredentialVerifier,
  loadOrCreateControlCredential,
} from "../../src/runtime/control-credential.js";
import { RuntimeOperationError } from "../../src/runtime/errors.js";
import {
  createRuntimeRouteRegistry,
  type NormalizedRouteResult,
  type RouteMethod,
  type RuntimeRouteRegistry,
} from "../../src/runtime/http-routing.js";
import { runtimePaths } from "../../src/runtime/paths.js";
import {
  parseWalletManagementOperation,
  parseWalletQrMatrix,
  type WalletOperationConfirmation,
  type WalletOperationConfirmationPort,
  type WalletOperationCreate,
  type WalletLocalControlOperationPort,
  type WalletManagementOperation,
  type WalletOperationResponse,
} from "../../src/wallet/contracts.js";
import { WalletOperationError } from "../../src/wallet/errors.js";
import { extendWalletControlRouteRegistry } from "../../src/wallet/routes.js";
import { bindForHarness, createCapabilityHarness } from "../core/capability-harness.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const operationId = Buffer.alloc(32, 11).toString("base64url");
const disconnected = Object.freeze({ status: "disconnected" as const, reason: "no_session" as const });

const operation = (overrides: Readonly<Record<string, unknown>> = {}): WalletManagementOperation =>
  parseWalletManagementOperation({
    operationId,
    kind: "disconnect",
    state: "completed",
    connectionRevision: "4",
    expiresAt: "2026-07-14T06:10:00.000Z",
    result: { outcome: "already_disconnected", connection: disconnected },
    failure: null,
    ...overrides,
  });

const qr = parseWalletQrMatrix({
  size: 21,
  rows: Array.from({ length: 21 }, () => "0".repeat(21)),
});

interface OperationCalls {
  creates: unknown[];
  reads: string[];
  cancellations: string[];
}

interface ConfirmationCalls {
  confirmations: unknown[];
}

const fakeOperations = (
  response: () => WalletOperationResponse = () => ({ operation: operation() }),
): { readonly operations: WalletLocalControlOperationPort; readonly calls: OperationCalls } => {
  const calls: OperationCalls = { creates: [], reads: [], cancellations: [] };
  return {
    calls,
    operations: Object.freeze({
      async start(input: WalletOperationCreate) {
        calls.creates.push(input);
        return response();
      },
      async get(id: string) {
        calls.reads.push(id);
        return response();
      },
      async cancel(id: string) {
        calls.cancellations.push(id);
        return response();
      },
    }),
  };
};

const fakeCliConfirmation = (
  response: () => WalletOperationResponse = () => ({ operation: operation() }),
): {
  readonly confirmation: WalletOperationConfirmationPort<"cli">;
  readonly calls: ConfirmationCalls;
} => {
  const calls: ConfirmationCalls = { confirmations: [] };
  return Object.freeze({
    calls,
    confirmation: Object.freeze({
      interactionInterface: "cli" as const,
      async confirm(id: string, input: WalletOperationConfirmation) {
        calls.confirmations.push({ id, input });
        return response();
      },
    }),
  });
};

const walletConnection = (
  handler: (
    input: Record<string, never>,
    context: HandlerInvocationContext,
    observations: ObservationWriter,
  ) => Promise<unknown> = async (_input, context, observations) => {
    observations.record("wallet_sdk", {
      source: context.ports.observations.get("wallet_sdk"),
      claims: [{ role: "wallet_sdk_state", value: disconnected }],
    });
    return { status: "success", data: disconnected };
  },
): WalletConnectionReadCapabilityPort => {
  const harness = createCapabilityHarness(() => "2026-07-14T06:00:00.000Z");
  return Object.freeze({
    connection: bindForHarness(walletConnectionCapability, harness, handler),
  });
};

const baseRoutes = async (): Promise<RuntimeRouteRegistry> => {
  const directory = await mkdtemp(resolve(tmpdir(), "littlejohn-wallet-routes-"));
  directories.push(directory);
  const paths = runtimePaths(directory);
  const authority = await loadOrCreateControlCredential(directory, paths.controlCredential);
  return createRuntimeRouteRegistry({ controlVerifier: createControlCredentialVerifier(authority) });
};

const routes = async (
  operations: WalletLocalControlOperationPort,
  connection: WalletConnectionReadCapabilityPort = walletConnection(),
  cliConfirmation: WalletOperationConfirmationPort<"cli"> = fakeCliConfirmation().confirmation,
): Promise<RuntimeRouteRegistry> => extendWalletControlRouteRegistry({
  routes: await baseRoutes(),
  operations,
  cliConfirmation,
  walletConnection: connection,
});

const invoke = async (
  registry: RuntimeRouteRegistry,
  method: RouteMethod,
  path: string,
  body: unknown = {},
): Promise<NormalizedRouteResult> => {
  const match = registry.match(method, path);
  expect(match.status).toBe("matched");
  if (match.status !== "matched") throw new Error("Expected route match.");
  return registry.normalizeResult(match.route, await match.route.handler({
    params: match.params,
    body,
    signal: new AbortController().signal,
  }));
};

describe("authenticated wallet control routes", () => {
  it("registers only the exact resource identities, methods, mutation meanings, and statuses", async () => {
    const { operations } = fakeOperations();
    const registry = await routes(operations);
    const expected = [
      ["POST", "/api/v1/internal/control/wallet/operations", "declared_control", 201, true],
      ["GET", `/api/v1/internal/control/wallet/operations/${operationId}`, "none", 200, false],
      ["POST", `/api/v1/internal/control/wallet/operations/${operationId}/confirmation`, "declared_control", 200, true],
      ["DELETE", `/api/v1/internal/control/wallet/operations/${operationId}`, "declared_control", 200, false],
      ["GET", "/api/v1/internal/control/wallet/connection", "none", 200, false],
    ] as const;

    for (const [method, path, mutation, successStatus, acceptsBody] of expected) {
      const match = registry.match(method, path);
      expect(match.status).toBe("matched");
      if (match.status !== "matched") continue;
      expect(match.route).toMatchObject({
        method,
        mutation,
        requestClass: "local_control",
        response: "canonical_json",
        successStatus,
        acceptsBody,
      });
    }

    expect(registry.match("GET", "/api/v1/internal/control/wallet/operations").status)
      .toBe("method_not_allowed");
    expect(registry.match("POST", "/api/v1/internal/control/wallet/connection").status)
      .toBe("method_not_allowed");
    expect(registry.match("GET", "/api/v1/wallet/connection").status).toBe("not_found");

    const connection = registry.match("GET", "/api/v1/internal/control/wallet/connection");
    if (connection.status !== "matched") throw new Error("Expected connection route match.");
    expect(registry.validateSecurity(connection.route, {
      host: ["127.0.0.1:46630"],
      origin: [],
      authorization: [],
      cookie: [],
      csrfToken: [],
      contentType: [],
      query: "",
      bodyLength: 0,
    })).toEqual({ ok: false, code: "unauthorized" });
  });

  it("strictly validates create and confirmation bodies before invoking the coordinator", async () => {
    const { operations, calls } = fakeOperations();
    const confirmations = fakeCliConfirmation();
    const registry = await routes(operations, walletConnection(), confirmations.confirmation);

    const created = await invoke(registry, "POST", "/api/v1/internal/control/wallet/operations", {
      kind: "connect",
      interactionInterface: "cli",
    });
    expect(created).toEqual({ ok: true, response: "canonical_json", body: { operation: operation() } });
    expect(calls.creates).toEqual([{ kind: "connect", interactionInterface: "cli" }]);

    const extraCreate = await invoke(registry, "POST", "/api/v1/internal/control/wallet/operations", {
      kind: "connect",
      interactionInterface: "cli",
      session: "forbidden",
    });
    expect(extraCreate.ok).toBe(false);
    if (!extraCreate.ok) expect(extraCreate.problem.code).toBe("invalid_input");
    expect(calls.creates).toHaveLength(1);

    let accessorRead = false;
    const hostileCreate = { kind: "connect", interactionInterface: "cli" };
    Object.defineProperty(hostileCreate, "kind", {
      enumerable: true,
      get() {
        accessorRead = true;
        throw new Error("secret");
      },
    });
    const hostile = await invoke(
      registry,
      "POST",
      "/api/v1/internal/control/wallet/operations",
      hostileCreate,
    );
    expect(hostile.ok).toBe(false);
    if (!hostile.ok) expect(hostile.problem.code).toBe("invalid_input");
    expect(accessorRead).toBe(false);

    const confirmed = await invoke(
      registry,
      "POST",
      `/api/v1/internal/control/wallet/operations/${operationId}/confirmation`,
      { connectionRevision: "4" },
    );
    expect(confirmed.ok).toBe(true);
    expect(confirmations.calls.confirmations).toEqual([
      { id: operationId, input: { connectionRevision: "4" } },
    ]);

    const extraConfirmation = await invoke(
      registry,
      "POST",
      `/api/v1/internal/control/wallet/operations/${operationId}/confirmation`,
      { connectionRevision: "4", approved: true },
    );
    expect(extraConfirmation.ok).toBe(false);
    if (!extraConfirmation.ok) expect(extraConfirmation.problem.code).toBe("invalid_input");
    expect(confirmations.calls.confirmations).toHaveLength(1);
  });

  it("validates operation identifiers and never passes an invalid path identity to the coordinator", async () => {
    const { operations, calls } = fakeOperations();
    const registry = await routes(operations);

    const invalidRead = await invoke(
      registry,
      "GET",
      "/api/v1/internal/control/wallet/operations/not-a-canonical-operation-id",
    );
    expect(invalidRead.ok).toBe(false);
    if (!invalidRead.ok) expect(invalidRead.problem.code).toBe("invalid_input");
    expect(calls.reads).toEqual([]);

    const invalidCancel = await invoke(
      registry,
      "DELETE",
      "/api/v1/internal/control/wallet/operations/not-a-canonical-operation-id",
    );
    expect(invalidCancel.ok).toBe(false);
    if (!invalidCancel.ok) expect(invalidCancel.problem.code).toBe("invalid_input");
    expect(calls.cancellations).toEqual([]);

    expect((await invoke(
      registry,
      "GET",
      `/api/v1/internal/control/wallet/operations/${operationId}`,
    )).ok).toBe(true);
    expect((await invoke(
      registry,
      "DELETE",
      `/api/v1/internal/control/wallet/operations/${operationId}`,
    )).ok).toBe(true);
    expect(calls.reads).toEqual([operationId]);
    expect(calls.cancellations).toEqual([operationId]);
  });

  it("returns QR matrices only as the optional response field and rejects invalid QR exposure", async () => {
    const pending = operation({
      kind: "connect",
      state: "awaiting_wallet_approval",
      result: null,
    });
    const withQr = fakeOperations(() => ({ operation: pending, qr }));
    const cliRegistry = await routes(withQr.operations);
    const cli = await invoke(cliRegistry, "POST", "/api/v1/internal/control/wallet/operations", {
      kind: "connect",
      interactionInterface: "cli",
    });
    expect(cli).toEqual({ ok: true, response: "canonical_json", body: { operation: pending, qr } });
    if (cli.ok && cli.response === "canonical_json") {
      expect("qr" in (cli.body as Record<string, unknown>)).toBe(true);
      expect("qr" in ((cli.body as { operation: Record<string, unknown> }).operation)).toBe(false);
    }

    const webRegistry = await routes(withQr.operations);
    const web = await invoke(webRegistry, "POST", "/api/v1/internal/control/wallet/operations", {
      kind: "connect",
      interactionInterface: "web",
    });
    expect(web.ok).toBe(false);
    if (!web.ok) expect(web.problem.code).toBe("internal_error");

    const omitted = fakeOperations();
    const omittedRegistry = await routes(omitted.operations);
    const read = await invoke(
      omittedRegistry,
      "GET",
      `/api/v1/internal/control/wallet/operations/${operationId}`,
    );
    expect(read.ok).toBe(true);
    if (read.ok && read.response === "canonical_json") {
      expect("qr" in (read.body as Record<string, unknown>)).toBe(false);
    }

    const invalid = fakeOperations(() => ({ operation: operation(), qr } as WalletOperationResponse));
    const invalidRegistry = await routes(invalid.operations);
    const rejected = await invoke(
      invalidRegistry,
      "GET",
      `/api/v1/internal/control/wallet/operations/${operationId}`,
    );
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.problem.code).toBe("internal_error");
  });

  it("preserves canonical operation errors and normalizes unknown exceptions without exposing their text", async () => {
    const throwing = (error: Error): WalletLocalControlOperationPort => Object.freeze({
      async start() { throw error; },
      get() { throw error; },
      async cancel() { throw error; },
    });

    const walletFailure = await invoke(
      await routes(throwing(new WalletOperationError("wallet_timeout"))),
      "GET",
      `/api/v1/internal/control/wallet/operations/${operationId}`,
    );
    expect(walletFailure.ok).toBe(false);
    if (!walletFailure.ok) expect(walletFailure.problem.code).toBe("wallet_timeout");

    const runtimeFailure = await invoke(
      await routes(throwing(new RuntimeOperationError("state_conflict"))),
      "DELETE",
      `/api/v1/internal/control/wallet/operations/${operationId}`,
    );
    expect(runtimeFailure.ok).toBe(false);
    if (!runtimeFailure.ok) expect(runtimeFailure.problem.code).toBe("state_conflict");

    const unknownFailure = await invoke(
      await routes(throwing(new Error("secret topic and relay payload"))),
      "GET",
      `/api/v1/internal/control/wallet/operations/${operationId}`,
    );
    expect(unknownFailure.ok).toBe(false);
    if (!unknownFailure.ok) {
      expect(unknownFailure.problem.code).toBe("internal_error");
      expect(JSON.stringify(unknownFailure.problem)).not.toContain("secret");
      expect(JSON.stringify(unknownFailure.problem)).not.toContain("relay");
    }
  });

  it("invokes the canonical wallet.connection binding without redefining its result", async () => {
    const { operations } = fakeOperations();
    const registry = await routes(operations);
    const result = await invoke(registry, "GET", "/api/v1/internal/control/wallet/connection");
    expect(result.ok).toBe(true);
    if (!result.ok || result.response !== "canonical_json") return;
    expect(result.body).toMatchObject({
      ok: true,
      meta: { capabilityId: "wallet.connection", contractVersion: "1", chainId: "4663" },
      data: disconnected,
      warnings: [],
    });

    const failedConnection = walletConnection(async () => ({
      status: "failure",
      code: "invalid_input",
      issues: [],
    }));
    const failed = await invoke(
      await routes(operations, failedConnection),
      "GET",
      "/api/v1/internal/control/wallet/connection",
    );
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.problem.code).toBe("invalid_input");
  });
});
