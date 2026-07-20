import type {
  AccountAssetCollectionSuccess,
  AccountAssetExactSuccess,
} from "../../account-assets/browser.js";
import {
  projectAccountAssetCollectionView,
  projectAccountAssetExactView,
  type AccountAssetQuantityView,
  type AccountAssetRowView,
} from "../../account-assets/view.js";
import type { TokenRegistration } from "../../token-catalog/browser.js";

export interface AccountAssetPageSnapshot {
  readonly result: AccountAssetCollectionSuccess;
  readonly cursor: TokenRegistration["asset"]["address"] | null;
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
  readonly onRemove: (registration: TokenRegistration, trigger: HTMLButtonElement) => void;
  readonly onPrevious: () => void;
  readonly onNext: () => void;
}

const quantityText = (quantity: AccountAssetQuantityView): Readonly<{
  primary: string;
  secondary?: string;
}> => quantity.status === "unavailable"
  ? Object.freeze({ primary: "Unavailable", secondary: quantity.reason.replaceAll("_", " ") })
  : Object.freeze({
      primary: quantity.formatted ?? quantity.raw,
      ...(quantity.formatted === null ? {} : { secondary: `Raw: ${quantity.raw}` }),
    });

const AssetQuantity = ({ quantity }: { readonly quantity: AccountAssetQuantityView }) => {
  const text = quantityText(quantity);
  return (
    <div className={quantity.status === "available" ? "asset-quantity" : "asset-quantity unavailable"}>
      <strong>{text.primary}</strong>
      {text.secondary === undefined ? null : <span>{text.secondary}</span>}
    </div>
  );
};

const TokenAssetRow = ({
  row,
  newlyAdded = false,
  disabled,
  onRemove,
}: {
  readonly row: AccountAssetRowView;
  readonly newlyAdded?: boolean;
  readonly disabled: boolean;
  readonly onRemove: (registration: TokenRegistration, trigger: HTMLButtonElement) => void;
}) => (
  <article className={newlyAdded ? "asset-row asset-row-new" : "asset-row"}>
    <div className="asset-identity">
      {newlyAdded ? <span className="asset-badge">Newly added</span> : null}
      <h2>{row.name ?? row.symbol ?? "Registered token"}</h2>
      {row.symbol === null ? null : <p className="asset-symbol">{row.symbol}</p>}
      <p className="asset-address">{row.registration.asset.address}</p>
    </div>
    <AssetQuantity quantity={row.quantity} />
    <button
      type="button"
      className="danger asset-action"
      disabled={disabled}
      onClick={(event) => { onRemove(row.registration, event.currentTarget); }}
    >
      Remove from this account
    </button>
  </article>
);

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
  onRemove,
  onPrevious,
  onNext,
}: AccountAssetPageProps) => {
  const page = snapshot === undefined ? undefined : projectAccountAssetCollectionView(snapshot.result);
  const exactRow = exact === undefined ? undefined : projectAccountAssetExactView(exact);
  const exactAlreadyVisible = exactRow !== undefined && page?.assets.some(
    (row) => row.registration.asset.address === exactRow.registration.asset.address,
  ) === true;
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
          <button type="button" className="secondary" disabled={loading} onClick={onRefresh}>
            {loading ? "Refreshing…" : "Refresh"}
          </button>
          <button
            type="button"
            disabled={mutationDisabled}
            onClick={(event) => { onAdd(event.currentTarget); }}
          >
            Add token
          </button>
        </div>
      </header>
      {staleMessage === undefined ? null : (
        <div className="warning" role="status">
          <strong>Latest assets unavailable</strong>
          <p>{staleMessage} The verified snapshot below has not been replaced.</p>
        </div>
      )}
      {exactRead.status === "loading" ? (
        <div className="notice" role="status">
          <strong>Reading newly added asset</strong>
          <p>Little John is reading its current balance.</p>
        </div>
      ) : exactRead.status === "error" ? (
        <div className="warning" role="status">
          <strong>Newly added asset unavailable</strong>
          <p>{exactRead.message}</p>
          <button type="button" className="secondary" onClick={onRetryExact}>Retry new asset</button>
        </div>
      ) : null}
      {page === undefined ? (
        <div className="empty-state">
          <h2>{loading ? "Reading assets…" : "Assets unavailable"}</h2>
          <p>{loading
            ? "Little John is reading current balances for this account."
            : "Retry the asset read without reconnecting your wallet."}</p>
        </div>
      ) : (
        <>
          <section className="asset-list" aria-label="Account asset balances">
            <article className="asset-row native-asset">
              <div className="asset-identity">
                <span className="asset-badge">Native</span>
                <h2>Robinhood Chain native asset</h2>
              </div>
              <AssetQuantity quantity={page.native} />
            </article>
            {exactRow !== undefined && !exactAlreadyVisible ? (
              <TokenAssetRow
                row={exactRow}
                newlyAdded
                disabled={mutationDisabled}
                onRemove={onRemove}
              />
            ) : null}
            {page.assets.map((row) => (
              <TokenAssetRow
                key={row.registration.asset.address}
                row={row}
                disabled={mutationDisabled}
                onRemove={onRemove}
              />
            ))}
          </section>
          {page.assets.length === 0 ? (
            <div className="empty-state compact-empty-state">
              <h2>No registered tokens</h2>
              <p>Add a token contract to include its current balance for this account.</p>
            </div>
          ) : null}
          <footer className="asset-pagination">
            <button type="button" className="secondary" disabled={snapshot?.canGoBack !== true || loading} onClick={onPrevious}>
              Previous
            </button>
            <p>{page.block === null
              ? "Balance source unavailable"
              : `Block ${page.block.blockNumber}`}</p>
            <button type="button" className="secondary" disabled={page.nextCursor === null || loading} onClick={onNext}>
              Next
            </button>
          </footer>
        </>
      )}
    </main>
  );
};
