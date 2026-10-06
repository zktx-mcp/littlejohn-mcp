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
  it("keeps the shared client graph on its exact interface-safe modules", async () => {
    const clientEntry = resolve("src/protocols/client.ts");
    const contracts = resolve("src/protocols/contracts.ts");
    const registry = resolve("src/protocols/registry.ts");
    const family = resolve("src/protocols/uniswap.ts");
    const expected = new Map<string, readonly string[]>([
      [clientEntry, [
        "module:./contracts.js",
        "module:./registry.js",
        "module:./uniswap.js",
      ]],
      [contracts, [
        "module:zod",
        "module:../core/client.js",
        "module:../evm/identities.js",
      ]],
      [family, ["module:./contracts.js"]],
      [registry, [
        "module:../core/client.js",
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
        mutate(clientEntry, (edges) => [...edges, edge]),
      )).toContain(`${clientEntry}:unexpected_runtime_edge:${edge}`);
    }
    expect(exactRuntimeGraphViolations(
      expected,
      mutate(clientEntry, (edges) => edges.filter((edge) => edge !== "module:./contracts.js")),
    )).toContain(`${clientEntry}:missing_runtime_edge:module:./contracts.js`);
    expect(exactRuntimeGraphViolations(
      expected,
      mutate(clientEntry, (edges) => [...edges, "module:./contracts.js"]),
    )).toContain(`${clientEntry}:unexpected_runtime_edge:module:./contracts.js`);
    expect(exactRuntimeGraphViolations(
      expected,
      mutate(clientEntry, (edges) => edges.map((edge) =>
        edge === "module:./contracts.js" ? "dynamic_import:./contracts.js" : edge)),
    )).toEqual([
      `${clientEntry}:missing_runtime_edge:module:./contracts.js`,
      `${clientEntry}:unexpected_runtime_edge:dynamic_import:./contracts.js`,
    ]);
    const withUnexpectedSource = new Map(observed);
    const unexpectedSource = resolve("src/protocols/server.ts");
    withUnexpectedSource.set(unexpectedSource, []);
    expect(exactRuntimeGraphViolations(expected, withUnexpectedSource))
      .toContain(`${unexpectedSource}:unexpected_source`);
    expect(inspectModuleImports(
      'export type { ProtocolPackageDescriptor } from "./contracts.js";',
      clientEntry,
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

  it("keeps the V2 client graph on its exact interface-safe modules", async () => {
    const clientEntry = resolve("src/protocols/uniswap-v2/client.ts");
    const contracts = resolve("src/protocols/uniswap-v2/contracts.ts");
    const deployment = resolve("src/protocols/uniswap-v2/deployment.ts");
    const evidence = resolve("src/protocols/uniswap-v2/evidence.ts");
    const quote = resolve("src/protocols/uniswap-v2/quote.ts");
    const expected = new Map<string, readonly string[]>([
      [clientEntry, [
        "module:./contracts.js",
        "module:./deployment.js",
      ]],
      [contracts, [
        "module:zod",
        "module:../../core/client.js",
        "module:../../evm/amounts.js", "module:../../evm/capability.js",
        "module:../../evm/identities.js", "module:../../evm/primitives.js",
        "module:../../intelligence/analysis-contract.js", "module:../../registry/client.js",
        "module:./deployment.js",
        "module:./evidence.js",
        "module:./quote.js",
        "module:../uniswap.js",
      ]],
      [deployment, [
        "module:zod",
        "module:../../evm/amounts.js", "module:../../evm/identities.js",
        "module:../../intelligence/analysis-contract.js",
        "module:../../core/client.js",
        "module:../../registry/client.js",
        "module:../contracts.js",
        "module:../uniswap.js",
      ]],
      [evidence, [
        "module:../../core/client.js",
        "module:../../chain/evidence-fragments.js", "module:../../evm/evidence-replay.js",
        "module:../../intelligence/analysis-evidence.js", "module:../../intelligence/analysis-evidence.js",
        "module:./deployment.js",
      ]],
      [quote, [
        "module:../../core/client.js",
        "module:../../evm/identities.js", "module:../../evm/keccak256.js",
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
        mutate(clientEntry, (edges) => [...edges, edge]),
      )).toContain(`${clientEntry}:unexpected_runtime_edge:${edge}`);
    }
    expect(exactRuntimeGraphViolations(
      expected,
      mutate(clientEntry, (edges) => edges.filter((edge) => edge !== "module:./contracts.js")),
    )).toContain(`${clientEntry}:missing_runtime_edge:module:./contracts.js`);
    expect(exactRuntimeGraphViolations(
      expected,
      mutate(clientEntry, (edges) => [...edges, "module:./contracts.js"]),
    )).toContain(`${clientEntry}:unexpected_runtime_edge:module:./contracts.js`);
    expect(inspectModuleImports(
      'import type { UniswapV2QuoteData } from "./contracts.js";',
      clientEntry,
    ).filter((reference) => reference.runtime)).toEqual([]);
  });

  it("keeps contract analysis in one Chain owner while exposing its admitted execution to Review", async () => {
    const chainRead = await source("src/chain/protocol-reads.ts");
    const publicPort = chainRead.slice(
      chainRead.indexOf("export interface PinnedEvmReadPort"),
      chainRead.indexOf("export const createPinnedEvmReadPort"),
    );
    expect(publicPort).toContain("Promise<ContractAnalysis>");
    expect(publicPort).toContain("Promise<ContractAnalysisExecution>");
    expect(chainRead.match(/analyzeContract\(/gu)).toHaveLength(1);
    expect(chainRead).toContain("const execution = await inspectContractExecution(context, block, address);");
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
      expect(text).not.toMatch(/protocols/u);
    }
  });
});
