import { uniswapProtocolFamily } from "../uniswap.js";
import {
  bindCapability,
  deepFreezeValue,
  type CapabilityBinding,
  type CapabilityInvocationAuthority,
  type HandlerInvocationContext,
  type HexBytes,
  type InvocationBoundaryPorts,
  type ObservationWriter,
} from "../../core/index.js";
import {
  normalizePinnedEvmReadFailure,
  type ChainInvocationContext,
  type ChainInvocationPort,
  type PinnedEvmCallResult,
  type PinnedEvmReadPort,
} from "../../chain/index.js";
import {
  uniswapV2QuoteCapability,
  uniswapV2CandidateSchema,
  uniswapV2EvaluatedHopSchema,
  uniswapV2QuoteDataSchema,
  type UniswapV2EvaluatedHop,
  type UniswapV2EvaluatedToken,
  type UniswapV2QuoteData,
  type UniswapV2QuoteInput,
  type UniswapV2TokenDecimals,
} from "./contracts.js";
import {
  uniswapV2DeploymentSource,
  uniswapV2FactoryAddress,
  uniswapV2FactoryRuntimeCodeIdentity,
  uniswapV2PairInitCodeHash,
  uniswapV2ProtocolId,
  uniswapV2RouteAssets,
  uniswapV2RouteCoverageBasis,
  uniswapV2RouteAssetSource,
  uniswapV2SdkDependencies,
} from "./deployment.js";
import {
  createUniswapV2DecimalsObservationClaim,
  createUniswapV2PairObservationClaim,
  uniswapV2DecimalsEvidenceTarget,
  uniswapV2PairEvidenceTarget,
  uniswapV2QuoteEvidence,
} from "./evidence.js";
import { uniswapV2Evm } from "./evm.js";
import {
  calculateUniswapV2AmountOut,
  calculateUniswapV2Prices,
  computeUniswapV2PairAddress,
  constructUniswapV2CandidatePaths,
  orderedTokenAddresses,
  uniswapV2FeeRate,
} from "./quote.js";
import {
  compareUniswapV2SdkQuote,
  type UniswapV2SdkHopInput,
} from "./sdk.js";
import { uniswapV2ErrorRegistry } from "./errors.js";

const zeroAddress = "0x0000000000000000000000000000000000000000" as const;

type UniswapV2FailureCode =
  | "not_found"
  | "source_inconsistent"
  | "token_decimals_unavailable";

class UniswapV2OperationError extends Error {
  readonly code: UniswapV2FailureCode;

  constructor(code: UniswapV2FailureCode) {
    super(code);
    this.name = "UniswapV2OperationError";
    this.code = code;
    Object.freeze(this);
  }
}

const asFailure = (code: string) => ({
  status: "failure" as const,
  code,
  issues: [],
});

const observedCall = async (
  read: Promise<PinnedEvmCallResult<HexBytes>>,
): Promise<HexBytes> => {
  const result = await read;
  if (result.status === "reverted") {
    throw new UniswapV2OperationError("source_inconsistent");
  }
  return result.value;
};

const decodeChainResult = <Value>(
  decode: () => Value,
): Value => {
  try {
    return decode();
  } catch {
    throw new UniswapV2OperationError("source_inconsistent");
  }
};

const decimalsState = (value: string): UniswapV2TokenDecimals =>
  Object.freeze({ status: "observed", value }) as UniswapV2TokenDecimals;

const evaluatedToken = (
  asset: UniswapV2EvaluatedToken["asset"],
  decimals: UniswapV2TokenDecimals,
): UniswapV2EvaluatedToken => deepFreezeValue({ asset, decimals });

const recordPair = (
  observations: ObservationWriter,
  reads: PinnedEvmReadPort,
  block: UniswapV2QuoteData["block"],
  candidateIndex: number,
  hopIndex: number,
  hop: UniswapV2EvaluatedHop,
): void => {
  const target = observations.bind(
    uniswapV2PairEvidenceTarget(candidateIndex, hopIndex),
  );
  observations.record(target.slot, {
    source: reads.observationAuthority,
    claims: [{
      role: target.roles.value,
      value: createUniswapV2PairObservationClaim(candidateIndex, hopIndex, hop),
      chainAnchor: block,
    }],
  });
};

const recordDecimals = (
  request: UniswapV2QuoteInput,
  observations: ObservationWriter,
  reads: PinnedEvmReadPort,
  block: UniswapV2QuoteData["block"],
  address: UniswapV2QuoteInput["tokenIn"]["address"],
  decimals: Exclude<UniswapV2TokenDecimals, { status: "not_observed" }>,
): void => {
  const target = observations.bind(
    uniswapV2DecimalsEvidenceTarget(request, address),
  );
  observations.record(target.slot, {
    source: reads.observationAuthority,
    claims: [{
      role: target.roles.value,
      value: createUniswapV2DecimalsObservationClaim(address, decimals),
      chainAnchor: block,
    }],
  });
};

const readEndpointDecimals = async (
  request: UniswapV2QuoteInput,
  context: ChainInvocationContext,
  reads: PinnedEvmReadPort,
  block: Awaited<ReturnType<PinnedEvmReadPort["resolveBlock"]>>,
  observations: ObservationWriter,
): Promise<ReadonlyMap<string, UniswapV2TokenDecimals>> => {
  const result = new Map<string, UniswapV2TokenDecimals>();
  for (const asset of [request.tokenIn, request.tokenOut]) {
    const observed = await reads.readTokenDecimals(
      context,
      block,
      asset.address,
    );
    if (observed.status === "reverted") {
      throw new UniswapV2OperationError("token_decimals_unavailable");
    }
    const state = decimalsState(observed.value);
    result.set(asset.address, state);
    recordDecimals(request, observations, reads, block.anchor, asset.address, state as
      Extract<UniswapV2TokenDecimals, { status: "observed" }>);
  }
  return result;
};

const readIntermediaryDecimals = async (
  request: UniswapV2QuoteInput,
  context: ChainInvocationContext,
  reads: PinnedEvmReadPort,
  block: Awaited<ReturnType<PinnedEvmReadPort["resolveBlock"]>>,
  observations: ObservationWriter,
  address: UniswapV2QuoteInput["tokenIn"]["address"],
): Promise<UniswapV2TokenDecimals> => {
  const observed = await reads.readTokenDecimals(
    context,
    block,
    address,
  );
  if (observed.status === "reverted") {
    const state = Object.freeze({
      status: "unavailable" as const,
      reason: "call_reverted" as const,
    });
    recordDecimals(
      request,
      observations,
      reads,
      block.anchor,
      address,
      state,
    );
    return state;
  }
  const state = decimalsState(observed.value);
  recordDecimals(request, observations, reads, block.anchor, address, state as
    Extract<UniswapV2TokenDecimals, { status: "observed" }>);
  return state;
};

const replaceTokenDecimals = (
  hops: readonly UniswapV2EvaluatedHop[],
  address: string,
  decimals: UniswapV2TokenDecimals,
): readonly UniswapV2EvaluatedHop[] => deepFreezeValue(hops.map((hop) =>
  uniswapV2EvaluatedHopSchema.parse({
    ...hop,
    tokenIn: hop.tokenIn.asset.address === address
      ? { ...hop.tokenIn, decimals }
      : hop.tokenIn,
    tokenOut: hop.tokenOut.asset.address === address
      ? { ...hop.tokenOut, decimals }
      : hop.tokenOut,
  })));

const evaluateCandidate = async (
  request: UniswapV2QuoteInput,
  context: ChainInvocationContext,
  reads: PinnedEvmReadPort,
  block: Awaited<ReturnType<PinnedEvmReadPort["resolveBlock"]>>,
  observations: ObservationWriter,
  endpointDecimals: ReadonlyMap<string, UniswapV2TokenDecimals>,
  candidateIndex: number,
  path: readonly UniswapV2QuoteInput["tokenIn"][],
): Promise<UniswapV2QuoteData["candidates"][number]> => {
  let amount = BigInt(request.amountIn);
  const hops: UniswapV2EvaluatedHop[] = [];
  const sdkHops: UniswapV2SdkHopInput[] = [];
  const reserves: { reserveIn: bigint; reserveOut: bigint }[] = [];

  for (let hopIndex = 0; hopIndex < path.length - 1; hopIndex += 1) {
    const tokenIn = path[hopIndex];
    const tokenOut = path[hopIndex + 1];
    if (tokenIn === undefined || tokenOut === undefined) {
      throw new TypeError("V2 candidate path is incomplete.");
    }
    const inputDecimals = endpointDecimals.get(tokenIn.address) ??
      Object.freeze({ status: "not_observed" as const });
    const outputDecimals = endpointDecimals.get(tokenOut.address) ??
      Object.freeze({ status: "not_observed" as const });
    const hopBase = {
      tokenIn: evaluatedToken(tokenIn, inputDecimals),
      tokenOut: evaluatedToken(tokenOut, outputDecimals),
      amountIn: amount.toString(10),
    };
    const factoryResultBytes = await observedCall(
      reads.call(context, block, {
        to: uniswapV2FactoryAddress,
        data: uniswapV2Evm.getPair(tokenIn.address, tokenOut.address),
      }),
    );
    const factoryResult = decodeChainResult(
      () => uniswapV2Evm.decodePair(factoryResultBytes),
    );
    if (factoryResult === zeroAddress) {
      const hop = uniswapV2EvaluatedHopSchema.parse({
        ...hopBase,
        status: "pair_absent" as const,
        factoryResult,
      });
      hops.push(hop);
      recordPair(observations, reads, block.anchor, candidateIndex, hopIndex, hop);
      return uniswapV2CandidateSchema.parse({
        status: "pair_absent" as const,
        path: [...path],
        evaluatedHops: hops,
      });
    }
    const expectedPair = computeUniswapV2PairAddress({
      factory: uniswapV2FactoryAddress,
      tokenA: tokenIn.address,
      tokenB: tokenOut.address,
      pairInitCodeHash: uniswapV2PairInitCodeHash,
    });
    if (factoryResult !== expectedPair) {
      throw new UniswapV2OperationError("source_inconsistent");
    }
    const runtimeCode = await reads.readRuntimeCode(context, block, factoryResult);
    if (runtimeCode === null) {
      throw new UniswapV2OperationError("source_inconsistent");
    }
    const factoryBytes = await observedCall(
      reads.call(context, block, { to: factoryResult, data: uniswapV2Evm.factory() }),
    );
    const token0Bytes = await observedCall(
      reads.call(context, block, { to: factoryResult, data: uniswapV2Evm.token0() }),
    );
    const token1Bytes = await observedCall(
      reads.call(context, block, { to: factoryResult, data: uniswapV2Evm.token1() }),
    );
    const reservesBytes = await observedCall(
      reads.call(context, block, { to: factoryResult, data: uniswapV2Evm.reserves() }),
    );
    const factory = decodeChainResult(
      () => uniswapV2Evm.decodeFactory(factoryBytes),
    );
    const token0 = decodeChainResult(
      () => uniswapV2Evm.decodeToken0(token0Bytes),
    );
    const token1 = decodeChainResult(
      () => uniswapV2Evm.decodeToken1(token1Bytes),
    );
    const decodedReserves = decodeChainResult(
      () => uniswapV2Evm.decodeReserves(reservesBytes),
    );
    const ordered = orderedTokenAddresses(tokenIn.address, tokenOut.address);
    if (
      factory !== uniswapV2FactoryAddress ||
      token0 !== ordered[0] ||
      token1 !== ordered[1]
    ) {
      throw new UniswapV2OperationError("source_inconsistent");
    }
    const pair = deepFreezeValue({
      pairAddress: factoryResult,
      runtimeCode: runtimeCode.identity,
      factory,
      token0,
      token1,
      reserve0: decodedReserves.reserve0.toString(10),
      reserve1: decodedReserves.reserve1.toString(10),
    });
    const token0IsInput = tokenIn.address === token0;
    const direction = {
      reserveIn: token0IsInput ? decodedReserves.reserve0 : decodedReserves.reserve1,
      reserveOut: token0IsInput ? decodedReserves.reserve1 : decodedReserves.reserve0,
    };
    const calculation = calculateUniswapV2AmountOut({
      amountIn: amount,
      ...direction,
    });
    if (calculation.status !== "quoted") {
      const hop = uniswapV2EvaluatedHopSchema.parse({
        ...hopBase,
        status: calculation.status,
        factoryResult,
        pair,
        ...(calculation.status === "amount_too_small" ? { amountOut: "0" as const } : {}),
        feeRate: uniswapV2FeeRate,
      });
      hops.push(hop);
      recordPair(observations, reads, block.anchor, candidateIndex, hopIndex, hop);
      return uniswapV2CandidateSchema.parse({
        status: calculation.status,
        path: [...path],
        evaluatedHops: hops,
      });
    }
    const hop = uniswapV2EvaluatedHopSchema.parse({
      ...hopBase,
      status: "completed" as const,
      factoryResult,
      pair,
      amountOut: calculation.amountOut.toString(10),
      feeRate: uniswapV2FeeRate,
    });
    hops.push(hop);
    recordPair(observations, reads, block.anchor, candidateIndex, hopIndex, hop);
    reserves.push(direction);
    sdkHops.push({
      tokenIn,
      tokenOut,
      tokenInDecimals: "",
      tokenOutDecimals: "",
      reserve0: pair.reserve0,
      reserve1: pair.reserve1,
      expectedPair,
    });
    amount = calculation.amountOut;
  }

  let finalizedHops: readonly UniswapV2EvaluatedHop[] = hops;
  if (path.length === 3) {
    const intermediary = path[1];
    if (intermediary === undefined) throw new TypeError("V2 intermediary is absent.");
    const state = await readIntermediaryDecimals(
      request,
      context,
      reads,
      block,
      observations,
      intermediary.address,
    );
    finalizedHops = replaceTokenDecimals(finalizedHops, intermediary.address, state);
  }
  const decimalsByAddress = new Map<string, UniswapV2TokenDecimals>();
  for (const hop of finalizedHops) {
    decimalsByAddress.set(hop.tokenIn.asset.address, hop.tokenIn.decimals);
    decimalsByAddress.set(hop.tokenOut.asset.address, hop.tokenOut.decimals);
  }
  const outsideSdkRange = [...decimalsByAddress.values()].some(
    (state) => state.status === "observed" && state.value === "255",
  );
  const unavailableIntermediary = [...decimalsByAddress.values()].some(
    (state) => state.status === "unavailable",
  );
  const sdkCheck = outsideSdkRange
    ? Object.freeze({
        status: "not_available" as const,
        reason: "token_decimals_outside_sdk_range" as const,
      })
    : unavailableIntermediary
      ? Object.freeze({
          status: "not_available" as const,
          reason: "intermediary_decimals_unavailable" as const,
        })
      : (() => {
          for (let index = 0; index < sdkHops.length; index += 1) {
            const sdkHop = sdkHops[index];
            const finalized = finalizedHops[index];
            if (sdkHop === undefined || finalized === undefined) {
              throw new TypeError("V2 SDK hop is incomplete.");
            }
            const inputState = finalized.tokenIn.decimals;
            const outputState = finalized.tokenOut.decimals;
            if (inputState.status !== "observed" || outputState.status !== "observed") {
              throw new TypeError("V2 SDK token decimals are unavailable.");
            }
            sdkHops[index] = {
              ...sdkHop,
              tokenInDecimals: inputState.value,
              tokenOutDecimals: outputState.value,
            };
          }
          compareUniswapV2SdkQuote({
            amountIn: request.amountIn,
            expectedAmountOut: amount.toString(10),
            hops: sdkHops,
          });
          return Object.freeze({
            status: "matched" as const,
            sdkCoreVersion: uniswapV2SdkDependencies.sdkCore.version,
            v2SdkVersion: uniswapV2SdkDependencies.v2Sdk.version,
          });
        })();
  const prices = calculateUniswapV2Prices({
    amountIn: BigInt(request.amountIn),
    amountOut: amount,
    reserves,
  });
  return uniswapV2CandidateSchema.parse({
    status: "quoted" as const,
    path: [...path],
    evaluatedHops: finalizedHops,
    amountOut: amount.toString(10),
    ...prices,
    sdkCheck,
  });
};

const executeQuote = async (
  request: UniswapV2QuoteInput,
  context: HandlerInvocationContext<InvocationBoundaryPorts>,
  observations: ObservationWriter,
  dependencies: Readonly<{
    readonly invocations: ChainInvocationPort;
    readonly reads: PinnedEvmReadPort;
  }>,
): Promise<unknown> => {
  try {
    return await dependencies.invocations.run(context.signal, async (chainContext) => {
      const block = await dependencies.reads.resolveBlock(chainContext, request.block);
      const chainTarget = observations.bind(uniswapV2QuoteEvidence.configuredChain.target);
      dependencies.reads.recordConfiguredChain(
        chainContext,
        block,
        observations,
        chainTarget,
      );
      const factoryRuntimeCode = await dependencies.reads.readRuntimeCode(
        chainContext,
        block,
        uniswapV2FactoryAddress,
      );
      if (factoryRuntimeCode === null) {
        throw new UniswapV2OperationError("not_found");
      }
      if (
        factoryRuntimeCode.identity.byteLength !==
          uniswapV2FactoryRuntimeCodeIdentity.byteLength ||
        factoryRuntimeCode.identity.codeHash !==
          uniswapV2FactoryRuntimeCodeIdentity.codeHash
      ) {
        throw new UniswapV2OperationError("source_inconsistent");
      }
      const analysis = await dependencies.reads.inspectContract(
        chainContext,
        block,
        {
          address: uniswapV2FactoryAddress,
          runtimeCode: factoryRuntimeCode.identity,
        },
        {
          fragment: uniswapV2QuoteEvidence.analysis,
          observations,
        },
      );
      const endpointDecimals = await readEndpointDecimals(
        request,
        chainContext,
        dependencies.reads,
        block,
        observations,
      );
      const paths = constructUniswapV2CandidatePaths(
        request.tokenIn,
        request.tokenOut,
        uniswapV2RouteAssets,
      );
      const candidates: UniswapV2QuoteData["candidates"][number][] = [];
      for (let index = 0; index < paths.length; index += 1) {
        const path = paths[index];
        if (path === undefined) throw new TypeError("V2 candidate path is absent.");
        candidates.push(await evaluateCandidate(
          request,
          chainContext,
          dependencies.reads,
          block,
          observations,
          endpointDecimals,
          index,
          path,
        ));
      }
      const tokenInDecimals = endpointDecimals.get(request.tokenIn.address);
      const tokenOutDecimals = endpointDecimals.get(request.tokenOut.address);
      if (
        tokenInDecimals?.status !== "observed" ||
        tokenOutDecimals?.status !== "observed"
      ) {
        throw new TypeError("V2 endpoint decimals handoff is incomplete.");
      }
      return {
        status: "success" as const,
        data: uniswapV2QuoteDataSchema.parse({
          protocol: {
            familyId: uniswapProtocolFamily.familyId,
            protocolId: uniswapV2ProtocolId,
          },
          deployment: {
            chainId: block.anchor.chainId,
            factory: uniswapV2FactoryAddress,
            runtimeCode: factoryRuntimeCode.identity,
            analysis,
            pairInitCodeHash: uniswapV2PairInitCodeHash,
            source: uniswapV2DeploymentSource,
          },
          block: block.anchor,
          input: {
            tokenIn: request.tokenIn,
            tokenOut: request.tokenOut,
            tokenInDecimals: tokenInDecimals.value,
            tokenOutDecimals: tokenOutDecimals.value,
            factory: request.factory,
            amountIn: request.amountIn,
          },
          candidates,
          coverage: {
            basis: uniswapV2RouteCoverageBasis,
            routeAssets: uniswapV2RouteAssets.map((asset) => asset.address),
            source: uniswapV2RouteAssetSource,
          },
        }),
      };
    });
  } catch (error) {
    if (error instanceof UniswapV2OperationError) return asFailure(error.code);
    const code = normalizePinnedEvmReadFailure(error, context.signal);
    if (code !== undefined) return asFailure(code);
    throw error;
  }
};

export interface UniswapV2QuoteApplication {
  readonly binding: CapabilityBinding<typeof uniswapV2QuoteCapability>;
}

export const createUniswapV2QuoteApplication = (input: {
  readonly invocations: ChainInvocationPort;
  readonly reads: PinnedEvmReadPort;
  readonly invocationAuthority: CapabilityInvocationAuthority;
  readonly invocationPorts: InvocationBoundaryPorts;
}): UniswapV2QuoteApplication => Object.freeze({
  binding: bindCapability({
    definition: uniswapV2QuoteCapability,
    errorRegistry: uniswapV2ErrorRegistry,
    invocationAuthority: input.invocationAuthority,
    createInvocationPorts: () => input.invocationPorts,
    handler: (request, context, observations) =>
      executeQuote(request, context, observations, input),
  }),
});
