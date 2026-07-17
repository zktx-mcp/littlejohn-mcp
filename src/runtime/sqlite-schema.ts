import { walletConnectionStatusDefinitions } from "../core/index.js";
import {
  runtimeConfigurationMacByteLength,
  runtimeIdentifierEncodedLength,
  runtimeProtocolVersion,
} from "./runtime-identity.js";
import { walletConnectionFieldPresenceCheckSql } from "./wallet-connection-storage.js";

const sqlIdentifierPattern = /^[a-z][a-z0-9_]*$/u;

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

export const canonicalRuntimeIdentifierSqlCheck = (columnInput: string): string => {
  const column = sqlColumn(columnInput);
  return `(${canonicalSqlTextCheck(column)} AND length(${column}) = ${runtimeIdentifierEncodedLength} AND ` +
    `${column} NOT GLOB '*[^A-Za-z0-9_-]*' AND substr(${column}, ${runtimeIdentifierEncodedLength}, 1) GLOB '[AQgw]')`;
};

export const canonicalRuntimeConfigurationMacSqlCheck = (columnInput: string): string => {
  const column = sqlColumn(columnInput);
  const encodedLength = Math.ceil(runtimeConfigurationMacByteLength * 4 / 3);
  return `(${canonicalSqlTextCheck(column)} AND length(${column}) = ${encodedLength} AND ` +
    `${column} NOT GLOB '*[^A-Za-z0-9_-]*' AND substr(${column}, ${encodedLength}, 1) GLOB '[AEIMQUYcgkosw048]')`;
};

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

const walletStatuses = Object.freeze(Object.keys(walletConnectionStatusDefinitions));

export const currentSqliteTableNames = Object.freeze([
  "chain",
  "contract",
  "current_wallet_connection",
  "local_profile",
  "runtime_owner",
  "token_contract",
  "wallet_account",
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
  protocol_version INTEGER NOT NULL CHECK (protocol_version = ${runtimeProtocolVersion}),
  process_id INTEGER NOT NULL CHECK (process_id > 0),
  owner_revision TEXT NOT NULL CHECK (${canonicalUnsignedDecimalSqlCheck("owner_revision")}),
  acquired_at TEXT NOT NULL CHECK (${canonicalSqlTextCheck("acquired_at")}),
  FOREIGN KEY (profile_id) REFERENCES local_profile(profile_id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;
CREATE TABLE chain (
  chain_id TEXT NOT NULL PRIMARY KEY CHECK (${canonicalEvmChainIdSqlCheck("chain_id")})
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
CREATE TABLE wallet_account (
  profile_id TEXT NOT NULL CHECK (${canonicalSqlTextCheck("profile_id")}),
  chain_id TEXT NOT NULL CHECK (${canonicalEvmChainIdSqlCheck("chain_id")}),
  wallet_address TEXT NOT NULL CHECK (${canonicalEvmAddressSqlCheck("wallet_address")}),
  PRIMARY KEY (profile_id, chain_id, wallet_address),
  FOREIGN KEY (profile_id) REFERENCES local_profile(profile_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (chain_id) REFERENCES chain(chain_id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;
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
