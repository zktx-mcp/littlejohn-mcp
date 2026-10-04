import { describe, expect, it } from "vitest";
import { createPrimitiveSchemaSet, parseChainId } from "../../src/core/primitives.js";
import { createEvmPrimitiveSchemaSet } from "../../src/evm/primitives.js";

describe("native identity ownership", () => {
  it("admits CAIP-2 syntax in generic scope and leaves native admission to EVM", () => {
    // CAIP-2's published namespace/reference example and maximum-width case.
    expect(parseChainId("cosmos:cosmoshub-2")).toBe("cosmos:cosmoshub-2");
    expect(parseChainId("chainstd:8c3444cf8970a9e41a706fab93e7a6c4")).toHaveLength(41);
    for (const invalid of ["ab:1", "chainname:1", "eip155:", `eip155:${"1".repeat(33)}`, "eip155:1/2"]) {
      expect(() => parseChainId(invalid)).toThrow();
    }
    const input = { chainId: "cosmos:cosmoshub-2", blockNumber: "1", blockHash: `0x${"1".repeat(64)}`,
      blockTimestamp: "2026-08-24T07:00:00.000Z" };
    expect(createPrimitiveSchemaSet().chainAnchor.parse(input)).toEqual(input);
    expect(() => createEvmPrimitiveSchemaSet().chainAnchor.parse(input)).toThrow();
  });
});
