import {
  evmAddressSchema,
  parseHexBytes,
  type BoundEvidenceObservationTarget,
  type BlockSelector,
  type ContractAnalysis,
  type ContractAnalysisEvidenceTargets,
  type ContractRuntimeCodeIdentity,
  type ConfiguredChainEvidenceFragment,
  type EvmAddress,
  type EvmChainId,
  type HexBytes,
  type ObservationAuthority,
  type ObservationWriter,
  type UnsignedDecimal,
} from "../core/index.js";
import {
  analyzeContract,
  recordContractAnalysisEvidence,
} from "../intelligence/contract-analysis.js";
import type {
  ContractRuntimeCode,
  ContractSourceVerificationPort,
} from "../intelligence/ports.js";
import {
  readConfiguredCanonicalBlock,
  resolveConfiguredCanonicalBlock,
  type CanonicalBlock,
} from "./canonical-block.js";
import { createContractAnalysisChainReadPort } from "./contract-analysis.js";
import {
  admitChainReadFailure,
  ChainOperationError,
} from "./errors.js";
import {
  createContractAnalysisCallEncoder,
  type Erc20CallEncoder,
} from "./evm-standard.js";
import {
  type ChainInvocationContext,
  type ChainInvocationLifecycle,
} from "./invocation-lifecycle.js";
import {
  normalizeAbiDecimals,
  normalizeRpcBytes,
  normalizeRpcRuntimeCode,
} from "./normalization.js";
import {
  isRpcExecutionRevertedError,
  type RpcRequester,
} from "./rpc.js";
import { recordConfiguredChainProof } from "./configured-chain.js";

export type PinnedEvmCallResult<Value> =
  | Readonly<{ readonly status: "observed"; readonly value: Value }>
  | Readonly<{ readonly status: "reverted" }>;

export interface PinnedEvmReadPort {
  readonly observationAuthority: ObservationAuthority;
  resolveBlock(
    context: ChainInvocationContext,
    selector: BlockSelector,
  ): Promise<CanonicalBlock>;
  readRuntimeCode(
    context: ChainInvocationContext,
    block: CanonicalBlock,
    address: EvmAddress,
  ): Promise<ContractRuntimeCode | null>;
  call(
    context: ChainInvocationContext,
    block: CanonicalBlock,
    request: Readonly<{ readonly to: EvmAddress; readonly data: HexBytes }>,
  ): Promise<PinnedEvmCallResult<HexBytes>>;
  readTokenDecimals(
    context: ChainInvocationContext,
    block: CanonicalBlock,
    token: EvmAddress,
  ): Promise<PinnedEvmCallResult<UnsignedDecimal>>;
  inspectContract(
    context: ChainInvocationContext,
    block: CanonicalBlock,
    target: Readonly<{
      readonly address: EvmAddress;
      readonly runtimeCode: ContractRuntimeCodeIdentity;
    }>,
    evidence: Readonly<{
      readonly fragment: ContractAnalysisEvidenceTargets;
      readonly observations: ObservationWriter;
    }>,
  ): Promise<ContractAnalysis>;
  recordConfiguredChain(
    context: ChainInvocationContext,
    block: CanonicalBlock,
    observations: ObservationWriter,
    target: BoundEvidenceObservationTarget<ConfiguredChainEvidenceFragment["target"]>,
  ): void;
}

export type PinnedEvmReadFailureCode =
  | "chain_response_unavailable"
  | "not_found"
  | "rate_limited"
  | "request_aborted"
  | "runtime_busy"
  | "runtime_state_unavailable"
  | "source_inconsistent"
  | "source_unavailable";

export const normalizePinnedEvmReadFailure = (
  error: unknown,
  callerSignal: AbortSignal,
): PinnedEvmReadFailureCode | undefined => {
  const failure = admitChainReadFailure(error, callerSignal);
  return failure?.error.code as PinnedEvmReadFailureCode | undefined;
};

export const createPinnedEvmReadPort = (input: {
  readonly rpc: RpcRequester;
  readonly chainId: EvmChainId;
  readonly lifecycle: ChainInvocationLifecycle;
  readonly erc20Encoder: Erc20CallEncoder;
  readonly contractSourceVerification: ContractSourceVerificationPort;
  readonly observationAuthority: ObservationAuthority;
}): PinnedEvmReadPort => {
  const contractAnalysisEncoder = createContractAnalysisCallEncoder();

  const stateFor = (
    context: ChainInvocationContext,
    block: CanonicalBlock,
  ) => {
    input.lifecycle.assertActiveContext(context);
    return readConfiguredCanonicalBlock({
      context,
      block,
      chainId: input.chainId,
    });
  };

  const readRuntimeCode = async (
    context: ChainInvocationContext,
    block: CanonicalBlock,
    addressInput: EvmAddress,
  ): Promise<ContractRuntimeCode | null> => {
    const address = evmAddressSchema.parse(addressInput);
    const state = stateFor(context, block);
    const raw = await input.rpc.request(
      "eth_getCode",
      [address, state.stateReference],
      context.signal,
    );
    try {
      const normalized = normalizeRpcRuntimeCode(raw);
      return normalized.status === "empty"
        ? null
        : Object.freeze({
            bytecode: normalized.bytecode,
            identity: Object.freeze({
              byteLength: normalized.byteLength,
              codeHash: normalized.codeHash,
            }),
          });
    } catch {
      throw new ChainOperationError("source_inconsistent");
    }
  };

  const call = async (
    context: ChainInvocationContext,
    block: CanonicalBlock,
    requestInput: Readonly<{ readonly to: EvmAddress; readonly data: HexBytes }>,
  ): Promise<PinnedEvmCallResult<HexBytes>> => {
    const request = Object.freeze({
      to: evmAddressSchema.parse(requestInput.to),
      data: parseHexBytes(requestInput.data),
    });
    const state = stateFor(context, block);
    try {
      const raw = await input.rpc.request(
        "eth_call",
        [request, state.stateReference],
        context.signal,
      );
      try {
        return Object.freeze({
          status: "observed" as const,
          value: normalizeRpcBytes(raw),
        });
      } catch {
        throw new ChainOperationError("source_inconsistent");
      }
    } catch (error) {
      if (isRpcExecutionRevertedError(error)) {
        return Object.freeze({ status: "reverted" as const });
      }
      throw error;
    }
  };

  return Object.freeze({
    observationAuthority: input.observationAuthority,
    resolveBlock(context: ChainInvocationContext, selector: BlockSelector) {
      input.lifecycle.assertActiveContext(context);
      return resolveConfiguredCanonicalBlock({
        rpc: input.rpc,
        chainId: input.chainId,
        selector,
        context,
      });
    },
    readRuntimeCode,
    call,
    async readTokenDecimals(
      context: ChainInvocationContext,
      block: CanonicalBlock,
      token: EvmAddress,
    ) {
      const result = await call(context, block, {
        to: token,
        data: input.erc20Encoder.decimals(),
      });
      if (result.status === "reverted") return result;
      try {
        return Object.freeze({
          status: "observed" as const,
          value: normalizeAbiDecimals(result.value),
        });
      } catch {
        throw new ChainOperationError("source_inconsistent");
      }
    },
    async inspectContract(
      context: ChainInvocationContext,
      block: CanonicalBlock,
      targetInput: Readonly<{
        readonly address: EvmAddress;
        readonly runtimeCode: ContractRuntimeCodeIdentity;
      }>,
      evidence: Readonly<{
        readonly fragment: ContractAnalysisEvidenceTargets;
        readonly observations: ObservationWriter;
      }>,
    ) {
      const address = evmAddressSchema.parse(targetInput.address);
      const state = stateFor(context, block);
      const execution = await analyzeContract({
        target: address,
        chain: createContractAnalysisChainReadPort({
          rpc: input.rpc,
          encoder: contractAnalysisEncoder,
          chainId: input.chainId,
          block: state.anchor,
          stateReference: state.stateReference,
          signal: context.signal,
        }),
        sourceVerification: input.contractSourceVerification,
        signal: context.signal,
      });
      return recordContractAnalysisEvidence({
        target: {
          chainId: input.chainId,
          address,
          block: state.anchor,
          runtimeCode: targetInput.runtimeCode,
        },
        sourceVerification: input.contractSourceVerification,
        execution,
        fragment: evidence.fragment,
        observations: evidence.observations,
        chainAuthority: input.observationAuthority,
      });
    },
    recordConfiguredChain(
      context: ChainInvocationContext,
      block: CanonicalBlock,
      observations: ObservationWriter,
      target: BoundEvidenceObservationTarget<ConfiguredChainEvidenceFragment["target"]>,
    ) {
      const state = stateFor(context, block);
      recordConfiguredChainProof({
        proof: state.configuredChainProof,
        rpcSource: input.observationAuthority,
        observations,
        target,
        chainAnchor: state.anchor,
      });
    },
  });
};
