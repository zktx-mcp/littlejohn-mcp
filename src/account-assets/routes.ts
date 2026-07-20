import { captureCanonicalJson, type ApplicationFailure } from "../core/index.js";
import type {
  RouteContext,
  RouteResult,
  RuntimeRouteRegistry,
} from "../runtime/index.js";
import {
  accountAssetApplicationContracts,
  type AccountAssetApplicationContract,
} from "./contracts.js";
import {
  createAccountAssetFailure,
  normalizeAccountAssetError,
} from "./errors.js";
import {
  accountAssetBrowserRoutes,
  accountAssetCollectionRequestBody,
  accountAssetControlRoutes,
} from "./http-contract.js";
import type { AccountAssetApplicationPort } from "./ports.js";

export {
  accountAssetBrowserRoutes,
  accountAssetCollectionRequestBody,
  accountAssetControlRoutes,
} from "./http-contract.js";

const success = (body: unknown): RouteResult => ({ ok: true, body: captureCanonicalJson(body) });
const failure = (value: ApplicationFailure): RouteResult => ({ ok: false, failure: value });

export const accountAssetApplicationResult = <Input, Success>(
  contract: AccountAssetApplicationContract<Input, Success>,
  request: unknown,
  value: unknown,
): RouteResult => {
  try { return success(contract.parsePublicSuccess(request, value)); }
  catch {
    try { return failure(contract.parseFailure(value)); }
    catch { return failure(normalizeAccountAssetError(value).failure); }
  }
};

export const parseAccountAssetExactPath = (context: Pick<RouteContext, "params">) =>
  accountAssetApplicationContracts.exact.parseInput({
    asset: {
      kind: "erc20",
      chainId: context.params["chainId"],
      address: context.params["tokenAddress"],
    },
  });

export const extendAccountAssetControlRouteRegistry = (input: Readonly<{
  routes: RuntimeRouteRegistry;
  accountAssets: AccountAssetApplicationPort;
}>): RuntimeRouteRegistry => input.routes.extend([{
  method: "POST",
  mutation: "none",
  pathPattern: accountAssetControlRoutes.queries,
  response: "canonical_json",
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
}]);
