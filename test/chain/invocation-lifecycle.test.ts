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
    const observedInvocation = Promise.allSettled([invocation]);
    const concurrentClose = lifecycle.close();
    const observedCloses = Promise.allSettled([
      initiatingClose,
      reentrantClose,
      concurrentClose,
    ]);
    let closeSettled = false;
    const observedInitiatingClose = initiatingClose.then(
      () => { closeSettled = true; },
      () => { closeSettled = true; },
    );
    let invocationOutcome: PromiseSettledResult<string> | undefined;
    let closeOutcomes: readonly PromiseSettledResult<void>[] = [];

    try {
      expect(reentrantClose).toBe(initiatingClose);
      expect(concurrentClose).toBe(initiatingClose);
      expect(abortedBeforeAwait).toBe(true);
      expect(removeListener).toHaveBeenCalledTimes(1);

      await new Promise<void>((resolve) => { setImmediate(resolve); });
      expect(closeSettled).toBe(false);
      expect(effectDone).toBe(false);

      releaseEffect();
      [invocationOutcome] = await observedInvocation;
      expect(invocationOutcome?.status).toBe("rejected");
      if (invocationOutcome?.status !== "rejected") {
        throw new TypeError("Expected application-close rejection.");
      }
      expect(getChainInvocationStopReason(invocationOutcome.reason)).toBe("application_closed");
      closeOutcomes = await observedCloses;
      await observedInitiatingClose;
      expect(closeOutcomes).toEqual(Array.from({ length: 3 }, () => ({
        status: "fulfilled",
        value: undefined,
      })));
      expect(effectDone).toBe(true);
      expect(lifecycle.close()).toBe(initiatingClose);
      expect(removeListener).toHaveBeenCalledTimes(1);
    } finally {
      releaseEffect?.();
      await observedInvocation;
      await observedCloses;
      await observedInitiatingClose;
    }
  });

  it("joins an exact nested signal under one deadline and drain, then rejects foreign and stale context use", async () => {
    vi.useFakeTimers();
    const owner = new AbortController();
    const lifecycle = createChainInvocationLifecycle(owner.signal);
    const foreignLifecycle = createChainInvocationLifecycle(new AbortController().signal);
    let contexts: Readonly<{
      outer: ChainInvocationContext;
      inner: ChainInvocationContext;
    }> | undefined;
    let releaseNested!: () => void;
    const nestedPending = new Promise<void>((resolveNested) => { releaseNested = resolveNested; });

    const invocation = lifecycle.run(new AbortController().signal, async (outer) => {
      lifecycle.assertActiveContext(outer);
      return await lifecycle.run(outer.signal, async (inner) => {
        contexts = { outer, inner };
        await nestedPending;
        return "joined";
      });
    });
    const observedInvocation = Promise.allSettled([invocation]);
    let observedClosing: Promise<readonly PromiseSettledResult<void>[]> | undefined;
    let observedCloseSettlement: Promise<void> | undefined;

    try {
      await Promise.resolve();
      expect(contexts).toBeDefined();
      if (contexts === undefined) throw new TypeError("Expected nested invocation contexts.");
      const publishedContexts = contexts;

      expect(publishedContexts.inner).toBe(publishedContexts.outer);
      expect(vi.getTimerCount()).toBe(1);
      expect(() => foreignLifecycle.assertActiveContext(publishedContexts.outer))
        .toThrowError(/another lifecycle/u);

      let closeSettled = false;
      const closing = lifecycle.close();
      observedClosing = Promise.allSettled([closing]);
      observedCloseSettlement = observedClosing.then(() => { closeSettled = true; });
      await Promise.resolve();
      expect(publishedContexts.outer.signal.aborted).toBe(true);
      expect(closeSettled).toBe(false);

      let lateJoinInvoked = false;
      await expect(lifecycle.run(publishedContexts.outer.signal, async () => {
        lateJoinInvoked = true;
      })).rejects.toThrowError(/cannot be joined/u);
      expect(lateJoinInvoked).toBe(false);

      releaseNested();
      const [invocationOutcome] = await observedInvocation;
      expect(invocationOutcome?.status).toBe("rejected");
      if (invocationOutcome?.status !== "rejected") {
        throw new TypeError("Expected application-close rejection.");
      }
      expect(getChainInvocationStopReason(invocationOutcome.reason)).toBe("application_closed");
      const [closeOutcome] = await observedClosing;
      await observedCloseSettlement;
      expect(closeOutcome).toEqual({ status: "fulfilled", value: undefined });
      expect(vi.getTimerCount()).toBe(0);
      expect(() => lifecycle.assertActiveContext(publishedContexts.outer))
        .toThrowError(/not active/u);
    } finally {
      releaseNested?.();
      await Promise.all([
        observedInvocation,
        observedClosing ?? Promise.resolve([]),
        observedCloseSettlement ?? Promise.resolve(),
        Promise.allSettled([lifecycle.close(), foreignLifecycle.close()]),
      ]);
    }
  });

  it("owns the whole-invocation deadline and rejects a late result", async () => {
    vi.useFakeTimers();
    const owner = new AbortController();
    const lifecycle = createChainInvocationLifecycle(owner.signal);
    let context!: ChainInvocationContext;
    let resolveLate!: (value: string) => void;
    const invocation = lifecycle.run(new AbortController().signal, async (activeContext) => {
      context = activeContext;
      return await new Promise<string>((resolve) => { resolveLate = resolve; });
    });
    const observed = invocation.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    );
    let invocationSettled = false;
    void observed.then(() => { invocationSettled = true; });

    try {
      await vi.advanceTimersByTimeAsync(89_999);
      expect(context.signal.aborted).toBe(false);
      expect(invocationSettled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(context.signal.aborted).toBe(true);
      expect(invocationSettled).toBe(false);

      resolveLate("late result");
      const outcome = await observed;
      expect(invocationSettled).toBe(true);
      expect(outcome.status).toBe("rejected");
      if (outcome.status !== "rejected") throw new TypeError("Expected a rejected invocation.");
      expect(getChainInvocationStopReason(outcome.reason)).toBe("deadline_reached");
      expect(getChainOperationFailure(outcome.reason)?.error.code)
        .toBe("chain_response_unavailable");
    } finally {
      resolveLate?.("cleanup");
      await observed;
      await lifecycle.close();
    }
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
