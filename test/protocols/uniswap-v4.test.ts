import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { createEvmAbiCodec } from "../../src/chain/index.js";
import { parseEvmAccountIdentity, parseHexBytes, parseHash32 } from "../../src/core/index.js";
import { parseExchangeRequest, resolveExchangeIntent } from "../../src/review/client.js";
import { createUniswapV4Evm } from "../../src/protocols/uniswap-v4/evm.js";
import { uniswapV4PoolCatalog, uniswapV4ContractAddresses } from "../../src/protocols/uniswap-v4/client.js";
import { defaultStockTokenManifest } from "../../src/registry/default-stock-tokens.js";

const codec = createEvmAbiCodec();
const { decodeAbiParameters } = createRequire(import.meta.url)("viem") as {
  decodeAbiParameters<Value extends readonly unknown[]>(parameters: readonly unknown[], data: string): Value;
};
const evm = createUniswapV4Evm(codec);
const account = parseEvmAccountIdentity({ chainId: "eip155:4663", address: `0x${"1".repeat(40)}` });
const stock = "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9";
const poolId = "0xc748f4671a867db48b552f6b7650bf3255e05f80f00e3f7aad1b17ccb7898fdb";

it("encodes a read outside the catalog without admitting that pool for a transaction", () => {
  const otherId = parseHash32(`0x${"4".repeat(64)}`);
  expect(uniswapV4PoolCatalog.some((entry) => entry.poolId === otherId)).toBe(false);
  expect(evm.slot0(otherId).endsWith(otherId.slice(2))).toBe(true);
  expect(() => evm.createSwap({ ...intent(), poolId: otherId })).toThrow();
  expect(() => evm.quote({ ...intent(), poolId: otherId })).toThrow();
});

const intent = (input: {
  direction?: "buy" | "sell";
  basis?: "sent" | "received";
  inputRelation?: "equal" | "at_most";
  outputRelation?: "equal" | "at_least";
  outputAmount?: string;
} = {}) => {
  const direction = input.direction ?? "buy";
  return resolveExchangeIntent({
    request: parseExchangeRequest({
      account: { kind: "address", address: account.address }, stockTokenAddress: stock,
      direction, poolId,
      conditions: {
        basis: input.basis ?? "sent", inputRelation: input.inputRelation ?? "equal",
        inputAmount: "100", outputRelation: input.outputRelation ?? "at_least", outputAmount: input.outputAmount ?? "1",
      },
      fees: { maxFeePerGas: "100", maxPriorityFeePerGas: "1" },
      deadline: "2030-01-01T00:00:00.000Z",
    }),
    account, inputDecimals: direction === "buy" ? "6" : "18", outputDecimals: direction === "buy" ? "18" : "6",
  });
};

describe("Uniswap V4 native exchange profile", () => {
  it("encodes the native 2.1.1 tuple and fixed settlement independently of its product decoder", () => {
    const selected = intent({ outputRelation: "equal" });
    const call = evm.createSwap(selected);
    const [command, inputs, deadline] = decodeAbiParameters<readonly [string, readonly string[], bigint]>(
      [{ type: "bytes" }, { type: "bytes[]" }, { type: "uint256" }], parseHexBytes(`0x${call.data.slice(10)}`),
    );
    expect(command).toBe("0x10");
    expect(deadline).toBe(1893456000n);
    expect(inputs).toHaveLength(1);
    const [actions, values] = decodeAbiParameters<readonly [string, readonly string[]]>([{ type: "bytes" }, { type: "bytes[]" }], inputs[0]!);
    expect(actions).toBe("0x060b0e");
    const [swap] = decodeAbiParameters<readonly [{
      pool: { c0: string; c1: string; fee: number; spacing: number; hook: string };
      zeroForOne: boolean; input: bigint; minimum: bigint; minHopPriceX36: bigint; hookData: string;
    }]>([{ type: "tuple", components: [
      { name: "pool", type: "tuple", components: [{ name: "c0", type: "address" }, { name: "c1", type: "address" }, { name: "fee", type: "uint24" }, { name: "spacing", type: "int24" }, { name: "hook", type: "address" }] },
      { name: "zeroForOne", type: "bool" }, { name: "input", type: "uint128" }, { name: "minimum", type: "uint128" },
      { name: "minHopPriceX36", type: "uint256" }, { name: "hookData", type: "bytes" },
    ] }], values[0]!);
    expect(swap.input).toBe(100000000n);
    expect(swap.minimum).toBe(1000000000000000000n);
    expect(swap.minHopPriceX36).toBe(0n);
    expect(swap.hookData).toBe("0x");
    expect(swap.pool.fee).toBe(3000);
    expect(swap.pool.spacing).toBe(60);
    expect(decodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bool" }], values[1]!).map((value) => typeof value === "string" ? value.toLowerCase() : value)).toEqual([selected.input.token, 100000000n, true]);
    expect(decodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint256" }], values[2]!).map((value) => typeof value === "string" ? value.toLowerCase() : value)).toEqual([selected.output.token, "0x0000000000000000000000000000000000000001", 1000000000000000000n]);
  });
  it("contains the current defaults as candidates without a native-ETH substitute", () => {
    for (const stock of defaultStockTokenManifest.assets) {
      expect(uniswapV4PoolCatalog.some((entry) => entry.stockTokenAddress === stock.contractAddress)).toBe(true);
    }
    expect(uniswapV4PoolCatalog.some((entry) => BigInt(entry.stockTokenAddress) === 0n)).toBe(false);
  });

  it("preserves direction, amount basis and fixed versus bounded settlement", () => {
    for (const selected of [
      intent(), intent({ direction: "sell", inputRelation: "at_most" }),
      intent({ basis: "received", inputRelation: "at_most", outputRelation: "equal" }),
      intent({ direction: "sell", basis: "received", outputRelation: "equal" }),
      intent({ outputAmount: "0" }),
    ]) {
      const call = evm.createSwap(selected);
      expect(call.to).toBe(uniswapV4ContractAddresses.router);
      expect(call.value).toBe("0");
      expect(call.data.slice(0, 10)).toBe("0x3593564c");
      expect(evm.decodeSwap(call.data, account.address)).toEqual({
        basis: selected.basis, poolId, tokenIn: selected.input.token, tokenOut: selected.output.token,
        recipient: account.address, inputRelation: selected.inputRelation, outputRelation: selected.outputRelation,
        inputAmount: selected.input.raw, outputAmount: selected.output.raw, deadline: "1893456000",
      });
    }
  });

  it("rejects a valid weaker call and a changed deadline against the selected intent", () => {
    const selected = intent({ outputRelation: "equal" });
    const weaker = evm.createSwap(intent({ inputRelation: "at_most", outputRelation: "at_least" }));
    expect(() => evm.assertCall(selected, weaker)).toThrow("differs from the admitted intent");
    const call = evm.createSwap(selected);
    const wordStart = 10 + 2 * 64;
    const changed = parseHexBytes(`${call.data.slice(0, wordStart)}${(1893456001n).toString(16).padStart(64, "0")}${call.data.slice(wordStart + 64)}`);
    expect(() => evm.assertCall(selected, { ...call, data: changed })).toThrow("differs from the admitted intent");
    expect(() => evm.decodeSwap(parseHexBytes(`${call.data}00`), account.address)).toThrow();
  });

  it("binds each approval to its exact spender, amount and expiration", () => {
    const selected = intent();
    const erc20 = evm.approval(selected, "erc20_approval");
    expect(erc20.data.slice(0, 10)).toBe("0x095ea7b3");
    expect(erc20.to).toBe(selected.input.token);
    expect(() => evm.assertCall(selected, erc20)).not.toThrow();
    const wrongSpender = codec.encodeErc20("approve", [uniswapV4ContractAddresses.router, BigInt(selected.input.raw)]);
    expect(() => evm.assertCall(selected, { ...erc20, data: wrongSpender })).toThrow("ERC-20 approval differs");
    const permit = evm.approval(selected, "permit2_approval");
    expect(permit.to).toBe(uniswapV4ContractAddresses.permit2);
    expect(() => evm.assertCall(selected, permit)).not.toThrow();
    const encoded = codec.encodeParameters([{ type: "uint160" }, { type: "uint48" }, { type: "uint48" }], [100n, 1893456000, 7]);
    expect(evm.decodePermitAllowance(encoded)).toEqual({ amount: "100", expiration: "1893456000", nonce: "7" });
  });
});
