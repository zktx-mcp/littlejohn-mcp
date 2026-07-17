import { fork, spawn } from "node:child_process";
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
  "transaction.inspect",
  "wallet.connection",
]);
const expectedToolNames = Object.freeze([
  "read_get_account_balance",
  "read_get_chain_status",
  "read_inspect_contract",
  "read_inspect_transaction",
  "read_list_capabilities",
  "wallet_cancel_operation",
  "wallet_get_connection",
  "wallet_get_operation",
  "wallet_start_connection",
  "wallet_start_disconnection",
]);

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
      "Release worker graceful shutdown",
    );
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

const operationIdFrom = (toolResult) => {
  const operationId = startedToolOperation(toolResult).operationId;
  if (typeof operationId !== "string") throw new TypeError("MCP wallet operation identity is unavailable.");
  return operationId;
};

const assertBrowserAssets = async (shell) => {
  const assets = [...shell.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/gu)]
    .map((match) => match[1])
    .filter((value) => value !== undefined);
  if (assets.length === 0) throw new TypeError("Packaged browser shell has no compiled assets.");
  for (const path of assets) {
    const asset = await fetch(`${fixedOrigin}${path}`, { redirect: "error" });
    if (asset.status !== 200) throw new TypeError(`Packaged browser asset failed: ${path}`);
    await asset.arrayBuffer();
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

const browserStart = (kind, connectionRevision, browser) => fetch(
  `${fixedOrigin}/api/v1/wallet/operations`,
  {
    method: "POST",
    headers: {
      Cookie: browser.cookie,
      Origin: fixedOrigin,
      [csrfHeaderName]: browser.csrf,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ kind, connectionRevision }),
    redirect: "error",
  },
);

const browserStartFromCurrentState = async (kind, browser) => {
  const state = await jsonResponse(await browserCurrent(browser));
  if (typeof state?.connectionRevision !== "string") {
    throw new TypeError("Packaged browser connection revision is unavailable.");
  }
  const response = await browserStart(kind, state.connectionRevision, browser);
  if (response.status !== 200) {
    const problem = await response.json();
    const after = await jsonResponse(await browserCurrent(browser));
    throw new Error(
      `HTTP ${response.status}: ${JSON.stringify(problem)}; ` +
      `before=${JSON.stringify(state)}; after=${JSON.stringify(after)}`,
    );
  }
  const result = await jsonResponse(response);
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

/** @type {typeof import("./packaged-integration.d.mts").verifyPackagedIntegration} */
export const verifyPackagedIntegration = async (prepared) => {
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
  const environment = Object.freeze({
    ...prepared.environment,
    LITTLEJOHN_DATA_DIR: dataDirectory,
    LITTLEJOHN_RELEASE_CLOCK: clockPath,
    LITTLEJOHN_RPC_URL: fakeRpc.url,
    LITTLEJOHN_WALLETCONNECT_PROJECT_ID: "1".repeat(32),
  });
  const workers = [];
  const mcpClients = [];
  try {
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

    const firstMcp = await startNpxMcp(prepared, environment);
    mcpClients.push(firstMcp);
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
    const catalog = await firstMcp.callTool("read_list_capabilities");
    const catalogEntries = catalog.structuredContent?.capabilities;
    if (!Array.isArray(catalogEntries)) {
      throw new TypeError("Packaged MCP capability catalog is invalid.");
    }
    const capabilityIds = catalogEntries.map((entry) => entry?.capabilityId);
    if (
      catalog.structuredContent?.contractVersion !== "1" ||
      JSON.stringify(capabilityIds) !== JSON.stringify(expectedCapabilityIds)
    ) throw new TypeError("Packaged MCP capability catalog is not the exact canonical set.");
    const chainStatus = await firstMcp.callTool("read_get_chain_status");
    if (
      chainStatus.structuredContent?.data?.chainId !== "4663" ||
      chainStatus.structuredContent?.data?.caip2 !== "eip155:4663"
    ) throw new TypeError("Packaged MCP chain status is invalid.");

    const httpChainStatus = await jsonResponse(await fetch(`${fixedOrigin}/api/v1/chain-status`));
    if (
      httpChainStatus.data?.chainId !== "4663" ||
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
      cliStatus.data?.chainId !== "4663" ||
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
        path: `${fixedOrigin}/wallet`,
        status: 404,
        headers: undefined,
      },
      {
        method: "GET",
        path: `${fixedOrigin}/api/v1/wallet/operations/${operationId}/qr`,
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
    const firstConnection = await firstMcp.callTool("wallet_get_connection");
    if (firstConnection.structuredContent?.data?.status !== "connected") {
      throw new TypeError("Packaged MCP wallet connection is not connected.");
    }
    const connectedBrowserState = await jsonResponse(await browserCurrent(browser));
    if (
      connectedBrowserState.status !== "absent" ||
      connectedBrowserState.connection?.status !== "connected"
    ) throw new TypeError("Packaged browser did not settle to the connected global wallet state.");

    const secondMcp = await startNpxMcp(prepared, environment);
    mcpClients.push(secondMcp);
    const secondConnection = await secondMcp.callTool("wallet_get_connection");
    if (
      JSON.stringify(secondConnection.structuredContent?.data) !==
      JSON.stringify(firstConnection.structuredContent?.data)
    ) throw new TypeError("Compatible MCP processes do not share one wallet projection.");

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
      typeof disconnectStart.operation?.operationId !== "string"
    ) throw new TypeError("Direct browser disconnection did not start exactly once.");
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
    const currentTime = (await readFile(clockPath, "utf8")).trim();
    const currentTimeMs = Date.parse(currentTime);
    if (!Number.isFinite(currentTimeMs)) {
      throw new TypeError("Packaged integration clock is invalid.");
    }
    const clock = new Date(currentTimeMs + 6 * 60 * 1_000);
    await writeFile(clockPath, `${clock.toISOString()}\n`, { mode: 0o600 });
    const expired = await internalOperation(owner, expiringOperation.operationId);
    if (expired.response?.body?.operation?.state !== "expired") {
      throw new TypeError("Packaged wallet operation did not expire at its canonical deadline.");
    }
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
    const restored = await publicWalletConnection(deferred);
    if (
      restored.ownerState !== "owner" ||
      restored.response?.body?.data?.status !== "connected"
    ) throw new TypeError("Deferred packaged process did not restore the persisted wallet session.");

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

    await deferred.request("delete_session");
    const deleted = await waitFor(
      () => publicWalletConnection(deferred),
      (result) => result.response?.body?.data?.status === "disconnected" &&
        result.response?.body?.data?.reason === "deleted",
      "Wallet-side deletion projection",
    );
    if (deleted.ownerState !== "owner") {
      throw new TypeError("Wallet-side deletion was not observed by the fixed owner.");
    }

    await deferred.stop();
    fakeRpc.assertNoUnexpectedMethods();
    const methods = fakeRpc.calls.map((call) => call.method);
    if (!methods.includes("eth_chainId") || !methods.includes("eth_getBlockByNumber")) {
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
