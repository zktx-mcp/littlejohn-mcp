import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import type {
  AccountAssetCollectionSuccess,
  AccountAssetCursor,
  AccountAssetExactSuccess,
  AccountAssetOfficialCandidateCursor,
  AccountAssetOfficialCandidateSuccess,
  AccountAssetViewRevision,
} from "../../account-assets/browser.js";
import { productDisplayName } from "../../core/browser.js";
import {
  isTokenCatalogOperationTerminal,
  type TokenCatalogOperation,
  type TokenSelection,
} from "../../token-catalog/browser.js";
import type {
  WalletCurrentOperationProjection,
  WalletManagementOperation,
  WalletOperationPresentation,
  WalletQrMatrix,
} from "../../wallet/operation-contract.js";
import {
  browserCsrfMetaName,
  browserPagePaths,
  parseBrowserCsrfToken,
} from "../browser-contract.js";
import {
  isDeliveryUnknown,
  type DeliveryUnknown,
} from "../operation-delivery.js";
import { AccountAssetsPage, type AccountAssetPageSnapshot } from "./account-assets-page.js";
import { Icon } from "./icons.js";
import {
  loadAccountAssets,
  loadExactAccountAsset,
  loadOfficialAssetCandidates,
} from "./account-assets-client.js";
import {
  browserActionFailureMessage,
  isBrowserResponseCode,
} from "./browser-client.js";
import { createBrowserSessionRecovery } from "./browser-session-recovery.js";
import type { NotificationNotice } from "./notification.js";
import { createBrowserRequestAuthority, type BrowserRequest } from "./request-authority.js";
import {
  cancelTokenOperation,
  confirmTokenOperation,
  loadCurrentTokenOperation,
  loadTokenOperation,
  parseTokenAddressInput,
  startTokenSelection,
  startTokenRemoval,
} from "./token-catalog-client.js";
import {
  tokenInspectionFields,
  tokenOperationCopy,
  tokenOperationNotification,
} from "./token-catalog-view.js";
import {
  cancelWalletOperation,
  confirmWalletOperation,
  loadWalletOperation,
  loadWalletProjection,
  startWalletOperation,
} from "./wallet-client.js";
import {
  walletConnectionActions,
  walletConnectionCopy,
  walletConnectionFields,
  walletDisconnectActionLabel,
  walletNavigationLabel,
  walletOperationActions,
  walletOperationConfirmationMessage,
  walletOperationCopy,
  walletOperationNotice,
  walletOperationNotification,
  type WalletConnectionAction,
  type WalletOperationAction,
} from "./wallet-dialog-view.js";
import {
  createWalletObservationStore,
  observeExactWalletOperation,
  observeExpiredWalletOperation,
  observeWalletCurrent,
  trackWalletOperationResult,
  type WalletObservationState,
  walletObservationStorageKey,
} from "./wallet-observation.js";

type AppState =
  | Readonly<{ status: "loading"; failure?: string }>
  | Readonly<{
      status: "ready";
      wallet: WalletCurrentOperationProjection;
      observationFailure?: string;
    }>;

type ConnectedAccount = Readonly<{
  chainId: TokenSelection["account"]["chainId"];
  address: TokenSelection["account"]["address"];
  connectionRevision: string;
}>;

type AssetSnapshot = Readonly<{
  accountKey: string;
  result: AccountAssetCollectionSuccess;
  cursor: AccountAssetCursor | null;
  previousCursors: readonly (AccountAssetCursor | null)[];
}>;

type AddFormContext = Readonly<{
  account: ConnectedAccount;
  viewRevision: AccountAssetViewRevision;
}>;

type OfficialCandidateSnapshot = Readonly<{
  result: AccountAssetOfficialCandidateSuccess;
  cursor: AccountAssetOfficialCandidateCursor | null;
  previousCursors: readonly (AccountAssetOfficialCandidateCursor | null)[];
}>;

type OfficialCandidateReadState =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "available"; snapshot: OfficialCandidateSnapshot }>
  | Readonly<{ status: "error"; message: string }>;

type ExactAssetReadState =
  | Readonly<{ status: "idle" }>
  | Readonly<{
      status: "loading";
      accountKey: string;
      asset: TokenSelection["asset"];
    }>
  | Readonly<{
      status: "available";
      accountKey: string;
      asset: TokenSelection["asset"];
      result: AccountAssetExactSuccess;
    }>
  | Readonly<{
      status: "error";
      accountKey: string;
      asset: TokenSelection["asset"];
      message: string;
    }>;

type AssetReadState =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "error"; message: string }>;

type ActiveNotification = Readonly<{
  notice: NotificationNotice;
  sequence: number;
  phase: "visible" | "exiting";
}>;

type DialogPresentation =
  | Readonly<{ kind: "wallet_delivery"; delivery: DeliveryUnknown }>
  | Readonly<{ kind: "wallet_operation"; presentation: WalletOperationPresentation }>
  | Readonly<{ kind: "wallet_connection"; wallet: WalletCurrentOperationProjection }>
  | Readonly<{ kind: "token_delivery"; delivery: DeliveryUnknown }>
  | Readonly<{ kind: "token_operation"; operation: TokenCatalogOperation; accountMatches: boolean }>
  | Readonly<{ kind: "token_add"; form: AddFormContext }>;

const browserPollMilliseconds = 500;
const standardToastMilliseconds = 5_000;
const errorToastMilliseconds = 8_000;
const toastExitMilliseconds = 180;
const idleExactAssetRead = Object.freeze({ status: "idle" as const });

const connectedAccount = (
  wallet: WalletCurrentOperationProjection | undefined,
): ConnectedAccount | undefined => wallet?.connection.status === "connected"
  ? Object.freeze({
      chainId: wallet.connection.chainId,
      address: wallet.connection.address,
      connectionRevision: wallet.connectionRevision,
    })
  : undefined;

const accountKey = (account: ConnectedAccount | undefined): string | undefined => account === undefined
  ? undefined
  : `${account.connectionRevision}:${account.chainId}:${account.address}`;

const sameAccount = (
  expected: ConnectedAccount,
  actual: ConnectedAccount | undefined,
): boolean => actual !== undefined &&
  expected.chainId === actual.chainId &&
  expected.address === actual.address &&
  expected.connectionRevision === actual.connectionRevision;

const resultMatchesAccount = (
  expected: ConnectedAccount,
  result: Pick<AccountAssetCollectionSuccess, "account"> |
    Pick<AccountAssetExactSuccess, "account"> |
    Pick<AccountAssetOfficialCandidateSuccess, "account">,
): boolean => result.account.chainId === expected.chainId && result.account.address === expected.address;

const createBrowserWalletObservationStore = () => createWalletObservationStore(Object.freeze({
  read: (): string | null => window.sessionStorage.getItem(walletObservationStorageKey),
  write: (operationId: string | undefined): void => {
    if (operationId === undefined) window.sessionStorage.removeItem(walletObservationStorageKey);
    else window.sessionStorage.setItem(walletObservationStorageKey, operationId);
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

const WalletConnectionDetails = ({
  wallet,
  pending,
  onAction,
  onClose,
}: {
  readonly wallet: WalletCurrentOperationProjection;
  readonly pending: boolean;
  readonly onAction: (action: WalletConnectionAction) => void;
  readonly onClose: () => void;
}) => {
  const copy = walletConnectionCopy(wallet.connection);
  const fields = walletConnectionFields(wallet.connection);
  const actions = walletConnectionActions(wallet);
  return (
    <>
      <header><h1>{copy.heading}</h1><p>{copy.message}</p></header>
      {fields.length === 0 ? null : (
        <dl>{fields.flatMap((field) => [
          <dt key={`${field.label}:label`}>{field.label}</dt>,
          <dd key={`${field.label}:value`}>{field.value}</dd>,
        ])}</dl>
      )}
      <div className="actions">
        <button type="button" className="secondary" disabled={pending} onClick={onClose}>Close</button>
        {actions.includes("disconnect") ? (
          <button type="button" className="danger" disabled={pending} onClick={() => { onAction("disconnect"); }}>
            {walletDisconnectActionLabel(wallet.connection)}
          </button>
        ) : null}
        {actions.includes("connect") ? (
          <button type="button" disabled={pending} onClick={() => { onAction("connect"); }}>Connect wallet</button>
        ) : null}
      </div>
    </>
  );
};

const WalletOperationDetails = ({
  presentation,
  pending,
  onAction,
}: {
  readonly presentation: WalletOperationPresentation;
  readonly pending: boolean;
  readonly onAction: (action: WalletOperationAction) => void;
}) => {
  const { operation, qr } = presentation;
  const copy = walletOperationCopy(operation);
  const actions = walletOperationActions(presentation);
  const notice = walletOperationNotice(presentation);
  return (
    <>
      <header><h1>{copy.heading}</h1><p>{copy.message}</p></header>
      {qr === undefined ? null : <div className="qr-wrap"><QrCode matrix={qr} /></div>}
      {notice === undefined ? null : <div className="notice"><strong>Read-only view</strong><p>{notice}</p></div>}
      {operation.state === "awaiting_confirmation" ? (
        <div className="warning"><strong>Confirmation required</strong><p>{walletOperationConfirmationMessage(operation)}</p></div>
      ) : null}
      {operation.failure === null ? null : <p className="error">{operation.failure.error.message}</p>}
      {actions.length === 0 ? null : (
        <div className="actions">
          {actions.includes("cancel") ? (
            <button type="button" className="secondary" disabled={pending} onClick={() => { onAction("cancel"); }}>Cancel</button>
          ) : null}
          {actions.includes("confirm") ? (
            <button type="button" disabled={pending} onClick={() => { onAction("confirm"); }}>Disconnect wallet</button>
          ) : null}
        </div>
      )}
    </>
  );
};

const TokenOperationDetails = ({
  operation,
  accountMatches,
  pending,
  onConfirm,
  onCancel,
  onClose,
}: {
  readonly operation: TokenCatalogOperation;
  readonly accountMatches: boolean;
  readonly pending: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly onClose: () => void;
}) => {
  const copy = tokenOperationCopy(operation);
  const webConfirmation = operation.interactionInterface === "web" &&
    operation.state === "awaiting_confirmation";
  return (
    <>
      <header><h1>{copy.heading}</h1><p>{copy.message}</p></header>
      <dl className="token-details">
        <dt>Account</dt><dd>{operation.account.chainId} / {operation.account.address}</dd>
        <dt>Contract</dt><dd>{operation.asset.address}</dd>
        {operation.kind === "add" ? (
          <><dt>Classification</dt><dd>{operation.review.officialEvidence === null
            ? "Custom ERC-20"
            : "Robinhood Stock Token"}</dd></>
        ) : null}
        {operation.review.officialEvidence === null ? null : (
          <><dt>Official asset UID</dt><dd>{operation.review.officialEvidence.assetUid}</dd></>
        )}
        {(operation.review.inspection === null ? [] : tokenInspectionFields(operation.review.inspection)).flatMap((field) => [
          <dt key={`${field.label}:label`}>{field.label}</dt>,
          <dd key={`${field.label}:value`}>{field.value}</dd>,
        ])}
      </dl>
      {operation.interactionInterface === "cli" ? (
        <div className="notice"><strong>Read-only review</strong><p>Continue this token change in the CLI.</p></div>
      ) : null}
      {!accountMatches ? (
        <div className="warning"><strong>Different account</strong><p>Confirmation is unavailable because the connected account changed.</p></div>
      ) : null}
      <div className="actions">
        {operation.interactionInterface === "cli" ? (
          <button type="button" className="secondary" disabled={pending} onClick={onClose}>Close</button>
        ) : null}
        {webConfirmation ? (
          <button type="button" className="secondary" disabled={pending} onClick={onCancel}>Cancel</button>
        ) : null}
        {webConfirmation && accountMatches ? (
          <button type="button" disabled={pending} onClick={onConfirm}>
            {operation.kind === "add" ? "Add to this account" : "Remove from this account"}
          </button>
        ) : null}
      </div>
    </>
  );
};

const ApplicationDialog = ({
  presentation,
  pending,
  onClose,
  onWalletAction,
  officialCandidates,
  onRetryOfficialCandidates,
  onPreviousOfficialCandidates,
  onNextOfficialCandidates,
  onTokenAddress,
  onTokenConfirm,
  onTokenCancel,
}: {
  readonly presentation: DialogPresentation;
  readonly pending: boolean;
  readonly onClose: () => void;
  readonly onWalletAction: (action: WalletConnectionAction | WalletOperationAction) => void;
  readonly officialCandidates: OfficialCandidateReadState;
  readonly onRetryOfficialCandidates: () => void;
  readonly onPreviousOfficialCandidates: () => void;
  readonly onNextOfficialCandidates: () => void;
  readonly onTokenAddress: (address: string) => void;
  readonly onTokenConfirm: () => void;
  readonly onTokenCancel: () => void;
}) => {
  const dialog = useRef<HTMLDialogElement>(null);
  const [address, setAddress] = useState("");
  const [validation, setValidation] = useState<string | undefined>();
  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    element.showModal();
    element.focus();
    return () => { if (element.open) element.close(); };
  }, []);
  const dismissible = presentation.kind === "wallet_delivery" ||
    presentation.kind === "wallet_connection" ||
    presentation.kind === "token_delivery" ||
    presentation.kind === "token_add" ||
    presentation.kind === "token_operation" && presentation.operation.interactionInterface === "cli";
  const close = (): void => { if (!pending && dismissible) onClose(); };
  const submitAddress = (): void => {
    try { parseTokenAddressInput(address); }
    catch { setValidation("Enter a valid EVM contract address."); return; }
    setValidation(undefined);
    onTokenAddress(address);
  };
  return (
    <dialog
      ref={dialog}
      className="application-dialog"
      aria-label="Little John action"
      tabIndex={-1}
      onCancel={(event) => { event.preventDefault(); close(); }}
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); close(); } }}
    >
      {presentation.kind === "wallet_delivery" || presentation.kind === "token_delivery" ? (
        <>
          <header><h1>Action status unknown</h1><p>The local browser did not receive a valid response after sending the action.</p></header>
          <div className="warning"><strong>Do not repeat this action</strong><p>It may have occurred. Inspect operation {presentation.delivery.operationId} before trying again.</p></div>
          <div className="actions"><button type="button" className="secondary" onClick={onClose}>Close</button></div>
        </>
      ) : presentation.kind === "wallet_operation" ? (
        <WalletOperationDetails presentation={presentation.presentation} pending={pending} onAction={onWalletAction} />
      ) : presentation.kind === "wallet_connection" ? (
        <WalletConnectionDetails wallet={presentation.wallet} pending={pending} onAction={onWalletAction} onClose={onClose} />
      ) : presentation.kind === "token_operation" ? (
        <TokenOperationDetails
          operation={presentation.operation}
          accountMatches={presentation.accountMatches}
          pending={pending}
          onConfirm={onTokenConfirm}
          onCancel={onTokenCancel}
          onClose={onClose}
        />
      ) : (
        <>
          <header><h1>Add token</h1><p>Choose a current Robinhood Stock Token or enter a custom ERC-20 contract.</p></header>
          <dl className="token-details">
            <dt>Account</dt>
            <dd>{presentation.form.account.chainId} / {presentation.form.account.address}</dd>
          </dl>
          <section className="add-token-section" aria-labelledby="official-token-heading">
            <h2 id="official-token-heading">Robinhood Stock Tokens</h2>
            {officialCandidates.status === "loading" ? (
              <p role="status">Reading current official candidates…</p>
            ) : officialCandidates.status === "error" ? (
              <div className="warning" role="status">
                <p>{officialCandidates.message}</p>
                <button type="button" className="secondary" onClick={onRetryOfficialCandidates}>Retry</button>
              </div>
            ) : officialCandidates.status === "available" ? (
              <>
                {officialCandidates.snapshot.result.candidates.length === 0 ? (
                  <p>No excluded Robinhood Stock Tokens are available in this view.</p>
                ) : (
                  <ul className="official-candidate-list">
                    {officialCandidates.snapshot.result.candidates.map((candidate) => (
                      <li key={candidate.assetUid}>
                        <div>
                          <strong>{candidate.sourceName ?? candidate.sourceSymbol ?? "Robinhood Stock Token"}</strong>
                          {candidate.sourceSymbol === null ? null : <span>{candidate.sourceSymbol}</span>}
                          <code>{candidate.contractAddress}</code>
                        </div>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={`Add ${candidate.sourceSymbol ?? candidate.contractAddress}`}
                          title="Review and add this token"
                          disabled={pending}
                          onClick={() => { onTokenAddress(candidate.contractAddress); }}
                        ><Icon name="plus" /></button>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="candidate-pagination">
                  <button
                    type="button"
                    className="icon-button secondary"
                    aria-label="Previous official token candidates"
                    title="Previous official token candidates"
                    disabled={pending || officialCandidates.snapshot.previousCursors.length === 0}
                    onClick={onPreviousOfficialCandidates}
                  ><Icon name="chevron-left" /></button>
                  <span>Official candidates</span>
                  <button
                    type="button"
                    className="icon-button secondary"
                    aria-label="Next official token candidates"
                    title="Next official token candidates"
                    disabled={pending || officialCandidates.snapshot.result.nextCursor === null}
                    onClick={onNextOfficialCandidates}
                  ><Icon name="chevron-right" /></button>
                </div>
              </>
            ) : null}
          </section>
          <section className="add-token-section" aria-labelledby="custom-token-heading">
            <h2 id="custom-token-heading">Custom ERC-20</h2>
            <label className="field">
              <span>Contract address</span>
              <input
                type="text"
                value={address}
                disabled={pending}
                onChange={(event) => { setAddress(event.currentTarget.value); }}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            {validation === undefined ? null : <p className="error">{validation}</p>}
            <button type="button" disabled={pending} onClick={submitAddress}>{pending ? "Inspecting…" : "Review custom token"}</button>
          </section>
          <div className="actions">
            <button type="button" className="secondary" disabled={pending} onClick={onClose}>Close</button>
          </div>
        </>
      )}
    </dialog>
  );
};

const Notification = ({ notice, exiting }: { readonly notice: NotificationNotice; readonly exiting: boolean }) => (
  <div className="notification-region">
    <div
      className={`notification notification-${notice.tone}${exiting ? " notification-exiting" : ""}`}
      role={notice.tone === "error" ? "alert" : "status"}
    >
      <strong>{notice.heading}</strong><p>{notice.message}</p>
    </div>
  </div>
);

export const App = () => {
  const [state, setState] = useState<AppState>({ status: "loading" });
  const stateRef = useRef<AppState>(state);
  const [connectionDialogOpen, setConnectionDialogOpen] = useState(false);
  const [walletDelivery, setWalletDelivery] = useState<DeliveryUnknown>();
  const [tokenDelivery, setTokenDelivery] = useState<DeliveryUnknown>();
  const [addForm, setAddForm] = useState<AddFormContext>();
  const [officialCandidateRead, setOfficialCandidateRead] = useState<OfficialCandidateReadState>({ status: "idle" });
  const [tokenOperation, setTokenOperation] = useState<TokenCatalogOperation | null>(null);
  const [assetSnapshot, setAssetSnapshot] = useState<AssetSnapshot>();
  const [exactRead, setExactRead] = useState<ExactAssetReadState>(idleExactAssetRead);
  const exactReadRef = useRef<ExactAssetReadState>(exactRead);
  const [assetRead, setAssetRead] = useState<AssetReadState>({ status: "idle" });
  const [walletPending, setWalletPending] = useState(false);
  const [tokenPending, setTokenPending] = useState(false);
  const [activeNotification, setActiveNotification] = useState<ActiveNotification>();
  const [walletAuthority] = useState(createBrowserRequestAuthority);
  const [assetAuthority] = useState(createBrowserRequestAuthority);
  const [exactAuthority] = useState(createBrowserRequestAuthority);
  const [candidateAuthority] = useState(createBrowserRequestAuthority);
  const [tokenAuthority] = useState(createBrowserRequestAuthority);
  const [sessionRecovery] = useState(() => createBrowserSessionRecovery(() => { window.location.reload(); }));
  const [observationStore] = useState(createBrowserWalletObservationStore);
  const observation = useRef<WalletObservationState>(observationStore.load());
  const notificationSequence = useRef(0);
  const handledTerminalTokenOperation = useRef<string | undefined>(undefined);
  const dismissedTokenOperation = useRef<string | undefined>(undefined);
  const dialogTrigger = useRef<HTMLElement | undefined>(undefined);
  const walletNavigation = useRef<HTMLButtonElement>(null);
  const dialogHadFocus = useRef(false);

  const publishNotification = useCallback((notice: NotificationNotice): void => {
    notificationSequence.current += 1;
    setActiveNotification(Object.freeze({ notice, sequence: notificationSequence.current, phase: "visible" }));
  }, []);

  const replaceExactRead = useCallback((next: ExactAssetReadState): void => {
    exactReadRef.current = next;
    setExactRead(next);
  }, []);

  const replaceObservation = useCallback((next: WalletObservationState): void => {
    observation.current = next;
    observationStore.save(next);
  }, [observationStore]);

  const publishActionError = useCallback((heading: string, error: unknown): void => {
    publishNotification(Object.freeze({
      id: `${heading.toLowerCase().replaceAll(" ", "-")}-error`,
      tone: "error",
      heading,
      message: browserActionFailureMessage(error),
    }));
  }, [publishNotification]);

  const refreshWallet = useCallback(async (request: BrowserRequest): Promise<boolean> => {
    try {
      const wallet = await loadWalletProjection(request.signal === undefined ? {} : { signal: request.signal });
      if (!walletAuthority.isCurrent(request)) return false;
      let resolved = observeWalletCurrent(observation.current, wallet);
      if (resolved.kind === "read_exact") {
        const exactObservation = resolved;
        try {
          const presentation = await loadWalletOperation(
            exactObservation.operationId,
            request.signal === undefined ? {} : { signal: request.signal },
          );
          if (!walletAuthority.isCurrent(request)) return false;
          const exact = observeExactWalletOperation(exactObservation, presentation);
          if (exact.kind === "retry") return false;
          resolved = exact;
        } catch (error) {
          if (!walletAuthority.isCurrent(request)) return false;
          if (!isBrowserResponseCode(error, "state_conflict")) throw error;
          resolved = observeExpiredWalletOperation(exactObservation);
        }
      }
      replaceObservation(resolved.state);
      const next = Object.freeze({ status: "ready" as const, wallet: resolved.wallet });
      stateRef.current = next;
      setState(next);
      if (resolved.wallet.status === "present") setConnectionDialogOpen(false);
      if (resolved.terminal !== undefined) {
        setConnectionDialogOpen(false);
        const notice = walletOperationNotification(resolved.terminal);
        if (notice !== undefined) publishNotification(notice);
      }
      return true;
    } catch (error) {
      if (!walletAuthority.isCurrent(request)) return false;
      if (sessionRecovery(error)) return false;
      const message = browserActionFailureMessage(error);
      const current = stateRef.current;
      const next: AppState = current.status === "ready"
        ? Object.freeze({ ...current, observationFailure: message })
        : Object.freeze({ status: "loading", failure: message });
      stateRef.current = next;
      setState(next);
      return false;
    }
  }, [publishNotification, replaceObservation, sessionRecovery, walletAuthority]);

  const retryWalletObservation = useCallback((): void => {
    const request = walletAuthority.beginRead();
    if (request !== undefined) void refreshWallet(request);
  }, [refreshWallet, walletAuthority]);

  const currentWallet = state.status === "ready" ? state.wallet : undefined;
  const currentAccount = connectedAccount(currentWallet);
  const currentAccountKey = accountKey(currentAccount);
  const observationUnavailable = state.status === "ready" && state.observationFailure !== undefined;

  const readAssetPage = useCallback(async (
    expected: ConnectedAccount,
    cursor: AccountAssetCursor | null,
    previousCursors: readonly (AccountAssetCursor | null)[],
    clearBeforeRead: boolean,
  ): Promise<AccountAssetCollectionSuccess | undefined> => {
    const request = assetAuthority.beginRead();
    if (request === undefined) return undefined;
    if (clearBeforeRead) setAssetSnapshot(undefined);
    setAssetRead({ status: "loading" });
    try {
      const result = await loadAccountAssets(
        { ...(cursor === null ? {} : { cursor }) },
        { signal: request.signal },
      );
      if (!assetAuthority.isCurrent(request)) return undefined;
      const actual = connectedAccount(stateRef.current.status === "ready" ? stateRef.current.wallet : undefined);
      if (!sameAccount(expected, actual) || !resultMatchesAccount(expected, result)) {
        throw new Error("The account changed while assets were being read.");
      }
      const next: AssetSnapshot = Object.freeze({
        accountKey: accountKey(expected)!,
        result,
        cursor,
        previousCursors: Object.freeze([...previousCursors]),
      });
      setAssetSnapshot(next);
      setAssetRead({ status: "idle" });
      const exact = exactReadRef.current;
      if (exact.status !== "idle" && result.assets.some(
        (entry) => entry.selection.asset.address === exact.asset.address,
      )) {
        exactAuthority.invalidateRead();
        replaceExactRead(idleExactAssetRead);
      }
      return result;
    } catch (error) {
      if (!assetAuthority.isCurrent(request)) return undefined;
      if (sessionRecovery(error)) return undefined;
      setAssetRead({ status: "error", message: browserActionFailureMessage(error) });
      return undefined;
    } finally {
      if (assetAuthority.isCurrent(request)) assetAuthority.cancelRead(request);
    }
  }, [assetAuthority, exactAuthority, replaceExactRead, sessionRecovery]);

  const readExactAsset = useCallback(async (
    expected: ConnectedAccount,
    asset: TokenSelection["asset"],
    revision: AccountAssetViewRevision,
  ): Promise<AccountAssetExactSuccess | undefined> => {
    const request = exactAuthority.beginRead();
    if (request === undefined) return undefined;
    const readIdentity = Object.freeze({
      accountKey: accountKey(expected)!,
      asset,
    });
    replaceExactRead(Object.freeze({ status: "loading", ...readIdentity }));
    try {
      const result = await loadExactAccountAsset(asset, revision, { signal: request.signal });
      if (!exactAuthority.isCurrent(request)) return undefined;
      const actual = connectedAccount(stateRef.current.status === "ready" ? stateRef.current.wallet : undefined);
      if (!sameAccount(expected, actual) || !resultMatchesAccount(expected, result)) return undefined;
      replaceExactRead(Object.freeze({ status: "available", ...readIdentity, result }));
      return result;
    } catch (error) {
      if (!exactAuthority.isCurrent(request) || sessionRecovery(error)) return undefined;
      replaceExactRead(Object.freeze({
        status: "error",
        ...readIdentity,
        message: browserActionFailureMessage(error),
      }));
      return undefined;
    } finally {
      if (exactAuthority.isCurrent(request)) exactAuthority.cancelRead(request);
    }
  }, [exactAuthority, replaceExactRead, sessionRecovery]);

  const readOfficialCandidates = useCallback(async (
    form: AddFormContext,
    cursor: AccountAssetOfficialCandidateCursor | null,
    previousCursors: readonly (AccountAssetOfficialCandidateCursor | null)[],
  ): Promise<void> => {
    const request = candidateAuthority.beginRead();
    if (request === undefined) return;
    setOfficialCandidateRead({ status: "loading" });
    try {
      const result = await loadOfficialAssetCandidates({
        viewRevision: form.viewRevision,
        ...(cursor === null ? {} : { cursor }),
      }, { signal: request.signal });
      if (!candidateAuthority.isCurrent(request)) return;
      const actual = connectedAccount(stateRef.current.status === "ready" ? stateRef.current.wallet : undefined);
      if (!sameAccount(form.account, actual) || !resultMatchesAccount(form.account, result)) {
        throw new Error("The account changed while official candidates were being read.");
      }
      setOfficialCandidateRead(Object.freeze({
        status: "available",
        snapshot: Object.freeze({
          result,
          cursor,
          previousCursors: Object.freeze([...previousCursors]),
        }),
      }));
    } catch (error) {
      if (!candidateAuthority.isCurrent(request) || sessionRecovery(error)) return;
      setOfficialCandidateRead({ status: "error", message: browserActionFailureMessage(error) });
    } finally {
      if (candidateAuthority.isCurrent(request)) candidateAuthority.cancelRead(request);
    }
  }, [candidateAuthority, sessionRecovery]);

  const acceptTokenOperation = useCallback((operation: TokenCatalogOperation): void => {
    if (!isTokenCatalogOperationTerminal(operation.state)) {
      if (dismissedTokenOperation.current !== operation.operationId) setTokenOperation(operation);
      candidateAuthority.invalidateRead();
      setAddForm(undefined);
      setOfficialCandidateRead({ status: "idle" });
      return;
    }
    if (handledTerminalTokenOperation.current === operation.operationId) return;
    handledTerminalTokenOperation.current = operation.operationId;
    setTokenOperation(null);
    candidateAuthority.invalidateRead();
    setAddForm(undefined);
    setOfficialCandidateRead({ status: "idle" });
    const notice = tokenOperationNotification(operation);
    if (notice !== undefined) publishNotification(notice);
    if (operation.state !== "completed") return;
    const actual = connectedAccount(stateRef.current.status === "ready" ? stateRef.current.wallet : undefined);
    const expected: ConnectedAccount = Object.freeze({
      chainId: operation.account.chainId,
      address: operation.account.address,
      connectionRevision: operation.connectionRevision,
    });
    if (!sameAccount(expected, actual)) return;
    assetAuthority.invalidateRead();
    exactAuthority.invalidateRead();
    const snapshot = assetSnapshot;
    if (operation.kind === "add") {
      void (async () => {
        const latest = await readAssetPage(
          expected,
          null,
          [],
          true,
        );
        if (latest !== undefined) {
          await readExactAsset(expected, operation.asset, latest.viewRevision);
        }
      })();
      return;
    }
    if (exactReadRef.current.status !== "idle" &&
      exactReadRef.current.asset.address === operation.asset.address) {
      exactAuthority.invalidateRead();
      replaceExactRead(idleExactAssetRead);
    }
    setAssetSnapshot(undefined);
    const onlyItemOnLaterPage = snapshot !== undefined && snapshot.cursor !== null &&
      snapshot.result.assets.length === 1 &&
      snapshot.result.assets[0]?.selection.asset.address === operation.asset.address;
    const cursor = onlyItemOnLaterPage ? snapshot.previousCursors.at(-1) ?? null : snapshot?.cursor ?? null;
    const previous = onlyItemOnLaterPage ? snapshot.previousCursors.slice(0, -1) : snapshot?.previousCursors ?? [];
    void readAssetPage(expected, cursor, previous, true);
  }, [assetAuthority, assetSnapshot, candidateAuthority, exactAuthority, publishNotification, readAssetPage, readExactAsset, replaceExactRead]);

  useEffect(() => {
    walletAuthority.activate();
    assetAuthority.activate();
    exactAuthority.activate();
    candidateAuthority.activate();
    tokenAuthority.activate();
    return () => {
      walletAuthority.close();
      assetAuthority.close();
      exactAuthority.close();
      candidateAuthority.close();
      tokenAuthority.close();
    };
  }, [assetAuthority, candidateAuthority, exactAuthority, tokenAuthority, walletAuthority]);

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

  useEffect(() => {
    if (walletPending || walletDelivery !== undefined) return;
    const request = walletAuthority.beginRead();
    if (request === undefined) return;
    let timer: number | undefined;
    const poll = async (): Promise<void> => {
      await refreshWallet(request);
      if (!walletAuthority.isCurrent(request)) return;
      timer = window.setTimeout(() => { void poll(); }, browserPollMilliseconds);
    };
    void poll();
    return () => {
      walletAuthority.cancelRead(request);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [refreshWallet, walletAuthority, walletDelivery, walletPending]);

  useEffect(() => {
    assetAuthority.invalidateRead();
    exactAuthority.invalidateRead();
    candidateAuthority.invalidateRead();
    setAssetSnapshot(undefined);
    replaceExactRead(idleExactAssetRead);
    setAddForm(undefined);
    setOfficialCandidateRead({ status: "idle" });
    setAssetRead({ status: "idle" });
    if (currentAccount !== undefined && !observationUnavailable) {
      void readAssetPage(currentAccount, null, [], true);
    }
  }, [currentAccountKey]);

  const operationId = tokenOperation?.operationId;
  useEffect(() => {
    if (tokenPending || tokenDelivery !== undefined) return;
    const request = tokenAuthority.beginRead();
    if (request === undefined) return;
    let timer: number | undefined;
    const poll = async (): Promise<void> => {
      try {
        const next = operationId === undefined
          ? await loadCurrentTokenOperation({ signal: request.signal })
          : (await loadTokenOperation(operationId, { signal: request.signal })).operation;
        if (!tokenAuthority.isCurrent(request)) return;
        if (next !== null && (
          isTokenCatalogOperationTerminal(next.state)
            ? handledTerminalTokenOperation.current !== next.operationId
            : next.operationId !== dismissedTokenOperation.current
        )) acceptTokenOperation(next);
      } catch (error) {
        if (!tokenAuthority.isCurrent(request) || sessionRecovery(error)) return;
        if (operationId !== undefined && isBrowserResponseCode(error, "token_operation_not_found")) {
          setTokenOperation(null);
          publishActionError("Token operation unavailable", error);
          return;
        }
      }
      if (tokenAuthority.isCurrent(request)) {
        timer = window.setTimeout(() => { void poll(); }, browserPollMilliseconds);
      }
    };
    void poll();
    return () => {
      tokenAuthority.cancelRead(request);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [acceptTokenOperation, operationId, publishActionError, sessionRecovery, tokenAuthority, tokenDelivery, tokenPending]);

  const runWalletAction = useCallback(async (
    action: WalletConnectionAction | WalletOperationAction,
  ): Promise<void> => {
    const current = stateRef.current;
    if (current.status !== "ready" || walletDelivery !== undefined) return;
    const request = walletAuthority.beginControl();
    if (request === undefined) return;
    setWalletPending(true);
    try {
      if (action === "connect" || action === "disconnect") {
        if (current.wallet.status === "present" || !walletConnectionActions(current.wallet).includes(action)) return;
        const result = await startWalletOperation(action, current.wallet.connectionRevision, csrfToken());
        if (isDeliveryUnknown(result)) { setWalletDelivery(result); return; }
        if (result.status === "operation_started") {
          replaceObservation(trackWalletOperationResult(observation.current, result.operation));
        }
      } else {
        if (current.wallet.status !== "present" || !walletOperationActions(current.wallet.presentation).includes(action)) return;
        const operation = current.wallet.presentation.operation;
        const result = action === "confirm"
          ? await confirmWalletOperation(operation.operationId, operation.connectionRevision, csrfToken())
          : await cancelWalletOperation(operation.operationId, operation.connectionRevision, csrfToken());
        if (isDeliveryUnknown(result)) { setWalletDelivery(result); return; }
        replaceObservation(trackWalletOperationResult(observation.current, result));
      }
      await refreshWallet(request);
    } catch (error) {
      if (!walletAuthority.isCurrent(request)) return;
      if (sessionRecovery(error)) return;
      if (isBrowserResponseCode(error, "state_conflict")) await refreshWallet(request);
      else publishActionError("Wallet action failed", error);
    } finally {
      walletAuthority.finishControl(request);
      if (walletAuthority.isCurrent(request)) setWalletPending(false);
    }
  }, [publishActionError, refreshWallet, replaceObservation, sessionRecovery, walletAuthority, walletDelivery]);

  const startAdd = useCallback(async (address: string): Promise<void> => {
    if (addForm === undefined || tokenPending || observationUnavailable) return;
    const request = tokenAuthority.beginControl();
    if (request === undefined) return;
    setTokenPending(true);
    try {
      const started = await startTokenSelection(addForm.account.chainId, address, csrfToken());
      if (!tokenAuthority.isCurrent(request)) return;
      if (isDeliveryUnknown(started)) {
        setTokenDelivery(started);
        candidateAuthority.invalidateRead();
        setAddForm(undefined);
        setOfficialCandidateRead({ status: "idle" });
        return;
      }
      acceptTokenOperation(started.operation);
    } catch (error) {
      if (!tokenAuthority.isCurrent(request) || sessionRecovery(error)) return;
      publishActionError("Token action failed", error);
    } finally {
      tokenAuthority.finishControl(request);
      if (tokenAuthority.isCurrent(request)) setTokenPending(false);
    }
  }, [acceptTokenOperation, addForm, candidateAuthority, observationUnavailable, publishActionError, sessionRecovery, tokenAuthority, tokenPending]);

  const startRemove = useCallback(async (selection: TokenSelection): Promise<void> => {
    if (currentAccount === undefined || tokenPending || observationUnavailable) return;
    const request = tokenAuthority.beginControl();
    if (request === undefined) return;
    setTokenPending(true);
    try {
      const started = await startTokenRemoval(selection, csrfToken());
      if (!tokenAuthority.isCurrent(request)) return;
      if (isDeliveryUnknown(started)) { setTokenDelivery(started); return; }
      acceptTokenOperation(started.operation);
    } catch (error) {
      if (!tokenAuthority.isCurrent(request) || sessionRecovery(error)) return;
      publishActionError("Token action failed", error);
    } finally {
      tokenAuthority.finishControl(request);
      if (tokenAuthority.isCurrent(request)) setTokenPending(false);
    }
  }, [acceptTokenOperation, currentAccountKey, observationUnavailable, publishActionError, sessionRecovery, tokenAuthority, tokenPending]);

  const runTokenOperation = useCallback(async (action: "confirm" | "cancel"): Promise<void> => {
    if (tokenOperation === null || tokenPending || tokenOperation.interactionInterface !== "web") return;
    const request = tokenAuthority.beginControl();
    if (request === undefined) return;
    setTokenPending(true);
    try {
      const result = action === "confirm"
        ? await confirmTokenOperation(tokenOperation, csrfToken())
        : await cancelTokenOperation(tokenOperation.operationId, csrfToken());
      if (!tokenAuthority.isCurrent(request)) return;
      if (isDeliveryUnknown(result)) { setTokenDelivery(result); setTokenOperation(null); return; }
      acceptTokenOperation("operation" in result ? result.operation : result);
    } catch (error) {
      if (!tokenAuthority.isCurrent(request) || sessionRecovery(error)) return;
      publishActionError("Token action failed", error);
    } finally {
      tokenAuthority.finishControl(request);
      if (tokenAuthority.isCurrent(request)) setTokenPending(false);
    }
  }, [acceptTokenOperation, publishActionError, sessionRecovery, tokenAuthority, tokenOperation, tokenPending]);

  const dialogPresentation: DialogPresentation | undefined = walletDelivery !== undefined
    ? { kind: "wallet_delivery", delivery: walletDelivery }
    : currentWallet?.status === "present"
      ? { kind: "wallet_operation", presentation: currentWallet.presentation }
      : connectionDialogOpen && currentWallet !== undefined
        ? { kind: "wallet_connection", wallet: currentWallet }
        : tokenDelivery !== undefined
          ? { kind: "token_delivery", delivery: tokenDelivery }
          : tokenOperation !== null
            ? { kind: "token_operation", operation: tokenOperation, accountMatches: sameAccount({
                chainId: tokenOperation.account.chainId,
                address: tokenOperation.account.address,
                connectionRevision: tokenOperation.connectionRevision,
              }, currentAccount) }
            : addForm !== undefined
              ? { kind: "token_add", form: addForm }
              : undefined;

  useEffect(() => {
    if (dialogPresentation !== undefined) { dialogHadFocus.current = true; return; }
    if (dialogHadFocus.current && !walletPending && !tokenPending) {
      (dialogTrigger.current?.isConnected === true ? dialogTrigger.current : walletNavigation.current)?.focus();
      dialogTrigger.current = undefined;
      dialogHadFocus.current = false;
    }
  }, [dialogPresentation, tokenPending, walletPending]);

  const closeDialog = (): void => {
    if (walletDelivery !== undefined) setWalletDelivery(undefined);
    else if (connectionDialogOpen) setConnectionDialogOpen(false);
    else if (tokenDelivery !== undefined) setTokenDelivery(undefined);
    else if (tokenOperation?.interactionInterface === "cli") {
      dismissedTokenOperation.current = tokenOperation.operationId;
      setTokenOperation(null);
    } else {
      candidateAuthority.invalidateRead();
      setAddForm(undefined);
      setOfficialCandidateRead({ status: "idle" });
    }
  };

  const activateWalletNavigation = (): void => {
    if (currentWallet === undefined || currentWallet.status === "present" || observationUnavailable) return;
    if (walletConnectionActions(currentWallet).includes("connect")) { void runWalletAction("connect"); return; }
    setConnectionDialogOpen((isOpen) => !isOpen);
  };

  const visibleAssetSnapshot = assetSnapshot?.accountKey === currentAccountKey
    ? assetSnapshot
    : undefined;
  const visibleExactAsset = exactRead.status === "available" && exactRead.accountKey === currentAccountKey
    ? exactRead.result
    : undefined;
  const visibleExactRead = exactRead.status !== "idle" && exactRead.accountKey === currentAccountKey
    ? exactRead
    : idleExactAssetRead;
  const snapshotForPage: AccountAssetPageSnapshot | undefined = visibleAssetSnapshot === undefined ? undefined : {
    result: visibleAssetSnapshot.result,
    cursor: visibleAssetSnapshot.cursor,
    canGoBack: visibleAssetSnapshot.previousCursors.length > 0,
  };
  return (
    <div className="app-shell">
      <nav className="app-nav" aria-label="Primary">
        <a className="product-name" href={browserPagePaths.root}>{productDisplayName}</a>
        <button
          ref={walletNavigation}
          type="button"
          className="wallet-nav-control secondary"
          aria-expanded={dialogPresentation?.kind.startsWith("wallet") ?? false}
          disabled={currentWallet === undefined || walletPending || walletDelivery !== undefined || observationUnavailable}
          onClick={activateWalletNavigation}
        >
          {walletNavigationLabel(currentWallet)}
        </button>
      </nav>
      {state.status === "loading" ? (
        <main className="intro">
          <p className="eyebrow">Robinhood Chain</p>
          <h1>Local account assets</h1>
          <p>{state.failure ?? "Checking the local wallet connection…"}</p>
          {state.failure === undefined ? null : (
            <button type="button" className="secondary" onClick={retryWalletObservation}>Retry</button>
          )}
        </main>
      ) : currentAccount === undefined ? (
        <main className="intro">
          <p className="eyebrow">Robinhood Chain</p>
          <h1>Your local chain assistant</h1>
          <p>Little John shows the connected account&apos;s native balance and the token contracts you add for that account.</p>
          <p>Connecting a wallet does not sign or send a transaction.</p>
          {state.observationFailure === undefined ? null : <p className="error">{state.observationFailure}</p>}
          {state.observationFailure === undefined ? (
            <button type="button" onClick={activateWalletNavigation}>Connect wallet</button>
          ) : (
            <button type="button" className="secondary" onClick={retryWalletObservation}>Retry</button>
          )}
        </main>
      ) : (
        <>
          {state.observationFailure === undefined ? null : (
            <div className="warning" role="status">
              <strong>Wallet observation unavailable</strong>
              <p>{state.observationFailure}</p>
              <button type="button" className="secondary" onClick={retryWalletObservation}>Retry</button>
            </div>
          )}
          <AccountAssetsPage
            snapshot={snapshotForPage}
            exact={visibleExactAsset}
            loading={assetRead.status === "loading"}
             staleMessage={assetRead.status === "error" ? assetRead.message : undefined}
             exactRead={visibleExactRead.status === "error"
               ? { status: "error", message: visibleExactRead.message }
               : visibleExactRead.status === "loading"
                 ? { status: "loading" }
                 : { status: "idle" }}
            mutationDisabled={walletPending || tokenPending || observationUnavailable || tokenDelivery !== undefined}
             onRefresh={() => {
              void readAssetPage(
                currentAccount,
                visibleAssetSnapshot?.cursor ?? null,
                visibleAssetSnapshot?.previousCursors ?? [],
                false,
              );
             }}
             onRetryExact={() => {
               if (visibleExactRead.status !== "error") return;
               if (visibleAssetSnapshot !== undefined) {
                 void readExactAsset(
                   currentAccount,
                   visibleExactRead.asset,
                   visibleAssetSnapshot.result.viewRevision,
                 );
               }
             }}
            onAdd={(trigger) => {
              if (visibleAssetSnapshot?.result.viewRevision.officialSnapshotStatus !== "current") return;
              dialogTrigger.current = trigger;
              const form = Object.freeze({
                account: currentAccount,
                viewRevision: visibleAssetSnapshot.result.viewRevision,
              });
              setAddForm(form);
              void readOfficialCandidates(form, null, []);
            }}
            onInfo={(selection, trigger) => {
              if (visibleAssetSnapshot === undefined) return;
              dialogTrigger.current = trigger;
              void readExactAsset(
                currentAccount,
                selection.asset,
                visibleAssetSnapshot.result.viewRevision,
              );
            }}
            onCloseInfo={() => {
              exactAuthority.invalidateRead();
              replaceExactRead(idleExactAssetRead);
              const trigger = dialogTrigger.current;
              dialogTrigger.current = undefined;
              window.setTimeout(() => { if (trigger?.isConnected === true) trigger.focus(); }, 0);
            }}
            onRemove={(selection, trigger) => {
              exactAuthority.invalidateRead();
              replaceExactRead(idleExactAssetRead);
              dialogTrigger.current = trigger;
              void startRemove(selection);
            }}
            onPrevious={() => {
              if (visibleAssetSnapshot === undefined) return;
              const cursor = visibleAssetSnapshot.previousCursors.at(-1) ?? null;
              void readAssetPage(
                currentAccount,
                cursor,
                visibleAssetSnapshot.previousCursors.slice(0, -1),
                true,
              );
            }}
            onNext={() => {
              if (visibleAssetSnapshot?.result.nextCursor === null || visibleAssetSnapshot === undefined) return;
              void readAssetPage(
                currentAccount,
                visibleAssetSnapshot.result.nextCursor,
                [...visibleAssetSnapshot.previousCursors, visibleAssetSnapshot.cursor],
                true,
              );
            }}
          />
        </>
      )}
      {dialogPresentation === undefined ? null : (
        <ApplicationDialog
          presentation={dialogPresentation}
          pending={walletPending || tokenPending}
          onClose={closeDialog}
          onWalletAction={(action) => { void runWalletAction(action); }}
          officialCandidates={officialCandidateRead}
          onRetryOfficialCandidates={() => {
            if (addForm !== undefined) void readOfficialCandidates(addForm, null, []);
          }}
          onPreviousOfficialCandidates={() => {
            if (addForm === undefined || officialCandidateRead.status !== "available") return;
            const previous = officialCandidateRead.snapshot.previousCursors;
            void readOfficialCandidates(
              addForm,
              previous.at(-1) ?? null,
              previous.slice(0, -1),
            );
          }}
          onNextOfficialCandidates={() => {
            if (addForm === undefined || officialCandidateRead.status !== "available" ||
              officialCandidateRead.snapshot.result.nextCursor === null) return;
            void readOfficialCandidates(
              addForm,
              officialCandidateRead.snapshot.result.nextCursor,
              [...officialCandidateRead.snapshot.previousCursors, officialCandidateRead.snapshot.cursor],
            );
          }}
          onTokenAddress={(address) => { void startAdd(address); }}
          onTokenConfirm={() => { void runTokenOperation("confirm"); }}
          onTokenCancel={() => { void runTokenOperation("cancel"); }}
        />
      )}
      {activeNotification === undefined ? null : (
        <Notification notice={activeNotification.notice} exiting={activeNotification.phase === "exiting"} />
      )}
    </div>
  );
};
