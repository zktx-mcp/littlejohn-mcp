import {parseEvmChainId, type EvmChainId} from "../evm/identities.js";
import {productChainId} from "../registry/product-identity.js";
import { admitRpcTransportTarget } from "../chain/rpc-transport-target.js";
import {
  createWalletConnectConfiguration,
  type WalletConnectConfiguration,
} from "../wallet/walletconnect-configuration.js";

export const defaultRpcUrl = "https://rpc.mainnet.chain.robinhood.com";
const officialRpcFetchUrl = admitRpcTransportTarget(defaultRpcUrl).fetchUrl;
const invalidRpcConfigurationMessage =
  "LITTLEJOHN_RPC_URL must be a valid absolute HTTPS URL without a fragment.";

const invalidRpcConfigurationErrors = new WeakSet<object>();

class InvalidRpcConfigurationError extends Error {
  constructor() {
    super(invalidRpcConfigurationMessage);
    this.name = "InvalidRpcConfigurationError";
    invalidRpcConfigurationErrors.add(this);
    Object.freeze(this);
  }
}

export const getInvalidRpcConfigurationError = (error: unknown): Error | undefined =>
  typeof error === "object" && error !== null && invalidRpcConfigurationErrors.has(error)
    ? error as Error
    : undefined;

export interface ConfiguredRpcEndpoint {
  readonly publicOrigin: string;
  readonly sourceOwner: "Robinhood" | "user_configured";
  readonly __configuredRpcEndpoint: unique symbol;
}

interface ConfiguredRpcEndpointState {
  readonly exactUri: string;
  readonly exactUtf8: Uint8Array;
}

const configuredRpcStates = new WeakMap<object, ConfiguredRpcEndpointState>();

export interface RuntimeChainConfiguration {
  readonly chainId: EvmChainId;
}

export interface RuntimeRpcConfiguration {
  readonly chain: RuntimeChainConfiguration;
  readonly endpoint: ConfiguredRpcEndpoint;
}

export interface RuntimeConfiguration {
  readonly chain: RuntimeChainConfiguration;
  readonly rpc: RuntimeRpcConfiguration;
  readonly wallet: WalletConnectConfiguration;
}

const runtimeChainConfigurations = new WeakSet<object>();

const createRuntimeChainConfiguration = (chainIdInput: unknown): RuntimeChainConfiguration => {
  const chain = Object.freeze({ chainId: parseEvmChainId(chainIdInput) });
  runtimeChainConfigurations.add(chain);
  return chain;
};

export const readRuntimeChainConfiguration = (
  chain: RuntimeChainConfiguration,
): RuntimeChainConfiguration => {
  if (
    typeof chain !== "object" ||
    chain === null ||
    !runtimeChainConfigurations.has(chain)
  ) throw new TypeError("Runtime chain configuration provenance is invalid.");
  return chain;
};

const parseConfiguredRpc = (value: unknown): ConfiguredRpcEndpoint => {
  let target: ReturnType<typeof admitRpcTransportTarget>;
  try {
    target = admitRpcTransportTarget(value);
  } catch {
    throw new InvalidRpcConfigurationError();
  }
  const sourceOwner =
    target.fetchUrl === officialRpcFetchUrl && target.authorization === undefined
      ? "Robinhood"
      : "user_configured";
  const endpoint = Object.freeze({
    publicOrigin: target.publicOrigin,
    sourceOwner,
  }) as ConfiguredRpcEndpoint;
  configuredRpcStates.set(endpoint, Object.freeze({
    exactUri: target.exactUri,
    exactUtf8: new Uint8Array(target.exactUtf8),
  }));
  return endpoint;
};

export const readConfiguredRpcEndpoint = (
  endpoint: ConfiguredRpcEndpoint,
): Readonly<{ exactUri: string; exactUtf8: Uint8Array }> => {
  const state = typeof endpoint === "object" && endpoint !== null
    ? configuredRpcStates.get(endpoint)
    : undefined;
  if (state === undefined) throw new TypeError("Configured RPC endpoint provenance is invalid.");
  return Object.freeze({ exactUri: state.exactUri, exactUtf8: new Uint8Array(state.exactUtf8) });
};

export const readRuntimeConfiguration = (
  environment: Readonly<Record<string, string | undefined>>,
): RuntimeConfiguration => {
  const chain = createRuntimeChainConfiguration(productChainId);
  const configuredRpc = environment["LITTLEJOHN_RPC_URL"];
  const endpoint = parseConfiguredRpc(configuredRpc === undefined ? defaultRpcUrl : configuredRpc);
  const rpc = Object.freeze({ chain, endpoint });
  const wallet = createWalletConnectConfiguration(
    environment["LITTLEJOHN_WALLETCONNECT_PROJECT_ID"],
    chain,
  );
  return Object.freeze({ chain, rpc, wallet });
};
