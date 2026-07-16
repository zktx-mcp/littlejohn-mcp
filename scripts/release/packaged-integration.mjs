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

const startedToolOperation = (toolResult) => {
  const operation = toolResult?.structuredContent?.operation;
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

const browserSession = async (managementUrl) => {
  const page = await fetch(managementUrl, { redirect: "error" });
  if (page.status !== 200) throw new TypeError("Packaged browser page did not load.");
  const shell = await page.text();
  const cookie = page.headers.get("set-cookie")?.split(";", 1)[0];
  const csrf = shell.match(/<meta name="littlejohn-csrf-token" content="([^"]+)"/u)?.[1];
  const csp = page.headers.get("content-security-policy");
  if (
    cookie === undefined ||
    csrf === undefined ||
    csp === null ||
    !csp.includes("default-src 'none'") ||
    /https?:\/\/(?!127\.0\.0\.1:46630)/u.test(shell)
  ) throw new TypeError("Packaged browser shell security metadata is invalid.");
  const assets = [...shell.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/gu)]
    .map((match) => match[1])
    .filter((value) => value !== undefined);
  if (assets.length === 0) throw new TypeError("Packaged browser shell has no compiled assets.");
  for (const path of assets) {
    const asset = await fetch(`${fixedOrigin}${path}`, { redirect: "error" });
    if (asset.status !== 200) throw new TypeError(`Packaged browser asset failed: ${path}`);
    await asset.arrayBuffer();
  }
  return Object.freeze({ cookie, csrf, shell });
};

const browserRead = (operationId, browser, suffix = "") => fetch(
  `${fixedOrigin}/api/v1/wallet/operations/${operationId}${suffix}`,
  { headers: { Cookie: browser.cookie }, redirect: "error" },
);

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

const browserCancel = (operationId, browser) => fetch(
  `${fixedOrigin}/api/v1/wallet/operations/${operationId}`,
  {
    method: "DELETE",
    headers: {
      Cookie: browser.cookie,
      Origin: fixedOrigin,
      [csrfHeaderName]: browser.csrf,
    },
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

const startInternalConnection = (worker) => dispatch(worker, {
  requestClass: "local_control",
  method: "POST",
  path: "/api/v1/internal/control/wallet/operations",
  body: { kind: "connect", interactionInterface: "web" },
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

    const started = await firstMcp.callTool("wallet_start_connection");
    const operationId = operationIdFrom(started);
    const managementUrl = started.structuredContent?.managementUrl;
    if (managementUrl !== `${fixedOrigin}/wallet/operations/${operationId}`) {
      throw new TypeError("Packaged MCP management URL is invalid.");
    }
    const serializedStart = JSON.stringify(started);
    for (const secretWord of ["pairing", "topic", "credential", "\"qr\""]) {
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
    const browser = await browserSession(managementUrl);
    const browserOperation = await jsonResponse(await browserRead(operationId, browser));
    if ("qr" in browserOperation) {
      throw new TypeError("Packaged browser operation read exposed QR data.");
    }
    const qr = await jsonResponse(await browserRead(operationId, browser, "/qr"));
    if (
      typeof qr.qr?.size !== "number" ||
      !Array.isArray(qr.qr?.rows) ||
      qr.qr.rows.length !== qr.qr.size
    ) throw new TypeError("Packaged browser QR projection is invalid.");
    const unauthorizedQr = await fetch(
      `${fixedOrigin}/api/v1/wallet/operations/${operationId}/qr`,
      { redirect: "error" },
    );
    if (unauthorizedQr.status < 400) {
      throw new TypeError("Packaged browser QR is readable without operation credentials.");
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
    const firstConnection = await firstMcp.callTool("wallet_get_connection");
    if (firstConnection.structuredContent?.data?.status !== "connected") {
      throw new TypeError("Packaged MCP wallet connection is not connected.");
    }

    const secondMcp = await startNpxMcp(prepared, environment);
    mcpClients.push(secondMcp);
    const secondConnection = await secondMcp.callTool("wallet_get_connection");
    if (
      JSON.stringify(secondConnection.structuredContent?.data) !==
      JSON.stringify(firstConnection.structuredContent?.data)
    ) throw new TypeError("Compatible MCP processes do not share one wallet projection.");

    const replacement = await firstMcp.callTool("wallet_start_connection");
    const replacementId = operationIdFrom(replacement);
    const replacementOperation = startedToolOperation(replacement);
    if (replacementOperation.state !== "awaiting_confirmation") {
      throw new TypeError("Connected replacement did not require explicit confirmation.");
    }
    const replacementBrowser = await browserSession(
      `${fixedOrigin}/wallet/operations/${replacementId}`,
    );
    await owner.request("touch_session");
    const staleConfirmation = await browserConfirm(
      replacementId,
      replacementOperation.connectionRevision,
      replacementBrowser,
    );
    const staleProblem = await staleConfirmation.json();
    if (staleConfirmation.status < 400 || problemCode(staleProblem) !== "state_conflict") {
      throw new TypeError("Stale browser confirmation was not rejected.");
    }
    const cancelledReplacement = await jsonResponse(
      await browserCancel(replacementId, replacementBrowser),
    );
    if (cancelledReplacement.operation?.state !== "cancelled") {
      throw new TypeError("Replacement cancellation did not preserve the active session.");
    }
    const preservedConnection = await firstMcp.callTool("wallet_get_connection");
    if (preservedConnection.structuredContent?.data?.status !== "connected") {
      throw new TypeError("Cancelled replacement changed the active wallet session.");
    }

    await Promise.all(mcpClients.splice(0).map((client) => client.close()));
    await owner.stop();
    const restored = await publicWalletConnection(deferred);
    if (
      restored.ownerState !== "owner" ||
      restored.response?.body?.data?.status !== "connected"
    ) throw new TypeError("Deferred packaged process did not restore the persisted wallet session.");

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

    const cancellable = await startInternalConnection(deferred);
    const cancellableOperation = cancellable.response?.body?.operation;
    if (cancellableOperation?.state !== "awaiting_wallet_approval") {
      throw new TypeError("Packaged browser cancellation scenario did not reach wallet approval.");
    }
    const cancellableBrowser = await browserSession(
      `${fixedOrigin}/wallet/operations/${cancellableOperation.operationId}`,
    );
    const cancelled = await jsonResponse(
      await browserCancel(cancellableOperation.operationId, cancellableBrowser),
    );
    if (cancelled.operation?.state !== "cancelled") {
      throw new TypeError("Packaged browser cancellation did not settle exactly.");
    }

    const expiring = await startInternalConnection(deferred);
    const expiringOperation = expiring.response?.body?.operation;
    if (expiringOperation?.state !== "awaiting_wallet_approval") {
      throw new TypeError("Packaged browser expiry scenario did not reach wallet approval.");
    }
    const expiringBrowser = await browserSession(
      `${fixedOrigin}/wallet/operations/${expiringOperation.operationId}`,
    );
    const currentTime = (await readFile(clockPath, "utf8")).trim();
    const currentTimeMs = Date.parse(currentTime);
    if (!Number.isFinite(currentTimeMs)) {
      throw new TypeError("Packaged integration clock is invalid.");
    }
    const clock = new Date(currentTimeMs + 6 * 60 * 1_000);
    await writeFile(clockPath, `${clock.toISOString()}\n`, { mode: 0o600 });
    const expired = await internalOperation(deferred, expiringOperation.operationId);
    if (expired.response?.body?.operation?.state !== "expired") {
      throw new TypeError("Packaged wallet operation did not expire at its canonical deadline.");
    }
    const expiredQr = await browserRead(expiringOperation.operationId, expiringBrowser, "/qr");
    const expiredProblem = await expiredQr.json();
    if (expiredQr.status < 400 || problemCode(expiredProblem) !== "state_conflict") {
      throw new TypeError("Expired packaged operation retained QR authority.");
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
