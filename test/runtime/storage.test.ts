import { fork, type ChildProcess } from "node:child_process";
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
  createCanonicalClock,
  parseCapabilityDataAt,
  parseUtcTimestamp,
  walletConnectionCapability,
} from "../../src/core/index.js";
import {
  createControlCredentialVerifier,
  loadOrCreateControlCredential,
  validateControlCredential,
} from "../../src/runtime/control-credential.js";
import {
  ProductDatabase,
  type ProductDatabaseStateFileAuthority,
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
  type OwnerOnlyStateFileLeaseFactory,
} from "../../src/runtime/paths.js";
import {
  createOwnerInstanceId,
  createProfileId,
  parseOwnerInstanceId,
  parseProfileId,
  parseRuntimeRevision,
  runtimeProtocolVersion,
} from "../../src/runtime/runtime-identity.js";

const directories: string[] = [];
const childProcesses: ChildProcess[] = [];
const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(resolve(tmpdir(), "littlejohn-runtime-"));
  directories.push(directory);
  return directory;
};
const observedAt = parseUtcTimestamp("2026-07-12T10:16:02.000Z");
const publicationStagingPath = (
  databasePath: string,
  tokenByte: number,
  suffix: "" | "-wal" | "-shm" = "",
): string => `${databasePath}.pending-2147483646-${Buffer.alloc(16, tokenByte).toString("base64url")}${suffix}`;

afterEach(async () => {
  for (const child of childProcesses.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const expectRuntimeCode = async (operation: Promise<unknown>, code: string): Promise<void> => {
  let failure: unknown;
  try { await operation; }
  catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(RuntimeOperationError);
  expect((failure as RuntimeOperationError).failure.error.code).toBe(code);
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

const launchSqliteCrashWorker = async (directory: string): Promise<ChildProcess> => {
  const workerPath = fileURLToPath(new URL("./sqlite-crash-worker.ts", import.meta.url));
  const child = fork(workerPath, [directory], {
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

const replacingStateFileAuthority = (
  replaceOnAssertion: number,
): { readonly authority: ProductDatabaseStateFileAuthority; readonly replacements: () => number } => {
  let replacements = 0;
  const acquireMainLease: OwnerOnlyStateFileLeaseFactory = (path, size) => {
    const lease = acquireOwnerOnlyStateFileLease(path, size);
    let assertions = 0;
    return Object.freeze({
      assertCurrent: (): void => {
        assertions += 1;
        if (assertions === replaceOnAssertion) {
          const replacement = `${path}.replacement`;
          copyFileSync(path, replacement);
          if (process.platform !== "win32") chmodSync(replacement, 0o600);
          renameSync(replacement, path);
          replacements += 1;
        }
        lease.assertCurrent();
      },
      stat: () => lease.stat(),
      read: (buffer: Buffer, offset: number, length: number, position: number) =>
        lease.read(buffer, offset, length, position),
      close: () => lease.close(),
    });
  };
  return Object.freeze({
    authority: Object.freeze({ acquireMainLease }),
    replacements: () => replacements,
  });
};

const connectedInput = (expiresAt = "2026-07-18T17:39:16.000Z") => ({
  status: "connected" as const,
  account: "eip155:4663:0x1111111111111111111111111111111111111111",
  address: "0x1111111111111111111111111111111111111111",
  chainId: "eip155:4663" as const,
  approvedMethods: ["eth_sendTransaction", "personal_sign"],
  approvedEvents: ["accountsChanged", "chainChanged"],
  expiresAt,
});

const connected = (expiresAt = "2026-07-18T17:39:16.000Z") =>
  parseCapabilityDataAt(walletConnectionCapability, connectedInput(expiresAt), observedAt);

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
    const before = await lstat(paths.controlCredential);
    await expectRuntimeCode(
      loadOrCreateControlCredential(directory, paths.controlCredential),
      "runtime_state_unavailable",
    );
    expect(await readFile(paths.controlCredential, "utf8")).toBe("invalid\n");
    expect((await lstat(paths.controlCredential)).ino).toBe(before.ino);

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
  it("uses one canonical runtime identity authority for stored owner identity", async () => {
    const profileId = createProfileId();
    const ownerInstanceId = createOwnerInstanceId();
    expect(parseProfileId(profileId)).toBe(profileId);
    expect(parseOwnerInstanceId(ownerInstanceId)).toBe(ownerInstanceId);
    expect(parseRuntimeRevision("0")).toBe("0");
    expect(runtimeProtocolVersion).toBe(1);
    const noncanonicalTail = `${"A".repeat(21)}B`;
    expect(() => parseProfileId(noncanonicalTail)).toThrow();
    expect(() => parseOwnerInstanceId(noncanonicalTail)).toThrow();
    expect(() => parseRuntimeRevision("01")).toThrow();

    const directory = await temporaryDirectory();
    await ensureOwnerOnlyDirectory(directory);
    const database = await ProductDatabase.open(runtimePaths(directory).database, observedAt);
    const record = database.ownerStore().publishOwner(ownerInstanceId, observedAt);
    expect(record).toMatchObject({
      profileId: database.ownerStore().readProfile().profileId,
      ownerInstanceId,
      protocolVersion: runtimeProtocolVersion,
      ownerRevision: "1",
    });
    database.close();
  });

  it("publishes one complete four-table database and preserves one profile", async () => {
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
        updatedAt: observedAt,
      });
      database.close();
    }
    const inspection = new Database(path, { readonly: true });
    expect(inspection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all())
      .toEqual([
        { name: "local_profile" },
        { name: "runtime_owner" },
        { name: "schema_migrations" },
        { name: "wallet_connection" },
      ]);
    expect(inspection.prepare("SELECT count(*) AS count FROM schema_migrations").get()).toEqual({ count: 1 });
    inspection.close();
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
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
    const finalInode = (await lstat(path)).ino;

    const afterSeparateStaging = await ProductDatabase.open(path, observedAt);
    expect(afterSeparateStaging.ownerStore().readProfile()).toEqual(profile);
    afterSeparateStaging.close();
    expect((await lstat(path)).ino).toBe(finalInode);
    for (const suffix of ["", "-wal", "-shm"] as const) {
      await expect(lstat(`${separateDatabase}${suffix}`)).rejects.toMatchObject({ code: "ENOENT" });
    }

    const publishedHardlink = publicationStagingPath(path, 3);
    await link(path, publishedHardlink);
    expect((await lstat(publishedHardlink)).ino).toBe(finalInode);
    const afterPublishedStaging = await ProductDatabase.open(path, observedAt);
    expect(afterPublishedStaging.ownerStore().readProfile()).toEqual(profile);
    afterPublishedStaging.close();
    expect((await lstat(path)).ino).toBe(finalInode);
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

  it("validates the final database before removing validly named publication staging", async () => {
    const directory = await temporaryDirectory();
    await ensureOwnerOnlyDirectory(directory);
    const path = runtimePaths(directory).database;
    const initialized = await ProductDatabase.open(path, observedAt);
    initialized.close();
    const staging = publicationStagingPath(path, 5);
    await writeFile(staging, "staging evidence", { mode: 0o600 });
    await writeFile(path, "invalid final database", { mode: 0o600 });
    const before = await sqliteDurableArtifactSnapshot(path);

    await expectRuntimeCode(ProductDatabase.open(path, observedAt), "runtime_state_unavailable");
    expect(await sqliteDurableArtifactSnapshot(path)).toEqual(before);
    expect(await readFile(staging, "utf8")).toBe("staging evidence");
  });

  it("uses stored update time for wallet meaning, canonicalizes arrays, and enforces CAS", async () => {
    const directory = await temporaryDirectory();
    await ensureOwnerOnlyDirectory(directory);
    const path = runtimePaths(directory).database;
    const database = await ProductDatabase.open(path, observedAt);
    const wallet = database.walletStore();
    const value = connected();
    const first = wallet.replace("0", value, observedAt);
    expect(first.revision).toBe("1");
    await expectRuntimeCode(
      Promise.resolve().then(() => wallet.replace("0", { status: "disconnected", reason: "no_session" }, observedAt)),
      "state_conflict",
    );
    const beforeInvalid = wallet.read();
    await expectRuntimeCode(
      Promise.resolve().then(() => wallet.replace("1", connectedInput(observedAt) as never, observedAt)),
      "runtime_state_unavailable",
    );
    expect(wallet.read()).toEqual(beforeInvalid);
    database.close();

    const raw = new Database(path, { readonly: true });
    const stored = raw.prepare("SELECT approved_methods_json, approved_events_json FROM wallet_connection").get() as {
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

  it("rejects missing or semantically corrupt existing state without repair", async () => {
    const cases: readonly {
      readonly name: string;
      readonly tamper: (database: Database.Database) => void;
      readonly verify: (database: Database.Database) => void;
    }[] = [
      {
        name: "missing profile",
        tamper: (database) => { database.prepare("DELETE FROM local_profile").run(); },
        verify: (database) => expect(database.prepare("SELECT count(*) AS count FROM local_profile").get()).toEqual({ count: 0 }),
      },
      {
        name: "invalid migration time",
        tamper: (database) => { database.prepare("UPDATE schema_migrations SET applied_at='bad'").run(); },
        verify: (database) => expect(database.prepare("SELECT applied_at FROM schema_migrations").get()).toEqual({ applied_at: "bad" }),
      },
      {
        name: "orphan owner",
        tamper: (database) => {
          database.pragma("foreign_keys=OFF");
          database.prepare(`INSERT INTO runtime_owner(singleton, profile_id, owner_instance_id, protocol_version,
            process_id, owner_revision, acquired_at) VALUES (1, ?, ?, 1, 1, '1', ?)`)
            .run(Buffer.alloc(16, 8).toString("base64url"), Buffer.alloc(16, 9).toString("base64url"), observedAt);
        },
        verify: (database) => expect((database.pragma("foreign_key_check") as unknown[]).length).toBe(1),
      },
    ];
    for (const testCase of cases) {
      const directory = await temporaryDirectory();
      await ensureOwnerOnlyDirectory(directory);
      const path = runtimePaths(directory).database;
      const product = await ProductDatabase.open(path, observedAt);
      product.close();
      const tamper = new Database(path);
      testCase.tamper(tamper);
      tamper.close();
      await expectRuntimeCode(ProductDatabase.open(path, observedAt), "runtime_state_unavailable");
      const verify = new Database(path, { readonly: true });
      testCase.verify(verify);
      verify.close();
    }
  });

  it("rejects noncanonical stored JSON without rewriting it", async () => {
    const directory = await temporaryDirectory();
    await ensureOwnerOnlyDirectory(directory);
    const path = runtimePaths(directory).database;
    const database = await ProductDatabase.open(path, observedAt);
    database.walletStore().replace("0", connected(), observedAt);
    database.close();
    const tamper = new Database(path);
    const noncanonical = '[ "eth_sendTransaction", "personal_sign" ]';
    tamper.prepare("UPDATE wallet_connection SET approved_methods_json=?").run(noncanonical);
    tamper.close();
    await expectRuntimeCode(ProductDatabase.open(path, observedAt), "runtime_state_unavailable");
    const verify = new Database(path, { readonly: true });
    expect((verify.prepare("SELECT approved_methods_json FROM wallet_connection").get() as { approved_methods_json: string }).approved_methods_json)
      .toBe(noncanonical);
    verify.close();
  });

  it("keeps wallet semantics in the core parser while SQLite enforces only the storage projection", async () => {
    const directory = await temporaryDirectory();
    await ensureOwnerOnlyDirectory(directory);
    const path = runtimePaths(directory).database;
    const database = await ProductDatabase.open(path, observedAt);
    database.close();

    const raw = new Database(path);
    const schema = (raw.prepare("SELECT sql FROM sqlite_schema WHERE name='wallet_connection'").get() as { sql: string }).sql;
    expect(schema).not.toContain("owner_unavailable");
    expect(schema).not.toContain("unusable_store");
    expect(schema).not.toContain("eip155:4663");
    expect(raw.prepare(`UPDATE wallet_connection SET
      status='unresolved', reason=NULL, account=NULL, address=NULL, chain_id=NULL,
      approved_methods_json=NULL, approved_events_json=NULL, expires_at=NULL,
      eligible_session_count='1' WHERE singleton=1`).run().changes).toBe(1);
    raw.close();

    const before = await sqliteArtifactSnapshot(path);
    await expectRuntimeCode(ProductDatabase.open(path, observedAt), "runtime_state_unavailable");
    expect(await sqliteArtifactSnapshot(path)).toEqual(before);
  });

  it("treats only a wholly absent SQLite artifact set as fresh and preserves rejected durable artifacts", async () => {
    const cases: readonly {
      readonly name: string;
      readonly prepare: (path: string) => Promise<void>;
    }[] = [
      {
        name: "zero-byte main",
        prepare: async (path) => { await createOwnerOnlyStateFile(path); },
      },
      {
        name: "orphan WAL",
        prepare: async (path) => { await writeFile(`${path}-wal`, "orphan", { mode: 0o600 }); },
      },
      {
        name: "DELETE-mode main",
        prepare: async (path) => {
          const database = new Database(path);
          database.exec("CREATE TABLE foreign_state(value TEXT)");
          database.close();
          if (process.platform !== "win32") await chmod(path, 0o600);
        },
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
      },
    ];
    for (const testCase of cases) {
      const directory = await temporaryDirectory();
      await ensureOwnerOnlyDirectory(directory);
      const path = runtimePaths(directory).database;
      await testCase.prepare(path);
      const before = await sqliteDurableArtifactSnapshot(path);
      await expectRuntimeCode(ProductDatabase.open(path, observedAt), "runtime_state_unavailable");
      expect(await sqliteDurableArtifactSnapshot(path), testCase.name).toEqual(before);
      expect((await readdir(directory)).every((name) => [
        "littlejohn.sqlite3",
        "littlejohn.sqlite3-wal",
        "littlejohn.sqlite3-shm",
      ].includes(name)), testCase.name).toBe(true);
    }
  });

  it("rejects migration identity and schema corruption without repairing persistent bytes", async () => {
    const cases: readonly {
      readonly name: string;
      readonly corrupt: (database: Database.Database) => void;
    }[] = [
      {
        name: "migration digest",
        corrupt: (database) => {
          database.prepare("UPDATE schema_migrations SET digest=? WHERE version=1").run("b".repeat(64));
        },
      },
      {
        name: "schema identity",
        corrupt: (database) => { database.exec("ALTER TABLE wallet_connection ADD COLUMN extra TEXT"); },
      },
    ];
    for (const testCase of cases) {
      const directory = await temporaryDirectory();
      await ensureOwnerOnlyDirectory(directory);
      const path = runtimePaths(directory).database;
      const product = await ProductDatabase.open(path, observedAt);
      product.close();
      const corrupt = new Database(path);
      testCase.corrupt(corrupt);
      corrupt.close();
      const before = await sqliteArtifactSnapshot(path);
      await expectRuntimeCode(ProductDatabase.open(path, observedAt), "runtime_state_unavailable");
      expect(await sqliteArtifactSnapshot(path), testCase.name).toEqual(before);
    }
  });

  it("validates an active WAL snapshot without creating a second product-state artifact", async () => {
    const directory = await temporaryDirectory();
    await ensureOwnerOnlyDirectory(directory);
    const path = runtimePaths(directory).database;
    const first = await ProductDatabase.open(path, observedAt);
    const expected = first.walletStore().replace("0", connected(), observedAt);
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
        writer.ownerStore().publishOwner(createOwnerInstanceId(), observedAt);
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

    const recovered = await ProductDatabase.open(path, observedAt);
    expect(recovered.walletStore().read().connection.status).toBe("connected");
    expect(await sqliteDurableArtifactSnapshot(path)).toEqual(before);
    const sharedMemory = await lstat(`${path}-shm`);
    expect(sharedMemory.isFile()).toBe(true);
    if (process.platform !== "win32") expect(sharedMemory.mode & 0o777).toBe(0o600);
    recovered.close();
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

  it("rejects invalid active-WAL state without changing durable database bytes", async () => {
    const directory = await temporaryDirectory();
    await ensureOwnerOnlyDirectory(directory);
    const path = runtimePaths(directory).database;
    const active = await ProductDatabase.open(path, observedAt);
    const tamper = new Database(path);
    tamper.prepare(`UPDATE wallet_connection SET
      status='unresolved', reason=NULL, account=NULL, address=NULL, chain_id=NULL,
      approved_methods_json=NULL, approved_events_json=NULL, expires_at=NULL,
      eligible_session_count='1' WHERE singleton=1`).run();
    tamper.close();

    const before = await sqliteDurableArtifactSnapshot(path);
    await expectRuntimeCode(ProductDatabase.open(path, observedAt), "runtime_state_unavailable");
    expect(await sqliteDurableArtifactSnapshot(path)).toEqual(before);
    const verify = new Database(path, { readonly: true });
    expect(verify.prepare("SELECT status, eligible_session_count FROM wallet_connection").get())
      .toEqual({ status: "unresolved", eligible_session_count: "1" });
    verify.close();
    active.close();
  });

  it("rejects physical B-tree corruption without changing any SQLite artifact", async () => {
    const directory = await temporaryDirectory();
    await ensureOwnerOnlyDirectory(directory);
    const path = runtimePaths(directory).database;
    const initialized = await ProductDatabase.open(path, observedAt);
    initialized.close();

    const inspection = new Database(path, { readonly: true, fileMustExist: true });
    const pageSize = inspection.pragma("page_size", { simple: true }) as number;
    const rootPage = (inspection.prepare("SELECT rootpage FROM sqlite_schema WHERE name='wallet_connection'").get() as {
      rootpage: number;
    }).rootpage;
    inspection.close();
    const corrupted = Buffer.from(await readFile(path));
    const pageHeaderOffset = (rootPage - 1) * pageSize;
    expect(corrupted[pageHeaderOffset]).not.toBe(0);
    corrupted[pageHeaderOffset] = 0;
    await writeFile(path, corrupted, { mode: 0o600 });
    const inode = (await lstat(path)).ino;
    const before = await sqliteArtifactSnapshot(path);

    await expectRuntimeCode(ProductDatabase.open(path, observedAt), "runtime_state_unavailable");
    expect(await sqliteArtifactSnapshot(path)).toEqual(before);
    expect((await lstat(path)).ino).toBe(inode);
  });

  it("rejects main-file replacement before and after writable validation", async () => {
    for (const replaceOnAssertion of [4, 7]) {
      const directory = await temporaryDirectory();
      await ensureOwnerOnlyDirectory(directory);
      const path = runtimePaths(directory).database;
      const initialized = await ProductDatabase.open(path, observedAt);
      initialized.close();
      const originalInode = (await lstat(path)).ino;
      const replacement = replacingStateFileAuthority(replaceOnAssertion);

      await expectRuntimeCode(
        ProductDatabase.open(path, observedAt, replacement.authority),
        "runtime_state_unavailable",
      );
      expect(replacement.replacements()).toBe(1);
      expect((await lstat(path)).ino).not.toBe(originalInode);
      expect((await readdir(directory)).some((name) => name.endsWith(".replacement"))).toBe(false);
      const reopened = await ProductDatabase.open(path, observedAt);
      reopened.close();
    }
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

  it("rejects weak or linked SQLite sidecars before opening and never repairs them", async () => {
    if (process.platform === "win32") return;

    const weakDirectory = await temporaryDirectory();
    await ensureOwnerOnlyDirectory(weakDirectory);
    const weakPath = runtimePaths(weakDirectory).database;
    const active = await ProductDatabase.open(weakPath, observedAt);
    const sharedMemoryPath = `${weakPath}-shm`;
    await chmod(sharedMemoryPath, 0o644);
    await expectRuntimeCode(ProductDatabase.open(weakPath, observedAt), "runtime_state_unavailable");
    expect((await stat(sharedMemoryPath)).mode & 0o777).toBe(0o644);
    active.close();

    const linkDirectory = await temporaryDirectory();
    await ensureOwnerOnlyDirectory(linkDirectory);
    const linkPath = runtimePaths(linkDirectory).database;
    const initialized = await ProductDatabase.open(linkPath, observedAt);
    initialized.close();
    const target = resolve(linkDirectory, "foreign-wal-target");
    await writeFile(target, "unchanged", { mode: 0o600 });
    await symlink(target, `${linkPath}-wal`);
    await expectRuntimeCode(ProductDatabase.open(linkPath, observedAt), "runtime_state_unavailable");
    expect(await readFile(target, "utf8")).toBe("unchanged");
    expect((await lstat(`${linkPath}-wal`)).isSymbolicLink()).toBe(true);
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
    expect(configuration.wallet).toEqual({
      projectId: "cd33d6deaa901b3c96185d9cb1f320ef",
      metadata: {
        name: "Littlejohn",
        description: "Local Robinhood Chain wallet connection",
        url: "http://127.0.0.1:46630",
        icons: [],
      },
    });
    const rpc = createRpcSourceAuthority({ credential, endpoint: configuration.rpc, clock });
    expect(rpc.configurationDigest).toBe("oA40Nw__Im-Kx0Tp9zCwwDLic15a7IjDaVCesNOhEuA");
    expect(rpc.sourceOwner).toBe("Robinhood");
    expect(rpc.publicOrigin).toBe("https://rpc.mainnet.chain.robinhood.com");

    const secretConfiguration = readRuntimeConfiguration({
      LITTLEJOHN_RPC_URL: "https://user:password@rpc.example/private?key=secret",
    });
    const secretSafe = createRpcSourceAuthority({ credential, endpoint: secretConfiguration.rpc, clock });
    expect(secretSafe.publicOrigin).toBe("https://rpc.example");
    expect(JSON.stringify(secretSafe)).not.toContain("password");
    expect(JSON.stringify(secretSafe)).not.toContain("private");
    expect(JSON.stringify(secretSafe)).not.toContain("secret");

    const slashConfiguration = readRuntimeConfiguration({ LITTLEJOHN_RPC_URL: "https://rpc.mainnet.chain.robinhood.com/" });
    const slash = createRpcSourceAuthority({ credential, endpoint: slashConfiguration.rpc, clock });
    expect(slash.configurationDigest).toBe("5VnFZF1HaHhd_PK5drKjmVZbZ21ca8n_QrhkoS3pR-o");
    expect(slash.sourceOwner).toBe("Robinhood");
    expect(readConfiguredRpcEndpoint(slashConfiguration.rpc).exactUri).toBe("https://rpc.mainnet.chain.robinhood.com/");

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
    expect(() => readRuntimeConfiguration({ LITTLEJOHN_RPC_URL: "https://rpc.example/\uD800" })).toThrow("invalid Unicode");

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
