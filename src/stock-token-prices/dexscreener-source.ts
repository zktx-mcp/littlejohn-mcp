import { z } from "zod";
import type { ReadableStreamReadResult } from "node:stream/web";
import {canonicalJsonStringify, captureCanonicalJson, createObservationAuthorityIssuer, deepFreezeValue, generalSingleLineTextSchema, sourceReferenceSchema, type CanonicalClock} from "../core/index.js";
import {parseEvmAddressInput} from "../evm/address-input.js";
import {productChainId} from "../registry/product-identity.js";
import {productUsdgAsset} from "../registry/product-assets.js";
import {type EvmAddress} from "../evm/identities.js";
import {
  admitPoolCandidateSourceResult, PoolCandidateSourceError,
  type PoolCandidate, type PoolCandidateProtocol,
} from "./source-contract.js";
import type { PoolCandidateSourcePort, PoolCandidateSourceObservation } from "./ports.js";

// Private transport settings. 300/min is the documented token-pairs limit;
// byte/time budgets match the existing untrusted official-list read budget.
const settings = deepFreezeValue({
  sourceOwner: "DEX Screener",
  sourceId: "dexscreener-token-pairs",
  origin: "https://api.dexscreener.com",
  chain: "robinhood",
  path: "/token-pairs/v1",
  responseBytes: 1_048_576,
  deadlineMs: 10_000,
  requestsPerMinute: 300,
});
const rowSchema = z.object({
  chainId: z.string(), dexId: generalSingleLineTextSchema,
  pairAddress: generalSingleLineTextSchema,
  labels: z.array(generalSingleLineTextSchema).nullable().optional(),
  baseToken: z.object({ address: z.string() }),
  quoteToken: z.object({ address: z.string() }),
});

const normalize = (value: unknown, stock: EvmAddress): PoolCandidate[] => {
  const rows = z.array(rowSchema).parse(value);
  const candidates = new Map<string, PoolCandidate>();
  for (const row of rows) {
    if (row.chainId !== settings.chain) throw new PoolCandidateSourceError("source_inconsistent");
    const baseAddress = parseEvmAddressInput(row.baseToken.address);
    const quoteAddress = parseEvmAddressInput(row.quoteToken.address);
    if (!((baseAddress === stock && quoteAddress === productUsdgAsset.address) ||
        (quoteAddress === stock && baseAddress === productUsdgAsset.address))) continue;
    const labels = row.labels ?? [];
    const versions = labels.filter((label) => ["v2", "v3", "v4"].includes(label));
    const protocol = row.dexId === "uniswap" && versions.length === 1
      ? `uniswap_${versions[0]}` as PoolCandidateProtocol : null;
    const poolId = /^0x[0-9a-f]+$/iu.test(row.pairAddress) ? row.pairAddress.toLowerCase() : row.pairAddress;
    const validId = new RegExp(protocol === "uniswap_v4" ? "^0x[0-9a-f]{64}$" : "^0x[0-9a-f]{40}$", "u").test(poolId);
    const candidate: PoolCandidate = {
      poolId, baseAddress, quoteAddress, sourceDexId: row.dexId,
      sourceLabels: labels, protocol,
      status: protocol === null ? "unsupported" : validId ? "candidate" : "invalid",
    };
    const previous = candidates.get(poolId);
    if (previous !== undefined && canonicalJsonStringify(captureCanonicalJson(previous)) !==
        canonicalJsonStringify(captureCanonicalJson(candidate))) {
      throw new PoolCandidateSourceError("source_inconsistent");
    }
    candidates.set(poolId, candidate);
  }
  const result = [...candidates.values()];
  captureCanonicalJson(result);
  return result;
};

export const createDexScreenerPoolCandidateSource = (input: Readonly<{
  clock: CanonicalClock;
  fetch?: typeof fetch;
}>): PoolCandidateSourcePort => {
  const fetcher = input.fetch ?? fetch;
  const sourceUri = `${settings.origin}${settings.path}/${settings.chain}`;
  const issuer = createObservationAuthorityIssuer({
    clock: input.clock, owner: settings.sourceOwner, sourceClass: "web_api",
    referenceKind: "public", sourceId: settings.sourceId,
  });
  const owner = new AbortController();
  const active = new Set<Promise<PoolCandidateSourceObservation>>();
  const starts: number[] = [];
  let closePromise: Promise<void> | undefined;

  const read = async (stock: EvmAddress, signal: AbortSignal): Promise<PoolCandidateSourceObservation> => {
    signal.throwIfAborted();
    owner.signal.throwIfAborted();
    const now = performance.now();
    while (starts.length > 0 && starts[0]! <= now - 60_000) starts.shift();
    if (starts.length >= settings.requestsPerMinute) throw new PoolCandidateSourceError("rate_limited");
    starts.push(now);
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), settings.deadlineMs);
    timer.unref?.();
    const joined = AbortSignal.any([signal, owner.signal, deadline.signal]);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let bodyComplete = false;
    const reference = sourceReferenceSchema.parse({
      kind: "public", sourceId: settings.sourceId, uri: `${sourceUri}/${stock}`,
    });
    try {
      let response: Response;
      try {
        response = await fetcher(`${sourceUri}/${stock}`, {
          method: "GET", headers: { accept: "application/json" },
          credentials: "omit", redirect: "error", signal: joined,
        });
      } catch {
        joined.throwIfAborted();
        throw new PoolCandidateSourceError("source_unavailable");
      }
      if (response.body !== null) reader = response.body.getReader();
      if (response.status === 429) throw new PoolCandidateSourceError("rate_limited");
      if (!response.ok || reader === undefined) throw new PoolCandidateSourceError("source_unavailable");
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        joined.throwIfAborted();
        let next: ReadableStreamReadResult<Uint8Array>;
        try { next = await reader.read(); } catch {
          joined.throwIfAborted();
          throw new PoolCandidateSourceError("source_unavailable");
        }
        if (next.done) { bodyComplete = true; break; }
        size += next.value.byteLength;
        if (size > settings.responseBytes) throw new PoolCandidateSourceError("pool_candidate_response_too_large");
        chunks.push(next.value);
      }
      joined.throwIfAborted();
      const body = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
      let candidates: PoolCandidate[];
      try { candidates = normalize(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)), stock); }
      catch (error) {
        if (error instanceof PoolCandidateSourceError) throw error;
        throw new PoolCandidateSourceError("source_inconsistent");
      }
      const result = admitPoolCandidateSourceResult(stock, {
        chainId: productChainId, stockTokenAddress: stock, quoteAddress: productUsdgAsset.address,
        coverage: "provider_reported", sourceOwner: settings.sourceOwner, reference,
        observedAt: input.clock.now(), candidates,
      });
      return Object.freeze({ result, observationAuthority: issuer.issue(reference) });
    } catch (error) {
      signal.throwIfAborted();
      owner.signal.throwIfAborted();
      if (deadline.signal.aborted) throw new PoolCandidateSourceError("source_unavailable");
      throw error;
    } finally {
      clearTimeout(timer);
      if (reader !== undefined) {
        try {
          // An errored stream rejects cancellation with its stored error. Cleanup
          // must preserve the outcome already classified by this source owner.
          if (!bodyComplete) await reader.cancel().catch(() => undefined);
        } finally { reader.releaseLock(); }
      }
    }
  };
  return Object.freeze({
    observationAuthorityRegistration: issuer.registration,
    read(stock: EvmAddress, signal: AbortSignal) {
      const pending = read(stock, signal);
      active.add(pending);
      void pending.then(() => active.delete(pending), () => active.delete(pending));
      return pending;
    },
    close() {
      if (closePromise !== undefined) return closePromise;
      owner.abort();
      closePromise = Promise.allSettled([...active]).then(() => undefined);
      return closePromise;
    },
  });
};
