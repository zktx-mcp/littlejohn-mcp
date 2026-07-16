import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { createErc20CallEncoder, type Erc20CallEncoder } from "../../src/chain/erc20-calls.js";
import { extendChainSupportManifest } from "../../src/chain/application.js";
import {
  walletConnectionCapability,
  type HandlerInvocationContext,
  type ObservationWriter,
} from "../../src/core/index.js";
import {
  extendPublicInterfaceRoutes,
  publicInterfaceRoutes,
} from "../../src/interfaces/http-routes.js";
import { extendInterfaceSupportManifest } from "../../src/interfaces/support.js";
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
  composeCapabilityCatalog,
  initialRuntimeSupportManifest,
  type WalletConnectionReadCapabilityPort,
} from "../../src/runtime/index.js";
import { extendWalletSupportManifest } from "../../src/wallet/application.js";
import { walletInterfaceErrorMappings } from "../../src/wallet/errors.js";
import { bindForHarness, createCapabilityHarness } from "../core/capability-harness.js";
import {
  ScriptedRpc,
  createChainHandlerHarness,
  disconnectedWallet,
  rpcValue,
  type ChainHandlerHarness,
} from "../chain/handler-harness.js";

const directories: string[] = [];
const blockHash = `0x${"88".repeat(32)}`;
let encoder: Erc20CallEncoder;
const chainHarnesses: ChainHandlerHarness[] = [];

beforeAll(async () => { encoder = await createErc20CallEncoder(); });

afterEach(async () => {
  await Promise.all(chainHarnesses.splice(0).map((harness) => harness.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

const walletConnection = (): WalletConnectionReadCapabilityPort => {
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
        const data = { status: "disconnected" as const, reason: "no_session" as const };
        observations.record("wallet_sdk", {
          source: context.ports.observations.get("wallet_sdk"),
          claims: [{ role: "wallet_sdk_state", value: data }],
        });
        return { status: "success" as const, data };
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
    errorMappings: walletInterfaceErrorMappings,
  });
};

const interfaceManifest = () => extendInterfaceSupportManifest(extendChainSupportManifest(
  extendWalletSupportManifest(initialRuntimeSupportManifest),
));

const createRoutes = async (): Promise<{
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
      walletConnection: walletConnection(),
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
      ["POST", publicInterfaceRoutes.transactionInspections],
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
      meta: { capabilityId: "chain.status", chainId: "4663" },
      data: {
        chainId: "4663",
        caip2: "eip155:4663",
        latestBlock: { chainId: "4663", blockNumber: "16", blockHash },
      },
    });
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

  it("exposes the generated catalog from the same support manifest and accepts no query", async () => {
    const { routes, manifest } = await createRoutes();
    const result = await invoke(routes, "GET", publicInterfaceRoutes.capabilities);
    expect(result).toEqual({
      ok: true,
      response: "canonical_json",
      body: composeCapabilityCatalog(manifest),
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
