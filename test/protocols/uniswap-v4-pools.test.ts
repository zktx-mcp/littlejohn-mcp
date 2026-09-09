import { describe, it, expect } from "vitest";
import { invokeBinding } from "../core/capability-harness.js";
import { createExchangeFixture } from "../review/fixture.js";
import { createUniswapV4PoolsApplication } from "../../src/protocols/uniswap-v4/application.js";
import { uniswapV4PoolsCapability } from "../../src/protocols/uniswap-v4/pools.js";

describe("Uniswap V4 pool selection", () => {
  it("returns only current official members from the fixed candidate catalog without a quote or Wallet request", async () => {
    const fixture = createExchangeFixture();
    try {
      const request = fixture.input.request;
      if ("kind" in request) throw new Error("Ordinary exchange fixture required.");
      const binding = createUniswapV4PoolsApplication({ officialAssets: fixture.deps.officialAssets,
        officialAssetObservationAuthority: fixture.deps.officialAssetObservationAuthority,
        invocationAuthority: fixture.deps.invocationAuthority, invocationPorts: fixture.invocationPorts });
      const selected = await invokeBinding(uniswapV4PoolsCapability, binding, { stockTokenAddress: request.stockTokenAddress });
      expect(selected).toMatchObject({ ok: true, data: { officialMember: true, candidates: [{ poolId: request.poolId }] } });
      const absent = await invokeBinding(uniswapV4PoolsCapability, binding, { stockTokenAddress: `0x${"ab".repeat(20)}` });
      expect(absent).toMatchObject({ ok: true, data: { officialMember: false, candidates: [] } });
      expect(fixture.readsCall).not.toHaveBeenCalled();
      expect(fixture.estimate).not.toHaveBeenCalled();
    } finally { await fixture.close(); }
  });
});
