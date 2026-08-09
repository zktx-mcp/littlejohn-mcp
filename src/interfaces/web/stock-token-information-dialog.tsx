import type { ReactNode } from "react";

import {
  projectAccountAssetExactView,
  type AccountAssetExactSuccess,
} from "../../account-assets/browser.js";
import type { TokenSelection } from "../../token-catalog/browser.js";
import {
  TokenControlSummary,
  createAnalysisTarget,
} from "./analysis-dialog.js";
import type { BrowserFetch } from "./browser-client.js";
import { CopyableIdentifier } from "./copyable-identifier.js";
import { DialogShell } from "./dialog-shell.js";
import {
  humanFailureText,
  type HumanFailurePresentation,
} from "./human-failures.js";
import { LoadingIndicator } from "./loading-indicator.js";

export type StockTokenInformationDialogPresentation =
  | Readonly<{ status: "loading"; selection: TokenSelection }>
  | Readonly<{
      status: "error";
      selection: TokenSelection;
      failure: HumanFailurePresentation;
    }>
  | Readonly<{
      status: "classification_mismatch";
      selection: TokenSelection;
      message: string;
    }>
  | Readonly<{
      status: "available";
      result: AccountAssetExactSuccess;
    }>;

export interface StockTokenInformationDialogProps {
  readonly presentation: StockTokenInformationDialogPresentation;
  readonly onClose: () => void;
  readonly onRemove: () => void;
  readonly onRetry: () => void;
  readonly recoverSession: (error: unknown) => boolean;
  readonly request?: BrowserFetch;
}

export const StockTokenInformationDialog = ({
  presentation,
  onClose,
  onRemove,
  onRetry,
  recoverSession,
  request,
}: StockTokenInformationDialogProps) => {
  const result = "result" in presentation ? presentation.result : undefined;
  const row = result === undefined ? undefined : projectAccountAssetExactView(result);
  const dismissible = presentation.status !== "loading";

  let body: ReactNode;
  let footer: ReactNode;
  if (presentation.status === "loading") {
    body = <LoadingIndicator label="Loading token details" />;
  } else if (presentation.status === "error") {
    body = (
      <div className="dialog-state dialog-state-error" role="alert">
        <p>{humanFailureText(presentation.failure)}</p>
      </div>
    );
    footer = (
      <div className="actions">
        <button type="button" className="secondary" onClick={onClose}>Close</button>
        {presentation.failure.retryable ? (
          <button type="button" onClick={onRetry}>Retry</button>
        ) : null}
      </div>
    );
  } else if (presentation.status === "classification_mismatch") {
    body = (
      <div className="dialog-state dialog-state-error" role="alert">
        <p>{presentation.message}</p>
      </div>
    );
    footer = (
      <div className="actions">
        <button type="button" className="secondary" onClick={onClose}>Close</button>
      </div>
    );
  } else {
    body = (
      <div className="stock-token-information-content">
        <section
          className="token-analysis-summary"
          aria-labelledby="stock-token-facts-heading"
        >
          <h2 id="stock-token-facts-heading">Token facts</h2>
          <dl className="analysis-control-grid">
            <dt>Name</dt>
            <dd>{row?.identity.name ?? "Unavailable"}</dd>
            <dt>Symbol</dt>
            <dd>{row?.identity.symbol ?? "Unavailable"}</dd>
            <dt>Decimals</dt>
            <dd>{row?.quantity.decimals ?? "Unavailable"}</dd>
          </dl>
          {row?.identity.warnings.map((warning) => (
            <p className="limitation" role="status" key={warning}>{warning}</p>
          ))}
        </section>
        <section
          className="analysis-target"
          aria-labelledby="stock-token-target-heading"
        >
          <h2 id="stock-token-target-heading">Originating token target</h2>
          <CopyableIdentifier
            label="token contract address"
            value={presentation.result.asset.selection.asset.address}
          />
        </section>
        <TokenControlSummary
          target={createAnalysisTarget({
            kind: "token",
            address: presentation.result.asset.selection.asset.address,
            blockNumber: presentation.result.block.blockNumber,
            expectedBlockHash: presentation.result.block.blockHash,
          })}
          recoverSession={recoverSession}
          {...(request === undefined ? {} : { request })}
        />
      </div>
    );
    footer = (
      <div className="actions">
        <button type="button" className="secondary" onClick={onClose}>Close</button>
        <button type="button" className="danger" onClick={onRemove}>
          Remove
        </button>
      </div>
    );
  }

  return (
    <DialogShell
      titleId="stock-token-information-title"
      title="Token information"
      dismissible={dismissible}
      onClose={onClose}
      footer={footer}
      className="stock-token-dialog"
    >
      {body}
    </DialogShell>
  );
};
