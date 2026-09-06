import { readdir, readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import type { Plugin } from "vite";

import { createMcpAppNotices, mcpAppNoticesFileName } from "./mcp-app-notices.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceRoot = resolve(repositoryRoot, "src/interfaces/mcp-app/view");
const forbiddenIdentifiers = new Set([
  "BroadcastChannel",
  "EventSource",
  "Function",
  "SharedWorker",
  "WebSocket",
  "Worker",
  "XMLHttpRequest",
  "eval",
  "fetch",
  "indexedDB",
  "localStorage",
  "sessionStorage",
]);
const allowedPackageImports = new Set([
  "@modelcontextprotocol/ext-apps",
  "@modelcontextprotocol/sdk/shared/protocol.js",
  "@modelcontextprotocol/sdk/types.js",
  "lightweight-charts",
]);

const sourceFiles = async (directory: string): Promise<readonly string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory()
      ? sourceFiles(path)
      : extname(entry.name) === ".ts" ? Promise.resolve([path]) : Promise.resolve([]);
  }));
  return nested.flat().sort();
};

const assertSource = async (path: string): Promise<void> => {
  const text = await readFile(path, "utf8");
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      if (!specifier.startsWith(".") && !allowedPackageImports.has(specifier)) {
        throw new TypeError(`MCP App source imports an undeclared package: ${specifier}`);
      }
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      throw new TypeError("MCP App source cannot use dynamic import.");
    }
    if (ts.isIdentifier(node) && forbiddenIdentifiers.has(node.text)) {
      throw new TypeError(`MCP App source uses a forbidden browser authority: ${node.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
};

const assertBundledJavaScript = (javascript: string): void => {
  const source = ts.createSourceFile(
    "mcp-app-view.js",
    javascript,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      throw new TypeError("MCP App bundle contains a dynamic import.");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
};

export const mcpAppBuildPolicyPlugin = (): Plugin => ({
  name: "littlejohn-mcp-app-build-policy",
  enforce: "post",
  async buildStart() {
    for (const path of await sourceFiles(sourceRoot)) await assertSource(path);
  },
  generateBundle(_options, bundle) {
    const outputs = Object.values(bundle);
    const chunks = outputs.filter((value) => value.type === "chunk");
    const styles = outputs.filter((value) =>
      value.type === "asset" && value.fileName.endsWith(".css"));
    const unexpected = outputs.filter((value) =>
      value.type !== "chunk" &&
      !(value.type === "asset" && value.fileName.endsWith(".css")));
    const entry = chunks.find((chunk) => chunk.isEntry);
    if (
      chunks.length !== 1 || entry === undefined || entry.imports.length !== 0 ||
      styles.length !== 1 || unexpected.length !== 0
    ) throw new TypeError("MCP App build is not one self-contained script and style.");
    assertBundledJavaScript(entry.code);
    const style = styles[0];
    if (style === undefined || style.type !== "asset") {
      throw new TypeError("MCP App style output is unavailable.");
    }
    const styleSource = style.source;
    const css = (typeof styleSource === "string"
      ? styleSource
      : new TextDecoder().decode(styleSource)).replaceAll("</style", "<\\/style");
    const javascript = entry.code.replaceAll("</script", "<\\/script");
    const notices = createMcpAppNotices(repositoryRoot, entry.modules);
    const html = "<!doctype html>\n" +
      "<html lang=\"en\"><head><meta charset=\"utf-8\">" +
      "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
      "<title>Little John</title><style>" + css + "</style></head>" +
      "<body><main id=\"app\" aria-live=\"polite\"></main>" +
      notices.template +
      "<script type=\"module\">" + javascript + "</script></body></html>\n";
    if (/(?:src|href)\s*=\s*["'](?:https?:|\/\/)/iu.test(html)) {
      throw new TypeError("MCP App build contains a network resource reference.");
    }
    for (const key of Object.keys(bundle)) delete bundle[key];
    this.emitFile({ type: "asset", fileName: "index.html", source: html });
    this.emitFile({ type: "asset", fileName: mcpAppNoticesFileName, source: notices.text });
  },
});
