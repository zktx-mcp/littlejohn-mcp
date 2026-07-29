import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
} from "react";

import {
  type TokenCatalogOperation,
  isTokenCatalogOperationTerminal,
} from "../../token-catalog/browser.js";
import {
  projectAccountAssetExactView,
} from "../../account-assets/browser.js";
import {
  browserCsrfMetaName,
  browserLocationHref,
  browserLocations,
  browserPageMetadata,
  browserPages,
  parseBrowserCsrfToken,
  type BrowserLocation,
} from "../browser-contract.js";
import {
  AccountAssetsPage,
  type AccountAssetPageSnapshot,
} from "./account-assets-page.js";
import {
  sameConnectedAccount,
  useAccountAssetsController,
} from "./account-assets-controller.js";
import { ApplicationShell } from "./application-shell.js";
import { Icon } from "./icons.js";
import { PageHeader } from "./page-header.js";
import { CopyableIdentifier } from "./copyable-identifier.js";
import { DialogShell } from "./dialog-shell.js";
import type { ReferenceChartPort } from "./reference-chart.js";
import {
  AnalysisDialogContent,
  type AnalysisTarget,
} from "./analysis-dialog.js";
import { LoadingIndicator } from "./loading-indicator.js";
import {
  humanFailureText,
} from "./human-failures.js";
import {
  notificationClassName,
  notificationRole,
  type NotificationNotice,
} from "./notification.js";
import { PricesPage } from "./prices-page.js";
import { ReferencePricePage } from "./reference-price-page.js";
import {
  tokenOperationCopy,
} from "./token-catalog-view.js";
import { StockTokenAddDialog } from "./stock-token-add-dialog.js";
import {
  StockTokenInformationDialog,
} from "./stock-token-information-dialog.js";
import {
  StockTokenRemoveDialog,
  type StockTokenRemoveSubject,
} from "./stock-token-remove-dialog.js";
import { useStockTokenProcess } from "./stock-token-process.js";
import {
  walletConnectionActions,
  walletNavigationLabel,
} from "./wallet-dialog-view.js";
import {
  useWalletProcess,
} from "./wallet-process.js";
import { createBrowserOperationId } from "./operation-id.js";
import {
  WalletTaskDialog,
  type WalletModalTaskKind,
} from "./wallet-task-dialog.js";

type ActiveNotification = Readonly<{
  notice: NotificationNotice;
  sequence: number;
  phase: "visible" | "exiting";
}>;

type ActiveModalTask =
  | Readonly<{
      kind: "analysis";
      target: AnalysisTarget;
      originResourceKey: string;
      returnFocus: HTMLElement | undefined;
    }>
  | Readonly<{
      kind: WalletModalTaskKind;
      connectionRevision: string;
      operationId: string;
      returnFocus: HTMLElement | undefined;
    }>
  | Readonly<{
      kind: "stock_token_add";
      accountKey: string;
      originResourceKey: string;
      returnFocus: HTMLElement | undefined;
    }>
  | Readonly<{
      kind: "stock_token_information";
      selectionAddress: string;
      originResourceKey: string;
      returnFocus: HTMLElement | undefined;
    }>
  | Readonly<{
      kind: "stock_token_remove";
      subject: StockTokenRemoveSubject;
      returnFocus: HTMLElement | undefined;
    }>
  | Readonly<{
      kind: "external_token_operation";
      operationId: string;
      returnFocus: HTMLElement | undefined;
    }>;

const standardToastMilliseconds = 5_000;
const errorToastMilliseconds = 8_000;
const toastExitMilliseconds = 180;

const csrfToken = (): string => {
  const value = document.querySelector<HTMLMetaElement>(
    `meta[name="${browserCsrfMetaName}"]`,
  )?.content;
  try { return parseBrowserCsrfToken(value); }
  catch { throw new Error("The browser request token is unavailable."); }
};

const locationResourceKey = (
  locationState: AppProps["locationState"],
): string => {
  if (locationState.status === "invalid") {
    return `invalid:${locationState.baseLocation.page}`;
  }
  const browserLocation = locationState.location;
  return browserLocation.page === "reference_price"
    ? `${browserLocation.page}:${browserLocation.pairId}`
    : browserLocation.page;
};

const AnalysisTaskDialog = ({
  target,
  onClose,
  recoverSession,
}: {
  readonly target: AnalysisTarget;
  readonly onClose: () => void;
  readonly recoverSession: (error: unknown) => boolean;
}) => {
  return (
    <DialogShell
      titleId="analysis-dialog-title"
      title="Analysis"
      description={`Reading the exact ${target.kind} selected by the originating result.`}
      dismissible
      onClose={onClose}
      footer={(
        <div className="actions">
          <button type="button" className="secondary" onClick={onClose}>Close</button>
        </div>
      )}
      className="analysis-dialog"
    >
      <AnalysisDialogContent
        target={target}
        recoverSession={recoverSession}
      />
    </DialogShell>
  );
};

const ExternalTokenOperationDialog = ({
  operation,
  accountMatches,
  pending,
  onClose,
  onConfirm,
  onCancel,
}: Readonly<{
  operation: TokenCatalogOperation;
  accountMatches: boolean;
  pending: boolean;
  onClose: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}>) => {
  const copy = tokenOperationCopy(operation);
  const title = operation.kind === "add"
    ? "Add Stock Token"
    : "Remove Stock Token";
  const awaitingWebConfirmation =
    operation.interactionInterface === "web" &&
    operation.state === "awaiting_confirmation";
  const dismissible = !pending && (
    operation.interactionInterface === "cli" ||
    isTokenCatalogOperationTerminal(operation.state) ||
    awaitingWebConfirmation
  );
  return (
    <DialogShell
      titleId="retained-token-operation-title"
      title={title}
      description={copy.message}
      dismissible={dismissible}
      onClose={awaitingWebConfirmation ? onCancel : onClose}
      footer={(
        <div className="actions">
          {operation.interactionInterface === "cli" ||
          isTokenCatalogOperationTerminal(operation.state) ? (
            <button type="button" className="secondary" disabled={pending} onClick={onClose}>Close</button>
          ) : null}
          {awaitingWebConfirmation ? (
            <button type="button" className="secondary" disabled={pending} onClick={onCancel}>
              {operation.kind === "add" ? "Cancel addition" : "Keep token"}
            </button>
          ) : null}
          {awaitingWebConfirmation && accountMatches ? (
            <button
              type="button"
              className={operation.kind === "remove" ? "danger" : undefined}
              disabled={pending}
              onClick={onConfirm}
            >
              {operation.kind === "add" ? "Add token" : "Remove token"}
            </button>
          ) : null}
        </div>
      )}
    >
      <section aria-labelledby="retained-token-contract-heading">
        <h2 id="retained-token-contract-heading">Contract</h2>
        <CopyableIdentifier label="token contract address" value={operation.asset.address} />
      </section>
      {operation.interactionInterface === "cli" ? (
        <div className="notice">
          <strong>Read-only review</strong>
          <p>Continue this token change in the CLI.</p>
        </div>
      ) : null}
      {!accountMatches ? (
        <div className="warning">
          <strong>Different account</strong>
          <p>Confirmation is unavailable because the connected account changed.</p>
        </div>
      ) : null}
    </DialogShell>
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
      className={notificationClassName(notice, exiting)}
      role={notificationRole(notice)}
    >
      <strong>{notice.heading}</strong>
      <p>{notice.message}</p>
    </div>
  </div>
);

const PublicTasks = ({
  onNavigate,
}: {
  readonly onNavigate: (
    location: BrowserLocation,
    event: MouseEvent<HTMLAnchorElement>,
  ) => void;
}) => (
  <section className="content-section public-task-list" aria-labelledby="public-task-heading">
    <h2 id="public-task-heading">No wallet required</h2>
    <ul>
      <li>
        <a
          href={browserLocationHref(browserLocations.referencePrices())}
          onClick={(event) => {
            onNavigate(browserLocations.referencePrices(), event);
          }}
        >
          Read reference prices
        </a>
        <span>Compare available reference pairs and see when their values were updated.</span>
      </li>
    </ul>
  </section>
);

export interface AppProps {
  readonly referenceChart: ReferenceChartPort;
  readonly locationState:
    | Readonly<{ status: "valid"; location: BrowserLocation }>
    | Readonly<{ status: "invalid"; baseLocation: BrowserLocation }>;
  readonly navigationFocusVisible: boolean;
  readonly onNavigate: (
    location: BrowserLocation,
    event: MouseEvent<HTMLAnchorElement>,
  ) => void;
}

export const App = ({
  referenceChart,
  locationState,
  navigationFocusVisible,
  onNavigate,
}: AppProps) => {
  const activeLocation = locationState.status === "valid"
    ? locationState.location
    : undefined;
  const activeResourceKey = locationResourceKey(locationState);
  const navigationKey = locationState.status === "valid"
    ? browserLocationHref(locationState.location)
    : activeResourceKey;
  const pageMetadata = activeLocation === undefined
    ? undefined
    : browserPageMetadata(activeLocation);
  const accountPageSelected =
    activeLocation?.page === browserPages.assets.id;
  const [activeModalTask, setActiveModalTask] =
    useState<ActiveModalTask>();
  const [activeNotification, setActiveNotification] = useState<ActiveNotification>();
  const notificationSequence = useRef(0);
  const walletNavigation = useRef<HTMLButtonElement>(null);
  const previousModalTask = useRef<ActiveModalTask | undefined>(undefined);
  const taskReturnFocus = useRef<HTMLElement | undefined>(undefined);
  const previousNavigationKey = useRef(navigationKey);
  const focusRestoreEpoch = useRef(0);

  const publishNotification = useCallback((notice: NotificationNotice): void => {
    notificationSequence.current += 1;
    setActiveNotification(Object.freeze({ notice, sequence: notificationSequence.current, phase: "visible" }));
  }, []);

  const walletProcess = useWalletProcess({
    csrfToken,
    onNotification: publishNotification,
  });
  const state = walletProcess.state;
  const currentWallet = walletProcess.wallet;
  const walletOperationPresentation = walletProcess.operationPresentation;
  const walletTerminalOperation = walletProcess.terminalOperation;
  const currentAccount = walletProcess.account;
  const observationUnavailable = walletProcess.observationUnavailable;
  const walletPending = walletProcess.pending;
  const walletPendingAction = walletProcess.pendingAction;
  const walletPendingOperationId = walletProcess.pendingOperationId;
  const walletDelivery = walletProcess.delivery;
  const walletActionFailure = walletProcess.actionFailure;
  const sessionRecovery = walletProcess.recoverSession;
  const accountAssets = useAccountAssetsController({
    account: currentAccount,
    active: accountPageSelected && !observationUnavailable,
    recoverSession: sessionRecovery,
  });

  useEffect(() => {
    if (activeNotification === undefined) return;
    const { sequence, phase } = activeNotification;
    const delay = phase === "exiting" ? toastExitMilliseconds :
      activeNotification.notice.tone === "error" ? errorToastMilliseconds : standardToastMilliseconds;
    const timer = window.setTimeout(() => {
      setActiveNotification((current) => current?.sequence !== sequence || current.phase !== phase
        ? current
        : phase === "visible"
          ? Object.freeze({ ...current, phase: "exiting" })
          : undefined);
    }, delay);
    return () => { window.clearTimeout(timer); };
  }, [activeNotification]);

  const stockTokenProcess = useStockTokenProcess({
    account: currentAccount,
    csrfToken,
    exactRead: accountAssets.exactRead,
    observationUnavailable,
    recoverSession: sessionRecovery,
    closeExact: accountAssets.closeExact,
    reconcileAddedSelection: accountAssets.reconcileAddedSelection,
    reconcileRemovedSelection: accountAssets.reconcileRemovedSelection,
    onNotification: publishNotification,
  });
  const tokenDelivery = stockTokenProcess.delivery;
  const tokenPending = stockTokenProcess.pending;
  const tokenOperation = stockTokenProcess.operation;
  const addTask = stockTokenProcess.addTask;
  const informationTask = stockTokenProcess.informationTask;
  const removeTask = stockTokenProcess.removeTask;
  const addPresentation = addTask.presentation;
  const informationPresentation = informationTask.presentation;
  const removePresentation = removeTask.presentation;
  const informationSelectionAddress = informationPresentation === undefined
    ? undefined
    : informationPresentation.status === "available"
      ? informationPresentation.result.asset.selection.asset.address
      : informationPresentation.selection.asset.address;
  const operationClaimedByTask =
    addTask.claimsOperation || removeTask.claimsOperation;

  useEffect(() => {
    setActiveModalTask((current) => {
      if (current !== undefined) return current;
      if (walletOperationPresentation !== undefined) {
        const operation = walletOperationPresentation.operation;
        return Object.freeze({
          kind: operation.kind === "connect"
            ? "wallet_connect" as const
            : "wallet_disconnect" as const,
          connectionRevision: operation.connectionRevision,
          operationId: operation.operationId,
          returnFocus: walletNavigation.current ?? undefined,
        });
      }
      if (
        addTask.claimsOperation &&
        stockTokenProcess.addContext !== undefined
      ) {
        const { account } = stockTokenProcess.addContext.form;
        return Object.freeze({
          kind: "stock_token_add" as const,
          accountKey: [
            account.connectionRevision,
            account.chainId,
            account.address,
          ].join(":"),
          originResourceKey: activeResourceKey,
          returnFocus: undefined,
        });
      }
      if (
        removeTask.claimsOperation &&
        stockTokenProcess.removeContext !== undefined
      ) {
        return Object.freeze({
          kind: "stock_token_remove" as const,
          subject: stockTokenProcess.removeContext.subject,
          returnFocus: undefined,
        });
      }
      if (tokenOperation !== null && !operationClaimedByTask) {
        return Object.freeze({
          kind: "external_token_operation" as const,
          operationId: tokenOperation.operationId,
          returnFocus: undefined,
        });
      }
      return current;
    });
  }, [
    addTask.claimsOperation,
    operationClaimedByTask,
    removeTask.claimsOperation,
    stockTokenProcess.addContext,
    stockTokenProcess.removeContext,
    tokenOperation,
    walletOperationPresentation,
    activeResourceKey,
  ]);

  useEffect(() => {
    if (walletTerminalOperation === undefined) return;
    const task = activeModalTask;
    const matchingTask =
      (
        task?.kind === "wallet_connect" &&
        walletTerminalOperation.kind === "connect"
      ) ||
      (
        task?.kind === "wallet_disconnect" &&
        walletTerminalOperation.kind === "disconnect"
      );
    const matchingIdentity = matchingTask &&
      task.connectionRevision === walletTerminalOperation.connectionRevision &&
      task.operationId === walletTerminalOperation.operationId;
    if (matchingIdentity) setActiveModalTask(undefined);
    walletProcess.acknowledgeTerminal(walletTerminalOperation.operationId);
  }, [
    activeModalTask,
    walletProcess,
    walletTerminalOperation,
  ]);

  useEffect(() => {
    if (
      activeModalTask?.kind === "stock_token_add" &&
      stockTokenProcess.addContext === undefined
    ) {
      setActiveModalTask(undefined);
    } else if (
      activeModalTask?.kind === "stock_token_remove" &&
      stockTokenProcess.removeContext === undefined
    ) {
      setActiveModalTask(undefined);
    } else if (
      activeModalTask?.kind === "stock_token_information" &&
      informationSelectionAddress !== activeModalTask.selectionAddress
    ) {
      setActiveModalTask(undefined);
    } else if (
      activeModalTask?.kind === "external_token_operation" &&
      tokenOperation?.operationId !== activeModalTask.operationId
    ) {
      setActiveModalTask(undefined);
    } else if (
      (
        activeModalTask?.kind === "wallet_connect" ||
        activeModalTask?.kind === "wallet_disconnect"
      ) &&
      walletOperationPresentation?.operation.operationId !==
        activeModalTask.operationId
    ) {
      setActiveModalTask(undefined);
    }
  }, [
    activeModalTask,
    informationSelectionAddress,
    stockTokenProcess.addContext,
    stockTokenProcess.removeContext,
    tokenOperation,
    walletOperationPresentation,
  ]);

  useEffect(() => {
    const task = activeModalTask;
    if (task === undefined || !("originResourceKey" in task)) return;
    if (task.originResourceKey === activeResourceKey) return;
    if (task.kind === "analysis") {
      setActiveModalTask(undefined);
    } else if (task.kind === "stock_token_information") {
      accountAssets.closeExact();
      setActiveModalTask(undefined);
    } else if (
      task.kind === "stock_token_add" &&
      addPresentation?.inputsLocked !== true &&
      stockTokenProcess.closeAdd()
    ) {
      setActiveModalTask(undefined);
    }
  }, [
    accountAssets,
    activeModalTask,
    activeResourceKey,
    addPresentation?.inputsLocked,
    stockTokenProcess,
  ]);

  useEffect(() => {
    const previous = previousModalTask.current;
    if (previous === undefined && activeModalTask !== undefined) {
      focusRestoreEpoch.current += 1;
      taskReturnFocus.current = activeModalTask.returnFocus;
    } else if (previous !== undefined && activeModalTask === undefined) {
      const restoreEpoch = ++focusRestoreEpoch.current;
      const returnFocus = taskReturnFocus.current;
      taskReturnFocus.current = undefined;
      window.setTimeout(() => {
        if (focusRestoreEpoch.current !== restoreEpoch) return;
        const target = returnFocus?.isConnected === true
          ? returnFocus
          : document.getElementById("page-content");
        target?.focus();
      }, 0);
    }
    previousModalTask.current = activeModalTask;
  }, [activeModalTask]);

  useEffect(() => {
    if (previousNavigationKey.current === navigationKey) return;
    previousNavigationKey.current = navigationKey;
    if (activeModalTask === undefined) {
      document.getElementById("page-content")?.focus();
    }
  }, [activeModalTask, navigationKey]);

  const closeActiveTask = (): void => {
    const task = activeModalTask;
    if (task === undefined) return;
    if (task.kind === "stock_token_add") {
      if (stockTokenProcess.closeAdd()) setActiveModalTask(undefined);
      return;
    }
    if (task.kind === "stock_token_remove") {
      if (stockTokenProcess.closeRemove()) setActiveModalTask(undefined);
      return;
    }
    if (task.kind === "stock_token_information") {
      accountAssets.closeExact();
      setActiveModalTask(undefined);
      return;
    }
    if (task.kind === "external_token_operation") {
      stockTokenProcess.dismissExternalOperation();
      setActiveModalTask(undefined);
      return;
    }
    if (task.kind === "wallet_connect" || task.kind === "wallet_disconnect") {
      walletProcess.dismissOperation();
    }
    setActiveModalTask(undefined);
  };

  const activateWalletNavigation = (): void => {
    if (
      activeModalTask !== undefined ||
      currentWallet === undefined ||
      observationUnavailable ||
      walletPending ||
      walletDelivery !== undefined
    ) {
      return;
    }
    const [action] = walletConnectionActions(currentWallet);
    if (action === undefined) return;
    const operationId = createBrowserOperationId();
    setActiveModalTask(Object.freeze({
      kind: action === "connect" ? "wallet_connect" : "wallet_disconnect",
      connectionRevision: currentWallet.connectionRevision,
      operationId,
      returnFocus: walletNavigation.current ?? undefined,
    }));
    void walletProcess.runAction(action, operationId);
  };
  const retryWalletObservation = walletProcess.retryObservation;

  const activateAnalysis = (
    target: AnalysisTarget,
    trigger: HTMLButtonElement,
  ): void => {
    if (activeModalTask !== undefined) return;
    setActiveModalTask(Object.freeze({
      kind: "analysis",
      target: Object.freeze({ ...target }),
      originResourceKey: activeResourceKey,
      returnFocus: trigger,
    }));
  };

  const snapshotForPage: AccountAssetPageSnapshot | undefined =
    accountAssets.snapshot === undefined ? undefined : {
    result: accountAssets.snapshot.result,
  };
  const visibleWalletObservationFailure =
    state.status === "ready" && activeModalTask === undefined
      ? state.observationFailure
      : undefined;
  const walletLabel = walletNavigationLabel(currentWallet);
  return (
    <>
      <ApplicationShell
        {...(pageMetadata?.activePrimaryPageId === undefined
          ? {}
          : { activePrimaryPageId: pageMetadata.activePrimaryPageId })}
        onNavigate={onNavigate}
        pageFocusVisible={navigationFocusVisible}
        walletControl={(
        <button
          ref={walletNavigation}
          type="button"
          className="wallet-nav-control secondary icon-button"
          aria-label={walletLabel}
          title={walletLabel}
          aria-expanded={
            activeModalTask?.kind === "wallet_connect" ||
            activeModalTask?.kind === "wallet_disconnect"
          }
          disabled={
            currentWallet === undefined ||
            walletPending ||
            walletDelivery !== undefined ||
            observationUnavailable
          }
          onClick={activateWalletNavigation}
        >
          <Icon
            name={
              currentAccount === undefined
                ? "wallet-disconnected"
                : "wallet-disconnect"
            }
          />
        </button>
        )}
        {...(
          walletDelivery === undefined &&
          tokenDelivery === undefined
            ? {}
            : {
          notice: (
            <div className="shared-delivery-warnings" role="status">
              {walletDelivery === undefined ? null : (
                <div className="warning shared-delivery-warning">
                  <strong>
                    Wallet {walletDelivery.task === "connect"
                      ? "connection"
                      : "disconnection"} status unknown
                  </strong>
                  <p>The request may have occurred. Do not repeat the wallet action.</p>
                </div>
              )}
              {tokenDelivery === undefined ? null : (
                <div className="warning shared-delivery-warning">
                  <strong>
                    Stock Token {tokenDelivery.task === "add" ? "addition" : "removal"} status unknown
                  </strong>
                  <p>The request may have occurred. Do not repeat the token action.</p>
                </div>
              )}
            </div>
          ),
        })}
      >
      {locationState.status === "invalid" ? (
        <section className="page-state page-state-unavailable">
          <h1>Page unavailable</h1>
          <p>The address does not identify a supported Little John page.</p>
          <a
            href={browserLocationHref(locationState.baseLocation)}
            onClick={(event) => {
              onNavigate(locationState.baseLocation, event);
            }}
          >
            Return to the nearest page
          </a>
        </section>
      ) : locationState.location.page === browserPages.referencePrices.id ? (
        <PricesPage onNavigate={onNavigate} />
      ) : locationState.location.page === browserPages.referencePrice.id ? (
        <ReferencePricePage
          chartPort={referenceChart}
          pageLocation={locationState.location}
          onNavigate={onNavigate}
          onAnalyze={activateAnalysis}
        />
      ) : (
        <div className="account-page">
          {state.status === "loading" ? (
            <section className="assets-introduction" aria-labelledby="assets-loading-heading">
              <PageHeader
                headingId="assets-loading-heading"
                title="Assets"
                description={state.failure === undefined
                  ? "Checking the local wallet connection…"
                  : humanFailureText(state.failure)}
              />
              {state.failure?.retryable === true &&
              activeModalTask === undefined ? (
                <button type="button" className="secondary" onClick={retryWalletObservation}>Retry</button>
              ) : null}
              <PublicTasks onNavigate={onNavigate} />
            </section>
          ) : currentAccount === undefined ? (
            <section className="assets-introduction" aria-labelledby="assets-disconnected-heading">
              <PageHeader
                headingId="assets-disconnected-heading"
                title="Assets"
                description="Connect a wallet to see your assets. Connecting does not sign or send a transaction."
              />
              {visibleWalletObservationFailure === undefined ? null : (
                <p className="error">
                  {humanFailureText(visibleWalletObservationFailure)}
                </p>
              )}
              {visibleWalletObservationFailure === undefined ? (
                <button type="button" onClick={activateWalletNavigation}>Connect wallet</button>
              ) : visibleWalletObservationFailure.retryable ? (
                <button type="button" className="secondary" onClick={retryWalletObservation}>Retry</button>
              ) : null}
              <PublicTasks onNavigate={onNavigate} />
            </section>
          ) : (
            <>
              {visibleWalletObservationFailure === undefined ? null : (
                <div className="warning" role="status">
                  <strong>Wallet observation unavailable</strong>
                  <p>{humanFailureText(visibleWalletObservationFailure)}</p>
                  {visibleWalletObservationFailure.retryable ? (
                    <button type="button" className="secondary" onClick={retryWalletObservation}>Retry</button>
                  ) : null}
                </div>
              )}
              <AccountAssetsPage
                snapshot={snapshotForPage}
                loading={accountAssets.overviewRead.status === "loading"}
                staleMessage={accountAssets.overviewRead.status === "error"
                  ? humanFailureText(accountAssets.overviewRead.failure)
                  : undefined}
                mutationDisabled={
                  walletPending ||
                  walletOperationPresentation !== undefined ||
                  tokenPending ||
                  tokenOperation !== null ||
                  observationUnavailable ||
                  tokenDelivery !== undefined
                }
                onRefresh={accountAssets.refresh}
                onAddStockToken={(candidates, trigger) => {
                  if (
                    activeModalTask !== undefined ||
                    accountAssets.snapshot?.result.viewRevision.officialSnapshotStatus !==
                    "current"
                  ) {
                    return;
                  }
                  const opened = stockTokenProcess.openAdd(Object.freeze({
                    account: currentAccount,
                    viewRevision: accountAssets.snapshot.result.viewRevision,
                    candidates,
                  }));
                  if (!opened) return;
                  setActiveModalTask(Object.freeze({
                    kind: "stock_token_add",
                    accountKey: [
                      currentAccount.connectionRevision,
                      currentAccount.chainId,
                      currentAccount.address,
                    ].join(":"),
                    originResourceKey: activeResourceKey,
                    returnFocus: trigger,
                  }));
                }}
                onInfo={(selection, trigger) => {
                  if (
                    activeModalTask !== undefined ||
                    accountAssets.snapshot === undefined
                  ) return;
                  if (!accountAssets.openExact(selection)) return;
                  setActiveModalTask(Object.freeze({
                    kind: "stock_token_information",
                    selectionAddress: selection.asset.address,
                    originResourceKey: activeResourceKey,
                    returnFocus: trigger,
                  }));
                }}
              />
            </>
          )}
        </div>
      )}
      </ApplicationShell>
      {activeModalTask?.kind === "analysis" ? (
        <AnalysisTaskDialog
          target={activeModalTask.target}
          onClose={closeActiveTask}
          recoverSession={sessionRecovery}
        />
      ) : activeModalTask?.kind === "wallet_connect" ||
        activeModalTask?.kind === "wallet_disconnect" ? (
        <WalletTaskDialog
          task={activeModalTask.kind}
          connectionRevision={activeModalTask.connectionRevision}
          operationId={activeModalTask.operationId}
          wallet={currentWallet}
          operationPresentation={walletOperationPresentation}
          pending={walletPending}
          pendingAction={walletPendingAction}
          pendingOperationId={walletPendingOperationId}
          delivery={walletDelivery}
          actionFailure={walletActionFailure}
          onClose={closeActiveTask}
          onAction={(action) => {
            void walletProcess.runAction(action, activeModalTask.operationId);
          }}
        />
      ) : activeModalTask?.kind === "stock_token_add" &&
        addPresentation !== undefined ? (
        <StockTokenAddDialog
          presentation={addPresentation}
          onClose={closeActiveTask}
          onAdd={stockTokenProcess.addCandidate}
          onRetry={stockTokenProcess.retryAdd}
        />
      ) : activeModalTask?.kind === "stock_token_information" &&
        informationPresentation !== undefined ? (
        <StockTokenInformationDialog
          presentation={informationPresentation}
          onClose={closeActiveTask}
          onRetry={accountAssets.retryExact}
          recoverSession={sessionRecovery}
          onRemove={() => {
            if (
              activeModalTask.kind !== "stock_token_information" ||
              informationPresentation.status !== "available"
            ) {
              return;
            }
            const row = projectAccountAssetExactView(
              informationPresentation.result,
            );
            const subject = Object.freeze({
              selection: informationPresentation.result.asset.selection,
              name: row.name ?? row.symbol ?? "Stock Token",
            });
            if (!stockTokenProcess.openRemove(subject)) return;
            accountAssets.closeExact();
            setActiveModalTask(Object.freeze({
              kind: "stock_token_remove",
              subject,
              returnFocus: activeModalTask.returnFocus,
            }));
          }}
        />
      ) : activeModalTask?.kind === "stock_token_remove" &&
        removePresentation !== undefined ? (
        <StockTokenRemoveDialog
          presentation={removePresentation}
          onClose={closeActiveTask}
          onConfirm={stockTokenProcess.confirmRemove}
          onRetry={stockTokenProcess.retryRemove}
        />
      ) : activeModalTask?.kind === "external_token_operation" &&
        tokenOperation?.operationId === activeModalTask.operationId ? (
        <ExternalTokenOperationDialog
          operation={tokenOperation}
          accountMatches={sameConnectedAccount({
            chainId: tokenOperation.account.chainId,
            address: tokenOperation.account.address,
            connectionRevision: tokenOperation.connectionRevision,
          }, currentAccount)}
          pending={tokenPending}
          onClose={closeActiveTask}
          onConfirm={stockTokenProcess.confirmCurrentOperation}
          onCancel={stockTokenProcess.cancelCurrentOperation}
        />
      ) : null}
      {activeNotification === undefined ? null : (
        <Notification notice={activeNotification.notice} exiting={activeNotification.phase === "exiting"} />
      )}
    </>
  );
};
