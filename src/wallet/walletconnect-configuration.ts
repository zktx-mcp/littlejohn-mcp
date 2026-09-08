import { z } from "zod";

import { productDisplayName } from "../core/index.js";
import type { RuntimeChainConfiguration } from "../runtime/configuration.js";
import { fixedOrigin } from "../runtime/http-boundary.js";
import { walletSessionRequirements } from "./session-requirements.js";

const defaultWalletConnectProjectId = "cd33d6deaa901b3c96185d9cb1f320ef";
const walletConnectDescription = "Local Robinhood Chain wallet connection" as const;

const walletConnectProjectIdSchema = z.string().regex(/^[0-9a-f]{32}$/)
  .brand("WalletConnectProjectId");
type WalletConnectProjectId = z.infer<typeof walletConnectProjectIdSchema>;

interface WalletConnectConfigurationState {
  readonly projectId: WalletConnectProjectId;
  readonly chain: RuntimeChainConfiguration;
  readonly requiredMethods: typeof walletSessionRequirements.requiredMethods;
  readonly requiredEvents: typeof walletSessionRequirements.requiredEvents;
  readonly metadata: {
    readonly name: typeof productDisplayName;
    readonly description: typeof walletConnectDescription;
    readonly url: typeof fixedOrigin;
    readonly icons: readonly [];
  };
}

declare const walletConnectConfigurationBrand: unique symbol;

export interface WalletConnectConfiguration {
  readonly [walletConnectConfigurationBrand]: true;
}

export interface WalletConnectSessionRequirements {
  readonly chain: RuntimeChainConfiguration;
  readonly requiredMethods: WalletConnectConfigurationState["requiredMethods"];
  readonly requiredEvents: WalletConnectConfigurationState["requiredEvents"];
}

const walletConnectConfigurationStates =
  new WeakMap<object, WalletConnectConfigurationState>();

const stateFor = (
  configuration: WalletConnectConfiguration,
): WalletConnectConfigurationState => {
  const state = typeof configuration === "object" && configuration !== null
    ? walletConnectConfigurationStates.get(configuration)
    : undefined;
  if (state === undefined) {
    throw new TypeError("WalletConnect configuration provenance is invalid.");
  }
  return state;
};

export const createWalletConnectConfiguration = (
  projectIdInput: unknown,
  chain: RuntimeChainConfiguration,
): WalletConnectConfiguration => {
  if (typeof chain !== "object" || chain === null) {
    throw new TypeError("WalletConnect chain configuration is invalid.");
  }
  const state = Object.freeze({
    projectId: walletConnectProjectIdSchema.parse(
      projectIdInput ?? defaultWalletConnectProjectId,
    ),
    chain,
    ...walletSessionRequirements,
    metadata: Object.freeze({
      name: productDisplayName,
      description: walletConnectDescription,
      url: fixedOrigin,
      icons: Object.freeze([]) as readonly [],
    }),
  });
  const configuration = Object.freeze({}) as WalletConnectConfiguration;
  walletConnectConfigurationStates.set(configuration, state);
  return configuration;
};

export const readWalletConnectConfiguration = (
  configuration: WalletConnectConfiguration,
): WalletConnectConfigurationState => stateFor(configuration);

export const readWalletConnectSessionRequirements = (
  configuration: WalletConnectConfiguration,
): WalletConnectSessionRequirements => {
  const state = stateFor(configuration);
  return Object.freeze({
    chain: state.chain,
    requiredMethods: state.requiredMethods,
    requiredEvents: state.requiredEvents,
  });
};

export const readWalletConnectConfigurationIdentity = (
  configuration: WalletConnectConfiguration,
  expectedChain: RuntimeChainConfiguration,
): Readonly<{ readonly projectIdUtf8: Uint8Array }> => {
  const state = stateFor(configuration);
  if (state.chain !== expectedChain) {
    throw new TypeError("WalletConnect configuration chain authority is inconsistent.");
  }
  return Object.freeze({
    projectIdUtf8: new TextEncoder().encode(state.projectId),
  });
};
