import { useEffect, useRef, useState, type ReactNode } from "react";

import type {
  AccountAssetCursor,
  AccountAssetCollectionSuccess,
  AccountAssetEvidenceField,
  AccountAssetExactSuccess,
  AccountAssetQuantityView,
  AccountAssetRowView,
} from "../../account-assets/browser.js";
import {
  accountAssetAnchorFields,
  assetIdentityWarnings,
  classificationEvidenceFields,
  classificationLabel,
  officialSnapshotFresh,
  officialSnapshotStatusText,
  projectAccountAssetCollectionView,
  projectAccountAssetExactView,
  tokenStandardDefinitionFor,
} from "../../account-assets/browser.js";
import type { TokenSelection } from "../../token-catalog/browser.js";
import { Icon } from "./icons.js";

export interface AccountAssetPageSnapshot {
  readonly result: AccountAssetCollectionSuccess;
  readonly cursor: AccountAssetCursor | null;
  readonly canGoBack: boolean;
}

export type AccountAssetExactReadPresentation =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "loading"; selection: TokenSelection }>
  | Readonly<{ status: "available"; selection: TokenSelection; result: AccountAssetExactSuccess }>
  | Readonly<{ status: "error"; selection: TokenSelection; message: string }>;

export interface AccountAssetPageProps {
  readonly snapshot: AccountAssetPageSnapshot | undefined;
  readonly loading: boolean;
  readonly staleMessage: string | undefined;
  readonly exactRead: AccountAssetExactReadPresentation;
  readonly mutationDisabled: boolean;
  readonly onRefresh: () => void;
  readonly onRetryExact: () => void;
  readonly onAdd: (trigger: HTMLButtonElement) => void;
  readonly onInfo: (selection: TokenSelection, trigger: HTMLButtonElement) => void;
  readonly onCloseInfo: () => void;
  readonly onRemove: (selection: TokenSelection, trigger: HTMLButtonElement) => void;
  readonly onPrevious: () => void;
  readonly onNext: () => void;
}

const quantityText = (quantity: AccountAssetQuantityView): Readonly<{
  primary: string;
  secondary: string;
}> => Object.freeze({
  primary: quantity.formattedAdjusted ?? quantity.formattedRaw ?? quantity.adjustedRaw ?? quantity.raw,
  secondary: quantity.adjustedRaw === null
    ? `Raw: ${quantity.raw}`
    : `Raw: ${quantity.raw} · UI-adjusted raw: ${quantity.adjustedRaw}`,
});

const AssetQuantity = ({ quantity }: { readonly quantity: AccountAssetQuantityView }) => {
  const text = quantityText(quantity);
  return (
    <div className="asset-quantity">
      <strong>{text.primary}</strong>
      <span>{text.secondary}</span>
    </div>
  );
};

const AssetDialog = ({
  labelledBy,
  onClose,
  className,
  children,
}: {
  readonly labelledBy: string;
  readonly onClose: () => void;
  readonly className?: string;
  readonly children: ReactNode;
}) => {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    element.showModal();
    element.focus();
    return () => { if (element.open) element.close(); };
  }, []);
  return (
    <dialog
      ref={dialog}
      className={`application-dialog asset-info-dialog${className === undefined ? "" : ` ${className}`}`}
      aria-labelledby={labelledBy}
      tabIndex={-1}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}
    >
      {children}
    </dialog>
  );
};

const TokenAssetRow = ({
  row,
  onInfo,
}: {
  readonly row: AccountAssetRowView;
  readonly onInfo: (selection: TokenSelection, trigger: HTMLButtonElement) => void;
}) => (
  <article className="asset-row">
    <div className="asset-identity">
      <span className="asset-badge">{classificationLabel(row.classification)}</span>
      <h2>{row.name ?? row.symbol ?? "ERC-20 token"}</h2>
      {row.symbol === null ? null : <p className="asset-symbol">{row.symbol}</p>}
      <p className="asset-address">{row.selection.asset.address}</p>
    </div>
    <AssetQuantity quantity={row.quantity} />
    <div className="asset-card-actions" aria-label="Asset actions">
      <button
        type="button"
        className="icon-button secondary"
        aria-label="Token details and actions"
        title="Token details and actions"
        onClick={(event) => { onInfo(row.selection, event.currentTarget); }}
      ><Icon name="more" /></button>
    </div>
  </article>
);

const EvidenceList = ({ fields }: { readonly fields: readonly AccountAssetEvidenceField[] }) => (
  <dl>{fields.flatMap((field) => [
    <dt key={`${field.label}:label`}>{field.label}</dt>,
    <dd key={`${field.label}:value`}>{field.value}</dd>,
  ])}</dl>
);

const TokenDetailsAndActions = ({
  read,
  mutationDisabled,
  onClose,
  onRetry,
  onRemove,
}: {
  readonly read: Exclude<AccountAssetExactReadPresentation, { status: "idle" }>;
  readonly mutationDisabled: boolean;
  readonly onClose: () => void;
  readonly onRetry: () => void;
  readonly onRemove: (selection: TokenSelection, trigger: HTMLButtonElement) => void;
}) => {
  const row = read.status === "available" ? projectAccountAssetExactView(read.result) : undefined;
  const identityWarnings = row === undefined ? [] : assetIdentityWarnings(row);
  const rawBalanceLine = row === undefined
    ? undefined
    : `${row.quantity.formattedRaw ?? "—"} / ${row.quantity.raw}`;
  const uiAdjustedLine = row === undefined
    ? undefined
    : row.quantity.adjustmentStatus === "available"
      ? `${row.quantity.formattedAdjusted ?? "—"} / ${row.quantity.adjustedRaw ?? "—"}`
      : row.quantity.adjustmentStatus === "result_out_of_range"
        ? "Out of range"
        : "Not established";
  const [tooltip, setTooltip] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const shownStandards = read.status === "available"
    ? read.result.standards.standards.filter(
        (standard) => standard.status !== "not_supported" && standard.status !== "unknown",
      )
    : [];
  const activeStandard = tooltip === null
    ? undefined
    : shownStandards.find((standard) => standard.standardId === tooltip);
  return (
    <AssetDialog labelledBy="asset-info-title" onClose={onClose} className="detail-dialog-host">
      <div
        className="detail-dialog"
        onMouseDown={(event) => {
          if ((event.target as Element).closest(".standard-badge") === null) {
            setTooltip(null);
          }
        }}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          if (tooltip === null) onClose();
          else setTooltip(null);
        }}
      >
        <div className="detail-dialog-head">
        <header>
          <p className="eyebrow">{row === undefined ? "Account token" : classificationLabel(row.classification)}</p>
          <h1 id="asset-info-title">{row?.name ?? row?.symbol ?? "Token details and actions"}</h1>
          {shownStandards.length === 0 ? null : (
            <div className="standard-badges">
              {shownStandards.map((standard) => {
                const definition = tokenStandardDefinitionFor(standard.standardId);
                const isOpen = tooltip === standard.standardId;
                return (
                  <button
                    key={standard.standardId}
                    type="button"
                    className={`standard-badge${standard.status === "inconsistent" ? " inconsistent" : ""}${isOpen ? " active" : ""}`}
                    aria-label={`About ${definition.displayName}`}
                    aria-expanded={isOpen}
                    onClick={() => { setTooltip(isOpen ? null : standard.standardId); }}
                    onKeyDown={(event) => { if (event.key === "Escape") setTooltip(null); }}
                  >{definition.displayName}</button>
                );
              })}
            </div>
          )}
          {activeStandard === undefined ? null : (
            <p role="tooltip" className="standard-explanation">
              {tokenStandardDefinitionFor(activeStandard.standardId).explanation}
            </p>
          )}
          <p className="asset-address">{read.selection.asset.address}</p>
        </header>
        {identityWarnings.length === 0 ? null : (
          <div className="warning" role="status">
            <strong>Identity evidence withheld</strong>
            {identityWarnings.map((message) => <p key={message}>{message}</p>)}
          </div>
        )}
        {read.status === "loading" ? (
          <div className="notice" role="status"><strong>Reading token information</strong></div>
        ) : read.status === "error" ? (
          <div className="warning" role="status">
            <strong>Token information unavailable</strong>
            <p>{read.message}</p>
            <button type="button" className="secondary" onClick={onRetry}>Retry</button>
          </div>
        ) : (
          <>
            <dl className="balance-list">
              <dt>Formatted / raw balance</dt><dd>{rawBalanceLine}</dd>
              <dt>UI-adjusted / raw balance</dt><dd>{uiAdjustedLine}</dd>
              <dt>Raw total supply</dt><dd>{read.result.totalSupply}</dd>
            </dl>
            <button
              type="button"
              className="disclosure"
              aria-expanded={showDetails}
              onClick={() => { setShowDetails((visible) => !visible); }}
            >
              <span>Evidence</span>
              <span className={`disclosure-chevron${showDetails ? " open" : ""}`} aria-hidden="true">
                <Icon name="chevron-right" />
              </span>
            </button>
          </>
        )}
        </div>
        {read.status !== "available" || !showDetails ? null : (
          <div className="detail-panel">
            <section aria-label="Asset evidence">
              <p className="evidence-caption">
                Classification · {classificationLabel(read.result.asset.classification)}
              </p>
              <EvidenceList fields={classificationEvidenceFields(read.result.asset.classification)} />
              <p className="evidence-caption">Chain anchor</p>
              <EvidenceList fields={accountAssetAnchorFields(read.result.block)} />
            </section>
          </div>
        )}
        <div className="actions detail-dialog-actions">
          <button
            type="button"
            className="danger with-icon"
            disabled={mutationDisabled}
            onClick={(event) => { onRemove(read.selection, event.currentTarget); }}
          ><Icon name="trash" />Remove token</button>
          <button type="button" className="secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </AssetDialog>
  );
};

export const AccountAssetsPage = ({
  snapshot,
  loading,
  staleMessage,
  exactRead,
  mutationDisabled,
  onRefresh,
  onRetryExact,
  onAdd,
  onInfo,
  onCloseInfo,
  onRemove,
  onPrevious,
  onNext,
}: AccountAssetPageProps) => {
  const page = snapshot === undefined ? undefined : projectAccountAssetCollectionView(snapshot.result);
  const [nativeInfo, setNativeInfo] = useState(false);
  const nativeInfoTrigger = useRef<HTMLButtonElement>(null);
  const closeNativeInfo = (): void => {
    setNativeInfo(false);
    window.setTimeout(() => { nativeInfoTrigger.current?.focus(); }, 0);
  };
  return (
    <main className="asset-page">
      <header className="asset-page-header">
        <div>
          <p className="eyebrow">Account assets</p>
          <h1>Your assets</h1>
          {page === undefined ? null : (
            <p className="account-line">{page.account.chainId} / {page.account.address}</p>
          )}
          {page === undefined ? null : (
            <p className="evidence-anchor">
              <span>As of block {page.block.blockNumber}</span>
              <span className={`data-status${officialSnapshotFresh(page.viewRevision) ? "" : " stale"}`}>
                {officialSnapshotStatusText(page.viewRevision)}
              </span>
            </p>
          )}
        </div>
        <div className="actions asset-page-actions">
          <button
            type="button"
            className="icon-button secondary"
            aria-label="Refresh assets"
            title="Refresh assets"
            disabled={loading}
            onClick={onRefresh}
          ><Icon name="refresh" /></button>
          <button
            type="button"
            className="icon-button"
            aria-label="Add token"
            title="Add token"
            disabled={mutationDisabled || snapshot?.result.viewRevision.officialSnapshotStatus !== "current"}
            onClick={(event) => { onAdd(event.currentTarget); }}
          ><Icon name="plus" /></button>
        </div>
      </header>
      {staleMessage === undefined ? null : (
        <div className="warning" role="status">
          <strong>Latest assets unavailable</strong>
          <p>{staleMessage}</p>
        </div>
      )}
      {page === undefined ? (
        <div className="empty-state">
          <h2>{loading ? "Reading assets…" : "Assets unavailable"}</h2>
          <p>{loading
            ? "Little John is synchronizing official assets and reading current balances."
            : "Retry the asset read without reconnecting your wallet."}</p>
        </div>
      ) : (
        <>
          <section className="asset-list" aria-label="Account asset balances">
            <article className="asset-row native-asset">
              <div className="asset-identity">
                <span className="asset-badge">Native</span>
                <h2>Robinhood Chain native asset</h2>
                <p className="asset-symbol">ETH</p>
              </div>
              <AssetQuantity quantity={page.native} />
              <div className="asset-card-actions" aria-label="Asset actions">
                <button
                  type="button"
                  className="icon-button secondary"
                  aria-label="Native asset details"
                  title="Native asset details"
                  ref={nativeInfoTrigger}
                  onClick={() => { setNativeInfo(true); }}
                ><Icon name="more" /></button>
              </div>
            </article>
            {page.assets.map((row) => (
              <TokenAssetRow
                key={row.selection.asset.address}
                row={row}
                onInfo={onInfo}
              />
            ))}
          </section>
          {page.assets.length === 0 ? (
            <div className="empty-state compact-empty-state">
              <h2>No included tokens</h2>
              <p>Add an official Stock Token or a custom ERC-20 contract for this account.</p>
            </div>
          ) : null}
          <footer className="asset-pagination">
            <button
              type="button"
              className="icon-button secondary"
              aria-label="Previous asset page"
              title="Previous asset page"
              disabled={snapshot?.canGoBack !== true || loading}
              onClick={onPrevious}
            ><Icon name="chevron-left" /></button>
            <p>Block {page.block.blockNumber}</p>
            <button
              type="button"
              className="icon-button secondary"
              aria-label="Next asset page"
              title="Next asset page"
              disabled={page.nextCursor === null || loading}
              onClick={onNext}
            ><Icon name="chevron-right" /></button>
          </footer>
        </>
      )}
      {exactRead.status === "idle" ? null : (
        <TokenDetailsAndActions
          read={exactRead}
          mutationDisabled={mutationDisabled}
          onClose={onCloseInfo}
          onRetry={onRetryExact}
          onRemove={onRemove}
        />
      )}
      {!nativeInfo ? null : (
        <AssetDialog labelledBy="native-info-title" onClose={closeNativeInfo}>
          <div>
            <header><p className="eyebrow">Native</p><h1 id="native-info-title">Robinhood Chain native asset</h1></header>
            <p>This is the chain&apos;s native asset. It is always shown and is not an ERC-20 account selection.</p>
            <div className="actions"><button type="button" className="secondary" onClick={closeNativeInfo}>Close</button></div>
          </div>
        </AssetDialog>
      )}
    </main>
  );
};
