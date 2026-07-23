import { createReferenceMarketApplicationContracts } from "./contracts.js";
import { referenceMarketErrorRegistry } from "./error-registry.js";

export const referenceMarketApplicationContracts =
  createReferenceMarketApplicationContracts(referenceMarketErrorRegistry);

export type AnyReferenceMarketApplicationContract =
  (typeof referenceMarketApplicationContracts)[keyof typeof referenceMarketApplicationContracts];
