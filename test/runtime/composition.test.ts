import type { RegistryOwnerApplicationStage } from "../../src/runtime/composition.js";
import { priceInterfaceBindings, priceInterfaceManifest } from "../stock-token-prices/interface-fixture.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AccountAssetOperationError } from "../../src/account-assets/errors.js";
import { extendChainSupportManifest } from "../../src/chain/application.js";
import { extendWalletSupportManifest } from "../../src/wallet/application.js";
import { extendStockTokenPriceSupportManifest } from "../../src/stock-token-prices/support.js";
import { extendInterfaceSupportManifest } from "../../src/interfaces/support.js";
import { extendAccountAssetSupportManifest } from "../../src/account-assets/support.js";
import {
  extendStockTokenTradeHistorySupportManifest,
  stockTokenTradeHistoryCapability,
  stockTokenTradeHistoryErrorRegistry,
} from "../../src/stock-token-trade-history/index.js";
import type { AccountAssetApplicationPort } from "../../src/account-assets/ports.js";
import {accountBalanceCapability} from "../../src/account-assets/balance-capability.js";
import {chainStatusCapability, addressInspectCapability, transactionInspectCapability} from "../../src/chain/read-contracts.js";
import {walletConnectionCapability} from "../../src/wallet/connection-capability.js";
import { tokenInspectCapability } from "../../src/token-catalog/contracts.js";
import { tokenCatalogErrorRegistry } from "../../src/token-catalog/errors.js";
import { TokenCatalogOperationError } from "../../src/token-catalog/operation-error.js";
import { extendTokenCatalogSupportManifest } from "../../src/token-catalog/support.js";
import type {
  TokenAdditionChainReadPort,
  TokenCatalogApplicationPort,
  TokenCatalogManagementApplicationPort,
  TokenCatalogQueryApplicationPort,
} from "../../src/token-catalog/ports.js";
import type { WalletManagementPort } from "../../src/wallet/contracts.js";
import {
  LocalRuntime,
  composeOwnerApplicationStages,
  type AccountAssetOwnerApplicationStage,
  type ReviewOwnerApplicationStage,
  type ProtocolOwnerApplicationStage,
  type StockTokenTradeHistoryOwnerApplicationStage,
  type StockTokenPriceOwnerApplicationStage,
  type TokenCatalogOwnerApplicationStage,
} from "../../src/runtime/composition.js";
import type {
  ChainReadCapabilityPort,
  WalletConnectionReadCapabilityPort,
} from "../../src/runtime/application-context.js";
import {
  readRuntimeConfiguration,
} from "../../src/runtime/configuration.js";
import {
  createControlCredentialVerifier,
  loadOrCreateControlCredential,
} from "../../src/runtime/control-credential.js";
import { RuntimeOperationError } from "../../src/runtime/errors.js";
import {
  runtimeProcessTerminal,
  runtimeReleased,
  type RuntimeShutdownOutcome,
} from "../../src/runtime/shutdown.js";
import { createResourceOwnershipScope } from "../../src/runtime/resource-ownership.js";
import { createRuntimeRouteRegistry } from "../../src/runtime/http-routing.js";
import { runtimePaths } from "../../src/runtime/paths.js";
import {
  extendChainRuntimeSupportManifest,
  extendInterfaceRuntimeSupportManifest,
  extendWalletRuntimeSupportManifest,
  createInitialRuntimeSupportManifest,
  verifyCurrentSupportDocument,
} from "../../src/runtime/support-manifest.js";
import type { ChainInvocationPort } from "../../src/chain/invocation-lifecycle.js";
import type { PinnedEvmReadPort } from "../../src/chain/protocol-reads.js";
import { bindForHarness, createCapabilityHarness } from "../core/capability-harness.js";
import {
  extendProtocolHarnessManifest,
  protocolHarnessSupportExtension,
  uniswapV2QuoteHarnessBinding,
  uniswapV4PoolsHarnessBinding,
} from "../protocols/interface-harness.js";

const directories: string[] = [];
const initialRuntimeSupportManifest = createInitialRuntimeSupportManifest(
  readRuntimeConfiguration({}).chain,
);

const internalFailure = new TokenCatalogOperationError("internal_error").failure;
const testTokenCatalog: TokenCatalogApplicationPort = Object.freeze({
  getSelection: () => internalFailure,
  listSelections: () => internalFailure,
  review: async () => internalFailure,
  decide: async () => internalFailure,
  getOperation: () => internalFailure,
});

const unavailableOperation = (): never => { throw new Error("Token catalog operation is unavailable in this fixture."); };
const testAddressTargets = Object.freeze({
  resolve: () => unavailableOperation(),
});
const testChainInvocations = Object.freeze({
  run: async () => unavailableOperation(),
}) satisfies ChainInvocationPort;
const testTokenAdditionReads = Object.freeze({
  inspectAndVerifyOfficial: async () => unavailableOperation(),
}) satisfies TokenAdditionChainReadPort;
const testTokenCatalogQueries = Object.freeze({
  getSelection: testTokenCatalog.getSelection,
  listSelections: testTokenCatalog.listSelections,
}) satisfies TokenCatalogQueryApplicationPort;
const testTokenCatalogManagement = Object.freeze({
  review: testTokenCatalog.review,
  decide: testTokenCatalog.decide,
  getOperation: testTokenCatalog.getOperation,
}) satisfies TokenCatalogManagementApplicationPort;

const testTokenInspection = () => bindForHarness(
  tokenInspectCapability,
  createCapabilityHarness(),
  async () => ({ status: "failure", code: "internal_error", issues: [] }),
  tokenCatalogErrorRegistry,
);

const testOfficialAssetReads = Object.freeze({
  verifyAtBlock: async () => unavailableOperation(),
  verifyManyAtBlock: async () => unavailableOperation(),
});
const testAccountAssetReads = Object.freeze({
  readCollectionAtBlock: async () => unavailableOperation(),
});
const testCurrentBlockReads = Object.freeze({
  resolveCurrentBlock: async () => unavailableOperation(),
});
const testPinnedEvmReads = Object.freeze({
  observationAuthority: Object.freeze({}) as PinnedEvmReadPort["observationAuthority"],
  resolveBlock: async () => unavailableOperation(),
  readRuntimeCode: async () => unavailableOperation(),
  call: async () => unavailableOperation(),
  readTokenDecimals: async () => unavailableOperation(),
  readTokenDisplayScaling: async () => { throw new Error("Unexpected token display read."); },
  inspectContractExecution: async () => { throw new Error("Unexpected transaction contract execution read."); },
  inspectContract: async () => unavailableOperation(),
  recordConfiguredChain: () => unavailableOperation(),
}) satisfies PinnedEvmReadPort;

const testWalletRequests = Object.freeze({
  hasPendingRequest: () => false,
  startRequest: async (): Promise<never> => { throw new Error("This stage fixture does not submit transactions."); },
});
const testTransactionReads = Object.freeze({
  observationAuthority: testPinnedEvmReads.observationAuthority,
  balance: async (): Promise<never> => unavailableOperation(),
  nonce: async (): Promise<never> => unavailableOperation(),
  estimateGas: async (): Promise<never> => unavailableOperation(),
  simulate: async (): Promise<never> => unavailableOperation(),
  readTransaction: async (): Promise<never> => unavailableOperation(),
  finality: async (): Promise<never> => unavailableOperation(),
});

const createTestProtocolStage = <ActiveWallet extends object>(
  close: () => void = () => undefined,
): ProtocolOwnerApplicationStage<ActiveWallet> => ({ routes }, _wallet, _chain) => ({
  routes,
  supportExtension: protocolHarnessSupportExtension(),
  uniswapV2Quote: uniswapV2QuoteHarnessBinding(),
  uniswapV4Pools: uniswapV4PoolsHarnessBinding(),
  poolPrices: { observationAuthority: testPinnedEvmReads.observationAuthority, createSession: () => ({ read: async () => { throw new Error("No price read is expected in composition tests."); } }) },
  close: async () => { close(); },
});

const createTestPriceStage = (close: () => void = () => undefined): StockTokenPriceOwnerApplicationStage =>
  ({ routes, supportBase }, _chain, _protocols, _registry) => ({
    routes, supportManifest: priceInterfaceManifest(supportBase), ...priceInterfaceBindings(),
    close: async () => { close(); },
  });

const createTestReviewStage = <ActiveWallet extends object>(close: () => void = () => undefined): ReviewOwnerApplicationStage<ActiveWallet> => ({ routes }) => ({
  routes,
  exchange: { start: async () => unavailableOperation(), get: unavailableOperation, cancel: unavailableOperation, confirm: async () => unavailableOperation() },
  signing: { start: async () => unavailableOperation(), get: unavailableOperation, cancel: unavailableOperation, confirm: async () => unavailableOperation() },
  activity: { get: unavailableOperation, list: unavailableOperation, inspect: async () => unavailableOperation() },
  presentations: { readPresentation: unavailableOperation },
  close: async () => { close(); },
});

const createTestTokenCatalogStage = <ActiveWallet extends object>(
  close: () => void = () => undefined,
): TokenCatalogOwnerApplicationStage<ActiveWallet> => ({ routes, supportBase }, _chain, _registry) => ({
  routes,
  supportManifest: extendTokenCatalogSupportManifest(supportBase),
  accountTokenSelectionStore: Object.freeze({
    isAccountRetained: () => false,
    getState: () => undefined,
    getForAccount: () => undefined,
    listIncludedForAccount: () => Object.freeze({ selections: [], nextCursor: null }),
    initializeDefaults: () => { throw new Error("No default initialization is expected."); },
  }),
  tokenCatalogQueries: testTokenCatalogQueries,
  tokenCatalogManagement: testTokenCatalogManagement,
  close: async () => { close(); },
});

const accountAssetFailure = new AccountAssetOperationError("internal_error").failure;
const testAccountAssets: AccountAssetApplicationPort = Object.freeze({
  list: async () => accountAssetFailure,
});

const createTestAccountAssetStage = <ActiveWallet extends object>(
  close: () => void = () => undefined,
): AccountAssetOwnerApplicationStage<ActiveWallet> => ({ routes, supportBase }, _chain, _catalog, _registry) => ({
  routes,
  supportManifest: extendAccountAssetSupportManifest(supportBase),
  list: testAccountAssets.list,
  close: async () => { close(); },
});

const testTradeHistory = Object.freeze({
  binding: bindForHarness(
    stockTokenTradeHistoryCapability,
    createCapabilityHarness(),
    async () => Object.freeze({
      status: "failure" as const,
      code: "internal_error",
      issues: Object.freeze([]),
    }),
    stockTokenTradeHistoryErrorRegistry,
  ),
});

const createTestTradeHistoryStage = <ActiveWallet extends object>(
  close: () => void = () => undefined,
): StockTokenTradeHistoryOwnerApplicationStage<ActiveWallet> => (
  { routes, supportBase },
  _chain,
  _registry,
) => ({
  routes,
  supportManifest: extendStockTokenTradeHistorySupportManifest(supportBase),
  ...testTradeHistory,
  close: async () => { close(); },
});

const extendTestInterfaceSupportManifest = (
  parent: ReturnType<typeof extendProtocolHarnessManifest>,
) => extendInterfaceRuntimeSupportManifest(parent, {
  registrations: [],
  presentations: [],
  changes: [{
    capabilityId: "chain.status",
    availability: {
      overall: "available", direct: "internal", http: "available",
      mcp: "unavailable", cli: "unavailable",
    },
  }],
});

const composeStages = <
  ActiveWallet extends object,
  WalletOperations extends WalletManagementPort,
>(
  context: Parameters<typeof composeOwnerApplicationStages<ActiveWallet, WalletOperations>>[0],
  stages: Parameters<typeof composeOwnerApplicationStages<ActiveWallet, WalletOperations>>[2],
) => composeOwnerApplicationStages(context, initialRuntimeSupportManifest, stages);

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const baseRoutes = async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "littlejohn-composition-"));
  directories.push(directory);
  const paths = runtimePaths(directory);
  const authority = await loadOrCreateControlCredential(directory, paths.controlCredential);
  return createRuntimeRouteRegistry({ controlVerifier: createControlCredentialVerifier(authority) });
};

const route = (pathPattern: string) => ({
  method: "GET" as const,
  pathPattern,
  mutation: "none" as const,
  successStatus: 200 as const,
  handler: async () => ({ ok: true as const, body: {} }),
});

const ownerContext = (
  routes: Awaited<ReturnType<typeof baseRoutes>>,
  signal: AbortSignal,
) => ({
  routes,
  signal,
  startupResources: createResourceOwnershipScope().resources,
});

interface TestWalletOperations extends WalletManagementPort {
  readOperation(): "test-operation";
}

interface TestActiveWallet {
  capture(): "test-wallet";
}

const testWalletOperations = (): TestWalletOperations => Object.freeze({
  readOperation: () => "test-operation" as const,
  review: async () => unavailableOperation(),
  decide: async () => unavailableOperation(),
  get: async () => unavailableOperation(),
  cancel: async () => unavailableOperation(),
  getPresentation: async () => unavailableOperation(),
});

const testActiveWallet = (): TestActiveWallet => Object.freeze({
  capture: () => "test-wallet" as const,
});

const capabilityPorts = (): {
  readonly wallet: WalletConnectionReadCapabilityPort;
  readonly chain: ChainReadCapabilityPort;
} => {
  const harness = createCapabilityHarness();
  const failure = async () => ({ status: "failure", code: "internal_error", issues: [] });
  return {
    wallet: {
      connection: bindForHarness(walletConnectionCapability, harness, failure),
    },
    chain: {
      accountBalance: bindForHarness(accountBalanceCapability, harness, failure),
      chainStatus: bindForHarness(chainStatusCapability, harness, failure),
      addressInspect: bindForHarness(addressInspectCapability, harness, failure),
      transactionInspect: bindForHarness(transactionInspectCapability, harness, failure),
    },
  };
};

const manifests = () => {
  const wallet = extendWalletRuntimeSupportManifest(initialRuntimeSupportManifest, {
    registrations: [],
    changes: [{
      capabilityId: "wallet.connection",
      availability: {
        overall: "internal", direct: "internal", http: "unavailable",
        mcp: "unavailable", cli: "unavailable",
      },
    }],
  });
  const chain = extendChainRuntimeSupportManifest(initialRuntimeSupportManifest, {
    registrations: [],
    changes: ["account.balance", "address.inspect", "chain.status", "transaction.inspect"].map((capabilityId) => ({
      capabilityId,
      availability: {
        overall: "internal", direct: "internal", http: "unavailable",
        mcp: "unavailable", cli: "unavailable",
      },
    })),
  });
  return { wallet, chain };
};

describe("owner application composition", () => {
  it("retains the database and listener when shutdown is process-terminal", async () => {
    const events: string[] = [];
    const database = { close(): void { events.push("database:close"); } };
    const owner = {
      state: "owner" as const,
      async start(): Promise<void> { events.push("owner:start"); },
      async closeApplication() {
        events.push("owner:contain");
        return Object.freeze({ outcome: runtimeProcessTerminal });
      },
      async releaseListener(): Promise<void> { events.push("owner:release"); },
    };
    const runtime = Reflect.construct(LocalRuntime, [database, () => owner]) as LocalRuntime;
    await runtime.start();
    await expect(runtime.stop()).resolves.toBe(runtimeProcessTerminal);
    expect(events).toEqual(["owner:start", "owner:contain"]);
  });

  it("preserves shutdown dependencies and retries only resources not proven closed", async () => {
    for (const failingResource of ["application", "database", "server"] as const) {
      const events: string[] = [];
      const secret = `secret-${failingResource}-close-payload`;
      let failureAvailable = true;
      const permit = Object.freeze({ resource: failingResource });
      const database = {
        close(): void {
          events.push("database:close");
          if (failingResource === "database" && failureAvailable) {
            failureAvailable = false;
            throw new Error(secret);
          }
        },
      };
      const owner = {
        async start(): Promise<void> { events.push("owner:start"); },
        async closeApplication() {
          events.push("owner:prepare");
          if (failingResource === "application" && failureAvailable) {
            failureAvailable = false;
            throw new Error(secret);
          }
          return Object.freeze({ outcome: runtimeReleased, permit });
        },
        async releaseListener(input: object): Promise<void> {
          expect(input).toBe(permit);
          events.push("owner:release");
          if (failingResource === "server" && failureAvailable) {
            failureAvailable = false;
            throw new Error(secret);
          }
        },
      };
      const runtime = Reflect.construct(LocalRuntime, [database, () => owner]) as LocalRuntime;
      await runtime.start();
      events.length = 0;
      let failure: unknown;
      try { await runtime.stop(); }
      catch (error) { failure = error; }
      expect(events).toEqual(failingResource === "application"
        ? ["owner:prepare"]
        : failingResource === "database"
          ? ["owner:prepare", "database:close"]
          : ["owner:prepare", "database:close", "owner:release"]);
      expect(failure).toBeInstanceOf(RuntimeOperationError);
      expect((failure as RuntimeOperationError).failure.error.code).toBe("internal_error");
      expect((failure as Error).message).not.toContain(secret);
      expect((failure as Error).cause).toBeUndefined();
      expect(JSON.stringify(failure)).not.toContain(secret);

      events.length = 0;
      await expect(runtime.stop()).resolves.toBe(runtimeReleased);
      expect(events).toEqual(failingResource === "server"
        ? ["owner:prepare", "owner:release"]
        : ["owner:prepare", "database:close", "owner:release"]);
    }
  });

  it("installs one runtime stop authority before owner abort can reenter it", async () => {
    const events: string[] = [];
    let runtime!: LocalRuntime;
    let reentered: Promise<RuntimeShutdownOutcome> | undefined;
    const database = {
      close(): void { events.push("database:close"); },
    };
    const permit = Object.freeze({ permit: true });
    const owner = {
      state: "owner" as const,
      async start(): Promise<void> { events.push("owner:start"); },
      async closeApplication() {
        events.push("owner:prepare");
        reentered = runtime.stop();
        return Object.freeze({ outcome: runtimeReleased, permit });
      },
      async releaseListener(input: object): Promise<void> {
        expect(input).toBe(permit);
        events.push("owner:release");
      },
    };
    runtime = Reflect.construct(LocalRuntime, [database, () => owner]) as LocalRuntime;
    await runtime.start();

    const stopping = runtime.stop();
    await stopping;
    expect(reentered).toBe(stopping);
    expect(events).toEqual(["owner:start", "owner:prepare", "database:close", "owner:release"]);
  });

  it("returns cleanup authority before fallible owner construction and forbids restart after stop", async () => {
    const constructionFailure = new Error("owner construction failed");
    let databaseCloses = 0;
    const runtime = Reflect.construct(LocalRuntime, [{
      close(): void { databaseCloses += 1; },
    }, () => { throw constructionFailure; }]) as LocalRuntime;

    await expect(runtime.start()).rejects.toMatchObject({
      failure: { error: { code: "internal_error" } },
    });
    await runtime.stop();
    expect(databaseCloses).toBe(1);
    await expect(runtime.start()).rejects.toMatchObject({
      failure: { error: { code: "state_conflict" } },
    });
  });

  it("hands typed outputs forward and closes dependency stages in reverse order", async () => {
    const routes = await baseRoutes();
    const signal = new AbortController().signal;
    const events: string[] = [];
    const ports = capabilityPorts();
    const support = {
      wallet: extendWalletSupportManifest(initialRuntimeSupportManifest),
      chain: extendChainSupportManifest(initialRuntimeSupportManifest),
    };
    const activeWallet = testActiveWallet();
    const walletOperations = testWalletOperations();
    const walletRoutes = routes.extend([route("/api/v1/internal/control/wallet")]);
    const chainRoutes = walletRoutes.extend([route("/api/v1/internal/control/chain")]);
    const catalogRoutes = chainRoutes;
    const accountAssetRoutes = catalogRoutes.extend([route("/api/v1/internal/control/account-assets")]);
    const tradeHistoryRoutes = accountAssetRoutes.extend([route("/api/v1/internal/control/stock-token-trade-history")]);
    const interfaceRoutes = tradeHistoryRoutes.extend([route("/api/v1/internal/control/interfaces")]);
    const application = await composeStages(ownerContext(routes, signal), {
wallet: () => ({
        routes: walletRoutes,
        supportManifest: support.wallet,
        walletConnection: ports.wallet,
        activeWallet,
        walletOperations, walletRequests: testWalletRequests,
        shutdown: async () => runtimeReleased,
        close: () => { events.push("wallet:close"); },
      }),
chain: (_context, wallet) => {
        expect(wallet.walletConnection.connection).toBe(ports.wallet.connection);
        expect(wallet.activeWallet).toBe(activeWallet);
        expect("walletOperations" in wallet).toBe(false);
        return {
          routes: chainRoutes,
          supportManifest: support.chain,
          invocations: testChainInvocations,
          chainReads: ports.chain,
          tokenInspection: testTokenInspection(),
          tokenAdditionReads: testTokenAdditionReads,
          officialAssetReads: testOfficialAssetReads,
          addressTargets: testAddressTargets,
          accountAssetReads: testAccountAssetReads,
          currentBlockReads: testCurrentBlockReads,
          protocolReads: testPinnedEvmReads, transactions: testTransactionReads,
          close: () => { events.push("chain:close"); },
        };
      },
protocols: createTestProtocolStage(() => { events.push("protocols:close"); }),
tokenCatalog: createTestTokenCatalogStage(() => { events.push("catalog:close"); }),
accountAssets: ({ supportBase }, chain, _catalog, _registry) => {
        expect(chain.addressTargets).toBe(testAddressTargets);
        return {
          routes: accountAssetRoutes,
          supportManifest: extendAccountAssetSupportManifest(supportBase),
          list: testAccountAssets.list,
          close: async () => { events.push("account-assets:close"); },
        };
      },
tradeHistory: ({ supportBase }, _chain, _registry) => ({
        routes: tradeHistoryRoutes,
        supportManifest: extendStockTokenTradeHistorySupportManifest(supportBase),
        ...testTradeHistory,
        close: async () => { events.push("trade-history:close"); },
      }),
prices: ({ routes, supportBase }) => ({
        routes,
        supportManifest: extendStockTokenPriceSupportManifest(supportBase),
        ...priceInterfaceBindings(),
        close: async () => { events.push("prices:close"); },
      }),
review: createTestReviewStage(() => { events.push("review:close"); }),
interfaces: (
        _context,
        wallet,
        chain,
        protocols,
        catalog,
        accountAssets,
        tradeHistory,
        prices,
        supportManifest,
        operations,
      ) => {
        expect(wallet.walletConnection.connection).toBe(ports.wallet.connection);
        expect(chain.chainReads.chainStatus).toBe(ports.chain.chainStatus);
        expect(chain.tokenInspection).toBeDefined();
        expect(chain.invocations).toBe(testChainInvocations);
        expect(chain.tokenAdditionReads).toBe(testTokenAdditionReads);
        expect(protocols.uniswapV2Quote).toBeDefined();
        expect(Reflect.ownKeys(catalog).sort()).toEqual([
          "supportManifest",
          "accountTokenSelectionStore",
          "tokenCatalogManagement",
          "tokenCatalogQueries",
        ].sort());
        expect(Reflect.ownKeys(catalog.tokenCatalogQueries).sort())
          .toEqual(["getSelection", "listSelections"]);
        expect(Reflect.ownKeys(catalog.tokenCatalogManagement).sort())
          .toEqual(["decide", "getOperation", "review"]);
        expect(operations).toBe(walletOperations);
        expect(operations.readOperation()).toBe("test-operation");
        expect(Reflect.ownKeys(accountAssets.accountAssets).sort())
          .toEqual(["list"]);
        expect(Reflect.ownKeys(tradeHistory.tradeHistory).sort())
          .toEqual(["binding"]);
        return {
          routes: interfaceRoutes,
          supportManifest: extendInterfaceSupportManifest(supportManifest),
          close: () => { events.push("interfaces:close"); },
        };
      },
registry: createTestRegistryStage(() => { events.push("registry:close"); })
});
    try {
      expect(application.routes).toBe(interfaceRoutes);
      const document = await readFile("docs/PRODUCT_POLICY.md", "utf8");
      expect(() => verifyCurrentSupportDocument(document, application.supportManifest)).not.toThrow();
    } finally {
      await application.close();
    }
    expect(events).toEqual([
      "interfaces:close", "review:close", "prices:close", "trade-history:close", "account-assets:close", "protocols:close",
      "catalog:close", "registry:close", "chain:close", "wallet:close",
    ]);
  });

  it("keeps the first shutdown failure terminal instead of reviving dependent stages", async () => {
    const routes = await baseRoutes();
    const ports = capabilityPorts();
    const support = manifests();
    const events: string[] = [];
    const failure = new Error("interface close failed");
    let interfaceCloseCalls = 0;
    let reentered: Promise<RuntimeShutdownOutcome> | undefined;
    const application = await composeStages(
      ownerContext(routes, new AbortController().signal),
      {
wallet: () => ({
          routes,
          supportManifest: support.wallet,
          walletConnection: ports.wallet,
          activeWallet: testActiveWallet(),
          walletOperations: testWalletOperations(), walletRequests: testWalletRequests,
          shutdown: async () => runtimeReleased,
          close: () => { events.push("wallet:close"); },
        }),
chain: () => ({
          routes,
          supportManifest: support.chain,
          invocations: testChainInvocations,
          chainReads: ports.chain,
          tokenInspection: testTokenInspection(),
          tokenAdditionReads: testTokenAdditionReads,
          officialAssetReads: testOfficialAssetReads,
          addressTargets: testAddressTargets,
          accountAssetReads: testAccountAssetReads,
          currentBlockReads: testCurrentBlockReads,
          protocolReads: testPinnedEvmReads, transactions: testTransactionReads,
          close: () => { events.push("chain:close"); },
        }),
protocols: createTestProtocolStage(() => { events.push("protocols:close"); }),
tokenCatalog: createTestTokenCatalogStage(() => { events.push("catalog:close"); }),
accountAssets: createTestAccountAssetStage(() => { events.push("account-assets:close"); }),
tradeHistory: createTestTradeHistoryStage(() => { events.push("trade-history:close"); }),
prices: createTestPriceStage(() => { events.push("prices:close"); }),
review: createTestReviewStage(() => { events.push("review:close"); }),
interfaces: (
          _context,
          _wallet,
          _chain,
          _protocols,
          _catalog,
          _accountAssets,
          _tradeHistory,
          prices,
          supportManifest,
        ) => ({
          routes,
          supportManifest: extendTestInterfaceSupportManifest(supportManifest),
          close: () => {
            events.push("interfaces:close");
            interfaceCloseCalls += 1;
            if (interfaceCloseCalls === 1) reentered = application.shutdown();
            if (interfaceCloseCalls === 1) throw failure;
          },
        }),
registry: createTestRegistryStage(() => { events.push("registry:close"); })
},
    );

    const first = application.shutdown();
    await expect(first).rejects.toBe(failure);
    expect(reentered).toBe(first);
    expect(events).toEqual(["interfaces:close"]);
    events.length = 0;
    expect(application.shutdown()).toBe(first);
    await expect(application.shutdown()).rejects.toBe(failure);
    expect(events).toEqual([]);
  });

  it("closes the invalid scoped child and completed dependencies", async () => {
    const routes = await baseRoutes();
    const signal = new AbortController().signal;
    const events: string[] = [];
    const ports = capabilityPorts();
    const support = manifests();
    const walletRoutes = routes.extend([route("/api/v1/internal/control/wallet")]);
    const chainRoutes = walletRoutes.extend([route("/api/v1/internal/control/chain")]);
    const siblingWallet = extendWalletRuntimeSupportManifest(initialRuntimeSupportManifest, {
      registrations: [],
      changes: [{
        capabilityId: "wallet.connection",
        availability: {
          overall: "internal", direct: "internal", http: "unavailable",
          mcp: "unavailable", cli: "unavailable",
        },
      }],
    });
    const wrongChain = extendChainRuntimeSupportManifest(siblingWallet, {
      registrations: [],
      changes: ["account.balance", "address.inspect", "chain.status", "transaction.inspect"].map((capabilityId) => ({
        capabilityId,
        availability: {
          overall: "internal", direct: "internal", http: "unavailable",
          mcp: "unavailable", cli: "unavailable",
        },
      })),
    });
    await expect(composeStages(ownerContext(routes, signal), {
wallet: () => ({
        routes: walletRoutes,
        supportManifest: support.wallet,
        walletConnection: ports.wallet,
        activeWallet: testActiveWallet(),
        walletOperations: testWalletOperations(), walletRequests: testWalletRequests,
        shutdown: async () => runtimeReleased,
        close: () => { events.push("wallet:close"); },
      }),
chain: () => ({
        routes: chainRoutes,
        supportManifest: wrongChain,
        invocations: testChainInvocations,
        chainReads: ports.chain,
        tokenInspection: testTokenInspection(),
        tokenAdditionReads: testTokenAdditionReads,
        officialAssetReads: testOfficialAssetReads,
        addressTargets: testAddressTargets,
        accountAssetReads: testAccountAssetReads,
        currentBlockReads: testCurrentBlockReads,
        protocolReads: testPinnedEvmReads, transactions: testTransactionReads,
        close: () => { events.push("chain:close"); },
      }),
protocols: createTestProtocolStage(),
tokenCatalog: createTestTokenCatalogStage(),
accountAssets: createTestAccountAssetStage(),
tradeHistory: createTestTradeHistoryStage(),
prices: createTestPriceStage(),
review: createTestReviewStage(),
registry: createTestRegistryStage()
})).rejects.toThrow("scope lineage");
    expect(events).toEqual(["chain:close", "wallet:close"]);
  });

  it("closes a partial dependent stage before completed dependency stages", async () => {
    const routes = await baseRoutes();
    const ports = capabilityPorts();
    const support = manifests();
    const outer = createResourceOwnershipScope();
    const events: string[] = [];
    let partialCloseCalls = 0;
    const stageFailure = new Error("chain stage failed");
    const composition = composeStages({
      routes,
      signal: new AbortController().signal,
      startupResources: outer.resources,
    }, {
wallet: () => ({
        routes,
        supportManifest: support.wallet,
        walletConnection: ports.wallet,
        activeWallet: testActiveWallet(),
        walletOperations: testWalletOperations(), walletRequests: testWalletRequests,
        shutdown: async () => runtimeReleased,
        close: () => { events.push("wallet:close"); },
      }),
chain: ({ startupResources }) => {
        startupResources.register({
          close(): void {
            events.push("partial-chain:close");
            partialCloseCalls += 1;
            if (partialCloseCalls === 1) throw new Error("partial cleanup failed");
          },
        });
        throw stageFailure;
      },
protocols: createTestProtocolStage(),
tokenCatalog: createTestTokenCatalogStage(),
accountAssets: createTestAccountAssetStage(),
tradeHistory: createTestTradeHistoryStage(),
prices: createTestPriceStage(),
review: createTestReviewStage(),
registry: createTestRegistryStage()
});

    let failure: unknown;
    try { await composition; }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      stageFailure,
      expect.objectContaining({ message: "partial cleanup failed" }),
    ]);
    expect(events).toEqual(["partial-chain:close"]);
    outer.seal();
    await outer.close();
    expect(events).toEqual([
      "partial-chain:close",
      "partial-chain:close",
      "wallet:close",
    ]);
  });

  it("rejects a completed stage that retains startup ownership and closes it before dependencies", async () => {
    const routes = await baseRoutes();
    const ports = capabilityPorts();
    const support = manifests();
    const events: string[] = [];

    await expect(composeStages(ownerContext(routes, new AbortController().signal), {
wallet: () => ({
        routes,
        supportManifest: support.wallet,
        walletConnection: ports.wallet,
        activeWallet: testActiveWallet(),
        walletOperations: testWalletOperations(), walletRequests: testWalletRequests,
        shutdown: async () => runtimeReleased,
        close: () => { events.push("wallet:close"); },
      }),
chain: ({ startupResources }) => {
        startupResources.register({ close(): void { events.push("partial-chain:close"); } });
        return {
          routes,
          supportManifest: support.chain,
          invocations: testChainInvocations,
          chainReads: ports.chain,
          tokenInspection: testTokenInspection(),
          tokenAdditionReads: testTokenAdditionReads,
          officialAssetReads: testOfficialAssetReads,
          addressTargets: testAddressTargets,
          accountAssetReads: testAccountAssetReads,
          currentBlockReads: testCurrentBlockReads,
          protocolReads: testPinnedEvmReads, transactions: testTransactionReads,
          close: () => { events.push("chain:close"); },
        };
      },
protocols: createTestProtocolStage(),
tokenCatalog: createTestTokenCatalogStage(),
accountAssets: createTestAccountAssetStage(),
tradeHistory: createTestTradeHistoryStage(),
prices: createTestPriceStage(),
review: createTestReviewStage(),
registry: createTestRegistryStage()
})).rejects.toThrow("retained startup resources");
    expect(events).toEqual(["chain:close", "partial-chain:close", "wallet:close"]);
  });

  it("does not close a stage application twice when its factory pre-registers it", async () => {
    const routes = await baseRoutes();
    const ports = capabilityPorts();
    const support = manifests();
    const events: string[] = [];

    await expect(composeStages(ownerContext(routes, new AbortController().signal), {
wallet: () => ({
        routes,
        supportManifest: support.wallet,
        walletConnection: ports.wallet,
        activeWallet: testActiveWallet(),
        walletOperations: testWalletOperations(), walletRequests: testWalletRequests,
        shutdown: async () => runtimeReleased,
        close: () => { events.push("wallet:close"); },
      }),
chain: ({ startupResources }) => {
        const application = {
          routes,
          supportManifest: support.chain,
          invocations: testChainInvocations,
          chainReads: ports.chain,
          tokenInspection: bindForHarness(
            tokenInspectCapability,
            createCapabilityHarness(),
            async () => ({ status: "failure", code: "internal_error", issues: [] }),
            tokenCatalogErrorRegistry,
          ),
          tokenAdditionReads: testTokenAdditionReads,
          officialAssetReads: testOfficialAssetReads,
          addressTargets: testAddressTargets,
          accountAssetReads: testAccountAssetReads,
          currentBlockReads: testCurrentBlockReads,
          protocolReads: testPinnedEvmReads, transactions: testTransactionReads,
          close: () => { events.push("chain:close"); },
        };
        startupResources.register(application);
        return application;
      },
protocols: createTestProtocolStage(),
tokenCatalog: createTestTokenCatalogStage(),
accountAssets: createTestAccountAssetStage(),
tradeHistory: createTestTradeHistoryStage(),
prices: createTestPriceStage(),
review: createTestReviewStage(),
registry: createTestRegistryStage()
})).rejects.toThrow("already registered");
    expect(events).toEqual(["chain:close", "wallet:close"]);
  });

  it("rejects a manifest that omits its typed capability output", async () => {
    const routes = await baseRoutes();
    const ports = capabilityPorts();
    const wrongWallet = extendWalletRuntimeSupportManifest(initialRuntimeSupportManifest, {
      registrations: [{
        capabilityId: "wallet.connect",
        availability: {
          overall: "internal", direct: "internal", http: "unavailable",
          mcp: "unavailable", cli: "unavailable",
        },
      }],
      changes: [],
    });
    let closed = false;
    await expect(composeStages(ownerContext(routes, new AbortController().signal), {
wallet: () => ({
        routes,
        supportManifest: wrongWallet,
        walletConnection: ports.wallet,
        activeWallet: testActiveWallet(),
        walletOperations: testWalletOperations(), walletRequests: testWalletRequests,
        shutdown: async () => runtimeReleased,
        close: () => { closed = true; },
      })
})).rejects.toThrow("absent from its support manifest");
    expect(closed).toBe(true);
  });

  it("rejects a binding placed under a different capability port", async () => {
    const routes = await baseRoutes();
    const ports = capabilityPorts();
    const support = manifests();
    let closed = false;
    await expect(composeStages(ownerContext(routes, new AbortController().signal), {
wallet: () => ({
        routes,
        supportManifest: support.wallet,
        walletConnection: { connection: ports.chain.chainStatus as never },
        activeWallet: testActiveWallet(),
        walletOperations: testWalletOperations(), walletRequests: testWalletRequests,
        shutdown: async () => runtimeReleased,
        close: () => { closed = true; },
      })
})).rejects.toThrow("provenance");
    expect(closed).toBe(true);
  });

  it("stops before the next stage and closes the completed stage after lifecycle abort", async () => {
    const routes = await baseRoutes();
    const lifecycle = new AbortController();
    const events: string[] = [];
    const ports = capabilityPorts();
    const support = manifests();
    let failure: unknown;
    try {
      await composeStages(ownerContext(routes, lifecycle.signal), {
wallet: () => {
          lifecycle.abort();
          return {
            routes,
            supportManifest: support.wallet,
            walletConnection: ports.wallet,
            activeWallet: testActiveWallet(),
            walletOperations: testWalletOperations(), walletRequests: testWalletRequests,
            shutdown: async () => runtimeReleased,
            close: () => { events.push("wallet:close"); },
          };
        },
chain: () => {
          events.push("chain:start");
          return {
            routes,
            supportManifest: support.chain,
            invocations: testChainInvocations,
            chainReads: ports.chain,
            tokenInspection: testTokenInspection(),
            tokenAdditionReads: testTokenAdditionReads,
            officialAssetReads: testOfficialAssetReads,
            addressTargets: testAddressTargets,
            accountAssetReads: testAccountAssetReads,
            currentBlockReads: testCurrentBlockReads,
            protocolReads: testPinnedEvmReads, transactions: testTransactionReads,
            close: () => undefined,
          };
        },
protocols: createTestProtocolStage(),
tokenCatalog: createTestTokenCatalogStage(),
accountAssets: createTestAccountAssetStage(),
tradeHistory: createTestTradeHistoryStage(),
prices: createTestPriceStage(),
review: createTestReviewStage(),
registry: createTestRegistryStage()
});
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(RuntimeOperationError);
    expect((failure as RuntimeOperationError).failure.error.code).toBe("request_aborted");
    expect(events).toEqual(["wallet:close"]);
  });

  it("rejects an absent or primitive wallet operation port before starting a dependent stage", async () => {
    const routes = await baseRoutes();
    const ports = capabilityPorts();
    const support = manifests();
    for (const invalid of [undefined, null, "operation", 1]) {
      const events: string[] = [];
      await expect(composeStages(ownerContext(routes, new AbortController().signal), {
wallet: () => ({
          routes,
          supportManifest: support.wallet,
          walletConnection: ports.wallet,
          activeWallet: testActiveWallet(),
          walletOperations: invalid as never, walletRequests: testWalletRequests,
          shutdown: async () => runtimeReleased,
          close: () => { events.push("wallet:close"); },
        }),
chain: () => {
          events.push("chain:start");
          return {
            routes,
            supportManifest: support.chain,
            invocations: testChainInvocations,
            chainReads: ports.chain,
            tokenInspection: testTokenInspection(),
            tokenAdditionReads: testTokenAdditionReads,
            officialAssetReads: testOfficialAssetReads,
            addressTargets: testAddressTargets,
            accountAssetReads: testAccountAssetReads,
            currentBlockReads: testCurrentBlockReads,
            protocolReads: testPinnedEvmReads, transactions: testTransactionReads,
            close: () => undefined,
          };
        },
protocols: createTestProtocolStage(),
tokenCatalog: createTestTokenCatalogStage(),
accountAssets: createTestAccountAssetStage(),
tradeHistory: createTestTradeHistoryStage(),
prices: createTestPriceStage(),
review: createTestReviewStage(),
registry: createTestRegistryStage()
})).rejects.toThrow("Wallet operation port must be a reference value");
      expect(events).toEqual(["wallet:close"]);
    }
  });

  it("rejects an absent or primitive active-wallet port before starting a dependent stage", async () => {
    const routes = await baseRoutes();
    const ports = capabilityPorts();
    const support = manifests();
    for (const invalid of [undefined, null, "wallet", 1]) {
      const events: string[] = [];
      await expect(composeStages(ownerContext(routes, new AbortController().signal), {
wallet: () => ({
          routes,
          supportManifest: support.wallet,
          walletConnection: ports.wallet,
          activeWallet: invalid as never,
          walletOperations: testWalletOperations(), walletRequests: testWalletRequests,
          shutdown: async () => runtimeReleased,
          close: () => { events.push("wallet:close"); },
        }),
chain: () => {
          events.push("chain:start");
          return {
            routes,
            supportManifest: support.chain,
            invocations: testChainInvocations,
            chainReads: ports.chain,
            tokenInspection: testTokenInspection(),
            tokenAdditionReads: testTokenAdditionReads,
            officialAssetReads: testOfficialAssetReads,
            addressTargets: testAddressTargets,
            accountAssetReads: testAccountAssetReads,
            currentBlockReads: testCurrentBlockReads,
            protocolReads: testPinnedEvmReads, transactions: testTransactionReads,
            close: () => undefined,
          };
        },
protocols: createTestProtocolStage(),
tokenCatalog: createTestTokenCatalogStage(),
accountAssets: createTestAccountAssetStage(),
tradeHistory: createTestTradeHistoryStage(),
prices: createTestPriceStage(),
review: createTestReviewStage(),
registry: createTestRegistryStage()
})).rejects.toThrow("Active wallet read port must be a reference value");
      expect(events).toEqual(["wallet:close"]);
    }
  });
});

const createTestRegistryStage = (close: () => void = () => undefined): RegistryOwnerApplicationStage => ({ routes }) => ({ routes,
  officialAssets: { synchronize: async () => unavailableOperation(), readStored: () => undefined, close: async () => undefined },
  close: async () => { close(); } });
