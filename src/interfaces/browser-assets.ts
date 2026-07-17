import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { productDisplayName } from "../core/index.js";
import type { BrowserContentType } from "../runtime/index.js";
import { browserAssetContentViolation } from "./browser-asset-policy.js";
import {
  browserCsrfMetaName,
  parseBrowserCsrfToken,
} from "./browser-contract.js";

export const csrfTemplatePlaceholder = "__LITTLEJOHN_CSRF_TOKEN__";

export interface BrowserAsset {
  readonly body: string;
  readonly contentType: BrowserContentType;
}

export interface BrowserAssetBundle {
  renderShell(csrfToken: string): string;
  get(path: string): BrowserAsset | undefined;
  paths(): readonly string[];
}

const hashedAssetName = /^[a-z0-9][a-z0-9_-]*-[A-Za-z0-9_-]{8,}\.(?:css|js|svg)$/;

const validateAssetBody = (name: string, body: string): void => {
  if (browserAssetContentViolation(name, body) !== undefined) {
    throw new TypeError("Compiled browser output contains an unsupported asset content.");
  }
};

const csrfMetaLine =
  `    <meta name="${browserCsrfMetaName}" content="${csrfTemplatePlaceholder}" />`;

const compiledShell = (
  javascriptPath: string,
  stylesheetPath: string,
  faviconPath: string,
): string => [
  "<!doctype html>",
  '<html lang="en">',
  "  <head>",
  '    <meta charset="UTF-8" />',
  '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
  csrfMetaLine,
  `    <title>${productDisplayName}</title>`,
  `    <link rel="icon" type="image/svg+xml" href="${faviconPath}" />`,
  `    <script type="module" crossorigin src="${javascriptPath}"></script>`,
  `    <link rel="stylesheet" crossorigin href="${stylesheetPath}">`,
  "  </head>",
  "  <body>",
  '    <main id="root"></main>',
  "  </body>",
  "</html>",
  "",
].join("\n");

const validateHtml = (html: string, assets: ReadonlyMap<string, BrowserAsset>): void => {
  const paths = [...assets.keys()];
  const javascript = paths.filter((path) => path.endsWith(".js"));
  const stylesheets = paths.filter((path) => path.endsWith(".css"));
  const favicons = paths.filter((path) => path.endsWith(".svg"));
  if (javascript.length !== 1 || stylesheets.length !== 1 || favicons.length !== 1 ||
    html !== compiledShell(
      javascript[0] as string,
      stylesheets[0] as string,
      favicons[0] as string,
    )) {
    throw new TypeError("Compiled browser shell violates its static asset contract.");
  }
};

export const loadBrowserAssetBundle = async (
  webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "web"),
): Promise<BrowserAssetBundle> => {
  const rootEntries = await readdir(webRoot, { withFileTypes: true });
  if (rootEntries.length !== 2 ||
    !rootEntries.some((entry) => entry.isFile() && entry.name === "index.html") ||
    !rootEntries.some((entry) => entry.isDirectory() && entry.name === "assets")) {
    throw new TypeError("Compiled browser output contains an unsupported root entry.");
  }

  const assetEntries = await readdir(resolve(webRoot, "assets"), { withFileTypes: true });
  if (assetEntries.length === 0 || assetEntries.some((entry) => !entry.isFile() || !hashedAssetName.test(entry.name))) {
    throw new TypeError("Compiled browser output contains an unsupported asset.");
  }
  const assets = new Map<string, BrowserAsset>();
  for (const entry of assetEntries) {
    const path = `/assets/${entry.name}`;
    const contentType: BrowserContentType = entry.name.endsWith(".css")
      ? "text/css; charset=utf-8"
      : entry.name.endsWith(".js")
        ? "text/javascript; charset=utf-8"
        : "image/svg+xml";
    const body = await readFile(resolve(webRoot, "assets", entry.name), "utf8");
    validateAssetBody(entry.name, body);
    assets.set(path, Object.freeze({
      body,
      contentType,
    }));
  }
  const html = await readFile(resolve(webRoot, "index.html"), "utf8");
  validateHtml(html, assets);
  const paths = Object.freeze([...assets.keys()].sort());
  const javascriptPath = paths.find((path) => path.endsWith(".js"));
  const stylesheetPath = paths.find((path) => path.endsWith(".css"));
  if (javascriptPath === undefined || stylesheetPath === undefined) {
    throw new TypeError("Compiled browser shell asset identity is incomplete.");
  }
  return Object.freeze({
    renderShell: (csrfToken: string): string => {
      let canonicalToken;
      try { canonicalToken = parseBrowserCsrfToken(csrfToken); }
      catch { throw new TypeError("Browser CSRF token is invalid."); }
      const rendered = html.replace(csrfTemplatePlaceholder, canonicalToken);
      if (rendered.includes(csrfTemplatePlaceholder)) throw new TypeError("Browser shell substitution is incomplete.");
      return rendered;
    },
    get: (path: string): BrowserAsset | undefined => assets.get(path),
    paths: (): readonly string[] => paths,
  });
};
