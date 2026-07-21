import { useEffect, useRef, useState, type ReactNode } from "react";

import type {
  AccountAssetCursor,
  AccountAssetCollectionSuccess,
  AccountAssetExactSuccess,
  AccountAssetQuantityView,
  AccountAssetRowView,
} from "../../account-assets/browser.js";
import {
  projectAccountAssetCollectionView,
  projectAccountAssetExactView,
  tokenStandardDefinitionFor,
} from "../../account-assets/browser.js";
import type { TokenSelection } from "../../token-catalog/browser.js";

export interface AccountAssetPageSnapshot {
  readonly result: AccountAssetCollectionSuccess;
  readonly cursor: AccountAssetCursor | null;
  readonly canGoBack: boolean;
}

export interface AccountAssetPageProps {
  readonly snapshot: AccountAssetPageSnapshot | undefined;
  readonly exact: AccountAssetExactSuccess | undefined;
  readonly loading: boolean;
  readonly staleMessage: string | undefined;
  readonly exactRead: Readonly<{
    status: "idle" | "loading" | "error";
    message?: string;
  }>;
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
  children,
}: {
  readonly labelledBy: string;
  readonly onClose: () => void;
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
      className="application-dialog asset-info-dialog"
      aria-labelledby={labelledBy}
      tabIndex={-1}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}
    >
      {children}
    </dialog>
  );
};

const classificationLabel = (row: AccountAssetRowView): string => {
  switch (row.classification.kind) {
    case "robinhood_stock_token": return "Robinhood Stock Token";
    case "custom_erc20": return "Custom ERC-20";
    case "classification_unavailable": return "Classification unavailable";
  }
};

const TokenAssetRow = ({
  row,
  disabled,
  onInfo,
  onRemove,
}: {
  readonly row: AccountAssetRowView;
  readonly disabled: boolean;
  readonly onInfo: (selection: TokenSelection, trigger: HTMLButtonElement) => void;
  readonly onRemove: (selection: TokenSelection, trigger: HTMLButtonElement) => void;
}) => (
  <article className="asset-row">
    <div className="asset-identity">
      <span className="asset-badge">{classificationLabel(row)}</span>
      <h2>{row.name ?? row.symbol ?? "ERC-20 token"}</h2>
      {row.symbol === null ? null : <p className="asset-symbol">{row.symbol}</p>}
      <p className="asset-address">{row.selection.asset.address}</p>
    </div>
    <AssetQuantity quantity={row.quantity} />
    <div className="asset-card-actions" aria-label="Asset actions">
      <button
        type="button"
        className="icon-button secondary"
        aria-label="View token information"
        title="View token information"
        onClick={(event) => { onInfo(row.selection, event.currentTarget); }}
      >ⓘ</button>
      <button
        type="button"
        className="icon-button danger"
        aria-label="Remove token from this account"
        title="Remove token from this account"
        disabled={disabled}
        onClick={(event) => { onRemove(row.selection, event.currentTarget); }}
      >−</button>
    </div>
  </article>
);

const TokenInformation = ({
  result,
  onClose,
}: {
  readonly result: AccountAssetExactSuccess;
  readonly onClose: () => void;
}) => {
  const row = projectAccountAssetExactView(result);
  const [tooltip, setTooltip] = useState<string | null>(null);
  return (
    <AssetDialog labelledBy="asset-info-title" onClose={onClose}>
      <div
        onMouseDown={(event) => {
          if ((event.target as Element).closest(".standard-list button") === null) {
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
        <header>
          <p className="eyebrow">{classificationLabel(row)}</p>
          <h1 id="asset-info-title">{row.name ?? row.symbol ?? "Token information"}</h1>
          <p className="asset-address">{row.selection.asset.address}</p>
        </header>
        <dl>
          <dt>Raw balance</dt><dd>{row.quantity.raw}</dd>
          <dt>Formatted raw balance</dt><dd>{row.quantity.formattedRaw ?? "Decimals unavailable"}</dd>
          <dt>UI-adjusted raw balance</dt><dd>{row.quantity.adjustedRaw ?? "Not established"}</dd>
          <dt>UI-adjusted balance</dt><dd>{row.quantity.formattedAdjusted ?? "Not established"}</dd>
          <dt>Raw total supply</dt><dd>{result.totalSupply}</dd>
          <dt>Block</dt><dd>{result.block.blockNumber}</dd>
        </dl>
        <section aria-labelledby="token-standards-heading">
          <h2 id="token-standards-heading">Token standards</h2>
          <ul className="standard-list">
            {result.standards.standards.map((standard) => {
              const definition = tokenStandardDefinitionFor(standard.standardId);
              const tooltipOpen = tooltip === standard.standardId;
              return (
                <li key={standard.standardId}>
                  <span>{definition.displayName}</span>
                  <strong>{standard.status.replaceAll("_", " ")}</strong>
                  <button
                    type="button"
                    className="icon-button secondary"
                    aria-label={`About ${definition.displayName}`}
                    aria-expanded={tooltipOpen}
                    onBlur={() => { setTooltip(null); }}
                    onClick={() => { setTooltip(tooltipOpen ? null : standard.standardId); }}
                    onKeyDown={(event) => { if (event.key === "Escape") setTooltip(null); }}
                  >?</button>
                  {tooltipOpen ? <p role="tooltip">{definition.explanation}</p> : null}
                </li>
              );
            })}
          </ul>
        </section>
        <div className="actions">
          <button type="button" className="secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </AssetDialog>
  );
};

export const AccountAssetsPage = ({
  snapshot,
  exact,
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
        </div>
        <div className="actions asset-page-actions">
          <button
            type="button"
            className="icon-button secondary"
            aria-label="Refresh assets"
            title="Refresh assets"
            disabled={loading}
            onClick={onRefresh}
          >↻</button>
          <button
            type="button"
            className="icon-button"
            aria-label="Add token"
            title="Add token"
            disabled={mutationDisabled || snapshot?.result.viewRevision.officialSnapshotStatus !== "current"}
            onClick={(event) => { onAdd(event.currentTarget); }}
          >+</button>
        </div>
      </header>
      {staleMessage === undefined ? null : (
        <div className="warning" role="status">
          <strong>Latest assets unavailable</strong>
          <p>{staleMessage}</p>
        </div>
      )}
      {exactRead.status === "loading" ? (
        <div className="notice" role="status"><strong>Reading token information</strong></div>
      ) : exactRead.status === "error" ? (
        <div className="warning" role="status">
          <strong>Token information unavailable</strong>
          <p>{exactRead.message}</p>
          <button type="button" className="secondary" onClick={onRetryExact}>Retry</button>
        </div>
      ) : null}
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
                  aria-label="View native asset information"
                  title="View native asset information"
                  ref={nativeInfoTrigger}
                  onClick={() => { setNativeInfo(true); }}
                >ⓘ</button>
                <span className="icon-button-placeholder" aria-hidden="true" />
              </div>
            </article>
            {page.assets.map((row) => (
              <TokenAssetRow
                key={row.selection.asset.address}
                row={row}
                disabled={mutationDisabled}
                onInfo={onInfo}
                onRemove={onRemove}
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
            >&lt;&lt;</button>
            <p>Block {page.block.blockNumber}</p>
            <button
              type="button"
              className="icon-button secondary"
              aria-label="Next asset page"
              title="Next asset page"
              disabled={page.nextCursor === null || loading}
              onClick={onNext}
            >&gt;&gt;</button>
          </footer>
        </>
      )}
      {exact === undefined ? null : <TokenInformation result={exact} onClose={onCloseInfo} />}
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
