import { describe, expect, it } from "vitest";

import { addressTargetSchema } from "../../src/core/address-target.js";

describe("canonical Address target", () => {
  it("normalizes admitted explicit addresses and preserves one active target", () => {
    const lowercase = `0x${"a".repeat(40)}`;
    expect(addressTargetSchema.parse({
      kind: "address",
      address: lowercase,
    })).toEqual({ kind: "address", address: lowercase });
    expect(addressTargetSchema.parse({
      kind: "address",
      address: `0x${"A".repeat(40)}`,
    })).toEqual({ kind: "address", address: lowercase });
    expect(addressTargetSchema.parse({
      kind: "address",
      address: "0x52908400098527886E0F7030069857D2E4169EE7",
    })).toEqual({
      kind: "address",
      address: "0x52908400098527886e0f7030069857d2e4169ee7",
    });
    expect(addressTargetSchema.parse({ kind: "active_wallet" }))
      .toEqual({ kind: "active_wallet" });
  });

  it("rejects malformed, invalid-checksum, broadened, and authority-bearing targets", () => {
    for (const input of [
      { kind: "address", address: "0x1" },
      { kind: "address", address: "0x52908400098527886e0F7030069857D2E4169EE7" },
      { kind: "address", address: `0x${"1".repeat(40)}`, chainId: "eip155:4663" },
      { kind: "active_wallet", address: `0x${"1".repeat(40)}` },
      { kind: "active_wallet", profileId: "profile" },
      { kind: "active_wallet", session: "session" },
      { kind: "stored_account", accountId: "account" },
      { kind: "address", address: `0x${"1".repeat(40)}`, controlled: true },
    ]) expect(addressTargetSchema.safeParse(input).success).toBe(false);
  });
});
