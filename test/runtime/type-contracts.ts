import type {
  ChainOwnerApplicationContext,
  ChainOwnerBootstrapPort,
  ChainReadCapabilityPort,
  RuntimeApplicationContext,
  WalletConnectionReadCapabilityPort,
  WalletOwnerApplicationContext,
  WalletOwnerBootstrapPort,
  WalletPrivateStoreDirectoryPort,
} from "../../src/runtime/application-context.js";
import type {
  ChainOwnerHandoff,
  LocalRuntimeOptions,
  TokenCatalogOwnerHandoff,
  WalletOwnerHandoff,
} from "../../src/runtime/composition.js";
import type {
  ChainOwnerApplicationFactory,
} from "../../src/chain/application.js";
import type {
  InterfaceOwnerApplicationContext,
  InterfaceOwnerApplicationFactory,
} from "../../src/interfaces/application.js";
import type {
  WalletOwnerApplication,
  WalletOwnerApplicationFactory,
} from "../../src/wallet/application.js";
import type { WalletManagementPort } from "../../src/wallet/contracts.js";
import type {
  RuntimeChainConfiguration,
  RuntimeConfiguration,
  RuntimeRpcConfiguration,
} from "../../src/runtime/configuration.js";
import type {
  WalletConnectConfiguration,
} from "../../src/wallet/walletconnect-configuration.js";
import type { LocalRuntime, WalletSessionSource } from "../../src/runtime/index.js";
import {
  acquireOwnerOnlyStateFileLease,
  type OwnerOnlyStateFileSize,
} from "../../src/runtime/paths.js";
import { tokenCatalogConsumerPortContract } from "../../src/token-catalog/ports.js";
import type {
  TokenCatalogApplicationDependencies,
  TokenCatalogManagementApplicationPort,
  TokenCatalogQueryApplicationPort,
} from "../../src/token-catalog/ports.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false;
type Assert<Value extends true> = Value;
type AssertFalse<Value extends false> = Value;
type ConsumerPortKeys<Definition> = Definition extends Readonly<{
  methods: readonly (infer Method extends string)[];
}> ? Method : never;

interface TestWalletOperations extends WalletManagementPort {
  readOperation(): unknown;
}

interface TestActiveWallet {
  capture(): unknown;
}

interface OtherActiveWallet {
  read(): unknown;
}

type TestWalletApplicationFactory = WalletOwnerApplicationFactory<TestActiveWallet, TestWalletOperations>;
type TestChainApplicationFactory = ChainOwnerApplicationFactory<TestActiveWallet>;
type TestInterfaceApplicationFactory = InterfaceOwnerApplicationFactory;

type _WalletContextKeys = Assert<Equal<
  keyof WalletOwnerApplicationContext,
  "routes" | "signal" | "startupResources" | "supportManifest" | "wallet"
>>;
type _RuntimeApplicationContextKeys = Assert<Equal<
  keyof RuntimeApplicationContext,
  "routes" | "signal" | "startupResources"
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
  keyof InterfaceOwnerApplicationContext,
  "routes" | "signal" | "startupResources" | "supportManifest" | "walletConnection" | "walletOperations" |
  "chainReads" | "uniswapV2Quote" | "tokenInspection" | "tokenCatalogQueries" | "tokenCatalogManagement" |
  "accountAssets" | "referenceMarkets"
>>;
type _InterfaceWalletOperations = Assert<Equal<
  InterfaceOwnerApplicationContext["walletOperations"],
  WalletManagementPort
>>;
type _WalletApplicationKeys = Assert<Equal<
  keyof WalletOwnerApplication<TestActiveWallet, TestWalletOperations>,
  "routes" | "close" | "shutdown" | "supportManifest" | "walletConnection" | "activeWallet" | "walletOperations"
>>;
type _WalletPortKeys = Assert<Equal<
  keyof WalletOwnerBootstrapPort,
  "configuration" | "privateStoreDirectory" | "projection" | "operations" |
  "sourceAuthority" | "capabilityAuthority"
>>;
type _WalletPortConfiguration = Assert<Equal<
  WalletOwnerBootstrapPort["configuration"],
  WalletConnectConfiguration
>>;
type _WalletConfigurationExposesNoProviderField = Assert<Equal<
  Extract<keyof WalletConnectConfiguration, string | number>,
  never
>>;
type _PrivateStoreDirectoryKeys = Assert<Equal<keyof WalletPrivateStoreDirectoryPort, "ensureDirectory">>;
type _ChainPortKeys = Assert<Equal<
  keyof ChainOwnerBootstrapPort,
  "configuration" | "sourceAuthority" | "capabilityAuthority" | "contractSourceVerification"
>>;
type _ChainPortConfiguration = Assert<Equal<
  ChainOwnerBootstrapPort["configuration"],
  RuntimeRpcConfiguration
>>;
type _RuntimeConfigurationKeys = Assert<Equal<keyof RuntimeConfiguration, "chain" | "rpc" | "wallet">>;
type _RuntimeChainConfigurationKeys = Assert<Equal<keyof RuntimeChainConfiguration, "chainId">>;
type _RuntimeRpcConfigurationKeys = Assert<Equal<keyof RuntimeRpcConfiguration, "chain" | "endpoint">>;
type _OwnerOnlyStateFileLeaseSizeInput = Assert<Equal<
  NonNullable<Parameters<typeof acquireOwnerOnlyStateFileLease>[1]>,
  OwnerOnlyStateFileSize
>>;

declare const ownerOnlyStateFilePath: string;
const exerciseOwnerOnlyStateFileSizeType = (): void => {
  acquireOwnerOnlyStateFileLease(ownerOnlyStateFilePath, { exact: 0, maximum: 1 });
  // @ts-expect-error Misspelled size constraints must not be silently ignored.
  acquireOwnerOnlyStateFileLease(ownerOnlyStateFilePath, { maxium: 1 });
  // @ts-expect-error Known size constraints must retain their numeric type.
  acquireOwnerOnlyStateFileLease(ownerOnlyStateFilePath, { exact: "0" });
};
void exerciseOwnerOnlyStateFileSizeType;
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
  "supportManifest" | "invocations" | "chainReads" | "tokenInspection" | "tokenAdditionReads" |
  "officialAssetReads" | "accountAssetReads" | "referenceMarketReads" | "protocolReads"
>>;
type _RuntimeHandleKeys = Assert<Equal<
  keyof LocalRuntime,
  "ownerState" | "presentationSnapshotStore" | "start" | "dispatchRuntimeRequest" |
  "openOwnerSession" | "stop"
>>;
type _RuntimeOptionKeys = Assert<Equal<
  keyof LocalRuntimeOptions<TestActiveWallet, TestWalletOperations>,
  "environment" | "now" | "robinhoodOfficialAssetSourceClient" |
    "stockTokenExecutionIndex" |
    "contractSourceVerificationFactory" | "walletApplicationFactory" |
    "chainApplicationFactory" | "interfaceApplicationFactory"
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
  "getSelection" | "getSelectionState" | "listSelections"
>>;
type _TokenCatalogHandoffKeys = Assert<Equal<
  keyof TokenCatalogOwnerHandoff,
  "supportManifest" | "officialAssets" | keyof typeof tokenCatalogConsumerPortContract
>>;
type _TokenCatalogQueryKeys = Assert<Equal<
  keyof TokenCatalogQueryApplicationPort,
  ConsumerPortKeys<typeof tokenCatalogConsumerPortContract.tokenCatalogQueries>
>>;
type _TokenCatalogManagementKeys = Assert<Equal<
  keyof TokenCatalogManagementApplicationPort,
  ConsumerPortKeys<typeof tokenCatalogConsumerPortContract.tokenCatalogManagement>
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
  | _OwnerOnlyStateFileLeaseSizeInput
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
  | _MismatchedActiveWalletRejected
  | _WalletSessionSourceKeys
  | _TokenCatalogApplicationStoreKeys
  | _TokenCatalogHandoffKeys
  | _TokenCatalogQueryKeys
  | _TokenCatalogManagementKeys;
