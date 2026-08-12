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

  it("includes the exact Zod license for the bundled MCP App parser", async () => {
    const [zod, notice] = await Promise.all([
      readFile("node_modules/zod/LICENSE", "utf8"),
      readFile("THIRD_PARTY_NOTICES.txt", "utf8"),
    ]);
    expect(notice.split(zod.trim())).toHaveLength(2);
    expect(notice).toContain(`Zod\n\n${zod.trim()}\n`);
  });
});
