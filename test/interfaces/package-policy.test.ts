import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("browser bundle distribution notices", () => {
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
