import { parseCapabilityDataAt, parseUtcTimestamp, walletConnectionCapability } from "../../src/core/index.js";
import { ProductDatabase } from "../../src/runtime/database.js";
import { ensureOwnerOnlyDirectory, runtimePaths } from "../../src/runtime/paths.js";

const dataDirectory = process.argv[2];
if (dataDirectory === undefined) throw new TypeError("SQLite crash-worker data directory is required.");

const observedAt = parseUtcTimestamp("2026-07-12T10:16:02.000Z");
await ensureOwnerOnlyDirectory(dataDirectory);
const database = await ProductDatabase.open(runtimePaths(dataDirectory).database, observedAt);
database.walletStore().replace("0", parseCapabilityDataAt(walletConnectionCapability, {
  status: "connected",
  account: "eip155:4663:0x1111111111111111111111111111111111111111",
  address: "0x1111111111111111111111111111111111111111",
  chainId: "eip155:4663",
  approvedMethods: ["eth_sendTransaction", "personal_sign"],
  approvedEvents: ["accountsChanged", "chainChanged"],
  expiresAt: "2026-07-18T17:39:16.000Z",
}, observedAt), observedAt);

process.send?.({ ready: true });
setInterval(() => undefined, 60_000);
