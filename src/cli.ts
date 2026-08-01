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
  getCapabilityDefinitionSnapshot,
  parseCapabilitySuccess,
  type ApplicationFailure,
  type CanonicalJson,
  type CapabilitySuccess,
  type OperationId,
  type WalletConnectionData,
} from "./core/index.js";
import { createChainOwnerApplication } from "./chain/application.js";
import {
  createInterfaceOwnerApplication,
  cliHelpText,
  LocalOperationClient,
  LocalMutationClient,
  normalizeProblemDetailsFailure,
  parseReadCliCommand,
  runReadCliCommand,
  startStdioMcp,
  walletConnectionInterface,
  walletLocalOperationIdentities,
  walletInterfaceBindings,
  type DeliveryUnknown,
  type ReadCliCommand,
  parseReferenceMarketCliCommand,
  runReferenceMarketCliCommand,
  type ReferenceMarketCliCommand,
  type StdioMcpHandle,
} from "./interfaces/index.js";
import { deliveryUnknownCliExitCode } from "./interfaces/delivery-exit.js";
import {
  parseTokenCliCommand,
  runTokenCliCommand,
  tokenCliCommandRequiresInteractiveTerminal,
  type TokenCliCommand,
} from "./interfaces/cli-token.js";
import {
  tokenCatalogErrorRegistry,
  tokenCatalogInterfaceErrorMappings,
} from "./token-catalog/index.js";
import {
  LocalRuntime,
  createOperationId as createRuntimeOperationId,
  getRuntimeStateResetRequiredError,
  runtimeStateResetRequiredCode,
  type RuntimeStateResetRequiredError,
  type RuntimeDispatchRequest,
  type RuntimeDispatchResponse,
  type RuntimeOwnerSession,
} from "./runtime/index.js";
import { getRuntimeOperationFailure } from "./runtime/errors.js";
import { createWalletOwnerApplication } from "./wallet/application.js";
import {
  parseWalletOperationId,
  walletTerminalStateFailureCodes,
  type WalletManagementOperation,
  type WalletOperationResponse,
  type WalletOperationStartResponse,
} from "./wallet/contracts.js";
import {
  isWalletOperationConfirmableState,
  isWalletOperationTerminalState,
  type WalletOperationKind,
} from "./wallet/operation-state.js";
import {
  WalletOperationError,
  createWalletFailure,
  getWalletOperationFailure,
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
  dispatchRuntimeRequest(request: RuntimeDispatchRequest): Promise<RuntimeDispatchResponse>;
  openOwnerSession(signal?: AbortSignal): Promise<RuntimeOwnerSession>;
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
  readLine(prompt: string): Promise<string>;
  dispose(): void;
}

export interface CliDependencies {
  readonly createRuntime: () => Promise<CliRuntimePort>;
  readonly createOperationId: () => OperationId;
  readonly terminal: CliTerminalPort;
  readonly waitForPoll: () => Promise<void>;
  readonly terminateProcess: (exitCode: number) => void;
  readonly startMcp?: (runtime: CliRuntimePort) => Promise<StdioMcpHandle>;
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

type WalletCliCommand =
  | { readonly kind: "status"; readonly json: boolean }
  | { readonly kind: "connect"; readonly json: false }
  | { readonly kind: "disconnect"; readonly json: false }
  | { readonly kind: "operation"; readonly operationId: string; readonly json: boolean }
  | { readonly kind: "cancel"; readonly operationId: string; readonly json: false };

type CliCommand = WalletCliCommand | { readonly kind: "help"; readonly json: false };

const invalidInput = (): never => { throw new WalletOperationError("invalid_input"); };

const cliApplicationFailures = new WeakMap<object, ApplicationFailure>();

class CliApplicationFailure extends Error {
  readonly failure: ApplicationFailure;

  constructor(failure: ApplicationFailure) {
    super(failure.error.message);
    this.name = "CliApplicationFailure";
    this.failure = failure;
    cliApplicationFailures.set(this, failure);
    Object.freeze(this);
  }
}

class CliDeliveryUnknown extends Error {
  readonly delivery: DeliveryUnknown;

  constructor(delivery: DeliveryUnknown) {
    super("The local operation response is unavailable after sending began.");
    this.name = "CliDeliveryUnknown";
    this.delivery = delivery;
    Object.freeze(this);
  }
}

const resolvedLocalOperation = <Success>(
  result: Awaited<ReturnType<LocalOperationClient["invoke"]>>,
): Success => {
  if ("status" in result) throw new CliDeliveryUnknown(result);
  if (!result.ok) throw new CliApplicationFailure(result.failure);
  return result.value as Success;
};

const getCliApplicationFailure = (error: unknown): ApplicationFailure | undefined =>
  typeof error === "object" && error !== null
    ? cliApplicationFailures.get(error)
    : undefined;

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
  if (argumentsInput.length === 1 && argumentsInput[0] === "--help") {
    return Object.freeze({ kind: "help", json: false });
  }
  const [domain, command, ...tokens] = argumentsInput;
  if (command === undefined) return invalidInput();
  if (domain === walletConnectionInterface.cli.domain && command === walletConnectionInterface.cli.command) {
    return Object.freeze({ kind: "status", json: parseJsonFlag(tokens) });
  }
  if (domain === walletInterfaceBindings.connect.cli?.domain &&
    command === walletInterfaceBindings.connect.cli.command) {
    if (tokens.length !== 0) return invalidInput();
    return Object.freeze({ kind: "connect", json: false });
  }
  if (domain === walletInterfaceBindings.disconnect.cli?.domain &&
    command === walletInterfaceBindings.disconnect.cli.command) {
    if (tokens.length !== 0) return invalidInput();
    return Object.freeze({ kind: "disconnect", json: false });
  }
  if (domain === walletInterfaceBindings.operation.cli?.domain &&
    command === walletInterfaceBindings.operation.cli.command) return parseOperationCommand(tokens);
  if (domain === walletInterfaceBindings.cancelOperation.cli?.domain &&
    command === walletInterfaceBindings.cancelOperation.cli.command) {
    if (tokens.length !== 1) return invalidInput();
    try {
      return Object.freeze({ kind: "cancel", operationId: parseWalletOperationId(tokens[0]), json: false });
    } catch { return invalidInput(); }
  }
  return invalidInput();
};

const constrainCliDispatchFailure = (
  failure: ApplicationFailure,
  failureCodes: readonly string[],
): ApplicationFailure => failureCodes.includes(failure.error.code)
  ? failure
  : createWalletFailure("internal_error");

const canonicalFailureFromResponse = (
  response: RuntimeDispatchResponse,
  failureCodes: readonly string[],
): CliApplicationFailure => new CliApplicationFailure(constrainCliDispatchFailure(
  normalizeProblemDetailsFailure(
    response,
    walletErrorRegistry,
    walletInterfaceErrorMappings,
    "runtime_state_unavailable",
  ),
  failureCodes,
));

const execute = async (
  runtime: CliRuntimePort,
  failureCodes: readonly string[],
  request: Omit<RuntimeDispatchRequest, "requestClass">,
): Promise<CanonicalJson> => {
  let response: RuntimeDispatchResponse;
  try {
    response = await runtime.dispatchRuntimeRequest({ requestClass: "local_control", ...request });
  } catch (error) {
    throw new CliApplicationFailure(constrainCliDispatchFailure(
      normalizeWalletError(error).failure,
      failureCodes,
    ));
  }
  if (response.status >= 400) throw canonicalFailureFromResponse(response, failureCodes);
  if (response.status !== 200) {
    throw new CliApplicationFailure(constrainCliDispatchFailure(
      createWalletFailure("runtime_state_unavailable"),
      failureCodes,
    ));
  }
  return response.body;
};

const startOperation = async (
  client: LocalOperationClient,
  kind: WalletOperationKind,
): Promise<WalletOperationStartResponse> => resolvedLocalOperation(
  await client.invoke(walletLocalOperationIdentities.cli[kind], {}),
);

const getOperation = async (
  client: LocalOperationClient,
  operationId: string,
): Promise<WalletOperationResponse> => resolvedLocalOperation(
  await client.invoke(walletLocalOperationIdentities.cli.operation, { operationId }),
);

const confirmOperation = async (
  client: LocalOperationClient,
  operation: WalletManagementOperation,
): Promise<WalletOperationResponse> => resolvedLocalOperation(
  await client.invoke(walletLocalOperationIdentities.cli.confirm, {
    operationId: operation.operationId,
    connectionRevision: operation.connectionRevision,
  }),
);

const cancelOperation = async (
  client: LocalOperationClient,
  operationId: string,
): Promise<WalletOperationResponse> => resolvedLocalOperation(
  await client.invoke(walletLocalOperationIdentities.cli.cancel, { operationId }),
);

const readConnection = async (runtime: CliRuntimePort): Promise<WalletConnectionSuccess> =>
  parseCapabilitySuccess(walletConnectionInterface.definition, {}, await execute(
    runtime,
    getCapabilityDefinitionSnapshot(walletConnectionInterface.definition).failureCodes,
    {
      method: "GET",
      path: walletControlRoutes.connection,
    },
  ));

const writeCanonical = (terminal: CliTerminalPort, value: unknown): void => {
  terminal.writeOutput(`${canonicalJsonStringify(captureCanonicalJson(value))}\n`);
};

const connectionSummary = (connection: WalletConnectionData): string => {
  switch (connection.status) {
    case "connected":
      return `Connected address: ${connection.address}\nChain: ${connection.chainId}\nSession expiry: ${connection.expiresAt}`;
    case "unresolved":
      return `Wallet state is unresolved because ${connection.sessionCount} sessions exist.`;
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
): string => {
  if (operation.kind === "disconnect") {
    return [
      connectionSummary(connection),
      `Connection revision: ${operation.connectionRevision}`,
      "Every existing wallet session for this profile will be disconnected.",
      "Disconnect every existing wallet session? [y/N] ",
    ].join("\n");
  }
  throw new WalletOperationError("runtime_state_unavailable");
};

const cancelledResponse = async (
  client: LocalOperationClient,
  operationId: string,
  dependencies: CliDependencies,
  initial?: WalletOperationResponse,
): Promise<WalletOperationResponse> => {
  let response = initial ?? await cancelOperation(client, operationId);
  for (;;) {
    if (response.operation.state === "cancelled") return response;
    if (isWalletOperationTerminalState(response.operation.state)) {
      throw new WalletOperationError("runtime_state_unavailable");
    }
    await dependencies.waitForPoll();
    response = await getOperation(client, operationId);
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
  (getWalletOperationFailure(error) ?? getCliApplicationFailure(error))?.error.code === "state_conflict";

const observeAuthoritativeTransition = async (
  client: LocalOperationClient,
  operationId: string,
  dependencies: CliDependencies,
): Promise<WalletManagementOperation> => {
  let response = await getOperation(client, operationId);
  for (;;) {
    if (isWalletOperationTerminalState(response.operation.state)) return response.operation;
    await dependencies.waitForPoll();
    response = await getOperation(client, operationId);
  }
};

const resolveExactCancellation = async (
  client: LocalOperationClient,
  operationId: string,
  dependencies: CliDependencies,
  afterCancellationStarted?: () => void,
): Promise<ExactCancellationResolution> => {
  const cancellation = cancelOperation(client, operationId);
  try { afterCancellationStarted?.(); }
  catch { /* Runtime settlement and final terminal restoration retain authority. */ }
  try {
    const cancelled = await cancelledResponse(
      client,
      operationId,
      dependencies,
      await cancellation,
    );
    return Object.freeze({ kind: "cancelled", operation: cancelled.operation });
  } catch (error) {
    if (!isStateConflict(error)) throw error;
    return Object.freeze({
      kind: "transition_committed",
      operation: await observeAuthoritativeTransition(client, operationId, dependencies),
    });
  }
};

const waitForTerminalOperation = async (
  client: LocalOperationClient,
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
      client,
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
              () => getOperation(client, response.operation.operationId),
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
  if (operation.state === "rejected" || operation.state === "expired") {
    return createWalletFailure(walletTerminalStateFailureCodes[operation.state]);
  }
  return undefined;
};

const runWalletTransition = async (
  runtime: CliRuntimePort,
  client: LocalOperationClient,
  kind: WalletOperationKind,
  dependencies: CliDependencies,
): Promise<void> => {
  const readConnectedAssets = async (): Promise<void> => {
    const exitCode = await runReadCliCommand(
      runtime,
      client,
      parseReadCliCommand(["read", "assets"]),
      dependencies.terminal,
      dependencies.terminal.interruptSignal,
    );
    if (exitCode !== 0) {
      dependencies.terminal.writeError("Retry with: littlejohn read assets\n");
    }
  };
  const startResponse = await startOperation(client, kind);
  if (startResponse.result.status === "current_connection") {
    if (kind !== "connect") throw new WalletOperationError("runtime_state_unavailable");
    writeConnectionHuman(dependencies.terminal, startResponse.result.connection);
    await readConnectedAssets();
    return;
  }
  let response: WalletOperationResponse = Object.freeze({
    operation: startResponse.result.operation,
    ...(startResponse.qr === undefined ? {} : { qr: startResponse.qr }),
  });
  let resolvedOperation: WalletManagementOperation | undefined;
  if (isWalletOperationConfirmableState(response.operation.state)) {
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
            () => dependencies.terminal.readLine(
              confirmationPrompt(response.operation, connection.result.data),
            ),
            dependencies.terminal.interruptSignal,
          );
          decision = confirmation.kind === "interrupted" || dependencies.terminal.interruptSignal.aborted
            ? "interrupt"
            : /^(?:y|yes)$/iu.test(confirmation.result.trim())
              ? "confirm"
              : "decline";
        }
      }
    } catch (error) {
      let resolution: ExactCancellationResolution;
      try {
        resolution = await resolveExactCancellation(
          client,
          response.operation.operationId,
          dependencies,
        );
      } catch (error) {
        if (error instanceof CliDeliveryUnknown) throw error;
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
          client,
          response.operation.operationId,
          dependencies,
        )).operation;
      } else if (decision === "confirm") {
        response = await confirmOperation(client, response.operation);
      }
    }
  }
  const operation = resolvedOperation ??
    (isWalletOperationTerminalState(response.operation.state)
      ? response.operation
      : await waitForTerminalOperation(client, response, dependencies));
  const failure = operationFailure(operation);
  if (failure !== undefined) throw new CliApplicationFailure(failure);
  writeOperationHuman(dependencies.terminal, operation);
  if (operation.result?.outcome === "connected") {
    await readConnectedAssets();
  }
  if (
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
    getRuntimeOperationFailure(startResult.reason)?.error.code !== "request_aborted"
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
  return tokenCatalogInterfaceErrorMappings.get(failure.error.code).cliExitCode;
};

const normalizeCliFailure = (error: unknown): ApplicationFailure =>
  getCliApplicationFailure(error) ??
  getWalletOperationFailure(error) ??
  getRuntimeOperationFailure(error) ??
  createApplicationFailure(tokenCatalogErrorRegistry, "internal_error");

const runCommand = async (
  command: WalletCliCommand,
  runtime: CliRuntimePort,
  client: LocalOperationClient,
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
      const response = await getOperation(client, command.operationId);
      if (command.json) writeCanonical(dependencies.terminal, response.operation);
      else writeOperationHuman(dependencies.terminal, response.operation);
      return;
    }
    case "cancel": {
      const response = await cancelledResponse(client, command.operationId, dependencies);
      writeOperationHuman(dependencies.terminal, response.operation);
      return;
    }
    case "connect":
    case "disconnect":
      await runWalletTransition(runtime, client, command.kind, dependencies);
  }
};

export const runCli = async (
  argumentsInput: readonly string[],
  dependencies: CliDependencies,
): Promise<number> => {
  let command: CliCommand | undefined;
  let readCommand: ReadCliCommand | undefined;
  let tokenCommand: TokenCliCommand | undefined;
  let marketCommand: ReferenceMarketCliCommand | undefined;
  const mcpMode = argumentsInput.length === 0;
  let runtime: CliRuntimePort | undefined;
  let operationClient: LocalOperationClient | undefined;
  let mutationClient: LocalMutationClient | undefined;
  let mcp: StdioMcpHandle | undefined;
  let readExitCode: number | undefined;
  let tokenExitCode: number | undefined;
  let marketExitCode: number | undefined;
  let runtimeStopped = false;
  let startupFailure: RuntimeStateResetRequiredError | undefined;
  let failure: ApplicationFailure | undefined;
  let deliveryUnknown: DeliveryUnknown | undefined;
  let runtimeCleanupFailed = false;
  const retainFailure = (error: unknown): void => {
    const resetRequired = getRuntimeStateResetRequiredError(error);
    if (resetRequired !== undefined) {
      startupFailure ??= resetRequired;
      return;
    }
    if (error instanceof CliDeliveryUnknown) {
      deliveryUnknown ??= error.delivery;
      return;
    }
    failure ??= normalizeCliFailure(error);
  };
  try {
    if (
      !mcpMode &&
      (argumentsInput[0] === "read" || argumentsInput[0] === "uniswap-v2")
    ) {
      try { readCommand = parseReadCliCommand(argumentsInput); }
      catch { throw new WalletOperationError("invalid_input"); }
    } else if (!mcpMode && argumentsInput[0] === "token") {
      try { tokenCommand = parseTokenCliCommand(argumentsInput); }
      catch { throw new WalletOperationError("invalid_input"); }
    } else if (!mcpMode && argumentsInput[0] === "market") {
      try { marketCommand = parseReferenceMarketCliCommand(argumentsInput); }
      catch { throw new WalletOperationError("invalid_input"); }
    } else if (!mcpMode) command = parseCommand(argumentsInput);
    if (command !== undefined && command.kind !== "help" &&
      (!dependencies.terminal.inputIsTTY || !dependencies.terminal.outputIsTTY)) {
      throw new WalletOperationError("interactive_terminal_required");
    }
    if (tokenCommand !== undefined && tokenCliCommandRequiresInteractiveTerminal(tokenCommand) &&
      (!dependencies.terminal.inputIsTTY || !dependencies.terminal.outputIsTTY)) {
      throw new WalletOperationError("interactive_terminal_required");
    }
    if (command?.kind === "help") {
      dependencies.terminal.writeOutput(cliHelpText);
    } else if (!dependencies.terminal.interruptSignal.aborted) {
      runtime = await dependencies.createRuntime();
      const startResult = await startRuntimeForCommand(runtime, dependencies.terminal.interruptSignal);
      runtimeStopped = startResult === "stopped";
      if (startResult === "started" && !dependencies.terminal.interruptSignal.aborted) {
        if (mcpMode) {
          if (dependencies.startMcp === undefined) throw new WalletOperationError("internal_error");
          mcp = await dependencies.startMcp(runtime);
          const decision = await raceWithInterrupt(() => mcp?.closed ?? Promise.resolve(),
            dependencies.terminal.interruptSignal);
          if (decision.kind === "interrupted") await mcp.close();
        } else if (readCommand !== undefined) {
          operationClient = new LocalOperationClient({
            ownerSessions: runtime,
            createOperationId: dependencies.createOperationId,
          });
          readExitCode = await runReadCliCommand(
            runtime,
            operationClient,
            readCommand,
            dependencies.terminal,
            dependencies.terminal.interruptSignal,
          );
        } else if (tokenCommand !== undefined) {
          operationClient = new LocalOperationClient({
            ownerSessions: runtime,
            createOperationId: dependencies.createOperationId,
          });
          tokenExitCode = await runTokenCliCommand(runtime, operationClient, tokenCommand, Object.freeze({
            inputIsTTY: dependencies.terminal.inputIsTTY,
            outputIsTTY: dependencies.terminal.outputIsTTY,
            interruptSignal: dependencies.terminal.interruptSignal,
            writeOutput: (value: string) => { dependencies.terminal.writeOutput(value); },
            writeError: (value: string) => { dependencies.terminal.writeError(value); },
            readLine: (prompt: string) => dependencies.terminal.readLine(prompt),
          }));
        } else if (marketCommand !== undefined) {
          mutationClient = new LocalMutationClient(runtime);
          marketExitCode = await runReferenceMarketCliCommand(
            runtime,
            mutationClient,
            marketCommand,
            dependencies.terminal,
            dependencies.terminal.interruptSignal,
          );
        } else if (command !== undefined) {
          operationClient = new LocalOperationClient({
            ownerSessions: runtime,
            createOperationId: dependencies.createOperationId,
          });
          await runCommand(command, runtime, operationClient, dependencies);
        }
      }
    }
  } catch (error) {
    retainFailure(error);
  } finally {
    if (mcp !== undefined) {
      try { await mcp.close(); }
      catch (error) { retainFailure(error); }
    }
    if (operationClient !== undefined) {
      try { await operationClient.close(); }
      catch (error) { retainFailure(error); }
    }
    if (mutationClient !== undefined) {
      try { await mutationClient.close(); }
      catch (error) { retainFailure(error); }
    }
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
  if (startupFailure !== undefined) {
    dependencies.terminal.writeError(
      `${runtimeStateResetRequiredCode}: ${startupFailure.message}\n`,
    );
    return 7;
  }
  if (deliveryUnknown !== undefined) {
    const json = tokenCommand?.json ?? command?.json ?? false;
    if (json) writeCanonical(dependencies.terminal, deliveryUnknown);
    else dependencies.terminal.writeError([
      `Delivery unknown for ${deliveryUnknown.action} operation ${deliveryUnknown.operationId}.`,
      "The action may have occurred. Do not repeat it.",
      "Inspect that exact operation before another state change.",
      "",
    ].join("\n"));
    return deliveryUnknownCliExitCode;
  }
  if (failure === undefined) return marketExitCode ?? tokenExitCode ?? readExitCode ?? 0;
  let exitCode: number;
  try {
    exitCode = reportFailure(
      failure,
      marketCommand?.json ?? tokenCommand?.json ?? command?.json ?? false,
      dependencies.terminal,
    );
  } catch {
    exitCode = tokenCatalogInterfaceErrorMappings.get("internal_error").cliExitCode;
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
    async readLine(prompt: string): Promise<string> {
      const previousReadlineError = closeReadline();
      if (previousReadlineError !== undefined) throw previousReadlineError;
      const active = createInterface({ input: host.stdin, output: host.stdout, terminal: true });
      readline = active;
      try {
        return await active.question(prompt);
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
  createRuntime: () => LocalRuntime.create({
    walletApplicationFactory: createWalletOwnerApplication,
    chainApplicationFactory: createChainOwnerApplication,
    interfaceApplicationFactory: createInterfaceOwnerApplication,
  }),
  createOperationId: createRuntimeOperationId,
  terminal: createProcessTerminal(),
  waitForPoll: () => new Promise<void>((resolvePoll) => { setTimeout(resolvePoll, 100); }),
  terminateProcess: (exitCode: number) => { exitProcess(exitCode); },
  startMcp: (runtime: CliRuntimePort) => startStdioMcp(runtime),
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
