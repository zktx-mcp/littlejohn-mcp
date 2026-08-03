import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  walletConnectionCapability,
  walletConnectionEvidence,
  type HandlerInvocationContext,
  type ObservationWriter,
} from "../../src/core/index.js";
import type { WalletConnectionReadCapabilityPort } from "../../src/runtime/application-context.js";
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
  parseWalletOperationPresentation,
  parseWalletQrMatrix,
  type WalletLocalControlOperationPort,
  type WalletManagementOperation,
  type WalletOperationCancellation,
  type WalletOperationConfirmation,
  type WalletOperationConfirmationPort,
  type WalletOperationCreate,
  type WalletOperationPresentationPort,
  type WalletOperationStartResult,
} from "../../src/wallet/contracts.js";
import { WalletOperationError } from "../../src/wallet/errors.js";
import {
  extendWalletControlRouteRegistry,
  walletControlResources,
} from "../../src/wallet/routes.js";
import { bindForHarness, createCapabilityHarness } from "../core/capability-harness.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

const operationId = Buffer.alloc(32, 11).toString("base64url");
const otherOperationId = Buffer.alloc(32, 12).toString("base64url");
const disconnected = Object.freeze({ status: "disconnected" as const, reason: "no_session" as const });
const connected = Object.freeze({
  status: "connected" as const,
  address: "0x1111111111111111111111111111111111111111",
  chainId: "eip155:4663" as const,
  approvedMethods: ["eth_sendTransaction"],
  approvedEvents: ["accountsChanged", "chainChanged"],
  expiresAt: "2026-07-15T06:00:00.000Z",
});
const qr = parseWalletQrMatrix({
  size: 21,
  rows: Array.from({ length: 21 }, () => "0".repeat(21)),
});

const operation = (overrides: Readonly<Record<string, unknown>> = {}): WalletManagementOperation =>
  parseWalletManagementOperation({
    operationId,
    kind: "disconnect",
    state: "completed",
    connectionRevision: "4",
    actionExpiresAt: "2026-07-14T06:10:00.000Z",
    interactionInterface: "cli",
    result: { outcome: "already_disconnected", connection: disconnected },
    failure: null,
    peerRefusalCode: null,
    ...overrides,
  });

interface OperationCalls {
  readonly starts: WalletOperationCreate[];
  readonly reads: string[];
  readonly cancellations: WalletOperationCancellation[];
  readonly presentations: Readonly<{ operationId: string; interactionInterface: string }>[];
  readonly confirmations: Readonly<{ operationId: string; input: WalletOperationConfirmation }>[];
}

const fakePorts = (input: {
  readonly start?: (value: WalletOperationCreate) => Promise<WalletOperationStartResult>;
  readonly get?: (operationId: string) => Promise<WalletManagementOperation>;
  readonly cancel?: (value: WalletOperationCancellation) => Promise<WalletManagementOperation>;
  readonly presentation?: (operationId: string, interactionInterface: "cli" | "web") =>
    Promise<ReturnType<typeof parseWalletOperationPresentation>>;
  readonly confirm?: (operationId: string, value: WalletOperationConfirmation) =>
    Promise<WalletManagementOperation>;
} = {}): {
  readonly operations: WalletLocalControlOperationPort;
  readonly presentation: WalletOperationPresentationPort;
  readonly confirmation: WalletOperationConfirmationPort<"cli">;
  readonly calls: OperationCalls;
} => {
  const calls: OperationCalls = {
    starts: [], reads: [], cancellations: [], presentations: [], confirmations: [],
  };
  return Object.freeze({
    calls,
    operations: Object.freeze({
      async start(value: WalletOperationCreate) {
        calls.starts.push(value);
        return input.start?.(value) ?? Object.freeze({
          status: "operation_started" as const,
          operation: operation(),
        });
      },
      async get(id: string) {
        calls.reads.push(id);
        return input.get?.(id) ?? operation();
      },
      async cancel(value: WalletOperationCancellation) {
        calls.cancellations.push(value);
        return input.cancel?.(value) ?? operation();
      },
    }),
    presentation: Object.freeze({
      async get(id: string, interactionInterface: "cli" | "web") {
        calls.presentations.push({ operationId: id, interactionInterface });
        return input.presentation?.(id, interactionInterface) ??
          parseWalletOperationPresentation({ operation: operation(), access: "interactive" });
      },
    }),
    confirmation: Object.freeze({
      interactionInterface: "cli" as const,
      async confirm(id: string, value: WalletOperationConfirmation) {
        calls.confirmations.push({ operationId: id, input: value });
        return input.confirm?.(id, value) ?? operation();
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
    const sdk = observations.bind(walletConnectionEvidence.targets.sdk);
    observations.record(sdk.slot, {
      source: context.ports.observations.get("wallet_sdk"),
      claims: [{ role: sdk.roles.state, value: disconnected }],
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
  ports = fakePorts(),
  connection: WalletConnectionReadCapabilityPort = walletConnection(),
): Promise<RuntimeRouteRegistry> => extendWalletControlRouteRegistry({
  routes: await baseRoutes(),
  operations: ports.operations,
  presentation: ports.presentation,
  cliConfirmation: ports.confirmation,
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
    query: "",
    signal: new AbortController().signal,
  }));
};

describe("authenticated wallet control routes", () => {
  it("registers the exact local resources including separate presentation", async () => {
    const registry = await routes();
    const expected = [
      ["POST", walletControlResources.operations.path, "declared_control"],
      ["GET", walletControlResources.operation.path(operationId), "none"],
      ["GET", walletControlResources.presentation.path(operationId), "none"],
      ["POST", walletControlResources.confirmation.path(operationId), "declared_control"],
      ["POST", walletControlResources.cancellation.path(operationId), "declared_control"],
      ["GET", walletControlResources.connection.path, "none"],
    ] as const;
    for (const [method, path, mutation] of expected) {
      const match = registry.match(method, path);
      expect(match.status).toBe("matched");
      if (match.status === "matched") {
        expect(match.route).toMatchObject({
          method,
          mutation,
          requestClass: "local_control",
          response: "canonical_json",
          successStatus: 200,
        });
      }
    }
    expect(registry.match("GET", walletControlResources.operations.path).status).toBe("method_not_allowed");
    expect(registry.match("POST", walletControlResources.connection.path).status).toBe("method_not_allowed");
    expect(registry.match("DELETE", walletControlResources.operation.path(operationId)).status)
      .toBe("method_not_allowed");
    expect(registry.match("DELETE", walletControlResources.cancellation.path(operationId)).status)
      .toBe("method_not_allowed");
  });

  it("strictly binds one start command and returns the direct QR-free canonical result", async () => {
    const ports = fakePorts();
    const registry = await routes(ports);
    const result = await invoke(registry, "POST", walletControlResources.operations.path, {
      control: { operationId, interactionInterface: "cli" },
      request: { kind: "disconnect", connectionRevision: null },
    });
    expect(result).toEqual({
      ok: true,
      response: "canonical_json",
      body: { status: "operation_started", operation: operation() },
    });
    expect(ports.calls.starts).toEqual([{
      operationId,
      interactionInterface: "cli",
      kind: "disconnect",
      connectionRevision: null,
    }]);
    expect(JSON.stringify(result)).not.toContain("qr");

    const invalid = await invoke(registry, "POST", walletControlResources.operations.path, {
      control: { operationId, interactionInterface: "cli" },
      request: { kind: "disconnect", connectionRevision: null },
      extra: true,
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.problem.code).toBe("invalid_input");
    expect(ports.calls.starts).toHaveLength(1);
  });

  it("binds read, presentation, confirmation, and cancellation to one exact operation", async () => {
    const pending = operation({
      kind: "connect",
      state: "awaiting_wallet_approval",
      result: null,
    });
    const ports = fakePorts({
      presentation: async () => parseWalletOperationPresentation({
        operation: pending,
        access: "interactive",
        qr,
      }),
    });
    const registry = await routes(ports);

    const read = await invoke(registry, "GET", walletControlResources.operation.path(operationId));
    expect(read).toMatchObject({ ok: true, body: { operationId } });
    const presentation = await invoke(registry, "GET", walletControlResources.presentation.path(operationId));
    expect(presentation).toMatchObject({
      ok: true,
      body: { operation: { operationId, state: "awaiting_wallet_approval" }, access: "interactive", qr },
    });
    const confirmation = await invoke(
      registry,
      "POST",
      walletControlResources.confirmation.path(operationId),
      { connectionRevision: "4" },
    );
    expect(confirmation).toMatchObject({ ok: true, body: { operationId } });
    const cancellation = await invoke(
      registry,
      "POST",
      walletControlResources.cancellation.path(operationId),
      { connectionRevision: "4" },
    );
    expect(cancellation).toMatchObject({ ok: true, body: { operationId } });

    expect(ports.calls).toEqual({
      starts: [],
      reads: [operationId],
      presentations: [{ operationId, interactionInterface: "cli" }],
      confirmations: [{ operationId, input: { connectionRevision: "4" } }],
      cancellations: [{ operationId, connectionRevision: "4" }],
    });
  });

  it("rejects invalid path identities and mismatched canonical results", async () => {
    const ports = fakePorts({
      get: async () => operation({ operationId: otherOperationId }),
      presentation: async () => parseWalletOperationPresentation({
        operation: operation({ operationId: otherOperationId }),
        access: "interactive",
      }),
    });
    const registry = await routes(ports);
    const invalid = await invoke(
      registry,
      "GET",
      "/api/v1/internal/control/wallet/operations/not-an-operation-id",
    );
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.problem.code).toBe("invalid_input");
    expect(ports.calls.reads).toEqual([]);

    for (const path of [
      walletControlResources.operation.path(operationId),
      walletControlResources.presentation.path(operationId),
    ]) {
      const result = await invoke(registry, "GET", path);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.problem.code).toBe("internal_error");
    }
  });

  it("preserves owned failures, redacts unknown failures, and projects wallet.connection unchanged", async () => {
    const failing = fakePorts({
      get: async () => { throw new WalletOperationError("wallet_timeout"); },
      cancel: async () => { throw new RuntimeOperationError("state_conflict"); },
      presentation: async () => { throw new Error("secret topic and relay payload"); },
    });
    const registry = await routes(failing);
    const timeout = await invoke(registry, "GET", walletControlResources.operation.path(operationId));
    expect(timeout.ok).toBe(false);
    if (!timeout.ok) expect(timeout.problem.code).toBe("wallet_timeout");
    const conflict = await invoke(
      registry,
      "POST",
      walletControlResources.cancellation.path(operationId),
      { connectionRevision: "4" },
    );
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.problem.code).toBe("state_conflict");
    const unknown = await invoke(registry, "GET", walletControlResources.presentation.path(operationId));
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.problem.code).toBe("internal_error");
      expect(JSON.stringify(unknown.problem)).not.toContain("secret");
      expect(JSON.stringify(unknown.problem)).not.toContain("relay");
    }

    const connection = await invoke(registry, "GET", walletControlResources.connection.path);
    expect(connection).toMatchObject({
      ok: true,
      body: {
        ok: true,
        meta: { capabilityId: "wallet.connection", contractVersion: "1", chainId: "eip155:4663" },
        data: disconnected,
        warnings: [],
      },
    });
  });
});
