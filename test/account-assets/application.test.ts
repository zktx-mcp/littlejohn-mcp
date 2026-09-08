import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createAccountAssetApplication } from "../../src/account-assets/application.js";
import { createAccountAssetApplicationFactory } from "../../src/account-assets/application-factory.js";
import { AccountAssetOperationError } from "../../src/account-assets/errors.js";
import { accountAssetControlRoutes } from "../../src/account-assets/http-contract.js";
import type { AccountAssetReadProcessDependencies } from "../../src/account-assets/ports.js";
import {
  chainAnchorSchema,
  createCanonicalClock,
  parseCapabilityDataAt,
  parseEvmAddressInput,
  parseEvmChainId,
  parseHash32,
  parseUtcTimestamp,
  parseUnsignedDecimal,
  walletConnectionCapability,
  type EvmAddress,
} from "../../src/core/index.js";
import {
  createChainInvocationLifecycle,
  createAddressTargetResolver,
  extendChainSupportManifest,
  readConfiguredCanonicalBlock,
  resolveConfiguredCanonicalBlock,
  type AccountAssetChainReadPort,
  type CanonicalBlock,
  type ChainInvocationContext,
  type CurrentBlockReadPort,
  type OfficialAssetChainReadPort,
} from "../../src/chain/index.js";
import { ChainOperationError } from "../../src/chain/errors.js";
import {
  assertCommittedOfficialAssetSnapshot,
  committedOfficialAssetSnapshotSchema,
  defaultStockTokenManifest,
  officialAssetSourceDefinition,
  officialAssetSnapshotRevisionSchema,
  stockFactoryAdmissionManifest,
  type CommittedOfficialAssetSnapshot,
  type OfficialAssetSourceMember,
  type StockFactoryVerificationResult,
} from "../../src/registry/index.js";
import {
  officialAssetCandidateListDigest,
  officialAssetMemberSetDigest,
} from "../../src/registry/official-asset-contract.js";
import {
  createControlCredentialVerifier,
  loadOrCreateControlCredential,
} from "../../src/runtime/control-credential.js";
import { readRuntimeConfiguration } from "../../src/runtime/configuration.js";
import { createRuntimeRouteRegistry } from "../../src/runtime/http-routing.js";
import { runtimePaths } from "../../src/runtime/paths.js";
import { createResourceOwnershipScope } from "../../src/runtime/resource-ownership.js";
import { createInitialRuntimeSupportManifest } from "../../src/runtime/support-manifest.js";
import {
  extendTokenCatalogSupportManifest,
} from "../../src/token-catalog/support.js";
import {
  tokenSelectionDetailSchema,
  tokenSelectionSetRevisionSchema,
  type AccountTokenSelectionStore,
  type TokenSelectionDetail,
  type TokenSelectionState,
} from "../../src/token-catalog/index.js";
import { tokenCatalogInterfaceErrorMappings } from "../../src/token-catalog/errors.js";
import { extendWalletSupportManifest } from "../../src/wallet/application.js";

const chainId = parseEvmChainId("eip155:4663");
const accountAddress = parseEvmAddressInput(`0x${"34".repeat(20)}`);
const customAddress = parseEvmAddressInput(`0x${"88".repeat(20)}`);
const candidateAddress = parseEvmAddressInput(`0x${"99".repeat(20)}`);
const at = parseUtcTimestamp("2026-07-21T00:00:00.000Z");
const block = chainAnchorSchema.parse({
  chainId,
  blockNumber: "42",
  blockHash: `0x${"ab".repeat(32)}`,
  blockTimestamp: at,
});
const laterBlock = chainAnchorSchema.parse({
  chainId,
  blockNumber: "43",
  blockHash: `0x${"bc".repeat(32)}`,
  blockTimestamp: "2026-07-21T00:00:01.000Z",
});
const issueBlock = (
  anchor: typeof block,
  context: ChainInvocationContext,
): Promise<CanonicalBlock> => resolveConfiguredCanonicalBlock({
  rpc: {
    async request(method) {
      if (method === "eth_chainId") return "0x1237";
      if (method === "eth_getBlockByNumber") {
        return {
          number: `0x${BigInt(anchor.blockNumber).toString(16)}`,
          hash: anchor.blockHash,
          timestamp: `0x${BigInt(Math.floor(Date.parse(anchor.blockTimestamp) / 1_000)).toString(16)}`,
        };
      }
      throw new Error(`Unexpected canonical-block fixture method: ${method}`);
    },
  },
  chainId,
  selector: { kind: "latest" },
  context,
});
const snapshotRevision = officialAssetSnapshotRevisionSchema.parse(
  Buffer.alloc(16, 7).toString("base64url"),
);
const selectionSetRevision = tokenSelectionSetRevisionSchema.parse(
  Buffer.alloc(16, 8).toString("base64url"),
);
const account = Object.freeze({ chainId, address: accountAddress });
const activeTarget = Object.freeze({ kind: "active_wallet" as const });
const testDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(testDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const pendingUntilAbort = (signal: AbortSignal): Promise<never> =>
  new Promise((_resolve, reject) => {
    const abort = (): void => reject(new DOMException("Aborted.", "AbortError"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });

const member = (address: EvmAddress, byte: string, symbol: string) => Object.freeze({
  assetUid: parseHash32(`0x${byte.repeat(32)}`),
  contractAddress: address,
  sourceName: `${symbol} Stock Token`,
  sourceSymbol: symbol,
});
const defaultMember = member(defaultStockTokenManifest.assets[0]!.contractAddress, "11", "AAPL");
const unselectedMember = member(candidateAddress, "22", "NEXT");
const snapshot = committedOfficialAssetSnapshotSchema.parse({
  sourceUri: officialAssetSourceDefinition.sourceUri,
  sourceObservedAt: at,
  rawResponseDigest: parseHash32(`0x${"33".repeat(32)}`),
  memberSetDigest: officialAssetMemberSetDigest([defaultMember, unselectedMember]),
  candidateListDigest: officialAssetCandidateListDigest([defaultMember, unselectedMember]),
  chainId,
  members: [defaultMember, unselectedMember],
  revision: snapshotRevision,
  updatedAt: at,
});

const officialSnapshotWithMembers = (
  members: readonly OfficialAssetSourceMember[],
): CommittedOfficialAssetSnapshot => assertCommittedOfficialAssetSnapshot({
  sourceUri: officialAssetSourceDefinition.sourceUri,
  sourceObservedAt: at,
  rawResponseDigest: parseHash32(`0x${"33".repeat(32)}`),
  memberSetDigest: officialAssetMemberSetDigest(members),
  candidateListDigest: officialAssetCandidateListDigest(members),
  chainId,
  members: [...members],
  revision: snapshotRevision,
  updatedAt: at,
});

const detail = (address: EvmAddress, byte: number, included = true): TokenSelectionDetail =>
  tokenSelectionDetailSchema.parse({
    selection: {
      account,
      asset: { kind: "erc20", chainId, address },
      included,
      revision: Buffer.alloc(16, byte).toString("base64url"),
      createdAt: at,
      updatedAt: at,
    },
    historicalInspection: null,
  });

const requiredObservation = (address: EvmAddress, observationBlock = block) => Object.freeze({
  asset: { kind: "erc20" as const, chainId, address },
  block: observationBlock,
  erc165: { standardId: "erc165" as const, status: "not_supported" as const },
  erc8056: { standardId: "erc8056" as const, status: "unknown" as const },
  pendingMultiplier: {
    standardId: "erc8056_pending_multiplier" as const,
    status: "unknown" as const,
  },
});

type OfficialSourceFailureCode =
  | "official_asset_response_too_large"
  | "official_asset_response_unavailable"
  | "rate_limited"
  | "source_inconsistent"
  | "source_unavailable";

const fixture = (options: Readonly<{
  sourceAvailable?: boolean;
  sourceFailureCode?: OfficialSourceFailureCode;
  retained?: boolean;
  defaultsInitialized?: boolean;
  defaultVerificationUnavailable?: boolean;
  verificationFailureCode?: "runtime_busy" | "runtime_state_unavailable";
  selectionEntries?: readonly TokenSelectionDetail[];
  blocks?: readonly [typeof block, ...(typeof block)[]];
  afterVerification?: (signal: AbortSignal) => void | Promise<void>;
  transformVerificationResults?: (
    members: readonly OfficialAssetSourceMember[],
    results: readonly StockFactoryVerificationResult[],
  ) => readonly StockFactoryVerificationResult[];
  beforeCollectionReturn?: (signal: AbortSignal) => void | Promise<void>;
  beforeOfficialSynchronizeReturn?: (signal: AbortSignal) => void | Promise<void>;
  onInitialize?: () => void;
}> = {}) => {
  let sourceAvailable = options.sourceAvailable ?? true;
  let sourceFailureCode = options.sourceFailureCode ?? "source_unavailable";
  const entries = options.selectionEntries === undefined
    ? [detail(defaultMember.contractAddress, 1), detail(customAddress, 2)]
    : [...options.selectionEntries];
  let state: TokenSelectionState = {
    account,
    revision: selectionSetRevision,
    defaultsInitialized: options.defaultsInitialized ?? true,
    createdAt: at,
    updatedAt: at,
  };
  let initializationCalls = 0;
  let walletCaptures = 0;
  let sessionSourceId = "wallet-session:test";
  let officialSnapshot: CommittedOfficialAssetSnapshot = snapshot;
  let blockIndex = 0;
  let afterVerification = options.afterVerification;
  let beforeCollectionReturn = options.beforeCollectionReturn;
  const beforeOfficialSynchronizeReturn = options.beforeOfficialSynchronizeReturn;
  const selections: AccountTokenSelectionStore = Object.freeze({
    isAccountRetained: (requested: Parameters<AccountTokenSelectionStore["isAccountRetained"]>[0]) =>
      (options.retained ?? true) &&
      requested.chainId === account.chainId && requested.address === account.address,
    getState: () => options.retained === false ? undefined : state,
    getForAccount: ({ account: requested, asset }: Parameters<AccountTokenSelectionStore["getForAccount"]>[0]) => requested.chainId === account.chainId &&
      requested.address === account.address
      ? entries.find((entry) => entry.selection.asset.address === asset.address)
      : undefined,
    listIncludedForAccount: ({ cursor, limit, excludedAddresses }: Parameters<AccountTokenSelectionStore["listIncludedForAccount"]>[0]) => {
      const matching = entries.map((entry) => entry.selection)
        .filter((entry) => entry.included && !excludedAddresses.includes(entry.asset.address) &&
          (cursor === null || entry.asset.address > cursor))
        .sort((left, right) => left.asset.address.localeCompare(right.asset.address));
      const page = matching.slice(0, limit);
      return Object.freeze({
        selections: Object.freeze(page),
        nextCursor: matching.length > limit ? page.at(-1)!.asset.address : null,
      });
    },
    initializeDefaults: (
      input: Parameters<AccountTokenSelectionStore["initializeDefaults"]>[0],
    ) => {
      initializationCalls += 1;
      options.onInitialize?.();
      if (state.defaultsInitialized) {
        throw new Error("Initialized state must not be seeded again.");
      }
      const initialized = input.verifiedDefaults.map((item, index) =>
        detail(item.asset.address, 20 + index));
      entries.push(...initialized);
      state = {
        ...state,
        revision: tokenSelectionSetRevisionSchema.parse(
          Buffer.alloc(16, 20).toString("base64url"),
        ),
        defaultsInitialized: true,
        updatedAt: input.now,
      };
      return Object.freeze({
        state,
        selections: Object.freeze(initialized.map((entry) => entry.selection)),
      });
    },
  });
  const currentConnection = parseCapabilityDataAt(walletConnectionCapability, {
    status: "connected",
    chainId,
    address: accountAddress,
    approvedMethods: ["eth_sendTransaction"],
    approvedEvents: ["accountsChanged", "chainChanged"],
    expiresAt: "2026-07-22T00:00:00.000Z",
  }, at);
  const verificationFor = (
    assetUid: ReturnType<typeof parseHash32>,
    contractAddress: EvmAddress,
    verificationBlock = block,
  ) => ({
    assetUid,
    contractAddress,
    block: verificationBlock,
    proxyAddress: stockFactoryAdmissionManifest.proxyAddress,
    proxyCodeHash: stockFactoryAdmissionManifest.proxyCodeHash,
    implementationAddress: stockFactoryAdmissionManifest.implementationAddress,
    implementationCodeHash: stockFactoryAdmissionManifest.implementationCodeHash,
    tokenCodeHash: parseHash32(`0x${"ee".repeat(32)}`),
  });
  const owner = new AbortController();
  const lifecycle = createChainInvocationLifecycle(owner.signal);
  const readBlock = (
    canonicalBlock: CanonicalBlock,
    context: ChainInvocationContext,
  ) => {
    lifecycle.assertActiveContext(context);
    return readConfiguredCanonicalBlock({
      block: canonicalBlock,
      context,
      chainId,
    }).anchor;
  };
  const officialAssetReads: OfficialAssetChainReadPort = Object.freeze({
    verifyAtBlock: async (
      entry: Parameters<OfficialAssetChainReadPort["verifyAtBlock"]>[0],
      verificationBlock: Parameters<OfficialAssetChainReadPort["verifyAtBlock"]>[1],
      context: Parameters<OfficialAssetChainReadPort["verifyAtBlock"]>[2],
    ) => Object.freeze({
      status: "verified" as const,
      member: entry,
      verification: verificationFor(
        entry.assetUid,
        entry.contractAddress,
        readBlock(verificationBlock, context),
      ),
    }),
    verifyManyAtBlock: async (
      members: Parameters<OfficialAssetChainReadPort["verifyManyAtBlock"]>[0],
      verificationBlock: Parameters<OfficialAssetChainReadPort["verifyManyAtBlock"]>[1],
      context: Parameters<OfficialAssetChainReadPort["verifyManyAtBlock"]>[2],
    ) => {
      const verificationAnchor = readBlock(verificationBlock, context);
      if (options.verificationFailureCode !== undefined) {
        throw new ChainOperationError(options.verificationFailureCode);
      }
      const results: readonly StockFactoryVerificationResult[] = Object.freeze(members.map((entry) =>
        options.defaultVerificationUnavailable === true &&
          entry.contractAddress === defaultMember.contractAddress
          ? Object.freeze({
              status: "unavailable" as const,
              member: entry,
              reason: "source_unavailable" as const,
            })
          : Object.freeze({
              status: "verified" as const,
              member: entry,
              verification: verificationFor(entry.assetUid, entry.contractAddress, verificationAnchor),
            })));
      await afterVerification?.(context.signal);
      return options.transformVerificationResults?.(members, results) ?? results;
    },
  });
  const currentBlockReads: CurrentBlockReadPort = Object.freeze({
    resolveCurrentBlock: async (
      context: Parameters<CurrentBlockReadPort["resolveCurrentBlock"]>[0],
    ) => {
      lifecycle.assertActiveContext(context);
      return issueBlock(options.blocks?.[blockIndex++] ?? block, context);
    },
  });
  const chainReads: AccountAssetChainReadPort = Object.freeze({
    readCollectionAtBlock: async (
      { account: requested, assets, block: requestedBlock }: Parameters<AccountAssetChainReadPort["readCollectionAtBlock"]>[0],
      context: Parameters<AccountAssetChainReadPort["readCollectionAtBlock"]>[1],
    ) => {
      const requestedAnchor = readBlock(requestedBlock, context);
      const result = Object.freeze({
        account: requested,
        block: requestedAnchor,
        nativeRawBalance: parseUnsignedDecimal("7"),
        tokens: Object.freeze(assets.map((asset, index) => Object.freeze({
        asset,
        name: { status: "available" as const, value: index === 0 ? "Apple" : "Custom" },
        symbol: { status: "available" as const, value: index === 0 ? "AAPL" : "CSTM" },
        decimals: parseUnsignedDecimal("18"),
        rawBalance: parseUnsignedDecimal(String(index + 1)),
        requiredStandards: requiredObservation(asset.address, requestedAnchor),
        }))),
      });
      await beforeCollectionReturn?.(context.signal);
      return result;
    },
  });
  const activeWallet = Object.freeze({
    capture: () => {
      walletCaptures += 1;
      return Object.freeze({
        connection: currentConnection,
        connectionRevision: parseUnsignedDecimal("1"),
        sessionSource: { sourceId: sessionSourceId } as never,
      });
    },
  });
  const dependencies = Object.freeze({
    addressTargets: createAddressTargetResolver({ chainId, activeWallet }),
    selections,
    officialAssets: Object.freeze({
      synchronize: async (signal: AbortSignal) => {
        await beforeOfficialSynchronizeReturn?.(signal);
        return sourceAvailable
          ? Object.freeze({ status: "current" as const, snapshot: officialSnapshot })
          : Object.freeze({
              status: "unavailable" as const,
              storedRevision: officialSnapshot.revision,
              reason: sourceFailureCode,
            });
      },
      readStored: () => officialSnapshot,
      close: async () => undefined,
    }),
    chainInvocations: lifecycle,
    officialAssetReads,
    currentBlockReads,
    chainReads,
    clock: createCanonicalClock(() => at),
    signal: owner.signal,
  }) satisfies AccountAssetReadProcessDependencies;
  const application = createAccountAssetApplication(dependencies);
  return {
    application,
    dependencies,
    async close() {
      await application.close();
      await lifecycle.close();
    },
    get state() { return state; },
    get walletCaptures() { return walletCaptures; },
    setState(next: TokenSelectionState) { state = next; },
    get initializationCalls() { return initializationCalls; },
    setSessionSourceId(next: string) { sessionSourceId = next; },
    setSourceAvailability(
      available: boolean,
      failureCode: OfficialSourceFailureCode = sourceFailureCode,
    ) {
      sourceAvailable = available;
      sourceFailureCode = failureCode;
    },
    setOfficialSnapshot(next: CommittedOfficialAssetSnapshot) { officialSnapshot = next; },
    setAfterVerification(next: typeof afterVerification) { afterVerification = next; },
    setBeforeCollectionReturn(next: typeof beforeCollectionReturn) { beforeCollectionReturn = next; },
  };
};

const tokenCatalogSupportManifest = extendTokenCatalogSupportManifest(
  extendChainSupportManifest(
    extendWalletSupportManifest(
      createInitialRuntimeSupportManifest(readRuntimeConfiguration({}).chain),
    ),
  ),
);

const accountFactoryRoutes = async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "littlejohn-account-assets-factory-"));
  testDirectories.push(directory);
  const paths = runtimePaths(directory);
  const authority = await loadOrCreateControlCredential(directory, paths.controlCredential);
  return createRuntimeRouteRegistry({
    controlVerifier: createControlCredentialVerifier(authority),
    errorMappings: tokenCatalogInterfaceErrorMappings,
  });
};

const startupOwnerFixture = () => {
  const scope = createResourceOwnershipScope();
  let registrations = 0;
  let registeredResource: Parameters<typeof scope.resources.register>[0] | undefined;
  return {
    scope,
    resources: Object.freeze({
      register(resource: Parameters<typeof scope.resources.register>[0]) {
        registrations += 1;
        registeredResource = resource;
        return scope.resources.register(resource);
      },
    }),
    get registrations() { return registrations; },
    get registeredResource() { return registeredResource; },
  };
};

describe("account asset read process", () => {
  it("reads many unretained explicit accounts without Wallet capture or account-state creation", async () => {
    const test = fixture({ retained: false, defaultsInitialized: false, selectionEntries: [] });
    const addresses = [
      accountAddress,
      ...Array.from({ length: 11 }, (_, index) =>
        parseEvmAddressInput(`0x${(index + 1).toString(16).padStart(40, "0")}`)),
    ];
    for (const address of addresses) {
      const result = await test.application.list({ account: { kind: "address", address } });
      if ("ok" in result) throw new TypeError(result.error.code);
      expect(result.account).toEqual({ chainId, address });
      expect(result.native.rawBalance).toBe("7");
      expect(result.assets).toEqual([]);
      expect(result.viewRevision).toMatchObject({
        account: { chainId, address },
        selectionSetRevision: null,
      });
    }
    expect(test.walletCaptures).toBe(0);
    expect(test.initializationCalls).toBe(0);
    expect(test.state.defaultsInitialized).toBe(false);
    await test.close();
  });

  it("initializes a retained account identically through explicit and active selectors", async () => {
    const explicit = fixture({ defaultsInitialized: false, selectionEntries: [] });
    const explicitResult = await explicit.application.list({
      account: { kind: "address", address: accountAddress },
    });
    if ("ok" in explicitResult) throw new TypeError(explicitResult.error.code);
    expect(explicit.initializationCalls).toBe(1);
    expect(explicit.walletCaptures).toBe(0);
    expect(explicit.state.defaultsInitialized).toBe(true);

    const active = fixture({ defaultsInitialized: false, selectionEntries: [] });
    const activeResult = await active.application.list({ account: activeTarget });
    if ("ok" in activeResult) throw new TypeError(activeResult.error.code);
    expect(active.initializationCalls).toBe(1);
    expect(active.walletCaptures).toBeGreaterThan(0);
    expect(active.state).toEqual(explicit.state);
    expect(activeResult.assets).toEqual(explicitResult.assets);
    await explicit.close();
    await active.close();
  });

  it("does not commit prepared defaults after target, Official, or selection continuity fails", async () => {
    for (const mutate of [
      (test: ReturnType<typeof fixture>) => test.setSessionSourceId("wallet-session:changed"),
      (test: ReturnType<typeof fixture>) => test.setOfficialSnapshot({
        ...snapshot,
        revision: officialAssetSnapshotRevisionSchema.parse(
          Buffer.alloc(16, 21).toString("base64url"),
        ),
      }),
      (test: ReturnType<typeof fixture>) => test.setState({
        ...test.state,
        revision: tokenSelectionSetRevisionSchema.parse(
          Buffer.alloc(16, 21).toString("base64url"),
        ),
      }),
    ]) {
      let test!: ReturnType<typeof fixture>;
      test = fixture({
        defaultsInitialized: false,
        selectionEntries: [],
        beforeCollectionReturn: () => { mutate(test); },
      });
      await expect(test.application.list({ account: activeTarget })).resolves.toMatchObject({
        ok: false,
        error: { code: "state_conflict" },
      });
      expect(test.initializationCalls).toBe(0);
      expect(test.state.defaultsInitialized).toBe(false);
      await test.close();
    }
  });

  it("publishes the exact commit return and prepared page without any post-commit read", async () => {
    // The two page endings exercise default and non-default cursor positions.
    for (const limit of [1, 2]) {
      const existing = [detail(customAddress, 2), detail(candidateAddress, 3)];
      const test = fixture({ defaultsInitialized: false, selectionEntries: existing });
      const store = test.dependencies.selections;
      const commits: ReturnType<AccountTokenSelectionStore["initializeDefaults"]>[] = [];
      let postCommitReads = 0;
      const assertReadable = (): void => {
        if (commits.length === 0) return;
        postCommitReads += 1;
        throw new Error("Storage is unavailable after the successful commit.");
      };
      const selections: AccountTokenSelectionStore = Object.freeze({
        isAccountRetained(account) { assertReadable(); return store.isAccountRetained(account); },
        getState(account) { assertReadable(); return store.getState(account); },
        getForAccount(input) { assertReadable(); return store.getForAccount(input); },
        listIncludedForAccount(input) { assertReadable(); return store.listIncludedForAccount(input); },
        initializeDefaults(input) {
          const committed = store.initializeDefaults(input);
          commits.push(committed);
          return committed;
        },
      } satisfies AccountTokenSelectionStore);
      const application = createAccountAssetApplication({
        ...test.dependencies,
        selections,
        clock: createCanonicalClock(() => { assertReadable(); return at; }),
      });
      try {
        const result = await application.list({
          account: { kind: "address", address: accountAddress }, limit,
        });
        if ("ok" in result) throw new TypeError(result.error.code);
        expect(commits).toHaveLength(1);
        const committed = commits[0]!;
        expect(result.assets.map((entry) => entry.selection)).toEqual([
          ...committed.selections, ...existing.map((entry) => entry.selection),
        ].slice(0, limit));
        expect(result.viewRevision.selectionSetRevision).toBe(committed.state.revision);
        expect(result.nextCursor).toMatchObject({
          group: limit === 1 ? "default" : "other",
          account,
          address: result.assets.at(-1)!.selection.asset.address,
          selectionSetRevision: committed.state.revision,
        });
        expect(postCommitReads).toBe(0);
      } finally {
        await application.close();
        await test.close();
      }
    }
  });

  it("does not commit prepared defaults after the final Chain read fails", async () => {
    const test = fixture({
      defaultsInitialized: false,
      selectionEntries: [],
      beforeCollectionReturn: () => {
        throw new ChainOperationError("chain_response_unavailable");
      },
    });
    await expect(test.application.list({ account: activeTarget })).resolves.toMatchObject({
      ok: false,
      error: { code: "chain_response_unavailable" },
    });
    expect(test.initializationCalls).toBe(0);
    expect(test.state.defaultsInitialized).toBe(false);
    await test.close();
  });

  it("rejects invalid prepared selection order before committing defaults", async () => {
    for (const duplicated of [false, true]) {
      const test = fixture({
        defaultsInitialized: false,
        selectionEntries: [detail(customAddress, 2), detail(candidateAddress, 3)],
      });
      test.setOfficialSnapshot(officialSnapshotWithMembers([{
        ...defaultMember, assetUid: defaultStockTokenManifest.assets[0]!.assetUid,
      }]));
      const store = test.dependencies.selections;
      const application = createAccountAssetApplication({
        ...test.dependencies,
        selections: {
          ...store,
          listIncludedForAccount(input) {
            const page = store.listIncludedForAccount(input);
            return { ...page, selections: duplicated
              ? [page.selections[0]!, page.selections[0]!]
              : [...page.selections].reverse() };
          },
        },
      });
      try {
        await expect(application.list({ account: { kind: "address", address: accountAddress } }))
          .resolves.toMatchObject({ ok: false, error: { code: "internal_error" } });
        expect(test.initializationCalls).toBe(0);
        expect(test.state.defaultsInitialized).toBe(false);
      } finally {
        await application.close();
        await test.close();
      }
    }
  });

  it("does not commit prepared defaults when the caller cancels before finalization", async () => {
    const started = deferred();
    const test = fixture({
      defaultsInitialized: false,
      selectionEntries: [],
      beforeCollectionReturn: (signal) => {
        started.resolve();
        return pendingUntilAbort(signal);
      },
    });
    const caller = new AbortController();
    const pending = test.application.list({ account: activeTarget }, caller.signal);
    await started.promise;
    caller.abort();
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: "request_aborted" },
    });
    expect(test.initializationCalls).toBe(0);
    expect(test.state.defaultsInitialized).toBe(false);
    await test.close();
  });

  it("does not relabel a committed result when cancellation arrives at the commit point", async () => {
    const caller = new AbortController();
    const test = fixture({
      defaultsInitialized: false,
      selectionEntries: [],
      onInitialize: () => { caller.abort(); },
    });
    const result = await test.application.list({ account: activeTarget }, caller.signal);
    if ("ok" in result) throw new TypeError(result.error.code);
    expect(result.assets).toHaveLength(1);
    expect(test.initializationCalls).toBe(1);
    expect(test.state.defaultsInitialized).toBe(true);
    await test.close();
  });

  it("publishes admitted work and close before synchronous dependency reentry", async () => {
    const effectGate = deferred();
    let effectClose: Promise<void> | undefined;
    let abortClose: Promise<void> | undefined;
    let abortObserved = false;
    let synchronizationCalls = 0;
    let test!: ReturnType<typeof fixture>;
    test = fixture({
      beforeOfficialSynchronizeReturn: (signal) => {
        synchronizationCalls += 1;
        signal.addEventListener("abort", () => {
          abortObserved = true;
          abortClose = test.application.close();
        }, { once: true });
        effectClose = test.application.close();
        return effectGate.promise;
      },
    });

    const read = test.application.list({ account: activeTarget });
    if (effectClose === undefined) throw new TypeError("Account close was not started by the effect.");
    expect(abortObserved).toBe(true);
    expect(abortClose).toBe(effectClose);
    expect(test.application.close()).toBe(effectClose);

    let closeSettled = false;
    void effectClose.then(
      () => { closeSettled = true; },
      () => { closeSettled = true; },
    );
    await new Promise<void>((resolveTurn) => { setImmediate(resolveTurn); });
    expect(closeSettled).toBe(false);
    await expect(test.application.list({ account: activeTarget })).resolves.toMatchObject({
      ok: false,
      error: { code: "runtime_state_unavailable" },
    });
    expect(synchronizationCalls).toBe(1);

    effectGate.resolve();
    await expect(read).resolves.toMatchObject({
      ok: false,
      error: { code: "runtime_state_unavailable" },
    });
    await effectClose;
    expect(closeSettled).toBe(true);
    await expect(test.application.list({ account: { kind: "active_wallet" } })).resolves.toMatchObject({
      ok: false,
      error: { code: "runtime_state_unavailable" },
    });
    expect(synchronizationCalls).toBe(1);
    await test.close();
  });

  it("orders defaults before custom selections and binds classifications to one current block", async () => {
    const test = fixture();
    const result = await test.application.list({ account: activeTarget, limit: 5 });
    if ("ok" in result) throw new TypeError(result.error.code);
    expect(result.assets.map((entry) => entry.selection.asset.address)).toEqual([
      defaultMember.contractAddress,
      customAddress,
    ]);
    expect(result.assets.map((entry) => entry.classification.kind)).toEqual([
      "robinhood_stock_token",
      "custom_erc20",
    ]);
    expect(result.assets.map((entry) => entry.requiredStandards.block)).toEqual([
      result.block,
      result.block,
    ]);
    expect(result.assets[0]!.classification).toMatchObject({
      verification: { block: result.block },
    });
    expect(result.native.rawBalance).toBe("7");
    expect(test.initializationCalls).toBe(0);

    await test.close();
  });

  it("returns the native account read when one missing default cannot be verified", async () => {
    const test = fixture({
      defaultsInitialized: false,
      defaultVerificationUnavailable: true,
      selectionEntries: [],
    });

    const result = await test.application.list({ account: activeTarget, limit: 5 });
    if ("ok" in result) throw new TypeError(result.error.code);
    expect(result.native.rawBalance).toBe("7");
    expect(result.assets).toEqual([]);
    expect(test.initializationCalls).toBe(0);
    expect(test.state.defaultsInitialized).toBe(false);
    await test.close();
  });

  it("attributes a current official member verification failure to StockFactory", async () => {
    const test = fixture({ defaultVerificationUnavailable: true });
    const result = await test.application.list({ account: activeTarget, limit: 5 });
    if ("ok" in result) throw new TypeError(result.error.code);
    expect(result.assets[0]?.classification).toMatchObject({
      kind: "classification_unavailable",
      cause: {
        kind: "stock_factory_verification_unavailable",
        reason: "source_unavailable",
        member: { contractAddress: defaultMember.contractAddress },
      },
    });
    await test.close();
  });

  it("keeps local StockFactory stops as whole-request failures without partial assets", async () => {
    for (const [verificationFailureCode, retryable] of [
      ["runtime_busy", true],
      ["runtime_state_unavailable", false],
    ] as const) {
      const test = fixture({ verificationFailureCode });
      await expect(test.application.list({ account: activeTarget, limit: 5 })).resolves.toMatchObject({
        ok: false,
        error: { code: verificationFailureCode, retryable },
      });
      await test.close();
    }
  });

  it("preserves one official-source failure cause through page and cursor reads", async () => {
    const test = fixture({
      sourceAvailable: false,
      sourceFailureCode: "source_inconsistent",
    });
    const result = await test.application.list({ account: activeTarget, limit: 1 });
    if ("ok" in result) throw new TypeError(result.error.code);
    expect(result.assets).toHaveLength(1);
    expect(result.assets.every((entry) =>
      entry.classification.kind === "classification_unavailable" &&
      entry.classification.cause.kind === "official_snapshot_unavailable" &&
      entry.classification.cause.reason === "source_inconsistent")).toBe(true);
    expect(result.viewRevision).toMatchObject({
      officialSnapshotStatus: "unavailable",
      officialSnapshotRevision: snapshotRevision,
      officialSnapshotUnavailableReason: "source_inconsistent",
      selectionSetRevision,
    });
    if (
      result.nextCursor === null ||
      result.nextCursor.officialSnapshotStatus !== "unavailable" ||
      result.viewRevision.officialSnapshotStatus !== "unavailable"
    ) throw new TypeError("Unavailable page fixture lacks its exact correlation state.");
    const next = await test.application.list({ account: activeTarget, limit: 1, cursor: result.nextCursor });
    if ("ok" in next) throw new TypeError(next.error.code);
    expect(next.assets[0]?.classification).toMatchObject({
      kind: "classification_unavailable",
      cause: { kind: "official_snapshot_unavailable", reason: "source_inconsistent" },
    });
    await expect(test.application.list({
      account: activeTarget,
      limit: 1,
      cursor: {
        ...result.nextCursor,
        officialSnapshotUnavailableReason: "source_unavailable",
      },
    })).resolves.toMatchObject({ ok: false, error: { code: "state_conflict" } });
    await test.close();
  });

  it("rejects StockFactory result count and member-order mismatches", async () => {
    const selections = [
      detail(defaultMember.contractAddress, 1),
      detail(unselectedMember.contractAddress, 2),
    ];
    const transforms = [
      (_members: readonly OfficialAssetSourceMember[], results: readonly StockFactoryVerificationResult[]) =>
        results.slice(0, 1),
      (_members: readonly OfficialAssetSourceMember[], results: readonly StockFactoryVerificationResult[]) => [
        {
          status: "unavailable" as const,
          member: member(customAddress, "44", "OTHER"),
          reason: "source_unavailable" as const,
        },
        results[1]!,
      ],
    ];
    for (const transformVerificationResults of transforms) {
      const test = fixture({ selectionEntries: selections, transformVerificationResults });
      await expect(test.application.list({ account: activeTarget })).resolves.toMatchObject({
        ok: false,
        error: { code: "internal_error" },
      });
      await test.close();
    }
  });

  it("accepts overlapping first pages when the current official view remains equal", async () => {
    const firstReadStarted = deferred();
    const releaseFirstRead = deferred();
    let collectionReads = 0;
    const test = fixture({
      sourceAvailable: false,
      sourceFailureCode: "source_inconsistent",
      beforeCollectionReturn: () => {
        collectionReads += 1;
        if (collectionReads !== 1) return;
        firstReadStarted.resolve();
        return releaseFirstRead.promise;
      },
    });

    const firstPending = test.application.list({ account: activeTarget });
    await firstReadStarted.promise;
    const second = await test.application.list({ account: activeTarget });
    if ("ok" in second) throw new TypeError(second.error.code);
    releaseFirstRead.resolve();
    const first = await firstPending;
    if ("ok" in first) throw new TypeError(first.error.code);

    expect(first.viewRevision).toEqual(second.viewRevision);
    expect(first.viewRevision).toMatchObject({
      officialSnapshotStatus: "unavailable",
      officialSnapshotUnavailableReason: "source_inconsistent",
    });
    await test.close();
  });

  it("rejects an overlapping first page after the current official view changes", async () => {
    const firstReadStarted = deferred();
    const releaseFirstRead = deferred();
    let collectionReads = 0;
    const test = fixture({
      sourceAvailable: false,
      sourceFailureCode: "source_unavailable",
      beforeCollectionReturn: () => {
        collectionReads += 1;
        if (collectionReads !== 1) return;
        firstReadStarted.resolve();
        return releaseFirstRead.promise;
      },
    });

    const stalePending = test.application.list({ account: activeTarget });
    await firstReadStarted.promise;
    test.setSourceAvailability(false, "source_inconsistent");
    const current = await test.application.list({ account: activeTarget });
    if ("ok" in current) throw new TypeError(current.error.code);
    expect(current.viewRevision).toMatchObject({
      officialSnapshotStatus: "unavailable",
      officialSnapshotUnavailableReason: "source_inconsistent",
    });
    releaseFirstRead.resolve();

    await expect(stalePending).resolves.toMatchObject({
      ok: false,
      error: { code: "state_conflict" },
    });
    await test.close();
  });

  it("rejects a continuation after its official view is replaced", async () => {
    const continuationTest = fixture({
      sourceAvailable: false,
      sourceFailureCode: "source_unavailable",
    });
    const firstPage = await continuationTest.application.list({ account: activeTarget, limit: 1 });
    if ("ok" in firstPage || firstPage.nextCursor === null) {
      throw new TypeError("Continuation fixture is invalid.");
    }
    const continuationStarted = deferred();
    const releaseContinuation = deferred();
    continuationTest.setBeforeCollectionReturn(() => {
      continuationStarted.resolve();
      return releaseContinuation.promise;
    });
    const continuationPending = continuationTest.application.list({
      account: activeTarget,
      limit: 1,
      cursor: firstPage.nextCursor,
    });
    await continuationStarted.promise;
    continuationTest.setBeforeCollectionReturn(undefined);
    continuationTest.setSourceAvailability(false, "source_inconsistent");
    const replacement = await continuationTest.application.list({
      account: { kind: "active_wallet" },
    });
    if ("ok" in replacement) throw new TypeError(replacement.error.code);
    releaseContinuation.resolve();
    await expect(continuationPending).resolves.toMatchObject({
      ok: false,
      error: { code: "state_conflict" },
    });
    await continuationTest.close();
  });

  it("rejects session-source and official-snapshot drift before returning a page", async () => {
    let sessionTest: ReturnType<typeof fixture>;
    sessionTest = fixture({
      beforeCollectionReturn: () => { sessionTest.setSessionSourceId("wallet-session:changed"); },
    });
    await expect(sessionTest.application.list({ account: activeTarget })).resolves.toMatchObject({
      ok: false,
      error: { code: "state_conflict" },
    });
    await sessionTest.close();

    const changedRevision = officialAssetSnapshotRevisionSchema.parse(
      Buffer.alloc(16, 10).toString("base64url"),
    );
    let sourceTest: ReturnType<typeof fixture>;
    sourceTest = fixture({
      beforeCollectionReturn: () => {
        sourceTest.setOfficialSnapshot({ ...snapshot, revision: changedRevision });
      },
    });
    await expect(sourceTest.application.list({ account: activeTarget })).resolves.toMatchObject({
      ok: false,
      error: { code: "state_conflict" },
    });
    await sourceTest.close();
  });

  it("retains view revisions while resolving a new block for a later page", async () => {
    const test = fixture({ blocks: [block, laterBlock] });
    const first = await test.application.list({ account: activeTarget, limit: 1 });
    if ("ok" in first || first.nextCursor === null) throw new TypeError("First page fixture is invalid.");
    const second = await test.application.list({ account: activeTarget, limit: 1, cursor: first.nextCursor });
    if ("ok" in second) throw new TypeError(second.error.code);

    expect(first.block.blockHash).toBe(block.blockHash);
    expect(second.block.blockHash).toBe(laterBlock.blockHash);
    expect(second.viewRevision).toEqual(first.viewRevision);
    await test.close();
  });

  it("rejects an account A continuation for account B with its other revisions unchanged", async () => {
    const test = fixture();
    const first = await test.application.list({ account: activeTarget, limit: 1 });
    if ("ok" in first || first.nextCursor === null) {
      throw new TypeError("Account continuation fixture is invalid.");
    }
    await expect(test.application.list({
      account: { kind: "address", address: customAddress },
      limit: 1,
      cursor: first.nextCursor,
    })).resolves.toMatchObject({ ok: false, error: { code: "state_conflict" } });
    await test.close();
  });

  it("keeps one remaining chain deadline across an account list read", async () => {
    vi.useFakeTimers();
    const test = fixture();
    const baseline = await test.application.list({ account: activeTarget });
    if ("ok" in baseline) throw new TypeError(baseline.error.code);

    const listGate = deferred();
    const listStarted = deferred();
    const collectionStarted = deferred();
    test.setAfterVerification(async () => {
      listStarted.resolve();
      await listGate.promise;
    });
    test.setBeforeCollectionReturn((signal) => {
      collectionStarted.resolve();
      return pendingUntilAbort(signal);
    });
    const pendingList = test.application.list({ account: activeTarget });
    await listStarted.promise;
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(vi.getTimerCount()).toBe(1);
    listGate.resolve();
    await collectionStarted.promise;
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(pendingList).resolves.toMatchObject({
      ok: false,
      error: { code: "chain_response_unavailable" },
    });
    expect(vi.getTimerCount()).toBe(0);

    await test.close();
  });
});

describe("account asset application factory", () => {
  it("shares its in-flight close and releases successful startup ownership", async () => {
    const readFixture = fixture();
    const startup = startupOwnerFixture();
    const application = await createAccountAssetApplicationFactory({
      ...readFixture.dependencies,
      routes: await accountFactoryRoutes(),
      supportManifest: tokenCatalogSupportManifest,
      startupResources: startup.resources,
    });
    expect(startup.registrations).toBe(1);
    expect(startup.scope.empty).toBe(true);

    const closing = application.close();
    expect(application.close()).toBe(closing);
    let admissionFailure: unknown;
    try { application.list({ account: activeTarget }); }
    catch (error) { admissionFailure = error; }
    expect(admissionFailure).toBeInstanceOf(AccountAssetOperationError);
    expect((admissionFailure as AccountAssetOperationError).failure.error.code)
      .toBe("runtime_state_unavailable");
    const route = application.routes.match("POST", accountAssetControlRoutes.queries);
    if (route.status !== "matched") throw new TypeError("Account route is unavailable.");
    await route.route.handler({
      params: route.params,
      query: "",
      body: { account: activeTarget, limit: 5 },
      signal: new AbortController().signal,
    }).then(
      () => undefined,
      () => undefined,
    );
    expect(readFixture.walletCaptures).toBe(0);
    await closing;
    await readFixture.close();
  });

  it("releases startup ownership after successful rollback", async () => {
    const readFixture = fixture();
    const startup = startupOwnerFixture();
    const startupFailure = createAccountAssetApplicationFactory({
      ...readFixture.dependencies,
      routes: await accountFactoryRoutes(),
      supportManifest: Object.freeze({}) as never,
      startupResources: startup.resources,
    });
    expect(startup.registrations).toBe(1);
    expect(startup.registeredResource).toMatchObject({ admission: { isOpen: false } });
    await expect(startupFailure).rejects.toThrow();
    expect(startup.scope.empty).toBe(true);
    await readFixture.close();
  });
});
