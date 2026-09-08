import { describe, expect, it } from "vitest";

import { createApplicationLifecycle } from "../../src/runtime/application-lifecycle.js";

describe("application lifecycle ownership", () => {
  it("admits only a completed, sealed application and never reopens it", async () => {
    const lifecycle = createApplicationLifecycle();
    expect(lifecycle.admission.isOpen).toBe(false);
    expect(Object.isFrozen(lifecycle.admission)).toBe(true);
    lifecycle.open();
    expect(lifecycle.admission.isOpen).toBe(true);
    expect(() => lifecycle.open()).toThrow(TypeError);
    expect(() => lifecycle.resources.register({ close() {} })).toThrow(TypeError);
    const close = lifecycle.close();
    expect(lifecycle.admission.isOpen).toBe(false);
    expect(() => lifecycle.open()).toThrow(TypeError);
    await close;
    expect(() => lifecycle.open()).toThrow(TypeError);
    await lifecycle.close();
  });

  it("publishes one completion before reentry and retains failed dependencies for retry", async () => {
    const lifecycle = createApplicationLifecycle();
    const events: string[] = [];
    const failure = new Error("dependent cleanup failed");
    let attempts = 0;
    let reentrant: Promise<void> | undefined;
    lifecycle.resources.register({ close() { events.push("source"); } });
    lifecycle.resources.register({
      close() {
        events.push("dependent");
        if (++attempts === 1) throw failure;
      },
    });
    lifecycle.resources.register({
      close() {
        events.push("consumer");
        expect(lifecycle.admission.isOpen).toBe(false);
        reentrant = lifecycle.close();
      },
    });
    lifecycle.open();
    const first = lifecycle.close();
    expect(events).toEqual([]);
    expect(lifecycle.close()).toBe(first);
    await expect(first).rejects.toBe(failure);
    expect(reentrant).toBe(first);
    expect(events).toEqual(["consumer", "dependent"]);
    expect(lifecycle.admission.isOpen).toBe(false);
    expect(() => lifecycle.resources.register({ close() {} })).toThrow(TypeError);
    expect(() => lifecycle.open()).toThrow(TypeError);
    const retry = lifecycle.close();
    expect(retry).not.toBe(first);
    expect(lifecycle.close()).toBe(retry);
    await retry;
    expect(events).toEqual(["consumer", "dependent", "dependent", "source"]);
    await lifecycle.close();
    expect(events).toHaveLength(4);
  });

  it("closes partial acquisition without ever publishing open admission", async () => {
    const lifecycle = createApplicationLifecycle();
    let closes = 0;
    lifecycle.resources.register({ close() { closes += 1; } });
    const closing = lifecycle.close();
    expect(lifecycle.admission.isOpen).toBe(false);
    expect(() => lifecycle.open()).toThrow(TypeError);
    expect(() => lifecycle.resources.register({ close() {} })).toThrow(TypeError);
    await closing;
    expect(closes).toBe(1);
    expect(lifecycle.admission.isOpen).toBe(false);
  });
});
