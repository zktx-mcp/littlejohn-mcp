import { constants } from "node:fs";
import { randomBytes } from "node:crypto";
import { link, lstat, open, readdir, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import Database from "better-sqlite3";

import {
  canonicalJsonStringify,
  canonicalBase64UrlSchema,
  createExactRational,
  decodeCanonicalBase64Url,
  deepFreezeValue,
  erc20AssetIdentitySchema,
  evmAccountIdentitySchema,
  parseEvmAccountIdentity,
  parseEvmChainId,
  parseEvmContractIdentity,
  parseCapabilityDataAt,
  productChainId,
  parseReferenceCompositeRoundId,
  parseUtcTimestamp,
  findReferenceFeed,
  findReferencePair,
  initialReferenceWatchlistRevision,
  referenceFeedIntegrityStatusSchema,
  referenceFeedIds,
  referenceFeedIdSchema,
  referenceFeedTraversalStateSchema,
  referenceFeedTraversalStatusSchema,
  referenceMarketLimits,
  referenceMarketManifestVersion,
  referencePairManifestEntrySchema,
  referenceRoundObservationSchema,
  referenceRoundReadEvidenceSchema,
  referenceSupportedPairIdSchema,
  referenceWatchlistRevisionSchema,
  referenceWatchlistSuccessSchema,
  walletConnectionCapability,
  type CanonicalJson,
  type EvmAccountIdentity,
  type EvmChainId,
  type ReferenceFeedId,
  type ReferenceFeedIntegrityStatus,
  type ReferenceFeedTraversalStatus,
  type ReferencePairId,
  type ReferenceRoundObservation,
  type ReferenceWatchlistSuccess,
  type UtcTimestamp,
  type WalletConnectionData,
} from "../core/index.js";
import {
  assertCommittedOfficialAssetSnapshot,
  assertRobinhoodOfficialAssetSourceObservation,
  assertOfficialAssetSourceMember,
  defaultStockTokenManifest,
  findOfficialAssetMember,
  officialAssetSnapshotRevisionSchema,
  officialAssetSourceDefinition,
  stockFactoryVerificationSchema,
  type CommittedOfficialAssetSnapshot,
  type OfficialAssetSnapshotStore,
  type OfficialAssetSourceMember,
} from "../registry/index.js";
import {
  tokenCatalogContractLimits,
  tokenCatalogConfirmedOperationSchema,
  tokenCatalogOperationSchema,
  tokenInspectionDigest,
  tokenInspectionSuccessSchema,
  tokenSelectionSchema,
  tokenSelectionDetailSchema,
  tokenSelectionRevisionSchema,
  tokenSelectionSetRevisionSchema,
  tokenSelectionStateSchema,
  type TokenInspectionSuccess,
  type TokenSelection,
  type TokenSelectionDetail,
  type TokenSelectionState,
} from "../token-catalog/contracts.js";
import { TokenCatalogOperationError } from "../token-catalog/operation-error.js";
import type {
  AccountTokenSelectionReadPort,
  AccountTokenSelectionStore,
  TokenCatalogQueryStore,
  TokenCatalogConfirmationCommand,
  TokenCatalogStore,
  TokenSelectionPage,
} from "../token-catalog/ports.js";
import { getRuntimeOperationFailure, RuntimeOperationError } from "./errors.js";
import {
  attestOwnerOnlyStateFile,
  acquireOwnerOnlyStateFileLease,
  createOwnerOnlyStateFile,
  sameOwnerOnlyStateFileIdentity,
  type OwnerOnlyStateFileLease,
  type OwnerOnlyStateFileObservation,
} from "./paths.js";
import {
  createProfileId,
  parseOwnerInstanceId,
  parseProfileId,
  parseRuntimeConfigurationMac,
  parseRuntimeRevision,
  type OwnerInstanceId,
  type ProfileId,
  type RuntimeConfigurationMac,
  type RuntimeRevision,
} from "./runtime-identity.js";
import {
  createRuntimeStateResetRequiredError,
  currentSqliteSchemaSql,
  getRuntimeStateResetRequiredError,
  hasExactCurrentSqliteStructure,
} from "./sqlite-schema.js";
import {
  decodeWalletConnectionStorage,
  encodeWalletConnectionStorage,
  type WalletConnectionStorageRow,
} from "./wallet-connection-storage.js";
import type {
  WalletConnectionRecord,
  WalletProjectionStore,
} from "./wallet-projection.js";
import type {
  ReferenceFeedCacheCommit,
  ReferenceFeedCacheSnapshot,
  ReferenceMarketStore,
  ReferenceWatchlistMutationResult,
} from "./reference-market-storage.js";

export interface LocalProfile {
  readonly profileId: ProfileId;
  readonly createdAt: UtcTimestamp;
}

export interface RuntimeOwnerRecord {
  readonly profileId: ProfileId;
  readonly ownerInstanceId: OwnerInstanceId;
  readonly configurationMac: RuntimeConfigurationMac;
  readonly processId: number;
  readonly ownerRevision: RuntimeRevision;
  readonly acquiredAt: UtcTimestamp;
}

export interface RuntimeOwnerStore {
  readProfile(): LocalProfile;
  readOwner(): RuntimeOwnerRecord | undefined;
  publishOwner(
    ownerInstanceId: string,
    configurationMac: string,
    acquiredAt: UtcTimestamp,
  ): RuntimeOwnerRecord;
}

export interface ConfiguredChainStore {
  insertConfiguredChainIfAbsent(chainId: EvmChainId): void;
}

interface ProfileRow { singleton: number; profileId: string; createdAt: string }
interface OwnerRow {
  singleton: number;
  profileId: string;
  ownerInstanceId: string;
  configurationMac: string;
  processId: number;
  ownerRevision: string;
  acquiredAt: string;
}
interface WalletRow extends WalletConnectionStorageRow {
  singleton: number;
  profileId: string;
  revision: string;
  updatedAt: string;
}

interface ChainRow { readonly chainId: string }
interface ContractRow { readonly chainId: string; readonly contractAddress: string }
interface TokenInspectionRow {
  readonly chainId: string;
  readonly contractAddress: string;
  readonly inspectionDigest: string;
  readonly resultJson: string;
}
interface TokenSelectionRecordRow {
  readonly profileId: string;
  readonly chainId: string;
  readonly walletAddress: string;
  readonly tokenAddress: string;
  readonly included: number;
  readonly revision: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
interface TokenSelectionStateRow {
  readonly profileId: string;
  readonly chainId: string;
  readonly walletAddress: string;
  readonly revision: string;
  readonly defaultsInitialized: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
interface OfficialAssetSnapshotRow {
  readonly chainId: string;
  readonly sourceObservedAt: string;
  readonly rawResponseDigest: string;
  readonly memberSetDigest: string;
  readonly candidateListDigest: string;
  readonly revision: string;
  readonly updatedAt: string;
}
interface OfficialAssetMemberRow {
  readonly chainId: string;
  readonly contractAddress: string;
  readonly assetUid: string;
  readonly sourceName: string | null;
  readonly sourceSymbol: string | null;
}
interface ReferenceFeedRoundRow {
  readonly manifestVersion: number;
  readonly chainId: string;
  readonly feedId: string;
  readonly proxyAddress: string;
  readonly phaseId: string;
  readonly aggregatorRoundId: string;
  readonly roundId: string;
  readonly answeredInRound: string;
  readonly answer: string;
  readonly startedAtUnixSeconds: string;
  readonly updatedAtUnixSeconds: string;
  readonly readEvidenceJson: string;
}
interface ReferenceFeedSyncStateRow {
  readonly manifestVersion: number;
  readonly chainId: string;
  readonly feedId: string;
  readonly proxyAddress: string;
  readonly revision: string;
  readonly backfillPhaseId: string | null;
  readonly backfillNextRoundId: string | null;
  readonly retentionCutoffRoundId: string | null;
  readonly integrityStatus: string | null;
  readonly backfillStatus: string | null;
  readonly updatedAt: string;
}
interface ReferenceWatchlistStateRow {
  readonly profileId: string;
  readonly chainId: string;
  readonly walletAddress: string;
  readonly revision: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
interface ReferenceWatchlistEntryRow {
  readonly profileId: string;
  readonly chainId: string;
  readonly walletAddress: string;
  readonly pairId: string;
  readonly pairJson: string;
  readonly position: number;
}
export interface WalletAccountStorageRow {
  readonly profileId: string;
  readonly chainId: string;
  readonly walletAddress: string;
}

export interface WalletAccountRecordKey {
  readonly profileId: ProfileId;
  readonly account: EvmAccountIdentity;
}

export const decodeWalletAccountRecordKey = (row: WalletAccountStorageRow): WalletAccountRecordKey =>
  Object.freeze({
    profileId: parseProfileId(row.profileId),
    account: parseEvmAccountIdentity({ chainId: row.chainId, address: row.walletAddress }),
  });

const tokenCatalogStorageError = (error: unknown): Error => {
  if (error instanceof TokenCatalogOperationError) return error;
  const runtimeFailure = getRuntimeOperationFailure(error);
  if (runtimeFailure !== undefined) return new TokenCatalogOperationError(
    runtimeFailure.error.code === "runtime_busy" ? "runtime_state_unavailable" : runtimeFailure.error.code,
  );
  const normalized = storageError(error);
  return new TokenCatalogOperationError(
    getRuntimeOperationFailure(normalized)?.error.code ?? "runtime_state_unavailable",
  );
};

const decodeInspectionRow = (row: TokenInspectionRow): TokenInspectionSuccess => {
  const identity = parseEvmContractIdentity({
    chainId: row.chainId,
    contractAddress: row.contractAddress,
  });
  const parsedJson = JSON.parse(row.resultJson) as unknown;
  const inspection = tokenInspectionSuccessSchema.parse(parsedJson);
  if (
    canonicalJsonStringify(inspection as unknown as CanonicalJson) !== row.resultJson ||
    inspection.data.asset.chainId !== identity.chainId ||
    inspection.data.asset.address !== identity.contractAddress ||
    tokenInspectionDigest(inspection) !== row.inspectionDigest
  ) throw new Error("Stored token inspection is invalid.");
  return inspection;
};

const decodeTokenSelectionRecordRow = (
  row: TokenSelectionRecordRow,
  expectedProfileId?: ProfileId,
): TokenSelection => {
  const profileId = parseProfileId(row.profileId);
  if (expectedProfileId !== undefined && profileId !== expectedProfileId) {
    throw new Error("Stored token selection profile is invalid.");
  }
  const account = parseEvmAccountIdentity({ chainId: row.chainId, address: row.walletAddress });
  const asset = erc20AssetIdentitySchema.parse({
    kind: "erc20",
    chainId: row.chainId,
    address: row.tokenAddress,
  });
  return tokenSelectionSchema.parse({
    account,
    asset,
    included: row.included === 1,
    revision: tokenSelectionRevisionSchema.parse(row.revision),
    createdAt: parseUtcTimestamp(row.createdAt),
    updatedAt: parseUtcTimestamp(row.updatedAt),
  });
};

const decodeTokenSelectionStateRow = (
  row: TokenSelectionStateRow,
  expectedProfileId?: ProfileId,
): TokenSelectionState => {
  const profileId = parseProfileId(row.profileId);
  if (expectedProfileId !== undefined && profileId !== expectedProfileId) {
    throw new Error("Stored token selection state profile is invalid.");
  }
  return tokenSelectionStateSchema.parse({
    account: parseEvmAccountIdentity({ chainId: row.chainId, address: row.walletAddress }),
    revision: tokenSelectionSetRevisionSchema.parse(row.revision),
    defaultsInitialized: row.defaultsInitialized === 1,
    createdAt: parseUtcTimestamp(row.createdAt),
    updatedAt: parseUtcTimestamp(row.updatedAt),
  });
};

const decodeOfficialAssetMemberRow = (row: OfficialAssetMemberRow): OfficialAssetSourceMember =>
  assertOfficialAssetSourceMember({
    assetUid: row.assetUid as never,
    contractAddress: row.contractAddress as never,
    ...(row.sourceName === null ? {} : { sourceName: row.sourceName }),
    ...(row.sourceSymbol === null ? {} : { sourceSymbol: row.sourceSymbol }),
  });

const sqliteContentionCodes: ReadonlySet<string> = new Set([
  "SQLITE_BUSY",
  "SQLITE_BUSY_RECOVERY",
  "SQLITE_BUSY_SNAPSHOT",
  "SQLITE_BUSY_TIMEOUT",
  "SQLITE_LOCKED",
  "SQLITE_LOCKED_SHAREDCACHE",
  "SQLITE_LOCKED_VTAB",
]);

const storageError = (error: unknown): Error => {
  const resetRequired = getRuntimeStateResetRequiredError(error);
  if (resetRequired !== undefined) return resetRequired;
  if (error instanceof RuntimeOperationError) return error;
  if (error instanceof Error && "code" in error && sqliteContentionCodes.has(String(error.code))) {
    return new RuntimeOperationError("runtime_busy");
  }
  return new RuntimeOperationError("runtime_state_unavailable");
};

const exclusive = <Result>(database: Database.Database, operation: () => Result): Result => {
  database.exec("BEGIN EXCLUSIVE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* Preserve the original failure. */ }
    throw error;
  }
};

const configureConnection = (database: Database.Database): void => {
  database.pragma("foreign_keys = ON");
  if (database.pragma("foreign_keys", { simple: true }) !== 1) throw new Error("SQLite foreign keys are unavailable.");
  database.pragma("busy_timeout = 5000");
  if (database.pragma("busy_timeout", { simple: true }) !== 5_000) throw new Error("SQLite busy timeout is unavailable.");
};

const assertExistingWalMode = (database: Database.Database): void => {
  if (database.pragma("journal_mode", { simple: true }) !== "wal") {
    throw new Error("Existing SQLite state is not in WAL mode.");
  }
};

const configureFreshDatabase = (database: Database.Database): void => {
  configureConnection(database);
  if (database.pragma("journal_mode = WAL", { simple: true }) !== "wal") {
    throw new Error("SQLite WAL mode is unavailable.");
  }
};

const configureExistingDatabase = (database: Database.Database): void => {
  configureConnection(database);
  assertExistingWalMode(database);
};

const profileFromRow = (row: ProfileRow): LocalProfile => {
  if (row.singleton !== 1) throw new Error("Local profile singleton is invalid.");
  return Object.freeze({
    profileId: parseProfileId(row.profileId),
    createdAt: parseUtcTimestamp(row.createdAt),
  });
};

const ownerFromRow = (row: OwnerRow, profile: LocalProfile): RuntimeOwnerRecord => {
  if (
    row.singleton !== 1 ||
    row.profileId !== profile.profileId ||
    !Number.isSafeInteger(row.processId) ||
    row.processId <= 0
  ) throw new Error("Runtime owner projection is invalid.");
  return Object.freeze({
    profileId: profile.profileId,
    ownerInstanceId: parseOwnerInstanceId(row.ownerInstanceId),
    configurationMac: parseRuntimeConfigurationMac(row.configurationMac),
    processId: row.processId,
    ownerRevision: parseRuntimeRevision(row.ownerRevision),
    acquiredAt: parseUtcTimestamp(row.acquiredAt),
  });
};

const walletFromRow = (row: WalletRow, profile: LocalProfile): WalletConnectionRecord => {
  if (row.singleton !== 1 || row.profileId !== profile.profileId) {
    throw new Error("Wallet connection singleton is invalid.");
  }
  const updatedAt = parseUtcTimestamp(row.updatedAt);
  return Object.freeze({
    revision: parseRuntimeRevision(row.revision),
    connection: parseCapabilityDataAt(
      walletConnectionCapability,
      decodeWalletConnectionStorage(row),
      updatedAt,
    ),
    updatedAt,
  });
};

const readProfileRaw = (database: Database.Database): LocalProfile => {
  const rows = database.prepare(`SELECT singleton, profile_id AS profileId, created_at AS createdAt
    FROM local_profile ORDER BY singleton`).all() as ProfileRow[];
  if (rows.length !== 1 || rows[0] === undefined) throw new Error("Local profile is unavailable.");
  return profileFromRow(rows[0]);
};

const readOwnerRaw = (database: Database.Database): RuntimeOwnerRecord | undefined => {
  const rows = database.prepare(`SELECT singleton, profile_id AS profileId,
    owner_instance_id AS ownerInstanceId, configuration_mac AS configurationMac,
    process_id AS processId, owner_revision AS ownerRevision, acquired_at AS acquiredAt
    FROM runtime_owner ORDER BY singleton`).all() as OwnerRow[];
  if (rows.length > 1) throw new Error("Runtime owner projection is invalid.");
  return rows[0] === undefined ? undefined : ownerFromRow(rows[0], readProfileRaw(database));
};

const readWalletRaw = (database: Database.Database): WalletConnectionRecord => {
  const rows = database.prepare(`SELECT singleton, profile_id AS profileId, revision, status, reason,
    chain_id AS chainId, wallet_address AS walletAddress,
    approved_methods_json AS approvedMethodsJson,
    approved_events_json AS approvedEventsJson, expires_at AS expiresAt,
    session_count AS sessionCount, updated_at AS updatedAt
    FROM current_wallet_connection ORDER BY singleton`).all() as WalletRow[];
  if (rows.length !== 1 || rows[0] === undefined) throw new Error("Wallet connection projection is unavailable.");
  return walletFromRow(rows[0], readProfileRaw(database));
};

const readChainRows = (database: Database.Database): void => {
  const rows = database.prepare("SELECT chain_id AS chainId FROM chain ORDER BY chain_id")
    .iterate() as IterableIterator<ChainRow>;
  for (const row of rows) parseEvmChainId(row.chainId);
};

const readContractRows = (database: Database.Database, table: "contract" | "token_contract"): void => {
  const rows = database.prepare(`SELECT chain_id AS chainId, contract_address AS contractAddress
    FROM ${table} ORDER BY chain_id, contract_address`).iterate() as IterableIterator<ContractRow>;
  for (const row of rows) {
    parseEvmContractIdentity({ chainId: row.chainId, contractAddress: row.contractAddress });
  }
};

const readWalletAccountRows = (database: Database.Database): void => {
  const rows = database.prepare(`SELECT profile_id AS profileId, chain_id AS chainId,
    wallet_address AS walletAddress
    FROM wallet_account ORDER BY profile_id, chain_id, wallet_address`)
    .iterate() as IterableIterator<WalletAccountStorageRow>;
  for (const row of rows) decodeWalletAccountRecordKey(row);
};

const tokenSelectionColumns = `r.profile_id AS profileId, r.chain_id AS chainId,
  r.wallet_address AS walletAddress, r.token_address AS tokenAddress, r.included,
  r.revision, r.created_at AS createdAt, r.updated_at AS updatedAt`;

const tokenSelectionRecordSelect = `SELECT ${tokenSelectionColumns}
  FROM wallet_token_selection AS r`;

const tokenSelectionStateSelect = `SELECT profile_id AS profileId, chain_id AS chainId,
  wallet_address AS walletAddress, revision, defaults_initialized AS defaultsInitialized,
  created_at AS createdAt, updated_at AS updatedAt FROM wallet_token_selection_state`;

const readOfficialAssetSnapshotRaw = (
  database: Database.Database,
): CommittedOfficialAssetSnapshot | undefined => {
  const rows = database.prepare(`SELECT chain_id AS chainId,
    source_observed_at AS sourceObservedAt, raw_response_digest AS rawResponseDigest,
    member_set_digest AS memberSetDigest, candidate_list_digest AS candidateListDigest,
    revision, updated_at AS updatedAt FROM robinhood_asset_snapshot ORDER BY chain_id`)
    .all() as OfficialAssetSnapshotRow[];
  if (rows.length > 1) throw new Error("Official asset snapshot identity is not unique.");
  const row = rows[0];
  if (row === undefined) return undefined;
  const members = database.prepare(`SELECT chain_id AS chainId,
    contract_address AS contractAddress, asset_uid AS assetUid,
    source_name AS sourceName, source_symbol AS sourceSymbol FROM robinhood_asset
    WHERE chain_id = ? ORDER BY asset_uid, contract_address`)
    .all(row.chainId) as OfficialAssetMemberRow[];
  return assertCommittedOfficialAssetSnapshot({
    sourceUri: officialAssetSourceDefinition.sourceUri,
    sourceObservedAt: row.sourceObservedAt as never,
    rawResponseDigest: row.rawResponseDigest as never,
    memberSetDigest: row.memberSetDigest as never,
    candidateListDigest: row.candidateListDigest as never,
    chainId: row.chainId as never,
    members: members.map(decodeOfficialAssetMemberRow),
    revision: row.revision as never,
    updatedAt: row.updatedAt as never,
  });
};

const readTokenCatalogRows = (database: Database.Database): void => {
  const inspections = database.prepare(`SELECT chain_id AS chainId,
    contract_address AS contractAddress, inspection_digest AS inspectionDigest,
    result_json AS resultJson FROM token_contract_inspection
    ORDER BY chain_id, contract_address, inspection_digest`).iterate() as IterableIterator<TokenInspectionRow>;
  for (const row of inspections) decodeInspectionRow(row);
  const selections = database.prepare(`${tokenSelectionRecordSelect}
    ORDER BY r.profile_id, r.chain_id, r.wallet_address, r.token_address`)
    .iterate() as IterableIterator<TokenSelectionRecordRow>;
  for (const row of selections) decodeTokenSelectionRecordRow(row);
  const selectionStates = database.prepare(`${tokenSelectionStateSelect}
    ORDER BY profile_id, chain_id, wallet_address`)
    .iterate() as IterableIterator<TokenSelectionStateRow>;
  for (const row of selectionStates) decodeTokenSelectionStateRow(row);
  readOfficialAssetSnapshotRaw(database);
};

const referenceCacheRevisionSchema = canonicalBase64UrlSchema(referenceMarketLimits.revisionBytes);
const roundSelect = `SELECT manifest_version AS manifestVersion, chain_id AS chainId,
  feed_id AS feedId, proxy_address AS proxyAddress, phase_id AS phaseId,
  aggregator_round_id AS aggregatorRoundId, round_id AS roundId,
  answered_in_round AS answeredInRound, answer,
  started_at_unix_seconds AS startedAtUnixSeconds,
  updated_at_unix_seconds AS updatedAtUnixSeconds,
  read_evidence_json AS readEvidenceJson FROM reference_feed_round`;

const decodeReferenceRoundRow = (row: ReferenceFeedRoundRow): ReferenceRoundObservation => {
  const feedId = referenceFeedIdSchema.parse(row.feedId);
  const feed = findReferenceFeed(feedId);
  if (
    row.manifestVersion !== referenceMarketManifestVersion ||
    row.chainId !== productChainId ||
    row.proxyAddress !== feed.standardProxy
  ) throw new Error("Stored reference round identity is invalid.");
  const roundIdentity = parseReferenceCompositeRoundId(row.roundId);
  if (
    roundIdentity.phaseId !== row.phaseId ||
    roundIdentity.aggregatorRoundId !== row.aggregatorRoundId
  ) {
    throw new Error("Stored reference round decomposition is invalid.");
  }
  let rawReadEvidence: unknown;
  try { rawReadEvidence = JSON.parse(row.readEvidenceJson); }
  catch { throw new Error("Stored reference round read evidence is invalid."); }
  const readEvidence = referenceRoundReadEvidenceSchema.parse(rawReadEvidence);
  if (canonicalJsonStringify(readEvidence as unknown as CanonicalJson) !== row.readEvidenceJson) {
    throw new Error("Stored reference round read evidence is not canonical.");
  }
  return referenceRoundObservationSchema.parse({
    fact: {
      manifestVersion: referenceMarketManifestVersion,
      feedId,
      proxyAddress: feed.standardProxy,
      decimals: feed.decimals,
      roundId: row.roundId,
      answeredInRound: row.answeredInRound,
      answer: row.answer,
      startedAtUnixSeconds: row.startedAtUnixSeconds,
      updatedAtUnixSeconds: row.updatedAtUnixSeconds,
      value: createExactRational(BigInt(row.answer), 10n ** BigInt(feed.decimals)),
    },
    readEvidence,
  });
};

const decodeReferenceIntegrityStatus = (value: string | null): ReferenceFeedIntegrityStatus => {
  if (value === null) return null;
  return referenceFeedIntegrityStatusSchema.parse(value);
};

const decodeReferenceBackfillStatus = (value: string | null): ReferenceFeedTraversalStatus => {
  if (value === null) return null;
  return referenceFeedTraversalStatusSchema.parse(value);
};

const referenceStateSelect = `SELECT manifest_version AS manifestVersion, chain_id AS chainId,
  feed_id AS feedId, proxy_address AS proxyAddress, revision,
  backfill_phase_id AS backfillPhaseId,
  backfill_next_round_id AS backfillNextRoundId,
  retention_cutoff_round_id AS retentionCutoffRoundId,
  integrity_status AS integrityStatus, backfill_status AS backfillStatus, updated_at AS updatedAt
  FROM reference_feed_sync_state`;

const validateReferenceFeedStateRow = (
  row: ReferenceFeedSyncStateRow,
  expectedFeedId?: ReferenceFeedId,
): void => {
  const feedId = referenceFeedIdSchema.parse(row.feedId);
  const feed = findReferenceFeed(feedId);
  if (
    row.manifestVersion !== referenceMarketManifestVersion ||
    row.chainId !== productChainId || row.proxyAddress !== feed.standardProxy ||
    (expectedFeedId !== undefined && feedId !== expectedFeedId)
  ) throw new Error("Stored reference feed state identity is invalid.");
  referenceCacheRevisionSchema.parse(row.revision);
  const status = decodeReferenceBackfillStatus(row.backfillStatus);
  referenceFeedTraversalStateSchema.parse({
    backfillPhaseId: row.backfillPhaseId,
    backfillNextRoundId: row.backfillNextRoundId,
    retentionCutoffRoundId: row.retentionCutoffRoundId,
    backfillStatus: status,
  });
  decodeReferenceIntegrityStatus(row.integrityStatus);
  parseUtcTimestamp(row.updatedAt);
};

const readReferenceFeedRaw = (
  database: Database.Database,
  feedIdInput: ReferenceFeedId,
): ReferenceFeedCacheSnapshot => {
  const feedId = referenceFeedIdSchema.parse(feedIdInput);
  const feed = findReferenceFeed(feedId);
  const states = database.prepare(`${referenceStateSelect}
    WHERE manifest_version = ? AND chain_id = ? AND feed_id = ? AND proxy_address = ?`)
    .all(referenceMarketManifestVersion, productChainId, feedId, feed.standardProxy) as ReferenceFeedSyncStateRow[];
  if (states.length > 1) throw new Error("Stored reference feed state is not unique.");
  const state = states[0];
  if (state !== undefined) {
    validateReferenceFeedStateRow(state, feedId);
  }
  const rows = database.prepare(`${roundSelect}
    WHERE manifest_version = ? AND chain_id = ? AND feed_id = ? AND proxy_address = ?
    ORDER BY length(updated_at_unix_seconds), updated_at_unix_seconds,
      length(round_id), round_id`)
    .all(referenceMarketManifestVersion, productChainId, feedId, feed.standardProxy) as ReferenceFeedRoundRow[];
  return deepFreezeValue({
    feedId,
    revision: state?.revision ?? null,
    observations: rows.map(decodeReferenceRoundRow),
    backfillPhaseId: state?.backfillPhaseId ?? null,
    backfillNextRoundId: state?.backfillNextRoundId ?? null,
    retentionCutoffRoundId: state?.retentionCutoffRoundId ?? null,
    integrityStatus: decodeReferenceIntegrityStatus(state?.integrityStatus ?? null),
    backfillStatus: decodeReferenceBackfillStatus(state?.backfillStatus ?? null),
  });
};

const watchlistStateSelect = `SELECT profile_id AS profileId, chain_id AS chainId,
  wallet_address AS walletAddress, revision, created_at AS createdAt, updated_at AS updatedAt
  FROM reference_pair_watchlist_state`;
const watchlistEntrySelect = `SELECT profile_id AS profileId, chain_id AS chainId,
  wallet_address AS walletAddress, pair_id AS pairId, pair_json AS pairJson, position
  FROM reference_pair_watchlist_entry`;

const readReferenceWatchlistRaw = (
  database: Database.Database,
  profileId: ProfileId,
  accountInput: EvmAccountIdentity,
): ReferenceWatchlistSuccess => {
  const account = evmAccountIdentitySchema.parse(accountInput);
  const states = database.prepare(`${watchlistStateSelect}
    WHERE profile_id = ? AND chain_id = ? AND wallet_address = ?`)
    .all(profileId, account.chainId, account.address) as ReferenceWatchlistStateRow[];
  if (states.length > 1) throw new Error("Stored reference watchlist state is not unique.");
  const state = states[0];
  const rows = database.prepare(`${watchlistEntrySelect}
    WHERE profile_id = ? AND chain_id = ? AND wallet_address = ? ORDER BY position`)
    .all(profileId, account.chainId, account.address) as ReferenceWatchlistEntryRow[];
  if (state === undefined && rows.length !== 0) throw new Error("Stored reference watchlist entries are orphaned.");
  const entries = rows.map((row, index) => {
    if (
      row.profileId !== profileId || row.chainId !== account.chainId ||
      row.walletAddress !== account.address || row.position !== index
    ) throw new Error("Stored reference watchlist entry identity is invalid.");
    const parsedJson = JSON.parse(row.pairJson) as unknown;
    const pair = referencePairManifestEntrySchema.parse(parsedJson);
    if (
      pair.pairId !== row.pairId ||
      canonicalJsonStringify(pair as unknown as CanonicalJson) !== row.pairJson
    ) throw new Error("Stored reference watchlist pair is invalid.");
    return pair;
  });
  if (state !== undefined) {
    if (state.profileId !== profileId || state.chainId !== account.chainId ||
      state.walletAddress !== account.address) {
      throw new Error("Stored reference watchlist state identity is invalid.");
    }
    referenceWatchlistRevisionSchema.parse(state.revision);
    parseUtcTimestamp(state.createdAt);
    parseUtcTimestamp(state.updatedAt);
  }
  return deepFreezeValue(referenceWatchlistSuccessSchema.parse({
    account,
    revision: state?.revision ?? initialReferenceWatchlistRevision,
    entries,
  }));
};

const readReferenceMarketRows = (database: Database.Database): void => {
  const allRounds = database.prepare(`${roundSelect}
    ORDER BY manifest_version, chain_id, feed_id, proxy_address,
      length(round_id), round_id`).iterate() as IterableIterator<ReferenceFeedRoundRow>;
  for (const row of allRounds) decodeReferenceRoundRow(row);
  const allStates = database.prepare(`${referenceStateSelect}
    ORDER BY manifest_version, chain_id, feed_id, proxy_address`)
    .iterate() as IterableIterator<ReferenceFeedSyncStateRow>;
  for (const row of allStates) validateReferenceFeedStateRow(row);
  for (const feedId of referenceFeedIds) readReferenceFeedRaw(database, feedId);
  const profiles = database.prepare("SELECT profile_id AS profileId FROM local_profile")
    .all() as Array<{ profileId: string }>;
  for (const profileRow of profiles) {
    const profileId = parseProfileId(profileRow.profileId);
    const accounts = database.prepare(`SELECT profile_id AS profileId, chain_id AS chainId,
      wallet_address AS walletAddress FROM reference_pair_watchlist_state
      WHERE profile_id = ? ORDER BY chain_id, wallet_address`)
      .all(profileId) as WalletAccountStorageRow[];
    for (const row of accounts) readReferenceWatchlistRaw(database, profileId, decodeWalletAccountRecordKey(row).account);
  }
};

const createReferenceRevision = (current: string | null): string => {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const revision = referenceWatchlistRevisionSchema.parse(
      randomBytes(referenceMarketLimits.revisionBytes).toString("base64url"),
    );
    if (revision !== initialReferenceWatchlistRevision && revision !== current) return revision;
  }
  throw new Error("A distinct reference-market revision could not be generated.");
};

const validateDatabaseState = (database: Database.Database): void => {
  readProfileRaw(database);
  readOwnerRaw(database);
  readChainRows(database);
  readContractRows(database, "contract");
  readContractRows(database, "token_contract");
  readWalletAccountRows(database);
  readTokenCatalogRows(database);
  readReferenceMarketRows(database);
  readWalletRaw(database);
  if (database.prepare("PRAGMA foreign_key_check").all().length !== 0) {
    throw new Error("SQLite foreign-key state is invalid.");
  }
};

const bootstrapFreshDatabase = (database: Database.Database, now: UtcTimestamp): void => {
  exclusive(database, () => {
    if (database.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get() !== undefined) {
      throw new Error("Fresh SQLite state is not empty.");
    }
    database.exec(currentSqliteSchemaSql);
    database.pragma("user_version = 1");
    if (!hasExactCurrentSqliteStructure(database)) {
      throw new Error("Fresh SQLite structure is unavailable.");
    }
    database.prepare("INSERT INTO local_profile(singleton, profile_id, created_at) VALUES (1, ?, ?)")
      .run(createProfileId(), now);
    const initialWallet = encodeWalletConnectionStorage({ status: "unknown", reason: "reconciling" });
    const profile = readProfileRaw(database);
    database.prepare(`INSERT INTO current_wallet_connection(
      singleton, profile_id, revision, status, reason, chain_id, wallet_address,
      approved_methods_json, approved_events_json, expires_at,
      session_count, updated_at
    ) VALUES (1, ?, '0', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        profile.profileId,
        initialWallet.status,
        initialWallet.reason,
        initialWallet.chainId,
        initialWallet.walletAddress,
        initialWallet.approvedMethodsJson,
        initialWallet.approvedEventsJson,
        initialWallet.expiresAt,
        initialWallet.sessionCount,
        now,
      );
    validateDatabaseState(database);
  });
};

const syncDirectory = async (path: string): Promise<void> => {
  if (process.platform === "win32") return;
  const handle = await open(path, constants.O_RDONLY);
  try { await handle.sync(); }
  finally { await handle.close(); }
};

const removeIfPresent = async (path: string): Promise<boolean> => {
  try {
    await unlink(path);
    return true;
  }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
};

const sqliteArtifactSuffixes = Object.freeze(["", "-wal", "-shm"] as const);
const publicationStagingSuffixPattern = /^([1-9][0-9]*)-([A-Za-z0-9_-]{22})(?:-(wal|shm))?$/u;

const reconcilePublicationStaging = async (path: string): Promise<void> => {
  const directory = dirname(path);
  const prefix = `${basename(path)}.pending-`;
  let removed = false;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.name.startsWith(prefix)) continue;
    const match = publicationStagingSuffixPattern.exec(entry.name.slice(prefix.length));
    if (match === null || !Number.isSafeInteger(Number(match[1]))) {
      throw new Error("SQLite publication staging name is invalid.");
    }
    try { decodeCanonicalBase64Url(match[2] as string, 16); }
    catch { throw new Error("SQLite publication staging name is invalid."); }
    const stagingPath = resolve(directory, entry.name);
    try {
      await attestOwnerOnlyStateFile(stagingPath);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    try { removed = await removeIfPresent(stagingPath) || removed; }
    catch (error) {
      if (process.platform === "win32" && error instanceof Error && "code" in error &&
        (error.code === "EPERM" || error.code === "EBUSY")) continue;
      throw error;
    }
  }
  if (removed) await syncDirectory(directory);
};

interface SqliteArtifactSet {
  readonly state: "fresh" | "existing";
}

interface ExistingSqliteArtifactSnapshot {
  readonly wal: OwnerOnlyStateFileObservation | undefined;
  readonly sharedMemory: OwnerOnlyStateFileObservation | undefined;
}

const artifactExists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
};

const captureOwnerOnlyArtifact = (
  path: string,
  size: Readonly<{ exact?: number }> = {},
): OwnerOnlyStateFileObservation => {
  const lease = acquireOwnerOnlyStateFileLease(path, size);
  try {
    lease.assertCurrent();
    return lease.observe();
  } finally {
    lease.close();
  }
};

const captureOptionalOwnerOnlyArtifact = (
  path: string,
): OwnerOnlyStateFileObservation | undefined => {
  try {
    return captureOwnerOnlyArtifact(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
};

const captureExistingSqliteArtifacts = (
  path: string,
  mainLease: OwnerOnlyStateFileLease,
): ExistingSqliteArtifactSnapshot => {
  mainLease.assertCurrent();
  const wal = captureOptionalOwnerOnlyArtifact(`${path}-wal`);
  const sharedMemory = captureOptionalOwnerOnlyArtifact(`${path}-shm`);
  mainLease.assertCurrent();
  return Object.freeze({ wal, sharedMemory });
};

const assertReadOnlyArtifactTransition = (
  path: string,
  mainLease: OwnerOnlyStateFileLease,
  before: ExistingSqliteArtifactSnapshot,
): void => {
  mainLease.assertCurrent();
  const after = captureExistingSqliteArtifacts(path, mainLease);
  if (before.wal === undefined) {
    if (after.wal !== undefined && after.wal.size !== 0n) {
      throw new Error("SQLite read-only admission created a non-empty WAL.");
    }
  } else if (
    after.wal === undefined ||
    !sameOwnerOnlyStateFileIdentity(before.wal, after.wal)
  ) {
    throw new Error("SQLite read-only admission changed the existing WAL artifact.");
  }
  mainLease.assertCurrent();
};

const inspectSqliteArtifactSet = async (path: string): Promise<SqliteArtifactSet> => {
  const paths = sqliteArtifactSuffixes.map((suffix) => `${path}${suffix}`);
  const present = await Promise.all(paths.map(artifactExists));
  if (present.every((value) => !value)) {
    return Object.freeze({ state: "fresh" });
  }
  if (!present[0]) throw new Error("SQLite artifact set has no main database.");
  const existingPaths = paths.filter((_candidate, index) => present[index] === true);
  for (const artifact of existingPaths) await attestOwnerOnlyStateFile(artifact);
  return Object.freeze({ state: "existing" });
};

const settleSqliteArtifactSet = async (path: string): Promise<SqliteArtifactSet> => {
  let failure: unknown;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try { return await inspectSqliteArtifactSet(path); }
    catch (error) {
      failure = error;
      await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    }
  }
  throw failure;
};

interface OpenedDatabase {
  readonly database: Database.Database;
  readonly mainLease: OwnerOnlyStateFileLease;
}

type ReadOnlyStructureAdmission =
  | Readonly<{ current: false }>
  | Readonly<{ current: true; mainLease: OwnerOnlyStateFileLease }>;

const admitExistingSqliteStructure = async (
  path: string,
): Promise<ReadOnlyStructureAdmission> => {
  const inspection = await settleSqliteArtifactSet(path);
  if (inspection.state !== "existing") throw new Error("Existing SQLite state is unavailable.");
  const mainLease = acquireOwnerOnlyStateFileLease(path);
  let database: Database.Database | undefined;
  let current: boolean | undefined;
  let failure: unknown;
  try {
    mainLease.assertCurrent();
    const before = captureExistingSqliteArtifacts(path, mainLease);
    try {
      database = new Database(path, { readonly: true, fileMustExist: true, timeout: 5_000 });
      mainLease.assertCurrent();
      current = hasExactCurrentSqliteStructure(database);
      mainLease.assertCurrent();
    } catch (error) {
      failure = error;
    } finally {
      if (database !== undefined) {
        try { database.close(); }
        catch (error) { failure ??= error; }
        database = undefined;
      }
    }
    try { assertReadOnlyArtifactTransition(path, mainLease, before); }
    catch (error) { failure ??= error; }
    if (failure !== undefined) throw failure;
    if (current === undefined) throw new Error("SQLite structure admission did not complete.");
    if (!current) {
      mainLease.close();
      return Object.freeze({ current: false });
    }
    return Object.freeze({ current: true, mainLease });
  } catch (error) {
    try { database?.close(); } catch { /* Preserve the original failure. */ }
    try { mainLease.close(); } catch { /* Preserve the original failure. */ }
    throw error;
  }
};

const openCurrentDatabase = async (
  path: string,
): Promise<OpenedDatabase> => {
  const admission = await admitExistingSqliteStructure(path);
  if (!admission.current) throw createRuntimeStateResetRequiredError();
  const { mainLease } = admission;
  let database: Database.Database | undefined;
  try {
    mainLease.assertCurrent();
    database = new Database(path, { fileMustExist: true, timeout: 5_000 });
    configureExistingDatabase(database);
    mainLease.assertCurrent();
    if (!hasExactCurrentSqliteStructure(database)) {
      throw new Error("SQLite structure changed across the read-write transition.");
    }
    mainLease.assertCurrent();
    validateDatabaseState(database);
    mainLease.assertCurrent();
    await reconcilePublicationStaging(path);
    mainLease.assertCurrent();
    return Object.freeze({ database, mainLease });
  } catch (error) {
    try { database?.close(); } catch { /* Preserve the original failure. */ }
    try { mainLease.close(); } catch { /* Preserve the original failure. */ }
    throw error;
  }
};

const createAndPublishFreshDatabase = async (path: string, now: UtcTimestamp): Promise<void> => {
  const pending = `${path}.pending-${process.pid}-${randomBytes(16).toString("base64url")}`;
  let database: Database.Database | undefined;
  try {
    await createOwnerOnlyStateFile(pending);
    database = new Database(pending, { fileMustExist: true, timeout: 5_000 });
    configureFreshDatabase(database);
    await attestOwnerOnlyStateFile(pending);
    bootstrapFreshDatabase(database, now);
    database.pragma("wal_checkpoint(TRUNCATE)");
    database.close();
    database = undefined;
    const completedPending = await settleSqliteArtifactSet(pending);
    if (completedPending.state !== "existing") throw new Error("Fresh SQLite database is incomplete.");
    try {
      await link(pending, path);
      await syncDirectory(dirname(path));
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) ||
        (error.code !== "EEXIST" && error.code !== "ENOENT")) throw error;
    }
  } finally {
    try { database?.close(); } catch { /* Preserve the original failure. */ }
    const removed = [
      await removeIfPresent(pending),
      await removeIfPresent(`${pending}-wal`),
      await removeIfPresent(`${pending}-shm`),
    ].some(Boolean);
    if (removed) await syncDirectory(dirname(path));
  }
};

export class ProductDatabase {
  readonly #database: Database.Database;
  readonly #mainLease: OwnerOnlyStateFileLease;
  readonly #ownerStore: RuntimeOwnerStore;
  readonly #configuredChainStore: ConfiguredChainStore;
  readonly #walletStore: WalletProjectionStore;
  readonly #officialAssetSnapshotStore: OfficialAssetSnapshotStore;
  readonly #tokenCatalogReadStore: TokenCatalogQueryStore;
  readonly #accountTokenSelectionStore: AccountTokenSelectionStore;
  readonly #tokenCatalogStore: TokenCatalogStore;
  readonly #referenceMarketStore: ReferenceMarketStore;
  #databaseClosed = false;
  #mainLeaseClosed = false;

  private constructor(opened: OpenedDatabase) {
    this.#database = opened.database;
    this.#mainLease = opened.mainLease;
    this.#ownerStore = Object.freeze({
      readProfile: () => this.readProfile(),
      readOwner: () => this.readOwner(),
      publishOwner: (ownerInstanceId: string, configurationMac: string, acquiredAt: UtcTimestamp) =>
        this.publishOwner(ownerInstanceId, configurationMac, acquiredAt),
    });
    this.#configuredChainStore = Object.freeze({
      insertConfiguredChainIfAbsent: (chainId: EvmChainId) => this.insertConfiguredChainIfAbsent(chainId),
    });
    this.#walletStore = Object.freeze({
      read: () => this.readWalletConnection(),
      replace: (expectedRevision: string, connection: WalletConnectionData, updatedAt: UtcTimestamp) =>
        this.replaceWalletConnection(expectedRevision, connection, updatedAt),
    });
    this.#officialAssetSnapshotStore = Object.freeze({
      readSnapshot: () => this.readOfficialAssetSnapshot(),
      replaceSnapshot: (snapshot, expectedRevision) =>
        this.replaceOfficialAssetSnapshot(snapshot, expectedRevision),
    } satisfies OfficialAssetSnapshotStore);
    this.#tokenCatalogReadStore = Object.freeze({
      getSelection: (account, asset) => this.getTokenSelection(account, asset),
      getSelectionState: (account) => this.getTokenSelectionState(account),
      listSelections: (input) => this.listTokenSelections(input),
    } satisfies TokenCatalogQueryStore);
    this.#accountTokenSelectionStore = Object.freeze({
      getState: (account) => this.getTokenSelectionState(account),
      getForAccount: ({ account, asset }) => this.getTokenSelection(account, asset),
      listIncludedForAccount: (input) => this.listIncludedTokenSelections(input),
      initializeDefaults: (input) => this.initializeDefaultTokenSelections(input),
    } satisfies AccountTokenSelectionStore);
    this.#tokenCatalogStore = Object.freeze({
      getSelection: (account, asset) => this.getTokenSelection(account, asset),
      getSelectionState: (account) => this.getTokenSelectionState(account),
      listSelections: (input) => this.listTokenSelections(input),
      applyConfirmation: (input) => this.applyTokenConfirmation(input),
    } satisfies TokenCatalogStore);
    this.#referenceMarketStore = Object.freeze({
      readFeed: (feedId) => this.readReferenceFeed(feedId),
      commitFeed: (input) => this.commitReferenceFeed(input),
      readWatchlist: (account) => this.readReferenceWatchlist(account),
      mutateWatchlist: (input) => this.mutateReferenceWatchlist(input),
    } satisfies ReferenceMarketStore);
  }

  static async open(
    path: string,
    nowInput: UtcTimestamp,
  ): Promise<ProductDatabase> {
    try {
      const now = parseUtcTimestamp(nowInput);
      const initial = await settleSqliteArtifactSet(path);
      let publicationFailure: unknown;
      if (initial.state === "fresh") {
        try { await createAndPublishFreshDatabase(path, now); }
        catch (error) { publicationFailure = error; }
      }
      if (publicationFailure !== undefined) {
        try { return new ProductDatabase(await openCurrentDatabase(path)); }
        catch (error) {
          if (getRuntimeStateResetRequiredError(error) !== undefined) throw error;
          throw publicationFailure;
        }
      }
      return new ProductDatabase(await openCurrentDatabase(path));
    } catch (error) { throw storageError(error); }
  }

  ownerStore(): RuntimeOwnerStore { return this.#ownerStore; }
  configuredChainStore(): ConfiguredChainStore { return this.#configuredChainStore; }
  walletStore(): WalletProjectionStore { return this.#walletStore; }
  officialAssetSnapshotStore(): OfficialAssetSnapshotStore { return this.#officialAssetSnapshotStore; }
  tokenCatalogReadStore(): TokenCatalogQueryStore { return this.#tokenCatalogReadStore; }
  accountTokenSelectionStore(): AccountTokenSelectionStore {
    return this.#accountTokenSelectionStore;
  }
  tokenCatalogStore(): TokenCatalogStore { return this.#tokenCatalogStore; }
  referenceMarketStore(): ReferenceMarketStore { return this.#referenceMarketStore; }

  close(): void {
    let failure: unknown;
    if (!this.#databaseClosed) {
      try {
        this.#database.close();
        this.#databaseClosed = true;
      } catch (error) { failure = error; }
    }
    if (this.#databaseClosed && !this.#mainLeaseClosed) {
      try {
        this.#mainLease.close();
        this.#mainLeaseClosed = true;
      } catch (error) { failure ??= error; }
    }
    if (failure !== undefined) throw storageError(failure);
  }

  #readWithIdentity<Result>(operation: () => Result): Result {
    this.#mainLease.assertCurrent();
    const result = operation();
    this.#mainLease.assertCurrent();
    return result;
  }

  #writeWithIdentity<Result>(operation: () => Result): Result {
    this.#mainLease.assertCurrent();
    const result = exclusive(this.#database, () => {
      this.#mainLease.assertCurrent();
      const value = operation();
      this.#mainLease.assertCurrent();
      return value;
    });
    this.#mainLease.assertCurrent();
    return result;
  }

  private readProfile(): LocalProfile {
    try { return this.#readWithIdentity(() => readProfileRaw(this.#database)); }
    catch (error) { throw storageError(error); }
  }

  private readOwner(): RuntimeOwnerRecord | undefined {
    try { return this.#readWithIdentity(() => readOwnerRaw(this.#database)); }
    catch (error) { throw storageError(error); }
  }

  private publishOwner(
    ownerInstanceId: string,
    configurationMacInput: string,
    acquiredAtInput: UtcTimestamp,
  ): RuntimeOwnerRecord {
    try {
      const parsedInstanceId = parseOwnerInstanceId(ownerInstanceId);
      const configurationMac = parseRuntimeConfigurationMac(configurationMacInput);
      const acquiredAt = parseUtcTimestamp(acquiredAtInput);
      return this.#writeWithIdentity(() => {
        const profile = readProfileRaw(this.#database);
        const current = readOwnerRaw(this.#database);
        const revision = (BigInt(current?.ownerRevision ?? "0") + 1n).toString(10);
        this.#database.prepare(`INSERT INTO runtime_owner(
          singleton, profile_id, owner_instance_id, configuration_mac, process_id,
          owner_revision, acquired_at
        ) VALUES (1, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET
          profile_id = excluded.profile_id,
          owner_instance_id = excluded.owner_instance_id,
          configuration_mac = excluded.configuration_mac,
          process_id = excluded.process_id,
          owner_revision = excluded.owner_revision,
          acquired_at = excluded.acquired_at`)
          .run(
            profile.profileId,
            parsedInstanceId,
            configurationMac,
            process.pid,
            revision,
            acquiredAt,
          );
        return readOwnerRaw(this.#database) as RuntimeOwnerRecord;
      });
    } catch (error) { throw storageError(error); }
  }

  private insertConfiguredChainIfAbsent(chainIdInput: EvmChainId): void {
    try {
      const chainId = parseEvmChainId(chainIdInput);
      this.#writeWithIdentity(() => {
        this.#database.prepare("INSERT INTO chain(chain_id) VALUES (?) ON CONFLICT(chain_id) DO NOTHING")
          .run(chainId);
        const rows = this.#database.prepare("SELECT chain_id AS chainId FROM chain WHERE chain_id = ?")
          .all(chainId) as ChainRow[];
        if (rows.length !== 1 || rows[0] === undefined || parseEvmChainId(rows[0].chainId) !== chainId) {
          throw new Error("Configured chain identity is unavailable.");
        }
      });
    } catch (error) { throw storageError(error); }
  }

  private readWalletConnection(): WalletConnectionRecord {
    try { return this.#readWithIdentity(() => readWalletRaw(this.#database)); }
    catch (error) { throw storageError(error); }
  }

  private replaceWalletConnection(
    expectedRevisionInput: string,
    connectionInput: WalletConnectionData,
    updatedAtInput: UtcTimestamp,
  ): WalletConnectionRecord {
    try {
      const expectedRevision = parseRuntimeRevision(expectedRevisionInput);
      const updatedAt = parseUtcTimestamp(updatedAtInput);
      const connection = parseCapabilityDataAt(walletConnectionCapability, connectionInput, updatedAt);
      return this.#writeWithIdentity(() => {
        const profile = readProfileRaw(this.#database);
        const current = readWalletRaw(this.#database);
        if (current.revision !== expectedRevision) throw new RuntimeOperationError("state_conflict");
        const revision = (BigInt(current.revision) + 1n).toString(10);
        const values = encodeWalletConnectionStorage(connection);
        if (connection.status === "connected") {
          this.#database.prepare(`INSERT INTO wallet_account(profile_id, chain_id, wallet_address)
            VALUES (?, ?, ?) ON CONFLICT(profile_id, chain_id, wallet_address) DO NOTHING`)
            .run(profile.profileId, connection.chainId, connection.address);
          const accountRows = this.#database.prepare(`SELECT profile_id AS profileId,
            chain_id AS chainId, wallet_address AS walletAddress FROM wallet_account
            WHERE profile_id = ? AND chain_id = ? AND wallet_address = ?`)
            .all(profile.profileId, connection.chainId, connection.address) as WalletAccountStorageRow[];
          if (accountRows.length !== 1 || accountRows[0] === undefined) {
            throw new Error("Wallet account persistence failed.");
          }
          decodeWalletAccountRecordKey(accountRows[0]);
        }
        const result = this.#database.prepare(`UPDATE current_wallet_connection SET
          revision = ?, status = ?, reason = ?, chain_id = ?, wallet_address = ?,
          approved_methods_json = ?, approved_events_json = ?, expires_at = ?,
          session_count = ?, updated_at = ?
          WHERE singleton = 1 AND revision = ?`)
          .run(
            revision, values.status, values.reason, values.chainId, values.walletAddress,
            values.approvedMethodsJson, values.approvedEventsJson, values.expiresAt,
            values.sessionCount, updatedAt, expectedRevision,
          );
        if (result.changes !== 1) throw new RuntimeOperationError("state_conflict");
        return readWalletRaw(this.#database);
      });
    } catch (error) { throw storageError(error); }
  }

  private readOfficialAssetSnapshot(): CommittedOfficialAssetSnapshot | undefined {
    try { return this.#readWithIdentity(() => readOfficialAssetSnapshotRaw(this.#database)); }
    catch (error) { throw storageError(error); }
  }

  private replaceOfficialAssetSnapshot(
    snapshotInput: Parameters<OfficialAssetSnapshotStore["replaceSnapshot"]>[0],
    expectedRevisionInput: Parameters<OfficialAssetSnapshotStore["replaceSnapshot"]>[1],
  ): CommittedOfficialAssetSnapshot {
    try {
      const snapshot = assertRobinhoodOfficialAssetSourceObservation(snapshotInput);
      const expectedRevision = expectedRevisionInput === null
        ? null
        : officialAssetSnapshotRevisionSchema.parse(expectedRevisionInput);
      return this.#writeWithIdentity(() => {
        const current = readOfficialAssetSnapshotRaw(this.#database);
        if ((current?.revision ?? null) !== expectedRevision) {
          throw new RuntimeOperationError("state_conflict");
        }
        const revision = current !== undefined &&
          current.memberSetDigest === snapshot.memberSetDigest &&
          current.candidateListDigest === snapshot.candidateListDigest
          ? current.revision
          : officialAssetSnapshotRevisionSchema.parse(randomBytes(16).toString("base64url"));
        this.#database.prepare("DELETE FROM robinhood_asset WHERE chain_id = ?")
          .run(snapshot.chainId);
        this.#database.prepare(`INSERT INTO robinhood_asset_snapshot(
          chain_id, source_observed_at, raw_response_digest, member_set_digest,
          candidate_list_digest, revision, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(chain_id) DO UPDATE SET
          source_observed_at = excluded.source_observed_at,
          raw_response_digest = excluded.raw_response_digest,
          member_set_digest = excluded.member_set_digest,
          candidate_list_digest = excluded.candidate_list_digest,
          revision = excluded.revision,
          updated_at = excluded.updated_at`)
          .run(
            snapshot.chainId,
            snapshot.sourceObservedAt,
            snapshot.rawResponseDigest,
            snapshot.memberSetDigest,
            snapshot.candidateListDigest,
            revision,
            snapshot.sourceObservedAt,
          );
        const insert = this.#database.prepare(`INSERT INTO robinhood_asset(
          chain_id, contract_address, asset_uid, source_name, source_symbol
        ) VALUES (?, ?, ?, ?, ?)`);
        for (const member of snapshot.members) {
          insert.run(
            snapshot.chainId,
            member.contractAddress,
            member.assetUid,
            member.sourceName ?? null,
            member.sourceSymbol ?? null,
          );
        }
        const stored = readOfficialAssetSnapshotRaw(this.#database);
        if (stored === undefined || stored.revision !== revision) {
          throw new Error("Official asset snapshot persistence failed.");
        }
        return stored;
      });
    } catch (error) { throw storageError(error); }
  }

  private getTokenSelectionStateRaw(
    profileId: ProfileId,
    account: EvmAccountIdentity,
  ): TokenSelectionState | undefined {
    const rows = this.#database.prepare(`${tokenSelectionStateSelect}
      WHERE profile_id = ? AND chain_id = ? AND wallet_address = ?`)
      .all(profileId, account.chainId, account.address) as TokenSelectionStateRow[];
    if (rows.length > 1) throw new Error("Token selection state identity is not unique.");
    return rows[0] === undefined ? undefined : decodeTokenSelectionStateRow(rows[0], profileId);
  }

  private getTokenSelectionState(accountInput: EvmAccountIdentity): TokenSelectionState | undefined {
    try {
      const account = evmAccountIdentitySchema.parse(accountInput);
      return this.#readWithIdentity(() => {
        const profile = readProfileRaw(this.#database);
        return this.getTokenSelectionStateRaw(profile.profileId, account);
      });
    } catch (error) { throw tokenCatalogStorageError(error); }
  }

  private getLatestInspection(asset: TokenSelection["asset"]): TokenInspectionSuccess | null {
    const rows = this.#database.prepare(`SELECT chain_id AS chainId,
      contract_address AS contractAddress, inspection_digest AS inspectionDigest,
      result_json AS resultJson FROM token_contract_inspection
      WHERE chain_id = ? AND contract_address = ? ORDER BY inspection_digest`)
      .all(asset.chainId, asset.address) as TokenInspectionRow[];
    const inspections = rows.map(decodeInspectionRow).sort((left, right) =>
      left.meta.evaluatedAt === right.meta.evaluatedAt
        ? tokenInspectionDigest(left).localeCompare(tokenInspectionDigest(right))
        : left.meta.evaluatedAt.localeCompare(right.meta.evaluatedAt));
    return inspections.at(-1) ?? null;
  }

  private getTokenSelectionRaw(
    profileId: ProfileId,
    account: EvmAccountIdentity,
    asset: TokenSelection["asset"],
  ): TokenSelectionDetail | undefined {
    const rows = this.#database.prepare(`${tokenSelectionRecordSelect}
      WHERE r.profile_id = ? AND r.chain_id = ? AND r.wallet_address = ? AND r.token_address = ?`)
      .all(profileId, account.chainId, account.address, asset.address) as TokenSelectionRecordRow[];
    if (rows.length > 1) throw new Error("Token selection identity is not unique.");
    if (rows[0] === undefined) return undefined;
    return tokenSelectionDetailSchema.parse({
      selection: decodeTokenSelectionRecordRow(rows[0], profileId),
      historicalInspection: this.getLatestInspection(asset),
    });
  }

  private getTokenSelection(
    accountInput: EvmAccountIdentity,
    assetInput: TokenSelection["asset"],
  ): TokenSelectionDetail | undefined {
    try {
      const account = evmAccountIdentitySchema.parse(accountInput);
      const asset = erc20AssetIdentitySchema.parse(assetInput);
      if (account.chainId !== asset.chainId) throw new TokenCatalogOperationError("invalid_input");
      return this.#readWithIdentity(() => {
        const profile = readProfileRaw(this.#database);
        return this.getTokenSelectionRaw(profile.profileId, account, asset);
      });
    } catch (error) { throw tokenCatalogStorageError(error); }
  }

  private listTokenSelections(input: Readonly<{
    account: EvmAccountIdentity;
    limit: number;
    cursor: TokenSelection["asset"]["address"] | null;
  }>): TokenSelectionPage {
    return this.listTokenSelectionsByAddress({ ...input, includedOnly: false, excludedAddresses: [] });
  }

  private listIncludedTokenSelections(
    input: Parameters<AccountTokenSelectionReadPort["listIncludedForAccount"]>[0],
  ): TokenSelectionPage {
    return this.listTokenSelectionsByAddress({ ...input, includedOnly: true });
  }

  private listTokenSelectionsByAddress(input: Readonly<{
    account: EvmAccountIdentity;
    limit: number;
    cursor: TokenSelection["asset"]["address"] | null;
    includedOnly: boolean;
    excludedAddresses: readonly TokenSelection["asset"]["address"][];
  }>): TokenSelectionPage {
    try {
      const account = evmAccountIdentitySchema.parse(input.account);
      if (!Number.isInteger(input.limit) || input.limit < 1 ||
        input.limit > tokenCatalogContractLimits.listMaximumLimit) {
        throw new TokenCatalogOperationError("invalid_input");
      }
      const cursor = input.cursor === null ? null : erc20AssetIdentitySchema.parse({
        kind: "erc20", chainId: account.chainId, address: input.cursor,
      }).address;
      const excluded = [...new Set(input.excludedAddresses.map((address) =>
        erc20AssetIdentitySchema.parse({ kind: "erc20", chainId: account.chainId, address }).address))];
      const excludedSql = excluded.length === 0
        ? ""
        : ` AND r.token_address NOT IN (${excluded.map(() => "?").join(", ")})`;
      return this.#readWithIdentity(() => {
        const profile = readProfileRaw(this.#database);
        const rows = this.#database.prepare(`${tokenSelectionRecordSelect}
          WHERE r.profile_id = ? AND r.chain_id = ? AND r.wallet_address = ?
            AND (? = 0 OR r.included = 1) AND (? IS NULL OR r.token_address > ?)${excludedSql}
          ORDER BY r.token_address LIMIT ?`)
          .all(
            profile.profileId, account.chainId, account.address,
            input.includedOnly ? 1 : 0, cursor, cursor, ...excluded, input.limit + 1,
          ) as TokenSelectionRecordRow[];
        const hasMore = rows.length > input.limit;
        const selections = rows.slice(0, input.limit)
          .map((row) => decodeTokenSelectionRecordRow(row, profile.profileId));
        return Object.freeze({
          selections: Object.freeze(selections),
          nextCursor: hasMore ? selections.at(-1)?.asset.address ?? null : null,
        });
      });
    } catch (error) { throw tokenCatalogStorageError(error); }
  }

  private initializeDefaultTokenSelections(
    input: Parameters<AccountTokenSelectionStore["initializeDefaults"]>[0],
  ): ReturnType<AccountTokenSelectionStore["initializeDefaults"]> {
    try {
      const account = evmAccountIdentitySchema.parse(input.account);
      const expectedConnectionRevision = parseRuntimeRevision(input.expectedConnectionRevision);
      const snapshotRevision = officialAssetSnapshotRevisionSchema.parse(input.snapshotRevision);
      const now = parseUtcTimestamp(input.now);
      return this.#writeWithIdentity(() => {
        const profile = readProfileRaw(this.#database);
        this.assertCurrentWalletConnection(account, expectedConnectionRevision);
        const snapshot = readOfficialAssetSnapshotRaw(this.#database);
        if (snapshot === undefined || snapshot.revision !== snapshotRevision) {
          throw new RuntimeOperationError("state_conflict");
        }
        const currentState = this.getTokenSelectionStateRaw(profile.profileId, account);
        if (currentState?.defaultsInitialized === true) {
          return Object.freeze({ state: currentState, selections: Object.freeze([]) });
        }
        const missing = defaultStockTokenManifest.assets.filter((entry) => {
          const asset = erc20AssetIdentitySchema.parse({
            kind: "erc20", chainId: account.chainId, address: entry.contractAddress,
          });
          if (this.getTokenSelectionRaw(profile.profileId, account, asset) !== undefined) return false;
          const member = findOfficialAssetMember(snapshot, entry.contractAddress);
          if (member === undefined) return false;
          if (member.assetUid !== entry.assetUid) {
            throw new RuntimeOperationError("state_conflict");
          }
          return true;
        });
        if (missing.length !== input.verifiedDefaults.length) {
          throw new RuntimeOperationError("state_conflict");
        }
        const verifiedDefaults = input.verifiedDefaults.map((item) => {
          const parsedVerification = stockFactoryVerificationSchema.safeParse(
            item.verification,
          );
          if (!parsedVerification.success) {
            throw new RuntimeOperationError("state_conflict");
          }
          return Object.freeze({
            asset: item.asset,
            verification: parsedVerification.data,
          });
        });
        for (let index = 0; index < missing.length; index += 1) {
          const expected = missing[index];
          const supplied = verifiedDefaults[index];
          if (expected === undefined || supplied === undefined ||
            supplied.asset.chainId !== account.chainId ||
            supplied.asset.address !== expected.contractAddress ||
            supplied.verification.assetUid !== expected.assetUid ||
            supplied.verification.contractAddress !== expected.contractAddress ||
            supplied.verification.block.chainId !== account.chainId) {
            throw new RuntimeOperationError("state_conflict");
          }
        }
        const verificationBlock = verifiedDefaults[0]?.verification.block;
        if (verificationBlock !== undefined && verifiedDefaults.some((item) =>
          item.verification.block.chainId !== verificationBlock.chainId ||
          item.verification.block.blockHash !== verificationBlock.blockHash ||
          item.verification.block.blockNumber !== verificationBlock.blockNumber ||
          item.verification.block.blockTimestamp !== verificationBlock.blockTimestamp
        )) throw new RuntimeOperationError("state_conflict");
        const stateRevision = tokenSelectionSetRevisionSchema.parse(randomBytes(16).toString("base64url"));
        if (currentState === undefined) {
          this.#database.prepare(`INSERT INTO wallet_token_selection_state(
            profile_id, chain_id, wallet_address, revision, defaults_initialized, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 1, ?, ?)`)
            .run(profile.profileId, account.chainId, account.address, stateRevision, now, now);
        } else {
          const update = this.#database.prepare(`UPDATE wallet_token_selection_state
            SET revision = ?, defaults_initialized = 1, updated_at = ?
            WHERE profile_id = ? AND chain_id = ? AND wallet_address = ?
              AND revision = ? AND defaults_initialized = 0`)
            .run(
              stateRevision, now, profile.profileId, account.chainId, account.address,
              currentState.revision,
            );
          if (update.changes !== 1) throw new RuntimeOperationError("state_conflict");
        }
        const selections: TokenSelection[] = [];
        for (const item of verifiedDefaults) {
          this.#database.prepare(`INSERT INTO contract(chain_id, contract_address) VALUES (?, ?)
            ON CONFLICT(chain_id, contract_address) DO NOTHING`).run(account.chainId, item.asset.address);
          this.#database.prepare(`INSERT INTO token_contract(chain_id, contract_address) VALUES (?, ?)
            ON CONFLICT(chain_id, contract_address) DO NOTHING`).run(account.chainId, item.asset.address);
          const revision = tokenSelectionRevisionSchema.parse(randomBytes(16).toString("base64url"));
          this.#database.prepare(`INSERT INTO wallet_token_selection(
            profile_id, chain_id, wallet_address, token_address, included, revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)`)
            .run(profile.profileId, account.chainId, account.address, item.asset.address, revision, now, now);
          const stored = this.getTokenSelectionRaw(profile.profileId, account, item.asset);
          if (stored === undefined || !stored.selection.included) {
            throw new Error("Default token selection persistence failed.");
          }
          selections.push(stored.selection);
        }
        const state = this.getTokenSelectionStateRaw(profile.profileId, account);
        if (state === undefined || !state.defaultsInitialized || state.revision !== stateRevision) {
          throw new Error("Default token selection state persistence failed.");
        }
        return deepFreezeValue({ state, selections });
      });
    } catch (error) { throw tokenCatalogStorageError(error); }
  }

  private readReferenceFeed(feedIdInput: ReferenceFeedId): ReferenceFeedCacheSnapshot {
    try {
      const feedId = referenceFeedIdSchema.parse(feedIdInput);
      return this.#readWithIdentity(() => readReferenceFeedRaw(this.#database, feedId));
    } catch (error) { throw storageError(error); }
  }

  private commitReferenceFeed(input: ReferenceFeedCacheCommit): ReferenceFeedCacheSnapshot {
    try {
      const feedId = referenceFeedIdSchema.parse(input.feedId);
      const feed = findReferenceFeed(feedId);
      const expectedRevision = input.expectedRevision === null
        ? null
        : referenceCacheRevisionSchema.parse(input.expectedRevision);
      const observations = input.observations.map((observation) =>
        referenceRoundObservationSchema.parse(observation));
      const observationIdentities = observations.map((observation) =>
        parseReferenceCompositeRoundId(observation.fact.roundId));
      if (
        observations.length > referenceMarketLimits.historyProbes + 1 ||
        observations.some((observation) => observation.fact.feedId !== feedId)
      ) {
        throw new RuntimeOperationError("state_conflict");
      }
      const backfillPhaseId = input.backfillPhaseId;
      const backfillNextRoundId = input.backfillNextRoundId;
      if (!/^[1-9][0-9]*$/u.test(input.retainAfterUnixSeconds) ||
        BigInt(input.retainAfterUnixSeconds) > 253_402_300_799n) {
        throw new TypeError("Reference history retention boundary is invalid.");
      }
      const backfillStatus = decodeReferenceBackfillStatus(input.backfillStatus);
      const now = parseUtcTimestamp(input.now);
      return this.#writeWithIdentity(() => {
        const current = readReferenceFeedRaw(this.#database, feedId);
        if (current.revision !== expectedRevision) throw new RuntimeOperationError("state_conflict");
        if (current.integrityStatus === "conflict") return current;
        const existingCutoff = current.retentionCutoffRoundId === null
          ? null
          : parseReferenceCompositeRoundId(current.retentionCutoffRoundId);
        if (
          existingCutoff !== null &&
          observationIdentities.some((identity) => BigInt(identity.roundId) <= BigInt(existingCutoff.roundId))
        ) {
          throw new RuntimeOperationError("state_conflict");
        }
        referenceFeedTraversalStateSchema.parse({
          backfillPhaseId,
          backfillNextRoundId,
          backfillStatus,
          retentionCutoffRoundId: existingCutoff?.roundId ?? null,
        });

        let changed = current.revision === null;
        let conflict = false;
        const selectExisting = this.#database.prepare(`${roundSelect}
          WHERE manifest_version = ? AND chain_id = ? AND feed_id = ? AND proxy_address = ?
            AND phase_id = ? AND aggregator_round_id = ?`);
        const insert = this.#database.prepare(`INSERT INTO reference_feed_round(
          manifest_version, chain_id, feed_id, proxy_address, phase_id, aggregator_round_id,
          round_id, answered_in_round, answer, started_at_unix_seconds, updated_at_unix_seconds,
          read_evidence_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const [index, observation] of observations.entries()) {
          const identity = observationIdentities[index]!;
          const existingRows = selectExisting.all(
            referenceMarketManifestVersion, productChainId, feedId, feed.standardProxy,
            identity.phaseId, identity.aggregatorRoundId,
          ) as ReferenceFeedRoundRow[];
          if (existingRows.length > 1) throw new Error("Stored reference round is not unique.");
          if (existingRows[0] !== undefined) {
            const existing = decodeReferenceRoundRow(existingRows[0]);
            if (canonicalJsonStringify(existing.fact as unknown as CanonicalJson) !==
              canonicalJsonStringify(observation.fact as unknown as CanonicalJson)) conflict = true;
            continue;
          }
          insert.run(
            referenceMarketManifestVersion, productChainId, feedId, feed.standardProxy,
            identity.phaseId, identity.aggregatorRoundId, identity.roundId,
            observation.fact.answeredInRound, observation.fact.answer,
            observation.fact.startedAtUnixSeconds, observation.fact.updatedAtUnixSeconds,
            canonicalJsonStringify(observation.readEvidence as unknown as CanonicalJson),
          );
          changed = true;
        }

        const storedRows = this.#database.prepare(`${roundSelect}
          WHERE manifest_version = ? AND chain_id = ? AND feed_id = ? AND proxy_address = ?
          ORDER BY length(round_id), round_id`)
          .all(referenceMarketManifestVersion, productChainId, feedId, feed.standardProxy) as ReferenceFeedRoundRow[];
        if (
          existingCutoff !== null &&
          storedRows.some((row) => BigInt(row.roundId) <= BigInt(existingCutoff.roundId))
        ) {
          throw new Error("Stored reference round is at or below the retention cutoff.");
        }
        let ageCandidate: ReferenceFeedRoundRow | undefined;
        for (let index = 0; index < storedRows.length - 1; index += 1) {
          const row = storedRows[index]!;
          if (BigInt(row.updatedAtUnixSeconds) >= BigInt(input.retainAfterUnixSeconds)) break;
          ageCandidate = row;
        }
        const capacityDeleteCount = Math.max(
          0,
          storedRows.length - referenceMarketLimits.historyRoundsPerFeed,
        );
        const capacityCandidate = capacityDeleteCount === 0
          ? undefined
          : storedRows[capacityDeleteCount - 1];
        const cutoffCandidates = [
          existingCutoff?.roundId,
          ageCandidate?.roundId,
          capacityCandidate?.roundId,
        ].filter((value): value is string => value !== undefined);
        const retentionCutoffRoundId = cutoffCandidates.length === 0
          ? null
          : cutoffCandidates.reduce((greatest, value) =>
              BigInt(value) > BigInt(greatest) ? value : greatest);
        const deleted = retentionCutoffRoundId === null
          ? []
          : storedRows.filter((row) => BigInt(row.roundId) <= BigInt(retentionCutoffRoundId));
        const retained = retentionCutoffRoundId === null
          ? storedRows
          : storedRows.filter((row) => BigInt(row.roundId) > BigInt(retentionCutoffRoundId));
        if (storedRows.length !== 0 && retained.length === 0) {
          throw new Error("Reference feed retention removed the greatest current identity.");
        }
        const remove = this.#database.prepare(`DELETE FROM reference_feed_round
          WHERE manifest_version = ? AND chain_id = ? AND feed_id = ? AND proxy_address = ?
            AND phase_id = ? AND aggregator_round_id = ?`);
        for (const row of deleted) {
          remove.run(
            referenceMarketManifestVersion, productChainId, feedId, feed.standardProxy,
            row.phaseId, row.aggregatorRoundId,
          );
        }
        if (deleted.length !== 0) changed = true;
        let finalBackfillPhaseId = backfillPhaseId;
        let finalBackfillNextRoundId = backfillNextRoundId;
        let finalBackfillStatus = backfillStatus;
        if (
          retentionCutoffRoundId !== null &&
          finalBackfillNextRoundId !== null &&
          BigInt(finalBackfillNextRoundId) <= BigInt(retentionCutoffRoundId)
        ) {
          finalBackfillPhaseId = parseReferenceCompositeRoundId(retentionCutoffRoundId).phaseId;
          finalBackfillNextRoundId = null;
          finalBackfillStatus = "retention_boundary";
        } else if (
          retentionCutoffRoundId !== null &&
          finalBackfillStatus === "retention_boundary"
        ) {
          finalBackfillPhaseId = parseReferenceCompositeRoundId(retentionCutoffRoundId).phaseId;
        }
        referenceFeedTraversalStateSchema.parse({
          backfillPhaseId: finalBackfillPhaseId,
          backfillNextRoundId: finalBackfillNextRoundId,
          backfillStatus: finalBackfillStatus,
          retentionCutoffRoundId,
        });
        const finalIntegrity = conflict ? "conflict" : current.integrityStatus;
        if (
          current.backfillPhaseId !== finalBackfillPhaseId ||
          current.backfillNextRoundId !== finalBackfillNextRoundId ||
          current.integrityStatus !== finalIntegrity ||
          current.backfillStatus !== finalBackfillStatus ||
          current.retentionCutoffRoundId !== retentionCutoffRoundId
        ) changed = true;
        if (!changed) return current;

        const revision = createReferenceRevision(current.revision);
        this.#database.prepare(`INSERT INTO reference_feed_sync_state(
          manifest_version, chain_id, feed_id, proxy_address, revision, backfill_phase_id,
          backfill_next_round_id,
          retention_cutoff_round_id, integrity_status, backfill_status, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(manifest_version, chain_id, feed_id, proxy_address) DO UPDATE SET
          revision = excluded.revision, backfill_phase_id = excluded.backfill_phase_id,
          backfill_next_round_id = excluded.backfill_next_round_id,
          retention_cutoff_round_id = excluded.retention_cutoff_round_id,
          integrity_status = excluded.integrity_status, backfill_status = excluded.backfill_status,
          updated_at = excluded.updated_at`)
          .run(
            referenceMarketManifestVersion, productChainId, feedId, feed.standardProxy,
            revision, finalBackfillPhaseId, finalBackfillNextRoundId,
            retentionCutoffRoundId, finalIntegrity, finalBackfillStatus, now,
          );
        const stored = readReferenceFeedRaw(this.#database, feedId);
        if (
          stored.revision !== revision || stored.integrityStatus !== finalIntegrity ||
          stored.backfillPhaseId !== finalBackfillPhaseId ||
          stored.backfillStatus !== finalBackfillStatus ||
          stored.backfillNextRoundId !== finalBackfillNextRoundId ||
          stored.retentionCutoffRoundId !== retentionCutoffRoundId ||
          stored.observations.length > referenceMarketLimits.historyRoundsPerFeed ||
          (retentionCutoffRoundId !== null && stored.observations.some((observation) =>
            BigInt(observation.fact.roundId) <= BigInt(retentionCutoffRoundId)))
        ) {
          throw new Error("Reference feed cache postcondition failed.");
        }
        return stored;
      });
    } catch (error) { throw storageError(error); }
  }

  private readReferenceWatchlist(accountInput: EvmAccountIdentity): ReferenceWatchlistSuccess {
    try {
      const account = evmAccountIdentitySchema.parse(accountInput);
      return this.#readWithIdentity(() =>
        readReferenceWatchlistRaw(this.#database, readProfileRaw(this.#database).profileId, account));
    } catch (error) { throw storageError(error); }
  }

  private mutateReferenceWatchlist(
    input: Parameters<ReferenceMarketStore["mutateWatchlist"]>[0],
  ): ReferenceWatchlistMutationResult {
    try {
      const account = evmAccountIdentitySchema.parse(input.account);
      const expectedConnectionRevision = parseRuntimeRevision(input.expectedConnectionRevision);
      const expectedRevision = referenceWatchlistRevisionSchema.parse(input.expectedRevision);
      const now = parseUtcTimestamp(input.now);
      const mutation = input.mutation.kind === "reorder"
        ? Object.freeze({
            kind: "reorder" as const,
            pairIds: Object.freeze(input.mutation.pairIds.map((pairId) =>
              referenceSupportedPairIdSchema.parse(pairId))),
          })
        : input.mutation.kind === "add"
          ? Object.freeze({
              kind: "add" as const,
              pairId: referenceSupportedPairIdSchema.parse(input.mutation.pairId),
            })
          : Object.freeze({
              kind: "remove" as const,
              pairId: referenceSupportedPairIdSchema.parse(input.mutation.pairId),
            });
      return this.#writeWithIdentity(() => {
        const profile = readProfileRaw(this.#database);
        this.assertCurrentWalletConnection(account, expectedConnectionRevision);
        const current = readReferenceWatchlistRaw(this.#database, profile.profileId, account);
        if (current.revision !== expectedRevision) throw new RuntimeOperationError("state_conflict");
        const currentIds = current.entries.map((entry) => entry.pairId);
        let nextIds: readonly ReferencePairId[];
        if (mutation.kind === "add") {
          if (currentIds.length >= referenceMarketLimits.watchlistEntries) {
            return Object.freeze({ status: "rejected", reason: "watchlist_full" });
          }
          if (currentIds.includes(mutation.pairId)) {
            return Object.freeze({ status: "rejected", reason: "watchlist_pair_already_saved" });
          }
          nextIds = Object.freeze([...currentIds, mutation.pairId]);
        } else if (mutation.kind === "remove") {
          if (!currentIds.includes(mutation.pairId)) {
            return Object.freeze({ status: "rejected", reason: "watchlist_pair_not_found" });
          }
          nextIds = Object.freeze(currentIds.filter((pairId) => pairId !== mutation.pairId));
        } else {
          if (new Set(mutation.pairIds).size !== mutation.pairIds.length ||
            mutation.pairIds.length !== currentIds.length ||
            mutation.pairIds.some((pairId) => !currentIds.includes(pairId))) {
            return Object.freeze({ status: "rejected", reason: "watchlist_order_conflict" });
          }
          if (mutation.pairIds.every((pairId, index) => pairId === currentIds[index])) {
            return Object.freeze({ status: "success", watchlist: current });
          }
          nextIds = mutation.pairIds;
        }

        const revision = createReferenceRevision(current.revision);
        const stateRows = this.#database.prepare(`${watchlistStateSelect}
          WHERE profile_id = ? AND chain_id = ? AND wallet_address = ?`)
          .all(profile.profileId, account.chainId, account.address) as ReferenceWatchlistStateRow[];
        if (stateRows.length === 0) {
          this.#database.prepare(`INSERT INTO reference_pair_watchlist_state(
            profile_id, chain_id, wallet_address, revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)`)
            .run(profile.profileId, account.chainId, account.address, revision, now, now);
        } else {
          const update = this.#database.prepare(`UPDATE reference_pair_watchlist_state
            SET revision = ?, updated_at = ?
            WHERE profile_id = ? AND chain_id = ? AND wallet_address = ? AND revision = ?`)
            .run(
              revision, now, profile.profileId, account.chainId, account.address, current.revision,
            );
          if (update.changes !== 1) throw new RuntimeOperationError("state_conflict");
        }
        this.#database.prepare(`DELETE FROM reference_pair_watchlist_entry
          WHERE profile_id = ? AND chain_id = ? AND wallet_address = ?`)
          .run(profile.profileId, account.chainId, account.address);
        const insert = this.#database.prepare(`INSERT INTO reference_pair_watchlist_entry(
          profile_id, chain_id, wallet_address, pair_id, pair_json, position
        ) VALUES (?, ?, ?, ?, ?, ?)`);
        nextIds.forEach((pairId, position) => {
          const pair = findReferencePair(pairId);
          insert.run(
            profile.profileId, account.chainId, account.address, pairId,
            canonicalJsonStringify(pair as unknown as CanonicalJson), position,
          );
        });
        const stored = readReferenceWatchlistRaw(this.#database, profile.profileId, account);
        if (stored.revision !== revision || stored.entries.length !== nextIds.length ||
          stored.entries.some((entry, index) => entry.pairId !== nextIds[index])) {
          throw new Error("Reference watchlist postcondition failed.");
        }
        return Object.freeze({ status: "success", watchlist: stored });
      });
    } catch (error) { throw storageError(error); }
  }

  private assertCurrentWalletConnection(
    account: EvmAccountIdentity,
    expectedRevision: RuntimeRevision,
  ): void {
    const current = readWalletRaw(this.#database);
    if (
      current.revision !== expectedRevision ||
      current.connection.status !== "connected" ||
      current.connection.chainId !== account.chainId ||
      current.connection.address !== account.address
    ) throw new RuntimeOperationError("state_conflict");
  }

  private applyTokenConfirmation(
    input: TokenCatalogConfirmationCommand,
  ): ReturnType<TokenCatalogStore["applyConfirmation"]> {
    try {
      const operation = tokenCatalogOperationSchema.parse(input.operation);
      if (operation.state !== "applying" || operation.kind !== input.kind) {
        throw new TokenCatalogOperationError("invalid_input");
      }
      const account = evmAccountIdentitySchema.parse(operation.account);
      const asset = erc20AssetIdentitySchema.parse(operation.asset);
      const expectedConnectionRevision = parseRuntimeRevision(input.expectedConnectionRevision);
      return this.#writeWithIdentity(() => {
        const profile = readProfileRaw(this.#database);
        this.assertCurrentWalletConnection(account, expectedConnectionRevision);
        const inspection = operation.review.inspection === null
          ? null
          : tokenInspectionSuccessSchema.parse(operation.review.inspection);
        const revision = tokenSelectionRevisionSchema.parse(input.selectionRevision);
        const stateRevision = tokenSelectionSetRevisionSchema.parse(input.selectionSetRevision);
        const now = parseUtcTimestamp(input.now);
        let state = this.getTokenSelectionStateRaw(profile.profileId, account);
        if ((state?.revision ?? null) !== operation.review.selectionSetRevision) {
          throw new TokenCatalogOperationError("token_selection_revision_changed");
        }
        if (stateRevision === state?.revision) throw new TokenCatalogOperationError("state_conflict");
        if (state === undefined) {
          this.#database.prepare(`INSERT INTO wallet_token_selection_state(
            profile_id, chain_id, wallet_address, revision, defaults_initialized, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 0, ?, ?)`)
            .run(profile.profileId, account.chainId, account.address, stateRevision, now, now);
        }
        const current = this.getTokenSelectionRaw(profile.profileId, account, asset);
        if (canonicalJsonStringify((current?.selection ?? null) as unknown as CanonicalJson) !==
          canonicalJsonStringify(operation.review.previousSelection as unknown as CanonicalJson)) {
          throw new TokenCatalogOperationError("token_selection_revision_changed");
        }

        if (input.kind === "add" && operation.kind === "add") {
          if (inspection === null) throw new TokenCatalogOperationError("internal_error");
          const inspectionDigest = operation.review.inspectionDigest;
          if (inspectionDigest === null) {
            throw new TokenCatalogOperationError("internal_error");
          }
          const snapshot = readOfficialAssetSnapshotRaw(this.#database);
          if (snapshot === undefined || snapshot.revision !== operation.review.officialSnapshotRevision) {
            throw new RuntimeOperationError("state_conflict");
          }
          const member = findOfficialAssetMember(snapshot, asset.address);
          const parsedVerification = input.officialVerification === null
            ? null
            : stockFactoryVerificationSchema.safeParse(input.officialVerification);
          if (parsedVerification !== null && !parsedVerification.success) {
            throw new RuntimeOperationError("state_conflict");
          }
          const verification = parsedVerification?.data ?? null;
          if ((member === undefined) !== (verification === null) ||
            (member !== undefined && verification !== null && (
              verification.assetUid !== member.assetUid ||
              verification.contractAddress !== member.contractAddress ||
              verification.block.chainId !== account.chainId ||
              operation.review.officialEvidence?.assetUid !== member.assetUid ||
              operation.review.officialEvidence.verificationBlock.chainId !== verification.block.chainId ||
              operation.review.officialEvidence.verificationBlock.blockNumber !== verification.block.blockNumber ||
              operation.review.officialEvidence.verificationBlock.blockHash !== verification.block.blockHash ||
              operation.review.officialEvidence.verificationBlock.blockTimestamp !== verification.block.blockTimestamp
            ))) throw new RuntimeOperationError("state_conflict");
          const resultJson = canonicalJsonStringify(inspection as unknown as CanonicalJson);
          if (current?.selection.included === true) {
            throw new TokenCatalogOperationError("token_selection_already_included");
          }
          this.#database.prepare(`INSERT INTO contract(chain_id, contract_address) VALUES (?, ?)
            ON CONFLICT(chain_id, contract_address) DO NOTHING`).run(asset.chainId, asset.address);
          this.#database.prepare(`INSERT INTO token_contract(chain_id, contract_address) VALUES (?, ?)
            ON CONFLICT(chain_id, contract_address) DO NOTHING`).run(asset.chainId, asset.address);
          const inspectionRows = this.#database.prepare(`SELECT chain_id AS chainId,
            contract_address AS contractAddress, inspection_digest AS inspectionDigest,
            result_json AS resultJson FROM token_contract_inspection
            WHERE chain_id = ? AND contract_address = ? AND inspection_digest = ?`)
            .all(asset.chainId, asset.address, inspectionDigest) as TokenInspectionRow[];
          if (inspectionRows.length === 0) {
            this.#database.prepare(`INSERT INTO token_contract_inspection(
              chain_id, contract_address, inspection_digest, result_json
            ) VALUES (?, ?, ?, ?)`).run(asset.chainId, asset.address, inspectionDigest, resultJson);
          } else if (inspectionRows.length !== 1 || inspectionRows[0]?.resultJson !== resultJson) {
            throw new Error("Token inspection digest collision detected.");
          } else {
            decodeInspectionRow(inspectionRows[0]);
          }
          this.#database.prepare(`INSERT INTO wallet_token_selection(
            profile_id, chain_id, wallet_address, token_address, included, revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)
          ON CONFLICT(profile_id, chain_id, wallet_address, token_address) DO UPDATE SET
            included = 1, revision = excluded.revision, updated_at = excluded.updated_at`)
            .run(profile.profileId, account.chainId, account.address, asset.address, revision, now, now);
        } else if (input.kind === "remove" && operation.kind === "remove") {
          const previous = operation.review.previousSelection;
          if (previous === null || !previous.included || current === undefined) {
            throw new TokenCatalogOperationError("token_selection_not_included");
          }
          const removal = this.#database.prepare(`UPDATE wallet_token_selection
            SET included = 0, revision = ?, updated_at = ?
            WHERE profile_id = ? AND chain_id = ? AND wallet_address = ?
              AND token_address = ? AND revision = ? AND included = 1`)
            .run(
              revision, now, profile.profileId, account.chainId, account.address,
              asset.address, previous.revision,
            );
          if (removal.changes !== 1) {
            throw new TokenCatalogOperationError("token_selection_revision_changed");
          }
        } else {
          throw new TokenCatalogOperationError("invalid_input");
        }

        if (state !== undefined) {
          const stateUpdate = this.#database.prepare(`UPDATE wallet_token_selection_state
            SET revision = ?, updated_at = ?
            WHERE profile_id = ? AND chain_id = ? AND wallet_address = ? AND revision = ?`)
            .run(
              stateRevision, now, profile.profileId, account.chainId, account.address, state.revision,
            );
          if (stateUpdate.changes !== 1) throw new RuntimeOperationError("state_conflict");
        }
        state = this.getTokenSelectionStateRaw(profile.profileId, account);
        const stored = this.getTokenSelectionRaw(profile.profileId, account, asset);
        if (state?.revision !== stateRevision || stored === undefined ||
          stored.selection.revision !== revision ||
          stored.selection.included !== (operation.kind === "add")) {
          throw new Error("Token selection persistence postcondition failed.");
        }
        const result: TokenSelectionDetail = operation.kind === "add"
          ? tokenSelectionDetailSchema.parse({
              selection: stored.selection,
              historicalInspection: inspection,
            })
          : stored;

        return deepFreezeValue(tokenCatalogConfirmedOperationSchema.parse({
          ...operation,
          state: "completed",
          result,
          failure: null,
        }));
      });
    } catch (error) { throw tokenCatalogStorageError(error); }
  }

}
