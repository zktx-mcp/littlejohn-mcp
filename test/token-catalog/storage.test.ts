import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  canonicalJsonStringify,
  parseCapabilityDataAt,
  evmAccountIdentitySchema,
  parseEvmAddressInput,
  parseEvmChainId,
  parseUtcTimestamp,
  walletConnectionCapability,
  type CanonicalJson,
} from "../../src/core/index.js";
import { ProductDatabase } from "../../src/runtime/database.js";
import { getRuntimeOperationFailure } from "../../src/runtime/errors.js";
import { ensureOwnerOnlyDirectory, runtimePaths } from "../../src/runtime/paths.js";
import { createOwnerInstanceId } from "../../src/runtime/runtime-identity.js";
import { getTokenCatalogOperationFailure } from "../../src/token-catalog/operation-error.js";
import {
  tokenInspectionDigest,
  tokenRegistrationRevisionSchema,
} from "../../src/token-catalog/contracts.js";
import { createInspectionSuccess, chainId, tokenAddress, walletAddress } from "./harness.js";

const directories: string[] = [];
const now = parseUtcTimestamp("2026-07-18T00:00:03.000Z");
const later = parseUtcTimestamp("2026-07-18T00:00:04.000Z");
const configurationMac = Buffer.alloc(32, 3).toString("base64url");
const revision = (byte: number) => tokenRegistrationRevisionSchema.parse(
  Buffer.alloc(16, byte).toString("base64url"),
);
const accountFor = (targetChain: string, address: string) =>
  evmAccountIdentitySchema.parse({ chainId: targetChain, address });

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const openDatabase = async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "littlejohn-token-storage-"));
  directories.push(directory);
  await ensureOwnerOnlyDirectory(directory);
  const path = runtimePaths(directory).database;
  return { path, database: await ProductDatabase.open(path, now) };
};

const connected = (targetChain: string, address: string) => parseCapabilityDataAt(walletConnectionCapability, {
  status: "connected",
  chainId: targetChain,
  address,
  approvedMethods: ["eth_sendTransaction"],
  approvedEvents: ["accountsChanged", "chainChanged"],
  expiresAt: "2026-07-19T00:00:00.000Z",
}, now);

const expectCatalogCode = (operation: () => unknown, code: string): void => {
  let failure: unknown;
  try { operation(); }
  catch (error) { failure = error; }
  expect(getTokenCatalogOperationFailure(failure)?.error.code).toBe(code);
};

describe("token catalog persistence", () => {
  it("creates, updates, lists, and removes one registration atomically", async () => {
    const { path, database } = await openDatabase();
    const configuredChain = parseEvmChainId(chainId);
    database.configuredChainStore().insertConfiguredChainIfAbsent(configuredChain);
    const connection = database.walletStore().replace("0", connected(chainId, walletAddress), now);
    const account = accountFor(chainId, walletAddress);
    const inspection = await createInspectionSuccess();
    const store = database.tokenCatalogStore();

    const created = store.register({
      account,
      expectedConnectionRevision: connection.revision,
      inspection,
      settings: { userLabel: "Savings", visibility: "visible" },
      revision: revision(1),
      now,
    });
    expect(store.getRegistration(account, inspection.data.asset)).toEqual(created);
    expect(store.listRegistrations({ account, limit: 25, cursor: null })).toEqual({
      registrations: [created.registration],
      nextCursor: null,
    });
    const restrictedParents = new Database(path);
    restrictedParents.pragma("foreign_keys = ON");
    expect(() => restrictedParents.prepare(`DELETE FROM token_contract
      WHERE chain_id = ? AND contract_address = ?`).run(chainId, tokenAddress)).toThrow();
    expect(() => restrictedParents.prepare(`DELETE FROM contract
      WHERE chain_id = ? AND contract_address = ?`).run(chainId, tokenAddress)).toThrow();
    restrictedParents.close();
    expectCatalogCode(() => store.register({
      account,
      expectedConnectionRevision: connection.revision,
      inspection,
      settings: { userLabel: null, visibility: "visible" },
      revision: revision(2),
      now,
    }), "state_conflict");

    const updated = store.update({
      account,
      asset: inspection.data.asset,
      expectedConnectionRevision: connection.revision,
      expectedRegistrationRevision: created.registration.revision,
      settings: { userLabel: null, visibility: "hidden" },
      revision: revision(2),
      now: later,
    });
    expect(updated.registration).toMatchObject({
      revision: revision(2),
      userLabel: null,
      visibility: "hidden",
      createdAt: now,
      updatedAt: later,
    });
    expectCatalogCode(() => store.update({
      account,
      asset: inspection.data.asset,
      expectedConnectionRevision: connection.revision,
      expectedRegistrationRevision: created.registration.revision,
      settings: { userLabel: "stale", visibility: "visible" },
      revision: revision(3),
      now: later,
    }), "token_registration_revision_changed");

    expect(store.unregister({
      account,
      asset: inspection.data.asset,
      expectedConnectionRevision: connection.revision,
      expectedRegistrationRevision: updated.registration.revision,
    })).toEqual({ asset: inspection.data.asset, removedRevision: revision(2) });
    expect(store.getRegistration(account, inspection.data.asset)).toBeUndefined();
    expectCatalogCode(() => store.update({
      account,
      asset: inspection.data.asset,
      expectedConnectionRevision: connection.revision,
      expectedRegistrationRevision: revision(2),
      settings: { userLabel: "Removed", visibility: "hidden" },
      revision: revision(3),
      now: later,
    }), "token_registration_revision_changed");

    const recreated = store.register({
      account,
      expectedConnectionRevision: connection.revision,
      inspection,
      settings: { userLabel: "Recreated", visibility: "visible" },
      revision: revision(3),
      now: later,
    });
    expect(recreated.registration.revision).toBe(revision(3));
    expectCatalogCode(() => store.update({
      account,
      asset: inspection.data.asset,
      expectedConnectionRevision: connection.revision,
      expectedRegistrationRevision: revision(2),
      settings: { userLabel: "Stale lifetime", visibility: "hidden" },
      revision: revision(4),
      now: later,
    }), "token_registration_revision_changed");
    expect(store.unregister({
      account,
      asset: inspection.data.asset,
      expectedConnectionRevision: connection.revision,
      expectedRegistrationRevision: recreated.registration.revision,
    })).toEqual({ asset: inspection.data.asset, removedRevision: revision(3) });
    expectCatalogCode(() => store.unregister({
      account,
      asset: inspection.data.asset,
      expectedConnectionRevision: connection.revision,
      expectedRegistrationRevision: revision(3),
    }), "token_registration_revision_changed");

    const raw = new Database(path, { readonly: true });
    expect(raw.prepare("SELECT COUNT(*) AS count FROM wallet_token_registration").get()).toEqual({ count: 0 });
    expect(raw.prepare("SELECT COUNT(*) AS count FROM token_contract_inspection").get()).toEqual({ count: 0 });
    expect(raw.prepare("SELECT COUNT(*) AS count FROM token_contract").get()).toEqual({ count: 1 });
    expect(raw.prepare("SELECT COUNT(*) AS count FROM contract").get()).toEqual({ count: 1 });
    expect(raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    raw.close();
    database.close();
  });

  it("paginates one account in canonical token-address order without crossing its scope", async () => {
    const { database } = await openDatabase();
    database.configuredChainStore().insertConfiguredChainIfAbsent(chainId);
    const connection = database.walletStore().replace("0", connected(chainId, walletAddress), now);
    const account = accountFor(chainId, walletAddress);
    const addresses = ["10", "20", "30"].map((byte) =>
      parseEvmAddressInput(`0x${byte.repeat(20)}`));
    const store = database.tokenCatalogStore();
    for (const [index, address] of addresses.entries()) {
      store.register({
        account,
        expectedConnectionRevision: connection.revision,
        inspection: await createInspectionSuccess({
          asset: { kind: "erc20", chainId, address },
          block: { kind: "latest" },
        }),
        settings: { userLabel: null, visibility: "visible" },
        revision: revision(index + 1),
        now,
      });
    }

    const first = store.listRegistrations({ account, limit: 2, cursor: null });
    expect(first.registrations.map((entry) => entry.asset.address)).toEqual(addresses.slice(0, 2));
    expect(first.nextCursor).toBe(addresses[1]);
    const second = store.listRegistrations({ account, limit: 2, cursor: first.nextCursor });
    expect(second.registrations.map((entry) => entry.asset.address)).toEqual(addresses.slice(2));
    expect(second.nextCursor).toBeNull();
    database.close();
  });

  it("lists registration records without loading inspection result JSON", async () => {
    const { path, database } = await openDatabase();
    database.configuredChainStore().insertConfiguredChainIfAbsent(chainId);
    const connection = database.walletStore().replace("0", connected(chainId, walletAddress), now);
    const account = accountFor(chainId, walletAddress);
    const inspection = await createInspectionSuccess();
    const store = database.tokenCatalogStore();
    const created = store.register({
      account,
      expectedConnectionRevision: connection.revision,
      inspection,
      settings: { userLabel: "Escaped \\\\ label", visibility: "visible" },
      revision: revision(1),
      now,
    });

    const raw = new Database(path);
    raw.prepare("UPDATE token_contract_inspection SET result_json = ?")
      .run('{"validJsonObject":"but not a token inspection"}');
    raw.close();

    const page = store.listRegistrations({ account, limit: 25, cursor: null });
    expect(page).toEqual({ registrations: [created.registration], nextCursor: null });
    expect("inspection" in page.registrations[0]!).toBe(false);
    expectCatalogCode(
      () => store.getRegistration(account, inspection.data.asset),
      "runtime_state_unavailable",
    );
    database.close();
  });

  it("isolates registration membership by chain and wallet account and rejects stale connection authority", async () => {
    const { database } = await openDatabase();
    const alternateChain = parseEvmChainId("eip155:1");
    const secondWallet = parseEvmAddressInput(`0x${"56".repeat(20)}`);
    database.configuredChainStore().insertConfiguredChainIfAbsent(parseEvmChainId(chainId));
    database.configuredChainStore().insertConfiguredChainIfAbsent(alternateChain);
    const store = database.tokenCatalogStore();

    const firstConnection = database.walletStore().replace("0", connected(chainId, walletAddress), now);
    const firstInspection = await createInspectionSuccess();
    const firstAccount = accountFor(chainId, walletAddress);
    store.register({
      account: firstAccount,
      expectedConnectionRevision: firstConnection.revision,
      inspection: firstInspection,
      settings: { userLabel: null, visibility: "visible" },
      revision: revision(1),
      now,
    });

    const secondConnection = database.walletStore().replace(
      firstConnection.revision,
      connected(chainId, secondWallet),
      later,
    );
    expect(store.listRegistrations({
      account: accountFor(chainId, secondWallet), limit: 25, cursor: null,
    }).registrations).toEqual([]);
    expectCatalogCode(() => store.register({
      account: firstAccount,
      expectedConnectionRevision: firstConnection.revision,
      inspection: firstInspection,
      settings: { userLabel: null, visibility: "visible" },
      revision: revision(2),
      now: later,
    }), "state_conflict");

    const alternateInspection = await createInspectionSuccess({
      asset: { kind: "erc20", chainId: alternateChain, address: tokenAddress },
      block: { kind: "latest" },
    });
    const alternateConnection = database.walletStore().replace(
      secondConnection.revision,
      connected(alternateChain, walletAddress),
      later,
    );
    store.register({
      account: accountFor(alternateChain, walletAddress),
      expectedConnectionRevision: alternateConnection.revision,
      inspection: alternateInspection,
      settings: { userLabel: "Other chain", visibility: "visible" },
      revision: revision(3),
      now: later,
    });
    expect(store.listRegistrations({
      account: firstAccount, limit: 25, cursor: null,
    }).registrations).toHaveLength(1);
    expect(store.listRegistrations({
      account: accountFor(alternateChain, walletAddress), limit: 25, cursor: null,
    }).registrations).toHaveLength(1);
    database.close();
  });

  it("preserves a registration across disconnect, reconnect, wallet deletion, and owner replacement", async () => {
    const { path, database } = await openDatabase();
    const profile = database.ownerStore().readProfile();
    const firstOwnerInstanceId = createOwnerInstanceId();
    const firstOwner = database.ownerStore().publishOwner(
      firstOwnerInstanceId,
      configurationMac,
      now,
    );
    expect(firstOwner).toMatchObject({
      profileId: profile.profileId,
      ownerInstanceId: firstOwnerInstanceId,
      ownerRevision: "1",
    });
    database.configuredChainStore().insertConfiguredChainIfAbsent(chainId);
    const account = accountFor(chainId, walletAddress);
    const inspection = await createInspectionSuccess();
    const wallet = database.walletStore();
    const store = database.tokenCatalogStore();

    const connectedRecord = wallet.replace("0", connected(chainId, walletAddress), now);
    const created = store.register({
      account,
      expectedConnectionRevision: connectedRecord.revision,
      inspection,
      settings: { userLabel: "Persistent", visibility: "visible" },
      revision: revision(1),
      now,
    });
    const disconnectedRecord = wallet.replace(
      connectedRecord.revision,
      { status: "disconnected", reason: "disconnected" },
      later,
    );
    expect(store.getRegistration(account, inspection.data.asset)).toEqual(created);
    const reconnectedRecord = wallet.replace(
      disconnectedRecord.revision,
      connected(chainId, walletAddress),
      later,
    );
    const deletedRecord = wallet.replace(
      reconnectedRecord.revision,
      { status: "disconnected", reason: "deleted" },
      later,
    );
    database.close();

    const reopened = await ProductDatabase.open(path, later);
    expect(reopened.ownerStore().readProfile()).toEqual(profile);
    expect(reopened.walletStore().read()).toEqual(deletedRecord);
    const secondOwnerInstanceId = createOwnerInstanceId();
    const secondOwner = reopened.ownerStore().publishOwner(
      secondOwnerInstanceId,
      configurationMac,
      later,
    );
    expect(secondOwnerInstanceId).not.toBe(firstOwnerInstanceId);
    expect(secondOwner).toMatchObject({
      profileId: profile.profileId,
      ownerInstanceId: secondOwnerInstanceId,
      ownerRevision: "2",
    });
    reopened.walletStore().replace(
      deletedRecord.revision,
      connected(chainId, walletAddress),
      later,
    );
    expect(reopened.tokenCatalogReadStore().getRegistration(account, inspection.data.asset)).toEqual(created);
    expect(reopened.tokenCatalogReadStore().listRegistrations({
      account,
      limit: 25,
      cursor: null,
    })).toEqual({ registrations: [created.registration], nextCursor: null });
    reopened.close();
  });

  it("rolls back every parent and inspection row when the registration write fails", async () => {
    const { path, database } = await openDatabase();
    database.configuredChainStore().insertConfiguredChainIfAbsent(chainId);
    const connection = database.walletStore().replace("0", connected(chainId, walletAddress), now);
    const inspection = await createInspectionSuccess();
    const raw = new Database(path);
    raw.exec(`CREATE TRIGGER reject_token_registration
      BEFORE INSERT ON wallet_token_registration
      BEGIN SELECT RAISE(ABORT, 'injected registration failure'); END`);

    expectCatalogCode(() => database.tokenCatalogStore().register({
      account: accountFor(chainId, walletAddress),
      expectedConnectionRevision: connection.revision,
      inspection,
      settings: { userLabel: null, visibility: "visible" },
      revision: revision(1),
      now,
    }), "runtime_state_unavailable");
    for (const table of ["contract", "token_contract", "token_contract_inspection", "wallet_token_registration"]) {
      expect(raw.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(), table).toEqual({ count: 0 });
    }
    raw.close();
    database.close();
  });

  it("rejects an inspection digest collision without changing persistent catalog state", async () => {
    const { path, database } = await openDatabase();
    database.configuredChainStore().insertConfiguredChainIfAbsent(chainId);
    const connection = database.walletStore().replace("0", connected(chainId, walletAddress), now);
    const account = accountFor(chainId, walletAddress);
    const inspection = await createInspectionSuccess();
    const digest = tokenInspectionDigest(inspection);
    const conflictingResultJson = `${canonicalJsonStringify(
      inspection as unknown as CanonicalJson,
    )}\n`;
    const raw = new Database(path);
    raw.pragma("foreign_keys = ON");
    raw.prepare("INSERT INTO contract(chain_id, contract_address) VALUES (?, ?)")
      .run(chainId, tokenAddress);
    raw.prepare("INSERT INTO token_contract(chain_id, contract_address) VALUES (?, ?)")
      .run(chainId, tokenAddress);
    raw.prepare(`INSERT INTO token_contract_inspection(
      chain_id, contract_address, inspection_digest, result_json
    ) VALUES (?, ?, ?, ?)`).run(chainId, tokenAddress, digest, conflictingResultJson);
    const before = {
      contracts: raw.prepare("SELECT COUNT(*) AS count FROM contract").get(),
      tokenContracts: raw.prepare("SELECT COUNT(*) AS count FROM token_contract").get(),
      inspections: raw.prepare("SELECT COUNT(*) AS count FROM token_contract_inspection").get(),
      registrations: raw.prepare("SELECT COUNT(*) AS count FROM wallet_token_registration").get(),
    };

    expectCatalogCode(() => database.tokenCatalogStore().register({
      account,
      expectedConnectionRevision: connection.revision,
      inspection,
      settings: { userLabel: null, visibility: "visible" },
      revision: revision(1),
      now,
    }), "runtime_state_unavailable");

    expect({
      contracts: raw.prepare("SELECT COUNT(*) AS count FROM contract").get(),
      tokenContracts: raw.prepare("SELECT COUNT(*) AS count FROM token_contract").get(),
      inspections: raw.prepare("SELECT COUNT(*) AS count FROM token_contract_inspection").get(),
      registrations: raw.prepare("SELECT COUNT(*) AS count FROM wallet_token_registration").get(),
    }).toEqual(before);
    expect(raw.prepare(`SELECT result_json AS resultJson FROM token_contract_inspection
      WHERE chain_id = ? AND contract_address = ? AND inspection_digest = ?`)
      .get(chainId, tokenAddress, digest)).toEqual({ resultJson: conflictingResultJson });
    raw.close();
    database.close();
  });

  it("keeps one account registration and its shared inspection when another account removes the same token", async () => {
    const { path, database } = await openDatabase();
    const secondWallet = parseEvmAddressInput(`0x${"56".repeat(20)}`);
    database.configuredChainStore().insertConfiguredChainIfAbsent(chainId);
    const inspection = await createInspectionSuccess();
    const store = database.tokenCatalogStore();

    const firstConnection = database.walletStore().replace("0", connected(chainId, walletAddress), now);
    const firstAccount = accountFor(chainId, walletAddress);
    store.register({
      account: firstAccount,
      expectedConnectionRevision: firstConnection.revision,
      inspection,
      settings: { userLabel: "First", visibility: "visible" },
      revision: revision(1),
      now,
    });
    const secondConnection = database.walletStore().replace(
      firstConnection.revision,
      connected(chainId, secondWallet),
      later,
    );
    const secondAccount = accountFor(chainId, secondWallet);
    const second = store.register({
      account: secondAccount,
      expectedConnectionRevision: secondConnection.revision,
      inspection,
      settings: { userLabel: "Second", visibility: "hidden" },
      revision: revision(2),
      now: later,
    });
    store.unregister({
      account: secondAccount,
      asset: inspection.data.asset,
      expectedConnectionRevision: secondConnection.revision,
      expectedRegistrationRevision: second.registration.revision,
    });

    expect(store.getRegistration(firstAccount, inspection.data.asset)?.registration.userLabel).toBe("First");
    expect(store.getRegistration(secondAccount, inspection.data.asset)).toBeUndefined();
    const raw = new Database(path, { readonly: true });
    expect(raw.prepare("SELECT COUNT(*) AS count FROM wallet_token_registration").get()).toEqual({ count: 1 });
    expect(raw.prepare("SELECT COUNT(*) AS count FROM token_contract_inspection").get()).toEqual({ count: 1 });
    expect(raw.prepare("SELECT COUNT(*) AS count FROM token_contract").get()).toEqual({ count: 1 });
    expect(raw.prepare("SELECT COUNT(*) AS count FROM contract").get()).toEqual({ count: 1 });
    expect(raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    raw.close();
    database.close();
  });

  it("rejects malformed catalog encodings through the current schema constraints", async () => {
    const { path, database } = await openDatabase();
    database.configuredChainStore().insertConfiguredChainIfAbsent(chainId);
    const connection = database.walletStore().replace("0", connected(chainId, walletAddress), now);
    const inspection = await createInspectionSuccess();
    const created = database.tokenCatalogStore().register({
      account: accountFor(chainId, walletAddress),
      expectedConnectionRevision: connection.revision,
      inspection,
      settings: { userLabel: null, visibility: "visible" },
      revision: revision(1),
      now,
    });
    database.close();

    const raw = new Database(path);
    raw.pragma("foreign_keys = ON");
    const stored = raw.prepare(`SELECT result_json AS resultJson FROM token_contract_inspection
      WHERE chain_id = ? AND contract_address = ? AND inspection_digest = ?`).get(
        chainId,
        tokenAddress,
        created.registration.inspectionDigest,
      ) as { resultJson: string };
    const insertInspection = raw.prepare(`INSERT INTO token_contract_inspection(
      chain_id, contract_address, inspection_digest, result_json
    ) VALUES (?, ?, ?, ?)`);
    for (const [digest, resultJson] of [
      [`0x${"A".repeat(64)}`, stored.resultJson],
      [`0x${"a".repeat(63)}`, stored.resultJson],
      [`0x${"b".repeat(64)}\0suffix`, stored.resultJson],
      [`0x${"c".repeat(64)}`, "[]"],
      [`0x${"d".repeat(64)}`, "{"],
      [`0x${"e".repeat(64)}`, "{\"value\":\"x\u0000y\"}"],
    ] as const) {
      expect(() => insertInspection.run(chainId, tokenAddress, digest, resultJson)).toThrow();
    }

    const profileId = (raw.prepare("SELECT profile_id AS profileId FROM local_profile WHERE singleton = 1")
      .get() as { profileId: string }).profileId;
    const secondWallet = `0x${"56".repeat(20)}`;
    raw.prepare("INSERT INTO wallet_account(profile_id, chain_id, wallet_address) VALUES (?, ?, ?)")
      .run(profileId, chainId, secondWallet);
    const insertRegistration = raw.prepare(`INSERT INTO wallet_token_registration(
      profile_id, chain_id, wallet_address, token_address, revision, inspection_digest,
      user_label, visibility, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const invalidRevision of ["A".repeat(21), "A".repeat(21) + "B", `A${"A".repeat(21)}\0`]) {
      expect(() => insertRegistration.run(
        profileId, chainId, secondWallet, tokenAddress, invalidRevision,
        created.registration.inspectionDigest, null, "visible", now, now,
      )).toThrow();
    }
    for (const invalidLabel of ["", "x".repeat(129), "x\0y"]) {
      expect(() => insertRegistration.run(
        profileId, chainId, secondWallet, tokenAddress, revision(2),
        created.registration.inspectionDigest, invalidLabel, "visible", now, now,
      )).toThrow();
    }
    expect(() => insertRegistration.run(
      profileId, chainId, secondWallet, tokenAddress, revision(2),
      created.registration.inspectionDigest, null, "archived", now, now,
    )).toThrow();
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM wallet_token_registration
      WHERE wallet_address = ?`).get(secondWallet)).toEqual({ count: 0 });
    raw.close();
  });

  it("rejects canonical-looking rows whose decoded meaning is corrupt", async () => {
    const mutations = [
      (raw: Database.Database) => {
        const row = raw.prepare("SELECT result_json AS resultJson FROM token_contract_inspection").get() as {
          resultJson: string;
        };
        raw.prepare("UPDATE token_contract_inspection SET result_json = ?")
          .run(JSON.stringify(JSON.parse(row.resultJson), null, 2));
      },
      (raw: Database.Database) => {
        raw.prepare("UPDATE wallet_token_registration SET user_label = ?").run("line\nbreak");
      },
      (raw: Database.Database) => {
        const falseDigest = `0x${"11".repeat(32)}`;
        raw.pragma("foreign_keys = OFF");
        raw.prepare("UPDATE token_contract_inspection SET inspection_digest = ?").run(falseDigest);
        raw.prepare("UPDATE wallet_token_registration SET inspection_digest = ?").run(falseDigest);
      },
    ];
    for (const mutate of mutations) {
      const { path, database } = await openDatabase();
      database.configuredChainStore().insertConfiguredChainIfAbsent(chainId);
      const connection = database.walletStore().replace("0", connected(chainId, walletAddress), now);
      database.tokenCatalogStore().register({
        account: accountFor(chainId, walletAddress),
        expectedConnectionRevision: connection.revision,
        inspection: await createInspectionSuccess(),
        settings: { userLabel: null, visibility: "visible" },
        revision: revision(1),
        now,
      });
      database.close();
      const raw = new Database(path);
      mutate(raw);
      raw.close();
      await expect(ProductDatabase.open(path, now)).rejects.toSatisfy((error: unknown) =>
        getRuntimeOperationFailure(error)?.error.code === "runtime_state_unavailable");
    }
  });
});
