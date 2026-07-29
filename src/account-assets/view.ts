import type { TokenOptionalTextUnavailableReason } from "../core/browser.js";
import type { StockFactoryClassificationUnavailableReason } from "../registry/browser.js";
import type { TokenSelection } from "../token-catalog/browser.js";
import type {
  AccountAssetClassification,
  AccountAssetCollectionSuccess,
  AccountAssetExactSuccess,
  AccountAssetOverviewSuccess,
  AccountAssetViewRevision,
  ContractAccountAsset,
} from "./contracts.js";

export interface AccountAssetQuantityView {
  readonly raw: string;
  readonly decimals: string | null;
  readonly formattedRaw: string | null;
  readonly adjustedRaw: string | null;
  readonly formattedAdjusted: string | null;
  readonly adjustmentStatus: "available" | "not_supported" | "result_out_of_range";
}

export interface AccountAssetRowView {
  readonly selection: TokenSelection;
  readonly name: string | null;
  readonly nameIssue: TokenOptionalTextUnavailableReason | null;
  readonly symbol: string | null;
  readonly symbolIssue: TokenOptionalTextUnavailableReason | null;
  readonly classification: AccountAssetClassification;
  readonly quantity: AccountAssetQuantityView;
  readonly requiredStandards: ContractAccountAsset["requiredStandards"];
}

const rowView = (entry: ContractAccountAsset): AccountAssetRowView => Object.freeze({
  selection: entry.selection,
  name: entry.name.status === "available" ? entry.name.value : null,
  nameIssue: entry.name.status === "unavailable" ? entry.name.reason : null,
  symbol: entry.symbol.status === "available" ? entry.symbol.value : null,
  symbolIssue: entry.symbol.status === "unavailable" ? entry.symbol.reason : null,
  classification: entry.classification,
  quantity: Object.freeze({
    raw: entry.amount.raw,
    decimals: entry.amount.decimals,
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

export const classificationLabel = (classification: AccountAssetClassification): string => {
  switch (classification.kind) {
    case "robinhood_stock_token": return "Robinhood Stock Token";
    case "custom_erc20": return "Custom ERC-20";
    case "classification_unavailable": return "Classification unavailable";
  }
};

const classificationUnavailableReasons: Readonly<
  Record<StockFactoryClassificationUnavailableReason, string>
> = Object.freeze({
  factory_identity_mismatch: "The StockFactory deployment identity did not match the accepted proxy and implementation.",
  source_inconsistent: "The official asset source returned inconsistent evidence.",
  source_unavailable: "The official asset source was unavailable.",
  token_code_missing: "No contract code was found at the token address.",
  token_identity_mismatch: "The token address did not match the StockFactory mapping for its UID.",
});

export const classificationUnavailableReasonLabel = (
  reason: StockFactoryClassificationUnavailableReason,
): string => classificationUnavailableReasons[reason];

export const officialSnapshotFresh = (revision: AccountAssetViewRevision): boolean =>
  revision.officialSnapshotStatus === "current";

export const officialSnapshotStatusText = (revision: AccountAssetViewRevision): string =>
  officialSnapshotFresh(revision) ? "Official data current" : "Official data unavailable";

const tokenOptionalTextUnavailableReasonText =
  Object.freeze({
  call_failed: "read call failed",
  malformed: "returned malformed data",
  unsafe_text: "contained unsafe text and was withheld",
  } satisfies Readonly<Record<TokenOptionalTextUnavailableReason, string>>);

export const tokenOptionalTextUnavailableReasonLabel = (
  reason: TokenOptionalTextUnavailableReason,
): string => tokenOptionalTextUnavailableReasonText[reason];

export const assetIdentityWarnings = (row: AccountAssetRowView): readonly string[] =>
  Object.freeze([
    ...(row.nameIssue === null
      ? []
      : [`Token name ${tokenOptionalTextUnavailableReasonLabel(row.nameIssue)}.`]),
    ...(row.symbolIssue === null
      ? []
      : [`Token symbol ${tokenOptionalTextUnavailableReasonLabel(row.symbolIssue)}.`]),
  ]);

export const projectAccountAssetCollectionView = (result: AccountAssetCollectionSuccess) =>
  Object.freeze({
    account: result.account,
    block: result.block,
    viewRevision: result.viewRevision,
    native: Object.freeze({
      raw: result.native.rawBalance,
      decimals: null,
      formattedRaw: null,
      adjustedRaw: null,
      formattedAdjusted: null,
      adjustmentStatus: "not_supported" as const,
    }),
    assets: Object.freeze(result.assets.map(rowView)),
    nextCursor: result.nextCursor,
  });

export const projectAccountAssetOverviewView = (result: AccountAssetOverviewSuccess) =>
  Object.freeze({
    account: result.account,
    block: result.block,
    viewRevision: result.viewRevision,
    native: Object.freeze({
      raw: result.native.rawBalance,
      decimals: null,
      formattedRaw: null,
      adjustedRaw: null,
      formattedAdjusted: null,
      adjustmentStatus: "not_supported" as const,
    }),
    stockTokens: result.stockTokens.status === "current"
      ? Object.freeze({
          status: "current" as const,
          candidateListDigest: result.stockTokens.candidateListDigest,
          assets: Object.freeze(result.stockTokens.members.flatMap((member) =>
            member.status === "selected" ? [rowView(member.asset)] : [])),
          candidates: Object.freeze(result.stockTokens.members.flatMap((member) =>
            member.status === "available_to_add" ? [member.candidate] : [])),
        })
      : result.stockTokens,
  });

export const projectAccountAssetExactView = (result: AccountAssetExactSuccess): AccountAssetRowView =>
  rowView(result.asset);
