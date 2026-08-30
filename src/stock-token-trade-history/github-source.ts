import type { ReadableStreamDefaultReader, ReadableStreamReadResult } from "node:stream/web";

import type {
  StockTokenTradeHistoryCatalogAssetFact,
  StockTokenTradeHistoryCatalogFacts,
  StockTokenTradeHistoryCompleteObjectFacts,
  StockTokenTradeHistoryProviderOutcome,
  StockTokenTradeHistoryProviderTransport,
  StockTokenTradeHistoryRangeFacts,
} from "./source-contract.js";
import {
  stockTokenTradeHistorySourceContract,
  StockTokenTradeHistoryProviderCleanupError,
  type StockTokenTradeHistorySourcePort,
} from "./source-contract.js";
import { createStockTokenTradeHistorySource } from "./source.js";

const githubSourceSettings = Object.freeze({
  apiOrigin: "https://api.github.com",
  downloadOrigin: "https://github.com",
  repository: stockTokenTradeHistorySourceContract.owner,
  catalogTag: "market-data-catalog",
  apiVersion: "2022-11-28",
  userAgent: "littlejohn-mcp",
  assetsPerPage: 100,
} as const);

type Fetch = typeof fetch;

export interface GitHubStockTokenTradeHistoryTransportDependencies {
  readonly fetch?: Fetch;
}

export interface GitHubStockTokenTradeHistorySourceDependencies {
  readonly fetch?: Fetch;
  readonly now?: () => Date;
}

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException("The operation was aborted.", "AbortError");

const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted) throw abortReason(signal);
};

const discardBody = async (response: Response): Promise<void> => {
  if (response.body === null) return;
  try {
    await response.body.cancel();
  } catch (error) {
    throw new StockTokenTradeHistoryProviderCleanupError([error]);
  }
};

const closeReader = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  cancel: boolean,
): Promise<void> => {
  const failures: unknown[] = [];
  if (cancel) {
    try {
      await reader.cancel();
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    reader.releaseLock();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length !== 0) throw new StockTokenTradeHistoryProviderCleanupError(failures);
};

type BoundedBodyResult =
  | Readonly<{ readonly status: "read"; readonly bytes: Uint8Array }>
  | Readonly<{ readonly status: "unavailable" }>
  | Readonly<{ readonly status: "capacity_exceeded" }>;

const readBoundedBody = async (
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<BoundedBodyResult> => {
  throwIfAborted(signal);
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(contentLength)) {
      await discardBody(response);
      return Object.freeze({ status: "unavailable" });
    }
    if (BigInt(contentLength) > BigInt(maximumBytes)) {
      await discardBody(response);
      return Object.freeze({ status: "capacity_exceeded" });
    }
  }
  if (response.body === null) return Object.freeze({ status: "unavailable" });
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch (error) {
    try {
      await discardBody(response);
    } catch (cleanupError) {
      throw new StockTokenTradeHistoryProviderCleanupError([error, cleanupError]);
    }
    throw error;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let cancelReader = true;
  let terminal: BoundedBodyResult | undefined;
  let primaryFailure: unknown;
  try {
    while (true) {
      throwIfAborted(signal);
      let part: ReadableStreamReadResult<Uint8Array>;
      try {
        part = await reader.read();
      } catch (error) {
        cancelReader = false;
        if (signal.aborted) throw abortReason(signal);
        terminal = Object.freeze({ status: "unavailable" });
        break;
      }
      if (part.done) {
        cancelReader = false;
        break;
      }
      if (!(part.value instanceof Uint8Array)) {
        terminal = Object.freeze({ status: "unavailable" });
        break;
      }
      total += part.value.byteLength;
      if (total > maximumBytes) {
        terminal = Object.freeze({ status: "capacity_exceeded" });
        break;
      }
      chunks.push(part.value);
    }
  } catch (error) {
    primaryFailure = error;
  } finally {
    try {
      await closeReader(reader, cancelReader);
    } catch (cleanupError) {
      if (primaryFailure !== undefined) {
        throw new StockTokenTradeHistoryProviderCleanupError([primaryFailure, cleanupError]);
      }
      throw cleanupError;
    }
  }
  if (primaryFailure !== undefined) throw primaryFailure;
  if (terminal !== undefined) return terminal;
  throwIfAborted(signal);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return Object.freeze({ status: "read", bytes });
};

const rateLimited = (response: Response): boolean =>
  response.status === 429 ||
  response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0";

const publicHeaders = (): Readonly<Record<string, string>> => Object.freeze({
  "accept": "application/vnd.github+json",
  "accept-encoding": "identity",
  "user-agent": githubSourceSettings.userAgent,
  "x-github-api-version": githubSourceSettings.apiVersion,
});

const downloadHeaders = (range?: string): Readonly<Record<string, string>> => Object.freeze({
  "accept-encoding": "identity",
  "user-agent": githubSourceSettings.userAgent,
  ...(range === undefined ? {} : { range }),
});

const identityEncoding = (response: Response): boolean => {
  const encoding = response.headers.get("content-encoding");
  return encoding === null || encoding.toLowerCase() === "identity";
};

const parseJson = (bytes: Uint8Array): unknown => {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
};

const normalizedCatalogAsset = (
  value: unknown,
): Readonly<{ readonly asset: StockTokenTradeHistoryCatalogAssetFact | null }> | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Readonly<Record<string, unknown>>;
  return typeof record["name"] === "string" &&
      record["name"].length > 0 &&
      record["name"].length <= 256 &&
      typeof record["size"] === "number" &&
      Number.isSafeInteger(record["size"]) &&
      record["size"] >= 0 &&
      typeof record["state"] === "string"
    ? Object.freeze({
        asset: record["state"] === "uploaded"
          ? Object.freeze({ name: record["name"], bytes: record["size"] })
          : null,
      })
    : undefined;
};

const normalizedReleaseId = (value: unknown): number | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const id = (value as Readonly<Record<string, unknown>>)["id"];
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : undefined;
};

const fetchResponse = async (
  fetchImplementation: Fetch,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response | undefined> => {
  throwIfAborted(signal);
  try {
    return await fetchImplementation(url, { ...init, signal });
  } catch (error) {
    if (signal.aborted) throw abortReason(signal);
    return undefined;
  }
};

const providerFailure = async <Value>(
  response: Response,
  absentOnNotFound: boolean,
): Promise<StockTokenTradeHistoryProviderOutcome<Value>> => {
  const absent = absentOnNotFound && response.status === 404;
  const limited = rateLimited(response);
  await discardBody(response);
  return Object.freeze({
    status: absent ? "absent" : limited ? "rate_limited" : "unavailable",
  }) as StockTokenTradeHistoryProviderOutcome<Value>;
};

const normalizedRedirect = (response: Response): string | undefined => {
  const location = response.headers.get("location");
  if (location === null) return undefined;
  try {
    const target = response.url === "" ? new URL(location) : new URL(location, response.url);
    return target.protocol === "https:" &&
      target.username === "" &&
      target.password === ""
      ? target.href
      : undefined;
  } catch {
    return undefined;
  }
};

const fetchDownload = async (
  fetchImplementation: Fetch,
  url: string,
  headers: Readonly<Record<string, string>>,
  maximumRedirects: number,
  signal: AbortSignal,
): Promise<Response | undefined> => {
  let current = url;
  for (let redirects = 0; ; redirects += 1) {
    const response = await fetchResponse(
      fetchImplementation,
      current,
      { method: "GET", headers, redirect: "manual" },
      signal,
    );
    if (response === undefined) return undefined;
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    if (redirects >= maximumRedirects) {
      await discardBody(response);
      return undefined;
    }
    const next = normalizedRedirect(response);
    await discardBody(response);
    if (next === undefined) return undefined;
    current = next;
  }
};

const downloadUrl = (releaseTag: string, assetName: string): string =>
  `${githubSourceSettings.downloadOrigin}/${githubSourceSettings.repository}/releases/download/` +
  `${encodeURIComponent(releaseTag)}/${encodeURIComponent(assetName)}`;

const contentRange = (
  value: string | null,
): StockTokenTradeHistoryRangeFacts["range"] => {
  const match = value?.match(/^bytes (0|[1-9][0-9]*)-(0|[1-9][0-9]*)\/(0|[1-9][0-9]*)$/u);
  if (match === undefined || match === null) return null;
  const from = Number(match[1]);
  const inclusiveUntil = Number(match[2]);
  const assetBytes = Number(match[3]);
  return Number.isSafeInteger(from) &&
      Number.isSafeInteger(inclusiveUntil) &&
      Number.isSafeInteger(assetBytes) &&
      from >= 0 &&
      inclusiveUntil >= from &&
      assetBytes > inclusiveUntil
    ? Object.freeze({ from, until: inclusiveUntil + 1, assetBytes })
    : null;
};

export const createGitHubStockTokenTradeHistoryTransport = (
  dependencies: GitHubStockTokenTradeHistoryTransportDependencies,
): StockTokenTradeHistoryProviderTransport => {
  const fetchImplementation = dependencies.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw new TypeError("GitHub Stock Token trade-history fetch is unavailable.");
  }

  const readCatalog = async (
    maximumResponseBytes: number,
    maximumTotalBytes: number,
    maximumAssets: number,
    signal: AbortSignal,
  ): Promise<StockTokenTradeHistoryProviderOutcome<StockTokenTradeHistoryCatalogFacts>> => {
    const releaseUrl = `${githubSourceSettings.apiOrigin}/repos/${githubSourceSettings.repository}/releases/tags/` +
      encodeURIComponent(githubSourceSettings.catalogTag);
    const releaseResponse = await fetchResponse(
      fetchImplementation,
      releaseUrl,
      { method: "GET", headers: publicHeaders(), redirect: "error" },
      signal,
    );
    if (releaseResponse === undefined) return Object.freeze({ status: "unavailable" });
    if (releaseResponse.status !== 200) return providerFailure(releaseResponse, true);
    const releaseBody = await readBoundedBody(
      releaseResponse,
      Math.min(maximumResponseBytes, maximumTotalBytes),
      signal,
    );
    if (releaseBody.status !== "read") return releaseBody;
    let transferredBytes = releaseBody.bytes.byteLength;
    if (transferredBytes > maximumTotalBytes) return Object.freeze({ status: "capacity_exceeded" });
    const releaseId = normalizedReleaseId(parseJson(releaseBody.bytes));
    if (releaseId === undefined) return Object.freeze({ status: "unavailable" });

    const assets: StockTokenTradeHistoryCatalogAssetFact[] = [];
    let assetCount = 0;
    for (let page = 1; ; page += 1) {
      const pageUrl = `${githubSourceSettings.apiOrigin}/repos/${githubSourceSettings.repository}/releases/` +
        `${releaseId}/assets?per_page=${githubSourceSettings.assetsPerPage}&page=${page}`;
      const response = await fetchResponse(
        fetchImplementation,
        pageUrl,
        { method: "GET", headers: publicHeaders(), redirect: "error" },
        signal,
      );
      if (response === undefined) return Object.freeze({ status: "unavailable" });
      if (response.status !== 200) return providerFailure(response, false);
      const body = await readBoundedBody(
        response,
        Math.min(maximumResponseBytes, Math.max(0, maximumTotalBytes - transferredBytes)),
        signal,
      );
      if (body.status !== "read") return body;
      transferredBytes += body.bytes.byteLength;
      if (transferredBytes > maximumTotalBytes) return Object.freeze({ status: "capacity_exceeded" });
      const parsed = parseJson(body.bytes);
      if (!Array.isArray(parsed) || parsed.length > githubSourceSettings.assetsPerPage) {
        return Object.freeze({ status: "unavailable" });
      }
      for (const value of parsed) {
        const normalized = normalizedCatalogAsset(value);
        if (normalized === undefined) return Object.freeze({ status: "unavailable" });
        assetCount += 1;
        if (assetCount > maximumAssets) {
          return Object.freeze({
            status: "read",
            value: Object.freeze({
              assets: Object.freeze(assets),
              overflow: true,
              transferredBytes,
            }),
          });
        }
        if (normalized.asset !== null) assets.push(normalized.asset);
      }
      if (parsed.length < githubSourceSettings.assetsPerPage) {
        return Object.freeze({
          status: "read",
          value: Object.freeze({ assets: Object.freeze(assets), overflow: false, transferredBytes }),
        });
      }
    }
  };

  const readRoot = async (
    name: string,
    maximumBytes: number,
    signal: AbortSignal,
  ): Promise<StockTokenTradeHistoryProviderOutcome<StockTokenTradeHistoryCompleteObjectFacts>> => {
    const response = await fetchDownload(
      fetchImplementation,
      downloadUrl(githubSourceSettings.catalogTag, name),
      downloadHeaders(),
      stockTokenTradeHistorySourceContract.maximumRedirects,
      signal,
    );
    if (response === undefined) return Object.freeze({ status: "unavailable" });
    if (response.status !== 200) return providerFailure(response, true);
    const body = await readBoundedBody(response, maximumBytes, signal);
    if (body.status !== "read") return body;
    return Object.freeze({
      status: "read",
      value: Object.freeze({
        bytes: body.bytes,
        identityEncoding: identityEncoding(response),
      }),
    });
  };

  const readMember = async (
    input: Readonly<{
      readonly releaseTag: string;
      readonly assetName: string;
      readonly from: number;
      readonly until: number;
      readonly maximumBytes: number;
    }>,
    signal: AbortSignal,
  ): Promise<StockTokenTradeHistoryProviderOutcome<StockTokenTradeHistoryRangeFacts>> => {
    const range = `bytes=${input.from}-${input.until - 1}`;
    const response = await fetchDownload(
      fetchImplementation,
      downloadUrl(input.releaseTag, input.assetName),
      downloadHeaders(range),
      stockTokenTradeHistorySourceContract.maximumRedirects,
      signal,
    );
    if (response === undefined) return Object.freeze({ status: "unavailable" });
    if (response.status === 200) {
      await discardBody(response);
      return Object.freeze({ status: "unavailable" });
    }
    if (response.status !== 206) return providerFailure(response, true);
    const body = await readBoundedBody(response, input.maximumBytes, signal);
    if (body.status !== "read") return body;
    return Object.freeze({
      status: "read",
      value: Object.freeze({
        bytes: body.bytes,
        identityEncoding: identityEncoding(response),
        range: contentRange(response.headers.get("content-range")),
      }),
    });
  };

  return Object.freeze({ readCatalog, readRoot, readMember });
};

export const createGitHubStockTokenTradeHistorySource = (
  dependencies: GitHubStockTokenTradeHistorySourceDependencies,
): StockTokenTradeHistorySourcePort => {
  return createStockTokenTradeHistorySource({
    transport: createGitHubStockTokenTradeHistoryTransport({
      ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
    }),
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  });
};
