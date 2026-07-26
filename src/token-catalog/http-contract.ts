import {
  tokenCatalogApplicationContracts,
  tokenCatalogOperationIdSchema,
  type TokenCatalogOperation,
  type TokenSelection,
  type TokenSelectionListInput,
  type TokenSelectionListRequest,
} from "./contract-schema.js";

type EvmChainId = TokenSelection["asset"]["chainId"];
type EvmAddress = TokenSelection["asset"]["address"];

const browserRoot = "/api/v1/token-catalog";
const browserOperationsRoot = `${browserRoot}/operations`;
const controlRoot = "/api/v1/internal/control/token-catalog";
const controlOperationsRoot = `${controlRoot}/operations`;

const operationPath = (
  root: string,
  operationId: TokenCatalogOperation["operationId"],
  action?: string,
): string => `${root}/${tokenCatalogOperationIdSchema.parse(operationId)}${
  action === undefined ? "" : `/${action}`
}`;

const selectionPath = (
  root: string,
  chainId: EvmChainId,
  tokenAddress: EvmAddress,
): string => {
  const { asset } = tokenCatalogApplicationContracts.selection.parseInput({
    asset: { kind: "erc20", chainId, address: tokenAddress },
  });
  return `${root}/${asset.chainId}/${asset.address}`;
};

export const tokenSelectionListRequestBody = (
  request: TokenSelectionListRequest,
): Readonly<TokenSelectionListInput> => Object.freeze({
  limit: request.limit,
  ...(request.cursor === null ? {} : { cursor: request.cursor }),
});

export const tokenCatalogBrowserRoutes = Object.freeze({
  root: browserRoot,
  selectionQueries: `${browserRoot}/selection-queries`,
  selectionPattern: `${browserRoot}/selections/{chainId}/{tokenAddress}`,
  operations: browserOperationsRoot,
  currentOperation: `${browserRoot}/current-operation`,
  operationPattern: `${browserOperationsRoot}/{operationId}`,
  confirmationPattern: `${browserOperationsRoot}/{operationId}/confirmation`,
  cancellationPattern: `${browserOperationsRoot}/{operationId}/cancellation`,
  selection: (chainId: EvmChainId, tokenAddress: EvmAddress): string =>
    selectionPath(`${browserRoot}/selections`, chainId, tokenAddress),
  operation: (operationId: TokenCatalogOperation["operationId"]): string =>
    operationPath(browserOperationsRoot, operationId),
  confirmation: (operationId: TokenCatalogOperation["operationId"]): string =>
    operationPath(browserOperationsRoot, operationId, "confirmation"),
  cancellation: (operationId: TokenCatalogOperation["operationId"]): string =>
    operationPath(browserOperationsRoot, operationId, "cancellation"),
});

export const tokenCatalogControlRoutes = Object.freeze({
  inspections: `${controlRoot}/inspections`,
  selectionQueries: `${controlRoot}/selection-queries`,
  selectionPattern: `${controlRoot}/selections/{chainId}/{tokenAddress}`,
  operations: controlOperationsRoot,
  operationPattern: `${controlOperationsRoot}/{operationId}`,
  confirmationPattern: `${controlOperationsRoot}/{operationId}/confirmation`,
  selection: (chainId: EvmChainId, tokenAddress: EvmAddress): string =>
    selectionPath(`${controlRoot}/selections`, chainId, tokenAddress),
  operation: (operationId: TokenCatalogOperation["operationId"]): string =>
    operationPath(controlOperationsRoot, operationId),
  confirmation: (operationId: TokenCatalogOperation["operationId"]): string =>
    operationPath(controlOperationsRoot, operationId, "confirmation"),
});
