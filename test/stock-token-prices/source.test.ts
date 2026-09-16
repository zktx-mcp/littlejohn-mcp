import { describe, expect, it, vi } from "vitest";
import { createCanonicalClock } from "../../src/core/index.js";
import { createDexScreenerPoolCandidateSource } from "../../src/stock-token-prices/dexscreener-source.js";
import { stockTokenPricesCapability } from "../../src/stock-token-prices/contracts.js";
import { candidateRow, createPriceFixture, oversizedCandidateResponse, stock, v3Pool } from "./fixture.js";

const clock = () => createCanonicalClock(() => "2026-09-16T08:00:01.000Z");
describe("replaceable pool candidate source", () => {
  it("retains the queried URI, ignores price fields and classifies hints before ID shape", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify([
      candidateRow("v3", v3Pool),
      { ...candidateRow("v4", v3Pool), dexId: "sheriff", pairAddress: "0x0000000000000000000000000000000000000033" },
      candidateRow("v4", "not-a-pool-id"),
    ])));
    const source = createDexScreenerPoolCandidateSource({ clock: clock(), fetch: fetcher });
    try {
      const observed = await source.read(stock, new AbortController().signal);
      expect(observed.result.candidates.map((row) => row.status)).toEqual(["candidate", "unsupported", "invalid"]);
      expect(observed.result.reference).toMatchObject({ uri: `https://api.dexscreener.com/token-pairs/v1/robinhood/${stock}` });
      expect(JSON.stringify(observed.result)).not.toContain("999999999");
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally { await source.close(); }
  });

  it.each([
    [{ ...candidateRow(), chainId: "other" }],
    [candidateRow(), { ...candidateRow(), labels: ["v3"] }],
  ])("rejects an inconsistent source without silently keeping a prefix", async (...rows) => {
    const source = createDexScreenerPoolCandidateSource({ clock: clock(), fetch: async () => new Response(JSON.stringify(rows)) });
    try { await expect(source.read(stock, new AbortController().signal)).rejects.toMatchObject({ code: "source_inconsistent" }); }
    finally { await source.close(); }
  });

  it.each([false, true])("preserves aggregate overflow through cancellation (rejects=%s)", async (rejects) => {
    const cancel = vi.fn(async () => { if (rejects) throw new TypeError("Cancellation failed."); });
    const response = oversizedCandidateResponse(cancel);
    const fixture = createPriceFixture({ fetch: async () => response });
    try {
      expect(await fixture.bindings.invoke(stockTokenPricesCapability, { symbol: "AAPL" }, { signal: new AbortController().signal }))
        .toEqual({ ok: false, error: { code: "pool_candidate_response_too_large", category: "domain",
          message: "The pool candidate response exceeds the supported size.", retryable: false, issues: [] } });
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(response.body!.locked).toBe(false);
      expect(fixture.calls).toHaveLength(0);
      expect(fixture.codeReads).not.toHaveBeenCalled();
      expect(fixture.fetcher).toHaveBeenCalledTimes(1);
    } finally { await fixture.close(); }
  });

  it.each([
    { status: 200, prefix: false, code: "source_unavailable" },
    { status: 200, prefix: true, code: "source_unavailable" },
    { status: 429, prefix: false, code: "rate_limited" },
  ])("keeps the owning failure for an errored body ($status, prefix=$prefix)", async ({ status, prefix, code }) => {
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        if (prefix) controller.enqueue(new TextEncoder().encode("[]"));
        else controller.error(new TypeError("Body stream failed."));
      },
      pull(controller) { controller.error(new TypeError("Body stream failed after a chunk.")); },
    }, { highWaterMark: 0 }), { status });
    const fixture = createPriceFixture({ fetch: async () => response });
    try {
      expect(await fixture.bindings.invoke(stockTokenPricesCapability, { symbol: "AAPL" }, { signal: new AbortController().signal }))
        .toMatchObject({ ok: false, error: { code } });
      expect(response.body!.locked).toBe(false);
      expect(fixture.calls).toHaveLength(0);
      expect(fixture.codeReads).not.toHaveBeenCalled();
      expect(fixture.fetcher).toHaveBeenCalledTimes(1);
    } finally { await fixture.close(); }
  });

  it.each(["deadline", "caller", "owner"] as const)("settles an active body after %s and drains its reader", async (stop) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let reached!: () => void;
    const started = new Promise<void>((resolve) => { reached = resolve; });
    let response!: Response;
    const fixture = createPriceFixture({ fetch: async (_url, init) => {
      const signal = init!.signal!;
      response = new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
        },
        pull() { reached(); },
      }, { highWaterMark: 0 }));
      return response;
    } });
    const caller = new AbortController();
    try {
      const pending = fixture.bindings.invoke(stockTokenPricesCapability, { symbol: "AAPL" }, { signal: caller.signal });
      await started;
      if (stop === "deadline") await vi.advanceTimersByTimeAsync(10_000);
      else (stop === "caller" ? caller : fixture.owner).abort();
      expect(await pending).toMatchObject({ ok: false, error: { code: stop === "deadline" ? "source_unavailable"
        : stop === "caller" ? "request_aborted" : "runtime_state_unavailable" } });
      expect(response.body!.locked).toBe(false);
      expect(fixture.calls).toHaveLength(0);
      expect(fixture.fetcher).toHaveBeenCalledTimes(1);
    } finally {
      caller.abort();
      await fixture.close();
      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
    }
  });

  it("does not retry provider throttling", async () => {
    const fetcher = vi.fn(async () => new Response("{}", { status: 429 }));
    const source = createDexScreenerPoolCandidateSource({ clock: clock(), fetch: fetcher });
    try {
      await expect(source.read(stock, new AbortController().signal)).rejects.toMatchObject({ code: "rate_limited" });
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally { await source.close(); }
  });
});
