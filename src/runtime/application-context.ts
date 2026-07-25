import type {
  CapabilityBinding,
  CanonicalClock,
  CapabilityInvocationAuthority,
  InvocationBoundaryPorts,
} from "../core/index.js";
import type {
  accountBalanceCapability,
  chainStatusCapability,
  contractInspectCapability,
  transactionInspectCapability,
  walletConnectionCapability,
} from "../core/index.js";
import type { WalletConnectConfiguration } from "../wallet/walletconnect-configuration.js";
import type { RuntimeRpcConfiguration } from "./configuration.js";
import type { RuntimeRouteRegistry } from "./http-routing.js";
import type { OwnedResourceRegistry } from "./resource-ownership.js";
import type {
  RpcSourceAuthorityPort,
  WalletSessionSource,
  WalletSourceAuthorityPort,
} from "./source-identity.js";
import type {
  InitialRuntimeSupportManifest,
  WalletRuntimeSupportManifest,
} from "./support-manifest.js";
import type { WalletProjectionStore } from "./wallet-projection.js";

export interface WalletCapabilityAuthorityPort {
  readonly clock: CanonicalClock;
  readonly invocationAuthority: CapabilityInvocationAuthority;
  createInvocationPorts(session?: WalletSessionSource): InvocationBoundaryPorts;
}

export interface ChainCapabilityAuthorityPort {
  readonly clock: CanonicalClock;
  readonly invocationAuthority: CapabilityInvocationAuthority;
  readonly invocationPorts: InvocationBoundaryPorts;
}

export interface WalletPrivateStoreDirectoryPort {
  ensureDirectory(): Promise<string>;
}

export interface WalletOwnerBootstrapPort {
  readonly configuration: WalletConnectConfiguration;
  readonly privateStoreDirectory: WalletPrivateStoreDirectoryPort;
  readonly projection: WalletProjectionStore;
  readonly sourceAuthority: WalletSourceAuthorityPort;
  readonly capabilityAuthority: WalletCapabilityAuthorityPort;
}

export interface ChainOwnerBootstrapPort {
  readonly configuration: RuntimeRpcConfiguration;
  readonly sourceAuthority: RpcSourceAuthorityPort;
  readonly capabilityAuthority: ChainCapabilityAuthorityPort;
}

export interface WalletConnectionReadCapabilityPort {
  readonly connection: CapabilityBinding<typeof walletConnectionCapability>;
}

export interface ChainReadCapabilityPort {
  readonly accountBalance: CapabilityBinding<typeof accountBalanceCapability>;
  readonly chainStatus: CapabilityBinding<typeof chainStatusCapability>;
  readonly contractInspect: CapabilityBinding<typeof contractInspectCapability>;
  readonly transactionInspect: CapabilityBinding<typeof transactionInspectCapability>;
}

export interface RuntimeApplicationContext {
  readonly routes: RuntimeRouteRegistry;
  readonly signal: AbortSignal;
  readonly startupResources: OwnedResourceRegistry;
}

export interface WalletOwnerApplicationContext extends RuntimeApplicationContext {
  readonly supportManifest: InitialRuntimeSupportManifest;
  readonly wallet: WalletOwnerBootstrapPort;
}

export interface ChainOwnerApplicationContext<ActiveWallet extends object>
  extends RuntimeApplicationContext {
  readonly supportManifest: WalletRuntimeSupportManifest;
  readonly walletConnection: WalletConnectionReadCapabilityPort;
  readonly activeWallet: ActiveWallet;
  readonly chain: ChainOwnerBootstrapPort;
}
