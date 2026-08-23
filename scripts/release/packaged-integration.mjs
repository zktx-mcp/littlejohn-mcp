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
import { pathToFileURL } from "node:url";

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
  "chain.status",
  "contract.inspect",
  "token.inspect",
  "transaction.inspect",
  "uniswap_v2.quote_exact_input",
  "wallet.connection",
]);
const expectedSemanticReadToolNames = Object.freeze([
  "market_get_stock_token_trade_history",
  "read_get_account_balance",
  "read_get_chain_status",
  "read_inspect_contract",
  "read_inspect_transaction",
  "token_inspect_contract",
  "uniswap_v2_quote_exact_input",
  "wallet_get_connection",
]);
const expectedToolNames = Object.freeze([
  "account_list_assets",
  "market_get_stock_token_trade_history",
  "read_get_account_balance",
  "read_get_chain_status",
  "read_inspect_contract",
  "read_inspect_transaction",
  "read_list_capabilities",
  "token_get_selection",
  "token_inspect_contract",
  "token_list_selections",
  "uniswap_v2_quote_exact_input",
  "wallet_get_connection",
]);
const expectedAppToolNames = Object.freeze([
  ...expectedToolNames,
  "presentation_get_snapshot",
  "presentation_get_snapshot_chunk",
  "token_add_selection",
  "token_get_operation",
  "token_get_selection_change_review",
  "token_remove_selection",
  "wallet_cancel_operation",
  "wallet_get_connection_change_review",
  "wallet_get_operation",
  "wallet_start_connection",
  "wallet_start_disconnection",
]);
const exactPackagedToolSchemaNames = Object.freeze([
  "read_get_chain_status",
  "wallet_get_connection",
]);
const expectedExactPackagedToolSchemaBundleSha256 =
  "21ad6a6f65023f912c0f682b7cf02f76b53c0e78e153da6eb08f26e9d99796c3";

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

class RawMcpClient {
  constructor(ownership, expectedServerIdentity, appConnection = false) {
    this.child = ownership.child;
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
    this.child.once("exit", (code, signal) => {
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

const readPackagedRuntimeIdentity = async () => {
  const challenge = randomBytes(32).toString("base64url");
  const response = await fetch(`${fixedOrigin}/api/v1/runtime-identity`, {
    headers: { [identityChallengeHeaderName]: challenge },
    redirect: "error",
  });
  const identity = await jsonResponse(response);
  const expectedFields = [
    "challenge",
    "configurationMac",
    "ownerInstanceId",
    "ownerRevision",
    "profileId",
    "proof",
  ];
  if (
    typeof identity !== "object" ||
    identity === null ||
    Array.isArray(identity) ||
    JSON.stringify(Object.keys(identity).sort()) !== JSON.stringify(expectedFields) ||
    identity.challenge !== challenge ||
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

const canonicalSemanticToolContent = (toolResult, label) => {
  const structured = toolResult?.structuredContent;
  if (
    typeof structured !== "object" ||
    structured === null ||
    Array.isArray(structured) ||
    canonicalToolText(toolResult) !== JSON.stringify(structured)
  ) throw new TypeError(`${label} text and structured content differ.`);
  return structured;
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
      snapshotId: descriptor.snapshotId,
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

const admitPackagedAppCreatingResult = async (client, result, label) => {
  const content = result?.content;
  const resource = result?._meta?.["littlejohn/presentation-snapshot"];
  const descriptor = resource?.descriptor;
  const text = content?.[0];
  const link = content?.[1];
  const value = result?.structuredContent;
  const resultText = independentCanonicalJson(value);
  const inputText = independentCanonicalJson(resource?.normalizedInput);
  if (
    !Array.isArray(content) ||
    content.length !== 2 ||
    text?.type !== "text" ||
    text.text !== resultText ||
    link?.type !== "resource_link" ||
    link?.uri !== descriptor?.snapshotUri ||
    resource?.kind !== "presentation_snapshot_resource" ||
    descriptor?.resultUtf8Bytes !== Buffer.byteLength(resultText, "utf8") ||
    descriptor?.resultSha256 !== createHash("sha256").update(resultText, "utf8").digest("hex") ||
    descriptor?.inputUtf8Bytes !== Buffer.byteLength(inputText, "utf8") ||
    descriptor?.inputSha256 !== createHash("sha256").update(inputText, "utf8").digest("hex")
  ) throw new TypeError(`${label} creating result is invalid.`);
  const exactResource = await client.readResource(link.uri);
  if (
    exactResource?.uri !== link.uri ||
    exactResource?.mimeType !== "application/json" ||
    exactResource?.text !== independentCanonicalJson(resource)
  ) throw new TypeError(`${label} snapshot resource is invalid: ${independentCanonicalJson({
    actualKind: (() => {
      try { return JSON.parse(exactResource?.text)?.kind ?? null; }
      catch { return null; }
    })(),
    actualReason: (() => {
      try { return JSON.parse(exactResource?.text)?.reason ?? null; }
      catch { return null; }
    })(),
    mimeType: exactResource?.mimeType ?? null,
    sameText: exactResource?.text === independentCanonicalJson(resource),
    sameUri: exactResource?.uri === link.uri,
  })}`);
  return Object.freeze({
    descriptor,
    link,
    resource,
    value,
  });
};

const assertPackagedReviewWithoutServerTools = async (
  client,
  packagedHtml,
  moduleRoot,
) => {
  const reviewResult = await client.callTool(
    "wallet_get_connection_change_review",
    { kind: "connect" },
  );
  const reviewSnapshot = await admitPackagedAppCreatingResult(
    client,
    reviewResult,
    "Packaged no-serverTools Wallet Review",
  );
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
    await bridge.sendToolResult(reviewResult);
    await waitFor(
      () => Promise.resolve(view.document.body.textContent),
      (text) => text.includes("Direct controls unavailable"),
      "Packaged no-serverTools Review presentation",
    );
    const text = view.document.body.textContent;
    if (
      !text.includes("Connect the external wallet") ||
      text.includes("Little John could not display this result") ||
      view.document.querySelectorAll("button").length !== 0 ||
      viewToolCalls !== 0
    ) throw new TypeError("Packaged no-serverTools View lost the read-only Review boundary.");
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
  const names = tools.map((tool) => tool.name).sort();
  if (JSON.stringify(names) !== JSON.stringify([...expectedAppToolNames].sort())) {
    throw new TypeError("Packaged MCP App tool registry is incomplete.");
  }
  const readTool = tools.find((tool) => tool.name === "wallet_get_connection");
  const snapshotTool = tools.find((tool) => tool.name === "presentation_get_snapshot");
  const chunkTool = tools.find((tool) => tool.name === "presentation_get_snapshot_chunk");
  const resourceUri = readTool?._meta?.ui?.resourceUri;
  if (
    typeof resourceUri !== "string" ||
    !resourceUri.startsWith("ui://littlejohn/presentation/") ||
    JSON.stringify(readTool?._meta?.ui?.visibility) !== JSON.stringify(["model"]) ||
    JSON.stringify(snapshotTool?._meta?.ui?.visibility) !== JSON.stringify(["model"]) ||
    snapshotTool?._meta?.ui?.resourceUri !== resourceUri ||
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

  const creatingResult = await client.callTool("market_get_stock_token_trade_history", {
    symbol: fakeRpc.stockTokenTradeHistory.symbol,
    window: "7d",
  });
  const creating = await admitPackagedAppCreatingResult(
    client,
    creatingResult,
    "Packaged MCP App trade history",
  );
  const { descriptor, link, resource: snapshotResource } = creating;
  if (
    descriptor?.contractId !== "market.stock_token_trade_history" ||
    descriptor?.contractVersion !== "1" ||
    descriptor?.resultChunkCount !== 1 ||
    JSON.stringify(creatingResult).includes("\"candles\"")
  ) throw new TypeError(`Packaged MCP App creating result is invalid: ${independentCanonicalJson({
    contractId: descriptor?.contractId ?? null,
    contractVersion: descriptor?.contractVersion ?? null,
    containsCandles: JSON.stringify(creatingResult).includes("\"candles\""),
    resultChunkCount: descriptor?.resultChunkCount ?? null,
    snapshotKind: snapshotResource?.kind ?? null,
  })}`);

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
  if (
    independentCanonicalJson(reconstructed) !== independentCanonicalJson(creating.value) ||
    reconstructed.status !== "available" ||
    reconstructed.symbol !== fakeRpc.stockTokenTradeHistory.symbol ||
    reconstructed.window !== "7d" ||
    !Array.isArray(reconstructed.chart?.positions) ||
    reconstructed.chart.positions.length !== 169
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
    selection.account.address !== expectedWalletAddress ||
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

const assertTokenSelectionDetail = (value, fakeRpc, token, included) => {
  const selection = assertTokenSelection(value?.selection, token, included);
  if (included && value.historicalInspection !== null) {
    assertTokenInspection(value.historicalInspection, Object.freeze({ ...fakeRpc, token }));
  }
  return selection;
};

const findTokenSelection = (value, token, included) => {
  if (
    typeof value !== "object" ||
    value === null ||
    !Array.isArray(value.selections) ||
    !Object.hasOwn(value, "nextCursor")
  ) throw new TypeError("Packaged token selection page is invalid.");
  const selection = value.selections.find((entry) => entry?.asset?.address === token.address);
  return assertTokenSelection(selection, token, included);
};

const assertAccountAssetCollection = (value, fakeRpc, expectedTokens) => {
  if (
    value?.account?.chainId !== fakeRpc.token.chainId ||
    value.account.address !== expectedWalletAddress ||
    value.block?.blockHash !== fakeRpc.canonicalBlockReference.blockHash ||
    value.native?.rawBalance !== fakeRpc.nativeBalanceRaw ||
    !Array.isArray(value.assets) ||
    value.assets.length !== expectedTokens.length ||
    expectedTokens.some((token, index) => {
      const asset = value.assets[index];
      return asset?.selection?.asset?.address !== token.address ||
        asset.selection.account?.address !== expectedWalletAddress ||
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
  const integrationRoot = resolve(prepared.workspace, "integration");
  const dataDirectory = resolve(integrationRoot, "state");
  const clockPath = resolve(integrationRoot, "clock.txt");
  const workerPath = resolve(prepared.installRoot, "release-owner-worker.mjs");
  await mkdir(integrationRoot, { recursive: true, mode: 0o700 });
  await writeFile(clockPath, `${new Date().toISOString()}\n`, { mode: 0o600 });
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
    const initialRuntimeIdentity = await readPackagedRuntimeIdentity();
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
    const unchangedRuntimeIdentity = await readPackagedRuntimeIdentity();
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
      invokedSemanticReadToolNames.add(name);
      return result;
    };
    const tools = await firstMcp.listTools();
    const names = tools.map((tool) => tool.name).sort();
    if (JSON.stringify(names) !== JSON.stringify([...expectedToolNames].sort())) {
      throw new TypeError("Packaged MCP tool registry is incomplete.");
    }
    if (tools.some((tool) =>
      typeof tool?.inputSchema !== "object" ||
      tool.inputSchema === null ||
      typeof tool?.outputSchema !== "object" ||
      tool.outputSchema === null
    )) throw new TypeError("Packaged MCP tools do not expose complete canonical schemas.");
    const exactSchemaTools = exactPackagedToolSchemaNames.map((name) =>
      tools.find((tool) => tool.name === name));
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
        entry?.maximumSuccessUtf8Bytes !== 8_388_607 ||
        !Array.isArray(entry?.failureCodes) ||
        entry.failureCodes.filter((code) => code === "result_too_large").length !== 1)
    ) throw new TypeError("Packaged MCP capability catalog is not the exact canonical set.");
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

    const contractInspection = await callSemanticRead(firstMcp, "read_inspect_contract", {
      address: fakeRpc.semanticReads.contract.address,
      block: { kind: "latest" },
    });
    const contractContent = canonicalSemanticToolContent(
      contractInspection,
      "Packaged MCP contract inspection",
    );
    assertPackagedClaimsDigests(contractContent, "Packaged MCP contract inspection");
    if (
      contractContent.data?.analysis?.target !== fakeRpc.semanticReads.contract.address ||
      contractContent.data.analysis.block?.blockHash !== fakeRpc.canonicalBlockReference.blockHash ||
      contractContent.data.analysis.targetRuntimeCode?.byteLength !==
        fakeRpc.semanticReads.contract.byteLength ||
      contractContent.data.analysis.targetRuntimeCode?.codeHash !==
        fakeRpc.semanticReads.contract.codeHash ||
      contractContent.data?.runtimeCode !== fakeRpc.semanticReads.contract.runtimeCode ||
      JSON.stringify(contractContent.evidence?.conclusions?.map(({ id }) => id)) !==
        JSON.stringify([
          "account_observed",
          "contract_controls_observed",
          "contract_deployment_observed",
          "contract_source_checked",
        ]) ||
      contractContent.evidence?.coverage?.status !== "partial"
    ) throw new TypeError("Packaged MCP contract inspection is invalid.");

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
      const result = await appMcp.callTool("wallet_get_connection_change_review", { kind });
      const value = (await admitPackagedAppCreatingResult(
        appMcp,
        result,
        "Packaged Wallet Review",
      )).value;
      if (value?.status !== "review" || value.review?.kind !== kind) {
        throw new TypeError("Packaged Wallet Review is invalid.");
      }
      return value.review;
    };
    const walletExact = (operationId) =>
      callOperationTool(appMcp, "wallet_get_operation", { operationId });
    const awaitWalletState = (operationId, state, label) => waitFor(
      () => walletExact(operationId),
      (result) => readToolOperation(result).state === state,
      label,
    );
    const startWallet = async (review) => {
      const toolName =
        review.kind === "connect"
          ? "wallet_start_connection"
          : "wallet_start_disconnection";
      const result = await callOperationTool(
        appMcp,
        toolName,
        { review, initiatedBy: "mcp_app" },
      );
      const operation = readToolOperation(result);
      if (
        operation.operationId !== review.operationId ||
        operation.review?.reviewDigest !== review.reviewDigest ||
        operation.initiatedBy !== "mcp_app"
      ) throw new TypeError("Packaged Wallet action lost its exact Review.");
      return operation;
    };

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
      completedConnectionOperation.result?.outcome !== "connected" ||
      completedConnectionOperation.result.connection?.address !== expectedWalletAddress ||
      completedConnectionOperation.result.connection?.chainId !== expectedChainId ||
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
    if (
      firstConnectionData?.status !== "connected" ||
      firstConnectionData.chainId !== expectedChainId ||
      firstConnectionData.address !== expectedWalletAddress
    ) throw new TypeError("Packaged Wallet connection read is invalid.");
    assertPackagedClaimsDigests(firstConnection.structuredContent, "Packaged Wallet connection");

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
      { symbol: fakeRpc.stockTokenTradeHistory.symbol, window: "1d" },
    );
    const stockTokenContent = canonicalSemanticToolContent(
      stockTokenTradeHistory,
      "Packaged Stock Token trade history",
    );
    const tradeHistoryChartCandles = Array.isArray(stockTokenContent.chart?.positions)
      ? stockTokenContent.chart.positions.filter((position) => position.candle !== null)
      : [];
    if (
      stockTokenContent.status !== "available" ||
      stockTokenContent.symbol !== fakeRpc.stockTokenTradeHistory.symbol ||
      stockTokenContent.officialAsset?.member?.contractAddress !==
        fakeRpc.stockTokenTradeHistory.tokenAddress ||
      stockTokenContent.block?.blockHash !== fakeRpc.canonicalBlockReference.blockHash ||
      stockTokenContent.source?.quoteToken?.symbol !== "USDG" ||
      stockTokenContent.coverage?.status !== "partial" ||
      stockTokenContent.chart?.window !== "1d" ||
      stockTokenContent.chart?.source?.token?.address !==
        fakeRpc.stockTokenTradeHistory.tokenAddress ||
      stockTokenContent.chart?.source?.quoteToken?.symbol !== "USDG" ||
      !Array.isArray(stockTokenContent.chart?.positions) ||
      stockTokenContent.chart.positions.length !== 97 ||
      tradeHistoryChartCandles.length !== 2 ||
      tradeHistoryChartCandles[0]?.candle?.high?.numerator !== "463" ||
      tradeHistoryChartCandles[0]?.candle?.high?.denominator !== "1" ||
      tradeHistoryChartCandles[0]?.candle?.low?.numerator !== "925" ||
      tradeHistoryChartCandles[0]?.candle?.low?.denominator !== "4" ||
      tradeHistoryChartCandles[0]?.candle?.tokenVolumeRaw !== "2001" ||
      tradeHistoryChartCandles[0]?.candle?.quoteVolumeRaw !== "4001" ||
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
        .some((field) => Object.hasOwn(stockTokenContent, field)) ||
      independentCanonicalJson(stockTokenContent).toLowerCase().includes("chainlink")
    ) throw new TypeError("Packaged Stock Token trade-history result is invalid.");
    const stockTokenCli = await runCommand(process.execPath, [
      resolve(prepared.installedPackageRoot, "dist/cli.js"),
      "market",
      "stock-token-trade-history",
      fakeRpc.stockTokenTradeHistory.symbol,
      "--window",
      "1d",
      "--json",
    ], { cwd: prepared.installRoot, env: environment, output: "capture" });
    if (
      independentCanonicalJson(JSON.parse(stockTokenCli.stdout.toString("utf8"))) !==
      independentCanonicalJson(stockTokenContent)
    ) throw new TypeError("Packaged Stock Token CLI changed the canonical result.");

    const catalogAsset = tokenAsset(fakeRpc);
    const officialCandidateAsset = Object.freeze({
      kind: "erc20",
      chainId: fakeRpc.officialCandidate.chainId,
      address: fakeRpc.officialCandidate.address,
    });
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
      (await firstMcp.callTool("account_list_assets")).structuredContent,
      fakeRpc,
      fakeRpc.defaultTokens,
    );
    assertRpcRequestBudget(fakeRpc, initialAssetRequestCount, 71, "Initial account assets");
    if (initialAssets.nextCursor !== null) {
      throw new TypeError("Default initialization created unexpected account selections.");
    }

    const tokenAddReviewResult = await appMcp.callTool(
      "token_get_selection_change_review",
      { kind: "add", asset: officialCandidateAsset },
    );
    const tokenAddReview = (await admitPackagedAppCreatingResult(
      appMcp,
      tokenAddReviewResult,
      "Packaged token-add Review",
    )).value?.review;
    const tokenAdd = readToolOperation(await callOperationTool(
      appMcp,
      "token_add_selection",
      { review: tokenAddReview, initiatedBy: "mcp_app" },
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
      (await firstMcp.callTool("token_list_selections")).structuredContent,
      fakeRpc.officialCandidate,
      true,
    );
    assertTokenSelectionDetail(
      (await firstMcp.callTool("token_get_selection", {
        asset: officialCandidateAsset,
      })).structuredContent,
      fakeRpc,
      fakeRpc.officialCandidate,
      true,
    );

    const tokenRemoveReviewResult = await appMcp.callTool(
      "token_get_selection_change_review",
      {
        kind: "remove",
        asset: officialCandidateAsset,
        expectedRevision: addedSelection.revision,
      },
    );
    const tokenRemoveReview = (await admitPackagedAppCreatingResult(
      appMcp,
      tokenRemoveReviewResult,
      "Packaged token-remove Review",
    )).value?.review;
    const tokenTerminal = readToolOperation(await callOperationTool(
      appMcp,
      "token_remove_selection",
      { review: tokenRemoveReview, initiatedBy: "mcp_app" },
    ));
    if (
      tokenTerminal.state !== "completed" ||
      tokenTerminal.kind !== "remove" ||
      tokenTerminal.result?.selection?.selection?.included !== false
    ) throw new TypeError("Packaged token removal is invalid.");
    findTokenSelection(
      (await secondMcp.callTool("token_list_selections")).structuredContent,
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
    const restored = await publicWalletConnection(deferred);
    if (
      restored.ownerState !== "owner" ||
      restored.response?.body?.data?.status !== "connected"
    ) throw new TypeError("Deferred packaged process did not restore the Wallet session.");
    const restoredRuntimeIdentity = await readPackagedRuntimeIdentity();
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
    const restoredSelections = await admitPackagedAppCreatingResult(
      takeoverMcp,
      await takeoverMcp.callTool("token_list_selections"),
      "Packaged restored token selections",
    );
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

    const persistenceInspection = await deferred.stopAndInspectPersistence();
    assertPackagedPersistence(persistenceInspection, restoredRuntimeIdentity, {
      processId: deferred.processId,
      acquiredAt: takeoverAcquiredAt,
    });
    await assertFixedPortReleased();
    const endOfInputMcp = await startInstalledMcp(prepared, environment);
    mcpClients.push(endOfInputMcp);
    const endOfInputStatus = await endOfInputMcp.callTool("read_get_chain_status");
    if (endOfInputStatus.structuredContent?.data?.chainId !== expectedChainId) {
      throw new TypeError("Installed MCP end-of-input proof did not complete its request.");
    }
    await assertFixedPortOwned();
    await endOfInputMcp.closeInputAndWaitForTermination();
    mcpClients.splice(mcpClients.indexOf(endOfInputMcp), 1);
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
