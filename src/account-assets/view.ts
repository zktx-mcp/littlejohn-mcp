import { formatAmount, type CanonicalAmount } from "../core/browser.js";
import type { TokenRegistration } from "../token-catalog/browser.js";
import type {
  AccountAssetBalance,
  AccountAssetCollectionSuccess,
  AccountAssetEntry,
  AccountAssetExactSuccess,
} from "./contracts.js";

export type AccountAssetQuantityView =
  | Readonly<{ status: "available"; raw: string; formatted: string | null }>
  | Readonly<{ status: "unavailable"; reason: string }>;

export interface AccountAssetRowView {
  readonly registration: TokenRegistration;
  readonly name: string | null;
  readonly symbol: string | null;
  readonly quantity: AccountAssetQuantityView;
  readonly metadata: AccountAssetEntry["metadata"];
}

const availableText = (
  field: AccountAssetEntry["metadata"]["name"] | AccountAssetEntry["metadata"]["symbol"],
): string | null => field.observation.status === "available" ? field.observation.value : null;

const amountView = (amount: CanonicalAmount): AccountAssetQuantityView => Object.freeze({
  status: "available" as const,
  raw: amount.raw,
  formatted: amount.decimals.status === "available"
    ? formatAmount(amount.raw, amount.decimals.value)
    : null,
});

const balanceFailureReason = (balance: AccountAssetBalance): string | undefined =>
  balance.status === "unavailable" ? balance.failure.error.code : undefined;

const rowView = (
  entry: AccountAssetEntry,
  quantity: AccountAssetQuantityView,
): AccountAssetRowView => Object.freeze({
  registration: entry.registration,
  name: availableText(entry.metadata.name),
  symbol: availableText(entry.metadata.symbol),
  quantity,
  metadata: entry.metadata,
});

export const projectAccountAssetCollectionView = (result: AccountAssetCollectionSuccess) => {
  const sourceFailure = balanceFailureReason(result.balance);
  const tokenResults = result.balance.status === "available" ? result.balance.snapshot.data.tokens : [];
  const assets = result.assets.map((entry, index) => {
    const token = tokenResults[index];
    const quantity: AccountAssetQuantityView = sourceFailure !== undefined
      ? Object.freeze({ status: "unavailable", reason: sourceFailure })
      : token?.result.status === "available"
        ? amountView(token.result.amount)
        : Object.freeze({ status: "unavailable", reason: token?.result.errorCode ?? "internal_error" });
    return rowView(entry, quantity);
  });
  const native = result.balance.status === "available"
    ? amountView(result.balance.snapshot.data.native.status === "available"
      ? result.balance.snapshot.data.native.amount
      : (() => { throw new TypeError("Native balance is unavailable."); })())
    : Object.freeze({ status: "unavailable" as const, reason: result.balance.failure.error.code });
  return Object.freeze({
    account: result.account,
    block: result.balance.status === "available" ? result.balance.snapshot.data.block : null,
    native,
    assets: Object.freeze(assets),
    nextCursor: result.nextCursor,
    balanceFailure: result.balance.status === "unavailable" ? result.balance.failure : null,
  });
};

export const projectAccountAssetExactView = (result: AccountAssetExactSuccess): AccountAssetRowView => {
  const quantity: AccountAssetQuantityView = result.balance.status === "unavailable"
    ? Object.freeze({ status: "unavailable", reason: result.balance.failure.error.code })
    : result.balance.snapshot.data.tokens[0]?.result.status === "available"
      ? amountView(result.balance.snapshot.data.tokens[0].result.amount)
      : Object.freeze({
          status: "unavailable",
          reason: result.balance.snapshot.data.tokens[0]?.result.errorCode ?? "internal_error",
        });
  return rowView(result.asset, quantity);
};
