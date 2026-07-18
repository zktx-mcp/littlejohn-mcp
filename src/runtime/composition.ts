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
  createTokenCatalogApplication,
} from "../token-catalog/application.js";
import {
  TokenCatalogCoordinator,
} from "../token-catalog/coordinator.js";
import {
  tokenCatalogCapabilityIds,
  tokenInspectCapability,
} from "../token-catalog/contracts.js";
import {
  type TokenCatalogBrowserOperationPort,
  tokenCatalogConsumerPortContract,
  type TokenCatalogInteractiveCliPort,
  type TokenCatalogApplicationPort,
  type TokenCatalogCoordinatorDependencies,
  type TokenCatalogNonInteractiveOperationPort,
  type TokenCatalogOperationCoordinatorPort,
  type TokenCatalogQueryApplicationPort,
  type TokenCatalogStartApplicationPort,
  type TokenCatalogWebStartPort,
} from "../token-catalog/ports.js";
import { extendTokenCatalogSupportManifest } from "../token-catalog/support.js";
import {
  readRuntimeConfiguration,
  type RuntimeRpcConfiguration,
  type WalletConnectConfiguration,
} from "./configuration.js";
import {
  deriveRuntimeConfigurationMac,
  loadOrCreateControlCredential,
} from "./control-credential.js";
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
  assertTokenCatalogRuntimeSupportManifestExtension,
  assertWalletRuntimeSupportManifestExtension,
  createInitialRuntimeSupportManifest,
  readRuntimeSupportManifest,
  type ChainRuntimeSupportManifest,
  type InitialRuntimeSupportManifest,
  type InterfaceRuntimeSupportManifest,
  type TokenCatalogRuntimeSupportManifest,
  type WalletRuntimeSupportManifest,
} from "./support-manifest.js";

const walletConnectionCapabilityId = getCapabilityDefinitionSnapshot(walletConnectionCapability).capabilityId;
const chainReadCapabilityIds = Object.freeze(chainReadCapabilities.map((definition) =>
  getCapabilityDefinitionSnapshot(definition).capabilityId));
type ActiveWalletAuthorityPort = TokenCatalogCoordinatorDependencies["activeWallet"];

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

export interface TokenInspectionReadCapabilityPort {
  readonly tokenInspection: CapabilityBinding<typeof tokenInspectCapability>;
}

export interface WalletOwnerHandoff<ActiveWallet extends object> {
  readonly supportManifest: WalletRuntimeSupportManifest;
  readonly walletConnection: WalletConnectionReadCapabilityPort;
  readonly activeWallet: ActiveWallet;
}

export interface ChainOwnerHandoff {
  readonly supportManifest: ChainRuntimeSupportManifest;
  readonly chainReads: ChainReadCapabilityPort;
  readonly tokenInspection: TokenInspectionReadCapabilityPort["tokenInspection"];
}

export interface TokenCatalogConsumerPorts {
  readonly tokenCatalogQueries: TokenCatalogQueryApplicationPort;
  readonly tokenCatalogWebStart: TokenCatalogWebStartPort;
  readonly tokenCatalogBrowserOperations: TokenCatalogBrowserOperationPort;
  readonly tokenCatalogInteractiveCli: TokenCatalogInteractiveCliPort;
  readonly tokenCatalogNonInteractiveOperations: TokenCatalogNonInteractiveOperationPort;
}

export interface TokenCatalogOwnerHandoff extends TokenCatalogConsumerPorts {
  readonly supportManifest: TokenCatalogRuntimeSupportManifest;
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

export interface InterfaceOwnerApplicationContext<WalletOperations extends object>
  extends TokenCatalogConsumerPorts {
  readonly routes: RuntimeRouteRegistry;
  readonly signal: AbortSignal;
  readonly startupResources: HttpOwnerStartupResourceRegistry;
  readonly supportManifest: TokenCatalogRuntimeSupportManifest;
  readonly walletConnection: WalletConnectionReadCapabilityPort;
  readonly walletOperations: WalletOperations;
  readonly chainReads: ChainReadCapabilityPort;
  readonly tokenInspection: TokenInspectionReadCapabilityPort["tokenInspection"];
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
  readonly tokenInspection: TokenInspectionReadCapabilityPort["tokenInspection"];
}

export interface TokenCatalogOwnerApplication extends HttpOwnerApplication, TokenCatalogConsumerPorts {
  readonly supportManifest: TokenCatalogRuntimeSupportManifest;
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
  WalletOperations extends object,
> = (
  context: HttpOwnerApplicationContext,
) => Promise<WalletOwnerApplication<ActiveWallet, WalletOperations>> |
  WalletOwnerApplication<ActiveWallet, WalletOperations>;
export type ChainOwnerApplicationStage<ActiveWallet extends object> = (
  context: HttpOwnerApplicationContext,
  wallet: WalletOwnerHandoff<ActiveWallet>,
) => Promise<ChainOwnerApplication> | ChainOwnerApplication;
export type TokenCatalogOwnerApplicationStage<ActiveWallet extends object> = (
  context: HttpOwnerApplicationContext,
  wallet: WalletOwnerHandoff<ActiveWallet>,
  chain: ChainOwnerHandoff,
) => Promise<TokenCatalogOwnerApplication> | TokenCatalogOwnerApplication;
export type InterfaceOwnerApplicationStage<
  ActiveWallet extends object,
  WalletOperations extends object,
> = (
  context: HttpOwnerApplicationContext,
  wallet: WalletOwnerHandoff<ActiveWallet>,
  chain: ChainOwnerHandoff,
  tokenCatalog: TokenCatalogOwnerHandoff,
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
      TokenCatalogOwnerApplicationStage<ActiveWallet>,
    ]
  | readonly [
      WalletOwnerApplicationStage<ActiveWallet, WalletOperations>,
      ChainOwnerApplicationStage<ActiveWallet>,
      TokenCatalogOwnerApplicationStage<ActiveWallet>,
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
  input: TokenInspectionReadCapabilityPort["tokenInspection"],
): TokenInspectionReadCapabilityPort["tokenInspection"] => {
  assertBindingProvenance(tokenInspectCapability, input);
  return input;
};

const createTokenCatalogStartPort = <InteractionInterface extends "cli" | "web">(
  application: TokenCatalogApplicationPort,
  interactionInterface: InteractionInterface,
): TokenCatalogStartApplicationPort<InteractionInterface> => Object.freeze({
  interactionInterface,
  startRegistration: (input: Parameters<TokenCatalogApplicationPort["startRegistration"]>[0]) =>
    application.startRegistration(input, interactionInterface),
  startRegistrationUpdate: (input: Parameters<TokenCatalogApplicationPort["startRegistrationUpdate"]>[0]) =>
    application.startRegistrationUpdate(input, interactionInterface),
  startUnregistration: (input: Parameters<TokenCatalogApplicationPort["startUnregistration"]>[0]) =>
    application.startUnregistration(input, interactionInterface),
});

export const createTokenCatalogConsumerPorts = (
  application: TokenCatalogApplicationPort,
  coordinator: TokenCatalogOperationCoordinatorPort,
): TokenCatalogConsumerPorts => {
  const tokenCatalogQueries = Object.freeze({
    getRegistration: (input: Parameters<TokenCatalogApplicationPort["getRegistration"]>[0]) =>
      application.getRegistration(input),
    listRegistrations: (input: Parameters<TokenCatalogApplicationPort["listRegistrations"]>[0]) =>
      application.listRegistrations(input),
  }) satisfies TokenCatalogQueryApplicationPort;
  const tokenCatalogWebStart = createTokenCatalogStartPort(application, "web");
  const cliStart = createTokenCatalogStartPort(application, "cli");
  const tokenCatalogBrowserOperations = Object.freeze({
    interactionInterface: "web",
    getOperation: (input: Parameters<TokenCatalogApplicationPort["getOperation"]>[0]) =>
      application.getOperation(input),
    getCurrentOperation: () => coordinator.getCurrentOperation(),
    confirm: (input: Parameters<TokenCatalogBrowserOperationPort["confirm"]>[0]) =>
      coordinator.confirm("web", input),
    cancel: (operationId: Parameters<TokenCatalogBrowserOperationPort["cancel"]>[0]) =>
      coordinator.cancel(operationId, "web"),
  }) satisfies TokenCatalogBrowserOperationPort;
  const tokenCatalogInteractiveCli = Object.freeze({
    ...cliStart,
    interactionInterface: "cli",
    confirm: (input: Parameters<TokenCatalogInteractiveCliPort["confirm"]>[0]) =>
      coordinator.confirm("cli", input),
  }) satisfies TokenCatalogInteractiveCliPort;
  const tokenCatalogNonInteractiveOperations = Object.freeze({
    getOperation: (input: Parameters<TokenCatalogApplicationPort["getOperation"]>[0]) =>
      application.getOperation(input),
    cancelOperation: (input: Parameters<TokenCatalogApplicationPort["cancelOperation"]>[0]) =>
      application.cancelOperation(input),
  }) satisfies TokenCatalogNonInteractiveOperationPort;
  return Object.freeze({
    tokenCatalogQueries,
    tokenCatalogWebStart,
    tokenCatalogBrowserOperations,
    tokenCatalogInteractiveCli,
    tokenCatalogNonInteractiveOperations,
  });
};

const snapshotTokenCatalogConsumerPorts = (
  input: TokenCatalogConsumerPorts,
): TokenCatalogConsumerPorts => {
  const assertPort = (
    name: string,
    port: object,
    definition: Readonly<{
      methods: readonly string[];
      interactionInterface?: "cli" | "web";
    }>,
  ): void => {
    const expectedKeys = [
      ...definition.methods,
      ...(definition.interactionInterface === undefined ? [] : ["interactionInterface"]),
    ].sort();
    const actualKeys = Reflect.ownKeys(port);
    if (
      actualKeys.some((key) => typeof key !== "string") ||
      JSON.stringify(actualKeys.slice().sort()) !== JSON.stringify(expectedKeys) ||
      definition.methods.some((method) => typeof (port as Record<string, unknown>)[method] !== "function") ||
      (definition.interactionInterface !== undefined &&
        (port as { interactionInterface?: unknown }).interactionInterface !== definition.interactionInterface)
    ) throw new TypeError(`Token catalog ${name} authority is invalid.`);
  };
  assertPort(
    "query",
    input.tokenCatalogQueries,
    tokenCatalogConsumerPortContract.tokenCatalogQueries,
  );
  assertPort(
    "web start",
    input.tokenCatalogWebStart,
    tokenCatalogConsumerPortContract.tokenCatalogWebStart,
  );
  assertPort(
    "browser operation",
    input.tokenCatalogBrowserOperations,
    tokenCatalogConsumerPortContract.tokenCatalogBrowserOperations,
  );
  assertPort(
    "interactive CLI",
    input.tokenCatalogInteractiveCli,
    tokenCatalogConsumerPortContract.tokenCatalogInteractiveCli,
  );
  assertPort(
    "non-interactive operation",
    input.tokenCatalogNonInteractiveOperations,
    tokenCatalogConsumerPortContract.tokenCatalogNonInteractiveOperations,
  );
  return Object.freeze({
    tokenCatalogQueries: Object.freeze({
      getRegistration: (request: Parameters<TokenCatalogQueryApplicationPort["getRegistration"]>[0]) =>
        input.tokenCatalogQueries.getRegistration(request),
      listRegistrations: (request: Parameters<TokenCatalogQueryApplicationPort["listRegistrations"]>[0]) =>
        input.tokenCatalogQueries.listRegistrations(request),
    }),
    tokenCatalogWebStart: Object.freeze({
      interactionInterface: "web",
      startRegistration: (request: Parameters<TokenCatalogWebStartPort["startRegistration"]>[0]) =>
        input.tokenCatalogWebStart.startRegistration(request),
      startRegistrationUpdate: (request: Parameters<TokenCatalogWebStartPort["startRegistrationUpdate"]>[0]) =>
        input.tokenCatalogWebStart.startRegistrationUpdate(request),
      startUnregistration: (request: Parameters<TokenCatalogWebStartPort["startUnregistration"]>[0]) =>
        input.tokenCatalogWebStart.startUnregistration(request),
    }),
    tokenCatalogBrowserOperations: Object.freeze({
      interactionInterface: "web",
      getOperation: (request: Parameters<TokenCatalogBrowserOperationPort["getOperation"]>[0]) =>
        input.tokenCatalogBrowserOperations.getOperation(request),
      getCurrentOperation: () => input.tokenCatalogBrowserOperations.getCurrentOperation(),
      confirm: (request: Parameters<TokenCatalogBrowserOperationPort["confirm"]>[0]) =>
        input.tokenCatalogBrowserOperations.confirm(request),
      cancel: (operationId: Parameters<TokenCatalogBrowserOperationPort["cancel"]>[0]) =>
        input.tokenCatalogBrowserOperations.cancel(operationId),
    }),
    tokenCatalogInteractiveCli: Object.freeze({
      interactionInterface: "cli",
      startRegistration: (request: Parameters<TokenCatalogInteractiveCliPort["startRegistration"]>[0]) =>
        input.tokenCatalogInteractiveCli.startRegistration(request),
      startRegistrationUpdate: (request: Parameters<TokenCatalogInteractiveCliPort["startRegistrationUpdate"]>[0]) =>
        input.tokenCatalogInteractiveCli.startRegistrationUpdate(request),
      startUnregistration: (request: Parameters<TokenCatalogInteractiveCliPort["startUnregistration"]>[0]) =>
        input.tokenCatalogInteractiveCli.startUnregistration(request),
      confirm: (request: Parameters<TokenCatalogInteractiveCliPort["confirm"]>[0]) =>
        input.tokenCatalogInteractiveCli.confirm(request),
    }),
    tokenCatalogNonInteractiveOperations: Object.freeze({
      getOperation: (request: Parameters<TokenCatalogNonInteractiveOperationPort["getOperation"]>[0]) =>
        input.tokenCatalogNonInteractiveOperations.getOperation(request),
      cancelOperation: (request: Parameters<TokenCatalogNonInteractiveOperationPort["cancelOperation"]>[0]) =>
        input.tokenCatalogNonInteractiveOperations.cancelOperation(request),
    }),
  });
};

const assertCapabilityDirectSupport = (
  manifest: WalletRuntimeSupportManifest | ChainRuntimeSupportManifest | TokenCatalogRuntimeSupportManifest,
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
  initialSupportManifest: InitialRuntimeSupportManifest,
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
        const tokenInspection = snapshotTokenInspection(chainApplication.tokenInspection);
        assertCapabilityDirectSupport(chainApplication.supportManifest, chainReadCapabilityIds);
        if (context.signal.aborted) throw new RuntimeOperationError("request_aborted");
        return Object.freeze({
          application: chainApplication,
          reads,
          handoff: Object.freeze({
            supportManifest: chainApplication.supportManifest,
            chainReads: reads,
            tokenInspection,
          }) satisfies ChainOwnerHandoff,
        });
      });
      chain = chainResult.application;
      chainReads = chainResult.reads;
      chainHandoff = chainResult.handoff;
      currentRoutes = chain.routes;
    }

    const tokenCatalogStage = stages[2];
    let tokenCatalogApplication: TokenCatalogOwnerApplication | undefined;
    let tokenCatalogHandoff: TokenCatalogOwnerHandoff | undefined;
    if (tokenCatalogStage !== undefined) {
      if (chain === undefined || chainHandoff === undefined) {
        throw new TypeError("Token catalog dependencies are unavailable.");
      }
      const tokenCatalogRoutes = currentRoutes;
      const tokenCatalogResult = await runApplicationStage(
        applications,
        (startupResources) => tokenCatalogStage(
          { routes: tokenCatalogRoutes, signal: context.signal, startupResources },
          walletHandoff,
          chainHandoff,
        ),
        (application) => {
          assertRuntimeRouteRegistryDescendant(tokenCatalogRoutes, application.routes);
          assertTokenCatalogRuntimeSupportManifestExtension(chain.supportManifest, application.supportManifest);
          assertCapabilityDirectSupport(application.supportManifest, tokenCatalogCapabilityIds);
          const consumerPorts = snapshotTokenCatalogConsumerPorts(application);
          if (context.signal.aborted) throw new RuntimeOperationError("request_aborted");
          return Object.freeze({
            application,
            handoff: Object.freeze({
              supportManifest: application.supportManifest,
              ...consumerPorts,
            }) satisfies TokenCatalogOwnerHandoff,
          });
        },
      );
      tokenCatalogApplication = tokenCatalogResult.application;
      tokenCatalogHandoff = tokenCatalogResult.handoff;
      currentRoutes = tokenCatalogApplication.routes;
    }

    const interfaceStage = stages[3];
    if (interfaceStage !== undefined) {
      if (
        chain === undefined || chainReads === undefined || chainHandoff === undefined ||
        tokenCatalogApplication === undefined || tokenCatalogHandoff === undefined
      ) {
        throw new TypeError("Interface application dependencies are unavailable.");
      }
      const interfaceRoutes = currentRoutes;
      const interfaceApplication = await runApplicationStage(
        applications,
        (startupResources) => interfaceStage(
          { routes: interfaceRoutes, signal: context.signal, startupResources },
          walletHandoff,
          chainHandoff,
          tokenCatalogHandoff,
          walletOperations,
        ),
        (application) => {
          assertRuntimeRouteRegistryDescendant(interfaceRoutes, application.routes);
          assertInterfaceRuntimeSupportManifestExtension(
            tokenCatalogApplication.supportManifest,
            application.supportManifest,
          );
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
    const initialSupportManifest = createInitialRuntimeSupportManifest(configuration.chain);
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
            supportManifest: initialSupportManifest,
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
            configuration: configuration.rpc,
            sourceAuthority: rpcSource,
            capabilityAuthority: Object.freeze({
              clock,
              invocationAuthority,
              invocationPorts: chainPorts,
            }),
          }),
        });
      const tokenCatalogStage: TokenCatalogOwnerApplicationStage<ActiveWallet> | undefined =
        chainStage === undefined
          ? undefined
          : ({ routes, signal }, wallet, chain) => {
            const activeWallet = requireActiveWalletAuthority(wallet.activeWallet);
            const coordinator = new TokenCatalogCoordinator({
              activeWallet,
              inspection: chain.tokenInspection,
              store: database.tokenCatalogStore(),
              clock,
              readWalletProjection: () => walletProjection.read(),
              signal,
            });
            const tokenCatalog = createTokenCatalogApplication({
              dependencies: {
                activeWallet,
                store: database.tokenCatalogReadStore(),
              },
              operations: coordinator,
            });
            const consumerPorts = createTokenCatalogConsumerPorts(tokenCatalog, coordinator);
            const supportManifest = extendTokenCatalogSupportManifest(chain.supportManifest);
            return Object.freeze({
              routes,
              supportManifest,
              ...consumerPorts,
              close: async () => { coordinator.close(); },
            });
          };
      const interfaceStage: InterfaceOwnerApplicationStage<ActiveWallet, WalletOperations> | undefined =
        interfaceApplicationFactory === undefined
          ? undefined
          : ({ routes, signal, startupResources }, wallet, chain, tokenCatalog, walletOperations) => interfaceApplicationFactory({
            routes,
            signal,
            startupResources,
            supportManifest: tokenCatalog.supportManifest,
            walletConnection: wallet.walletConnection,
            walletOperations,
            chainReads: chain.chainReads,
            tokenInspection: chain.tokenInspection,
            tokenCatalogQueries: tokenCatalog.tokenCatalogQueries,
            tokenCatalogWebStart: tokenCatalog.tokenCatalogWebStart,
            tokenCatalogBrowserOperations: tokenCatalog.tokenCatalogBrowserOperations,
            tokenCatalogInteractiveCli: tokenCatalog.tokenCatalogInteractiveCli,
            tokenCatalogNonInteractiveOperations: tokenCatalog.tokenCatalogNonInteractiveOperations,
          });
      const stages: OwnerApplicationStages<ActiveWallet, WalletOperations> | undefined = walletStage === undefined
        ? undefined
        : chainStage === undefined
          ? [walletStage]
          : interfaceStage === undefined
            ? [walletStage, chainStage, tokenCatalogStage as TokenCatalogOwnerApplicationStage<ActiveWallet>]
            : [
                walletStage,
                chainStage,
                tokenCatalogStage as TokenCatalogOwnerApplicationStage<ActiveWallet>,
                interfaceStage,
              ];
      const applicationFactory = stages === undefined
        ? undefined
        : (context: HttpOwnerApplicationContext) => composeOwnerApplicationStages(
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
