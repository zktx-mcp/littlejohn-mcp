import { describe, expect, it } from "vitest";

import {
  parseWalletCurrentOperationProjection,
  parseWalletManagementOperation,
  parseWalletOperationCancellation,
  parseWalletOperationConfirmation,
  parseWalletOperationCreate,
  parseWalletOperationId,
  parseWalletOperationPresentation,
  parseWalletOperationPresentationAccess,
  parseWalletOperationStartResult,
  parseWalletQrMatrix,
  parseWalletWebOperationCreate,
  walletOperationFailureCodes,
  walletOperationIdByteLength,
  walletOperationOutcomes,
  walletPeerRefusalCodes,
  walletQrMatrixSizeLimits,
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
import {
  createWalletFailure,
  walletInterfaceErrorMappings,
} from "../../src/wallet/errors.js";

const operationId = Buffer.alloc(walletOperationIdByteLength, 7).toString("base64url");
const actionExpiresAt = "2026-07-14T01:05:00.000Z";
const disconnected = Object.freeze({ status: "disconnected", reason: "no_session" });
const connected = Object.freeze({
  status: "connected",
  address: "0x1111111111111111111111111111111111111111",
  chainId: "eip155:4663",
  approvedMethods: ["eth_sendTransaction"],
  approvedEvents: ["accountsChanged", "chainChanged"],
  expiresAt: "2026-07-14T01:10:00.000Z",
});
const qr = {
  size: 21,
  rows: Array.from({ length: 21 }, () => "0".repeat(21)),
};

const operation = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  operationId,
  kind: "disconnect",
  state: "completed",
  connectionRevision: "3",
  actionExpiresAt,
  interactionInterface: "web",
  result: { outcome: "already_disconnected", connection: disconnected },
  failure: null,
  peerRefusalCode: null,
  ...overrides,
});

describe("wallet management contracts", () => {
  it("owns exact identifiers, interfaces, outcomes, and QR dimensions", () => {
    expect(walletInteractionInterfaces).toEqual(["cli", "web"]);
    expect(walletOperationKinds).toEqual(["connect", "disconnect"]);
    expect(walletOperationOutcomes).toEqual({
      connect: ["connected"],
      disconnect: ["disconnected", "already_disconnected"],
    });
    expect(walletQrMatrixSizeLimits).toEqual({ minimum: 21, maximum: 177 });
    expect(parseWalletOperationId(operationId)).toBe(operationId);
    expect(parseWalletOperationPresentationAccess("interactive")).toBe("interactive");
    expect(parseWalletOperationPresentationAccess("read_only")).toBe("read_only");
    expect(parseWalletQrMatrix(qr)).toEqual(qr);

    expect(() => parseWalletOperationId(`${operationId}=`)).toThrow();
    expect(() => parseWalletOperationPresentationAccess("mcp")).toThrow();
    expect(() => parseWalletQrMatrix({ ...qr, rows: qr.rows.slice(1) })).toThrow();
  });

  it("admits one strict command shape and keeps local control separate from web creation", () => {
    expect(parseWalletOperationCreate({
      control: { operationId, interactionInterface: "cli" },
      request: { kind: "connect", connectionRevision: null },
    })).toEqual({
      operationId,
      interactionInterface: "cli",
      kind: "connect",
      connectionRevision: null,
    });
    expect(parseWalletWebOperationCreate({
      kind: "disconnect",
      connectionRevision: "3",
    })).toEqual({ kind: "disconnect", connectionRevision: "3" });
    expect(parseWalletOperationConfirmation({ connectionRevision: "3" }))
      .toEqual({ connectionRevision: "3" });
    expect(parseWalletOperationCancellation({ operationId, connectionRevision: "3" }))
      .toEqual({ operationId, connectionRevision: "3" });

    expect(() => parseWalletOperationCreate({
      control: { operationId, interactionInterface: "mcp" },
      request: { kind: "connect", connectionRevision: null },
    })).toThrow();
    expect(() => parseWalletOperationCreate({
      operationId,
      interactionInterface: "cli",
      kind: "connect",
      connectionRevision: null,
    })).toThrow();
    expect(() => parseWalletWebOperationCreate({ kind: "connect" })).toThrow();
    expect(() => parseWalletOperationCancellation({ operationId })).toThrow();
  });

  it("binds immutable action and interface identity into every operation", () => {
    const parsed = parseWalletManagementOperation(operation());
    expect(parsed).toMatchObject({
      operationId,
      connectionRevision: "3",
      actionExpiresAt,
      interactionInterface: "web",
    });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.result)).toBe(true);

    const { actionExpiresAt: _action, ...withoutAction } = operation();
    expect(() => parseWalletManagementOperation(withoutAction)).toThrow();
    const { interactionInterface: _interface, ...withoutInterface } = operation();
    expect(() => parseWalletManagementOperation(withoutInterface)).toThrow();
    expect(() => parseWalletManagementOperation({ ...operation(), expiresAt: actionExpiresAt })).toThrow();
    expect(() => parseWalletManagementOperation({ ...operation(), qr })).toThrow();
  });

  it("derives reachable states and their only legal payload from one state authority", () => {
    const allowed = {
      connect: new Set([
        "starting_connection", "awaiting_wallet_approval", "cancelling",
        "validating_session", "completed", "cancelled", "rejected", "failed", "expired",
      ]),
      disconnect: new Set([
        "awaiting_confirmation", "disconnecting", "completed", "cancelled", "failed", "expired",
      ]),
    } as const;
    expect(walletOperationStates.map((state) => ({
      state,
      terminal: isWalletOperationTerminalState(state),
      confirmable: isWalletOperationConfirmableState(state),
      cancellable: isWalletOperationCancellableState(state),
      payload: walletOperationStateDefinitions[state].payload,
    }))).toEqual(walletOperationStates.map((state) => ({
      state,
      terminal: walletOperationStateDefinitions[state].terminal,
      confirmable: walletOperationStateDefinitions[state].confirmable,
      cancellable: walletOperationStateDefinitions[state].cancellable,
      payload: walletOperationStateDefinitions[state].payload,
    })));

    for (const kind of walletOperationKinds) {
      for (const state of walletOperationStates) {
        const candidate = operation({
          kind,
          state,
          result: state === "completed"
            ? kind === "connect"
              ? { outcome: "connected", connection: connected }
              : { outcome: "disconnected", connection: disconnected }
            : null,
          failure: state === "failed" ? createWalletFailure("runtime_state_unavailable") : null,
          peerRefusalCode: state === "rejected" ? 5001 : null,
        });
        if (allowed[kind].has(state as never)) {
          expect(parseWalletManagementOperation(candidate)).toMatchObject({ kind, state });
        } else {
          expect(() => parseWalletManagementOperation(candidate)).toThrow();
        }
      }
    }
  });

  it("binds completed outcomes to the operation kind and connection status", () => {
    expect(parseWalletManagementOperation(operation()).result)
      .toEqual({ outcome: "already_disconnected", connection: disconnected });
    expect(parseWalletManagementOperation(operation({
      kind: "connect",
      result: { outcome: "connected", connection: connected },
    })).result).toEqual({ outcome: "connected", connection: connected });

    expect(() => parseWalletManagementOperation(operation({
      kind: "connect",
      result: { outcome: "connected", connection: disconnected },
    }))).toThrow();
    expect(() => parseWalletManagementOperation(operation({
      result: { outcome: "already_disconnected", connection: connected },
    }))).toThrow();
  });

  it("keeps canonical local failures and numeric peer refusals mutually exclusive", () => {
    expect(walletOperationFailureCodes).toEqual([
      "internal_error",
      "runtime_state_unavailable",
      "state_conflict",
      "wallet_pairing_code_unavailable",
      "wallet_session_unusable",
      "wallet_timeout",
      "walletconnect_unavailable",
    ]);
    for (const code of walletOperationFailureCodes) {
      const failed = parseWalletManagementOperation(operation({
        state: "failed",
        result: null,
        failure: createWalletFailure(code),
      }));
      expect(failed.failure?.error.code).toBe(code);
    }

    for (const peerRefusalCode of walletPeerRefusalCodes) {
      expect(parseWalletManagementOperation(operation({
        kind: "connect",
        state: "rejected",
        result: null,
        failure: null,
        peerRefusalCode,
      }))).toMatchObject({ state: "rejected", peerRefusalCode });
    }
    expect(() => parseWalletManagementOperation(operation({
      kind: "connect",
      state: "rejected",
      result: null,
      peerRefusalCode: 5004,
    }))).toThrow();
    expect(() => parseWalletManagementOperation(operation({
      state: "failed",
      result: null,
      failure: createWalletFailure("wallet_timeout"),
      peerRefusalCode: 5001,
    }))).toThrow();
  });

  it("owns the exact local deadline, pairing-code, and WalletConnect failure meanings", () => {
    expect(createWalletFailure("wallet_timeout")).toEqual({
      ok: false,
      error: {
        code: "wallet_timeout",
        category: "wallet",
        message: "The wallet action exceeded Little John's local action deadline.",
        retryable: false,
        issues: [],
      },
    });
    expect(createWalletFailure("wallet_pairing_code_unavailable")).toEqual({
      ok: false,
      error: {
        code: "wallet_pairing_code_unavailable",
        category: "internal",
        message: "The wallet pairing code could not be created.",
        retryable: false,
        issues: [],
      },
    });
    expect(createWalletFailure("walletconnect_unavailable")).toEqual({
      ok: false,
      error: {
        code: "walletconnect_unavailable",
        category: "wallet",
        message: "WalletConnect could not complete the wallet action.",
        retryable: false,
        issues: [],
      },
    });
    expect(walletInterfaceErrorMappings.get("wallet_timeout")).toEqual({
      code: "wallet_timeout",
      httpStatus: 504,
      problemTitle: "Wallet action deadline exceeded",
      cliExitCode: 4,
    });
    expect(walletInterfaceErrorMappings.get("wallet_pairing_code_unavailable")).toEqual({
      code: "wallet_pairing_code_unavailable",
      httpStatus: 500,
      problemTitle: "Wallet pairing code unavailable",
      cliExitCode: 1,
    });
    expect(walletInterfaceErrorMappings.get("walletconnect_unavailable")).toEqual({
      code: "walletconnect_unavailable",
      httpStatus: 503,
      problemTitle: "WalletConnect unavailable",
      cliExitCode: 4,
    });
  });

  it("keeps QR authority in exact presentation and out of canonical start/read results", () => {
    const pending = operation({
      kind: "connect",
      state: "awaiting_wallet_approval",
      result: null,
    });
    const presentation = parseWalletOperationPresentation({
      operation: pending,
      access: "read_only",
      qr,
    });
    expect(presentation.qr).toEqual(qr);
    expect("qr" in presentation.operation).toBe(false);

    const started = parseWalletOperationStartResult({
      status: "operation_started",
      operation: pending,
    });
    expect(started).toEqual({ status: "operation_started", operation: pending });
    expect(() => parseWalletOperationStartResult({ ...started, qr })).toThrow();
    expect(() => parseWalletOperationStartResult({ result: started })).toThrow();
    expect(() => parseWalletOperationPresentation({ operation: operation(), access: "read_only", qr }))
      .toThrow();
    expect(() => parseWalletOperationPresentation({
      operation: pending,
      access: "read_only",
      qr,
      uri: "wc:secret",
    })).toThrow();
  });

  it("admits terminal exact reads but only nonterminal current-operation projections", () => {
    const terminal = parseWalletManagementOperation(operation());
    expect(terminal.state).toBe("completed");
    expect(parseWalletCurrentOperationProjection({
      status: "absent",
      connectionRevision: "3",
      connection: disconnected,
    })).toMatchObject({ status: "absent" });

    const pending = parseWalletOperationPresentation({
      operation: operation({ state: "awaiting_confirmation", result: null }),
      access: "interactive",
    });
    expect(parseWalletCurrentOperationProjection({
      status: "present",
      connectionRevision: "3",
      connection: connected,
      presentation: pending,
    })).toMatchObject({ status: "present" });
    expect(() => parseWalletCurrentOperationProjection({
      status: "present",
      connectionRevision: "3",
      connection: disconnected,
      presentation: { operation: terminal, access: "interactive" },
    })).toThrow();
  });

  it("rejects extra fields and hostile accessors without reading them", () => {
    expect(() => parseWalletManagementOperation({ ...operation(), extra: true })).toThrow();
    let accessorRead = false;
    const hostile = { ...operation() };
    Object.defineProperty(hostile, "state", {
      enumerable: true,
      get() {
        accessorRead = true;
        throw new Error("secret");
      },
    });
    expect(() => parseWalletManagementOperation(hostile)).toThrow();
    expect(accessorRead).toBe(false);
  });
});
