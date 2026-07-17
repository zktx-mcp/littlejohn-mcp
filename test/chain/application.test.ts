import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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
  getCapabilityDefinitionSnapshot,
  parseCapabilityDataAt,
  parseHexBytes,
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
  ChainRpcError,
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
  initialRuntimeSupportManifest,
  readRuntimeSupportManifest,
  type ChainOwnerApplicationContext,
} from "../../src/runtime/index.js";
import { extendWalletSupportManifest } from "../../src/wallet/application.js";
import type {
  ActiveWalletReadPort,
  ActiveWalletReadSnapshot,
} from "../../src/wallet/coordinator.js";
import { bindForHarness, createCapabilityHarness } from "../core/capability-harness.js";

const directories: string[] = [];
const observedAt = parseUtcTimestamp("2026-07-15T12:00:00.000Z");
const exactRpcUrl = "https://rpc-user:rpc-password@rpc.example/private/path?project=secret";

afterEach(async () => {
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
      return Object.freeze({ connection: disconnected });
    },
  });
  const ownerController = new AbortController();
  const startupScope = createResourceOwnershipScope();
  const context: ChainOwnerApplicationContext<ActiveWalletReadPort> = Object.freeze({
    routes,
    signal: ownerController.signal,
    startupResources: startupScope.resources,
    supportManifest: extendWalletSupportManifest(initialRuntimeSupportManifest),
    walletConnection: Object.freeze({ connection: walletConnection }),
    activeWallet,
    chain: Object.freeze({
      configuredRpcUri: exactRpcUrl,
      sourceAuthority: Object.freeze({
        sourceOwner: "user_configured" as const,
        publicOrigin: "https://rpc.example",
        sourceId: "rpc_chain_application_test",
        configurationDigest: "A".repeat(43),
        observationAuthority: rpcAuthority,
      }),
      capabilityAuthority: Object.freeze({
        clock,
        invocationAuthority: createCapabilityInvocationAuthority(clock),
        invocationPorts: Object.freeze({
          observations: new ObservationAuthorityRegistry(clock, [rpcAuthority]),
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
    expect(Object.keys(application).sort()).toEqual(["chainReads", "close", "routes", "supportManifest"]);
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
      error: { code: "source_unavailable" },
    });
    await expect(application.close()).resolves.toBeUndefined();

    await expect(bindings.invoke(chainStatusCapability, {}, {
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      ok: false,
      error: { code: "source_unavailable" },
    });
    expect(requester.calls).toHaveLength(1);
  });
});
