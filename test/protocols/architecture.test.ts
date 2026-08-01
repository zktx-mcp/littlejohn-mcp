import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { inspectModuleImports, inspectSourceFile } from "../runtime/import-audit.js";

const source = (path: string) =>
  readFile(resolve(process.cwd(), path), "utf8");

const runtimeEdgeKey = (
  reference: Readonly<{ readonly kind: string; readonly specifier?: string }>,
): string => `${reference.kind}:${reference.specifier ?? "<nonliteral>"}`;

const exactRuntimeGraphViolations = (
  expected: ReadonlyMap<string, readonly string[]>,
  observed: ReadonlyMap<string, readonly string[]>,
): readonly string[] => {
  const violations: string[] = [];
  for (const [file, expectedEdges] of expected) {
    const observedEdges = observed.get(file);
    if (observedEdges === undefined) {
      violations.push(`${file}:missing_source`);
      continue;
    }
    const remaining = [...observedEdges];
    for (const edge of expectedEdges) {
      const index = remaining.indexOf(edge);
      if (index < 0) violations.push(`${file}:missing_runtime_edge:${edge}`);
      else remaining.splice(index, 1);
    }
    for (const edge of remaining) violations.push(`${file}:unexpected_runtime_edge:${edge}`);
  }
  for (const file of observed.keys()) {
    if (!expected.has(file)) violations.push(`${file}:unexpected_source`);
  }
  return violations.sort();
};

describe("shared protocol module boundary", () => {
  it("keeps the shared browser graph on its exact browser-safe modules", async () => {
    const browserEntry = resolve("src/protocols/browser.ts");
    const contracts = resolve("src/protocols/contracts.ts");
    const registry = resolve("src/protocols/registry.ts");
    const expected = new Map<string, readonly string[]>([
      [browserEntry, [
        "module:./contracts.js",
        "module:./registry.js",
      ]],
      [contracts, [
        "module:zod",
        "module:../core/browser.js",
      ]],
      [registry, [
        "module:../core/browser.js",
        "module:./contracts.js",
      ]],
    ]);
    const observed = new Map<string, readonly string[]>();
    for (const file of expected.keys()) {
      observed.set(
        file,
        (await inspectSourceFile(file)).moduleImports
          .filter((reference) => reference.runtime)
          .map(runtimeEdgeKey),
      );
    }
    expect(exactRuntimeGraphViolations(expected, observed)).toEqual([]);

    const mutate = (
      file: string,
      transform: (edges: readonly string[]) => readonly string[],
    ): ReadonlyMap<string, readonly string[]> => new Map(
      [...observed].map(([candidate, edges]) => [
        candidate,
        candidate === file ? transform(edges) : edges,
      ]),
    );
    for (const edge of [
      "module:./server/adapter.js",
      "module:../runtime/database.js",
      "module:./uniswap-v2/sdk.js",
      "module:./application.js",
      "dynamic_import:./contracts.js",
      "dynamic_import:<nonliteral>",
      "module:node:fs",
      "module:alternate-package",
    ]) {
      expect(exactRuntimeGraphViolations(
        expected,
        mutate(browserEntry, (edges) => [...edges, edge]),
      )).toContain(`${browserEntry}:unexpected_runtime_edge:${edge}`);
    }
    expect(exactRuntimeGraphViolations(
      expected,
      mutate(browserEntry, (edges) => edges.filter((edge) => edge !== "module:./contracts.js")),
    )).toContain(`${browserEntry}:missing_runtime_edge:module:./contracts.js`);
    expect(exactRuntimeGraphViolations(
      expected,
      mutate(browserEntry, (edges) => [...edges, "module:./contracts.js"]),
    )).toContain(`${browserEntry}:unexpected_runtime_edge:module:./contracts.js`);
    expect(exactRuntimeGraphViolations(
      expected,
      mutate(browserEntry, (edges) => edges.map((edge) =>
        edge === "module:./contracts.js" ? "dynamic_import:./contracts.js" : edge)),
    )).toEqual([
      `${browserEntry}:missing_runtime_edge:module:./contracts.js`,
      `${browserEntry}:unexpected_runtime_edge:dynamic_import:./contracts.js`,
    ]);
    const withUnexpectedSource = new Map(observed);
    const unexpectedSource = resolve("src/protocols/server.ts");
    withUnexpectedSource.set(unexpectedSource, []);
    expect(exactRuntimeGraphViolations(expected, withUnexpectedSource))
      .toContain(`${unexpectedSource}:unexpected_source`);
    expect(inspectModuleImports(
      'export type { ProtocolPackageDescriptor } from "./contracts.js";',
      browserEntry,
    ).filter((reference) => reference.runtime)).toEqual([]);
  });

  it("keeps shared contracts and registry free of protocol-version behavior", async () => {
    const sharedPaths = [
      "src/protocols/contracts.ts",
      "src/protocols/registry.ts",
    ] as const;
    for (const path of sharedPaths) {
      const text = await source(path);
      expect(text).not.toMatch(/uniswap_v[0-9]|latestProtocol|defaultDeployment|routeDiscovery/iu);
      expect(text).not.toMatch(/@uniswap|\/uniswap-v[0-9]\//iu);
      expect(text).not.toMatch(/\bfetch\s*\(|setTimeout\s*\(|setInterval\s*\(/u);
      const runtimeImports = inspectModuleImports(text, resolve(path))
        .filter((reference) => reference.runtime);
      expect(runtimeImports.filter((reference) =>
        reference.specifierClass === "node_builtin" ||
        reference.packageRoot?.startsWith("@uniswap/") === true)).toEqual([]);
    }
  });

  it("keeps the server application export on the server entry", async () => {
    const index = resolve("src/protocols/index.ts");
    expect((await inspectSourceFile(index)).moduleImports
      .filter((reference) => reference.runtime)
      .map(runtimeEdgeKey)).toContain("module:./application.js");
  });

  it("keeps the V2 browser graph on its exact browser-safe modules", async () => {
    const browserEntry = resolve("src/protocols/uniswap-v2/browser.ts");
    const contracts = resolve("src/protocols/uniswap-v2/contracts.ts");
    const deployment = resolve("src/protocols/uniswap-v2/deployment.ts");
    const evidence = resolve("src/protocols/uniswap-v2/evidence.ts");
    const quote = resolve("src/protocols/uniswap-v2/quote.ts");
    const expected = new Map<string, readonly string[]>([
      [browserEntry, [
        "module:./contracts.js",
        "module:./deployment.js",
      ]],
      [contracts, [
        "module:zod",
        "module:../../core/browser.js",
        "module:./deployment.js",
        "module:./evidence.js",
        "module:./quote.js",
      ]],
      [deployment, [
        "module:zod",
        "module:../../core/browser.js",
        "module:../../registry/browser.js",
        "module:../contracts.js",
      ]],
      [evidence, [
        "module:../../core/browser.js",
        "module:./deployment.js",
      ]],
      [quote, [
        "module:../../core/browser.js",
      ]],
    ]);
    const observed = new Map<string, readonly string[]>();
    for (const file of expected.keys()) {
      observed.set(
        file,
        (await inspectSourceFile(file)).moduleImports
          .filter((reference) => reference.runtime)
          .map(runtimeEdgeKey),
      );
    }
    expect(exactRuntimeGraphViolations(expected, observed)).toEqual([]);

    const mutate = (
      file: string,
      transform: (edges: readonly string[]) => readonly string[],
    ): ReadonlyMap<string, readonly string[]> => new Map(
      [...observed].map(([candidate, edges]) => [
        candidate,
        candidate === file ? transform(edges) : edges,
      ]),
    );
    for (const edge of [
      "module:./server/adapter.js",
      "module:../../runtime/database.js",
      "module:./sdk.js",
      "module:./application.js",
      "dynamic_import:./contracts.js",
      "dynamic_import:<nonliteral>",
      "module:node:fs",
      "module:alternate-package",
    ]) {
      expect(exactRuntimeGraphViolations(
        expected,
        mutate(browserEntry, (edges) => [...edges, edge]),
      )).toContain(`${browserEntry}:unexpected_runtime_edge:${edge}`);
    }
    expect(exactRuntimeGraphViolations(
      expected,
      mutate(browserEntry, (edges) => edges.filter((edge) => edge !== "module:./contracts.js")),
    )).toContain(`${browserEntry}:missing_runtime_edge:module:./contracts.js`);
    expect(exactRuntimeGraphViolations(
      expected,
      mutate(browserEntry, (edges) => [...edges, "module:./contracts.js"]),
    )).toContain(`${browserEntry}:unexpected_runtime_edge:module:./contracts.js`);
    expect(inspectModuleImports(
      'import type { UniswapV2QuoteData } from "./contracts.js";',
      browserEntry,
    ).filter((reference) => reference.runtime)).toEqual([]);
  });

  it("keeps contract-analysis admission and recording inside the chain-read owner", async () => {
    const chainRead = await source("src/chain/protocol-reads.ts");
    const publicPort = chainRead.slice(
      chainRead.indexOf("export interface PinnedEvmReadPort"),
      chainRead.indexOf("export const createPinnedEvmReadPort"),
    );
    expect(publicPort).toContain("Promise<ContractAnalysis>");
    expect(publicPort).not.toContain("ContractAnalysisExecution");
    expect(publicPort).not.toContain("ContractSourceVerificationPort");
    expect(chainRead).toContain("recordContractAnalysisEvidence({");
    expect(chainRead.match(/recordContractAnalysisEvidence\(/gu)).toHaveLength(1);
  });

  it("keeps protocol support independent from token-catalog ownership", async () => {
    const protocolRuntime = await source("src/protocols/runtime.ts");
    const tokenCatalog = await Promise.all([
      source("src/token-catalog/support.ts"),
      source("src/token-catalog/application-factory.ts"),
    ]);
    expect(protocolRuntime).toContain("supportExtension");
    expect(protocolRuntime).not.toContain("supportManifest");
    for (const text of tokenCatalog) {
      expect(text).not.toMatch(/protocols|ProtocolRuntimeSupportManifest/u);
    }
  });
});
