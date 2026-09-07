import { fork, type ChildProcess } from "node:child_process";
import { chmod, lstat, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serialize } from "node:v8";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  openWalletConnectStorage,
  walletConnectStorageDatabaseFileName,
} from "../../src/wallet/walletconnect-storage.js";

const roots: string[] = [];
const children: ChildProcess[] = [];

const privateRoot = async (): Promise<string> => {
  const root = await mkdtemp(resolve(tmpdir(), "littlejohn-wallet-storage-"));
  roots.push(root);
  if (process.platform !== "win32") await chmod(root, 0o700);
  return root;
};

const databasePath = (root: string): string =>
  resolve(root, walletConnectStorageDatabaseFileName);

interface NativeRead {
  readonly sql: string;
  readonly readOnly: boolean;
  readonly rows: Record<string, unknown>[];
}

// Observe actual driver results before the product decoder, without replacing
// the query, its arguments, its result or the native iterator's cleanup.
const observeAdmissionReads = (): NativeRead[] => {
  const reads: NativeRead[] = [];
  const prepare = Database.prototype.prepare;
  vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
    this: Database.Database, sql: string,
  ) {
    const statement = prepare.call(this, sql) as Database.Statement;
    if (sql.includes("FROM sqlite_schema") || sql.includes("FROM walletconnect_storage_metadata")) {
      const all = statement.all.bind(statement);
      const readOnly = this.readonly;
      vi.spyOn(statement, "all").mockImplementation((...parameters: unknown[]) => {
        const rows = all(...parameters) as Record<string, unknown>[];
        reads.push({ sql, readOnly, rows });
        return rows;
      });
    } else if (sql.includes("AS keyStorageClass")) {
      const iterate = statement.iterate.bind(statement);
      const readOnly = this.readonly;
      vi.spyOn(statement, "iterate").mockImplementation(function* (...parameters: unknown[]) {
        const read: NativeRead = { sql, readOnly, rows: [] };
        reads.push(read);
        for (const row of iterate(...parameters)) {
          read.rows.push(row as Record<string, unknown>);
          yield row;
        }
      });
    }
    return statement;
  });
  return reads;
};

const bufferWithEncodedSize = (bytes: number): Buffer => {
  const overhead = serialize(Buffer.alloc(bytes)).length - bytes;
  const value = Buffer.alloc(bytes - overhead);
  expect(serialize(value).length).toBe(bytes);
  return value;
};

const keyAdmissionSummaries = (reads: readonly NativeRead[]): Record<string, unknown>[] =>
  reads.filter((read) => read.sql.includes("AS keyStorageClass")).flatMap((read) =>
    read.rows.map(({ keyPrefix, ...metadata }) => ({
      ...metadata,
      // Keep adversarial failure output bounded even if a projection regresses.
      keyPrefix: keyPrefix === null ? null : {
        type: Buffer.isBuffer(keyPrefix) ? "blob" : typeof keyPrefix,
        bytes: Buffer.isBuffer(keyPrefix) ? keyPrefix.length :
          typeof keyPrefix === "string" ? Buffer.byteLength(keyPrefix, "utf8") : undefined,
      },
    })));

const metadataValueSummary = (value: unknown): unknown => {
  if (Buffer.isBuffer(value)) return { type: "blob", bytes: value.length };
  if (typeof value === "string") return { type: "text", bytes: Buffer.byteLength(value, "utf8") };
  return value;
};

const metadataReadSummaries = (reads: readonly NativeRead[]) =>
  reads.filter((read) => read.sql.includes("FROM walletconnect_storage_metadata"))
    .map((read) => ({
      readOnly: read.readOnly,
      rows: read.rows.map((row) => ({
        singleton: metadataValueSummary(row["singleton"]),
        revision: metadataValueSummary(row["revision"]),
      })),
    }));

const createMetadataFixture = async (
  rows: readonly (readonly [unknown, unknown])[],
): Promise<string> => {
  const root = await privateRoot();
  const owner = await openWalletConnectStorage(root);
  owner.close();
  const raw = new Database(databasePath(root), { fileMustExist: true });
  try {
    const schema = raw.prepare(`SELECT sql FROM sqlite_schema
      WHERE name = 'walletconnect_storage_metadata'`).get() as { readonly sql: unknown };
    if (typeof schema.sql !== "string") throw new Error("Metadata fixture schema is unavailable.");
    // A permissive temporary declaration permits controlled stored-cell corruption;
    // the real opener must see the exact original schema, not a relaxed schema.
    raw.exec(`DROP TABLE walletconnect_storage_metadata;
      CREATE TABLE walletconnect_storage_metadata (
        singleton ANY NOT NULL PRIMARY KEY,
        revision ANY NOT NULL
      ) STRICT, WITHOUT ROWID`);
    const insert = raw.prepare("INSERT INTO walletconnect_storage_metadata VALUES (?, ?)");
    for (const row of rows) insert.run(...row);
    raw.unsafeMode(true);
    raw.pragma("writable_schema = ON");
    raw.prepare(`UPDATE sqlite_schema SET sql = ?
      WHERE name = 'walletconnect_storage_metadata'`).run(schema.sql);
    raw.pragma("writable_schema = OFF");
  } finally { raw.close(); }
  return root;
};

const expectMetadataOpeningRefused = async (root: string): Promise<void> => {
  let opened: Awaited<ReturnType<typeof openWalletConnectStorage>> | undefined;
  try {
    await expect(openWalletConnectStorage(root).then((owner) => {
      opened = owner;
      return owner;
    })).rejects.toThrow("WalletConnect private storage is unavailable.");
  } finally {
    // A weakened admission must not leak the unexpectedly published owner.
    opened?.close();
  }
};

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const launchCrashWorker = async (
  root: string,
  mode?: "exit-without-close",
): Promise<ChildProcess> => {
  const workerPath = fileURLToPath(
    new URL("./walletconnect-storage-crash-worker.ts", import.meta.url),
  );
  const child = fork(workerPath, mode === undefined ? [root] : [root, mode], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  children.push(child);
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer | string) => { stderr += chunk.toString(); });
  await new Promise<void>((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => {
      rejectReady(new Error(`WalletConnect storage crash worker timed out.\n${stderr}`));
    }, 10_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectReady(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      rejectReady(new Error(
        `WalletConnect storage crash worker exited (${String(code)}/${String(signal)}).\n${stderr}`,
      ));
    });
    child.on("message", (message: unknown) => {
      if (
        typeof message === "object" && message !== null &&
        (message as { readonly ready?: unknown }).ready === true
      ) {
        clearTimeout(timeout);
        resolveReady();
      }
    });
  });
  return child;
};

const waitForWorkerExit = async (
  child: ChildProcess,
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return new Promise((resolveExit) => {
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
};

const killCrashWorker = async (child: ChildProcess): Promise<void> => {
  const exited = new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>(
    (resolveExit) => child.once("exit", (code, signal) => resolveExit({ code, signal })),
  );
  if (!child.kill("SIGKILL")) throw new Error("WalletConnect storage crash worker could not be killed.");
  const result = await exited;
  if (process.platform !== "win32" && result.signal !== "SIGKILL") {
    throw new Error(
      `WalletConnect storage crash worker did not exit by SIGKILL (${String(result.code)}/${String(result.signal)}).`,
    );
  }
};

describe("WalletConnect SQLite storage owner", () => {
  it("durably round-trips opaque values and advances one revision per state change", async () => {
    const root = await privateRoot();
    const owner = await openWalletConnectStorage(root);

    expect(owner.checkpoint()).toBe(0n);
    await owner.storage.setItem("session", { accounts: ["0xabc"], expiry: 42 });
    expect(owner.checkpoint()).toBe(1n);
    await owner.storage.setItem("session", { accounts: ["0xdef"], expiry: 84 });
    expect(owner.checkpoint()).toBe(2n);
    expect(await owner.storage.getItem("session"))
      .toEqual({ accounts: ["0xdef"], expiry: 84 });
    await owner.storage.setItem("제안/🔐", new Uint8Array([1, 2, 3]));
    expect(owner.checkpoint()).toBe(3n);
    await owner.storage.removeItem("missing");
    expect(owner.checkpoint()).toBe(3n);

    expect(await owner.storage.getKeys()).toEqual(["session", "제안/🔐"]);
    expect(await owner.storage.getEntries()).toEqual([
      ["session", { accounts: ["0xdef"], expiry: 84 }],
      ["제안/🔐", new Uint8Array([1, 2, 3])],
    ]);
    expect(await owner.storage.getItem("session"))
      .toEqual({ accounts: ["0xdef"], expiry: 84 });

    await owner.storage.removeItem("제안/🔐");
    expect(owner.checkpoint()).toBe(4n);
    owner.close();

    const reopened = await openWalletConnectStorage(root);
    expect(reopened.checkpoint()).toBe(4n);
    expect(await reopened.storage.getEntries())
      .toEqual([["session", { accounts: ["0xdef"], expiry: 84 }]]);
    reopened.close();
  });

  it("commits the value and revision before returning the SDK mutation promise", async () => {
    const root = await privateRoot();
    const owner = await openWalletConnectStorage(root);

    const write = owner.storage.setItem("session", { valid: true });
    expect(owner.checkpoint()).toBe(1n);
    expect(await owner.storage.getItem("session")).toEqual({ valid: true });
    await write;

    await owner.storage.setItem("session", { valid: true });
    expect(owner.checkpoint()).toBe(2n);

    const removal = owner.storage.removeItem("session");
    expect(owner.checkpoint()).toBe(3n);
    expect(await owner.storage.getItem("session")).toBeUndefined();
    await removal;
    owner.close();
  });

  it("preserves a fulfilled mutation across abnormal process termination", async () => {
    const root = await privateRoot();
    const child = await launchCrashWorker(root);
    await killCrashWorker(child);

    const reopened = await openWalletConnectStorage(root);
    expect(reopened.checkpoint()).toBe(1n);
    expect(await reopened.storage.getItem("committed-before-crash"))
      .toEqual({ durable: true });
    reopened.close();
  }, 20_000);

  it.runIf(process.platform !== "win32")(
    "reopens a real main-plus-WAL artifact and leaves only owner-only artifacts",
    async () => {
      const root = await privateRoot();
      const child = await launchCrashWorker(root, "exit-without-close");
      expect(await waitForWorkerExit(child)).toEqual({ code: 0, signal: null });
      expect((await readdir(root)).sort()).toEqual([
        walletConnectStorageDatabaseFileName,
        `${walletConnectStorageDatabaseFileName}-wal`,
      ]);

      const reopened = await (async () => {
        const previousMask = process.umask(0o022);
        try {
          return await openWalletConnectStorage(root);
        } finally {
          process.umask(previousMask);
        }
      })();
      expect(await reopened.storage.getItem("committed-before-crash"))
        .toEqual({ durable: true });
      for (const entry of await readdir(root, { withFileTypes: true })) {
        const details = await lstat(resolve(root, entry.name));
        expect(details.mode & 0o777).toBe(0o600);
      }
      reopened.close();
    },
    20_000,
  );

  it("rejects concurrent ownership of the same private database", async () => {
    const root = await privateRoot();
    const first = await openWalletConnectStorage(root);
    await first.storage.setItem("committed", true);
    // A zero-wait diagnostic observes the retained lock, not a product deadline.
    const contender = new Database(databasePath(root), { readonly: true, timeout: 0 });
    try {
      expect(() => contender.prepare("SELECT revision FROM walletconnect_storage_metadata").get())
        .toThrow(expect.objectContaining({ code: "SQLITE_BUSY" }));
    } finally {
      contender.close();
    }

    await expect(openWalletConnectStorage(root))
      .rejects.toThrow("WalletConnect private storage is unavailable.");

    first.close();
    const successor = await openWalletConnectStorage(root);
    successor.close();
  }, 15_000);

  it("latches a codec failure and still closes the database handle", async () => {
    const root = await privateRoot();
    const owner = await openWalletConnectStorage(root);

    await expect(owner.storage.setItem("unsupported", () => undefined))
      .rejects.toThrow("WalletConnect private storage is unavailable.");
    expect(() => owner.checkpoint())
      .toThrow("WalletConnect private storage is unavailable.");
    expect(() => owner.close())
      .toThrow("WalletConnect private storage is unavailable.");

    const raw = new Database(databasePath(root), { fileMustExist: true });
    raw.close();
  });

  it("latches corrupt opaque bytes when they are decoded instead of treating them as absence", async () => {
    const root = await privateRoot();
    const owner = await openWalletConnectStorage(root);
    await owner.storage.setItem("session", { valid: true });
    owner.close();

    const raw = new Database(databasePath(root), { fileMustExist: true });
    raw.prepare("UPDATE walletconnect_storage_entry SET value = ? WHERE key = ?")
      .run(Buffer.from([0]), Buffer.from("session", "utf8"));
    raw.close();

    const corrupt = await openWalletConnectStorage(root);
    await expect(corrupt.storage.getItem("missing")).resolves.toBeUndefined();
    await expect(corrupt.storage.getItem("session"))
      .rejects.toThrow("WalletConnect private storage is unavailable.");
    await expect(corrupt.storage.getEntries())
      .rejects.toThrow("WalletConnect private storage is unavailable.");
    await expect(corrupt.storage.getKeys())
      .rejects.toThrow("WalletConnect private storage is unavailable.");
    expect(() => corrupt.close())
      .toThrow("WalletConnect private storage is unavailable.");
  });

  it("rejects malformed raw key bytes before exposing the SDK storage facade", async () => {
    const root = await privateRoot();
    const owner = await openWalletConnectStorage(root);
    owner.close();

    const raw = new Database(databasePath(root), { fileMustExist: true });
    raw.prepare("INSERT INTO walletconnect_storage_entry(key, value) VALUES (?, ?)")
      .run(Buffer.from([0x80]), serialize({ hidden: true }));
    raw.close();

    await expect(openWalletConnectStorage(root))
      .rejects.toThrow("WalletConnect private storage is unavailable.");
  });

  it("bounds raw key material before decoding a constraint-violating row", async () => {
    const root = await privateRoot();
    const owner = await openWalletConnectStorage(root);
    owner.close();

    const raw = new Database(databasePath(root), { fileMustExist: true });
    raw.pragma("ignore_check_constraints = ON");
    raw.prepare("INSERT INTO walletconnect_storage_entry(key, value) VALUES (?, ?)")
      .run(Buffer.alloc(4_097, 0x61), serialize({ hidden: true }));
    raw.close();

    const reads = observeAdmissionReads();
    await expect(openWalletConnectStorage(root))
      .rejects.toThrow("WalletConnect private storage is unavailable.");
    expect(keyAdmissionSummaries(reads)).toEqual([{
      keyStorageClass: "blob", keyBytes: 4_097n, keyPrefix: null,
      valueStorageClass: "blob", valueBytes: BigInt(serialize({ hidden: true }).length),
    }]);
  });

  it("bounds persisted admission at one row beyond the current key-count limit", async () => {
    const root = await privateRoot();
    const owner = await openWalletConnectStorage(root);
    owner.close();

    const raw = new Database(databasePath(root), { fileMustExist: true });
    const insert = raw.prepare(
      "INSERT INTO walletconnect_storage_entry(key, value) VALUES (?, ?)",
    );
    raw.transaction(() => {
      for (let index = 0; index <= 4_096; index += 1) {
        insert.run(Buffer.from(`key-${index.toString().padStart(4, "0")}`, "utf8"), serialize(null));
      }
    })();
    raw.close();

    await expect(openWalletConnectStorage(root))
      .rejects.toThrow("WalletConnect private storage is unavailable.");
  });

  it("rejects a large non-BLOB key under the exact current schema", async () => {
    const root = await privateRoot();
    const owner = await openWalletConnectStorage(root);
    owner.close();

    const schemaOwner = new Database(databasePath(root), { fileMustExist: true });
    const schema = schemaOwner.prepare(`SELECT sql FROM sqlite_schema
      WHERE type = 'table' AND name = 'walletconnect_storage_entry'`).get() as
      | { readonly sql?: unknown }
      | undefined;
    if (typeof schema?.sql !== "string") throw new Error("WalletConnect test schema is unavailable.");
    const exactSql = schema.sql;
    schemaOwner.unsafeMode(true);
    schemaOwner.pragma("writable_schema = ON");
    schemaOwner.prepare(`UPDATE sqlite_schema SET sql = ?
      WHERE type = 'table' AND name = 'walletconnect_storage_entry'`).run(
      `CREATE TABLE walletconnect_storage_entry (
        key TEXT NOT NULL PRIMARY KEY,
        value BLOB NOT NULL
      ) STRICT, WITHOUT ROWID`,
    );
    schemaOwner.pragma("writable_schema = OFF");
    schemaOwner.close();

    const forged = new Database(databasePath(root), { fileMustExist: true });
    forged.prepare("INSERT INTO walletconnect_storage_entry(key, value) VALUES (?, ?)")
      .run("a".repeat(8 * 1024 * 1024), serialize(null));
    forged.unsafeMode(true);
    forged.pragma("writable_schema = ON");
    forged.prepare(`UPDATE sqlite_schema SET sql = ?
      WHERE type = 'table' AND name = 'walletconnect_storage_entry'`).run(exactSql);
    forged.pragma("writable_schema = OFF");
    forged.close();

    const reads = observeAdmissionReads();
    await expect(openWalletConnectStorage(root))
      .rejects.toThrow("WalletConnect private storage is unavailable.");
    expect(keyAdmissionSummaries(reads)).toEqual([{
      keyStorageClass: "text", keyBytes: null, keyPrefix: null,
      valueStorageClass: "blob", valueBytes: BigInt(serialize(null).length),
    }]);
  });

  it.each(["healthy", "nested write", "failed", "closed"] as const)(
    "rechecks write admission after codec return: %s", async (mode) => {
      const root = await privateRoot();
      const owner = await openWalletConnectStorage(root);
      await owner.storage.setItem("retained", true);
      let inner: Promise<unknown> | undefined;
      const value = { get data() {
        if (mode === "failed") inner = owner.storage.removeItem("").catch((error: unknown) => error);
        if (mode === "closed") owner.close();
        if (mode === "nested write") inner = owner.storage.setItem("inner", true);
        return "opaque";
      } };

      const outer = owner.storage.setItem("outer", value);
      if (mode === "healthy" || mode === "nested write") {
        await outer;
        await inner;
        expect(await owner.storage.getItem("outer")).toEqual({ data: "opaque" });
        expect(owner.checkpoint()).toBe(mode === "healthy" ? 2n : 3n);
        owner.close();
      } else {
        await expect(outer).rejects.toThrow("WalletConnect private storage is unavailable.");
        if (mode === "failed") await expect(outer).rejects.toBe(await inner);
        expect(() => owner.checkpoint()).toThrow("WalletConnect private storage is unavailable.");
        expect(() => owner.close()).toThrow("WalletConnect private storage is unavailable.");
      }

      const reopened = await openWalletConnectStorage(root);
      expect(await reopened.storage.getItem("retained")).toBe(true);
      expect(await reopened.storage.getItem("outer"))
        .toEqual(mode === "failed" || mode === "closed" ? undefined : { data: "opaque" });
      expect(await reopened.storage.getItem("inner")).toBe(mode === "nested write" ? true : undefined);
      expect(reopened.checkpoint()).toBe(
        mode === "nested write" ? 3n : mode === "healthy" ? 2n : 1n,
      );
      reopened.close();
    },
  );

  it("latches an invalid removal without deleting or advancing stored state", async () => {
    const root = await privateRoot();
    const owner = await openWalletConnectStorage(root);
    await owner.storage.setItem("session", { valid: true });

    await expect(owner.storage.removeItem(""))
      .rejects.toThrow("WalletConnect private storage is unavailable.");
    expect(() => owner.checkpoint())
      .toThrow("WalletConnect private storage is unavailable.");
    expect(() => owner.close())
      .toThrow("WalletConnect private storage is unavailable.");

    const reopened = await openWalletConnectStorage(root);
    expect(reopened.checkpoint()).toBe(1n);
    expect(await reopened.storage.getItem("session")).toEqual({ valid: true });
    reopened.close();
  });

  it("closes an open owner without manufacturing a storage failure", async () => {
    const root = await privateRoot();
    const owner = await openWalletConnectStorage(root);
    await owner.storage.setItem("session", { valid: true });

    owner.close();
    owner.close();
    await expect(owner.storage.getItem("session"))
      .rejects.toThrow("WalletConnect private storage is unavailable.");
  });

  it.each(["UTF-8", "UTF-16le", "UTF-16be"])(
    "preserves exact native schema bytes and bounds a changed SQL value in %s", async (encoding) => {
      const baselineRoot = await privateRoot();
      const baseline = await openWalletConnectStorage(baselineRoot);
      baseline.close();
      const original = new Database(databasePath(baselineRoot), { readonly: true });
      const schema = original.prepare(`SELECT sql FROM sqlite_schema
        WHERE name NOT GLOB 'sqlite_*' ORDER BY name`).all() as { sql: string }[];
      original.close();

      const root = await privateRoot();
      const raw = new Database(databasePath(root));
      raw.pragma(`encoding = '${encoding}'`);
      raw.pragma("journal_mode = WAL");
      for (const row of schema) raw.exec(row.sql);
      raw.exec("INSERT INTO walletconnect_storage_metadata VALUES (1, 0)");
      raw.close();
      if (process.platform !== "win32") await chmod(databasePath(root), 0o600);

      const reads = observeAdmissionReads();
      const owner = await openWalletConnectStorage(root);
      await owner.storage.setItem("opaque/🔐", { value: "retained" });
      owner.close();
      const schemas = reads.filter((read) => read.sql.includes("FROM sqlite_schema"));
      expect(schemas.map((read) => read.readOnly)).toEqual([true, false]);
      expect(schemas.map((read) => read.rows.length)).toEqual([2, 2]);
      const trusted = schemas[0]!.rows;
      for (const read of schemas) {
        for (const row of read.rows) {
          for (const field of ["type", "name", "tableName", "sql"]) {
            expect(row[`${field}Storage`]).toBe("text");
            expect(Buffer.isBuffer(row[field])).toBe(true);
          }
        }
      }
      const reopened = await openWalletConnectStorage(root);
      expect(await reopened.storage.getItem("opaque/🔐")).toEqual({ value: "retained" });
      expect(reopened.checkpoint()).toBe(1n);
      reopened.close();

      const changed = new Database(databasePath(root), { fileMustExist: true });
      // A valid SQLite comment enlarges only the rejected schema value.
      const entrySql = schema.find((row) => row.sql.includes("CREATE TABLE walletconnect_storage_entry"))!.sql;
      changed.exec("DROP TABLE walletconnect_storage_entry");
      changed.exec(entrySql.replace("(", `(/*${"x".repeat(1024 * 1024)}*/`));
      changed.close();
      reads.length = 0;
      await expect(openWalletConnectStorage(root))
        .rejects.toThrow("WalletConnect private storage is unavailable.");
      expect(reads).toHaveLength(1);
      expect(reads[0]?.readOnly).toBe(true);
      expect(reads[0]?.rows).toHaveLength(2);
      const maximumSqlBytes = Math.max(...trusted.map((row) => (row["sql"] as Buffer).length));
      expect(Math.max(...reads[0]!.rows.map((row) => (row["sql"] as Buffer).length)))
        .toBe(maximumSqlBytes + 1);
    },
  );

  it.each(["long name", "extra rows", "NUL suffix"])(
    "bounds noncurrent schema fields and row count before rejection: %s", async (variant) => {
      const root = await privateRoot();
      const original = await openWalletConnectStorage(root);
      original.close();
      const reads = observeAdmissionReads();
      const control = await openWalletConnectStorage(root);
      control.close();
      const trusted = reads.find((read) => read.sql.includes("FROM sqlite_schema"))!.rows;
      const raw = new Database(databasePath(root), { fileMustExist: true });
      try {
        if (variant === "long name") {
          raw.exec(`CREATE TABLE "${"x".repeat(65_536)}" (value BLOB)`);
        } else if (variant === "extra rows") {
          raw.exec("CREATE TABLE extra_one (value BLOB); CREATE TABLE extra_two (value BLOB)");
        } else {
          raw.unsafeMode(true);
          raw.pragma("writable_schema = ON");
          raw.prepare(`UPDATE sqlite_schema SET sql = sql || ?
            WHERE name = 'walletconnect_storage_entry'`).run("\0suffix");
          raw.pragma("writable_schema = OFF");
        }
      } finally { raw.close(); }
      reads.length = 0;

      await expect(openWalletConnectStorage(root))
        .rejects.toThrow("WalletConnect private storage is unavailable.");
      expect(reads).toHaveLength(1);
      const rows = reads[0]!.rows;
      expect(rows.length).toBe(variant === "NUL suffix" ? 2 : 3);
      for (const field of ["type", "name", "tableName", "sql"]) {
        const maximum = Math.max(...trusted.map((row) => (row[field] as Buffer).length));
        expect(Math.max(...rows.map((row) => (row[field] as Buffer).length)))
          .toBeLessThanOrEqual(maximum + 1);
      }
    },
  );

  it("rejects noncurrent structure rather than repairing or interpreting it", async () => {
    const root = await privateRoot();
    const raw = new Database(databasePath(root));
    raw.pragma("journal_mode = WAL");
    raw.exec("CREATE TABLE legacy_wallet_state (value TEXT NOT NULL) STRICT");
    raw.close();
    if (process.platform !== "win32") await chmod(databasePath(root), 0o600);

    await expect(openWalletConnectStorage(root))
      .rejects.toThrow("WalletConnect private storage is unavailable.");

    const inspection = new Database(databasePath(root), { readonly: true, fileMustExist: true });
    expect(inspection.prepare(`SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all())
      .toEqual([{ name: "legacy_wallet_state" }]);
    inspection.close();
  });

  it("does not hide a user SQLite object whose name only resembles the reserved prefix", async () => {
    const root = await privateRoot();
    const owner = await openWalletConnectStorage(root);
    owner.close();

    const raw = new Database(databasePath(root), { fileMustExist: true });
    raw.exec("CREATE TABLE sqliteXlegacy (value TEXT NOT NULL) STRICT");
    raw.close();

    await expect(openWalletConnectStorage(root))
      .rejects.toThrow("WalletConnect private storage is unavailable.");
  });

  it("rejects more than one metadata row under the exact current schema", async () => {
    const root = await privateRoot();
    const owner = await openWalletConnectStorage(root);
    owner.close();

    const schemaOwner = new Database(databasePath(root), { fileMustExist: true });
    const schema = schemaOwner.prepare(`SELECT sql FROM sqlite_schema
      WHERE type = 'table' AND name = 'walletconnect_storage_metadata'`).get() as
      | { readonly sql?: unknown }
      | undefined;
    if (typeof schema?.sql !== "string") throw new Error("WalletConnect test schema is unavailable.");
    const exactSql = schema.sql;
    schemaOwner.unsafeMode(true);
    schemaOwner.pragma("writable_schema = ON");
    schemaOwner.prepare(`UPDATE sqlite_schema SET sql = ?
      WHERE type = 'table' AND name = 'walletconnect_storage_metadata'`).run(
      `CREATE TABLE walletconnect_storage_metadata (
        singleton INTEGER NOT NULL PRIMARY KEY,
        revision INTEGER NOT NULL
      ) STRICT, WITHOUT ROWID`,
    );
    schemaOwner.pragma("writable_schema = OFF");
    schemaOwner.close();

    const forged = new Database(databasePath(root), { fileMustExist: true });
    forged.prepare(
      "INSERT INTO walletconnect_storage_metadata(singleton, revision) VALUES (2, 0)",
    ).run();
    forged.unsafeMode(true);
    forged.pragma("writable_schema = ON");
    forged.prepare(`UPDATE sqlite_schema SET sql = ?
      WHERE type = 'table' AND name = 'walletconnect_storage_metadata'`).run(exactSql);
    forged.pragma("writable_schema = OFF");
    forged.close();

    await expect(openWalletConnectStorage(root))
      .rejects.toThrow("WalletConnect private storage is unavailable.");
  });

  it("rejects orphaned SQLite sidecars instead of treating them as a fresh store", async () => {
    const root = await privateRoot();
    const orphan = new Database(`${databasePath(root)}-wal`);
    orphan.close();
    if (process.platform !== "win32") await chmod(`${databasePath(root)}-wal`, 0o600);

    await expect(openWalletConnectStorage(root))
      .rejects.toThrow("WalletConnect private storage is unavailable.");
    expect(await readdir(root)).toEqual([`${walletConnectStorageDatabaseFileName}-wal`]);
  });

  it.each([
    ["negative revision", "revision = -1"],
    ["wrong singleton", "singleton = 2"],
  ])("rejects invalid stored metadata before exposing the facade: %s", async (_name, assignment) => {
    const root = await privateRoot();
    const owner = await openWalletConnectStorage(root);
    owner.close();
    const raw = new Database(databasePath(root), { fileMustExist: true });
    try {
      raw.pragma("ignore_check_constraints = ON");
      raw.exec(`UPDATE walletconnect_storage_metadata SET ${assignment}`);
    } finally { raw.close(); }
    await expect(openWalletConnectStorage(root))
      .rejects.toThrow("WalletConnect private storage is unavailable.");
  });

  it.each([0n, 9_223_372_036_854_775_807n])(
    "preserves exact integer metadata through both opening passes: %s", async (revision) => {
      const root = await createMetadataFixture([[1n, revision]]);
      const reads = observeAdmissionReads();
      const owner = await openWalletConnectStorage(root);
      try {
        expect(metadataReadSummaries(reads)).toEqual([
          { readOnly: true, rows: [{ singleton: 1n, revision }] },
          { readOnly: false, rows: [{ singleton: 1n, revision }] },
        ]);
        expect(owner.checkpoint()).toBe(revision);
      } finally { owner.close(); }
    },
  );

  it.each([
    ["singleton", "blob"], ["singleton", "text"],
    ["revision", "blob"], ["revision", "text"],
  ] as const)("withholds invalid metadata payload before opening: %s %s", async (field, type) => {
    // One MiB witnesses variable-size transfer; it is not a storage quota.
    const payload = type === "blob" ? Buffer.alloc(1_048_576, 0x61) : "a".repeat(1_048_576);
    const root = await createMetadataFixture([
      [field === "singleton" ? payload : 1n, field === "revision" ? payload : 0n],
    ]);
    const reads = observeAdmissionReads();
    await expectMetadataOpeningRefused(root);
    expect(metadataReadSummaries(reads)).toEqual([{
      readOnly: true,
      rows: [{ singleton: field === "singleton" ? null : 1n, revision: field === "revision" ? null : 0n }],
    }]);
  });

  it("retains invalid metadata rows instead of admitting a filtered singleton", async () => {
    const root = await createMetadataFixture([[1n, 0n], [Buffer.alloc(1_048_576, 0x61), 0n]]);
    const reads = observeAdmissionReads();
    await expectMetadataOpeningRefused(root);
    const metadata = metadataReadSummaries(reads);
    expect(metadata).toHaveLength(1);
    expect(metadata[0]?.readOnly).toBe(true);
    expect(metadata[0]?.rows).toHaveLength(2);
    expect(metadata[0]?.rows).toEqual(expect.arrayContaining([
      { singleton: 1n, revision: 0n },
      { singleton: null, revision: 0n },
    ]));
  });

  it("rejects mixed legacy artifacts without creating a new current store beside them", async () => {
    const root = await privateRoot();
    await writeFile(resolve(root, "legacy-record"), "opaque state", { mode: 0o600 });
    if (process.platform !== "win32") await chmod(resolve(root, "legacy-record"), 0o600);

    await expect(openWalletConnectStorage(root))
      .rejects.toThrow("WalletConnect private storage is unavailable.");
    expect(await readdir(root)).toEqual(["legacy-record"]);
  });

  it("rolls back entry writes and removals when the native revision is exhausted", async () => {
    const root = await privateRoot();
    const owner = await openWalletConnectStorage(root);
    await owner.storage.setItem("retained", { valid: true });
    owner.close();

    const raw = new Database(databasePath(root), { fileMustExist: true });
    raw.prepare("UPDATE walletconnect_storage_metadata SET revision = ?")
      .run(9_223_372_036_854_775_807n);
    raw.close();

    const writeOwner = await openWalletConnectStorage(root);
    await writeOwner.storage.removeItem("missing");
    expect(writeOwner.checkpoint()).toBe(9_223_372_036_854_775_807n);
    await expect(writeOwner.storage.setItem("rolled-back", true))
      .rejects.toThrow("WalletConnect private storage is unavailable.");
    expect(() => writeOwner.close())
      .toThrow("WalletConnect private storage is unavailable.");

    const writeInspection = new Database(databasePath(root), { readonly: true, fileMustExist: true });
    expect(writeInspection.prepare("SELECT revision FROM walletconnect_storage_metadata")
      .safeIntegers().get()).toEqual({ revision: 9_223_372_036_854_775_807n });
    expect(writeInspection.prepare(
      "SELECT key FROM walletconnect_storage_entry ORDER BY key",
    ).all()).toEqual([{ key: Buffer.from("retained", "utf8") }]);
    writeInspection.close();

    const removalOwner = await openWalletConnectStorage(root);
    await expect(removalOwner.storage.removeItem("retained"))
      .rejects.toThrow("WalletConnect private storage is unavailable.");
    expect(() => removalOwner.close())
      .toThrow("WalletConnect private storage is unavailable.");

    const removalInspection = new Database(databasePath(root), { readonly: true, fileMustExist: true });
    expect(removalInspection.prepare("SELECT revision FROM walletconnect_storage_metadata")
      .safeIntegers().get()).toEqual({ revision: 9_223_372_036_854_775_807n });
    expect(removalInspection.prepare(
      "SELECT key FROM walletconnect_storage_entry ORDER BY key",
    ).all()).toEqual([{ key: Buffer.from("retained", "utf8") }]);
    removalInspection.close();
  });

  it("admits exact canonical UTF-8 key bytes and rejects one byte more", async () => {
    const root = await privateRoot();
    const key = "é".repeat(2_048);
    expect(Buffer.byteLength(key, "utf8")).toBe(4_096);
    const owner = await openWalletConnectStorage(root);
    await owner.storage.setItem(key, true);
    expect(await owner.storage.getItem(key)).toBe(true);
    owner.close();

    const reads = observeAdmissionReads();
    const reopened = await openWalletConnectStorage(root);
    expect(await reopened.storage.getKeys()).toEqual([key]);
    const projected = reads.filter((read) => read.sql.includes("AS keyStorageClass"));
    expect(projected.map((read) => read.readOnly)).toEqual([true, false]);
    for (const read of projected) expect(read.rows).toEqual([{
      keyStorageClass: "blob", keyBytes: 4_096n, keyPrefix: Buffer.from(key),
      valueStorageClass: "blob", valueBytes: BigInt(serialize(true).length),
    }]);
    await expect(reopened.storage.setItem(`${key}x`, true))
      .rejects.toThrow("WalletConnect private storage is unavailable.");
    expect(() => reopened.close())
      .toThrow("WalletConnect private storage is unavailable.");

    const raw = new Database(databasePath(root), { readonly: true });
    try {
      expect(raw.prepare("SELECT key FROM walletconnect_storage_entry").all())
        .toEqual([{ key: Buffer.from(key) }]);
      expect(raw.prepare("SELECT revision FROM walletconnect_storage_metadata").safeIntegers().get())
        .toEqual({ revision: 1n });
    } finally { raw.close(); }
  });

  it("admits exact serialized-value bytes and refuses one byte more before entry writes", async () => {
    const root = await privateRoot();
    let entryWrites = 0;
    const prepare = Database.prototype.prepare;
    vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
      this: Database.Database, sql: string,
    ) {
      const statement = prepare.call(this, sql) as Database.Statement;
      if (sql.startsWith("INSERT INTO walletconnect_storage_entry")) {
        const run = statement.run.bind(statement);
        vi.spyOn(statement, "run").mockImplementation((...parameters: unknown[]) => {
          entryWrites += 1;
          return run(...parameters);
        });
      }
      return statement;
    });
    const exact = bufferWithEncodedSize(16_777_216);
    const owner = await openWalletConnectStorage(root);
    await owner.storage.setItem("exact", exact);
    expect(entryWrites).toBe(1);
    expect(owner.checkpoint()).toBe(1n);
    owner.close();

    const reopened = await openWalletConnectStorage(root);
    const restored = await reopened.storage.getItem("exact");
    expect(Buffer.isBuffer(restored)).toBe(true);
    expect((restored as Buffer).equals(exact)).toBe(true);
    await expect(reopened.storage.setItem("oversized", bufferWithEncodedSize(16_777_217)))
      .rejects.toThrow("WalletConnect private storage is unavailable.");
    expect(entryWrites).toBe(1);
    expect(() => reopened.close())
      .toThrow("WalletConnect private storage is unavailable.");

    const raw = new Database(databasePath(root), { fileMustExist: true });
    try {
      expect(raw.prepare("SELECT key, length(value) AS bytes FROM walletconnect_storage_entry").all())
        .toEqual([{ key: Buffer.from("exact"), bytes: 16_777_216 }]);
      expect(raw.prepare("SELECT revision FROM walletconnect_storage_metadata").safeIntegers().get())
        .toEqual({ revision: 1n });
      raw.pragma("ignore_check_constraints = ON");
      raw.prepare("UPDATE walletconnect_storage_entry SET value = ?")
        .run(serialize(bufferWithEncodedSize(16_777_217)));
    } finally { raw.close(); }
    await expect(openWalletConnectStorage(root))
      .rejects.toThrow("WalletConnect private storage is unavailable.");
  });

  it("rejects a new key at the count limit without changing the stored revision", async () => {
    const root = await privateRoot();
    const owner = await openWalletConnectStorage(root);
    owner.close();

    const raw = new Database(databasePath(root), { fileMustExist: true });
    const insert = raw.prepare(
      "INSERT INTO walletconnect_storage_entry(key, value) VALUES (?, ?)",
    );
    const fill = raw.transaction(() => {
      for (let index = 0; index < 4_096; index += 1) {
        insert.run(Buffer.from(`key-${index.toString().padStart(4, "0")}`, "utf8"), serialize(index));
      }
      raw.prepare("UPDATE walletconnect_storage_metadata SET revision = 4096").run();
    });
    fill();
    raw.close();

    const full = await openWalletConnectStorage(root);
    await full.storage.setItem("key-0000", "replacement");
    expect((await full.storage.getKeys()).length).toBe(4_096);
    expect(await full.storage.getItem("key-0000")).toBe("replacement");
    expect(full.checkpoint()).toBe(4_097n);
    const revision = full.checkpoint();
    await expect(full.storage.setItem("overflow", true))
      .rejects.toThrow("WalletConnect private storage is unavailable.");
    expect(() => full.checkpoint())
      .toThrow("WalletConnect private storage is unavailable.");
    expect(() => full.close())
      .toThrow("WalletConnect private storage is unavailable.");

    const inspection = new Database(databasePath(root), { readonly: true, fileMustExist: true });
    expect(inspection.prepare("SELECT revision FROM walletconnect_storage_metadata")
      .safeIntegers().get()).toEqual({ revision });
    expect(inspection.prepare("SELECT count(*) AS count FROM walletconnect_storage_entry").get())
      .toEqual({ count: 4_096 });
    inspection.close();
  });

  it("admits exact aggregate capacity and rejects startup and mutation excess atomically", async () => {
    const root = await privateRoot();
    const owner = await openWalletConnectStorage(root);
    owner.close();

    const value = bufferWithEncodedSize(8_388_608);
    const encoded = serialize(value);
    expect(encoded.length).toBe(8_388_608);
    const raw = new Database(databasePath(root), { fileMustExist: true });
    const insert = raw.prepare(
      "INSERT INTO walletconnect_storage_entry(key, value) VALUES (?, ?)",
    );
    raw.transaction(() => {
      for (let index = 0; index < 16; index += 1) {
        insert.run(Buffer.from(`large-${index}`, "utf8"), encoded);
      }
      raw.prepare("UPDATE walletconnect_storage_metadata SET revision = 16").run();
    })();
    raw.close();

    const inspect = (count: number, bytes: number, revision: bigint): void => {
      const inspection = new Database(databasePath(root), { readonly: true, fileMustExist: true });
      try {
        expect(inspection.prepare(`SELECT count(*) AS count, sum(length(value)) AS bytes
          FROM walletconnect_storage_entry`).get()).toEqual({ count, bytes });
        expect(inspection.prepare("SELECT revision FROM walletconnect_storage_metadata")
          .safeIntegers().get()).toEqual({ revision });
      } finally { inspection.close(); }
    };
    const changeTail = (bytes: number, removeCandidate = false): void => {
      const fixture = new Database(databasePath(root), { fileMustExist: true });
      try {
        fixture.transaction(() => {
          if (removeCandidate) fixture.prepare("DELETE FROM walletconnect_storage_entry WHERE key = ?")
            .run(Buffer.from("candidate"));
          fixture.prepare("UPDATE walletconnect_storage_entry SET value = ? WHERE key = ?")
            .run(serialize(bufferWithEncodedSize(bytes)), Buffer.from("large-15"));
        })();
      } finally { fixture.close(); }
    };

    inspect(16, 134_217_728, 16n);
    const exact = await openWalletConnectStorage(root);
    await exact.storage.setItem("large-0", value);
    expect(exact.checkpoint()).toBe(17n);
    exact.close();
    inspect(16, 134_217_728, 17n);

    changeTail(8_388_609);
    inspect(16, 134_217_729, 17n);
    await expect(openWalletConnectStorage(root))
      .rejects.toThrow("WalletConnect private storage is unavailable.");
    inspect(16, 134_217_729, 17n);

    // A small candidate isolates net accounting without rebuilding the large fixture.
    const candidate = bufferWithEncodedSize(200);
    changeTail(8_388_608 - 200);
    const insertion = await openWalletConnectStorage(root);
    await insertion.storage.setItem("candidate", candidate);
    expect(await insertion.storage.getItem("candidate")).toEqual(candidate);
    insertion.close();
    inspect(17, 134_217_728, 18n);

    changeTail(8_388_608 - 199, true);
    const overflowing = await openWalletConnectStorage(root);
    await expect(overflowing.storage.setItem("candidate", candidate))
      .rejects.toThrow("WalletConnect private storage is unavailable.");
    expect(() => overflowing.close()).toThrow("WalletConnect private storage is unavailable.");
    inspect(16, 134_217_728 - 199, 18n);

    const replacement = await openWalletConnectStorage(root);
    await expect(replacement.storage.setItem("large-0", bufferWithEncodedSize(8_388_608 + 200)))
      .rejects.toThrow("WalletConnect private storage is unavailable.");
    expect(() => replacement.close()).toThrow("WalletConnect private storage is unavailable.");
    inspect(16, 134_217_728 - 199, 18n);
  }, 30_000);

  it.runIf(process.platform !== "win32")(
    "rejects permissive database permissions instead of repairing them",
    async () => {
      const root = await privateRoot();
      const owner = await openWalletConnectStorage(root);
      owner.close();
      await chmod(databasePath(root), 0o644);

      await expect(openWalletConnectStorage(root))
        .rejects.toThrow("WalletConnect private storage is unavailable.");
      expect((await lstat(databasePath(root))).mode & 0o777).toBe(0o644);
    },
  );

  it.runIf(process.platform !== "win32")(
    "creates every SQLite artifact with owner-only permissions",
    async () => {
      const root = await privateRoot();
      const owner = await openWalletConnectStorage(root);
      await owner.storage.setItem("session", { valid: true });

      const entries = await readdir(root, { withFileTypes: true });
      expect(entries.some((entry) => entry.name === walletConnectStorageDatabaseFileName)).toBe(true);
      for (const entry of entries) {
        const details = await lstat(resolve(root, entry.name));
        expect(details.mode & 0o777).toBe(0o600);
      }
      owner.close();
    },
  );
});
