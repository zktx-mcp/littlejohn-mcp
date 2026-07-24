import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  canonicalJsonStringify,
  type CanonicalJson,
} from "../../src/core/index.js";

import {
  parseWalletManagementOperation,
  parseWalletCurrentOperationProjection,
  parseWalletOperationConfirmation,
  parseWalletOperationCreate,
  parseWalletOperationId,
  parseWalletOperationPresentation,
  parseWalletOperationPresentationAccess,
  parseWalletQrMatrix,
  parseWalletOperationResponse,
  parseWalletOperationStartResponse,
  parseWalletWebOperationCreate,
  walletCurrentOperationPresentationSchema,
  walletCurrentOperationProjectionSchema,
  walletInteractionInterfaceSchema,
  walletManagementOperationSchema,
  walletNonterminalManagementOperationSchema,
  walletOperationAllowsQr,
  walletOperationConfirmationSchema,
  walletOperationControlSchema,
  walletOperationFailureCodes,
  walletOperationIdByteLength,
  walletOperationOutcomes,
  walletOperationPresentationAccess,
  walletOperationPresentationSchema,
  walletOperationResponseSchema,
  walletOperationStartResponseSchema,
  walletOperationStartResultSchema,
  walletTerminalStateFailureCodes,
  walletWebOperationCreateSchema,
  walletQrMatrixSizeLimits,
  type WalletOperationConfirmationPort,
  type WalletOperationPresentationPort,
} from "../../src/wallet/contracts.js";
import {
  isWalletOperationCancellableState,
  isWalletOperationConfirmableState,
  isWalletOperationTerminalState,
  walletInteractionInterfaces,
  walletOperationKinds,
  walletOperationStateDefinitions,
  walletOperationStates,
} from "../../src/wallet/operation-state.js";
import { createWalletFailure } from "../../src/wallet/errors.js";

const operationId = Buffer.alloc(walletOperationIdByteLength, 7).toString("base64url");
const disconnected = Object.freeze({ status: "disconnected", reason: "no_session" });
const connected = Object.freeze({
  status: "connected",
  address: "0x1111111111111111111111111111111111111111",
  chainId: "eip155:4663",
  approvedMethods: ["eth_sendTransaction"],
  approvedEvents: ["accountsChanged", "chainChanged"],
  expiresAt: "2026-07-14T01:10:00.000Z",
});
const unknown = Object.freeze({ status: "unknown", reason: "reconciling" });
const unresolved = Object.freeze({ status: "unresolved", sessionCount: "2" });

const operation = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  operationId,
  kind: "disconnect",
  state: "completed",
  connectionRevision: "3",
  expiresAt: "2026-07-14T01:05:00.000Z",
  result: { outcome: "already_disconnected", connection: disconnected },
  failure: null,
  ...overrides,
});

const outputSchema = (schema: z.ZodType): CanonicalJson =>
  JSON.parse(JSON.stringify(z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "output",
    unrepresentable: "throw",
  }))) as CanonicalJson;

const canonicalOperationProjection = (): string => canonicalJsonStringify(
  JSON.parse(JSON.stringify({
    interactionInterfaces: walletInteractionInterfaces,
    operationKinds: walletOperationKinds,
    operationStateDefinitions: walletOperationStateDefinitions,
    operationFailureCodes: walletOperationFailureCodes,
    terminalStateFailureCodes: walletTerminalStateFailureCodes,
    presentationAccess: walletOperationPresentationAccess,
    schemas: {
      managementOperation: outputSchema(walletManagementOperationSchema),
      nonterminalManagementOperation: outputSchema(walletNonterminalManagementOperationSchema),
      operationControl: outputSchema(walletOperationControlSchema),
      webOperationCreate: outputSchema(walletWebOperationCreateSchema),
      operationConfirmation: outputSchema(walletOperationConfirmationSchema),
      operationResponse: outputSchema(walletOperationResponseSchema),
      operationStartResult: outputSchema(walletOperationStartResultSchema),
      operationStartResponse: outputSchema(walletOperationStartResponseSchema),
      operationPresentation: outputSchema(walletOperationPresentationSchema),
      currentOperationPresentation: outputSchema(walletCurrentOperationPresentationSchema),
      currentOperationProjection: outputSchema(walletCurrentOperationProjectionSchema),
    },
  })) as CanonicalJson,
);

describe("wallet management contracts", () => {
  it("preserves the complete wallet operation projection", () => {
    const canonical = canonicalOperationProjection();
    expect(Buffer.byteLength(canonical, "utf8")).toBe(110_890);
    expect(createHash("sha256").update(canonical, "utf8").digest("hex")).toBe(
      "fe0c81b853949e6056cda607dd1a168f4f56e2d6f061c3f7898d0bc3f1705b93",
    );
  });

  it("owns exact interaction and per-kind outcome vocabularies", () => {
    expect(walletInteractionInterfaces).toEqual(["cli", "web"]);
    expect(walletOperationOutcomes).toEqual({
      connect: ["connected"],
      disconnect: ["disconnected", "already_disconnected"],
    });
    expect(Object.isFrozen(walletOperationOutcomes)).toBe(true);
    expect(Object.isFrozen(walletOperationOutcomes.connect)).toBe(true);
    expect(Object.isFrozen(walletOperationOutcomes.disconnect)).toBe(true);

    expect(walletInteractionInterfaceSchema.parse("cli")).toBe("cli");
    expect(walletInteractionInterfaceSchema.parse("web")).toBe("web");
    for (const invalid of ["mcp", "CLI", "browser", "", null, undefined]) {
      expect(() => walletInteractionInterfaceSchema.parse(invalid)).toThrow();
    }
  });

  it("owns canonical operation identifiers and presentation access", () => {
    expect(parseWalletOperationId(operationId)).toBe(operationId);
    for (const invalidOperationId of [
      Buffer.alloc(walletOperationIdByteLength - 1, 7).toString("base64url"),
      Buffer.alloc(walletOperationIdByteLength + 1, 7).toString("base64url"),
      `${operationId}=`,
      `${operationId.slice(0, -1)}+`,
    ]) expect(() => parseWalletOperationId(invalidOperationId)).toThrow();

    expect(parseWalletOperationPresentationAccess("interactive")).toBe("interactive");
    expect(parseWalletOperationPresentationAccess("read_only")).toBe("read_only");
    expect(() => parseWalletOperationPresentationAccess("owner")).toThrow();
  });

  it("owns one frozen QR matrix dimension contract", () => {
    expect(walletQrMatrixSizeLimits).toEqual({ minimum: 21, maximum: 177 });
    expect(Object.isFrozen(walletQrMatrixSizeLimits)).toBe(true);

    for (const size of [
      walletQrMatrixSizeLimits.minimum,
      walletQrMatrixSizeLimits.maximum,
    ]) {
      expect(parseWalletQrMatrix({
        size,
        rows: Array.from({ length: size }, () => "0".repeat(size)),
      }).size).toBe(size);
    }

    for (const size of [
      walletQrMatrixSizeLimits.minimum - 1,
      walletQrMatrixSizeLimits.maximum + 1,
    ]) {
      expect(() => parseWalletQrMatrix({
        size,
        rows: Array.from({ length: size }, () => "0".repeat(size)),
      })).toThrow();
    }
  });

  it("binds terminal results to the operation kind and canonical connection state", () => {
    const parsed = parseWalletManagementOperation(operation());
    expect(parsed.result).toEqual({ outcome: "already_disconnected", connection: disconnected });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.result)).toBe(true);
    expect(Object.isFrozen(parsed.result?.connection)).toBe(true);

    expect(() => parseWalletManagementOperation(operation({
      kind: "connect",
      result: { outcome: "connected", connection: disconnected },
    }))).toThrow();
    expect(() => parseWalletManagementOperation(operation({
      kind: "disconnect",
      result: { outcome: "connected", connection: connected },
    }))).toThrow();

    for (const nonDisconnectedConnection of [connected, unknown, unresolved]) {
      expect(() => parseWalletManagementOperation(operation({
        result: { outcome: "already_disconnected", connection: nonDisconnectedConnection },
      }))).toThrow();
      expect(() => parseWalletManagementOperation(operation({
        result: { outcome: "disconnected", connection: nonDisconnectedConnection },
      }))).toThrow();
    }

    for (const nonConnectedConnection of [disconnected, unknown, unresolved]) {
      expect(() => parseWalletManagementOperation(operation({
        kind: "connect",
        result: { outcome: "connected", connection: nonConnectedConnection },
      }))).toThrow();
    }

    expect(parseWalletManagementOperation(operation({
      result: { outcome: "disconnected", connection: disconnected },
    })).result).toEqual({ outcome: "disconnected", connection: disconnected });
    expect(parseWalletManagementOperation(operation({
      kind: "connect",
      result: { outcome: "connected", connection: connected },
    })).result).toEqual({ outcome: "connected", connection: connected });
  });

  it("owns terminal-state classification with the operation-state authority", () => {
    expect(walletOperationStates.map((state) => [state, isWalletOperationTerminalState(state)])).toEqual([
      ["starting_connection", false],
      ["awaiting_confirmation", false],
      ["awaiting_wallet_approval", false],
      ["disconnecting", false],
      ["cancelling", false],
      ["validating_session", false],
      ["completed", true],
      ["cancelled", true],
      ["rejected", true],
      ["failed", true],
      ["expired", true],
    ]);
    expect(walletOperationStates.filter(isWalletOperationConfirmableState))
      .toEqual(["awaiting_confirmation"]);
    expect(walletOperationStates.filter(isWalletOperationCancellableState))
      .toEqual(["starting_connection", "awaiting_confirmation", "awaiting_wallet_approval"]);
  });

  it("binds each operation kind to exactly its reachable lifecycle states", () => {
    const allowedStates = {
      connect: [
        "starting_connection",
        "awaiting_wallet_approval",
        "cancelling",
        "validating_session",
        "completed",
        "cancelled",
        "rejected",
        "failed",
        "expired",
      ],
      disconnect: [
        "awaiting_confirmation",
        "disconnecting",
        "completed",
        "cancelled",
        "failed",
        "expired",
      ],
    } as const;
    const failure = createWalletFailure("runtime_state_unavailable");

    for (const kind of ["connect", "disconnect"] as const) {
      for (const state of walletOperationStates) {
        const candidate = operation({
          kind,
          state,
          result: state === "completed"
            ? kind === "disconnect"
              ? { outcome: "already_disconnected", connection: disconnected }
              : { outcome: "connected", connection: connected }
            : null,
          failure: state === "failed" ? failure : null,
        });
        if ((allowedStates[kind] as readonly string[]).includes(state)) {
          expect(parseWalletManagementOperation(candidate)).toMatchObject({ kind, state });
        } else {
          expect(() => parseWalletManagementOperation(candidate)).toThrow();
        }
      }
    }
  });

  it("accepts only canonical failures in failed operations", () => {
    const independentFailures = [
      {
        ok: false,
        error: {
          code: "internal_error",
          category: "internal",
          message: "The request could not be completed.",
          retryable: false,
          issues: [],
        },
      },
      {
        ok: false,
        error: {
          code: "runtime_state_unavailable",
          category: "runtime",
          message: "Local runtime state is unavailable.",
          retryable: false,
          issues: [],
        },
      },
      {
        ok: false,
        error: {
          code: "wallet_session_unusable",
          category: "wallet",
          message: "The WalletConnect session cannot satisfy this request.",
          retryable: false,
          issues: [],
        },
      },
      {
        ok: false,
        error: {
          code: "wallet_timeout",
          category: "wallet",
          message: "The wallet request timed out.",
          retryable: true,
          issues: [],
        },
      },
    ] as const;

    for (const failure of independentFailures) {
      expect(parseWalletManagementOperation(operation({
        state: "failed",
        result: null,
        failure,
      })).failure).toEqual(failure);
      expect(() => parseWalletManagementOperation(operation({
        state: "failed",
        result: null,
        failure: {
          ...failure,
          error: { ...failure.error, category: "domain" },
        },
      }))).toThrow();
    }

    expect(() => parseWalletManagementOperation(operation({
      state: "failed",
      result: null,
      failure: {
        ...independentFailures[3],
        error: { ...independentFailures[3].error, message: "forged" },
      },
    }))).toThrow();

    for (const code of [
      "invalid_input",
      "state_conflict",
      "interactive_terminal_required",
      "wallet_user_rejected",
    ]) {
      expect(() => parseWalletManagementOperation(operation({
        state: "failed",
        result: null,
        failure: createWalletFailure(code),
      }))).toThrow();
    }

    expect(() => parseWalletManagementOperation(operation({
      state: "failed",
      result: null,
      failure: {
        ...independentFailures[3],
        error: {
          ...independentFailures[3].error,
          issues: [{
            path: "/operation",
            code: "invalid_value",
            message: "The field value is invalid.",
          }],
        },
      },
    }))).toThrow();
  });

  it("keeps QR material outside the canonical operation and only on pending approval responses", () => {
    const qr = { size: 21, rows: Array.from({ length: 21 }, () => "0".repeat(21)) };
    const pending = operation({
      kind: "connect",
      state: "awaiting_wallet_approval",
      result: null,
    });
    expect(walletOperationAllowsQr(parseWalletManagementOperation(pending))).toBe(true);
    expect(walletOperationAllowsQr(parseWalletManagementOperation(operation()))).toBe(false);
    const response = parseWalletOperationResponse({ operation: pending, qr });
    expect(response.qr).toEqual(qr);
    expect("qr" in response.operation).toBe(false);
    expect(() => parseWalletOperationResponse({ operation: operation(), qr })).toThrow();
    expect(() => parseWalletOperationResponse({
      operation: operation({
        kind: "disconnect",
        state: "awaiting_wallet_approval",
        result: null,
      }),
      qr,
    })).toThrow();
  });

  it("owns strict start and current-operation contracts without assuming every start creates an operation", () => {
    expect(parseWalletOperationCreate({
      control: { operationId, interactionInterface: "cli" },
      request: { kind: "connect", connectionRevision: null },
    })).toEqual({
      operationId,
      kind: "connect",
      interactionInterface: "cli",
      connectionRevision: null,
    });
    for (const interactionInterface of ["mcp", "CLI", "browser", "", null, undefined]) {
      expect(() => parseWalletOperationCreate({
        control: { operationId, interactionInterface },
        request: { kind: "connect", connectionRevision: null },
      })).toThrow();
    }
    expect(() => parseWalletOperationCreate({
      control: { operationId, interactionInterface: "web", extra: true },
      request: { kind: "connect", connectionRevision: null },
    })).toThrow();
    expect(() => parseWalletOperationCreate({
      control: { operationId, interactionInterface: "web" },
      request: { kind: "other", connectionRevision: "3" },
    })).toThrow();
    expect(() => parseWalletOperationCreate({
      control: { operationId, interactionInterface: "web" },
      request: { kind: "connect" },
    })).toThrow();
    expect(parseWalletWebOperationCreate({
      kind: "connect",
      connectionRevision: "3",
    })).toEqual({ kind: "connect", connectionRevision: "3" });
    expect(() => parseWalletWebOperationCreate({ kind: "connect" })).toThrow();
    expect(() => parseWalletWebOperationCreate({
      kind: "connect",
      connectionRevision: "3",
      extra: true,
    })).toThrow();

    const current = parseWalletOperationStartResponse({
      result: {
        status: "current_connection",
        connectionRevision: "3",
        connection: connected,
      },
    });
    expect(current.result).toEqual({
      status: "current_connection",
      connectionRevision: "3",
      connection: connected,
    });
    expect(() => parseWalletOperationStartResponse({ ...current, qr: {
      size: 21,
      rows: Array.from({ length: 21 }, () => "0".repeat(21)),
    } })).toThrow();

    const startedOperation = operation({
      kind: "disconnect",
      state: "awaiting_confirmation",
      result: null,
    });
    expect(parseWalletOperationStartResponse({
      result: { status: "operation_started", operation: startedOperation },
    }).result).toEqual({ status: "operation_started", operation: startedOperation });

    expect(parseWalletCurrentOperationProjection({
      status: "absent",
      connectionRevision: "3",
      connection: connected,
    })).toEqual({
      status: "absent",
      connectionRevision: "3",
      connection: connected,
    });
    const presentation = parseWalletOperationPresentation({
      operation: startedOperation,
      access: "interactive",
    });
    expect(parseWalletCurrentOperationProjection({
      status: "present",
      connectionRevision: "4",
      connection: disconnected,
      presentation,
    })).toEqual({
      status: "present",
      connectionRevision: "4",
      connection: disconnected,
      presentation,
    });
    const terminalPresentation = parseWalletOperationPresentation({
      operation: operation({
        kind: "connect",
        state: "cancelled",
        result: null,
      }),
      access: "interactive",
    });
    expect(terminalPresentation.operation.state).toBe("cancelled");
    expect(() => parseWalletCurrentOperationProjection({
      status: "present",
      connectionRevision: "4",
      connection: disconnected,
      presentation: terminalPresentation,
    })).toThrow();
  });

  it("binds operation, interface access, and optional QR into one exact presentation snapshot", async () => {
    const qr = { size: 21, rows: Array.from({ length: 21 }, () => "0".repeat(21)) };
    const pending = operation({
      kind: "connect",
      state: "awaiting_wallet_approval",
      result: null,
    });
    const port: WalletOperationPresentationPort = Object.freeze({
      async get(id: string) {
        expect(id).toBe(operationId);
        return parseWalletOperationPresentation({ operation: pending, qr, access: "read_only" });
      },
    });

    const presentation = await port.get(operationId);
    expect(presentation).toEqual({ operation: pending, qr, access: "read_only" });
    expect(Object.keys(presentation).sort()).toEqual(["access", "operation", "qr"]);
    expect(Object.isFrozen(presentation)).toBe(true);
    expect(Object.isFrozen(presentation.operation)).toBe(true);
    expect(Object.isFrozen(presentation.qr)).toBe(true);
    expect(Object.isFrozen(presentation.qr?.rows)).toBe(true);

    const confirmation = operation({
      kind: "disconnect",
      state: "awaiting_confirmation",
      result: null,
    });
    expect(parseWalletOperationPresentation({
      operation: confirmation,
      access: "interactive",
    })).toEqual({ operation: confirmation, access: "interactive" });
    expect(() => parseWalletOperationPresentation({ operation: pending, qr, access: "other" })).toThrow();
    expect(() => parseWalletOperationPresentation({ operation: operation(), qr, access: "read_only" })).toThrow();
    expect(() => parseWalletOperationPresentation({
      operation: pending,
      qr,
      access: "read_only",
      uri: "wc:secret",
    })).toThrow();
  });

  it("binds confirmation ports to one interaction interface and response shape", async () => {
    const cliResponse = parseWalletOperationResponse({
      operation: operation({ kind: "connect", state: "awaiting_wallet_approval", result: null }),
      qr: { size: 21, rows: Array.from({ length: 21 }, () => "0".repeat(21)) },
    });
    const cli: WalletOperationConfirmationPort<"cli"> = Object.freeze({
      interactionInterface: "cli",
      confirm: async () => cliResponse,
    });
    const webOperation = parseWalletManagementOperation(operation());
    const web: WalletOperationConfirmationPort<"web"> = Object.freeze({
      interactionInterface: "web",
      confirm: async () => webOperation,
    });

    const confirmation = parseWalletOperationConfirmation({ connectionRevision: "3" });
    await expect(cli.confirm(operationId, confirmation)).resolves.toEqual(cliResponse);
    await expect(web.confirm(operationId, confirmation)).resolves.toEqual(webOperation);
    expect(cli.interactionInterface).toBe("cli");
    expect(web.interactionInterface).toBe("web");
  });

  it("rejects extra fields and hostile accessors without evaluating them", () => {
    expect(() => parseWalletManagementOperation({ ...operation(), extra: true })).toThrow();
    let evaluated = false;
    const hostile = { ...operation() };
    Object.defineProperty(hostile, "state", {
      enumerable: true,
      get() {
        evaluated = true;
        throw new Error("secret");
      },
    });
    expect(() => parseWalletManagementOperation(hostile)).toThrow();
    expect(evaluated).toBe(false);
  });
});
