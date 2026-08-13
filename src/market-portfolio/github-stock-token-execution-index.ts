import type { ReadableStreamReadResult } from "node:stream/web";

import { z } from "zod";

import {
  compareCodePointSequences,
  deepFreezeValue,
  jsonObject,
  utcTimestampSchema,
} from "../core/index.js";
import {
  createStockTokenExecutionSeries,
  findStockTokenExecutionIndexAsset,
  stockTokenExecutionIndexRegistry,
  stockTokenExecutionSeriesLimits,
  unavailableStockTokenExecutionSeries,
  type StockTokenExecutionDayReference,
  type StockTokenExecutionIndexDayAdmission,
  type StockTokenExecutionIndexReadInput,
  type StockTokenExecutionIndexReadPort,
  type StockTokenExecutionSeries,
} from "./stock-token-execution-index.js";
import {
  decodeStockTokenExecutionIndexDay,
  decodeStockTokenExecutionIndexState,
} from "./stock-token-execution-index-artifact.js";

const githubStockTokenExecutionIndexSettings = deepFreezeValue({
  repository: "stelis-dev/robinhood-stock-token-index",
  apiOrigin: "https://api.github.com",
  downloadOrigin: "https://github.com",
  apiVersion: "2022-11-28",
  userAgent: "littlejohn-mcp",
  stateTag: "index-state",
  maximumReleaseAssets: 1_000,
  maximumConcurrentDayReads: 2,
} as const);

const githubReleaseAssetSchema = jsonObject({
  id: z.number().int().positive().safe(),
  name: z.string().min(1).max(256),
  size: z.number().int().nonnegative().max(stockTokenExecutionSeriesLimits.artifactBytes),
}).passthrough();

const githubReleaseSchema = jsonObject({
  tag_name: z.literal(githubStockTokenExecutionIndexSettings.stateTag),
  assets: z.array(githubReleaseAssetSchema)
    .max(githubStockTokenExecutionIndexSettings.maximumReleaseAssets),
}).passthrough().superRefine((value, context) => {
  if (
    new Set(value.assets.map((asset) => asset.id)).size !== value.assets.length ||
    new Set(value.assets.map((asset) => asset.name)).size !== value.assets.length
  ) context.addIssue({ code: "custom", message: "GitHub Release asset identities are ambiguous." });
});

class IndexTransportError extends Error {
  constructor(readonly kind: "unavailable" | "inconsistent") {
    super("Stock Token execution index read failed.");
    this.name = "IndexTransportError";
  }
}

const cancelBody = (response: Response): void => {
  if (response.body !== null) void response.body.cancel().catch(() => undefined);
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
    cancelBody(response);
    throw new IndexTransportError("inconsistent");
  }
  if (response.body === null) throw new IndexTransportError("inconsistent");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      let part: ReadableStreamReadResult<Uint8Array>;
      try { part = await reader.read(); }
      catch { throw new IndexTransportError("unavailable"); }
      if (part.done) break;
      if (signal.aborted) throw new IndexTransportError("unavailable");
      total += part.value.byteLength;
      if (total > maximumBytes) throw new IndexTransportError("inconsistent");
      chunks.push(part.value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  }
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
    throw new IndexTransportError("inconsistent");
  }
};

const dayInterval = (day: string): Readonly<{ start: number; end: number }> => {
  const start = Date.parse(`${day}T00:00:00.000Z`);
  return Object.freeze({ start, end: start + 86_400_000 });
};

export interface GitHubStockTokenExecutionIndexOptions {
  readonly fetchImplementation?: typeof fetch;
}

export const createGitHubStockTokenExecutionIndex = (
  options: GitHubStockTokenExecutionIndexOptions = {},
): StockTokenExecutionIndexReadPort => {
  const fetchImplementation = options.fetchImplementation ?? fetch;

  const request = async (
    target: string,
    maximumBytes: number,
    signal: AbortSignal,
    accept: string,
  ): Promise<Readonly<{ status: number; bytes: Uint8Array }>> => {
    let response: Response;
    try {
      response = await fetchImplementation(target, {
        method: "GET",
        headers: {
          accept,
          "user-agent": githubStockTokenExecutionIndexSettings.userAgent,
          ...(target.startsWith(githubStockTokenExecutionIndexSettings.apiOrigin)
            ? { "x-github-api-version": githubStockTokenExecutionIndexSettings.apiVersion }
            : {}),
        },
        redirect: "follow",
        credentials: "omit",
        signal,
      });
    } catch {
      throw new IndexTransportError("unavailable");
    }
    if (!response.ok) {
      cancelBody(response);
      return Object.freeze({ status: response.status, bytes: new Uint8Array() });
    }
    return Object.freeze({
      status: response.status,
      bytes: await readBoundedBody(response, maximumBytes, signal),
    });
  };

  const readDay = async (
    reference: StockTokenExecutionDayReference,
    signal: AbortSignal,
  ) => {
    const target = `${githubStockTokenExecutionIndexSettings.downloadOrigin}/` +
      `${githubStockTokenExecutionIndexSettings.repository}/releases/download/` +
      `${encodeURIComponent(reference.releaseTag)}/${encodeURIComponent(reference.assetName)}`;
    const response = await request(
      target,
      stockTokenExecutionSeriesLimits.artifactBytes,
      signal,
      "application/octet-stream",
    );
    if (response.status !== 200) throw new IndexTransportError("inconsistent");
    try {
      return deepFreezeValue({
        reference,
        ...decodeStockTokenExecutionIndexDay(response.bytes, reference),
      }) satisfies StockTokenExecutionIndexDayAdmission;
    }
    catch { throw new IndexTransportError("inconsistent"); }
  };

  const read = async (
    inputValue: StockTokenExecutionIndexReadInput,
    callerSignal?: AbortSignal,
  ): Promise<StockTokenExecutionSeries> => {
    const input = Object.freeze({
      token: inputValue.token,
      requestedStart: utcTimestampSchema.parse(inputValue.requestedStart),
      requestedEnd: utcTimestampSchema.parse(inputValue.requestedEnd),
    });
    if (Date.parse(input.requestedStart) >= Date.parse(input.requestedEnd)) {
      throw new TypeError("Stock Token execution-index request interval is invalid.");
    }
    const asset = findStockTokenExecutionIndexAsset(input.token);
    if (asset === undefined) {
      return unavailableStockTokenExecutionSeries(input, "asset_not_indexed");
    }
    const deadlineSignal = AbortSignal.timeout(
      stockTokenExecutionSeriesLimits.requestDeadlineMilliseconds,
    );
    const signal = callerSignal === undefined
      ? deadlineSignal
      : AbortSignal.any([callerSignal, deadlineSignal]);
    try {
      const releaseTarget = `${githubStockTokenExecutionIndexSettings.apiOrigin}/repos/` +
        `${githubStockTokenExecutionIndexSettings.repository}/releases/tags/` +
        githubStockTokenExecutionIndexSettings.stateTag;
      const releaseResponse = await request(
        releaseTarget,
        stockTokenExecutionSeriesLimits.metadataResponseBytes,
        signal,
        "application/vnd.github+json",
      );
      if (releaseResponse.status === 404) {
        return unavailableStockTokenExecutionSeries(input, "index_unavailable");
      }
      if (releaseResponse.status !== 200) throw new IndexTransportError("unavailable");
      let release: z.infer<typeof githubReleaseSchema>;
      try { release = githubReleaseSchema.parse(readJson(releaseResponse.bytes)); }
      catch { throw new IndexTransportError("inconsistent"); }
      const pattern = new RegExp(
        `^${stockTokenExecutionIndexRegistry.groups[0]!.groupId}-state-g([0-9]{16})\\.json\\.gz$`,
        "u",
      );
      const candidates = release.assets.map((candidate) => ({
        candidate,
        match: candidate.name.match(pattern),
      })).filter((entry) => entry.match !== null)
        .sort((left, right) => compareCodePointSequences(left.candidate.name, right.candidate.name));
      if (candidates.length === 0) {
        return unavailableStockTokenExecutionSeries(input, "index_unavailable");
      }
      const selected = candidates.at(-1)!;
      const stateResponse = await request(
        `${githubStockTokenExecutionIndexSettings.apiOrigin}/repos/` +
          `${githubStockTokenExecutionIndexSettings.repository}/releases/assets/${selected.candidate.id}`,
        stockTokenExecutionSeriesLimits.artifactBytes,
        signal,
        "application/octet-stream",
      );
      if (stateResponse.status !== 200) throw new IndexTransportError("unavailable");
      if (stateResponse.bytes.byteLength !== selected.candidate.size) {
        throw new IndexTransportError("inconsistent");
      }
      let stateValue: ReturnType<typeof decodeStockTokenExecutionIndexState>;
      try {
        stateValue = decodeStockTokenExecutionIndexState(
          stateResponse.bytes,
          selected.match![1],
        );
      } catch {
        throw new IndexTransportError("inconsistent");
      }
      const requestedStart = Date.parse(input.requestedStart);
      const requestedEnd = Date.parse(input.requestedEnd);
      const references = stateValue.state.days.filter((reference) => {
        const interval = dayInterval(reference.day);
        return interval.end > requestedStart && interval.start < requestedEnd;
      });
      if (references.length === 0) {
        return unavailableStockTokenExecutionSeries(input, "outside_published_coverage");
      }
      if (references.length > stockTokenExecutionSeriesLimits.dayArtifacts) {
        throw new IndexTransportError("inconsistent");
      }
      const days = new Array<StockTokenExecutionIndexDayAdmission>(references.length);
      let next = 0;
      const worker = async (): Promise<void> => {
        while (next < references.length) {
          const index = next;
          next += 1;
          days[index] = await readDay(references[index]!, signal);
        }
      };
      await Promise.all(Array.from(
        { length: Math.min(references.length, githubStockTokenExecutionIndexSettings.maximumConcurrentDayReads) },
        () => worker(),
      ));
      return createStockTokenExecutionSeries({
        request: input,
        asset,
        state: stateValue.state,
        stateSha256: stateValue.sha256,
        days,
      });
    } catch (error) {
      if (callerSignal?.aborted === true) throw error;
      const kind = error instanceof IndexTransportError ? error.kind : "inconsistent";
      return unavailableStockTokenExecutionSeries(
        input,
        kind === "unavailable" ? "index_unavailable" : "index_inconsistent",
      );
    }
  };

  return Object.freeze({ read });
};
