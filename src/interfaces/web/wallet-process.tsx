import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type {
  WalletCurrentOperationProjection,
  WalletManagementOperation,
  WalletOperationPresentation,
} from "../../wallet/operation-contract.js";
import {
  isDeliveryUnknown,
  type DeliveryUnknown,
} from "../operation-delivery.js";
import type { NotificationNotice } from "./notification.js";
import type { ConnectedAccount } from "./account-assets-controller.js";
import {
  isBrowserRequestFailureCode,
  type BrowserFetch,
} from "./browser-client.js";
import { createBrowserSessionRecovery } from "./browser-session-recovery.js";
import {
  humanFailureText,
  presentBrowserRequestFailure,
  type HumanFailurePresentation,
  type HumanFailureTaskContext,
} from "./human-failures.js";
import {
  createBrowserRequestAuthority,
  type BrowserRequest,
} from "./request-authority.js";
import {
  cancelWalletOperation,
  confirmWalletOperation,
  loadWalletOperation,
  loadWalletProjection,
  startWalletOperation,
} from "./wallet-client.js";
import {
  walletConnectionActions,
  walletOperationActions,
  walletOperationNotification,
  type WalletConnectionAction,
  type WalletOperationAction,
} from "./wallet-dialog-view.js";
import {
  createWalletObservationState,
  createWalletObservationStore,
  observeExactWalletOperation,
  observeExpiredWalletOperation,
  observeWalletCurrent,
  trackWalletOperationResult,
  type WalletObservationState,
  walletObservationStorageKey,
} from "./wallet-observation.js";

const browserPollMilliseconds = 500;

export type WalletProcessReadState =
  | Readonly<{
      status: "loading";
      failure?: HumanFailurePresentation;
    }>
  | Readonly<{
      status: "ready";
      wallet: WalletCurrentOperationProjection;
      observationFailure?: HumanFailurePresentation;
    }>;

export type WalletProcessAction =
  | WalletConnectionAction
  | WalletOperationAction;

export type WalletActionFailure = Readonly<{
  action: WalletProcessAction;
  connectionRevision: string;
  operationId: string;
  failure: HumanFailurePresentation;
}>;

export type WalletDelivery = Readonly<{
  task: "connect" | "disconnect";
  connectionRevision: string;
  result: DeliveryUnknown;
}>;

export const connectedWalletAccount = (
  wallet: WalletCurrentOperationProjection | undefined,
): ConnectedAccount | undefined => wallet?.connection.status === "connected"
  ? Object.freeze({
      chainId: wallet.connection.chainId,
      address: wallet.connection.address,
      connectionRevision: wallet.connectionRevision,
    })
  : undefined;

const createBrowserWalletObservationStore = () =>
  createWalletObservationStore(Object.freeze({
    read: (): string | null =>
      window.sessionStorage.getItem(walletObservationStorageKey),
    write: (value: string | undefined): void => {
      if (value === undefined) {
        window.sessionStorage.removeItem(walletObservationStorageKey);
      } else {
        window.sessionStorage.setItem(
          walletObservationStorageKey,
          value,
        );
      }
    },
  }));

export interface WalletProcess {
  readonly state: WalletProcessReadState;
  readonly wallet: WalletCurrentOperationProjection | undefined;
  readonly operationPresentation: WalletOperationPresentation | undefined;
  readonly terminalOperation: WalletManagementOperation | undefined;
  readonly account: ConnectedAccount | undefined;
  readonly observationUnavailable: boolean;
  readonly pending: boolean;
  readonly pendingAction: WalletProcessAction | undefined;
  readonly pendingOperationId: string | undefined;
  readonly delivery: WalletDelivery | undefined;
  readonly actionFailure: WalletActionFailure | undefined;
  readonly recoverSession: (error: unknown) => boolean;
  readonly retryObservation: () => void;
  readonly runAction: (
    action: WalletProcessAction,
    operationId?: string,
  ) => Promise<void>;
  readonly acknowledgeTerminal: (operationId: string) => void;
  readonly dismissOperation: () => void;
}

export const useWalletProcess = ({
  csrfToken,
  onNotification,
  request,
}: Readonly<{
  csrfToken: () => string;
  onNotification: (notice: NotificationNotice) => void;
  request?: BrowserFetch;
}>): WalletProcess => {
  const [state, setState] =
    useState<WalletProcessReadState>({ status: "loading" });
  const stateRef = useRef<WalletProcessReadState>(state);
  stateRef.current = state;
  const [dismissedOperationId, setDismissedOperationId] =
    useState<string>();
  const dismissedOperationIdRef = useRef(dismissedOperationId);
  dismissedOperationIdRef.current = dismissedOperationId;
  const [delivery, setDelivery] = useState<WalletDelivery>();
  const deliveryRef = useRef(delivery);
  deliveryRef.current = delivery;
  const [pending, setPending] = useState(false);
  const [pendingAction, setPendingAction] =
    useState<WalletProcessAction>();
  const [pendingOperationId, setPendingOperationId] =
    useState<string>();
  const [observationGeneration, setObservationGeneration] = useState(0);
  const [actionFailure, setActionFailure] =
    useState<WalletActionFailure>();
  const [terminalOperation, setTerminalOperation] =
    useState<WalletManagementOperation>();
  const terminalOperationRef = useRef(terminalOperation);
  terminalOperationRef.current = terminalOperation;
  const [authority] = useState(createBrowserRequestAuthority);
  const [recoverSession] = useState(() =>
    createBrowserSessionRecovery(() => {
      window.location.reload();
    }));
  const [observationStore] = useState(createBrowserWalletObservationStore);
  const observationRef = useRef<WalletObservationState>(
    observationStore.load(),
  );
  const requestRef = useRef(request);
  requestRef.current = request;
  const notificationRef = useRef(onNotification);
  notificationRef.current = onNotification;
  const csrfTokenRef = useRef(csrfToken);
  csrfTokenRef.current = csrfToken;

  const replaceObservation = useCallback((
    next: WalletObservationState,
  ): void => {
    observationRef.current = next;
    observationStore.save(next);
  }, [observationStore]);

  const requestOptions = useCallback((
    activeRequest: BrowserRequest,
  ) => Object.freeze({
    ...(requestRef.current === undefined
      ? {}
      : { request: requestRef.current }),
    ...(activeRequest.signal === undefined
      ? {}
      : { signal: activeRequest.signal }),
  }), []);

  const refresh = useCallback(async (
    activeRequest: BrowserRequest,
  ): Promise<boolean> => {
    try {
      const options = requestOptions(activeRequest);
      const wallet = await loadWalletProjection(options);
      if (!authority.isCurrent(activeRequest)) return false;
      let resolved = observeWalletCurrent(observationRef.current, wallet);
      if (resolved.kind === "read_exact") {
        const exactObservation = resolved;
        try {
          const presentation = await loadWalletOperation(
            exactObservation.operationId,
            options,
          );
          if (!authority.isCurrent(activeRequest)) return false;
          const exact = observeExactWalletOperation(
            exactObservation,
            presentation,
          );
          if (exact.kind === "retry") return false;
          resolved = exact;
        } catch (error) {
          if (!authority.isCurrent(activeRequest)) return false;
          if (!isBrowserRequestFailureCode(error, "state_conflict")) {
            throw error;
          }
          resolved = observeExpiredWalletOperation(exactObservation);
        }
      }
      replaceObservation(resolved.state);
      const currentOperationId = resolved.wallet.status === "present"
        ? resolved.wallet.presentation.operation.operationId
        : undefined;
      if (
        deliveryRef.current !== undefined &&
        (
          currentOperationId === deliveryRef.current.result.operationId ||
          resolved.terminal?.operationId ===
            deliveryRef.current.result.operationId
        )
      ) {
        deliveryRef.current = undefined;
        setDelivery(undefined);
      }
      if (
        dismissedOperationIdRef.current !== undefined &&
        dismissedOperationIdRef.current !== currentOperationId
      ) {
        dismissedOperationIdRef.current = undefined;
        setDismissedOperationId(undefined);
      }
      const next = Object.freeze({
        status: "ready" as const,
        wallet: resolved.wallet,
      });
      stateRef.current = next;
      setState(next);
      if (resolved.terminal !== undefined) {
        terminalOperationRef.current = resolved.terminal;
        setTerminalOperation(resolved.terminal);
        const notice = walletOperationNotification(resolved.terminal);
        if (notice !== undefined) notificationRef.current(notice);
      }
      return true;
    } catch (error) {
      if (!authority.isCurrent(activeRequest)) return false;
      if (recoverSession(error)) return false;
      const failure = presentBrowserRequestFailure("wallet_status", error);
      const current = stateRef.current;
      const next: WalletProcessReadState = current.status === "ready"
        ? Object.freeze({ ...current, observationFailure: failure })
        : Object.freeze({ status: "loading", failure });
      stateRef.current = next;
      setState(next);
      return false;
    }
  }, [authority, recoverSession, replaceObservation, requestOptions]);

  const retryObservation = useCallback((): void => {
    setObservationGeneration((current) => current + 1);
  }, []);

  const runAction = useCallback(async (
    action: WalletProcessAction,
    requestedOperationId?: string,
  ): Promise<void> => {
    const current = stateRef.current;
    if (current.status !== "ready" || delivery !== undefined) return;
    const connectionAction = action === "connect" || action === "disconnect";
    const operationId = connectionAction
      ? requestedOperationId
      : current.wallet.status === "present"
        ? current.wallet.presentation.operation.operationId
        : undefined;
    if (operationId === undefined) return;
    const activeRequest = authority.beginControl();
    if (activeRequest === undefined) return;
    setActionFailure(undefined);
    setPendingAction(action);
    setPendingOperationId(operationId);
    setPending(true);
    try {
      const options = requestOptions(activeRequest);
      if (action === "connect" || action === "disconnect") {
        if (
          current.wallet.status === "present" ||
          !walletConnectionActions(current.wallet).includes(action)
        ) {
          return;
        }
        const result = await startWalletOperation(
          operationId,
          action,
          current.wallet.connectionRevision,
          csrfTokenRef.current(),
          options,
        );
        if (isDeliveryUnknown(result)) {
          replaceObservation(createWalletObservationState(result.operationId));
          const nextDelivery = Object.freeze({
            task: action,
            connectionRevision: current.wallet.connectionRevision,
            result,
          });
          deliveryRef.current = nextDelivery;
          setDelivery(nextDelivery);
          return;
        }
        if (result.status === "operation_started") {
          replaceObservation(trackWalletOperationResult(
            observationRef.current,
            result.operation,
          ));
        }
      } else {
        if (
          current.wallet.status !== "present" ||
          !walletOperationActions(current.wallet.presentation).includes(action)
        ) {
          return;
        }
        const operation = current.wallet.presentation.operation;
        const result = action === "confirm"
          ? await confirmWalletOperation(
              operation.operationId,
              operation.connectionRevision,
              csrfTokenRef.current(),
              options,
            )
          : await cancelWalletOperation(
              operation.operationId,
              operation.connectionRevision,
              csrfTokenRef.current(),
              options,
            );
        if (isDeliveryUnknown(result)) {
          replaceObservation(createWalletObservationState(result.operationId));
          const nextDelivery = Object.freeze({
            task: operation.kind,
            connectionRevision: operation.connectionRevision,
            result,
          });
          deliveryRef.current = nextDelivery;
          setDelivery(nextDelivery);
          return;
        }
        replaceObservation(trackWalletOperationResult(
          observationRef.current,
          result,
        ));
      }
      await refresh(activeRequest);
    } catch (error) {
      if (!authority.isCurrent(activeRequest) || recoverSession(error)) return;
      if (isBrowserRequestFailureCode(error, "state_conflict")) {
        const reconciled = await refresh(activeRequest);
        if (!authority.isCurrent(activeRequest)) return;
        const refreshed = stateRef.current;
        const requestedStateReached = refreshed.status === "ready" &&
          (
            action === "connect"
              ? refreshed.wallet.connection.status === "connected"
              : action === "disconnect"
                ? refreshed.wallet.connection.status === "disconnected"
                : false
          );
        const exactOperationPresent = refreshed.status === "ready" &&
          refreshed.wallet.status === "present" &&
          refreshed.wallet.presentation.operation.operationId === operationId;
        if (reconciled && (requestedStateReached || exactOperationPresent)) {
          return;
        }
        const context: HumanFailureTaskContext =
          action === "disconnect" ? "wallet_disconnection" : "wallet_connection";
        setActionFailure(Object.freeze({
          action,
          connectionRevision: current.wallet.connectionRevision,
          operationId,
          failure: presentBrowserRequestFailure(context, error),
        }));
      } else {
        const context: HumanFailureTaskContext =
          action === "disconnect" ||
          (
            current.wallet.status === "present" &&
            current.wallet.presentation.operation.kind === "disconnect"
          )
            ? "wallet_disconnection"
            : "wallet_connection";
        setActionFailure(Object.freeze({
          action,
          connectionRevision: current.wallet.connectionRevision,
          operationId,
          failure: presentBrowserRequestFailure(context, error),
        }));
      }
    } finally {
      authority.finishControl(activeRequest);
      if (authority.isCurrent(activeRequest)) {
        setPending(false);
        setPendingAction(undefined);
        setPendingOperationId(undefined);
      }
    }
  }, [
    authority,
    delivery,
    recoverSession,
    refresh,
    replaceObservation,
    requestOptions,
  ]);

  const wallet = state.status === "ready" ? state.wallet : undefined;
  const operationPresentation =
    wallet?.status === "present" &&
      wallet.presentation.operation.operationId !== dismissedOperationId
      ? wallet.presentation
      : undefined;
  const account = connectedWalletAccount(wallet);
  const observationUnavailable =
    state.status === "ready" && state.observationFailure !== undefined;

  const dismissOperation = useCallback((): void => {
    const current = stateRef.current;
    if (
      current.status === "ready" &&
      current.wallet.status === "present" &&
      walletOperationActions(current.wallet.presentation).length === 0
    ) {
      const operationId =
        current.wallet.presentation.operation.operationId;
      dismissedOperationIdRef.current = operationId;
      setDismissedOperationId(operationId);
    }
  }, []);

  const acknowledgeTerminal = useCallback((operationId: string): void => {
    if (terminalOperationRef.current?.operationId !== operationId) return;
    terminalOperationRef.current = undefined;
    setTerminalOperation(undefined);
  }, []);

  useEffect(() => {
    authority.activate();
    return () => {
      authority.close();
    };
  }, [authority]);

  useEffect(() => {
    if (pending) return;
    const activeRequest = authority.beginRead();
    if (activeRequest === undefined) return;
    let timer: number | undefined;
    const poll = async (): Promise<void> => {
      await refresh(activeRequest);
      if (!authority.isCurrent(activeRequest)) return;
      timer = window.setTimeout(() => {
        void poll();
      }, browserPollMilliseconds);
    };
    void poll();
    return () => {
      authority.cancelRead(activeRequest);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [authority, observationGeneration, pending, refresh]);

  return useMemo(() => Object.freeze({
    state,
    wallet,
    operationPresentation,
    terminalOperation,
    account,
    observationUnavailable,
    pending,
    pendingAction,
    pendingOperationId,
    delivery,
    actionFailure,
    recoverSession,
    retryObservation,
    runAction,
    acknowledgeTerminal,
    dismissOperation,
  }), [
    account,
    acknowledgeTerminal,
    actionFailure,
    delivery,
    dismissOperation,
    observationUnavailable,
    operationPresentation,
    pending,
    pendingAction,
    pendingOperationId,
    recoverSession,
    retryObservation,
    runAction,
    state,
    terminalOperation,
    wallet,
  ]);
};
