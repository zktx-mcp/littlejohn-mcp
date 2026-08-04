import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  isTokenCatalogOperationTerminal,
  tokenCatalogOperationIdSchema,
  type TokenCatalogOperation,
  type TokenSelection,
} from "../../token-catalog/browser.js";
import {
  isDeliveryUnknown,
} from "../operation-delivery.js";
import type {
  AccountAssetExactReadState,
  ConnectedAccount,
} from "./account-assets-controller.js";
import {
  sameConnectedAccount,
} from "./account-assets-controller.js";
import type { BrowserFetch } from "./browser-client.js";
import {
  isBrowserRequestFailureCode,
} from "./browser-client.js";
import {
  humanFailureText,
  presentBrowserRequestFailure,
  type HumanFailureTaskContext,
} from "./human-failures.js";
import type { NotificationNotice } from "./notification.js";
import { createBrowserRequestAuthority } from "./request-authority.js";
import type {
  OfficialStockTokenCandidate,
} from "./stock-token-add-dialog.js";
import {
  operationMatchesStockTokenAddition,
  operationMatchesStockTokenRemoval,
  presentStockTokenAddTask,
  presentStockTokenInformationTask,
  presentStockTokenOperationTask,
  presentStockTokenRemoveTask,
  type StockTokenActionIntent,
  type StockTokenAddContext,
  type StockTokenAddFormContext,
  type StockTokenAddTaskPresentation,
  type StockTokenDelivery,
  type StockTokenInformationTaskPresentation,
  type StockTokenOperationTaskPresentation,
  type StockTokenRemoveContext,
  type StockTokenRemoveTaskPresentation,
  type StockTokenTaskFailure,
} from "./stock-token-task-presentation.js";
import type {
  StockTokenRemoveSubject,
} from "./stock-token-remove-dialog.js";
import {
  cancelTokenOperation,
  confirmTokenOperation,
  loadCurrentTokenOperation,
  loadTokenOperation,
  startTokenRemoval,
  startTokenSelection,
} from "./token-catalog-client.js";
import {
  tokenOperationNotification,
} from "./token-catalog-view.js";

const browserPollMilliseconds = 500;

export const stockTokenTerminalNotificationStorageKey =
  "littlejohn.stock-token-terminal-notification";

const createStockTokenTerminalNotificationStore = () => {
  return Object.freeze({
    load: (): string | undefined => {
      try {
        const value = window.sessionStorage.getItem(
          stockTokenTerminalNotificationStorageKey,
        );
        return value === null
          ? undefined
          : tokenCatalogOperationIdSchema.parse(value);
      } catch {
        try {
          window.sessionStorage.removeItem(
            stockTokenTerminalNotificationStorageKey,
          );
        } catch {
          // Unavailable presentation storage does not change the operation.
        }
        return undefined;
      }
    },
    save: (operationId: string): void => {
      try {
        window.sessionStorage.setItem(
          stockTokenTerminalNotificationStorageKey,
          operationId,
        );
      } catch {
        try {
          window.sessionStorage.removeItem(
            stockTokenTerminalNotificationStorageKey,
          );
        } catch {
          // Unavailable presentation storage does not change the operation.
        }
      }
    },
  });
};

type StockTokenAddConsent = Readonly<{
  taskId: number;
  form: StockTokenAddFormContext;
  candidate: OfficialStockTokenCandidate;
}>;

type DismissedRemovePresentation = Readonly<{
  taskId: number;
  operationId: string;
}>;

const sameCandidate = (
  left: OfficialStockTokenCandidate,
  right: OfficialStockTokenCandidate,
): boolean =>
  left.assetUid === right.assetUid &&
  left.contractAddress === right.contractAddress;

const operationMatchesAddConsent = (
  operation: TokenCatalogOperation,
  consent: StockTokenAddConsent,
): boolean =>
  operationMatchesStockTokenAddition(
    operation,
    consent.form,
    consent.candidate,
  );

export interface StockTokenProcess {
  readonly delivery: StockTokenDelivery | undefined;
  readonly pending: boolean;
  readonly addContext: StockTokenAddContext | undefined;
  readonly removeContext: StockTokenRemoveContext | undefined;
  readonly operation: TokenCatalogOperation | null;
  readonly operationTask: StockTokenOperationTaskPresentation | undefined;
  readonly actionIntent: StockTokenActionIntent | undefined;
  readonly addTask: StockTokenAddTaskPresentation;
  readonly informationTask: StockTokenInformationTaskPresentation;
  readonly removeTask: StockTokenRemoveTaskPresentation;
  readonly openAdd: (form: StockTokenAddFormContext) => boolean;
  readonly closeAdd: () => boolean;
  readonly addCandidate: (candidate: OfficialStockTokenCandidate) => void;
  readonly retryAdd: () => void;
  readonly openRemove: (subject: StockTokenRemoveSubject) => boolean;
  readonly closeRemove: () => boolean;
  readonly confirmRemove: () => void;
  readonly retryRemove: () => void;
  readonly confirmCurrentOperation: () => void;
  readonly cancelCurrentOperation: () => void;
  readonly acknowledgeCurrentOperation: () => void;
  readonly dismissExternalOperation: () => void;
}

export const useStockTokenProcess = ({
  account,
  csrfToken,
  exactRead,
  observationUnavailable,
  recoverSession,
  closeExact,
  reconcileAddedSelection,
  reconcileRemovedSelection,
  onNotification,
  request,
}: Readonly<{
  account: ConnectedAccount | undefined;
  csrfToken: () => string;
  exactRead: AccountAssetExactReadState;
  observationUnavailable: boolean;
  recoverSession: (error: unknown) => boolean;
  closeExact: () => void;
  reconcileAddedSelection: () => void;
  reconcileRemovedSelection: (selection: TokenSelection) => void;
  onNotification: (notice: NotificationNotice) => void;
  request?: BrowserFetch;
}>): StockTokenProcess => {
  const [addContext, setAddContext] = useState<StockTokenAddContext>();
  const [removeContext, setRemoveContext] =
    useState<StockTokenRemoveContext>();
  const [operation, setOperation] = useState<TokenCatalogOperation | null>(null);
  const [actionIntent, setActionIntent] =
    useState<StockTokenActionIntent>();
  const [delivery, setDelivery] = useState<StockTokenDelivery>();
  const deliveryRef = useRef(delivery);
  deliveryRef.current = delivery;
  const [pending, setPending] = useState(false);
  const [dismissedAddTaskId, setDismissedAddTaskId] = useState<number>();
  const [dismissedRemovePresentation, setDismissedRemovePresentation] =
    useState<DismissedRemovePresentation>();
  const [dismissedExternalOperationId, setDismissedExternalOperationId] =
    useState<string>();
  const [operationAuthority] = useState(createBrowserRequestAuthority);
  const accountRef = useRef(account);
  accountRef.current = account;
  const observationUnavailableRef = useRef(observationUnavailable);
  observationUnavailableRef.current = observationUnavailable;
  const addContextRef = useRef(addContext);
  addContextRef.current = addContext;
  const removeContextRef = useRef(removeContext);
  removeContextRef.current = removeContext;
  const operationRef = useRef(operation);
  operationRef.current = operation;
  const actionIntentRef = useRef(actionIntent);
  actionIntentRef.current = actionIntent;
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const requestRef = useRef(request);
  requestRef.current = request;
  const csrfTokenRef = useRef(csrfToken);
  csrfTokenRef.current = csrfToken;
  const recoverSessionRef = useRef(recoverSession);
  recoverSessionRef.current = recoverSession;
  const closeExactRef = useRef(closeExact);
  closeExactRef.current = closeExact;
  const reconcileAddedRef = useRef(reconcileAddedSelection);
  reconcileAddedRef.current = reconcileAddedSelection;
  const reconcileRemovedRef = useRef(reconcileRemovedSelection);
  reconcileRemovedRef.current = reconcileRemovedSelection;
  const notificationRef = useRef(onNotification);
  notificationRef.current = onNotification;
  const [terminalNotificationStore] = useState(
    createStockTokenTerminalNotificationStore,
  );
  const handledTerminalOperationRef = useRef<string | undefined>(
    terminalNotificationStore.load(),
  );
  const notifiedTerminalOperationRef = useRef<string | undefined>(undefined);
  const reconciledTerminalOperationRef = useRef<string | undefined>(undefined);
  const dismissedRemovePresentationRef =
    useRef<DismissedRemovePresentation | undefined>(undefined);
  dismissedRemovePresentationRef.current = dismissedRemovePresentation;
  const dismissedExternalOperationIdRef = useRef<string | undefined>(undefined);
  dismissedExternalOperationIdRef.current = dismissedExternalOperationId;
  const addTaskSequenceRef = useRef(0);
  const removeTaskSequenceRef = useRef(0);
  const addConsentRef = useRef<StockTokenAddConsent | undefined>(undefined);
  const confirmationStartedOperationIdRef =
    useRef<string | undefined>(undefined);

  const replaceAddContext = useCallback((
    next: StockTokenAddContext | undefined,
  ): void => {
    addContextRef.current = next;
    setAddContext(next);
  }, []);

  const replaceRemoveContext = useCallback((
    next: StockTokenRemoveContext | undefined,
  ): void => {
    removeContextRef.current = next;
    setRemoveContext(next);
  }, []);

  const replaceOperation = useCallback((
    next: TokenCatalogOperation | null,
  ): void => {
    operationRef.current = next;
    setOperation(next);
  }, []);

  const replaceActionIntent = useCallback((
    next: StockTokenActionIntent | undefined,
  ): void => {
    actionIntentRef.current = next;
    setActionIntent(next);
  }, []);

  const replacePending = useCallback((next: boolean): void => {
    pendingRef.current = next;
    setPending(next);
  }, []);

  const replaceDelivery = useCallback((
    next: StockTokenDelivery | undefined,
  ): void => {
    deliveryRef.current = next;
    setDelivery(next);
  }, []);

  const replaceDismissedAddTaskId = useCallback((
    next: number | undefined,
  ): void => {
    setDismissedAddTaskId(next);
  }, []);

  const replaceDismissedRemovePresentation = useCallback((
    next: DismissedRemovePresentation | undefined,
  ): void => {
    dismissedRemovePresentationRef.current = next;
    setDismissedRemovePresentation(next);
  }, []);

  const replaceDismissedExternalOperationId = useCallback((
    next: string | undefined,
  ): void => {
    dismissedExternalOperationIdRef.current = next;
    setDismissedExternalOperationId(next);
  }, []);

  const markTerminalHandled = useCallback((operationId: string): void => {
    handledTerminalOperationRef.current = operationId;
    terminalNotificationStore.save(operationId);
  }, [terminalNotificationStore]);

  const publishTerminalNotification = useCallback((
    operation: TokenCatalogOperation,
  ): void => {
    if (notifiedTerminalOperationRef.current === operation.operationId) return;
    notifiedTerminalOperationRef.current = operation.operationId;
    const notice = tokenOperationNotification(operation);
    if (notice !== undefined) notificationRef.current(notice);
  }, []);

  const requestOptions = useCallback((signal?: AbortSignal) =>
    Object.freeze({
      ...(requestRef.current === undefined
        ? {}
        : { request: requestRef.current }),
      ...(signal === undefined ? {} : { signal }),
    }), []);

  const publishActionError = useCallback((
    heading: string,
    context: HumanFailureTaskContext,
    error: unknown,
  ): void => {
    const failure = presentBrowserRequestFailure(context, error);
    notificationRef.current(Object.freeze({
      id: `${heading.toLowerCase().replaceAll(" ", "-")}-error`,
      tone: "error",
      heading,
      message: humanFailureText(failure),
    }));
  }, []);

  const taskFailure = useCallback((
    action: StockTokenTaskFailure["action"],
    context: HumanFailureTaskContext,
    error: unknown,
    candidate?: OfficialStockTokenCandidate,
  ): StockTokenTaskFailure => Object.freeze({
    action,
    presentation: presentBrowserRequestFailure(context, error),
    ...(candidate === undefined ? {} : { candidate }),
  }), []);

  const clearAddForm = useCallback((): void => {
    addConsentRef.current = undefined;
    confirmationStartedOperationIdRef.current = undefined;
    replaceDismissedAddTaskId(undefined);
    replaceAddContext(undefined);
  }, [replaceAddContext, replaceDismissedAddTaskId]);

  const clearAddFailure = useCallback((context: StockTokenAddContext): void => {
    replaceAddContext(Object.freeze({
      taskId: context.taskId,
      form: context.form,
      candidate: context.candidate,
    }));
  }, [replaceAddContext]);

  const clearRemoveFailure = useCallback((
    context: StockTokenRemoveContext,
  ): void => {
    replaceRemoveContext(Object.freeze({
      taskId: context.taskId,
      account: context.account,
      subject: context.subject,
    }));
  }, [replaceRemoveContext]);

  const clearAdd = useCallback((): void => {
    replaceOperation(null);
    clearAddForm();
  }, [clearAddForm, replaceOperation]);

  const clearRemove = useCallback((): void => {
    replaceOperation(null);
    replaceDismissedRemovePresentation(undefined);
    replaceRemoveContext(undefined);
  }, [
    replaceDismissedRemovePresentation,
    replaceOperation,
    replaceRemoveContext,
  ]);

  const acceptOperation = useCallback((
    nextOperation: TokenCatalogOperation,
  ): void => {
    const currentDelivery = deliveryRef.current;
    const resolvesDelivery =
      currentDelivery?.result.operationId === nextOperation.operationId &&
      (
        currentDelivery.result.action === "start" ||
        (
          currentDelivery.result.action === "confirm" &&
          nextOperation.state !== "awaiting_confirmation"
        ) ||
        (
          currentDelivery.result.action === "cancel" &&
          isTokenCatalogOperationTerminal(nextOperation.state)
        )
      );
    if (resolvesDelivery) {
      replaceDelivery(undefined);
    }
    const currentAdd = addContextRef.current;
    const addConsent = addConsentRef.current;
    const addMatches = currentAdd?.candidate !== null &&
      currentAdd?.candidate !== undefined &&
      addConsent !== undefined &&
      currentAdd.taskId === addConsent.taskId &&
      sameCandidate(currentAdd.candidate, addConsent.candidate) &&
      operationMatchesAddConsent(nextOperation, addConsent);
    const currentRemove = removeContextRef.current;
    const removeMatches = currentRemove !== undefined &&
      operationMatchesStockTokenRemoval(nextOperation, currentRemove);

    if (!isTokenCatalogOperationTerminal(nextOperation.state)) {
      const dismissedRemove = dismissedRemovePresentationRef.current;
      if (
        resolvesDelivery === true &&
        removeMatches &&
        nextOperation.state === "awaiting_confirmation" &&
        dismissedRemove?.taskId === currentRemove?.taskId &&
        dismissedRemove.operationId === nextOperation.operationId
      ) {
        replaceDismissedRemovePresentation(undefined);
      }
      replaceOperation(nextOperation);
      return;
    }
    if (dismissedExternalOperationIdRef.current === nextOperation.operationId) {
      replaceDismissedExternalOperationId(undefined);
    }
    if (
      dismissedRemovePresentationRef.current?.operationId ===
        nextOperation.operationId
    ) {
      replaceDismissedRemovePresentation(undefined);
    }
    if (
      handledTerminalOperationRef.current === nextOperation.operationId
    ) {
      return;
    }
    if (addMatches) {
      if (
        nextOperation.state === "completed" &&
        reconciledTerminalOperationRef.current !== nextOperation.operationId
      ) {
        reconciledTerminalOperationRef.current = nextOperation.operationId;
        reconcileAddedRef.current();
      }
      replaceOperation(nextOperation);
      publishTerminalNotification(nextOperation);
      return;
    }

    if (removeMatches) {
      if (
        nextOperation.state === "completed" &&
        reconciledTerminalOperationRef.current !== nextOperation.operationId
      ) {
        reconciledTerminalOperationRef.current = nextOperation.operationId;
        reconcileRemovedRef.current(nextOperation.result.selection);
      }
      replaceOperation(nextOperation);
      publishTerminalNotification(nextOperation);
      return;
    }

    replaceOperation(nextOperation);
    publishTerminalNotification(nextOperation);
  }, [
    publishTerminalNotification,
    replaceDelivery,
    replaceDismissedExternalOperationId,
    replaceDismissedRemovePresentation,
    replaceOperation,
  ]);

  const runOperation = useCallback(async (
    action: "confirm" | "cancel",
    intent: StockTokenActionIntent,
  ): Promise<void> => {
    const current = operationRef.current;
    if (
      current === null ||
      pendingRef.current ||
      current.interactionInterface !== "web"
    ) {
      return;
    }
    const activeRequest = operationAuthority.beginControl();
    if (activeRequest === undefined) return;
    replaceActionIntent(intent);
    replacePending(true);
    try {
      const result = action === "confirm"
        ? await confirmTokenOperation(
            current,
            csrfTokenRef.current(),
            requestOptions(activeRequest.signal),
          )
        : await cancelTokenOperation(
            current.operationId,
            csrfTokenRef.current(),
            requestOptions(activeRequest.signal),
          );
      if (!operationAuthority.isCurrent(activeRequest)) return;
      if (isDeliveryUnknown(result)) {
        replaceDelivery(Object.freeze({
          task: current.kind,
          result,
        }));
        return;
      }
      acceptOperation("operation" in result ? result.operation : result);
    } catch (error) {
      if (
        !operationAuthority.isCurrent(activeRequest) ||
        recoverSessionRef.current(error)
      ) {
        return;
      }
      const failure = taskFailure(
        action === "confirm"
          ? current.kind === "remove" ? "confirm_remove" : "confirm_add"
          : current.kind === "remove" ? "cancel_remove" : "cancel_add",
        current.kind === "remove" ? "stock_token_remove" : "stock_token_add",
        error,
      );
      if (current.kind === "add" && addContextRef.current !== undefined) {
        confirmationStartedOperationIdRef.current = undefined;
        replaceAddContext(Object.freeze({
          ...addContextRef.current,
          failure,
        }));
      } else if (
        current.kind === "remove" &&
        removeContextRef.current !== undefined
      ) {
        replaceRemoveContext(Object.freeze({
          ...removeContextRef.current,
          failure,
        }));
      } else {
        publishActionError("Token action failed", "stock_token_change", error);
      }
    } finally {
      operationAuthority.finishControl(activeRequest);
      if (operationAuthority.isCurrent(activeRequest)) {
        replaceActionIntent(undefined);
        replacePending(false);
      }
    }
  }, [
    acceptOperation,
    operationAuthority,
    publishActionError,
    replaceAddContext,
    replaceActionIntent,
    replaceDelivery,
    replacePending,
    replaceRemoveContext,
    requestOptions,
    taskFailure,
  ]);

  const openAdd = useCallback((form: StockTokenAddFormContext): boolean => {
    if (
      form.viewRevision.officialSnapshotStatus !== "current" ||
      !sameConnectedAccount(form.account, accountRef.current)
    ) {
      return false;
    }
    addTaskSequenceRef.current += 1;
    closeExactRef.current();
    replaceDismissedAddTaskId(undefined);
    replaceAddContext(Object.freeze({
      taskId: addTaskSequenceRef.current,
      form,
      candidate: null,
    }));
    return true;
  }, [replaceAddContext, replaceDismissedAddTaskId]);

  const addCandidate = useCallback(async (
    candidate: OfficialStockTokenCandidate,
  ): Promise<void> => {
    const task = addContextRef.current;
    if (
      task === undefined ||
      task.candidate !== null ||
      !task.form.candidates.some((entry) =>
        sameCandidate(entry, candidate)) ||
      addConsentRef.current !== undefined ||
      operationRef.current !== null ||
      deliveryRef.current !== undefined ||
      pendingRef.current ||
      observationUnavailableRef.current ||
      !sameConnectedAccount(task.form.account, accountRef.current)
    ) {
      return;
    }
    const activeRequest = operationAuthority.beginControl();
    if (activeRequest === undefined) return;
    const consent = Object.freeze({
      taskId: task.taskId,
      form: task.form,
      candidate,
    });
    addConsentRef.current = consent;
    replaceAddContext(Object.freeze({
      taskId: task.taskId,
      form: task.form,
      candidate,
    }));
    replaceActionIntent("starting_add");
    replacePending(true);
    try {
      const started = await startTokenSelection(
        task.form.account.chainId,
        candidate.contractAddress,
        csrfTokenRef.current(),
        requestOptions(activeRequest.signal),
      );
      if (!operationAuthority.isCurrent(activeRequest)) return;
      if (isDeliveryUnknown(started)) {
        replaceDelivery(Object.freeze({ task: "add", result: started }));
        return;
      }
      if (!operationMatchesAddConsent(started.operation, consent)) {
        const cleanup = await cancelTokenOperation(
          started.operation.operationId,
          csrfTokenRef.current(),
          requestOptions(activeRequest.signal),
        );
        if (!operationAuthority.isCurrent(activeRequest)) return;
        if (isDeliveryUnknown(cleanup)) {
          replaceDelivery(Object.freeze({ task: "add", result: cleanup }));
          return;
        }
        markTerminalHandled(cleanup.operation.operationId);
        clearAdd();
        reconcileAddedRef.current();
        notificationRef.current(Object.freeze({
          id: "stock-token-snapshot-changed",
          tone: "neutral",
          heading: "Stock Token list changed",
          message: "Assets is refreshing. Reopen Add Stock Token from the updated list.",
        }));
        return;
      }
      acceptOperation(started.operation);
    } catch (error) {
      if (
        !operationAuthority.isCurrent(activeRequest) ||
        recoverSessionRef.current(error)
      ) {
        return;
      }
      addConsentRef.current = undefined;
      confirmationStartedOperationIdRef.current = undefined;
      const current = addContextRef.current;
      if (current?.taskId === task.taskId) {
        replaceAddContext(Object.freeze({
          ...current,
          candidate: null,
          failure: taskFailure("start_add", "stock_token_add", error, candidate),
        }));
      }
    } finally {
      operationAuthority.finishControl(activeRequest);
      if (operationAuthority.isCurrent(activeRequest)) {
        replaceActionIntent(undefined);
        replacePending(false);
      }
    }
  }, [
    acceptOperation,
    clearAdd,
    operationAuthority,
    markTerminalHandled,
    replaceActionIntent,
    replaceAddContext,
    replaceDelivery,
    replacePending,
    requestOptions,
    taskFailure,
  ]);

  const confirmCapturedAddition = useCallback(async (
    current: TokenCatalogOperation,
    consent: StockTokenAddConsent,
  ): Promise<void> => {
    if (
      current.state !== "awaiting_confirmation" ||
      confirmationStartedOperationIdRef.current === current.operationId ||
      !operationMatchesAddConsent(current, consent) ||
      addContextRef.current?.taskId !== consent.taskId ||
      !sameConnectedAccount(consent.form.account, accountRef.current)
    ) {
      return;
    }
    const activeRequest = operationAuthority.beginControl();
    if (activeRequest === undefined) return;
    confirmationStartedOperationIdRef.current = current.operationId;
    replaceActionIntent("confirming_add");
    replacePending(true);
    try {
      const result = await confirmTokenOperation(
        current,
        csrfTokenRef.current(),
        requestOptions(activeRequest.signal),
      );
      if (!operationAuthority.isCurrent(activeRequest)) return;
      if (isDeliveryUnknown(result)) {
        replaceDelivery(Object.freeze({ task: "add", result }));
        return;
      }
      acceptOperation(result);
    } catch (error) {
      if (
        !operationAuthority.isCurrent(activeRequest) ||
        recoverSessionRef.current(error)
      ) {
        return;
      }
      confirmationStartedOperationIdRef.current = undefined;
      const active = addContextRef.current;
      if (active?.taskId === consent.taskId) {
        replaceAddContext(Object.freeze({
          ...active,
          failure: taskFailure("confirm_add", "stock_token_add", error),
        }));
      }
    } finally {
      operationAuthority.finishControl(activeRequest);
      if (operationAuthority.isCurrent(activeRequest)) {
        replaceActionIntent(undefined);
        replacePending(false);
      }
    }
  }, [
    acceptOperation,
    operationAuthority,
    replaceActionIntent,
    replaceAddContext,
    replaceDelivery,
    replacePending,
    requestOptions,
    taskFailure,
  ]);

  const prepareRemove = useCallback(async (
    context: StockTokenRemoveContext,
    activeRequest: NonNullable<ReturnType<
      typeof operationAuthority.beginControl
    >>,
  ): Promise<void> => {
    const { subject } = context;
    replaceActionIntent("starting_remove");
    replacePending(true);
    try {
      const started = await startTokenRemoval(
        subject.selection,
        csrfTokenRef.current(),
        requestOptions(activeRequest.signal),
      );
      if (!operationAuthority.isCurrent(activeRequest)) return;
      if (isDeliveryUnknown(started)) {
        replaceDelivery(Object.freeze({ task: "remove", result: started }));
        return;
      }
      if (!operationMatchesStockTokenRemoval(started.operation, context)) {
        const cleanup = await cancelTokenOperation(
          started.operation.operationId,
          csrfTokenRef.current(),
          requestOptions(activeRequest.signal),
        );
        if (!operationAuthority.isCurrent(activeRequest)) return;
        if (isDeliveryUnknown(cleanup)) {
          replaceDelivery(Object.freeze({ task: "remove", result: cleanup }));
          return;
        }
        markTerminalHandled(cleanup.operation.operationId);
        clearRemove();
        reconcileRemovedRef.current(subject.selection);
        notificationRef.current(Object.freeze({
          id: "stock-token-removal-changed",
          tone: "neutral",
          heading: "Stock Token changed",
          message: "Assets is refreshing. Reopen the token from the updated list.",
        }));
        return;
      }
      acceptOperation(started.operation);
    } catch (error) {
      if (
        !operationAuthority.isCurrent(activeRequest) ||
        recoverSessionRef.current(error)
      ) {
        return;
      }
      replaceRemoveContext(Object.freeze({
        taskId: context.taskId,
        account: context.account,
        subject,
        failure: taskFailure("start_remove", "stock_token_remove", error),
      }));
    } finally {
      operationAuthority.finishControl(activeRequest);
      if (operationAuthority.isCurrent(activeRequest)) {
        replaceActionIntent(undefined);
        replacePending(false);
      }
    }
  }, [
    acceptOperation,
    clearRemove,
    markTerminalHandled,
    operationAuthority,
    replaceActionIntent,
    replacePending,
    replaceDelivery,
    replaceRemoveContext,
    requestOptions,
    taskFailure,
  ]);

  const openRemove = useCallback((
    subject: StockTokenRemoveSubject,
  ): boolean => {
    const currentAccount = accountRef.current;
    if (
      currentAccount === undefined ||
      currentAccount.chainId !== subject.selection.account.chainId ||
      currentAccount.address !== subject.selection.account.address ||
      pendingRef.current ||
      delivery !== undefined ||
      operationRef.current !== null ||
      addContextRef.current !== undefined ||
      observationUnavailableRef.current
    ) {
      return false;
    }
    const activeRequest = operationAuthority.beginControl();
    if (activeRequest === undefined) return false;
    removeTaskSequenceRef.current += 1;
    replaceDismissedRemovePresentation(undefined);
    const context = Object.freeze({
      taskId: removeTaskSequenceRef.current,
      account: currentAccount,
      subject,
    });
    replaceRemoveContext(context);
    void prepareRemove(context, activeRequest);
    return true;
  }, [
    delivery,
    operationAuthority,
    prepareRemove,
    replaceDismissedRemovePresentation,
    replaceRemoveContext,
  ]);

  const retryAdd = useCallback((): void => {
    const context = addContextRef.current;
    const failure = context?.failure;
    if (context === undefined || failure?.presentation.retryable !== true) return;
    if (failure.action === "start_add" && failure.candidate !== undefined) {
      clearAddFailure(context);
      void addCandidate(failure.candidate);
    } else if (failure.action === "confirm_add") {
      clearAddFailure(context);
      const current = operationRef.current;
      const consent = addConsentRef.current;
      if (current !== null && consent !== undefined) {
        void confirmCapturedAddition(current, consent);
      }
    } else if (failure.action === "cancel_add") {
      clearAddFailure(context);
      void runOperation("cancel", "closing_add");
    }
  }, [addCandidate, clearAddFailure, confirmCapturedAddition, runOperation]);

  const retryRemove = useCallback((): void => {
    const context = removeContextRef.current;
    const failure = context?.failure;
    if (context === undefined || failure?.presentation.retryable !== true) return;
    clearRemoveFailure(context);
    if (failure.action === "start_remove") {
      const activeRequest = operationAuthority.beginControl();
      if (activeRequest !== undefined) {
        void prepareRemove(context, activeRequest);
      }
    } else if (failure.action === "confirm_remove") {
      void runOperation("confirm", "confirming_remove");
    } else if (failure.action === "cancel_remove") {
      void runOperation("cancel", "closing_remove");
    }
  }, [clearRemoveFailure, operationAuthority, prepareRemove, runOperation]);

  const currentOperationTask = presentStockTokenOperationTask({
    operation,
    account,
    pending,
    actionIntent,
    delivery,
  });
  const operationTask =
    currentOperationTask !== undefined &&
    dismissedExternalOperationId === currentOperationTask.operation.operationId &&
    !currentOperationTask.terminal
      ? undefined
      : currentOperationTask;
  const presentedAddTask = presentStockTokenAddTask({
    context: addContext,
    actionIntent,
    operationTask: currentOperationTask,
    delivery,
  });
  const addTask = addContext !== undefined &&
    dismissedAddTaskId === addContext.taskId &&
    (
      presentedAddTask.presentation?.addStatus.status === "delivery_unknown" ||
      presentedAddTask.presentation?.addStatus.status === "adding"
    )
    ? Object.freeze({
        presentation: undefined,
        claimsOperation: presentedAddTask.claimsOperation,
      })
    : presentedAddTask;
  const informationTask = presentStockTokenInformationTask(exactRead);
  const presentedRemoveTask = presentStockTokenRemoveTask({
    context: removeContext,
    actionIntent,
    operationTask: currentOperationTask,
    delivery,
  });
  const removeOperationId = delivery?.task === "remove"
    ? delivery.result.operationId
    : presentedRemoveTask.claimsOperation
      ? currentOperationTask?.operation.operationId
      : undefined;
  const removeTask =
    removeContext !== undefined &&
    dismissedRemovePresentation?.taskId === removeContext.taskId &&
    dismissedRemovePresentation.operationId === removeOperationId &&
    (
      presentedRemoveTask.presentation?.status === "delivery_unknown" ||
      presentedRemoveTask.presentation?.status === "removing" ||
      presentedRemoveTask.presentation?.status === "closing"
    )
      ? Object.freeze({
          presentation: undefined,
          claimsOperation: presentedRemoveTask.claimsOperation,
        })
      : presentedRemoveTask;

  const closeAdd = useCallback((): boolean => {
    const task = presentStockTokenAddTask({
      context: addContextRef.current,
      actionIntent: actionIntentRef.current,
      operationTask: presentStockTokenOperationTask({
        operation: operationRef.current,
        account: accountRef.current,
        pending: pendingRef.current,
        actionIntent: actionIntentRef.current,
        delivery: deliveryRef.current,
      }),
      delivery,
    });
    if (task.presentation?.addStatus.status === "delivery_unknown") {
      const context = addContextRef.current;
      if (context !== undefined) replaceDismissedAddTaskId(context.taskId);
      return true;
    }
    if (task.presentation?.addStatus.status === "terminal") {
      markTerminalHandled(task.presentation.addStatus.operation.operationId);
      clearAdd();
      return true;
    }
    const current = operationRef.current;
    if (
      task.claimsOperation &&
      current?.state === "awaiting_confirmation"
    ) {
      void runOperation("cancel", "closing_add");
      return false;
    }
    clearAdd();
    return true;
  }, [
    clearAdd,
    delivery,
    markTerminalHandled,
    replaceDismissedAddTaskId,
    runOperation,
  ]);

  const closeRemove = useCallback((): boolean => {
    const task = presentStockTokenRemoveTask({
      context: removeContextRef.current,
      actionIntent: actionIntentRef.current,
      operationTask: presentStockTokenOperationTask({
        operation: operationRef.current,
        account: accountRef.current,
        pending: pendingRef.current,
        actionIntent: actionIntentRef.current,
        delivery: deliveryRef.current,
      }),
      delivery,
    });
    if (task.presentation?.status === "delivery_unknown") {
      const context = removeContextRef.current;
      if (context !== undefined) {
        replaceDismissedRemovePresentation(Object.freeze({
          taskId: context.taskId,
          operationId: task.presentation.delivery.operationId,
        }));
      }
      return true;
    }
    if (task.presentation?.status === "terminal") {
      markTerminalHandled(task.presentation.operation.operationId);
      clearRemove();
      return true;
    }
    const current = operationRef.current;
    if (
      task.claimsOperation &&
      current?.state === "awaiting_confirmation"
    ) {
      void runOperation("cancel", "closing_remove");
      return false;
    }
    clearRemove();
    return true;
  }, [
    clearRemove,
    delivery,
    markTerminalHandled,
    replaceDismissedRemovePresentation,
    runOperation,
  ]);

  const acknowledgeCurrentOperation = useCallback((): void => {
    const current = operationRef.current;
    if (current === null || !isTokenCatalogOperationTerminal(current.state)) return;
    replaceDismissedExternalOperationId(undefined);
    markTerminalHandled(current.operationId);
    if (current.kind === "add" && addContextRef.current !== undefined) {
      clearAdd();
    } else if (current.kind === "remove" && removeContextRef.current !== undefined) {
      clearRemove();
    } else {
      replaceOperation(null);
    }
  }, [
    clearAdd,
    clearRemove,
    markTerminalHandled,
    replaceDismissedExternalOperationId,
    replaceOperation,
  ]);

  const dismissExternalOperation = useCallback((): void => {
    const current = operationRef.current;
    if (current === null || isTokenCatalogOperationTerminal(current.state)) return;
    replaceDismissedExternalOperationId(current.operationId);
  }, [replaceDismissedExternalOperationId]);

  useEffect(() => {
    operationAuthority.activate();
    return () => {
      operationAuthority.close();
    };
  }, [operationAuthority]);

  const accountKey = account === undefined
    ? undefined
    : `${account.connectionRevision}:${account.chainId}:${account.address}`;
  useEffect(() => {
    if (
      operationRef.current === null &&
      deliveryRef.current === undefined &&
      !pendingRef.current
    ) {
      clearAddForm();
      replaceDismissedRemovePresentation(undefined);
      replaceRemoveContext(undefined);
    }
  }, [
    accountKey,
    clearAddForm,
    replaceDismissedRemovePresentation,
    replaceRemoveContext,
  ]);

  useEffect(() => {
    const current = operationRef.current;
    const consent = addConsentRef.current;
    if (
      current === null ||
      consent === undefined ||
      current.kind !== "add" ||
      current.state !== "awaiting_confirmation" ||
      pending ||
      delivery !== undefined ||
      sameConnectedAccount(consent.form.account, account)
    ) return;
    void runOperation("cancel", "closing_add");
  }, [account, delivery, pending, runOperation]);

  useEffect(() => {
    const consent = addConsentRef.current;
    if (
      consent === undefined ||
      operation === null ||
      operation.state !== "awaiting_confirmation" ||
      pending ||
      delivery !== undefined
    ) {
      return;
    }
    void confirmCapturedAddition(operation, consent);
  }, [
    confirmCapturedAddition,
    delivery,
    operation,
    pending,
  ]);

  const operationId =
    operation?.operationId ?? delivery?.result.operationId;
  useEffect(() => {
    if (pending) return;
    const activeRequest = operationAuthority.beginRead();
    if (activeRequest === undefined) return;
    let timer: number | undefined;
    const poll = async (): Promise<void> => {
      try {
        const next = operationId === undefined
          ? await loadCurrentTokenOperation(
              requestOptions(activeRequest.signal),
            )
          : (await loadTokenOperation(
              operationId,
              requestOptions(activeRequest.signal),
            )).operation;
        if (!operationAuthority.isCurrent(activeRequest)) return;
        if (
          next !== null &&
          (
            !isTokenCatalogOperationTerminal(next.state) ||
            handledTerminalOperationRef.current !== next.operationId
          )
        ) {
          acceptOperation(next);
        }
      } catch (error) {
        if (
          !operationAuthority.isCurrent(activeRequest) ||
          recoverSessionRef.current(error)
        ) {
          return;
        }
        if (
          operationId !== undefined &&
          isBrowserRequestFailureCode(error, "token_operation_not_found")
        ) {
          if (deliveryRef.current?.result.operationId !== operationId) {
            replaceOperation(null);
            publishActionError(
              "Token operation unavailable",
              "stock_token_change",
              error,
            );
            return;
          }
        }
      }
      if (operationAuthority.isCurrent(activeRequest)) {
        timer = window.setTimeout(() => {
          void poll();
        }, browserPollMilliseconds);
      }
    };
    void poll();
    return () => {
      operationAuthority.cancelRead(activeRequest);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [
    acceptOperation,
    operationAuthority,
    operationId,
    pending,
    publishActionError,
    replaceOperation,
    requestOptions,
  ]);

  return useMemo(() => Object.freeze({
    delivery,
    pending,
    addContext,
    removeContext,
    operation,
    operationTask,
    actionIntent,
    addTask,
    informationTask,
    removeTask,
    openAdd,
    closeAdd,
    addCandidate: (candidate: OfficialStockTokenCandidate) => {
      void addCandidate(candidate);
    },
    retryAdd,
    openRemove,
    closeRemove,
    confirmRemove: () => {
      void runOperation("confirm", "confirming_remove");
    },
    retryRemove,
    confirmCurrentOperation: () => {
      const current = operationRef.current;
      void runOperation(
        "confirm",
        current?.kind === "remove" ? "confirming_remove" : "confirming_add",
      );
    },
    cancelCurrentOperation: () => {
      const current = operationRef.current;
      void runOperation(
        "cancel",
        current?.kind === "remove" ? "closing_remove" : "closing_add",
      );
    },
    acknowledgeCurrentOperation,
    dismissExternalOperation,
  }), [
    actionIntent,
    acknowledgeCurrentOperation,
    addCandidate,
    addContext,
    addTask,
    closeAdd,
    closeRemove,
    delivery,
    informationTask,
    dismissExternalOperation,
    openAdd,
    openRemove,
    operation,
    operationTask,
    pending,
    removeContext,
    removeTask,
    retryAdd,
    retryRemove,
    runOperation,
  ]);
};
