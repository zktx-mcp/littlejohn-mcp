import { erc20AssetIdentitySchema, type EvmAddress } from "../core/browser.js";
import {
  accountAssetApplicationContracts,
  type AccountAssetCollectionRequest,
  type AccountAssetOfficialCandidateRequest,
  type AccountAssetViewRevision,
} from "./contracts.js";

const browserRoot = "/api/v1/account-assets";
const controlRoot = "/api/v1/internal/control/account-assets";

export const accountAssetCollectionRequestBody = (
  request: AccountAssetCollectionRequest,
) => Object.freeze({
  limit: request.limit,
  ...(request.cursor === null ? {} : { cursor: request.cursor }),
});

export const accountAssetBrowserRoutes = Object.freeze({
  queries: `${browserRoot}/queries`,
  officialCandidateQueries: `${browserRoot}/official-candidate-queries`,
  exactPattern: `${browserRoot}/{chainId}/{tokenAddress}`,
  exact(chainId: string, tokenAddress: EvmAddress): string {
    const asset = erc20AssetIdentitySchema.parse({
      kind: "erc20", chainId, address: tokenAddress,
    });
    return `${browserRoot}/${asset.chainId}/${asset.address}`;
  },
});

export const accountAssetExactRequestBody = (viewRevision: AccountAssetViewRevision) =>
  Object.freeze({ viewRevision });

export const accountAssetOfficialCandidateRequestBody = (
  request: AccountAssetOfficialCandidateRequest,
) => Object.freeze({
  viewRevision: request.viewRevision,
  ...(request.cursor === null ? {} : { cursor: request.cursor }),
});

export const accountAssetControlRoutes = Object.freeze({
  queries: `${controlRoot}/queries`,
});
