// @vitest-environment jsdom

import {
  act,
  cleanup,
  render,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  browserOperationCancellationPath,
  browserOperationConfirmationPath,
  browserOperationPath,
  browserWalletApiPaths,
} from "../../../src/interfaces/browser-contract.js";
import type {
  BrowserFetch,
  BrowserFetchResponse,
} from "../../../src/interfaces/web/browser-client.js";
import type { NotificationNotice } from "../../../src/interfaces/web/notification.js";
import {
  useWalletProcess,
  type WalletProcess,
} from "../../../src/interfaces/web/wallet-process.js";
import {
  walletObservationStorageKey,
} from "../../../src/interfaces/web/wallet-observation.js";
import {
  parseWalletCurrentOperationProjection,
  parseWalletManagementOperation,
  parseWalletOperationPresentation,
} from "../../../src/wallet/operation-contract.js";

const csrfToken = "A".repeat(43);
const operationId = "A".repeat(43);
const connectionRevision = "1";
const disconnected = Object.freeze({
  status: "disconnected" as const,
  reason: "no_session" as const,
});
const operationBase = Object.freeze({
  operationId,
  connectionRevision,
  actionExpiresAt: "2099-12-31T23:59:59.000Z",
  interactionInterface: "web",
  kind: "connect" as const,
  result: null,
  failure: null,
  peerRefusalCode: null,
});
const awaitingApproval = parseWalletManagementOperation({
  ...operationBase,
  state: "awaiting_wallet_approval",
});
const cancelled = parseWalletManagementOperation({
  ...operationBase,
  state: "cancelled",
});
const present = parseWalletCurrentOperationProjection({
  status: "present",
  connectionRevision,
  connection: disconnected,
  presentation: parseWalletOperationPresentation({
    operation: awaitingApproval,
    access: "interactive",
  }),
});
const disconnecting = parseWalletManagementOperation({
  ...operationBase,
  kind: "disconnect",
  state: "disconnecting",
});
const disconnectingPresentation = parseWalletOperationPresentation({
  operation: disconnecting,
  access: "interactive",
});
const connected = Object.freeze({
  status: "connected" as const,
  address: `0x${"11".repeat(20)}`,
  chainId: "eip155:4663",
  approvedMethods: Object.freeze(["eth_sendTransaction"]),
  approvedEvents: Object.freeze(["accountsChanged", "chainChanged"]),
  expiresAt: "2099-12-31T23:59:59.000Z",
});
const awaitingDisconnect = parseWalletManagementOperation({
  ...operationBase,
  kind: "disconnect",
  state: "awaiting_confirmation",
});
const completedDisconnect = parseWalletManagementOperation({
  ...operationBase,
  kind: "disconnect",
  state: "completed",
  result: {
    outcome: "disconnected",
    connection: { status: "disconnected", reason: "disconnected" },
  },
});
const presentAwaitingDisconnect = parseWalletCurrentOperationProjection({
  status: "present",
  connectionRevision,
  connection: connected,
  presentation: parseWalletOperationPresentation({
    operation: awaitingDisconnect,
    access: "interactive",
  }),
});
const completedDisconnectPresentation = parseWalletOperationPresentation({
  operation: completedDisconnect,
  access: "interactive",
});
const presentDisconnecting = parseWalletCurrentOperationProjection({
  status: "present",
  connectionRevision,
  connection: disconnected,
  presentation: disconnectingPresentation,
});
const absent = parseWalletCurrentOperationProjection({
  status: "absent",
  connectionRevision,
  connection: disconnected,
});

const response = (
  value: unknown,
  status = 200,
): BrowserFetchResponse => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => value,
});

let latest: WalletProcess | undefined;

const Harness = ({
  request,
  onNotification,
}: {
  readonly request: BrowserFetch;
  readonly onNotification: (notice: NotificationNotice) => void;
}) => {
  latest = useWalletProcess({
    csrfToken: () => csrfToken,
    onNotification,
    request,
  });
  return null;
};

beforeEach(() => {
  window.sessionStorage.removeItem(walletObservationStorageKey);
  vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation((array) => {
    new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(0);
    return array;
  });
});

afterEach(() => {
  cleanup();
  latest = undefined;
  vi.restoreAllMocks();
});

describe("wallet process owner", () => {
  it("preserves cancellation through notification presentation failure and cleanup", async () => {
    let currentReads = 0;
    const requests: string[] = [];
    const request = vi.fn<BrowserFetch>(async (path) => {
      requests.push(path);
      if (path === browserWalletApiPaths.currentOperation) {
        currentReads += 1;
        return response(currentReads === 1 ? present : absent);
      }
      if (path === browserOperationCancellationPath(operationId)) {
        return response(cancelled);
      }
      throw new Error(`Unexpected path: ${path}`);
    });
    const onNotification = vi.fn<(notice: NotificationNotice) => void>(() => {
      throw new Error("notification presentation failed");
    });
    const mounted = render(
      <Harness request={request} onNotification={onNotification} />,
    );

    await waitFor(() => {
      expect(latest?.wallet).toEqual(present);
    });
    await act(async () => {
      await latest?.runAction("cancel");
    });
    await waitFor(() => {
      expect(latest?.wallet).toEqual(absent);
      expect(latest?.pending).toBe(false);
    });

    expect(requests).toContain(browserOperationCancellationPath(operationId));
    expect(onNotification).toHaveBeenCalledWith(expect.objectContaining({
      heading: "Wallet connection cancelled",
    }));
    expect(latest?.terminalOperation).toEqual(cancelled);
    expect(latest?.delivery).toBeUndefined();
    expect(window.sessionStorage.getItem(walletObservationStorageKey)).toBe(
      JSON.stringify({ notifiedTerminalOperationId: operationId }),
    );

    act(() => {
      latest?.acknowledgeTerminal(operationId);
    });
    expect(latest?.terminalOperation).toBeUndefined();

    mounted.unmount();
    latest = undefined;
    render(<Harness request={request} onNotification={onNotification} />);
    await waitFor(() => {
      expect(latest?.wallet).toEqual(absent);
    });
    expect(onNotification).toHaveBeenCalledTimes(1);
  });

  it("owns confirmation through exact terminal reconciliation", async () => {
    let currentReads = 0;
    const request = vi.fn<BrowserFetch>(async (path) => {
      if (path === browserWalletApiPaths.currentOperation) {
        currentReads += 1;
        return response(
          currentReads === 1 ? presentAwaitingDisconnect : absent,
        );
      }
      if (path === browserOperationConfirmationPath(operationId)) {
        return response(disconnecting);
      }
      if (path === browserOperationPath(operationId)) {
        return response(completedDisconnectPresentation);
      }
      throw new Error(`Unexpected path: ${path}`);
    });
    const onNotification = vi.fn<(notice: NotificationNotice) => void>();
    render(<Harness request={request} onNotification={onNotification} />);

    await waitFor(() => {
      expect(latest?.wallet).toEqual(presentAwaitingDisconnect);
    });
    await act(async () => {
      await latest?.runAction("confirm");
    });
    await waitFor(() => {
      expect(latest?.wallet).toEqual(absent);
      expect(latest?.pending).toBe(false);
    });

    expect(request).toHaveBeenCalledWith(
      browserOperationConfirmationPath(operationId),
      expect.objectContaining({ method: "POST" }),
    );
    expect(request).toHaveBeenCalledWith(
      browserOperationPath(operationId),
      expect.objectContaining({ method: "GET" }),
    );
    expect(onNotification).toHaveBeenCalledWith(expect.objectContaining({
      heading: "Wallet disconnected",
    }));
    expect(window.sessionStorage.getItem(walletObservationStorageKey)).toBe(
      JSON.stringify({ notifiedTerminalOperationId: operationId }),
    );
  });

  it("aborts the owned read and rejects its late result after unmount", async () => {
    let resolveRead: ((value: BrowserFetchResponse) => void) | undefined;
    let observedSignal: AbortSignal | undefined;
    const request = vi.fn<BrowserFetch>(async (_path, init) => {
      observedSignal = init.signal;
      return await new Promise<BrowserFetchResponse>((resolve) => {
        resolveRead = resolve;
      });
    });
    const onNotification = vi.fn<(notice: NotificationNotice) => void>();
    const rendered = render(
      <Harness request={request} onNotification={onNotification} />,
    );
    await waitFor(() => {
      expect(request).toHaveBeenCalledTimes(1);
    });

    rendered.unmount();
    expect(observedSignal?.aborted).toBe(true);
    await act(async () => {
      resolveRead?.(response(present));
    });
    expect(onNotification).not.toHaveBeenCalled();
  });

  it("retains delivery uncertainty and does not repeat the sent action", async () => {
    const request = vi.fn<BrowserFetch>(async (path) => {
      if (path === browserWalletApiPaths.currentOperation) {
        return response(absent);
      }
      if (path === browserWalletApiPaths.operations) {
        return response({});
      }
      throw new Error(`Unexpected path: ${path}`);
    });
    render(
      <Harness
        request={request}
        onNotification={vi.fn<(notice: NotificationNotice) => void>()}
      />,
    );
    await waitFor(() => {
      expect(latest?.wallet).toEqual(absent);
    });

    act(() => {
      void latest?.runAction("connect", operationId);
    });
    await waitFor(() => {
      expect(latest?.delivery).toEqual({
        task: "connect",
        connectionRevision,
        result: {
          status: "delivery_unknown",
          action: "start",
          operationId,
          resendAllowed: false,
        },
      });
    });
    expect(request.mock.calls.filter(([path]) =>
      path === browserWalletApiPaths.operations)).toHaveLength(1);
  });

  it("dismisses only a non-interactive operation presentation while observation continues", async () => {
    const request = vi.fn<BrowserFetch>(async (path) => {
      if (path === browserWalletApiPaths.currentOperation) {
        return response(presentDisconnecting);
      }
      throw new Error(`Unexpected path: ${path}`);
    });
    render(
      <Harness
        request={request}
        onNotification={vi.fn<(notice: NotificationNotice) => void>()}
      />,
    );
    await waitFor(() => {
      expect(latest?.operationPresentation).toEqual(
        disconnectingPresentation,
      );
    });

    act(() => {
      latest?.dismissOperation();
    });

    await waitFor(() => {
      expect(latest?.operationPresentation).toBeUndefined();
    });
    expect(latest?.wallet).toEqual(presentDisconnecting);
  });
});
