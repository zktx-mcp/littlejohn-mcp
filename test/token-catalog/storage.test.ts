import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CapabilityBindingRegistry,
  CapabilityRegistry,
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
  tokenInspectCapability,
  tokenInspectionDigest,
  tokenSelectionReviewDigest,
  tokenSelectionRevisionSchema,
  tokenSelectionSetRevisionSchema,
  type TokenInspectionSuccess,
  type TokenSelection,
  type TokenSelectionDirectAction,
} from "../../src/token-catalog/contracts.js";
import { getTokenCatalogOperationFailure, TokenCatalogOperationError } from "../../src/token-catalog/operation-error.js";
import type { TokenCatalogStore } from "../../src/token-catalog/ports.js";
import {
  createExactResolvedAnalysis,
  validContractAnalysisClaimMutations,
} from "../core/contract-analysis-fixtures.js";
import { createInspectionBinding, createInspectionSuccess } from "./harness.js";

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
const operationBoundaryAnalysis = (
  lastSignatureLength: number,
  signatureCount = 48,
) => {
  const base = createExactResolvedAnalysis(operationBoundaryAsset, operationBoundaryBlock);
  if (base.declaredFunctions.status !== "observed") {
    throw new TypeError("Operation boundary analysis is incomplete.");
  }
  const filler = Array.from({ length: signatureCount }, (_, index) =>
    `z${String(index).padStart(4, "0")}_${"a".repeat(
      index === signatureCount - 1 ? lastSignatureLength : 994,
    )}`);
  return contractAnalysisSchema.parse({
    ...base,
    declaredFunctions: {
      status: "observed",
      signatures: [...base.declaredFunctions.signatures, ...filler].sort(),
    },
  });
};

const operationBoundaryInspection = async (
  lastSignatureLength: number,
  signatureCount = 48,
): Promise<TokenInspectionSuccess> => createInspectionSuccess({
    asset: { kind: "erc20", chainId, address: operationBoundaryAsset },
    block: { kind: "latest" },
  }, { analysis: operationBoundaryAnalysis(lastSignatureLength, signatureCount) });

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
  const ordered = [...entries].sort(compareRetentionEntries);
  const prefixBytes = [0];
  for (const entry of ordered) prefixBytes.push(prefixBytes.at(-1)! + entry.byteLength);
  const requiredRows = Math.max(0, entries.length + 1 - expectedTokenInspectionPersistenceLimits.rows);
  const requiredBytes = Math.max(0, prefixBytes.at(-1)! + candidate.byteLength -
    expectedTokenInspectionPersistenceLimits.aggregateResultBytes);
  const count = prefixBytes.findIndex((bytes, index) => index >= requiredRows && bytes >= requiredBytes);
  if (count < 0) throw new TypeError("Independent retention fixture cannot admit its candidate.");
  return Object.freeze(ordered.slice(0, count));
};

type RetentionPressure = "none" | "rows" | "bytes" | "both";

const retentionBudgetCase = (pressure: RetentionPressure, requireMultipleVictims = false) => fc.record({
  countChoice: fc.nat(),
  candidateChoice: fc.nat(),
  totalChoice: fc.nat(),
  position: fc.constantFrom("before", "within", "after"),
}).chain((choice) => {
  const { rows, resultBytes, aggregateResultBytes } = expectedTokenInspectionPersistenceLimits;
  const rowPressure = pressure === "rows" || pressure === "both";
  const bytePressure = pressure === "bytes" || pressure === "both";
  const multipleVictims = pressure === "both" && requireMultipleVictims;
  const minimumCandidateBytes = multipleVictims ? 4 : 2;
  const candidateBytes = minimumCandidateBytes +
    choice.candidateChoice % (resultBytes - minimumCandidateBytes + 1);
  const minimumRows = bytePressure
    ? Math.ceil((aggregateResultBytes - candidateBytes + 1) / resultBytes)
    : choice.position === "within" ? 2 : 0;
  const rowCount = rowPressure ? rows : minimumRows + choice.countChoice % (rows - minimumRows);
  const minimumBytes = Math.max(
    rowCount * 2,
    bytePressure ? aggregateResultBytes - candidateBytes + (multipleVictims ? 3 : 1) : 0,
  );
  const maximumBytes = Math.min(
    rowCount * resultBytes,
    bytePressure ? aggregateResultBytes : aggregateResultBytes - candidateBytes,
  );
  if (minimumBytes > maximumBytes) throw new TypeError("Retention budget has no valid allocation.");
  const totalBytes = minimumBytes + choice.totalChoice % (maximumBytes - minimumBytes + 1);
  return fc.record({
    identities: fc.uniqueArray(fc.record({
      chain: fc.integer({ min: 1, max: 1_000 }),
      contract: fc.integer({ min: 0, max: 7 }),
      digest: fc.integer({ min: 0, max: 999_999 }),
    }), {
      minLength: rowCount + 1,
      maxLength: rowCount + 1,
      selector: (identity) => `${identity.chain}:${identity.contract}:${identity.digest}`,
    }),
    lengthChoices: fc.array(fc.nat(), { minLength: rowCount, maxLength: rowCount }),
    reverse: fc.boolean(),
    rotation: fc.nat(),
  }).map((input) => {
    const identities = input.identities.map((identity) =>
      retentionEntryFor({ ...identity, byteLength: 2 })).sort(compareRetentionEntries);
    const candidateIndex = choice.position === "before" ? 0 :
      choice.position === "after" ? rowCount : Math.floor(identities.length / 2);
    const candidate = { ...identities[candidateIndex]!, byteLength: candidateBytes };
    const existing = identities.filter((_, index) => index !== candidateIndex);
    let remainingBytes = totalBytes;
    const entries = existing.map((identity, index) => {
      const remainingRows = rowCount - index - 1;
      const minimum = Math.max(2, remainingBytes - remainingRows * resultBytes);
      let maximum = Math.min(resultBytes, remainingBytes - remainingRows * 2);
      if (multipleVictims && index === 0) {
        maximum = Math.min(maximum, totalBytes + candidateBytes - aggregateResultBytes - 1);
      }
      if (minimum > maximum) throw new TypeError("Retention prefix budget is inconsistent.");
      const byteLength = minimum + input.lengthChoices[index]! % (maximum - minimum + 1);
      remainingBytes -= byteLength;
      return Object.freeze({ ...identity, byteLength });
    });
    if (remainingBytes !== 0) throw new TypeError("Retention allocation did not preserve its budget.");
    const pivot = entries.length === 0 ? 0 : input.rotation % entries.length;
    const rotated = [...entries.slice(pivot), ...entries.slice(0, pivot)];
    const presented = input.reverse ? rotated.reverse() : rotated;
    return Object.freeze({
      pressure,
      rowPressure,
      bytePressure,
      multipleVictims,
      position: choice.position,
      rowCount,
      totalBytes,
      entries: Object.freeze(presented),
      candidate: Object.freeze(candidate),
    });
  });
});

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
  connectionRevision: string | null;
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
  const accountTarget = input.connectionRevision === null
    ? { kind: "address" as const }
    : { kind: "active_wallet" as const, connectionRevision: input.connectionRevision };
  const id = operationId();
  const withoutDigest = input.kind === "add"
    ? {
        contractVersion: "1" as const,
        domain: "token_selection" as const,
        operationId: id,
        kind: input.kind,
        createdAt: now,
        actionExpiresAt: "2026-07-21T00:05:00.000Z",
        target: { account: targetAccount, asset: input.asset },
        precondition: {
          accountTarget,
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
        target: { account: targetAccount, asset: input.asset },
        decision: { action: "remove_selection" as const },
        precondition: {
          accountTarget,
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
  });

  it("admits the smallest existing prefix in every reachable capacity state", () => {
    const domains = (["none", "rows", "bytes", "both"] as const).flatMap((pressure) =>
      (pressure === "both" ? [false, true] : [false])
        .map((multipleVictims) => ({ pressure, multipleVictims })));
    for (const { pressure, multipleVictims } of domains) {
      fc.assert(fc.property(retentionBudgetCase(pressure, multipleVictims), (sample) => {
        const { entries, candidate, rowCount, totalBytes } = sample;
        const { rows, resultBytes, aggregateResultBytes } = expectedTokenInspectionPersistenceLimits;
        expect(entries).toHaveLength(rowCount);
        expect(entries.reduce((sum, entry) => sum + entry.byteLength, 0)).toBe(totalBytes);
        expect(entries.every((entry) => entry.byteLength >= 2 && entry.byteLength <= resultBytes)).toBe(true);
        expect(totalBytes).toBeLessThanOrEqual(aggregateResultBytes);
        expect(rowCount + 1 > rows).toBe(sample.rowPressure);
        expect(totalBytes + candidate.byteLength > aggregateResultBytes).toBe(sample.bytePressure);
        const ordered = [...entries].sort(compareRetentionEntries);
        if (ordered.length !== 0) {
          if (sample.position === "before") expect(compareRetentionEntries(candidate, ordered[0]!)).toBeLessThan(0);
          if (sample.position === "after") expect(compareRetentionEntries(candidate, ordered.at(-1)!)).toBeGreaterThan(0);
          if (sample.position === "within") {
            expect(compareRetentionEntries(candidate, ordered[0]!)).toBeGreaterThan(0);
            expect(compareRetentionEntries(candidate, ordered.at(-1)!)).toBeLessThan(0);
          }
        }
        if (sample.multipleVictims) {
          expect(totalBytes + candidate.byteLength - ordered[0]!.byteLength)
            .toBeGreaterThan(aggregateResultBytes);
        }
        const expected = expectedRetentionVictims(entries, candidate);
        const victims = selectTokenInspectionRetentionVictims(entries, candidate);
        expect(victims).toEqual(expected);
        expect(victims.map(retentionIdentity)).not.toContain(retentionIdentity(candidate));
        const prefixBytes = [0];
        for (const entry of ordered) prefixBytes.push(prefixBytes.at(-1)! + entry.byteLength);
        expect(rowCount + 1 - victims.length).toBeLessThanOrEqual(rows);
        expect(totalBytes + candidate.byteLength - prefixBytes[victims.length]!)
          .toBeLessThanOrEqual(aggregateResultBytes);
        expect(prefixBytes.slice(0, victims.length).every((removedBytes, count) =>
          rowCount + 1 - count > rows ||
          totalBytes + candidate.byteLength - removedBytes > aggregateResultBytes)).toBe(true);
      }), { numRuns: 25, endOnFailure: true });
    }
  }, 20_000);

  it("keeps joint-capacity replacement and a new explicit account in one transaction", async () => {
    const binding = createInspectionBinding(chainId, undefined, {
      analysis: operationBoundaryAnalysis(606, 1),
    });
    const registry = new CapabilityBindingRegistry(new CapabilityRegistry([tokenInspectCapability]), [binding]);
    const rows: Array<Readonly<{ digest: string; bytes: Buffer }>> = [];
    for (let index = 0; index < 4_096; index += 1) {
      const inspection = await registry.invoke(tokenInspectCapability, {
        asset: { kind: "erc20", chainId, address: operationBoundaryAsset },
        block: { kind: "latest" },
      }, { signal: new AbortController().signal });
      if (!inspection.ok) throw new Error("Joint-capacity inspection fixture was rejected.");
      const value = inspection as unknown as IndependentJson;
      rows.push(Object.freeze({
        digest: independentTokenInspectionDigest(value),
        bytes: Buffer.from(independentCanonicalJson(value), "utf8"),
      }));
    }
    expect(rows.every((row) => row.bytes.length === 16_384)).toBe(true);
    expect(new Set(rows.map((row) => row.digest)).size).toBe(rows.length);
    const candidate = await operationBoundaryInspection(90, 45);
    const candidateValue = candidate as unknown as IndependentJson;
    const candidateBytes = Buffer.from(independentCanonicalJson(candidateValue), "utf8");
    const candidateDigest = independentTokenInspectionDigest(candidateValue);
    expect(candidateBytes.length).toBe(60_000);
    const metadata = rows.map((row) => ({
      chainId, contractAddress: operationBoundaryAsset,
      inspectionDigest: row.digest, byteLength: row.bytes.length,
    }));
    const expectedVictims = expectedRetentionVictims(metadata, {
      chainId, contractAddress: operationBoundaryAsset,
      inspectionDigest: candidateDigest, byteLength: candidateBytes.length,
    });
    expect(expectedVictims.length).toBeGreaterThan(1);
    const firstVictim = expectedVictims[0]!;
    const newAccount: EvmAccountIdentity = Object.freeze({
      chainId, address: parseEvmAddressInput(`0x${"3a".repeat(20)}`),
    });
    const initial = await openDatabase();
    const database = initial.database;
    try {
      const seed = new Database(initial.path);
      try {
        seed.pragma("foreign_keys = ON");
        seed.transaction(() => {
          seed.prepare("INSERT INTO contract(chain_id, contract_address) VALUES (?, ?)")
            .run(chainId, operationBoundaryAsset);
          seed.prepare("INSERT INTO token_contract(chain_id, contract_address) VALUES (?, ?)")
            .run(chainId, operationBoundaryAsset);
          const insert = seed.prepare(`INSERT INTO token_contract_inspection(
            chain_id, contract_address, inspection_digest, result_bytes
          ) VALUES (?, ?, ?, ?)`);
          for (const row of rows) insert.run(chainId, operationBoundaryAsset, row.digest, row.bytes);
          seed.prepare(`INSERT INTO account_token_selection_state(
            profile_id, chain_id, account_address, revision, defaults_initialized, created_at, updated_at
          ) SELECT profile_id, ?, ?, ?, 0, ?, ? FROM local_profile WHERE singleton = 1`)
            .run(chainId, account.address, setRevision(110), now, now);
          seed.prepare(`INSERT INTO account_token_selection(
            profile_id, chain_id, account_address, token_address, inspection_digest,
            included, revision, created_at, updated_at
          ) SELECT profile_id, ?, ?, ?, ?, 1, ?, ?, ? FROM local_profile WHERE singleton = 1`)
            .run(chainId, account.address, operationBoundaryAsset, firstVictim.inspectionDigest,
              selectionRevision(111), now, now);
        })();
        expect(seed.prepare(`SELECT count(*) AS rows, sum(length(result_bytes)) AS bytes
          FROM token_contract_inspection`).get()).toEqual({ rows: 4_096, bytes: 67_108_864 });
      } finally {
        seed.close();
      }

      let probe: Database.Database | undefined;
      try {
        const snapshot = await sourceSnapshot(database);
        const store = database.tokenCatalogStore();
        const action = selectionAction({
          kind: "add", account: newAccount, connectionRevision: null,
          asset: candidate.data.asset, previousSelection: null, currentSetRevision: null,
          inspection: candidate, snapshotRevision: snapshot.revision,
        });
        const command = {
          action, selectionRevision: selectionRevision(112), selectionSetRevision: setRevision(113),
        };
        probe = new Database(initial.path);
        const originalSelection = probe.prepare(`SELECT * FROM account_token_selection`).all();
        const originalState = probe.prepare(`SELECT * FROM account_token_selection_state`).all();
        probe.exec(`CREATE TRIGGER reject_joint_terminal BEFORE INSERT ON token_selection_operation
          BEGIN SELECT RAISE(ABORT, 'reject joint-pressure terminal operation'); END`);
        expect(failureCode(() => apply(store, command))).toBe("runtime_state_unavailable");
        const orderedRows = [...rows].sort((left, right) => compareTestText(left.digest, right.digest));
        const restoredRows = probe.prepare(`SELECT inspection_digest AS digest, result_bytes AS bytes
          FROM token_contract_inspection ORDER BY inspection_digest`).iterate() as
          IterableIterator<{ digest: string; bytes: Buffer }>;
        let restoredCount = 0;
        for (const restored of restoredRows) {
          const expected = orderedRows[restoredCount];
          expect(expected).toBeDefined();
          expect(restored.digest).toBe(expected!.digest);
          expect(restored.bytes.equals(expected!.bytes)).toBe(true);
          restoredCount += 1;
        }
        expect(restoredCount).toBe(rows.length);
        expect(probe.prepare("SELECT * FROM account_token_selection").all()).toEqual(originalSelection);
        expect(probe.prepare("SELECT * FROM account_token_selection_state").all()).toEqual(originalState);
        expect(probe.prepare("SELECT count(*) AS count FROM account WHERE account_address = ?")
          .get(newAccount.address)).toEqual({ count: 0 });
        expect(probe.prepare("SELECT count(*) AS count FROM token_selection_operation").get())
          .toEqual({ count: 0 });
        probe.exec("DROP TRIGGER reject_joint_terminal");

        const completed = apply(store, command);
        const removed = new Set(expectedVictims.map((entry) => entry.inspectionDigest));
        const expectedDigests = [...rows.filter((row) => !removed.has(row.digest)).map((row) => row.digest),
          candidateDigest].sort(compareTestText);
        expect(probe.prepare(`SELECT inspection_digest AS digest FROM token_contract_inspection
          ORDER BY inspection_digest`).all()).toEqual(expectedDigests.map((digest) => ({ digest })));
        expect(probe.prepare(`SELECT count(*) AS rows, sum(length(result_bytes)) AS bytes
          FROM token_contract_inspection`).get()).toEqual({
          rows: 4_097 - expectedVictims.length,
          bytes: 67_108_864 + candidateBytes.length -
            expectedVictims.reduce((total, victim) => total + victim.byteLength, 0),
        });
        expect(store.getSelection(account, candidate.data.asset)?.historicalInspection).toBeNull();
        expect(store.getSelection(account, candidate.data.asset)?.selection.revision).toBe(selectionRevision(111));
        expect(store.getSelectionState(account)?.revision).toBe(setRevision(110));
        expect(database.accountTokenSelectionStore().isAccountRetained(newAccount)).toBe(true);
        expect(store.getSelection(newAccount, candidate.data.asset)?.historicalInspection).toEqual(candidate);
        expect(completed.result.selection.historicalInspection).toEqual(candidate);
        expect(store.readOperation(completed.operationId)).toEqual(completed);
        expect(probe.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        probe?.close();
      }
    } finally {
      database.close();
    }

    const reopened = await ProductDatabase.open(initial.path, now);
    try {
      expect(reopened.tokenCatalogStore().getSelection(newAccount, candidate.data.asset)?.historicalInspection)
        .toEqual(candidate);
      expect(reopened.tokenCatalogStore().getSelection(account, candidate.data.asset)?.historicalInspection)
        .toBeNull();
    } finally {
      reopened.close();
    }
  }, 60_000);

  it("keeps exact operation delivery and removal independent of retained inspection size", async () => {
    const { database, connection } = await openDatabase();
    const snapshot = await sourceSnapshot(database);
    const inspection = await operationBoundaryInspection(840);
    expect(canonicalByteLength(inspection)).toBe(63_759);
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
    const inspection = await operationBoundaryInspection(841);
    expect(canonicalByteLength(inspection)).toBe(63_760);
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
      "account_token_selection_state",
      "account_token_selection",
      "token_selection_operation",
    ]) expect(raw.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(), table)
      .toEqual({ count: 0 });
    raw.close();
    const profileId = database.ownerStore().readProfile().profileId;
    database.close();

    const existing = new Database(path);
    const insert = existing.prepare(`INSERT INTO token_selection_operation(
      profile_id, operation_id, kind, initiated_by, review_digest,
      chain_id, account_address, token_address, operation_json
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
      "account_token_selection_state",
      "account_token_selection",
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
      raw.prepare(`INSERT INTO account(profile_id, chain_id, account_address)
        SELECT profile_id, ?, ? FROM local_profile WHERE singleton = 1`)
        .run(chainId, secondAccount.address);
      raw.prepare(`INSERT INTO account_token_selection_state(
        profile_id, chain_id, account_address, revision, defaults_initialized, created_at, updated_at
      ) SELECT profile_id, ?, ?, ?, 0, ?, ? FROM local_profile WHERE singleton = 1`)
        .run(chainId, secondAccount.address, setRevision(78), now, now);
      raw.prepare(`INSERT INTO account_token_selection(
        profile_id, chain_id, account_address, token_address, inspection_digest,
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
    const candidate = await operationBoundaryInspection(840);
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
      .toEqual({ rowCount: 1_024, aggregateBytes: 67_107_087 });
    expect(afterRetention.prepare(`SELECT count(*) AS count FROM token_contract_inspection
      WHERE inspection_digest = ?`).get(victim.digest)).toEqual({ count: 0 });
    expect(afterRetention.prepare(`SELECT inspection_digest AS inspectionDigest, revision
      FROM account_token_selection WHERE account_address = ? AND token_address = ?`)
      .get(secondAccount.address, operationBoundaryAsset))
      .toEqual({ inspectionDigest: victim.digest, revision: selectionRevision(79) });
    expect(afterRetention.prepare(`SELECT revision FROM account_token_selection_state
      WHERE account_address = ?`).get(secondAccount.address))
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

  it("admits the exact retained-row boundary, rejects one more valid row, and replaces one victim", async () => {
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
    expect(rows.reduce((total, row) => total + row.bytes.length, 0))
      .toBeLessThan(67_108_864);
    expect(rows.every((row) => row.bytes.length <= 65_536)).toBe(true);
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
    try {
      const oneOver = new Database(path);
      try {
        oneOver.pragma("foreign_keys = ON");
        oneOver.prepare(`INSERT INTO token_contract_inspection(
          chain_id, contract_address, inspection_digest, result_bytes
        ) VALUES (?, ?, ?, ?)`).run(chainId, operationBoundaryAsset, candidate.digest, candidate.bytes);
      } finally { oneOver.close(); }
      let rowFailure: unknown;
      let unexpectedlyAdmitted: ProductDatabase | undefined;
      try { unexpectedlyAdmitted = await ProductDatabase.open(path, now); }
      catch (error) { rowFailure = error; }
      finally { unexpectedlyAdmitted?.close(); }
      expect(getRuntimeOperationFailure(rowFailure)?.error.code).toBe("runtime_state_unavailable");
      const restoreExact = new Database(path);
      try {
        expect(restoreExact.prepare(`DELETE FROM token_contract_inspection
          WHERE chain_id = ? AND contract_address = ? AND inspection_digest = ?`)
          .run(chainId, operationBoundaryAsset, candidate.digest).changes).toBe(1);
      } finally { restoreExact.close(); }

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
      expect(rolledBack.prepare(`SELECT count(*) AS count FROM account_token_selection
        WHERE account_address = ?`).get(secondAccount.address)).toEqual({ count: 0 });
      expect(rolledBack.prepare(`SELECT count(*) AS count FROM token_selection_operation
        WHERE operation_id = ?`).get(rollbackAction.action.review.operationId)).toEqual({ count: 0 });
      rolledBack.close();
    } finally {
      exact.close();
    }
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
    raw.prepare(`INSERT INTO account_token_selection_state(
      profile_id, chain_id, account_address, revision, defaults_initialized, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 0, ?, ?)`).run(
      profileId,
      chainId,
      walletAddress,
      setRevision(86),
      now,
      now,
    );
    const insert = raw.prepare(`INSERT INTO account_token_selection(
      profile_id, chain_id, account_address, token_address, inspection_digest,
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

  it("rejects one-over inspection bytes on startup", async () => {
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
  }, 30_000);

  it("returns an exact duplicate operation before reclassifying a later oversized inspection", async () => {
    const { database, connection } = await openDatabase();
    const snapshot = await sourceSnapshot(database);
    const admittedInspection = await operationBoundaryInspection(840);
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
    const unretainedAccount: EvmAccountIdentity = Object.freeze({
      chainId,
      address: parseEvmAddressInput(`0x${"39".repeat(20)}`),
    });
    expect(failureCode(() => store.initializeDefaults({
      account: unretainedAccount,
      snapshotRevision: snapshot.revision,
      verifiedDefaults,
      now,
    }))).toBe("state_conflict");
    expect(store.isAccountRetained(unretainedAccount)).toBe(false);

    const initialized = store.initializeDefaults({
      account,
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
    expect(raw.prepare("SELECT COUNT(*) AS count FROM account_token_selection").get()).toEqual({ count: 1 });
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
    expect(raw.prepare(`SELECT account_address AS accountAddress,
      inspection_digest AS inspectionDigest FROM account_token_selection
      WHERE token_address = ? ORDER BY account_address`).all(input.asset.address)).toEqual([
      { accountAddress: account.address, inspectionDigest: tokenInspectionDigest(firstInspection) },
      { accountAddress: secondAccount.address, inspectionDigest: tokenInspectionDigest(secondInspection) },
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
      snapshotRevision: snapshot.revision,
      verifiedDefaults: defaults,
      now,
    });
    const raw = new Database(path);
    expect(() => raw.prepare("DELETE FROM account WHERE chain_id = ? AND account_address = ?")
      .run(chainId, walletAddress)).toThrow();
    expect(raw.prepare("DELETE FROM robinhood_asset_snapshot WHERE chain_id = ?").run(chainId).changes).toBe(1);
    expect(raw.prepare("SELECT COUNT(*) AS count FROM robinhood_asset").get()).toEqual({ count: 0 });
    expect(raw.prepare("SELECT COUNT(*) AS count FROM account_token_selection").get()).toEqual({ count: 5 });
    expect(raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(raw.pragma("integrity_check", { simple: true })).toBe("ok");
    raw.close();
    database.close();
  });
  it("rejects stored selection flags before converting them on startup and live reads", async () => {
    const { database, path } = await openDatabase();
    const raw = new Database(path);
    const profileId = database.ownerStore().readProfile().profileId;
    const asset = { kind: "erc20" as const, chainId, address: operationBoundaryAsset };
    try {
      raw.prepare("INSERT INTO contract VALUES (?, ?)").run(chainId, asset.address);
      raw.prepare("INSERT INTO token_contract VALUES (?, ?)").run(chainId, asset.address);
      raw.prepare("INSERT INTO account_token_selection_state VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(profileId, chainId, walletAddress, setRevision(1), 0, now, now);
      raw.prepare("INSERT INTO account_token_selection VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(profileId, chainId, walletAddress, asset.address, null, 0, selectionRevision(1), now, now);
      const store = database.tokenCatalogStore();
      for (const value of [0, 1]) {
        raw.prepare("UPDATE account_token_selection SET included = ?").run(value);
        raw.prepare("UPDATE account_token_selection_state SET defaults_initialized = ?").run(value);
        expect(store.getSelection(account, asset)?.selection.included).toBe(value === 1);
        expect(store.getSelectionState(account)?.defaultsInitialized).toBe(value === 1);
      }
      raw.pragma("ignore_check_constraints = ON");
      for (const [table, column, read] of [
        ["account_token_selection", "included", () => store.getSelection(account, asset)],
        ["account_token_selection_state", "defaults_initialized", () => store.getSelectionState(account)],
      ] as const) {
        raw.prepare(`UPDATE ${table} SET ${column} = 2`).run();
        expect(read).toThrowError(TokenCatalogOperationError);
        if (column === "included") {
          expect(() => database.tokenCatalogReadStore().listSelections({
            account, limit: 1, cursor: null,
          })).toThrowError(TokenCatalogOperationError);
          expect(() => database.accountTokenSelectionStore().listIncludedForAccount({
            account, cursor: null, limit: 1, excludedAddresses: [],
          })).toThrowError(TokenCatalogOperationError);
        }
        let failure: unknown;
        try { (await ProductDatabase.open(path, now)).close(); } catch (error) { failure = error; }
        expect(getRuntimeOperationFailure(failure)?.error.code).toBe("runtime_state_unavailable");
        raw.prepare(`UPDATE ${table} SET ${column} = 1`).run();
        expect(read).not.toThrow();
      }
      const nextAddress = `0x${"13".repeat(20)}`;
      raw.prepare("INSERT INTO contract VALUES (?, ?)").run(chainId, nextAddress);
      raw.prepare("INSERT INTO token_contract VALUES (?, ?)").run(chainId, nextAddress);
      raw.prepare("INSERT INTO account_token_selection VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(profileId, chainId, walletAddress, nextAddress, null, 1, selectionRevision(2), now,
          "2026-07-20T00:00:00.000Z");
      expect(store.getSelection(account, asset)?.selection.included).toBe(true);
      expect(() => store.listSelections({ account, cursor: null, limit: 1 }))
        .toThrowError(TokenCatalogOperationError);
    } finally { raw.close(); database.close(); }
  });

  it("reads an official header and its members from one snapshot during a concurrent committed replacement", async () => {
    const { database, path } = await openDatabase();
    const originalSnapshot = await sourceSnapshot(database);
    const replacement = await sourceObservation([{
      id: `0x${"99".repeat(32)}`,
      contractAddress: operationBoundaryAsset,
      tokenName: "Added member",
      tokenSymbol: "ADD",
    }]);
    const second = await ProductDatabase.open(path, now);
    const originalPrepare = Database.prototype.prepare;
    let replaced = false;
    const spy = vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
      this: Database.Database, sql: string,
    ) {
      const statement = originalPrepare.call(this, sql);
      if (sql.includes("FROM robinhood_asset_snapshot ORDER BY")) {
        const all = statement.all.bind(statement);
        statement.all = (...parameters: unknown[]) => {
          const rows = Reflect.apply(all, statement, parameters) as unknown[];
          if (!replaced) {
            replaced = true;
            second.officialAssetSnapshotStore().replaceSnapshot(replacement, originalSnapshot.revision);
          }
          return rows;
        };
      }
      return statement;
    });
    try {
      expect(database.officialAssetSnapshotStore().readSnapshot()).toEqual(originalSnapshot);
      expect(replaced).toBe(true);
      expect(database.officialAssetSnapshotStore().readSnapshot()?.members).toEqual(replacement.members);
    } finally { spy.mockRestore(); second.close(); database.close(); }
  });

  it("bounds the actual official member result before canonical snapshot admission", async () => {
    const { database, path } = await openDatabase();
    await sourceSnapshot(database);
    const raw = new Database(path);
    let memberSql: string | undefined;
    const reads: { parameters: unknown[]; rows: number }[] = [];
    const originalPrepare = Database.prototype.prepare;
    const spy = vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
      this: Database.Database, sql: string,
    ) {
      const statement = originalPrepare.call(this, sql);
      if (sql.includes("FROM robinhood_asset\n")) {
        memberSql = sql;
        const all = statement.all.bind(statement);
        statement.all = (...parameters: unknown[]) => {
          const rows = Reflect.apply(all, statement, parameters) as unknown[];
          reads.push({ parameters, rows: rows.length });
          return rows;
        };
      }
      return statement;
    });
    database.officialAssetSnapshotStore().readSnapshot();
    try {
      expect(memberSql).toBeDefined();
      raw.transaction(() => {
        raw.prepare("DELETE FROM robinhood_asset").run();
        for (let index = 1; index <= 514; index += 1) {
          raw.prepare("INSERT INTO robinhood_asset VALUES (?, ?, ?, ?, ?)").run(
            chainId, `0x${index.toString(16).padStart(40, "0")}`,
            `0x${index.toString(16).padStart(64, "0")}`, "Member", "M",
          );
        }
      })();
      expect(raw.prepare(memberSql!).all(chainId, 513)).toHaveLength(513);
      expect(raw.prepare(memberSql!.replace(" LIMIT ?", "")).all(chainId)).toHaveLength(514);
      reads.length = 0;
      expect(() => database.officialAssetSnapshotStore().readSnapshot()).toThrow();
      expect(reads).toEqual([{ parameters: [chainId, 513], rows: 513 }]);
    } finally { spy.mockRestore(); raw.close(); database.close(); }
  });

  it("rejects a cache BOM before a canonical result can hide the stored byte difference", async () => {
    const { database, path } = await openDatabase();
    const inspection = await createInspectionSuccess({
      asset: { kind: "erc20", chainId, address: operationBoundaryAsset }, block: { kind: "latest" },
    });
    const raw = new Database(path);
    try {
      const profileId = database.ownerStore().readProfile().profileId;
      const digest = tokenInspectionDigest(inspection);
      raw.prepare("INSERT INTO contract VALUES (?, ?)").run(chainId, operationBoundaryAsset);
      raw.prepare("INSERT INTO token_contract VALUES (?, ?)").run(chainId, operationBoundaryAsset);
      raw.prepare("INSERT INTO token_contract_inspection VALUES (?, ?, ?, ?)").run(
        chainId, operationBoundaryAsset, digest, Buffer.from(canonicalJsonStringify(captureCanonicalJson(inspection))),
      );
      raw.prepare("INSERT INTO account_token_selection_state VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(profileId, chainId, walletAddress, setRevision(1), 0, now, now);
      raw.prepare("INSERT INTO account_token_selection VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(profileId, chainId, walletAddress, operationBoundaryAsset, digest, 1, selectionRevision(1), now, now);
      expect(database.tokenCatalogStore().getSelection(account, inspection.data.asset)?.historicalInspection)
        .toEqual(inspection);
      raw.prepare("UPDATE token_contract_inspection SET result_bytes = ?").run(
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]),
          Buffer.from(canonicalJsonStringify(captureCanonicalJson(inspection)))]),
      );
      expect(() => database.tokenCatalogStore().getSelection(account, inspection.data.asset))
        .toThrowError(TokenCatalogOperationError);
    } finally { raw.close(); database.close(); }
  });

});
