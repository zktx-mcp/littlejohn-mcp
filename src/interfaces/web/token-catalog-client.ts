import {
  parseEvmAddressInput,
} from "../../core/browser.js";
import {
  tokenCatalogApplicationContracts,
  tokenCatalogBrowserRoutes,
  tokenCatalogCurrentOperationSchema,
  tokenCatalogOperationConfirmationContract,
  tokenRegistrationListRequestBody,
  type TokenCatalogCancellationResult,
  type TokenCatalogConfirmedOperation,
  type TokenCatalogOperation,
  type TokenCatalogOperationResult,
  type TokenCatalogOperationStartResult,
  type TokenRegistration,
  type TokenRegistrationChanges,
  type TokenRegistrationListInput,
  type TokenRegistrationListResult,
  type TokenRegistrationSettings,
  type TokenRegistrationWithInspection,
} from "../../token-catalog/browser.js";
import {
  BrowserResponseError,
  controlBrowserJson,
  invalidBrowserResponse,
  queryBrowserJson,
  readBrowserJson,
  type BrowserRequestOptions,
} from "./browser-client.js";

const invalidCatalogResponse = (): BrowserResponseError =>
  invalidBrowserResponse("The token catalog response is invalid.");

type TokenChainId = TokenRegistration["asset"]["chainId"];
type TokenAddress = TokenRegistration["asset"]["address"];

const tokenAsset = (chainId: TokenChainId, addressInput: unknown) => Object.freeze({
  kind: "erc20" as const,
  chainId,
  address: parseEvmAddressInput(addressInput),
});

export const parseTokenAddressInput = (input: unknown): TokenAddress =>
  parseEvmAddressInput(input);

export const loadTokenRegistrations = async (
  input: TokenRegistrationListInput = {},
  options: BrowserRequestOptions = {},
): Promise<TokenRegistrationListResult> => {
  const contract = tokenCatalogApplicationContracts.registrations;
  const request = contract.parseInput(input);
  try {
    return contract.parseSuccess(
      request,
      await queryBrowserJson(
        tokenCatalogBrowserRoutes.registrationQueries,
        tokenRegistrationListRequestBody(request),
        options,
      ),
    );
  } catch (error) {
    if (error instanceof BrowserResponseError) throw error;
    throw invalidCatalogResponse();
  }
};

export const loadTokenRegistration = async (
  chainId: TokenChainId,
  addressInput: unknown,
  options: BrowserRequestOptions = {},
): Promise<TokenRegistrationWithInspection> => {
  const contract = tokenCatalogApplicationContracts.registration;
  const request = contract.parseInput({ asset: tokenAsset(chainId, addressInput) });
  try {
    return contract.parseSuccess(
      request,
      await readBrowserJson(
        tokenCatalogBrowserRoutes.registration(request.asset.chainId, request.asset.address),
        options,
      ),
    );
  } catch (error) {
    if (error instanceof BrowserResponseError) throw error;
    throw invalidCatalogResponse();
  }
};

export const startTokenRegistration = (
  chainId: TokenChainId,
  addressInput: unknown,
  settings: TokenRegistrationSettings,
  csrfToken: unknown,
  options: BrowserRequestOptions = {},
): Promise<TokenCatalogOperationStartResult<"register">> => {
  const contract = tokenCatalogApplicationContracts.startRegistration;
  const request = contract.parseInput({ asset: tokenAsset(chainId, addressInput), settings });
  return controlBrowserJson(
    tokenCatalogBrowserRoutes.operations,
    { kind: "register", ...request },
    csrfToken,
    options,
  ).then((value) => {
    try { return contract.parseSuccess(request, value); }
    catch { throw invalidCatalogResponse(); }
  });
};

export const startTokenRegistrationUpdate = (
  registration: TokenRegistration,
  changes: TokenRegistrationChanges,
  csrfToken: unknown,
  options: BrowserRequestOptions = {},
): Promise<TokenCatalogOperationStartResult<"update_registration">> => {
  const contract = tokenCatalogApplicationContracts.startRegistrationUpdate;
  const request = contract.parseInput({
    asset: registration.asset,
    expectedRevision: registration.revision,
    changes,
  });
  return controlBrowserJson(
    tokenCatalogBrowserRoutes.operations,
    { kind: "update_registration", ...request },
    csrfToken,
    options,
  ).then((value) => {
    try { return contract.parseSuccess(request, value); }
    catch { throw invalidCatalogResponse(); }
  });
};

export const startTokenUnregistration = (
  registration: TokenRegistration,
  csrfToken: unknown,
  options: BrowserRequestOptions = {},
): Promise<TokenCatalogOperationStartResult<"unregister">> => {
  const contract = tokenCatalogApplicationContracts.startUnregistration;
  const request = contract.parseInput({
    asset: registration.asset,
    expectedRevision: registration.revision,
  });
  return controlBrowserJson(
    tokenCatalogBrowserRoutes.operations,
    { kind: "unregister", ...request },
    csrfToken,
    options,
  ).then((value) => {
    try { return contract.parseSuccess(request, value); }
    catch { throw invalidCatalogResponse(); }
  });
};

export const loadCurrentTokenOperation = async (
  options: BrowserRequestOptions = {},
): Promise<TokenCatalogOperation | null> => {
  try {
    return tokenCatalogCurrentOperationSchema.parse(
      await readBrowserJson(tokenCatalogBrowserRoutes.currentOperation, options),
    ).operation;
  } catch (error) {
    if (error instanceof BrowserResponseError) throw error;
    throw invalidCatalogResponse();
  }
};

export const loadTokenOperation = async (
  operationId: TokenCatalogOperation["operationId"],
  options: BrowserRequestOptions = {},
): Promise<TokenCatalogOperationResult> => {
  const contract = tokenCatalogApplicationContracts.operation;
  const request = contract.parseInput({ operationId });
  try {
    return contract.parseSuccess(
      request,
      await readBrowserJson(tokenCatalogBrowserRoutes.operation(request.operationId), options),
    );
  } catch (error) {
    if (error instanceof BrowserResponseError) throw error;
    throw invalidCatalogResponse();
  }
};

export const confirmTokenOperation = async (
  operation: TokenCatalogOperation,
  csrfToken: unknown,
  options: BrowserRequestOptions = {},
): Promise<TokenCatalogConfirmedOperation> => {
  const request = tokenCatalogOperationConfirmationContract.parseInput({
    operationId: operation.operationId,
    reviewDigest: operation.review.reviewDigest,
  });
  try {
    return tokenCatalogOperationConfirmationContract.parseSuccess(
      request,
      await controlBrowserJson(
        tokenCatalogBrowserRoutes.confirmation(operation.operationId),
        { reviewDigest: operation.review.reviewDigest },
        csrfToken,
        options,
      ),
    );
  } catch (error) {
    if (error instanceof BrowserResponseError) throw error;
    throw invalidCatalogResponse();
  }
};

export const cancelTokenOperation = async (
  operationId: TokenCatalogOperation["operationId"],
  csrfToken: unknown,
  options: BrowserRequestOptions = {},
): Promise<TokenCatalogCancellationResult> => {
  const contract = tokenCatalogApplicationContracts.cancelOperation;
  const request = contract.parseInput({ operationId });
  try {
    return contract.parseSuccess(
      request,
      await controlBrowserJson(
        tokenCatalogBrowserRoutes.cancellation(request.operationId),
        {},
        csrfToken,
        options,
      ),
    );
  } catch (error) {
    if (error instanceof BrowserResponseError) throw error;
    throw invalidCatalogResponse();
  }
};
