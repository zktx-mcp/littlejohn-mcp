import {
  CapabilityBindingRegistry,
  captureCanonicalJson,
  readCapabilityRegistry,
  type AnyReadCapabilityDefinition,
  type ApplicationFailure,
  type CanonicalJson,
} from "../core/index.js";
import { chainInterfaceErrorMappings } from "../chain/errors.js";
import {
  composeCapabilityCatalog,
  type ChainReadCapabilityPort,
  type InterfaceRuntimeSupportManifest,
  type RouteContext,
  type RouteResult,
  type RuntimeRouteRegistry,
  type WalletConnectionReadCapabilityPort,
} from "../runtime/index.js";
import {
  accountBalanceInterface,
  capabilityCatalogInterface,
  chainStatusInterface,
  contractInspectInterface,
  readInterfaceIdentities,
  transactionInspectInterface,
  walletConnectionInterface,
} from "./identities.js";

export const publicInterfaceRoutes = Object.freeze({
  accountBalanceQueries: accountBalanceInterface.http.path,
  capabilities: capabilityCatalogInterface.http.path,
  chainStatus: chainStatusInterface.http.path,
  contractInspections: contractInspectInterface.http.path,
  transactionInspections: transactionInspectInterface.http.path,
  walletConnection: walletConnectionInterface.http.path,
});

const success = (body: unknown): RouteResult => ({ ok: true, body: captureCanonicalJson(body) });
const failure = (applicationFailure: ApplicationFailure): RouteResult => ({
  ok: false,
  failure: applicationFailure,
});

const invoke = async (
  bindings: CapabilityBindingRegistry,
  definition: AnyReadCapabilityDefinition,
  context: RouteContext,
): Promise<RouteResult> => {
  const result = await bindings.invoke(definition, context.body, { signal: context.signal });
  return result.ok ? success(result) : failure(result);
};

export const extendPublicInterfaceRoutes = (input: {
  readonly routes: RuntimeRouteRegistry;
  readonly chainReads: ChainReadCapabilityPort;
  readonly walletConnection: WalletConnectionReadCapabilityPort;
  readonly supportManifest: InterfaceRuntimeSupportManifest;
}): RuntimeRouteRegistry => {
  const bindings = new CapabilityBindingRegistry(readCapabilityRegistry, [
    input.chainReads.accountBalance,
    input.chainReads.chainStatus,
    input.chainReads.contractInspect,
    input.chainReads.transactionInspect,
    input.walletConnection.connection,
  ]);
  const catalog = composeCapabilityCatalog(input.supportManifest);

  return input.routes.extend([
    ...readInterfaceIdentities.map((identity) => ({
      method: identity.http.method,
      mutation: "none" as const,
      pathPattern: identity.http.path,
      response: "canonical_json" as const,
      successStatus: 200 as const,
      handler: (context: RouteContext) => invoke(bindings, identity.definition, context),
    })),
    {
      method: capabilityCatalogInterface.http.method,
      mutation: "none",
      pathPattern: capabilityCatalogInterface.http.path,
      response: "canonical_json",
      successStatus: 200,
      handler: async () => success(catalog as unknown as CanonicalJson),
    },
  ], chainInterfaceErrorMappings);
};
