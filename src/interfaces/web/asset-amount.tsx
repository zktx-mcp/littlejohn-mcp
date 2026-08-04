import type {
  AccountAssetQuantityView,
  AccountAssetRowView,
} from "../../account-assets/browser.js";

export interface AssetAmountPresentation {
  readonly value: string;
  readonly label: "Balance" | "Adjusted balance";
  readonly onChainValue: string | null;
  readonly reason: string | null;
  readonly warning: string | null;
}

const withUnit = (value: string, symbol: string | null): string =>
  symbol === null ? value : `${value} ${symbol}`;

type AssetAmountContext =
  | Readonly<{ kind: "native" }>
  | Readonly<{ kind: "contract"; symbol: string | null }>;

export const presentAssetAmount = (
  quantity: AccountAssetQuantityView,
  context: AssetAmountContext,
): AssetAmountPresentation => {
  const symbol = context.kind === "contract" ? context.symbol : null;
  if (quantity.formattedAdjusted !== null) {
    return Object.freeze({
      value: withUnit(quantity.formattedAdjusted, symbol),
      label: "Adjusted balance",
      onChainValue: quantity.formattedRaw === null ||
          quantity.formattedRaw === quantity.formattedAdjusted
        ? null
        : withUnit(quantity.formattedRaw, symbol),
      reason: null,
      warning: null,
    });
  }
  if (quantity.formattedRaw !== null) {
    return Object.freeze({
      value: withUnit(quantity.formattedRaw, symbol),
      label: "Balance",
      onChainValue: null,
      reason: null,
      warning: quantity.adjustmentStatus === "result_out_of_range"
        ? "The adjusted balance is outside the supported display range."
        : null,
    });
  }
  if (quantity.raw === "0") {
    return Object.freeze({
      value: withUnit("0", symbol),
      label: "Balance",
      onChainValue: null,
      reason: null,
      warning: null,
    });
  }
  return Object.freeze({
    value: "Human amount unavailable",
    label: "Balance",
    onChainValue: null,
    reason: context.kind === "native"
      ? "Native decimals are not provided by this overview."
      : "Token decimals are unavailable for this balance.",
    warning: null,
  });
};

export const presentNativeAssetAmount = (
  quantity: AccountAssetQuantityView,
): AssetAmountPresentation => presentAssetAmount(quantity, { kind: "native" });

export const AssetAmount = ({
  amount,
  className,
}: {
  readonly amount: AssetAmountPresentation;
  readonly className?: string;
}) => (
  <div className={`asset-amount${className === undefined ? "" : ` ${className}`}`}>
    <span>{amount.label}</span>
    <strong>{amount.value}</strong>
    {amount.reason === null ? null : <p>{amount.reason}</p>}
    {amount.warning === null ? null : <p role="status">{amount.warning}</p>}
  </div>
);

export const stockTokenAmount = (
  row: AccountAssetRowView,
): AssetAmountPresentation => presentAssetAmount(row.quantity, {
  kind: "contract",
  symbol: row.symbol,
});
