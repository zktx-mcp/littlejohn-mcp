import { fork, type ChildProcess } from "node:child_process";
import { createHmac, hkdfSync } from "node:crypto";
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
  parseEvmChainId,
  parseCapabilityDataAt,
  parseUtcTimestamp,
  productDisplayName,
  walletConnectionCapability,
} from "../../src/core/index.js";
import {
  createControlCredentialVerifier,
  deriveRuntimeConfigurationMac,
  loadOrCreateControlCredential,
  validateControlCredential,
} from "../../src/runtime/control-credential.js";
import {
  decodeWalletAccountRecordKey,
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
import {
  canonicalSelectionRevisionSqlCheck,
  canonicalRuntimeConfigurationMacSqlCheck,
  canonicalRuntimeIdentifierSqlCheck,
  canonicalSqlTextCheck,
  databaseSchemaVersion,
} from "../../src/runtime/sqlite-schema.js";

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

const launchSqliteCrashWorker = async (
  directory: string,
  mode: "committed" | "interrupted" | "catalog-interrupted" = "committed",
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
    expect(runtimeProtocolVersion).toBe(7);
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
      protocolVersion: runtimeProtocolVersion,
      ownerRevision: "1",
    });
    database.close();
  });

  it("keeps the database schema independent from a stale owner protocol projection", async () => {
    const directory = await temporaryDirectory();
    await ensureOwnerOnlyDirectory(directory);
    const path = runtimePaths(directory).database;
    const initial = await ProductDatabase.open(path, observedAt);
    initial.ownerStore().publishOwner(createOwnerInstanceId(), configurationMac, observedAt);
    initial.close();

    const stale = new Database(path);
    expect(() => stale.prepare("UPDATE runtime_owner SET protocol_version = 0 WHERE singleton = 1").run())
      .toThrow();
    expect(() => stale.prepare("UPDATE runtime_owner SET protocol_version = ? WHERE singleton = 1")
      .run(Number.MAX_SAFE_INTEGER + 1)).toThrow();
    stale.prepare("UPDATE runtime_owner SET protocol_version = ? WHERE singleton = 1")
      .run(runtimeProtocolVersion - 1);
    expect(stale.pragma("user_version", { simple: true })).toBe(databaseSchemaVersion);
    stale.close();

    const reopened = await ProductDatabase.open(path, observedAt);
    expect(reopened.ownerStore().readOwner()?.protocolVersion).toBe(runtimeProtocolVersion - 1);
    const current = reopened.ownerStore().publishOwner(
      createOwnerInstanceId(),
      configurationMac,
      observedAt,
    );
    expect(current.protocolVersion).toBe(runtimeProtocolVersion);
    expect(current.ownerRevision).toBe("2");
    reopened.close();
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
        updatedAt: observedAt,
      });
      database.close();
    }
    const inspection = new Database(path, { readonly: true });
    expect(inspection.pragma("user_version", { simple: true })).toBe(databaseSchemaVersion);
    expect(inspection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all())
      .toEqual([
        { name: "chain" },
        { name: "contract" },
        { name: "current_wallet_connection" },
        { name: "local_profile" },
        { name: "robinhood_asset" },
        { name: "robinhood_asset_snapshot" },
        { name: "runtime_owner" },
        { name: "token_contract" },
        { name: "token_contract_inspection" },
        { name: "wallet_account" },
        { name: "wallet_token_selection" },
        { name: "wallet_token_selection_state" },
      ]);
    inspection.close();
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
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
      { name: "chain", wr: 1, strict: 1 },
      { name: "contract", wr: 1, strict: 1 },
      { name: "current_wallet_connection", wr: 0, strict: 1 },
      { name: "local_profile", wr: 0, strict: 1 },
      { name: "robinhood_asset", wr: 1, strict: 1 },
      { name: "robinhood_asset_snapshot", wr: 1, strict: 1 },
      { name: "runtime_owner", wr: 0, strict: 1 },
      { name: "token_contract", wr: 1, strict: 1 },
      { name: "token_contract_inspection", wr: 1, strict: 1 },
      { name: "wallet_account", wr: 1, strict: 1 },
      { name: "wallet_token_selection", wr: 1, strict: 1 },
      { name: "wallet_token_selection_state", wr: 1, strict: 1 },
    ]);
    for (const table of [
      "runtime_owner",
      "robinhood_asset_snapshot",
      "contract",
      "token_contract",
      "token_contract_inspection",
      "wallet_account",
      "wallet_token_selection_state",
      "wallet_token_selection",
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
      configuration_mac, protocol_version, process_id, owner_revision, acquired_at)
      VALUES (1, ?, ?, ?, ${runtimeProtocolVersion}, 1, '0', ?)`)
      .run(profileId, `${createOwnerInstanceId()}\0suffix`, configurationMac, observedAt)).toThrow();
    expect(() => raw.prepare(`INSERT INTO runtime_owner(singleton, profile_id, owner_instance_id,
      configuration_mac, protocol_version, process_id, owner_revision, acquired_at)
      VALUES (1, ?, ?, ?, ${runtimeProtocolVersion}, 1, '0', ?)`)
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
      session_count = '1', chain_id = NULL, wallet_address = NULL, approved_methods_json = NULL,
      approved_events_json = NULL, expires_at = NULL WHERE singleton = 1`).run()).toThrow();
    expect(() => raw.prepare(`INSERT INTO wallet_account(profile_id, chain_id, wallet_address)
      VALUES (?, ?, ?)`)
      .run(profileId, configuredChainId, "0x1111111111111111111111111111111111111111\0suffix")).toThrow();
    expect(() => raw.prepare("INSERT INTO contract(chain_id, contract_address) VALUES (?, ?)")
      .run("eip155:10", "0x1111111111111111111111111111111111111111")).toThrow();
    expect(raw.prepare("SELECT COUNT(*) AS count FROM wallet_account").get()).toEqual({ count: 0 });
    raw.close();
  });

  it("opens only the exact current schema and never repairs incompatible state", async () => {
    for (const mutation of [
      (database: Database.Database) => { database.pragma("user_version = 0"); },
      (database: Database.Database) => { database.exec("CREATE TABLE obsolete_state(value TEXT)"); },
    ]) {
      const directory = await temporaryDirectory();
      await ensureOwnerOnlyDirectory(directory);
      const path = runtimePaths(directory).database;
      const initialized = await ProductDatabase.open(path, observedAt);
      initialized.close();

      const incompatible = new Database(path);
      mutation(incompatible);
      incompatible.close();
      if (process.platform !== "win32") await chmod(path, 0o600);
      const before = await sqliteDurableArtifactSnapshot(path);

      await expectRuntimeCode(ProductDatabase.open(path, observedAt), "runtime_state_unavailable");
      expect(await sqliteDurableArtifactSnapshot(path)).toEqual(before);
    }
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
      database.walletStore().replace("0", connected(), observedAt);
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

  it("uses stored update time for wallet meaning, canonicalizes arrays, and enforces CAS", async () => {
    const directory = await temporaryDirectory();
    await ensureOwnerOnlyDirectory(directory);
    const path = runtimePaths(directory).database;
    const database = await ProductDatabase.open(path, observedAt);
    database.configuredChainStore().insertConfiguredChainIfAbsent(configuredChainId);
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
    const accountRows = new Database(path, { readonly: true });
    expect(accountRows.prepare(`SELECT profile_id AS profileId, chain_id AS chainId,
      wallet_address AS walletAddress FROM wallet_account`).all()).toHaveLength(1);
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

  it("preserves chain-scoped wallet accounts across disconnect, address switch, and chain switch", async () => {
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

    wallet.replace("0", connectedFor(configuredChainId, addressA), observedAt);
    wallet.replace("1", { status: "disconnected", reason: "disconnected" }, observedAt);
    wallet.replace("2", connectedFor(configuredChainId, addressB), observedAt);
    wallet.replace("3", { status: "disconnected", reason: "no_session" }, observedAt);
    wallet.replace("4", connectedFor("eip155:1", addressA), observedAt);
    wallet.replace("5", { status: "disconnected", reason: "deleted" }, observedAt);
    wallet.replace("6", connectedFor(configuredChainId, addressA), observedAt);

    const raw = new Database(path, { readonly: true });
    const rows = raw.prepare(`SELECT profile_id AS profileId, chain_id AS chainId,
      wallet_address AS walletAddress FROM wallet_account
      ORDER BY chain_id, wallet_address`).all() as {
      profileId: string;
      chainId: string;
      walletAddress: string;
    }[];
    expect(rows.map(decodeWalletAccountRecordKey)).toEqual([
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

  it("rolls back account creation when the connection revision or chain parent is invalid", async () => {
    const directory = await temporaryDirectory();
    await ensureOwnerOnlyDirectory(directory);
    const path = runtimePaths(directory).database;
    const database = await ProductDatabase.open(path, observedAt);
    database.configuredChainStore().insertConfiguredChainIfAbsent(configuredChainId);
    const wallet = database.walletStore();
    const addressA = "0x1111111111111111111111111111111111111111";
    const addressB = "0x2222222222222222222222222222222222222222";
    wallet.replace("0", connectedFor(configuredChainId, addressA), observedAt);
    await expectRuntimeCode(
      Promise.resolve().then(() => wallet.replace("0", connectedFor(configuredChainId, addressB), observedAt)),
      "state_conflict",
    );
    await expectRuntimeCode(
      Promise.resolve().then(() => wallet.replace("1", connectedFor("eip155:10", addressB), observedAt)),
      "runtime_state_unavailable",
    );
    expect(wallet.read()).toMatchObject({
      revision: "1",
      connection: { status: "connected", chainId: configuredChainId, address: addressA },
    });
    const raw = new Database(path, { readonly: true });
    expect(raw.prepare("SELECT chain_id AS chainId, wallet_address AS walletAddress FROM wallet_account").all())
      .toEqual([{ chainId: configuredChainId, walletAddress: addressA }]);
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
        observedAt,
      )),
      Promise.resolve().then(() => wallet.replace(
        "0",
        connectedFor(configuredChainId, addressB),
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
    const accounts = raw.prepare(`SELECT chain_id AS chainId, wallet_address AS walletAddress
      FROM wallet_account ORDER BY chain_id, wallet_address`).all();
    expect(accounts).toEqual([{
      chainId: configuredChainId,
      walletAddress: current.connection.status === "connected" ? current.connection.address : "unreachable",
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
        observedAt,
      )),
      "runtime_state_unavailable",
    );
    expect(database.walletStore().read()).toMatchObject({
      revision: "0",
      connection: { status: "unknown", reason: "reconciling" },
    });
    const inspection = new Database(path, { readonly: true });
    expect(inspection.prepare("SELECT COUNT(*) AS count FROM wallet_account").get())
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
    expect(inspection.prepare("SELECT COUNT(*) AS count FROM wallet_account").get())
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
      "wallet_token_selection_state",
      "wallet_token_selection",
    ]) {
      expect(inspection.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(), table)
        .toEqual({ count: 0 });
    }
    expect(inspection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(inspection.pragma("integrity_check", { simple: true })).toBe("ok");
    inspection.close();
    reopened.close();
  });

  it("never initializes over an existing SQLite artifact set", async () => {
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
      const beforeMainInode = await lstat(path).then(
        (details) => details.ino,
        (error: unknown) => {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
          throw error;
        },
      );
      await expectRuntimeCode(ProductDatabase.open(path, observedAt), "runtime_state_unavailable");
      const afterMainInode = await lstat(path).then(
        (details) => details.ino,
        (error: unknown) => {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
          throw error;
        },
      );
      expect(afterMainInode, testCase.name).toBe(beforeMainInode);
      expect((await readdir(directory)).every((name) => [
        "littlejohn.sqlite3",
        "littlejohn.sqlite3-wal",
        "littlejohn.sqlite3-shm",
      ].includes(name)), testCase.name).toBe(true);
    }
  });

  it("validates an active WAL snapshot without creating a second product-state artifact", async () => {
    const directory = await temporaryDirectory();
    await ensureOwnerOnlyDirectory(directory);
    const path = runtimePaths(directory).database;
    const first = await ProductDatabase.open(path, observedAt);
    first.configuredChainStore().insertConfiguredChainIfAbsent(configuredChainId);
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

  it("rejects main-file replacement across current-state opening", async () => {
    for (const replaceOnAssertion of [1, 4]) {
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
      chain: { chainId: "eip155:4663" },
      requiredMethods: ["eth_sendTransaction"],
      requiredEvents: ["accountsChanged", "chainChanged"],
      metadata: {
        name: productDisplayName,
        description: "Local Robinhood Chain wallet connection",
        url: "http://127.0.0.1:46630",
        icons: [],
      },
    });
    const configurationFields = [
      Buffer.from(configuration.chain.chainId, "utf8"),
      Buffer.from(readConfiguredRpcEndpoint(configuration.rpc.endpoint).exactUri, "utf8"),
      Buffer.from(configuration.wallet.projectId, "utf8"),
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
      Buffer.from("littlejohn/runtime-configuration/v2", "utf8"),
      32,
    ))).update(payload).digest("base64url");
    expect(deriveRuntimeConfigurationMac(credential, configuration)).toBe(independentConfigurationMac);
    const forgedChain = Object.freeze({ chainId: configuration.chain.chainId });
    expect(() => deriveRuntimeConfigurationMac(credential, {
      chain: forgedChain,
      rpc: Object.freeze({ chain: forgedChain, endpoint: configuration.rpc.endpoint }),
      wallet: Object.freeze({ ...configuration.wallet, chain: forgedChain }),
    } as never)).toThrow("provenance");
    const rpc = createRpcSourceAuthority({ credential, endpoint: configuration.rpc.endpoint, clock });
    expect(rpc.configurationDigest).toBe("oA40Nw__Im-Kx0Tp9zCwwDLic15a7IjDaVCesNOhEuA");
    expect(rpc.sourceOwner).toBe("Robinhood");
    expect(rpc.publicOrigin).toBe("https://rpc.mainnet.chain.robinhood.com");

    const secretConfiguration = readRuntimeConfiguration({
      LITTLEJOHN_RPC_URL: "https://user:password@rpc.example/private?key=secret",
    });
    const secretSafe = createRpcSourceAuthority({ credential, endpoint: secretConfiguration.rpc.endpoint, clock });
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
