import { createCanonicalClock, parseUnsignedDecimal } from "../core/index.js";
import { createWalletSourceAuthorityFromKey } from "../runtime/source-identity.js";
import { readRuntimeConfiguration } from "../runtime/configuration.js";
import { createResourceOwnershipScope } from "../runtime/resource-ownership.js";
import { restoreWalletConnectConfiguration } from "./walletconnect-configuration.js";
import { openWalletConnectStorage } from "./walletconnect-storage.js";
import { createWalletConnectClient, type WalletExternalModuleLoader } from "./walletconnect-client.js";
import { isWalletConnectClientError, type WalletConnectLocalClientPort, type WalletConnectConnectionAttemptPort, type WalletConnectSessionSnapshot } from "./client-contract.js";
import { workerCommandSchema, workerMessageSchema, createWalletWorkerSender, decodeWalletWorkerMessage, type WalletWorkerMessage, type WalletWorkerSession, workerSessionSchema } from "./worker-contract.js";

type WorkerOutput = WalletWorkerMessage extends infer Message ? Message extends WalletWorkerMessage ? Omit<Message, "version" | "generation"> : never : never;

export interface WalletWorkerProcess {
  send(message: string, callback: (error: Error | null) => void): void;
  on(event: "message", listener: (message: unknown) => void): void;
  on(event: "disconnect", listener: () => void): void;
}
export interface WalletSdkWorkerDependencies {
  readonly moduleLoader?: WalletExternalModuleLoader;
  readonly relayUrl?: string;
}
export const runWalletSdkWorker = (
  channel: WalletWorkerProcess,
  terminate: (code: number) => void,
  dependencies: WalletSdkWorkerDependencies = {},
): void => {
  let generation: string | undefined;
  let lastId = 0;
  let client: WalletConnectLocalClientPort | undefined;
  let connection: { id: number; attempt: WalletConnectConnectionAttemptPort } | undefined;
  let closing = false;
  const executing = new Set<string>();
  const controller = new AbortController();
  const scope = createResourceOwnershipScope();
  const stop = (code: number): void => {
    if (closing) return;
    closing = true;
    controller.abort();
    // Retain the SDK's SQLite owner until the direct entry terminates the OS
    // process. SDK close/IPC acknowledgement cannot make the lease reusable.
    void Promise.resolve().then(() => client?.contain()).finally(() => terminate(code)).catch(() => terminate(1));
  };
  const sender = createWalletWorkerSender((message, done) => channel.send(message, done), () => stop(1));
  const emit = (message: WorkerOutput): Promise<void> => {
    if (generation === undefined || closing) return Promise.resolve();
    try { const sent = sender.send(workerMessageSchema, { version: "1", generation, ...message });
      void sent.catch(() => stop(1)); return sent;
    } catch { stop(1); return Promise.resolve(); }
  };
  const session = (value: WalletConnectSessionSnapshot): WalletWorkerSession => {
    const source = { sourceId: value.source.sourceId, candidateId: value.source.candidateId, topicDigest: value.source.topicDigest };
    return workerSessionSchema.parse(value.status === "invalid" ? { status: "invalid", source } : { status: "valid", source, expiry: value.expiry, namespaces: value.namespaces });
  };
  channel.on("disconnect", () => stop(1));
  channel.on("message", (input) => {
    if (closing) return;
    let message;
    try {
      message = decodeWalletWorkerMessage(workerCommandSchema, input);
      if (message.id <= lastId || (generation !== undefined && message.generation !== generation)) throw new TypeError();
      lastId = message.id;
      if (generation === undefined && message.kind !== "bootstrap") throw new TypeError();
      if (generation !== undefined && message.kind === "bootstrap") throw new TypeError();
      generation ??= message.generation;
    } catch { stop(1); return; }
    const command = message;
    const lane = ["connect", "cancel", "disconnect", "contain_pending"].includes(command.kind) ? "management" : command.kind;
    if (executing.has(lane)) { stop(1); return; }
    executing.add(lane);
    void (async (): Promise<void> => {
      if (command.kind === "shutdown") { stop(0); return; }
      if (command.kind === "bootstrap") {
        const configuration = restoreWalletConnectConfiguration(command.configuration, readRuntimeConfiguration({}).chain);
        const storage = await openWalletConnectStorage(command.directory);
        const registration = scope.resources.register(storage);
        const sources = createWalletSourceAuthorityFromKey({ key: Buffer.from(command.sourceKey, "base64url"), profileId: command.storeSourceId.slice("wallet-sdk:".length), clock: createCanonicalClock(() => new Date().toISOString()) });
        const acquired = await createWalletConnectClient({ wallet: configuration, storageOwner: storage, createSessionSource: (topic) => sources.createSessionSource(topic) }, registration, controller.signal, undefined, dependencies.moduleLoader, dependencies.relayUrl ?? command.relayUrl);
        if (closing) return;
        client = acquired.client;
        const activation = client.activate((event) => emit({ kind: "event", event } as WorkerOutput));
        emit({ kind: "ready", id: command.id });
        activation.releaseEvents();
        return;
      }
      if (client === undefined) throw new TypeError();
      switch (command.kind) {
        case "observe": {
          const observed = client.observe();
          await emit({ kind: "observation_start", id: command.id, proposalCount: observed.proposalCount, sessionCount: observed.sessions.length, revision: parseUnsignedDecimal(observed.revision.toString()) });
          for (const [index, value] of observed.sessions.entries()) {
            if (closing) return;
            await emit({ kind: "observation_session", id: command.id, index, session: session(value) });
          }
          await emit({ kind: "observed", id: command.id });
          return;
        }
        case "connect": {
          if (connection !== undefined) throw new TypeError();
          const attempt = await client.startConnection();
          connection = { id: command.id, attempt };
          emit({ kind: "connected", id: command.id, qr: attempt.qr } as WorkerOutput);
          void attempt.wait().then((outcome) => {
            if (connection?.id === command.id) connection = undefined;
            emit({ kind: "connection_outcome", id: command.id, outcome: outcome.status === "approved" ? { ...outcome, session: session(outcome.session) } : outcome } as WorkerOutput);
          }, () => stop(1));
          return;
        }
        case "cancel": {
          if (connection?.id !== command.attemptId) throw new TypeError();
          await connection.attempt.cancel();
          break;
        }
        case "contain_pending": await client.containPendingConnectionState(); break;
        case "disconnect": await client.disconnectSession(command.sourceId); break;
        case "request": {
          const attempt = await client.startRequest(command.input);
          void attempt.response.then((outcome) => emit({ kind: "response", id: command.id, outcome } as WorkerOutput), () => stop(1));
          void attempt.settlement.then((outcome) => emit({ kind: "settlement", id: command.id, outcome } as WorkerOutput), () => stop(1));
          return;
        }
      }
      emit({ kind: "acknowledged", id: command.id });
    })().catch((error: unknown) => {
      emit({ kind: "failure", id: command.id, code: isWalletConnectClientError(error) ? error.code : "sdk" } as WorkerOutput);
      if (command.kind === "bootstrap") stop(1);
    }).finally(() => executing.delete(lane));
  });
};
