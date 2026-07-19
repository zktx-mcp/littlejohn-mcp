import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import type { WalletCurrentOperationProjection } from "../../wallet/operation-contract.js";
import {
  isTokenCatalogOperationTerminal,
  tokenInspectionDigest,
  tokenRegistrationSettingsSchema,
  type TokenCatalogOperation,
  type TokenRegistration,
  type TokenRegistrationSettings,
  type TokenRegistrationWithInspection,
} from "../../token-catalog/browser.js";
import {
  browserActionFailureMessage,
  isBrowserResponseCode,
} from "./browser-client.js";
import { loadWalletProjection } from "./wallet-client.js";
import type { NotificationNotice } from "./notification.js";
import { createBrowserRequestAuthority } from "./request-authority.js";
import {
  cancelTokenOperation,
  confirmTokenOperation,
  loadCurrentTokenOperation,
  loadTokenOperation,
  loadTokenRegistration,
  loadTokenRegistrations,
  parseTokenAddressInput,
  startTokenRegistration,
  startTokenRegistrationUpdate,
  startTokenUnregistration,
} from "./token-catalog-client.js";
import {
  tokenInspectionFields,
  tokenOperationCopy,
  tokenOperationNotification,
  tokenRegistrationLabel,
} from "./token-catalog-view.js";

const tokenOperationPollMilliseconds = 500;
const accountMismatchMessage = "The token catalog response does not match the connected account.";

type ConnectedAccount = Readonly<{
  chainId: TokenRegistration["account"]["chainId"];
  address: TokenRegistration["account"]["address"];
  connectionRevision: string;
}>;

type TokenListState =
  | Readonly<{ status: "unavailable" }>
  | Readonly<{ status: "loading"; account: ConnectedAccount }>
  | Readonly<{ status: "error"; account: ConnectedAccount; message: string }>
  | Readonly<{
      status: "ready";
      account: ConnectedAccount;
      registrations: readonly TokenRegistration[];
      nextCursor: TokenRegistration["asset"]["address"] | null;
    }>;

type TokenFormDialog =
  | Readonly<{ mode: "add"; account: ConnectedAccount }>
  | Readonly<{
      mode: "edit";
      account: ConnectedAccount;
      detail: TokenRegistrationWithInspection;
    }>;

const connectedAccount = (
  wallet: WalletCurrentOperationProjection,
): ConnectedAccount | undefined => wallet.connection.status === "connected"
  ? Object.freeze({
      chainId: wallet.connection.chainId,
      address: wallet.connection.address,
      connectionRevision: wallet.connectionRevision,
    })
  : undefined;

const sameConnectedAccount = (
  expected: ConnectedAccount,
  wallet: WalletCurrentOperationProjection,
): boolean => {
  const actual = connectedAccount(wallet);
  return actual !== undefined &&
    actual.chainId === expected.chainId &&
    actual.address === expected.address &&
    actual.connectionRevision === expected.connectionRevision;
};

const sameAccount = (
  left: ConnectedAccount,
  right: ConnectedAccount,
): boolean => left.chainId === right.chainId &&
  left.address === right.address &&
  left.connectionRevision === right.connectionRevision;

const registrationPageMatchesAccount = (
  expected: ConnectedAccount,
  registrations: readonly TokenRegistration[],
): boolean => registrations.every((registration) =>
  registration.account.chainId === expected.chainId &&
  registration.account.address === expected.address,
);

const TokenInspectionDetails = ({
  inspection,
}: {
  readonly inspection: TokenRegistrationWithInspection["inspection"];
}) => (
  <dl className="token-details">
    {tokenInspectionFields(inspection).flatMap((field) => [
      <dt key={`${field.label}:label`}>{field.label}</dt>,
      <dd key={`${field.label}:value`}>{field.value}</dd>,
    ])}
  </dl>
);

const TokenOperationReview = ({ operation }: { readonly operation: TokenCatalogOperation }) => {
  const copy = tokenOperationCopy(operation);
  const proposed = operation.review.proposedSettings;
  const previous = operation.review.previousRegistration;
  return (
    <>
      <header>
        <h1>{copy.heading}</h1>
        <p>{copy.message}</p>
      </header>
      <dl className="token-details">
        <dt>Chain</dt>
        <dd>{operation.account.chainId}</dd>
        <dt>Account</dt>
        <dd>{operation.account.address}</dd>
        <dt>Contract</dt>
        <dd>{operation.asset.address}</dd>
        {previous === null ? null : (
          <>
            <dt>Current label</dt>
            <dd>{previous.userLabel ?? "None"}</dd>
            <dt>Current visibility</dt>
            <dd>{previous.visibility}</dd>
          </>
        )}
        {proposed === null ? null : (
          <>
            <dt>New label</dt>
            <dd>{proposed.userLabel ?? "None"}</dd>
            <dt>New visibility</dt>
            <dd>{proposed.visibility}</dd>
          </>
        )}
      </dl>
      <TokenInspectionDetails inspection={operation.review.inspection} />
      <details>
        <summary>Technical details</summary>
        <dl className="technical-details">
          <dt>Operation ID</dt>
          <dd>{operation.operationId}</dd>
          <dt>Review digest</dt>
          <dd>{operation.review.reviewDigest}</dd>
          <dt>Inspection digest</dt>
          <dd>{tokenInspectionDigest(operation.review.inspection)}</dd>
          <dt>Expires</dt>
          <dd>{operation.expiresAt}</dd>
        </dl>
      </details>
      {operation.interactionInterface === "cli" && !isTokenCatalogOperationTerminal(operation.state) ? (
        <div className="notice">
          <strong>Read-only review</strong>
          <p>Continue this token catalog change in the CLI.</p>
        </div>
      ) : null}
    </>
  );
};

const TokenDialog = ({
  form,
  operation,
  pending,
  onClose,
  onSubmitAdd,
  onSubmitEdit,
  onConfirm,
  onCancel,
}: {
  readonly form: TokenFormDialog | undefined;
  readonly operation: TokenCatalogOperation | null;
  readonly pending: boolean;
  readonly onClose: () => void;
  readonly onSubmitAdd: (address: string, settings: TokenRegistrationSettings) => void;
  readonly onSubmitEdit: (
    detail: TokenRegistrationWithInspection,
    settings: TokenRegistrationSettings,
  ) => void;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) => {
  const dialog = useRef<HTMLDialogElement>(null);
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState(form?.mode === "edit" ? form.detail.registration.userLabel ?? "" : "");
  const [visibility, setVisibility] = useState<TokenRegistrationSettings["visibility"]>(
    form?.mode === "edit" ? form.detail.registration.visibility : "visible",
  );
  const [validation, setValidation] = useState<string | undefined>(undefined);
  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    element.showModal();
    element.focus();
    return () => { if (element.open) element.close(); };
  }, []);

  const settings = (): TokenRegistrationSettings => tokenRegistrationSettingsSchema.parse({
    userLabel: label === "" ? null : label,
    visibility,
  });

  const submit = (): void => {
    setValidation(undefined);
    let next: TokenRegistrationSettings;
    try { next = settings(); }
    catch {
      setValidation(
        "Use 1–128 printable label characters without line breaks or directional controls, or leave it blank.",
      );
      return;
    }
    if (form?.mode === "add") {
      try { parseTokenAddressInput(address); }
      catch {
        setValidation("Enter a valid EVM contract address.");
        return;
      }
      onSubmitAdd(address, next);
      return;
    }
    if (form?.mode === "edit") {
      if (
        next.userLabel === form.detail.registration.userLabel &&
        next.visibility === form.detail.registration.visibility
      ) {
        setValidation("Change the label or visibility before continuing.");
        return;
      }
      onSubmitEdit(form.detail, next);
    }
  };

  const showOperationActions = operation !== null &&
    operation.state === "awaiting_confirmation" &&
    operation.interactionInterface === "web";
  const dismissibleReadOnlyOperation = operation !== null &&
    operation.interactionInterface === "cli" &&
    !isTokenCatalogOperationTerminal(operation.state);
  const closeWithoutMutation = (): void => {
    if (!pending && (dismissibleReadOnlyOperation || operation === null)) onClose();
  };
  return (
    <dialog
      ref={dialog}
      className="token-dialog"
      aria-label="Token catalog"
      tabIndex={-1}
      onCancel={(event) => {
        event.preventDefault();
        closeWithoutMutation();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        closeWithoutMutation();
      }}
    >
      {operation !== null ? <TokenOperationReview operation={operation} /> : null}
      {form?.mode === "add" || form?.mode === "edit" ? (
        <>
          <header>
            <h1>{form.mode === "add" ? "Add token" : "Edit token"}</h1>
            <p>{form.mode === "add"
              ? "Inspect a token contract and review it before adding it to this account."
              : "Review the stored inspection before changing this account's catalog settings."}</p>
          </header>
          {form.mode === "edit" ? <TokenInspectionDetails inspection={form.detail.inspection} /> : null}
          <label className="field">
            <span>Contract address</span>
            <input
              type="text"
              value={form.mode === "edit" ? form.detail.registration.asset.address : address}
              disabled={pending || form.mode === "edit"}
              onChange={(event) => { setAddress(event.currentTarget.value); }}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label className="field">
            <span>Label</span>
            <input
              type="text"
              value={label}
              disabled={pending}
              onChange={(event) => { setLabel(event.currentTarget.value); }}
              autoComplete="off"
            />
          </label>
          <label className="field">
            <span>Visibility</span>
            <select
              value={visibility}
              disabled={pending}
              onChange={(event) => {
                setVisibility(event.currentTarget.value === "hidden" ? "hidden" : "visible");
              }}
            >
              <option value="visible">Visible</option>
              <option value="hidden">Hidden</option>
            </select>
          </label>
          {validation === undefined ? null : <p className="error">{validation}</p>}
        </>
      ) : null}
      <div className="actions">
        {operation === null || dismissibleReadOnlyOperation ? (
          <button type="button" className="secondary" disabled={pending} onClick={() => { onClose(); }}>
            Close
          </button>
        ) : null}
        {form?.mode === "add" || form?.mode === "edit" ? (
          <button type="button" disabled={pending} onClick={() => { submit(); }}>
            {pending ? "Inspecting…" : "Review change"}
          </button>
        ) : null}
        {showOperationActions ? (
          <>
            <button type="button" className="secondary" disabled={pending} onClick={() => { onCancel(); }}>
              Cancel
            </button>
            <button type="button" disabled={pending} onClick={() => { onConfirm(); }}>
              Confirm change
            </button>
          </>
        ) : null}
      </div>
    </dialog>
  );
};

export const TokenCatalogPage = ({
  wallet,
  getCsrfToken,
  recoverBrowserSession,
  onOpenWallet,
  onNotification,
}: {
  readonly wallet: WalletCurrentOperationProjection;
  readonly getCsrfToken: () => string;
  readonly recoverBrowserSession: (error: unknown) => boolean;
  readonly onOpenWallet: () => void;
  readonly onNotification: (notice: NotificationNotice) => void;
}) => {
  const account = connectedAccount(wallet);
  const accountKey = account === undefined
    ? "disconnected"
    : `${account.connectionRevision}:${account.chainId}:${account.address}`;
  const [listState, setListState] = useState<TokenListState>(
    account === undefined ? { status: "unavailable" } : { status: "loading", account },
  );
  const [listRevision, setListRevision] = useState(0);
  const [formDialog, setFormDialog] = useState<TokenFormDialog | undefined>(undefined);
  const [operation, setOperation] = useState<TokenCatalogOperation | null>(null);
  const [listRequestAuthority] = useState(createBrowserRequestAuthority);
  const [detailRequestAuthority] = useState(createBrowserRequestAuthority);
  const [operationRequestAuthority] = useState(createBrowserRequestAuthority);
  const [loadMorePending, setLoadMorePending] = useState(false);
  const [detailPending, setDetailPending] = useState(false);
  const [operationPending, setOperationPending] = useState(false);
  const requestPending = loadMorePending || detailPending || operationPending;
  const notifiedOperationId = useRef<string | undefined>(undefined);
  const dismissedReadOnlyOperationId = useRef<string | undefined>(undefined);
  const pageHeading = useRef<HTMLHeadingElement | null>(null);
  const addTokenButton = useRef<HTMLButtonElement | null>(null);
  const dialogTrigger = useRef<HTMLElement | null>(null);
  const dialogHadFocus = useRef(false);
  const focusReturnPending = useRef(false);

  useEffect(() => {
    listRequestAuthority.activate();
    detailRequestAuthority.activate();
    operationRequestAuthority.activate();
    return () => {
      listRequestAuthority.close();
      detailRequestAuthority.close();
      operationRequestAuthority.close();
    };
  }, [detailRequestAuthority, listRequestAuthority, operationRequestAuthority]);

  const setStableDialogFocusTarget = useCallback((): void => {
    dialogTrigger.current = addTokenButton.current ?? pageHeading.current;
  }, []);

  const publishError = useCallback((error: unknown): void => {
    onNotification(Object.freeze({
      id: "token-catalog-error",
      tone: "error",
      heading: "Token catalog action failed",
      message: browserActionFailureMessage(error),
    }));
  }, [onNotification]);

  const acceptOperation = useCallback((next: TokenCatalogOperation): void => {
    detailRequestAuthority.invalidateRead();
    setDetailPending(false);
    const notice = tokenOperationNotification(next);
    if (notice === undefined) {
      if (dismissedReadOnlyOperationId.current !== next.operationId) {
        dismissedReadOnlyOperationId.current = undefined;
      }
      setOperation(next);
      setFormDialog(undefined);
      return;
    }
    setStableDialogFocusTarget();
    setOperation(null);
    setFormDialog(undefined);
    if (notifiedOperationId.current !== next.operationId) {
      notifiedOperationId.current = next.operationId;
      onNotification(notice);
      setListRevision((current) => current + 1);
    }
  }, [detailRequestAuthority, onNotification, setStableDialogFocusTarget]);

  useEffect(() => {
    const request = listRequestAuthority.beginRead();
    if (request === undefined) return;
    setLoadMorePending(false);
    if (account === undefined) {
      setListState({ status: "unavailable" });
      return () => { listRequestAuthority.cancelRead(request); };
    }
    setListState({ status: "loading", account });
    void (async () => {
      try {
        const page = await loadTokenRegistrations({}, { signal: request.signal });
        if (!listRequestAuthority.isCurrent(request)) return;
        const after = await loadWalletProjection({ signal: request.signal });
        if (!listRequestAuthority.isCurrent(request)) return;
        if (
          !sameConnectedAccount(account, after) ||
          !registrationPageMatchesAccount(account, page.registrations)
        ) {
          setListState({ status: "error", account, message: accountMismatchMessage });
          return;
        }
        setListState({
          status: "ready",
          account,
          registrations: page.registrations,
          nextCursor: page.nextCursor,
        });
      } catch (error) {
        if (!listRequestAuthority.isCurrent(request) || recoverBrowserSession(error)) return;
        setListState({
          status: "error",
          account,
          message: browserActionFailureMessage(error),
        });
      }
    })();
    return () => { listRequestAuthority.cancelRead(request); };
  }, [accountKey, listRequestAuthority, listRevision, recoverBrowserSession]);

  const operationId = operation?.operationId;
  useEffect(() => {
    if (operationPending) return;
    const request = operationRequestAuthority.beginRead();
    if (request === undefined) return;
    let timer: number | undefined;
    const poll = async (): Promise<void> => {
      try {
        const next = operationId === undefined
          ? await loadCurrentTokenOperation({ signal: request.signal })
          : (await loadTokenOperation(operationId, { signal: request.signal })).operation;
        if (!operationRequestAuthority.isCurrent(request)) return;
        if (
          next !== null &&
          next.operationId !== notifiedOperationId.current &&
          (
            next.operationId !== dismissedReadOnlyOperationId.current ||
            isTokenCatalogOperationTerminal(next.state)
          )
        ) acceptOperation(next);
      } catch (error) {
        if (!operationRequestAuthority.isCurrent(request) || recoverBrowserSession(error)) return;
        if (
          operationId !== undefined &&
          isBrowserResponseCode(error, "token_operation_not_found")
        ) {
          setStableDialogFocusTarget();
          setOperation(null);
          setFormDialog(undefined);
          onNotification(Object.freeze({
            id: `${operationId}:unavailable`,
            tone: "error",
            heading: "Token catalog operation unavailable",
            message: browserActionFailureMessage(error),
          }));
          return;
        }
      }
      if (operationRequestAuthority.isCurrent(request)) {
        timer = window.setTimeout(() => { void poll(); }, tokenOperationPollMilliseconds);
      }
    };
    void poll();
    return () => {
      operationRequestAuthority.cancelRead(request);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [
    acceptOperation,
    onNotification,
    operationId,
    operationPending,
    operationRequestAuthority,
    recoverBrowserSession,
    setStableDialogFocusTarget,
  ]);

  const displayedFormDialog = formDialog !== undefined &&
    account !== undefined &&
    sameAccount(formDialog.account, account)
    ? formDialog
    : undefined;
  const tokenDialogOpen = displayedFormDialog !== undefined || operation !== null;
  useEffect(() => {
    if (tokenDialogOpen) {
      dialogHadFocus.current = true;
      return;
    }
    if ((dialogHadFocus.current || focusReturnPending.current) && !requestPending) {
      const target = dialogTrigger.current?.isConnected === true
        ? dialogTrigger.current
        : addTokenButton.current ?? pageHeading.current;
      target?.focus();
      dialogTrigger.current = null;
      dialogHadFocus.current = false;
      focusReturnPending.current = false;
    }
  }, [requestPending, tokenDialogOpen]);

  useEffect(() => {
    detailRequestAuthority.invalidateRead();
    setDetailPending(false);
    setFormDialog((current) => current !== undefined && (
      account === undefined || !sameAccount(current.account, account)
    ) ? undefined : current);
  }, [accountKey, detailRequestAuthority]);

  const closeTokenDialog = useCallback((): void => {
    if (
      operation !== null &&
      operation.interactionInterface === "cli" &&
      !isTokenCatalogOperationTerminal(operation.state)
    ) dismissedReadOnlyOperationId.current = operation.operationId;
    setOperation(null);
    setFormDialog(undefined);
  }, [operation]);

  const verifyDetailAccount = async (
    expected: ConnectedAccount,
    detail: TokenRegistrationWithInspection,
    signal?: AbortSignal,
  ): Promise<boolean> => {
    const after = await loadWalletProjection(signal === undefined ? {} : { signal });
    return sameConnectedAccount(expected, after) &&
      detail.registration.account.chainId === expected.chainId &&
      detail.registration.account.address === expected.address;
  };

  const openEdit = async (registration: TokenRegistration): Promise<void> => {
    if (account === undefined || requestPending) return;
    const request = detailRequestAuthority.beginRead();
    if (request === undefined) return;
    focusReturnPending.current = true;
    setDetailPending(true);
    try {
      const detail = await loadTokenRegistration(
        account.chainId,
        registration.asset.address,
        { signal: request.signal },
      );
      if (!detailRequestAuthority.isCurrent(request)) return;
      if (!await verifyDetailAccount(account, detail, request.signal)) {
        if (!detailRequestAuthority.isCurrent(request)) return;
        setFormDialog(undefined);
        return;
      }
      if (!detailRequestAuthority.isCurrent(request)) return;
      setFormDialog({ mode: "edit", account, detail });
    } catch (error) {
      if (!detailRequestAuthority.isCurrent(request)) return;
      setFormDialog(undefined);
      if (!recoverBrowserSession(error)) publishError(error);
    } finally {
      if (detailRequestAuthority.isCurrent(request)) {
        detailRequestAuthority.cancelRead(request);
        setDetailPending(false);
      }
    }
  };

  const startRemoval = async (registration: TokenRegistration): Promise<void> => {
    if (account === undefined || requestPending) return;
    const request = operationRequestAuthority.beginControl();
    if (request === undefined) return;
    focusReturnPending.current = true;
    setOperationPending(true);
    try {
      const detail = await loadTokenRegistration(account.chainId, registration.asset.address);
      if (!operationRequestAuthority.isCurrent(request)) return;
      if (!await verifyDetailAccount(account, detail)) {
        if (!operationRequestAuthority.isCurrent(request)) return;
        setFormDialog(undefined);
        return;
      }
      const started = await startTokenUnregistration(detail.registration, getCsrfToken());
      if (!operationRequestAuthority.isCurrent(request)) return;
      acceptOperation(started.operation);
    } catch (error) {
      if (!operationRequestAuthority.isCurrent(request)) return;
      setFormDialog(undefined);
      if (!recoverBrowserSession(error)) publishError(error);
    } finally {
      operationRequestAuthority.finishControl(request);
      if (operationRequestAuthority.isCurrent(request)) setOperationPending(false);
    }
  };

  const submitAdd = async (
    address: string,
    settings: TokenRegistrationSettings,
  ): Promise<void> => {
    if (account === undefined || requestPending) return;
    const request = operationRequestAuthority.beginControl();
    if (request === undefined) return;
    setOperationPending(true);
    try {
      const started = await startTokenRegistration(
        account.chainId,
        address,
        settings,
        getCsrfToken(),
      );
      if (!operationRequestAuthority.isCurrent(request)) return;
      acceptOperation(started.operation);
    } catch (error) {
      if (!operationRequestAuthority.isCurrent(request)) return;
      if (!recoverBrowserSession(error)) publishError(error);
    } finally {
      operationRequestAuthority.finishControl(request);
      if (operationRequestAuthority.isCurrent(request)) setOperationPending(false);
    }
  };

  const submitEdit = async (
    detail: TokenRegistrationWithInspection,
    settings: TokenRegistrationSettings,
  ): Promise<void> => {
    if (requestPending) return;
    const request = operationRequestAuthority.beginControl();
    if (request === undefined) return;
    const changes = Object.freeze({
      ...(settings.userLabel === detail.registration.userLabel
        ? {}
        : { userLabel: settings.userLabel }),
      ...(settings.visibility === detail.registration.visibility
        ? {}
        : { visibility: settings.visibility }),
    });
    setOperationPending(true);
    try {
      const started = await startTokenRegistrationUpdate(
        detail.registration,
        changes,
        getCsrfToken(),
      );
      if (!operationRequestAuthority.isCurrent(request)) return;
      acceptOperation(started.operation);
    } catch (error) {
      if (!operationRequestAuthority.isCurrent(request)) return;
      if (!recoverBrowserSession(error)) publishError(error);
    } finally {
      operationRequestAuthority.finishControl(request);
      if (operationRequestAuthority.isCurrent(request)) setOperationPending(false);
    }
  };

  const operate = async (action: "confirm" | "cancel"): Promise<void> => {
    if (operation === null || requestPending || operation.interactionInterface !== "web") return;
    const request = operationRequestAuthority.beginControl();
    if (request === undefined) return;
    setOperationPending(true);
    try {
      const result = action === "confirm"
        ? await confirmTokenOperation(operation, getCsrfToken())
        : (await cancelTokenOperation(operation.operationId, getCsrfToken())).operation;
      if (!operationRequestAuthority.isCurrent(request)) return;
      acceptOperation(result);
    } catch (error) {
      if (!operationRequestAuthority.isCurrent(request)) return;
      if (!recoverBrowserSession(error)) publishError(error);
    } finally {
      operationRequestAuthority.finishControl(request);
      if (operationRequestAuthority.isCurrent(request)) setOperationPending(false);
    }
  };

  const loadMore = async (): Promise<void> => {
    if (listState.status !== "ready" || listState.nextCursor === null || requestPending) return;
    const expected = listState;
    const cursor = listState.nextCursor;
    const request = listRequestAuthority.beginRead();
    if (request === undefined) return;
    setLoadMorePending(true);
    try {
      const page = await loadTokenRegistrations({ cursor }, { signal: request.signal });
      if (!listRequestAuthority.isCurrent(request)) return;
      const after = await loadWalletProjection({ signal: request.signal });
      if (!listRequestAuthority.isCurrent(request)) return;
      if (
        !sameConnectedAccount(expected.account, after) ||
        !registrationPageMatchesAccount(expected.account, page.registrations)
      ) {
        setListState({
          status: "error",
          account: expected.account,
          message: accountMismatchMessage,
        });
        return;
      }
      setListState((current) => current.status === "ready" &&
        sameAccount(current.account, expected.account) &&
        current.nextCursor === cursor
        ? {
            ...current,
            registrations: Object.freeze([...current.registrations, ...page.registrations]),
            nextCursor: page.nextCursor,
          }
        : current);
    } catch (error) {
      if (!listRequestAuthority.isCurrent(request)) return;
      if (!recoverBrowserSession(error)) publishError(error);
    } finally {
      if (listRequestAuthority.isCurrent(request)) {
        listRequestAuthority.cancelRead(request);
        setLoadMorePending(false);
      }
    }
  };

  const displayedListState: TokenListState = account === undefined
    ? { status: "unavailable" }
    : listState.status !== "unavailable" && sameAccount(listState.account, account)
      ? listState
      : { status: "loading", account };

  return (
    <section className="token-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Account catalog</p>
          <h1 ref={pageHeading} tabIndex={-1}>Tokens</h1>
          <p>Keep a local list of token contracts for the connected account.</p>
        </div>
        {account === undefined ? null : (
          <button
            ref={addTokenButton}
            type="button"
            disabled={requestPending}
            onClick={(event) => {
              dialogTrigger.current = event.currentTarget;
              setFormDialog({ mode: "add", account });
            }}
          >
            Add token
          </button>
        )}
      </header>
      {account === undefined ? (
        <div className="empty-state">
          <h2>Connect a wallet to view its token catalog</h2>
          <p>Registrations belong to one chain and one wallet address.</p>
          <div className="actions">
            <button type="button" onClick={() => { onOpenWallet(); }}>Connect wallet</button>
          </div>
        </div>
      ) : (
        <>
          <p className="account-line">
            <strong>Account</strong> {account.chainId} / {account.address}
          </p>
          {displayedListState.status === "loading" ? <p>Loading token registrations…</p> : null}
          {displayedListState.status === "error" ? <p className="error">{displayedListState.message}</p> : null}
          {displayedListState.status === "ready" && displayedListState.registrations.length === 0 ? (
            <div className="empty-state">
              <h2>No registered tokens</h2>
              <p>Add a contract to inspect it and keep it in this account's local catalog.</p>
            </div>
          ) : null}
          {displayedListState.status === "ready" && displayedListState.registrations.length > 0 ? (
            <div className="token-list">
              {displayedListState.registrations.map((registration) => (
                <article className="token-card" key={registration.asset.address}>
                  <div className="token-card-copy">
                    <h2>{tokenRegistrationLabel(registration)}</h2>
                    <p>{registration.asset.address}</p>
                    <p>Visibility: {registration.visibility}</p>
                  </div>
                  <div className="actions compact-actions">
                    <button
                      type="button"
                      className="secondary"
                      disabled={requestPending}
                      onClick={(event) => {
                        dialogTrigger.current = event.currentTarget;
                        void openEdit(registration);
                      }}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="danger"
                      disabled={requestPending}
                      onClick={(event) => {
                        dialogTrigger.current = event.currentTarget;
                        void startRemoval(registration);
                      }}
                    >
                      Remove
                    </button>
                  </div>
                </article>
              ))}
            </div>
          ) : null}
          {displayedListState.status === "ready" && displayedListState.nextCursor !== null ? (
            <div className="actions">
              <button type="button" className="secondary" disabled={requestPending} onClick={() => { void loadMore(); }}>
                Load more
              </button>
            </div>
          ) : null}
        </>
      )}
      {displayedFormDialog !== undefined || operation !== null ? (
        <TokenDialog
          key={operation?.operationId ?? displayedFormDialog?.mode}
          form={displayedFormDialog}
          operation={operation}
          pending={requestPending}
          onClose={closeTokenDialog}
          onSubmitAdd={(address, settings) => { void submitAdd(address, settings); }}
          onSubmitEdit={(detail, settings) => { void submitEdit(detail, settings); }}
          onConfirm={() => { void operate("confirm"); }}
          onCancel={() => { void operate("cancel"); }}
        />
      ) : null}
    </section>
  );
};
