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
if (
  mode !== "committed" && mode !== "interrupted" &&
  mode !== "catalog-interrupted" && mode !== "structural-mismatch"
) {
  throw new TypeError("SQLite crash-worker mode is invalid.");
}

const observedAt = parseUtcTimestamp("2026-07-12T10:16:02.000Z");
await ensureOwnerOnlyDirectory(dataDirectory);
const databasePath = runtimePaths(dataDirectory).database;
if (mode === "structural-mismatch") {
  const database = new Database(databasePath);
  database.pragma("journal_mode = WAL");
  database.pragma("wal_autocheckpoint = 0");
  database.exec("CREATE TABLE crash_only_state(value TEXT)");
  process.send?.({ ready: true });
  setInterval(() => undefined, 60_000);
} else if (mode === "interrupted" || mode === "catalog-interrupted") {
  const database = new Database(databasePath);
  database.pragma("foreign_keys = ON");
  database.exec("BEGIN EXCLUSIVE");
  if (mode === "interrupted") {
    database.prepare(`INSERT INTO account(profile_id, chain_id, account_address)
      SELECT profile_id, ?, ? FROM local_profile WHERE singleton = 1`).run(
      "eip155:4663",
      "0x1111111111111111111111111111111111111111",
    );
  } else {
    const chainId = "eip155:4663";
    const walletAddress = "0x1111111111111111111111111111111111111111";
    const tokenAddress = "0x2222222222222222222222222222222222222222";
    const inspectionDigest = `0x${"33".repeat(32)}`;
    database.prepare("INSERT INTO contract(chain_id, contract_address) VALUES (?, ?)")
      .run(chainId, tokenAddress);
    database.prepare("INSERT INTO token_contract(chain_id, contract_address) VALUES (?, ?)")
      .run(chainId, tokenAddress);
    database.prepare(`INSERT INTO token_contract_inspection(
      chain_id, contract_address, inspection_digest, result_bytes
    ) VALUES (?, ?, ?, ?)`)
      .run(chainId, tokenAddress, inspectionDigest, Buffer.from("{}", "utf8"));
    database.prepare(`INSERT INTO account_token_selection_state(
      profile_id, chain_id, account_address, revision, defaults_initialized, created_at, updated_at
    ) SELECT profile_id, ?, ?, ?, 0, ?, ?
      FROM local_profile WHERE singleton = 1`).run(
        chainId,
        walletAddress,
        Buffer.alloc(16, 3).toString("base64url"),
        observedAt,
        observedAt,
      );
    database.prepare(`INSERT INTO account_token_selection(
      profile_id, chain_id, account_address, token_address, included, revision, created_at, updated_at
    ) SELECT profile_id, ?, ?, ?, 1, ?, ?, ?
      FROM local_profile WHERE singleton = 1`).run(
        chainId,
        walletAddress,
        tokenAddress,
        Buffer.alloc(16, 4).toString("base64url"),
        observedAt,
        observedAt,
      );
  }
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
  }, observedAt), false, observedAt);

  process.send?.({ ready: true });
  setInterval(() => undefined, 60_000);
}
