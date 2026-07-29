import type {
  AccountAssetQuantityView,
  AccountAssetRowView,
} from "../../account-assets/browser.js";

export interface AssetAmountPresentation {
  readonly value: string;
  readonly label: "Balance" | "Adjusted balance";
  readonly onChainValue: string | null;
  readonly warning: string | null;
}

const withUnit = (value: string, symbol: string | null): string =>
  symbol === null ? value : `${value} ${symbol}`;

export const presentContractAssetAmount = (
  quantity: AccountAssetQuantityView,
  symbol: string | null,
): AssetAmountPresentation => {
  if (quantity.formattedAdjusted !== null) {
    return Object.freeze({
      value: withUnit(quantity.formattedAdjusted, symbol),
      label: "Adjusted balance",
      onChainValue: quantity.formattedRaw === null ||
          quantity.formattedRaw === quantity.formattedAdjusted
        ? null
        : withUnit(quantity.formattedRaw, symbol),
      warning: null,
    });
  }
  if (quantity.formattedRaw !== null) {
    return Object.freeze({
      value: withUnit(quantity.formattedRaw, symbol),
      label: "Balance",
      onChainValue: null,
      warning: quantity.adjustmentStatus === "result_out_of_range"
        ? "The adjusted balance is outside the supported display range."
        : null,
    });
  }
  return Object.freeze({
    value: "Balance unavailable",
    label: "Balance",
    onChainValue: null,
    warning: null,
  });
};

export const presentNativeAssetAmount = (
  raw: string,
): AssetAmountPresentation => Object.freeze({
  value: raw === "0" ? "0 ETH" : "ETH balance unavailable",
  label: "Balance",
  onChainValue: null,
  warning: null,
});

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
    {amount.warning === null ? null : <p role="status">{amount.warning}</p>}
  </div>
);

export const stockTokenAmount = (
  row: AccountAssetRowView,
): AssetAmountPresentation => presentContractAssetAmount(row.quantity, row.symbol);
