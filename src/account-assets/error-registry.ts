import { coreErrorRegistry } from "../core/browser.js";
import { chainErrorDefinitions } from "../chain/error-definitions.js";
import { runtimeErrorDefinitions } from "../runtime/error-definitions.js";
import { tokenCatalogErrorDefinitions } from "../token-catalog/error-definitions.js";
import { walletErrorDefinitions } from "../wallet/error-definitions.js";

export const accountAssetErrorRegistry = coreErrorRegistry
  .extend(runtimeErrorDefinitions)
  .extend(walletErrorDefinitions)
  .extend(chainErrorDefinitions)
  .extend(tokenCatalogErrorDefinitions);
