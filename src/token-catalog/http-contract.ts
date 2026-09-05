import {
  tokenCatalogApplicationContracts,
  type TokenSelectionInput,
  type TokenSelectionListInput,
  type TokenSelectionListRequest,
  type TokenSelectionRequest,
} from "./contract-schema.js";

const controlRoot = "/api/v1/internal/control/token-catalog";

export const tokenSelectionRequestBody = (
  request: TokenSelectionRequest,
): Readonly<TokenSelectionInput> => Object.freeze({
  account: request.account,
  asset: request.asset,
});

export const tokenSelectionListRequestBody = (
  request: TokenSelectionListRequest,
): Readonly<TokenSelectionListInput> => Object.freeze({
  account: request.account,
  limit: request.limit,
  ...(request.cursor === null ? {} : { cursor: request.cursor }),
});

export const tokenCatalogControlRoutes = Object.freeze({
  inspections: `${controlRoot}/inspections`,
  selectionQueries: `${controlRoot}/selection-queries`,
  selectionListQueries: `${controlRoot}/selection-list-queries`,
});
