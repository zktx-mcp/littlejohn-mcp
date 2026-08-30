import { performance } from "node:perf_hooks";

import {
  deepFreezeValue,
  type UtcTimestamp,
} from "../core/index.js";
import {
  parseStockTokenTradeHistorySourceInput,
  parseStockTokenTradeHistorySourceObservedAt,
  stockTokenTradeHistorySourceContract,
  stockTokenTradeHistorySourceLimits,
  stockTokenTradeHistorySourceResolution,
  StockTokenTradeHistoryProviderCleanupError,
  StockTokenTradeHistorySourceClosedError,
  StockTokenTradeHistorySourceRateLimitError,
  isStockTokenTradeHistoryProviderCleanupError,
  type StockTokenTradeHistoryAvailableSource,
  type StockTokenTradeHistoryCatalogAssetFact,
  type StockTokenTradeHistoryProviderOutcome,
  type StockTokenTradeHistorySelectedBase,
  type StockTokenTradeHistorySelectedOwnerMonth,
  type StockTokenTradeHistorySelectedRoot,
  type StockTokenTradeHistorySourceDependencies,
  type StockTokenTradeHistorySourceInput,
  type StockTokenTradeHistorySourceLimits,
  type StockTokenTradeHistorySourcePort,
  type StockTokenTradeHistorySourceReason,
  type StockTokenTradeHistorySourceResult,
  type StockTokenTradeHistorySourceScope,
  type StockTokenTradeHistoryStoredCandle,
  type StockTokenTradeHistoryStoredMemberIdentity,
  type StockTokenTradeHistoryUnavailableSource,
} from "./source-contract.js";
import {
  decodeStockTokenTradeHistorySourceFile,
  parseBaseMonthFile,
  parseBaseResolutionFile,
  parseBaseStateFile,
  parseSelectedRootFile,
  sourceLogicalId,
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

const rootNamePattern = /^root-s([1-9][0-9]*)-([0-9a-f]{64})\.json\.gz$/u;

class SourceTerminal extends Error {
  constructor(readonly result: StockTokenTradeHistoryUnavailableSource) {
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
  const uniqueFailures = [...new Set(orderedFailures)];
  const cleanupFailures = uniqueFailures.filter(isStockTokenTradeHistoryProviderCleanupError);
  if (cleanupFailures.length !== 0) {
    const primary = orderedFailures.find((error) =>
      !isStockTokenTradeHistoryProviderCleanupError(error));
    throw new StockTokenTradeHistoryProviderCleanupError([
      ...(primary === undefined ? [] : [primary]),
      ...cleanupFailures,
    ]);
  }
  const first = orderedFailures[0];
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
): never => {
  const sourceObservedAt = observedAt(now);
  if (scope === "catalog_root") {
    throw new SourceTerminal(deepFreezeValue({
      status: "unavailable",
      reason,
      scope,
      observedAt: sourceObservedAt,
    }));
  }
  if (state.root === undefined) {
    throw new TypeError("Selected source scope has no admitted root.");
  }
  if (scope === "selected_base") {
    throw new SourceTerminal(deepFreezeValue({
      status: "unavailable",
      reason,
      scope,
      observedAt: sourceObservedAt,
      root: state.root,
    }));
  }
  if (state.base === undefined) {
    throw new TypeError("Selected-period source scope has no admitted base.");
  }
  throw new SourceTerminal(deepFreezeValue({
    status: "unavailable",
    reason,
    scope,
    observedAt: sourceObservedAt,
    root: state.root,
    base: state.base,
  }));
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
    const untilTimestamp = segment.untilTimestamp < input.requestedEnd
      ? segment.untilTimestamp
      : input.requestedEnd;
    const untilBlock = BigInt(segment.untilBlock) < anchorBlock
      ? segment.untilBlock
      : input.canonicalBlock.blockNumber;
    return [{ ...segment, untilTimestamp, untilBlock }];
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

const verifySelectedCandleOrder = (
  candles: readonly StockTokenTradeHistoryStoredCandle[],
): void => {
  let previous: StockTokenTradeHistoryStoredCandle | undefined;
  for (const candle of candles) {
    if (previous !== undefined && (
      candle.intervalStart <= previous.intervalStart ||
      BigInt(candle.firstSource.blockNumber) <= BigInt(previous.lastSource.blockNumber)
    )) throw new StockTokenTradeHistorySourceIntegrityError();
    previous = candle;
  }
};

const validateResolutionOwnsMonthCoverage = (
  resolution: readonly BaseResolutionFile["coverage"][number][],
  month: readonly BaseMonthFile["coverage"][number][],
): void => {
  validateCoverageSequence(resolution);
  validateCoverageSequence(month);
  for (const segment of month) {
    const matches = resolution.filter((candidate) =>
      candidate.poolId === segment.poolId &&
      candidate.fromTimestamp <= segment.fromTimestamp &&
      candidate.untilTimestamp >= segment.untilTimestamp &&
      BigInt(candidate.fromBlock) <= BigInt(segment.fromBlock) &&
      BigInt(candidate.untilBlock) >= BigInt(segment.untilBlock));
    if (matches.length !== 1) throw new StockTokenTradeHistorySourceIntegrityError();
  }
};

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
  readonly #active = new Set<Promise<void>>();
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
    const result = this.#read(input, signal);
    let settlement!: Promise<void>;
    settlement = result.then(() => undefined, () => undefined)
      .finally(() => this.#active.delete(settlement));
    this.#active.add(settlement);
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
        terminalResult("trade_history_unavailable", scope, state, this.#dependencies.now);
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
      const outcome = await this.#dependencies.transport.readMember({
        releaseTag: asset.releaseTag,
        assetName: asset.assetName,
        from: reference.from,
        until: reference.until,
        maximumBytes: compressedBytes,
      }, readSignal);
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
        stockTokenTradeHistorySourceContract.maximumReleaseAssets,
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
      if (candidate.bytes > stockTokenTradeHistorySourceContract.maximumPhysicalAssetBytes) {
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
        sourceLogicalId.state(input.baseCurrencyAddress),
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
        poolPeriods: stateRead.value.poolPeriods,
        pools: stateRead.value.pools,
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
      if (selectedMonths.length > 13) {
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
        const monthLogicalId = sourceLogicalId.month(input.baseCurrencyAddress, ownerMonth);
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
      const resolutionReferences = monthReads.map((monthRead, index) => {
        const ownerMonth = selectedMonths[index]!;
        admit("selected_period", () => coverageSubset(
          monthRead.value.coverage,
          stateRead.value.poolPeriods,
        ));
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
        const expectedResolutionId = sourceLogicalId.resolution(
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
        admit("selected_period", () => coverageSubset(
          resolutionRead.value.coverage,
          stateRead.value.poolPeriods,
        ));
        admit("selected_period", () => validateResolutionOwnsMonthCoverage(
          resolutionRead.value.coverage,
          monthRead.value.coverage,
        ));
        const memberCandles: StockTokenTradeHistoryStoredCandle[] = [];
        for (const candle of resolutionRead.value.candles) {
          if (candleInsideSelectedCoverage(candle, coverage, input)) {
            const selected = candle as StockTokenTradeHistoryStoredCandle;
            memberCandles.push(selected);
            selectedCandles.push(selected);
          }
        }
        ownerMonthSelections.push(deepFreezeValue({
          ownerMonth,
          month: {
            member: monthRead.identity,
            coverage: monthRead.value.coverage,
          },
          resolution: {
            label: input.resolution,
            member: resolutionRead.identity,
            coverage: resolutionRead.value.coverage,
            candles: memberCandles,
          },
        }));
      }
      admit("selected_period", () => verifySelectedCandleOrder(selectedCandles));
      const selectedBase = state.base;
      if (selectedBase === undefined) {
        throw new TypeError("Available trade-history source has no selected base.");
      }
      const result: StockTokenTradeHistoryAvailableSource = deepFreezeValue({
        status: "available",
        observedAt: observedAt(this.#dependencies.now),
        root: state.root,
        base: selectedBase,
        ownerMonths: ownerMonthSelections,
      });
      interrupt("selected_period");
      return result;
    } catch (error) {
      if (isStockTokenTradeHistoryProviderCleanupError(error)) {
        if (callerSignal?.aborted === true) {
          throw new StockTokenTradeHistoryProviderCleanupError([callerSignal.reason, error]);
        }
        if (this.#owner.signal.aborted) {
          throw new StockTokenTradeHistoryProviderCleanupError([
            new StockTokenTradeHistorySourceClosedError(),
            error,
          ]);
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
    this.#closed = true;
    this.#owner.abort();
    const active = [...this.#active];
    this.#closePromise = Promise.allSettled(active).then(() => undefined);
    return this.#closePromise;
  }
}

export const createStockTokenTradeHistorySource = (
  dependencies: StockTokenTradeHistorySourceDependencies,
): StockTokenTradeHistorySourcePort => new StockTokenTradeHistorySource(dependencies);

export const stockTokenTradeHistorySourceQuoteAddress =
  stockTokenTradeHistorySourceContract.usdgAddress;

export const stockTokenTradeHistorySourceIntervalSeconds = (
  resolution: StockTokenTradeHistorySourceInput["resolution"],
): number => stockTokenTradeHistorySourceResolution(resolution).intervalSeconds;
