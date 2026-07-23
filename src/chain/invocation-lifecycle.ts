import { ChainOperationError } from "./errors.js";

export const chainInvocationDeadlineMs = 90_000;

export type ChainInvocationStopReason = "caller_aborted" | "application_closed" | "deadline_reached";

const stopReasons = new WeakMap<object, ChainInvocationStopReason>();

const createChainInvocationStoppedError = (reason: ChainInvocationStopReason): ChainOperationError => {
  const error = new ChainOperationError(
    reason === "caller_aborted" ? "request_aborted" : "source_unavailable",
  );
  stopReasons.set(error, reason);
  return error;
};

export const getChainInvocationStopReason = (error: unknown): ChainInvocationStopReason | undefined =>
  typeof error === "object" && error !== null ? stopReasons.get(error) : undefined;

const unrefTimer = (timer: ReturnType<typeof setTimeout>): void => {
  if (typeof timer === "object" && timer !== null && "unref" in timer && typeof timer.unref === "function") {
    timer.unref();
  }
};

export interface ChainInvocationLifecycle {
  run<Result>(
    callerSignal: AbortSignal,
    effect: (context: ChainInvocationContext) => Promise<Result>,
  ): Promise<Result>;
  assertActiveContext(context: ChainInvocationContext): void;
  close(): Promise<void>;
}

export interface ChainInvocationContext {
  readonly signal: AbortSignal;
}

export interface ChainInvocationPort {
  run<Result>(
    callerSignal: AbortSignal,
    effect: (context: ChainInvocationContext) => Promise<Result>,
  ): Promise<Result>;
}

interface ActiveContextRecord {
  readonly owner: object;
  readonly context: ChainInvocationContext;
  readonly signal: AbortSignal;
  readonly stopReason: () => ChainInvocationStopReason | undefined;
  active: boolean;
}

const contextRecords = new WeakMap<object, ActiveContextRecord>();
const signalRecords = new WeakMap<AbortSignal, ActiveContextRecord>();

export const assertActiveChainInvocationContext = (
  context: ChainInvocationContext,
): void => {
  const record = typeof context === "object" && context !== null
    ? contextRecords.get(context)
    : undefined;
  if (
    record === undefined ||
    !record.active ||
    record.context !== context ||
    context.signal !== record.signal ||
    record.stopReason() !== undefined
  ) {
    throw new TypeError("Chain invocation context is not active.");
  }
};

export const createChainInvocationLifecycle = (
  ownerSignal: AbortSignal,
): ChainInvocationLifecycle => {
  const owner = Object.freeze({});
  const applicationAbort = new AbortController();
  const active = new Set<Promise<unknown>>();
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const abortForOwner = (): void => applicationAbort.abort();
  if (ownerSignal.aborted) applicationAbort.abort();
  else ownerSignal.addEventListener("abort", abortForOwner, { once: true });

  const run = <Result>(
    callerSignal: AbortSignal,
    effect: (context: ChainInvocationContext) => Promise<Result>,
  ): Promise<Result> => {
    if (typeof effect !== "function") return Promise.reject(new TypeError("Chain invocation effect is invalid."));
    const joined = signalRecords.get(callerSignal);
    if (joined !== undefined) {
      if (joined.owner !== owner || !joined.active || joined.stopReason() !== undefined) {
        return Promise.reject(new TypeError("Chain invocation context cannot be joined."));
      }
      return Promise.resolve().then(() => effect(joined.context));
    }
    if (closed || applicationAbort.signal.aborted) {
      return Promise.reject(createChainInvocationStoppedError(
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
    const context = Object.freeze({ signal }) satisfies ChainInvocationContext;
    const record: ActiveContextRecord = {
      owner,
      context,
      signal,
      stopReason,
      active: true,
    };
    contextRecords.set(context, record);
    signalRecords.set(signal, record);
    const invocation = (async (): Promise<Result> => {
      try {
        const initialStop = stopReason();
        if (initialStop !== undefined) throw createChainInvocationStoppedError(initialStop);
        const result = await effect(context);
        const finalStop = stopReason();
        if (finalStop !== undefined) throw createChainInvocationStoppedError(finalStop);
        return result;
      } catch (error) {
        const reason = stopReason();
        if (reason !== undefined) throw createChainInvocationStoppedError(reason);
        throw error;
      } finally {
        record.active = false;
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
    assertActiveContext(context: ChainInvocationContext): void {
      const record = typeof context === "object" && context !== null
        ? contextRecords.get(context)
        : undefined;
      if (record?.owner !== owner) {
        throw new TypeError("Chain invocation context belongs to another lifecycle.");
      }
      assertActiveChainInvocationContext(context);
    },
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
