import {
  admitApplicationInput,
  captureCanonicalJson,
  type ApplicationFailure,
} from "../core/index.js";
import {
  createMarketPortfolioFailure,
  normalizeMarketPortfolioError,
  marketPortfolioApplicationContracts,
  marketPortfolioInterfaceErrorMappings,
  type MarketPortfolioApplicationContract,
  type MarketPortfolioApplicationPort,
} from "../market-portfolio/index.js";
import type {
  RouteContext,
  RouteDefinition,
  RouteResult,
  RuntimeRouteRegistry,
} from "../runtime/http-routing.js";
import {
  constrainInterfaceFailure,
  dispatchCanonical,
  type InterfaceInvocationResult,
  type RuntimeDispatchPort,
} from "./http-client.js";
import {
  marketPortfolioInterfaceBindings,
  type MarketPortfolioInterfaceBinding,
} from "./identities.js";

const success = (body: unknown): RouteResult => ({ ok: true, body: captureCanonicalJson(body) });
const failure = (value: ApplicationFailure): RouteResult => ({ ok: false, failure: value });

export const dispatchMarketPortfolioRead = async (
  runtime: RuntimeDispatchPort,
  binding: MarketPortfolioInterfaceBinding,
  value: unknown,
  signal?: AbortSignal,
): Promise<InterfaceInvocationResult> => {
  if (
    binding.action !== "price" &&
    binding.action !== "history" &&
    binding.action !== "stockTokenMarket" &&
    binding.action !== "watchlist"
  ) {
    throw new TypeError("Market portfolio binding is not a read.");
  }
  const admission = admitApplicationInput(binding.contract, value);
  if (!admission.ok) return admission;
  const input = admission.value;
  const result = constrainInterfaceFailure(await dispatchCanonical(runtime, {
    requestClass: "public_read",
    method: binding.http.method,
    path: binding.http.path,
    body: captureCanonicalJson(input),
    ...(signal === undefined ? {} : { signal }),
  }, 200, binding.responseAuthority), binding.contract.failureCodes);
  if (!result.ok) return result;
  try {
    return {
      ok: true,
      value: captureCanonicalJson(binding.contract.parsePublicSuccess(input, result.value)),
    };
  } catch {
    return { ok: false, failure: createMarketPortfolioFailure("internal_error") };
  }
};

export const marketPortfolioApplicationResult = <Input, Success>(
  contract: MarketPortfolioApplicationContract<Input, Success>,
  request: unknown,
  value: unknown,
): RouteResult => {
  try { return success(contract.parsePublicSuccess(request, value)); }
  catch {
    try { return failure(contract.parseFailure(value)); }
    catch { return failure(normalizeMarketPortfolioError(value).failure); }
  }
};

const readRoute = <Input, Success>(input: Readonly<{
  path: string;
  contract: MarketPortfolioApplicationContract<Input, Success>;
  invoke(request: Input, signal: AbortSignal): Promise<Success | ApplicationFailure>;
}>): RouteDefinition => Object.freeze({
  method: "POST",
  mutation: "none",
  pathPattern: input.path,
  successStatus: 200,
  handler: async (context: RouteContext) => {
    const admission = admitApplicationInput(input.contract, context.body);
    if (!admission.ok) return failure(admission.failure);
    const result = await input.invoke(admission.value, context.signal);
    return marketPortfolioApplicationResult(input.contract, admission.value, result);
  },
});

const publicReadDefinitions = (application: MarketPortfolioApplicationPort): readonly RouteDefinition[] =>
  Object.freeze([
    readRoute({
      path: marketPortfolioInterfaceBindings.price.http.path,
      contract: marketPortfolioInterfaceBindings.price.contract,
      invoke: (request, signal) => application.price(request, signal),
    }),
    readRoute({
      path: marketPortfolioInterfaceBindings.history.http.path,
      contract: marketPortfolioInterfaceBindings.history.contract,
      invoke: (request, signal) => application.history(request, signal),
    }),
    readRoute({
      path: marketPortfolioInterfaceBindings.stockTokenMarket.http.path,
      contract: marketPortfolioInterfaceBindings.stockTokenMarket.contract,
      invoke: (request, signal) => application.stockTokenMarket(request, signal),
    }),
    readRoute({
      path: marketPortfolioInterfaceBindings.watchlist.http.path,
      contract: marketPortfolioApplicationContracts.watchlist,
      invoke: (request, signal) => application.watchlist(request, signal),
    }),
  ]);

export const extendMarketPortfolioInterfaceRoutes = (input: Readonly<{
  routes: RuntimeRouteRegistry;
  markets: MarketPortfolioApplicationPort;
}>): RuntimeRouteRegistry => input.routes.extend(
  publicReadDefinitions(input.markets),
  marketPortfolioInterfaceErrorMappings,
);
