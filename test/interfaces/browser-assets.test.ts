import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  csrfTemplatePlaceholder,
  loadBrowserAssetBundle,
} from "../../src/interfaces/browser-assets.js";
import { browserCsrfMetaName } from "../../src/interfaces/browser-contract.js";

const roots: string[] = [];

const createOutput = async (input: {
  readonly html?: string;
  readonly javascriptName?: string;
  readonly javascriptBody?: string;
  readonly stylesheetName?: string;
  readonly stylesheetBody?: string;
} = {}): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "littlejohn-web-assets-"));
  roots.push(root);
  await mkdir(join(root, "assets"));
  const javascriptName = input.javascriptName ?? "index-Abcdef12.js";
  const stylesheetName = input.stylesheetName ?? "index-Abcdef12.css";
  await writeFile(join(root, "assets", javascriptName), input.javascriptBody ?? "export{};", "utf8");
  await writeFile(join(root, "assets", stylesheetName), input.stylesheetBody ?? ".panel{}", "utf8");
  await writeFile(
    join(root, "index.html"),
    input.html ?? canonicalHtml(`/assets/${javascriptName}`, `/assets/${stylesheetName}`),
    "utf8",
  );
  return root;
};

const canonicalHtml = (javascriptPath: string, stylesheetPath: string): string => [
  "<!doctype html>",
  '<html lang="en">',
  "  <head>",
  '    <meta charset="UTF-8" />',
  '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
  `    <meta name="${browserCsrfMetaName}" content="${csrfTemplatePlaceholder}" />`,
  "    <title>Wallet Operation</title>",
  `    <script type="module" crossorigin src="${javascriptPath}"></script>`,
  `    <link rel="stylesheet" crossorigin href="${stylesheetPath}">`,
  "  </head>",
  "  <body>",
  '    <main id="root"></main>',
  "  </body>",
  "</html>",
  "",
].join("\n");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("compiled browser asset authority", () => {
  it("loads one immutable asset graph and substitutes exactly one canonical CSRF token", async () => {
    const root = await createOutput();
    const bundle = await loadBrowserAssetBundle(root);
    const token = Buffer.alloc(32, 4).toString("base64url");

    expect(bundle.paths()).toEqual([
      "/assets/index-Abcdef12.css",
      "/assets/index-Abcdef12.js",
    ]);
    expect(bundle.get("/assets/index-Abcdef12.js")).toEqual({
      body: "export{};",
      contentType: "text/javascript; charset=utf-8",
    });
    expect(bundle.get("/assets/missing.js")).toBeUndefined();
    expect(bundle.renderShell(token)).toContain(`content="${token}"`);
    expect(bundle.renderShell(token)).not.toContain(csrfTemplatePlaceholder);
    expect(() => bundle.renderShell("not-a-token")).toThrow("Browser CSRF token is invalid.");
  });

  it.each([
    ["an entity-encoded meta refresh", (html: string) => html.replace(
      "    <title>Wallet Operation</title>",
      '    <meta http-equiv="re&#102;resh" content="0;url=https://example.invalid">\n' +
      "    <title>Wallet Operation</title>",
    )],
    ["an inline script", (html: string) => html.replace(
      "    <title>Wallet Operation</title>",
      "    <script>danger()</script>\n    <title>Wallet Operation</title>",
    )],
    ["a remote resource", (html: string) => html.replace(
      "    <title>Wallet Operation</title>",
      '    <link rel="preload" href="https://example.invalid/a.js">\n    <title>Wallet Operation</title>',
    )],
    ["a second CSRF placeholder", (html: string) => html.replace(
      "    <title>Wallet Operation</title>",
      `    <meta content="${csrfTemplatePlaceholder}">\n    <title>Wallet Operation</title>`,
    )],
    ["an unknown asset", (html: string) => html.replace(
      "/assets/index-Abcdef12.js",
      "/assets/other-Abcdef12.js",
    )],
  ])("rejects a compiled shell containing %s", async (_name, mutate) => {
    const html = canonicalHtml(
      "/assets/index-Abcdef12.js",
      "/assets/index-Abcdef12.css",
    );
    const root = await createOutput({ html: mutate(html) });
    await expect(loadBrowserAssetBundle(root))
      .rejects.toThrow(/Compiled browser shell/u);
  });

  it("rejects mutable names, unsupported output entries, and forbidden asset content", async () => {
    await expect(loadBrowserAssetBundle(await createOutput({ javascriptName: "index.js" })))
      .rejects.toThrow("Compiled browser output contains an unsupported asset.");

    const extraRoot = await createOutput();
    await writeFile(join(extraRoot, "extra.txt"), "unexpected", "utf8");
    await expect(loadBrowserAssetBundle(extraRoot))
      .rejects.toThrow("Compiled browser output contains an unsupported root entry.");

    const sourceMapAsset = await createOutput({ javascriptBody: "//# sourceMappingURL=index.js.map" });
    await expect(loadBrowserAssetBundle(sourceMapAsset))
      .rejects.toThrow("Compiled browser output contains an unsupported asset content.");

    const escapedUrlAsset = await createOutput({
      stylesheetBody: String.raw`.panel { background: u\72l(/outside); }`,
    });
    await expect(loadBrowserAssetBundle(escapedUrlAsset))
      .rejects.toThrow("Compiled browser output contains an unsupported asset content.");

    const splitUrlAsset = await createOutput({
      stylesheetBody: `.panel { background: u/**/rl(/outside); }`,
    });
    await expect(loadBrowserAssetBundle(splitUrlAsset))
      .rejects.toThrow("Compiled browser output contains an unsupported asset content.");
  });

  it("allows inert URI text in JavaScript that cannot load, navigate, submit, frame, or create a worker", async () => {
    const root = await createOutput({
      javascriptBody: 'const diagnostic = "https://example.invalid/inert"; export { diagnostic };',
    });
    await expect(loadBrowserAssetBundle(root)).resolves.toBeDefined();
  });
});
