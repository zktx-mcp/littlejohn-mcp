export const chainInvocationDeadlineMs = 90_000;

export type ChainInvocationStopReason = "caller_aborted" | "application_closed" | "deadline_reached";

const stopReasons = new WeakMap<object, ChainInvocationStopReason>();

export class ChainInvocationStoppedError extends Error {
  constructor(reason: ChainInvocationStopReason) {
    super(reason);
    this.name = "ChainInvocationStoppedError";
    stopReasons.set(this, reason);
    Object.freeze(this);
  }
}

export const getChainInvocationStopReason = (error: unknown): ChainInvocationStopReason | undefined =>
  typeof error === "object" && error !== null ? stopReasons.get(error) : undefined;

const unrefTimer = (timer: ReturnType<typeof setTimeout>): void => {
  if (typeof timer === "object" && timer !== null && "unref" in timer && typeof timer.unref === "function") {
    timer.unref();
  }
};

export interface ChainInvocationLifecycle {
  run<Result>(callerSignal: AbortSignal, effect: (signal: AbortSignal) => Promise<Result>): Promise<Result>;
  close(): Promise<void>;
}

export const createChainInvocationLifecycle = (
  ownerSignal: AbortSignal,
): ChainInvocationLifecycle => {
  const applicationAbort = new AbortController();
  const active = new Set<Promise<unknown>>();
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const abortForOwner = (): void => applicationAbort.abort();
  if (ownerSignal.aborted) applicationAbort.abort();
  else ownerSignal.addEventListener("abort", abortForOwner, { once: true });

  const run = <Result>(
    callerSignal: AbortSignal,
    effect: (signal: AbortSignal) => Promise<Result>,
  ): Promise<Result> => {
    if (typeof effect !== "function") return Promise.reject(new TypeError("Chain invocation effect is invalid."));
    if (closed || applicationAbort.signal.aborted) {
      return Promise.reject(new ChainInvocationStoppedError(
        callerSignal.aborted ? "caller_aborted" : "application_closed",
      ));
    }
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), chainInvocationDeadlineMs);
    unrefTimer(timer);
    const signal = AbortSignal.any([callerSignal, applicationAbort.signal, deadline.signal]);
    const stopReason = (): ChainInvocationStopReason | undefined =>
      callerSignal.aborted
        ? "caller_aborted"
        : applicationAbort.signal.aborted
          ? "application_closed"
          : deadline.signal.aborted
            ? "deadline_reached"
            : undefined;
    const invocation = (async (): Promise<Result> => {
      try {
        const initialStop = stopReason();
        if (initialStop !== undefined) throw new ChainInvocationStoppedError(initialStop);
        const result = await effect(signal);
        const finalStop = stopReason();
        if (finalStop !== undefined) throw new ChainInvocationStoppedError(finalStop);
        return result;
      } catch (error) {
        const reason = stopReason();
        if (reason !== undefined) throw new ChainInvocationStoppedError(reason);
        throw error;
      } finally {
        clearTimeout(timer);
      }
    })();
    active.add(invocation);
    void invocation.then(
      () => active.delete(invocation),
      () => active.delete(invocation),
    );
    return invocation;
  };

  return Object.freeze({
    run,
    close(): Promise<void> {
      if (closePromise !== undefined) return closePromise;
      closed = true;
      applicationAbort.abort();
      ownerSignal.removeEventListener("abort", abortForOwner);
      closePromise = Promise.allSettled([...active]).then(() => undefined);
      return closePromise;
    },
  });
};
