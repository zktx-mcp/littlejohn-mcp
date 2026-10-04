import type {
  CapabilityBinding,
  CanonicalClock,
  CanonicalJson,
  CapabilityInvocationAuthority,
  InvocationBoundaryPorts,
} from "../core/index.js";
import type {accountBalanceCapability} from "../account-assets/balance-capability.js";
import type {addressInspectCapability, chainStatusCapability, transactionInspectCapability} from "../chain/read-contracts.js";
import type {walletConnectionCapability} from "../wallet/connection-capability.js";
import type { ContractSourceVerificationPort } from "../intelligence/ports.js";
import type { WalletConnectConfiguration } from "../wallet/walletconnect-configuration.js";
import type { WalletOperationStore } from "../wallet/contracts.js";
import type { RuntimeRpcConfiguration } from "./configuration.js";
import type { RuntimeRouteRegistry } from "./http-routing.js";
import type { OwnedResourceRegistry } from "./resource-ownership.js";
import type {
  RpcSourceAuthorityPort,
  WalletSessionSource,
  WalletSourceAuthorityPort,
} from "./source-identity.js";
import type { RuntimeSupportManifest } from "./support-manifest.js";
import type { WalletProjectionStore } from "./wallet-projection.js";

export {
  presentationSnapshotLimits,
  presentationSnapshotUnavailableReasons,
} from "./presentation-snapshot.js";
export type {
  PresentationSnapshotRecord,
  PresentationSnapshotResult,
  PresentationSnapshotStore,
  PresentationSnapshotUnavailableReason,
} from "./presentation-snapshot.js";

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
  readonly operations: WalletOperationStore;
  readonly sourceAuthority: WalletSourceAuthorityPort;
  readonly capabilityAuthority: WalletCapabilityAuthorityPort;
}

export interface ChainOwnerBootstrapPort {
  readonly configuration: RuntimeRpcConfiguration;
  readonly sourceAuthority: RpcSourceAuthorityPort;
  readonly capabilityAuthority: ChainCapabilityAuthorityPort;
  readonly contractSourceVerification: ContractSourceVerificationPort;
}

export interface WalletConnectionReadCapabilityPort {
  readonly connection: CapabilityBinding<typeof walletConnectionCapability>;
}

export interface ChainReadCapabilityPort {
  readonly accountBalance: CapabilityBinding<typeof accountBalanceCapability>;
  readonly addressInspect: CapabilityBinding<typeof addressInspectCapability>;
  readonly chainStatus: CapabilityBinding<typeof chainStatusCapability>;
  readonly transactionInspect: CapabilityBinding<typeof transactionInspectCapability>;
}

export interface RuntimeApplicationContext {
  readonly routes: RuntimeRouteRegistry;
  readonly signal: AbortSignal;
  readonly startupResources: OwnedResourceRegistry;
}

export interface WalletOwnerApplicationContext extends RuntimeApplicationContext {
  readonly supportManifest: RuntimeSupportManifest;
  readonly wallet: WalletOwnerBootstrapPort;
}

export interface ChainOwnerApplicationContext<ActiveWallet extends object>
  extends RuntimeApplicationContext {
  readonly supportManifest: RuntimeSupportManifest;
  readonly walletConnection: WalletConnectionReadCapabilityPort;
  readonly activeWallet: ActiveWallet;
  readonly chain: ChainOwnerBootstrapPort;
}
