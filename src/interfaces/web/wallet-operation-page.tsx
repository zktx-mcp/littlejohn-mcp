import { useCallback, useEffect, useState } from "react";

import { productDisplayName } from "../../core/browser.js";
import type {
  WalletManagementOperation,
  WalletQrMatrix,
} from "../../wallet/operation-contract.js";
import {
  isWalletOperationCancellableState,
  isWalletOperationConfirmableState,
  isWalletOperationTerminalState,
} from "../../wallet/operation-state.js";
import {
  browserCsrfMetaName,
  parseBrowserOperationPagePath,
  parseBrowserRequestToken,
} from "../browser-contract.js";
import {
  cancelWalletOperation,
  confirmWalletOperation,
  isBrowserResponseCode,
  loadWalletOperationView,
  type WalletOperationView,
} from "./operation-client.js";
import {
  createWalletOperationRequestAuthority,
  type WalletOperationRequest,
} from "./request-authority.js";

type ReadyViewState = WalletOperationView & { readonly status: "ready" };

type ViewState =
  | { readonly status: "loading" }
  | ReadyViewState
  | { readonly status: "error"; readonly message: string };

const operationIdFromPath = (): string => parseBrowserOperationPagePath(window.location.pathname);

const csrfToken = (): string => {
  const value = document.querySelector<HTMLMetaElement>(`meta[name="${browserCsrfMetaName}"]`)?.content;
  try { return parseBrowserRequestToken(value); }
  catch { throw new Error("The wallet operation request token is unavailable."); }
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

const operationResult = (operation: WalletManagementOperation): string | undefined => {
  if (operation.result === null) return undefined;
  return operation.result.outcome;
};

const walletOperationConfirmationMessage = (
  kind: WalletManagementOperation["kind"],
): string => kind === "connect"
  ? "Every existing wallet session will be disconnected before the new connection is requested. If the new wallet approval fails, this profile will remain disconnected."
  : "Every existing wallet session in this local profile will be disconnected.";

const ConnectionResult = ({ operation }: { readonly operation: WalletManagementOperation }) => {
  const connection = operation.result?.connection;
  if (connection === undefined) return null;
  if (connection.status === "connected") {
    return <>
      <dt>Connected address</dt><dd>{connection.address}</dd>
      <dt>Chain</dt><dd>{connection.chainId}</dd>
      <dt>Session expiry</dt><dd>{connection.expiresAt}</dd>
    </>;
  }
  return <><dt>Connection</dt><dd>Disconnected ({connection.reason})</dd></>;
};

export const WalletOperationPage = () => {
  const [operationId] = useState(operationIdFromPath);
  const [view, setView] = useState<ViewState>({ status: "loading" });
  const [requestPending, setRequestPending] = useState(false);
  const [polling, setPolling] = useState(true);
  const [requestAuthority] = useState(createWalletOperationRequestAuthority);

  const refresh = useCallback(async (request: WalletOperationRequest): Promise<boolean> => {
    try {
      const nextView = await loadWalletOperationView(
        operationId,
        request.signal === undefined ? {} : { signal: request.signal },
      );
      if (!requestAuthority.isCurrent(request)) return false;
      setView({ status: "ready", ...nextView });
      return !isWalletOperationTerminalState(nextView.operation.state);
    }
    catch (error) {
      if (!requestAuthority.isCurrent(request)) return false;
      setView({ status: "error", message: error instanceof Error ? error.message : "The wallet operation failed." });
      return false;
    }
  }, [operationId, requestAuthority]);

  useEffect(() => {
    requestAuthority.activate();
    return () => { requestAuthority.close(); };
  }, [requestAuthority]);

  useEffect(() => {
    if (!polling || requestPending) return;
    const request = requestAuthority.beginPoll();
    if (request === undefined) return;
    let timer: number | undefined;
    const poll = async (): Promise<void> => {
      const shouldContinue = await refresh(request);
      if (!requestAuthority.isCurrent(request)) return;
      if (!shouldContinue) {
        setPolling(false);
        return;
      }
      timer = window.setTimeout(() => { void poll(); }, 500);
    };
    void poll();
    return () => {
      requestAuthority.cancelPoll(request);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [polling, refresh, requestAuthority, requestPending]);

  const control = async (method: "POST" | "DELETE"): Promise<void> => {
    if (view.status !== "ready") return;
    const request = requestAuthority.beginControl();
    if (request === undefined) return;
    setRequestPending(true);
    try {
      const operation = method === "POST"
        ? await confirmWalletOperation(
          operationId,
          view.operation.connectionRevision,
          csrfToken(),
        )
        : await cancelWalletOperation(operationId, csrfToken());
      if (!requestAuthority.isCurrent(request)) return;
      setView({ status: "ready", operation, access: view.access });
      if (isWalletOperationTerminalState(operation.state)) setPolling(false);
    } catch (error) {
      if (!requestAuthority.isCurrent(request)) return;
      if (isBrowserResponseCode(error, "state_conflict")) {
        const shouldContinue = await refresh(request);
        if (requestAuthority.isCurrent(request)) setPolling(shouldContinue);
      } else {
        setPolling(false);
        setView({
          status: "error",
          message: error instanceof Error
            ? error.message
            : "The wallet operation failed.",
        });
      }
    } finally {
      requestAuthority.finishControl(request);
      if (requestAuthority.isCurrent(request)) setRequestPending(false);
    }
  };

  if (view.status === "loading") return <section className="panel"><p>Loading wallet operation…</p></section>;
  if (view.status === "error") return <section className="panel"><h1>Wallet operation unavailable</h1><p>{view.message}</p></section>;

  const operation = view.operation;
  return (
    <section className="panel">
      <header>
        <p className="eyebrow">{productDisplayName}</p>
        <h1>{operation.kind === "connect" ? "Connect Robinhood Wallet" : "Disconnect Robinhood Wallet"}</h1>
      </header>
      <dl>
        <dt>State</dt><dd>{operation.state}</dd>
        <dt>Connection revision</dt><dd>{operation.connectionRevision}</dd>
        <dt>Expires</dt><dd>{operation.expiresAt}</dd>
        {operationResult(operation) === undefined ? null : <><dt>Outcome</dt><dd>{operationResult(operation)}</dd></>}
        <ConnectionResult operation={operation} />
      </dl>
      {view.qr === undefined ? null : (
        <div className="qr-wrap">
          <QrCode matrix={view.qr} />
          <p>Scan this code with Robinhood Wallet, then approve only the Robinhood Chain address connection.</p>
        </div>
      )}
      {operation.state === "awaiting_confirmation" ? (
        <div className="warning">
          <strong>Confirmation required</strong>
          <p>{walletOperationConfirmationMessage(operation.kind)}</p>
        </div>
      ) : null}
      {operation.failure === null ? null : <p className="error">{operation.failure.error.message}</p>}
      <div className="actions">
        <button
          type="button"
          disabled={requestPending || view.access !== "interactive" ||
            !isWalletOperationConfirmableState(operation.state)}
          onClick={() => { void control("POST"); }}
        >
          Confirm
        </button>
        <button
          type="button"
          className="secondary"
          disabled={requestPending || view.access !== "interactive" ||
            !isWalletOperationCancellableState(operation.state)}
          onClick={() => { void control("DELETE"); }}
        >
          Cancel
        </button>
      </div>
    </section>
  );
};
