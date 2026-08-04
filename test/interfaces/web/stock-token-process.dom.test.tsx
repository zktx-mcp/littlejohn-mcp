// @vitest-environment jsdom

import {
  act,
  cleanup,
  render,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseHash32 } from "../../../src/core/browser.js";
import type {
  BrowserFetch,
  BrowserFetchResponse,
} from "../../../src/interfaces/web/browser-client.js";
import type { NotificationNotice } from "../../../src/interfaces/web/notification.js";
import {
  stockTokenTerminalNotificationStorageKey,
  useStockTokenProcess,
  type StockTokenProcess,
} from "../../../src/interfaces/web/stock-token-process.js";
import {
  officialAssetSnapshotRevisionSchema,
} from "../../../src/registry/browser.js";
import {
  tokenCatalogBrowserRoutes,
  tokenCatalogOperationSchema,
  tokenSelectionSetRevisionSchema,
  type TokenCatalogOperation,
} from "../../../src/token-catalog/browser.js";
import {
  chainId,
  createTokenOperation,
  tokenAddress,
  walletAddress,
} from "../../token-catalog/harness.js";

const csrfToken = "A".repeat(43);
const operationId = "A".repeat(43);
const officialRevision = officialAssetSnapshotRevisionSchema.parse(
  Buffer.alloc(16, 4).toString("base64url"),
);
const selectionSetRevision = tokenSelectionSetRevisionSchema.parse(
  Buffer.alloc(16, 3).toString("base64url"),
);
const otherSelectionSetRevision = tokenSelectionSetRevisionSchema.parse(
  Buffer.alloc(16, 9).toString("base64url"),
);
const assetUid = parseHash32(`0x${"56".repeat(32)}`);
const account = Object.freeze({
  chainId,
  address: walletAddress,
  connectionRevision: "1",
});
const viewRevision = Object.freeze({
  officialSnapshotStatus: "current" as const,
  officialSnapshotRevision: officialRevision,
  selectionSetRevision,
});
const candidate = Object.freeze({
  assetUid,
  contractAddress: tokenAddress,
  sourceName: "Example Stock Token",
  sourceSymbol: "EXT",
});
const addForm = Object.freeze({
  account,
  viewRevision,
  candidates: Object.freeze([candidate]),
});

const withOfficialEvidence = (
  operation: TokenCatalogOperation,
): TokenCatalogOperation => {
  if (operation.kind !== "add" || operation.review.inspection === null) {
    throw new TypeError("Expected an addition operation.");
  }
  return tokenCatalogOperationSchema.parse({
    ...operation,
    review: {
      ...operation.review,
      officialSnapshotRevision: officialRevision,
      officialEvidence: {
        assetUid,
        snapshotRevision: officialRevision,
        verificationBlock: operation.review.inspection.data.analysis.block,
      },
    },
  });
};

const response = (
  value: unknown,
  status = 200,
): BrowserFetchResponse => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => value,
});

let latest: StockTokenProcess | undefined;

const Harness = ({
  request,
  onNotification,
  reconcileAddedSelection,
  reconcileRemovedSelection = vi.fn(),
}: {
  readonly request: BrowserFetch;
  readonly onNotification: (notice: NotificationNotice) => void;
  readonly reconcileAddedSelection: () => void;
  readonly reconcileRemovedSelection?: (
    selection: Parameters<StockTokenProcess["openRemove"]>[0]["selection"],
  ) => void;
}) => {
  latest = useStockTokenProcess({
    account,
    csrfToken: () => csrfToken,
    exactRead: { status: "idle" },
    observationUnavailable: false,
    recoverSession: () => false,
    closeExact: vi.fn(),
    reconcileAddedSelection,
    reconcileRemovedSelection,
    onNotification,
    request,
  });
  return null;
};

beforeEach(() => {
  window.sessionStorage.removeItem(
    stockTokenTerminalNotificationStorageKey,
  );
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

describe("Stock Token process owner", () => {
  it("does not repeat a retained terminal notification after a document reload", async () => {
    const completed = withOfficialEvidence(await createTokenOperation({
      kind: "add",
      state: "completed",
      operationId,
    }));
    const onNotification = vi.fn<(notice: NotificationNotice) => void>();
    const request = vi.fn<BrowserFetch>(async (path) => {
      if (path === tokenCatalogBrowserRoutes.currentOperation) {
        return response({ operation: completed });
      }
      throw new Error(`Unexpected path: ${path}`);
    });
    const first = render(
      <Harness
        request={request}
        onNotification={onNotification}
        reconcileAddedSelection={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(onNotification).toHaveBeenCalledTimes(1);
      expect(latest?.operation?.state).toBe("completed");
    });
    expect(window.sessionStorage.getItem(
      stockTokenTerminalNotificationStorageKey,
    )).toBeNull();
    act(() => {
      latest?.acknowledgeCurrentOperation();
    });
    expect(window.sessionStorage.getItem(
      stockTokenTerminalNotificationStorageKey,
    )).toBe(operationId);
    expect((latest as StockTokenProcess | undefined)?.operation).toBeNull();

    first.unmount();
    latest = undefined;
    const readsBeforeReload = request.mock.calls.filter(([path]) =>
      path === tokenCatalogBrowserRoutes.currentOperation).length;
    render(
      <Harness
        request={request}
        onNotification={onNotification}
        reconcileAddedSelection={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(request.mock.calls.filter(([path]) =>
        path === tokenCatalogBrowserRoutes.currentOperation).length)
        .toBeGreaterThan(readsBeforeReload);
    });
    expect(onNotification).toHaveBeenCalledTimes(1);
    expect((latest as StockTokenProcess | undefined)?.operation).toBeNull();
  });

  it("owns one add consent through confirmation, terminal reconciliation, and notification", async () => {
    const awaiting = withOfficialEvidence(await createTokenOperation({
      kind: "add",
      state: "awaiting_confirmation",
      operationId,
    }));
    const completed = withOfficialEvidence(await createTokenOperation({
      kind: "add",
      state: "completed",
      operationId,
    }));
    const onNotification = vi.fn<(notice: NotificationNotice) => void>();
    const reconcileAdded = vi.fn();
    const request = vi.fn<BrowserFetch>(async (path) => {
      if (path === tokenCatalogBrowserRoutes.currentOperation) {
        return response({ operation: null });
      }
      if (path === tokenCatalogBrowserRoutes.operations) {
        return response({ operation: awaiting });
      }
      if (path === tokenCatalogBrowserRoutes.operation(operationId)) {
        return response({ operation: awaiting });
      }
      if (path === tokenCatalogBrowserRoutes.confirmation(operationId)) {
        return response(completed);
      }
      throw new Error(`Unexpected path: ${path}`);
    });
    render(
      <Harness
        request={request}
        onNotification={onNotification}
        reconcileAddedSelection={reconcileAdded}
      />,
    );
    act(() => {
      latest?.openAdd(addForm);
    });
    act(() => {
      latest?.addCandidate(candidate);
    });
    await waitFor(() => {
      expect(latest?.addTask.presentation?.addStatus.status).toBe("terminal");
      expect(latest?.operation?.state).toBe("completed");
      expect(reconcileAdded).toHaveBeenCalledTimes(1);
    });
    expect(onNotification).toHaveBeenCalledWith(expect.objectContaining({
      tone: "success",
    }));
    expect(latest?.delivery).toBeUndefined();
    expect(request.mock.calls.filter(([path]) =>
      path === tokenCatalogBrowserRoutes.operations)).toHaveLength(1);
    expect(request.mock.calls.filter(([path]) =>
      path === tokenCatalogBrowserRoutes.confirmation(operationId),
    )).toHaveLength(1);
    act(() => {
      expect(latest?.closeAdd()).toBe(true);
    });
    expect(latest?.addContext).toBeUndefined();
    expect(latest?.operation).toBeNull();
  });

  it("cancels a started addition whose exact selection revision does not match the consent", async () => {
    const awaiting = withOfficialEvidence(await createTokenOperation({
      kind: "add",
      state: "awaiting_confirmation",
      operationId,
    }));
    const mismatched = tokenCatalogOperationSchema.parse({
      ...awaiting,
      review: {
        ...awaiting.review,
        selectionSetRevision: otherSelectionSetRevision,
      },
    });
    const cancelled = tokenCatalogOperationSchema.parse({
      ...mismatched,
      state: "cancelled",
    });
    const reconcileAdded = vi.fn();
    const onNotification = vi.fn<(notice: NotificationNotice) => void>();
    const request = vi.fn<BrowserFetch>(async (path) => {
      if (path === tokenCatalogBrowserRoutes.currentOperation) {
        return response({ operation: null });
      }
      if (path === tokenCatalogBrowserRoutes.operations) {
        return response({ operation: mismatched });
      }
      if (path === tokenCatalogBrowserRoutes.cancellation(operationId)) {
        return response({ operation: cancelled });
      }
      throw new Error(`Unexpected path: ${path}`);
    });
    render(
      <Harness
        request={request}
        onNotification={onNotification}
        reconcileAddedSelection={reconcileAdded}
      />,
    );
    act(() => {
      latest?.openAdd(addForm);
    });
    act(() => {
      latest?.addCandidate(candidate);
    });

    await waitFor(() => {
      expect(latest?.addContext).toBeUndefined();
      expect(reconcileAdded).toHaveBeenCalledOnce();
    });
    expect(request.mock.calls.filter(([path]) =>
      path === tokenCatalogBrowserRoutes.cancellation(operationId),
    )).toHaveLength(1);
    expect(request.mock.calls.filter(([path]) =>
      path === tokenCatalogBrowserRoutes.confirmation(operationId),
    )).toHaveLength(0);
    expect(onNotification).toHaveBeenCalledWith(expect.objectContaining({
      id: "stock-token-snapshot-changed",
      tone: "neutral",
    }));
  });

  it("never auto-confirms an awaiting operation discovered without a current add consent", async () => {
    const awaiting = withOfficialEvidence(await createTokenOperation({
      kind: "add",
      state: "awaiting_confirmation",
      operationId,
    }));
    const request = vi.fn<BrowserFetch>(async (path) => {
      if (path === tokenCatalogBrowserRoutes.currentOperation) {
        return response({ operation: awaiting });
      }
      throw new Error(`Unexpected path: ${path}`);
    });
    render(
      <Harness
        request={request}
        onNotification={vi.fn<(notice: NotificationNotice) => void>()}
        reconcileAddedSelection={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(latest?.operation?.operationId).toBe(operationId);
    });
    expect(request.mock.calls.filter(([path]) =>
      path === tokenCatalogBrowserRoutes.confirmation(operationId),
    )).toHaveLength(0);
  });

  it("does not resend confirmation while its delivery remains unknown", async () => {
    const awaiting = withOfficialEvidence(await createTokenOperation({
      kind: "add",
      state: "awaiting_confirmation",
      operationId,
    }));
    const request = vi.fn<BrowserFetch>(async (path) => {
      if (path === tokenCatalogBrowserRoutes.currentOperation) {
        return response({ operation: null });
      }
      if (path === tokenCatalogBrowserRoutes.operations) {
        return response({ operation: awaiting });
      }
      if (path === tokenCatalogBrowserRoutes.confirmation(operationId)) {
        return response({});
      }
      if (path === tokenCatalogBrowserRoutes.operation(operationId)) {
        return response({ operation: awaiting });
      }
      throw new Error(`Unexpected path: ${path}`);
    });
    render(
      <Harness
        request={request}
        onNotification={vi.fn<(notice: NotificationNotice) => void>()}
        reconcileAddedSelection={vi.fn()}
      />,
    );
    act(() => {
      latest?.openAdd(addForm);
    });
    act(() => {
      latest?.addCandidate(candidate);
    });

    await waitFor(() => {
      expect(latest?.delivery?.result).toMatchObject({
        status: "delivery_unknown",
        action: "confirm",
        operationId,
      });
    });
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 750);
      });
    });
    expect(latest?.delivery?.result).toMatchObject({
      status: "delivery_unknown",
      action: "confirm",
      operationId,
    });
    expect(request.mock.calls.filter(([path]) =>
      path === tokenCatalogBrowserRoutes.confirmation(operationId),
    )).toHaveLength(1);
  });

  it("retains the exact add task until an uncertain delivery becomes observable", async () => {
    const awaiting = withOfficialEvidence(await createTokenOperation({
      kind: "add",
      state: "awaiting_confirmation",
      operationId,
    }));
    const completed = withOfficialEvidence(await createTokenOperation({
      kind: "add",
      state: "completed",
      operationId,
    }));
    let observable = false;
    const request = vi.fn<BrowserFetch>(async (path) => {
      if (path === tokenCatalogBrowserRoutes.currentOperation) {
        return response({ operation: null });
      }
      if (path === tokenCatalogBrowserRoutes.operations) {
        return response({});
      }
      if (path === tokenCatalogBrowserRoutes.operation(operationId)) {
        return observable
          ? response({ operation: awaiting })
          : response({
              type: "about:blank",
              title: "Token operation not found",
              status: 404,
              code: "token_operation_not_found",
              detail: "The token operation was not found.",
              retryable: false,
              issues: [],
            }, 404);
      }
      if (path === tokenCatalogBrowserRoutes.confirmation(operationId)) {
        return response(completed);
      }
      throw new Error(`Unexpected path: ${path}`);
    });
    render(
      <Harness
        request={request}
        onNotification={vi.fn<(notice: NotificationNotice) => void>()}
        reconcileAddedSelection={vi.fn()}
      />,
    );
    act(() => {
      latest?.openAdd(addForm);
    });
    act(() => {
      latest?.addCandidate(candidate);
    });
    await waitFor(() => {
      expect(latest?.delivery).toEqual({
        task: "add",
        result: {
          status: "delivery_unknown",
          action: "start",
          operationId,
          resendAllowed: false,
        },
      });
    });
    act(() => {
      expect(latest?.closeAdd()).toBe(true);
    });
    expect(latest?.addContext).toBeDefined();
    expect(latest?.addTask.presentation).toBeUndefined();
    observable = true;
    await waitFor(() => {
      expect(latest?.delivery).toBeUndefined();
      expect(latest?.addTask.presentation?.addStatus.status).toBe("terminal");
      expect(latest?.operation?.state).toBe("completed");
    }, { timeout: 2_000 });
    expect(request.mock.calls.filter(([path]) =>
      path === tokenCatalogBrowserRoutes.operations)).toHaveLength(1);
    expect(request.mock.calls.filter(([path]) =>
      path === tokenCatalogBrowserRoutes.confirmation(operationId),
    )).toHaveLength(1);
    act(() => {
      expect(latest?.closeAdd()).toBe(true);
    });
    expect(latest?.addContext).toBeUndefined();
  });

  it("opens and reopens from the mounted candidate projection without another read", async () => {
    const request = vi.fn<BrowserFetch>(async (path) => {
      if (path === tokenCatalogBrowserRoutes.currentOperation) {
        return response({ operation: null });
      }
      throw new Error(`Unexpected path: ${path}`);
    });
    render(
      <Harness
        request={request}
        onNotification={vi.fn<(notice: NotificationNotice) => void>()}
        reconcileAddedSelection={vi.fn()}
      />,
    );
    act(() => {
      expect(latest?.openAdd(addForm)).toBe(true);
    });
    expect(latest?.addTask.presentation?.candidates).toEqual([candidate]);
    act(() => {
      expect(latest?.closeAdd()).toBe(true);
    });
    act(() => {
      expect(latest?.openAdd(addForm)).toBe(true);
    });
    expect(latest?.addTask.presentation?.candidates).toEqual([candidate]);
    expect(request.mock.calls.every(([path]) =>
      path === tokenCatalogBrowserRoutes.currentOperation)).toBe(true);
  });

  it("opens removal directly from one admitted row and cancels that exact review once", async () => {
    const awaiting = await createTokenOperation({
      kind: "remove",
      state: "awaiting_confirmation",
      operationId,
    });
    const cancelled = await createTokenOperation({
      kind: "remove",
      state: "cancelled",
      operationId,
    });
    const selection = awaiting.review.previousSelection!;
    let observedOperation: TokenCatalogOperation = awaiting;
    const request = vi.fn<BrowserFetch>(async (path) => {
      if (path === tokenCatalogBrowserRoutes.currentOperation) {
        return response({ operation: null });
      }
      if (path === tokenCatalogBrowserRoutes.operations) {
        return response({ operation: awaiting });
      }
      if (path === tokenCatalogBrowserRoutes.operation(operationId)) {
        return response({ operation: observedOperation });
      }
      if (path === tokenCatalogBrowserRoutes.cancellation(operationId)) {
        observedOperation = cancelled;
        return response({ operation: cancelled });
      }
      throw new Error(`Unexpected path: ${path}`);
    });
    render(
      <Harness
        request={request}
        onNotification={vi.fn<(notice: NotificationNotice) => void>()}
        reconcileAddedSelection={vi.fn()}
      />,
    );

    act(() => {
      expect(latest?.openRemove({
        selection,
        name: "Example Stock Token",
      })).toBe(true);
    });
    await waitFor(() => {
      expect(latest?.removeTask.presentation?.status).toBe("ready");
    });
    act(() => {
      expect(latest?.closeRemove()).toBe(false);
    });
    await waitFor(() => {
      expect(latest?.removeTask.presentation?.status).toBe("terminal");
      expect(latest?.operation?.state).toBe("cancelled");
    });
    expect(request.mock.calls.filter(([path]) =>
      path === tokenCatalogBrowserRoutes.cancellation(operationId),
    )).toHaveLength(1);
    act(() => {
      expect(latest?.closeRemove()).toBe(true);
    });
    expect(latest?.removeContext).toBeUndefined();
    expect(latest?.operation).toBeNull();
  });

  it("dismisses removal delivery uncertainty without losing its exact reconciliation subject", async () => {
    const awaiting = await createTokenOperation({
      kind: "remove",
      state: "awaiting_confirmation",
      operationId,
    });
    const selection = awaiting.review.previousSelection!;
    let observable = false;
    const request = vi.fn<BrowserFetch>(async (path) => {
      if (path === tokenCatalogBrowserRoutes.currentOperation) {
        return response({ operation: null });
      }
      if (path === tokenCatalogBrowserRoutes.operations) {
        return response({});
      }
      if (path === tokenCatalogBrowserRoutes.operation(operationId)) {
        return observable
          ? response({ operation: awaiting })
          : response({
              type: "about:blank",
              title: "Token operation not found",
              status: 404,
              code: "token_operation_not_found",
              detail: "The token operation was not found.",
              retryable: false,
              issues: [],
            }, 404);
      }
      throw new Error(`Unexpected path: ${path}`);
    });
    render(
      <Harness
        request={request}
        onNotification={vi.fn<(notice: NotificationNotice) => void>()}
        reconcileAddedSelection={vi.fn()}
      />,
    );

    act(() => {
      expect(latest?.openRemove({
        selection,
        name: "Example Stock Token",
      })).toBe(true);
    });
    await waitFor(() => {
      expect(latest?.removeTask.presentation?.status).toBe("delivery_unknown");
    });
    const retainedTaskId = latest?.removeContext?.taskId;
    act(() => {
      expect(latest?.closeRemove()).toBe(true);
    });
    expect(latest?.removeContext?.taskId).toBe(retainedTaskId);
    expect(latest?.delivery?.result.operationId).toBe(operationId);
    expect(latest?.removeTask.presentation).toBeUndefined();

    observable = true;
    await waitFor(() => {
      expect(latest?.removeTask.presentation?.status).toBe("ready");
      expect(latest?.operation?.operationId).toBe(operationId);
      expect(latest?.delivery).toBeUndefined();
    }, { timeout: 2_000 });
    expect(request.mock.calls.filter(([path]) =>
      path === tokenCatalogBrowserRoutes.operations)).toHaveLength(1);
  });

  it("keeps cancellation uncertainty through exact nonterminal observations and resolves it only at terminal", async () => {
    const awaiting = await createTokenOperation({
      kind: "remove",
      state: "awaiting_confirmation",
      operationId,
    });
    const applying = await createTokenOperation({
      kind: "remove",
      state: "applying",
      operationId,
    });
    const cancelled = await createTokenOperation({
      kind: "remove",
      state: "cancelled",
      operationId,
    });
    const selection = awaiting.review.previousSelection!;
    let observedOperation: TokenCatalogOperation = awaiting;
    const request = vi.fn<BrowserFetch>(async (path) => {
      if (path === tokenCatalogBrowserRoutes.currentOperation) {
        return response({ operation: null });
      }
      if (path === tokenCatalogBrowserRoutes.operations) {
        return response({ operation: awaiting });
      }
      if (path === tokenCatalogBrowserRoutes.cancellation(operationId)) {
        return response({});
      }
      if (path === tokenCatalogBrowserRoutes.operation(operationId)) {
        return response({ operation: observedOperation });
      }
      throw new Error(`Unexpected path: ${path}`);
    });
    render(
      <Harness
        request={request}
        onNotification={vi.fn<(notice: NotificationNotice) => void>()}
        reconcileAddedSelection={vi.fn()}
      />,
    );

    act(() => {
      expect(latest?.openRemove({
        selection,
        name: "Example Stock Token",
      })).toBe(true);
    });
    await waitFor(() => {
      expect(latest?.removeTask.presentation?.status).toBe("ready");
    });
    act(() => {
      expect(latest?.closeRemove()).toBe(false);
    });
    await waitFor(() => {
      expect(latest?.removeTask.presentation?.status).toBe("delivery_unknown");
    });
    act(() => {
      expect(latest?.closeRemove()).toBe(true);
    });
    const exactReadsAfterDismissal = request.mock.calls.filter(([path]) =>
      path === tokenCatalogBrowserRoutes.operation(operationId)).length;
    await waitFor(() => {
      expect(request.mock.calls.filter(([path]) =>
        path === tokenCatalogBrowserRoutes.operation(operationId)).length)
        .toBeGreaterThan(exactReadsAfterDismissal);
      expect(latest?.operation?.state).toBe("awaiting_confirmation");
    }, { timeout: 2_000 });
    expect(latest?.delivery?.result.action).toBe("cancel");
    expect(latest?.removeTask.presentation).toBeUndefined();

    observedOperation = applying;
    await waitFor(() => {
      expect(latest?.operation?.state).toBe("applying");
    }, { timeout: 2_000 });
    expect(latest?.delivery?.result.action).toBe("cancel");
    expect(latest?.removeTask.presentation).toBeUndefined();

    observedOperation = cancelled;
    await waitFor(() => {
      expect(latest?.operation?.state).toBe("cancelled");
      expect(latest?.removeTask.presentation?.status).toBe("terminal");
      expect(latest?.delivery).toBeUndefined();
    }, { timeout: 2_000 });
    expect(request.mock.calls.filter(([path]) =>
      path === tokenCatalogBrowserRoutes.cancellation(operationId)))
      .toHaveLength(1);
  });

  it("dismisses external delivery uncertainty while exact-ID polling continues to terminal", async () => {
    const awaiting = await createTokenOperation({
      kind: "remove",
      state: "awaiting_confirmation",
      operationId,
    });
    const completed = await createTokenOperation({
      kind: "remove",
      state: "completed",
      operationId,
    });
    let observedOperation: TokenCatalogOperation = awaiting;
    const request = vi.fn<BrowserFetch>(async (path) => {
      if (path === tokenCatalogBrowserRoutes.currentOperation) {
        return response({ operation: awaiting });
      }
      if (path === tokenCatalogBrowserRoutes.confirmation(operationId)) {
        return response({});
      }
      if (path === tokenCatalogBrowserRoutes.operation(operationId)) {
        return response({ operation: observedOperation });
      }
      throw new Error(`Unexpected path: ${path}`);
    });
    render(
      <Harness
        request={request}
        onNotification={vi.fn<(notice: NotificationNotice) => void>()}
        reconcileAddedSelection={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(latest?.operationTask?.actions).toEqual(["confirm", "cancel"]);
    });
    act(() => {
      latest?.confirmCurrentOperation();
    });
    await waitFor(() => {
      expect(latest?.operationTask?.request.status).toBe("delivery_unknown");
    });
    act(() => {
      latest?.dismissExternalOperation();
    });
    expect(latest?.operation?.operationId).toBe(operationId);
    expect(latest?.operationTask).toBeUndefined();

    observedOperation = completed;
    await waitFor(() => {
      expect(latest?.operationTask?.terminal).toBe(true);
      expect(latest?.operation?.state).toBe("completed");
    }, { timeout: 2_000 });
    expect(request.mock.calls.filter(([path]) =>
      path === tokenCatalogBrowserRoutes.confirmation(operationId)))
      .toHaveLength(1);
    expect(request.mock.calls.some(([path]) =>
      path === tokenCatalogBrowserRoutes.operation(operationId))).toBe(true);
  });

  it("confirms removal and reconciles only the operation result selection", async () => {
    const awaiting = await createTokenOperation({
      kind: "remove",
      state: "awaiting_confirmation",
      operationId,
    });
    const completed = await createTokenOperation({
      kind: "remove",
      state: "completed",
      operationId,
    });
    const selection = awaiting.review.previousSelection!;
    const reconcileRemoved = vi.fn();
    let observedOperation: TokenCatalogOperation = awaiting;
    const request = vi.fn<BrowserFetch>(async (path) => {
      if (path === tokenCatalogBrowserRoutes.currentOperation) {
        return response({ operation: null });
      }
      if (path === tokenCatalogBrowserRoutes.operations) {
        return response({ operation: awaiting });
      }
      if (path === tokenCatalogBrowserRoutes.operation(operationId)) {
        return response({ operation: observedOperation });
      }
      if (path === tokenCatalogBrowserRoutes.confirmation(operationId)) {
        observedOperation = completed;
        return response(completed);
      }
      throw new Error(`Unexpected path: ${path}`);
    });
    render(
      <Harness
        request={request}
        onNotification={vi.fn<(notice: NotificationNotice) => void>()}
        reconcileAddedSelection={vi.fn()}
        reconcileRemovedSelection={reconcileRemoved}
      />,
    );

    act(() => {
      latest?.openRemove({ selection, name: "Example Stock Token" });
    });
    await waitFor(() => {
      expect(latest?.removeTask.presentation?.status).toBe("ready");
    });
    act(() => {
      latest?.confirmRemove();
    });
    await waitFor(() => {
      expect(latest?.removeTask.presentation?.status).toBe("terminal");
      expect(latest?.operation?.state).toBe("completed");
    });
    expect(reconcileRemoved).toHaveBeenCalledOnce();
    expect(reconcileRemoved).toHaveBeenCalledWith(
      completed.result?.selection,
    );
    act(() => {
      expect(latest?.closeRemove()).toBe(true);
    });
    expect(latest?.removeContext).toBeUndefined();
  });

  it("aborts polling and ignores a late operation after unmount", async () => {
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
      <Harness
        request={request}
        onNotification={onNotification}
        reconcileAddedSelection={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(request).toHaveBeenCalledTimes(1);
    });
    rendered.unmount();
    expect(observedSignal?.aborted).toBe(true);
    await act(async () => {
      resolveRead?.(response({ operation: null }));
    });
    expect(onNotification).not.toHaveBeenCalled();
  });
});
