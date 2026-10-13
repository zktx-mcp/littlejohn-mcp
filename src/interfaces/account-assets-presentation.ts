import { formatAmount } from "../evm/amounts.js";
import { nativeAssetUnitDefinition } from "../registry/client.js";
import { presentationCopy as copy, tokenTextIssue } from "./presentation-copy.js";
import type { TokenOptionalTextUnavailableReason, TokenSelection } from "../token-catalog/client.js";

import type {
  AccountAssetClassification,
  AccountAssetCollectionSuccess,
  AccountAssetViewRevision,
  ContractAccountAsset,
} from "../account-assets/contracts.js";

type AssetField = readonly [label: string, value: string];
export interface AccountAssetQuantityView {
  readonly basis: "token" | "adjusted";
  readonly fields: readonly AssetField[];
  readonly limitations: readonly string[];
  readonly details: readonly Readonly<{ title: string | null; fields: readonly AssetField[] }>[];
}

export interface AccountAssetHumanIdentityView {
  readonly address: TokenSelection["asset"]["address"];
  readonly label: string;
  readonly name: string | null;
  readonly symbol: string | null;
  readonly warnings: readonly string[];
}

export type AccountAssetClassificationView =
  | Readonly<{
      kind: "robinhood_stock_token";
      label: "Robinhood Stock Token";
      limitation: null;
    }>
  | Readonly<{
      kind: "custom_erc20";
      label: typeof copy.classification.custom_erc20;
      limitation: null;
    }>
  | Readonly<{
      kind: "official_snapshot_unavailable";
      label: typeof copy.classification.unavailable;
      limitation: string;
    }>
  | Readonly<{
      kind: "stock_factory_verification_unavailable";
      label: typeof copy.classification.unavailable;
      limitation: string;
    }>;

export interface AccountAssetRowView {
  readonly selection: TokenSelection;
  readonly identity: AccountAssetHumanIdentityView;
  readonly classification: AccountAssetClassificationView;
  readonly quantity: AccountAssetQuantityView;
}

export const officialSnapshotFresh = (revision: AccountAssetViewRevision): boolean =>
  revision.officialSnapshotStatus === "current";

export const officialSnapshotStatusText = (revision: AccountAssetViewRevision): string =>
  officialSnapshotFresh(revision) ? copy.freshness.current : copy.label.unavailable;

const assetIdentityWarnings = (input: Readonly<{
  nameIssue: TokenOptionalTextUnavailableReason | null;
  symbolIssue: TokenOptionalTextUnavailableReason | null;
}>): readonly string[] => Object.freeze([
  ...(input.nameIssue === null ? [] : [tokenTextIssue("name", input.nameIssue)]),
  ...(input.symbolIssue === null ? [] : [tokenTextIssue("symbol", input.symbolIssue)]),
]);

const classificationView = (
  classification: AccountAssetClassification,
): AccountAssetClassificationView => {
  if (classification.kind === "robinhood_stock_token") {
    return Object.freeze({
      kind: "robinhood_stock_token",
      label: copy.classification.robinhood_stock_token,
      limitation: null,
    });
  }
  if (classification.kind === "custom_erc20") {
    return Object.freeze({
      kind: "custom_erc20",
      label: copy.classification.custom_erc20,
      limitation: null,
    });
  }
  return classification.cause.kind === "official_snapshot_unavailable"
    ? Object.freeze({
        kind: "official_snapshot_unavailable",
        label: copy.classification.unavailable,
        limitation: copy.scope.classificationUnavailable,
      })
    : Object.freeze({
        kind: "stock_factory_verification_unavailable",
        label: copy.classification.unavailable,
        limitation: copy.scope.classificationUnavailable,
      });
};

// Canonical amounts retain their numeric authority. This projection chooses
// their human meaning once, before either text or DOM composition.
const quantityView = (entry: ContractAccountAsset, symbol: string | null): AccountAssetQuantityView => {
  const { amount } = entry;
  const adjusted = amount.uiAdjusted;
  const displayAmount = (raw: string, formatted: string | null): string | null =>
    formatted ?? (raw === "0" ? "0" : null);
  const tokenAmount = displayAmount(amount.raw, amount.formattedRaw);
  const adjustedAmount = adjusted?.status === "available"
    ? displayAmount(adjusted.adjustedRaw, amount.formattedUiAdjusted) : null;
  const amountText = (value: string | null): string => value === null ? copy.label.amountUnavailable
    : `${value}${symbol === null ? "" : ` ${symbol}`}`;
  const tokenField: AssetField = [copy.label.tokenBalance, amountText(tokenAmount)];
  const fields: AssetField[] = [];
  const limitations: string[] = [];
  const details: { title: string | null; fields: AssetField[] }[] = [];
  const basis = adjustedAmount === null ? "token" : "adjusted";
  if (basis === "adjusted") {
    fields.push([copy.label.adjustedBalance, amountText(adjustedAmount)]);
    details.push({ title: null, fields: [tokenField] });
  } else {
    fields.push(tokenField);
    if (adjusted !== null) {
      fields.push([copy.label.adjustedBalance, adjusted.status === "available"
        ? copy.label.amountUnavailable : copy.label.unavailable]);
    } else if (entry.requiredStandards.erc8056.status !== "not_supported") {
      fields.push([copy.label.adjustedBalance, copy.label.unavailable]);
      limitations.push(entry.requiredStandards.erc8056.status === "inconsistent"
        ? copy.scope.adjustmentInconsistent : copy.scope.adjustmentUnknown);
    }
  }
  if (adjusted?.status === "unavailable") limitations.push(copy.scope.adjustmentOutOfRange);
  if (tokenAmount === null || (adjusted?.status === "available" && adjustedAmount === null)) {
    limitations.push(copy.scope.nonzeroUnitUnavailable);
  }
  if (tokenAmount === null) details.push({ title: copy.label.tokenBalance, fields: [[copy.label.rawAmount, amount.raw]] });
  if (adjusted?.status === "available" && adjustedAmount === null) {
    details.push({ title: copy.label.adjustedBalance, fields: [[copy.label.rawAmount, adjusted.adjustedRaw]] });
  }
  if (adjusted !== null) details.push({ title: null, fields: [[copy.label.currentAdjustmentFactor, `${adjusted.multiplier} / ${adjusted.scale}`]] });
  return Object.freeze({ basis, fields, limitations, details });
};

const rowView = (entry: ContractAccountAsset): AccountAssetRowView => {
  const name = entry.name.status === "available" ? entry.name.value : null;
  const nameIssue = entry.name.status === "unavailable" ? entry.name.reason : null;
  const symbol = entry.symbol.status === "available" ? entry.symbol.value : null;
  const symbolIssue = entry.symbol.status === "unavailable" ? entry.symbol.reason : null;
  return Object.freeze({
    selection: entry.selection,
    identity: Object.freeze({
      address: entry.selection.asset.address,
      label: name ?? symbol ?? entry.selection.asset.address,
      name,
      symbol,
      warnings: assetIdentityWarnings({ nameIssue, symbolIssue }),
    }),
    classification: classificationView(entry.classification),
    quantity: quantityView(entry, symbol),
  });
};

export const projectAccountAssetCollectionView = (result: AccountAssetCollectionSuccess) => {
  const assets = result.assets.map(rowView);
  return Object.freeze({
    account: result.account,
    block: result.block,
    viewRevision: result.viewRevision,
    nativeBalance: nativeAccountBalanceText(result.native),
    assets: Object.freeze(assets),
    balanceExplanations: Object.freeze(assets.length === 0 ? [] : [copy.scope.tokenBalances,
      ...(assets.some(asset => asset.quantity.basis === "adjusted") ? [copy.scope.adjustedBalances] : [])]),
    nextCursor: result.nextCursor,
  });
};

export const nativeAccountBalanceText = (native: AccountAssetCollectionSuccess["native"]): string =>
  native.asset.kind === "native" && native.asset.chainId === nativeAssetUnitDefinition.asset.chainId
    ? `${formatAmount(native.rawBalance, nativeAssetUnitDefinition.decimals)} ETH` : copy.label.amountUnavailable;
