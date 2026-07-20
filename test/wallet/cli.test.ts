import { EventEmitter, getEventListeners } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  captureCanonicalJson,
  parseCapabilityData,
  walletConnectionCapability,
  type CanonicalJson,
  type WalletConnectionData,
} from "../../src/core/index.js";
import {
  LocalRuntime,
  RuntimeOperationError,
  toProblemDetails,
  type RuntimeDispatchRequest,
  type RuntimeDispatchResponse,
} from "../../src/runtime/index.js";
import {
  createProcessTerminal,
  runCli,
  type CliDependencies,
  type CliProcessPort,
  type CliRuntimePort,
  type CliTerminalPort,
} from "../../src/cli.js";
import {
  parseWalletManagementOperation,
  parseWalletQrMatrix,
  type WalletManagementOperation,
} from "../../src/wallet/contracts.js";
import {
  WalletOperationError,
  createWalletFailure,
  walletInterfaceErrorMappings,
} from "../../src/wallet/errors.js";
import { walletControlRoutes } from "../../src/wallet/routes.js";
import {
  createTerminalQrDisplay,
  renderTerminalQr,
  type TerminalQrRendering,
} from "../../src/wallet/terminal-qr.js";
import {
  bindForHarness,
  createCapabilityHarness,
  invokeBinding,
} from "../core/capability-harness.js";
import { openTestOwnerSession } from "../interfaces/owner-session-harness.js";

const operationId = Buffer.alloc(32, 21).toString("base64url");
const hyphenLeadingOperationId = Buffer.concat([
  Buffer.from([0xfb, 0xe0]),
  Buffer.alloc(30),
]).toString("base64url");
const disconnected = Object.freeze({ status: "disconnected" as const, reason: "no_session" as const });
const unresolved = parseCapabilityData(walletConnectionCapability, {
  status: "unresolved",
  sessionCount: "2",
});
const connected = parseCapabilityData(walletConnectionCapability, {
  status: "connected",
  address: "0x1111111111111111111111111111111111111111",
  chainId: "eip155:4663",
  approvedMethods: ["eth_sendTransaction"],
  approvedEvents: ["accountsChanged", "chainChanged"],
  expiresAt: "2026-07-14T07:30:00.000Z",
});
const qr = Object.freeze({
  size: 21,
  rows: Object.freeze(Array.from({ length: 21 }, (_unused, row) =>
    Array.from({ length: 21 }, (_other, column) => (row + column) % 2 === 0 ? "1" : "0").join(""))),
});

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  resolve(value: Value): void;
  reject(error: unknown): void;
}

const deferred = <Value>(): Deferred<Value> => {
  let resolvePromise!: (value: Value) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<Value>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return Object.freeze({ promise, resolve: resolvePromise, reject: rejectPromise });
};

const operation = (
  overrides: Readonly<Record<string, unknown>> = {},
): WalletManagementOperation => parseWalletManagementOperation({
  operationId,
  kind: "disconnect",
  state: "completed",
  connectionRevision: "4",
  expiresAt: "2026-07-14T07:10:00.000Z",
  result: { outcome: "already_disconnected", connection: disconnected },
  failure: null,
  ...overrides,
});

const successResponse = (status: 200, body: unknown): RuntimeDispatchResponse => Object.freeze({
  status,
  body: captureCanonicalJson(body),
});

const operationStartResponse = (
  startedOperation: WalletManagementOperation,
  matrix?: typeof qr,
): Readonly<Record<string, unknown>> => Object.freeze({
  result: Object.freeze({
    status: "operation_started",
    operation: startedOperation,
  }),
  ...(matrix === undefined ? {} : { qr: matrix }),
});

const currentConnectionStartResponse = (): Readonly<Record<string, unknown>> => Object.freeze({
  result: Object.freeze({
    status: "current_connection",
    connectionRevision: "4",
    connection: connected,
  }),
});

const failureResponse = (code: string): RuntimeDispatchResponse => {
  const problem = toProblemDetails(createWalletFailure(code), walletInterfaceErrorMappings);
  return Object.freeze({ status: problem.status, body: problem as unknown as CanonicalJson });
};

const walletConnectionSuccess = async (
  data: WalletConnectionData,
): Promise<CanonicalJson> => {
  const harness = createCapabilityHarness(() => "2026-07-14T07:00:00.000Z");
  const binding = bindForHarness(walletConnectionCapability, harness, async (_input, context, observations) => {
    observations.record("wallet_sdk", {
      source: context.ports.observations.get("wallet_sdk"),
      claims: [{ role: "wallet_sdk_state", value: data }],
    });
    if (data.status === "connected") {
      observations.record("wallet_session", {
        source: context.ports.observations.get("wallet_session"),
        claims: [{ role: "wallet_session_state", value: data }],
      });
    }
    return { status: "success", data };
  });
  const result = await invokeBinding(walletConnectionCapability, binding, {});
  if (!result.ok) throw new Error("Expected a canonical wallet connection success.");
  return result as unknown as CanonicalJson;
};

const disconnectedSuccess = (): Promise<CanonicalJson> => walletConnectionSuccess(disconnected);

class FakeRuntime implements CliRuntimePort {
  ownerState: CliRuntimePort["ownerState"];
  readonly requests: RuntimeDispatchRequest[] = [];
  stopCount = 0;
  startCount = 0;
  onOwnerSessionOpen: (() => void) | undefined;
  readonly #handle: (operation: RuntimeDispatchRequest, requestIndex: number) => RuntimeDispatchResponse | Promise<RuntimeDispatchResponse>;
  readonly #stopError: Error | undefined;
  readonly #startError: Error | undefined;

  constructor(
    handle: (operation: RuntimeDispatchRequest, requestIndex: number) => RuntimeDispatchResponse | Promise<RuntimeDispatchResponse>,
    ownerState: CliRuntimePort["ownerState"] = "deferred",
    stopError?: Error,
    startError?: Error,
  ) {
    this.#handle = handle;
    this.ownerState = ownerState;
    this.#stopError = stopError;
    this.#startError = startError;
  }

  async dispatchRuntimeRequest(input: RuntimeDispatchRequest): Promise<RuntimeDispatchResponse> {
    const request = Object.freeze({ ...input });
    this.requests.push(request);
    return this.#handle(request, this.requests.length - 1);
  }

  openOwnerSession(signal?: AbortSignal) {
    this.onOwnerSessionOpen?.();
    return openTestOwnerSession(this, signal);
  }

  async start(): Promise<void> {
    this.startCount += 1;
    if (this.#startError !== undefined) throw this.#startError;
  }

  async stop(): Promise<void> {
    this.stopCount += 1;
    if (this.#stopError !== undefined) throw this.#stopError;
  }
}

interface FakeTerminalResult {
  readonly terminal: CliTerminalPort;
  readonly output: string[];
  readonly errors: string[];
  readonly prompts: string[];
  readonly events: string[];
  setDimensions(columns: number | undefined, rows: number | undefined): void;
  resolveInterrupt(): void;
  readonly disposed: () => boolean;
}

const fakeTerminal = (options: {
  readonly inputIsTTY?: boolean;
  readonly outputIsTTY?: boolean;
  readonly columns?: number | undefined;
  readonly rows?: number | undefined;
  readonly confirmation?: boolean;
  readonly confirmationError?: Error;
  readonly writeErrorError?: Error;
  readonly disposeError?: Error;
  readonly showQrFailures?: number;
  readonly hideQrFailures?: number;
  readonly onOutput?: (value: string, result: FakeTerminalResult) => void;
} = {}): FakeTerminalResult => {
  const output: string[] = [];
  const errors: string[] = [];
  const prompts: string[] = [];
  const events: string[] = [];
  let columns = "columns" in options ? options.columns : 50;
  let rows = "rows" in options ? options.rows : 30;
  let disposed = false;
  let showQrFailures = options.showQrFailures ?? 0;
  let hideQrFailures = options.hideQrFailures ?? 0;
  const interruptController = new AbortController();
  const result = {} as FakeTerminalResult;
  const qrDisplay = createTerminalQrDisplay((value) => {
    if (value.includes("\u001b[?1049h") && showQrFailures > 0) {
      showQrFailures -= 1;
      events.push("qr_show_failure");
      throw new Error("secret terminal presentation failure");
    }
    if (value.includes("\u001b[?1049l") && hideQrFailures > 0) {
      hideQrFailures -= 1;
      events.push("qr_hide_failure");
      throw new Error("secret terminal restoration failure");
    }
    output.push(value);
    events.push(value.includes("\u001b[?1049l") ? "qr_hide" : "qr_show");
    options.onOutput?.(value, result);
  });
  const terminal: CliTerminalPort = Object.freeze({
    inputIsTTY: options.inputIsTTY ?? true,
    outputIsTTY: options.outputIsTTY ?? true,
    get columns(): number | undefined { return columns; },
    get rows(): number | undefined { return rows; },
    interruptSignal: interruptController.signal,
    writeOutput(value: string): void {
      output.push(value);
      events.push("output");
      options.onOutput?.(value, result);
    },
    writeError(value: string): void {
      if (options.writeErrorError !== undefined) throw options.writeErrorError;
      errors.push(value);
    },
    showQr: (rendering: TerminalQrRendering) => qrDisplay.show(rendering),
    hideQr: () => qrDisplay.hide(),
    async readLine(prompt: string): Promise<string> {
      prompts.push(prompt);
      if (options.confirmationError !== undefined) throw options.confirmationError;
      return options.confirmation === true ? "y" : "n";
    },
    dispose(): void {
      qrDisplay.hide();
      disposed = true;
      if (options.disposeError !== undefined) throw options.disposeError;
    },
  });
  Object.assign(result, {
    terminal,
    output,
    errors,
    prompts,
    events,
    setDimensions(nextColumns: number | undefined, nextRows: number | undefined): void {
      columns = nextColumns;
      rows = nextRows;
    },
    resolveInterrupt(): void { interruptController.abort(); },
    disposed: () => disposed,
  });
  return result;
};

const fakeProcessHost = (): {
  readonly host: CliProcessPort;
  readonly output: () => string;
  readonly writeInput: (value: string) => void;
  readonly emit: (event: "exit" | "SIGINT" | "SIGTERM" | "SIGHUP") => void;
  readonly listenerCount: (event: "exit" | "SIGINT" | "SIGTERM" | "SIGHUP") => number;
} => {
  const events = new EventEmitter();
  const stdin = Object.assign(new PassThrough(), { isTTY: true });
  const stdout = Object.assign(new PassThrough(), {
    isTTY: true,
    columns: 30,
    rows: 15,
  });
  const stderr = new PassThrough();
  let output = "";
  stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  const host: CliProcessPort = {
    stdin,
    stdout,
    stderr,
    on(event, listener): void { events.on(event, listener); },
    removeListener(event, listener): void { events.removeListener(event, listener); },
  };
  return Object.freeze({
    host,
    output: () => output,
    writeInput: (value: string) => { stdin.write(value); },
    emit: (event: "exit" | "SIGINT" | "SIGTERM" | "SIGHUP") => { events.emit(event); },
    listenerCount: (event: "exit" | "SIGINT" | "SIGTERM" | "SIGHUP") =>
      events.listenerCount(event),
  });
};

const dependencies = (
  runtime: FakeRuntime,
  terminalResult = fakeTerminal(),
  onPoll?: () => void,
  onTerminate?: (exitCode: number) => void,
): CliDependencies => Object.freeze({
  createOperationId: () => operationId,
  createRuntime: async () => runtime,
  terminal: terminalResult.terminal,
  waitForPoll: async () => { onPoll?.(); },
  terminateProcess: (exitCode: number) => { onTerminate?.(exitCode); },
});

const requestWithoutSignal = ({
  signal: _signal,
  ...request
}: RuntimeDispatchRequest): Omit<RuntimeDispatchRequest, "signal"> => request;

const walletStartBody = (kind: "connect" | "disconnect") => ({
  control: { operationId, interactionInterface: "cli" as const },
  request: { kind, connectionRevision: null },
});

describe("wallet CLI", () => {
  it("returns raw terminal input so each command owns its confirmation grammar", async () => {
    const processHost = fakeProcessHost();
    const terminal = createProcessTerminal(processHost.host);
    const answer = terminal.readLine("Answer: ");
    processHost.writeInput("yes\n");
    await expect(answer).resolves.toBe("yes");
    terminal.dispose();
  });

  it("latches catchable process signals without taking normal QR restoration authority", () => {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      const processHost = fakeProcessHost();
      const terminal = createProcessTerminal(processHost.host);
      const rendering = renderTerminalQr(parseWalletQrMatrix(qr));

      terminal.showQr(rendering);
      expect(processHost.listenerCount(signal)).toBe(1);
      processHost.emit(signal);
      expect(terminal.interruptSignal.aborted).toBe(true);
      expect(processHost.output()).not.toContain("\u001b[?25h\u001b[?1049l");

      processHost.emit(signal);
      expect(processHost.output()).not.toContain("\u001b[?25h\u001b[?1049l");
      expect(processHost.listenerCount(signal)).toBe(1);

      terminal.hideQr();
      expect(processHost.output().match(/\u001b\[\?1049l/gu)).toHaveLength(1);
      terminal.dispose();
      expect(processHost.listenerCount("SIGINT")).toBe(0);
      expect(processHost.listenerCount("SIGTERM")).toBe(0);
      expect(processHost.listenerCount("SIGHUP")).toBe(0);
      expect(processHost.listenerCount("exit")).toBe(0);
    }
  });

  it("clears the process terminal and settles exact cancellation for every catchable signal", async () => {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      const awaiting = operation({
        kind: "connect",
        state: "awaiting_wallet_approval",
        result: null,
      });
      const cancelled = operation({ kind: "connect", state: "cancelled", result: null });
      const events: string[] = [];
      const runtime = new FakeRuntime((request) => {
        events.push(request.method === "DELETE" ? "cancel" : "operation");
        return request.method === "POST"
          ? successResponse(200, operationStartResponse(awaiting, qr))
          : successResponse(200, { operation: cancelled });
      });
      runtime.onOwnerSessionOpen = () => events.push("session-open");
      const processHost = fakeProcessHost();
      const terminal = createProcessTerminal(processHost.host);
      let signalSent = false;
      processHost.host.stdout.on("data", (chunk: Buffer) => {
        const value = chunk.toString("utf8");
        if (value.includes("\u001b[?1049l")) events.push("restore");
        if (!signalSent && value.includes("\u001b[?1049h")) {
          signalSent = true;
          processHost.emit(signal);
        }
      });

      expect(await runCli(["wallet", "connect"], {
        createOperationId: () => operationId,
        createRuntime: async () => runtime,
        terminal,
        waitForPoll: async () => undefined,
        terminateProcess: () => undefined,
      })).toBe(0);
      expect(events.indexOf("cancel")).toBeGreaterThan(events.indexOf("operation"));
      expect(events.indexOf("restore")).toBeGreaterThan(events.lastIndexOf("session-open"));
      expect(runtime.stopCount).toBe(1);
    }
  });

  it("does not start or dispatch a command when interruption arrives during runtime creation", async () => {
    const runtime = new FakeRuntime(() => { throw new Error("operation must not run"); });
    const runtimeResult = deferred<CliRuntimePort>();
    const creationEntered = deferred<void>();
    const processHost = fakeProcessHost();
    const terminal = createProcessTerminal(processHost.host);
    const running = runCli(["wallet", "disconnect"], {
      createOperationId: () => operationId,
      createRuntime: () => {
        creationEntered.resolve(undefined);
        return runtimeResult.promise;
      },
      terminal,
      waitForPoll: async () => undefined,
      terminateProcess: () => undefined,
    });

    await creationEntered.promise;
    processHost.emit("SIGINT");
    runtimeResult.resolve(runtime);

    expect(await running).toBe(0);
    expect(runtime.startCount).toBe(0);
    expect(runtime.requests).toEqual([]);
    expect(runtime.stopCount).toBe(1);
  });

  it("stops and drains runtime startup before admitting any interrupted wallet mutation", async () => {
    for (const command of [
      ["wallet", "connect"],
      ["wallet", "disconnect"],
      ["wallet", "cancel", operationId],
    ] as const) {
      const startEntered = deferred<void>();
      const startResult = deferred<void>();
      const requests: RuntimeDispatchRequest[] = [];
      let stopCount = 0;
      const runtime: CliRuntimePort = {
        ownerState: "starting",
        start(): Promise<void> {
          startEntered.resolve(undefined);
          return startResult.promise;
        },
        dispatchRuntimeRequest(request): Promise<RuntimeDispatchResponse> {
          requests.push(request);
          throw new Error("operation must not run");
        },
        openOwnerSession(signal?: AbortSignal) { return openTestOwnerSession(this, signal); },
        async stop(): Promise<void> {
          stopCount += 1;
          startResult.reject(new RuntimeOperationError("request_aborted"));
        },
      };
      const processHost = fakeProcessHost();
      const terminal = createProcessTerminal(processHost.host);
      const running = runCli(command, {
        createOperationId: () => operationId,
        createRuntime: async () => runtime,
        terminal,
        waitForPoll: async () => undefined,
        terminateProcess: () => undefined,
      });

      await startEntered.promise;
      processHost.emit("SIGTERM");

      expect(await running).toBe(0);
      expect(requests).toEqual([]);
      expect(stopCount).toBe(1);
    }
  });

  it("composes process interruption with the real LocalRuntime start and stop lifecycle", async () => {
    const events: string[] = [];
    const startEntered = deferred<void>();
    const startCompletion = deferred<void>();
    const releasePermit = Object.freeze({ release: true });
    const database = {
      close(): void { events.push("database:close"); },
    };
    const owner = {
      ownerState: "starting" as const,
      async start(): Promise<void> {
        events.push("owner:start");
        startEntered.resolve(undefined);
        return startCompletion.promise;
      },
      async dispatchRuntimeRequest(): Promise<RuntimeDispatchResponse> {
        events.push("owner:operation");
        throw new Error("operation must not run");
      },
      async closeApplication(): Promise<object> {
        events.push("owner:close-application");
        startCompletion.reject(new RuntimeOperationError("request_aborted"));
        return releasePermit;
      },
      async releaseListener(permit: object): Promise<void> {
        expect(permit).toBe(releasePermit);
        events.push("owner:release-listener");
      },
    };
    const runtime = Reflect.construct(LocalRuntime, [database, () => owner]) as LocalRuntime;
    const processHost = fakeProcessHost();
    const terminal = createProcessTerminal(processHost.host);
    const running = runCli(["wallet", "disconnect"], {
      createOperationId: () => operationId,
      createRuntime: async () => runtime,
      terminal,
      waitForPoll: async () => undefined,
      terminateProcess: () => undefined,
    });

    await startEntered.promise;
    processHost.emit("SIGINT");

    expect(await running).toBe(0);
    expect(events).toEqual([
      "owner:start",
      "owner:close-application",
      "database:close",
      "owner:release-listener",
    ]);
    expect(processHost.listenerCount("SIGINT")).toBe(0);
    expect(processHost.listenerCount("SIGTERM")).toBe(0);
    expect(processHost.listenerCount("SIGHUP")).toBe(0);
    expect(processHost.listenerCount("exit")).toBe(0);
  });

  it("waits for owner cleanup to drain interrupted work before LocalRuntime releases dependencies", async () => {
    const awaiting = operation({
      kind: "connect",
      state: "awaiting_wallet_approval",
      result: null,
    });
    const cancelled = operation({ kind: "connect", state: "cancelled", result: null });
    const events: string[] = [];
    const getEntered = deferred<void>();
    const pendingGet = deferred<RuntimeDispatchResponse>();
    const getSettled = deferred<void>();
    void pendingGet.promise.then(
      () => { events.push("owner:get-settled"); getSettled.resolve(undefined); },
      () => { events.push("owner:get-settled"); getSettled.resolve(undefined); },
    );
    const releasePermit = Object.freeze({ release: true });
    const database = {
      close(): void {
        events.push("database:close");
      },
    };
    const owner = {
      state: "owner" as const,
      async start(): Promise<void> {
        events.push("owner:start");
      },
      dispatchRuntimeRequest(request: RuntimeDispatchRequest): Promise<RuntimeDispatchResponse> {
        if (request.method === "POST") {
          events.push("owner:post");
          return Promise.resolve(successResponse(200, operationStartResponse(awaiting, qr)));
        }
        if (request.method === "GET") {
          events.push("owner:get");
          getEntered.resolve(undefined);
          return pendingGet.promise;
        }
        events.push("owner:delete");
        return Promise.resolve(successResponse(200, { operation: cancelled }));
      },
      openOwnerSession(signal?: AbortSignal) {
        return openTestOwnerSession(this, signal);
      },
      async closeApplication(): Promise<object> {
        events.push("owner:close-application");
        pendingGet.reject(new RuntimeOperationError("request_aborted"));
        await getSettled.promise;
        return releasePermit;
      },
      async releaseListener(permit: object): Promise<void> {
        expect(permit).toBe(releasePermit);
        events.push("owner:release-listener");
      },
    };
    const runtime = Reflect.construct(LocalRuntime, [database, () => owner]) as LocalRuntime;
    const terminal = fakeTerminal();
    const running = runCli(["wallet", "connect"], {
      createOperationId: () => operationId,
      createRuntime: async () => runtime,
      terminal: terminal.terminal,
      waitForPoll: async () => undefined,
      terminateProcess: () => undefined,
    });

    await getEntered.promise;
    terminal.resolveInterrupt();

    expect(await running).toBe(0);
    expect(events).toEqual([
      "owner:start",
      "owner:post",
      "owner:get",
      "owner:delete",
      "owner:close-application",
      "owner:get-settled",
      "database:close",
      "owner:release-listener",
    ]);
  });

  it("rejects non-interactive input or output before starting the local runtime", async () => {
    for (const tty of [
      fakeTerminal({ inputIsTTY: false }),
      fakeTerminal({ outputIsTTY: false }),
    ]) {
      let starts = 0;
      const exitCode = await runCli(["wallet", "status"], {
        createOperationId: () => operationId,
        createRuntime: async () => {
          starts += 1;
          throw new Error("must not start");
        },
        terminal: tty.terminal,
        waitForPoll: async () => undefined,
        terminateProcess: () => undefined,
      });
      expect(exitCode).toBe(2);
      expect(starts).toBe(0);
      expect(tty.errors.join("")).toBe(
        "interactive_terminal_required: This command requires an interactive terminal.\n",
      );
      expect(tty.disposed()).toBe(true);
    }
  });

  it("uses a closed wallet-command grammar and never starts the runtime for invalid input", async () => {
    const invalidCommands = [
      ["read", "status"],
      ["wallet", "status", "--json", "--json"],
      ["wallet", "connect", "--json"],
      ["wallet", "rotate"],
      ["wallet", "operation"],
      ["wallet", "operation", operationId, "--unknown"],
      ["wallet", "cancel", "not-an-operation-id"],
    ];
    for (const command of invalidCommands) {
      const tty = fakeTerminal();
      let starts = 0;
      expect(await runCli(command, {
        createOperationId: () => operationId,
        createRuntime: async () => {
          starts += 1;
          throw new Error("must not start");
          },
          terminal: tty.terminal,
          waitForPoll: async () => undefined,
          terminateProcess: () => undefined,
        })).toBe(2);
      expect(starts).toBe(0);
      expect(tty.errors.join("")).toBe("invalid_input: The request input is invalid.\n");
    }
  });

  it("runs no-argument stdio MCP without requiring a TTY and closes the shared runtime", async () => {
    const runtime = new FakeRuntime(() => { throw new Error("MCP must not dispatch during startup."); });
    const terminal = fakeTerminal({ inputIsTTY: false, outputIsTTY: false });
    let starts = 0;
    let closes = 0;

    expect(await runCli([], {
      createOperationId: () => operationId,
      createRuntime: async () => runtime,
      terminal: terminal.terminal,
      waitForPoll: async () => undefined,
      terminateProcess: () => undefined,
      startMcp: async (selectedRuntime) => {
        starts += 1;
        expect(selectedRuntime).toBe(runtime);
        return Object.freeze({
          closed: Promise.resolve(),
          close: async (): Promise<void> => { closes += 1; },
        });
      },
    })).toBe(0);

    expect(starts).toBe(1);
    expect(closes).toBe(1);
    expect(runtime.startCount).toBe(1);
    expect(runtime.stopCount).toBe(1);
    expect(terminal.disposed()).toBe(true);
    expect(terminal.output).toEqual([]);
    expect(terminal.errors).toEqual([]);
  });

  it("parses canonical operation identifiers independently from exact CLI flags", async () => {
    expect(hyphenLeadingOperationId).toMatch(/^--[A-Za-z0-9_-]{41}$/u);
    const retained = operation({ operationId: hyphenLeadingOperationId });
    const cancelled = operation({
      operationId: hyphenLeadingOperationId,
      kind: "connect",
      state: "cancelled",
      result: null,
    });
    const operationRuntime = new FakeRuntime(() => successResponse(200, { operation: retained }));
    const operationTerminal = fakeTerminal();
    expect(await runCli(
      ["wallet", "operation", hyphenLeadingOperationId, "--json"],
      dependencies(operationRuntime, operationTerminal),
    )).toBe(0);
    expect(operationRuntime.requests.map(requestWithoutSignal)).toEqual([{
      requestClass: "local_control",
      method: "GET",
      path: walletControlRoutes.operation(hyphenLeadingOperationId),
    }]);

    const cancelRuntime = new FakeRuntime(() => successResponse(200, { operation: cancelled }));
    expect(await runCli(
      ["wallet", "cancel", hyphenLeadingOperationId],
      dependencies(cancelRuntime),
    )).toBe(0);
    expect(cancelRuntime.requests.map(requestWithoutSignal)).toEqual([{
      requestClass: "local_control",
      method: "DELETE",
      path: walletControlRoutes.operation(hyphenLeadingOperationId),
    }]);
  });

  it("projects canonical status and operation JSON without exposing QR material", async () => {
    const connection = await disconnectedSuccess();
    const pending = operation({
      kind: "connect",
      state: "awaiting_wallet_approval",
      result: null,
    });
    const runtime = new FakeRuntime((request) => {
      if (request.path === walletControlRoutes.connection) {
        return successResponse(200, connection);
      }
      return successResponse(200, { operation: pending, qr });
    });

    const statusTerminal = fakeTerminal();
    expect(await runCli(["wallet", "status", "--json"], dependencies(runtime, statusTerminal))).toBe(0);
    expect(JSON.parse(statusTerminal.output.join(""))).toEqual(connection);
    expect(statusTerminal.errors).toEqual([]);

    const operationTerminal = fakeTerminal();
    expect(await runCli(
      ["wallet", "operation", "--json", operationId],
      dependencies(runtime, operationTerminal),
    )).toBe(0);
    const projected = JSON.parse(operationTerminal.output.join("")) as Record<string, unknown>;
    expect(projected).toEqual(pending);
    expect(projected).not.toHaveProperty("qr");
    expect(operationTerminal.output.join("")).not.toContain(qr.rows[0] as string);
  });

  it("returns the current valid connection without creating, confirming, or observing an operation", async () => {
    const runtime = new FakeRuntime((request) => {
      expect(requestWithoutSignal(request)).toEqual({
        requestClass: "local_control",
        method: "POST",
        path: walletControlRoutes.operations,
        body: walletStartBody("connect"),
      });
      return successResponse(200, currentConnectionStartResponse());
    }, "owner");
    const terminal = fakeTerminal();
    let polls = 0;

    expect(await runCli(["wallet", "connect"], dependencies(runtime, terminal, () => {
      polls += 1;
    }))).toBe(0);

    expect(runtime.requests).toHaveLength(1);
    expect(polls).toBe(0);
    expect(terminal.prompts).toEqual([]);
    expect(terminal.events).not.toContain("qr_show");
    expect(terminal.output.join("")).toContain(
      "Connected address: 0x1111111111111111111111111111111111111111",
    );
    expect(terminal.output.join("")).not.toContain("Wallet operation");
    expect(terminal.output.join("")).not.toContain("WalletConnect coordinator active");
  });

  it("preserves delivery uncertainty for an invalid current-connection response to disconnection", async () => {
    const runtime = new FakeRuntime(() =>
      successResponse(200, currentConnectionStartResponse()));
    const terminal = fakeTerminal();

    expect(await runCli(["wallet", "disconnect"], dependencies(runtime, terminal))).toBe(8);
    expect(runtime.requests.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: "POST", path: walletControlRoutes.operations },
      { method: "GET", path: walletControlRoutes.operation(operationId) },
    ]);
    expect(terminal.prompts).toEqual([]);
    expect(terminal.events).not.toContain("qr_show");
    expect(terminal.errors.join("")).toContain("Delivery unknown for start operation");
  });

  it("renders a fresh pairing matrix, clears it at completion, and keeps an owner coordinator until interrupt", async () => {
    const awaiting = operation({
      kind: "connect",
      state: "awaiting_wallet_approval",
      result: null,
    });
    const completed = operation({
      kind: "connect",
      state: "completed",
      result: { outcome: "connected", connection: connected },
    });
    const runtime = new FakeRuntime((request) => request.method === "POST"
      ? successResponse(200, operationStartResponse(awaiting, qr))
      : successResponse(200, { operation: completed }), "owner");
    let tty!: FakeTerminalResult;
    tty = fakeTerminal({
      onOutput(value, result) {
        if (value.includes("WalletConnect coordinator active")) result.resolveInterrupt();
      },
    });

    expect(await runCli(["wallet", "connect"], dependencies(runtime, tty))).toBe(0);
    expect(runtime.requests.map(requestWithoutSignal)).toEqual([
      {
        requestClass: "local_control",
        method: "POST",
        path: walletControlRoutes.operations,
        body: walletStartBody("connect"),
      },
      { requestClass: "local_control", method: "GET", path: walletControlRoutes.operation(operationId) },
    ]);
    expect(tty.output.some((value) => value.includes("\u001b[47m\u001b[30m"))).toBe(true);
    expect(tty.output.some((value) => value.includes("\u001b[?1049h\u001b[?25l"))).toBe(true);
    expect(tty.output.some((value) => value.includes("\u001b[?25h\u001b[?1049l"))).toBe(true);
    expect(tty.output.join("")).not.toContain("wc:");
    expect(tty.output.join("")).not.toContain(qr.rows[0] as string);
    expect(runtime.stopCount).toBe(1);
  });

  it("uses a process signal after approval only to stop the owner and preserve the session", async () => {
    const awaiting = operation({
      kind: "connect",
      state: "awaiting_wallet_approval",
      result: null,
    });
    const completed = operation({
      kind: "connect",
      state: "completed",
      result: { outcome: "connected", connection: connected },
    });
    const runtime = new FakeRuntime((request) => request.method === "POST"
      ? successResponse(200, operationStartResponse(awaiting, qr))
      : successResponse(200, { operation: completed }), "owner");
    const processHost = fakeProcessHost();
    const terminal = createProcessTerminal(processHost.host);
    let signalSent = false;
    processHost.host.stdout.on("data", (chunk: Buffer) => {
      if (!signalSent && chunk.toString("utf8").includes("WalletConnect coordinator active")) {
        signalSent = true;
        processHost.emit("SIGINT");
      }
    });

    expect(await runCli(["wallet", "connect"], {
      createOperationId: () => operationId,
      createRuntime: async () => runtime,
      terminal,
      waitForPoll: async () => undefined,
      terminateProcess: () => undefined,
    })).toBe(0);
    expect(signalSent).toBe(true);
    expect(runtime.requests.map(({ method }) => method)).toEqual(["POST", "GET"]);
    expect(runtime.stopCount).toBe(1);
  });

  it("clears a pairing matrix as soon as the owner removes QR authority", async () => {
    const awaiting = operation({
      kind: "connect",
      state: "awaiting_wallet_approval",
      result: null,
    });
    const validating = operation({
      kind: "connect",
      state: "validating_session",
      result: null,
    });
    const completed = operation({
      kind: "connect",
      state: "completed",
      result: { outcome: "connected", connection: connected },
    });
    const events: string[] = [];
    let reads = 0;
    const runtime = new FakeRuntime((request) => {
      if (request.method === "POST") {
        events.push("create");
        return successResponse(200, operationStartResponse(awaiting, qr));
      }
      reads += 1;
      events.push(reads === 1 ? "read-validating" : "read-completed");
      return successResponse(200, { operation: reads === 1 ? validating : completed });
    });
    const tty = fakeTerminal({
      onOutput(value) {
        events.push(value.includes("\u001b[?1049l") ? "clear" : "output");
      },
    });

    expect(await runCli(["wallet", "connect"], dependencies(runtime, tty))).toBe(0);
    expect(events.indexOf("clear")).toBeGreaterThan(events.indexOf("read-validating"));
    expect(events.indexOf("clear")).toBeLessThan(events.indexOf("read-completed"));
  });

  it("shows canonical disconnection state and cancels the exact operation when confirmation is declined", async () => {
    const connection = await walletConnectionSuccess(unresolved);
    const awaiting = operation({
      kind: "disconnect",
      state: "awaiting_confirmation",
      result: null,
    });
    const cancelled = operation({ kind: "disconnect", state: "cancelled", result: null });
    const runtime = new FakeRuntime((request) => {
      if (request.method === "POST") return successResponse(200, operationStartResponse(awaiting));
      if (request.path === walletControlRoutes.connection) {
        return successResponse(200, connection);
      }
      if (request.method === "DELETE") return successResponse(200, { operation: cancelled });
      throw new Error("unexpected request");
    });
    const tty = fakeTerminal({ confirmation: false });

    expect(await runCli(["wallet", "disconnect"], dependencies(runtime, tty))).toBe(0);
    expect(tty.prompts).toHaveLength(1);
    expect(tty.prompts[0]).toContain("Connection revision: 4");
    expect(tty.prompts[0]).toContain("Every existing wallet session for this profile will be disconnected");
    expect(requestWithoutSignal(runtime.requests.at(-1)!)).toEqual({
      requestClass: "local_control",
      method: "DELETE",
      path: walletControlRoutes.operation(operationId),
    });
    expect(tty.output.join("")).toContain(": cancelled");
  });

  it("posts a revision-bound confirmation and never derives a disconnection revision in the CLI", async () => {
    const connection = await disconnectedSuccess();
    const awaiting = operation({
      kind: "disconnect",
      state: "awaiting_confirmation",
      connectionRevision: "91",
      result: null,
    });
    const completed = operation({
      kind: "disconnect",
      state: "completed",
      connectionRevision: "91",
      result: { outcome: "disconnected", connection: disconnected },
    });
    const runtime = new FakeRuntime((request) => {
      if (request.path === walletControlRoutes.operations) {
        return successResponse(200, operationStartResponse(awaiting));
      }
      if (request.path === walletControlRoutes.connection) {
        return successResponse(200, connection);
      }
      if (request.path.endsWith("/confirmation")) return successResponse(200, { operation: completed });
      throw new Error("unexpected request");
    });
    const tty = fakeTerminal({ confirmation: true });

    expect(await runCli(["wallet", "disconnect"], dependencies(runtime, tty))).toBe(0);
    expect(requestWithoutSignal(runtime.requests[0]!)).toEqual({
      requestClass: "local_control",
      method: "POST",
      path: walletControlRoutes.operations,
      body: walletStartBody("disconnect"),
    });
    expect(requestWithoutSignal(runtime.requests.at(-1)!)).toEqual({
      requestClass: "local_control",
      method: "POST",
      path: walletControlRoutes.confirmation(operationId),
      body: { connectionRevision: "91" },
    });
  });

  it("cancels its exact waiting operation when confirmation preparation fails", async () => {
    const connection = await walletConnectionSuccess(unresolved);
    const awaiting = operation({
      kind: "disconnect",
      state: "awaiting_confirmation",
      result: null,
    });
    const cancelled = operation({ kind: "disconnect", state: "cancelled", result: null });

    const connectionFailure = new FakeRuntime((request) => {
      if (request.path === walletControlRoutes.operations) {
        return successResponse(200, operationStartResponse(awaiting));
      }
      if (request.path === walletControlRoutes.connection) {
        return failureResponse("runtime_state_unavailable");
      }
      if (request.method === "DELETE") return successResponse(200, { operation: cancelled });
      throw new Error("unexpected request");
    });
    const connectionTerminal = fakeTerminal();
    expect(await runCli(
      ["wallet", "disconnect"],
      dependencies(connectionFailure, connectionTerminal),
    )).toBe(7);
    expect(connectionFailure.requests.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: "POST", path: walletControlRoutes.operations },
      { method: "GET", path: walletControlRoutes.connection },
      { method: "DELETE", path: walletControlRoutes.operation(operationId) },
    ]);

    const promptFailure = new FakeRuntime((request) => {
      if (request.path === walletControlRoutes.operations) {
        return successResponse(200, operationStartResponse(awaiting));
      }
      if (request.path === walletControlRoutes.connection) {
        return successResponse(200, connection);
      }
      if (request.method === "DELETE") return successResponse(200, { operation: cancelled });
      throw new Error("unexpected request");
    });
    const promptTerminal = fakeTerminal({ confirmationError: new Error("secret terminal failure") });
    expect(await runCli(
      ["wallet", "disconnect"],
      dependencies(promptFailure, promptTerminal),
    )).toBe(1);
    expect(requestWithoutSignal(promptFailure.requests.at(-1)!)).toEqual({
      requestClass: "local_control",
      method: "DELETE",
      path: walletControlRoutes.operation(operationId),
    });
    expect(promptTerminal.errors.join("")).toBe(
      "internal_error: The request could not be completed.\n",
    );

    const expired = operation({ kind: "disconnect", state: "expired", result: null });
    const cleanupFailure = new FakeRuntime((request) => {
      if (request.path === walletControlRoutes.operations) {
        return successResponse(200, operationStartResponse(awaiting));
      }
      if (request.path === walletControlRoutes.connection) {
        return failureResponse("wallet_session_unusable");
      }
      if (request.method === "DELETE") return failureResponse("state_conflict");
      if (request.path === walletControlRoutes.operation(operationId)) {
        return successResponse(200, { operation: expired });
      }
      throw new Error("unexpected request");
    });
    const cleanupTerminal = fakeTerminal();
    expect(await runCli(
      ["wallet", "disconnect"],
      dependencies(cleanupFailure, cleanupTerminal),
    )).toBe(4);
    expect(cleanupTerminal.errors.join("")).toBe(
      "wallet_timeout: The wallet request timed out.\n",
    );
  });

  it("gives a latched interrupt priority over an already available destructive confirmation", async () => {
    const connection = await walletConnectionSuccess(connected);
    const awaiting = operation({
      kind: "disconnect",
      state: "awaiting_confirmation",
      result: null,
    });
    const cancelled = operation({ kind: "disconnect", state: "cancelled", result: null });
    const terminal = fakeTerminal({ confirmation: true });
    const runtime = new FakeRuntime((request) => {
      if (request.path === walletControlRoutes.operations) {
        terminal.resolveInterrupt();
        return successResponse(200, operationStartResponse(awaiting));
      }
      if (request.path === walletControlRoutes.connection) return successResponse(200, connection);
      if (request.method === "DELETE") return successResponse(200, { operation: cancelled });
      throw new Error("confirmation must not be dispatched");
    });

    expect(await runCli(["wallet", "disconnect"], dependencies(runtime, terminal))).toBe(0);
    expect(runtime.requests.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: "POST", path: walletControlRoutes.operations },
      { method: "DELETE", path: walletControlRoutes.operation(operationId) },
    ]);
    expect(terminal.prompts).toEqual([]);
  });

  it("starts exact cancellation while confirmation connection evidence is still pending", async () => {
    const awaiting = operation({
      kind: "disconnect",
      state: "awaiting_confirmation",
      result: null,
    });
    const cancelled = operation({ kind: "disconnect", state: "cancelled", result: null });
    const connectionRead = deferred<RuntimeDispatchResponse>();
    const connectionReadEntered = deferred<void>();
    const cancellationEntered = deferred<void>();
    const terminal = fakeTerminal({ confirmation: true });
    const runtime = new FakeRuntime((request) => {
      if (request.path === walletControlRoutes.operations) {
        return successResponse(200, operationStartResponse(awaiting));
      }
      if (request.path === walletControlRoutes.connection) {
        connectionReadEntered.resolve(undefined);
        return connectionRead.promise;
      }
      if (request.method === "DELETE") {
        cancellationEntered.resolve(undefined);
        return successResponse(200, { operation: cancelled });
      }
      throw new Error("confirmation must not be dispatched");
    });
    const running = runCli(["wallet", "disconnect"], dependencies(runtime, terminal));

    await connectionReadEntered.promise;
    terminal.resolveInterrupt();
    await cancellationEntered.promise;
    connectionRead.resolve(successResponse(200, await walletConnectionSuccess(connected)));

    expect(await running).toBe(0);
    expect(runtime.requests.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: "POST", path: walletControlRoutes.operations },
      { method: "GET", path: walletControlRoutes.connection },
      { method: "DELETE", path: walletControlRoutes.operation(operationId) },
    ]);
    expect(terminal.prompts).toEqual([]);
  });

  it("turns a process signal during readline confirmation into exact cancellation", async () => {
    const connection = await walletConnectionSuccess(connected);
    const awaiting = operation({
      kind: "disconnect",
      state: "awaiting_confirmation",
      result: null,
    });
    const cancelled = operation({ kind: "disconnect", state: "cancelled", result: null });
    const runtime = new FakeRuntime((request) => {
      if (request.path === walletControlRoutes.operations) return successResponse(200, operationStartResponse(awaiting));
      if (request.path === walletControlRoutes.connection) return successResponse(200, connection);
      if (request.method === "DELETE") return successResponse(200, { operation: cancelled });
      throw new Error("confirmation must not be dispatched");
    });
    const processHost = fakeProcessHost();
    const terminal = createProcessTerminal(processHost.host);
    let signalSent = false;
    processHost.host.stdout.on("data", (chunk: Buffer) => {
      if (!signalSent && chunk.toString("utf8").includes("Disconnect every existing wallet session?")) {
        signalSent = true;
        processHost.emit("SIGINT");
      }
    });

    expect(await runCli(["wallet", "disconnect"], {
      createOperationId: () => operationId,
      createRuntime: async () => runtime,
      terminal,
      waitForPoll: async () => undefined,
      terminateProcess: () => undefined,
    })).toBe(0);
    expect(runtime.requests.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: "POST", path: walletControlRoutes.operations },
      { method: "GET", path: walletControlRoutes.connection },
      { method: "DELETE", path: walletControlRoutes.operation(operationId) },
    ]);
  });

  it("latches interruption during operation creation and cancels the returned exact operation", async () => {
    const awaiting = operation({
      kind: "connect",
      state: "awaiting_wallet_approval",
      result: null,
    });
    const cancelled = operation({ kind: "connect", state: "cancelled", result: null });
    const creation = deferred<RuntimeDispatchResponse>();
    const creationEntered = deferred<void>();
    const cancellationEntered = deferred<void>();
    const terminal = fakeTerminal();
    const runtime = new FakeRuntime((request) => {
      if (request.method === "POST") {
        creationEntered.resolve(undefined);
        return creation.promise;
      }
      if (request.method === "DELETE") {
        cancellationEntered.resolve(undefined);
        return successResponse(200, { operation: cancelled });
      }
      throw new Error("operation observation must not run");
    });
    const running = runCli(["wallet", "connect"], dependencies(runtime, terminal));

    await creationEntered.promise;
    terminal.resolveInterrupt();
    expect(runtime.requests.map(({ method }) => method)).toEqual(["POST"]);
    creation.resolve(successResponse(200, operationStartResponse(awaiting)));
    await cancellationEntered.promise;

    expect(await running).toBe(0);
    expect(runtime.requests.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: "POST", path: walletControlRoutes.operations },
      { method: "DELETE", path: walletControlRoutes.operation(operationId) },
    ]);
  });

  it("does not infer cancellation authority after confirmation dispatch", async () => {
    const connection = await walletConnectionSuccess(unresolved);
    const awaiting = operation({
      kind: "disconnect",
      state: "awaiting_confirmation",
      result: null,
    });
    const runtime = new FakeRuntime((request) => {
      if (request.path === walletControlRoutes.operations) {
        return successResponse(200, operationStartResponse(awaiting));
      }
      if (request.path === walletControlRoutes.connection) {
        return successResponse(200, connection);
      }
      if (request.path.endsWith("/confirmation")) return failureResponse("state_conflict");
      throw new Error("unexpected request");
    });
    const terminal = fakeTerminal({ confirmation: true });

    expect(await runCli(
      ["wallet", "disconnect"],
      dependencies(runtime, terminal),
    )).toBe(5);
    expect(runtime.requests.some(({ method }) => method === "DELETE")).toBe(false);
    expect(requestWithoutSignal(runtime.requests.at(-1)!)).toEqual({
      requestClass: "local_control",
      method: "POST",
      path: walletControlRoutes.confirmation(operationId),
      body: { connectionRevision: "4" },
    });
  });

  it("maps disconnect and explicit cancellation to their exact coordinator operations", async () => {
    const alreadyDisconnected = operation();
    const disconnectRuntime = new FakeRuntime(() =>
      successResponse(200, operationStartResponse(alreadyDisconnected)));
    const disconnectTerminal = fakeTerminal();
    expect(await runCli(
      ["wallet", "disconnect"],
      dependencies(disconnectRuntime, disconnectTerminal),
    )).toBe(0);
    expect(disconnectRuntime.requests.map(requestWithoutSignal)).toEqual([{
      requestClass: "local_control",
      method: "POST",
      path: walletControlRoutes.operations,
      body: walletStartBody("disconnect"),
    }]);
    expect(disconnectTerminal.output.join("")).toContain("already_disconnected");

    const cancelled = operation({ kind: "connect", state: "cancelled", result: null });
    const cancelRuntime = new FakeRuntime(() => successResponse(200, { operation: cancelled }));
    const cancelTerminal = fakeTerminal();
    expect(await runCli(
      ["wallet", "cancel", operationId],
      dependencies(cancelRuntime, cancelTerminal),
    )).toBe(0);
    expect(cancelRuntime.requests.map(requestWithoutSignal)).toEqual([{
      requestClass: "local_control",
      method: "DELETE",
      path: walletControlRoutes.operation(operationId),
    }]);
  });

  it("reports exact current and minimum dimensions and waits for explicit interruption", async () => {
    const awaiting = operation({
      kind: "connect",
      state: "awaiting_wallet_approval",
      result: null,
    });
    const cancelled = operation({ kind: "connect", state: "cancelled", result: null });
    const runtime = new FakeRuntime((request) => request.method === "POST"
      ? successResponse(200, operationStartResponse(awaiting, qr))
      : successResponse(200, { operation: cancelled }));
    const events: string[] = [];
    let tty!: FakeTerminalResult;
    tty = fakeTerminal({
      columns: 29,
      rows: 15,
      onOutput(value, result) {
        events.push(value.includes("Current terminal dimensions") ? "dimensions" : "output");
        if (value.includes("Current terminal dimensions")) result.resolveInterrupt();
      },
    });

    expect(await runCli(["wallet", "connect"], dependencies(runtime, tty))).toBe(0);
    expect(requestWithoutSignal(runtime.requests.at(-1)!)).toEqual({
      requestClass: "local_control",
      method: "DELETE",
      path: walletControlRoutes.operation(operationId),
    });
    expect(events[0]).toBe("dimensions");
    expect(tty.output.join("")).toContain("Current terminal dimensions: 29 columns x 15 rows");
    expect(tty.output.join("")).toContain("Minimum terminal dimensions for this QR: 30 columns x 15 rows");
    expect(tty.output.join("")).toContain("The pairing code will appear automatically.");
    expect(tty.output.join("")).not.toContain("\u001b[47m\u001b[30m");
    expect(tty.errors).toEqual([]);
  });

  it("keeps the same operation while resizing and renders it as soon as both dimensions fit", async () => {
    const awaiting = operation({
      kind: "connect",
      state: "awaiting_wallet_approval",
      result: null,
    });
    const completed = operation({
      kind: "connect",
      state: "completed",
      result: { outcome: "connected", connection: connected },
    });
    let reads = 0;
    const runtime = new FakeRuntime((request) => {
      if (request.method === "POST") return successResponse(200, operationStartResponse(awaiting, qr));
      reads += 1;
      return successResponse(200, { operation: reads === 1 ? awaiting : completed, ...(reads === 1 ? { qr } : {}) });
    });
    const tty = fakeTerminal({ columns: 29, rows: 15 });
    let polls = 0;

    expect(await runCli(["wallet", "connect"], dependencies(runtime, tty, () => {
      polls += 1;
      if (polls === 1) tty.setDimensions(30, 15);
    }))).toBe(0);
    expect(runtime.requests.map(({ method }) => method)).toEqual(["POST", "GET", "GET"]);
    expect(runtime.requests.some(({ method }) => method === "DELETE")).toBe(false);
    expect(tty.output.filter((value) => value.includes("Current terminal dimensions"))).toHaveLength(1);
    expect(tty.output.some((value) => value.includes("\u001b[47m\u001b[30m"))).toBe(true);
    expect(tty.output.some((value) => value.includes("\u001b[?1049l"))).toBe(true);
    expect(tty.errors).toEqual([]);
  });

  it("owns QR display through repeated terminal shrink and growth without changing the operation", async () => {
    const awaiting = operation({
      kind: "connect",
      state: "awaiting_wallet_approval",
      result: null,
    });
    const completed = operation({
      kind: "connect",
      state: "completed",
      result: { outcome: "connected", connection: connected },
    });
    let reads = 0;
    const runtime = new FakeRuntime((request) => {
      if (request.method === "POST") return successResponse(200, operationStartResponse(awaiting, qr));
      reads += 1;
      return successResponse(200, reads < 4 ? { operation: awaiting, qr } : { operation: completed });
    });
    const tty = fakeTerminal({ columns: 29, rows: 14 });
    let polls = 0;

    expect(await runCli(["wallet", "connect"], dependencies(runtime, tty, () => {
      polls += 1;
      if (polls === 1 || polls === 3) tty.setDimensions(30, 15);
      if (polls === 2) tty.setDimensions(29, 14);
    }))).toBe(0);

    expect(runtime.requests.some(({ method }) => method === "DELETE")).toBe(false);
    expect(new Set(runtime.requests.map(({ path }) => path))).toEqual(new Set([
      walletControlRoutes.operations,
      walletControlRoutes.operation(operationId),
    ]));
    expect(tty.events.filter((event) => event === "qr_show")).toHaveLength(2);
    expect(tty.events.filter((event) => event === "qr_hide")).toHaveLength(2);
    expect(tty.output.filter((value) => value.includes("\u001b[?1049h"))).toHaveLength(2);
    expect(tty.output.filter((value) => value.includes("\u001b[?1049l"))).toHaveLength(2);
    expect(tty.output.filter((value) => value.includes("Current terminal dimensions"))).toHaveLength(2);
  });

  it("reports unknown dimensions without rendering partial QR material", async () => {
    const awaiting = operation({
      kind: "connect",
      state: "awaiting_wallet_approval",
      result: null,
    });
    const cancelled = operation({ kind: "connect", state: "cancelled", result: null });
    const runtime = new FakeRuntime((request) => request.method === "POST"
      ? successResponse(200, operationStartResponse(awaiting, qr))
      : successResponse(200, { operation: cancelled }));
    let tty!: FakeTerminalResult;
    tty = fakeTerminal({
      columns: undefined,
      rows: undefined,
      onOutput(value, result) {
        if (value.includes("Current terminal dimensions")) result.resolveInterrupt();
      },
    });

    expect(await runCli(["wallet", "connect"], dependencies(runtime, tty))).toBe(0);
    expect(tty.output.join("")).toContain("Current terminal dimensions: unknown columns x unknown rows");
    expect(tty.output.join("")).toContain("Minimum terminal dimensions for this QR: 30 columns x 15 rows");
    expect(tty.output.join("")).not.toContain("\u001b[47m\u001b[30m");
  });

  it("releases each poll interrupt subscription before the next operation observation", async () => {
    const awaiting = operation({
      kind: "connect",
      state: "awaiting_wallet_approval",
      result: null,
    });
    const completed = operation({
      kind: "connect",
      state: "completed",
      result: { outcome: "connected", connection: connected },
    });
    let reads = 0;
    const runtime = new FakeRuntime((request) => {
      if (request.method === "POST") return successResponse(200, operationStartResponse(awaiting, qr));
      reads += 1;
      return successResponse(200, { operation: reads < 12 ? awaiting : completed, ...(reads < 12 ? { qr } : {}) });
    });
    const terminal = fakeTerminal();
    const listenerCounts: number[] = [];

    expect(await runCli(["wallet", "connect"], {
      createOperationId: () => operationId,
      createRuntime: async () => runtime,
      terminal: terminal.terminal,
      waitForPoll: () => new Promise<void>((resolvePoll) => {
        queueMicrotask(() => {
          listenerCounts.push(getEventListeners(terminal.terminal.interruptSignal, "abort").length);
          resolvePoll();
        });
      }),
      terminateProcess: () => undefined,
    })).toBe(0);
    expect(listenerCounts).toHaveLength(12);
    expect(new Set(listenerCounts)).toEqual(new Set([1]));
    expect(getEventListeners(terminal.terminal.interruptSignal, "abort")).toEqual([]);
  });

  it("does not dispatch an observation when interruption latches after polling completes", async () => {
    const awaiting = operation({
      kind: "connect",
      state: "awaiting_wallet_approval",
      result: null,
    });
    const cancelled = operation({ kind: "connect", state: "cancelled", result: null });
    const terminal = fakeTerminal();
    const runtime = new FakeRuntime((request) => {
      if (request.method === "POST") return successResponse(200, operationStartResponse(awaiting, qr));
      if (request.method === "DELETE") return successResponse(200, { operation: cancelled });
      throw new Error("operation observation must not be dispatched");
    });

    expect(await runCli(["wallet", "connect"], {
      createOperationId: () => operationId,
      createRuntime: async () => runtime,
      terminal: terminal.terminal,
      waitForPoll: () => new Promise<void>((resolvePoll) => {
        resolvePoll();
        queueMicrotask(() => { terminal.resolveInterrupt(); });
      }),
      terminateProcess: () => undefined,
    })).toBe(0);
    expect(runtime.requests.map(({ method }) => method)).toEqual(["POST", "DELETE"]);
  });

  it("starts exact cancellation while an operation observation is still pending", async () => {
    const awaiting = operation({
      kind: "connect",
      state: "awaiting_wallet_approval",
      result: null,
    });
    const cancelled = operation({ kind: "connect", state: "cancelled", result: null });
    const observation = deferred<RuntimeDispatchResponse>();
    const observationEntered = deferred<void>();
    const cancellationEntered = deferred<void>();
    const terminal = fakeTerminal();
    const runtime = new FakeRuntime((request) => {
      if (request.method === "POST") return successResponse(200, operationStartResponse(awaiting, qr));
      if (request.method === "GET") {
        observationEntered.resolve(undefined);
        return observation.promise;
      }
      if (request.method === "DELETE") {
        cancellationEntered.resolve(undefined);
        return successResponse(200, { operation: cancelled });
      }
      throw new Error("unexpected operation request");
    });
    const running = runCli(["wallet", "connect"], dependencies(runtime, terminal));

    await observationEntered.promise;
    terminal.resolveInterrupt();
    await cancellationEntered.promise;
    observation.resolve(successResponse(200, { operation: awaiting, qr }));

    expect(await running).toBe(0);
    expect(runtime.requests.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: "POST", path: walletControlRoutes.operations },
      { method: "GET", path: walletControlRoutes.operation(operationId) },
      { method: "DELETE", path: walletControlRoutes.operation(operationId) },
    ]);
  });

  it("clears a displayed QR and settles exact-operation cancellation on interrupt", async () => {
    const awaiting = operation({
      kind: "connect",
      state: "awaiting_wallet_approval",
      result: null,
    });
    const cancelled = operation({ kind: "connect", state: "cancelled", result: null });
    const events: string[] = [];
    const runtime = new FakeRuntime((request) => {
      events.push(request.method === "DELETE" ? "cancel" : request.method.toLowerCase());
      return request.method === "POST"
        ? successResponse(200, operationStartResponse(awaiting, qr))
        : successResponse(200, { operation: cancelled });
    });
    runtime.onOwnerSessionOpen = () => events.push("session-open");
    let tty!: FakeTerminalResult;
    tty = fakeTerminal({
      onOutput(value, result) {
        events.push(value.includes("\u001b[?1049l") ? "clear" : "output");
        if (value.includes("\u001b[47m\u001b[30m")) result.resolveInterrupt();
      },
    });

    expect(await runCli(["wallet", "connect"], dependencies(runtime, tty))).toBe(0);
    expect(events.lastIndexOf("session-open")).toBeGreaterThan(events.indexOf("output"));
    expect(events.indexOf("clear")).toBeGreaterThan(events.lastIndexOf("session-open"));
    expect(runtime.requests.some((request) => request.method === "DELETE" &&
      request.path === walletControlRoutes.operation(operationId))).toBe(true);
  });

  it("settles exact cancellation even when the first terminal restoration write fails", async () => {
    const awaiting = operation({
      kind: "connect",
      state: "awaiting_wallet_approval",
      result: null,
    });
    const runtime = new FakeRuntime((request) => request.method === "POST"
      ? successResponse(200, operationStartResponse(awaiting, qr))
      : failureResponse("runtime_state_unavailable"));
    let terminal!: FakeTerminalResult;
    terminal = fakeTerminal({
      hideQrFailures: 1,
      onOutput(value, result) {
        if (value.includes("\u001b[47m\u001b[30m")) result.resolveInterrupt();
      },
    });

    expect(await runCli(["wallet", "connect"], dependencies(runtime, terminal))).toBe(7);
    expect(runtime.requests.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: "POST", path: walletControlRoutes.operations },
      { method: "DELETE", path: walletControlRoutes.operation(operationId) },
    ]);
    expect(terminal.events).toContain("qr_hide_failure");
    expect(terminal.events).toContain("qr_hide");
    expect(terminal.errors.join("")).toBe(
      "runtime_state_unavailable: Local runtime state is unavailable.\n",
    );
  });

  it("preserves an authoritative completion across a transient QR restoration failure", async () => {
    const awaiting = operation({
      kind: "connect",
      state: "awaiting_wallet_approval",
      result: null,
    });
    const completed = operation({
      kind: "connect",
      state: "completed",
      result: { outcome: "connected", connection: connected },
    });
    const runtime = new FakeRuntime((request) => request.method === "POST"
      ? successResponse(200, operationStartResponse(awaiting, qr))
      : successResponse(200, { operation: completed }));
    const terminal = fakeTerminal({ hideQrFailures: 1 });

    expect(await runCli(["wallet", "connect"], dependencies(runtime, terminal))).toBe(0);
    expect(runtime.requests.map(({ method }) => method)).toEqual(["POST", "GET"]);
    expect(terminal.events).toContain("qr_hide_failure");
    expect(terminal.events).toContain("qr_hide");
    expect(terminal.output.join("")).toContain(": completed");
    expect(terminal.errors).toEqual([]);
  });

  it("converges presentation, polling, and observation failures through exact cancellation", async () => {
    for (const failurePoint of ["presentation", "poll", "observation"] as const) {
      const awaiting = operation({
        kind: "connect",
        state: "awaiting_wallet_approval",
        result: null,
      });
      const cancelled = operation({ kind: "connect", state: "cancelled", result: null });
      const runtime = new FakeRuntime((request) => {
        if (request.method === "POST") return successResponse(200, operationStartResponse(awaiting, qr));
        if (request.method === "DELETE") return successResponse(200, { operation: cancelled });
        if (failurePoint === "observation") return failureResponse("runtime_state_unavailable");
        throw new Error("operation observation must not run");
      });
      const terminal = fakeTerminal({
        ...(failurePoint === "presentation" ? { showQrFailures: 1 } : {}),
      });

      const exitCode = await runCli(["wallet", "connect"], {
        createOperationId: () => operationId,
        createRuntime: async () => runtime,
        terminal: terminal.terminal,
        waitForPoll: failurePoint === "poll"
          ? async () => { throw new Error("secret polling failure"); }
          : async () => undefined,
        terminateProcess: () => undefined,
      });

      expect(exitCode).toBe(failurePoint === "observation" ? 7 : 1);
      expect(runtime.requests.filter(({ method }) => method === "DELETE")
        .map(requestWithoutSignal)).toEqual([{
        requestClass: "local_control",
        method: "DELETE",
        path: walletControlRoutes.operation(operationId),
      }]);
    }
  });

  it("reports an authoritative completion when presentation cleanup loses the state race", async () => {
    const awaiting = operation({
      kind: "connect",
      state: "awaiting_wallet_approval",
      result: null,
    });
    const completed = operation({
      kind: "connect",
      state: "completed",
      result: { outcome: "connected", connection: connected },
    });
    const runtime = new FakeRuntime((request) => {
      if (request.method === "POST") return successResponse(200, operationStartResponse(awaiting, qr));
      if (request.method === "DELETE") return failureResponse("state_conflict");
      return successResponse(200, { operation: completed });
    });
    const terminal = fakeTerminal({ showQrFailures: 1 });

    expect(await runCli(["wallet", "connect"], dependencies(runtime, terminal))).toBe(0);
    expect(runtime.requests.map(({ method }) => method)).toEqual(["POST", "DELETE", "GET"]);
    expect(terminal.output.join("")).toContain(": completed");
    expect(terminal.errors).toEqual([]);
  });

  it("reports an authoritative expiry when observation cleanup loses the state race", async () => {
    const awaiting = operation({
      kind: "connect",
      state: "awaiting_wallet_approval",
      result: null,
    });
    const expired = operation({ kind: "connect", state: "expired", result: null });
    let operationReads = 0;
    const runtime = new FakeRuntime((request) => {
      if (request.method === "POST") return successResponse(200, operationStartResponse(awaiting, qr));
      if (request.method === "DELETE") return failureResponse("state_conflict");
      operationReads += 1;
      return operationReads === 1
        ? failureResponse("runtime_state_unavailable")
        : successResponse(200, { operation: expired });
    });
    const terminal = fakeTerminal();

    expect(await runCli(["wallet", "connect"], dependencies(runtime, terminal))).toBe(4);
    expect(runtime.requests.map(({ method }) => method)).toEqual(["POST", "GET", "DELETE", "GET"]);
    expect(terminal.errors.join("")).toBe("wallet_timeout: The wallet request timed out.\n");
  });

  it("derives a rejected connection command from the canonical terminal-state failure mapping", async () => {
    const awaiting = operation({
      kind: "connect",
      state: "awaiting_wallet_approval",
      result: null,
    });
    const rejected = operation({ kind: "connect", state: "rejected", result: null });
    const runtime = new FakeRuntime((request) => request.method === "POST"
      ? successResponse(200, operationStartResponse(awaiting, qr))
      : successResponse(200, { operation: rejected }));
    const terminal = fakeTerminal();

    expect(await runCli(["wallet", "connect"], dependencies(runtime, terminal))).toBe(5);
    expect(runtime.requests.map(({ method }) => method)).toEqual(["POST", "GET"]);
    expect(terminal.errors.join("")).toBe(
      "wallet_user_rejected: The user rejected the wallet request.\n",
    );
  });

  it("finishes an authoritative transition when interrupt cancellation loses the state race", async () => {
    const awaiting = operation({
      kind: "connect",
      state: "awaiting_wallet_approval",
      result: null,
    });
    const validating = operation({
      kind: "connect",
      state: "validating_session",
      result: null,
    });
    const completed = operation({
      kind: "connect",
      state: "completed",
      result: { outcome: "connected", connection: connected },
    });
    let reads = 0;
    const runtime = new FakeRuntime((request) => {
      if (request.method === "POST") return successResponse(200, operationStartResponse(awaiting, qr));
      if (request.method === "DELETE") return failureResponse("state_conflict");
      reads += 1;
      return successResponse(200, { operation: reads === 1 ? validating : completed });
    });
    let tty!: FakeTerminalResult;
    tty = fakeTerminal({
      onOutput(value, result) {
        if (value.includes("\u001b[47m\u001b[30m")) result.resolveInterrupt();
      },
    });

    expect(await runCli(["wallet", "connect"], dependencies(runtime, tty))).toBe(0);
    expect(runtime.requests.map(({ method }) => method)).toEqual(["POST", "DELETE", "GET", "GET"]);
    expect(tty.output.join("")).toContain(": completed");
    expect(runtime.stopCount).toBe(1);
  });

  it("fails closed when a status route returns a wallet error outside the connection contract", async () => {
    const runtime = new FakeRuntime(() => failureResponse("wallet_session_unusable"));
    const tty = fakeTerminal();
    expect(await runCli(["wallet", "status", "--json"], dependencies(runtime, tty))).toBe(1);
    expect(JSON.parse(tty.output.join(""))).toEqual(createWalletFailure("internal_error"));
    expect(tty.errors).toEqual([]);
  });

  it("preserves a status failure declared by the connection contract", async () => {
    const runtime = new FakeRuntime(() => failureResponse("runtime_state_unavailable"));
    const terminal = fakeTerminal();
    expect(await runCli(["wallet", "status"], dependencies(runtime, terminal))).toBe(7);
    expect(terminal.errors).toEqual([
      "runtime_state_unavailable: Local runtime state is unavailable.\n",
    ]);
  });

  it("attempts runtime and terminal cleanup before reporting any command failure", async () => {
    const runtime = new FakeRuntime(
      () => { throw new Error("secret command failure"); },
      "deferred",
      new Error("secret runtime stop failure"),
    );
    const terminal = fakeTerminal({ writeErrorError: new Error("terminal report failed") });
    const forcedExitCodes: number[] = [];

    expect(await runCli([
      "wallet", "status",
    ], dependencies(runtime, terminal, undefined, (exitCode) => { forcedExitCodes.push(exitCode); }))).toBe(1);
    expect(runtime.stopCount).toBe(1);
    expect(terminal.disposed()).toBe(true);
    expect(terminal.errors).toEqual([]);
    expect(forcedExitCodes).toEqual([1]);
  });

  it("retains the runtime handle and stops it when owner startup fails", async () => {
    const runtime = new FakeRuntime(
      () => { throw new Error("command must not run"); },
      "stopping",
      undefined,
      new Error("secret owner startup failure"),
    );
    const terminal = fakeTerminal();

    expect(await runCli(["wallet", "status"], dependencies(runtime, terminal))).toBe(1);
    expect(runtime.startCount).toBe(1);
    expect(runtime.requests).toEqual([]);
    expect(runtime.stopCount).toBe(1);
    expect(terminal.disposed()).toBe(true);
    expect(terminal.errors.join("")).toBe("internal_error: The request could not be completed.\n");
  });

  it("does not inspect forged or proxied wallet error objects from the runtime boundary", async () => {
    let getterReads = 0;
    const forged = Object.create(WalletOperationError.prototype) as Record<string, unknown>;
    Object.defineProperty(forged, "failure", {
      enumerable: true,
      get: () => {
        getterReads += 1;
        throw new Error("secret-forged-failure");
      },
    });
    let proxyReads = 0;
    const proxied = new Proxy(new WalletOperationError("state_conflict"), {
      get: () => {
        proxyReads += 1;
        throw new Error("secret-proxy-failure");
      },
      getPrototypeOf: () => {
        proxyReads += 1;
        throw new Error("secret-proxy-failure");
      },
    });

    for (const hostile of [forged, proxied]) {
      const runtime = new FakeRuntime(() => { throw hostile; });
      const terminal = fakeTerminal();
      expect(await runCli(["wallet", "status"], dependencies(runtime, terminal))).toBe(1);
      expect(terminal.errors.join(""))
        .toBe("internal_error: The request could not be completed.\n");
      expect(runtime.stopCount).toBe(1);
      expect(terminal.disposed()).toBe(true);
    }
    expect(getterReads).toBe(0);
    expect(proxyReads).toBe(0);
  });

  it("preserves the command failure while still attempting a failing terminal disposal", async () => {
    const runtime = new FakeRuntime(() => failureResponse("wallet_session_unusable"));
    const terminal = fakeTerminal({ disposeError: new Error("terminal dispose failed") });

    expect(await runCli(["wallet", "status"], dependencies(runtime, terminal))).toBe(1);
    expect(runtime.stopCount).toBe(1);
    expect(terminal.disposed()).toBe(true);
    expect(terminal.errors.join("")).toBe(
      "internal_error: The request could not be completed.\n",
    );
  });
});
