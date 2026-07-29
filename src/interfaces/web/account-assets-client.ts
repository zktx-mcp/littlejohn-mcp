import {
  accountAssetApplicationContracts,
  accountAssetBrowserRoutes,
  accountAssetExactRequestBody,
  accountAssetOverviewQueryContract,
  type AccountAssetExactSuccess,
  type AccountAssetOverviewSuccess,
  type AccountAssetViewRevision,
} from "../../account-assets/browser.js";
import type { TokenSelection } from "../../token-catalog/browser.js";
import {
  BrowserRequestError,
  invalidBrowserResponse,
  queryBrowserJson,
  readBrowserJson,
  type BrowserRequestOptions,
} from "./browser-client.js";

const invalidAccountAssetResponse = (): BrowserRequestError =>
  invalidBrowserResponse();

export const loadAccountAssetsOverview = async (
  options: BrowserRequestOptions = {},
): Promise<AccountAssetOverviewSuccess> => {
  const contract = accountAssetOverviewQueryContract;
  const request = contract.parseInput({});
  try {
    return contract.parsePublicSuccess(
      request,
      await readBrowserJson(
        accountAssetBrowserRoutes.overview,
        options,
      ),
    );
  } catch (error) {
    if (error instanceof BrowserRequestError) throw error;
    throw invalidAccountAssetResponse();
  }
};

export const loadExactAccountAsset = async (
  asset: TokenSelection["asset"],
  viewRevision: AccountAssetViewRevision,
  options: BrowserRequestOptions = {},
): Promise<AccountAssetExactSuccess> => {
  const contract = accountAssetApplicationContracts.exact;
  const request = contract.parseInput({ asset, viewRevision });
  try {
    return contract.parsePublicSuccess(
      request,
      await queryBrowserJson(
        accountAssetBrowserRoutes.exact(request.asset.chainId, request.asset.address),
        accountAssetExactRequestBody(request.viewRevision),
        options,
      ),
    );
  } catch (error) {
    if (error instanceof BrowserRequestError) throw error;
    throw invalidAccountAssetResponse();
  }
};
