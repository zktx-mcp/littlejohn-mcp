import {
  admitApplicationInput,
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
import {
  referenceMarketInterfaceBindings,
  type ReferenceMarketInterfaceBinding,
} from "./identities.js";

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
  successStatus: 200,
  handler: async (context: RouteContext) => {
    const admission = admitApplicationInput(input.contract, context.body);
    if (!admission.ok) return failure(admission.failure);
    const result = await input.invoke(admission.value, context.signal);
    return referenceMarketApplicationResult(input.contract, admission.value, result);
  },
});

const publicReadDefinitions = (application: ReferenceMarketApplicationPort): readonly RouteDefinition[] =>
  Object.freeze([
    readRoute({
      path: referenceMarketInterfaceBindings.price.http.path,
      contract: referenceMarketInterfaceBindings.price.contract,
      invoke: (request, signal) => application.price(request, signal),
    }),
    readRoute({
      path: referenceMarketInterfaceBindings.history.http.path,
      contract: referenceMarketInterfaceBindings.history.contract,
      invoke: (request, signal) => application.history(request, signal),
    }),
    readRoute({
      path: referenceMarketInterfaceBindings.watchlist.http.path,
      contract: referenceMarketApplicationContracts.watchlist,
      invoke: (request, signal) => application.watchlist(request, signal),
    }),
  ]);

export const extendReferenceMarketInterfaceRoutes = (input: Readonly<{
  routes: RuntimeRouteRegistry;
  referenceMarkets: ReferenceMarketApplicationPort;
}>): RuntimeRouteRegistry => input.routes.extend(
  publicReadDefinitions(input.referenceMarkets),
  referenceMarketInterfaceErrorMappings,
);
