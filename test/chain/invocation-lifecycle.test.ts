import { afterEach, describe, expect, it, vi } from "vitest";

import {
  chainInvocationDeadlineMs,
  createChainInvocationLifecycle,
  getChainInvocationStopReason,
} from "../../src/chain/invocation-lifecycle.js";

afterEach(() => {
  vi.useRealTimers();
});

const pendingUntilAbort = (signal: AbortSignal): Promise<never> => new Promise((_, reject) => {
  const rejectStopped = (): void => reject(new Error("stopped"));
  signal.addEventListener("abort", rejectStopped, { once: true });
  if (signal.aborted) rejectStopped();
});

describe("chain invocation lifecycle", () => {
  it("gives caller cancellation precedence before invoking the effect", async () => {
    const owner = new AbortController();
    const caller = new AbortController();
    owner.abort();
    caller.abort();
    const lifecycle = createChainInvocationLifecycle(owner.signal);
    let invoked = false;
    let failure: unknown;
    try { await lifecycle.run(caller.signal, async () => { invoked = true; }); }
    catch (error) { failure = error; }
    expect(invoked).toBe(false);
    expect(getChainInvocationStopReason(failure)).toBe("caller_aborted");
    await lifecycle.close();
  });

  it("aborts and drains admitted work before close settles", async () => {
    const owner = new AbortController();
    const lifecycle = createChainInvocationLifecycle(owner.signal);
    const caller = new AbortController();
    const invocation = lifecycle.run(caller.signal, pendingUntilAbort);
    const closing = lifecycle.close();
    let failure: unknown;
    try { await invocation; }
    catch (error) { failure = error; }
    expect(getChainInvocationStopReason(failure)).toBe("application_closed");
    await expect(closing).resolves.toBeUndefined();
    await expect(lifecycle.close()).resolves.toBeUndefined();
  });

  it("owns the whole-invocation deadline and rejects a late result", async () => {
    vi.useFakeTimers();
    const owner = new AbortController();
    const lifecycle = createChainInvocationLifecycle(owner.signal);
    let resolveLate!: (value: string) => void;
    const invocation = lifecycle.run(new AbortController().signal, async () =>
      new Promise<string>((resolve) => { resolveLate = resolve; }));
    await vi.advanceTimersByTimeAsync(chainInvocationDeadlineMs);
    resolveLate("late result");
    let failure: unknown;
    try { await invocation; }
    catch (error) { failure = error; }
    expect(getChainInvocationStopReason(failure)).toBe("deadline_reached");
    await lifecycle.close();
  });
});
