import {walletSelectAccountInputSchema} from "../../src/wallet/account-selection-contract.js";
import {mkdtemp, rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import Database from "better-sqlite3";
import {afterEach, describe, expect, it} from "vitest";
import {parseUtcTimestamp} from "../../src/core/index.js";
import {parseEvmAccountIdentity, parseEvmChainId} from "../../src/evm/identities.js";
import {ProductDatabase} from "../../src/runtime/database.js";
import {walletConnectionDataSchema} from "../../src/wallet/connection-contract.js";
import {walletLocalRevisionSchema, nextWalletLocalRevision, parseWalletLocalRevision} from "../../src/wallet/local-revision.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const now = parseUtcTimestamp("2026-09-11T00:00:00.000Z");
const chainId = parseEvmChainId("eip155:4663");
const account = (digit: string) => parseEvmAccountIdentity({chainId, address: "0x" + digit.repeat(40)});
const a = account("1"), b = account("2");
const connectionId = "wallet-session:" + Buffer.alloc(32, 1).toString("base64url");
const connected = (accounts = [a, b], source = connectionId) => walletConnectionDataSchema.parse({status: "connected", connectionId: source,
  expiresAt: "2026-09-12T00:00:00.000Z", namespaces: [{key: "eip155", accounts: accounts.map(value => `${chainId}:${value.address}`), methods: [], events: []}]});
const setup = async () => {
  const directory = await mkdtemp(join(tmpdir(), "littlejohn-account-selection-"));
  const path = join(directory, "product.sqlite3"); const database = await ProductDatabase.open(path, now);
  cleanup.push(async () => {database.close(); await rm(directory, {recursive: true, force: true});});
  database.configuredChainStore().insertConfiguredChainIfAbsent(chainId);
  return {database, path, store: database.walletStore()};
};

describe("Wallet account preference persistence", () => {
  it("admits exact signed-64-bit decimal counters and rejects overflow", () => {
    expect(parseWalletLocalRevision("0")).toBe("0");
    expect(walletLocalRevisionSchema.safeParse("not_decimal")).toMatchObject({success: false});
    expect(walletLocalRevisionSchema.safeParse("9223372036854775807")).toMatchObject({success: true, data: "9223372036854775807"});
    expect(walletLocalRevisionSchema.safeParse("9223372036854775808")).toMatchObject({success: false});
    expect(nextWalletLocalRevision("9223372036854775806")).toBe("9223372036854775807");
    for (const value of ["-1", "01", "1.0", "1\0suffix", "9223372036854775808", 1, "9".repeat(20)]) expect(() => parseWalletLocalRevision(value)).toThrow();
    expect(() => nextWalletLocalRevision("9223372036854775807")).toThrow();
  });

  it("retains every supported member without requiring a transaction method and keeps choice changes local", async () => {
    const test = await setup(); const retained = account("3");
    test.store.replace("0", connected([a, b, retained]), null, null, now, [], [connectionId]); test.store.replace("1", connected(), null, null, now, [], [connectionId]);
    const raw = new Database(test.path);
    try {
      expect(raw.prepare("SELECT account_address AS address FROM account ORDER BY account_address").all()).toEqual([{address: a.address}, {address: b.address}, {address: retained.address}]);
      expect(test.store.readPreference(chainId)).toMatchObject({account: null, selectionRevision: "0"});
      const input = {connectionId, chainId, account: b, expectedConnectionRevision: "2", expectedSelectionRevision: "0"};
      expect(test.store.selectAccount(walletSelectAccountInputSchema.parse(input))).toEqual({connectionId, connectionRevision: "2", chainId, account: b, selectionRevision: "1"});
      expect(test.store.read().revision).toBe("2");
      expect(test.store.selectAccount(walletSelectAccountInputSchema.parse({...input, expectedSelectionRevision: "1"})).selectionRevision).toBe("1");
      expect(() => test.store.selectAccount(walletSelectAccountInputSchema.parse({...input, account: a}))).toThrow();
      expect(() => test.store.selectAccount(walletSelectAccountInputSchema.parse({...input, account: retained, expectedSelectionRevision: "1"}))).toThrow();
      expect(test.store.readPreference(chainId)).toMatchObject({account: b, selectionRevision: "1"});
    } finally {raw.close();}
  });

  it("preserves preference through unknown observations and invalidates it only on confirmed loss", async () => {
    const test = await setup(); test.store.replace("0", connected(), null, null, now, [], [connectionId]);
    test.store.selectAccount(walletSelectAccountInputSchema.parse({connectionId, chainId, account: b, expectedConnectionRevision: "1", expectedSelectionRevision: "0"}));
    test.store.replace("1", {status: "unknown", reason: "observation_unavailable"}, null, null, now, [], null);
    expect(test.store.readPreference(chainId)).toMatchObject({account: b, selectionRevision: "1"});
    test.store.replace("2", connected(), null, null, now, [], [connectionId]);
    expect(test.store.readPreference(chainId)).toMatchObject({account: b, selectionRevision: "1"});
    test.store.replace("3", connected([a]), null, null, now, [], [connectionId]);
    expect(test.store.readPreference(chainId)).toMatchObject({account: null, selectionRevision: "2"});
    const raw = new Database(test.path, {readonly: true});
    try {expect(raw.prepare("SELECT count(*) AS count FROM account").get()).toEqual({count: 2});}
    finally {raw.close();}
  });

  it("rolls back the entire selection or observation when either local counter would overflow", async () => {
    const test = await setup(); test.store.replace("0", connected(), null, null, now, [], [connectionId]);
    test.store.selectAccount(walletSelectAccountInputSchema.parse({connectionId, chainId, account: a, expectedConnectionRevision: "1", expectedSelectionRevision: "0"}));
    const raw = new Database(test.path);
    try {
      raw.prepare("UPDATE wallet_account_preference SET selection_revision = ?").run(9223372036854775806n);
      const input = {connectionId, chainId, account: b, expectedConnectionRevision: "1", expectedSelectionRevision: "9223372036854775806"};
      expect(test.store.selectAccount(walletSelectAccountInputSchema.parse(input)).selectionRevision).toBe("9223372036854775807");
      const before = test.store.readPreference(chainId);
      expect(() => test.store.selectAccount(walletSelectAccountInputSchema.parse({...input, account: a, expectedSelectionRevision: "9223372036854775807"}))).toThrow();
      expect(test.store.readPreference(chainId)).toEqual(before);
      expect(() => test.store.replace("1", {status: "disconnected", reason: "disconnected"}, null, null, now, [], [])).toThrow();
      expect(test.store.read().revision).toBe("1"); expect(test.store.readPreference(chainId)).toEqual(before);
      raw.prepare("UPDATE current_wallet_connection SET revision = ?").run(9223372036854775807n);
      expect(() => test.store.replace("9223372036854775807", connected(), null, null, now, [], [connectionId])).toThrow();
      expect(test.store.read().revision).toBe("9223372036854775807");
      expect(test.store.readPreference(chainId)).toEqual(before);
    } finally {raw.close();}
  });
});
