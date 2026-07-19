import { describe, expect, it } from "vitest";

import { walletConnectionDataSchema } from "../../../src/core/browser.js";
import {
  parseWalletCurrentOperationProjection,
  parseWalletManagementOperation,
  parseWalletOperationPresentation,
} from "../../../src/wallet/operation-contract.js";
import {
  isWalletOperationTerminalState,
  walletOperationKinds,
  walletOperationStatesForKind,
} from "../../../src/wallet/operation-state.js";
import { createWalletFailure } from "../../../src/wallet/errors.js";
import {
  walletConnectionActions,
  walletConnectionCopy,
  walletDisconnectActionLabel,
  walletConnectionFields,
  walletNavigationLabel,
  walletOperationActions,
  walletOperationCopy,
  walletOperationNotice,
  walletOperationNotification,
} from "../../../src/interfaces/web/wallet-dialog-view.js";

const operationBase = Object.freeze({
  operationId: "A".repeat(43),
  connectionRevision: "1",
  expiresAt: "2099-12-31T23:59:59.000Z",
});

const connectedAddress = "0x1111111111111111111111111111111111111111";
const connected = walletConnectionDataSchema.parse({
  status: "connected",
  address: connectedAddress,
  chainId: "eip155:4663",
  approvedMethods: ["eth_sendTransaction"],
  approvedEvents: ["accountsChanged", "chainChanged"],
  expiresAt: "2099-12-31T23:59:59.000Z",
});

const absent = (connection: unknown) => parseWalletCurrentOperationProjection({
  status: "absent",
  connectionRevision: "1",
  connection,
});

const operation = (
  kind: "connect" | "disconnect",
  state: string,
) => parseWalletManagementOperation({
  ...operationBase,
  kind,
  state,
  result: null,
  failure: null,
});

describe("wallet dialog view", () => {
  it("rejects removed wallet identity and session-count fields", () => {
    expect(() => walletConnectionDataSchema.parse({
      ...connected,
      account: `eip155:4663:${connectedAddress}`,
    })).toThrow();
    expect(() => walletConnectionDataSchema.parse({
      status: "unresolved",
      eligibleSessionCount: "2",
    })).toThrow();
  });

  it("uses the concise navigation label and exact connection actions", () => {
    const live = absent(connected);
    const unknown = absent({ status: "unknown", reason: "reconciling" });
    const unresolved = absent({ status: "unresolved", sessionCount: "2" });
    const unusableStore = absent({ status: "disconnected", reason: "unusable_store" });

    expect(walletNavigationLabel(undefined)).toBe("Wallet");
    expect(walletNavigationLabel(live)).toBe("Wallet");
    expect(walletNavigationLabel(unusableStore)).toBe("Wallet");
    for (const reason of ["no_session", "expired", "deleted", "disconnected"] as const) {
      const disconnected = absent({ status: "disconnected", reason });
      expect(walletNavigationLabel(disconnected), reason).toBe("Connect wallet");
      expect(walletConnectionActions(disconnected), reason).toEqual(["connect"]);
    }
    expect(walletConnectionActions(live)).toEqual(["disconnect"]);
    expect(walletConnectionActions(unknown)).toEqual([]);
    expect(walletConnectionActions(unresolved)).toEqual(["disconnect"]);
    expect(walletConnectionActions(unusableStore)).toEqual(["disconnect"]);
    expect(walletDisconnectActionLabel(live.connection)).toBe("Disconnect wallet");
    expect(walletDisconnectActionLabel(unresolved.connection)).toBe("Disconnect all sessions");
  });

  it("suppresses connection mutations while one nonterminal operation is present", () => {
    const presentation = parseWalletOperationPresentation({
      operation: operation("connect", "awaiting_wallet_approval"),
      access: "interactive",
    });
    const present = parseWalletCurrentOperationProjection({
      status: "present",
      connectionRevision: "1",
      connection: { status: "disconnected", reason: "no_session" },
      presentation,
    });

    expect(walletNavigationLabel(present)).toBe("Wallet");
    expect(walletConnectionActions(present)).toEqual([]);
    expect(walletOperationActions(presentation)).toEqual(["cancel"]);
  });

  it("derives exact operation actions from canonical state and presentation access", () => {
    const confirmation = parseWalletOperationPresentation({
      operation: operation("disconnect", "awaiting_confirmation"),
      access: "interactive",
    });
    const approval = parseWalletOperationPresentation({
      operation: operation("connect", "awaiting_wallet_approval"),
      access: "interactive",
    });
    const readOnly = parseWalletOperationPresentation({
      operation: operation("disconnect", "awaiting_confirmation"),
      access: "read_only",
    });
    const disconnecting = parseWalletOperationPresentation({
      operation: operation("disconnect", "disconnecting"),
      access: "interactive",
    });

    expect(walletOperationActions(confirmation)).toEqual(["confirm", "cancel"]);
    expect(walletOperationActions(approval)).toEqual(["cancel"]);
    expect(walletOperationActions(readOnly)).toEqual([]);
    expect(walletOperationActions(disconnecting)).toEqual([]);
    expect(walletOperationNotice(readOnly)).toMatch(/controlled by the CLI/u);
    expect(walletOperationNotice(confirmation)).toBeUndefined();
  });

  it("covers every nonterminal operation kind and state without interface-owned exceptions", () => {
    for (const kind of walletOperationKinds) {
      for (const state of walletOperationStatesForKind(kind)) {
        if (isWalletOperationTerminalState(state)) continue;
        const presentation = parseWalletOperationPresentation({
          operation: operation(kind, state),
          access: "interactive",
        });
        const expected = state === "awaiting_confirmation"
          ? ["confirm", "cancel"]
          : state === "starting_connection" || state === "awaiting_wallet_approval"
            ? ["cancel"]
            : [];
        expect(walletOperationActions(presentation), `${kind}:${state}`)
          .toEqual(expected);
        expect(walletOperationActions(parseWalletOperationPresentation({
          operation: operation(kind, state),
          access: "read_only",
        })), `${kind}:${state}:read_only`).toEqual([]);
      }
    }
  });

  it("shows one human connection projection without technical duplicate fields", () => {
    expect(walletConnectionCopy(connected)).toEqual({
      heading: "Wallet connected",
      message: "The Robinhood Chain session is ready.",
    });
    expect(walletConnectionFields(connected)).toEqual([
      { label: "Address", value: connectedAddress },
      { label: "Network", value: "Robinhood Chain" },
    ]);
    const serialized = JSON.stringify({
      copy: walletConnectionCopy(connected),
      fields: walletConnectionFields(connected),
    });
    expect(serialized).not.toContain("connectionRevision");
    expect(serialized).not.toContain("expiresAt");
    expect(serialized).not.toContain("status");
    expect(walletConnectionCopy({ status: "disconnected", reason: "unusable_store" })).toEqual({
      heading: "Wallet connection needs attention",
      message: "Disconnect the existing local wallet session before connecting again.",
    });
  });

  it("uses distinct copy for connection and disconnection", () => {
    const connection = walletOperationCopy(operation("connect", "awaiting_wallet_approval"));
    const cancelling = walletOperationCopy(operation("connect", "cancelling"));

    expect(connection.heading).toBe("Connect Robinhood Wallet");
    expect(connection.message).toBe(
      "Scan this QR code with Robinhood Wallet and approve the Robinhood Chain session. This does not sign or send a transaction.",
    );
    expect(walletOperationCopy(operation("disconnect", "awaiting_confirmation")).heading)
      .toBe("Disconnect wallet");
    expect(cancelling).toEqual({
      heading: "Cancelling wallet connection",
      message: "The pending wallet connection request is being cancelled.",
    });
  });

  it("maps terminal outcomes to one success, neutral, or error notification", () => {
    const connectedCompletion = parseWalletManagementOperation({
      ...operationBase,
      kind: "connect",
      state: "completed",
      result: { outcome: "connected", connection: connected },
      failure: null,
    });
    const disconnectedCompletion = parseWalletManagementOperation({
      ...operationBase,
      kind: "disconnect",
      state: "completed",
      result: {
        outcome: "disconnected",
        connection: { status: "disconnected", reason: "disconnected" },
      },
      failure: null,
    });
    const alreadyDisconnected = parseWalletManagementOperation({
      ...operationBase,
      kind: "disconnect",
      state: "completed",
      result: {
        outcome: "already_disconnected",
        connection: { status: "disconnected", reason: "no_session" },
      },
      failure: null,
    });
    const failedConnection = parseWalletManagementOperation({
      ...operationBase,
      kind: "connect",
      state: "failed",
      result: null,
      failure: createWalletFailure("wallet_timeout"),
    });

    expect(walletOperationNotification(connectedCompletion)).toEqual({
      id: operationBase.operationId,
      tone: "success",
      heading: "Wallet connected",
      message: "The Robinhood Chain session is ready.",
    });
    expect(walletOperationNotification(disconnectedCompletion)).toEqual({
      id: operationBase.operationId,
      tone: "success",
      heading: "Wallet disconnected",
      message: "No wallet session remains in this local profile.",
    });
    expect(walletOperationNotification(alreadyDisconnected)?.tone).toBe("neutral");
    expect(walletOperationNotification(operation("connect", "cancelled"))).toMatchObject({
      tone: "neutral",
      heading: "Wallet connection cancelled",
    });
    expect(walletOperationNotification(operation("connect", "rejected"))).toMatchObject({
      tone: "error",
      heading: "Wallet connection rejected",
    });
    expect(walletOperationNotification(operation("connect", "expired"))).toMatchObject({
      tone: "error",
      heading: "Wallet connection expired",
    });
    expect(walletOperationNotification(failedConnection)).toMatchObject({
      tone: "error",
      heading: "Wallet connection failed",
      message: createWalletFailure("wallet_timeout").error.message,
    });
    expect(walletOperationNotification(operation("connect", "awaiting_wallet_approval")))
      .toBeUndefined();
  });
});
