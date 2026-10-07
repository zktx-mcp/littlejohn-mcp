import { lstat, opendir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { deserialize, serialize } from "node:v8";

import Database from "better-sqlite3";

import { attestOwnerOnlyStateFile } from "../runtime/paths.js";

export const walletConnectStorageDatabaseFileName = "walletconnect.sqlite3";

export const walletConnectMessageStorageKeys = Object.freeze({
  messages: "wc@2:core:0.3//messages",
  unacknowledged: "wc@2:core:0.3//messages_withoutClientAck",
});

import { walletConnectStorageLimits } from "./storage-limits.js";
// These are the restoration stores of the pinned Sign Client/Core adapter.
// Every other SDK namespace, including a new namespace, remains volatile.
const persistentSdkStorageKeys = new Set([
  "wc@2:core:0.3//keychain",
  "wc@2:core:0.3//pairing",
  "wc@2:core:0.3//subscription",
  "wc@2:core:0.3//expirer",
  "wc@2:client:0.3//session",
  "WALLETCONNECT_CLIENT_ID",
]);
const privateDirectoryMode = 0o700;
const ownerOnlyCreationMask = 0o077;
const sqliteArtifactSuffixes = Object.freeze(["", "-wal", "-shm"] as const);
const sqliteArtifactNames = new Set(sqliteArtifactSuffixes.map(
  (suffix) => `${walletConnectStorageDatabaseFileName}${suffix}`,
));

const metadataTableSql = `CREATE TABLE walletconnect_storage_metadata (
  singleton INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
  revision INTEGER NOT NULL CHECK (revision >= 0)
) STRICT, WITHOUT ROWID`;

const entryTableSql = `CREATE TABLE walletconnect_storage_entry (
  key BLOB NOT NULL PRIMARY KEY CHECK (
    typeof(key) = 'blob' AND
    instr(key, X'00') = 0 AND
    length(key) BETWEEN 1 AND ${walletConnectStorageLimits.keyBytes}
  ),
  value BLOB NOT NULL CHECK (length(value) BETWEEN 1 AND ${walletConnectStorageLimits.valueBytes})
) STRICT, WITHOUT ROWID`;

const currentSchemaRows = Object.freeze([
  Object.freeze({
    type: "table",
    name: "walletconnect_storage_entry",
    tableName: "walletconnect_storage_entry",
    sql: entryTableSql,
  }),
  Object.freeze({
    type: "table",
    name: "walletconnect_storage_metadata",
    tableName: "walletconnect_storage_metadata",
    sql: metadataTableSql,
  }),
]);

const currentSchemaSql = `${metadataTableSql};
${entryTableSql};
INSERT INTO walletconnect_storage_metadata(singleton, revision) VALUES (1, 0);`;

const unavailable = (): Error =>
  Object.freeze(new Error("WalletConnect private storage is unavailable."));

const withOwnerOnlySqliteArtifacts = <Result>(operation: () => Result): Result => {
  if (process.platform === "win32") return operation();
  const previousMask = process.umask(ownerOnlyCreationMask);
  try {
    return operation();
  } finally {
    process.umask(previousMask);
  }
};

const validKey = (key: unknown): key is string => {
  if (
    typeof key !== "string" || key.length === 0 || key.length > walletConnectStorageLimits.keyBytes ||
    key.includes("\0")
  ) return false;
  const encoded = Buffer.from(key, "utf8");
  return encoded.length <= walletConnectStorageLimits.keyBytes && encoded.toString("utf8") === key;
};

const encodeKey = (key: unknown): Buffer => {
  if (!validKey(key)) throw unavailable();
  return Buffer.from(key, "utf8");
};

const decodeKey = (value: unknown): string => {
  if (!Buffer.isBuffer(value) || value.length < 1 || value.length > walletConnectStorageLimits.keyBytes) {
    throw unavailable();
  }
  const key = value.toString("utf8");
  if (!validKey(key) || !Buffer.from(key, "utf8").equals(value)) throw unavailable();
  return key;
};

const parseRevision = (value: unknown): bigint => {
  if (typeof value !== "bigint" || value < 0n || value > walletConnectStorageLimits.revision) {
    throw unavailable();
  }
  return value;
};

interface SchemaRow {
  readonly type: unknown;
  readonly name: unknown;
  readonly tableName: unknown;
  readonly sql: unknown;
}

interface SchemaBytes {
  readonly type: Buffer;
  readonly name: Buffer;
  readonly tableName: Buffer;
  readonly sql: Buffer;
}

interface StoredSchemaRow extends SchemaRow {
  readonly typeStorage: unknown;
  readonly nameStorage: unknown;
  readonly tableNameStorage: unknown;
  readonly sqlStorage: unknown;
}

interface MetadataRow {
  readonly singleton: unknown;
  readonly revision: unknown;
}

interface EntryRow {
  readonly key: unknown;
  readonly value: unknown;
}

interface EntryStatsRow {
  readonly entryCount: unknown;
  readonly totalValueBytes: unknown;
}

interface StoredEntryAdmissionRow {
  readonly keyStorageClass: unknown;
  readonly keyBytes: unknown;
  readonly keyPrefix: unknown;
  readonly valueStorageClass: unknown;
  readonly valueBytes: unknown;
}

interface ExistingValueRow {
  readonly valueBytes: unknown;
}

const equalSchemaRow = (
  actual: SchemaRow,
  expected: SchemaBytes,
): boolean => Buffer.isBuffer(actual.type) && actual.type.equals(expected.type) &&
  Buffer.isBuffer(actual.name) && actual.name.equals(expected.name) &&
  Buffer.isBuffer(actual.tableName) && actual.tableName.equals(expected.tableName) &&
  Buffer.isBuffer(actual.sql) && actual.sql.equals(expected.sql);

const inspectCurrentStructure = (database: Database.Database): void => {
  // Encode trusted references on this connection so existing database encodings
  // keep their exact meaning without decoding an untrusted partial prefix.
  const encodeReference = database.prepare(`SELECT CAST(? AS BLOB) AS type,
    CAST(? AS BLOB) AS name, CAST(? AS BLOB) AS tableName, CAST(? AS BLOB) AS sql`);
  const reference = currentSchemaRows.map((tuple): SchemaBytes => {
    const row = encodeReference.get(tuple.type, tuple.name, tuple.tableName, tuple.sql) as SchemaRow;
    if (!Buffer.isBuffer(row.type) || !Buffer.isBuffer(row.name) ||
      !Buffer.isBuffer(row.tableName) || !Buffer.isBuffer(row.sql)) throw unavailable();
    return { type: row.type, name: row.name, tableName: row.tableName, sql: row.sql };
  });
  const rows = database.prepare(`SELECT
      typeof(type) AS typeStorage, substr(CAST(type AS BLOB), 1, ?) AS type,
      typeof(name) AS nameStorage, substr(CAST(name AS BLOB), 1, ?) AS name,
      typeof(tbl_name) AS tableNameStorage, substr(CAST(tbl_name AS BLOB), 1, ?) AS tableName,
      typeof(sql) AS sqlStorage, substr(CAST(sql AS BLOB), 1, ?) AS sql
    FROM sqlite_schema
    WHERE name NOT GLOB 'sqlite_*'
    LIMIT ?`).all(
      Math.max(...reference.map((row) => row.type.length)) + 1,
      Math.max(...reference.map((row) => row.name.length)) + 1,
      Math.max(...reference.map((row) => row.tableName.length)) + 1,
      Math.max(...reference.map((row) => row.sql.length)) + 1,
      reference.length + 1,
    ) as StoredSchemaRow[];
  if (
    rows.length !== reference.length ||
    rows.some((row) => row.typeStorage !== "text" || row.nameStorage !== "text" ||
      row.tableNameStorage !== "text" || row.sqlStorage !== "text" ||
      !reference.some((expected) => equalSchemaRow(row, expected))) ||
    reference.some((expected) =>
      rows.filter((row) => equalSchemaRow(row, expected)).length !== 1)
  ) throw unavailable();

  const metadata = database.prepare(`SELECT
      CASE WHEN typeof(singleton) = 'integer' THEN singleton END AS singleton,
      CASE WHEN typeof(revision) = 'integer' THEN revision END AS revision
    FROM walletconnect_storage_metadata LIMIT 2`).safeIntegers().all() as MetadataRow[];
  if (
    metadata.length !== 1 ||
    metadata[0]?.singleton !== 1n
  ) throw unavailable();
  parseRevision(metadata[0].revision);

  const entries = database.prepare(`SELECT typeof(key) AS keyStorageClass,
      CASE WHEN typeof(key) = 'blob' THEN length(key) END AS keyBytes,
      CASE WHEN typeof(key) = 'blob' THEN
        CASE WHEN length(key) BETWEEN 1 AND ${walletConnectStorageLimits.keyBytes}
          THEN substr(key, 1, ${walletConnectStorageLimits.keyBytes + 1}) END
      END AS keyPrefix,
      typeof(value) AS valueStorageClass,
      CASE WHEN typeof(value) = 'blob' THEN length(value) END AS valueBytes
    FROM walletconnect_storage_entry
    LIMIT ${walletConnectStorageLimits.keys + 1}`).safeIntegers().iterate() as IterableIterator<StoredEntryAdmissionRow>;
  const admittedKeys = new Set<string>();
  let admittedCount = 0;
  let admittedValueBytes = 0n;
  for (const row of entries) {
    admittedCount += 1;
    if (
      admittedCount > walletConnectStorageLimits.keys || row.keyStorageClass !== "blob" ||
      typeof row.keyBytes !== "bigint" || row.keyBytes < 1n ||
      row.keyBytes > BigInt(walletConnectStorageLimits.keyBytes) || !Buffer.isBuffer(row.keyPrefix) ||
      BigInt(row.keyPrefix.length) !== row.keyBytes || row.valueStorageClass !== "blob" ||
      typeof row.valueBytes !== "bigint" || row.valueBytes < 1n ||
      row.valueBytes > BigInt(walletConnectStorageLimits.valueBytes)
    ) throw unavailable();
    const key = decodeKey(row.keyPrefix);
    if (!persistentSdkStorageKeys.has(key) || admittedKeys.has(key)) throw unavailable();
    admittedKeys.add(key);
    admittedValueBytes += row.valueBytes;
    if (admittedValueBytes > BigInt(walletConnectStorageLimits.aggregateValueBytes)) throw unavailable();
  }
};

const configureCommon = (database: Database.Database): void => {
  database.pragma(`busy_timeout = ${walletConnectStorageLimits.busyTimeoutMilliseconds}`);
  if (database.pragma("busy_timeout", { simple: true }) !==
    walletConnectStorageLimits.busyTimeoutMilliseconds) throw unavailable();
  database.pragma("locking_mode = EXCLUSIVE");
  if (database.pragma("locking_mode", { simple: true }) !== "exclusive") throw unavailable();
  database.pragma("synchronous = FULL");
  if (database.pragma("synchronous", { simple: true }) !== 2) throw unavailable();
  if (process.platform === "darwin") {
    database.pragma("fullfsync = ON");
    if (database.pragma("fullfsync", { simple: true }) !== 1) throw unavailable();
  }
};

const configureFresh = (database: Database.Database): void => {
  configureCommon(database);
  if (database.pragma("journal_mode = WAL", { simple: true }) !== "wal") throw unavailable();
  database.exec("BEGIN EXCLUSIVE");
  try {
    database.exec(currentSchemaSql);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* Preserve the first failure. */ }
    throw error;
  }
};

const configureExisting = (database: Database.Database): void => {
  configureCommon(database);
  if (database.pragma("journal_mode", { simple: true }) !== "wal") throw unavailable();
  database.exec("BEGIN EXCLUSIVE");
  try {
    inspectCurrentStructure(database);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* Preserve the first failure. */ }
    throw error;
  }
};

const inspectExistingWithoutMutation = (path: string): void =>
  withOwnerOnlySqliteArtifacts(() => {
    const database = new Database(path, {
      readonly: true, fileMustExist: true, timeout: walletConnectStorageLimits.busyTimeoutMilliseconds,
    });
    let firstFailure: unknown;
    try {
      if (database.pragma("journal_mode", { simple: true }) !== "wal") throw unavailable();
      inspectCurrentStructure(database);
    } catch (error) {
      firstFailure = error;
    }
    try {
      database.close();
    } catch (error) {
      firstFailure ??= error;
    }
    if (firstFailure !== undefined) throw firstFailure;
  });

const inspectWalletConnectArtifactSet = async (
  privateStoreDirectory: string,
): Promise<"existing" | "fresh"> => {
  const directory = await lstat(privateStoreDirectory);
  if (directory.isSymbolicLink() || !directory.isDirectory()) throw unavailable();
  if (process.platform !== "win32") {
    if (typeof process.getuid === "function" && directory.uid !== process.getuid()) {
      throw unavailable();
    }
    if ((directory.mode & 0o777) !== privateDirectoryMode) throw unavailable();
  }

  const present = new Set<string>();
  for await (const entry of await opendir(privateStoreDirectory)) {
    if (present.size >= sqliteArtifactNames.size || !sqliteArtifactNames.has(entry.name)) {
      throw unavailable();
    }
    await attestOwnerOnlyStateFile(resolve(privateStoreDirectory, entry.name));
    present.add(entry.name);
  }

  const main = present.has(walletConnectStorageDatabaseFileName);
  if (!main && present.size !== 0) throw unavailable();
  return main ? "existing" : "fresh";
};

const openConfiguredDatabase = (
  path: string,
  fresh: boolean,
): Database.Database => withOwnerOnlySqliteArtifacts(() => {
  let opened: Database.Database | undefined;
  try {
    opened = new Database(path, {
      ...(fresh ? {} : { fileMustExist: true }),
      timeout: walletConnectStorageLimits.busyTimeoutMilliseconds,
    });
    if (fresh) configureFresh(opened);
    else configureExisting(opened);
    return opened;
  } catch (error) {
    try { opened?.close(); } catch { /* Preserve the configuration failure. */ }
    throw error;
  }
});

export interface WalletConnectSdkStorage {
  getKeys(): Promise<string[]>;
  getEntries<Value = unknown>(): Promise<[string, Value][]>;
  getItem<Value = unknown>(key: string): Promise<Value | undefined>;
  setItem<Value = unknown>(key: string, value: Value): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface WalletConnectStorageOwner {
  readonly storage: WalletConnectSdkStorage;
  checkpoint(): bigint;
  close(): void;
}

class WalletConnectStorage implements WalletConnectStorageOwner {
  readonly storage: WalletConnectSdkStorage;

  private readonly database: Database.Database;
  private readonly readRevisionStatement: Database.Statement;
  private readonly readKeysStatement: Database.Statement;
  private readonly readEntriesStatement: Database.Statement;
  private readonly readItemStatement: Database.Statement;
  private readonly readStatsStatement: Database.Statement;
  private readonly readExistingValueStatement: Database.Statement;
  private readonly writeItemStatement: Database.Statement;
  private readonly removeItemStatement: Database.Statement;
  private readonly writeRevisionStatement: Database.Statement;
  private readonly writeItemTransaction: (key: Buffer, value: Buffer) => void;
  private readonly removeItemTransaction: (key: Buffer) => void;

  private admissionOpen = true;
  private databaseClosed = false;
  private firstFailure: Error | undefined;
  private readonly volatile = new Map<string, Buffer>();
  private volatileBytes = 0;
  private volatileRevision = 0n;

  constructor(database: Database.Database) {
    this.database = database;
    this.readRevisionStatement = database.prepare(`SELECT revision
      FROM walletconnect_storage_metadata WHERE singleton = 1`).safeIntegers();
    this.readKeysStatement = database.prepare(`SELECT key
      FROM walletconnect_storage_entry ORDER BY key`);
    this.readEntriesStatement = database.prepare(`SELECT key, value
      FROM walletconnect_storage_entry ORDER BY key`);
    this.readItemStatement = database.prepare(`SELECT value
      FROM walletconnect_storage_entry WHERE key = ?`);
    this.readStatsStatement = database.prepare(`SELECT count(*) AS entryCount,
        coalesce(sum(length(value)), 0) AS totalValueBytes
      FROM walletconnect_storage_entry`);
    this.readExistingValueStatement = database.prepare(`SELECT length(value) AS valueBytes
      FROM walletconnect_storage_entry WHERE key = ?`);
    this.writeItemStatement = database.prepare(`INSERT INTO walletconnect_storage_entry(key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
    this.removeItemStatement = database.prepare(`DELETE FROM walletconnect_storage_entry
      WHERE key = ?`);
    this.writeRevisionStatement = database.prepare(`UPDATE walletconnect_storage_metadata
      SET revision = ? WHERE singleton = 1`);

    this.writeItemTransaction = database.transaction((key: Buffer, value: Buffer): void => {
      const existing = this.readExistingValueStatement.get(key) as ExistingValueRow | undefined;
      if (existing !== undefined && (
        typeof existing.valueBytes !== "number" ||
        !Number.isSafeInteger(existing.valueBytes) ||
        existing.valueBytes < 1 ||
        existing.valueBytes > walletConnectStorageLimits.valueBytes
      )) throw unavailable();
      this.assertWriteCapacity(existing?.valueBytes as number | undefined, value.length);
      this.writeItemStatement.run(key, value);
      this.advanceRevision();
    });
    this.removeItemTransaction = database.transaction((key: Buffer): void => {
      const result = this.removeItemStatement.run(key);
      if (result.changes !== 0) this.advanceRevision();
    });

    this.storage = Object.freeze({
      getKeys: () => this.sdkOperation(() => this.readKeys()),
      getEntries: <Value = unknown>() =>
        this.sdkOperation(() => this.readEntries<Value>()),
      getItem: <Value = unknown>(key: string) =>
        this.sdkOperation(() => this.readItem<Value>(key)),
      setItem: <Value = unknown>(key: string, value: Value) =>
        this.sdkOperation(() => this.writeItem(key, value)),
      removeItem: (key: string) => this.sdkOperation(() => this.removeItem(key)),
    });
  }

  checkpoint(): bigint {
    try {
      this.assertAdmission();
      return this.readCheckpoint();
    } catch {
      throw this.latchFailure();
    }
  }

  close(): void {
    this.admissionOpen = false;
    this.volatile.clear();
    this.volatileBytes = 0;
    if (!this.databaseClosed) {
      try {
        this.database.close();
        this.databaseClosed = true;
      } catch {
        this.latchFailure();
      }
    }
    if (this.firstFailure !== undefined) throw this.firstFailure;
  }

  private assertAdmission(): void {
    if (!this.admissionOpen || this.databaseClosed || this.firstFailure !== undefined) {
      throw unavailable();
    }
  }

  private latchFailure(): Error {
    this.firstFailure ??= unavailable();
    return this.firstFailure;
  }

  private sdkOperation<Result>(operation: () => Result): Promise<Result> {
    try {
      this.assertAdmission();
      return Promise.resolve(operation());
    } catch {
      return Promise.reject(this.latchFailure());
    }
  }

  private readRevision(): bigint {
    const rows = this.readRevisionStatement.all() as { readonly revision: unknown }[];
    if (rows.length !== 1) throw unavailable();
    return parseRevision(rows[0]?.revision);
  }

  private advanceRevision(): void {
    if (this.readCheckpoint() >= walletConnectStorageLimits.revision) throw unavailable();
    const next = this.readRevision() + 1n;
    if (next > walletConnectStorageLimits.revision) throw unavailable();
    const result = this.writeRevisionStatement.run(next);
    if (result.changes !== 1) throw unavailable();
  }

  private readCheckpoint(): bigint {
    return parseRevision(this.readRevision() + this.volatileRevision);
  }

  private advanceVolatileRevision(): void {
    if (this.readCheckpoint() >= walletConnectStorageLimits.revision) throw unavailable();
    this.volatileRevision += 1n;
  }

  private readStats(): { readonly entryCount: number; readonly totalValueBytes: number } {
    const row = this.readStatsStatement.get() as EntryStatsRow | undefined;
    if (
      row === undefined ||
      typeof row.entryCount !== "number" ||
      !Number.isSafeInteger(row.entryCount) ||
      row.entryCount < 0 ||
      row.entryCount > walletConnectStorageLimits.keys ||
      typeof row.totalValueBytes !== "number" ||
      !Number.isSafeInteger(row.totalValueBytes) ||
      row.totalValueBytes < 0 ||
      row.totalValueBytes > walletConnectStorageLimits.aggregateValueBytes
    ) throw unavailable();
    return Object.freeze({
      entryCount: row.entryCount,
      totalValueBytes: row.totalValueBytes,
    });
  }

  private readCombinedStats(): { readonly entryCount: number; readonly totalValueBytes: number } {
    const stored = this.readStats();
    const entryCount = stored.entryCount + this.volatile.size;
    const totalValueBytes = stored.totalValueBytes + this.volatileBytes;
    if (entryCount > walletConnectStorageLimits.keys ||
        !Number.isSafeInteger(totalValueBytes) ||
        totalValueBytes > walletConnectStorageLimits.aggregateValueBytes) throw unavailable();
    return { entryCount, totalValueBytes };
  }

  private assertWriteCapacity(previousBytes: number | undefined, valueBytes: number): void {
    const stats = this.readCombinedStats();
    const total = stats.totalValueBytes - (previousBytes ?? 0) + valueBytes;
    if ((previousBytes === undefined && stats.entryCount >= walletConnectStorageLimits.keys) ||
        !Number.isSafeInteger(total) || total > walletConnectStorageLimits.aggregateValueBytes) throw unavailable();
  }

  private readKeys(): string[] {
    const rows = this.readKeysStatement.all() as { readonly key: unknown }[];
    if (rows.length > walletConnectStorageLimits.keys) throw unavailable();
    this.readCombinedStats();
    return [...rows.map((row) => decodeKey(row.key)), ...this.volatile.keys()]
      .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  }

  private readEntries<Value>(): [string, Value][] {
    const rows = this.readEntriesStatement.all() as EntryRow[];
    if (rows.length > walletConnectStorageLimits.keys) throw unavailable();
    this.readCombinedStats();
    const stored: [string, Value][] = rows.map((row) => {
      if (!Buffer.isBuffer(row.value)) throw unavailable();
      return [decodeKey(row.key), this.decode<Value>(row.value)];
    });
    const entries: [string, Value][] = [
      ...stored, ...Array.from(this.volatile, ([key, value]): [string, Value] => [key, this.decode<Value>(value)]),
    ];
    return entries.sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  }

  private readItem<Value>(key: string): Value | undefined {
    const encodedKey = encodeKey(key);
    if (!persistentSdkStorageKeys.has(key)) {
      const value = this.volatile.get(key);
      return value === undefined ? undefined : this.decode<Value>(value);
    }
    const row = this.readItemStatement.get(encodedKey) as
      { readonly value: unknown } | undefined;
    if (row === undefined) return undefined;
    if (!Buffer.isBuffer(row.value)) throw unavailable();
    return this.decode<Value>(row.value);
  }

  private writeItem<Value>(key: string, value: Value): void {
    const encodedKey = encodeKey(key);
    let encoded: Buffer;
    try {
      encoded = serialize(value);
    } catch {
      throw unavailable();
    }
    this.assertAdmission();
    if (encoded.length < 1 || encoded.length > walletConnectStorageLimits.valueBytes) throw unavailable();
    if (persistentSdkStorageKeys.has(key)) {
      this.writeItemTransaction(encodedKey, encoded);
      return;
    }
    const previous = this.volatile.get(key);
    this.assertWriteCapacity(previous?.length, encoded.length);
    this.advanceVolatileRevision();
    this.volatile.set(key, encoded);
    this.volatileBytes += encoded.length - (previous?.length ?? 0);
  }

  private removeItem(key: string): void {
    const encoded = encodeKey(key);
    if (persistentSdkStorageKeys.has(key)) {
      this.removeItemTransaction(encoded);
      return;
    }
    const previous = this.volatile.get(key);
    if (previous === undefined) return;
    this.advanceVolatileRevision();
    this.volatile.delete(key);
    this.volatileBytes -= previous.length;
  }

  private decode<Value>(value: Buffer): Value {
    if (value.length < 1 || value.length > walletConnectStorageLimits.valueBytes) throw unavailable();
    try {
      return deserialize(value) as Value;
    } catch {
      throw unavailable();
    }
  }
}

export const openWalletConnectStorage = async (
  privateStoreDirectory: string,
): Promise<WalletConnectStorageOwner> => {
  if (!isAbsolute(privateStoreDirectory) || privateStoreDirectory.includes("\0")) {
    throw unavailable();
  }
  const path = resolve(privateStoreDirectory, walletConnectStorageDatabaseFileName);
  let database: Database.Database | undefined;
  try {
    const fresh = await inspectWalletConnectArtifactSet(privateStoreDirectory) === "fresh";
    if (!fresh) inspectExistingWithoutMutation(path);
    database = openConfiguredDatabase(path, fresh);
    if (await inspectWalletConnectArtifactSet(privateStoreDirectory) !== "existing") {
      throw unavailable();
    }
    const owner = new WalletConnectStorage(database);
    return Object.freeze({
      storage: owner.storage,
      checkpoint: () => owner.checkpoint(),
      close: () => owner.close(),
    });
  } catch {
    if (database !== undefined) {
      try { database.close(); } catch { /* Preserve the fixed boundary failure. */ }
    }
    throw unavailable();
  }
};
