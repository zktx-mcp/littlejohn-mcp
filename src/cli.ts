#!/usr/bin/env node

import { parseExchangeCliCommand, runExchangeCliCommand, type ExchangeCliCommand } from "./interfaces/cli-exchange.js";
import { parseSigningCliCommand, runSigningCliCommand, type SigningCliCommand } from "./interfaces/cli-signing.js";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import {canonicalJsonStringify, captureCanonicalJson, createApplicationFailure, getCapabilityDefinitionSnapshot, parseCapabilitySuccess, type ApplicationFailure, type CapabilitySuccess} from "./core/index.js";
import {type WalletConnectionData} from "./wallet/connection-contract.js";
import { createChainOwnerApplication } from "./chain/application.js";
import {
  createInterfaceOwnerApplication,
  createStdioMcp,
  cliHelpText,
  loadMcpAppResource,
  LocalOperationClient,
  parseReadCliCommand,
  runReadCliCommand,
  walletConnectionInterface,
  type DeliveryUnknown,
  type ReadCliCommand,
  parseMarketCliCommand,
  runMarketCliCommand,
  type MarketCliCommand,
  type McpServerRuntimePort,
  type StdioMcpOwner,
} from "./interfaces/index.js";
import {
  constrainInterfaceFailure,
  dispatchCanonical,
} from "./interfaces/http-client.js";
import { readCliDecision } from "./interfaces/cli-operation.js";
import {
  operationInterfaceBindings,
  walletOperationPresentationIdentity,
} from "./interfaces/operation-bindings.js";
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
  getInvalidRpcConfigurationError,
  getRuntimeStateResetRequiredError,
  runtimeInterfaceErrorMappings,
  runtimeStateResetRequiredCode,
  type RuntimeStateResetRequiredError,
} from "./runtime/index.js";
import {
  isProcessTerminalRequiredError,
  type RuntimeShutdownOutcome,
} from "./runtime/shutdown.js";
import { getRuntimeOperationFailure } from "./runtime/errors.js";
import { createWalletOwnerApplication } from "./wallet/application.js";
import {
  createWalletOperationCancellation,
  parseWalletOperationId,
  type WalletManagementOperation,
  type WalletOperationPresentation,
  type WalletReview,
  type WalletReviewResult,
} from "./wallet/contracts.js";
import {
  isWalletOperationCancellableState,
  isWalletOperationTerminalState,
  type WalletOperationKind,
} from "./wallet/operation-state.js";
import {
  WalletOperationError,
  createWalletFailure,
  getWalletOperationFailure,
} from "./wallet/errors.js";
import {
  createTerminalQrDisplay,
  renderTerminalQr,
  type TerminalQrRendering,
} from "./wallet/terminal-qr.js";

type WalletConnectionSuccess = CapabilitySuccess<WalletConnectionData>;

export interface CliRuntimePort extends McpServerRuntimePort {
  readonly ownerState: LocalRuntime["ownerState"];
  start(): Promise<void>;
  stop(): Promise<RuntimeShutdownOutcome>;
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
  readonly terminal: CliTerminalPort;
  readonly waitForPoll: () => Promise<void>;
  readonly createMcp: (runtime: CliRuntimePort) => StdioMcpOwner;
  readonly settleOutput?: () => Promise<void>;
}

export interface CliRunResult {
  readonly exitCode: number;
  readonly processDisposition: "natural_exit" | "process_exit_required";
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
  if (domain === operationInterfaceBindings.walletConnect.cli?.domain &&
    command === operationInterfaceBindings.walletConnect.cli.command) {
    if (tokens.length !== 0) return invalidInput();
    return Object.freeze({ kind: "connect", json: false });
  }
  if (domain === operationInterfaceBindings.walletDisconnect.cli?.domain &&
    command === operationInterfaceBindings.walletDisconnect.cli.command) {
    if (tokens.length !== 0) return invalidInput();
    return Object.freeze({ kind: "disconnect", json: false });
  }
  if (domain === operationInterfaceBindings.walletOperation.cli?.domain &&
    command === operationInterfaceBindings.walletOperation.cli.command) return parseOperationCommand(tokens);
  if (domain === operationInterfaceBindings.walletCancel.cli?.domain &&
    command === operationInterfaceBindings.walletCancel.cli.command) {
    if (tokens.length !== 1) return invalidInput();
    try {
      return Object.freeze({ kind: "cancel", operationId: parseWalletOperationId(tokens[0]), json: false });
    } catch { return invalidInput(); }
  }
  return invalidInput();
};

const getConnectionChangeReview = async (
  client: LocalOperationClient,
  kind: WalletOperationKind,
): Promise<WalletReviewResult> => resolvedLocalOperation(
  await client.invoke(operationInterfaceBindings.walletReview.identity, { kind }),
);

const getOperation = async (
  client: LocalOperationClient,
  operationId: string,
): Promise<WalletManagementOperation> => resolvedLocalOperation(
  await client.invoke(operationInterfaceBindings.walletOperation.identity, { operationId }),
);

const getOperationPresentation = async (
  client: LocalOperationClient,
  operationId: string,
): Promise<WalletOperationPresentation> => resolvedLocalOperation(
  await client.invoke(walletOperationPresentationIdentity, { operationId }),
);

const decideConnectionChange = async (
  client: LocalOperationClient,
  review: WalletReview,
): Promise<WalletManagementOperation> => resolvedLocalOperation(
  await client.invoke(
    review.kind === "connect"
      ? operationInterfaceBindings.walletConnect.identity
      : operationInterfaceBindings.walletDisconnect.identity,
    { review, initiatedBy: "cli" } as never,
  ),
);

const cancelOperation = async (
  client: LocalOperationClient,
  operation: WalletManagementOperation,
): Promise<WalletManagementOperation> => {
  if (!isWalletOperationCancellableState(operation.state)) {
    throw new CliApplicationFailure(createWalletFailure("state_conflict"));
  }
  return resolvedLocalOperation(
    await client.invoke(operationInterfaceBindings.walletCancel.identity,
      createWalletOperationCancellation(operation)),
  );
};

const readConnection = async (runtime: CliRuntimePort): Promise<WalletConnectionSuccess> => {
  if (walletConnectionInterface.http.method !== "GET") {
    throw new CliApplicationFailure(createWalletFailure("internal_error"));
  }
  const result = constrainInterfaceFailure(await dispatchCanonical(runtime, {
    requestClass: "public_read",
    method: walletConnectionInterface.http.method,
    path: walletConnectionInterface.http.path,
  }, 200, walletConnectionInterface.responseAuthority),
  getCapabilityDefinitionSnapshot(walletConnectionInterface.definition).failureCodes);
  if (!result.ok) throw new CliApplicationFailure(result.failure);
  try {
    return parseCapabilitySuccess(walletConnectionInterface.definition, {}, result.value);
  } catch {
    throw new CliApplicationFailure(createWalletFailure("internal_error"));
  }
};

const writeCanonical = (terminal: CliTerminalPort, value: unknown): void => {
  terminal.writeOutput(`${canonicalJsonStringify(captureCanonicalJson(value))}\n`);
};

const connectionSummary = (connection: WalletConnectionData): string => {
  switch (connection.status) {
    case "connected":
      return `Connected address: ${connection.address}\nChain: ${connection.chainId}\nSession expiry: ${connection.expiresAt}`;
    case "unresolved":
      return `The current wallet state cannot be used.\nWallet sessions found: ${connection.sessionCount}.`;
    case "disconnected":
      return `Disconnected (${connection.reason}).`;
    case "unknown":
      return `Wallet state is unknown (${connection.reason}).`;
  }
};

const writeConnectionHuman = (terminal: CliTerminalPort, connection: WalletConnectionData): void => {
  terminal.writeOutput(`${connectionSummary(connection)}\n`);
};

const walletReviewHuman = (review: WalletReview): string => [
  review.kind === "connect" ? "Connect wallet" : "Disconnect wallet",
  `Chain: ${review.target.chainId}`,
  `Current state: ${connectionSummary(review.precondition.connection)}`,
  `Connection revision: ${review.precondition.connectionRevision}`,
  ...(review.kind === "connect" ? [
    `Required methods: ${review.decision.requiredMethods.join(", ")}`,
    `Requested optional methods: ${review.decision.optionalMethods.join(", ")}`,
    `Required events: ${review.decision.requiredEvents.join(", ")}`,
  ] : [
    "Decision: disconnect the listed WalletConnect sessions from this profile",
    `Session count: ${review.fixedEvidence.sessionSourceIds.length}`,
    ...review.fixedEvidence.sessionSourceIds.map((sourceId) => `Session source: ${sourceId}`),
  ]),
  `Action deadline: ${review.actionExpiresAt}`,
  `Operation ID: ${review.operationId}`,
  `Review digest: ${review.reviewDigest}`,
].join("\n");

const writeOperationHuman = (terminal: CliTerminalPort, operation: WalletManagementOperation): void => {
  terminal.writeOutput([
    `Wallet operation ${operation.operationId}: ${operation.state}`,
    `Action: ${operation.kind}`,
    `Initiated by: ${operation.initiatedBy}`,
    `Review digest: ${operation.review.reviewDigest}`,
    ...(operation.peerRefusalCode === null
      ? []
      : [`Wallet refusal code: ${operation.peerRefusalCode}`]),
    ...(operation.failure === null
      ? []
      : [`Failure: ${operation.failure.error.code}: ${operation.failure.error.message}`]),
    "",
  ].join("\n"));
  if (operation.result !== null) {
    terminal.writeOutput(`Outcome: ${operation.result.outcome}\n`);
    writeConnectionHuman(terminal, operation.result.connection);
  }
};

const cancelledResponse = async (
  client: LocalOperationClient,
  operation: WalletManagementOperation,
  dependencies: CliDependencies,
  initial?: WalletManagementOperation,
): Promise<WalletManagementOperation> => {
  let current = initial ?? await cancelOperation(client, operation);
  for (;;) {
    if (isWalletOperationTerminalState(current.state)) return current;
    await dependencies.waitForPoll();
    current = await getOperation(client, operation.operationId);
  }
};

type QrPresentation =
  | {
      readonly state: "displayed";
      readonly rendering: TerminalQrRendering;
      readonly terminalColumns: number;
      readonly terminalRows: number;
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
  terminalColumns: number,
  terminalRows: number,
): QrPresentation => {
  terminal.showQr(rendering);
  return Object.freeze({ state: "displayed", rendering, terminalColumns, terminalRows });
};

const clearQr = (terminal: CliTerminalPort, presentation: QrPresentation | undefined): void => {
  if (presentation?.state !== "displayed") return;
  terminal.hideQr();
};

const synchronizeQr = (
  operationPresentation: WalletOperationPresentation,
  terminal: CliTerminalPort,
  presentation: QrPresentation | undefined,
): QrPresentation | undefined => {
  if (operationPresentation.qr === undefined) {
    clearQr(terminal, presentation);
    return undefined;
  }
  const rendering = presentation?.rendering ?? renderTerminalQr(operationPresentation.qr);
  const columns = terminalDimension(terminal.columns);
  const rows = terminalDimension(terminal.rows);
  if (columns !== undefined && rows !== undefined && terminalHasSpace(rendering, columns, rows)) {
    return presentation?.state === "displayed" && presentation.terminalColumns === columns && presentation.terminalRows === rows
      ? presentation
      : displayQr(rendering, terminal, columns, rows);
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

type PromiseObservation<Value> =
  | Readonly<{ readonly status: "fulfilled"; readonly value: Value }>
  | Readonly<{ readonly status: "rejected"; readonly reason: unknown }>;

const observePromise = <Value>(promise: Promise<Value>): Promise<PromiseObservation<Value>> =>
  promise.then(
    (value) => Object.freeze({ status: "fulfilled" as const, value }),
    (reason: unknown) => Object.freeze({ status: "rejected" as const, reason }),
  );

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

const isStateConflict = (error: unknown): boolean =>
  (getWalletOperationFailure(error) ?? getCliApplicationFailure(error))?.error.code === "state_conflict";

const observeAuthoritativeTransition = async (
  client: LocalOperationClient,
  operationId: string,
  dependencies: CliDependencies,
): Promise<WalletManagementOperation> => {
  let operation = await getOperation(client, operationId);
  for (;;) {
    if (isWalletOperationTerminalState(operation.state)) return operation;
    await dependencies.waitForPoll();
    operation = await getOperation(client, operationId);
  }
};

const resolveExactCancellation = async (
  client: LocalOperationClient,
  operationId: string,
  dependencies: CliDependencies,
  afterCancellationStarted?: () => void,
): Promise<WalletManagementOperation> => {
  const operation = await getOperation(client, operationId);
  if (isWalletOperationTerminalState(operation.state)) {
    return operation;
  }
  if (!isWalletOperationCancellableState(operation.state)) {
    return await observeAuthoritativeTransition(client, operationId, dependencies);
  }
  const cancellation = cancelOperation(client, operation);
  try { afterCancellationStarted?.(); }
  catch { /* Runtime settlement and final terminal restoration retain authority. */ }
  try {
    const terminal = await cancelledResponse(
      client,
      operation,
      dependencies,
      await cancellation,
    );
    return terminal;
  } catch (error) {
    if (!isStateConflict(error)) throw error;
    return await observeAuthoritativeTransition(client, operationId, dependencies);
  }
};

const cancelRequestedOperation = async (
  client: LocalOperationClient,
  operationId: string,
  dependencies: CliDependencies,
): Promise<WalletManagementOperation> => {
  const operation = await getOperation(client, operationId);
  if (isWalletOperationTerminalState(operation.state)) return operation;
  if (!isWalletOperationCancellableState(operation.state)) {
    throw new CliApplicationFailure(createWalletFailure("state_conflict"));
  }
  return await cancelledResponse(client, operation, dependencies);
};

const waitForTerminalOperation = async (
  client: LocalOperationClient,
  initial: WalletManagementOperation,
  dependencies: CliDependencies,
): Promise<WalletManagementOperation> => {
  let operation = initial;
  let presentation: QrPresentation | undefined;
  const clearPresentation = (): void => {
    try {
      clearQr(dependencies.terminal, presentation);
      presentation = undefined;
    } catch { /* Final terminal disposal retains emergency restoration authority. */ }
  };
  const cancelExactOperation = (): Promise<WalletManagementOperation> =>
    resolveExactCancellation(
      client,
      operation.operationId,
      dependencies,
      clearPresentation,
    );
  try {
    for (;;) {
      if (isWalletOperationTerminalState(operation.state)) {
        clearPresentation();
        return operation;
      }

      let step:
        | Readonly<{ kind: "poll" }>
        | Readonly<{ kind: "interrupt" }>
        | Readonly<{ kind: "failure" }>;
      try {
        if (dependencies.terminal.interruptSignal.aborted) {
          step = Object.freeze({ kind: "interrupt" });
        } else {
          const observation = await raceWithInterrupt(
            () => getOperationPresentation(client, operation.operationId),
            dependencies.terminal.interruptSignal,
          );
          if (observation.kind === "interrupted") {
            step = Object.freeze({ kind: "interrupt" });
          } else {
            operation = observation.result.operation;
            if (isWalletOperationTerminalState(operation.state)) continue;
            presentation = synchronizeQr(
              observation.result,
              dependencies.terminal,
              presentation,
            );
            step = Object.freeze({ kind: await waitDecision(dependencies) });
          }
        }
      } catch {
        step = dependencies.terminal.interruptSignal.aborted
          ? Object.freeze({ kind: "interrupt" })
          : Object.freeze({ kind: "failure" });
      }

      if (step.kind === "interrupt") return await cancelExactOperation();
      if (step.kind === "failure") {
        try { return await cancelExactOperation(); }
        catch (error) {
          if (error instanceof CliDeliveryUnknown) throw error;
          throw new WalletOperationError("runtime_state_unavailable");
        }
      }
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
  client: LocalOperationClient,
  kind: WalletOperationKind,
  dependencies: CliDependencies,
): Promise<void> => {
  const readConnectedAssets = async (): Promise<void> => {
    const exitCode = await runReadCliCommand(
      runtime,
      client,
      parseReadCliCommand(["read", "assets", "--active"]),
      dependencies.terminal,
      dependencies.terminal.interruptSignal,
    );
    if (exitCode !== 0) {
      dependencies.terminal.writeError("Retry with: littlejohn read assets --active\n");
    }
  };
  const reviewed = await getConnectionChangeReview(client, kind);
  if (reviewed.status === "current_connection") {
    writeConnectionHuman(dependencies.terminal, reviewed.connection);
    await readConnectedAssets();
    return;
  }
  if (reviewed.status === "already_disconnected") {
    writeConnectionHuman(dependencies.terminal, reviewed.connection);
    return;
  }
  dependencies.terminal.writeOutput(`${walletReviewHuman(reviewed.review)}\n`);
  const decision = await readCliDecision(
    dependencies.terminal,
    kind === "connect" ? "Connect this wallet? [y/N] " : "Disconnect this wallet? [y/N] ",
  );
  if (decision !== "accepted" || dependencies.terminal.interruptSignal.aborted) {
    dependencies.terminal.writeOutput("Declined. No Wallet operation was created.\n");
    return;
  }

  const operation = await decideConnectionChange(client, reviewed.review);
  const terminalOperation = isWalletOperationTerminalState(operation.state)
    ? operation
    : await waitForTerminalOperation(client, operation, dependencies);
  writeOperationHuman(dependencies.terminal, terminalOperation);
  const failure = operationFailure(terminalOperation);
  if (failure !== undefined) throw new CliApplicationFailure(failure);
  if (terminalOperation.result?.outcome === "connected") {
    await readConnectedAssets();
  }
  if (
    terminalOperation.result?.outcome === "connected" &&
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
): Promise<
  | Readonly<{ readonly kind: "started" }>
  | Readonly<{
      readonly kind: "stopped";
      readonly stop: PromiseObservation<RuntimeShutdownOutcome>;
      readonly start?: PromiseObservation<void>;
    }>
> => {
  if (signal.aborted) {
    return Object.freeze({ kind: "stopped", stop: await observePromise(runtime.stop()) });
  }
  const starting = runtime.start();
  const decision = await raceWithInterrupt(() => starting, signal);
  if (decision.kind === "completed" && !signal.aborted) {
    return Object.freeze({ kind: "started" });
  }

  const stopping = runtime.stop();
  const [start, stop] = await Promise.all([
    observePromise(starting),
    observePromise(stopping),
  ]);
  return Object.freeze({ kind: "stopped", start, stop });
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
      const operation = await getOperation(client, command.operationId);
      if (command.json) writeCanonical(dependencies.terminal, operation);
      else writeOperationHuman(dependencies.terminal, operation);
      return;
    }
    case "cancel": {
      const terminalOperation = await cancelRequestedOperation(
        client,
        command.operationId,
        dependencies,
      );
      const failure = operationFailure(terminalOperation);
      if (failure !== undefined) throw new CliApplicationFailure(failure);
      writeOperationHuman(dependencies.terminal, terminalOperation);
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
): Promise<CliRunResult> => {
  let command: CliCommand | undefined;
  let readCommand: ReadCliCommand | undefined;
  let tokenCommand: TokenCliCommand | undefined;
  let marketCommand: MarketCliCommand | undefined;
  let exchangeCommand: ExchangeCliCommand | undefined;
  let signingCommand: SigningCliCommand | undefined;
  const mcpMode = argumentsInput.length === 0;
  let runtime: CliRuntimePort | undefined;
  let operationClient: LocalOperationClient | undefined;
  let mcp: StdioMcpOwner | undefined;
  let mcpClosed: Promise<PromiseObservation<void>> | undefined;
  let mcpStart: Promise<PromiseObservation<void>> | undefined;
  let readExitCode: number | undefined;
  let tokenExitCode: number | undefined;
  let marketExitCode: number | undefined;
  let exchangeExitCode: number | undefined;
  let signingExitCode: number | undefined;
  let runtimeStopAttempted = false;
  let processDisposition: CliRunResult["processDisposition"] = "natural_exit";
  let invalidRpcConfigurationFailure: Error | undefined;
  let startupFailure: RuntimeStateResetRequiredError | undefined;
  let failure: ApplicationFailure | undefined;
  let deliveryUnknown: DeliveryUnknown | undefined;
  const retainFailure = (error: unknown): void => {
    if (isProcessTerminalRequiredError(error)) {
      processDisposition = "process_exit_required";
      if (error.primaryFailure !== undefined) retainFailure(error.primaryFailure);
      return;
    }
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
  const retainMcpLifecycleFailure = (): void => {
    failure ??= createApplicationFailure(tokenCatalogErrorRegistry, "internal_error");
  };
  const hasAdmittedFailure = (): boolean =>
    invalidRpcConfigurationFailure !== undefined ||
    startupFailure !== undefined ||
    deliveryUnknown !== undefined ||
    failure !== undefined ||
    (readExitCode !== undefined && readExitCode !== 0) ||
    (tokenExitCode !== undefined && tokenExitCode !== 0) ||
    (marketExitCode !== undefined && marketExitCode !== 0) ||
    (signingExitCode !== undefined && signingExitCode !== 0);
  const retainDependentCleanupFailure = (): void => {
    processDisposition = "process_exit_required";
    if (!hasAdmittedFailure()) retainMcpLifecycleFailure();
  };
  const retainRuntimeStop = (result: PromiseObservation<RuntimeShutdownOutcome>): void => {
    runtimeStopAttempted = true;
    if (result.status === "rejected") {
      processDisposition = "process_exit_required";
      retainFailure(result.reason);
      return;
    }
    processDisposition = result.value.kind === "released"
      ? "natural_exit"
      : "process_exit_required";
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
      try { marketCommand = parseMarketCliCommand(argumentsInput); }
      catch { throw new WalletOperationError("invalid_input"); }
    } else if (!mcpMode && ["exchange", "activity", "uniswap-v4"].includes(argumentsInput[0] ?? "")) {
      try { exchangeCommand = parseExchangeCliCommand(argumentsInput); }
      catch { throw new WalletOperationError("invalid_input"); }
    } else if (!mcpMode && argumentsInput[0] === "signing") {
      try { signingCommand = parseSigningCliCommand(argumentsInput); }
      catch { throw new WalletOperationError("invalid_input"); }
    } else if (!mcpMode) command = parseCommand(argumentsInput);
    if ((exchangeCommand?.kind === "start" || signingCommand?.kind === "start") && (!dependencies.terminal.inputIsTTY || !dependencies.terminal.outputIsTTY)) {
      throw new WalletOperationError("interactive_terminal_required");
    }
    if (command !== undefined &&
      (command.kind === "connect" || command.kind === "disconnect" || command.kind === "cancel") &&
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
      try {
        runtime = await dependencies.createRuntime();
      } catch (error) {
        const configurationFailure = getInvalidRpcConfigurationError(error);
        if (configurationFailure === undefined) throw error;
        invalidRpcConfigurationFailure = configurationFailure;
      }
      if (runtime !== undefined) {
        processDisposition = "process_exit_required";
        const startResult = await startRuntimeForCommand(runtime, dependencies.terminal.interruptSignal);
        if (startResult.kind === "stopped") {
          retainRuntimeStop(startResult.stop);
          if (
            startResult.stop.status === "fulfilled" &&
            startResult.start?.status === "rejected" &&
            getRuntimeOperationFailure(startResult.start.reason)?.error.code !== "request_aborted"
          ) retainFailure(startResult.start.reason);
        }
        if (startResult.kind === "started" && !dependencies.terminal.interruptSignal.aborted) {
          if (mcpMode) {
            mcp = dependencies.createMcp(runtime);
            const closedObservation = observePromise(mcp.closed);
            mcpClosed = closedObservation;
            const startObservation = observePromise(mcp.start());
            mcpStart = startObservation;
            const startDecision = await raceWithInterrupt(
              () => startObservation,
              dependencies.terminal.interruptSignal,
            );
            if (startDecision.kind === "completed") {
              if (startDecision.result.status === "fulfilled") {
                await raceWithInterrupt(
                  () => closedObservation,
                  dependencies.terminal.interruptSignal,
                );
              }
            }
          } else if (readCommand !== undefined) {
            operationClient = new LocalOperationClient({
              ownerSessions: runtime,
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
            marketExitCode = await runMarketCliCommand(
              runtime,
              marketCommand,
              dependencies.terminal,
              dependencies.terminal.interruptSignal,
            );
          } else if (exchangeCommand !== undefined) {
            operationClient = new LocalOperationClient({ ownerSessions: runtime });
            exchangeExitCode = await runExchangeCliCommand(runtime, operationClient, exchangeCommand, dependencies.terminal);
          } else if (signingCommand !== undefined) {
            operationClient = new LocalOperationClient({ ownerSessions: runtime });
            signingExitCode = await runSigningCliCommand(operationClient, signingCommand, dependencies.terminal);
          } else if (command !== undefined) {
            operationClient = new LocalOperationClient({
              ownerSessions: runtime,
            });
            await runCommand(command, runtime, operationClient, dependencies);
          }
        }
      }
    }
  } catch (error) {
    retainFailure(error);
  } finally {
    let dependentReleased = true;
    if (mcp !== undefined) {
      const released = observePromise(mcp.close());
      const [terminal, release] = await Promise.all([
        mcpClosed ?? observePromise(mcp.closed),
        released,
        ...(mcpStart === undefined ? [] : [mcpStart]),
      ]);
      if (terminal.status === "rejected") retainMcpLifecycleFailure();
      if (release.status === "rejected") {
        dependentReleased = false;
        retainDependentCleanupFailure();
      }
    }
    if (operationClient !== undefined) {
      try { await operationClient.close(); }
      catch {
        dependentReleased = false;
        retainDependentCleanupFailure();
      }
    }
    if (runtime !== undefined && !runtimeStopAttempted && dependentReleased) {
      retainRuntimeStop(await observePromise(runtime.stop()));
    }
    try { dependencies.terminal.dispose(); }
    catch (error) { retainFailure(error); }
  }
  let exitCode: number;
  if (invalidRpcConfigurationFailure !== undefined) {
    const mapping = runtimeInterfaceErrorMappings.get("invalid_input");
    dependencies.terminal.writeError(
      `${mapping.code}: ${invalidRpcConfigurationFailure.message}\n`,
    );
    exitCode = mapping.cliExitCode;
  } else if (startupFailure !== undefined) {
    dependencies.terminal.writeError(
      `${runtimeStateResetRequiredCode}: ${startupFailure.message}\n`,
    );
    exitCode = 7;
  } else if (deliveryUnknown !== undefined) {
    const json = tokenCommand?.json ?? command?.json ?? false;
    if (json) writeCanonical(dependencies.terminal, deliveryUnknown);
    else dependencies.terminal.writeError([
      `Delivery unknown for ${deliveryUnknown.action} operation ${deliveryUnknown.operationId}.`,
      "The action may have occurred. Do not repeat it.",
      "Inspect that exact operation before another state change.",
      "",
    ].join("\n"));
    exitCode = deliveryUnknownCliExitCode;
  } else if (failure === undefined) {
    exitCode = signingExitCode ?? exchangeExitCode ?? marketExitCode ?? tokenExitCode ?? readExitCode ?? 0;
  } else {
    try {
      exitCode = reportFailure(
        failure,
        exchangeCommand?.json ?? marketCommand?.json ?? tokenCommand?.json ?? command?.json ?? false,
        dependencies.terminal,
      );
    } catch {
      exitCode = tokenCatalogInterfaceErrorMappings.get("internal_error").cliExitCode;
    }
  }
  if (dependencies.settleOutput !== undefined) {
    try { await dependencies.settleOutput(); }
    catch {
      exitCode = tokenCatalogInterfaceErrorMappings.get("internal_error").cliExitCode;
    }
  }
  return Object.freeze({ exitCode, processDisposition });
};

const terminationSignals = Object.freeze(["SIGINT", "SIGTERM", "SIGHUP"] as const);

export interface CliProcessOutputOwner {
  readonly mcpOutput: Writable;
  writeOutput(value: string): void;
  writeError(value: string): void;
  settle(): Promise<void>;
}

export const createCliProcessOutputOwner = (
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): CliProcessOutputOwner => {
  let accepting = true;
  let firstFailure: unknown;
  let stdoutTail: Promise<void> = Promise.resolve();
  let stderrTail: Promise<void> = Promise.resolve();
  let settleWork: Promise<void> | undefined;

  const retainStreamFailure = (error: unknown): void => { firstFailure ??= error; };
  stdout.on("error", retainStreamFailure);
  stderr.on("error", retainStreamFailure);

  const admit = (
    stream: NodeJS.WritableStream,
    lane: "stdout" | "stderr",
    value: string | Uint8Array,
  ): Promise<void> => {
    if (!accepting) throw new Error("Process output is sealed.");
    const previous = lane === "stdout" ? stdoutTail : stderrTail;
    const work = previous.catch(() => undefined).then(() => new Promise<void>((resolveWrite, rejectWrite) => {
      try {
        stream.write(value, (error?: Error | null) => {
          if (error === undefined || error === null) resolveWrite();
          else rejectWrite(error);
        });
      } catch (error) { rejectWrite(error); }
    }));
    void work.catch(retainStreamFailure);
    if (lane === "stdout") stdoutTail = work;
    else stderrTail = work;
    return work;
  };

  const mcpOutput = new Writable({
    write(chunk, encoding, callback): void {
      let value: string | Uint8Array;
      if (typeof chunk === "string") value = chunk;
      else if (chunk instanceof Uint8Array) value = chunk;
      else value = Buffer.from(chunk, encoding);
      try { void admit(stdout, "stdout", value).then(() => callback(), callback); }
      catch (error) { callback(error as Error); }
    },
  });
  mcpOutput.on("error", (error) => { firstFailure ??= error; });

  const settle = (): Promise<void> => {
    if (settleWork !== undefined) return settleWork;
    settleWork = Promise.resolve().then(async () => {
      await new Promise<void>((resolveFinish) => {
        if (mcpOutput.writableFinished || mcpOutput.destroyed) return resolveFinish();
        const finish = (): void => {
          mcpOutput.off("finish", finish);
          mcpOutput.off("error", finish);
          mcpOutput.off("close", finish);
          resolveFinish();
        };
        mcpOutput.once("finish", finish);
        mcpOutput.once("error", finish);
        mcpOutput.once("close", finish);
        mcpOutput.end();
      });
      accepting = false;
      await Promise.allSettled([stdoutTail, stderrTail]);
      if (firstFailure !== undefined) throw firstFailure;
    });
    return settleWork;
  };

  return Object.freeze({
    mcpOutput,
    writeOutput(value: string): void { void admit(stdout, "stdout", value); },
    writeError(value: string): void { void admit(stderr, "stderr", value); },
    settle,
  });
};

export interface ProcessCliTerminalPort extends CliTerminalPort {
  readonly outputOwner: CliProcessOutputOwner;
}

export const createProcessTerminal = (
  host: CliProcessPort = process,
  outputOwner: CliProcessOutputOwner = createCliProcessOutputOwner(host.stdout, host.stderr),
): ProcessCliTerminalPort => {
  let readline: ReadlineInterface | undefined;
  const qrDisplay = createTerminalQrDisplay((value) => { outputOwner.writeOutput(value); });
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
  let disposed = false;
  return Object.freeze({
    outputOwner,
    inputIsTTY: host.stdin.isTTY === true,
    outputIsTTY: host.stdout.isTTY === true,
    get columns(): number | undefined { return host.stdout.columns; },
    get rows(): number | undefined { return host.stdout.rows; },
    interruptSignal: interruptController.signal,
    writeOutput(value: string): void { outputOwner.writeOutput(value); },
    writeError(value: string): void { outputOwner.writeError(value); },
    showQr: (rendering: TerminalQrRendering) => qrDisplay.show(rendering),
    hideQr: () => qrDisplay.hide(),
    async readLine(prompt: string): Promise<string> {
      const previousReadlineError = closeReadline();
      if (previousReadlineError !== undefined) throw previousReadlineError;
      outputOwner.writeOutput(prompt);
      const active = createInterface({ input: host.stdin, terminal: false });
      readline = active;
      try {
        return await active.question("");
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
        disposed = true;
      }
      if (readlineError !== undefined) throw readlineError;
      if (restoreError !== undefined) throw restoreError;
    },
  });
};

const createDefaultDependencies = (): CliDependencies => {
  const terminal = createProcessTerminal();
  return Object.freeze({
    createRuntime: () => LocalRuntime.create({
      walletApplicationFactory: createWalletOwnerApplication,
      chainApplicationFactory: createChainOwnerApplication,
      interfaceApplicationFactory: createInterfaceOwnerApplication,
    }),
    terminal,
    waitForPoll: () => new Promise<void>((resolvePoll) => { setTimeout(resolvePoll, 500); }),
    createMcp: (runtime: CliRuntimePort) => createStdioMcp(
      runtime,
      process.stdin,
      terminal.outputOwner.mcpOutput,
      loadMcpAppResource(),
    ),
    settleOutput: () => terminal.outputOwner.settle(),
  });
};

const isDirectExecution = (): boolean => {
  const executablePath = process.argv[1];
  if (executablePath === undefined) return false;
  try {
    return realpathSync(resolve(executablePath)) === realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
};

if (isDirectExecution()) {
  void runCli(process.argv.slice(2), createDefaultDependencies()).then((result) => {
    if (result.processDisposition === "process_exit_required") process.exit(result.exitCode);
    else process.exitCode = result.exitCode;
  });
}
