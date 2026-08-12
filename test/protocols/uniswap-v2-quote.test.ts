import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import { keccak_256 } from "@noble/hashes/sha3.js";

import {
  CapabilityRegistry,
  assertDirectApplicationErrorRegistryExtension,
  chainAnchorSchema,
  contractRuntimeCodeIdentitySchema,
  createContractAnalysisChainClaims,
  createContractAnalysisSourceClaim,
  deepFreezeValue,
  exactRationalSchema,
  keccak256FromHex,
  parseCapabilitySuccess,
  parseEvmAddressInput,
  parseEvmChainId,
  parseHexBytes,
  parseUnsignedDecimal,
  projectCapabilities,
  type ContractAnalysis,
  type HexBytes,
  type ObservationWriter,
} from "../../src/core/index.js";
import { chainErrorRegistry } from "../../src/chain/errors.js";
import {
  createChainInvocationLifecycle,
  type ChainInvocationContext,
} from "../../src/chain/invocation-lifecycle.js";
import type {
  PinnedEvmCallResult,
  PinnedEvmReadPort,
} from "../../src/chain/protocol-reads.js";
import {
  assertUniswapV2QuoteData,
  createUniswapV2QuoteApplication,
  uniswapV2ErrorRegistry,
  uniswapV2QuoteCapability,
  uniswapV2QuoteDataSchema,
  uniswapV2QuoteInputSchema,
} from "../../src/protocols/uniswap-v2/index.js";
import { uniswapV2Evm } from "../../src/protocols/uniswap-v2/evm.js";
import {
  uniswapV2FactoryAddress,
  uniswapV2FactoryRuntimeCodeIdentity,
  uniswapV2PairInitCodeHash,
  uniswapV2RouteAssets,
} from "../../src/protocols/uniswap-v2/deployment.js";
import {
  calculateUniswapV2AmountOut,
  calculateUniswapV2Prices,
  computeUniswapV2PairAddress,
  constructUniswapV2CandidatePaths,
  orderedTokenAddresses,
} from "../../src/protocols/uniswap-v2/quote.js";
import { compareUniswapV2SdkQuote } from "../../src/protocols/uniswap-v2/sdk.js";
import {
  createCapabilityHarness,
  invokeBinding,
} from "../core/capability-harness.js";
import {
  uniswapV2FactoryRuntimeCodeFixture,
} from "../../scripts/release/uniswap-v2-factory-fixture.mjs";

const chainId = parseEvmChainId("eip155:4663");
const block = deepFreezeValue({
  anchor: chainAnchorSchema.parse({
    chainId,
    blockNumber: "20056525",
    blockHash: `0x${"ab".repeat(32)}` as const,
    blockTimestamp: "2026-07-27T00:00:00.000Z",
  }),
});
const tokenIn = deepFreezeValue({
  kind: "erc20" as const,
  chainId,
  address: parseEvmAddressInput(`0x${"11".repeat(20)}`),
});
const tokenOut = deepFreezeValue({
  kind: "erc20" as const,
  chainId,
  address: parseEvmAddressInput(`0x${"22".repeat(20)}`),
});
const zeroAddress = parseEvmAddressInput(`0x${"00".repeat(20)}`);

const word = (value: bigint): HexBytes =>
  parseHexBytes(`0x${value.toString(16).padStart(64, "0")}`);
const addressWord = (address: string): HexBytes =>
  parseHexBytes(`0x${address.slice(2).padStart(64, "0")}`);
const reservesResult = (reserve0: bigint, reserve1: bigint): HexBytes =>
  parseHexBytes(
    `0x${reserve0.toString(16).padStart(64, "0")}` +
      `${reserve1.toString(16).padStart(64, "0")}` +
      `${"0".repeat(64)}`,
  );
const independentKeccak = (hex: string): string =>
  Buffer.from(keccak_256(Buffer.from(hex, "hex"))).toString("hex");
const independentCanonicalJson = (value: unknown): string => {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(independentCanonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, entry]) =>
      `${JSON.stringify(key)}:${independentCanonicalJson(entry)}`).join(",")}}`;
  }
  throw new TypeError("Unsupported test canonical JSON value.");
};
const independentSha256 = (value: unknown): string =>
  createHash("sha256")
    .update(independentCanonicalJson(value), "utf8")
    .digest("hex");
const independentPairAddress = (
  factory: string,
  tokenA: string,
  tokenB: string,
  initCodeHash: string,
): string => {
  const [token0, token1] = [tokenA, tokenB].sort();
  const salt = independentKeccak(`${token0!.slice(2)}${token1!.slice(2)}`);
  const digest = independentKeccak(
    `ff${factory.slice(2)}${salt}${initCodeHash.slice(2)}`,
  );
  return `0x${digest.slice(-40)}`;
};

const directAnalysis = (): ContractAnalysis => deepFreezeValue({
  chainId: block.anchor.chainId,
  target: uniswapV2FactoryAddress,
  block: block.anchor,
  targetRuntimeCode: uniswapV2FactoryRuntimeCodeIdentity,
  proxy: { status: "no_supported_proxy_observed" },
  sources: [{
    role: "target",
    address: uniswapV2FactoryAddress,
    status: "no_record_observed",
  }],
  declaredFunctions: {
    status: "unavailable",
    reason: "exact_abi_unavailable",
  },
  controls: {
    owner: { status: "unavailable", reason: "exact_abi_unavailable" },
    paused: { status: "unavailable", reason: "exact_abi_unavailable" },
    defaultAdmins: { status: "unavailable", reason: "exact_abi_unavailable" },
  },
});

const recordAnalysis = (
  observations: ObservationWriter,
  fragment: Parameters<PinnedEvmReadPort["inspectContract"]>[3]["fragment"],
  analysis: ContractAnalysis,
  chainAuthority: PinnedEvmReadPort["observationAuthority"],
  sourceAuthority: ReturnType<
    ReturnType<typeof createCapabilityHarness>["contractVerificationSource"]
  >,
): void => {
  const deployment = observations.bind(fragment.targets.deployment);
  const targetSource = observations.bind(fragment.targets.targetSource);
  observations.record(deployment.slot, {
    source: chainAuthority,
    claims: [{
      role: deployment.roles.value,
      value: createContractAnalysisChainClaims(analysis).deployment,
      chainAnchor: analysis.block,
    }],
  });
  observations.record(targetSource.slot, {
    source: sourceAuthority,
    claims: [{
      role: targetSource.roles.value,
      value: createContractAnalysisSourceClaim(analysis, "target"),
      chainAnchor: analysis.block,
    }],
  });
};

const invokeWithFactoryLookup = async (
  lookup: PinnedEvmCallResult<HexBytes>,
  pairScenario?: Readonly<{
    readonly address: string;
    readonly runtimeCode: Awaited<
      ReturnType<PinnedEvmReadPort["readRuntimeCode"]>
    >;
    readonly responses: readonly PinnedEvmCallResult<HexBytes>[];
  }>,
  decimalsResults: readonly PinnedEvmCallResult<
    ReturnType<typeof parseUnsignedDecimal>
  >[] = [],
  options: Readonly<{
    readonly omitConfiguredChainAnchor?: boolean;
  }> = {},
) => {
  const harness = createCapabilityHarness();
  const lifecycle = createChainInvocationLifecycle(new AbortController().signal);
  const getPairCalls: string[] = [];
  let decimalsCallIndex = 0;
  const chainAuthority = harness.ports.observations.get("chain_rpc");
  const reads: PinnedEvmReadPort = {
    observationAuthority: chainAuthority,
    async resolveBlock() {
      return block;
    },
    async readRuntimeCode(_context, _block, address) {
      if (address === uniswapV2FactoryAddress) {
        const bytecode = parseHexBytes(uniswapV2FactoryRuntimeCodeFixture);
        return {
          bytecode,
          identity: contractRuntimeCodeIdentitySchema.parse({
            byteLength: String((bytecode.length - 2) / 2),
            codeHash: keccak256FromHex(bytecode),
          }),
        };
      }
      if (address !== pairScenario?.address) {
        throw new TypeError("Pair runtime code must not be read after absence.");
      }
      return pairScenario.runtimeCode;
    },
    async call(_context, _block, request) {
      getPairCalls.push(request.data);
      if (request.to === uniswapV2FactoryAddress) return lookup;
      if (request.to !== pairScenario?.address) {
        throw new TypeError("Unexpected V2 pair read.");
      }
      const next = pairScenario.responses[getPairCalls.length - 2];
      if (next === undefined) throw new TypeError("Unexpected V2 pair read count.");
      return next;
    },
    async readTokenDecimals() {
      return decimalsResults[decimalsCallIndex++] ?? {
        status: "observed",
        value: parseUnsignedDecimal("18"),
      };
    },
    async inspectContract(_context, _block, _target, evidence) {
      const analysis = directAnalysis();
      recordAnalysis(
        evidence.observations,
        evidence.fragment,
        analysis,
        chainAuthority,
        harness.contractVerificationSource(uniswapV2FactoryAddress),
      );
      return analysis;
    },
    recordConfiguredChain(_context, currentBlock, observations, target) {
      observations.record(target.slot, {
        source: chainAuthority,
        claims: [{
          role: target.roles.chainId,
          value: currentBlock.anchor.chainId,
          ...(options.omitConfiguredChainAnchor === true
            ? {}
            : { chainAnchor: currentBlock.anchor }),
        }],
      });
    },
  };
  const application = createUniswapV2QuoteApplication({
    invocations: lifecycle,
    reads,
    invocationAuthority: harness.invocationAuthority,
    invocationPorts: harness.ports,
  });
  const result = await invokeBinding(
    uniswapV2QuoteCapability,
    application.binding,
    {
      tokenIn,
      tokenOut,
      factory: uniswapV2FactoryAddress,
      amountIn: "1000",
      block: { kind: "number", blockNumber: block.anchor.blockNumber },
    },
  );
  await lifecycle.close();
  return { result, getPairCalls };
};

describe("Uniswap V2 exact-input quote owner", () => {
  it("pins the exact capability schema projections independently", () => {
    const [projection] = projectCapabilities(
      new CapabilityRegistry([uniswapV2QuoteCapability]),
    );
    expect(projection).toBeDefined();
    const expected = [
      "a35272c41bb05da22e010a4bb6538f595bff52df277677f0485cc821a7b6325c",
      "05fa850d2edb92cc1591af5de272ebe72907c8f0df1b224789e822222d176ce0",
      "3777dc9371d4f909d7a6ea475835a8e583b325c0e51acc499d9f29da6e52062b",
    ];
    expect([
      independentSha256(projection!.input.schema),
      independentSha256(projection!.data.schema),
      independentSha256(projection!.success.schema),
    ]).toEqual(expected);
    expect([
      projection!.input.digest,
      projection!.data.digest,
      projection!.success.digest,
    ]).toEqual(expected);
  });

  it("owns its protocol-specific public failure without changing chain errors", () => {
    expect(() => assertDirectApplicationErrorRegistryExtension(
      chainErrorRegistry,
      uniswapV2ErrorRegistry,
    )).not.toThrow();
    expect(uniswapV2ErrorRegistry.get("token_decimals_unavailable")).toEqual({
      code: "token_decimals_unavailable",
      category: "source",
      message: "A required endpoint token decimals call reverted.",
      retryable: false,
    });
  });

  it("admits only the verified factory and keeps package revision out of quote data", async () => {
    expect(() => uniswapV2QuoteInputSchema.parse({
      tokenIn,
      tokenOut,
      factory: parseEvmAddressInput(`0x${"33".repeat(20)}`),
      amountIn: "1000",
      block: { kind: "number", blockNumber: block.anchor.blockNumber },
    })).toThrow("V2 quote factory is not registered.");

    const { result } = await invokeWithFactoryLookup({
      status: "observed",
      value: addressWord(zeroAddress),
    });
    if (!result.ok) throw new TypeError("Expected a successful V2 quote result.");
    expect("packageContractVersion" in result.data.protocol).toBe(false);
    expect(() => uniswapV2QuoteDataSchema.parse({
      ...result.data,
      protocol: {
        ...result.data.protocol,
        packageContractVersion: "1",
      },
    })).toThrow();
  });

  it("matches a fixed independently calculated CREATE2 address vector", () => {
    const independent = independentPairAddress(
      uniswapV2FactoryAddress,
      uniswapV2RouteAssets[0]!.address,
      uniswapV2RouteAssets[1]!.address,
      uniswapV2PairInitCodeHash,
    );
    expect(independent).toBe("0x8803c117ccae7b5146297876c2a25df135141c4d");
    expect(computeUniswapV2PairAddress({
      factory: uniswapV2FactoryAddress,
      tokenA: uniswapV2RouteAssets[0]!.address,
      tokenB: uniswapV2RouteAssets[1]!.address,
      pairInitCodeHash: uniswapV2PairInitCodeHash,
    })).toBe(independent);
  });

  it("keeps exact ABI admission and the pinned SDK comparison independent", () => {
    const routeTokenIn = uniswapV2RouteAssets[0]!;
    const routeTokenOut = uniswapV2RouteAssets[1]!;
    const expectedPair = parseEvmAddressInput(
      "0x8803c117ccae7b5146297876c2a25df135141c4d",
    );
    expect(uniswapV2Evm.decodePair(addressWord(expectedPair))).toBe(expectedPair);
    expect(() => uniswapV2Evm.decodePair(
      parseHexBytes(`0x01${expectedPair.slice(2).padStart(64, "0")}`),
    )).toThrow();
    expect(() => uniswapV2Evm.decodeReserves(reservesResult(1n << 112n, 1n)))
      .toThrow(TypeError);
    expect(() => compareUniswapV2SdkQuote({
      amountIn: "1000",
      expectedAmountOut: "906",
      hops: [{
        tokenIn: routeTokenIn,
        tokenOut: routeTokenOut,
        tokenInDecimals: "18",
        tokenOutDecimals: "18",
        reserve0: "10000",
        reserve1: "10000",
        expectedPair,
      }],
    })).not.toThrow();
    expect(() => compareUniswapV2SdkQuote({
      amountIn: "1000",
      expectedAmountOut: "907",
      hops: [{
        tokenIn: routeTokenIn,
        tokenOut: routeTokenOut,
        tokenInDecimals: "18",
        tokenOutDecimals: "18",
        reserve0: "10000",
        reserve1: "10000",
        expectedPair,
      }],
    })).toThrow(TypeError);
    expect(() => compareUniswapV2SdkQuote({
      amountIn: "1000",
      expectedAmountOut: "474",
      hops: [{
        tokenIn: tokenOut,
        tokenOut: tokenIn,
        tokenInDecimals: "18",
        tokenOutDecimals: "18",
        reserve0: "10000",
        reserve1: "20000",
        expectedPair: computeUniswapV2PairAddress({
          factory: uniswapV2FactoryAddress,
          tokenA: tokenOut.address,
          tokenB: tokenIn.address,
          pairInitCodeHash: uniswapV2PairInitCodeHash,
        }),
      }],
    })).not.toThrow();
    for (const decimals of ["0", "254"]) {
      expect(() => compareUniswapV2SdkQuote({
        amountIn: "1000",
        expectedAmountOut: "906",
        hops: [{
          tokenIn: routeTokenIn,
          tokenOut: routeTokenOut,
          tokenInDecimals: decimals,
          tokenOutDecimals: decimals,
          reserve0: "10000",
          reserve1: "10000",
          expectedPair,
        }],
      })).not.toThrow();
    }
    expect(() => compareUniswapV2SdkQuote({
      amountIn: "1000",
      expectedAmountOut: "906",
      hops: [{
        tokenIn: routeTokenIn,
        tokenOut: routeTokenOut,
        tokenInDecimals: "255",
        tokenOutDecimals: "18",
        reserve0: "10000",
        reserve1: "10000",
        expectedPair,
      }],
    })).toThrow(TypeError);
  });

  it("applies the exact integer formula and separates terminal states", () => {
    const independentOutput =
      (1_000n * 997n * 10_000n) / (10_000n * 1_000n + 1_000n * 997n);
    expect(independentOutput).toBe(906n);
    expect(calculateUniswapV2AmountOut({
      amountIn: 1_000n,
      reserveIn: 10_000n,
      reserveOut: 10_000n,
    })).toEqual({ status: "quoted", amountOut: independentOutput });
    expect(calculateUniswapV2AmountOut({
      amountIn: 1n,
      reserveIn: 10_000n,
      reserveOut: 1n,
    })).toEqual({ status: "amount_too_small" });
    expect(calculateUniswapV2AmountOut({
      amountIn: 1n,
      reserveIn: 0n,
      reserveOut: 10_000n,
    })).toEqual({ status: "zero_liquidity" });
    expect(calculateUniswapV2AmountOut({
      amountIn: (1n << 256n) - 1n,
      reserveIn: 1n,
      reserveOut: 1n,
    })).toEqual({ status: "arithmetic_overflow" });
    expect(calculateUniswapV2Prices({
      amountIn: 1n,
      amountOut: 1n,
      reserves: [{ reserveIn: 1n, reserveOut: 1n }],
    })).toEqual({
      executionPrice: { numerator: "1", denominator: "1" },
      midPrice: { numerator: "1", denominator: "1" },
      priceImpact: { numerator: "0", denominator: "1" },
    });
  });

  it("constructs only direct and distinct one-intermediary candidates", () => {
    const paths = constructUniswapV2CandidatePaths(
      tokenIn,
      uniswapV2RouteAssets[0]!,
      uniswapV2RouteAssets,
    );
    expect(paths).toEqual([
      [tokenIn, uniswapV2RouteAssets[0]],
      [tokenIn, uniswapV2RouteAssets[1], uniswapV2RouteAssets[0]],
    ]);
    expect(() => constructUniswapV2CandidatePaths(
      tokenIn,
      tokenOut,
      [...uniswapV2RouteAssets].reverse(),
    )).toThrow("V2 route assets must be unique, ordered, and on the quote chain.");
    expect(() => constructUniswapV2CandidatePaths(
      tokenIn,
      tokenOut,
      [uniswapV2RouteAssets[0]!, uniswapV2RouteAssets[0]!],
    )).toThrow("V2 route assets must be unique, ordered, and on the quote chain.");
    expect(() => constructUniswapV2CandidatePaths(
      tokenIn,
      tokenOut,
      [{
        ...uniswapV2RouteAssets[0]!,
        chainId: parseEvmChainId("eip155:1"),
      }],
    )).toThrow("V2 route assets must be unique, ordered, and on the quote chain.");
  });

  it("does not read a later hop after the first terminal result", async () => {
    const { result, getPairCalls } = await invokeWithFactoryLookup({
      status: "observed",
      value: addressWord(zeroAddress),
    });
    expect(result).toMatchObject({
      ok: true,
      data: {
        candidates: [
          { status: "pair_absent", evaluatedHops: [{ status: "pair_absent" }] },
          { status: "pair_absent", evaluatedHops: [{ status: "pair_absent" }] },
          { status: "pair_absent", evaluatedHops: [{ status: "pair_absent" }] },
        ],
      },
    });
    expect(getPairCalls).toHaveLength(3);
    if (!result.ok) throw new TypeError("Expected absent-pair candidate results.");
    expect(result.evidence.conclusions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "uniswap_v2_quote_observed",
        status: "not_applicable",
        reason: "not_present",
      }),
    ]));
    const quoteConclusion = result.evidence.conclusions.find(
      ({ id }) => id === "uniswap_v2_quote_observed",
    );
    expect(quoteConclusion?.observationIds.length).toBeGreaterThan(0);
    expect(result.evidence.coverage.status).toBe("complete");
    expect(result.evidence.coverage.notApplicable).toContain("uniswap_v2_quote_observed");
    expect(result.evidence.sources.some(({ purpose }) => purpose === "quote_outcome"))
      .toBe(false);
    const changed = structuredClone(result.data);
    const intermediaryCandidate = changed.candidates[1];
    const terminalHop = intermediaryCandidate?.evaluatedHops[0];
    if (
      intermediaryCandidate?.status !== "pair_absent" ||
      terminalHop?.status !== "pair_absent"
    ) {
      throw new TypeError("Expected a terminal intermediary candidate.");
    }
    terminalHop.tokenOut.decimals = { status: "observed", value: "18" };
    expect(() => assertUniswapV2QuoteData(changed)).toThrow(
      "V2 intermediary decimals do not match candidate evaluation.",
    );
  });

  it("classifies malformed chain ABI output as source inconsistency", async () => {
    const { result, getPairCalls } = await invokeWithFactoryLookup({
      status: "observed",
      value: parseHexBytes("0x01"),
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "source_inconsistent" },
    });
    expect(getPairCalls).toHaveLength(1);
  });

  it("fails before pair evaluation when an endpoint decimals call reverts", async () => {
    const { result, getPairCalls } = await invokeWithFactoryLookup(
      { status: "observed", value: addressWord(zeroAddress) },
      undefined,
      [{ status: "reverted" }],
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "token_decimals_unavailable" },
    });
    expect(getPairCalls).toHaveLength(0);
  });

  it("rejects a configured-chain handoff that omits the canonical block anchor", async () => {
    const { result } = await invokeWithFactoryLookup(
      { status: "observed", value: addressWord(zeroAddress) },
      undefined,
      [],
      { omitConfiguredChainAnchor: true },
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "internal_error" },
    });
  });

  it("rejects conflicting pair address, code, identity, and ABI facts at admission", async () => {
    const expectedPair = computeUniswapV2PairAddress({
      factory: uniswapV2FactoryAddress,
      tokenA: tokenIn.address,
      tokenB: tokenOut.address,
      pairInitCodeHash: uniswapV2PairInitCodeHash,
    });
    const [token0, token1] = orderedTokenAddresses(tokenIn.address, tokenOut.address);
    const pairBytecode = parseHexBytes("0x6001");
    const admittedRuntimeCode = {
      bytecode: pairBytecode,
      identity: contractRuntimeCodeIdentitySchema.parse({
        byteLength: "2",
        codeHash: keccak256FromHex(pairBytecode),
      }),
    };
    const canonicalResponses: readonly PinnedEvmCallResult<HexBytes>[] = [
      { status: "observed", value: addressWord(uniswapV2FactoryAddress) },
      { status: "observed", value: addressWord(token0) },
      { status: "observed", value: addressWord(token1) },
      { status: "observed", value: reservesResult(10_000n, 10_000n) },
    ];
    const cases = [
      {
        name: "unexpected CREATE2 address",
        lookup: addressWord(parseEvmAddressInput(`0x${"99".repeat(20)}`)),
        runtimeCode: admittedRuntimeCode,
        responses: canonicalResponses,
      },
      {
        name: "missing runtime code",
        lookup: addressWord(expectedPair),
        runtimeCode: null,
        responses: canonicalResponses,
      },
      {
        name: "reported foreign factory",
        lookup: addressWord(expectedPair),
        runtimeCode: admittedRuntimeCode,
        responses: [
          { status: "observed" as const, value: addressWord(tokenIn.address) },
          ...canonicalResponses.slice(1),
        ],
      },
      {
        name: "reported wrong token order",
        lookup: addressWord(expectedPair),
        runtimeCode: admittedRuntimeCode,
        responses: [
          canonicalResponses[0]!,
          { status: "observed" as const, value: addressWord(token1) },
          { status: "observed" as const, value: addressWord(token0) },
          canonicalResponses[3]!,
        ],
      },
      {
        name: "reverted pair call",
        lookup: addressWord(expectedPair),
        runtimeCode: admittedRuntimeCode,
        responses: [
          { status: "reverted" as const },
          ...canonicalResponses.slice(1),
        ],
      },
      {
        name: "malformed reserves",
        lookup: addressWord(expectedPair),
        runtimeCode: admittedRuntimeCode,
        responses: [
          ...canonicalResponses.slice(0, 3),
          { status: "observed" as const, value: parseHexBytes("0x01") },
        ],
      },
    ];
    for (const testCase of cases) {
      const { result } = await invokeWithFactoryLookup(
        { status: "observed", value: testCase.lookup },
        {
          address: expectedPair,
          runtimeCode: testCase.runtimeCode,
          responses: testCase.responses,
        },
      );
      expect(result, testCase.name).toMatchObject({
        ok: false,
        error: { code: "source_inconsistent" },
      });
    }
  });

  it("binds a reverted intermediary-decimals read to public evidence", async () => {
    const harness = createCapabilityHarness();
    const lifecycle = createChainInvocationLifecycle(new AbortController().signal);
    const chainAuthority = harness.ports.observations.get("chain_rpc");
    const paths = constructUniswapV2CandidatePaths(tokenIn, tokenOut, uniswapV2RouteAssets);
    const quotedPath = paths[1]!;
    const pairOne = computeUniswapV2PairAddress({
      factory: uniswapV2FactoryAddress,
      tokenA: quotedPath[0]!.address,
      tokenB: quotedPath[1]!.address,
      pairInitCodeHash: uniswapV2PairInitCodeHash,
    });
    const pairTwo = computeUniswapV2PairAddress({
      factory: uniswapV2FactoryAddress,
      tokenA: quotedPath[1]!.address,
      tokenB: quotedPath[2]!.address,
      pairInitCodeHash: uniswapV2PairInitCodeHash,
    });
    const pairLookups = [zeroAddress, pairOne, pairTwo, zeroAddress];
    const pairTokens = new Map([
      [pairOne, orderedTokenAddresses(quotedPath[0]!.address, quotedPath[1]!.address)],
      [pairTwo, orderedTokenAddresses(quotedPath[1]!.address, quotedPath[2]!.address)],
    ]);
    let decimalReads = 0;
    const reads: PinnedEvmReadPort = {
      observationAuthority: chainAuthority,
      async resolveBlock() {
        return block;
      },
      async readRuntimeCode(_context, _block, address) {
        if (address === uniswapV2FactoryAddress) {
          const bytecode = parseHexBytes(uniswapV2FactoryRuntimeCodeFixture);
          return {
            bytecode,
            identity: contractRuntimeCodeIdentitySchema.parse({
              byteLength: String((bytecode.length - 2) / 2),
              codeHash: keccak256FromHex(bytecode),
            }),
          };
        }
        if (pairTokens.has(address)) {
          const bytecode = parseHexBytes("0x6001");
          return {
            bytecode,
            identity: contractRuntimeCodeIdentitySchema.parse({
              byteLength: "2",
              codeHash: keccak256FromHex(bytecode),
            }),
          };
        }
        return null;
      },
      async call(
        _context: ChainInvocationContext,
        _block,
        request,
      ): Promise<PinnedEvmCallResult<HexBytes>> {
        if (request.to === uniswapV2FactoryAddress) {
          const next = pairLookups.shift();
          if (next === undefined) throw new TypeError("Unexpected pair lookup.");
          return { status: "observed", value: addressWord(next) };
        }
        const pair = pairTokens.get(request.to);
        if (pair === undefined) throw new TypeError("Unexpected pair call.");
        if (request.data === parseHexBytes("0xc45a0155")) {
          return { status: "observed", value: addressWord(uniswapV2FactoryAddress) };
        }
        if (request.data === parseHexBytes("0x0dfe1681")) {
          return { status: "observed", value: addressWord(pair[0]) };
        }
        if (request.data === parseHexBytes("0xd21220a7")) {
          return { status: "observed", value: addressWord(pair[1]) };
        }
        if (request.data === parseHexBytes("0x0902f1ac")) {
          return { status: "observed", value: reservesResult(10_000n, 10_000n) };
        }
        throw new TypeError("Unexpected pair selector.");
      },
      async readTokenDecimals() {
        decimalReads += 1;
        return decimalReads === 3
          ? { status: "reverted" }
          : { status: "observed", value: parseUnsignedDecimal("18") };
      },
      async inspectContract(_context, _block, _target, evidence) {
        const analysis = directAnalysis();
        recordAnalysis(
          evidence.observations,
          evidence.fragment,
          analysis,
          chainAuthority,
          harness.contractVerificationSource(uniswapV2FactoryAddress),
        );
        return analysis;
      },
      recordConfiguredChain(_context, currentBlock, observations, target) {
        observations.record(target.slot, {
          source: chainAuthority,
          claims: [{
            role: target.roles.chainId,
            value: currentBlock.anchor.chainId,
            chainAnchor: currentBlock.anchor,
          }],
        });
      },
    };
    const application = createUniswapV2QuoteApplication({
      invocations: lifecycle,
      reads,
      invocationAuthority: harness.invocationAuthority,
      invocationPorts: harness.ports,
    });
    const result = await invokeBinding(
      uniswapV2QuoteCapability,
      application.binding,
      {
        tokenIn,
        tokenOut,
        factory: uniswapV2FactoryAddress,
        amountIn: "1000",
        block: { kind: "number", blockNumber: block.anchor.blockNumber },
      },
    );
    expect(result).toMatchObject({
      ok: true,
      data: {
        candidates: [
          { status: "pair_absent" },
          {
            status: "quoted",
            sdkCheck: {
              status: "not_available",
              reason: "intermediary_decimals_unavailable",
            },
          },
          { status: "pair_absent" },
        ],
      },
    });
    if (!result.ok) throw new TypeError("Expected a successful V2 quote result.");
    expect(result.evidence.conclusions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "uniswap_v2_quote_observed",
        status: "established",
        reason: "observed",
      }),
    ]));
    expect(result.evidence.coverage.status).toBe("complete");
    expect(result.evidence.sources.some((source) =>
      source.purpose === "token_decimals")).toBe(true);
    const reordered = structuredClone(result);
    reordered.data.candidates.reverse();
    expect(() => parseCapabilitySuccess(
      uniswapV2QuoteCapability,
      {
        tokenIn,
        tokenOut,
        factory: uniswapV2FactoryAddress,
        amountIn: "1000",
        block: { kind: "number", blockNumber: block.anchor.blockNumber },
      },
      reordered,
    )).toThrow();
    const truncated = structuredClone(result);
    const truncatedCandidate = truncated.data.candidates[1];
    if (truncatedCandidate?.status !== "quoted") {
      throw new TypeError("Expected the intermediary route to be quoted.");
    }
    truncatedCandidate.evaluatedHops.splice(1);
    expect(() => parseCapabilitySuccess(
      uniswapV2QuoteCapability,
      {
        tokenIn,
        tokenOut,
        factory: uniswapV2FactoryAddress,
        amountIn: "1000",
        block: { kind: "number", blockNumber: block.anchor.blockNumber },
      },
      truncated,
    )).toThrow();
    const changedReserve = structuredClone(result);
    const changedReserveCandidate = changedReserve.data.candidates[1];
    if (changedReserveCandidate?.status !== "quoted") {
      throw new TypeError("Expected the intermediary route to be quoted.");
    }
    const changedReserveHop = changedReserveCandidate.evaluatedHops[0];
    if (changedReserveHop === undefined || changedReserveHop.status === "pair_absent") {
      throw new TypeError("Expected an observed V2 pair.");
    }
    changedReserveHop.pair.reserve0 = "10001";
    expect(() => parseCapabilitySuccess(
      uniswapV2QuoteCapability,
      {
        tokenIn,
        tokenOut,
        factory: uniswapV2FactoryAddress,
        amountIn: "1000",
        block: { kind: "number", blockNumber: block.anchor.blockNumber },
      },
      changedReserve,
    )).toThrow();
    const changed = structuredClone(result);
    const candidate = changed.data.candidates[1];
    if (candidate?.status !== "quoted") {
      throw new TypeError("Expected the intermediary route to be quoted.");
    }
    for (const hop of candidate.evaluatedHops) {
      for (const token of [hop.tokenIn, hop.tokenOut]) {
        if (token.asset.address === quotedPath[1]!.address) {
          token.decimals = { status: "observed", value: "18" };
        }
      }
    }
    candidate.sdkCheck = {
      status: "matched",
      sdkCoreVersion: "7.19.0",
      v2SdkVersion: "4.21.1",
    };
    expect(() => assertUniswapV2QuoteData(changed.data)).not.toThrow();
    expect(() => parseCapabilitySuccess(
      uniswapV2QuoteCapability,
      {
        tokenIn,
        tokenOut,
        factory: uniswapV2FactoryAddress,
        amountIn: "1000",
        block: { kind: "number", blockNumber: block.anchor.blockNumber },
      },
      changed,
    )).toThrow(TypeError);
    const notObserved = structuredClone(changed.data);
    const notObservedCandidate = notObserved.candidates[1];
    if (notObservedCandidate?.status !== "quoted") {
      throw new TypeError("Expected the intermediary route to be quoted.");
    }
    for (const hop of notObservedCandidate.evaluatedHops) {
      for (const token of [hop.tokenIn, hop.tokenOut]) {
        if (token.asset.address === quotedPath[1]!.address) {
          token.decimals = { status: "not_observed" };
        }
      }
    }
    expect(() => assertUniswapV2QuoteData(notObserved)).toThrow(
      "V2 intermediary decimals do not match candidate evaluation.",
    );
    const conflicting = structuredClone(changed.data);
    const conflictingCandidate = conflicting.candidates[1];
    if (conflictingCandidate?.status !== "quoted") {
      throw new TypeError("Expected the intermediary route to be quoted.");
    }
    const firstIntermediary = conflictingCandidate.evaluatedHops[0]?.tokenOut;
    const secondIntermediary = conflictingCandidate.evaluatedHops[1]?.tokenIn;
    if (firstIntermediary === undefined || secondIntermediary === undefined) {
      throw new TypeError("Expected both intermediary token occurrences.");
    }
    firstIntermediary.decimals = { status: "observed", value: "18" };
    secondIntermediary.decimals = {
      status: "unavailable",
      reason: "call_reverted",
    };
    expect(() => assertUniswapV2QuoteData(conflicting)).toThrow(
      "V2 token decimals are inconsistent.",
    );
    const outsideSdkRange = structuredClone(changed.data);
    outsideSdkRange.input.tokenInDecimals = "255";
    for (const current of outsideSdkRange.candidates) {
      for (const hop of current.evaluatedHops) {
        for (const token of [hop.tokenIn, hop.tokenOut]) {
          if (token.asset.address === tokenIn.address) {
            token.decimals = { status: "observed", value: "255" };
          }
        }
      }
      if (current.status === "quoted") {
        current.sdkCheck = {
          status: "not_available",
          reason: "token_decimals_outside_sdk_range",
        };
      }
    }
    expect(() => assertUniswapV2QuoteData(outsideSdkRange)).not.toThrow();
    await lifecycle.close();
  });
});
