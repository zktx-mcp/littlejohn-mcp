import { createRegistryOwnerApplication, type RegistryOwnerApplication } from "../registry/application-factory.js";
import { mergeRuntimeSupportManifests } from "./support-manifest.js";
import { createReviewApplication, type ReviewApplication } from "../review/application.js";
import { createStockTokenPriceApplicationFactory, type StockTokenPriceOwnerApplication, type StockTokenPriceReadPort } from "../stock-token-prices/index.js";
import { stockTokenPriceCapabilityIds, stockTokenPricesCapability, stockTokensCapability } from "../stock-token-prices/contracts.js";
import type { ActiveWalletReadPort } from "../wallet/coordinator.js";
import { createEvmAbiCodec } from "../chain/index.js";
import { createSigningCodec } from "../chain/evm-standard.js";
import { uniswapV4PackageRegistration } from "../protocols/uniswap-v4/register.js";
import { uniswapV4PoolsCapability } from "../protocols/uniswap-v4/pools.js";
import { nativeAssetUnitDefinition } from "../registry/native-asset.js";
import { createObservationAuthority, sourceReferenceSchema } from "../core/index.js";
import {
  accountAssetCapabilityIds,
  createAccountAssetApplicationFactory,
  type AccountAssetApplication,
  type AccountAssetApplicationPort,
} from "../account-assets/index.js";
import {
  createStockTokenTradeHistoryApplicationFactory,
  createStockTokenTradeHistoryObservationAuthorities,
  type StockTokenTradeHistoryOwnerApplication,
  type StockTokenTradeHistoryReadCapabilityPort,
} from "../stock-token-trade-history/index.js";
import {CapabilityBindingRegistry, CapabilityRegistry, ObservationAuthorityRegistry, createCanonicalClock, createCapabilityInvocationAuthority, getCapabilityDefinitionSnapshot, parseUtcTimestamp, type AnyReadCapabilityDefinition, type CanonicalClock, type CapabilityBinding, type InvocationBoundaryPorts, type ObservationAuthorityRegistration, type UtcTimestamp} from "../core/index.js";
import {chainReadCapabilities} from "../chain/read-capabilities.js";
import {accountBalanceCapability} from "../account-assets/balance-capability.js";
import {addressInspectCapability, chainStatusCapability, transactionInspectCapability} from "../chain/read-contracts.js";
import {walletConnectionCapability} from "../wallet/connection-capability.js";
import {
  stockTokenTradeHistoryCapability,
  stockTokenTradeHistoryCapabilityIds,
} from "../stock-token-trade-history/contracts.js";
import {
  createProtocolOwnerApplication,
  readProtocolSupportExtension,
  type ProtocolOwnerApplication,
  type ProtocolSupportExtension,
} from "../protocols/index.js";
import { uniswapV2QuoteCapability } from "../protocols/uniswap-v2/index.js";
import {
  createTokenCatalogApplicationFactory,
  type TokenCatalogApplication,
} from "../token-catalog/application-factory.js";
import {
  createRobinhoodOfficialAssetSourceClient,
  type RobinhoodOfficialAssetSourceClient,
} from "../registry/index.js";
import type {
  AccountAssetChainReadPort,
  AddressTargetResolverPort,
  CurrentBlockReadPort,
  ChainInvocationPort,
  OfficialAssetChainReadPort,
  PinnedEvmReadPort,
} from "../chain/index.js";
import type {
  ChainOwnerApplication,
  ChainOwnerApplicationFactory,
} from "../chain/application.js";
import { createSourcifyContractSourceVerification } from "../intelligence/sourcify.js";
import type { ContractSourceVerificationPort } from "../intelligence/ports.js";
import type {
  InterfaceOwnerApplication,
  InterfaceOwnerApplicationContext,
  InterfaceOwnerApplicationFactory,
} from "../interfaces/application.js";
import {
  tokenCatalogCapabilityIds,
  tokenInspectCapability,
} from "../token-catalog/contracts.js";
import {
  type TokenCatalogConsumerPorts,
  tokenCatalogConsumerPortContract,
  type TokenAdditionChainReadPort,
  type TokenCatalogCoordinatorDependencies,
  type TokenCatalogInspectionPort,
  type TokenCatalogManagementApplicationPort,
  type TokenCatalogQueryApplicationPort,
} from "../token-catalog/ports.js";
import {
  readRuntimeConfiguration,
} from "./configuration.js";
import {
  deriveRuntimeConfigurationMac,
  loadOrCreateControlCredential,
} from "./control-credential.js";
import { ProductDatabase } from "./database.js";
import {
  FixedHttpOwner,
  type HttpOwnerApplication,
  type HttpOwnerRootApplication,
  type RuntimeDispatchRequest,
  type RuntimeDispatchResponse,
} from "./http-owner.js";
import {
  createResourceOwnershipScope,
  type OwnedResourceRegistry,
  type ResourceOwnershipScope,
} from "./resource-ownership.js";
import {
  assertRuntimeRouteRegistryDescendant,
  type RuntimeRouteRegistry,
} from "./http-routing.js";
import { normalizeRuntimeError, RuntimeOperationError } from "./errors.js";
import {
  isProcessTerminalRequiredError,
  requireProcessTermination,
  runtimeReleased,
  type RuntimeShutdownOutcome,
} from "./shutdown.js";
import type { RuntimeOwnerSession } from "./owner-session.js";
import {
  ensureOwnerOnlyDirectory,
  resolveApplicationDataDirectory,
  runtimePaths,
} from "./paths.js";
import {
  createRpcSourceAuthority,
  createWalletSourceAuthority,
  type WalletSessionSource,
} from "./source-identity.js";
import { assertChainRuntimeSupportManifestExtension, assertAccountAssetRuntimeSupportManifestExtension, assertInterfaceRuntimeSupportManifestExtension, assertProtocolRuntimeSupportManifestExtension, assertStockTokenTradeHistoryRuntimeSupportManifestExtension, assertStockTokenPriceRuntimeSupportManifestExtension, assertTokenCatalogRuntimeSupportManifestExtension, assertWalletRuntimeSupportManifestExtension, createInitialRuntimeSupportManifest, extendProtocolRuntimeSupportManifest, readRuntimeSupportManifest, type RuntimeSupportManifest } from "./support-manifest.js";
import type {
  ChainCapabilityAuthorityPort,
  ChainReadCapabilityPort,
  RuntimeApplicationContext,
  WalletCapabilityAuthorityPort,
  WalletConnectionReadCapabilityPort,
  WalletPrivateStoreDirectoryPort,
} from "./application-context.js";
import type { PresentationSnapshotStore } from "./presentation-snapshot.js";
import type {
  WalletOwnerApplication,
  WalletOwnerApplicationFactory,
} from "../wallet/application.js";
import type { WalletManagementPort } from "../wallet/contracts.js";
import type { WalletRequestPort } from "../wallet/request-contract.js";
import type { TransactionChainReadPort } from "../chain/transaction-reads.js";

const walletConnectionCapabilityId = getCapabilityDefinitionSnapshot(walletConnectionCapability).capabilityId;
const chainReadCapabilityIds = Object.freeze(chainReadCapabilities.map((definition) =>
  getCapabilityDefinitionSnapshot(definition).capabilityId));

export interface WalletOwnerHandoff<ActiveWallet extends object> {
  readonly supportManifest: RuntimeSupportManifest;
  readonly walletConnection: WalletConnectionReadCapabilityPort;
  readonly activeWallet: ActiveWallet;
}

export interface ChainOwnerHandoff {
  readonly supportManifest: RuntimeSupportManifest;
  readonly addressTargets: AddressTargetResolverPort;
  readonly invocations: ChainInvocationPort;
  readonly chainReads: ChainReadCapabilityPort;
  readonly tokenInspection: TokenCatalogInspectionPort;
  readonly tokenAdditionReads: TokenAdditionChainReadPort;
  readonly officialAssetReads: OfficialAssetChainReadPort;
  readonly accountAssetReads: AccountAssetChainReadPort;
  readonly currentBlockReads: CurrentBlockReadPort;
  readonly protocolReads: PinnedEvmReadPort;
  readonly transactions: TransactionChainReadPort;
}

export interface RegistryOwnerHandoff {
  readonly officialAssets: import("../registry/index.js").OfficialAssetReadPort;
}

export interface ProtocolOwnerHandoff {
  readonly supportExtension: ProtocolSupportExtension;
  readonly uniswapV2Quote: ProtocolOwnerApplication["uniswapV2Quote"];
  readonly uniswapV4Pools: ProtocolOwnerApplication["uniswapV4Pools"];
  readonly poolPrices: ProtocolOwnerApplication["poolPrices"];
}

export interface TokenCatalogOwnerHandoff extends TokenCatalogConsumerPorts {
  readonly supportManifest: RuntimeSupportManifest;
}

export interface AccountAssetOwnerHandoff {
  readonly supportManifest: RuntimeSupportManifest;
  readonly accountAssets: AccountAssetApplicationPort;
}

export interface StockTokenTradeHistoryOwnerHandoff {
  readonly supportManifest: RuntimeSupportManifest;
  readonly tradeHistory: StockTokenTradeHistoryReadCapabilityPort;
}
export interface StockTokenPriceOwnerHandoff {
  readonly supportManifest: RuntimeSupportManifest;
  readonly prices: StockTokenPriceReadPort;
}

interface LocalRuntimeBaseOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => UtcTimestamp;
  readonly robinhoodOfficialAssetSourceClient?: RobinhoodOfficialAssetSourceClient;
  readonly contractSourceVerificationFactory?: (
    clock: CanonicalClock,
  ) => Readonly<{
    readonly port: ContractSourceVerificationPort;
    readonly observationAuthorityRegistration: ObservationAuthorityRegistration;
  }>;
}

type LocalRuntimeApplicationFactories<
  ActiveWallet extends object,
  WalletOperations extends WalletManagementPort,
> =
  | {
      readonly walletApplicationFactory?: never;
      readonly chainApplicationFactory?: never;
      readonly interfaceApplicationFactory?: never;
    }
  | {
      readonly walletApplicationFactory: WalletOwnerApplicationFactory<ActiveWallet, WalletOperations>;
      readonly chainApplicationFactory?: never;
      readonly interfaceApplicationFactory?: never;
    }
  | {
      readonly walletApplicationFactory: WalletOwnerApplicationFactory<ActiveWallet, WalletOperations>;
      readonly chainApplicationFactory: ChainOwnerApplicationFactory<NoInfer<ActiveWallet>>;
      readonly interfaceApplicationFactory?: never;
    }
  | {
      readonly walletApplicationFactory: WalletOwnerApplicationFactory<ActiveWallet, WalletOperations>;
      readonly chainApplicationFactory: ChainOwnerApplicationFactory<NoInfer<ActiveWallet>>;
      readonly interfaceApplicationFactory: InterfaceOwnerApplicationFactory;
    };

export type LocalRuntimeOptions<
  ActiveWallet extends object,
  WalletOperations extends WalletManagementPort,
> = LocalRuntimeBaseOptions & LocalRuntimeApplicationFactories<ActiveWallet, WalletOperations>;

const systemNow = (): UtcTimestamp => parseUtcTimestamp(new Date().toISOString());

const ensureRuntimeStateDirectory = async (path: string): Promise<void> => {
  try { await ensureOwnerOnlyDirectory(path); }
  catch { throw new RuntimeOperationError("runtime_state_unavailable"); }
};

export const createWalletPrivateStoreDirectoryPort = (
  path: string,
  signal: AbortSignal,
): WalletPrivateStoreDirectoryPort => Object.freeze({
  async ensureDirectory(): Promise<string> {
    if (signal.aborted) throw new RuntimeOperationError("request_aborted");
    await ensureRuntimeStateDirectory(path);
    if (signal.aborted) throw new RuntimeOperationError("request_aborted");
    return path;
  },
});

const runApplicationStage = async <Application extends HttpOwnerApplication, Result>(
  parent: ResourceOwnershipScope,
  factory: (resources: OwnedResourceRegistry) => Promise<Application> | Application,
  validate: (application: Application) => Result,
  signal: AbortSignal,
): Promise<Result> => {
  const stage = createResourceOwnershipScope();
  parent.resources.register(stage);
  try {
    const application = await factory(stage.resources);
    stage.resources.register(application);
    const result = validate(application);
    if (signal.aborted) throw new RuntimeOperationError("request_aborted");
    stage.seal();
    if (stage.size !== 1) throw new TypeError("Application stage retained startup resources.");
    return result;
  } catch (error) {
    stage.seal();
    throw error;
  }
};

export interface ApplicationStageContext extends RuntimeApplicationContext {
  readonly supportBase: RuntimeSupportManifest;
}

export type WalletOwnerApplicationStage<
  ActiveWallet extends object,
  WalletOperations extends WalletManagementPort,
> = (
  context: ApplicationStageContext,
) => Promise<WalletOwnerApplication<ActiveWallet, WalletOperations>> |
  WalletOwnerApplication<ActiveWallet, WalletOperations>;
export type ChainOwnerApplicationStage<ActiveWallet extends object> = (
  context: ApplicationStageContext,
  wallet: WalletOwnerHandoff<ActiveWallet>,
) => Promise<ChainOwnerApplication> | ChainOwnerApplication;
export type ProtocolOwnerApplicationStage<ActiveWallet extends object> = (
  context: ApplicationStageContext,
  chain: ChainOwnerHandoff,
  registry: RegistryOwnerHandoff,
) => Promise<ProtocolOwnerApplication> | ProtocolOwnerApplication;
export type TokenCatalogOwnerApplicationStage<ActiveWallet extends object> = (
  context: ApplicationStageContext,
  chain: ChainOwnerHandoff,
  registry: RegistryOwnerHandoff,
) => Promise<TokenCatalogApplication> | TokenCatalogApplication;
export type AccountAssetOwnerApplicationStage<ActiveWallet extends object> = (
  context: ApplicationStageContext,
  chain: ChainOwnerHandoff,
  tokenCatalog: TokenCatalogOwnerHandoff,
  registry: RegistryOwnerHandoff,
) => Promise<AccountAssetApplication> | AccountAssetApplication;
export type StockTokenTradeHistoryOwnerApplicationStage<ActiveWallet extends object> = (
  context: ApplicationStageContext,
  chain: ChainOwnerHandoff,
  registry: RegistryOwnerHandoff,
) => Promise<StockTokenTradeHistoryOwnerApplication> | StockTokenTradeHistoryOwnerApplication;
export type StockTokenPriceOwnerApplicationStage = (
  context: ApplicationStageContext,
  chain: ChainOwnerHandoff,
  protocols: ProtocolOwnerHandoff,
  registry: RegistryOwnerHandoff,
) => Promise<StockTokenPriceOwnerApplication> | StockTokenPriceOwnerApplication;
export type ReviewOwnerHandoff = Pick<ReviewApplication, "exchange" | "activity" | "signing" | "presentations">;
export type ReviewOwnerApplication = ReviewApplication & HttpOwnerApplication;
export type ReviewOwnerApplicationStage<ActiveWallet extends object> = (
  context: ApplicationStageContext,
  wallet: WalletOwnerHandoff<ActiveWallet>,
  chain: ChainOwnerHandoff,
  registry: RegistryOwnerHandoff,
  walletRequests: WalletRequestPort,
) => Promise<ReviewOwnerApplication> | ReviewOwnerApplication;
export type InterfaceOwnerApplicationStage<
  ActiveWallet extends object,
  WalletOperations extends WalletManagementPort,
> = (
  context: ApplicationStageContext,
  wallet: WalletOwnerHandoff<ActiveWallet>,
  chain: ChainOwnerHandoff,
  protocols: ProtocolOwnerHandoff,
  tokenCatalog: TokenCatalogOwnerHandoff,
  accountAssets: AccountAssetOwnerHandoff,
  tradeHistory: StockTokenTradeHistoryOwnerHandoff,
  prices: StockTokenPriceOwnerHandoff,
  supportManifest: RuntimeSupportManifest,
  walletOperations: WalletOperations,
  exchange: ReviewOwnerHandoff,
) => Promise<InterfaceOwnerApplication> | InterfaceOwnerApplication;

export type RegistryOwnerApplicationStage = (context: ApplicationStageContext) =>
  Promise<RegistryOwnerApplication> | RegistryOwnerApplication;
export interface OwnerApplicationStages<ActiveWallet extends object, WalletOperations extends WalletManagementPort> {
  readonly wallet: WalletOwnerApplicationStage<ActiveWallet, WalletOperations>;
  readonly chain?: ChainOwnerApplicationStage<ActiveWallet>;
  readonly registry?: RegistryOwnerApplicationStage;
  readonly protocols?: ProtocolOwnerApplicationStage<ActiveWallet>;
  readonly tokenCatalog?: TokenCatalogOwnerApplicationStage<ActiveWallet>;
  readonly accountAssets?: AccountAssetOwnerApplicationStage<ActiveWallet>;
  readonly tradeHistory?: StockTokenTradeHistoryOwnerApplicationStage<ActiveWallet>;
  readonly prices?: StockTokenPriceOwnerApplicationStage;
  readonly review?: ReviewOwnerApplicationStage<ActiveWallet>;
  readonly interfaces?: InterfaceOwnerApplicationStage<ActiveWallet, WalletOperations>;
}

const snapshotWalletConnection = (
  input: WalletConnectionReadCapabilityPort,
): WalletConnectionReadCapabilityPort => {
  new CapabilityBindingRegistry(new CapabilityRegistry([walletConnectionCapability]), [input.connection]);
  return Object.freeze({ connection: input.connection });
};

const assertBindingProvenance = <Definition extends AnyReadCapabilityDefinition>(
  definition: Definition,
  binding: CapabilityBinding<Definition>,
): void => {
  new CapabilityBindingRegistry(new CapabilityRegistry([definition]), [binding]);
};

const snapshotChainReads = (input: ChainReadCapabilityPort): ChainReadCapabilityPort => {
  assertBindingProvenance(accountBalanceCapability, input.accountBalance);
  assertBindingProvenance(addressInspectCapability, input.addressInspect);
  assertBindingProvenance(chainStatusCapability, input.chainStatus);
  assertBindingProvenance(transactionInspectCapability, input.transactionInspect);
  return Object.freeze({
    accountBalance: input.accountBalance,
    addressInspect: input.addressInspect,
    chainStatus: input.chainStatus,
    transactionInspect: input.transactionInspect,
  });
};

const snapshotStockTokenTradeHistory = (
  input: StockTokenTradeHistoryReadCapabilityPort,
): StockTokenTradeHistoryReadCapabilityPort => {
  assertBindingProvenance(stockTokenTradeHistoryCapability, input.binding);
  return Object.freeze({ binding: input.binding });
};

const snapshotTokenInspection = (
  input: TokenCatalogInspectionPort,
): TokenCatalogInspectionPort => {
  assertBindingProvenance(tokenInspectCapability, input);
  return input;
};

const snapshotTokenCatalogConsumerPorts = (
  input: TokenCatalogConsumerPorts,
): TokenCatalogConsumerPorts => {
  const assertPort = (
    name: string,
    port: object,
    definition: Readonly<{
      methods: readonly string[];
    }>,
  ): void => {
    const expectedKeys = [...definition.methods].sort();
    const actualKeys = Reflect.ownKeys(port);
    if (
      actualKeys.some((key) => typeof key !== "string") ||
      JSON.stringify(actualKeys.slice().sort()) !== JSON.stringify(expectedKeys) ||
      definition.methods.some((method) => typeof (port as Record<string, unknown>)[method] !== "function")
    ) throw new TypeError(`Token catalog ${name} authority is invalid.`);
  };
  assertPort(
    "account token selection",
    input.accountTokenSelectionStore,
    tokenCatalogConsumerPortContract.accountTokenSelectionStore,
  );
  assertPort(
    "query",
    input.tokenCatalogQueries,
    tokenCatalogConsumerPortContract.tokenCatalogQueries,
  );
  assertPort(
    "management",
    input.tokenCatalogManagement,
    tokenCatalogConsumerPortContract.tokenCatalogManagement,
  );
  return Object.freeze({
    accountTokenSelectionStore: Object.freeze({
      isAccountRetained: (...args: Parameters<TokenCatalogConsumerPorts["accountTokenSelectionStore"]["isAccountRetained"]>) =>
        input.accountTokenSelectionStore.isAccountRetained(...args),
      getState: (...args: Parameters<TokenCatalogConsumerPorts["accountTokenSelectionStore"]["getState"]>) =>
        input.accountTokenSelectionStore.getState(...args),
      getForAccount: (...args: Parameters<TokenCatalogConsumerPorts["accountTokenSelectionStore"]["getForAccount"]>) =>
        input.accountTokenSelectionStore.getForAccount(...args),
      listIncludedForAccount: (...args: Parameters<TokenCatalogConsumerPorts["accountTokenSelectionStore"]["listIncludedForAccount"]>) =>
        input.accountTokenSelectionStore.listIncludedForAccount(...args),
      initializeDefaults: (...args: Parameters<TokenCatalogConsumerPorts["accountTokenSelectionStore"]["initializeDefaults"]>) =>
        input.accountTokenSelectionStore.initializeDefaults(...args),
    }),
    tokenCatalogQueries: Object.freeze({
      getSelection: (request: Parameters<TokenCatalogQueryApplicationPort["getSelection"]>[0]) =>
        input.tokenCatalogQueries.getSelection(request),
      listSelections: (request: Parameters<TokenCatalogQueryApplicationPort["listSelections"]>[0]) =>
        input.tokenCatalogQueries.listSelections(request),
    }),
    tokenCatalogManagement: Object.freeze({
      review: (request: Parameters<TokenCatalogManagementApplicationPort["review"]>[0]) =>
        input.tokenCatalogManagement.review(request),
      decide: (request: Parameters<TokenCatalogManagementApplicationPort["decide"]>[0]) =>
        input.tokenCatalogManagement.decide(request),
      getOperation: (request: Parameters<TokenCatalogManagementApplicationPort["getOperation"]>[0]) =>
        input.tokenCatalogManagement.getOperation(request),
    }),
  });
};

const assertCapabilityDirectSupport = (
  manifest: RuntimeSupportManifest,
  capabilityIds: readonly string[],
): void => {
  const snapshot = readRuntimeSupportManifest(manifest);
  for (const capabilityId of capabilityIds) {
    if (snapshot.capabilities.find((entry) => entry.capabilityId === capabilityId)?.availability.direct !== "internal") {
      throw new TypeError("Application capability output is absent from its support manifest.");
    }
  }
};

export const composeOwnerApplicationStages = async <ActiveWallet extends object, WalletOperations extends WalletManagementPort,>(context: RuntimeApplicationContext, initialSupportManifest: RuntimeSupportManifest, stages: OwnerApplicationStages<ActiveWallet, WalletOperations>): Promise<HttpOwnerRootApplication & Readonly<{ supportManifest: RuntimeSupportManifest }>> => {
    const applications = createResourceOwnershipScope();
    const cleanupRegistration = context.startupResources.register(applications);
    const walletApplications = createResourceOwnershipScope();
    const dependentApplications = createResourceOwnershipScope();
    applications.resources.register(walletApplications);
    applications.resources.register(dependentApplications);
    let currentRoutes = context.routes;
    let walletApplication: WalletOwnerApplication<ActiveWallet, WalletOperations> | undefined;
    try {
        const walletRoutes = currentRoutes;
        const walletResult = await runApplicationStage(walletApplications, (startupResources) => stages.wallet({
            routes: walletRoutes,
            signal: context.signal,
            startupResources,
            supportBase: initialSupportManifest,
        }), (wallet) => {
            assertRuntimeRouteRegistryDescendant(walletRoutes, wallet.routes);
            assertWalletRuntimeSupportManifestExtension(initialSupportManifest, wallet.supportManifest);
            const walletConnection = snapshotWalletConnection(wallet.walletConnection);
            const activeWallet = wallet.activeWallet;
            const activeWalletType = typeof activeWallet;
            if (activeWallet === null || (activeWalletType !== "object" && activeWalletType !== "function")) {
                throw new TypeError("Active wallet read port must be a reference value.");
            }
            const walletOperations = wallet.walletOperations;
            const walletOperationsType = typeof walletOperations;
            if (walletOperations === null || (walletOperationsType !== "object" && walletOperationsType !== "function")) {
                throw new TypeError("Wallet operation port must be a reference value.");
            }
            const walletRequests = wallet.walletRequests;
            if (typeof walletRequests !== "object" || walletRequests === null ||
                typeof walletRequests.hasPendingRequest !== "function" || typeof walletRequests.startRequest !== "function") {
                throw new TypeError("Wallet transaction authority is unavailable.");
            }
            assertCapabilityDirectSupport(wallet.supportManifest, [walletConnectionCapabilityId]);
            if (context.signal.aborted)
                throw new RuntimeOperationError("request_aborted");
            return Object.freeze({
                application: wallet,
                handoff: Object.freeze({
                    supportManifest: wallet.supportManifest,
                    walletConnection,
                    activeWallet,
                }) satisfies WalletOwnerHandoff<ActiveWallet>,
                walletOperations,
                walletRequests,
            });
        }, context.signal);
        const wallet = walletResult.application;
        walletApplication = wallet;
        const walletHandoff = walletResult.handoff;
        const walletOperations = walletResult.walletOperations;
        const walletRequests = walletResult.walletRequests;
        currentRoutes = wallet.routes;
        const supportParts: RuntimeSupportManifest[] = [wallet.supportManifest];
        let chain: ChainOwnerApplication | undefined;
        let chainHandoff: ChainOwnerHandoff | undefined;
        if (stages.chain !== undefined) {
            const before = currentRoutes;
            const chainResult = await runApplicationStage(dependentApplications, resources => stages.chain!({
                routes: before, signal: context.signal, startupResources: resources,
                supportBase: initialSupportManifest,
            }, walletHandoff), application => {
                assertRuntimeRouteRegistryDescendant(before, application.routes);
                assertChainRuntimeSupportManifestExtension(initialSupportManifest, application.supportManifest);
                const reads = snapshotChainReads(application.chainReads);
                const addressTargets = application.addressTargets;
                const invocations = application.invocations;
                const tokenInspection = snapshotTokenInspection(application.tokenInspection);
                const tokenAdditionReads = application.tokenAdditionReads;
                const officialAssetReads = application.officialAssetReads;
                const accountAssetReads = application.accountAssetReads;
                const currentBlockReads = application.currentBlockReads;
                const protocolReads = application.protocolReads;
                const transactions = application.transactions;
                if (typeof transactions !== "object" || transactions === null ||
                    ["balance", "nonce", "estimateGas", "simulate", "readTransaction", "finality"].some((method) => typeof (transactions as unknown as Record<string, unknown>)[method] !== "function")) {
                    throw new TypeError("Transaction Chain reads are unavailable.");
                }
                if (typeof addressTargets !== "object" || addressTargets === null ||
                    typeof addressTargets.resolve !== "function")
                    throw new TypeError("Address target resolution authority is unavailable.");
                if (typeof tokenAdditionReads !== "object" || tokenAdditionReads === null ||
                    typeof tokenAdditionReads.inspectAndVerifyOfficial !== "function")
                    throw new TypeError("Token addition chain read authority is unavailable.");
                if (typeof invocations !== "object" || invocations === null ||
                    typeof invocations.run !== "function")
                    throw new TypeError("Chain invocation authority is unavailable.");
                if (typeof officialAssetReads !== "object" || officialAssetReads === null ||
                    typeof officialAssetReads.verifyAtBlock !== "function" ||
                    typeof officialAssetReads.verifyManyAtBlock !== "function")
                    throw new TypeError("Official asset chain read authority is unavailable.");
                if (typeof accountAssetReads !== "object" || accountAssetReads === null ||
                    typeof accountAssetReads.readCollectionAtBlock !== "function")
                    throw new TypeError("Account asset chain read authority is unavailable.");
                if (typeof currentBlockReads !== "object" || currentBlockReads === null ||
                    typeof currentBlockReads.resolveCurrentBlock !== "function")
                    throw new TypeError("Current-block read authority is unavailable.");
                if (typeof protocolReads !== "object" || protocolReads === null ||
                    typeof protocolReads.resolveBlock !== "function" ||
                    typeof protocolReads.readRuntimeCode !== "function" ||
                    typeof protocolReads.call !== "function" ||
                    typeof protocolReads.readTokenDecimals !== "function" ||
                    typeof protocolReads.inspectContract !== "function" ||
                    typeof protocolReads.recordConfiguredChain !== "function")
                    throw new TypeError("Pinned EVM read authority is unavailable.");
                assertCapabilityDirectSupport(application.supportManifest, chainReadCapabilityIds);
                if (context.signal.aborted)
                    throw new RuntimeOperationError("request_aborted");
                return Object.freeze({
                    application: application,
                    reads,
                    handoff: Object.freeze({
                        supportManifest: application.supportManifest,
                        addressTargets,
                        invocations,
                        chainReads: reads,
                        tokenInspection,
                        tokenAdditionReads,
                        officialAssetReads,
                        accountAssetReads,
                        currentBlockReads,
                        protocolReads,
                        transactions,
                    }) satisfies ChainOwnerHandoff,
                });
            }, context.signal);
            chain = chainResult.application;
            currentRoutes = chain.routes;
            supportParts.push(chain.supportManifest);
            chainHandoff = chainResult.handoff;
        }
        let registry: RegistryOwnerApplication | undefined;
        if (stages.registry !== undefined) {
            registry = await runApplicationStage(dependentApplications, resources => stages.registry!({ routes: currentRoutes, signal: context.signal,
                startupResources: resources, supportBase: initialSupportManifest }), application => {
                if (typeof application.officialAssets !== "object" || application.officialAssets === null ||
                    typeof application.officialAssets.synchronize !== "function" ||
                    typeof application.officialAssets.readStored !== "function" ||
                    typeof application.officialAssets.close !== "function" || typeof application.close !== "function") {
                    throw new TypeError("Registry ownership is unavailable.");
                }
                assertRuntimeRouteRegistryDescendant(currentRoutes, application.routes);
                return application;
            }, context.signal);
            currentRoutes = registry.routes;
        }
        const registryHandoff = registry === undefined ? undefined : Object.freeze({
            officialAssets: Object.freeze({
                synchronize: (signal: AbortSignal) => registry.officialAssets.synchronize(signal),
                readStored: () => registry.officialAssets.readStored(),
            }),
        }) satisfies RegistryOwnerHandoff;
        let tokenCatalog: TokenCatalogApplication | undefined;
        let catalog: TokenCatalogOwnerHandoff | undefined;
        if (stages.tokenCatalog !== undefined) {
            if (chainHandoff === undefined || registryHandoff === undefined)
                throw new TypeError("Token dependencies are unavailable.");
            const before = currentRoutes;
            tokenCatalog = await runApplicationStage(dependentApplications, resources => stages.tokenCatalog!({ routes: before, signal: context.signal, startupResources: resources,
                supportBase: initialSupportManifest }, chainHandoff!, registryHandoff!), application => {
                assertRuntimeRouteRegistryDescendant(before, application.routes);
                assertTokenCatalogRuntimeSupportManifestExtension(initialSupportManifest, application.supportManifest);
                const ports = snapshotTokenCatalogConsumerPorts(application);
                assertCapabilityDirectSupport(application.supportManifest, tokenCatalogCapabilityIds);
                return Object.freeze({ ...application, ...ports });
            }, context.signal);
            catalog = Object.freeze({
                supportManifest: tokenCatalog.supportManifest,
                ...snapshotTokenCatalogConsumerPorts(tokenCatalog),
            });
            currentRoutes = tokenCatalog.routes;
            supportParts.push(tokenCatalog.supportManifest);
        }
        let protocolApplication: ProtocolOwnerApplication | undefined;
        let protocolHandoff: ProtocolOwnerHandoff | undefined;
        if (stages.protocols !== undefined) {
            if (chainHandoff === undefined || registryHandoff === undefined)
                throw new TypeError("Protocol dependencies are unavailable.");
            const before = currentRoutes;
            protocolApplication = await runApplicationStage(dependentApplications, resources => stages.protocols!({ routes: before, signal: context.signal, startupResources: resources,
                supportBase: initialSupportManifest }, chainHandoff!, registryHandoff!), application => {
                assertRuntimeRouteRegistryDescendant(before, application.routes);
                assertBindingProvenance(uniswapV2QuoteCapability, application.uniswapV2Quote);
                assertBindingProvenance(uniswapV4PoolsCapability, application.uniswapV4Pools);
                return application;
            }, context.signal);
            protocolHandoff = Object.freeze({
                supportExtension: protocolApplication.supportExtension,
                uniswapV2Quote: protocolApplication.uniswapV2Quote,
                uniswapV4Pools: protocolApplication.uniswapV4Pools,
                poolPrices: protocolApplication.poolPrices,
            });
            currentRoutes = protocolApplication.routes;
            supportParts.push(extendProtocolRuntimeSupportManifest(initialSupportManifest, readProtocolSupportExtension(protocolApplication.supportExtension)));
        }
        let accountApplication: AccountAssetApplication | undefined;
        let accountHandoff: AccountAssetOwnerHandoff | undefined;
        if (stages.accountAssets !== undefined) {
            if (chainHandoff === undefined || catalog === undefined || registryHandoff === undefined)
                throw new TypeError("Account dependencies are unavailable.");
            const before = currentRoutes;
            accountApplication = await runApplicationStage(dependentApplications, resources => stages.accountAssets!({ routes: before, signal: context.signal, startupResources: resources,
                supportBase: initialSupportManifest }, chainHandoff!, catalog!, registryHandoff!), application => {
                assertRuntimeRouteRegistryDescendant(before, application.routes);
                assertAccountAssetRuntimeSupportManifestExtension(initialSupportManifest, application.supportManifest);
                assertCapabilityDirectSupport(application.supportManifest, accountAssetCapabilityIds);
                return application;
            }, context.signal);
            accountHandoff = Object.freeze({ supportManifest: accountApplication.supportManifest, accountAssets: Object.freeze({ list: (...args: Parameters<AccountAssetApplicationPort["list"]>) => accountApplication!.list(...args) }) });
            currentRoutes = accountApplication.routes;
            supportParts.push(accountApplication.supportManifest);
        }
        let historyApplication: StockTokenTradeHistoryOwnerApplication | undefined;
        let historyHandoff: StockTokenTradeHistoryOwnerHandoff | undefined;
        if (stages.tradeHistory !== undefined) {
            if (chainHandoff === undefined || registryHandoff === undefined)
                throw new TypeError("Trade-history dependencies are unavailable.");
            const before = currentRoutes;
            historyApplication = await runApplicationStage(dependentApplications, resources => stages.tradeHistory!({ routes: before, signal: context.signal, startupResources: resources,
                supportBase: initialSupportManifest }, chainHandoff!, registryHandoff!), application => {
                assertRuntimeRouteRegistryDescendant(before, application.routes);
                assertStockTokenTradeHistoryRuntimeSupportManifestExtension(initialSupportManifest, application.supportManifest);
                assertCapabilityDirectSupport(application.supportManifest, stockTokenTradeHistoryCapabilityIds);
                return application;
            }, context.signal);
            historyHandoff = Object.freeze({ supportManifest: historyApplication.supportManifest, tradeHistory: snapshotStockTokenTradeHistory(historyApplication) });
            currentRoutes = historyApplication.routes;
            supportParts.push(historyApplication.supportManifest);
        }
        let prices: StockTokenPriceOwnerHandoff | undefined;
        if (stages.prices !== undefined) {
            if (chainHandoff === undefined || protocolHandoff === undefined || registryHandoff === undefined)
                throw new TypeError("Price dependencies are unavailable.");
            const before = currentRoutes;
            const application = await runApplicationStage(dependentApplications, resources => stages.prices!({ routes: before, signal: context.signal, startupResources: resources,
                supportBase: initialSupportManifest }, chainHandoff!, protocolHandoff!, registryHandoff!), application => {
                assertRuntimeRouteRegistryDescendant(before, application.routes);
                assertStockTokenPriceRuntimeSupportManifestExtension(initialSupportManifest, application.supportManifest);
                assertCapabilityDirectSupport(application.supportManifest, stockTokenPriceCapabilityIds);
                assertBindingProvenance(stockTokenPricesCapability, application.prices);
                assertBindingProvenance(stockTokensCapability, application.tokens);
                return application;
            }, context.signal);
            prices = Object.freeze({ supportManifest: application.supportManifest, prices: Object.freeze({ prices: application.prices, tokens: application.tokens }) });
            currentRoutes = application.routes;
            supportParts.push(application.supportManifest);
        }
        let reviewHandoff: ReviewOwnerHandoff | undefined;
        if (stages.review !== undefined) {
            if (chainHandoff === undefined || registryHandoff === undefined)
                throw new TypeError("Review dependencies are unavailable.");
            const before = currentRoutes;
            const reviewApplication = await runApplicationStage(dependentApplications, resources => stages.review!({ routes: before, signal: context.signal, startupResources: resources,
                supportBase: initialSupportManifest }, walletHandoff, chainHandoff!, registryHandoff!, walletRequests), application => {
                assertRuntimeRouteRegistryDescendant(before, application.routes);
                return application;
            }, context.signal);
            currentRoutes = reviewApplication.routes;
            reviewHandoff = Object.freeze({ exchange: reviewApplication.exchange, activity: reviewApplication.activity,
                signing: reviewApplication.signing, presentations: reviewApplication.presentations });
        }
        let composedSupport = mergeRuntimeSupportManifests(initialSupportManifest, supportParts);
        if (stages.interfaces !== undefined) {
            if (chainHandoff === undefined || protocolHandoff === undefined || catalog === undefined || accountHandoff === undefined || historyHandoff === undefined || prices === undefined || reviewHandoff === undefined) {
                throw new TypeError("Interface application dependencies are unavailable.");
            }
            const before = currentRoutes;
            const application = await runApplicationStage(dependentApplications, resources => stages.interfaces!({ routes: before, signal: context.signal, startupResources: resources,
                supportBase: initialSupportManifest }, walletHandoff, chainHandoff!, protocolHandoff!, catalog!, accountHandoff!, historyHandoff!, prices!, composedSupport, walletOperations, reviewHandoff!), application => {
                assertRuntimeRouteRegistryDescendant(before, application.routes);
                assertInterfaceRuntimeSupportManifestExtension(composedSupport, application.supportManifest);
                return application;
            }, context.signal);
            currentRoutes = application.routes;
            composedSupport = application.supportManifest;
        }
        applications.seal();
        let shutdownWork: Promise<RuntimeShutdownOutcome> | undefined;
        const shutdown = (): Promise<RuntimeShutdownOutcome> => {
            if (shutdownWork !== undefined)
                return shutdownWork;
            shutdownWork = Promise.resolve().then(async () => {
                let dependentFailure: unknown;
                try {
                    await dependentApplications.close();
                }
                catch (error) {
                    dependentFailure = error;
                }
                let outcome: RuntimeShutdownOutcome;
                try {
                    outcome = await wallet.shutdown();
                }
                catch (error) {
                    if (isProcessTerminalRequiredError(error)) {
                        throw requireProcessTermination(dependentFailure ?? error.primaryFailure ?? error);
                    }
                    throw error;
                }
                if (dependentFailure !== undefined) {
                    if (outcome.kind === "process_terminal") {
                        throw requireProcessTermination(dependentFailure);
                    }
                    throw dependentFailure;
                }
                if (outcome.kind === "released") {
                    await walletApplications.close();
                    await applications.close();
                    return runtimeReleased;
                }
                return outcome;
            });
            return shutdownWork;
        };
        const application = Object.freeze({
            routes: currentRoutes,
            supportManifest: composedSupport,
            shutdown,
            close: async (): Promise<void> => {
                const outcome = await shutdown();
                if (outcome.kind === "process_terminal")
                    throw requireProcessTermination();
            },
        });
        cleanupRegistration.transfer();
        return application;
    }
    catch (startupError) {
        applications.seal();
        try {
            await dependentApplications.close();
            if (walletApplication !== undefined) {
                const outcome = await walletApplication.shutdown();
                if (outcome.kind === "process_terminal") {
                    throw requireProcessTermination(startupError);
                }
            }
            await walletApplications.close();
            await applications.close();
            cleanupRegistration.transfer();
        }
        catch (cleanupError) {
            if (isProcessTerminalRequiredError(cleanupError)) {
                throw cleanupError.primaryFailure === undefined
                    ? requireProcessTermination(startupError)
                    : cleanupError;
            }
            throw new AggregateError([startupError, cleanupError], "Application startup and cleanup failed.");
        }
        throw startupError;
    }
};

export class LocalRuntime {
  readonly #database: ProductDatabase;
  readonly #createHttpOwner: (database: ProductDatabase) => FixedHttpOwner;
  #httpOwner: FixedHttpOwner | undefined;
  #databaseClosed = false;
  #stopRequested = false;
  #startPromise: Promise<void> | undefined;
  #stopPromise: Promise<RuntimeShutdownOutcome> | undefined;

  private constructor(
    database: ProductDatabase,
    createHttpOwner: (database: ProductDatabase) => FixedHttpOwner,
  ) {
    this.#database = database;
    this.#createHttpOwner = createHttpOwner;
  }

  get ownerState(): FixedHttpOwner["state"] { return this.#httpOwner?.state ?? "stopped"; }

  presentationSnapshotStore(): PresentationSnapshotStore {
    if (this.#databaseClosed) throw new RuntimeOperationError("state_conflict");
    return this.#database.presentationSnapshotStore();
  }

  static async create<
    ActiveWallet extends object = object,
    WalletOperations extends WalletManagementPort = WalletManagementPort,
  >(
    options: LocalRuntimeOptions<ActiveWallet, WalletOperations> = {},
  ): Promise<LocalRuntime> {
    const environment = options.environment ?? process.env;
    const now = options.now ?? systemNow;
    const configuration = readRuntimeConfiguration(environment);
    const initialSupportManifest = createInitialRuntimeSupportManifest(configuration.chain);
    const paths = runtimePaths(resolveApplicationDataDirectory(environment));
    const walletApplicationFactory = options.walletApplicationFactory;
    const chainApplicationFactory = options.chainApplicationFactory;
    const interfaceApplicationFactory = options.interfaceApplicationFactory;
    const robinhoodOfficialAssetSourceClient =
      options.robinhoodOfficialAssetSourceClient;
    const contractSourceVerificationFactory =
      options.contractSourceVerificationFactory;
    if ((walletApplicationFactory === undefined && (chainApplicationFactory !== undefined || interfaceApplicationFactory !== undefined)) ||
      (chainApplicationFactory === undefined && interfaceApplicationFactory !== undefined)) {
      throw new TypeError("Owner application factories must form a dependency prefix.");
    }
    await ensureRuntimeStateDirectory(paths.dataDirectory);
    const credential = await loadOrCreateControlCredential(paths.dataDirectory, paths.controlCredential);
    const configurationMac = deriveRuntimeConfigurationMac(credential, configuration);
    const createHttpOwner = (database: ProductDatabase): FixedHttpOwner => {
      const ownerStore = database.ownerStore();
      const walletProjection = database.walletStore();
      const profile = ownerStore.readProfile();
      const clock = createCanonicalClock(now);
      const invocationAuthority = createCapabilityInvocationAuthority(clock, configuration.chain.chainId);
      const rpcSource = createRpcSourceAuthority({
        credential,
        endpoint: configuration.rpc.endpoint,
        clock,
      });
      const contractSourceVerification = contractSourceVerificationFactory === undefined
        ? createSourcifyContractSourceVerification({ clock })
        : contractSourceVerificationFactory(clock);
      const walletSource = createWalletSourceAuthority({ credential, profileId: profile.profileId, clock });
      const stockTokenTradeHistorySources =
        createStockTokenTradeHistoryObservationAuthorities(clock);
      const nativeUnitAuthority = createObservationAuthority({ clock, sourceClass: "official_document", owner: "Native asset definition",
        reference: sourceReferenceSchema.parse({ kind: "public", sourceId: "native-ether-definition", uri: nativeAssetUnitDefinition.chainSource }) });
      const chainAuthorities = [rpcSource.observationAuthority, contractSourceVerification.observationAuthorityRegistration,
        stockTokenTradeHistorySources.officialAsset, stockTokenTradeHistorySources.archive, nativeUnitAuthority];
      const chainPorts = Object.freeze({
        observations: new ObservationAuthorityRegistry(clock, chainAuthorities),
      });
      const walletCapabilityAuthority: WalletCapabilityAuthorityPort = Object.freeze({
        clock,
        invocationAuthority,
        createInvocationPorts(session?: WalletSessionSource): InvocationBoundaryPorts {
          const authorities = [walletSource.sdkStoreAuthority];
          if (session !== undefined) authorities.push(session.observationAuthority);
          return Object.freeze({ observations: new ObservationAuthorityRegistry(clock, authorities) });
        },
      });
      const walletStage: WalletOwnerApplicationStage<ActiveWallet, WalletOperations> | undefined =
        walletApplicationFactory === undefined
          ? undefined
          : ({ routes, signal, startupResources }) => walletApplicationFactory({
            routes,
            signal,
            startupResources,
            supportManifest: initialSupportManifest,
            wallet: Object.freeze({
              configuration: configuration.wallet,
              privateStoreDirectory: createWalletPrivateStoreDirectoryPort(
                paths.walletConnectDirectory,
                signal,
              ),
              projection: walletProjection,
              operations: database.walletOperationStore(),
              sourceAuthority: walletSource,
              capabilityAuthority: walletCapabilityAuthority,
            }),
          });
      const chainStage: ChainOwnerApplicationStage<ActiveWallet> | undefined = chainApplicationFactory === undefined
        ? undefined
        : ({ routes, signal, startupResources }, wallet) => chainApplicationFactory({
          routes,
          signal,
          startupResources,
          supportManifest: initialSupportManifest,
          walletConnection: wallet.walletConnection,
          activeWallet: wallet.activeWallet,
          chain: Object.freeze({
            configuration: configuration.rpc,
            sourceAuthority: rpcSource,
            capabilityAuthority: Object.freeze({
              clock,
              invocationAuthority,
              invocationPorts: chainPorts,
            }),
            contractSourceVerification: contractSourceVerification.port,
          }),
        });
      const protocolStage: ProtocolOwnerApplicationStage<ActiveWallet> | undefined =
        chainStage === undefined
          ? undefined
          : ({ routes }, chain, registry) => createProtocolOwnerApplication({
            officialAssets: registry.officialAssets,
            officialAssetObservationAuthority: stockTokenTradeHistorySources.officialAsset,
            routes,
            invocations: chain.invocations,
            reads: chain.protocolReads,
            invocationAuthority,
            invocationPorts: chainPorts,
          });
      const registryStage: RegistryOwnerApplicationStage | undefined = chainStage === undefined ? undefined :
        ({ routes, signal, startupResources }) => createRegistryOwnerApplication({
          routes, signal, startupResources,
          source: robinhoodOfficialAssetSourceClient ?? createRobinhoodOfficialAssetSourceClient(),
          store: database.officialAssetSnapshotStore(),
        });
      const tokenCatalogStage: TokenCatalogOwnerApplicationStage<ActiveWallet> | undefined = chainStage === undefined ? undefined :
        ({ routes, signal, startupResources }, chain, registry) => createTokenCatalogApplicationFactory({
          routes, signal, startupResources, supportManifest: initialSupportManifest,
          addressTargets: chain.addressTargets, additionChainReads: chain.tokenAdditionReads,
          officialAssets: registry.officialAssets, store: database.tokenCatalogStore(),
          readStore: database.tokenCatalogReadStore(), accountTokenSelectionStore: database.accountTokenSelectionStore(),clock,
        });
      const accountAssetStage: AccountAssetOwnerApplicationStage<ActiveWallet> | undefined =
        tokenCatalogStage === undefined
          ? undefined
          : ({ routes, signal, startupResources }, chain, tokenCatalog, registry) =>
            createAccountAssetApplicationFactory({
              routes,
              supportManifest: initialSupportManifest,
              addressTargets: chain.addressTargets,
              selections: tokenCatalog.accountTokenSelectionStore,
              officialAssets: registry.officialAssets,
              chainInvocations: chain.invocations,
              officialAssetReads: chain.officialAssetReads,
              currentBlockReads: chain.currentBlockReads,
              chainReads: chain.accountAssetReads,
              clock,
              signal,
              startupResources,
            });
      const stockTokenTradeHistoryStage: StockTokenTradeHistoryOwnerApplicationStage<ActiveWallet> | undefined =
        chainStage === undefined
          ? undefined
          : ({ routes, startupResources }, chain, registry) =>
            createStockTokenTradeHistoryApplicationFactory({
              routes,
              supportManifest: initialSupportManifest,
              chainInvocations: chain.invocations,
              currentBlockReads: chain.currentBlockReads,
              officialAssetReads: chain.officialAssetReads,
              protocolReads: chain.protocolReads,
              officialAssets: registry.officialAssets,
              invocationAuthority,
              invocationPorts: chainPorts,
              officialAssetObservationAuthority: stockTokenTradeHistorySources.officialAsset,
              archiveObservationAuthority: stockTokenTradeHistorySources.archive,
              now: () => new Date(now()),
              startupResources,
            });
      const priceStage: StockTokenPriceOwnerApplicationStage | undefined = chainStage === undefined ? undefined :
        ({ routes, signal, startupResources }, chain, protocols, registry) =>
          createStockTokenPriceApplicationFactory({
            routes, ownerSignal: signal, startupResources, supportManifest: initialSupportManifest, clock,
            chainInvocations: chain.invocations, currentBlockReads: chain.currentBlockReads,
            officialAssetReads: chain.officialAssetReads, protocolReads: chain.protocolReads,
            poolReads: protocols.poolPrices, officialAssets: registry.officialAssets,
            officialAssetObservationAuthority: stockTokenTradeHistorySources.officialAsset,
            invocationAuthority, invocationPorts: chainPorts,
          });
      const reviewStage: ReviewOwnerApplicationStage<ActiveWallet> | undefined = chainStage === undefined ? undefined :
        ({ routes, startupResources }, wallet, chain, registry, walletRequests) => {
          if (!("capture" in wallet.activeWallet) || typeof wallet.activeWallet.capture !== "function") {
            throw new TypeError("Exchange requires the canonical active Wallet capture port.");
          }
          const codec = createEvmAbiCodec();
          const application = createReviewApplication({
            preparation: { clock, invocationAuthority,
              createInvocationPorts: (session) => ({ observations: new ObservationAuthorityRegistry(clock, [...chainAuthorities, session.observationAuthority]) }),
              activeWallet: wallet.activeWallet as ActiveWalletReadPort,
              chainInvocations: chain.invocations, reads: chain.protocolReads, transactions: chain.transactions,
              officialAssets: registry.officialAssets, officialAssetReads: chain.officialAssetReads,
              officialAssetObservationAuthority: stockTokenTradeHistorySources.officialAsset,
              evm: uniswapV4PackageRegistration.createNativeOperations(codec) },
            receiptInvocationPorts: chainPorts, nativeUnitAuthority, codec, signingCodec: createSigningCodec(), walletRequests,
            ledger: database.transactionLedgerStore(),
          });
          return Object.freeze({ ...application, routes });
        };
      const interfaceStage: InterfaceOwnerApplicationStage<ActiveWallet, WalletOperations> | undefined =
        interfaceApplicationFactory === undefined
          ? undefined
          : (
              { routes, signal, startupResources },
              wallet,
              chain,
              protocols,
              tokenCatalog,
              accountAssets,
              tradeHistory,
              prices,
              supportManifest,
              walletOperations,
              exchange,
            ) => interfaceApplicationFactory({
                routes,
                signal,
                startupResources,
                supportManifest,
                uniswapV2Quote: protocols.uniswapV2Quote,
                walletConnection: wallet.walletConnection,
                walletOperations,
                exchange: exchange.exchange,
                activity: exchange.activity,
                signing: exchange.signing,
                reviewPresentations: exchange.presentations,
                cardStore: database.presentationCardStore(),
                snapshots: database.presentationSnapshotStore(),
                clock,
                uniswapV4Pools: protocols.uniswapV4Pools,
                chainReads: chain.chainReads,
                tokenInspection: chain.tokenInspection,
                accountAssets: accountAssets.accountAssets,
                tradeHistory: tradeHistory.tradeHistory,
                prices: prices.prices,
                tokenCatalogQueries: tokenCatalog.tokenCatalogQueries,
                tokenCatalogManagement: tokenCatalog.tokenCatalogManagement,
              });
      const stages: OwnerApplicationStages<ActiveWallet, WalletOperations> | undefined = walletStage === undefined ? undefined : {
        wallet: walletStage,
        ...(chainStage === undefined ? {} : { chain: chainStage }),
        ...(registryStage === undefined ? {} : { registry: registryStage }),
        ...(protocolStage === undefined ? {} : { protocols: protocolStage }),
        ...(tokenCatalogStage === undefined ? {} : { tokenCatalog: tokenCatalogStage }),
        ...(accountAssetStage === undefined ? {} : { accountAssets: accountAssetStage }),
        ...(stockTokenTradeHistoryStage === undefined ? {} : { tradeHistory: stockTokenTradeHistoryStage }),
        ...(priceStage === undefined ? {} : { prices: priceStage }),
        ...(reviewStage === undefined ? {} : { review: reviewStage }),
        ...(interfaceStage === undefined ? {} : { interfaces: interfaceStage }),
      };
      const applicationFactory = stages === undefined
        ? undefined
        : (context: RuntimeApplicationContext) => composeOwnerApplicationStages(
          context,
          initialSupportManifest,
          stages,
        );
      return new FixedHttpOwner({
        ownerStore,
        credential,
        configurationMac,
        now,
        onPortOwnershipAcquired: () => {
          database.configuredChainStore().insertConfiguredChainIfAbsent(configuration.chain.chainId);
        },
        ...(applicationFactory === undefined ? {} : { applicationFactory }),
      });
    };
    const database = await ProductDatabase.open(paths.database, parseUtcTimestamp(now()));
    return new LocalRuntime(database, createHttpOwner);
  }

  start(): Promise<void> {
    if (this.#startPromise !== undefined) return this.#startPromise;
    if (this.#stopRequested || this.#databaseClosed) {
      return Promise.reject(new RuntimeOperationError("state_conflict"));
    }
    let resolveTracked!: () => void;
    let rejectTracked!: (error: unknown) => void;
    const tracked = new Promise<void>((resolve, reject) => {
      resolveTracked = resolve;
      rejectTracked = reject;
    });
    this.#startPromise = tracked;
    void (async () => {
      try {
        const owner = this.#httpOwner ?? this.#createHttpOwner(this.#database);
        this.#httpOwner = owner;
        await owner.start();
        if (this.#startPromise === tracked) this.#startPromise = undefined;
        resolveTracked();
      } catch (error) {
        if (this.#startPromise === tracked) this.#startPromise = undefined;
        rejectTracked(normalizeRuntimeError(error));
      }
    })();
    return tracked;
  }

  dispatchRuntimeRequest(request: RuntimeDispatchRequest): Promise<RuntimeDispatchResponse> {
    const owner = this.#httpOwner;
    return owner === undefined
      ? Promise.reject(new RuntimeOperationError("state_conflict"))
      : owner.dispatchRuntimeRequest(request);
  }

  openOwnerSession(signal?: AbortSignal): Promise<RuntimeOwnerSession> {
    const owner = this.#httpOwner;
    return owner === undefined
      ? Promise.reject(new RuntimeOperationError("state_conflict"))
      : owner.openOwnerSession(signal);
  }

  stop(): Promise<RuntimeShutdownOutcome> {
    if (this.#stopPromise !== undefined) return this.#stopPromise;
    let resolveTracked!: (outcome: RuntimeShutdownOutcome) => void;
    let rejectTracked!: (error: unknown) => void;
    const tracked = new Promise<RuntimeShutdownOutcome>((resolve, reject) => {
      resolveTracked = resolve;
      rejectTracked = reject;
    });
    this.#stopPromise = tracked;
    this.#stopRequested = true;
    void this.#stopInternal().then(
      (outcome) => {
        if (this.#stopPromise === tracked) this.#stopPromise = undefined;
        resolveTracked(outcome);
      },
      (error: unknown) => {
        if (this.#stopPromise === tracked) this.#stopPromise = undefined;
        rejectTracked(error);
      },
    );
    return tracked;
  }

  async #stopInternal(): Promise<RuntimeShutdownOutcome> {
    try {
      const owner = this.#httpOwner;
      const shutdown = owner === undefined
        ? undefined
        : await owner.closeApplication();
      if (shutdown?.outcome.kind === "process_terminal") {
        return shutdown.outcome;
      }
      if (!this.#databaseClosed) {
        this.#database.close();
        this.#databaseClosed = true;
      }
      if (owner !== undefined && shutdown !== undefined && "permit" in shutdown) {
        await owner.releaseListener(shutdown.permit);
      }
      return runtimeReleased;
    } catch (error) {
      if (isProcessTerminalRequiredError(error)) throw error;
      throw normalizeRuntimeError(error);
    }
  }
}
