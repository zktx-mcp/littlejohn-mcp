import { describe, expect, it } from "vitest";

import {
  isWalletOperationTerminalState,
  parseWalletManagementOperation,
  parseWalletOperationConfirmation,
  parseWalletOperationPresentation,
  parseWalletOperationResponse,
  walletOperationStates,
  type WalletOperationConfirmationPort,
  type WalletOperationPresentationPort,
} from "../../src/wallet/contracts.js";
import { createWalletFailure } from "../../src/wallet/errors.js";

const operationId = Buffer.alloc(32, 7).toString("base64url");
const disconnected = Object.freeze({ status: "disconnected", reason: "no_session" });
const connected = Object.freeze({
  status: "connected",
  account: "eip155:4663:0x1111111111111111111111111111111111111111",
  address: "0x1111111111111111111111111111111111111111",
  chainId: "eip155:4663",
  approvedMethods: ["eth_sendTransaction"],
  approvedEvents: ["accountsChanged", "chainChanged"],
  expiresAt: "2026-07-14T01:10:00.000Z",
});
const unknown = Object.freeze({ status: "unknown", reason: "reconciling" });
const unresolved = Object.freeze({ status: "unresolved", eligibleSessionCount: "2" });

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

describe("wallet management contracts", () => {
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
      ["awaiting_confirmation", false],
      ["awaiting_wallet_approval", false],
      ["disconnecting", false],
      ["validating_session", false],
      ["completed", true],
      ["cancelled", true],
      ["rejected", true],
      ["failed", true],
      ["expired", true],
    ]);
  });

  it("binds each operation kind to exactly its reachable lifecycle states", () => {
    const allowedStates = {
      connect: [
        "awaiting_confirmation",
        "awaiting_wallet_approval",
        "disconnecting",
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
            ? kind === "connect"
              ? { outcome: "connected", connection: connected }
              : { outcome: "already_disconnected", connection: disconnected }
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
    const failure = createWalletFailure("wallet_timeout");
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
        error: { ...failure.error, message: "forged" },
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
        ...failure,
        error: {
          ...failure.error,
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
      kind: "connect",
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
