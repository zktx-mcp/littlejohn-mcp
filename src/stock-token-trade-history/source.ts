import { performance } from "node:perf_hooks";

import { subtractUtcCalendarMonths } from "./calendar.js";

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
  admitStockTokenTradeHistorySourceResult,
  assertStockTokenTradeHistoryStoredCandleSequence,
  coalesceStockTokenTradeHistoryCoverage,
  deriveStockTokenTradeHistorySourceRequirements,
  stockTokenTradeHistoryLogicalId,
  stockTokenTradeHistoryOwnerMonths,
  stockTokenTradeHistoryAvailableSourceSchema,
  stockTokenTradeHistoryUnavailableSourceSchema,
  type StockTokenTradeHistoryAvailableSource,
  type StockTokenTradeHistoryCoverageSegment,
  type StockTokenTradeHistoryPoolKey,
  type StockTokenTradeHistorySelectedBase,
  type StockTokenTradeHistorySelectedMember,
  type StockTokenTradeHistorySelectedRoot,
  type StockTokenTradeHistorySourceRequirements,
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

class SourceDeadlineAbort extends Error {
  constructor() {
    super("The Stock Token trade-history source deadline elapsed.");
    this.name = "SourceDeadlineAbort";
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
      error instanceof SourceTerminal && error.origin === "deadline") ?? primaryCandidates[0];
    const cleanupFailures = cleanupErrors.flatMap((error) => error.cleanupFailures);
    throw new StockTokenTradeHistoryProviderCleanupError(cleanupFailures, primary);
  }
  const first = orderedFailures.find((error) =>
    error instanceof SourceTerminal && error.origin === "deadline") ?? orderedFailures[0];
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

const sourceTerminal = (
  reason: StockTokenTradeHistorySourceReason,
  scope: StockTokenTradeHistorySourceScope,
  state: SourceState,
  now: () => Date,
  origin: "source" | "deadline" = "source",
): SourceTerminal => {
  const sourceObservedAt = observedAt(now);
  if (scope === "catalog_root") {
    return new SourceTerminal(deepFreezeValue(
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
    return new SourceTerminal(deepFreezeValue(
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
  return new SourceTerminal(deepFreezeValue(
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

const terminalResult = (
  reason: StockTokenTradeHistorySourceReason,
  scope: StockTokenTradeHistorySourceScope,
  state: SourceState,
  now: () => Date,
  origin: "source" | "deadline" = "source",
): never => {
  throw sourceTerminal(reason, scope, state, now, origin);
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
  const lowerBound = subtractUtcCalendarMonths(currentUntil.timestamp, 12);
  const earliestDay = `${lowerBound.slice(0, 10)}T00:00:00.000Z`;
  const first = state.poolPeriods[0]!;
  if (first.fromTimestamp < earliestDay) throw new StockTokenTradeHistorySourceIntegrityError();
  if (first.fromTimestamp < lowerBound) {
    const prefix = Date.parse(lowerBound) - Date.parse(first.fromTimestamp);
    if (prefix <= 0 || prefix >= 15 * 60_000) {
      throw new StockTokenTradeHistorySourceIntegrityError();
    }
  }
  const expectedMonths = stockTokenTradeHistoryOwnerMonths(
    first.fromTimestamp,
    currentUntil.timestamp,
  );
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

const sameStrings = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const orderedSubset = (subset: readonly string[], superset: readonly string[]): boolean => {
  let cursor = 0;
  for (const value of subset) {
    const index = superset.indexOf(value, cursor);
    if (index < 0) return false;
    cursor = index + 1;
  }
  return true;
};

const sameEligiblePositions = (
  left: StockTokenTradeHistorySourceRequirements["eligiblePositions"],
  right: StockTokenTradeHistorySourceRequirements["eligiblePositions"],
): boolean => left.length === right.length && left.every((position, index) => {
  const candidate = right[index];
  return candidate !== undefined &&
    position.naturalStart === candidate.naturalStart &&
    position.naturalEnd === candidate.naturalEnd &&
    position.representedStart === candidate.representedStart &&
    position.representedEnd === candidate.representedEnd &&
    position.ownerMonth === candidate.ownerMonth &&
    position.poolId === candidate.poolId;
});

const assertSameRequirements = (
  expected: StockTokenTradeHistorySourceRequirements,
  actual: StockTokenTradeHistorySourceRequirements,
): void => {
  const expectedByStart = new Map(expected.eligiblePositions.map((position) =>
    [position.naturalStart, position] as const));
  if (
    !orderedSubset(actual.coverageOwnerMonths, expected.coverageOwnerMonths) ||
    !orderedSubset(actual.resolutionOwnerMonths, expected.resolutionOwnerMonths) ||
    actual.eligiblePositions.some((position) => {
      const candidate = expectedByStart.get(position.naturalStart);
      return candidate === undefined || !sameEligiblePositions([position], [candidate]);
    })
  ) throw new StockTokenTradeHistorySourceIntegrityError();
};

const sourceRequirements = (
  input: StockTokenTradeHistorySourceInput,
  coverage: readonly StockTokenTradeHistoryCoverageSegment[],
): StockTokenTradeHistorySourceRequirements => {
  try {
    return deriveStockTokenTradeHistorySourceRequirements(input, coverage);
  } catch {
    throw new StockTokenTradeHistorySourceIntegrityError();
  }
};

interface SelectedResolutionRead extends ReadMemberResult<BaseResolutionFile> {
  readonly ownerMonth: string;
}

interface SelectedMonthRead extends ReadMemberResult<BaseMonthFile> {
  readonly ownerMonth: string;
}

const selectResolutionCandles = (input: Readonly<{
  sourceInput: StockTokenTradeHistorySourceInput;
  stateCoverage: readonly StockTokenTradeHistoryCoverageSegment[];
  requirements: StockTokenTradeHistorySourceRequirements;
  months: readonly SelectedMonthRead[];
  resolutions: readonly SelectedResolutionRead[];
}>): readonly StockTokenTradeHistoryStoredCandle[] => {
  if (!sameStrings(
    input.resolutions.map((read) => read.ownerMonth),
    input.requirements.resolutionOwnerMonths,
  )) throw new StockTokenTradeHistorySourceIntegrityError();
  const eligibleByStart = new Map(input.requirements.eligiblePositions.map((position) =>
    [position.naturalStart, position] as const));
  const requestByStart = new Map(input.requirements.request.positions.map((position) =>
    [position.naturalStart, position] as const));
  const selected: StockTokenTradeHistoryStoredCandle[] = [];
  for (const resolution of input.resolutions) {
    coverageSubset(resolution.value.coverage, input.stateCoverage);
    const month = input.months.find((candidate) =>
      candidate.ownerMonth === resolution.ownerMonth);
    if (month === undefined) throw new StockTokenTradeHistorySourceIntegrityError();
    let monthCoverage: readonly StockTokenTradeHistoryCoverageSegment[];
    let resolutionCoverage: readonly StockTokenTradeHistoryCoverageSegment[];
    try {
      monthCoverage = coalesceStockTokenTradeHistoryCoverage(month.value.coverage);
      resolutionCoverage = coalesceStockTokenTradeHistoryCoverage(resolution.value.coverage);
    } catch {
      throw new StockTokenTradeHistorySourceIntegrityError();
    }
    const firstMonthCoverage = monthCoverage[0];
    const firstResolutionCoverage = resolutionCoverage.find((segment) =>
      segment.untilTimestamp > `${resolution.ownerMonth}-01T00:00:00.000Z`);
    if (
      firstMonthCoverage === undefined ||
      firstResolutionCoverage === undefined ||
      firstResolutionCoverage.fromTimestamp !== firstMonthCoverage.fromTimestamp ||
      firstResolutionCoverage.fromBlock !== firstMonthCoverage.fromBlock ||
      monthCoverage.some((segment) => resolutionCoverage.filter((candidate) =>
        candidate.poolId === segment.poolId &&
        candidate.fromTimestamp <= segment.fromTimestamp &&
        candidate.untilTimestamp >= segment.untilTimestamp &&
        BigInt(candidate.fromBlock) <= BigInt(segment.fromBlock) &&
        BigInt(candidate.untilBlock) >= BigInt(segment.untilBlock)).length !== 1)
    ) throw new StockTokenTradeHistorySourceIntegrityError();
    const eligible = input.requirements.eligiblePositions.filter((position) =>
      position.ownerMonth === resolution.ownerMonth);
    if (eligible.length === 0) throw new StockTokenTradeHistorySourceIntegrityError();
    for (const position of eligible) {
      const matches = resolution.value.coverage.filter((segment) =>
        segment.poolId === position.poolId &&
        segment.fromTimestamp <= position.naturalStart &&
        segment.untilTimestamp >= position.naturalEnd);
      if (matches.length !== 1) throw new StockTokenTradeHistorySourceIntegrityError();
    }
    for (const candle of resolution.value.candles) {
      const requestPosition = requestByStart.get(candle.intervalStart);
      if (requestPosition === undefined) continue;
      const eligiblePosition = eligibleByStart.get(candle.intervalStart);
      const matches = input.requirements.coverage.filter((segment) =>
        segment.poolId === eligiblePosition?.poolId &&
        segment.fromTimestamp <= candle.intervalStart &&
        segment.untilTimestamp >= candle.intervalEnd &&
        BigInt(segment.fromBlock) <= BigInt(candle.firstSource.blockNumber) &&
        BigInt(segment.untilBlock) > BigInt(candle.lastSource.blockNumber));
      if (
        eligiblePosition === undefined ||
        eligiblePosition.ownerMonth !== resolution.ownerMonth ||
        candle.intervalEnd !== requestPosition.naturalEnd ||
        BigInt(candle.lastSource.blockNumber) >=
          BigInt(input.sourceInput.canonicalBlock.blockNumber) ||
        matches.length !== 1
      ) throw new StockTokenTradeHistorySourceIntegrityError();
      selected.push(candle);
    }
  }
  selected.sort((left, right) => left.intervalStart.localeCompare(right.intervalStart));
  assertStockTokenTradeHistoryStoredCandleSequence({
    candles: selected,
    baseDecimals: input.sourceInput.baseCurrencyDecimals,
    resolution: input.sourceInput.resolution,
  });
  return deepFreezeValue(selected);
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

const deadlineOrSignal = (
  caller: AbortSignal | undefined,
  owner: AbortSignal,
  deadline: AbortSignal,
): AbortSignal => caller === undefined
  ? AbortSignal.any([owner, deadline])
  : AbortSignal.any([caller, owner, deadline]);

class StockTokenTradeHistorySource implements StockTokenTradeHistorySourcePort {
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
    const deadlineReason = new SourceDeadlineAbort();
    const deadlineAt = performance.now() + limits.deadlineMilliseconds;
    const timer = setTimeout(
      () => deadline.abort(deadlineReason),
      limits.deadlineMilliseconds,
    );
    const signal = deadlineOrSignal(
      callerSignal,
      this.#owner.signal,
      deadline.signal,
    );
    const higherPriorityFailure = (): unknown | undefined => {
      if (callerSignal?.aborted === true) return callerSignal.reason;
      if (this.#owner.signal.aborted) return new StockTokenTradeHistorySourceClosedError();
      return undefined;
    };
    const preserveCleanup = (
      cleanupFailures: readonly unknown[],
      createPrimary: () => unknown,
    ): StockTokenTradeHistoryProviderCleanupError => {
      let primary: unknown;
      try {
        primary = createPrimary();
      } catch (error) {
        primary = error;
      }
      return new StockTokenTradeHistoryProviderCleanupError(
        cleanupFailures,
        higherPriorityFailure() ?? primary,
      );
    };
    const interrupt = (scope: StockTokenTradeHistorySourceScope): void => {
      const higherPriority = higherPriorityFailure();
      if (higherPriority !== undefined) throw higherPriority;
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
        if (isStockTokenTradeHistoryProviderCleanupError(error)) {
          if (error.primaryFailure === deadlineReason) {
            throw preserveCleanup(
              error.cleanupFailures,
              () => sourceTerminal(
                "trade_history_unavailable",
                scope,
                state,
                this.#dependencies.now,
                "deadline",
              ),
            );
          }
          throw error;
        }
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
      state.base = deepFreezeValue({
        baseCurrencyAddress: input.baseCurrencyAddress,
        decimals: stateRead.value.decimals,
        state: stateRead.identity,
      });
      const stateRequirements = admit("selected_period", () =>
        sourceRequirements(input, stateRead.value.poolPeriods));
      if (
        stateRequirements.coverage.length === 0 ||
        !stateRequirements.requestedCoverageAvailable
      ) {
        return terminalResult(
          "outside_published_coverage",
          "selected_period",
          state,
          this.#dependencies.now,
        );
      }
      if (stateRequirements.coverageOwnerMonths.length > limits.stateMonths) {
        return terminalResult(
          "trade_history_too_large",
          "selected_period",
          state,
          this.#dependencies.now,
        );
      }
      const monthReferences = stateRequirements.coverageOwnerMonths.map((ownerMonth) => {
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
      const selectedMonthReads: SelectedMonthRead[] = monthReads.map(
        (read, index) => deepFreezeValue({
          ownerMonth: stateRequirements.coverageOwnerMonths[index]!,
          ...read,
        }),
      );
      const admittedMonthCoverage = admit("selected_period", () => selectedMonthCoverage(
        stateRead.value.poolPeriods,
        stateRequirements.coverageOwnerMonths,
        monthReads.map((read) => read.value),
      ));
      const monthRequirements = admit("selected_period", () =>
        sourceRequirements(input, admittedMonthCoverage));
      admit("selected_period", () => assertSameRequirements(stateRequirements, monthRequirements));
      const requirements = monthRequirements;
      if (requirements.coverage.length === 0 || !requirements.requestedCoverageAvailable) {
        return terminalResult(
          "outside_published_coverage",
          "selected_period",
          state,
          this.#dependencies.now,
        );
      }
      const monthMembers: StockTokenTradeHistorySelectedMember[] =
        requirements.coverageOwnerMonths.map((ownerMonth) => {
          const index = stateRequirements.coverageOwnerMonths.indexOf(ownerMonth);
          const monthRead = monthReads[index];
          if (index < 0 || monthRead === undefined) {
            return terminalResult(
              "trade_history_inconsistent",
              "selected_period",
              state,
              this.#dependencies.now,
            );
          }
          return deepFreezeValue({ ownerMonth, member: monthRead.identity });
        });
      for (const monthRead of monthReads) {
        for (const child of [
          ...monthRead.value.days,
          ...Object.values(monthRead.value.resolutions),
        ]) {
          admit("selected_period", () => {
            memberAsset(rootAdmission.selectedAssetByLogicalId, child);
            return undefined;
          });
        }
      }
      const resolutionReferences = requirements.resolutionOwnerMonths.map((ownerMonth) => {
        const monthIndex = requirements.coverageOwnerMonths.indexOf(ownerMonth);
        const monthRead = monthReads[monthIndex];
        if (monthIndex < 0 || monthRead === undefined) {
          return terminalResult(
            "trade_history_inconsistent",
            "selected_period",
            state,
            this.#dependencies.now,
          );
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
        async ({ ownerMonth, reference, expectedResolutionId }, _index, memberSignal) => {
          const read = await readMember(
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
          );
          return deepFreezeValue({ ownerMonth, ...read });
        },
      );
      const selectedCandles = admit("selected_period", () => selectResolutionCandles({
        sourceInput: input,
        stateCoverage: stateRead.value.poolPeriods,
        requirements,
        months: selectedMonthReads,
        resolutions: resolutionReads,
      }));
      const resolutionMembers: StockTokenTradeHistorySelectedMember[] =
        resolutionReads.map((read) => deepFreezeValue({
          ownerMonth: read.ownerMonth,
          member: read.identity,
        }));
      const selectedBase = state.base;
      if (selectedBase === undefined) {
        throw new TypeError("Available trade-history source has no selected base.");
      }
      const requiredPoolIds = new Set(
        requirements.coverage.map((segment) => segment.poolId),
      );
      const pools: Record<string, StockTokenTradeHistoryPoolKey> = {};
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
        pools[poolId] = facts.poolKey;
      }
      const result = deepFreezeValue(stockTokenTradeHistoryAvailableSourceSchema.parse({
        status: "available",
        observedAt: observedAt(this.#dependencies.now),
        root: rootAdmission.root,
        base: selectedBase,
        coverage: requirements.coverage,
        pools,
        coverageOwnerMonths: requirements.coverageOwnerMonths,
        monthMembers,
        resolutionMembers,
        candles: selectedCandles,
      })) as StockTokenTradeHistoryAvailableSource;
      const admitted = admitStockTokenTradeHistorySourceResult(input, result);
      interrupt("selected_period");
      return admitted;
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
          error.primaryFailure === deadlineReason ||
          error.primaryFailure === undefined &&
            (deadline.signal.aborted || performance.now() >= deadlineAt)
        ) {
          const scope = state.base === undefined
            ? state.root === undefined ? "catalog_root" : "selected_base"
            : "selected_period";
          throw preserveCleanup(
            error.cleanupFailures,
            () => sourceTerminal(
              "trade_history_unavailable",
              scope,
              state,
              this.#dependencies.now,
              "deadline",
            ),
          );
        }
        throw error;
      }
      if (callerSignal?.aborted === true) throw callerSignal.reason;
      if (this.#owner.signal.aborted) throw new StockTokenTradeHistorySourceClosedError();
      if (deadline.signal.aborted || performance.now() >= deadlineAt) {
        const scope = state.base === undefined
          ? state.root === undefined ? "catalog_root" : "selected_base"
          : "selected_period";
        const deadlineTerminal = sourceTerminal(
          "trade_history_unavailable",
          scope,
          state,
          this.#dependencies.now,
          "deadline",
        );
        const higherPriority = higherPriorityFailure();
        if (higherPriority !== undefined) throw higherPriority;
        return admitStockTokenTradeHistorySourceResult(
          input,
          deadlineTerminal.result,
        );
      }
      if (error instanceof SourceTerminal) {
        return admitStockTokenTradeHistorySourceResult(input, error.result);
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
