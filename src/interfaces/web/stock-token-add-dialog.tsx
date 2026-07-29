import {
  useRef,
  useState,
} from "react";

import {
  filterAccountAssetOfficialCandidates,
} from "../../account-assets/browser.js";
import type { OfficialAssetCandidate } from "../../registry/browser.js";
import type { DeliveryUnknown } from "../operation-delivery.js";
import { CopyableIdentifier } from "./copyable-identifier.js";
import { DialogShell } from "./dialog-shell.js";
import { Icon } from "./icons.js";
import { LoadingIndicator } from "./loading-indicator.js";
import type {
  StockTokenTaskFailure,
} from "./stock-token-task-presentation.js";

export type OfficialStockTokenCandidate = OfficialAssetCandidate;

export type StockTokenAddStatus =
  | Readonly<{ status: "idle" }>
  | Readonly<{
      status: "adding";
      candidate: OfficialStockTokenCandidate;
    }>
  | Readonly<{
      status: "delivery_unknown";
      candidate: OfficialStockTokenCandidate;
      delivery: DeliveryUnknown;
    }>
  | Readonly<{
      status: "error";
      candidate: OfficialStockTokenCandidate | null;
      failure: StockTokenTaskFailure;
    }>;

export type StockTokenAddDialogPresentation = Readonly<{
  candidates: readonly OfficialStockTokenCandidate[];
  addStatus: StockTokenAddStatus;
  inputsLocked: boolean;
  dismissible: boolean;
}>;

export interface StockTokenAddDialogProps {
  readonly presentation: StockTokenAddDialogPresentation;
  readonly onClose: () => void;
  readonly onAdd: (candidate: OfficialStockTokenCandidate) => void;
  readonly onRetry: () => void;
}

const candidateName = (candidate: OfficialStockTokenCandidate): string =>
  candidate.sourceName ?? candidate.sourceSymbol ?? "Stock Token";

const CandidateRegion = ({
  candidates,
  draft,
  searchInput,
  locked,
  onDraftChange,
  onAdd,
}: Readonly<{
  candidates: readonly OfficialStockTokenCandidate[];
  draft: string;
  searchInput: React.RefObject<HTMLInputElement | null>;
  locked: boolean;
  onDraftChange: (value: string) => void;
  onAdd: (candidate: OfficialStockTokenCandidate) => void;
}>) => {
  let visibleCandidates: readonly OfficialStockTokenCandidate[] = [];
  let validation: string | undefined;
  try {
    visibleCandidates = filterAccountAssetOfficialCandidates(
      candidates,
      draft,
    );
  } catch {
    validation = "Enter no more than 128 characters or 512 UTF-8 bytes.";
  }

  return (
    <div className="stock-token-candidate-picker">
      <div className="stock-token-search">
        <label htmlFor="stock-token-search-input">Search</label>
        <div className={`stock-token-search-control${draft === "" ? "" : " has-clear"}`}>
          <input
            id="stock-token-search-input"
            ref={searchInput}
            type="text"
            value={draft}
            disabled={locked}
            aria-invalid={validation === undefined ? undefined : true}
            aria-describedby={validation === undefined
              ? undefined
              : "stock-token-search-error"}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => { onDraftChange(event.currentTarget.value); }}
          />
          <span className="stock-token-search-icon">
            <Icon name="search" />
          </span>
          {draft === "" ? null : (
            <button
              type="button"
              className="icon-button unfilled stock-token-search-clear"
              aria-label="Clear Stock Token search"
              title="Clear Stock Token search"
              disabled={locked}
              onClick={() => {
                onDraftChange("");
                searchInput.current?.focus();
              }}
            >
              <Icon name="close" />
            </button>
          )}
        </div>
      </div>
      <div className="stock-token-candidate-results">
        {validation !== undefined ? (
          <p id="stock-token-search-error" className="error" role="alert">
            {validation}
          </p>
        ) : visibleCandidates.length === 0 ? (
          <p className="dialog-empty-state">
            No unselected Stock Token matches this search.
          </p>
        ) : (
          <ul
            className="stock-token-candidates"
            aria-label="Stock Tokens available to add"
          >
            {visibleCandidates.map((candidate) => (
              <li
                key={candidate.assetUid}
                className="stock-token-candidate-row"
              >
                <span className="stock-token-candidate-copy">
                  <strong>{candidateName(candidate)}</strong>
                  {candidate.sourceSymbol === null ? null : (
                    <span>{candidate.sourceSymbol}</span>
                  )}
                </span>
                <button
                  type="button"
                  className="icon-button unfilled"
                  disabled={locked}
                  aria-label={`Add ${candidateName(candidate)}`}
                  title={`Add ${candidateName(candidate)}`}
                  onClick={() => { onAdd(candidate); }}
                >
                  <Icon name="plus" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

const AddStatus = ({
  presentation,
  onRetry,
}: {
  readonly presentation: StockTokenAddStatus;
  readonly onRetry: () => void;
}) => {
  if (presentation.status === "idle") return null;
  if (presentation.status === "adding") {
    return (
      <div className="stock-token-add-status">
        <LoadingIndicator
          label={`Adding ${candidateName(presentation.candidate)}`}
        />
      </div>
    );
  }
  if (presentation.status === "delivery_unknown") {
    return (
      <div className="warning" role="status">
        <strong>Addition status unknown</strong>
        <p>
          The request was sent, but its result was not received. Do not repeat
          the addition.
        </p>
        <CopyableIdentifier
          label="operation ID"
          value={presentation.delivery.operationId}
        />
      </div>
    );
  }
  return (
    <div className="dialog-state dialog-state-error" role="alert">
      <p>{presentation.failure.presentation.summary}</p>
      {presentation.failure.presentation.recovery === undefined ? null : (
        <p>{presentation.failure.presentation.recovery}</p>
      )}
      {presentation.failure.presentation.retryable ? (
        <button type="button" className="secondary" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
};

export const StockTokenAddDialog = ({
  presentation,
  onClose,
  onAdd,
  onRetry,
}: StockTokenAddDialogProps) => {
  const [draft, setDraft] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);

  return (
    <DialogShell
      titleId="stock-token-add-title"
      title="Add Stock Token"
      description="Search the official Stock Token list and add one token to Assets."
      dismissible={presentation.dismissible}
      onClose={onClose}
      footer={(
        <div className="actions">
          <button
            type="button"
            className="secondary"
            disabled={!presentation.dismissible}
            onClick={onClose}
          >
            Close
          </button>
        </div>
      )}
      className="stock-token-dialog stock-token-add-dialog"
    >
      <div className="stock-token-add-layout">
        <CandidateRegion
          candidates={presentation.candidates}
          draft={draft}
          searchInput={searchInput}
          locked={presentation.inputsLocked}
          onDraftChange={setDraft}
          onAdd={onAdd}
        />
        <AddStatus presentation={presentation.addStatus} onRetry={onRetry} />
      </div>
    </DialogShell>
  );
};
