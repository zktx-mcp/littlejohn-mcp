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
  "account-assets/browser.ts",
  "account-assets/contracts.ts",
  "account-assets/error-registry.ts",
  "account-assets/http-contract.ts",
  "account-assets/view.ts",
  "interfaces/browser-contract.ts",
  "interfaces/browser-error-response.ts",
  "interfaces/operation-delivery.ts",
  "interfaces/reference-market-delivery.ts",
  "interfaces/web/reference-market-client.ts",
  "interfaces/web/reference-market-view.tsx",
  "interfaces/web/app.tsx",
  "interfaces/web/browser-client.ts",
  "interfaces/web/main.tsx",
  "interfaces/web/operation-id.ts",
  "interfaces/web/token-catalog-client.ts",
  "interfaces/web/wallet-dialog-view.ts",
  "runtime/error-definitions.ts",
  "market-portfolio/contracts.ts",
  "token-catalog/contract-schema.ts",
  "wallet/management-contracts.ts",
  "wallet/operation-contract.ts",
]);
const browserTokenCatalogConsumers = new Set([
  resolve(sourceRoot, "interfaces/browser-error-response.ts"),
]);
const runtimeEntryPoint = resolve(sourceRoot, "runtime/index.ts");
const runtimeComposition = resolve(sourceRoot, "runtime/composition.ts");

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

const resolveSourceModule = (file: string, specifier: string): string | undefined => {
  if (!specifier.startsWith(".")) return undefined;
  try {
    const target = fileURLToPath(new URL(specifier, pathToFileURL(file)));
    return target.endsWith(".js") ? `${target.slice(0, -3)}.ts` : target;
  } catch {
    return undefined;
  }
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

  it("keeps feature modules out of the runtime entry point and composition implementation", async () => {
    const violations: string[] = [];
    for (const file of await collectSourceFiles(sourceRoot)) {
      const name = relative(sourceRoot, file).split(sep).join("/");
      for (const reference of (await inspectSourceFile(file)).moduleImports) {
        if (reference.specifier === undefined) continue;
        const target = resolveSourceModule(file, reference.specifier);
        if (target === runtimeEntryPoint && file !== resolve(sourceRoot, "cli.ts")) {
          violations.push(`${name}:runtime-entry`);
        }
        if (target === runtimeComposition && file !== runtimeEntryPoint) {
          violations.push(`${name}:runtime-composition`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps the product chain literal in its single code owner and derives its numeric form", async () => {
    const productChainLiteralOwners: string[] = [];
    const productChainNumericLiteralOwners: string[] = [];
    for (const file of await collectSourceFiles(sourceRoot)) {
      const name = relative(sourceRoot, file).split(sep).join("/");
      const source = await readFile(file, "utf8");
      const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (ts.isStringLiteralLike(node) && node.text === "eip155:4663") {
          productChainLiteralOwners.push(name);
        }
        if (ts.isNumericLiteral(node) && node.text === "4663") {
          productChainNumericLiteralOwners.push(name);
        }
        ts.forEachChild(node, visit);
      };
      visit(parsed);
    }
    expect([...new Set(productChainLiteralOwners)]).toEqual(["core/product-identity.ts"]);
    expect(productChainNumericLiteralOwners).toEqual([]);
  });

  it("keeps every reference-market capability identifier in its contract owner", async () => {
    const expected = new Set([
      "market.reference_price",
      "market.reference_history",
      "market.watchlist",
      "market.add_watchlist_pair",
      "market.remove_watchlist_pair",
      "market.reorder_watchlist_pairs",
    ]);
    const owners = new Map<string, Set<string>>();
    for (const file of await collectSourceFiles(sourceRoot)) {
      const name = relative(sourceRoot, file).split(sep).join("/");
      const parsed = ts.createSourceFile(
        file,
        await readFile(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      const visit = (node: ts.Node): void => {
        if (ts.isStringLiteralLike(node) && expected.has(node.text)) {
          const files = owners.get(node.text) ?? new Set<string>();
          files.add(name);
          owners.set(node.text, files);
        }
        ts.forEachChild(node, visit);
      };
      visit(parsed);
    }
    expect([...owners.keys()].sort()).toEqual([...expected].sort());
    for (const files of owners.values()) expect([...files]).toEqual(["market-portfolio/contracts.ts"]);
  });

  it("keeps the fixed reference-market manifest and process entry points in their single owners", async () => {
    const fixedLiteralOwners = new Map<string, string>([
      [
        "https://docs.chain.link/data-feeds/price-feeds/addresses?network=robinhood",
        "core/reference-market.ts",
      ],
      ["2026-07-23T02:00:12.000Z", "core/reference-market.ts"],
      ["0x78f3556b67e17df817d51ef5a990cdaf09e8d3a9", "core/reference-market.ts"],
      ["0x61b7e5650328764b076a108eff5fa7282a1b9ad2", "core/reference-market.ts"],
      ["0x5fc5360d0400a0fd4f2af552add042d716f1d168", "core/reference-market.ts"],
      ["ETH / USD", "core/reference-market.ts"],
      ["USDG / USD", "core/reference-market.ts"],
      ["ETH/USD", "core/reference-market.ts"],
      ["USDG/USD", "core/reference-market.ts"],
      ["ETH/USDG", "core/reference-market.ts"],
      ["0x7284e416", "chain/reference-market.ts"],
      ["0xfeaf968c", "chain/reference-market.ts"],
      ["0x9a6fc8f5", "chain/reference-market.ts"],
    ]);
    const fixedLiteralOccurrences = new Map(
      [...fixedLiteralOwners.keys()].map((literal) => [literal, new Set<string>()]),
    );
    const declarationOwners = new Map<string, Set<string>>([
      ["createReferenceMarketChainReadPort", new Set()],
      ["createReferenceHistory", new Set()],
    ]);
    const heartbeatOwners = new Set<string>();
    const canonicalWatchlistLimitConsumers = new Set<string>();
    const referenceMarketSurfaceFiles: string[] = [];
    const forbiddenLogReaders: string[] = [];

    for (const file of await collectSourceFiles(sourceRoot)) {
      const name = relative(sourceRoot, file).split(sep).join("/");
      const parsed = ts.createSourceFile(
        file,
        await readFile(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      const referenceMarketRelated =
        name.includes("reference-market") ||
        name.startsWith("market-portfolio/") ||
        parsed.text.includes("referenceMarket") ||
        parsed.text.includes("ReferenceMarket");
      if (referenceMarketRelated) {
        referenceMarketSurfaceFiles.push(name);
        if (parsed.text.includes("eth_getLogs")) forbiddenLogReaders.push(name);
      }
      const visit = (node: ts.Node): void => {
        if (ts.isStringLiteralLike(node)) {
          fixedLiteralOccurrences.get(node.text)?.add(name);
        }
        if (
          ts.isNumericLiteral(node) &&
          node.getText(parsed).replaceAll("_", "") === "86400" &&
          referenceMarketRelated
        ) {
          heartbeatOwners.add(name);
        }
        if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          declarationOwners.has(node.name.text)
        ) {
          declarationOwners.get(node.name.text)!.add(name);
        }
        if (
          ts.isPropertyAccessExpression(node) &&
          node.getText(parsed) === "referenceMarketLimits.watchlistEntries"
        ) {
          canonicalWatchlistLimitConsumers.add(name);
        }
        ts.forEachChild(node, visit);
      };
      visit(parsed);
    }

    for (const [literal, expectedOwner] of fixedLiteralOwners) {
      expect([...fixedLiteralOccurrences.get(literal)!], literal).toEqual([expectedOwner]);
    }
    expect([...heartbeatOwners]).toEqual(["core/reference-market.ts"]);
    expect([...declarationOwners.get("createReferenceMarketChainReadPort")!])
      .toEqual(["chain/reference-market.ts"]);
    expect([...declarationOwners.get("createReferenceHistory")!])
      .toEqual(["market-portfolio/candles.ts"]);
    expect([...canonicalWatchlistLimitConsumers]).toEqual(expect.arrayContaining([
      "core/reference-market.ts",
      "interfaces/web/reference-market-view.tsx",
      "runtime/database.ts",
      "runtime/sqlite-schema.ts",
    ]));
    expect(forbiddenLogReaders).toEqual([]);
    expect(referenceMarketSurfaceFiles.filter((name) =>
      /(?:^|[-/])(?:indexer|provider)(?:[-/.]|$)/u.test(name))).toEqual([]);
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

  it("passes only the cumulative support manifest into the reference-market stage", async () => {
    const file = resolve("src/runtime/composition.ts");
    const source = await readFile(file, "utf8");
    const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    let stageType: ts.TypeAliasDeclaration | undefined;
    const visit = (node: ts.Node): void => {
      if (ts.isTypeAliasDeclaration(node) && node.name.text === "ReferenceMarketOwnerApplicationStage") {
        stageType = node;
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);
    expect(stageType).toBeDefined();
    if (stageType === undefined || !ts.isFunctionTypeNode(stageType.type)) return;
    expect(stageType.type.parameters[3]?.type?.getText(parsed)).toBe("AccountAssetRuntimeSupportManifest");
    expect(stageType.getText(parsed)).not.toContain("AccountAssetOwnerHandoff");
  });

  it("keeps chain invocation, opaque-block, observation, and token-inspection authority in their exact owners", async () => {
    const lifecycleOwners = new Set([
      resolve(sourceRoot, "chain/application.ts"),
      resolve(sourceRoot, "chain/index.ts"),
      resolve(sourceRoot, "chain/invocation-lifecycle.ts"),
    ]);
    const lifecycleViolations: string[] = [];
    for (const file of await collectSourceFiles(sourceRoot)) {
      const source = await readFile(file, "utf8");
      if (
        !lifecycleOwners.has(file) &&
        (source.includes("createChainInvocationLifecycle") || source.includes("chainInvocationDeadlineMs"))
      ) {
        lifecycleViolations.push(relative(sourceRoot, file).split(sep).join("/"));
      }
    }
    expect(lifecycleViolations).toEqual([]);

    const atBlockPorts = [
      [resolve(sourceRoot, "chain/account-assets.ts"), "AccountAssetChainReadPort"],
      [resolve(sourceRoot, "chain/official-assets.ts"), "OfficialAssetChainReadPort"],
      [resolve(sourceRoot, "chain/reference-market.ts"), "ReferenceMarketChainReadPort"],
    ] as const;
    const blockPortViolations: string[] = [];
    for (const [file, interfaceName] of atBlockPorts) {
      const source = await readFile(file, "utf8");
      const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const visit = (node: ts.Node): void => {
        if (ts.isInterfaceDeclaration(node) && node.name.text === interfaceName) {
          for (const member of node.members) {
            if (!ts.isMethodSignature(member)) continue;
            const text = member.getText(parsed);
            const hasBlockParameter = member.parameters.some((parameter) =>
              ts.isIdentifier(parameter.name) && parameter.name.text === "block") ||
              text.includes("block: CanonicalBlock");
            if (hasBlockParameter && (!text.includes("CanonicalBlock") || !text.includes("ChainInvocationContext"))) {
              blockPortViolations.push(`${relative(sourceRoot, file)}:${member.name.getText(parsed)}`);
            }
            if (hasBlockParameter && text.includes("block: ChainAnchor")) {
              blockPortViolations.push(`${relative(sourceRoot, file)}:${member.name.getText(parsed)}:raw-anchor`);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(parsed);
    }
    expect(blockPortViolations).toEqual([]);

    const coreIndexFile = resolve(sourceRoot, "core/index.ts");
    const coreIndexSource = await readFile(coreIndexFile, "utf8");
    const coreIndex = ts.createSourceFile(
      coreIndexFile,
      coreIndexSource,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const constructorDeclarations: string[] = [];
    const inspectCoreIndex = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === "captureReferenceRoundObservation") {
        constructorDeclarations.push("function");
      }
      if (ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "captureReferenceRoundObservation") {
        constructorDeclarations.push("variable");
      }
      ts.forEachChild(node, inspectCoreIndex);
    };
    inspectCoreIndex(coreIndex);
    expect(constructorDeclarations).toEqual([]);
    expect(coreIndexSource).toContain("captureReferenceRoundObservation,");

    const coordinator = await readFile(resolve(sourceRoot, "token-catalog/coordinator.ts"), "utf8");
    for (const forbidden of [
      "CapabilityBindingRegistry",
      "CapabilityRegistry",
      "createTokenInspectionService",
      "tokenInspectCapability",
    ]) expect(coordinator).not.toContain(forbidden);
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
