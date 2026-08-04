import {
  captureCanonicalJson,
  type ApplicationFailure,
} from "../core/index.js";
import {
  createReferenceMarketFailure,
  normalizeReferenceMarketError,
  referenceMarketApplicationContracts,
  referenceMarketInterfaceErrorMappings,
  type ReferenceMarketApplicationContract,
  type ReferenceMarketApplicationPort,
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
import { referenceMarketPublicRoutes } from "./browser-contract.js";
import { browserCapabilityBindings } from "./browser-capability-bindings.js";
import {
  referenceMarketLocalMutationPaths,
  type ReferenceMarketInterfaceBinding,
} from "./identities.js";
import {
  referenceMarketDeliveryActions,
  type ReferenceMarketDeliveryAction,
} from "./reference-market-delivery.js";

const success = (body: unknown): RouteResult => ({ ok: true, body: captureCanonicalJson(body) });
const failure = (value: ApplicationFailure): RouteResult => ({ ok: false, failure: value });

export const dispatchReferenceMarketRead = async (
  runtime: RuntimeDispatchPort,
  binding: ReferenceMarketInterfaceBinding,
  value: unknown,
  signal?: AbortSignal,
): Promise<InterfaceInvocationResult> => {
  if (binding.action !== "price" && binding.action !== "history" && binding.action !== "watchlist") {
    throw new TypeError("Reference market binding is not a read.");
  }
  let input: unknown;
  try { input = binding.contract.parseInput(value); }
  catch { return { ok: false, failure: createReferenceMarketFailure("invalid_input") }; }
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
    return { ok: false, failure: createReferenceMarketFailure("internal_error") };
  }
};

export const referenceMarketApplicationResult = <Input, Success>(
  contract: ReferenceMarketApplicationContract<Input, Success>,
  request: unknown,
  value: unknown,
): RouteResult => {
  try { return success(contract.parsePublicSuccess(request, value)); }
  catch {
    try { return failure(contract.parseFailure(value)); }
    catch { return failure(normalizeReferenceMarketError(value).failure); }
  }
};

const readRoute = <Input, Success>(input: Readonly<{
  path: string;
  contract: ReferenceMarketApplicationContract<Input, Success>;
  invoke(request: Input, signal: AbortSignal): Promise<Success | ApplicationFailure>;
}>): RouteDefinition => Object.freeze({
  method: "POST",
  mutation: "none",
  pathPattern: input.path,
  query: "none",
  response: "canonical_json",
  successStatus: 200,
  handler: async (context: RouteContext) => {
    let request: Input;
    try { request = input.contract.parseInput(context.body); }
    catch { return failure(createReferenceMarketFailure("invalid_input")); }
    const result = await input.invoke(request, context.signal);
    return referenceMarketApplicationResult(input.contract, request, result);
  },
});

const mutationRoute = <Input, Success>(input: Readonly<{
  path: string;
  contract: ReferenceMarketApplicationContract<Input, Success>;
  invoke(request: Input, signal: AbortSignal): Promise<Success | ApplicationFailure>;
}>): RouteDefinition => Object.freeze({
  ...readRoute(input),
  mutation: "declared_control",
});

const publicReadDefinitions = (application: ReferenceMarketApplicationPort): readonly RouteDefinition[] =>
  Object.freeze([
    readRoute({
      path: referenceMarketPublicRoutes.priceQueries,
      contract: browserCapabilityBindings.referencePrice.contract,
      invoke: (request, signal) => application.price(request, signal),
    }),
    readRoute({
      path: referenceMarketPublicRoutes.historyQueries,
      contract: browserCapabilityBindings.referenceHistory.contract,
      invoke: (request, signal) => application.history(request, signal),
    }),
    readRoute({
      path: referenceMarketPublicRoutes.watchlistQueries,
      contract: referenceMarketApplicationContracts.watchlist,
      invoke: (request, signal) => application.watchlist(request, signal),
    }),
  ]);

const controlDefinition = (
  application: ReferenceMarketApplicationPort,
  paths: Readonly<Record<ReferenceMarketDeliveryAction, string>>,
  action: ReferenceMarketDeliveryAction,
): RouteDefinition => {
  switch (action) {
    case "add":
      return mutationRoute({
        path: paths.add,
        contract: referenceMarketApplicationContracts.add,
        invoke: (request, signal) => application.addPair(request, signal),
      });
    case "remove":
      return mutationRoute({
        path: paths.remove,
        contract: referenceMarketApplicationContracts.remove,
        invoke: (request, signal) => application.removePair(request, signal),
      });
    case "reorder":
      return mutationRoute({
        path: paths.reorder,
        contract: referenceMarketApplicationContracts.reorder,
        invoke: (request, signal) => application.reorderPairs(request, signal),
      });
  }
};

const controlDefinitions = (
  application: ReferenceMarketApplicationPort,
  paths: Readonly<Record<ReferenceMarketDeliveryAction, string>>,
): readonly RouteDefinition[] => Object.freeze(referenceMarketDeliveryActions.map((action) =>
  controlDefinition(application, paths, action)));

export const extendReferenceMarketInterfaceRoutes = (input: Readonly<{
  routes: RuntimeRouteRegistry;
  referenceMarkets: ReferenceMarketApplicationPort;
}>): RuntimeRouteRegistry => input.routes.extend([
  ...publicReadDefinitions(input.referenceMarkets),
  ...controlDefinitions(input.referenceMarkets, referenceMarketLocalMutationPaths),
], referenceMarketInterfaceErrorMappings);
