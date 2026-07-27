import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  canonicalJsonStringify,
  chainAnchorSchema,
  parseCapabilityDataAt,
  parseEvmAddressInput,
  parseEvmChainId,
  parseHash32,
  parseUtcTimestamp,
  walletConnectionCapability,
  type CanonicalJson,
  type EvmAccountIdentity,
} from "../../src/core/index.js";
import {
  defaultStockTokenManifest,
  stockFactoryAdmissionManifest,
  type StockFactoryVerification,
} from "../../src/registry/index.js";
import {
  assertOfficialAssetSourceSnapshot,
} from "../../src/registry/official-asset-contract.js";
import {
  createRobinhoodOfficialAssetSourceClient,
} from "../../src/registry/official-assets.js";
import { ProductDatabase } from "../../src/runtime/database.js";
import { getRuntimeOperationFailure } from "../../src/runtime/errors.js";
import { ensureOwnerOnlyDirectory, runtimePaths } from "../../src/runtime/paths.js";
import {
  tokenCatalogOperationIdSchema,
  tokenCatalogOperationSchema,
  tokenCatalogDigestVersions,
  tokenCatalogReviewDigest,
  tokenInspectionDigest,
  tokenSelectionRevisionSchema,
  tokenSelectionSetRevisionSchema,
  type TokenCatalogOperation,
  type TokenInspectionSuccess,
  type TokenOfficialSelectionEvidence,
  type TokenSelection,
} from "../../src/token-catalog/contracts.js";
import { getTokenCatalogOperationFailure } from "../../src/token-catalog/operation-error.js";
import type { TokenCatalogStore } from "../../src/token-catalog/ports.js";
import {
  createExactResolvedAnalysis,
  validContractAnalysisClaimMutations,
} from "../core/contract-analysis-fixtures.js";
import { createInspectionSuccess } from "./harness.js";

const directories: string[] = [];
const chainId = parseEvmChainId("eip155:4663");
const walletAddress = parseEvmAddressInput(`0x${"34".repeat(20)}`);
const account: EvmAccountIdentity = Object.freeze({ chainId, address: walletAddress });
const now = parseUtcTimestamp("2026-07-21T00:00:00.000Z");
const later = parseUtcTimestamp("2026-07-21T00:00:01.000Z");
const block = chainAnchorSchema.parse({
  chainId,
  blockNumber: "42",
  blockHash: `0x${"ab".repeat(32)}`,
  blockTimestamp: now,
});

type IndependentJson =
  | null
  | boolean
  | number
  | string
  | readonly IndependentJson[]
  | { readonly [key: string]: IndependentJson };

const independentCanonicalJson = (value: IndependentJson): string => {
  if (value === null || typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(independentCanonicalJson).join(",")}]`;
  const object = value as { readonly [key: string]: IndependentJson };
  return `{${Object.keys(object).sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    .map((key) => `${JSON.stringify(key)}:${independentCanonicalJson(
      object[key] as IndependentJson,
    )}`).join(",")}}`;
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

const openDatabase = async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "littlejohn-token-selection-"));
  directories.push(directory);
  await ensureOwnerOnlyDirectory(directory);
  const path = runtimePaths(directory).database;
  const database = await ProductDatabase.open(path, now);
  database.configuredChainStore().insertConfiguredChainIfAbsent(chainId);
  const connection = database.walletStore().replace("0", parseCapabilityDataAt(walletConnectionCapability, {
    status: "connected",
    chainId,
    address: walletAddress,
    approvedMethods: ["eth_sendTransaction"],
    approvedEvents: ["accountsChanged", "chainChanged"],
    expiresAt: "2026-07-22T00:00:00.000Z",
  }, now), now);
  return { database, path, connection };
};

const sourceObservation = async (additionalAssets: readonly Readonly<{
  id: string;
  contractAddress: string;
  tokenName: string;
  tokenSymbol: string;
}>[] = [], defaultAssetUidByAddress: Readonly<Record<string, string>> = {}) => {
  const response = {
    assets: [
      ...defaultStockTokenManifest.assets.map((entry, index) => ({
        id: defaultAssetUidByAddress[entry.contractAddress] ?? entry.assetUid,
        status: "ASSET_STATUS_ACTIVE",
        deployments: [{ chainId: 4663, contractAddress: entry.contractAddress }],
        tokenName: `Default ${index + 1}`,
        tokenSymbol: `D${index + 1}`,
      })),
      ...additionalAssets.map((entry) => ({
        id: entry.id,
        status: "ASSET_STATUS_ACTIVE",
        deployments: [{ chainId: 4663, contractAddress: entry.contractAddress }],
        tokenName: entry.tokenName,
        tokenSymbol: entry.tokenSymbol,
      })),
    ],
  };
  return await createRobinhoodOfficialAssetSourceClient({
    fetch: (async () => new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch,
    now: () => new Date(now),
  }).read(new AbortController().signal);
};

const sourceSnapshot = async (database: ProductDatabase) =>
  database.officialAssetSnapshotStore().replaceSnapshot(await sourceObservation(), null);

const verification = (
  assetUid: StockFactoryVerification["assetUid"],
  contractAddress: StockFactoryVerification["contractAddress"],
  verificationBlock: StockFactoryVerification["block"] = block,
): StockFactoryVerification => Object.freeze({
  assetUid,
  contractAddress,
  block: verificationBlock,
  proxyAddress: stockFactoryAdmissionManifest.proxyAddress,
  proxyCodeHash: stockFactoryAdmissionManifest.proxyCodeHash,
  implementationAddress: stockFactoryAdmissionManifest.implementationAddress,
  implementationCodeHash: stockFactoryAdmissionManifest.implementationCodeHash,
  tokenCodeHash: parseHash32(`0x${"ee".repeat(32)}`),
});

let operationSequence = 0;
const operationId = () => {
  operationSequence += 1;
  return tokenCatalogOperationIdSchema.parse(Buffer.alloc(32, operationSequence).toString("base64url"));
};
const selectionRevision = (byte: number) => tokenSelectionRevisionSchema.parse(
  Buffer.alloc(16, byte).toString("base64url"),
);
const setRevision = (byte: number) => tokenSelectionSetRevisionSchema.parse(
  Buffer.alloc(16, byte).toString("base64url"),
);

const applyingOperation = (input: Readonly<{
  kind: "add" | "remove";
  connectionRevision: string;
  asset: TokenSelection["asset"];
  previousSelection: TokenSelection | null;
  currentSetRevision: ReturnType<typeof tokenSelectionSetRevisionSchema.parse> | null;
  inspection: TokenInspectionSuccess | null;
  snapshotRevision: string | null;
  officialEvidence?: TokenOfficialSelectionEvidence | null;
}>): Extract<TokenCatalogOperation, { state: "applying" }> => {
  const id = operationId();
  const officialEvidence = input.officialEvidence ?? null;
  const reviewDigest = tokenCatalogReviewDigest({
    operationId: id,
    kind: input.kind,
    account,
    connectionRevision: input.connectionRevision,
    asset: input.asset,
    previousSelection: input.previousSelection,
    selectionSetRevision: input.currentSetRevision,
    inspection: input.inspection,
    officialSnapshotRevision: input.snapshotRevision,
    officialEvidence,
    interactionInterface: "cli",
    expiresAt: "2026-07-21T00:05:00.000Z",
  });
  return tokenCatalogOperationSchema.parse({
    operationId: id,
    kind: input.kind,
    state: "applying",
    interactionInterface: "cli",
    createdAt: now,
    expiresAt: "2026-07-21T00:05:00.000Z",
    account,
    connectionRevision: input.connectionRevision,
    asset: input.asset,
    review: {
      previousSelection: input.previousSelection,
      selectionSetRevision: input.currentSetRevision,
      inspection: input.inspection,
      inspectionDigest: input.kind === "add" && input.inspection !== null
        ? tokenInspectionDigest(input.inspection)
        : null,
      officialSnapshotRevision: input.snapshotRevision,
      officialEvidence,
      reviewDigest,
    },
    result: null,
    failure: null,
  }) as Extract<TokenCatalogOperation, { state: "applying" }>;
};

const apply = (store: TokenCatalogStore, input: Readonly<{
  kind: "add" | "remove";
  connectionRevision: string;
  operation: Extract<TokenCatalogOperation, { state: "applying" }>;
  selectionRevision: ReturnType<typeof tokenSelectionRevisionSchema.parse>;
  selectionSetRevision: ReturnType<typeof tokenSelectionSetRevisionSchema.parse>;
  officialVerification?: StockFactoryVerification | null;
}>) => store.applyConfirmation({
  kind: input.kind,
  operation: input.operation as never,
  expectedConnectionRevision: input.connectionRevision,
  selectionRevision: input.selectionRevision,
  selectionSetRevision: input.selectionSetRevision,
  ...(input.kind === "add" ? { officialVerification: input.officialVerification ?? null } : {}),
  now: later,
} as never);

const failureCode = (effect: () => unknown): string | undefined => {
  try { effect(); return undefined; }
  catch (error) { return getTokenCatalogOperationFailure(error)?.error.code; }
};

describe("token selection persistence", () => {
  it("rejects a stored token inspection without the required source record digests", async () => {
    const { database, path } = await openDatabase();
    const inspection = await createInspectionSuccess({
      asset: {
        kind: "erc20",
        chainId,
        address: parseEvmAddressInput(`0x${"87".repeat(20)}`),
      },
      block: { kind: "latest" },
    });
    database.close();

    const oldResult = JSON.parse(canonicalJsonStringify(inspection as unknown as CanonicalJson)) as {
      evidence: { sources: Array<Record<string, unknown>> };
    };
    for (const source of oldResult.evidence.sources) delete source["recordDigest"];
    const resultJson = independentCanonicalJson(oldResult as unknown as IndependentJson);
    const inspectionDigest = `0x${createHash("sha256").update(independentCanonicalJson({
      digestKind: "token_inspection",
      digestVersion: tokenCatalogDigestVersions.inspection,
      result: oldResult as unknown as IndependentJson,
    }), "utf8").digest("hex")}`;

    const raw = new Database(path);
    raw.prepare("INSERT INTO contract(chain_id, contract_address) VALUES (?, ?)")
      .run(chainId, inspection.data.asset.address);
    raw.prepare("INSERT INTO token_contract(chain_id, contract_address) VALUES (?, ?)")
      .run(chainId, inspection.data.asset.address);
    raw.prepare(`INSERT INTO token_contract_inspection(
      chain_id, contract_address, inspection_digest, result_json
    ) VALUES (?, ?, ?, ?)`)
      .run(chainId, inspection.data.asset.address, inspectionDigest, resultJson);
    raw.close();

    let failure: unknown;
    try { await ProductDatabase.open(path, now); }
    catch (error) { failure = error; }
    expect(getRuntimeOperationFailure(failure)?.error.code).toBe("runtime_state_unavailable");
  });

  it("rejects a matching independently digested durable semantic corruption", async () => {
    const { database, path } = await openDatabase();
    const address = parseEvmAddressInput(`0x${"86".repeat(20)}`);
    const analysisBlock = chainAnchorSchema.parse({
      chainId,
      blockNumber: "42",
      blockHash: `0x${"ab".repeat(32)}`,
      blockTimestamp: "2026-07-18T00:00:00.000Z",
    });
    const analysis = createExactResolvedAnalysis(address, analysisBlock);
    const inspection = await createInspectionSuccess({
      asset: {
        kind: "erc20",
        chainId,
        address,
      },
      block: { kind: "latest" },
    }, { analysis });
    database.close();

    const changedOwner = validContractAnalysisClaimMutations(analysis).find(
      (mutation) => mutation.label === "owner",
    )?.analysis;
    expect(changedOwner).toBeDefined();
    if (changedOwner === undefined) return;
    const malformed = JSON.parse(JSON.stringify(inspection)) as {
      data: { analysis: unknown };
    };
    malformed.data.analysis = changedOwner;
    const resultJson = independentCanonicalJson(malformed as unknown as IndependentJson);
    const inspectionDigest = `0x${createHash("sha256").update(independentCanonicalJson({
      digestKind: "token_inspection",
      digestVersion: "5",
      result: malformed as unknown as IndependentJson,
    }), "utf8").digest("hex")}`;

    const raw = new Database(path);
    raw.prepare("INSERT INTO contract(chain_id, contract_address) VALUES (?, ?)")
      .run(chainId, inspection.data.asset.address);
    raw.prepare("INSERT INTO token_contract(chain_id, contract_address) VALUES (?, ?)")
      .run(chainId, inspection.data.asset.address);
    raw.prepare(`INSERT INTO token_contract_inspection(
      chain_id, contract_address, inspection_digest, result_json
    ) VALUES (?, ?, ?, ?)`)
      .run(chainId, inspection.data.asset.address, inspectionDigest, resultJson);
    raw.close();

    let failure: unknown;
    try { await ProductDatabase.open(path, now); }
    catch (error) { failure = error; }
    expect(getRuntimeOperationFailure(failure)?.error.code).toBe("runtime_state_unavailable");
  });

  it("rejects a structural copy before changing the durable official snapshot", async () => {
    const { database, path } = await openDatabase();
    const observation = await sourceObservation();
    const copy = assertOfficialAssetSourceSnapshot({
      ...observation,
      members: observation.members.map((member) => ({ ...member })),
    });

    let failure: unknown;
    try { database.officialAssetSnapshotStore().replaceSnapshot(copy as never, null); }
    catch (error) { failure = error; }
    expect(getRuntimeOperationFailure(failure)?.error.code).toBe("runtime_state_unavailable");

    const raw = new Database(path, { readonly: true });
    expect(raw.prepare("SELECT COUNT(*) AS count FROM robinhood_asset_snapshot").get())
      .toEqual({ count: 0 });
    expect(raw.prepare("SELECT COUNT(*) AS count FROM robinhood_asset").get())
      .toEqual({ count: 0 });
    raw.close();
    database.close();
  });

  it("rejects a persisted official label outside the shared display contract on reopen", async () => {
    const { database, path } = await openDatabase();
    await sourceSnapshot(database);
    database.close();

    const raw = new Database(path);
    expect(raw.prepare("UPDATE robinhood_asset SET source_name = ?").run("A".repeat(129)).changes)
      .toBe(defaultStockTokenManifest.assets.length);
    raw.close();

    let failure: unknown;
    try { await ProductDatabase.open(path, now); }
    catch (error) { failure = error; }
    expect(getRuntimeOperationFailure(failure)?.error.code).toBe("runtime_state_unavailable");
  });

  it("rejects a persisted official snapshot with a forged member digest on reopen", async () => {
    const { database, path } = await openDatabase();
    await sourceSnapshot(database);
    database.close();

    const raw = new Database(path);
    expect(raw.prepare("UPDATE robinhood_asset_snapshot SET member_set_digest = ?")
      .run(`0x${"ff".repeat(32)}`).changes).toBe(1);
    raw.close();

    let failure: unknown;
    try { await ProductDatabase.open(path, now); }
    catch (error) { failure = error; }
    expect(getRuntimeOperationFailure(failure)?.error.code).toBe("runtime_state_unavailable");
  });

  it("binds each default verification to the persisted source member identity", async () => {
    const { database, connection } = await openDatabase();
    const first = defaultStockTokenManifest.assets[0]!;
    const observation = await sourceObservation([], {
      [first.contractAddress]: `0x${"fe".repeat(32)}`,
    });
    const snapshot = database.officialAssetSnapshotStore().replaceSnapshot(observation, null);
    const store = database.accountTokenSelectionStore();
    const verifiedDefaults = defaultStockTokenManifest.assets.map((entry) => ({
      asset: { kind: "erc20" as const, chainId, address: entry.contractAddress },
      verification: verification(entry.assetUid, entry.contractAddress),
    }));

    expect(failureCode(() => store.initializeDefaults({
      account,
      expectedConnectionRevision: connection.revision,
      snapshotRevision: snapshot.revision,
      verifiedDefaults,
      now,
    }))).toBe("state_conflict");
    expect(store.getState(account)).toBeUndefined();
    for (const entry of verifiedDefaults) {
      expect(store.getForAccount({ account, asset: entry.asset })).toBeUndefined();
    }
    database.close();
  });

  it("initializes exactly the verified default set once and preserves an explicit exclusion", async () => {
    const { database, connection } = await openDatabase();
    const snapshot = await sourceSnapshot(database);
    const store = database.accountTokenSelectionStore();
    const verifiedDefaults = defaultStockTokenManifest.assets.map((entry) => ({
      asset: { kind: "erc20" as const, chainId, address: entry.contractAddress },
      verification: verification(entry.assetUid, entry.contractAddress),
    }));
    const initialized = store.initializeDefaults({
      account,
      expectedConnectionRevision: connection.revision,
      snapshotRevision: snapshot.revision,
      verifiedDefaults,
      now,
    });
    expect(initialized.state.defaultsInitialized).toBe(true);
    expect(initialized.selections.map((entry) => entry.asset.address)).toEqual(
      defaultStockTokenManifest.assets.map((entry) => entry.contractAddress),
    );

    const catalog = database.tokenCatalogStore();
    const excluded = catalog.getSelection(account, initialized.selections[0]!.asset)!;
    const removal = applyingOperation({
      kind: "remove",
      connectionRevision: connection.revision,
      asset: excluded.selection.asset,
      previousSelection: excluded.selection,
      currentSetRevision: initialized.state.revision,
      inspection: null,
      snapshotRevision: null,
    });
    apply(catalog, {
      kind: "remove",
      connectionRevision: connection.revision,
      operation: removal,
      selectionRevision: selectionRevision(10),
      selectionSetRevision: setRevision(11),
    });
    expect(catalog.getSelection(account, excluded.selection.asset)?.selection.included).toBe(false);

    const repeated = store.initializeDefaults({
      account,
      expectedConnectionRevision: connection.revision,
      snapshotRevision: snapshot.revision,
      verifiedDefaults: [],
      now: later,
    });
    expect(repeated.selections).toEqual([]);
    expect(catalog.getSelection(account, excluded.selection.asset)?.selection.included).toBe(false);
    database.close();
  });

  it("rejects every forged fixed StockFactory identity before default initialization becomes durable", async () => {
    const { database, connection } = await openDatabase();
    const snapshot = await sourceSnapshot(database);
    const store = database.accountTokenSelectionStore();
    const verifiedDefaults = defaultStockTokenManifest.assets.map((entry) => ({
      asset: { kind: "erc20" as const, chainId, address: entry.contractAddress },
      verification: verification(entry.assetUid, entry.contractAddress),
    }));
    const first = verifiedDefaults[0]!;

    for (const forgedVerification of [
      {
        ...first.verification,
        proxyAddress: parseEvmAddressInput(`0x${"aa".repeat(20)}`),
      },
      {
        ...first.verification,
        proxyCodeHash: parseHash32(`0x${"bb".repeat(32)}`),
      },
      {
        ...first.verification,
        implementationAddress: parseEvmAddressInput(`0x${"cc".repeat(20)}`),
      },
      {
        ...first.verification,
        implementationCodeHash: parseHash32(`0x${"dd".repeat(32)}`),
      },
    ] as const) {
      expect(failureCode(() => store.initializeDefaults({
        account,
        expectedConnectionRevision: connection.revision,
        snapshotRevision: snapshot.revision,
        verifiedDefaults: [
          { ...first, verification: forgedVerification },
          ...verifiedDefaults.slice(1),
        ],
        now,
      }))).toBe("state_conflict");
      expect(store.getState(account)).toBeUndefined();
      for (const entry of verifiedDefaults) {
        expect(store.getForAccount({ account, asset: entry.asset })).toBeUndefined();
      }
    }
    database.close();
  });

  it("toggles one custom asset without deleting its account-scoped selection identity", async () => {
    const { database, path, connection } = await openDatabase();
    const snapshot = await sourceSnapshot(database);
    const store = database.tokenCatalogStore();
    const input = {
      asset: {
        kind: "erc20",
        chainId,
        address: parseEvmAddressInput(`0x${"88".repeat(20)}`),
      },
      block: { kind: "latest" },
    } as const;
    const inspections = await Promise.all([
      createInspectionSuccess(input, { name: "First same-time inspection" }),
      createInspectionSuccess(input, { name: "Second same-time inspection" }),
    ]);
    const [inspection, reinspection] = inspections.sort((left, right) =>
      tokenInspectionDigest(right).localeCompare(tokenInspectionDigest(left)));
    if (inspection === undefined || reinspection === undefined ||
      inspection.meta.evaluatedAt !== reinspection.meta.evaluatedAt ||
      tokenInspectionDigest(inspection) <= tokenInspectionDigest(reinspection)) {
      throw new TypeError("Same-time inspection counterexample is invalid.");
    }
    const addOperation = applyingOperation({
      kind: "add",
      connectionRevision: connection.revision,
      asset: inspection.data.asset,
      previousSelection: null,
      currentSetRevision: null,
      inspection,
      snapshotRevision: snapshot.revision,
    });
    const added = apply(store, {
      kind: "add",
      connectionRevision: connection.revision,
      operation: addOperation,
      selectionRevision: selectionRevision(1),
      selectionSetRevision: setRevision(2),
    });
    expect(added).toMatchObject({ state: "completed", result: { selection: { included: true } } });
    const first = store.getSelection(account, inspection.data.asset)!;

    const removeOperation = applyingOperation({
      kind: "remove",
      connectionRevision: connection.revision,
      asset: inspection.data.asset,
      previousSelection: first.selection,
      currentSetRevision: store.getSelectionState(account)!.revision,
      inspection: null,
      snapshotRevision: null,
    });
    apply(store, {
      kind: "remove",
      connectionRevision: connection.revision,
      operation: removeOperation,
      selectionRevision: selectionRevision(3),
      selectionSetRevision: setRevision(4),
    });
    const excluded = store.getSelection(account, inspection.data.asset)!;
    expect(excluded.selection).toMatchObject({ included: false, createdAt: first.selection.createdAt });
    expect(database.accountTokenSelectionStore().listIncludedForAccount({
      account, limit: 25, cursor: null, excludedAddresses: [],
    }).selections).toEqual([]);

    const readdOperation = applyingOperation({
      kind: "add",
      connectionRevision: connection.revision,
      asset: reinspection.data.asset,
      previousSelection: excluded.selection,
      currentSetRevision: store.getSelectionState(account)!.revision,
      inspection: reinspection,
      snapshotRevision: snapshot.revision,
    });
    const restored = apply(store, {
      kind: "add",
      connectionRevision: connection.revision,
      operation: readdOperation,
      selectionRevision: selectionRevision(5),
      selectionSetRevision: setRevision(6),
    });
    if (restored.state !== "completed" || restored.result === null) {
      throw new TypeError("Same-time re-addition did not complete.");
    }
    expect(restored.result.selection).toMatchObject({
      included: true,
      createdAt: first.selection.createdAt,
    });
    expect(tokenInspectionDigest(restored.result.historicalInspection))
      .toBe(tokenInspectionDigest(reinspection));

    const raw = new Database(path, { readonly: true });
    expect(raw.prepare("SELECT COUNT(*) AS count FROM wallet_token_selection").get()).toEqual({ count: 1 });
    expect(raw.prepare("SELECT COUNT(*) AS count FROM token_contract_inspection").get()).toEqual({ count: 2 });
    raw.close();
    database.close();
  });

  it("preserves account choices across both official-classification directions", async () => {
    const { database, connection } = await openDatabase();
    let snapshot = await sourceSnapshot(database);
    const store = database.tokenCatalogStore();
    const firstAddress = parseEvmAddressInput(`0x${"91".repeat(20)}`);
    const secondAddress = parseEvmAddressInput(`0x${"92".repeat(20)}`);
    const neverSelectedAddress = parseEvmAddressInput(`0x${"93".repeat(20)}`);
    const sourceEntry = (address: string, byte: string, symbol: string) => ({
      id: `0x${byte.repeat(32)}`,
      contractAddress: address,
      tokenName: `${symbol} Stock Token`,
      tokenSymbol: symbol,
    });
    const firstSource = sourceEntry(firstAddress, "91", "ONE");
    const secondSource = sourceEntry(secondAddress, "92", "TWO");
    const neverSelectedSource = sourceEntry(neverSelectedAddress, "93", "NEW");
    const firstInspection = await createInspectionSuccess({
      asset: { kind: "erc20", chainId, address: firstAddress },
      block: { kind: "latest" },
    });
    const firstAdd = applyingOperation({
      kind: "add",
      connectionRevision: connection.revision,
      asset: firstInspection.data.asset,
      previousSelection: null,
      currentSetRevision: null,
      inspection: firstInspection,
      snapshotRevision: snapshot.revision,
    });
    apply(store, {
      kind: "add",
      connectionRevision: connection.revision,
      operation: firstAdd,
      selectionRevision: selectionRevision(20),
      selectionSetRevision: setRevision(21),
    });
    const firstSelection = store.getSelection(account, firstInspection.data.asset)!.selection;

    snapshot = database.officialAssetSnapshotStore().replaceSnapshot(
      await sourceObservation([firstSource, neverSelectedSource]),
      snapshot.revision,
    );
    expect(store.getSelection(account, firstInspection.data.asset)?.selection).toEqual(firstSelection);
    expect(store.getSelection(account, {
      kind: "erc20", chainId, address: neverSelectedAddress,
    })).toBeUndefined();

    snapshot = database.officialAssetSnapshotStore().replaceSnapshot(
      await sourceObservation(),
      snapshot.revision,
    );
    expect(store.getSelection(account, firstInspection.data.asset)?.selection).toEqual(firstSelection);

    snapshot = database.officialAssetSnapshotStore().replaceSnapshot(
      await sourceObservation([firstSource]),
      snapshot.revision,
    );
    const firstRemove = applyingOperation({
      kind: "remove",
      connectionRevision: connection.revision,
      asset: firstInspection.data.asset,
      previousSelection: firstSelection,
      currentSetRevision: store.getSelectionState(account)!.revision,
      inspection: null,
      snapshotRevision: null,
    });
    apply(store, {
      kind: "remove",
      connectionRevision: connection.revision,
      operation: firstRemove,
      selectionRevision: selectionRevision(22),
      selectionSetRevision: setRevision(23),
    });
    snapshot = database.officialAssetSnapshotStore().replaceSnapshot(
      await sourceObservation(),
      snapshot.revision,
    );
    expect(store.getSelection(account, firstInspection.data.asset)?.selection.included).toBe(false);

    const secondInspection = await createInspectionSuccess({
      asset: { kind: "erc20", chainId, address: secondAddress },
      block: { kind: "latest" },
    });
    const secondAdd = applyingOperation({
      kind: "add",
      connectionRevision: connection.revision,
      asset: secondInspection.data.asset,
      previousSelection: null,
      currentSetRevision: store.getSelectionState(account)!.revision,
      inspection: secondInspection,
      snapshotRevision: snapshot.revision,
    });
    apply(store, {
      kind: "add",
      connectionRevision: connection.revision,
      operation: secondAdd,
      selectionRevision: selectionRevision(24),
      selectionSetRevision: setRevision(25),
    });
    const secondSelection = store.getSelection(account, secondInspection.data.asset)!.selection;
    const secondRemove = applyingOperation({
      kind: "remove",
      connectionRevision: connection.revision,
      asset: secondInspection.data.asset,
      previousSelection: secondSelection,
      currentSetRevision: store.getSelectionState(account)!.revision,
      inspection: null,
      snapshotRevision: null,
    });
    apply(store, {
      kind: "remove",
      connectionRevision: connection.revision,
      operation: secondRemove,
      selectionRevision: selectionRevision(26),
      selectionSetRevision: setRevision(27),
    });
    snapshot = database.officialAssetSnapshotStore().replaceSnapshot(
      await sourceObservation([secondSource, neverSelectedSource]),
      snapshot.revision,
    );
    expect(store.getSelection(account, secondInspection.data.asset)?.selection.included).toBe(false);
    expect(store.getSelection(account, {
      kind: "erc20", chainId, address: neverSelectedAddress,
    })).toBeUndefined();
    database.close();
  });

  it("rejects stale connection, selection, and selection-set revisions before durable change", async () => {
    const { database, connection } = await openDatabase();
    const snapshot = await sourceSnapshot(database);
    const inspection = await createInspectionSuccess({
      asset: {
        kind: "erc20",
        chainId,
        address: parseEvmAddressInput(`0x${"77".repeat(20)}`),
      },
      block: { kind: "latest" },
    });
    const store = database.tokenCatalogStore();
    const operation = applyingOperation({
      kind: "add",
      connectionRevision: connection.revision,
      asset: inspection.data.asset,
      previousSelection: null,
      currentSetRevision: null,
      inspection,
      snapshotRevision: snapshot.revision,
    });
    expect(failureCode(() => apply(store, {
      kind: "add",
      connectionRevision: "0",
      operation,
      selectionRevision: selectionRevision(5),
      selectionSetRevision: setRevision(6),
    }))).toBe("state_conflict");
    expect(store.getSelection(account, inspection.data.asset)).toBeUndefined();

    apply(store, {
      kind: "add",
      connectionRevision: connection.revision,
      operation,
      selectionRevision: selectionRevision(5),
      selectionSetRevision: setRevision(6),
    });
    expect(failureCode(() => apply(store, {
      kind: "add",
      connectionRevision: connection.revision,
      operation,
      selectionRevision: selectionRevision(7),
      selectionSetRevision: setRevision(8),
    }))).toBe("token_selection_revision_changed");
    expect(store.getSelection(account, inspection.data.asset)?.selection.revision).toBe(selectionRevision(5));
    database.close();
  });

  it("rejects every internal official anchor mismatch before durable mutation", async () => {
    const { database, path, connection } = await openDatabase();
    const snapshot = await sourceSnapshot(database);
    const manifestEntry = defaultStockTokenManifest.assets[0];
    if (manifestEntry === undefined) throw new TypeError("Default token manifest is empty.");
    const inspection = await createInspectionSuccess({
      asset: {
        kind: "erc20",
        chainId,
        address: manifestEntry.contractAddress,
      },
      block: { kind: "latest" },
    });
    const correctVerification = verification(
      manifestEntry.assetUid,
      manifestEntry.contractAddress,
      inspection.data.analysis.block,
    );
    const operation = applyingOperation({
      kind: "add",
      connectionRevision: connection.revision,
      asset: inspection.data.asset,
      previousSelection: null,
      currentSetRevision: null,
      inspection,
      snapshotRevision: snapshot.revision,
      officialEvidence: {
        assetUid: manifestEntry.assetUid,
        snapshotRevision: snapshot.revision,
        verificationBlock: inspection.data.analysis.block,
      },
    });
    const anchorMutations = [
      { field: "chainId", value: "eip155:1" },
      { field: "blockNumber", value: "43" },
      { field: "blockHash", value: `0x${"cd".repeat(32)}` },
      { field: "blockTimestamp", value: "2026-07-18T00:00:01.000Z" },
    ] as const;
    const store = database.tokenCatalogStore();

    for (const mutation of anchorMutations) {
      const mismatchedVerification = {
        ...correctVerification,
        block: {
          ...correctVerification.block,
          [mutation.field]: mutation.value,
        },
      } as StockFactoryVerification;
      expect(failureCode(() => apply(store, {
        kind: "add",
        connectionRevision: connection.revision,
        operation,
        selectionRevision: selectionRevision(40),
        selectionSetRevision: setRevision(41),
        officialVerification: mismatchedVerification,
      }))).toBe("state_conflict");
      expect(store.getSelection(account, inspection.data.asset)).toBeUndefined();
      expect(store.getSelectionState(account)).toBeUndefined();
      const raw = new Database(path, { readonly: true });
      expect(raw.prepare("SELECT COUNT(*) AS count FROM token_contract_inspection").get())
        .toEqual({ count: 0 });
      raw.close();
    }

    for (const forgedVerification of [
      {
        ...correctVerification,
        proxyAddress: parseEvmAddressInput(`0x${"aa".repeat(20)}`),
      },
      {
        ...correctVerification,
        proxyCodeHash: parseHash32(`0x${"bb".repeat(32)}`),
      },
      {
        ...correctVerification,
        implementationAddress: parseEvmAddressInput(`0x${"cc".repeat(20)}`),
      },
      {
        ...correctVerification,
        implementationCodeHash: parseHash32(`0x${"dd".repeat(32)}`),
      },
    ] as const) {
      expect(failureCode(() => apply(store, {
        kind: "add",
        connectionRevision: connection.revision,
        operation,
        selectionRevision: selectionRevision(40),
        selectionSetRevision: setRevision(41),
        officialVerification: forgedVerification,
      }))).toBe("state_conflict");
      expect(store.getSelection(account, inspection.data.asset)).toBeUndefined();
      expect(store.getSelectionState(account)).toBeUndefined();
    }

    const completed = apply(store, {
      kind: "add",
      connectionRevision: connection.revision,
      operation,
      selectionRevision: selectionRevision(40),
      selectionSetRevision: setRevision(41),
      officialVerification: correctVerification,
    });
    expect(completed).toMatchObject({
      state: "completed",
      result: { selection: { included: true } },
    });
    expect(store.getSelection(account, inspection.data.asset)?.selection.included).toBe(true);
    const raw = new Database(path, { readonly: true });
    expect(raw.prepare("SELECT COUNT(*) AS count FROM token_contract_inspection").get())
      .toEqual({ count: 1 });
    raw.close();
    database.close();
  });

  it("keeps the selection, account, and official snapshot parents restrictive", async () => {
    const { database, path, connection } = await openDatabase();
    const snapshot = await sourceSnapshot(database);
    const defaults = defaultStockTokenManifest.assets.map((entry) => ({
      asset: { kind: "erc20" as const, chainId, address: entry.contractAddress },
      verification: verification(entry.assetUid, entry.contractAddress),
    }));
    database.accountTokenSelectionStore().initializeDefaults({
      account,
      expectedConnectionRevision: connection.revision,
      snapshotRevision: snapshot.revision,
      verifiedDefaults: defaults,
      now,
    });
    const raw = new Database(path);
    expect(() => raw.prepare("DELETE FROM wallet_account WHERE chain_id = ? AND wallet_address = ?")
      .run(chainId, walletAddress)).toThrow();
    expect(raw.prepare("DELETE FROM robinhood_asset_snapshot WHERE chain_id = ?").run(chainId).changes).toBe(1);
    expect(raw.prepare("SELECT COUNT(*) AS count FROM robinhood_asset").get()).toEqual({ count: 0 });
    expect(raw.prepare("SELECT COUNT(*) AS count FROM wallet_token_selection").get()).toEqual({ count: 5 });
    expect(raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(raw.pragma("integrity_check", { simple: true })).toBe("ok");
    raw.close();
    database.close();
  });
});
