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
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";

import { createChainOwnerApplication } from ${packageModule("chain/application.js")};
import { sha256Bytes } from ${packageModule("core/index.js")};
import { createInterfaceOwnerApplication } from ${packageModule("interfaces/application.js")};
import { createSourcifyContractSourceVerification } from ${packageModule("intelligence/sourcify.js")};
import {
  canonicalStockTokenExecutionIndexJson,
  createStockTokenExecutionSeries,
  findStockTokenExecutionIndexAssetByPairId,
  stockTokenExecutionIndexDaySchema,
  stockTokenExecutionIndexMonthSchema,
  stockTokenExecutionIndexStateSchema,
  stockTokenExecutionPairDayLogicalId,
  stockTokenExecutionPairMonthLogicalId,
  unavailableStockTokenExecutionSeries,
} from ${packageModule("market-portfolio/stock-token-execution-index.js")};
import {
  createRobinhoodOfficialAssetSourceClient,
  officialAssetSourceDefinition,
} from ${packageModule("registry/index.js")};
import { ProductDatabase } from ${packageModule("runtime/database.js")};
import { LocalRuntime } from ${packageModule("runtime/index.js")};
import { requireProcessTermination } from ${packageModule("runtime/shutdown.js")};
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
const sessionStoreKey = "littlejohn.release.fixture.sessions";
const now = () => readFileSync(clockPath, "utf8").trim();
const sessionExpiry = () => Math.floor(Date.parse(now()) / 1000) + 7 * 24 * 60 * 60;

const encodeExecutionArtifact = (value) => {
  const json = new TextEncoder().encode(canonicalStockTokenExecutionIndexJson(value));
  const gzip = gzipSync(json, { level: 9 });
  return Object.freeze({
    gzipBytes: gzip.byteLength,
    gzipSha256: sha256Bytes(gzip),
    jsonBytes: json.byteLength,
    jsonSha256: sha256Bytes(json),
  });
};

const executionArtifactReference = (logicalId, sequence, coverage, encoded) => Object.freeze({
  logicalId,
  sequence,
  coverage,
  jsonBytes: encoded.jsonBytes,
  jsonSha256: encoded.jsonSha256,
  gzipBytes: encoded.gzipBytes,
  gzipSha256: encoded.gzipSha256,
});

const stockTokenExecutionIndex = Object.freeze({
  read: async (input, signal) => {
    if (signal?.aborted === true) throw signal.reason;
    const asset = findStockTokenExecutionIndexAssetByPairId(input.pairId);
    if (asset === undefined) {
      return unavailableStockTokenExecutionSeries(input, "asset_not_indexed");
    }
    const sequence = 1;
    const requestedEnd = Date.parse(input.requestedEnd);
    const coverageEnd = new Date(Math.floor(requestedEnd / 60_000) * 60_000).toISOString();
    const activationBlock = BigInt(asset.pair.activation.blockNumber);
    const coverage = Object.freeze({
      fromBlock: asset.pair.activation.blockNumber,
      fromTimestamp: asset.pair.activation.timestamp,
      untilBlock: (activationBlock + 300n).toString(),
      untilTimestamp: coverageEnd,
    });
    if (
      coverage.fromTimestamp.slice(0, 10) !== coverage.untilTimestamp.slice(0, 10) ||
      coverage.fromTimestamp >= coverage.untilTimestamp
    ) throw new TypeError("Release execution fixture coverage is invalid.");
    const candleStarts = [7, 5, 2].map((minutes) =>
      new Date(Date.parse(coverageEnd) - minutes * 60_000).toISOString());
    const denominators = ["4", "1", "4"];
    const numerators = ["925", "463", "927"];
    const candles = candleStarts.map((intervalStart, index) => {
      const blockNumber = (activationBlock + 159n + BigInt(index)).toString();
      const byte = String(40 + index).padStart(2, "0");
      const transactionByte = String(50 + index).padStart(2, "0");
      const source = Object.freeze({
        blockNumber,
        blockHash: "0x" + byte.repeat(32),
        transactionIndex: 0,
        transactionHash: "0x" + transactionByte.repeat(32),
        logIndex: 0,
      });
      const exact = Object.freeze({ numerator: numerators[index], denominator: denominators[index] });
      return Object.freeze({
        intervalStart,
        intervalEnd: new Date(Date.parse(intervalStart) + 60_000).toISOString(),
        open: exact,
        high: exact,
        low: exact,
        close: exact,
        baseVolumeRaw: String(1_000 + index),
        quoteVolumeRaw: String(2_000 + index),
        tradeCount: 1,
        firstSource: source,
        lastSource: source,
      });
    });
    const dayKey = coverage.fromTimestamp.slice(0, 10);
    const day = stockTokenExecutionIndexDaySchema.parse({
      candles,
      contractVersion: "1",
      coverage,
      day: dayKey,
      kind: "pair_candle_day",
      pair: asset.pair,
      sequence,
    });
    const encodedDay = encodeExecutionArtifact(day);
    const dayReference = executionArtifactReference(
      stockTokenExecutionPairDayLogicalId(asset.poolId, dayKey),
      sequence,
      coverage,
      encodedDay,
    );
    const monthKey = coverage.fromTimestamp.slice(0, 7);
    const month = stockTokenExecutionIndexMonthSchema.parse({
      contractVersion: "1",
      coverage,
      days: [dayReference],
      kind: "pair_candle_month",
      month: monthKey,
      pair: asset.pair,
      sequence,
    });
    const encodedMonth = encodeExecutionArtifact(month);
    const monthReference = executionArtifactReference(
      stockTokenExecutionPairMonthLogicalId(asset.poolId, monthKey),
      sequence,
      coverage,
      encodedMonth,
    );
    const state = stockTokenExecutionIndexStateSchema.parse({
      contractVersion: "1",
      coverage,
      kind: "pair_candle_state",
      months: [monthReference],
      pair: asset.pair,
      sequence,
    });
    const encodedState = encodeExecutionArtifact(state);
    return createStockTokenExecutionSeries({
      request: input,
      asset,
      state,
      stateSha256: encodedState.jsonSha256,
      months: [{ reference: monthReference, month, sha256: encodedMonth.jsonSha256 }],
      days: [{ reference: dayReference, day, sha256: encodedDay.jsonSha256 }],
    });
  },
});

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

const admitStoredSessions = (value) => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 1) {
    throw new TypeError("Release WalletConnect fixture storage is invalid.");
  }
  return value.map((stored) => {
    const account = stored?.namespaces?.eip155?.accounts?.[0];
    if (
      typeof stored !== "object" || stored === null ||
      stored.topic !== sessionTopic ||
      !Number.isSafeInteger(stored.expiry) || stored.expiry <= 0 ||
      typeof account !== "string"
    ) throw new TypeError("Release WalletConnect fixture session is invalid.");
    return session(stored.expiry, account);
  });
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
  constructor(storageOwner, createSessionSource, sessions) {
    this.storageOwner = storageOwner;
    this.createSessionSource = createSessionSource;
    this.sessions = sessions;
    this.nextSessionAccount = sessions[0]?.namespaces?.eip155?.accounts?.[0] ?? sessionAccount;
    this.listener = undefined;
    this.pending = undefined;
    this.contained = false;
  }

  publicSession(value) {
    return Object.freeze({
      status: "valid",
      source: this.createSessionSource(value.topic),
      expiry: value.expiry,
      namespaces: value.namespaces,
    });
  }

  async persistSessions() {
    if (this.contained) throw new Error("Release WalletConnect fixture is contained.");
    await this.storageOwner.storage.setItem(sessionStoreKey, this.sessions);
  }

  observe() {
    if (this.contained) throw new Error("Release WalletConnect fixture is contained.");
    const r0 = this.storageOwner.checkpoint();
    const sessions = Object.freeze(this.sessions.map((value) => this.publicSession(value)));
    const proposalCount = this.pending === undefined || this.pending.closed ? 0 : 1;
    const r1 = this.storageOwner.checkpoint();
    if (r0 !== r1) throw new Error("Release WalletConnect fixture observation changed.");
    return Object.freeze({ proposalCount, sessions, revision: r1 });
  }

  async startConnection() {
    if (this.contained || this.pending !== undefined || this.sessions.length !== 0) {
      throw new Error("A fake connection attempt cannot start.");
    }
    let resolveOutcome;
    const outcome = new Promise((resolve) => { resolveOutcome = resolve; });
    const pending = {
      resolve: resolveOutcome,
      closed: false,
    };
    this.pending = pending;
    return Object.freeze({
      qr,
      wait: () => outcome,
      cancel: async () => this.settlePending(pending, Object.freeze({ status: "cancelled" })),
    });
  }

  settlePending(pending, outcome) {
    if (pending.closed) return outcome;
    pending.closed = true;
    if (this.pending === pending) this.pending = undefined;
    pending.resolve(outcome);
    return outcome;
  }

  async containPendingConnectionState() {
    const pending = this.pending;
    if (pending !== undefined) {
      this.settlePending(pending, Object.freeze({ status: "cancelled" }));
    }
  }

  async approve() {
    const pending = this.pending;
    if (pending === undefined || pending.closed) throw new Error("No fake approval is pending.");
    const approved = session(sessionExpiry(), this.nextSessionAccount);
    this.sessions = [approved];
    await this.persistSessions();
    this.settlePending(
      pending,
      Object.freeze({ status: "approved", session: this.publicSession(approved) }),
    );
    return approved;
  }

  async touchSession() {
    if (this.sessions.length !== 1) throw new Error("No exact fake session is available.");
    const current = this.sessions[0];
    const account = current.namespaces.eip155.accounts[0];
    const changed = session(current.expiry + 120, account);
    this.sessions = [changed];
    await this.persistSessions();
    this.listener?.(Object.freeze({
      kind: "observation_changed",
      sessionSourceId: this.createSessionSource(sessionTopic).sourceId,
    }));
    return changed;
  }

  async deleteSession() {
    const existed = this.sessions.some((value) => value.topic === sessionTopic);
    this.sessions = this.sessions.filter((value) => value.topic !== sessionTopic);
    await this.persistSessions();
    if (existed) this.listener?.(Object.freeze({
      kind: "observation_changed",
      sessionSourceId: this.createSessionSource(sessionTopic).sourceId,
    }));
  }

  async disconnectSession(sessionSourceId) {
    const matched = this.sessions.find((value) =>
      this.createSessionSource(value.topic).sourceId === sessionSourceId);
    if (matched === undefined) throw new Error("No exact fake session is available.");
    this.sessions = this.sessions.filter((value) => value !== matched);
    await this.persistSessions();
    this.listener?.(Object.freeze({ kind: "observation_changed", sessionSourceId }));
  }

  activate(listener) {
    if (this.contained || this.listener !== undefined) {
      throw new Error("Fake wallet listener cannot be registered.");
    }
    this.listener = listener;
    let active = true;
    return Object.freeze({
      initialObservation: Object.freeze({
        status: "available",
        observation: this.observe(),
      }),
      releaseEvents: () => undefined,
      unsubscribe: () => {
        if (!active) return;
        active = false;
        if (this.listener === listener) this.listener = undefined;
      },
    });
  }

  async contain() {
    if (this.contained) return;
    await this.containPendingConnectionState();
    this.contained = true;
    this.listener = undefined;
  }

  async close() {
    await this.contain();
    throw requireProcessTermination();
  }
}

let client;
const createFakeClient = async (configuration, registration, signal) => {
  const stored = await configuration.storageOwner.storage.getItem(sessionStoreKey);
  const created = new FakeWalletConnectClient(
    configuration.storageOwner,
    configuration.createSessionSource,
    admitStoredSessions(stored),
  );
  registration.replace(configuration.storageOwner, created);
  const abort = () => { void created.contain(); };
  signal.addEventListener("abort", abort, { once: true });
  let ownedResource = created;
  let adopted = false;
  let controlled = true;
  client = created;
  return Object.freeze({
    client: Object.freeze({
      observe: () => created.observe(),
      startConnection: () => created.startConnection(),
      containPendingConnectionState: () => created.containPendingConnectionState(),
      disconnectSession: (sessionSourceId) => created.disconnectSession(sessionSourceId),
      activate: (listener) => created.activate(listener),
      contain: () => created.contain(),
    }),
    replace: (resource) => {
      if (!controlled) throw new Error("Release WalletConnect fixture ownership was transferred.");
      registration.replace(ownedResource, resource);
      ownedResource = resource;
      if (!adopted) {
        adopted = true;
        signal.removeEventListener("abort", abort);
      }
    },
    transfer: () => {
      if (!adopted || !controlled) {
        throw new Error("Release WalletConnect fixture ownership is unavailable.");
      }
      registration.transfer();
      controlled = false;
    },
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
  stockTokenExecutionIndex,
  contractSourceVerificationFactory: createContractSourceVerification,
  walletApplicationFactory: createWalletOwnerApplicationFactory(createFakeClient),
  chainApplicationFactory: createChainOwnerApplication,
  interfaceApplicationFactory: createInterfaceOwnerApplication,
});
await runtime.start();

const send = (value) => {
  if (process.send !== undefined && process.connected) process.send(value);
};

const sendSettled = (value) => new Promise((resolveSend, rejectSend) => {
  if (process.send === undefined || !process.connected) {
    rejectSend(new Error("Release worker IPC is unavailable."));
    return;
  }
  process.send(value, (error) => {
    if (error === null) resolveSend();
    else rejectSend(error);
  });
});

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
  if (message.command === "delete_session") {
    if (client === undefined) throw new Error("Fake wallet owner is unavailable.");
    await client.deleteSession();
    send({ requestId, ok: true, result: null });
    return;
  }
  if (message.command === "stop") {
    const outcome = await runtime.stop();
    if (outcome.kind !== "process_terminal") {
      throw new Error("Release worker did not retain its WalletConnect process owner.");
    }
    await sendSettled({ requestId, ok: true, result: null });
    process.exit(0);
    return;
  }
  if (message.command === "stop_and_inspect_persistence") {
    const outcome = await runtime.stop();
    if (outcome.kind !== "process_terminal") {
      throw new Error("Release worker did not retain its WalletConnect process owner.");
    }
    await sendSettled({ requestId, ok: true, result: await inspectPersistence() });
    process.exit(0);
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
  void runtime.stop().then(
    () => process.exit(0),
    () => process.exit(1),
  );
});

send({ ready: true, result: { ownerState: runtime.ownerState } });
`;
};
