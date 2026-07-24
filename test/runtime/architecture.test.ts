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
  "registry/official-asset-contract.ts",
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

const sourceDescendants = (root: ts.Node): readonly ts.Node[] => {
  const nodes: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    nodes.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return nodes;
};

const parseSource = async (path: string): Promise<ts.SourceFile> =>
  ts.createSourceFile(path, await readFile(path, "utf8"), ts.ScriptTarget.Latest, true);

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

  it("keeps wallet finite vocabularies in their owners without coupling token interfaces", async () => {
    const [
      operationContract,
      managementContracts,
      coordinator,
      identities,
    ] = await Promise.all([
      parseSource(resolve(sourceRoot, "wallet/operation-contract.ts")),
      parseSource(resolve(sourceRoot, "wallet/management-contracts.ts")),
      parseSource(resolve(sourceRoot, "wallet/coordinator.ts")),
      parseSource(resolve(sourceRoot, "interfaces/identities.ts")),
    ]);
    const declaration = (source: ts.SourceFile, name: string): ts.VariableDeclaration => {
      const found = sourceDescendants(source).find((node): node is ts.VariableDeclaration =>
        ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name);
      if (found === undefined) throw new TypeError(`Missing declaration: ${name}`);
      return found;
    };
    const identifierNames = (node: ts.Node): readonly string[] =>
      sourceDescendants(node)
        .filter((descendant): descendant is ts.Identifier => ts.isIdentifier(descendant))
        .map((identifier) => identifier.text);
    const exactStringArrayExists = (node: ts.Node, expected: readonly string[]): boolean =>
      sourceDescendants(node).some((descendant) =>
        ts.isArrayLiteralExpression(descendant) &&
        descendant.elements.length === expected.length &&
        descendant.elements.every((element, index) =>
          ts.isStringLiteralLike(element) && element.text === expected[index]));

    const interactionSchema = declaration(operationContract, "walletInteractionInterfaceSchema");
    expect(identifierNames(interactionSchema)).toContain("walletInteractionInterfaces");

    const operationFailure = declaration(operationContract, "operationFailureErrorSchema");
    expect(identifierNames(operationFailure)).toContain("walletOperationFailureCategories");
    expect(exactStringArrayExists(operationFailure, ["internal", "runtime", "wallet"])).toBe(false);

    const internalContext = declaration(managementContracts, "walletManagementInternalContextSchema");
    expect(identifierNames(internalContext)).toContain("walletInteractionInterfaceSchema");
    expect(exactStringArrayExists(internalContext, ["cli", "web"])).toBe(false);

    const complete = sourceDescendants(coordinator).find((node): node is ts.MethodDeclaration =>
      ts.isMethodDeclaration(node) && node.name.getText(coordinator) === "#complete");
    if (complete === undefined) throw new TypeError("Missing WalletCoordinator completion method.");
    expect(complete.parameters[1]?.type?.getText(coordinator)).toBe("WalletOperationOutcome");

    const walletStart = declaration(identities, "walletStartLocalIdentity");
    expect(identifierNames(walletStart)).toContain("WalletInteractionInterface");
    expect(exactStringArrayExists(walletStart, ["cli", "web"])).toBe(false);

    for (const tokenDeclaration of [
      declaration(identities, "tokenStartLocalIdentity"),
      declaration(identities, "tokenStartIdentities"),
    ]) {
      expect(identifierNames(tokenDeclaration)).not.toContain("WalletInteractionInterface");
    }
  });

  it("keeps every fixed official-asset manifest literal in its single contract owner", async () => {
    const expectedOwner = "registry/official-asset-contract.ts";
    const fixedTextLiterals = new Set([
      "https://api.robinhood.com/rhj/assets",
      "https://docs.robinhood.com/chain/contracts/",
      "ASSET_STATUS_ACTIVE",
      "2026-07-20",
      "14660943",
      "https://robinhoodchain.blockscout.com/address/0x4783C67b63dE2B358Ac5951a7D41F47A38F3C046",
      "https://robinhoodchain.blockscout.com/address/0xEe351E53BCe6AAF106428358838197C91e36EE0E",
    ]);
    const fixedHexLiterals = new Set([
      "0x4783c67b63de2b358ac5951a7d41f47a38f3c046",
      "0xee351e53bce6aaf106428358838197c91e36ee0e",
      "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
      "0x394c3517e9331e7c88ef8af388c0cb63c720af1b1b4d5a5cace212f7df0b045a",
      "0x3bfd5841605b9931c9dbb0f9f54a28b4038918ceb74d6d1081bc7f963fe528b4",
      "0x94d90a8691fc4fc7a4fb48a86755f948f2a1110325d6c8257dbfeaddaf8832b0",
    ]);
    const owners = new Map(
      [...fixedTextLiterals, ...fixedHexLiterals]
        .map((literal) => [literal, new Set<string>()]),
    );
    for (const file of await collectSourceFiles(sourceRoot)) {
      const name = relative(sourceRoot, file).split(sep).join("/");
      const source = await readFile(file, "utf8");
      const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (ts.isStringLiteralLike(node)) {
          const key = fixedTextLiterals.has(node.text)
            ? node.text
            : fixedHexLiterals.has(node.text.toLowerCase())
              ? node.text.toLowerCase()
              : undefined;
          if (key !== undefined) owners.get(key)?.add(name);
        }
        ts.forEachChild(node, visit);
      };
      visit(parsed);
    }
    for (const [literal, files] of owners) {
      expect([...files], literal).toEqual([expectedOwner]);
    }
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

    const owner = await parseSource(resolve(sourceRoot, "core/reference-market.ts"));
    const declaration = (name: string): ts.VariableDeclaration | undefined =>
      sourceDescendants(owner).find((node): node is ts.VariableDeclaration =>
        ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name);
    const declarationIdentifiers = (name: string): readonly string[] => {
      const found = declaration(name);
      if (found === undefined) throw new TypeError(`Missing declaration: ${name}`);
      return sourceDescendants(found)
        .filter((node): node is ts.Identifier => ts.isIdentifier(node))
        .map((identifier) => identifier.text);
    };
    const containingDeclaration = (node: ts.Node): string | undefined => {
      let current: ts.Node | undefined = node;
      while (current !== undefined) {
        if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) {
          return current.name.text;
        }
        current = current.parent;
      }
      return undefined;
    };

    const definitionLiteralOwners = new Map<string, string>([
      ["1d", "referenceHistoryWindowDefinitionEntries"],
      ["7d", "referenceHistoryWindowDefinitionEntries"],
      ["30d", "referenceHistoryWindowDefinitionEntries"],
      [
        "https://docs.chain.link/data-feeds/price-feeds/addresses?network=robinhood",
        "referenceMarketMappingEvidenceDefinition",
      ],
      ["2026-07-23T02:00:12.000Z", "referenceMarketMappingEvidenceDefinition"],
      ["all_other_networks_and_feeds", "referenceMarketMappingEvidenceDefinition"],
      [
        "feed_address_association_at_observation_time",
        "referenceMarketMappingEvidenceDefinition",
      ],
      ["feed_description_at_observation_time", "referenceMarketMappingEvidenceDefinition"],
      ["feed_decimals_at_observation_time", "referenceMarketMappingEvidenceDefinition"],
      ["feed_heartbeat_at_observation_time", "referenceMarketMappingEvidenceDefinition"],
      ["ongoing_directory_membership", "referenceMarketMappingEvidenceDefinition"],
      ["proxy_correctness_after_observation", "referenceMarketMappingEvidenceDefinition"],
      ["source_uptime", "referenceMarketMappingEvidenceDefinition"],
      ["price_correctness", "referenceMarketMappingEvidenceDefinition"],
      ["endorsement", "referenceMarketMappingEvidenceDefinition"],
      ["trade_price", "referenceMarketMappingEvidenceDefinition"],
      ["sequencer_status", "referenceMarketMappingEvidenceDefinition"],
      ["legal_value", "referenceMarketMappingEvidenceDefinition"],
      ["eth_usd", "referenceFeedDefinitions"],
      ["usdg_usd", "referenceFeedDefinitions"],
      ["0x78f3556b67e17df817d51ef5a990cdaf09e8d3a9", "referenceFeedDefinitions"],
      ["0x61b7e5650328764b076a108eff5fa7282a1b9ad2", "referenceFeedDefinitions"],
      ["ETH / USD", "referenceFeedDefinitions"],
      ["USDG / USD", "referenceFeedDefinitions"],
      ["ETH/USD", "referencePairDefinitions"],
      ["USDG/USD", "referencePairDefinitions"],
      ["ETH/USDG", "referencePairDefinitions"],
    ]);
    const actualDefinitionLiteralOwners = new Map(
      [...definitionLiteralOwners.keys()].map((literal) => [literal, [] as string[]]),
    );
    for (const node of sourceDescendants(owner)) {
      if (!ts.isStringLiteralLike(node)) continue;
      const declarations = actualDefinitionLiteralOwners.get(node.text);
      if (declarations !== undefined) {
        declarations.push(containingDeclaration(node) ?? "<none>");
      }
    }
    for (const [literal, expectedOwner] of definitionLiteralOwners) {
      expect(actualDefinitionLiteralOwners.get(literal), literal).toEqual([expectedOwner]);
    }

    expect(declarationIdentifiers("referenceMarketMappingEvidenceSchema"))
      .toContain("referenceMarketMappingEvidenceDefinition");
    expect(declarationIdentifiers("referenceHistoryWindowSchema"))
      .toContain("referenceHistoryWindowIds");
    expect(declarationIdentifiers("referenceHistoryWindowDefinitions"))
      .toContain("referenceHistoryWindowDefinitionRecord");
    const historyProjection = sourceDescendants(owner).find((node): node is ts.ForOfStatement =>
      ts.isForOfStatement(node) &&
      node.expression.getText(owner) === "referenceHistoryWindowDefinitionEntries");
    if (historyProjection === undefined) throw new TypeError("Missing history-window projection.");
    const historyProjectionIdentifiers = sourceDescendants(historyProjection)
      .filter((node): node is ts.Identifier => ts.isIdentifier(node))
      .map((identifier) => identifier.text);
    expect(historyProjectionIdentifiers).toEqual(expect.arrayContaining([
      "referenceHistoryWindowDefinitionRecord",
      "referenceHistoryCandleBucketRecord",
    ]));
    expect(declarationIdentifiers("referenceFeedIdSchema"))
      .toContain("referenceFeedDefinitionIds");
    expect(declarationIdentifiers("referenceFeedManifestEntrySchema"))
      .toEqual(expect.arrayContaining([
        "referenceFeedAssets",
        "referenceFeedDescriptions",
        "referenceFeedDefinitionById",
      ]));
    expect(declarationIdentifiers("referencePairManifestEntrySchema"))
      .toEqual(expect.arrayContaining(["referencePairLabels", "exactPairEntry"]));
    expect(declarationIdentifiers("exactPairEntry")).toContain("canonicalPairEntryById");
    expect(declarationIdentifiers("referenceMarketLimits"))
      .toEqual(expect.arrayContaining([
        "referenceHistoryCandleBuckets",
        "referenceFeedDefinitions",
        "referencePairDefinitions",
      ]));
    expect(declarationIdentifiers("referenceMarketManifestSchema"))
      .toEqual(expect.arrayContaining(["referenceFeedIds", "referencePairIds"]));
    expect(declarationIdentifiers("referenceMarketManifest"))
      .toEqual(expect.arrayContaining(["referenceFeedDefinitions", "canonicalPairEntries"]));

    for (const obsoleteDeclaration of [
      "canonicalFeedIdentity",
      "ethUsdContract",
      "usdgUsdContract",
      "ethUsdgContract",
    ]) {
      expect(declaration(obsoleteDeclaration)).toBeUndefined();
    }
    expect(sourceDescendants(owner).some((node) =>
      ts.isStringLiteralLike(node) &&
      node.text.includes("eth_usd") &&
      node.text.includes("usdg_usd"))).toBe(false);
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
