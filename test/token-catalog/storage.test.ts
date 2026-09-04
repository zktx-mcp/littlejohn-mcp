import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";

import {
  canonicalJsonStringify,
  captureCanonicalJson,
  chainAnchorSchema,
  contractAnalysisSchema,
  parseCapabilityDataAt,
  parseEvmAddressInput,
  parseEvmChainId,
  parseHash32,
  parseUtcTimestamp,
  walletConnectionCapability,
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
import {
  ProductDatabase,
  selectTokenInspectionRetentionVictims,
  type TokenInspectionRetentionEntry,
} from "../../src/runtime/database.js";
import { getRuntimeOperationFailure } from "../../src/runtime/errors.js";
import { ensureOwnerOnlyDirectory, runtimePaths } from "../../src/runtime/paths.js";
import {
  hasExactCurrentSqliteStructure,
  tokenInspectionPersistenceLimits,
} from "../../src/runtime/sqlite-schema.js";
import {
  createTokenAdditionReviewProjection,
  parseTokenCatalogOperation,
  parseTokenSelectionReview,
  tokenCatalogOperationIdSchema,
  tokenInspectionDigest,
  tokenSelectionReviewDigest,
  tokenSelectionRevisionSchema,
  tokenSelectionSetRevisionSchema,
  type TokenInspectionSuccess,
  type TokenSelection,
  type TokenSelectionDirectAction,
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

const operationBoundaryAsset = parseEvmAddressInput(`0x${"12".repeat(20)}`);
const operationBoundaryBlock = chainAnchorSchema.parse({
  chainId,
  blockNumber: "42",
  blockHash: `0x${"ab".repeat(32)}`,
  blockTimestamp: "2026-07-18T00:00:00.000Z",
});
const operationBoundaryInspection = async (
  lastSignatureLength: number,
  signatureCount = 48,
): Promise<TokenInspectionSuccess> => {
  const base = createExactResolvedAnalysis(operationBoundaryAsset, operationBoundaryBlock);
  if (base.declaredFunctions.status !== "observed") {
    throw new TypeError("Operation boundary analysis is incomplete.");
  }
  const filler = Array.from({ length: signatureCount }, (_, index) =>
    `z${String(index).padStart(4, "0")}_${"a".repeat(
      index === signatureCount - 1 ? lastSignatureLength : 994,
    )}`);
  const analysis = contractAnalysisSchema.parse({
    ...base,
    declaredFunctions: {
      status: "observed",
      signatures: [...base.declaredFunctions.signatures, ...filler].sort(),
    },
  });
  return createInspectionSuccess({
    asset: { kind: "erc20", chainId, address: operationBoundaryAsset },
    block: { kind: "latest" },
  }, { analysis });
};

const canonicalByteLength = (value: unknown): number => Buffer.byteLength(
  canonicalJsonStringify(captureCanonicalJson(value)),
  "utf8",
);

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

const independentTokenInspectionDigest = (result: IndependentJson): string =>
  `0x${createHash("sha256").update(independentCanonicalJson({
    digestKind: "token_inspection",
    digestVersion: "1",
    result,
  }), "utf8").digest("hex")}`;

const expectedTokenInspectionPersistenceLimits = Object.freeze({
  resultBytes: 65_536,
  rows: 4_096,
  aggregateResultBytes: 67_108_864,
});

const retentionEntryFor = (input: Readonly<{
  chain: number;
  contract: number;
  digest: number;
  byteLength: number;
}>): TokenInspectionRetentionEntry => Object.freeze({
  chainId: parseEvmChainId(`eip155:${input.chain}`),
  contractAddress: parseEvmAddressInput(`0x${input.contract.toString(16).padStart(40, "0")}`),
  inspectionDigest: parseHash32(`0x${input.digest.toString(16).padStart(64, "0")}`),
  byteLength: input.byteLength,
});

const compareTestText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const compareRetentionEntries = (
  left: TokenInspectionRetentionEntry,
  right: TokenInspectionRetentionEntry,
): number => compareTestText(left.chainId, right.chainId) ||
  compareTestText(left.contractAddress, right.contractAddress) ||
  compareTestText(left.inspectionDigest, right.inspectionDigest);

const retentionIdentity = (entry: TokenInspectionRetentionEntry): string =>
  `${entry.chainId}\0${entry.contractAddress}\0${entry.inspectionDigest}`;

const expectedRetentionVictims = (
  entries: readonly TokenInspectionRetentionEntry[],
  candidate: TokenInspectionRetentionEntry,
): readonly TokenInspectionRetentionEntry[] => {
  const identities = new Set(entries.map(retentionIdentity));
  if (identities.size !== entries.length || identities.has(retentionIdentity(candidate))) {
    throw new TypeError("Independent retention fixture identity is invalid.");
  }
  let retainedRows = entries.length + 1;
  let retainedBytes = entries.reduce((total, entry) => total + entry.byteLength, 0) +
    candidate.byteLength;
  const victims: TokenInspectionRetentionEntry[] = [];
  for (const entry of [...entries].sort(compareRetentionEntries)) {
    if (
      retainedRows <= expectedTokenInspectionPersistenceLimits.rows &&
      retainedBytes <= expectedTokenInspectionPersistenceLimits.aggregateResultBytes
    ) break;
    victims.push(entry);
    retainedRows -= 1;
    retainedBytes -= entry.byteLength;
  }
  if (
    retainedRows > expectedTokenInspectionPersistenceLimits.rows ||
    retainedBytes > expectedTokenInspectionPersistenceLimits.aggregateResultBytes
  ) throw new TypeError("Independent retention fixture cannot admit its candidate.");
  return Object.freeze(victims);
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
  }, now), false, now);
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
  const result = await createRobinhoodOfficialAssetSourceClient({
    fetch: (async () => new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch,
    now: () => new Date(now),
  }).read(new AbortController().signal);
  if (result.status !== "observed") throw new Error("Expected source observation.");
  return result.observation;
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

const selectionAction = (input: Readonly<{
  kind: "add" | "remove";
  account?: EvmAccountIdentity;
  connectionRevision: string;
  asset: TokenSelection["asset"];
  previousSelection: TokenSelection | null;
  currentSetRevision: ReturnType<typeof tokenSelectionSetRevisionSchema.parse> | null;
  inspection: TokenInspectionSuccess | null;
  snapshotRevision: Parameters<
    typeof createTokenAdditionReviewProjection
  >[0]["officialSnapshotRevision"] | null;
  officialMember?: Parameters<typeof createTokenAdditionReviewProjection>[0]["officialMember"];
  officialVerification?: StockFactoryVerification | null;
}>): Readonly<{
  action: TokenSelectionDirectAction;
  inspection: TokenInspectionSuccess | null;
}> => {
  const targetAccount = input.account ?? account;
  const id = operationId();
  const withoutDigest = input.kind === "add"
    ? {
        contractVersion: "1" as const,
        domain: "token_selection" as const,
        operationId: id,
        kind: input.kind,
        createdAt: now,
        actionExpiresAt: "2026-07-21T00:05:00.000Z",
        target: { asset: input.asset },
        precondition: {
          account: targetAccount,
          connectionRevision: input.connectionRevision,
          previousSelection: input.previousSelection,
          selectionSetRevision: input.currentSetRevision,
        },
        ...createTokenAdditionReviewProjection({
          inspection: input.inspection!,
          officialSnapshotRevision: input.snapshotRevision!,
          officialMember: input.officialMember ?? null,
          officialVerification: input.officialVerification ?? null,
        }),
      }
    : {
        contractVersion: "1" as const,
        domain: "token_selection" as const,
        operationId: id,
        kind: input.kind,
        createdAt: now,
        actionExpiresAt: "2026-07-21T00:05:00.000Z",
        target: { asset: input.asset },
        decision: { action: "remove_selection" as const },
        precondition: {
          account: targetAccount,
          connectionRevision: input.connectionRevision,
          previousSelection: input.previousSelection,
          selectionSetRevision: input.currentSetRevision,
        },
        fixedEvidence: {},
      };
  const review = parseTokenSelectionReview({
    ...withoutDigest,
    reviewDigest: tokenSelectionReviewDigest(withoutDigest),
  });
  return Object.freeze({
    action: Object.freeze({ review, initiatedBy: "cli" }),
    inspection: input.inspection,
  });
};

const apply = (store: TokenCatalogStore, input: Readonly<{
  action: ReturnType<typeof selectionAction>;
  selectionRevision: ReturnType<typeof tokenSelectionRevisionSchema.parse>;
  selectionSetRevision: ReturnType<typeof tokenSelectionSetRevisionSchema.parse>;
  officialVerification?: StockFactoryVerification | null;
}>) => store.applySelectionChange({
  action: input.action.action,
  selectionRevision: input.selectionRevision,
  selectionSetRevision: input.selectionSetRevision,
  inspection: input.action.inspection,
  officialVerification: input.officialVerification ?? null,
  completedAt: later,
});

const operationForAction = (input: Readonly<{
  action: ReturnType<typeof selectionAction>["action"];
  inspection: TokenInspectionSuccess;
  selectionRevision: ReturnType<typeof tokenSelectionRevisionSchema.parse>;
  selectionSetRevision: ReturnType<typeof tokenSelectionSetRevisionSchema.parse>;
}>) => parseTokenCatalogOperation({
  contractVersion: "1",
  domain: "token_selection",
  operationId: input.action.review.operationId,
  kind: "add",
  initiatedBy: input.action.initiatedBy,
  review: input.action.review,
  state: "completed",
  completedAt: later,
  result: {
    outcome: "selection_added",
    selectionSetRevision: input.selectionSetRevision,
    selection: {
      selection: {
        account,
        asset: input.inspection.data.asset,
        included: true,
        revision: input.selectionRevision,
        createdAt: later,
        updatedAt: later,
      },
      historicalInspection: input.inspection,
    },
  },
});

const failureCode = (effect: () => unknown): string | undefined => {
  try { effect(); return undefined; }
  catch (error) { return getTokenCatalogOperationFailure(error)?.error.code; }
};

describe("token selection persistence", () => {
  it("owns deterministic Token inspection retention across row and aggregate limits", () => {
    expect(tokenInspectionPersistenceLimits).toEqual(expectedTokenInspectionPersistenceLimits);

    const chainFirst = retentionEntryFor({ chain: 1, contract: 0x11, digest: 0x11, byteLength: 2 });
    const sameContractLaterDigest = retentionEntryFor({
      chain: 1, contract: 0x11, digest: 0xff, byteLength: 2,
    });
    const digestFirstWithoutContract = retentionEntryFor({
      chain: 1, contract: 0x22, digest: 0, byteLength: 2,
    });
    const contractFirstWithoutChain = retentionEntryFor({
      chain: 4663, contract: 0, digest: 0, byteLength: 2,
    });
    const rowFillers = Array.from({ length: 4_092 }, (_, index) => retentionEntryFor({
      chain: 999_999,
      contract: 1_000_000 + index,
      digest: 2_000_000 + index,
      byteLength: 2,
    }));
    const candidateBeforeAll = retentionEntryFor({ chain: 1, contract: 0, digest: 0, byteLength: 2 });
    const candidateWithin = retentionEntryFor({ chain: 1, contract: 0x20, digest: 0, byteLength: 2 });
    const candidateAfterAll = retentionEntryFor({
      chain: 999_999, contract: 9_000_000, digest: 9_000_000, byteLength: 2,
    });
    const rowBoundary = [
      sameContractLaterDigest,
      chainFirst,
      digestFirstWithoutContract,
      contractFirstWithoutChain,
      ...rowFillers,
    ];
    for (const candidate of [candidateBeforeAll, candidateWithin, candidateAfterAll]) {
      expect(expectedRetentionVictims(rowBoundary, candidate)).toEqual([chainFirst]);
      expect(selectTokenInspectionRetentionVictims(rowBoundary, candidate))
        .toEqual([chainFirst]);
    }

    const smallCanonicalVictim = retentionEntryFor({
      chain: 1, contract: 1, digest: 1, byteLength: 2,
    });
    const largeCanonicalVictim = retentionEntryFor({
      chain: 1, contract: 2, digest: 2, byteLength: 65_536,
    });
    const adjustedAggregateEntry = retentionEntryFor({
      chain: 1, contract: 3, digest: 3, byteLength: 65_534,
    });
    const aggregateFillers = Array.from({ length: 1_022 }, (_, index) => retentionEntryFor({
      chain: 1,
      contract: index + 4,
      digest: index + 4,
      byteLength: 65_536,
    }));
    const aggregateBoundary = [
      aggregateFillers[0]!,
      smallCanonicalVictim,
      largeCanonicalVictim,
      adjustedAggregateEntry,
      ...aggregateFillers.slice(1),
    ];
    const largeCandidate = retentionEntryFor({
      chain: 4663, contract: 8_000, digest: 8_000, byteLength: 65_536,
    });
    expect(aggregateBoundary.reduce((total, entry) => total + entry.byteLength, 0))
      .toBe(expectedTokenInspectionPersistenceLimits.aggregateResultBytes);
    expect(expectedRetentionVictims(aggregateBoundary, largeCandidate))
      .toEqual([smallCanonicalVictim, largeCanonicalVictim]);
    expect(selectTokenInspectionRetentionVictims(aggregateBoundary, largeCandidate))
      .toEqual([smallCanonicalVictim, largeCanonicalVictim]);

    const arbitraryEntry = fc.record({
      chain: fc.integer({ min: 1, max: 1_000 }),
      contract: fc.integer({ min: 0, max: 999_999 }),
      digest: fc.integer({ min: 0, max: 999_999 }),
      byteLength: fc.integer({ min: 2, max: 65_536 }),
    });
    fc.assert(fc.property(fc.record({
      entries: fc.array(arbitraryEntry, { minLength: 0, maxLength: 12 }),
      candidate: arbitraryEntry,
      pressure: fc.boolean(),
      reverse: fc.boolean(),
      rotation: fc.integer({ min: 0, max: 4_095 }),
    }).filter(({ entries, candidate }) => {
      const identities = entries.map(({ chain, contract, digest }) =>
        `${chain}\0${contract}\0${digest}`);
      const candidateIdentity = `${candidate.chain}\0${candidate.contract}\0${candidate.digest}`;
      return new Set(identities).size === identities.length &&
        !identities.includes(candidateIdentity);
    }), ({ entries: entryInputs, candidate: candidateInput, pressure, reverse, rotation }) => {
      const generatedEntries = entryInputs.map(retentionEntryFor);
      const fillers = pressure
        ? Array.from({
            length: expectedTokenInspectionPersistenceLimits.rows - generatedEntries.length,
          }, (_, index) => retentionEntryFor({
            chain: 999_999,
            contract: 2_000_000 + index,
            digest: 3_000_000 + index,
            byteLength: 2,
          }))
        : [];
      const orderedInput = [...generatedEntries, ...fillers];
      const pivot = orderedInput.length === 0 ? 0 : rotation % orderedInput.length;
      const rotated = [...orderedInput.slice(pivot), ...orderedInput.slice(0, pivot)];
      const presentedEntries = reverse ? rotated.reverse() : rotated;
      const candidate = retentionEntryFor(candidateInput);
      const expected = expectedRetentionVictims(presentedEntries, candidate);
      const victims = selectTokenInspectionRetentionVictims(presentedEntries, candidate);
      expect(victims).toEqual(expected);
      expect(victims.map(retentionIdentity)).not.toContain(retentionIdentity(candidate));
      const retainedRows = presentedEntries.length - victims.length + 1;
      const retainedBytes = presentedEntries.reduce(
        (total, entry) => total + entry.byteLength,
        candidate.byteLength,
      ) - victims.reduce((total, entry) => total + entry.byteLength, 0);
      expect(retainedRows).toBeLessThanOrEqual(expectedTokenInspectionPersistenceLimits.rows);
      expect(retainedBytes)
        .toBeLessThanOrEqual(expectedTokenInspectionPersistenceLimits.aggregateResultBytes);
    }));
  });

  it("keeps exact operation delivery and removal independent of retained inspection size", async () => {
    const { database, connection } = await openDatabase();
    const snapshot = await sourceSnapshot(database);
    const inspection = await operationBoundaryInspection(881);
    expect(canonicalByteLength(inspection)).toBe(63_800);
    const store = database.tokenCatalogStore();
    const addition = selectionAction({
      kind: "add",
      connectionRevision: connection.revision,
      asset: inspection.data.asset,
      previousSelection: null,
      currentSetRevision: null,
      inspection,
      snapshotRevision: snapshot.revision,
    });
    const added = apply(store, {
      action: addition,
      selectionRevision: selectionRevision(60),
      selectionSetRevision: setRevision(61),
    });
    expect(canonicalByteLength(added)).toBe(65_535);
    expect(store.readOperation(added.operationId)).toEqual(added);

    const current = store.getSelection(account, inspection.data.asset);
    expect(current?.historicalInspection).toEqual(inspection);
    if (current === undefined) throw new TypeError("Boundary selection is unavailable.");
    const removal = selectionAction({
      kind: "remove",
      connectionRevision: connection.revision,
      asset: inspection.data.asset,
      previousSelection: current.selection,
      currentSetRevision: store.getSelectionState(account)?.revision ?? null,
      inspection: null,
      snapshotRevision: null,
    });
    const removed = apply(store, {
      action: removal,
      selectionRevision: selectionRevision(62),
      selectionSetRevision: setRevision(63),
    });
    expect(removed.result.selection.historicalInspection).toBeNull();
    expect(canonicalByteLength(removed)).toBeLessThan(65_535);
    expect(store.getSelection(account, inspection.data.asset)?.historicalInspection)
      .toEqual(inspection);
    database.close();
  });

  it("rejects a produced one-over operation without committing any catalog row", async () => {
    const { database, path, connection } = await openDatabase();
    const snapshot = await sourceSnapshot(database);
    const inspection = await operationBoundaryInspection(882);
    expect(canonicalByteLength(inspection)).toBe(63_801);
    const store = database.tokenCatalogStore();
    const addition = selectionAction({
      kind: "add",
      connectionRevision: connection.revision,
      asset: inspection.data.asset,
      previousSelection: null,
      currentSetRevision: null,
      inspection,
      snapshotRevision: snapshot.revision,
    });
    const nextSelectionRevision = selectionRevision(64);
    const nextSetRevision = setRevision(65);
    const oneOverOperation = operationForAction({
      action: addition.action,
      inspection,
      selectionRevision: nextSelectionRevision,
      selectionSetRevision: nextSetRevision,
    });
    expect(canonicalByteLength(oneOverOperation)).toBe(65_536);
    let failure: unknown;
    try {
      apply(store, {
        action: addition,
        selectionRevision: nextSelectionRevision,
        selectionSetRevision: nextSetRevision,
      });
    } catch (error) { failure = error; }
    expect(getTokenCatalogOperationFailure(failure)).toMatchObject({
      error: { code: "result_too_large", retryable: false },
    });
    const raw = new Database(path, { readonly: true });
    for (const table of [
      "contract",
      "token_contract",
      "token_contract_inspection",
      "wallet_token_selection_state",
      "wallet_token_selection",
      "token_selection_operation",
    ]) expect(raw.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(), table)
      .toEqual({ count: 0 });
    raw.close();
    const profileId = database.ownerStore().readProfile().profileId;
    database.close();

    const existing = new Database(path);
    const insert = existing.prepare(`INSERT INTO token_selection_operation(
      profile_id, operation_id, kind, initiated_by, review_digest,
      chain_id, wallet_address, token_address, operation_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const parameters = [
      profileId,
      oneOverOperation.operationId,
      oneOverOperation.kind,
      oneOverOperation.initiatedBy,
      oneOverOperation.review.reviewDigest,
      account.chainId,
      account.address,
      oneOverOperation.result.selection.selection.asset.address,
      Buffer.from(canonicalJsonStringify(captureCanonicalJson(oneOverOperation)), "utf8"),
    ] as const;
    expect(() => insert.run(...parameters)).toThrow(/CHECK constraint failed/u);
    existing.pragma("ignore_check_constraints = ON");
    insert.run(...parameters);
    existing.close();

    let startupFailure: unknown;
    try { await ProductDatabase.open(path, now); }
    catch (error) { startupFailure = error; }
    expect(getRuntimeOperationFailure(startupFailure)?.error.code)
      .toBe("runtime_state_unavailable");
  });

  it("classifies a produced cache-over-limit inspection before its first mutation", async () => {
    const { database, path, connection } = await openDatabase();
    const snapshot = await sourceSnapshot(database);
    const inspection = await operationBoundaryInspection(994, 50);
    expect(canonicalByteLength(inspection)).toBe(65_919);
    const store = database.tokenCatalogStore();
    const action = selectionAction({
      kind: "add",
      connectionRevision: connection.revision,
      asset: inspection.data.asset,
      previousSelection: null,
      currentSetRevision: null,
      inspection,
      snapshotRevision: snapshot.revision,
    });

    let failure: unknown;
    try {
      apply(store, {
        action,
        selectionRevision: selectionRevision(66),
        selectionSetRevision: setRevision(67),
      });
    } catch (error) { failure = error; }
    expect(getTokenCatalogOperationFailure(failure)).toMatchObject({
      error: { code: "result_too_large", retryable: false },
    });
    const raw = new Database(path, { readonly: true });
    for (const table of [
      "contract",
      "token_contract",
      "token_contract_inspection",
      "wallet_token_selection_state",
      "wallet_token_selection",
      "token_selection_operation",
    ]) expect(raw.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(), table)
      .toEqual({ count: 0 });
    raw.close();
    database.close();
  });

  it("admits the exact aggregate cache boundary before rejecting one more valid row", async () => {
    const { database, path } = await openDatabase();
    database.close();
    const inspections = await Promise.all(Array.from({ length: 1_025 }, () =>
      operationBoundaryInspection(611, 50)));
    expect(inspections.every((inspection) => canonicalByteLength(inspection) === 65_536))
      .toBe(true);
    const rows = inspections.map((inspection) => {
      const result = inspection as unknown as IndependentJson;
      return Object.freeze({
        digest: independentTokenInspectionDigest(result),
        bytes: Buffer.from(independentCanonicalJson(result), "utf8"),
      });
    });
    expect(new Set(rows.map((row) => row.digest)).size).toBe(rows.length);
    expect(rows.slice(0, 1_024).reduce((total, row) => total + row.bytes.length, 0))
      .toBe(67_108_864);

    const raw = new Database(path);
    raw.pragma("foreign_keys = ON");
    raw.prepare("INSERT INTO contract(chain_id, contract_address) VALUES (?, ?)")
      .run(chainId, operationBoundaryAsset);
    raw.prepare("INSERT INTO token_contract(chain_id, contract_address) VALUES (?, ?)")
      .run(chainId, operationBoundaryAsset);
    const insert = raw.prepare(`INSERT INTO token_contract_inspection(
      chain_id, contract_address, inspection_digest, result_bytes
    ) VALUES (?, ?, ?, ?)`);
    const victim = [...rows.slice(0, 1_024)]
      .sort((left, right) => left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0)[0];
    if (victim === undefined) throw new TypeError("Aggregate cache fixture has no victim.");
    const secondAccount: EvmAccountIdentity = Object.freeze({
      chainId,
      address: parseEvmAddressInput(`0x${"37".repeat(20)}`),
    });
    raw.transaction(() => {
      for (const row of rows.slice(0, 1_024)) {
        insert.run(chainId, operationBoundaryAsset, row.digest, row.bytes);
      }
      raw.prepare(`INSERT INTO wallet_account(profile_id, chain_id, wallet_address)
        SELECT profile_id, ?, ? FROM local_profile WHERE singleton = 1`)
        .run(chainId, secondAccount.address);
      raw.prepare(`INSERT INTO wallet_token_selection_state(
        profile_id, chain_id, wallet_address, revision, defaults_initialized, created_at, updated_at
      ) SELECT profile_id, ?, ?, ?, 0, ?, ? FROM local_profile WHERE singleton = 1`)
        .run(chainId, secondAccount.address, setRevision(78), now, now);
      raw.prepare(`INSERT INTO wallet_token_selection(
        profile_id, chain_id, wallet_address, token_address, inspection_digest,
        included, revision, created_at, updated_at
      ) SELECT profile_id, ?, ?, ?, ?, 1, ?, ?, ? FROM local_profile WHERE singleton = 1`)
        .run(
          chainId,
          secondAccount.address,
          operationBoundaryAsset,
          victim.digest,
          selectionRevision(79),
          now,
          now,
        );
    })();
    raw.close();

    const exact = await ProductDatabase.open(path, now);
    const snapshot = await sourceSnapshot(exact);
    const candidate = await operationBoundaryInspection(881);
    const connection = exact.walletStore().read();
    const action = selectionAction({
      kind: "add",
      connectionRevision: connection.revision,
      asset: candidate.data.asset,
      previousSelection: null,
      currentSetRevision: null,
      inspection: candidate,
      snapshotRevision: snapshot.revision,
    });
    apply(exact.tokenCatalogStore(), {
      action,
      selectionRevision: selectionRevision(80),
      selectionSetRevision: setRevision(81),
    });
    const afterRetention = new Database(path, { readonly: true });
    expect(afterRetention.prepare(`SELECT count(*) AS rowCount,
      sum(length(result_bytes)) AS aggregateBytes FROM token_contract_inspection`).get())
      .toEqual({ rowCount: 1_024, aggregateBytes: 67_107_128 });
    expect(afterRetention.prepare(`SELECT count(*) AS count FROM token_contract_inspection
      WHERE inspection_digest = ?`).get(victim.digest)).toEqual({ count: 0 });
    expect(afterRetention.prepare(`SELECT inspection_digest AS inspectionDigest, revision
      FROM wallet_token_selection WHERE wallet_address = ? AND token_address = ?`)
      .get(secondAccount.address, operationBoundaryAsset))
      .toEqual({ inspectionDigest: victim.digest, revision: selectionRevision(79) });
    expect(afterRetention.prepare(`SELECT revision FROM wallet_token_selection_state
      WHERE wallet_address = ?`).get(secondAccount.address))
      .toEqual({ revision: setRevision(78) });
    afterRetention.close();
    expect(exact.tokenCatalogStore().getSelection(
      secondAccount,
      candidate.data.asset,
    )?.historicalInspection).toBeNull();
    exact.close();

    const over = new Database(path);
    over.prepare(`INSERT INTO token_contract_inspection(
      chain_id, contract_address, inspection_digest, result_bytes
    ) VALUES (?, ?, ?, ?)`).run(
      chainId,
      operationBoundaryAsset,
      rows[1_024]!.digest,
      rows[1_024]!.bytes,
    );
    over.close();
    let failure: unknown;
    try { await ProductDatabase.open(path, now); }
    catch (error) { failure = error; }
    expect(getRuntimeOperationFailure(failure)?.error.code)
      .toBe("runtime_state_unavailable");
  }, 30_000);

  it("replaces one canonical victim at the exact retained-row boundary", async () => {
    const { database, path } = await openDatabase();
    database.close();
    const inspections = await Promise.all(Array.from({ length: 4_097 }, () =>
      createInspectionSuccess({
        asset: { kind: "erc20", chainId, address: operationBoundaryAsset },
        block: { kind: "latest" },
      })));
    const rows = inspections.map((inspection) => {
      const result = inspection as unknown as IndependentJson;
      return Object.freeze({
        inspection,
        digest: independentTokenInspectionDigest(result),
        bytes: Buffer.from(independentCanonicalJson(result), "utf8"),
      });
    });
    expect(new Set(rows.map((row) => row.digest)).size).toBe(rows.length);
    expect(rows.slice(0, 4_096).reduce((total, row) => total + row.bytes.length, 0))
      .toBeLessThan(67_108_864);
    const victim = [...rows.slice(0, 4_096)]
      .sort((left, right) => left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0)[0];
    const candidate = rows[4_096];
    if (victim === undefined || candidate === undefined) {
      throw new TypeError("Row-boundary cache fixture is incomplete.");
    }

    const raw = new Database(path);
    raw.pragma("foreign_keys = ON");
    raw.prepare("INSERT INTO contract(chain_id, contract_address) VALUES (?, ?)")
      .run(chainId, operationBoundaryAsset);
    raw.prepare("INSERT INTO token_contract(chain_id, contract_address) VALUES (?, ?)")
      .run(chainId, operationBoundaryAsset);
    const insert = raw.prepare(`INSERT INTO token_contract_inspection(
      chain_id, contract_address, inspection_digest, result_bytes
    ) VALUES (?, ?, ?, ?)`);
    raw.transaction(() => {
      for (const row of rows.slice(0, 4_096)) {
        insert.run(chainId, operationBoundaryAsset, row.digest, row.bytes);
      }
    })();
    raw.close();

    const exact = await ProductDatabase.open(path, now);
    const snapshot = await sourceSnapshot(exact);
    const connection = exact.walletStore().read();
    const action = selectionAction({
      kind: "add",
      connectionRevision: connection.revision,
      asset: candidate.inspection.data.asset,
      previousSelection: null,
      currentSetRevision: null,
      inspection: candidate.inspection,
      snapshotRevision: snapshot.revision,
    });
    apply(exact.tokenCatalogStore(), {
      action,
      selectionRevision: selectionRevision(82),
      selectionSetRevision: setRevision(83),
    });
    const after = new Database(path, { readonly: true });
    expect(after.prepare("SELECT count(*) AS count FROM token_contract_inspection").get())
      .toEqual({ count: 4_096 });
    expect(after.prepare(`SELECT count(*) AS count FROM token_contract_inspection
      WHERE inspection_digest = ?`).get(victim.digest)).toEqual({ count: 0 });
    expect(after.prepare(`SELECT count(*) AS count FROM token_contract_inspection
      WHERE inspection_digest = ?`).get(candidate.digest)).toEqual({ count: 1 });
    const beforeRollback = after.prepare(`SELECT inspection_digest AS inspectionDigest
      FROM token_contract_inspection ORDER BY inspection_digest`).all();
    after.close();

    const secondAccount: EvmAccountIdentity = Object.freeze({
      chainId,
      address: parseEvmAddressInput(`0x${"38".repeat(20)}`),
    });
    const secondConnection = exact.walletStore().replace(
      connection.revision,
      parseCapabilityDataAt(walletConnectionCapability, {
        status: "connected",
        chainId,
        address: secondAccount.address,
        approvedMethods: ["eth_sendTransaction"],
        approvedEvents: ["accountsChanged", "chainChanged"],
        expiresAt: "2026-07-22T00:00:00.000Z",
      }, later),
      false,
      later,
    );
    const rollbackInspection = await createInspectionSuccess({
      asset: { kind: "erc20", chainId, address: operationBoundaryAsset },
      block: { kind: "latest" },
    }, { name: "Rollback candidate" });
    const rollbackAction = selectionAction({
      kind: "add",
      account: secondAccount,
      connectionRevision: secondConnection.revision,
      asset: rollbackInspection.data.asset,
      previousSelection: null,
      currentSetRevision: null,
      inspection: rollbackInspection,
      snapshotRevision: snapshot.revision,
    });
    const trigger = new Database(path);
    trigger.exec(`CREATE TRIGGER reject_retention_operation
      BEFORE INSERT ON token_selection_operation
      BEGIN SELECT RAISE(ABORT, 'reject retained terminal operation'); END`);
    trigger.close();
    expect(() => apply(exact.tokenCatalogStore(), {
      action: rollbackAction,
      selectionRevision: selectionRevision(84),
      selectionSetRevision: setRevision(85),
    })).toThrow();
    const rolledBack = new Database(path, { readonly: true });
    expect(rolledBack.prepare(`SELECT inspection_digest AS inspectionDigest
      FROM token_contract_inspection ORDER BY inspection_digest`).all()).toEqual(beforeRollback);
    expect(rolledBack.prepare(`SELECT count(*) AS count FROM wallet_token_selection
      WHERE wallet_address = ?`).get(secondAccount.address)).toEqual({ count: 0 });
    expect(rolledBack.prepare(`SELECT count(*) AS count FROM token_selection_operation
      WHERE operation_id = ?`).get(rollbackAction.action.review.operationId)).toEqual({ count: 0 });
    rolledBack.close();
    exact.close();
  }, 60_000);

  it("rejects an existing TEXT inspection payload under the exact BLOB schema", async () => {
    const { database, path } = await openDatabase();
    database.close();
    const raw = new Database(path);
    raw.pragma("foreign_keys = OFF");
    raw.prepare("INSERT INTO contract(chain_id, contract_address) VALUES (?, ?)")
      .run(chainId, operationBoundaryAsset);
    raw.prepare("INSERT INTO token_contract(chain_id, contract_address) VALUES (?, ?)")
      .run(chainId, operationBoundaryAsset);
    const replaceDeclaredType = (from: string, to: string): void => {
      raw.unsafeMode(true);
      raw.exec("PRAGMA writable_schema = ON");
      const changed = raw.prepare(`UPDATE sqlite_schema SET sql = replace(sql, ?, ?)
        WHERE type = 'table' AND name = 'token_contract_inspection'`).run(from, to);
      expect(changed.changes).toBe(1);
      raw.exec("PRAGMA writable_schema = OFF");
      const version = raw.pragma("schema_version", { simple: true }) as number;
      raw.pragma(`schema_version = ${version + 1}`);
    };
    replaceDeclaredType("result_bytes BLOB", "result_bytes ANY");
    raw.pragma("ignore_check_constraints = ON");
    raw.prepare(`INSERT INTO token_contract_inspection(
      chain_id, contract_address, inspection_digest, result_bytes
    ) VALUES (?, ?, ?, ?)`).run(
      chainId,
      operationBoundaryAsset,
      `0x${"44".repeat(32)}`,
      "{}",
    );
    raw.pragma("ignore_check_constraints = OFF");
    replaceDeclaredType("result_bytes ANY", "result_bytes BLOB");
    expect(hasExactCurrentSqliteStructure(raw)).toBe(true);
    expect(raw.prepare("SELECT typeof(result_bytes) AS storageClass FROM token_contract_inspection").get())
      .toEqual({ storageClass: "text" });
    raw.close();

    let failure: unknown;
    try { await ProductDatabase.open(path, now); }
    catch (error) { failure = error; }
    expect(getRuntimeOperationFailure(failure)?.error.code)
      .toBe("runtime_state_unavailable");
  });

  it("rejects a noncanonical selection cache key on startup", async () => {
    const { database, path } = await openDatabase();
    const profileId = database.ownerStore().readProfile().profileId;
    database.close();
    const raw = new Database(path);
    raw.pragma("foreign_keys = ON");
    raw.prepare("INSERT INTO contract(chain_id, contract_address) VALUES (?, ?)")
      .run(chainId, operationBoundaryAsset);
    raw.prepare("INSERT INTO token_contract(chain_id, contract_address) VALUES (?, ?)")
      .run(chainId, operationBoundaryAsset);
    raw.prepare(`INSERT INTO wallet_token_selection_state(
      profile_id, chain_id, wallet_address, revision, defaults_initialized, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 0, ?, ?)`).run(
      profileId,
      chainId,
      walletAddress,
      setRevision(86),
      now,
      now,
    );
    const insert = raw.prepare(`INSERT INTO wallet_token_selection(
      profile_id, chain_id, wallet_address, token_address, inspection_digest,
      included, revision, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`);
    const parameters = [
      profileId,
      chainId,
      walletAddress,
      operationBoundaryAsset,
      "not-a-digest",
      selectionRevision(87),
      now,
      now,
    ] as const;
    expect(() => insert.run(...parameters)).toThrow(/CHECK constraint failed/u);
    raw.pragma("ignore_check_constraints = ON");
    insert.run(...parameters);
    raw.close();

    let failure: unknown;
    try { await ProductDatabase.open(path, now); }
    catch (error) { failure = error; }
    expect(getRuntimeOperationFailure(failure)?.error.code)
      .toBe("runtime_state_unavailable");
  });

  it("rejects one-over inspection bytes and one-over retained rows on startup", async () => {
    const exactInspection = await operationBoundaryInspection(611, 50);
    const oversizedInspection = await operationBoundaryInspection(612, 50);
    expect(canonicalByteLength(exactInspection)).toBe(65_536);
    expect(canonicalByteLength(oversizedInspection)).toBe(65_537);

    const exactState = await openDatabase();
    exactState.database.close();
    const exactRaw = new Database(exactState.path);
    exactRaw.pragma("foreign_keys = ON");
    exactRaw.prepare("INSERT INTO contract(chain_id, contract_address) VALUES (?, ?)")
      .run(chainId, operationBoundaryAsset);
    exactRaw.prepare("INSERT INTO token_contract(chain_id, contract_address) VALUES (?, ?)")
      .run(chainId, operationBoundaryAsset);
    const insert = exactRaw.prepare(`INSERT INTO token_contract_inspection(
      chain_id, contract_address, inspection_digest, result_bytes
    ) VALUES (?, ?, ?, ?)`);
    const exactBytes = Buffer.from(
      independentCanonicalJson(exactInspection as unknown as IndependentJson),
      "utf8",
    );
    const oversizedBytes = Buffer.from(
      independentCanonicalJson(oversizedInspection as unknown as IndependentJson),
      "utf8",
    );
    insert.run(
      chainId,
      operationBoundaryAsset,
      independentTokenInspectionDigest(exactInspection as unknown as IndependentJson),
      exactBytes,
    );
    expect(() => insert.run(
      chainId,
      operationBoundaryAsset,
      independentTokenInspectionDigest(oversizedInspection as unknown as IndependentJson),
      oversizedBytes,
    )).toThrow(/CHECK constraint failed/u);
    exactRaw.pragma("ignore_check_constraints = ON");
    insert.run(
      chainId,
      operationBoundaryAsset,
      independentTokenInspectionDigest(oversizedInspection as unknown as IndependentJson),
      oversizedBytes,
    );
    exactRaw.close();
    let byteFailure: unknown;
    try { await ProductDatabase.open(exactState.path, now); }
    catch (error) { byteFailure = error; }
    expect(getRuntimeOperationFailure(byteFailure)?.error.code)
      .toBe("runtime_state_unavailable");

    const rowState = await openDatabase();
    rowState.database.close();
    const rowRaw = new Database(rowState.path);
    rowRaw.pragma("foreign_keys = ON");
    rowRaw.prepare("INSERT INTO contract(chain_id, contract_address) VALUES (?, ?)")
      .run(chainId, operationBoundaryAsset);
    rowRaw.prepare("INSERT INTO token_contract(chain_id, contract_address) VALUES (?, ?)")
      .run(chainId, operationBoundaryAsset);
    const insertSmall = rowRaw.prepare(`INSERT INTO token_contract_inspection(
      chain_id, contract_address, inspection_digest, result_bytes
    ) VALUES (?, ?, ?, ?)`);
    rowRaw.transaction(() => {
      for (let index = 0; index < 4_097; index += 1) {
        insertSmall.run(
          chainId,
          operationBoundaryAsset,
          `0x${(index + 1).toString(16).padStart(64, "0")}`,
          Buffer.from("{}", "utf8"),
        );
      }
    })();
    rowRaw.close();
    let rowFailure: unknown;
    try { await ProductDatabase.open(rowState.path, now); }
    catch (error) { rowFailure = error; }
    expect(getRuntimeOperationFailure(rowFailure)?.error.code)
      .toBe("runtime_state_unavailable");
  }, 30_000);

  it("returns an exact duplicate operation before reclassifying a later oversized inspection", async () => {
    const { database, connection } = await openDatabase();
    const snapshot = await sourceSnapshot(database);
    const admittedInspection = await operationBoundaryInspection(881);
    const oversizedInspection = await operationBoundaryInspection(994, 50);
    const store = database.tokenCatalogStore();
    const action = selectionAction({
      kind: "add",
      connectionRevision: connection.revision,
      asset: admittedInspection.data.asset,
      previousSelection: null,
      currentSetRevision: null,
      inspection: admittedInspection,
      snapshotRevision: snapshot.revision,
    });
    const completed = apply(store, {
      action,
      selectionRevision: selectionRevision(68),
      selectionSetRevision: setRevision(69),
    });

    expect(store.applySelectionChange({
      action: action.action,
      selectionRevision: selectionRevision(70),
      selectionSetRevision: setRevision(71),
      inspection: oversizedInspection,
      officialVerification: null,
      completedAt: later,
    })).toEqual(completed);
    database.close();
  });

  it("rejects a current stored token inspection missing required source record digests", async () => {
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

    const malformedCurrentResult = JSON.parse(JSON.stringify(inspection)) as {
      evidence: { sources: Array<Record<string, unknown>> };
    };
    expect(independentTokenInspectionDigest(malformedCurrentResult as unknown as IndependentJson))
      .toBe(tokenInspectionDigest(inspection));
    for (const source of malformedCurrentResult.evidence.sources) delete source["recordDigest"];
    const resultJson = independentCanonicalJson(malformedCurrentResult as unknown as IndependentJson);
    const inspectionDigest = independentTokenInspectionDigest(
      malformedCurrentResult as unknown as IndependentJson,
    );

    const raw = new Database(path);
    raw.prepare("INSERT INTO contract(chain_id, contract_address) VALUES (?, ?)")
      .run(chainId, inspection.data.asset.address);
    raw.prepare("INSERT INTO token_contract(chain_id, contract_address) VALUES (?, ?)")
      .run(chainId, inspection.data.asset.address);
    raw.prepare(`INSERT INTO token_contract_inspection(
      chain_id, contract_address, inspection_digest, result_bytes
    ) VALUES (?, ?, ?, ?)`)
      .run(
        chainId,
        inspection.data.asset.address,
        inspectionDigest,
        Buffer.from(resultJson, "utf8"),
      );
    raw.close();

    let failure: unknown;
    try { await ProductDatabase.open(path, now); }
    catch (error) { failure = error; }
    expect(getRuntimeOperationFailure(failure)?.error.code).toBe("runtime_state_unavailable");
  });

  it("rejects a current independently digested durable semantic corruption", async () => {
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
    expect(independentTokenInspectionDigest(malformed as unknown as IndependentJson))
      .toBe(tokenInspectionDigest(inspection));
    malformed.data.analysis = changedOwner;
    const resultJson = independentCanonicalJson(malformed as unknown as IndependentJson);
    const inspectionDigest = independentTokenInspectionDigest(
      malformed as unknown as IndependentJson,
    );

    const raw = new Database(path);
    raw.prepare("INSERT INTO contract(chain_id, contract_address) VALUES (?, ?)")
      .run(chainId, inspection.data.asset.address);
    raw.prepare("INSERT INTO token_contract(chain_id, contract_address) VALUES (?, ?)")
      .run(chainId, inspection.data.asset.address);
    raw.prepare(`INSERT INTO token_contract_inspection(
      chain_id, contract_address, inspection_digest, result_bytes
    ) VALUES (?, ?, ?, ?)`)
      .run(
        chainId,
        inspection.data.asset.address,
        inspectionDigest,
        Buffer.from(resultJson, "utf8"),
      );
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

  it("stores and reads the admitted official source URI instead of rebuilding it", async () => {
    const { database, path } = await openDatabase();
    const snapshot = await sourceSnapshot(database);
    const raw = new Database(path);
    expect(raw.prepare("SELECT source_uri AS sourceUri FROM robinhood_asset_snapshot").get())
      .toEqual({ sourceUri: snapshot.sourceUri });
    expect(() => raw.prepare("UPDATE robinhood_asset_snapshot SET source_uri = ?")
      .run("https://example.invalid/assets")).toThrow();
    raw.close();
    database.close();

    const reopened = await ProductDatabase.open(path, now);
    expect(reopened.officialAssetSnapshotStore().readSnapshot()?.sourceUri)
      .toBe(snapshot.sourceUri);
    reopened.close();

    const forged = new Database(path);
    forged.pragma("ignore_check_constraints = ON");
    forged.prepare("UPDATE robinhood_asset_snapshot SET source_uri = ?")
      .run("https://example.invalid/assets");
    forged.close();
    await expect(ProductDatabase.open(path, now)).rejects.toSatisfy((error: unknown) =>
      getRuntimeOperationFailure(error)?.error.code === "runtime_state_unavailable");
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
    expect(Buffer.from(initialized.state.revision, "base64url")).toHaveLength(16);
    expect(initialized.selections.every((entry) =>
      Buffer.from(entry.revision, "base64url").byteLength === 16)).toBe(true);
    expect(initialized.selections.map((entry) => entry.asset.address)).toEqual(
      defaultStockTokenManifest.assets.map((entry) => entry.contractAddress),
    );

    const catalog = database.tokenCatalogStore();
    const excluded = catalog.getSelection(account, initialized.selections[0]!.asset)!;
    const removal = selectionAction({
      kind: "remove",
      connectionRevision: connection.revision,
      asset: excluded.selection.asset,
      previousSelection: excluded.selection,
      currentSetRevision: initialized.state.revision,
      inspection: null,
      snapshotRevision: null,
    });
    apply(catalog, {
      action: removal,
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

  it("keeps a default selection inspection absent when another account inspects that token", async () => {
    const { database, connection } = await openDatabase();
    const snapshot = await sourceSnapshot(database);
    const defaultEntry = defaultStockTokenManifest.assets[0];
    if (defaultEntry === undefined) throw new TypeError("Default token manifest is empty.");
    const defaultAsset = {
      kind: "erc20" as const,
      chainId,
      address: defaultEntry.contractAddress,
    };
    database.accountTokenSelectionStore().initializeDefaults({
      account,
      expectedConnectionRevision: connection.revision,
      snapshotRevision: snapshot.revision,
      verifiedDefaults: defaultStockTokenManifest.assets.map((entry) => ({
        asset: { kind: "erc20" as const, chainId, address: entry.contractAddress },
        verification: verification(entry.assetUid, entry.contractAddress),
      })),
      now,
    });
    expect(database.tokenCatalogStore().getSelection(account, defaultAsset)?.historicalInspection)
      .toBeNull();

    const secondAccount: EvmAccountIdentity = Object.freeze({
      chainId,
      address: parseEvmAddressInput(`0x${"36".repeat(20)}`),
    });
    const secondConnection = database.walletStore().replace(
      connection.revision,
      parseCapabilityDataAt(walletConnectionCapability, {
        status: "connected",
        chainId,
        address: secondAccount.address,
        approvedMethods: ["eth_sendTransaction"],
        approvedEvents: ["accountsChanged", "chainChanged"],
        expiresAt: "2026-07-22T00:00:00.000Z",
      }, later),
      false,
      later,
    );
    const inspection = await createInspectionSuccess({
      asset: defaultAsset,
      block: { kind: "latest" },
    });
    const member = snapshot.members.find((candidate) =>
      candidate.contractAddress === defaultAsset.address);
    if (member === undefined) throw new TypeError("Default source member is unavailable.");
    const officialVerification = verification(
      member.assetUid,
      member.contractAddress,
      inspection.data.analysis.block,
    );
    const action = selectionAction({
      kind: "add",
      account: secondAccount,
      connectionRevision: secondConnection.revision,
      asset: defaultAsset,
      previousSelection: null,
      currentSetRevision: null,
      inspection,
      snapshotRevision: snapshot.revision,
      officialMember: member,
      officialVerification,
    });
    apply(database.tokenCatalogStore(), {
      action,
      selectionRevision: selectionRevision(76),
      selectionSetRevision: setRevision(77),
      officialVerification,
    });

    expect(database.tokenCatalogStore().getSelection(account, defaultAsset)?.historicalInspection)
      .toBeNull();
    expect(tokenInspectionDigest(
      database.tokenCatalogStore().getSelection(secondAccount, defaultAsset)?.historicalInspection,
    )).toBe(tokenInspectionDigest(inspection));
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
    const addOperation = selectionAction({
      kind: "add",
      connectionRevision: connection.revision,
      asset: inspection.data.asset,
      previousSelection: null,
      currentSetRevision: null,
      inspection,
      snapshotRevision: snapshot.revision,
    });
    const added = apply(store, {
      action: addOperation,
      selectionRevision: selectionRevision(1),
      selectionSetRevision: setRevision(2),
    });
    expect(added).toMatchObject({
      state: "completed",
      result: { selection: { selection: { included: true } } },
    });
    const first = store.getSelection(account, inspection.data.asset)!;

    const removeOperation = selectionAction({
      kind: "remove",
      connectionRevision: connection.revision,
      asset: inspection.data.asset,
      previousSelection: first.selection,
      currentSetRevision: store.getSelectionState(account)!.revision,
      inspection: null,
      snapshotRevision: null,
    });
    apply(store, {
      action: removeOperation,
      selectionRevision: selectionRevision(3),
      selectionSetRevision: setRevision(4),
    });
    const excluded = store.getSelection(account, inspection.data.asset)!;
    expect(excluded.selection).toMatchObject({ included: false, createdAt: first.selection.createdAt });
    expect(database.accountTokenSelectionStore().listIncludedForAccount({
      account, limit: 25, cursor: null, excludedAddresses: [],
    }).selections).toEqual([]);

    const readdOperation = selectionAction({
      kind: "add",
      connectionRevision: connection.revision,
      asset: reinspection.data.asset,
      previousSelection: excluded.selection,
      currentSetRevision: store.getSelectionState(account)!.revision,
      inspection: reinspection,
      snapshotRevision: snapshot.revision,
    });
    const restored = apply(store, {
      action: readdOperation,
      selectionRevision: selectionRevision(5),
      selectionSetRevision: setRevision(6),
    });
    expect(restored.result.selection.selection).toMatchObject({
      included: true,
      createdAt: first.selection.createdAt,
    });
    expect(tokenInspectionDigest(restored.result.selection.historicalInspection))
      .toBe(tokenInspectionDigest(reinspection));
    expect(tokenInspectionDigest(
      store.getSelection(account, inspection.data.asset)?.historicalInspection,
    )).toBe(tokenInspectionDigest(reinspection));

    const raw = new Database(path, { readonly: true });
    expect(raw.prepare("SELECT COUNT(*) AS count FROM wallet_token_selection").get()).toEqual({ count: 1 });
    expect(raw.prepare("SELECT COUNT(*) AS count FROM token_contract_inspection").get()).toEqual({ count: 2 });
    raw.close();
    database.close();
  });

  it("binds each account selection to the inspection used by that account", async () => {
    const { database, path, connection } = await openDatabase();
    const snapshot = await sourceSnapshot(database);
    const store = database.tokenCatalogStore();
    const input = {
      asset: {
        kind: "erc20",
        chainId,
        address: parseEvmAddressInput(`0x${"89".repeat(20)}`),
      },
      block: { kind: "latest" },
    } as const;
    const firstInspection = await createInspectionSuccess(input, { name: "First account token" });
    const secondInspection = await createInspectionSuccess(input, { name: "Second account token" });
    const firstAction = selectionAction({
      kind: "add",
      connectionRevision: connection.revision,
      asset: input.asset,
      previousSelection: null,
      currentSetRevision: null,
      inspection: firstInspection,
      snapshotRevision: snapshot.revision,
    });
    apply(store, {
      action: firstAction,
      selectionRevision: selectionRevision(72),
      selectionSetRevision: setRevision(73),
    });

    const secondAccount: EvmAccountIdentity = Object.freeze({
      chainId,
      address: parseEvmAddressInput(`0x${"35".repeat(20)}`),
    });
    const secondConnection = database.walletStore().replace(
      connection.revision,
      parseCapabilityDataAt(walletConnectionCapability, {
        status: "connected",
        chainId,
        address: secondAccount.address,
        approvedMethods: ["eth_sendTransaction"],
        approvedEvents: ["accountsChanged", "chainChanged"],
        expiresAt: "2026-07-22T00:00:00.000Z",
      }, later),
      false,
      later,
    );
    const secondAction = selectionAction({
      kind: "add",
      account: secondAccount,
      connectionRevision: secondConnection.revision,
      asset: input.asset,
      previousSelection: null,
      currentSetRevision: null,
      inspection: secondInspection,
      snapshotRevision: snapshot.revision,
    });
    apply(store, {
      action: secondAction,
      selectionRevision: selectionRevision(74),
      selectionSetRevision: setRevision(75),
    });

    expect(tokenInspectionDigest(
      store.getSelection(account, input.asset)?.historicalInspection,
    )).toBe(tokenInspectionDigest(firstInspection));
    expect(tokenInspectionDigest(
      store.getSelection(secondAccount, input.asset)?.historicalInspection,
    )).toBe(tokenInspectionDigest(secondInspection));
    const raw = new Database(path, { readonly: true });
    expect(raw.prepare(`SELECT wallet_address AS walletAddress,
      inspection_digest AS inspectionDigest FROM wallet_token_selection
      WHERE token_address = ? ORDER BY wallet_address`).all(input.asset.address)).toEqual([
      { walletAddress: account.address, inspectionDigest: tokenInspectionDigest(firstInspection) },
      { walletAddress: secondAccount.address, inspectionDigest: tokenInspectionDigest(secondInspection) },
    ]);
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
    const firstAdd = selectionAction({
      kind: "add",
      connectionRevision: connection.revision,
      asset: firstInspection.data.asset,
      previousSelection: null,
      currentSetRevision: null,
      inspection: firstInspection,
      snapshotRevision: snapshot.revision,
    });
    apply(store, {
      action: firstAdd,
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
    const firstRemove = selectionAction({
      kind: "remove",
      connectionRevision: connection.revision,
      asset: firstInspection.data.asset,
      previousSelection: firstSelection,
      currentSetRevision: store.getSelectionState(account)!.revision,
      inspection: null,
      snapshotRevision: null,
    });
    apply(store, {
      action: firstRemove,
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
    const secondAdd = selectionAction({
      kind: "add",
      connectionRevision: connection.revision,
      asset: secondInspection.data.asset,
      previousSelection: null,
      currentSetRevision: store.getSelectionState(account)!.revision,
      inspection: secondInspection,
      snapshotRevision: snapshot.revision,
    });
    apply(store, {
      action: secondAdd,
      selectionRevision: selectionRevision(24),
      selectionSetRevision: setRevision(25),
    });
    const secondSelection = store.getSelection(account, secondInspection.data.asset)!.selection;
    const secondRemove = selectionAction({
      kind: "remove",
      connectionRevision: connection.revision,
      asset: secondInspection.data.asset,
      previousSelection: secondSelection,
      currentSetRevision: store.getSelectionState(account)!.revision,
      inspection: null,
      snapshotRevision: null,
    });
    apply(store, {
      action: secondRemove,
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
    const staleConnectionAction = selectionAction({
      kind: "add",
      connectionRevision: "0",
      asset: inspection.data.asset,
      previousSelection: null,
      currentSetRevision: null,
      inspection,
      snapshotRevision: snapshot.revision,
    });
    const staleAction = selectionAction({
      kind: "add",
      connectionRevision: connection.revision,
      asset: inspection.data.asset,
      previousSelection: null,
      currentSetRevision: null,
      inspection,
      snapshotRevision: snapshot.revision,
    });
    const action = selectionAction({
      kind: "add",
      connectionRevision: connection.revision,
      asset: inspection.data.asset,
      previousSelection: null,
      currentSetRevision: null,
      inspection,
      snapshotRevision: snapshot.revision,
    });
    expect(failureCode(() => apply(store, {
      action: staleConnectionAction,
      selectionRevision: selectionRevision(5),
      selectionSetRevision: setRevision(6),
    }))).toBe("state_conflict");
    expect(store.getSelection(account, inspection.data.asset)).toBeUndefined();

    apply(store, {
      action,
      selectionRevision: selectionRevision(5),
      selectionSetRevision: setRevision(6),
    });
    expect(failureCode(() => apply(store, {
      action: staleAction,
      selectionRevision: selectionRevision(7),
      selectionSetRevision: setRevision(8),
    }))).toBe("token_selection_revision_changed");
    expect(store.getSelection(account, inspection.data.asset)?.selection.revision).toBe(selectionRevision(5));
    database.close();
  });

  it("rejects mismatched admitted official evidence before durable mutation", async () => {
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
    const officialMember = snapshot.members.find((member) =>
      member.contractAddress === manifestEntry.contractAddress);
    if (officialMember === undefined) throw new TypeError("Official source member is missing.");
    const action = selectionAction({
      kind: "add",
      connectionRevision: connection.revision,
      asset: inspection.data.asset,
      previousSelection: null,
      currentSetRevision: null,
      inspection,
      snapshotRevision: snapshot.revision,
      officialMember,
      officialVerification: correctVerification,
    });
    const store = database.tokenCatalogStore();
    const mismatchedVerification: StockFactoryVerification = {
      ...correctVerification,
      block: {
        ...correctVerification.block,
        blockHash: parseHash32(`0x${"cd".repeat(32)}`),
      },
    };
    expect(failureCode(() => apply(store, {
      action,
      selectionRevision: selectionRevision(40),
      selectionSetRevision: setRevision(41),
      officialVerification: mismatchedVerification,
    }))).toBe("runtime_state_unavailable");
    expect(store.getSelection(account, inspection.data.asset)).toBeUndefined();
    expect(store.getSelectionState(account)).toBeUndefined();
    const empty = new Database(path, { readonly: true });
    expect(empty.prepare("SELECT COUNT(*) AS count FROM token_contract_inspection").get())
      .toEqual({ count: 0 });
    empty.close();

    const completed = apply(store, {
      action,
      selectionRevision: selectionRevision(40),
      selectionSetRevision: setRevision(41),
      officialVerification: correctVerification,
    });
    expect(completed).toMatchObject({
      state: "completed",
      result: { selection: { selection: { included: true } } },
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
