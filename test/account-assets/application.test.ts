import { describe, expect, it } from "vitest";

import { createAccountAssetApplication } from "../../src/account-assets/application.js";
import {
  chainAnchorSchema,
  createCanonicalClock,
  parseCapabilityDataAt,
  parseEvmAddressInput,
  parseEvmChainId,
  parseHash32,
  parseUtcTimestamp,
  parseUnsignedDecimal,
  tokenStandardObservationResultSchema,
  walletConnectionCapability,
  type EvmAddress,
} from "../../src/core/index.js";
import type {
  AccountAssetChainReadPort,
  OfficialAssetChainReadPort,
} from "../../src/chain/index.js";
import {
  defaultStockTokenManifest,
  officialAssetSnapshotRevisionSchema,
  robinhoodAssetSourceUri,
  type CommittedOfficialAssetSnapshot,
} from "../../src/registry/index.js";
import {
  tokenSelectionDetailSchema,
  tokenSelectionSetRevisionSchema,
  type AccountTokenSelectionStore,
  type TokenSelectionDetail,
  type TokenSelectionState,
} from "../../src/token-catalog/index.js";

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
const snapshotRevision = officialAssetSnapshotRevisionSchema.parse(
  Buffer.alloc(16, 7).toString("base64url"),
);
const selectionSetRevision = tokenSelectionSetRevisionSchema.parse(
  Buffer.alloc(16, 8).toString("base64url"),
);
const account = Object.freeze({ chainId, address: accountAddress });

const member = (address: EvmAddress, byte: string, symbol: string) => Object.freeze({
  assetUid: parseHash32(`0x${byte.repeat(32)}`),
  contractAddress: address,
  sourceName: `${symbol} Stock Token`,
  sourceSymbol: symbol,
});
const defaultMember = member(defaultStockTokenManifest.assets[0]!.contractAddress, "11", "AAPL");
const unselectedMember = member(candidateAddress, "22", "NEXT");
const snapshot = Object.freeze({
  sourceUri: robinhoodAssetSourceUri,
  sourceObservedAt: at,
  rawResponseDigest: parseHash32(`0x${"33".repeat(32)}`),
  memberSetDigest: parseHash32(`0x${"44".repeat(32)}`),
  candidateListDigest: parseHash32(`0x${"55".repeat(32)}`),
  chainId,
  members: Object.freeze([defaultMember, unselectedMember]),
  revision: snapshotRevision,
  updatedAt: at,
}) satisfies CommittedOfficialAssetSnapshot;

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

const fullObservation = (address: EvmAddress) => tokenStandardObservationResultSchema.parse({
  asset: { kind: "erc20", chainId, address },
  account,
  block,
  standards: [
    { standardId: "erc20_read_surface", status: "observed" },
    { standardId: "erc165", status: "not_supported" },
    { standardId: "erc8056", status: "unknown" },
    { standardId: "erc8056_pending_multiplier", status: "unknown" },
    { standardId: "erc8056_conversion", status: "unknown" },
    { standardId: "erc8056_balances", status: "unknown" },
  ],
});

const fixture = (options: Readonly<{
  sourceAvailable?: boolean;
  blocks?: readonly [typeof block, ...(typeof block)[]];
  afterVerification?: () => void;
  beforeCollectionReturn?: () => void;
}> = {}) => {
  const sourceAvailable = options.sourceAvailable ?? true;
  const entries = [detail(defaultMember.contractAddress, 1), detail(customAddress, 2)];
  let state: TokenSelectionState = {
    account,
    revision: selectionSetRevision,
    defaultsInitialized: true,
    createdAt: at,
    updatedAt: at,
  };
  let initializationCalls = 0;
  let sessionSourceId = "wallet-session:test";
  let officialSnapshot: CommittedOfficialAssetSnapshot = snapshot;
  let blockIndex = 0;
  const selections: AccountTokenSelectionStore = Object.freeze({
    getState: () => state,
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
    initializeDefaults: () => {
      initializationCalls += 1;
      throw new Error("Initialized state must not be seeded again.");
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
    proxyAddress: parseEvmAddressInput(`0x${"aa".repeat(20)}`),
    proxyCodeHash: parseHash32(`0x${"bb".repeat(32)}`),
    implementationAddress: parseEvmAddressInput(`0x${"cc".repeat(20)}`),
    implementationCodeHash: parseHash32(`0x${"dd".repeat(32)}`),
    tokenCodeHash: parseHash32(`0x${"ee".repeat(32)}`),
  });
  const owner = new AbortController();
  const officialAssetReads: OfficialAssetChainReadPort = Object.freeze({
    verifyAtBlock: async (
      entry: Parameters<OfficialAssetChainReadPort["verifyAtBlock"]>[0],
      verificationBlock: Parameters<OfficialAssetChainReadPort["verifyAtBlock"]>[1],
    ) => verificationFor(entry.assetUid, entry.contractAddress, verificationBlock),
    verifyManyAtBlock: async (
      members: Parameters<OfficialAssetChainReadPort["verifyManyAtBlock"]>[0],
      verificationBlock: Parameters<OfficialAssetChainReadPort["verifyManyAtBlock"]>[1],
    ) => {
      const results = Object.freeze(members.map((entry) => Object.freeze({
        status: "verified" as const,
        verification: verificationFor(entry.assetUid, entry.contractAddress, verificationBlock),
      })));
      options.afterVerification?.();
      return results;
    },
  });
  const chainReads: AccountAssetChainReadPort = Object.freeze({
    resolveCurrentBlock: async () => options.blocks?.[blockIndex++] ?? block,
    readCollectionAtBlock: async (
      { account: requested, assets, block: requestedBlock }: Parameters<AccountAssetChainReadPort["readCollectionAtBlock"]>[0],
    ) => {
      const result = Object.freeze({
        account: requested,
        block: requestedBlock,
        nativeRawBalance: parseUnsignedDecimal("7"),
        tokens: Object.freeze(assets.map((asset, index) => Object.freeze({
        asset,
        name: { status: "available" as const, value: index === 0 ? "Apple" : "Custom" },
        symbol: { status: "available" as const, value: index === 0 ? "AAPL" : "CSTM" },
        decimals: parseUnsignedDecimal("18"),
        rawBalance: parseUnsignedDecimal(String(index + 1)),
        requiredStandards: requiredObservation(asset.address, requestedBlock),
        }))),
      });
      options.beforeCollectionReturn?.();
      return result;
    },
    readExactAtBlock: async (
      { account: requested, asset }: Parameters<AccountAssetChainReadPort["readExactAtBlock"]>[0],
    ) => Object.freeze({
      account: requested,
      asset,
      block,
      name: { status: "available" as const, value: "Exact" },
      symbol: { status: "available" as const, value: "EXT" },
      decimals: parseUnsignedDecimal("18"),
      rawBalance: parseUnsignedDecimal("9"),
      requiredStandards: requiredObservation(asset.address),
      totalSupply: parseUnsignedDecimal("100"),
      standards: fullObservation(asset.address),
    }),
  });
  const application = createAccountAssetApplication({
    activeWallet: Object.freeze({
      capture: () => Object.freeze({
        connection: currentConnection,
        connectionRevision: parseUnsignedDecimal("1"),
        sessionSource: { sourceId: sessionSourceId } as never,
      }),
    }),
    selections,
    officialAssets: Object.freeze({
      synchronize: async () => sourceAvailable
        ? Object.freeze({ status: "current" as const, snapshot: officialSnapshot })
        : Object.freeze({
            status: "unavailable" as const,
            storedRevision: officialSnapshot.revision,
            failure: { ok: false as const, error: {
              code: "source_unavailable" as never,
              category: "source" as const,
              message: "Source unavailable.",
              retryable: true,
              issues: [],
            } },
          }),
      readStored: () => officialSnapshot,
      close: async () => undefined,
    }),
    officialAssetReads,
    chainReads,
    clock: createCanonicalClock(() => at),
    signal: owner.signal,
  });
  return {
    application,
    get state() { return state; },
    setState(next: TokenSelectionState) { state = next; },
    get initializationCalls() { return initializationCalls; },
    setSessionSourceId(next: string) { sessionSourceId = next; },
    setOfficialSnapshot(next: CommittedOfficialAssetSnapshot) { officialSnapshot = next; },
  };
};

describe("account asset read process", () => {
  it("orders defaults before custom selections and binds classifications to one current block", async () => {
    const test = fixture();
    const result = await test.application.list({ limit: 5 });
    if ("ok" in result) throw new TypeError(result.error.code);
    expect(result.assets.map((entry) => entry.selection.asset.address)).toEqual([
      defaultMember.contractAddress,
      customAddress,
    ]);
    expect(result.assets.map((entry) => entry.classification.kind)).toEqual([
      "robinhood_stock_token",
      "custom_erc20",
    ]);
    expect(result.native.rawBalance).toBe("7");
    expect(test.initializationCalls).toBe(0);

    const candidates = await test.application.listOfficialCandidates({ viewRevision: result.viewRevision });
    if ("ok" in candidates) throw new TypeError(candidates.error.code);
    expect(candidates.candidates.map((entry) => entry.contractAddress)).toEqual([candidateAddress]);
    await test.application.close();
  });

  it("uses the supplied view revision for exact reads and rejects later selection drift", async () => {
    const test = fixture();
    const list = await test.application.list({});
    if ("ok" in list) throw new TypeError(list.error.code);
    const exact = await test.application.get({
      asset: list.assets[1]!.selection.asset,
      viewRevision: list.viewRevision,
    });
    if ("ok" in exact) throw new TypeError(exact.error.code);
    expect(exact.totalSupply).toBe("100");
    expect(exact.asset.amount.raw).toBe("9");

    test.setState({
      ...test.state,
      revision: tokenSelectionSetRevisionSchema.parse(Buffer.alloc(16, 9).toString("base64url")),
    });
    await expect(test.application.get({
      asset: list.assets[1]!.selection.asset,
      viewRevision: list.viewRevision,
    })).resolves.toMatchObject({ ok: false, error: { code: "state_conflict" } });
    await test.application.close();
  });

  it("preserves selected assets while making official classification explicitly unavailable", async () => {
    const test = fixture({ sourceAvailable: false });
    const result = await test.application.list({});
    if ("ok" in result) throw new TypeError(result.error.code);
    expect(result.assets).toHaveLength(2);
    expect(result.assets.every((entry) =>
      entry.classification.kind === "classification_unavailable" &&
      entry.classification.reason === "source_unavailable")).toBe(true);
    expect(result.viewRevision).toMatchObject({
      officialSnapshotStatus: "unavailable",
      officialSnapshotRevision: snapshotRevision,
      selectionSetRevision,
    });
    await test.application.close();
  });

  it("rejects session-source and official-snapshot drift before returning a page", async () => {
    let sessionTest: ReturnType<typeof fixture>;
    sessionTest = fixture({
      beforeCollectionReturn: () => { sessionTest.setSessionSourceId("wallet-session:changed"); },
    });
    await expect(sessionTest.application.list({})).resolves.toMatchObject({
      ok: false,
      error: { code: "state_conflict" },
    });
    await sessionTest.application.close();

    const changedRevision = officialAssetSnapshotRevisionSchema.parse(
      Buffer.alloc(16, 10).toString("base64url"),
    );
    let sourceTest: ReturnType<typeof fixture>;
    sourceTest = fixture({
      beforeCollectionReturn: () => {
        sourceTest.setOfficialSnapshot({ ...snapshot, revision: changedRevision });
      },
    });
    await expect(sourceTest.application.list({})).resolves.toMatchObject({
      ok: false,
      error: { code: "state_conflict" },
    });
    await sourceTest.application.close();
  });

  it("retains view revisions while resolving a new block for a later page", async () => {
    const test = fixture({ blocks: [block, laterBlock] });
    const first = await test.application.list({ limit: 1 });
    if ("ok" in first || first.nextCursor === null) throw new TypeError("First page fixture is invalid.");
    const second = await test.application.list({ limit: 1, cursor: first.nextCursor });
    if ("ok" in second) throw new TypeError(second.error.code);

    expect(first.block.blockHash).toBe(block.blockHash);
    expect(second.block.blockHash).toBe(laterBlock.blockHash);
    expect(second.viewRevision).toEqual(first.viewRevision);
    await test.application.close();
  });
});
