import {
  accountAssetApplicationContracts,
  accountAssetBrowserRoutes,
  accountAssetCollectionRequestBody,
  accountAssetExactRequestBody,
  accountAssetOfficialCandidateQueryContract,
  accountAssetOfficialCandidateRequestBody,
  type AccountAssetCollectionInput,
  type AccountAssetCollectionSuccess,
  type AccountAssetExactSuccess,
  type AccountAssetOfficialCandidateInput,
  type AccountAssetOfficialCandidateSuccess,
  type AccountAssetViewRevision,
} from "../../account-assets/browser.js";
import type { TokenSelection } from "../../token-catalog/browser.js";
import {
  BrowserResponseError,
  invalidBrowserResponse,
  queryBrowserJson,
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
    if (error instanceof BrowserResponseError) throw error;
    throw invalidAccountAssetResponse();
  }
};

export const loadOfficialAssetCandidates = async (
  input: AccountAssetOfficialCandidateInput,
  options: BrowserRequestOptions = {},
): Promise<AccountAssetOfficialCandidateSuccess> => {
  const contract = accountAssetOfficialCandidateQueryContract;
  const request = contract.parseInput(input);
  try {
    return contract.parsePublicSuccess(
      request,
      await queryBrowserJson(
        accountAssetBrowserRoutes.officialCandidateQueries,
        accountAssetOfficialCandidateRequestBody(request),
        options,
      ),
    );
  } catch (error) {
    if (error instanceof BrowserResponseError) throw error;
    throw invalidAccountAssetResponse();
  }
};
