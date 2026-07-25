import {
  parseEvmChainId,
  productChainId,
  type EvmChainId,
} from "../core/index.js";
import {
  createWalletConnectConfiguration,
  type WalletConnectConfiguration,
} from "../wallet/walletconnect-configuration.js";

export const defaultRpcUrl = "https://rpc.mainnet.chain.robinhood.com";

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

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

const exactUtf8 = (value: string): Uint8Array => {
  const bytes = utf8Encoder.encode(value);
  if (utf8Decoder.decode(bytes) !== value) throw new TypeError("RPC URL contains invalid Unicode.");
  return bytes;
};

const parseConfiguredRpc = (value: string): ConfiguredRpcEndpoint => {
  const bytes = exactUtf8(value);
  if (bytes.length === 0 || bytes.length > 4_096 || value.includes("#") || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError("LITTLEJOHN_RPC_URL must be an absolute HTTP or HTTPS URL without a fragment.");
  }
  let url: URL;
  try { url = new URL(value); }
  catch { throw new TypeError("LITTLEJOHN_RPC_URL must be an absolute HTTP or HTTPS URL without a fragment."); }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("LITTLEJOHN_RPC_URL must be an absolute HTTP or HTTPS URL without a fragment.");
  }
  const official = new URL(defaultRpcUrl);
  const sourceOwner =
    url.href === official.href &&
    url.username === "" &&
    url.password === "" &&
    url.pathname === "/" &&
    url.search === ""
      ? "Robinhood"
      : "user_configured";
  const endpoint = Object.freeze({
    publicOrigin: url.origin,
    sourceOwner,
  }) as ConfiguredRpcEndpoint;
  configuredRpcStates.set(endpoint, Object.freeze({ exactUri: value, exactUtf8: new Uint8Array(bytes) }));
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
  const endpoint = parseConfiguredRpc(environment["LITTLEJOHN_RPC_URL"] ?? defaultRpcUrl);
  const rpc = Object.freeze({ chain, endpoint });
  const wallet = createWalletConnectConfiguration(
    environment["LITTLEJOHN_WALLETCONNECT_PROJECT_ID"],
    chain,
  );
  return Object.freeze({ chain, rpc, wallet });
};
