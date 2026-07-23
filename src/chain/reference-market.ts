import {
  captureReferenceRoundObservation,
  createExactRational,
  createReferenceHistoryWorkPlan,
  deepFreezeValue,
  findReferenceFeed,
  parseReferenceCompositeRoundId,
  parseHexBytes,
  referenceCompositeRoundIdSchema,
  referenceFeedIdSchema,
  referenceFeedTraversalStateSchema,
  referenceMarketLimits,
  referenceMarketManifestVersion,
  referenceRoundFactSchema,
  referenceRoundObservationSchema,
  type CanonicalClock,
  type ChainAnchor,
  type HexBytes,
  type ObservationAuthority,
  type ReferenceFeedId,
  type ReferenceFeedTraversalState,
  type ReferenceFeedTraversalStatus,
  type ReferenceHistoryWorkSegment,
  type ReferenceRoundFact,
  type ReferenceRoundObservation,
} from "../core/index.js";
import {
  decodeErc20DecimalsResult,
  decodeErc20TextResult,
} from "./evm-standard.js";
import {
  readConfiguredCanonicalBlock,
  resolveConfiguredCanonicalBlock,
  type CanonicalBlock,
} from "./canonical-block.js";
import { ChainOperationError, getChainOperationFailure } from "./errors.js";
import {
  getChainInvocationStopReason,
  type ChainInvocationContext,
  type ChainInvocationLifecycle,
} from "./invocation-lifecycle.js";
import { normalizeRpcBytes, normalizeRpcRuntimeCode } from "./normalization.js";
import {
  getChainRpcErrorCode,
  isRpcBatchRejectedError,
  isRpcExecutionRevertedError,
  rpcConcurrencyLimit,
  type ChainRpcCall,
  type RpcCanonicalBlockReference,
  type RpcRequester,
} from "./rpc.js";

const descriptionCall = parseHexBytes("0x7284e416");
const decimalsCall = parseHexBytes("0x313ce567");
const latestRoundDataCall = parseHexBytes("0xfeaf968c");
const getRoundDataSelector = "0x9a6fc8f5" as const;
const uint80Maximum = (1n << 80n) - 1n;
const uint256Maximum = (1n << 256n) - 1n;
const int256Sign = 1n << 255n;
const maximumUtcUnixSeconds = 253_402_300_799n;

export interface ReferenceMarketCallEncoder {
  description(): HexBytes;
  decimals(): HexBytes;
  latestRoundData(): HexBytes;
  getRoundData(roundId: string): HexBytes;
}

export const createReferenceMarketCallEncoder = (): ReferenceMarketCallEncoder => Object.freeze({
  description: () => descriptionCall,
  decimals: () => decimalsCall,
  latestRoundData: () => latestRoundDataCall,
  getRoundData(roundIdInput: string): HexBytes {
    if (!/^[1-9][0-9]*$/u.test(roundIdInput)) {
      throw new TypeError("Reference round ID is invalid.");
    }
    const roundId = BigInt(roundIdInput);
    if (roundId > uint80Maximum) throw new TypeError("Reference round ID is invalid.");
    return parseHexBytes(`${getRoundDataSelector}${roundId.toString(16).padStart(64, "0")}`);
  },
});

interface DecodedRoundData {
  readonly roundId: bigint;
  readonly answer: bigint;
  readonly startedAt: bigint;
  readonly updatedAt: bigint;
  readonly answeredInRound: bigint;
}

const decodeRoundData = (input: unknown): DecodedRoundData => {
  const bytes = normalizeRpcBytes(input);
  if (!/^0x[0-9a-f]{320}$/u.test(bytes)) throw new TypeError("Reference round data is malformed.");
  const words = Array.from({ length: 5 }, (_, index) =>
    BigInt(`0x${bytes.slice(2 + index * 64, 2 + (index + 1) * 64)}`));
  const [roundId, rawAnswer, startedAt, updatedAt, answeredInRound] = words;
  if (
    roundId === undefined || rawAnswer === undefined || startedAt === undefined ||
    updatedAt === undefined || answeredInRound === undefined ||
    roundId > uint80Maximum || answeredInRound > uint80Maximum ||
    startedAt > maximumUtcUnixSeconds || updatedAt > maximumUtcUnixSeconds
  ) throw new TypeError("Reference round data is outside the supported range.");
  const answer = rawAnswer >= int256Sign ? rawAnswer - (uint256Maximum + 1n) : rawAnswer;
  return Object.freeze({ roundId, answer, startedAt, updatedAt, answeredInRound });
};

export interface ReferenceHistoryTraversal {
  readonly observations: readonly ReferenceRoundObservation[];
  readonly backfillPhaseId: string | null;
  readonly backfillNextRoundId: string | null;
  readonly backfillStatus: ReferenceFeedTraversalStatus;
  readonly phaseBoundaryObserved: boolean;
  readonly malformedRoundObserved: boolean;
  readonly failure: unknown | undefined;
}

export interface ReferenceMarketChainReadPort {
  resolveCurrentBlock(context: ChainInvocationContext): Promise<CanonicalBlock>;
  readLatestAtBlock(
    feedIds: readonly ReferenceFeedId[],
    block: CanonicalBlock,
    context: ChainInvocationContext,
  ): Promise<readonly ReferenceRoundObservation[]>;
  readHistoryAtBlock(
    input: Readonly<{
      feedId: ReferenceFeedId;
      latestRoundId: string;
      knownObservations: readonly ReferenceRoundObservation[];
      backfillPhaseId: string | null;
      backfillNextRoundId: string | null;
      backfillStatus: ReferenceFeedTraversalStatus;
      retentionCutoffRoundId: string | null;
      stopAtOrBeforeUnixSeconds: string;
      block: CanonicalBlock;
    }>,
    context: ChainInvocationContext,
  ): Promise<ReferenceHistoryTraversal>;
}

interface Dependencies {
  readonly rpc: RpcRequester;
  readonly encoder: ReferenceMarketCallEncoder;
  readonly chainId: ChainAnchor["chainId"];
  readonly lifecycle: ChainInvocationLifecycle;
  readonly clock: CanonicalClock;
  readonly observationAuthority: ObservationAuthority;
}

const normalizeFailure = (error: unknown, callerSignal: AbortSignal): never => {
  const stopReason = getChainInvocationStopReason(error);
  if (stopReason !== undefined) {
    throw new ChainOperationError(stopReason === "caller_aborted" ? "request_aborted" : "source_unavailable");
  }
  if (getChainOperationFailure(error) !== undefined) throw error;
  const rpcCode = getChainRpcErrorCode(error);
  if (rpcCode !== undefined) {
    throw new ChainOperationError(
      rpcCode === "request_aborted" && callerSignal.aborted ? "request_aborted" : rpcCode,
    );
  }
  throw error;
};

const normalizedFailure = (error: unknown, callerSignal: AbortSignal): unknown => {
  try {
    normalizeFailure(error, callerSignal);
  } catch (normalized) {
    return normalized;
  }
};

const allWithSiblingCancellation = async <Value>(
  operations: readonly ((signal: AbortSignal) => Promise<Value>)[],
  parentSignal: AbortSignal,
): Promise<Value[]> => {
  const stop = new AbortController();
  const signal = AbortSignal.any([parentSignal, stop.signal]);
  const pending = operations.map((operation) => operation(signal));
  try {
    return await Promise.all(pending);
  } catch (error) {
    stop.abort();
    await Promise.allSettled(pending);
    throw error;
  }
};

const requireBlock = (
  chainId: ChainAnchor["chainId"],
  blockInput: CanonicalBlock,
  context: ChainInvocationContext,
): Readonly<{ block: ChainAnchor; reference: RpcCanonicalBlockReference }> => {
  const block = readConfiguredCanonicalBlock({
    context,
    block: blockInput,
    chainId,
  });
  return Object.freeze({ block: block.anchor, reference: block.stateReference });
};

const decodeDescription = (input: unknown): string => {
  const decoded = decodeErc20TextResult(normalizeRpcBytes(input), "name", 64);
  if (decoded.status !== "decoded") throw new TypeError("Reference feed description is malformed.");
  return decoded.value;
};

type ReferenceRoundCandidate =
  | Readonly<{ status: "admitted"; fact: ReferenceRoundFact }>
  | Readonly<{ status: "malformed" }>;

const malformedRoundCandidate = Object.freeze({
  status: "malformed" as const,
});

const parseRoundCandidate = (
  feedId: ReferenceFeedId,
  input: unknown,
  block: ChainAnchor,
  expectedRoundId?: string,
): ReferenceRoundCandidate => {
  const feed = findReferenceFeed(feedId);
  let decoded: DecodedRoundData;
  try {
    decoded = decodeRoundData(input);
  } catch {
    return malformedRoundCandidate;
  }
  if (
    decoded.roundId <= 0n ||
    decoded.answer <= 0n ||
    decoded.updatedAt <= 0n ||
    decoded.updatedAt * 1_000n > BigInt(Date.parse(block.blockTimestamp)) ||
    (expectedRoundId !== undefined && decoded.roundId.toString(10) !== expectedRoundId)
  ) return malformedRoundCandidate;
  const fact = referenceRoundFactSchema.safeParse({
    manifestVersion: referenceMarketManifestVersion,
    feedId,
    proxyAddress: feed.standardProxy,
    decimals: feed.decimals,
    roundId: decoded.roundId.toString(10),
    answeredInRound: decoded.answeredInRound.toString(10),
    answer: decoded.answer.toString(10),
    startedAtUnixSeconds: decoded.startedAt.toString(10),
    updatedAtUnixSeconds: decoded.updatedAt.toString(10),
    value: createExactRational(decoded.answer, 10n ** BigInt(feed.decimals)),
  });
  return fact.success
    ? Object.freeze({ status: "admitted", fact: fact.data })
    : malformedRoundCandidate;
};

const captureObservation = (
  dependencies: Dependencies,
  fact: ReferenceRoundFact,
  block: ChainAnchor,
): ReferenceRoundObservation => {
  try {
    return captureReferenceRoundObservation({
      fact,
      clock: dependencies.clock,
      source: dependencies.observationAuthority,
      block,
    });
  } catch (error) {
    if (getChainOperationFailure(error) !== undefined) throw error;
    throw new ChainOperationError("source_inconsistent");
  }
};

const readLatestFeed = async (
  dependencies: Dependencies,
  feedId: ReferenceFeedId,
  reference: RpcCanonicalBlockReference,
  block: ChainAnchor,
  signal: AbortSignal,
): Promise<ReferenceRoundObservation> => {
  const feed = findReferenceFeed(feedId);
  let results: readonly unknown[];
  try {
    results = await allWithSiblingCancellation([
      (readSignal) => dependencies.rpc.request("eth_getCode", [feed.standardProxy, reference], readSignal),
      (readSignal) => dependencies.rpc.request("eth_call", [{ to: feed.standardProxy, data: dependencies.encoder.description() }, reference], readSignal),
      (readSignal) => dependencies.rpc.request("eth_call", [{ to: feed.standardProxy, data: dependencies.encoder.decimals() }, reference], readSignal),
      (readSignal) => dependencies.rpc.request("eth_call", [{ to: feed.standardProxy, data: dependencies.encoder.latestRoundData() }, reference], readSignal),
    ], signal);
  } catch (error) {
    if (isRpcExecutionRevertedError(error)) throw new ChainOperationError("source_inconsistent");
    throw error;
  }
  try {
    const code = normalizeRpcRuntimeCode(results[0]);
    if (code.status !== "present" || decodeDescription(results[1]) !== feed.expectedDescription ||
      decodeErc20DecimalsResult(normalizeRpcBytes(results[2])) !== String(feed.decimals)) {
      throw new TypeError("Reference feed identity is inconsistent.");
    }
    const candidate = parseRoundCandidate(feedId, results[3], block);
    if (candidate.status === "malformed") throw new TypeError("Reference latest round is malformed.");
    return captureObservation(dependencies, candidate.fact, block);
  } catch (error) {
    if (getChainOperationFailure(error) !== undefined) throw error;
    throw new ChainOperationError("source_inconsistent");
  }
};

const roundCalls = (
  dependencies: Dependencies,
  feedId: ReferenceFeedId,
  roundIds: readonly string[],
  reference: RpcCanonicalBlockReference,
): readonly ChainRpcCall[] => {
  const feed = findReferenceFeed(feedId);
  return Object.freeze(roundIds.map((roundId) => Object.freeze({
    method: "eth_call" as const,
    params: [{ to: feed.standardProxy, data: dependencies.encoder.getRoundData(roundId) }, reference] as const,
  })));
};

const roundParts = (roundId: string): Readonly<{ phase: bigint; aggregator: bigint }> => {
  const parsed = parseReferenceCompositeRoundId(roundId);
  return Object.freeze({
    phase: BigInt(parsed.phaseId),
    aggregator: BigInt(parsed.aggregatorRoundId),
  });
};

const previousRoundId = (roundId: string): string | null => {
  const { phase, aggregator } = roundParts(roundId);
  if (phase <= 0n || aggregator <= 1n) return null;
  return ((phase << 64n) | (aggregator - 1n)).toString(10);
};

const candidateBatch = (
  firstRoundId: string,
  remainingProbes: number,
  stopExclusiveRoundId: string | null,
  cutoffRoundId: string | null,
): readonly string[] => {
  const { phase, aggregator } = roundParts(firstRoundId);
  let available = aggregator;
  if (stopExclusiveRoundId !== null) {
    const stop = roundParts(stopExclusiveRoundId);
    if (stop.phase !== phase || stop.aggregator >= aggregator) {
      throw new TypeError("Reference history boundary is invalid.");
    }
    available = aggregator - stop.aggregator;
  }
  if (cutoffRoundId !== null) {
    const cutoff = roundParts(cutoffRoundId);
    if (phase < cutoff.phase || (phase === cutoff.phase && aggregator <= cutoff.aggregator)) {
      return Object.freeze([]);
    }
    if (phase === cutoff.phase) {
      available = available < aggregator - cutoff.aggregator
        ? available
        : aggregator - cutoff.aggregator;
    }
  }
  const count = Math.min(remainingProbes, Number(available), referenceMarketLimits.providerBatchCalls);
  return Object.freeze(Array.from({ length: count }, (_, index) =>
    ((phase << 64n) | (aggregator - BigInt(index))).toString(10)));
};

const parseHistoryRoundId = (value: unknown): string => {
  if (typeof value !== "string") {
    throw new TypeError("Reference history continuation is invalid.");
  }
  try {
    parseReferenceCompositeRoundId(value);
  } catch {
    throw new TypeError("Reference history continuation is invalid.");
  }
  return value;
};

const parseHistoryPhaseId = (value: unknown): string => {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) {
    throw new TypeError("Reference history phase is invalid.");
  }
  const parsed = BigInt(value);
  if (parsed >= (1n << 16n)) throw new TypeError("Reference history phase is invalid.");
  return value;
};

const parseHistoryStop = (value: unknown): bigint => {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) {
    throw new TypeError("Reference history stop time is invalid.");
  }
  const parsed = BigInt(value);
  if (parsed > maximumUtcUnixSeconds) throw new TypeError("Reference history stop time is invalid.");
  return parsed;
};

const settleRoundCalls = async (
  dependencies: Dependencies,
  calls: readonly ChainRpcCall[],
  signal: AbortSignal,
): Promise<readonly PromiseSettledResult<unknown>[]> => {
  const settleSingly = async (): Promise<readonly PromiseSettledResult<unknown>[]> => {
    const settled: PromiseSettledResult<unknown>[] = [];
    for (let start = 0; start < calls.length; start += rpcConcurrencyLimit) {
      settled.push(...await Promise.allSettled(calls.slice(start, start + rpcConcurrencyLimit).map((call) =>
        dependencies.rpc.request(call.method, call.params as never, signal))));
    }
    return Object.freeze(settled);
  };
  if (dependencies.rpc.requestBatch === undefined) {
    return await settleSingly();
  }
  try {
    return await dependencies.rpc.requestBatch(calls, signal);
  } catch (error) {
    if (!isRpcBatchRejectedError(error)) throw error;
    return await settleSingly();
  }
};

export const createReferenceMarketChainReadPort = (dependencies: Dependencies): ReferenceMarketChainReadPort => {
  if (
    typeof dependencies !== "object" || dependencies === null ||
    typeof dependencies.rpc?.request !== "function" ||
    typeof dependencies.encoder?.getRoundData !== "function" ||
    typeof dependencies.lifecycle?.run !== "function"
  ) throw new TypeError("Reference market chain dependencies are invalid.");
  const port: ReferenceMarketChainReadPort = {
    async resolveCurrentBlock(context: ChainInvocationContext): Promise<CanonicalBlock> {
      dependencies.lifecycle.assertActiveContext(context);
      try {
        return await resolveConfiguredCanonicalBlock({
          rpc: dependencies.rpc,
          chainId: dependencies.chainId,
          selector: { kind: "latest" },
          context,
        });
      } catch (error) {
        return normalizeFailure(error, context.signal);
      }
    },
    async readLatestAtBlock(
      feedIdsInput: readonly ReferenceFeedId[],
      blockInput: CanonicalBlock,
      context: ChainInvocationContext,
    ) {
      dependencies.lifecycle.assertActiveContext(context);
      const block = requireBlock(dependencies.chainId, blockInput, context);
      const feedIds = Object.freeze(feedIdsInput.map((feedId) => referenceFeedIdSchema.parse(feedId)));
      if (
        feedIds.length < 1 || feedIds.length > referenceMarketLimits.feedCount ||
        new Set(feedIds).size !== feedIds.length
      ) throw new TypeError("Reference market latest-read input is invalid.");
      try {
        return Object.freeze(
          await allWithSiblingCancellation(feedIds.map((feedId) => (readSignal) =>
            readLatestFeed(
              dependencies,
              feedId,
              block.reference,
              block.block,
              readSignal,
            )), context.signal),
        );
      } catch (error) {
        return normalizeFailure(error, context.signal);
      }
    },
    async readHistoryAtBlock(
      input: Readonly<{
        feedId: ReferenceFeedId;
        latestRoundId: string;
        knownObservations: readonly ReferenceRoundObservation[];
        backfillPhaseId: string | null;
        backfillNextRoundId: string | null;
        backfillStatus: ReferenceFeedTraversalStatus;
        retentionCutoffRoundId: string | null;
        stopAtOrBeforeUnixSeconds: string;
        block: CanonicalBlock;
      }>,
      context: ChainInvocationContext,
    ) {
      dependencies.lifecycle.assertActiveContext(context);
      const block = requireBlock(dependencies.chainId, input.block, context);
      const feedId = referenceFeedIdSchema.parse(input.feedId);
      const latestRoundId = parseHistoryRoundId(input.latestRoundId);
      const knownObservations = Object.freeze(input.knownObservations.map((observation) =>
        referenceRoundObservationSchema.parse(observation)));
      const knownRoundIds = Object.freeze(knownObservations.map((observation) => observation.fact.roundId));
      const backfillPhaseId = input.backfillPhaseId === null
        ? null
        : parseHistoryPhaseId(input.backfillPhaseId);
      const backfillNextRoundId = input.backfillNextRoundId === null
        ? null
        : parseHistoryRoundId(input.backfillNextRoundId);
      const retentionCutoffRoundId = input.retentionCutoffRoundId === null
        ? null
        : parseHistoryRoundId(input.retentionCutoffRoundId);
      const stopAtOrBeforeUnixSeconds = parseHistoryStop(input.stopAtOrBeforeUnixSeconds);
      const continuationReachedCutoff = (
        backfillPhaseId !== null &&
        backfillNextRoundId !== null &&
        retentionCutoffRoundId !== null &&
        backfillNextRoundId === retentionCutoffRoundId &&
        backfillPhaseId === roundParts(retentionCutoffRoundId).phase.toString(10)
      );
      const admittedBackfillNextRoundId = continuationReachedCutoff
        ? null
        : backfillNextRoundId;
      const admittedBackfillStatus = continuationReachedCutoff
        ? "retention_boundary"
        : input.backfillStatus;
      const traversalState = referenceFeedTraversalStateSchema.safeParse({
        backfillPhaseId,
        backfillNextRoundId: admittedBackfillNextRoundId,
        backfillStatus: admittedBackfillStatus,
        retentionCutoffRoundId,
      });
      if (
        knownRoundIds.length > referenceMarketLimits.historyRoundsPerFeed ||
        new Set(knownRoundIds).size !== knownRoundIds.length ||
        knownObservations.some((observation) => observation.fact.feedId !== feedId) ||
        knownRoundIds.some((roundId) =>
          retentionCutoffRoundId !== null && BigInt(roundId) <= BigInt(retentionCutoffRoundId)) ||
        (knownRoundIds.length > 0 && backfillPhaseId === null) ||
        !traversalState.success
      ) {
        throw new TypeError("Reference market history-read input is invalid.");
      }
      const signal = context.signal;
      const observations: ReferenceRoundObservation[] = [];
      const latest = roundParts(latestRoundId);
      let nextBackfillPhase = backfillPhaseId;
      let nextBackfill = admittedBackfillNextRoundId;
      let backfillStatus = admittedBackfillStatus;
      if (
        knownRoundIds.length === 0 && nextBackfillPhase === null &&
        nextBackfill === null && backfillStatus === null
      ) {
        nextBackfillPhase = latest.phase.toString(10);
        nextBackfill = previousRoundId(latestRoundId);
        if (nextBackfill === null) backfillStatus = "phase_boundary";
      }
      let traversal: ReferenceFeedTraversalState = referenceFeedTraversalStateSchema.parse({
        backfillPhaseId: nextBackfillPhase,
        backfillNextRoundId: nextBackfill,
        backfillStatus,
        retentionCutoffRoundId,
      });
      const work = createReferenceHistoryWorkPlan({
        latestRoundId: referenceCompositeRoundIdSchema.parse(latestRoundId),
        observations: knownObservations,
        traversal,
      });
      let probes = 0;
      let phaseBoundaryObserved = traversal.backfillStatus === "phase_boundary";
      let malformedRoundObserved = traversal.backfillStatus === "malformed";
      let failure: unknown | undefined;

      const readSegment = async (segment: ReferenceHistoryWorkSegment): Promise<Readonly<{
        nextRoundId: string | null;
        status: ReferenceFeedTraversalStatus;
        coverageSatisfied: boolean;
      }>> => {
        let nextRoundId: string | null = segment.firstRoundId;
        let status: ReferenceFeedTraversalStatus = null;
        let coverageSatisfied = false;
        while (
          nextRoundId !== null &&
          !(segment.kind === "continuation" && coverageSatisfied) &&
          probes < referenceMarketLimits.historyProbes
        ) {
          if (nextRoundId === segment.stopExclusiveRoundId) {
            return Object.freeze({ nextRoundId: null, status, coverageSatisfied });
          }
          const batch = candidateBatch(
            nextRoundId,
            referenceMarketLimits.historyProbes - probes,
            segment.stopExclusiveRoundId,
            retentionCutoffRoundId,
          );
          if (batch.length === 0) {
            return Object.freeze({
              nextRoundId: null,
              status: segment.kind === "continuation" ? "retention_boundary" : null,
              coverageSatisfied,
            });
          }
          const calls = roundCalls(dependencies, feedId, batch, block.reference);
          const settled = await settleRoundCalls(dependencies, calls, signal);
          if (settled.length !== batch.length) throw new ChainOperationError("source_inconsistent");
          probes += batch.length;
          let lastAdmittedIndex = -1;
          for (let index = 0; index < settled.length; index += 1) {
            const result = settled[index];
            const requestedRoundId = batch[index];
            if (result === undefined || requestedRoundId === undefined) {
              throw new ChainOperationError("source_inconsistent");
            }
            if (result.status === "rejected") {
              if (isRpcExecutionRevertedError(result.reason)) continue;
              throw result.reason;
            }
            const candidate = parseRoundCandidate(
              feedId,
              result.value,
              block.block,
              requestedRoundId,
            );
            if (candidate.status === "malformed") {
              malformedRoundObserved = true;
              return Object.freeze({
                nextRoundId: requestedRoundId,
                status: "malformed",
                coverageSatisfied,
              });
            }
            if (
              retentionCutoffRoundId !== null &&
              BigInt(candidate.fact.roundId) <= BigInt(retentionCutoffRoundId)
            ) throw new ChainOperationError("source_inconsistent");
            const observation = captureObservation(dependencies, candidate.fact, block.block);
            observations.push(observation);
            lastAdmittedIndex = index;
            if (BigInt(observation.fact.updatedAtUnixSeconds) <= stopAtOrBeforeUnixSeconds) {
              coverageSatisfied = true;
            }
          }
          const lastRequested = batch.at(-1);
          if (lastRequested === undefined) throw new ChainOperationError("source_inconsistent");
          if (roundParts(lastRequested).aggregator === 1n) phaseBoundaryObserved = true;
          if (lastAdmittedIndex < 0) {
            return Object.freeze({
              nextRoundId: batch[0]!,
              status,
              coverageSatisfied,
            });
          }
          const firstTrailingUnresolved = batch[lastAdmittedIndex + 1];
          if (firstTrailingUnresolved !== undefined) {
            return Object.freeze({
              nextRoundId: firstTrailingUnresolved,
              status,
              coverageSatisfied,
            });
          }
          nextRoundId = previousRoundId(batch[lastAdmittedIndex]!);
          if (nextRoundId === null) status = "phase_boundary";
        }
        return Object.freeze({ nextRoundId, status, coverageSatisfied });
      };

      try {
        for (const segment of work.segments) {
          if (probes >= referenceMarketLimits.historyProbes) break;
          const result = await readSegment(segment);
          if (segment.kind !== "continuation") continue;
          nextBackfill = result.nextRoundId;
          backfillStatus = result.status;
          if (backfillStatus === "phase_boundary") phaseBoundaryObserved = true;
          if (backfillStatus === "malformed") malformedRoundObserved = true;
          traversal = referenceFeedTraversalStateSchema.parse({
            backfillPhaseId: nextBackfillPhase,
            backfillNextRoundId: nextBackfill,
            backfillStatus,
            retentionCutoffRoundId,
          });
        }
      } catch (error) {
        failure = normalizedFailure(error, signal);
      }

      return Object.freeze({
        observations: Object.freeze(observations),
        backfillPhaseId: traversal.backfillPhaseId,
        backfillNextRoundId: traversal.backfillNextRoundId,
        backfillStatus: traversal.backfillStatus,
        phaseBoundaryObserved,
        malformedRoundObserved,
        failure,
      });
    },
  };
  return Object.freeze(port);
};
