import { describe, expect, it } from "vitest";
import { parseCapabilitySuccess,
  createObservationAuthority, sourceReferenceSchema, ObservationAuthorityRegistry } from "../../src/core/index.js";
import { createEvidenceReplayLayout, createEvidenceReplayBinder, replayPublicEvidence } from "../../src/core/client.js";
import { stockTokenPricesCapability, stockTokensCapability, stockTokenPricesEvidence } from "../../src/stock-token-prices/contracts.js";
import { tokenUnitPoolPrice } from "../../src/stock-token-prices/numeric.js";
import { candidateRow, createPriceFixture, member, stock, v3Pool, v4Pool, dynamicPool, block, toFunctionSelector } from "./fixture.js";
import { poolPriceFeeText } from "../../src/interfaces/stock-token-price-presentation.js";

describe("Stock Token price execution", () => {
  it("binds each API fact to its own registered owner and rejects source substitution", async () => {
    const fixture = createPriceFixture();
    try {
      const result = await fixture.bindings.invoke(stockTokenPricesCapability, { symbol: "AAPL" }, { signal: new AbortController().signal });
      if (!result.ok) throw new Error(JSON.stringify(result));
      const evidence = stockTokenPricesEvidence;
      const layout = createEvidenceReplayLayout(evidence.definition, evidence.observationTargets());
      const declaration = evidence.declaration({ symbol: "AAPL" }, result.data, createEvidenceReplayBinder(evidence.definition, layout));
      const input = { definition: evidence.definition, layout, ...declaration,
        sources: result.evidence.sources, evaluatedAt: result.meta.evaluatedAt };
      expect(replayPublicEvidence(input).coverage).toEqual(result.evidence.coverage);
      expect(() => replayPublicEvidence({ ...input, observationExpectations: declaration.observationExpectations.map((item) =>
        item.source?.owner === "Robinhood" ? { ...item, source: { ...item.source, owner: "DEX Screener" } } : item) })).toThrow("definition-owned identity");
      expect(() => replayPublicEvidence({ ...input, observationExpectations: declaration.observationExpectations.map((item) =>
        item.source?.owner === "DEX Screener" ? { slot: item.slot, claims: item.claims } : item) })).toThrow("exact definition-owned source");
      const foreign = createObservationAuthority({ clock: fixture.clock, sourceClass: "web_api", owner: "Other provider",
        reference: sourceReferenceSchema.parse({ kind: "public", sourceId: "foreign-provider", uri: "https://other.example/" }) });
      expect(fixture.ports.observations.owns("web_api", foreign)).toBe(false);
      expect(() => fixture.ports.observations.get("web_api")).toThrow("ambiguous");
      const changedReference = createObservationAuthority({ clock: fixture.clock, sourceClass: "web_api", owner: "Robinhood",
        reference: sourceReferenceSchema.parse({ kind: "public", sourceId: "robinhood-official-assets", uri: "https://other.example/" }) });
      expect(() => new ObservationAuthorityRegistry(fixture.clock, [fixture.officialAuthority, changedReference])).toThrow("Duplicate");
    } finally { await fixture.close(); }
  });
  it("checks the full V4 hash before asking for the price state", async () => {
    const fixture = createPriceFixture({ rows: [candidateRow("v4", v4Pool.slice(0, -2) + "00")] });
    try {
      const result = await fixture.bindings.invoke(stockTokenPricesCapability, { symbol: "AAPL" }, { signal: new AbortController().signal });
      if (!result.ok || result.data.status !== "available") throw new Error(JSON.stringify(result));
      expect(result.data.pools).toMatchObject([{ status: "invalid", reason: "pool_identity_mismatch" }]);
      expect(fixture.calls.some((call) => call.data.startsWith(toFunctionSelector("getSlot0(bytes32)")))).toBe(false);
    } finally { await fixture.close(); }
  });

  it("uses observed dynamic fees and labels both protocol directions", async () => {
    const fixture = createPriceFixture({ dynamic: true, rows: [candidateRow("v4", dynamicPool)] });
    try {
      const result = await fixture.bindings.invoke(stockTokenPricesCapability, { symbol: "AAPL" }, { signal: new AbortController().signal });
      if (!result.ok || result.data.status !== "available") throw new Error(JSON.stringify(result));
      const row = result.data.pools[0]!;
      expect(row).toMatchObject({ status: "verified", state: { dynamicFee: true, lpFeeMillionths: "1500", protocolFee0To1Millionths: "500", protocolFee1To0Millionths: "250" } });
      expect(poolPriceFeeText(row)).toBe("Observed LP fee: 0.15% (dynamic); protocol fee Stock Token→USDG: 0.025%; USDG→Stock Token: 0.05%");
      expect(poolPriceFeeText(row)).not.toContain("8388608");
    } finally { await fixture.close(); }
  });
  it("reads the three native versions at one block and ignores provider prices", async () => {
    const fixture = createPriceFixture();
    try {
      const result = await fixture.bindings.invoke(stockTokenPricesCapability, { symbol: "aapl" }, { signal: new AbortController().signal });
      expect(result.ok).toBe(true);
      if (!result.ok || result.data.status !== "available") throw new Error(JSON.stringify(result));
      expect(result.data.pools.map((pool) => pool.status)).toEqual(["verified", "verified", "verified"]);
      for (const pool of result.data.pools) {
        if (pool.status !== "verified") throw new Error("Missing price.");
        // 10^6 quote raw units and 10^18 stock raw units represent one token each.
        expect(pool.price).toEqual({ numerator: "1", denominator: "1" });
      }
      expect(result.data.block).toEqual(block);
      expect(fixture.calls.every((call) => call.block === block)).toBe(true);
      expect(new Set(fixture.codeReads.mock.calls.map((call) => call[2])).size).toBe(fixture.codeReads.mock.calls.length);
      expect(fixture.fetcher).toHaveBeenCalledTimes(1);
      expect(result.evidence.sources.filter((source) => source.sourceClass === "web_api").map((source) => source.owner).sort()).toEqual(["DEX Screener", "Robinhood"]);
      expect(result.evidence.conclusions.find((item) => item.freshness.ruleId === "pool_candidate_source_observed")?.freshness.status).toBe("unknown");
      expect(parseCapabilitySuccess(stockTokenPricesCapability, { symbol: "AAPL" }, result)).toEqual(result);
      const altered = structuredClone(result);
      const row = altered.data.status === "available" ? altered.data.pools[0] : undefined;
      if (row?.status !== "verified") throw new Error("Missing mutable test row.");
      row.price.numerator = "2";
      expect(() => parseCapabilitySuccess(stockTokenPricesCapability, { symbol: "AAPL" }, altered)).toThrow();
    } finally { await fixture.close(); }
  });

  it("deduplicates returned IDs and preserves unsupported and unavailable candidates", async () => {
    const fixture = createPriceFixture({ rows: [candidateRow(), candidateRow(), candidateRow("v3", v3Pool),
      { ...candidateRow("v4", "0x0000000000000000000000000000000000000022"), dexId: "sheriff" }],
      intercept: (_address, selector) => selector === toFunctionSelector("poolKeys(bytes25)") ? "empty_key" : undefined });
    try {
      const result = await fixture.bindings.invoke(stockTokenPricesCapability, { tokenAddress: stock }, { signal: new AbortController().signal });
      if (!result.ok || result.data.status !== "available") throw new Error(JSON.stringify(result));
      expect(result.data.pools.map((pool) => pool.status)).toEqual(["unavailable", "verified", "unsupported"]);
      expect(result.data.pools[0]).toMatchObject({ reason: "pool_metadata_unavailable" });
      expect(fixture.calls.filter((call) => call.data.startsWith(toFunctionSelector("poolKeys(bytes25)")))).toHaveLength(1);
      expect(fixture.calls.some((call) => call.address.endsWith("0022"))).toBe(false);
      expect(result.evidence.coverage.status).toBe("partial");
    } finally { await fixture.close(); }
  });

  it.each(["wrong_factory", "bad_bytes"] as const)("isolates a V3 %s from an independently valid V4 price", async (change) => {
    const fixture = createPriceFixture({ rows: [candidateRow("v3", v3Pool), candidateRow()],
      intercept: (address, selector) => address === v3Pool && selector === toFunctionSelector("factory()") ? change : undefined });
    try {
      const result = await fixture.bindings.invoke(stockTokenPricesCapability, { symbol: "AAPL" }, { signal: new AbortController().signal });
      if (!result.ok || result.data.status !== "available") throw new Error(JSON.stringify(result));
      expect(result.data.pools.map((pool) => pool.status)).toEqual(["invalid", "verified"]);
      expect(result.data.pools[0]).toMatchObject({ reason: change === "wrong_factory" ? "pool_identity_mismatch" : "pool_response_malformed" });
    } finally { await fixture.close(); }
  });

  it("requires deployment code identity and the PositionManager relationship", async () => {
    for (const options of [{ badCode: true }, { intercept: (_address: string, selector: string) => selector === toFunctionSelector("poolManager()") ? "wrong_manager" as const : undefined }]) {
      const fixture = createPriceFixture({ ...options, rows: [candidateRow()] });
      try {
        const result = await fixture.bindings.invoke(stockTokenPricesCapability, { symbol: "AAPL" }, { signal: new AbortController().signal });
        if (!result.ok || result.data.status !== "available") throw new Error(JSON.stringify(result));
        expect(result.data.pools).toMatchObject([{ status: "invalid", reason: "deployment_identity_mismatch" }]);
        expect(fixture.calls.some((call) => call.data.startsWith(toFunctionSelector("poolKeys(bytes25)")))).toBe(false);
      } finally { await fixture.close(); }
    }
  });

  it("lists official members independently and does not select an ambiguous symbol", async () => {
    const other = { ...member, assetUid: `0x${"8".repeat(64)}` as typeof member.assetUid,
      contractAddress: "0x0000000000000000000000000000000000000044" as typeof stock };
    const fixture = createPriceFixture({ members: [member, other] });
    try {
      const catalog = await fixture.bindings.invoke(stockTokensCapability, {}, { signal: new AbortController().signal });
      if (!catalog.ok) throw new Error(JSON.stringify(catalog));
      expect(catalog.data.members).toEqual([member, other]);
      const prices = await fixture.bindings.invoke(stockTokenPricesCapability, { symbol: "AAPL" }, { signal: new AbortController().signal });
      if (!prices.ok) throw new Error(JSON.stringify(prices));
      expect(prices.data).toMatchObject({ status: "selection_unavailable", reason: "official_asset_ambiguous", candidates: [member, other] });
      expect(fixture.fetcher).not.toHaveBeenCalled();
      expect(fixture.codeReads).not.toHaveBeenCalled();
    } finally { await fixture.close(); }
  });

  it.each(["caller", "owner"] as const)("settles and drains a blocked source after %s termination", async (who) => {
    let reached!: () => void;
    const started = new Promise<void>((resolve) => { reached = resolve; });
    const fixture = createPriceFixture({ fetch: async (_url, init) => new Promise((_resolve, reject) => {
      reached();
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    }) });
    const caller = new AbortController();
    try {
      const pending = fixture.bindings.invoke(stockTokenPricesCapability, { symbol: "AAPL" }, { signal: caller.signal });
      await started;
      (who === "caller" ? caller : fixture.owner).abort();
      expect(await pending).toMatchObject({ ok: false, error: { code: who === "caller" ? "request_aborted" : "runtime_state_unavailable" } });
      expect(fixture.calls).toHaveLength(0);
    } finally { await fixture.close(); }
    expect(await fixture.bindings.invoke(stockTokenPricesCapability, { symbol: "AAPL" }, { signal: new AbortController().signal })).toMatchObject({ ok: false, error: { code: "runtime_state_unavailable" } });
    expect(fixture.fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("price numeric contract", () => {
  it("preserves direction, unequal decimals and the admitted extreme without Number arithmetic", () => {
    expect(tokenUnitPoolPrice({ numerator: 2n, denominator: 5n, stockDecimals: 18, quoteDecimals: 6 })).toEqual({ numerator: "400000000000", denominator: "1" });
    expect(tokenUnitPoolPrice({ numerator: 5n, denominator: 2n, stockDecimals: 6, quoteDecimals: 18 })).toEqual({ numerator: "1", denominator: "400000000000" });
    const extreme = tokenUnitPoolPrice({ numerator: 1n, denominator: 1n << 192n, stockDecimals: 0, quoteDecimals: 255 });
    expect(extreme.numerator).toBe("1");
    expect(extreme.denominator).toBe(((1n << 192n) * 10n ** 255n).toString(10));
    expect(extreme.denominator).toHaveLength(313);
    expect(() => tokenUnitPoolPrice({ numerator: 1n, denominator: 0n, stockDecimals: 18, quoteDecimals: 6 })).toThrow();
  });
});
