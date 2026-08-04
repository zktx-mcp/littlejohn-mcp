import { describe, expect, it } from "vitest";

import {
  completeTokenStandardObservation,
  erc165DetectionGas,
  observeRequiredErc8056,
} from "../../src/chain/token-standards.js";
import {
  canonicalBlockReference,
  ChainRpcError,
  createBoundedRpcRequester,
  type ChainRpcMethod,
  type ChainRpcRequestMap,
  type RpcRequester,
} from "../../src/chain/rpc.js";
import {
  parseEvmAddress,
  parseHash32,
  parseHexBytes,
  parseUnsignedDecimal,
  requiredErc8056ObservationSchema,
  tokenStandardDefinitions,
  tokenStandardObservationResultSchema,
  type ChainAnchor,
  type Erc20AssetIdentity,
  type EvmAccountIdentity,
} from "../../src/core/index.js";

const address = parseEvmAddress(`0x${"1".repeat(40)}`);
const otherAddress = parseEvmAddress(`0x${"3".repeat(40)}`);
const accountAddress = parseEvmAddress(`0x${"2".repeat(40)}`);
const blockHash = parseHash32(`0x${"a".repeat(64)}`);
const block: ChainAnchor = {
  chainId: "eip155:4663" as ChainAnchor["chainId"],
  blockNumber: "10" as ChainAnchor["blockNumber"],
  blockHash,
  blockTimestamp: "2026-07-20T00:00:00.000Z" as ChainAnchor["blockTimestamp"],
};
const asset: Erc20AssetIdentity = { kind: "erc20", chainId: block.chainId, address };
const otherAsset: Erc20AssetIdentity = {
  kind: "erc20",
  chainId: block.chainId,
  address: otherAddress,
};
const account: EvmAccountIdentity = { chainId: block.chainId, address: accountAddress };
const reference = canonicalBlockReference(blockHash);
const word = (value: bigint) => parseHexBytes(`0x${value.toString(16).padStart(64, "0")}`);
const bool = (value: boolean) => word(value ? 1n : 0n);
const interfaceCall = (interfaceId: string) =>
  `0x01ffc9a7${interfaceId.slice(2).padEnd(64, "0")}`;
const calls = {
  erc165: interfaceCall("0x01ffc9a7"),
  invalid: interfaceCall("0xffffffff"),
  core: interfaceCall("0xa60bf13d"),
  pending: interfaceCall("0x4bd27648"),
  conversion: interfaceCall("0x57854fc3"),
  balances: interfaceCall("0xd890fd71"),
  currentMultiplier: "0xa60bf13d",
  pendingMultiplier: "0xdc767007",
  pendingEffectiveAt: "0x97a4064f",
  balanceOfUi: `0x437a9958${accountAddress.slice(2).padStart(64, "0")}`,
} as const;

type Step = Readonly<{
  data: string;
  gas?: string;
  result?: unknown;
  error?: unknown;
}>;

class ExactCallRpc implements RpcRequester {
  readonly calls: Array<Readonly<{ method: ChainRpcMethod; params: readonly unknown[] }>> = [];
  readonly steps: Step[];

  constructor(steps: readonly Step[]) { this.steps = [...steps]; }

  async request<Method extends ChainRpcMethod>(
    method: Method,
    params: ChainRpcRequestMap[Method],
    _signal: AbortSignal,
  ): Promise<unknown> {
    this.calls.push({ method, params });
    const step = this.steps.shift();
    if (step === undefined || method !== "eth_call") throw new Error("Unexpected RPC call.");
    const call = params[0] as { to?: unknown; data?: unknown; gas?: unknown };
    if (
      call.to !== address ||
      call.data !== step.data ||
      call.gas !== step.gas ||
      params[1] !== reference
    ) throw new Error(`Unexpected eth_call boundary for ${step.data}.`);
    if (step.error !== undefined) throw step.error;
    return step.result;
  }
}

const requiredInput = (rpc: RpcRequester, selectedAsset = asset) => ({
  rpc,
  asset: selectedAsset,
  block,
  stateReference: reference,
  signal: new AbortController().signal,
});

const successfulRequiredSteps = (
  currentMultiplier = 2_000_000_000_000_000_000n,
): Step[] => [
  { data: calls.erc165, gas: erc165DetectionGas, result: bool(true) },
  { data: calls.invalid, gas: erc165DetectionGas, result: bool(false) },
  { data: calls.core, gas: erc165DetectionGas, result: bool(true) },
  { data: calls.pending, gas: erc165DetectionGas, result: bool(true) },
  { data: calls.currentMultiplier, result: word(currentMultiplier) },
  { data: calls.pendingMultiplier, result: word(3_000_000_000_000_000_000n) },
  { data: calls.pendingEffectiveAt, result: word(1_800_000_000n) },
];

const rpcWithProtocolResponses = (
  responses: readonly Readonly<{ result?: unknown; error?: unknown }>[],
): RpcRequester => {
  const pending = [...responses];
  return createBoundedRpcRequester({
    url: "https://rpc.example",
    fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { id: string };
      const response = pending.shift();
      if (response === undefined) throw new Error("Unexpected RPC request.");
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...response }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });
};

describe("token standard observation", () => {
  it("keeps the closed standard definitions and official specification links in one owner", () => {
    expect(Object.keys(tokenStandardDefinitions)).toEqual([
      "erc20_read_surface",
      "erc165",
      "erc8056",
      "erc8056_pending_multiplier",
      "erc8056_conversion",
      "erc8056_balances",
    ]);
    expect(tokenStandardDefinitions.erc20_read_surface.specificationUri).toBe(
      "https://eips.ethereum.org/EIPS/eip-20",
    );
    for (const id of [
      "erc165",
      "erc8056",
      "erc8056_pending_multiplier",
      "erc8056_conversion",
      "erc8056_balances",
    ] as const) {
      expect(tokenStandardDefinitions[id].explanation.length).toBeGreaterThan(20);
      expect(tokenStandardDefinitions[id].specificationUri).toMatch(/^https:\/\/eips\.ethereum\.org\/EIPS\/eip-/u);
    }
  });

  it("owns exact required and full account calls and returns identity-bound runtime contracts", async () => {
    const rpc = new ExactCallRpc([
      ...successfulRequiredSteps(),
      { data: calls.conversion, gas: erc165DetectionGas, result: bool(true) },
      { data: calls.balances, gas: erc165DetectionGas, result: bool(true) },
      { data: calls.balanceOfUi, result: word(10n) },
    ]);
    const required = await observeRequiredErc8056(requiredInput(rpc));
    expect(requiredErc8056ObservationSchema.parse(required)).toMatchObject({
      asset,
      erc165: { standardId: "erc165", status: "supported" },
      erc8056: { standardId: "erc8056", status: "supported" },
      pendingMultiplier: { standardId: "erc8056_pending_multiplier", status: "supported" },
      values: {
        currentMultiplier: "2000000000000000000",
        pendingMultiplier: "3000000000000000000",
        pendingEffectiveAt: "1800000000",
      },
    });
    const result = await completeTokenStandardObservation({
      ...requiredInput(rpc),
      erc20ReadSurfaceObserved: true,
      accountBalance: { account, rawBalance: parseUnsignedDecimal("5") },
    }, required);
    expect(tokenStandardObservationResultSchema.parse(result)).toEqual(result);
    expect(result).toMatchObject({
      asset,
      account,
      calculatedBalance: { status: "available", adjustedRaw: "10" },
      balanceOfUi: "10",
    });
    expect(result.standards.map(({ standardId, status }) => [standardId, status])).toEqual([
      ["erc20_read_surface", "observed"],
      ["erc165", "supported"],
      ["erc8056", "supported"],
      ["erc8056_pending_multiplier", "supported"],
      ["erc8056_conversion", "supported"],
      ["erc8056_balances", "supported"],
    ]);
    expect(rpc.calls).toHaveLength(10);
    expect(() => requiredErc8056ObservationSchema.parse({
      ...required,
      erc8056: { standardId: "erc8056", status: "supported" },
      pendingMultiplier: { standardId: "erc8056_pending_multiplier", status: "not_supported" },
      values: undefined,
    })).toThrow();
    expect(() => tokenStandardObservationResultSchema.parse({
      ...result,
      standards: result.standards.map((entry) => entry.standardId === "erc8056"
        ? { ...entry, status: "not_supported" }
        : entry),
      requiredErc8056: undefined,
    })).toThrow();
  });

  it("implements the ERC-165 negative detection procedure for false and reverted probes", async () => {
    const falseSelf = await observeRequiredErc8056(requiredInput(new ExactCallRpc([
      { data: calls.erc165, gas: erc165DetectionGas, result: bool(false) },
    ])));
    expect(falseSelf.erc165.status).toBe("not_supported");

    const trueInvalid = await observeRequiredErc8056(requiredInput(new ExactCallRpc([
      { data: calls.erc165, gas: erc165DetectionGas, result: bool(true) },
      { data: calls.invalid, gas: erc165DetectionGas, result: bool(true) },
    ])));
    expect(trueInvalid.erc165.status).toBe("not_supported");

    for (const responses of [
      [{ error: { code: 3, message: "execution reverted", data: "0x" } }],
      [
        { result: bool(true) },
        { error: { code: 3, message: "execution reverted", data: "0x" } },
      ],
    ]) {
      const reverted = await observeRequiredErc8056(requiredInput(rpcWithProtocolResponses(responses)));
      expect(reverted.erc165.status).toBe("not_supported");
    }
  });

  it("keeps source failures unknown, returned malformed values inconsistent, and abort terminal", async () => {
    const unavailable = await observeRequiredErc8056(requiredInput(new ExactCallRpc([
      { data: calls.erc165, gas: erc165DetectionGas, error: new ChainRpcError("source_unavailable") },
    ])));
    expect(unavailable.erc165.status).toBe("unknown");

    const malformedSource = await observeRequiredErc8056(requiredInput(new ExactCallRpc([
      { data: calls.erc165, gas: erc165DetectionGas, error: new ChainRpcError("source_inconsistent") },
    ])));
    expect(malformedSource.erc165.status).toBe("unknown");

    await expect(observeRequiredErc8056({
      ...requiredInput(new ExactCallRpc([
        { data: calls.erc165, gas: erc165DetectionGas, error: new ChainRpcError("request_aborted") },
      ])),
      signal: AbortSignal.abort(),
    })).rejects.toMatchObject({ failure: { error: { code: "request_aborted" } } });

    const malformedValues = await observeRequiredErc8056(requiredInput(new ExactCallRpc([
      ...successfulRequiredSteps().slice(0, 4),
      { data: calls.currentMultiplier, result: parseHexBytes("0x01") },
      { data: calls.pendingMultiplier, result: word(1n) },
      { data: calls.pendingEffectiveAt, result: word(1n) },
    ])));
    expect(malformedValues).toMatchObject({
      erc8056: { status: "inconsistent" },
      pendingMultiplier: { status: "inconsistent" },
    });
  });

  it("observes optional extension IDs for a valid non-ERC-8056 contract", async () => {
    const rpc = new ExactCallRpc([
      { data: calls.erc165, gas: erc165DetectionGas, result: bool(true) },
      { data: calls.invalid, gas: erc165DetectionGas, result: bool(false) },
      { data: calls.core, gas: erc165DetectionGas, result: bool(false) },
      { data: calls.pending, gas: erc165DetectionGas, result: bool(false) },
      { data: calls.conversion, gas: erc165DetectionGas, result: bool(false) },
      { data: calls.balances, gas: erc165DetectionGas, result: bool(false) },
    ]);
    const required = await observeRequiredErc8056(requiredInput(rpc));
    const result = await completeTokenStandardObservation({
      ...requiredInput(rpc),
      erc20ReadSurfaceObserved: true,
    }, required);
    expect(result.standards.slice(-2).map(({ status }) => status)).toEqual([
      "not_supported",
      "not_supported",
    ]);
    expect(rpc.calls).toHaveLength(6);

    const contradictoryRpc = new ExactCallRpc([
      { data: calls.erc165, gas: erc165DetectionGas, result: bool(true) },
      { data: calls.invalid, gas: erc165DetectionGas, result: bool(false) },
      { data: calls.core, gas: erc165DetectionGas, result: bool(false) },
      { data: calls.pending, gas: erc165DetectionGas, result: bool(false) },
      { data: calls.conversion, gas: erc165DetectionGas, result: bool(true) },
      { data: calls.balances, gas: erc165DetectionGas, result: bool(true) },
    ]);
    const contradictoryRequired = await observeRequiredErc8056(requiredInput(contradictoryRpc));
    const contradictory = await completeTokenStandardObservation({
      ...requiredInput(contradictoryRpc),
      erc20ReadSurfaceObserved: true,
    }, contradictoryRequired);
    expect(contradictory.standards.slice(-2).map(({ status }) => status)).toEqual([
      "inconsistent",
      "inconsistent",
    ]);
  });

  it("withholds an adjusted balance when a declared balances extension disagrees or is unavailable", async () => {
    for (const balanceStep of [
      { data: calls.balanceOfUi, result: word(11n) },
      { data: calls.balanceOfUi, error: new ChainRpcError("source_unavailable") },
    ]) {
      const rpc = new ExactCallRpc([
        ...successfulRequiredSteps(),
        { data: calls.conversion, gas: erc165DetectionGas, result: bool(false) },
        { data: calls.balances, gas: erc165DetectionGas, result: bool(true) },
        balanceStep,
      ]);
      const required = await observeRequiredErc8056(requiredInput(rpc));
      const result = await completeTokenStandardObservation({
        ...requiredInput(rpc),
        erc20ReadSurfaceObserved: true,
        accountBalance: { account, rawBalance: parseUnsignedDecimal("5") },
      }, required);
      expect(result.calculatedBalance).toBeUndefined();
      expect(result.balanceOfUi).toBeUndefined();
      expect(result.standards.at(-1)?.status).toBe(
        "result" in balanceStep ? "inconsistent" : "unknown",
      );
    }
  });

  it("returns a bounded arithmetic conclusion instead of throwing for valid maximum values", async () => {
    const maximum = (1n << 256n) - 1n;
    const rpc = new ExactCallRpc([
      ...successfulRequiredSteps(maximum),
      { data: calls.conversion, gas: erc165DetectionGas, result: bool(false) },
      { data: calls.balances, gas: erc165DetectionGas, result: bool(false) },
    ]);
    const required = await observeRequiredErc8056(requiredInput(rpc));
    const result = await completeTokenStandardObservation({
      ...requiredInput(rpc),
      erc20ReadSurfaceObserved: true,
      accountBalance: { account, rawBalance: parseUnsignedDecimal(maximum.toString(10)) },
    }, required);
    expect(result.calculatedBalance).toEqual({
      status: "unavailable",
      reason: "result_out_of_range",
      raw: maximum.toString(10),
      multiplier: maximum.toString(10),
      scale: "1000000000000000000",
    });
  });

  it("rejects fabricated, cross-block, and cross-token required results before further calls", async () => {
    const rpc = new ExactCallRpc([]);
    await expect(completeTokenStandardObservation({
      ...requiredInput(rpc),
      erc20ReadSurfaceObserved: true,
    }, {
      asset,
      block,
      erc165: { standardId: "erc165", status: "supported" },
      erc8056: { standardId: "erc8056", status: "not_supported" },
      pendingMultiplier: { standardId: "erc8056_pending_multiplier", status: "not_supported" },
    })).rejects.toThrow("not valid");

    const producer = new ExactCallRpc([
      { data: calls.erc165, gas: erc165DetectionGas, result: bool(false) },
    ]);
    const required = await observeRequiredErc8056(requiredInput(producer));
    await expect(completeTokenStandardObservation({
      ...requiredInput(rpc, otherAsset),
      erc20ReadSurfaceObserved: true,
    }, required)).rejects.toThrow("not valid");

    await expect(observeRequiredErc8056({
      ...requiredInput(rpc),
      stateReference: canonicalBlockReference(parseHash32(`0x${"b".repeat(64)}`)),
    })).rejects.toThrow("block reference");
    expect(rpc.calls).toHaveLength(0);
  });
});
