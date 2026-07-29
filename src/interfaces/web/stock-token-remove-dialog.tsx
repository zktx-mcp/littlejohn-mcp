import type { ReactNode } from "react";

import type {
  TokenCatalogOperation,
  TokenSelection,
} from "../../token-catalog/browser.js";
import type { DeliveryUnknown } from "../operation-delivery.js";
import { CopyableIdentifier } from "./copyable-identifier.js";
import { DialogShell } from "./dialog-shell.js";
import { LoadingIndicator } from "./loading-indicator.js";
import type { StockTokenTaskFailure } from "./stock-token-task-presentation.js";

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
  const dismissible = !active;
  let body: ReactNode;
  let footer: ReactNode;

  if (presentation.status === "preparing") {
    body = <LoadingIndicator label={`Preparing removal of ${subject.name}`} />;
  } else if (presentation.status === "ready") {
    body = (
      <div className="remove-stock-token-review">
        <p>Remove {subject.name} from Assets?</p>
        <p>
          This changes the local list for the connected account. It does not
          transfer or dispose of the token.
        </p>
      </div>
    );
    footer = (
      <div className="actions">
        <button type="button" className="secondary" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="danger" onClick={onConfirm}>
          Remove
        </button>
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
