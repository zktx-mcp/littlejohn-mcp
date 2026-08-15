import { afterEach, describe, expect, it, vi } from "vitest";

import {
  chainInvocationDeadlineMs,
  createChainInvocationLifecycle,
  type ChainInvocationContext,
} from "../../src/chain/invocation-lifecycle.js";
import {
  getChainInvocationStopReason,
  getChainOperationFailure,
} from "../../src/chain/errors.js";

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
    expect(getChainOperationFailure(failure)?.error.code).toBe("request_aborted");
    await lifecycle.close();
  });

  it("aborts and drains admitted work before close settles", async () => {
    const owner = new AbortController();
    const lifecycle = createChainInvocationLifecycle(owner.signal);
    const caller = new AbortController();
    const invocation = lifecycle.run(caller.signal, (context) => pendingUntilAbort(context.signal));
    const closing = lifecycle.close();
    let failure: unknown;
    try { await invocation; }
    catch (error) { failure = error; }
    expect(getChainInvocationStopReason(failure)).toBe("application_closed");
    expect(getChainOperationFailure(failure)?.error.code).toBe("runtime_state_unavailable");
    await expect(closing).resolves.toBeUndefined();
    await expect(lifecycle.close()).resolves.toBeUndefined();
  });

  it("publishes admitted work and one close completion before synchronous reentry", async () => {
    const owner = new AbortController();
    const removeListener = vi.spyOn(owner.signal, "removeEventListener");
    const lifecycle = createChainInvocationLifecycle(owner.signal);
    let releaseEffect!: () => void;
    const effectPending = new Promise<void>((resolve) => { releaseEffect = resolve; });
    let initiatingClose!: Promise<void>;
    let reentrantClose!: Promise<void>;
    let abortedBeforeAwait = false;
    let effectDone = false;

    const invocation = lifecycle.run(new AbortController().signal, async (context) => {
      context.signal.addEventListener("abort", () => {
        reentrantClose = lifecycle.close();
      }, { once: true });
      initiatingClose = lifecycle.close();
      abortedBeforeAwait = context.signal.aborted;
      await effectPending;
      effectDone = true;
      return "late result";
    });
    const concurrentClose = lifecycle.close();

    expect(reentrantClose).toBe(initiatingClose);
    expect(concurrentClose).toBe(initiatingClose);
    expect(abortedBeforeAwait).toBe(true);
    expect(removeListener).toHaveBeenCalledTimes(1);

    let closeSettled = false;
    void initiatingClose.then(
      () => { closeSettled = true; },
      () => { closeSettled = true; },
    );
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(closeSettled).toBe(false);
    expect(effectDone).toBe(false);

    releaseEffect();
    let failure: unknown;
    try { await invocation; }
    catch (error) { failure = error; }
    expect(getChainInvocationStopReason(failure)).toBe("application_closed");
    await expect(initiatingClose).resolves.toBeUndefined();
    expect(effectDone).toBe(true);
    expect(lifecycle.close()).toBe(initiatingClose);
    expect(removeListener).toHaveBeenCalledTimes(1);
  });

  it("joins an exact nested signal under one deadline and drain, then rejects foreign and stale context use", async () => {
    vi.useFakeTimers();
    const owner = new AbortController();
    const lifecycle = createChainInvocationLifecycle(owner.signal);
    const foreignLifecycle = createChainInvocationLifecycle(new AbortController().signal);
    let publishContexts!: (contexts: Readonly<{
      outer: ChainInvocationContext;
      inner: ChainInvocationContext;
    }>) => void;
    const contextsReady = new Promise<Readonly<{
      outer: ChainInvocationContext;
      inner: ChainInvocationContext;
    }>>((resolveContexts) => { publishContexts = resolveContexts; });
    let releaseNested!: () => void;
    const nestedPending = new Promise<void>((resolveNested) => { releaseNested = resolveNested; });

    const invocation = lifecycle.run(new AbortController().signal, async (outer) => {
      lifecycle.assertActiveContext(outer);
      return await lifecycle.run(outer.signal, async (inner) => {
        publishContexts({ outer, inner });
        await nestedPending;
        return "joined";
      });
    });
    const contexts = await contextsReady;

    expect(contexts.inner).toBe(contexts.outer);
    expect(vi.getTimerCount()).toBe(1);
    expect(() => foreignLifecycle.assertActiveContext(contexts.outer))
      .toThrowError(/another lifecycle/u);

    let closeSettled = false;
    const closing = lifecycle.close().then(() => { closeSettled = true; });
    await Promise.resolve();
    expect(contexts.outer.signal.aborted).toBe(true);
    expect(closeSettled).toBe(false);

    let lateJoinInvoked = false;
    await expect(lifecycle.run(contexts.outer.signal, async () => {
      lateJoinInvoked = true;
    })).rejects.toThrowError(/cannot be joined/u);
    expect(lateJoinInvoked).toBe(false);

    releaseNested();
    let failure: unknown;
    try { await invocation; }
    catch (error) { failure = error; }
    expect(getChainInvocationStopReason(failure)).toBe("application_closed");
    await expect(closing).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    expect(() => lifecycle.assertActiveContext(contexts.outer))
      .toThrowError(/not active/u);
    await foreignLifecycle.close();
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
    expect(getChainOperationFailure(failure)?.error.code).toBe("chain_response_unavailable");
    await lifecycle.close();
  });

  it("keeps application close ahead of an already-reached invocation deadline", async () => {
    vi.useFakeTimers();
    const lifecycle = createChainInvocationLifecycle(new AbortController().signal);
    let release!: () => void;
    const invocation = lifecycle.run(new AbortController().signal, async () =>
      new Promise<void>((resolve) => { release = resolve; }));

    await vi.advanceTimersByTimeAsync(chainInvocationDeadlineMs);
    const closing = lifecycle.close();
    release();

    let failure: unknown;
    try { await invocation; }
    catch (error) { failure = error; }
    expect(getChainInvocationStopReason(failure)).toBe("application_closed");
    expect(getChainOperationFailure(failure)?.error.code).toBe("runtime_state_unavailable");
    await closing;
  });
});
