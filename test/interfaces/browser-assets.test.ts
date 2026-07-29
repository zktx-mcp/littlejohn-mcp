import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { productDisplayName } from "../../src/core/index.js";
import {
  csrfTemplatePlaceholder,
  loadBrowserAssetBundle,
} from "../../src/interfaces/browser-assets.js";
import { browserCsrfMetaName } from "../../src/interfaces/browser-contract.js";

const roots: string[] = [];
const canonicalFavicon = await readFile("src/interfaces/web/favicon.svg", "utf8");

const canonicalHtml = (
  javascriptPath: string,
  stylesheetPaths: readonly string[],
  faviconPath: string,
): string => [
  "<!doctype html>",
  '<html lang="en">',
  "  <head>",
  '    <meta charset="UTF-8" />',
  '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
  `    <meta name="${browserCsrfMetaName}" content="${csrfTemplatePlaceholder}" />`,
  `    <title>${productDisplayName}</title>`,
  `    <link rel="icon" type="image/svg+xml" href="${faviconPath}" />`,
  `    <script type="module" crossorigin src="${javascriptPath}"></script>`,
  ...stylesheetPaths.map((path) =>
    `    <link rel="stylesheet" crossorigin href="${path}">`),
  "  </head>",
  "  <body>",
  '    <div id="root"></div>',
  "  </body>",
  "</html>",
  "",
].join("\n");

const canonicalManifest = (names: Readonly<{
  dynamic: string;
  favicon: string;
  javascript: string;
  stylesheet: string;
}>): Record<string, Record<string, unknown>> => ({
  "../../../node_modules/lightweight-charts/dist/lightweight-charts.production.mjs": {
    file: `assets/${names.dynamic}`,
    name: "lightweight-charts.production",
    src: "../../../node_modules/lightweight-charts/dist/lightweight-charts.production.mjs",
    isDynamicEntry: true,
  },
  "favicon.svg": {
    file: `assets/${names.favicon}`,
    src: "favicon.svg",
  },
  "index.html": {
    file: `assets/${names.javascript}`,
    name: "index",
    src: "index.html",
    isEntry: true,
    dynamicImports: [
      "../../../node_modules/lightweight-charts/dist/lightweight-charts.production.mjs",
    ],
    css: [`assets/${names.stylesheet}`],
    assets: [`assets/${names.favicon}`],
  },
});

interface TestOutput {
  readonly dynamicName: string;
  readonly faviconName: string;
  readonly javascriptName: string;
  readonly manifest: Record<string, Record<string, unknown>>;
  readonly root: string;
  readonly stylesheetName: string;
}

const createOutput = async (input: Readonly<{
  dynamicBody?: string;
  dynamicName?: string;
  faviconName?: string;
  html?: string;
  javascriptBody?: string;
  javascriptName?: string;
  stylesheetBody?: string;
  stylesheetName?: string;
}> = {}): Promise<TestOutput> => {
  const root = await mkdtemp(join(tmpdir(), "littlejohn-web-assets-"));
  roots.push(root);
  await mkdir(join(root, "assets"));
  await mkdir(join(root, ".vite"));
  const names = Object.freeze({
    dynamic: input.dynamicName ?? "chunk-Abcdef12.js",
    favicon: input.faviconName ?? "favicon-Abcdef12.svg",
    javascript: input.javascriptName ?? "index-Abcdef12.js",
    stylesheet: input.stylesheetName ?? "index-Abcdef12.css",
  });
  await writeFile(
    join(root, "assets", names.javascript),
    input.javascriptBody ?? "export{};",
    "utf8",
  );
  await writeFile(
    join(root, "assets", names.dynamic),
    input.dynamicBody ?? "export{};",
    "utf8",
  );
  await writeFile(
    join(root, "assets", names.stylesheet),
    input.stylesheetBody ?? ".panel{}",
    "utf8",
  );
  await writeFile(join(root, "assets", names.favicon), canonicalFavicon, "utf8");
  const manifest = canonicalManifest({
    dynamic: names.dynamic,
    favicon: names.favicon,
    javascript: names.javascript,
    stylesheet: names.stylesheet,
  });
  await writeFile(
    join(root, ".vite", "manifest.json"),
    JSON.stringify(manifest),
    "utf8",
  );
  await writeFile(
    join(root, "index.html"),
    input.html ?? canonicalHtml(
      `/assets/${names.javascript}`,
      [`/assets/${names.stylesheet}`],
      `/assets/${names.favicon}`,
    ),
    "utf8",
  );
  return Object.freeze({
    dynamicName: names.dynamic,
    faviconName: names.favicon,
    javascriptName: names.javascript,
    manifest,
    root,
    stylesheetName: names.stylesheet,
  });
};

const writeManifest = async (
  output: TestOutput,
  manifest: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
): Promise<void> => {
  await writeFile(
    join(output.root, ".vite", "manifest.json"),
    JSON.stringify(manifest),
    "utf8",
  );
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { force: true, recursive: true })));
});

describe("compiled browser asset authority", () => {
  it("keeps the packaged favicon bound to the product identity artwork", () => {
    expect(canonicalFavicon).toContain(`<title>${productDisplayName}</title>`);
    expect(canonicalFavicon).toContain('viewBox="0 0 64 64"');
    expect(canonicalFavicon.match(/<path/gu)).toHaveLength(2);
    expect(canonicalFavicon).not.toMatch(/Stelis|#1565c0/iu);
  });

  it("admits the complete reachable manifest graph and substitutes one canonical CSRF token", async () => {
    const output = await createOutput();
    const bundle = await loadBrowserAssetBundle(output.root);
    const token = Buffer.alloc(32, 4).toString("base64url");

    expect(bundle.paths()).toEqual([
      "/assets/chunk-Abcdef12.js",
      "/assets/favicon-Abcdef12.svg",
      "/assets/index-Abcdef12.css",
      "/assets/index-Abcdef12.js",
    ]);
    expect(bundle.get("/assets/chunk-Abcdef12.js")).toEqual({
      body: "export{};",
      contentType: "text/javascript; charset=utf-8",
    });
    expect(bundle.get("/assets/favicon-Abcdef12.svg")).toEqual({
      body: canonicalFavicon,
      contentType: "image/svg+xml",
    });
    expect(bundle.get("/assets/missing.js")).toBeUndefined();
    const rendered = bundle.renderShell(token);
    expect(rendered).toContain(`name="${browserCsrfMetaName}" content="${token}"`);
    expect(rendered.match(new RegExp(token, "gu"))).toHaveLength(1);
    expect(rendered).not.toContain(csrfTemplatePlaceholder);
    expect(() => bundle.renderShell("not-a-token"))
      .toThrow("Browser CSRF token is invalid.");
  });

  it.each([
    ["an entity-encoded meta refresh", (html: string) => html.replace(
      `    <title>${productDisplayName}</title>`,
      '    <meta http-equiv="re&#102;resh" content="0;url=https://example.invalid">\n' +
      `    <title>${productDisplayName}</title>`,
    )],
    ["an inline script", (html: string) => html.replace(
      `    <title>${productDisplayName}</title>`,
      `    <script>danger()</script>\n    <title>${productDisplayName}</title>`,
    )],
    ["a remote resource", (html: string) => html.replace(
      `    <title>${productDisplayName}</title>`,
      `    <link rel="preload" href="https://example.invalid/a.js">\n` +
      `    <title>${productDisplayName}</title>`,
    )],
    ["a second CSRF placeholder", (html: string) => html.replace(
      `    <title>${productDisplayName}</title>`,
      `    <meta content="${csrfTemplatePlaceholder}">\n` +
      `    <title>${productDisplayName}</title>`,
    )],
    ["a dynamic chunk reference", (html: string) => html.replace(
      "</head>",
      '    <link rel="modulepreload" href="/assets/chunk-Abcdef12.js">\n  </head>',
    )],
  ])("rejects a compiled shell containing %s", async (_name, mutate) => {
    const html = canonicalHtml(
      "/assets/index-Abcdef12.js",
      ["/assets/index-Abcdef12.css"],
      "/assets/favicon-Abcdef12.svg",
    );
    const output = await createOutput({ html: mutate(html) });
    await expect(loadBrowserAssetBundle(output.root))
      .rejects.toThrow(/Compiled browser shell/u);
  });

  it("rejects unsupported output entries, mutable names, and forbidden asset content", async () => {
    const mutable = await createOutput({ javascriptName: "index.js" });
    await expect(loadBrowserAssetBundle(mutable.root))
      .rejects.toThrow("Compiled browser output contains an unsupported asset.");

    const extraRoot = await createOutput();
    await writeFile(join(extraRoot.root, "extra.txt"), "unexpected", "utf8");
    await expect(loadBrowserAssetBundle(extraRoot.root))
      .rejects.toThrow("Compiled browser output contains an unsupported root entry.");

    const sourceMap = await createOutput({
      javascriptBody: "//# sourceMappingURL=index.js.map",
    });
    await expect(loadBrowserAssetBundle(sourceMap.root))
      .rejects.toThrow("Compiled browser output contains an unsupported asset content.");

    const escapedUrl = await createOutput({
      stylesheetBody: String.raw`.panel { background: u\72l(/outside); }`,
    });
    await expect(loadBrowserAssetBundle(escapedUrl.root))
      .rejects.toThrow("Compiled browser output contains an unsupported asset content.");
  });

  it("rejects malformed records, invalid entry roles, and graph disagreement", async () => {
    const unknownField = await createOutput();
    unknownField.manifest["index.html"]!["unknown"] = "value";
    await writeManifest(unknownField, unknownField.manifest);
    await expect(loadBrowserAssetBundle(unknownField.root))
      .rejects.toThrow("invalid record");

    const explicitFalse = await createOutput();
    explicitFalse.manifest["index.html"]!["isDynamicEntry"] = false;
    await writeManifest(explicitFalse, explicitFalse.manifest);
    await expect(loadBrowserAssetBundle(explicitFalse.root))
      .rejects.toThrow("invalid boolean field");

    const missingDynamic = await createOutput();
    missingDynamic.manifest["index.html"]!["dynamicImports"] = ["missing"];
    await writeManifest(missingDynamic, missingDynamic.manifest);
    await expect(loadBrowserAssetBundle(missingDynamic.root))
      .rejects.toThrow("missing record");

    const cycle = await createOutput();
    cycle.manifest[
      "../../../node_modules/lightweight-charts/dist/lightweight-charts.production.mjs"
    ]!["imports"] = ["index.html"];
    await writeManifest(cycle, cycle.manifest);
    await expect(loadBrowserAssetBundle(cycle.root))
      .rejects.toThrow("contains a cycle");

    const duplicate = await createOutput();
    duplicate.manifest["duplicate.ts"] = {
      file: `assets/${duplicate.dynamicName}`,
      src: "duplicate.ts",
    };
    await writeManifest(duplicate, duplicate.manifest);
    await expect(loadBrowserAssetBundle(duplicate.root))
      .rejects.toThrow("duplicate record output");

    const unreachable = await createOutput();
    await writeFile(
      join(unreachable.root, "assets", "chunk-Zyxwv987.js"),
      "export{};",
      "utf8",
    );
    unreachable.manifest["unreachable.ts"] = {
      file: "assets/chunk-Zyxwv987.js",
      src: "unreachable.ts",
    };
    await writeManifest(unreachable, unreachable.manifest);
    await expect(loadBrowserAssetBundle(unreachable.root))
      .rejects.toThrow("unreachable record");

    const unmanifested = await createOutput();
    await writeFile(
      join(unmanifested.root, "assets", "chunk-Zyxwv987.js"),
      "export{};",
      "utf8",
    );
    await expect(loadBrowserAssetBundle(unmanifested.root))
      .rejects.toThrow("manifest and emitted assets disagree");
  });

  it("rejects nested paths, chunk fields on emitted assets, and a second HTML entry", async () => {
    const nested = await createOutput();
    nested.manifest[
      "../../../node_modules/lightweight-charts/dist/lightweight-charts.production.mjs"
    ]!["file"] = "assets/nested/chunk-Abcdef12.js";
    await writeManifest(nested, nested.manifest);
    await expect(loadBrowserAssetBundle(nested.root))
      .rejects.toThrow("invalid record");

    const assetChunkFields = await createOutput();
    assetChunkFields.manifest["favicon.svg"]!["imports"] = ["index.html"];
    await writeManifest(assetChunkFields, assetChunkFields.manifest);
    await expect(loadBrowserAssetBundle(assetChunkFields.root))
      .rejects.toThrow("chunk fields on an emitted asset");

    const secondEntry = await createOutput();
    secondEntry.manifest[
      "../../../node_modules/lightweight-charts/dist/lightweight-charts.production.mjs"
    ]!["isEntry"] = true;
    await writeManifest(secondEntry, secondEntry.manifest);
    await expect(loadBrowserAssetBundle(secondEntry.root))
      .rejects.toThrow(/entry/u);
  });

  it("rejects symbolic links and non-file entries at every served file boundary", async () => {
    const assetLink = await createOutput();
    await symlink(
      assetLink.javascriptName,
      join(assetLink.root, "assets", "alias-Abcdef12.js"),
    );
    await expect(loadBrowserAssetBundle(assetLink.root))
      .rejects.toThrow("unsupported asset");

    const manifestLink = await createOutput();
    await rm(join(manifestLink.root, ".vite", "manifest.json"));
    await symlink(
      "../index.html",
      join(manifestLink.root, ".vite", "manifest.json"),
    );
    await expect(loadBrowserAssetBundle(manifestLink.root))
      .rejects.toThrow("unsupported manifest metadata");

    const assetDirectory = await createOutput();
    await mkdir(join(assetDirectory.root, "assets", "chunk-Zyxwv987.js"));
    await expect(loadBrowserAssetBundle(assetDirectory.root))
      .rejects.toThrow("unsupported asset");
  });

  it("enforces manifest, HTML, individual-asset, aggregate, and record-count limits", async () => {
    const manifest = await createOutput();
    await writeFile(
      join(manifest.root, ".vite", "manifest.json"),
      `{${" ".repeat(65_536)}}`,
      "utf8",
    );
    await expect(loadBrowserAssetBundle(manifest.root))
      .rejects.toThrow("manifest exceeds its admission limit");

    const html = await createOutput();
    await writeFile(
      join(html.root, "index.html"),
      " ".repeat(65_537),
      "utf8",
    );
    await expect(loadBrowserAssetBundle(html.root))
      .rejects.toThrow("shell exceeds its admission limit");

    const asset = await createOutput({
      javascriptBody: " ".repeat(1_048_577),
    });
    await expect(loadBrowserAssetBundle(asset.root))
      .rejects.toThrow("asset exceeds its admission limit");

    const aggregate = await createOutput({
      dynamicBody: " ".repeat(700_000),
      javascriptBody: " ".repeat(700_000),
    });
    await writeFile(
      join(aggregate.root, "assets", "chunk-Zyxwv987.js"),
      " ".repeat(700_000),
      "utf8",
    );
    aggregate.manifest["second-dynamic.ts"] = {
      file: "assets/chunk-Zyxwv987.js",
      src: "second-dynamic.ts",
      isDynamicEntry: true,
    };
    aggregate.manifest["index.html"]!["dynamicImports"] = [
      "../../../node_modules/lightweight-charts/dist/lightweight-charts.production.mjs",
      "second-dynamic.ts",
    ];
    await writeManifest(aggregate, aggregate.manifest);
    await expect(loadBrowserAssetBundle(aggregate.root))
      .rejects.toThrow("aggregate admission limit");

    const recordCount = await createOutput();
    for (let index = 0; index < 62; index += 1) {
      recordCount.manifest[`extra-${index}.ts`] = {
        file: `assets/chunk-${index.toString().padStart(8, "0")}.js`,
        src: `extra-${index}.ts`,
      };
    }
    await writeManifest(recordCount, recordCount.manifest);
    await expect(loadBrowserAssetBundle(recordCount.root))
      .rejects.toThrow("invalid record count");
  });

  it("allows inert URI text in JavaScript that has no loading authority", async () => {
    const output = await createOutput({
      javascriptBody:
        'const diagnostic = "https://example.invalid/inert"; export { diagnostic };',
    });
    await expect(loadBrowserAssetBundle(output.root)).resolves.toBeDefined();
  });
});
