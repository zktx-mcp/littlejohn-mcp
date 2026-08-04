import {
  parseCapabilityInput,
  parseCapabilitySuccess,
  parseEvmAddressInput,
} from "../../core/browser.js";
import {
  tokenCatalogBrowserRoutes,
  tokenCatalogCurrentOperationSchema,
  tokenCatalogOperationConfirmationContract,
  tokenInspectCapability,
  type TokenCatalogCancellationResult,
  type TokenCatalogConfirmedOperation,
  type TokenCatalogOperation,
  type TokenCatalogOperationResult,
  type TokenCatalogOperationStartResult,
  type TokenInspectionSuccess,
  type TokenSelection,
} from "../../token-catalog/browser.js";
import { browserCapabilityBindings } from "../browser-capability-bindings.js";
import { publicInspectionPaths } from "../browser-contract.js";
import {
  BrowserRequestError,
  controlBrowserActionJson,
  invalidBrowserResponse,
  queryPublicBrowserJson,
  readBrowserJson,
  type BrowserRequestOptions,
} from "./browser-client.js";
import {
  createDeliveryUnknown,
  type DeliveryUnknown,
} from "../operation-delivery.js";
import { createBrowserOperationId } from "./operation-id.js";

const invalidCatalogResponse = (): BrowserRequestError =>
  invalidBrowserResponse();

const invalidInspectionResponse = (): BrowserRequestError =>
  invalidBrowserResponse();

type TokenChainId = TokenSelection["asset"]["chainId"];
type TokenAddress = TokenSelection["asset"]["address"];

const tokenAsset = (chainId: TokenChainId, addressInput: unknown) => Object.freeze({
  kind: "erc20" as const,
  chainId,
  address: parseEvmAddressInput(addressInput),
});

export const parseTokenAddressInput = (input: unknown): TokenAddress =>
  parseEvmAddressInput(input);

export const inspectTokenContract = async (
  input: unknown,
  options: BrowserRequestOptions = {},
): Promise<TokenInspectionSuccess> => {
  const request = parseCapabilityInput(tokenInspectCapability, input);
  try {
    return parseCapabilitySuccess(
      tokenInspectCapability,
      request,
      await queryPublicBrowserJson(
        publicInspectionPaths.tokenQueries,
        request,
        options,
      ),
    );
  } catch (error) {
    if (error instanceof BrowserRequestError) throw error;
    throw invalidInspectionResponse();
  }
};

export const startTokenSelection = async (
  chainId: TokenChainId,
  addressInput: unknown,
  csrfToken: unknown,
  options: BrowserRequestOptions = {},
): Promise<TokenCatalogOperationStartResult<"add"> | DeliveryUnknown> => {
  const contract = browserCapabilityBindings.tokenStartAddition.contract;
  const request = contract.parseInput({ asset: tokenAsset(chainId, addressInput) });
  const operationId = createBrowserOperationId();
  const delivery = await controlBrowserActionJson(
    "start",
    operationId,
    tokenCatalogBrowserRoutes.operations,
    {
      control: { operationId, interactionInterface: "web" },
      request: { kind: "add", ...request },
    },
    csrfToken,
    options,
  );
  if (delivery.status === "delivery_unknown") return delivery.delivery;
  const value = delivery.value;
  try { return contract.parseBoundSuccess(request, { operationId, interactionInterface: "web" }, value); }
  catch { return createDeliveryUnknown("start", operationId); }
};

export const startTokenRemoval = async (
  selection: TokenSelection,
  csrfToken: unknown,
  options: BrowserRequestOptions = {},
): Promise<TokenCatalogOperationStartResult<"remove"> | DeliveryUnknown> => {
  const contract = browserCapabilityBindings.tokenStartRemoval.contract;
  const request = contract.parseInput({
    asset: selection.asset,
    expectedRevision: selection.revision,
  });
  const operationId = createBrowserOperationId();
  const delivery = await controlBrowserActionJson(
    "start",
    operationId,
    tokenCatalogBrowserRoutes.operations,
    {
      control: { operationId, interactionInterface: "web" },
      request: { kind: "remove", ...request },
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
    if (error instanceof BrowserRequestError) throw error;
    throw invalidCatalogResponse();
  }
};

export const loadTokenOperation = async (
  operationId: TokenCatalogOperation["operationId"],
  options: BrowserRequestOptions = {},
): Promise<TokenCatalogOperationResult> => {
  const contract = browserCapabilityBindings.tokenOperation.contract;
  const request = contract.parseInput({ operationId });
  try {
    return contract.parsePublicSuccess(
      request,
      await readBrowserJson(tokenCatalogBrowserRoutes.operation(request.operationId), options),
    );
  } catch (error) {
    if (error instanceof BrowserRequestError) throw error;
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
    if (error instanceof BrowserRequestError) throw error;
    return createDeliveryUnknown("confirm", operationId);
  }
};

export const cancelTokenOperation = async (
  operationId: TokenCatalogOperation["operationId"],
  csrfToken: unknown,
  options: BrowserRequestOptions = {},
): Promise<TokenCatalogCancellationResult | DeliveryUnknown> => {
  const contract = browserCapabilityBindings.tokenCancelOperation.contract;
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
    return contract.parsePublicSuccess(
      request,
      value,
    );
  } catch (error) {
    if (error instanceof BrowserRequestError) throw error;
    return createDeliveryUnknown("cancel", request.operationId);
  }
};
