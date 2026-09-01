import { performance } from "node:perf_hooks";

import {
  deepFreezeValue,
  type UtcTimestamp,
} from "../core/index.js";
import {
  parseStockTokenTradeHistorySourceInput,
  parseStockTokenTradeHistorySourceObservedAt,
  stockTokenTradeHistoryProducerAdmission,
  stockTokenTradeHistorySourceLimits,
  StockTokenTradeHistoryProviderCleanupError,
  StockTokenTradeHistorySourceClosedError,
  StockTokenTradeHistorySourceRateLimitError,
  isStockTokenTradeHistoryProviderCleanupError,
  type StockTokenTradeHistoryCatalogAssetFact,
  type StockTokenTradeHistoryProviderOutcome,
  type StockTokenTradeHistorySourceDependencies,
  type StockTokenTradeHistorySourceInput,
  type StockTokenTradeHistorySourceLimits,
  type StockTokenTradeHistorySourcePort,
} from "./source-contract.js";
import {
  decodeStockTokenTradeHistorySourceFile,
  parseBaseMonthFile,
  parseBaseResolutionFile,
  parseBaseStateFile,
  parseSelectedRootFile,
  sourceSha256,
  StockTokenTradeHistorySourceCapacityError,
  StockTokenTradeHistorySourceIntegrityError,
  validateCoverageSequence,
  type BaseMonthFile,
  type BaseResolutionFile,
  type BaseStateFile,
  type SelectedAssetEntry,
  type SelectedRootFile,
  type StoredMemberReference,
} from "./source-files.js";
import {
  assertStockTokenTradeHistoryStoredCandleSequence,
  stockTokenTradeHistoryLogicalId,
  stockTokenTradeHistoryAvailableSourceSchema,
  stockTokenTradeHistoryUnavailableSourceSchema,
  type StockTokenTradeHistoryAvailableSource,
  type StockTokenTradeHistoryCoverageSegment,
  type StockTokenTradeHistoryPoolFacts,
  type StockTokenTradeHistorySelectedBase,
  type StockTokenTradeHistorySelectedOwnerMonth,
  type StockTokenTradeHistorySelectedRoot,
  type StockTokenTradeHistorySourceReason,
  type StockTokenTradeHistorySourceResult,
  type StockTokenTradeHistorySourceScope,
  type StockTokenTradeHistoryStoredCandle,
  type StockTokenTradeHistoryStoredMemberIdentity,
  type StockTokenTradeHistoryUnavailableSource,
} from "./source-semantics.js";

const rootNamePattern = /^root-s([1-9][0-9]*)-([0-9a-f]{64})\.json\.gz$/u;

class SourceTerminal extends Error {
  constructor(
    readonly result: StockTokenTradeHistoryUnavailableSource,
    readonly origin: "source" | "deadline" = "source",
  ) {
    super("Stock Token trade-history source reached a terminal result.");
    this.name = "SourceTerminal";
  }
}

class SourceLaterMemberAbort extends Error {
  constructor() {
    super("A later Stock Token trade-history member is no longer needed.");
    this.name = "SourceLaterMemberAbort";
  }
}

interface SourceState {
  root?: StockTokenTradeHistorySelectedRoot;
  base?: StockTokenTradeHistorySelectedBase;
}

interface SourceCounters {
  transport: number;
  decoded: number;
}

interface RootCandidate {
  readonly name: string;
  readonly bytes: number;
  readonly publicationSequence: number;
  readonly gzipSha256: string;
}

interface SelectedRootAdmission {
  readonly root: StockTokenTradeHistorySelectedRoot;
  readonly stateReference?: StoredMemberReference;
  readonly selectedAssetByLogicalId: ReadonlyMap<string, SelectedMemberAsset>;
  readonly decodedBytes: number;
}

type SelectedMemberAsset = Readonly<Pick<
  SelectedAssetEntry,
  "assetName" | "bytes" | "releaseTag" | "sha256"
>>;

interface ReadMemberResult<Value> {
  readonly value: Value;
  readonly identity: StockTokenTradeHistoryStoredMemberIdentity;
}

const mapConcurrently = async <Input, Output>(
  inputs: readonly Input[],
  concurrency: number,
  action: (input: Input, index: number, signal: AbortSignal) => Promise<Output>,
): Promise<readonly Output[]> => {
  const outputs = new Array<Output>(inputs.length);
  const failures = new Array<unknown>(inputs.length);
  const active = new Map<number, AbortController>();
  let cursor = 0;
  let firstFailedIndex = inputs.length;
  const stopLaterWork = (failedIndex: number): void => {
    if (failedIndex >= firstFailedIndex) return;
    firstFailedIndex = failedIndex;
    for (const [index, controller] of active) {
      if (index > failedIndex && !controller.signal.aborted) {
        controller.abort(new SourceLaterMemberAbort());
      }
    }
  };
  const workers = Array.from({ length: Math.min(concurrency, inputs.length) }, async () => {
    while (true) {
      const index = cursor;
      if (index >= inputs.length || index >= firstFailedIndex) return;
      cursor += 1;
      const controller = new AbortController();
      active.set(index, controller);
      try {
        outputs[index] = await action(inputs[index]!, index, controller.signal);
      } catch (error) {
        failures[index] = error;
        if (!(error instanceof SourceLaterMemberAbort)) stopLaterWork(index);
        return;
      } finally {
        active.delete(index);
      }
    }
  });
  await Promise.all(workers);
  const orderedFailures = failures.filter((error) =>
    error !== undefined && !(error instanceof SourceLaterMemberAbort));
  const cleanupErrors = orderedFailures.filter(isStockTokenTradeHistoryProviderCleanupError);
  if (cleanupErrors.length !== 0) {
    const primaryCandidates = orderedFailures.flatMap((error) => {
      const candidate = isStockTokenTradeHistoryProviderCleanupError(error)
        ? error.primaryFailure
        : error;
      return candidate === undefined || candidate instanceof SourceLaterMemberAbort
        ? []
        : [candidate];
    });
    const primary = primaryCandidates.find((error) =>
      !(error instanceof SourceTerminal && error.origin === "deadline")) ?? primaryCandidates[0];
    const cleanupFailures = cleanupErrors.flatMap((error) => error.cleanupFailures);
    throw new StockTokenTradeHistoryProviderCleanupError(cleanupFailures, primary);
  }
  const first = orderedFailures.find((error) =>
    !(error instanceof SourceTerminal && error.origin === "deadline")) ?? orderedFailures[0];
  if (first !== undefined) throw first;
  return Object.freeze(outputs);
};

const observedAt = (now: () => Date): UtcTimestamp => {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("Stock Token trade-history source clock is invalid.");
  }
  return parseStockTokenTradeHistorySourceObservedAt(
    new Date(Math.floor(value.getTime() / 1_000) * 1_000).toISOString(),
  );
};

const terminalResult = (
  reason: StockTokenTradeHistorySourceReason,
  scope: StockTokenTradeHistorySourceScope,
  state: SourceState,
  now: () => Date,
  origin: "source" | "deadline" = "source",
): never => {
  const sourceObservedAt = observedAt(now);
  if (scope === "catalog_root") {
    throw new SourceTerminal(deepFreezeValue(
      stockTokenTradeHistoryUnavailableSourceSchema.parse({
      status: "unavailable",
      reason,
      scope,
      observedAt: sourceObservedAt,
      }),
    ), origin);
  }
  if (state.root === undefined) {
    throw new TypeError("Selected source scope has no admitted root.");
  }
  if (scope === "selected_base") {
    throw new SourceTerminal(deepFreezeValue(
      stockTokenTradeHistoryUnavailableSourceSchema.parse({
      status: "unavailable",
      reason,
      scope,
      observedAt: sourceObservedAt,
      root: state.root,
      }),
    ), origin);
  }
  if (state.base === undefined) {
    throw new TypeError("Selected-period source scope has no admitted base.");
  }
  throw new SourceTerminal(deepFreezeValue(
    stockTokenTradeHistoryUnavailableSourceSchema.parse({
    status: "unavailable",
    reason,
    scope,
    observedAt: sourceObservedAt,
    root: state.root,
    base: state.base,
    }),
  ), origin);
};

const reserveCounter = (
  counters: SourceCounters,
  key: keyof SourceCounters,
  amount: number,
  maximum: number,
  scope: StockTokenTradeHistorySourceScope,
  state: SourceState,
  now: () => Date,
): void => {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    terminalResult("trade_history_inconsistent", scope, state, now);
  }
  if (counters[key] > maximum - amount) {
    terminalResult("trade_history_too_large", scope, state, now);
  }
  counters[key] += amount;
};

const remainingCounter = (
  counters: SourceCounters,
  key: keyof SourceCounters,
  maximum: number,
): number => maximum - counters[key];

const providerValue = <Value>(
  outcome: StockTokenTradeHistoryProviderOutcome<Value>,
  scope: StockTokenTradeHistorySourceScope,
  state: SourceState,
  now: () => Date,
): Value => {
  switch (outcome.status) {
    case "read": return outcome.value;
    case "rate_limited": throw new StockTokenTradeHistorySourceRateLimitError();
    case "capacity_exceeded": return terminalResult("trade_history_too_large", scope, state, now);
    case "absent":
    case "unavailable": return terminalResult("trade_history_unavailable", scope, state, now);
  }
};

const exactProviderValue = <Value>(
  outcome: StockTokenTradeHistoryProviderOutcome<Value>,
  scope: StockTokenTradeHistorySourceScope,
  state: SourceState,
  now: () => Date,
): Value => outcome.status === "capacity_exceeded"
  ? terminalResult("trade_history_inconsistent", scope, state, now)
  : providerValue(outcome, scope, state, now);

const classifyAdmissionError = (
  error: unknown,
  scope: StockTokenTradeHistorySourceScope,
  state: SourceState,
  now: () => Date,
): never => {
  if (error instanceof StockTokenTradeHistorySourceCapacityError) {
    return terminalResult("trade_history_too_large", scope, state, now);
  }
  if (error instanceof StockTokenTradeHistorySourceIntegrityError) {
    return terminalResult("trade_history_inconsistent", scope, state, now);
  }
  throw error;
};

const parseRootCandidate = (
  asset: StockTokenTradeHistoryCatalogAssetFact,
): RootCandidate | undefined => {
  const match = asset.name.match(rootNamePattern);
  if (match === null) return undefined;
  const publicationSequence = Number(match[1]);
  return Number.isSafeInteger(publicationSequence) && publicationSequence > 0
    ? Object.freeze({
        name: asset.name,
        bytes: asset.bytes,
        publicationSequence,
        gzipSha256: match[2]!,
      })
    : undefined;
};

const selectRootCandidate = (
  assets: readonly StockTokenTradeHistoryCatalogAssetFact[],
  state: SourceState,
  now: () => Date,
): RootCandidate => {
  const candidates = assets.flatMap((asset) => {
    const candidate = parseRootCandidate(asset);
    return candidate === undefined ? [] : [candidate];
  }).sort((left, right) => left.publicationSequence - right.publicationSequence);
  if (candidates.length === 0) {
    return terminalResult("trade_history_unavailable", "catalog_root", state, now);
  }
  for (let index = 1; index < candidates.length; index += 1) {
    if (candidates[index - 1]!.publicationSequence === candidates[index]!.publicationSequence) {
      return terminalResult("trade_history_inconsistent", "catalog_root", state, now);
    }
  }
  const selected = candidates.at(-1);
  if (selected === undefined || selected.bytes <= 0) {
    return terminalResult("trade_history_inconsistent", "catalog_root", state, now);
  }
  return selected;
};

const memberAsset = (
  selectedAssetByLogicalId: ReadonlyMap<string, SelectedMemberAsset>,
  reference: StoredMemberReference,
): SelectedMemberAsset => {
  const asset = selectedAssetByLogicalId.get(reference.logicalId);
  if (asset === undefined || asset.sha256 !== reference.assetSha256) {
    throw new StockTokenTradeHistorySourceIntegrityError();
  }
  if (reference.until > asset.bytes || reference.from >= reference.until) {
    throw new StockTokenTradeHistorySourceIntegrityError();
  }
  return asset;
};

const memberIdentity = (
  reference: StoredMemberReference,
): StockTokenTradeHistoryStoredMemberIdentity => Object.freeze({
  logicalId: reference.logicalId,
  assetSha256: reference.assetSha256,
  gzipSha256: reference.gzipSha256,
  jsonSha256: reference.jsonSha256,
});

const subtractCalendarMonths = (timestamp: string, months: number): string => {
  const source = new Date(timestamp);
  const absoluteMonth = source.getUTCFullYear() * 12 + source.getUTCMonth() - months;
  const year = Math.floor(absoluteMonth / 12);
  const month = absoluteMonth - year * 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(
    year,
    month,
    Math.min(source.getUTCDate(), lastDay),
    source.getUTCHours(),
    source.getUTCMinutes(),
    source.getUTCSeconds(),
  )).toISOString();
};

const validateStateAgainstRoot = (
  state: BaseStateFile,
  currentUntil: StockTokenTradeHistorySelectedRoot["currentUntil"],
): void => {
  const last = state.poolPeriods.at(-1);
  if (last === undefined ||
      last.untilBlock !== currentUntil.blockNumber ||
      last.untilTimestamp !== currentUntil.timestamp) {
    throw new StockTokenTradeHistorySourceIntegrityError();
  }
  const lowerBound = subtractCalendarMonths(currentUntil.timestamp, 12);
  const earliestDay = `${lowerBound.slice(0, 10)}T00:00:00.000Z`;
  const first = state.poolPeriods[0]!;
  if (first.fromTimestamp < earliestDay) throw new StockTokenTradeHistorySourceIntegrityError();
  if (first.fromTimestamp < lowerBound) {
    const prefix = Date.parse(lowerBound) - Date.parse(first.fromTimestamp);
    if (prefix <= 0 || prefix >= 15 * 60_000) {
      throw new StockTokenTradeHistorySourceIntegrityError();
    }
  }
  const expectedMonths = ownerMonths(first.fromTimestamp, currentUntil.timestamp);
  const recordedMonths = state.months.map((reference) => reference.logicalId.slice(-7));
  if (expectedMonths.length !== recordedMonths.length ||
      expectedMonths.some((month, index) => month !== recordedMonths[index])) {
    throw new StockTokenTradeHistorySourceIntegrityError();
  }
  for (const facts of Object.values(state.pools)) {
    if (
      Date.parse(facts.sourceFrom.timestamp) <
        Math.floor(Date.parse(facts.initialize.timestamp) / 60_000) * 60_000 ||
      (facts.sourceFrom.timestamp > facts.initialize.timestamp &&
        BigInt(facts.sourceFrom.blockNumber) <= BigInt(facts.initialize.blockNumber)) ||
      facts.historyFrom.timestamp < facts.sourceFrom.timestamp ||
      BigInt(facts.historyFrom.blockNumber) < BigInt(facts.sourceFrom.blockNumber)
    ) throw new StockTokenTradeHistorySourceIntegrityError();
  }
};

const coverageSubset = (
  recorded: readonly BaseMonthFile["coverage"][number][],
  state: readonly BaseStateFile["poolPeriods"][number][],
): void => {
  validateCoverageSequence(recorded);
  validateCoverageSequence(state);
  const selectedFrom = state[0]!;
  for (const segment of recorded) {
    const beforeTime = segment.untilTimestamp <= selectedFrom.fromTimestamp;
    const beforeBlock = BigInt(segment.untilBlock) <= BigInt(selectedFrom.fromBlock);
    if (beforeTime || beforeBlock) {
      if (beforeTime !== beforeBlock) throw new StockTokenTradeHistorySourceIntegrityError();
      continue;
    }
    const matches = state.filter((period) =>
      period.poolId === segment.poolId &&
      period.fromTimestamp <= segment.fromTimestamp &&
      period.untilTimestamp >= segment.untilTimestamp &&
      BigInt(period.fromBlock) <= BigInt(segment.fromBlock) &&
      BigInt(period.untilBlock) >= BigInt(segment.untilBlock));
    if (matches.length !== 1) throw new StockTokenTradeHistorySourceIntegrityError();
  }
};

const nextOwnerMonth = (ownerMonth: string): string => {
  const next = new Date(`${ownerMonth}-01T00:00:00.000Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return next.toISOString().slice(0, 7);
};

const sameCoverageBoundary = (
  leftTimestamp: string,
  leftBlock: string,
  rightTimestamp: string,
  rightBlock: string,
): boolean => leftTimestamp === rightTimestamp && leftBlock === rightBlock;

const mergeAdjacentCoverage = (
  coverage: readonly StockTokenTradeHistoryCoverageSegment[],
): readonly StockTokenTradeHistoryCoverageSegment[] => {
  validateCoverageSequence(coverage);
  const merged: StockTokenTradeHistoryCoverageSegment[] = [];
  for (const segment of coverage) {
    const previous = merged.at(-1);
    if (
      previous !== undefined &&
      previous.poolId === segment.poolId &&
      sameCoverageBoundary(
        previous.untilTimestamp,
        previous.untilBlock,
        segment.fromTimestamp,
        segment.fromBlock,
      )
    ) {
      merged[merged.length - 1] = Object.freeze({
        ...previous,
        untilTimestamp: segment.untilTimestamp,
        untilBlock: segment.untilBlock,
      });
    } else {
      merged.push(Object.freeze({ ...segment }));
    }
  }
  return Object.freeze(merged);
};

const selectedMonthCoverage = (
  stateCoverage: readonly StockTokenTradeHistoryCoverageSegment[],
  selectedMonths: readonly string[],
  months: readonly BaseMonthFile[],
): readonly StockTokenTradeHistoryCoverageSegment[] => {
  if (selectedMonths.length === 0 || selectedMonths.length !== months.length) {
    throw new StockTokenTradeHistorySourceIntegrityError();
  }
  const stateStart = stateCoverage[0];
  const stateEnd = stateCoverage.at(-1);
  if (stateStart === undefined || stateEnd === undefined) {
    throw new StockTokenTradeHistorySourceIntegrityError();
  }
  const flattened = months.flatMap((month, index) => {
    if (month.month !== selectedMonths[index]) {
      throw new StockTokenTradeHistorySourceIntegrityError();
    }
    coverageSubset(month.coverage, stateCoverage);
    return month.coverage;
  });
  const retained = flattened.filter((segment) => {
    const beforeTime = segment.untilTimestamp <= stateStart.fromTimestamp;
    const beforeBlock = BigInt(segment.untilBlock) <= BigInt(stateStart.fromBlock);
    if (beforeTime || beforeBlock) {
      if (beforeTime !== beforeBlock) throw new StockTokenTradeHistorySourceIntegrityError();
      return false;
    }
    return true;
  });
  if (retained.length === 0) throw new StockTokenTradeHistorySourceIntegrityError();
  validateCoverageSequence(retained);
  const first = retained[0]!;
  const last = retained.at(-1)!;
  const firstMonth = selectedMonths[0]!;
  const lastMonth = selectedMonths.at(-1)!;
  const expectedStart = firstMonth === stateStart.fromTimestamp.slice(0, 7)
    ? stateStart.fromTimestamp
    : `${firstMonth}-01T00:00:00.000Z`;
  const expectedEnd = lastMonth === new Date(Date.parse(stateEnd.untilTimestamp) - 1)
    .toISOString().slice(0, 7)
    ? stateEnd.untilTimestamp
    : `${nextOwnerMonth(lastMonth)}-01T00:00:00.000Z`;
  if (
    first.fromTimestamp !== expectedStart || last.untilTimestamp !== expectedEnd ||
    expectedStart === stateStart.fromTimestamp && first.fromBlock !== stateStart.fromBlock ||
    expectedEnd === stateEnd.untilTimestamp && last.untilBlock !== stateEnd.untilBlock
  ) throw new StockTokenTradeHistorySourceIntegrityError();
  return Object.freeze(retained.map((segment) => Object.freeze({ ...segment })));
};

const selectedResolutionCoverage = (
  stateCoverage: readonly StockTokenTradeHistoryCoverageSegment[],
  monthCoverage: readonly StockTokenTradeHistoryCoverageSegment[],
  resolutions: readonly BaseResolutionFile[],
): readonly StockTokenTradeHistoryCoverageSegment[] => {
  const firstMonth = monthCoverage[0];
  const lastMonth = monthCoverage.at(-1);
  if (firstMonth === undefined || lastMonth === undefined) {
    throw new StockTokenTradeHistorySourceIntegrityError();
  }
  const coveredMonths = new Set<number>();
  for (const resolution of resolutions) {
    coverageSubset(resolution.coverage, stateCoverage);
    for (const sourceSegment of resolution.coverage) {
      const beforeByTime = sourceSegment.untilTimestamp <= firstMonth.fromTimestamp;
      const beforeByBlock = BigInt(sourceSegment.untilBlock) <= BigInt(firstMonth.fromBlock);
      if (beforeByTime || beforeByBlock) {
        if (beforeByTime !== beforeByBlock) {
          throw new StockTokenTradeHistorySourceIntegrityError();
        }
        continue;
      }
      const afterByTime = sourceSegment.fromTimestamp >= lastMonth.untilTimestamp;
      const afterByBlock = BigInt(sourceSegment.fromBlock) >= BigInt(lastMonth.untilBlock);
      if (afterByTime || afterByBlock) {
        if (afterByTime !== afterByBlock) {
          throw new StockTokenTradeHistorySourceIntegrityError();
        }
        continue;
      }
      if (
        sourceSegment.fromTimestamp < firstMonth.fromTimestamp &&
          BigInt(sourceSegment.fromBlock) > BigInt(firstMonth.fromBlock) ||
        sourceSegment.untilTimestamp > lastMonth.untilTimestamp &&
          BigInt(sourceSegment.untilBlock) < BigInt(lastMonth.untilBlock)
      ) throw new StockTokenTradeHistorySourceIntegrityError();
      const fromMonth = sourceSegment.fromTimestamp <= firstMonth.fromTimestamp
        ? firstMonth
        : monthCoverage.find((segment) => sameCoverageBoundary(
            segment.fromTimestamp,
            segment.fromBlock,
            sourceSegment.fromTimestamp,
            sourceSegment.fromBlock,
          ));
      const untilMonth = sourceSegment.untilTimestamp >= lastMonth.untilTimestamp
        ? lastMonth
        : monthCoverage.find((segment) => sameCoverageBoundary(
            segment.untilTimestamp,
            segment.untilBlock,
            sourceSegment.untilTimestamp,
            sourceSegment.untilBlock,
          ));
      if (fromMonth === undefined || untilMonth === undefined) {
        throw new StockTokenTradeHistorySourceIntegrityError();
      }
      const fromIndex = monthCoverage.indexOf(fromMonth);
      const untilIndex = monthCoverage.indexOf(untilMonth);
      if (fromIndex < 0 || untilIndex < fromIndex) {
        throw new StockTokenTradeHistorySourceIntegrityError();
      }
      const explanation = monthCoverage.slice(fromIndex, untilIndex + 1);
      if (
        explanation.some((segment) => segment.poolId !== sourceSegment.poolId) ||
        !sameCoverageBoundary(
          explanation[0]!.fromTimestamp,
          explanation[0]!.fromBlock,
          sourceSegment.fromTimestamp < firstMonth.fromTimestamp
            ? firstMonth.fromTimestamp : sourceSegment.fromTimestamp,
          sourceSegment.fromTimestamp < firstMonth.fromTimestamp
            ? firstMonth.fromBlock : sourceSegment.fromBlock,
        ) ||
        !sameCoverageBoundary(
          explanation.at(-1)!.untilTimestamp,
          explanation.at(-1)!.untilBlock,
          sourceSegment.untilTimestamp > lastMonth.untilTimestamp
            ? lastMonth.untilTimestamp : sourceSegment.untilTimestamp,
          sourceSegment.untilTimestamp > lastMonth.untilTimestamp
            ? lastMonth.untilBlock : sourceSegment.untilBlock,
        )
      ) throw new StockTokenTradeHistorySourceIntegrityError();
      for (let index = fromIndex; index <= untilIndex; index += 1) coveredMonths.add(index);
    }
  }
  if (coveredMonths.size !== monthCoverage.length) {
    throw new StockTokenTradeHistorySourceIntegrityError();
  }
  return mergeAdjacentCoverage(monthCoverage);
};

const ownerMonths = (from: string, until: string): readonly string[] => {
  const months: string[] = [];
  const cursor = new Date(`${from.slice(0, 7)}-01T00:00:00.000Z`);
  const last = new Date(Date.parse(until) - 1).toISOString().slice(0, 7);
  while (true) {
    const month = cursor.toISOString().slice(0, 7);
    months.push(month);
    if (month === last) return Object.freeze(months);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
};

const selectedCoverage = (
  state: BaseStateFile,
  input: StockTokenTradeHistorySourceInput,
): readonly BaseStateFile["poolPeriods"][number][] => {
  const anchorBlock = BigInt(input.canonicalBlock.blockNumber);
  return Object.freeze(state.poolPeriods.flatMap((segment) => {
    if (
      segment.untilTimestamp <= input.requestedStart ||
      segment.fromTimestamp >= input.requestedEnd ||
      BigInt(segment.fromBlock) >= anchorBlock
    ) return [];
    return [segment];
  }));
};

const createSelectedRoot = (
  root: SelectedRootFile,
  candidate: RootCandidate,
  jsonSha256: string,
): StockTokenTradeHistorySelectedRoot => deepFreezeValue({
  publicationSequence: root.publicationSequence,
  gzipSha256: candidate.gzipSha256,
  jsonSha256,
  currentUntil: root.currentUntil,
  poolManager: root.poolManager,
  usdgAddress: root.usdgAddress,
  usdgDecimals: root.usdgDecimals,
});

const admitSelectedRoot = (
  value: unknown,
  decodedBytes: number,
  jsonSha256: string,
  candidate: RootCandidate,
  input: StockTokenTradeHistorySourceInput,
  limits: StockTokenTradeHistorySourceLimits,
): SelectedRootAdmission => {
  const root = parseSelectedRootFile(value, limits);
  if (root.publicationSequence !== candidate.publicationSequence) {
    throw new StockTokenTradeHistorySourceIntegrityError();
  }
  const prefix = `base/${input.baseCurrencyAddress}/`;
  const selectedAssetByLogicalId = new Map<string, SelectedMemberAsset>();
  for (const asset of root.assets) {
    const selectedAsset = Object.freeze({
      assetName: asset.assetName,
      bytes: asset.bytes,
      releaseTag: asset.releaseTag,
      sha256: asset.sha256,
    });
    for (const id of asset.logicalIds) {
      if (id.startsWith(prefix)) selectedAssetByLogicalId.set(id, selectedAsset);
    }
  }
  return Object.freeze({
    root: createSelectedRoot(root, candidate, jsonSha256),
    ...(root.baseCurrencies[input.baseCurrencyAddress] === undefined
      ? {}
      : { stateReference: root.baseCurrencies[input.baseCurrencyAddress] }),
    selectedAssetByLogicalId,
    decodedBytes,
  });
};

const validateMemberReference = (
  selectedAssetByLogicalId: ReadonlyMap<string, SelectedMemberAsset>,
  reference: StoredMemberReference,
  expectedLogicalId: string,
): SelectedMemberAsset => {
  if (reference.logicalId !== expectedLogicalId) {
    throw new StockTokenTradeHistorySourceIntegrityError();
  }
  return memberAsset(selectedAssetByLogicalId, reference);
};

const candleInsideSelectedCoverage = (
  candle: StockTokenTradeHistoryStoredCandle,
  coverage: readonly BaseStateFile["poolPeriods"][number][],
  input: StockTokenTradeHistorySourceInput,
): boolean => candle.intervalStart >= input.requestedStart &&
  candle.intervalEnd <= input.requestedEnd &&
  BigInt(candle.lastSource.blockNumber) < BigInt(input.canonicalBlock.blockNumber) &&
  coverage.some((segment) =>
    segment.fromTimestamp <= candle.intervalStart &&
    segment.untilTimestamp >= candle.intervalEnd &&
    BigInt(segment.fromBlock) <= BigInt(candle.firstSource.blockNumber) &&
    BigInt(segment.untilBlock) > BigInt(candle.lastSource.blockNumber));

const deadlineOrSignal = (
  caller: AbortSignal | undefined,
  owner: AbortSignal,
  deadline: AbortSignal,
): AbortSignal => caller === undefined
  ? AbortSignal.any([owner, deadline])
  : AbortSignal.any([caller, owner, deadline]);

export class StockTokenTradeHistorySource implements StockTokenTradeHistorySourcePort {
  readonly #dependencies: Readonly<{
    transport: StockTokenTradeHistorySourceDependencies["transport"];
    limits: StockTokenTradeHistorySourceLimits;
    now: () => Date;
  }>;
  readonly #owner = new AbortController();
  readonly #active = new Set<Promise<StockTokenTradeHistoryProviderCleanupError | undefined>>();
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(dependencies: StockTokenTradeHistorySourceDependencies) {
    this.#dependencies = Object.freeze({
      transport: dependencies.transport,
      limits: stockTokenTradeHistorySourceLimits,
      now: dependencies.now ?? (() => new Date()),
    });
  }

  read(
    input: StockTokenTradeHistorySourceInput,
    signal?: AbortSignal,
  ): Promise<StockTokenTradeHistorySourceResult> {
    if (this.#closed) return Promise.reject(new StockTokenTradeHistorySourceClosedError());
    let resolveResult!: (result: StockTokenTradeHistorySourceResult) => void;
    let rejectResult!: (reason: unknown) => void;
    const result = new Promise<StockTokenTradeHistorySourceResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    let settlement!: Promise<StockTokenTradeHistoryProviderCleanupError | undefined>;
    settlement = result.then(
      () => undefined,
      (error: unknown) => isStockTokenTradeHistoryProviderCleanupError(error)
        ? error
        : undefined,
    ).then((cleanupFailure) => {
      if (cleanupFailure === undefined) this.#active.delete(settlement);
      return cleanupFailure;
    });
    this.#active.add(settlement);
    void this.#read(input, signal).then(resolveResult, rejectResult);
    return result;
  }

  async #read(
    inputValue: StockTokenTradeHistorySourceInput,
    callerSignal: AbortSignal | undefined,
  ): Promise<StockTokenTradeHistorySourceResult> {
    const input = parseStockTokenTradeHistorySourceInput(inputValue);
    const limits = this.#dependencies.limits;
    const state: SourceState = {};
    const counters: SourceCounters = { transport: 0, decoded: 0 };
    const deadline = new AbortController();
    const deadlineAt = performance.now() + limits.deadlineMilliseconds;
    const timer = setTimeout(() => deadline.abort(), limits.deadlineMilliseconds);
    const signal = deadlineOrSignal(
      callerSignal,
      this.#owner.signal,
      deadline.signal,
    );
    const interrupt = (scope: StockTokenTradeHistorySourceScope): void => {
      if (callerSignal?.aborted === true) throw callerSignal.reason;
      if (this.#owner.signal.aborted) throw new StockTokenTradeHistorySourceClosedError();
      if (deadline.signal.aborted || performance.now() >= deadlineAt) {
        terminalResult(
          "trade_history_unavailable",
          scope,
          state,
          this.#dependencies.now,
          "deadline",
        );
      }
    };
    const admit = <Value>(
      scope: StockTokenTradeHistorySourceScope,
      action: () => Value,
    ): Value => {
      try {
        const value = action();
        interrupt(scope);
        return value;
      } catch (error) {
        if (error instanceof SourceTerminal) throw error;
        interrupt(scope);
        return classifyAdmissionError(error, scope, state, this.#dependencies.now);
      }
    };
    const readMember = async <Value>(
      selectedAssetByLogicalId: ReadonlyMap<string, SelectedMemberAsset>,
      reference: StoredMemberReference,
      expectedLogicalId: string,
      scope: "selected_base" | "selected_period",
      parse: (value: unknown) => Value,
      readSignal: AbortSignal = signal,
    ): Promise<ReadMemberResult<Value>> => {
      const asset = admit(scope, () => validateMemberReference(
        selectedAssetByLogicalId,
        reference,
        expectedLogicalId,
      ));
      const compressedBytes = reference.until - reference.from;
      if (compressedBytes > limits.memberCompressedBytes ||
          reference.jsonBytes > limits.memberDecodedBytes) {
        return terminalResult("trade_history_too_large", scope, state, this.#dependencies.now);
      }
      reserveCounter(
        counters,
        "transport",
        compressedBytes,
        limits.cumulativeTransportBytes,
        scope,
        state,
        this.#dependencies.now,
      );
      reserveCounter(
        counters,
        "decoded",
        reference.jsonBytes,
        limits.cumulativeDecodedBytes,
        scope,
        state,
        this.#dependencies.now,
      );
      interrupt(scope);
      let outcome: Awaited<ReturnType<StockTokenTradeHistorySourceDependencies["transport"]["readMember"]>>;
      try {
        outcome = await this.#dependencies.transport.readMember({
          releaseTag: asset.releaseTag,
          assetName: asset.assetName,
          from: reference.from,
          until: reference.until,
          maximumBytes: compressedBytes,
        }, readSignal);
      } catch (error) {
        if (isStockTokenTradeHistoryProviderCleanupError(error)) throw error;
        if (readSignal.aborted && readSignal.reason instanceof SourceLaterMemberAbort) {
          throw readSignal.reason;
        }
        interrupt(scope);
        throw error;
      }
      if (readSignal.aborted && readSignal.reason instanceof SourceLaterMemberAbort) {
        throw readSignal.reason;
      }
      interrupt(scope);
      const facts = exactProviderValue(outcome, scope, state, this.#dependencies.now);
      if (!facts.identityEncoding || facts.range === null ||
          facts.range.from !== reference.from || facts.range.until !== reference.until ||
          facts.range.assetBytes !== asset.bytes ||
          facts.bytes.byteLength !== compressedBytes ||
          sourceSha256(facts.bytes) !== reference.gzipSha256) {
        return terminalResult("trade_history_inconsistent", scope, state, this.#dependencies.now);
      }
      const decoded = admit(scope, () => {
        try {
          return decodeStockTokenTradeHistorySourceFile(
            facts.bytes,
            Math.min(limits.memberDecodedBytes, reference.jsonBytes),
          );
        } catch (error) {
          if (error instanceof StockTokenTradeHistorySourceCapacityError &&
              reference.jsonBytes <= limits.memberDecodedBytes) {
            throw new StockTokenTradeHistorySourceIntegrityError();
          }
          throw error;
        }
      });
      if (decoded.jsonBytes.byteLength !== reference.jsonBytes ||
          decoded.jsonSha256 !== reference.jsonSha256) {
        return terminalResult("trade_history_inconsistent", scope, state, this.#dependencies.now);
      }
      return Object.freeze({
        value: admit(scope, () => parse(decoded.value)),
        identity: memberIdentity(reference),
      });
    };

    try {
      interrupt("catalog_root");
      const catalogOutcome = await this.#dependencies.transport.readCatalog(
        limits.catalogResponseBytes,
        limits.cumulativeTransportBytes,
        stockTokenTradeHistoryProducerAdmission.maximumReleaseAssets,
        signal,
      );
      interrupt("catalog_root");
      const catalog = providerValue(
        catalogOutcome,
        "catalog_root",
        state,
        this.#dependencies.now,
      );
      reserveCounter(
        counters,
        "transport",
        catalog.transferredBytes,
        limits.cumulativeTransportBytes,
        "catalog_root",
        state,
        this.#dependencies.now,
      );
      if (catalog.overflow) {
        return terminalResult(
          "trade_history_inconsistent",
          "catalog_root",
          state,
          this.#dependencies.now,
        );
      }
      const candidate = selectRootCandidate(catalog.assets, state, this.#dependencies.now);
      if (candidate.bytes > stockTokenTradeHistoryProducerAdmission.maximumPhysicalAssetBytes) {
        return terminalResult(
          "trade_history_inconsistent",
          "catalog_root",
          state,
          this.#dependencies.now,
        );
      }
      if (candidate.bytes > limits.rootCompressedBytes) {
        return terminalResult(
          "trade_history_too_large",
          "catalog_root",
          state,
          this.#dependencies.now,
        );
      }
      reserveCounter(
        counters,
        "transport",
        candidate.bytes,
        limits.cumulativeTransportBytes,
        "catalog_root",
        state,
        this.#dependencies.now,
      );
      const rootOutcome = await this.#dependencies.transport.readRoot(
        candidate.name,
        candidate.bytes,
        signal,
      );
      interrupt("catalog_root");
      const rootFacts = exactProviderValue(
        rootOutcome,
        "catalog_root",
        state,
        this.#dependencies.now,
      );
      if (!rootFacts.identityEncoding || rootFacts.bytes.byteLength !== candidate.bytes ||
          sourceSha256(rootFacts.bytes) !== candidate.gzipSha256) {
        return terminalResult(
          "trade_history_inconsistent",
          "catalog_root",
          state,
          this.#dependencies.now,
        );
      }
      const rootAdmission = admit("catalog_root", () => {
        const decoded = decodeStockTokenTradeHistorySourceFile(
          rootFacts.bytes,
          Math.min(
            limits.rootDecodedBytes,
            remainingCounter(counters, "decoded", limits.cumulativeDecodedBytes),
          ),
        );
        return admitSelectedRoot(
          decoded.value,
          decoded.jsonBytes.byteLength,
          decoded.jsonSha256,
          candidate,
          input,
          limits,
        );
      });
      reserveCounter(
        counters,
        "decoded",
        rootAdmission.decodedBytes,
        limits.cumulativeDecodedBytes,
        "catalog_root",
        state,
        this.#dependencies.now,
      );
      state.root = rootAdmission.root;

      const stateReference = rootAdmission.stateReference;
      if (stateReference === undefined) {
        return terminalResult(
          "asset_not_supported",
          "selected_base",
          state,
          this.#dependencies.now,
        );
      }
      const stateRead = await readMember(
        rootAdmission.selectedAssetByLogicalId,
        stateReference,
        stockTokenTradeHistoryLogicalId.state(input.baseCurrencyAddress),
        "selected_base",
        (value) => parseBaseStateFile(
          value,
          input.baseCurrencyAddress,
          input.baseCurrencyDecimals,
          limits,
        ),
      );
      admit("selected_base", () => validateStateAgainstRoot(
        stateRead.value,
        rootAdmission.root.currentUntil,
      ));
      for (const reference of stateRead.value.months) {
        admit("selected_base", () => {
          memberAsset(rootAdmission.selectedAssetByLogicalId, reference);
          return undefined;
        });
      }
      const coverage = selectedCoverage(stateRead.value, input);
      state.base = deepFreezeValue({
        baseCurrencyAddress: input.baseCurrencyAddress,
        decimals: stateRead.value.decimals,
        state: stateRead.identity,
      });
      if (coverage.length === 0) {
        return terminalResult(
          "outside_published_coverage",
          "selected_period",
          state,
          this.#dependencies.now,
        );
      }

      const firstCoverage = coverage[0]!;
      const lastCoverage = coverage.at(-1)!;
      const selectedMonths = ownerMonths(
        firstCoverage.fromTimestamp > input.requestedStart
          ? firstCoverage.fromTimestamp
          : input.requestedStart,
        lastCoverage.untilTimestamp < input.requestedEnd
          ? lastCoverage.untilTimestamp
          : input.requestedEnd,
      );
      if (selectedMonths.length > limits.stateMonths) {
        return terminalResult(
          "trade_history_too_large",
          "selected_period",
          state,
          this.#dependencies.now,
        );
      }
      const selectedCandles: StockTokenTradeHistoryStoredCandle[] = [];
      const ownerMonthSelections: StockTokenTradeHistorySelectedOwnerMonth[] = [];
      const monthReferences = selectedMonths.map((ownerMonth) => {
        const monthLogicalId = stockTokenTradeHistoryLogicalId.month(
          input.baseCurrencyAddress,
          ownerMonth,
        );
        const monthReference = stateRead.value.months.find((reference) =>
          reference.logicalId === monthLogicalId);
        if (monthReference === undefined) {
          return terminalResult(
            "trade_history_inconsistent",
            "selected_period",
            state,
            this.#dependencies.now,
          );
        }
        return Object.freeze({ ownerMonth, monthLogicalId, monthReference });
      });
      const monthReads = await mapConcurrently(
        monthReferences,
        limits.concurrentMemberReads,
        async ({ ownerMonth, monthLogicalId, monthReference }, _index, memberSignal) => readMember(
          rootAdmission.selectedAssetByLogicalId,
          monthReference,
          monthLogicalId,
          "selected_period",
          (value) => parseBaseMonthFile(
            value,
            input.baseCurrencyAddress,
            ownerMonth,
            limits,
          ),
          AbortSignal.any([signal, memberSignal]),
        ),
      );
      const admittedMonthCoverage = admit("selected_period", () => selectedMonthCoverage(
        stateRead.value.poolPeriods,
        selectedMonths,
        monthReads.map((read) => read.value),
      ));
      const resolutionReferences = monthReads.map((monthRead, index) => {
        const ownerMonth = selectedMonths[index]!;
        for (const child of [
          ...monthRead.value.days,
          ...Object.values(monthRead.value.resolutions),
        ]) {
          admit("selected_period", () => {
            memberAsset(rootAdmission.selectedAssetByLogicalId, child);
            return undefined;
          });
        }
        const resolutionReference = monthRead.value.resolutions[input.resolution];
        const expectedResolutionId = stockTokenTradeHistoryLogicalId.resolution(
          input.baseCurrencyAddress,
          input.resolution,
          ownerMonth,
        );
        return Object.freeze({
          ownerMonth,
          reference: resolutionReference,
          expectedResolutionId,
        });
      });
      const resolutionReads = await mapConcurrently(
        resolutionReferences,
        limits.concurrentMemberReads,
        async ({ ownerMonth, reference, expectedResolutionId }, _index, memberSignal) => readMember(
          rootAdmission.selectedAssetByLogicalId,
          reference,
          expectedResolutionId,
          "selected_period",
          (value) => parseBaseResolutionFile(
            value,
            input.baseCurrencyAddress,
            input.baseCurrencyDecimals,
            ownerMonth,
            input.resolution,
            limits,
          ),
          AbortSignal.any([signal, memberSignal]),
        ),
      );
      const admittedResolutionCoverage = admit(
        "selected_period",
        () => selectedResolutionCoverage(
          stateRead.value.poolPeriods,
          admittedMonthCoverage,
          resolutionReads.map((read) => read.value),
        ),
      );
      for (const [index, resolutionRead] of resolutionReads.entries()) {
        const monthRead = monthReads[index];
        const ownerMonth = selectedMonths[index];
        if (monthRead === undefined || ownerMonth === undefined) {
          return terminalResult(
            "trade_history_inconsistent",
            "selected_period",
            state,
            this.#dependencies.now,
          );
        }
        for (const candle of resolutionRead.value.candles) {
          if (candleInsideSelectedCoverage(candle, admittedResolutionCoverage, input)) {
            const selected = candle as StockTokenTradeHistoryStoredCandle;
            selectedCandles.push(selected);
          }
        }
        ownerMonthSelections.push(deepFreezeValue({
          ownerMonth,
          monthMember: monthRead.identity,
          resolutionMember: resolutionRead.identity,
        }));
      }
      admit("selected_period", () => assertStockTokenTradeHistoryStoredCandleSequence({
        candles: selectedCandles,
        baseDecimals: input.baseCurrencyDecimals,
        resolution: input.resolution,
      }));
      const selectedBase = state.base;
      if (selectedBase === undefined) {
        throw new TypeError("Available trade-history source has no selected base.");
      }
      const publishedCoverage = mergeAdjacentCoverage(admittedMonthCoverage);
      const requiredPoolIds = new Set([
        ...publishedCoverage.map((segment) => segment.poolId),
        ...admittedResolutionCoverage.map((segment) => segment.poolId),
      ]);
      const pools: Record<string, StockTokenTradeHistoryPoolFacts> = {};
      for (const poolId of [...requiredPoolIds].sort()) {
        const facts = stateRead.value.pools[poolId];
        if (facts === undefined) {
          return terminalResult(
            "trade_history_inconsistent",
            "selected_period",
            state,
            this.#dependencies.now,
          );
        }
        pools[poolId] = facts;
      }
      const result = deepFreezeValue(stockTokenTradeHistoryAvailableSourceSchema.parse({
        status: "available",
        observedAt: observedAt(this.#dependencies.now),
        root: rootAdmission.root,
        base: selectedBase,
        publishedCoverage,
        selectedResolutionCoverage: admittedResolutionCoverage,
        pools,
        ownerMonths: ownerMonthSelections,
        candles: selectedCandles,
      })) as StockTokenTradeHistoryAvailableSource;
      interrupt("selected_period");
      return result;
    } catch (error) {
      if (isStockTokenTradeHistoryProviderCleanupError(error)) {
        if (callerSignal?.aborted === true) {
          throw new StockTokenTradeHistoryProviderCleanupError(
            error.cleanupFailures,
            callerSignal.reason,
          );
        }
        if (this.#owner.signal.aborted) {
          throw new StockTokenTradeHistoryProviderCleanupError(
            error.cleanupFailures,
            new StockTokenTradeHistorySourceClosedError(),
          );
        }
        if (
          error.primaryFailure === undefined &&
          (deadline.signal.aborted || performance.now() >= deadlineAt)
        ) {
          try {
            terminalResult(
              "trade_history_unavailable",
              state.base === undefined
                ? state.root === undefined ? "catalog_root" : "selected_base"
                : "selected_period",
              state,
              this.#dependencies.now,
              "deadline",
            );
          } catch (deadlinePrimary) {
            if (deadlinePrimary instanceof SourceTerminal) {
              throw new StockTokenTradeHistoryProviderCleanupError(
                error.cleanupFailures,
                deadlinePrimary,
              );
            }
            throw deadlinePrimary;
          }
        }
        throw error;
      }
      if (callerSignal?.aborted === true) throw callerSignal.reason;
      if (this.#owner.signal.aborted) throw new StockTokenTradeHistorySourceClosedError();
      if (error instanceof SourceTerminal) return error.result;
      if (deadline.signal.aborted || performance.now() >= deadlineAt) {
        try {
          terminalResult(
            "trade_history_unavailable",
            state.base === undefined
              ? state.root === undefined ? "catalog_root" : "selected_base"
              : "selected_period",
            state,
            this.#dependencies.now,
            "deadline",
          );
        } catch (terminal) {
          if (terminal instanceof SourceTerminal) return terminal.result;
          throw terminal;
        }
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    let resolveClose!: () => void;
    let rejectClose!: (reason: unknown) => void;
    const close = new Promise<void>((resolve, reject) => {
      resolveClose = resolve;
      rejectClose = reject;
    });
    this.#closePromise = close;
    this.#closed = true;
    const active = [...this.#active];
    void (async () => {
      this.#owner.abort();
      const cleanupFailures = (await Promise.all(active)).filter(
        (failure): failure is StockTokenTradeHistoryProviderCleanupError => failure !== undefined,
      );
      if (cleanupFailures.length === 1) throw cleanupFailures[0];
      if (cleanupFailures.length > 1) {
        const primaryFailures = cleanupFailures.flatMap((failure) =>
          failure.primaryFailure === undefined ? [] : [failure.primaryFailure]);
        const primary = primaryFailures[0];
        throw new StockTokenTradeHistoryProviderCleanupError(
          cleanupFailures.flatMap((failure) => failure.cleanupFailures),
          primary,
        );
      }
    })().then(resolveClose, rejectClose);
    return close;
  }
}

export const createStockTokenTradeHistorySource = (
  dependencies: StockTokenTradeHistorySourceDependencies,
): StockTokenTradeHistorySourcePort => new StockTokenTradeHistorySource(dependencies);
