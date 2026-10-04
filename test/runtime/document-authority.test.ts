import { readFile } from "node:fs/promises";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import {
  accountAssetControlRoutes,
} from "../../src/account-assets/index.js";
import {productChainId} from "../../src/registry/product-identity.js";
import {
  capabilityCatalogInterface,
  declaredCliCommandIdentities,
  declaredMcpToolNames,
  publicInspectionPaths,
  readInterfaceIdentities,
  stockTokenTradeHistoryPublicRoute,
  uniswapV2PublicRoutes,
} from "../../src/interfaces/identities.js";
import { publicInterfaceRoutes } from "../../src/interfaces/http-routes.js";
import { operationControlResources } from "../../src/interfaces/operation-bindings.js";
import {
  fixedOrigin,
  internalApiPathPrefix,
  localControlApiPathPrefix,
  publicApiPathPrefix,
  runtimeIdentityPath,
} from "../../src/runtime/http-boundary.js";
import { currentSqliteSchemaSql } from "../../src/runtime/sqlite-schema.js";
import {
  tokenCatalogControlRoutes,
} from "../../src/token-catalog/index.js";

const architecturePath = "docs/ARCHITECTURE.md";

const deriveCurrentSqliteTableNames = (): readonly string[] => {
  const database = new Database(":memory:");
  try {
    database.exec(currentSqliteSchemaSql);
    return Object.freeze((database.prepare(`SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Array<{ name: string }>)
      .map((row) => row.name));
  } finally {
    database.close();
  }
};

const derivedSqliteTableNames = deriveCurrentSqliteTableNames();

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const decorationNeutralText = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[`*~[\](){}<>|]/gu, " ")
    .replace(/\s+/gu, " ");

const containsExactIdentifier = (text: string, identifier: string): boolean =>
  new RegExp(
    `(?:^|[^a-z0-9_-])${escapeRegex(identifier.toLowerCase())}(?=$|[^a-z0-9_-])`,
    "u",
  ).test(decorationNeutralText(text));

const containsExactPhrase = (text: string, words: readonly string[]): boolean => {
  const phrase = words
    .map((word) => escapeRegex(word.toLowerCase()))
    .join("\\s+");
  return new RegExp(
    `(?:^|[^a-z0-9_-])${phrase}(?=$|[^a-z0-9_-])`,
    "u",
  ).test(decorationNeutralText(text));
};

const stringValues = (value: object): readonly string[] =>
  Object.values(value).filter((entry): entry is string => typeof entry === "string");

const nestedStringValues = (value: unknown): readonly string[] => {
  if (typeof value === "string") return [value];
  if (typeof value !== "object" || value === null) return [];
  return Object.values(value).flatMap(nestedStringValues);
};

const sourceOwnedPaths = Object.freeze([
  ...new Set([
    capabilityCatalogInterface.http.path,
    internalApiPathPrefix,
    localControlApiPathPrefix,
    publicApiPathPrefix,
    runtimeIdentityPath,
    ...readInterfaceIdentities.map((identity) => identity.http.path),
    ...stringValues(accountAssetControlRoutes),
    ...stringValues(publicInspectionPaths),
    ...stringValues(publicInterfaceRoutes),
    stockTokenTradeHistoryPublicRoute,
    ...stringValues(tokenCatalogControlRoutes),
    ...stringValues(uniswapV2PublicRoutes),
    ...nestedStringValues(operationControlResources),
  ].filter((path) => path !== "/")),
].sort());

type CopiedSourceIdentifier =
  | `path:${string}`
  | `sqlite:${string}`
  | "product-chain";

const copiedSourceIdentifiers = (document: string): readonly CopiedSourceIdentifier[] => {
  const violations = new Set<CopiedSourceIdentifier>();
  if (containsExactIdentifier(document, productChainId)) {
    violations.add("product-chain");
  }
  for (const path of sourceOwnedPaths) {
    if (document.includes(path)) violations.add(`path:${path}`);
  }
  for (const tableName of derivedSqliteTableNames) {
    if (
      tableName.includes("_") &&
      containsExactIdentifier(document, tableName)
    ) {
      violations.add(`sqlite:${tableName}`);
    }
  }
  return [...violations].sort();
};

const copiedCompleteInterfaceCatalogs = (
  document: string,
): readonly ("cli" | "mcp")[] => {
  const violations: ("cli" | "mcp")[] = [];
  if (
    declaredCliCommandIdentities.length > 0 &&
    declaredCliCommandIdentities.every((identity) =>
      containsExactPhrase(document, [identity.domain, identity.command]))
  ) {
    violations.push("cli");
  }
  if (
    declaredMcpToolNames.length > 0 &&
    declaredMcpToolNames.every((name) => containsExactIdentifier(document, name))
  ) {
    violations.push("mcp");
  }
  return violations;
};

describe("binding document authority", () => {
  it("detects source-owned exact literals through decorated and fenced text", () => {
    const sqlite = derivedSqliteTableNames.find((name) => name.includes("_"))!;
    const fixture = [
      `**${productChainId}**`,
      "```text",
      runtimeIdentityPath,
      sqlite,
      "```",
    ].join("\n");
    expect(copiedSourceIdentifiers(fixture)).toEqual(expect.arrayContaining([
      `path:${runtimeIdentityPath}`,
      "product-chain",
      `sqlite:${sqlite}`,
    ]));
  });

  it("detects only complete source-derived CLI and MCP catalogs", () => {
    const cliCatalog = declaredCliCommandIdentities
      .map((identity) => `**${identity.domain}** \`${identity.command}\``)
      .join("\n\n");
    const mcpCatalog = declaredMcpToolNames
      .map((name) => `\`${name}\``)
      .join("\n");
    expect(copiedCompleteInterfaceCatalogs(cliCatalog)).toEqual(["cli"]);
    expect(copiedCompleteInterfaceCatalogs(mcpCatalog)).toEqual(["mcp"]);
    expect(copiedCompleteInterfaceCatalogs(
      `${declaredCliCommandIdentities[0]!.domain} ${
        declaredCliCommandIdentities[0]!.command
      }\n${declaredMcpToolNames[0]}`,
    )).toEqual([]);
  });

  it("keeps source-owned exact literals and interface catalogs out of Architecture", async () => {
    const architecture = await readFile(architecturePath, "utf8");
    expect(copiedSourceIdentifiers(architecture)).toEqual([]);
    expect(copiedCompleteInterfaceCatalogs(architecture)).toEqual([]);
    expect(architecture.match(new RegExp(escapeRegex(fixedOrigin), "gu")) ?? [])
      .toHaveLength(1);
  });
});
