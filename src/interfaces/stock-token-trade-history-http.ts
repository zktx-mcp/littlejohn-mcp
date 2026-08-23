import {
  admitApplicationInput,
  captureCanonicalJson,
  type ApplicationFailure,
} from "../core/index.js";
import {
  createStockTokenTradeHistoryFailure,
  normalizeStockTokenTradeHistoryError,
  stockTokenTradeHistoryApplicationContract,
  stockTokenTradeHistoryInterfaceErrorMappings,
  type StockTokenTradeHistoryApplicationPort,
} from "../stock-token-trade-history/index.js";
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
  stockTokenTradeHistoryInterfaceBinding,
  type StockTokenTradeHistoryInterfaceBinding,
} from "./identities.js";

const success = (body: unknown): RouteResult => ({ ok: true, body: captureCanonicalJson(body) });
const failure = (value: ApplicationFailure): RouteResult => ({ ok: false, failure: value });

export const dispatchStockTokenTradeHistoryRead = async (
  runtime: RuntimeDispatchPort,
  binding: StockTokenTradeHistoryInterfaceBinding,
  value: unknown,
  signal?: AbortSignal,
): Promise<InterfaceInvocationResult> => {
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
    return { ok: false, failure: createStockTokenTradeHistoryFailure("internal_error") };
  }
};

export const stockTokenTradeHistoryApplicationResult = (
  request: unknown,
  value: unknown,
): RouteResult => {
  try { return success(stockTokenTradeHistoryApplicationContract.parsePublicSuccess(request, value)); }
  catch {
    try { return failure(stockTokenTradeHistoryApplicationContract.parseFailure(value)); }
    catch { return failure(normalizeStockTokenTradeHistoryError(value).failure); }
  }
};

const publicReadDefinition = (application: StockTokenTradeHistoryApplicationPort): RouteDefinition =>
  Object.freeze({
    method: "POST",
    mutation: "none",
    pathPattern: stockTokenTradeHistoryInterfaceBinding.http.path,
    successStatus: 200,
    handler: async (context: RouteContext) => {
      const admission = admitApplicationInput(stockTokenTradeHistoryApplicationContract, context.body);
      if (!admission.ok) return failure(admission.failure);
      const result = await application.get(admission.value, context.signal);
      return stockTokenTradeHistoryApplicationResult(admission.value, result);
    },
  });

export const extendStockTokenTradeHistoryInterfaceRoutes = (input: Readonly<{
  routes: RuntimeRouteRegistry;
  tradeHistory: StockTokenTradeHistoryApplicationPort;
}>): RuntimeRouteRegistry => input.routes.extend(
  [publicReadDefinition(input.tradeHistory)],
  stockTokenTradeHistoryInterfaceErrorMappings,
);
