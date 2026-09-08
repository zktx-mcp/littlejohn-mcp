import { constants } from "node:fs";
import { randomBytes } from "node:crypto";
import { link, lstat, open, opendir, unlink } from "node:fs/promises";
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
  operationIdByteLength,
  operationIdSchema,
  parseEvmAccountIdentity,
  parseEvmChainId,
  parseEvmContractIdentity,
  parseHash32,
  parseCapabilityDataAt,
  parseUtcTimestamp,
  sha256Bytes,
  tokenDisplayTextLimits,
  walletConnectionCapability,
  walletConnectionStatusDefinitions,
  type CanonicalJson,
  type EvmAccountIdentity,
  type EvmChainId,
  type UtcTimestamp,
  type WalletConnectionData,
} from "../core/index.js";
import {
  parsePresentationContractIdentity,
  presentationSnapshotIdentity,
  presentationSnapshotIdPattern,
  presentationSnapshotLimits,
  presentationSnapshotMetadataLimits,
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
  officialAssetSourceDefinition,
  stockFactoryVerificationSchema,
  type CommittedOfficialAssetSnapshot,
  type OfficialAssetSnapshotStore,
  type OfficialAssetSourceMember,
} from "../registry/index.js";
import {
  createTokenAdditionReviewProjection,
  parseTokenCatalogOperation,
  tokenCatalogContractLimits,
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
import {
  tokenCatalogInitiators,
  tokenCatalogOperationKinds,
} from "../token-catalog/state.js";
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
  walletInitiators,
  walletOperationKinds,
  walletOperationStates,
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
  runtimeConfigurationMacByteLength,
  runtimeIdentifierByteLength,
  type OwnerInstanceId,
  type ProfileId,
  type RuntimeConfigurationMac,
  type RuntimeRevision,
} from "./runtime-identity.js";
import { internalCanonicalJsonResponseLimitBytes } from "./http-limits.js";
import {
  createRuntimeStateResetRequiredError,
  currentSqliteSchemaSql,
  getRuntimeStateResetRequiredError,
  hasExactCurrentSqliteStructure,
  persistedOperationJsonLimits,
  tokenInspectionPersistenceLimits,
} from "./sqlite-schema.js";
import {
  assertWalletConnectionStorageSize,
  walletConnectionStorageLimits,
  decodeWalletConnectionStorage,
  encodeWalletConnectionStorage,
  type WalletConnectionStorageRow,
} from "./wallet-connection-storage.js";
import type {
  WalletConnectionRecord,
  WalletProjectionStore,
} from "./wallet-projection.js";

const sqliteOperationalLimits = Object.freeze({
  busyTimeoutMilliseconds: 5_000,
  artifactSetAttempts: 8,
});

const runtimeOwnerRevisionBytes = internalCanonicalJsonResponseLimitBytes;
type SqliteRow = Readonly<Record<string, unknown>>;
interface SqliteScalar<Value> {
  projection(qualifier?: string): string;
  read(row: SqliteRow): Value;
}

const decodeStoredUtf8 = (bytes: Buffer): string =>
  new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);

const sqlColumnReference = (column: string, qualifier: string): string => {
  if (!/^[a-z][a-z0-9_]*$/u.test(column) ||
    (qualifier !== "" && !/^[a-z][a-z0-9_]*$/u.test(qualifier))) {
    throw new TypeError("SQLite column reference is invalid.");
  }
  return qualifier === "" ? column : `${qualifier}.${column}`;
};

const boundedSqlBytes = (
  column: string,
  alias: string,
  storageClass: "text" | "blob",
  maximumBytes: number,
  nullable: boolean,
): SqliteScalar<Buffer | null> => {
  if (!/^[a-z][a-zA-Z0-9]*$/u.test(alias) ||
    !Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new TypeError("SQLite byte projection is invalid.");
  }
  return Object.freeze({
    projection(qualifier = ""): string {
      const reference = sqlColumnReference(column, qualifier);
      return `typeof(${reference}) AS ${alias}StorageClass, ` +
        `octet_length(${reference}) AS ${alias}ByteLength, ` +
        `CASE WHEN typeof(${reference}) = '${storageClass}' AND ` +
        `octet_length(${reference}) <= ${maximumBytes} ` +
        `THEN CAST(${reference} AS BLOB) END AS ${alias}`;
    },
    read(row: SqliteRow): Buffer | null {
      const kind = row[`${alias}StorageClass`];
      const length = row[`${alias}ByteLength`];
      const value = row[alias];
      if (nullable && kind === "null" && length === null && value === null) return null;
      if (kind !== storageClass || !Number.isSafeInteger(length) ||
        (length as number) < 0 || (length as number) > maximumBytes ||
        !Buffer.isBuffer(value) || value.length !== length) {
        throw new TypeError("Stored SQLite scalar is invalid.");
      }
      return value;
    },
  });
};

function boundedSqlText(column: string, alias: string, maximumBytes: number): SqliteScalar<string>;
function boundedSqlText(
  column: string, alias: string, maximumBytes: number, nullable: true,
): SqliteScalar<string | null>;
function boundedSqlText(
  column: string, alias: string, maximumBytes: number, nullable = false,
): SqliteScalar<string | null> {
  const bytes = boundedSqlBytes(column, alias, "text", maximumBytes, nullable);
  return Object.freeze({
    projection: bytes.projection,
    read(row: SqliteRow): string | null {
      const value = bytes.read(row);
      return value === null ? null : decodeStoredUtf8(value);
    },
  });
}

const boundedSqlBlob = (column: string, alias: string, maximumBytes: number): SqliteScalar<Buffer> => {
  const bytes = boundedSqlBytes(column, alias, "blob", maximumBytes, false);
  return Object.freeze({
    projection: bytes.projection,
    read(row: SqliteRow): Buffer {
      const value = bytes.read(row);
      if (value === null) throw new TypeError("Stored SQLite BLOB is invalid.");
      return value;
    },
  });
};

const sqlInteger = (column: string, alias: string): SqliteScalar<number> => Object.freeze({
  projection(qualifier = ""): string {
    const reference = sqlColumnReference(column, qualifier);
    return `typeof(${reference}) AS ${alias}StorageClass, ` +
      `CASE WHEN typeof(${reference}) = 'integer' THEN ${reference} END AS ${alias}`;
  },
  read(row: SqliteRow): number {
    if (row[`${alias}StorageClass`] !== "integer" || !Number.isSafeInteger(row[alias])) {
      throw new TypeError("Stored SQLite integer is invalid.");
    }
    return row[alias] as number;
  },
});

const storedBoolean = (value: number): boolean => {
  if (value !== 0 && value !== 1) throw new TypeError("Stored SQLite boolean is invalid.");
  return value === 1;
};

const maximumUtf8Bytes = (values: readonly string[]): number =>
  Math.max(...values.map((value) => Buffer.byteLength(value, "utf8")));

const storedChainIdBytes = 39;
const storedAddressBytes = 42;
const storedTimestampBytes = 24;

const singletonField = sqlInteger("singleton", "singleton");
const processIdField = sqlInteger("process_id", "processId");
const includedField = sqlInteger("included", "included");
const defaultsInitializedField = sqlInteger("defaults_initialized", "defaultsInitialized");
const profileIdField = boundedSqlText("profile_id", "profileId", Math.ceil(runtimeIdentifierByteLength * 4 / 3));
const ownerInstanceIdField = boundedSqlText("owner_instance_id", "ownerInstanceId", Math.ceil(runtimeIdentifierByteLength * 4 / 3));
const configurationMacField = boundedSqlText("configuration_mac", "configurationMac", Math.ceil(runtimeConfigurationMacByteLength * 4 / 3));
const ownerRevisionField = boundedSqlText("owner_revision", "ownerRevision", runtimeOwnerRevisionBytes);
const chainIdField = boundedSqlText("chain_id", "chainId", storedChainIdBytes);
const contractAddressField = boundedSqlText("contract_address", "contractAddress", storedAddressBytes);
const accountAddressField = boundedSqlText("account_address", "accountAddress", storedAddressBytes);
const tokenAddressField = boundedSqlText("token_address", "tokenAddress", storedAddressBytes);
const createdAtField = boundedSqlText("created_at", "createdAt", storedTimestampBytes);
const updatedAtField = boundedSqlText("updated_at", "updatedAt", storedTimestampBytes);
const acquiredAtField = boundedSqlText("acquired_at", "acquiredAt", storedTimestampBytes);
const actionExpiresAtField = boundedSqlText("action_expires_at", "actionExpiresAt", storedTimestampBytes);
const inspectionDigestField = boundedSqlText("inspection_digest", "inspectionDigest", 66);
const selectionInspectionDigestField = boundedSqlText("inspection_digest", "inspectionDigest", 66, true);
const selectionRevisionField = boundedSqlText("revision", "revision", Math.ceil(tokenCatalogContractLimits.selectionRevisionBytes * 4 / 3));
const sourceRevisionField = boundedSqlText("revision", "revision", Math.ceil(officialAssetSnapshotRevisionByteLength * 4 / 3));
const operationIdField = boundedSqlText("operation_id", "operationId", Math.ceil(operationIdByteLength * 4 / 3));
const reviewDigestField = boundedSqlText("review_digest", "reviewDigest", 66);
const walletKindField = boundedSqlText("kind", "kind", maximumUtf8Bytes(walletOperationKinds));
const walletInitiatedByField = boundedSqlText("initiated_by", "initiatedBy", maximumUtf8Bytes(walletInitiators));
const walletStateField = boundedSqlText("state", "state", maximumUtf8Bytes(walletOperationStates));
const connectionRevisionField = boundedSqlText("connection_revision", "connectionRevision", persistedOperationJsonLimits.walletBytes);
const walletOperationJsonField = boundedSqlBlob("operation_json", "operationJson", persistedOperationJsonLimits.walletBytes);
const tokenKindField = boundedSqlText("kind", "kind", maximumUtf8Bytes(tokenCatalogOperationKinds));
const tokenInitiatedByField = boundedSqlText("initiated_by", "initiatedBy", maximumUtf8Bytes(tokenCatalogInitiators));
const tokenOperationJsonField = boundedSqlBlob("operation_json", "operationJson", persistedOperationJsonLimits.tokenSelectionBytes);
const inspectionResultField = boundedSqlBlob("result_bytes", "resultBytes", tokenInspectionPersistenceLimits.resultBytes);
const sourceUriField = boundedSqlText("source_uri", "sourceUri", Buffer.byteLength(officialAssetSourceDefinition.sourceUri, "utf8"));
const sourceObservedAtField = boundedSqlText("source_observed_at", "sourceObservedAt", storedTimestampBytes);
const rawResponseDigestField = boundedSqlText("raw_response_digest", "rawResponseDigest", 66);
const memberSetDigestField = boundedSqlText("member_set_digest", "memberSetDigest", 66);
const candidateListDigestField = boundedSqlText("candidate_list_digest", "candidateListDigest", 66);
const assetUidField = boundedSqlText("asset_uid", "assetUid", 66);
const sourceNameField = boundedSqlText("source_name", "sourceName", tokenDisplayTextLimits.utf8Bytes, true);
const sourceSymbolField = boundedSqlText("source_symbol", "sourceSymbol", tokenDisplayTextLimits.utf8Bytes, true);
const snapshotIdField = boundedSqlText("snapshot_id", "snapshotId", 71);
const contractIdField = boundedSqlText("contract_id", "contractId", presentationSnapshotMetadataLimits.contractIdentityBytes);
const contractVersionField = boundedSqlText("contract_version", "contractVersion", presentationSnapshotMetadataLimits.contractIdentityBytes);
const inputDigestField = boundedSqlText("input_digest", "inputDigest", 64);
const resultDigestField = boundedSqlText("result_digest", "resultDigest", 64);
const resultChunkDigestsField = boundedSqlText("result_chunk_digests_json", "resultChunkDigestsJson", presentationSnapshotMetadataLimits.resultChunkDigestsBytes);
const snapshotInputField = boundedSqlBlob("input_bytes", "inputBytes", presentationSnapshotLimits.inputBytes);
const snapshotResultField = boundedSqlBlob("result_bytes", "resultBytes", presentationSnapshotLimits.resultBytes);

const walletConnectionFields = Object.freeze({
  singleton: singletonField,
  profileId: profileIdField,
  revision: boundedSqlText("revision", "revision", walletConnectionStorageLimits.revision),
  revalidationRequired: sqlInteger("revalidation_required", "revalidationRequired"),
  status: boundedSqlText("status", "status", maximumUtf8Bytes(Object.keys(walletConnectionStatusDefinitions))),
  reason: boundedSqlText("reason", "reason", maximumUtf8Bytes(
    Object.values(walletConnectionStatusDefinitions).flatMap((definition) => [...definition.reasons]),
  ), true),
  chainId: boundedSqlText("chain_id", "chainId", storedChainIdBytes, true),
  walletAddress: boundedSqlText("wallet_address", "walletAddress", storedAddressBytes, true),
  approvedMethodsJson: boundedSqlText("approved_methods_json", "approvedMethodsJson", walletConnectionStorageLimits.approvedMethodsJson, true),
  approvedEventsJson: boundedSqlText("approved_events_json", "approvedEventsJson", walletConnectionStorageLimits.approvedEventsJson, true),
  expiresAt: boundedSqlText("expires_at", "expiresAt", storedTimestampBytes, true),
  sessionCount: boundedSqlText("session_count", "sessionCount", walletConnectionStorageLimits.sessionCount, true),
  updatedAt: updatedAtField,
});

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
  readonly accountAddress: string;
  readonly tokenAddress: string;
  readonly operationJson: Buffer;
}
interface TokenInspectionRow {
  readonly chainId: string;
  readonly contractAddress: string;
  readonly inspectionDigest: string;
  readonly resultBytes: Buffer;
}
interface TokenInspectionSizeRow {
  readonly storageClass: unknown;
  readonly byteLength: unknown;
}
export interface TokenInspectionRetentionEntry {
  readonly chainId: string;
  readonly contractAddress: string;
  readonly inspectionDigest: string;
  readonly byteLength: number;
}
interface TokenSelectionRecordRow {
  readonly profileId: string;
  readonly chainId: string;
  readonly accountAddress: string;
  readonly tokenAddress: string;
  readonly inspectionDigest: string | null;
  readonly included: number;
  readonly revision: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
interface TokenSelectionStateRow {
  readonly profileId: string;
  readonly chainId: string;
  readonly accountAddress: string;
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
export interface AccountStorageRow {
  readonly profileId: string;
  readonly chainId: string;
  readonly accountAddress: string;
}

export interface AccountRecordKey {
  readonly profileId: ProfileId;
  readonly account: EvmAccountIdentity;
}

export const decodeAccountRecordKey = (row: AccountStorageRow): AccountRecordKey =>
  Object.freeze({
    profileId: parseProfileId(row.profileId),
    account: parseEvmAccountIdentity({ chainId: row.chainId, address: row.accountAddress }),
  });

const accountSelect = `SELECT ${profileIdField.projection()}, ${chainIdField.projection()},
  ${accountAddressField.projection()} FROM account`;

const decodeStoredAccountRecordKey = (row: SqliteRow): AccountRecordKey => decodeAccountRecordKey({
  profileId: profileIdField.read(row),
  chainId: chainIdField.read(row),
  accountAddress: accountAddressField.read(row),
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

const decodeInspectionRow = (raw: SqliteRow): TokenInspectionSuccess => {
  const row: TokenInspectionRow = {
    chainId: chainIdField.read(raw),
    contractAddress: contractAddressField.read(raw),
    inspectionDigest: inspectionDigestField.read(raw),
    resultBytes: inspectionResultField.read(raw),
  };
  const identity = parseEvmContractIdentity({
    chainId: row.chainId,
    contractAddress: row.contractAddress,
  });
  if (!Buffer.isBuffer(row.resultBytes)) {
    throw new Error("Stored token inspection bytes are invalid.");
  }
  const text = decodeStoredUtf8(row.resultBytes);
  const parsedJson = JSON.parse(text) as unknown;
  const inspection = tokenInspectionSuccessSchema.parse(parsedJson);
  if (
    canonicalJsonStringify(inspection as unknown as CanonicalJson) !== text ||
    inspection.data.asset.chainId !== identity.chainId ||
    inspection.data.asset.address !== identity.contractAddress ||
    tokenInspectionDigest(inspection) !== row.inspectionDigest
  ) throw new Error("Stored token inspection is invalid.");
  return inspection;
};

const tokenInspectionRetentionIdentity = (
  entry: Pick<TokenInspectionRetentionEntry, "chainId" | "contractAddress" | "inspectionDigest">,
): string => `${entry.chainId}\0${entry.contractAddress}\0${entry.inspectionDigest}`;

const admitTokenInspectionRetentionEntry = (
  entry: TokenInspectionRetentionEntry,
): TokenInspectionRetentionEntry => {
  const identity = parseEvmContractIdentity({
    chainId: entry.chainId,
    contractAddress: entry.contractAddress,
  });
  const inspectionDigest = parseHash32(entry.inspectionDigest);
  if (
    !Number.isSafeInteger(entry.byteLength) ||
    entry.byteLength < 2 ||
    entry.byteLength > tokenInspectionPersistenceLimits.resultBytes
  ) throw new TypeError("Token inspection retention row is invalid.");
  return Object.freeze({
    chainId: identity.chainId,
    contractAddress: identity.contractAddress,
    inspectionDigest,
    byteLength: entry.byteLength,
  });
};

const compareTokenInspectionRetentionEntries = (
  left: TokenInspectionRetentionEntry,
  right: TokenInspectionRetentionEntry,
): number => compareCodePointSequences(left.chainId, right.chainId) ||
  compareCodePointSequences(left.contractAddress, right.contractAddress) ||
  compareCodePointSequences(left.inspectionDigest, right.inspectionDigest);

export const selectTokenInspectionRetentionVictims = (
  entriesInput: readonly TokenInspectionRetentionEntry[],
  candidateInput: TokenInspectionRetentionEntry,
): readonly TokenInspectionRetentionEntry[] => {
  const entries = entriesInput.map(admitTokenInspectionRetentionEntry);
  const candidate = admitTokenInspectionRetentionEntry(candidateInput);
  if (entries.length > tokenInspectionPersistenceLimits.rows) {
    throw new TypeError("Token inspection retention row count is invalid.");
  }
  const identities = new Set<string>();
  let aggregateResultBytes = 0;
  for (const entry of entries) {
    const identity = tokenInspectionRetentionIdentity(entry);
    if (identities.has(identity)) {
      throw new TypeError("Token inspection retention identity is duplicated.");
    }
    identities.add(identity);
    aggregateResultBytes += entry.byteLength;
    if (
      !Number.isSafeInteger(aggregateResultBytes) ||
      aggregateResultBytes > tokenInspectionPersistenceLimits.aggregateResultBytes
    ) throw new TypeError("Token inspection retention bytes are invalid.");
  }
  const candidateIdentity = tokenInspectionRetentionIdentity(candidate);
  if (identities.has(candidateIdentity)) {
    const existing = entries.find((entry) =>
      tokenInspectionRetentionIdentity(entry) === candidateIdentity);
    if (existing?.byteLength !== candidate.byteLength) {
      throw new TypeError("Token inspection retention identity is inconsistent.");
    }
    return Object.freeze([]);
  }
  let retainedRows = entries.length + 1;
  let retainedResultBytes = aggregateResultBytes + candidate.byteLength;
  const victims: TokenInspectionRetentionEntry[] = [];
  for (const entry of [...entries].sort(compareTokenInspectionRetentionEntries)) {
    if (
      retainedRows <= tokenInspectionPersistenceLimits.rows &&
      retainedResultBytes <= tokenInspectionPersistenceLimits.aggregateResultBytes
    ) break;
    victims.push(entry);
    retainedRows -= 1;
    retainedResultBytes -= entry.byteLength;
  }
  if (
    retainedRows > tokenInspectionPersistenceLimits.rows ||
    retainedResultBytes > tokenInspectionPersistenceLimits.aggregateResultBytes
  ) throw new TypeError("Token inspection retention cannot admit the candidate.");
  return Object.freeze(victims);
};

interface TokenInspectionCapacity {
  readonly rowCount: number;
  readonly aggregateResultBytes: number;
}

const preflightTokenInspectionRows = (
  database: Database.Database,
): TokenInspectionCapacity => {
  const count = database.prepare("SELECT count(*) AS rowCount FROM token_contract_inspection")
    .get() as { readonly rowCount: unknown };
  if (
    !Number.isSafeInteger(count.rowCount) ||
    (count.rowCount as number) < 0 ||
    (count.rowCount as number) > tokenInspectionPersistenceLimits.rows
  ) throw new Error("Stored token inspection row count is invalid.");
  const sizes = database.prepare(`SELECT typeof(result_bytes) AS storageClass,
    octet_length(result_bytes) AS byteLength FROM token_contract_inspection
    LIMIT ?`).iterate(
      tokenInspectionPersistenceLimits.rows + 1,
    ) as IterableIterator<TokenInspectionSizeRow>;
  let rowCount = 0;
  let aggregateResultBytes = 0;
  for (const row of sizes) {
    rowCount += 1;
    if (
      rowCount > tokenInspectionPersistenceLimits.rows ||
      row.storageClass !== "blob" ||
      !Number.isSafeInteger(row.byteLength) ||
      (row.byteLength as number) < 2 ||
      (row.byteLength as number) > tokenInspectionPersistenceLimits.resultBytes
    ) throw new Error("Stored token inspection row size is invalid.");
    aggregateResultBytes += row.byteLength as number;
    if (
      !Number.isSafeInteger(aggregateResultBytes) ||
      aggregateResultBytes > tokenInspectionPersistenceLimits.aggregateResultBytes
    ) throw new Error("Stored token inspection aggregate size is invalid.");
  }
  if (rowCount !== count.rowCount) {
    throw new Error("Stored token inspection row count changed during admission.");
  }
  return Object.freeze({ rowCount, aggregateResultBytes });
};

const readTokenInspectionRetentionEntries = (
  database: Database.Database,
): readonly TokenInspectionRetentionEntry[] => {
  const rows = database.prepare(`SELECT ${chainIdField.projection()},
    ${contractAddressField.projection()}, ${inspectionDigestField.projection()},
    typeof(result_bytes) AS storageClass, octet_length(result_bytes) AS byteLength
    FROM token_contract_inspection LIMIT ?`).all(
      tokenInspectionPersistenceLimits.rows + 1,
    ) as SqliteRow[];
  if (rows.length > tokenInspectionPersistenceLimits.rows) {
    throw new Error("Stored token inspection row count is invalid.");
  }
  return Object.freeze(rows.map((row) => {
    if (row["storageClass"] !== "blob") {
      throw new Error("Stored token inspection row size is invalid.");
    }
    return admitTokenInspectionRetentionEntry({
      chainId: chainIdField.read(row),
      contractAddress: contractAddressField.read(row),
      inspectionDigest: inspectionDigestField.read(row),
      byteLength: row["byteLength"] as number,
    });
  }));
};

const walletOperationSelect = `SELECT ${profileIdField.projection()},
  ${operationIdField.projection()},
  ${walletKindField.projection()},
  ${walletInitiatedByField.projection()},
  ${reviewDigestField.projection()},
  ${connectionRevisionField.projection()},
  ${walletStateField.projection()},
  ${createdAtField.projection()},
  ${actionExpiresAtField.projection()},
  ${walletOperationJsonField.projection()}
  FROM wallet_operation`;

const tokenSelectionOperationSelect = `SELECT ${profileIdField.projection()},
  ${operationIdField.projection()},
  ${tokenKindField.projection()},
  ${tokenInitiatedByField.projection()},
  ${reviewDigestField.projection()},
  ${chainIdField.projection()},
  ${accountAddressField.projection()},
  ${tokenAddressField.projection()},
  ${tokenOperationJsonField.projection()}
  FROM token_selection_operation`;

const decodeWalletOperationRow = (
  raw: SqliteRow,
  expectedProfileId?: ProfileId,
): WalletManagementOperation => {
  const row: WalletOperationRow = {
    profileId: profileIdField.read(raw),
    operationId: operationIdField.read(raw),
    kind: walletKindField.read(raw),
    initiatedBy: walletInitiatedByField.read(raw),
    reviewDigest: reviewDigestField.read(raw),
    connectionRevision: connectionRevisionField.read(raw),
    state: walletStateField.read(raw),
    createdAt: createdAtField.read(raw),
    actionExpiresAt: actionExpiresAtField.read(raw),
    operationJson: walletOperationJsonField.read(raw),
  };
  const profileId = parseProfileId(row.profileId);
  if (expectedProfileId !== undefined && profileId !== expectedProfileId) {
    throw new Error("Stored wallet operation profile is invalid.");
  }
  if (!Buffer.isBuffer(row.operationJson)) {
    throw new Error("Stored wallet operation bytes are invalid.");
  }
  const text = decodeStoredUtf8(row.operationJson);
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
  raw: SqliteRow,
  expectedProfileId?: ProfileId,
): TokenCatalogOperation => {
  const row: TokenSelectionOperationRow = {
    profileId: profileIdField.read(raw),
    operationId: operationIdField.read(raw),
    kind: tokenKindField.read(raw),
    initiatedBy: tokenInitiatedByField.read(raw),
    reviewDigest: reviewDigestField.read(raw),
    chainId: chainIdField.read(raw),
    accountAddress: accountAddressField.read(raw),
    tokenAddress: tokenAddressField.read(raw),
    operationJson: tokenOperationJsonField.read(raw),
  };
  const profileId = parseProfileId(row.profileId);
  if (expectedProfileId !== undefined && profileId !== expectedProfileId) {
    throw new Error("Stored token selection operation profile is invalid.");
  }
  if (!Buffer.isBuffer(row.operationJson)) {
    throw new Error("Stored token selection operation bytes are invalid.");
  }
  const text = decodeStoredUtf8(row.operationJson);
  const operation = parseTokenCatalogOperation(JSON.parse(text) as unknown);
  if (
    canonicalJsonStringify(operation as unknown as CanonicalJson) !== text ||
    operation.operationId !== row.operationId ||
    operation.kind !== row.kind ||
    operation.initiatedBy !== row.initiatedBy ||
    operation.review.reviewDigest !== row.reviewDigest ||
    operation.review.target.account.chainId !== row.chainId ||
    operation.review.target.account.address !== row.accountAddress ||
    operation.review.target.asset.address !== row.tokenAddress
  ) throw new Error("Stored token selection operation does not match its indexed identity.");
  return operation;
};

const readOperationRows = (database: Database.Database): void => {
  const walletRows = database.prepare(`${walletOperationSelect} ORDER BY operation_id`)
    .iterate() as IterableIterator<SqliteRow>;
  for (const row of walletRows) decodeWalletOperationRow(row);
  const tokenRows = database.prepare(`${tokenSelectionOperationSelect} ORDER BY operation_id`)
    .iterate() as IterableIterator<SqliteRow>;
  for (const row of tokenRows) decodeTokenSelectionOperationRow(row);
};


interface TokenSelectionStorageRecord {
  readonly selection: TokenSelection;
  readonly inspectionDigest: ReturnType<typeof parseHash32> | null;
}

const decodeTokenSelectionStorageRow = (
  raw: SqliteRow,
  expectedProfileId?: ProfileId,
): TokenSelectionStorageRecord => {
  const row: TokenSelectionRecordRow = {
    profileId: profileIdField.read(raw),
    chainId: chainIdField.read(raw),
    accountAddress: accountAddressField.read(raw),
    tokenAddress: tokenAddressField.read(raw),
    inspectionDigest: selectionInspectionDigestField.read(raw),
    included: includedField.read(raw),
    revision: selectionRevisionField.read(raw),
    createdAt: createdAtField.read(raw),
    updatedAt: updatedAtField.read(raw),
  };
  const profileId = parseProfileId(row.profileId);
  if (expectedProfileId !== undefined && profileId !== expectedProfileId) {
    throw new Error("Stored token selection profile is invalid.");
  }
  const account = parseEvmAccountIdentity({ chainId: row.chainId, address: row.accountAddress });
  const asset = erc20AssetIdentitySchema.parse({
    kind: "erc20",
    chainId: row.chainId,
    address: row.tokenAddress,
  });
  const selection = tokenSelectionSchema.parse({
    account,
    asset,
    included: storedBoolean(row.included),
    revision: tokenSelectionRevisionSchema.parse(row.revision),
    createdAt: parseUtcTimestamp(row.createdAt),
    updatedAt: parseUtcTimestamp(row.updatedAt),
  });
  const inspectionDigest = row.inspectionDigest === null
    ? null
    : parseHash32(row.inspectionDigest);
  return Object.freeze({ selection, inspectionDigest });
};

const decodeTokenSelectionRecordRow = (
  row: SqliteRow,
  expectedProfileId?: ProfileId,
): TokenSelection => decodeTokenSelectionStorageRow(row, expectedProfileId).selection;

const decodeTokenSelectionStateRow = (
  raw: SqliteRow,
  expectedProfileId?: ProfileId,
): TokenSelectionState => {
  const row: TokenSelectionStateRow = {
    profileId: profileIdField.read(raw),
    chainId: chainIdField.read(raw),
    accountAddress: accountAddressField.read(raw),
    revision: selectionRevisionField.read(raw),
    defaultsInitialized: defaultsInitializedField.read(raw),
    createdAt: createdAtField.read(raw),
    updatedAt: updatedAtField.read(raw),
  };
  const profileId = parseProfileId(row.profileId);
  if (expectedProfileId !== undefined && profileId !== expectedProfileId) {
    throw new Error("Stored token selection state profile is invalid.");
  }
  return tokenSelectionStateSchema.parse({
    account: parseEvmAccountIdentity({ chainId: row.chainId, address: row.accountAddress }),
    revision: tokenSelectionSetRevisionSchema.parse(row.revision),
    defaultsInitialized: storedBoolean(row.defaultsInitialized),
    createdAt: parseUtcTimestamp(row.createdAt),
    updatedAt: parseUtcTimestamp(row.updatedAt),
  });
};

const decodeOfficialAssetMemberRow = (raw: SqliteRow): OfficialAssetSourceMember => {
  parseEvmChainId(chainIdField.read(raw));
  const sourceName = sourceNameField.read(raw);
  const sourceSymbol = sourceSymbolField.read(raw);
  return assertOfficialAssetSourceMember({
    assetUid: assetUidField.read(raw) as never,
    contractAddress: contractAddressField.read(raw) as never,
    ...(sourceName === null ? {} : { sourceName }),
    ...(sourceSymbol === null ? {} : { sourceSymbol }),
  });
};

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

const sha256Pattern = /^[0-9a-f]{64}$/u;

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
  const text = decodeStoredUtf8(value);
  const admitted = captureCanonicalJson(JSON.parse(text) as unknown);
  if (canonicalJsonStringify(admitted) !== text) {
    throw new TypeError("Stored presentation JSON is not canonical.");
  }
  return admitted;
};

const snapshotSelect = `SELECT ${snapshotIdField.projection()},
  ${contractIdField.projection()},
  ${contractVersionField.projection()},
  ${snapshotInputField.projection()},
  ${inputDigestField.projection()},
  ${snapshotResultField.projection()},
  ${resultDigestField.projection()},
  ${resultChunkDigestsField.projection()}
  FROM presentation_snapshot`;

const decodePresentationSnapshotRow = (raw: SqliteRow): PresentationSnapshotRecord => {
  const row: PresentationSnapshotRow = {
    snapshotId: snapshotIdField.read(raw),
    contractId: contractIdField.read(raw),
    contractVersion: contractVersionField.read(raw),
    inputBytes: snapshotInputField.read(raw),
    inputDigest: inputDigestField.read(raw),
    resultBytes: snapshotResultField.read(raw),
    resultDigest: resultDigestField.read(raw),
    resultChunkDigestsJson: resultChunkDigestsField.read(raw),
  };
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
  if (snapshotId !== row.snapshotId || !presentationSnapshotIdPattern.test(row.snapshotId)) {
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
    Buffer.byteLength(identity.contractId, "utf8") > presentationSnapshotMetadataLimits.contractIdentityBytes ||
    Buffer.byteLength(identity.contractVersion, "utf8") > presentationSnapshotMetadataLimits.contractIdentityBytes ||
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
  database.pragma(`busy_timeout = ${sqliteOperationalLimits.busyTimeoutMilliseconds}`);
  if (database.pragma("busy_timeout", { simple: true }) !== sqliteOperationalLimits.busyTimeoutMilliseconds) throw new Error("SQLite busy timeout is unavailable.");
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

const profileFromRow = (raw: SqliteRow): LocalProfile => {
  const row: ProfileRow = {
    singleton: singletonField.read(raw),
    profileId: profileIdField.read(raw),
    createdAt: createdAtField.read(raw),
  };
  if (row.singleton !== 1) throw new Error("Local profile singleton is invalid.");
  return Object.freeze({
    profileId: parseProfileId(row.profileId),
    createdAt: parseUtcTimestamp(row.createdAt),
  });
};

const ownerFromRow = (raw: SqliteRow, profile: LocalProfile): RuntimeOwnerRecord => {
  const row: OwnerRow = {
    singleton: singletonField.read(raw),
    profileId: profileIdField.read(raw),
    ownerInstanceId: ownerInstanceIdField.read(raw),
    configurationMac: configurationMacField.read(raw),
    processId: processIdField.read(raw),
    ownerRevision: ownerRevisionField.read(raw),
    acquiredAt: acquiredAtField.read(raw),
  };
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
  const rows = database.prepare(`SELECT ${singletonField.projection()}, ${profileIdField.projection()}, ${createdAtField.projection()}
    FROM local_profile ORDER BY singleton LIMIT 2`).all() as SqliteRow[];
  if (rows.length !== 1 || rows[0] === undefined) throw new Error("Local profile is unavailable.");
  return profileFromRow(rows[0]);
};

const readOwnerRaw = (database: Database.Database): RuntimeOwnerRecord | undefined => {
  const rows = database.prepare(`SELECT ${singletonField.projection()}, ${profileIdField.projection()},
    ${ownerInstanceIdField.projection()}, ${configurationMacField.projection()},
    ${processIdField.projection()}, ${ownerRevisionField.projection()}, ${acquiredAtField.projection()}
    FROM runtime_owner ORDER BY singleton LIMIT 2`).all() as SqliteRow[];
  if (rows.length > 1) throw new Error("Runtime owner projection is invalid.");
  return rows[0] === undefined ? undefined : ownerFromRow(rows[0], readProfileRaw(database));
};

const readWalletRaw = (database: Database.Database): WalletConnectionRecord => {
  const rows = database.prepare(`SELECT ${Object.values(walletConnectionFields)
    .map((field) => field.projection()).join(", ")}
    FROM current_wallet_connection ORDER BY singleton LIMIT 2`).all() as SqliteRow[];
  if (rows.length !== 1 || rows[0] === undefined) throw new Error("Wallet connection projection is unavailable.");
  const raw = rows[0];
  const fields = walletConnectionFields;
  const row: WalletRow = {
    singleton: fields.singleton.read(raw), profileId: fields.profileId.read(raw),
    revision: fields.revision.read(raw), revalidationRequired: fields.revalidationRequired.read(raw),
    status: fields.status.read(raw), reason: fields.reason.read(raw),
    chainId: fields.chainId.read(raw), walletAddress: fields.walletAddress.read(raw),
    approvedMethodsJson: fields.approvedMethodsJson.read(raw),
    approvedEventsJson: fields.approvedEventsJson.read(raw), expiresAt: fields.expiresAt.read(raw),
    sessionCount: fields.sessionCount.read(raw), updatedAt: fields.updatedAt.read(raw),
  };
  return walletFromRow(row, readProfileRaw(database));
};

const readChainRows = (database: Database.Database): void => {
  const rows = database.prepare(`SELECT ${chainIdField.projection()} FROM chain ORDER BY chain_id`)
    .iterate() as IterableIterator<SqliteRow>;
  for (const row of rows) parseEvmChainId(chainIdField.read(row));
};

const readContractRows = (database: Database.Database, table: "contract" | "token_contract"): void => {
  const rows = database.prepare(`SELECT ${chainIdField.projection()}, ${contractAddressField.projection()}
    FROM ${table} ORDER BY chain_id, contract_address`).iterate() as IterableIterator<SqliteRow>;
  for (const row of rows) {
    parseEvmContractIdentity({ chainId: chainIdField.read(row), contractAddress: contractAddressField.read(row) });
  }
};

const readAccountRows = (database: Database.Database): void => {
  const rows = database.prepare(`${accountSelect} ORDER BY profile_id, chain_id, account_address`)
    .iterate() as IterableIterator<SqliteRow>;
  for (const row of rows) decodeStoredAccountRecordKey(row);
};

const tokenSelectionRecordSelect = `SELECT ${profileIdField.projection("r")},
  ${chainIdField.projection("r")},
  ${accountAddressField.projection("r")},
  ${tokenAddressField.projection("r")},
  ${selectionInspectionDigestField.projection("r")},
  ${includedField.projection("r")},
  ${selectionRevisionField.projection("r")},
  ${createdAtField.projection("r")},
  ${updatedAtField.projection("r")}
  FROM account_token_selection AS r`;

const tokenSelectionStateSelect = `SELECT ${profileIdField.projection()},
  ${chainIdField.projection()},
  ${accountAddressField.projection()},
  ${selectionRevisionField.projection()},
  ${defaultsInitializedField.projection()},
  ${createdAtField.projection()},
  ${updatedAtField.projection()}
  FROM account_token_selection_state`;

const tokenInspectionSelect = `SELECT ${chainIdField.projection()},
  ${contractAddressField.projection()},
  ${inspectionDigestField.projection()},
  ${inspectionResultField.projection()}
  FROM token_contract_inspection`;

const readOfficialAssetSnapshotRaw = (
  database: Database.Database,
): CommittedOfficialAssetSnapshot | undefined => database.transaction(() => {
  const rows = database.prepare(`SELECT ${chainIdField.projection()},
    ${sourceUriField.projection()}, ${sourceObservedAtField.projection()},
    ${rawResponseDigestField.projection()}, ${memberSetDigestField.projection()},
    ${candidateListDigestField.projection()}, ${sourceRevisionField.projection()},
    ${updatedAtField.projection()} FROM robinhood_asset_snapshot ORDER BY chain_id LIMIT 2`)
    .all() as SqliteRow[];
  if (rows.length > 1) throw new Error("Official asset snapshot identity is not unique.");
  const raw = rows[0];
  if (raw === undefined) return undefined;
  const row: OfficialAssetSnapshotRow = {
    chainId: chainIdField.read(raw),
    sourceUri: sourceUriField.read(raw),
    sourceObservedAt: sourceObservedAtField.read(raw),
    rawResponseDigest: rawResponseDigestField.read(raw),
    memberSetDigest: memberSetDigestField.read(raw),
    candidateListDigest: candidateListDigestField.read(raw),
    revision: sourceRevisionField.read(raw),
    updatedAt: updatedAtField.read(raw),
  };
  const members = database.prepare(`SELECT ${chainIdField.projection()},
    ${contractAddressField.projection()}, ${assetUidField.projection()},
    ${sourceNameField.projection()}, ${sourceSymbolField.projection()} FROM robinhood_asset
    WHERE chain_id = ? ORDER BY asset_uid, contract_address LIMIT ?`)
    .all(row.chainId, officialAssetSourceDefinition.memberLimit + 1) as SqliteRow[];
  if (members.length > officialAssetSourceDefinition.memberLimit) {
    throw new Error("Stored official asset member count is invalid.");
  }
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
}).deferred();

const readTokenInspectionRows = (database: Database.Database): void => {
  const capacity = preflightTokenInspectionRows(database);
  const inspections = database.prepare(`${tokenInspectionSelect}
    ORDER BY chain_id, contract_address, inspection_digest LIMIT ?`).iterate(
      tokenInspectionPersistenceLimits.rows + 1,
    ) as IterableIterator<SqliteRow>;
  let rowCount = 0;
  let aggregateResultBytes = 0;
  for (const row of inspections) {
    rowCount += 1;
    aggregateResultBytes += inspectionResultField.read(row).length;
    if (
      rowCount > capacity.rowCount ||
      !Number.isSafeInteger(aggregateResultBytes) ||
      aggregateResultBytes > capacity.aggregateResultBytes
    ) throw new Error("Stored token inspection capacity changed during admission.");
    decodeInspectionRow(row);
  }
  if (rowCount !== capacity.rowCount || aggregateResultBytes !== capacity.aggregateResultBytes) {
    throw new Error("Stored token inspection capacity changed during admission.");
  }
};

const readTokenCatalogRows = (database: Database.Database): void => {
  database.transaction(() => readTokenInspectionRows(database)).deferred();
  const selections = database.prepare(`${tokenSelectionRecordSelect}
    ORDER BY r.profile_id, r.chain_id, r.account_address, r.token_address`)
    .iterate() as IterableIterator<SqliteRow>;
  for (const row of selections) decodeTokenSelectionStorageRow(row);
  const selectionStates = database.prepare(`${tokenSelectionStateSelect}
    ORDER BY profile_id, chain_id, account_address`)
    .iterate() as IterableIterator<SqliteRow>;
  for (const row of selectionStates) decodeTokenSelectionStateRow(row);
  readOfficialAssetSnapshotRaw(database);
};

const readPresentationCapacity = (database: Database.Database): Readonly<{
  rowCount: number;
  aggregateBytes: number;
}> | undefined => {
  const capacity = database.prepare(`SELECT count(*) AS rowCount,
    coalesce(sum(octet_length(input_bytes) + octet_length(result_bytes)), 0) AS aggregateBytes
    FROM presentation_snapshot`).get() as SqliteRow;
  if (
    !Number.isSafeInteger(capacity["rowCount"]) || (capacity["rowCount"] as number) < 0 ||
    !Number.isSafeInteger(capacity["aggregateBytes"]) || (capacity["aggregateBytes"] as number) < 0
  ) return undefined;
  return Object.freeze({
    rowCount: capacity["rowCount"] as number,
    aggregateBytes: capacity["aggregateBytes"] as number,
  });
};

const validateDatabaseState = (database: Database.Database): void => {
  readProfileRaw(database);
  readOwnerRaw(database);
  const snapshotCapacity = readPresentationCapacity(database);
  if (
    snapshotCapacity === undefined ||
    snapshotCapacity.rowCount > presentationSnapshotLimits.rows ||
    snapshotCapacity.aggregateBytes > presentationSnapshotLimits.aggregateBytes
  ) throw new Error("Stored presentation snapshot capacity is invalid.");
  readChainRows(database);
  readContractRows(database, "contract");
  readContractRows(database, "token_contract");
  readAccountRows(database);
  readTokenCatalogRows(database);
  readOperationRows(database);
  readWalletRaw(database);
  if (database.prepare("PRAGMA foreign_key_check").get() !== undefined) {
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
  for await (const entry of await opendir(directory)) {
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
  for (let attempt = 0; attempt < sqliteOperationalLimits.artifactSetAttempts; attempt += 1) {
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
      database = new Database(path, { readonly: true, fileMustExist: true, timeout: sqliteOperationalLimits.busyTimeoutMilliseconds });
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
    database = new Database(path, { fileMustExist: true, timeout: sqliteOperationalLimits.busyTimeoutMilliseconds });
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
    database = new Database(pending, { fileMustExist: true, timeout: sqliteOperationalLimits.busyTimeoutMilliseconds });
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
      isAccountRetained: (account) => this.isAccountRetained(account),
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
          .all(candidate.value.snapshotId) as SqliteRow[];
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
        const capacity = readPresentationCapacity(this.#database);
        if (capacity === undefined) return presentationUnavailable("snapshot_inconsistent");
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
    if (!presentationSnapshotIdPattern.test(snapshotId)) return presentationUnavailable("snapshot_inconsistent");
    try {
      return this.#readWithIdentity(() => {
        const rows = this.#database.prepare(`${snapshotSelect} WHERE snapshot_id = ?`)
          .all(snapshotId) as SqliteRow[];
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
      !presentationSnapshotIdPattern.test(input.snapshotId) ||
      !Number.isSafeInteger(input.index) || input.index < 0
    ) return presentationUnavailable("snapshot_inconsistent");
    try {
      return this.#readWithIdentity(() => {
        const offset = input.index * presentationSnapshotLimits.resultChunkBytes;
        if (!Number.isSafeInteger(offset)) return presentationUnavailable("snapshot_inconsistent");
        const rows = this.#database.prepare(`SELECT ${snapshotIdField.projection()},
          ${contractIdField.projection()}, ${contractVersionField.projection()},
          typeof(input_bytes) AS inputStorageClass, octet_length(input_bytes) AS inputBytes,
          ${inputDigestField.projection()},
          typeof(result_bytes) AS resultStorageClass, octet_length(result_bytes) AS resultBytes,
          ${resultDigestField.projection()}, ${resultChunkDigestsField.projection()},
          CASE WHEN typeof(result_bytes) = 'blob' AND
            octet_length(result_bytes) BETWEEN 1 AND ${presentationSnapshotLimits.resultBytes}
            THEN substr(result_bytes, ?, ?) END AS chunkBytes
          FROM presentation_snapshot WHERE snapshot_id = ?`).all(
            offset + 1,
            presentationSnapshotLimits.resultChunkBytes,
            input.snapshotId,
          ) as SqliteRow[];
        if (rows.length === 0) return presentationUnavailable("snapshot_missing");
        const raw = rows[0];
        if (rows.length !== 1 || raw === undefined || !Buffer.isBuffer(raw["chunkBytes"]) ||
          raw["inputStorageClass"] !== "blob" || raw["resultStorageClass"] !== "blob" ||
          !Number.isSafeInteger(raw["inputBytes"]) || (raw["inputBytes"] as number) < 1 ||
          (raw["inputBytes"] as number) > presentationSnapshotLimits.inputBytes ||
          !Number.isSafeInteger(raw["resultBytes"]) || (raw["resultBytes"] as number) < 1 ||
          (raw["resultBytes"] as number) > presentationSnapshotLimits.resultBytes) {
          return presentationUnavailable("snapshot_inconsistent");
        }
        let row: PresentationSnapshotMetadataRow;
        try {
          row = {
            snapshotId: snapshotIdField.read(raw),
            contractId: contractIdField.read(raw),
            contractVersion: contractVersionField.read(raw),
            inputBytes: raw["inputBytes"] as number,
            inputDigest: inputDigestField.read(raw),
            resultBytes: raw["resultBytes"] as number,
            resultDigest: resultDigestField.read(raw),
            resultChunkDigestsJson: resultChunkDigestsField.read(raw),
            chunkBytes: raw["chunkBytes"],
          };
        } catch { return presentationUnavailable("snapshot_inconsistent"); }
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
        if (Buffer.byteLength(revision, "utf8") > runtimeOwnerRevisionBytes) {
          throw new RuntimeOperationError("runtime_state_unavailable");
        }
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
        const rows = this.#database.prepare(`SELECT ${chainIdField.projection()} FROM chain WHERE chain_id = ?`)
          .all(chainId) as SqliteRow[];
        if (rows.length !== 1 || rows[0] === undefined || parseEvmChainId(chainIdField.read(rows[0])) !== chainId) {
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
        assertWalletConnectionStorageSize(values, revision);
        if (connection.status === "connected") {
          this.#database.prepare(`INSERT INTO account(profile_id, chain_id, account_address)
            VALUES (?, ?, ?) ON CONFLICT(profile_id, chain_id, account_address) DO NOTHING`)
            .run(profile.profileId, connection.chainId, connection.address);
          const accountRows = this.#database.prepare(`${accountSelect}
            WHERE profile_id = ? AND chain_id = ? AND account_address = ?`)
            .all(profile.profileId, connection.chainId, connection.address) as SqliteRow[];
          if (accountRows.length !== 1 || accountRows[0] === undefined) {
            throw new Error("Account persistence failed.");
          }
          decodeStoredAccountRecordKey(accountRows[0]);
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
          .all(profile.profileId, operationId) as SqliteRow[];
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
          .all(profile.profileId, ...walletNonterminalOperationStates) as SqliteRow[];
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
          WHERE operation_id = ?`).all(operation.operationId) as SqliteRow[];
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
          .all(profile.profileId, operation.operationId) as SqliteRow[];
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
          .all(profile.profileId, operationId) as SqliteRow[];
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
          .all(profile.profileId, operationId) as SqliteRow[];
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
      WHERE profile_id = ? AND chain_id = ? AND account_address = ?`)
      .all(profileId, account.chainId, account.address) as SqliteRow[];
    if (rows.length > 1) throw new Error("Token selection state identity is not unique.");
    return rows[0] === undefined ? undefined : decodeTokenSelectionStateRow(rows[0], profileId);
  }

  private isAccountRetained(accountInput: EvmAccountIdentity): boolean {
    try {
      const account = evmAccountIdentitySchema.parse(accountInput);
      return this.#readWithIdentity(() => {
        const profile = readProfileRaw(this.#database);
        const rows = this.#database.prepare(`${accountSelect}
          WHERE profile_id = ? AND chain_id = ? AND account_address = ?`)
          .all(profile.profileId, account.chainId, account.address) as SqliteRow[];
        if (rows.length > 1) throw new Error("Account identity is not unique.");
        if (rows[0] === undefined) return false;
        decodeStoredAccountRecordKey(rows[0]);
        return true;
      });
    } catch (error) { throw tokenCatalogStorageError(error); }
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

  private getRetainedInspection(
    asset: TokenSelection["asset"],
    inspectionDigest: ReturnType<typeof parseHash32>,
  ): TokenInspectionSuccess | null {
    const rows = this.#database.prepare(`${tokenInspectionSelect}
      WHERE chain_id = ? AND contract_address = ? AND inspection_digest = ?`)
      .all(asset.chainId, asset.address, inspectionDigest) as SqliteRow[];
    if (rows.length === 0) return null;
    if (rows.length !== 1 || rows[0] === undefined) {
      throw new Error("Token inspection identity is not unique.");
    }
    return decodeInspectionRow(rows[0]);
  }

  private getTokenSelectionRaw(
    profileId: ProfileId,
    account: EvmAccountIdentity,
    asset: TokenSelection["asset"],
  ): TokenSelectionDetail | undefined {
    const rows = this.#database.prepare(`${tokenSelectionRecordSelect}
      WHERE r.profile_id = ? AND r.chain_id = ? AND r.account_address = ? AND r.token_address = ?`)
      .all(profileId, account.chainId, account.address, asset.address) as SqliteRow[];
    if (rows.length > 1) throw new Error("Token selection identity is not unique.");
    if (rows[0] === undefined) return undefined;
    const stored = decodeTokenSelectionStorageRow(rows[0], profileId);
    return tokenSelectionDetailSchema.parse({
      selection: stored.selection,
      historicalInspection: stored.inspectionDigest === null
        ? null
        : this.getRetainedInspection(asset, stored.inspectionDigest),
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
          WHERE r.profile_id = ? AND r.chain_id = ? AND r.account_address = ?
            AND (? = 0 OR r.included IS NOT 0) AND (? IS NULL OR r.token_address > ?)${excludedSql}
          ORDER BY r.token_address LIMIT ?`)
          .all(
            profile.profileId, account.chainId, account.address,
            input.includedOnly ? 1 : 0, cursor, cursor, ...excluded, input.limit + 1,
          ) as SqliteRow[];
        const hasMore = rows.length > input.limit;
        const selections = rows.map((row) => decodeTokenSelectionRecordRow(row, profile.profileId))
          .slice(0, input.limit);
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
      const snapshotRevision = officialAssetSnapshotRevisionSchema.parse(input.snapshotRevision);
      const now = parseUtcTimestamp(input.now);
      return this.#writeWithIdentity(() => {
        const profile = readProfileRaw(this.#database);
        const accountRows = this.#database.prepare(`${accountSelect}
          WHERE profile_id = ? AND chain_id = ? AND account_address = ?`)
          .all(profile.profileId, account.chainId, account.address) as SqliteRow[];
        if (accountRows.length !== 1 || accountRows[0] === undefined) {
          throw new RuntimeOperationError("state_conflict");
        }
        decodeStoredAccountRecordKey(accountRows[0]);
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
          this.#database.prepare(`INSERT INTO account_token_selection_state(
            profile_id, chain_id, account_address, revision, defaults_initialized, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 1, ?, ?)`)
            .run(profile.profileId, account.chainId, account.address, stateRevision, now, now);
        } else {
          const update = this.#database.prepare(`UPDATE account_token_selection_state
            SET revision = ?, defaults_initialized = 1, updated_at = ?
            WHERE profile_id = ? AND chain_id = ? AND account_address = ?
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
          this.#database.prepare(`INSERT INTO account_token_selection(
            profile_id, chain_id, account_address, token_address, included, revision, created_at, updated_at
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
          .all(profile.profileId, operationId) as SqliteRow[];
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
      const account = evmAccountIdentitySchema.parse(action.review.target.account);
      const asset = erc20AssetIdentitySchema.parse(action.review.target.asset);
      const accountTarget = action.review.precondition.accountTarget;
      const expectedConnectionRevision = accountTarget.kind === "active_wallet"
        ? parseRuntimeRevision(accountTarget.connectionRevision)
        : null;
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
          WHERE operation_id = ?`).all(action.review.operationId) as SqliteRow[];
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

        if (expectedConnectionRevision !== null) {
          this.assertCurrentWalletConnection(account, expectedConnectionRevision);
        }
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

        let preparedInspection: Readonly<{
          inspection: TokenInspectionSuccess;
          digest: ReturnType<typeof parseHash32>;
          bytes: Buffer;
        }> | null = null;
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
          const bytes = canonicalBytes(inspection as unknown as CanonicalJson);
          if (bytes.length > tokenInspectionPersistenceLimits.resultBytes) {
            throw new TokenCatalogOperationError("result_too_large");
          }
          preparedInspection = Object.freeze({
            inspection,
            digest: tokenInspectionDigest(inspection),
            bytes,
          });
        } else {
          if (inspection !== null || verification !== null) {
            throw new TokenCatalogOperationError("invalid_input");
          }
          const previous = action.review.precondition.previousSelection;
          if (previous === null || !previous.included || current === undefined) {
            throw new TokenCatalogOperationError("token_selection_not_included");
          }
        }

        const nextSelection = tokenSelectionSchema.parse({
          account,
          asset,
          included: action.review.kind === "add",
          revision,
          createdAt: current?.selection.createdAt ?? completedAt,
          updatedAt: completedAt,
        });
        const operationSelection = tokenSelectionDetailSchema.parse({
          selection: nextSelection,
          historicalInspection: action.review.kind === "add"
            ? preparedInspection?.inspection
            : null,
        });
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
            selection: operationSelection,
          },
        });
        const operationBytes = canonicalBytes(operation as unknown as CanonicalJson);
        if (
          action.review.kind === "add" &&
          operationBytes.length > persistedOperationJsonLimits.tokenSelectionBytes
        ) throw new TokenCatalogOperationError("result_too_large");

        if (action.review.kind === "add") {
          const prepared = preparedInspection;
          if (prepared === null) throw new Error("Token inspection preparation is unavailable.");
          this.#database.prepare(`INSERT INTO account(profile_id, chain_id, account_address)
            VALUES (?, ?, ?) ON CONFLICT(profile_id, chain_id, account_address) DO NOTHING`)
            .run(profile.profileId, account.chainId, account.address);
          const accountRows = this.#database.prepare(`${accountSelect}
            WHERE profile_id = ? AND chain_id = ? AND account_address = ?`)
            .all(profile.profileId, account.chainId, account.address) as SqliteRow[];
          if (accountRows.length !== 1 || accountRows[0] === undefined) {
            throw new Error("Account persistence failed.");
          }
          decodeStoredAccountRecordKey(accountRows[0]);
          this.#database.prepare(`INSERT INTO contract(chain_id, contract_address) VALUES (?, ?)
            ON CONFLICT(chain_id, contract_address) DO NOTHING`).run(asset.chainId, asset.address);
          this.#database.prepare(`INSERT INTO token_contract(chain_id, contract_address) VALUES (?, ?)
            ON CONFLICT(chain_id, contract_address) DO NOTHING`).run(asset.chainId, asset.address);
          const inspectionRows = this.#database.prepare(`${tokenInspectionSelect}
            WHERE chain_id = ? AND contract_address = ? AND inspection_digest = ?`)
            .all(asset.chainId, asset.address, prepared.digest) as SqliteRow[];
          if (inspectionRows.length === 0) {
            const entries = readTokenInspectionRetentionEntries(this.#database);
            const victims = selectTokenInspectionRetentionVictims(entries, {
              chainId: asset.chainId,
              contractAddress: asset.address,
              inspectionDigest: prepared.digest,
              byteLength: prepared.bytes.length,
            });
            const removeInspection = this.#database.prepare(`DELETE FROM token_contract_inspection
              WHERE chain_id = ? AND contract_address = ? AND inspection_digest = ?`);
            for (const victim of victims) {
              const removed = removeInspection.run(
                victim.chainId,
                victim.contractAddress,
                victim.inspectionDigest,
              );
              if (removed.changes !== 1) {
                throw new Error("Token inspection retention changed during mutation.");
              }
            }
            this.#database.prepare(`INSERT INTO token_contract_inspection(
              chain_id, contract_address, inspection_digest, result_bytes
            ) VALUES (?, ?, ?, ?)`).run(
              asset.chainId,
              asset.address,
              prepared.digest,
              prepared.bytes,
            );
          } else if (
            inspectionRows.length !== 1 ||
            inspectionRows[0] === undefined ||
            Buffer.compare(inspectionResultField.read(inspectionRows[0]), prepared.bytes) !== 0
          ) {
            throw new Error("Token inspection digest collision detected.");
          } else {
            decodeInspectionRow(inspectionRows[0]);
          }
          if (state === undefined) {
            this.#database.prepare(`INSERT INTO account_token_selection_state(
              profile_id, chain_id, account_address, revision, defaults_initialized, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 0, ?, ?)`).run(
              profile.profileId,
              account.chainId,
              account.address,
              stateRevision,
              completedAt,
              completedAt,
            );
          }
          this.#database.prepare(`INSERT INTO account_token_selection(
            profile_id, chain_id, account_address, token_address, inspection_digest,
            included, revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
          ON CONFLICT(profile_id, chain_id, account_address, token_address) DO UPDATE SET
            inspection_digest = excluded.inspection_digest,
            included = 1, revision = excluded.revision, updated_at = excluded.updated_at`)
            .run(
              profile.profileId,
              account.chainId,
              account.address,
              asset.address,
              prepared.digest,
              revision,
              completedAt,
              completedAt,
            );
        } else {
          const previous = action.review.precondition.previousSelection;
          if (previous === null || current === undefined) throw new Error("Token removal state is unavailable.");
          const removal = this.#database.prepare(`UPDATE account_token_selection
            SET included = 0, revision = ?, updated_at = ?
            WHERE profile_id = ? AND chain_id = ? AND account_address = ?
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
          const stateUpdate = this.#database.prepare(`UPDATE account_token_selection_state
            SET revision = ?, updated_at = ?
            WHERE profile_id = ? AND chain_id = ? AND account_address = ? AND revision = ?`)
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
          canonicalJsonStringify(stored.selection as unknown as CanonicalJson) !==
            canonicalJsonStringify(nextSelection as unknown as CanonicalJson) ||
          (action.review.kind === "add" && (
            stored.historicalInspection === null ||
            tokenInspectionDigest(stored.historicalInspection) !== preparedInspection?.digest
          ))
        ) throw new Error("Token selection persistence postcondition failed.");
        this.#database.prepare(`INSERT INTO token_selection_operation(
          profile_id, operation_id, kind, initiated_by, review_digest,
          chain_id, account_address, token_address, operation_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          profile.profileId,
          operation.operationId,
          operation.kind,
          operation.initiatedBy,
          operation.review.reviewDigest,
          account.chainId,
          account.address,
          asset.address,
          operationBytes,
        );
        const storedRows = this.#database.prepare(`${tokenSelectionOperationSelect}
          WHERE profile_id = ? AND operation_id = ?`)
          .all(profile.profileId, operation.operationId) as SqliteRow[];
        if (storedRows.length !== 1 || storedRows[0] === undefined) {
          throw new Error("Token selection operation persistence failed.");
        }
        return decodeTokenSelectionOperationRow(storedRows[0], profile.profileId);
      });
    } catch (error) { throw tokenCatalogStorageError(error); }
  }

}
