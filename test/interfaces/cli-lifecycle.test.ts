import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, rm, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import {
  accountAssetInterfaceErrorMappings,
  createAccountAssetFailure,
} from "../../src/account-assets/index.js";
import {
  canonicalJsonStringify,
  captureCanonicalJson,
  parseUnsignedDecimal,
} from "../../src/core/index.js";
import {
  createProcessTerminal,
  runCli,
  type CliDependencies,
  type CliRuntimePort,
  type CliTerminalPort,
} from "../../src/cli.js";
import type { StdioMcpOwner } from "../../src/interfaces/index.js";
import {
  jsonContentType,
  noStoreCacheControl,
  problemJsonContentType,
  RuntimeOperationError,
  toProblemDetails,
  type RuntimeOwnerSession,
  type RuntimeOwnerSendResult,
} from "../../src/runtime/index.js";
import {
  parseOwnerInstanceId,
  parseProfileId,
  parseRuntimeConfigurationMac,
} from "../../src/runtime/runtime-identity.js";
import {
  runtimeProcessTerminal,
  runtimeReleased,
  type RuntimeShutdownOutcome,
} from "../../src/runtime/shutdown.js";
import { tokenCatalogInterfaceErrorMappings } from "../../src/token-catalog/errors.js";
import {
  parseWalletManagementOperation,
  parseWalletReview,
  walletReviewDigest,
} from "../../src/wallet/contracts.js";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

const operationId = Buffer.alloc(32, 41).toString("base64url");
const reviewInput = Object.freeze({
  contractVersion: "1" as const,
  domain: "wallet" as const,
  operationId,
  kind: "connect" as const,
  createdAt: "2026-08-15T00:00:00.000Z",
  actionExpiresAt: "2026-08-15T00:05:00.000Z",
  target: { chainId: "eip155:4663" },
  decision: {
    requiredMethods: ["eth_sendTransaction"] as const,
    optionalMethods: ["personal_sign", "eth_signTypedData_v4"] as const,
    requiredEvents: ["accountsChanged", "chainChanged"] as const,
  },
  precondition: {
    connectionRevision: "4",
    connection: { status: "disconnected" as const, reason: "no_session" as const },
  },
  fixedEvidence: { sessionSourceIds: [] as const },
});
const review = parseWalletReview({
  ...reviewInput,
  reviewDigest: walletReviewDigest(reviewInput),
});
const operation = parseWalletManagementOperation({
  contractVersion: "1",
  domain: "wallet",
  operationId,
  kind: "connect",
  initiatedBy: "cli",
  review,
  state: "cancelled",
  terminationTarget: null,
  result: null,
  failure: null,
  peerRefusalCode: null,
});

const sessionIdentity = Object.freeze({
  profileId: parseProfileId(Buffer.alloc(16, 42).toString("base64url")),
  ownerInstanceId: parseOwnerInstanceId(Buffer.alloc(16, 43).toString("base64url")),
  configurationMac: parseRuntimeConfigurationMac(Buffer.alloc(32, 44).toString("base64url")),
  ownerRevision: parseUnsignedDecimal("1"),
});

const received = (statusCode: number, body: unknown): RuntimeOwnerSendResult => Object.freeze({
  status: "response_received",
  response: Object.freeze({
    statusCode,
    contentType: statusCode >= 400 ? problemJsonContentType : jsonContentType,
    cacheControl: noStoreCacheControl,
    bytes: new TextEncoder().encode(
      `${canonicalJsonStringify(captureCanonicalJson(body))}\n`,
    ),
  }),
});

class LifecycleRuntime implements CliRuntimePort {
  readonly ownerState = "deferred" as const;
  readonly events: string[];
  readonly #response: RuntimeOwnerSendResult;
  readonly #sessionCloseFailure: unknown;
  readonly #stopFailure: unknown;
  readonly #stopOutcome: RuntimeShutdownOutcome;
  readonly #start: (() => Promise<void>) | undefined;
  startCalls = 0;
  stopCalls = 0;
  openCalls = 0;
  sessionCloseCalls = 0;

  constructor(input: Readonly<{
    events: string[];
    response?: RuntimeOwnerSendResult;
    sessionCloseFailure?: unknown;
    stopFailure?: unknown;
    stopOutcome?: RuntimeShutdownOutcome;
    start?: () => Promise<void>;
  }>) {
    this.events = input.events;
    this.#response = input.response ?? received(200, operation);
    this.#sessionCloseFailure = input.sessionCloseFailure;
    this.#stopFailure = input.stopFailure;
    this.#stopOutcome = input.stopOutcome ?? runtimeReleased;
    this.#start = input.start;
  }

  presentationSnapshotStore(): never {
    throw new Error("CLI lifecycle tests must not request the MCP snapshot store.");
  }

  async dispatchRuntimeRequest(): Promise<never> {
    throw new Error("CLI lifecycle tests must use the owner-session boundary.");
  }

  async start(): Promise<void> {
    this.startCalls += 1;
    this.events.push("runtime.start");
    await this.#start?.();
  }

  async stop(): Promise<RuntimeShutdownOutcome> {
    this.stopCalls += 1;
    this.events.push("runtime.stop");
    if (this.#stopFailure !== undefined) throw this.#stopFailure;
    return this.#stopOutcome;
  }

  async openOwnerSession(): Promise<RuntimeOwnerSession> {
    this.openCalls += 1;
    const owner = this;
    return Object.freeze({
      identity: sessionIdentity,
      usable: true,
      async send(): Promise<RuntimeOwnerSendResult> { return owner.#response; },
      close(): void {
        owner.sessionCloseCalls += 1;
        if (owner.#sessionCloseFailure !== undefined) throw owner.#sessionCloseFailure;
      },
    });
  }
}

const capturedTerminal = (input: Readonly<{
  controller?: AbortController;
  events?: string[];
}> = {}) => {
  const output: string[] = [];
  const errors: string[] = [];
  const events = input.events ?? [];
  const controller = input.controller ?? new AbortController();
  const terminal: CliTerminalPort = Object.freeze({
    inputIsTTY: false,
    outputIsTTY: false,
    columns: undefined,
    rows: undefined,
    interruptSignal: controller.signal,
    writeOutput(value: string): void { output.push(value); },
    writeError(value: string): void { errors.push(value); },
    showQr(): void { throw new Error("CLI lifecycle tests must not show a QR."); },
    hideQr(): void {},
    async readLine(): Promise<string> { throw new Error("CLI lifecycle tests must not read input."); },
    dispose(): void { events.push("terminal.dispose"); },
  });
  return Object.freeze({ terminal, output, errors, events, controller });
};

const dependencies = (
  runtime: CliRuntimePort,
  captured: Pick<ReturnType<typeof capturedTerminal>, "terminal">,
  input: Readonly<{
    createMcp?: () => StdioMcpOwner;
    settleOutput?: () => Promise<void>;
  }> = {},
): CliDependencies => Object.freeze({
  createRuntime: async () => runtime,
  terminal: captured.terminal,
  waitForPoll: async () => undefined,
  createMcp: input.createMcp ?? (() => { throw new Error("MCP must not be created."); }),
  ...(input.settleOutput === undefined ? {} : { settleOutput: input.settleOutput }),
});

const processTerminalFixture = () => {
  const host = Object.assign(new EventEmitter(), {
    stdin: Object.assign(new PassThrough(), { isTTY: true }),
    stdout: Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 }),
    stderr: new PassThrough(),
  });
  const output: string[] = [], errors: string[] = [];
  host.stdout.on("data", (value: Buffer) => { output.push(value.toString()); });
  host.stderr.on("data", (value: Buffer) => { errors.push(value.toString()); });
  const terminal = createProcessTerminal(host);
  return { host, terminal, output, errors, async close() {
    terminal.dispose();
    await terminal.outputOwner.settle();
    host.stdin.destroy(); host.stdout.destroy(); host.stderr.destroy();
  } };
};

describe("signing input acquisition and CLI cleanup", () => {
  it.runIf(process.platform !== "win32")("rejects a real FIFO without a writer and completes CLI cleanup", async ({ task }) => {
    const root = await mkdtemp(join(tmpdir(), "littlejohn-signing-input-"));
    const captured = processTerminalFixture();
    const events: string[] = [];
    const runtime = new LifecycleRuntime({ events });
    let rescue: Promise<FileHandle> | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const fifo = join(root, "payload.fifo");
      execFileSync("mkfifo", [fifo]);
      expect((await lstat(fifo)).isFIFO()).toBe(true);
      // Safety escape for a regressed blocking open. Needing this writer fails
      // the test; half the runner budget leaves time to settle and close it.
      watchdog = setTimeout(() => {
        rescue = open(fifo, constants.O_RDWR | constants.O_NONBLOCK);
        void rescue.catch(() => undefined);
      }, task.timeout / 2);
      const result = await runCli(["signing", "start", "--active", "--file", fifo], dependencies(runtime, captured, {
        settleOutput: () => captured.terminal.outputOwner.settle(),
      }));
      clearTimeout(watchdog);
      expect(rescue).toBeUndefined();
      expect(result).toEqual({ exitCode: 2, processDisposition: "natural_exit" });
      expect(captured.errors).toEqual(["invalid_input: The request input is invalid.\n"]);
      expect(runtime.openCalls).toBe(0);
      expect(events).toEqual(["runtime.start", "runtime.stop"]);
      expect((await vi.mocked(open).mock.results[0]!.value).fd).toBe(-1);
      expect(captured.host.listenerCount("SIGINT")).toBe(0);
    } finally {
      clearTimeout(watchdog);
      await (await rescue)?.close();
      await captured.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("consumes an interrupt during real file acquisition before creating a Review and closes the acquired handle", async () => {
    const root = await mkdtemp(join(tmpdir(), "littlejohn-signing-interrupt-"));
    const captured = processTerminalFixture();
    const events: string[] = [];
    const runtime = new LifecycleRuntime({ events });
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let acquired: FileHandle | undefined;
    try {
      const file = join(root, "payload.json");
      await writeFile(file, JSON.stringify({ kind: "personal", encoding: "utf8", value: "Synthetic signing input" }));
      vi.mocked(open).mockImplementationOnce(async (...args) => {
        acquired = await actual.open(...args);
        captured.host.emit("SIGINT");
        return acquired;
      });
      const result = await runCli(["signing", "start", "--active", "--file", file], dependencies(runtime, captured, {
        settleOutput: () => captured.terminal.outputOwner.settle(),
      }));
      expect(captured.terminal.interruptSignal.aborted).toBe(true);
      expect(result).toEqual({ exitCode: 4, processDisposition: "natural_exit" });
      expect(captured.errors).toEqual(["request_aborted: The request ended before completion.\n"]);
      expect(runtime.openCalls).toBe(0);
      expect(events).toEqual(["runtime.start", "runtime.stop"]);
      expect(acquired?.fd).toBe(-1);
      expect(captured.host.listenerCount("SIGINT")).toBe(0);
    } finally {
      await acquired?.close();
      await captured.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("CLI dependent cleanup and process disposition", () => {
  it("keeps a nonzero read result and skips Runtime stop when direct cleanup rejects", async () => {
    const events: string[] = [];
    const captured = capturedTerminal({ events });
    const cleanupFailure = new Error("session cleanup failed");
    const sourceFailure = createAccountAssetFailure("runtime_state_unavailable");
    const problem = toProblemDetails(sourceFailure, accountAssetInterfaceErrorMappings);
    const runtime = new LifecycleRuntime({
      events,
      response: received(problem.status, problem),
      sessionCloseFailure: cleanupFailure,
    });

    const result = await runCli(["read", "assets", "--active"], dependencies(runtime, captured, {
      settleOutput: async () => { events.push("output.settle"); },
    }));

    expect(result).toEqual({
      exitCode: accountAssetInterfaceErrorMappings.get("runtime_state_unavailable").cliExitCode,
      processDisposition: "process_exit_required",
    });
    expect(runtime.openCalls).toBe(1);
    expect(runtime.sessionCloseCalls).toBe(2);
    expect(runtime.stopCalls).toBe(0);
    expect(captured.errors).toEqual([
      "runtime_state_unavailable: Local runtime state is unavailable.\n",
    ]);
    expect(events).toEqual([
      "runtime.start",
      "terminal.dispose",
      "output.settle",
    ]);
  });

  it("maps cleanup rejection after a successful command to internal error", async () => {
    const events: string[] = [];
    const captured = capturedTerminal({ events });
    const runtime = new LifecycleRuntime({
      events,
      sessionCloseFailure: new Error("session cleanup failed"),
    });

    const result = await runCli(
      ["wallet", "operation", operationId],
      dependencies(runtime, captured),
    );

    expect(result).toEqual({
      exitCode: tokenCatalogInterfaceErrorMappings.get("internal_error").cliExitCode,
      processDisposition: "process_exit_required",
    });
    expect(runtime.stopCalls).toBe(0);
    expect(captured.output.join("")).toContain(`Wallet operation ${operationId}: cancelled`);
    expect(captured.errors).toEqual([
      "internal_error: The request could not be completed.\n",
    ]);
  });

  it("uses a fulfilled direct cleanup and released Runtime as the natural-exit proof", async () => {
    const events: string[] = [];
    const captured = capturedTerminal({ events });
    const runtime = new LifecycleRuntime({ events });

    const result = await runCli(
      ["wallet", "operation", operationId],
      dependencies(runtime, captured),
    );

    expect(result).toEqual({ exitCode: 0, processDisposition: "natural_exit" });
    expect(runtime.sessionCloseCalls).toBe(1);
    expect(runtime.stopCalls).toBe(1);
    expect(events).toEqual(["runtime.start", "runtime.stop", "terminal.dispose"]);
  });

  it("does not stop Runtime when MCP release rejects", async () => {
    const events: string[] = [];
    const captured = capturedTerminal({ events });
    const runtime = new LifecycleRuntime({ events });
    const mcp: StdioMcpOwner = Object.freeze({
      closed: Promise.resolve(),
      start: () => Promise.resolve(),
      close: () => Promise.reject(new Error("MCP cleanup failed")),
    });

    const result = await runCli([], dependencies(runtime, captured, { createMcp: () => mcp }));

    expect(result.processDisposition).toBe("process_exit_required");
    expect(result.exitCode).toBe(tokenCatalogInterfaceErrorMappings.get("internal_error").cliExitCode);
    expect(runtime.stopCalls).toBe(0);
  });

  it("retains MCP terminal failure but stops Runtime after fulfilled MCP release", async () => {
    const events: string[] = [];
    const captured = capturedTerminal({ events });
    const runtime = new LifecycleRuntime({ events });
    const terminalFailure = new Error("MCP terminal failed");
    const closed = Promise.reject(terminalFailure);
    void closed.catch(() => undefined);
    const mcp: StdioMcpOwner = Object.freeze({
      closed,
      start: () => Promise.resolve(),
      close: () => Promise.resolve(),
    });

    const result = await runCli([], dependencies(runtime, captured, { createMcp: () => mcp }));

    expect(result.processDisposition).toBe("natural_exit");
    expect(result.exitCode).toBe(tokenCatalogInterfaceErrorMappings.get("internal_error").cliExitCode);
    expect(runtime.stopCalls).toBe(1);
  });

  it("requires process exit when Runtime stop rejects after dependent release", async () => {
    const events: string[] = [];
    const captured = capturedTerminal({ events });
    const runtime = new LifecycleRuntime({
      events,
      stopFailure: new RuntimeOperationError("runtime_state_unavailable"),
    });

    const result = await runCli(
      ["wallet", "operation", operationId],
      dependencies(runtime, captured),
    );

    expect(result.processDisposition).toBe("process_exit_required");
    expect(result.exitCode)
      .toBe(tokenCatalogInterfaceErrorMappings.get("runtime_state_unavailable").cliExitCode);
    expect(runtime.stopCalls).toBe(1);
  });

  it("uses the one startup-interruption stop result without creating a dependent", async () => {
    const events: string[] = [];
    const controller = new AbortController();
    const captured = capturedTerminal({ controller, events });
    const runtime = new LifecycleRuntime({
      events,
      start: async () => {
        controller.abort();
        throw new RuntimeOperationError("request_aborted");
      },
    });

    const result = await runCli(["wallet", "status"], dependencies(runtime, captured));

    expect(result).toEqual({ exitCode: 0, processDisposition: "natural_exit" });
    expect(runtime.startCalls).toBe(1);
    expect(runtime.stopCalls).toBe(1);
    expect(runtime.openCalls).toBe(0);
    expect(events).toEqual(["runtime.start", "runtime.stop", "terminal.dispose"]);
  });

  it("uses the actual pre-start interruption stop result for the process decision", async () => {
    const events: string[] = [];
    const controller = new AbortController();
    const captured = capturedTerminal({ controller, events });
    const runtime = new LifecycleRuntime({
      events,
      stopOutcome: runtimeProcessTerminal,
    });
    const runDependencies = Object.freeze({
      ...dependencies(runtime, captured),
      createRuntime: async (): Promise<CliRuntimePort> => {
        controller.abort();
        return runtime;
      },
    });

    const result = await runCli(["wallet", "status"], runDependencies);

    expect(result).toEqual({ exitCode: 0, processDisposition: "process_exit_required" });
    expect(runtime.startCalls).toBe(0);
    expect(runtime.stopCalls).toBe(1);
    expect(runtime.openCalls).toBe(0);
    expect(events).toEqual(["runtime.stop", "terminal.dispose"]);
  });
});
