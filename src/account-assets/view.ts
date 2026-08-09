import type { TokenOptionalTextUnavailableReason } from "../core/browser.js";
import type { StockFactoryClassificationUnavailableReason } from "../registry/browser.js";
import type { TokenSelection } from "../token-catalog/browser.js";
import type {
  AccountAssetClassification,
  AccountAssetCollectionSuccess,
  AccountAssetExactSuccess,
  AccountAssetOfficialSnapshotUnavailableReason,
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
      label: "Custom ERC-20";
      limitation: null;
    }>
  | Readonly<{
      kind: "official_snapshot_unavailable";
      label: "Classification unavailable";
      limitation: string;
    }>
  | Readonly<{
      kind: "stock_factory_verification_unavailable";
      label: "Classification unavailable";
      limitation: string;
    }>;

export interface AccountAssetRowView {
  readonly selection: TokenSelection;
  readonly identity: AccountAssetHumanIdentityView;
  readonly classification: AccountAssetClassificationView;
  readonly quantity: AccountAssetQuantityView;
  readonly requiredStandards: ContractAccountAsset["requiredStandards"];
}

const classificationUnavailableReasons: Readonly<
  Record<StockFactoryClassificationUnavailableReason, string>
> = Object.freeze({
  chain_response_unavailable: "A complete chain response was not obtained for StockFactory verification.",
  factory_identity_mismatch: "The StockFactory deployment identity did not match the accepted proxy and implementation.",
  rate_limited: "The chain source rate-limited StockFactory verification.",
  runtime_busy: "Little John was busy before StockFactory verification completed.",
  source_inconsistent: "Chain evidence used for StockFactory verification was inconsistent.",
  source_unavailable: "Chain evidence required for StockFactory verification was unavailable.",
  token_code_missing: "No contract code was found at the token address.",
  token_identity_mismatch: "The token address did not match the StockFactory mapping for its UID.",
});

const officialSnapshotUnavailableReasons = Object.freeze({
  source_inconsistent: "The current official Stock Token list contained inconsistent evidence.",
  source_unavailable: "The current official Stock Token list was unavailable.",
} satisfies Readonly<Record<AccountAssetOfficialSnapshotUnavailableReason, string>>);

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

const assetIdentityWarnings = (input: Readonly<{
  nameIssue: TokenOptionalTextUnavailableReason | null;
  symbolIssue: TokenOptionalTextUnavailableReason | null;
}>): readonly string[] =>
  Object.freeze([
    ...(input.nameIssue === null
      ? []
      : [`Token name ${tokenOptionalTextUnavailableReasonLabel(input.nameIssue)}.`]),
    ...(input.symbolIssue === null
      ? []
      : [`Token symbol ${tokenOptionalTextUnavailableReasonLabel(input.symbolIssue)}.`]),
  ]);

const classificationView = (
  classification: AccountAssetClassification,
): AccountAssetClassificationView => {
  if (classification.kind === "robinhood_stock_token") {
    return Object.freeze({
      kind: "robinhood_stock_token",
      label: "Robinhood Stock Token",
      limitation: null,
    });
  }
  if (classification.kind === "custom_erc20") {
    return Object.freeze({
      kind: "custom_erc20",
      label: "Custom ERC-20",
      limitation: null,
    });
  }
  return classification.cause.kind === "official_snapshot_unavailable"
    ? Object.freeze({
        kind: "official_snapshot_unavailable",
        label: "Classification unavailable",
        limitation: officialSnapshotUnavailableReasons[classification.cause.reason],
      })
    : Object.freeze({
        kind: "stock_factory_verification_unavailable",
        label: "Classification unavailable",
        limitation: classificationUnavailableReasons[classification.cause.reason],
      });
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
};

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
