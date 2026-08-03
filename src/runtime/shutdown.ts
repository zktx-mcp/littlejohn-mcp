export type RuntimeShutdownOutcome =
  | Readonly<{ readonly kind: "released" }>
  | Readonly<{ readonly kind: "process_terminal" }>;

export const runtimeReleased = Object.freeze({ kind: "released" } as const);
export const runtimeProcessTerminal = Object.freeze({ kind: "process_terminal" } as const);

const processTerminalErrors = new WeakSet<object>();

export interface ProcessTerminalRequiredFailure extends Error {
  readonly primaryFailure: unknown;
}

class ProcessTerminalRequiredError extends Error implements ProcessTerminalRequiredFailure {
  readonly primaryFailure: unknown;

  constructor(primaryFailure?: unknown) {
    super("Process termination is required to release the WalletConnect owner.");
    this.name = "ProcessTerminalRequiredError";
    this.primaryFailure = primaryFailure;
    processTerminalErrors.add(this);
  }
}

export const isProcessTerminalRequiredError = (
  value: unknown,
): value is ProcessTerminalRequiredFailure =>
  typeof value === "object" && value !== null && processTerminalErrors.has(value);

export const requireProcessTermination = (
  primaryFailure?: unknown,
): ProcessTerminalRequiredFailure => new ProcessTerminalRequiredError(primaryFailure);
