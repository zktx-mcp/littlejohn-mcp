import type { LocalRuntime } from "./composition.js";

export interface BackendProcess {
  on(event: "SIGINT" | "SIGTERM" | "SIGHUP", listener: () => void): unknown;
  removeListener(event: "SIGINT" | "SIGTERM" | "SIGHUP", listener: () => void): unknown;
}

// This entry owns whole-backend termination. It has no stdin/parent-disconnect
// listener: only the separately owned SDK child follows backend parent loss.
export const runBackend = async (input: {
  host: BackendProcess;
  createRuntime(onShutdownRequested: () => void): Promise<LocalRuntime>;
}): Promise<number> => {
  let runtime: LocalRuntime | undefined;
  let initializing: Promise<LocalRuntime> | undefined;
  let stopping: Promise<number> | undefined;
  let finish!: (code: number) => void;
  const ended = new Promise<number>(resolve => { finish = resolve; });
  const shutdown = (): Promise<number> => {
    if (stopping !== undefined) return stopping;
    stopping = Promise.resolve().then(async () => {
      try {
        if (runtime === undefined && initializing !== undefined) {
          try { runtime = await initializing; } catch { return 1; }
        }
        const outcome = await runtime?.stop();
        return outcome?.kind === "process_terminal" ? 1 : 0;
      } catch { return 1; }
    });
    void stopping.then(finish);
    return stopping;
  };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const stop = (): void => { void shutdown(); };
  for (const signal of signals) input.host.on(signal, stop);
  try {
    initializing = input.createRuntime(stop);
    runtime = await initializing;
    if (stopping !== undefined) return await stopping;
    const acquired = await runtime.startExclusive();
    if (!acquired) return await shutdown();
    return await ended;
  } catch {
    const requested = stopping !== undefined;
    await shutdown();
    return requested ? await ended : 1;
  } finally {
    for (const signal of signals) input.host.removeListener(signal, stop);
  }
};
