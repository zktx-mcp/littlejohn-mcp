import {
  tokenCatalogApplicationContracts,
  type TokenSelection,
  type TokenSelectionListInput,
  type TokenSelectionListRequest,
} from "./contract-schema.js";

type EvmChainId = TokenSelection["asset"]["chainId"];
type EvmAddress = TokenSelection["asset"]["address"];

const controlRoot = "/api/v1/internal/control/token-catalog";

const selectionPath = (chainId: EvmChainId, tokenAddress: EvmAddress): string => {
  const { asset } = tokenCatalogApplicationContracts.selection.parseInput({
    asset: { kind: "erc20", chainId, address: tokenAddress },
  });
  return `${controlRoot}/selections/${asset.chainId}/${asset.address}`;
};

export const tokenSelectionListRequestBody = (
  request: TokenSelectionListRequest,
): Readonly<TokenSelectionListInput> => Object.freeze({
  limit: request.limit,
  ...(request.cursor === null ? {} : { cursor: request.cursor }),
});

export const tokenCatalogControlRoutes = Object.freeze({
  inspections: `${controlRoot}/inspections`,
  selectionQueries: `${controlRoot}/selection-queries`,
  selectionPattern: `${controlRoot}/selections/{chainId}/{tokenAddress}`,
  selection: selectionPath,
});
