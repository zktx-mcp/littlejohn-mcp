#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import process, { exit as exitProcess } from "node:process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import {
  canonicalJsonStringify,
  captureCanonicalJson,
  createApplicationFailure,
  parseCapabilitySuccess,
  walletConnectionCapability,
  type ApplicationFailure,
  type CanonicalJson,
  type CapabilitySuccess,
  type WalletConnectionData,
} from "./core/index.js";
import {
  LocalRuntime,
  RuntimeOperationError,
  problemDetailsSchema,
  toProblemDetails,
  type OwnerOperation,
  type OwnerOperationResponse,
} from "./runtime/index.js";
import { createWalletOwnerApplication } from "./wallet/application.js";
import {
  isWalletOperationTerminalState,
  parseWalletOperationId,
  parseWalletOperationResponse,
  type WalletManagementOperation,
  type WalletOperationKind,
  type WalletOperationResponse,
} from "./wallet/contracts.js";
import {
  WalletOperationError,
  createWalletFailure,
  normalizeWalletError,
  walletErrorRegistry,
  walletInterfaceErrorMappings,
} from "./wallet/errors.js";
import { walletControlRoutes } from "./wallet/routes.js";
import {
  createTerminalQrDisplay,
  renderTerminalQr,
  type TerminalQrRendering,
} from "./wallet/terminal-qr.js";

type WalletConnectionSuccess = CapabilitySuccess<WalletConnectionData>;

export interface CliRuntimePort {
  readonly ownerState: LocalRuntime["ownerState"];
  start(): Promise<void>;
  executeOwnerOperation(operation: OwnerOperation): Promise<OwnerOperationResponse>;
  stop(): Promise<void>;
}

export interface CliTerminalPort {
  readonly inputIsTTY: boolean;
  readonly outputIsTTY: boolean;
  readonly columns: number | undefined;
  readonly rows: number | undefined;
  readonly interruptSignal: AbortSignal;
  writeOutput(value: string): void;
  writeError(value: string): void;
  showQr(rendering: TerminalQrRendering): void;
  hideQr(): void;
  readConfirmation(prompt: string): Promise<boolean>;
  dispose(): void;
}

export interface CliDependencies {
  readonly createRuntime: () => Promise<CliRuntimePort>;
  readonly terminal: CliTerminalPort;
  readonly waitForPoll: () => Promise<void>;
  readonly terminateProcess: (exitCode: number) => void;
}

type CliProcessEvent = "exit" | "SIGINT" | "SIGTERM" | "SIGHUP";

export interface CliProcessPort {
  readonly stdin: NodeJS.ReadableStream & { readonly isTTY?: boolean };
  readonly stdout: NodeJS.WritableStream & {
    readonly isTTY?: boolean;
    readonly columns?: number;
    readonly rows?: number;
  };
  readonly stderr: NodeJS.WritableStream;
  on(event: CliProcessEvent, listener: () => void): unknown;
  removeListener(event: CliProcessEvent, listener: () => void): unknown;
}

type CliCommand =
  | { readonly kind: "status"; readonly json: boolean }
  | { readonly kind: "connect"; readonly json: false }
  | { readonly kind: "disconnect"; readonly json: false }
  | { readonly kind: "operation"; readonly operationId: string; readonly json: boolean }
  | { readonly kind: "cancel"; readonly operationId: string; readonly json: false };

const invalidInput = (): never => { throw new WalletOperationError("invalid_input"); };

class CliApplicationFailure extends Error {
  readonly failure: ApplicationFailure;

  constructor(failure: ApplicationFailure) {
    super(failure.error.message);
    this.name = "CliApplicationFailure";
    this.failure = failure;
    Object.freeze(this);
  }
}

const parseJsonFlag = (tokens: readonly string[]): boolean => {
  if (tokens.length === 0) return false;
  if (tokens.length === 1 && tokens[0] === "--json") return true;
  return invalidInput();
};

const parseOperationCommand = (tokens: readonly string[]): CliCommand => {
  const jsonTokens = tokens.filter((token) => token === "--json");
  const positionals = tokens.filter((token) => token !== "--json");
  if (jsonTokens.length > 1 || positionals.length !== 1) return invalidInput();
  let operationId: string;
  try { operationId = parseWalletOperationId(positionals[0]); }
  catch { return invalidInput(); }
  return Object.freeze({ kind: "operation", operationId, json: jsonTokens.length === 1 });
};

const parseCommand = (argumentsInput: readonly string[]): CliCommand => {
  const [domain, command, ...tokens] = argumentsInput;
  if (domain !== "wallet" || command === undefined) return invalidInput();
  if (command === "status") {
    return Object.freeze({ kind: "status", json: parseJsonFlag(tokens) });
  }
  if (command === "connect" || command === "disconnect") {
    if (tokens.length !== 0) return invalidInput();
    return Object.freeze({ kind: command, json: false });
  }
  if (command === "operation") return parseOperationCommand(tokens);
  if (command === "cancel") {
    if (tokens.length !== 1) return invalidInput();
    try {
      return Object.freeze({ kind: "cancel", operationId: parseWalletOperationId(tokens[0]), json: false });
    } catch { return invalidInput(); }
  }
  return invalidInput();
};

const canonicalFailureFromResponse = (
  response: OwnerOperationResponse,
): CliApplicationFailure | WalletOperationError => {
  try {
    const problem = problemDetailsSchema.parse(captureCanonicalJson(response.body));
    const failure = createApplicationFailure(walletErrorRegistry, problem.code, problem.issues);
    const expected = toProblemDetails(failure, walletInterfaceErrorMappings);
    if (response.status !== problem.status ||
      canonicalJsonStringify(problem as unknown as CanonicalJson) !==
        canonicalJsonStringify(expected as unknown as CanonicalJson)) {
      throw new TypeError("Problem details do not match their error authority.");
    }
    return new CliApplicationFailure(failure);
  } catch (error) {
    if (error instanceof CliApplicationFailure || error instanceof WalletOperationError) return error;
    return new WalletOperationError("runtime_state_unavailable");
  }
};

const execute = async (
  runtime: CliRuntimePort,
  expectedStatus: 200 | 201,
  operation: OwnerOperation,
): Promise<CanonicalJson> => {
  const response = await runtime.executeOwnerOperation(operation);
  if (response.status >= 400) throw canonicalFailureFromResponse(response);
  if (response.status !== expectedStatus) throw new WalletOperationError("runtime_state_unavailable");
  return response.body;
};

const startOperation = async (
  runtime: CliRuntimePort,
  kind: WalletOperationKind,
): Promise<WalletOperationResponse> => parseWalletOperationResponse(await execute(runtime, 201, {
  method: "POST",
  path: walletControlRoutes.operations,
  body: { kind, interactionInterface: "cli" },
}));

const getOperation = async (
  runtime: CliRuntimePort,
  operationId: string,
): Promise<WalletOperationResponse> => parseWalletOperationResponse(await execute(runtime, 200, {
  method: "GET",
  path: walletControlRoutes.operation(operationId),
}));

const confirmOperation = async (
  runtime: CliRuntimePort,
  operation: WalletManagementOperation,
): Promise<WalletOperationResponse> => parseWalletOperationResponse(await execute(runtime, 200, {
  method: "POST",
  path: walletControlRoutes.confirmation(operation.operationId),
  body: { connectionRevision: operation.connectionRevision },
}));

const cancelOperation = async (
  runtime: CliRuntimePort,
  operationId: string,
): Promise<WalletOperationResponse> => parseWalletOperationResponse(await execute(runtime, 200, {
  method: "DELETE",
  path: walletControlRoutes.operation(operationId),
}));

const readConnection = async (runtime: CliRuntimePort): Promise<WalletConnectionSuccess> =>
  parseCapabilitySuccess(walletConnectionCapability, await execute(runtime, 200, {
    method: "GET",
    path: walletControlRoutes.connection,
  }));

const writeCanonical = (terminal: CliTerminalPort, value: unknown): void => {
  terminal.writeOutput(`${canonicalJsonStringify(captureCanonicalJson(value))}\n`);
};

const connectionSummary = (connection: WalletConnectionData): string => {
  switch (connection.status) {
    case "connected":
      return `Connected address: ${connection.address}\nChain: ${connection.chainId}\nSession expiry: ${connection.expiresAt}`;
    case "unresolved":
      return `Wallet state is unresolved because ${connection.eligibleSessionCount} eligible sessions exist.`;
    case "disconnected":
      return `Disconnected (${connection.reason}).`;
    case "unknown":
      return `Wallet state is unknown (${connection.reason}).`;
  }
};

const writeConnectionHuman = (terminal: CliTerminalPort, connection: WalletConnectionData): void => {
  terminal.writeOutput(`${connectionSummary(connection)}\n`);
};

const writeOperationHuman = (terminal: CliTerminalPort, operation: WalletManagementOperation): void => {
  terminal.writeOutput(`Wallet operation ${operation.operationId}: ${operation.state}\n`);
  if (operation.result !== null) {
    terminal.writeOutput(`Outcome: ${operation.result.outcome}\n`);
    writeConnectionHuman(terminal, operation.result.connection);
  }
};

const confirmationPrompt = (
  operation: WalletManagementOperation,
  connection: WalletConnectionData,
): string => operation.kind === "connect"
  ? [
      connectionSummary(connection),
      `Connection revision: ${operation.connectionRevision}`,
      "Every existing wallet session will be disconnected before a new connection is requested.",
      "If the new wallet approval fails, this profile will remain disconnected.",
      "Replace every existing wallet session? [y/N] ",
    ].join("\n")
  : [
      connectionSummary(connection),
      `Connection revision: ${operation.connectionRevision}`,
      "Every existing wallet session for this profile will be disconnected.",
      "Disconnect every existing wallet session? [y/N] ",
    ].join("\n");

const cancelledResponse = async (
  runtime: CliRuntimePort,
  operationId: string,
  dependencies: CliDependencies,
  initial?: WalletOperationResponse,
): Promise<WalletOperationResponse> => {
  let response = initial ?? await cancelOperation(runtime, operationId);
  for (;;) {
    if (response.operation.state === "cancelled") return response;
    if (isWalletOperationTerminalState(response.operation.state)) {
      throw new WalletOperationError("runtime_state_unavailable");
    }
    await dependencies.waitForPoll();
    response = await getOperation(runtime, operationId);
  }
};

type QrPresentation =
  | {
      readonly state: "displayed";
      readonly rendering: TerminalQrRendering;
    }
  | {
      readonly state: "waiting_for_space";
      readonly rendering: TerminalQrRendering;
      readonly terminalColumns: number | undefined;
      readonly terminalRows: number | undefined;
    };

const terminalDimension = (value: number | undefined): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;

const terminalHasSpace = (
  rendering: TerminalQrRendering,
  columns: number | undefined,
  rows: number | undefined,
): boolean => columns !== undefined &&
  rows !== undefined &&
  columns >= rendering.minimum.columns &&
  rows >= rendering.minimum.rows;

const terminalSize = (columns: number | undefined, rows: number | undefined): string =>
  `${columns ?? "unknown"} columns x ${rows ?? "unknown"} rows`;

const displayQr = (
  rendering: TerminalQrRendering,
  terminal: CliTerminalPort,
): QrPresentation => {
  terminal.showQr(rendering);
  return Object.freeze({ state: "displayed", rendering });
};

const clearQr = (terminal: CliTerminalPort, presentation: QrPresentation | undefined): void => {
  if (presentation?.state !== "displayed") return;
  terminal.hideQr();
};

const synchronizeQr = (
  response: WalletOperationResponse,
  terminal: CliTerminalPort,
  presentation: QrPresentation | undefined,
): QrPresentation | undefined => {
  if (response.qr === undefined) {
    clearQr(terminal, presentation);
    return undefined;
  }
  const rendering = presentation?.rendering ?? renderTerminalQr(response.qr);
  const columns = terminalDimension(terminal.columns);
  const rows = terminalDimension(terminal.rows);
  if (terminalHasSpace(rendering, columns, rows)) {
    return presentation?.state === "displayed"
      ? presentation
      : displayQr(rendering, terminal);
  }

  clearQr(terminal, presentation);
  if (
    presentation?.state !== "waiting_for_space" ||
    presentation.terminalColumns !== columns ||
    presentation.terminalRows !== rows
  ) {
    terminal.writeOutput([
      `Current terminal dimensions: ${terminalSize(columns, rows)}`,
      `Minimum terminal dimensions for this QR: ${terminalSize(
        rendering.minimum.columns,
        rendering.minimum.rows,
      )}`,
      "Resize the terminal to at least the minimum dimensions. The pairing code will appear automatically.",
      "",
    ].join("\n"));
  }
  return Object.freeze({
    state: "waiting_for_space",
    rendering,
    terminalColumns: columns,
    terminalRows: rows,
  });
};

type InterruptRace<Result> =
  | { readonly kind: "completed"; readonly result: Result }
  | { readonly kind: "interrupted" };

const raceWithInterrupt = async <Result>(
  startWork: () => Promise<Result>,
  signal: AbortSignal,
): Promise<InterruptRace<Result>> => {
  if (signal.aborted) return Object.freeze({ kind: "interrupted" });
  const work = startWork();
  const completed = work.then((result) => Object.freeze({ kind: "completed" as const, result }));
  if (signal.aborted) {
    void completed.catch(() => undefined);
    return Object.freeze({ kind: "interrupted" });
  }
  let resolveInterrupt!: (result: InterruptRace<Result>) => void;
  const interrupted = new Promise<InterruptRace<Result>>((resolve) => {
    resolveInterrupt = resolve;
  });
  const onAbort = (): void => { resolveInterrupt(Object.freeze({ kind: "interrupted" })); };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    return await Promise.race([
      completed,
      interrupted,
    ]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
};

const waitForInterrupt = async (signal: AbortSignal): Promise<void> => {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
};

type WaitDecision = "poll" | "interrupt";

const waitDecision = async (dependencies: CliDependencies): Promise<WaitDecision> => {
  const decision = await raceWithInterrupt(
    dependencies.waitForPoll,
    dependencies.terminal.interruptSignal,
  );
  return decision.kind === "interrupted" ? "interrupt" : "poll";
};

type ExactCancellationResolution = Readonly<{
  kind: "cancelled" | "transition_committed";
  operation: WalletManagementOperation;
}>;

const isStateConflict = (error: unknown): boolean =>
  (error instanceof WalletOperationError || error instanceof CliApplicationFailure) &&
  error.failure.error.code === "state_conflict";

const observeAuthoritativeTransition = async (
  runtime: CliRuntimePort,
  operationId: string,
  dependencies: CliDependencies,
): Promise<WalletManagementOperation> => {
  let response = await getOperation(runtime, operationId);
  for (;;) {
    if (isWalletOperationTerminalState(response.operation.state)) return response.operation;
    await dependencies.waitForPoll();
    response = await getOperation(runtime, operationId);
  }
};

const resolveExactCancellation = async (
  runtime: CliRuntimePort,
  operationId: string,
  dependencies: CliDependencies,
  afterCancellationStarted?: () => void,
): Promise<ExactCancellationResolution> => {
  const cancellation = cancelOperation(runtime, operationId);
  try { afterCancellationStarted?.(); }
  catch { /* Runtime settlement and final terminal restoration retain authority. */ }
  try {
    const cancelled = await cancelledResponse(
      runtime,
      operationId,
      dependencies,
      await cancellation,
    );
    return Object.freeze({ kind: "cancelled", operation: cancelled.operation });
  } catch (error) {
    if (!isStateConflict(error)) throw error;
    return Object.freeze({
      kind: "transition_committed",
      operation: await observeAuthoritativeTransition(runtime, operationId, dependencies),
    });
  }
};

const waitForTerminalOperation = async (
  runtime: CliRuntimePort,
  initial: WalletOperationResponse,
  dependencies: CliDependencies,
): Promise<WalletManagementOperation> => {
  let response = initial;
  let presentation: QrPresentation | undefined;
  const clearPresentation = (): void => {
    try {
      clearQr(dependencies.terminal, presentation);
      presentation = undefined;
    } catch { /* Final terminal disposal retains emergency restoration authority. */ }
  };
  const cancelExactOperation = (): Promise<ExactCancellationResolution> =>
    resolveExactCancellation(
      runtime,
      response.operation.operationId,
      dependencies,
      clearPresentation,
    );
  try {
    for (;;) {
      if (isWalletOperationTerminalState(response.operation.state)) {
        clearPresentation();
        return response.operation;
      }

      let step:
        | Readonly<{ kind: "observation"; response: WalletOperationResponse }>
        | Readonly<{ kind: "interrupt" }>
        | Readonly<{ kind: "failure"; error: unknown }>;
      try {
        if (dependencies.terminal.interruptSignal.aborted) {
          step = Object.freeze({ kind: "interrupt" });
        } else {
          presentation = synchronizeQr(response, dependencies.terminal, presentation);
          if (await waitDecision(dependencies) === "interrupt") {
            step = Object.freeze({ kind: "interrupt" });
          } else {
            const observation = await raceWithInterrupt(
              () => getOperation(runtime, response.operation.operationId),
              dependencies.terminal.interruptSignal,
            );
            step = observation.kind === "interrupted"
              ? Object.freeze({ kind: "interrupt" })
              : Object.freeze({ kind: "observation", response: observation.result });
          }
        }
      } catch (error) {
        step = dependencies.terminal.interruptSignal.aborted
          ? Object.freeze({ kind: "interrupt" })
          : Object.freeze({ kind: "failure", error });
      }

      if (step.kind === "interrupt") return (await cancelExactOperation()).operation;
      if (step.kind === "failure") {
        let resolution: ExactCancellationResolution;
        try { resolution = await cancelExactOperation(); }
        catch { throw new WalletOperationError("runtime_state_unavailable"); }
        if (resolution.kind === "transition_committed") return resolution.operation;
        throw step.error;
      }
      response = step.response;
    }
  } finally {
    clearPresentation();
  }
};

const operationFailure = (operation: WalletManagementOperation): ApplicationFailure | undefined => {
  if (operation.state === "failed") {
    return operation.failure ?? createWalletFailure("runtime_state_unavailable");
  }
  if (operation.state === "rejected") return createWalletFailure("wallet_user_rejected");
  if (operation.state === "expired") return createWalletFailure("wallet_timeout");
  return undefined;
};

const runWalletTransition = async (
  runtime: CliRuntimePort,
  kind: WalletOperationKind,
  dependencies: CliDependencies,
): Promise<void> => {
  let response = await startOperation(runtime, kind);
  let resolvedOperation: WalletManagementOperation | undefined;
  if (response.operation.state === "awaiting_confirmation") {
    let decision: "confirm" | "decline" | "interrupt" | undefined;
    try {
      if (dependencies.terminal.interruptSignal.aborted) {
        decision = "interrupt";
      } else {
        const connection = await raceWithInterrupt(
          () => readConnection(runtime),
          dependencies.terminal.interruptSignal,
        );
        if (connection.kind === "interrupted" || dependencies.terminal.interruptSignal.aborted) {
          decision = "interrupt";
        } else {
          const confirmation = await raceWithInterrupt(
            () => dependencies.terminal.readConfirmation(
              confirmationPrompt(response.operation, connection.result.data),
            ),
            dependencies.terminal.interruptSignal,
          );
          decision = confirmation.kind === "interrupted" || dependencies.terminal.interruptSignal.aborted
            ? "interrupt"
            : confirmation.result
              ? "confirm"
              : "decline";
        }
      }
    } catch (error) {
      let resolution: ExactCancellationResolution;
      try {
        resolution = await resolveExactCancellation(
          runtime,
          response.operation.operationId,
          dependencies,
        );
      } catch {
        throw new WalletOperationError("runtime_state_unavailable");
      }
      if (resolution.kind === "transition_committed" ||
        dependencies.terminal.interruptSignal.aborted) {
        resolvedOperation = resolution.operation;
      } else {
        throw error;
      }
    }
    if (resolvedOperation === undefined) {
      if (decision === "interrupt" || decision === "decline" ||
        decision === "confirm" && dependencies.terminal.interruptSignal.aborted) {
        resolvedOperation = (await resolveExactCancellation(
          runtime,
          response.operation.operationId,
          dependencies,
        )).operation;
      } else if (decision === "confirm") {
        response = await confirmOperation(runtime, response.operation);
      }
    }
  }
  const operation = resolvedOperation ??
    (isWalletOperationTerminalState(response.operation.state)
      ? response.operation
      : await waitForTerminalOperation(runtime, response, dependencies));
  const failure = operationFailure(operation);
  if (failure !== undefined) throw new CliApplicationFailure(failure);
  writeOperationHuman(dependencies.terminal, operation);
  if (
    kind === "connect" &&
    operation.result?.outcome === "connected" &&
    runtime.ownerState === "owner"
  ) {
    dependencies.terminal.writeOutput(
      "WalletConnect coordinator active. Press Ctrl+C to stop without disconnecting the stored session.\n",
    );
    await waitForInterrupt(dependencies.terminal.interruptSignal);
  }
};

const startRuntimeForCommand = async (
  runtime: CliRuntimePort,
  signal: AbortSignal,
): Promise<"started" | "stopped"> => {
  if (signal.aborted) {
    await runtime.stop();
    return "stopped";
  }
  const starting = runtime.start();
  const decision = await raceWithInterrupt(() => starting, signal);
  if (decision.kind === "completed" && !signal.aborted) return "started";

  const stopping = runtime.stop();
  const [startResult, stopResult] = await Promise.allSettled([starting, stopping]);
  if (stopResult.status === "rejected") throw stopResult.reason;
  if (
    startResult.status === "rejected" &&
    !(startResult.reason instanceof RuntimeOperationError &&
      startResult.reason.failure.error.code === "request_aborted")
  ) throw startResult.reason;
  return "stopped";
};

const reportFailure = (
  failure: ApplicationFailure,
  json: boolean,
  terminal: CliTerminalPort,
): number => {
  if (json) writeCanonical(terminal, failure);
  else terminal.writeError(`${failure.error.code}: ${failure.error.message}\n`);
  return walletInterfaceErrorMappings.get(failure.error.code).cliExitCode;
};

const normalizeCliFailure = (error: unknown): ApplicationFailure =>
  error instanceof CliApplicationFailure
    ? error.failure
    : error instanceof WalletOperationError
      ? error.failure
      : error instanceof RuntimeOperationError
        ? normalizeWalletError(error).failure
        : createWalletFailure("internal_error");

const runCommand = async (
  command: CliCommand,
  runtime: CliRuntimePort,
  dependencies: CliDependencies,
): Promise<void> => {
  switch (command.kind) {
    case "status": {
      const connection = await readConnection(runtime);
      if (command.json) writeCanonical(dependencies.terminal, connection);
      else writeConnectionHuman(dependencies.terminal, connection.data);
      return;
    }
    case "operation": {
      const response = await getOperation(runtime, command.operationId);
      if (command.json) writeCanonical(dependencies.terminal, response.operation);
      else writeOperationHuman(dependencies.terminal, response.operation);
      return;
    }
    case "cancel": {
      const response = await cancelledResponse(runtime, command.operationId, dependencies);
      writeOperationHuman(dependencies.terminal, response.operation);
      return;
    }
    case "connect":
    case "disconnect":
      await runWalletTransition(runtime, command.kind, dependencies);
  }
};

export const runCli = async (
  argumentsInput: readonly string[],
  dependencies: CliDependencies,
): Promise<number> => {
  let command: CliCommand | undefined;
  let runtime: CliRuntimePort | undefined;
  let runtimeStopped = false;
  let failure: ApplicationFailure | undefined;
  let runtimeCleanupFailed = false;
  const retainFailure = (error: unknown): void => {
    failure ??= normalizeCliFailure(error);
  };
  try {
    command = parseCommand(argumentsInput);
    if (!dependencies.terminal.inputIsTTY || !dependencies.terminal.outputIsTTY) {
      throw new WalletOperationError("interactive_terminal_required");
    }
    if (!dependencies.terminal.interruptSignal.aborted) {
      runtime = await dependencies.createRuntime();
      const startResult = await startRuntimeForCommand(runtime, dependencies.terminal.interruptSignal);
      runtimeStopped = startResult === "stopped";
      if (startResult === "started" && !dependencies.terminal.interruptSignal.aborted) {
        await runCommand(command, runtime, dependencies);
      }
    }
  } catch (error) {
    retainFailure(error);
  } finally {
    if (runtime !== undefined && !runtimeStopped) {
      try { await runtime.stop(); }
      catch (error) {
        runtimeCleanupFailed = true;
        retainFailure(error);
      }
    }
    try { dependencies.terminal.dispose(); }
    catch (error) { retainFailure(error); }
  }
  if (failure === undefined) return 0;
  let exitCode: number;
  try {
    exitCode = reportFailure(failure, command?.json ?? false, dependencies.terminal);
  } catch {
    exitCode = walletInterfaceErrorMappings.get("internal_error").cliExitCode;
  }
  if (runtimeCleanupFailed) dependencies.terminateProcess(exitCode);
  return exitCode;
};

const terminationSignals = Object.freeze(["SIGINT", "SIGTERM", "SIGHUP"] as const);

export const createProcessTerminal = (
  host: CliProcessPort = process,
): CliTerminalPort => {
  let readline: ReadlineInterface | undefined;
  const qrDisplay = createTerminalQrDisplay((value) => { host.stdout.write(value); });
  const interruptController = new AbortController();

  const closeReadline = (): unknown | undefined => {
    const active = readline;
    readline = undefined;
    if (active === undefined) return undefined;
    try {
      active.close();
      return undefined;
    } catch (error) {
      return error;
    }
  };

  const restoreTerminal = (): unknown | undefined => {
    let firstError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        qrDisplay.hide();
        return undefined;
      } catch (error) {
        firstError ??= error;
      }
    }
    return firstError;
  };

  const requestInterrupt = (): void => {
    interruptController.abort();
    closeReadline();
  };
  const signalListeners = new Map<(typeof terminationSignals)[number], () => void>();
  for (const signal of terminationSignals) {
    const listener = (): void => requestInterrupt();
    signalListeners.set(signal, listener);
    host.on(signal, listener);
  }
  const onExit = (): void => { restoreTerminal(); };
  host.on("exit", onExit);

  let disposed = false;
  return Object.freeze({
    inputIsTTY: host.stdin.isTTY === true,
    outputIsTTY: host.stdout.isTTY === true,
    get columns(): number | undefined { return host.stdout.columns; },
    get rows(): number | undefined { return host.stdout.rows; },
    interruptSignal: interruptController.signal,
    writeOutput(value: string): void { host.stdout.write(value); },
    writeError(value: string): void { host.stderr.write(value); },
    showQr: (rendering: TerminalQrRendering) => qrDisplay.show(rendering),
    hideQr: () => qrDisplay.hide(),
    async readConfirmation(prompt: string): Promise<boolean> {
      const previousReadlineError = closeReadline();
      if (previousReadlineError !== undefined) throw previousReadlineError;
      const active = createInterface({ input: host.stdin, output: host.stdout, terminal: true });
      readline = active;
      try {
        const answer = await active.question(prompt);
        return /^(?:y|yes)$/i.test(answer.trim());
      } finally {
        active.close();
        if (readline === active) readline = undefined;
      }
    },
    dispose(): void {
      if (disposed) return;
      const readlineError = closeReadline();
      const restoreError = restoreTerminal();
      if (restoreError === undefined) {
        for (const [signal, listener] of signalListeners) {
          host.removeListener(signal, listener);
        }
        host.removeListener("exit", onExit);
        disposed = true;
      }
      if (readlineError !== undefined) throw readlineError;
      if (restoreError !== undefined) throw restoreError;
    },
  });
};

const createDefaultDependencies = (): CliDependencies => Object.freeze({
  createRuntime: () => LocalRuntime.create({ walletApplicationFactory: createWalletOwnerApplication }),
  terminal: createProcessTerminal(),
  waitForPoll: () => new Promise<void>((resolvePoll) => { setTimeout(resolvePoll, 100); }),
  terminateProcess: (exitCode: number) => { exitProcess(exitCode); },
});

const isDirectExecution = (): boolean => {
  const executablePath = process.argv[1];
  if (executablePath === undefined) return false;
  try {
    return realpathSync(resolve(executablePath)) === realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
};

if (isDirectExecution()) {
  void runCli(process.argv.slice(2), createDefaultDependencies()).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
