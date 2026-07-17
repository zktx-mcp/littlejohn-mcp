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
  parseEvmChainId,
  parseCapabilityDataAt,
  sourceReferenceSchema,
  transactionInspectCapability,
  walletConnectionCapability,
  type AnyReadCapabilityDefinition,
  type CapabilityData,
  type CapabilitySuccess,
  type EvmAddress,
  type EvmChainId,
  type UtcTimestamp,
  type WalletConnectionData,
} from "../../src/core/index.js";
import type { Erc20CallEncoder } from "../../src/chain/evm-standard.js";
import { createChainReadService, type ChainReadService } from "../../src/chain/handlers.js";
import {
  ChainRpcError,
  type ChainRpcMethod,
  type ChainRpcRequestMap,
  type RpcRequester,
} from "../../src/chain/rpc.js";
import type { ChainOwnerApplicationContext, WalletSessionSource } from "../../src/runtime/index.js";
import { readRuntimeConfiguration } from "../../src/runtime/configuration.js";
import type {
  ActiveWalletReadPort,
  ActiveWalletReadSnapshot,
} from "../../src/wallet/coordinator.js";

export const handlerEvaluationTime = "2026-07-15T06:00:00.000Z" as UtcTimestamp;
const handlerClock = createCanonicalClock(() => handlerEvaluationTime);
export const configuredChainId = parseEvmChainId("eip155:4663");
const runtimeConfiguration = readRuntimeConfiguration({});

export interface RecordedRpcCall {
  readonly method: ChainRpcMethod;
  readonly params: readonly unknown[];
}

export interface RpcStep {
  readonly method: ChainRpcMethod;
  readonly run: (
    params: readonly unknown[],
    signal: AbortSignal,
  ) => unknown | Promise<unknown>;
}

export const rpcValue = <Method extends ChainRpcMethod>(
  method: Method,
  value: unknown,
): RpcStep => Object.freeze({ method, run: () => value });

export const rpcFailure = <Method extends ChainRpcMethod>(
  method: Method,
  code: ConstructorParameters<typeof ChainRpcError>[0],
): RpcStep => Object.freeze({
  method,
  run: () => {
    throw new ChainRpcError(code);
  },
});

export class ScriptedRpc implements RpcRequester {
  readonly calls: RecordedRpcCall[] = [];
  readonly #steps: RpcStep[];

  constructor(steps: readonly RpcStep[]) {
    this.#steps = [...steps];
  }

  async request<Method extends ChainRpcMethod>(
    method: Method,
    params: ChainRpcRequestMap[Method],
    signal: AbortSignal,
  ): Promise<unknown> {
    this.calls.push(Object.freeze({ method, params: [...params] }));
    const step = this.#steps.shift();
    if (step === undefined || step.method !== method) {
      throw new TypeError(`Unexpected RPC call: ${method}.`);
    }
    return await step.run(params, signal);
  }

  get remainingSteps(): number {
    return this.#steps.length;
  }
}

export interface ActiveWalletHarness {
  readonly port: ActiveWalletReadPort;
  readonly captures: () => number;
}

export const activeWallet = (snapshot: ActiveWalletReadSnapshot): ActiveWalletHarness => {
  let captureCount = 0;
  return Object.freeze({
    port: Object.freeze({
      capture(): ActiveWalletReadSnapshot {
        captureCount += 1;
        return snapshot;
      },
    }),
    captures: () => captureCount,
  });
};

export const disconnectedWallet = (): ActiveWalletHarness => activeWallet(Object.freeze({
  connection: parseCapabilityDataAt(walletConnectionCapability, {
    status: "disconnected",
    reason: "no_session",
  }, handlerEvaluationTime),
}));

export const connectedWallet = (
  address: EvmAddress,
  chainId: EvmChainId = configuredChainId,
): ActiveWalletHarness => {
  const topicDigest = "A".repeat(43);
  const sourceId = `wallet-session:${topicDigest}`;
  const observationAuthority = createObservationAuthority({
    clock: handlerClock,
    sourceClass: "wallet_session",
    owner: "WalletConnect session",
    reference: sourceReferenceSchema.parse({
      kind: "wallet_session",
      sourceId,
      topicDigest,
    }),
  });
  const sessionSource: WalletSessionSource = Object.freeze({
    sourceId,
    candidateId: sourceId,
    topicDigest,
    observationAuthority,
  });
  const connection: WalletConnectionData = parseCapabilityDataAt(walletConnectionCapability, {
    status: "connected",
    address,
    chainId,
    approvedMethods: ["eth_sendTransaction"],
    approvedEvents: ["accountsChanged", "chainChanged"],
    expiresAt: "2026-07-22T06:00:00.000Z",
  }, handlerEvaluationTime);
  return activeWallet(Object.freeze({ connection, sessionSource }));
};

const definitions = Object.freeze([
  accountBalanceCapability,
  chainStatusCapability,
  contractInspectCapability,
  transactionInspectCapability,
] as const);

export interface ChainHandlerHarness {
  readonly registry: CapabilityBindingRegistry;
  readonly rpc: ScriptedRpc;
  readonly service: ChainReadService;
  readonly wallet: ActiveWalletHarness;
  invoke<Definition extends AnyReadCapabilityDefinition>(
    definition: Definition,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<CapabilitySuccess<CapabilityData<Definition>> | import("../../src/core/index.js").ApplicationFailure>;
  close(): Promise<void>;
}

export const createChainHandlerHarness = (input: {
  readonly rpc: ScriptedRpc;
  readonly encoder: Erc20CallEncoder;
  readonly wallet?: ActiveWalletHarness;
}): ChainHandlerHarness => {
  const rpcAuthority = createObservationAuthority({
    clock: handlerClock,
    sourceClass: "chain_rpc",
    owner: "user_configured",
    reference: sourceReferenceSchema.parse({
      kind: "public",
      sourceId: "rpc_handler_test",
      uri: "https://rpc.example/",
    }),
  });
  const invocationAuthority = createCapabilityInvocationAuthority(handlerClock, configuredChainId);
  const wallet = input.wallet ?? disconnectedWallet();
  const owner = new AbortController();
  const context = {
    activeWallet: wallet.port,
    signal: owner.signal,
    chain: {
      configuration: runtimeConfiguration.rpc,
      sourceAuthority: { observationAuthority: rpcAuthority },
      capabilityAuthority: {
        clock: handlerClock,
        invocationAuthority,
        invocationPorts: Object.freeze({
          observations: new ObservationAuthorityRegistry(handlerClock, [rpcAuthority]),
        }),
      },
    },
  } as unknown as ChainOwnerApplicationContext<ActiveWalletReadPort>;
  const service = createChainReadService({ context, rpc: input.rpc, encoder: input.encoder });
  const bindings = service.chainReads;
  const registry = new CapabilityBindingRegistry(
    new CapabilityRegistry(definitions),
    [bindings.accountBalance, bindings.chainStatus, bindings.contractInspect, bindings.transactionInspect],
  );
  return Object.freeze({
    registry,
    rpc: input.rpc,
    service,
    wallet,
    invoke<Definition extends AnyReadCapabilityDefinition>(
      definition: Definition,
      request: unknown,
      signal: AbortSignal = new AbortController().signal,
    ) {
      return registry.invoke(definition, request, { signal });
    },
    close: () => service.close(),
  });
};
