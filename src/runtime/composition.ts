import {
  accountAssetCapabilityIds,
  createAccountAssetApplicationFactory,
  type AccountAssetApplication,
  type AccountAssetApplicationPort,
} from "../account-assets/index.js";
import {
  createReferenceMarketApplicationFactory,
  createGitHubStockTokenExecutionIndex,
  type ReferenceMarketApplicationPort,
  type ReferenceMarketOwnerApplication,
  type StockTokenExecutionIndexReadPort,
} from "../market-portfolio/index.js";
import {
  CapabilityBindingRegistry,
  CapabilityRegistry,
  ObservationAuthorityRegistry,
  accountBalanceCapability,
  chainReadCapabilities,
  chainStatusCapability,
  contractInspectCapability,
  createCanonicalClock,
  createCapabilityInvocationAuthority,
  getCapabilityDefinitionSnapshot,
  parseUtcTimestamp,
  transactionInspectCapability,
  walletConnectionCapability,
  type AnyReadCapabilityDefinition,
  type CanonicalClock,
  type CapabilityBinding,
  type InvocationBoundaryPorts,
  type ObservationAuthorityRegistration,
  type UtcTimestamp,
} from "../core/index.js";
import { referenceMarketCapabilityIds } from "../market-portfolio/contracts.js";
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
  createOfficialAssetSynchronization,
  type RobinhoodOfficialAssetSourceClient,
  type OfficialAssetSynchronizationPort,
} from "../registry/index.js";
import type {
  AccountAssetChainReadPort,
  ChainInvocationPort,
  OfficialAssetChainReadPort,
  PinnedEvmReadPort,
  ReferenceMarketChainReadPort,
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
import {
  assertChainRuntimeSupportManifestExtension,
  assertAccountAssetRuntimeSupportManifestExtension,
  assertInterfaceRuntimeSupportManifestExtension,
  assertProtocolRuntimeSupportManifestExtension,
  assertReferenceMarketRuntimeSupportManifestExtension,
  assertTokenCatalogRuntimeSupportManifestExtension,
  assertWalletRuntimeSupportManifestExtension,
  createInitialRuntimeSupportManifest,
  extendProtocolRuntimeSupportManifest,
  readRuntimeSupportManifest,
  type ChainRuntimeSupportManifest,
  type AccountAssetRuntimeSupportManifest,
  type InitialRuntimeSupportManifest,
  type ProtocolRuntimeSupportManifest,
  type ReferenceMarketRuntimeSupportManifest,
  type TokenCatalogRuntimeSupportManifest,
  type WalletRuntimeSupportManifest,
} from "./support-manifest.js";
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

const walletConnectionCapabilityId = getCapabilityDefinitionSnapshot(walletConnectionCapability).capabilityId;
const chainReadCapabilityIds = Object.freeze(chainReadCapabilities.map((definition) =>
  getCapabilityDefinitionSnapshot(definition).capabilityId));
type ActiveWalletAuthorityPort = TokenCatalogCoordinatorDependencies["activeWallet"];

export interface WalletOwnerHandoff<ActiveWallet extends object> {
  readonly supportManifest: WalletRuntimeSupportManifest;
  readonly walletConnection: WalletConnectionReadCapabilityPort;
  readonly activeWallet: ActiveWallet;
}

export interface ChainOwnerHandoff {
  readonly supportManifest: ChainRuntimeSupportManifest;
  readonly invocations: ChainInvocationPort;
  readonly chainReads: ChainReadCapabilityPort;
  readonly tokenInspection: TokenCatalogInspectionPort;
  readonly tokenAdditionReads: TokenAdditionChainReadPort;
  readonly officialAssetReads: OfficialAssetChainReadPort;
  readonly accountAssetReads: AccountAssetChainReadPort;
  readonly referenceMarketReads: ReferenceMarketChainReadPort;
  readonly protocolReads: PinnedEvmReadPort;
}

export interface ProtocolOwnerHandoff {
  readonly supportExtension: ProtocolSupportExtension;
  readonly uniswapV2Quote: ProtocolOwnerApplication["uniswapV2Quote"];
}

export interface TokenCatalogOwnerHandoff extends TokenCatalogConsumerPorts {
  readonly supportManifest: TokenCatalogRuntimeSupportManifest;
  readonly officialAssets: OfficialAssetSynchronizationPort;
}

export interface AccountAssetOwnerHandoff {
  readonly supportManifest: AccountAssetRuntimeSupportManifest;
  readonly accountAssets: AccountAssetApplicationPort;
}

export interface ReferenceMarketOwnerHandoff {
  readonly supportManifest: ReferenceMarketRuntimeSupportManifest;
  readonly referenceMarkets: ReferenceMarketApplicationPort;
}

interface LocalRuntimeBaseOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => UtcTimestamp;
  readonly robinhoodOfficialAssetSourceClient?: RobinhoodOfficialAssetSourceClient;
  readonly stockTokenExecutionIndex?: StockTokenExecutionIndexReadPort;
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

const requireActiveWalletAuthority = (value: object): ActiveWalletAuthorityPort => {
  if (!("capture" in value) || typeof value.capture !== "function") {
    throw new TypeError("Active wallet read authority is unavailable.");
  }
  return value as ActiveWalletAuthorityPort;
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
): Promise<Result> => {
  const stage = createResourceOwnershipScope();
  parent.resources.register(stage);
  try {
    const application = await factory(stage.resources);
    stage.resources.register(application);
    const result = validate(application);
    stage.seal();
    if (stage.size !== 1) throw new TypeError("Application stage retained startup resources.");
    return result;
  } catch (error) {
    stage.seal();
    throw error;
  }
};

export type WalletOwnerApplicationStage<
  ActiveWallet extends object,
  WalletOperations extends WalletManagementPort,
> = (
  context: RuntimeApplicationContext,
) => Promise<WalletOwnerApplication<ActiveWallet, WalletOperations>> |
  WalletOwnerApplication<ActiveWallet, WalletOperations>;
export type ChainOwnerApplicationStage<ActiveWallet extends object> = (
  context: RuntimeApplicationContext,
  wallet: WalletOwnerHandoff<ActiveWallet>,
) => Promise<ChainOwnerApplication> | ChainOwnerApplication;
export type ProtocolOwnerApplicationStage<ActiveWallet extends object> = (
  context: RuntimeApplicationContext,
  wallet: WalletOwnerHandoff<ActiveWallet>,
  chain: ChainOwnerHandoff,
) => Promise<ProtocolOwnerApplication> | ProtocolOwnerApplication;
export type TokenCatalogOwnerApplicationStage<ActiveWallet extends object> = (
  context: RuntimeApplicationContext,
  wallet: WalletOwnerHandoff<ActiveWallet>,
  chain: ChainOwnerHandoff,
) => Promise<TokenCatalogApplication> | TokenCatalogApplication;
export type AccountAssetOwnerApplicationStage<ActiveWallet extends object> = (
  context: RuntimeApplicationContext,
  wallet: WalletOwnerHandoff<ActiveWallet>,
  chain: ChainOwnerHandoff,
  tokenCatalog: TokenCatalogOwnerHandoff,
) => Promise<AccountAssetApplication> | AccountAssetApplication;
export type ReferenceMarketOwnerApplicationStage<ActiveWallet extends object> = (
  context: RuntimeApplicationContext,
  wallet: WalletOwnerHandoff<ActiveWallet>,
  chain: ChainOwnerHandoff,
  supportManifest: AccountAssetRuntimeSupportManifest,
  officialAssets: OfficialAssetSynchronizationPort,
) => Promise<ReferenceMarketOwnerApplication> | ReferenceMarketOwnerApplication;
export type InterfaceOwnerApplicationStage<
  ActiveWallet extends object,
  WalletOperations extends WalletManagementPort,
> = (
  context: RuntimeApplicationContext,
  wallet: WalletOwnerHandoff<ActiveWallet>,
  chain: ChainOwnerHandoff,
  protocols: ProtocolOwnerHandoff,
  tokenCatalog: TokenCatalogOwnerHandoff,
  accountAssets: AccountAssetOwnerHandoff,
  referenceMarkets: ReferenceMarketOwnerHandoff,
  supportManifest: ProtocolRuntimeSupportManifest,
  walletOperations: WalletOperations,
) => Promise<InterfaceOwnerApplication> | InterfaceOwnerApplication;

export type OwnerApplicationStages<
  ActiveWallet extends object,
  WalletOperations extends WalletManagementPort,
> =
  | readonly [WalletOwnerApplicationStage<ActiveWallet, WalletOperations>]
  | readonly [
      WalletOwnerApplicationStage<ActiveWallet, WalletOperations>,
      ChainOwnerApplicationStage<ActiveWallet>,
      ProtocolOwnerApplicationStage<ActiveWallet>,
      TokenCatalogOwnerApplicationStage<ActiveWallet>,
      AccountAssetOwnerApplicationStage<ActiveWallet>,
      ReferenceMarketOwnerApplicationStage<ActiveWallet>,
    ]
  | readonly [
      WalletOwnerApplicationStage<ActiveWallet, WalletOperations>,
      ChainOwnerApplicationStage<ActiveWallet>,
      ProtocolOwnerApplicationStage<ActiveWallet>,
      TokenCatalogOwnerApplicationStage<ActiveWallet>,
      AccountAssetOwnerApplicationStage<ActiveWallet>,
      ReferenceMarketOwnerApplicationStage<ActiveWallet>,
      InterfaceOwnerApplicationStage<ActiveWallet, WalletOperations>,
    ];

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
  assertBindingProvenance(chainStatusCapability, input.chainStatus);
  assertBindingProvenance(contractInspectCapability, input.contractInspect);
  assertBindingProvenance(transactionInspectCapability, input.transactionInspect);
  return Object.freeze({
    accountBalance: input.accountBalance,
    chainStatus: input.chainStatus,
    contractInspect: input.contractInspect,
    transactionInspect: input.transactionInspect,
  });
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
  manifest: WalletRuntimeSupportManifest | ChainRuntimeSupportManifest |
    ProtocolRuntimeSupportManifest | TokenCatalogRuntimeSupportManifest |
    AccountAssetRuntimeSupportManifest |
    ReferenceMarketRuntimeSupportManifest,
  capabilityIds: readonly string[],
): void => {
  const snapshot = readRuntimeSupportManifest(manifest);
  for (const capabilityId of capabilityIds) {
    if (snapshot.capabilities.find((entry) => entry.capabilityId === capabilityId)?.availability.direct !== "internal") {
      throw new TypeError("Application capability output is absent from its support manifest.");
    }
  }
};

export const composeOwnerApplicationStages = async <
  ActiveWallet extends object,
  WalletOperations extends WalletManagementPort,
>(
  context: RuntimeApplicationContext,
  initialSupportManifest: InitialRuntimeSupportManifest,
  stages: OwnerApplicationStages<ActiveWallet, WalletOperations>,
): Promise<HttpOwnerRootApplication> => {
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
    const walletResult = await runApplicationStage(walletApplications, (startupResources) => stages[0]({
      routes: walletRoutes,
      signal: context.signal,
      startupResources,
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
      assertCapabilityDirectSupport(wallet.supportManifest, [walletConnectionCapabilityId]);
      if (context.signal.aborted) throw new RuntimeOperationError("request_aborted");
      return Object.freeze({
        application: wallet,
        handoff: Object.freeze({
          supportManifest: wallet.supportManifest,
          walletConnection,
          activeWallet,
        }) satisfies WalletOwnerHandoff<ActiveWallet>,
        walletOperations,
      });
    });
    const wallet = walletResult.application;
    walletApplication = wallet;
    const walletHandoff = walletResult.handoff;
    const walletOperations = walletResult.walletOperations;
    currentRoutes = wallet.routes;

    const chainStage = stages[1];
    let chain: ChainOwnerApplication | undefined;
    let chainReads: ChainReadCapabilityPort | undefined;
    let chainHandoff: ChainOwnerHandoff | undefined;
    if (chainStage !== undefined) {
      const chainRoutes = currentRoutes;
      const chainResult = await runApplicationStage(dependentApplications, (startupResources) => chainStage({
        routes: chainRoutes,
        signal: context.signal,
        startupResources,
      }, walletHandoff), (chainApplication) => {
        assertRuntimeRouteRegistryDescendant(chainRoutes, chainApplication.routes);
        assertChainRuntimeSupportManifestExtension(wallet.supportManifest, chainApplication.supportManifest);
        const reads = snapshotChainReads(chainApplication.chainReads);
        const invocations = chainApplication.invocations;
        const tokenInspection = snapshotTokenInspection(chainApplication.tokenInspection);
        const tokenAdditionReads = chainApplication.tokenAdditionReads;
        const officialAssetReads = chainApplication.officialAssetReads;
        const accountAssetReads = chainApplication.accountAssetReads;
        const referenceMarketReads = chainApplication.referenceMarketReads;
        const protocolReads = chainApplication.protocolReads;
        if (
          typeof tokenAdditionReads !== "object" || tokenAdditionReads === null ||
          typeof tokenAdditionReads.inspectAndVerifyOfficial !== "function"
        ) throw new TypeError("Token addition chain read authority is unavailable.");
        if (
          typeof invocations !== "object" || invocations === null ||
          typeof invocations.run !== "function"
        ) throw new TypeError("Chain invocation authority is unavailable.");
        if (
          typeof officialAssetReads !== "object" || officialAssetReads === null ||
          typeof officialAssetReads.verifyAtBlock !== "function" ||
          typeof officialAssetReads.verifyManyAtBlock !== "function"
        ) throw new TypeError("Official asset chain read authority is unavailable.");
        if (
          typeof accountAssetReads !== "object" || accountAssetReads === null ||
          typeof accountAssetReads.resolveCurrentBlock !== "function" ||
          typeof accountAssetReads.readCollectionAtBlock !== "function" ||
          typeof accountAssetReads.readExactAtBlock !== "function"
        ) throw new TypeError("Account asset chain read authority is unavailable.");
        if (
          typeof referenceMarketReads !== "object" || referenceMarketReads === null ||
          typeof referenceMarketReads.resolveCurrentBlock !== "function" ||
          typeof referenceMarketReads.readLatestAtBlock !== "function" ||
          typeof referenceMarketReads.readHistoryAtBlock !== "function" ||
          typeof referenceMarketReads.readStockTokenAtBlock !== "function"
        ) throw new TypeError("Reference market chain read authority is unavailable.");
        if (
          typeof protocolReads !== "object" || protocolReads === null ||
          typeof protocolReads.resolveBlock !== "function" ||
          typeof protocolReads.readRuntimeCode !== "function" ||
          typeof protocolReads.call !== "function" ||
          typeof protocolReads.readTokenDecimals !== "function" ||
          typeof protocolReads.inspectContract !== "function" ||
          typeof protocolReads.recordConfiguredChain !== "function"
        ) throw new TypeError("Pinned EVM read authority is unavailable.");
        assertCapabilityDirectSupport(chainApplication.supportManifest, chainReadCapabilityIds);
        if (context.signal.aborted) throw new RuntimeOperationError("request_aborted");
        return Object.freeze({
          application: chainApplication,
          reads,
          handoff: Object.freeze({
            supportManifest: chainApplication.supportManifest,
            invocations,
            chainReads: reads,
            tokenInspection,
            tokenAdditionReads,
            officialAssetReads,
            accountAssetReads,
            referenceMarketReads,
            protocolReads,
          }) satisfies ChainOwnerHandoff,
        });
      });
      chain = chainResult.application;
      chainReads = chainResult.reads;
      chainHandoff = chainResult.handoff;
      currentRoutes = chain.routes;
    }

    const protocolStage = stages[2];
    let protocolApplication: ProtocolOwnerApplication | undefined;
    let protocolHandoff: ProtocolOwnerHandoff | undefined;
    if (protocolStage !== undefined) {
      if (chain === undefined || chainHandoff === undefined) {
        throw new TypeError("Protocol dependencies are unavailable.");
      }
      const protocolRoutes = currentRoutes;
      const protocolResult = await runApplicationStage(
        dependentApplications,
        (startupResources) => protocolStage(
          { routes: protocolRoutes, signal: context.signal, startupResources },
          walletHandoff,
          chainHandoff,
        ),
        (application) => {
          assertRuntimeRouteRegistryDescendant(protocolRoutes, application.routes);
          readProtocolSupportExtension(application.supportExtension);
          assertBindingProvenance(
            uniswapV2QuoteCapability,
            application.uniswapV2Quote,
          );
          if (context.signal.aborted) throw new RuntimeOperationError("request_aborted");
          return Object.freeze({
            application,
            handoff: Object.freeze({
              supportExtension: application.supportExtension,
              uniswapV2Quote: application.uniswapV2Quote,
            }) satisfies ProtocolOwnerHandoff,
          });
        },
      );
      protocolApplication = protocolResult.application;
      protocolHandoff = protocolResult.handoff;
      currentRoutes = protocolApplication.routes;
    }

    const tokenCatalogStage = stages[3];
    let tokenCatalogApplication: TokenCatalogApplication | undefined;
    let tokenCatalogHandoff: TokenCatalogOwnerHandoff | undefined;
    if (tokenCatalogStage !== undefined) {
      if (chain === undefined || chainHandoff === undefined) {
        throw new TypeError("Token catalog dependencies are unavailable.");
      }
      const tokenCatalogRoutes = currentRoutes;
      const tokenCatalogResult = await runApplicationStage(
        dependentApplications,
        (startupResources) => tokenCatalogStage(
          { routes: tokenCatalogRoutes, signal: context.signal, startupResources },
          walletHandoff,
          chainHandoff,
        ),
        (application) => {
          assertRuntimeRouteRegistryDescendant(tokenCatalogRoutes, application.routes);
          assertTokenCatalogRuntimeSupportManifestExtension(
            chain.supportManifest,
            application.supportManifest,
          );
          assertCapabilityDirectSupport(application.supportManifest, tokenCatalogCapabilityIds);
          const consumerPorts = snapshotTokenCatalogConsumerPorts(application);
          if (context.signal.aborted) throw new RuntimeOperationError("request_aborted");
          return Object.freeze({
            application,
            handoff: Object.freeze({
              supportManifest: application.supportManifest,
              officialAssets: application.officialAssets,
              ...consumerPorts,
            }) satisfies TokenCatalogOwnerHandoff,
          });
        },
      );
      tokenCatalogApplication = tokenCatalogResult.application;
      tokenCatalogHandoff = tokenCatalogResult.handoff;
      currentRoutes = tokenCatalogApplication.routes;
    }

    const accountAssetStage = stages[4];
    let accountAssetApplication: AccountAssetApplication | undefined;
    let accountAssetHandoff: AccountAssetOwnerHandoff | undefined;
    if (accountAssetStage !== undefined) {
      if (
        chain === undefined || chainHandoff === undefined ||
        tokenCatalogApplication === undefined || tokenCatalogHandoff === undefined
      ) throw new TypeError("Account asset dependencies are unavailable.");
      const accountAssetRoutes = currentRoutes;
      const accountAssetResult = await runApplicationStage(
        dependentApplications,
        (startupResources) => accountAssetStage(
          { routes: accountAssetRoutes, signal: context.signal, startupResources },
          walletHandoff,
          chainHandoff,
          tokenCatalogHandoff,
        ),
        (application) => {
          assertRuntimeRouteRegistryDescendant(accountAssetRoutes, application.routes);
          assertAccountAssetRuntimeSupportManifestExtension(
            tokenCatalogApplication.supportManifest,
            application.supportManifest,
          );
          assertCapabilityDirectSupport(application.supportManifest, accountAssetCapabilityIds);
          if (context.signal.aborted) throw new RuntimeOperationError("request_aborted");
          const accountAssets = Object.freeze({
            list: (...args: Parameters<AccountAssetApplicationPort["list"]>) => application.list(...args),
            getOverview: (...args: Parameters<AccountAssetApplicationPort["getOverview"]>) =>
              application.getOverview(...args),
            get: (...args: Parameters<AccountAssetApplicationPort["get"]>) => application.get(...args),
          }) satisfies AccountAssetApplicationPort;
          return Object.freeze({
            application,
            handoff: Object.freeze({
              supportManifest: application.supportManifest,
              accountAssets,
            }) satisfies AccountAssetOwnerHandoff,
          });
        },
      );
      accountAssetApplication = accountAssetResult.application;
      accountAssetHandoff = accountAssetResult.handoff;
      currentRoutes = accountAssetApplication.routes;
    }

    const referenceMarketStage = stages[5];
    let referenceMarketApplication: ReferenceMarketOwnerApplication | undefined;
    let referenceMarketHandoff: ReferenceMarketOwnerHandoff | undefined;
    if (referenceMarketStage !== undefined) {
      if (
        chain === undefined || chainHandoff === undefined ||
        tokenCatalogHandoff === undefined ||
        accountAssetApplication === undefined || accountAssetHandoff === undefined
      ) throw new TypeError("Reference market dependencies are unavailable.");
      const referenceMarketRoutes = currentRoutes;
      const referenceMarketResult = await runApplicationStage(
        dependentApplications,
        (startupResources) => referenceMarketStage(
          { routes: referenceMarketRoutes, signal: context.signal, startupResources },
          walletHandoff,
          chainHandoff,
          accountAssetApplication.supportManifest,
          tokenCatalogHandoff.officialAssets,
        ),
        (application) => {
          assertRuntimeRouteRegistryDescendant(referenceMarketRoutes, application.routes);
          assertReferenceMarketRuntimeSupportManifestExtension(
            accountAssetApplication.supportManifest,
            application.supportManifest,
          );
          assertCapabilityDirectSupport(application.supportManifest, referenceMarketCapabilityIds);
          if (context.signal.aborted) throw new RuntimeOperationError("request_aborted");
          const referenceMarkets = Object.freeze({
            price: (...args: Parameters<ReferenceMarketApplicationPort["price"]>) => application.price(...args),
            history: (...args: Parameters<ReferenceMarketApplicationPort["history"]>) => application.history(...args),
            stockTokenMarket: (
              ...args: Parameters<ReferenceMarketApplicationPort["stockTokenMarket"]>
            ) => application.stockTokenMarket(...args),
            watchlist: (...args: Parameters<ReferenceMarketApplicationPort["watchlist"]>) => application.watchlist(...args),
            reviewWatchlistChange: (
              ...args: Parameters<ReferenceMarketApplicationPort["reviewWatchlistChange"]>
            ) => application.reviewWatchlistChange(...args),
            decideWatchlistChange: (
              ...args: Parameters<ReferenceMarketApplicationPort["decideWatchlistChange"]>
            ) => application.decideWatchlistChange(...args),
            getWatchlistOperation: (
              ...args: Parameters<ReferenceMarketApplicationPort["getWatchlistOperation"]>
            ) => application.getWatchlistOperation(...args),
          }) satisfies ReferenceMarketApplicationPort;
          return Object.freeze({
            application,
            handoff: Object.freeze({
              supportManifest: application.supportManifest,
              referenceMarkets,
            }) satisfies ReferenceMarketOwnerHandoff,
          });
        },
      );
      referenceMarketApplication = referenceMarketResult.application;
      referenceMarketHandoff = referenceMarketResult.handoff;
      currentRoutes = referenceMarketApplication.routes;
    }

    const interfaceStage = stages[6];
    if (interfaceStage !== undefined) {
      if (
        chain === undefined || chainReads === undefined || chainHandoff === undefined ||
        protocolApplication === undefined || protocolHandoff === undefined ||
        tokenCatalogApplication === undefined || tokenCatalogHandoff === undefined ||
        accountAssetApplication === undefined || accountAssetHandoff === undefined
        || referenceMarketApplication === undefined || referenceMarketHandoff === undefined
      ) {
        throw new TypeError("Interface application dependencies are unavailable.");
      }
      const interfaceRoutes = currentRoutes;
      const protocolSupportManifest = extendProtocolRuntimeSupportManifest(
        referenceMarketHandoff.supportManifest,
        readProtocolSupportExtension(protocolHandoff.supportExtension),
      );
      const interfaceApplication = await runApplicationStage(
        dependentApplications,
        (startupResources) => interfaceStage(
          { routes: interfaceRoutes, signal: context.signal, startupResources },
          walletHandoff,
          chainHandoff,
          protocolHandoff,
          tokenCatalogHandoff,
          accountAssetHandoff,
          referenceMarketHandoff,
          protocolSupportManifest,
          walletOperations,
        ),
        (application) => {
          assertRuntimeRouteRegistryDescendant(interfaceRoutes, application.routes);
          assertInterfaceRuntimeSupportManifestExtension(
            protocolSupportManifest,
            application.supportManifest,
          );
          if (context.signal.aborted) throw new RuntimeOperationError("request_aborted");
          return application;
        },
      );
      currentRoutes = interfaceApplication.routes;
    }
    applications.seal();
    let shutdownWork: Promise<RuntimeShutdownOutcome> | undefined;
    const shutdown = (): Promise<RuntimeShutdownOutcome> => {
      if (shutdownWork !== undefined) return shutdownWork;
      shutdownWork = Promise.resolve().then(async () => {
        let dependentFailure: unknown;
        try { await dependentApplications.close(); }
        catch (error) { dependentFailure = error; }
        let outcome: RuntimeShutdownOutcome;
        try { outcome = await wallet.shutdown(); }
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
      shutdown,
      close: async (): Promise<void> => {
        const outcome = await shutdown();
        if (outcome.kind === "process_terminal") throw requireProcessTermination();
      },
    });
    cleanupRegistration.transfer();
    return application;
  } catch (startupError) {
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
    } catch (cleanupError) {
      if (isProcessTerminalRequiredError(cleanupError)) {
        throw cleanupError.primaryFailure === undefined
          ? requireProcessTermination(startupError)
          : cleanupError;
      }
      throw new AggregateError(
        [startupError, cleanupError],
        "Application startup and cleanup failed.",
      );
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
    const stockTokenExecutionIndex = options.stockTokenExecutionIndex ??
      createGitHubStockTokenExecutionIndex();
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
      const chainPorts = Object.freeze({
        observations: new ObservationAuthorityRegistry(clock, [
          rpcSource.observationAuthority,
          contractSourceVerification.observationAuthorityRegistration,
        ]),
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
          supportManifest: wallet.supportManifest,
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
          : ({ routes }, _wallet, chain) => createProtocolOwnerApplication({
            routes,
            invocations: chain.invocations,
            reads: chain.protocolReads,
            invocationAuthority,
            invocationPorts: chainPorts,
          });
      const tokenCatalogStage: TokenCatalogOwnerApplicationStage<ActiveWallet> | undefined =
        chainStage === undefined
          ? undefined
          : async ({ routes, signal, startupResources }, wallet, chain) => {
            const activeWallet = requireActiveWalletAuthority(wallet.activeWallet);
            const store = database.tokenCatalogStore();
            const readStore = database.tokenCatalogReadStore();
            const accountTokenSelectionStore = database.accountTokenSelectionStore();
            const source = robinhoodOfficialAssetSourceClient ??
              createRobinhoodOfficialAssetSourceClient();
            const officialAssets = createOfficialAssetSynchronization({
              source,
              store: database.officialAssetSnapshotStore(),
              signal,
            });
            const application = await createTokenCatalogApplicationFactory({
              routes,
              supportManifest: chain.supportManifest,
              activeWallet,
              additionChainReads: chain.tokenAdditionReads,
              officialAssets,
              startupResources,
              store,
              readStore,
              accountTokenSelectionStore,
              clock,
              signal,
            });
            return application;
          };
      const accountAssetStage: AccountAssetOwnerApplicationStage<ActiveWallet> | undefined =
        tokenCatalogStage === undefined
          ? undefined
          : ({ routes, signal, startupResources }, wallet, chain, tokenCatalog) =>
            createAccountAssetApplicationFactory({
              routes,
              supportManifest: tokenCatalog.supportManifest,
              activeWallet: requireActiveWalletAuthority(wallet.activeWallet),
              selections: tokenCatalog.accountTokenSelectionStore,
              officialAssets: tokenCatalog.officialAssets,
              chainInvocations: chain.invocations,
              officialAssetReads: chain.officialAssetReads,
              chainReads: chain.accountAssetReads,
              clock,
              signal,
              startupResources,
            });
      const referenceMarketStage: ReferenceMarketOwnerApplicationStage<ActiveWallet> | undefined =
        accountAssetStage === undefined
          ? undefined
          : ({ routes, startupResources }, wallet, chain, supportManifest, officialAssets) =>
            createReferenceMarketApplicationFactory({
              routes,
              supportManifest,
              activeWallet: requireActiveWalletAuthority(wallet.activeWallet),
              chainInvocations: chain.invocations,
              chain: chain.referenceMarketReads,
              store: database.referenceMarketStore(),
              officialAssets,
              stockTokenExecutionIndex,
              clock,
              startupResources,
            });
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
              referenceMarkets,
              supportManifest,
              walletOperations,
            ) => interfaceApplicationFactory({
                routes,
                signal,
                startupResources,
                supportManifest,
                uniswapV2Quote: protocols.uniswapV2Quote,
                walletConnection: wallet.walletConnection,
                walletOperations,
                chainReads: chain.chainReads,
                tokenInspection: chain.tokenInspection,
                accountAssets: accountAssets.accountAssets,
                referenceMarkets: referenceMarkets.referenceMarkets,
                tokenCatalogQueries: tokenCatalog.tokenCatalogQueries,
                tokenCatalogManagement: tokenCatalog.tokenCatalogManagement,
              });
      const stages: OwnerApplicationStages<ActiveWallet, WalletOperations> | undefined = walletStage === undefined
        ? undefined
        : chainStage === undefined
          ? [walletStage]
          : interfaceStage === undefined
            ? [
                walletStage,
                chainStage,
                protocolStage as ProtocolOwnerApplicationStage<ActiveWallet>,
                tokenCatalogStage as TokenCatalogOwnerApplicationStage<ActiveWallet>,
                accountAssetStage as AccountAssetOwnerApplicationStage<ActiveWallet>,
                referenceMarketStage as ReferenceMarketOwnerApplicationStage<ActiveWallet>,
              ]
            : [
                walletStage,
                chainStage,
                protocolStage as ProtocolOwnerApplicationStage<ActiveWallet>,
                tokenCatalogStage as TokenCatalogOwnerApplicationStage<ActiveWallet>,
                accountAssetStage as AccountAssetOwnerApplicationStage<ActiveWallet>,
                referenceMarketStage as ReferenceMarketOwnerApplicationStage<ActiveWallet>,
                interfaceStage,
              ];
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
