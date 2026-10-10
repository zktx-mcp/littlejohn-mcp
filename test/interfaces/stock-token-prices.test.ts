import { describe, expect, it } from "vitest";
import { captureCanonicalJson, getCapabilityDefinitionSnapshot, parseCapabilityInput } from "../../src/core/index.js";
import { parseMarketCliCommand, runMarketCliCommand } from "../../src/interfaces/market-cli.js";
import { stockTokenPricesCapability, stockTokensCapability } from "../../src/stock-token-prices/contracts.js";
import { createPriceFixture, stock } from "../stock-token-prices/fixture.js";
import { LocalOperationClient } from "../../src/interfaces/operation-client.js";
import { openTestOwnerSession } from "./owner-session-harness.js";

describe("price and catalog CLI bindings", () => {
  it("uses canonical selectors and rejects conflicting inputs", () => {
    expect(parseMarketCliCommand(["market", "stock-token-prices", "aapl"]).input).toEqual({ symbol: "AAPL" });
    expect(parseMarketCliCommand(["market", "stock-token-prices", "--token", stock]).input).toEqual({ tokenAddress: stock });
    for (const address of ["0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9", `0x${stock.slice(2).toUpperCase()}`]) {
      expect(parseMarketCliCommand(["market", "stock-token-prices", "--token", address]).input).toEqual({ tokenAddress: stock });
      expect(() => parseCapabilityInput(stockTokenPricesCapability, { tokenAddress: address })).toThrow();
    }
    for (const address of ["0xaf3D76f1834A1d425780943C99Ea8A608f8a93f9", stock.slice(0, -1)]) {
      expect(() => parseMarketCliCommand(["market", "stock-token-prices", "--token", address])).toThrow();
    }
    expect(getCapabilityDefinitionSnapshot(stockTokensCapability).failureCodes).not.toContain("pool_candidate_response_too_large");
    expect(getCapabilityDefinitionSnapshot(stockTokenPricesCapability).failureCodes).toContain("result_too_large");
    expect(parseMarketCliCommand(["market", "stock-tokens", "--json"]).input).toEqual({});
    for (const args of [["stock-token-prices"], ["stock-token-prices", "AAPL", "--token", stock], ["stock-tokens", "AAPL"], ["stock-tokens", "--json", "--json"]]) {
      expect(() => parseMarketCliCommand(["market", ...args])).toThrow();
    }
  });
  it.each(["stock-token-prices", "stock-tokens"])("delivers the canonical %s result and does not use snapshots", async (name) => {
    const fixture = createPriceFixture();
    const requests: unknown[] = [];
    const output: string[] = [];
    let client: LocalOperationClient | undefined;
    try {
      const definition = name === "stock-tokens" ? stockTokensCapability : stockTokenPricesCapability;
      const input = name === "stock-tokens" ? {} : { symbol: "AAPL" };
      const result = await fixture.bindings.invoke(definition, input, { signal: new AbortController().signal });
      if (!result.ok) throw new Error(JSON.stringify(result));
      const runtime = { async dispatchRuntimeRequest(request: unknown) { requests.push(request); return { status: 200, body: captureCanonicalJson(result) }; } };
      client = new LocalOperationClient({ ownerSessions: { openOwnerSession: (signal) => openTestOwnerSession(runtime, signal) } });
      const command = parseMarketCliCommand(["market", name, ...(name === "stock-tokens" ? [] : ["--token", "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9"]), "--json"]);
      const exit = await runMarketCliCommand(client, command, { writeOutput: (text) => output.push(text), writeError: (text) => { throw new Error(text); } });
      expect(exit).toBe(0);
      expect(JSON.parse(output[0]!)).toEqual(result);
      expect(requests).toEqual([expect.objectContaining({ requestClass: "local_control", method: "POST",
        path: name === "stock-tokens" ? "/api/v1/internal/control/stock-tokens" : "/api/v1/internal/control/stock-token-price-queries",
        body: name === "stock-tokens" ? {} : { tokenAddress: stock } })]);
    } finally { await client?.close(); await fixture.close(); }
  });
});
