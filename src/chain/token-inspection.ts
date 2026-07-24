import {
  CapabilityBindingRegistry,
  CapabilityRegistry,
  bindCapability,
  type BoundEvidenceObservationTarget,
  type CapabilityBinding,
  type CanonicalAmount,
  type CanonicalJson,
  type ChainAnchor,
  type HandlerInvocationContext,
  type InvocationBoundaryPorts,
  type ObservationAuthority,
  type ObservationWriter,
  type TokenMetadataRead,
} from "../core/index.js";
import type { ChainOwnerApplicationContext } from "../runtime/application-context.js";
import type { ActiveWalletReadPort } from "../wallet/coordinator.js";
import {
  tokenInspectCapability,
  tokenInspectionEvidence,
  type TokenInspectionData,
  type TokenInspectionInput,
} from "../token-catalog/contracts.js";
import type { TokenAdditionChainReadPort } from "../token-catalog/ports.js";
import {
  decodeErc20TotalSupplyResult,
  type Erc20CallEncoder,
} from "./evm-standard.js";
import {
  normalizeRpcBytes,
  normalizeRpcRuntimeCode,
} from "./normalization.js";
import {
  getChainRpcErrorCode,
  isRpcExecutionRevertedError,
  type RpcCanonicalBlockReference,
  type RpcRequester,
} from "./rpc.js";
import {
  ChainOperationError,
  getChainOperationFailure,
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
  getChainInvocationStopReason,
  type ChainInvocationContext,
  type ChainInvocationLifecycle,
} from "./invocation-lifecycle.js";
import {
  completeTokenStandardObservation,
  observeRequiredErc8056,
} from "./token-standards.js";
import type { OfficialAssetChainReadPort } from "./official-assets.js";
import { readTokenMetadataAtBlock } from "./token-metadata.js";

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
  readonly rpcSource: ObservationAuthority;
  readonly chainId: TokenInspectionInput["asset"]["chainId"];
}

const asFailure = (code: string) => ({ status: "failure" as const, code, issues: Object.freeze([]) });

const inspectionFailureCode = (
  error: unknown,
  callerSignal: AbortSignal,
): string | undefined => {
  const stopReason = getChainInvocationStopReason(error);
  if (stopReason !== undefined) {
    return stopReason === "caller_aborted" ? "request_aborted" : "source_unavailable";
  }
  if (isRequiredTotalSupplyRevertedError(error)) return "token_total_supply_reverted";
  const operationFailure = getChainOperationFailure(error);
  if (operationFailure !== undefined) return operationFailure.error.code;
  const rpcCode = getChainRpcErrorCode(error);
  if (rpcCode !== undefined) {
    return rpcCode === "request_aborted" && !callerSignal.aborted
      ? "source_unavailable"
      : rpcCode;
  }
  return undefined;
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
  const blockTarget = observations.bind(tokenInspectionEvidence.targets.block);
  const runtimeCodeTarget = observations.bind(
    tokenInspectionEvidence.targets.runtimeCode,
  );
  const totalSupplyTarget = observations.bind(
    tokenInspectionEvidence.targets.totalSupply,
  );
  const decimalsTarget = observations.bind(tokenInspectionEvidence.targets.decimals);
  const nameTarget = observations.bind(tokenInspectionEvidence.targets.name);
  const symbolTarget = observations.bind(tokenInspectionEvidence.targets.symbol);
  const block = await resolveBlock(
    dependencies,
    request,
    context,
    observations,
    configuredChain,
  );

  const rawCode = await dependencies.rpc.request(
    "eth_getCode",
    [request.asset.address, block.reference],
    signal,
  );
  const runtimeCode = normalizeSource(() => normalizeRpcRuntimeCode(rawCode));
  if (runtimeCode.status === "empty") throw new ChainOperationError("not_found");

  const stop = new AbortController();
  const callSignal = AbortSignal.any([signal, stop.signal]);
  const calls = [
    readRequiredTotalSupply(dependencies, request.asset.address, block.reference, callSignal),
    readTokenMetadataAtBlock(dependencies, {
      asset: request.asset,
      stateReference: block.reference,
      signal: callSignal,
    }),
  ] as const;
  let callResults: [unknown, TokenMetadataRead];
  try {
    callResults = await Promise.all(calls);
  } catch (error) {
    stop.abort();
    await Promise.allSettled(calls);
    throw error;
  }
  const [rawTotalSupply, metadata] = callResults;
  const { name, symbol, decimals } = metadata;
  const totalSupplyRaw = normalizeSource(() =>
    decodeErc20TotalSupplyResult(normalizeRpcBytes(rawTotalSupply)));

  const blockObservationId = observations.record(blockTarget.slot, {
    source: dependencies.rpcSource,
    claims: [{
      role: blockTarget.roles.value,
      value: block.anchor as unknown as CanonicalJson,
      chainAnchor: block.anchor,
    }],
  });
  const runtimeCodeValue = Object.freeze({
    byteLength: runtimeCode.byteLength,
    codeHash: runtimeCode.codeHash,
  });
  observations.record(runtimeCodeTarget.slot, {
    source: dependencies.rpcSource,
    claims: [{
      role: runtimeCodeTarget.roles.value,
      value: runtimeCodeValue as unknown as CanonicalJson,
      asset: request.asset,
      chainAnchor: block.anchor,
    }],
  });
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
      value: decimals ?? { status: "unavailable", reason: "missing" },
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
  void blockObservationId;

  const totalSupply: CanonicalAmount = Object.freeze({
    asset: request.asset,
    raw: totalSupplyRaw,
    decimals: decimals === null
      ? Object.freeze({ status: "unavailable" as const, reason: "missing" as const, observationIds: [decimalsObservationId] })
      : Object.freeze({ status: "available" as const, value: decimals, observationId: decimalsObservationId }),
    quantityObservationId: supplyObservationId,
  });
  const requiredStandards = await observeRequiredErc8056({
    rpc: dependencies.rpc,
    asset: request.asset,
    block: block.anchor,
    stateReference: block.reference,
    signal,
  });
  const standards = await completeTokenStandardObservation({
    rpc: dependencies.rpc,
    asset: request.asset,
    block: block.anchor,
    stateReference: block.reference,
    signal,
    erc20ReadSurfaceObserved: true,
  }, requiredStandards);
  const data: TokenInspectionData = Object.freeze({
    asset: request.asset,
    block: block.anchor,
    runtimeCode: runtimeCodeValue,
    totalSupply,
    metadata: Object.freeze({
      name: Object.freeze({ ...name, observationId: nameObservationId }) as OptionalText,
      symbol: Object.freeze({ ...symbol, observationId: symbolObservationId }) as OptionalText,
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
              { asset: request.asset, block: { kind: "latest" } },
              { signal: context.signal },
            );
            if (!inspection.ok) return inspection;
            const block = capturedBlocks.get(context);
            if (block === undefined) throw new ChainOperationError("internal_error");
            const officialVerification = request.officialMember === null
              ? null
              : await input.officialAssetReads.verifyAtBlock(
                  request.officialMember,
                  block,
                  context,
                );
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
