import {
  type AccountAssetCollectionRequest,
} from "./contracts.js";

const controlRoot = "/api/v1/internal/control/account-assets";

export const accountAssetCollectionRequestBody = (
  request: AccountAssetCollectionRequest,
) => Object.freeze({
  limit: request.limit,
  ...(request.cursor === null ? {} : { cursor: request.cursor }),
});

export const accountAssetControlRoutes = Object.freeze({
  queries: `${controlRoot}/queries`,
});
