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
import {
  runtimeConfigurationMacByteLength,
  runtimeIdentifierByteLength,
} from "./runtime-identity.js";
import { walletConnectionFieldPresenceCheckSql } from "./wallet-connection-storage.js";

const sqlIdentifierPattern = /^[a-z][a-z0-9_]*$/u;
const base64UrlAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export const databaseSchemaVersion = 9 as const;

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

export const currentSqliteTableNames = Object.freeze([
  "chain",
  "contract",
  "current_wallet_connection",
  "local_profile",
  "reference_feed_round",
  "reference_feed_sync_state",
  "reference_pair_watchlist_entry",
  "reference_pair_watchlist_state",
  "robinhood_asset",
  "robinhood_asset_snapshot",
  "runtime_owner",
  "token_contract",
  "token_contract_inspection",
  "wallet_account",
  "wallet_token_selection",
  "wallet_token_selection_state",
] as const);

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
  protocol_version INTEGER NOT NULL CHECK (protocol_version BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}),
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
  status TEXT NOT NULL CHECK (${canonicalSqlTextCheck("status")} AND status IN (${sqlStringList(walletStatuses)})),
  reason TEXT CHECK (reason IS NULL OR ${canonicalSqlTextCheck("reason")}),
  chain_id TEXT CHECK (chain_id IS NULL OR ${canonicalEvmChainIdSqlCheck("chain_id")}),
  wallet_address TEXT CHECK (wallet_address IS NULL OR ${canonicalEvmAddressSqlCheck("wallet_address")}),
  approved_methods_json TEXT CHECK (approved_methods_json IS NULL OR ${canonicalSqlTextCheck("approved_methods_json")}),
  approved_events_json TEXT CHECK (approved_events_json IS NULL OR ${canonicalSqlTextCheck("approved_events_json")}),
  expires_at TEXT CHECK (expires_at IS NULL OR ${canonicalSqlTextCheck("expires_at")}),
  session_count TEXT CHECK (session_count IS NULL OR (${canonicalUnsignedDecimalSqlCheck("session_count")} AND session_count NOT IN ('0', '1'))),
  updated_at TEXT NOT NULL CHECK (${canonicalSqlTextCheck("updated_at")}),
  FOREIGN KEY (profile_id) REFERENCES local_profile(profile_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (profile_id, chain_id, wallet_address)
    REFERENCES wallet_account(profile_id, chain_id, wallet_address)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  ${walletConnectionFieldPresenceCheckSql}
) STRICT;`;
