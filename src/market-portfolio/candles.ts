import {
  compareExactRationals,
  deriveReferencePairValue,
  findReferenceFeed,
  referenceHistoryWindowDefinitions,
  referenceHistorySuccessSchema,
  referenceHistoryWarnings,
  referenceMarketMappingEvidence,
  type ChainAnchor,
  type ExactRational,
  type ReferenceFeedId,
  type ReferenceHistorySuccess,
  type ReferenceHistoryTraversalReport,
  type ReferenceHistoryWindow,
  type ReferencePairManifestEntry,
  type ReferenceRoundObservation,
} from "../core/index.js";
import type { ReferenceFeedCacheSnapshot } from "../runtime/reference-market-storage.js";

interface PricePoint {
  readonly time: number;
  readonly value: ExactRational;
  readonly sources: readonly ReferenceRoundObservation[];
}

const observationTime = (observation: ReferenceRoundObservation): number =>
  Number(observation.fact.updatedAtUnixSeconds) * 1_000;

const chronological = (
  observations: readonly ReferenceRoundObservation[],
): readonly ReferenceRoundObservation[] => Object.freeze([...observations].sort((left, right) => {
  const time = observationTime(left) - observationTime(right);
  if (time !== 0) return time;
  const leftRound = BigInt(left.fact.roundId);
  const rightRound = BigInt(right.fact.roundId);
  return leftRound === rightRound ? 0 : leftRound < rightRound ? -1 : 1;
}));

const pointsFor = (
  pair: ReferencePairManifestEntry,
  snapshots: ReadonlyMap<ReferenceFeedId, ReferenceFeedCacheSnapshot>,
  requestedStart: number,
  requestedEnd: number,
): readonly PricePoint[] => {
  const byFeed = new Map(pair.contract.sourceIds.map((feedId) => {
    const snapshot = snapshots.get(feedId);
    if (snapshot === undefined || snapshot.integrityStatus === "conflict") return [feedId, []] as const;
    return [feedId, chronological(snapshot.observations)] as const;
  }));
  if (pair.contract.sourceIds.length === 1) {
    const feedId = pair.contract.sourceIds[0]!;
    return Object.freeze((byFeed.get(feedId) ?? []).flatMap((observation) => {
      const time = observationTime(observation);
      return time >= requestedStart && time <= requestedEnd
        ? [{ time, value: observation.fact.value, sources: [observation] }]
        : [];
    }));
  }
  const candidateTimes = [...new Set(pair.contract.sourceIds.flatMap((feedId) =>
    (byFeed.get(feedId) ?? []).map(observationTime)
      .filter((time) => time >= requestedStart && time <= requestedEnd)))].sort((a, b) => a - b);
  return Object.freeze(candidateTimes.flatMap((time): PricePoint[] => {
    const sources = pair.contract.sourceIds.map((feedId) =>
      (byFeed.get(feedId) ?? []).findLast((observation) => observationTime(observation) <= time));
    if (sources.some((source) => source === undefined)) return [];
    const exactSources = sources as ReferenceRoundObservation[];
    if (exactSources.some((source) =>
      time - observationTime(source) > findReferenceFeed(source.fact.feedId).heartbeatSeconds * 1_000)) return [];
    return [{ time, value: deriveReferencePairValue(pair, exactSources), sources: exactSources }];
  }));
};

const sourceSkewSeconds = (sources: readonly ReferenceRoundObservation[]): string => {
  const times = sources.map((source) => BigInt(source.fact.updatedAtUnixSeconds));
  return (times.reduce((maximum, value) => value > maximum ? value : maximum) -
    times.reduce((minimum, value) => value < minimum ? value : minimum)).toString(10);
};

const selectExtreme = (
  points: readonly PricePoint[],
  direction: "high" | "low",
): PricePoint => points.reduce((selected, point) => {
  const comparison = compareExactRationals(point.value, selected.value);
  return direction === "high" ? comparison > 0 ? point : selected : comparison < 0 ? point : selected;
});

export const createReferenceHistory = (input: Readonly<{
  pair: ReferencePairManifestEntry;
  window: ReferenceHistoryWindow;
  block: ChainAnchor;
  snapshots: ReadonlyMap<ReferenceFeedId, ReferenceFeedCacheSnapshot>;
  reports: ReadonlyMap<ReferenceFeedId, ReferenceHistoryTraversalReport>;
}>): ReferenceHistorySuccess => {
  const requestedEnd = Date.parse(input.block.blockTimestamp);
  const windowDefinition = referenceHistoryWindowDefinitions[input.window];
  const requestedStart = requestedEnd - windowDefinition.windowMilliseconds;
  const bucketSize = windowDefinition.bucketMilliseconds;
  const firstBucket = Math.ceil(requestedStart / bucketSize) * bucketSize;
  const points = pointsFor(input.pair, input.snapshots, firstBucket, requestedEnd);
  const candles = [];
  const sourceObservations: ReferenceRoundObservation[] = [];
  const admittedSourceKeys = new Set<string>();
  const sourcePointers = (sources: readonly ReferenceRoundObservation[]) => Object.freeze(sources.map((source) => {
    const key = `${source.fact.feedId}:${source.fact.roundId}`;
    if (!admittedSourceKeys.has(key)) {
      admittedSourceKeys.add(key);
      sourceObservations.push(source);
    }
    return Object.freeze({ feedId: source.fact.feedId, roundId: source.fact.roundId });
  }));
  const emptyBucketStarts: string[] = [];
  for (let openedAt = firstBucket; openedAt < requestedEnd; openedAt += bucketSize) {
    const naturalEnd = openedAt + bucketSize;
    const openBucket = requestedEnd < naturalEnd;
    const closedAt = openBucket ? requestedEnd : naturalEnd;
    const bucketPoints = points.filter((point) =>
      point.time >= openedAt &&
      (openBucket ? point.time <= closedAt : point.time < naturalEnd));
    if (bucketPoints.length === 0) {
      emptyBucketStarts.push(new Date(openedAt).toISOString());
      continue;
    }
    const open = bucketPoints[0]!;
    const close = bucketPoints.at(-1)!;
    const high = selectExtreme(bucketPoints, "high");
    const low = selectExtreme(bucketPoints, "low");
    candles.push({
      openedAt: new Date(openedAt).toISOString(),
      closedAt: new Date(closedAt).toISOString(),
      openBucket,
      open: open.value,
      high: high.value,
      low: low.value,
      close: close.value,
      openSourcePointers: sourcePointers(open.sources),
      openSourceSkewSeconds: sourceSkewSeconds(open.sources),
      highSourcePointers: sourcePointers(high.sources),
      highSourceSkewSeconds: sourceSkewSeconds(high.sources),
      lowSourcePointers: sourcePointers(low.sources),
      lowSourceSkewSeconds: sourceSkewSeconds(low.sources),
      closeSourcePointers: sourcePointers(close.sources),
      closeSourceSkewSeconds: sourceSkewSeconds(close.sources),
    });
  }

  const requestedStartUtc = new Date(requestedStart).toISOString();
  const requestedEndUtc = new Date(requestedEnd).toISOString();
  const reports = input.pair.contract.sourceIds.map((feedId) => {
    const report = input.reports.get(feedId);
    if (report === undefined) throw new TypeError("Reference history traversal report is missing.");
    return report;
  });
  const limitations = [
    "source_history_not_exhaustive" as const,
    ...(reports.some((report) => report.remainingContinuation || report.remainingGap)
      ? ["traversal_incomplete" as const] : []),
    ...(reports.some((report) => report.phaseBoundaryObserved)
      ? ["phase_boundary" as const] : []),
    ...(reports.some((report) => report.malformedRoundObserved)
      ? ["malformed_round" as const] : []),
    ...(input.pair.contract.sourceIds.some((feedId) =>
      input.snapshots.get(feedId)?.retentionCutoffRoundId !== null &&
      input.snapshots.get(feedId)?.retentionCutoffRoundId !== undefined)
      ? ["retention_limited" as const] : []),
  ];
  if (candles.length === 0) {
    return referenceHistorySuccessSchema.parse({
      status: "unavailable",
      reason: "no_valid_observation",
      pair: input.pair,
      window: input.window,
      block: input.block,
      mappingEvidence: referenceMarketMappingEvidence,
      coverage: {
        basis: "observed_rounds",
        requestedStart: requestedStartUtc,
        requestedEnd: requestedEndUtc,
        emptyBucketStarts,
        limitations,
      },
      candles: [],
      sourceObservations: [],
      warnings: referenceHistoryWarnings,
    });
  }
  return referenceHistorySuccessSchema.parse({
    status: "partial",
    pair: input.pair,
    window: input.window,
    block: input.block,
    mappingEvidence: referenceMarketMappingEvidence,
    coverage: {
      basis: "observed_rounds",
      requestedStart: requestedStartUtc,
      requestedEnd: requestedEndUtc,
      emptyBucketStarts,
      limitations,
    },
    candles,
    sourceObservations,
    warnings: [...referenceHistoryWarnings, "partial_history"],
  });
};
