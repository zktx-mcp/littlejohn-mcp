import Database from "better-sqlite3";

import {
  productChainId,
  referenceFeedIntegrityStatuses,
  referenceFeedTraversalStatuses,
  referenceMarketLimits,
  referenceMarketManifest,
  referenceMarketManifestVersion,
  tokenDisplayTextLimits,
  walletConnectionStatusDefinitions,
} from "../core/index.js";
import { tokenCatalogContractLimits } from "../token-catalog/contracts.js";
import { officialAssetSourceDefinition } from "../registry/official-asset-contract.js";
import {
  runtimeConfigurationMacByteLength,
  runtimeIdentifierByteLength,
} from "./runtime-identity.js";
import { walletConnectionFieldPresenceCheckSql } from "./wallet-connection-storage.js";

const sqlIdentifierPattern = /^[a-z][a-z0-9_]*$/u;
const base64UrlAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export const runtimeStateResetRequiredCode = "runtime_state_reset_required" as const;
export const runtimeStateResetRequiredMessage =
  "Local development state must be reset. Stop Little John, move the entire data directory aside or " +
  "replace it with a new empty directory, and start again.";

export interface RuntimeStateResetRequiredError extends Error {
  readonly code: typeof runtimeStateResetRequiredCode;
}

const runtimeStateResetRequiredErrors = new WeakSet<object>();

class RuntimeStateResetRequiredSourceError extends Error implements RuntimeStateResetRequiredError {
  readonly code = runtimeStateResetRequiredCode;

  constructor() {
    super(runtimeStateResetRequiredMessage);
    this.name = "RuntimeStateResetRequiredError";
    runtimeStateResetRequiredErrors.add(this);
    Object.freeze(this);
  }
}

export const createRuntimeStateResetRequiredError = (): RuntimeStateResetRequiredError =>
  new RuntimeStateResetRequiredSourceError();

export const getRuntimeStateResetRequiredError = (
  error: unknown,
): RuntimeStateResetRequiredError | undefined =>
  typeof error === "object" && error !== null && runtimeStateResetRequiredErrors.has(error)
    ? error as RuntimeStateResetRequiredError
    : undefined;

const sqlColumn = (column: string): string => {
  if (!sqlIdentifierPattern.test(column)) throw new TypeError("SQLite column identifier is invalid.");
  return column;
};

const sqlString = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const sqlStringList = (values: readonly string[]): string => values.map(sqlString).join(", ");

export const canonicalSqlTextCheck = (columnInput: string): string => {
  const column = sqlColumn(columnInput);
  return `instr(${column}, char(0)) = 0`;
};

export const canonicalUnsignedDecimalSqlCheck = (columnInput: string): string => {
  const column = sqlColumn(columnInput);
  return `(${canonicalSqlTextCheck(column)} AND length(${column}) >= 1 AND ` +
    `${column} NOT GLOB '*[^0-9]*' AND (${column} = '0' OR substr(${column}, 1, 1) BETWEEN '1' AND '9'))`;
};

const canonicalBase64UrlSqlCheck = (columnInput: string, byteLength: number): string => {
  const column = sqlColumn(columnInput);
  if (!Number.isSafeInteger(byteLength) || byteLength < 1) {
    throw new TypeError("Base64url byte length must be a positive safe integer.");
  }
  const encodedLength = Math.ceil(byteLength * 4 / 3);
  const trailingBytes = byteLength % 3;
  const terminalStride = trailingBytes === 1 ? 16 : trailingBytes === 2 ? 4 : 1;
  const terminalCharacters = Array.from(
    { length: base64UrlAlphabet.length / terminalStride },
    (_, index) => base64UrlAlphabet[index * terminalStride],
  ).join("");
  const terminalCheck = trailingBytes === 0
    ? ""
    : ` AND substr(${column}, ${encodedLength}, 1) GLOB '[${terminalCharacters}]'`;
  return `(${canonicalSqlTextCheck(column)} AND length(${column}) = ${encodedLength} AND ` +
    `${column} NOT GLOB '*[^A-Za-z0-9_-]*'${terminalCheck})`;
};

export const canonicalRuntimeIdentifierSqlCheck = (columnInput: string): string =>
  canonicalBase64UrlSqlCheck(columnInput, runtimeIdentifierByteLength);

export const canonicalRuntimeConfigurationMacSqlCheck = (columnInput: string): string =>
  canonicalBase64UrlSqlCheck(columnInput, runtimeConfigurationMacByteLength);

export const canonicalEvmChainIdSqlCheck = (columnInput: string): string => {
  const column = sqlColumn(columnInput);
  return `(${canonicalSqlTextCheck(column)} AND length(${column}) BETWEEN 8 AND 39 AND ` +
    `substr(${column}, 1, 7) = 'eip155:' AND length(substr(${column}, 8)) BETWEEN 1 AND 32 AND ` +
    `substr(${column}, 8) NOT GLOB '*[^0-9]*' AND substr(${column}, 8, 1) BETWEEN '1' AND '9')`;
};

export const canonicalEvmAddressSqlCheck = (columnInput: string): string => {
  const column = sqlColumn(columnInput);
  return `(${canonicalSqlTextCheck(column)} AND length(${column}) = 42 AND ` +
    `substr(${column}, 1, 2) = '0x' AND lower(${column}) = ${column} AND ` +
    `substr(${column}, 3) NOT GLOB '*[^0-9a-f]*')`;
};

export const canonicalHash32SqlCheck = (columnInput: string): string => {
  const column = sqlColumn(columnInput);
  return `(${canonicalSqlTextCheck(column)} AND length(${column}) = 66 AND ` +
    `substr(${column}, 1, 2) = '0x' AND lower(${column}) = ${column} AND ` +
    `substr(${column}, 3) NOT GLOB '*[^0-9a-f]*')`;
};

export const canonicalSelectionRevisionSqlCheck = (columnInput: string): string =>
  canonicalBase64UrlSqlCheck(columnInput, tokenCatalogContractLimits.selectionRevisionBytes);

export const canonicalReferenceRevisionSqlCheck = (columnInput: string): string =>
  canonicalBase64UrlSqlCheck(columnInput, referenceMarketLimits.revisionBytes);

export const canonicalJsonObjectSqlCheck = (columnInput: string): string => {
  const column = sqlColumn(columnInput);
  return `(${canonicalSqlTextCheck(column)} AND length(CAST(${column} AS BLOB)) BETWEEN 2 AND 65536 AND ` +
    `json_valid(${column}) = 1 AND json_type(${column}) = 'object')`;
};

const walletStatuses = Object.freeze(Object.keys(walletConnectionStatusDefinitions));
const [referenceMalformedStatus, referencePhaseBoundaryStatus, referenceRetentionBoundaryStatus] =
  referenceFeedTraversalStatuses;
if (
  referenceMalformedStatus === undefined || referencePhaseBoundaryStatus === undefined ||
  referenceRetentionBoundaryStatus === undefined
) throw new TypeError("Reference feed traversal definitions are incomplete.");
const referenceFeedIdentitySqlCheck = `manifest_version = ${referenceMarketManifestVersion} AND ` +
  `chain_id = ${sqlString(productChainId)} AND (` + referenceMarketManifest.feeds.map((feed) =>
    `(feed_id = ${sqlString(feed.feedId)} AND proxy_address = ${sqlString(feed.standardProxy)})`).join(" OR ") + `)`;

export const currentSqliteSchemaSql = `CREATE TABLE local_profile (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  profile_id TEXT NOT NULL UNIQUE CHECK (${canonicalRuntimeIdentifierSqlCheck("profile_id")}),
  created_at TEXT NOT NULL CHECK (${canonicalSqlTextCheck("created_at")})
) STRICT;
CREATE TABLE runtime_owner (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  profile_id TEXT NOT NULL CHECK (${canonicalSqlTextCheck("profile_id")}),
  owner_instance_id TEXT NOT NULL CHECK (${canonicalRuntimeIdentifierSqlCheck("owner_instance_id")}),
  configuration_mac TEXT NOT NULL CHECK (${canonicalRuntimeConfigurationMacSqlCheck("configuration_mac")}),
  process_id INTEGER NOT NULL CHECK (process_id > 0),
  owner_revision TEXT NOT NULL CHECK (${canonicalUnsignedDecimalSqlCheck("owner_revision")}),
  acquired_at TEXT NOT NULL CHECK (${canonicalSqlTextCheck("acquired_at")}),
  FOREIGN KEY (profile_id) REFERENCES local_profile(profile_id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;
CREATE TABLE chain (
  chain_id TEXT NOT NULL PRIMARY KEY CHECK (${canonicalEvmChainIdSqlCheck("chain_id")})
) STRICT, WITHOUT ROWID;
CREATE TABLE reference_feed_round (
  manifest_version INTEGER NOT NULL CHECK (manifest_version = ${referenceMarketManifestVersion}),
  chain_id TEXT NOT NULL CHECK (${canonicalEvmChainIdSqlCheck("chain_id")}),
  feed_id TEXT NOT NULL CHECK (feed_id IN (${sqlStringList(referenceMarketManifest.feeds.map((feed) => feed.feedId))})),
  proxy_address TEXT NOT NULL CHECK (${canonicalEvmAddressSqlCheck("proxy_address")}),
  phase_id TEXT NOT NULL CHECK (${canonicalUnsignedDecimalSqlCheck("phase_id")}),
  aggregator_round_id TEXT NOT NULL CHECK (${canonicalUnsignedDecimalSqlCheck("aggregator_round_id")}),
  round_id TEXT NOT NULL CHECK (${canonicalUnsignedDecimalSqlCheck("round_id")}),
  answered_in_round TEXT NOT NULL CHECK (${canonicalUnsignedDecimalSqlCheck("answered_in_round")}),
  answer TEXT NOT NULL CHECK (${canonicalUnsignedDecimalSqlCheck("answer")}),
  started_at_unix_seconds TEXT NOT NULL CHECK (${canonicalUnsignedDecimalSqlCheck("started_at_unix_seconds")}),
  updated_at_unix_seconds TEXT NOT NULL CHECK (${canonicalUnsignedDecimalSqlCheck("updated_at_unix_seconds")}),
  read_evidence_json TEXT NOT NULL CHECK (${canonicalJsonObjectSqlCheck("read_evidence_json")}),
  CHECK (${referenceFeedIdentitySqlCheck}),
  PRIMARY KEY (manifest_version, chain_id, feed_id, proxy_address, phase_id, aggregator_round_id),
  UNIQUE (manifest_version, chain_id, feed_id, proxy_address, round_id),
  FOREIGN KEY (chain_id) REFERENCES chain(chain_id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;
CREATE INDEX reference_feed_round_time
  ON reference_feed_round(manifest_version, chain_id, feed_id, proxy_address, updated_at_unix_seconds);
CREATE TABLE reference_feed_sync_state (
  manifest_version INTEGER NOT NULL CHECK (manifest_version = ${referenceMarketManifestVersion}),
  chain_id TEXT NOT NULL CHECK (${canonicalEvmChainIdSqlCheck("chain_id")}),
  feed_id TEXT NOT NULL CHECK (feed_id IN (${sqlStringList(referenceMarketManifest.feeds.map((feed) => feed.feedId))})),
  proxy_address TEXT NOT NULL CHECK (${canonicalEvmAddressSqlCheck("proxy_address")}),
  revision TEXT NOT NULL CHECK (${canonicalReferenceRevisionSqlCheck("revision")}),
  backfill_phase_id TEXT CHECK (
    backfill_phase_id IS NULL OR
      (${canonicalUnsignedDecimalSqlCheck("backfill_phase_id")} AND backfill_phase_id != '0')
  ),
  backfill_next_round_id TEXT CHECK (
    backfill_next_round_id IS NULL OR ${canonicalUnsignedDecimalSqlCheck("backfill_next_round_id")}
  ),
  retention_cutoff_round_id TEXT CHECK (
    retention_cutoff_round_id IS NULL OR ${canonicalUnsignedDecimalSqlCheck("retention_cutoff_round_id")}
  ),
  integrity_status TEXT CHECK (
    integrity_status IS NULL OR integrity_status IN (${sqlStringList(referenceFeedIntegrityStatuses)})
  ),
  backfill_status TEXT CHECK (
    backfill_status IS NULL OR backfill_status IN (${sqlStringList(referenceFeedTraversalStatuses)})
  ),
  updated_at TEXT NOT NULL CHECK (${canonicalSqlTextCheck("updated_at")}),
  CHECK (
    (backfill_phase_id IS NULL AND backfill_next_round_id IS NULL AND backfill_status IS NULL) OR
    (backfill_phase_id IS NOT NULL AND (
      (backfill_status IS NULL AND backfill_next_round_id IS NOT NULL) OR
      (backfill_status = ${sqlString(referenceMalformedStatus)} AND backfill_next_round_id IS NOT NULL) OR
      (backfill_status = ${sqlString(referencePhaseBoundaryStatus)} AND backfill_next_round_id IS NULL) OR
      (backfill_status = ${sqlString(referenceRetentionBoundaryStatus)} AND
        backfill_next_round_id IS NULL AND retention_cutoff_round_id IS NOT NULL)
    ))
  ),
  CHECK (
    backfill_next_round_id IS NULL OR retention_cutoff_round_id IS NULL OR
    length(backfill_next_round_id) > length(retention_cutoff_round_id) OR
    (
      length(backfill_next_round_id) = length(retention_cutoff_round_id) AND
      backfill_next_round_id > retention_cutoff_round_id
    )
  ),
  CHECK (${referenceFeedIdentitySqlCheck}),
  PRIMARY KEY (manifest_version, chain_id, feed_id, proxy_address),
  FOREIGN KEY (chain_id) REFERENCES chain(chain_id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;
CREATE TABLE robinhood_asset_snapshot (
  chain_id TEXT NOT NULL PRIMARY KEY CHECK (${canonicalEvmChainIdSqlCheck("chain_id")}),
  source_uri TEXT NOT NULL CHECK (source_uri = ${sqlString(officialAssetSourceDefinition.sourceUri)}),
  source_observed_at TEXT NOT NULL CHECK (${canonicalSqlTextCheck("source_observed_at")}),
  raw_response_digest TEXT NOT NULL CHECK (${canonicalHash32SqlCheck("raw_response_digest")}),
  member_set_digest TEXT NOT NULL CHECK (${canonicalHash32SqlCheck("member_set_digest")}),
  candidate_list_digest TEXT NOT NULL CHECK (${canonicalHash32SqlCheck("candidate_list_digest")}),
  revision TEXT NOT NULL CHECK (${canonicalSelectionRevisionSqlCheck("revision")}),
  updated_at TEXT NOT NULL CHECK (${canonicalSqlTextCheck("updated_at")}),
  FOREIGN KEY (chain_id) REFERENCES chain(chain_id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;
CREATE TABLE robinhood_asset (
  chain_id TEXT NOT NULL CHECK (${canonicalEvmChainIdSqlCheck("chain_id")}),
  contract_address TEXT NOT NULL CHECK (${canonicalEvmAddressSqlCheck("contract_address")}),
  asset_uid TEXT NOT NULL CHECK (${canonicalHash32SqlCheck("asset_uid")}),
  source_name TEXT CHECK (source_name IS NULL OR (${canonicalSqlTextCheck("source_name")} AND length(CAST(source_name AS BLOB)) <= ${tokenDisplayTextLimits.utf8Bytes})),
  source_symbol TEXT CHECK (source_symbol IS NULL OR (${canonicalSqlTextCheck("source_symbol")} AND length(CAST(source_symbol AS BLOB)) <= ${tokenDisplayTextLimits.utf8Bytes})),
  PRIMARY KEY (chain_id, contract_address),
  UNIQUE (chain_id, asset_uid),
  FOREIGN KEY (chain_id) REFERENCES robinhood_asset_snapshot(chain_id)
    ON UPDATE RESTRICT ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE TABLE contract (
  chain_id TEXT NOT NULL CHECK (${canonicalEvmChainIdSqlCheck("chain_id")}),
  contract_address TEXT NOT NULL CHECK (${canonicalEvmAddressSqlCheck("contract_address")}),
  PRIMARY KEY (chain_id, contract_address),
  FOREIGN KEY (chain_id) REFERENCES chain(chain_id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;
CREATE TABLE token_contract (
  chain_id TEXT NOT NULL CHECK (${canonicalEvmChainIdSqlCheck("chain_id")}),
  contract_address TEXT NOT NULL CHECK (${canonicalEvmAddressSqlCheck("contract_address")}),
  PRIMARY KEY (chain_id, contract_address),
  FOREIGN KEY (chain_id, contract_address) REFERENCES contract(chain_id, contract_address)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;
CREATE TABLE token_contract_inspection (
  chain_id TEXT NOT NULL CHECK (${canonicalEvmChainIdSqlCheck("chain_id")}),
  contract_address TEXT NOT NULL CHECK (${canonicalEvmAddressSqlCheck("contract_address")}),
  inspection_digest TEXT NOT NULL CHECK (${canonicalHash32SqlCheck("inspection_digest")}),
  result_json TEXT NOT NULL CHECK (${canonicalJsonObjectSqlCheck("result_json")}),
  PRIMARY KEY (chain_id, contract_address, inspection_digest),
  FOREIGN KEY (chain_id, contract_address)
    REFERENCES token_contract(chain_id, contract_address)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;
CREATE TABLE wallet_account (
  profile_id TEXT NOT NULL CHECK (${canonicalSqlTextCheck("profile_id")}),
  chain_id TEXT NOT NULL CHECK (${canonicalEvmChainIdSqlCheck("chain_id")}),
  wallet_address TEXT NOT NULL CHECK (${canonicalEvmAddressSqlCheck("wallet_address")}),
  PRIMARY KEY (profile_id, chain_id, wallet_address),
  FOREIGN KEY (profile_id) REFERENCES local_profile(profile_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (chain_id) REFERENCES chain(chain_id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;
CREATE TABLE reference_pair_watchlist_state (
  profile_id TEXT NOT NULL CHECK (${canonicalSqlTextCheck("profile_id")}),
  chain_id TEXT NOT NULL CHECK (${canonicalEvmChainIdSqlCheck("chain_id")}),
  wallet_address TEXT NOT NULL CHECK (${canonicalEvmAddressSqlCheck("wallet_address")}),
  revision TEXT NOT NULL CHECK (${canonicalReferenceRevisionSqlCheck("revision")}),
  created_at TEXT NOT NULL CHECK (${canonicalSqlTextCheck("created_at")}),
  updated_at TEXT NOT NULL CHECK (${canonicalSqlTextCheck("updated_at")}),
  PRIMARY KEY (profile_id, chain_id, wallet_address),
  FOREIGN KEY (profile_id, chain_id, wallet_address)
    REFERENCES wallet_account(profile_id, chain_id, wallet_address)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;
CREATE TABLE reference_pair_watchlist_entry (
  profile_id TEXT NOT NULL CHECK (${canonicalSqlTextCheck("profile_id")}),
  chain_id TEXT NOT NULL CHECK (${canonicalEvmChainIdSqlCheck("chain_id")}),
  wallet_address TEXT NOT NULL CHECK (${canonicalEvmAddressSqlCheck("wallet_address")}),
  pair_id TEXT NOT NULL CHECK (${canonicalHash32SqlCheck("pair_id")}),
  pair_json TEXT NOT NULL CHECK (${canonicalJsonObjectSqlCheck("pair_json")}),
  position INTEGER NOT NULL CHECK (
    position BETWEEN 0 AND ${referenceMarketLimits.watchlistEntries - 1}
  ),
  PRIMARY KEY (profile_id, chain_id, wallet_address, pair_id),
  UNIQUE (profile_id, chain_id, wallet_address, position),
  FOREIGN KEY (profile_id, chain_id, wallet_address)
    REFERENCES reference_pair_watchlist_state(profile_id, chain_id, wallet_address)
    ON UPDATE RESTRICT ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE TABLE wallet_token_selection_state (
  profile_id TEXT NOT NULL CHECK (${canonicalSqlTextCheck("profile_id")}),
  chain_id TEXT NOT NULL CHECK (${canonicalEvmChainIdSqlCheck("chain_id")}),
  wallet_address TEXT NOT NULL CHECK (${canonicalEvmAddressSqlCheck("wallet_address")}),
  revision TEXT NOT NULL CHECK (${canonicalSelectionRevisionSqlCheck("revision")}),
  defaults_initialized INTEGER NOT NULL CHECK (defaults_initialized IN (0, 1)),
  created_at TEXT NOT NULL CHECK (${canonicalSqlTextCheck("created_at")}),
  updated_at TEXT NOT NULL CHECK (${canonicalSqlTextCheck("updated_at")}),
  PRIMARY KEY (profile_id, chain_id, wallet_address),
  FOREIGN KEY (profile_id, chain_id, wallet_address)
    REFERENCES wallet_account(profile_id, chain_id, wallet_address)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;
CREATE TABLE wallet_token_selection (
  profile_id TEXT NOT NULL CHECK (${canonicalSqlTextCheck("profile_id")}),
  chain_id TEXT NOT NULL CHECK (${canonicalEvmChainIdSqlCheck("chain_id")}),
  wallet_address TEXT NOT NULL CHECK (${canonicalEvmAddressSqlCheck("wallet_address")}),
  token_address TEXT NOT NULL CHECK (${canonicalEvmAddressSqlCheck("token_address")}),
  included INTEGER NOT NULL CHECK (included IN (0, 1)),
  revision TEXT NOT NULL CHECK (${canonicalSelectionRevisionSqlCheck("revision")}),
  created_at TEXT NOT NULL CHECK (${canonicalSqlTextCheck("created_at")}),
  updated_at TEXT NOT NULL CHECK (${canonicalSqlTextCheck("updated_at")}),
  PRIMARY KEY (profile_id, chain_id, wallet_address, token_address),
  FOREIGN KEY (profile_id, chain_id, wallet_address)
    REFERENCES wallet_token_selection_state(profile_id, chain_id, wallet_address)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (chain_id, token_address)
    REFERENCES token_contract(chain_id, contract_address)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;
CREATE INDEX wallet_token_selection_token_fk
  ON wallet_token_selection(chain_id, token_address);
CREATE TABLE current_wallet_connection (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  profile_id TEXT NOT NULL CHECK (${canonicalSqlTextCheck("profile_id")}),
  revision TEXT NOT NULL CHECK (${canonicalUnsignedDecimalSqlCheck("revision")}),
  revalidation_required INTEGER NOT NULL CHECK (revalidation_required IN (0, 1)),
  status TEXT NOT NULL CHECK (${canonicalSqlTextCheck("status")} AND status IN (${sqlStringList(walletStatuses)})),
  reason TEXT CHECK (reason IS NULL OR ${canonicalSqlTextCheck("reason")}),
  chain_id TEXT CHECK (chain_id IS NULL OR ${canonicalEvmChainIdSqlCheck("chain_id")}),
  wallet_address TEXT CHECK (wallet_address IS NULL OR ${canonicalEvmAddressSqlCheck("wallet_address")}),
  approved_methods_json TEXT CHECK (approved_methods_json IS NULL OR ${canonicalSqlTextCheck("approved_methods_json")}),
  approved_events_json TEXT CHECK (approved_events_json IS NULL OR ${canonicalSqlTextCheck("approved_events_json")}),
  expires_at TEXT CHECK (expires_at IS NULL OR ${canonicalSqlTextCheck("expires_at")}),
  session_count TEXT CHECK (session_count IS NULL OR (${canonicalUnsignedDecimalSqlCheck("session_count")} AND session_count != '0')),
  updated_at TEXT NOT NULL CHECK (${canonicalSqlTextCheck("updated_at")}),
  FOREIGN KEY (profile_id) REFERENCES local_profile(profile_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (profile_id, chain_id, wallet_address)
    REFERENCES wallet_account(profile_id, chain_id, wallet_address)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (status != 'connected' OR revalidation_required = 0),
  ${walletConnectionFieldPresenceCheckSql}
) STRICT;`;

interface SqliteSchemaTuple {
  readonly type: Buffer;
  readonly name: Buffer;
  readonly tableName: Buffer;
  readonly sql: Buffer | null;
}

interface SqliteSchemaReference {
  readonly tuples: readonly SqliteSchemaTuple[];
  readonly rowCount: number;
  readonly maximumTypeBytes: number;
  readonly maximumNameBytes: number;
  readonly maximumTableNameBytes: number;
  readonly maximumSqlBytes: number;
  readonly totalTupleBytes: number;
}

interface ReferenceSchemaRow {
  readonly type: unknown;
  readonly name: unknown;
  readonly tableName: unknown;
  readonly sql: unknown;
}

interface CandidateSchemaRow {
  readonly typeStorage: unknown;
  readonly typeBytes: unknown;
  readonly nameStorage: unknown;
  readonly nameBytes: unknown;
  readonly tableNameStorage: unknown;
  readonly tableNameBytes: unknown;
  readonly sqlStorage: unknown;
  readonly sqlBytes: unknown;
}

const tupleByteLength = (tuple: SqliteSchemaTuple): number =>
  tuple.type.length + tuple.name.length + tuple.tableName.length + 1 + (tuple.sql?.length ?? 0);

const compareBytes = (left: Buffer, right: Buffer): number => Buffer.compare(left, right);

const compareSchemaTuples = (left: SqliteSchemaTuple, right: SqliteSchemaTuple): number => {
  const type = compareBytes(left.type, right.type);
  if (type !== 0) return type;
  const name = compareBytes(left.name, right.name);
  if (name !== 0) return name;
  const tableName = compareBytes(left.tableName, right.tableName);
  if (tableName !== 0) return tableName;
  if (left.sql === null || right.sql === null) {
    if (left.sql === right.sql) return 0;
    return left.sql === null ? -1 : 1;
  }
  return compareBytes(left.sql, right.sql);
};

const sameSchemaTuple = (left: SqliteSchemaTuple, right: SqliteSchemaTuple): boolean =>
  compareSchemaTuples(left, right) === 0;

const referenceText = (value: unknown): Buffer => {
  if (typeof value !== "string") throw new TypeError("Current SQLite reference schema is invalid.");
  return Buffer.from(value, "utf8");
};

const buildCurrentSqliteSchemaReference = (): SqliteSchemaReference => {
  const database = new Database(":memory:");
  try {
    database.exec(currentSqliteSchemaSql);
    const rows = database.prepare(`SELECT type, name, tbl_name AS tableName, sql
      FROM sqlite_schema`).all() as ReferenceSchemaRow[];
    if (rows.length === 0) throw new TypeError("Current SQLite reference schema is empty.");
    const tuples = rows.map((row): SqliteSchemaTuple => Object.freeze({
      type: referenceText(row.type),
      name: referenceText(row.name),
      tableName: referenceText(row.tableName),
      sql: row.sql === null ? null : referenceText(row.sql),
    })).sort(compareSchemaTuples);
    let maximumTypeBytes = 0;
    let maximumNameBytes = 0;
    let maximumTableNameBytes = 0;
    let maximumSqlBytes = 0;
    let totalTupleBytes = 0;
    for (const tuple of tuples) {
      maximumTypeBytes = Math.max(maximumTypeBytes, tuple.type.length);
      maximumNameBytes = Math.max(maximumNameBytes, tuple.name.length);
      maximumTableNameBytes = Math.max(maximumTableNameBytes, tuple.tableName.length);
      maximumSqlBytes = Math.max(maximumSqlBytes, tuple.sql?.length ?? 0);
      totalTupleBytes += tupleByteLength(tuple);
    }
    return Object.freeze({
      tuples: Object.freeze(tuples),
      rowCount: tuples.length,
      maximumTypeBytes,
      maximumNameBytes,
      maximumTableNameBytes,
      maximumSqlBytes,
      totalTupleBytes,
    });
  } finally {
    database.close();
  }
};

let currentSqliteSchemaReference: SqliteSchemaReference | undefined;

const getCurrentSqliteSchemaReference = (): SqliteSchemaReference => {
  currentSqliteSchemaReference ??= buildCurrentSqliteSchemaReference();
  return currentSqliteSchemaReference;
};

const candidateTextBytes = (value: unknown): Buffer => {
  if (!Buffer.isBuffer(value)) throw new TypeError("SQLite schema byte projection is invalid.");
  return value;
};

const readCandidateSqliteSchema = (
  database: Database.Database,
  reference: SqliteSchemaReference,
): readonly SqliteSchemaTuple[] | undefined => {
  const rows = database.prepare(`SELECT
      typeof(type) AS typeStorage,
      substr(CAST(type AS BLOB), 1, ?) AS typeBytes,
      typeof(name) AS nameStorage,
      substr(CAST(name AS BLOB), 1, ?) AS nameBytes,
      typeof(tbl_name) AS tableNameStorage,
      substr(CAST(tbl_name AS BLOB), 1, ?) AS tableNameBytes,
      typeof(sql) AS sqlStorage,
      CASE WHEN sql IS NULL THEN NULL ELSE substr(CAST(sql AS BLOB), 1, ?) END AS sqlBytes
    FROM sqlite_schema
    LIMIT ?`).iterate(
      reference.maximumTypeBytes + 1,
      reference.maximumNameBytes + 1,
      reference.maximumTableNameBytes + 1,
      reference.maximumSqlBytes + 1,
      reference.rowCount + 1,
    ) as IterableIterator<CandidateSchemaRow>;
  const tuples: SqliteSchemaTuple[] = [];
  let totalTupleBytes = 0;
  for (const row of rows) {
    if (tuples.length === reference.rowCount) return undefined;
    if (
      row.typeStorage !== "text" || row.nameStorage !== "text" ||
      row.tableNameStorage !== "text" ||
      (row.sqlStorage !== "null" && row.sqlStorage !== "text")
    ) return undefined;
    const type = candidateTextBytes(row.typeBytes);
    const name = candidateTextBytes(row.nameBytes);
    const tableName = candidateTextBytes(row.tableNameBytes);
    const sql = row.sqlStorage === "null" ? null : candidateTextBytes(row.sqlBytes);
    if (
      type.length > reference.maximumTypeBytes ||
      name.length > reference.maximumNameBytes ||
      tableName.length > reference.maximumTableNameBytes ||
      (sql?.length ?? 0) > reference.maximumSqlBytes
    ) return undefined;
    const tuple = Object.freeze({ type, name, tableName, sql });
    totalTupleBytes += tupleByteLength(tuple);
    if (totalTupleBytes > reference.totalTupleBytes) return undefined;
    tuples.push(tuple);
  }
  if (tuples.length !== reference.rowCount) return undefined;
  return Object.freeze(tuples.sort(compareSchemaTuples));
};

export const hasExactCurrentSqliteStructure = (database: Database.Database): boolean => {
  const reference = getCurrentSqliteSchemaReference();
  const candidate = readCandidateSqliteSchema(database, reference);
  return candidate !== undefined && candidate.every((tuple, index) => {
    const expected = reference.tuples[index];
    return expected !== undefined && sameSchemaTuple(tuple, expected);
  });
};
