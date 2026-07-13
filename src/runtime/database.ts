import { constants } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { link, lstat, open, readdir, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import Database from "better-sqlite3";

import {
  canonicalJsonStringify,
  decodeCanonicalBase64Url,
  parseCapabilityDataAt,
  parseUtcTimestamp,
  walletConnectionCapability,
  type CanonicalJson,
  type UtcTimestamp,
  type WalletConnectionData,
} from "../core/index.js";
import { RuntimeOperationError } from "./errors.js";
import {
  attestOwnerOnlyStateFile,
  acquireOwnerOnlyStateFileLease,
  createOwnerOnlyStateFile,
  openOwnerOnlyStateFileForRead,
  type OwnerOnlyStateFileLease,
  type OwnerOnlyStateFileLeaseFactory,
} from "./paths.js";
import {
  createProfileId,
  parseOwnerInstanceId,
  parseProfileId,
  parseRuntimeRevision,
  runtimeIdentifierEncodedLength,
  runtimeProtocolVersion,
  unsignedDecimalSqlCheck,
  type OwnerInstanceId,
  type ProfileId,
  type RuntimeRevision,
} from "./runtime-identity.js";
import {
  decodeWalletConnectionStorage,
  encodeWalletConnectionStorage,
  walletConnectionFieldPresenceCheckSql,
  type WalletConnectionStorageRow,
} from "./wallet-connection-storage.js";

const migrationSql = `
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  applied_at TEXT NOT NULL
);
CREATE TABLE local_profile (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  profile_id TEXT NOT NULL UNIQUE CHECK (length(profile_id) = ${runtimeIdentifierEncodedLength}),
  created_at TEXT NOT NULL
);
CREATE TABLE runtime_owner (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  profile_id TEXT NOT NULL,
  owner_instance_id TEXT NOT NULL CHECK (length(owner_instance_id) = ${runtimeIdentifierEncodedLength}),
  protocol_version INTEGER NOT NULL CHECK (protocol_version = ${runtimeProtocolVersion}),
  process_id INTEGER NOT NULL CHECK (process_id > 0),
  owner_revision TEXT NOT NULL CHECK (${unsignedDecimalSqlCheck("owner_revision")}),
  acquired_at TEXT NOT NULL,
  FOREIGN KEY (profile_id) REFERENCES local_profile(profile_id)
);
CREATE TABLE wallet_connection (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision TEXT NOT NULL CHECK (${unsignedDecimalSqlCheck("revision")}),
  status TEXT NOT NULL,
  reason TEXT,
  account TEXT,
  address TEXT,
  chain_id TEXT,
  approved_methods_json TEXT,
  approved_events_json TEXT,
  expires_at TEXT,
  eligible_session_count TEXT,
  updated_at TEXT NOT NULL,
  ${walletConnectionFieldPresenceCheckSql}
);`;

const migrationDigest = createHash("sha256").update(migrationSql, "utf8").digest("hex");
export interface LocalProfile {
  readonly profileId: ProfileId;
  readonly createdAt: UtcTimestamp;
}

export interface RuntimeOwnerRecord {
  readonly profileId: ProfileId;
  readonly ownerInstanceId: OwnerInstanceId;
  readonly protocolVersion: typeof runtimeProtocolVersion;
  readonly processId: number;
  readonly ownerRevision: RuntimeRevision;
  readonly acquiredAt: UtcTimestamp;
}

export interface WalletConnectionRecord {
  readonly revision: RuntimeRevision;
  readonly connection: WalletConnectionData;
  readonly updatedAt: UtcTimestamp;
}

export interface RuntimeOwnerStore {
  readProfile(): LocalProfile;
  readOwner(): RuntimeOwnerRecord | undefined;
  publishOwner(ownerInstanceId: string, acquiredAt: UtcTimestamp): RuntimeOwnerRecord;
}

export interface WalletProjectionStore {
  read(): WalletConnectionRecord;
  replace(
    expectedRevision: string,
    connection: WalletConnectionData,
    updatedAt: UtcTimestamp,
  ): WalletConnectionRecord;
}

interface MigrationRow { version: number; digest: string; applied_at: string }
interface ProfileRow { singleton: number; profile_id: string; created_at: string }
interface OwnerRow {
  singleton: number;
  profile_id: string;
  owner_instance_id: string;
  protocol_version: number;
  process_id: number;
  owner_revision: string;
  acquired_at: string;
}
interface WalletRow extends WalletConnectionStorageRow {
  singleton: number;
  revision: string;
  updated_at: string;
}
interface SchemaRow { readonly type: string; readonly name: string; readonly tableName: string; readonly sql: string }

const sqliteContentionCodes: ReadonlySet<string> = new Set([
  "SQLITE_BUSY",
  "SQLITE_BUSY_RECOVERY",
  "SQLITE_BUSY_SNAPSHOT",
  "SQLITE_BUSY_TIMEOUT",
  "SQLITE_LOCKED",
  "SQLITE_LOCKED_SHAREDCACHE",
  "SQLITE_LOCKED_VTAB",
]);

const storageError = (error: unknown): RuntimeOperationError => {
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

const tableNames = (database: Database.Database): string[] =>
  (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[]).map((row) => row.name);

const schemaRows = (database: Database.Database): SchemaRow[] =>
  (database.prepare(`SELECT type, name, tbl_name, sql
    FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
    ORDER BY type, name`).all() as { type: string; name: string; tbl_name: string; sql: string }[])
    .map((row) => ({ type: row.type, name: row.name, tableName: row.tbl_name, sql: row.sql }));

const schemaIdentity = (database: Database.Database): string =>
  createHash("sha256")
    .update(canonicalJsonStringify(schemaRows(database) as unknown as CanonicalJson), "utf8")
    .digest("hex");

const expectedSchemaIdentity = (() => {
  const database = new Database(":memory:");
  try {
    database.exec(migrationSql);
    return schemaIdentity(database);
  } finally { database.close(); }
})();

const configureConnection = (database: Database.Database): void => {
  database.pragma("foreign_keys = ON");
  if (database.pragma("foreign_keys", { simple: true }) !== 1) throw new Error("SQLite foreign keys are unavailable.");
  database.pragma("busy_timeout = 5000");
  if (database.pragma("busy_timeout", { simple: true }) !== 5_000) throw new Error("SQLite busy timeout is unavailable.");
};

const configureValidationConnection = (database: Database.Database): void => {
  configureConnection(database);
  database.pragma("temp_store = MEMORY");
  if (database.pragma("temp_store", { simple: true }) !== 2) {
    throw new Error("SQLite in-memory validation workspace is unavailable.");
  }
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

const configureExistingValidation = (database: Database.Database): void => {
  configureValidationConnection(database);
  assertExistingWalMode(database);
};

const profileFromRow = (row: ProfileRow): LocalProfile => {
  if (row.singleton !== 1) throw new Error("Local profile singleton is invalid.");
  return Object.freeze({
    profileId: parseProfileId(row.profile_id),
    createdAt: parseUtcTimestamp(row.created_at),
  });
};

const ownerFromRow = (row: OwnerRow, profile: LocalProfile): RuntimeOwnerRecord => {
  if (
    row.singleton !== 1 ||
    row.profile_id !== profile.profileId ||
    row.protocol_version !== runtimeProtocolVersion ||
    !Number.isSafeInteger(row.process_id) ||
    row.process_id <= 0
  ) throw new Error("Runtime owner projection is invalid.");
  return Object.freeze({
    profileId: profile.profileId,
    ownerInstanceId: parseOwnerInstanceId(row.owner_instance_id),
    protocolVersion: runtimeProtocolVersion,
    processId: row.process_id,
    ownerRevision: parseRuntimeRevision(row.owner_revision),
    acquiredAt: parseUtcTimestamp(row.acquired_at),
  });
};

const walletFromRow = (row: WalletRow): WalletConnectionRecord => {
  if (row.singleton !== 1) throw new Error("Wallet connection singleton is invalid.");
  const updatedAt = parseUtcTimestamp(row.updated_at);
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
  const rows = database.prepare("SELECT singleton, profile_id, created_at FROM local_profile ORDER BY singleton").all() as ProfileRow[];
  if (rows.length !== 1 || rows[0] === undefined) throw new Error("Local profile is unavailable.");
  return profileFromRow(rows[0]);
};

const readOwnerRaw = (database: Database.Database): RuntimeOwnerRecord | undefined => {
  const rows = database.prepare(`SELECT singleton, profile_id, owner_instance_id, protocol_version,
    process_id, owner_revision, acquired_at FROM runtime_owner ORDER BY singleton`).all() as OwnerRow[];
  if (rows.length > 1) throw new Error("Runtime owner projection is invalid.");
  return rows[0] === undefined ? undefined : ownerFromRow(rows[0], readProfileRaw(database));
};

const readWalletRaw = (database: Database.Database): WalletConnectionRecord => {
  const rows = database.prepare(`SELECT singleton, revision, status, reason, account, address, chain_id,
    approved_methods_json, approved_events_json, expires_at, eligible_session_count, updated_at
    FROM wallet_connection ORDER BY singleton`).all() as WalletRow[];
  if (rows.length !== 1 || rows[0] === undefined) throw new Error("Wallet connection projection is unavailable.");
  return walletFromRow(rows[0]);
};

const validateDatabaseState = (database: Database.Database): void => {
  const integrity = database.pragma("integrity_check") as { integrity_check: string }[];
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") throw new Error("Database integrity failed.");
  if ((database.pragma("foreign_key_check") as unknown[]).length !== 0) throw new Error("Database foreign keys are invalid.");
  const expectedTables = ["local_profile", "runtime_owner", "schema_migrations", "wallet_connection"];
  if (tableNames(database).join("\0") !== expectedTables.join("\0")) throw new Error("Database table set is invalid.");
  if (schemaIdentity(database) !== expectedSchemaIdentity) throw new Error("Database schema identity is invalid.");
  const migrations = database.prepare("SELECT version, digest, applied_at FROM schema_migrations ORDER BY version").all() as MigrationRow[];
  if (
    migrations.length !== 1 ||
    migrations[0]?.version !== 1 ||
    migrations[0].digest !== migrationDigest
  ) throw new Error("Database migration identity is invalid.");
  parseUtcTimestamp(migrations[0].applied_at);
  readProfileRaw(database);
  readOwnerRaw(database);
  readWalletRaw(database);
};

const bootstrapFreshDatabase = (database: Database.Database, now: UtcTimestamp): void => {
  exclusive(database, () => {
    if (tableNames(database).length !== 0) throw new Error("Fresh SQLite state is not empty.");
    database.exec(migrationSql);
    database.prepare("INSERT INTO schema_migrations(version, digest, applied_at) VALUES (1, ?, ?)")
      .run(migrationDigest, now);
    database.prepare("INSERT INTO local_profile(singleton, profile_id, created_at) VALUES (1, ?, ?)")
      .run(createProfileId(), now);
    const initialWallet = encodeWalletConnectionStorage({ status: "unknown", reason: "reconciling" });
    database.prepare(`INSERT INTO wallet_connection(
      singleton, revision, status, reason, account, address, chain_id,
      approved_methods_json, approved_events_json, expires_at,
      eligible_session_count, updated_at
    ) VALUES (1, '0', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        initialWallet.status,
        initialWallet.reason,
        initialWallet.account,
        initialWallet.address,
        initialWallet.chainId,
        initialWallet.methods,
        initialWallet.events,
        initialWallet.expiresAt,
        initialWallet.eligibleCount,
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

const sqliteMainHeaderLength = 100;
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
  readonly hasWal: boolean;
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

const assertWalMainHeader = (bytes: Uint8Array): void => {
  if (
    bytes.length < 20 ||
    !Buffer.from(bytes.subarray(0, 16)).equals(Buffer.from("SQLite format 3\0", "binary")) ||
    bytes[18] !== 2 ||
    bytes[19] !== 2
  ) throw new Error("Existing SQLite main file is not a complete WAL database.");
};

const assertWalDatabaseHeader = async (path: string): Promise<void> => {
  const details = await lstat(path);
  if (details.size < sqliteMainHeaderLength) throw new Error("Existing SQLite main file is incomplete.");
  const handle = await openOwnerOnlyStateFileForRead(path);
  try {
    const header = Buffer.alloc(20);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead !== header.length) throw new Error("Existing SQLite main file is incomplete.");
    assertWalMainHeader(header);
  } finally { await handle.close(); }
};

const inspectSqliteArtifactSet = async (path: string): Promise<SqliteArtifactSet> => {
  const paths = sqliteArtifactSuffixes.map((suffix) => `${path}${suffix}`);
  const present = await Promise.all(paths.map(artifactExists));
  if (present.every((value) => !value)) {
    return Object.freeze({ state: "fresh", hasWal: false });
  }
  if (!present[0]) throw new Error("SQLite artifact set has no main database.");
  const existingPaths = paths.filter((_candidate, index) => present[index] === true);
  for (const artifact of existingPaths) await attestOwnerOnlyStateFile(artifact);
  await assertWalDatabaseHeader(path);
  return Object.freeze({
    state: "existing",
    hasWal: present[1] === true,
  });
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

const sameStableFileState = (
  left: ReturnType<OwnerOnlyStateFileLease["stat"]>,
  right: ReturnType<OwnerOnlyStateFileLease["stat"]>,
): boolean => left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
  left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;

const readStableMainImage = (lease: OwnerOnlyStateFileLease): Buffer => {
  const before = lease.stat();
  if (!Number.isSafeInteger(before.size) || before.size < sqliteMainHeaderLength) {
    throw new Error("Existing SQLite main file is incomplete.");
  }
  const image = Buffer.alloc(before.size);
  let position = 0;
  while (position < image.length) {
    const bytesRead = lease.read(image, position, image.length - position, position);
    if (bytesRead === 0) throw new Error("SQLite main file changed while reading.");
    position += bytesRead;
  }
  if (!sameStableFileState(before, lease.stat())) throw new Error("SQLite main file changed while reading.");
  return image;
};

interface ValidatedExistingState {
  readonly mainLease: OwnerOnlyStateFileLease;
  readonly readConnection?: Database.Database;
}

const closeReadConnection = (state: ValidatedExistingState, transactionOpen: boolean): void => {
  let failure: unknown;
  if (state.readConnection !== undefined) {
    if (transactionOpen) {
      try { state.readConnection.exec("ROLLBACK"); } catch (error) { failure = error; }
    }
    try { state.readConnection.close(); } catch (error) { failure ??= error; }
  }
  if (failure !== undefined) throw failure;
};

const validateCheckpointedMain = (
  mainLease: OwnerOnlyStateFileLease,
): ValidatedExistingState => {
  const image = readStableMainImage(mainLease);
  assertWalMainHeader(image);

  const validationImage = Buffer.from(image);
  validationImage[18] = 1;
  validationImage[19] = 1;
  const validation = new Database(validationImage, { readonly: true });
  try {
    configureValidationConnection(validation);
    validateDatabaseState(validation);
  } finally { validation.close(); }
  mainLease.assertCurrent();
  return Object.freeze({ mainLease });
};

const prepareActiveWalValidation = async (
  path: string,
  mainLease: OwnerOnlyStateFileLease,
): Promise<ValidatedExistingState> => {
  mainLease.assertCurrent();
  const validation = new Database(path, { readonly: true, fileMustExist: true, timeout: 5_000 });
  try {
    configureExistingValidation(validation);
    const opened = await settleSqliteArtifactSet(path);
    if (opened.state !== "existing") throw new Error("SQLite artifact set changed while opening.");
    mainLease.assertCurrent();
    return Object.freeze({ mainLease, readConnection: validation });
  } catch (error) {
    try { validation.close(); } catch { /* Preserve the validation failure. */ }
    throw error;
  }
};

const acquireValidatedExistingState = async (
  path: string,
  leaseFactory: OwnerOnlyStateFileLeaseFactory,
): Promise<ValidatedExistingState> => {
  const inspection = await settleSqliteArtifactSet(path);
  if (inspection.state !== "existing") throw new Error("Existing SQLite state is unavailable.");
  const mainLease = leaseFactory(path);
  try {
    mainLease.assertCurrent();
    return inspection.hasWal
      ? await prepareActiveWalValidation(path, mainLease)
      : validateCheckpointedMain(mainLease);
  } catch (error) {
    try { mainLease.close(); } catch { /* Preserve the validation failure. */ }
    throw error;
  }
};

interface OpenedValidatedDatabase {
  readonly database: Database.Database;
  readonly mainLease: OwnerOnlyStateFileLease;
}

const openValidatedConnection = (
  path: string,
  validated: ValidatedExistingState,
): Database.Database => {
  let database: Database.Database | undefined;
  let writerTransaction = false;
  let readTransaction = false;
  let readConnectionClosed = false;
  try {
    validated.mainLease.assertCurrent();
    if (validated.readConnection !== undefined) {
      validated.readConnection.exec("BEGIN");
      readTransaction = true;
      validateDatabaseState(validated.readConnection);
      validated.mainLease.assertCurrent();
    }
    database = new Database(path, { fileMustExist: true, timeout: 5_000 });
    configureExistingDatabase(database);
    validated.mainLease.assertCurrent();
    database.exec("BEGIN IMMEDIATE");
    writerTransaction = true;
    try {
      validated.mainLease.assertCurrent();
      validateDatabaseState(database);
      validated.mainLease.assertCurrent();
      database.exec("COMMIT");
      writerTransaction = false;
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* Preserve the original failure. */ }
      writerTransaction = false;
      throw error;
    }
    validated.mainLease.assertCurrent();
    closeReadConnection(validated, readTransaction);
    readTransaction = false;
    readConnectionClosed = true;
    validated.mainLease.assertCurrent();
    return database;
  } catch (error) {
    if (writerTransaction) {
      try { database?.exec("ROLLBACK"); } catch { /* Preserve the original failure. */ }
    }
    try { database?.close(); } catch { /* Preserve the original failure. */ }
    if (!readConnectionClosed) {
      try { closeReadConnection(validated, readTransaction); } catch { /* Preserve the original failure. */ }
    }
    try { validated.mainLease.close(); } catch { /* Preserve the original failure. */ }
    throw error;
  }
};

const openValidatedDatabase = async (
  path: string,
  leaseFactory: OwnerOnlyStateFileLeaseFactory,
): Promise<OpenedValidatedDatabase> => {
  const validated = await acquireValidatedExistingState(path, leaseFactory);
  let database: Database.Database | undefined;
  try {
    database = openValidatedConnection(path, validated);
    const opened = await settleSqliteArtifactSet(path);
    if (opened.state !== "existing") throw new Error("SQLite artifact set changed while opening.");
    validated.mainLease.assertCurrent();
    await reconcilePublicationStaging(path);
    validated.mainLease.assertCurrent();
    return Object.freeze({ database, mainLease: validated.mainLease });
  } catch (error) {
    try { database?.close(); } catch { /* Preserve the original failure. */ }
    try { validated.mainLease.close(); } catch { /* Preserve the original failure. */ }
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
    await assertWalDatabaseHeader(pending);
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

export interface ProductDatabaseStateFileAuthority {
  readonly acquireMainLease: OwnerOnlyStateFileLeaseFactory;
}

export const localProductDatabaseStateFileAuthority = Object.freeze({
  acquireMainLease: acquireOwnerOnlyStateFileLease,
}) satisfies ProductDatabaseStateFileAuthority;

export class ProductDatabase {
  readonly #database: Database.Database;
  readonly #mainLease: OwnerOnlyStateFileLease;
  readonly #ownerStore: RuntimeOwnerStore;
  readonly #walletStore: WalletProjectionStore;

  private constructor(opened: OpenedValidatedDatabase) {
    this.#database = opened.database;
    this.#mainLease = opened.mainLease;
    this.#ownerStore = Object.freeze({
      readProfile: () => this.readProfile(),
      readOwner: () => this.readOwner(),
      publishOwner: (ownerInstanceId: string, acquiredAt: UtcTimestamp) =>
        this.publishOwner(ownerInstanceId, acquiredAt),
    });
    this.#walletStore = Object.freeze({
      read: () => this.readWalletConnection(),
      replace: (expectedRevision: string, connection: WalletConnectionData, updatedAt: UtcTimestamp) =>
        this.replaceWalletConnection(expectedRevision, connection, updatedAt),
    });
  }

  static async open(
    path: string,
    nowInput: UtcTimestamp,
    stateFileAuthority: ProductDatabaseStateFileAuthority = localProductDatabaseStateFileAuthority,
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
        try { return new ProductDatabase(await openValidatedDatabase(path, stateFileAuthority.acquireMainLease)); }
        catch { throw publicationFailure; }
      }
      return new ProductDatabase(await openValidatedDatabase(path, stateFileAuthority.acquireMainLease));
    } catch (error) { throw storageError(error); }
  }

  ownerStore(): RuntimeOwnerStore { return this.#ownerStore; }
  walletStore(): WalletProjectionStore { return this.#walletStore; }

  close(): void {
    let failure: unknown;
    try { this.#database.close(); } catch (error) { failure = error; }
    try { this.#mainLease.close(); } catch (error) { failure ??= error; }
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

  private publishOwner(ownerInstanceId: string, acquiredAtInput: UtcTimestamp): RuntimeOwnerRecord {
    try {
      const parsedInstanceId = parseOwnerInstanceId(ownerInstanceId);
      const acquiredAt = parseUtcTimestamp(acquiredAtInput);
      return this.#writeWithIdentity(() => {
        const profile = readProfileRaw(this.#database);
        const current = readOwnerRaw(this.#database);
        const revision = (BigInt(current?.ownerRevision ?? "0") + 1n).toString(10);
        this.#database.prepare(`INSERT INTO runtime_owner(
          singleton, profile_id, owner_instance_id, protocol_version, process_id,
          owner_revision, acquired_at
        ) VALUES (1, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET
          profile_id = excluded.profile_id,
          owner_instance_id = excluded.owner_instance_id,
          protocol_version = excluded.protocol_version,
          process_id = excluded.process_id,
          owner_revision = excluded.owner_revision,
          acquired_at = excluded.acquired_at`)
          .run(
            profile.profileId,
            parsedInstanceId,
            runtimeProtocolVersion,
            process.pid,
            revision,
            acquiredAt,
          );
        return readOwnerRaw(this.#database) as RuntimeOwnerRecord;
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
        const current = readWalletRaw(this.#database);
        if (current.revision !== expectedRevision) throw new RuntimeOperationError("state_conflict");
        const revision = (BigInt(current.revision) + 1n).toString(10);
        const values = encodeWalletConnectionStorage(connection);
        const result = this.#database.prepare(`UPDATE wallet_connection SET
          revision = ?, status = ?, reason = ?, account = ?, address = ?, chain_id = ?,
          approved_methods_json = ?, approved_events_json = ?, expires_at = ?,
          eligible_session_count = ?, updated_at = ?
          WHERE singleton = 1 AND revision = ?`)
          .run(
            revision, values.status, values.reason, values.account, values.address,
            values.chainId, values.methods, values.events, values.expiresAt,
            values.eligibleCount, updatedAt, expectedRevision,
          );
        if (result.changes !== 1) throw new RuntimeOperationError("state_conflict");
        return readWalletRaw(this.#database);
      });
    } catch (error) { throw storageError(error); }
  }
}

export const databaseMigrationIdentity = Object.freeze({
  version: 1,
  digest: migrationDigest,
  schemaIdentity: expectedSchemaIdentity,
});
