import { canonicalRelativePath } from "./release-support.mjs";

/** @type {typeof import("./packaged-owner-worker-source.d.mts").renderPackagedOwnerWorkerSource} */
export const renderPackagedOwnerWorkerSource = (packageInstallRelativePath) => {
  const packageRoot = canonicalRelativePath(packageInstallRelativePath);
  if (!packageRoot.startsWith("node_modules/")) {
    throw new TypeError("Release worker package path is invalid.");
  }
  const packageModule = (path) =>
    JSON.stringify(`./${packageRoot}/dist/${canonicalRelativePath(path)}`);
  return String.raw`
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createChainOwnerApplication } from ${packageModule("chain/application.js")};
import { createInterfaceOwnerApplication } from ${packageModule("interfaces/application.js")};
import { createSourcifyContractSourceVerification } from ${packageModule("intelligence/sourcify.js")};
import {
  createRobinhoodOfficialAssetSourceClient,
  officialAssetSourceDefinition,
} from ${packageModule("registry/index.js")};
import { ProductDatabase } from ${packageModule("runtime/database.js")};
import { LocalRuntime } from ${packageModule("runtime/index.js")};
import { createWalletOwnerApplicationFactory } from ${packageModule("wallet/application.js")};

const dataDirectory = process.env.LITTLEJOHN_DATA_DIR;
const clockPath = process.env.LITTLEJOHN_RELEASE_CLOCK;
const assetSourceUrl = process.env.LITTLEJOHN_RELEASE_ASSET_SOURCE_URL;
if (
  typeof dataDirectory !== "string" ||
  typeof clockPath !== "string" ||
  typeof assetSourceUrl !== "string"
) {
  throw new TypeError("Release worker environment is incomplete.");
}

const sessionTopic = "a".repeat(64);
const sessionAccount = "eip155:4663:0x1111111111111111111111111111111111111111";
const alternateSessionAccount = "eip155:4663:0x3333333333333333333333333333333333333333";
const now = () => readFileSync(clockPath, "utf8").trim();
const sessionExpiry = () => Math.floor(Date.parse(now()) / 1000) + 7 * 24 * 60 * 60;

const createContractSourceVerification = (clock) =>
  createSourcifyContractSourceVerification({
    clock,
    fetch: async (input, init) => {
      if (
        typeof input !== "string" ||
        init?.method !== "GET" ||
        init?.redirect !== "error"
      ) throw new TypeError("Release source verifier received an invalid request.");
      const url = new URL(input);
      const segments = url.pathname.split("/");
      const chainId = segments.at(-2);
      const address = segments.at(-1);
      if (
        url.protocol !== "https:" ||
        url.hostname !== "sourcify.dev" ||
        url.port !== "" ||
        chainId !== "4663" ||
        typeof address !== "string"
      ) throw new TypeError("Release source verifier received an unexpected identity.");
      return new Response(JSON.stringify({
        address,
        chainId,
        creationMatch: null,
        match: null,
        runtimeMatch: null,
      }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    },
  });

const session = (expiry = sessionExpiry(), account = sessionAccount) => Object.freeze({
  topic: sessionTopic,
  expiry,
  namespaces: Object.freeze({
    eip155: Object.freeze({
      chains: Object.freeze(["eip155:4663"]),
      accounts: Object.freeze([account]),
      methods: Object.freeze(["eth_sendTransaction"]),
      events: Object.freeze(["accountsChanged", "chainChanged"]),
    }),
  }),
});

const qr = Object.freeze({
  size: 21,
  rows: Object.freeze(Array.from({ length: 21 }, (_, row) =>
    Array.from({ length: 21 }, (_, column) => (row + column) % 2 === 0 ? "1" : "0").join("")
  )),
});

const readSessions = async (path) => {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (!Array.isArray(value)) throw new TypeError("Fake wallet store is invalid.");
    return value;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return [];
    throw error;
  }
};

const persistSessions = async (path, sessions) => {
  const temporary = path + ".tmp-" + process.pid;
  await writeFile(temporary, JSON.stringify(sessions) + "\n", { mode: 0o600 });
  if (process.platform !== "win32") await chmod(temporary, 0o600);
  await rename(temporary, path);
};

const inspectPersistence = async () => {
  const database = await ProductDatabase.open(
    resolve(dataDirectory, "littlejohn.sqlite3"),
    now(),
  );
  try {
    return {
      owner: database.ownerStore().readOwner() ?? null,
      connection: database.walletStore().read(),
    };
  } finally {
    database.close();
  }
};

class FakeWalletConnectClient {
  constructor(storePath, sessions) {
    this.storePath = storePath;
    this.sessions = sessions;
    this.nextSessionAccount = sessions[0]?.namespaces?.eip155?.accounts?.[0] ?? sessionAccount;
    this.listener = undefined;
    this.pending = undefined;
  }

  listSessions() {
    return Object.freeze([...this.sessions]);
  }

  async startConnection() {
    if (this.pending !== undefined) throw new Error("A fake connection attempt is already active.");
    let resolveOutcome;
    const outcome = new Promise((resolve) => { resolveOutcome = resolve; });
    const pending = {
      resolve: resolveOutcome,
      closed: false,
    };
    this.pending = pending;
    const terminal = (value) => {
      if (pending.closed) return value;
      pending.closed = true;
      if (this.pending === pending) this.pending = undefined;
      pending.resolve(value);
      return value;
    };
    return Object.freeze({
      qr,
      wait: () => outcome,
      cancel: async () => terminal(Object.freeze({ status: "cancelled" })),
    });
  }

  async approve() {
    const pending = this.pending;
    if (pending === undefined || pending.closed) throw new Error("No fake approval is pending.");
    const approved = session(sessionExpiry(), this.nextSessionAccount);
    this.sessions = [approved];
    await persistSessions(this.storePath, this.sessions);
    pending.closed = true;
    this.pending = undefined;
    pending.resolve(Object.freeze({ status: "approved", session: approved }));
    return approved;
  }

  async touchSession() {
    if (this.sessions.length !== 1) throw new Error("No exact fake session is available.");
    const changed = session(this.sessions[0].expiry + 120);
    this.sessions = [changed];
    await persistSessions(this.storePath, this.sessions);
    this.listener?.(Object.freeze({ kind: "session_changed", topic: sessionTopic }));
    return changed;
  }

  async changeAccount() {
    if (this.sessions.length !== 1) throw new Error("No exact fake session is available.");
    const current = this.sessions[0];
    this.nextSessionAccount = this.nextSessionAccount === sessionAccount
      ? alternateSessionAccount
      : sessionAccount;
    const changed = session(current.expiry + 120, this.nextSessionAccount);
    this.sessions = [changed];
    await persistSessions(this.storePath, this.sessions);
    this.listener?.(Object.freeze({ kind: "session_changed", topic: sessionTopic }));
    return changed;
  }

  async deleteSession() {
    const existed = this.sessions.some((value) => value.topic === sessionTopic);
    this.sessions = this.sessions.filter((value) => value.topic !== sessionTopic);
    await persistSessions(this.storePath, this.sessions);
    if (existed) this.listener?.(Object.freeze({ kind: "session_deleted", topic: sessionTopic }));
  }

  async disconnectSession(topic) {
    this.sessions = this.sessions.filter((value) => value.topic !== topic);
    await persistSessions(this.storePath, this.sessions);
    return Object.freeze([...this.sessions]);
  }

  subscribe(listener) {
    if (this.listener !== undefined) throw new Error("Fake wallet listener is already registered.");
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = undefined;
    };
  }

  async close() {
    const pending = this.pending;
    if (pending !== undefined && !pending.closed) {
      pending.closed = true;
      pending.resolve(Object.freeze({ status: "cancelled" }));
    }
    this.pending = undefined;
    this.listener = undefined;
  }
}

let client;
const createFakeClient = async (configuration, acquisitionResources) => {
  await mkdir(configuration.privateStoreDirectory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(configuration.privateStoreDirectory, 0o700);
  const storePath = resolve(configuration.privateStoreDirectory, "release-fake-sessions.json");
  const created = new FakeWalletConnectClient(storePath, await readSessions(storePath));
  const registration = acquisitionResources.register(created);
  let ownedResource = created;
  client = created;
  return Object.freeze({
    client: created,
    replace: (resource) => {
      registration.replace(ownedResource, resource);
      ownedResource = resource;
    },
    transfer: () => registration.transfer(),
  });
};

const runtime = await LocalRuntime.create({
  environment: process.env,
  now,
  robinhoodOfficialAssetSourceClient: createRobinhoodOfficialAssetSourceClient({
    now: () => new Date(now()),
    fetch: (input, init) => {
      if (input !== officialAssetSourceDefinition.sourceUri) {
        throw new TypeError("Release source client requested an unexpected authority.");
      }
      return fetch(assetSourceUrl, init);
    },
  }),
  contractSourceVerificationFactory: createContractSourceVerification,
  walletApplicationFactory: createWalletOwnerApplicationFactory(createFakeClient),
  chainApplicationFactory: createChainOwnerApplication,
  interfaceApplicationFactory: createInterfaceOwnerApplication,
});
await runtime.start();

const send = (value) => {
  if (process.send !== undefined && process.connected) process.send(value);
};

let tail = Promise.resolve();
const handle = async (message) => {
  if (typeof message !== "object" || message === null || typeof message.requestId !== "string") {
    throw new TypeError("Release worker command is invalid.");
  }
  const requestId = message.requestId;
  if (message.command === "inspect") {
    send({ requestId, ok: true, result: { ownerState: runtime.ownerState } });
    return;
  }
  if (message.command === "dispatch") {
    const response = await runtime.dispatchRuntimeRequest(message.request);
    send({ requestId, ok: true, result: { ownerState: runtime.ownerState, response } });
    return;
  }
  if (message.command === "approve") {
    if (client === undefined) throw new Error("Fake wallet owner is unavailable.");
    send({ requestId, ok: true, result: await client.approve() });
    return;
  }
  if (message.command === "touch_session") {
    if (client === undefined) throw new Error("Fake wallet owner is unavailable.");
    send({ requestId, ok: true, result: await client.touchSession() });
    return;
  }
  if (message.command === "change_account") {
    if (client === undefined) throw new Error("Fake wallet owner is unavailable.");
    send({ requestId, ok: true, result: await client.changeAccount() });
    return;
  }
  if (message.command === "delete_session") {
    if (client === undefined) throw new Error("Fake wallet owner is unavailable.");
    await client.deleteSession();
    send({ requestId, ok: true, result: null });
    return;
  }
  if (message.command === "stop") {
    await runtime.stop();
    send({ requestId, ok: true, result: null });
    setImmediate(() => process.exit(0));
    return;
  }
  if (message.command === "stop_and_inspect_persistence") {
    await runtime.stop();
    send({ requestId, ok: true, result: await inspectPersistence() });
    setImmediate(() => process.exit(0));
    return;
  }
  throw new TypeError("Release worker command is unknown.");
};

process.on("message", (message) => {
  tail = tail.then(
    () => handle(message),
    () => handle(message),
  ).catch((error) => {
    send({
      requestId: typeof message === "object" && message !== null &&
        typeof message.requestId === "string" ? message.requestId : "invalid",
      ok: false,
      error: error instanceof Error ? error.message : "Release worker failed.",
    });
  });
});

process.on("disconnect", () => {
  void runtime.stop().finally(() => process.exit(0));
});

send({ ready: true, result: { ownerState: runtime.ownerState } });
`;
};
