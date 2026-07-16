import { describe, expect, it } from "vitest";

import { createErc20CallEncoder } from "../../src/chain/erc20-calls.js";
import { parseEvmAddress } from "../../src/core/index.js";

describe("viem ERC-20 call encoding boundary", () => {
  it("loads the pinned viem utility and validates exact call bytes", async () => {
    const encoder = await createErc20CallEncoder();
    const account = parseEvmAddress(`0x${"12".repeat(20)}`);
    expect(encoder.decimals()).toBe("0x313ce567");
    expect(encoder.balanceOf(account)).toBe(
      `0x70a08231${"12".repeat(20).padStart(64, "0")}`,
    );
  });

  it("rejects a forged or incompatible encoder module", async () => {
    await expect(createErc20CallEncoder(async () => ({
      encodeFunctionData: () => "0xdeadbeef",
    }))).rejects.toThrow("unexpected ERC-20 call encoding");
    await expect(createErc20CallEncoder(async () => Object.create({
      encodeFunctionData: () => "0x313ce567",
    }) as unknown)).rejects.toThrow("unavailable");
  });
});
