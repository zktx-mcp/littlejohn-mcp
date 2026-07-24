import type { TokenOptionalTextUnavailableReason } from "../core/browser.js";
import type { StockFactoryClassificationUnavailableReason } from "../registry/browser.js";
import type { TokenSelection } from "../token-catalog/browser.js";
import type {
  AccountAssetClassification,
  AccountAssetCollectionSuccess,
  AccountAssetExactSuccess,
  AccountAssetViewRevision,
  ContractAccountAsset,
} from "./contracts.js";

export interface AccountAssetEvidenceField {
  readonly label: string;
  readonly value: string;
}

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

const classificationUnavailableReason: Readonly<
  Record<StockFactoryClassificationUnavailableReason, string>
> = Object.freeze({
  factory_identity_mismatch: "The StockFactory deployment identity did not match the accepted proxy and implementation.",
  source_inconsistent: "The official asset source returned inconsistent evidence.",
  source_unavailable: "The official asset source was unavailable.",
  token_code_missing: "No contract code was found at the token address.",
  token_identity_mismatch: "The token address did not match the StockFactory mapping for its UID.",
});

export const classificationEvidenceFields = (
  classification: AccountAssetClassification,
): readonly AccountAssetEvidenceField[] => {
  switch (classification.kind) {
    case "robinhood_stock_token":
      return Object.freeze([
        Object.freeze({ label: "Source", value: classification.snapshot.sourceUri }),
        Object.freeze({ label: "Observed at", value: classification.snapshot.sourceObservedAt }),
        Object.freeze({ label: "Snapshot revision", value: classification.snapshot.revision }),
        Object.freeze({ label: "Asset UID", value: classification.member.assetUid }),
        Object.freeze({ label: "Verified implementation", value: classification.verification.implementationAddress }),
        Object.freeze({ label: "Implementation code hash", value: classification.verification.implementationCodeHash }),
        Object.freeze({ label: "Token code hash", value: classification.verification.tokenCodeHash }),
        Object.freeze({ label: "Verified at block", value: classification.verification.block.blockNumber }),
      ]);
    case "custom_erc20":
      return Object.freeze([
        Object.freeze({ label: "Source", value: classification.snapshot.sourceUri }),
        Object.freeze({ label: "Observed at", value: classification.snapshot.sourceObservedAt }),
        Object.freeze({ label: "Snapshot revision", value: classification.snapshot.revision }),
        Object.freeze({ label: "Basis", value: "Proven absent from the current official asset set." }),
      ]);
    case "classification_unavailable":
      return Object.freeze([
        Object.freeze({ label: "Reason", value: classificationUnavailableReason[classification.reason] }),
        ...(classification.snapshot === null ? [] : [
          Object.freeze({ label: "Source", value: classification.snapshot.sourceUri }),
          Object.freeze({ label: "Observed at", value: classification.snapshot.sourceObservedAt }),
        ]),
      ]);
  }
};

export const accountAssetAnchorFields = (
  block: AccountAssetCollectionSuccess["block"],
): readonly AccountAssetEvidenceField[] => Object.freeze([
  Object.freeze({ label: "Block", value: block.blockNumber }),
  Object.freeze({ label: "Block time", value: block.blockTimestamp }),
  Object.freeze({ label: "Block hash", value: block.blockHash }),
]);

export const officialSnapshotFresh = (revision: AccountAssetViewRevision): boolean =>
  revision.officialSnapshotStatus === "current";

export const officialSnapshotStatusText = (revision: AccountAssetViewRevision): string =>
  officialSnapshotFresh(revision) ? "Official data current" : "Official data unavailable";

const textIssue: Readonly<Record<TokenOptionalTextUnavailableReason, string>> = Object.freeze({
  call_failed: "read call failed",
  malformed: "returned malformed data",
  unsafe_text: "contained unsafe text and was withheld",
});

export const assetIdentityWarnings = (row: AccountAssetRowView): readonly string[] =>
  Object.freeze([
    ...(row.nameIssue === null ? [] : [`Token name ${textIssue[row.nameIssue]}.`]),
    ...(row.symbolIssue === null ? [] : [`Token symbol ${textIssue[row.symbolIssue]}.`]),
  ]);

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
