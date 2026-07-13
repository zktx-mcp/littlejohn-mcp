import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { createApplicationFailure } from "../../src/core/index.js";
import {
  RuntimeOperationError,
  assertDirectInterfaceErrorMappingRegistryExtension,
  normalizeRuntimeError,
  problemDetailsSchema,
  runtimeErrorRegistry,
  runtimeInterfaceErrorMappings,
  toProblemDetails,
} from "../../src/runtime/errors.js";
import {
  assertChainRuntimeSupportManifestExtension,
  assertInterfaceRuntimeSupportManifestExtension,
  assertWalletRuntimeSupportManifestExtension,
  capabilityCatalogSchema,
  composeCapabilityCatalog,
  extendChainRuntimeSupportManifest,
  extendInterfaceRuntimeSupportManifest,
  extendWalletRuntimeSupportManifest,
  initialRuntimeSupportManifest,
  projectCurrentSupportDocument,
  readRuntimeSupportManifest,
  renderCurrentSupportSection,
  runtimeSupportManifestSchema,
  verifyCurrentSupportDocument,
} from "../../src/runtime/support-manifest.js";

describe("runtime support manifest authority", () => {
  it("owns L0 evidence and derives capability identity from the canonical registry", async () => {
    const snapshot = readRuntimeSupportManifest(initialRuntimeSupportManifest);
    expect(snapshot.contractVersion).toBe("1");
    expect(snapshot.chains).toEqual([{
      chainId: "4663",
      caip2: "eip155:4663",
      supportLevel: "L0_discovered",
      evidence: {
        position: "source_defined",
        sourceOwner: "Robinhood",
        canonicalUri: "https://docs.robinhood.com/chain/connecting/",
        coverage: "Published Robinhood Chain network identity and chain ID.",
        unsupportedConclusions: ["Endpoint availability.", "Runtime availability.", "Safety."],
      },
    }]);
    expect(snapshot.capabilities.map((entry) => entry.capabilityId)).toEqual([
      "account.balance",
      "chain.status",
      "contract.inspect",
      "transaction.inspect",
      "wallet.connect",
      "wallet.connection",
      "wallet.disconnect",
      "wallet.list_sessions",
      "wallet.select_session",
    ]);
    expect(snapshot.capabilities.every((entry) => entry.availability.overall === "unavailable")).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.capabilities)).toBe(true);

    const catalog = composeCapabilityCatalog(initialRuntimeSupportManifest);
    expect(catalog.capabilities.map((entry) => entry.capabilityId)).toEqual([
      "account.balance",
      "chain.status",
      "contract.inspect",
      "transaction.inspect",
      "wallet.connection",
    ]);
    expect(catalog.capabilities.every((entry) => entry.availability.overall === "unavailable")).toBe(true);
  });

  it("allows only dependency-ordered, scope-limited support changes", () => {
    const wallet = extendWalletRuntimeSupportManifest(initialRuntimeSupportManifest, [
      { capabilityId: "wallet.connect", direct: "internal", http: "internal", cli: "available" },
      { capabilityId: "wallet.connection", direct: "internal", http: "internal", cli: "available" },
    ]);
    expect(readRuntimeSupportManifest(wallet).capabilities
      .find((entry) => entry.capabilityId === "wallet.connection")?.availability).toEqual({
      overall: "available", direct: "internal", http: "internal",
      mcp: "unavailable", cli: "available", web: "unavailable",
    });
    const chain = extendChainRuntimeSupportManifest(wallet);
    for (const capabilityId of ["account.balance", "chain.status", "contract.inspect", "transaction.inspect"]) {
      expect(readRuntimeSupportManifest(chain).capabilities
        .find((entry) => entry.capabilityId === capabilityId)?.availability.direct).toBe("internal");
    }
    const interfaces = extendInterfaceRuntimeSupportManifest(chain, [
      { capabilityId: "account.balance", bindings: ["cli", "http", "mcp"] },
      { capabilityId: "wallet.connection", bindings: ["http", "mcp"] },
    ]);
    expect(readRuntimeSupportManifest(interfaces).capabilities
      .find((entry) => entry.capabilityId === "account.balance")?.availability).toEqual({
      overall: "available", direct: "internal", http: "available",
      mcp: "available", cli: "available", web: "unavailable",
    });
    expect(readRuntimeSupportManifest(interfaces).capabilities
      .find((entry) => entry.capabilityId === "wallet.connection")?.availability).toEqual({
      overall: "available", direct: "internal", http: "available",
      mcp: "available", cli: "available", web: "unavailable",
    });
    expect(() => assertWalletRuntimeSupportManifestExtension(initialRuntimeSupportManifest, wallet)).not.toThrow();
    expect(() => assertChainRuntimeSupportManifestExtension(wallet, chain)).not.toThrow();
    expect(() => assertInterfaceRuntimeSupportManifestExtension(chain, interfaces)).not.toThrow();
    expect(() => assertWalletRuntimeSupportManifestExtension(initialRuntimeSupportManifest, chain as never))
      .toThrow("scope lineage");
    expect(() => extendWalletRuntimeSupportManifest(initialRuntimeSupportManifest, [])).toThrow();
    expect(() => extendWalletRuntimeSupportManifest(initialRuntimeSupportManifest, [{
      capabilityId: "account.balance", direct: "internal",
    }])).toThrow();
    expect(() => extendWalletRuntimeSupportManifest(initialRuntimeSupportManifest, [{
      capabilityId: "wallet.connection", mcp: "available",
    }])).toThrow();
    expect(() => extendWalletRuntimeSupportManifest(initialRuntimeSupportManifest, [{
      capabilityId: "wallet.connection", http: "available",
    }])).toThrow();
    expect(() => extendWalletRuntimeSupportManifest(initialRuntimeSupportManifest, [{
      capabilityId: "wallet.connection", direct: "available",
    }])).toThrow();
    expect(() => extendWalletRuntimeSupportManifest(initialRuntimeSupportManifest, [{
      capabilityId: "wallet.connection", cli: "available",
    }])).toThrow("direct capability");
    expect(() => extendInterfaceRuntimeSupportManifest(chain, [{
      capabilityId: "wallet.disconnect", bindings: ["cli"],
    }])).toThrow();
    expect(() => extendInterfaceRuntimeSupportManifest(chain, [{
      capabilityId: "account.balance", bindings: ["web"],
    }])).toThrow();
    expect(() => extendInterfaceRuntimeSupportManifest(chain, [{
      capabilityId: "wallet.connection", bindings: ["http"],
    }])).not.toThrow();
    expect(() => extendInterfaceRuntimeSupportManifest(chain, [{
      capabilityId: "chain.status", bindings: ["mcp", "http"],
    }])).toThrow("unique and ordered");
    const hostile = new Proxy([], {
      ownKeys(): never { throw new Error("secret-support-delta"); },
    });
    let hostileFailure: unknown;
    try {
      extendWalletRuntimeSupportManifest(initialRuntimeSupportManifest, hostile as never);
    } catch (error) { hostileFailure = error; }
    expect(hostileFailure).toBeInstanceOf(TypeError);
    expect(String(hostileFailure)).not.toContain("secret-support-delta");
  });

  it("keeps internal authority independent from mutated public schemas", () => {
    const manifestRuntime = (runtimeSupportManifestSchema as unknown as { _zod: { run: unknown } })._zod;
    const catalogRuntime = (capabilityCatalogSchema as unknown as { _zod: { run: unknown } })._zod;
    const manifestRun = manifestRuntime.run;
    const catalogRun = catalogRuntime.run;
    try {
      manifestRuntime.run = () => ({ value: { forged: true }, issues: [] });
      catalogRuntime.run = () => ({ value: { forged: true }, issues: [] });
      expect(readRuntimeSupportManifest(initialRuntimeSupportManifest).chains[0]?.chainId).toBe("4663");
      expect(composeCapabilityCatalog(initialRuntimeSupportManifest).contractVersion).toBe("1");
    } finally {
      manifestRuntime.run = manifestRun;
      catalogRuntime.run = catalogRun;
    }
  });

  it("requires exactly one generated Current Support section and marker", async () => {
    const document = await readFile("docs/PRODUCT_POLICY.md", "utf8");
    expect(() => verifyCurrentSupportDocument(document, initialRuntimeSupportManifest)).not.toThrow();
    const drifted = document.replace("Available user-facing capabilities: none.", "Available user-facing capabilities: all.");
    expect(() => verifyCurrentSupportDocument(drifted, initialRuntimeSupportManifest)).toThrow("not synchronized");
    expect(projectCurrentSupportDocument(drifted, initialRuntimeSupportManifest)).toBe(document);
    expect(() => projectCurrentSupportDocument(`${document}\n${renderCurrentSupportSection(initialRuntimeSupportManifest)}`, initialRuntimeSupportManifest))
      .toThrow("identity");
    expect(() => projectCurrentSupportDocument(
      document.replace(
        "<!-- Generated from the runtime support manifest. Do not edit this section. -->",
        "<!-- Generated from the runtime support manifest. Do not edit this section. -->\n<!-- Generated from the runtime support manifest. Do not edit this section. -->",
      ),
      initialRuntimeSupportManifest,
    )).toThrow("identity");
  });
});

describe("interface error authority", () => {
  it("matches the complete WU2 error projection fixed by the accepted plan", () => {
    expect(runtimeInterfaceErrorMappings.values()).toEqual([
      { code: "invalid_input", httpStatus: 400, problemTitle: "Invalid request", cliExitCode: 2 },
      { code: "internal_error", httpStatus: 500, problemTitle: "Internal error", cliExitCode: 1 },
      { code: "invalid_json", httpStatus: 400, problemTitle: "Invalid JSON", cliExitCode: 2 },
      { code: "query_not_supported", httpStatus: 400, problemTitle: "Query not supported", cliExitCode: 2 },
      { code: "payload_too_large", httpStatus: 413, problemTitle: "Payload too large", cliExitCode: 2 },
      { code: "content_type_unsupported", httpStatus: 415, problemTitle: "Unsupported content type", cliExitCode: 2 },
      { code: "invalid_host", httpStatus: 400, problemTitle: "Invalid host", cliExitCode: 6 },
      { code: "invalid_origin", httpStatus: 403, problemTitle: "Invalid origin", cliExitCode: 6 },
      { code: "unauthorized", httpStatus: 401, problemTitle: "Unauthorized", cliExitCode: 6 },
      { code: "route_not_found", httpStatus: 404, problemTitle: "Route not found", cliExitCode: 3 },
      { code: "method_not_allowed", httpStatus: 405, problemTitle: "Method not allowed", cliExitCode: 2 },
      { code: "state_conflict", httpStatus: 409, problemTitle: "State conflict", cliExitCode: 5 },
      { code: "port_conflict", httpStatus: 409, problemTitle: "Port conflict", cliExitCode: 7 },
      { code: "runtime_busy", httpStatus: 503, problemTitle: "Runtime busy", cliExitCode: 4 },
      { code: "runtime_state_unavailable", httpStatus: 500, problemTitle: "Runtime state unavailable", cliExitCode: 7 },
      { code: "request_aborted", httpStatus: 408, problemTitle: "Request aborted", cliExitCode: 4 },
    ]);
  });

  it("projects one canonical application failure without trusting the public schema", () => {
    const failure = createApplicationFailure(runtimeErrorRegistry, "invalid_host");
    const expected = {
      type: "about:blank",
      title: "Invalid host",
      status: 400,
      code: "invalid_host",
      detail: "The request host is not allowed.",
      retryable: false,
      issues: [],
    };
    expect(toProblemDetails(failure)).toEqual(expected);
    const runtime = (problemDetailsSchema as unknown as { _zod: { run: unknown } })._zod;
    const original = runtime.run;
    try {
      runtime.run = () => ({ value: { forged: true }, issues: [] });
      expect(toProblemDetails(failure)).toEqual(expected);
    } finally { runtime.run = original; }
    expect(() => toProblemDetails({
      ...failure,
      error: { ...failure.error, message: "forged provider detail" },
    })).toThrow("authority");
  });

  it("extends mappings only through the exact direct application-error lineage", () => {
    const childErrors = runtimeErrorRegistry.extend([{
      code: "wallet_test_failure",
      category: "wallet",
      message: "The wallet test failed.",
      retryable: false,
    }]);
    const childMappings = runtimeInterfaceErrorMappings.extend(childErrors, [{
      code: "wallet_test_failure",
      httpStatus: 409,
      problemTitle: "Wallet test failure",
      cliExitCode: 5,
    }]);
    assertDirectInterfaceErrorMappingRegistryExtension(runtimeInterfaceErrorMappings, childMappings);
    expect(toProblemDetails(createApplicationFailure(childErrors, "wallet_test_failure"), childMappings).status).toBe(409);

    const siblingErrors = runtimeErrorRegistry.extend([{
      code: "wallet_sibling_failure",
      category: "wallet",
      message: "The sibling wallet test failed.",
      retryable: false,
    }]);
    expect(() => childMappings.extend(siblingErrors, [{
      code: "wallet_sibling_failure",
      httpStatus: 409,
      problemTitle: "Sibling wallet test failure",
      cliExitCode: 5,
    }])).toThrow("ancestry");
  });

  it("normalizes unknown exceptions without retaining their payload", () => {
    const secret = "secret-provider-payload";
    const normalized = normalizeRuntimeError(new Error(secret));
    expect(normalized).toBeInstanceOf(RuntimeOperationError);
    expect(normalized.failure.error).toMatchObject({
      code: "internal_error",
      message: "The request could not be completed.",
    });
    expect(JSON.stringify(normalized)).not.toContain(secret);
    expect(JSON.stringify(normalized)).not.toContain("stack");
  });
});
