import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  createChainInvocationLifecycle,
  type ReferenceMarketChainReadPort,
} from "../../src/chain/index.js";
import {
  createCanonicalClock,
  createObservationAuthority,
  parseCapabilityDataAt,
  parseEvmAddressInput,
  parseEvmChainId,
  parseUtcTimestamp,
  referenceMarketManifest,
  sourceReferenceSchema,
  walletConnectionCapability,
  type ApplicationFailure,
} from "../../src/core/index.js";
import { ReferenceMarketApplication } from "../../src/market-portfolio/application.js";
import type { ReferenceWatchlistOperation } from "../../src/market-portfolio/contracts.js";
import { ProductDatabase } from "../../src/runtime/database.js";
import { ensureOwnerOnlyDirectory, runtimePaths } from "../../src/runtime/paths.js";
import type { WalletSessionSource } from "../../src/runtime/source-identity.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

const chainId = parseEvmChainId("eip155:4663");
const address = parseEvmAddressInput(`0x${"12".repeat(20)}`);
const now = "2026-07-22T00:07:00.000Z";

const success = <Value>(value: Value | ApplicationFailure): Value => {
  if (typeof value === "object" && value !== null && "ok" in value && value.ok === false) {
    throw new Error(`Unexpected failure: ${value.error.code}`);
  }
  return value as Value;
};

const createState = async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "littlejohn-watchlist-operation-"));
  directories.push(directory);
  await ensureOwnerOnlyDirectory(directory);
  const path = runtimePaths(directory).database;
  const clock = createCanonicalClock(() => now);
  let database = await ProductDatabase.open(path, parseUtcTimestamp(now));
  database.configuredChainStore().insertConfiguredChainIfAbsent(chainId);
  const connected = database.walletStore().replace("0", parseCapabilityDataAt(
    walletConnectionCapability,
    {
      status: "connected",
      chainId,
      address,
      approvedMethods: ["eth_sendTransaction"],
      approvedEvents: ["accountsChanged", "chainChanged"],
      expiresAt: "2026-07-23T00:07:00.000Z",
    },
    parseUtcTimestamp(now),
  ), false, parseUtcTimestamp(now));
  const topicDigest = "A".repeat(43);
  const sourceId = `wallet-session:${topicDigest}`;
  const sessionSource: WalletSessionSource = Object.freeze({
    sourceId,
    candidateId: sourceId,
    topicDigest,
    observationAuthority: createObservationAuthority({
      clock,
      sourceClass: "wallet_session",
      owner: "WalletConnect session",
      reference: sourceReferenceSchema.parse({ kind: "wallet_session", sourceId, topicDigest }),
    }),
  });
  const activeWallet = Object.freeze({
    capture: () => Object.freeze({
      connection: connected.connection,
      connectionRevision: connected.revision,
      sessionSource,
    }),
  });
  const unavailable = async (): Promise<never> => {
    throw new Error("Reference chain reads are outside this operation test.");
  };
  const chain: ReferenceMarketChainReadPort = Object.freeze({
    resolveCurrentBlock: unavailable,
    readLatestAtBlock: unavailable,
    readHistoryAtBlock: unavailable,
    readStockTokenAtBlock: unavailable,
  });
  const createApplication = () => {
    const lifecycle = createChainInvocationLifecycle(new AbortController().signal);
    const application = new ReferenceMarketApplication({
      chain,
      chainInvocations: lifecycle,
      store: database.referenceMarketStore(),
      activeWallet,
      officialAssets: Object.freeze({
        synchronize: async () => { throw new Error("Official asset reads are not expected."); },
        readStored: () => undefined,
        close: async () => undefined,
      }),
      clock,
    });
    return Object.freeze({
      application,
      async close() {
        await application.close();
        await lifecycle.close();
      },
    });
  };
  return Object.freeze({
    path,
    get database() { return database; },
    createApplication,
    async reopen() {
      database.close();
      database = await ProductDatabase.open(path, parseUtcTimestamp(now));
    },
  });
};

describe("reference watchlist durable operations", () => {
  it("keeps Review creation pure and reopens the exact mutation result", async () => {
    const state = await createState();
    const owner = state.createApplication();
    const initial = success(await owner.application.watchlist({}));
    const review = success(await owner.application.reviewWatchlistChange({
      kind: "add",
      pairId: referenceMarketManifest.pairs[0]!.pairId,
      expectedRevision: initial.revision,
    })).review;

    const before = new Database(state.path, { readonly: true });
    for (const table of [
      "reference_pair_watchlist_state",
      "reference_pair_watchlist_entry",
      "reference_watchlist_operation",
    ]) expect(before.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(), table)
      .toEqual({ count: 0 });
    before.close();

    const operation = success<ReferenceWatchlistOperation>(
      await owner.application.decideWatchlistChange({ review, initiatedBy: "cli" }),
    );
    expect(operation).toMatchObject({
      operationId: review.operationId,
      review,
      state: "completed",
      result: { outcome: "watchlist_pair_added" },
    });
    expect(success(await owner.application.getWatchlistOperation({
      operationId: review.operationId,
    }))).toEqual(operation);

    const committed = new Database(state.path, { readonly: true });
    expect(committed.prepare("SELECT COUNT(*) AS count FROM reference_pair_watchlist_entry").get())
      .toEqual({ count: 1 });
    expect(committed.prepare("SELECT COUNT(*) AS count FROM reference_watchlist_operation").get())
      .toEqual({ count: 1 });
    committed.close();

    await owner.close();
    await state.reopen();
    const successor = state.createApplication();
    expect(success(await successor.application.getWatchlistOperation({
      operationId: review.operationId,
    }))).toEqual(operation);
    expect(success(await successor.application.watchlist({}))).toEqual(operation.result.watchlist);
    await successor.close();
    state.database.close();
  });

  it("rolls back the watchlist mutation when the terminal result cannot be stored", async () => {
    const state = await createState();
    const owner = state.createApplication();
    const initial = success(await owner.application.watchlist({}));
    const review = success(await owner.application.reviewWatchlistChange({
      kind: "add",
      pairId: referenceMarketManifest.pairs[0]!.pairId,
      expectedRevision: initial.revision,
    })).review;
    const raw = new Database(state.path);
    raw.exec(`CREATE TRIGGER reject_watchlist_operation BEFORE INSERT ON reference_watchlist_operation
      BEGIN SELECT RAISE(ABORT, 'reject terminal operation'); END`);
    raw.close();

    expect(await owner.application.decideWatchlistChange({ review, initiatedBy: "mcp_app" }))
      .toMatchObject({ ok: false });
    const check = new Database(state.path, { readonly: true });
    expect(check.prepare("SELECT COUNT(*) AS count FROM reference_pair_watchlist_state").get())
      .toEqual({ count: 0 });
    expect(check.prepare("SELECT COUNT(*) AS count FROM reference_pair_watchlist_entry").get())
      .toEqual({ count: 0 });
    expect(check.prepare("SELECT COUNT(*) AS count FROM reference_watchlist_operation").get())
      .toEqual({ count: 0 });
    check.close();
    await owner.close();
    state.database.close();
  });
});
