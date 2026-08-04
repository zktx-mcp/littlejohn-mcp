import { describe, expect, it } from "vitest";

import {
  createReferenceMarketCallEncoder,
  createReferenceMarketChainReadPort,
  type ReferenceHistoryTraversal,
  type ReferenceMarketChainReadPort,
} from "../../src/chain/reference-market.js";
import {
  resolveConfiguredCanonicalBlock,
  type CanonicalBlock,
} from "../../src/chain/canonical-block.js";
import { getChainOperationFailure } from "../../src/chain/errors.js";
import { createChainInvocationLifecycle } from "../../src/chain/invocation-lifecycle.js";
import type { ChainInvocationContext } from "../../src/chain/invocation-lifecycle.js";
import {
  ChainRpcError,
  createBoundedRpcRequester,
  type ChainRpcMethod,
  type RpcRequester,
} from "../../src/chain/rpc.js";
import {
  chainAnchorSchema,
  createCanonicalClock,
  createExactRational,
  createObservationAuthority,
  createReferenceHistoryWorkPlan,
  findReferenceFeed,
  parseEvmAddress,
  parseEvmChainId,
  referenceCompositeRoundIdSchema,
  referenceFeedTraversalStateSchema,
  referenceRoundObservationSchema,
  sourceReferenceSchema,
  type ChainAnchor,
} from "../../src/core/index.js";

const ethProxy = parseEvmAddress("0x78f3556b67e17df817d51ef5a990cdaf09e8d3a9");
const usdgProxy = parseEvmAddress("0x61b7e5650328764b076a108eff5fa7282a1b9ad2");
const blockHash = `0x${"11".repeat(32)}`;
const readObservedAt = "2026-07-22T00:00:05.000Z";
const rpcConfigurationDigest = "A".repeat(43);
const compositeRoundId = (phase: bigint, aggregatorRound: bigint): string =>
  ((phase << 64n) | aggregatorRound).toString(10);
const word = (value: bigint): string => {
  const unsigned = value < 0n ? (1n << 256n) + value : value;
  return unsigned.toString(16).padStart(64, "0");
};
const encodedText = (value: string): string => {
  const bytes = Buffer.from(value, "utf8");
  const padding = (32 - bytes.length % 32) % 32;
  return `0x${word(32n)}${word(BigInt(bytes.length))}${bytes.toString("hex")}${"0".repeat(padding * 2)}`;
};
const encodedRoundFields = (input: Readonly<{
  roundId: bigint;
  answer: bigint;
  startedAt: bigint;
  updatedAt: bigint;
  answeredInRound?: bigint;
}>): string => `0x${[
  input.roundId,
  input.answer,
  input.startedAt,
  input.updatedAt,
  input.answeredInRound ?? input.roundId,
].map(word).join("")}`;
const encodedRound = (
  roundId: bigint,
  answer: bigint,
  updatedAt = 1_784_592_000n,
): string => encodedRoundFields({
  roundId,
  answer,
  startedAt: updatedAt - 10n,
  updatedAt,
});

const currentBlock = chainAnchorSchema.parse({
  chainId: "eip155:4663",
  blockNumber: "42",
  blockHash,
  blockTimestamp: "2026-07-22T00:00:00.000Z",
}) as ChainAnchor;

const historyObservation = (
  roundId: string,
  updatedAtUnixSeconds = 1_784_592_000n,
) => {
  const feed = findReferenceFeed("eth_usd");
  return referenceRoundObservationSchema.parse({
    fact: {
      manifestVersion: 1,
      feedId: feed.feedId,
      proxyAddress: feed.standardProxy,
      decimals: feed.decimals,
      roundId,
      answeredInRound: roundId,
      answer: "300000000000",
      startedAtUnixSeconds: (updatedAtUnixSeconds - 10n).toString(10),
      updatedAtUnixSeconds: updatedAtUnixSeconds.toString(10),
      value: createExactRational(3_000n, 1n),
    },
    readEvidence: {
      observedAt: readObservedAt,
      sourceOwner: "user_configured",
      sourceClass: "chain_rpc",
      sourceReference: {
        kind: "configured_rpc",
        sourceId: `rpc:${rpcConfigurationDigest}`,
        publicOrigin: "https://rpc.example",
        configurationDigest: rpcConfigurationDigest,
      },
      block: currentBlock,
    },
  });
};

class LatestRequester implements RpcRequester {
  constructor(
    private readonly future = false,
    private readonly roundIdOverride?: bigint,
    private readonly roundResultOverride?: string,
  ) {}

  async request<Method extends ChainRpcMethod>(
    method: Method,
    params: Parameters<RpcRequester["request"]>[1],
    _signal: AbortSignal,
  ): Promise<unknown> {
    if (method === "eth_chainId") return "0x1237";
    if (method === "eth_getBlockByNumber") {
      return { number: "0x2a", hash: blockHash, timestamp: "0x6a600800" };
    }
    if (method === "eth_getCode") return "0x6000";
    if (method !== "eth_call") throw new Error(`Unexpected RPC method: ${method}`);
    const call = params[0] as { readonly to: string; readonly data: string };
    if (call.data === "0x7284e416") return encodedText(call.to === ethProxy ? "ETH / USD" : "USDG / USD");
    if (call.data === "0x313ce567") return `0x${word(8n)}`;
    if (call.data === "0xfeaf968c") {
      if (this.roundResultOverride !== undefined) return this.roundResultOverride;
      const roundId = this.roundIdOverride ??
        (call.to === ethProxy ? 18_446_744_073_709_551_617n : 18_446_744_073_709_551_618n);
      const answer = call.to === ethProxy ? 300_000_000_000n : 100_000_000n;
      return encodedRound(roundId, answer, this.future ? 1_784_678_401n : 1_784_592_000n);
    }
    throw new Error(`Unexpected RPC call: ${call.data}`);
  }
}

const createObservationContext = () => {
  const clock = createCanonicalClock(() => readObservedAt);
  return Object.freeze({
    clock,
    observationAuthority: createObservationAuthority({
      clock,
      sourceClass: "chain_rpc",
      owner: "user_configured",
      reference: sourceReferenceSchema.parse({
        kind: "configured_rpc",
        sourceId: `rpc:${rpcConfigurationDigest}`,
        publicOrigin: "https://rpc.example",
        configurationDigest: rpcConfigurationDigest,
      }),
    }),
  });
};

const createPort = (rpc: RpcRequester) => {
  const lifecycle = createChainInvocationLifecycle(new AbortController().signal);
  const observationContext = createObservationContext();
  const port = createReferenceMarketChainReadPort({
    rpc,
    encoder: createReferenceMarketCallEncoder(),
    chainId: parseEvmChainId("eip155:4663"),
    lifecycle,
    ...observationContext,
  });
  const issueBlock = (context: ChainInvocationContext): Promise<CanonicalBlock> =>
    resolveConfiguredCanonicalBlock({
      rpc: {
        async request(method) {
          if (method === "eth_chainId") return "0x1237";
          if (method === "eth_getBlockByNumber") {
            return { number: "0x2a", hash: blockHash, timestamp: "0x6a600800" };
          }
          throw new Error(`Unexpected block fixture method: ${method}`);
        },
      },
      chainId: parseEvmChainId("eip155:4663"),
      selector: { kind: "latest" },
      context,
    });
  const runAtBlock = <Result>(
    operation: (block: CanonicalBlock, context: ChainInvocationContext) => Promise<Result>,
  ): Promise<Result> => lifecycle.run(
    new AbortController().signal,
    async (context) => operation(await issueBlock(context), context),
  );
  return {
    lifecycle,
    port,
    latest(feedIds: Parameters<ReferenceMarketChainReadPort["readLatestAtBlock"]>[0]) {
      return lifecycle.run(new AbortController().signal, async (context) => {
        const block = await port.resolveCurrentBlock(context);
        return Object.freeze({
          block,
          observations: await port.readLatestAtBlock(feedIds, block, context),
        });
      });
    },
    latestAtIssuedBlock(feedIds: Parameters<ReferenceMarketChainReadPort["readLatestAtBlock"]>[0]) {
      return runAtBlock((block, context) => port.readLatestAtBlock(feedIds, block, context));
    },
    readHistory(
      input: Omit<Parameters<ReferenceMarketChainReadPort["readHistoryAtBlock"]>[0], "block">,
    ): Promise<ReferenceHistoryTraversal> {
      return runAtBlock((block, context) =>
        port.readHistoryAtBlock({ ...input, block }, context));
    },
  };
};

describe("reference market chain reads", () => {
  it("uses the reviewed standard-proxy selectors and canonical uint80 encoding", () => {
    const encoder = createReferenceMarketCallEncoder();
    expect(encoder.description()).toBe("0x7284e416");
    expect(encoder.decimals()).toBe("0x313ce567");
    expect(encoder.latestRoundData()).toBe("0xfeaf968c");
    expect(encoder.getRoundData("1")).toBe(`0x9a6fc8f5${"0".repeat(63)}1`);
    expect(() => encoder.getRoundData("0")).toThrow("Reference round ID is invalid.");
    expect(() => encoder.getRoundData((1n << 80n).toString(10)))
      .toThrow("Reference round ID is invalid.");
  });

  it("binds latest observations to one canonical block and rejects future evidence", async () => {
    const active = createPort(new LatestRequester());
    const { block, observations } = await active.latest(["eth_usd", "usdg_usd"]);
    expect(block.anchor).toEqual(currentBlock);
    expect(observations.map((observation) => ({
      feedId: observation.fact.feedId,
      roundId: observation.fact.roundId,
      value: observation.fact.value,
      observedAt: observation.readEvidence.observedAt,
    }))).toEqual([{
      feedId: "eth_usd",
      roundId: "18446744073709551617",
      value: { numerator: "3000", denominator: "1" },
      observedAt: readObservedAt,
    }, {
      feedId: "usdg_usd",
      roundId: "18446744073709551618",
      value: { numerator: "1", denominator: "1" },
      observedAt: readObservedAt,
    }]);
    await active.lifecycle.close();

    const future = createPort(new LatestRequester(true));
    try {
      await future.latest(["eth_usd"]);
      throw new Error("Expected future evidence rejection.");
    } catch (error) {
      expect(getChainOperationFailure(error)?.error.code).toBe("source_inconsistent");
    }
    await future.lifecycle.close();
  });

  it("rejects zero composite-round components at latest, pointer, cutoff, and history admission", async () => {
    const invalidRoundIds = [1n, 1n << 64n] as const;
    for (const invalidRoundId of invalidRoundIds) {
      const latest = createPort(new LatestRequester(false, invalidRoundId));
      await expect(latest.latestAtIssuedBlock(["eth_usd"]))
        .rejects.toMatchObject({ failure: { error: { code: "source_inconsistent" } } });
      await latest.lifecycle.close();
    }

    let historicalReads = 0;
    const history = createPort({
      async request() {
        historicalReads += 1;
        throw new Error("Invalid history identity must fail before state RPC.");
      },
    });
    const validRoundId = ((1n << 64n) | 2n).toString(10);
    const base = {
      feedId: "eth_usd" as const,
      latestRoundId: validRoundId,
      knownObservations: [],
      backfillPhaseId: null,
      backfillNextRoundId: null,
      backfillStatus: null,
      retentionCutoffRoundId: null,
      stopAtOrBeforeUnixSeconds: "1",
    };
    for (const invalidRoundId of invalidRoundIds.map((value) => value.toString(10))) {
      await expect(history.readHistory({
        ...base,
        latestRoundId: invalidRoundId,
      })).rejects.toThrow(TypeError);
      await expect(history.readHistory({
        ...base,
        backfillPhaseId: "1",
        backfillNextRoundId: invalidRoundId,
      })).rejects.toThrow(TypeError);
      await expect(history.readHistory({
        ...base,
        backfillPhaseId: "1",
        backfillStatus: "retention_boundary",
        retentionCutoffRoundId: invalidRoundId,
      })).rejects.toThrow(TypeError);
    }
    expect(historicalReads).toBe(0);
    await history.lifecycle.close();
  });

  it("keeps batch item order and leaves a reverted continuation candidate retryable", async () => {
    const firstRound = "18446744073709551618";
    const secondRound = "18446744073709551617";
    const requestedBatches: string[][] = [];
    const requester = createBoundedRpcRequester({
      url: "https://rpc.example",
      fetch: (async (_input, init) => {
        if (typeof init?.body !== "string") throw new TypeError("Expected a request body.");
        const requests = JSON.parse(init.body) as Array<{
          readonly id: string;
          readonly params: Array<{ readonly data: string }>;
        }>;
        requestedBatches.push(requests.map((request) =>
          BigInt(`0x${request.params[0]!.data.slice(-64)}`).toString(10)));
        if (requestedBatches.length > 1) {
          return new Response(JSON.stringify(requests.map((request) => ({
            jsonrpc: "2.0",
            id: request.id,
            error: { code: 3, message: "execution reverted", data: "0x" },
          }))));
        }
        return new Response(JSON.stringify([{
          jsonrpc: "2.0",
          id: requests[1]!.id,
          error: { code: 3, message: "execution reverted", data: "0x" },
        }, {
          jsonrpc: "2.0",
          id: requests[0]!.id,
          result: encodedRound(BigInt(firstRound), 300_000_000_000n),
        }]));
      }) as typeof fetch,
    });
    const active = createPort(requester);
    const result = await active.readHistory({
      feedId: "eth_usd",
      latestRoundId: (BigInt(firstRound) + 1n).toString(10),
      knownObservations: [],
      backfillPhaseId: "1",
      backfillNextRoundId: firstRound,
      backfillStatus: null,
      retentionCutoffRoundId: null,
      stopAtOrBeforeUnixSeconds: "1",
    });
    expect(result).toMatchObject({
      observations: [{ fact: { roundId: firstRound } }],
      backfillNextRoundId: secondRound,
      backfillStatus: null,
      phaseBoundaryObserved: true,
      malformedRoundObserved: false,
      failure: undefined,
    });
    expect(requestedBatches).toEqual([[firstRound, secondRound]]);
    await active.lifecycle.close();
  });

  it("falls back to the same logical calls singly when a provider rejects JSON-RPC batches", async () => {
    const roundIds = ["18446744073709551618", "18446744073709551617"];
    let fetches = 0;
    const requester = createBoundedRpcRequester({
      url: "https://rpc.example",
      fetch: (async (_input, init) => {
        fetches += 1;
        if (typeof init?.body !== "string") throw new TypeError("Expected a request body.");
        const request = JSON.parse(init.body) as unknown;
        if (Array.isArray(request)) {
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32600, message: "batch unsupported" },
          }));
        }
        const single = request as { readonly id: string; readonly params: Array<{ readonly data: string }> };
        const requested = BigInt(`0x${single.params[0]!.data.slice(-64)}`);
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: single.id,
          result: encodedRound(requested, 300_000_000_000n),
        }));
      }) as typeof fetch,
    });
    const active = createPort(requester);
    const result = await active.readHistory({
      feedId: "eth_usd",
      latestRoundId: (BigInt(roundIds[0]!) + 1n).toString(10),
      knownObservations: [],
      backfillPhaseId: "1",
      backfillNextRoundId: roundIds[0]!,
      backfillStatus: null,
      retentionCutoffRoundId: null,
      stopAtOrBeforeUnixSeconds: "1",
    });
    expect(result.observations.map((entry) => entry.fact.roundId)).toEqual(roundIds);
    expect(result).toMatchObject({
      backfillNextRoundId: null,
      backfillStatus: "phase_boundary",
      phaseBoundaryObserved: true,
      malformedRoundObserved: false,
      failure: undefined,
    });
    expect(fetches).toBe(3);
    await active.lifecycle.close();
  });

  it("executes bracketed and virtual-boundary gaps in greatest-candidate order", async () => {
    const requested: string[] = [];
    const requester: RpcRequester = {
      async request(_method, params) {
        const data = (params[0] as { readonly data: string }).data;
        const roundId = BigInt(`0x${data.slice(-64)}`);
        requested.push(roundId.toString(10));
        return encodedRound(roundId, 300_000_000_000n);
      },
    };
    const active = createPort(requester);
    const phaseOne = 1n << 64n;
    const middle = await active.readHistory({
      feedId: "eth_usd",
      latestRoundId: (phaseOne | 6n).toString(10),
      knownObservations: [historyObservation((phaseOne | 3n).toString(10), 11n)],
      backfillPhaseId: "1",
      backfillNextRoundId: null,
      backfillStatus: "phase_boundary",
      retentionCutoffRoundId: null,
      stopAtOrBeforeUnixSeconds: "11",
    });
    expect(middle.observations.map((entry) => entry.fact.roundId)).toEqual([
      (phaseOne | 5n).toString(10),
      (phaseOne | 4n).toString(10),
      (phaseOne | 2n).toString(10),
      (phaseOne | 1n).toString(10),
    ]);
    expect(requested).toEqual(middle.observations.map((entry) => entry.fact.roundId));
    expect(middle).toMatchObject({
      backfillNextRoundId: null,
      backfillStatus: "phase_boundary",
      phaseBoundaryObserved: true,
      malformedRoundObserved: false,
      failure: undefined,
    });
    await active.lifecycle.close();
  });

  it("keeps a new-phase tail and an older continuation as separate ordered work", async () => {
    const requested: string[] = [];
    const active = createPort({
      async request(_method, params) {
        const data = (params[0] as { readonly data: string }).data;
        const roundId = BigInt(`0x${data.slice(-64)}`);
        requested.push(roundId.toString(10));
        return encodedRound(roundId, 300_000_000_000n);
      },
    });
    const phaseOne = 1n << 64n;
    const phaseTwo = 2n << 64n;
    const result = await active.readHistory({
      feedId: "eth_usd",
      latestRoundId: (phaseTwo | 3n).toString(10),
      knownObservations: [historyObservation((phaseOne | 6n).toString(10))],
      backfillPhaseId: "1",
      backfillNextRoundId: (phaseOne | 5n).toString(10),
      backfillStatus: null,
      retentionCutoffRoundId: null,
      stopAtOrBeforeUnixSeconds: "1",
    });
    const expected = [
      (phaseTwo | 2n).toString(10),
      (phaseTwo | 1n).toString(10),
      (phaseOne | 5n).toString(10),
      (phaseOne | 4n).toString(10),
      (phaseOne | 3n).toString(10),
      (phaseOne | 2n).toString(10),
      (phaseOne | 1n).toString(10),
    ];
    expect(requested).toEqual(expected);
    expect(result.observations.map((entry) => entry.fact.roundId)).toEqual(expected);
    expect(result).toMatchObject({
      backfillPhaseId: "1",
      backfillNextRoundId: null,
      backfillStatus: "phase_boundary",
      phaseBoundaryObserved: true,
      malformedRoundObserved: false,
      failure: undefined,
    });
    await active.lifecycle.close();
  });

  it("keeps every history batch inside the supplied invocation and RPC concurrency bound", async () => {
    let activeCalls = 0;
    let maximumActiveCalls = 0;
    const requester: RpcRequester = {
      async request(_method, params) {
        activeCalls += 1;
        maximumActiveCalls = Math.max(maximumActiveCalls, activeCalls);
        try {
          await new Promise((resolve) => setTimeout(resolve, 1));
          const data = (params[0] as { readonly data: string }).data;
          const roundId = BigInt(`0x${data.slice(-64)}`);
          return encodedRound(roundId, 300_000_000_000n);
        } finally {
          activeCalls -= 1;
        }
      },
    };
    const firstRoundId = ((1n << 64n) | 33n).toString(10);
    const active = createPort(requester);
    const result = await active.readHistory({
      feedId: "eth_usd",
      latestRoundId: (BigInt(firstRoundId) + 1n).toString(10),
      knownObservations: [],
      backfillPhaseId: "1",
      backfillNextRoundId: firstRoundId,
      backfillStatus: null,
      retentionCutoffRoundId: null,
      stopAtOrBeforeUnixSeconds: "1",
    });
    expect(result.observations).toHaveLength(33);
    expect(result).toMatchObject({
      backfillNextRoundId: null,
      backfillStatus: "phase_boundary",
      phaseBoundaryObserved: true,
      malformedRoundObserved: false,
      failure: undefined,
    });
    expect(maximumActiveCalls).toBe(16);
    await active.lifecycle.close();
  });

  it("shares one probe budget between head-gap repair and older backfill", async () => {
    let probes = 0;
    const requester: RpcRequester = {
      async request(_method, params) {
        probes += 1;
        const data = (params[0] as { readonly data: string }).data;
        const roundId = BigInt(`0x${data.slice(-64)}`);
        return encodedRound(roundId, 300_000_000_000n);
      },
    };
    const active = createPort(requester);
    const latestPhase = 2n << 64n;
    const backfillPhase = 1n << 64n;
    const result = await active.readHistory({
      feedId: "eth_usd",
      latestRoundId: (latestPhase | 3n).toString(10),
      knownObservations: [historyObservation((latestPhase | 1n).toString(10))],
      backfillPhaseId: "1",
      backfillNextRoundId: (backfillPhase | 2_000n).toString(10),
      backfillStatus: null,
      retentionCutoffRoundId: null,
      stopAtOrBeforeUnixSeconds: "1",
    });
    expect(probes).toBe(1_024);
    expect(result).toMatchObject({
      phaseBoundaryObserved: false,
      malformedRoundObserved: false,
      failure: undefined,
    });
    await active.lifecycle.close();
  });

  it("continues an over-budget new phase tail on the next explicit request", async () => {
    const requester: RpcRequester = {
      async request(_method, params) {
        const data = (params[0] as { readonly data: string }).data;
        const roundId = BigInt(`0x${data.slice(-64)}`);
        return encodedRound(roundId, 300_000_000_000n);
      },
    };
    const active = createPort(requester);
    const oldPhase = 1n << 64n;
    const newPhase = 2n << 64n;
    const latestRoundId = (newPhase | 1_026n).toString(10);
    const first = await active.readHistory({
      feedId: "eth_usd",
      latestRoundId,
      knownObservations: [historyObservation((oldPhase | 1n).toString(10))],
      backfillPhaseId: "1",
      backfillNextRoundId: null,
      backfillStatus: "phase_boundary",
      retentionCutoffRoundId: null,
      stopAtOrBeforeUnixSeconds: "1",
    });
    expect(first.observations).toHaveLength(1_024);
    expect(first.observations.at(-1)?.fact.roundId).toBe((newPhase | 2n).toString(10));
    expect(first).toMatchObject({
      phaseBoundaryObserved: true,
      malformedRoundObserved: false,
      failure: undefined,
    });

    const second = await active.readHistory({
      feedId: "eth_usd",
      latestRoundId,
      knownObservations: [
        historyObservation(latestRoundId),
        ...first.observations,
        historyObservation((oldPhase | 1n).toString(10)),
      ],
      backfillPhaseId: "1",
      backfillNextRoundId: null,
      backfillStatus: "phase_boundary",
      retentionCutoffRoundId: null,
      stopAtOrBeforeUnixSeconds: "1",
    });
    expect(second.observations.map((entry) => entry.fact.roundId)).toEqual([
      (newPhase | 1n).toString(10),
    ]);
    expect(second).toMatchObject({
      phaseBoundaryObserved: true,
      malformedRoundObserved: false,
      failure: undefined,
    });
    await active.lifecycle.close();
  });

  it("re-derives bracketed and unbracketed all-revert work without durable absence", async () => {
    const requested: string[] = [];
    const requester = createBoundedRpcRequester({
      url: "https://rpc.example",
      fetch: (async (_input, init) => {
        if (typeof init?.body !== "string") throw new TypeError("Expected a request body.");
        const requests = JSON.parse(init.body) as Array<{
          readonly id: string;
          readonly params: Array<{ readonly data: string }>;
        }>;
        return new Response(JSON.stringify(requests.map((request) => {
          const roundId = BigInt(`0x${request.params[0]!.data.slice(-64)}`).toString(10);
          requested.push(roundId);
          return {
            jsonrpc: "2.0",
            id: request.id,
            error: { code: 3, message: "execution reverted", data: "0x" },
          };
        })));
      }) as typeof fetch,
    });
    const active = createPort(requester);
    const phase = 1n << 64n;
    const input = {
      feedId: "eth_usd",
      latestRoundId: (phase | 6n).toString(10),
      knownObservations: [historyObservation((phase | 3n).toString(10))],
      backfillPhaseId: "1",
      backfillNextRoundId: null,
      backfillStatus: "phase_boundary",
      retentionCutoffRoundId: null,
      stopAtOrBeforeUnixSeconds: "1",
    } as const;
    const expected = [
      (phase | 5n).toString(10),
      (phase | 4n).toString(10),
      (phase | 2n).toString(10),
      (phase | 1n).toString(10),
    ];
    const first = await active.readHistory(input);
    expect(requested).toEqual(expected);
    expect(first).toMatchObject({
      observations: [],
      backfillPhaseId: "1",
      backfillNextRoundId: null,
      backfillStatus: "phase_boundary",
      phaseBoundaryObserved: true,
      malformedRoundObserved: false,
      failure: undefined,
    });

    const second = await active.readHistory(input);
    expect(requested).toEqual([...expected, ...expected]);
    expect(second).toMatchObject({
      observations: [],
      backfillPhaseId: "1",
      backfillNextRoundId: null,
      backfillStatus: "phase_boundary",
      phaseBoundaryObserved: true,
      malformedRoundObserved: false,
      failure: undefined,
    });
    await active.lifecycle.close();
  });

  it("records the natural boundary when the latest aggregator round is one", async () => {
    let probes = 0;
    const active = createPort({
      async request() {
        probes += 1;
        throw new Error("A natural phase boundary must not issue a historical probe.");
      },
    });
    const phaseOneRoundOne = ((1n << 64n) | 1n).toString(10);
    const result = await active.readHistory({
      feedId: "eth_usd",
      latestRoundId: phaseOneRoundOne,
      knownObservations: [],
      backfillPhaseId: null,
      backfillNextRoundId: null,
      backfillStatus: null,
      retentionCutoffRoundId: null,
      stopAtOrBeforeUnixSeconds: "1",
    });
    expect(probes).toBe(0);
    expect(result).toMatchObject({
      backfillPhaseId: "1",
      backfillNextRoundId: null,
      backfillStatus: "phase_boundary",
      phaseBoundaryObserved: true,
      malformedRoundObserved: false,
      failure: undefined,
    });
    await active.lifecycle.close();
  });

  it("plans and executes only the cutoff-exclusive same-phase work", async () => {
    const cutoff = referenceCompositeRoundIdSchema.parse(compositeRoundId(1n, 100n));
    const traversal = referenceFeedTraversalStateSchema.parse({
      backfillPhaseId: "1",
      backfillNextRoundId: null,
      backfillStatus: "retention_boundary",
      retentionCutoffRoundId: cutoff,
    });
    expect(createReferenceHistoryWorkPlan({
      latestRoundId: referenceCompositeRoundIdSchema.parse(compositeRoundId(1n, 101n)),
      observations: [],
      traversal,
    })).toEqual({
      segments: [],
      remainingContinuation: false,
      remainingGap: false,
    });
    expect(createReferenceHistoryWorkPlan({
      latestRoundId: referenceCompositeRoundIdSchema.parse(compositeRoundId(1n, 103n)),
      observations: [],
      traversal,
    })).toEqual({
      segments: [{
        kind: "gap",
        firstRoundId: compositeRoundId(1n, 102n),
        stopExclusiveRoundId: cutoff,
      }],
      remainingContinuation: false,
      remainingGap: true,
    });

    const requested: string[] = [];
    const active = createPort({
      async request(_method, params) {
        const data = (params[0] as { readonly data: string }).data;
        const roundId = BigInt(`0x${data.slice(-64)}`);
        requested.push(roundId.toString(10));
        return encodedRound(roundId, 300_000_000_000n);
      },
    });
    const result = await active.readHistory({
      feedId: "eth_usd",
      latestRoundId: compositeRoundId(1n, 103n),
      knownObservations: [],
      backfillPhaseId: traversal.backfillPhaseId,
      backfillNextRoundId: traversal.backfillNextRoundId,
      backfillStatus: traversal.backfillStatus,
      retentionCutoffRoundId: traversal.retentionCutoffRoundId,
      stopAtOrBeforeUnixSeconds: "1",
    });
    expect(requested).toEqual([
      compositeRoundId(1n, 102n),
      compositeRoundId(1n, 101n),
    ]);
    expect(result.observations.map((entry) => entry.fact.roundId)).toEqual([
      compositeRoundId(1n, 102n),
      compositeRoundId(1n, 101n),
    ]);
    expect(result).toMatchObject({
      backfillPhaseId: "1",
      backfillNextRoundId: null,
      backfillStatus: "retention_boundary",
      phaseBoundaryObserved: false,
      malformedRoundObserved: false,
      failure: undefined,
    });
    await active.lifecycle.close();
  });

  it("keeps a cutoff-bounded gap replayable when one probe remains in the shared budget", async () => {
    const requested: string[] = [];
    const active = createPort({
      async request(_method, params) {
        const data = (params[0] as { readonly data: string }).data;
        const roundId = BigInt(`0x${data.slice(-64)}`);
        requested.push(roundId.toString(10));
        return encodedRound(roundId, 300_000_000_000n);
      },
    });
    const cutoff = compositeRoundId(1n, 100n);
    const latestRoundId = compositeRoundId(1n, 1_127n);
    const retained = historyObservation(compositeRoundId(1n, 103n));
    const traversal = referenceFeedTraversalStateSchema.parse({
      backfillPhaseId: "1",
      backfillNextRoundId: null,
      backfillStatus: "retention_boundary",
      retentionCutoffRoundId: cutoff,
    });

    const first = await active.readHistory({
      feedId: "eth_usd",
      latestRoundId,
      knownObservations: [retained],
      backfillPhaseId: traversal.backfillPhaseId,
      backfillNextRoundId: traversal.backfillNextRoundId,
      backfillStatus: traversal.backfillStatus,
      retentionCutoffRoundId: traversal.retentionCutoffRoundId,
      stopAtOrBeforeUnixSeconds: "1",
    });
    expect(first.observations).toHaveLength(1_024);
    expect(first.observations.at(-1)?.fact.roundId).toBe(compositeRoundId(1n, 102n));
    expect(first.observations.some((entry) =>
      BigInt(entry.fact.roundId) <= BigInt(cutoff))).toBe(false);
    const afterFirst = createReferenceHistoryWorkPlan({
      latestRoundId: referenceCompositeRoundIdSchema.parse(latestRoundId),
      observations: [retained, ...first.observations],
      traversal,
    });
    expect(afterFirst).toEqual({
      segments: [{
        kind: "gap",
        firstRoundId: compositeRoundId(1n, 101n),
        stopExclusiveRoundId: cutoff,
      }],
      remainingContinuation: false,
      remainingGap: true,
    });

    const firstRequestCount = requested.length;
    const second = await active.readHistory({
      feedId: "eth_usd",
      latestRoundId,
      knownObservations: [retained, ...first.observations],
      backfillPhaseId: traversal.backfillPhaseId,
      backfillNextRoundId: traversal.backfillNextRoundId,
      backfillStatus: traversal.backfillStatus,
      retentionCutoffRoundId: traversal.retentionCutoffRoundId,
      stopAtOrBeforeUnixSeconds: "1",
    });
    expect(requested.slice(firstRequestCount)).toEqual([compositeRoundId(1n, 101n)]);
    expect(second.observations.map((entry) => entry.fact.roundId))
      .toEqual([compositeRoundId(1n, 101n)]);
    expect(createReferenceHistoryWorkPlan({
      latestRoundId: referenceCompositeRoundIdSchema.parse(latestRoundId),
      observations: [retained, ...first.observations, ...second.observations],
      traversal,
    })).toEqual({
      segments: [],
      remainingContinuation: false,
      remainingGap: false,
    });
    await active.lifecycle.close();
  });

  it("clips a same-phase continuation at the exclusive cutoff without RPC", async () => {
    const requested: string[] = [];
    const active = createPort({
      async request(_method, params) {
        const data = (params[0] as { readonly data: string }).data;
        const roundId = BigInt(`0x${data.slice(-64)}`);
        requested.push(roundId.toString(10));
        return encodedRound(roundId, 300_000_000_000n);
      },
    });
    const samePhaseCutoff = compositeRoundId(1n, 100n);
    const atCutoff = await active.readHistory({
      feedId: "eth_usd",
      latestRoundId: compositeRoundId(1n, 101n),
      knownObservations: [],
      backfillPhaseId: "1",
      backfillNextRoundId: samePhaseCutoff,
      backfillStatus: null,
      retentionCutoffRoundId: samePhaseCutoff,
      stopAtOrBeforeUnixSeconds: "1",
    });
    expect(requested).toEqual([]);
    expect(atCutoff).toMatchObject({
      observations: [],
      backfillPhaseId: "1",
      backfillNextRoundId: null,
      backfillStatus: "retention_boundary",
      phaseBoundaryObserved: false,
      malformedRoundObserved: false,
      failure: undefined,
    });
    await active.lifecycle.close();
  });

  it("requests a same-phase continuation immediately above the cutoff exactly once", async () => {
    const requested: string[] = [];
    const active = createPort({
      async request(_method, params) {
        const data = (params[0] as { readonly data: string }).data;
        const roundId = BigInt(`0x${data.slice(-64)}`);
        requested.push(roundId.toString(10));
        return encodedRound(roundId, 300_000_000_000n);
      },
    });
    const samePhaseCutoff = compositeRoundId(1n, 100n);
    const immediatelyAbove = await active.readHistory({
      feedId: "eth_usd",
      latestRoundId: compositeRoundId(1n, 102n),
      knownObservations: [],
      backfillPhaseId: "1",
      backfillNextRoundId: compositeRoundId(1n, 101n),
      backfillStatus: null,
      retentionCutoffRoundId: samePhaseCutoff,
      stopAtOrBeforeUnixSeconds: "1",
    });
    expect(requested).toEqual([compositeRoundId(1n, 101n)]);
    expect(immediatelyAbove).toMatchObject({
      observations: [{ fact: { roundId: compositeRoundId(1n, 101n) } }],
      backfillPhaseId: "1",
      backfillNextRoundId: null,
      backfillStatus: "retention_boundary",
      phaseBoundaryObserved: false,
      malformedRoundObserved: false,
      failure: undefined,
    });
    await active.lifecycle.close();
  });

  it("preserves a phase-two continuation above a phase-one cutoff", async () => {
    const requested: string[] = [];
    const active = createPort({
      async request(_method, params) {
        const data = (params[0] as { readonly data: string }).data;
        const roundId = BigInt(`0x${data.slice(-64)}`);
        requested.push(roundId.toString(10));
        return encodedRound(roundId, 300_000_000_000n);
      },
    });
    const laterPhase = await active.readHistory({
      feedId: "eth_usd",
      latestRoundId: compositeRoundId(2n, 4n),
      knownObservations: [],
      backfillPhaseId: "2",
      backfillNextRoundId: compositeRoundId(2n, 3n),
      backfillStatus: null,
      retentionCutoffRoundId: compositeRoundId(1n, 50n),
      stopAtOrBeforeUnixSeconds: "1",
    });
    const expectedLaterPhase = [
      compositeRoundId(2n, 3n),
      compositeRoundId(2n, 2n),
      compositeRoundId(2n, 1n),
    ];
    expect(requested).toEqual(expectedLaterPhase);
    expect(laterPhase.observations.map((entry) => entry.fact.roundId)).toEqual(expectedLaterPhase);
    expect(laterPhase).toMatchObject({
      backfillPhaseId: "2",
      backfillNextRoundId: null,
      backfillStatus: "phase_boundary",
      phaseBoundaryObserved: true,
      malformedRoundObserved: false,
      failure: undefined,
    });
    await active.lifecycle.close();
  });

  it("reports malformed and transport-stopped traversal without converting either into absence", async () => {
    const malformed = createPort({
      async request() {
        return "0x";
      },
    });
    const malformedResult = await malformed.readHistory({
      feedId: "eth_usd",
      latestRoundId: compositeRoundId(1n, 3n),
      knownObservations: [],
      backfillPhaseId: "1",
      backfillNextRoundId: compositeRoundId(1n, 2n),
      backfillStatus: null,
      retentionCutoffRoundId: null,
      stopAtOrBeforeUnixSeconds: "1",
    });
    expect(malformedResult).toMatchObject({
      observations: [],
      backfillPhaseId: "1",
      backfillNextRoundId: compositeRoundId(1n, 2n),
      backfillStatus: "malformed",
      phaseBoundaryObserved: false,
      malformedRoundObserved: true,
      failure: undefined,
    });
    await malformed.lifecycle.close();

    const unavailable = createPort({
      async request() {
        throw new ChainRpcError("chain_response_unavailable");
      },
    });
    const unavailableResult = await unavailable.readHistory({
      feedId: "eth_usd",
      latestRoundId: compositeRoundId(1n, 3n),
      knownObservations: [],
      backfillPhaseId: "1",
      backfillNextRoundId: compositeRoundId(1n, 2n),
      backfillStatus: null,
      retentionCutoffRoundId: null,
      stopAtOrBeforeUnixSeconds: "1",
    });
    expect(unavailableResult).toMatchObject({
      observations: [],
      backfillPhaseId: "1",
      backfillNextRoundId: compositeRoundId(1n, 2n),
      backfillStatus: null,
      phaseBoundaryObserved: false,
      malformedRoundObserved: false,
    });
    expect(getChainOperationFailure(unavailableResult.failure)?.error.code)
      .toBe("chain_response_unavailable");
    await unavailable.lifecycle.close();
  });

  it("keeps every decoded but inadmissible history candidate retryable while latest rejects it", async () => {
    const requestedRoundId = compositeRoundId(1n, 2n);
    const decodedButInadmissible = [{
      name: "returned identity mismatch",
      result: encodedRoundFields({
        roundId: BigInt(compositeRoundId(1n, 1n)),
        answer: 300_000_000_000n,
        startedAt: 1_784_591_990n,
        updatedAt: 1_784_592_000n,
      }),
    }, {
      name: "nonpositive answer",
      result: encodedRoundFields({
        roundId: BigInt(requestedRoundId),
        answer: 0n,
        startedAt: 1_784_591_990n,
        updatedAt: 1_784_592_000n,
      }),
    }, {
      name: "missing update time",
      result: encodedRoundFields({
        roundId: BigInt(requestedRoundId),
        answer: 300_000_000_000n,
        startedAt: 0n,
        updatedAt: 0n,
      }),
    }, {
      name: "inverted timestamps",
      result: encodedRoundFields({
        roundId: BigInt(requestedRoundId),
        answer: 300_000_000_000n,
        startedAt: 1_784_592_001n,
        updatedAt: 1_784_592_000n,
      }),
    }, {
      name: "future update time",
      result: encodedRoundFields({
        roundId: BigInt(requestedRoundId),
        answer: 300_000_000_000n,
        startedAt: 1_784_678_391n,
        updatedAt: 1_784_678_401n,
      }),
    }] as const;

    for (const candidate of decodedButInadmissible) {
      const history = createPort({
        async request() {
          return candidate.result;
        },
      });
      const result = await history.readHistory({
        feedId: "eth_usd",
        latestRoundId: compositeRoundId(1n, 3n),
        knownObservations: [],
        backfillPhaseId: "1",
        backfillNextRoundId: requestedRoundId,
        backfillStatus: null,
        retentionCutoffRoundId: null,
        stopAtOrBeforeUnixSeconds: "1",
      });
      expect(result, candidate.name).toMatchObject({
        observations: [],
        backfillPhaseId: "1",
        backfillNextRoundId: requestedRoundId,
        backfillStatus: "malformed",
        malformedRoundObserved: true,
        failure: undefined,
      });
      await history.lifecycle.close();
    }

    const invalidLatestRoundId = BigInt(compositeRoundId(1n, 1n));
    const latest = createPort(new LatestRequester(false, undefined, encodedRoundFields({
      roundId: invalidLatestRoundId,
      answer: 0n,
      startedAt: 1_784_591_990n,
      updatedAt: 1_784_592_000n,
    })));
    await expect(latest.latestAtIssuedBlock(["eth_usd"]))
      .rejects.toMatchObject({ failure: { error: { code: "source_inconsistent" } } });
    await latest.lifecycle.close();
  });

  it("aborts and settles sibling latest calls after the first required read fails", async () => {
    let abortedSiblings = 0;
    const requester: RpcRequester = {
      async request(method, _params, signal) {
        if (method === "eth_getCode") throw new ChainRpcError("source_unavailable");
        return await new Promise((_resolve, reject) => signal.addEventListener("abort", () => {
          abortedSiblings += 1;
          reject(new ChainRpcError("request_aborted"));
        }, { once: true }));
      },
    };
    const active = createPort(requester);
    await expect(active.latestAtIssuedBlock(["eth_usd"]))
      .rejects.toMatchObject({ failure: { error: { code: "source_unavailable" } } });
    expect(abortedSiblings).toBe(3);
    await active.lifecycle.close();
  });
});
