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
  controlBrowserActionJson,
  invalidBrowserResponse,
  queryBrowserJson,
  readBrowserJson,
  type BrowserRequestOptions,
} from "./browser-client.js";
import {
  createDeliveryUnknown,
  type DeliveryUnknown,
} from "../operation-delivery.js";
import { createBrowserOperationId } from "./operation-id.js";

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
    return contract.parsePublicSuccess(
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
    return contract.parsePublicSuccess(
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

export const startTokenRegistration = async (
  chainId: TokenChainId,
  addressInput: unknown,
  settings: TokenRegistrationSettings,
  csrfToken: unknown,
  options: BrowserRequestOptions = {},
): Promise<TokenCatalogOperationStartResult<"register"> | DeliveryUnknown> => {
  const contract = tokenCatalogApplicationContracts.startRegistration;
  const request = contract.parseInput({ asset: tokenAsset(chainId, addressInput), settings });
  const operationId = createBrowserOperationId();
  const delivery = await controlBrowserActionJson(
    "start",
    operationId,
    tokenCatalogBrowserRoutes.operations,
    {
      control: { operationId, interactionInterface: "web" },
      request: { kind: "register", ...request },
    },
    csrfToken,
    options,
  );
  if (delivery.status === "delivery_unknown") return delivery.delivery;
  const value = delivery.value;
  try { return contract.parseBoundSuccess(request, { operationId, interactionInterface: "web" }, value); }
  catch { return createDeliveryUnknown("start", operationId); }
};

export const startTokenRegistrationUpdate = async (
  registration: TokenRegistration,
  changes: TokenRegistrationChanges,
  csrfToken: unknown,
  options: BrowserRequestOptions = {},
): Promise<TokenCatalogOperationStartResult<"update_registration"> | DeliveryUnknown> => {
  const contract = tokenCatalogApplicationContracts.startRegistrationUpdate;
  const request = contract.parseInput({
    asset: registration.asset,
    expectedRevision: registration.revision,
    changes,
  });
  const operationId = createBrowserOperationId();
  const delivery = await controlBrowserActionJson(
    "start",
    operationId,
    tokenCatalogBrowserRoutes.operations,
    {
      control: { operationId, interactionInterface: "web" },
      request: { kind: "update_registration", ...request },
    },
    csrfToken,
    options,
  );
  if (delivery.status === "delivery_unknown") return delivery.delivery;
  const value = delivery.value;
  try { return contract.parseBoundSuccess(request, { operationId, interactionInterface: "web" }, value); }
  catch { return createDeliveryUnknown("start", operationId); }
};

export const startTokenUnregistration = async (
  registration: TokenRegistration,
  csrfToken: unknown,
  options: BrowserRequestOptions = {},
): Promise<TokenCatalogOperationStartResult<"unregister"> | DeliveryUnknown> => {
  const contract = tokenCatalogApplicationContracts.startUnregistration;
  const request = contract.parseInput({
    asset: registration.asset,
    expectedRevision: registration.revision,
  });
  const operationId = createBrowserOperationId();
  const delivery = await controlBrowserActionJson(
    "start",
    operationId,
    tokenCatalogBrowserRoutes.operations,
    {
      control: { operationId, interactionInterface: "web" },
      request: { kind: "unregister", ...request },
    },
    csrfToken,
    options,
  );
  if (delivery.status === "delivery_unknown") return delivery.delivery;
  const value = delivery.value;
  try { return contract.parseBoundSuccess(request, { operationId, interactionInterface: "web" }, value); }
  catch { return createDeliveryUnknown("start", operationId); }
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
    return contract.parsePublicSuccess(
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
): Promise<TokenCatalogConfirmedOperation | DeliveryUnknown> => {
  const request = tokenCatalogOperationConfirmationContract.parseInput({
    operationId: operation.operationId,
    reviewDigest: operation.review.reviewDigest,
  });
  const operationId = request.operationId;
  const delivery = await controlBrowserActionJson(
    "confirm",
    operationId,
    tokenCatalogBrowserRoutes.confirmation(operationId),
    { reviewDigest: operation.review.reviewDigest },
    csrfToken,
    options,
  );
  if (delivery.status === "delivery_unknown") return delivery.delivery;
  const value = delivery.value;
  try {
    return tokenCatalogOperationConfirmationContract.parseBoundSuccess(
      request,
      { operationId, interactionInterface: "web" },
      value,
    );
  } catch (error) {
    if (error instanceof BrowserResponseError) throw error;
    return createDeliveryUnknown("confirm", operationId);
  }
};

export const cancelTokenOperation = async (
  operationId: TokenCatalogOperation["operationId"],
  csrfToken: unknown,
  options: BrowserRequestOptions = {},
): Promise<TokenCatalogCancellationResult | DeliveryUnknown> => {
  const contract = tokenCatalogApplicationContracts.cancelOperation;
  const request = contract.parseInput({ operationId });
  const delivery = await controlBrowserActionJson(
    "cancel",
    request.operationId,
    tokenCatalogBrowserRoutes.cancellation(request.operationId),
    {},
    csrfToken,
    options,
  );
  if (delivery.status === "delivery_unknown") return delivery.delivery;
  const value = delivery.value;
  try {
    const result = contract.parsePublicSuccess(
      request,
      value,
    );
    if (result.operation.state !== "cancelled") {
      return createDeliveryUnknown("cancel", request.operationId);
    }
    return result;
  } catch (error) {
    if (error instanceof BrowserResponseError) throw error;
    return createDeliveryUnknown("cancel", request.operationId);
  }
};
