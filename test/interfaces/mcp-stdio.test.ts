import { PassThrough, Writable } from "node:stream";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

import {
  canonicalJsonStringify,
  captureCanonicalJson,
  parseUnsignedDecimal,
} from "../../src/core/index.js";
import {
  runCli,
  type CliRuntimePort,
  type CliTerminalPort,
} from "../../src/cli.js";
import { createMcpAppResource } from "../../src/interfaces/mcp-app/server.js";
import {
  createStdioMcp,
  type McpServerRuntimePort,
} from "../../src/interfaces/mcp.js";
import { referenceMarketInterfaceBindings } from "../../src/interfaces/identities.js";
import type { PresentationSnapshotStore } from "../../src/runtime/presentation-snapshot.js";
import {
  RuntimeOperationError,
  noStoreCacheControl,
  problemJsonContentType,
  toProblemDetails,
  type RuntimeDispatchRequest,
  type RuntimeDispatchResponse,
  type RuntimeOwnerSession,
  type RuntimeOwnerSendResult,
} from "../../src/runtime/index.js";
import {
  parseOwnerInstanceId,
  parseProfileId,
  parseRuntimeConfigurationMac,
} from "../../src/runtime/runtime-identity.js";
import {
  requireProcessTermination,
  runtimeReleased,
} from "../../src/runtime/shutdown.js";
import {
  createTokenCatalogFailure,
  tokenCatalogInterfaceErrorMappings,
} from "../../src/token-catalog/errors.js";
import { openTestOwnerSession } from "./owner-session-harness.js";
import { stockTokenMarketUnmappedFixture } from "./stock-token-market-fixture.js";

const appResource = createMcpAppResource("<!doctype html><title>Little John test</title>");

const unusedSnapshotStore: PresentationSnapshotStore = Object.freeze({
  prepare: () => { throw new Error("This lifecycle test must not prepare a snapshot."); },
  commit: () => { throw new Error("This lifecycle test must not commit a snapshot."); },
  read: () => { throw new Error("This lifecycle test must not read a snapshot."); },
  readResultChunk: () => { throw new Error("This lifecycle test must not read a snapshot chunk."); },
});

class TestRuntime implements McpServerRuntimePort {
  readonly #snapshotStore: PresentationSnapshotStore;

  constructor(snapshotStore: PresentationSnapshotStore = unusedSnapshotStore) {
    this.#snapshotStore = snapshotStore;
  }

  async dispatchRuntimeRequest(_request: RuntimeDispatchRequest): Promise<RuntimeDispatchResponse> {
    return Object.freeze({ status: 500, body: Object.freeze({ ok: false }) });
  }

  openOwnerSession(signal?: AbortSignal) { return openTestOwnerSession(this, signal); }

  presentationSnapshotStore(): PresentationSnapshotStore { return this.#snapshotStore; }
}

const discardOutput = (): Writable => new Writable({
  write(_chunk, _encoding, callback): void { callback(); },
});

const settle = <Value>(promise: Promise<Value>) => promise.then(
  (value) => Object.freeze({ status: "fulfilled" as const, value }),
  (reason: unknown) => Object.freeze({ status: "rejected" as const, reason }),
);

class SetupAndPauseFailInput extends PassThrough {
  readonly setupFailure: Error;
  readonly pauseFailure: Error;
  dataSetupFailed = false;
  pauseCalls = 0;

  constructor(setupFailure: Error, pauseFailure: Error) {
    super();
    this.setupFailure = setupFailure;
    this.pauseFailure = pauseFailure;
  }

  override on(eventName: string | symbol, listener: (...args: any[]) => void): this {
    const result = super.on(eventName, listener);
    if (eventName === "data" && !this.dataSetupFailed) {
      this.dataSetupFailed = true;
      throw this.setupFailure;
    }
    return result;
  }

  override pause(): this {
    this.pauseCalls += 1;
    if (this.pauseCalls === 1) throw this.pauseFailure;
    return super.pause();
  }
}

class ObserverRemovalInput extends PassThrough {
  readonly childFailure = new AggregateError([], "child cleanup failure");
  readonly offEvents: (string | symbol)[] = [];
  endRemovalAttempts = 0;
  pauseCalls = 0;

  override off(eventName: string | symbol, listener: (...args: any[]) => void): this {
    this.offEvents.push(eventName);
    if (eventName === "end") {
      this.endRemovalAttempts += 1;
      if (this.endRemovalAttempts === 1) throw undefined;
      if (this.endRemovalAttempts === 2) throw this.childFailure;
    }
    return super.off(eventName, listener);
  }

  override pause(): this {
    this.pauseCalls += 1;
    return super.pause();
  }
}

class FirstPauseFailureInput extends PassThrough {
  readonly failure: unknown;
  pauseCalls = 0;

  constructor(failure: unknown) {
    super();
    this.failure = failure;
  }

  override pause(): this {
    this.pauseCalls += 1;
    if (this.pauseCalls === 1) throw this.failure;
    return super.pause();
  }
}

class StreamClientTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <Message extends JSONRPCMessage>(message: Message) => void;

  readonly #input: PassThrough;
  readonly #output: PassThrough;
  #buffer = "";
  #started = false;

  readonly #onData = (chunk: Buffer): void => {
    this.#buffer += chunk.toString("utf8");
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.length === 0) continue;
      try { this.onmessage?.(JSON.parse(line) as JSONRPCMessage); }
      catch (error) { this.onerror?.(error instanceof Error ? error : new Error(String(error))); }
    }
  };

  constructor(input: PassThrough, output: PassThrough) {
    this.#input = input;
    this.#output = output;
  }

  async start(): Promise<void> {
    if (this.#started) throw new Error("Test client transport already started.");
    this.#started = true;
    this.#output.on("data", this.#onData);
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.#started) throw new Error("Test client transport is not started.");
    this.#input.write(`${JSON.stringify(message)}\n`);
  }

  async close(): Promise<void> {
    if (!this.#started) return;
    this.#started = false;
    this.#output.off("data", this.#onData);
    this.onclose?.();
  }
}

const appClientCapabilities = Object.freeze({
  extensions: Object.freeze({
    "io.modelcontextprotocol/ui": Object.freeze({
      mimeTypes: Object.freeze(["text/html;profile=mcp-app"]),
    }),
  }),
});

const connectClient = async (
  owner: ReturnType<typeof createStdioMcp>,
  input: PassThrough,
  output: PassThrough,
): Promise<Client> => {
  await owner.start();
  const client = new Client(
    { name: "littlejohn-stdio-test", version: "1.0.0" },
    { capabilities: appClientCapabilities },
  );
  await client.connect(new StreamClientTransport(input, output));
  return client;
};

class CountingSnapshotStore implements PresentationSnapshotStore {
  prepareCalls = 0;

  prepare(): ReturnType<PresentationSnapshotStore["prepare"]> {
    this.prepareCalls += 1;
    return Object.freeze({ status: "unavailable", reason: "runtime_unavailable" });
  }

  commit(): ReturnType<PresentationSnapshotStore["commit"]> {
    return Object.freeze({ status: "unavailable", reason: "runtime_unavailable" });
  }

  read(): ReturnType<PresentationSnapshotStore["read"]> {
    return Object.freeze({ status: "unavailable", reason: "snapshot_missing" });
  }

  readResultChunk(): ReturnType<PresentationSnapshotStore["readResultChunk"]> {
    return Object.freeze({ status: "unavailable", reason: "snapshot_missing" });
  }
}

const sessionIdentity = Object.freeze({
  profileId: parseProfileId(Buffer.alloc(16, 21).toString("base64url")),
  ownerInstanceId: parseOwnerInstanceId(Buffer.alloc(16, 22).toString("base64url")),
  configurationMac: parseRuntimeConfigurationMac(Buffer.alloc(32, 23).toString("base64url")),
  ownerRevision: parseUnsignedDecimal("1"),
});

class CliTestRuntime extends TestRuntime implements CliRuntimePort {
  readonly ownerState = "deferred" as const;
  readonly events: string[];

  constructor(events: string[]) {
    super();
    this.events = events;
  }

  async start(): Promise<void> { this.events.push("runtime.start"); }

  async stop() {
    this.events.push("runtime.stop");
    return runtimeReleased;
  }
}

const cliTerminal = (
  interruptController: AbortController,
  output: string[],
  errors: string[],
  events: string[],
): CliTerminalPort => Object.freeze({
  inputIsTTY: false,
  outputIsTTY: false,
  columns: undefined,
  rows: undefined,
  interruptSignal: interruptController.signal,
  writeOutput(value: string): void { output.push(value); },
  writeError(value: string): void { errors.push(value); },
  showQr(): void { throw new Error("MCP mode must not show a QR directly."); },
  hideQr(): void {},
  readLine: async () => { throw new Error("MCP mode must not read a CLI line."); },
  dispose(): void { events.push("terminal.dispose"); },
});

describe("MCP stdio lifecycle ownership", () => {
  it("publishes an inert owner before start and closes without starting a connection", async () => {
    const input = new PassThrough();
    const owner = createStdioMcp(new TestRuntime(), input, discardOutput(), appResource);

    expect(input.listenerCount("data")).toBe(0);
    expect(input.listenerCount("error")).toBe(0);
    expect(input.listenerCount("end")).toBe(0);
    expect(input.listenerCount("close")).toBe(0);

    const firstClose = owner.close();
    expect(owner.close()).toBe(firstClose);
    await expect(firstClose).resolves.toBeUndefined();
    await expect(owner.closed).resolves.toBeUndefined();
    expect(owner.close()).toBe(firstClose);

    const firstStart = owner.start();
    expect(owner.start()).toBe(firstStart);
    await expect(firstStart).rejects.toThrow("already closed");
    expect(input.listenerCount("data")).toBe(0);
  });

  it("observes an input that ended before owner construction without starting SDK work", async () => {
    const input = new FirstPauseFailureInput(new Error("pre-ended input must not adopt a transport"));
    const ended = new Promise<void>((resolve) => { input.once("end", resolve); });
    input.resume();
    input.end();
    await ended;
    expect(input.readableEnded).toBe(true);

    const owner = createStdioMcp(new TestRuntime(), input, discardOutput(), appResource);
    const starting = owner.start();
    expect(owner.start()).toBe(starting);
    expect(input.listenerCount("data")).toBe(0);
    expect(input.listenerCount("error")).toBe(0);
    expect(input.listenerCount("end")).toBe(0);
    expect(input.listenerCount("close")).toBe(0);

    await expect(starting).resolves.toBeUndefined();
    await expect(owner.closed).resolves.toBeUndefined();
    expect(input.pauseCalls).toBe(0);
    expect(input.listenerCount("data")).toBe(0);
    expect(input.listenerCount("error")).toBe(0);
    expect(input.listenerCount("end")).toBe(0);
    expect(input.listenerCount("close")).toBe(0);
  });

  it("publishes cleanup before setup reentry and removes the observer added by that setup", async () => {
    const input = new PassThrough();
    let owner!: ReturnType<typeof createStdioMcp>;
    let reentrantClose: Promise<void> | undefined;
    input.on("newListener", (eventName) => {
      if (eventName === "end" && reentrantClose === undefined) {
        reentrantClose = owner.close();
      }
    });
    owner = createStdioMcp(new TestRuntime(), input, discardOutput(), appResource);

    const starting = owner.start();
    await expect(starting).resolves.toBeUndefined();
    expect(reentrantClose).toBeDefined();
    await expect(reentrantClose).resolves.toBeUndefined();
    expect(owner.close()).toBe(reentrantClose);
    await expect(owner.closed).resolves.toBeUndefined();
    expect(input.listenerCount("data")).toBe(0);
    expect(input.listenerCount("error")).toBe(0);
    expect(input.listenerCount("end")).toBe(0);
    expect(input.listenerCount("close")).toBe(0);
  });

  it("settles cleanly on actual input end and releases every input observer", async () => {
    const input = new PassThrough();
    const owner = createStdioMcp(new TestRuntime(), input, discardOutput(), appResource);
    await expect(owner.start()).resolves.toBeUndefined();

    input.end();
    await expect(owner.closed).resolves.toBeUndefined();
    await expect(owner.close()).resolves.toBeUndefined();
    expect(input.listenerCount("data")).toBe(0);
    expect(input.listenerCount("error")).toBe(0);
    expect(input.listenerCount("end")).toBe(0);
    expect(input.listenerCount("close")).toBe(0);
  });

  it("keeps the first input error as the stable terminal while reentrant close shares cleanup", async () => {
    const input = new PassThrough();
    const owner = createStdioMcp(new TestRuntime(), input, discardOutput(), appResource);
    await owner.start();
    const inputFailure = new Error("input failed");
    let reentrantClose: Promise<void> | undefined;
    input.on("error", () => { reentrantClose = owner.close(); });

    input.emit("error", inputFailure);
    expect(reentrantClose).toBeDefined();
    expect(owner.close()).toBe(reentrantClose);
    await expect(reentrantClose).resolves.toBeUndefined();
    await expect(owner.closed).rejects.toBe(inputFailure);
    input.emit("close");
    await expect(owner.closed).rejects.toBe(inputFailure);
  });

  it("retains an adopted transport after setup and first-close failures", async () => {
    const setupFailure = new Error("data observer setup failed");
    const closeFailure = new Error("pause failed");
    const input = new SetupAndPauseFailInput(setupFailure, closeFailure);
    const owner = createStdioMcp(new TestRuntime(), input, discardOutput(), appResource);
    const starting = owner.start();
    const terminal = await settle(owner.closed);
    expect(terminal.status).toBe("rejected");
    if (terminal.status === "rejected") {
      expect(terminal.reason).toBeInstanceOf(AggregateError);
      expect((terminal.reason as AggregateError).errors).toEqual([setupFailure, closeFailure]);
    }
    await expect(starting).rejects.toBe(
      terminal.status === "rejected" ? terminal.reason : undefined,
    );
    expect(input.pauseCalls).toBe(1);

    const retry = owner.close();
    await expect(retry).resolves.toBeUndefined();
    expect(input.pauseCalls).toBe(2);
    expect(owner.close()).toBe(retry);
    await expect(owner.closed).rejects.toBe(
      terminal.status === "rejected" ? terminal.reason : undefined,
    );
  });

  it("uses failure state rather than reason values and retries only unresolved observers", async () => {
    const input = new ObserverRemovalInput();
    const owner = createStdioMcp(new TestRuntime(), input, discardOutput(), appResource);
    await owner.start();

    input.end();
    const first = await settle(owner.closed);
    expect(first).toEqual({ status: "rejected", reason: undefined });
    expect(input.pauseCalls).toBe(1);

    const callsAfterFirstAttempt = input.offEvents.length;
    const second = owner.close();
    await expect(second).rejects.toBe(input.childFailure);
    expect(input.offEvents.slice(callsAfterFirstAttempt)).toEqual(["end"]);
    expect(input.pauseCalls).toBe(1);

    const third = owner.close();
    await expect(third).resolves.toBeUndefined();
    expect(input.offEvents.slice(callsAfterFirstAttempt)).toEqual(["end", "end"]);
    expect(owner.close()).toBe(third);
    expect(input.pauseCalls).toBe(1);
  });

  it("keeps non-closing parse errors open and treats the SDK fatal-close pair as one failure", async () => {
    const input = new PassThrough();
    const owner = createStdioMcp(new TestRuntime(), input, discardOutput(), appResource);
    await owner.start();

    input.write("{not-json}\n");
    const afterParse = await Promise.race([
      settle(owner.closed),
      new Promise<Readonly<{ status: "pending" }>>((resolve) => {
        setImmediate(() => resolve(Object.freeze({ status: "pending" })));
      }),
    ]);
    expect(afterParse).toEqual({ status: "pending" });

    input.write(Buffer.alloc(10 * 1024 * 1024 + 1, 1));
    const terminal = await settle(owner.closed);
    expect(terminal.status).toBe("rejected");
    if (terminal.status === "rejected") {
      expect(terminal.reason).toBeInstanceOf(Error);
      expect((terminal.reason as Error).message).toContain("ReadBuffer exceeded maximum size");
    }
    await expect(owner.close()).resolves.toBeUndefined();
  });

  it("blocks a late public result from creating presentation state after SDK close", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const store = new CountingSnapshotStore();
    let request!: RuntimeDispatchRequest;
    let resolveDispatch!: (response: RuntimeDispatchResponse) => void;
    let resolveDispatchStarted!: () => void;
    const dispatchStarted = new Promise<void>((resolve) => { resolveDispatchStarted = resolve; });
    class HeldRuntime extends TestRuntime {
      override dispatchRuntimeRequest(value: RuntimeDispatchRequest): Promise<RuntimeDispatchResponse> {
        request = value;
        resolveDispatchStarted();
        return new Promise((resolveResponse) => { resolveDispatch = resolveResponse; });
      }
    }
    const owner = createStdioMcp(new HeldRuntime(store), input, output, appResource);
    const client = await connectClient(owner, input, output);
    const call = client.callTool({
      name: referenceMarketInterfaceBindings.stockTokenMarket.mcp.name,
      arguments: { symbol: "P" },
    });
    void call.catch(() => undefined);
    await dispatchStarted;
    input.end();
    await owner.closed;
    expect(request.signal?.aborted).toBe(true);
    resolveDispatch(Object.freeze({
      status: 200,
      body: captureCanonicalJson(stockTokenMarketUnmappedFixture()),
    }));
    await new Promise<void>((resolveTurn) => { setImmediate(resolveTurn); });
    expect(store.prepareCalls).toBe(0);
    await client.close();
  });

  it("keeps MCP terminal ownership separate when its shared operation client fails closed", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const store = new CountingSnapshotStore();
    const notFound = createTokenCatalogFailure("token_selection_not_found");
    const problem = toProblemDetails(notFound, tokenCatalogInterfaceErrorMappings);
    let opens = 0;
    let sends = 0;
    let sessionCloseCalls = 0;
    const ownedSession: RuntimeOwnerSession = Object.freeze({
      identity: sessionIdentity,
      usable: true,
      async send(): Promise<RuntimeOwnerSendResult> {
        sends += 1;
        return Object.freeze({
          status: "response_received" as const,
          response: Object.freeze({
            statusCode: problem.status,
            contentType: problemJsonContentType,
            cacheControl: noStoreCacheControl,
            bytes: new TextEncoder().encode(
              `${canonicalJsonStringify(captureCanonicalJson(problem))}\n`,
            ),
          }),
        });
      },
      close(): void {
        sessionCloseCalls += 1;
        if (sessionCloseCalls === 1) throw new Error("session release failed");
      },
    });
    class FailingSessionRuntime extends TestRuntime {
      override async openOwnerSession(): Promise<RuntimeOwnerSession> {
        opens += 1;
        return ownedSession;
      }
    }
    const owner = createStdioMcp(new FailingSessionRuntime(store), input, output, appResource);
    const client = await connectClient(owner, input, output);
    const request = {
      name: "token_get_selection",
      arguments: {
        asset: {
          kind: "erc20",
          chainId: "eip155:4663",
          address: `0x${"1".repeat(40)}`,
        },
      },
    } as const;

    const first = await client.callTool(request);
    expect(first.isError).toBe(true);
    expect(first.structuredContent).toEqual(notFound);
    expect(opens).toBe(1);
    expect(sends).toBe(1);
    expect(sessionCloseCalls).toBe(1);

    const second = await client.callTool(request);
    expect(second.isError).toBe(true);
    expect(second.structuredContent).toMatchObject({
      ok: false,
      error: { code: "runtime_state_unavailable" },
    });
    expect(opens).toBe(1);
    expect(sends).toBe(1);
    expect(sessionCloseCalls).toBe(1);

    input.end();
    await expect(owner.closed).resolves.toBeUndefined();
    await expect(owner.close()).resolves.toBeUndefined();
    expect(sessionCloseCalls).toBe(2);
    expect(store.prepareCalls).toBe(0);
    await client.close();
  });

  it("retries server before client and retains the client until its admitted request settles", async () => {
    const serverFailure = new Error("server close failed");
    const clientFailure = new AggregateError([], "client close failed");
    const input = new FirstPauseFailureInput(serverFailure);
    const output = new PassThrough();
    const store = new CountingSnapshotStore();
    let resolveSend!: (result: RuntimeOwnerSendResult) => void;
    let resolveSendStarted!: () => void;
    const sendStarted = new Promise<void>((resolve) => { resolveSendStarted = resolve; });
    let sessionCloseCalls = 0;
    const session: RuntimeOwnerSession = Object.freeze({
      identity: sessionIdentity,
      usable: true,
      send: async () => {
        resolveSendStarted();
        return await new Promise<RuntimeOwnerSendResult>((resolve) => { resolveSend = resolve; });
      },
      close: () => {
        sessionCloseCalls += 1;
        if (sessionCloseCalls === 1) throw clientFailure;
      },
    });
    class HeldSessionRuntime extends TestRuntime {
      override async openOwnerSession(): Promise<RuntimeOwnerSession> { return session; }
    }
    const owner = createStdioMcp(new HeldSessionRuntime(store), input, output, appResource);
    const client = await connectClient(owner, input, output);
    const call = client.callTool({
      name: "token_get_selection",
      arguments: {
        asset: {
          kind: "erc20",
          chainId: "eip155:4663",
          address: `0x${"1".repeat(40)}`,
        },
      },
    });
    void call.catch(() => undefined);
    await sendStarted;

    input.end();
    await expect(owner.closed).rejects.toBe(serverFailure);
    expect(input.pauseCalls).toBe(1);
    expect(sessionCloseCalls).toBe(0);

    const clientAttempt = owner.close();
    expect(await Promise.race([
      settle(clientAttempt),
      new Promise<Readonly<{ status: "pending" }>>((resolve) => {
        setImmediate(() => resolve(Object.freeze({ status: "pending" })));
      }),
    ])).toEqual({ status: "pending" });
    expect(input.pauseCalls).toBe(2);
    expect(sessionCloseCalls).toBe(1);

    resolveSend(Object.freeze({ status: "request_not_sent", reason: "request_aborted" }));
    await expect(clientAttempt).rejects.toBe(clientFailure);

    const release = owner.close();
    await expect(release).resolves.toBeUndefined();
    expect(owner.close()).toBe(release);
    await expect(owner.closed).rejects.toBe(serverFailure);
    expect(sessionCloseCalls).toBe(2);
    expect(store.prepareCalls).toBe(0);
    await client.close();
  });

  it("normalizes MCP terminal and retry failures without exposing their product-shaped reasons", async () => {
    const events: string[] = [];
    const output: string[] = [];
    const errors: string[] = [];
    const interruptController = new AbortController();
    const runtime = new CliTestRuntime(events);
    const terminalFailure = requireProcessTermination(
      new RuntimeOperationError("runtime_state_unavailable"),
    );
    const retryFailure = new RuntimeOperationError("state_conflict");
    const closed = Promise.reject(terminalFailure);
    void closed.catch(() => undefined);
    let closeCalls = 0;
    const result = await runCli([], {
      createRuntime: async () => runtime,
      terminal: cliTerminal(interruptController, output, errors, events),
      waitForPoll: async () => undefined,
      createMcp: () => Object.freeze({
        closed,
        start: () => {
          events.push("mcp.start");
          return Promise.resolve();
        },
        close: () => {
          closeCalls += 1;
          events.push("mcp.close");
          return Promise.reject(retryFailure);
        },
      }),
    });

    expect(closeCalls).toBe(1);
    expect(events).toEqual([
      "runtime.start",
      "mcp.start",
      "mcp.close",
      "terminal.dispose",
    ]);
    expect(result.exitCode).toBeGreaterThan(0);
    expect(result.processDisposition).toBe("process_exit_required");
    expect(errors).toEqual(["internal_error: The request could not be completed.\n"]);
    expect(output).toEqual([]);
  });

  it("uses interruption to request first cleanup, then consumes the same terminal once", async () => {
    const events: string[] = [];
    const output: string[] = [];
    const errors: string[] = [];
    const interruptController = new AbortController();
    const runtime = new CliTestRuntime(events);
    let resolveStart!: () => void;
    let resolveClosed!: () => void;
    const start = new Promise<void>((resolve) => { resolveStart = resolve; });
    const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    let signalCloseCalled!: () => void;
    const closeCalled = new Promise<void>((resolve) => { signalCloseCalled = resolve; });
    let closeCalls = 0;
    const running = runCli([], {
      createRuntime: async () => runtime,
      terminal: cliTerminal(interruptController, output, errors, events),
      waitForPoll: async () => undefined,
      createMcp: () => Object.freeze({
        closed,
        start: () => {
          events.push("mcp.start");
          signalStarted();
          return start;
        },
        close: () => {
          closeCalls += 1;
          events.push("mcp.close");
          resolveClosed();
          signalCloseCalled();
          return Promise.resolve();
        },
      }),
    });
    await started;
    interruptController.abort();
    await closeCalled;
    const beforeStartSettlement = await Promise.race([
      running.then(() => Object.freeze({ status: "completed" as const })),
      new Promise<Readonly<{ status: "pending" }>>((resolve) => {
        setImmediate(() => resolve(Object.freeze({ status: "pending" })));
      }),
    ]);
    expect(beforeStartSettlement).toEqual({ status: "pending" });
    resolveStart();
    const result = await running;

    expect(closeCalls).toBe(1);
    expect(events).toEqual([
      "runtime.start",
      "mcp.start",
      "mcp.close",
      "runtime.stop",
      "terminal.dispose",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.processDisposition).toBe("natural_exit");
    expect(output).toEqual([]);
    expect(errors).toEqual([]);
  });
});
