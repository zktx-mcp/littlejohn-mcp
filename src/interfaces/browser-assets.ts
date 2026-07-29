import { constants } from "node:fs";
import {
  lstat,
  open,
  readdir,
  type FileHandle,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";

import { productDisplayName } from "../core/index.js";
import type { BrowserContentType } from "../runtime/http-boundary.js";
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

interface OpenedFile {
  readonly handle: FileHandle;
  readonly size: number;
}

interface BrowserManifestRecord {
  readonly file: string;
  readonly src: string | undefined;
  readonly name: string | undefined;
  readonly css: readonly string[];
  readonly assets: readonly string[];
  readonly imports: readonly string[];
  readonly dynamicImports: readonly string[];
  readonly isEntry: boolean;
  readonly isDynamicEntry: boolean;
}

interface BrowserManifest {
  readonly records: ReadonlyMap<string, BrowserManifestRecord>;
  readonly entry: BrowserManifestRecord;
}

const manifestByteLimit = 65_536;
const htmlByteLimit = 65_536;
const manifestRecordLimit = 64;
const assetByteLimit = 1_048_576;
const aggregateBrowserOutputByteLimit = 2_097_152;

const hashedAssetPath =
  /^assets\/[a-z0-9][a-z0-9_-]*-[A-Za-z0-9_-]{8,}\.(?:css|js|svg)$/u;
const manifestRecordFields = new Set([
  "assets",
  "css",
  "dynamicImports",
  "file",
  "imports",
  "isDynamicEntry",
  "isEntry",
  "name",
  "src",
]);
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

const fail = (message: string): never => {
  throw new TypeError(message);
};

const ensureRealDirectory = async (path: string): Promise<void> => {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    fail("Compiled browser output contains an unsupported directory.");
  }
};

const openRegularFile = async (
  path: string,
  byteLimit: number,
  errorMessage: string,
): Promise<OpenedFile> => {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > byteLimit) fail(errorMessage);
    return Object.freeze({ handle, size: metadata.size });
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error instanceof TypeError) throw error;
    return fail(errorMessage);
  }
};

const readOpenedFile = async (
  opened: OpenedFile,
  errorMessage: string,
): Promise<string> => {
  try {
    const bytes = await opened.handle.readFile();
    if (bytes.byteLength !== opened.size) fail(errorMessage);
    return utf8Decoder.decode(bytes);
  } catch (error) {
    if (error instanceof TypeError) throw error;
    return fail(errorMessage);
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
};

const exactObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const optionalString = (
  record: Readonly<Record<string, unknown>>,
  field: "name" | "src",
): string | undefined => {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value === "string" && value.length !== 0) return value;
  return fail("Compiled browser manifest contains an invalid string field.");
};

const optionalTrue = (
  record: Readonly<Record<string, unknown>>,
  field: "isEntry" | "isDynamicEntry",
): boolean => {
  const value = record[field];
  if (value === undefined) return false;
  if (value === true) return true;
  return fail("Compiled browser manifest contains an invalid boolean field.");
};

const optionalUniqueStrings = (
  record: Readonly<Record<string, unknown>>,
  field: "assets" | "css" | "dynamicImports" | "imports",
): readonly string[] => {
  const value = record[field];
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) {
    return fail("Compiled browser manifest contains an invalid array field.");
  }
  const items: unknown[] = value;
  if (items.some((item) => typeof item !== "string" || item.length === 0)) {
    fail("Compiled browser manifest contains an invalid array field.");
  }
  const strings = items as string[];
  if (new Set(strings).size !== strings.length) {
    fail("Compiled browser manifest contains an invalid array field.");
  }
  return Object.freeze([...strings]);
};

const parseManifestRecord = (
  key: string,
  value: unknown,
): BrowserManifestRecord => {
  if (!exactObject(value)) {
    return fail("Compiled browser manifest contains an invalid record.");
  }
  const candidate: Record<string, unknown> = value;
  if (Object.keys(candidate).some((field) => !manifestRecordFields.has(field)) ||
    typeof candidate["file"] !== "string" ||
    !hashedAssetPath.test(candidate["file"])) {
    fail("Compiled browser manifest contains an invalid record.");
  }
  const file = candidate["file"];
  if (typeof file !== "string") {
    return fail("Compiled browser manifest contains an invalid record.");
  }
  const record = Object.freeze({
    file,
    src: optionalString(candidate, "src"),
    name: optionalString(candidate, "name"),
    css: optionalUniqueStrings(candidate, "css"),
    assets: optionalUniqueStrings(candidate, "assets"),
    imports: optionalUniqueStrings(candidate, "imports"),
    dynamicImports: optionalUniqueStrings(candidate, "dynamicImports"),
    isEntry: optionalTrue(candidate, "isEntry"),
    isDynamicEntry: optionalTrue(candidate, "isDynamicEntry"),
  });
  if (record.isEntry && record.isDynamicEntry) {
    fail("Compiled browser manifest contains conflicting entry roles.");
  }
  if (record.imports.includes(key) || record.dynamicImports.includes(key) ||
    record.imports.some((dependency) => record.dynamicImports.includes(dependency))) {
    fail("Compiled browser manifest contains an invalid graph edge.");
  }
  if (record.css.some((path) => !hashedAssetPath.test(path) || !path.endsWith(".css")) ||
    record.assets.some((path) => !hashedAssetPath.test(path) || !path.endsWith(".svg"))) {
    fail("Compiled browser manifest contains an invalid emitted asset reference.");
  }
  if (!record.file.endsWith(".js") && (
    record.name !== undefined ||
    record.isEntry ||
    record.isDynamicEntry ||
    record.css.length !== 0 ||
    record.assets.length !== 0 ||
    record.imports.length !== 0 ||
    record.dynamicImports.length !== 0
  )) {
    fail("Compiled browser manifest contains chunk fields on an emitted asset.");
  }
  return record;
};

const visitManifestGraph = (
  key: string,
  records: ReadonlyMap<string, BrowserManifestRecord>,
  outputOwners: ReadonlyMap<string, string>,
  visiting: Set<string>,
  reachable: Set<string>,
): void => {
  if (visiting.has(key)) fail("Compiled browser manifest contains a cycle.");
  if (reachable.has(key)) return;
  const candidate = records.get(key);
  if (candidate === undefined) {
    return fail("Compiled browser manifest contains a missing record.");
  }
  const record: BrowserManifestRecord = candidate;
  visiting.add(key);
  for (const dependency of [...record.imports, ...record.dynamicImports]) {
    visitManifestGraph(dependency, records, outputOwners, visiting, reachable);
  }
  for (const output of [...record.css, ...record.assets]) {
    const owner = outputOwners.get(output);
    if (owner !== undefined) {
      visitManifestGraph(owner, records, outputOwners, visiting, reachable);
    }
  }
  visiting.delete(key);
  reachable.add(key);
};

const parseBrowserManifest = (
  text: string,
  emittedFiles: ReadonlySet<string>,
): BrowserManifest => {
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    return fail("Compiled browser manifest is malformed.");
  }
  if (!exactObject(input)) return fail("Compiled browser manifest is malformed.");
  const manifestObject: Record<string, unknown> = input;
  const entries = Object.entries(manifestObject);
  if (entries.length === 0 || entries.length > manifestRecordLimit) {
    fail("Compiled browser manifest has an invalid record count.");
  }
  const records = new Map<string, BrowserManifestRecord>();
  const outputOwners = new Map<string, string>();
  for (const [key, value] of entries) {
    if (key.length === 0) fail("Compiled browser manifest contains an invalid key.");
    const record = parseManifestRecord(key, value);
    if (outputOwners.has(record.file)) {
      fail("Compiled browser manifest contains duplicate record output.");
    }
    outputOwners.set(record.file, key);
    records.set(key, record);
  }
  const entryCandidate = records.get("index.html");
  if (entryCandidate === undefined) {
    return fail("Compiled browser manifest contains an invalid HTML entry.");
  }
  const entry: BrowserManifestRecord = entryCandidate;
  if (entry.src !== "index.html" ||
    !entry.isEntry ||
    entry.isDynamicEntry ||
    !entry.file.endsWith(".js") ||
    entry.css.length === 0 ||
    [...records.entries()].some(([key, record]) => key !== "index.html" && record.isEntry)) {
    fail("Compiled browser manifest contains an invalid HTML entry.");
  }
  for (const record of records.values()) {
    for (const dependency of [...record.imports, ...record.dynamicImports]) {
      if (!records.has(dependency)) {
        fail("Compiled browser manifest contains a missing record.");
      }
    }
    for (const dependency of record.dynamicImports) {
      if (records.get(dependency)?.isDynamicEntry !== true) {
        fail("Compiled browser manifest contains an invalid dynamic entry.");
      }
    }
  }
  const dynamicTargets = new Set(
    [...records.values()].flatMap((record) => [...record.dynamicImports]),
  );
  if ([...records.entries()].some(([key, record]) =>
    record.isDynamicEntry && !dynamicTargets.has(key))) {
    fail("Compiled browser manifest contains an unreferenced dynamic entry.");
  }
  const reachable = new Set<string>();
  visitManifestGraph("index.html", records, outputOwners, new Set(), reachable);
  if (reachable.size !== records.size) {
    fail("Compiled browser manifest contains an unreachable record.");
  }
  const declaredOutputs = new Set<string>();
  for (const record of records.values()) {
    declaredOutputs.add(record.file);
    record.css.forEach((path) => declaredOutputs.add(path));
    record.assets.forEach((path) => declaredOutputs.add(path));
  }
  if (declaredOutputs.size !== emittedFiles.size ||
    [...declaredOutputs].some((path) => !emittedFiles.has(path))) {
    fail("Compiled browser manifest and emitted assets disagree.");
  }
  const favicons = [...declaredOutputs].filter((path) => path.endsWith(".svg"));
  const faviconPath = favicons.at(0);
  if (favicons.length !== 1 ||
    entry.assets.length !== 1 ||
    entry.assets.at(0) !== faviconPath ||
    faviconPath === undefined ||
    outputOwners.get(faviconPath) !== "favicon.svg" ||
    records.get("favicon.svg")?.src !== "favicon.svg") {
    fail("Compiled browser manifest contains an invalid favicon.");
  }
  return Object.freeze({
    records,
    entry,
  });
};

const validateAssetBody = (name: string, body: string): void => {
  if (browserAssetContentViolation(name, body) !== undefined) {
    fail("Compiled browser output contains an unsupported asset content.");
  }
};

const csrfMetaLine =
  `    <meta name="${browserCsrfMetaName}" content="${csrfTemplatePlaceholder}" />`;

const compiledShell = (
  javascriptPath: string,
  stylesheetPaths: readonly string[],
  faviconPath: string,
): string => [
  "<!doctype html>",
  '<html lang="en">',
  "  <head>",
  '    <meta charset="UTF-8" />',
  '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
  csrfMetaLine,
  `    <title>${productDisplayName}</title>`,
  `    <link rel="icon" type="image/svg+xml" href="/${faviconPath}" />`,
  `    <script type="module" crossorigin src="/${javascriptPath}"></script>`,
  ...stylesheetPaths.map((path) =>
    `    <link rel="stylesheet" crossorigin href="/${path}">`),
  "  </head>",
  "  <body>",
  '    <div id="root"></div>',
  "  </body>",
  "</html>",
  "",
].join("\n");

const contentTypeFor = (path: string): BrowserContentType =>
  path.endsWith(".css")
    ? "text/css; charset=utf-8"
    : path.endsWith(".js")
      ? "text/javascript; charset=utf-8"
      : "image/svg+xml";

export const loadBrowserAssetBundle = async (
  webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "web"),
): Promise<BrowserAssetBundle> => {
  await ensureRealDirectory(webRoot);
  const rootEntries = await readdir(webRoot, { withFileTypes: true });
  if (rootEntries.length !== 3 ||
    !rootEntries.some((entry) => entry.name === "index.html" && entry.isFile() && !entry.isSymbolicLink()) ||
    !rootEntries.some((entry) => entry.name === "assets" && entry.isDirectory() && !entry.isSymbolicLink()) ||
    !rootEntries.some((entry) => entry.name === ".vite" && entry.isDirectory() && !entry.isSymbolicLink())) {
    fail("Compiled browser output contains an unsupported root entry.");
  }

  const assetsRoot = resolve(webRoot, "assets");
  const metadataRoot = resolve(webRoot, ".vite");
  await ensureRealDirectory(assetsRoot);
  await ensureRealDirectory(metadataRoot);
  const metadataEntries = await readdir(metadataRoot, { withFileTypes: true });
  if (metadataEntries.length !== 1 ||
    metadataEntries.at(0)?.name !== "manifest.json" ||
    metadataEntries.at(0)?.isFile() !== true ||
    metadataEntries.at(0)?.isSymbolicLink() === true) {
    fail("Compiled browser output contains unsupported manifest metadata.");
  }
  const assetEntries = await readdir(assetsRoot, { withFileTypes: true });
  if (assetEntries.length === 0 ||
    assetEntries.some((entry) =>
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      !hashedAssetPath.test(`assets/${entry.name}`))) {
    fail("Compiled browser output contains an unsupported asset.");
  }
  const emittedFiles = new Set(assetEntries.map((entry) => `assets/${entry.name}`));

  const manifestFile = await openRegularFile(
    resolve(metadataRoot, "manifest.json"),
    manifestByteLimit,
    "Compiled browser manifest exceeds its admission limit.",
  );
  const manifestText = await readOpenedFile(
    manifestFile,
    "Compiled browser manifest changed during admission.",
  );
  const manifest = parseBrowserManifest(manifestText, emittedFiles);

  const htmlFile = await openRegularFile(
    resolve(webRoot, "index.html"),
    htmlByteLimit,
    "Compiled browser shell exceeds its admission limit.",
  );
  const html = await readOpenedFile(
    htmlFile,
    "Compiled browser shell changed during admission.",
  );
  const faviconPath = manifest.entry.assets.at(0);
  if (faviconPath === undefined ||
    html !== compiledShell(manifest.entry.file, manifest.entry.css, faviconPath)) {
    fail("Compiled browser shell violates its static asset contract.");
  }

  const openedAssets = new Map<string, OpenedFile>();
  try {
    for (const entry of assetEntries) {
      openedAssets.set(
        `assets/${entry.name}`,
        await openRegularFile(
          resolve(assetsRoot, entry.name),
          assetByteLimit,
          "Compiled browser asset exceeds its admission limit.",
        ),
      );
    }
    const aggregateSize = htmlFile.size +
      [...openedAssets.values()].reduce((total, file) => total + file.size, 0);
    if (aggregateSize > aggregateBrowserOutputByteLimit) {
      fail("Compiled browser output exceeds its aggregate admission limit.");
    }
    const assets = new Map<string, BrowserAsset>();
    for (const [relativePath, opened] of openedAssets) {
      const body = await readOpenedFile(
        opened,
        "Compiled browser asset changed during admission.",
      );
      openedAssets.delete(relativePath);
      validateAssetBody(relativePath, body);
      assets.set(`/${relativePath}`, Object.freeze({
        body,
        contentType: contentTypeFor(relativePath),
      }));
    }
    const paths = Object.freeze([...assets.keys()].sort());
    return Object.freeze({
      renderShell: (csrfToken: string): string => {
        let canonicalToken: string;
        try {
          canonicalToken = parseBrowserCsrfToken(csrfToken);
        } catch {
          throw new TypeError("Browser CSRF token is invalid.");
        }
        const rendered = html.replace(csrfTemplatePlaceholder, canonicalToken);
        if (rendered.includes(csrfTemplatePlaceholder)) {
          throw new TypeError("Browser shell substitution is incomplete.");
        }
        return rendered;
      },
      get: (path: string): BrowserAsset | undefined => assets.get(path),
      paths: (): readonly string[] => paths,
    });
  } finally {
    await Promise.all(
      [...openedAssets.values()].map((opened) =>
        opened.handle.close().catch(() => undefined)),
    );
  }
};
