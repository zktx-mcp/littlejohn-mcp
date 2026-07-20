import type { EvmAddress } from "../core/index.js";
import {
  accountAssetApplicationContracts,
  type AccountAssetCollectionRequest,
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
  exactPattern: `${browserRoot}/{chainId}/{tokenAddress}`,
  exact(chainId: string, tokenAddress: EvmAddress): string {
    const request = accountAssetApplicationContracts.exact.parseInput({
      asset: { kind: "erc20", chainId, address: tokenAddress },
    });
    return `${browserRoot}/${request.asset.chainId}/${request.asset.address}`;
  },
});

export const accountAssetControlRoutes = Object.freeze({
  queries: `${controlRoot}/queries`,
});
