import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, rm, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
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
import { createWalletFailure } from "../../src/wallet/operation-error.js";
import { walletInterfaceErrorMappings } from "../../src/wallet/errors.js";
import { walletAccountSelectionSchema } from "../../src/wallet/account-selection-contract.js";
import { stockTokenTradeHistoryUnavailableFixture } from "./stock-token-trade-history-fixture.js";
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

  presentationPublicationKeys(): never { throw new Error("CLI lifecycle must not derive a presentation key."); }

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
    writeSignature: async () => { throw new Error("This command must not deliver a signature."); },
    showQr(): Promise<"written" | "unavailable"> { throw new Error("CLI lifecycle tests must not show a QR."); },
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
      expect(captured.errors).toEqual(["Request failed\nSome request details are invalid. Check the fields listed in Error details.\nError details\nError code: invalid_input\nReported reason: The request input is invalid.\n"]);
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
      expect(captured.errors).toEqual(["Request failed\nThe request ended before a result was confirmed.\nError details\nError code: request_aborted\nReported reason: The request ended before completion.\n"]);
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
  it("preserves the exact Runtime result when its local reader cleanup fails without creating a backend client", async () => {
    const captured = capturedTerminal();
    const createRuntime = vi.fn(async (): Promise<CliRuntimePort> => { throw new Error("Administrative commands must not start a backend."); });
    const result = await runCli(["runtime", "stop", "--json"], {
      terminal: captured.terminal, createRuntime,
      createMcp: () => { throw new Error("No MCP on an administrative command."); },
      waitForPoll: async () => undefined,
      runRuntimeManagement: async () => ({ result: { status: "released", target: {
        profileId: sessionIdentity.profileId, ownerInstanceId: sessionIdentity.ownerInstanceId, ownerRevision: sessionIdentity.ownerRevision,
      } }, close: async () => { throw new Error("The reader did not close."); } }),
    });
    expect(createRuntime).not.toHaveBeenCalled();
    expect(result.processDisposition).toBe("process_exit_required");
    expect(result.exitCode).not.toBe(0);
    expect(captured.output).toHaveLength(1);
    expect(JSON.parse(captured.output[0]!)).toEqual({ status: "released", target: {
      profileId: sessionIdentity.profileId, ownerInstanceId: sessionIdentity.ownerInstanceId, ownerRevision: sessionIdentity.ownerRevision,
    } });
    expect(captured.errors.join("")).toContain("internal_error");
  });

  it("releases the Market owner session before stopping the runtime", async () => {
    const events: string[] = [];
    const captured = capturedTerminal({events});
    const value = stockTokenTradeHistoryUnavailableFixture();
    const runtime = new LifecycleRuntime({events, response: received(200, value)});
    const result = await runCli(["market", "stock-token-trade-history", "AAPL", "--json"], dependencies(runtime, captured));
    expect(result).toEqual({exitCode: 0, processDisposition: "natural_exit"});
    expect(JSON.parse(captured.output.join(""))).toEqual(value);
    expect(runtime.openCalls).toBe(1);
    expect(runtime.sessionCloseCalls).toBe(1);
    expect(runtime.stopCalls).toBe(1);
    expect(events).toEqual(["runtime.start", "runtime.stop", "terminal.dispose"]);
  });

  it("preserves a Market read failure and refuses runtime stop when owner-session cleanup fails", async () => {
    const events: string[] = [];
    const captured = capturedTerminal({events});
    const problem = toProblemDetails(createWalletFailure("runtime_state_unavailable"), walletInterfaceErrorMappings);
    const runtime = new LifecycleRuntime({events, response: received(problem.status, problem),
      sessionCloseFailure: new Error("Market owner session cleanup failed.")});
    const result = await runCli(["market", "stock-token-trade-history", "AAPL"], dependencies(runtime, captured));
    expect(result).toEqual({exitCode: 7, processDisposition: "process_exit_required"});
    expect(captured.errors).toEqual(["Request failed\nLittle John MCP could not get the local information needed for this request.\nError details\nError code: runtime_state_unavailable\nReported reason: Local runtime state is unavailable.\n"]);
    expect(runtime.sessionCloseCalls).toBe(2);
    expect(runtime.stopCalls).toBe(0);
  });

  it("labels the singleton account as effective without inventing a stored selection revision", async () => {
    const captured = capturedTerminal();
    const account = {chainId: "eip155:4663", address: `0x${"11".repeat(20)}`};
    const state = walletAccountSelectionSchema.parse({chainId: account.chainId, account,
      connectionId: `wallet-session:${Buffer.alloc(32, 51).toString("base64url")}`, connectionRevision: "4",
      selectionRevision: "0", eligibleAccounts: [account]});
    const runtime = new LifecycleRuntime({events: captured.events, response: received(200, state)});
    expect((await runCli(["wallet", "account-selection"], dependencies(runtime, captured))).exitCode).toBe(0);
    expect(captured.output.join("")).toContain("Network: Robinhood Chain");
    expect(captured.output.join("")).toContain(`${account.address} (current)`);
    expect(captured.output.join("")).not.toContain("preference");
    expect(state.selectionRevision).toBe("0");
    expect(runtime.openCalls).toBe(1);
    expect(runtime.sessionCloseCalls).toBe(1);
  });

  it.each(["wallet_session_unusable", "walletconnect_unavailable"] as const)(
    "renders a saved failed connection with its exact %s failure", async (code) => {
      const captured = capturedTerminal();
      const failed = parseWalletManagementOperation({...operation, state: "failed", failure: createWalletFailure(code)});
      const runtime = new LifecycleRuntime({events: captured.events, response: received(200, failed)});
      const result = await runCli(["wallet", "operation", operationId], dependencies(runtime, captured));
      expect(result.exitCode).toBe(0);
      const text = captured.output.join("");
      expect(text).toContain("Request failed\n");
      expect(text).not.toContain(operationId);
      expect(text).toContain("Connect wallet");
      expect(text).toContain("Network: Robinhood Chain");
      expect(text).toContain("Required: Transaction approval requests");
      expect(text).toContain("Optional: Message signature requests, Typed data signature requests");

      expect(text).toContain(`Error code: ${code}\nReported reason: ${failed.failure!.error.message}`);
      expect(text).not.toContain("disconnect it before starting");
      expect(runtime.openCalls).toBe(1);
    },
  );

  it("uses effective-account recovery wording for an unconfirmed direct selection", async () => {
    const captured = capturedTerminal();
    const account = {chainId: "eip155:4663", address: `0x${"11".repeat(20)}`};
    const state = walletAccountSelectionSchema.parse({chainId: account.chainId, account,
      connectionId: `wallet-session:${Buffer.alloc(32, 51).toString("base64url")}`, connectionRevision: "4",
      selectionRevision: "0", eligibleAccounts: [account]});
    let sends = 0;
    class SelectionRuntime extends LifecycleRuntime {
      override async openOwnerSession(): Promise<RuntimeOwnerSession> {
        const session = await super.openOwnerSession();
        return Object.freeze({...session, async send(): Promise<RuntimeOwnerSendResult> {
          sends += 1;
          return sends === 1 ? received(200, state) : {status: "response_unavailable_after_send_began"};
        }});
      }
    }
    const terminal = Object.freeze({...captured.terminal, inputIsTTY: true, outputIsTTY: true, readLine: async () => "1"});
    const runtime = new SelectionRuntime({events: captured.events});
    const result = await runCli(["wallet", "select-account"], dependencies(runtime, {terminal}));
    expect(result).toEqual({exitCode: 8, processDisposition: "natural_exit"});
    expect(captured.output.join("")).toContain("Network: Robinhood Chain");
    expect(captured.errors.join("")).toContain("The effective account alone does not prove this call succeeded.");
    expect(captured.errors.join("")).toBe("Result unknown\nThe result of this action could not be confirmed. It will not be repeated automatically.\nThe action may have occurred. Do not repeat it.\nRead wallet account-selection. The effective account alone does not prove this call succeeded.\n");
    expect(captured.errors.join("")).not.toMatch(/Not submitted|Declined/);
    expect(captured.errors.join("")).not.toContain("Current preference");
    expect(sends).toBe(2);
    expect(runtime.sessionCloseCalls).toBe(2);
  });

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
      "Request failed\nLittle John MCP could not get the local information needed for this request.\nError details\nError code: runtime_state_unavailable\nReported reason: Local runtime state is unavailable.\n",
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
    expect(captured.output.join("")).toContain("This connection request was cancelled in Little John MCP.");
    expect(captured.errors).toEqual([
      "Request failed\nThis request could not be completed.\nError details\nError code: internal_error\nReported reason: The request could not be completed.\n",
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


describe("terminal output admission and direct input", () => {
  const fixture = () => {
    const output: string[] = [];
    let releaseFirst: ((error?: Error | null) => void) | undefined;
    let first!: () => void;
    const firstWrite = new Promise<void>(resolve => { first = resolve; });
    const stdout = Object.assign(new Writable({write(chunk, _encoding, callback) {
      output.push(chunk.toString());
      if (output.length === 1) { releaseFirst = callback; first(); }
      else callback();
    }}), {isTTY: true, columns: 80, rows: 24});
    const stdin = Object.assign(new PassThrough(), {isTTY: true});
    const stderr = new PassThrough(); stderr.resume();
    const host = Object.assign(new EventEmitter(), {stdin, stdout, stderr});
    const terminal = createProcessTerminal(host);
    const release = (error?: Error): void => { const callback = releaseFirst; releaseFirst = undefined; callback?.(error); };
    let closeWork: Promise<void> | undefined;
    return {host, terminal, output, firstWrite, release, close(): Promise<void> {
      return closeWork ??= (async () => {
        release(); terminal.dispose();
        try { await terminal.outputOwner.settle(); }
        finally { stdin.destroy(); stdout.destroy(); stderr.destroy(); }
      })();
    }};
  };
  const signature = `0x${"ab".repeat(65)}`;
  const now = "2026-08-15T00:00:00.000Z", expiry = "2026-08-15T00:05:00.000Z";

  it.each(["interrupt", "dispose"] as const)("discards private output during %s without waiting for an earlier public write", async reason => {
    vi.useFakeTimers({toFake: ["Date", "setTimeout", "clearTimeout"]}); vi.setSystemTime(new Date(now));
    const test = fixture(); const signal = new AbortController();
    try {
      test.terminal.writeOutput("Verified public result\n"); await test.firstWrite;
      const delivery = test.terminal.writeSignature(signature, expiry, signal.signal);
      let observed: string | undefined; void delivery.then(value => { observed = value; });
      if (reason === "interrupt") signal.abort(); else test.terminal.dispose();
      await Promise.resolve();
      expect(observed).toBe("unavailable");
      test.release(); expect(await delivery).toBe("unavailable");
      await test.close();
      expect(test.output).toEqual(["Verified public result\n"]);
    } finally { await test.close(); vi.useRealTimers(); }
  });

  it("checks the original expiry at native write before the expiry timer has run", async () => {
    vi.useFakeTimers({toFake: ["Date", "setTimeout", "clearTimeout"]}); vi.setSystemTime(new Date(now));
    const test = fixture();
    try {
      test.terminal.writeOutput("Public result\n"); await test.firstWrite;
      const delivery = test.terminal.writeSignature(signature, expiry, new AbortController().signal);
      vi.setSystemTime(new Date(expiry)); // Changing the clock does not dispatch the timer.
      test.release();
      expect(await delivery).toBe("unavailable");
      expect(test.output).toEqual(["Public result\n"]);
    } finally { await test.close(); vi.useRealTimers(); }
  });

  it("preserves an admitted signature write across a later interrupt and waits for its callback", async () => {
    vi.useFakeTimers({toFake: ["Date", "setTimeout", "clearTimeout"]}); vi.setSystemTime(new Date(now));
    const test = fixture(); const signal = new AbortController();
    try {
      const delivery = test.terminal.writeSignature(signature, expiry, signal.signal);
      let completed = false; void delivery.then(() => {completed = true;});
      await test.firstWrite; signal.abort(); vi.setSystemTime(new Date(expiry));
      await Promise.resolve(); expect(completed).toBe(false);
      test.release(); expect(await delivery).toBe("written");
      expect(test.output).toEqual([`Signature: ${signature}\n`]);
    } finally { await test.close(); vi.useRealTimers(); }
  });

  it("keeps output callback failure separate from private unavailability", async () => {
    vi.useFakeTimers({toFake: ["Date", "setTimeout", "clearTimeout"]}); vi.setSystemTime(new Date(now));
    const test = fixture();
    try {
      const delivery = test.terminal.writeSignature(signature, expiry, new AbortController().signal);
      const rejected = expect(delivery).rejects.toThrow("synthetic output failure");
      await test.firstWrite; test.release(new Error("synthetic output failure")); await rejected;
    } finally { await expect(test.close()).rejects.toThrow("synthetic output failure"); vi.useRealTimers(); }
  });

  it("invalidates a queued QR before display and restores an actually entered screen", async () => {
    vi.useFakeTimers({toFake: ["Date", "setTimeout", "clearTimeout"]}); vi.setSystemTime(new Date(now));
    const test = fixture();
    const {renderTerminalQr} = await import("../../src/wallet/terminal-qr.js");
    const rendering = renderTerminalQr({size: 21, rows: Array(21).fill("0".repeat(21))});
    try {
      test.terminal.writeOutput("Public result\n"); await test.firstWrite;
      const obsolete = test.terminal.showQr(rendering, expiry); test.terminal.hideQr();
      expect(await obsolete).toBe("unavailable"); test.release();
      expect(await test.terminal.showQr(rendering, expiry)).toBe("written");
      test.terminal.hideQr(); await test.close();
      expect(test.output.filter(value => value.includes("\u001b[?1049h"))).toHaveLength(1);
      expect(test.output.at(-1)).toBe("\u001b[0m\u001b[?25h\u001b[?1049l");
    } finally {await test.close(); vi.useRealTimers();}
  });

  it("opens one question only after the complete Review and prompt writes", async () => {
    const test = fixture();
    let listening!: () => void;
    const ready = new Promise<void>(resolve => {listening = resolve;});
    test.host.stdin.on("newListener", event => {if (event === "data") listening();});
    try {
      test.terminal.writeOutput("Complete Review\n"); await test.firstWrite;
      const answer = test.terminal.readLine("Confirm [y/N]: ");
      expect(test.host.stdin.listenerCount("data")).toBe(0);
      expect(test.output).toEqual(["Complete Review\n"]);
      test.release(); await ready;
      expect(test.output).toEqual(["Complete Review\n", "Confirm [y/N]: "]);
      test.host.stdin.write("y\n"); expect(await answer).toBe("y");
      expect(test.host.stdin.listenerCount("data")).toBe(0);
    } finally {await test.close();}
  });

  it("settles a question cancelled during output without opening a late reader", async () => {
    const test = fixture(); const controller = new AbortController();
    try {
      test.terminal.writeOutput("Complete Review\n"); await test.firstWrite;
      const answer = test.terminal.readLine("Confirm [y/N]: ", controller.signal);
      controller.abort(); expect(await answer).toBe("");
      test.release(); await test.close();
      expect(test.host.stdin.listenerCount("data")).toBe(0);
    } finally {await test.close();}
  });

  it.each(["abort", "eof", "error", "dispose"] as const)("settles and closes the opened question on %s", async reason => {
    const test = fixture(); const controller = new AbortController();
    let listening!: () => void;
    const ready = new Promise<void>(resolve => {listening = resolve;});
    test.host.stdin.on("newListener", event => {if (event === "data") listening();});
    try {
      const answer = test.terminal.readLine("Confirm [y/N]: ", controller.signal);
      const result = answer.then(value => ({value}), error => ({error}));
      await test.firstWrite; test.release(); await ready;
      if (reason === "abort") controller.abort();
      else if (reason === "dispose") test.terminal.dispose();
      else if (reason === "eof") test.host.stdin.end();
      else test.host.stdin.emit("error", new Error("synthetic input failure"));
      expect(await result).toEqual(reason === "error" ? {error: new Error("synthetic input failure")} : {value: ""});
      expect(test.host.stdin.listenerCount("data")).toBe(0);
    } finally {await test.close();}
  });
});
