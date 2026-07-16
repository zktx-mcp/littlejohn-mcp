import { z } from "zod";

import { productDisplayName } from "../core/index.js";
import { fixedOrigin } from "./http-boundary.js";

export const defaultRpcUrl = "https://rpc.mainnet.chain.robinhood.com";
export const defaultWalletConnectProjectId = "cd33d6deaa901b3c96185d9cb1f320ef";

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

export interface WalletConnectConfiguration {
  readonly projectId: string;
  readonly metadata: {
    readonly name: typeof productDisplayName;
    readonly description: "Local Robinhood Chain wallet connection";
    readonly url: typeof fixedOrigin;
    readonly icons: readonly [];
  };
}

export interface RuntimeConfiguration {
  readonly rpc: ConfiguredRpcEndpoint;
  readonly wallet: WalletConnectConfiguration;
}

export const walletConnectProjectIdSchema = z.string().regex(/^[0-9a-f]{32}$/);
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
  const rpc = parseConfiguredRpc(environment["LITTLEJOHN_RPC_URL"] ?? defaultRpcUrl);
  const projectId = walletConnectProjectIdSchema.parse(
    environment["LITTLEJOHN_WALLETCONNECT_PROJECT_ID"] ?? defaultWalletConnectProjectId,
  );
  const wallet = Object.freeze({
    projectId,
    metadata: Object.freeze({
      name: productDisplayName,
      description: "Local Robinhood Chain wallet connection" as const,
      url: fixedOrigin,
      icons: Object.freeze([]) as readonly [],
    }),
  });
  return Object.freeze({ rpc, wallet });
};
