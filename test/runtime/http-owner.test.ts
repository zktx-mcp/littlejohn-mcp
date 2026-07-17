import { fork, type ChildProcess } from "node:child_process";
import { createHash, createHmac, hkdfSync } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { connect as connectSocket } from "node:net";
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  canonicalJsonStringify,
  parseEvmChainId,
  parseUtcTimestamp,
  type CanonicalJson,
} from "../../src/core/index.js";
import {
  readConfiguredRpcEndpoint,
  readRuntimeConfiguration,
  type RuntimeConfiguration,
} from "../../src/runtime/configuration.js";
import {
  deriveRuntimeConfigurationMac,
  loadOrCreateControlCredential,
} from "../../src/runtime/control-credential.js";
import { ProductDatabase } from "../../src/runtime/database.js";
import { RuntimeOperationError } from "../../src/runtime/errors.js";
import {
  FixedHttpOwner,
  type HttpOwnerApplicationContext,
  type HttpOwnerOptions,
} from "../../src/runtime/http-owner.js";
import { createResourceOwnershipScope } from "../../src/runtime/resource-ownership.js";
import type { OwnerIdentity } from "../../src/runtime/runtime-identity.js";
import {
  fixedHost,
  fixedHostHeader,
  fixedPort,
  internalResponseLimitBytes,
  publicReadResponseLimitBytes,
} from "../../src/runtime/http-boundary.js";
import { ensureOwnerOnlyDirectory, runtimePaths } from "../../src/runtime/paths.js";

const directories: string[] = [];
const owners: FixedHttpOwner[] = [];
const databases: ProductDatabase[] = [];
const servers: Server[] = [];
const processWorkers: ProcessWorker[] = [];
const now = parseUtcTimestamp("2026-07-12T10:16:02.000Z");
const ownerIdentityPath = "/api/v1/runtime-identity";
const ownerOperationMethod = "GET";
const ownerOperationPath = "/api/v1/internal/control/example";

type RawPeerRequestKind = "identity" | "operation" | "unrelated";

const classifyRawPeerRequest = (request: Pick<IncomingMessage, "method" | "url">): RawPeerRequestKind => {
  if (request.method === "GET" && request.url === ownerIdentityPath) return "identity";
  if (request.method === ownerOperationMethod && request.url === ownerOperationPath) return "operation";
  return "unrelated";
};

const rejectRawPeerRequest = (response: ServerResponse): void => {
  response.writeHead(404, {
    "Content-Length": "0",
    "Cache-Control": "no-store",
    Connection: "close",
  });
  response.end();
};

afterEach(async () => {
  await Promise.all(processWorkers.splice(0).map((worker) => worker.terminate()));
  await Promise.all(owners.splice(0).map((owner) => owner.stop().catch(() => undefined)));
  for (const database of databases.splice(0)) {
    try { database.close(); } catch { /* Preserve test cleanup. */ }
  }
  await Promise.all(servers.splice(0).map((server) => close(server).catch(() => undefined)));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const fixture = async (knownBytes?: Uint8Array) => {
  const directory = await mkdtemp(resolve(tmpdir(), "littlejohn-owner-"));
  directories.push(directory);
  await ensureOwnerOnlyDirectory(directory);
  const paths = runtimePaths(directory);
  if (knownBytes !== undefined) {
    await writeFile(paths.controlCredential, `${Buffer.from(knownBytes).toString("base64url")}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
  const credential = await loadOrCreateControlCredential(directory, paths.controlCredential);
  const database = await ProductDatabase.open(paths.database, now);
  const configuration = readRuntimeConfiguration({});
  const configurationMac = deriveRuntimeConfigurationMac(credential, configuration);
  databases.push(database);
  return { directory, paths, credential, database, configuration, configurationMac };
};

type OwnerFixture = Awaited<ReturnType<typeof fixture>>;

const fixedOwnerOptions = (
  test: OwnerFixture,
  database = test.database,
  configuration: RuntimeConfiguration = test.configuration,
): Omit<HttpOwnerOptions, "applicationFactory"> => ({
  ownerStore: database.ownerStore(),
  credential: test.credential,
  configurationMac: deriveRuntimeConfigurationMac(test.credential, configuration),
  now: () => now,
  onPortOwnershipAcquired: () => {
    database.configuredChainStore().insertConfiguredChainIfAbsent(configuration.chain.chainId);
  },
});

const listen = (server: Server): Promise<void> => new Promise((resolveListen, reject) => {
  server.once("error", reject);
  server.listen(fixedPort, fixedHost, resolveListen);
});

const close = (server: Server): Promise<void> => new Promise((resolveClose, reject) => {
  if (!server.listening) return resolveClose();
  server.close((error) => error === undefined ? resolveClose() : reject(error));
  server.closeAllConnections();
});

const requestJson = (
  path: string,
  method = "GET",
  headers: Record<string, string> = {},
  body?: Uint8Array | string,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: unknown }> =>
  new Promise((resolveResponse, reject) => {
    const request = httpRequest({
      host: fixedHost,
      port: fixedPort,
      path,
      method,
      headers: { Host: fixedHostHeader, ...headers },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        try {
          resolveResponse({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
          });
        } catch (error) { reject(error); }
      });
    });
    request.on("error", reject);
    request.end(body);
  });

const requestText = (
  path: string,
  method = "GET",
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> =>
  new Promise((resolveResponse, reject) => {
    const request = httpRequest({
      host: fixedHost,
      port: fixedPort,
      path,
      method,
      headers: { Host: fixedHostHeader, ...headers },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolveResponse({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.on("error", reject);
    request.end();
  });

const credentialAuthorization = async (path: string): Promise<string> =>
  `Bearer ${(await readFile(path, "utf8")).slice(0, -1)}`;

interface IndependentProofFields {
  readonly profileId: string;
  readonly ownerInstanceId: string;
  readonly runtimeProtocolVersion: number;
  readonly configurationMac: string;
  readonly challenge: string;
  readonly ownerRevision: string;
}

const independentProofPayload = (identity: IndependentProofFields): Uint8Array => {
  const fields = [
    identity.profileId,
    identity.ownerInstanceId,
    String(identity.runtimeProtocolVersion),
    identity.configurationMac,
    identity.challenge,
    identity.ownerRevision,
  ].map((value) => Buffer.from(value, "utf8"));
  const bytes = Buffer.alloc(fields.reduce((sum, value) => sum + 4 + value.length, 0));
  let offset = 0;
  for (const field of fields) {
    bytes.writeUInt32BE(field.length, offset);
    offset += 4;
    field.copy(bytes, offset);
    offset += field.length;
  }
  return bytes;
};

const independentProof = (key: Uint8Array, identity: IndependentProofFields): string =>
  createHmac("sha256", key).update(independentProofPayload(identity)).digest("base64url");

const independentConfigurationMac = (
  credential: Uint8Array,
  configuration: RuntimeConfiguration,
  chainId: string,
): string => {
  const fields = [
    chainId,
    readConfiguredRpcEndpoint(configuration.rpc.endpoint).exactUri,
    configuration.wallet.projectId,
  ].map((value) => Buffer.from(value, "utf8"));
  const payload = Buffer.alloc(fields.reduce((sum, value) => sum + 4 + value.length, 0));
  let offset = 0;
  for (const field of fields) {
    payload.writeUInt32BE(field.length, offset);
    offset += 4;
    field.copy(payload, offset);
    offset += field.length;
  }
  const key = hkdfSync(
    "sha256",
    credential,
    Buffer.alloc(0),
    Buffer.from("littlejohn/runtime-configuration/v2", "utf8"),
    32,
  );
  return createHmac("sha256", Buffer.from(key)).update(payload).digest("base64url");
};

const canonicalResponse = (response: ServerResponse, status: number, value: CanonicalJson): void => {
  const body = `${canonicalJsonStringify(value)}\n`;
  response.writeHead(status, {
    "Content-Type": status >= 400 ? "application/problem+json" : "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
};

const formattedJsonResponse = (response: ServerResponse, status: number, value: unknown): void => {
  const body = JSON.stringify(value, null, 2);
  response.writeHead(status, {
    "Content-Type": status >= 400 ? "application/problem+json" : "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
};

interface ProcessWorkerSnapshot {
  readonly processId: number;
  readonly state: "stopped" | "starting" | "owner" | "deferred" | "stopping";
  readonly profileId: string;
  readonly credentialDigest: string;
  readonly applicationFactoryCalls: number;
  readonly recordedOwnerProcessId: number | null;
  readonly recordedOwnerRevision: string | null;
}

interface ProcessWorkerStartResult extends ProcessWorkerSnapshot {
  readonly outcome: "owner" | "deferred";
}

interface ProcessWorkerOperationResult extends ProcessWorkerSnapshot {
  readonly response: {
    readonly status: number;
    readonly body: unknown;
  };
}

interface ProcessWorkerResponse {
  readonly requestId: string;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: { readonly name?: unknown; readonly message?: unknown };
}

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

class ProcessWorker {
  readonly child: ChildProcess;
  readonly ready: Promise<void>;
  readonly exited: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;
  readonly #pending = new Map<string, {
    readonly resolve: (value: unknown) => void;
    readonly reject: (error: Error) => void;
    readonly timer: NodeJS.Timeout;
  }>();
  #nextRequestId = 0;
  #stderr = "";
  #readySettled = false;
  #exited = false;

  private constructor(child: ChildProcess) {
    this.child = child;
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    this.ready = new Promise<void>((resolvePromise, rejectPromise) => {
      resolveReady = resolvePromise;
      rejectReady = rejectPromise;
    });
    let resolveExit!: (result: { readonly code: number | null; readonly signal: NodeJS.Signals | null }) => void;
    this.exited = new Promise((resolvePromise) => { resolveExit = resolvePromise; });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      this.#stderr = `${this.#stderr}${chunk.toString()}`.slice(-8_192);
    });
    child.on("message", (message: unknown) => {
      if (isObjectRecord(message) && message["ready"] === true) {
        if (!this.#readySettled) {
          this.#readySettled = true;
          resolveReady();
        }
        return;
      }
      if (!isObjectRecord(message) || typeof message["requestId"] !== "string" || typeof message["ok"] !== "boolean") {
        return;
      }
      const response = message as unknown as ProcessWorkerResponse;
      const pending = this.#pending.get(response.requestId);
      if (pending === undefined) return;
      clearTimeout(pending.timer);
      this.#pending.delete(response.requestId);
      if (response.ok) pending.resolve(response.result);
      else {
        const detail = typeof response.error?.message === "string"
          ? response.error.message
          : "Child process operation failed.";
        pending.reject(new Error(`${detail}${this.#stderr.length === 0 ? "" : `\n${this.#stderr}`}`));
      }
    });
    child.once("error", (error) => {
      if (!this.#readySettled) {
        this.#readySettled = true;
        rejectReady(error);
      }
      this.#rejectPending(error);
    });
    child.once("exit", (code, signal) => {
      this.#exited = true;
      if (!this.#readySettled) {
        this.#readySettled = true;
        rejectReady(new Error(`Child process exited before readiness (${String(code)}/${String(signal)}).\n${this.#stderr}`));
      }
      this.#rejectPending(new Error(`Child process exited (${String(code)}/${String(signal)}).\n${this.#stderr}`));
      resolveExit({ code, signal });
    });
  }

  static async launch(path: string): Promise<ProcessWorker> {
    const worker = new ProcessWorker(fork(path, [], {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    }));
    await worker.ready;
    return worker;
  }

  request<Result>(command: Readonly<Record<string, unknown>>, timeout = 10_000): Promise<Result> {
    if (this.#exited || !this.child.connected) return Promise.reject(new Error("Child process is unavailable."));
    const requestId = `${process.pid}-${this.child.pid ?? "unknown"}-${this.#nextRequestId++}`;
    return new Promise<Result>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        rejectPromise(new Error(`Child process request timed out.\n${this.#stderr}`));
      }, timeout);
      this.#pending.set(requestId, {
        resolve: (value) => resolvePromise(value as Result),
        reject: rejectPromise,
        timer,
      });
      this.child.send({ ...command, requestId }, (error) => {
        if (error === null) return;
        const pending = this.#pending.get(requestId);
        if (pending === undefined) return;
        clearTimeout(pending.timer);
        this.#pending.delete(requestId);
        pending.reject(error);
      });
    });
  }

  async killOwner(): Promise<void> {
    if (!this.#exited && !this.child.kill("SIGKILL")) throw new Error("Child process could not be killed.");
    const result = await this.exited;
    if (result.signal !== "SIGKILL" && process.platform !== "win32") {
      throw new Error(`Child process did not exit by SIGKILL (${String(result.code)}/${String(result.signal)}).`);
    }
  }

  async terminate(): Promise<void> {
    if (this.#exited) return;
    try { await this.request<null>({ command: "stop" }, 3_000); }
    catch {
      if (!this.#exited) this.child.kill("SIGKILL");
    }
    await Promise.race([
      this.exited,
      new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 3_000)),
    ]);
    if (!this.#exited) this.child.kill("SIGKILL");
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

const readProcessDatabase = (path: string): {
  readonly profileId: string;
  readonly ownerProcessId: number;
  readonly ownerRevision: string;
} => {
  const database = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const profile = database.prepare("SELECT profile_id AS profileId FROM local_profile WHERE singleton = 1").get() as {
      profileId: string;
    };
    const owner = database.prepare(
      "SELECT process_id AS processId, owner_revision AS ownerRevision FROM runtime_owner WHERE singleton = 1",
    ).get() as { processId: number; ownerRevision: string };
    return Object.freeze({
      profileId: profile.profileId,
      ownerProcessId: owner.processId,
      ownerRevision: owner.ownerRevision,
    });
  } finally { database.close(); }
};

describe.sequential("fixed-port owner lifecycle and authenticated operations", () => {
  it("elects one real process and performs one crash takeover under simultaneous demand", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "littlejohn-owner-processes-"));
    directories.push(directory);
    const paths = runtimePaths(directory);
    const workerPath = fileURLToPath(new URL("./http-owner-process-worker.ts", import.meta.url));
    const workers = await Promise.all([
      ProcessWorker.launch(workerPath),
      ProcessWorker.launch(workerPath),
      ProcessWorker.launch(workerPath),
    ]);
    processWorkers.push(...workers);

    const preparedStarts = await Promise.all(workers.map((worker) => worker.request<{ readonly processId: number }>({
      command: "prepare_start",
      dataDirectory: directory,
      now,
    })));
    expect(preparedStarts.map((prepared) => prepared.processId).sort((left, right) => left - right)).toEqual(
      workers.map((worker) => worker.child.pid as number).sort((left, right) => left - right),
    );
    const firstStartBarrier = Date.now() + 100;
    const startResults = await Promise.all(workers.map((worker) => worker.request<ProcessWorkerStartResult>({
      command: "release_start",
      notBeforeEpochMs: firstStartBarrier,
    }, 20_000)));
    expect(startResults.map((result) => result.outcome).sort()).toEqual(["deferred", "deferred", "owner"]);
    const initialOwnerIndex = startResults.findIndex((result) => result.outcome === "owner");
    expect(initialOwnerIndex).toBeGreaterThanOrEqual(0);
    const initialOwner = startResults[initialOwnerIndex] as ProcessWorkerStartResult;
    expect(startResults.map((result) => result.profileId)).toEqual([
      initialOwner.profileId,
      initialOwner.profileId,
      initialOwner.profileId,
    ]);
    expect(startResults.map((result) => result.credentialDigest)).toEqual([
      initialOwner.credentialDigest,
      initialOwner.credentialDigest,
      initialOwner.credentialDigest,
    ]);
    expect(startResults.map((result) => result.recordedOwnerProcessId)).toEqual([
      initialOwner.processId,
      initialOwner.processId,
      initialOwner.processId,
    ]);
    expect(startResults.map((result) => result.applicationFactoryCalls)).toEqual(
      startResults.map((result) => result.outcome === "owner" ? 1 : 0),
    );

    const credentialContent = await readFile(paths.controlCredential, "utf8");
    expect(credentialContent).toMatch(/^[A-Za-z0-9_-]{43}\n$/);
    const credentialDigest = createHash("sha256")
      .update(`Bearer ${credentialContent.slice(0, -1)}`, "utf8")
      .digest("hex");
    expect(credentialDigest).toBe(initialOwner.credentialDigest);
    const credentialDetails = await lstat(paths.controlCredential);
    const databaseDetails = await lstat(paths.database);
    const initialDatabase = readProcessDatabase(paths.database);
    expect(initialDatabase).toEqual({
      profileId: initialOwner.profileId,
      ownerProcessId: initialOwner.processId,
      ownerRevision: initialOwner.recordedOwnerRevision,
    });
    expect((await readdir(directory)).filter((entry) => entry.includes(".pending-"))).toEqual([]);
    await expect(lstat(paths.walletConnectDirectory)).rejects.toMatchObject({ code: "ENOENT" });

    await workers[initialOwnerIndex]?.killOwner();
    const survivingWorkers = workers.filter((_worker, index) => index !== initialOwnerIndex);
    const preparedOperations = await Promise.all(survivingWorkers.map((worker) =>
      worker.request<{ readonly processId: number; readonly state: string }>({ command: "prepare_operate" })));
    expect(preparedOperations.map((prepared) => prepared.processId).sort((left, right) => left - right)).toEqual(
      survivingWorkers.map((worker) => worker.child.pid as number).sort((left, right) => left - right),
    );
    expect(preparedOperations.map((prepared) => prepared.state)).toEqual(["deferred", "deferred"]);
    const takeoverBarrier = Date.now() + 100;
    const operationResults = await Promise.all(survivingWorkers.map((worker) =>
      worker.request<ProcessWorkerOperationResult>({
        command: "release_operate",
        notBeforeEpochMs: takeoverBarrier,
      }, 20_000)));
    for (const result of operationResults) expect(result.response.status).toBe(200);
    const operationBodies = operationResults.map((result) => result.response.body as {
      readonly processId: number;
      readonly executionCount: number;
    });
    expect(new Set(operationBodies.map((body) => body.processId)).size).toBe(1);
    expect(operationBodies.map((body) => body.executionCount).sort((left, right) => left - right)).toEqual([1, 2]);
    const takeoverOwnerProcessId = operationBodies[0]?.processId;
    expect(typeof takeoverOwnerProcessId).toBe("number");
    expect(survivingWorkers.map((worker) => worker.child.pid)).toContain(takeoverOwnerProcessId);

    const finalSnapshots = await Promise.all(survivingWorkers.map((worker) =>
      worker.request<ProcessWorkerSnapshot>({ command: "inspect" })));
    expect(finalSnapshots.map((snapshot) => snapshot.state).sort()).toEqual(["deferred", "owner"]);
    expect(finalSnapshots.map((snapshot) => snapshot.recordedOwnerProcessId)).toEqual([
      takeoverOwnerProcessId,
      takeoverOwnerProcessId,
    ]);
    expect(finalSnapshots.map((snapshot) => snapshot.profileId)).toEqual([
      initialOwner.profileId,
      initialOwner.profileId,
    ]);
    expect(finalSnapshots.map((snapshot) => snapshot.credentialDigest)).toEqual([
      credentialDigest,
      credentialDigest,
    ]);
    expect(finalSnapshots.map((snapshot) => snapshot.applicationFactoryCalls).sort()).toEqual([0, 1]);
    const finalOwner = finalSnapshots.find((snapshot) => snapshot.state === "owner");
    expect(finalOwner?.processId).toBe(takeoverOwnerProcessId);

    const finalCredentialDetails = await lstat(paths.controlCredential);
    const finalDatabaseDetails = await lstat(paths.database);
    expect(finalCredentialDetails.ino).toBe(credentialDetails.ino);
    expect(finalDatabaseDetails.ino).toBe(databaseDetails.ino);
    expect(await readFile(paths.controlCredential, "utf8")).toBe(credentialContent);
    const finalDatabase = readProcessDatabase(paths.database);
    expect(finalDatabase.profileId).toBe(initialDatabase.profileId);
    expect(finalDatabase.ownerProcessId).toBe(takeoverOwnerProcessId);
    expect(BigInt(finalDatabase.ownerRevision)).toBe(BigInt(initialDatabase.ownerRevision) + 1n);
    expect((await readdir(directory)).filter((entry) => entry.includes(".pending-"))).toEqual([]);
    await expect(lstat(paths.walletConnectDirectory)).rejects.toMatchObject({ code: "ENOENT" });

    await Promise.all(survivingWorkers.map((worker) => worker.terminate()));
    const releaseProbe = createServer();
    servers.push(releaseProbe);
    await listen(releaseProbe);
    await close(releaseProbe);
  }, 45_000);

  it("produces the version-2 proof from the exact independent BE32 vector", async () => {
    const key = new Uint8Array(32).fill(1);
    const test = await fixture(key);
    const owner = new FixedHttpOwner({
      ...fixedOwnerOptions(test),
    });
    owners.push(owner);
    expect(await owner.start()).toBe("owner");
    const challenge = Buffer.alloc(32, 3).toString("base64url");
    const response = await requestJson("/api/v1/runtime-identity", "GET", { "Littlejohn-Identity-Challenge": challenge });
    expect(response.status).toBe(200);
    const identity = response.body as OwnerIdentity;
    const { proof, ...withoutProof } = identity;
    expect(proof).toBe(independentProof(key, withoutProof));
    expect(JSON.stringify(response.body)).not.toContain(Buffer.from(key).toString("base64url"));
  });

  it("defers only to an owner with byte-identical runtime configuration", async () => {
    const credentialBytes = new Uint8Array(32).fill(2);
    const test = await fixture(credentialBytes);
    const owner = new FixedHttpOwner({ ...fixedOwnerOptions(test) });
    owners.push(owner);
    expect(await owner.start()).toBe("owner");

    const configurations: readonly RuntimeConfiguration[] = [
      readRuntimeConfiguration({ LITTLEJOHN_RPC_URL: "https://rpc.example/alternate" }),
      readRuntimeConfiguration({ LITTLEJOHN_WALLETCONNECT_PROJECT_ID: "1".repeat(32) }),
    ];

    const compatibleDatabase = await ProductDatabase.open(test.paths.database, now);
    databases.push(compatibleDatabase);
    const compatible = new FixedHttpOwner({ ...fixedOwnerOptions(test, compatibleDatabase) });
    owners.push(compatible);
    expect(await compatible.start()).toBe("deferred");

    for (const configuration of configurations) {
      const database = await ProductDatabase.open(test.paths.database, now);
      databases.push(database);
      const candidate = new FixedHttpOwner({ ...fixedOwnerOptions(test, database, configuration) });
      owners.push(candidate);
      await expect(candidate.start()).rejects.toMatchObject({
        failure: { error: { code: "port_conflict" } },
      });
      expect(candidate.state).toBe("stopped");
    }
    const alternateChainId = parseEvmChainId("eip155:1");
    const alternateChainDatabase = await ProductDatabase.open(test.paths.database, now);
    databases.push(alternateChainDatabase);
    const alternateChain = new FixedHttpOwner({
      ownerStore: alternateChainDatabase.ownerStore(),
      credential: test.credential,
      configurationMac: independentConfigurationMac(
        credentialBytes,
        test.configuration,
        alternateChainId,
      ) as never,
      now: () => now,
      onPortOwnershipAcquired: () => {
        alternateChainDatabase.configuredChainStore().insertConfiguredChainIfAbsent(alternateChainId);
      },
    });
    owners.push(alternateChain);
    await expect(alternateChain.start()).rejects.toMatchObject({
      failure: { error: { code: "port_conflict" } },
    });
    expect(alternateChain.state).toBe("stopped");
    const inspection = new Database(test.paths.database, { readonly: true });
    expect(inspection.prepare("SELECT chain_id AS chainId FROM chain ORDER BY chain_id").all())
      .toEqual([{ chainId: "eip155:4663" }]);
    inspection.close();
  });

  it("runs port ownership setup only for the owner and before application creation", async () => {
    const test = await fixture();
    const secondDatabase = await ProductDatabase.open(test.paths.database, now);
    databases.push(secondDatabase);
    const events: string[] = [];
    const ownerOptions = fixedOwnerOptions(test);
    const owner = new FixedHttpOwner({
      ...ownerOptions,
      onPortOwnershipAcquired: () => {
        events.push("ownership");
        expect(test.database.ownerStore().readOwner()).toMatchObject({
          configurationMac: test.configurationMac,
        });
        ownerOptions.onPortOwnershipAcquired();
      },
      applicationFactory: ({ routes }) => {
        events.push("application");
        return { routes, close: () => undefined };
      },
    });
    let deferredOwnershipCalls = 0;
    const peer = new FixedHttpOwner({
      ...fixedOwnerOptions(test, secondDatabase),
      onPortOwnershipAcquired: () => { deferredOwnershipCalls += 1; },
    });
    owners.push(owner, peer);

    expect(await owner.start()).toBe("owner");
    expect(events).toEqual(["ownership", "application"]);
    expect(await peer.start()).toBe("deferred");
    expect(deferredOwnershipCalls).toBe(0);
  });

  it("closes the listener and never constructs the application when port ownership setup fails", async () => {
    const test = await fixture();
    const failure = new Error("configured chain insertion failed");
    let applicationCalls = 0;
    const owner = new FixedHttpOwner({
      ...fixedOwnerOptions(test),
      onPortOwnershipAcquired: () => { throw failure; },
      applicationFactory: ({ routes }) => {
        applicationCalls += 1;
        return { routes, close: () => undefined };
      },
    });
    owners.push(owner);

    await expect(owner.start()).rejects.toBe(failure);
    expect(applicationCalls).toBe(0);
    expect(owner.state).toBe("stopped");
    const releaseProbe = createServer();
    servers.push(releaseProbe);
    await listen(releaseProbe);
    await close(releaseProbe);
  });

  it("serializes startup cleanup reentry and retries only resources not proven closed", async () => {
    const scope = createResourceOwnershipScope();
    const failure = new Error("first cleanup failed");
    let failingCalls = 0;
    let successfulCalls = 0;
    let reentered: Promise<void> | undefined;
    scope.resources.register({
      close(): void {
        failingCalls += 1;
        if (failingCalls === 1) throw failure;
      },
    });
    scope.resources.register({
      close(): void {
        successfulCalls += 1;
        reentered = scope.close();
      },
    });

    const first = scope.close();
    await expect(first).rejects.toBe(failure);
    expect(reentered).toBe(first);
    expect(failingCalls).toBe(1);
    expect(successfulCalls).toBe(1);
    expect(scope.empty).toBe(false);

    await expect(scope.close()).resolves.toBeUndefined();
    expect(failingCalls).toBe(2);
    expect(successfulCalls).toBe(1);
    expect(scope.empty).toBe(true);
  });

  it("keeps replacement ownership across active cleanup and retries only the replacement", async () => {
    const scope = createResourceOwnershipScope();
    let originalCloses = 0;
    let replacementCloses = 0;
    let unrelatedCloses = 0;
    let releaseOriginal!: () => void;
    let originalEntered!: () => void;
    const originalGate = new Promise<void>((resolveGate) => { releaseOriginal = resolveGate; });
    const entered = new Promise<void>((resolveEntered) => { originalEntered = resolveEntered; });
    const registration = scope.resources.register({
      async close(): Promise<void> {
        originalCloses += 1;
        originalEntered();
        await originalGate;
      },
    });
    scope.resources.register({ close(): void { unrelatedCloses += 1; } });

    const firstClose = scope.close();
    await entered;
    registration.replace({ close(): void { replacementCloses += 1; } });
    expect(() => registration.transfer()).toThrow(
      "Owned resource registration is unavailable.",
    );
    releaseOriginal();
    await firstClose;

    expect(originalCloses).toBe(1);
    expect(unrelatedCloses).toBe(1);
    expect(replacementCloses).toBe(0);
    expect(scope.empty).toBe(false);
    await scope.close();
    expect(originalCloses).toBe(1);
    expect(unrelatedCloses).toBe(1);
    expect(replacementCloses).toBe(1);
    expect(scope.empty).toBe(true);
  });

  it("retains a replacement and its dependencies when the replaced cleanup fails", async () => {
    const scope = createResourceOwnershipScope();
    const events: string[] = [];
    let releaseOriginal!: () => void;
    let originalEntered!: () => void;
    const originalGate = new Promise<void>((resolveGate) => { releaseOriginal = resolveGate; });
    const entered = new Promise<void>((resolveEntered) => { originalEntered = resolveEntered; });
    scope.resources.register({ close(): void { events.push("dependency:close"); } });
    const registration = scope.resources.register({
      async close(): Promise<void> {
        events.push("original:close");
        originalEntered();
        await originalGate;
        throw new Error("original cleanup failed");
      },
    });

    const first = scope.close();
    await entered;
    registration.replace({ close(): void { events.push("replacement:close"); } });
    releaseOriginal();
    await expect(first).rejects.toThrow("original cleanup failed");
    expect(events).toEqual(["original:close"]);

    scope.seal();
    await scope.close();
    expect(events).toEqual(["original:close", "replacement:close", "dependency:close"]);
  });

  it("seals acquisition ownership and cannot revive a closed registration", async () => {
    const scope = createResourceOwnershipScope();
    let closes = 0;
    const registration = scope.resources.register({ close(): void { closes += 1; } });
    scope.seal();
    expect(scope.sealed).toBe(true);
    expect(() => scope.resources.register({ close(): void {} })).toThrow("scope is sealed");
    expect(() => registration.replace({ close(): void {} })).toThrow("registration is unavailable");
    expect(() => registration.transfer()).toThrow("registration is unavailable");
    await scope.close();
    expect(closes).toBe(1);
    expect(scope.empty).toBe(true);
    expect(() => registration.replace({ close(): void {} })).toThrow("registration is unavailable");
  });

  it("rejects duplicate identity and close-getter reentry without changing ownership", async () => {
    const duplicateScope = createResourceOwnershipScope();
    let duplicateCloses = 0;
    const duplicate = { close(): void { duplicateCloses += 1; } };
    duplicateScope.resources.register(duplicate);
    expect(() => duplicateScope.resources.register(duplicate)).toThrow("already registered");
    duplicateScope.seal();
    await duplicateScope.close();
    expect(duplicateCloses).toBe(1);

    const registerScope = createResourceOwnershipScope();
    expect(() => registerScope.resources.register({
      get close(): () => void {
        registerScope.seal();
        return () => undefined;
      },
    })).toThrow("mutation is active");
    expect(registerScope.sealed).toBe(false);
    expect(registerScope.empty).toBe(true);

    const replaceScope = createResourceOwnershipScope();
    let originalCloses = 0;
    let replacementCloses = 0;
    const registration = replaceScope.resources.register({ close(): void { originalCloses += 1; } });
    expect(() => registration.replace({
      get close(): () => void {
        registration.transfer();
        return () => { replacementCloses += 1; };
      },
    })).toThrow("mutation is active");
    expect(replaceScope.size).toBe(1);
    replaceScope.seal();
    await replaceScope.close();
    expect(originalCloses).toBe(1);
    expect(replacementCloses).toBe(0);
  });

  it("closes acquired dependencies in reverse order and retains earlier dependencies after failure", async () => {
    const scope = createResourceOwnershipScope();
    const events: string[] = [];
    let dependentCalls = 0;
    scope.resources.register({ close(): void { events.push("dependency:close"); } });
    scope.resources.register({
      close(): void {
        events.push("dependent:close");
        dependentCalls += 1;
        if (dependentCalls === 1) throw new Error("dependent close failed");
      },
    });
    scope.seal();

    await expect(scope.close()).rejects.toThrow("dependent close failed");
    expect(events).toEqual(["dependent:close"]);
    await scope.close();
    expect(events).toEqual(["dependent:close", "dependent:close", "dependency:close"]);
  });

  it("keeps the application and fixed port owned until a failed shutdown is retried", async () => {
    const test = await fixture();
    const peerDatabase = await ProductDatabase.open(test.paths.database, now);
    databases.push(peerDatabase);
    const closeFailure = new Error("application close failed");
    let closeCalls = 0;
    const owner = new FixedHttpOwner({
      ...fixedOwnerOptions(test),
      applicationFactory: ({ routes }) => ({
        routes,
        close(): void {
          closeCalls += 1;
          if (closeCalls === 1) throw closeFailure;
        },
      }),
    });
    const peer = new FixedHttpOwner({
      ...fixedOwnerOptions(test, peerDatabase),
    });
    owners.push(owner, peer);
    await owner.start();

    const first = owner.stop();
    expect(owner.stop()).toBe(first);
    await expect(first).rejects.toBe(closeFailure);
    expect(owner.state).toBe("stopping");
    expect(closeCalls).toBe(1);
    await expect(peer.start()).rejects.toMatchObject({
      failure: { error: { code: "port_conflict" } },
    });
    expect(peer.state).toBe("stopped");

    const retry = owner.stop();
    expect(retry).not.toBe(first);
    await retry;
    expect(closeCalls).toBe(2);
    expect(owner.state).toBe("stopped");

    const releaseProbe = createServer();
    servers.push(releaseProbe);
    await listen(releaseProbe);
    await close(releaseProbe);
  });

  it("installs the shared stop promise before synchronous abort listeners can reenter", async () => {
    const test = await fixture();
    let owner!: FixedHttpOwner;
    let reentered: Promise<void> | undefined;
    let closeCalls = 0;
    owner = new FixedHttpOwner({
      ...fixedOwnerOptions(test),
      applicationFactory: ({ routes, signal }) => {
        signal.addEventListener("abort", () => { reentered = owner.stop(); }, { once: true });
        return { routes, close: () => { closeCalls += 1; } };
      },
    });
    owners.push(owner);
    await owner.start();

    const stopping = owner.stop();
    await stopping;
    expect(reentered).toBe(stopping);
    expect(closeCalls).toBe(1);
  });

  it("requires the exact application-close permit before releasing the fixed port", async () => {
    const test = await fixture();
    const owner = new FixedHttpOwner({
      ...fixedOwnerOptions(test),
    });
    owners.push(owner);
    await owner.start();

    await expect(owner.releaseListener({ generation: 0 } as never)).rejects.toMatchObject({
      failure: { error: { code: "state_conflict" } },
    });
    expect(owner.state).toBe("owner");

    const closing = owner.closeApplication();
    expect(owner.closeApplication()).toBe(closing);
    const permit = await closing;
    expect(owner.state).toBe("stopping");
    const releasing = owner.releaseListener(permit);
    expect(owner.releaseListener(permit)).toBe(releasing);
    await expect(owner.releaseListener({ generation: permit.generation } as never)).rejects.toMatchObject({
      failure: { error: { code: "state_conflict" } },
    });
    await releasing;
    expect(owner.state).toBe("stopped");
  });

  it("seals the startup registry when application production completes", async () => {
    const test = await fixture();
    let retainedRegistry!: HttpOwnerApplicationContext["startupResources"];
    const owner = new FixedHttpOwner({
      ...fixedOwnerOptions(test),
      applicationFactory: ({ routes, startupResources }) => {
        retainedRegistry = startupResources;
        return { routes, close: () => undefined };
      },
    });
    owners.push(owner);
    await owner.start();

    expect(() => retainedRegistry.register({ close(): void {} })).toThrow("scope is sealed");
    await owner.stop();
  });

  it("rejects an application that leaves startup ownership behind and closes every retained resource", async () => {
    const test = await fixture();
    const events: string[] = [];
    const owner = new FixedHttpOwner({
      ...fixedOwnerOptions(test),
      applicationFactory: ({ routes, startupResources }) => {
        startupResources.register({ close(): void { events.push("startup:close"); } });
        return { routes, close: () => { events.push("application:close"); } };
      },
    });
    owners.push(owner);

    await expect(owner.start()).rejects.toThrow("retained startup resources");
    expect(events).toEqual(["application:close", "startup:close"]);
    expect(owner.state).toBe("stopped");
  });

  it("keeps the listener owned when startup cleanup fails and retries only unreleased resources", async () => {
    const test = await fixture();
    const peerDatabase = await ProductDatabase.open(test.paths.database, now);
    databases.push(peerDatabase);
    const cleanupFailure = new Error("application cleanup failed");
    let applicationCloseCalls = 0;
    let dependencyCloseCalls = 0;
    const owner = new FixedHttpOwner({
      ...fixedOwnerOptions(test),
      applicationFactory: ({ routes, startupResources }) => {
        startupResources.register({ close: () => { dependencyCloseCalls += 1; } });
        return {
          routes,
          close(): void {
            applicationCloseCalls += 1;
            if (applicationCloseCalls === 1) throw cleanupFailure;
          },
        };
      },
    });
    const peer = new FixedHttpOwner({
      ...fixedOwnerOptions(test, peerDatabase),
    });
    owners.push(owner, peer);

    const startupFailure = await owner.start().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(startupFailure).toBeInstanceOf(AggregateError);
    if (!(startupFailure instanceof AggregateError)) throw startupFailure;
    expect(startupFailure.errors).toEqual([
      expect.objectContaining({ message: "HTTP owner application retained startup resources." }),
      cleanupFailure,
    ]);
    expect(applicationCloseCalls).toBe(1);
    expect(dependencyCloseCalls).toBe(1);
    expect(owner.state).toBe("stopping");
    await expect(peer.start()).rejects.toMatchObject({
      failure: { error: { code: "port_conflict" } },
    });

    await owner.stop();
    expect(applicationCloseCalls).toBe(2);
    expect(dependencyCloseCalls).toBe(1);
    expect(owner.state).toBe("stopped");
  });

  it("does not close the same application twice when a factory registers and returns it", async () => {
    const test = await fixture();
    let closeCalls = 0;
    const owner = new FixedHttpOwner({
      ...fixedOwnerOptions(test),
      applicationFactory: ({ routes, startupResources }) => {
        const application = { routes, close: () => { closeCalls += 1; } };
        startupResources.register(application);
        return application;
      },
    });
    owners.push(owner);

    await expect(owner.start()).rejects.toThrow("already registered");
    expect(closeCalls).toBe(1);
    expect(owner.state).toBe("stopped");
  });

  it("classifies EADDRINUSE only when the fixed-port listen itself fails", async () => {
    const test = await fixture();
    const applicationFailure = Object.assign(new Error("application startup failed"), { code: "EADDRINUSE" });
    const owner = new FixedHttpOwner({
      ...fixedOwnerOptions(test),
      applicationFactory: () => { throw applicationFailure; },
    });
    owners.push(owner);

    await expect(owner.start()).rejects.toBe(applicationFailure);
    expect(owner.state).toBe("stopped");
  });

  it("aborts and awaits initial deferred-owner authentication during stop", async () => {
    const test = await fixture();
    test.database.ownerStore().publishOwner(
      Buffer.alloc(16, 12).toString("base64url"),
      test.configurationMac,
      now,
    );
    let resolveAuthentication!: () => void;
    const authenticationStarted = new Promise<void>((resolveStarted) => { resolveAuthentication = resolveStarted; });
    const foreign = createServer((request, response) => {
      if (classifyRawPeerRequest(request) !== "identity") {
        rejectRawPeerRequest(response);
        return;
      }
      resolveAuthentication();
    });
    servers.push(foreign);
    await listen(foreign);
    const candidate = new FixedHttpOwner({
      ...fixedOwnerOptions(test),
    });
    owners.push(candidate);
    const startOutcome = candidate.start().then((value) => value, (error: unknown) => error);
    await authenticationStarted;
    const stopping = candidate.stop();
    expect(await startOutcome).toMatchObject({ failure: { error: { code: "request_aborted" } } });
    await stopping;
    expect(candidate.state).toBe("stopped");
  });

  it("dispatches explicit request classes through one verified owner and takes over before delivery", async () => {
    const test = await fixture();
    const secondDatabase = await ProductDatabase.open(test.paths.database, now);
    databases.push(secondDatabase);
    let executions = 0;
    const applicationFactory = ({ routes }: HttpOwnerApplicationContext) => ({
      routes: routes.extend([
        {
          method: "GET",
          pathPattern: "/api/v1/internal/control/example",
          mutation: "none" as const,
          response: "canonical_json" as const,
          successStatus: 200,
          handler: async () => {
            executions += 1;
            return { ok: true as const, body: { executions, resource: "control" } };
          },
        },
        {
          method: "GET",
          pathPattern: "/api/v1/dispatch-example",
          mutation: "none" as const,
          response: "canonical_json" as const,
          successStatus: 200,
          handler: async () => {
            executions += 1;
            return { ok: true as const, body: { executions, resource: "public" } };
          },
        },
      ]),
      close: () => undefined,
    });
    const first = new FixedHttpOwner({
      ...fixedOwnerOptions(test), applicationFactory,
    });
    const second = new FixedHttpOwner({
      ...fixedOwnerOptions(test, secondDatabase), applicationFactory,
    });
    owners.push(first, second);
    expect(await first.start()).toBe("owner");
    expect(await second.start()).toBe("deferred");
    expect(await second.dispatchRuntimeRequest({
      requestClass: "public_read",
      method: "GET",
      path: "/api/v1/dispatch-example",
    })).toEqual({ status: 200, body: { executions: 1, resource: "public" } });
    expect(await second.dispatchRuntimeRequest({
      requestClass: "public_read",
      method: "GET",
      path: "/api/v1/internal/control/example",
    })).toMatchObject({ status: 401, body: { code: "unauthorized" } });
    expect(await second.dispatchRuntimeRequest({
      requestClass: "local_control",
      method: "GET",
      path: "/api/v1/dispatch-example",
    })).toMatchObject({ status: 401, body: { code: "unauthorized" } });
    expect(executions).toBe(1);
    expect(await second.dispatchRuntimeRequest({
      requestClass: "local_control",
      method: "GET",
      path: "/api/v1/internal/control/example",
    })).toEqual({ status: 200, body: { executions: 2, resource: "control" } });
    await first.stop();
    expect(await second.dispatchRuntimeRequest({
      requestClass: "public_read",
      method: "GET",
      path: "/api/v1/dispatch-example",
    })).toEqual({ status: 200, body: { executions: 3, resource: "public" } });
    expect(second.state).toBe("owner");
  });

  it("enforces the exact byte-counted public read response limit across a deferred owner", async () => {
    const test = await fixture();
    const secondDatabase = await ProductDatabase.open(test.paths.database, now);
    databases.push(secondDatabase);
    const envelopeBytes = Buffer.byteLength('{"value":"€"}\n');
    const value = `€${"x".repeat(publicReadResponseLimitBytes - envelopeBytes)}`;
    const oversizedValue = `${value}x`;
    expect(Buffer.byteLength(`${canonicalJsonStringify({ value })}\n`)).toBe(publicReadResponseLimitBytes);
    expect(Buffer.byteLength(`${canonicalJsonStringify({ value: oversizedValue })}\n`))
      .toBe(publicReadResponseLimitBytes + 1);
    expect(Buffer.byteLength(value)).toBeGreaterThan(internalResponseLimitBytes);
    const applicationFactory = ({ routes }: HttpOwnerApplicationContext) => ({
      routes: routes.extend([
        {
          method: "GET",
          pathPattern: "/api/v1/public-read-at-limit",
          mutation: "none" as const,
          response: "canonical_json" as const,
          successStatus: 200,
          handler: async () => ({ ok: true as const, body: { value } }),
        },
        {
          method: "GET",
          pathPattern: "/api/v1/public-read-over-limit",
          mutation: "none" as const,
          response: "canonical_json" as const,
          successStatus: 200,
          handler: async () => ({ ok: true as const, body: { value: oversizedValue } }),
        },
      ]),
      close: () => undefined,
    });
    const first = new FixedHttpOwner({
      ...fixedOwnerOptions(test), applicationFactory,
    });
    const second = new FixedHttpOwner({
      ...fixedOwnerOptions(test, secondDatabase), applicationFactory,
    });
    owners.push(first, second);

    expect(await first.start()).toBe("owner");
    expect(await second.start()).toBe("deferred");
    expect(await second.dispatchRuntimeRequest({
      requestClass: "public_read",
      method: "GET",
      path: "/api/v1/public-read-at-limit",
    })).toEqual({ status: 200, body: { value } });
    expect(await second.dispatchRuntimeRequest({
      requestClass: "public_read",
      method: "GET",
      path: "/api/v1/public-read-over-limit",
    })).toMatchObject({ status: 500, body: { code: "internal_error" } });
  });

  it("serves browser content through fixed headers without exposing an arbitrary header channel", async () => {
    const test = await fixture();
    const shell = "<!doctype html><html><head></head><body><div id=\"root\"></div></body></html>";
    const cookie =
      "example_session=token; Path=/api/v1/examples/example; Max-Age=60; HttpOnly; SameSite=Strict";
    const owner = new FixedHttpOwner({
      ...fixedOwnerOptions(test),
      applicationFactory: ({ routes }) => {
        const browserRoutes = routes.extendRequestPolicies({
          authenticationVerifiers: [],
          policies: [{
            requestClass: "browser_bootstrap",
            host: "fixed",
            origin: "absent",
            authentication: "none",
            body: "none",
            responseLimitBytes: 65_536,
            mutation: "none",
          }],
        }, [{
          kind: "route",
          method: "GET",
          pathPattern: "/examples/{operationId}",
          requestClass: "browser_bootstrap",
        }]);
        return {
          routes: browserRoutes.extend([{
            method: "GET",
            pathPattern: "/examples/{operationId}",
            mutation: "none",
            response: "browser_content",
            successStatus: 200,
            handler: async () => ({
              ok: true,
              body: shell,
              contentType: "text/html; charset=utf-8",
              setCookie: cookie,
            }),
          }]),
          close: () => undefined,
        };
      },
    });
    owners.push(owner);
    expect(await owner.start()).toBe("owner");

    const response = await requestText("/examples/example");
    expect(response.status).toBe(200);
    expect(response.body).toBe(shell);
    expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(response.headers["content-length"]).toBe(String(Buffer.byteLength(shell)));
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["content-security-policy"]).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; " +
      "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["cross-origin-opener-policy"]).toBe("same-origin");
    expect(response.headers["set-cookie"]).toEqual([cookie]);
  });

  it("binds browser authentication to the immutable matched path parameters before dispatch", async () => {
    const test = await fixture();
    let handlerCalls = 0;
    const owner = new FixedHttpOwner({
      ...fixedOwnerOptions(test),
      applicationFactory: ({ routes }) => {
        const securedRoutes = routes.extendRequestPolicies({
          authenticationVerifiers: [{
            authentication: "browser_resource",
            verify: (input) => input.authorization.length === 0 &&
              input.cookie.length === 1 && input.cookie[0] === "example_session=credential" &&
              input.csrfToken.length === 0 && Object.isFrozen(input.params) &&
              Object.getPrototypeOf(input.params) === null &&
              input.params["resourceId"] === "authorized-resource",
          }],
          policies: [{
            requestClass: "browser_read", host: "fixed", origin: "absent_or_fixed",
            authentication: "browser_resource", body: "none",
            responseLimitBytes: 65_536, mutation: "none",
          }],
        }, [{
          kind: "route", method: "GET",
          pathPattern: "/api/v1/examples/{resourceId}",
          requestClass: "browser_read",
        }]);
        return {
          routes: securedRoutes.extend([{
            method: "GET", mutation: "none",
            pathPattern: "/api/v1/examples/{resourceId}",
            response: "canonical_json", successStatus: 200,
            handler: async () => {
              handlerCalls += 1;
              return { ok: true, body: { authorized: true } };
            },
          }]),
          close: () => undefined,
        };
      },
    });
    owners.push(owner);
    expect(await owner.start()).toBe("owner");

    const cookie = { Cookie: "example_session=credential" };
    const accepted = await requestJson(
      "/api/v1/examples/authorized-resource",
      "GET",
      cookie,
    );
    expect(accepted).toMatchObject({ status: 200, body: { authorized: true } });

    const foreign = await requestJson(
      "/api/v1/examples/foreign-resource",
      "GET",
      cookie,
    );
    expect(foreign).toMatchObject({ status: 401, body: { code: "unauthorized" } });

    const acceptedMethodRejection = await requestJson(
      "/api/v1/examples/authorized-resource",
      "POST",
      cookie,
    );
    expect(acceptedMethodRejection.status).toBe(405);
    expect(acceptedMethodRejection.headers["allow"]).toBe("GET");

    const foreignMethodRejection = await requestJson(
      "/api/v1/examples/foreign-resource",
      "POST",
      cookie,
    );
    expect(foreignMethodRejection).toMatchObject({
      status: 401,
      body: { code: "unauthorized" },
    });
    expect(handlerCalls).toBe(1);
  });

  it("accepts standard formatted JSON while pinning the operation to the authenticated socket", async () => {
    const key = new Uint8Array(32).fill(16);
    const test = await fixture(key);
    const record = test.database.ownerStore().publishOwner(
      Buffer.alloc(16, 17).toString("base64url"), test.configurationMac, now,
    );
    let identityRequests = 0;
    let authenticatedSocket: IncomingMessage["socket"] | undefined;
    let operationSocket: IncomingMessage["socket"] | undefined;
    const authorizations: string[] = [];
    const compatible = createServer((request, response) => {
      const requestKind = classifyRawPeerRequest(request);
      if (requestKind === "unrelated") {
        rejectRawPeerRequest(response);
        return;
      }
      if (requestKind === "identity") {
        identityRequests += 1;
        if (identityRequests === 2) authenticatedSocket = request.socket;
        const identityWithoutProof = {
          profileId: record.profileId,
          ownerInstanceId: record.ownerInstanceId,
          runtimeProtocolVersion: 2 as const,
          configurationMac: record.configurationMac,
          challenge: request.headers["littlejohn-identity-challenge"] as string,
          ownerRevision: record.ownerRevision,
        };
        formattedJsonResponse(response, 200, {
          ...identityWithoutProof,
          proof: independentProof(key, identityWithoutProof),
        });
        return;
      }
      operationSocket = request.socket;
      const authorization = request.headers["authorization"];
      if (typeof authorization === "string") authorizations.push(authorization);
      formattedJsonResponse(response, 200, { served: true });
    });
    servers.push(compatible);
    await listen(compatible);
    const candidate = new FixedHttpOwner({
      ...fixedOwnerOptions(test),
    });
    owners.push(candidate);
    expect(await candidate.start()).toBe("deferred");
    expect(await candidate.dispatchRuntimeRequest({ requestClass: "local_control", method: "GET", path: "/api/v1/internal/control/example" }))
      .toEqual({ status: 200, body: { served: true } });
    expect(identityRequests).toBe(2);
    expect(authenticatedSocket).toBeDefined();
    expect(operationSocket).toBe(authenticatedSocket);
    expect(authorizations).toEqual([await credentialAuthorization(test.paths.controlCredential)]);
  });

  it("keeps an authenticated operation alive after its exact-socket dispatch deadline", async () => {
    const key = new Uint8Array(32).fill(22);
    const test = await fixture(key);
    const record = test.database.ownerStore().publishOwner(
      Buffer.alloc(16, 23).toString("base64url"), test.configurationMac, now,
    );
    let identityRequests = 0;
    let operationRequests = 0;
    const compatible = createServer((request, response) => {
      const requestKind = classifyRawPeerRequest(request);
      if (requestKind === "unrelated") {
        rejectRawPeerRequest(response);
        return;
      }
      if (requestKind === "identity") {
        identityRequests += 1;
        const identityWithoutProof = {
          profileId: record.profileId,
          ownerInstanceId: record.ownerInstanceId,
          runtimeProtocolVersion: 2 as const,
          configurationMac: record.configurationMac,
          challenge: request.headers["littlejohn-identity-challenge"] as string,
          ownerRevision: record.ownerRevision,
        };
        canonicalResponse(response, 200, {
          ...identityWithoutProof,
          proof: independentProof(key, identityWithoutProof),
        } as unknown as CanonicalJson);
        return;
      }
      operationRequests += 1;
      setTimeout(() => canonicalResponse(response, 200, { completed: true }), 2_250);
    });
    servers.push(compatible);
    await listen(compatible);
    const candidate = new FixedHttpOwner({
      ...fixedOwnerOptions(test),
    });
    owners.push(candidate);
    expect(await candidate.start()).toBe("deferred");
    expect(await requestText(`/api/v1/examples/${"A".repeat(43)}`))
      .toMatchObject({ status: 404, body: "" });
    expect(await candidate.dispatchRuntimeRequest({ requestClass: "local_control", method: "GET", path: "/api/v1/internal/control/example" }))
      .toEqual({ status: 200, body: { completed: true } });
    expect(identityRequests).toBe(2);
    expect(operationRequests).toBe(1);
  });

  it("does not send or retry an operation on a replacement connection at the same port", async () => {
    const key = new Uint8Array(32).fill(18);
    const test = await fixture(key);
    const record = test.database.ownerStore().publishOwner(
      Buffer.alloc(16, 19).toString("base64url"), test.configurationMac, now,
    );
    let identityRequests = 0;
    let originalOperationRequests = 0;
    let replacementRequests = 0;
    let replacementMode = false;
    let authenticatedSocket: IncomingMessage["socket"] | undefined;
    const originalAuthorizations: string[] = [];
    const replacementAuthorizations: string[] = [];
    const original = createServer((request, response) => {
      const requestKind = classifyRawPeerRequest(request);
      if (requestKind === "unrelated") {
        rejectRawPeerRequest(response);
        return;
      }
      if (requestKind === "operation" && replacementMode && request.socket !== authenticatedSocket) {
        replacementRequests += 1;
        const authorization = request.headers["authorization"];
        if (typeof authorization === "string") replacementAuthorizations.push(authorization);
        request.socket.destroy();
        return;
      }
      if (requestKind === "operation") {
        originalOperationRequests += 1;
        const authorization = request.headers["authorization"];
        if (typeof authorization === "string") originalAuthorizations.push(authorization);
        request.socket.destroy();
        return;
      }
      identityRequests += 1;
      const identityWithoutProof = {
        profileId: record.profileId,
        ownerInstanceId: record.ownerInstanceId,
        runtimeProtocolVersion: 2 as const,
        configurationMac: record.configurationMac,
        challenge: request.headers["littlejohn-identity-challenge"] as string,
        ownerRevision: record.ownerRevision,
      };
      if (identityRequests === 1) {
        canonicalResponse(response, 200, {
          ...identityWithoutProof,
          proof: independentProof(key, identityWithoutProof),
        } as unknown as CanonicalJson);
        return;
      }
      const identitySocket = request.socket;
      authenticatedSocket = identitySocket;
      replacementMode = true;
      const body = `${canonicalJsonStringify({
        ...identityWithoutProof,
        proof: independentProof(key, identityWithoutProof),
      } as unknown as CanonicalJson)}\n`;
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store",
        Connection: "close",
      });
      response.once("finish", () => setTimeout(() => identitySocket.destroy(), 10));
      response.end(body);
    });
    servers.push(original);
    await listen(original);
    const candidate = new FixedHttpOwner({
      ...fixedOwnerOptions(test),
    });
    owners.push(candidate);
    expect(await candidate.start()).toBe("deferred");
    const operation = candidate.dispatchRuntimeRequest({ requestClass: "local_control",
      method: "GET", path: "/api/v1/internal/control/example",
    }).then(
      (value) => ({ kind: "settled" as const, value }),
      (error: unknown) => ({ kind: "settled" as const, error }),
    );
    let resolveHarnessDeadline!: () => void;
    const harnessDeadline = new Promise<{ readonly kind: "harness_deadline" }>((resolveDeadline) => {
      resolveHarnessDeadline = () => resolveDeadline({ kind: "harness_deadline" });
    });
    const harnessTimer = setTimeout(resolveHarnessDeadline, 3_000);
    let resolveEarlyObservation!: () => void;
    const earlyObservation = new Promise<{ readonly kind: "early_unsettled" }>((resolveEarly) => {
      resolveEarlyObservation = () => resolveEarly({ kind: "early_unsettled" });
    });
    const earlyTimer = setTimeout(resolveEarlyObservation, 500);
    const earlyOutcome = await Promise.race([
      operation,
      earlyObservation,
    ]);
    clearTimeout(earlyTimer);
    expect(earlyOutcome).toEqual({ kind: "early_unsettled" });
    expect(identityRequests).toBe(2);
    expect(originalOperationRequests).toBe(0);
    expect(originalAuthorizations).toEqual([]);
    expect(replacementRequests).toBe(0);
    expect(replacementAuthorizations).toEqual([]);

    const finalOutcome = await Promise.race([operation, harnessDeadline]);
    clearTimeout(harnessTimer);
    expect(finalOutcome).toMatchObject({
      kind: "settled",
      error: { failure: { error: { code: "runtime_state_unavailable" } } },
    });
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
    expect(identityRequests).toBe(2);
    expect(originalOperationRequests).toBe(0);
    expect(originalAuthorizations).toEqual([]);
    expect(replacementRequests).toBe(0);
    expect(replacementAuthorizations).toEqual([]);
  });

  it("rejects a foreign proof and a replayed identity without sending a control credential", async () => {
    const key = new Uint8Array(32).fill(4);
    const test = await fixture(key);
    const record = test.database.ownerStore().publishOwner(
      Buffer.alloc(16, 5).toString("base64url"), test.configurationMac, now,
    );
    let firstChallenge: string | undefined;
    const authorizations: string[] = [];
    const foreign = createServer((request, response) => {
      const requestKind = classifyRawPeerRequest(request);
      if (requestKind === "unrelated") {
        rejectRawPeerRequest(response);
        return;
      }
      const authorization = request.headers["authorization"];
      if (typeof authorization === "string") authorizations.push(authorization);
      if (requestKind === "operation") {
        rejectRawPeerRequest(response);
        return;
      }
      const current = request.headers["littlejohn-identity-challenge"] as string;
      firstChallenge ??= current;
      const identityWithoutProof = {
        profileId: record.profileId,
        ownerInstanceId: record.ownerInstanceId,
        runtimeProtocolVersion: 2 as const,
        configurationMac: record.configurationMac,
        challenge: firstChallenge,
        ownerRevision: record.ownerRevision,
      };
      canonicalResponse(response, 200, {
        ...identityWithoutProof,
        proof: independentProof(key, identityWithoutProof),
      } as unknown as CanonicalJson);
    });
    servers.push(foreign);
    await listen(foreign);
    const candidate = new FixedHttpOwner({
      ...fixedOwnerOptions(test),
    });
    owners.push(candidate);
    expect(await candidate.start()).toBe("deferred");
    await expect(candidate.dispatchRuntimeRequest({ requestClass: "local_control", method: "GET", path: "/api/v1/internal/control/example" }))
      .rejects.toMatchObject({ failure: { error: { code: "port_conflict" } } });
    expect(authorizations).toEqual([]);
  });

  it("rejects every owner identity field and transport invariant before disclosing the credential", async () => {
    const key = new Uint8Array(32).fill(14);
    const test = await fixture(key);
    const record = test.database.ownerStore().publishOwner(
      Buffer.alloc(16, 15).toString("base64url"), test.configurationMac, now,
    );
    const cases: readonly {
      readonly name: string;
      readonly response: (
        request: IncomingMessage,
        response: ServerResponse,
        valid: IndependentProofFields,
      ) => void;
    }[] = [
      {
        name: "challenge",
        response: (_request, response, valid) => {
          const changed = { ...valid, challenge: Buffer.alloc(32, 1).toString("base64url") };
          canonicalResponse(response, 200, { ...changed, proof: independentProof(key, changed) } as unknown as CanonicalJson);
        },
      },
      {
        name: "profile",
        response: (_request, response, valid) => {
          const changed = { ...valid, profileId: Buffer.alloc(16, 2).toString("base64url") };
          canonicalResponse(response, 200, { ...changed, proof: independentProof(key, changed) } as unknown as CanonicalJson);
        },
      },
      {
        name: "protocol version",
        response: (_request, response, valid) => {
          const changed = { ...valid, runtimeProtocolVersion: 1 };
          canonicalResponse(response, 200, { ...changed, proof: independentProof(key, changed) } as unknown as CanonicalJson);
        },
      },
      {
        name: "configuration MAC",
        response: (_request, response, valid) => {
          const changed = { ...valid, configurationMac: Buffer.alloc(32, 6).toString("base64url") };
          canonicalResponse(response, 200, { ...changed, proof: independentProof(key, changed) } as unknown as CanonicalJson);
        },
      },
      {
        name: "owner instance",
        response: (_request, response, valid) => {
          const changed = { ...valid, ownerInstanceId: Buffer.alloc(16, 3).toString("base64url") };
          canonicalResponse(response, 200, { ...changed, proof: independentProof(key, changed) } as unknown as CanonicalJson);
        },
      },
      {
        name: "owner revision",
        response: (_request, response, valid) => {
          const changed = { ...valid, ownerRevision: (BigInt(valid.ownerRevision) + 1n).toString(10) };
          canonicalResponse(response, 200, { ...changed, proof: independentProof(key, changed) } as unknown as CanonicalJson);
        },
      },
      {
        name: "proof",
        response: (_request, response, valid) => canonicalResponse(response, 200, {
          ...valid,
          proof: Buffer.alloc(32, 4).toString("base64url"),
        } as unknown as CanonicalJson),
      },
      {
        name: "extra field",
        response: (_request, response, valid) => canonicalResponse(response, 200, {
          ...valid,
          proof: independentProof(key, valid),
          extra: "forged",
        } as unknown as CanonicalJson),
      },
      {
        name: "content type",
        response: (_request, response, valid) => {
          const body = `${canonicalJsonStringify({ ...valid, proof: independentProof(key, valid) } as unknown as CanonicalJson)}\n`;
          response.writeHead(200, {
            "Content-Type": "text/plain",
            "Content-Length": Buffer.byteLength(body),
            "Cache-Control": "no-store",
          });
          response.end(body);
        },
      },
      {
        name: "cache policy",
        response: (_request, response, valid) => {
          const body = `${canonicalJsonStringify({ ...valid, proof: independentProof(key, valid) } as unknown as CanonicalJson)}\n`;
          response.writeHead(200, {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          });
          response.end(body);
        },
      },
    ];

    for (const testCase of cases) {
      const authorizations: string[] = [];
      const foreign = createServer((request, response) => {
        const requestKind = classifyRawPeerRequest(request);
        if (requestKind === "unrelated") {
          rejectRawPeerRequest(response);
          return;
        }
        const authorization = request.headers["authorization"];
        if (typeof authorization === "string") authorizations.push(authorization);
        if (requestKind === "operation") {
          rejectRawPeerRequest(response);
          return;
        }
        const valid: IndependentProofFields = {
          profileId: record.profileId,
          ownerInstanceId: record.ownerInstanceId,
          runtimeProtocolVersion: 2,
          configurationMac: record.configurationMac,
          challenge: request.headers["littlejohn-identity-challenge"] as string,
          ownerRevision: record.ownerRevision,
        };
        testCase.response(request, response, valid);
      });
      servers.push(foreign);
      await listen(foreign);
      const candidate = new FixedHttpOwner({
        ...fixedOwnerOptions(test),
      });
      owners.push(candidate);
      await expect(candidate.start(), testCase.name)
        .rejects.toMatchObject({ failure: { error: { code: "port_conflict" } } });
      expect(authorizations, testCase.name).toEqual([]);
      await candidate.stop();
      await close(foreign);
    }
  });

  it("closes an oversized identity stream before the server can deliver the full response", async () => {
    const test = await fixture();
    const chunk = Buffer.alloc(16_384, 0x61);
    const totalBytes = 4 * 1024 * 1024;
    let attemptedBytes = 0;
    let resolveClientClosed!: () => void;
    const clientClosed = new Promise<void>((resolveClosed) => { resolveClientClosed = resolveClosed; });
    let resolveStreaming!: () => void;
    let rejectStreaming!: (error: Error) => void;
    const streamingFinished = new Promise<void>((resolveFinished, rejectFinished) => {
      resolveStreaming = resolveFinished;
      rejectStreaming = rejectFinished;
    });
    const foreign = createServer((request, response) => {
      if (classifyRawPeerRequest(request) !== "identity") {
        rejectRawPeerRequest(response);
        return;
      }
      let closed = false;
      response.once("close", () => {
        closed = true;
        resolveClientClosed();
      });
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      void (async () => {
        while (!closed && attemptedBytes < totalBytes) {
          const writable = response.write(chunk);
          attemptedBytes += chunk.length;
          await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
          if (!writable && !closed) {
            await new Promise<void>((resolveWritable) => {
              const done = (): void => {
                response.off("drain", done);
                response.off("close", done);
                resolveWritable();
              };
              response.once("drain", done);
              response.once("close", done);
            });
          }
        }
        if (!closed) response.end();
      })().then(resolveStreaming, (error: unknown) => {
        rejectStreaming(error instanceof Error ? error : new Error("Identity stream failed."));
      });
    });
    servers.push(foreign);
    await listen(foreign);
    const candidate = new FixedHttpOwner({
      ...fixedOwnerOptions(test),
    });
    owners.push(candidate);
    await expect(candidate.start())
      .rejects.toMatchObject({ failure: { error: { code: "port_conflict" } } });
    await clientClosed;
    await streamingFinished;
    expect(attemptedBytes).toBeGreaterThan(65_536);
    expect(attemptedBytes).toBeLessThan(totalBytes);
  });

  it("does not resend an operation whose delivery result is uncertain", async () => {
    const key = new Uint8Array(32).fill(6);
    const test = await fixture(key);
    const record = test.database.ownerStore().publishOwner(
      Buffer.alloc(16, 7).toString("base64url"), test.configurationMac, now,
    );
    let identityRequests = 0;
    let operationRequests = 0;
    const foreign = createServer((request, response) => {
      const requestKind = classifyRawPeerRequest(request);
      if (requestKind === "unrelated") {
        rejectRawPeerRequest(response);
        return;
      }
      if (requestKind === "identity") {
        identityRequests += 1;
        const identityWithoutProof = {
          profileId: record.profileId,
          ownerInstanceId: record.ownerInstanceId,
          runtimeProtocolVersion: 2 as const,
          configurationMac: record.configurationMac,
          challenge: request.headers["littlejohn-identity-challenge"] as string,
          ownerRevision: record.ownerRevision,
        };
        canonicalResponse(response, 200, {
          ...identityWithoutProof,
          proof: independentProof(key, identityWithoutProof),
        } as unknown as CanonicalJson);
        return;
      }
      operationRequests += 1;
      request.socket.destroy();
    });
    servers.push(foreign);
    await listen(foreign);
    const candidate = new FixedHttpOwner({
      ...fixedOwnerOptions(test),
    });
    owners.push(candidate);
    expect(await candidate.start()).toBe("deferred");
    await expect(candidate.dispatchRuntimeRequest({ requestClass: "local_control", method: "GET", path: "/api/v1/internal/control/example" }))
      .rejects.toMatchObject({ failure: { error: { code: "runtime_state_unavailable" } } });
    expect(identityRequests).toBe(2);
    expect(operationRequests).toBe(1);
  });

  it("stops a deferred operation during owner authentication without sending the credential", async () => {
    const key = new Uint8Array(32).fill(8);
    const test = await fixture(key);
    const record = test.database.ownerStore().publishOwner(
      Buffer.alloc(16, 9).toString("base64url"), test.configurationMac, now,
    );
    let identityRequests = 0;
    const authorizations: string[] = [];
    let resolveAuthentication!: () => void;
    const authenticationStarted = new Promise<void>((resolveStarted) => { resolveAuthentication = resolveStarted; });
    const foreign = createServer((request, response) => {
      const requestKind = classifyRawPeerRequest(request);
      if (requestKind === "unrelated") {
        rejectRawPeerRequest(response);
        return;
      }
      const authorization = request.headers["authorization"];
      if (typeof authorization === "string") authorizations.push(authorization);
      if (requestKind === "operation") {
        rejectRawPeerRequest(response);
        return;
      }
      identityRequests += 1;
      if (identityRequests === 2) {
        resolveAuthentication();
        return;
      }
      const identityWithoutProof = {
        profileId: record.profileId,
        ownerInstanceId: record.ownerInstanceId,
        runtimeProtocolVersion: 2 as const,
        configurationMac: record.configurationMac,
        challenge: request.headers["littlejohn-identity-challenge"] as string,
        ownerRevision: record.ownerRevision,
      };
      canonicalResponse(response, 200, {
        ...identityWithoutProof,
        proof: independentProof(key, identityWithoutProof),
      } as unknown as CanonicalJson);
    });
    servers.push(foreign);
    await listen(foreign);
    const candidate = new FixedHttpOwner({
      ...fixedOwnerOptions(test),
    });
    owners.push(candidate);
    expect(await candidate.start()).toBe("deferred");
    const operationOutcome = candidate.dispatchRuntimeRequest({ requestClass: "local_control",
      method: "GET", path: "/api/v1/internal/control/example",
    }).then((value) => value, (error: unknown) => error);
    await authenticationStarted;
    await candidate.stop();
    const operationError = await operationOutcome;
    expect(operationError).toMatchObject({ failure: { error: { code: "request_aborted" } } });
    expect(candidate.state).toBe("stopped");
    expect(identityRequests).toBe(2);
    expect(authorizations).toEqual([]);
  });

  it("waits for an aborted delivered owner operation and never resends it during stop", async () => {
    const key = new Uint8Array(32).fill(10);
    const test = await fixture(key);
    const record = test.database.ownerStore().publishOwner(
      Buffer.alloc(16, 11).toString("base64url"), test.configurationMac, now,
    );
    let identityRequests = 0;
    let operationRequests = 0;
    let resolveDelivery!: () => void;
    const delivered = new Promise<void>((resolveDelivered) => { resolveDelivery = resolveDelivered; });
    const foreign = createServer((request, response) => {
      const requestKind = classifyRawPeerRequest(request);
      if (requestKind === "unrelated") {
        rejectRawPeerRequest(response);
        return;
      }
      if (requestKind === "identity") {
        identityRequests += 1;
        const identityWithoutProof = {
          profileId: record.profileId,
          ownerInstanceId: record.ownerInstanceId,
          runtimeProtocolVersion: 2 as const,
          configurationMac: record.configurationMac,
          challenge: request.headers["littlejohn-identity-challenge"] as string,
          ownerRevision: record.ownerRevision,
        };
        canonicalResponse(response, 200, {
          ...identityWithoutProof,
          proof: independentProof(key, identityWithoutProof),
        } as unknown as CanonicalJson);
        return;
      }
      operationRequests += 1;
      resolveDelivery();
    });
    servers.push(foreign);
    await listen(foreign);
    const candidate = new FixedHttpOwner({
      ...fixedOwnerOptions(test),
    });
    owners.push(candidate);
    expect(await candidate.start()).toBe("deferred");
    let operationSettled = false;
    const operationOutcome = candidate.dispatchRuntimeRequest({ requestClass: "local_control",
      method: "GET", path: "/api/v1/internal/control/example",
    }).then(
      (value) => { operationSettled = true; return value; },
      (error: unknown) => { operationSettled = true; return error; },
    );
    await delivered;
    await candidate.stop();
    expect(operationSettled).toBe(true);
    expect(await operationOutcome).toMatchObject({ failure: { error: { code: "request_aborted" } } });
    expect(candidate.state).toBe("stopped");
    expect(identityRequests).toBe(2);
    expect(operationRequests).toBe(1);
  });

  it("cancels initialization and closes a late application before completing stop", async () => {
    const test = await fixture();
    let context: HttpOwnerApplicationContext | undefined;
    let release!: () => void;
    let closes = 0;
    const pending = new Promise<void>((resolvePending) => { release = resolvePending; });
    const owner = new FixedHttpOwner({
      ...fixedOwnerOptions(test),
      applicationFactory: async (input) => {
        context = input;
        await pending;
        return { routes: input.routes, close: () => { closes += 1; } };
      },
    });
    owners.push(owner);
    const starting = owner.start();
    while (context === undefined) await new Promise<void>((resolveTick) => setImmediate(resolveTick));
    const stopping = owner.stop();
    expect(context.signal.aborted).toBe(true);
    let stopSettled = false;
    void stopping.then(() => { stopSettled = true; });
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));
    expect(stopSettled).toBe(false);
    expect(closes).toBe(0);
    release();
    await expect(starting).rejects.toMatchObject({ failure: { error: { code: "request_aborted" } } });
    await stopping;
    expect(stopSettled).toBe(true);
    expect(closes).toBe(1);
    expect(owner.state).toBe("stopped");
  });

  it("reports late startup cleanup failure while concurrent stop retries the same application", async () => {
    const test = await fixture();
    let context: HttpOwnerApplicationContext | undefined;
    let release!: () => void;
    let closeCalls = 0;
    const closeFailure = new Error("late application close failed");
    const pending = new Promise<void>((resolvePending) => { release = resolvePending; });
    let application: {
      readonly routes: HttpOwnerApplicationContext["routes"];
      close(): void;
    } | undefined;
    const owner = new FixedHttpOwner({
      ...fixedOwnerOptions(test),
      applicationFactory: async (input) => {
        context = input;
        application = {
          routes: input.routes,
          close(): void {
            closeCalls += 1;
            if (closeCalls === 1) throw closeFailure;
          },
        };
        await pending;
        return application;
      },
    });
    owners.push(owner);
    const starting = owner.start();
    while (context === undefined) await new Promise<void>((resolveTick) => setImmediate(resolveTick));
    const stopping = owner.stop();
    release();

    const startupFailure = await starting.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(startupFailure).toBeInstanceOf(AggregateError);
    if (!(startupFailure instanceof AggregateError)) throw startupFailure;
    expect(startupFailure.errors).toHaveLength(2);
    expect(startupFailure.errors[0]).toMatchObject({ failure: { error: { code: "request_aborted" } } });
    expect(startupFailure.errors[1]).toBe(closeFailure);
    await stopping;
    expect(closeCalls).toBe(2);
    expect(owner.state).toBe("stopped");
    await owner.stop();
    expect(closeCalls).toBe(2);
  });

  it("awaits an abort-ignoring inbound handler before closing the application and completing stop", async () => {
    const test = await fixture();
    let release!: () => void;
    let entered!: (signal: AbortSignal) => void;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    const handlerEntered = new Promise<AbortSignal>((resolveEntered) => { entered = resolveEntered; });
    let handlerFinished = false;
    let applicationClosed = false;
    let handlerCalls = 0;
    const lifecycleEvents: string[] = [];
    const owner = new FixedHttpOwner({
      ...fixedOwnerOptions(test),
      applicationFactory: ({ routes }) => ({
        routes: routes.extend([{
          method: "GET",
          pathPattern: "/api/v1/internal/control/example",
          mutation: "none" as const,
          response: "canonical_json" as const, successStatus: 200,
          handler: async ({ signal }) => {
            handlerCalls += 1;
            entered(signal);
            await gate;
            handlerFinished = true;
            lifecycleEvents.push("handler:finish");
            return { ok: true, body: {} };
          },
        }]),
        close: () => {
          applicationClosed = true;
          lifecycleEvents.push("application:close");
        },
      }),
    });
    owners.push(owner);
    await owner.start();
    const authorization = await credentialAuthorization(test.paths.controlCredential);
    const request = requestJson(
      "/api/v1/internal/control/example", "GET", { Authorization: authorization },
    ).then((value) => value, (error: unknown) => error);
    const handlerSignal = await handlerEntered;
    const stopping = owner.stop();
    let stopSettled = false;
    void stopping.then(() => { stopSettled = true; });
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));
    expect(handlerSignal.aborted).toBe(true);
    expect(stopSettled).toBe(false);
    expect(handlerFinished).toBe(false);
    expect(applicationClosed).toBe(false);
    expect(handlerCalls).toBe(1);
    const blocked = await requestJson(
      "/api/v1/internal/control/example", "GET", { Authorization: authorization },
    );
    expect(blocked).toMatchObject({ status: 408, body: { code: "request_aborted" } });
    expect(handlerCalls).toBe(1);
    release();
    await stopping;
    await request;
    expect(handlerFinished).toBe(true);
    expect(applicationClosed).toBe(true);
    expect(stopSettled).toBe(true);
    expect(lifecycleEvents).toEqual(["handler:finish", "application:close"]);
    expect(owner.state).toBe("stopped");
  });

  it("rejects malformed UTF-8 before the handler and derives the connection-attempt status", async () => {
    const test = await fixture();
    let handlerCalls = 0;
    const owner = new FixedHttpOwner({
      ...fixedOwnerOptions(test),
      applicationFactory: ({ routes }) => ({
        routes: routes.extend([{
          method: "POST",
          pathPattern: "/api/v1/internal/control/examples",
          mutation: "declared_control" as const,
          response: "canonical_json" as const, successStatus: 201,
          handler: async () => {
            handlerCalls += 1;
            return { ok: true, body: { accepted: true } };
          },
        }]),
        close: () => undefined,
      }),
    });
    owners.push(owner);
    await owner.start();
    const authorization = await credentialAuthorization(test.paths.controlCredential);
    const malformed = await requestJson(
      "/api/v1/internal/control/examples",
      "POST",
      { Authorization: authorization, "Content-Type": "application/json", "Content-Length": "1" },
      Buffer.from([0xff]),
    );
    expect(malformed).toMatchObject({ status: 400, body: { code: "invalid_json" } });
    expect(handlerCalls).toBe(0);

    const body = "{}";
    const accepted = await requestJson(
      "/api/v1/internal/control/examples",
      "POST",
      { Authorization: authorization, "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)) },
      body,
    );
    expect(accepted).toMatchObject({ status: 201, body: { accepted: true } });
    expect(handlerCalls).toBe(1);
  });

  it("enforces the global envelope and matched-path request class before method errors", async () => {
    const test = await fixture();
    const owner = new FixedHttpOwner({
      ...fixedOwnerOptions(test),
      applicationFactory: ({ routes }) => ({
        routes: routes.extend([{
          method: "GET",
          pathPattern: "/api/v1/internal/control/example",
          mutation: "none" as const,
          response: "canonical_json" as const, successStatus: 200,
          handler: async () => ({ ok: true, body: {} }),
        }]),
        close: () => undefined,
      }),
    });
    owners.push(owner);
    await owner.start();
    const authorization = await credentialAuthorization(test.paths.controlCredential);

    const invalidHost = await requestJson(
      "/api/v1/internal/control/example", "POST", { Host: "localhost:46630" },
    );
    expect(invalidHost).toMatchObject({ status: 400, body: { code: "invalid_host" } });
    const invalidQuery = await requestJson("/api/v1/internal/control/example?x=1", "POST");
    expect(invalidQuery).toMatchObject({ status: 400, body: { code: "query_not_supported" } });
    const invalidOrigin = await requestJson(
      "/api/v1/internal/control/example", "POST", { Origin: "http://127.0.0.1:46630" },
    );
    expect(invalidOrigin).toMatchObject({ status: 403, body: { code: "invalid_origin" } });
    const unauthorized = await requestJson("/api/v1/internal/control/example", "POST");
    expect(unauthorized).toMatchObject({ status: 401, body: { code: "unauthorized" } });
    const oversized = await requestJson(
      "/api/v1/internal/control/example",
      "POST",
      { "Content-Length": "65537" },
      Buffer.alloc(65_537),
    );
    expect(oversized).toMatchObject({ status: 413, body: { code: "payload_too_large" } });
    const method = await requestJson(
      "/api/v1/internal/control/example", "POST", { Authorization: authorization },
    );
    expect(method).toMatchObject({ status: 405, body: { code: "method_not_allowed" } });
    expect(method.headers["allow"]).toBe("GET");

    const unknownQuery = await requestJson("/api/v1/internal/control/unknown?x=1");
    expect(unknownQuery).toMatchObject({ status: 400, body: { code: "query_not_supported" } });
    const unknown = await requestJson("/api/v1/internal/control/unknown");
    expect(unknown).toMatchObject({ status: 404, body: { code: "route_not_found" } });
  });

  it("does not invoke a handler after a request body is abandoned", async () => {
    const test = await fixture();
    let handlerCalls = 0;
    const owner = new FixedHttpOwner({
      ...fixedOwnerOptions(test),
      applicationFactory: ({ routes }) => ({
        routes: routes.extend([{
          method: "POST",
          pathPattern: "/api/v1/internal/control/examples",
          mutation: "declared_control" as const,
          response: "canonical_json" as const, successStatus: 201,
          handler: async () => {
            handlerCalls += 1;
            return { ok: true, body: {} };
          },
        }]),
        close: () => undefined,
      }),
    });
    owners.push(owner);
    await owner.start();
    const authorization = await credentialAuthorization(test.paths.controlCredential);
    const socket = connectSocket({ host: fixedHost, port: fixedPort });
    await new Promise<void>((resolveConnect, reject) => {
      socket.once("connect", resolveConnect);
      socket.once("error", reject);
    });
    socket.write([
      "POST /api/v1/internal/control/examples HTTP/1.1",
      `Host: ${fixedHostHeader}`,
      `Authorization: ${authorization}`,
      "Content-Type: application/json",
      "Content-Length: 20",
      "",
      "{",
    ].join("\r\n"));
    socket.destroy();
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    expect(handlerCalls).toBe(0);
  });
});
