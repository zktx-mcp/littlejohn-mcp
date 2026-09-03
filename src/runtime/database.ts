import { constants } from "node:fs";
import { randomBytes } from "node:crypto";
import { link, lstat, open, readdir, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import Database from "better-sqlite3";

import {
  canonicalJsonStringify,
  captureCanonicalJson,
  compareCodePointSequences,
  decodeCanonicalBase64Url,
  deepFreezeValue,
  erc20AssetIdentitySchema,
  evmAccountIdentitySchema,
  operationIdSchema,
  parseEvmAccountIdentity,
  parseEvmChainId,
  parseEvmContractIdentity,
  parseHash32,
  parseCapabilityDataAt,
  parseUtcTimestamp,
  sha256Bytes,
  walletConnectionCapability,
  type CanonicalJson,
  type EvmAccountIdentity,
  type EvmChainId,
  type UtcTimestamp,
  type WalletConnectionData,
} from "../core/index.js";
import {
  presentationSnapshotLimits,
  type PresentationSnapshotRecord,
  type PresentationSnapshotResult,
  type PresentationSnapshotStore,
  type PresentationSnapshotUnavailableReason,
} from "./presentation-snapshot.js";
import {
  assertCommittedOfficialAssetSnapshot,
  assertRobinhoodOfficialAssetSourceObservation,
  assertOfficialAssetSourceMember,
  defaultStockTokenManifest,
  findOfficialAssetMember,
  officialAssetSnapshotRevisionByteLength,
  officialAssetSnapshotRevisionSchema,
  stockFactoryVerificationSchema,
  type CommittedOfficialAssetSnapshot,
  type OfficialAssetSnapshotStore,
  type OfficialAssetSourceMember,
} from "../registry/index.js";
import {
  createTokenAdditionReviewProjection,
  parseTokenCatalogOperation,
  tokenCatalogContractLimits,
  tokenCatalogOperationSchema,
  tokenSelectionDirectActionSchema,
  tokenInspectionDigest,
  tokenInspectionSuccessSchema,
  tokenSelectionSchema,
  tokenSelectionDetailSchema,
  tokenSelectionRevisionSchema,
  tokenSelectionSetRevisionSchema,
  tokenSelectionStateSchema,
  type TokenCatalogOperation,
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
  TokenSelectionActionCommand,
  TokenCatalogStore,
  TokenSelectionPage,
} from "../token-catalog/ports.js";
import {
  assertWalletOperationTransition,
  parseWalletManagementOperation,
  type WalletManagementOperation,
  type WalletNonterminalManagementOperation,
} from "../wallet/operation-contract.js";
import {
  isWalletOperationTerminalState,
  walletNonterminalOperationStates,
} from "../wallet/operation-state.js";
import type {
  WalletOperationStore,
  WalletOperationTransitionCommand,
} from "../wallet/contracts.js";
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
interface PresentationSnapshotRow {
  readonly snapshotId: string;
  readonly contractId: string;
  readonly contractVersion: string;
  readonly inputBytes: Buffer;
  readonly inputDigest: string;
  readonly resultBytes: Buffer;
  readonly resultDigest: string;
  readonly resultChunkDigestsJson: string;
}
interface PresentationSnapshotMetadataRow {
  readonly snapshotId: string;
  readonly contractId: string;
  readonly contractVersion: string;
  readonly inputBytes: number;
  readonly inputDigest: string;
  readonly resultBytes: number;
  readonly resultDigest: string;
  readonly resultChunkDigestsJson: string;
  readonly chunkBytes: Buffer;
}
interface WalletRow extends WalletConnectionStorageRow {
  singleton: number;
  profileId: string;
  revision: string;
  revalidationRequired: number;
  updatedAt: string;
}
interface WalletOperationRow {
  readonly profileId: string;
  readonly operationId: string;
  readonly kind: string;
  readonly initiatedBy: string;
  readonly reviewDigest: string;
  readonly connectionRevision: string;
  readonly state: string;
  readonly createdAt: string;
  readonly actionExpiresAt: string;
  readonly operationJson: Buffer;
}
interface TokenSelectionOperationRow {
  readonly profileId: string;
  readonly operationId: string;
  readonly kind: string;
  readonly initiatedBy: string;
  readonly reviewDigest: string;
  readonly chainId: string;
  readonly walletAddress: string;
  readonly tokenAddress: string;
  readonly operationJson: Buffer;
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
  readonly sourceUri: string;
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

const walletOperationSelect = `SELECT profile_id AS profileId, operation_id AS operationId,
  kind, initiated_by AS initiatedBy, review_digest AS reviewDigest,
  connection_revision AS connectionRevision, state, created_at AS createdAt,
  action_expires_at AS actionExpiresAt, operation_json AS operationJson
  FROM wallet_operation`;

const tokenSelectionOperationSelect = `SELECT profile_id AS profileId,
  operation_id AS operationId, kind, initiated_by AS initiatedBy,
  review_digest AS reviewDigest, chain_id AS chainId,
  wallet_address AS walletAddress, token_address AS tokenAddress,
  operation_json AS operationJson FROM token_selection_operation`;

const decodeWalletOperationRow = (
  row: WalletOperationRow,
  expectedProfileId?: ProfileId,
): WalletManagementOperation => {
  const profileId = parseProfileId(row.profileId);
  if (expectedProfileId !== undefined && profileId !== expectedProfileId) {
    throw new Error("Stored wallet operation profile is invalid.");
  }
  if (!Buffer.isBuffer(row.operationJson)) {
    throw new Error("Stored wallet operation bytes are invalid.");
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(row.operationJson);
  const operation = parseWalletManagementOperation(JSON.parse(text) as unknown);
  if (
    canonicalJsonStringify(operation as unknown as CanonicalJson) !== text ||
    operation.operationId !== row.operationId ||
    operation.kind !== row.kind ||
    operation.initiatedBy !== row.initiatedBy ||
    operation.review.reviewDigest !== row.reviewDigest ||
    operation.review.precondition.connectionRevision !== row.connectionRevision ||
    operation.state !== row.state ||
    operation.review.createdAt !== row.createdAt ||
    operation.review.actionExpiresAt !== row.actionExpiresAt
  ) throw new Error("Stored wallet operation does not match its indexed identity.");
  return operation;
};

const decodeTokenSelectionOperationRow = (
  row: TokenSelectionOperationRow,
  expectedProfileId?: ProfileId,
): TokenCatalogOperation => {
  const profileId = parseProfileId(row.profileId);
  if (expectedProfileId !== undefined && profileId !== expectedProfileId) {
    throw new Error("Stored token selection operation profile is invalid.");
  }
  if (!Buffer.isBuffer(row.operationJson)) {
    throw new Error("Stored token selection operation bytes are invalid.");
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(row.operationJson);
  const operation = parseTokenCatalogOperation(JSON.parse(text) as unknown);
  if (
    canonicalJsonStringify(operation as unknown as CanonicalJson) !== text ||
    operation.operationId !== row.operationId ||
    operation.kind !== row.kind ||
    operation.initiatedBy !== row.initiatedBy ||
    operation.review.reviewDigest !== row.reviewDigest ||
    operation.review.precondition.account.chainId !== row.chainId ||
    operation.review.precondition.account.address !== row.walletAddress ||
    operation.review.target.asset.address !== row.tokenAddress
  ) throw new Error("Stored token selection operation does not match its indexed identity.");
  return operation;
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

const snapshotIdPattern = /^sha256:[0-9a-f]{64}$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const positiveCanonicalDecimalPattern = /^[1-9][0-9]*$/u;

const presentationAvailable = <Value>(value: Value): PresentationSnapshotResult<Value> =>
  Object.freeze({ status: "available", value });

const presentationUnavailable = <Value>(
  reason: PresentationSnapshotUnavailableReason,
): PresentationSnapshotResult<Value> => Object.freeze({ status: "unavailable", reason });

const canonicalBytes = (value: CanonicalJson): Buffer =>
  Buffer.from(canonicalJsonStringify(value), "utf8");

const presentationResultChunkDigests = (bytes: Uint8Array): readonly string[] => Object.freeze(
  Array.from(
    { length: Math.ceil(bytes.length / presentationSnapshotLimits.resultChunkBytes) },
    (_, index) => sha256Bytes(bytes.slice(
      index * presentationSnapshotLimits.resultChunkBytes,
      Math.min((index + 1) * presentationSnapshotLimits.resultChunkBytes, bytes.length),
    )),
  ),
);

const encodePresentationResultChunkDigests = (bytes: Uint8Array): string =>
  canonicalJsonStringify(captureCanonicalJson(presentationResultChunkDigests(bytes)));

const decodePresentationResultChunkDigests = (
  value: unknown,
  expectedCount: number,
): readonly string[] => {
  if (typeof value !== "string") throw new TypeError("Stored chunk digests are invalid.");
  const captured = captureCanonicalJson(JSON.parse(value) as unknown);
  if (
    !Array.isArray(captured) || captured.length !== expectedCount ||
    captured.some((digest) => typeof digest !== "string" || !sha256Pattern.test(digest)) ||
    canonicalJsonStringify(captured) !== value
  ) throw new TypeError("Stored chunk digests are invalid.");
  return Object.freeze([...captured] as string[]);
};

const admitCanonicalBytes = (value: Buffer): CanonicalJson => {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(value);
  const admitted = captureCanonicalJson(JSON.parse(text) as unknown);
  if (canonicalJsonStringify(admitted) !== text) {
    throw new TypeError("Stored presentation JSON is not canonical.");
  }
  return admitted;
};

const parsePresentationContractIdentity = (contractId: unknown, contractVersion: unknown): Readonly<{
  contractId: string;
  contractVersion: string;
}> => {
  if (
    typeof contractId !== "string" || contractId.length === 0 || contractId.includes("\0") ||
    typeof contractVersion !== "string" || !positiveCanonicalDecimalPattern.test(contractVersion)
  ) throw new TypeError("Presentation contract identity is invalid.");
  return Object.freeze({ contractId, contractVersion });
};

const presentationSnapshotIdentity = (input: Readonly<{
  contractId: string;
  contractVersion: string;
  inputBytes: number;
  inputDigest: string;
  resultBytes: number;
  resultDigest: string;
}>): string => {
  parsePresentationContractIdentity(input.contractId, input.contractVersion);
  if (
    !Number.isSafeInteger(input.inputBytes) || input.inputBytes < 1 ||
    !Number.isSafeInteger(input.resultBytes) || input.resultBytes < 1 ||
    !sha256Pattern.test(input.inputDigest) || !sha256Pattern.test(input.resultDigest)
  ) throw new TypeError("Presentation snapshot identity fields are invalid.");
  const identityInput = [
    input.contractId,
    input.contractVersion,
    String(input.inputBytes),
    input.inputDigest,
    String(input.resultBytes),
    input.resultDigest,
  ].join("\0");
  return `sha256:${sha256Bytes(new TextEncoder().encode(identityInput))}`;
};

const snapshotSelect = `SELECT snapshot_id AS snapshotId, contract_id AS contractId,
  contract_version AS contractVersion, input_bytes AS inputBytes,
  input_digest AS inputDigest, result_bytes AS resultBytes, result_digest AS resultDigest,
  result_chunk_digests_json AS resultChunkDigestsJson
  FROM presentation_snapshot`;

const decodePresentationSnapshotRow = (row: PresentationSnapshotRow): PresentationSnapshotRecord => {
  if (!Buffer.isBuffer(row.inputBytes) || !Buffer.isBuffer(row.resultBytes)) {
    throw new TypeError("Stored presentation snapshot bytes are invalid.");
  }
  const identity = parsePresentationContractIdentity(row.contractId, row.contractVersion);
  if (
    row.inputBytes.length < 1 || row.inputBytes.length > presentationSnapshotLimits.inputBytes ||
    row.resultBytes.length < 1 || row.resultBytes.length > presentationSnapshotLimits.resultBytes
  ) throw new TypeError("Stored presentation snapshot size is invalid.");
  admitCanonicalBytes(row.inputBytes);
  admitCanonicalBytes(row.resultBytes);
  const inputDigest = sha256Bytes(row.inputBytes);
  const resultDigest = sha256Bytes(row.resultBytes);
  const chunkDigests = decodePresentationResultChunkDigests(
    row.resultChunkDigestsJson,
    Math.ceil(row.resultBytes.length / presentationSnapshotLimits.resultChunkBytes),
  );
  if (inputDigest !== row.inputDigest || resultDigest !== row.resultDigest) {
    throw new TypeError("Stored presentation snapshot digest is invalid.");
  }
  if (
    canonicalJsonStringify(captureCanonicalJson(chunkDigests)) !==
      encodePresentationResultChunkDigests(row.resultBytes)
  ) throw new TypeError("Stored presentation snapshot chunk digests are invalid.");
  const snapshotId = presentationSnapshotIdentity({
    ...identity,
    inputBytes: row.inputBytes.length,
    inputDigest,
    resultBytes: row.resultBytes.length,
    resultDigest,
  });
  if (snapshotId !== row.snapshotId || !snapshotIdPattern.test(row.snapshotId)) {
    throw new TypeError("Stored presentation snapshot identity is invalid.");
  }
  return Object.freeze({
    snapshotId,
    ...identity,
    inputBytes: Uint8Array.from(row.inputBytes),
    inputDigest,
    resultBytes: Uint8Array.from(row.resultBytes),
    resultDigest,
  });
};

const samePresentationSnapshot = (
  left: PresentationSnapshotRecord,
  right: PresentationSnapshotRecord,
): boolean => left.snapshotId === right.snapshotId &&
  left.contractId === right.contractId && left.contractVersion === right.contractVersion &&
  left.inputDigest === right.inputDigest && left.resultDigest === right.resultDigest &&
  Buffer.compare(Buffer.from(left.inputBytes), Buffer.from(right.inputBytes)) === 0 &&
  Buffer.compare(Buffer.from(left.resultBytes), Buffer.from(right.resultBytes)) === 0;

const createPresentationSnapshot = (input: Readonly<{
  contractId: string;
  contractVersion: string;
  normalizedInput: CanonicalJson;
  admittedResult: CanonicalJson;
}>): PresentationSnapshotResult<PresentationSnapshotRecord> => {
  let identity: Readonly<{ contractId: string; contractVersion: string }>;
  let inputBytes: Buffer;
  let resultBytes: Buffer;
  try {
    identity = parsePresentationContractIdentity(input.contractId, input.contractVersion);
    inputBytes = canonicalBytes(input.normalizedInput);
    resultBytes = canonicalBytes(input.admittedResult);
  } catch {
    return presentationUnavailable("snapshot_inconsistent");
  }
  if (
    inputBytes.length > presentationSnapshotLimits.inputBytes ||
    resultBytes.length > presentationSnapshotLimits.resultBytes
  ) return presentationUnavailable("capacity_exceeded");
  const inputDigest = sha256Bytes(inputBytes);
  const resultDigest = sha256Bytes(resultBytes);
  const snapshotId = presentationSnapshotIdentity({
    ...identity,
    inputBytes: inputBytes.length,
    inputDigest,
    resultBytes: resultBytes.length,
    resultDigest,
  });
  return presentationAvailable(Object.freeze({
    snapshotId,
    ...identity,
    inputBytes: Uint8Array.from(inputBytes),
    inputDigest,
    resultBytes: Uint8Array.from(resultBytes),
    resultDigest,
  }));
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
  if (
    row.singleton !== 1 ||
    row.profileId !== profile.profileId ||
    (row.revalidationRequired !== 0 && row.revalidationRequired !== 1) ||
    (row.status === "connected" && row.revalidationRequired !== 0)
  ) {
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
    revalidationRequired: row.revalidationRequired === 1,
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
  const rows = database.prepare(`SELECT singleton, profile_id AS profileId, revision,
    revalidation_required AS revalidationRequired, status, reason,
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
    source_uri AS sourceUri, source_observed_at AS sourceObservedAt,
    raw_response_digest AS rawResponseDigest,
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
    sourceUri: row.sourceUri,
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

const validateDatabaseState = (database: Database.Database): void => {
  readProfileRaw(database);
  readOwnerRaw(database);
  const snapshotCapacity = database.prepare(`SELECT count(*) AS rowCount,
    coalesce(sum(length(input_bytes) + length(result_bytes)), 0) AS aggregateBytes
    FROM presentation_snapshot`).get() as { rowCount: number; aggregateBytes: number };
  if (
    !Number.isSafeInteger(snapshotCapacity.rowCount) || snapshotCapacity.rowCount < 0 ||
    !Number.isSafeInteger(snapshotCapacity.aggregateBytes) || snapshotCapacity.aggregateBytes < 0 ||
    snapshotCapacity.rowCount > presentationSnapshotLimits.rows ||
    snapshotCapacity.aggregateBytes > presentationSnapshotLimits.aggregateBytes
  ) throw new Error("Stored presentation snapshot capacity is invalid.");
  readChainRows(database);
  readContractRows(database, "contract");
  readContractRows(database, "token_contract");
  readWalletAccountRows(database);
  readTokenCatalogRows(database);
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
      singleton, profile_id, revision, revalidation_required, status, reason, chain_id, wallet_address,
      approved_methods_json, approved_events_json, expires_at,
      session_count, updated_at
    ) VALUES (1, ?, '0', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
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
  readonly #walletOperationStore: WalletOperationStore;
  readonly #officialAssetSnapshotStore: OfficialAssetSnapshotStore;
  readonly #tokenCatalogReadStore: TokenCatalogQueryStore;
  readonly #accountTokenSelectionStore: AccountTokenSelectionStore;
  readonly #tokenCatalogStore: TokenCatalogStore;
  readonly #presentationSnapshotStore: PresentationSnapshotStore;
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
      replace: (
        expectedRevision: string,
        connection: WalletConnectionData,
        revalidationRequired: boolean,
        updatedAt: UtcTimestamp,
      ) => this.replaceWalletConnection(
        expectedRevision,
        connection,
        revalidationRequired,
        updatedAt,
      ),
    });
    this.#walletOperationStore = Object.freeze({
      read: (operationId) => this.readWalletOperation(operationId),
      readActive: () => this.readActiveWalletOperation(),
      create: (operation) => this.createWalletOperation(operation),
      transition: (command) => this.transitionWalletOperation(command),
    } satisfies WalletOperationStore);
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
      readOperation: (operationId) => this.readTokenSelectionOperation(operationId),
      applySelectionChange: (input) => this.applyTokenSelectionChange(input),
    } satisfies TokenCatalogStore);
    this.#presentationSnapshotStore = Object.freeze({
      prepare: (input) => createPresentationSnapshot(input),
      commit: (input) => this.commitPresentationSnapshot(input),
      read: (snapshotId) => this.readPresentationSnapshot(snapshotId),
      readResultChunk: (input) => this.readPresentationSnapshotResultChunk(input),
    } satisfies PresentationSnapshotStore);
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
  walletOperationStore(): WalletOperationStore { return this.#walletOperationStore; }
  officialAssetSnapshotStore(): OfficialAssetSnapshotStore { return this.#officialAssetSnapshotStore; }
  tokenCatalogReadStore(): TokenCatalogQueryStore { return this.#tokenCatalogReadStore; }
  accountTokenSelectionStore(): AccountTokenSelectionStore {
    return this.#accountTokenSelectionStore;
  }
  tokenCatalogStore(): TokenCatalogStore { return this.#tokenCatalogStore; }
  presentationSnapshotStore(): PresentationSnapshotStore { return this.#presentationSnapshotStore; }

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
    return exclusive(this.#database, () => {
      this.#mainLease.assertCurrent();
      const value = operation();
      this.#mainLease.assertCurrent();
      return value;
    });
  }

  private readProfile(): LocalProfile {
    try { return this.#readWithIdentity(() => readProfileRaw(this.#database)); }
    catch (error) { throw storageError(error); }
  }

  private commitPresentationSnapshot(
    input: Parameters<PresentationSnapshotStore["commit"]>[0],
  ): PresentationSnapshotResult<PresentationSnapshotRecord> {
    const candidate = createPresentationSnapshot(input);
    if (candidate.status === "unavailable") return candidate;
    try {
      return this.#writeWithIdentity(() => {
        const existingRows = this.#database.prepare(`${snapshotSelect} WHERE snapshot_id = ?`)
          .all(candidate.value.snapshotId) as PresentationSnapshotRow[];
        if (existingRows.length > 1) return presentationUnavailable("snapshot_inconsistent");
        const existing = existingRows[0];
        if (existing !== undefined) {
          try {
            const admitted = decodePresentationSnapshotRow(existing);
            return samePresentationSnapshot(admitted, candidate.value)
              ? presentationAvailable(admitted)
              : presentationUnavailable("snapshot_inconsistent");
          } catch { return presentationUnavailable("snapshot_inconsistent"); }
        }
        const capacity = this.#database.prepare(`SELECT count(*) AS rowCount,
          coalesce(sum(length(input_bytes) + length(result_bytes)), 0) AS aggregateBytes
          FROM presentation_snapshot`).get() as { rowCount: number; aggregateBytes: number };
        if (
          !Number.isSafeInteger(capacity.rowCount) || capacity.rowCount < 0 ||
          !Number.isSafeInteger(capacity.aggregateBytes) || capacity.aggregateBytes < 0
        ) return presentationUnavailable("snapshot_inconsistent");
        if (
          capacity.rowCount + 1 > presentationSnapshotLimits.rows ||
          capacity.aggregateBytes + candidate.value.inputBytes.length +
            candidate.value.resultBytes.length > presentationSnapshotLimits.aggregateBytes
        ) return presentationUnavailable("capacity_exceeded");
        const inserted = this.#database.prepare(`INSERT INTO presentation_snapshot(
          snapshot_id, contract_id, contract_version, input_bytes, input_digest,
          result_bytes, result_digest, result_chunk_digests_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
          candidate.value.snapshotId,
          candidate.value.contractId,
          candidate.value.contractVersion,
          Buffer.from(candidate.value.inputBytes),
          candidate.value.inputDigest,
          Buffer.from(candidate.value.resultBytes),
          candidate.value.resultDigest,
          encodePresentationResultChunkDigests(candidate.value.resultBytes),
        );
        if (inserted.changes !== 1) throw new TypeError("Presentation snapshot was not inserted.");
        return candidate;
      });
    } catch { return presentationUnavailable("runtime_unavailable"); }
  }

  private readPresentationSnapshot(
    snapshotId: string,
  ): PresentationSnapshotResult<PresentationSnapshotRecord> {
    if (!snapshotIdPattern.test(snapshotId)) return presentationUnavailable("snapshot_inconsistent");
    try {
      return this.#readWithIdentity(() => {
        const rows = this.#database.prepare(`${snapshotSelect} WHERE snapshot_id = ?`)
          .all(snapshotId) as PresentationSnapshotRow[];
        if (rows.length === 0) return presentationUnavailable("snapshot_missing");
        if (rows.length !== 1 || rows[0] === undefined) {
          return presentationUnavailable("snapshot_inconsistent");
        }
        try { return presentationAvailable(decodePresentationSnapshotRow(rows[0])); }
        catch { return presentationUnavailable("snapshot_inconsistent"); }
      });
    } catch { return presentationUnavailable("runtime_unavailable"); }
  }

  private readPresentationSnapshotResultChunk(
    input: Parameters<PresentationSnapshotStore["readResultChunk"]>[0],
  ): ReturnType<PresentationSnapshotStore["readResultChunk"]> {
    if (
      !snapshotIdPattern.test(input.snapshotId) ||
      !Number.isSafeInteger(input.index) || input.index < 0
    ) return presentationUnavailable("snapshot_inconsistent");
    try {
      return this.#readWithIdentity(() => {
        const offset = input.index * presentationSnapshotLimits.resultChunkBytes;
        if (!Number.isSafeInteger(offset)) return presentationUnavailable("snapshot_inconsistent");
        const rows = this.#database.prepare(`SELECT snapshot_id AS snapshotId,
          contract_id AS contractId, contract_version AS contractVersion,
          length(input_bytes) AS inputBytes, input_digest AS inputDigest,
          length(result_bytes) AS resultBytes, result_digest AS resultDigest,
          result_chunk_digests_json AS resultChunkDigestsJson,
          substr(result_bytes, ?, ?) AS chunkBytes
          FROM presentation_snapshot WHERE snapshot_id = ?`).all(
            offset + 1,
            presentationSnapshotLimits.resultChunkBytes,
            input.snapshotId,
          ) as PresentationSnapshotMetadataRow[];
        if (rows.length === 0) return presentationUnavailable("snapshot_missing");
        const row = rows[0];
        if (rows.length !== 1 || row === undefined || !Buffer.isBuffer(row.chunkBytes)) {
          return presentationUnavailable("snapshot_inconsistent");
        }
        let expectedId: string;
        try {
          expectedId = presentationSnapshotIdentity({
            contractId: row.contractId,
            contractVersion: row.contractVersion,
            inputBytes: row.inputBytes,
            inputDigest: row.inputDigest,
            resultBytes: row.resultBytes,
            resultDigest: row.resultDigest,
          });
        } catch { return presentationUnavailable("snapshot_inconsistent"); }
        const chunkCount = Math.ceil(row.resultBytes / presentationSnapshotLimits.resultChunkBytes);
        let chunkDigests: readonly string[];
        try {
          chunkDigests = decodePresentationResultChunkDigests(
            row.resultChunkDigestsJson,
            chunkCount,
          );
        } catch { return presentationUnavailable("snapshot_inconsistent"); }
        const expectedBytes = input.index === chunkCount - 1
          ? row.resultBytes - offset
          : presentationSnapshotLimits.resultChunkBytes;
        if (
          expectedId !== input.snapshotId || input.index >= chunkCount ||
          expectedBytes < 1 || row.chunkBytes.length !== expectedBytes ||
          chunkDigests[input.index] !== sha256Bytes(row.chunkBytes)
        ) return presentationUnavailable("snapshot_inconsistent");
        return presentationAvailable(Object.freeze({
          snapshotId: input.snapshotId,
          index: input.index,
          bytes: Uint8Array.from(row.chunkBytes),
        }));
      });
    } catch { return presentationUnavailable("runtime_unavailable"); }
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
    revalidationRequiredInput: boolean,
    updatedAtInput: UtcTimestamp,
  ): WalletConnectionRecord {
    try {
      const expectedRevision = parseRuntimeRevision(expectedRevisionInput);
      const updatedAt = parseUtcTimestamp(updatedAtInput);
      if (typeof revalidationRequiredInput !== "boolean") {
        throw new TypeError("Wallet revalidation state is invalid.");
      }
      const connection = parseCapabilityDataAt(walletConnectionCapability, connectionInput, updatedAt);
      if (connection.status === "connected" && revalidationRequiredInput) {
        throw new TypeError("A connected wallet cannot require revalidation.");
      }
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
          revision = ?, revalidation_required = ?, status = ?, reason = ?, chain_id = ?, wallet_address = ?,
          approved_methods_json = ?, approved_events_json = ?, expires_at = ?,
          session_count = ?, updated_at = ?
          WHERE singleton = 1 AND revision = ?`)
          .run(
            revision, revalidationRequiredInput ? 1 : 0,
            values.status, values.reason, values.chainId, values.walletAddress,
            values.approvedMethodsJson, values.approvedEventsJson, values.expiresAt,
            values.sessionCount, updatedAt, expectedRevision,
          );
        if (result.changes !== 1) throw new RuntimeOperationError("state_conflict");
        return readWalletRaw(this.#database);
      });
    } catch (error) { throw storageError(error); }
  }

  private readWalletOperation(
    operationIdInput: WalletManagementOperation["operationId"],
  ): WalletManagementOperation | null {
    try {
      const operationId = operationIdSchema.parse(operationIdInput);
      return this.#readWithIdentity(() => {
        const profile = readProfileRaw(this.#database);
        const rows = this.#database.prepare(`${walletOperationSelect}
          WHERE profile_id = ? AND operation_id = ?`)
          .all(profile.profileId, operationId) as WalletOperationRow[];
        if (rows.length === 0) return null;
        if (rows.length !== 1 || rows[0] === undefined) {
          throw new Error("Wallet operation identity is not unique.");
        }
        return decodeWalletOperationRow(rows[0], profile.profileId);
      });
    } catch (error) { throw storageError(error); }
  }

  private readActiveWalletOperation(): WalletNonterminalManagementOperation | null {
    try {
      return this.#readWithIdentity(() => {
        const profile = readProfileRaw(this.#database);
        const placeholders = walletNonterminalOperationStates.map(() => "?").join(", ");
        const rows = this.#database.prepare(`${walletOperationSelect}
          WHERE profile_id = ? AND state IN (${placeholders})`)
          .all(profile.profileId, ...walletNonterminalOperationStates) as WalletOperationRow[];
        if (rows.length === 0) return null;
        if (rows.length !== 1 || rows[0] === undefined) {
          throw new Error("More than one active wallet operation is stored.");
        }
        const operation = decodeWalletOperationRow(rows[0], profile.profileId);
        if (isWalletOperationTerminalState(operation.state)) {
          throw new Error("Stored active wallet operation is terminal.");
        }
        return operation as WalletNonterminalManagementOperation;
      });
    } catch (error) { throw storageError(error); }
  }

  private createWalletOperation(
    operationInput: WalletNonterminalManagementOperation,
  ): WalletNonterminalManagementOperation {
    try {
      const operation = parseWalletManagementOperation(operationInput);
      if (isWalletOperationTerminalState(operation.state)) {
        throw new TypeError("A created wallet operation must be active.");
      }
      return this.#writeWithIdentity(() => {
        const profile = readProfileRaw(this.#database);
        const existingRows = this.#database.prepare(`${walletOperationSelect}
          WHERE operation_id = ?`).all(operation.operationId) as WalletOperationRow[];
        if (existingRows.length !== 0) throw new RuntimeOperationError("state_conflict");
        const operationJson = canonicalBytes(operation as unknown as CanonicalJson);
        this.#database.prepare(`INSERT INTO wallet_operation(
          profile_id, operation_id, kind, initiated_by, review_digest,
          connection_revision, state, created_at, action_expires_at, operation_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          profile.profileId,
          operation.operationId,
          operation.kind,
          operation.initiatedBy,
          operation.review.reviewDigest,
          operation.review.precondition.connectionRevision,
          operation.state,
          operation.review.createdAt,
          operation.review.actionExpiresAt,
          operationJson,
        );
        const rows = this.#database.prepare(`${walletOperationSelect}
          WHERE profile_id = ? AND operation_id = ?`)
          .all(profile.profileId, operation.operationId) as WalletOperationRow[];
        if (rows.length !== 1 || rows[0] === undefined) {
          throw new Error("Wallet operation persistence failed.");
        }
        return decodeWalletOperationRow(rows[0], profile.profileId) as WalletNonterminalManagementOperation;
      });
    } catch (error) { throw storageError(error); }
  }

  private transitionWalletOperation(
    commandInput: WalletOperationTransitionCommand,
  ): WalletManagementOperation {
    try {
      const operation = parseWalletManagementOperation(commandInput.operation);
      const operationId = operationIdSchema.parse(commandInput.operationId);
      const reviewDigest = parseHash32(commandInput.reviewDigest);
      const connectionRevision = parseRuntimeRevision(commandInput.connectionRevision);
      const expectedState = walletNonterminalOperationStates.find((state) =>
        state === commandInput.expectedState);
      if (
        expectedState === undefined ||
        operation.operationId !== operationId ||
        operation.review.reviewDigest !== reviewDigest ||
        operation.review.precondition.connectionRevision !== connectionRevision
      ) throw new TypeError("Wallet operation transition identity is invalid.");
      return this.#writeWithIdentity(() => {
        const profile = readProfileRaw(this.#database);
        const currentRows = this.#database.prepare(`${walletOperationSelect}
          WHERE profile_id = ? AND operation_id = ?`)
          .all(profile.profileId, operationId) as WalletOperationRow[];
        if (currentRows.length !== 1 || currentRows[0] === undefined) {
          throw new RuntimeOperationError("state_conflict");
        }
        const current = decodeWalletOperationRow(currentRows[0], profile.profileId);
        if (isWalletOperationTerminalState(current.state) || current.state !== expectedState) {
          throw new RuntimeOperationError("state_conflict");
        }
        assertWalletOperationTransition(current as WalletNonterminalManagementOperation, operation);
        const update = this.#database.prepare(`UPDATE wallet_operation
          SET state = ?, operation_json = ?
          WHERE profile_id = ? AND operation_id = ? AND review_digest = ?
            AND connection_revision = ? AND state = ?`).run(
          operation.state,
          canonicalBytes(operation as unknown as CanonicalJson),
          profile.profileId,
          operationId,
          reviewDigest,
          connectionRevision,
          expectedState,
        );
        if (update.changes !== 1) throw new RuntimeOperationError("state_conflict");
        const storedRows = this.#database.prepare(`${walletOperationSelect}
          WHERE profile_id = ? AND operation_id = ?`)
          .all(profile.profileId, operationId) as WalletOperationRow[];
        if (storedRows.length !== 1 || storedRows[0] === undefined) {
          throw new Error("Wallet operation transition persistence failed.");
        }
        return decodeWalletOperationRow(storedRows[0], profile.profileId);
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
          : officialAssetSnapshotRevisionSchema.parse(
              randomBytes(officialAssetSnapshotRevisionByteLength).toString("base64url"),
            );
        this.#database.prepare("DELETE FROM robinhood_asset WHERE chain_id = ?")
          .run(snapshot.chainId);
        this.#database.prepare(`INSERT INTO robinhood_asset_snapshot(
          chain_id, source_uri, source_observed_at, raw_response_digest,
          member_set_digest, candidate_list_digest, revision, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(chain_id) DO UPDATE SET
          source_uri = excluded.source_uri,
          source_observed_at = excluded.source_observed_at,
          raw_response_digest = excluded.raw_response_digest,
          member_set_digest = excluded.member_set_digest,
          candidate_list_digest = excluded.candidate_list_digest,
          revision = excluded.revision,
          updated_at = excluded.updated_at`)
          .run(
            snapshot.chainId,
            snapshot.sourceUri,
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
        ? compareCodePointSequences(tokenInspectionDigest(left), tokenInspectionDigest(right))
        : compareCodePointSequences(left.meta.evaluatedAt, right.meta.evaluatedAt));
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
        const stateRevision = tokenSelectionSetRevisionSchema.parse(
          randomBytes(tokenCatalogContractLimits.selectionRevisionBytes).toString("base64url"),
        );
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
          const revision = tokenSelectionRevisionSchema.parse(
            randomBytes(tokenCatalogContractLimits.selectionRevisionBytes).toString("base64url"),
          );
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

  private readTokenSelectionOperation(
    operationIdInput: TokenCatalogOperation["operationId"],
  ): TokenCatalogOperation | null {
    try {
      const operationId = operationIdSchema.parse(operationIdInput);
      return this.#readWithIdentity(() => {
        const profile = readProfileRaw(this.#database);
        const rows = this.#database.prepare(`${tokenSelectionOperationSelect}
          WHERE profile_id = ? AND operation_id = ?`)
          .all(profile.profileId, operationId) as TokenSelectionOperationRow[];
        if (rows.length === 0) return null;
        if (rows.length !== 1 || rows[0] === undefined) {
          throw new Error("Token selection operation identity is not unique.");
        }
        return decodeTokenSelectionOperationRow(rows[0], profile.profileId);
      });
    } catch (error) { throw tokenCatalogStorageError(error); }
  }

  private applyTokenSelectionChange(
    input: TokenSelectionActionCommand,
  ): ReturnType<TokenCatalogStore["applySelectionChange"]> {
    try {
      const action = tokenSelectionDirectActionSchema.parse(input.action);
      const account = evmAccountIdentitySchema.parse(action.review.precondition.account);
      const asset = erc20AssetIdentitySchema.parse(action.review.target.asset);
      const expectedConnectionRevision = parseRuntimeRevision(
        action.review.precondition.connectionRevision,
      );
      const revision = tokenSelectionRevisionSchema.parse(input.selectionRevision);
      const stateRevision = tokenSelectionSetRevisionSchema.parse(input.selectionSetRevision);
      const completedAt = parseUtcTimestamp(input.completedAt);
      const inspection = input.inspection === null
        ? null
        : tokenInspectionSuccessSchema.parse(input.inspection);
      const verification = input.officialVerification === null
        ? null
        : stockFactoryVerificationSchema.parse(input.officialVerification);
      return this.#writeWithIdentity(() => {
        const profile = readProfileRaw(this.#database);
        const existingRows = this.#database.prepare(`${tokenSelectionOperationSelect}
          WHERE operation_id = ?`).all(action.review.operationId) as TokenSelectionOperationRow[];
        if (existingRows.length > 0) {
          if (existingRows.length !== 1 || existingRows[0] === undefined) {
            throw new Error("Token selection operation identity is not unique.");
          }
          const existing = decodeTokenSelectionOperationRow(existingRows[0], profile.profileId);
          if (
            existing.kind !== action.review.kind ||
            canonicalJsonStringify(existing.review as unknown as CanonicalJson) !==
              canonicalJsonStringify(action.review as unknown as CanonicalJson)
          ) throw new TokenCatalogOperationError("state_conflict");
          return existing;
        }

        this.assertCurrentWalletConnection(account, expectedConnectionRevision);
        let state = this.getTokenSelectionStateRaw(profile.profileId, account);
        if ((state?.revision ?? null) !== action.review.precondition.selectionSetRevision) {
          throw new TokenCatalogOperationError("token_selection_revision_changed");
        }
        if (stateRevision === state?.revision) throw new TokenCatalogOperationError("state_conflict");
        const current = this.getTokenSelectionRaw(profile.profileId, account, asset);
        if (
          canonicalJsonStringify((current?.selection ?? null) as unknown as CanonicalJson) !==
            canonicalJsonStringify(
              action.review.precondition.previousSelection as unknown as CanonicalJson,
            )
        ) throw new TokenCatalogOperationError("token_selection_revision_changed");

        if (action.review.kind === "add") {
          if (inspection === null) throw new TokenCatalogOperationError("invalid_input");
          const snapshot = readOfficialAssetSnapshotRaw(this.#database);
          if (
            snapshot === undefined ||
            snapshot.revision !== action.review.fixedEvidence.officialSnapshotRevision
          ) throw new RuntimeOperationError("state_conflict");
          const member = findOfficialAssetMember(snapshot, asset.address) ?? null;
          const projection = createTokenAdditionReviewProjection({
            inspection,
            officialSnapshotRevision: snapshot.revision,
            officialMember: member,
            officialVerification: verification,
          });
          if (
            canonicalJsonStringify(projection as unknown as CanonicalJson) !==
              canonicalJsonStringify({
                decision: action.review.decision,
                fixedEvidence: action.review.fixedEvidence,
              } as unknown as CanonicalJson)
          ) throw new RuntimeOperationError("state_conflict");
          if (current?.selection.included === true) {
            throw new TokenCatalogOperationError("token_selection_already_included");
          }
          const inspectionDigest = tokenInspectionDigest(inspection);
          const resultJson = canonicalJsonStringify(inspection as unknown as CanonicalJson);
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
          if (state === undefined) {
            this.#database.prepare(`INSERT INTO wallet_token_selection_state(
              profile_id, chain_id, wallet_address, revision, defaults_initialized, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 0, ?, ?)`).run(
              profile.profileId,
              account.chainId,
              account.address,
              stateRevision,
              completedAt,
              completedAt,
            );
          }
          this.#database.prepare(`INSERT INTO wallet_token_selection(
            profile_id, chain_id, wallet_address, token_address, included, revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)
          ON CONFLICT(profile_id, chain_id, wallet_address, token_address) DO UPDATE SET
            included = 1, revision = excluded.revision, updated_at = excluded.updated_at`)
            .run(
              profile.profileId,
              account.chainId,
              account.address,
              asset.address,
              revision,
              completedAt,
              completedAt,
            );
        } else {
          if (inspection !== null || verification !== null) {
            throw new TokenCatalogOperationError("invalid_input");
          }
          const previous = action.review.precondition.previousSelection;
          if (previous === null || !previous.included || current === undefined) {
            throw new TokenCatalogOperationError("token_selection_not_included");
          }
          const removal = this.#database.prepare(`UPDATE wallet_token_selection
            SET included = 0, revision = ?, updated_at = ?
            WHERE profile_id = ? AND chain_id = ? AND wallet_address = ?
              AND token_address = ? AND revision = ? AND included = 1`)
            .run(
              revision,
              completedAt,
              profile.profileId,
              account.chainId,
              account.address,
              asset.address,
              previous.revision,
            );
          if (removal.changes !== 1) {
            throw new TokenCatalogOperationError("token_selection_revision_changed");
          }
        }

        if (state !== undefined) {
          const stateUpdate = this.#database.prepare(`UPDATE wallet_token_selection_state
            SET revision = ?, updated_at = ?
            WHERE profile_id = ? AND chain_id = ? AND wallet_address = ? AND revision = ?`)
            .run(
              stateRevision,
              completedAt,
              profile.profileId,
              account.chainId,
              account.address,
              state.revision,
            );
          if (stateUpdate.changes !== 1) throw new RuntimeOperationError("state_conflict");
        }
        state = this.getTokenSelectionStateRaw(profile.profileId, account);
        const stored = this.getTokenSelectionRaw(profile.profileId, account, asset);
        if (
          state?.revision !== stateRevision ||
          stored === undefined ||
          stored.selection.revision !== revision ||
          stored.selection.included !== (action.review.kind === "add")
        ) throw new Error("Token selection persistence postcondition failed.");
        const selection: TokenSelectionDetail = action.review.kind === "add"
          ? tokenSelectionDetailSchema.parse({
              selection: stored.selection,
              historicalInspection: inspection,
            })
          : stored;
        const operation = parseTokenCatalogOperation({
          contractVersion: "1",
          domain: "token_selection",
          operationId: action.review.operationId,
          kind: action.review.kind,
          initiatedBy: action.initiatedBy,
          review: action.review,
          state: "completed",
          completedAt,
          result: {
            outcome: action.review.kind === "add" ? "selection_added" : "selection_removed",
            selectionSetRevision: stateRevision,
            selection,
          },
        });
        this.#database.prepare(`INSERT INTO token_selection_operation(
          profile_id, operation_id, kind, initiated_by, review_digest,
          chain_id, wallet_address, token_address, operation_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          profile.profileId,
          operation.operationId,
          operation.kind,
          operation.initiatedBy,
          operation.review.reviewDigest,
          account.chainId,
          account.address,
          asset.address,
          canonicalBytes(operation as unknown as CanonicalJson),
        );
        const storedRows = this.#database.prepare(`${tokenSelectionOperationSelect}
          WHERE profile_id = ? AND operation_id = ?`)
          .all(profile.profileId, operation.operationId) as TokenSelectionOperationRow[];
        if (storedRows.length !== 1 || storedRows[0] === undefined) {
          throw new Error("Token selection operation persistence failed.");
        }
        return decodeTokenSelectionOperationRow(storedRows[0], profile.profileId);
      });
    } catch (error) { throw tokenCatalogStorageError(error); }
  }

}
