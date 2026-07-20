import {
  accountAssetApplicationContracts,
  accountAssetBrowserRoutes,
  accountAssetCollectionRequestBody,
  type AccountAssetCollectionInput,
  type AccountAssetCollectionSuccess,
  type AccountAssetExactSuccess,
} from "../../account-assets/browser.js";
import type { TokenRegistration } from "../../token-catalog/browser.js";
import {
  BrowserResponseError,
  invalidBrowserResponse,
  queryBrowserJson,
  readBrowserJson,
  type BrowserRequestOptions,
} from "./browser-client.js";

const invalidAccountAssetResponse = (): BrowserResponseError =>
  invalidBrowserResponse("The account asset response is invalid.");

export const loadAccountAssets = async (
  input: AccountAssetCollectionInput = {},
  options: BrowserRequestOptions = {},
): Promise<AccountAssetCollectionSuccess> => {
  const contract = accountAssetApplicationContracts.collection;
  const request = contract.parseInput(input);
  try {
    return contract.parsePublicSuccess(
      request,
      await queryBrowserJson(
        accountAssetBrowserRoutes.queries,
        accountAssetCollectionRequestBody(request),
        options,
      ),
    );
  } catch (error) {
    if (error instanceof BrowserResponseError) throw error;
    throw invalidAccountAssetResponse();
  }
};

export const loadExactAccountAsset = async (
  asset: TokenRegistration["asset"],
  options: BrowserRequestOptions = {},
): Promise<AccountAssetExactSuccess> => {
  const contract = accountAssetApplicationContracts.exact;
  const request = contract.parseInput({ asset });
  try {
    return contract.parsePublicSuccess(
      request,
      await readBrowserJson(
        accountAssetBrowserRoutes.exact(request.asset.chainId, request.asset.address),
        options,
      ),
    );
  } catch (error) {
    if (error instanceof BrowserResponseError) throw error;
    throw invalidAccountAssetResponse();
  }
};
