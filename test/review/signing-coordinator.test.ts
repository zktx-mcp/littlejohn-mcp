import { afterEach, describe, expect, it, vi } from "vitest";
import { signingFailureCode } from "../../src/review/signing-errors.js";
import { createSigningCodec } from "../../src/chain/evm-standard.js";
import { createSigningFixture as fixture, command, message, signer } from "./signing-fixture.js";
afterEach(() => { vi.useRealTimers(); });

describe("direct signing lifetime", () => {
  it("verifies the confirmed data after a same-account session extension", async () => {
    const test = fixture();
    try {
      const signal = new AbortController().signal;
      const review = await test.coordinator.start(command, signal);
      const result = test.coordinator.confirm({ review, initiatedBy: "cli" }, signal);
      await test.sent; test.extendSession();
      const signature = await signer.signMessage({ message });
      test.reply({ status: "signature_returned", signature });
      expect(await result).toMatchObject({ outcome: { status: "verified", messageHash: review.messageHash }, signature });
      expect(test.startRequest).toHaveBeenCalledOnce();
    } finally { await test.close(); }
  });
  it("verifies one response, releases the consumed Review and rejects replay", async () => {
    const test = fixture();
    try {
      const signal = new AbortController().signal;
      const review = await test.coordinator.start(command, signal);
      const result = test.coordinator.confirm({ review, initiatedBy: "cli" }, signal);
      await test.sent;
      expect(test.coordinator.get(review.operationId)).toBeNull();
      await expect(test.coordinator.confirm({ review, initiatedBy: "mcp_app" }, signal).catch(signingFailureCode)).resolves.toBe("review_unavailable");
      const signature = await signer.signMessage({ message });
      test.reply({ status: "signature_returned", signature });
      expect(await result).toMatchObject({ outcome: { status: "verified", operationId: review.operationId, messageHash: review.messageHash }, signature });
      expect(test.startRequest).toHaveBeenCalledOnce();
    } finally { await test.close(); }
  });

  it.each(["wallet_rejected", "not_sent", "unsupported_signature"] as const)("preserves %s without producing a signature", async (status) => {
    const test = fixture();
    try {
      const signal = new AbortController().signal;
      const review = await test.coordinator.start(command, signal);
      const result = test.coordinator.confirm({ review, initiatedBy: "cli" }, signal);
      await test.sent; test.reply({ status });
      expect(await result).toMatchObject({ outcome: { status } });
      expect(await result).not.toHaveProperty("signature");
    } finally { await test.close(); }
  });

  it.each(["expiry", "interrupt", "close"] as const)("discards a late signature after %s without starting recovery", async (ending) => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-10T00:00:00.000Z"));
    const original = createSigningCodec();
    const recoverAddress = vi.fn(original.recoverAddress);
    const test = fixture({ ...original, recoverAddress });
    try {
      const signal = new AbortController();
      const review = await test.coordinator.start(command, signal.signal);
      const result = test.coordinator.confirm({ review, initiatedBy: "cli" }, signal.signal);
      await test.sent;
      if (ending === "expiry") await vi.advanceTimersByTimeAsync(300_000);
      else if (ending === "interrupt") signal.abort(); else await test.coordinator.close();
      expect(await result).toMatchObject({ outcome: { status: "delivery_unknown" } });
      test.reply({ status: "signature_returned", signature: await signer.signMessage({ message }) });
      await vi.advanceTimersByTimeAsync(0);
      expect(recoverAddress).not.toHaveBeenCalled();
      expect(test.startRequest).toHaveBeenCalledOnce();
      expect(await result).not.toHaveProperty("signature");
    } finally { await test.close(); }
  });

  it("rechecks waiting after real recovery completes and never publishes past expiry", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-10T00:00:00.000Z"));
    let release!: () => void, started!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const codec = createSigningCodec();
    const test = fixture({ ...codec, recoverAddress: async (hash, signature) => {
      started(); await pending; return codec.recoverAddress(hash, signature);
    } });
    try {
      const signal = new AbortController().signal;
      const review = await test.coordinator.start(command, signal);
      const result = test.coordinator.confirm({ review, initiatedBy: "cli" }, signal);
      await test.sent; test.reply({ status: "signature_returned", signature: await signer.signMessage({ message }) });
      await entered; await vi.advanceTimersByTimeAsync(300_000); release();
      expect(await result).toMatchObject({ outcome: { status: "delivery_unknown" } });
      await vi.advanceTimersByTimeAsync(0);
      expect(await result).not.toHaveProperty("signature");
    } finally { release(); await test.close(); }
  });

  it.each(["session", "permission"] as const)("rejects changed %s before request entry", async (change) => {
    const test = fixture();
    try {
      const signal = new AbortController().signal;
      const review = await test.coordinator.start(command, signal);
      if (change === "session") test.changeSession(); else test.removeMethod();
      await expect(test.coordinator.confirm({ review, initiatedBy: "cli" }, signal).catch(signingFailureCode)).resolves.toBe("wallet_session_unusable");
      expect(test.startRequest).not.toHaveBeenCalled();
      expect(test.coordinator.get(review.operationId)).toBeNull();
    } finally { await test.close(); }
  });
});
