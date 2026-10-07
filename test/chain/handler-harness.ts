import {CapabilityBindingRegistry, CapabilityRegistry, ObservationAuthorityRegistry, createCanonicalClock, createCapabilityInvocationAuthority, createObservationAuthority, createObservationAuthorityIssuer, parseCapabilityDataAt, parseUnsignedDecimal, sourceReferenceSchema, type AnyReadCapabilityDefinition, type CapabilityData, type CapabilitySuccess, type UtcTimestamp, type SourceReference, type ObservationAuthorityRegistration} from "../../src/core/index.js";
import {accountBalanceCapability} from "../../src/account-assets/balance-capability.js";
import {chainStatusCapability, addressInspectCapability, transactionInspectCapability} from "../../src/chain/read-contracts.js";
import {parseEvmChainId, type EvmAddress, type EvmChainId} from "../../src/evm/identities.js";
import {walletConnectionCapability} from "../../src/wallet/connection-capability.js";
import {type WalletConnectionData} from "../../src/wallet/connection-contract.js";
import type { Erc20CallEncoder } from "../../src/chain/evm-standard.js";
import { createAddressTargetResolver } from "../../src/chain/address-target.js";
import { createChainReadService, type ChainReadService } from "../../src/chain/handlers.js";
import { createChainInvocationLifecycle } from "../../src/chain/invocation-lifecycle.js";
import {
  createContractSourceVerificationPort,
  type ContractSourceVerificationPort,
  type ContractSourceVerificationRequest,
} from "../../src/intelligence/ports.js";
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
export const handlerClock = createCanonicalClock(() => handlerEvaluationTime);
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
      async capture(): Promise<ActiveWalletReadSnapshot> {
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
  connectionRevision: parseUnsignedDecimal("0"),
}));

export const connectedWallet = (
  address: EvmAddress,
  chainId: EvmChainId = configuredChainId,
  includeSessionSource = true,
  connectionRevision = "0",
  sourceCharacter = "A",
): ActiveWalletHarness => {
  const topicDigest = sourceCharacter.repeat(43);
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
  return activeWallet(Object.freeze({
    connection,
    connectionRevision: parseUnsignedDecimal(connectionRevision),
    ...(includeSessionSource ? { sessionSource } : {}),
  }));
};

const definitions = Object.freeze([
  accountBalanceCapability,
  chainStatusCapability,
  addressInspectCapability,
  transactionInspectCapability,
] as const);

export interface ChainHandlerHarness {
  readonly registry: CapabilityBindingRegistry;
  readonly rpc: ScriptedRpc;
  readonly service: ChainReadService;
  readonly wallet: ActiveWalletHarness;
  readonly contractSourceVerificationRequests: () => number;
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
  readonly chainRpc?: Readonly<{ owner: string; reference: SourceReference }>;
  readonly contractSourceVerification?: Readonly<{
    readonly port: ContractSourceVerificationPort;
    readonly observationAuthorityRegistration: ObservationAuthorityRegistration;
  }>;
}): ChainHandlerHarness => {
  const configurationDigest = "A".repeat(43);
  const rpcAuthority = createObservationAuthority({
    clock: handlerClock,
    sourceClass: "chain_rpc",
    owner: input.chainRpc?.owner ?? "user_configured",
    reference: input.chainRpc?.reference ?? sourceReferenceSchema.parse({
      kind: "configured_rpc",
      sourceId: `rpc:${configurationDigest}`,
      publicOrigin: "https://rpc.mainnet.chain.robinhood.com",
      configurationDigest,
    }),
  });
  const invocationAuthority = createCapabilityInvocationAuthority(handlerClock, configuredChainId);
  const defaultContractVerification = createObservationAuthorityIssuer({
    clock: handlerClock,
    sourceClass: "contract_verification_service",
    owner: "Sourcify",
    referenceKind: "public",
    sourceId: "sourcify-v2",
  });
  let contractSourceVerificationRequestCount = 0;
  const contractSourceVerification = input.contractSourceVerification ?? Object.freeze({
    observationAuthorityRegistration: defaultContractVerification.registration,
    port: createContractSourceVerificationPort({
      observationAuthorityRegistration: defaultContractVerification.registration,
      async inspect(request: ContractSourceVerificationRequest) {
        contractSourceVerificationRequestCount += 1;
        const reference = sourceReferenceSchema.parse({
          kind: "public",
          sourceId: "sourcify-v2",
          uri: `https://sourcify.example/contract/${request.address}`,
        });
        if (reference.kind !== "public") throw new TypeError("Expected public source reference.");
        return Object.freeze({
          status: "no_record_observed" as const,
          reference,
          observationAuthority: defaultContractVerification.issue(reference),
        });
      },
    }),
  });
  const wallet = input.wallet ?? disconnectedWallet();
  const owner = new AbortController();
  const context = {
    activeWallet: wallet.port,
    signal: owner.signal,
    chain: {
      configuration: runtimeConfiguration.rpc,
      contractSourceVerification: contractSourceVerification.port,
      sourceAuthority: { observationAuthority: rpcAuthority },
      capabilityAuthority: {
        clock: handlerClock,
        invocationAuthority,
        invocationPorts: Object.freeze({
          observations: new ObservationAuthorityRegistry(
            handlerClock,
            [rpcAuthority, contractSourceVerification.observationAuthorityRegistration],
          ),
        }),
      },
    },
  } as unknown as ChainOwnerApplicationContext<ActiveWalletReadPort>;
  const lifecycle = createChainInvocationLifecycle(owner.signal);
  const service = createChainReadService({
    context,
    rpc: input.rpc,
    encoder: input.encoder,
    lifecycle,
    addressTargets: createAddressTargetResolver({
      chainId: configuredChainId,
      activeWallet: wallet.port,
    }),
  });
  const bindings = service.chainReads;
  const registry = new CapabilityBindingRegistry(
    new CapabilityRegistry(definitions),
    [bindings.accountBalance, bindings.addressInspect, bindings.chainStatus, bindings.transactionInspect],
  );
  return Object.freeze({
    registry,
    rpc: input.rpc,
    service,
    wallet,
    contractSourceVerificationRequests: () => contractSourceVerificationRequestCount,
    invoke<Definition extends AnyReadCapabilityDefinition>(
      definition: Definition,
      request: unknown,
      signal: AbortSignal = new AbortController().signal,
    ) {
      return registry.invoke(definition, request, { signal });
    },
    close: () => lifecycle.close(),
  });
};
