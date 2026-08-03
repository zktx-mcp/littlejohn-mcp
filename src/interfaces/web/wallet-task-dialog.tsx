import type { ReactNode } from "react";

import type {
  WalletCurrentOperationProjection,
  WalletOperationPresentation,
  WalletQrMatrix,
} from "../../wallet/operation-contract.js";
import { CopyableIdentifier } from "./copyable-identifier.js";
import { DialogShell } from "./dialog-shell.js";
import type {
  WalletActionFailure,
  WalletDelivery,
  WalletProcessAction,
} from "./wallet-process.js";
import {
  humanFailureText,
} from "./human-failures.js";
import { LoadingIndicator } from "./loading-indicator.js";
import {
  walletConnectionFields,
  walletOperationActions,
  walletOperationConfirmationMessage,
  walletOperationCopy,
  walletOperationNotice,
} from "./wallet-dialog-view.js";

export type WalletModalTaskKind = "wallet_connect" | "wallet_disconnect";

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

const WalletFields = ({
  wallet,
}: {
  readonly wallet: WalletCurrentOperationProjection | undefined;
}) => {
  if (wallet === undefined) return null;
  const fields = walletConnectionFields(wallet.connection);
  return fields.length === 0 ? null : (
    <dl>{fields.flatMap((field) => [
      <dt key={`${field.label}:label`}>{field.label}</dt>,
      <dd key={`${field.label}:value`}>
        {field.valueKind === "identifier"
          ? <CopyableIdentifier label={field.label} value={field.value} />
          : field.value}
      </dd>,
    ])}</dl>
  );
};

const OperationDetails = ({
  presentation,
}: {
  readonly presentation: WalletOperationPresentation;
}) => {
  const notice = walletOperationNotice(presentation);
  return (
    <>
      {presentation.qr === undefined ? null : (
        <div className="qr-wrap"><QrCode matrix={presentation.qr} /></div>
      )}
      {notice === undefined ? null : (
        <div className="notice">
          <strong>Read-only view</strong>
          <p>{notice}</p>
        </div>
      )}
      {presentation.operation.state === "awaiting_confirmation" ? (
        <div className="warning">
          <strong>Confirmation required</strong>
          <p>{walletOperationConfirmationMessage(presentation.operation)}</p>
        </div>
      ) : null}
    </>
  );
};

export const WalletTaskDialog = ({
  task,
  connectionRevision,
  operationId,
  wallet,
  operationPresentation,
  pending,
  pendingAction,
  pendingOperationId,
  delivery,
  actionFailure,
  onClose,
  onAction,
}: Readonly<{
  task: WalletModalTaskKind;
  connectionRevision: string;
  operationId: string;
  wallet: WalletCurrentOperationProjection | undefined;
  operationPresentation: WalletOperationPresentation | undefined;
  pending: boolean;
  pendingAction: WalletProcessAction | undefined;
  pendingOperationId: string | undefined;
  delivery: WalletDelivery | undefined;
  actionFailure: WalletActionFailure | undefined;
  onClose: () => void;
  onAction: (action: WalletProcessAction) => void;
}>) => {
  const operationKind = task === "wallet_connect" ? "connect" : "disconnect";
  const title = operationKind === "connect" ? "Connect wallet" : "Disconnect wallet";
  const matchingPresentation =
    operationPresentation?.operation.kind === operationKind &&
    operationPresentation.operation.connectionRevision === connectionRevision &&
    operationPresentation.operation.operationId === operationId
      ? operationPresentation
      : undefined;
  const actions = matchingPresentation === undefined
    ? []
    : walletOperationActions(matchingPresentation);
  const matchingDelivery =
    delivery?.task === operationKind &&
    delivery.connectionRevision === connectionRevision &&
    delivery.result.operationId === operationId
      ? delivery
      : undefined;
  const cancelling = actions.includes("cancel");
  const terminal = matchingPresentation !== undefined &&
    actions.length === 0 &&
    (
      matchingPresentation.operation.state === "completed" ||
      matchingPresentation.operation.state === "cancelled" ||
      matchingPresentation.operation.state === "rejected" ||
      matchingPresentation.operation.state === "failed" ||
      matchingPresentation.operation.state === "expired"
    );
  const failure = actionFailure !== undefined &&
    actionFailure.connectionRevision === connectionRevision &&
    actionFailure.operationId === operationId &&
    (
      actionFailure.action === operationKind ||
      matchingPresentation !== undefined
    )
      ? actionFailure.failure
      : undefined;
  const matchingPending = pending && pendingOperationId === operationId;
  const completedWithoutPresentation =
    matchingPresentation === undefined &&
    !pending &&
    failure === undefined &&
    (
      operationKind === "connect"
        ? wallet?.connection.status === "connected"
        : wallet?.connection.status === "disconnected"
    );

  let body: ReactNode;
  if (matchingDelivery !== undefined) {
    body = (
      <div className="warning" role="status">
        <strong>{operationKind === "connect"
          ? "Connection status unknown"
          : "Disconnection status unknown"}</strong>
        <p>
          The request was sent, but its result was not received. Do not repeat
          this action.
        </p>
        <CopyableIdentifier
          label="operation ID"
          value={matchingDelivery.result.operationId}
        />
      </div>
    );
  } else if (failure !== undefined) {
    body = (
      <div className="dialog-state dialog-state-error" role="alert">
        <p>{humanFailureText(failure)}</p>
      </div>
    );
  } else if (matchingPresentation !== undefined) {
    const copy = walletOperationCopy(matchingPresentation.operation);
    body = (
      <>
        <p className="dialog-task-status">{copy.message}</p>
        <OperationDetails presentation={matchingPresentation} />
      </>
    );
  } else if (completedWithoutPresentation) {
    body = (
      <>
        <p>{operationKind === "connect"
          ? "The Robinhood Chain wallet session is ready."
          : "No wallet session remains in this local profile."}</p>
        <WalletFields wallet={wallet} />
      </>
    );
  } else {
    body = (
      <LoadingIndicator
        label={operationKind === "connect"
          ? "Starting wallet connection"
          : "Preparing wallet disconnection"}
      />
    );
  }

  const activeWithoutChoice =
    matchingDelivery === undefined &&
    failure === undefined &&
    !terminal &&
    !completedWithoutPresentation &&
    (
      matchingPending ||
      (pendingAction !== undefined && matchingPending) ||
      matchingPresentation === undefined ||
      actions.length === 0
    );
  const dismissible =
    matchingDelivery !== undefined ||
    failure !== undefined ||
    terminal ||
    completedWithoutPresentation ||
    (!pending && cancelling);
  const close = (): void => {
    if (cancelling && !matchingPending) {
      onAction("cancel");
    } else {
      onClose();
    }
  };

  return (
    <DialogShell
      titleId={`${task}-title`}
      title={title}
      description={operationKind === "connect"
        ? "Connect Robinhood Wallet to this local profile."
        : "Remove every wallet session from this local profile."}
      dismissible={dismissible}
      onClose={close}
      footer={(
        <div className="actions">
          {activeWithoutChoice ? (
            <button type="button" className="secondary" disabled>Close</button>
          ) : cancelling ? (
            <button
              type="button"
              className="secondary"
              disabled={matchingPending}
              onClick={() => { onAction("cancel"); }}
            >
              {operationKind === "connect" ? "Cancel connection" : "Keep connected"}
            </button>
          ) : (
            <button type="button" className="secondary" onClick={onClose}>Close</button>
          )}
          {failure?.retryable === true && actionFailure !== undefined ? (
            <button
              type="button"
              disabled={matchingPending}
              onClick={() => { onAction(actionFailure.action); }}
            >
              Retry
            </button>
          ) : null}
          {actions.includes("confirm") ? (
            <button
              type="button"
              className="danger"
              disabled={matchingPending}
              onClick={() => { onAction("confirm"); }}
            >
              Disconnect
            </button>
          ) : null}
        </div>
      )}
    >
      {body}
    </DialogShell>
  );
};
