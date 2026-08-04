import { contractInspectCapability } from "../core/browser.js";
import { referenceMarketApplicationContracts } from "../market-portfolio/contracts.js";
import { tokenCatalogApplicationContracts } from "../token-catalog/browser.js";
import { walletManagementContracts } from "../wallet/management-contracts.js";
import {
  browserDialogSurfaces,
  browserPages,
  type BrowserDialogSurface,
  type BrowserPage,
} from "./browser-contract.js";

export type BrowserCapabilitySurface = BrowserPage | BrowserDialogSurface;
export type BrowserCapabilitySurfaceTuple = readonly [
  BrowserCapabilitySurface,
  ...BrowserCapabilitySurface[],
];

export interface BrowserCapabilityBinding {
  readonly contract: object;
  readonly surfaces: BrowserCapabilitySurfaceTuple;
}

export const browserCapabilityBindings = Object.freeze({
  contractInspect: Object.freeze({
    contract: contractInspectCapability,
    surfaces: Object.freeze([browserDialogSurfaces.analysis] as const),
  }),
  referencePrice: Object.freeze({
    contract: referenceMarketApplicationContracts.price,
    surfaces: Object.freeze([browserPages.referencePrice] as const),
  }),
  referenceHistory: Object.freeze({
    contract: referenceMarketApplicationContracts.history,
    surfaces: Object.freeze([browserPages.referencePrice] as const),
  }),
  tokenStartAddition: Object.freeze({
    contract: tokenCatalogApplicationContracts.startAddition,
    surfaces: Object.freeze([browserDialogSurfaces.stockTokenAdd] as const),
  }),
  tokenStartRemoval: Object.freeze({
    contract: tokenCatalogApplicationContracts.startRemoval,
    surfaces: Object.freeze([browserDialogSurfaces.stockTokenRemove] as const),
  }),
  tokenOperation: Object.freeze({
    contract: tokenCatalogApplicationContracts.operation,
    surfaces: Object.freeze([
      browserDialogSurfaces.stockTokenAdd,
      browserDialogSurfaces.stockTokenRemove,
      browserDialogSurfaces.externalTokenOperation,
    ] as const),
  }),
  tokenCancelOperation: Object.freeze({
    contract: tokenCatalogApplicationContracts.cancelOperation,
    surfaces: Object.freeze([
      browserDialogSurfaces.stockTokenRemove,
      browserDialogSurfaces.externalTokenOperation,
    ] as const),
  }),
  walletConnect: Object.freeze({
    contract: walletManagementContracts.connect,
    surfaces: Object.freeze([browserDialogSurfaces.walletConnect] as const),
  }),
  walletDisconnect: Object.freeze({
    contract: walletManagementContracts.disconnect,
    surfaces: Object.freeze([browserDialogSurfaces.walletDisconnect] as const),
  }),
  walletOperation: Object.freeze({
    contract: walletManagementContracts.operation,
    surfaces: Object.freeze([
      browserDialogSurfaces.walletConnect,
      browserDialogSurfaces.walletDisconnect,
    ] as const),
  }),
  walletCancelOperation: Object.freeze({
    contract: walletManagementContracts.cancelOperation,
    surfaces: Object.freeze([
      browserDialogSurfaces.walletConnect,
      browserDialogSurfaces.walletDisconnect,
    ] as const),
  }),
} as const satisfies Readonly<Record<string, BrowserCapabilityBinding>>);

export const browserCapabilityBindingList: readonly BrowserCapabilityBinding[] =
  Object.freeze(Object.values(browserCapabilityBindings));

for (const [index, binding] of browserCapabilityBindingList.entries()) {
  if (browserCapabilityBindingList.slice(index + 1).some(
    (candidate) => candidate.contract === binding.contract,
  )) {
    throw new TypeError("Browser capability binding contract is duplicated.");
  }
}

export const browserCapabilityBindingFor = (
  contract: object,
): BrowserCapabilityBinding | undefined =>
  browserCapabilityBindingList.find((binding) => binding.contract === contract);
