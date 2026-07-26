import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { productChainId } from "../../src/core/index.js";
import { runtimeProtocolVersion } from "../../src/runtime/runtime-identity.js";
import {
  currentSqliteSchemaSql,
  currentSqliteTableNames,
  databaseSchemaVersion,
} from "../../src/runtime/sqlite-schema.js";

const architecturePath = "docs/ARCHITECTURE.md";
const productPolicyPath = "docs/PRODUCT_POLICY.md";
const transactionPolicyPath = "docs/TRANSACTION_POLICY.md";

const currentTableNames = [
  "chain",
  "contract",
  "current_wallet_connection",
  "local_profile",
  "reference_feed_round",
  "reference_feed_sync_state",
  "reference_pair_watchlist_entry",
  "reference_pair_watchlist_state",
  "robinhood_asset",
  "robinhood_asset_snapshot",
  "runtime_owner",
  "token_contract",
  "token_contract_inspection",
  "wallet_account",
  "wallet_token_selection",
  "wallet_token_selection_state",
] as const;

type DuplicateMachineState =
  | "database-schema-version"
  | "product-chain-reference"
  | "runtime-protocol-version"
  | "sqlite-table-count"
  | `sqlite-table-name:${typeof currentTableNames[number]}`;

const containsExactToken = (text: string, token: string): boolean =>
  new RegExp(`(?:^|[^a-z0-9_])${token}(?=$|[^a-z0-9_])`, "u").test(text);

const containsVersionValue = (text: string, numeric: string, word: string): boolean =>
  containsExactToken(text, numeric) ||
  containsExactToken(text, word) ||
  new RegExp(`(?:^|[^a-z0-9_])v${numeric}(?=$|[^a-z0-9_])`, "u").test(text);

const duplicateMachineState = (document: string): readonly DuplicateMachineState[] => {
  const normalized = document.toLowerCase();
  const violations = new Set<DuplicateMachineState>();
  if (containsExactToken(normalized, "4663")) violations.add("product-chain-reference");

  const statements = normalized
    .replace(/\s+/gu, " ")
    .split(/[.!?]+(?:\s+|$)/u)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  for (const statement of statements) {
    const isRuntimeProtocolContext =
      /\bruntimeprotocolversion\b/u.test(statement) ||
      /\bruntime protocol\b/u.test(statement) ||
      /\bprotocol (?:version|revision)\b/u.test(statement) ||
      /\bwire (?:contract|version|revision)\b/u.test(statement);
    if (isRuntimeProtocolContext && containsVersionValue(statement, "9", "nine")) {
      violations.add("runtime-protocol-version");
    }

    const isDatabaseSchemaContext =
      /\bdatabase schema\b/u.test(statement) ||
      /\bsqlite schema\b/u.test(statement) ||
      /\bschema (?:version|revision)\b/u.test(statement) ||
      /\buser_version\b/u.test(statement) ||
      /\bdatabaseschemaversion\b/u.test(statement);
    if (isDatabaseSchemaContext && containsVersionValue(statement, "8", "eight")) {
      violations.add("database-schema-version");
    }

    const isSqliteTableContext =
      /\btables?\b/u.test(statement) &&
      /\b(?:database|schema|sqlite)\b/u.test(statement);
    if (isSqliteTableContext && containsVersionValue(statement, "16", "sixteen")) {
      violations.add("sqlite-table-count");
    }
  }

  for (const tableName of currentTableNames) {
    if (tableName.includes("_") && containsExactToken(normalized, tableName)) {
      violations.add(`sqlite-table-name:${tableName}`);
    }
  }
  return [...violations].sort();
};

describe("binding document authority", () => {
  it("detects equivalent duplicate machine-state claims without relying on prose or Markdown form", () => {
    expect(duplicateMachineState("`runtimeProtocolVersion` equals `9`.")).toEqual([
      "runtime-protocol-version",
    ]);
    expect(duplicateMachineState([
      "The EIP-155 chain reference is 4663.",
      "The compatible wire contract uses version 9.",
      "`databaseSchemaVersion` equals `8`.",
      "There are sixteen current SQLite tables.",
      "The current database tables include runtime_owner and local_profile.",
    ].join("\n\n"))).toEqual([
      "database-schema-version",
      "product-chain-reference",
      "runtime-protocol-version",
      "sqlite-table-count",
      "sqlite-table-name:local_profile",
      "sqlite-table-name:runtime_owner",
    ]);
  });

  it("keeps exact machine current state in its code and Product Policy owners", async () => {
    expect(productChainId).toBe("eip155:4663");
    expect(runtimeProtocolVersion).toBe(9);
    expect(databaseSchemaVersion).toBe(8);
    expect(currentSqliteTableNames).toEqual(currentTableNames);
    expect(Buffer.byteLength(currentSqliteSchemaSql, "utf8")).toBe(23_690);
    expect(createHash("sha256").update(currentSqliteSchemaSql, "utf8").digest("hex")).toBe(
      "a969ee4a4e1cf1cf4d6da18eb1a0ab3903f0242ebcc67d719ab61a7e93af62fa",
    );

    const productPolicy = await readFile(productPolicyPath, "utf8");
    expect(Buffer.byteLength(productPolicy, "utf8")).toBe(7_723);
    expect(createHash("sha256").update(productPolicy, "utf8").digest("hex")).toBe(
      "6016e97e67c98fe6b303f4de2156ab05f4c83223185d6b308a43013ad6c3524c",
    );
  });

  it("keeps Architecture semantic rules without duplicate exact current state", async () => {
    const architecture = await readFile(architecturePath, "utf8");
    expect(duplicateMachineState(architecture)).toEqual([]);

    for (const owner of [
      "docs/PRODUCT_POLICY.md",
      "productChainId",
      "runtimeProtocolVersion",
      "databaseSchemaVersion",
      "currentSqliteSchemaSql",
      "currentSqliteTableNames",
    ]) expect(architecture).toContain(owner);

    for (const semanticRule of [
      "EIP-1898",
      "A mismatch fails closed",
      "never invokes a migration",
      "The stored owner protocol version is a projection",
      "One account for the canonical product chain",
    ]) expect(architecture).toContain(semanticRule);
  });

  it("keeps transaction handoff meaning while naming the product-chain owner", async () => {
    const transactionPolicy = await readFile(transactionPolicyPath, "utf8");
    expect(duplicateMachineState(transactionPolicy)).toEqual([]);
    expect(transactionPolicy).toContain(
      "the canonical\n  product chain identified by `docs/PRODUCT_POLICY.md`",
    );
    expect(transactionPolicy).toContain(
      "the coordinator sends the request on that session without another QR\n  pairing",
    );
  });
});
