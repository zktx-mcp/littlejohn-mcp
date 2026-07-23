import { tokenCatalogErrorRegistry } from "../token-catalog/errors.js";
import { referenceMarketErrorDefinitions } from "./error-definitions.js";

export const referenceMarketErrorRegistry = tokenCatalogErrorRegistry.extend(referenceMarketErrorDefinitions);
