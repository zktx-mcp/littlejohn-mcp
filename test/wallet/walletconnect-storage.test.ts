import { fork, type ChildProcess } from "node:child_process";
import { chmod, lstat, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serialize } from "node:v8";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

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
    owner.seal(4n);
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

    const removal = owner.storage.removeItem("session");
    expect(owner.checkpoint()).toBe(2n);
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
    owner.seal(owner.checkpoint());
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

    await expect(openWalletConnectStorage(root))
      .rejects.toThrow("WalletConnect private storage is unavailable.");
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

    await expect(openWalletConnectStorage(root))
      .rejects.toThrow("WalletConnect private storage is unavailable.");
  });

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

  it("makes a revision mismatch irreversible while leaving close available", async () => {
    const root = await privateRoot();
    const owner = await openWalletConnectStorage(root);
    const stale = owner.checkpoint();
    await owner.storage.setItem("session", { valid: true });

    expect(() => owner.seal(stale))
      .toThrow("WalletConnect private storage is unavailable.");
    await expect(owner.storage.getItem("session"))
      .rejects.toThrow("WalletConnect private storage is unavailable.");
    expect(() => owner.close())
      .toThrow("WalletConnect private storage is unavailable.");

    const raw = new Database(databasePath(root), { fileMustExist: true });
    raw.close();
  });

  it("rejects SDK facade access after a successful seal", async () => {
    const root = await privateRoot();
    const owner = await openWalletConnectStorage(root);
    owner.seal(owner.checkpoint());

    await expect(owner.storage.getKeys())
      .rejects.toThrow("WalletConnect private storage is unavailable.");
    expect(() => owner.close())
      .toThrow("WalletConnect private storage is unavailable.");
  });

  it("aborts an unsealed owner without manufacturing a storage failure", async () => {
    const root = await privateRoot();
    const owner = await openWalletConnectStorage(root);
    await owner.storage.setItem("session", { valid: true });

    owner.close();
    owner.close();
    await expect(owner.storage.getItem("session"))
      .rejects.toThrow("WalletConnect private storage is unavailable.");
  });

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

  it("enforces key and item limits before a mutation becomes durable", async () => {
    const root = await privateRoot();
    const tooLongKey = "x".repeat(4_097);
    const owner = await openWalletConnectStorage(root);
    await expect(owner.storage.setItem(tooLongKey, true))
      .rejects.toThrow("WalletConnect private storage is unavailable.");
    expect(() => owner.close())
      .toThrow("WalletConnect private storage is unavailable.");

    const cleanRoot = await privateRoot();
    const itemOwner = await openWalletConnectStorage(cleanRoot);
    await expect(itemOwner.storage.setItem("oversized", Buffer.alloc(16 * 1024 * 1024)))
      .rejects.toThrow("WalletConnect private storage is unavailable.");
    expect(() => itemOwner.close())
      .toThrow("WalletConnect private storage is unavailable.");
  });

  it("rejects a new key at the count limit without changing the stored revision", async () => {
    const root = await privateRoot();
    const owner = await openWalletConnectStorage(root);
    owner.seal(owner.checkpoint());
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

  it("rejects a mutation above the aggregate value limit without a partial write", async () => {
    const root = await privateRoot();
    const owner = await openWalletConnectStorage(root);
    owner.close();

    const encoded = serialize(Buffer.alloc(15 * 1024 * 1024));
    expect(encoded.length).toBeLessThan(16 * 1024 * 1024);
    const raw = new Database(databasePath(root), { fileMustExist: true });
    const insert = raw.prepare(
      "INSERT INTO walletconnect_storage_entry(key, value) VALUES (?, ?)",
    );
    raw.transaction(() => {
      for (let index = 0; index < 8; index += 1) {
        insert.run(Buffer.from(`large-${index}`, "utf8"), encoded);
      }
      raw.prepare("UPDATE walletconnect_storage_metadata SET revision = 8").run();
    })();
    raw.close();

    const bounded = await openWalletConnectStorage(root);
    await expect(bounded.storage.setItem("large-8", Buffer.alloc(15 * 1024 * 1024)))
      .rejects.toThrow("WalletConnect private storage is unavailable.");
    expect(() => bounded.close())
      .toThrow("WalletConnect private storage is unavailable.");

    const inspection = new Database(databasePath(root), { readonly: true, fileMustExist: true });
    expect(inspection.prepare("SELECT revision FROM walletconnect_storage_metadata")
      .safeIntegers().get()).toEqual({ revision: 8n });
    expect(inspection.prepare("SELECT count(*) AS count FROM walletconnect_storage_entry").get())
      .toEqual({ count: 8 });
    inspection.close();
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
