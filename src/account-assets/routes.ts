import { captureCanonicalJson, type ApplicationFailure } from "../core/index.js";
import type {
  RouteResult,
  RuntimeRouteRegistry,
} from "../runtime/http-routing.js";
import {
  accountAssetApplicationContracts,
  type AccountAssetRequestContract,
} from "./contracts.js";
import {
  createAccountAssetFailure,
  normalizeAccountAssetError,
} from "./errors.js";
import {
  accountAssetCollectionRequestBody,
  accountAssetControlRoutes,
} from "./http-contract.js";
import type { AccountAssetApplicationPort } from "./ports.js";
import { accountAssetInterfaceErrorMappings } from "./error-mappings.js";

export {
  accountAssetCollectionRequestBody,
  accountAssetControlRoutes,
} from "./http-contract.js";

const success = (body: unknown): RouteResult => ({ ok: true, body: captureCanonicalJson(body) });
const failure = (value: ApplicationFailure): RouteResult => ({ ok: false, failure: value });

export const accountAssetApplicationResult = <Input, Success>(
  contract: AccountAssetRequestContract<Input, Success>,
  request: unknown,
  value: unknown,
): RouteResult => {
  try { return success(contract.parsePublicSuccess(request, value)); }
  catch {
    try { return failure(contract.parseFailure(value)); }
    catch { return failure(normalizeAccountAssetError(value).failure); }
  }
};

export const extendAccountAssetControlRouteRegistry = (input: Readonly<{
  routes: RuntimeRouteRegistry;
  accountAssets: AccountAssetApplicationPort;
}>): RuntimeRouteRegistry => input.routes.extend([{
  method: "POST",
  mutation: "declared_control",
  pathPattern: accountAssetControlRoutes.queries,
  successStatus: 200,
  handler: async (context) => {
    const contract = accountAssetApplicationContracts.collection;
    let request;
    try { request = contract.parseInput(context.body); }
    catch { return failure(createAccountAssetFailure("invalid_input")); }
    const result = await input.accountAssets.list(
      accountAssetCollectionRequestBody(request),
      context.signal,
    );
    return accountAssetApplicationResult(contract, request, result);
  },
}], accountAssetInterfaceErrorMappings);
