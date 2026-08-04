import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { WalletTaskDialog } from "../../../src/interfaces/web/wallet-task-dialog.js";
import {
  parseWalletOperationPresentation,
} from "../../../src/wallet/operation-contract.js";

const operationId = "A".repeat(43);
const deliveryUnknown = Object.freeze({
  status: "delivery_unknown" as const,
  action: "start" as const,
  operationId,
  resendAllowed: false as const,
});
const callbacks = Object.freeze({
  onClose: vi.fn(),
  onAction: vi.fn(),
});

describe("wallet task dialog", () => {
  it("keeps the Connect task title while its matching delivery is unknown", () => {
    const markup = renderToStaticMarkup(createElement(WalletTaskDialog, {
      task: "wallet_connect",
      connectionRevision: "1",
      operationId,
      operationPresentation: undefined,
      pending: false,
      pendingAction: undefined,
      pendingOperationId: undefined,
      delivery: {
        task: "connect",
        connectionRevision: "1",
        result: deliveryUnknown,
      },
      actionFailure: undefined,
      ...callbacks,
    }));

    expect(markup).toContain(">Connect wallet<");
    expect(markup).toContain("Connection status unknown");
    expect(markup).toContain(operationId);
    expect(markup).not.toContain("Disconnect wallet");
  });

  it("does not project delivery from another wallet task or revision", () => {
    const otherTask = renderToStaticMarkup(createElement(WalletTaskDialog, {
      task: "wallet_connect",
      connectionRevision: "1",
      operationId,
      operationPresentation: undefined,
      pending: false,
      pendingAction: undefined,
      pendingOperationId: undefined,
      delivery: {
        task: "disconnect",
        connectionRevision: "1",
        result: deliveryUnknown,
      },
      actionFailure: undefined,
      ...callbacks,
    }));
    const otherRevision = renderToStaticMarkup(createElement(WalletTaskDialog, {
      task: "wallet_connect",
      connectionRevision: "1",
      operationId,
      operationPresentation: undefined,
      pending: false,
      pendingAction: undefined,
      pendingOperationId: undefined,
      delivery: {
        task: "connect",
        connectionRevision: "2",
        result: deliveryUnknown,
      },
      actionFailure: undefined,
      ...callbacks,
    }));

    expect(otherTask).not.toContain("Connection status unknown");
    expect(otherRevision).not.toContain("Connection status unknown");
    expect(otherTask).toContain("Starting wallet connection");
    expect(otherRevision).toContain("Starting wallet connection");
  });

  it("states the profile-wide disconnect effect without a count-dependent action", () => {
    const presentation = parseWalletOperationPresentation({
      operation: {
        operationId,
        kind: "disconnect",
        state: "awaiting_confirmation",
        connectionRevision: "1",
        actionExpiresAt: "2099-12-31T23:59:59.000Z",
        interactionInterface: "web",
        result: null,
        failure: null,
        peerRefusalCode: null,
      },
      access: "interactive",
    });
    const markup = renderToStaticMarkup(createElement(WalletTaskDialog, {
      task: "wallet_disconnect",
      connectionRevision: "1",
      operationId,
      operationPresentation: presentation,
      pending: false,
      pendingAction: undefined,
      pendingOperationId: undefined,
      delivery: undefined,
      actionFailure: undefined,
      ...callbacks,
    }));

    expect(markup).toContain("Remove every wallet session from this local profile.");
    expect(markup).toContain(">Disconnect<");
    expect(markup).not.toContain("current wallet session");
  });
});
