import { describe, expect, it } from "vitest";

import {createGitHubStockTokenTradeHistoryTransport} from "../../src/stock-token-trade-history/github-source.js";
import {
  isStockTokenTradeHistoryProviderCleanupError,
  type StockTokenTradeHistoryProviderCleanupError,
} from "../../src/stock-token-trade-history/source-contract.js";

const jsonResponse = (value: unknown, status = 200, headers: HeadersInit = {}): Response =>
  new Response(JSON.stringify(value), { status, headers });

describe("GitHub Stock Token trade-history transport", () => {
  it("reads the complete catalog through the first short asset page", async () => {
    const urls: string[] = [];
    const fetchImplementation: typeof fetch = async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/releases/tags/market-data-catalog")) {
        return jsonResponse({ id: 41, ignored: true });
      }
      return jsonResponse([{
        id: 9,
        name: `root-s1-${"a".repeat(64)}.json.gz`,
        size: 81,
        state: "uploaded",
      }]);
    };
    const transport = createGitHubStockTokenTradeHistoryTransport({
      fetch: fetchImplementation,
    });

    await expect(transport.readCatalog(4_096, 8_192, 1_000, new AbortController().signal))
      .resolves.toMatchObject({
        status: "read",
        value: {
          assets: [{ name: `root-s1-${"a".repeat(64)}.json.gz`, bytes: 81 }],
          overflow: false,
        },
      });
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain("per_page=100&page=1");
  });

  it("counts non-uploaded assets when proving catalog overflow", async () => {
    const fetchImplementation: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/releases/tags/market-data-catalog")) return jsonResponse({ id: 42 });
      const page = Number(new URL(url).searchParams.get("page"));
      const count = page <= 10 ? 100 : 1;
      return jsonResponse(Array.from({ length: count }, (_, index) => ({
        name: `asset-${page}-${index}`,
        size: 1,
        state: page <= 10 ? "open" : "uploaded",
      })));
    };
    const transport = createGitHubStockTokenTradeHistoryTransport({
      fetch: fetchImplementation,
    });

    await expect(transport.readCatalog(
      65_536,
      1_048_576,
      1_000,
      new AbortController().signal,
    )).resolves.toMatchObject({
      status: "read",
      value: { assets: [], overflow: true },
    });
  });

  it("selects only uploaded catalog assets", async () => {
    const fetchImplementation: typeof fetch = async (input) => {
      if (String(input).includes("/releases/tags/market-data-catalog")) {
        return jsonResponse({ id: 44 });
      }
      return jsonResponse([{
        name: `root-s2-${"b".repeat(64)}.json.gz`,
        size: 82,
        state: "open",
      }, {
        name: `root-s1-${"a".repeat(64)}.json.gz`,
        size: 81,
        state: "uploaded",
      }]);
    };
    const transport = createGitHubStockTokenTradeHistoryTransport({ fetch: fetchImplementation });

    await expect(transport.readCatalog(4_096, 8_192, 2, new AbortController().signal))
      .resolves.toMatchObject({
        status: "read",
        value: {
          assets: [{ name: `root-s1-${"a".repeat(64)}.json.gz`, bytes: 81 }],
          overflow: false,
        },
      });
  });

  it("reapplies the exact Range after redirects and returns normalized range facts", async () => {
    const ranges: Array<string | null> = [];
    let invocation = 0;
    const fetchImplementation: typeof fetch = async (_input, init) => {
      ranges.push(new Headers(init?.headers).get("range"));
      invocation += 1;
      if (invocation === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://objects.example.test/member" },
        });
      }
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 206,
        headers: {
          "content-range": "bytes 4-6/10",
          "content-length": "3",
        },
      });
    };
    const transport = createGitHubStockTokenTradeHistoryTransport({
      fetch: fetchImplementation,
    });

    await expect(transport.readMember({
      releaseTag: "market-data-2026-08-s1",
      assetName: `data-${"a".repeat(64)}.bin`,
      from: 4,
      until: 7,
      maximumBytes: 8,
    }, new AbortController().signal)).resolves.toMatchObject({
      status: "read",
      value: {
        bytes: new Uint8Array([1, 2, 3]),
        identityEncoding: true,
        range: { from: 4, until: 7, assetBytes: 10 },
      },
    });
    expect(ranges).toEqual(["bytes=4-6", "bytes=4-6"]);
  });

  it("admits exactly five redirects and rejects another or an unsafe target", async () => {
    const redirected = (count: number, location: (index: number) => string): typeof fetch => {
      let invocation = 0;
      return async () => {
        invocation += 1;
        if (invocation <= count) {
          return new Response(null, { status: 302, headers: { location: location(invocation) } });
        }
        return new Response(new Uint8Array([1]), {
          status: 200,
          headers: { "content-length": "1" },
        });
      };
    };
    const five = createGitHubStockTokenTradeHistoryTransport({
      fetch: redirected(5, (index) => `https://objects.example.test/${index}`),
    });
    await expect(five.readRoot("root.json.gz", 1, new AbortController().signal))
      .resolves.toMatchObject({ status: "read" });

    const six = createGitHubStockTokenTradeHistoryTransport({
      fetch: redirected(6, (index) => `https://objects.example.test/${index}`),
    });
    await expect(six.readRoot("root.json.gz", 1, new AbortController().signal))
      .resolves.toEqual({ status: "unavailable" });

    for (const location of ["http://objects.example.test/member", "https://user@example.test/member"]) {
      const unsafe = createGitHubStockTokenTradeHistoryTransport({
        fetch: redirected(1, () => location),
      });
      await expect(unsafe.readRoot("root.json.gz", 1, new AbortController().signal))
        .resolves.toEqual({ status: "unavailable" });
    }
  });

  it("maps GitHub primary and secondary rate limits without reading their bodies", async () => {
    for (const response of [
      new Response(null, { status: 429 }),
      new Response(null, { status: 403, headers: { "x-ratelimit-remaining": "0" } }),
    ]) {
      const transport = createGitHubStockTokenTradeHistoryTransport({ fetch: async () => response });
      await expect(transport.readRoot("root.json.gz", 1, new AbortController().signal))
        .resolves.toEqual({ status: "rate_limited" });
    }
  });

  it("does not replace Range storage with a complete packed-asset response", async () => {
    const transport = createGitHubStockTokenTradeHistoryTransport({
      fetch: async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    });
    await expect(transport.readMember({
      releaseTag: "market-data-2026-08-s1",
      assetName: `data-${"a".repeat(64)}.bin`,
      from: 0,
      until: 3,
      maximumBytes: 8,
    }, new AbortController().signal)).resolves.toEqual({ status: "unavailable" });
  });

  it("reports response capacity before returning bytes", async () => {
    const transport = createGitHubStockTokenTradeHistoryTransport({
      fetch: async () => new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-length": "3" },
      }),
    });
    await expect(transport.readRoot("root.json.gz", 2, new AbortController().signal))
      .resolves.toEqual({ status: "capacity_exceeded" });
  });

  it("retains a provider outcome when discarding an oversized body fails", async () => {
    const cleanupCause = new Error("cleanup failed");
    const response = new Response(new ReadableStream<Uint8Array>({
      cancel() { throw cleanupCause; },
    }), {
      status: 200,
      headers: { "content-length": "3" },
    });
    const transport = createGitHubStockTokenTradeHistoryTransport({ fetch: async () => response });

    const failure = await transport.readRoot(
      "root.json.gz",
      2,
      new AbortController().signal,
    ).then(() => undefined, (error: unknown) => error);
    expect(isStockTokenTradeHistoryProviderCleanupError(failure)).toBe(true);
    expect((failure as StockTokenTradeHistoryProviderCleanupError).primaryFailure)
      .toEqual({ status: "capacity_exceeded" });
    expect((failure as StockTokenTradeHistoryProviderCleanupError).cleanupFailures)
      .toEqual([cleanupCause]);
  });

  it("reports an errored response body as provider unavailability and releases its reader", async () => {
    const failure = new Error("body failed");
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.error(failure); },
    }), { status: 200 });
    const transport = createGitHubStockTokenTradeHistoryTransport({
      fetch: async () => response,
    });

    await expect(transport.readRoot("root.json.gz", 8, new AbortController().signal))
      .resolves.toEqual({ status: "unavailable" });
    const reader = response.body!.getReader();
    reader.releaseLock();
  });

  it("preserves caller abort while releasing a pending response reader", async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    let entered!: () => void;
    const enteredRead = new Promise<void>((resolve) => { entered = resolve; });
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { streamController = controller; },
      pull() { entered(); },
    }), { status: 200 });
    const transport = createGitHubStockTokenTradeHistoryTransport({
      fetch: async (_input, init) => {
        init?.signal?.addEventListener("abort", () => {
          streamController.error(init.signal?.reason);
        }, { once: true });
        return response;
      },
    });
    const controller = new AbortController();
    const reason = new Error("caller stopped");
    const read = transport.readRoot("root.json.gz", 8, controller.signal);
    await enteredRead;
    controller.abort(reason);

    await expect(read).rejects.toBe(reason);
    const reader = response.body!.getReader();
    reader.releaseLock();
  });

  it("cancels an acquired response body when abort wins before reader acquisition", async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      cancel() { cancelled = true; },
    }), { status: 200 });
    const controller = new AbortController();
    const reason = new Error("caller stopped before body admission");
    const transport = createGitHubStockTokenTradeHistoryTransport({
      fetch: async () => {
        controller.abort(reason);
        return response;
      },
    });

    await expect(transport.readRoot("root.json.gz", 8, controller.signal))
      .rejects.toBe(reason);
    expect(cancelled).toBe(true);
  });

  it("bounds catalog responses against the remaining aggregate before reading the next body", async () => {
    const releaseText = JSON.stringify({ id: 43 });
    const pageText = JSON.stringify([{
      name: `root-s1-${"a".repeat(64)}.json.gz`,
      size: 81,
      state: "uploaded",
    }]);
    let pageCancelled = false;
    const fetchImplementation: typeof fetch = async (input) => {
      if (String(input).includes("/releases/tags/market-data-catalog")) {
        return new Response(releaseText, {
          status: 200,
          headers: { "content-length": String(Buffer.byteLength(releaseText)) },
        });
      }
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode(pageText));
          controller.close();
        },
        cancel() { pageCancelled = true; },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-length": String(Buffer.byteLength(pageText)) },
      });
    };
    const transport = createGitHubStockTokenTradeHistoryTransport({
      fetch: fetchImplementation,
    });

    await expect(transport.readCatalog(
      4_096,
      Buffer.byteLength(releaseText) + Buffer.byteLength(pageText) - 1,
      1_000,
      new AbortController().signal,
    )).resolves.toEqual({ status: "capacity_exceeded" });
    expect(pageCancelled).toBe(true);
  });
});
