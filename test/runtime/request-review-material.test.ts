import {afterEach, describe, expect, it, vi} from "vitest";
import {addUtcMilliseconds} from "../../src/core/index.js";
import {createSigningFixture, command} from "../review/signing-fixture.js";
import {signingResponseContext} from "../../src/review/signing-contracts.js";

afterEach(() => {vi.useRealTimers();});

describe("private prepared material ownership", () => {
  it("keeps canonical material while suspending presentation and consumes only the winning token", async () => {
    const test = createSigningFixture();
    try {
      const review = await test.coordinator.start(command, new AbortController().signal);
      const material = test.materials.read(review.operationId);
      if (material === null) throw new Error("Published material required.");
      expect(test.materials.readPresentation(review.operationId).status).toBe("available");
      const expiresAt = addUtcMilliseconds(review.createdAt, 5_000);
      const winning = test.materials.prepareConsumption(review, expiresAt);
      expect(test.materials.read(review.operationId)).toBe(material);
      expect(test.materials.readPresentation(review.operationId)).toEqual({status: "unavailable", reason: "runtime_unavailable"});
      expect(() => test.materials.prepareConsumption(review, expiresAt)).toThrow("unavailable");
      expect(test.materials.discardUnprepared(material)).toBe(false);
      expect(test.materials.takePrepared(winning)).toEqual({kind: "signing", payload: command.payload, context: signingResponseContext(review)});
      expect(test.materials.read(review.operationId)).toBeNull();
      expect(test.materials.readPresentation(review.operationId)).toEqual({status: "unavailable", reason: "snapshot_missing"});
      expect(() => test.materials.takePrepared(winning)).toThrow("unavailable");
      expect(test.startRequest).not.toHaveBeenCalled();
    } finally {await test.close();}
  });

  it("conditionally discards an unprepared owner but refuses an equal-valued obsolete captured owner", async () => {
    const test = createSigningFixture();
    try {
      const review = await test.coordinator.start(command, new AbortController().signal);
      const original = test.materials.read(review.operationId);
      if (original === null) throw new Error("Published material required.");
      expect(test.materials.discardUnprepared(original)).toBe(true);
      const reservation = test.materials.reserve(review.operationId, review.createdAt, review.actionExpiresAt);
      test.materials.publish(reservation, original);
      const current = test.materials.read(review.operationId);
      if (current === null) throw new Error("Replacement owner required.");
      expect(current).toEqual(original); expect(current).not.toBe(original);
      expect(test.materials.discardUnprepared(original)).toBe(false);
      expect(test.materials.read(review.operationId)).toBe(current);
      expect(test.materials.readPresentation(review.operationId).status).toBe("available");
      expect(test.materials.discardUnprepared(current)).toBe(true);
      expect(test.materials.readPresentation(review.operationId)).toEqual({status: "unavailable", reason: "snapshot_missing"});
      expect(test.startRequest).not.toHaveBeenCalled();
    } finally {await test.close();}
  });

  it.each(["discard", "expiry", "close"] as const)("releases the exact prepared owner on %s", async (ending) => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-10T00:00:00.000Z"));
    const test = createSigningFixture();
    try {
      const review = await test.coordinator.start(command, new AbortController().signal);
      const prepared = test.materials.prepareConsumption(review, addUtcMilliseconds(review.createdAt, 5_000));
      if (ending === "discard") test.materials.discardPrepared(prepared);
      else if (ending === "expiry") await vi.advanceTimersByTimeAsync(5_000);
      else test.materials.close();
      expect(test.materials.readPresentation(review.operationId)).toEqual({status: "unavailable", reason: ending === "close" ? "runtime_unavailable" : "snapshot_missing"});
      expect(() => test.materials.takePrepared(prepared)).toThrow();
      test.materials.discardPrepared(prepared);
      expect(test.startRequest).not.toHaveBeenCalled();
    } finally {await test.close();}
  });
});
