import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CapabilityBindingRegistry,
  CapabilityRegistry,
  ObservationAuthorityRegistry,
  accountBalanceCapability,
  chainStatusCapability,
  contractInspectCapability,
  createCanonicalClock,
  createCapabilityInvocationAuthority,
  createObservationAuthority,
  createObservationAuthorityIssuer,
  getCapabilityDefinitionSnapshot,
  parseCapabilitySuccess,
  parseCapabilityDataAt,
  parseEvmAddressInput,
  parseEvmChainId,
  parseHexBytes,
  parseHash32,
  parseUnsignedDecimal,
  parseUtcTimestamp,
  sourceReferenceSchema,
  transactionInspectCapability,
  walletConnectionCapability,
} from "../../src/core/index.js";
import {
  createChainOwnerApplicationFactory,
} from "../../src/chain/application.js";
import type { Erc20CallEncoder } from "../../src/chain/evm-standard.js";
import {
  createContractSourceVerificationPort,
  type ContractSourceVerificationRequest,
} from "../../src/intelligence/ports.js";
import {
  ChainRpcError,
  createBoundedRpcRequester,
  type ChainRpcMethod,
  type RpcRequester,
} from "../../src/chain/rpc.js";
import {
  createControlCredentialVerifier,
  loadOrCreateControlCredential,
} from "../../src/runtime/control-credential.js";
import { createRuntimeRouteRegistry } from "../../src/runtime/http-routing.js";
import { runtimePaths } from "../../src/runtime/paths.js";
import { createResourceOwnershipScope } from "../../src/runtime/resource-ownership.js";
import {
  createInitialRuntimeSupportManifest,
  readRuntimeSupportManifest,
  type ChainOwnerApplicationContext,
} from "../../src/runtime/index.js";
import { readRuntimeConfiguration } from "../../src/runtime/configuration.js";
import { extendWalletSupportManifest } from "../../src/wallet/application.js";
import type {
  ActiveWalletReadPort,
  ActiveWalletReadSnapshot,
} from "../../src/wallet/coordinator.js";
import { bindForHarness, createCapabilityHarness } from "../core/capability-harness.js";
import { tokenInspectCapability, tokenInspectionDigest } from "../../src/token-catalog/index.js";
import {
  stockFactoryAdmissionManifest,
} from "../../src/registry/index.js";
import {
  stockFactoryImplementationCodeFixture,
  stockFactoryProxyCodeFixture,
} from "../registry/stock-factory-fixture.js";

const directories: string[] = [];
const observedAt = parseUtcTimestamp("2026-07-15T12:00:00.000Z");
const exactRpcUrl = "https://rpc-user:rpc-password@rpc.example/private/path?project=secret";
const configuredChainId = parseEvmChainId("eip155:4663");
const runtimeConfiguration = readRuntimeConfiguration({ LITTLEJOHN_RPC_URL: exactRpcUrl });
const tokenAddress = parseEvmAddressInput(`0x${"ab".repeat(20)}`);
const rpcWord = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`;
const emptyStorageWord = rpcWord(0n);
const rpcText = (value: string) => {
  const bytes = Buffer.from(value, "utf8");
  const padding = (32 - bytes.length % 32) % 32;
  return `${rpcWord(32n)}${rpcWord(BigInt(bytes.length)).slice(2)}${bytes.toString("hex")}${"0".repeat(padding * 2)}`;
};

const createBoundedErc20Requester = (
  overrideEthCall: (data: string, requestId: string) => Response | Error | undefined,
): RpcRequester => createBoundedRpcRequester({
  url: "https://rpc.example",
  fetch: (async (_input, init) => {
    if (typeof init?.body !== "string") throw new TypeError("Expected an RPC request body.");
    const request = JSON.parse(init.body) as {
      readonly id: string;
      readonly method: ChainRpcMethod;
      readonly params: readonly unknown[];
    };
    let result: unknown;
    if (request.method === "eth_chainId") result = "0x1237";
    else if (request.method === "eth_getBlockByNumber") result = {
      number: "0x2d",
      hash: `0x${"bc".repeat(32)}`,
      timestamp: "0x687787a4",
    };
    else if (request.method === "eth_getCode") result = "0x6000";
    else if (request.method === "eth_getStorageAt") result = emptyStorageWord;
    else if (request.method === "eth_call") {
      const data = (request.params[0] as { readonly data: string }).data;
      const override = overrideEthCall(data, request.id);
      if (override instanceof Error) throw override;
      if (override !== undefined) return override;
      if (data === "0x18160ddd") result = rpcWord(7n);
      else if (data === "0x06fdde03") result = rpcText("Token");
      else if (data === "0x95d89b41") result = rpcText("TKN");
      else if (data === "0x313ce567") result = rpcWord(18n);
      else if (data.startsWith("0x70a08231")) result = rpcWord(5n);
      else throw new Error(`Unexpected eth_call data: ${data}`);
    } else throw new Error(`Unexpected RPC method: ${request.method}`);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
  }) as typeof fetch,
});

const executionRevertResponse = (requestId: string): Response => new Response(JSON.stringify({
  jsonrpc: "2.0",
  id: requestId,
  error: { code: 3, message: "execution reverted", data: "0x" },
}));

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

type RequestHandler = (
  method: ChainRpcMethod,
  params: readonly unknown[],
  signal: AbortSignal,
) => Promise<unknown>;

class FakeRequester implements RpcRequester {
  readonly calls: Array<Readonly<{
    method: ChainRpcMethod;
    params: readonly unknown[];
    signal: AbortSignal;
  }>> = [];

  constructor(private readonly handler: RequestHandler = async () => "0x1237") {}

  request<Method extends ChainRpcMethod>(
    method: Method,
    params: Parameters<RpcRequester["request"]>[1],
    signal: AbortSignal,
  ): Promise<unknown> {
    this.calls.push(Object.freeze({ method, params, signal }));
    return this.handler(method, params, signal);
  }
}

class FakeEncoder implements Erc20CallEncoder {
  balanceOfCalls = 0;
  decimalsCalls = 0;

  balanceOf(): ReturnType<Erc20CallEncoder["balanceOf"]> {
    this.balanceOfCalls += 1;
    return parseHexBytes(`0x70a08231${"0".repeat(64)}`);
  }

  decimals(): ReturnType<Erc20CallEncoder["decimals"]> {
    this.decimalsCalls += 1;
    return parseHexBytes("0x313ce567");
  }

  name(): ReturnType<Erc20CallEncoder["name"]> {
    return parseHexBytes("0x06fdde03");
  }

  symbol(): ReturnType<Erc20CallEncoder["symbol"]> {
    return parseHexBytes("0x95d89b41");
  }

  totalSupply(): ReturnType<Erc20CallEncoder["totalSupply"]> {
    return parseHexBytes("0x18160ddd");
  }
}

const createContext = async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "littlejohn-chain-application-"));
  directories.push(directory);
  const paths = runtimePaths(directory);
  const credential = await loadOrCreateControlCredential(directory, paths.controlCredential);
  const routes = createRuntimeRouteRegistry({
    controlVerifier: createControlCredentialVerifier(credential),
  });
  const clock = createCanonicalClock(() => observedAt);
  const rpcAuthority = createObservationAuthority({
    clock,
    sourceClass: "chain_rpc",
    owner: "user_configured",
    reference: sourceReferenceSchema.parse({
      kind: "public",
      sourceId: "rpc_chain_application_test",
      uri: "https://rpc.example/",
    }),
  });
  const contractVerification = createObservationAuthorityIssuer({
    clock,
    sourceClass: "contract_verification_service",
    owner: "Sourcify",
    referenceKind: "public",
    sourceId: "sourcify-v2",
  });
  const walletHarness = createCapabilityHarness(() => observedAt);
  const disconnected = parseCapabilityDataAt(
    walletConnectionCapability,
    { status: "disconnected", reason: "no_session" },
    observedAt,
  );
  const walletConnection = bindForHarness(
    walletConnectionCapability,
    walletHarness,
    async () => ({ status: "success", data: disconnected }),
  );
  let walletCaptureCount = 0;
  const activeWallet: ActiveWalletReadPort = Object.freeze({
    capture(): ActiveWalletReadSnapshot {
      walletCaptureCount += 1;
      return Object.freeze({
        connection: disconnected,
        connectionRevision: parseUnsignedDecimal("0"),
      });
    },
  });
  const ownerController = new AbortController();
  const startupScope = createResourceOwnershipScope();
  const context: ChainOwnerApplicationContext<ActiveWalletReadPort> = Object.freeze({
    routes,
    signal: ownerController.signal,
    startupResources: startupScope.resources,
    supportManifest: extendWalletSupportManifest(
      createInitialRuntimeSupportManifest(runtimeConfiguration.chain),
    ),
    walletConnection: Object.freeze({ connection: walletConnection }),
    activeWallet,
    chain: Object.freeze({
      configuration: runtimeConfiguration.rpc,
      contractSourceVerification: createContractSourceVerificationPort({
        observationAuthorityRegistration: contractVerification.registration,
        async inspect(request: ContractSourceVerificationRequest) {
          const reference = sourceReferenceSchema.parse({
            kind: "public",
            sourceId: "sourcify-v2",
            uri: `https://sourcify.example/contract/${request.address}`,
          });
          if (reference.kind !== "public") throw new TypeError("Expected public source reference.");
          return Object.freeze({
            status: "no_record_observed" as const,
            reference,
            observationAuthority: contractVerification.issue(reference),
          });
        },
      }),
      sourceAuthority: Object.freeze({
        sourceOwner: "user_configured" as const,
        publicOrigin: "https://rpc.example",
        sourceId: "rpc_chain_application_test",
        configurationDigest: "A".repeat(43),
        observationAuthority: rpcAuthority,
      }),
      capabilityAuthority: Object.freeze({
        clock,
        invocationAuthority: createCapabilityInvocationAuthority(clock, configuredChainId),
        invocationPorts: Object.freeze({
          observations: new ObservationAuthorityRegistry(
            clock,
            [rpcAuthority, contractVerification.registration],
          ),
        }),
      }),
    }),
  });
  return Object.freeze({
    context,
    ownerController,
    startupScope,
    get walletCaptureCount(): number { return walletCaptureCount; },
  });
};

const readDefinitions = Object.freeze([
  accountBalanceCapability,
  chainStatusCapability,
  contractInspectCapability,
  transactionInspectCapability,
] as const);

const internalDirectAvailability = Object.freeze({
  overall: "internal",
  direct: "internal",
  http: "unavailable",
  mcp: "unavailable",
  cli: "unavailable",
  web: "unavailable",
});

describe("chain owner application", () => {
  it("inspects required and optional ERC-20 evidence at one canonical block", async () => {
    const blockHash = `0x${"cd".repeat(32)}`;
    const blockTimestampSeconds = BigInt(Date.parse("2026-07-15T11:59:00.000Z") / 1_000);
    const requester = new FakeRequester(async (method, params) => {
      if (method === "eth_chainId") return "0x1237";
      if (method === "eth_getBlockByNumber") return {
        number: "0x2a",
        hash: blockHash,
        timestamp: `0x${blockTimestampSeconds.toString(16)}`,
      };
      if (method === "eth_getCode") return "0x6000";
      if (method === "eth_getStorageAt") return emptyStorageWord;
      if (method === "eth_call") {
        const call = params[0] as { readonly data: string };
        if (call.data === "0x18160ddd") return rpcWord(1_000_000n);
        if (call.data === "0x06fdde03") return rpcText("Example Token");
        if (call.data === "0x95d89b41") return rpcText("EXT");
        if (call.data === "0x313ce567") return rpcWord(18n);
        if (call.data.startsWith("0x01ffc9a7")) return rpcWord(0n);
      }
      throw new Error(`Unexpected RPC method: ${method}`);
    });
    const state = await createContext();
    const application = await createChainOwnerApplicationFactory(
      () => requester,
      async () => new FakeEncoder(),
    )(state.context);
    const bindings = new CapabilityBindingRegistry(
      new CapabilityRegistry([tokenInspectCapability]),
      [application.tokenInspection],
    );

    const result = await bindings.invoke(tokenInspectCapability, {
      asset: { kind: "erc20", chainId: configuredChainId, address: tokenAddress },
      block: { kind: "latest" },
    }, { signal: new AbortController().signal });

    expect(result).toMatchObject({
      ok: true,
      data: {
        asset: { kind: "erc20", chainId: configuredChainId, address: tokenAddress },
        analysis: {
          block: { blockNumber: "42", blockHash },
          targetRuntimeCode: { byteLength: "2" },
        },
        totalSupply: { raw: "1000000", decimals: { status: "available", value: "18" } },
        metadata: {
          name: { status: "available", value: "Example Token" },
          symbol: { status: "available", value: "EXT" },
          decimalsReadFailure: null,
        },
      },
    });
    if (result.ok) {
      const digest = tokenInspectionDigest(result);
      const changed = structuredClone(result);
      changed.data.totalSupply.raw = "1000001" as typeof changed.data.totalSupply.raw;
      expect(() => tokenInspectionDigest(changed)).toThrow("Token inspection success is invalid");
      expect(tokenInspectionDigest(result)).toBe(digest);
    }
    const stateReferences = requester.calls
      .flatMap((call) => call.method === "eth_getStorageAt"
        ? [call.params[2]]
        : call.method === "eth_getCode" || call.method === "eth_call"
          ? [call.params[1]]
          : []);
    expect(stateReferences).toHaveLength(9);
    expect(stateReferences.every((reference) => JSON.stringify(reference) === JSON.stringify({
      blockHash,
      requireCanonical: true,
    }))).toBe(true);
    await application.close();
  });

  it("keeps optional ERC-20 failures explicit without inventing metadata or decimals", async () => {
    const blockHash = `0x${"ef".repeat(32)}`;
    const requester = createBoundedRpcRequester({
      url: "https://rpc.example",
      fetch: (async (_input, init) => {
        if (typeof init?.body !== "string") throw new TypeError("Expected an RPC request body.");
        const request = JSON.parse(init.body) as {
          readonly id: string;
          readonly method: ChainRpcMethod;
          readonly params: readonly unknown[];
        };
        let result: unknown;
        if (request.method === "eth_chainId") result = "0x1237";
        else if (request.method === "eth_getBlockByNumber") result = {
          number: "0x2b",
          hash: blockHash,
          timestamp: "0x687787a4",
        };
        else if (request.method === "eth_getCode") result = "0x6000";
        else if (request.method === "eth_getStorageAt") result = emptyStorageWord;
        else if (request.method === "eth_call") {
          const call = request.params[0] as { readonly data: string };
          if (call.data === "0x18160ddd") result = rpcWord(7n);
          else if (call.data === "0x06fdde03") {
            return new Response(JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              error: { code: 3, message: "execution reverted", data: "0x" },
            }));
          } else if (call.data === "0x95d89b41") result = rpcWord(1n);
          else if (call.data === "0x313ce567") result = rpcWord(256n);
          else throw new Error("Unexpected eth_call data.");
        } else throw new Error(`Unexpected RPC method: ${request.method}`);
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
      }) as typeof fetch,
    });
    const state = await createContext();
    const application = await createChainOwnerApplicationFactory(
      () => requester,
      async () => new FakeEncoder(),
    )(state.context);
    const bindings = new CapabilityBindingRegistry(
      new CapabilityRegistry([tokenInspectCapability]),
      [application.tokenInspection],
    );
    const input = {
      asset: { kind: "erc20", chainId: configuredChainId, address: tokenAddress },
      block: { kind: "latest" as const },
    };
    const result = await bindings.invoke(
      tokenInspectCapability,
      input,
      { signal: new AbortController().signal },
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        totalSupply: { raw: "7", decimals: { status: "unavailable", reason: "missing" } },
        metadata: {
          name: { status: "unavailable", reason: "call_failed" },
          symbol: { status: "unavailable", reason: "malformed" },
          decimalsReadFailure: "malformed",
        },
      },
    });
    if (result.ok) {
      expect(result.evidence.conclusions.find(({ id }) => id === "decimals_observed"))
        .toMatchObject({ status: "unavailable", reason: "source_inconsistent" });
      expect(result.evidence.conclusions.find(({ id }) => id === "name_observed"))
        .toMatchObject({ status: "unavailable", reason: "source_failed" });
      expect(result.evidence.conclusions.find(({ id }) => id === "symbol_observed"))
        .toMatchObject({ status: "unavailable", reason: "source_inconsistent" });
      expect(result.warnings.map((warning) => warning.code)).toEqual([
        "decimals_unavailable",
        "partial_result",
      ]);
      const partial = result.warnings.find((warning) => warning.code === "partial_result");
      expect(partial?.observationIds).toEqual(expect.arrayContaining([
        result.data.metadata.name.observationId,
        result.data.metadata.symbol.observationId,
      ]));
      const changedAuthorship = {
        ...result,
        data: {
          ...result.data,
          metadata: {
            ...result.data.metadata,
            decimalsReadFailure: "call_failed" as const,
          },
        },
        evidence: {
          ...result.evidence,
          conclusions: result.evidence.conclusions.map((conclusion) =>
            conclusion.id === "decimals_observed"
              ? { ...conclusion, reason: "source_failed" as const }
              : conclusion),
        },
      };
      expect(() => parseCapabilitySuccess(
        tokenInspectCapability,
        input,
        changedAuthorship,
      )).toThrow();
    }
    await application.close();
  });

  it.each([
    ["name", "0x06fdde03", "symbol"],
    ["symbol", "0x95d89b41", "name"],
  ] as const)("links a %s-only metadata failure without linking available metadata", async (
    unavailableField,
    revertedSelector,
    availableField,
  ) => {
    const requester = createBoundedErc20Requester((data, requestId) =>
      data === revertedSelector ? executionRevertResponse(requestId) : undefined);
    const state = await createContext();
    const application = await createChainOwnerApplicationFactory(
      () => requester,
      async () => new FakeEncoder(),
    )(state.context);
    const bindings = new CapabilityBindingRegistry(
      new CapabilityRegistry([tokenInspectCapability]),
      [application.tokenInspection],
    );

    const result = await bindings.invoke(tokenInspectCapability, {
      asset: { kind: "erc20", chainId: configuredChainId, address: tokenAddress },
      block: { kind: "latest" },
    }, { signal: new AbortController().signal });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const partial = result.warnings.find((warning) => warning.code === "partial_result");
      expect(partial?.observationIds).toContain(
        result.data.metadata[unavailableField].observationId,
      );
      expect(partial?.observationIds).not.toContain(
        result.data.metadata[availableField].observationId,
      );
    }
    await application.close();
  });

  it("publishes an incomplete optional RPC read without attributing it to the source", async () => {
    const requester = createBoundedErc20Requester((data) =>
      data === "0x313ce567" ? new Error("PRIVATE_FETCH_CAUSE") : undefined);
    const state = await createContext();
    const application = await createChainOwnerApplicationFactory(
      () => requester,
      async () => new FakeEncoder(),
    )(state.context);
    const bindings = new CapabilityBindingRegistry(
      new CapabilityRegistry([tokenInspectCapability]),
      [application.tokenInspection],
    );

    await expect(bindings.invoke(tokenInspectCapability, {
      asset: { kind: "erc20", chainId: configuredChainId, address: tokenAddress },
      block: { kind: "latest" },
    }, { signal: new AbortController().signal })).resolves.toMatchObject({
      ok: false,
      error: { code: "chain_response_unavailable" },
    });
    await application.close();
  });

  it("keeps an optional decimals execution revert as an unavailable observation", async () => {
    const requester = createBoundedErc20Requester((data, requestId) =>
      data === "0x313ce567" ? executionRevertResponse(requestId) : undefined);
    const state = await createContext();
    const application = await createChainOwnerApplicationFactory(
      () => requester,
      async () => new FakeEncoder(),
    )(state.context);
    const bindings = new CapabilityBindingRegistry(
      new CapabilityRegistry([tokenInspectCapability]),
      [application.tokenInspection],
    );

    const result = await bindings.invoke(tokenInspectCapability, {
      asset: { kind: "erc20", chainId: configuredChainId, address: tokenAddress },
      block: { kind: "latest" },
    }, { signal: new AbortController().signal });
    expect(result).toMatchObject({
      ok: true,
      data: {
        totalSupply: {
          raw: "7",
          decimals: { status: "unavailable", reason: "missing" },
        },
        metadata: { decimalsReadFailure: "call_failed" },
      },
    });
    if (result.ok) {
      expect(result.warnings.map(({ code }) => code)).toContain("decimals_unavailable");
      expect(result.evidence.conclusions.find(({ id }) => id === "decimals_observed"))
        .toMatchObject({ status: "unavailable", reason: "source_failed" });
    }
    await application.close();
  });

  it("fails the inspection when required totalSupply execution reverts", async () => {
    const requester = createBoundedErc20Requester((data, requestId) =>
      data === "0x18160ddd" ? executionRevertResponse(requestId) : undefined);
    const state = await createContext();
    const application = await createChainOwnerApplicationFactory(
      () => requester,
      async () => new FakeEncoder(),
    )(state.context);
    const bindings = new CapabilityBindingRegistry(
      new CapabilityRegistry([tokenInspectCapability]),
      [application.tokenInspection],
    );

    await expect(bindings.invoke(tokenInspectCapability, {
      asset: { kind: "erc20", chainId: configuredChainId, address: tokenAddress },
      block: { kind: "latest" },
    }, { signal: new AbortController().signal })).resolves.toMatchObject({
      ok: false,
      error: {
        code: "token_total_supply_reverted",
        category: "domain",
        message: "The token contract reverted the required totalSupply call.",
        retryable: false,
        issues: [],
      },
    });
    await application.close();
  });

  it("keeps a balanceOf execution revert as an explicit partial token result", async () => {
    const observedCalls: string[] = [];
    const requester = createBoundedErc20Requester((data, requestId) => {
      observedCalls.push(data);
      return data.startsWith("0x70a08231") ? executionRevertResponse(requestId) : undefined;
    });
    const state = await createContext();
    const application = await createChainOwnerApplicationFactory(
      () => requester,
      async () => new FakeEncoder(),
    )(state.context);
    const bindings = new CapabilityBindingRegistry(
      new CapabilityRegistry([accountBalanceCapability]),
      [application.chainReads.accountBalance],
    );

    const result = await bindings.invoke(accountBalanceCapability, {
      account: { kind: "address", address: `0x${"11".repeat(20)}` },
      includeNative: false,
      tokens: [tokenAddress],
      block: { kind: "latest" },
    }, { signal: new AbortController().signal });
    expect(result).toMatchObject({
      ok: true,
      data: {
        tokens: [{
          asset: { kind: "erc20", chainId: configuredChainId, address: tokenAddress },
          result: { status: "unavailable", errorCode: "source_unavailable" },
        }],
      },
      evidence: { coverage: { status: "partial" } },
    });
    if (result.ok) {
      expect(result.warnings.map(({ code }) => code)).toContain("partial_result");
    }
    expect(observedCalls).toHaveLength(1);
    expect(observedCalls[0]).toMatch(/^0x70a08231/u);
    await application.close();
  });

  it("keeps oversized and control-character metadata unavailable without truncation", async () => {
    const blockHash = `0x${"ad".repeat(32)}`;
    const requester = new FakeRequester(async (method, params) => {
      if (method === "eth_chainId") return "0x1237";
      if (method === "eth_getBlockByNumber") return {
        number: "0x2c",
        hash: blockHash,
        timestamp: "0x687787a4",
      };
      if (method === "eth_getCode") return "0x6000";
      if (method === "eth_getStorageAt") return emptyStorageWord;
      if (method === "eth_call") {
        const call = params[0] as { readonly data: string };
        if (call.data === "0x18160ddd") return rpcWord(7n);
        if (call.data === "0x06fdde03") return rpcText("line\nbreak");
        if (call.data === "0x95d89b41") return rpcText("a".repeat(513));
        if (call.data === "0x313ce567") return rpcWord(18n);
        if (call.data.startsWith("0x01ffc9a7")) return rpcWord(0n);
      }
      throw new Error(`Unexpected RPC method: ${method}`);
    });
    const state = await createContext();
    const application = await createChainOwnerApplicationFactory(
      () => requester,
      async () => new FakeEncoder(),
    )(state.context);
    const bindings = new CapabilityBindingRegistry(
      new CapabilityRegistry([tokenInspectCapability]),
      [application.tokenInspection],
    );

    const result = await bindings.invoke(tokenInspectCapability, {
      asset: { kind: "erc20", chainId: configuredChainId, address: tokenAddress },
      block: { kind: "latest" },
    }, { signal: new AbortController().signal });
    expect(result).toMatchObject({
      ok: true,
      data: {
        metadata: {
          name: { status: "unavailable", reason: "unsafe_text" },
          symbol: { status: "unavailable", reason: "unsafe_text" },
        },
      },
    });
    if (result.ok) {
      expect(result.evidence.conclusions.find(({ id }) => id === "name_observed"))
        .toMatchObject({ status: "established", reason: "observed" });
      expect(result.evidence.conclusions.find(({ id }) => id === "symbol_observed"))
        .toMatchObject({ status: "established", reason: "observed" });
      const partial = result.warnings.find(({ code }) => code === "partial_result");
      expect(partial?.observationIds).not.toContain(result.data.metadata.name.observationId);
      expect(partial?.observationIds).not.toContain(result.data.metadata.symbol.observationId);
    }
    await application.close();
  });

  it("preserves a fatal source inconsistency and drains every sibling call before completion", async () => {
    const blockHash = `0x${"ac".repeat(32)}`;
    let delayedStarted = 0;
    let metadataAborted = 0;
    let totalSupplyAborted = 0;
    let markStarted!: () => void;
    const started = new Promise<void>((resolveStarted) => { markStarted = resolveStarted; });
    let markMetadataAborted!: () => void;
    const metadataSiblingsAborted = new Promise<void>((resolveAborted) => {
      markMetadataAborted = resolveAborted;
    });
    let markTotalSupplyAborted!: () => void;
    const totalSupplySiblingAborted = new Promise<void>((resolveAborted) => {
      markTotalSupplyAborted = resolveAborted;
    });
    const releaseMetadata: Array<() => void> = [];
    let releaseTotalSupply!: () => void;
    const requester = new FakeRequester(async (method, params, signal) => {
      if (method === "eth_chainId") return "0x1237";
      if (method === "eth_getBlockByNumber") return {
        number: "0x2c",
        hash: blockHash,
        timestamp: "0x687787a4",
      };
      if (method === "eth_getCode") return "0x6000";
      if (method === "eth_getStorageAt") return emptyStorageWord;
      if (method === "eth_call") {
        const call = params[0] as { readonly data: string };
        if (call.data.startsWith("0x01ffc9a7")) return rpcWord(0n);
        if (call.data === "0x06fdde03") throw new ChainRpcError("source_inconsistent");
        return await new Promise<never>((_resolve, reject) => {
          const onAbort = (): void => {
            if (call.data === "0x18160ddd") {
              totalSupplyAborted += 1;
              markTotalSupplyAborted();
            } else {
              metadataAborted += 1;
              if (metadataAborted === 2) markMetadataAborted();
            }
          };
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
          const release = (): void => reject(new ChainRpcError("request_aborted"));
          if (call.data === "0x18160ddd") releaseTotalSupply = release;
          else releaseMetadata.push(release);
          delayedStarted += 1;
          if (delayedStarted === 3) markStarted();
        });
      }
      throw new Error(`Unexpected RPC method: ${method}`);
    });
    const state = await createContext();
    const application = await createChainOwnerApplicationFactory(
      () => requester,
      async () => new FakeEncoder(),
    )(state.context);
    const bindings = new CapabilityBindingRegistry(
      new CapabilityRegistry([tokenInspectCapability]),
      [application.tokenInspection],
    );

    let invocationSettled = false;
    const invocation = bindings.invoke(tokenInspectCapability, {
      asset: { kind: "erc20", chainId: configuredChainId, address: tokenAddress },
      block: { kind: "latest" },
    }, { signal: new AbortController().signal }).then((result) => {
      invocationSettled = true;
      return result;
    });
    await started;
    await metadataSiblingsAborted;
    await new Promise<void>((resolveTurn) => { setImmediate(resolveTurn); });
    expect(invocationSettled).toBe(false);
    expect(totalSupplyAborted).toBe(0);

    for (const release of releaseMetadata) release();
    await totalSupplySiblingAborted;
    await new Promise<void>((resolveTurn) => { setImmediate(resolveTurn); });
    expect(invocationSettled).toBe(false);
    releaseTotalSupply();
    await expect(invocation).resolves.toMatchObject({
      ok: false,
      error: { code: "source_inconsistent" },
    });
    await application.close();
    expect(metadataAborted).toBe(2);
    expect(totalSupplyAborted).toBe(1);
  });

  it("fails closed for a wrong input chain and for missing runtime code", async () => {
    const state = await createContext();
    const requester = new FakeRequester(async (method, params) => {
      if (method === "eth_chainId") return "0x1237";
      if (method === "eth_getBlockByNumber") return {
        number: "0x2c",
        hash: `0x${"01".repeat(32)}`,
        timestamp: "0x687787a4",
      };
      if (method === "eth_getCode") return "0x";
      if (method === "eth_call") {
        const call = params[0] as { readonly data: string };
        if (call.data === "0x18160ddd") return rpcWord(7n);
        if (call.data === "0x06fdde03") return rpcText("Token");
        if (call.data === "0x95d89b41") return rpcText("TKN");
        if (call.data === "0x313ce567") return rpcWord(18n);
        if (call.data.startsWith("0x01ffc9a7")) return rpcWord(0n);
      }
      throw new Error(`Unexpected RPC method: ${method}`);
    });
    const application = await createChainOwnerApplicationFactory(
      () => requester,
      async () => new FakeEncoder(),
    )(state.context);
    const bindings = new CapabilityBindingRegistry(
      new CapabilityRegistry([tokenInspectCapability]),
      [application.tokenInspection],
    );

    await expect(bindings.invoke(tokenInspectCapability, {
      asset: { kind: "erc20", chainId: "eip155:1", address: tokenAddress },
      block: { kind: "latest" },
    }, { signal: new AbortController().signal })).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
    await expect(bindings.invoke(tokenInspectCapability, {
      asset: { kind: "erc20", chainId: configuredChainId, address: tokenAddress },
      block: { kind: "latest" },
    }, { signal: new AbortController().signal })).resolves.toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    await application.close();
  });

  it("rejects a wrong configured RPC chain before either composite reader requests a block", async () => {
    const requester = new FakeRequester(async (method) => {
      if (method === "eth_chainId") return "0x1";
      throw new Error(`Unexpected RPC method after a wrong chain ID: ${method}`);
    });
    const state = await createContext();
    const application = await createChainOwnerApplicationFactory(
      () => requester,
      async () => new FakeEncoder(),
    )(state.context);

    await expect(application.invocations.run(
      new AbortController().signal,
      (context) => application.accountAssetReads.resolveCurrentBlock(context),
    )).rejects.toMatchObject({ failure: { error: { code: "source_inconsistent" } } });
    expect(requester.calls.map(({ method }) => method)).toEqual(["eth_chainId"]);

    requester.calls.splice(0);
    await expect(application.invocations.run(
      new AbortController().signal,
      (context) => application.referenceMarketReads.resolveCurrentBlock(context),
    )).rejects.toMatchObject({ failure: { error: { code: "source_inconsistent" } } });
    expect(requester.calls.map(({ method }) => method)).toEqual(["eth_chainId"]);

    await application.close();
  });

  it("returns a canonical failure when token-addition chain work is stopped before admission", async () => {
    const requester = new FakeRequester();
    const state = await createContext();
    const application = await createChainOwnerApplicationFactory(
      () => requester,
      async () => new FakeEncoder(),
    )(state.context);
    const caller = new AbortController();
    caller.abort();

    await expect(application.tokenAdditionReads.inspectAndVerifyOfficial({
      asset: { kind: "erc20", chainId: configuredChainId, address: tokenAddress },
      officialMember: null,
    }, caller.signal)).resolves.toMatchObject({
      ok: false,
      error: {
        code: "request_aborted",
        category: "transport",
      },
    });
    expect(requester.calls).toEqual([]);
    await application.close();
  });

  it("uses one remaining deadline and one exact block for token inspection and official verification", async () => {
    vi.useFakeTimers();
    const blockHash = `0x${"cd".repeat(32)}` as const;
    const assetUid = parseHash32(`0x${"12".repeat(32)}`);
    const implementationWord =
      `0x${"0".repeat(24)}${stockFactoryAdmissionManifest.implementationAddress.slice(2)}`;
    const mappedAddressWord = `0x${"0".repeat(24)}${tokenAddress.slice(2)}`;
    let tokenCodeReads = 0;
    let releaseInspectionCode!: () => void;
    const inspectionCodeReleased = new Promise<void>((resolveReleased) => {
      releaseInspectionCode = resolveReleased;
    });
    let markInspectionCodeStarted!: () => void;
    const inspectionCodeStarted = new Promise<void>((resolveStarted) => {
      markInspectionCodeStarted = resolveStarted;
    });
    const requester = new FakeRequester(async (method, params) => {
      if (method === "eth_chainId") return "0x1237";
      if (method === "eth_getBlockByNumber") {
        return { number: "0x2d", hash: blockHash, timestamp: "0x687787a4" };
      }
      if (method === "eth_getCode") {
        const address = params[0];
        if (address === tokenAddress) {
          tokenCodeReads += 1;
          if (tokenCodeReads === 1) {
            markInspectionCodeStarted();
            await inspectionCodeReleased;
          }
          return "0x6000";
        }
        if (address === stockFactoryAdmissionManifest.proxyAddress) {
          return stockFactoryProxyCodeFixture;
        }
        if (address === stockFactoryAdmissionManifest.implementationAddress) {
          return stockFactoryImplementationCodeFixture;
        }
      }
      if (method === "eth_getStorageAt") {
        if (params[0] === tokenAddress) return emptyStorageWord;
        expect(params[0]).toBe(stockFactoryAdmissionManifest.proxyAddress);
        expect(params[1]).toBe(stockFactoryAdmissionManifest.implementationSlot);
        return implementationWord;
      }
      if (method === "eth_call") {
        const call = params[0] as { readonly to: string; readonly data: string };
        if (call.to === stockFactoryAdmissionManifest.proxyAddress) {
          return mappedAddressWord;
        }
        if (call.data === "0x18160ddd") return rpcWord(7n);
        if (call.data === "0x06fdde03") return rpcText("Token");
        if (call.data === "0x95d89b41") return rpcText("TKN");
        if (call.data === "0x313ce567") return rpcWord(18n);
        if (call.data.startsWith("0x01ffc9a7")) return rpcWord(0n);
      }
      throw new Error(`Unexpected RPC method: ${method}`);
    });
    const state = await createContext();
    const application = await createChainOwnerApplicationFactory(
      () => requester,
      async () => new FakeEncoder(),
    )(state.context);

    const pending = application.tokenAdditionReads.inspectAndVerifyOfficial({
      asset: { kind: "erc20", chainId: configuredChainId, address: tokenAddress },
      officialMember: { assetUid, contractAddress: tokenAddress },
    }, new AbortController().signal);
    await inspectionCodeStarted;
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(vi.getTimerCount()).toBe(1);
    releaseInspectionCode();

    const result = await pending;
    expect(result).toMatchObject({
      inspection: {
        ok: true,
        data: {
          asset: { kind: "erc20", chainId: configuredChainId, address: tokenAddress },
          analysis: { block: { blockHash } },
        },
      },
      officialVerification: {
        assetUid,
        contractAddress: tokenAddress,
        block: { blockHash },
      },
    });
    if ("inspection" in result && result.inspection.ok) {
      expect(result.officialVerification?.block).toEqual(result.inspection.data.analysis.block);
    }
    const stateReferences = requester.calls.flatMap(({ method, params }) => {
      if (method === "eth_call") return [params[1]];
      if (method === "eth_getCode") return [params[1]];
      if (method === "eth_getStorageAt") return [params[2]];
      return [];
    }).filter((value) => value !== undefined);
    expect(new Set(stateReferences).size).toBe(1);
    expect(stateReferences[0]).toMatchObject({ blockHash, requireCanonical: true });
    expect(vi.getTimerCount()).toBe(0);
    await application.close();
  });

  it("composes the exact RPC URL, unchanged routes, internal support, and canonical bindings without startup reads", async () => {
    const requester = new FakeRequester();
    const encoder = new FakeEncoder();
    const requestedUrls: string[] = [];
    let encoderFactoryCalls = 0;
    const createApplication = createChainOwnerApplicationFactory(
      (url) => {
        requestedUrls.push(url);
        return requester;
      },
      async () => {
        encoderFactoryCalls += 1;
        return encoder;
      },
    );
    const state = await createContext();
    const application = await createApplication(state.context);

    expect(requestedUrls).toEqual([exactRpcUrl]);
    expect(encoderFactoryCalls).toBe(1);
    expect(requester.calls).toEqual([]);
    expect(encoder.balanceOfCalls).toBe(0);
    expect(encoder.decimalsCalls).toBe(0);
    expect(state.walletCaptureCount).toBe(0);
    expect(application.routes).toBe(state.context.routes);
    expect(Object.keys(application).sort()).toEqual([
      "accountAssetReads",
      "chainReads",
      "close",
      "invocations",
      "officialAssetReads",
      "protocolReads",
      "referenceMarketReads",
      "routes",
      "supportManifest",
      "tokenAdditionReads",
      "tokenInspection",
    ]);
    expect(JSON.stringify(application)).not.toContain("rpc-password");

    const parent = readRuntimeSupportManifest(state.context.supportManifest);
    const manifest = readRuntimeSupportManifest(application.supportManifest);
    expect(manifest.capabilities).toHaveLength(parent.capabilities.length);
    const readIds = readDefinitions.map((definition) =>
      getCapabilityDefinitionSnapshot(definition).capabilityId);
    expect(readIds).toEqual([
      "account.balance",
      "chain.status",
      "contract.inspect",
      "transaction.inspect",
    ]);
    for (const capabilityId of readIds) {
      expect(manifest.capabilities.find((entry) => entry.capabilityId === capabilityId)?.availability)
        .toEqual(internalDirectAvailability);
    }
    for (const parentEntry of parent.capabilities) {
      if (readIds.includes(parentEntry.capabilityId)) continue;
      expect(manifest.capabilities.find((entry) => entry.capabilityId === parentEntry.capabilityId))
        .toEqual(parentEntry);
    }

    expect(() => new CapabilityBindingRegistry(
      new CapabilityRegistry(readDefinitions),
      [
        application.chainReads.accountBalance,
        application.chainReads.chainStatus,
        application.chainReads.contractInspect,
        application.chainReads.transactionInspect,
      ],
    )).not.toThrow();

    await application.close();
  });

  it("does not report an application when dependency creation fails", async () => {
    const requester = new FakeRequester();
    let encoderFactoryCalls = 0;
    const createApplication = createChainOwnerApplicationFactory(
      () => requester,
      async () => {
        encoderFactoryCalls += 1;
        throw new Error("encoder acquisition failed");
      },
    );
    const state = await createContext();

    await expect(createApplication(state.context)).rejects.toThrow("encoder acquisition failed");
    expect(encoderFactoryCalls).toBe(1);
    expect(requester.calls).toEqual([]);
    expect(state.walletCaptureCount).toBe(0);
  });

  it("aborts and drains active work, closes idempotently, and rejects later invocations without another RPC", async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolveStarted) => { markStarted = resolveStarted; });
    let markAborted!: () => void;
    const aborted = new Promise<void>((resolveAborted) => { markAborted = resolveAborted; });
    let releaseRequest!: () => void;
    let abortCount = 0;
    const requester = new FakeRequester(async (_method, _params, signal) =>
      await new Promise<never>((_resolve, reject) => {
        releaseRequest = () => reject(new ChainRpcError("request_aborted"));
        const onAbort = (): void => {
          abortCount += 1;
          markAborted();
        };
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
        markStarted();
      }));
    const state = await createContext();
    const application = await createChainOwnerApplicationFactory(
      () => requester,
      async () => new FakeEncoder(),
    )(state.context);
    const bindings = new CapabilityBindingRegistry(
      new CapabilityRegistry([chainStatusCapability]),
      [application.chainReads.chainStatus],
    );
    const invocation = bindings.invoke(chainStatusCapability, {}, {
      signal: new AbortController().signal,
    });
    await started;

    let firstCloseSettled = false;
    const firstClose = Promise.resolve(application.close()).then(() => { firstCloseSettled = true; });
    const secondClose = Promise.resolve(application.close());
    await aborted;
    await new Promise<void>((resolveTurn) => { setImmediate(resolveTurn); });
    expect(firstCloseSettled).toBe(false);
    expect(abortCount).toBe(1);

    releaseRequest();
    await Promise.all([firstClose, secondClose]);
    await expect(invocation).resolves.toMatchObject({
      ok: false,
      error: { code: "runtime_state_unavailable" },
    });
    await expect(application.close()).resolves.toBeUndefined();

    await expect(bindings.invoke(chainStatusCapability, {}, {
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      ok: false,
      error: { code: "runtime_state_unavailable" },
    });
    expect(requester.calls).toHaveLength(1);
  });
});
