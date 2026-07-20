import { constants } from "node:fs";
import { randomBytes } from "node:crypto";
import { link, lstat, open, readdir, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import Database from "better-sqlite3";

import {
  canonicalJsonStringify,
  decodeCanonicalBase64Url,
  deepFreezeValue,
  erc20AssetIdentitySchema,
  evmAccountIdentitySchema,
  parseEvmAccountIdentity,
  parseEvmChainId,
  parseEvmContractIdentity,
  parseCapabilityDataAt,
  parseUtcTimestamp,
  walletConnectionCapability,
  type CanonicalJson,
  type EvmAccountIdentity,
  type EvmChainId,
  type UtcTimestamp,
  type WalletConnectionData,
} from "../core/index.js";
import {
  tokenCatalogContractLimits,
  tokenCatalogConfirmedOperationSchema,
  tokenCatalogOperationSchema,
  tokenInspectionDigest,
  tokenInspectionSuccessSchema,
  tokenRegistrationSchema,
  tokenRegistrationRevisionSchema,
  tokenRegistrationWithInspectionSchema,
  type TokenInspectionSuccess,
  type TokenRegistration,
  type TokenRegistrationWithInspection,
} from "../token-catalog/contracts.js";
import { TokenCatalogOperationError } from "../token-catalog/operation-error.js";
import type {
  AccountTokenRegistrationReadPort,
  TokenCatalogQueryStore,
  TokenCatalogConfirmationCommand,
  TokenCatalogStore,
  TokenRegistrationPage,
} from "../token-catalog/ports.js";
import { getRuntimeOperationFailure, RuntimeOperationError } from "./errors.js";
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
  parseRuntimeConfigurationMac,
  parseRuntimeRevision,
  runtimeProtocolVersion,
  type OwnerInstanceId,
  type ProfileId,
  type RuntimeConfigurationMac,
  type RuntimeRevision,
} from "./runtime-identity.js";
import {
  currentSqliteSchemaSql,
  currentSqliteTableNames,
  databaseSchemaVersion,
} from "./sqlite-schema.js";
import {
  decodeWalletConnectionStorage,
  encodeWalletConnectionStorage,
  type WalletConnectionStorageRow,
} from "./wallet-connection-storage.js";

export interface LocalProfile {
  readonly profileId: ProfileId;
  readonly createdAt: UtcTimestamp;
}

export interface RuntimeOwnerRecord {
  readonly profileId: ProfileId;
  readonly ownerInstanceId: OwnerInstanceId;
  readonly configurationMac: RuntimeConfigurationMac;
  readonly protocolVersion: number;
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
  publishOwner(
    ownerInstanceId: string,
    configurationMac: string,
    acquiredAt: UtcTimestamp,
  ): RuntimeOwnerRecord;
}

export interface ConfiguredChainStore {
  insertConfiguredChainIfAbsent(chainId: EvmChainId): void;
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
  configurationMac: string;
  protocolVersion: number;
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
interface TokenRegistrationRecordRow {
  readonly profileId: string;
  readonly chainId: string;
  readonly walletAddress: string;
  readonly tokenAddress: string;
  readonly revision: string;
  readonly inspectionDigest: string;
  readonly createdAt: string;
}
interface TokenRegistrationRow extends TokenRegistrationRecordRow {
  readonly contractAddress: string;
  readonly resultJson: string;
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

const decodeTokenRegistrationRecordRow = (
  row: TokenRegistrationRecordRow,
  expectedProfileId?: ProfileId,
): TokenRegistration => {
  const profileId = parseProfileId(row.profileId);
  if (expectedProfileId !== undefined && profileId !== expectedProfileId) {
    throw new Error("Stored token registration profile is invalid.");
  }
  const account = parseEvmAccountIdentity({ chainId: row.chainId, address: row.walletAddress });
  const asset = erc20AssetIdentitySchema.parse({
    kind: "erc20",
    chainId: row.chainId,
    address: row.tokenAddress,
  });
  return tokenRegistrationSchema.parse({
    account,
    asset,
    revision: tokenRegistrationRevisionSchema.parse(row.revision),
    inspectionDigest: row.inspectionDigest,
    createdAt: parseUtcTimestamp(row.createdAt),
  });
};

const decodeTokenRegistrationRow = (
  row: TokenRegistrationRow,
  expectedProfileId?: ProfileId,
): TokenRegistrationWithInspection => tokenRegistrationWithInspectionSchema.parse({
  registration: decodeTokenRegistrationRecordRow(row, expectedProfileId),
  inspection: decodeInspectionRow(row),
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
  if (database.pragma("user_version", { simple: true }) !== databaseSchemaVersion) {
    throw new Error("SQLite schema version is incompatible.");
  }
  if (JSON.stringify(tableNames(database)) !== JSON.stringify(currentSqliteTableNames)) {
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
    !Number.isSafeInteger(row.protocolVersion) ||
    row.protocolVersion <= 0 ||
    !Number.isSafeInteger(row.processId) ||
    row.processId <= 0
  ) throw new Error("Runtime owner projection is invalid.");
  return Object.freeze({
    profileId: profile.profileId,
    ownerInstanceId: parseOwnerInstanceId(row.ownerInstanceId),
    configurationMac: parseRuntimeConfigurationMac(row.configurationMac),
    protocolVersion: row.protocolVersion,
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
    protocol_version AS protocolVersion,
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

const tokenRegistrationColumns = `r.profile_id AS profileId, r.chain_id AS chainId,
  r.wallet_address AS walletAddress, r.token_address AS tokenAddress, r.revision,
  r.inspection_digest AS inspectionDigest, r.created_at AS createdAt`;

const tokenRegistrationRecordSelect = `SELECT ${tokenRegistrationColumns}
  FROM wallet_token_registration AS r`;

const tokenRegistrationSelect = `SELECT ${tokenRegistrationColumns},
  i.contract_address AS contractAddress, i.result_json AS resultJson
  FROM wallet_token_registration AS r
  JOIN token_contract_inspection AS i
    ON i.chain_id = r.chain_id
   AND i.contract_address = r.token_address
   AND i.inspection_digest = r.inspection_digest`;

const readTokenCatalogRows = (database: Database.Database): void => {
  const inspections = database.prepare(`SELECT chain_id AS chainId,
    contract_address AS contractAddress, inspection_digest AS inspectionDigest,
    result_json AS resultJson FROM token_contract_inspection
    ORDER BY chain_id, contract_address, inspection_digest`).iterate() as IterableIterator<TokenInspectionRow>;
  for (const row of inspections) decodeInspectionRow(row);
  const registrations = database.prepare(`${tokenRegistrationRecordSelect}
    ORDER BY r.profile_id, r.chain_id, r.wallet_address, r.token_address`)
    .iterate() as IterableIterator<TokenRegistrationRecordRow>;
  for (const row of registrations) decodeTokenRegistrationRecordRow(row);
};

const validateDatabaseState = (database: Database.Database): void => {
  assertCurrentSchema(database);
  readProfileRaw(database);
  readOwnerRaw(database);
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
    if (tableNames(database).length !== 0) throw new Error("Fresh SQLite state is not empty.");
    database.exec(currentSqliteSchemaSql);
    database.pragma(`user_version = ${databaseSchemaVersion}`);
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
  readonly #configuredChainStore: ConfiguredChainStore;
  readonly #walletStore: WalletProjectionStore;
  readonly #tokenCatalogReadStore: TokenCatalogQueryStore;
  readonly #accountTokenRegistrationRead: AccountTokenRegistrationReadPort;
  readonly #tokenCatalogStore: TokenCatalogStore;
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
    this.#tokenCatalogReadStore = Object.freeze({
      getRegistration: (account, asset) => this.getTokenRegistration(account, asset),
      listRegistrations: (input) => this.listTokenRegistrations(input),
    } satisfies TokenCatalogQueryStore);
    this.#accountTokenRegistrationRead = Object.freeze({
      getForAccount: ({ account, asset }) => this.getTokenRegistration(account, asset),
      listForAccount: (input) => this.listTokenRegistrationInspections(input),
    } satisfies AccountTokenRegistrationReadPort);
    this.#tokenCatalogStore = Object.freeze({
      getRegistration: (account, asset) => this.getTokenRegistration(account, asset),
      listRegistrations: (input) => this.listTokenRegistrations(input),
      applyConfirmation: (input) => this.applyTokenConfirmation(input),
    } satisfies TokenCatalogStore);
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
  configuredChainStore(): ConfiguredChainStore { return this.#configuredChainStore; }
  walletStore(): WalletProjectionStore { return this.#walletStore; }
  tokenCatalogReadStore(): TokenCatalogQueryStore { return this.#tokenCatalogReadStore; }
  accountTokenRegistrationRead(): AccountTokenRegistrationReadPort {
    return this.#accountTokenRegistrationRead;
  }
  tokenCatalogStore(): TokenCatalogStore { return this.#tokenCatalogStore; }

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
          singleton, profile_id, owner_instance_id, configuration_mac, protocol_version, process_id,
          owner_revision, acquired_at
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET
          profile_id = excluded.profile_id,
          owner_instance_id = excluded.owner_instance_id,
          configuration_mac = excluded.configuration_mac,
          protocol_version = excluded.protocol_version,
          process_id = excluded.process_id,
          owner_revision = excluded.owner_revision,
          acquired_at = excluded.acquired_at`)
          .run(
            profile.profileId,
            parsedInstanceId,
            configurationMac,
            runtimeProtocolVersion,
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

  private getTokenRegistration(
    accountInput: EvmAccountIdentity,
    assetInput: TokenRegistration["asset"],
  ): TokenRegistrationWithInspection | undefined {
    try {
      const account = evmAccountIdentitySchema.parse(accountInput);
      const asset = erc20AssetIdentitySchema.parse(assetInput);
      if (account.chainId !== asset.chainId) throw new TokenCatalogOperationError("invalid_input");
      return this.#readWithIdentity(() => {
        const profile = readProfileRaw(this.#database);
        const rows = this.#database.prepare(`${tokenRegistrationSelect}
          WHERE r.profile_id = ? AND r.chain_id = ? AND r.wallet_address = ? AND r.token_address = ?`)
          .all(profile.profileId, account.chainId, account.address, asset.address) as TokenRegistrationRow[];
        if (rows.length > 1) throw new Error("Token registration identity is not unique.");
        return rows[0] === undefined ? undefined : decodeTokenRegistrationRow(rows[0], profile.profileId);
      });
    } catch (error) { throw tokenCatalogStorageError(error); }
  }

  private listTokenRegistrations(input: Readonly<{
    account: EvmAccountIdentity;
    limit: number;
    cursor: TokenRegistration["asset"]["address"] | null;
  }>): TokenRegistrationPage {
    try {
      const account = evmAccountIdentitySchema.parse(input.account);
      if (
        !Number.isInteger(input.limit) || input.limit < 1 ||
        input.limit > tokenCatalogContractLimits.listMaximumLimit
      ) {
        throw new TokenCatalogOperationError("invalid_input");
      }
      const cursor = input.cursor === null
        ? null
        : erc20AssetIdentitySchema.parse({ kind: "erc20", chainId: account.chainId, address: input.cursor }).address;
      return this.#readWithIdentity(() => {
        const profile = readProfileRaw(this.#database);
        const rows = this.#database.prepare(`${tokenRegistrationRecordSelect}
          WHERE r.profile_id = ? AND r.chain_id = ? AND r.wallet_address = ?
            AND (? IS NULL OR r.token_address > ?)
          ORDER BY r.token_address LIMIT ?`)
          .all(
            profile.profileId,
            account.chainId,
            account.address,
            cursor,
            cursor,
            input.limit + 1,
          ) as TokenRegistrationRecordRow[];
        const hasMore = rows.length > input.limit;
        const selected = rows.slice(0, input.limit)
          .map((row) => decodeTokenRegistrationRecordRow(row, profile.profileId));
        return Object.freeze({
          registrations: Object.freeze(selected),
          nextCursor: hasMore ? selected.at(-1)?.asset.address ?? null : null,
        });
      });
    } catch (error) { throw tokenCatalogStorageError(error); }
  }

  private listTokenRegistrationInspections(
    input: Parameters<AccountTokenRegistrationReadPort["listForAccount"]>[0],
  ): ReturnType<AccountTokenRegistrationReadPort["listForAccount"]> {
    try {
      const account = evmAccountIdentitySchema.parse(input.account);
      if (
        !Number.isInteger(input.limit) || input.limit < 1 ||
        input.limit > tokenCatalogContractLimits.listMaximumLimit
      ) throw new TokenCatalogOperationError("invalid_input");
      const cursor = input.cursor === null
        ? null
        : erc20AssetIdentitySchema.parse({
            kind: "erc20",
            chainId: account.chainId,
            address: input.cursor,
          }).address;
      return this.#readWithIdentity(() => {
        const profile = readProfileRaw(this.#database);
        const rows = this.#database.prepare(`${tokenRegistrationSelect}
          WHERE r.profile_id = ? AND r.chain_id = ? AND r.wallet_address = ?
            AND (? IS NULL OR r.token_address > ?)
          ORDER BY r.token_address LIMIT ?`)
          .all(
            profile.profileId,
            account.chainId,
            account.address,
            cursor,
            cursor,
            input.limit + 1,
          ) as TokenRegistrationRow[];
        const hasMore = rows.length > input.limit;
        const entries = rows.slice(0, input.limit)
          .map((row) => decodeTokenRegistrationRow(row, profile.profileId));
        return Object.freeze({
          entries: Object.freeze(entries),
          nextCursor: hasMore ? entries.at(-1)?.registration.asset.address ?? null : null,
        });
      });
    } catch (error) { throw tokenCatalogStorageError(error); }
  }

  private assertTokenCatalogConnection(
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
        this.assertTokenCatalogConnection(account, expectedConnectionRevision);
        let result: NonNullable<ReturnType<TokenCatalogStore["applyConfirmation"]>["result"]>;

        if (input.kind === "register" && operation.kind === "register") {
          const inspection = tokenInspectionSuccessSchema.parse(operation.review.inspection);
          const revision = tokenRegistrationRevisionSchema.parse(input.registrationRevision);
          const now = parseUtcTimestamp(input.now);
          const inspectionDigest = tokenInspectionDigest(inspection);
          const resultJson = canonicalJsonStringify(inspection as unknown as CanonicalJson);
          const existing = this.#database.prepare(`SELECT revision FROM wallet_token_registration
            WHERE profile_id = ? AND chain_id = ? AND wallet_address = ? AND token_address = ?`)
            .all(profile.profileId, account.chainId, account.address, asset.address) as { revision: string }[];
          if (existing.length !== 0) throw new TokenCatalogOperationError("state_conflict");
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
          this.#database.prepare(`INSERT INTO wallet_token_registration(
            profile_id, chain_id, wallet_address, token_address, revision, inspection_digest, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(
              profile.profileId, account.chainId, account.address, asset.address, revision,
              inspectionDigest, now,
            );
          const stored = this.getTokenRegistrationRaw(profile.profileId, account, asset);
          if (stored === undefined) throw new Error("Token registration persistence failed.");
          result = stored;
        } else if (input.kind === "unregister" && operation.kind === "unregister") {
          const previous = operation.review.previousRegistration;
          if (previous === null) throw new TokenCatalogOperationError("internal_error");
          const current = this.getTokenRegistrationRaw(profile.profileId, account, asset);
          if (current === undefined || current.registration.revision !== previous.revision) {
            throw new TokenCatalogOperationError("token_registration_revision_changed");
          }
          if (canonicalJsonStringify(current.registration as unknown as CanonicalJson) !==
            canonicalJsonStringify(previous as unknown as CanonicalJson)) {
            throw new Error("Token registration revision does not identify its durable state.");
          }
          const removal = this.#database.prepare(`DELETE FROM wallet_token_registration
            WHERE profile_id = ? AND chain_id = ? AND wallet_address = ? AND token_address = ? AND revision = ?`)
            .run(profile.profileId, account.chainId, account.address, asset.address, previous.revision);
          if (removal.changes !== 1) {
            throw new TokenCatalogOperationError("token_registration_revision_changed");
          }
          this.#database.prepare(`DELETE FROM token_contract_inspection
            WHERE chain_id = ? AND contract_address = ? AND inspection_digest = ?
              AND NOT EXISTS (
                SELECT 1 FROM wallet_token_registration
                WHERE chain_id = ? AND token_address = ? AND inspection_digest = ?
              )`).run(
                asset.chainId, asset.address, previous.inspectionDigest,
                asset.chainId, asset.address, previous.inspectionDigest,
              );
          if (this.getTokenRegistrationRaw(profile.profileId, account, asset) !== undefined) {
            throw new Error("Token registration removal failed.");
          }
          const references = this.#database.prepare(`SELECT COUNT(*) AS count
            FROM wallet_token_registration
            WHERE chain_id = ? AND token_address = ? AND inspection_digest = ?`)
            .get(asset.chainId, asset.address, previous.inspectionDigest) as { count: number };
          const inspectionRows = this.#database.prepare(`SELECT chain_id AS chainId,
            contract_address AS contractAddress, inspection_digest AS inspectionDigest,
            result_json AS resultJson FROM token_contract_inspection
            WHERE chain_id = ? AND contract_address = ? AND inspection_digest = ?`)
            .all(asset.chainId, asset.address, previous.inspectionDigest) as TokenInspectionRow[];
          if (
            (references.count === 0 && inspectionRows.length !== 0) ||
            (references.count > 0 && inspectionRows.length !== 1)
          ) throw new Error("Token inspection collection postcondition failed.");
          if (inspectionRows[0] !== undefined) decodeInspectionRow(inspectionRows[0]);
          result = Object.freeze({ asset, removedRevision: previous.revision });
        } else {
          throw new TokenCatalogOperationError("invalid_input");
        }

        return deepFreezeValue(tokenCatalogConfirmedOperationSchema.parse({
          ...operation,
          state: "completed",
          result,
          failure: null,
        }));
      });
    } catch (error) { throw tokenCatalogStorageError(error); }
  }

  private getTokenRegistrationRaw(
    profileId: ProfileId,
    account: EvmAccountIdentity,
    asset: TokenRegistration["asset"],
  ): TokenRegistrationWithInspection | undefined {
    const rows = this.#database.prepare(`${tokenRegistrationSelect}
      WHERE r.profile_id = ? AND r.chain_id = ? AND r.wallet_address = ? AND r.token_address = ?`)
      .all(profileId, account.chainId, account.address, asset.address) as TokenRegistrationRow[];
    if (rows.length > 1) throw new Error("Token registration identity is not unique.");
    return rows[0] === undefined ? undefined : decodeTokenRegistrationRow(rows[0], profileId);
  }

}
