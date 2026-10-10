import { fork, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import {
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import { JSDOM, VirtualConsole } from "jsdom";

import {
  initializeOwnedChild,
  ownChildProcess,
  waitForPromise,
} from "./child-process-lifecycle.mjs";
import { startFakeRpc } from "./fake-rpc.mjs";
import { renderPackagedOwnerWorkerSource } from "./packaged-owner-worker-source.mjs";
import { runCommand } from "./release-support.mjs";

const fixedOrigin = "http://127.0.0.1:46630";
const identityChallengeHeaderName = "Littlejohn-Identity-Challenge";
const expectedChainId = "eip155:4663";
const expectedWalletAddress = "0x1111111111111111111111111111111111111111";
const expectedCanonicalBlock = Object.freeze({
  chainId: expectedChainId,
  blockNumber: "9007199254740993",
  blockHash: "0x8888888888888888888888888888888888888888888888888888888888888888",
  blockTimestamp: "2026-08-24T07:00:00.000Z",
});
const requestTimeoutMs = 30_000;
const childShutdownTimeoutMs = 5_000;
const mcpEndOfInputExitTimeoutMs = 2_000;
const pollIntervalMs = 25;
const packagedCliTtyLauncher = [
  'Object.defineProperty(process.stdin, "isTTY", { value: true });',
  'Object.defineProperty(process.stdout, "isTTY", { value: true });',
  'const { pathToFileURL } = await import("node:url");',
  "await import(pathToFileURL(process.argv[1]).href);",
].join("");
const expectedCapabilityIds = Object.freeze([
  "account.balance",
  "address.inspect",
  "chain.status",
  "market.stock_token_prices",
  "market.stock_token_trade_history",
  "market.stock_tokens",
  "token.inspect",
  "transaction.inspect",
  "uniswap_v2.quote_exact_input",
  "uniswap_v4.list_pools",
  "wallet.connection",
]);
const expectedSemanticReadToolNames = Object.freeze([
  "market_get_stock_token_prices",
  "market_get_stock_token_trade_history",
  "market_list_stock_tokens",
  "read_get_account_balance",
  "read_get_chain_status",
  "read_inspect_address",
  "read_inspect_transaction",
  "token_inspect_contract",
  "uniswap_v2_quote_exact_input",
  "uniswap_v4_list_pools",
  "wallet_get_connection",
]);
const expectedToolNames = Object.freeze([
  "presentation_get_card", "presentation_get_snapshot",
  "wallet_get_account_selection", "wallet_start_connection_change_review", "wallet_get_operation",
  "token_start_selection_change_review", "token_get_operation",
  "signing_get_review", "signing_start_review",
  "activity_get_transaction", "activity_inspect_transaction", "activity_list_transactions", "exchange_get_review", "exchange_start_review",
  "account_list_assets",
  "market_get_stock_token_prices",
  "market_get_stock_token_trade_history",
  "market_list_stock_tokens",
  "read_get_account_balance",
  "read_get_chain_status",
  "read_inspect_address",
  "read_inspect_transaction",
  "read_list_capabilities",
  "token_get_selection",
  "token_inspect_contract",
  "token_list_selections",
  "uniswap_v2_quote_exact_input",
  "uniswap_v4_list_pools",
  "wallet_get_connection",
]);
const expectedAppToolNames = Object.freeze([
  ...expectedToolNames,
  "presentation_start_view", "presentation_cancel_decision", "presentation_cancel_wait",
  "presentation_start_read", "presentation_start_decision", "wallet_select_account",
  "signing_cancel_review", "signing_request_signature",
  "exchange_cancel_review", "exchange_request_transaction",
  "presentation_get_snapshot_chunk",
  "token_add_selection",
  "token_remove_selection",
  "wallet_cancel_operation",
  "wallet_start_connection",
  "wallet_start_disconnection",
]);
const exactPackagedToolSchemaNames = Object.freeze([
  "read_get_chain_status",
  "wallet_get_connection",
]);
const expectedExactPackagedToolSchemaBundleSha256 =
  "0f4d9b1a4bced245f4d55e84d26408e1ea02965bc9ca22105554a456b06ef352";

// Independent oracle from the accepted complete invocation effects. Schema
// digests deliberately exclude annotations and cannot establish these hints.
const expectedToolEffects = Object.freeze({
  account_list_assets: [false, true, false, true],
  market_get_stock_token_prices: [false, true, false, true],
  market_get_stock_token_trade_history: [false, true, false, true],
  market_list_stock_tokens: [false, true, false, true],
  read_get_account_balance: [false, true, true, true],
  read_get_chain_status: [true, false, true, true],
  read_inspect_address: [false, true, true, true],
  read_inspect_transaction: [true, false, true, true],
  read_list_capabilities: [true, false, true, false],
  token_get_selection: [false, true, true, false],
  token_inspect_contract: [true, false, true, true],
  token_list_selections: [false, true, true, false],
  uniswap_v2_quote_exact_input: [true, false, true, true],
  uniswap_v4_list_pools: [false, true, false, true],
  wallet_get_connection: [false, true, true, false],
  wallet_start_connection_change_review: [false, true, false, false],
  wallet_start_connection: [false, true, true, true],
  wallet_start_disconnection: [false, true, true, true],
  wallet_get_operation: [false, true, true, true],
  wallet_cancel_operation: [false, true, true, true],
  wallet_get_account_selection: [false, true, true, false],
  wallet_select_account: [false, true, true, false],
  token_start_selection_change_review: [false, true, false, true],
  token_add_selection: [false, true, true, true],
  token_remove_selection: [false, true, true, false],
  token_get_operation: [true, false, true, false],
  exchange_start_review: [false, true, false, true],
  exchange_get_review: [true, false, true, false],
  exchange_cancel_review: [false, true, true, false],
  exchange_request_transaction: [false, true, false, true],
  activity_get_transaction: [true, false, true, false],
  activity_list_transactions: [true, false, true, false],
  activity_inspect_transaction: [false, true, false, true],
  signing_start_review: [false, true, false, false],
  signing_get_review: [true, false, true, false],
  signing_cancel_review: [false, true, true, false],
  signing_request_signature: [false, true, false, true],
  presentation_start_read: [false, true, false, true],
  presentation_start_decision: [false, true, false, true],
  presentation_get_card: [false, true, true, true],
  presentation_start_view: [false, true, true, true],
  presentation_cancel_decision: [false, true, true, true],
  presentation_cancel_wait: [false, true, true, true],
  presentation_get_snapshot: [true, false, true, false],
  presentation_get_snapshot_chunk: [true, false, true, false],
});

const assertPackagedToolAnnotations = (tools, appConnection = false) => {
  const expectedNames = appConnection ? expectedAppToolNames : expectedToolNames;
  const names = tools.map((tool) => tool?.name).sort();
  if (independentCanonicalJson(names) !== independentCanonicalJson([...expectedNames].sort()) ||
      independentCanonicalJson(Object.keys(expectedToolEffects).sort()) !==
        independentCanonicalJson([...expectedAppToolNames].sort())) {
    throw new TypeError("Packaged MCP effect oracle does not cover the exact tool registry.");
  }
  for (const tool of tools) {
    const [readOnlyHint, destructiveHint, idempotentHint, openWorldHint] = expectedToolEffects[tool.name];
    if (independentCanonicalJson(tool.annotations) !== independentCanonicalJson({
      readOnlyHint, destructiveHint, idempotentHint, openWorldHint,
    })) throw new TypeError(`Packaged ${tool.name} annotations differ from its complete invocation effects.`);
  }
};

/** @type {typeof import("./packaged-integration.d.mts").assertPackagedMcpServerIdentity} */
export const assertPackagedMcpServerIdentity = (result, expected) => {
  const serverInfo =
    typeof result === "object" &&
    result !== null &&
    !Array.isArray(result)
      ? Object.getOwnPropertyDescriptor(result, "serverInfo")?.value
      : undefined;
  if (
    typeof expected !== "object" ||
    expected === null ||
    typeof expected.name !== "string" ||
    typeof expected.version !== "string" ||
    typeof serverInfo !== "object" ||
    serverInfo === null ||
    Array.isArray(serverInfo) ||
    Object.getOwnPropertyDescriptor(serverInfo, "name")?.value !== expected.name ||
    Object.getOwnPropertyDescriptor(serverInfo, "version")?.value !== expected.version
  ) throw new TypeError("Packaged MCP server identity is invalid.");
};

const delay = (milliseconds) => new Promise((resolveDelay) => {
  setTimeout(resolveDelay, milliseconds);
});

const waitFor = async (read, accept, label) => {
  const deadline = performance.now() + requestTimeoutMs;
  let value;
  for (;;) {
    value = await read();
    if (accept(value)) return value;
    const remainingMilliseconds = deadline - performance.now();
    if (remainingMilliseconds <= 0) break;
    await delay(Math.min(pollIntervalMs, remainingMilliseconds));
  }
  throw new TypeError(`${label} did not reach its required state.`);
};

const assertRpcRequestBudget = (fakeRpc, startingCount, maximumCount, label) => {
  const requestCount = fakeRpc.calls.length - startingCount;
  if (requestCount < 1 || requestCount > maximumCount) {
    throw new TypeError(
      `${label} used ${requestCount} RPC requests; expected 1-${maximumCount}.`,
    );
  }
};

class WorkerPeer {
  constructor(ownership, ready) {
    this.child = ownership.child;
    this.ownership = ownership;
    this.ready = ready;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.child.on("message", (message) => {
      if (typeof message !== "object" || message === null) return;
      const requestId = message.requestId;
      if (typeof requestId !== "string") return;
      const request = this.pending.get(requestId);
      if (request === undefined) return;
      this.pending.delete(requestId);
      if (message.ok === true) request.resolve(message.result);
      else request.reject(new Error(
        typeof message.error === "string" ? message.error : "Release worker request failed.",
      ));
    });
    this.child.once("exit", (code, signal) => {
      for (const request of this.pending.values()) {
        request.reject(new Error(
          `Release worker exited ${signal === null ? `with code ${code}` : `with signal ${signal}`}.`,
        ));
      }
      this.pending.clear();
    });
  }

  get processId() {
    const processId = this.child.pid;
    if (!Number.isSafeInteger(processId) || processId <= 0) {
      throw new TypeError("Release worker process identity is unavailable.");
    }
    return processId;
  }

  request(command, input = {}) {
    const requestId = String(this.nextRequestId++);
    return new Promise((resolveRequest, rejectRequest) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        rejectRequest(new Error(`Release worker request timed out: ${command}`));
      }, requestTimeoutMs);
      const settle = (settleRequest) => (value) => {
        clearTimeout(timeout);
        settleRequest(value);
      };
      const pending = {
        resolve: settle(resolveRequest),
        reject: settle(rejectRequest),
      };
      this.pending.set(requestId, pending);
      this.child.send({ requestId, command, ...input }, (error) => {
        if (error === null) return;
        this.pending.delete(requestId);
        pending.reject(error);
      });
    });
  }

  async stop() {
    if (this.ownership.isTerminated()) return;
    await this.request("stop");
    await waitForPromise(
      this.ownership.termination,
      requestTimeoutMs,
      "Release worker process-terminal shutdown",
    );
  }

  async stopAndInspectPersistence() {
    if (this.ownership.isTerminated()) {
      throw new TypeError("Release worker terminated before persistence inspection.");
    }
    const result = await this.request("stop_and_inspect_persistence");
    await waitForPromise(
      this.ownership.termination,
      requestTimeoutMs,
      "Release worker process-terminal persistence inspection",
    );
    return result;
  }

  async terminate() {
    await this.ownership.terminate();
  }
}

const startWorkerPeer = async (workerPath, cwd, environment) => {
  const child = fork(workerPath, [], {
    cwd,
    env: environment,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const ownership = ownChildProcess(child, "Release worker", childShutdownTimeoutMs);
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => { stderr += chunk; });
  const ready = await initializeOwnedChild(
    ownership,
    () => new Promise((resolveReady, rejectReady) => {
      const cleanup = () => {
        child.off("message", onMessage);
        child.off("error", onError);
        child.off("exit", onExit);
      };
      const resolve = (value) => {
        cleanup();
        resolveReady(value);
      };
      const reject = (error) => {
        cleanup();
        rejectReady(error);
      };
      const onMessage = (message) => {
        if (typeof message === "object" && message !== null && message.ready === true) {
          resolve(message.result);
        }
      };
      const onError = (error) => {
        reject(new Error(`Release worker failed before ready: ${error.message}`));
      };
      const onExit = (code, signal) => {
        reject(new Error(
          `Release worker failed before ready ${signal === null ? `with code ${code}` : `with signal ${signal}`}: ${stderr}`,
        ));
      };
      child.on("message", onMessage);
      child.once("error", onError);
      child.once("exit", onExit);
    }),
    requestTimeoutMs,
    "Release worker startup",
  );
  return new WorkerPeer(ownership, ready);
};

const assertIncompatibleWorkerConfiguration = async (
  workerPath,
  cwd,
  environment,
  privateConfigurationValues,
) => {
  let worker;
  let startupFailure;
  try { worker = await startWorkerPeer(workerPath, cwd, environment); }
  catch (error) { startupFailure = error; }
  if (worker !== undefined) {
    try { await worker.stop(); }
    finally { await worker.terminate(); }
    throw new TypeError("Changed packaged runtime configuration shared the fixed owner.");
  }
  if (
    !(startupFailure instanceof Error) ||
    !startupFailure.message.includes("owned by an incompatible process")
  ) throw startupFailure ?? new TypeError("Changed packaged runtime configuration did not fail.");
  if (privateConfigurationValues.some((value) => startupFailure.message.includes(value))) {
    throw new TypeError("Packaged configuration incompatibility exposed a private input.");
  }
};

/** @typedef {import("./packaged-integration.d.mts").RawMcpClient} RawMcpClientContract */
/** @implements {RawMcpClientContract} */
export class RawMcpClient {
  /**
   * @param {ConstructorParameters<typeof import("./packaged-integration.d.mts").RawMcpClient>[0]} ownership
   * @param {ConstructorParameters<typeof import("./packaged-integration.d.mts").RawMcpClient>[1]} expectedServerIdentity
   * @param {ConstructorParameters<typeof import("./packaged-integration.d.mts").RawMcpClient>[2]} appConnection
   */
  constructor(ownership, expectedServerIdentity, appConnection = false) {
    this.child = ownership.child;
    if (this.child.stdin === null || this.child.stdout === null || this.child.stderr === null) {
      throw new TypeError("Packaged MCP requires piped standard streams.");
    }
    this.ownership = ownership;
    this.expectedServerIdentity = expectedServerIdentity;
    this.appConnection = appConnection;
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = "";
    this.stdoutTail = "";
    this.closeOutcome = new Promise((resolveClose) => {
      this.child.once("close", (code, signal) => {
        resolveClose(Object.freeze({ code, signal }));
      });
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      this.stdoutTail += chunk;
      for (;;) {
        const newline = this.stdoutTail.indexOf("\n");
        if (newline === -1) break;
        const line = this.stdoutTail.slice(0, newline).replace(/\r$/u, "");
        this.stdoutTail = this.stdoutTail.slice(newline + 1);
        if (line.length === 0) continue;
        let message;
        try { message = JSON.parse(line); }
        catch {
          this.failAll(new Error("Packaged MCP server emitted invalid JSON."));
          continue;
        }
        const id = message.id;
        if (typeof id !== "number") continue;
        const request = this.pending.get(id);
        if (request === undefined) continue;
        this.pending.delete(id);
        if (message.error !== undefined) {
          request.reject(new Error(`MCP request failed: ${JSON.stringify(message.error)}`));
        } else {
          request.resolve(message.result);
        }
      }
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => { this.stderr += chunk; });
    void this.ownership.failure.catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      this.failAll(new Error(`Packaged MCP process failed: ${detail}`));
    });
    this.child.once("close", (code, signal) => {
      this.failAll(new Error(
        `Packaged MCP process exited ${signal === null ? `with code ${code}` : `with signal ${signal}`}: ${this.stderr}`,
      ));
    });
  }

  failAll(error) {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  send(value) {
    return this.ownership.write(`${JSON.stringify(value)}\n`);
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolveRequest, rejectRequest) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(`MCP request timed out: ${method}`));
      }, requestTimeoutMs);
      const settle = (settleRequest) => (value) => {
        clearTimeout(timeout);
        settleRequest(value);
      };
      const pending = {
        resolve: settle(resolveRequest),
        reject: settle(rejectRequest),
      };
      this.pending.set(id, pending);
      void this.send({ jsonrpc: "2.0", id, method, params }).catch((error) => {
        if (this.pending.get(id) !== pending) return;
        this.pending.delete(id);
        pending.reject(error);
      });
    });
  }

  async initialize() {
    const result = await this.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: this.appConnection ? {
        extensions: {
          "io.modelcontextprotocol/ui": {
            mimeTypes: ["text/html;profile=mcp-app"],
          },
        },
      } : {},
      clientInfo: {
        name: this.appConnection
          ? "littlejohn-release-app-check"
          : "littlejohn-release-check",
        version: "1.0.0",
      },
    });
    assertPackagedMcpServerIdentity(result, this.expectedServerIdentity);
    await this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  /** @returns {ReturnType<import("./packaged-integration.d.mts").RawMcpClient["listTools"]>} */
  async listTools() {
    const result = await this.request("tools/list", {});
    if (!Array.isArray(result?.tools)) throw new TypeError("Packaged MCP tool list is invalid.");
    return result.tools;
  }

  async callToolResult(name, arguments_ = {}) {
    return await this.request("tools/call", { name, arguments: arguments_ });
  }

  async callTool(name, arguments_ = {}) {
    const result = await this.callToolResult(name, arguments_);
    if (result?.isError === true) {
      throw new Error(`Packaged MCP tool failed: ${name}: ${JSON.stringify(result.structuredContent)}`);
    }
    return result;
  }

  async listResources() {
    const result = await this.request("resources/list", {});
    if (!Array.isArray(result?.resources)) {
      throw new TypeError("Packaged MCP resource list is invalid.");
    }
    return result.resources;
  }

  async readResource(uri) {
    const result = await this.request("resources/read", { uri });
    if (!Array.isArray(result?.contents) || result.contents.length !== 1) {
      throw new TypeError("Packaged MCP resource result is invalid.");
    }
    return result.contents[0];
  }

  async closeInputAndWaitForTermination() {
    if (this.pending.size !== 0 || this.stdoutTail.length !== 0) {
      throw new TypeError("Packaged MCP input cannot close with pending protocol work.");
    }
    const startedAt = performance.now();
    if (this.child.stdin === null) throw new TypeError("Packaged MCP input is unavailable.");
    this.child.stdin.end();
    const outcome = await waitForPromise(
      this.closeOutcome,
      mcpEndOfInputExitTimeoutMs,
      "Packaged MCP end-of-input termination",
    );
    if (
      outcome.code !== 0 ||
      outcome.signal !== null ||
      this.stdoutTail.length !== 0 ||
      performance.now() - startedAt > mcpEndOfInputExitTimeoutMs
    ) {
      throw new TypeError("Packaged MCP did not terminate cleanly after end-of-input.");
    }
  }

  async close() {
    await this.ownership.terminate();
  }
}

const startNpxMcp = async (prepared, environment, appConnection = false) => {
  const child = spawn("npx", [
    "--yes",
    "--package",
    prepared.tarballPath,
    "littlejohn",
  ], {
    cwd: prepared.npxRoot,
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const ownership = ownChildProcess(child, "Packaged MCP process", childShutdownTimeoutMs);
  const client = new RawMcpClient(
    ownership,
    prepared.packageIdentity,
    appConnection,
  );
  await initializeOwnedChild(
    ownership,
    () => client.initialize(),
    requestTimeoutMs,
    "Packaged MCP initialization",
  );
  return client;
};

const startInstalledMcp = async (prepared, environment) => {
  const child = spawn(process.execPath, [resolve(
    prepared.installRoot,
    prepared.packageIdentity.installRelativePath,
    "dist/cli.js",
  )], {
    cwd: prepared.installRoot,
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const ownership = ownChildProcess(child, "Installed MCP process", childShutdownTimeoutMs);
  const client = new RawMcpClient(ownership, prepared.packageIdentity);
  await initializeOwnedChild(
    ownership,
    () => client.initialize(),
    requestTimeoutMs,
    "Installed MCP initialization",
  );
  return client;
};

const jsonResponse = async (response, expectedStatus = 200) => {
  const body = await response.json();
  if (response.status !== expectedStatus) {
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
};

const isRecord = (value) =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value);

const hasExactStringSet = (values, expected) =>
  Array.isArray(values) &&
  values.every((value) => typeof value === "string") &&
  JSON.stringify([...values].sort()) === JSON.stringify([...expected].sort());

const hasExactObjectKeys = (value, expectedNames) =>
  isRecord(value) && hasExactStringSet(Object.keys(value), expectedNames);

const compareCodePointSequences = (left, right) => {
  const leftCodePoints = Array.from(left, (character) => character.codePointAt(0));
  const rightCodePoints = Array.from(right, (character) => character.codePointAt(0));
  const sharedLength = Math.min(leftCodePoints.length, rightCodePoints.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = leftCodePoints[index] - rightCodePoints[index];
    if (difference !== 0) return difference;
  }
  return leftCodePoints.length - rightCodePoints.length;
};

const independentCanonicalJson = (value, ancestors = new Set()) => {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Schema JSON contains a non-finite number.");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new TypeError("Schema JSON contains a non-JSON value.");
  }
  if (ancestors.has(value)) throw new TypeError("Schema JSON contains a cycle.");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length) {
        throw new TypeError("Schema JSON contains a sparse or extended array.");
      }
      return `[${value.map((item) => independentCanonicalJson(item, ancestors)).join(",")}]`;
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== "string")) {
      throw new TypeError("Schema JSON contains a symbol key.");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(value).sort(compareCodePointSequences);
    if (keys.length !== ownKeys.length) {
      throw new TypeError("Schema JSON contains a non-enumerable property.");
    }
    const members = keys.map((key) => {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        throw new TypeError("Schema JSON contains a non-data or non-enumerable property.");
      }
      return `${JSON.stringify(key)}:${independentCanonicalJson(descriptor.value, ancestors)}`;
    });
    return `{${members.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
};

/** @type {typeof import("./packaged-integration.d.mts").packagedToolSchemaBundleSha256} */
export const packagedToolSchemaBundleSha256 = (tools) => {
  if (!Array.isArray(tools) || tools.length === 0) {
    throw new TypeError("Packaged tool schema bundle is empty.");
  }
  const names = new Set();
  const bundle = tools.map((tool) => {
    if (!isRecord(tool) || typeof tool.name !== "string" ||
      !isRecord(tool.inputSchema) || !isRecord(tool.outputSchema) ||
      names.has(tool.name)) {
      throw new TypeError("Packaged tool schema bundle is invalid.");
    }
    names.add(tool.name);
    return Object.freeze({
      name: tool.name,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
    });
  }).sort((left, right) => compareCodePointSequences(left.name, right.name));
  return createHash("sha256")
    .update(independentCanonicalJson(bundle), "utf8")
    .digest("hex");
};

const assertPackagedToolSchemaBundleDigestControls = () => {
  const closed = {
    type: "object",
    additionalProperties: false,
    properties: {
      value: { type: "string", minLength: 1 },
    },
    required: ["value"],
  };
  const base = [{
    name: "control",
    inputSchema: closed,
    outputSchema: {
      oneOf: [closed, { const: null, type: "null" }],
    },
  }];
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const baseline = packagedToolSchemaBundleSha256(base);
  const reordered = [{
    outputSchema: {
      oneOf: [
        {
          required: ["value"],
          properties: { value: { minLength: 1, type: "string" } },
          additionalProperties: false,
          type: "object",
        },
        { type: "null", const: null },
      ],
    },
    inputSchema: {
      required: ["value"],
      properties: { value: { minLength: 1, type: "string" } },
      additionalProperties: false,
      type: "object",
    },
    name: "control",
  }];
  if (packagedToolSchemaBundleSha256(reordered) !== baseline) {
    throw new TypeError("Packaged schema digest depends on object-key insertion order.");
  }
  const mutations = [
    (candidate) => { delete candidate[0].inputSchema.properties.value.minLength; },
    (candidate) => { candidate[0].inputSchema.additionalProperties = true; },
    (candidate) => { candidate[0].inputSchema.required = []; },
    (candidate) => { candidate[0].inputSchema.properties.extra = { type: "boolean" }; },
    (candidate) => { candidate[0].outputSchema.oneOf.push({ type: "boolean" }); },
    (candidate) => { candidate[0].outputSchema.oneOf[0].properties.value.type = "integer"; },
  ];
  for (const mutate of mutations) {
    const candidate = clone(base);
    mutate(candidate);
    if (packagedToolSchemaBundleSha256(candidate) === baseline) {
      throw new TypeError("Packaged schema digest ignores a nested schema change.");
    }
  }
};

const assertPackagedClaimsDigests = (content, label) => {
  const sources = content?.evidence?.sources;
  if (
    !Array.isArray(sources) ||
    sources.length === 0 ||
    sources.some((source) =>
      typeof source?.recordDigest !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/u.test(source.recordDigest))
  ) throw new TypeError(`${label} does not carry every source record digest.`);
};

/** @type {typeof import("./packaged-integration.d.mts").assertPackagedWalletConnection} */
export const assertPackagedWalletConnection = (data) => {
  const connection = /** @type {Record<string, unknown>} */ (data);
  const namespaces = [{key: "eip155", accounts: [`${expectedChainId}:${expectedWalletAddress}`],
    methods: ["eth_sendTransaction"], events: ["accountsChanged", "chainChanged"], chains: [expectedChainId]}];
  if (!hasExactObjectKeys(data, ["status", "connectionId", "expiresAt", "namespaces"]) || connection["status"] !== "connected" ||
      typeof connection["connectionId"] !== "string" || !/^wallet-session:[A-Za-z0-9_-]{43}$/u.test(connection["connectionId"]) ||
      typeof connection["expiresAt"] !== "string" || !Number.isFinite(Date.parse(connection["expiresAt"])) ||
      independentCanonicalJson(connection["namespaces"]) !== independentCanonicalJson(namespaces)) {
    throw new TypeError("Packaged Wallet connection did not preserve its complete approved namespace scope.");
  }
};

const readPackagedRuntimeIdentity = async (packageIdentity) => {
  const challenge = randomBytes(32).toString("base64url");
  const response = await fetch(`${fixedOrigin}/api/v1/runtime-identity`, {
    headers: { [identityChallengeHeaderName]: challenge },
    redirect: "error",
  });
  const identity = await jsonResponse(response);
  const expectedFields = [
    "challenge",
    "configurationMac",
    "controlProtocolVersion",
    "ownerInstanceId",
    "ownerRevision",
    "packageName",
    "packageVersion",
    "phase",
    "profileId",
    "proof",
    "role",
  ];
  if (
    typeof identity !== "object" ||
    identity === null ||
    Array.isArray(identity) ||
    JSON.stringify(Object.keys(identity).sort()) !== JSON.stringify(expectedFields) ||
    identity.challenge !== challenge ||
    identity.packageName !== packageIdentity.name ||
    identity.packageVersion !== packageIdentity.version ||
    identity.controlProtocolVersion !== "1" || identity.role !== "backend" || identity.phase !== "running" ||
    typeof identity.profileId !== "string" ||
    !/^[A-Za-z0-9_-]{22}$/u.test(identity.profileId) ||
    typeof identity.ownerInstanceId !== "string" ||
    !/^[A-Za-z0-9_-]{22}$/u.test(identity.ownerInstanceId) ||
    typeof identity.configurationMac !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(identity.configurationMac) ||
    typeof identity.proof !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(identity.proof) ||
    typeof identity.ownerRevision !== "string" ||
    !/^(?:0|[1-9][0-9]*)$/u.test(identity.ownerRevision)
  ) throw new TypeError("Packaged runtime identity is invalid.");
  return identity;
};

const problemCode = (value) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const code = Object.getOwnPropertyDescriptor(value, "code")?.value;
  return typeof code === "string" ? code : undefined;
};

const readToolOperation = (toolResult) => {
  const operation = toolResult?.structuredContent;
  if (typeof operation !== "object" || operation === null) {
    throw new TypeError("MCP wallet operation is unavailable.");
  }
  return operation;
};

const canonicalToolText = (toolResult) => {
  const content = toolResult?.content;
  if (
    !Array.isArray(content) ||
    content.length !== 1 ||
    content[0]?.type !== "text" ||
    typeof content[0].text !== "string"
  ) throw new TypeError("Packaged MCP canonical text projection is invalid.");
  return content[0].text;
};

const canonicalSemanticToolContent = (toolResult, label, projectText) => {
  const structured = toolResult?.structuredContent;
  if (
    typeof structured !== "object" ||
    structured === null ||
    Array.isArray(structured) ||
    canonicalToolText(toolResult) !== (projectText === undefined
      ? JSON.stringify(structured)
      : projectText(structured))
  ) throw new TypeError(`${label} text and structured content differ.`);
  return structured;
};

const stockTokenTradeHistorySummary = (success) => {
  const result = success?.data;
  if (result?.status !== "available") {
    throw new TypeError("Packaged Stock Token trade-history summary requires available data.");
  }
  const sourceName = result.officialAsset?.member?.sourceName;
  const label = sourceName === undefined || sourceName === null || sourceName === result.symbol
    ? result.symbol
    : `${sourceName} · ${result.symbol}`;
  const lines = [
    "Stock Token trade history",
    `Token: ${label}`,
    `Requested period: ${result.period.count} ${result.period.unit}${result.period.count === 1 ? "" : "s"}`,
    "Status: Available",
    `Requested range: ${result.requestedStart} to ${result.requestedEnd}`,
    `Freshness: ${result.freshness === "current" ? "Current" : "Stale"}`,
    `Published through: ${result.archive.root.currentUntil.timestamp}`,
    `Coverage: ${result.coverage.status === "complete" ? "Complete" : "Partial"}`,
    `Requested coverage: ${result.coverage.fromTimestamp} to ${result.coverage.untilTimestamp}`,
    `Resolution: ${result.resolution.label} (${result.resolution.intervalSeconds % 86_400 === 0
      ? `${result.resolution.intervalSeconds / 86_400}-day`
      : result.resolution.intervalSeconds % 3_600 === 0
        ? `${result.resolution.intervalSeconds / 3_600}-hour`
        : `${result.resolution.intervalSeconds / 60}-minute`})`,
    ...result.coverage.limitations.map((limitation) => `Limitation: ${limitation ===
        "before_published_coverage"
      ? "Published trade history starts after the requested period began."
      : "Published trade history ends before the requested period ended."}`),
  ];
  if (result.positions.some((position) =>
    position.coverage === "partial" && position.candle !== null)) {
    lines.push("Warning: A partial candle is the unchanged full stored natural interval and may include activity outside its represented request bounds.");
  }
  const latest = result.positions.findLast((position) => position.candle !== null)?.candle;
  if (latest === undefined || latest === null) {
    lines.push(result.positions.every((position) => position.coverage === "complete")
      ? "No qualifying Stock Token/USDG trade occurred in the requested period."
      : "Trade absence is not established for every requested position.");
  } else {
    lines.push(
      `Latest chart close: ${latest.close.numerator} / ${latest.close.denominator} USDG`,
      `Trades observed: ${latest.observedStart} to ${latest.observedEnd}`,
    );
  }
  return lines.join("\n");
};

const assertOperationToolResultDescriptor = (toolResult, toolName, normalizedInput) => {
  const descriptor = toolResult?._meta?.["littlejohn/operation-tool-result"];
  const result = toolResult?.structuredContent;
  const inputText = independentCanonicalJson(normalizedInput);
  const resultText = independentCanonicalJson(result);
  if (
    !hasExactObjectKeys(descriptor, [
      "inputSha256",
      "inputUtf8Bytes",
      "isError",
      "kind",
      "resultSha256",
      "resultUtf8Bytes",
      "toolName",
      "version",
    ]) ||
    descriptor.kind !== "operation_tool_result_descriptor" ||
    descriptor.version !== 1 ||
    descriptor.toolName !== toolName ||
    descriptor.inputUtf8Bytes !== Buffer.byteLength(inputText, "utf8") ||
    descriptor.inputSha256 !== createHash("sha256").update(inputText, "utf8").digest("hex") ||
    descriptor.resultUtf8Bytes !== Buffer.byteLength(resultText, "utf8") ||
    descriptor.resultSha256 !== createHash("sha256").update(resultText, "utf8").digest("hex") ||
    descriptor.isError !== (toolResult?.isError === true) ||
    canonicalToolText(toolResult) !== resultText
  ) throw new TypeError("Packaged operation result descriptor is invalid.");
  return descriptor;
};

const callOperationTool = async (client, toolName, normalizedInput) => {
  const result = await client.callTool(toolName, normalizedInput);
  assertOperationToolResultDescriptor(result, toolName, normalizedInput);
  return result;
};

const reconstructPackagedSnapshot = async (client, descriptor) => {
  const chunks = [];
  for (let index = 0; index < descriptor.resultChunkCount; index += 1) {
    const chunk = await client.callTool("presentation_get_snapshot_chunk", {
      snapshotUri: descriptor.snapshotUri,
      index,
    });
    const chunkContent = chunk?.structuredContent;
    if (
      chunkContent?.kind !== "presentation_snapshot_chunk" ||
      chunkContent.snapshotId !== descriptor.snapshotId ||
      chunkContent.index !== index ||
      typeof chunkContent.canonicalBase64 !== "string"
    ) throw new TypeError("Packaged MCP App exact snapshot chunk is invalid.");
    const bytes = Buffer.from(chunkContent.canonicalBase64, "base64");
    const expectedLength = index + 1 === descriptor.resultChunkCount
      ? descriptor.resultUtf8Bytes - descriptor.resultChunkBytes * index
      : descriptor.resultChunkBytes;
    if (bytes.length !== expectedLength) {
      throw new TypeError("Packaged MCP App snapshot chunk length is invalid.");
    }
    chunks.push(bytes);
  }
  const bytes = Buffer.concat(chunks);
  if (
    bytes.length !== descriptor.resultUtf8Bytes ||
    createHash("sha256").update(bytes).digest("hex") !== descriptor.resultSha256
  ) throw new TypeError("Packaged MCP App snapshot bytes are invalid.");
  const value = JSON.parse(bytes.toString("utf8"));
  if (bytes.toString("utf8") !== independentCanonicalJson(value)) {
    throw new TypeError("Packaged MCP App snapshot JSON is not canonical.");
  }
  return value;
};

const assertPackagedNoUi = (result, label) => {
  if (result?._meta?.["littlejohn/presentation-card"] !== undefined || result?._meta?.ui?.resourceUri !== undefined ||
      result?._meta?.["openai/outputTemplate"] !== undefined || result?.content?.some((item) =>
        item.type === "resource_link" && item.uri.startsWith("littlejohn://presentation/cards/"))) throw new TypeError(`${label} unexpectedly published UI.`);
};
const assertPackagedDataWithoutUi = (result, label) => {
  assertPackagedNoUi(result, label);
  if (result?._meta?.["littlejohn/presentation-snapshot"] !== undefined || result?.content?.some((item) => item.type === "resource_link")) {
    throw new TypeError(`${label} attached an unsolicited immutable presentation.`);
  }
};

const admitPackagedAppCreatingSource = async (client, result, label) => {
  const reference = result?._meta?.["littlejohn/presentation-card"];
  const acknowledgement = result?.structuredContent;
  if (!hasExactObjectKeys(reference, ["kind", "cardId"]) || reference.kind !== "card" ||
      typeof reference.cardId !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(reference.cardId) ||
      !hasExactObjectKeys(acknowledgement, ["kind", "cardId", "disposition"]) || acknowledgement.kind !== "card" ||
      acknowledgement.cardId !== reference.cardId || !["created", "existing", "creating"].includes(acknowledgement.disposition) ||
      result?.content?.length !== 2 || result.content[0]?.type !== "text" || result.content[0].text !== independentCanonicalJson(acknowledgement) ||
      result.content[1]?.type !== "resource_link" || result.content[1].uri !== `littlejohn://presentation/cards/${reference.cardId}` ||
      result._meta?.["littlejohn/presentation-snapshot"] !== undefined) throw new TypeError(`${label} creation acknowledgement is invalid.`);
  const presentation = await waitFor(async () => (await callOperationTool(client, "presentation_get_card", reference)).structuredContent,
    (value) => value?.display?.kind === "decision" || value?.display?.kind === "snapshot", `${label} source preparation`);
  const resource = presentation.display.resource;
  const descriptor = resource?.descriptor;
  const inputText = independentCanonicalJson(resource?.normalizedInput);
  if (presentation.state?.reference?.cardId !== reference.cardId || presentation.state.record?.cardId !== reference.cardId ||
      resource?.kind !== "presentation_snapshot_resource" ||
      descriptor?.inputUtf8Bytes !== Buffer.byteLength(inputText, "utf8") ||
      descriptor?.inputSha256 !== createHash("sha256").update(inputText, "utf8").digest("hex")) throw new TypeError(`${label} exact source is invalid.`);
  return Object.freeze({descriptor, link: {uri: descriptor.snapshotUri}, resource, reference, presentation});
};

const readPackagedAppSourceResult = async (client, source, label) => {
  const {descriptor, resource} = source;
  const exactResource = await client.readResource(descriptor.snapshotUri);
  if (exactResource?.uri !== descriptor.snapshotUri || exactResource?.mimeType !== "application/json" ||
      exactResource?.text !== independentCanonicalJson(resource)) throw new TypeError(`${label} snapshot resource is invalid.`);
  const value = await reconstructPackagedSnapshot(client, descriptor);
  return Object.freeze({...source, value});
};

const admitPackagedAppCreatingResult = async (client, result, label) =>
  readPackagedAppSourceResult(client, await admitPackagedAppCreatingSource(client, result, label), label);

/** @param {typeof import("../../src/interfaces/mcp-app/registry.js").presentationContractRegistry} installedRegistry */
const assertPackagedAddressCardReplay = async (
  installedRegistry, client, creatingResult, expectedInput, fakeRpc, readSourceRequestCount, label,
) => {
  const source = await admitPackagedAppCreatingSource(client, creatingResult, label);
  const rpcCount = fakeRpc.calls.length;
  const sourceCount = await readSourceRequestCount();
  const creating = await readPackagedAppSourceResult(client, source, label);
  const entry = installedRegistry.requireIdentity("address.inspect", "1");
  const input = entry.parseInput(expectedInput);
  const admittedInput = entry.parseNormalizedInput(creating.resource.normalizedInput);
  const descriptor = creating.descriptor;
  const initialText = independentCanonicalJson(creating.value);
  const presentationText = independentCanonicalJson(creating.presentation);
  const record = creating.presentation.state.record;
  if (descriptor.contractId !== entry.contractId || descriptor.contractVersion !== entry.contractVersion ||
      descriptor.source.kind !== "sqlite" ||
      independentCanonicalJson(admittedInput) !== independentCanonicalJson(input) ||
      independentCanonicalJson(entry.parseResult(admittedInput, creating.value)) !== initialText ||
      creating.presentation.state.mode !== "static" || creating.presentation.display.kind !== "snapshot" ||
      creating.presentation.actions.length !== 0 || record.kind !== "read" || record.preparationState !== "completed" ||
      record.contractId !== entry.contractId || record.contractVersion !== entry.contractVersion ||
      record.inputDigest !== descriptor.inputSha256 || record.snapshotId !== descriptor.snapshotId ||
      record.outcome?.kind !== "snapshot") {
    throw new TypeError(`${label} did not retain its exact admitted input/result.`);
  }

  const current = (await callOperationTool(client, "presentation_get_card", creating.reference)).structuredContent;
  const opened = (await callOperationTool(client, "presentation_start_view", {
    cardId: creating.reference.cardId, cardOpenRequestId: randomBytes(32).toString("base64url"),
  })).structuredContent;
  const cardUri = `littlejohn://presentation/cards/${creating.reference.cardId}`;
  const cardResource = await client.readResource(cardUri);
  const snapshot = await client.callTool("presentation_get_snapshot", {snapshotUri: descriptor.snapshotUri});
  assertPackagedNoUi(snapshot, `${label} exact snapshot lookup`);
  const snapshotResource = await client.readResource(descriptor.snapshotUri);
  const replayed = await reconstructPackagedSnapshot(client, descriptor);
  if (independentCanonicalJson(current) !== presentationText || independentCanonicalJson(opened) !== presentationText ||
      cardResource?.uri !== cardUri || cardResource?.mimeType !== "application/json" || cardResource?.text !== presentationText ||
      snapshot.structuredContent?.kind !== "presentation_snapshot_reference" ||
      snapshot.structuredContent.snapshotUri !== descriptor.snapshotUri ||
      independentCanonicalJson(snapshot.structuredContent.descriptor) !== independentCanonicalJson(descriptor) ||
      snapshot._meta?.["littlejohn/presentation-snapshot"] !== undefined ||
      snapshotResource?.uri !== descriptor.snapshotUri || snapshotResource?.mimeType !== "application/json" ||
      snapshotResource?.text !== independentCanonicalJson(creating.resource) ||
      independentCanonicalJson(entry.parseResult(admittedInput, replayed)) !== initialText ||
      independentCanonicalJson(replayed) !== initialText) {
    throw new TypeError(`${label} replay changed the complete saved canonical result or its exact source.`);
  }
  if (fakeRpc.calls.length !== rpcCount || await readSourceRequestCount() !== sourceCount) {
    throw new TypeError(`${label} exact redisplay re-executed the owning read.`);
  }
  return creating;
};

const createPackagedExistingDecision = async (client, result, label) => {
  assertPackagedDataWithoutUi(result, label);
  const review = result?.structuredContent?.review;
  if (typeof review?.operationId !== "string" || !["wallet", "token_selection"].includes(review.domain)) throw new TypeError(`${label} has no canonical Review.`);
  return client.callTool("presentation_start_decision", {kind: review.domain,
    source: {kind: "existing", operationId: review.operationId}});
};

const openPackagedCardReview = async (client, result, label) => {
  const creating = await admitPackagedAppCreatingResult(client, await createPackagedExistingDecision(client, result, label), label);
  const cardId = creating.reference.cardId;
  const uri = `littlejohn://presentation/cards/${cardId}`;
  const resource = await client.readResource(uri);
  const initial = JSON.parse(resource?.text).state;
  const review = creating.value?.review;
  if (independentCanonicalJson(creating.value) !== independentCanonicalJson(result.structuredContent) ||
      resource?.uri !== uri || resource?.mimeType !== "application/json" || initial?.mode !== "interactive" ||
      initial.reference?.cardId !== cardId || initial.record?.cardId !== cardId || initial.record.operationId !== review?.operationId ||
      initial.record.resultDigest !== creating.descriptor.resultSha256 || initial.record.inputState !== "input_pending" ||
      initial.record.closeReason !== null || initial.record.dispatchId !== null || Object.hasOwn(initial.record, "firstCardOpenRequestId")) {
    throw new TypeError(`${label} does not identify its pending exact card/source.`);
  }
  const replay = await client.callTool("presentation_get_snapshot", {snapshotUri: creating.descriptor.snapshotUri});
  assertPackagedNoUi(replay, `${label} immutable source lookup`);
  if (replay?.structuredContent?.kind !== "presentation_snapshot_reference" || replay.structuredContent.snapshotUri !== creating.descriptor.snapshotUri ||
      independentCanonicalJson(replay.structuredContent.descriptor) !== independentCanonicalJson(creating.descriptor)) throw new TypeError(`${label} source descriptor changed.`);
  const afterReplay = JSON.parse((await client.readResource(uri))?.text).state;
  if (independentCanonicalJson(afterReplay) !== independentCanonicalJson(initial)) throw new TypeError(`${label} snapshot lookup changed its saved card.`);
  const opening = {cardId, cardOpenRequestId: randomBytes(32).toString("base64url")};
  const opened = (await callOperationTool(client, "presentation_start_view", opening)).structuredContent;
  if (opened?.state?.mode !== "interactive" || opened.state.record?.cardId !== cardId || opened.state.record.operationId !== review.operationId ||
      opened.state.record.inputState !== "input_pending" || opened.display?.kind !== "decision" || !opened.actions?.includes("confirm")) throw new TypeError(`${label} did not admit its current source.`);
  const repeated = (await callOperationTool(client, "presentation_start_view", opening)).structuredContent;
  const anotherView = (await callOperationTool(client, "presentation_start_view", {cardId, cardOpenRequestId: randomBytes(32).toString("base64url")})).structuredContent;
  if (independentCanonicalJson(repeated) !== independentCanonicalJson(opened) || independentCanonicalJson(anotherView) !== independentCanonicalJson(opened)) {
    throw new TypeError(`${label} changed on an opening retry or redisplay.`);
  }
  return {...opening, decision: {review, initiatedBy: "mcp_app"}};
};

const assertPackagedReviewWithoutServerTools = async (
  client,
  packagedHtml,
  moduleRoot,
) => {
  const reviewResult = await client.callTool(
    "wallet_start_connection_change_review",
    { kind: "connect" },
  );
  const creatingResult = await createPackagedExistingDecision(client, reviewResult, "Packaged no-serverTools Wallet Review");
  const reviewSnapshot = await admitPackagedAppCreatingResult(client, creatingResult, "Packaged no-serverTools Wallet Review");
  const review = reviewSnapshot.value?.review;
  if (
    reviewSnapshot.value?.status !== "review" ||
    review?.kind !== "connect" ||
    typeof review?.operationId !== "string"
  ) throw new TypeError("Packaged no-serverTools Wallet Review is invalid.");

  const script = /<script type="module">([\s\S]*)<\/script>/u.exec(packagedHtml)?.[1];
  if (script === undefined) {
    throw new TypeError("Packaged MCP App module is unavailable.");
  }
  const dom = new JSDOM(
    packagedHtml.replace(/<script type="module">[\s\S]*<\/script>/u, ""),
    {
      pretendToBeVisual: true,
      runScripts: "outside-only",
      url: "https://example.invalid/",
      virtualConsole: new VirtualConsole(),
    },
  );
  const view = dom.window;
  view.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  let viewToolCalls = 0;
  const hostTransport = {
    async start() {},
    async send(message) {
      view.dispatchEvent(new view.MessageEvent("message", { data: message, source: view }));
    },
    async close() {
      this.onclose?.();
    },
  };
  Object.defineProperty(view, "postMessage", {
    configurable: true,
    value: (message) => queueMicrotask(() => {
      if (message?.method === "tools/call") viewToolCalls += 1;
      hostTransport.onmessage?.(message);
    }),
  });
  const bridge = new AppBridge(
    null,
    { name: "littlejohn-release-no-server-tools-host", version: "1.0.0" },
    {},
  );
  bridge.oncalltool = async () => ({ content: [], isError: true });
  let initializedResolve;
  const initialized = new Promise((resolveInitialized) => {
    initializedResolve = resolveInitialized;
  });
  bridge.oninitialized = () => initializedResolve();

  const globalDescriptors = new Map();
  const installGlobal = (name, value) => {
    globalDescriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  };
  for (const [name, value] of Object.entries({
    window: view,
    document: view.document,
    navigator: view.navigator,
    Event: view.Event,
    MessageEvent: view.MessageEvent,
    CustomEvent: view.CustomEvent,
    HTMLElement: view.HTMLElement,
    MutationObserver: view.MutationObserver,
    ResizeObserver: view.ResizeObserver,
    getComputedStyle: view.getComputedStyle.bind(view),
    requestAnimationFrame: view.requestAnimationFrame.bind(view),
    cancelAnimationFrame: view.cancelAnimationFrame.bind(view),
  })) installGlobal(name, value);

  const modulePath = resolve(
    moduleRoot,
    `release-packaged-view-${randomBytes(8).toString("hex")}.mjs`,
  );
  const originalConsoleDebug = console.debug;
  console.debug = () => {};
  try {
    await writeFile(modulePath, script, { mode: 0o600 });
    await bridge.connect(hostTransport);
    await import(pathToFileURL(modulePath).href);
    await waitForPromise(
      initialized,
      requestTimeoutMs,
      "Packaged no-serverTools View initialization",
    );
    await bridge.sendToolResult(creatingResult);
    await waitFor(
      () => Promise.resolve(view.document.body.textContent),
      (text) => text.includes("Direct controls unavailable"),
      "Packaged no-serverTools Review presentation",
    );
    const text = view.document.body.textContent;
    if (
      !text.includes("This Host cannot read the saved card. No action was requested.") ||
      text.includes("Little John could not display this result") ||
      view.document.querySelectorAll("button").length !== 0 ||
      viewToolCalls !== 0
    ) throw new TypeError("Packaged no-serverTools View bypassed the saved-card boundary.");
  } finally {
    await bridge.close().catch(() => undefined);
    view.close();
    await rm(modulePath, { force: true });
    console.debug = originalConsoleDebug;
    for (const [name, descriptor] of globalDescriptors) {
      if (descriptor === undefined) delete globalThis[name];
      else Object.defineProperty(globalThis, name, descriptor);
    }
  }

  const untouchedResource = await client.readResource(
    `littlejohn://presentation/cards/${reviewSnapshot.reference.cardId}`,
  );
  const untouchedState = JSON.parse(untouchedResource?.text).state;
  if (untouchedState?.record?.inputState !== "input_pending" || untouchedState.record.closeReason !== null || untouchedState.record.dispatchId !== null) {
    throw new TypeError("Packaged no-serverTools View changed the saved card.");
  }

  const exactOperation = await client.request("tools/call", {
    name: "wallet_get_operation",
    arguments: { operationId: review.operationId },
  });
  if (
    exactOperation?.isError !== true ||
    exactOperation?.structuredContent?.error?.code !== "wallet_operation_not_found"
  ) throw new TypeError("Packaged no-serverTools View created Wallet operation state.");
};

const assertPackagedReadApp = async (client, prepared, fakeRpc) => {
  const tools = await client.listTools();
  assertPackagedToolAnnotations(tools, true);
  const names = tools.map((tool) => tool.name).sort();
  if (JSON.stringify(names) !== JSON.stringify([...expectedAppToolNames].sort())) {
    throw new TypeError("Packaged MCP App tool registry is incomplete.");
  }
  const readTool = tools.find((tool) => tool.name === "wallet_get_connection");
  const readCreationTool = tools.find((tool) => tool.name === "presentation_start_read");
  const decisionCreationTool = tools.find((tool) => tool.name === "presentation_start_decision");
  const snapshotTool = tools.find((tool) => tool.name === "presentation_get_snapshot");
  const chunkTool = tools.find((tool) => tool.name === "presentation_get_snapshot_chunk");
  const resourceUri = readCreationTool?._meta?.ui?.resourceUri;
  if (
    typeof resourceUri !== "string" ||
    !resourceUri.startsWith("ui://littlejohn/presentation/") ||
    decisionCreationTool?._meta?.ui?.resourceUri !== resourceUri || readTool?._meta?.ui?.resourceUri !== undefined ||
    JSON.stringify(readTool?._meta?.ui?.visibility) !== JSON.stringify(["model"]) ||
    JSON.stringify(snapshotTool?._meta?.ui?.visibility) !== JSON.stringify(["model"]) ||
    snapshotTool?._meta?.ui?.resourceUri !== undefined ||
    JSON.stringify(chunkTool?._meta?.ui?.visibility) !== JSON.stringify(["app"]) ||
    chunkTool?._meta?.ui?.resourceUri !== undefined ||
    tools.some((tool) => tool?._meta?.["openai/outputTemplate"] !== undefined)
  ) throw new TypeError("Packaged MCP App tool metadata is invalid.");

  const resources = await client.listResources();
  if (
    resources.length !== 1 ||
    resources[0]?.uri !== resourceUri ||
    resources[0]?.mimeType !== "text/html;profile=mcp-app"
  ) throw new TypeError("Packaged MCP App resource catalog is invalid.");
  const appResource = await client.readResource(resourceUri);
  const packagedHtml = await readFile(
    resolve(prepared.installedPackageRoot, "dist/mcp-app/index.html"),
    "utf8",
  );
  const appDigest = createHash("sha256").update(packagedHtml, "utf8").digest("hex");
  if (
    appResource?.uri !== resourceUri ||
    appResource?.mimeType !== "text/html;profile=mcp-app" ||
    appResource?.text !== packagedHtml ||
    resourceUri !== `ui://littlejohn/presentation/${appDigest}.html`
  ) throw new TypeError("Packaged MCP App resource bytes are invalid.");

  const appNotice = await readFile(
    resolve(prepared.installedPackageRoot, "dist/mcp-app/THIRD_PARTY_NOTICES.txt"),
    "utf8",
  );
  const noticeDom = new JSDOM(appResource.text, { virtualConsole: new VirtualConsole() });
  try {
    const document = noticeDom.window.document;
    const templates = document.querySelectorAll("template#third-party-notices");
    if (
      templates.length !== 1 ||
      templates[0].content.textContent !== appNotice ||
      document.querySelectorAll("script").length !== 1 ||
      document.querySelector("script")?.type !== "module" ||
      document.querySelectorAll("style").length !== 1 ||
      document.querySelectorAll("[src],link[href]").length !== 0 ||
      document.querySelector("main#app")?.textContent !== "" ||
      document.body.textContent.includes("MCP App third-party notices") ||
      resources[0].size !== Buffer.byteLength(appResource.text, "utf8")
    ) throw new TypeError("Packaged App notices did not reach the Host resource inertly and completely.");
  } finally {
    noticeDom.window.close();
  }

  const readInput = { symbol: fakeRpc.stockTokenTradeHistory.symbol, period: { count: 7, unit: "day" } };
  const creatingResult = await client.callTool("presentation_start_read", {
    capabilityId: "market.stock_token_trade_history", input: readInput,
  });
  const savedReference = creatingResult?._meta?.["littlejohn/presentation-card"];
  const cardId = savedReference?.cardId;
  const cardUri = `littlejohn://presentation/cards/${cardId}`;
  const cardLink = creatingResult?.content?.[1];
  if (
    !hasExactObjectKeys(savedReference, ["kind", "cardId"]) || savedReference.kind !== "card" ||
    typeof cardId !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(cardId) ||
    independentCanonicalJson(creatingResult.structuredContent) !== independentCanonicalJson({kind: "card", cardId, disposition: "created"}) ||
    creatingResult.content?.length !== 2 || creatingResult.content[0]?.type !== "text" ||
    creatingResult.content[0].text !== independentCanonicalJson(creatingResult.structuredContent) ||
    cardLink?.type !== "resource_link" || cardLink.uri !== cardUri ||
    creatingResult._meta?.["littlejohn/presentation-snapshot"] !== undefined
  ) throw new TypeError("Packaged chart admission did not return only its saved card reference.");
  const completed = await waitFor(
    async () => {
      const result = await callOperationTool(client, "presentation_get_card", savedReference);
      const presentation = result.structuredContent;
      if (presentation?.state?.record?.cardId !== cardId || presentation.state.record.kind !== "read") {
        throw new TypeError("Packaged chart read changed its saved identity.");
      }
      return presentation;
    },
    (presentation) => presentation.state.record.preparationState !== "pending",
    "Packaged chart publication",
  );
  const snapshotResource = completed.display?.resource;
  const descriptor = snapshotResource?.descriptor;
  const link = { uri: descriptor?.snapshotUri };
  if (
    completed.state.mode !== "static" || completed.display?.kind !== "snapshot" ||
    completed.actions?.length !== 0 ||
    completed.state.record.preparationState !== "completed" || Object.hasOwn(completed.state.record, "inputState") ||
    completed.state.record.outcome?.kind !== "snapshot" ||
    completed.state.record.snapshotId !== descriptor?.snapshotId ||
    snapshotResource?.kind !== "presentation_snapshot_resource" ||
    descriptor?.contractId !== "market.stock_token_trade_history" || descriptor?.contractVersion !== "1" ||
    independentCanonicalJson(snapshotResource.normalizedInput) !== independentCanonicalJson(readInput) ||
    descriptor.resultChunkCount !== 1
  ) throw new TypeError("Packaged chart publication did not link its complete canonical snapshot.");
  const exactSnapshot = await client.readResource(link.uri);
  if (exactSnapshot?.text !== independentCanonicalJson(snapshotResource)) {
    throw new TypeError("Packaged chart snapshot descriptor changed in resource delivery.");
  }
  const reopened = (await callOperationTool(client, "presentation_start_view", {
    cardId, cardOpenRequestId: randomBytes(32).toString("base64url"),
  })).structuredContent;
  if (independentCanonicalJson(reopened) !== independentCanonicalJson(completed)) {
    throw new TypeError("Packaged completed chart changed when opened again.");
  }

  const reference = await client.callTool("presentation_get_snapshot", {
    snapshotUri: link.uri,
  });
  if (
    reference?.structuredContent?.kind !== "presentation_snapshot_reference" ||
    reference.structuredContent.snapshotUri !== link.uri ||
    independentCanonicalJson(reference.structuredContent.descriptor) !==
      independentCanonicalJson(descriptor) ||
    Object.hasOwn(reference.structuredContent, "result") ||
    Object.hasOwn(reference.structuredContent, "payload")
  ) throw new TypeError("Packaged MCP App exact snapshot reference is invalid.");

  const reconstructed = await reconstructPackagedSnapshot(client, descriptor);
  const reconstructedData = reconstructed.data;
  if (
    reconstructedData?.status !== "available" ||
    reconstructedData.symbol !== fakeRpc.stockTokenTradeHistory.symbol ||
    reconstructedData.period?.count !== 7 ||
    reconstructedData.period?.unit !== "day" ||
    !Array.isArray(reconstructedData.positions) ||
    reconstructedData.positions.length !== 168
  ) throw new TypeError("Packaged MCP App snapshot reconstruction is invalid.");

  await assertPackagedReviewWithoutServerTools(
    client,
    packagedHtml,
    prepared.installRoot,
  );
};

const tokenAsset = (fakeRpc) => Object.freeze({
  kind: "erc20",
  chainId: fakeRpc.token.chainId,
  address: fakeRpc.token.address,
});

const assertTokenInspection = (inspection, fakeRpc) => {
  const asset = tokenAsset(fakeRpc);
  const standardStatuses = inspection?.data?.standards?.standards
    ?.map(({ standardId, status }) => [standardId, status]);
  const conclusionIds = inspection?.evidence?.conclusions?.map(({ id }) => id);
  const standardConclusionIds = [
    "erc165_status_observed",
    "erc20_read_surface_observed",
    "erc8056_balances_status_observed",
    "erc8056_conversion_status_observed",
    "erc8056_pending_multiplier_status_observed",
    "erc8056_required_values_observed",
    "erc8056_status_observed",
  ];
  const standardSourcePurposes = inspection?.evidence?.sources
    ?.map(({ purpose }) => purpose)
    .filter((purpose) => purpose.startsWith("erc"))
    .sort();
  if (
    typeof inspection !== "object" ||
    inspection === null ||
    inspection.data?.asset?.kind !== asset.kind ||
    inspection.data.asset.chainId !== asset.chainId ||
    inspection.data.asset.address !== asset.address ||
    inspection.data?.analysis?.target !== asset.address ||
    inspection.data.analysis.block?.blockHash !== fakeRpc.canonicalBlockReference.blockHash ||
    inspection.data?.totalSupply?.raw !== fakeRpc.token.totalSupplyRaw ||
    inspection.data?.totalSupply?.decimals?.status !== "available" ||
    inspection.data.totalSupply.decimals.value !== fakeRpc.token.decimals ||
    inspection.data?.metadata?.name?.status !== "available" ||
    inspection.data.metadata.name.value !== fakeRpc.token.name ||
    inspection.data?.metadata?.symbol?.status !== "available" ||
    inspection.data.metadata.symbol.value !== fakeRpc.token.symbol ||
    inspection.data.metadata.decimalsReadFailure !== null ||
    JSON.stringify(standardStatuses) !== JSON.stringify([
      ["erc20_read_surface", "observed"],
      ["erc165", "supported"],
      ["erc8056", "supported"],
      ["erc8056_pending_multiplier", "supported"],
      ["erc8056_conversion", "not_supported"],
      ["erc8056_balances", "supported"],
    ]) ||
    inspection.data.standards.requiredErc8056?.currentMultiplier !==
      fakeRpc.token.currentMultiplier ||
    inspection.data.standards.requiredErc8056?.pendingMultiplier !==
      fakeRpc.token.pendingMultiplier ||
    inspection.data.standards.requiredErc8056?.pendingEffectiveAt !==
      fakeRpc.token.pendingEffectiveAt ||
    JSON.stringify(conclusionIds) !== JSON.stringify([
      "contract_controls_observed",
      "contract_deployment_observed",
      "contract_source_checked",
      "decimals_observed",
      "erc165_status_observed",
      "erc20_read_surface_observed",
      "erc8056_balances_status_observed",
      "erc8056_conversion_status_observed",
      "erc8056_pending_multiplier_status_observed",
      "erc8056_required_values_observed",
      "erc8056_status_observed",
      "name_observed",
      "symbol_observed",
      "total_supply_observed",
    ]) ||
    JSON.stringify(standardSourcePurposes) !== JSON.stringify([
      "erc165_status",
      "erc20_read_surface",
      "erc8056_balances_status",
      "erc8056_conversion_status",
      "erc8056_pending_multiplier_status",
      "erc8056_required_values",
      "erc8056_status",
    ]) ||
    standardConclusionIds.some((id) => {
      const conclusion = inspection.evidence.conclusions.find((entry) => entry.id === id);
      return conclusion?.status !== "established" || conclusion.reason !== "observed";
    })
  ) throw new TypeError("Packaged token inspection does not match the release fake authority.");
  assertPackagedClaimsDigests(inspection, "Packaged token inspection");
};

const uniswapV2QuoteInput = (fakeRpc) => Object.freeze({
  tokenIn: Object.freeze({
    kind: "erc20",
    chainId: fakeRpc.semanticReads.uniswapV2.tokenIn.chainId,
    address: fakeRpc.semanticReads.uniswapV2.tokenIn.address,
  }),
  tokenOut: Object.freeze({
    kind: "erc20",
    chainId: fakeRpc.semanticReads.uniswapV2.tokenOut.chainId,
    address: fakeRpc.semanticReads.uniswapV2.tokenOut.address,
  }),
  factory: fakeRpc.semanticReads.uniswapV2.factory,
  amountIn: "1000000000000000000",
  block: Object.freeze({ kind: "latest" }),
});

const assertUniswapV2Quote = (value, fakeRpc, label) => {
  const direct = value?.data?.candidates?.[0];
  const remaining = value?.data?.candidates?.slice(1);
  if (
    value?.data?.protocol?.protocolId !== "uniswap_v2" ||
    value.data.deployment?.factory !== fakeRpc.semanticReads.uniswapV2.factory ||
    value.data.deployment?.runtimeCode?.byteLength !== "13859" ||
    value.data.deployment?.runtimeCode?.codeHash !==
      "0xbab145d02e7005f0d84c6c1639d39b799b0ea16df99ebbdaf5a14d9da820b4e0" ||
    value.data.deployment?.analysis?.target !== fakeRpc.semanticReads.uniswapV2.factory ||
    value.data.block?.blockHash !== fakeRpc.canonicalBlockReference.blockHash ||
    value.data.input?.amountIn !== "1000000000000000000" ||
    value.data.input?.tokenIn?.address !== fakeRpc.semanticReads.uniswapV2.tokenIn.address ||
    value.data.input?.tokenOut?.address !== fakeRpc.semanticReads.uniswapV2.tokenOut.address ||
    direct?.status !== "quoted" ||
    direct.amountOut !== "1992013962079806432" ||
    direct.sdkCheck?.status !== "matched" ||
    direct.evaluatedHops?.length !== 1 ||
    direct.evaluatedHops[0]?.pair?.pairAddress !== fakeRpc.semanticReads.uniswapV2.pair ||
    direct.evaluatedHops[0]?.pair?.reserve0 !== fakeRpc.semanticReads.uniswapV2.reserve0 ||
    direct.evaluatedHops[0]?.pair?.reserve1 !== fakeRpc.semanticReads.uniswapV2.reserve1 ||
    !Array.isArray(remaining) ||
    remaining.length !== 2 ||
    remaining.some((candidate) =>
      candidate?.status !== "pair_absent" ||
      candidate.evaluatedHops?.length !== 1 ||
      candidate.evaluatedHops[0]?.status !== "pair_absent")
  ) throw new TypeError(`${label} is invalid.`);
  assertPackagedClaimsDigests(value, label);
  return value;
};

/**
 * @param {unknown} value
 * @param {Awaited<ReturnType<typeof startFakeRpc>>["token"]} token
 * @param {boolean} included
 * @returns {{
 *   readonly account: { readonly chainId: string; readonly address: string };
 *   readonly asset: { readonly kind: "erc20"; readonly chainId: string; readonly address: string };
 *   readonly included: boolean;
 *   readonly revision: string;
 *   readonly createdAt: string;
 *   readonly updatedAt: string;
 * }}
 */
const assertTokenSelection = (
  value,
  token,
  included,
  expectedAccountAddress = expectedWalletAddress,
) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Packaged token selection is invalid.");
  }
  const selection = /** @type {{
   * account?: { chainId?: unknown; address?: unknown };
   * asset?: { kind?: unknown; chainId?: unknown; address?: unknown };
   * included?: unknown;
   * revision?: unknown;
   * createdAt?: unknown;
   * updatedAt?: unknown;
   * }} */ (value);
  if (
    selection.account?.chainId !== token.chainId ||
    selection.account.address !== expectedAccountAddress ||
    selection.asset?.kind !== "erc20" ||
    selection.asset.chainId !== token.chainId ||
    selection.asset.address !== token.address ||
    selection.included !== included ||
    typeof selection.revision !== "string" ||
    typeof selection.createdAt !== "string" ||
    typeof selection.updatedAt !== "string"
  ) throw new TypeError("Packaged token selection is invalid.");
  return Object.freeze({
    account: Object.freeze({
      chainId: selection.account.chainId,
      address: selection.account.address,
    }),
    asset: Object.freeze({
      kind: selection.asset.kind,
      chainId: selection.asset.chainId,
      address: selection.asset.address,
    }),
    included: selection.included,
    revision: selection.revision,
    createdAt: selection.createdAt,
    updatedAt: selection.updatedAt,
  });
};

const assertTokenSelectionDetail = (
  value,
  fakeRpc,
  token,
  included,
  expectedAccountAddress = expectedWalletAddress,
) => {
  const selection = assertTokenSelection(value?.selection, token, included, expectedAccountAddress);
  if (included && value.historicalInspection !== null) {
    assertTokenInspection(value.historicalInspection, Object.freeze({ ...fakeRpc, token }));
  }
  return selection;
};

const findTokenSelection = (
  value,
  token,
  included,
  expectedAccountAddress = expectedWalletAddress,
) => {
  if (
    typeof value !== "object" ||
    value === null ||
    !Array.isArray(value.selections) ||
    !Object.hasOwn(value, "nextCursor")
  ) throw new TypeError("Packaged token selection page is invalid.");
  const selection = value.selections.find((entry) => entry?.asset?.address === token.address);
  return assertTokenSelection(selection, token, included, expectedAccountAddress);
};

const assertAccountAssetCollection = (
  value,
  fakeRpc,
  expectedTokens,
  expectedAccountAddress = expectedWalletAddress,
) => {
  if (
    value?.account?.chainId !== fakeRpc.token.chainId ||
    value.account.address !== expectedAccountAddress ||
    value.block?.blockHash !== fakeRpc.canonicalBlockReference.blockHash ||
    value.native?.rawBalance !== fakeRpc.nativeBalanceRaw ||
    !Array.isArray(value.assets) ||
    value.assets.length !== expectedTokens.length ||
    expectedTokens.some((token, index) => {
      const asset = value.assets[index];
      return asset?.selection?.asset?.address !== token.address ||
        asset.selection.account?.address !== expectedAccountAddress ||
        asset.selection.included !== true ||
        asset.amount?.raw !== token.accountBalanceRaw ||
        asset.requiredStandards?.block?.blockHash !== fakeRpc.canonicalBlockReference.blockHash;
    })
  ) throw new TypeError("Packaged account asset page is invalid.");
  return value;
};

const dispatch = async (worker, request) => {
  const result = await worker.request("dispatch", { request });
  if (typeof result !== "object" || result === null) {
    throw new TypeError("Release worker dispatch result is invalid.");
  }
  return result;
};

const publicWalletConnection = (worker) => dispatch(worker, {
  requestClass: "public_read",
  method: "GET",
  path: "/api/v1/wallet/connection",
});

const packagedMarketCases = Object.freeze([
  { toolName: "market_get_stock_token_prices", capabilityId: "market.stock_token_prices",
    path: "/api/v1/internal/control/stock-token-price-queries", input: { symbol: "AAPL" },
    cli: ["market", "stock-token-prices", "AAPL", "--json"],
    sourceRoles: [["official", "web_api"], ["candidates", "web_api"], ["asset", "chain_rpc"], ["pools", "chain_rpc"]],
    conclusionIds: ["official_asset_membership_observed", "pool_candidates_observed", "price_asset_inputs_verified", "pool_price_reads_complete"] },
  { toolName: "market_get_stock_token_trade_history", capabilityId: "market.stock_token_trade_history",
    path: "/api/v1/internal/control/stock-token-trade-history-queries",
    input: { symbol: "AAPL", period: { count: 7, unit: "day" } },
    cli: ["market", "stock-token-trade-history", "AAPL", "--period", "7", "--unit", "day", "--json"],
    sourceRoles: [["official_asset_snapshot", "web_api"], ["stock_factory", "chain_rpc"], ["token_decimals", "chain_rpc"], ["trade_history_archive", "public_dataset"]],
    conclusionIds: ["official_asset_snapshot_current", "stock_factory_verified", "token_decimals_observed", "trade_history_archive_observed"] },
  { toolName: "market_list_stock_tokens", capabilityId: "market.stock_tokens",
    path: "/api/v1/internal/control/stock-tokens", input: {},
    cli: ["market", "stock-tokens", "--json"], sourceRoles: [["official_catalog", "web_api"]],
    conclusionIds: ["official_asset_catalog_observed"] },
]);

/** @type {typeof import("./packaged-integration.d.mts").derivePackagedLargeHistorySourceArtifact} */
export const derivePackagedLargeHistorySourceArtifact = (source) => {
  const original = /** @type {any} */ (source).artifacts.healthy;
  const root = JSON.parse(gunzipSync(Buffer.from(original.rootBase64, "base64")).toString("utf8"));
  const assets = new Map(/** @type {[string, Buffer][]} */ (original.assets.map((asset) => [asset.assetName, Buffer.from(asset.base64, "base64")])));
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const decode = (reference) => {
    const asset = root.assets.find((candidate) => candidate.sha256 === reference.assetSha256);
    const bytes = assets.get(asset.assetName);
    if (bytes === undefined) throw new TypeError("Retained History member asset is absent.");
    return JSON.parse(gunzipSync(bytes.subarray(reference.from, reference.until)).toString("utf8"));
  };
  const stateReference = root.baseCurrencies[original.baseAddress];
  const state = decode(stateReference);
  const monthReference = state.months.find((reference) => reference.logicalId.endsWith("/month/2026-08"));
  const month = decode(monthReference);
  const hourly = decode(month.resolutions["1h"]);
  const retainedCandle = decode(month.resolutions["15m"]).candles[0];
  if (original.baseAddress !== "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9" ||
      retainedCandle?.open?.numerator !== "1" || retainedCandle?.close?.numerator !== "2" ||
      retainedCandle.high?.numerator !== "2" || retainedCandle.low?.numerator !== "1" ||
      [retainedCandle.open, retainedCandle.high, retainedCandle.low, retainedCandle.close].some((ratio) => ratio.denominator !== "1") ||
      retainedCandle.baseVolumeRaw !== "2" || retainedCandle.quoteVolumeRaw !== "3" ||
      retainedCandle.tradeCount !== "2" || retainedCandle.sourceCandleCount !== 1 || hourly.candles.length !== 0) {
    throw new TypeError("Retained History source does not match the independent synthetic input design.");
  }
  const start = Date.parse("2026-08-23T07:00:00.000Z");
  const hash = (value) => `0x${BigInt(value).toString(16).padStart(64, "0")}`;
  // These are synthetic upstream stored aggregates, not derived product
  // candles or claims about chain activity. Exact numeric values come from
  // the retained 15m source; intervals and provenance are explicit inputs.
  hourly.candles = Array.from({ length: 24 }, (_, index) => {
    const from = start + index * 3_600_000;
    const blockNumber = String(75 + index);
    const blockHash = hash(2_000 + index);
    return {
      intervalStart: new Date(from).toISOString(), intervalEnd: new Date(from + 3_600_000).toISOString(),
      observedStart: new Date(from + 45 * 60_000).toISOString(), observedEnd: new Date(from + 46 * 60_000).toISOString(),
      open: retainedCandle.open, high: retainedCandle.high, low: retainedCandle.low, close: retainedCandle.close,
      baseVolumeRaw: retainedCandle.baseVolumeRaw, quoteVolumeRaw: retainedCandle.quoteVolumeRaw,
      tradeCount: retainedCandle.tradeCount, sourceCandleCount: retainedCandle.sourceCandleCount,
      firstSource: { blockNumber, blockHash, transactionHash: hash(1_000 + index * 2), transactionIndex: 0, logIndex: 0 },
      lastSource: { blockNumber, blockHash, transactionHash: hash(1_001 + index * 2), transactionIndex: 1, logIndex: 1 },
    };
  });
  const replaceMember = (reference, value, references) => {
    const oldSha256 = reference.assetSha256;
    const selected = root.assets.find((asset) => asset.sha256 === oldSha256);
    const bytes = assets.get(selected.assetName);
    if (bytes === undefined) throw new TypeError("Retained History replacement asset is absent.");
    const json = Buffer.from(independentCanonicalJson(value), "utf8");
    const replacement = gzipSync(json, { level: 9 });
    const members = references.filter((member) => member.assetSha256 === oldSha256).sort((left, right) => left.from - right.from);
    const chunks = [];
    let previousUntil = 0;
    let offset = 0;
    for (const member of members) {
      const gap = bytes.subarray(previousUntil, member.from);
      const priorFrom = member.from;
      const priorUntil = member.until;
      const part = member === reference ? replacement : bytes.subarray(priorFrom, priorUntil);
      chunks.push(gap, part);
      offset += gap.length;
      member.from = offset;
      member.until = offset + part.length;
      if (member === reference) {
        member.gzipSha256 = digest(replacement);
        member.jsonSha256 = digest(json);
        member.jsonBytes = json.length;
      }
      offset += part.length;
      previousUntil = priorUntil;
    }
    chunks.push(bytes.subarray(previousUntil));
    const packed = Buffer.concat(chunks);
    const sha256 = digest(packed);
    for (const member of members) member.assetSha256 = sha256;
    assets.delete(selected.assetName);
    selected.assetName = `${selected.assetName.split("-")[0]}-${sha256}.bin`;
    selected.sha256 = sha256;
    selected.bytes = packed.length;
    assets.set(selected.assetName, packed);
  };
  replaceMember(month.resolutions["1h"], hourly, [...month.days, ...Object.values(month.resolutions)]);
  replaceMember(monthReference, month, state.months);
  replaceMember(stateReference, state, Object.values(root.baseCurrencies));
  root.assets.sort((left, right) => compareCodePointSequences(left.sha256, right.sha256));
  const rootBytes = gzipSync(Buffer.from(independentCanonicalJson(root), "utf8"), { level: 9 });
  return {
    source: "test/stock-token-trade-history/source-artifacts.json#artifacts.healthy",
    limitation: "Synthetic hourly archive input for offline transport verification; it establishes no live chain activity or public source claim.",
    artifact: {
      baseAddress: original.baseAddress,
      rootName: `root-s${root.publicationSequence}-${digest(rootBytes)}.json.gz`,
      rootBase64: rootBytes.toString("base64"),
      assets: [...assets].map(([assetName, bytes]) => ({ assetName, base64: bytes.toString("base64") })),
    },
  };
};

const assertPackagedMarketTransport = (observed, specification, expectedStatus) => {
  const transport = observed?.transport;
  if (observed?.ownerState !== "deferred" || transport?.outcome !== "response_received" ||
      transport.request?.method !== "POST" ||
      transport.request.path !== specification.path || transport.request.maximumResponseBytes !== 8_388_608 ||
      independentCanonicalJson(transport.request.body) !== independentCanonicalJson(specification.input) ||
      transport.response?.statusCode !== expectedStatus || transport.response.cacheControl !== "no-store" ||
      typeof transport.response.text !== "string") {
    throw new TypeError(`Packaged ${specification.toolName} did not use its complete authenticated typed control transport.`);
  }
  return transport.response.text;
};

const assertPackagedMarketSuccessEnvelope = (success, specification, observedAt, label) => {
  const conclusionIds = [...specification.conclusionIds].sort(compareCodePointSequences);
  const sourceRoles = success?.evidence?.sources?.map((source) => [source.purpose, source.sourceClass]);
  const expectedRoles = [...specification.sourceRoles].sort((left, right) => compareCodePointSequences(left[0], right[0]));
  const conclusions = success?.evidence?.conclusions?.map((conclusion) => [
    conclusion.id, conclusion.status, conclusion.reason, conclusion.freshness?.evaluatedAt,
  ]);
  if (!hasExactObjectKeys(success, ["ok", "meta", "data", "evidence", "warnings"]) || success.ok !== true ||
      independentCanonicalJson(success.meta) !== independentCanonicalJson({
        capabilityId: specification.capabilityId, contractVersion: "1", chainId: expectedChainId, evaluatedAt: observedAt,
      }) || independentCanonicalJson(success.warnings) !== "[]" ||
      !Array.isArray(sourceRoles) || independentCanonicalJson(sourceRoles.sort((left, right) => compareCodePointSequences(left[0], right[0]))) !== independentCanonicalJson(expectedRoles) ||
      success.evidence.sources.some((source) => source.observedAt !== observedAt) ||
      independentCanonicalJson(conclusions) !== independentCanonicalJson(conclusionIds.map((id) => [id, "established", "observed", observedAt])) ||
      independentCanonicalJson(success.evidence.coverage) !== independentCanonicalJson({
        status: "complete", established: conclusionIds, notApplicable: [], unavailable: [],
      })) {
    throw new TypeError(`${label} changed its fixture-known canonical envelope or evidence scope.`);
  }
  // This presence check complements the installed owning replay admission. It
  // does not recompute record digests or reconstruct random observation IDs.
  assertPackagedClaimsDigests(success, label);
};

/** @type {typeof import("./packaged-integration.d.mts").assertPackagedCatalogIdentity} */
export const assertPackagedCatalogIdentity = (success, expectedMembers, observedAt, label) => {
  const data = /** @type {any} */ (success)?.data;
  if (independentCanonicalJson(data?.members) !== independentCanonicalJson(expectedMembers) ||
      data?.snapshot?.sourceObservedAt !== observedAt) {
    throw new TypeError(`${label} changed its independently supplied official catalog.`);
  }
};

// Read the supplied upstream bytes, rather than an observed product result.
// This fixture has one requested owner month and one Pool; it is not a second
// source parser or a general archive implementation.
const derivePackagedHistoryArchiveExpectation = (artifact, observedAt) => {
  const rootBytes = Buffer.from(artifact.rootBase64, "base64");
  const rootJson = gunzipSync(rootBytes);
  const root = JSON.parse(rootJson.toString("utf8"));
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const rootSha256 = digest(rootBytes);
  if (artifact.rootName !== `root-s${root.publicationSequence}-${rootSha256}.json.gz`) {
    throw new TypeError("Packaged History fixture root name does not identify its supplied bytes.");
  }
  const decode = (reference) => {
    const asset = root.assets.find((candidate) => candidate.sha256 === reference.assetSha256);
    const supplied = artifact.assets.find((candidate) => candidate.assetName === asset?.assetName);
    if (supplied === undefined) throw new TypeError("Packaged History fixture member asset is absent.");
    const bytes = Buffer.from(supplied.base64, "base64");
    return JSON.parse(gunzipSync(bytes.subarray(reference.from, reference.until)).toString("utf8"));
  };
  const identity = ({ logicalId, assetSha256, gzipSha256, jsonSha256 }) =>
    ({ logicalId, assetSha256, gzipSha256, jsonSha256 });
  const stateReference = root.baseCurrencies[artifact.baseAddress];
  const state = decode(stateReference);
  const monthReference = state.months.find((reference) => reference.logicalId.endsWith("/month/2026-08"));
  const month = decode(monthReference);
  const poolIds = Object.keys(state.pools);
  if (poolIds.length !== 1) throw new TypeError("Packaged History fixture requires one independent Pool identity.");
  return {
    // The History archive contract uses whole seconds, unlike the enclosing
    // evidence clock. Derive its precision from the supplied fixture clock,
    // never from a returned product result.
    observedAt: observedAt.replace(/\.\d{3}Z$/u, ".000Z"),
    root: { publicationSequence: root.publicationSequence, gzipSha256: rootSha256, jsonSha256: digest(rootJson),
      currentUntil: root.currentUntil, poolManager: root.poolManager, usdgAddress: root.usdgAddress, usdgDecimals: root.usdgDecimals },
    base: { baseCurrencyAddress: artifact.baseAddress, decimals: state.decimals, state: identity(stateReference) },
    monthMembers: [{ ownerMonth: "2026-08", member: identity(monthReference) }],
    resolutionMembers: [{ ownerMonth: "2026-08", member: identity(month.resolutions["1h"]) }],
    pools: Object.fromEntries(poolIds.map((poolId) => [poolId, state.pools[poolId].poolKey])),
  };
};

/** @type {typeof import("./packaged-integration.d.mts").assertPackagedHistorySourceIdentity} */
export const assertPackagedHistorySourceIdentity = (success, expectedArchive, label) => {
  const data = /** @type {any} */ (success)?.data;
  if (independentCanonicalJson(data?.archive) !== independentCanonicalJson(expectedArchive) ||
      data?.officialAsset?.member?.contractAddress !== expectedArchive.base.baseCurrencyAddress) {
    throw new TypeError(`${label} changed its independently supplied History source identity.`);
  }
};

const assertPackagedLargeHistory = (success, label, expectedArchive) => {
  const data = success?.data;
  const text = independentCanonicalJson(success);
  const utf8Bytes = Buffer.byteLength(text, "utf8");
  const poolIds = Object.keys(expectedArchive.pools);
  if (utf8Bytes <= 65_536 || utf8Bytes > 600_000) {
    throw new TypeError(`${label} has ${utf8Bytes} canonical UTF-8 bytes; the independent transport witness requires more than 65,536 and at most 600,000.`);
  }
  if (success?.ok !== true || data?.status !== "available" ||
      data.symbol !== "AAPL" || data.period?.count !== 7 || data.period?.unit !== "day" ||
      data.requestedStart !== "2026-08-17T07:00:00.000Z" ||
      data.requestedEnd !== expectedCanonicalBlock.blockTimestamp ||
      independentCanonicalJson(data.block) !== independentCanonicalJson(expectedCanonicalBlock) ||
      data.officialAsset?.member?.contractAddress !== "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9" ||
      data.coverage?.status !== "complete" ||
      data.resolution?.label !== "1h" || data.resolution.intervalSeconds !== 3_600 ||
      poolIds.length !== 1 || !Array.isArray(data.positions) || data.positions.length !== 168) {
    throw new TypeError(`${label} is not the independently specified large canonical History success.`);
  }
  assertPackagedHistorySourceIdentity(success, expectedArchive, label);
  const start = Date.parse("2026-08-17T07:00:00.000Z");
  for (const [index, position] of data.positions.entries()) {
    const from = new Date(start + index * 3_600_000).toISOString();
    const until = new Date(start + (index + 1) * 3_600_000).toISOString();
    if (position.naturalStart !== from || position.naturalEnd !== until ||
        position.representedStart !== from || position.representedEnd !== until ||
        position.coverage !== "complete" || position.poolId !== poolIds[0] ||
        (index < 144 && position.candle !== null)) {
      throw new TypeError(`${label} lost or changed canonical History position ${index}.`);
    }
    if (index >= 144) {
      const candle = position.candle;
      const ordinal = index - 144;
      const hash = (value) => `0x${BigInt(value).toString(16).padStart(64, "0")}`;
      const expected = {
        intervalStart: from, intervalEnd: until,
        observedStart: new Date(Date.parse(from) + 45 * 60_000).toISOString(),
        observedEnd: new Date(Date.parse(from) + 46 * 60_000).toISOString(),
        open: { numerator: "1", denominator: "1" }, high: { numerator: "2", denominator: "1" },
        low: { numerator: "1", denominator: "1" }, close: { numerator: "2", denominator: "1" },
        baseVolumeRaw: "2", quoteVolumeRaw: "3", tradeCount: "2", sourceCandleCount: 1,
        firstSource: { blockNumber: String(75 + ordinal), blockHash: hash(2_000 + ordinal),
          transactionHash: hash(1_000 + ordinal * 2), transactionIndex: 0, logIndex: 0 },
        lastSource: { blockNumber: String(75 + ordinal), blockHash: hash(2_000 + ordinal),
          transactionHash: hash(1_001 + ordinal * 2), transactionIndex: 1, logIndex: 1 },
      };
      if (independentCanonicalJson(candle) !== independentCanonicalJson(expected)) {
        throw new TypeError(`${label} lost the independently specified synthetic source candle ${ordinal}.`);
      }
    }
  }
  assertPackagedClaimsDigests(success, label);
  process.stdout.write(`${label}: ${utf8Bytes} complete canonical UTF-8 bytes.\n`);
  return text;
};

const runPackagedMarketFailureCli = async (prepared, environment, arguments_) => {
  const child = spawn(process.execPath, [
    resolve(prepared.installedPackageRoot, "dist/cli.js"), ...arguments_,
  ], { cwd: prepared.installRoot, env: environment, stdio: ["ignore", "pipe", "pipe"] });
  const ownership = ownChildProcess(child, "Packaged Market failure CLI", childShutdownTimeoutMs);
  const chunks = [];
  child.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  child.stderr.resume();
  const exited = new Promise((resolveExit) => child.once("close", (code, signal) => resolveExit({ code, signal })));
  try {
    const outcome = await waitForPromise(Promise.race([exited, ownership.failure]), requestTimeoutMs, "Packaged Market failure CLI");
    if (outcome.code !== 4 || outcome.signal !== null) {
      throw new TypeError("Packaged Market source failure did not preserve its CLI exit code.");
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { await ownership.terminate(); }
};

const assertFixedPortReleased = async () => {
  const server = createServer();
  /** @type {Promise<void>} */
  const listening = new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(46630, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  await listening;
  /** @type {Promise<void>} */
  const closing = new Promise((resolveClose, rejectClose) => {
    server.close((error) => error === undefined ? resolveClose() : rejectClose(error));
  });
  await closing;
};

const assertFixedPortOwned = async () => {
  const server = createServer();
  /** @type {Promise<void>} */
  const owned = new Promise((resolveOwned, rejectOwned) => {
    server.once("error", (error) => {
      if (Object.getOwnPropertyDescriptor(error, "code")?.value === "EADDRINUSE") resolveOwned();
      else rejectOwned(error);
    });
    server.listen(46630, "127.0.0.1", () => {
      server.close(() => rejectOwned(new TypeError("The fixed port has no owner.")));
    });
  });
  await owned;
};

const assertPackagedPersistence = (inspection, runtimeIdentity, expectedOwner) => {
  if (
    typeof inspection !== "object" ||
    inspection === null ||
    Array.isArray(inspection)
  ) throw new TypeError("Packaged SQLite reopen result is invalid.");
  const owner = inspection.owner;
  const expectedOwnerFields = [
    "acquiredAt",
    "configurationMac",
    "ownerInstanceId",
    "ownerRevision",
    "processId",
    "profileId",
  ];
  if (
    typeof owner !== "object" ||
    owner === null ||
    Array.isArray(owner) ||
    JSON.stringify(Object.keys(owner).sort()) !== JSON.stringify(expectedOwnerFields) ||
    owner.profileId !== runtimeIdentity.profileId ||
    owner.configurationMac !== runtimeIdentity.configurationMac ||
    owner.ownerInstanceId !== runtimeIdentity.ownerInstanceId ||
    owner.ownerRevision !== runtimeIdentity.ownerRevision ||
    owner.processId !== expectedOwner.processId ||
    typeof owner.acquiredAt !== "string" ||
    !Number.isFinite(Date.parse(owner.acquiredAt)) ||
    new Date(owner.acquiredAt).toISOString() !== owner.acquiredAt ||
    owner.acquiredAt !== expectedOwner.acquiredAt
  ) throw new TypeError("Packaged SQLite owner configuration identity is invalid.");
  const connection = inspection.connection;
  if (
    typeof connection !== "object" ||
    connection === null ||
    Array.isArray(connection) ||
    connection.connection?.status !== "disconnected" ||
    connection.connection.reason !== "no_session"
  ) throw new TypeError("Packaged SQLite current connection did not reopen exactly.");
};

/** @type {typeof import("./packaged-integration.d.mts").verifyPackagedIntegration} */
export const verifyPackagedIntegration = async (prepared) => {
  assertPackagedToolSchemaBundleDigestControls();
  const {presentationContractRegistry: installedPresentationRegistry} =
    /** @type {typeof import("../../src/interfaces/mcp-app/registry.js")} */ (await import(pathToFileURL(
      resolve(prepared.installedPackageRoot, "dist/interfaces/mcp-app/registry.js"),
    ).href));
  // Execute the exact package's parent and production SDK executable. The
  // fixture forbids egress and uses only a private loopback relay and profile.
  await runCommand("npm", ["test", "--", "test/wallet/worker.test.ts", "test/runtime/backend-lifecycle.test.ts", "-t", "initializes the pinned SDK offline|compiled independent backend"], {
    cwd: prepared.sourceRoot,
    env: { ...prepared.environment, LITTLEJOHN_TEST_PACKAGE_ROOT: prepared.installedPackageRoot },
  });
  const integrationRoot = resolve(prepared.workspace, "integration");
  const dataDirectory = resolve(integrationRoot, "state");
  const clockPath = resolve(integrationRoot, "clock.txt");
  const tradeHistoryArtifactPath = resolve(integrationRoot, "trade-history-source-artifacts.json");
  const largeTradeHistoryArtifactPath = resolve(integrationRoot, "large-trade-history-source-artifact.json");
  const workerPath = resolve(prepared.installRoot, "release-owner-worker.mjs");
  await mkdir(integrationRoot, { recursive: true, mode: 0o700 });
  const fixtureObservedAt = new Date().toISOString();
  await writeFile(clockPath, `${fixtureObservedAt}\n`, { mode: 0o600 });
  const retainedTradeHistoryBytes = await readFile(new URL("../../test/stock-token-trade-history/source-artifacts.json", import.meta.url));
  await writeFile(tradeHistoryArtifactPath, retainedTradeHistoryBytes, { mode: 0o600 });
  const largeTradeHistoryFixture = derivePackagedLargeHistorySourceArtifact(
    JSON.parse(retainedTradeHistoryBytes.toString("utf8")),
  );
  const expectedHistoryArchive = derivePackagedHistoryArchiveExpectation(largeTradeHistoryFixture.artifact, fixtureObservedAt);
  await writeFile(largeTradeHistoryArtifactPath, JSON.stringify(largeTradeHistoryFixture), { mode: 0o600 });
  await writeFile(
    workerPath,
    renderPackagedOwnerWorkerSource(prepared.packageIdentity.installRelativePath),
    { mode: 0o600 },
  );
  const fakeRpc = await startFakeRpc();
  const walletConnectProjectId = "1".repeat(32);
  const verifierEnvironment = Object.freeze({
    ...prepared.environment,
    LITTLEJOHN_DATA_DIR: dataDirectory,
    LITTLEJOHN_RELEASE_CLOCK: clockPath,
    LITTLEJOHN_RELEASE_TRADE_HISTORY_ARTIFACT: tradeHistoryArtifactPath,
    LITTLEJOHN_RELEASE_LARGE_TRADE_HISTORY_ARTIFACT: largeTradeHistoryArtifactPath,
    LITTLEJOHN_WALLETCONNECT_PROJECT_ID: walletConnectProjectId,
  });
  const environment = fakeRpc.createChildEnvironment(verifierEnvironment);
  const workers = [];
  const mcpClients = [];
  try {
    if (fakeRpc.token.chainId !== expectedChainId) {
      throw new TypeError("Release fake token is outside the configured chain.");
    }
    const owner = await startWorkerPeer(workerPath, prepared.installRoot, environment);
    workers.push(owner);
    if (owner.ready?.ownerState !== "owner") {
      throw new TypeError("First packaged runtime process did not own the fixed port.");
    }
    const deferred = await startWorkerPeer(workerPath, prepared.installRoot, environment);
    workers.push(deferred);
    if (deferred.ready?.ownerState !== "deferred") {
      throw new TypeError("Second packaged runtime process did not defer to the fixed owner.");
    }
    const initialRuntimeIdentity = await readPackagedRuntimeIdentity(prepared.packageIdentity);
    const publicIdentityBytes = JSON.stringify(initialRuntimeIdentity);
    if (
      publicIdentityBytes.includes(fakeRpc.url) ||
      publicIdentityBytes.includes(walletConnectProjectId)
    ) throw new TypeError("Packaged runtime identity exposed configuration input.");
    const changedRpcUrl = `${fakeRpc.url}/`;
    await assertIncompatibleWorkerConfiguration(
      workerPath,
      prepared.installRoot,
      fakeRpc.createChildEnvironment(verifierEnvironment, changedRpcUrl),
      [changedRpcUrl, walletConnectProjectId],
    );
    const changedProjectId = "2".repeat(32);
    await assertIncompatibleWorkerConfiguration(
      workerPath,
      prepared.installRoot,
      fakeRpc.createChildEnvironment({
        ...verifierEnvironment,
        LITTLEJOHN_WALLETCONNECT_PROJECT_ID: changedProjectId,
      }),
      [fakeRpc.url, changedProjectId],
    );
    const unchangedOwner = await owner.request("inspect");
    const unchangedRuntimeIdentity = await readPackagedRuntimeIdentity(prepared.packageIdentity);
    if (
      unchangedOwner?.ownerState !== "owner" ||
      unchangedRuntimeIdentity.profileId !== initialRuntimeIdentity.profileId ||
      unchangedRuntimeIdentity.ownerInstanceId !== initialRuntimeIdentity.ownerInstanceId ||
      unchangedRuntimeIdentity.ownerRevision !== initialRuntimeIdentity.ownerRevision ||
      unchangedRuntimeIdentity.configurationMac !== initialRuntimeIdentity.configurationMac
    ) throw new TypeError("Incompatible packaged configuration changed the fixed owner.");

    const firstMcp = await startNpxMcp(prepared, environment);
    mcpClients.push(firstMcp);
    const invokedSemanticReadToolNames = new Set();
    const callSemanticRead = async (client, name, arguments_ = {}) => {
      if (!expectedSemanticReadToolNames.includes(name)) {
        throw new TypeError(`Undeclared semantic read invocation: ${name}.`);
      }
      const result = await client.callTool(name, arguments_);
      assertPackagedDataWithoutUi(result, `Packaged ${name} data`);
      invokedSemanticReadToolNames.add(name);
      return result;
    };
    const readContractSourceRequestCount = async () => {
      const inspection = await owner.request("inspect");
      if (
        inspection?.ownerState !== "owner" ||
        !Number.isSafeInteger(inspection.contractSourceVerificationRequestCount) ||
        inspection.contractSourceVerificationRequestCount < 0
      ) throw new TypeError("Packaged source-request count is invalid.");
      return inspection.contractSourceVerificationRequestCount;
    };
    const tools = (await firstMcp.listTools()).map((tool) => {
      if (typeof tool !== "object" || tool === null || Array.isArray(tool) ||
        !("name" in tool) || typeof tool.name !== "string" ||
        !("inputSchema" in tool) || !isRecord(tool.inputSchema) ||
        !("outputSchema" in tool) || !isRecord(tool.outputSchema)
      ) throw new TypeError("Packaged MCP tools do not expose complete canonical schemas.");
      return /** @type {Parameters<typeof import("./packaged-integration.d.mts").packagedToolSchemaBundleSha256>[0][number]} */ (tool);
    });
    const names = tools.map((tool) => tool.name).sort();
    assertPackagedToolAnnotations(tools);
    if (JSON.stringify(names) !== JSON.stringify([...expectedToolNames].sort())) {
      throw new TypeError("Packaged MCP tool registry is incomplete.");
    }
    const exactSchemaTools = exactPackagedToolSchemaNames.map((name) => {
      const tool = tools.find((candidate) => candidate.name === name);
      if (tool === undefined) throw new TypeError("Packaged MCP tool registry is incomplete.");
      return tool;
    });
    const actualSchemaDigest = packagedToolSchemaBundleSha256(exactSchemaTools);
    if (actualSchemaDigest !== expectedExactPackagedToolSchemaBundleSha256) {
      throw new TypeError(
        `Packaged exact tool schema bundle digest is ${actualSchemaDigest}.`,
      );
    }
    const catalog = await firstMcp.callTool("read_list_capabilities");
    const catalogEntries = catalog.structuredContent?.capabilities;
    if (!Array.isArray(catalogEntries)) {
      throw new TypeError("Packaged MCP capability catalog is invalid.");
    }
    const capabilityIds = catalogEntries.map((entry) => entry?.capabilityId);
    if (
      catalog.structuredContent?.contractVersion !== "1" ||
      JSON.stringify(capabilityIds) !== JSON.stringify(expectedCapabilityIds) ||
      catalogEntries.some((entry) =>
        entry?.maximumSuccessUtf8Bytes !== (entry?.capabilityId === "market.stock_token_trade_history"
          ? 600_000
          : 8_388_607) ||
        !Array.isArray(entry?.failureCodes) ||
        entry.failureCodes.filter((code) => code === "result_too_large").length !== 1)
    ) throw new TypeError("Packaged MCP capability catalog is not the exact canonical set.");
    for (const specification of packagedMarketCases) {
      const entry = catalogEntries.find((candidate) => candidate.capabilityId === specification.capabilityId);
      if (independentCanonicalJson(entry?.availability) !== independentCanonicalJson({
        overall: "available", direct: "internal", http: "internal", mcp: "available", cli: "available",
      })) throw new TypeError(`Packaged ${specification.capabilityId} did not preserve its exact transport availability.`);
    }
    const readRegistryState = () => {
      const database = new DatabaseSync(resolve(dataDirectory, "littlejohn.sqlite3"), { readOnly: true });
      try {
        return independentCanonicalJson({
          snapshots: database.prepare("SELECT * FROM robinhood_asset_snapshot ORDER BY chain_id").all(),
          members: database.prepare("SELECT * FROM robinhood_asset ORDER BY chain_id, contract_address").all(),
        });
      } finally { database.close(); }
    };
    const registryBeforeUnauthenticated = readRegistryState();
    const sourceCallsBeforeUnauthenticated = (await owner.request("inspect")).officialAssetSourceRequestCount;
    if (!Number.isSafeInteger(sourceCallsBeforeUnauthenticated) || sourceCallsBeforeUnauthenticated < 0) {
      throw new TypeError("Packaged official source-request count is invalid.");
    }
    const rpcCallsBeforeUnauthenticated = fakeRpc.calls.length;
    for (const specification of packagedMarketCases) {
      const unauthorized = await jsonResponse(await fetch(fixedOrigin + specification.path, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(specification.input), redirect: "error",
      }), 401);
      if (problemCode(unauthorized) !== "unauthorized") {
        throw new TypeError(`Packaged ${specification.toolName} accepted an unauthenticated control read.`);
      }
    }
    if (readRegistryState() !== registryBeforeUnauthenticated ||
        (await owner.request("inspect")).officialAssetSourceRequestCount !== sourceCallsBeforeUnauthenticated ||
        fakeRpc.calls.length !== rpcCallsBeforeUnauthenticated) {
      throw new TypeError("Unauthenticated packaged Market controls reached a producer or changed the Registry snapshot.");
    }
    const pools = canonicalSemanticToolContent(await callSemanticRead(firstMcp, "uniswap_v4_list_pools", {
      stockTokenAddress: fakeRpc.stockTokenTradeHistory.tokenAddress,
    }), "Packaged V4 pool candidates");
    if (pools.data?.stockTokenAddress !== fakeRpc.stockTokenTradeHistory.tokenAddress ||
        pools.data?.officialMember !== true || !Array.isArray(pools.data?.candidates) ||
        pools.data.candidates.length === 0 || pools.data.candidates.some((entry) =>
          entry.stockTokenAddress !== fakeRpc.stockTokenTradeHistory.tokenAddress)) {
      throw new TypeError("Packaged pool listing lost the admitted asset or its candidates.");
    }
    assertPackagedClaimsDigests(pools, "Packaged V4 pool candidates");
    const expectedCatalogMembers = fakeRpc.tokens.filter((token) => token.assetUid !== undefined)
      .map((token) => ({ assetUid: /** @type {string} */ (token.assetUid), contractAddress: token.address, sourceName: token.name, sourceSymbol: token.symbol }))
      .sort((left, right) => compareCodePointSequences(left.assetUid, right.assetUid));
    const expectedCatalogSummary = [
      "Official Stock Tokens", `Catalog observed: ${fixtureObservedAt}`,
      "Catalog membership does not establish a USDG pool or a current price.",
      ...expectedCatalogMembers.map((member) => `${member.sourceSymbol} — ${member.sourceName} — ${member.contractAddress}`),
    ].join("\n");
    const tokenCatalog = canonicalSemanticToolContent(await callSemanticRead(firstMcp, "market_list_stock_tokens", {}), "Packaged official token catalog", () => expectedCatalogSummary);
    assertPackagedCatalogIdentity(tokenCatalog, expectedCatalogMembers, fixtureObservedAt, "Packaged official token catalog");
    const expectedPriceSummary = [
      "Stock Token pool prices: AAPL",
      `Price block: ${expectedCanonicalBlock.blockNumber} (${expectedCanonicalBlock.blockTimestamp})`,
      "Candidate source: DEX Screener; coverage: source-reported candidates",
      "Only candidates returned by the source are covered; this is not every pool or a best-price selection.",
      "Prices are pool spot ratios in USDG per Stock Token at the displayed block, not execution quotes or USD values.",
      "uniswap_v2 — 0xd0bbf7df4e357eb3d6276df5a5903bd42bbf3647",
      "Price: 2 USDG; Verified pool price", "Pool swap fee: 0.3%",
    ].join("\n");
    const priceRead = canonicalSemanticToolContent(await callSemanticRead(firstMcp, "market_get_stock_token_prices", { symbol: "AAPL" }), "Packaged pool prices", () => expectedPriceSummary);
    const priceRow = priceRead.data?.pools?.[0];
    if (priceRead.data?.status !== "available" || priceRead.data?.pools?.length !== 1 || priceRow?.status !== "verified" ||
        priceRow.price?.numerator !== "2" || priceRow.price?.denominator !== "1" ||
        priceRow.state?.swapFeeMillionths !== "3000" || priceRead.data?.source?.coverage !== "provider_reported" ||
        JSON.stringify(priceRead.evidence?.sources?.filter((source) => source.sourceClass === "web_api").map((source) => source.owner).sort()) !== JSON.stringify(["DEX Screener", "Robinhood"])) {
      throw new TypeError("Packaged price read did not preserve its independent source, pinned state and exact price.");
    }
    assertPackagedClaimsDigests(tokenCatalog, "Packaged official catalog");
    assertPackagedClaimsDigests(priceRead, "Packaged pool prices");
    const checksumPrice = await runCommand(process.execPath, [
      resolve(prepared.installedPackageRoot, "dist/cli.js"),
      "market", "stock-token-prices", "--token", "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9", "--json",
    ], { cwd: prepared.installRoot, env: environment, output: "capture" });
    const checksumPriceResult = JSON.parse(checksumPrice.stdout.toString("utf8"));
    if (checksumPriceResult.ok !== true || checksumPriceResult.data?.member?.contractAddress !== fakeRpc.stockTokenTradeHistory.tokenAddress ||
        independentCanonicalJson(checksumPriceResult.data) !== independentCanonicalJson(priceRead.data)) {
      throw new TypeError("Installed CLI checksum selector did not preserve the canonical pool-price result.");
    }
    await owner.request("set_trade_history_source_fixture", { fixture: "large_transport" });
    try {
    for (const specification of packagedMarketCases) {
      const native = await deferred.request("market_read", { toolName: specification.toolName, input: specification.input });
      const responseText = assertPackagedMarketTransport(native, specification, 200);
      if (native.result?.ok !== true || native.transport.response.contentType !== "application/json") {
        throw new TypeError(`Packaged ${specification.toolName} did not deliver a canonical native success.`);
      }
      const nativeSuccess = native.result.value;
      if (responseText !== `${independentCanonicalJson(nativeSuccess)}\n`) {
        throw new TypeError(`Packaged ${specification.toolName} changed the complete original HTTP response in typed admission.`);
      }
      const mcp = await callSemanticRead(firstMcp, specification.toolName, specification.input);
      const mcpSuccess = mcp.structuredContent;
      const expectedSummary = specification.capabilityId === "market.stock_token_trade_history"
        ? stockTokenTradeHistorySummary(mcpSuccess)
        : specification.capabilityId === "market.stock_token_prices" ? expectedPriceSummary : expectedCatalogSummary;
      if (mcpSuccess?.ok !== true || canonicalToolText(mcp) !== expectedSummary) {
        throw new TypeError(`Packaged ${specification.toolName} changed its admitted MCP result or data-only summary.`);
      }
      const cli = await runCommand(process.execPath, [
        resolve(prepared.installedPackageRoot, "dist/cli.js"), ...specification.cli,
      ], { cwd: prepared.installRoot, env: environment, output: "capture" });
      const cliText = cli.stdout.toString("utf8");
      const cliSuccess = JSON.parse(cliText);
      if (cliSuccess?.ok !== true || cliText !== `${independentCanonicalJson(cliSuccess)}\n`) {
        throw new TypeError(`Packaged ${specification.toolName} changed its complete admitted CLI JSON.`);
      }
      for (const [success, label] of [[nativeSuccess, "typed HTTP"], [mcpSuccess, "data-only MCP"], [cliSuccess, "CLI"]]) {
        assertPackagedMarketSuccessEnvelope(success, specification, fixtureObservedAt, `Packaged ${label} ${specification.toolName}`);
      }
      if (specification.capabilityId === "market.stock_token_trade_history") {
        assertPackagedLargeHistory(nativeSuccess, "Packaged typed HTTP History", expectedHistoryArchive);
        assertPackagedLargeHistory(mcpSuccess, "Packaged data-only MCP History", expectedHistoryArchive);
        assertPackagedLargeHistory(cliSuccess, "Packaged CLI History", expectedHistoryArchive);
      } else if (specification.capabilityId === "market.stock_tokens") {
        for (const success of [nativeSuccess, mcpSuccess, cliSuccess]) {
          assertPackagedCatalogIdentity(success, expectedCatalogMembers, fixtureObservedAt, "Packaged official token catalog");
        }
      } else {
        if ([nativeSuccess, mcpSuccess, cliSuccess].some((success) =>
          independentCanonicalJson(success.data) !== independentCanonicalJson(priceRead.data))) {
          throw new TypeError(`Packaged ${specification.toolName} changed its independently checked Market data.`);
        }
      }
    }
    } finally { await owner.request("set_trade_history_source_fixture", { fixture: "retained" }); }
    const sourceFailure = {
      ok: false,
      error: { code: "source_unavailable", category: "source",
        message: "A required data source is unavailable.", retryable: true, issues: [] },
    };
    await owner.request("set_official_asset_source_availability", { available: false });
    try {
      const registryBeforeFailure = readRegistryState();
      const rpcCallsBeforeFailure = fakeRpc.calls.length;
      const sourceCallsBeforeFailure = (await owner.request("inspect")).officialAssetSourceRequestCount;
      for (const specification of packagedMarketCases) {
        const native = await deferred.request("market_read", { toolName: specification.toolName, input: specification.input });
        const problemText = assertPackagedMarketTransport(native, specification, 503);
        if (native.result?.ok !== false ||
            independentCanonicalJson(native.result.failure) !== independentCanonicalJson(sourceFailure) ||
            problemCode(JSON.parse(problemText)) !== sourceFailure.error.code ||
            native.transport.response.contentType !== "application/problem+json") {
          throw new TypeError(`Packaged ${specification.toolName} lost its native owning source failure.`);
        }
        const mcp = await firstMcp.callToolResult(specification.toolName, specification.input);
        assertPackagedDataWithoutUi(mcp, `Packaged ${specification.toolName} failure`);
        if (mcp.isError !== true ||
            independentCanonicalJson(mcp.structuredContent) !== independentCanonicalJson(sourceFailure) ||
            canonicalToolText(mcp) !== independentCanonicalJson(sourceFailure)) {
          throw new TypeError(`Packaged ${specification.toolName} lost its data-only MCP owning source failure.`);
        }
        const cliText = await runPackagedMarketFailureCli(prepared, environment, specification.cli);
        if (cliText !== `${independentCanonicalJson(sourceFailure)}\n`) {
          throw new TypeError(`Packaged ${specification.toolName} lost its complete CLI owning source failure.`);
        }
      }
      if (readRegistryState() !== registryBeforeFailure || fakeRpc.calls.length !== rpcCallsBeforeFailure ||
          (await owner.request("inspect")).officialAssetSourceRequestCount !== sourceCallsBeforeFailure + 3 * packagedMarketCases.length) {
        throw new TypeError("Packaged Market source failures changed the admitted Registry, reached Chain reads or bypassed the source.");
      }
    } finally { await owner.request("set_official_asset_source_availability", { available: true }); }
    const activity = await firstMcp.callTool("activity_list_transactions", {
      account: { chainId: expectedChainId, address: expectedWalletAddress }, cursor: null,
    });
    if (independentCanonicalJson(activity.structuredContent) !== independentCanonicalJson({
      account: { chainId: expectedChainId, address: expectedWalletAddress }, records: [], nextCursor: null,
    })) throw new TypeError("Packaged activity did not read its empty canonical ledger.");
    const appMcp = await startNpxMcp(prepared, environment, true);
    mcpClients.push(appMcp);
    await assertPackagedReadApp(appMcp, prepared, fakeRpc);
    const chainStatus = await callSemanticRead(firstMcp, "read_get_chain_status");
    if (
      chainStatus.structuredContent?.data?.chainId !== expectedChainId ||
      !hasExactObjectKeys(chainStatus.structuredContent?.data, ["chainId", "latestBlock"])
    ) throw new TypeError("Packaged MCP chain status is invalid.");
    assertPackagedClaimsDigests(chainStatus.structuredContent, "Packaged MCP chain status");

    const accountBalance = await callSemanticRead(firstMcp, "read_get_account_balance", {
      account: { kind: "address", address: fakeRpc.semanticReads.account.address },
      includeNative: true,
      tokens: [fakeRpc.semanticReads.account.token.address],
      block: { kind: "latest" },
    });
    const accountBalanceContent = canonicalSemanticToolContent(
      accountBalance,
      "Packaged MCP account balance",
    );
    assertPackagedClaimsDigests(accountBalanceContent, "Packaged MCP account balance");
    const accountToken = accountBalanceContent.data?.tokens?.[0];
    const accountConclusionIds = accountBalanceContent.evidence?.conclusions?.map(({ id }) => id);
    if (
      accountBalanceContent.data?.account !== fakeRpc.semanticReads.account.address ||
      accountBalanceContent.data?.block?.blockHash !== fakeRpc.canonicalBlockReference.blockHash ||
      accountBalanceContent.data?.native?.status !== "available" ||
      accountBalanceContent.data.native.amount?.raw !== fakeRpc.semanticReads.account.nativeBalanceRaw ||
      accountToken?.asset?.address !== fakeRpc.semanticReads.account.token.address ||
      accountToken.result?.status !== "available" ||
      accountToken.result.amount?.raw !== fakeRpc.semanticReads.account.token.accountBalanceRaw ||
      accountToken.result.amount?.decimals?.status !== "available" ||
      accountToken.result.amount.decimals.value !== fakeRpc.semanticReads.account.token.decimals ||
      JSON.stringify(accountConclusionIds) !== JSON.stringify([
        "account_bound",
        "native_balance_observed",
        `token_balance:${fakeRpc.semanticReads.account.token.address}`,
      ]) ||
      accountBalanceContent.evidence?.coverage?.status !== "complete"
    ) throw new TypeError("Packaged MCP account balance is invalid.");

    const codeFixture = fakeRpc.semanticReads.address.runtimeCodeObserved;
    const codeRpcStart = fakeRpc.calls.length;
    const sourceRequestsBeforeCode = await readContractSourceRequestCount();
    const codeInspection = await callSemanticRead(appMcp, "read_inspect_address", {
      target: { kind: "address", address: codeFixture.address },
      block: { kind: "latest" },
    });
    assertPackagedDataWithoutUi(codeInspection, "Packaged code-bearing Address data");
    const codeContent = canonicalSemanticToolContent(codeInspection, "Packaged code-bearing Address inspection");
    const sourceRequestsAfterCode = await readContractSourceRequestCount();
    const codeRpcCalls = fakeRpc.calls.slice(codeRpcStart);
    const assertCodeInspection = (content) => {
      assertPackagedClaimsDigests(content, "Packaged code-bearing Address inspection");
      const codeAnalysis = content.data?.analysis;
      if (
        content.data?.status !== "runtime_code_observed" ||
        content.data?.address !== codeFixture.address ||
        independentCanonicalJson(content.data?.block ?? null) !==
          independentCanonicalJson(expectedCanonicalBlock) ||
        codeAnalysis?.chainId !== expectedChainId ||
        codeAnalysis?.target !== codeFixture.address ||
        independentCanonicalJson(codeAnalysis?.block ?? null) !==
          independentCanonicalJson(expectedCanonicalBlock) ||
        codeAnalysis?.targetRuntimeCode?.byteLength !== codeFixture.byteLength ||
        codeAnalysis?.targetRuntimeCode?.codeHash !== codeFixture.codeHash ||
        independentCanonicalJson(codeAnalysis?.proxy ?? null) !==
          independentCanonicalJson({ status: "no_supported_proxy_observed" }) ||
        independentCanonicalJson(codeAnalysis?.sources ?? null) !==
          independentCanonicalJson([{
            role: "target",
            address: codeFixture.address,
            status: "no_record_observed",
          }]) ||
        independentCanonicalJson(codeAnalysis?.declaredFunctions ?? null) !==
          independentCanonicalJson({
            status: "unavailable",
            reason: "exact_abi_unavailable",
          }) ||
        independentCanonicalJson(codeAnalysis?.controls ?? null) !==
          independentCanonicalJson({
            owner: { status: "unavailable", reason: "exact_abi_unavailable" },
            paused: { status: "unavailable", reason: "exact_abi_unavailable" },
            defaultAdmins: { status: "unavailable", reason: "exact_abi_unavailable" },
          }) ||
        content.data?.runtimeCode !== codeFixture.runtimeCode ||
        JSON.stringify(content.evidence?.conclusions?.map(({ id }) => id)) !==
          JSON.stringify([
            "address_target_bound",
            "contract_controls_observed",
            "contract_deployment_observed",
            "contract_source_checked",
            "runtime_code_observed",
          ]) ||
        content.evidence?.coverage?.status !== "partial" ||
        independentCanonicalJson(content.warnings?.map(({ code, message }) => ({
          code,
          message,
        })) ?? null) !== independentCanonicalJson([{
          code: "partial_result",
          message: "Some requested results are unavailable.",
        }])
      ) throw new TypeError("Packaged code-bearing Address inspection is invalid.");
    };
    assertCodeInspection(codeContent);
    if (sourceRequestsAfterCode !== sourceRequestsBeforeCode + 1 ||
      JSON.stringify(codeRpcCalls.map(({ method }) => method)) !== JSON.stringify([
        "eth_chainId",
        "eth_getBlockByNumber",
        "eth_getCode",
        "eth_getStorageAt",
        "eth_getStorageAt",
        "eth_getStorageAt",
      ]) ||
      codeRpcCalls[2]?.params?.[0] !== codeFixture.address
    ) throw new TypeError("Packaged code-bearing Address inspection is invalid.");
    const codeCreating = await assertPackagedAddressCardReplay(installedPresentationRegistry, appMcp,
      await appMcp.callTool("presentation_start_read", {capabilityId: "address.inspect", input: {
        target: {kind: "address", address: codeFixture.address}, block: {kind: "latest"}}}),
      {target: {kind: "address", address: codeFixture.address}, block: {kind: "latest"}},
      fakeRpc, readContractSourceRequestCount, "Packaged code-bearing Address card");
    assertCodeInspection(codeCreating.value);

    const emptyFixture = fakeRpc.semanticReads.address.noRuntimeCodeObserved;
    const emptyRpcStart = fakeRpc.calls.length;
    const sourceRequestsBeforeEmpty = await readContractSourceRequestCount();
    const emptyInspection = await callSemanticRead(appMcp, "read_inspect_address", {
      target: { kind: "address", address: emptyFixture.address },
      block: { kind: "latest" },
    });
    assertPackagedDataWithoutUi(emptyInspection, "Packaged empty-code Address data");
    const emptyContent = canonicalSemanticToolContent(emptyInspection, "Packaged empty-code Address inspection");
    const sourceRequestsAfterEmpty = await readContractSourceRequestCount();
    const emptyRpcCalls = fakeRpc.calls.slice(emptyRpcStart);
    const assertEmptyInspection = (content) => {
      assertPackagedClaimsDigests(content, "Packaged empty-code Address inspection");
      if (
        !hasExactObjectKeys(content.data, ["address", "block", "runtimeCode", "status"]) ||
        content.data.status !== "no_runtime_code_observed" ||
        content.data.address !== emptyFixture.address ||
        independentCanonicalJson(content.data.block ?? null) !==
          independentCanonicalJson(expectedCanonicalBlock) ||
        content.data.runtimeCode !== "0x" ||
        JSON.stringify(content.evidence?.conclusions?.map(({ id }) => id)) !==
          JSON.stringify(["address_target_bound", "no_runtime_code_observed"]) ||
        content.evidence?.coverage?.status !== "complete" ||
        content.evidence?.sources?.some((source) =>
          source.sourceClass === "contract_verification_service") ||
        !Array.isArray(content.warnings) ||
        content.warnings.length !== 0
      ) throw new TypeError("Packaged empty-code Address inspection is invalid.");
    };
    assertEmptyInspection(emptyContent);
    if (sourceRequestsAfterEmpty !== sourceRequestsBeforeEmpty ||
      JSON.stringify(emptyRpcCalls.map(({ method }) => method)) !== JSON.stringify([
        "eth_chainId",
        "eth_getBlockByNumber",
        "eth_getCode",
      ]) ||
      emptyRpcCalls[2]?.params?.[0] !== emptyFixture.address
    ) throw new TypeError("Packaged empty-code Address inspection is invalid.");
    const emptyCreating = await assertPackagedAddressCardReplay(installedPresentationRegistry, appMcp,
      await appMcp.callTool("presentation_start_read", {capabilityId: "address.inspect", input: {
        target: {kind: "address", address: emptyFixture.address}, block: {kind: "latest"}}}),
      {target: {kind: "address", address: emptyFixture.address}, block: {kind: "latest"}},
      fakeRpc, readContractSourceRequestCount, "Packaged empty-code Address card");
    assertEmptyInspection(emptyCreating.value);

    const sourceResponseLimitBytes = 8 * 1024 * 1024;
    for (const [label, result] of [
      ["transaction", fakeRpc.semanticReads.transaction.transaction],
      ["receipt", fakeRpc.semanticReads.transaction.receipt],
    ]) {
      const bytes = Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id: "release", result }), "utf8");
      if (bytes >= sourceResponseLimitBytes) {
        throw new TypeError(`Packaged ${label} fixture exceeds the RPC source-response limit.`);
      }
    }
    const transactionInput = {
      transactionHash: fakeRpc.semanticReads.transaction.transactionHash,
    };
    const transactionMcpDelivery = await firstMcp.callToolResult(
      "read_inspect_transaction",
      transactionInput,
    );
    invokedSemanticReadToolNames.add("read_inspect_transaction");
    if (
      transactionMcpDelivery?.isError !== true ||
      transactionMcpDelivery.structuredContent !== undefined ||
      transactionMcpDelivery._meta !== undefined ||
      JSON.stringify(transactionMcpDelivery.content) !== JSON.stringify([{
        type: "text",
        text: "Little John could not deliver this MCP result because it exceeds the supported response size.",
      }])
    ) throw new TypeError("Packaged MCP transaction delivery boundary is invalid.");
    const transactionContent = await jsonResponse(await fetch(
      `${fixedOrigin}/api/v1/transaction-inspections`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(transactionInput),
        redirect: "error",
      },
    ));
    assertPackagedClaimsDigests(transactionContent, "Packaged HTTP transaction inspection");
    const receipt = transactionContent.data?.inclusion?.receipt;
    const transactionWarnings = transactionContent.warnings;
    const transactionBytes = Buffer.byteLength(JSON.stringify(transactionContent), "utf8");
    if (
      transactionContent.data?.transactionHash !== fakeRpc.semanticReads.transaction.transactionHash ||
      transactionContent.data?.from !== fakeRpc.semanticReads.transaction.from ||
      transactionContent.data?.recipient?.kind !== "call" ||
      transactionContent.data.recipient.address !== fakeRpc.semanticReads.transaction.to ||
      transactionContent.data?.value?.raw !== fakeRpc.semanticReads.transaction.valueRaw ||
      transactionContent.data?.input !== fakeRpc.semanticReads.transaction.input ||
      transactionContent.data?.nonce !== fakeRpc.semanticReads.transaction.nonce ||
      transactionContent.data?.gasLimit?.raw !== fakeRpc.semanticReads.transaction.gasLimitRaw ||
      transactionContent.data?.type !== fakeRpc.semanticReads.transaction.type ||
      transactionContent.data?.fee?.kind !== "legacy" ||
      transactionContent.data.fee.gasPrice?.numerator?.raw !==
        fakeRpc.semanticReads.transaction.gasPriceRaw ||
      transactionContent.data?.accessList?.kind !== "entries" ||
      transactionContent.data.accessList.entries?.[0]?.address !==
        fakeRpc.semanticReads.transaction.accessListAddress ||
      transactionContent.data.accessList.entries?.[0]?.storageKeys?.[0] !==
        fakeRpc.semanticReads.transaction.accessListStorageKey ||
      transactionContent.data?.inclusion?.status !== "included" ||
      transactionContent.data.inclusion.block?.blockHash !== fakeRpc.canonicalBlockReference.blockHash ||
      transactionContent.data.inclusion.block?.blockNumber !==
        fakeRpc.semanticReads.transaction.blockNumber ||
      transactionContent.data.inclusion.transactionIndex !==
        fakeRpc.semanticReads.transaction.transactionIndex ||
      receipt?.status !== "success" ||
      receipt.cumulativeGasUsed?.raw !== fakeRpc.semanticReads.transaction.cumulativeGasUsedRaw ||
      receipt.gasUsed?.raw !== fakeRpc.semanticReads.transaction.gasUsedRaw ||
      receipt.effectiveGasPrice?.numerator?.raw !== fakeRpc.semanticReads.transaction.gasPriceRaw ||
      receipt.logs?.[0]?.data !== fakeRpc.semanticReads.transaction.undecodedLogData ||
      receipt.logs?.[0]?.decodedEvent?.kind !== "not_decoded" ||
      receipt.logs?.[1]?.decodedEvent?.kind !== "erc20_transfer" ||
      receipt.logs[1].decodedEvent.token !== fakeRpc.semanticReads.transaction.transferToken ||
      receipt.logs[1].decodedEvent.from !== fakeRpc.semanticReads.transaction.transferFrom ||
      receipt.logs[1].decodedEvent.to !== fakeRpc.semanticReads.transaction.transferTo ||
      receipt.logs[1].decodedEvent.amount?.raw !== fakeRpc.semanticReads.transaction.transferAmountRaw ||
      JSON.stringify(transactionContent.evidence?.conclusions?.map(({ id }) => id)) !==
        JSON.stringify([
          "inclusion_observed",
          "receipt_observed",
          "standard_events_decoded",
          "transaction_observed",
        ]) ||
      !Array.isArray(transactionWarnings) ||
      transactionWarnings.length !== 2 ||
      transactionWarnings.some((warning) => warning?.code !== "decimals_unavailable") ||
      transactionContent.evidence?.coverage?.status !== "complete" ||
      transactionBytes < 8_000_000 ||
      transactionBytes > 8_388_607
    ) throw new TypeError("Packaged HTTP transaction inspection is invalid.");

    const quoteInput = uniswapV2QuoteInput(fakeRpc);
    const mcpUniswapV2Quote = await callSemanticRead(
      firstMcp,
      "uniswap_v2_quote_exact_input",
      quoteInput,
    );
    assertUniswapV2Quote(
      canonicalSemanticToolContent(
        mcpUniswapV2Quote,
        "Packaged MCP Uniswap V2 quote",
      ),
      fakeRpc,
      "Packaged MCP Uniswap V2 quote",
    );

    const httpUniswapV2Quote = assertUniswapV2Quote(
      await jsonResponse(await fetch(
        `${fixedOrigin}/api/v1/uniswap-v2-exact-input-quotes`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(quoteInput),
          redirect: "error",
        },
      )),
      fakeRpc,
      "Packaged HTTP Uniswap V2 quote",
    );
    if (
      JSON.stringify(httpUniswapV2Quote.data) !==
      JSON.stringify(mcpUniswapV2Quote.structuredContent.data)
    ) {
      throw new TypeError("Packaged MCP and HTTP Uniswap V2 quote data differ.");
    }

    const cliUniswapV2Quote = await runCommand(process.execPath, [
      resolve(prepared.installedPackageRoot, "dist/cli.js"),
      "uniswap-v2",
      "quote-exact-input",
      "--factory",
      quoteInput.factory,
      "--token-in",
      quoteInput.tokenIn.address,
      "--token-out",
      quoteInput.tokenOut.address,
      "--amount-in",
      quoteInput.amountIn,
      "--block",
      "latest",
      "--json",
    ], { cwd: prepared.installRoot, env: environment, output: "capture" });
    const cliUniswapV2Content = assertUniswapV2Quote(
      JSON.parse(cliUniswapV2Quote.stdout.toString("utf8")),
      fakeRpc,
      "Packaged CLI Uniswap V2 quote",
    );
    if (JSON.stringify(cliUniswapV2Content.data) !== JSON.stringify(httpUniswapV2Quote.data)) {
      throw new TypeError("Packaged CLI and HTTP Uniswap V2 quote data differ.");
    }

    const httpChainStatus = await jsonResponse(await fetch(`${fixedOrigin}/api/v1/chain-status`));
    if (
      httpChainStatus.data?.chainId !== expectedChainId ||
      !hasExactObjectKeys(httpChainStatus.data, ["chainId", "latestBlock"]) ||
      httpChainStatus.data?.latestBlock?.blockHash !== `0x${"88".repeat(32)}`
    ) throw new TypeError("Packaged HTTP chain status is invalid.");

    const cli = await runCommand(process.execPath, [
      resolve(prepared.installedPackageRoot, "dist/cli.js"),
      "read",
      "chain-status",
      "--json",
    ], { cwd: prepared.installRoot, env: environment, output: "capture" });
    const cliStatus = JSON.parse(cli.stdout.toString("utf8"));
    if (
      cliStatus.data?.chainId !== expectedChainId ||
      !hasExactObjectKeys(cliStatus.data, ["chainId", "latestBlock"]) ||
      cliStatus.data?.latestBlock?.blockHash !== "0x" + "88".repeat(32)
    ) throw new TypeError("Packaged CLI chain status is invalid.");

    const removedBrowserRoot = await fetch(fixedOrigin + "/", { redirect: "error" });
    if (
      removedBrowserRoot.status !== 404 ||
      removedBrowserRoot.headers.get("set-cookie") !== null
    ) throw new TypeError("Packaged local Browser surface still exists.");
    await removedBrowserRoot.arrayBuffer();
    const credentialedPublicRead = await fetch(
      fixedOrigin + "/api/v1/wallet/connection",
      { headers: { Cookie: "littlejohn_browser_session=obsolete" }, redirect: "error" },
    );
    if (
      credentialedPublicRead.status !== 401 ||
      problemCode(await credentialedPublicRead.json()) !== "unauthorized"
    ) throw new TypeError("Packaged public read accepted obsolete Browser authority.");
    const queriedPublicRead = await fetch(
      fixedOrigin + "/api/v1/wallet/connection?refresh=true",
      { redirect: "error" },
    );
    if (
      queriedPublicRead.status < 400 ||
      problemCode(await queriedPublicRead.json()) !== "query_not_supported"
    ) throw new TypeError("Packaged public read accepted a Browser-style query.");

    const walletReview = async (kind) => {
      const result = await appMcp.callTool("wallet_start_connection_change_review", { kind });
      const envelope = await openPackagedCardReview(appMcp, result, "Packaged Wallet Review");
      if (envelope.decision.review?.kind !== kind) {
        throw new TypeError("Packaged Wallet Review is invalid.");
      }
      return envelope;
    };
    const walletExact = (operationId) =>
      callOperationTool(appMcp, "wallet_get_operation", { operationId });
    const awaitWalletState = (operationId, state, label) => waitFor(
      () => walletExact(operationId),
      (result) => readToolOperation(result).state === state,
      label,
    );
    const startWallet = async (envelope) => {
      const { review } = envelope.decision;
      const toolName =
        review.kind === "connect"
          ? "wallet_start_connection"
          : "wallet_start_disconnection";
      const result = await callOperationTool(
        appMcp,
        toolName,
        envelope,
      );
      const operation = readToolOperation(result);
      const encoded = result._meta?.["littlejohn/presentation-state"];
      if (typeof encoded !== "string") throw new TypeError("Packaged direct action omitted its canonical card presentation.");
      const presentation = JSON.parse(encoded);
      if (independentCanonicalJson(presentation) !== encoded ||
          presentation.state?.reference?.cardId !== envelope.cardId ||
          presentation.state.record?.operationId !== review.operationId ||
          presentation.state.record?.inputState !== "input_closed" || presentation.state.record.closeReason !== "submitted" ||
          typeof presentation.state.record.dispatchId !== "string" ||
          presentation.state.mode !== "static" || presentation.display?.kind !== "operation") {
        throw new TypeError("Packaged direct action did not carry its admitted saved state.");
      }
      if (
        operation.operationId !== review.operationId ||
        operation.review?.reviewDigest !== review.reviewDigest ||
        operation.initiatedBy !== "mcp_app"
      ) throw new TypeError("Packaged Wallet action lost its exact Review.");
      return operation;
    };

    const catalogAsset = tokenAsset(fakeRpc);
    const officialCandidateAsset = Object.freeze({
      kind: "erc20",
      chainId: fakeRpc.officialCandidate.chainId,
      address: fakeRpc.officialCandidate.address,
    });
    const explicitAccountAddress = "0x3333333333333333333333333333333333333333";
    const explicitAccount = Object.freeze({
      kind: "address",
      address: explicitAccountAddress,
    });
    const accountStateCounts = () => {
      const database = new DatabaseSync(resolve(dataDirectory, "littlejohn.sqlite3"), {
        readOnly: true,
      });
      try {
        const count = (sql) => {
          const row = /** @type {{ readonly count: number }} */ (
            database.prepare(sql).get()
          );
          return row.count;
        };
        return Object.freeze({
          accounts: count("SELECT COUNT(*) AS count FROM account"),
          selectionStates: count(
            "SELECT COUNT(*) AS count FROM account_token_selection_state",
          ),
          selections: count(
            "SELECT COUNT(*) AS count FROM account_token_selection",
          ),
        });
      } finally {
        database.close();
      }
    };

    const emptyAccountState = accountStateCounts();
    if (JSON.stringify(emptyAccountState) !== JSON.stringify({
      accounts: 0,
      selectionStates: 0,
      selections: 0,
    })) throw new TypeError("Packaged fresh account state is not empty.");
    // The real disconnected owner must preserve the Wallet failure through
    // Account Assets registration, HTTP normalization and installed CLI parsing.
    const unavailableAssetRpcCount = fakeRpc.calls.length;
    const unavailableAssetsCli = spawn(process.execPath, [
      resolve(prepared.installedPackageRoot, "dist/cli.js"),
      "read", "assets", "--active", "--json",
    ], { cwd: prepared.installRoot, env: environment, stdio: ["ignore", "pipe", "pipe"] });
    const unavailableAssetsOwner = ownChildProcess(
      unavailableAssetsCli, "Packaged unavailable active assets", childShutdownTimeoutMs,
    );
    const unavailableAssetOutput = [];
    unavailableAssetsCli.stdout.on("data", (chunk) => unavailableAssetOutput.push(Buffer.from(chunk)));
    unavailableAssetsCli.stderr.resume();
    const unavailableAssetsExit = new Promise((resolveExit) => {
      unavailableAssetsCli.once("close", (code, signal) => resolveExit({ code, signal }));
    });
    try {
      const outcome = await waitForPromise(
        Promise.race([unavailableAssetsExit, unavailableAssetsOwner.failure]),
        requestTimeoutMs, "Packaged unavailable active assets",
      );
      const failure = JSON.parse(Buffer.concat(unavailableAssetOutput).toString("utf8"));
      if (outcome.code !== 5 || outcome.signal !== null || failure.ok !== false ||
        failure.error?.code !== "wallet_not_connected" || failure.error?.category !== "wallet" ||
        fakeRpc.calls.length !== unavailableAssetRpcCount) {
        throw new TypeError("Packaged active assets lost its Wallet failure or issued a premature RPC read.");
      }
    } finally {
      await unavailableAssetsOwner.terminate();
    }
    for (const address of [
      explicitAccountAddress,
      expectedWalletAddress,
    ]) {
      const explicitAssets = assertAccountAssetCollection(
        (await firstMcp.callTool("account_list_assets", {
          account: { kind: "address", address },
        })).structuredContent,
        fakeRpc,
        [],
        address,
      );
      if (explicitAssets.nextCursor !== null) {
        throw new TypeError("Unretained explicit account produced a cursor.");
      }
    }
    if (JSON.stringify(accountStateCounts()) !== JSON.stringify(emptyAccountState)) {
      throw new TypeError("Explicit account reads retained account state.");
    }

    const explicitAddReviewResult = await appMcp.callTool(
      "token_start_selection_change_review",
      { kind: "add", account: explicitAccount, asset: officialCandidateAsset },
    );
    const explicitAddDecision = await openPackagedCardReview(
      appMcp,
      explicitAddReviewResult,
      "Packaged explicit token-add Review",
    );
    const explicitAdd = readToolOperation(await callOperationTool(
      appMcp,
      "token_add_selection",
      explicitAddDecision,
    ));
    assertTokenSelectionDetail(
      explicitAdd.result?.selection,
      fakeRpc,
      fakeRpc.officialCandidate,
      true,
      explicitAccountAddress,
    );
    if (JSON.stringify(accountStateCounts()) !== JSON.stringify({
      accounts: 1,
      selectionStates: 1,
      selections: 1,
    })) throw new TypeError("Confirmed explicit Token addition did not atomically retain its account.");

    const initializedExplicitAssets = assertAccountAssetCollection(
      (await firstMcp.callTool("account_list_assets", {
        account: explicitAccount,
      })).structuredContent,
      fakeRpc,
      fakeRpc.defaultTokens,
      explicitAccountAddress,
    );
    if (initializedExplicitAssets.nextCursor === null) {
      throw new TypeError("Retained explicit account omitted its additional selection cursor.");
    }
    const continuedExplicitAssets = assertAccountAssetCollection(
      (await firstMcp.callTool("account_list_assets", {
        account: explicitAccount,
        cursor: initializedExplicitAssets.nextCursor,
      })).structuredContent,
      fakeRpc,
      [fakeRpc.officialCandidate],
      explicitAccountAddress,
    );
    if (
      continuedExplicitAssets.nextCursor !== null ||
      independentCanonicalJson(continuedExplicitAssets.viewRevision) !==
        independentCanonicalJson(initializedExplicitAssets.viewRevision)
    ) throw new TypeError("Packaged explicit account continuation lost its terminal position or revision.");
    if (JSON.stringify(accountStateCounts()) !== JSON.stringify({
      accounts: 1,
      selectionStates: 1,
      selections: 6,
    })) throw new TypeError("Retained explicit account did not initialize exact defaults.");
    findTokenSelection(
      (await firstMcp.callTool("token_list_selections", {
        account: explicitAccount,
      })).structuredContent,
      fakeRpc.officialCandidate,
      true,
      explicitAccountAddress,
    );
    const explicitTokenCli = await runCommand(process.execPath, [
      resolve(prepared.installedPackageRoot, "dist/cli.js"),
      "token",
      "list",
      "--address",
      explicitAccountAddress,
      "--json",
    ], { cwd: prepared.installRoot, env: environment, output: "capture" });
    findTokenSelection(
      JSON.parse(explicitTokenCli.stdout.toString("utf8")),
      fakeRpc.officialCandidate,
      true,
      explicitAccountAddress,
    );
    const explicitAssetsCli = await runCommand(process.execPath, [
      resolve(prepared.installedPackageRoot, "dist/cli.js"),
      "read",
      "assets",
      "--address",
      explicitAccountAddress,
      "--limit",
      "5",
      "--json",
    ], { cwd: prepared.installRoot, env: environment, output: "capture" });
    assertAccountAssetCollection(
      JSON.parse(explicitAssetsCli.stdout.toString("utf8")),
      fakeRpc,
      fakeRpc.defaultTokens,
      explicitAccountAddress,
    );

    const cancellableReview = await walletReview("connect");
    const cancellableStart = await startWallet(cancellableReview);
    const cancellableActive = await awaitWalletState(
      cancellableStart.operationId,
      "awaiting_wallet_approval",
      "Packaged cancellable Wallet connection",
    );
    const cancellableOperation = readToolOperation(cancellableActive);
    const resultDescriptor =
      cancellableActive?._meta?.["littlejohn/operation-tool-result"];
    const privateQr = cancellableActive?._meta?.["littlejohn/wallet-operation-qr"];
    if (
      !hasExactObjectKeys(privateQr, ["kind", "operationId", "qr", "resultSha256"]) ||
      privateQr.kind !== "wallet_operation_qr" ||
      privateQr.operationId !== cancellableOperation.operationId ||
      privateQr.resultSha256 !== resultDescriptor.resultSha256 ||
      typeof privateQr.qr?.size !== "number" ||
      privateQr.qr.rows?.length !== privateQr.qr.size ||
      JSON.stringify(cancellableActive.structuredContent).includes("\"qr\"")
    ) throw new TypeError("Packaged Wallet QR did not remain View-private.");
    await callOperationTool(appMcp, "wallet_cancel_operation", {
      operationId: cancellableOperation.operationId,
      reviewDigest: cancellableOperation.review.reviewDigest,
      expectedState: cancellableOperation.state,
      connectionRevision: cancellableOperation.review.precondition.connectionRevision,
    });
    const cancelledResult = await awaitWalletState(
      cancellableOperation.operationId,
      "cancelled",
      "Packaged Wallet cancellation",
    );
    if (
      readToolOperation(cancelledResult).result !== null ||
      JSON.stringify(cancelledResult).includes("\"qr\"")
    ) throw new TypeError("Packaged cancelled Wallet operation retained authority.");

    const connectionReview = await walletReview("connect");
    const connectionStart = await startWallet(connectionReview);
    await awaitWalletState(
      connectionStart.operationId,
      "awaiting_wallet_approval",
      "Packaged Wallet approval",
    );
    await owner.request("approve");
    const completedConnectionResult = await awaitWalletState(
      connectionStart.operationId,
      "completed",
      "Packaged connected Wallet operation",
    );
    const completedConnectionOperation = readToolOperation(completedConnectionResult);
    if (
      !hasExactObjectKeys(completedConnectionOperation.result, ["kind", "connectionId", "connectionRevision"]) ||
      completedConnectionOperation.result.kind !== "connected" ||
      typeof completedConnectionOperation.result.connectionId !== "string" ||
      !/^(?:0|[1-9][0-9]*)$/u.test(completedConnectionOperation.result.connectionRevision) ||
      JSON.stringify(completedConnectionResult).includes("\"qr\"")
    ) throw new TypeError("Packaged Wallet connection terminal result is invalid.");

    const cliOperationResult = await runCommand(process.execPath, [
      "--input-type=module",
      "--eval",
      packagedCliTtyLauncher,
      resolve(prepared.installedPackageRoot, "dist/cli.js"),
      "wallet",
      "operation",
      connectionStart.operationId,
      "--json",
    ], { cwd: prepared.installRoot, env: environment, output: "capture" });
    if (
      JSON.stringify(JSON.parse(cliOperationResult.stdout.toString("utf8"))) !==
      JSON.stringify(completedConnectionOperation)
    ) throw new TypeError("Packaged CLI did not read the exact App-created Wallet operation.");

    const firstConnection = await callSemanticRead(firstMcp, "wallet_get_connection");
    const firstConnectionData = firstConnection.structuredContent?.data;
    assertPackagedWalletConnection(firstConnectionData);
    if (firstConnectionData.connectionId !== completedConnectionOperation.result.connectionId) throw new TypeError("Packaged Wallet result does not identify its observed connection.");
    assertPackagedClaimsDigests(firstConnection.structuredContent, "Packaged Wallet connection");

    const walletOperationCount = () => {
      const database = new DatabaseSync(resolve(dataDirectory, "littlejohn.sqlite3"), {readOnly: true});
      try { return database.prepare("SELECT COUNT(*) AS count FROM wallet_operation").get()?.["count"]; }
      finally { database.close(); }
    };
    const operationsBeforeLocalInputs = walletOperationCount();
    const rpcBeforeLocalInputs = fakeRpc.calls.length;
    const currentConnectionResult = await appMcp.callTool("wallet_start_connection_change_review", {kind: "connect"});
    assertPackagedDataWithoutUi(currentConnectionResult, "Packaged no-op Wallet data");
    const currentConnection = canonicalSemanticToolContent(currentConnectionResult, "Packaged no-op Wallet data");
    if (currentConnectionResult._meta?.["littlejohn/operation-tool-result"] !== undefined ||
        !hasExactObjectKeys(currentConnection, ["status", "connectionId", "connectionRevision"]) || currentConnection.status !== "current_connection" ||
        currentConnection.connectionId !== firstConnectionData.connectionId || currentConnection.connectionRevision !== completedConnectionOperation.result.connectionRevision) {
      throw new TypeError("Packaged no-op Wallet result changed its compact confirmed facts.");
    }
    const noOpCard = await admitPackagedAppCreatingResult(appMcp,
      await appMcp.callTool("presentation_start_decision", {kind: "wallet", source: {kind: "new", input: {kind: "connect"}}}), "Packaged no-op Wallet card");
    if (noOpCard.presentation.state.record?.kind !== "read" || noOpCard.presentation.state.record.preparationState !== "completed" ||
        noOpCard.presentation.actions?.length !== 0 || noOpCard.presentation.display?.kind !== "snapshot" ||
        independentCanonicalJson(noOpCard.value) !== independentCanonicalJson(currentConnection)) throw new TypeError("Packaged no-op Wallet card admitted decision input.");

    const selectionResult = await callOperationTool(appMcp, "wallet_get_account_selection", {chainId: expectedChainId});
    assertPackagedDataWithoutUi(selectionResult, "Packaged local account selection data");
    const selection = selectionResult.structuredContent;
    const nativeAccount = {chainId: expectedChainId, address: expectedWalletAddress};
    if (!hasExactObjectKeys(selection, ["connectionId", "connectionRevision", "chainId", "selectionRevision", "account", "eligibleAccounts"]) ||
        selection.connectionId !== firstConnectionData.connectionId || selection.chainId !== expectedChainId || selection.selectionRevision !== "0" ||
        independentCanonicalJson(selection.account) !== independentCanonicalJson(nativeAccount) ||
        independentCanonicalJson(selection.eligibleAccounts) !== independentCanonicalJson([nativeAccount])) {
      throw new TypeError("Packaged account selection did not expose its complete eligible native scope.");
    }
    const selectionCard = await admitPackagedAppCreatingResult(appMcp,
      await appMcp.callTool("presentation_start_decision", {kind: "wallet_selection", source: {kind: "new", input: {chainId: expectedChainId}}}), "Packaged local account selection card");
    const selectionOpening = {cardId: selectionCard.reference.cardId, cardOpenRequestId: randomBytes(32).toString("base64url")};
    const selectionView = (await callOperationTool(appMcp, "presentation_start_view", selectionOpening)).structuredContent;
    if (selectionView.state?.record?.kind !== "wallet_selection" || selectionView.state.record.operationId !== null ||
        selectionView.state.record.expiresAt !== null || selectionView.state.record.inputState !== "input_pending" ||
        independentCanonicalJson(selectionCard.value) !== independentCanonicalJson(selection) ||
        selectionView.selection?.connectionId !== selection.connectionId || selectionView.selection.connectionRevision !== selection.connectionRevision ||
        selectionView.selection.selectionRevision !== "0" || !selectionView.actions?.includes("confirm")) {
      throw new TypeError("Packaged local selection did not preserve its original source/current revision boundary.");
    }
    const selectedResult = await callOperationTool(appMcp, "wallet_select_account", {...selectionOpening, decision: {
      connectionId: selection.connectionId, chainId: expectedChainId, account: nativeAccount,
      expectedConnectionRevision: selection.connectionRevision, expectedSelectionRevision: selectionView.selection.selectionRevision,
    }});
    const selected = selectedResult.structuredContent;
    const selectedStateText = selectedResult._meta?.["littlejohn/presentation-state"];
    const selectedState = typeof selectedStateText === "string" ? JSON.parse(selectedStateText) : undefined;
    if (!hasExactObjectKeys(selected, ["connectionId", "connectionRevision", "chainId", "account", "selectionRevision"]) ||
        selected.connectionId !== selection.connectionId || selected.connectionRevision !== selection.connectionRevision || selected.chainId !== expectedChainId ||
        selected.selectionRevision !== "1" || independentCanonicalJson(selected.account) !== independentCanonicalJson(nativeAccount) ||
        independentCanonicalJson(selectedState) !== selectedStateText || selectedState.state?.record?.operationId !== null ||
        selectedState.state.record.inputState !== "input_closed" || selectedState.state.record.closeReason !== "submitted" ||
        selectedState.state.record.outcome?.kind !== "wallet_selection" ||
        independentCanonicalJson(selectedState.state.record.outcome.value) !== independentCanonicalJson(selected)) {
      throw new TypeError("Packaged local account selection did not atomically publish its original card result.");
    }
    const afterPreference = (await callSemanticRead(appMcp, "wallet_get_connection")).structuredContent;
    if (independentCanonicalJson(afterPreference.data) !== independentCanonicalJson(firstConnectionData) ||
        walletOperationCount() !== operationsBeforeLocalInputs || fakeRpc.calls.length !== rpcBeforeLocalInputs) {
      throw new TypeError("Packaged local selection/no-op changed SDK facts, created an operation or issued a chain request.");
    }

    const secondMcp = await startNpxMcp(prepared, environment);
    mcpClients.push(secondMcp);
    const secondConnection = await secondMcp.callTool("wallet_get_connection");
    if (
      JSON.stringify(secondConnection.structuredContent?.data) !==
      JSON.stringify(firstConnectionData)
    ) throw new TypeError("Compatible MCP processes do not share one Wallet projection.");

    const stockTokenTradeHistory = await callSemanticRead(
      firstMcp,
      "market_get_stock_token_trade_history",
      { symbol: fakeRpc.stockTokenTradeHistory.symbol },
    );
    const stockTokenContent = canonicalSemanticToolContent(
      stockTokenTradeHistory,
      "Packaged Stock Token trade history",
      stockTokenTradeHistorySummary,
    );
    const stockTokenData = stockTokenContent.data;
    const tradeHistoryChartCandles = Array.isArray(stockTokenData?.positions)
      ? stockTokenData.positions.filter((position) => position.candle !== null)
      : [];
    if (
      stockTokenData?.status !== "available" ||
      stockTokenData.symbol !== fakeRpc.stockTokenTradeHistory.symbol ||
      stockTokenData.period?.count !== 1 ||
      stockTokenData.period?.unit !== "day" ||
      stockTokenData.officialAsset?.member?.contractAddress !==
        fakeRpc.stockTokenTradeHistory.tokenAddress ||
      stockTokenData.block?.blockHash !== fakeRpc.canonicalBlockReference.blockHash ||
      stockTokenData.coverage?.status !== "complete" ||
      stockTokenData.resolution?.label !== "15m" ||
      !Array.isArray(stockTokenData.positions) ||
      stockTokenData.positions.length !== 96 ||
      tradeHistoryChartCandles.length !== 1 ||
      tradeHistoryChartCandles[0]?.candle?.high?.numerator !== "2" ||
      tradeHistoryChartCandles[0]?.candle?.low?.numerator !== "1" ||
      tradeHistoryChartCandles[0]?.candle?.baseVolumeRaw !== "2" ||
      tradeHistoryChartCandles[0]?.candle?.quoteVolumeRaw !== "3" ||
      tradeHistoryChartCandles[0]?.candle?.tradeCount !== "2" ||
      [
        "candles",
        "detail",
        "reference",
        "mapping",
        "oraclePaused",
        "price",
        "history",
        "warnings",
        "execution",
      ]
        .some((field) => Object.hasOwn(stockTokenData, field)) ||
      independentCanonicalJson(stockTokenContent).toLowerCase().includes("chainlink")
    ) throw new TypeError("Packaged Stock Token trade-history result is invalid.");
    const stockTokenCli = await runCommand(process.execPath, [
      resolve(prepared.installedPackageRoot, "dist/cli.js"),
      "market",
      "stock-token-trade-history",
      fakeRpc.stockTokenTradeHistory.symbol,
      "--json",
    ], { cwd: prepared.installRoot, env: environment, output: "capture" });
    const stockTokenCliContent = JSON.parse(stockTokenCli.stdout.toString("utf8"));
    const conclusionMeaning = (content) => content?.evidence?.conclusions?.map((conclusion) => ({
      id: conclusion.id,
      status: conclusion.status,
      reason: conclusion.reason,
      freshness: {
        evaluatedAt: conclusion.freshness?.evaluatedAt,
        ruleId: conclusion.freshness?.ruleId,
        status: conclusion.freshness?.status,
      },
    }));
    if (
      stockTokenCliContent?.ok !== true ||
      independentCanonicalJson(stockTokenCliContent.data) !== independentCanonicalJson(stockTokenData) ||
      independentCanonicalJson(stockTokenCliContent.meta) !== independentCanonicalJson(stockTokenContent.meta) ||
      independentCanonicalJson(stockTokenCliContent.warnings) !==
        independentCanonicalJson(stockTokenContent.warnings) ||
      independentCanonicalJson(stockTokenCliContent.evidence?.coverage) !==
        independentCanonicalJson(stockTokenContent.evidence?.coverage) ||
      independentCanonicalJson(conclusionMeaning(stockTokenCliContent)) !==
        independentCanonicalJson(conclusionMeaning(stockTokenContent))
    ) throw new TypeError("Packaged Stock Token CLI changed the admitted result meaning.");
    assertPackagedClaimsDigests(stockTokenContent, "Packaged Stock Token trade history");
    assertPackagedClaimsDigests(stockTokenCliContent, "Packaged Stock Token CLI trade history");

    const publicInspection = await jsonResponse(await fetch(
      fixedOrigin + "/api/v1/token-inspections",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ asset: catalogAsset, block: { kind: "latest" } }),
        redirect: "error",
      },
    ));
    assertTokenInspection(publicInspection, fakeRpc);
    const mcpInspection = await callSemanticRead(firstMcp, "token_inspect_contract", {
      asset: catalogAsset,
      block: { kind: "latest" },
    });
    assertTokenInspection(mcpInspection.structuredContent, fakeRpc);

    const initialAssetRequestCount = fakeRpc.calls.length;
    const initialAssets = assertAccountAssetCollection(
      (await firstMcp.callTool("account_list_assets", {
        account: { kind: "active_wallet" },
      })).structuredContent,
      fakeRpc,
      fakeRpc.defaultTokens,
    );
    assertRpcRequestBudget(fakeRpc, initialAssetRequestCount, 71, "Initial account assets");
    if (initialAssets.nextCursor !== null) {
      throw new TypeError("Default initialization created unexpected account selections.");
    }

    const tokenAddReviewResult = await appMcp.callTool(
      "token_start_selection_change_review",
      { kind: "add", account: { kind: "active_wallet" }, asset: officialCandidateAsset },
    );
    const tokenAddDecision = await openPackagedCardReview(
      appMcp,
      tokenAddReviewResult,
      "Packaged token-add Review",
    );
    const tokenAdd = readToolOperation(await callOperationTool(
      appMcp,
      "token_add_selection",
      tokenAddDecision,
    ));
    if (
      tokenAdd.state !== "completed" ||
      tokenAdd.kind !== "add" ||
      tokenAdd.result?.selection?.selection?.included !== true
    ) throw new TypeError("Packaged token addition is invalid.");
    const addedSelection = assertTokenSelectionDetail(
      tokenAdd.result.selection,
      fakeRpc,
      fakeRpc.officialCandidate,
      true,
    );
    const exactTokenAdd = readToolOperation(await callOperationTool(
      appMcp,
      "token_get_operation",
      { operationId: tokenAdd.operationId },
    ));
    if (JSON.stringify(exactTokenAdd) !== JSON.stringify(tokenAdd)) {
      throw new TypeError("Packaged token operation is not immutable.");
    }
    findTokenSelection(
      (await firstMcp.callTool("token_list_selections", {
        account: { kind: "active_wallet" },
      })).structuredContent,
      fakeRpc.officialCandidate,
      true,
    );
    assertTokenSelectionDetail(
      (await firstMcp.callTool("token_get_selection", {
        account: { kind: "active_wallet" },
        asset: officialCandidateAsset,
      })).structuredContent,
      fakeRpc,
      fakeRpc.officialCandidate,
      true,
    );

    const tokenRemoveReviewResult = await appMcp.callTool(
      "token_start_selection_change_review",
      {
        kind: "remove",
        account: { kind: "active_wallet" },
        asset: officialCandidateAsset,
        expectedRevision: addedSelection.revision,
      },
    );
    const tokenRemoveDecision = await openPackagedCardReview(
      appMcp,
      tokenRemoveReviewResult,
      "Packaged token-remove Review",
    );
    const tokenTerminal = readToolOperation(await callOperationTool(
      appMcp,
      "token_remove_selection",
      tokenRemoveDecision,
    ));
    if (
      tokenTerminal.state !== "completed" ||
      tokenTerminal.kind !== "remove" ||
      tokenTerminal.result?.selection?.selection?.included !== false
    ) throw new TypeError("Packaged token removal is invalid.");
    findTokenSelection(
      (await secondMcp.callTool("token_list_selections", {
        account: { kind: "active_wallet" },
      })).structuredContent,
      fakeRpc.officialCandidate,
      false,
    );

    if (
      JSON.stringify([...invokedSemanticReadToolNames].sort()) !==
      JSON.stringify([...expectedSemanticReadToolNames].sort())
    ) throw new TypeError("Packaged MCP did not execute every semantic read tool.");

    const durableOperations = Object.freeze([
      Object.freeze({
        tool: "wallet_get_operation",
        operationId: completedConnectionOperation.operationId,
        value: completedConnectionOperation,
      }),
      Object.freeze({
        tool: "token_get_operation",
        operationId: tokenTerminal.operationId,
        value: tokenTerminal,
      }),
    ]);

    await Promise.all(mcpClients.splice(0).map((client) => client.close()));
    await owner.stop();
    const takeoverAcquiredAt = (await readFile(clockPath, "utf8")).trim();
    const acquiredSession = await deferred.request("open_owner_session");
    if (
      acquiredSession?.ownerState !== "owner" ||
      acquiredSession.identity?.profileId !== initialRuntimeIdentity.profileId ||
      acquiredSession.identity.ownerInstanceId === initialRuntimeIdentity.ownerInstanceId
    ) throw new TypeError("Packaged control-session acquisition did not take over the absent owner.");
    const restored = await publicWalletConnection(deferred);
    if (
      restored.ownerState !== "owner" ||
      restored.response?.body?.data?.status !== "connected"
    ) throw new TypeError("Deferred packaged process did not restore the Wallet session.");
    const restoredRuntimeIdentity = await readPackagedRuntimeIdentity(prepared.packageIdentity);
    if (
      restoredRuntimeIdentity.profileId !== initialRuntimeIdentity.profileId ||
      restoredRuntimeIdentity.configurationMac !== initialRuntimeIdentity.configurationMac ||
      restoredRuntimeIdentity.ownerInstanceId === initialRuntimeIdentity.ownerInstanceId ||
      BigInt(restoredRuntimeIdentity.ownerRevision) <=
        BigInt(initialRuntimeIdentity.ownerRevision)
    ) throw new TypeError("Compatible packaged takeover changed configuration identity.");

    const takeoverMcp = await startNpxMcp(prepared, environment, true);
    mcpClients.push(takeoverMcp);
    for (const durable of durableOperations) {
      const restoredOperation = readToolOperation(await callOperationTool(
        takeoverMcp,
        durable.tool,
        { operationId: durable.operationId },
      ));
      if (JSON.stringify(restoredOperation) !== JSON.stringify(durable.value)) {
        throw new TypeError("Packaged owner takeover changed a durable operation.");
      }
    }
    const restoredSelectionData = await takeoverMcp.callTool("token_list_selections", {account: {kind: "active_wallet"}});
    assertPackagedDataWithoutUi(restoredSelectionData, "Packaged restored Token selection data");
    findTokenSelection(restoredSelectionData.structuredContent, fakeRpc.officialCandidate, false);
    const restoredSelections = await admitPackagedAppCreatingResult(takeoverMcp,
      await takeoverMcp.callTool("presentation_start_read", {capabilityId: "token.selections", input: {account: {kind: "active_wallet"}}}),
      "Packaged explicit restored Token selection card");
    if (independentCanonicalJson(restoredSelections.resource.normalizedInput) !== independentCanonicalJson({account: {kind: "active_wallet"}, limit: 25, cursor: null}) ||
        independentCanonicalJson(restoredSelections.value) !== independentCanonicalJson(restoredSelectionData.structuredContent)) {
      throw new TypeError("Packaged Token read card did not consume one admitted normalized input/result.");
    }
    findTokenSelection(restoredSelections.value, fakeRpc.officialCandidate, false);
    await takeoverMcp.close();
    mcpClients.splice(mcpClients.indexOf(takeoverMcp), 1);

    await deferred.request("delete_session");
    const deleted = await waitFor(
      () => publicWalletConnection(deferred),
      (result) => result.response?.body?.data?.status === "disconnected" &&
        result.response?.body?.data?.reason === "no_session",
      "Wallet-side deletion projection",
    );
    if (deleted.ownerState !== "owner") {
      throw new TypeError("Wallet-side deletion was not observed by the fixed owner.");
    }

    const endOfInputMcp = await startInstalledMcp(prepared, environment);
    mcpClients.push(endOfInputMcp);
    const endOfInputStatus = await endOfInputMcp.callTool("read_get_chain_status");
    if (endOfInputStatus.structuredContent?.data?.chainId !== expectedChainId) {
      throw new TypeError("Installed MCP end-of-input proof did not complete its request.");
    }
    await assertFixedPortOwned();
    await endOfInputMcp.closeInputAndWaitForTermination();
    mcpClients.splice(mcpClients.indexOf(endOfInputMcp), 1);
    const afterEofIdentity = await readPackagedRuntimeIdentity(prepared.packageIdentity);
    if (afterEofIdentity.ownerInstanceId !== restoredRuntimeIdentity.ownerInstanceId ||
        afterEofIdentity.ownerRevision !== restoredRuntimeIdentity.ownerRevision) {
      throw new TypeError("Foreground EOF changed the independent backend owner.");
    }
    const persistenceInspection = await deferred.stopAndInspectPersistence();
    assertPackagedPersistence(persistenceInspection, restoredRuntimeIdentity, {
      processId: deferred.processId,
      acquiredAt: takeoverAcquiredAt,
    });
    await assertFixedPortReleased();

    fakeRpc.assertNoUnexpectedMethods();
    const methods = fakeRpc.calls.map((call) => call.method);
    if ([
      "eth_call",
      "eth_chainId",
      "eth_getBalance",
      "eth_getBlockByHash",
      "eth_getBlockByNumber",
      "eth_getCode",
      "eth_getTransactionByHash",
      "eth_getTransactionReceipt",
    ].some((method) => !methods.includes(method))) {
      throw new TypeError("Packaged integration did not exercise the bounded RPC path.");
    }
    await fakeRpc.close();
  } finally {
    await Promise.allSettled(mcpClients.splice(0).map((client) => client.close()));
    await Promise.allSettled(workers.map((worker) => worker.stop()));
    await Promise.allSettled(workers.map((worker) => worker.terminate()));
    await fakeRpc.close().catch(() => undefined);
    await rm(workerPath, { force: true });
  }
};
