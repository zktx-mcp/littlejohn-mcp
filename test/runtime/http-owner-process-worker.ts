import { createHash } from "node:crypto";

import { captureCanonicalJson, parseUtcTimestamp } from "../../src/core/index.js";
import {
  createControlAuthorizationHeader,
  loadOrCreateControlCredential,
  type LocalControlCredentialAuthority,
} from "../../src/runtime/control-credential.js";
import { ProductDatabase } from "../../src/runtime/database.js";
import {
  FixedHttpOwner,
  type HttpOwnerApplicationContext,
  type RuntimeDispatchResponse,
} from "../../src/runtime/http-owner.js";
import { ensureOwnerOnlyDirectory, runtimePaths } from "../../src/runtime/paths.js";

type WorkerCommand =
  | {
      readonly requestId: string;
      readonly command: "prepare_start";
      readonly dataDirectory: string;
      readonly now: string;
    }
  | { readonly requestId: string; readonly command: "release_start"; readonly notBeforeEpochMs: number }
  | { readonly requestId: string; readonly command: "prepare_operate" }
  | { readonly requestId: string; readonly command: "release_operate"; readonly notBeforeEpochMs: number }
  | { readonly requestId: string; readonly command: "inspect" }
  | { readonly requestId: string; readonly command: "stop" };

interface PreparedStart {
  readonly dataDirectory: string;
  readonly now: string;
}

interface WorkerSnapshot {
  readonly processId: number;
  readonly state: FixedHttpOwner["state"];
  readonly profileId: string;
  readonly credentialDigest: string;
  readonly applicationFactoryCalls: number;
  readonly recordedOwnerProcessId: number | null;
  readonly recordedOwnerRevision: string | null;
}

interface WorkerStartResult extends WorkerSnapshot {
  readonly outcome: "owner" | "deferred";
}

interface WorkerOperationResult extends WorkerSnapshot {
  readonly response: RuntimeDispatchResponse;
}

let database: ProductDatabase | undefined;
let owner: FixedHttpOwner | undefined;
let credential: LocalControlCredentialAuthority | undefined;
let profileId: string | undefined;
let credentialDigest: string | undefined;
let applicationFactoryCalls = 0;
let executionCount = 0;
let preparedStart: PreparedStart | undefined;
let operationPrepared = false;
let messageTail: Promise<void> = Promise.resolve();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseCommand = (value: unknown): WorkerCommand => {
  if (!isRecord(value) || typeof value["requestId"] !== "string" || typeof value["command"] !== "string") {
    throw new TypeError("Worker command is invalid.");
  }
  if (value["command"] === "prepare_start") {
    if (
      typeof value["dataDirectory"] !== "string" ||
      typeof value["now"] !== "string"
    ) throw new TypeError("Worker start command is invalid.");
    return {
      requestId: value["requestId"],
      command: "prepare_start",
      dataDirectory: value["dataDirectory"],
      now: value["now"],
    };
  }
  if (value["command"] === "release_start" || value["command"] === "release_operate") {
    if (typeof value["notBeforeEpochMs"] !== "number" || !Number.isSafeInteger(value["notBeforeEpochMs"])) {
      throw new TypeError("Worker release command is invalid.");
    }
    return {
      requestId: value["requestId"],
      command: value["command"],
      notBeforeEpochMs: value["notBeforeEpochMs"],
    };
  }
  if (value["command"] === "prepare_operate" || value["command"] === "inspect" || value["command"] === "stop") {
    return { requestId: value["requestId"], command: value["command"] };
  }
  throw new TypeError("Worker command is unknown.");
};

const send = (value: unknown): void => {
  if (process.send === undefined || !process.connected) return;
  process.send(value);
};

const snapshot = (): WorkerSnapshot => {
  if (database === undefined || owner === undefined || profileId === undefined || credentialDigest === undefined) {
    throw new TypeError("Worker runtime is unavailable.");
  }
  const record = database.ownerStore().readOwner();
  return Object.freeze({
    processId: process.pid,
    state: owner.state,
    profileId,
    credentialDigest,
    applicationFactoryCalls,
    recordedOwnerProcessId: record?.processId ?? null,
    recordedOwnerRevision: record?.ownerRevision ?? null,
  });
};

const applicationFactory = ({ routes }: HttpOwnerApplicationContext) => {
  applicationFactoryCalls += 1;
  return Object.freeze({
    routes: routes.extend([{
      method: "GET",
      pathPattern: "/api/v1/internal/control/process-owner",
      mutation: "none" as const,
      response: "canonical_json" as const, successStatus: 200,
      handler: async () => {
        executionCount += 1;
        return {
          ok: true as const,
          body: captureCanonicalJson({ processId: process.pid, executionCount }),
        };
      },
    }]),
    close: () => undefined,
  });
};

const waitUntil = async (epochMs: number): Promise<void> => {
  const delay = epochMs - Date.now();
  if (delay > 0) await new Promise<void>((resolveWait) => setTimeout(resolveWait, delay));
};

const start = async (command: PreparedStart, notBeforeEpochMs: number): Promise<WorkerStartResult> => {
  if (database !== undefined || owner !== undefined) throw new TypeError("Worker runtime already started.");
  await waitUntil(notBeforeEpochMs);
  const now = parseUtcTimestamp(command.now);
  await ensureOwnerOnlyDirectory(command.dataDirectory);
  const paths = runtimePaths(command.dataDirectory);
  credential = await loadOrCreateControlCredential(command.dataDirectory, paths.controlCredential);
  credentialDigest = createHash("sha256")
    .update(createControlAuthorizationHeader(credential), "utf8")
    .digest("hex");
  database = await ProductDatabase.open(paths.database, now);
  profileId = database.ownerStore().readProfile().profileId;
  owner = new FixedHttpOwner({
    ownerStore: database.ownerStore(),
    credential,
    now: () => now,
    applicationFactory,
  });
  const outcome = await owner.start();
  return Object.freeze({ outcome, ...snapshot() });
};

const operate = async (notBeforeEpochMs: number): Promise<WorkerOperationResult> => {
  if (owner === undefined) throw new TypeError("Worker runtime is unavailable.");
  await waitUntil(notBeforeEpochMs);
  const response = await owner.dispatchRuntimeRequest({ requestClass: "local_control",
    method: "GET",
    path: "/api/v1/internal/control/process-owner",
  });
  return Object.freeze({ response, ...snapshot() });
};

const stop = async (): Promise<void> => {
  const activeOwner = owner;
  owner = undefined;
  try { await activeOwner?.stop(); }
  finally {
    const activeDatabase = database;
    database = undefined;
    activeDatabase?.close();
  }
};

const handle = async (input: unknown): Promise<void> => {
  let requestId = "invalid";
  try {
    const command = parseCommand(input);
    requestId = command.requestId;
    if (command.command === "prepare_start") {
      if (preparedStart !== undefined || database !== undefined || owner !== undefined) {
        throw new TypeError("Worker start is already prepared.");
      }
      preparedStart = Object.freeze({
        dataDirectory: command.dataDirectory,
        now: command.now,
      });
      send({ requestId, ok: true, result: { processId: process.pid } });
      return;
    }
    if (command.command === "release_start") {
      const prepared = preparedStart;
      if (prepared === undefined) throw new TypeError("Worker start is not prepared.");
      preparedStart = undefined;
      send({ requestId, ok: true, result: await start(prepared, command.notBeforeEpochMs) });
      return;
    }
    if (command.command === "prepare_operate") {
      if (owner === undefined || operationPrepared) throw new TypeError("Worker operation cannot be prepared.");
      operationPrepared = true;
      send({ requestId, ok: true, result: { processId: process.pid, state: owner.state } });
      return;
    }
    if (command.command === "release_operate") {
      if (!operationPrepared) throw new TypeError("Worker operation is not prepared.");
      operationPrepared = false;
      send({ requestId, ok: true, result: await operate(command.notBeforeEpochMs) });
      return;
    }
    if (command.command === "inspect") {
      send({ requestId, ok: true, result: snapshot() });
      return;
    }
    await stop();
    send({ requestId, ok: true, result: null });
    setImmediate(() => process.exit(0));
  } catch (error) {
    send({
      requestId,
      ok: false,
      error: {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : "Worker operation failed.",
      },
    });
  }
};

process.on("message", (message: unknown) => {
  messageTail = messageTail.then(() => handle(message), () => handle(message));
});

process.on("disconnect", () => {
  void stop().finally(() => process.exit(0));
});

send({ ready: true, processId: process.pid });
