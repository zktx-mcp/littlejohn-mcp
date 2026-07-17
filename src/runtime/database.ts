import { constants } from "node:fs";
import { randomBytes } from "node:crypto";
import { link, lstat, open, readdir, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import Database from "better-sqlite3";

import {
  decodeCanonicalBase64Url,
  parseCapabilityDataAt,
  parseUtcTimestamp,
  walletConnectionCapability,
  type UtcTimestamp,
  type WalletConnectionData,
} from "../core/index.js";
import { RuntimeOperationError } from "./errors.js";
import {
  attestOwnerOnlyStateFile,
  acquireOwnerOnlyStateFileLease,
  createOwnerOnlyStateFile,
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

const schemaSql = `CREATE TABLE local_profile (
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

const currentTableNames = Object.freeze([
  "local_profile",
  "runtime_owner",
  "wallet_connection",
]);

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

interface ProfileRow { singleton: number; profileId: string; createdAt: string }
interface OwnerRow {
  singleton: number;
  profileId: string;
  ownerInstanceId: string;
  protocolVersion: number;
  processId: number;
  ownerRevision: string;
  acquiredAt: string;
}
interface WalletRow extends WalletConnectionStorageRow {
  singleton: number;
  revision: string;
  updatedAt: string;
}

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

const assertCurrentSchema = (database: Database.Database): void => {
  if (database.pragma("user_version", { simple: true }) !== runtimeProtocolVersion) {
    throw new Error("SQLite schema protocol is incompatible.");
  }
  if (JSON.stringify(tableNames(database)) !== JSON.stringify(currentTableNames)) {
    throw new Error("SQLite table set is incompatible.");
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
    row.protocolVersion !== runtimeProtocolVersion ||
    !Number.isSafeInteger(row.processId) ||
    row.processId <= 0
  ) throw new Error("Runtime owner projection is invalid.");
  return Object.freeze({
    profileId: profile.profileId,
    ownerInstanceId: parseOwnerInstanceId(row.ownerInstanceId),
    protocolVersion: runtimeProtocolVersion,
    processId: row.processId,
    ownerRevision: parseRuntimeRevision(row.ownerRevision),
    acquiredAt: parseUtcTimestamp(row.acquiredAt),
  });
};

const walletFromRow = (row: WalletRow): WalletConnectionRecord => {
  if (row.singleton !== 1) throw new Error("Wallet connection singleton is invalid.");
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
    owner_instance_id AS ownerInstanceId, protocol_version AS protocolVersion,
    process_id AS processId, owner_revision AS ownerRevision, acquired_at AS acquiredAt
    FROM runtime_owner ORDER BY singleton`).all() as OwnerRow[];
  if (rows.length > 1) throw new Error("Runtime owner projection is invalid.");
  return rows[0] === undefined ? undefined : ownerFromRow(rows[0], readProfileRaw(database));
};

const readWalletRaw = (database: Database.Database): WalletConnectionRecord => {
  const rows = database.prepare(`SELECT singleton, revision, status, reason, account, address,
    chain_id AS chainId, approved_methods_json AS approvedMethodsJson,
    approved_events_json AS approvedEventsJson, expires_at AS expiresAt,
    eligible_session_count AS eligibleSessionCount, updated_at AS updatedAt
    FROM wallet_connection ORDER BY singleton`).all() as WalletRow[];
  if (rows.length !== 1 || rows[0] === undefined) throw new Error("Wallet connection projection is unavailable.");
  return walletFromRow(rows[0]);
};

const validateDatabaseState = (database: Database.Database): void => {
  assertCurrentSchema(database);
  readProfileRaw(database);
  readOwnerRaw(database);
  readWalletRaw(database);
};

const bootstrapFreshDatabase = (database: Database.Database, now: UtcTimestamp): void => {
  exclusive(database, () => {
    if (tableNames(database).length !== 0) throw new Error("Fresh SQLite state is not empty.");
    database.exec(schemaSql);
    database.pragma(`user_version = ${runtimeProtocolVersion}`);
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
        initialWallet.approvedMethodsJson,
        initialWallet.approvedEventsJson,
        initialWallet.expiresAt,
        initialWallet.eligibleSessionCount,
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

const artifactExists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
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

const openCurrentDatabase = async (
  path: string,
  leaseFactory: OwnerOnlyStateFileLeaseFactory,
): Promise<OpenedDatabase> => {
  const inspection = await settleSqliteArtifactSet(path);
  if (inspection.state !== "existing") throw new Error("Existing SQLite state is unavailable.");
  const mainLease = leaseFactory(path);
  let database: Database.Database | undefined;
  try {
    mainLease.assertCurrent();
    database = new Database(path, { fileMustExist: true, timeout: 5_000 });
    configureExistingDatabase(database);
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
  #databaseClosed = false;
  #mainLeaseClosed = false;

  private constructor(opened: OpenedDatabase) {
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
        try { return new ProductDatabase(await openCurrentDatabase(path, stateFileAuthority.acquireMainLease)); }
        catch { throw publicationFailure; }
      }
      return new ProductDatabase(await openCurrentDatabase(path, stateFileAuthority.acquireMainLease));
    } catch (error) { throw storageError(error); }
  }

  ownerStore(): RuntimeOwnerStore { return this.#ownerStore; }
  walletStore(): WalletProjectionStore { return this.#walletStore; }

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
            values.chainId, values.approvedMethodsJson, values.approvedEventsJson, values.expiresAt,
            values.eligibleSessionCount, updatedAt, expectedRevision,
          );
        if (result.changes !== 1) throw new RuntimeOperationError("state_conflict");
        return readWalletRaw(this.#database);
      });
    } catch (error) { throw storageError(error); }
  }
}
