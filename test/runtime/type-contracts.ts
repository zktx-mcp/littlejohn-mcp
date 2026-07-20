import type {
  ChainOwnerApplicationContext,
  ChainOwnerApplicationFactory,
  ChainOwnerBootstrapPort,
  ChainOwnerHandoff,
  ChainReadCapabilityPort,
  InterfaceOwnerApplicationContext,
  InterfaceOwnerApplicationFactory,
  LocalRuntimeOptions,
  TokenCatalogOwnerHandoff,
  WalletConnectionReadCapabilityPort,
  WalletOwnerApplication,
  WalletOwnerApplicationContext,
  WalletOwnerApplicationFactory,
  WalletOwnerBootstrapPort,
  WalletOwnerHandoff,
  WalletPrivateStoreDirectoryPort,
} from "../../src/runtime/composition.js";
import type {
  RuntimeChainConfiguration,
  RuntimeConfiguration,
  RuntimeRpcConfiguration,
  WalletConnectConfiguration,
} from "../../src/runtime/configuration.js";
import type { LocalRuntime, WalletSessionSource } from "../../src/runtime/index.js";
import { tokenCatalogConsumerPortContract } from "../../src/token-catalog/ports.js";
import type {
  TokenCatalogApplicationDependencies,
  TokenCatalogBrowserOperationPort,
  TokenCatalogInteractiveCliPort,
  TokenCatalogNonInteractiveOperationPort,
  TokenCatalogQueryApplicationPort,
  TokenCatalogWebStartPort,
} from "../../src/token-catalog/ports.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false;
type Assert<Value extends true> = Value;
type AssertFalse<Value extends false> = Value;
type ConsumerPortKeys<Definition> = Definition extends Readonly<{
  methods: readonly (infer Method extends string)[];
  interactionInterface: string;
}>
  ? Method | "interactionInterface"
  : Definition extends Readonly<{ methods: readonly (infer Method extends string)[] }>
    ? Method
    : never;

interface TestWalletOperations {
  readOperation(): unknown;
}

interface TestActiveWallet {
  capture(): unknown;
}

interface OtherWalletOperations {
  cancelOperation(): unknown;
}

interface OtherActiveWallet {
  read(): unknown;
}

type TestWalletApplicationFactory = WalletOwnerApplicationFactory<TestActiveWallet, TestWalletOperations>;
type TestChainApplicationFactory = ChainOwnerApplicationFactory<TestActiveWallet>;
type TestInterfaceApplicationFactory = InterfaceOwnerApplicationFactory<TestWalletOperations>;

type _WalletContextKeys = Assert<Equal<
  keyof WalletOwnerApplicationContext,
  "routes" | "signal" | "startupResources" | "supportManifest" | "wallet"
>>;
type _ChainContextKeys = Assert<Equal<
  keyof ChainOwnerApplicationContext<TestActiveWallet>,
  "routes" | "signal" | "startupResources" | "supportManifest" | "walletConnection" | "activeWallet" | "chain"
>>;
type _ChainActiveWallet = Assert<Equal<
  ChainOwnerApplicationContext<TestActiveWallet>["activeWallet"],
  TestActiveWallet
>>;
type _InterfaceContextKeys = Assert<Equal<
  keyof InterfaceOwnerApplicationContext<TestWalletOperations>,
  "routes" | "signal" | "startupResources" | "supportManifest" | "walletConnection" | "walletOperations" |
  "chainReads" | "tokenInspection" | "tokenCatalogQueries" | "tokenCatalogWebStart" |
  "tokenCatalogBrowserOperations" | "tokenCatalogInteractiveCli" | "tokenCatalogNonInteractiveOperations" |
  "accountTokenRegistrationRead" | "accountAssets"
>>;
type _InterfaceWalletOperations = Assert<Equal<
  InterfaceOwnerApplicationContext<TestWalletOperations>["walletOperations"],
  TestWalletOperations
>>;
type _WalletApplicationKeys = Assert<Equal<
  keyof WalletOwnerApplication<TestActiveWallet, TestWalletOperations>,
  "routes" | "close" | "supportManifest" | "walletConnection" | "activeWallet" | "walletOperations"
>>;
type _WalletPortKeys = Assert<Equal<
  keyof WalletOwnerBootstrapPort,
  "configuration" | "privateStoreDirectory" | "projection" | "sourceAuthority" | "capabilityAuthority"
>>;
type _WalletPortConfiguration = Assert<Equal<
  WalletOwnerBootstrapPort["configuration"],
  WalletConnectConfiguration
>>;
type _PrivateStoreDirectoryKeys = Assert<Equal<keyof WalletPrivateStoreDirectoryPort, "ensureDirectory">>;
type _ChainPortKeys = Assert<Equal<
  keyof ChainOwnerBootstrapPort,
  "configuration" | "sourceAuthority" | "capabilityAuthority"
>>;
type _ChainPortConfiguration = Assert<Equal<
  ChainOwnerBootstrapPort["configuration"],
  RuntimeRpcConfiguration
>>;
type _RuntimeConfigurationKeys = Assert<Equal<keyof RuntimeConfiguration, "chain" | "rpc" | "wallet">>;
type _RuntimeChainConfigurationKeys = Assert<Equal<keyof RuntimeChainConfiguration, "chainId">>;
type _RuntimeRpcConfigurationKeys = Assert<Equal<keyof RuntimeRpcConfiguration, "chain" | "endpoint">>;
type _WalletConnectionReadKeys = Assert<Equal<keyof WalletConnectionReadCapabilityPort, "connection">>;
type _ChainReadKeys = Assert<Equal<
  keyof ChainReadCapabilityPort,
  "accountBalance" | "chainStatus" | "contractInspect" | "transactionInspect"
>>;
type _WalletHandoffKeys = Assert<Equal<
  keyof WalletOwnerHandoff<TestActiveWallet>,
  "supportManifest" | "walletConnection" | "activeWallet"
>>;
type _WalletHandoffActiveWallet = Assert<Equal<
  WalletOwnerHandoff<TestActiveWallet>["activeWallet"],
  TestActiveWallet
>>;
type _ChainHandoffKeys = Assert<Equal<
  keyof ChainOwnerHandoff,
  "supportManifest" | "chainReads" | "tokenInspection"
>>;
type _RuntimeHandleKeys = Assert<Equal<
  keyof LocalRuntime,
  "ownerState" | "start" | "dispatchRuntimeRequest" | "openOwnerSession" | "stop"
>>;
type _RuntimeOptionKeys = Assert<Equal<
  keyof LocalRuntimeOptions<TestActiveWallet, TestWalletOperations>,
  "environment" | "now" | "walletApplicationFactory" | "chainApplicationFactory" | "interfaceApplicationFactory"
>>;
type _NoFactoryPrefix = Assert<{} extends LocalRuntimeOptions<TestActiveWallet, TestWalletOperations> ? true : false>;
type _WalletFactoryPrefix = Assert<{
  walletApplicationFactory: TestWalletApplicationFactory;
} extends LocalRuntimeOptions<TestActiveWallet, TestWalletOperations> ? true : false>;
type _ChainFactoryPrefix = Assert<{
  walletApplicationFactory: TestWalletApplicationFactory;
  chainApplicationFactory: TestChainApplicationFactory;
} extends LocalRuntimeOptions<TestActiveWallet, TestWalletOperations> ? true : false>;
type _InterfaceFactoryPrefix = Assert<{
  walletApplicationFactory: TestWalletApplicationFactory;
  chainApplicationFactory: TestChainApplicationFactory;
  interfaceApplicationFactory: TestInterfaceApplicationFactory;
} extends LocalRuntimeOptions<TestActiveWallet, TestWalletOperations> ? true : false>;
type _ChainWithoutWalletRejected = AssertFalse<{
  chainApplicationFactory: TestChainApplicationFactory;
} extends LocalRuntimeOptions<TestActiveWallet, TestWalletOperations> ? true : false>;
type _InterfaceWithoutChainRejected = AssertFalse<{
  walletApplicationFactory: TestWalletApplicationFactory;
  interfaceApplicationFactory: TestInterfaceApplicationFactory;
} extends LocalRuntimeOptions<TestActiveWallet, TestWalletOperations> ? true : false>;
type _MismatchedInterfaceOperationsRejected = AssertFalse<{
  walletApplicationFactory: TestWalletApplicationFactory;
  chainApplicationFactory: TestChainApplicationFactory;
  interfaceApplicationFactory: InterfaceOwnerApplicationFactory<OtherWalletOperations>;
} extends LocalRuntimeOptions<TestActiveWallet, TestWalletOperations> ? true : false>;
type _MismatchedActiveWalletRejected = AssertFalse<{
  walletApplicationFactory: TestWalletApplicationFactory;
  chainApplicationFactory: ChainOwnerApplicationFactory<OtherActiveWallet>;
} extends LocalRuntimeOptions<TestActiveWallet, TestWalletOperations> ? true : false>;
type _WalletSessionSourceKeys = Assert<Equal<
  keyof WalletSessionSource,
  "sourceId" | "candidateId" | "topicDigest" | "observationAuthority"
>>;
type _TokenCatalogApplicationStoreKeys = Assert<Equal<
  keyof TokenCatalogApplicationDependencies["store"],
  "getRegistration" | "listRegistrations"
>>;
type _TokenCatalogHandoffKeys = Assert<Equal<
  keyof TokenCatalogOwnerHandoff,
  "supportManifest" | keyof typeof tokenCatalogConsumerPortContract
>>;
type _TokenCatalogQueryKeys = Assert<Equal<
  keyof TokenCatalogQueryApplicationPort,
  ConsumerPortKeys<typeof tokenCatalogConsumerPortContract.tokenCatalogQueries>
>>;
type _TokenCatalogWebStartKeys = Assert<Equal<
  keyof TokenCatalogWebStartPort,
  ConsumerPortKeys<typeof tokenCatalogConsumerPortContract.tokenCatalogWebStart>
>>;
type _TokenCatalogBrowserOperationKeys = Assert<Equal<
  keyof TokenCatalogBrowserOperationPort,
  ConsumerPortKeys<typeof tokenCatalogConsumerPortContract.tokenCatalogBrowserOperations>
>>;
type _TokenCatalogInteractiveCliKeys = Assert<Equal<
  keyof TokenCatalogInteractiveCliPort,
  ConsumerPortKeys<typeof tokenCatalogConsumerPortContract.tokenCatalogInteractiveCli>
>>;
type _TokenCatalogNonInteractiveOperationKeys = Assert<Equal<
  keyof TokenCatalogNonInteractiveOperationPort,
  ConsumerPortKeys<typeof tokenCatalogConsumerPortContract.tokenCatalogNonInteractiveOperations>
>>;

export type RuntimePortTypeContracts =
  | _WalletContextKeys
  | _ChainContextKeys
  | _ChainActiveWallet
  | _InterfaceContextKeys
  | _InterfaceWalletOperations
  | _WalletApplicationKeys
  | _WalletPortKeys
  | _WalletPortConfiguration
  | _PrivateStoreDirectoryKeys
  | _ChainPortKeys
  | _ChainPortConfiguration
  | _RuntimeConfigurationKeys
  | _RuntimeChainConfigurationKeys
  | _RuntimeRpcConfigurationKeys
  | _WalletConnectionReadKeys
  | _ChainReadKeys
  | _WalletHandoffKeys
  | _WalletHandoffActiveWallet
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
  | _MismatchedActiveWalletRejected
  | _WalletSessionSourceKeys
  | _TokenCatalogApplicationStoreKeys
  | _TokenCatalogHandoffKeys
  | _TokenCatalogQueryKeys
  | _TokenCatalogWebStartKeys
  | _TokenCatalogBrowserOperationKeys
  | _TokenCatalogInteractiveCliKeys
  | _TokenCatalogNonInteractiveOperationKeys;
