import { afterEach, describe, expect, it, vi } from "vitest";

import { hash32Schema, hexBytesSchema } from "../../src/core/index.js";

const bridge = "../../src/chain/viem-standard.cjs";
const loadBoundary = async (overrides: Record<string, unknown>) => {
  const original = await vi.importActual<{ default: Record<string, unknown> }>(bridge);
  vi.doMock(bridge, () => ({ default: { ...original.default, ...overrides } }));
  return import("../../src/chain/evm-standard.js");
};
afterEach(() => {
  vi.doUnmock(bridge);
  vi.resetModules();
});

const a = `0x${"11".repeat(20)}`;
const b = `0x${"22".repeat(20)}`;
const addressTopic = (address: string) => hash32Schema.parse(`0x${"0".repeat(24)}${address.slice(2)}`);
const word = hexBytesSchema.parse(`0x${"0".repeat(63)}5`);

describe("SDK output admission", () => {
  it("compares independently decoded event fields with original log bytes", async () => {
    let decoded: unknown;
    const { decodeCanonicalErc20Event } = await loadBoundary({ decodeEventLog: () => decoded });
    for (const [eventName, topic0, first, second] of [
      ["Transfer", "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", "from", "to"],
      ["Approval", "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925", "owner", "spender"],
    ] as const) {
      const topics = [hash32Schema.parse(topic0), addressTopic(a), addressTopic(b)];
      const args = { [first]: a, [second]: b, value: 5n };
      decoded = { eventName, args };
      expect(decodeCanonicalErc20Event(topics, word)).not.toBeNull();
      for (const [key, value] of [[first, b], [second, a], ["value", 6n]] as const) {
        decoded = { eventName, args: { ...args, [key]: value } };
        expect(decodeCanonicalErc20Event(topics, word)).toBeNull();
      }
    }
  });

  it("uses generic scalar parameters and rejects malformed decoded results", async () => {
    let decoded: unknown;
    const decode = vi.fn(() => decoded);
    const boundary = await loadBoundary({ decodeAbiParameters: decode });
    const addressWord = hexBytesSchema.parse(`0x${"0".repeat(24)}${a.slice(2)}`);
    for (const [type, input, read, valid, expected, invalid] of [
      ["uint256", word, boundary.decodeAbiUint256Result, 5n, "5", [5, -1n, 1n << 256n]],
      ["bool", hexBytesSchema.parse(`0x${"0".repeat(63)}1`), boundary.decodeAbiBooleanResult, true, true, [1n, "true"]],
      ["address", addressWord, boundary.decodeAbiAddressResult, a, a, [1n, "0x01"]],
    ] as const) {
      decoded = [valid];
      expect(read(input)).toBe(expected);
      expect(decode).toHaveBeenLastCalledWith([{ type }], input);
      for (const malformed of [null, [], [valid, valid], ...invalid.map((value) => [value])]) {
        decoded = malformed;
        expect(() => read(input)).toThrow(TypeError);
      }
    }
  });
});
