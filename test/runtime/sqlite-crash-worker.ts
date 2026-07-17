import {
  parseCapabilityDataAt,
  parseEvmChainId,
  parseUtcTimestamp,
  walletConnectionCapability,
} from "../../src/core/index.js";
import Database from "better-sqlite3";
import { ProductDatabase } from "../../src/runtime/database.js";
import { ensureOwnerOnlyDirectory, runtimePaths } from "../../src/runtime/paths.js";

const dataDirectory = process.argv[2];
if (dataDirectory === undefined) throw new TypeError("SQLite crash-worker data directory is required.");
const mode = process.argv[3];
if (mode !== "committed" && mode !== "interrupted") {
  throw new TypeError("SQLite crash-worker mode is invalid.");
}

const observedAt = parseUtcTimestamp("2026-07-12T10:16:02.000Z");
await ensureOwnerOnlyDirectory(dataDirectory);
const databasePath = runtimePaths(dataDirectory).database;
if (mode === "interrupted") {
  const database = new Database(databasePath);
  database.pragma("foreign_keys = ON");
  database.exec("BEGIN EXCLUSIVE");
  database.prepare(`INSERT INTO wallet_account(profile_id, chain_id, wallet_address)
    SELECT profile_id, ?, ? FROM local_profile WHERE singleton = 1`).run(
    "eip155:4663",
    "0x1111111111111111111111111111111111111111",
  );
  process.send?.({ ready: true });
  setInterval(() => undefined, 60_000);
} else {
  const database = await ProductDatabase.open(databasePath, observedAt);
  database.configuredChainStore().insertConfiguredChainIfAbsent(parseEvmChainId("eip155:4663"));
  database.walletStore().replace("0", parseCapabilityDataAt(walletConnectionCapability, {
    status: "connected",
    address: "0x1111111111111111111111111111111111111111",
    chainId: "eip155:4663",
    approvedMethods: ["eth_sendTransaction", "personal_sign"],
    approvedEvents: ["accountsChanged", "chainChanged"],
    expiresAt: "2026-07-18T17:39:16.000Z",
  }, observedAt), observedAt);

  process.send?.({ ready: true });
  setInterval(() => undefined, 60_000);
}
