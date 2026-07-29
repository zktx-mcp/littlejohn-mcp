import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { WalletTaskDialog } from "../../../src/interfaces/web/wallet-task-dialog.js";
import {
  parseWalletCurrentOperationProjection,
} from "../../../src/wallet/operation-contract.js";

const operationId = "A".repeat(43);
const disconnected = parseWalletCurrentOperationProjection({
  status: "absent",
  connectionRevision: "1",
  connection: {
    status: "disconnected",
    reason: "no_session",
  },
});
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
      wallet: disconnected,
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
      wallet: disconnected,
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
      wallet: disconnected,
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
});
