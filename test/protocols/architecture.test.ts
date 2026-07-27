import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const source = (path: string) =>
  readFile(resolve(process.cwd(), path), "utf8");

describe("shared protocol module boundary", () => {
  it("keeps browser exports on descriptor and registry modules only", async () => {
    const browser = await source("src/protocols/browser.ts");
    expect(browser).toContain('from "./contracts.js"');
    expect(browser).toContain('from "./registry.js"');
    expect(browser).not.toMatch(/application|runtime|chain|intelligence|uniswap/iu);
  });

  it("keeps shared contracts and registry free of protocol-version behavior", async () => {
    const shared = await Promise.all([
      source("src/protocols/contracts.ts"),
      source("src/protocols/registry.ts"),
    ]);
    for (const text of shared) {
      expect(text).not.toMatch(/uniswap_v[0-9]|latestProtocol|defaultDeployment|routeDiscovery/iu);
      expect(text).not.toMatch(/node:|@uniswap|\/uniswap-v[0-9]\//iu);
      expect(text).not.toMatch(/\bfetch\s*\(|setTimeout\s*\(|setInterval\s*\(/u);
    }
  });

  it("keeps server application exports out of the browser entry", async () => {
    const index = await source("src/protocols/index.ts");
    const browser = await source("src/protocols/browser.ts");
    expect(index).toContain('from "./application.js"');
    expect(browser).not.toContain('from "./application.js"');
  });

  it("keeps the V2 SDK and application outside the browser package", async () => {
    const browser = await source("src/protocols/uniswap-v2/browser.ts");
    const sdk = await source("src/protocols/uniswap-v2/sdk.ts");
    expect(browser).not.toMatch(/application|errors|register|sdk|node:/u);
    expect(sdk).toContain('from "node:module"');
    expect(sdk).toContain('require("@uniswap/sdk-core")');
    expect(sdk).toContain('require("@uniswap/v2-sdk")');
    for (const path of [
      "src/protocols/uniswap-v2/contracts.ts",
      "src/protocols/uniswap-v2/deployment.ts",
      "src/protocols/uniswap-v2/evidence.ts",
      "src/protocols/uniswap-v2/quote.ts",
    ]) {
      const text = await source(path);
      expect(text).not.toMatch(/from "node:|require\s*\(|from "@uniswap/gu);
    }
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
