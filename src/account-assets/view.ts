import type { TokenSelection } from "../token-catalog/browser.js";
import type {
  AccountAssetClassification,
  AccountAssetCollectionSuccess,
  AccountAssetExactSuccess,
  ContractAccountAsset,
} from "./contracts.js";

export interface AccountAssetQuantityView {
  readonly raw: string;
  readonly formattedRaw: string | null;
  readonly adjustedRaw: string | null;
  readonly formattedAdjusted: string | null;
  readonly adjustmentStatus: "available" | "not_supported" | "result_out_of_range";
}

export interface AccountAssetRowView {
  readonly selection: TokenSelection;
  readonly name: string | null;
  readonly symbol: string | null;
  readonly classification: AccountAssetClassification;
  readonly quantity: AccountAssetQuantityView;
  readonly requiredStandards: ContractAccountAsset["requiredStandards"];
}

const rowView = (entry: ContractAccountAsset): AccountAssetRowView => Object.freeze({
  selection: entry.selection,
  name: entry.name.status === "available" ? entry.name.value : null,
  symbol: entry.symbol.status === "available" ? entry.symbol.value : null,
  classification: entry.classification,
  quantity: Object.freeze({
    raw: entry.amount.raw,
    formattedRaw: entry.amount.formattedRaw,
    adjustedRaw: entry.amount.uiAdjusted?.status === "available"
      ? entry.amount.uiAdjusted.adjustedRaw
      : null,
    formattedAdjusted: entry.amount.formattedUiAdjusted,
    adjustmentStatus: entry.amount.uiAdjusted === null
      ? "not_supported"
      : entry.amount.uiAdjusted.status === "available"
        ? "available"
        : "result_out_of_range",
  }),
  requiredStandards: entry.requiredStandards,
});

export const projectAccountAssetCollectionView = (result: AccountAssetCollectionSuccess) =>
  Object.freeze({
    account: result.account,
    block: result.block,
    viewRevision: result.viewRevision,
    native: Object.freeze({
      raw: result.native.rawBalance,
      formattedRaw: null,
      adjustedRaw: null,
      formattedAdjusted: null,
      adjustmentStatus: "not_supported" as const,
    }),
    assets: Object.freeze(result.assets.map(rowView)),
    nextCursor: result.nextCursor,
  });

export const projectAccountAssetExactView = (result: AccountAssetExactSuccess): AccountAssetRowView =>
  rowView(result.asset);
