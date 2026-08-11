import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("bundled interface distribution notices", () => {
  it("retains the exact MCP Apps license and bundled MCP SDK notice", async () => {
    const [installedApps, retainedApps, installedSdk, notice] = await Promise.all([
      readFile("node_modules/@modelcontextprotocol/ext-apps/LICENSE"),
      readFile("LICENSES/MCP-APPS-LICENSE.txt"),
      readFile("node_modules/@modelcontextprotocol/sdk/LICENSE", "utf8"),
      readFile("THIRD_PARTY_NOTICES.txt", "utf8"),
    ]);
    expect(retainedApps).toEqual(installedApps);
    expect(createHash("sha256").update(retainedApps).digest("hex"))
      .toBe("0382b0057770ca05e9c350a50aa3b1c1fea84da0bc81d723bf00b9aa841be58a");
    expect(notice.split("Model Context Protocol Apps")).toHaveLength(2);
    expect(notice).toContain("LICENSES/MCP-APPS-LICENSE.txt");
    expect(notice.split(installedSdk.trim())).toHaveLength(2);
  });

  it("retains the exact Lightweight Charts closure licenses and official notice", async () => {
    const [installed, retained, fancyCanvas, notice] = await Promise.all([
      readFile("node_modules/lightweight-charts/LICENSE"),
      readFile("LICENSES/LIGHTWEIGHT-CHARTS-LICENSE.txt"),
      readFile("LICENSES/FANCY-CANVAS-LICENSE.txt"),
      readFile("THIRD_PARTY_NOTICES.txt", "utf8"),
    ]);
    const officialNotice =
      "TradingView Lightweight Charts™\n" +
      "Copyright (с) 2025 TradingView, Inc. https://www.tradingview.com/";
    expect(retained).toEqual(installed);
    expect(createHash("sha256").update(retained).digest("hex"))
      .toBe("70c9d5382506dd184465425c08a99ad9bd6d9ac1313c252968ba0b585e5ef823");
    expect(createHash("sha256").update(fancyCanvas).digest("hex"))
      .toBe("52d2ba0c8f8f4532bd524358d679693ff3dd9e40c56fe0c0c63061ed0733aa18");
    expect(notice.split(officialNotice)).toHaveLength(2);
    expect(notice).toContain("LICENSES/LIGHTWEIGHT-CHARTS-LICENSE.txt");
    expect(notice).toContain("LICENSES/FANCY-CANVAS-LICENSE.txt");
  });

  it("retains the exact pinned Lucide and Feather license artifact", async () => {
    const [installed, retained, notice] = await Promise.all([
      readFile("node_modules/lucide-react/LICENSE"),
      readFile("LICENSES/LUCIDE-LICENSE.txt"),
      readFile("THIRD_PARTY_NOTICES.txt", "utf8"),
    ]);
    expect(retained).toEqual(installed);
    expect(notice).toContain("Lucide (React icons)");
    expect(notice).toContain("LICENSES/LUCIDE-LICENSE.txt");
  });

  it("includes the exact shared React license once for React, React DOM, and Scheduler", async () => {
    const [react, reactDom, scheduler, notice] = await Promise.all([
      readFile("node_modules/react/LICENSE", "utf8"),
      readFile("node_modules/react-dom/LICENSE", "utf8"),
      readFile("node_modules/scheduler/LICENSE", "utf8"),
      readFile("THIRD_PARTY_NOTICES.txt", "utf8"),
    ]);
    expect(reactDom).toBe(react);
    expect(scheduler).toBe(react);
    expect(notice.split(react.trim())).toHaveLength(2);
    expect(notice).toContain(`React, React DOM, and Scheduler\n\n${react.trim()}\n`);
  });

  it("includes the exact Vite core MIT license used by the module-preload polyfill", async () => {
    const [viteLicense, notice] = await Promise.all([
      readFile("node_modules/vite/LICENSE.md", "utf8"),
      readFile("THIRD_PARTY_NOTICES.txt", "utf8"),
    ]);
    const core = viteLicense.match(/MIT License\n\nCopyright \(c\) 2019-present[\s\S]*?(?=\n# Licenses of bundled dependencies)/u)?.[0];
    if (core === undefined) throw new Error("Vite core license section is unavailable.");
    expect(notice.split(core.trim())).toHaveLength(2);
    expect(notice).toContain(`Vite module-preload polyfill\n\n${core.trim()}\n`);
  });

  it("includes the exact Zod license for the bundled browser parser", async () => {
    const [zod, notice] = await Promise.all([
      readFile("node_modules/zod/LICENSE", "utf8"),
      readFile("THIRD_PARTY_NOTICES.txt", "utf8"),
    ]);
    expect(notice.split(zod.trim())).toHaveLength(2);
    expect(notice).toContain(`Zod\n\n${zod.trim()}\n`);
  });
});
