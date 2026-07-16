const timeoutError = (label) => new Error(`${label} timed out.`);

/** @type {typeof import("./child-process-lifecycle.d.mts").waitForPromise} */
export const waitForPromise = (
  promise,
  timeoutMilliseconds,
  label,
) => new Promise((resolveDeadline, rejectDeadline) => {
  const timeout = setTimeout(() => {
    rejectDeadline(timeoutError(label));
  }, timeoutMilliseconds);
  promise.then(
    (value) => {
      clearTimeout(timeout);
      resolveDeadline(value);
    },
    (error) => {
      clearTimeout(timeout);
      rejectDeadline(error);
    },
  );
});

/** @type {typeof import("./child-process-lifecycle.d.mts").ownChildProcess} */
export const ownChildProcess = (
  child,
  label,
  shutdownTimeoutMilliseconds,
) => {
  let terminated = false;
  let inputFailure;
  const pendingInputWrites = new Set();
  /** @type {() => void} */
  let resolveTermination = () => {};
  /** @type {(reason?: unknown) => void} */
  let rejectFailure = () => {};
  /** @type {Promise<void>} */
  const termination = new Promise((resolve) => {
    resolveTermination = resolve;
  });
  /** @type {Promise<never>} */
  const failure = new Promise((_resolve, reject) => {
    rejectFailure = reject;
  });
  child.once("error", (error) => {
    rejectFailure(error);
  });
  const failInputWrites = (error) => {
    const failure = error instanceof Error
      ? error
      : new Error(`${label} input failed.`);
    inputFailure ??= failure;
    for (const pending of pendingInputWrites) pending.reject(failure);
    pendingInputWrites.clear();
  };
  child.stdin?.on("error", (error) => {
    failInputWrites(error);
    rejectFailure(error);
  });
  child.once("close", () => {
    if (terminated) return;
    terminated = true;
    failInputWrites(new Error(`${label} input closed.`));
    resolveTermination();
  });

  const write = (input) => new Promise((resolveWrite, rejectWrite) => {
    const stream = child.stdin;
    if (
      inputFailure !== undefined ||
      terminated ||
      stream === null ||
      stream.destroyed ||
      !stream.writable
    ) {
      rejectWrite(inputFailure ?? new Error(`${label} input is unavailable.`));
      return;
    }
    const pending = {
      resolve: resolveWrite,
      reject: rejectWrite,
    };
    pendingInputWrites.add(pending);
    try {
      stream.write(input, (error) => {
        if (!pendingInputWrites.delete(pending)) return;
        if (error === null || error === undefined) pending.resolve(undefined);
        else pending.reject(error);
      });
    } catch (error) {
      pendingInputWrites.delete(pending);
      pending.reject(error);
    }
  });

  const terminate = async () => {
    if (terminated) {
      await termination;
      return;
    }
    child.kill("SIGTERM");
    try {
      await waitForPromise(
        termination,
        shutdownTimeoutMilliseconds,
        `${label} shutdown`,
      );
      return;
    } catch {
      if (!terminated) child.kill("SIGKILL");
    }
    await waitForPromise(
      termination,
      shutdownTimeoutMilliseconds,
      `${label} forced shutdown`,
    );
  };

  return Object.freeze({
    child,
    failure,
    isTerminated: () => terminated,
    termination,
    terminate,
    write,
  });
};

/** @type {typeof import("./child-process-lifecycle.d.mts").initializeOwnedChild} */
export const initializeOwnedChild = async (
  ownership,
  initialize,
  timeoutMilliseconds,
  label,
) => {
  try {
    return await waitForPromise(
      Promise.race([
        Promise.resolve().then(initialize),
        ownership.failure,
      ]),
      timeoutMilliseconds,
      label,
    );
  } catch (error) {
    try {
      await ownership.terminate();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `${label} and cleanup both failed.`,
      );
    }
    throw error;
  }
};
