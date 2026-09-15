import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { build, rolldownVersion, version as viteVersion } from "vite";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { createMcpAppNotices, mcpAppNoticesTemplate } from "../../../scripts/mcp-app-notices.js";
import config from "../../../vite.mcp-app.config.js";
import {
  createMcpAppResource,
  McpAppPresentationService,
} from "../../../src/interfaces/mcp-app/server.js";
import type { PresentationSnapshotStore } from "../../../src/runtime/presentation-snapshot.js";

const root = resolve(".");
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const normalizeLines = (text: string) => text.replace(/\r\n?/gu, "\n");
const temporaryRoots: string[] = [];
// The build runs in Node; each DOM inspection has its own closed window.
const { JSDOM } = createRequire(import.meta.url)("jsdom");
const windows: { close(): void }[] = [];
const parseHtml = (html: string) => {
  const dom = new JSDOM(html);
  windows.push(dom.window);
  return dom.window.document;
};

const buildApp = async () => {
  let executable = "";
  let style = "";
  let modules: Record<string, { renderedLength: number }> = {};
  const result = await build({
    ...config,
    configFile: false,
    logLevel: "silent",
    plugins: [{
      name: "independent-notice-source-observation",
      enforce: "post",
      generateBundle(_options, bundle) {
        for (const output of Object.values(bundle)) {
          if (output.type === "chunk") {
            executable = output.code.replaceAll("</script", "<\\/script");
            modules = Object.fromEntries(Object.entries(output.modules)
              .map(([id, entry]) => [id, { renderedLength: entry.renderedLength }]));
          } else if (output.fileName.endsWith(".css")) {
            style = String(output.source).replaceAll("</style", "<\\/style");
          }
        }
      },
    }, ...(config.plugins ?? [])],
    build: { ...config.build, write: false, emptyOutDir: false },
  });
  const output = (Array.isArray(result) ? result : [result]);
  const assets = output.flatMap((entry) => "output" in entry ? entry.output : []);
  const html = assets.find((entry) => entry.fileName === "index.html");
  const notice = assets.find((entry) => entry.fileName === "THIRD_PARTY_NOTICES.txt");
  if (html?.type !== "asset" || notice?.type !== "asset") throw new Error("App artifacts missing.");
  return { html: String(html.source), notice: String(notice.source), executable, style, modules,
    paths: assets.map((entry) => entry.fileName).sort() };
};

let app: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => { app = await buildApp(); });
afterEach(async () => {
  for (const window of windows.splice(0)) window.close();
  for (const path of temporaryRoots.splice(0)) await rm(path, { recursive: true, force: true });
});

const fixture = async () => {
  await mkdir(resolve(".WORK/tests"), { recursive: true });
  const directory = await mkdtemp(resolve(".WORK/tests/mcp-app-notices-"));
  temporaryRoots.push(directory);
  const packagePath = resolve(directory, "node_modules/@noble/hashes");
  await mkdir(packagePath, { recursive: true });
  await mkdir(resolve(directory, "LICENSES"));
  const packageManifest = JSON.parse(await readFile("node_modules/@noble/hashes/package.json", "utf8"));
  const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
  await writeFile(resolve(directory, "package.json"), JSON.stringify({
    name: "notice-fixture", version: "1.0.0", dependencies: { "@noble/hashes": packageManifest.version },
  }));
  await writeFile(resolve(directory, "package-lock.json"), JSON.stringify({
    name: "notice-fixture", version: "1.0.0", lockfileVersion: 3,
    packages: { "node_modules/@noble/hashes": lock.packages["node_modules/@noble/hashes"] },
  }));
  await writeFile(resolve(packagePath, "package.json"), JSON.stringify(packageManifest));
  await writeFile(resolve(packagePath, "sha2.js"), "export const fixture = true;\n");
  const license = resolve(directory, "LICENSES/NOBLE-HASHES-LICENSE.txt");
  await writeFile(license, await readFile("node_modules/@noble/hashes/LICENSE"));
  const modules = { [resolve(packagePath, "sha2.js")]: { renderedLength: 1 } };
  return { directory, packagePath, packageManifest, license, modules };
};

interface NoticeSourceExpectation {
  readonly name: string;
  readonly version: string;
  readonly material: string;
}

const readNoticeSourceExpectations = async (): Promise<readonly NoticeSourceExpectation[]> => {
  // Independent source relationships from the reviewed package artifacts.
  // Source preservation is checked separately by package-policy tests and the
  // release artifact audit.
  const materialPaths = new Map<string, readonly string[]>([
    ["@modelcontextprotocol/ext-apps", ["node_modules/@modelcontextprotocol/ext-apps/LICENSE"]],
    ["@modelcontextprotocol/sdk", ["node_modules/@modelcontextprotocol/sdk/LICENSE"]],
    ["@noble/hashes", ["node_modules/@noble/hashes/LICENSE"]],
    ["zod", ["node_modules/zod/LICENSE"]],
    ["lightweight-charts", [
      "LICENSES/lightweight-charts-5.2.1-NOTICE.txt",
      "node_modules/lightweight-charts/LICENSE",
      "LICENSES/lightweight-charts-5.2.1-tslib-0BSD.txt",
    ]],
    ["fancy-canvas", ["LICENSES/fancy-canvas-2.1.0-MIT.txt"]],
    ["vite", ["LICENSES/VITE-CORE-LICENSE.txt"]],
    ["rolldown", ["node_modules/rolldown/LICENSE", "LICENSES/ESBUILD-RUNTIME-LICENSE.txt"]],
  ]);
  return Promise.all([...materialPaths].map(async ([name, paths]) => {
    const manifest = JSON.parse(await readFile(`node_modules/${name}/package.json`, "utf8"));
    expect(manifest.name).toBe(name);
    expect(typeof manifest.version).toBe("string");
    return {
      name,
      version: manifest.version as string,
      material: (await Promise.all(paths.map(async (path) =>
        normalizeLines(await readFile(path, "utf8"))))).join("\n"),
    };
  }));
};

const assertNoticeSources = (
  notice: string,
  expected: readonly NoticeSourceExpectation[],
): void => {
  // License documents contain their own --- separators. Only source identity
  // start lines delimit these blocks; internal license text remains intact.
  const headers = [...notice.matchAll(/^((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)@([^\s]+)$/gmu)];
  expect(headers.map(([identity]) => identity).sort(), "Notice source identities")
    .toEqual(expected.map(({ name, version }) => `${name}@${version}`).sort());
  for (const [index, header] of headers.entries()) {
    const source = expected.find(({ name }) => name === header[1]);
    if (source === undefined) throw new Error("Notice source has no expected material.");
    const next = headers[index + 1];
    const block = notice.slice(header.index + header[0].length + 1, next?.index);
    const materialStart = block.indexOf("\n\n");
    expect(materialStart, `Notice source metadata: ${source.name}`).toBeGreaterThanOrEqual(0);
    const suffix = next === undefined ? "\n" : "\n\n---\n\n";
    expect(block.endsWith(suffix), `Notice source boundary: ${source.name}`).toBe(true);
    expect(block.slice(materialStart + 2, -suffix.length), `Notice source material: ${source.name}`)
      .toBe(source.material);
  }
};

describe("complete App notice carriage", () => {
  it("covers actual npm, virtual and incorporated sources independently of the assembly list", async () => {
    const ids = Object.entries(app.modules).filter(([, item]) => item.renderedLength > 0).map(([id]) => id);
    const expected = await readNoticeSourceExpectations();
    const packageNames = new Set(ids.flatMap((id) => {
      const packagePath = id.split("/node_modules/").at(-1);
      if (packagePath === undefined || packagePath === id) return [];
      return [packagePath.split("/").slice(0, packagePath.startsWith("@") ? 2 : 1).join("/")];
    }));
    expect(ids.filter((id) => id.startsWith("\0")).sort())
      .toEqual(["\0rolldown/runtime.js", "\0vite/preload-helper.js"]);
    expect([...packageNames].sort()).toEqual(expected.map(({ name }) => name)
      .filter((name) => name !== "vite" && name !== "rolldown").sort());
    expect(expected.find(({ name }) => name === "vite")?.version).toBe(viteVersion);
    expect(expected.find(({ name }) => name === "rolldown")?.version).toBe(rolldownVersion);
    assertNoticeSources(app.notice, expected);
    const vite = await readFile("node_modules/vite/LICENSE.md", "utf8");
    const core = vite.slice(vite.indexOf("MIT License\n"), vite.indexOf("# Licenses of bundled dependencies"));
    expect(expected.find(({ name }) => name === "vite")?.material).toBe(core);
    expect(app.notice).toContain("preload helper");
    expect(app.notice).not.toContain("module-preload polyfill");
    expect(app.notice).not.toContain("Portions © 2025 Reown");
  });

  it("rejects false source identities and material associations even when both carriers agree", async () => {
    const expected = await readNoticeSourceExpectations();
    assertNoticeSources(app.notice, expected);
    const noble = expected.find(({ name }) => name === "@noble/hashes")!;
    const zod = expected.find(({ name }) => name === "zod")!;
    const replacements = [
      { original: noble.material, replacement: zod.material },
      { original: zod.material, replacement: noble.material },
    ].map((value) => ({ ...value, index: app.notice.indexOf(value.original) }))
      .sort((left, right) => right.index - left.index);
    let exchanged = app.notice;
    for (const replacement of replacements) {
      expect(replacement.index).toBeGreaterThanOrEqual(0);
      exchanged = exchanged.slice(0, replacement.index) + replacement.replacement +
        exchanged.slice(replacement.index + replacement.original.length);
    }
    const candidates = [
      ...expected.filter(({ name }) => name === "vite" || name === "rolldown").map((source) => ({
        notice: app.notice.replace(`${source.name}@${source.version}\n`, `${source.name}@0.0.0\n`),
        failure: "Notice source identities",
      })),
      { notice: exchanged, failure: "Notice source material:" },
      { notice: app.notice.replace(noble.material, ""), failure: "Notice source material: @noble/hashes" },
    ];
    for (const candidate of candidates) {
      expect(candidate.notice).not.toBe(app.notice);
      const document = parseHtml(app.html);
      const template = document.querySelector("template#third-party-notices");
      template.content.querySelector("pre").textContent = candidate.notice;
      // The DOM carrier is changed through textContent, independently of the
      // production encoder. Carrier equality is only a fixture precondition.
      const decoded = template.content.textContent;
      expect(decoded).toBe(candidate.notice);
      expect(document.querySelectorAll("script")).toHaveLength(1);
      expect(document.querySelector("script").textContent).toBe(app.executable);
      expect(() => assertNoticeSources(decoded, expected)).toThrow(candidate.failure);
    }
  });

  it("embeds the complete companion inertly and leaves executable script and style intact", () => {
    expect(app.paths).toEqual(["THIRD_PARTY_NOTICES.txt", "index.html"]);
    const document = parseHtml(app.html);
    const template = document.querySelector("template#third-party-notices");
    expect(template?.content.textContent).toBe(app.notice);
    expect(document.querySelectorAll("script")).toHaveLength(1);
    expect(document.querySelector("script")?.textContent).toBe(app.executable);
    expect(document.querySelectorAll("style")).toHaveLength(1);
    expect(document.querySelector("style")?.textContent).toBe(app.style);
    expect(document.querySelector("main")?.textContent).toBe("");
    expect(document.body.textContent).not.toContain("MCP App third-party notices");
    expect(document.querySelectorAll("[src],link[href]")).toHaveLength(0);
  });

  it("returns those complete bytes and their hash from the existing resource owner", async () => {
    const resource = createMcpAppResource(app.html);
    const store = new Proxy({} as PresentationSnapshotStore, {
      get() { throw new Error("HTML resource must not read a snapshot."); },
    });
    const response = (await new McpAppPresentationService(store, resource, { read: async () => { throw new Error("Unexpected live Review read in a stored presentation test."); } }, async () => { throw new Error("An immutable result must not read a decision-card reference."); }).readResource(resource.uri));
    expect(response.text).toBe(app.html);
    expect(resource.utf8Bytes).toBe(Buffer.byteLength(app.html));
    expect(resource.uri).toBe(`ui://littlejohn/presentation/${sha256(app.html)}.html`);
  });

  it("produces identical artifacts for the same source inputs", async () => {
    const repeated = await buildApp();
    expect(repeated.html).toBe(app.html);
    expect(repeated.notice).toBe(app.notice);
  });

  it("preserves delimiter and resource-attribute text without creating markup", () => {
    const text = 'Copyright 🧭 & <text> "quoted" \'single\'\n</pre></template><script src="https://example.invalid/a"></script>';
    const html = mcpAppNoticesTemplate(text);
    const document = parseHtml(html);
    expect(document.querySelector("template")?.content.textContent).toBe(text);
    expect(document.querySelectorAll("script,[src],a")).toHaveLength(0);
    expect(/(?:src|href)\s*=\s*["'](?:https?:|\/\/)/iu.test(html)).toBe(false);
  });

  it("rejects a changed source document before producing a notice", async () => {
    const f = await fixture();
    expect(createMcpAppNotices(f.directory, f.modules).text).toContain("Paul Miller");
    await writeFile(f.license, "Another valid UTF-8 license body.\n");
    expect(() => createMcpAppNotices(f.directory, f.modules)).toThrow("differs from its reviewed bytes");
  });

  it("rejects package-name, reviewed-version and lock-version conflicts independently", async () => {
    const f = await fixture();
    await writeFile(resolve(f.packagePath, "package.json"), JSON.stringify({ ...f.packageManifest, name: "another-package" }));
    expect(() => createMcpAppNotices(f.directory, f.modules)).toThrow("package identity conflicts");
    const lockPath = resolve(f.directory, "package-lock.json");
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    lock.packages["node_modules/@noble/hashes"].version = "0.0.0";
    await writeFile(lockPath, JSON.stringify(lock));
    await writeFile(resolve(f.packagePath, "package.json"), JSON.stringify({ ...f.packageManifest, version: "0.0.0" }));
    expect(() => createMcpAppNotices(f.directory, f.modules)).toThrow("package identity conflicts");
    await writeFile(resolve(f.packagePath, "package.json"), JSON.stringify(f.packageManifest));
    expect(() => createMcpAppNotices(f.directory, f.modules)).toThrow("package identity conflicts");
  });

  it("rejects absent source material with every package input still valid", async () => {
    const f = await fixture();
    await rm(f.license);
    expect(() => createMcpAppNotices(f.directory, f.modules)).toThrow();
  });

  it("rejects unreviewed source classes without treating removed code as a contribution", async () => {
    expect(() => createMcpAppNotices(root, { "\0new/helper.js": { renderedLength: 1 } }))
      .toThrow("Unreviewed MCP App virtual source");
    const f = await fixture();
    const foreign = resolve(f.directory, "node_modules/foreign");
    await mkdir(foreign); await writeFile(resolve(foreign, "index.js"), "export const value = 1;");
    await writeFile(resolve(foreign, "package.json"), JSON.stringify({ name: "foreign", version: "1.0.0", license: "MIT" }));
    const lockPath = resolve(f.directory, "package-lock.json");
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    lock.packages["node_modules/foreign"] = { version: "1.0.0", license: "MIT" };
    await writeFile(lockPath, JSON.stringify(lock));
    expect(() => createMcpAppNotices(f.directory, { [resolve(foreign, "index.js")]: { renderedLength: 1 } }))
      .toThrow("Unreviewed MCP App package");
    expect(createMcpAppNotices(f.directory, { ...f.modules, "\0removed/helper.js": { renderedLength: 0 } }).text)
      .toContain("@noble/hashes@");
    expect(() => createMcpAppNotices(f.directory, { [resolve(f.packagePath, "sha2.js")]: { renderedLength: -1 } }))
      .toThrow("rendered module metadata is invalid");
  });
});
