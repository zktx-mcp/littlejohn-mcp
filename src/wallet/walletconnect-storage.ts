import { lstat, opendir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { deserialize, serialize } from "node:v8";

import Database from "better-sqlite3";

import { attestOwnerOnlyStateFile } from "../runtime/paths.js";

export const walletConnectStorageDatabaseFileName = "walletconnect.sqlite3";

const maximumKeyCount = 4_096;
const maximumKeyBytes = 4_096;
const maximumValueBytes = 16 * 1024 * 1024;
const maximumTotalValueBytes = 128 * 1024 * 1024;
const maximumRevision = (1n << 63n) - 1n;
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
    length(key) BETWEEN 1 AND ${maximumKeyBytes}
  ),
  value BLOB NOT NULL CHECK (length(value) BETWEEN 1 AND ${maximumValueBytes})
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
    typeof key !== "string" || key.length === 0 || key.length > maximumKeyBytes ||
    key.includes("\0")
  ) return false;
  const encoded = Buffer.from(key, "utf8");
  return encoded.length <= maximumKeyBytes && encoded.toString("utf8") === key;
};

const encodeKey = (key: unknown): Buffer => {
  if (!validKey(key)) throw unavailable();
  return Buffer.from(key, "utf8");
};

const decodeKey = (value: unknown): string => {
  if (!Buffer.isBuffer(value) || value.length < 1 || value.length > maximumKeyBytes) {
    throw unavailable();
  }
  const key = value.toString("utf8");
  if (!validKey(key) || !Buffer.from(key, "utf8").equals(value)) throw unavailable();
  return key;
};

const parseRevision = (value: unknown): bigint => {
  if (typeof value !== "bigint" || value < 0n || value > maximumRevision) {
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
  expected: (typeof currentSchemaRows)[number],
): boolean => actual.type === expected.type && actual.name === expected.name &&
  actual.tableName === expected.tableName && actual.sql === expected.sql;

const inspectCurrentStructure = (database: Database.Database): void => {
  const rows = database.prepare(`SELECT type, name, tbl_name AS tableName, sql
    FROM sqlite_schema
    WHERE name NOT GLOB 'sqlite_*'
    LIMIT ${currentSchemaRows.length + 1}`).all() as SchemaRow[];
  if (
    rows.length !== currentSchemaRows.length ||
    rows.some((row) => !currentSchemaRows.some((expected) => equalSchemaRow(row, expected))) ||
    currentSchemaRows.some((expected) =>
      rows.filter((row) => equalSchemaRow(row, expected)).length !== 1)
  ) throw unavailable();

  const metadata = database.prepare(`SELECT singleton, revision
    FROM walletconnect_storage_metadata LIMIT 2`).safeIntegers().all() as MetadataRow[];
  if (
    metadata.length !== 1 ||
    metadata[0]?.singleton !== 1n
  ) throw unavailable();
  parseRevision(metadata[0].revision);

  const entries = database.prepare(`SELECT typeof(key) AS keyStorageClass,
      CASE WHEN typeof(key) = 'blob' THEN length(key) END AS keyBytes,
      CASE WHEN typeof(key) = 'blob' THEN
        CASE WHEN length(key) BETWEEN 1 AND ${maximumKeyBytes}
          THEN substr(key, 1, ${maximumKeyBytes + 1}) END
      END AS keyPrefix,
      typeof(value) AS valueStorageClass,
      CASE WHEN typeof(value) = 'blob' THEN length(value) END AS valueBytes
    FROM walletconnect_storage_entry
    LIMIT ${maximumKeyCount + 1}`).safeIntegers().iterate() as IterableIterator<StoredEntryAdmissionRow>;
  const admittedKeys = new Set<string>();
  let admittedCount = 0;
  let admittedValueBytes = 0n;
  for (const row of entries) {
    admittedCount += 1;
    if (
      admittedCount > maximumKeyCount || row.keyStorageClass !== "blob" ||
      typeof row.keyBytes !== "bigint" || row.keyBytes < 1n ||
      row.keyBytes > BigInt(maximumKeyBytes) || !Buffer.isBuffer(row.keyPrefix) ||
      BigInt(row.keyPrefix.length) !== row.keyBytes || row.valueStorageClass !== "blob" ||
      typeof row.valueBytes !== "bigint" || row.valueBytes < 1n ||
      row.valueBytes > BigInt(maximumValueBytes)
    ) throw unavailable();
    const key = decodeKey(row.keyPrefix);
    if (admittedKeys.has(key)) throw unavailable();
    admittedKeys.add(key);
    admittedValueBytes += row.valueBytes;
    if (admittedValueBytes > BigInt(maximumTotalValueBytes)) throw unavailable();
  }
};

const configureCommon = (database: Database.Database): void => {
  database.pragma("busy_timeout = 5000");
  if (database.pragma("busy_timeout", { simple: true }) !== 5_000) throw unavailable();
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
    const database = new Database(path, { readonly: true, fileMustExist: true, timeout: 5_000 });
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
      timeout: 5_000,
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
  seal(expectedRevision: bigint): void;
  close(): void;
}

class SqliteWalletConnectStorageOwner implements WalletConnectStorageOwner {
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
      const stats = this.readStats();
      const existing = this.readExistingValueStatement.get(key) as ExistingValueRow | undefined;
      if (existing !== undefined && (
        typeof existing.valueBytes !== "number" ||
        !Number.isSafeInteger(existing.valueBytes) ||
        existing.valueBytes < 1 ||
        existing.valueBytes > maximumValueBytes
      )) throw unavailable();
      if (existing === undefined && stats.entryCount >= maximumKeyCount) throw unavailable();
      const total = stats.totalValueBytes - (existing?.valueBytes as number | undefined ?? 0) +
        value.length;
      if (!Number.isSafeInteger(total) || total > maximumTotalValueBytes) throw unavailable();
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
      return this.readRevision();
    } catch {
      throw this.latchFailure();
    }
  }

  seal(expectedRevision: bigint): void {
    this.admissionOpen = false;
    try {
      if (this.databaseClosed || this.firstFailure !== undefined) throw unavailable();
      if (typeof expectedRevision !== "bigint" || expectedRevision < 0n) throw unavailable();
      if (this.readRevision() !== expectedRevision) throw unavailable();
    } catch {
      throw this.latchFailure();
    }
  }

  close(): void {
    this.admissionOpen = false;
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
    const next = this.readRevision() + 1n;
    if (next > maximumRevision) throw unavailable();
    const result = this.writeRevisionStatement.run(next);
    if (result.changes !== 1) throw unavailable();
  }

  private readStats(): { readonly entryCount: number; readonly totalValueBytes: number } {
    const row = this.readStatsStatement.get() as EntryStatsRow | undefined;
    if (
      row === undefined ||
      typeof row.entryCount !== "number" ||
      !Number.isSafeInteger(row.entryCount) ||
      row.entryCount < 0 ||
      row.entryCount > maximumKeyCount ||
      typeof row.totalValueBytes !== "number" ||
      !Number.isSafeInteger(row.totalValueBytes) ||
      row.totalValueBytes < 0 ||
      row.totalValueBytes > maximumTotalValueBytes
    ) throw unavailable();
    return Object.freeze({
      entryCount: row.entryCount,
      totalValueBytes: row.totalValueBytes,
    });
  }

  private readKeys(): string[] {
    const rows = this.readKeysStatement.all() as { readonly key: unknown }[];
    if (rows.length > maximumKeyCount) throw unavailable();
    return rows.map((row) => decodeKey(row.key));
  }

  private readEntries<Value>(): [string, Value][] {
    const rows = this.readEntriesStatement.all() as EntryRow[];
    if (rows.length > maximumKeyCount) throw unavailable();
    return rows.map((row) => {
      if (!Buffer.isBuffer(row.value)) throw unavailable();
      return [decodeKey(row.key), this.decode<Value>(row.value)];
    });
  }

  private readItem<Value>(key: string): Value | undefined {
    const row = this.readItemStatement.get(encodeKey(key)) as
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
    if (encoded.length < 1 || encoded.length > maximumValueBytes) throw unavailable();
    this.writeItemTransaction(encodedKey, encoded);
  }

  private removeItem(key: string): void {
    this.removeItemTransaction(encodeKey(key));
  }

  private decode<Value>(value: Buffer): Value {
    if (value.length < 1 || value.length > maximumValueBytes) throw unavailable();
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
    const owner = new SqliteWalletConnectStorageOwner(database);
    return Object.freeze({
      storage: owner.storage,
      checkpoint: () => owner.checkpoint(),
      seal: (expectedRevision: bigint) => owner.seal(expectedRevision),
      close: () => owner.close(),
    });
  } catch {
    if (database !== undefined) {
      try { database.close(); } catch { /* Preserve the fixed boundary failure. */ }
    }
    throw unavailable();
  }
};
