import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import * as runtimePublic from "../../src/runtime/index.js";
import {
  collectProductSourceFiles,
  collectSourceFiles,
  createPackageImportPolicy,
  directCodeExecutionViolations,
  inspectSourceFile,
  loadPackageManifest,
  moduleImportPolicyViolations,
} from "./import-audit.js";

const repositoryRoot = resolve(".");
const sourceRoot = resolve(repositoryRoot, "src");
const coreRoot = resolve("src/core");
const tokenCatalogRoot = resolve(sourceRoot, "token-catalog");
const browserInterfaceRoot = resolve(sourceRoot, "interfaces/web");
const interfaceConsumerRoots = Object.freeze([
  resolve(sourceRoot, "interfaces"),
  resolve(repositoryRoot, "scripts/release"),
]);
const interfaceConsumerEntryPoints = new Set([
  resolve(sourceRoot, "cli.ts"),
]);
const browserCoreConsumers = new Set([
  "interfaces/browser-contract.ts",
  "interfaces/browser-error-response.ts",
  "interfaces/operation-delivery.ts",
  "interfaces/web/app.tsx",
  "interfaces/web/browser-client.ts",
  "interfaces/web/main.tsx",
  "interfaces/web/operation-id.ts",
  "interfaces/web/token-catalog-client.ts",
  "interfaces/web/wallet-dialog-view.ts",
  "runtime/error-definitions.ts",
  "token-catalog/contract-schema.ts",
  "wallet/management-contracts.ts",
  "wallet/operation-contract.ts",
]);
const browserTokenCatalogConsumers = new Set([
  resolve(sourceRoot, "interfaces/browser-error-response.ts"),
]);

const loadPackagePolicy = async () => {
  const [manifest, sourceFiles] = await Promise.all([
    loadPackageManifest(),
    collectProductSourceFiles(repositoryRoot),
  ]);
  return createPackageImportPolicy(manifest, repositoryRoot, sourceFiles);
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

const isWithin = (file: string, directory: string): boolean => {
  const fromDirectory = relative(directory, file);
  return fromDirectory === "" || (!isAbsolute(fromDirectory) && fromDirectory !== ".." &&
    !fromDirectory.startsWith(`..${sep}`));
};

const isInterfaceConsumer = (file: string): boolean =>
  interfaceConsumerEntryPoints.has(file) ||
  interfaceConsumerRoots.some((root) => isWithin(file, root));

const resolvesInsideTokenCatalog = (file: string, specifier: string): string | undefined => {
  if (!specifier.startsWith(".")) return undefined;
  let target: string;
  try { target = fileURLToPath(new URL(specifier, pathToFileURL(file))); }
  catch { return undefined; }
  const fromCatalog = relative(tokenCatalogRoot, target);
  const inside = fromCatalog === "" || (!isAbsolute(fromCatalog) && fromCatalog !== ".." &&
    !fromCatalog.startsWith(`..${sep}`));
  return inside ? fromCatalog.split(sep).join("/") : undefined;
};

describe("runtime architecture boundary", () => {
  it("enforces current package owners without stage-specific exceptions", async () => {
    const policy = await loadPackagePolicy();
    const violations: string[] = [];
    for (const file of await collectProductSourceFiles(repositoryRoot)) {
      const audit = await inspectSourceFile(file);
      violations.push(...moduleImportPolicyViolations(file, audit.moduleImports, policy));
      violations.push(...directCodeExecutionViolations(
        file,
        audit.directCodeExecutions,
        repositoryRoot,
      ));
    }
    expect(violations).toEqual([]);
  });

  it("requires every non-core product consumer to use its exact curated core entry point", async () => {
    const violations: string[] = [];
    for (const file of await collectSourceFiles(sourceRoot)) {
      if (file.startsWith(`${coreRoot}${sep}`)) continue;
      for (const reference of (await inspectSourceFile(file)).moduleImports) {
        if (reference.specifier === undefined) continue;
        const target = resolvesInsideCore(file, reference.specifier);
        if (target !== undefined) {
          const consumer = relative(sourceRoot, file).split(sep).join("/");
          const allowed = browserCoreConsumers.has(consumer)
            ? target === "browser.js"
            : target === "index.js";
          if (!allowed) violations.push(`${consumer}:${reference.specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("requires interface and package consumers to enter the token catalog through their exact public handoff", async () => {
    const violations: string[] = [];
    for (const file of await collectProductSourceFiles(repositoryRoot)) {
      if (!isInterfaceConsumer(file)) continue;
      for (const reference of (await inspectSourceFile(file)).moduleImports) {
        if (reference.specifier === undefined) continue;
        const target = resolvesInsideTokenCatalog(file, reference.specifier);
        const expectedEntryPoint = browserTokenCatalogConsumers.has(file) ||
          isWithin(file, browserInterfaceRoot)
          ? "browser.js"
          : "index.js";
        if (target !== undefined && target !== expectedEntryPoint) {
          violations.push(`${relative(repositoryRoot, file).split(sep).join("/")}:${reference.specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("confines local operation bindings and catalog resolution to their process owner", async () => {
    const allowed = new Set([
      resolve(sourceRoot, "interfaces/identities.ts"),
      resolve(sourceRoot, "interfaces/operation-client.ts"),
    ]);
    const violations: string[] = [];
    for (const file of await collectSourceFiles(sourceRoot)) {
      const source = await readFile(file, "utf8");
      if (!allowed.has(file) && source.includes("resolveLocalOperationIdentity")) {
        violations.push(relative(sourceRoot, file).split(sep).join("/"));
      }
    }
    expect(violations).toEqual([]);

    const publicInterface = await readFile(resolve(sourceRoot, "interfaces/index.ts"), "utf8");
    expect(publicInterface).not.toContain("LocalOperationBinding");
    expect(publicInterface).not.toContain("LocalOperationContract");
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
    ]) expect(Object.hasOwn(runtimePublic, forbidden)).toBe(false);
  });

  it("limits raw authority imports to their declared runtime owners", async () => {
    const allowedCredentialConsumers = new Set([
      "composition.ts",
      "http-owner.ts",
      "http-routing.ts",
      "request-security.ts",
      "source-identity.ts",
    ]);
    const violations: string[] = [];
    for (const file of await collectSourceFiles(resolve("src/runtime"))) {
      const name = relative(resolve("src/runtime"), file).split(sep).join("/");
      for (const reference of (await inspectSourceFile(file)).moduleImports) {
        if (reference.specifier?.endsWith("/control-credential.js") && !allowedCredentialConsumers.has(name)) {
          violations.push(`${name}:control-credential`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps unavailable support values and broad owner bootstrap ports out of the runtime foundation", async () => {
    const support = await readFile(resolve("src/runtime/support-manifest.ts"), "utf8");
    const composition = await readFile(resolve("src/runtime/composition.ts"), "utf8");
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

  it("makes runtime composition consume the complete token catalog application", async () => {
    const composition = await readFile(resolve("src/runtime/composition.ts"), "utf8");
    expect(composition).toContain("createTokenCatalogApplicationFactory");
    expect(composition).not.toContain("new TokenCatalogCoordinator");
    expect(composition).not.toContain("createTokenCatalogApplication({");
    expect(composition).not.toContain("createTokenCatalogConsumerPorts(");
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
      "configuration_mac AS configurationMac",
      "protocol_version AS protocolVersion",
      "process_id AS processId",
      "owner_revision AS ownerRevision",
      "approved_methods_json AS approvedMethodsJson",
      "approved_events_json AS approvedEventsJson",
      "session_count AS sessionCount",
    ]) expect(database).toContain(alias);
  });
});
