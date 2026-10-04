import { createApplicationLifecycle } from "../../src/runtime/application-lifecycle.js";
import { createResourceOwnershipScope } from "../../src/runtime/resource-ownership.js";
import { createInitialRuntimeSupportManifest } from "../../src/runtime/support-manifest.js";
import { readRuntimeConfiguration } from "../../src/runtime/configuration.js";
import type { RuntimeRouteRegistry } from "../../src/runtime/http-routing.js";
import { extendWalletSupportManifest } from "../../src/wallet/application.js";
import { extendChainSupportManifest } from "../../src/chain/index.js";
import { extendTokenCatalogSupportManifest } from "../../src/token-catalog/support.js";
import { extendAccountAssetSupportManifest } from "../../src/account-assets/support.js";
import { createStockTokenTradeHistoryApplicationFactory } from "../../src/stock-token-trade-history/application-factory.js";
import { Buffer } from "node:buffer";

import { describe, expect, it, vi } from "vitest";

import {
  createChainInvocationLifecycle,
  type PinnedEvmCallResult,
  type PinnedEvmReadPort,
} from "../../src/chain/index.js";
import {CapabilityBindingRegistry, CapabilityRegistry, ObservationAuthorityRegistry, createCanonicalClock, createCapabilityInvocationAuthority, createObservationAuthority, parseHash32, parseUnsignedDecimal, parseUtcTimestamp, sourceReferenceSchema, type UnsignedDecimal} from "../../src/core/index.js";
import {chainAnchorSchema} from "../../src/evm/primitives.js";
import {parseEvmAddress} from "../../src/evm/identities.js";
import {
  assertCommittedOfficialAssetSnapshot,
  officialAssetSnapshotRevisionSchema,
  officialAssetSourceDefinition,
  stockFactoryAdmissionManifest,
  stockFactoryVerificationSchema,
  type CommittedOfficialAssetSnapshot,
  type OfficialAssetSourceMember,
  type StockFactoryVerificationResult,
} from "../../src/registry/index.js";
import {
  officialAssetCandidateListDigest,
  officialAssetMemberSetDigest,
} from "../../src/registry/official-asset-contract.js";
import {
  createStockTokenTradeHistoryApplication,
  createStockTokenTradeHistoryObservationAuthorities,
  stockTokenTradeHistoryCapability,
} from "../../src/stock-token-trade-history/index.js";
import {createStockTokenTradeHistorySource} from "../../src/stock-token-trade-history/source.js";
import type {StockTokenTradeHistorySourcePort} from "../../src/stock-token-trade-history/source-contract.js";
import {
  createStockTokenTradeHistoryMultiMonthSourceFixture,
  createStockTokenTradeHistorySourceFixture,
} from "./source-fixture.js";

const block = chainAnchorSchema.parse({
  chainId: "eip155:4663",
  blockNumber: "100",
  blockHash: `0x${"e".repeat(64)}`,
  blockTimestamp: "2026-08-24T07:00:00.000Z",
});
const member: OfficialAssetSourceMember = Object.freeze({
  assetUid: parseHash32(`0x${"7".repeat(64)}`),
  contractAddress: parseEvmAddress("0xaf3d76f1834a1d425780943c99ea8a608f8a93f9"),
  sourceName: "Apple • Robinhood Token",
  sourceSymbol: "AAPL",
});
const snapshot = (
  members: readonly OfficialAssetSourceMember[] = [member],
): CommittedOfficialAssetSnapshot => {
  const observedAt = parseUtcTimestamp("2026-08-24T06:59:00.000Z");
  return assertCommittedOfficialAssetSnapshot({
    sourceUri: officialAssetSourceDefinition.sourceUri,
    sourceObservedAt: observedAt,
    rawResponseDigest: parseHash32(`0x${"1".repeat(64)}`),
    memberSetDigest: officialAssetMemberSetDigest(members),
    candidateListDigest: officialAssetCandidateListDigest(members),
    chainId: block.chainId,
    members: [...members],
    revision: officialAssetSnapshotRevisionSchema.parse(
      Buffer.alloc(16, 1).toString("base64url"),
    ),
    updatedAt: observedAt,
  });
};
const verification = stockFactoryVerificationSchema.parse({
  assetUid: member.assetUid,
  contractAddress: member.contractAddress,
  block,
  proxyAddress: stockFactoryAdmissionManifest.proxyAddress,
  proxyCodeHash: stockFactoryAdmissionManifest.proxyCodeHash,
  implementationAddress: stockFactoryAdmissionManifest.implementationAddress,
  implementationCodeHash: stockFactoryAdmissionManifest.implementationCodeHash,
  tokenCodeHash: parseHash32(`0x${"2".repeat(64)}`),
});

const unsupported = async (): Promise<never> => {
  throw new Error("Unexpected application test port call.");
};

const createFixture = (input: Readonly<{
  readonly source: StockTokenTradeHistorySourcePort;
  readonly decimals?: PinnedEvmCallResult<UnsignedDecimal>;
  readonly officialSnapshot?: CommittedOfficialAssetSnapshot;
  readonly stockFactory?: StockFactoryVerificationResult;
}>) => {
  const clock = createCanonicalClock(() => parseUtcTimestamp("2026-08-24T07:00:01.000Z"));
  const sources = createStockTokenTradeHistoryObservationAuthorities(clock);
  const rpc = createObservationAuthority({
    clock,
    sourceClass: "chain_rpc",
    owner: "Fixture RPC",
    reference: sourceReferenceSchema.parse({
      kind: "public",
      sourceId: "fixture-rpc",
      uri: "https://rpc.example/",
    }),
  });
  const chain = createChainInvocationLifecycle(new AbortController().signal);
  const readTokenDecimals = vi.fn(async () => input.decimals ?? Object.freeze({
    status: "observed" as const,
    value: parseUnsignedDecimal("18"),
  }));
  const protocolReads: PinnedEvmReadPort = Object.freeze({
    observationAuthority: rpc,
    resolveBlock: unsupported,
    readRuntimeCode: unsupported,
    call: unsupported,
    readTokenDecimals,
    inspectContract: unsupported,
    readTokenDisplayScaling: async () => { throw new Error("Unexpected token display read."); },
    inspectContractExecution: unsupported,
    recordConfiguredChain: () => { throw new Error("Unexpected configured-chain record."); },
  });
  const sourceRead = vi.fn((
    ...args: Parameters<StockTokenTradeHistorySourcePort["read"]>
  ) => input.source.read(...args));
  const sourcePort: StockTokenTradeHistorySourcePort = Object.freeze({
    read: sourceRead,
    close: () => input.source.close(),
  });
  const currentBlockRead = vi.fn(async () => Object.freeze({ anchor: block }));
  const officialSnapshot = input.officialSnapshot ?? snapshot();
  const lifecycle = createApplicationLifecycle();
  lifecycle.resources.register(chain);
  lifecycle.resources.register(sourcePort);
  const synchronize = vi.fn(async () => Object.freeze({ status: "current" as const, snapshot: officialSnapshot }));
  const dependencies = {
    admission: lifecycle.admission,
    chainInvocations: chain,
    currentBlockReads: Object.freeze({
      resolveCurrentBlock: currentBlockRead,
    }),
    officialAssets: Object.freeze({
      synchronize,
      readStored: () => officialSnapshot,
      close: async () => undefined,
    }),
    officialAssetReads: Object.freeze({
      verifyAtBlock: async () => input.stockFactory ?? Object.freeze({
        status: "verified" as const,
        member,
        verification,
      }),
      verifyManyAtBlock: unsupported,
    }),
    protocolReads,
    source: sourcePort,
    invocationAuthority: createCapabilityInvocationAuthority(clock, block.chainId),
    invocationPorts: Object.freeze({
      observations: new ObservationAuthorityRegistry(clock, [
        sources.officialAsset,
        sources.archive,
        rpc,
      ]),
    }),
    officialAssetObservationAuthority: sources.officialAsset,
    archiveObservationAuthority: sources.archive,
  };
  const application = createStockTokenTradeHistoryApplication(dependencies);
  lifecycle.resources.register(application);
  lifecycle.open();
  const bindings = new CapabilityBindingRegistry(
    new CapabilityRegistry([stockTokenTradeHistoryCapability]),
    [application.binding],
  );
  const invoke = (value: unknown, signal = new AbortController().signal) =>
    bindings.invoke(stockTokenTradeHistoryCapability, value, { signal });
  return { application, close: lifecycle.close, dependencies, synchronize, currentBlockRead, invoke, readTokenDecimals, sourceRead };
};

const admittedSource = () => {
  const fixture = createStockTokenTradeHistorySourceFixture();
  return createStockTokenTradeHistorySource({
    transport: fixture.transport,
    now: () => new Date("2026-08-24T07:00:00.000Z"),
  });
};

const admittedMultiMonthSource = () => {
  const fixture = createStockTokenTradeHistoryMultiMonthSourceFixture();
  return createStockTokenTradeHistorySource({
    transport: fixture.transport,
    now: () => new Date("2026-08-24T07:00:00.000Z"),
  });
};

describe("Stock Token trade-history application", () => {
  it("returns proved official absence without entering Chain or archive work", async () => {
    const fixture = createFixture({ source: admittedSource() });
    try {
      const result = await fixture.invoke({ symbol: "ZZZZ" });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new TypeError("Expected an official-absence success.");
      expect(result.data).toMatchObject({
        status: "unavailable",
        reason: "official_asset_not_found",
        symbol: "ZZZZ",
      });
      expect(result.evidence.sources.map((entry) => entry.sourceClass)).toEqual(["web_api"]);
      expect(result.evidence.conclusions.map((entry) => [entry.id, entry.status])).toEqual([
        ["official_asset_snapshot_current", "established"],
        ["stock_factory_verified", "not_applicable"],
        ["token_decimals_observed", "not_applicable"],
        ["trade_history_archive_observed", "not_applicable"],
      ]);
      expect(fixture.readTokenDecimals).not.toHaveBeenCalled();
      expect(fixture.sourceRead).not.toHaveBeenCalled();
    } finally {
      await fixture.close();
    }
  });

  it("retains the exact ambiguous official selector outcome without entering Chain work", async () => {
    const otherMember: OfficialAssetSourceMember = Object.freeze({
      assetUid: parseHash32(`0x${"8".repeat(64)}`),
      contractAddress: parseEvmAddress("0x1111111111111111111111111111111111111111"),
      sourceName: "Another Apple Stock Token",
      sourceSymbol: "AAPL",
    });
    const fixture = createFixture({
      source: admittedSource(),
      officialSnapshot: snapshot([member, otherMember]),
    });
    try {
      const result = await fixture.invoke({ symbol: "AAPL" });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new TypeError("Expected an ambiguous-official success.");
      expect(result.data).toMatchObject({
        status: "unavailable",
        reason: "official_asset_symbol_ambiguous",
        candidateAssetUids: [member.assetUid, otherMember.assetUid],
      });
      expect(result.evidence.sources.map((entry) => entry.sourceClass)).toEqual(["web_api"]);
      expect(fixture.currentBlockRead).not.toHaveBeenCalled();
      expect(fixture.sourceRead).not.toHaveBeenCalled();
    } finally {
      await fixture.close();
    }
  });

  it("publishes a reached StockFactory failure and leaves later stages not requested", async () => {
    const fixture = createFixture({
      source: admittedSource(),
      stockFactory: Object.freeze({
        status: "unavailable",
        member,
        reason: "source_unavailable",
      }),
    });
    try {
      const result = await fixture.invoke({ symbol: "AAPL" });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new TypeError("Expected a StockFactory-unavailable success.");
      expect(result.data).toMatchObject({
        status: "unavailable",
        reason: "stock_factory_unavailable",
      });
      expect(result.evidence.conclusions.map((entry) => [entry.id, entry.status, entry.reason]))
        .toEqual([
          ["official_asset_snapshot_current", "established", "observed"],
          ["stock_factory_verified", "unavailable", "source_failed"],
          ["token_decimals_observed", "not_applicable", "not_requested"],
          ["trade_history_archive_observed", "not_applicable", "not_requested"],
        ]);
      expect(fixture.readTokenDecimals).not.toHaveBeenCalled();
      expect(fixture.sourceRead).not.toHaveBeenCalled();
    } finally {
      await fixture.close();
    }
  });

  it("binds one period through official identity, same-block decimals, WU1, evidence, and positions", async () => {
    const fixture = createFixture({ source: admittedSource() });
    try {
      const result = await fixture.invoke({ symbol: "aapl", period: { count: 1, unit: "day" } });
      expect(result.ok).toBe(true);
      if (!result.ok || result.data.status !== "available") {
        throw new TypeError("Expected an available trade-history success.");
      }
      expect(result.data.resolution).toMatchObject({ label: "15m", positionCount: 96 });
      expect(result.evidence.conclusions.map((entry) => [entry.id, entry.status])).toEqual([
        ["official_asset_snapshot_current", "established"],
        ["stock_factory_verified", "established"],
        ["token_decimals_observed", "established"],
        ["trade_history_archive_observed", "established"],
      ]);
      expect(result.evidence.sources.map((entry) => entry.sourceClass).sort()).toEqual([
        "chain_rpc", "chain_rpc", "public_dataset", "web_api",
      ]);
      expect(fixture.readTokenDecimals).toHaveBeenCalledTimes(1);
      expect(fixture.sourceRead).toHaveBeenCalledTimes(1);
    } finally {
      await fixture.close();
    }
  });

  it("carries a producer-valid multi-month archive through the one-year canonical result", async () => {
    const fixture = createFixture({ source: admittedMultiMonthSource() });
    try {
      const result = await fixture.invoke({
        symbol: "AAPL",
        period: { count: 1, unit: "year" },
      });
      expect(result.ok).toBe(true);
      if (!result.ok || result.data.status !== "available") {
        throw new TypeError("Expected an available one-year trade-history success.");
      }
      expect(result.data.resolution).toMatchObject({ label: "2d" });
      expect(result.data.resolution.positionCount).toBeLessThanOrEqual(185);
      expect(result.data.archive.monthMembers.map((entry) => entry.ownerMonth))
        .toEqual(["2026-06", "2026-07"]);
      expect(result.data.archive.resolutionMembers).toEqual([]);
      expect(result.data.coverage).toMatchObject({
        status: "partial",
        limitations: ["before_published_coverage", "after_published_coverage"],
        fromTimestamp: expect.any(String),
        untilTimestamp: expect.any(String),
      });
      expect(result.data.positions).toHaveLength(result.data.resolution.positionCount);
      expect(result.data.positions.some((position) => position.coverage === "partial")).toBe(true);
      expect(result.data.positions.some((position) => position.coverage === "unavailable")).toBe(true);
      expect(fixture.sourceRead).toHaveBeenCalledTimes(1);
    } finally {
      await fixture.close();
    }
  });

  it("stops after the reached decimals observation when the same-block call reverts", async () => {
    const fixture = createFixture({
      source: admittedSource(),
      decimals: Object.freeze({ status: "reverted" }),
    });
    try {
      const result = await fixture.invoke({ symbol: "AAPL" });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new TypeError("Expected a decimals-unavailable success.");
      expect(result.data).toMatchObject({
        status: "unavailable",
        reason: "token_decimals_unavailable",
        tokenDecimals: { status: "unavailable", reason: "call_reverted" },
      });
      expect(fixture.sourceRead).not.toHaveBeenCalled();
      expect(result.evidence.sources.map((entry) => entry.sourceClass).sort())
        .toEqual(["chain_rpc", "chain_rpc", "web_api"]);
      expect(result.evidence.conclusions.at(-1)).toMatchObject({ status: "not_applicable" });
    } finally {
      await fixture.close();
    }
  });

  it("registers the whole invocation before work and drains owner cancellation", async () => {
    let started!: () => void;
    const sourceStarted = new Promise<void>((resolve) => { started = resolve; });
    let aborted = false;
    const source: StockTokenTradeHistorySourcePort = Object.freeze({
      async read(
        _request: Parameters<StockTokenTradeHistorySourcePort["read"]>[0],
        signal?: AbortSignal,
      ) {
        started();
        return await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("source aborted"));
          }, { once: true });
        });
      },
      close: async () => undefined,
    });
    const fixture = createFixture({ source });
    const active = fixture.invoke({ symbol: "AAPL" });
    await sourceStarted;
    const closing = fixture.application.close();
    await expect(active).resolves.toMatchObject({
      ok: false,
      error: { code: "runtime_state_unavailable" },
    });
    await closing;
    expect(aborted).toBe(true);
    await fixture.close();
  });
});


describe("Stock Token trade-history factory admission", () => {
  it("blocks the real binding before cleanup can cancel a newly admitted read", async () => {
    const fixture = createFixture({ source: admittedSource() });
    const startup = createResourceOwnershipScope();
    const supportManifest = extendAccountAssetSupportManifest(extendTokenCatalogSupportManifest(
      extendChainSupportManifest(extendWalletSupportManifest(
        createInitialRuntimeSupportManifest(readRuntimeConfiguration({}).chain),
      )),
    ));
    const application = await createStockTokenTradeHistoryApplicationFactory({
      ...fixture.dependencies,
      routes: Object.freeze({}) as RuntimeRouteRegistry,
      supportManifest,
      startupResources: startup.resources,
    });
    try {
      const bindings = new CapabilityBindingRegistry(
        new CapabilityRegistry([stockTokenTradeHistoryCapability]), [application.binding],
      );
      const invoke = () => bindings.invoke(stockTokenTradeHistoryCapability, { symbol: "ZZZZ" }, {
        signal: new AbortController().signal,
      });
      await expect(invoke()).resolves.toMatchObject({ ok: true });
      expect(fixture.synchronize).toHaveBeenCalledTimes(1);
      expect(startup.empty).toBe(true);
      const close = application.close();
      expect(application.close()).toBe(close);
      const refused = invoke();
      expect(fixture.synchronize).toHaveBeenCalledTimes(1);
      await expect(refused).resolves.toMatchObject({
        ok: false, error: { code: "runtime_state_unavailable" },
      });
      await close;
    } finally {
      await application.close();
      await fixture.close();
    }
  });
});

describe("trade-history card execution", () => {
  const setupCard = async (source: StockTokenTradeHistorySourcePort,
    wrapStore: (store: import("../../src/interfaces/mcp-app/card-contract.js").PresentationCardStore) => import("../../src/interfaces/mcp-app/card-contract.js").PresentationCardStore = (store) => store) => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { ProductDatabase } = await import("../../src/runtime/database.js");
    const { PresentationCardApplication } = await import("../../src/interfaces/mcp-app/card-application.js");
    const { captureCanonicalJson } = await import("../../src/core/index.js");
    const fixture = createFixture({ source });
    const directory = await mkdtemp(join(tmpdir(), "littlejohn-read-card-"));
    const database = await ProductDatabase.open(join(directory, "product.sqlite3"), parseUtcTimestamp("2026-08-24T07:00:01.000Z"));
    const unused = (): never => { throw new Error("No Wallet or transaction operation belongs to this read."); };
    const owner = new AbortController();
    const cards = new PresentationCardApplication({
      ownerSignal: owner.signal,
      clock: createCanonicalClock(() => parseUtcTimestamp("2026-08-24T07:00:01.000Z")),
      store: wrapStore(database.presentationCardStore()), snapshots: database.presentationSnapshotStore(), reviews: { readPresentation: unused },
      domains: {
        wallet: { review: unused, decide: unused, get: unused, getPresentation: unused, cancel: unused },
        signing: { start: unused, get: unused, cancel: unused, confirm: unused },
        exchange: { start: unused, get: unused, cancel: unused, confirm: unused },
        token: { review: unused, decide: unused, getOperation: unused },
      },
      readExecution: { async execute(input, signal) { const result = await fixture.invoke(input, signal); return result.ok ? captureCanonicalJson(result) : result; } },
    });
    return { cards, database, fixture, owner, path: join(directory, "product.sqlite3"),
      close: async () => { await cards.close(); await fixture.close(); database.close(); await rm(directory, { recursive: true, force: true }); } };
  };

  it("acknowledges before source completion and keeps one actual capability execution after caller closure and new openings", async () => {
    const source = admittedSource();
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    const test = await setupCard({ read: async (input, signal) => { entered(); await gate; return source.read(input, signal); }, close: () => source.close() });
    const caller = new AbortController();
    try {
      const acknowledgement = await test.cards.startRead({ capabilityId: "market.stock_token_trade_history", input: { symbol: "aapl" } }, caller.signal);
      await reached; caller.abort();
      for (const byte of [81, 82]) {
        const value = await test.cards.open({ cardId: acknowledgement.reference.cardId, cardOpenRequestId: Buffer.alloc(32, byte).toString("base64url") });
        expect(value.presentation.state).toMatchObject({ mode: "static", record: { kind: "read", phase: "pending", outcome: null,
          request: { input: { symbol: "AAPL", period: { count: 1, unit: "day" } } } } });
      }
      release();
      await vi.waitFor(async () => expect((await test.cards.get(acknowledgement.reference)).presentation.state.record?.phase).toBe("closed"));
      const stored = test.database.presentationCardStore().read(acknowledgement.reference.cardId);
      if (stored?.kind !== "read" || stored.outcome?.kind !== "snapshot") throw new Error("The completed read must reference its canonical snapshot.");
      const snapshot = test.database.presentationSnapshotStore().read(stored.outcome.snapshotId);
      if (snapshot.status !== "available") throw new Error("The referenced result must be committed.");
      expect(JSON.parse(new TextDecoder().decode(snapshot.value.inputBytes))).toEqual({ symbol: "AAPL", period: { count: 1, unit: "day" } });
      expect(JSON.parse(new TextDecoder().decode(snapshot.value.resultBytes))).toMatchObject({ ok: true, data: { status: "available" }, meta: { capabilityId: "market.stock_token_trade_history" } });
      await test.cards.get(acknowledgement.reference);
      expect(test.fixture.sourceRead).toHaveBeenCalledOnce();
      expect(test.fixture.synchronize).toHaveBeenCalledOnce();
    } finally { release(); await test.close(); }
  });

  it("records a refused publication's owned capacity failure without disabling later card reads", async () => {
    const { CardError } = await import("../../src/interfaces/mcp-app/card-errors.js");
    let refuse = true;
    let reached!: () => void;
    let publication = new Promise<void>((resolve) => { reached = resolve; });
    const test = await setupCard(admittedSource(), (store) => ({ ...store,
      completeRead(record, input) {
        reached();
        if (refuse) throw new CardError("presentation_capacity_exceeded");
        return store.completeRead(record, input);
      },
    }));
    try {
      const first = await test.cards.startRead({ capabilityId: "market.stock_token_trade_history", input: { symbol: "AAPL" } }, new AbortController().signal);
      await publication;
      expect(test.database.presentationCardStore().read(first.reference.cardId)).toMatchObject({ phase: "closed",
        outcome: { kind: "failure", failureCode: "presentation_capacity_exceeded" } });
      expect((await test.cards.get(first.reference)).presentation.state.record).toMatchObject({ phase: "closed" });
      refuse = false;
      publication = new Promise<void>((resolve) => { reached = resolve; });
      const next = await test.cards.startRead({ capabilityId: "market.stock_token_trade_history", input: { symbol: "AAPL" } }, new AbortController().signal);
      await publication;
      expect((await test.cards.get(next.reference)).presentation.state.record?.outcome?.kind).toBe("snapshot");
      expect(test.fixture.sourceRead).toHaveBeenCalledTimes(2);
    } finally { await test.close(); }
  });

  it("interrupts the admitted chart through its owner signal without closing storage first", async () => {
    const source = admittedSource();
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    const test = await setupCard({ read: async (_input, signal) => new Promise<never>((_, reject) => {
      if (signal === undefined) throw new Error("The admitted chart execution must carry its cancellation signal.");
      const abort = (): void => { reject(new Error("The source observed owner cancellation.")); };
      signal.addEventListener("abort", abort, { once: true });
      entered(); if (signal.aborted) abort();
    }), close: () => source.close() });
    try {
      const started = await test.cards.startRead({ capabilityId: "market.stock_token_trade_history", input: { symbol: "AAPL" } }, new AbortController().signal);
      await reached;
      test.owner.abort();
      await test.cards.close();
      expect(test.database.presentationCardStore().read(started.reference.cardId)).toMatchObject({ phase: "closed",
        outcome: { kind: "failure", failureCode: "runtime_state_unavailable" } });
      expect(test.fixture.sourceRead).toHaveBeenCalledOnce();
      await expect(test.cards.startRead({ capabilityId: "market.stock_token_trade_history", input: { symbol: "AAPL" } }, new AbortController().signal))
        .rejects.toThrow("Local runtime state is unavailable.");
      expect(test.fixture.sourceRead).toHaveBeenCalledOnce();
    } finally { await test.close(); }
  });

  it("rolls back the snapshot when the final card update fails without publishing a false completion", async () => {
    const { default: Database } = await import("better-sqlite3");
    const test = await setupCard(admittedSource());
    const raw = new Database(test.path);
    raw.exec(`CREATE TRIGGER fail_read_publication BEFORE UPDATE ON presentation_card
      WHEN json_extract(NEW.record_json, '$.outcome.kind') = 'snapshot'
      BEGIN SELECT RAISE(ABORT, 'publication failure'); END`);
    try {
      const acknowledgement = await test.cards.startRead({ capabilityId: "market.stock_token_trade_history", input: { symbol: "AAPL" } }, new AbortController().signal);
      await vi.waitFor(async () => expect((await test.cards.get(acknowledgement.reference)).presentation.state.record?.phase).toBe("closed"));
      expect(test.database.presentationCardStore().read(acknowledgement.reference.cardId)).toMatchObject({ kind: "read", phase: "closed",
        outcome: { kind: "failure", failureCode: "runtime_state_unavailable" } });
      expect(raw.prepare("SELECT count(*) AS count FROM presentation_snapshot").get()).toEqual({ count: 0 });
      expect(test.fixture.sourceRead).toHaveBeenCalledOnce();
      raw.exec("DROP TRIGGER fail_read_publication");
      const second = await test.cards.startRead({ capabilityId: "market.stock_token_trade_history", input: { symbol: "AAPL" } }, new AbortController().signal);
      expect(second.reference.cardId).not.toBe(acknowledgement.reference.cardId);
      await vi.waitFor(async () => expect((await test.cards.get(second.reference)).presentation.state.record?.outcome?.kind).toBe("snapshot"));
      expect(raw.prepare("SELECT count(*) AS count FROM presentation_snapshot").get()).toEqual({ count: 1 });
      expect(test.fixture.sourceRead).toHaveBeenCalledTimes(2);
    } finally { raw.close(); await test.close(); }
  });
});
