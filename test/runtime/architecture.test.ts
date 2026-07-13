import { readFile, readdir } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import * as runtimePublic from "../../src/runtime/index.js";

const sourceRoot = resolve("src");
const coreRoot = resolve("src/core");
const prohibitedPackages = ["@walletconnect/", "viem", "@modelcontextprotocol/", "react", "qrcode"];

const collectTypeScript = async (directory: string): Promise<string[]> => {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectTypeScript(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
};

const moduleSpecifiers = (source: string, file: string): readonly { readonly kind: string; readonly value?: string }[] => {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const specifiers: { kind: string; value?: string }[] = [];
  const record = (kind: string, expression: ts.Expression | undefined): void => {
    if (expression !== undefined && ts.isStringLiteralLike(expression)) specifiers.push({ kind, value: expression.text });
    else specifiers.push({ kind });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined) record("module", node.moduleSpecifier);
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) record("dynamic_import", node.arguments[0]);
      if (ts.isIdentifier(node.expression) && node.expression.text === "require") record("require", node.arguments[0]);
      if (ts.isIdentifier(node.expression) && (node.expression.text === "eval" || node.expression.text === "Function")) {
        specifiers.push({ kind: `loader:${node.expression.text}` });
      }
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "getBuiltinModule") {
        specifiers.push({ kind: "loader:getBuiltinModule" });
      }
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Function") {
      specifiers.push({ kind: "loader:Function" });
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return specifiers;
};

const resolvesInsideCore = (file: string, specifier: string): string | undefined => {
  if (!specifier.startsWith(".")) return undefined;
  let target: string;
  try { target = fileURLToPath(new URL(specifier, pathToFileURL(file))); }
  catch { return "invalid"; }
  const fromCore = relative(coreRoot, target);
  const inside = fromCore === "" || (!isAbsolute(fromCore) && fromCore !== ".." && !fromCore.startsWith(`..${sep}`));
  return inside ? fromCore.split(sep).join("/") : undefined;
};

describe("WU2 architecture boundary", () => {
  it("contains no early WalletConnect, RPC SDK, MCP, QR, React, or dynamic-loader implementation", async () => {
    const violations: string[] = [];
    for (const file of await collectTypeScript(sourceRoot)) {
      for (const specifier of moduleSpecifiers(await readFile(file, "utf8"), file)) {
        if (specifier.kind.startsWith("loader:") ||
          ((specifier.kind === "dynamic_import" || specifier.kind === "require") && specifier.value === undefined)) {
          violations.push(`${relative(sourceRoot, file)}:${specifier.kind}:non_literal`);
        }
        const value = specifier.value;
        if (value !== undefined && prohibitedPackages.some((name) =>
          value === name || value.startsWith(name))) {
          violations.push(`${relative(sourceRoot, file)}:${value}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("requires every non-core product consumer to use the frozen curated core entry point", async () => {
    const violations: string[] = [];
    for (const file of await collectTypeScript(sourceRoot)) {
      if (file.startsWith(`${coreRoot}${sep}`)) continue;
      for (const specifier of moduleSpecifiers(await readFile(file, "utf8"), file)) {
        if (specifier.value === undefined) continue;
        const target = resolvesInsideCore(file, specifier.value);
        if (target !== undefined && target !== "index.js") {
          violations.push(`${relative(sourceRoot, file)}:${specifier.value}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps credential, database, owner, and route construction out of the public runtime entry point", async () => {
    const index = await readFile(resolve("src/runtime/index.ts"), "utf8");
    const parsed = ts.createSourceFile("index.ts", index, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const wildcards: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isExportDeclaration(node) && node.exportClause === undefined) {
        wildcards.push(node.moduleSpecifier?.getText(parsed) ?? "local");
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);
    expect(wildcards).toEqual([]);
    for (const forbidden of [
      "ProductDatabase",
      "FixedHttpOwner",
      "loadOrCreateControlCredential",
      "createRuntimeRouteRegistry",
      "LocalControlCredentialAuthority",
      "ControlCredentialVerifier",
      "readConfiguredRpcEndpoint",
    ]) expect(Object.hasOwn(runtimePublic, forbidden)).toBe(false);
  });

  it("limits raw authority imports to their declared WU2 owners", async () => {
    const allowedCredentialConsumers = new Set([
      "composition.ts",
      "http-owner.ts",
      "http-routing.ts",
      "request-security.ts",
      "source-identity.ts",
    ]);
    const violations: string[] = [];
    for (const file of await collectTypeScript(resolve("src/runtime"))) {
      const name = relative(resolve("src/runtime"), file).split(sep).join("/");
      for (const specifier of moduleSpecifiers(await readFile(file, "utf8"), file)) {
        if (specifier.value?.endsWith("/control-credential.js") && !allowedCredentialConsumers.has(name)) {
          violations.push(`${name}:control-credential`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps future support values and broad owner bootstrap ports out of WU2", async () => {
    const support = await readFile(resolve("src/runtime/support-manifest.ts"), "utf8");
    const composition = await readFile(resolve("src/runtime/composition.ts"), "utf8");
    expect(support).not.toMatch(/\bWU[3-5]\b/);
    expect(support).not.toContain("walletAvailable");
    expect(support).not.toContain("readAvailable");
    expect(support).not.toContain("extendRuntimeSupportManifest");
    expect(composition).not.toContain("ownerApplicationFactory");
    expect(composition).not.toContain("sdkStoreDirectory");
    for (const scopedAuthority of [
      "extendWalletRuntimeSupportManifest",
      "extendChainRuntimeSupportManifest",
      "extendInterfaceRuntimeSupportManifest",
    ]) expect(Object.hasOwn(runtimePublic, scopedAuthority)).toBe(true);
  });

  it("confines SQLite snake-case row names to SQL aliases at the database adapter", async () => {
    const files = [resolve("src/runtime/database.ts"), resolve("src/runtime/wallet-connection-storage.ts")];
    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const visit = (node: ts.Node): void => {
        const record = (name: ts.PropertyName | undefined): void => {
          if (name !== undefined && ts.isIdentifier(name) && /^[a-z][a-z0-9]*_[a-z0-9_]+$/.test(name.text)) {
            violations.push(`${relative(sourceRoot, file)}:${name.text}`);
          }
        };
        if (ts.isPropertySignature(node) || ts.isPropertyAssignment(node) || ts.isMethodSignature(node)) {
          record(node.name);
        } else if (ts.isPropertyAccessExpression(node) && /^[a-z][a-z0-9]*_[a-z0-9_]+$/.test(node.name.text)) {
          violations.push(`${relative(sourceRoot, file)}:${node.name.text}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(parsed);
    }
    expect(violations).toEqual([]);

    const database = await readFile(resolve("src/runtime/database.ts"), "utf8");
    for (const alias of [
      "profile_id AS profileId",
      "owner_instance_id AS ownerInstanceId",
      "protocol_version AS protocolVersion",
      "process_id AS processId",
      "owner_revision AS ownerRevision",
      "approved_methods_json AS approvedMethodsJson",
      "approved_events_json AS approvedEventsJson",
      "eligible_session_count AS eligibleSessionCount",
    ]) expect(database).toContain(alias);
  });
});
