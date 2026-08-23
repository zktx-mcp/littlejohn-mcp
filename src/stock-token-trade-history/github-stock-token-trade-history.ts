import type { ReadableStreamDefaultReader, ReadableStreamReadResult } from "node:stream/web";

import { z } from "zod";

import {
  deepFreezeValue,
  hash32Schema,
  jsonObject,
  marketTimeWindowDefinitions,
  marketTimeWindowSchema,
  utcTimestampSchema,
} from "../core/index.js";
import {
  createStockTokenTradeHistoryData,
  findStockTokenTradeHistoryAssetByPairId,
  stockTokenTradeHistoryFileMaximumBytes,
  stockTokenTradeHistoryDataLimits,
  unavailableStockTokenTradeHistoryData,
  type StockTokenTradeHistoryFileReference,
  type StockTokenTradeHistoryDayAdmission,
  type StockTokenTradeHistoryMonthAdmission,
  type StockTokenTradeHistoryReadInput,
  type StockTokenTradeHistoryReadPort,
  type StockTokenTradeHistoryData,
} from "./stock-token-trade-history-data.js";
import {
  decodeStockTokenTradeHistoryDay,
  decodeStockTokenTradeHistoryMonth,
  decodeStockTokenTradeHistoryState,
} from "./stock-token-trade-history-file.js";

const githubStockTokenTradeHistorySettings = deepFreezeValue({
  repository: "stelis-dev/robinhood-stock-token-index",
  apiOrigin: "https://api.github.com",
  downloadOrigin: "https://github.com",
  apiVersion: "2022-11-28",
  userAgent: "littlejohn-mcp",
  maximumReleaseAssets: 1_000,
  maximumConcurrentFileReads: 2,
  metadataResponseBytes: 2_097_152,
  requestDeadlineMilliseconds: 30_000,
} as const);

const githubReleaseSchema = jsonObject({
  id: z.number().int().positive().safe(),
  tag_name: z.string().min(1).max(256),
}).passthrough();
const githubReleaseAssetSchema = jsonObject({
  id: z.number().int().positive().safe(),
  name: z.string().min(1).max(256),
  size: z.number().int().nonnegative().max(stockTokenTradeHistoryFileMaximumBytes),
}).passthrough();
const githubReleaseAssetListSchema = z.array(githubReleaseAssetSchema).max(100);
const inputSchema = jsonObject({
  pairId: hash32Schema,
  window: marketTimeWindowSchema,
  requestedStart: utcTimestampSchema,
  requestedEnd: utcTimestampSchema,
}).strict();

class TradeHistoryTransportError extends Error {
  constructor(readonly kind: "unavailable" | "inconsistent") {
    super("Stock Token trade-history data read failed.");
    this.name = "TradeHistoryTransportError";
  }
}

class TradeHistoryLocalError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TradeHistoryLocalError";
  }
}

const tradeHistoryCleanupFailure = (failures: readonly unknown[]): TradeHistoryLocalError => new TradeHistoryLocalError(
  "Stock Token trade-history response cleanup failed.",
  { cause: failures.length === 1 ? failures[0] : new AggregateError(failures) },
);

const discardBody = async (response: Response): Promise<void> => {
  if (response.body === null) return;
  try {
    await response.body.cancel();
  } catch (error) {
    throw tradeHistoryCleanupFailure([error]);
  }
};

const closeReader = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  cancel: boolean,
): Promise<void> => {
  const failures: unknown[] = [];
  if (cancel) {
    try { await reader.cancel(); }
    catch (error) { failures.push(error); }
  }
  try { reader.releaseLock(); }
  catch (error) { failures.push(error); }
  if (failures.length !== 0) throw tradeHistoryCleanupFailure(failures);
};

const readBoundedBody = async (
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> => {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    (!/^(?:0|[1-9][0-9]*)$/u.test(contentLength) || BigInt(contentLength) > BigInt(maximumBytes))
  ) {
    await discardBody(response);
    throw new TradeHistoryTransportError("inconsistent");
  }
  if (response.body === null) throw new TradeHistoryTransportError("inconsistent");
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try { reader = response.body.getReader(); }
  catch (error) {
    const primaryFailure = new TradeHistoryLocalError("Stock Token trade-history body reader could not be acquired.", {
      cause: error,
    });
    try { await discardBody(response); }
    catch (cleanupError) { throw tradeHistoryCleanupFailure([primaryFailure, cleanupError]); }
    throw primaryFailure;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let complete = false;
  let primaryFailure: Readonly<{ reason: unknown }> | undefined;
  try {
    while (true) {
      let part: ReadableStreamReadResult<Uint8Array>;
      try { part = await reader.read(); }
      catch (error) {
        primaryFailure = { reason: new TradeHistoryTransportError("unavailable") };
        break;
      }
      if (part.done) {
        complete = true;
        break;
      }
      if (!(part.value instanceof Uint8Array)) {
        primaryFailure = {
          reason: new TradeHistoryLocalError("Stock Token trade-history reader returned an invalid chunk."),
        };
        break;
      }
      if (signal.aborted) {
        primaryFailure = { reason: new TradeHistoryTransportError("unavailable") };
        break;
      }
      total += part.value.byteLength;
      if (total > maximumBytes) {
        primaryFailure = { reason: new TradeHistoryTransportError("inconsistent") };
        break;
      }
      chunks.push(part.value);
    }
  } finally {
    try {
      await closeReader(reader, !complete);
    } catch (cleanupError) {
      if (primaryFailure === undefined) throw cleanupError;
      throw tradeHistoryCleanupFailure([primaryFailure.reason, cleanupError]);
    }
  }
  if (primaryFailure !== undefined) throw primaryFailure.reason;
  if (signal.aborted) throw new TradeHistoryTransportError("unavailable");
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
};

const readJson = (bytes: Uint8Array): unknown => {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new TradeHistoryTransportError("inconsistent");
  }
};

const stateTag = (pairId: string): string => `pair-${pairId}-state`;
const monthTag = (pairId: string, month: string): string => `pair-${pairId}-month-${month}`;
const stateObjectNamePattern = /^state-g([0-9]{16})\.json\.gz$/u;
const referenceIdentity = (reference: StockTokenTradeHistoryFileReference): Readonly<{
  kind: "month" | "day";
  pairId: string;
  period: string;
}> => {
  const match = reference.logicalId.match(/^pairs\/(0x[0-9a-f]{64})\/(months|days)\/(.+)$/u);
  if (match === null) throw new TradeHistoryTransportError("inconsistent");
  return Object.freeze({
    pairId: match[1]!,
    kind: match[2] === "months" ? "month" : "day",
    period: match[3]!,
  });
};
const referenceObjectName = (reference: StockTokenTradeHistoryFileReference): string => {
  const identity = referenceIdentity(reference);
  return `${identity.kind}-${identity.period}-g${reference.sequence.toString().padStart(16, "0")}-` +
    `${reference.gzipSha256}.json.gz`;
};

const monthSlices = (from: string, until: string): readonly Readonly<{
  from: string;
  until: string;
  month: string;
}>[] => {
  const output: Array<{ from: string; until: string; month: string }> = [];
  let cursor = from;
  while (cursor < until) {
    const nextMonth = new Date(`${cursor.slice(0, 7)}-01T00:00:00.000Z`);
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    const boundary = nextMonth.toISOString();
    const sliceUntil = boundary < until ? boundary : until;
    output.push({ from: cursor, until: sliceUntil, month: cursor.slice(0, 7) });
    cursor = sliceUntil;
  }
  return output;
};

const overlaps = (
  reference: StockTokenTradeHistoryFileReference,
  from: string,
  until: string,
): boolean => reference.coverage.untilTimestamp > from && reference.coverage.fromTimestamp < until;

const readConcurrently = async <Input, Output>(
  inputs: readonly Input[],
  read: (input: Input) => Promise<Output>,
): Promise<readonly Output[]> => {
  const output = new Array<Output>(inputs.length);
  const failures: Array<{ index: number; reason: unknown }> = [];
  let next = 0;
  let stopped = false;
  const worker = async (): Promise<void> => {
    while (!stopped && next < inputs.length) {
      const index = next;
      next += 1;
      try { output[index] = await read(inputs[index]!); }
      catch (reason) {
        failures.push({ index, reason });
        stopped = true;
      }
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(inputs.length, githubStockTokenTradeHistorySettings.maximumConcurrentFileReads) },
    () => worker(),
  ));
  if (failures.length !== 0) {
    failures.sort((left, right) => left.index - right.index);
    throw failures[0]!.reason;
  }
  return output;
};

export interface GitHubStockTokenTradeHistoryOptions {
  readonly fetchImplementation?: typeof fetch | undefined;
}

export const createGitHubStockTokenTradeHistory = (
  options: GitHubStockTokenTradeHistoryOptions = {},
): StockTokenTradeHistoryReadPort => {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Stock Token trade-history options are invalid.");
  }
  if (Object.keys(options).some((key) => key !== "fetchImplementation")) {
    throw new TypeError("Stock Token trade-history options contain an unknown setting.");
  }
  const suppliedFetch = options.fetchImplementation;
  if (suppliedFetch !== undefined && typeof suppliedFetch !== "function") {
    throw new TypeError("Stock Token trade-history fetch dependency is invalid.");
  }
  const fetchImplementation = suppliedFetch === undefined ? fetch : suppliedFetch;

  const request = async (
    target: string,
    maximumBytes: number,
    signal: AbortSignal,
    accept: string,
  ): Promise<Readonly<{ status: number; bytes: Uint8Array }>> => {
    let response: Response;
    try {
      const fetched = await fetchImplementation(target, {
        method: "GET",
        headers: {
          accept,
          "user-agent": githubStockTokenTradeHistorySettings.userAgent,
          ...(target.startsWith(githubStockTokenTradeHistorySettings.apiOrigin)
            ? { "x-github-api-version": githubStockTokenTradeHistorySettings.apiVersion }
            : {}),
        },
        redirect: "follow",
        credentials: "omit",
        signal,
      });
      if (!(fetched instanceof Response)) {
        throw new TradeHistoryLocalError("Stock Token trade-history fetch returned an invalid response.");
      }
      response = fetched;
    } catch (error) {
      if (error instanceof TradeHistoryLocalError) throw error;
      throw new TradeHistoryTransportError("unavailable");
    }
    if (!response.ok) {
      await discardBody(response);
      return Object.freeze({ status: response.status, bytes: new Uint8Array() });
    }
    return Object.freeze({
      status: response.status,
      bytes: await readBoundedBody(response, maximumBytes, signal),
    });
  };

  const apiRequest = async (
    path: string,
    maximumBytes: number,
    signal: AbortSignal,
  ): Promise<Readonly<{ status: number; bytes: Uint8Array }>> => request(
    `${githubStockTokenTradeHistorySettings.apiOrigin}${path}`,
    maximumBytes,
    signal,
    "application/vnd.github+json",
  );

  const listAssets = async (releaseId: number, signal: AbortSignal) => {
    const assets: z.infer<typeof githubReleaseAssetSchema>[] = [];
    for (let page = 1; page <= 11; page += 1) {
      const response = await apiRequest(
        `/repos/${githubStockTokenTradeHistorySettings.repository}/releases/${releaseId}/assets?per_page=100&page=${page}`,
        githubStockTokenTradeHistorySettings.metadataResponseBytes,
        signal,
      );
      if (response.status !== 200) throw new TradeHistoryTransportError("unavailable");
      let part: z.infer<typeof githubReleaseAssetListSchema>;
      try { part = githubReleaseAssetListSchema.parse(readJson(response.bytes)); }
      catch (error) {
        if (error instanceof TradeHistoryTransportError) throw error;
        throw new TradeHistoryTransportError("inconsistent");
      }
      assets.push(...part);
      if (assets.length > githubStockTokenTradeHistorySettings.maximumReleaseAssets) {
        throw new TradeHistoryTransportError("inconsistent");
      }
      if (part.length < 100) break;
      if (page === 11) throw new TradeHistoryTransportError("inconsistent");
    }
    if (
      new Set(assets.map((asset) => asset.id)).size !== assets.length ||
      new Set(assets.map((asset) => asset.name)).size !== assets.length
    ) throw new TradeHistoryTransportError("inconsistent");
    return assets;
  };

  const readReleaseFile = async (
    tag: string,
    name: string,
    expectedBytes: number | undefined,
    signal: AbortSignal,
  ): Promise<Uint8Array> => {
    const response = await request(
      `${githubStockTokenTradeHistorySettings.downloadOrigin}/` +
        `${githubStockTokenTradeHistorySettings.repository}/releases/download/` +
        `${encodeURIComponent(tag)}/${encodeURIComponent(name)}`,
      stockTokenTradeHistoryFileMaximumBytes,
      signal,
      "application/octet-stream",
    );
    if (response.status !== 200) throw new TradeHistoryTransportError("inconsistent");
    if (expectedBytes !== undefined && response.bytes.byteLength !== expectedBytes) {
      throw new TradeHistoryTransportError("inconsistent");
    }
    return response.bytes;
  };

  const readReferenced = async (
    reference: StockTokenTradeHistoryFileReference,
    signal: AbortSignal,
  ): Promise<Uint8Array> => {
    const identity = referenceIdentity(reference);
    return readReleaseFile(
      monthTag(identity.pairId, identity.period.slice(0, 7)),
      referenceObjectName(reference),
      reference.gzipBytes,
      signal,
    );
  };

  const read = async (
    inputValue: StockTokenTradeHistoryReadInput,
    callerSignal?: AbortSignal,
  ): Promise<StockTokenTradeHistoryData> => {
    const input = inputSchema.parse(inputValue);
    const requestedStart = Date.parse(input.requestedStart);
    const requestedEnd = Date.parse(input.requestedEnd);
    if (
      requestedStart >= requestedEnd ||
      requestedEnd - requestedStart !== marketTimeWindowDefinitions[input.window].durationMilliseconds
    ) throw new TypeError("Stock Token trade-history request interval is invalid.");
    const asset = findStockTokenTradeHistoryAssetByPairId(input.pairId);
    if (asset === undefined) return unavailableStockTokenTradeHistoryData(input, "asset_not_supported");
    if (callerSignal !== undefined && !(callerSignal instanceof AbortSignal)) {
      throw new TypeError("Stock Token trade-history signal is invalid.");
    }
    const deadlineSignal = AbortSignal.timeout(
      githubStockTokenTradeHistorySettings.requestDeadlineMilliseconds,
    );
    const signal = callerSignal === undefined
      ? deadlineSignal
      : AbortSignal.any([callerSignal, deadlineSignal]);
    try {
      const selectedTag = stateTag(input.pairId);
      const releaseResponse = await apiRequest(
        `/repos/${githubStockTokenTradeHistorySettings.repository}/releases/tags/${encodeURIComponent(selectedTag)}`,
        githubStockTokenTradeHistorySettings.metadataResponseBytes,
        signal,
      );
      if (releaseResponse.status === 404) {
        return unavailableStockTokenTradeHistoryData(input, "trade_history_unavailable");
      }
      if (releaseResponse.status !== 200) throw new TradeHistoryTransportError("unavailable");
      let release: z.infer<typeof githubReleaseSchema>;
      try { release = githubReleaseSchema.parse(readJson(releaseResponse.bytes)); }
      catch (error) {
        if (error instanceof TradeHistoryTransportError) throw error;
        throw new TradeHistoryTransportError("inconsistent");
      }
      if (release.tag_name !== selectedTag) throw new TradeHistoryTransportError("inconsistent");
      const assets = await listAssets(release.id, signal);
      const candidates = assets.map((candidate) => {
        const match = candidate.name.match(stateObjectNamePattern);
        return { candidate, sequence: match === null ? null : Number(match[1]) };
      }).filter((entry): entry is typeof entry & { sequence: number } =>
        entry.sequence !== null && Number.isSafeInteger(entry.sequence) && entry.sequence > 0)
        .sort((left, right) => left.sequence - right.sequence);
      if (candidates.length === 0) {
        return unavailableStockTokenTradeHistoryData(input, "trade_history_unavailable");
      }
      const selected = candidates.at(-1)!;
      const selectedSequence = selected.sequence;
      const stateBytes = await readReleaseFile(
        selectedTag,
        selected.candidate.name,
        selected.candidate.size,
        signal,
      );
      let stateValue: ReturnType<typeof decodeStockTokenTradeHistoryState>;
      try {
        stateValue = decodeStockTokenTradeHistoryState(stateBytes, input.pairId, selectedSequence);
      } catch {
        throw new TradeHistoryTransportError("inconsistent");
      }

      const slices = monthSlices(input.requestedStart, input.requestedEnd);
      const monthReferences = slices.flatMap((slice) => stateValue.state.months.filter((reference) =>
        reference.logicalId === `${stockTokenTradePairMonthPrefix(input.pairId)}${slice.month}` &&
        overlaps(reference, slice.from, slice.until)));
      if (monthReferences.length === 0) {
        return unavailableStockTokenTradeHistoryData(input, "outside_published_coverage");
      }
      if (
        monthReferences.length > stockTokenTradeHistoryDataLimits.monthFiles ||
        new Set(monthReferences.map((reference) => reference.logicalId)).size !== monthReferences.length
      ) throw new TradeHistoryTransportError("inconsistent");
      const months = await readConcurrently(monthReferences, async (reference): Promise<StockTokenTradeHistoryMonthAdmission> => {
        try {
          const decoded = decodeStockTokenTradeHistoryMonth(await readReferenced(reference, signal), reference);
          return deepFreezeValue({ reference, ...decoded });
        } catch (error) {
          if (error instanceof TradeHistoryLocalError) throw error;
          throw new TradeHistoryTransportError("inconsistent");
        }
      });
      const dayReferences = months.flatMap((entry) => entry.month.days)
        .filter((reference) => overlaps(reference, input.requestedStart, input.requestedEnd));
      if (
        dayReferences.length === 0 || dayReferences.length > stockTokenTradeHistoryDataLimits.dayFiles ||
        new Set(dayReferences.map((reference) => reference.logicalId)).size !== dayReferences.length
      ) throw new TradeHistoryTransportError("inconsistent");
      const days = await readConcurrently(dayReferences, async (reference): Promise<StockTokenTradeHistoryDayAdmission> => {
        try {
          const decoded = decodeStockTokenTradeHistoryDay(await readReferenced(reference, signal), reference);
          return deepFreezeValue({ reference, ...decoded });
        } catch (error) {
          if (error instanceof TradeHistoryLocalError) throw error;
          throw new TradeHistoryTransportError("inconsistent");
        }
      });
      try {
        return createStockTokenTradeHistoryData({
          request: input,
          asset,
          state: stateValue.state,
          stateSha256: stateValue.sha256,
          months,
          days,
        });
      } catch {
        throw new TradeHistoryTransportError("inconsistent");
      }
    } catch (error) {
      if (callerSignal?.aborted === true || error instanceof TradeHistoryLocalError) throw error;
      const kind = error instanceof TradeHistoryTransportError ? error.kind : "inconsistent";
      return unavailableStockTokenTradeHistoryData(
        input,
        kind === "unavailable" ? "trade_history_unavailable" : "trade_history_inconsistent",
      );
    }
  };

  return Object.freeze({ read });
};

const stockTokenTradePairMonthPrefix = (pairId: string): string => `pairs/${pairId}/months/`;
