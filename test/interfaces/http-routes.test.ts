import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { createErc20CallEncoder, type Erc20CallEncoder } from "../../src/chain/evm-standard.js";
import { extendChainSupportManifest } from "../../src/chain/application.js";
import { extendAccountAssetSupportManifest } from "../../src/account-assets/support.js";
import {
  walletConnectionCapability,
  walletConnectionEvidence,
  type HandlerInvocationContext,
  type ObservationWriter,
} from "../../src/core/index.js";
import {
  extendPublicInterfaceRoutes,
  publicInterfaceRoutes,
} from "../../src/interfaces/http-routes.js";
import { extendInterfaceSupportManifest } from "../../src/interfaces/support.js";
import { extendReferenceMarketSupportManifest } from "../../src/market-portfolio/support.js";
import { composeInterfaceCapabilityCatalog } from "../../src/interfaces/support.js";
import { extendTokenCatalogSupportManifest } from "../../src/token-catalog/support.js";
import {
  createControlCredentialVerifier,
  loadOrCreateControlCredential,
} from "../../src/runtime/control-credential.js";
import {
  createRuntimeRouteRegistry,
  type NormalizedRouteResult,
  type RouteMethod,
  type RuntimeRouteRegistry,
} from "../../src/runtime/http-routing.js";
import { fixedHostHeader } from "../../src/runtime/http-boundary.js";
import { runtimePaths } from "../../src/runtime/paths.js";
import {
  createInitialRuntimeSupportManifest,
  type WalletConnectionReadCapabilityPort,
} from "../../src/runtime/index.js";
import { readRuntimeConfiguration } from "../../src/runtime/configuration.js";
import { extendWalletSupportManifest } from "../../src/wallet/application.js";
import { bindForHarness, createCapabilityHarness } from "../core/capability-harness.js";
import {
  ScriptedRpc,
  createChainHandlerHarness,
  disconnectedWallet,
  rpcValue,
  type ChainHandlerHarness,
} from "../chain/handler-harness.js";
import { tokenCatalogInterfaceHarnessPorts } from "../token-catalog/interface-harness.js";
import {
  extendUniswapV2ProtocolHarnessManifest,
  uniswapV2QuoteHarnessBinding,
} from "../protocols/interface-harness.js";

const directories: string[] = [];
const blockHash = `0x${"88".repeat(32)}`;
let encoder: Erc20CallEncoder;
const chainHarnesses: ChainHandlerHarness[] = [];

beforeAll(async () => { encoder = await createErc20CallEncoder(); });

afterEach(async () => {
  await Promise.all(chainHarnesses.splice(0).map((harness) => harness.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

const walletConnection = (
  data: unknown = { status: "disconnected" as const, reason: "no_session" as const },
): WalletConnectionReadCapabilityPort => {
  const harness = createCapabilityHarness(() => "2026-07-15T06:00:00.000Z");
  return Object.freeze({
    connection: bindForHarness(
      walletConnectionCapability,
      harness,
      async (
        _input: Record<string, never>,
        context: HandlerInvocationContext,
        observations: ObservationWriter,
      ) => {
        const sdk = observations.bind(walletConnectionEvidence.targets.sdk);
        observations.record(sdk.slot, {
          source: context.ports.observations.get("wallet_sdk"),
          claims: [{ role: sdk.roles.state, value: data as never }],
        });
        return { status: "success" as const, data: data as never };
      },
    ),
  });
};

const baseRoutes = async (): Promise<RuntimeRouteRegistry> => {
  const directory = await mkdtemp(resolve(tmpdir(), "littlejohn-public-routes-"));
  directories.push(directory);
  const paths = runtimePaths(directory);
  const credential = await loadOrCreateControlCredential(directory, paths.controlCredential);
  return createRuntimeRouteRegistry({
    controlVerifier: createControlCredentialVerifier(credential),
  });
};

const interfaceManifest = () => extendInterfaceSupportManifest(extendUniswapV2ProtocolHarnessManifest(
  extendReferenceMarketSupportManifest(extendAccountAssetSupportManifest(
    extendTokenCatalogSupportManifest(extendChainSupportManifest(
    extendWalletSupportManifest(createInitialRuntimeSupportManifest(readRuntimeConfiguration({}).chain)),
    )),
  )),
));

const createRoutes = async (walletData?: unknown): Promise<{
  readonly routes: RuntimeRouteRegistry;
  readonly chain: ChainHandlerHarness;
  readonly manifest: ReturnType<typeof interfaceManifest>;
}> => {
  const chain = createChainHandlerHarness({
    rpc: new ScriptedRpc([
      rpcValue("eth_chainId", "0x1237"),
      rpcValue("eth_getBlockByNumber", {
        number: "0x10",
        hash: blockHash,
        timestamp: "0x65a00000",
        transactions: [],
      }),
    ]),
    encoder,
    wallet: disconnectedWallet(),
  });
  chainHarnesses.push(chain);
  const manifest = interfaceManifest();
  return Object.freeze({
    chain,
    manifest,
    routes: extendPublicInterfaceRoutes({
      routes: await baseRoutes(),
      chainReads: chain.service.chainReads,
      walletConnection: walletConnection(walletData),
      tokenInspection: tokenCatalogInterfaceHarnessPorts().tokenInspection,
      uniswapV2Quote: uniswapV2QuoteHarnessBinding(),
      supportManifest: manifest,
    }),
  });
};

const invoke = async (
  registry: RuntimeRouteRegistry,
  method: RouteMethod,
  path: string,
  body: unknown = {},
): Promise<NormalizedRouteResult> => {
  const match = registry.match(method, path);
  expect(match.status).toBe("matched");
  if (match.status !== "matched") throw new Error("Expected a public interface route.");
  return registry.normalizeResult(match.route, await match.route.handler({
    params: match.params,
    body,
    signal: new AbortController().signal,
  }));
};

describe("public read HTTP routes", () => {
  it("registers one exact resource-oriented route for every declared read and catalog", async () => {
    const { routes } = await createRoutes();
    const expected = [
      ["POST", publicInterfaceRoutes.accountBalanceQueries],
      ["GET", publicInterfaceRoutes.capabilities],
      ["GET", publicInterfaceRoutes.chainStatus],
      ["POST", publicInterfaceRoutes.contractInspections],
      ["POST", publicInterfaceRoutes.tokenInspections],
      ["POST", publicInterfaceRoutes.transactionInspections],
      ["POST", publicInterfaceRoutes.uniswapV2ExactInputQuotes],
      ["GET", publicInterfaceRoutes.walletConnection],
    ] as const;
    for (const [method, path] of expected) {
      const match = routes.match(method, path);
      expect(match.status).toBe("matched");
      if (match.status === "matched") {
        expect(match.route).toMatchObject({
          method,
          requestClass: "public_read",
          mutation: "none",
          response: "canonical_json",
          successStatus: 200,
        });
      }
    }
    expect(routes.match("POST", publicInterfaceRoutes.chainStatus).status).toBe("method_not_allowed");
    expect(routes.match("GET", publicInterfaceRoutes.contractInspections).status).toBe("method_not_allowed");
    expect(Object.values(publicInterfaceRoutes).some((path) => path.includes("mcp") || path.includes("cli")))
      .toBe(false);
  });

  it("returns the canonical direct result unchanged and performs only the declared RPC reads", async () => {
    const { routes, chain } = await createRoutes();
    const result = await invoke(routes, "GET", publicInterfaceRoutes.chainStatus);
    expect(result.ok).toBe(true);
    if (!result.ok || result.response !== "canonical_json") throw new Error("Expected canonical JSON.");
    expect(result.body).toMatchObject({
      ok: true,
      meta: { capabilityId: "chain.status", chainId: "eip155:4663" },
      data: {
        chainId: "eip155:4663",
        latestBlock: { chainId: "eip155:4663", blockNumber: "16", blockHash },
      },
    });
    expect(JSON.stringify(result.body)).not.toContain('"caip2"');
    expect(chain.rpc.calls).toEqual([
      { method: "eth_chainId", params: [] },
      { method: "eth_getBlockByNumber", params: ["latest", false] },
    ]);
    expect(chain.rpc.remainingSteps).toBe(0);
  });

  it("rejects malformed canonical input before any dependent RPC call", async () => {
    const { routes, chain } = await createRoutes();
    const result = await invoke(routes, "POST", publicInterfaceRoutes.contractInspections, {
      address: "0xnot-an-address",
      block: { kind: "latest" },
      extra: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem.code).toBe("invalid_input");
    expect(chain.rpc.calls).toEqual([]);
  });

  it("rejects legacy wallet identity and session-count fields instead of projecting them", async () => {
    for (const legacyConnection of [
      {
        status: "connected",
        account: "eip155:4663:0x1111111111111111111111111111111111111111",
        address: "0x1111111111111111111111111111111111111111",
        chainId: "eip155:4663",
        approvedMethods: ["eth_sendTransaction"],
        approvedEvents: ["accountsChanged", "chainChanged"],
        expiresAt: "2026-07-22T00:00:00.000Z",
      },
      { status: "unresolved", eligibleSessionCount: "2" },
    ]) {
      const { routes } = await createRoutes(legacyConnection);
      const result = await invoke(routes, "GET", publicInterfaceRoutes.walletConnection);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.problem.code).toBe("internal_error");
    }
  });

  it("exposes the generated catalog from the same support manifest and accepts no query", async () => {
    const { routes, manifest } = await createRoutes();
    const result = await invoke(routes, "GET", publicInterfaceRoutes.capabilities);
    expect(result).toEqual({
      ok: true,
      response: "canonical_json",
      body: composeInterfaceCapabilityCatalog(manifest),
    });
    const match = routes.match("GET", publicInterfaceRoutes.capabilities);
    if (match.status !== "matched") throw new Error("Expected catalog route.");
    const base = {
      host: [fixedHostHeader], origin: [], authorization: [], cookie: [], csrfToken: [],
      contentType: [], bodyLength: 0,
    } as const;
    expect(routes.validateSecurity(match, { ...base, query: "" })).toEqual({ ok: true });
    expect(routes.validateSecurity(match, { ...base, query: "?format=json" }))
      .toEqual({ ok: false, code: "query_not_supported" });
  });
});
