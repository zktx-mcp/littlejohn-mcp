import type {
  ChainOwnerApplicationContext,
  ChainOwnerApplicationFactory,
  ChainOwnerBootstrapPort,
  ChainOwnerHandoff,
  ChainReadCapabilityPort,
  InterfaceOwnerApplicationContext,
  InterfaceOwnerApplicationFactory,
  LocalRuntimeOptions,
  WalletConnectionReadCapabilityPort,
  WalletOwnerApplication,
  WalletOwnerApplicationContext,
  WalletOwnerApplicationFactory,
  WalletOwnerBootstrapPort,
  WalletOwnerHandoff,
  WalletPrivateStoreDirectoryPort,
} from "../../src/runtime/composition.js";
import type { LocalRuntime, WalletSessionSource } from "../../src/runtime/index.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false;
type Assert<Value extends true> = Value;
type AssertFalse<Value extends false> = Value;

interface TestWalletOperations {
  readOperation(): unknown;
}

interface OtherWalletOperations {
  cancelOperation(): unknown;
}

type TestWalletApplicationFactory = WalletOwnerApplicationFactory<TestWalletOperations>;
type TestInterfaceApplicationFactory = InterfaceOwnerApplicationFactory<TestWalletOperations>;

type _WalletContextKeys = Assert<Equal<
  keyof WalletOwnerApplicationContext,
  "routes" | "signal" | "supportManifest" | "wallet"
>>;
type _ChainContextKeys = Assert<Equal<
  keyof ChainOwnerApplicationContext,
  "routes" | "signal" | "supportManifest" | "walletConnection" | "chain"
>>;
type _InterfaceContextKeys = Assert<Equal<
  keyof InterfaceOwnerApplicationContext<TestWalletOperations>,
  "routes" | "signal" | "supportManifest" | "walletConnection" | "walletOperations" | "chainReads"
>>;
type _InterfaceWalletOperations = Assert<Equal<
  InterfaceOwnerApplicationContext<TestWalletOperations>["walletOperations"],
  TestWalletOperations
>>;
type _WalletApplicationKeys = Assert<Equal<
  keyof WalletOwnerApplication<TestWalletOperations>,
  "routes" | "close" | "supportManifest" | "walletConnection" | "walletOperations"
>>;
type _WalletPortKeys = Assert<Equal<
  keyof WalletOwnerBootstrapPort,
  "configuration" | "privateStoreDirectory" | "projection" | "sourceAuthority" | "capabilityAuthority"
>>;
type _PrivateStoreDirectoryKeys = Assert<Equal<keyof WalletPrivateStoreDirectoryPort, "prepare">>;
type _ChainPortKeys = Assert<Equal<
  keyof ChainOwnerBootstrapPort,
  "configuredRpcUri" | "sourceAuthority" | "capabilityAuthority"
>>;
type _WalletConnectionReadKeys = Assert<Equal<keyof WalletConnectionReadCapabilityPort, "connection">>;
type _ChainReadKeys = Assert<Equal<
  keyof ChainReadCapabilityPort,
  "accountBalance" | "chainStatus" | "contractInspect" | "transactionInspect"
>>;
type _WalletHandoffKeys = Assert<Equal<
  keyof WalletOwnerHandoff,
  "supportManifest" | "walletConnection"
>>;
type _ChainHandoffKeys = Assert<Equal<
  keyof ChainOwnerHandoff,
  "supportManifest" | "chainReads"
>>;
type _RuntimeHandleKeys = Assert<Equal<
  keyof LocalRuntime,
  "ownerState" | "executeOwnerOperation" | "stop"
>>;
type _RuntimeOptionKeys = Assert<Equal<
  keyof LocalRuntimeOptions<TestWalletOperations>,
  "environment" | "now" | "walletApplicationFactory" | "chainApplicationFactory" | "interfaceApplicationFactory"
>>;
type _NoFactoryPrefix = Assert<{} extends LocalRuntimeOptions<TestWalletOperations> ? true : false>;
type _WalletFactoryPrefix = Assert<{
  walletApplicationFactory: TestWalletApplicationFactory;
} extends LocalRuntimeOptions<TestWalletOperations> ? true : false>;
type _ChainFactoryPrefix = Assert<{
  walletApplicationFactory: TestWalletApplicationFactory;
  chainApplicationFactory: ChainOwnerApplicationFactory;
} extends LocalRuntimeOptions<TestWalletOperations> ? true : false>;
type _InterfaceFactoryPrefix = Assert<{
  walletApplicationFactory: TestWalletApplicationFactory;
  chainApplicationFactory: ChainOwnerApplicationFactory;
  interfaceApplicationFactory: TestInterfaceApplicationFactory;
} extends LocalRuntimeOptions<TestWalletOperations> ? true : false>;
type _ChainWithoutWalletRejected = AssertFalse<{
  chainApplicationFactory: ChainOwnerApplicationFactory;
} extends LocalRuntimeOptions<TestWalletOperations> ? true : false>;
type _InterfaceWithoutChainRejected = AssertFalse<{
  walletApplicationFactory: TestWalletApplicationFactory;
  interfaceApplicationFactory: TestInterfaceApplicationFactory;
} extends LocalRuntimeOptions<TestWalletOperations> ? true : false>;
type _MismatchedInterfaceOperationsRejected = AssertFalse<{
  walletApplicationFactory: TestWalletApplicationFactory;
  chainApplicationFactory: ChainOwnerApplicationFactory;
  interfaceApplicationFactory: InterfaceOwnerApplicationFactory<OtherWalletOperations>;
} extends LocalRuntimeOptions<TestWalletOperations> ? true : false>;
type _WalletSessionSourceKeys = Assert<Equal<
  keyof WalletSessionSource,
  "sourceId" | "candidateId" | "topicDigest" | "observationAuthority"
>>;

export type RuntimePortTypeContracts =
  | _WalletContextKeys
  | _ChainContextKeys
  | _InterfaceContextKeys
  | _InterfaceWalletOperations
  | _WalletApplicationKeys
  | _WalletPortKeys
  | _PrivateStoreDirectoryKeys
  | _ChainPortKeys
  | _WalletConnectionReadKeys
  | _ChainReadKeys
  | _WalletHandoffKeys
  | _ChainHandoffKeys
  | _RuntimeHandleKeys
  | _RuntimeOptionKeys
  | _NoFactoryPrefix
  | _WalletFactoryPrefix
  | _ChainFactoryPrefix
  | _InterfaceFactoryPrefix
  | _ChainWithoutWalletRejected
  | _InterfaceWithoutChainRejected
  | _MismatchedInterfaceOperationsRejected
  | _WalletSessionSourceKeys;
