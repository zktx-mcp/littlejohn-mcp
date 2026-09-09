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
import {
  CapabilityBindingRegistry,
  CapabilityRegistry,
  ObservationAuthorityRegistry,
  chainAnchorSchema,
  createCanonicalClock,
  createCapabilityInvocationAuthority,
  createObservationAuthority,
  parseEvmAddress,
  parseHash32,
  parseUnsignedDecimal,
  parseUtcTimestamp,
  sourceReferenceSchema,
  type UnsignedDecimal,
} from "../../src/core/index.js";
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
import { createStockTokenTradeHistorySource } from
  "../../src/stock-token-trade-history/source.js";
import type { StockTokenTradeHistorySourcePort } from
  "../../src/stock-token-trade-history/source-contract.js";
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
