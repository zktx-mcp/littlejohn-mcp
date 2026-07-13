import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CapabilityBindingRegistry,
  CapabilityRegistry,
  ObservationAuthorityRegistry,
  accountBalanceCapability,
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
  type RuntimeBuildIdentity,
  type UtcTimestamp,
} from "../core/index.js";
import { verifyRuntimeBuildIdentityFiles } from "../build/runtime-file-set.js";
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
  type OwnerOperation,
  type OwnerOperationResponse,
} from "./http-owner.js";
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
const chainReadCapabilityDefinitions = Object.freeze([
  accountBalanceCapability,
  chainStatusCapability,
  contractInspectCapability,
  transactionInspectCapability,
] as const);
const chainReadCapabilityIds = Object.freeze(chainReadCapabilityDefinitions.map((definition) =>
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
  prepare(): Promise<string>;
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

export interface WalletOwnerHandoff {
  readonly supportManifest: WalletRuntimeSupportManifest;
  readonly walletConnection: WalletConnectionReadCapabilityPort;
}

export interface ChainOwnerHandoff {
  readonly supportManifest: ChainRuntimeSupportManifest;
  readonly chainReads: ChainReadCapabilityPort;
}

export interface WalletOwnerApplicationContext {
  readonly routes: RuntimeRouteRegistry;
  readonly signal: AbortSignal;
  readonly supportManifest: InitialRuntimeSupportManifest;
  readonly wallet: WalletOwnerBootstrapPort;
}

export interface ChainOwnerApplicationContext {
  readonly routes: RuntimeRouteRegistry;
  readonly signal: AbortSignal;
  readonly supportManifest: WalletRuntimeSupportManifest;
  readonly walletConnection: WalletConnectionReadCapabilityPort;
  readonly chain: ChainOwnerBootstrapPort;
}

export interface InterfaceOwnerApplicationContext<WalletOperations extends object> {
  readonly routes: RuntimeRouteRegistry;
  readonly signal: AbortSignal;
  readonly supportManifest: ChainRuntimeSupportManifest;
  readonly walletConnection: WalletConnectionReadCapabilityPort;
  readonly walletOperations: WalletOperations;
  readonly chainReads: ChainReadCapabilityPort;
}

export interface WalletOwnerApplication<WalletOperations extends object> extends HttpOwnerApplication {
  readonly supportManifest: WalletRuntimeSupportManifest;
  readonly walletConnection: WalletConnectionReadCapabilityPort;
  readonly walletOperations: WalletOperations;
}

export interface ChainOwnerApplication extends HttpOwnerApplication {
  readonly supportManifest: ChainRuntimeSupportManifest;
  readonly chainReads: ChainReadCapabilityPort;
}

export interface InterfaceOwnerApplication extends HttpOwnerApplication {
  readonly supportManifest: InterfaceRuntimeSupportManifest;
}

export type WalletOwnerApplicationFactory<WalletOperations extends object> = (
  context: WalletOwnerApplicationContext,
) => Promise<WalletOwnerApplication<WalletOperations>> | WalletOwnerApplication<WalletOperations>;
export type ChainOwnerApplicationFactory = (
  context: ChainOwnerApplicationContext,
) => Promise<ChainOwnerApplication> | ChainOwnerApplication;
export type InterfaceOwnerApplicationFactory<WalletOperations extends object> = (
  context: InterfaceOwnerApplicationContext<WalletOperations>,
) => Promise<InterfaceOwnerApplication> | InterfaceOwnerApplication;

interface LocalRuntimeBaseOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => UtcTimestamp;
}

type LocalRuntimeApplicationFactories<WalletOperations extends object> =
  | {
      readonly walletApplicationFactory?: never;
      readonly chainApplicationFactory?: never;
      readonly interfaceApplicationFactory?: never;
    }
  | {
      readonly walletApplicationFactory: WalletOwnerApplicationFactory<WalletOperations>;
      readonly chainApplicationFactory?: never;
      readonly interfaceApplicationFactory?: never;
    }
  | {
      readonly walletApplicationFactory: WalletOwnerApplicationFactory<WalletOperations>;
      readonly chainApplicationFactory: ChainOwnerApplicationFactory;
      readonly interfaceApplicationFactory?: never;
    }
  | {
      readonly walletApplicationFactory: WalletOwnerApplicationFactory<WalletOperations>;
      readonly chainApplicationFactory: ChainOwnerApplicationFactory;
      readonly interfaceApplicationFactory: InterfaceOwnerApplicationFactory<NoInfer<WalletOperations>>;
    };

export type LocalRuntimeOptions<WalletOperations extends object> =
  LocalRuntimeBaseOptions & LocalRuntimeApplicationFactories<WalletOperations>;

const systemNow = (): UtcTimestamp => parseUtcTimestamp(new Date().toISOString());

const ensureRuntimeStateDirectory = async (path: string): Promise<void> => {
  try { await ensureOwnerOnlyDirectory(path); }
  catch { throw new RuntimeOperationError("runtime_state_unavailable"); }
};

export const createWalletPrivateStoreDirectoryPort = (
  path: string,
  signal: AbortSignal,
): WalletPrivateStoreDirectoryPort => Object.freeze({
  async prepare(): Promise<string> {
    if (signal.aborted) throw new RuntimeOperationError("request_aborted");
    await ensureRuntimeStateDirectory(path);
    if (signal.aborted) throw new RuntimeOperationError("request_aborted");
    return path;
  },
});

const closeApplications = async (applications: readonly HttpOwnerApplication[]): Promise<void> => {
  let failure: unknown;
  for (let index = applications.length - 1; index >= 0; index -= 1) {
    try { await applications[index]?.close(); }
    catch (error) { failure ??= error; }
  }
  if (failure !== undefined) throw failure;
};

export type WalletOwnerApplicationStage<WalletOperations extends object> = (
  context: HttpOwnerApplicationContext,
) => Promise<WalletOwnerApplication<WalletOperations>> | WalletOwnerApplication<WalletOperations>;
export type ChainOwnerApplicationStage = (
  context: HttpOwnerApplicationContext,
  wallet: WalletOwnerHandoff,
) => Promise<ChainOwnerApplication> | ChainOwnerApplication;
export type InterfaceOwnerApplicationStage<WalletOperations extends object> = (
  context: HttpOwnerApplicationContext,
  wallet: WalletOwnerHandoff,
  chain: ChainOwnerHandoff,
  walletOperations: WalletOperations,
) => Promise<InterfaceOwnerApplication> | InterfaceOwnerApplication;

export type OwnerApplicationStages<WalletOperations extends object> =
  | readonly [WalletOwnerApplicationStage<WalletOperations>]
  | readonly [WalletOwnerApplicationStage<WalletOperations>, ChainOwnerApplicationStage]
  | readonly [
      WalletOwnerApplicationStage<WalletOperations>,
      ChainOwnerApplicationStage,
      InterfaceOwnerApplicationStage<WalletOperations>,
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

export const composeOwnerApplicationStages = async <WalletOperations extends object>(
  context: HttpOwnerApplicationContext,
  stages: OwnerApplicationStages<WalletOperations>,
): Promise<HttpOwnerApplication> => {
  const applications: HttpOwnerApplication[] = [];
  let currentRoutes = context.routes;
  try {
    const wallet = await stages[0]({ routes: currentRoutes, signal: context.signal });
    applications.push(wallet);
    assertRuntimeRouteRegistryDescendant(currentRoutes, wallet.routes);
    assertWalletRuntimeSupportManifestExtension(initialRuntimeSupportManifest, wallet.supportManifest);
    const walletConnection = snapshotWalletConnection(wallet.walletConnection);
    const walletOperations = wallet.walletOperations;
    const walletOperationsType = typeof walletOperations;
    if (walletOperations === null || (walletOperationsType !== "object" && walletOperationsType !== "function")) {
      throw new TypeError("Wallet operation port must be a reference value.");
    }
    assertCapabilityDirectSupport(wallet.supportManifest, [walletConnectionCapabilityId]);
    const walletHandoff: WalletOwnerHandoff = Object.freeze({
      supportManifest: wallet.supportManifest,
      walletConnection,
    });
    currentRoutes = wallet.routes;
    if (context.signal.aborted) throw new RuntimeOperationError("request_aborted");

    const chainStage = stages[1];
    let chain: ChainOwnerApplication | undefined;
    let chainReads: ChainReadCapabilityPort | undefined;
    let chainHandoff: ChainOwnerHandoff | undefined;
    if (chainStage !== undefined) {
      chain = await chainStage({ routes: currentRoutes, signal: context.signal }, walletHandoff);
      applications.push(chain);
      assertRuntimeRouteRegistryDescendant(currentRoutes, chain.routes);
      assertChainRuntimeSupportManifestExtension(wallet.supportManifest, chain.supportManifest);
      chainReads = snapshotChainReads(chain.chainReads);
      assertCapabilityDirectSupport(chain.supportManifest, chainReadCapabilityIds);
      chainHandoff = Object.freeze({
        supportManifest: chain.supportManifest,
        chainReads,
      });
      currentRoutes = chain.routes;
      if (context.signal.aborted) throw new RuntimeOperationError("request_aborted");
    }

    const interfaceStage = stages[2];
    if (interfaceStage !== undefined) {
      if (chain === undefined || chainReads === undefined || chainHandoff === undefined) {
        throw new TypeError("Interface application dependencies are unavailable.");
      }
      const interfaceApplication = await interfaceStage(
        { routes: currentRoutes, signal: context.signal },
        walletHandoff,
        chainHandoff,
        walletOperations,
      );
      applications.push(interfaceApplication);
      assertRuntimeRouteRegistryDescendant(currentRoutes, interfaceApplication.routes);
      assertInterfaceRuntimeSupportManifestExtension(chain.supportManifest, interfaceApplication.supportManifest);
      currentRoutes = interfaceApplication.routes;
      if (context.signal.aborted) throw new RuntimeOperationError("request_aborted");
    }
    const ownedApplications = Object.freeze([...applications]);
    return Object.freeze({
      routes: currentRoutes,
      close: () => closeApplications(ownedApplications),
    });
  } catch (error) {
    try { await closeApplications(applications); }
    catch { /* Preserve the composition failure. */ }
    throw error;
  }
};

const loadBuildIdentity = async (): Promise<RuntimeBuildIdentity> => {
  const runtimeDirectory = dirname(fileURLToPath(import.meta.url));
  const distDirectory = resolve(runtimeDirectory, "..");
  if (basename(dirname(runtimeDirectory)) === "src") {
    throw new TypeError("The local runtime starts only from a verified compiled package.");
  }
  const packageRoot = resolve(distDirectory, "..");
  const path = resolve(distDirectory, "generated/runtime-build-identity.json");
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  return verifyRuntimeBuildIdentityFiles(parsed, packageRoot, distDirectory, path);
};

export class LocalRuntime {
  readonly #database: ProductDatabase;
  readonly #httpOwner: FixedHttpOwner;

  private constructor(database: ProductDatabase, httpOwner: FixedHttpOwner) {
    this.#database = database;
    this.#httpOwner = httpOwner;
  }

  get ownerState(): FixedHttpOwner["state"] { return this.#httpOwner.state; }

  static async start<WalletOperations extends object = object>(
    options: LocalRuntimeOptions<WalletOperations> = {},
  ): Promise<LocalRuntime> {
    let database: ProductDatabase | undefined;
    try {
      const environment = options.environment ?? process.env;
      const now = options.now ?? systemNow;
      const configuration = readRuntimeConfiguration(environment);
      const paths = runtimePaths(resolveApplicationDataDirectory(environment));
      await ensureRuntimeStateDirectory(paths.dataDirectory);
      const credential = await loadOrCreateControlCredential(paths.dataDirectory, paths.controlCredential);
      database = await ProductDatabase.open(paths.database, parseUtcTimestamp(now()));
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
      const walletApplicationFactory = options.walletApplicationFactory;
      const chainApplicationFactory = options.chainApplicationFactory;
      const interfaceApplicationFactory = options.interfaceApplicationFactory;
      if ((walletApplicationFactory === undefined && (chainApplicationFactory !== undefined || interfaceApplicationFactory !== undefined)) ||
        (chainApplicationFactory === undefined && interfaceApplicationFactory !== undefined)) {
        throw new TypeError("Owner application factories must form a dependency prefix.");
      }
      const walletStage: WalletOwnerApplicationStage<WalletOperations> | undefined =
        walletApplicationFactory === undefined
          ? undefined
          : ({ routes, signal }) => walletApplicationFactory({
            routes,
            signal,
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
      const chainStage: ChainOwnerApplicationStage | undefined = chainApplicationFactory === undefined
        ? undefined
        : ({ routes, signal }, wallet) => chainApplicationFactory({
          routes,
          signal,
          supportManifest: wallet.supportManifest,
          walletConnection: wallet.walletConnection,
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
      const interfaceStage: InterfaceOwnerApplicationStage<WalletOperations> | undefined =
        interfaceApplicationFactory === undefined
          ? undefined
          : ({ routes, signal }, wallet, chain, walletOperations) => interfaceApplicationFactory({
            routes,
            signal,
            supportManifest: chain.supportManifest,
            walletConnection: wallet.walletConnection,
            walletOperations,
            chainReads: chain.chainReads,
          });
      const stages: OwnerApplicationStages<WalletOperations> | undefined = walletStage === undefined
        ? undefined
        : chainStage === undefined
          ? [walletStage]
          : interfaceStage === undefined
            ? [walletStage, chainStage]
            : [walletStage, chainStage, interfaceStage];
      const applicationFactory = stages === undefined
        ? undefined
        : (context: HttpOwnerApplicationContext) => composeOwnerApplicationStages(context, stages);
      const buildIdentity = await loadBuildIdentity();
      const httpOwner = new FixedHttpOwner({
        ownerStore,
        credential,
        runtimeBuildDigest: buildIdentity.digest,
        now,
        ...(applicationFactory === undefined ? {} : { applicationFactory }),
      });
      await httpOwner.start();
      return new LocalRuntime(database, httpOwner);
    } catch (error) {
      try { database?.close(); } catch { /* Preserve the startup failure. */ }
      throw normalizeRuntimeError(error);
    }
  }

  executeOwnerOperation(operation: OwnerOperation): Promise<OwnerOperationResponse> {
    return this.#httpOwner.executeOwnerOperation(operation);
  }

  async stop(): Promise<void> {
    let failure: unknown;
    try { await this.#httpOwner.stop(); }
    catch (error) { failure = error; }
    try { this.#database.close(); }
    catch (error) { failure ??= error; }
    if (failure !== undefined) throw normalizeRuntimeError(failure);
  }
}
