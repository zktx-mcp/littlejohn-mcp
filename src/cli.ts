#!/usr/bin/env node
import { presentationCopy as copy, statusCopy, connectionCopy, connectionStatusCopy, walletOperationCopy, networkText, permissionText, failureText, deliveryUnknownText } from "./interfaces/presentation-copy.js";
import { runtimeCliCommandIdentities } from "./runtime/management-contract.js";
import { RuntimeClient } from "./runtime/client.js";
import { parseRuntimeManagementCommand, runRuntimeManagement, type RuntimeManagementCommand, type RuntimeManagementCall } from "./runtime/management-client.js";
import {walletAccountBindings} from "./interfaces/wallet-account-bindings.js";
import type {WalletAccountSelection} from "./wallet/account-selection-contract.js";
import {productChainId, productIdentifier} from "./registry/client.js";
import {readWalletDisconnectTargets} from "./wallet/disconnect-target-reader.js";
import type {WalletDisconnectTarget} from "./wallet/operation-contract.js";

import { parseExchangeCliCommand, runExchangeCliCommand, type ExchangeCliCommand } from "./interfaces/cli-exchange.js";
import { parseSigningCliCommand, runSigningCliCommand, type SigningCliCommand, type SigningCliOutputPort } from "./interfaces/cli-signing.js";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import {canonicalJsonStringify, captureCanonicalJson, createApplicationFailure, getCapabilityDefinitionSnapshot, parseCapabilitySuccess, type ApplicationFailure, type CapabilitySuccess} from "./core/index.js";
import {type WalletConnectionData} from "./wallet/connection-contract.js";
import {
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
import { getRuntimeOperationFailure, RuntimeOperationError } from "./runtime/errors.js";
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
import {WalletOperationError, createWalletFailure, getWalletOperationFailure} from "./wallet/operation-error.js";
import {
  createTerminalQrDisplay,
  renderTerminalQr,
  type TerminalQrRendering,
} from "./wallet/terminal-qr.js";

type WalletConnectionSuccess = CapabilitySuccess<WalletConnectionData>;

export interface CliRuntimePort extends McpServerRuntimePort {
  readonly startupFailure?: Promise<unknown>;
  start(): Promise<void>;
  stop(): Promise<RuntimeShutdownOutcome>;
}

export interface CliTerminalPort extends SigningCliOutputPort {
  readonly inputIsTTY: boolean;
  readonly outputIsTTY: boolean;
  readonly columns: number | undefined;
  readonly rows: number | undefined;
  readonly interruptSignal: AbortSignal;
  writeOutput(value: string): void;
  writeError(value: string): void;
  showQr(rendering: TerminalQrRendering, expiresAt: string): Promise<"written" | "unavailable">;
  hideQr(): void;
  readLine(prompt: string, signal?: AbortSignal): Promise<string>;
  dispose(): void;
}

export interface CliDependencies {
  readonly createRuntime: () => Promise<CliRuntimePort>;
  readonly terminal: CliTerminalPort;
  readonly waitForPoll: () => Promise<void>;
  readonly createMcp: (runtime: CliRuntimePort) => StdioMcpOwner;
  readonly settleOutput?: () => Promise<void>;
  readonly runRuntimeManagement?: typeof runRuntimeManagement;
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
  | { readonly kind: "account_selection"; readonly json: boolean }
  | { readonly kind: "select_account"; readonly json: false }
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
  if (domain === walletAccountBindings.get.cli.domain && command === walletAccountBindings.get.cli.command) {
    return Object.freeze({kind: "account_selection", json: parseJsonFlag(tokens)});
  }
  if (domain === walletAccountBindings.select.cli.domain && command === walletAccountBindings.select.cli.command) {
    if (tokens.length !== 0) return invalidInput();
    return Object.freeze({kind: "select_account", json: false});
  }
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
  const value = connectionStatusCopy(connection);
  return [value.label, value.message,
    ...(connection.status === "connected" ? connection.namespaces.flatMap(namespace => [
      ...namespace.accounts.map(account => `${copy.label.account}: ${account}`),
      `${copy.label.approvedPermissions}: ${namespace.methods.filter(method => Object.hasOwn(copy.permission, method)).map(permissionText).join(", ")}`,
      ...(namespace.methods.some(method => !Object.hasOwn(copy.permission, method)) ? [`${copy.label.otherPermissions}: ${namespace.methods.filter(method => !Object.hasOwn(copy.permission, method)).join(", ")}`] : []),
    ]) : connection.status === "unresolved" && BigInt(connection.sessionCount) > 1n ? [copy.scope.multipleConnections] : []),
  ].join("\n");
};
const writeConnectionHuman = (terminal: CliTerminalPort, connection: WalletConnectionData): void => {
  terminal.writeOutput(`${connectionSummary(connection)}\n`);
};
const walletReviewHuman = (review: WalletReview, targets: readonly WalletDisconnectTarget[]): string => [
  review.kind === "connect" ? copy.action.connect : copy.action.disconnect,
  `${copy.label.network}: ${networkText(review.target.chainId)}`,
  ...(review.kind === "connect" ? [copy.scope.connect,
    `${copy.label.required}: ${review.decision.requiredMethods.map(permissionText).join(", ")}`,
    `${copy.label.optional}: ${review.decision.optionalMethods.map(permissionText).join(", ")}`,
  ] : [copy.scope.disconnect, ...targets.flatMap(target => [`${copy.label.wallet}: ${target.sourceId}`,
    target.status === "available" ? connectionSummary(target.connection) : `${copy.label.connectionDetails}: ${copy.label.unavailable} (${target.reason})`])]),
  `${copy.label.availableUntil}: ${review.actionExpiresAt}`,
].join("\n");
const writeOperationHuman = (terminal: CliTerminalPort, operation: WalletManagementOperation): void => {
  const value = walletOperationCopy(operation.state, operation.kind);
  terminal.writeOutput(`${operation.failure === null ? `${value.label}\n${value.message}` : failureText(operation.failure)}\n${copy.label.network}: ${networkText(operation.review.target.chainId)}\n`);
  if (operation.state === "failed" && operation.review.kind === "connect") terminal.writeOutput(`${copy.label.yourRequest}\n${walletReviewHuman(operation.review, [])}\n`);
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
      readonly state: "requested";
      readonly delivery: { status: "pending" | "written" | "unavailable" };
      readonly minimum: TerminalQrRendering["minimum"];
      readonly terminalColumns: number;
      readonly terminalRows: number;
    }
  | {
      readonly state: "waiting_for_space";
      readonly minimum: TerminalQrRendering["minimum"];
      readonly terminalColumns: number | undefined;
      readonly terminalRows: number | undefined;
    };

const terminalDimension = (value: number | undefined): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;

const terminalHasSpace = (
  rendering: Pick<TerminalQrRendering, "minimum">,
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
  expiresAt: string,
): QrPresentation => {
  const delivery: { status: "pending" | "written" | "unavailable" } = { status: "pending" };
  void terminal.showQr(rendering, expiresAt).then(
    (status) => { delivery.status = status; },
    () => { delivery.status = "unavailable"; },
  );
  return Object.freeze({ state: "requested", delivery, minimum: rendering.minimum, terminalColumns, terminalRows });
};

const clearQr = (terminal: CliTerminalPort, presentation: QrPresentation | undefined): void => {
  if (presentation?.state !== "requested") return;
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
  let rendering = presentation === undefined ? renderTerminalQr(operationPresentation.qr) : undefined;
  const minimum = presentation?.minimum ?? rendering!.minimum;
  const columns = terminalDimension(terminal.columns);
  const rows = terminalDimension(terminal.rows);
  if (columns !== undefined && rows !== undefined && terminalHasSpace({minimum}, columns, rows)) {
    return presentation?.state === "requested" && presentation.delivery.status !== "unavailable" && presentation.terminalColumns === columns && presentation.terminalRows === rows
      ? presentation
      : displayQr(rendering ??= renderTerminalQr(operationPresentation.qr), terminal, columns, rows, operationPresentation.operation.review.actionExpiresAt);
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
        minimum.columns,
        minimum.rows,
      )}`,
      "Resize the terminal to at least the minimum dimensions. The pairing code will appear automatically.",
      "",
    ].join("\n"));
  }
  return Object.freeze({
    state: "waiting_for_space",
    minimum,
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
          let observation: InterruptRace<WalletOperationPresentation> | undefined = await raceWithInterrupt(
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
            observation = undefined;
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
      dependencies.terminal.writeError(`Retry with: ${productIdentifier} read assets --active\n`);
    }
  };
  const reviewed = await getConnectionChangeReview(client, kind);
  if (reviewed.status === "current_connection") {
    dependencies.terminal.writeOutput(`${connectionCopy.connected.message}\n`);
    await readConnectedAssets();
    return;
  }
  if (reviewed.status === "already_disconnected") {
    dependencies.terminal.writeOutput(`Disconnected (${reviewed.reason}).\n`);
    return;
  }
  const targets = reviewed.review.kind === "disconnect" ? await readWalletDisconnectTargets(reviewed.review, {
    async readResultChunk(snapshotId, index) {
      const result = await runtime.presentationSnapshotStore().readResultChunk({snapshotId, index});
      if (result.status !== "available") throw new CliApplicationFailure(createWalletFailure("runtime_state_unavailable"));
      return result.value.bytes;
    },
  }) : [];
  dependencies.terminal.writeOutput(`${walletReviewHuman(reviewed.review, targets)}\n`);
  const decision = await readCliDecision(
    dependencies.terminal,
    `${kind === "connect" ? copy.action.connect : copy.action.disconnect}? [y/N] `,
  );
  if (decision !== "accepted" || dependencies.terminal.interruptSignal.aborted) {
    dependencies.terminal.writeOutput(`${statusCopy.notSubmitted.label}. This CLI request sent no wallet request.\n`);
    return;
  }

  const operation = await decideConnectionChange(client, reviewed.review);
  const terminalOperation = isWalletOperationTerminalState(operation.state)
    ? operation
    : await waitForTerminalOperation(client, operation, dependencies);
  writeOperationHuman(dependencies.terminal, terminalOperation);
  const failure = operationFailure(terminalOperation);
  if (failure !== undefined) throw new CliApplicationFailure(failure);
  if (terminalOperation.result?.kind === "connected") {
    await readConnectedAssets();
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
  target: "human" | "json" | "mcp_stdio",
  terminal: CliTerminalPort,
): number => {
  if (target === "json") writeCanonical(terminal, failure);
  else if (target === "mcp_stdio") terminal.writeError(`${failure.error.code}: ${failure.error.message}\n`);
  else terminal.writeError(`${failureText(failure)}\n`);
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
    case "account_selection":
    case "select_account": {
      const state = resolvedLocalOperation<WalletAccountSelection>(await client.invoke(walletAccountBindings.get.identity,
        {chainId: productChainId}, dependencies.terminal.interruptSignal));
      if (command.json) { writeCanonical(dependencies.terminal, state); return; }
      const terminal = dependencies.terminal;
      terminal.writeOutput(`${copy.title.accountSelection}\n${copy.scope.accountSelection}\n${copy.label.network}: ${networkText(state.chainId)}\n`);
      state.eligibleAccounts.forEach((account, index) => terminal.writeOutput(`${index + 1}. ${account.address}${state.account?.address === account.address ? " (current)" : ""}\n`));
      if (state.eligibleAccounts.length === 0) { terminal.writeOutput("No eligible account is available.\n"); return; }
      if (state.account === null) terminal.writeOutput(`${copy.label.noAccount}\n`);
      if (command.kind === "account_selection") return;
      const answer = (await terminal.readLine("Select an account number, or press Enter to leave unchanged: ", terminal.interruptSignal)).trim();
      if (answer.length === 0 || terminal.interruptSignal.aborted) return;
      if (!/^[1-9][0-9]*$/u.test(answer)) return invalidInput();
      const index = Number(answer) - 1;
      if (!Number.isSafeInteger(index) || index < 0 || index >= state.eligibleAccounts.length) return invalidInput();
      const chosen = state.eligibleAccounts[index]!;
      const result = resolvedLocalOperation<import("./wallet/account-selection-contract.js").WalletSelectAccountSuccess>(await client.invoke(walletAccountBindings.select.identity,
        {connectionId: state.connectionId, chainId: state.chainId, account: chosen, expectedConnectionRevision: state.connectionRevision,
          expectedSelectionRevision: state.selectionRevision}, terminal.interruptSignal));
      terminal.writeOutput(`${statusCopy.accountSelected.label}\n${statusCopy.accountSelected.message}\n${copy.label.account}: ${result.account.address}\n`);
      return;
    }
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
      if (failure !== undefined) {
        if (terminalOperation.kind === "connect" && terminalOperation.state === "failed") {
          writeOperationHuman(dependencies.terminal, terminalOperation);
        }
        throw new CliApplicationFailure(failure);
      }
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
  let runtimeCommand: RuntimeManagementCommand | undefined;
  let runtimeCommandExitCode: number | undefined;
  let runtimeManagementCall: RuntimeManagementCall | undefined;
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
    (signingExitCode !== undefined && signingExitCode !== 0) ||
    (runtimeCommandExitCode !== undefined && runtimeCommandExitCode !== 0);
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
    if (!mcpMode && argumentsInput[0] === runtimeCliCommandIdentities.status.domain) {
      runtimeCommand = parseRuntimeManagementCommand(argumentsInput);
    } else if (
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
      (command.kind === "connect" || command.kind === "disconnect" || command.kind === "cancel" || command.kind === "select_account") &&
      (!dependencies.terminal.inputIsTTY || !dependencies.terminal.outputIsTTY)) {
      throw new WalletOperationError("interactive_terminal_required");
    }
    if (tokenCommand !== undefined && tokenCliCommandRequiresInteractiveTerminal(tokenCommand) &&
      (!dependencies.terminal.inputIsTTY || !dependencies.terminal.outputIsTTY)) {
      throw new WalletOperationError("interactive_terminal_required");
    }
    if (command?.kind === "help") {
      dependencies.terminal.writeOutput(cliHelpText);
    } else if (runtimeCommand !== undefined) {
      if (dependencies.runRuntimeManagement === undefined) throw new RuntimeOperationError("runtime_state_unavailable");
      try { runtimeManagementCall = await dependencies.runRuntimeManagement(runtimeCommand, dependencies.terminal.interruptSignal); }
      catch (error) {
        const configuration = getInvalidRpcConfigurationError(error);
        if (configuration === undefined) throw error;
        invalidRpcConfigurationFailure = configuration;
      }
      if (runtimeManagementCall !== undefined) {
      const result = runtimeManagementCall.result;
      runtimeCommandExitCode = "status" in result && result.status === "shutdown_unconfirmed"
        ? runtimeInterfaceErrorMappings.get("runtime_state_unavailable").cliExitCode : 0;
      const text = runtimeCommand.json ? canonicalJsonStringify(captureCanonicalJson(result)) : "phase" in result
        ? `Runtime ${result.phase}. Owner: ${result.target.ownerInstanceId}. Package: ${result.packageName}@${result.packageVersion}.`
        : result.status === "not_running" ? "No runtime listener is running."
        : result.status === "released" ? `Runtime resources released for ${result.target.ownerInstanceId}.`
        : `Runtime shutdown is unconfirmed for ${result.target.ownerInstanceId}. Read the same result in this profile with: ${productIdentifier} runtime status --shutdown ${result.target.ownerInstanceId}`;
      dependencies.terminal.writeOutput(`${text}\n`);
      }
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
                const mcpCompletion = closedObservation.then(() => ({ kind: "mcp" as const }));
                const startupFailure = runtime.startupFailure;
                const finished = await raceWithInterrupt(() => startupFailure === undefined ? mcpCompletion :
                  Promise.race([mcpCompletion, startupFailure.then(reason => ({ kind: "startup_failure" as const, reason }))]),
                  dependencies.terminal.interruptSignal);
                if (finished.kind === "completed" && finished.result.kind === "startup_failure") retainFailure(finished.result.reason);
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
              readLine: (prompt: string, signal?: AbortSignal) => dependencies.terminal.readLine(prompt, signal),
            }));
          } else if (marketCommand !== undefined) {
            operationClient = new LocalOperationClient({ ownerSessions: runtime });
            marketExitCode = await runMarketCliCommand(
              operationClient,
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
    if (runtimeManagementCall !== undefined) {
      try { await runtimeManagementCall.close(); }
      catch (error) { retainDependentCleanupFailure(); retainFailure(error); }
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
    else dependencies.terminal.writeError(`${deliveryUnknownText(deliveryUnknown)}\n`);
    exitCode = deliveryUnknownCliExitCode;
  } else if (failure === undefined) {
    exitCode = runtimeCommandExitCode ?? signingExitCode ?? exchangeExitCode ?? marketExitCode ?? tokenExitCode ?? readExitCode ?? 0;
  } else {
    try {
      exitCode = reportFailure(
        failure,
        mcpMode ? "mcp_stdio" : (runtimeManagementCall !== undefined ? false :
          runtimeCommand?.json ?? exchangeCommand?.json ?? marketCommand?.json ?? tokenCommand?.json ?? command?.json ?? false) ? "json" : "human",
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

type PrivateWriteResult = "written" | "unavailable";
type PrivateOutput =
  | { readonly kind: "signature"; readonly value: string }
  | { readonly kind: "qr"; readonly rendering: TerminalQrRendering };

export interface CliProcessOutputOwner {
  readonly mcpOutput: Writable;
  writeOutput(value: string): Promise<void>;
  writePrompt(value: string): Promise<void>;
  writeError(value: string): void;
  writeSignature(value: string, expiresAt: string, signal: AbortSignal): Promise<PrivateWriteResult>;
  showQr(rendering: TerminalQrRendering, expiresAt: string, signal: AbortSignal): Promise<PrivateWriteResult>;
  hideQr(): void;
  settle(): Promise<void>;
}

export const createCliProcessOutputOwner = (
  stdout: CliProcessPort["stdout"],
  stderr: NodeJS.WritableStream,
  stdin?: CliProcessPort["stdin"],
): CliProcessOutputOwner => {
  let accepting = true;
  let firstFailure: unknown;
  let stdoutTail: Promise<void> = Promise.resolve();
  let stderrTail: Promise<void> = Promise.resolve();
  let settleWork: Promise<void> | undefined;
  let qrSlot: { dispose(): void } | undefined;
  const retainStreamFailure = (error: unknown): void => { firstFailure ??= error; };
  stdout.on("error", retainStreamFailure);
  stderr.on("error", retainStreamFailure);

  const writeNative = (stream: NodeJS.WritableStream, value: string | Uint8Array): Promise<void> =>
    new Promise<void>((resolveWrite, rejectWrite) => {
      let finished = false;
      const finish = (error?: unknown): void => {
        if (finished) return;
        finished = true;
        stream.off("close", onClose); stream.off("error", onError);
        if (error === undefined || error === null) resolveWrite();
        else { retainStreamFailure(error); rejectWrite(error); }
      };
      const onClose = (): void => finish(new Error("Process output closed before its write completed."));
      const onError = (error: unknown): void => finish(error);
      stream.once("close", onClose); stream.once("error", onError);
      try { stream.write(value, (error?: Error | null) => finish(error)); }
      catch (error) { finish(error); }
    });
  const qrDisplay = createTerminalQrDisplay(value => writeNative(stdout, value));
  const enqueue = (lane: "stdout" | "stderr", write: () => Promise<void>): Promise<void> => {
    if (!accepting) throw new Error("Process output is sealed.");
    const previous = lane === "stdout" ? stdoutTail : stderrTail;
    const work = previous.catch(() => undefined).then(write);
    void work.catch(retainStreamFailure);
    if (lane === "stdout") stdoutTail = work;
    else stderrTail = work;
    return work;
  };
  const hideQr = (): void => {
    const previous = qrSlot; qrSlot = undefined; previous?.dispose();
    // Preserve the existing emergency restoration attempt after a failed write.
    void enqueue("stdout", () => qrDisplay.hide().catch(() => qrDisplay.hide()));
  };
  const privateWrite = (
    payload: PrivateOutput | undefined, expiresAt: string, signal: AbortSignal,
  ): Promise<PrivateWriteResult> => {
    if (!accepting) throw new Error("Process output is sealed.");
    const isQr = payload?.kind === "qr";
    const expiry = Date.parse(expiresAt);
    if (!Number.isFinite(expiry)) throw new TypeError("Private output requires its original expiry.");
    let started = false, finished = false;
    let resolveResult!: (result: PrivateWriteResult) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<PrivateWriteResult>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    const release = (): void => { clearTimeout(timer); signal.removeEventListener("abort", invalidate); };
    const slot = { dispose(): void {
      payload = undefined; release();
      if (!started && !finished) { finished = true; resolveResult("unavailable"); }
    } };
    const invalidate = (): void => {
      if (isQr && qrSlot === slot) hideQr();
      else slot.dispose();
    };
    const timer = setTimeout(invalidate, Math.max(0, expiry - Date.now()));
    timer.unref();
    signal.addEventListener("abort", invalidate, { once: true });
    if (isQr) { const previous = qrSlot; qrSlot = slot; previous?.dispose(); }
    if (signal.aborted || Date.now() >= expiry || stdin?.isTTY !== true || stdout.isTTY !== true) invalidate();
    const work = enqueue("stdout", async () => {
      if (finished) return;
      if (firstFailure !== undefined) throw firstFailure;
      if (signal.aborted || Date.now() >= expiry || stdin?.isTTY !== true || stdout.isTTY !== true ||
          payload === undefined || (payload.kind === "qr" &&
            !terminalHasSpace(payload.rendering, terminalDimension(stdout.columns), terminalDimension(stdout.rows)))) {
        invalidate(); return;
      }
      started = true;
      let pendingWrite: Promise<void>;
      try {
        pendingWrite = payload.kind === "signature"
          ? writeNative(stdout, `Signature: ${payload.value}\n`)
          : qrDisplay.show(payload.rendering);
      } finally {
        payload = undefined;
        if (!isQr) release();
      }
      await pendingWrite;
      finished = true; resolveResult("written");
    });
    void work.catch(error => {
      const rejected = !finished;
      finished = true; slot.dispose();
      if (rejected) rejectResult(error);
    });
    return result;
  };
  const mcpOutput = new Writable({
    write(chunk, encoding, callback): void {
      let value: string | Uint8Array;
      if (typeof chunk === "string") value = chunk;
      else if (chunk instanceof Uint8Array) value = chunk;
      else value = Buffer.from(chunk, encoding);
      try { void enqueue("stdout", () => writeNative(stdout, value)).then(() => callback(), callback); }
      catch (error) { callback(error as Error); }
    },
  });
  mcpOutput.on("error", retainStreamFailure);
  const settle = (): Promise<void> => {
    if (settleWork !== undefined) return settleWork;
    settleWork = Promise.resolve().then(async () => {
      hideQr();
      await new Promise<void>((resolveFinish) => {
        if (mcpOutput.writableFinished || mcpOutput.destroyed) return resolveFinish();
        const finish = (): void => {
          mcpOutput.off("finish", finish); mcpOutput.off("error", finish); mcpOutput.off("close", finish); resolveFinish();
        };
        mcpOutput.once("finish", finish); mcpOutput.once("error", finish); mcpOutput.once("close", finish);
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
    writeOutput: (value: string): Promise<void> => enqueue("stdout", () => writeNative(stdout, value)),
    writePrompt: (value: string): Promise<void> => enqueue("stdout", async () => {
      if (firstFailure !== undefined) throw firstFailure;
      await writeNative(stdout, value);
    }),
    writeError(value: string): void { void enqueue("stderr", () => writeNative(stderr, value)); },
    writeSignature: (value: string, expiry: string, signal: AbortSignal) => privateWrite({kind: "signature", value}, expiry, signal),
    showQr: (rendering: TerminalQrRendering, expiry: string, signal: AbortSignal) => privateWrite({kind: "qr", rendering}, expiry, signal),
    hideQr, settle,
  });
};

export interface ProcessCliTerminalPort extends CliTerminalPort {
  readonly outputOwner: CliProcessOutputOwner;
}

export const createProcessTerminal = (
  host: CliProcessPort = process,
  outputOwner: CliProcessOutputOwner = createCliProcessOutputOwner(host.stdout, host.stderr, host.stdin),
): ProcessCliTerminalPort => {
  let readline: ReadlineInterface | undefined;
  let question: object | undefined;
  let disposed = false;
  const disposal = new AbortController();
  const interruptController = new AbortController();
  const lifetime = (signal?: AbortSignal): AbortSignal => AbortSignal.any([
    interruptController.signal, disposal.signal, ...(signal === undefined ? [] : [signal]),
  ]);
  const requestInterrupt = (): void => { interruptController.abort(); outputOwner.hideQr(); };
  const signalListeners = new Map<(typeof terminationSignals)[number], () => void>();
  for (const signal of terminationSignals) {
    const listener = (): void => requestInterrupt();
    signalListeners.set(signal, listener); host.on(signal, listener);
  }
  return Object.freeze({
    outputOwner,
    get inputIsTTY(): boolean { return host.stdin.isTTY === true; },
    get outputIsTTY(): boolean { return host.stdout.isTTY === true; },
    get columns(): number | undefined { return host.stdout.columns; },
    get rows(): number | undefined { return host.stdout.rows; },
    interruptSignal: interruptController.signal,
    writeOutput(value: string): void { void outputOwner.writeOutput(value); },
    writeError(value: string): void { outputOwner.writeError(value); },
    writeSignature: (value: string, expiresAt: string, signal: AbortSignal) => outputOwner.writeSignature(value, expiresAt, lifetime(signal)),
    showQr: (rendering: TerminalQrRendering, expiresAt: string) => outputOwner.showQr(rendering, expiresAt, lifetime()),
    hideQr: () => outputOwner.hideQr(),
    async readLine(prompt: string, signal?: AbortSignal): Promise<string> {
      if (question !== undefined) throw new Error("Another terminal question is still active.");
      const current = {}; question = current;
      const joined = lifetime(signal);
      try {
        const emitted = await raceWithInterrupt(() => outputOwner.writePrompt(prompt), joined);
        if (emitted.kind === "interrupted" || joined.aborted || disposed) return "";
        if (host.stdin.isTTY !== true || host.stdout.isTTY !== true) throw new Error("A direct question requires a live TTY.");
        const input = host.stdin as typeof host.stdin & {readonly readableEnded?: boolean; readonly destroyed?: boolean};
        if (input.readableEnded || input.destroyed) return "";
        const active = createInterface({input: host.stdin, terminal: false});
        readline = active;
        return await new Promise<string>((resolveAnswer, rejectAnswer) => {
          let settled = false;
          const questionAbort = new AbortController();
          const finish = (answer: string, error?: unknown): void => {
            if (settled) return;
            settled = true;
            joined.removeEventListener("abort", abort);
            active.off("close", close); active.off("error", failed);
            questionAbort.abort();
            try { active.close(); if (readline === active) readline = undefined; }
            catch (closeError) { error ??= closeError; }
            if (error !== undefined) rejectAnswer(error);
            else resolveAnswer(joined.aborted || question !== current ? "" : answer);
          };
          const abort = (): void => finish("");
          const close = (): void => finish("");
          const failed = (error: unknown): void => finish("", error);
          joined.addEventListener("abort", abort, {once: true});
          active.once("close", close); active.once("error", failed);
          if (joined.aborted) { abort(); return; }
          void active.question("", {signal: questionAbort.signal}).then(
            answer => finish(answer), error => { if (!settled) finish("", error); },
          );
        });
      } finally { if (question === current) question = undefined; }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true; disposal.abort();
      try { readline?.close(); readline = undefined; }
      finally {
        outputOwner.hideQr();
        for (const [signal, listener] of signalListeners) host.removeListener(signal, listener);
      }
    },
  });
};

const createDefaultDependencies = (): CliDependencies => {
  const terminal = createProcessTerminal();
  return Object.freeze({
    createRuntime: () => RuntimeClient.create(),
    runRuntimeManagement,
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
