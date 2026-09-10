import { EventEmitter } from "node:events";
import { sha256Bytes } from "../core/index.js";
import { walletConnectMessageStorageKeys, type WalletConnectStorageOwner } from "./walletconnect-storage.js";

export const walletConnectRequestExpirySeconds = 300;

type MessageRecord = Record<string, string>;
type PublisherOptions = { readonly id?: string; readonly tag?: number };
type Publish = (topic: string, message: string, options?: PublisherOptions) => Promise<void>;
type Decode = (topic: string, message: string, options?: unknown) => Promise<unknown>;
type Encode = (topic: string, payload: unknown, options?: unknown) => Promise<string>;

// The pinned SDK's public controller boundary. It never crosses out of Wallet.
export interface WalletConnectProtocolResources {
  readonly storageOwner: WalletConnectStorageOwner;
  readonly history: { readonly events: EventEmitter; delete(topic: string, id: number): void };
  readonly messages: {
    readonly messages: Map<string, MessageRecord>;
    readonly messagesWithoutClientAck: Map<string, MessageRecord>;
  };
  readonly publisher: { publish: Publish; readonly queue: Map<string, unknown> };
  readonly crypto: { decode: Decode; encode: Encode };
  readonly relayerEvents: EventEmitter;
  readonly engineEvents: EventEmitter;
  readonly providerEvents: EventEmitter;
}

export interface WalletConnectRequestResources {
  readonly entered: boolean;
  finish(): void;
}

interface Entry {
  readonly topic: string;
  readonly marker: string;
  readonly messages: Set<string>;
  readonly publications: Map<string, Set<(...args: unknown[]) => void>>;
  id?: number;
  entered: boolean;
  expiresAt: number;
  finished: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

const data = (value: unknown, key: string): unknown => {
  if (typeof value !== "object" || value === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
};
const messageKey = (message: string): string => sha256Bytes(Buffer.from(message, "utf8"));

export const createWalletConnectRequestTracker = (
  resources: WalletConnectProtocolResources,
  failed: (error: unknown) => void,
) => {
  const entries = new Set<Entry>();
  const byId = new Map<number, Entry>();
  const requests = new WeakMap<object, Entry>();
  const messageOwners = new Map<string, Entry>();
  let active: Entry | undefined;
  let ordinal = 0n;
  let closed = false;
  let closing: Promise<void> | undefined;
  const publish = resources.publisher.publish;
  const decode = resources.crypto.decode;
  const encode = resources.crypto.encode;

  const finish = (entry: Entry): void => {
    if (entry.finished) return;
    entry.finished = true;
    if (active === entry) active = undefined;
    if (entry.id !== undefined) {
      resources.history.delete(entry.topic, entry.id);
      resources.engineEvents.removeAllListeners(`session_request:${entry.id}`);
    }
    for (const [id, listeners] of entry.publications) {
      resources.publisher.queue.delete(id);
      resources.providerEvents.removeAllListeners(id);
      for (const listener of listeners) resources.relayerEvents.removeListener("relayer_publish", listener);
    }
    entry.publications.clear();
  };

  const retire = async (entry: Entry): Promise<void> => {
    if (!entries.has(entry)) return;
    finish(entry);
    clearTimeout(entry.timer);
    for (const map of [resources.messages.messages, resources.messages.messagesWithoutClientAck]) {
      const record = map.get(entry.topic);
      if (record === undefined) continue;
      for (const key of entry.messages) {
        const value = data(record, key);
        if (value === undefined) continue;
        if (typeof value !== "string" || messageKey(value) !== key || !Reflect.deleteProperty(record, key)) {
          throw new TypeError("WalletConnect retained-message identity is inconsistent.");
        }
      }
      if (Object.keys(record).length === 0) map.delete(entry.topic);
    }
    for (const key of entry.messages) if (messageOwners.get(key) === entry) messageOwners.delete(key);
    entry.messages.clear();
    // Both maps change synchronously before their opaque snapshots are written.
    await Promise.all([
      resources.storageOwner.storage.setItem(walletConnectMessageStorageKeys.messages, Object.fromEntries(resources.messages.messages)),
      resources.storageOwner.storage.setItem(walletConnectMessageStorageKeys.unacknowledged, Object.fromEntries(resources.messages.messagesWithoutClientAck)),
      resources.storageOwner.storage.removeItem(entry.marker),
    ]);
    entries.delete(entry);
    if (entry.id !== undefined && byId.get(entry.id) === entry) byId.delete(entry.id);
  };
  const arm = (entry: Entry, milliseconds: number): void => {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => { void retire(entry).catch(failed); }, Math.max(0, milliseconds));
    entry.timer.unref();
  };
  const created = (record: unknown): void => {
    const request = data(record, "request");
    if (data(request, "method") !== "wc_sessionRequest") return;
    const inner = data(data(request, "params"), "request");
    const params = data(inner, "params");
    const entry = typeof params === "object" && params !== null ? requests.get(params) : undefined;
    if (entry === undefined || data(record, "topic") !== entry.topic) return;
    const id = data(record, "id");
    const expiry = data(inner, "expiryTimestamp");
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0 ||
        typeof expiry !== "number" || !Number.isSafeInteger(expiry) ||
        !Number.isSafeInteger(expiry * 1_000)) {
      throw new TypeError("WalletConnect request identity or expiry is invalid.");
    }
    entry.id = id;
    entry.entered = true;
    if (entry.finished || !entries.has(entry)) {
      resources.history.delete(entry.topic, id);
      throw new TypeError("WalletConnect request authority has ended.");
    }
    if (byId.has(id) && byId.get(id) !== entry) {
      const error = new TypeError("WalletConnect reused a retained request identity.");
      failed(error);
      throw error;
    }
    byId.set(id, entry);
    entry.expiresAt = expiry * 1_000;
    arm(entry, expiry * 1_000 - Date.now());
  };

  const trackedPublish: Publish = (topic, message, options) => {
    if (options?.tag !== 1108) {
      return Reflect.apply(publish, resources.publisher, [topic, message, options]);
    }
    const entry = typeof message === "string" ? messageOwners.get(messageKey(message)) : undefined;
    if (closed || entry === undefined || entry.id === undefined || entry.topic !== topic ||
        entry.finished || !entries.has(entry) || Date.now() >= entry.expiresAt) {
      const error = new TypeError("WalletConnect publication has no owned request identity.");
      failed(error);
      return Promise.reject(error);
    }
    const id = options.id;
    if (typeof id !== "string" || !/^[0-9]+$/u.test(id) || typeof message !== "string") {
      return Promise.reject(new TypeError("WalletConnect publication identity is invalid."));
    }
    entry.entered = true;
    entry.messages.add(messageKey(message));
    const listeners = new Set<(...args: unknown[]) => void>();
    entry.publications.set(id, listeners);
    // Publisher registers this listener synchronously before its first await.
    // Its failure path leaves the listener attached; retain its exact identity.
    const capture = (name: string | symbol, listener: (...args: unknown[]) => void): void => {
      if (name === "relayer_publish" && listeners.size === 0) listeners.add(listener);
    };
    resources.relayerEvents.on("newListener", capture);
    // Engine options are shared by method; another request must not mutate the
    // ID observed by this publication's completion listener.
    try { return Reflect.apply(publish, resources.publisher, [topic, message, { ...options }]); }
    finally { resources.relayerEvents.off("newListener", capture); }
  };
  const decoded = (topic: string, key: string, payload: unknown): unknown => {
    const id = data(payload, "id");
    const entry = typeof id === "number" ? byId.get(id) : undefined;
    if (entry !== undefined && entry.topic === topic) entry.messages.add(key);
    return payload;
  };
  const trackedDecode: Decode = (topic, message, options) => {
    if (entries.size === 0) return Reflect.apply(decode, resources.crypto, [topic, message, options]);
    const key = messageKey(message);
    return Promise.resolve(Reflect.apply(decode, resources.crypto, [topic, message, options]))
      .then((payload) => decoded(topic, key, payload));
  };
  const encoded = (entry: Entry, message: string): string => {
    if (closed || entry.finished || !entries.has(entry) || Date.now() >= entry.expiresAt) {
      throw new TypeError("WalletConnect request authority has ended.");
    }
    const key = messageKey(message);
    messageOwners.set(key, entry);
    entry.messages.add(key);
    return message;
  };
  const trackedEncode: Encode = (topic, payload, options) => {
    if (data(payload, "method") !== "wc_sessionRequest") {
      return Reflect.apply(encode, resources.crypto, [topic, payload, options]);
    }
    const params = data(data(data(payload, "params"), "request"), "params");
    const entry = typeof params === "object" && params !== null ? requests.get(params) : undefined;
    if (closed || entry === undefined || entry.topic !== topic || entry.finished ||
        !entries.has(entry) || Date.now() >= entry.expiresAt) {
      return Promise.reject(new TypeError("WalletConnect request has no active local owner."));
    }
    return Promise.resolve(Reflect.apply(encode, resources.crypto, [topic, payload, options]))
      .then((message) => encoded(entry, message));
  };
  resources.publisher.publish = trackedPublish;
  resources.crypto.decode = trackedDecode;
  resources.crypto.encode = trackedEncode;
  resources.history.events.on("history_created", created);

  return Object.freeze({
    begin(topic: string, params: object): WalletConnectRequestResources {
      if (closed || active !== undefined || !/^[0-9a-f]{64}$/u.test(topic)) {
        throw new TypeError("WalletConnect request resources are unavailable.");
      }
      const marker = `littlejohn:wallet_request:${++ordinal}`;
      // One volatile key reserves one resource slot in the same bounded store.
      // It contains no request bytes and cannot be restored after a restart.
      const entry: Entry = {
        topic, marker, messages: new Set(), publications: new Map(), finished: false, entered: false,
        expiresAt: Date.now() + walletConnectRequestExpirySeconds * 1_000,
      };
      active = entry;
      try {
        // The owning facade publishes mutations before returning its promise.
        // Its checkpoint also rejects a synchronous write failure that the SDK
        // might otherwise ignore in a fire-and-forget persistence call.
        void resources.storageOwner.storage.setItem(marker, true).catch(failed);
        resources.storageOwner.checkpoint();
      }
      catch (error) { active = undefined; throw error; }
      entries.add(entry);
      requests.set(params, entry);
      arm(entry, walletConnectRequestExpirySeconds * 1_000);
      return Object.freeze({
        get entered() { return entry.entered; },
        finish: () => {
          finish(entry);
          if (entry.id === undefined) void retire(entry).catch(failed);
        },
      });
    },
    close(): Promise<void> {
      if (closing !== undefined) return closing;
      closed = true;
      resources.history.events.off("history_created", created);
      if (resources.publisher.publish !== trackedPublish || resources.crypto.decode !== trackedDecode ||
          resources.crypto.encode !== trackedEncode) {
        closing = Promise.reject(new TypeError("WalletConnect request resource ownership changed."));
        return closing;
      }
      // The SDK owner requires process termination after close. Keep the closed
      // send guard until then so a late SDK continuation cannot regain a sender.
      closing = Promise.allSettled([...entries].map(retire)).then((outcomes) => {
        const failure = outcomes.find((outcome) => outcome.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      });
      return closing;
    },
  });
};

export type WalletConnectRequestTracker = ReturnType<typeof createWalletConnectRequestTracker>;
