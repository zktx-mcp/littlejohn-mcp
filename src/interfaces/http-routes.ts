import {
  CapabilityBindingRegistry,
  captureCanonicalJson,
  type AnyReadCapabilityDefinition,
  type ApplicationFailure,
  type CanonicalJson,
} from "../core/index.js";
import { chainInterfaceErrorMappings } from "../chain/errors.js";
import { tokenCatalogInterfaceErrorMappings } from "../token-catalog/index.js";
import { walletInterfaceErrorMappings } from "../wallet/errors.js";
import {
  uniswapV2InterfaceErrorMappings,
  type UniswapV2QuoteApplication,
} from "../protocols/uniswap-v2/index.js";
import type {
  ChainReadCapabilityPort,
  WalletConnectionReadCapabilityPort,
} from "../runtime/application-context.js";
import type { TokenCatalogInspectionPort } from "../token-catalog/index.js";
import type { InterfaceRuntimeSupportManifest } from "../runtime/support-manifest.js";
import type {
  RouteContext,
  RouteResult,
  RuntimeRouteRegistry,
} from "../runtime/http-routing.js";
import {
  accountBalanceInterface,
  capabilityCatalogInterface,
  chainStatusInterface,
  contractInspectInterface,
  interfaceReadCapabilityRegistry,
  tokenInspectInterface,
  transactionInspectInterface,
  type ReadInterfaceIdentity,
  uniswapV2QuoteInterface,
  walletConnectionInterface,
} from "./identities.js";
import { composeInterfaceCapabilityCatalog } from "./support.js";

export const publicInterfaceRoutes = Object.freeze({
  accountBalanceQueries: accountBalanceInterface.http.path,
  capabilities: capabilityCatalogInterface.http.path,
  chainStatus: chainStatusInterface.http.path,
  contractInspections: contractInspectInterface.http.path,
  tokenInspections: tokenInspectInterface.http.path,
  transactionInspections: transactionInspectInterface.http.path,
  uniswapV2ExactInputQuotes: uniswapV2QuoteInterface.http.path,
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

const readRoutes = (
  bindings: CapabilityBindingRegistry,
  identities: readonly ReadInterfaceIdentity[],
) => identities.map((identity) => ({
  method: identity.http.method,
  mutation: "none" as const,
  pathPattern: identity.http.path,
  successStatus: 200 as const,
  handler: (context: RouteContext) => invoke(bindings, identity.definition, context),
}));

export const extendPublicInterfaceRoutes = (input: {
  readonly routes: RuntimeRouteRegistry;
  readonly chainReads: ChainReadCapabilityPort;
  readonly walletConnection: WalletConnectionReadCapabilityPort;
  readonly tokenInspection: TokenCatalogInspectionPort;
  readonly uniswapV2Quote: UniswapV2QuoteApplication["binding"];
  readonly supportManifest: InterfaceRuntimeSupportManifest;
}): RuntimeRouteRegistry => {
  const bindings = new CapabilityBindingRegistry(interfaceReadCapabilityRegistry, [
    input.chainReads.accountBalance,
    input.chainReads.chainStatus,
    input.chainReads.contractInspect,
    input.tokenInspection,
    input.chainReads.transactionInspect,
    input.uniswapV2Quote,
    input.walletConnection.connection,
  ]);
  const catalog = composeInterfaceCapabilityCatalog(input.supportManifest);

  const walletRoutes = input.routes.extend(
    readRoutes(bindings, [walletConnectionInterface]),
    walletInterfaceErrorMappings,
  );
  const chainRoutes = walletRoutes.extend(readRoutes(bindings, [
    accountBalanceInterface,
    chainStatusInterface,
    contractInspectInterface,
    transactionInspectInterface,
  ]), chainInterfaceErrorMappings);
  const tokenRoutes = chainRoutes.extend([
    ...readRoutes(bindings, [tokenInspectInterface]),
    {
      method: capabilityCatalogInterface.http.method,
      mutation: "none",
      pathPattern: capabilityCatalogInterface.http.path,
      successStatus: 200,
      handler: async () => success(catalog as unknown as CanonicalJson),
    },
  ], tokenCatalogInterfaceErrorMappings);
  return tokenRoutes.extend(
    readRoutes(bindings, [uniswapV2QuoteInterface]),
    uniswapV2InterfaceErrorMappings,
  );
};
