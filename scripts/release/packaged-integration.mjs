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

import {
  initializeOwnedChild,
  ownChildProcess,
  waitForPromise,
} from "./child-process-lifecycle.mjs";
import { startFakeRpc } from "./fake-rpc.mjs";
import { renderPackagedOwnerWorkerSource } from "./packaged-owner-worker-source.mjs";
import { runCommand } from "./release-support.mjs";

const fixedOrigin = "http://127.0.0.1:46630";
const csrfHeaderName = "Littlejohn-CSRF-Token";
const identityChallengeHeaderName = "Littlejohn-Identity-Challenge";
const expectedChainId = "eip155:4663";
const expectedWalletAddress = "0x1111111111111111111111111111111111111111";
const requestTimeoutMs = 30_000;
const childShutdownTimeoutMs = 5_000;
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
  "market_get_reference_history",
  "market_get_reference_price",
  "market_get_watchlist",
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
  "market_add_watchlist_pair",
  "market_get_reference_history",
  "market_get_reference_price",
  "market_get_watchlist",
  "market_remove_watchlist_pair",
  "market_reorder_watchlist_pairs",
  "read_get_account_balance",
  "read_get_chain_status",
  "read_inspect_contract",
  "read_inspect_transaction",
  "read_list_capabilities",
  "token_cancel_operation",
  "token_get_operation",
  "token_get_selection",
  "token_inspect_contract",
  "token_list_selections",
  "token_start_addition",
  "token_start_removal",
  "uniswap_v2_quote_exact_input",
  "wallet_cancel_operation",
  "wallet_get_connection",
  "wallet_get_operation",
  "wallet_start_connection",
  "wallet_start_disconnection",
]);
const exactPackagedToolSchemaNames = Object.freeze([
  "read_get_chain_status",
  "wallet_get_connection",
]);
const expectedExactPackagedToolSchemaBundleSha256 =
  "cffa0580f7cbc5b0b7ae1c42bf4bba14e918ab0b127afbb74f24941dbdb96982";

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
  constructor(ownership, expectedServerIdentity) {
    this.child = ownership.child;
    this.ownership = ownership;
    this.expectedServerIdentity = expectedServerIdentity;
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = "";
    let buffer = "";
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const line = buffer.slice(0, newline).replace(/\r$/u, "");
        buffer = buffer.slice(newline + 1);
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
      capabilities: {},
      clientInfo: { name: "littlejohn-release-check", version: "1.0.0" },
    });
    assertPackagedMcpServerIdentity(result, this.expectedServerIdentity);
    await this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  async listTools() {
    const result = await this.request("tools/list", {});
    if (!Array.isArray(result?.tools)) throw new TypeError("Packaged MCP tool list is invalid.");
    return result.tools;
  }

  async callTool(name, arguments_ = {}) {
    const result = await this.request("tools/call", { name, arguments: arguments_ });
    if (result?.isError === true) {
      throw new Error(`Packaged MCP tool failed: ${name}: ${JSON.stringify(result.structuredContent)}`);
    }
    return result;
  }

  async close() {
    await this.ownership.terminate();
  }
}

const startNpxMcp = async (prepared, environment) => {
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
  const client = new RawMcpClient(ownership, prepared.packageIdentity);
  await initializeOwnedChild(
    ownership,
    () => client.initialize(),
    requestTimeoutMs,
    "Packaged MCP initialization",
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

const startToolResult = (toolResult) => {
  const result = toolResult?.structuredContent?.result;
  if (typeof result !== "object" || result === null) {
    throw new TypeError("MCP wallet start result is unavailable.");
  }
  if (toolResult.structuredContent?.displayUrl !== `${fixedOrigin}/`) {
    throw new TypeError("MCP wallet display URL is not the fixed browser root.");
  }
  return result;
};

const startedToolOperation = (toolResult) => {
  const result = startToolResult(toolResult);
  if (result.status !== "operation_started") {
    throw new TypeError("MCP wallet start did not create an operation.");
  }
  const operation = result.operation;
  if (typeof operation !== "object" || operation === null) {
    throw new TypeError("MCP wallet start operation is unavailable.");
  }
  return operation;
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

const operationIdFrom = (toolResult) => {
  const operationId = startedToolOperation(toolResult).operationId;
  if (typeof operationId !== "string") throw new TypeError("MCP wallet operation identity is unavailable.");
  return operationId;
};

const tokenStartOperation = (toolResult) => {
  const result = toolResult?.structuredContent?.result;
  if (
    typeof result !== "object" ||
    result === null ||
    typeof result.operation !== "object" ||
    result.operation === null ||
    toolResult.structuredContent?.displayUrl !== `${fixedOrigin}/`
  ) throw new TypeError("MCP token catalog start result is unavailable.");
  return result.operation;
};

const tokenAsset = (fakeRpc) => Object.freeze({
  kind: "erc20",
  chainId: fakeRpc.token.chainId,
  address: fakeRpc.token.address,
});

const assertTokenInspection = (inspection, fakeRpc) => {
  const asset = tokenAsset(fakeRpc);
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
    inspection.data.metadata.symbol.value !== fakeRpc.token.symbol
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

const assertBrowserAssets = async (shell) => {
  const assets = [...shell.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/gu)]
    .map((match) => match[1])
    .filter((value) => value !== undefined);
  if (assets.length === 0) throw new TypeError("Packaged browser shell has no compiled assets.");
  let javascript = "";
  for (const path of assets) {
    const asset = await fetch(`${fixedOrigin}${path}`, { redirect: "error" });
    if (asset.status !== 200) throw new TypeError(`Packaged browser asset failed: ${path}`);
    if (path.endsWith(".js")) javascript += await asset.text();
    else await asset.arrayBuffer();
  }
  if (javascript.includes("/api/v1/uniswap-v2-exact-input-quotes")) {
    throw new TypeError("Packaged browser bundle exposes a machine-only quote transport.");
  }
  if (
    !javascript.includes("/api/v1/contract-inspections") ||
    !javascript.includes("/api/v1/token-inspections") ||
    !javascript.includes("Analysis")
  ) {
    throw new TypeError("Packaged browser bundle omits contextual Analysis.");
  }
};

const browserSession = async () => {
  const page = await fetch(`${fixedOrigin}/`, { redirect: "error" });
  if (page.status !== 200) throw new TypeError("Packaged browser root did not load.");
  const shell = await page.text();
  const cookie = page.headers.get("set-cookie")?.split(";", 1)[0];
  const csrf = shell.match(/<meta name="littlejohn-csrf-token" content="([^"]+)"/u)?.[1];
  const csp = page.headers.get("content-security-policy");
  if (
    cookie === undefined ||
    csrf === undefined ||
    csp === null ||
    !csp.includes("default-src 'none'") ||
    /https?:\/\/(?!127\.0\.0\.1:46630)/u.test(shell) ||
    shell.includes("__LITTLEJOHN_CSRF_TOKEN__")
  ) throw new TypeError("Packaged browser root security metadata is invalid.");
  await assertBrowserAssets(shell);
  const unsupportedPage = await fetch(`${fixedOrigin}/unsupported`, {
    redirect: "error",
  });
  if (unsupportedPage.status !== 404) throw new TypeError("Packaged unknown page is available.");
  return Object.freeze({ cookie, csrf, shell });
};

const browserCurrent = (browser) => fetch(
  `${fixedOrigin}/api/v1/wallet/current-operation`,
  { headers: { Cookie: browser.cookie }, redirect: "error" },
);

const browserOperation = (operationId, browser) => fetch(
  `${fixedOrigin}/api/v1/wallet/operations/${operationId}`,
  { headers: { Cookie: browser.cookie }, redirect: "error" },
);

const browserStart = (operationId, kind, connectionRevision, browser) => fetch(
  `${fixedOrigin}/api/v1/wallet/operations`,
  {
    method: "POST",
    headers: {
      Cookie: browser.cookie,
      Origin: fixedOrigin,
      [csrfHeaderName]: browser.csrf,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      control: { operationId, interactionInterface: "web" },
      request: { kind, connectionRevision },
    }),
    redirect: "error",
  },
);

const browserStartFromCurrentState = async (kind, browser) => {
  const state = await jsonResponse(await browserCurrent(browser));
  if (typeof state?.connectionRevision !== "string") {
    throw new TypeError("Packaged browser connection revision is unavailable.");
  }
  const operationId = randomBytes(32).toString("base64url");
  const response = await browserStart(operationId, kind, state.connectionRevision, browser);
  if (response.status !== 200) {
    const problem = await response.json();
    const after = await jsonResponse(await browserCurrent(browser));
    throw new Error(
      `HTTP ${response.status}: ${JSON.stringify(problem)}; ` +
      `before=${JSON.stringify(state)}; after=${JSON.stringify(after)}`,
    );
  }
  const result = await jsonResponse(response);
  if (result.status === "operation_started" && result.operation?.operationId !== operationId) {
    throw new TypeError("Packaged browser start did not retain its operation identity.");
  }
  return Object.freeze({ state, result });
};

const browserConfirm = (operationId, revision, browser) => fetch(
  `${fixedOrigin}/api/v1/wallet/operations/${operationId}/confirmation`,
  {
    method: "POST",
    headers: {
      Cookie: browser.cookie,
      Origin: fixedOrigin,
      [csrfHeaderName]: browser.csrf,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ connectionRevision: revision }),
    redirect: "error",
  },
);

const browserCancel = (operationId, revision, browser) => fetch(
  `${fixedOrigin}/api/v1/wallet/operations/${operationId}/cancellation`,
  {
    method: "POST",
    headers: {
      Cookie: browser.cookie,
      Origin: fixedOrigin,
      [csrfHeaderName]: browser.csrf,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ connectionRevision: revision }),
    redirect: "error",
  },
);

const browserTokenCurrent = (browser) => fetch(
  `${fixedOrigin}/api/v1/token-catalog/current-operation`,
  { headers: { Cookie: browser.cookie }, redirect: "error" },
);

const unsupportedBrowserTokenResource = (browser) => fetch(
  `${fixedOrigin}/api/v1/token-catalog/unsupported`,
  {
    method: "POST",
    headers: {
      Cookie: browser.cookie,
      "Content-Type": "application/json",
    },
    body: "{}",
    redirect: "error",
  },
);

const browserAccountAssets = (browser) => fetch(
  `${fixedOrigin}/api/v1/account-assets/overview`,
  {
    headers: {
      Cookie: browser.cookie,
    },
    redirect: "error",
  },
);

const browserExactAccountAsset = (browser, token, viewRevision) => fetch(
  `${fixedOrigin}/api/v1/account-assets/${token.chainId}/${token.address}`,
  {
    method: "POST",
    headers: {
      Cookie: browser.cookie,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ viewRevision }),
    redirect: "error",
  },
);

const browserReferencePrice = (pairId, headers = {}) => fetch(
  `${fixedOrigin}/api/v1/reference-markets/price-queries`,
  {
    method: "POST",
    headers: {
      Origin: fixedOrigin,
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify({ pairId }),
    redirect: "error",
  },
);

const browserReferenceHistory = (pairId, window) => fetch(
  `${fixedOrigin}/api/v1/reference-markets/history-queries`,
  {
    method: "POST",
    headers: {
      Origin: fixedOrigin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ pairId, window }),
    redirect: "error",
  },
);

const browserReferenceWatchlistMutation = (path, body, browser) => fetch(
  `${fixedOrigin}${path}`,
  {
    method: "POST",
    headers: {
      Cookie: browser.cookie,
      Origin: fixedOrigin,
      [csrfHeaderName]: browser.csrf,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    redirect: "error",
  },
);

const assertReferenceWatchlist = (value, expectedPairIds) => {
  if (
    value?.account?.chainId !== expectedChainId ||
    value.account.address !== expectedWalletAddress ||
    typeof value.revision !== "string" ||
    !Array.isArray(value.entries) ||
    JSON.stringify(value.entries.map((entry) => entry?.pairId)) !== JSON.stringify(expectedPairIds)
  ) throw new TypeError("Packaged reference-market watchlist is invalid.");
  return value;
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

const assertAccountAssetOverview = (value, fakeRpc, expectedSelectedTokens) => {
  const officialTokens = [...fakeRpc.defaultTokens, fakeRpc.officialCandidate]
    .sort((left, right) =>
      left.assetUid < right.assetUid
        ? -1
        : left.assetUid > right.assetUid
          ? 1
          : left.address < right.address
            ? -1
            : left.address > right.address
              ? 1
              : 0);
  const selectedAddresses = new Set(expectedSelectedTokens.map((token) => token.address));
  if (
    selectedAddresses.size !== expectedSelectedTokens.length ||
    expectedSelectedTokens.some((token) =>
      !officialTokens.some((official) => official.address === token.address)) ||
    value?.account?.chainId !== fakeRpc.token.chainId ||
    value.account.address !== expectedWalletAddress ||
    value.block?.blockHash !== fakeRpc.canonicalBlockReference.blockHash ||
    value.native?.rawBalance !== fakeRpc.nativeBalanceRaw ||
    value.viewRevision?.officialSnapshotStatus !== "current" ||
    typeof value.viewRevision.officialSnapshotRevision !== "string" ||
    typeof value.viewRevision.selectionSetRevision !== "string" ||
    value.stockTokens?.status !== "current" ||
    !/^0x[0-9a-f]{64}$/u.test(value.stockTokens.candidateListDigest) ||
    !Array.isArray(value.stockTokens.members) ||
    value.stockTokens.members.length !== officialTokens.length ||
    officialTokens.some((token, index) => {
      const member = value.stockTokens.members[index];
      if (selectedAddresses.has(token.address)) {
        const asset = member?.status === "selected" ? member.asset : undefined;
        return asset?.selection?.asset?.address !== token.address ||
          asset.selection.account?.address !== expectedWalletAddress ||
          asset.selection.included !== true ||
          asset.amount?.raw !== token.accountBalanceRaw ||
          asset.requiredStandards?.block?.blockHash !==
            fakeRpc.canonicalBlockReference.blockHash;
      }
      const candidate = member?.status === "available_to_add"
        ? member.candidate
        : undefined;
      return candidate?.assetUid !== token.assetUid ||
        candidate.contractAddress !== token.address ||
        candidate.sourceName !== token.name ||
        candidate.sourceSymbol !== token.symbol;
    })
  ) throw new TypeError("Packaged account asset overview is invalid.");
  return value;
};

const assertUnavailableAccountAssetOverview = (
  value,
  fakeRpc,
  retainedSnapshotRevision,
) => {
  if (
    value?.account?.chainId !== fakeRpc.token.chainId ||
    value.account.address !== expectedWalletAddress ||
    value.block?.blockHash !== fakeRpc.canonicalBlockReference.blockHash ||
    value.native?.rawBalance !== fakeRpc.nativeBalanceRaw ||
    value.viewRevision?.officialSnapshotStatus !== "unavailable" ||
    value.viewRevision.officialSnapshotRevision !== retainedSnapshotRevision ||
    value.stockTokens?.status !== "unavailable" ||
    value.stockTokens.reason !== "source_unavailable"
  ) throw new TypeError("Packaged unavailable account asset overview is invalid.");
  return value;
};

const assertExactAccountAsset = (value, fakeRpc, token) => {
  if (
    value?.account?.chainId !== token.chainId ||
    value.account.address !== expectedWalletAddress ||
    value.block?.blockHash !== fakeRpc.canonicalBlockReference.blockHash ||
    value.asset?.selection?.asset?.address !== token.address ||
    value.asset.selection.account?.address !== expectedWalletAddress ||
    value.asset.selection.included !== true ||
    value.asset.amount?.raw !== token.accountBalanceRaw ||
    value.asset.amount?.uiAdjusted?.status !== "available" ||
    value.asset.amount.uiAdjusted.adjustedRaw !== (
      BigInt(token.accountBalanceRaw) * BigInt(token.currentMultiplier) /
      1_000_000_000_000_000_000n
    ).toString(10) ||
    value.totalSupply !== token.totalSupplyRaw ||
    value.standards?.asset?.address !== token.address ||
    value.standards.requiredErc8056?.currentMultiplier !== token.currentMultiplier
  ) throw new TypeError("Packaged exact account asset is invalid.");
  return value;
};

const browserTokenConfirm = (operationId, reviewDigest, browser) => fetch(
  `${fixedOrigin}/api/v1/token-catalog/operations/${operationId}/confirmation`,
  {
    method: "POST",
    headers: {
      Cookie: browser.cookie,
      Origin: fixedOrigin,
      [csrfHeaderName]: browser.csrf,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ reviewDigest }),
    redirect: "error",
  },
);

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

const internalOperation = (worker, operationId) => dispatch(worker, {
  requestClass: "local_control",
  method: "GET",
  path: `/api/v1/internal/control/wallet/operations/${operationId}`,
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
    const transactionInspection = await callSemanticRead(firstMcp, "read_inspect_transaction", {
      transactionHash: fakeRpc.semanticReads.transaction.transactionHash,
    });
    const transactionContent = canonicalSemanticToolContent(
      transactionInspection,
      "Packaged MCP transaction inspection",
    );
    assertPackagedClaimsDigests(transactionContent, "Packaged MCP transaction inspection");
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
    ) throw new TypeError("Packaged MCP transaction inspection is invalid.");

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
    const browser = await browserSession();
    const unauthorizedCurrent = await fetch(
      `${fixedOrigin}/api/v1/wallet/current-operation`,
      { redirect: "error" },
    );
    const unauthorizedCurrentProblem = await unauthorizedCurrent.json();
    if (
      unauthorizedCurrent.status !== 401 ||
      problemCode(unauthorizedCurrentProblem) !== "unauthorized"
    ) {
      throw new TypeError("Packaged browser wallet state is readable without session authority.");
    }

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
      cliStatus.data?.latestBlock?.blockHash !== `0x${"88".repeat(32)}`
    ) throw new TypeError("Packaged CLI chain status is invalid.");

    const {
      state: cancellableConnectionState,
      result: cancellableConnection,
    } = await browserStartFromCurrentState("connect", browser);
    if (
      cancellableConnectionState.status !== "absent" ||
      cancellableConnectionState.connection?.status !== "disconnected" ||
      cancellableConnection.status !== "operation_started" ||
      cancellableConnection.operation?.kind !== "connect" ||
      typeof cancellableConnection.operation?.operationId !== "string"
    ) throw new TypeError("Browser connection cancellation precondition is invalid.");
    const cancellablePresentation = await waitFor(
      async () => jsonResponse(await browserOperation(
        cancellableConnection.operation.operationId,
        browser,
      )),
      (value) => value.operation?.state === "awaiting_wallet_approval",
      "Browser connection cancellation operation",
    );
    const cancellationAccepted = await jsonResponse(await browserCancel(
      cancellableConnection.operation.operationId,
      cancellablePresentation.operation.connectionRevision,
      browser,
    ));
    if (
      cancellationAccepted.operationId !== cancellableConnection.operation.operationId ||
      cancellationAccepted.connectionRevision !== cancellablePresentation.operation.connectionRevision
    ) throw new TypeError("Browser cancellation did not retain the exact operation identity.");
    const cancelledConnection = (await waitFor(
      async () => jsonResponse(await browserOperation(
        cancellableConnection.operation.operationId,
        browser,
      )),
      (value) => value.operation?.state === "cancelled",
      "Browser connection cancellation",
    )).operation;
    if (cancelledConnection.state !== "cancelled") throw new TypeError("Browser cancellation did not settle.");
    const stateAfterCancellation = await jsonResponse(await browserCurrent(browser));
    if (
      stateAfterCancellation.status !== "absent" ||
      stateAfterCancellation.connection?.status !== "disconnected"
    ) throw new TypeError("Cancelled browser connection changed wallet state.");

    const started = await firstMcp.callTool("wallet_start_connection");
    const operationId = operationIdFrom(started);
    const serializedStart = JSON.stringify(started);
    for (const secretWord of [
      "pairing",
      "topic",
      "credential",
      "\"qr\"",
    ]) {
      if (serializedStart.includes(secretWord)) {
        throw new TypeError("Packaged MCP wallet start leaked private connection material.");
      }
    }
    const waiting = await waitFor(
      () => firstMcp.callTool("wallet_get_operation", { operationId }),
      (result) => readToolOperation(result).state === "awaiting_wallet_approval",
      "Wallet approval operation",
    );
    const waitingOperation = readToolOperation(waiting);
    const cliOperationResult = await runCommand(process.execPath, [
      "--input-type=module",
      "--eval",
      packagedCliTtyLauncher,
      resolve(prepared.installedPackageRoot, "dist/cli.js"),
      "wallet",
      "operation",
      operationId,
      "--json",
    ], { cwd: prepared.installRoot, env: environment, output: "capture" });
    const cliOperationText = cliOperationResult.stdout.toString("utf8").replace(/\n$/u, "");
    if (
      cliOperationText !== canonicalToolText(waiting) ||
      JSON.stringify(JSON.parse(cliOperationText)) !== JSON.stringify(waitingOperation)
    ) {
      throw new TypeError(
        "Packaged CLI did not preserve the MCP-created wallet operation exactly.",
      );
    }
    const browserState = await jsonResponse(await browserCurrent(browser));
    if (
      browserState.status !== "present" ||
      browserState.presentation?.operation?.operationId !== operationId ||
      browserState.presentation?.access !== "interactive"
    ) throw new TypeError("Packaged browser current-operation projection is invalid.");
    const qr = browserState.presentation;
    if (
      typeof qr.qr?.size !== "number" ||
      !Array.isArray(qr.qr?.rows) ||
      qr.qr.rows.length !== qr.qr.size
    ) throw new TypeError("Packaged browser QR projection is invalid.");
    for (const { method, path, status, headers } of [
      {
        method: "GET",
        path: `${fixedOrigin}/unsupported`,
        status: 404,
        headers: undefined,
      },
      {
        method: "GET",
        path: `${fixedOrigin}/api/v1/wallet/operations/${operationId}/unsupported`,
        status: 404,
        headers: undefined,
      },
      {
        method: "DELETE",
        path: `${fixedOrigin}/api/v1/wallet/operations/${operationId}`,
        status: 405,
        headers: { Cookie: browser.cookie },
      },
    ]) {
      const undeclared = await fetch(path, {
        method,
        ...(headers === undefined ? {} : { headers }),
        redirect: "error",
      });
      if (undeclared.status !== status) {
        throw new TypeError(
          `Packaged browser undeclared-resource status mismatch: ` +
          `${method} ${path} expected ${status}, received ${undeclared.status}.`,
        );
      }
    }

    await owner.request("approve");
    const completed = await waitFor(
      () => firstMcp.callTool("wallet_get_operation", { operationId }),
      (result) => readToolOperation(result).state === "completed",
      "Approved wallet operation",
    );
    if (readToolOperation(completed).result?.outcome !== "connected") {
      throw new TypeError("Packaged fake wallet approval did not connect.");
    }
    const completedBrowserOperation =
      await jsonResponse(await browserOperation(operationId, browser));
    if (
      completedBrowserOperation.operation?.state !== "completed" ||
      completedBrowserOperation.operation?.result?.outcome !== "connected"
    ) throw new TypeError("Packaged browser lost the completed connection result.");
    const firstConnection = await callSemanticRead(firstMcp, "wallet_get_connection");
    const firstConnectionData = firstConnection.structuredContent?.data;
    if (
      firstConnectionData?.status !== "connected" ||
      firstConnectionData.chainId !== expectedChainId ||
      firstConnectionData.address !== expectedWalletAddress ||
      !hasExactObjectKeys(firstConnectionData, [
        "approvedEvents",
        "approvedMethods",
        "address",
        "chainId",
        "expiresAt",
        "status",
      ])
    ) {
      throw new TypeError("Packaged MCP wallet connection is not connected.");
    }
    assertPackagedClaimsDigests(
      firstConnection.structuredContent,
      "Packaged MCP wallet connection",
    );
    const connectedBrowserState = await jsonResponse(await browserCurrent(browser));
    if (
      connectedBrowserState.status !== "absent" ||
      connectedBrowserState.connection?.status !== "connected" ||
      connectedBrowserState.connection.chainId !== expectedChainId ||
      connectedBrowserState.connection.address !== expectedWalletAddress ||
      !hasExactObjectKeys(connectedBrowserState.connection, [
        "approvedEvents",
        "approvedMethods",
        "address",
        "chainId",
        "expiresAt",
        "status",
      ])
    ) throw new TypeError("Packaged browser did not settle to the connected global wallet state.");

    const secondMcp = await startNpxMcp(prepared, environment);
    mcpClients.push(secondMcp);
    const secondConnection = await secondMcp.callTool("wallet_get_connection");
    if (
      JSON.stringify(secondConnection.structuredContent?.data) !==
      JSON.stringify(firstConnection.structuredContent?.data)
    ) throw new TypeError("Compatible MCP processes do not share one wallet projection.");

    const referencePair = fakeRpc.referenceMarkets.pairs[0];
    if (referencePair === undefined) throw new TypeError("Release reference pair is unavailable.");
    const selectedPricePage = await fetch(
      `${fixedOrigin}/prices/${referencePair.pairId}?window=30d`,
      { redirect: "error" },
    );
    if (
      selectedPricePage.status !== 200 ||
      selectedPricePage.headers.get("set-cookie") === null
    ) {
      throw new TypeError("Packaged selected Price location did not load with its admitted window.");
    }
    await selectedPricePage.arrayBuffer();
    const invalidSelectedPriceQuery = await fetch(
      `${fixedOrigin}/prices/${referencePair.pairId}?window=1d&window=30d`,
      { redirect: "error" },
    );
    const invalidSelectedPriceProblem = await invalidSelectedPriceQuery.json();
    if (
      invalidSelectedPriceQuery.status !== 400 ||
      invalidSelectedPriceQuery.headers.get("set-cookie") !== null ||
      problemCode(invalidSelectedPriceProblem) !== "invalid_input"
    ) {
      throw new TypeError(
        "Packaged selected Price location accepted a duplicate window or issued credentials.",
      );
    }
    const referencePrice = await callSemanticRead(firstMcp, "market_get_reference_price", {
      pairId: referencePair.pairId,
    });
    if (
      referencePrice.structuredContent?.status !== "current" ||
      referencePrice.structuredContent.pair?.pairId !== referencePair.pairId ||
      referencePrice.structuredContent.currentPrice?.numerator !== "96692202731" ||
      referencePrice.structuredContent.currentPrice?.denominator !== "50000000" ||
      referencePrice.structuredContent.block?.blockHash !== fakeRpc.canonicalBlockReference.blockHash
    ) throw new TypeError("Packaged reference price is invalid.");
    const browserPrice = await jsonResponse(await browserReferencePrice(referencePair.pairId));
    if (JSON.stringify(browserPrice) !== JSON.stringify(referencePrice.structuredContent)) {
      throw new TypeError("Packaged browser and MCP reference prices differ.");
    }
    const credentialedReferencePrice = await browserReferencePrice(referencePair.pairId, {
      Cookie: browser.cookie,
    });
    const credentialedReferenceProblem = await credentialedReferencePrice.json();
    if (
      credentialedReferencePrice.status !== 401 ||
      problemCode(credentialedReferenceProblem) !== "unauthorized"
    ) throw new TypeError("Public reference price accepted browser credentials.");

    const referenceHistory = await callSemanticRead(firstMcp, "market_get_reference_history", {
      pairId: referencePair.pairId,
      window: "1d",
    });
    const referenceHistoryContent = referenceHistory.structuredContent;
    if (
      referenceHistoryContent?.status !== "partial" ||
      referenceHistoryContent.pair?.pairId !== referencePair.pairId ||
      referenceHistoryContent.window !== "1d" ||
      referenceHistoryContent.coverage?.basis !== "observed_rounds" ||
      JSON.stringify(Object.keys(referenceHistoryContent.coverage).sort()) !==
        JSON.stringify(["basis", "emptyBucketStarts", "limitations", "requestedEnd", "requestedStart"]) ||
      JSON.stringify(referenceHistoryContent.coverage.limitations) !==
        JSON.stringify(["source_history_not_exhaustive", "phase_boundary"]) ||
      !Array.isArray(referenceHistoryContent.candles) ||
      referenceHistoryContent.candles.length !== 1 ||
      Object.hasOwn(referenceHistoryContent.candles[0] ?? {}, "volume") ||
      !Array.isArray(referenceHistoryContent.warnings) ||
      !referenceHistoryContent.warnings.includes("partial_history")
    ) throw new TypeError("Packaged reference history is invalid.");
    const browserHistory = await jsonResponse(await browserReferenceHistory(referencePair.pairId, "1d"));
    if (JSON.stringify(browserHistory) !== JSON.stringify(referenceHistoryContent)) {
      throw new TypeError("Packaged browser and MCP reference histories differ.");
    }
    for (const [command, expected] of [
      [["market", "price", referencePair.pairId, "--json"], referencePrice.structuredContent],
      [["market", "history", referencePair.pairId, "--window", "1d", "--json"], referenceHistoryContent],
    ]) {
      const result = await runCommand(process.execPath, [
        resolve(prepared.installedPackageRoot, "dist/cli.js"),
        ...command,
      ], { cwd: prepared.installRoot, env: environment, output: "capture" });
      if (JSON.stringify(JSON.parse(result.stdout.toString("utf8"))) !== JSON.stringify(expected)) {
        throw new TypeError("Packaged CLI and MCP reference reads differ.");
      }
    }

    const initialReferenceWatchlist = assertReferenceWatchlist(
      (await callSemanticRead(firstMcp, "market_get_watchlist")).structuredContent,
      [],
    );
    const cliReferenceWatchlist = await runCommand(process.execPath, [
      resolve(prepared.installedPackageRoot, "dist/cli.js"),
      "market",
      "watchlist",
      "--json",
    ], { cwd: prepared.installRoot, env: environment, output: "capture" });
    assertReferenceWatchlist(
      JSON.parse(cliReferenceWatchlist.stdout.toString("utf8")),
      [],
    );
    const addedReferenceWatchlist = assertReferenceWatchlist(
      await jsonResponse(await browserReferenceWatchlistMutation(
        "/api/v1/reference-market-watchlist/entry-additions",
        { pairId: referencePair.pairId, expectedRevision: initialReferenceWatchlist.revision },
        browser,
      )),
      [referencePair.pairId],
    );
    const reorderedReferenceWatchlist = assertReferenceWatchlist(
      (await firstMcp.callTool("market_reorder_watchlist_pairs", {
        pairIds: [referencePair.pairId],
        expectedRevision: addedReferenceWatchlist.revision,
      })).structuredContent,
      [referencePair.pairId],
    );
    if (reorderedReferenceWatchlist.revision !== addedReferenceWatchlist.revision) {
      throw new TypeError("Packaged no-op watchlist reorder changed its revision.");
    }
    const catalogAsset = tokenAsset(fakeRpc);
    const officialCandidateAsset = Object.freeze({
      kind: "erc20",
      chainId: fakeRpc.officialCandidate.chainId,
      address: fakeRpc.officialCandidate.address,
    });
    const publicInspectionResponse = await fetch(`${fixedOrigin}/api/v1/token-inspections`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ asset: catalogAsset, block: { kind: "latest" } }),
      redirect: "error",
    });
    const publicInspection = await jsonResponse(publicInspectionResponse);
    assertTokenInspection(publicInspection, fakeRpc);
    const credentialedPublicInspection = await fetch(`${fixedOrigin}/api/v1/token-inspections`, {
      method: "POST",
      headers: {
        Cookie: browser.cookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ asset: catalogAsset, block: { kind: "latest" } }),
      redirect: "error",
    });
    const credentialedPublicProblem = await credentialedPublicInspection.json();
    if (
      credentialedPublicInspection.status !== 401 ||
      problemCode(credentialedPublicProblem) !== "unauthorized"
    ) throw new TypeError("Public token inspection accepted browser authority.");

    const mcpInspection = await callSemanticRead(firstMcp, "token_inspect_contract", {
      asset: catalogAsset,
      block: { kind: "latest" },
    });
    assertTokenInspection(mcpInspection.structuredContent, fakeRpc);
    if (
      JSON.stringify([...invokedSemanticReadToolNames].sort()) !==
      JSON.stringify([...expectedSemanticReadToolNames].sort())
    ) throw new TypeError("Packaged MCP did not execute every semantic read tool.");

    const initialAssetRequestCount = fakeRpc.calls.length;
    let initialMcpAssets;
    try {
      initialMcpAssets = await firstMcp.callTool("account_list_assets");
    } catch (error) {
      throw new AggregateError(
        [error],
        `Packaged initial account-asset read failed: ${JSON.stringify({
          failures: fakeRpc.failures,
          tail: fakeRpc.calls.slice(-12),
        })}`,
      );
    }
    const initialAssets = assertAccountAssetCollection(
      initialMcpAssets.structuredContent,
      fakeRpc,
      fakeRpc.defaultTokens,
    );
    assertRpcRequestBudget(fakeRpc, initialAssetRequestCount, 71, "Initial account asset page");
    if (initialAssets.nextCursor !== null) {
      throw new TypeError("Default initialization created unexpected account selections.");
    }
    const browserAssets = assertAccountAssetOverview(
      await jsonResponse(await browserAccountAssets(browser)),
      fakeRpc,
      fakeRpc.defaultTokens,
    );
    const browserExactDefault = await jsonResponse(await browserExactAccountAsset(
      browser,
      fakeRpc.defaultTokens[0],
      browserAssets.viewRevision,
    ));
    assertExactAccountAsset(browserExactDefault, fakeRpc, fakeRpc.defaultTokens[0]);

    const officialAdditionRequestCount = fakeRpc.calls.length;
    const officialStart = await firstMcp.callTool("token_start_addition", {
      asset: officialCandidateAsset,
    });
    assertRpcRequestBudget(fakeRpc, officialAdditionRequestCount, 24, "Official token addition");
    const pendingTokenOperation = tokenStartOperation(officialStart);
    if (
      pendingTokenOperation.kind !== "add" ||
      pendingTokenOperation.state !== "awaiting_confirmation" ||
      pendingTokenOperation.interactionInterface !== "web" ||
      pendingTokenOperation.account?.address !== expectedWalletAddress ||
      pendingTokenOperation.asset?.chainId !== fakeRpc.officialCandidate.chainId ||
      pendingTokenOperation.asset.address !== fakeRpc.officialCandidate.address ||
      pendingTokenOperation.review?.officialEvidence?.assetUid !==
        fakeRpc.officialCandidate.assetUid ||
      typeof pendingTokenOperation.review.reviewDigest !== "string"
    ) throw new TypeError("Packaged official token addition operation is invalid.");
    assertTokenInspection(
      pendingTokenOperation.review.inspection,
      Object.freeze({ ...fakeRpc, token: fakeRpc.officialCandidate }),
    );
    const tokenOperationId = pendingTokenOperation.operationId;
    const currentTokenOperation = await jsonResponse(await browserTokenCurrent(browser));
    if (
      JSON.stringify(currentTokenOperation.operation) !== JSON.stringify(pendingTokenOperation)
    ) throw new TypeError("Browser did not expose the MCP-created token operation exactly.");
    const secondTokenOperation = await secondMcp.callTool("token_get_operation", {
      operationId: tokenOperationId,
    });
    if (
      JSON.stringify(secondTokenOperation.structuredContent?.operation) !==
      JSON.stringify(pendingTokenOperation)
    ) throw new TypeError("Compatible MCP processes do not share one token operation.");
    const confirmedTokenOperation = await jsonResponse(await browserTokenConfirm(
      tokenOperationId,
      pendingTokenOperation.review.reviewDigest,
      browser,
    ));
    if (
      confirmedTokenOperation.operationId !== tokenOperationId ||
      confirmedTokenOperation.kind !== "add" ||
      confirmedTokenOperation.state !== "completed" ||
      confirmedTokenOperation.failure !== null
    ) throw new TypeError("Browser token confirmation did not complete the exact operation.");
    const officialSelection = assertTokenSelectionDetail(
      confirmedTokenOperation.result,
      fakeRpc,
      fakeRpc.officialCandidate,
      true,
    );
    assertAccountAssetOverview(
      await jsonResponse(await browserAccountAssets(browser)),
      fakeRpc,
      [...fakeRpc.defaultTokens, fakeRpc.officialCandidate],
    );

    const firstSelection = await firstMcp.callTool("token_get_selection", {
      asset: officialCandidateAsset,
    });
    assertTokenSelectionDetail(
      firstSelection.structuredContent,
      fakeRpc,
      fakeRpc.officialCandidate,
      true,
    );
    findTokenSelection(
      (await secondMcp.callTool("token_list_selections")).structuredContent,
      fakeRpc.officialCandidate,
      true,
    );
    const unsupportedTokenResource = await unsupportedBrowserTokenResource(browser);
    if (
      unsupportedTokenResource.status !== 404 ||
      problemCode(await unsupportedTokenResource.json()) !== "route_not_found"
    ) throw new TypeError("Packaged unknown token resource is available.");

    const tokenRemovalStart = await firstMcp.callTool("token_start_removal", {
      asset: officialCandidateAsset,
      expectedRevision: officialSelection.revision,
    });
    const pendingTokenRemoval = tokenStartOperation(tokenRemovalStart);
    if (
      pendingTokenRemoval.kind !== "remove" ||
      pendingTokenRemoval.state !== "awaiting_confirmation" ||
      pendingTokenRemoval.review?.previousSelection?.revision !== officialSelection.revision
    ) throw new TypeError("Packaged token removal operation is invalid.");
    const currentTokenRemoval = await jsonResponse(await browserTokenCurrent(browser));
    if (JSON.stringify(currentTokenRemoval.operation) !== JSON.stringify(pendingTokenRemoval)) {
      throw new TypeError("Browser did not expose the token removal operation exactly.");
    }
    const confirmedTokenRemoval = await jsonResponse(await browserTokenConfirm(
      pendingTokenRemoval.operationId,
      pendingTokenRemoval.review.reviewDigest,
      browser,
    ));
    if (
      confirmedTokenRemoval.kind !== "remove" ||
      confirmedTokenRemoval.state !== "completed" ||
      confirmedTokenRemoval.result?.selection?.included !== false
    ) throw new TypeError("Browser token removal confirmation did not complete the exact operation.");
    const excludedOfficial = findTokenSelection(
      (await secondMcp.callTool("token_list_selections")).structuredContent,
      fakeRpc.officialCandidate,
      false,
    );
    assertAccountAssetOverview(
      await jsonResponse(await browserAccountAssets(browser)),
      fakeRpc,
      fakeRpc.defaultTokens,
    );
    const retainedExclusion = await firstMcp.callTool("token_get_selection", {
      asset: officialCandidateAsset,
    });
    assertTokenSelectionDetail(
      retainedExclusion.structuredContent,
      fakeRpc,
      fakeRpc.officialCandidate,
      false,
    );

    const customAdditionRequestCount = fakeRpc.calls.length;
    const customStart = await firstMcp.callTool("token_start_addition", {
      asset: catalogAsset,
    });
    assertRpcRequestBudget(fakeRpc, customAdditionRequestCount, 24, "Custom token addition");
    const pendingCustomAddition = tokenStartOperation(customStart);
    if (
      pendingCustomAddition.kind !== "add" ||
      pendingCustomAddition.review?.officialEvidence !== null
    ) throw new TypeError("Packaged custom token addition operation is invalid.");
    const confirmedCustomAddition = await jsonResponse(await browserTokenConfirm(
      pendingCustomAddition.operationId,
      pendingCustomAddition.review.reviewDigest,
      browser,
    ));
    if (
      confirmedCustomAddition.kind !== "add" ||
      confirmedCustomAddition.state !== "completed" ||
      confirmedCustomAddition.failure !== null
    ) {
      throw new TypeError(
        `Packaged custom token addition did not complete: ${JSON.stringify(confirmedCustomAddition)}`,
      );
    }
    const customSelection = assertTokenSelectionDetail(
      confirmedCustomAddition.result,
      fakeRpc,
      fakeRpc.token,
      true,
    );
    const customAssetView = assertAccountAssetOverview(
      await jsonResponse(await browserAccountAssets(browser)),
      fakeRpc,
      fakeRpc.defaultTokens,
    );
    const exactAssetRequestCount = fakeRpc.calls.length;
    const exactCustom = await jsonResponse(await browserExactAccountAsset(
      browser,
      fakeRpc.token,
      customAssetView.viewRevision,
    ));
    assertRpcRequestBudget(fakeRpc, exactAssetRequestCount, 22, "Exact account asset read");
    assertExactAccountAsset(exactCustom, fakeRpc, fakeRpc.token);

    const cliTokenList = await runCommand(process.execPath, [
      resolve(prepared.installedPackageRoot, "dist/cli.js"),
      "token",
      "list",
      "--json",
    ], { cwd: prepared.installRoot, env: environment, output: "capture" });
    findTokenSelection(
      JSON.parse(cliTokenList.stdout.toString("utf8")),
      fakeRpc.token,
      true,
    );
    const cliTokenGet = await runCommand(process.execPath, [
      resolve(prepared.installedPackageRoot, "dist/cli.js"),
      "token",
      "get",
      fakeRpc.token.address,
      "--json",
    ], { cwd: prepared.installRoot, env: environment, output: "capture" });
    assertTokenSelectionDetail(
      JSON.parse(cliTokenGet.stdout.toString("utf8")),
      fakeRpc,
      fakeRpc.token,
      true,
    );
    const cliAssets = await runCommand(process.execPath, [
      resolve(prepared.installedPackageRoot, "dist/cli.js"),
      "read",
      "assets",
      "--json",
    ], { cwd: prepared.installRoot, env: environment, output: "capture" });
    assertAccountAssetCollection(
      JSON.parse(cliAssets.stdout.toString("utf8")),
      fakeRpc,
      fakeRpc.defaultTokens,
    );

    const customRemovalStart = tokenStartOperation(await firstMcp.callTool("token_start_removal", {
      asset: catalogAsset,
      expectedRevision: customSelection.revision,
    }));
    const removedCustom = await jsonResponse(await browserTokenConfirm(
      customRemovalStart.operationId,
      customRemovalStart.review.reviewDigest,
      browser,
    ));
    const excludedCustom = assertTokenSelectionDetail(
      removedCustom.result,
      fakeRpc,
      fakeRpc.token,
      false,
    );
    const customRestart = tokenStartOperation(await firstMcp.callTool("token_start_addition", {
      asset: catalogAsset,
    }));
    const restoredCustomOperation = await jsonResponse(await browserTokenConfirm(
      customRestart.operationId,
      customRestart.review.reviewDigest,
      browser,
    ));
    if (
      restoredCustomOperation.kind !== "add" ||
      restoredCustomOperation.state !== "completed" ||
      restoredCustomOperation.failure !== null
    ) {
      throw new TypeError(
        `Packaged custom token re-addition did not complete: ${JSON.stringify(restoredCustomOperation)}`,
      );
    }
    const restoredToken = assertTokenSelectionDetail(
      restoredCustomOperation.result,
      fakeRpc,
      fakeRpc.token,
      true,
    );
    if (
      excludedOfficial.revision === officialSelection.revision ||
      restoredToken.revision === customSelection.revision ||
      restoredToken.revision === excludedCustom.revision
    ) throw new TypeError("Packaged selection transitions reused stale revisions.");

    fakeRpc.setAssetSourceUnavailable(true);
    const unavailableSourceAssets = assertUnavailableAccountAssetOverview(
      await jsonResponse(await browserAccountAssets(browser)),
      fakeRpc,
      customAssetView.viewRevision.officialSnapshotRevision,
    );
    fakeRpc.setAssetSourceUnavailable(false);
    if (unavailableSourceAssets.viewRevision.selectionSetRevision === null) {
      throw new TypeError("Packaged source failure did not preserve the committed snapshot revision.");
    }

    const idempotentConnection = startToolResult(
      await firstMcp.callTool("wallet_start_connection"),
    );
    if (
      idempotentConnection.status !== "current_connection" ||
      JSON.stringify(idempotentConnection.connection) !==
        JSON.stringify(firstConnection.structuredContent?.data)
    ) throw new TypeError("Connected MCP Connect did not return the current connection.");

    const { result: browserConnection } =
      await browserStartFromCurrentState("connect", browser);
    if (
      browserConnection.status !== "current_connection" ||
      JSON.stringify(browserConnection.connection) !==
        JSON.stringify(firstConnection.structuredContent?.data)
    ) throw new TypeError("Connected browser Connect did not return the current connection.");

    const staleDisconnection = await firstMcp.callTool("wallet_start_disconnection");
    const staleDisconnectionId = operationIdFrom(staleDisconnection);
    const staleDisconnectionOperation = startedToolOperation(staleDisconnection);
    if (
      staleDisconnectionOperation.kind !== "disconnect" ||
      staleDisconnectionOperation.state !== "awaiting_confirmation"
    ) {
      throw new TypeError("Connected disconnection did not require explicit confirmation.");
    }
    await owner.request("touch_session");
    const staleConfirmation = await browserConfirm(
      staleDisconnectionId,
      staleDisconnectionOperation.connectionRevision,
      browser,
    );
    const staleProblem = await staleConfirmation.json();
    if (staleConfirmation.status < 400 || problemCode(staleProblem) !== "state_conflict") {
      throw new TypeError("Stale browser confirmation was not rejected.");
    }
    const disconnectionCancellationAccepted = await jsonResponse(await browserCancel(
      staleDisconnectionId,
      staleDisconnectionOperation.connectionRevision,
      browser,
    ));
    if (
      disconnectionCancellationAccepted.operationId !== staleDisconnectionId ||
      disconnectionCancellationAccepted.connectionRevision !==
        staleDisconnectionOperation.connectionRevision ||
      disconnectionCancellationAccepted.kind !== "disconnect"
    ) {
      throw new TypeError("Browser disconnection cancellation lost its exact operation identity.");
    }
    const cancelledDisconnection = (await waitFor(
      async () => jsonResponse(await browserOperation(staleDisconnectionId, browser)),
      (value) => value.operation?.state === "cancelled",
      "Browser disconnection cancellation",
    )).operation;
    if (cancelledDisconnection.state !== "cancelled") {
      throw new TypeError("Browser disconnection cancellation did not settle.");
    }
    const preservedConnection = await firstMcp.callTool("wallet_get_connection");
    if (preservedConnection.structuredContent?.data?.status !== "connected") {
      throw new TypeError("Cancelled disconnection changed the active wallet session.");
    }

    const {
      state: disconnectState,
      result: disconnectStart,
    } = await browserStartFromCurrentState("disconnect", browser);
    if (
      disconnectState.status !== "absent" ||
      disconnectState.connection?.status !== "connected"
    ) throw new TypeError("Browser disconnection precondition is invalid.");
    if (
      disconnectStart.status !== "operation_started" ||
      disconnectStart.operation?.kind !== "disconnect" ||
      disconnectStart.operation?.state !== "awaiting_confirmation" ||
      typeof disconnectStart.operation?.operationId !== "string"
    ) throw new TypeError("Direct browser disconnection did not start exactly once.");
    const confirmedDisconnection = await jsonResponse(await browserConfirm(
      disconnectStart.operation.operationId,
      disconnectStart.operation.connectionRevision,
      browser,
    ));
    if (
      confirmedDisconnection.operationId !== disconnectStart.operation.operationId ||
      confirmedDisconnection.connectionRevision !== disconnectStart.operation.connectionRevision ||
      confirmedDisconnection.kind !== "disconnect" ||
      confirmedDisconnection.state !== "disconnecting"
    ) throw new TypeError("Direct browser disconnection did not retain exact confirmation authority.");
    const completedDisconnection = await waitFor(
      async () => jsonResponse(await browserOperation(
        disconnectStart.operation.operationId,
        browser,
      )),
      (value) => value.operation?.state === "completed",
      "Direct browser disconnection",
    );
    if (
      completedDisconnection.operation?.state !== "completed" ||
      completedDisconnection.operation?.result?.outcome !== "disconnected"
    ) throw new TypeError("Packaged browser lost the completed disconnection result.");

    const {
      state: expiringState,
      result: expiringStart,
    } = await browserStartFromCurrentState("connect", browser);
    if (
      expiringState.status !== "absent" ||
      expiringState.connection?.status !== "disconnected"
    ) throw new TypeError("Browser pairing expiry precondition is invalid.");
    if (
      expiringStart.status !== "operation_started" ||
      expiringStart.operation?.kind !== "connect" ||
      typeof expiringStart.operation?.operationId !== "string"
    ) throw new TypeError("Browser pairing expiry scenario did not start a connection.");
    const expiringOperation = (await waitFor(
      async () => jsonResponse(await browserOperation(
        expiringStart.operation.operationId,
        browser,
      )),
      (value) => value.operation?.state === "awaiting_wallet_approval",
      "Browser pairing expiry operation",
    )).operation;
    const expiringPresentation = await jsonResponse(await browserCurrent(browser));
    if (
      expiringPresentation.status !== "present" ||
      expiringPresentation.presentation?.operation?.operationId !== expiringOperation.operationId ||
      expiringPresentation.presentation?.qr === undefined
    ) throw new TypeError("Browser pairing expiry scenario did not expose one atomic QR snapshot.");
    const actionExpiresAtMs = Date.parse(expiringOperation.actionExpiresAt);
    if (!Number.isFinite(actionExpiresAtMs)) {
      throw new TypeError("Packaged wallet operation deadline is invalid.");
    }
    const clock = new Date(actionExpiresAtMs + 1);
    await writeFile(clockPath, `${clock.toISOString()}\n`, { mode: 0o600 });
    const expiryStarted = await internalOperation(owner, expiringOperation.operationId);
    if (
      expiryStarted.response?.body?.state !== "cancelling" ||
      JSON.stringify(expiryStarted.response?.body).includes("\"qr\"")
    ) {
      throw new TypeError("Packaged wallet operation did not withdraw approval authority at its deadline.");
    }
    await waitFor(
      () => internalOperation(owner, expiringOperation.operationId),
      (value) => value.response?.body?.state === "expired",
      "Packaged wallet operation expiry",
    );
    const expiredBrowserOperation = await jsonResponse(await browserOperation(
      expiringOperation.operationId,
      browser,
    ));
    if (
      expiredBrowserOperation.operation?.state !== "expired" ||
      JSON.stringify(expiredBrowserOperation).includes("\"qr\"")
    ) throw new TypeError("Packaged browser retained QR authority after operation expiry.");
    const stateAfterExpiry = await jsonResponse(await browserCurrent(browser));
    if (
      stateAfterExpiry.status !== "absent" ||
      stateAfterExpiry.connection?.status !== "disconnected" ||
      JSON.stringify(stateAfterExpiry).includes("\"qr\"")
    ) throw new TypeError("Expired packaged operation retained browser QR authority.");

    const { result: reconnect } =
      await browserStartFromCurrentState("connect", browser);
    if (
      reconnect.status !== "operation_started" ||
      reconnect.operation?.kind !== "connect" ||
      typeof reconnect.operation?.operationId !== "string"
    ) throw new TypeError("Browser reconnect did not start a connection.");
    await waitFor(
      async () => jsonResponse(await browserOperation(reconnect.operation.operationId, browser)),
      (value) => value.operation?.state === "awaiting_wallet_approval",
      "Browser reconnect wallet approval",
    );
    await owner.request("approve");
    const reconnected = await waitFor(
      () => firstMcp.callTool("wallet_get_operation", {
        operationId: reconnect.operation.operationId,
      }),
      (result) => readToolOperation(result).state === "completed",
      "Browser-started wallet reconnect",
    );
    if (readToolOperation(reconnected).result?.outcome !== "connected") {
      throw new TypeError("Browser-started wallet reconnect did not complete.");
    }

    await Promise.all(mcpClients.splice(0).map((client) => client.close()));
    await owner.stop();
    const takeoverAcquiredAt = (await readFile(clockPath, "utf8")).trim();
    const restored = await publicWalletConnection(deferred);
    if (
      restored.ownerState !== "owner" ||
      restored.response?.body?.data?.status !== "connected"
    ) throw new TypeError("Deferred packaged process did not restore the persisted wallet session.");
    const restoredRuntimeIdentity = await readPackagedRuntimeIdentity();
    if (
      restoredRuntimeIdentity.profileId !== initialRuntimeIdentity.profileId ||
      restoredRuntimeIdentity.configurationMac !== initialRuntimeIdentity.configurationMac ||
      restoredRuntimeIdentity.ownerInstanceId === initialRuntimeIdentity.ownerInstanceId ||
      BigInt(restoredRuntimeIdentity.ownerRevision) <= BigInt(initialRuntimeIdentity.ownerRevision)
    ) throw new TypeError("Compatible packaged takeover changed configuration identity.");

    const staleBrowserResponse = await browserCurrent(browser);
    const staleBrowserProblem = await staleBrowserResponse.json();
    if (
      staleBrowserResponse.status !== 401 ||
      problemCode(staleBrowserProblem) !== "unauthorized"
    ) throw new TypeError("Owner takeover did not invalidate the previous browser session.");
    const renewedBrowser = await browserSession();
    const renewedBrowserState = await jsonResponse(await browserCurrent(renewedBrowser));
    if (renewedBrowserState.connection?.status !== "connected") {
      throw new TypeError("Browser bootstrap did not recover after owner takeover.");
    }
    const renewedAssets = await jsonResponse(await browserAccountAssets(renewedBrowser));
    assertAccountAssetOverview(renewedAssets, fakeRpc, fakeRpc.defaultTokens);
    const takeoverMcp = await startNpxMcp(prepared, environment);
    mcpClients.push(takeoverMcp);
    const takeoverAssets = await takeoverMcp.callTool("account_list_assets");
    assertAccountAssetCollection(
      takeoverAssets.structuredContent,
      fakeRpc,
      fakeRpc.defaultTokens,
    );
    const takeoverReferenceWatchlist = assertReferenceWatchlist(
      (await callSemanticRead(takeoverMcp, "market_get_watchlist")).structuredContent,
      [referencePair.pairId],
    );
    if (takeoverReferenceWatchlist.revision !== reorderedReferenceWatchlist.revision) {
      throw new TypeError("Packaged owner takeover changed the persisted reference watchlist.");
    }
    const removedReferenceWatchlist = assertReferenceWatchlist(
      (await takeoverMcp.callTool("market_remove_watchlist_pair", {
        pairId: referencePair.pairId,
        expectedRevision: takeoverReferenceWatchlist.revision,
      })).structuredContent,
      [],
    );
    if (removedReferenceWatchlist.revision === takeoverReferenceWatchlist.revision) {
      throw new TypeError("Packaged watchlist removal did not commit a new revision.");
    }
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
    await assertFixedPortReleased();
  } finally {
    await Promise.allSettled(mcpClients.splice(0).map((client) => client.close()));
    await Promise.allSettled(workers.map((worker) => worker.stop()));
    await Promise.allSettled(workers.map((worker) => worker.terminate()));
    await fakeRpc.close().catch(() => undefined);
    await rm(workerPath, { force: true });
  }
};
