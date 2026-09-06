import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { rolldownVersion, version as viteVersion } from "vite";

export const mcpAppNoticesFileName = "THIRD_PARTY_NOTICES.txt";

interface NoticeSource {
  readonly kind: "package" | "virtual";
  readonly version: string;
  readonly role: string;
  readonly reference: string;
  readonly files: readonly string[];
}

// These digests and the source records below identify reviewed text/artifacts.
// Installed versions are checked against those records and the standard lock;
// this module does not select or resolve a different dependency version.
const sourceDigests = new Map<string, string>([
  ["MCP-APPS-LICENSE.txt", "0382b0057770ca05e9c350a50aa3b1c1fea84da0bc81d723bf00b9aa841be58a"],
  ["MCP-SDK-LICENSE.txt", "5e13dbbc1d120fc2a03cecde7c91424ae2d7de11b63d58ded2f4431e261ee50d"],
  ["NOBLE-HASHES-LICENSE.txt", "4f221aee6e072336700c408c68ab3b96a3fc09f6aebe6f48f1bd99e5ef13faec"],
  ["ZOD-LICENSE.txt", "3f1189b28e3866e0d979968d466b78f813f76827cfdca1fbb124cc0a5c8841f8"],
  ["VITE-CORE-LICENSE.txt", "e01e8b64570c0ebabbac7792ada3e84a4bd80e4f98b0de4dd60db6d69d1a6227"],
  ["ROLLDOWN-LICENSE.txt", "23ecfff35a5a2e80d92142f75228912c3b1abc4b5a8337a821ff4397e2f9f734"],
  ["ESBUILD-RUNTIME-LICENSE.txt", "f2b90afb27a6bc02915e506d60b5271f69a4dcc643b674c83584077c547d71dc"],
  ["fancy-canvas-2.1.0-MIT.txt", "52d2ba0c8f8f4532bd524358d679693ff3dd9e40c56fe0c0c63061ed0733aa18"],
  ["lightweight-charts-5.2.1-Apache-2.0.txt", "70c9d5382506dd184465425c08a99ad9bd6d9ac1313c252968ba0b585e5ef823"],
  ["lightweight-charts-5.2.1-NOTICE.txt", "f76c6afab94884448f0426e30d6e9d555ca7247894cd3484e477d2f87513036e"],
  ["lightweight-charts-5.2.1-tslib-0BSD.txt", "210b19e543130388c68654b7497e967119ce17145f66ab7d85688fbd70f08751"],
]);

const sources = new Map<string, NoticeSource>([
  ["@modelcontextprotocol/ext-apps", {
    kind: "package", version: "1.7.5",
    role: "MCP Apps bridge; complete upstream licensing-transition statement",
    reference: "https://github.com/modelcontextprotocol/ext-apps/tree/v1.7.5",
    files: ["MCP-APPS-LICENSE.txt"],
  }],
  ["@modelcontextprotocol/sdk", {
    kind: "package", version: "1.30.0",
    role: "MCP protocol and schemas", reference: "https://github.com/modelcontextprotocol/typescript-sdk",
    files: ["MCP-SDK-LICENSE.txt"],
  }],
  ["@noble/hashes", {
    kind: "package", version: "2.2.0",
    role: "SHA-256 and Keccak hash implementation", reference: "https://github.com/paulmillr/noble-hashes/tree/2.2.0",
    files: ["NOBLE-HASHES-LICENSE.txt"],
  }],
  ["zod", {
    kind: "package", version: "4.4.3",
    role: "Canonical value validation", reference: "https://github.com/colinhacks/zod",
    files: ["ZOD-LICENSE.txt"],
  }],
  ["lightweight-charts", {
    kind: "package", version: "5.2.1",
    role: "Chart rendering, including retained tslib portions",
    reference: "https://github.com/tradingview/lightweight-charts/tree/v5.2.1",
    files: ["lightweight-charts-5.2.1-NOTICE.txt", "lightweight-charts-5.2.1-Apache-2.0.txt", "lightweight-charts-5.2.1-tslib-0BSD.txt"],
  }],
  ["fancy-canvas", {
    kind: "package", version: "2.1.0",
    role: "Canvas rendering", reference: "https://github.com/tradingview/fancy-canvas/tree/2.1.0",
    files: ["fancy-canvas-2.1.0-MIT.txt"],
  }],
  ["vite", {
    kind: "virtual", version: "8.1.4",
    role: "Build-inserted preload helper; Vite core license section",
    reference: "https://github.com/vitejs/vite/tree/v8.1.4/packages/vite",
    files: ["VITE-CORE-LICENSE.txt"],
  }],
  ["rolldown", {
    kind: "virtual", version: "1.1.5",
    role: "Build-inserted runtime, including esbuild-derived helpers",
    reference: "https://github.com/rolldown/rolldown/tree/v1.1.5/crates/rolldown/src/runtime",
    files: ["ROLLDOWN-LICENSE.txt", "ESBUILD-RUNTIME-LICENSE.txt"],
  }],
]);

const virtualOwners = new Map([
  ["\0vite/preload-helper.js", "vite"],
  ["\0rolldown/runtime.js", "rolldown"],
]);

const decodeText = (bytes: Uint8Array): string => {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  if (text.length === 0 || text.includes("\0")) throw new TypeError("MCP App notice text is invalid.");
  return text;
};

const readObject = (path: string): Record<string, unknown> => {
  const value: unknown = JSON.parse(decodeText(readFileSync(path)));
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("MCP App package identity is invalid.");
  }
  return value as Record<string, unknown>;
};

const within = (root: string, path: string): boolean => {
  const suffix = relative(root, path);
  return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
};

export const mcpAppNoticesTemplate = (text: string): string => {
  if (text.includes("\0") || Buffer.from(text, "utf8").toString("utf8") !== text) {
    throw new TypeError("MCP App notice text is invalid.");
  }
  const escaped = text.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
  return `<template id="third-party-notices"><pre>${escaped}</pre></template>`;
};

export const createMcpAppNotices = (
  repositoryRoot: string,
  modules: Readonly<Record<string, Readonly<{ renderedLength: number }>>>,
): Readonly<{ text: string; template: string }> => {
  const root = realpathSync(repositoryRoot);
  const lock = readObject(resolve(root, "package-lock.json"));
  const lockedPackages = lock["packages"];
  if (lockedPackages === null || typeof lockedPackages !== "object" || Array.isArray(lockedPackages)) {
    throw new TypeError("MCP App dependency lock is invalid.");
  }
  const included = new Map<string, NoticeSource>();
  for (const [id, module] of Object.entries(modules)) {
    if (!Number.isSafeInteger(module.renderedLength) || module.renderedLength < 0) {
      throw new TypeError("MCP App rendered module metadata is invalid.");
    }
    if (module.renderedLength === 0) continue;
    let name: string;
    let packageRoot: string | undefined;
    let version: string | undefined;
    if (id.startsWith("\0")) {
      const owner = virtualOwners.get(id);
      if (owner === undefined) throw new TypeError(`Unreviewed MCP App virtual source: ${id.slice(1)}`);
      name = owner;
      version = name === "vite" ? viteVersion : rolldownVersion;
    } else {
      const normalized = id.replaceAll("\\", "/");
      const marker = "/node_modules/";
      const boundary = normalized.lastIndexOf(marker);
      if (boundary < 0) {
        if (!isAbsolute(id) || !within(resolve(root, "src"), realpathSync(id))) {
          throw new TypeError(`Unreviewed MCP App source: ${id}`);
        }
        continue;
      }
      const segments = normalized.slice(boundary + marker.length).split("/");
      name = segments.slice(0, segments[0]?.startsWith("@") ? 2 : 1).join("/");
      packageRoot = realpathSync(normalized.slice(0, boundary + marker.length) + name);
      if (!within(packageRoot, realpathSync(id))) throw new TypeError("MCP App module escaped its package.");
    }
    const source = sources.get(name);
    if (source === undefined || source.kind !== (id.startsWith("\0") ? "virtual" : "package")) {
      throw new TypeError(`Unreviewed MCP App package: ${name}`);
    }
    if (packageRoot !== undefined) {
      const manifest = readObject(resolve(packageRoot, "package.json"));
      const key = relative(root, packageRoot).split(sep).join("/");
      const locked = Object.getOwnPropertyDescriptor(lockedPackages, key)?.value as unknown;
      if (
        !within(root, packageRoot) || manifest["name"] !== name ||
        typeof manifest["version"] !== "string" ||
        locked === null || typeof locked !== "object" || Array.isArray(locked) ||
        Object.getOwnPropertyDescriptor(locked, "version")?.value !== manifest["version"]
      ) throw new TypeError(`MCP App package identity conflicts with the lock: ${name}`);
      version = manifest["version"];
    }
    if (version !== source.version) {
      throw new TypeError(`MCP App package identity conflicts with its reviewed source: ${name}`);
    }
    included.set(`${name}@${version}`, source);
  }
  const sections = [...included].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([identity, source]) => {
      const texts = source.files.map((file) => {
        const path = resolve(root, "LICENSES", file);
        const bytes = readFileSync(path);
        const text = decodeText(bytes);
        if (createHash("sha256").update(bytes).digest("hex") !== sourceDigests.get(file)) {
          throw new TypeError(`MCP App notice source differs from its reviewed bytes: ${file}`);
        }
        return text.replace(/\r\n?/gu, "\n");
      });
      return `${identity}\n${source.role}\nSource: ${source.reference}\n\n${texts.join("\n")}`;
    });
  const text = "MCP App third-party notices\n\n" +
    "The following software is bundled and minified for Little John.\n" +
    "These notices accompany both the self-contained HTML and its npm package.\n\n" +
    sections.join("\n\n---\n\n") + "\n";
  return Object.freeze({ text, template: mcpAppNoticesTemplate(text) });
};
