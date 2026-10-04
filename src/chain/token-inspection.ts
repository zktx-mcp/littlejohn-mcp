import {CapabilityBindingRegistry, CapabilityRegistry, bindCapability, type BoundEvidenceObservationTarget, type CapabilityBinding, type HandlerInvocationContext, type InvocationBoundaryPorts, type ObservationAuthority, type ObservationWriter, type TokenMetadataRead} from "../core/index.js";
import {tokenStandardOrder} from "../evm/token-standards.js";
import {type CanonicalAmount} from "../evm/amounts.js";
import {type ChainAnchor} from "../evm/primitives.js";
import {
  analyzeContract,
  isContractAnalysisTargetNotFoundError,
  recordContractAnalysisEvidence,
} from "../intelligence/contract-analysis.js";
import type { ContractSourceVerificationPort } from "../intelligence/ports.js";
import type { ChainOwnerApplicationContext } from "../runtime/application-context.js";
import type { ActiveWalletReadPort } from "../wallet/coordinator.js";
import {
  tokenInspectCapability,
  tokenInspectionEvidence,
  projectTokenInspectionStandardEvidence,
  type TokenInspectionData,
  type TokenInspectionInput,
} from "../token-catalog/contracts.js";
import type { TokenAdditionChainReadPort } from "../token-catalog/ports.js";
import {
  createContractAnalysisCallEncoder,
  decodeAbiUint256Result,
  type ContractAnalysisCallEncoder,
  type Erc20CallEncoder,
} from "./evm-standard.js";
import { normalizeRpcBytes } from "./normalization.js";
import {
  isRpcExecutionRevertedError,
  type RpcCanonicalBlockReference,
  type RpcRequester,
} from "./rpc.js";
import {
  admitChainReadFailure,
  ChainOperationError,
} from "./errors.js";
import {
  createTokenCatalogFailure,
  tokenCatalogErrorRegistry,
} from "../token-catalog/errors.js";
import {
  readConfiguredCanonicalBlock,
  resolveConfiguredCanonicalBlock,
  type CanonicalBlock,
} from "./canonical-block.js";
import { recordConfiguredChainProof } from "./configured-chain.js";
import {
  type ChainInvocationContext,
  type ChainInvocationLifecycle,
} from "./invocation-lifecycle.js";
import {
  completeTokenStandardObservation,
  observeRequiredErc8056,
} from "./token-standards.js";
import type { OfficialAssetChainReadPort } from "./official-assets.js";
import { readTokenMetadataAtBlock } from "./token-metadata.js";
import { createContractAnalysisChainReadPort } from "./contract-analysis.js";

const requiredTotalSupplyRevertedErrors = new WeakSet<object>();

const createRequiredTotalSupplyRevertedError = (): Error => {
  const error = new Error("token_total_supply_reverted");
  error.name = "RequiredTotalSupplyRevertedError";
  requiredTotalSupplyRevertedErrors.add(error);
  Object.freeze(error);
  return error;
};

const isRequiredTotalSupplyRevertedError = (error: unknown): boolean =>
  typeof error === "object" && error !== null && requiredTotalSupplyRevertedErrors.has(error);

interface TokenInspectionDependencies {
  readonly rpc: RpcRequester;
  readonly encoder: Erc20CallEncoder;
  readonly contractAnalysisEncoder: ContractAnalysisCallEncoder;
  readonly contractSourceVerification: ContractSourceVerificationPort;
  readonly rpcSource: ObservationAuthority;
  readonly chainId: TokenInspectionInput["asset"]["chainId"];
}

const asFailure = (code: string) => ({ status: "failure" as const, code, issues: Object.freeze([]) });

const inspectionFailureCode = (
  error: unknown,
  callerSignal: AbortSignal,
): string | undefined => {
  if (isContractAnalysisTargetNotFoundError(error)) return "not_found";
  if (isRequiredTotalSupplyRevertedError(error)) return "token_total_supply_reverted";
  return admitChainReadFailure(error, callerSignal)?.error.code;
};

const normalizeSource = <Value>(operation: () => Value): Value => {
  try { return operation(); }
  catch { throw new ChainOperationError("source_inconsistent"); }
};

const runInspection = async <Result>(
  lifecycle: ChainInvocationLifecycle,
  callerSignal: AbortSignal,
  operation: (context: ChainInvocationContext) => Promise<Result>,
): Promise<Result | ReturnType<typeof asFailure>> => {
  try {
    return await lifecycle.run(callerSignal, operation);
  } catch (error) {
    const code = inspectionFailureCode(error, callerSignal);
    if (code !== undefined) return asFailure(code);
    throw error;
  }
};

const resolveBlock = async (
  dependencies: TokenInspectionDependencies,
  input: TokenInspectionInput,
  context: ChainInvocationContext,
  observations: ObservationWriter,
  configuredChainTarget: BoundEvidenceObservationTarget<
    typeof tokenInspectionEvidence.configuredChain.target
  >,
): Promise<Readonly<{
  block: CanonicalBlock;
  anchor: ChainAnchor;
  reference: RpcCanonicalBlockReference;
}>> => {
  const block = await resolveConfiguredCanonicalBlock({
    rpc: dependencies.rpc,
    chainId: dependencies.chainId,
    selector: input.block,
    context,
  });
  const state = readConfiguredCanonicalBlock({
    context,
    block,
    chainId: dependencies.chainId,
  });
  recordConfiguredChainProof({
    proof: state.configuredChainProof,
    rpcSource: dependencies.rpcSource,
    observations,
    target: configuredChainTarget,
    chainAnchor: state.anchor,
  });
  return Object.freeze({
    block,
    anchor: state.anchor,
    reference: state.stateReference,
  });
};

type OptionalText = TokenInspectionData["metadata"]["name"];
const readRequiredTotalSupply = async (
  dependencies: TokenInspectionDependencies,
  address: TokenInspectionInput["asset"]["address"],
  reference: RpcCanonicalBlockReference,
  signal: AbortSignal,
): Promise<unknown> => {
  try {
    return await dependencies.rpc.request("eth_call", [{
      to: address,
      data: dependencies.encoder.totalSupply(),
    }, reference], signal);
  } catch (error) {
    if (isRpcExecutionRevertedError(error)) throw createRequiredTotalSupplyRevertedError();
    throw error;
  }
};

const inspectionHandler = async (
  dependencies: TokenInspectionDependencies,
  request: TokenInspectionInput,
  context: ChainInvocationContext,
  observations: ObservationWriter,
): Promise<Readonly<{
  success: Readonly<{ status: "success"; data: TokenInspectionData }>;
  block: CanonicalBlock;
}>> => {
  if (request.asset.chainId !== dependencies.chainId) throw new ChainOperationError("invalid_input");
  const signal = context.signal;
  const configuredChain = observations.bind(
    tokenInspectionEvidence.configuredChain.target,
  );
  const totalSupplyTarget = observations.bind(
    tokenInspectionEvidence.targets.totalSupply,
  );
  const decimalsTarget = observations.bind(tokenInspectionEvidence.targets.decimals);
  const nameTarget = observations.bind(tokenInspectionEvidence.targets.name);
  const symbolTarget = observations.bind(tokenInspectionEvidence.targets.symbol);
  const standardTargets = tokenStandardOrder.map((standardId) => Object.freeze({
    standardId,
    target: observations.bind(tokenInspectionEvidence.targets.standards[standardId]),
  }));
  const requiredErc8056Target = observations.bind(
    tokenInspectionEvidence.targets.requiredErc8056,
  );
  const block = await resolveBlock(
    dependencies,
    request,
    context,
    observations,
    configuredChain,
  );

  const stop = new AbortController();
  const callSignal = AbortSignal.any([signal, stop.signal]);
  const analysisChain = createContractAnalysisChainReadPort({
    rpc: dependencies.rpc,
    encoder: dependencies.contractAnalysisEncoder,
    chainId: dependencies.chainId,
    block: block.anchor,
    stateReference: block.reference,
    signal: callSignal,
  });
  const calls = [
    analyzeContract({
      target: request.asset.address,
      chain: analysisChain,
      sourceVerification: dependencies.contractSourceVerification,
      signal: callSignal,
    }),
    readRequiredTotalSupply(dependencies, request.asset.address, block.reference, callSignal),
    readTokenMetadataAtBlock(dependencies, {
      asset: request.asset,
      stateReference: block.reference,
      signal: callSignal,
    }),
    (async () => {
      const requiredStandards = await observeRequiredErc8056({
        rpc: dependencies.rpc,
        asset: request.asset,
        block: block.anchor,
        stateReference: block.reference,
        signal: callSignal,
      });
      return completeTokenStandardObservation({
        rpc: dependencies.rpc,
        asset: request.asset,
        block: block.anchor,
        stateReference: block.reference,
        signal: callSignal,
        erc20ReadSurfaceObserved: true,
      }, requiredStandards);
    })(),
  ] as const;
  const callResults = await (async () => {
    try {
      return await Promise.all(calls);
    } catch (error) {
      stop.abort();
      await Promise.allSettled(calls);
      throw error;
    }
  })();
  const [analysisExecution, rawTotalSupply, metadata, standards] = callResults;
  const analysis = recordContractAnalysisEvidence({
    target: {
      chainId: dependencies.chainId,
      address: request.asset.address,
      block: block.anchor,
      runtimeCode: analysisExecution.targetRuntimeCode.identity,
    },
    sourceVerification: dependencies.contractSourceVerification,
    execution: analysisExecution,
    fragment: tokenInspectionEvidence.analysis,
    observations,
    chainAuthority: dependencies.rpcSource,
  });
  const { name, symbol, decimals } = metadata;
  const standardEvidence = projectTokenInspectionStandardEvidence(standards);
  const totalSupplyRaw = normalizeSource(() =>
    decodeAbiUint256Result(normalizeRpcBytes(rawTotalSupply)));

  const supplyObservationId = observations.record(totalSupplyTarget.slot, {
    source: dependencies.rpcSource,
    claims: [{
      role: totalSupplyTarget.roles.value,
      value: totalSupplyRaw,
      asset: request.asset,
      chainAnchor: block.anchor,
    }],
  });
  const decimalsObservationId = observations.record(decimalsTarget.slot, {
    source: dependencies.rpcSource,
    claims: [{
      role: decimalsTarget.roles.value,
      value: decimals.status === "available"
        ? decimals.value
        : { status: "unavailable", reason: decimals.reason },
      asset: request.asset,
      chainAnchor: block.anchor,
    }],
  });
  const nameObservationId = observations.record(nameTarget.slot, {
    source: dependencies.rpcSource,
    claims: [{
      role: nameTarget.roles.value,
      value: name.status === "available"
        ? name.value
        : { status: "unavailable", reason: name.reason },
      asset: request.asset,
      chainAnchor: block.anchor,
    }],
  });
  const symbolObservationId = observations.record(symbolTarget.slot, {
    source: dependencies.rpcSource,
    claims: [{
      role: symbolTarget.roles.value,
      value: symbol.status === "available"
        ? symbol.value
        : { status: "unavailable", reason: symbol.reason },
      asset: request.asset,
      chainAnchor: block.anchor,
    }],
  });
  for (const entry of standardTargets) {
    const projection = standardEvidence.standards[entry.standardId];
    if (projection.observationValue === undefined) continue;
    observations.record(entry.target.slot, {
      source: dependencies.rpcSource,
      claims: [{
        role: entry.target.roles.value,
        value: projection.observationValue,
        asset: request.asset,
        chainAnchor: block.anchor,
      }],
    });
  }
  if (standardEvidence.requiredErc8056.observationValue !== undefined) {
    observations.record(requiredErc8056Target.slot, {
      source: dependencies.rpcSource,
      claims: [{
        role: requiredErc8056Target.roles.value,
        value: standardEvidence.requiredErc8056.observationValue,
        asset: request.asset,
        chainAnchor: block.anchor,
      }],
    });
  }

  const totalSupply: CanonicalAmount = Object.freeze({
    asset: request.asset,
    raw: totalSupplyRaw,
    decimals: decimals.status === "unavailable"
      ? Object.freeze({ status: "unavailable" as const, reason: "missing" as const, observationIds: [decimalsObservationId] })
      : Object.freeze({ status: "available" as const, value: decimals.value, observationId: decimalsObservationId }),
    quantityObservationId: supplyObservationId,
  });
  const data: TokenInspectionData = Object.freeze({
    asset: request.asset,
    analysis,
    totalSupply,
    metadata: Object.freeze({
      name: Object.freeze({ ...name, observationId: nameObservationId }) as OptionalText,
      symbol: Object.freeze({ ...symbol, observationId: symbolObservationId }) as OptionalText,
      decimalsReadFailure: decimals.status === "unavailable" ? decimals.reason : null,
    }),
    standards,
  });
  return Object.freeze({
    success: Object.freeze({ status: "success", data }),
    block: block.block,
  });
};

export interface TokenInspectionService {
  readonly binding: CapabilityBinding<typeof tokenInspectCapability>;
  readonly additionReads: TokenAdditionChainReadPort;
}

export const createTokenInspectionService = (input: {
  readonly context: ChainOwnerApplicationContext<ActiveWalletReadPort>;
  readonly rpc: RpcRequester;
  readonly encoder: Erc20CallEncoder;
  readonly lifecycle: ChainInvocationLifecycle;
  readonly officialAssetReads: OfficialAssetChainReadPort;
}): TokenInspectionService => {
  const dependencies: TokenInspectionDependencies = Object.freeze({
    rpc: input.rpc,
    encoder: input.encoder,
    contractAnalysisEncoder: createContractAnalysisCallEncoder(),
    contractSourceVerification: input.context.chain.contractSourceVerification,
    rpcSource: input.context.chain.sourceAuthority.observationAuthority,
    chainId: input.context.chain.configuration.chain.chainId,
  });
  const basePorts = input.context.chain.capabilityAuthority.invocationPorts;
  const captureContexts = new WeakSet<object>();
  const capturedBlocks = new WeakMap<object, CanonicalBlock>();
  const execute = (
    callerSignal: AbortSignal,
    operation: (context: ChainInvocationContext) => Promise<unknown>,
  ): Promise<unknown> => runInspection(input.lifecycle, callerSignal, operation);
  const binding = bindCapability({
    definition: tokenInspectCapability,
    errorRegistry: tokenCatalogErrorRegistry,
    invocationAuthority: input.context.chain.capabilityAuthority.invocationAuthority,
    createInvocationPorts: (): InvocationBoundaryPorts => Object.freeze({
      observations: basePorts.observations,
    }),
    handler: async (request, context: HandlerInvocationContext<InvocationBoundaryPorts>, observations) =>
      execute(context.signal, async (chainInvocation) => {
        const execution = await inspectionHandler(
          dependencies,
          request,
          chainInvocation,
          observations,
        );
        if (captureContexts.has(chainInvocation)) {
          capturedBlocks.set(chainInvocation, execution.block);
        }
        return execution.success;
      }),
  });
  const inspections = new CapabilityBindingRegistry(
    new CapabilityRegistry([tokenInspectCapability]),
    [binding],
  );
  const additionReads: TokenAdditionChainReadPort = Object.freeze({
    async inspectAndVerifyOfficial(
      request: Parameters<TokenAdditionChainReadPort["inspectAndVerifyOfficial"]>[0],
      callerSignal: Parameters<TokenAdditionChainReadPort["inspectAndVerifyOfficial"]>[1],
    ) {
      try {
        return await input.lifecycle.run(callerSignal, async (context) => {
          if (
            request.asset.chainId !== dependencies.chainId ||
            (request.officialMember !== null &&
              request.officialMember.contractAddress !== request.asset.address)
          ) {
            throw new ChainOperationError("invalid_input");
          }
          captureContexts.add(context);
          try {
            const inspection = await inspections.invoke(
              tokenInspectCapability,
              {
                asset: request.asset,
                block: request.block === null
                  ? { kind: "latest" }
                  : { kind: "number", blockNumber: request.block.blockNumber },
              },
              { signal: context.signal },
            );
            if (!inspection.ok) return inspection;
            const block = capturedBlocks.get(context);
            if (block === undefined) throw new ChainOperationError("internal_error");
            if (request.block !== null && (
              block.anchor.chainId !== request.block.chainId ||
              block.anchor.blockNumber !== request.block.blockNumber ||
              block.anchor.blockHash !== request.block.blockHash ||
              block.anchor.blockTimestamp !== request.block.blockTimestamp
            )) throw new ChainOperationError("source_inconsistent");
            const officialResult = request.officialMember === null
              ? null
              : await input.officialAssetReads.verifyAtBlock(
                  request.officialMember,
                  block,
                  context,
                );
            if (officialResult?.status === "unavailable") {
              return createTokenCatalogFailure(officialResult.reason);
            }
            const officialVerification = officialResult?.verification ?? null;
            return Object.freeze({ inspection, officialVerification });
          } finally {
            captureContexts.delete(context);
            capturedBlocks.delete(context);
          }
        });
      } catch (error) {
        return createTokenCatalogFailure(
          inspectionFailureCode(error, callerSignal) ?? "internal_error",
        );
      }
    },
  });

  return Object.freeze({ binding, additionReads });
};
