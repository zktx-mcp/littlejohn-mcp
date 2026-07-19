import {
  tokenCatalogApplicationContracts,
  tokenCatalogOperationIdSchema,
  type TokenCatalogOperation,
  type TokenRegistration,
  type TokenRegistrationListInput,
  type TokenRegistrationListRequest,
} from "./contract-schema.js";

type EvmChainId = TokenRegistration["asset"]["chainId"];
type EvmAddress = TokenRegistration["asset"]["address"];

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

const registrationPath = (
  root: string,
  chainId: EvmChainId,
  tokenAddress: EvmAddress,
): string => {
  const { asset } = tokenCatalogApplicationContracts.registration.parseInput({
    asset: { kind: "erc20", chainId, address: tokenAddress },
  });
  return `${root}/${asset.chainId}/${asset.address}`;
};

export const tokenRegistrationListRequestBody = (
  request: TokenRegistrationListRequest,
): Readonly<TokenRegistrationListInput> => Object.freeze({
  limit: request.limit,
  ...(request.cursor === null ? {} : { cursor: request.cursor }),
});

export const tokenCatalogBrowserRoutes = Object.freeze({
  root: browserRoot,
  inspections: `${browserRoot}/inspections`,
  registrationQueries: `${browserRoot}/registration-queries`,
  registrationPattern: `${browserRoot}/registrations/{chainId}/{tokenAddress}`,
  operations: browserOperationsRoot,
  currentOperation: `${browserRoot}/current-operation`,
  operationPattern: `${browserOperationsRoot}/{operationId}`,
  confirmationPattern: `${browserOperationsRoot}/{operationId}/confirmation`,
  cancellationPattern: `${browserOperationsRoot}/{operationId}/cancellation`,
  registration: (chainId: EvmChainId, tokenAddress: EvmAddress): string =>
    registrationPath(`${browserRoot}/registrations`, chainId, tokenAddress),
  operation: (operationId: TokenCatalogOperation["operationId"]): string =>
    operationPath(browserOperationsRoot, operationId),
  confirmation: (operationId: TokenCatalogOperation["operationId"]): string =>
    operationPath(browserOperationsRoot, operationId, "confirmation"),
  cancellation: (operationId: TokenCatalogOperation["operationId"]): string =>
    operationPath(browserOperationsRoot, operationId, "cancellation"),
});

export const tokenCatalogControlRoutes = Object.freeze({
  inspections: `${controlRoot}/inspections`,
  registrationQueries: `${controlRoot}/registration-queries`,
  registrationPattern: `${controlRoot}/registrations/{chainId}/{tokenAddress}`,
  operations: controlOperationsRoot,
  operationPattern: `${controlOperationsRoot}/{operationId}`,
  confirmationPattern: `${controlOperationsRoot}/{operationId}/confirmation`,
  registration: (chainId: EvmChainId, tokenAddress: EvmAddress): string =>
    registrationPath(`${controlRoot}/registrations`, chainId, tokenAddress),
  operation: (operationId: TokenCatalogOperation["operationId"]): string =>
    operationPath(controlOperationsRoot, operationId),
  confirmation: (operationId: TokenCatalogOperation["operationId"]): string =>
    operationPath(controlOperationsRoot, operationId, "confirmation"),
});
