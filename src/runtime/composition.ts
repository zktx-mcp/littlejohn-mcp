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
  type CapabilityBinding,
  type CanonicalClock,
  type CapabilityInvocationAuthority,
  type InvocationBoundaryPorts,
  type UtcTimestamp,
} from "../core/index.js";
import {
  readConfiguredRpcEndpoint,
  readRuntimeConfiguration,
  type WalletConnectConfiguration,
} from "./configuration.js";
import { loadOrCreateControlCredential } from "./control-credential.js";
import {
  ProductDatabase,
  type WalletProjectionStore,
} from "./database.js";
import {
  FixedHttpOwner,
  type HttpOwnerApplication,
  type HttpOwnerApplicationContext,
  type HttpOwnerReleasePermit,
  type HttpOwnerStartupResourceRegistry,
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
  ensureOwnerOnlyDirectory,
  resolveApplicationDataDirectory,
  runtimePaths,
} from "./paths.js";
import {
  createRpcSourceAuthority,
  createWalletSourceAuthority,
  type RpcSourceAuthorityPort,
  type WalletSessionSource,
  type WalletSourceAuthorityPort,
} from "./source-identity.js";
import {
  assertChainRuntimeSupportManifestExtension,
  assertInterfaceRuntimeSupportManifestExtension,
  assertWalletRuntimeSupportManifestExtension,
  initialRuntimeSupportManifest,
  readRuntimeSupportManifest,
  type ChainRuntimeSupportManifest,
  type InitialRuntimeSupportManifest,
  type InterfaceRuntimeSupportManifest,
  type WalletRuntimeSupportManifest,
} from "./support-manifest.js";

const walletConnectionCapabilityId = getCapabilityDefinitionSnapshot(walletConnectionCapability).capabilityId;
const chainReadCapabilityIds = Object.freeze(chainReadCapabilities.map((definition) =>
  getCapabilityDefinitionSnapshot(definition).capabilityId));

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

export interface WalletOwnerBootstrapPort {
  readonly configuration: WalletConnectConfiguration;
  readonly privateStoreDirectory: WalletPrivateStoreDirectoryPort;
  readonly projection: WalletProjectionStore;
  readonly sourceAuthority: WalletSourceAuthorityPort;
  readonly capabilityAuthority: WalletCapabilityAuthorityPort;
}

export interface WalletPrivateStoreDirectoryPort {
  ensureDirectory(): Promise<string>;
}

export interface ChainOwnerBootstrapPort {
  readonly configuredRpcUri: string;
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

export interface WalletOwnerHandoff<ActiveWallet extends object> {
  readonly supportManifest: WalletRuntimeSupportManifest;
  readonly walletConnection: WalletConnectionReadCapabilityPort;
  readonly activeWallet: ActiveWallet;
}

export interface ChainOwnerHandoff {
  readonly supportManifest: ChainRuntimeSupportManifest;
  readonly chainReads: ChainReadCapabilityPort;
}

export interface WalletOwnerApplicationContext {
  readonly routes: RuntimeRouteRegistry;
  readonly signal: AbortSignal;
  readonly startupResources: HttpOwnerStartupResourceRegistry;
  readonly supportManifest: InitialRuntimeSupportManifest;
  readonly wallet: WalletOwnerBootstrapPort;
}

export interface ChainOwnerApplicationContext<ActiveWallet extends object> {
  readonly routes: RuntimeRouteRegistry;
  readonly signal: AbortSignal;
  readonly startupResources: HttpOwnerStartupResourceRegistry;
  readonly supportManifest: WalletRuntimeSupportManifest;
  readonly walletConnection: WalletConnectionReadCapabilityPort;
  readonly activeWallet: ActiveWallet;
  readonly chain: ChainOwnerBootstrapPort;
}

export interface InterfaceOwnerApplicationContext<WalletOperations extends object> {
  readonly routes: RuntimeRouteRegistry;
  readonly signal: AbortSignal;
  readonly startupResources: HttpOwnerStartupResourceRegistry;
  readonly supportManifest: ChainRuntimeSupportManifest;
  readonly walletConnection: WalletConnectionReadCapabilityPort;
  readonly walletOperations: WalletOperations;
  readonly chainReads: ChainReadCapabilityPort;
}

export interface WalletOwnerApplication<
  ActiveWallet extends object,
  WalletOperations extends object,
> extends HttpOwnerApplication {
  readonly supportManifest: WalletRuntimeSupportManifest;
  readonly walletConnection: WalletConnectionReadCapabilityPort;
  readonly activeWallet: ActiveWallet;
  readonly walletOperations: WalletOperations;
}

export interface ChainOwnerApplication extends HttpOwnerApplication {
  readonly supportManifest: ChainRuntimeSupportManifest;
  readonly chainReads: ChainReadCapabilityPort;
}

export interface InterfaceOwnerApplication extends HttpOwnerApplication {
  readonly supportManifest: InterfaceRuntimeSupportManifest;
}

export type WalletOwnerApplicationFactory<
  ActiveWallet extends object,
  WalletOperations extends object,
> = (
  context: WalletOwnerApplicationContext,
) => Promise<WalletOwnerApplication<ActiveWallet, WalletOperations>> |
  WalletOwnerApplication<ActiveWallet, WalletOperations>;
export type ChainOwnerApplicationFactory<ActiveWallet extends object> = (
  context: ChainOwnerApplicationContext<ActiveWallet>,
) => Promise<ChainOwnerApplication> | ChainOwnerApplication;
export type InterfaceOwnerApplicationFactory<WalletOperations extends object> = (
  context: InterfaceOwnerApplicationContext<WalletOperations>,
) => Promise<InterfaceOwnerApplication> | InterfaceOwnerApplication;

interface LocalRuntimeBaseOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => UtcTimestamp;
}

type LocalRuntimeApplicationFactories<
  ActiveWallet extends object,
  WalletOperations extends object,
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
      readonly interfaceApplicationFactory: InterfaceOwnerApplicationFactory<NoInfer<WalletOperations>>;
    };

export type LocalRuntimeOptions<
  ActiveWallet extends object,
  WalletOperations extends object,
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
  WalletOperations extends object,
> = (
  context: HttpOwnerApplicationContext,
) => Promise<WalletOwnerApplication<ActiveWallet, WalletOperations>> |
  WalletOwnerApplication<ActiveWallet, WalletOperations>;
export type ChainOwnerApplicationStage<ActiveWallet extends object> = (
  context: HttpOwnerApplicationContext,
  wallet: WalletOwnerHandoff<ActiveWallet>,
) => Promise<ChainOwnerApplication> | ChainOwnerApplication;
export type InterfaceOwnerApplicationStage<
  ActiveWallet extends object,
  WalletOperations extends object,
> = (
  context: HttpOwnerApplicationContext,
  wallet: WalletOwnerHandoff<ActiveWallet>,
  chain: ChainOwnerHandoff,
  walletOperations: WalletOperations,
) => Promise<InterfaceOwnerApplication> | InterfaceOwnerApplication;

export type OwnerApplicationStages<
  ActiveWallet extends object,
  WalletOperations extends object,
> =
  | readonly [WalletOwnerApplicationStage<ActiveWallet, WalletOperations>]
  | readonly [
      WalletOwnerApplicationStage<ActiveWallet, WalletOperations>,
      ChainOwnerApplicationStage<ActiveWallet>,
    ]
  | readonly [
      WalletOwnerApplicationStage<ActiveWallet, WalletOperations>,
      ChainOwnerApplicationStage<ActiveWallet>,
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

const assertCapabilityDirectSupport = (
  manifest: WalletRuntimeSupportManifest | ChainRuntimeSupportManifest,
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
  WalletOperations extends object,
>(
  context: HttpOwnerApplicationContext,
  stages: OwnerApplicationStages<ActiveWallet, WalletOperations>,
): Promise<HttpOwnerApplication> => {
  const applications = createResourceOwnershipScope();
  const cleanupRegistration = context.startupResources.register(applications);
  let currentRoutes = context.routes;
  try {
    const walletRoutes = currentRoutes;
    const walletResult = await runApplicationStage(applications, (startupResources) => stages[0]({
      routes: walletRoutes,
      signal: context.signal,
      startupResources,
    }), (wallet) => {
      assertRuntimeRouteRegistryDescendant(walletRoutes, wallet.routes);
      assertWalletRuntimeSupportManifestExtension(initialRuntimeSupportManifest, wallet.supportManifest);
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
    const walletHandoff = walletResult.handoff;
    const walletOperations = walletResult.walletOperations;
    currentRoutes = wallet.routes;

    const chainStage = stages[1];
    let chain: ChainOwnerApplication | undefined;
    let chainReads: ChainReadCapabilityPort | undefined;
    let chainHandoff: ChainOwnerHandoff | undefined;
    if (chainStage !== undefined) {
      const chainRoutes = currentRoutes;
      const chainResult = await runApplicationStage(applications, (startupResources) => chainStage({
        routes: chainRoutes,
        signal: context.signal,
        startupResources,
      }, walletHandoff), (chainApplication) => {
        assertRuntimeRouteRegistryDescendant(chainRoutes, chainApplication.routes);
        assertChainRuntimeSupportManifestExtension(wallet.supportManifest, chainApplication.supportManifest);
        const reads = snapshotChainReads(chainApplication.chainReads);
        assertCapabilityDirectSupport(chainApplication.supportManifest, chainReadCapabilityIds);
        if (context.signal.aborted) throw new RuntimeOperationError("request_aborted");
        return Object.freeze({
          application: chainApplication,
          reads,
          handoff: Object.freeze({
            supportManifest: chainApplication.supportManifest,
            chainReads: reads,
          }) satisfies ChainOwnerHandoff,
        });
      });
      chain = chainResult.application;
      chainReads = chainResult.reads;
      chainHandoff = chainResult.handoff;
      currentRoutes = chain.routes;
    }

    const interfaceStage = stages[2];
    if (interfaceStage !== undefined) {
      if (chain === undefined || chainReads === undefined || chainHandoff === undefined) {
        throw new TypeError("Interface application dependencies are unavailable.");
      }
      const interfaceRoutes = currentRoutes;
      const interfaceApplication = await runApplicationStage(
        applications,
        (startupResources) => interfaceStage(
          { routes: interfaceRoutes, signal: context.signal, startupResources },
          walletHandoff,
          chainHandoff,
          walletOperations,
        ),
        (application) => {
          assertRuntimeRouteRegistryDescendant(interfaceRoutes, application.routes);
          assertInterfaceRuntimeSupportManifestExtension(chain.supportManifest, application.supportManifest);
          if (context.signal.aborted) throw new RuntimeOperationError("request_aborted");
          return application;
        },
      );
      currentRoutes = interfaceApplication.routes;
    }
    applications.seal();
    const application = Object.freeze({
      routes: currentRoutes,
      close: () => applications.close(),
    });
    cleanupRegistration.transfer();
    return application;
  } catch (error) {
    applications.seal();
    try {
      await applications.close();
      cleanupRegistration.transfer();
    } catch { /* The HTTP owner retains failed cleanup authority. */ }
    throw error;
  }
};

export class LocalRuntime {
  readonly #database: ProductDatabase;
  readonly #createHttpOwner: (database: ProductDatabase) => FixedHttpOwner;
  #httpOwner: FixedHttpOwner | undefined;
  #databaseClosed = false;
  #stopRequested = false;
  #startPromise: Promise<void> | undefined;
  #stopPromise: Promise<void> | undefined;

  private constructor(
    database: ProductDatabase,
    createHttpOwner: (database: ProductDatabase) => FixedHttpOwner,
  ) {
    this.#database = database;
    this.#createHttpOwner = createHttpOwner;
  }

  get ownerState(): FixedHttpOwner["state"] { return this.#httpOwner?.state ?? "stopped"; }

  static async create<
    ActiveWallet extends object = object,
    WalletOperations extends object = object,
  >(
    options: LocalRuntimeOptions<ActiveWallet, WalletOperations> = {},
  ): Promise<LocalRuntime> {
    const environment = options.environment ?? process.env;
    const now = options.now ?? systemNow;
    const configuration = readRuntimeConfiguration(environment);
    const paths = runtimePaths(resolveApplicationDataDirectory(environment));
    const walletApplicationFactory = options.walletApplicationFactory;
    const chainApplicationFactory = options.chainApplicationFactory;
    const interfaceApplicationFactory = options.interfaceApplicationFactory;
    if ((walletApplicationFactory === undefined && (chainApplicationFactory !== undefined || interfaceApplicationFactory !== undefined)) ||
      (chainApplicationFactory === undefined && interfaceApplicationFactory !== undefined)) {
      throw new TypeError("Owner application factories must form a dependency prefix.");
    }
    await ensureRuntimeStateDirectory(paths.dataDirectory);
    const credential = await loadOrCreateControlCredential(paths.dataDirectory, paths.controlCredential);
    const createHttpOwner = (database: ProductDatabase): FixedHttpOwner => {
      const ownerStore = database.ownerStore();
      const walletProjection = database.walletStore();
      const profile = ownerStore.readProfile();
      const clock = createCanonicalClock(now);
      const invocationAuthority = createCapabilityInvocationAuthority(clock);
      const rpcSource = createRpcSourceAuthority({ credential, endpoint: configuration.rpc, clock });
      const walletSource = createWalletSourceAuthority({ credential, profileId: profile.profileId, clock });
      const chainPorts = Object.freeze({
        observations: new ObservationAuthorityRegistry(clock, [rpcSource.observationAuthority]),
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
            supportManifest: initialRuntimeSupportManifest,
            wallet: Object.freeze({
              configuration: configuration.wallet,
              privateStoreDirectory: createWalletPrivateStoreDirectoryPort(
                paths.walletConnectDirectory,
                signal,
              ),
              projection: walletProjection,
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
            configuredRpcUri: readConfiguredRpcEndpoint(configuration.rpc).exactUri,
            sourceAuthority: rpcSource,
            capabilityAuthority: Object.freeze({
              clock,
              invocationAuthority,
              invocationPorts: chainPorts,
            }),
          }),
        });
      const interfaceStage: InterfaceOwnerApplicationStage<ActiveWallet, WalletOperations> | undefined =
        interfaceApplicationFactory === undefined
          ? undefined
          : ({ routes, signal, startupResources }, wallet, chain, walletOperations) => interfaceApplicationFactory({
            routes,
            signal,
            startupResources,
            supportManifest: chain.supportManifest,
            walletConnection: wallet.walletConnection,
            walletOperations,
            chainReads: chain.chainReads,
          });
      const stages: OwnerApplicationStages<ActiveWallet, WalletOperations> | undefined = walletStage === undefined
        ? undefined
        : chainStage === undefined
          ? [walletStage]
          : interfaceStage === undefined
            ? [walletStage, chainStage]
            : [walletStage, chainStage, interfaceStage];
      const applicationFactory = stages === undefined
        ? undefined
        : (context: HttpOwnerApplicationContext) => composeOwnerApplicationStages(context, stages);
      return new FixedHttpOwner({
        ownerStore,
        credential,
        now,
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

  stop(): Promise<void> {
    if (this.#stopPromise !== undefined) return this.#stopPromise;
    let resolveTracked!: () => void;
    let rejectTracked!: (error: unknown) => void;
    const tracked = new Promise<void>((resolve, reject) => {
      resolveTracked = resolve;
      rejectTracked = reject;
    });
    this.#stopPromise = tracked;
    this.#stopRequested = true;
    void this.#stopInternal().then(
      () => {
        if (this.#stopPromise === tracked) this.#stopPromise = undefined;
        resolveTracked();
      },
      (error: unknown) => {
        if (this.#stopPromise === tracked) this.#stopPromise = undefined;
        rejectTracked(error);
      },
    );
    return tracked;
  }

  async #stopInternal(): Promise<void> {
    try {
      const owner = this.#httpOwner;
      const permit: HttpOwnerReleasePermit | undefined = owner === undefined
        ? undefined
        : await owner.closeApplication();
      if (!this.#databaseClosed) {
        this.#database.close();
        this.#databaseClosed = true;
      }
      if (owner !== undefined && permit !== undefined) await owner.releaseListener(permit);
    } catch (error) {
      throw normalizeRuntimeError(error);
    }
  }
}
