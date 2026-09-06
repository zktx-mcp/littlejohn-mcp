import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("bundled interface distribution notices", () => {
  it("retains the complete MCP Apps statement and exact MCP SDK source text", async () => {
    const [installedApps, retainedApps, installedSdk, retainedSdk, notice] = await Promise.all([
      readFile("node_modules/@modelcontextprotocol/ext-apps/LICENSE"),
      readFile("LICENSES/MCP-APPS-LICENSE.txt"),
      readFile("node_modules/@modelcontextprotocol/sdk/LICENSE", "utf8"),
      readFile("LICENSES/MCP-SDK-LICENSE.txt", "utf8"),
      readFile("THIRD_PARTY_NOTICES.txt", "utf8"),
    ]);
    expect(retainedApps).toEqual(installedApps);
    expect(createHash("sha256").update(retainedApps).digest("hex"))
      .toBe("0382b0057770ca05e9c350a50aa3b1c1fea84da0bc81d723bf00b9aa841be58a");
    expect(retainedSdk).toBe(installedSdk);
    expect(notice).toContain("dist/mcp-app/THIRD_PARTY_NOTICES.txt");
    expect(notice).toContain("dist/mcp-app/index.html");
  });

  it("retains the Vite core license section for the emitted preload helper", async () => {
    const [viteLicense, notice] = await Promise.all([
      readFile("node_modules/vite/LICENSE.md", "utf8"),
      readFile("LICENSES/VITE-CORE-LICENSE.txt", "utf8"),
    ]);
    const start = viteLicense.indexOf("MIT License\n");
    const end = viteLicense.indexOf("# Licenses of bundled dependencies");
    if (start < 0 || end <= start) throw new Error("Vite core license section is unavailable.");
    const core = viteLicense.slice(start, end);
    expect(notice).toBe(core);
  });

  it("retains the exact Zod and Noble license sources", async () => {
    const [zod, notice] = await Promise.all([
      readFile("node_modules/zod/LICENSE", "utf8"),
      readFile("LICENSES/ZOD-LICENSE.txt", "utf8"),
    ]);
    expect(notice).toBe(zod);
    expect(await readFile("LICENSES/NOBLE-HASHES-LICENSE.txt"))
      .toEqual(await readFile("node_modules/@noble/hashes/LICENSE"));
  });

  it("retains the reviewed chart closure licenses and required TradingView notice", async () => {
    const [
      installedChart,
      retainedChart,
      retainedFancyCanvas,
      retainedTslib,
      notice,
    ] = await Promise.all([
      readFile("node_modules/lightweight-charts/LICENSE"),
      readFile("LICENSES/lightweight-charts-5.2.1-Apache-2.0.txt"),
      readFile("LICENSES/fancy-canvas-2.1.0-MIT.txt"),
      readFile("LICENSES/lightweight-charts-5.2.1-tslib-0BSD.txt"),
      readFile("LICENSES/lightweight-charts-5.2.1-NOTICE.txt", "utf8"),
    ]);
    expect(retainedChart).toEqual(installedChart);
    expect(createHash("sha256").update(retainedFancyCanvas).digest("hex"))
      .toBe("52d2ba0c8f8f4532bd524358d679693ff3dd9e40c56fe0c0c63061ed0733aa18");
    expect(createHash("sha256").update(retainedTslib).digest("hex"))
      .toBe("210b19e543130388c68654b7497e967119ce17145f66ab7d85688fbd70f08751");
    expect(notice.split(
      "TradingView Lightweight Charts™\n" +
      "Copyright (с) 2025 TradingView, Inc. https://www.tradingview.com/",
    )).toHaveLength(2);
    expect(createHash("sha256").update(notice).digest("hex"))
      .toBe("f76c6afab94884448f0426e30d6e9d555ca7247894cd3484e477d2f87513036e");
  });
});
