import { createHash } from "node:crypto";

import { z } from "zod";
import { describe, expect, it } from "vitest";

import {
  coreContractVersion,
  createApplicationFailure,
  readCapabilityRegistry,
  type CanonicalJson,
} from "../../src/core/index.js";
import { interfaceReadCapabilityRegistry } from "../../src/interfaces/identities.js";
import { extendAccountAssetSupportManifest } from "../../src/account-assets/support.js";
import { extendReferenceMarketSupportManifest } from "../../src/market-portfolio/support.js";
import { readRuntimeConfiguration } from "../../src/runtime/configuration.js";
import { ownerIdentitySchema } from "../../src/runtime/runtime-identity.js";
import {
  RuntimeOperationError,
  assertDirectInterfaceErrorMappingRegistryExtension,
  createRuntimeFailure,
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
  createCapabilityCatalogSchema,
  composeCapabilityCatalog,
  extendChainRuntimeSupportManifest,
  extendInterfaceRuntimeSupportManifest,
  extendWalletRuntimeSupportManifest,
  createInitialRuntimeSupportManifest,
  projectCurrentSupportDocument,
  readRuntimeSupportManifest,
  renderCurrentSupportSection,
  runtimeSupportManifestSchema,
  type RuntimeSupportManifestExtensionInput,
  verifyCurrentSupportDocument,
} from "../../src/runtime/support-manifest.js";
import { extendTokenCatalogSupportManifest } from "../../src/token-catalog/support.js";

const initialRuntimeSupportManifest = createInitialRuntimeSupportManifest(
  readRuntimeConfiguration({}).chain,
);
const interfaceCapabilityCatalogSchema = createCapabilityCatalogSchema(interfaceReadCapabilityRegistry);
const initialCapabilityCatalogSchema = createCapabilityCatalogSchema(readCapabilityRegistry);

const independentCanonicalJson = (value: unknown): string => {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(independentCanonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, entry]) =>
      `${JSON.stringify(key)}:${independentCanonicalJson(entry)}`).join(",")}}`;
  }
  throw new TypeError("Unsupported test canonical JSON value.");
};

const outputSchema = (schema: z.ZodType): string => independentCanonicalJson(
  JSON.parse(JSON.stringify(z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "output",
    unrepresentable: "throw",
  }))) as CanonicalJson,
);

const unavailable = {
  overall: "unavailable",
  direct: "unavailable",
  http: "unavailable",
  mcp: "unavailable",
  cli: "unavailable",
  web: "unavailable",
} as const;

const internal = {
  overall: "internal",
  direct: "internal",
  http: "unavailable",
  mcp: "unavailable",
  cli: "unavailable",
  web: "unavailable",
} as const;

const cliAvailable = {
  overall: "available",
  direct: "internal",
  http: "internal",
  mcp: "unavailable",
  cli: "available",
  web: "unavailable",
} as const;

const walletExtensionInput = {
  registrations: [
    { capabilityId: "wallet.cancel_operation", availability: cliAvailable },
    { capabilityId: "wallet.connect", availability: cliAvailable },
    { capabilityId: "wallet.disconnect", availability: cliAvailable },
    { capabilityId: "wallet.operation", availability: cliAvailable },
  ],
  changes: [{ capabilityId: "wallet.connection", availability: cliAvailable }],
} as const;

const chainExtensionInput = {
  registrations: [],
  changes: ["account.balance", "chain.status", "contract.inspect", "transaction.inspect"].map((capabilityId) => ({
    capabilityId,
    availability: internal,
  })),
};

describe("runtime support manifest authority", () => {
  it("preserves the independent runtime and owner schema projections", () => {
    for (const [schema, bytes, digest] of [
      [
        runtimeSupportManifestSchema,
        2_616,
        "44dcbdfeb0b5c4f9e57c35536f3add76f56b63fa024d781da0f10c2daba7b72a",
      ],
      [
        interfaceCapabilityCatalogSchema,
        3_328,
        "9209da8bcaf161cae40d787c8d0ae0186d4fe18381822146798ffacc15e4cc24",
      ],
      [
        ownerIdentitySchema,
        745,
        "cb63a8085d4c2f675b56ed92e01ecc966b62285c811bb7260964046c0a54ff2c",
      ],
    ] as const) {
      const projection = outputSchema(schema);
      expect(Buffer.byteLength(projection, "utf8")).toBe(bytes);
      expect(createHash("sha256").update(projection, "utf8").digest("hex")).toBe(digest);
    }
  });

  it("starts with only the five canonical read identities and official L0 evidence", () => {
    const snapshot = readRuntimeSupportManifest(initialRuntimeSupportManifest);
    expect(snapshot.contractVersion).toBe(coreContractVersion);
    expect(snapshot.chains).toEqual([{
      chainId: "eip155:4663",
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
      "wallet.connection",
    ]);
    expect(snapshot.capabilities.every((entry) => entry.availability.overall === "unavailable")).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.capabilities)).toBe(true);
  });

  it("rejects a structurally forged chain configuration before it enters support", () => {
    for (const chain of [
      { chainId: "4663" },
      { chainId: "eip155:04663" },
      { chainId: "eip155:0" },
      { chainId: "eip155:1" },
      { chainId: "eip155:4663" },
    ]) expect(() => createInitialRuntimeSupportManifest(chain as never)).toThrow();
  });

  it("accepts the complete first-consumer capability set without predeclaring it", () => {
    const wallet = extendWalletRuntimeSupportManifest(initialRuntimeSupportManifest, walletExtensionInput);
    const walletSnapshot = readRuntimeSupportManifest(wallet);
    expect(walletSnapshot.capabilities.map((entry) => entry.capabilityId)).toEqual([
      "account.balance",
      "chain.status",
      "contract.inspect",
      "transaction.inspect",
      "wallet.cancel_operation",
      "wallet.connect",
      "wallet.connection",
      "wallet.disconnect",
      "wallet.operation",
    ]);
    expect(walletSnapshot.capabilities.find((entry) => entry.capabilityId === "wallet.operation")?.availability)
      .toEqual(cliAvailable);
    expect(() => assertWalletRuntimeSupportManifestExtension(initialRuntimeSupportManifest, wallet)).not.toThrow();

    const chain = extendChainRuntimeSupportManifest(wallet, chainExtensionInput);
    for (const capabilityId of ["account.balance", "chain.status", "contract.inspect", "transaction.inspect"]) {
      expect(readRuntimeSupportManifest(chain).capabilities
        .find((entry) => entry.capabilityId === capabilityId)?.availability).toEqual(internal);
    }
    const accountAssets = extendAccountAssetSupportManifest(extendTokenCatalogSupportManifest(chain));
    const referenceMarkets = extendReferenceMarketSupportManifest(accountAssets);
    const interfaces = extendInterfaceRuntimeSupportManifest(referenceMarkets, {
      registrations: [],
      changes: [{
        capabilityId: "wallet.operation",
        availability: { ...cliAvailable, web: "available" },
      }],
    });
    expect(readRuntimeSupportManifest(interfaces).capabilities
      .find((entry) => entry.capabilityId === "wallet.operation")?.availability.web).toBe("available");
    expect(() => assertChainRuntimeSupportManifestExtension(wallet, chain)).not.toThrow();
    expect(() => assertInterfaceRuntimeSupportManifestExtension(referenceMarkets, interfaces)).not.toThrow();
    expect(() => assertWalletRuntimeSupportManifestExtension(initialRuntimeSupportManifest, chain as never))
      .toThrow("scope lineage");

    const catalog = composeCapabilityCatalog(interfaceReadCapabilityRegistry, interfaces);
    expect(catalog.capabilities.map((entry) => entry.capabilityId)).toEqual([
      "account.balance", "chain.status", "contract.inspect", "token.inspect", "transaction.inspect", "wallet.connection",
    ]);
  });

  it("rejects incomplete, invalid, duplicate, replacement, removal, and backward extensions", () => {
    expect(() => extendWalletRuntimeSupportManifest(initialRuntimeSupportManifest, {
      registrations: [], changes: [],
    })).toThrow("empty");
    expect(() => extendWalletRuntimeSupportManifest(initialRuntimeSupportManifest, {
      registrations: [{ capabilityId: "wallet.invalid.name", availability: unavailable }], changes: [],
    })).toThrow();
    expect(() => extendWalletRuntimeSupportManifest(initialRuntimeSupportManifest, {
      registrations: [{ capabilityId: "wallet.connection", availability: unavailable }], changes: [],
    })).toThrow("already registered");
    expect(() => extendWalletRuntimeSupportManifest(initialRuntimeSupportManifest, {
      registrations: [
        { capabilityId: "wallet.operation", availability: internal },
        { capabilityId: "wallet.connect", availability: internal },
      ],
      changes: [],
    })).toThrow("unique and ordered");
    expect(() => extendWalletRuntimeSupportManifest(initialRuntimeSupportManifest, {
      registrations: [{ capabilityId: "wallet.operation", availability: { direct: "internal" } }], changes: [],
    } as unknown as RuntimeSupportManifestExtensionInput)).toThrow();
    expect(() => extendWalletRuntimeSupportManifest(initialRuntimeSupportManifest, {
      registrations: [], changes: [{ capabilityId: "wallet.operation", availability: internal }],
    })).toThrow("previously registered");
    expect(() => extendWalletRuntimeSupportManifest(initialRuntimeSupportManifest, {
      registrations: [], changes: [{ capabilityId: "wallet.connection", availability: unavailable }],
    })).toThrow("does not move forward");

    const wallet = extendWalletRuntimeSupportManifest(initialRuntimeSupportManifest, walletExtensionInput);
    expect(() => extendChainRuntimeSupportManifest(wallet, {
      registrations: [],
      changes: [{ capabilityId: "wallet.operation", availability: internal }],
    })).toThrow("backward");
    expect(() => extendChainRuntimeSupportManifest(wallet, {
      registrations: [{ capabilityId: "wallet.operation", availability: cliAvailable }], changes: [],
    })).toThrow("already registered");
    expect(() => extendChainRuntimeSupportManifest(wallet, {
      registrations: [],
      changes: [{ capabilityId: "wallet.operation", availability: { ...cliAvailable, web: "available", overall: "internal" } }],
    })).toThrow();
  });

  it("normalizes hostile extension input and keeps internal schemas independent", () => {
    const hostile = new Proxy({}, {
      ownKeys(): never { throw new Error("secret-support-delta"); },
    });
    let hostileFailure: unknown;
    try { extendWalletRuntimeSupportManifest(initialRuntimeSupportManifest, hostile as never); }
    catch (error) { hostileFailure = error; }
    expect(hostileFailure).toBeInstanceOf(TypeError);
    expect(String(hostileFailure)).not.toContain("secret-support-delta");

    const manifestRuntime = (runtimeSupportManifestSchema as unknown as { _zod: { run: unknown } })._zod;
    const catalogRuntime = (initialCapabilityCatalogSchema as unknown as { _zod: { run: unknown } })._zod;
    const manifestRun = manifestRuntime.run;
    const catalogRun = catalogRuntime.run;
    try {
      manifestRuntime.run = () => ({ value: { forged: true }, issues: [] });
      catalogRuntime.run = () => ({ value: { forged: true }, issues: [] });
      expect(readRuntimeSupportManifest(initialRuntimeSupportManifest).chains[0]?.chainId).toBe("eip155:4663");
      expect(composeCapabilityCatalog(readCapabilityRegistry, initialRuntimeSupportManifest).contractVersion)
        .toBe(coreContractVersion);
    } finally {
      manifestRuntime.run = manifestRun;
      catalogRuntime.run = catalogRun;
    }
  });

  it("binds the capability catalog schema and projection to the exact supplied registry", () => {
    const wallet = extendWalletRuntimeSupportManifest(initialRuntimeSupportManifest, walletExtensionInput);
    const chain = extendChainRuntimeSupportManifest(wallet, chainExtensionInput);
    const accountAssets = extendAccountAssetSupportManifest(extendTokenCatalogSupportManifest(chain));
    const referenceMarkets = extendReferenceMarketSupportManifest(accountAssets);
    const interfaces = extendInterfaceRuntimeSupportManifest(referenceMarkets, {
      registrations: [],
      changes: [{
        capabilityId: "token.inspect",
        availability: {
          overall: "available",
          direct: "internal",
          http: "available",
          mcp: "available",
          cli: "available",
          web: "available",
        },
      }],
    });
    const catalog = composeCapabilityCatalog(interfaceReadCapabilityRegistry, interfaces);
    expect(interfaceCapabilityCatalogSchema.parse(catalog)).toEqual(catalog);
    expect(() => initialCapabilityCatalogSchema.parse(catalog)).toThrow();
    expect(() => interfaceCapabilityCatalogSchema.parse({
      ...catalog,
      capabilities: [catalog.capabilities[1], catalog.capabilities[0], ...catalog.capabilities.slice(2)],
    })).toThrow("canonical order");
    const first = catalog.capabilities[0]!;
    expect(() => interfaceCapabilityCatalogSchema.parse({
      ...catalog,
      capabilities: [{ ...first, input: { ...first.input, digest: `0x${"11".repeat(32)}` } }, ...catalog.capabilities.slice(1)],
    })).toThrow("does not match");
  });

  it("projects exactly one generated Current Support section from the manifest", () => {
    const document = [
      "# Product Policy",
      "",
      renderCurrentSupportSection(initialRuntimeSupportManifest).trimEnd(),
      "",
      "## Support Levels",
      "",
      "Support-level fixture content.",
      "",
    ].join("\n");
    expect(() => verifyCurrentSupportDocument(document, initialRuntimeSupportManifest)).not.toThrow();
    const drifted = document.replace("Available user-facing capabilities: none.", "Available user-facing capabilities: all.");
    expect(() => verifyCurrentSupportDocument(drifted, initialRuntimeSupportManifest)).toThrow("not synchronized");
    expect(projectCurrentSupportDocument(drifted, initialRuntimeSupportManifest)).toBe(document);
    expect(() => projectCurrentSupportDocument(
      `${document}\n${renderCurrentSupportSection(initialRuntimeSupportManifest)}`,
      initialRuntimeSupportManifest,
    )).toThrow("identity");
    expect(() => projectCurrentSupportDocument(
      document.replace(
        "<!-- Generated from the runtime support manifest. Do not edit this section. -->",
        "<!-- Generated from the runtime support manifest. Do not edit this section. -->\n" +
          "<!-- Generated from the runtime support manifest. Do not edit this section. -->",
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
      { code: "result_too_large", httpStatus: 422, problemTitle: "Result too large", cliExitCode: 3 },
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
    expect(toProblemDetails(createRuntimeFailure("port_conflict")).detail)
      .toBe("The fixed Little John port is owned by an incompatible process.");
    expect(toProblemDetails(createRuntimeFailure("result_too_large"))).toMatchObject({
      status: 422,
      title: "Result too large",
      code: "result_too_large",
      detail: "The canonical result exceeds the supported size.",
      retryable: false,
    });
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
