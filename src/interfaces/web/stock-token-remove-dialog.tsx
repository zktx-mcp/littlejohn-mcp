import type { ReactNode } from "react";

import type {
  TokenCatalogOperation,
  TokenSelection,
} from "../../token-catalog/browser.js";
import type { DeliveryUnknown } from "../operation-delivery.js";
import { CopyableIdentifier } from "./copyable-identifier.js";
import { DialogShell } from "./dialog-shell.js";
import { LoadingIndicator } from "./loading-indicator.js";
import {
  stockTokenAccountObservationNotice,
  type StockTokenOperationTaskPresentation,
  type StockTokenTaskFailure,
} from "./stock-token-task-presentation.js";
import { tokenOperationCopy } from "./token-catalog-view.js";

export type StockTokenRemoveSubject = Readonly<{
  selection: TokenSelection;
  name: string;
}>;

export type StockTokenRemoveDialogPresentation =
  | Readonly<{
      status: "preparing";
      subject: StockTokenRemoveSubject;
    }>
  | Readonly<{
      status: "ready";
      subject: StockTokenRemoveSubject;
      operation: Extract<TokenCatalogOperation, { kind: "remove" }>;
      operationTask: StockTokenOperationTaskPresentation;
    }>
  | Readonly<{
      status: "removing";
      subject: StockTokenRemoveSubject;
    }>
  | Readonly<{
      status: "closing";
      subject: StockTokenRemoveSubject;
    }>
  | Readonly<{
      status: "delivery_unknown";
      subject: StockTokenRemoveSubject;
      delivery: DeliveryUnknown;
    }>
  | Readonly<{
      status: "terminal";
      subject: StockTokenRemoveSubject;
      operation: Extract<TokenCatalogOperation, { kind: "remove" }>;
    }>
  | Readonly<{
      status: "error";
      subject: StockTokenRemoveSubject;
      failure: StockTokenTaskFailure;
    }>;

export interface StockTokenRemoveDialogProps {
  readonly presentation: StockTokenRemoveDialogPresentation;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
  readonly onRetry: () => void;
}

export const StockTokenRemoveDialog = ({
  presentation,
  onClose,
  onConfirm,
  onRetry,
}: StockTokenRemoveDialogProps) => {
  const { subject } = presentation;
  const active =
    presentation.status === "preparing" ||
    presentation.status === "removing" ||
    presentation.status === "closing";
  const dismissible = presentation.status === "ready"
    ? presentation.operationTask.actions.includes("cancel")
    : presentation.status === "delivery_unknown"
      ? true
      : !active;
  let body: ReactNode;
  let footer: ReactNode;

  if (presentation.status === "preparing") {
    body = <LoadingIndicator label={`Preparing removal of ${subject.name}`} />;
  } else if (presentation.status === "ready") {
    const accountMessage = stockTokenAccountObservationNotice(
      presentation.operationTask.account,
    );
    body = (
      <div className="remove-stock-token-review">
        <p>Remove {subject.name} from Assets?</p>
        <p>
          This changes the local list for the connected account. It does not
          transfer or dispose of the token.
        </p>
        {accountMessage === undefined ? null : (
          <div className="warning">
            <strong>{accountMessage.heading}</strong>
            <p>{accountMessage.message}</p>
          </div>
        )}
      </div>
    );
    footer = (
      <div className="actions">
        {presentation.operationTask.actions.includes("cancel") ? (
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
        ) : null}
        {presentation.operationTask.actions.includes("confirm") ? (
          <button type="button" className="danger" onClick={onConfirm}>
            Remove
          </button>
        ) : null}
      </div>
    );
  } else if (presentation.status === "removing") {
    body = <LoadingIndicator label={`Removing ${subject.name}`} />;
  } else if (presentation.status === "closing") {
    body = <LoadingIndicator label={`Keeping ${subject.name}`} />;
  } else if (presentation.status === "delivery_unknown") {
    body = (
      <div className="warning" role="status">
        <strong>Removal status unknown</strong>
        <p>
          The request was sent, but its result was not received. Do not repeat
          the removal.
        </p>
        <CopyableIdentifier
          label="operation ID"
          value={presentation.delivery.operationId}
        />
      </div>
    );
    footer = (
      <div className="actions">
        <button type="button" className="secondary" onClick={onClose}>Close</button>
      </div>
    );
  } else if (presentation.status === "terminal") {
    const copy = tokenOperationCopy(presentation.operation);
    body = (
      <div className="dialog-state" role="status">
        <strong>{copy.heading}</strong>
        <p>{copy.message}</p>
      </div>
    );
    footer = (
      <div className="actions">
        <button type="button" className="secondary" onClick={onClose}>Close</button>
      </div>
    );
  } else {
    body = (
      <div className="dialog-state dialog-state-error" role="alert">
        <p>{presentation.failure.presentation.summary}</p>
        {presentation.failure.presentation.recovery === undefined ? null : (
          <p>{presentation.failure.presentation.recovery}</p>
        )}
      </div>
    );
    footer = (
      <div className="actions">
        <button type="button" className="secondary" onClick={onClose}>Close</button>
        {presentation.failure.presentation.retryable ? (
          <button type="button" onClick={onRetry}>Retry</button>
        ) : null}
      </div>
    );
  }

  return (
    <DialogShell
      titleId="stock-token-remove-title"
      title={`Remove ${subject.name}`}
      description="Stock Token"
      dismissible={dismissible}
      onClose={onClose}
      footer={footer}
      className="stock-token-dialog"
    >
      {body}
    </DialogShell>
  );
};
