import type {
  ExactRational,
  ReferenceAsset,
  ReferencePairManifestEntry,
  ReferencePriceSuccess,
} from "../../core/browser.js";
import { canonicalUsdgAddress } from "../../core/browser.js";

export interface ReferencePriceUnit {
  readonly code: "ETH" | "USD" | "USDG";
  readonly prefix: "" | "$";
  readonly suffix: "" | " ETH" | " USDG";
}

const referenceAssetUnit = (asset: ReferenceAsset): ReferencePriceUnit => {
  switch (asset.kind) {
    case "native_eth":
      return Object.freeze({ code: "ETH", prefix: "", suffix: " ETH" });
    case "reference_currency":
      return Object.freeze({ code: asset.code, prefix: "$", suffix: "" });
    case "erc20":
      if (asset.address === canonicalUsdgAddress) {
        return Object.freeze({ code: "USDG", prefix: "", suffix: " USDG" });
      }
      throw new TypeError("Reference price asset has no admitted human unit.");
  }
};

export const referencePairQuoteUnit = (
  pair: ReferencePairManifestEntry,
): ReferencePriceUnit => referenceAssetUnit(pair.contract.quote);

export type ReferencePricePresentation =
  | Readonly<{
      status: "available";
      tone: "current" | "stale";
      value: ExactRational;
      unit: ReferencePriceUnit;
    }>
  | Readonly<{
      status: "unavailable";
      tone: "unavailable";
      unit: ReferencePriceUnit;
    }>;

export const presentReferencePrice = (
  price: ReferencePriceSuccess,
): ReferencePricePresentation => {
  const unit = referencePairQuoteUnit(price.pair);
  switch (price.status) {
    case "current":
      return Object.freeze({
        status: "available",
        tone: "current",
        value: price.currentPrice,
        unit,
      });
    case "stale":
      return Object.freeze({
        status: "available",
        tone: "stale",
        value: price.lastObserved,
        unit,
      });
    case "unavailable":
      return Object.freeze({
        status: "unavailable",
        tone: "unavailable",
        unit,
      });
  }
};
