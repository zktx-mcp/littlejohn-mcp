import { fork, type ChildProcess } from "node:child_process";
import { createHash, createHmac, hkdfSync } from "node:crypto";
import { chmodSync, copyFileSync, renameSync } from "node:fs";
import {
  chmod,
  lstat,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  ObservationAuthorityRegistry,
  canonicalJsonStringify,
  captureCanonicalJson,
  createCanonicalClock,
  parseEvmAddressInput,
  parseEvmChainId,
  parseCapabilityDataAt,
  parseUnsignedDecimal,
  parseUtcTimestamp,
  walletConnectionCapability,
} from "../../src/core/index.js";
import {
  createControlCredentialVerifier,
  deriveRuntimeConfigurationMac,
  loadOrCreateControlCredential,
  validateControlCredential,
} from "../../src/runtime/control-credential.js";
import {
  decodeAccountRecordKey,
  ProductDatabase,
} from "../../src/runtime/database.js";
import { createWalletPrivateStoreDirectoryPort } from "../../src/runtime/composition.js";
import { RuntimeOperationError } from "../../src/runtime/errors.js";
import {
  readRuntimeConfiguration,
  readConfiguredRpcEndpoint,
} from "../../src/runtime/configuration.js";
import {
  createRpcSourceAuthority,
  createWalletSourceAuthority,
} from "../../src/runtime/source-identity.js";
import {
  acquireOwnerOnlyStateFileLease,
  createOwnerOnlyStateFile,
  ensureOwnerOnlyDirectory,
  resolveApplicationDataDirectory,
  runtimePaths,
  sameOwnerOnlyStateFileIdentity,
} from "../../src/runtime/paths.js";
import {
  createOwnerInstanceId,
  createProfileId,
  parseOwnerInstanceId,
  parseProfileId,
  parseRuntimeRevision,
} from "../../src/runtime/runtime-identity.js";
import {
  canonicalOfficialAssetSnapshotRevisionSqlCheck,
  canonicalSelectionRevisionSqlCheck,
  canonicalRuntimeConfigurationMacSqlCheck,
  canonicalRuntimeIdentifierSqlCheck,
  canonicalSqlTextCheck,
  currentSqliteSchemaSql,
  getRuntimeStateResetRequiredError,
  hasExactCurrentSqliteStructure,
  persistedOperationJsonLimits,
  runtimeStateResetRequiredCode,
  runtimeStateResetRequiredMessage,
  tokenInspectionPersistenceLimits,
} from "../../src/runtime/sqlite-schema.js";
import { tokenInspectionDigest } from "../../src/token-catalog/contracts.js";
import {
  parseWalletManagementOperation,
  parseWalletReview,
  walletReviewDigest,
} from "../../src/wallet/contracts.js";
import {
  createWalletConnectConfiguration,
} from "../../src/wallet/walletconnect-configuration.js";
import { createInspectionSuccess } from "../token-catalog/harness.js";

const directories: string[] = [];
const childProcesses: ChildProcess[] = [];
const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(resolve(tmpdir(), "littlejohn-runtime-"));
  directories.push(directory);
  return directory;
};
const observedAt = parseUtcTimestamp("2026-07-12T10:16:02.000Z");
const configurationMac = Buffer.alloc(32, 3).toString("base64url");
const configuredChainId = parseEvmChainId("eip155:4663");
const alternateChainId = parseEvmChainId("eip155:1");

const walletOperationAtBytes = (byteLength: number, operationByte: number) => {
  const operationId = Buffer.alloc(32, operationByte).toString("base64url");
  const create = (revision: string) => {
    const reviewWithoutDigest = {
      contractVersion: "1" as const,
      domain: "wallet" as const,
      operationId,
      kind: "connect" as const,
      createdAt: observedAt,
      actionExpiresAt: "2026-07-12T10:21:02.000Z",
      target: { chainId: configuredChainId },
      decision: {
        requiredMethods: ["eth_sendTransaction"] as const,
        requiredEvents: ["accountsChanged", "chainChanged"] as const,
      },
      precondition: {
        connectionRevision: revision,
        connection: { status: "disconnected" as const, reason: "no_session" as const },
      },
      fixedEvidence: { sessionSourceIds: [] as const },
    };
    const review = parseWalletReview({
      ...reviewWithoutDigest,
      reviewDigest: walletReviewDigest(reviewWithoutDigest),
    });
    return parseWalletManagementOperation({
      contractVersion: "1",
      domain: "wallet",
      operationId,
      kind: "connect",
      initiatedBy: "cli",
      review,
      state: "cancelled",
      terminationTarget: null,
      result: null,
      failure: null,
      peerRefusalCode: null,
    });
  };
  const baseline = create("1");
  const baselineBytes = Buffer.byteLength(
    canonicalJsonStringify(captureCanonicalJson(baseline)),
    "utf8",
  );
  const operation = create("9".repeat(1 + byteLength - baselineBytes));
  expect(Buffer.byteLength(
    canonicalJsonStringify(captureCanonicalJson(operation)),
    "utf8",
  )).toBe(byteLength);
  return operation;
};
const publicationStagingPath = (
  databasePath: string,
  tokenByte: number,
  suffix: "" | "-wal" | "-shm" = "",
): string => `${databasePath}.pending-2147483646-${Buffer.alloc(16, tokenByte).toString("base64url")}${suffix}`;

interface ExactFileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

const exactFileIdentity = async (path: string): Promise<ExactFileIdentity> => {
  const details = await lstat(path, { bigint: true });
  return Object.freeze({ device: details.dev, inode: details.ino });
};

const optionalExactFileIdentity = async (
  path: string,
): Promise<ExactFileIdentity | undefined> => {
  try { return await exactFileIdentity(path); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
};

afterEach(async () => {
  for (const child of childProcesses.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const expectRuntimeCode = async (
  operation: Promise<unknown>,
  code: string,
  label?: string,
): Promise<void> => {
  let failure: unknown;
  try { await operation; }
  catch (error) { failure = error; }
  expect(failure, label).toBeInstanceOf(RuntimeOperationError);
  expect((failure as RuntimeOperationError).failure.error.code, label).toBe(code);
};

const expectResetRequired = async (operation: Promise<unknown>): Promise<void> => {
  let failure: unknown;
  try { await operation; }
  catch (error) { failure = error; }
  const admitted = getRuntimeStateResetRequiredError(failure);
  expect(admitted).toBe(failure);
  expect(admitted).toMatchObject({
    name: "RuntimeStateResetRequiredError",
    code: runtimeStateResetRequiredCode,
    message: runtimeStateResetRequiredMessage,
  });
};

interface IndependentSqliteSchemaRow {
  readonly type: string;
  readonly name: string;
  readonly tableName: string;
  readonly sql: string | null;
}

interface ProjectedSqliteSchemaRow {
  readonly typeStorage: "text";
  readonly typeBytes: Buffer;
  readonly nameStorage: "text";
  readonly nameBytes: Buffer;
  readonly tableNameStorage: "text";
  readonly tableNameBytes: Buffer;
  readonly sqlStorage: "null" | "text";
  readonly sqlBytes: Buffer | null;
}

interface ObservedSqliteSchemaRead {
  readonly preparedSql: string[];
  readonly iterateParameters: (readonly unknown[])[];
  yieldedRows: number;
}

const expectedBoundedSqliteSchemaSelect = `SELECT
  typeof(type) AS typeStorage,
  substr(CAST(type AS BLOB), 1, ?) AS typeBytes,
  typeof(name) AS nameStorage,
  substr(CAST(name AS BLOB), 1, ?) AS nameBytes,
  typeof(tbl_name) AS tableNameStorage,
  substr(CAST(tbl_name AS BLOB), 1, ?) AS tableNameBytes,
  typeof(sql) AS sqlStorage,
  CASE WHEN sql IS NULL THEN NULL ELSE substr(CAST(sql AS BLOB), 1, ?) END AS sqlBytes
FROM sqlite_schema
LIMIT ?`;

const normalizeBoundedSqliteSchemaSelect = (sql: string): string =>
  sql.replace(/[\u0009-\u000d\u0020]+/gu, " ").trim();

const isExpectedBoundedSqliteSchemaSelect = (sql: string): boolean =>
  normalizeBoundedSqliteSchemaSelect(sql) ===
    normalizeBoundedSqliteSchemaSelect(expectedBoundedSqliteSchemaSelect);

const replaceExactSqlFragment = (
  sql: string,
  original: string,
  replacement: string,
): string => {
  const start = sql.indexOf(original);
  if (start === -1 || sql.indexOf(original, start + original.length) !== -1) {
    throw new TypeError("The test-owned SQL mutation target must occur exactly once.");
  }
  return `${sql.slice(0, start)}${replacement}${sql.slice(start + original.length)}`;
};

const rowLimitExpansionSql = replaceExactSqlFragment(
  expectedBoundedSqliteSchemaSelect,
  "LIMIT ?",
  "LIMIT ? + 1000",
);
const unreachableTypePrefixSql = replaceExactSqlFragment(
  expectedBoundedSqliteSchemaSelect,
  "substr(CAST(type AS BLOB), 1, ?) AS typeBytes",
  `CASE WHEN length(type) >= 0 THEN CAST(type AS BLOB)
    ELSE substr(CAST(type AS BLOB), 1, ?) END AS typeBytes`,
);
const boundedSqliteSchemaSelectMutants = Object.freeze([
  Object.freeze({ name: "expanded row limit", sql: rowLimitExpansionSql }),
  Object.freeze({ name: "unreachable type prefix", sql: unreachableTypePrefixSql }),
  Object.freeze({
    name: "row-hiding filter",
    sql: replaceExactSqlFragment(
      expectedBoundedSqliteSchemaSelect,
      "FROM sqlite_schema\nLIMIT ?",
      "FROM sqlite_schema\nWHERE name <> 'local_profile'\nLIMIT ?",
    ),
  }),
  Object.freeze({
    name: "unbounded ordering",
    sql: replaceExactSqlFragment(
      expectedBoundedSqliteSchemaSelect,
      "FROM sqlite_schema\nLIMIT ?",
      "FROM sqlite_schema\nORDER BY name\nLIMIT ?",
    ),
  }),
  Object.freeze({
    name: "changed storage-class probe",
    sql: replaceExactSqlFragment(
      expectedBoundedSqliteSchemaSelect,
      "typeof(type) AS typeStorage",
      "typeof(name) AS typeStorage",
    ),
  }),
  Object.freeze({
    name: "lost null preservation",
    sql: replaceExactSqlFragment(
      expectedBoundedSqliteSchemaSelect,
      "CASE WHEN sql IS NULL THEN NULL ELSE substr(CAST(sql AS BLOB), 1, ?) END AS sqlBytes",
      "COALESCE(substr(CAST(sql AS BLOB), 1, ?), X'') AS sqlBytes",
    ),
  }),
  Object.freeze({
    name: "changed result alias",
    sql: replaceExactSqlFragment(
      expectedBoundedSqliteSchemaSelect,
      "AS tableNameBytes",
      "AS otherTableNameBytes",
    ),
  }),
]);

const projectIndependentSqliteSchemaRow = (
  row: IndependentSqliteSchemaRow,
): ProjectedSqliteSchemaRow => ({
  typeStorage: "text",
  typeBytes: Buffer.from(row.type, "utf8"),
  nameStorage: "text",
  nameBytes: Buffer.from(row.name, "utf8"),
  tableNameStorage: "text",
  tableNameBytes: Buffer.from(row.tableName, "utf8"),
  sqlStorage: row.sql === null ? "null" : "text",
  sqlBytes: row.sql === null ? null : Buffer.from(row.sql, "utf8"),
});

const independentSqliteSchemaTupleBytes = (row: IndependentSqliteSchemaRow): number =>
  Buffer.byteLength(row.type, "utf8") +
  Buffer.byteLength(row.name, "utf8") +
  Buffer.byteLength(row.tableName, "utf8") +
  1 +
  (row.sql === null ? 0 : Buffer.byteLength(row.sql, "utf8"));

const createObservedSqliteSchemaDatabase = (
  rows: readonly (ProjectedSqliteSchemaRow | (() => never))[],
): Readonly<{
  database: Database.Database;
  observation: ObservedSqliteSchemaRead;
}> => {
  const observation: ObservedSqliteSchemaRead = {
    preparedSql: [],
    iterateParameters: [],
    yieldedRows: 0,
  };
  const statement = {
    all: (): never => {
      throw new Error("The bounded SQLite verifier must not materialize schema rows.");
    },
    iterate: (...parameters: readonly unknown[]): IterableIterator<ProjectedSqliteSchemaRow> => {
      observation.iterateParameters.push(Object.freeze([...parameters]));
      let index = 0;
      return {
        [Symbol.iterator]() { return this; },
        next(): IteratorResult<ProjectedSqliteSchemaRow> {
          const row = rows[index];
          index += 1;
          if (row === undefined) return { done: true, value: undefined };
          observation.yieldedRows += 1;
          return {
            done: false,
            value: typeof row === "function" ? row() : row,
          };
        },
      };
    },
  };
  const database = {
    prepare: (sql: string) => {
      observation.preparedSql.push(sql);
      return statement;
    },
  } as unknown as Database.Database;
  return Object.freeze({ database, observation });
};

const compareIndependentSchemaRows = (
  left: IndependentSqliteSchemaRow,
  right: IndependentSqliteSchemaRow,
): number => {
  for (const [leftValue, rightValue] of [
    [left.type, right.type],
    [left.name, right.name],
    [left.tableName, right.tableName],
  ] as const) {
    const comparison = Buffer.compare(Buffer.from(leftValue, "utf8"), Buffer.from(rightValue, "utf8"));
    if (comparison !== 0) return comparison;
  }
  if (left.sql === null || right.sql === null) {
    if (left.sql === right.sql) return 0;
    return left.sql === null ? -1 : 1;
  }
  return Buffer.compare(Buffer.from(left.sql, "utf8"), Buffer.from(right.sql, "utf8"));
};

const readIndependentSqliteSchema = (
  database: Database.Database,
): readonly IndependentSqliteSchemaRow[] =>
  Object.freeze((database.prepare(`SELECT type, name, tbl_name AS tableName, sql
    FROM sqlite_schema`).all() as IndependentSqliteSchemaRow[]).sort(compareIndependentSchemaRows));

const deriveIndependentCurrentSqliteSchema = (): readonly IndependentSqliteSchemaRow[] => {
  const database = new Database(":memory:");
  try {
    database.exec(currentSqliteSchemaSql);
    return readIndependentSqliteSchema(database);
  } finally {
    database.close();
  }
};

const maximumIndependentSqliteSchemaFieldBytes = (
  rows: readonly IndependentSqliteSchemaRow[],
  field: keyof IndependentSqliteSchemaRow,
): number => Math.max(...rows.map((row) => {
  const value = row[field];
  return value === null ? 0 : Buffer.byteLength(value, "utf8");
}));

const deriveIndependentSqliteSchemaReadParameters = (
  rows: readonly IndependentSqliteSchemaRow[],
): readonly [number, number, number, number, number] => Object.freeze([
  maximumIndependentSqliteSchemaFieldBytes(rows, "type") + 1,
  maximumIndependentSqliteSchemaFieldBytes(rows, "name") + 1,
  maximumIndependentSqliteSchemaFieldBytes(rows, "tableName") + 1,
  maximumIndependentSqliteSchemaFieldBytes(rows, "sql") + 1,
  rows.length + 1,
]);

const expectSingleObservedSqliteSchemaRead = (
  observation: ObservedSqliteSchemaRead,
  expectedParameters: readonly [number, number, number, number, number],
  label?: string,
): void => {
  expect(observation.preparedSql, label).toHaveLength(1);
  expect(observation.iterateParameters, label).toEqual([expectedParameters]);
};

const sqliteArtifactSnapshot = async (path: string): Promise<readonly {
  readonly suffix: string;
  readonly bytes?: string;
  readonly mode?: number;
  readonly type?: "file" | "link" | "other";
}[]> => Promise.all(["", "-wal", "-shm"].map(async (suffix) => {
  const artifact = `${path}${suffix}`;
  try {
    const details = await lstat(artifact);
    const type = details.isFile() ? "file" as const : details.isSymbolicLink() ? "link" as const : "other" as const;
    return {
      suffix,
      type,
      mode: details.mode & 0o777,
      ...(type === "file" ? { bytes: (await readFile(artifact)).toString("hex") } : {}),
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { suffix };
    throw error;
  }
}));

const sqliteDurableArtifactSnapshot = async (path: string) =>
  (await sqliteArtifactSnapshot(path)).filter((artifact) => artifact.suffix !== "-shm");

const launchSqliteCrashWorker = async (
  directory: string,
  mode: "committed" | "interrupted" | "catalog-interrupted" | "structural-mismatch" = "committed",
): Promise<ChildProcess> => {
  const workerPath = fileURLToPath(new URL("./sqlite-crash-worker.ts", import.meta.url));
  const child = fork(workerPath, [directory, mode], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  childProcesses.push(child);
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer | string) => { stderr += chunk.toString(); });
  await new Promise<void>((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error(`SQLite crash worker timed out.\n${stderr}`)), 10_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectReady(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      rejectReady(new Error(`SQLite crash worker exited (${String(code)}/${String(signal)}).\n${stderr}`));
    });
    child.on("message", (message: unknown) => {
      if (typeof message === "object" && message !== null && (message as { ready?: unknown }).ready === true) {
        clearTimeout(timer);
        resolveReady();
      }
    });
  });
  return child;
};

const killSqliteCrashWorker = async (child: ChildProcess): Promise<void> => {
  const exited = new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>((resolveExit) => {
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  if (!child.kill("SIGKILL")) throw new Error("SQLite crash worker could not be killed.");
  const result = await exited;
  if (process.platform !== "win32" && result.signal !== "SIGKILL") {
    throw new Error(`SQLite crash worker did not exit by SIGKILL (${String(result.code)}/${String(result.signal)}).`);
  }
};

const connectedInput = (expiresAt = "2026-07-18T17:39:16.000Z") => ({
  status: "connected" as const,
  address: "0x1111111111111111111111111111111111111111",
  chainId: configuredChainId,
  approvedMethods: ["eth_sendTransaction", "personal_sign"],
  approvedEvents: ["accountsChanged", "chainChanged"],
  expiresAt,
});

const connected = (expiresAt = "2026-07-18T17:39:16.000Z") =>
  parseCapabilityDataAt(walletConnectionCapability, connectedInput(expiresAt), observedAt);

const connectedFor = (chainId: string, address: string) =>
  parseCapabilityDataAt(walletConnectionCapability, {
    ...connectedInput(),
    chainId,
    address,
  }, observedAt);

describe("application data and local credential", () => {
  it("resolves fixed data locations and rejects an unsafe existing directory without repairing it", async () => {
    expect(resolveApplicationDataDirectory({}, "darwin", "/Users/test"))
      .toBe("/Users/test/Library/Application Support/Littlejohn");
    expect(resolveApplicationDataDirectory({}, "linux", "/home/test"))
      .toBe("/home/test/.local/state/littlejohn");
    expect(resolveApplicationDataDirectory({ XDG_STATE_HOME: "/state" }, "linux", "/home/test"))
      .toBe("/state/littlejohn");
    expect(resolveApplicationDataDirectory({ LOCALAPPDATA: "C:\\Local" }, "win32", "C:\\Users\\test"))
      .toContain("Littlejohn");
    expect(() => resolveApplicationDataDirectory({}, "win32", "C:\\Users\\test")).toThrow("LOCALAPPDATA");

    if (process.platform !== "win32") {
      const directory = await temporaryDirectory();
      await rm(directory, { recursive: true, force: true });
      await mkdir(directory, { mode: 0o755 });
      await expect(ensureOwnerOnlyDirectory(directory)).rejects.toThrow("owner-only");
      expect((await stat(directory)).mode & 0o077).not.toBe(0);
    }
  });

  it("publishes one complete credential atomically and exposes only verifier authority", async () => {
    const directory = await temporaryDirectory();
    const paths = runtimePaths(directory);
    let observing = true;
    const visibleContents: string[] = [];
    let resolveObserverReady!: () => void;
    let resolveFirstVisible!: () => void;
    const observerReady = new Promise<void>((resolveReady) => { resolveObserverReady = resolveReady; });
    const firstVisible = new Promise<void>((resolveVisible) => { resolveFirstVisible = resolveVisible; });
    const observer = (async () => {
      resolveObserverReady();
      while (observing) {
        try {
          visibleContents.push(await readFile(paths.controlCredential, "utf8"));
          resolveFirstVisible();
        }
        catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
        }
        await new Promise<void>((resolveTick) => setImmediate(resolveTick));
      }
    })();
    await observerReady;
    const authorities = await Promise.all(Array.from({ length: 16 }, () =>
      loadOrCreateControlCredential(directory, paths.controlCredential)));
    await firstVisible;
    observing = false;
    await observer;
    const content = await readFile(paths.controlCredential, "utf8");
    expect(content).toMatch(/^[A-Za-z0-9_-]{43}\n$/);
    expect(visibleContents.length).toBeGreaterThan(0);
    expect(visibleContents[0]).toBe(content);
    expect(visibleContents.every((value) => value === content)).toBe(true);
    const encoded = content.slice(0, -1);
    for (const authority of authorities) {
      const verifier = createControlCredentialVerifier(authority);
      expect(validateControlCredential(verifier, encoded)).toBe(true);
      expect(JSON.stringify(authority)).toBe("{}");
      expect(JSON.stringify(verifier)).toBe("{}");
    }
    expect((await readdir(directory)).filter((name) => name.includes(".pending-"))).toEqual([]);
    if (process.platform !== "win32") {
      expect((await stat(directory)).mode & 0o077).toBe(0);
      expect((await stat(paths.controlCredential)).mode & 0o177).toBe(0);
    }
  });

  it("does not repair, replace, follow, or chmod an existing credential", async () => {
    const directory = await temporaryDirectory();
    const paths = runtimePaths(directory);
    await ensureOwnerOnlyDirectory(directory);
    await writeFile(paths.controlCredential, "invalid\n", { encoding: "utf8", mode: 0o600 });
    const before = await exactFileIdentity(paths.controlCredential);
    await expectRuntimeCode(
      loadOrCreateControlCredential(directory, paths.controlCredential),
      "runtime_state_unavailable",
    );
    expect(await readFile(paths.controlCredential, "utf8")).toBe("invalid\n");
    expect(await exactFileIdentity(paths.controlCredential)).toEqual(before);

    if (process.platform !== "win32") {
      const weakDirectory = await temporaryDirectory();
      const weakPaths = runtimePaths(weakDirectory);
      const valid = `${Buffer.alloc(32, 1).toString("base64url")}\n`;
      await writeFile(weakPaths.controlCredential, valid, { encoding: "utf8", mode: 0o644 });
      await expectRuntimeCode(
        loadOrCreateControlCredential(weakDirectory, weakPaths.controlCredential),
        "runtime_state_unavailable",
      );
      expect((await stat(weakPaths.controlCredential)).mode & 0o177).not.toBe(0);

      const linkDirectory = await temporaryDirectory();
      const linkPaths = runtimePaths(linkDirectory);
      const target = resolve(linkDirectory, "target");
      await writeFile(target, valid, { encoding: "utf8", mode: 0o600 });
      await symlink(target, linkPaths.controlCredential);
      await expectRuntimeCode(
        loadOrCreateControlCredential(linkDirectory, linkPaths.controlCredential),
        "runtime_state_unavailable",
      );
      expect(await readFile(target, "utf8")).toBe(valid);
    }
  });

  it("rejects an oversized credential before decoding and leaves it unchanged", async () => {
    const directory = await temporaryDirectory();
    const paths = runtimePaths(directory);
    await ensureOwnerOnlyDirectory(directory);
    const oversized = Buffer.alloc(1024 * 1024, 0x41);
    await writeFile(paths.controlCredential, oversized, { mode: 0o600 });
    await expectRuntimeCode(
      loadOrCreateControlCredential(directory, paths.controlCredential),
      "runtime_state_unavailable",
    );
    expect((await stat(paths.controlCredential)).size).toBe(oversized.length);
    expect((await readFile(paths.controlCredential)).equals(oversized)).toBe(true);
  });

  it("creates owner-only state inodes without replacement independently of the umask", async () => {
    if (process.platform === "win32") return;
    const directory = await temporaryDirectory();
    await ensureOwnerOnlyDirectory(directory);
    for (const [name, umask] of [["permissive", 0], ["restrictive", 0o777]] as const) {
      const path = resolve(directory, `${name}-state-file`);
      const previousUmask = process.umask(umask);
      try {
        await createOwnerOnlyStateFile(path);
      } finally {
        process.umask(previousUmask);
      }
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      await expect(createOwnerOnlyStateFile(path)).rejects.toMatchObject({ code: "EEXIST" });
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  it("compares the complete bigint file identity without a safe-integer projection", () => {
    const baseline = Object.freeze({ device: 7n, inode: 9_007_199_254_740_992n });
    expect(sameOwnerOnlyStateFileIdentity(baseline, baseline)).toBe(true);
    expect(sameOwnerOnlyStateFileIdentity(
      baseline,
      Object.freeze({ device: 7n, inode: 9_007_199_254_740_993n }),
    )).toBe(false);
    expect(sameOwnerOnlyStateFileIdentity(
      baseline,
      Object.freeze({ device: 8n, inode: baseline.inode }),
    )).toBe(false);
  });

  it("binds WalletConnect private-directory preparation to the owner lifecycle", async () => {
    const directory = await temporaryDirectory();
    const activeController = new AbortController();
    const path = resolve(directory, "wallet-private");
    const port = createWalletPrivateStoreDirectoryPort(path, activeController.signal);
    expect(await port.ensureDirectory()).toBe(path);
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o077).toBe(0);
    activeController.abort();
    await expectRuntimeCode(port.ensureDirectory(), "request_aborted");

    const stoppedController = new AbortController();
    stoppedController.abort();
    const unusedPath = resolve(directory, "wallet-private-unused");
    await expectRuntimeCode(
      createWalletPrivateStoreDirectoryPort(unusedPath, stoppedController.signal).ensureDirectory(),
      "request_aborted",
    );
    await expect(lstat(unusedPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("SQLite product state", () => {
  it("admits Wallet operation bytes before materialization at the exact row boundary", async () => {
    expect(persistedOperationJsonLimits).toMatchObject({ walletBytes: 65_535 });
    const exact = walletOperationAtBytes(65_535, 41);
    const oneOver = walletOperationAtBytes(65_536, 42);
    const directory = await temporaryDirectory();
    await ensureOwnerOnlyDirectory(directory);
    const path = runtimePaths(directory).database;
    const initialized = await ProductDatabase.open(path, observedAt);
    const profileId = initialized.ownerStore().readProfile().profileId;
    initialized.close();

    const raw = new Database(path);
    const insert = raw.prepare(`INSERT INTO wallet_operation(
      profile_id, operation_id, kind, initiated_by, review_digest,
      connection_revision, state, created_at, action_expires_at, operation_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const parameters = (operation: typeof exact) => [
      profileId,
      operation.operationId,
      operation.kind,
      operation.initiatedBy,
      operation.review.reviewDigest,
      operation.review.precondition.connectionRevision,
      operation.state,
      operation.review.createdAt,
      operation.review.actionExpiresAt,
      Buffer.from(canonicalJsonStringify(captureCanonicalJson(operation)), "utf8"),
    ] as const;
    insert.run(...parameters(exact));
    expect(() => insert.run(...parameters(oneOver))).toThrow(/CHECK constraint failed/u);
    raw.pragma("ignore_check_constraints = ON");
    insert.run(...parameters(oneOver));
    raw.close();

    await expectRuntimeCode(
      ProductDatabase.open(path, observedAt),
      "runtime_state_unavailable",
    );
  });

  it("preserves the independent canonical SQLite schema bytes", () => {
    expect(Buffer.byteLength(currentSqliteSchemaSql, "utf8")).toBe(19_990);
    expect(createHash("sha256").update(currentSqliteSchemaSql, "utf8").digest("hex")).toBe(
      "0bb8353e72c91d9cfde925e1ba24c2904df8f3b44df8ae75778533e077a06ce0",
    );
    const structure = JSON.stringify(deriveIndependentCurrentSqliteSchema());
    expect(createHash("sha256").update(structure, "utf8").digest("hex")).toBe(
      "b6789f3c3bde8045d2611002068db8ab838ae5a4de44689410fd592dc0a3bb6a",
    );
  });

  it("compares the complete current SQLite structure within independently derived bounds", () => {
    const openCurrent = (): Database.Database => {
      const database = new Database(":memory:");
      database.exec(currentSqliteSchemaSql);
      return database;
    };
    const currentRows = deriveIndependentCurrentSqliteSchema();
    const maximumBytes = (field: keyof IndependentSqliteSchemaRow): number => Math.max(
      ...currentRows.map((row) => {
        const value = row[field];
        return value === null ? 0 : Buffer.byteLength(value, "utf8");
      }),
    );

    const exact = openCurrent();
    expect(hasExactCurrentSqliteStructure(exact)).toBe(true);
    exact.unsafeMode(true);
    exact.exec("PRAGMA writable_schema = ON");
    exact.prepare("UPDATE sqlite_schema SET rootpage = rootpage + 1000 WHERE rootpage > 0").run();
    expect(hasExactCurrentSqliteStructure(exact)).toBe(true);
    exact.close();

    for (const statement of [
      "CREATE TABLE additional_table(value TEXT)",
      "CREATE VIEW additional_view AS SELECT 1 AS value",
      "CREATE TRIGGER additional_trigger AFTER UPDATE ON local_profile BEGIN SELECT 1; END",
      "CREATE INDEX additional_index ON local_profile(created_at)",
      "DROP INDEX wallet_operation_one_active",
      "DROP INDEX account_token_selection_token_fk; CREATE INDEX account_token_selection_token_fk ON account_token_selection(token_address)",
    ]) {
      const candidate = openCurrent();
      candidate.exec(statement);
      expect(hasExactCurrentSqliteStructure(candidate), statement).toBe(false);
      candidate.close();
    }

    const generated = openCurrent();
    const generatedRow = currentRows.find((row) => row.type === "index" && row.sql === null);
    if (generatedRow === undefined) throw new TypeError("Current SQLite schema has no generated index row.");
    generated.unsafeMode(true);
    generated.exec("PRAGMA writable_schema = ON");
    generated.prepare("UPDATE sqlite_schema SET name = name || 'x' WHERE type = 'index' AND name = ?")
      .run(generatedRow.name);
    expect(hasExactCurrentSqliteStructure(generated)).toBe(false);
    generated.close();

    for (const [field, column, condition] of [
      ["type", "type", "1 = 1"],
      ["name", "name", "1 = 1"],
      ["tableName", "tbl_name", "1 = 1"],
      ["sql", "sql", "sql IS NOT NULL"],
    ] as const) {
      const candidate = openCurrent();
      candidate.unsafeMode(true);
      candidate.exec("PRAGMA writable_schema = ON");
      candidate.prepare(`UPDATE sqlite_schema SET ${column} = ?
        WHERE rowid = (SELECT rowid FROM sqlite_schema WHERE ${condition} LIMIT 1)`)
        .run("x".repeat(maximumBytes(field) + 1));
      expect(hasExactCurrentSqliteStructure(candidate), field).toBe(false);
      candidate.close();
    }

    const cumulative = openCurrent();
    cumulative.unsafeMode(true);
    cumulative.exec("PRAGMA writable_schema = ON");
    cumulative.prepare(`UPDATE sqlite_schema SET
      type = ?, name = ?, tbl_name = ?,
      sql = CASE WHEN sql IS NULL THEN NULL ELSE ? END`).run(
      "x".repeat(maximumBytes("type")),
      "x".repeat(maximumBytes("name")),
      "x".repeat(maximumBytes("tableName")),
      "x".repeat(maximumBytes("sql")),
    );
    expect(hasExactCurrentSqliteStructure(cumulative)).toBe(false);
    cumulative.close();
  });

  it("uses one complete bounded schema statement with independently derived binds", () => {
    const currentRows = deriveIndependentCurrentSqliteSchema();
    const projectedRows = currentRows.map(projectIndependentSqliteSchemaRow);
    const expectedParameters = deriveIndependentSqliteSchemaReadParameters(currentRows);

    const exact = createObservedSqliteSchemaDatabase(projectedRows);
    expect(hasExactCurrentSqliteStructure(exact.database)).toBe(true);
    expectSingleObservedSqliteSchemaRead(exact.observation, expectedParameters);
    const [capturedSql] = exact.observation.preparedSql;
    if (capturedSql === undefined) throw new TypeError("The SQLite schema statement was not observed.");
    expect(isExpectedBoundedSqliteSchemaSelect(capturedSql)).toBe(true);
    expect(exact.observation.yieldedRows).toBe(currentRows.length);

    for (const mutant of boundedSqliteSchemaSelectMutants) {
      expect(isExpectedBoundedSqliteSchemaSelect(mutant.sql), mutant.name).toBe(false);
    }
  });

  it("bounds schema rows and field bytes inside SQLite before admission", () => {
    const currentRows = deriveIndependentCurrentSqliteSchema();
    const expectedParameters = deriveIndependentSqliteSchemaReadParameters(currentRows);
    const observed = createObservedSqliteSchemaDatabase(
      currentRows.map(projectIndependentSqliteSchemaRow),
    );
    expect(hasExactCurrentSqliteStructure(observed.database)).toBe(true);
    expectSingleObservedSqliteSchemaRead(observed.observation, expectedParameters);
    const [capturedSql] = observed.observation.preparedSql;
    if (capturedSql === undefined || !isExpectedBoundedSqliteSchemaSelect(capturedSql)) {
      throw new TypeError("The exact bounded SQLite schema statement was not observed.");
    }

    const rowFixture = new Database(":memory:");
    try {
      rowFixture.exec(currentSqliteSchemaSql);
      for (let index = 0; index < expectedParameters[4] + 4; index += 1) {
        rowFixture.exec(`CREATE TABLE extra_schema_row_${index}(value TEXT)`);
      }
      const raw = rowFixture.prepare(
        "SELECT count(*) AS rowCount FROM sqlite_schema",
      ).get() as { readonly rowCount: number };
      expect(raw.rowCount).toBeGreaterThan(expectedParameters[4]);
      expect(rowFixture.prepare(capturedSql).all(...expectedParameters))
        .toHaveLength(expectedParameters[4]);
      expect(rowFixture.prepare(rowLimitExpansionSql).all(...expectedParameters))
        .toHaveLength(raw.rowCount);
    } finally {
      rowFixture.close();
    }

    for (const [field, column, bytesField, condition] of [
      ["type", "type", "typeBytes", "1 = 1"],
      ["name", "name", "nameBytes", "1 = 1"],
      ["tableName", "tbl_name", "tableNameBytes", "1 = 1"],
      ["sql", "sql", "sqlBytes", "sql IS NOT NULL"],
    ] as const) {
      const fieldFixture = new Database(":memory:");
      try {
        fieldFixture.exec(currentSqliteSchemaSql);
        fieldFixture.unsafeMode(true);
        fieldFixture.exec("PRAGMA writable_schema = ON");
        const referenceMaximum = maximumIndependentSqliteSchemaFieldBytes(currentRows, field);
        const oversizedByteLength = Math.max(64 * 1024, referenceMaximum + 2);
        fieldFixture.prepare(`UPDATE sqlite_schema SET ${column} = ?
          WHERE rowid = (SELECT rowid FROM sqlite_schema WHERE ${condition} LIMIT 1)`)
          .run("x".repeat(oversizedByteLength));
        const raw = fieldFixture.prepare(`SELECT CAST(${column} AS BLOB) AS bytes
          FROM sqlite_schema WHERE ${condition} LIMIT 1`).get() as { readonly bytes: Buffer };
        expect(Buffer.isBuffer(raw.bytes), field).toBe(true);
        expect(raw.bytes.length, field).toBe(oversizedByteLength);

        const boundedRows = fieldFixture.prepare(capturedSql)
          .all(...expectedParameters) as ProjectedSqliteSchemaRow[];
        expect(boundedRows, field).toHaveLength(currentRows.length);
        const largestReturnedField = boundedRows.reduce((largest, row) => {
          const bytes = row[bytesField];
          return Math.max(largest, bytes?.length ?? 0);
        }, 0);
        expect(largestReturnedField, field).toBe(referenceMaximum + 1);

        if (field === "type") {
          const unboundedRows = fieldFixture.prepare(unreachableTypePrefixSql)
            .all(...expectedParameters) as ProjectedSqliteSchemaRow[];
          expect(unboundedRows.reduce(
            (largest, row) => Math.max(largest, row.typeBytes.length),
            0,
          )).toBe(oversizedByteLength);
        }
      } finally {
        fieldFixture.close();
      }
    }
  });

  it("stops schema consumption immediately after every decisive rejection", () => {
    const currentRows = deriveIndependentCurrentSqliteSchema();
    const projectedRows = currentRows.map(projectIndependentSqliteSchemaRow);
    const expectedParameters = deriveIndependentSqliteSchemaReadParameters(currentRows);
    const maximumBytes = (field: keyof IndependentSqliteSchemaRow): number =>
      maximumIndependentSqliteSchemaFieldBytes(currentRows, field);
    const neverConsume = (): never => {
      throw new Error("The bounded SQLite verifier consumed rows after its result was known.");
    };

    const exact = createObservedSqliteSchemaDatabase(projectedRows);
    expect(hasExactCurrentSqliteStructure(exact.database)).toBe(true);
    expectSingleObservedSqliteSchemaRead(exact.observation, expectedParameters);
    expect(exact.observation.yieldedRows).toBe(currentRows.length);

    const rowOverflow = createObservedSqliteSchemaDatabase([
      ...projectedRows,
      projectedRows[0] as ProjectedSqliteSchemaRow,
      neverConsume,
    ]);
    expect(hasExactCurrentSqliteStructure(rowOverflow.database)).toBe(false);
    expectSingleObservedSqliteSchemaRead(rowOverflow.observation, expectedParameters, "row count");
    expect(rowOverflow.observation.yieldedRows).toBe(currentRows.length + 1);

    for (const [field, bytesField] of [
      ["type", "typeBytes"],
      ["name", "nameBytes"],
      ["tableName", "tableNameBytes"],
      ["sql", "sqlBytes"],
    ] as const) {
      const first = projectedRows[0];
      if (first === undefined) throw new TypeError("Current SQLite schema is empty.");
      const invalid = {
        ...first,
        [bytesField]: Buffer.alloc(maximumBytes(field) + 1, 0x78),
        ...(field === "sql" ? { sqlStorage: "text" as const } : {}),
      } as ProjectedSqliteSchemaRow;
      const fieldOverflow = createObservedSqliteSchemaDatabase([invalid, neverConsume]);
      expect(hasExactCurrentSqliteStructure(fieldOverflow.database), field).toBe(false);
      expectSingleObservedSqliteSchemaRead(fieldOverflow.observation, expectedParameters, field);
      expect(fieldOverflow.observation.yieldedRows, field).toBe(1);
    }

    const totalReferenceBytes = currentRows.reduce(
      (total, row) => total + independentSqliteSchemaTupleBytes(row),
      0,
    );
    const expandable = currentRows.flatMap((row, index) => ([
      ["type", "typeBytes"],
      ["name", "nameBytes"],
      ["tableName", "tableNameBytes"],
      ["sql", "sqlBytes"],
    ] as const).flatMap(([field, bytesField]) => {
      const value = row[field];
      return value !== null && Buffer.byteLength(value, "utf8") < maximumBytes(field)
        ? [{ index, bytesField }]
        : [];
    }))[0];
    if (expandable === undefined) {
      throw new TypeError("Current SQLite schema has no independently expandable bounded field.");
    }
    const aggregateRows = projectedRows.map((row, index) => index === expandable.index
      ? {
          ...row,
          [expandable.bytesField]: Buffer.concat([
            row[expandable.bytesField] as Buffer,
            Buffer.from("x"),
          ]),
        }
      : row);
    const aggregateBytes = aggregateRows.reduce((total, row) =>
      total + row.typeBytes.length + row.nameBytes.length + row.tableNameBytes.length + 1 +
      (row.sqlBytes?.length ?? 0), 0);
    expect(aggregateBytes).toBe(totalReferenceBytes + 1);
    const aggregateOverflow = createObservedSqliteSchemaDatabase([
      ...aggregateRows,
      neverConsume,
    ]);
    expect(hasExactCurrentSqliteStructure(aggregateOverflow.database)).toBe(false);
    expectSingleObservedSqliteSchemaRead(
      aggregateOverflow.observation,
      expectedParameters,
      "aggregate bytes",
    );
    expect(aggregateOverflow.observation.yieldedRows).toBe(currentRows.length);
  });

  it("exposes catalog queries through a runtime object without mutation methods", async () => {
    const directory = await temporaryDirectory();
    await ensureOwnerOnlyDirectory(directory);
    const database = await ProductDatabase.open(runtimePaths(directory).database, observedAt);

    const queries = database.tokenCatalogReadStore();
    expect(Object.isFrozen(queries)).toBe(true);
    expect(Reflect.ownKeys(queries).sort()).toEqual([
      "getSelection",
      "getSelectionState",
      "listSelections",
    ]);
    expect(queries).not.toBe(database.tokenCatalogStore());
    expect("register" in queries).toBe(false);
    expect("update" in queries).toBe(false);
    expect("unregister" in queries).toBe(false);

    database.close();
  });

  it("uses one canonical runtime identity authority for stored owner identity", async () => {
    const profileId = createProfileId();
    const ownerInstanceId = createOwnerInstanceId();
    expect(parseProfileId(profileId)).toBe(profileId);
    expect(parseOwnerInstanceId(ownerInstanceId)).toBe(ownerInstanceId);
    expect(parseRuntimeRevision("0")).toBe("0");
    const noncanonicalTail = `${"A".repeat(21)}B`;
    expect(() => parseProfileId(noncanonicalTail)).toThrow();
    expect(() => parseOwnerInstanceId(noncanonicalTail)).toThrow();
    expect(() => parseRuntimeRevision("01")).toThrow();

    const directory = await temporaryDirectory();
    await ensureOwnerOnlyDirectory(directory);
    const database = await ProductDatabase.open(runtimePaths(directory).database, observedAt);
    const record = database.ownerStore().publishOwner(ownerInstanceId, configurationMac, observedAt);
    expect(record).toMatchObject({
      profileId: database.ownerStore().readProfile().profileId,
      ownerInstanceId,
      configurationMac,
      ownerRevision: "1",
    });
    database.close();
  });

  it("publishes one complete current-schema database and preserves one profile", async () => {
    const directory = await temporaryDirectory();
    await ensureOwnerOnlyDirectory(directory);
    const path = runtimePaths(directory).database;
    const databases = await Promise.all(Array.from({ length: 4 }, () => ProductDatabase.open(path, observedAt)));
    const profiles = databases.map((database) => database.ownerStore().readProfile());
    expect(new Set(profiles.map((profile) => profile.profileId)).size).toBe(1);
    for (const database of databases) {
      expect(database.walletStore().read()).toEqual({
        revision: "0",
        connection: { status: "unknown", reason: "reconciling" },
        revalidationRequired: false,
        updatedAt: observedAt,
      });
      database.close();
    }
    const inspection = new Database(path, { readonly: true });
    expect(inspection.pragma("user_version", { simple: true })).toBe(1);
    expect(readIndependentSqliteSchema(inspection)).toEqual(deriveIndependentCurrentSqliteSchema());
    const walletColumns = inspection.pragma("table_xinfo(current_wallet_connection)") as
      Array<{ name: string }>;
    expect(walletColumns.map((column) => column.name)).toEqual([
      "singleton",
      "profile_id",
      "revision",
      "revalidation_required",
      "status",
      "reason",
      "chain_id",
      "wallet_address",
      "approved_methods_json",
      "approved_events_json",
      "expires_at",
      "session_count",
      "updated_at",
    ]);
    inspection.close();
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  it("admits an exact-current main-only database before any product access", async () => {
    const directory = await temporaryDirectory();
    await ensureOwnerOnlyDirectory(directory);
    const path = runtimePaths(directory).database;
    const created = await ProductDatabase.open(path, observedAt);
    const expectedProfile = created.ownerStore().readProfile();
    created.close();

    const before = await sqliteArtifactSnapshot(path);
    expect(before).toEqual([
      expect.objectContaining({
        suffix: "",
        type: "file",
        mode: process.platform === "win32" ? expect.any(Number) : 0o600,
      }),
      { suffix: "-wal" },
      { suffix: "-shm" },
    ]);
    const mainBefore = await exactFileIdentity(path);
    const mainBytesBefore = await readFile(path);

    const reopened = await ProductDatabase.open(path, observedAt);
    expect(reopened.ownerStore().readProfile()).toEqual(expectedProfile);
    expect(await exactFileIdentity(path)).toEqual(mainBefore);
    expect((await readFile(path)).equals(mainBytesBefore)).toBe(true);
    const wal = await lstat(`${path}-wal`);
    const sharedMemory = await lstat(`${path}-shm`);
    expect(wal.isFile()).toBe(true);
    expect(wal.size).toBe(0);
    expect(sharedMemory.isFile()).toBe(true);
    if (process.platform !== "win32") {
      expect(wal.mode & 0o777).toBe(0o600);
      expect(sharedMemory.mode & 0o777).toBe(0o600);
      expect(wal.uid).toBe(process.getuid?.());
      expect(sharedMemory.uid).toBe(process.getuid?.());
    }
    reopened.close();
  });

  it("uses the exact current relational options and declared foreign-key deletion behavior", async () => {
    const directory = await temporaryDirectory();
    await ensureOwnerOnlyDirectory(directory);
    const path = runtimePaths(directory).database;
    const database = await ProductDatabase.open(path, observedAt);
    database.close();

    const inspection = new Database(path, { readonly: true });
    const tableOptions = (inspection.pragma("table_list") as {
      name: string;
      type: string;
      wr: number;
      strict: number;
    }[]).filter((row) => row.type === "table" && !row.name.startsWith("sqlite_"));
    expect(tableOptions.map(({ name, wr, strict }) => ({ name, wr, strict })).sort((a, b) =>
      a.name.localeCompare(b.name))).toEqual([
      { name: "account", wr: 1, strict: 1 },
      { name: "account_token_selection", wr: 1, strict: 1 },
      { name: "account_token_selection_state", wr: 1, strict: 1 },
      { name: "chain", wr: 1, strict: 1 },
      { name: "contract", wr: 1, strict: 1 },
      { name: "current_wallet_connection", wr: 0, strict: 1 },
      { name: "local_profile", wr: 0, strict: 1 },
      { name: "presentation_snapshot", wr: 1, strict: 1 },
      { name: "robinhood_asset", wr: 1, strict: 1 },
      { name: "robinhood_asset_snapshot", wr: 1, strict: 1 },
      { name: "runtime_owner", wr: 0, strict: 1 },
      { name: "token_contract", wr: 1, strict: 1 },
      { name: "token_contract_inspection", wr: 1, strict: 1 },
      { name: "token_selection_operation", wr: 1, strict: 1 },
      { name: "wallet_operation", wr: 1, strict: 1 },
    ]);
    expect((inspection.pragma("table_xinfo(token_contract_inspection)") as Array<{
      name: string;
      type: string;
      notnull: number;
    }>).map(({ name, type, notnull }) => ({ name, type, notnull }))).toEqual([
      { name: "chain_id", type: "TEXT", notnull: 1 },
      { name: "contract_address", type: "TEXT", notnull: 1 },
      { name: "inspection_digest", type: "TEXT", notnull: 1 },
      { name: "result_bytes", type: "BLOB", notnull: 1 },
    ]);
    expect((inspection.pragma("table_xinfo(account_token_selection)") as Array<{
      name: string;
      type: string;
      notnull: number;
    }>).map(({ name, type, notnull }) => ({ name, type, notnull }))).toContainEqual(
      { name: "inspection_digest", type: "TEXT", notnull: 0 },
    );
    for (const table of [
      "runtime_owner",
      "robinhood_asset_snapshot",
      "contract",
      "token_contract",
      "token_contract_inspection",
      "token_selection_operation",
      "account",
      "wallet_operation",
      "account_token_selection_state",
      "account_token_selection",
      "current_wallet_connection",
    ]) {
      const foreignKeys = inspection.pragma(`foreign_key_list(${table})`) as {
        on_update: string;
        on_delete: string;
      }[];
      expect(foreignKeys.length, table).toBeGreaterThan(0);
      expect(foreignKeys.every((key) => key.on_update === "RESTRICT" && key.on_delete === "RESTRICT"), table)
        .toBe(true);
    }
    const officialAssetKeys = inspection.pragma("foreign_key_list(robinhood_asset)") as {
      on_update: string;
      on_delete: string;
    }[];
    expect(officialAssetKeys).toEqual([
      expect.objectContaining({ on_update: "RESTRICT", on_delete: "CASCADE" }),
    ]);
    expect(inspection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(inspection.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
    inspection.close();
  });

  it("proves bundled SQLite NUL behavior and rejects it through the shared SQL check", () => {
    const database = new Database(":memory:");
    const value = "eip155:4663\0suffix";
    const observed = database.prepare(`SELECT hex(?) AS encoded, length(?) AS textLength,
      instr(?, char(0)) AS nulPosition`).get(value, value, value) as {
      encoded: string;
      textLength: number;
      nulPosition: number;
    };
    expect(observed.encoded).toBe(Buffer.from(value, "utf8").toString("hex").toUpperCase());
    expect(observed.textLength).toBe("eip155:4663".length);
    expect(observed.nulPosition).toBe("eip155:4663".length + 1);
    database.exec(`CREATE TABLE checked_text(value TEXT NOT NULL CHECK (${canonicalSqlTextCheck("value")})) STRICT`);
    expect(() => database.prepare("INSERT INTO checked_text(value) VALUES (?)").run(value)).toThrow();
    database.close();
  });

  it("accepts only canonical base64url terminal characters for 16-byte and 32-byte schema values", () => {
    const database = new Database(":memory:");
    const base64UrlAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const checks = [
      { byteLength: 16, check: canonicalRuntimeIdentifierSqlCheck },
      { byteLength: 16, check: canonicalOfficialAssetSnapshotRevisionSqlCheck },
      { byteLength: 16, check: canonicalSelectionRevisionSqlCheck },
      { byteLength: 32, check: canonicalRuntimeConfigurationMacSqlCheck },
    ] as const;

    for (const [index, { byteLength, check }] of checks.entries()) {
      const table = `canonical_base64url_${index}`;
      database.exec(`CREATE TABLE ${table}(value TEXT NOT NULL CHECK (${check("value")})) STRICT`);
      const insert = database.prepare(`INSERT INTO ${table}(value) VALUES (?)`);
      const encodedLength = Buffer.alloc(byteLength).toString("base64url").length;
      const canonicalTerminalCharacters = new Set(Array.from({ length: 256 }, (_, lastByte) => {
        const bytes = Buffer.alloc(byteLength);
        bytes[byteLength - 1] = lastByte;
        return bytes.toString("base64url").at(-1);
      }));

      for (const terminalCharacter of base64UrlAlphabet) {
        const value = `${"A".repeat(encodedLength - 1)}${terminalCharacter}`;
        if (canonicalTerminalCharacters.has(terminalCharacter)) {
          expect(() => insert.run(value), `${byteLength} bytes ending in ${terminalCharacter}`).not.toThrow();
        } else {
          expect(() => insert.run(value), `${byteLength} bytes ending in ${terminalCharacter}`).toThrow();
        }
      }
    }

    database.close();
  });

  it("rejects embedded NUL across actual identity, owner, revision, count, and address columns", async () => {
    const directory = await temporaryDirectory();
    await ensureOwnerOnlyDirectory(directory);
    const path = runtimePaths(directory).database;
    const database = await ProductDatabase.open(path, observedAt);
    database.configuredChainStore().insertConfiguredChainIfAbsent(configuredChainId);
    const profileId = database.ownerStore().readProfile().profileId;
    database.close();

    const raw = new Database(path);
    raw.pragma("foreign_keys = ON");
    expect(() => raw.prepare("UPDATE local_profile SET profile_id = ? WHERE singleton = 1")
      .run(`${profileId}\0suffix`)).toThrow();
    expect(() => raw.prepare("INSERT INTO chain(chain_id) VALUES (?)")
      .run(`${configuredChainId}\0suffix`)).toThrow();
    expect(() => raw.prepare(`INSERT INTO runtime_owner(singleton, profile_id, owner_instance_id,
      configuration_mac, process_id, owner_revision, acquired_at)
      VALUES (1, ?, ?, ?, 1, '0', ?)`)
      .run(profileId, `${createOwnerInstanceId()}\0suffix`, configurationMac, observedAt)).toThrow();
    expect(() => raw.prepare(`INSERT INTO runtime_owner(singleton, profile_id, owner_instance_id,
      configuration_mac, process_id, owner_revision, acquired_at)
      VALUES (1, ?, ?, ?, 1, '0', ?)`)
      .run(profileId, createOwnerInstanceId(), `${configurationMac}\0suffix`, observedAt)).toThrow();
    expect(() => raw.prepare("UPDATE current_wallet_connection SET revision = ? WHERE singleton = 1")
      .run("1\0suffix")).toThrow();
    expect(() => raw.prepare(`UPDATE current_wallet_connection SET status = 'unresolved', reason = NULL,
      session_count = ?, chain_id = NULL, wallet_address = NULL, approved_methods_json = NULL,
      approved_events_json = NULL, expires_at = NULL WHERE singleton = 1`)
      .run("2\0suffix")).toThrow();
    expect(() => raw.prepare("UPDATE current_wallet_connection SET reason = 'no_session' WHERE singleton = 1")
      .run()).toThrow();
    expect(() => raw.prepare(`UPDATE current_wallet_connection SET status = 'unresolved', reason = NULL,
      session_count = '0', chain_id = NULL, wallet_address = NULL, approved_methods_json = NULL,
      approved_events_json = NULL, expires_at = NULL WHERE singleton = 1`).run()).toThrow();
    expect(() => raw.prepare(
      "UPDATE current_wallet_connection SET revalidation_required = 2 WHERE singleton = 1",
    ).run()).toThrow();
    expect(() => raw.prepare(
      "UPDATE current_wallet_connection SET revalidation_required = NULL WHERE singleton = 1",
    ).run()).toThrow();
    expect(() => raw.prepare(`INSERT INTO account(profile_id, chain_id, account_address)
      VALUES (?, ?, ?)`)
      .run(profileId, configuredChainId, "0x1111111111111111111111111111111111111111\0suffix")).toThrow();
    expect(() => raw.prepare("INSERT INTO contract(chain_id, contract_address) VALUES (?, ?)")
      .run("eip155:10", "0x1111111111111111111111111111111111111111")).toThrow();
    expect(raw.prepare("SELECT COUNT(*) AS count FROM account").get()).toEqual({ count: 0 });
    raw.close();
  });

  it("does not treat user_version as current-structure authority", async () => {
    const directory = await temporaryDirectory();
    await ensureOwnerOnlyDirectory(directory);
    const path = runtimePaths(directory).database;
    const initialized = await ProductDatabase.open(path, observedAt);
    initialized.close();

    const raw = new Database(path);
    raw.pragma("user_version = 73");
    raw.close();
    if (process.platform !== "win32") await chmod(path, 0o600);

    const reopened = await ProductDatabase.open(path, observedAt);
    reopened.close();
    const inspection = new Database(path, { readonly: true });
    expect(inspection.pragma("user_version", { simple: true })).toBe(73);
    expect(readIndependentSqliteSchema(inspection)).toEqual(deriveIndependentCurrentSqliteSchema());
    inspection.close();
  });

  it("rejects a clean structural mismatch without repairing product state", async () => {
    const directory = await temporaryDirectory();
    await ensureOwnerOnlyDirectory(directory);
    const path = runtimePaths(directory).database;
    const initialized = await ProductDatabase.open(path, observedAt);
    initialized.close();

    const incompatible = new Database(path);
    incompatible.exec("CREATE TABLE unexpected_structure(value TEXT)");
    incompatible.close();
    if (process.platform !== "win32") await chmod(path, 0o600);
    const beforeMain = await exactFileIdentity(path);
    const beforeBytes = await readFile(path);
    await expect(lstat(`${path}-wal`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(`${path}-shm`)).rejects.toMatchObject({ code: "ENOENT" });

    await expectResetRequired(ProductDatabase.open(path, observedAt));
    expect(await exactFileIdentity(path)).toEqual(beforeMain);
    expect((await readFile(path)).equals(beforeBytes)).toBe(true);
    const firstArtifacts = await sqliteArtifactSnapshot(path);
    expect(firstArtifacts).toEqual([
      expect.objectContaining({ suffix: "", type: "file", mode: process.platform === "win32" ? expect.any(Number) : 0o600 }),
      expect.objectContaining({ suffix: "-wal", type: "file", bytes: "", mode: process.platform === "win32" ? expect.any(Number) : 0o600 }),
      expect.objectContaining({ suffix: "-shm", type: "file", mode: process.platform === "win32" ? expect.any(Number) : 0o600 }),
    ]);
    const firstDurableArtifacts = await sqliteDurableArtifactSnapshot(path);

    await expectResetRequired(ProductDatabase.open(path, observedAt));
    expect(await exactFileIdentity(path)).toEqual(beforeMain);
    expect((await readFile(path)).equals(beforeBytes)).toBe(true);
    expect(await sqliteDurableArtifactSnapshot(path)).toEqual(firstDurableArtifacts);
  });

  it("requires a complete reset for the previous operation-row capacities", async () => {
    const directory = await temporaryDirectory();
    await ensureOwnerOnlyDirectory(directory);
    const path = runtimePaths(directory).database;
    const initialized = await ProductDatabase.open(path, observedAt);
    initialized.close();

    const oldSchema = new Database(path);
    oldSchema.unsafeMode(true);
    oldSchema.exec("PRAGMA writable_schema = ON");
    const changed = oldSchema.prepare(`UPDATE sqlite_schema
      SET sql = replace(sql, 'length(operation_json) BETWEEN 2 AND 65535',
        'length(operation_json) BETWEEN 2 AND 8388607')
      WHERE type = 'table' AND name IN ('wallet_operation', 'token_selection_operation')`)
      .run();
    expect(changed.changes).toBe(2);
    oldSchema.exec("PRAGMA writable_schema = OFF");
    oldSchema.close();
    if (process.platform !== "win32") await chmod(path, 0o600);
    const before = await readFile(path);

    await expectResetRequired(ProductDatabase.open(path, observedAt));
    expect((await readFile(path)).equals(before)).toBe(true);
    const preserved = new Database(path, { readonly: true });
    expect(preserved.pragma("user_version", { simple: true })).toBe(1);
    preserved.close();
  });

  it("requires a complete reset for the previous Token inspection cache schema", async () => {
    const directory = await temporaryDirectory();
    await ensureOwnerOnlyDirectory(directory);
    const path = runtimePaths(directory).database;
    const currentInspectionColumn = `  result_bytes BLOB NOT NULL CHECK (
    typeof(result_bytes) = 'blob' AND
    length(result_bytes) BETWEEN 2 AND ${tokenInspectionPersistenceLimits.resultBytes}
  ),`;
    const previousInspectionColumn = `  result_json TEXT NOT NULL CHECK (
    instr(result_json, char(0)) = 0 AND
    length(CAST(result_json AS BLOB)) BETWEEN 2 AND 65536 AND
    json_valid(result_json) = 1 AND json_type(result_json) = 'object'
  ),`;
    const selectionCacheKey = `  inspection_digest TEXT CHECK (
    inspection_digest IS NULL OR (instr(inspection_digest, char(0)) = 0 AND length(inspection_digest) = 66 AND substr(inspection_digest, 1, 2) = '0x' AND lower(inspection_digest) = inspection_digest AND substr(inspection_digest, 3) NOT GLOB '*[^0-9a-f]*')
  ),
`;
    const previousSchema = replaceExactSqlFragment(
      replaceExactSqlFragment(
        currentSqliteSchemaSql,
        currentInspectionColumn,
        previousInspectionColumn,
      ),
      selectionCacheKey,
      "",
    );
    const previous = new Database(path);
    previous.pragma("journal_mode = WAL");
    previous.exec(previousSchema);
    previous.pragma("user_version = 1");
    previous.pragma("wal_checkpoint(TRUNCATE)");
    previous.close();
    if (process.platform !== "win32") await chmod(path, 0o600);
    const before = await readFile(path);

    await expectResetRequired(ProductDatabase.open(path, observedAt));
    expect((await readFile(path)).equals(before)).toBe(true);
    const retained = new Database(path, { readonly: true });
    expect((retained.pragma("table_xinfo(token_contract_inspection)") as Array<{ name: string }>)
      .map(({ name }) => name)).toContain("result_json");
    expect((retained.pragma("table_xinfo(wallet_token_selection)") as Array<{ name: string }>)
      .map(({ name }) => name)).not.toContain("inspection_digest");
    retained.close();
  });

  it("resets only by replacing the complete isolated data directory", async () => {
    const root = await temporaryDirectory();
    const activeDirectory = resolve(root, "active");
    const preservedDirectory = resolve(root, "preserved");
    await ensureOwnerOnlyDirectory(activeDirectory);
    const activePath = runtimePaths(activeDirectory).database;
    const initialized = await ProductDatabase.open(activePath, observedAt);
    initialized.close();
    const incompatible = new Database(activePath);
    incompatible.exec("CREATE TABLE unexpected_structure(value TEXT)");
    incompatible.close();
    if (process.platform !== "win32") await chmod(activePath, 0o600);
    const retainedMarker = Buffer.from("independent retained material\n", "utf8");
    await writeFile(resolve(activeDirectory, "retained.bin"), retainedMarker, { mode: 0o600 });

    await expectResetRequired(ProductDatabase.open(activePath, observedAt));
    const rejectedArtifacts = await sqliteArtifactSnapshot(activePath);
    const rejectedMarker = await readFile(resolve(activeDirectory, "retained.bin"));

    renameSync(activeDirectory, preservedDirectory);
    await ensureOwnerOnlyDirectory(activeDirectory);
    const freshPath = runtimePaths(activeDirectory).database;
    const fresh = await ProductDatabase.open(freshPath, observedAt);
    fresh.close();

    const inspection = new Database(freshPath, { readonly: true });
    expect(readIndependentSqliteSchema(inspection)).toEqual(deriveIndependentCurrentSqliteSchema());
    expect(inspection.pragma("user_version", { simple: true })).toBe(1);
    inspection.close();
    expect(await sqliteArtifactSnapshot(runtimePaths(preservedDirectory).database))
      .toEqual(rejectedArtifacts);
    expect((await readFile(resolve(preservedDirectory, "retained.bin"))).equals(rejectedMarker)).toBe(true);
  });

  it("fails closed when canonical time or array bytes are written outside the row adapter", async () => {
    for (const mutate of [
      (database: Database.Database) => database.prepare(
        "UPDATE current_wallet_connection SET updated_at = '2026-02-30T00:00:00.000Z' WHERE singleton = 1",
      ).run(),
      (database: Database.Database) => database.prepare(
        "UPDATE current_wallet_connection SET approved_methods_json = '[\"personal_sign\", \"eth_sendTransaction\"]' WHERE singleton = 1",
      ).run(),
    ]) {
      const directory = await temporaryDirectory();
      await ensureOwnerOnlyDirectory(directory);
      const path = runtimePaths(directory).database;
      const database = await ProductDatabase.open(path, observedAt);
      database.configuredChainStore().insertConfiguredChainIfAbsent(configuredChainId);
      database.walletStore().replace("0", connected(), false, observedAt);
      database.close();
      const raw = new Database(path);
      mutate(raw);
      raw.close();
      if (process.platform !== "win32") await chmod(path, 0o600);
      const before = await sqliteDurableArtifactSnapshot(path);
      await expectRuntimeCode(ProductDatabase.open(path, observedAt), "runtime_state_unavailable");
      expect(await sqliteDurableArtifactSnapshot(path)).toEqual(before);
    }
  });

  it("decodes valid contract and token parent rows on reopen", async () => {
    const directory = await temporaryDirectory();
    await ensureOwnerOnlyDirectory(directory);
    const path = runtimePaths(directory).database;
    const database = await ProductDatabase.open(path, observedAt);
    database.configuredChainStore().insertConfiguredChainIfAbsent(configuredChainId);
    database.close();
    const address = "0x1111111111111111111111111111111111111111";
    const raw = new Database(path);
    raw.pragma("foreign_keys = ON");
    raw.prepare("INSERT INTO contract(chain_id, contract_address) VALUES (?, ?)")
      .run(configuredChainId, address);
    raw.prepare("INSERT INTO token_contract(chain_id, contract_address) VALUES (?, ?)")
      .run(configuredChainId, address);
    raw.close();
    const reopened = await ProductDatabase.open(path, observedAt);
    expect(reopened.walletStore().read().connection).toEqual({ status: "unknown", reason: "reconciling" });
    reopened.close();
  });

  it("never treats publication staging as product authority and removes exact stale artifacts", async () => {
    const directory = await temporaryDirectory();
    await ensureOwnerOnlyDirectory(directory);
    const path = runtimePaths(directory).database;
    const prePublication = publicationStagingPath(path, 1);
    await writeFile(prePublication, "not a database", { mode: 0o600 });

    const created = await ProductDatabase.open(path, observedAt);
    const profile = created.ownerStore().readProfile();
    created.close();
    expect(await readFile(path)).not.toEqual(Buffer.from("not a database"));
    await expect(lstat(prePublication)).rejects.toMatchObject({ code: "ENOENT" });

    const separateDatabase = publicationStagingPath(path, 2);
    copyFileSync(path, separateDatabase);
    if (process.platform !== "win32") chmodSync(separateDatabase, 0o600);
    await writeFile(`${separateDatabase}-wal`, "stale WAL", { mode: 0o600 });
    await writeFile(`${separateDatabase}-shm`, "stale SHM", { mode: 0o600 });
    const finalIdentity = await exactFileIdentity(path);

    const afterSeparateStaging = await ProductDatabase.open(path, observedAt);
    expect(afterSeparateStaging.ownerStore().readProfile()).toEqual(profile);
    afterSeparateStaging.close();
    expect(await exactFileIdentity(path)).toEqual(finalIdentity);
    for (const suffix of ["", "-wal", "-shm"] as const) {
      await expect(lstat(`${separateDatabase}${suffix}`)).rejects.toMatchObject({ code: "ENOENT" });
    }

    const publishedHardlink = publicationStagingPath(path, 3);
    await link(path, publishedHardlink);
    expect(await exactFileIdentity(publishedHardlink)).toEqual(finalIdentity);
    const afterPublishedStaging = await ProductDatabase.open(path, observedAt);
    expect(afterPublishedStaging.ownerStore().readProfile()).toEqual(profile);
    afterPublishedStaging.close();
    expect(await exactFileIdentity(path)).toEqual(finalIdentity);
    await expect(lstat(publishedHardlink)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed on malformed or unsafe publication staging without changing the final database", async () => {
    const malformedDirectory = await temporaryDirectory();
    await ensureOwnerOnlyDirectory(malformedDirectory);
    const malformedPath = runtimePaths(malformedDirectory).database;
    const initialized = await ProductDatabase.open(malformedPath, observedAt);
    initialized.close();
    const malformedStaging = `${malformedPath}.pending-invalid`;
    await writeFile(malformedStaging, "reserved namespace", { mode: 0o600 });
    const beforeMalformed = await sqliteDurableArtifactSnapshot(malformedPath);
    await expectRuntimeCode(ProductDatabase.open(malformedPath, observedAt), "runtime_state_unavailable");
    expect(await sqliteDurableArtifactSnapshot(malformedPath)).toEqual(beforeMalformed);
    expect(await readFile(malformedStaging, "utf8")).toBe("reserved namespace");

    if (process.platform === "win32") return;
    const linkedDirectory = await temporaryDirectory();
    await ensureOwnerOnlyDirectory(linkedDirectory);
    const linkedPath = runtimePaths(linkedDirectory).database;
    const linked = await ProductDatabase.open(linkedPath, observedAt);
    linked.close();
    const target = resolve(linkedDirectory, "foreign-staging-target");
    await writeFile(target, "unchanged", { mode: 0o600 });
    const linkedStaging = publicationStagingPath(linkedPath, 4);
    await symlink(target, linkedStaging);
    const beforeLinked = await sqliteDurableArtifactSnapshot(linkedPath);
    await expectRuntimeCode(ProductDatabase.open(linkedPath, observedAt), "runtime_state_unavailable");
    expect(await sqliteDurableArtifactSnapshot(linkedPath)).toEqual(beforeLinked);
    expect(await readFile(target, "utf8")).toBe("unchanged");
    expect((await lstat(linkedStaging)).isSymbolicLink()).toBe(true);
  });

  it("uses stored update time for wallet meaning, canonicalizes arrays, and enforces CAS", async () => {
    const directory = await temporaryDirectory();
    await ensureOwnerOnlyDirectory(directory);
    const path = runtimePaths(directory).database;
    const database = await ProductDatabase.open(path, observedAt);
    database.configuredChainStore().insertConfiguredChainIfAbsent(configuredChainId);
    const wallet = database.walletStore();
    const value = connected();
    const first = wallet.replace("0", value, false, observedAt);
    expect(first.revision).toBe("1");
    await expectRuntimeCode(
      Promise.resolve().then(() => wallet.replace(
        "0",
        { status: "disconnected", reason: "no_session" },
        true,
        observedAt,
      )),
      "state_conflict",
    );
    const beforeInvalid = wallet.read();
    await expectRuntimeCode(
      Promise.resolve().then(() => wallet.replace("1", connectedInput(observedAt) as never, false, observedAt)),
      "runtime_state_unavailable",
    );
    expect(wallet.read()).toEqual(beforeInvalid);
    const accountRows = new Database(path, { readonly: true });
    expect(accountRows.prepare(`SELECT profile_id AS profileId, chain_id AS chainId,
      account_address AS accountAddress FROM account`).all()).toHaveLength(1);
    accountRows.close();
    database.close();

    const raw = new Database(path, { readonly: true });
    const stored = raw.prepare("SELECT approved_methods_json, approved_events_json FROM current_wallet_connection").get() as {
      approved_methods_json: string;
      approved_events_json: string;
    };
    expect(stored.approved_methods_json).toBe('["eth_sendTransaction","personal_sign"]');
    expect(stored.approved_events_json).toBe('["accountsChanged","chainChanged"]');
    raw.close();

    const reopened = await ProductDatabase.open(path, parseUtcTimestamp("2030-01-01T00:00:00.000Z"));
    expect(reopened.walletStore().read()).toEqual(first);
    reopened.close();
  });

  it("rejects a persisted connected projection that requires revalidation", async () => {
    const directory = await temporaryDirectory();
    await ensureOwnerOnlyDirectory(directory);
    const path = runtimePaths(directory).database;
    const database = await ProductDatabase.open(path, observedAt);
    database.configuredChainStore().insertConfiguredChainIfAbsent(configuredChainId);
    const wallet = database.walletStore();
    wallet.replace("0", connected(), false, observedAt);

    const raw = new Database(path);
    raw.pragma("ignore_check_constraints = ON");
    raw.prepare(`UPDATE current_wallet_connection SET revalidation_required = 1
      WHERE singleton = 1`).run();
    raw.close();

    await expectRuntimeCode(
      Promise.resolve().then(() => wallet.read()),
      "runtime_state_unavailable",
    );
    database.close();
  });

  it("atomically compares and replaces connection and durable revalidation state", async () => {
    const directory = await temporaryDirectory();
    await ensureOwnerOnlyDirectory(directory);
    const path = runtimePaths(directory).database;
    const database = await ProductDatabase.open(path, observedAt);
    const wallet = database.walletStore();

    const blocked = wallet.replace(
      "0",
      { status: "unresolved", sessionCount: parseUnsignedDecimal("1") },
      true,
      observedAt,
    );
    expect(blocked).toEqual({
      revision: "1",
      connection: { status: "unresolved", sessionCount: "1" },
      revalidationRequired: true,
      updatedAt: observedAt,
    });
    await expectRuntimeCode(
      Promise.resolve().then(() => wallet.replace(
        "0",
        { status: "disconnected", reason: "no_session" },
        false,
        observedAt,
      )),
      "state_conflict",
    );
    expect(wallet.read()).toEqual(blocked);

    const cleared = wallet.replace(
      "1",
      { status: "disconnected", reason: "no_session" },
      false,
      observedAt,
    );
    expect(cleared).toEqual({
      revision: "2",
      connection: { status: "disconnected", reason: "no_session" },
      revalidationRequired: false,
      updatedAt: observedAt,
    });
    await expectRuntimeCode(
      Promise.resolve().then(() => wallet.replace(
        "2",
        { status: "unknown", reason: "observation_unavailable" },
        1 as never,
        observedAt,
      )),
      "runtime_state_unavailable",
    );
    expect(wallet.read()).toEqual(cleared);
    database.close();

    const raw = new Database(path, { readonly: true });
    expect(raw.prepare(`SELECT revision, revalidation_required AS revalidationRequired,
      status, reason FROM current_wallet_connection WHERE singleton = 1`).get()).toEqual({
      revision: "2",
      revalidationRequired: 0,
      status: "disconnected",
      reason: "no_session",
    });
    raw.close();
    const reopened = await ProductDatabase.open(path, observedAt);
    expect(reopened.walletStore().read()).toEqual(cleared);
    reopened.close();
  });

  it("preserves chain-scoped accounts across disconnect, address switch, and chain switch", async () => {
    const directory = await temporaryDirectory();
    await ensureOwnerOnlyDirectory(directory);
    const path = runtimePaths(directory).database;
    const database = await ProductDatabase.open(path, observedAt);
    const chains = database.configuredChainStore();
    chains.insertConfiguredChainIfAbsent(configuredChainId);
    chains.insertConfiguredChainIfAbsent(configuredChainId);
    chains.insertConfiguredChainIfAbsent(alternateChainId);
    const wallet = database.walletStore();
    const addressA = "0x1111111111111111111111111111111111111111";
    const addressB = "0x2222222222222222222222222222222222222222";

    wallet.replace("0", connectedFor(configuredChainId, addressA), false, observedAt);
    wallet.replace("1", { status: "disconnected", reason: "disconnected" }, false, observedAt);
    wallet.replace("2", connectedFor(configuredChainId, addressB), false, observedAt);
    wallet.replace("3", { status: "disconnected", reason: "no_session" }, false, observedAt);
    wallet.replace("4", connectedFor("eip155:1", addressA), false, observedAt);
    wallet.replace("5", { status: "disconnected", reason: "expired" }, false, observedAt);
    wallet.replace("6", connectedFor(configuredChainId, addressA), false, observedAt);

    const raw = new Database(path, { readonly: true });
    const rows = raw.prepare(`SELECT profile_id AS profileId, chain_id AS chainId,
      account_address AS accountAddress FROM account
      ORDER BY chain_id, account_address`).all() as {
      profileId: string;
      chainId: string;
      accountAddress: string;
    }[];
    expect(rows.map(decodeAccountRecordKey)).toEqual([
      {
        profileId: database.ownerStore().readProfile().profileId,
        account: { chainId: "eip155:1", address: addressA },
      },
      {
        profileId: database.ownerStore().readProfile().profileId,
        account: { chainId: configuredChainId, address: addressA },
      },
      {
        profileId: database.ownerStore().readProfile().profileId,
        account: { chainId: configuredChainId, address: addressB },
      },
    ]);
    expect(raw.prepare("SELECT chain_id AS chainId FROM chain ORDER BY chain_id").all())
      .toEqual([{ chainId: "eip155:1" }, { chainId: configuredChainId }]);
    expect(raw.prepare("SELECT COUNT(*) AS count FROM contract").get()).toEqual({ count: 0 });
    expect(raw.prepare("SELECT COUNT(*) AS count FROM token_contract").get()).toEqual({ count: 0 });
    raw.close();
    expect(wallet.read().connection).toMatchObject({
      status: "connected",
      chainId: configuredChainId,
      address: addressA,
    });
    database.close();
  });

  it("changes only the projection when a durable account becomes nonconnected", async () => {
    const directory = await temporaryDirectory();
    await ensureOwnerOnlyDirectory(directory);
    const path = runtimePaths(directory).database;
    const address = "0x1111111111111111111111111111111111111111";
    const tokenAddress = "0x2222222222222222222222222222222222222222";
    const selectionSetRevision = Buffer.alloc(16, 7).toString("base64url");
    const selectionRevision = Buffer.alloc(16, 8).toString("base64url");

    const initialized = await ProductDatabase.open(path, observedAt);
    initialized.configuredChainStore().insertConfiguredChainIfAbsent(configuredChainId);
    initialized.walletStore().replace(
      "0",
      connectedFor(configuredChainId, address),
      false,
      observedAt,
    );
    initialized.close();

    const fixture = new Database(path);
    fixture.pragma("foreign_keys = ON");
    fixture.prepare("INSERT INTO contract(chain_id, contract_address) VALUES (?, ?)")
      .run(configuredChainId, tokenAddress);
    fixture.prepare("INSERT INTO token_contract(chain_id, contract_address) VALUES (?, ?)")
      .run(configuredChainId, tokenAddress);
    fixture.prepare(`INSERT INTO account_token_selection_state(
      profile_id, chain_id, account_address, revision, defaults_initialized, created_at, updated_at
    ) SELECT profile_id, ?, ?, ?, 1, ?, ? FROM local_profile WHERE singleton = 1`)
      .run(configuredChainId, address, selectionSetRevision, observedAt, observedAt);
    fixture.prepare(`INSERT INTO account_token_selection(
      profile_id, chain_id, account_address, token_address, included, revision, created_at, updated_at
    ) SELECT profile_id, ?, ?, ?, 1, ?, ?, ? FROM local_profile WHERE singleton = 1`)
      .run(
        configuredChainId,
        address,
        tokenAddress,
        selectionRevision,
        observedAt,
        observedAt,
      );
    fixture.close();
    if (process.platform !== "win32") await chmod(path, 0o600);

    const database = await ProductDatabase.open(path, observedAt);
    const disconnected = database.walletStore().replace(
      "1",
      { status: "disconnected", reason: "disconnected" },
      false,
      observedAt,
    );
    expect(disconnected).toMatchObject({
      revision: "2",
      connection: { status: "disconnected", reason: "disconnected" },
      revalidationRequired: false,
    });
    database.close();

    const inspection = new Database(path, { readonly: true });
    expect(inspection.prepare("SELECT COUNT(*) AS count FROM account").get()).toEqual({ count: 1 });
    expect(inspection.prepare(`SELECT revision, defaults_initialized AS defaultsInitialized
      FROM account_token_selection_state`).get()).toEqual({
      revision: selectionSetRevision,
      defaultsInitialized: 1,
    });
    expect(inspection.prepare("SELECT revision, included FROM account_token_selection").get()).toEqual({
      revision: selectionRevision,
      included: 1,
    });
    expect(inspection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    inspection.close();
  });

  it("rolls back account creation when the connection revision or chain parent is invalid", async () => {
    const directory = await temporaryDirectory();
    await ensureOwnerOnlyDirectory(directory);
    const path = runtimePaths(directory).database;
    const database = await ProductDatabase.open(path, observedAt);
    database.configuredChainStore().insertConfiguredChainIfAbsent(configuredChainId);
    const wallet = database.walletStore();
    const addressA = "0x1111111111111111111111111111111111111111";
    const addressB = "0x2222222222222222222222222222222222222222";
    wallet.replace("0", connectedFor(configuredChainId, addressA), false, observedAt);
    await expectRuntimeCode(
      Promise.resolve().then(() => wallet.replace(
        "0",
        connectedFor(configuredChainId, addressB),
        false,
        observedAt,
      )),
      "state_conflict",
    );
    await expectRuntimeCode(
      Promise.resolve().then(() => wallet.replace(
        "1",
        connectedFor("eip155:10", addressB),
        false,
        observedAt,
      )),
      "runtime_state_unavailable",
    );
    expect(wallet.read()).toMatchObject({
      revision: "1",
      connection: { status: "connected", chainId: configuredChainId, address: addressA },
    });
    const raw = new Database(path, { readonly: true });
    expect(raw.prepare("SELECT chain_id AS chainId, account_address AS accountAddress FROM account").all())
      .toEqual([{ chainId: configuredChainId, accountAddress: addressA }]);
    expect(raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    raw.close();
    database.close();
  });

  it("admits one first connected projection and one matching account for a shared revision", async () => {
    const directory = await temporaryDirectory();
    await ensureOwnerOnlyDirectory(directory);
    const path = runtimePaths(directory).database;
    const database = await ProductDatabase.open(path, observedAt);
    database.configuredChainStore().insertConfiguredChainIfAbsent(configuredChainId);
    const wallet = database.walletStore();
    const addressA = "0x1111111111111111111111111111111111111111";
    const addressB = "0x2222222222222222222222222222222222222222";

    const results = await Promise.allSettled([
      Promise.resolve().then(() => wallet.replace(
        "0",
        connectedFor(configuredChainId, addressA),
        false,
        observedAt,
      )),
      Promise.resolve().then(() => wallet.replace(
        "0",
        connectedFor(configuredChainId, addressB),
        false,
        observedAt,
      )),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(({ status }) => status === "rejected");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status !== "rejected") throw new TypeError("A stale connection write was not rejected.");
    expect(rejected.reason).toBeInstanceOf(RuntimeOperationError);
    expect((rejected.reason as RuntimeOperationError).failure.error.code).toBe("state_conflict");

    const current = wallet.read();
    expect(current.revision).toBe("1");
    expect(current.connection.status).toBe("connected");
    const raw = new Database(path, { readonly: true });
    const accounts = raw.prepare(`SELECT chain_id AS chainId, account_address AS accountAddress
      FROM account ORDER BY chain_id, account_address`).all();
    expect(accounts).toEqual([{
      chainId: configuredChainId,
      accountAddress: current.connection.status === "connected" ? current.connection.address : "unreachable",
    }]);
    expect(raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    raw.close();
    database.close();
  });

  it("rolls back the account insert when the projection write fails", async () => {
    const directory = await temporaryDirectory();
    await ensureOwnerOnlyDirectory(directory);
    const path = runtimePaths(directory).database;
    const database = await ProductDatabase.open(path, observedAt);
    database.configuredChainStore().insertConfiguredChainIfAbsent(configuredChainId);
    const raw = new Database(path);
    raw.exec(`CREATE TRIGGER force_connection_write_failure
      BEFORE UPDATE ON current_wallet_connection
      BEGIN SELECT RAISE(ABORT, 'forced connection write failure'); END`);
    raw.close();

    await expectRuntimeCode(
      Promise.resolve().then(() => database.walletStore().replace(
        "0",
        connectedFor(
          configuredChainId,
          "0x1111111111111111111111111111111111111111",
        ),
        true,
        observedAt,
      )),
      "runtime_state_unavailable",
    );
    expect(database.walletStore().read()).toMatchObject({
      revision: "0",
      connection: { status: "unknown", reason: "reconciling" },
      revalidationRequired: false,
    });
    const inspection = new Database(path, { readonly: true });
    expect(inspection.prepare("SELECT COUNT(*) AS count FROM account").get())
      .toEqual({ count: 0 });
    expect(inspection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    inspection.close();
    database.close();
  });

  it("rolls back an uncommitted account when the process stops before the projection write", async () => {
    const directory = await temporaryDirectory();
    await ensureOwnerOnlyDirectory(directory);
    const path = runtimePaths(directory).database;
    const initialized = await ProductDatabase.open(path, observedAt);
    initialized.configuredChainStore().insertConfiguredChainIfAbsent(configuredChainId);
    initialized.close();

    const child = await launchSqliteCrashWorker(directory, "interrupted");
    await killSqliteCrashWorker(child);

    const reopened = await ProductDatabase.open(path, observedAt);
    expect(reopened.walletStore().read()).toMatchObject({
      revision: "0",
      connection: { status: "unknown", reason: "reconciling" },
    });
    const inspection = new Database(path, { readonly: true });
    expect(inspection.prepare("SELECT COUNT(*) AS count FROM account").get())
      .toEqual({ count: 0 });
    expect(inspection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(inspection.pragma("integrity_check", { simple: true })).toBe("ok");
    inspection.close();
    reopened.close();
  });

  it("rolls back every uncommitted catalog row when the owner process stops", async () => {
    const directory = await temporaryDirectory();
    await ensureOwnerOnlyDirectory(directory);
    const path = runtimePaths(directory).database;
    const initialized = await ProductDatabase.open(path, observedAt);
    initialized.configuredChainStore().insertConfiguredChainIfAbsent(configuredChainId);
    initialized.walletStore().replace(
      "0",
      connectedFor(configuredChainId, "0x1111111111111111111111111111111111111111"),
      false,
      observedAt,
    );
    initialized.close();

    const child = await launchSqliteCrashWorker(directory, "catalog-interrupted");
    await killSqliteCrashWorker(child);

    const reopened = await ProductDatabase.open(path, observedAt);
    const inspection = new Database(path, { readonly: true });
    for (const table of [
      "contract",
      "token_contract",
      "token_contract_inspection",
      "account_token_selection_state",
      "account_token_selection",
    ]) {
      expect(inspection.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(), table)
        .toEqual({ count: 0 });
    }
    expect(inspection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(inspection.pragma("integrity_check", { simple: true })).toBe("ok");
    inspection.close();
    reopened.close();
  });

  it("rejects a crash-persisted structural mismatch without changing main or WAL bytes", async () => {
    const directory = await temporaryDirectory();
    await ensureOwnerOnlyDirectory(directory);
    const path = runtimePaths(directory).database;
    const initialized = await ProductDatabase.open(path, observedAt);
    initialized.close();
    const exactMainBeforeCrash = await readFile(path);

    const child = await launchSqliteCrashWorker(directory, "structural-mismatch");
    expect((await lstat(`${path}-wal`)).isFile()).toBe(true);
    expect((await stat(`${path}-wal`)).size).toBeGreaterThan(0);
    await killSqliteCrashWorker(child);

    const mainBefore = await exactFileIdentity(path);
    const walBefore = await exactFileIdentity(`${path}-wal`);
    const mainBytesBefore = await readFile(path);
    const walBytesBefore = await readFile(`${path}-wal`);
    expect(mainBytesBefore.equals(exactMainBeforeCrash)).toBe(true);

    await expectResetRequired(ProductDatabase.open(path, observedAt));
    const mainAfter = await exactFileIdentity(path);
    const walAfter = await exactFileIdentity(`${path}-wal`);
    expect(mainAfter).toEqual(mainBefore);
    expect(walAfter).toEqual(walBefore);
    expect((await readFile(path)).equals(mainBytesBefore)).toBe(true);
    expect((await readFile(`${path}-wal`)).equals(walBytesBefore)).toBe(true);

    const recoverable = new Database(path, { fileMustExist: true });
    expect(recoverable.prepare(`SELECT type, name, tbl_name AS tableName, sql
      FROM sqlite_schema WHERE name = 'crash_only_state'`).get()).toMatchObject({
      type: "table",
      name: "crash_only_state",
      tableName: "crash_only_state",
    });
    recoverable.close();
  });

  it("never initializes over an existing SQLite artifact set", async () => {
    const cases: readonly {
      readonly name: string;
      readonly prepare: (path: string) => Promise<void>;
      readonly outcome: "reset" | "unavailable";
    }[] = [
      {
        name: "zero-byte main",
        prepare: async (path) => { await createOwnerOnlyStateFile(path); },
        outcome: "reset",
      },
      {
        name: "orphan WAL",
        prepare: async (path) => { await writeFile(`${path}-wal`, "orphan", { mode: 0o600 }); },
        outcome: "unavailable",
      },
      {
        name: "orphan SHM",
        prepare: async (path) => { await writeFile(`${path}-shm`, "orphan", { mode: 0o600 }); },
        outcome: "unavailable",
      },
      {
        name: "orphan WAL and SHM",
        prepare: async (path) => {
          await writeFile(`${path}-wal`, "orphan WAL", { mode: 0o600 });
          await writeFile(`${path}-shm`, "orphan SHM", { mode: 0o600 });
        },
        outcome: "unavailable",
      },
      {
        name: "DELETE-mode main",
        prepare: async (path) => {
          const database = new Database(path);
          database.exec("CREATE TABLE foreign_state(value TEXT)");
          database.close();
          if (process.platform !== "win32") await chmod(path, 0o600);
        },
        outcome: "reset",
      },
      {
        name: "partial final artifact set",
        prepare: async (path) => {
          const database = new Database(path);
          database.pragma("journal_mode = WAL");
          database.exec("CREATE TABLE foreign_state(value TEXT)");
          database.pragma("wal_checkpoint(TRUNCATE)");
          database.close();
          if (process.platform !== "win32") await chmod(path, 0o600);
          await writeFile(`${path}-wal`, "partial", { mode: 0o600 });
        },
        outcome: "reset",
      },
    ];
    for (const testCase of cases) {
      const directory = await temporaryDirectory();
      await ensureOwnerOnlyDirectory(directory);
      const path = runtimePaths(directory).database;
      await testCase.prepare(path);
      const beforeArtifacts = await sqliteArtifactSnapshot(path);
      const beforeDurableArtifacts = await sqliteDurableArtifactSnapshot(path);
      const beforeMainIdentity = await optionalExactFileIdentity(path);
      if (testCase.outcome === "reset") {
        await expectResetRequired(ProductDatabase.open(path, observedAt));
      } else {
        await expectRuntimeCode(
          ProductDatabase.open(path, observedAt),
          "runtime_state_unavailable",
          testCase.name,
        );
      }
      const afterMainIdentity = await optionalExactFileIdentity(path);
      expect(afterMainIdentity, testCase.name).toEqual(beforeMainIdentity);
      if (testCase.outcome === "unavailable") {
        expect(await sqliteArtifactSnapshot(path), testCase.name).toEqual(beforeArtifacts);
      } else if (beforeArtifacts.some((artifact) => artifact.suffix === "-wal" && artifact.type === "file")) {
        expect(await sqliteDurableArtifactSnapshot(path), testCase.name).toEqual(beforeDurableArtifacts);
      }
    }
  });

  it("validates an active WAL snapshot without creating a second product-state artifact", async () => {
    const directory = await temporaryDirectory();
    await ensureOwnerOnlyDirectory(directory);
    const path = runtimePaths(directory).database;
    const first = await ProductDatabase.open(path, observedAt);
    first.configuredChainStore().insertConfiguredChainIfAbsent(configuredChainId);
    const expected = first.walletStore().replace("0", connected(), false, observedAt);
    expect((await lstat(`${path}-wal`)).isFile()).toBe(true);
    expect((await lstat(`${path}-shm`)).isFile()).toBe(true);

    const second = await ProductDatabase.open(path, observedAt);
    expect(second.walletStore().read()).toEqual(expected);
    expect((await readdir(directory)).sort()).toEqual([
      "littlejohn.sqlite3",
      "littlejohn.sqlite3-shm",
      "littlejohn.sqlite3-wal",
    ]);
    second.close();
    first.close();
  });

  it("keeps bounded Token inspection admission on one WAL snapshot", async () => {
    const directory = await temporaryDirectory();
    await ensureOwnerOnlyDirectory(directory);
    const path = runtimePaths(directory).database;
    const tokenAddress = parseEvmAddressInput(`0x${"57".repeat(20)}`);
    const initialized = await ProductDatabase.open(path, observedAt);
    initialized.configuredChainStore().insertConfiguredChainIfAbsent(configuredChainId);
    initialized.close();
    const inspection = await createInspectionSuccess({
      asset: { kind: "erc20", chainId: configuredChainId, address: tokenAddress },
      block: { kind: "latest" },
    });
    const resultBytes = Buffer.from(
      canonicalJsonStringify(captureCanonicalJson(inspection)),
      "utf8",
    );

    const reader = new Database(path);
    const writer = new Database(path);
    writer.pragma("foreign_keys = ON");
    reader.exec("BEGIN DEFERRED");
    expect(reader.prepare("SELECT count(*) AS count FROM token_contract_inspection").get())
      .toEqual({ count: 0 });
    writer.transaction(() => {
      writer.prepare("INSERT INTO contract(chain_id, contract_address) VALUES (?, ?)")
        .run(configuredChainId, tokenAddress);
      writer.prepare("INSERT INTO token_contract(chain_id, contract_address) VALUES (?, ?)")
        .run(configuredChainId, tokenAddress);
      writer.prepare(`INSERT INTO token_contract_inspection(
        chain_id, contract_address, inspection_digest, result_bytes
      ) VALUES (?, ?, ?, ?)`).run(
        configuredChainId,
        tokenAddress,
        tokenInspectionDigest(inspection),
        resultBytes,
      );
    })();
    expect(reader.prepare(`SELECT typeof(result_bytes) AS storageClass,
      length(result_bytes) AS byteLength FROM token_contract_inspection`).all()).toEqual([]);
    expect(reader.prepare("SELECT result_bytes AS resultBytes FROM token_contract_inspection").all())
      .toEqual([]);
    reader.exec("COMMIT");
    expect(reader.prepare(`SELECT typeof(result_bytes) AS storageClass,
      length(result_bytes) AS byteLength FROM token_contract_inspection`).all()).toEqual([
      { storageClass: "blob", byteLength: resultBytes.length },
    ]);
    reader.close();
    writer.close();

    const reopened = await ProductDatabase.open(path, observedAt);
    reopened.close();
  });

  it("opens a consistent WAL snapshot while a valid writer continues committing", async () => {
    const directory = await temporaryDirectory();
    await ensureOwnerOnlyDirectory(directory);
    const path = runtimePaths(directory).database;
    const writer = await ProductDatabase.open(path, observedAt);
    let openingSettled = false;
    const opening = ProductDatabase.open(path, observedAt).then(
      (database) => { openingSettled = true; return database; },
      (error: unknown) => { openingSettled = true; throw error; },
    );
    let commitsWhileOpening = 0;
    const writing = (async () => {
      for (let index = 0; index < 128; index += 1) {
        writer.ownerStore().publishOwner(createOwnerInstanceId(), configurationMac, observedAt);
        if (!openingSettled) commitsWhileOpening += 1;
        await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
      }
    })();
    const [reader] = await Promise.all([opening, writing]);
    expect(commitsWhileOpening).toBeGreaterThan(0);
    expect(reader.ownerStore().readProfile()).toEqual(writer.ownerStore().readProfile());
    expect(writer.ownerStore().readOwner()?.ownerRevision).toBe("128");
    reader.close();
    writer.close();
  });

  it("reconstructs transient SHM after a crash without changing main or WAL", async () => {
    const directory = await temporaryDirectory();
    await ensureOwnerOnlyDirectory(directory);
    const path = runtimePaths(directory).database;
    const child = await launchSqliteCrashWorker(directory);
    expect((await lstat(`${path}-wal`)).isFile()).toBe(true);
    expect((await lstat(`${path}-shm`)).isFile()).toBe(true);
    await killSqliteCrashWorker(child);
    const before = await sqliteDurableArtifactSnapshot(path);
    await unlink(`${path}-shm`);

    const reopened = await ProductDatabase.open(path, observedAt);
    expect(reopened.walletStore().read().connection.status).toBe("connected");
    expect(await sqliteDurableArtifactSnapshot(path)).toEqual(before);
    const sharedMemory = await lstat(`${path}-shm`);
    expect(sharedMemory.isFile()).toBe(true);
    if (process.platform !== "win32") expect(sharedMemory.mode & 0o777).toBe(0o600);
    reopened.close();
  });

  it("does not treat transient SHM without WAL as product-state authority", async () => {
    const directory = await temporaryDirectory();
    await ensureOwnerOnlyDirectory(directory);
    const path = runtimePaths(directory).database;
    const initialized = await ProductDatabase.open(path, observedAt);
    const profile = initialized.ownerStore().readProfile();
    initialized.close();
    await writeFile(`${path}-shm`, Buffer.alloc(32_768), { mode: 0o600 });

    const reopened = await ProductDatabase.open(path, observedAt);
    expect(reopened.ownerStore().readProfile()).toEqual(profile);
    reopened.close();
  });

  it("rejects main-file replacement through the actual owner-only lease", async () => {
    const directory = await temporaryDirectory();
    await ensureOwnerOnlyDirectory(directory);
    const path = runtimePaths(directory).database;
    await createOwnerOnlyStateFile(path);
    await writeFile(path, "current", { mode: 0o600 });
    const lease = acquireOwnerOnlyStateFileLease(path);
    const originalIdentity = await exactFileIdentity(path);
    expect(lease.observe()).toMatchObject(originalIdentity);
    const replacement = `${path}.replacement`;
    copyFileSync(path, replacement);
    if (process.platform !== "win32") chmodSync(replacement, 0o600);
    renameSync(replacement, path);

    expect(() => lease.assertCurrent()).toThrow("Owner-only state file type is invalid.");
    expect(await exactFileIdentity(path)).not.toEqual(originalIdentity);
    lease.close();
  });

  it("keeps main-file identity bound for the complete product-database lifetime", async () => {
    const directory = await temporaryDirectory();
    await ensureOwnerOnlyDirectory(directory);
    const path = runtimePaths(directory).database;
    const database = await ProductDatabase.open(path, observedAt);
    const replacement = `${path}.replacement`;
    copyFileSync(path, replacement);
    if (process.platform !== "win32") chmodSync(replacement, 0o600);
    renameSync(replacement, path);

    await expectRuntimeCode(
      Promise.resolve().then(() => database.walletStore().read()),
      "runtime_state_unavailable",
    );
    database.close();
  });

  it("retains the main-file lease until the database connection is proven closed", () => {
    const databaseFailure = new Error("database close failed");
    const leaseFailure = new Error("lease close failed");

    for (const failingResource of ["database", "lease"] as const) {
      const events: string[] = [];
      let failureAvailable = true;
      const database = Reflect.construct(ProductDatabase, [{
        database: {
          close(): void {
            events.push("database:close");
            if (failingResource === "database" && failureAvailable) {
              failureAvailable = false;
              throw databaseFailure;
            }
          },
        },
        mainLease: {
          close(): void {
            events.push("lease:close");
            if (failingResource === "lease" && failureAvailable) {
              failureAvailable = false;
              throw leaseFailure;
            }
          },
        },
      }]) as ProductDatabase;

      expect(() => database.close()).toThrow(RuntimeOperationError);
      expect(events).toEqual(failingResource === "database"
        ? ["database:close"]
        : ["database:close", "lease:close"]);

      events.length = 0;
      expect(() => database.close()).not.toThrow();
      expect(events).toEqual(failingResource === "database"
        ? ["database:close", "lease:close"]
        : ["lease:close"]);

      events.length = 0;
      database.close();
      expect(events).toEqual([]);
    }
  });

  it("rejects weak or non-regular SQLite artifacts before opening and never repairs them", async () => {
    if (process.platform === "win32") return;

    for (const suffix of ["", "-wal", "-shm"] as const) {
      const directory = await temporaryDirectory();
      await ensureOwnerOnlyDirectory(directory);
      const path = runtimePaths(directory).database;
      const initialized = await ProductDatabase.open(path, observedAt);
      initialized.close();
      const artifact = `${path}${suffix}`;
      if (suffix !== "") await writeFile(artifact, `weak ${suffix}`, { mode: 0o600 });
      await chmod(artifact, 0o644);
      const before = await sqliteArtifactSnapshot(path);
      await expectRuntimeCode(
        ProductDatabase.open(path, observedAt),
        "runtime_state_unavailable",
        `weak ${suffix || "main"}`,
      );
      expect(await sqliteArtifactSnapshot(path)).toEqual(before);
    }

    for (const suffix of ["", "-wal", "-shm"] as const) {
      const directory = await temporaryDirectory();
      await ensureOwnerOnlyDirectory(directory);
      const path = runtimePaths(directory).database;
      const initialized = await ProductDatabase.open(path, observedAt);
      initialized.close();
      const artifact = `${path}${suffix}`;
      const target = resolve(directory, `linked-${suffix || "main"}-target`);
      if (suffix === "") renameSync(path, target);
      else await writeFile(target, `linked ${suffix}`, { mode: 0o600 });
      const targetBytes = await readFile(target);
      await symlink(target, artifact);
      const before = await sqliteArtifactSnapshot(path);
      await expectRuntimeCode(
        ProductDatabase.open(path, observedAt),
        "runtime_state_unavailable",
        `linked ${suffix || "main"}`,
      );
      expect(await sqliteArtifactSnapshot(path)).toEqual(before);
      expect((await readFile(target)).equals(targetBytes)).toBe(true);
      expect((await lstat(artifact)).isSymbolicLink()).toBe(true);
    }
  });

  it("preserves non-reset failure precedence when exact structure admission cannot complete", async () => {
    const contentionDirectory = await temporaryDirectory();
    await ensureOwnerOnlyDirectory(contentionDirectory);
    const contentionPath = runtimePaths(contentionDirectory).database;
    const initialized = await ProductDatabase.open(contentionPath, observedAt);
    initialized.close();
    const blocker = new Database(contentionPath);
    blocker.pragma("locking_mode = EXCLUSIVE");
    blocker.exec("BEGIN EXCLUSIVE");
    try {
      await expectRuntimeCode(ProductDatabase.open(contentionPath, observedAt), "runtime_busy");
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
    }
    const afterContention = await ProductDatabase.open(contentionPath, observedAt);
    afterContention.close();

    if (process.platform !== "win32") {
      const permissionDirectory = await temporaryDirectory();
      await ensureOwnerOnlyDirectory(permissionDirectory);
      const permissionPath = runtimePaths(permissionDirectory).database;
      const permitted = await ProductDatabase.open(permissionPath, observedAt);
      permitted.close();
      await chmod(permissionDirectory, 0o600);
      try {
        await expectRuntimeCode(ProductDatabase.open(permissionPath, observedAt), "runtime_state_unavailable");
      } finally {
        await chmod(permissionDirectory, 0o700);
      }
      const afterPermissionFailure = await ProductDatabase.open(permissionPath, observedAt);
      afterPermissionFailure.close();
    }

    const ioDirectory = await temporaryDirectory();
    const nonDirectory = resolve(ioDirectory, "not-a-directory");
    const retained = Buffer.from("retained I/O boundary\n", "utf8");
    await writeFile(nonDirectory, retained, { mode: 0o600 });
    await expectRuntimeCode(
      ProductDatabase.open(resolve(nonDirectory, "littlejohn.sqlite3"), observedAt),
      "runtime_state_unavailable",
    );
    expect((await readFile(nonDirectory)).equals(retained)).toBe(true);
  }, 15_000);

  it("does not classify unreadable SQLite content as a structure mismatch", async () => {
    const directory = await temporaryDirectory();
    await ensureOwnerOnlyDirectory(directory);
    const path = runtimePaths(directory).database;
    const bytes = Buffer.from("not a SQLite database", "utf8");
    await writeFile(path, bytes, { mode: 0o600 });
    const before = await exactFileIdentity(path);

    await expectRuntimeCode(ProductDatabase.open(path, observedAt), "runtime_state_unavailable");
    expect(await exactFileIdentity(path)).toEqual(before);
    expect((await readFile(path)).equals(bytes)).toBe(true);
  });
});

describe("configuration and source authority", () => {
  it("owns exact RPC bytes, official identity, WalletConnect metadata, and domain-separated source vectors", async () => {
    const directory = await temporaryDirectory();
    const paths = runtimePaths(directory);
    await ensureOwnerOnlyDirectory(directory);
    await writeFile(
      paths.controlCredential,
      `${Buffer.alloc(32, 1).toString("base64url")}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    const credential = await loadOrCreateControlCredential(directory, paths.controlCredential);
    const clock = createCanonicalClock(() => observedAt);
    const configuration = readRuntimeConfiguration({});
    expect(Reflect.ownKeys(configuration.wallet)).toEqual([]);
    expect(Object.isFrozen(configuration.wallet)).toBe(true);
    const configurationFields = [
      Buffer.from(configuration.chain.chainId, "utf8"),
      Buffer.from(readConfiguredRpcEndpoint(configuration.rpc.endpoint).exactUri, "utf8"),
      Buffer.from("cd33d6deaa901b3c96185d9cb1f320ef", "utf8"),
    ];
    const payload = Buffer.alloc(configurationFields.reduce((sum, field) => sum + 4 + field.length, 0));
    let payloadOffset = 0;
    for (const field of configurationFields) {
      payload.writeUInt32BE(field.length, payloadOffset);
      payloadOffset += 4;
      field.copy(payload, payloadOffset);
      payloadOffset += field.length;
    }
    const independentConfigurationMac = createHmac("sha256", Buffer.from(hkdfSync(
      "sha256",
      Buffer.alloc(32, 1),
      Buffer.alloc(0),
      Buffer.from("littlejohn/runtime-configuration/v1", "utf8"),
      32,
    ))).update(payload).digest("base64url");
    const expectedConfigurationMac = "FIidE1Dj6RcKlQxqhlA9OidO39xk72JZHIVrFIWCXyQ";
    expect(payload.toString("hex")).toBe(
      "0000000b6569703135353a343636330000002768747470733a2f2f7270632e6d61696e6e65742e636861696e2e726f62696e686f6f642e636f6d000000206364333364366465616139303162336339363138356439636231663332306566",
    );
    expect(independentConfigurationMac).toBe(expectedConfigurationMac);
    expect(deriveRuntimeConfigurationMac(credential, configuration)).toBe(expectedConfigurationMac);
    expect(() => readRuntimeConfiguration({
      LITTLEJOHN_WALLETCONNECT_PROJECT_ID: "not-a-project-id",
    })).toThrow();
    const forgedChain = Object.freeze({ chainId: configuration.chain.chainId });
    expect(() => deriveRuntimeConfigurationMac(credential, {
      chain: forgedChain,
      rpc: Object.freeze({ chain: forgedChain, endpoint: configuration.rpc.endpoint }),
      wallet: Object.freeze({}),
    } as never)).toThrow("provenance");
    const wrongChain = Object.freeze({ chainId: alternateChainId });
    expect(() => deriveRuntimeConfigurationMac(credential, {
      chain: configuration.chain,
      rpc: configuration.rpc,
      wallet: createWalletConnectConfiguration(undefined, wrongChain as never),
    })).toThrow("chain authority");
    const rpc = createRpcSourceAuthority({ credential, endpoint: configuration.rpc.endpoint, clock });
    expect(rpc.configurationDigest).toBe("oA40Nw__Im-Kx0Tp9zCwwDLic15a7IjDaVCesNOhEuA");
    expect(rpc.sourceOwner).toBe("Robinhood");
    expect(rpc.publicOrigin).toBe("https://rpc.mainnet.chain.robinhood.com");
    expect(() => createRpcSourceAuthority({
      credential,
      endpoint: Object.freeze({
        publicOrigin: configuration.rpc.endpoint.publicOrigin,
        sourceOwner: configuration.rpc.endpoint.sourceOwner,
      }) as never,
      clock,
    })).toThrow("provenance");

    const secretConfiguration = readRuntimeConfiguration({
      LITTLEJOHN_RPC_URL: "https://user:password@rpc.example/private?key=secret",
    });
    const secretSafe = createRpcSourceAuthority({ credential, endpoint: secretConfiguration.rpc.endpoint, clock });
    expect(secretSafe.sourceOwner).toBe("user_configured");
    expect(secretSafe.publicOrigin).toBe("https://rpc.example");
    expect(JSON.stringify(secretSafe)).not.toContain("password");
    expect(JSON.stringify(secretSafe)).not.toContain("private");
    expect(JSON.stringify(secretSafe)).not.toContain("secret");

    const slashConfiguration = readRuntimeConfiguration({ LITTLEJOHN_RPC_URL: "https://rpc.mainnet.chain.robinhood.com/" });
    const slash = createRpcSourceAuthority({ credential, endpoint: slashConfiguration.rpc.endpoint, clock });
    expect(slash.configurationDigest).toBe("5VnFZF1HaHhd_PK5drKjmVZbZ21ca8n_QrhkoS3pR-o");
    expect(slash.sourceOwner).toBe("Robinhood");
    expect(readConfiguredRpcEndpoint(slashConfiguration.rpc.endpoint).exactUri)
      .toBe("https://rpc.mainnet.chain.robinhood.com/");

    const emptyUserInfoAuthorities = [
      "https://@rpc.mainnet.chain.robinhood.com/",
      "https://:@rpc.mainnet.chain.robinhood.com/",
    ].map((exactUri) => {
      const configured = readRuntimeConfiguration({ LITTLEJOHN_RPC_URL: exactUri });
      expect(configured.rpc.endpoint.sourceOwner).toBe("Robinhood");
      return createRpcSourceAuthority({ credential, endpoint: configured.rpc.endpoint, clock });
    });
    expect(new Set([
      rpc.configurationDigest,
      ...emptyUserInfoAuthorities.map(({ configurationDigest }) => configurationDigest),
    ]).size).toBe(3);

    const profileId = Buffer.alloc(16, 2).toString("base64url") as never;
    const wallet = createWalletSourceAuthority({ credential, profileId, clock });
    expect(wallet.sdkStoreSourceId).toBe(`wallet-sdk:${profileId}`);
    const session = wallet.createSessionSource("secret-topic");
    expect(session).toMatchObject({
      sourceId: "wallet-session:3I4Q0digMLRmE7X4WT7MbMvX_iiR_cE6WKlsqCjENy4",
      candidateId: "wallet-session:3I4Q0digMLRmE7X4WT7MbMvX_iiR_cE6WKlsqCjENy4",
      topicDigest: "3I4Q0digMLRmE7X4WT7MbMvX_iiR_cE6WKlsqCjENy4",
    });
    expect(Object.isFrozen(session)).toBe(true);
    const authorities = new ObservationAuthorityRegistry(clock, [session.observationAuthority]);
    expect(authorities.owns("wallet_session", session.observationAuthority)).toBe(true);
    expect(JSON.stringify(session)).not.toContain("secret-topic");
  });

  it("rejects empty fragments and Unicode inputs that collide under replacement encoding", async () => {
    expect(() => readRuntimeConfiguration({ LITTLEJOHN_RPC_URL: "https://rpc.example/#" })).toThrow("without a fragment");
    expect(() => readRuntimeConfiguration({ LITTLEJOHN_RPC_URL: "https://rpc.example/\uD800" }))
      .toThrow("valid absolute HTTPS URL");

    const directory = await temporaryDirectory();
    const paths = runtimePaths(directory);
    const credential = await loadOrCreateControlCredential(directory, paths.controlCredential);
    const clock = createCanonicalClock(() => observedAt);
    const wallet = createWalletSourceAuthority({
      credential,
      profileId: Buffer.alloc(16, 2).toString("base64url") as never,
      clock,
    });
    expect(() => wallet.createSessionSource("\uD800")).toThrow("invalid");
  });
});
