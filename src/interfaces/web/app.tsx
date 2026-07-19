import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { productDisplayName } from "../../core/browser.js";
import type {
  WalletCurrentOperationProjection,
  WalletManagementOperation,
  WalletOperationPresentation,
  WalletQrMatrix,
} from "../../wallet/operation-contract.js";
import {
  browserPagePaths,
  browserCsrfMetaName,
  parseBrowserCsrfToken,
  parseBrowserPagePath,
} from "../browser-contract.js";
import {
  cancelWalletOperation,
  confirmWalletOperation,
  loadWalletOperation,
  loadWalletProjection,
  startWalletOperation,
} from "./wallet-client.js";
import {
  browserActionFailureMessage,
  isBrowserResponseCode,
} from "./browser-client.js";
import {
  createWalletObservationStore,
  observeExactWalletOperation,
  observeExpiredWalletOperation,
  observeWalletCurrent,
  trackWalletOperationResult,
  type WalletObservationState,
  walletObservationStorageKey,
} from "./wallet-observation.js";
import {
  createBrowserRequestAuthority,
  type BrowserRequest,
} from "./request-authority.js";
import { createBrowserSessionRecovery } from "./browser-session-recovery.js";
import {
  walletConnectionActions,
  walletConnectionCopy,
  walletDisconnectActionLabel,
  walletConnectionFields,
  walletNavigationLabel,
  walletOperationActions,
  walletOperationConfirmationMessage,
  walletOperationCopy,
  walletOperationNotice,
  walletOperationNotification,
  type WalletConnectionAction,
  type WalletOperationAction,
} from "./wallet-dialog-view.js";
import type { NotificationNotice } from "./notification.js";
import { TokenCatalogPage } from "./token-catalog-page.js";

type ReadyState = {
  readonly status: "ready";
  readonly wallet: WalletCurrentOperationProjection;
};

type AppState =
  | { readonly status: "loading" }
  | ReadyState;

type ActiveNotification = {
  readonly notice: NotificationNotice;
  readonly sequence: number;
  readonly phase: "visible" | "exiting";
};

const browserPollMilliseconds = 500;
const standardToastMilliseconds = 5_000;
const errorToastMilliseconds = 8_000;
const toastExitMilliseconds = 180;

const createBrowserWalletObservationStore = () => createWalletObservationStore(Object.freeze({
  read: (): string | null => window.sessionStorage.getItem(walletObservationStorageKey),
  write: (operationId: string | undefined): void => {
    if (operationId === undefined) {
      window.sessionStorage.removeItem(walletObservationStorageKey);
    } else {
      window.sessionStorage.setItem(walletObservationStorageKey, operationId);
    }
  },
}));

const csrfToken = (): string => {
  const value = document.querySelector<HTMLMetaElement>(
    `meta[name="${browserCsrfMetaName}"]`,
  )?.content;
  try { return parseBrowserCsrfToken(value); }
  catch { throw new Error("The browser request token is unavailable."); }
};

const QrCode = ({ matrix }: { readonly matrix: WalletQrMatrix }) => (
  <svg
    className="qr-code"
    viewBox={`0 0 ${matrix.size + 8} ${matrix.size + 8}`}
    role="img"
    aria-label="Robinhood Wallet pairing code"
    shapeRendering="crispEdges"
  >
    <rect width="100%" height="100%" fill="white" />
    {matrix.rows.flatMap((row, y) => [...row].map((module, x) => module === "1"
      ? <rect key={`${x}:${y}`} x={x + 4} y={y + 4} width="1" height="1" fill="black" />
      : null))}
  </svg>
);

const ConnectionDetails = ({
  wallet,
  requestPending,
  onAction,
  onClose,
}: {
  readonly wallet: WalletCurrentOperationProjection;
  readonly requestPending: boolean;
  readonly onAction: (action: WalletConnectionAction) => void;
  readonly onClose: () => void;
}) => {
  const copy = walletConnectionCopy(wallet.connection);
  const fields = walletConnectionFields(wallet.connection);
  const actions = walletConnectionActions(wallet);
  return (
    <>
      <header>
        <h1>{copy.heading}</h1>
        <p>{copy.message}</p>
      </header>
      {fields.length === 0 ? null : (
        <dl>
          {fields.flatMap((field) => [
            <dt key={`${field.label}:label`}>{field.label}</dt>,
            <dd key={`${field.label}:value`}>{field.value}</dd>,
          ])}
        </dl>
      )}
      <div className="actions">
        <button
          type="button"
          className="secondary"
          disabled={requestPending}
          onClick={() => { onClose(); }}
        >
          Close
        </button>
        {actions.includes("disconnect") ? (
          <button
            type="button"
            className="danger"
            disabled={requestPending}
            onClick={() => { onAction("disconnect"); }}
          >
            {walletDisconnectActionLabel(wallet.connection)}
          </button>
        ) : null}
        {actions.includes("connect") ? (
          <button
            type="button"
            disabled={requestPending}
            onClick={() => { onAction("connect"); }}
          >
            Connect wallet
          </button>
        ) : null}
      </div>
    </>
  );
};

const OperationDetails = ({
  presentation,
  requestPending,
  onAction,
}: {
  readonly presentation: WalletOperationPresentation;
  readonly requestPending: boolean;
  readonly onAction: (action: WalletOperationAction) => void;
}) => {
  const { operation, qr } = presentation;
  const copy = walletOperationCopy(operation);
  const actions = walletOperationActions(presentation);
  const notice = walletOperationNotice(presentation);
  return (
    <>
      <header>
        <h1>{copy.heading}</h1>
        <p>{copy.message}</p>
      </header>
      {qr === undefined ? null : (
        <div className="qr-wrap">
          <QrCode matrix={qr} />
        </div>
      )}
      {notice === undefined ? null : (
        <div className="notice">
          <strong>Read-only view</strong>
          <p>{notice}</p>
        </div>
      )}
      {operation.state === "awaiting_confirmation" ? (
        <div className="warning">
          <strong>Confirmation required</strong>
          <p>{walletOperationConfirmationMessage(operation)}</p>
        </div>
      ) : null}
      {operation.failure === null ? null : (
        <p className="error">{operation.failure.error.message}</p>
      )}
      {actions.length === 0 ? null : (
        <div className="actions">
          {actions.includes("cancel") ? (
            <button
              type="button"
              className="secondary"
              disabled={requestPending}
              onClick={() => { onAction("cancel"); }}
            >
              Cancel
            </button>
          ) : null}
          {actions.includes("confirm") ? (
            <button
              type="button"
              disabled={requestPending}
              onClick={() => { onAction("confirm"); }}
            >
              Disconnect wallet
            </button>
          ) : null}
        </div>
      )}
    </>
  );
};

const Notification = ({
  notice,
  exiting,
}: {
  readonly notice: NotificationNotice;
  readonly exiting: boolean;
}) => (
  <div className="notification-region">
    <div
      className={`notification notification-${notice.tone}${exiting ? " notification-exiting" : ""}`}
      role={notice.tone === "error" ? "alert" : "status"}
    >
      <strong>{notice.heading}</strong>
      <p>{notice.message}</p>
    </div>
  </div>
);

const WalletDialog = ({
  wallet,
  requestPending,
  onConnectionAction,
  onOperationAction,
  onClose,
}: {
  readonly wallet: WalletCurrentOperationProjection;
  readonly requestPending: boolean;
  readonly onConnectionAction: (action: WalletConnectionAction) => void;
  readonly onOperationAction: (action: WalletOperationAction) => void;
  readonly onClose: () => void;
}) => {
  const dialog = useRef<HTMLDialogElement>(null);
  const presentation = wallet.status === "present"
    ? wallet.presentation
    : undefined;
  const closeWhenIdle = (): void => {
    if (presentation === undefined) onClose();
  };
  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    element.showModal();
    element.focus();
    return () => {
      if (element.open) element.close();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="wallet-dialog"
      aria-label="Wallet"
      tabIndex={-1}
      onCancel={(event) => {
        event.preventDefault();
        closeWhenIdle();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        closeWhenIdle();
      }}
    >
      {presentation === undefined
        ? (
            <ConnectionDetails
              wallet={wallet}
              requestPending={requestPending}
              onAction={onConnectionAction}
              onClose={onClose}
            />
          )
        : (
            <OperationDetails
              presentation={presentation}
              requestPending={requestPending}
              onAction={onOperationAction}
            />
          )}
    </dialog>
  );
};

export const App = () => {
  const [state, setState] = useState<AppState>({ status: "loading" });
  const [connectionDialogOpen, setConnectionDialogOpen] = useState(false);
  const [requestPending, setRequestPending] = useState(false);
  const [activeNotification, setActiveNotification] = useState<ActiveNotification | undefined>(undefined);
  const [requestAuthority] = useState(createBrowserRequestAuthority);
  const [sessionRecovery] = useState(() => createBrowserSessionRecovery(
    () => { window.location.reload(); },
  ));
  const [observationStore] = useState(createBrowserWalletObservationStore);
  const notificationSequence = useRef(0);
  const observation = useRef(observationStore.load());
  const walletNavigation = useRef<HTMLButtonElement>(null);
  const dialogHadFocus = useRef(false);

  const publishNotification = useCallback((notice: NotificationNotice): void => {
    notificationSequence.current += 1;
    setActiveNotification(Object.freeze({
      notice,
      sequence: notificationSequence.current,
      phase: "visible",
    }));
  }, []);

  const publishTerminalToast = useCallback((
    operation: WalletManagementOperation,
  ): void => {
    const notice = walletOperationNotification(operation);
    if (notice === undefined) return;
    publishNotification(notice);
  }, [publishNotification]);

  const publishControlError = useCallback((error: unknown): void => {
    publishNotification(Object.freeze({
      id: "wallet-control-error",
      tone: "error",
      heading: "Wallet action failed",
      message: browserActionFailureMessage(error),
    }));
  }, [publishNotification]);

  const recoverBrowserSession = useCallback((error: unknown): boolean => {
    return sessionRecovery(error);
  }, [sessionRecovery]);

  const replaceObservation = useCallback((next: WalletObservationState): void => {
    observation.current = next;
    observationStore.save(next);
  }, [observationStore]);

  const refresh = useCallback(async (request: BrowserRequest): Promise<boolean> => {
    try {
      const wallet = await loadWalletProjection(
        request.signal === undefined ? {} : { signal: request.signal },
      );
      if (!requestAuthority.isCurrent(request)) return false;
      let resolved = observeWalletCurrent(observation.current, wallet);
      if (resolved.kind === "read_exact") {
        const exactObservation = resolved;
        try {
          const presentation = await loadWalletOperation(
            exactObservation.operationId,
            request.signal === undefined ? {} : { signal: request.signal },
          );
          if (!requestAuthority.isCurrent(request)) return false;
          const exact = observeExactWalletOperation(exactObservation, presentation);
          if (exact.kind === "retry") return false;
          resolved = exact;
        } catch (error) {
          if (!requestAuthority.isCurrent(request)) return false;
          if (!isBrowserResponseCode(error, "state_conflict")) throw error;
          resolved = observeExpiredWalletOperation(exactObservation);
        }
      }
      replaceObservation(resolved.state);
      setState({ status: "ready", wallet: resolved.wallet });
      if (resolved.wallet.status === "present") setConnectionDialogOpen(false);
      if (resolved.terminal !== undefined) {
        setConnectionDialogOpen(false);
        publishTerminalToast(resolved.terminal);
      }
      return true;
    } catch (error) {
      if (!requestAuthority.isCurrent(request)) return false;
      recoverBrowserSession(error);
      return false;
    }
  }, [publishTerminalToast, recoverBrowserSession, replaceObservation, requestAuthority]);

  useEffect(() => {
    requestAuthority.activate();
    return () => { requestAuthority.close(); };
  }, [requestAuthority]);

  useEffect(() => {
    if (activeNotification === undefined) return;
    const sequence = activeNotification.sequence;
    const phase = activeNotification.phase;
    const delay = phase === "exiting"
      ? toastExitMilliseconds
      : activeNotification.notice.tone === "error"
        ? errorToastMilliseconds
        : standardToastMilliseconds;
    const timer = window.setTimeout(() => {
      setActiveNotification((current) => {
        if (current?.sequence !== sequence || current.phase !== phase) return current;
        return phase === "visible"
          ? Object.freeze({ ...current, phase: "exiting" })
          : undefined;
      });
    }, delay);
    return () => { window.clearTimeout(timer); };
  }, [activeNotification]);

  useEffect(() => {
    if (requestPending) return;
    const request = requestAuthority.beginRead();
    if (request === undefined) return;
    let timer: number | undefined;
    const poll = async (): Promise<void> => {
      await refresh(request);
      if (!requestAuthority.isCurrent(request)) return;
      timer = window.setTimeout(() => { void poll(); }, browserPollMilliseconds);
    };
    void poll();
    return () => {
      requestAuthority.cancelRead(request);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [refresh, requestAuthority, requestPending]);

  const trackOperationResult = useCallback((
    operation: WalletManagementOperation,
  ): void => {
    replaceObservation(trackWalletOperationResult(observation.current, operation));
  }, [replaceObservation]);

  const closeConnectionDialog = useCallback((): void => {
    setConnectionDialogOpen(false);
  }, []);

  const runControl = useCallback(async (
    action: WalletConnectionAction | WalletOperationAction,
  ): Promise<void> => {
    if (state.status !== "ready") return;
    const request = requestAuthority.beginControl();
    if (request === undefined) return;
    setRequestPending(true);
    try {
      if (action === "connect" || action === "disconnect") {
        if (state.wallet.status === "present") return;
        if (!walletConnectionActions(state.wallet).includes(action)) return;
        const token = csrfToken();
        const result = await startWalletOperation(
          action,
          state.wallet.connectionRevision,
          token,
        );
        if (result.status === "operation_started") {
          trackOperationResult(result.operation);
        }
      } else {
        if (state.wallet.status !== "present") return;
        const presentation = state.wallet.presentation;
        if (!walletOperationActions(presentation).includes(action)) return;
        const { operation } = presentation;
        if (action === "confirm") {
          const confirmed = await confirmWalletOperation(
            operation.operationId,
            operation.connectionRevision,
            csrfToken(),
          );
          trackOperationResult(confirmed);
        } else {
          const cancelled = await cancelWalletOperation(
            operation.operationId,
            operation.connectionRevision,
            csrfToken(),
          );
          trackOperationResult(cancelled);
        }
      }
      await refresh(request);
    } catch (error) {
      if (!requestAuthority.isCurrent(request)) return;
      if (recoverBrowserSession(error)) return;
      if (isBrowserResponseCode(error, "state_conflict")) {
        await refresh(request);
      } else {
        publishControlError(error);
      }
    } finally {
      requestAuthority.finishControl(request);
      if (requestAuthority.isCurrent(request)) setRequestPending(false);
    }
  }, [publishControlError, recoverBrowserSession, refresh, requestAuthority, state, trackOperationResult]);

  const wallet = state.status === "ready" ? state.wallet : undefined;
  const dialogOpen = wallet?.status === "present" ||
    (wallet !== undefined && connectionDialogOpen);
  useEffect(() => {
    if (dialogOpen) {
      dialogHadFocus.current = true;
      return;
    }
    if (dialogHadFocus.current && !requestPending) {
      walletNavigation.current?.focus();
      dialogHadFocus.current = false;
    }
  }, [dialogOpen, requestPending]);
  const activateWalletNavigation = (): void => {
    if (wallet === undefined || wallet.status === "present") return;
    if (walletConnectionActions(wallet).includes("connect")) {
      void runControl("connect");
      return;
    }
    setConnectionDialogOpen((current) => !current);
  };
  const pagePath = parseBrowserPagePath(window.location.pathname);
  return (
    <div className="app-shell">
      <nav className="app-nav" aria-label="Primary">
        <a className="product-name" href={browserPagePaths.root}>{productDisplayName}</a>
        <div className="page-navigation">
          <a
            className={pagePath === browserPagePaths.root ? "page-link active" : "page-link"}
            href={browserPagePaths.root}
            aria-current={pagePath === browserPagePaths.root ? "page" : undefined}
          >
            Home
          </a>
          <a
            className={pagePath === browserPagePaths.tokens ? "page-link active" : "page-link"}
            href={browserPagePaths.tokens}
            aria-current={pagePath === browserPagePaths.tokens ? "page" : undefined}
          >
            Tokens
          </a>
        </div>
        <button
          ref={walletNavigation}
          type="button"
          className="wallet-nav-control secondary"
          aria-expanded={dialogOpen}
          disabled={wallet === undefined || requestPending}
          onClick={() => { activateWalletNavigation(); }}
        >
          {walletNavigationLabel(wallet)}
        </button>
      </nav>
      {pagePath === browserPagePaths.root ? (
        <section className="intro">
          <p className="eyebrow">Robinhood Chain</p>
          <h1>Local wallet connection</h1>
          <p>Connect Robinhood Wallet to the local Little John runtime.</p>
        </section>
      ) : state.status === "ready" ? (
        <TokenCatalogPage
          wallet={state.wallet}
          getCsrfToken={csrfToken}
          recoverBrowserSession={recoverBrowserSession}
          onOpenWallet={activateWalletNavigation}
          onNotification={publishNotification}
        />
      ) : (
        <section className="intro"><p>Loading token catalog…</p></section>
      )}
      {dialogOpen && wallet !== undefined ? (
        <WalletDialog
          wallet={wallet}
          requestPending={requestPending}
          onConnectionAction={(action) => { void runControl(action); }}
          onOperationAction={(action) => { void runControl(action); }}
          onClose={closeConnectionDialog}
        />
      ) : null}
      {activeNotification === undefined ? null : (
        <Notification
          key={activeNotification.sequence}
          notice={activeNotification.notice}
          exiting={activeNotification.phase === "exiting"}
        />
      )}
    </div>
  );
};
